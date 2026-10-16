const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('dragging a canvas image into the local asset panel saves it without moving the node', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:900}});
    const imports = [];
    const saved = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'canvas-asset-drop.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return file.startsWith(root + path.sep) && fs.existsSync(file)
                ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/local-assets/import-urls'){
            const request = JSON.parse(route.request().postData());
            imports.push(request);
            if(request.items.some(item => item.url === '/assets/missing.png')){
                return route.fulfill({json:{ok:true, count:0, files:[], items:[{ok:false, error:'本地素材不存在，请刷新后重试'}]}});
            }
            const files = request.items.map((item, index) => ({id:`saved-${saved.length + index}`, url:`/assets/saved-${saved.length + index}.png`, name:item.name}));
            saved.push(...files);
            return route.fulfill({json:{ok:true, count:files.length, files, items:files.map(file => ({ok:true, item:file}))}});
        }
        if(url.pathname === '/api/canvases/asset-drop-fixture'){
            return route.fulfill({json:{canvas:{id:'asset-drop-fixture', title:'Asset drop', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:saved, tree:{id:'__root__', name:'全部上传', items:saved, children:[{path:'frames', name:'相框', items:saved, children:[]}]}}});
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204, body:''});
    });
    await page.goto('http://canvas-asset-drop.test/static/smart-canvas.html?id=asset-drop-fixture');
    await page.waitForFunction(() => typeof render === 'function' && canvas?.id === 'asset-drop-fixture');
    await page.evaluate(() => {
        nodes = [{id:'frame', type:'smart-upload', title:'Frame', x:180, y:200, images:[{url:'/assets/frame.png', name:'Frame'}]}];
        canvas.nodes = nodes;
        viewport = {x:0, y:0, scale:1};
        canvasViewPrefs.snap = false;
        applyViewport();
        render();
        toggleAssetLibrary(true);
    });
    await page.locator('#assetCategorySelect option[value="frames"]').waitFor({state:'attached'});
    await page.locator('#assetCategorySelect').selectOption('frames');
    const source = await page.locator('.image-node[data-id="frame"] .image-wrap img').boundingBox();
    const target = await page.locator('#assetDropZone').boundingBox();
    assert.ok(source && target);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(500);
    const position = await page.evaluate(() => ({x:nodes[0].x, y:nodes[0].y}));
    assert.deepEqual(imports.map(item => item.items.map(image => image.url)), [['/assets/frame.png']]);
    assert.equal(imports[0].folder, 'frames');
    await page.locator('#assetGrid .asset-item[data-asset-id="saved-0"]').waitFor();
    assert.deepEqual(position, {x:180, y:200});
    await page.evaluate(() => {
        nodes = [{id:'group', type:'smart-upload', title:'Frames', x:180, y:200, images:[
            {url:'/assets/first.png', name:'First'}, {url:'/assets/second.png', name:'Second'}
        ]}];
        canvas.nodes = nodes;
        render();
    });
    const tile = await page.locator('.image-node[data-id="group"] .thumb-item').first().boundingBox();
    assert.ok(tile);
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.deepEqual(imports.map(item => item.items.map(image => image.url)), [
        ['/assets/frame.png'], ['/assets/first.png']
    ]);
    const group = await page.evaluate(() => ({
        nodes:nodes.map(node => ({id:node.id, urls:node.images.map(image => image.url)})),
        undoEntries:undoStack.length
    }));
    assert.deepEqual(group.nodes, [{id:'group', urls:['/assets/first.png', '/assets/second.png']}]);
    assert.equal(group.undoEntries, 0);
    const groupBox = await page.locator('.image-node[data-id="group"]').boundingBox();
    assert.ok(groupBox);
    await page.mouse.move(groupBox.x + 6, groupBox.y + 6);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.deepEqual(imports.at(-1).items.map(item => item.url), ['/assets/first.png', '/assets/second.png']);
    assert.deepEqual(await page.evaluate(() => nodes[0].images.map(image => image.url)), ['/assets/first.png', '/assets/second.png']);
    await page.evaluate(() => {
        nodes = [{id:'missing', type:'smart-upload', x:180, y:200, images:[{url:'/assets/missing.png'}]}];
        canvas.nodes = nodes;
        render();
    });
    const missing = await page.locator('.image-node[data-id="missing"] .image-wrap img').boundingBox();
    assert.ok(missing);
    await page.mouse.move(missing.x + missing.width / 2, missing.y + missing.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('本地素材不存在'));
    assert.deepEqual(imports.at(-1).items.map(item => item.url), ['/assets/missing.png']);
    assert.deepEqual(errors, []);
});
