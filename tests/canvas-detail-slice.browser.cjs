const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const sourceUrl = '/output/long-image.png';
const source = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="360"><rect width="120" height="120" fill="red"/><rect y="120" width="120" height="240" fill="blue"/></svg>';

test('long image slices export as upload nodes in either layout', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    const uploads = new Map();
    let failUpload = true;
    let stored = {
        id:'slice-fixture', title:'Slice fixture', settings:{}, logs:[], connections:[],
        nodes:[{id:'source', type:'smart-upload', x:120, y:150, images:[
            {url:sourceUrl, name:'long-image.png', kind:'image', natural_w:120, natural_h:360}
        ]}]
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request();
        const {hostname, pathname, searchParams} = new URL(request.url());
        if(hostname !== 'canvas-slice.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/canvases/slice-fixture'){
            if(request.method() === 'PUT') stored = {...stored,...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(pathname === '/api/ai/upload'){
            if(failUpload) return route.fulfill({status:500,json:{detail:'模拟上传失败'}});
            const files = [];
            const multipart = request.postDataBuffer();
            const signature = Buffer.from('\x89PNG\r\n\x1a\n','latin1');
            for(let start = multipart.indexOf(signature); start >= 0;){
                const end = multipart.indexOf(Buffer.from('IEND'),start) + 8;
                assert.ok(end > start);
                const url = `/output/slice-${uploads.size + 1}.png`;
                uploads.set(url,multipart.subarray(start,end));
                files.push({url,kind:'image'});
                start = multipart.indexOf(signature,end);
            }
            return route.fulfill({json:{files}});
        }
        const mediaUrl = pathname === '/api/media-preview' ? searchParams.get('url') : pathname;
        if(mediaUrl === sourceUrl) return route.fulfill({contentType:'image/svg+xml',body:source});
        if(uploads.has(mediaUrl)) return route.fulfill({contentType:'image/png',body:uploads.get(mediaUrl)});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });

    await page.goto('http://canvas-slice.test/static/smart-canvas.html?id=slice-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Slice fixture');
    const dialog = page.getByRole('dialog', {name:'详情页长图切片'});
    const outputButton = dialog.getByRole('button', {name:'输出到画布'});
    for(const scenario of [
        {layout:'separate', skipSecond:true, heights:[[120]]},
        {layout:'separate', heights:[[120],[240]]},
        {layout:'grouped', heights:[[120,240]]}
    ]){
        await page.evaluate(() => { selectedId = 'source'; selectedIds = []; render(); });
        await page.locator('[data-smart-node-action="detail-slice"][data-node-id="source"]').click();
        await page.waitForFunction(() => document.querySelector('[data-slice-img]')?.naturalHeight === 360);
        await dialog.locator('[data-slice-manual-y]').fill('120');
        await dialog.locator('[data-slice-add-y]').click();
        await dialog.locator('[data-slice-layout]').selectOption(scenario.layout);
        if(scenario.skipSecond){
            await dialog.getByRole('checkbox', {name:'选择切片 #02'}).uncheck();
            await outputButton.click();
            await dialog.locator('[data-slice-status].has-error').waitFor();
            assert.equal(await page.evaluate(() => nodes.length),1);
            failUpload = false;
        }

        const saved = page.waitForRequest(request => request.method() === 'PUT'
            && request.url().endsWith('/api/canvases/slice-fixture')
            && request.postDataJSON().nodes.length === 1 + scenario.heights.length);
        await outputButton.click();
        await dialog.waitFor({state:'detached'});
        assert.equal(await page.locator('#composer').evaluate(el => el.classList.contains('open')),false);
        const [original,...outputs] = (await saved).postDataJSON().nodes;
        assert.equal(original.images[0].url,sourceUrl);
        assert.deepEqual(outputs.map(node => node.type),scenario.heights.map(() => 'smart-upload'));
        assert.deepEqual(outputs.map(node => node.images.map(image => image.natural_h)),scenario.heights);
        for(const image of outputs.flatMap(node => node.images)){
            const png = uploads.get(image.url);
            assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[120,image.natural_h]);
        }
        await page.evaluate(() => performUndo());
        assert.equal(await page.evaluate(() => nodes.length),1);
    }
    assert.deepEqual(errors,[]);
});
