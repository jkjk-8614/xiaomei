const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function checkCancelPosition(page, node){
    const nodeId = await node.getAttribute('data-id');
    const readPosition = () => node.evaluate(element => {
        const button = element.querySelector('.generation-batch-cancel').getBoundingClientRect();
        const card = element.getBoundingClientRect();
        return {gap:card.top - button.bottom, right:button.right - card.right, width:button.width, height:button.height};
    });
    for(const scale of [1, 0.6, 1.5]){
        await page.evaluate(({nodeId, scale}) => {
            const node = nodes.find(item => item.id === nodeId);
            clearSelection();
            viewport = {x:500 - node.x * scale, y:300 - node.y * scale, scale};
            render();
            applyViewport();
        }, {nodeId, scale});
        const before = await readPosition();
        await node.locator('.loading-cell:not(.generation-complete-cell)').first().click({position:{x:8, y:8}});
        await page.waitForFunction(nodeId => selectedNodeIds().includes(nodeId), nodeId);
        const selected = await readPosition();
        await page.mouse.click(100, 180);
        await page.waitForFunction(nodeId => !selectedNodeIds().includes(nodeId), nodeId);
        const deselected = await readPosition();
        for(const position of [selected, deselected]){
            for(const key of Object.keys(before)){
                assert.ok(Math.abs(position[key] - before[key]) < 1,
                    `cancel button moved at scale ${scale}: ${JSON.stringify({before, position})}`);
            }
        }
        assert.ok(before.gap > 0 && before.gap < 16, JSON.stringify(before));
    }
}

test('batch canvas generation has one cancel control for its remaining tasks', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400, height:1000}});
    const errors = [], cancelled = [];
    let failOnce = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'batch-cancel.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(request.method() === 'POST' && url.pathname.endsWith('/cancel')){
            const taskId = url.pathname.split('/').at(-2);
            cancelled.push(taskId);
            if(taskId === 'canvas_img_retry' && failOnce){
                failOnce = false;
                return route.fulfill({status:503, json:{detail:'暂时无法取消'}});
            }
            return route.fulfill({json:{task_id:taskId, status:'cancelled'}});
        }
        if(url.pathname === '/api/canvases/batch-cancel') return route.fulfill({json:{canvas:{id:'batch-cancel', title:'Batch cancel', nodes:[], connections:[], logs:[], settings:{}}}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://batch-cancel.test/static/smart-canvas.html?id=batch-cancel');
    await page.waitForFunction(() => canvas?.id === 'batch-cancel');
    await page.evaluate(() => {
        const batch = createNode(350, 250, [], {nodeType:'smart-paint', select:false});
        batch.pendingTasks = ['canvas_img_1', 'canvas_img_2', 'canvas_img_retry', 'canvas_img_4']
            .map(taskId => ({taskId, kind:'image', status:'running'}));
        batch.pending = 4;
        batch.manualSize = true; batch.w = 300; batch.h = 350;
        window.batchCancelId = batch.id;
        render({nodeIds:[batch.id]});
    });
    const batch = page.locator('.image-node').filter({has:page.locator('[data-cancel-image-batch]')});
    assert.equal(await batch.locator('.generation-cancel').count(), 1);
    assert.equal(await batch.locator('.generation-progress-ring').count(), 4);
    assert.equal(await batch.evaluate(element => element.querySelector('.generation-batch-cancel').getBoundingClientRect().bottom
        <= element.querySelector('.loading-skeleton').getBoundingClientRect().top), true);
    await checkCancelPosition(page, batch);
    await batch.locator('[data-cancel-image-batch]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-cancel-image-batch]')].some(button => !button.disabled));
    assert.deepEqual([...cancelled].sort(), ['canvas_img_1','canvas_img_2','canvas_img_4','canvas_img_retry']);
    await batch.locator('[data-cancel-image-batch]').click();
    await page.waitForFunction(() => nodes.find(node => node.id === batchCancelId)?.pendingTasks.find(task => task.taskId === 'canvas_img_retry')?.status === 'cancelled');
    assert.deepEqual(cancelled.filter(id => id === 'canvas_img_retry'), ['canvas_img_retry','canvas_img_retry']);
    assert.equal(cancelled.length, 5);
    await page.evaluate(() => {
        const mixed = createNode(750, 250, [], {nodeType:'smart-paint', select:false});
        mixed.images = [{url:'/output/already-finished.png', kind:'image'}];
        mixed.pendingTasks = [{taskId:'canvas_img_remaining', kind:'image', status:'running'}];
        mixed.pending = 1;
        mixed.manualSize = true; mixed.w = 260; mixed.h = 280;
        window.mixedCancelId = mixed.id;
        render({nodeIds:[mixed.id]});
    });
    const mixed = page.locator('.image-node').filter({has:page.locator(`[data-cancel-image-batch]`)}).last();
    assert.equal(await mixed.locator('.generation-complete-cell').count(), 1);
    assert.equal(await mixed.locator('.generation-cancel').count(), 1);
    await checkCancelPosition(page, mixed);
    await mixed.locator('.loading-cell:not(.generation-complete-cell)').click({position:{x:8, y:8}});
    assert.equal(await mixed.evaluate(element => {
        const button = element.querySelector('.generation-batch-cancel').getBoundingClientRect();
        const toolbar = element.querySelector('.smart-node-floating-menu').getBoundingClientRect();
        return toolbar.bottom <= button.top || toolbar.top >= button.bottom
            || toolbar.right <= button.left || toolbar.left >= button.right;
    }), true, 'image actions must not cover the cancel button when a partial result is selected');
    assert.deepEqual(errors, []);
});
