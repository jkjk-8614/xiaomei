const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=';

test('deleting an expanded batch editor preserves pending tasks, completed results and retry', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1100}});
    const errors = [], submissions = [], tasks = new Map();
    page.on('pageerror', error => errors.push(error.message));
    let stored = {id:'edit-delete', title:'Fixture', logs:[], connections:[], nodes:[{
        id:'batch', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true,
        x:20, y:20, batchSourceNodeId:'local', batchSourceText:'产品资料',
        batchAiTargetCount:2, batchOverviewStarted:true,
        batchImageSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', ratio:'9:16', resolution:'1k'},
        manualInputRefs:[{url:pixel, name:'product.png', referenceId:'product'}],
        aiSplitPrompts:[{title:'首屏', prompt:'展示全貌'}, {title:'细节', prompt:'展示材质'}],
        variablePrompts:['展示全貌', '展示材质']
    }]};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'edit-delete.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/edit-delete'){
            if(request.method() === 'PUT') stored = {...stored, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2'], chat_models:[]
        }], comfy_instances:[]}});
        if(url.pathname === '/api/canvas-image-tasks' && request.method() === 'POST'){
            submissions.push(request.postDataJSON());
            const id = `task-${submissions.length}`;
            tasks.set(id, 'running');
            return route.fulfill({json:{task_id:id}});
        }
        if(url.pathname.startsWith('/api/canvas-image-tasks/')){
            const id = url.pathname.split('/').pop(), status = tasks.get(id);
            return route.fulfill({json:{id, status, ...(status === 'succeeded'
                ? {result:{images:[`/fixture/${id}.svg`]}}
                : status === 'failed' ? {error:'fixture timeout', upstream_terminal_error:true} : {})}});
        }
        if(url.pathname.startsWith('/fixture/') || url.pathname.includes('preview')) return route.fulfill({
            contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="gold"/></svg>'
        });
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://edit-delete.test/static/smart-canvas.html?id=edit-delete');
    const ready = () => page.waitForFunction(() => smartConfigReady && smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch')).length === 2);
    await ready();
    const click = selector => page.locator(selector).evaluate(button => button.click());
    const firstId = await page.evaluate(() => smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'))[0].id);
    await click('[data-batch-screen-run="0"]');
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.some(task => task.taskId === 'task-1')));
    await click('[data-loop-result-edit="0"]');
    assert.equal(await page.locator(`.image-node[data-id="${firstId}"]`).count(), 1);
    await page.evaluate(id => deleteNodeFromButton(id), firstId);
    assert.equal(await page.locator(`.image-node[data-id="${firstId}"]`).count(), 0);
    assert.equal(await page.evaluate(id => nodes.find(n => n.id === id).pendingTasks[0].taskId, firstId), 'task-1');
    assert.equal(await page.locator('.batch-screen').first().getAttribute('data-state'), 'running');
    await click('[data-batch-screen-run="0"]');
    assert.equal(submissions.length, 1, 'hiding the editor cannot submit a second request');
    tasks.set('task-1', 'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelector('.batch-screen')?.dataset.state === 'done');
    assert.equal(await page.locator('[data-batch-screen-run="0"]').innerText(), '重生成');
    await click('[data-loop-result-edit="0"]');
    // Keyboard deletion shares the same behavior after generation has finished.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    assert.equal(await page.locator(`.image-node[data-id="${firstId}"]`).count(), 0);
    assert.equal(await page.locator('.batch-screen').first().getAttribute('data-state'), 'done');
    await page.evaluate(() => saveCanvas());
    assert.equal(stored.nodes.find(n => n.id === firstId).images[0].url, '/fixture/task-1.svg');
    await page.reload();
    await ready();
    assert.equal(await page.locator(`.image-node[data-id="${firstId}"]`).count(), 0);
    assert.equal(await page.locator('.batch-screen').first().getAttribute('data-state'), 'done');
    await click('[data-batch-screen-run="0"]');
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.some(task => task.taskId === 'task-2')));
    tasks.set('task-2', 'failed');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelector('.batch-screen')?.dataset.state === 'failed');
    assert.equal(await page.locator('[data-batch-screen-run="0"]').isEnabled(), true);
    assert.equal(await page.locator('[data-batch-screen-run="0"]').innerText(), '重试');
    assert.equal(await page.locator('.batch-screen-sub').first().getAttribute('title'), 'fixture timeout');
    await click('[data-batch-screen-run="0"]');
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.some(task => task.taskId === 'task-3')));
    tasks.set('task-3', 'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelector('.batch-screen')?.dataset.state === 'done');
    assert.equal(submissions.length, 3);
    assert.equal(await page.evaluate(id => nodes.find(n => n.id === id).images[0].url, firstId), '/fixture/task-3.svg');
    // A canvas saved by the older deletion behavior can recreate the missing screen on demand.
    await page.evaluate(() => {
        const owner = nodes.find(n => n.id === 'batch');
        const missingId = smartLoopDetailPaintNodes(owner)[1].id;
        nodes = nodes.filter(n => n.id !== missingId);
        canvas.connections = canvas.connections.filter(c => c.from !== missingId && c.to !== missingId);
        owner.batchPaintNodeIds = owner.batchPaintNodeIds.filter(id => id !== missingId);
        owner.batchPaintAutoRepair = false;
        render();
    });
    assert.equal(await page.locator('[data-batch-screen-run="1"]').isEnabled(), true);
    await click('[data-batch-screen-run="1"]');
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.some(task => task.taskId === 'task-4')));
    tasks.set('task-4', 'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelectorAll('.batch-screen')[1]?.dataset.state === 'done');
    assert.equal(submissions.length, 4);
    assert.equal(await page.evaluate(id => nodes.find(n => n.id === id).images[0].url, firstId), '/fixture/task-3.svg');
    // The full batch also keeps the original task alive when its editor is removed.
    await page.evaluate(() => { nodes.find(n => n.id === 'batch').mode = 'parallel'; render(); });
    await click('[data-loop-run]');
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.some(task => task.taskId === 'task-6')));
    await click('[data-loop-result-edit="0"]');
    await page.evaluate(id => deleteNodeFromButton(id), firstId);
    assert.equal(await page.locator('.batch-screen').first().getAttribute('data-state'), 'running');
    tasks.set('task-6', 'succeeded');
    await page.waitForFunction(() => document.querySelectorAll('.batch-screen')[1]?.dataset.state === 'done');
    assert.equal(await page.locator('.batch-screen').first().getAttribute('data-state'), 'running');
    await click('[data-loop-run]');
    tasks.set('task-5', 'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelector('.batch-screen')?.dataset.state === 'done');
    assert.equal(submissions.length, 6, 'stopping a batch cannot resubmit or discard its accepted tasks');
    assert.equal(await page.evaluate(id => nodes.find(n => n.id === id).images[0].url, firstId), '/fixture/task-5.svg');
    assert.deepEqual(errors, []);
});
