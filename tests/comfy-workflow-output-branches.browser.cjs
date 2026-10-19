const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const fields = [
    {id:'1:text', node:'1', input:'text', name:'提示词', type:'textarea', default:'一对穿着针织衫的年轻情侣'},
    {id:'2:steps', node:'2', input:'steps', name:'步数', type:'number', default:9},
    {id:'3:image', node:'3', input:'image', name:'参考图', type:'image'}
];

test('ComfyUI runs branch from the workflow and retain earlier results and links', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], tasks = [];
    let savedCanvas = {id:'fixture', title:'Test canvas', nodes:[], connections:[], logs:[], settings:{}};
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const pathname = decodeURIComponent(url.pathname);
        if(url.hostname !== 'xiaomei-fixture.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.join(root, pathname);
            if(!fs.existsSync(file)) file = path.join(root, 'ComfyUI/web', pathname.slice(8));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(pathname.startsWith('/output/') || pathname === '/assets/reference.png' || pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="776" height="1029"><rect width="776" height="1029" fill="#d6c3ab"/></svg>'});
        }
        if(pathname === '/api/canvases/fixture'){
            if(request.method() === 'PUT') savedCanvas = {...savedCanvas, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:savedCanvas}});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        if(pathname === '/api/workflows') return route.fulfill({json:{workflows:[{name:'custom/test.json', config:{fields}}]}});
        if(pathname === '/api/workflows/custom/test.json') return route.fulfill({json:{config:{fields}}});
        if(pathname === '/api/upload') return route.fulfill({json:{files:[{comfy_name:'reference.png'}]}});
        if(pathname === '/api/canvas-comfy-tasks' && request.method() === 'POST'){
            requests.push(request.postDataJSON());
            const task = {task_id:`canvas_comfy_fixture_${tasks.length}`, status:'queued'};
            tasks.push(task);
            return route.fulfill({json:task});
        }
        if(pathname.startsWith('/api/canvas-comfy-tasks/')){
            return route.fulfill({json:tasks.find(task => pathname.endsWith('/' + task.task_id)) || {}});
        }
        return route.fulfill({json:{items:[], entries:[], skills:[], categories:[], libraries:[], batches:[]}});
    });

    await page.goto('http://xiaomei-fixture.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => smartConfigReady && canvas?.title === 'Test canvas');
    await page.evaluate(fields => {
        const comfySettings = {engine:'comfy', comfyMode:'custom', comfyWorkflow:'custom/test.json', comfyParams:{'1:text':fields[0].default, '2:steps':9}};
        nodes = [
            {id:'reference', type:SMART_UPLOAD_NODE_TYPE, x:20, y:100, w:180, h:240,
                images:[{url:'/assets/reference.png', name:'参考图.png', kind:'image', natural_w:776, natural_h:1029}]},
            {id:'workflow', type:SMART_COMFY_WORKFLOW_NODE_TYPE, x:260, y:100, w:390, h:500, images:[],
                workflowRef:'custom/test.json', workflowTitle:'Test workflow', workflowFields:fields,
                workflowStatus:'ready', workflowReadiness:{can_run:true}, runSettings:comfySettings},
            {id:'existing-output', type:SMART_UPLOAD_NODE_TYPE, x:730, y:180, w:280, h:220, manualSize:true,
                title:'Image', images:[{url:'/output/old.png', name:'old.png', kind:'image', natural_w:776, natural_h:1029}],
                runSettings:{...comfySettings}, runAt:100, runFinishedAt:110, scale:1},
            {id:'downstream', type:SMART_PAINT_NODE_TYPE, x:1100, y:180, images:[], runSettings:{engine:'api'}}
        ];
        canvas.connections = [
            {from:'reference', to:'workflow', kind:'input'},
            {from:'workflow', to:'existing-output', kind:'flow'},
            {from:'existing-output', to:'downstream', kind:'input'}
        ];
        canvasUsesConnections = true;
        selectedId = 'workflow'; selectedIds = [];
        settings = cloneSmartSettings(smartSettingsForNode(nodes[1]));
        ensureGenerationNotificationPermission = () => {};
        viewport = {x:0, y:0, scale:0.35};
        render(); applyViewport();
    }, fields);

    const outputs = () => page.evaluate(() => outgoingConnectionsFor(nodes.find(node => node.id === 'workflow'), ['flow'])
        .map(connection => nodes.find(node => node.id === connection.to))
        .map(node => ({id:node.id, x:node.x, y:node.y, rect:nodeRect(node),
            images:(node.images || []).map(image => image.url), pending:node.pending || 0, error:node.runError || ''})));
    const oldOutput = (await outputs())[0];
    const outputX = await page.evaluate(() => {
        const rect = nodeRect(nodes.find(node => node.id === 'workflow'));
        return rect.x + rect.width + 80;
    });
    const runButton = page.locator('[data-id="workflow"] [data-comfy-node-run]');

    async function startRun(index){
        await runButton.click();
        await page.waitForFunction(count => nodes.filter(node => node.pending > 0).length === 1
            && canvas.connections.filter(connection => connection.from === 'workflow' && connection.kind === 'flow').length === count, index + 2);
        await page.waitForFunction(() => document.querySelector('[data-comfy-node-run]')?.disabled);
        await page.waitForResponse(response => response.url().includes('/api/canvas-comfy-tasks/') && response.request().method() === 'GET');
        assert.equal(tasks.length, index + 1);
        const all = await outputs(), pending = all.at(-1);
        assert.equal(all.length, index + 2);
        assert.equal(pending.images.length, 0);
        assert.equal(pending.pending, 1);
        assert.equal(pending.x, outputX);
        for(const earlier of all.slice(0, -1)) assert(pending.y >= earlier.rect.y + earlier.rect.height + 28);
        assert.deepEqual(all[0], oldOutput);
        assert.equal(await page.locator('[data-id="existing-output"] .loading-cell').count(), 0);
        assert.equal(await page.locator(`[data-id="${pending.id}"] .loading-cell`).count(), 1);
        return pending.id;
    }
    async function completeRun(index, id, error=''){
        Object.assign(tasks[index], error ? {status:'failed', error}
            : {status:'succeeded', result:{images:[`/output/result-${index}.png`]}});
        await page.waitForFunction(({id, error}) => {
            const node = nodes.find(node => node.id === id);
            return !node?.pending && (error ? node?.runError === error : node?.images?.length === 1);
        }, {id, error});
        await page.waitForFunction(() => !document.querySelector('[data-comfy-node-run]')?.disabled);
        if(!error) await page.waitForFunction(id => [...document.querySelectorAll(`[data-id="${id}"] img`)]
            .some(image => image.complete && image.naturalWidth > 0), id);
    }

    const firstId = await startRun(0);
    await completeRun(0, firstId);
    const firstResult = (await outputs())[1];
    assert.deepEqual(firstResult.images, ['/output/result-0.png']);
    await page.evaluate(id => connectInputNode(id, 'downstream'), firstId);
    const secondId = await startRun(1);
    await page.screenshot({path:path.join(root, 'logs/comfy-workflow-output-branches.png'), fullPage:true});
    await completeRun(1, secondId);
    assert.notEqual(firstId, secondId);
    assert.deepEqual((await outputs())[1], firstResult);

    const failedId = await startRun(2);
    await completeRun(2, failedId, '模拟工作流失败');
    const afterFailure = await outputs();
    assert.deepEqual(afterFailure[0], oldOutput);
    assert.deepEqual(afterFailure[1], firstResult);
    assert.deepEqual(afterFailure[2].images, ['/output/result-1.png']);
    assert.equal(afterFailure[3].error, '模拟工作流失败');
    assert.equal(await page.locator(`[data-id="${failedId}"] .generation-failed-cell`).count(), 1);

    const retryId = await startRun(3);
    await completeRun(3, retryId);
    assert.notEqual(retryId, failedId);
    assert.equal((await outputs())[3].error, '模拟工作流失败');
    assert.deepEqual(requests.map(request => ({workflow:request.workflow_json, params:request.params})),
        Array.from({length:4}, () => ({workflow:'custom/test.json', params:{'1':{text:fields[0].default}, '2':{steps:9}, '3':{image:'reference.png'}}})));
    assert.equal(await page.evaluate(() => nodes.some(node => node.isHistoryGroup)), false);
    assert.deepEqual(await page.evaluate(() => inputImagesFor(nodes.find(node => node.id === 'downstream')).map(image => image.url)),
        ['/output/old.png', '/output/result-0.png']);
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'workflow').images.length), 0);
    assert.equal(await page.evaluate(() => selectedId), 'workflow');
    assert(await page.evaluate(() => saveCanvas()));
    const savedOutputs = await outputs();
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.runError === '模拟工作流失败'));
    assert.deepEqual(await outputs(), savedOutputs);
    assert.equal(await page.evaluate(() => canvas.connections.filter(connection => connection.to === 'downstream').length), 2);
    assert.equal(tasks.length, 4);
    assert.deepEqual(errors, []);
});
