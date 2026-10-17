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

test('one click runs missing ancestors, then reuses completed Agents until each is run directly', {timeout:40000}, async t => {
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
    assert.equal(await page.locator('[data-id="tail"] .agent-run').innerText(), '取消');
    assert.equal(await page.locator('[data-id="tail"] .agent-run').isDisabled(), false);
    assert.equal(await page.locator('[data-id="tail"]').getAttribute('data-run-phase'), 'queued');
    release();
    await page.waitForFunction(() => !smartDependencyRuns.size && nodes.find(n => n.id === 'tail').outputText);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].images, [], 'the next Agent receives the analysis text without inherited images');
    assert.deepEqual(calls[2].images, [], 'later Agents also receive text without inherited images');
    assert.equal(await page.locator('[data-id="plan"] .smart-node-input-thumb').count(), 0);
    assert.match(calls[1].message, /输出：analysis\n\nplan/);
    assert.match(calls[2].message, /plan\n\ntail/);
    await page.evaluate(() => {
        nodes = JSON.parse(JSON.stringify(nodes));
        nodes.find(n => n.id === 'analysis').dependencyRunSignature = undefined;
        nodes.find(n => n.id === 'plan').dependencyRunSignature = undefined;
        render();
    });
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 4, 'completed ancestors are reused even without saved signatures');
    await page.evaluate(() => {
        nodes.find(n => n.id === 'photo').images[0].url = '/output/new-product.png';
        nodes.find(n => n.id === 'analysis').systemPrompt = '分析材质';
    });
    setHandler((route, body) => route.fulfill({json:{text:`新结果：${body.message}`}}));
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 5, 'editing upstream inputs does not rerun completed Agents');
    assert.match(calls[4].message, /输出：analysis\n\nplan\n\ntail/);
    assert.equal((await page.evaluate(() => runAgentNode('analysis'))).ok, true);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls[5].images, ['/output/new-product.png']);
    assert.equal(calls[5].system_prompt, '分析材质');
    assert.equal((await page.evaluate(() => runAgentNode('plan'))).ok, true);
    assert.equal(calls.length, 7);
    assert.match(calls[6].message, /新结果：analysis\n\nplan/);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 8);
    assert.match(calls[7].message, /新结果：新结果：analysis\n\nplan\n\ntail/);
    assert.ok(calls.every(call => !/unrelated|downstream/.test(call.message)));
});

test('an Agent receives only its own direct image inputs beside upstream Agent text', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [
        {id:'source-image', type:'smart-upload', images:[{url:'/output/source.png'}]},
        agent('analysis', {outputText:'已分析商品图'}),
        {id:'new-image', type:'smart-upload', images:[{url:'/output/new.png'}]},
        agent('tail', {x:600})
    ], [edge('source-image','analysis'), edge('analysis','tail','flow'), edge('new-image','tail')]);
    assert.deepEqual(await page.locator('[data-id="tail"] .smart-node-input-thumb').count(), 1);
    const result = await page.evaluate(() => runAgentNode('tail'));
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images, ['/output/new.png']);
    assert.equal(calls[0].message, '已分析商品图\n\ntail');
});

test('cancel stops a stalled upstream Agent and leaves the downstream node ready to rerun', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('source'), agent('tail', {x:600})], [edge('source','tail')]);
    let release;
    setHandler(async route => {
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({json:{text:'迟到的输出'}}).catch(() => {});
    });
    await page.locator('[data-id="tail"] .agent-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'source').running);
    await page.locator('[data-id="tail"] .agent-cancel-top').click();
    await page.waitForFunction(() => !smartDependencyRuns.size && !nodes.find(n => n.id === 'source').running);
    assert.equal(calls.length, 1);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'tail').runError), 'Agent 运行已取消');
    assert.equal(await page.locator('[data-id="tail"]').getAttribute('data-run-phase'), 'cancelled');
    assert.equal(await page.locator('[data-id="tail"] .agent-run').innerText(), '运行');
    release();
    setHandler((route, body) => route.fulfill({json:{text:`重试成功：${body.message}`}}));
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    assert.equal(calls.length, 3);
    assert.match(await page.evaluate(() => nodes.find(n => n.id === 'tail').outputText), /重试成功/);
});

test('canceling one chain keeps a shared upstream Agent for another chain', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('shared'), agent('left', {x:600}), agent('right', {x:1100})],
        [edge('shared','left'), edge('shared','right')]);
    let release;
    setHandler(async (route, body) => {
        if(body.message === 'shared') await new Promise(resolve => { release = resolve; });
        await route.fulfill({json:{text:`输出：${body.message}`}}).catch(() => {});
    });
    await page.evaluate(() => { window.leftRun = runAgentNode('left'); window.rightRun = runAgentNode('right'); });
    await page.waitForFunction(() => nodes.find(n => n.id === 'shared').running && smartDependencyRuns.get('shared')?.owners.size === 2);
    await page.locator('[data-id="left"] .agent-cancel-top').click();
    assert.equal((await page.evaluate(() => window.leftRun)).ok, false);
    assert.equal(await page.evaluate(() => smartDependencyRuns.get('shared')?.controller.signal.aborted), false);
    release();
    assert.equal((await page.evaluate(() => window.rightRun)).ok, true);
    assert.equal(calls.filter(call => call.message === 'shared').length, 1);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'left').outputText || ''), '');
    assert.match(await page.evaluate(() => nodes.find(n => n.id === 'right').outputText), /输出/);
});

test('cancel aborts a running Agent request without replacing its previous output', {timeout:40000}, async t => {
    const {page, calls, setHandler} = await fixture(t);
    await install(page, [agent('solo', {outputText:'之前的输出'})], []);
    let release;
    setHandler(async route => {
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({json:{text:'迟到的输出'}}).catch(() => {});
    });
    await page.locator('[data-id="solo"] .agent-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'solo').running);
    await page.locator('[data-id="solo"] .agent-run').click();
    await page.waitForFunction(() => !smartDependencyRuns.size && !nodes.find(n => n.id === 'solo').running);
    release();
    assert.equal(calls.length, 1);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'solo').outputText), '之前的输出');
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'solo').runError), 'Agent 运行已取消');
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

test('Prompt keeps its instruction separate from editable downstream output', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [
        {id:'source', type:'smart-prompt', text:'商品信息', x:80, y:150},
        {id:'prompt', type:'smart-prompt', text:'生成卖点', llmEnabled:true, images:[], x:470, y:150}
    ], [edge('source','prompt','flow')]);
    const prompt = page.locator('[data-id="prompt"]');
    assert.equal(await prompt.locator('.prompt-node-top').innerText(), '提示词');
    assert.equal(await prompt.locator('.prompt-node-output-field > span').innerText(), '输出提示词');
    assert.equal(await prompt.locator('.prompt-node-upstream .prompt-node-segment p').innerText(), '商品信息');
    const layout = await prompt.evaluate(element => ({
        card:element.querySelector('.prompt-node-card').getBoundingClientRect(),
        output:element.querySelector('.prompt-node-text').getBoundingClientRect(),
        footer:element.querySelector('.prompt-node-footer').getBoundingClientRect()
    }));
    assert.ok(layout.output.height >= 72 && layout.footer.bottom <= layout.card.bottom + 1);
    assert.equal((await page.evaluate(() => runPromptLLMNode('prompt'))).ok, true);
    assert.equal(calls[0].message, '商品信息\n\n生成卖点');
    assert.equal(await prompt.locator('.prompt-llm-instruction').inputValue(), '生成卖点');
    await prompt.locator('.prompt-node-text').fill('手动修改后的提示词');
    assert.deepEqual(await page.evaluate(() => ({text:textForNode(nodes.find(n => n.id === 'prompt')), images:outputImagesForNode(nodes.find(n => n.id === 'prompt'))})),
        {text:'手动修改后的提示词', images:[]});
    assert.equal((await page.evaluate(() => runPromptLLMNode('prompt'))).ok, true);
    assert.equal(calls[1].message, '商品信息\n\n生成卖点');
    assert.equal(await prompt.locator('.prompt-node-text').inputValue(), '结果2：商品信息\n\n生成卖点');
    await page.evaluate(() => { const node = nodes.find(n => n.id === 'prompt'); node.llmInstruction = ''; node.promptRunAt = Date.now(); canvas.connections = []; });
    const before = calls.length;
    assert.equal((await page.evaluate(() => runPromptLLMNodeDirect('prompt'))).ok, false);
    assert.equal(calls.length, before, 'completed output cannot silently become a new instruction');
    await prompt.locator('.prompt-node-text').fill('第一段;第二段');
    assert.equal(await prompt.locator('.prompt-split-toggle').count(), 0);
    assert.equal(await page.evaluate(() => textForNode(nodes.find(n => n.id === 'prompt'))), '第一段;第二段');
    await page.evaluate(() => { nodes.find(n => n.id === 'prompt').promptSplitEnabled = true; });
    assert.equal(await page.evaluate(() => textForNode(nodes.find(n => n.id === 'prompt'))), '第一段;第二段');
    const fresh = await page.evaluate(() => {
        const node = createPromptNode(900, 150, {select:false});
        node.text = '手动输出';
        node.llmEnabled = true;
        render();
        return {initialized:node.promptInstructionInitialized, instruction:node.llmInstruction};
    });
    assert.deepEqual(fresh, {initialized:true, instruction:''});
});

test('Prompt shows system instructions first and uses Skills from the shared library', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await page.route('**/api/agent-skills', route => route.fulfill({json:{skills:[{id:'fixture-skill', name:'商品文案'}]}}));
    await page.route('**/api/agent-skills/fixture-skill', route => route.fulfill({json:{instructions:'用简洁的中文写卖点'}}));
    await install(page, [{id:'prompt', type:'smart-prompt', text:'', llmEnabled:true, llmSystemEnabled:true,
        llmSystemPrompt:'遵守品牌语气', llmInstruction:'写一句商品文案', promptInstructionInitialized:true,
        llmProvider:'fixture', llmModel:'fixture-chat', x:470, y:150, w:460, h:560}], []);
    const prompt = page.locator('[data-id="prompt"]');
    const fileChooser = page.waitForEvent('filechooser');
    await prompt.locator('.agent-skill-install').click();
    await fileChooser;
    assert.deepEqual(await prompt.evaluate(element => [
        '.prompt-llm-system', '.prompt-llm-instruction', '.prompt-node-text'
    ].map(selector => element.querySelector(selector).getBoundingClientRect().top).every((top, index, values) => !index || values[index - 1] < top)), true);
    await prompt.locator('.agent-skill-library').click();
    await prompt.locator('.agent-skill-library-use').click();
    await prompt.locator('.agent-skill-chip').waitFor({state:'visible'});
    assert.equal(await prompt.locator('.agent-skill-chip').count(), 1);
    assert.equal(await prompt.evaluate(element => {
        const card = element.querySelector('.prompt-node-card').getBoundingClientRect();
        const output = element.querySelector('.prompt-node-text').getBoundingClientRect();
        const footer = element.querySelector('.prompt-node-footer').getBoundingClientRect();
        return output.height >= 72 && footer.bottom <= card.bottom + 1;
    }), true);
    assert.equal((await page.evaluate(() => runPromptLLMNodeDirect('prompt'))).ok, true);
    assert.match(calls[0].system_prompt, /遵守品牌语气[\s\S]*商品文案[\s\S]*用简洁的中文写卖点/);
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

test('retrying a failed drawing reuses an Agent output even when its last run has an error', {timeout:40000}, async t => {
    const {page, calls, imageCalls} = await fixture(t);
    await install(page, [
        agent('source', {outputText:'已经完成的生图提示词', x:80, y:100}),
        {id:'paint', type:'smart-paint', images:[], x:600, y:100,
            promptDraftText:'绘制主图', promptDraftHtml:'绘制主图',
            runSettings:{engine:'api', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'1:1', resolution:'1k'}}
    ], [edge('source','paint','flow')]);
    await page.route('**/api/canvas-image-tasks/image-*', route => route.fulfill({json:
        imageCalls.length === 1
            ? {status:'failed', error:'模拟生图失败', upstream_terminal_error:true}
            : {status:'succeeded', result:{images:['/output/generated.png']}}
    }));
    await page.evaluate(() => { selectedId='paint'; render(); updateComposer(); });
    assert.equal((await page.evaluate(() => runGeneration())).ok, false);
    assert.equal(calls.length, 0);
    await page.evaluate(() => { nodes.find(node => node.id === 'source').runError = '之前一次 Agent 重试失败'; render(); });
    assert.match(await page.locator('[data-id="paint"] .generation-failed-message').innerText(), /模拟生图失败/);
    await page.locator('[data-id="paint"] [data-image-rerun]').click();
    await page.waitForFunction(() => nodes.find(node => node.id === 'paint').images?.some(image => image.url));
    assert.equal(calls.length, 0, 'the saved upstream text must not be regenerated');
    assert.equal(imageCalls.length, 2, 'only the failed drawing is submitted again');
    assert.match(imageCalls[1].prompt, /已经完成的生图提示词/);
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'source').outputText), '已经完成的生图提示词');
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
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'source').outputText || ''), '', 'a reply for changed inputs is discarded');
    setHandler(null);
    assert.equal((await page.evaluate(() => runAgentNode('tail'))).ok, true);
    setHandler(async route => {
        await new Promise(resolve => {release = resolve;});
        return route.fulfill({json:{text:'新结果'}});
    });
    await page.evaluate(() => {
        nodes.find(n => n.id === 'source').userPrompt = '再次修改';
        nodes.find(n => n.id === 'source').outputText = '';
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
    assert.equal(await page.locator('[data-id="tail"] .agent-run').innerText(), '取消');
    await page.evaluate(() => {
        const source = nodes.find(n => n.id === 'source');
        source.outputText = '已完成的分析'; source.running = false; source.runFinishedAt = Date.now();
    });
    assert.equal((await page.evaluate(() => window.chain)).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, '已完成的分析\n\ntail');
});

test('cancel clears an orphaned upstream Agent running state', {timeout:40000}, async t => {
    const {page, calls} = await fixture(t);
    await install(page, [agent('source', {running:true, runStartedAt:Date.now() - 600000}), agent('tail')], [edge('source','tail')]);
    await page.evaluate(() => { window.chain = runAgentNode('tail'); });
    await page.waitForFunction(() => smartDependencyRuns.get('source')?.waitingForExistingTask);
    await page.locator('[data-id="tail"] .agent-cancel-top').click();
    assert.equal((await page.evaluate(() => window.chain)).ok, false);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'source').running), false);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'source').runError), 'Agent 运行已取消');
    assert.equal(calls.length, 0);
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
