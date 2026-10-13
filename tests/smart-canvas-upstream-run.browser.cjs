const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1700, height:1000}});
    const errors = [], calls = [], imageCalls = [];
    let llmHandler = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'upstream-run.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2'], chat_models:['fixture-chat','changed-model']
        }], comfy_instances:[]}});
        if(url.pathname === '/api/canvas-llm'){
            const body = request.postDataJSON();
            calls.push(body);
            if(llmHandler) return llmHandler(route, body);
            return route.fulfill({json:{text:`结果${calls.length}：${body.message}`}});
        }
        if(url.pathname === '/api/canvas-image-tasks' && request.method() === 'POST'){
            imageCalls.push(request.postDataJSON());
            return route.fulfill({json:{task_id:`image-${imageCalls.length}`, status:'queued'}});
        }
        if(url.pathname.startsWith('/api/canvas-image-tasks/')){
            return route.fulfill({json:{status:'succeeded', result:{images:['/output/generated.png']}}});
        }
        if(url.pathname.startsWith('/output/') || url.pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')});
        }
        if(url.pathname === '/api/canvases/fixture' && request.method() === 'GET'){
            return route.fulfill({json:{canvas:{id:'fixture', title:'上游执行测试', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://upstream-run.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    t.after(() => assert.deepEqual(errors, []));
    return {page, calls, imageCalls, setHandler(handler){ llmHandler = handler; }};
}
function agent(id, extra={}){
    return {id, type:'smart-agent', userPrompt:id, images:[], x:80, y:100, w:440, h:650, ...extra};
}
async function install(page, list, connections){
    await page.evaluate(({list, connections}) => {
        nodes = list;
        canvas.connections = connections;
        canvasUsesConnections = true;
        selectedId = ''; selectedIds = [];
        viewport = {x:0, y:0, scale:1};
        applyViewport(); render();
    }, {list, connections});
}
const edge = (from, to, kind='input') => ({from, to, kind});

test('one click waits for all ancestors, reuses unchanged results and reruns changed inputs', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [
        {id:'photo', type:'smart-upload', images:[{url:'/output/product.png', name:'商品'}]},
        agent('analysis'), agent('plan', {x:600}), agent('tail', {x:1100, w:440}),
        agent('unrelated', {x:2200}), agent('downstream', {x:2700})
    ], [edge('photo', 'analysis'), edge('analysis', 'plan', 'flow'), edge('plan', 'tail'), edge('tail', 'downstream')]);
    let release;
    setHandler(async (route, body) => {
        if(body.message === 'analysis') await new Promise(resolve => {release = resolve;});
        return route.fulfill({json:{text:`输出：${body.message}`}});
    });
    await page.locator('[data-id="tail"] .agent-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'analysis').running);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images, ['/output/product.png']);
    assert.equal(await page.locator('[data-id="tail"] .agent-run').innerText(), '等待上游');
    assert.equal(await page.locator('[data-id="tail"] .agent-run').isDisabled(), true);
    assert.equal(await page.locator('[data-id="tail"]').getAttribute('data-run-phase'), 'queued');
    release();
    await page.waitForFunction(() => !smartDependencyRuns.size && nodes.find(n => n.id === 'tail').outputText);
    assert.equal(calls.length, 3);
    assert.match(calls[1].message, /输出：analysis\n\nplan/);
    assert.match(calls[2].message, /plan\n\ntail/);
    await page.evaluate(() => { nodes = JSON.parse(JSON.stringify(nodes)); render(); });
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 4, 'saved input signatures survive reopening and reuse both ancestors');
    await page.evaluate(() => { nodes.find(n => n.id === 'photo').images[0].url = '/output/new-product.png'; });
    setHandler((route, body) => route.fulfill({json:{text:`新结果：${body.message}`}}));
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 7);
    assert.deepEqual(calls[4].images, ['/output/new-product.png']);
    await page.evaluate(() => { nodes.find(n => n.id === 'analysis').systemPrompt = '分析材质'; });
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 9, 'a branch whose actual input text is identical can reuse its result');
    assert.equal(calls[7].system_prompt, '分析材质');
    assert.ok(calls.every(call => !/unrelated|downstream/.test(call.message)));
});

test('shared ancestors run once across branches and simultaneous targets', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [agent('shared'), agent('left'), agent('right'), agent('tail'), agent('other')],
        [edge('shared','left'), edge('shared','right'), edge('left','tail'), edge('right','tail'), edge('shared','other')]);
    const results = await page.evaluate(() => Promise.all([runAgentNode('tail'), runAgentNode('other'), runAgentNode('tail')]));
    assert.ok(results.every(result => result.ok));
    assert.equal(calls.length, 5);
    assert.equal(calls.filter(call => call.message === 'shared').length, 1);
    const tail = calls.find(call => call.message.endsWith('\n\ntail'));
    assert.match(tail.message, /left/);
    assert.match(tail.message, /right/);
});

test('failures, empty replies and cyclic connections prevent downstream requests', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('source'), agent('tail')], [edge('source','tail')]);
    setHandler(route => route.fulfill({status:503, json:{detail:'上游不可用'}}));
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, false);
    assert.equal(calls.length, 1);
    assert.match(await page.evaluate(() => nodes.find(n => n.id === 'tail').runError), /source.*上游不可用/);
    assert.equal(await page.locator('[data-id="tail"] .agent-run').isDisabled(), false);
    setHandler(route => route.fulfill({json:{text:''}}));
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, false);
    assert.equal(calls.length, 2);
    setHandler(null);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 4);
    await page.evaluate(() => canvas.connections.push({from:'tail', to:'source', kind:'flow'}));
    const cycle = await page.evaluate(() => runAgentNode('tail'));
    assert.equal(cycle.ok, false);
    assert.match(cycle.error, /循环连线/);
    assert.equal(calls.length, 4);
});

test('LLM prompt nodes preserve instructions, reuse results and refresh after model changes', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [
        {id:'text', type:'smart-prompt', text:'商品信息'},
        {id:'prompt', type:'smart-prompt', text:'生成卖点', llmEnabled:true, images:[]},
        agent('tail')
    ], [edge('text','prompt','flow'), edge('prompt','tail')]);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].message, '商品信息\n\n生成卖点');
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'prompt').llmInstruction), '生成卖点');
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 3);
    await page.evaluate(() => { nodes.find(n => n.id === 'prompt').llmModel = 'changed-model'; });
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 5);
    assert.equal(calls[3].message, '商品信息\n\n生成卖点');
});

test('image ancestors finish polling before Agent consumes images and reuse the displayed output', {timeout:40000}, async t => {
    const {page, calls, imageCalls} = await fixture(t);
    await install(page, [
        {id:'image', type:'smart-paint', images:[], promptDraftHtml:'生成商品图', promptDraftText:'生成商品图',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}},
        agent('tail')
    ], [edge('image','tail')]);
    const result = await page.evaluate(() => runAgentNode('tail'));
    assert.equal(result.ok, true, result.error);
    assert.equal(imageCalls.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images, ['/output/generated.png']);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(imageCalls.length, 1);
    await page.evaluate(() => { nodes.find(n => n.id === 'image').promptDraftHtml = '换一个构图'; });
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(imageCalls.length, 1, 'editing an upstream prompt keeps its displayed image as the reference');
    await page.evaluate(() => { selectedId='image'; render(); updateComposer(); });
    assert.equal((await page.evaluate(() => runGeneration())).ok, true);
    assert.equal(imageCalls.length, 2, 'running the image node itself updates its output');
    assert.match(imageCalls[1].prompt, /换一个构图/);
});

test('drawing runs in the selected node and preserves completed upstream images and their ancestors', {timeout:40000}, async t => {
    const {page, calls, imageCalls} = await fixture(t);
    const reference = {id:'reference', type:'smart-image', images:[{url:'/output/product.png', name:'参考图'}],
        x:80, y:100, runPrompt:'旧图提示词', promptDraftHtml:'上游已修改但尚未运行的提示词',
        runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k', requestMode:'async', videoTempShLinks:[]}};
    await install(page, [agent('reference-analysis'), reference,
        {id:'paint', type:'smart-paint', images:[], x:600, y:100, promptDraftHtml:'把图1改成纯白', promptDraftText:'把图1改成纯白',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('reference-analysis','reference'), edge('reference','paint')]);
    await page.waitForFunction(() => nodes.find(n => n.id === 'reference').images[0].layout_w);
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); });
    const before = await page.evaluate(() => nodes.find(n => n.id === 'reference'));
    let release;
    let queryArrived;
    const querying = new Promise(resolve => { queryArrived = resolve; });
    await page.route('**/api/canvas-image-tasks/image-*', async route => {
        await new Promise(resolve => { release = resolve; queryArrived(); });
        await route.fulfill({json:{status:'succeeded', result:{images:['/output/generated.png']}}});
    });
    await page.evaluate(() => { window.drawingRun = runGeneration(); });
    await page.waitForFunction(() => nodes.some(n => n.pendingTasks?.length));
    await querying;
    assert.equal(imageCalls.length, 1);
    assert.equal(calls.length, 0, 'a completed reference does not rerun its own ancestors');
    assert.match(imageCalls[0].prompt, /把图1改成纯白/);
    assert.deepEqual(imageCalls[0].reference_images.map(ref => ref.url || ref), ['/output/product.png']);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'paint').pending), 1);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'reference')), before);
    release();
    const result = await page.evaluate(() => window.drawingRun);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'reference')), before);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'paint').images[0].url), '/output/generated.png');
    assert.equal(await page.evaluate(() => selectedId), 'paint');
});

test('drawing failure belongs to the selected node and keeps the reference image intact', {timeout:40000}, async t => {
    const {page, imageCalls} = await fixture(t);
    const reference = {id:'reference', type:'smart-paint', images:[{url:'/output/product.png', name:'原图'}],
        runPrompt:'旧图提示词', x:80, y:100};
    await install(page, [reference,
        {id:'paint', type:'smart-paint', images:[], x:600, y:100, promptDraftHtml:'改成纯白', promptDraftText:'改成纯白',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('reference','paint')]);
    await page.route('**/api/canvas-image-tasks/image-*', route => route.fulfill({json:{status:'failed', error:'模拟生成失败', upstream_terminal_error:true}}));
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); });
    await page.waitForFunction(() => nodes.find(n => n.id === 'reference').images[0].layout_w);
    const before = await page.evaluate(() => nodes.find(n => n.id === 'reference'));
    const result = await page.evaluate(() => runGeneration());
    assert.equal(result.ok, false);
    assert.equal(imageCalls.length, 1);
    assert.match(await page.evaluate(() => nodes.find(n => n.id === 'paint').runError), /模拟生成失败/);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'reference')), before);
    assert.equal(await page.evaluate(() => selectedId), 'paint');
});

test('drawing waits for an upstream image already being regenerated and consumes its new result', {timeout:40000}, async t => {
    const {page, imageCalls} = await fixture(t);
    await install(page, [
        {id:'reference', type:'smart-paint', images:[{url:'/output/product.png', name:'旧图'}], x:80, y:100,
            running:true, runStartedAt:Date.now(), runFinishedAt:Date.now()-1000, runPrompt:'重新生成参考图'},
        {id:'paint', type:'smart-paint', images:[], x:600, y:100, promptDraftHtml:'改成纯白', promptDraftText:'改成纯白',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('reference','paint')]);
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); window.drawingRun = runGeneration(); });
    await page.waitForFunction(() => smartDependencyRuns.has('reference'));
    assert.equal(imageCalls.length, 0);
    await page.evaluate(() => {
        const source = nodes.find(n => n.id === 'reference');
        source.images = [{url:'/output/new-reference.png', name:'新图'}];
        source.running = false;
        source.runFinishedAt = Date.now();
    });
    const result = await page.evaluate(() => window.drawingRun);
    assert.equal(result.ok, true, result.error);
    assert.equal(imageCalls.length, 1);
    assert.deepEqual(imageCalls[0].reference_images.map(ref => ref.url || ref), ['/output/new-reference.png']);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'reference').images[0].url), '/output/new-reference.png');
});

test('changed inputs during a request stop the chain and deleting a target stops remaining calls', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('source'), agent('tail')], [edge('source','tail')]);
    let release;
    setHandler(async route => {
        await new Promise(resolve => {release = resolve;});
        return route.fulfill({json:{text:'旧输入的结果'}});
    });
    await page.evaluate(() => { window.chain = runAgentNode('tail'); });
    await page.waitForFunction(() => nodes.find(n => n.id === 'source').running);
    await page.evaluate(() => { nodes.find(n => n.id === 'source').userPrompt = '新要求'; });
    release();
    assert.equal((await page.evaluate(() => window.chain)).ok, false);
    assert.equal(calls.length, 1);
    assert.equal(await page.evaluate(() => smartDependencyRuns.size), 0);
    setHandler(null);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    setHandler(async route => {
        await new Promise(resolve => {release = resolve;});
        return route.fulfill({json:{text:'新结果'}});
    });
    await page.evaluate(() => {
        nodes.find(n => n.id === 'source').userPrompt = '再次修改';
        window.chain = runAgentNode('tail');
    });
    await page.waitForFunction(() => nodes.find(n => n.id === 'source').running);
    await page.evaluate(() => { nodes = nodes.filter(n => n.id !== 'tail'); });
    release();
    assert.equal((await page.evaluate(() => window.chain)).ok, false);
    assert.equal(calls.length, 4);
});

test('the drawing run button prepares Agent output and keeps the selected node prompt and model', {timeout:40000}, async t => {
    const {page, calls, imageCalls} = await fixture(t);
    await install(page, [agent('analysis'),
        {id:'paint', type:'smart-paint', images:[], x:600, y:100, promptDraftHtml:'绘制主图', promptDraftText:'绘制主图',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('analysis','paint','flow')]);
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); });
    const result = await page.evaluate(() => runGeneration());
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.length, 1);
    assert.equal(imageCalls.length, 1);
    assert.match(imageCalls[0].prompt, /绘制主图/);
    assert.match(imageCalls[0].prompt, /结果1：analysis/);
    assert.equal(imageCalls[0].model, 'gpt-image-2');
    assert.equal((await page.evaluate(() => runGeneration())).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(imageCalls.length, 2);
});

test('an existing upstream task is awaited without another request', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [agent('source', {running:true, runStartedAt:Date.now()}), agent('tail')], [edge('source','tail')]);
    await page.evaluate(() => { window.chain = runAgentNode('tail'); });
    assert.equal(calls.length, 0);
    assert.equal(await page.locator('[data-id="tail"] .agent-run').innerText(), '等待上游');
    await page.evaluate(() => {
        const source = nodes.find(n => n.id === 'source');
        source.outputText = '已完成的分析'; source.running = false; source.runFinishedAt = Date.now();
    });
    assert.equal((await page.evaluate(() => window.chain)).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, '已完成的分析\n\ntail');
});

test('changing connections while waiting stops the chain without starting a new cycle', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('source'), agent('tail')], [edge('source','tail')]);
    let release;
    setHandler(async route => {
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({json:{text:'已完成'}});
    });
    await page.evaluate(() => { window.chain = runAgentNode('tail'); });
    await page.waitForFunction(() => nodes.find(n => n.id === 'source').running);
    await page.evaluate(() => { canvas.connections = [{from:'tail', to:'source', kind:'flow'}]; });
    release();
    const result = await page.evaluate(() => window.chain);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(await page.evaluate(() => smartDependencyRuns.size), 0);
});

test('a drawing using only connected text does not duplicate it on rerun', {timeout:40000}, async t => {
    const {page, imageCalls} = await fixture(t);
    await install(page, [{id:'text', type:'smart-prompt', text:'画一个蓝色杯子'},
        {id:'paint', type:'smart-paint', images:[], x:600, y:100, promptDraftHtml:'', promptDraftText:'',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('text','paint','flow')]);
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); });
    assert.equal((await page.evaluate(() => runGeneration())).ok, true);
    assert.equal((await page.evaluate(() => runGeneration())).ok, true);
    assert.equal(imageCalls.length, 2);
    assert.equal(imageCalls[0].prompt, imageCalls[1].prompt);
    assert.equal(imageCalls[1].prompt.match(/画一个蓝色杯子/g).length, 1);
});
