const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('settings vectorizer converts selected image and downloads SVG for external editing', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:960}});
    const errors = [], conversions = [];
    let failConversion = false, hold = false, release;
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72" viewBox="0 0 96 72"><path fill="#e54535" d="M10 10H42V62H10Z"/><path fill="#2080c0" d="M48 12H88V58H48Z"/></svg>';
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        if(url.hostname !== 'xiaomei-vector.test') return route.abort();
        if(p.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(p));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({body:''});
        }
        if(p === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        if(p === '/api/canvases/vector-fixture') return route.fulfill({json:{canvas:{id:'vector-fixture',title:'Vector fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        if(p === '/api/image-vectorizer/status') return route.fulfill({json:{vtracer_ready:true,paid_api:false}});
        if(p === '/api/image/vectorize'){
            const body = request.postDataJSON();
            conversions.push(body);
            if(hold){ hold = false; await new Promise(resolve => { release = resolve; }); }
            if(failConversion) return route.fulfill({status:422,json:{detail:'模拟转换失败'}});
            return route.fulfill({json:{url:'/output/vector_fixture.svg',name:'插画_矢量.svg',kind:'image',width:96,height:72,path_count:2,size_bytes:1024,derived_from:{url:body.source_url,operation:'vectorize'},preset:body.preset,detail:body.detail,color_mode:body.color_mode}});
        }
        if(p.endsWith('.svg') || p.endsWith('.png') || p.includes('media-preview')) return route.fulfill({contentType:'image/svg+xml',body:svg});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],cases:[],batches:[]}});
    });
    await page.goto('http://xiaomei-vector.test/static/smart-canvas.html?id=vector-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Vector fixture');
    const id = await page.evaluate(() => {
        const node = createNode(300,250,[
            {url:'/output/illustration.png',name:'插画.png',kind:'image',natural_w:96,natural_h:72}
        ], {nodeType:'smart-paint',select:true});
        selectedId = node.id;
        selectedIds = [];
        selectedImage = {nodeId:node.id,index:0};
        render();
        return node.id;
    });
    const node = page.locator(`.image-node[data-id="${id}"]`);
    await node.locator('[data-smart-node-settings]').click();
    const action = node.locator('[data-smart-node-action="vectorize"]');
    assert.equal((await action.textContent()).trim(), '矢量');
    await action.click();
    const dialog = page.locator('.smart-vector-dialog');
    await dialog.waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('[data-vector-engine]')?.textContent.includes('已就绪'));
    assert.deepEqual(await dialog.locator('.smart-vector-footer button').allTextContents(), ['转换为 SVG','下载 SVG']);
    assert.equal(await dialog.locator('a').count(), 0);
    assert.ok(await dialog.locator('[data-vector-download]').isDisabled());
    assert.equal(await dialog.locator('img').first().getAttribute('src'), '/output/illustration.png');
    await dialog.locator('[data-vector-preset]').selectOption('illustration');
    await dialog.locator('[data-vector-detail]').selectOption('fine');
    await dialog.locator('[data-vector-color]').selectOption('color');
    await dialog.locator('[data-vector-convert]').click();
    await page.waitForFunction(() => document.querySelector('[data-vector-status]')?.textContent.includes('2 条路径'));
    assert.deepEqual(conversions[0], {source_url:'/output/illustration.png',name:'插画.png',preset:'illustration',detail:'fine',color_mode:'color'});
    const images = await page.evaluate(id => nodes.find(node => node.id === id).images, id);
    assert.equal(images[0].url, '/output/illustration.png');
    assert.equal(images[0].vectorization.url, '/output/vector_fixture.svg');
    assert.ok(await dialog.locator('[data-vector-download]').isEnabled());

    // Native SVG preview must retain transparent pixels, rather than embed a bitmap.
    await page.waitForFunction(() => document.querySelector('[data-vector-result]')?.naturalWidth === 96);
    const alpha = await page.evaluate(() => {
        const image = document.querySelector('[data-vector-result]');
        const canvas = document.createElement('canvas'); canvas.width=96;canvas.height=72;
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        return ctx.getImageData(0,0,1,1).data[3];
    });
    assert.equal(alpha, 0);
    const downloadEvent = page.waitForEvent('download');
    await dialog.locator('[data-vector-download]').click();
    const svgDownload = await downloadEvent;
    assert.equal(svgDownload.suggestedFilename(), '插画_矢量.svg');

    const before = await dialog.locator('[data-vector-result]').getAttribute('src');
    await dialog.locator('[data-vector-refresh]').click();
    assert.notEqual(await dialog.locator('[data-vector-result]').getAttribute('src'), before);

    failConversion = true;
    await dialog.locator('[data-vector-convert]').click();
    await page.waitForFunction(() => document.querySelector('[data-vector-status]')?.textContent.includes('模拟转换失败'));
    assert.ok(await dialog.locator('[data-vector-download]').isEnabled());
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).images[0].vectorization.url,id), '/output/vector_fixture.svg');
    await dialog.locator('[data-vector-download]').focus();
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(id => nodes.some(node => node.id === id), id), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);

    // Reopen keeps the latest SVG; closing a running conversion does not lose it.
    await page.evaluate(id => openSmartImageVectorizer(id,0), id);
    assert.ok(await dialog.locator('[data-vector-download]').isEnabled());
    failConversion = false; hold = true;
    await dialog.locator('[data-vector-convert]').click();
    await page.waitForFunction(() => document.querySelector('[data-vector-convert]')?.textContent === '转换中…');
    await dialog.locator('[data-vector-close]').click();
    await page.evaluate(id => openSmartImageVectorizer(id,0), id);
    assert.ok(await dialog.locator('[data-vector-convert]').isDisabled());
    while(!release) await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await page.waitForFunction(() => document.querySelector('[data-vector-status]')?.textContent.includes('2 条路径'));
    assert.equal(conversions.length, 3);

    const artifacts = path.join(root,'output','test-artifacts','vectorizer');
    fs.mkdirSync(artifacts,{recursive:true});
    await dialog.screenshot({path:path.join(artifacts,'vectorizer-light.png')});
    await page.evaluate(() => {
        document.documentElement.classList.add('theme-dark','studio-theme-dark');
        document.body.classList.add('theme-dark','studio-theme-dark');
    });
    assert.notEqual(await dialog.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    await dialog.screenshot({path:path.join(artifacts,'vectorizer-dark.png')});
    await dialog.locator('[data-vector-close]').click();
    await page.evaluate(id => {
        const current = nodes.find(node => node.id === id);
        current.images.unshift({url:'/output/logo.png',name:'logo.png',kind:'image',natural_w:96,natural_h:72});
        selectedImage = {nodeId:id,index:1};
        runSmartNodeToolbarAction(id,'vectorize');
    }, id);
    assert.ok(await dialog.locator('[data-vector-download]').isEnabled());
    await dialog.locator('[data-vector-convert]').click();
    await page.waitForFunction(() => document.querySelector('[data-vector-status]')?.textContent.includes('2 条路径'));
    assert.equal(conversions.at(-1).source_url, '/output/illustration.png');
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).images[0].vectorization, id), undefined);
    await dialog.locator('[data-vector-close]').click();
    await page.evaluate(id => {
        sharedCanvasReadOnly = true;
        render();
    }, id);
    assert.ok(await node.locator('[data-smart-node-action="vectorize"]').isDisabled());
    assert.deepEqual(errors, []);
});
