const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('batch image remove hides only the chosen upstream image from preview and generation', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400, height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'batch-reference-remove', title:'Batch references', nodes:[], connections:[], logs:[], settings:{}};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'batch-reference-remove.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/fixture-images/')){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#abcdef"/></svg>'});
        }
        if(url.pathname === '/api/canvases/batch-reference-remove'){
            if(route.request().method() === 'PUT') saved = {...saved, ...route.request().postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://batch-reference-remove.test/static/smart-canvas.html?id=batch-reference-remove');
    await page.waitForFunction(() => canvas?.id === 'batch-reference-remove');
    await page.evaluate(() => {
        nodes = [
            {id:'source', type:'smart-upload', x:30, y:30, images:[
                {url:'/fixture-images/first.svg', kind:'image'},
                {url:'/fixture-images/second.svg', kind:'image'}
            ]},
            {id:'batch', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true, x:350, y:30, w:400, h:650,
                imageInput:true, showPrompt:true, loopStart:1, imageBatchSize:1, batchSourceNodeId:'local',
                batchSourceText:'两屏详情页', variablePrompts:['第一屏','第二屏']}
        ];
        canvas.connections = [{from:'source', to:'batch', kind:'input'}];
        canvasUsesConnections = true;
        render();
    });
    const batch = page.locator('[data-id="batch"]');
    const remove = batch.locator('[data-node-input-remove]');
    assert.equal(await remove.count(), 2);
    assert.equal(await remove.nth(1).evaluate(element => getComputedStyle(element).visibility), 'visible');
    await remove.nth(1).click();
    assert.equal(await remove.count(), 1, JSON.stringify(await page.evaluate(() => ({
        blocked:nodes.find(node => node.id === 'batch').blockedInputRefs,
        preview:smartLoopPreviewImages(nodes.find(node => node.id === 'batch')).map(image => ({url:image.url, key:inputRefKey(image)})),
        imageInput:nodes.find(node => node.id === 'batch').imageInput,
        connections:canvas.connections
    }))));
    assert.match(await batch.locator('.loop-paired-section-head strong').first().innerText(), /1/);
    assert.deepEqual(await page.evaluate(() => {
        const loop = nodes.find(node => node.id === 'batch');
        return {
            preview:smartLoopPreviewImages(loop).map(image => image.url),
            run:smartLoopInputImages(loop, {index:1}).map(image => image.url),
            blocked:loop.blockedInputRefs,
            source:nodes.find(node => node.id === 'source').images.map(image => image.url),
            connections:canvas.connections.filter(connection => connection.to === 'batch').length
        };
    }), {
        preview:['/fixture-images/first.svg'], run:['/fixture-images/first.svg'], blocked:['source|1'],
        source:['/fixture-images/first.svg','/fixture-images/second.svg'], connections:1
    });
    await page.evaluate(() => saveCanvas());
    assert.deepEqual(saved.nodes.find(node => node.id === 'batch').blockedInputRefs, ['source|1']);
    await page.reload();
    await page.waitForFunction(() => nodes?.some(node => node.id === 'batch'));
    assert.equal(await page.locator('[data-id="batch"] [data-node-input-remove]').count(), 1);
});
