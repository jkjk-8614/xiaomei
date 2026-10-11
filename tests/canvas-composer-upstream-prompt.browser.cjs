const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('connected composer preserves local drafts and submits upstream text once', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1100}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    let savedCanvas = {
        id:'upstream-fixture', title:'Upstream prompt fixture', nodes:[], connections:[], logs:[],
        settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}
    };
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'upstream-prompt.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{
            api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', image_models:['fixture-image'], chat_models:[]}],
            comfy_instances:[]
        }});
        if(url.pathname === '/api/canvases/upstream-fixture') return route.fulfill({json:{canvas:savedCanvas}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://upstream-prompt.test/static/smart-canvas.html?id=upstream-fixture');
    await page.waitForFunction(() => smartConfigReady && canvas);
    await page.evaluate(() => {
        window.testAgent = {id:'upstream-agent', type:'smart-agent', x:100, y:100, outputText:'使用蓝色地毯，保留室内构图。'};
        nodes.push(window.testAgent);
        window.testPaint = createPaintNodeAt({x:650, y:100});
        connectInputNode(testAgent.id, testPaint.id);
        render();
        updateComposer();
    });

    const state = () => page.evaluate(() => ({
        draft:promptPlainText(),
        preview:document.querySelector('.input-prompt-preview-text')?.textContent || '',
        prompt:buildPromptRequest(testPaint, []).prompt,
        nodePrompt:buildPromptRequestForNode(testPaint, []).prompt
    }));
    const upstream = '使用蓝色地毯，保留室内构图。';
    assert.deepEqual(await state(), {draft:'', preview:upstream, prompt:upstream, nodePrompt:upstream});

    await page.evaluate(() => {
        const request = buildPromptRequest(testPaint, []);
        attachRunMeta(testPaint, snapshotRunMeta(request.prompt, testPaint.id, request.displayPrompt, []));
        selectedId = testAgent.id;
        updateComposer();
        selectedId = testPaint.id;
        updateComposer();
    });
    assert.deepEqual(await state(), {draft:'', preview:upstream, prompt:upstream, nodePrompt:upstream});

    const local = '增加自然光。';
    await page.locator('#promptInput').fill(local);
    await page.evaluate(() => {
        savePromptDraftForCurrent();
        const request = buildPromptRequest(testPaint, []);
        attachRunMeta(testPaint, snapshotRunMeta(request.prompt, testPaint.id, request.displayPrompt, []));
        selectedId = testAgent.id;
        updateComposer();
        testAgent.outputText = '使用绿色地毯，保留室内构图。';
        selectedId = testPaint.id;
        updateComposer();
    });
    const updatedUpstream = '使用绿色地毯，保留室内构图。';
    assert.deepEqual(await state(), {draft:local, preview:updatedUpstream, prompt:`${local}\n\n${updatedUpstream}`, nodePrompt:`${local}\n\n${updatedUpstream}`});

    await page.locator('#promptInput').fill('');
    savedCanvas = await page.evaluate(() => {
        savePromptDraftForCurrent();
        return JSON.parse(JSON.stringify({...canvas, nodes}));
    });
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && canvas);
    await page.evaluate(() => {
        window.testAgent = nodes.find(node => node.id === 'upstream-agent');
        window.testPaint = nodes.find(node => node.type === SMART_PAINT_NODE_TYPE);
        selectedId = testPaint.id;
        selectedIds = [];
        render();
        updateComposer();
    });
    assert.deepEqual(await state(), {draft:'', preview:updatedUpstream, prompt:updatedUpstream, nodePrompt:updatedUpstream});

    await page.evaluate(() => {
        const ref = {url:'/assets/detail.png', name:'细节图'};
        testPaint.runPrompt = '旧提示词';
        testPaint.runPromptRefs = [ref];
        testPaint.promptDraftText = '参考@细节图，增加自然光。';
        testPaint.promptDraftHtml = `参考${mentionTokenHtml(ref)}，增加自然光。`;
        loadPromptDraft(testPaint);
    });
    assert.equal(await page.locator('#promptInput .mention-image-token').count(), 1);
    assert.equal(await page.evaluate(() => promptPlainText()), '参考@细节图，增加自然光。');
    const mentioned = await page.evaluate(() => {
        const request = buildPromptRequest(testPaint, []);
        attachRunMeta(testPaint, snapshotRunMeta(request.prompt, testPaint.id, request.displayPrompt, request.refs));
        loadNodePromptDraftToInput(testPaint);
        return {draft:promptPlainText(), refs:buildPromptRequest(testPaint, []).refs.map(ref => ref.url)};
    });
    assert.deepEqual(mentioned, {draft:'参考@细节图，增加自然光。', refs:['/assets/detail.png']});

    await page.evaluate(() => {
        delete testPaint.promptDraftHtml;
        delete testPaint.promptDraftText;
        testPaint.runPrompt = testAgent.outputText;
        testPaint.runPromptRefs = [];
        loadPromptDraft(testPaint);
    });
    assert.equal(await page.evaluate(() => promptPlainText()), '');
    assert.equal(await page.evaluate(() => buildPromptRequestForNode(testPaint, []).prompt), updatedUpstream);
    assert.equal(await page.evaluate(() => {
        loadPromptDraft({id:'legacy-output', type:SMART_PAINT_NODE_TYPE, runPrompt:'独立图片的原提示词'});
        return promptPlainText();
    }), '独立图片的原提示词');
    assert.deepEqual(errors, []);
});
