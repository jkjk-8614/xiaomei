const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/NkcAAAAASUVORK5CYII=', 'base64');

test('detail screens stitch in screen order, update one output, and allow manual reordering', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel:'msedge', headless:true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const requests = [];
    let savedCanvas = null;
    let stitchGate = null;
    let failNextSave = false;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-stitch.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/assets/output/')) return route.fulfill({contentType:'image/png', body:pixel});
        if(url.pathname === '/api/canvas-share/session') return route.fulfill({json:{canvas_id:'stitch', role:'editor', allow_assets:true}});
        if(url.pathname === '/api/canvases/stitch' && route.request().method() === 'GET'){
            return route.fulfill({json:{canvas:savedCanvas || {
                id:'stitch', title:'Detail stitch', viewport:{x:0,y:0,scale:1}, logs:[], settings:{},
                connections:['p1','p2','p3'].map(id => ({from:'loop', to:id, kind:'input'})),
                nodes:[
                    {id:'p3', type:'smart-paint', x:1060, y:640, batchDetailOwnerId:'loop', batchDetailScreenIndex:3,
                        images:[{url:'/assets/output/c.png', natural_w:1024, natural_h:1792, kind:'image'}]},
                    {id:'loop', type:'smart-loop', x:30, y:30, w:420, h:760, batchUiMode:'paired', batchDetailModeV2:true,
                        batchPaintNodeIds:['p1','p2','p3'], batchImageSettings:{ratio:'9:16', resolution:'1K'},
                        aiSplitPrompts:[1,2,3].map(n => ({title:`第${n}屏`, prompt:`画面${n}`}))},
                    {id:'p2', type:'smart-paint', x:1600, y:30, batchDetailOwnerId:'loop', batchDetailScreenIndex:2,
                        images:[{url:'/assets/output/b.png', natural_w:1024, natural_h:1792, kind:'image'}]},
                    {id:'p1', type:'smart-paint', x:1060, y:30, batchDetailOwnerId:'loop', batchDetailScreenIndex:1,
                        images:[{url:'/assets/output/a.png', natural_w:1024, natural_h:1792, kind:'image'}]},
                ]
            }}});
        }
        if(url.pathname === '/api/canvas-detail-stitch'){
            requests.push(JSON.parse(route.request().postData()));
            const n = requests.length;
            if(stitchGate) await stitchGate;
            return route.fulfill({json:{url:`/assets/output/long-${n}.png`, name:'详情页长图.png', width:1024, height:5376,
                asset_ref_id:`asset_long_${n}`}});
        }
        if(url.pathname === '/api/canvases/stitch' && ['PUT','PATCH'].includes(route.request().method())){
            if(failNextSave){
                failNextSave = false;
                return route.fulfill({status:500, json:{detail:'simulated save failure'}});
            }
            savedCanvas = {id:'stitch', ...route.request().postDataJSON(), updated_at:Date.now()};
            return route.fulfill({json:{canvas:savedCanvas}});
        }
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[]}});
    });
    await page.goto('http://xiaomei-stitch.test/static/smart-canvas.html?id=stitch');
    await page.waitForFunction(() => nodes.some(node => node.id === 'loop') && document.querySelector('[data-loop-detail-stitch="loop"]'));
    await page.locator('[data-loop-detail-stitch="loop"]').click();
    await page.waitForFunction(() => nodes.some(node => node.detailStitchOwnerId === 'loop'));
    assert.deepEqual(requests[0].urls, ['/assets/output/a.png','/assets/output/b.png','/assets/output/c.png']);
    const initial = await page.evaluate(() => {
        const output = nodes.find(node => node.detailStitchOwnerId === 'loop');
        const right = Math.max(...nodes.filter(node => node.batchDetailOwnerId === 'loop').map(node => nodeRect(node).x + nodeRect(node).width));
        return {id:output.id, x:output.x, right, url:output.images[0].url, sources:output.detailStitchSourceUrls};
    });
    assert.ok(initial.x > initial.right, 'long image is placed to the right of the screens');
    assert.equal(initial.url, '/assets/output/long-1.png');
    await page.evaluate(() => saveCanvas());
    assert.deepEqual(savedCanvas.nodes.find(node => node.id === initial.id).detailStitchSourceNodeIds, ['p1','p2','p3']);
    await page.reload();
    await page.waitForFunction(id => nodes.some(node => node.id === id), initial.id);
    assert.deepEqual(await page.evaluate(id => {
        const output = nodes.find(node => node.id === id);
        return {url:output.images[0].url, sources:output.detailStitchSourceUrls, stale:detailStitchOutputNeedsUpdate(output)};
    }, initial.id), {url:'/assets/output/long-1.png', sources:initial.sources, stale:false});

    await page.evaluate(() => {
        nodes.find(node => node.id === 'p2').images = [{url:'/assets/output/b-new.png', natural_w:1024, natural_h:1792, kind:'image'}];
        render();
    });
    assert.match(await page.locator('[data-loop-detail-stitch-status]').textContent(), /更新长图/);
    let releaseStitch;
    stitchGate = new Promise(resolve => { releaseStitch = resolve; });
    await page.locator('[data-loop-detail-stitch="loop"]').click();
    await page.waitForFunction(() => detailStitchInFlight.has('loop'));
    assert.equal(await page.evaluate(id => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = smartNodeToolbarHtml(nodes.find(node => node.id === id));
        return wrapper.querySelector('[data-smart-node-action="update-detail-stitch"]').disabled;
    }, initial.id), true, 'the output update button is disabled during the same batch request');
    await page.evaluate(id => stitchDetailPagesFromOutput(id), initial.id);
    assert.equal(requests.length, 2, 'the output action cannot start a second stitch');
    releaseStitch();
    stitchGate = null;
    await page.waitForFunction(() => nodes.find(node => node.detailStitchOwnerId === 'loop')?.images?.[0]?.url === '/assets/output/long-2.png');
    const updated = await page.evaluate(() => nodes.find(node => node.detailStitchOwnerId === 'loop').id);
    assert.equal(updated, initial.id, 'update reuses the existing output node');
    assert.deepEqual(requests[1].urls, ['/assets/output/a.png','/assets/output/b-new.png','/assets/output/c.png']);

    await page.evaluate(() => { nodes.find(node => node.id === 'p3').images = []; render(); });
    assert.equal(await page.locator('[data-loop-detail-stitch="loop"]').isDisabled(), true);
    assert.match(await page.locator('[data-loop-detail-stitch-status]').textContent(), /第 3 屏/);
    await page.evaluate(id => {
        const output = nodes.find(node => node.id === id);
        centerViewportOnWorldPoint({x:output.x + 100, y:output.y + 100});
        render();
    }, initial.id);
    assert.match(await page.locator(`.image-node[data-id="${initial.id}"] .smart-detail-stitch-marker`).textContent(), /待更新/);

    await page.evaluate(() => {
        nodes.find(node => node.id === 'p3').images = [{url:'/assets/output/c.png', natural_w:1024, natural_h:1792, kind:'image'}];
        viewport.scale = 0.65; centerViewportOnWorldPoint({x:1400,y:350});
        selectedIds = ['p3','p1','p2']; selectedId = ''; render();
    });
    await page.locator('[data-smart-selection-action="stitch-detail"]').click();
    await page.locator('[data-detail-stitch-move="0:1"]').click();
    await page.locator('[data-detail-stitch-confirm]').click();
    await page.waitForFunction(() => nodes.filter(node => Array.isArray(node.detailStitchSourceNodeIds)).length === 2);
    assert.deepEqual(requests[2].urls, ['/assets/output/b-new.png','/assets/output/a.png','/assets/output/c.png']);

    await page.evaluate(() => saveCanvas());
    await page.goto('http://xiaomei-stitch.test/static/smart-canvas.html?id=stitch&shared=1');
    await page.waitForFunction(id => sharedCanvasMode && !sharedCanvasReadOnly && nodes.some(node => node.id === id), initial.id);
    await page.evaluate(() => {
        nodes.find(node => node.id === 'p1').images = [{url:'/assets/output/a-shared.png', natural_w:1024, natural_h:1792, kind:'image'}];
        centerViewportOnWorldPoint({x:240, y:370});
        render();
    });
    await page.locator('[data-loop-detail-stitch="loop"]').click();
    await page.waitForFunction(() => nodes.find(node => node.detailStitchOwnerId === 'loop')?.images?.[0]?.url === '/assets/output/long-4.png');
    assert.deepEqual(requests[3].urls, ['/assets/output/a-shared.png','/assets/output/b-new.png','/assets/output/c.png']);
    assert.equal(savedCanvas.nodes.find(node => node.id === initial.id).images[0].url, '/assets/output/long-4.png', 'shared editing saves the updated long image');
    await page.reload();
    await page.waitForFunction(id => nodes.some(node => node.id === id), initial.id);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).images[0].url, initial.id), '/assets/output/long-4.png');
    failNextSave = true;
    await page.evaluate(() => {
        nodes.find(node => node.id === 'p1').images = [{url:'/assets/output/a-save-fail.png', natural_w:1024, natural_h:1792, kind:'image'}];
        centerViewportOnWorldPoint({x:240, y:370});
        render();
    });
    await page.locator('[data-loop-detail-stitch="loop"]').click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('画布保存失败'));
    assert.equal(savedCanvas.nodes.find(node => node.id === initial.id).images[0].url, '/assets/output/long-4.png', 'failed canvas save is not reported as saved');
});
