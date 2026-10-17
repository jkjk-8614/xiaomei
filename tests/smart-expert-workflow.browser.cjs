const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function fixture(t, outcomes=['completed']){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1700, height:1000}});
    const errors = [], requests = [], llmCalls = [], runs = new Map();
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'expert-flow.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, chat_models:['chat-a','chat-b'], image_models:[]
        }], comfy_instances:[]}});
        if(url.pathname === '/api/providers') return route.fulfill({json:{providers:[
            {id:'modelscope', name:'ModelScope', enabled:true, chat_models:['Qwen/Qwen3-235B-A22B'], image_models:[]},
            {id:'fixture', name:'Fixture', enabled:true, chat_models:['chat-a','chat-b'], image_models:[]},
            {id:'gemini-cli', name:'Antigravity CLI', enabled:true, chat_models:['gemini-3.8-flash-high','auto'], image_models:[]}
        ]}});
        if(url.pathname === '/api/agent-skills') return route.fulfill({json:{skills:[
            {id:'analysis-skill', name:'商品分析', enabled:true},
            {id:'copy-skill', name:'文案写作', enabled:true},
        ]}});
        if(url.pathname === '/api/canvas-llm'){
            const body = request.postDataJSON();
            llmCalls.push(body);
            return route.fulfill({json:{text:'下游收到：' + body.message}});
        }
        if(url.pathname === '/api/expert-workflows/runs' && request.method() === 'POST'){
            const body = request.postDataJSON();
            requests.push(body);
            const id = `run${requests.length}`;
            const prior = runs.get(body.resume_from);
            const steps = body.workflow.experts.map((expert, index) => ({
                ...expert, status:index <= body.resume_after_step && prior ? 'reused' : 'waiting',
                input:index <= body.resume_after_step && prior ? prior.steps[index].input : '',
                output:index <= body.resume_after_step && prior
                    ? (index === body.resume_after_step && body.edited_output || prior.steps[index].output) : '',
                error:'',
            }));
            const run = {id, node_id:body.node_id, canvas_id:body.canvas_id, status:'queued',
                name:body.workflow.name, steps, output:'', error:'', polls:0,
                outcome:outcomes[requests.length - 1] || 'completed', created_at:Date.now() / 1000};
            runs.set(id, run);
            return route.fulfill({json:run});
        }
        if(url.pathname === '/api/expert-workflows/runs' && request.method() === 'GET'){
            return route.fulfill({json:{runs:[...runs.values()].reverse().map(run => ({
                id:run.id, status:run.status, created_at:run.created_at, name:run.name,
            }))}});
        }
        const match = url.pathname.match(/^\/api\/expert-workflows\/runs\/(run\d+)(\/cancel)?$/);
        if(match){
            const run = runs.get(match[1]);
            if(!run) return route.fulfill({status:404, json:{detail:'未找到运行记录'}});
            if(match[2]){
                run.status = 'cancelled';
                return route.fulfill({json:run});
            }
            if(run.status === 'queued' || run.status === 'running'){
                run.polls++;
                if(run.outcome === 'hold'){
                    run.status = 'running';
                    run.steps[0].status = 'running';
                } else if(run.outcome === 'completed' && run.polls === 1){
                    run.status = 'running';
                    run.steps[0].status = run.steps[0].status === 'reused' ? 'reused' : 'completed';
                    run.steps[0].output ||= '分析结果';
                    run.steps[1].status = 'running';
                } else if(run.outcome === 'paused'){
                    run.status = 'paused';
                    run.steps[0].status = 'completed';
                    run.steps[0].output = '待审阅的分析';
                } else if(run.outcome === 'failed'){
                    run.status = 'failed';
                    run.steps[0].status = run.steps[0].status === 'reused' ? 'reused' : 'completed';
                    run.steps[0].output ||= '分析结果';
                    run.steps[1].status = 'failed';
                    run.steps[1].error = '上游暂时不可用';
                    run.error = '专家「文案写作」运行失败：上游暂时不可用';
                } else {
                    run.status = 'completed';
                    run.steps[0].status = run.steps[0].status === 'reused' ? 'reused' : 'completed';
                    run.steps[0].output ||= '分析结果';
                    run.steps[1].status = 'completed';
                    run.steps[1].input = '上一位专家的结果：' + run.steps[0].output;
                    run.steps[1].output = '最终专家结果';
                    run.output = '最终专家结果';
                }
            }
            return route.fulfill({json:run});
        }
        if(url.pathname === '/api/canvases/fixture' && request.method() === 'GET'){
            return route.fulfill({json:{canvas:{id:'fixture', title:'专家协作测试', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://expert-flow.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    t.after(() => assert.deepEqual(errors, []));
    return {page, requests, llmCalls, runs};
}

async function createConfiguredWorkflow(page){
    await page.evaluate(() => openCreateMenu({clientX:400, clientY:350}, {point:{x:400, y:350}}));
    await page.locator('[data-create-type="expert-workflow"]').click();
    const id = await page.evaluate(() => nodes.find(node => node.agentMode === 'expert-workflow')?.id);
    assert.ok(id);
    await page.locator(`[data-id="${id}"] .expert-workflow-node-input`).fill('给出商品主图文案');
    await page.locator(`[data-id="${id}"] .expert-workflow-open`).click();
    await page.locator('.expert-workflow-add').click();
    await page.waitForFunction(() => document.querySelectorAll('.expert-workflow-sidebar [data-ew-field="skill_id"] option').length > 1);
    await page.locator('[data-ew-field="name"]').fill('需求分析');
    await page.locator('[data-ew-field="skill_id"]').selectOption('analysis-skill');
    assert.deepEqual(await page.locator('[data-ew-field="provider"] option').allTextContents(), ['选择平台', 'Fixture', 'Antigravity CLI']);
    assert.equal(await page.locator('[data-ew-field="provider"]').inputValue(), 'fixture');
    await page.locator('[data-ew-field="instruction"]').fill('分析商品定位');
    await page.locator('.expert-workflow-add').click();
    await page.locator('[data-ew-field="name"]').fill('文案写作');
    await page.locator('[data-ew-field="skill_id"]').selectOption('copy-skill');
    await page.locator('[data-ew-field="model"]').selectOption('chat-b');
    assert.equal(await page.locator('.expert-workflow-card').count(), 4);
    assert.deepEqual(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.edges, id), [
        {from:'input', to:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[0].id, id)},
        {from:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[0].id, id),
            to:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[1].id, id)},
        {from:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[1].id, id), to:'output'},
    ]);
    return id;
}

test('changing a platform immediately replaces its model choices', {timeout:60000}, async t => {
    const {page} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    await page.evaluate(id => {
        const expert = nodes.find(node => node.id === id).expertWorkflow.experts[1];
        expert.provider = 'modelscope';
        expert.model = 'Qwen/Qwen3-235B-A22B';
        document.querySelector(`[data-ew-card="${expert.id}"]`).click();
        const select = document.querySelector('[data-ew-field="provider"]');
        select.value = 'gemini-cli';
        select.dispatchEvent(new Event('input', {bubbles:true}));
    }, id);
    assert.equal(await page.locator('[data-ew-field="provider"]').inputValue(), 'gemini-cli');
    assert.deepEqual(await page.locator('[data-ew-field="model"] option').allTextContents(),
        ['选择模型', 'gemini-3.8-flash-high', 'auto']);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[1].model, id), 'gemini-3.8-flash-high');
});

test('one canvas node runs Skill experts and passes its fresh result downstream', {timeout:60000}, async t => {
    const {page, requests, llmCalls} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    await page.evaluate(id => {
        nodes.push({id:'source', type:'smart-prompt', title:'产品信息', text:'面料柔软', x:20, y:50});
        canvas.connections = [{from:'source', to:id, kind:'input'}];
        canvasUsesConnections = true;
        render();
    }, id);
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(() => document.querySelector('.expert-workflow-status')?.dataset.phase === 'running');
    assert.equal(await page.locator('.expert-workflow-add').isDisabled(), true);
    assert.equal(await page.locator('[data-ew-field="skill_id"]').isDisabled(), true);
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'completed', id);
    assert.equal(await page.locator('.expert-workflow-add').isDisabled(), false);
    assert.equal(requests.length, 1);
    assert.match(requests[0].message, /来自「产品信息」：\n面料柔软/);
    assert.deepEqual(requests[0].workflow.experts.map(item => [item.skill_id, item.model]), [
        ['analysis-skill','chat-a'], ['copy-skill','chat-b'],
    ]);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).outputText, id), '最终专家结果');
    await page.locator('.expert-workflow-name').fill('商品视觉协作');
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).expertRunStatus, id), 'completed');
    await page.evaluate(async id => {
        const node = nodes.find(item => item.id === id);
        node.expertRunStatus = 'running';
        node.running = true;
        node.outputText = '';
        delete node.dependencyRunSignature;
        await SmartExpertWorkflow.restore([node]);
    }, id);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).outputText, id), '最终专家结果');
    await page.locator('.expert-workflow-close').click();
    await page.evaluate(id => {
        nodes.push({id:'downstream', type:'smart-agent', title:'下游', userPrompt:'整理成摘要',
            outputText:'', images:[], x:900, y:100, w:430, h:640, agentProvider:'fixture', agentModel:'chat-a'});
        canvas.connections.push({from:id, to:'downstream', kind:'input'});
        render();
    }, id);
    assert.equal((await page.evaluate(() => runAgentNode('downstream'))).ok, true);
    assert.equal(requests.length, 1, '已完成且输入未变化的专家流程应复用');
    assert.match(llmCalls[0].message, /最终专家结果/);
    await page.evaluate(() => { nodes.find(node => node.id === 'source').text = '面料升级'; });
    assert.equal((await page.evaluate(() => runAgentNode('downstream'))).ok, true);
    assert.equal(requests.length, 2, '上游文字变化后应重新执行专家流程');
    assert.match(requests[1].message, /面料升级/);
});

test('reviewed output continues to failure and retries from the failed expert', {timeout:60000}, async t => {
    const {page, requests} = await fixture(t, ['paused','failed','completed']);
    const id = await createConfiguredWorkflow(page);
    const expertIds = await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts.map(item => item.id), id);
    await page.locator(`[data-ew-card="${expertIds[0]}"]`).click();
    await page.locator('[data-ew-field="pause_after"]').check();
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'paused', id);
    await page.locator(`[data-ew-card="${expertIds[0]}"]`).click();
    await page.locator('[data-ew-edited]').fill('人工修改后的分析');
    await page.locator('[data-ew-continue]').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'failed', id);
    assert.equal(requests[1].resume_from, 'run1');
    assert.equal(requests[1].resume_after_step, 0);
    assert.equal(requests[1].edited_output, '人工修改后的分析');
    await page.locator(`[data-ew-card="${expertIds[1]}"]`).click();
    await page.locator('[data-ew-retry]').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'completed', id);
    assert.equal(requests[2].resume_from, 'run2');
    assert.equal(requests[2].resume_after_step, 0);
    assert.equal(requests.length, 3);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).outputText, id), '最终专家结果');
});

test('stopping a running expert workflow cancels its server run', {timeout:60000}, async t => {
    const {page, requests, runs} = await fixture(t, ['hold']);
    const id = await createConfiguredWorkflow(page);
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'running', id);
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'cancelled', id);
    assert.equal(runs.get('run1').status, 'cancelled');
    assert.equal(requests.length, 1);
});

test('a paused workflow can start a fresh run from the beginning', {timeout:60000}, async t => {
    const {page, requests} = await fixture(t, ['paused','paused']);
    const id = await createConfiguredWorkflow(page);
    const firstId = await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[0].id, id);
    await page.locator(`[data-ew-card="${firstId}"]`).click();
    await page.locator('[data-ew-field="pause_after"]').check();
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunStatus === 'paused', id);
    assert.equal(await page.locator('.expert-workflow-start').innerText(), '从头运行');
    await page.locator('.expert-workflow-start').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.expertRunId === 'run2', id);
    assert.equal(Object.hasOwn(requests[1], 'resume_from'), false);
});

test('internal connection can be removed and dragged back between expert ports', {timeout:60000}, async t => {
    const {page} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    const expertIds = await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts.map(item => item.id), id);
    const line = await page.locator('[data-ew-edge="1"]').evaluate(element => {
        const box = element.getBoundingClientRect();
        return {x:box.left + box.width / 2, y:box.top + box.height / 2};
    });
    await page.mouse.click(line.x, line.y);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.edges.length, id), 2);
    const from = await page.locator(`[data-ew-out="${expertIds[0]}"]`).boundingBox();
    const to = await page.locator(`[data-ew-in="${expertIds[1]}"]`).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {steps:8});
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.edges.map(item => [item.from, item.to]), id), [
        ['input', expertIds[0]], [expertIds[1], 'output'], [expertIds[0], expertIds[1]],
    ]);
});

test('input and output cards move with their connections', {timeout:60000}, async t => {
    const {page} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    for(const cardId of ['input', 'output']){
        const before = await page.locator(`[data-ew-card="${cardId}"]`).boundingBox();
        const line = page.locator('.expert-workflow-line').nth(cardId === 'input' ? 0 : 2);
        const pathBefore = await line.getAttribute('d');
        await page.mouse.move(before.x + 70, before.y + 45);
        await page.mouse.down();
        await page.mouse.move(before.x + 130, before.y + 105, {steps:6});
        await page.mouse.up();
        const after = await page.locator(`[data-ew-card="${cardId}"]`).boundingBox();
        assert.ok(Math.abs(after.x - before.x - 60) < 2);
        assert.ok(Math.abs(after.y - before.y - 60) < 2);
        assert.deepEqual(await page.evaluate(([nodeId, endpoint]) =>
            nodes.find(node => node.id === nodeId).expertWorkflow.positions[endpoint], [id, cardId]),
            {x:cardId === 'input' ? 110 : 1000, y:360});
        assert.notEqual(await line.getAttribute('d'), pathBefore);
    }
});

test('dropping a connection on empty canvas creates an expert and keeps its preview under the pointer', {timeout:60000}, async t => {
    const {page} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    const sourceId = await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[0].id, id);
    const source = await page.locator(`[data-ew-out="${sourceId}"]`).boundingBox();
    const drop = {x:900, y:740};
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, {steps:8});
    const preview = await page.locator('.expert-workflow-line.preview').getAttribute('d');
    const expected = await page.evaluate(point => {
        const rect = document.querySelector('.expert-workflow-stage').getBoundingClientRect();
        return {x:point.x - rect.left, y:point.y - rect.top};
    }, drop);
    const end = preview.match(/,\s*([\d.-]+)\s+([\d.-]+)$/);
    assert.ok(end, preview);
    assert.ok(Math.abs(Number(end[1]) - expected.x) < 2);
    assert.ok(Math.abs(Number(end[2]) - expected.y) < 2);
    await page.locator('.expert-workflow-viewport').evaluate(element => {
        element.querySelector('.expert-workflow-stage').style.height = '1200px';
        element.scrollTop += 50;
    });
    await page.waitForFunction(previous => document.querySelector('.expert-workflow-line.preview')?.getAttribute('d') !== previous, preview);
    const scrolled = await page.locator('.expert-workflow-line.preview').getAttribute('d');
    assert.notEqual(scrolled, preview);
    await page.mouse.up();
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts.length, id), 3);
    assert.deepEqual(await page.evaluate(([nodeId, from]) => {
        const flow = nodes.find(node => node.id === nodeId).expertWorkflow;
        const created = flow.experts[2].id;
        return flow.edges.filter(edge => edge.from === from || edge.from === created);
    }, [id, sourceId]), [
        {from:sourceId, to:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[2].id, id)},
        {from:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[2].id, id),
            to:await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts[1].id, id)}
    ]);
});

test('zoom controls and wheel keep card dragging and connection previews aligned', {timeout:60000}, async t => {
    const {page} = await fixture(t);
    const id = await createConfiguredWorkflow(page);
    await page.locator('[data-ew-zoom="in"]').click();
    await page.locator('[data-ew-zoom="in"]').click();
    assert.equal(await page.locator('.expert-workflow-zoom-label').innerText(), '130%');
    await page.locator('.expert-workflow-viewport').evaluate(element => {
        element.scrollLeft = 0;
        element.scrollTop = 0;
    });
    const before = await page.locator('[data-ew-card="input"]').boundingBox();
    await page.mouse.move(before.x + 70, before.y + 45);
    await page.mouse.down();
    await page.mouse.move(before.x + 135, before.y + 110, {steps:6});
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.positions.input, id),
        {x:100, y:350});
    const port = await page.locator('[data-ew-out="input"]').boundingBox();
    const drop = {x:770, y:735};
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, {steps:5});
    const preview = await page.locator('.expert-workflow-line.preview').getAttribute('d');
    const expected = await page.evaluate(point => {
        const rect = document.querySelector('.expert-workflow-stage').getBoundingClientRect();
        return {x:(point.x - rect.left) / 1.3, y:(point.y - rect.top) / 1.3};
    }, drop);
    const end = preview.match(/,\s*([\d.-]+)\s+([\d.-]+)$/);
    assert.ok(Math.abs(Number(end[1]) - expected.x) < 2);
    assert.ok(Math.abs(Number(end[2]) - expected.y) < 2);
    await page.mouse.up();
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).expertWorkflow.experts.length, id), 3);
    const viewport = await page.locator('.expert-workflow-viewport').boundingBox();
    const scrollBefore = await page.locator('.expert-workflow-viewport').evaluate(element => element.scrollTop);
    await page.mouse.move(viewport.x + 40, viewport.y + 80);
    await page.mouse.down();
    await page.mouse.move(viewport.x + 40, viewport.y + 20, {steps:5});
    await page.mouse.up();
    assert.ok(await page.locator('.expert-workflow-viewport').evaluate(element => element.scrollTop) > scrollBefore);
    await page.locator('[data-ew-zoom="reset"]').click();
    assert.equal(await page.locator('.expert-workflow-zoom-label').innerText(), '100%');
    await page.locator('.expert-workflow-viewport').hover({position:{x:100, y:100}});
    await page.mouse.wheel(0, -100);
    assert.equal(await page.locator('.expert-workflow-zoom-label').innerText(), '110%');
});
