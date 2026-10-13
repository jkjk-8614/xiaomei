const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1700, height:950}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'node-feedback.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/fixture') return route.fulfill({json:{canvas:{id:'fixture', title:'节点运行反馈', nodes:[], connections:[], logs:[], settings:{}}}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://node-feedback.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    return {page, errors};
}

test('node feedback follows queue, progress, completion and failure in both themes', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    await page.evaluate(() => {
        const start = Date.now() - 32000;
        nodes = [
            {id:'agent', type:'smart-agent', x:80, y:100, w:440, h:650, running:true, runStartedAt:start, systemPrompt:'你是一名电商视觉策划师。', userPrompt:'分析参考图片，规划详情页。', outputText:'运行结果会显示在这里。', images:[]},
            {id:'parallel', type:'smart-agent', x:600, y:100, w:440, h:650, running:true, runStartedAt:start, systemPrompt:'你是一名文案编辑。', userPrompt:'根据商品卖点，生成详情页文案。', images:[]},
            {id:'image', type:'smart-paint', x:1120, y:100, w:300, h:330, pending:1, running:true, queued:true, runStartedAt:start, pendingTasks:[{taskId:'queued-task', status:'queued'}], images:[]},
            {id:'failed', type:'smart-agent', x:1120, y:490, w:440, h:340, runStartedAt:start, runFinishedAt:Date.now(), runError:'请求失败，请重试', images:[]}
        ];
        canvas.connections = [{from:'agent', to:'parallel', kind:'input'}];
        viewport = {x:0, y:0, scale:1};
        selectedId = '';
        applyViewport();
        render();
        window.feedbackContent = document.querySelector('[data-id="agent"] .agent-output-text');
    });
    const agent = page.locator('.image-node[data-id="agent"]');
    const image = page.locator('.image-node[data-id="image"]');
    const failed = page.locator('.image-node[data-id="failed"]');
    assert.match(await agent.locator('.agent-node-top').innerText(), /运行中\s*·\s*32秒/);
    assert.equal(await page.locator('.image-node[data-run-phase="running"]').count(), 2);
    assert.equal(await image.getAttribute('data-run-phase'), 'queued');
    assert.equal(await image.locator('.node-run-status').isVisible(), false);
    assert.equal(await image.locator('.generation-progress-wrap').isVisible(), true);
    assert.equal(await image.locator('.node-run-flow').isVisible(), false);
    assert.equal(await failed.getAttribute('data-run-phase'), 'failed');
    assert.equal(await failed.locator('.node-run-flow').isVisible(), false);
    const artifacts = path.join(os.tmpdir(), 'xiaomei-node-feedback-preview');
    fs.mkdirSync(artifacts, {recursive:true});
    for(const dark of [false, true]){
        await page.evaluate(dark => {
            StudioAppearance.apply({skin:dark ? 'dark' : 'minimal'});
        }, dark);
        assert.equal(await image.locator('.node-run-status').isVisible(), false);
        assert.equal(await image.locator('.generation-progress-wrap').isVisible(), true);
        assert.equal(await agent.locator('.run-time-pill').isVisible(), true);
        const geometry = await agent.locator('.node-run-outline').evaluate(rect => {
            const node = rect.closest('.image-node').getBoundingClientRect();
            const shape = rect.getBoundingClientRect();
            const flow = rect.parentElement.querySelector('.node-run-flow');
            return {width:shape.width, nodeWidth:node.width, height:shape.height, nodeHeight:node.height,
                color:getComputedStyle(rect).stroke, duration:getComputedStyle(flow).animationDuration,
                pointerEvents:getComputedStyle(rect.parentElement).pointerEvents};
        });
        assert.ok(Math.abs(geometry.width - geometry.nodeWidth) < 5, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.height - geometry.nodeHeight) < 5, JSON.stringify(geometry));
        assert.equal(geometry.duration, '2.6s');
        assert.equal(geometry.pointerEvents, 'none');
        assert.equal(geometry.color, dark ? 'rgb(34, 211, 238)' : 'rgb(37, 99, 235)');
        await page.screenshot({path:path.join(artifacts, dark ? 'dark.png' : 'light.png')});
        await page.evaluate(() => {
            viewport.scale = .55;
            applyViewport();
        });
        assert.equal(await agent.locator('.node-run-outline').evaluate(el => getComputedStyle(el).vectorEffect), 'non-scaling-stroke');
        await page.screenshot({path:path.join(artifacts, dark ? 'dark-zoom.png' : 'light-zoom.png')});
        await page.evaluate(() => {
            viewport.scale = 1;
            applyViewport();
        });
    }
    await page.evaluate(() => {
        const node = nodes.find(node => node.id === 'image');
        node.pendingTasks[0].status = 'running';
        node.pendingTasks[0].progress = 47;
        refreshRunningNodeProgress();
    });
    assert.equal(await image.getAttribute('data-run-phase'), 'running');
    assert.equal(await image.locator('.node-run-status').isVisible(), false);
    assert.match(await image.locator('.generation-progress-ring').innerText(), /47%/);
    await page.evaluate(() => {
        delete nodes.find(node => node.id === 'image').pendingTasks[0].progress;
        refreshRunningNodeProgress();
    });
    assert.equal(await image.locator('.node-run-status').isVisible(), false);
    assert.match(await image.locator('.generation-progress-ring').innerText(), /\d+s/);
    assert.ok(await page.evaluate(() => window.feedbackContent === document.querySelector('[data-id="agent"] .agent-output-text')));
    await page.evaluate(() => {
        const agent = nodes.find(node => node.id === 'agent');
        agent.running = false;
        agent.runFinishedAt = Date.now();
        const next = nodes.find(node => node.id === 'parallel');
        next.runStartedAt = Date.now();
        render();
        window.feedbackContent = document.querySelector('[data-id="agent"] .agent-output-text');
    });
    assert.equal(await agent.getAttribute('data-run-phase'), 'succeeded');
    assert.match(await agent.locator('.run-time-pill').innerText(), /已完成/);
    assert.equal(await page.locator('.conn-run-transfer').count(), 1);
    await page.evaluate(() => {
        nodes.find(node => node.id === 'agent').runFinishedAt -= 5000;
        refreshRunTimerPills();
    });
    assert.equal(await agent.getAttribute('data-run-phase'), 'idle');
    assert.equal(await agent.locator('.node-run-border').isVisible(), false);
    assert.equal(await failed.getAttribute('data-run-phase'), 'failed');
    assert.ok(await page.evaluate(() => window.feedbackContent === document.querySelector('[data-id="agent"] .agent-output-text')));
    await page.evaluate(() => shell.classList.add('panning'));
    assert.equal(await image.locator('.node-run-flow').evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await image.locator('.node-run-flow').isVisible(), false);
    assert.equal(await image.locator('.node-run-outline').isVisible(), true);
    await page.evaluate(() => {
        const node = nodes.find(node => node.id === 'failed');
        node.running = true;
        node.runStartedAt = Date.now();
        delete node.runError;
        refreshRunTimerPills();
    });
    assert.equal(await failed.getAttribute('data-run-phase'), 'running');
    const promptFeedback = await page.evaluate(() => {
        const prompt = {id:'prompt', type:'smart-prompt', running:true, promptRunStartedAt:Date.now() - 12000};
        const running = smartNodeRunFeedback(prompt);
        prompt.running = false;
        prompt.promptRunFinishedAt = Date.now();
        prompt.promptRunError = '提示词请求失败';
        return {running, failed:smartNodeRunFeedback(prompt)};
    });
    assert.equal(promptFeedback.running.phase, 'running');
    assert.equal(promptFeedback.running.value, '12秒');
    assert.equal(promptFeedback.failed.phase, 'failed');
    assert.deepEqual(errors, []);
    console.log(`Preview images: ${artifacts}`);
});

test('Agent requests produce success and persistent failure feedback', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    await page.evaluate(() => {
        nodes = [{id:'agent', type:'smart-agent', x:120, y:120, w:460, h:600, userPrompt:'生成文案', images:[]}];
        viewport = {x:0, y:0, scale:1};
        applyViewport();
        render();
    });
    await page.route('**/api/canvas-llm', route => route.fulfill({json:{text:'这是生成的商品文案。'}}));
    await page.evaluate(() => runAgentNode('agent'));
    const agent = page.locator('.image-node[data-id="agent"]');
    assert.equal(await agent.getAttribute('data-run-phase'), 'succeeded');
    assert.equal(await agent.locator('.agent-output-text').inputValue(), '这是生成的商品文案。');
    await page.waitForFunction(() => document.querySelector('.image-node[data-id="agent"]').dataset.runPhase === 'idle', {timeout:7000});
    assert.equal(await page.evaluate(() => runTimerInterval), null);
    await page.route('**/api/canvas-llm', route => route.fulfill({status:500, json:{detail:'模型暂时不可用'}}));
    await page.evaluate(() => runAgentNode('agent'));
    assert.equal(await agent.getAttribute('data-run-phase'), 'failed');
    assert.match(await agent.locator('.run-time-pill').innerText(), /运行失败/);
    assert.equal(await agent.locator('.node-run-flow').isVisible(), false);
    await page.waitForTimeout(4500);
    assert.equal(await agent.getAttribute('data-run-phase'), 'failed');
    assert.deepEqual(errors, []);
});
