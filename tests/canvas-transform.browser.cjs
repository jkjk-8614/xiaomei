const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('settings rotation previews four transforms, cancels, saves and retains failed drafts', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    let uploads = 0, failSave = false, savedPng = null;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><path fill="#ff0000" d="M0 0h1v1H0z"/><path fill="#00ff00" d="M1 0h1v1H1z"/><path fill="#0000ff" d="M2 0h1v1H2z"/><path fill="#ffff00" d="M0 1h1v1H0z"/><path fill="#ff00ff" d="M1 1h1v1H1z"/></svg>';
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        if(url.hostname !== 'xiaomei-transform.test') return route.abort();
        if(p.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(p));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({body:''});
        }
        if(p === '/api/config') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
        if(p === '/api/canvases/transform-fixture') return route.fulfill({json:{canvas:{id:'transform-fixture',title:'Transform fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        if(p === '/api/ai/upload'){
            uploads++;
            if(failSave) return route.fulfill({status:500,json:{detail:'模拟保存失败'}});
            const multipart = request.postDataBuffer();
            const start = multipart.indexOf(Buffer.from('\x89PNG\r\n\x1a\n','latin1'));
            const end = multipart.indexOf(Buffer.from('IEND'),start) + 8;
            assert.ok(start >= 0);
            savedPng = multipart.subarray(start, end);
            return route.fulfill({json:{files:[{url:'/output/saved.png',name:'saved.png',kind:'image'}]}});
        }
        if(p === '/output/saved.png' && savedPng) return route.fulfill({contentType:'image/png',body:savedPng});
        if(p.endsWith('.png') || p.includes('media-preview')) return route.fulfill({contentType:'image/svg+xml',body:svg});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
    });
    await page.goto('http://xiaomei-transform.test/static/smart-canvas.html?id=transform-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Transform fixture');
    const id = await page.evaluate(() => {
        const node = createNode(300,250,[{url:'/output/source.png',kind:'image',name:'source.png',natural_w:3,natural_h:2}],{nodeType:'smart-image',select:true});
        window.transformTestId = node.id;
        return node.id;
    });
    const node = page.locator(`.image-node[data-id="${id}"]`);
    const open = async () => {
        await node.locator('[data-smart-node-settings]').click();
        const panel = node.locator('.smart-node-settings-panel');
        assert.equal(await panel.locator('[data-smart-node-action="rotate"]').count(),1);
        assert.equal(await panel.locator('[data-smart-node-action^="flip-"], [data-smart-node-action^="rotate-"]').count(),0);
        await panel.locator('[data-smart-node-action="rotate"]').click();
        await page.waitForFunction(() => smartNodeTransformSession?.busy === false);
        const keys = await node.locator('.smart-node-transform-menu button').evaluateAll(es => es.map(e => e.dataset.smartNodeAction));
        assert.deepEqual(keys,['transform-cancel','transform-flip-vertical','transform-flip-horizontal','transform-rotate-left','transform-rotate-right','transform-save']);
        assert.equal(await node.locator('[data-smart-node-settings]').count(),0);
    };
    const pixels = () => page.evaluate(() => {
        const canvas = smartNodeTransformSession.bitmap;
        const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        const colors = [];
        for(let i=0;i<data.length;i+=4) colors.push(Array.from(data.slice(i,i+4)));
        return {width:canvas.width,height:canvas.height,colors};
    });
    const red=[255,0,0,255],green=[0,255,0,255],blue=[0,0,255,255],yellow=[255,255,0,255],pink=[255,0,255,255],clear=[0,0,0,0];
    for(const [operation,width,height,colors] of [
        ['flip-vertical',3,2,[yellow,pink,clear,red,green,blue]],
        ['flip-horizontal',3,2,[blue,green,red,clear,pink,yellow]],
        ['rotate-left',2,3,[blue,clear,green,pink,red,yellow]],
        ['rotate-right',2,3,[yellow,red,pink,green,clear,blue]]
    ]){
        await open();
        await node.locator(`[data-smart-node-action="transform-${operation}"]`).click();
        assert.deepEqual(await pixels(),{width,height,colors});
        assert.equal(uploads,0);
        assert.equal(await page.evaluate(() => nodes.find(n=>n.id===window.transformTestId).images[0].url),'/output/source.png');
        assert.equal(await node.locator('.smart-node-transform-preview').count(),1);
        await node.locator('[data-smart-node-action="transform-cancel"]').click();
        assert.equal(await node.locator('.smart-node-transform-preview').count(),0);
    }
    await open();
    await node.locator('[data-smart-node-action="transform-rotate-left"]').click();
    await node.locator('[data-smart-node-action="transform-rotate-right"]').click();
    assert.deepEqual(await pixels(),{width:3,height:2,colors:[red,green,blue,yellow,pink,clear]});
    await node.locator('[data-smart-node-action="transform-rotate-right"]').click();
    failSave = true;
    await node.locator('[data-smart-node-action="transform-save"]').click();
    await page.waitForFunction(() => smartNodeTransformSession?.busy === false);
    assert.equal(await page.evaluate(() => nodes.find(n=>n.id===window.transformTestId).images[0].url),'/output/source.png');
    assert.equal(await node.locator('.smart-node-transform-preview').count(),1);
    failSave = false;
    await node.locator('[data-smart-node-action="transform-save"]').click();
    await page.waitForFunction(() => !smartNodeTransformSession && nodes.find(n=>n.id===window.transformTestId).images[0].url==='/output/saved.png');
    assert.equal(uploads,2);
    assert.deepEqual(await page.evaluate(() => {const i=nodes.find(n=>n.id===window.transformTestId).images[0];return [i.natural_w,i.natural_h];}),[2,3]);
    assert.equal(await node.locator('[data-smart-node-settings]').count(),1);
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(() => nodes.find(n=>n.id===window.transformTestId).images[0].url),'/output/source.png');
    assert.deepEqual(errors,[]);
});
