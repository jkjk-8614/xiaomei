const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const savedNode = {
    id:'saved-prompt', type:'smart-prompt', x:100, y:100, w:316, h:360,
    llmEnabled:true, llmProvider:'antigravity', llmModel:'gemini-3.8-flash-high',
    llmInstruction:'写一段提示词', text:'已有输出'
};
const savedAgent = {
    id:'saved-agent', type:'smart-agent', x:480, y:100, w:430, h:640,
    agentProvider:'gemini-cli', agentModel:'gemini-3.8-flash-high',
    userPrompt:'写一段提示词', outputText:'已有输出'
};

test('text nodes keep saved models while providers load and when a provider disappears', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400, height:900}});
    const errors = [], saves = [], llmCalls = [];
    let releaseConfig;
    const configGate = new Promise(resolve => { releaseConfig = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'prompt-selection.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config'){
            await configGate;
            return route.fulfill({json:{api_providers:[
                {id:'comfly', name:'comfly', enabled:true, chat_models:['claude-fable-5'], image_models:[]},
                {id:'antigravity', name:'Antigravity CLI', enabled:true, chat_models:['gemini-3.8-flash-high'], image_models:[]},
                {id:'gemini-cli', name:'Antigravity CLI', enabled:true, chat_models:['gemini-3.8-flash-high'], image_models:[]}
            ], comfy_instances:[]}});
        }
        if(url.pathname === '/api/canvases/fixture'){
            if(request.method() === 'GET') return route.fulfill({json:{canvas:{id:'fixture', title:'测试', nodes:[savedNode, savedAgent], connections:[], logs:[], settings:{}}}});
            saves.push(request.postDataJSON());
            return route.fulfill({json:{canvas:{id:'fixture', updated_at:Date.now(), nodes:saves.at(-1).nodes || [savedNode, savedAgent], connections:[]}}});
        }
        if(url.pathname === '/api/canvas-llm'){
            llmCalls.push(request.postDataJSON());
            return route.fulfill({json:{text:'模型输出'}});
        }
        return route.fulfill({json:{workflows:[], entries:[], items:[]}});
    });
    await page.goto('http://prompt-selection.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    assert.deepEqual(await page.locator('[data-id="saved-prompt"] select.prompt-llm-provider').inputValue(), 'antigravity');
    assert.deepEqual(await page.locator('[data-id="saved-prompt"] select.prompt-llm-model').inputValue(), 'gemini-3.8-flash-high');
    assert.match(await page.locator('[data-id="saved-agent"] [data-agent-select="provider"] .agent-select-trigger').innerText(), /Antigravity|gemini-cli/);
    assert.match(await page.locator('[data-id="saved-agent"] [data-agent-select="model"] .agent-select-trigger').innerText(), /gemini-3.8-flash-high/);
    await page.evaluate(() => scheduleSave());
    await page.waitForTimeout(900);
    assert.ok(saves.length > 0);
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-prompt').llmProvider, 'antigravity');
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-prompt').llmModel, 'gemini-3.8-flash-high');
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-agent').agentProvider, 'gemini-cli');
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-agent').agentModel, 'gemini-3.8-flash-high');

    releaseConfig();
    await page.waitForFunction(() => smartConfigReady);
    assert.equal(await page.locator('[data-id="saved-prompt"] select.prompt-llm-provider').inputValue(), 'antigravity');
    assert.equal(await page.locator('[data-id="saved-prompt"] select.prompt-llm-model').inputValue(), 'gemini-3.8-flash-high');
    await page.evaluate(() => {
        apiProviders = apiProviders.filter(provider => !['antigravity', 'gemini-cli'].includes(provider.id));
        render();
    });
    assert.equal(await page.locator('[data-id="saved-prompt"] select.prompt-llm-provider').inputValue(), 'antigravity');
    assert.equal(await page.locator('[data-id="saved-prompt"] select.prompt-llm-model').inputValue(), 'gemini-3.8-flash-high');
    assert.equal(await page.locator('[data-id="saved-agent"] [data-agent-select="provider"] .agent-select-trigger').innerText(), 'gemini-cli');
    assert.equal(await page.locator('[data-id="saved-agent"] [data-agent-select="model"] .agent-select-trigger').innerText(), 'gemini-3.8-flash-high');
    await page.evaluate(() => scheduleSave());
    await page.waitForTimeout(900);
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-agent').agentProvider, 'gemini-cli');
    assert.equal(saves.at(-1).nodes.find(node => node.id === 'saved-agent').agentModel, 'gemini-3.8-flash-high');
    const result = await page.evaluate(() => runPromptLLMNodeDirect('saved-prompt'));
    assert.equal(result.ok, false);
    const agentResult = await page.evaluate(() => runAgentNodeDirect('saved-agent'));
    assert.equal(agentResult.ok, false);
    assert.equal(llmCalls.length, 0);
    await page.evaluate(() => {
        apiProviders.push({id:'antigravity', name:'Antigravity CLI', enabled:true, chat_models:['gemini-3.8-flash-high'], image_models:[]});
        apiProviders.push({id:'gemini-cli', name:'Antigravity CLI', enabled:true, chat_models:['gemini-3.8-flash-high'], image_models:[]});
        render();
    });
    const restored = await page.evaluate(() => runPromptLLMNodeDirect('saved-prompt'));
    assert.equal(restored.ok, true);
    assert.equal(llmCalls[0].provider, 'antigravity');
    assert.equal(llmCalls[0].model, 'gemini-3.8-flash-high');
    const restoredAgent = await page.evaluate(() => runAgentNodeDirect('saved-agent'));
    assert.equal(restoredAgent.ok, true);
    assert.equal(llmCalls[1].provider, 'gemini-cli');
    assert.equal(llmCalls[1].model, 'gemini-3.8-flash-high');
    assert.deepEqual(errors, []);
});
