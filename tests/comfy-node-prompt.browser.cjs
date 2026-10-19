const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const localPrompt = '一对穿着针织衫的年轻情侣，正视图，柔和自然光。';
const negativePrompt = '水印、文字、模糊、过度磨皮';
const fields = [
    {id:'6:text', node:'6', input:'text', type:'textarea', name:'提示词', default:localPrompt},
    {id:'7:text', node:'7', input:'text', type:'textarea', name:'负向提示词', default:negativePrompt},
    {id:'8:steps', node:'8', input:'steps', type:'number', name:'步数', default:9, advanced:true}
];

async function openFixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1100}});
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], calls = [];
    let failLlm = false;
    let savedCanvas = {
        id:'prompt-fixture', title:'Prompt fixture', connections:[], logs:[], settings:{},
        viewport:{x:0, y:0, scale:1}, nodes:[
            {id:'prompt', type:'smart-prompt', x:100, y:100, w:430, h:500, text:'', llmEnabled:false},
            {id:'workflow', type:'smart-comfy-workflow', x:660, y:100, w:430, h:800, images:[],
                workflowRef:'custom/test.json', workflowTitle:'ComfyUI 提示词测试', workflowFields:fields,
                workflowStatus:'ready', workflowReadiness:{can_run:true},
                runSettings:{engine:'comfy', comfyMode:'custom', comfyWorkflow:'custom/test.json',
                    comfyParams:{'6:text':localPrompt, '7:text':negativePrompt, '8:steps':9}}}
        ]
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const pathname = decodeURIComponent(url.pathname);
        if(url.hostname !== 'comfy-prompt.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.join(root, pathname);
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(pathname.startsWith('/output/') || pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="776" height="1029"><rect width="776" height="1029" fill="#d6c3ab"/></svg>'});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[
            {id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image']}
        ], comfy_instances:[]}});
        if(pathname === '/api/canvases/prompt-fixture'){
            if(request.method() === 'PUT') savedCanvas = {...savedCanvas, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:savedCanvas}});
        }
        if(pathname === '/api/workflows') return route.fulfill({json:{workflows:[{name:'custom/test.json', fields}]}});
        if(pathname === '/api/workflows/custom/test.json') return route.fulfill({json:{config:{fields}}});
        if(pathname === '/api/canvas-llm'){
            calls.push('llm');
            return route.fulfill({status:failLlm ? 500 : 200, json:failLlm ? {detail:'模拟提示词处理失败'} : {text:'LLM 输出：深蓝色毛衣，海边人像摄影。'}});
        }
        if(pathname === '/api/canvas-comfy-tasks' && request.method() === 'POST'){
            calls.push('comfy');
            requests.push(request.postDataJSON());
            return route.fulfill({json:{task_id:`canvas_comfy_prompt_${requests.length}`, status:'queued'}});
        }
        if(pathname.startsWith('/api/canvas-comfy-tasks/')){
            return route.fulfill({json:{status:'succeeded', result:{images:[`/output/result-${requests.length}.png`]}}});
        }
        return route.fulfill({json:{items:[], entries:[], skills:[], categories:[], libraries:[], batches:[]}});
    });
    await page.goto('http://comfy-prompt.test/static/smart-canvas.html?id=prompt-fixture');
    await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'workflow'));
    await page.evaluate(() => {
        selectedId = 'workflow'; selectedIds = [];
        ensureGenerationNotificationPermission = () => {};
        render(); applyViewport();
    });
    return {page, errors, requests, calls, failLlm:() => {failLlm = true;}};
}

test('ComfyUI prompt height follows the handle at different zoom levels and survives saving', {timeout:30000}, async t => {
    const {page, errors} = await openFixture(t);
    const textarea = page.locator('[data-comfy-node-param="6:text"]');
    const height = () => textarea.evaluate(input => input.offsetHeight);
    async function drag(delta){
        const rect = await textarea.boundingBox();
        const scale = await page.evaluate(() => viewport.scale);
        const start = {x:rect.x + rect.width - 4 * scale, y:rect.y + rect.height - 4 * scale};
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x, start.y + delta * scale, {steps:12});
        await page.mouse.up();
    }
    for(const scale of [0.75, 1.25]){
        await page.evaluate(scale => { viewport = {x:0, y:0, scale}; applyViewport(); render(); }, scale);
        const before = await height();
        await drag(180);
        assert(Math.abs(await height() - before - 180) <= 2);
        assert(await height() > 150);
        const grown = await height();
        await page.evaluate(() => { document.activeElement?.blur(); render(); });
        assert.equal(await height(), grown);
        assert(await page.evaluate(() => saveCanvas()));
        await page.reload();
        await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'workflow'));
        assert.equal(await height(), grown);
        assert.deepEqual(await page.evaluate(() => {
            const node = nodes.find(node => node.id === 'workflow');
            return {x:node.x, y:node.y, prompt:node.runSettings.comfyParams['6:text']};
        }), {x:660, y:100, prompt:localPrompt});
        await drag(-1000);
        assert.equal(await height(), 96);
    }
    await page.evaluate(() => { viewport = {x:-160, y:0, scale:1}; applyViewport(); render(); });
    await textarea.fill((localPrompt + '\n').repeat(12));
    await drag(260);
    t.diagnostic(await textarea.evaluate(input => {
        const css = getComputedStyle(input);
        return `Prompt text: ${css.fontSize}, weight ${css.fontWeight}, line height ${css.lineHeight}; field height ${input.offsetHeight}px`;
    }));
    await page.screenshot({path:path.join(root, 'logs/comfy-node-prompt.png'), fullPage:true});
    assert.deepEqual(errors, []);
});

test('connected prompt output reaches the ComfyUI primary field and preserves negative prompts', {timeout:30000}, async t => {
    const {page, errors, requests, calls, failLlm} = await openFixture(t);
    const button = page.locator('[data-id="workflow"] [data-comfy-node-run]');
    async function run(){
        await button.click();
        await page.waitForFunction(() => !comfyNodeSubmissions.has('workflow') && !smartDependencyRuns.has('workflow'));
    }
    await page.evaluate(() => { connectInputNode('prompt', 'workflow'); render(); });
    await run();
    assert.equal(requests.at(-1).params['6'].text, localPrompt);

    const upstream = '深蓝色毛衣，海边人像摄影。';
    await page.locator('[data-id="prompt"] .prompt-node-text').fill(upstream);
    await run();
    assert.equal(requests.at(-1).params['6'].text, upstream);
    assert.equal(requests.at(-1).params['7'].text, negativePrompt);
    assert.equal(await page.locator('[data-comfy-node-param="6:text"]').inputValue(), localPrompt);
    assert.deepEqual(calls, ['comfy', 'comfy']);

    await page.locator('[data-id="prompt"] .prompt-node-text').fill('');
    await run();
    assert.equal(requests.at(-1).params['6'].text, localPrompt);

    await page.evaluate(() => {
        const node = nodes.find(node => node.id === 'prompt');
        Object.assign(node, {llmEnabled:true, llmProvider:'fixture', llmModel:'fixture-chat',
            llmInstruction:'将产品要求转换成摄影提示词', text:''});
        render();
    });
    await run();
    assert.deepEqual(calls.slice(-2), ['llm', 'comfy']);
    assert.equal(requests.at(-1).params['6'].text, 'LLM 输出：深蓝色毛衣，海边人像摄影。');
    assert.equal(requests.at(-1).params['7'].text, negativePrompt);
    failLlm();
    await page.evaluate(() => {
        const node = nodes.find(node => node.id === 'prompt');
        node.llmInstruction = '重新整理摄影要求';
        node.text = '';
        render();
    });
    const beforeFailure = requests.length;
    await run();
    assert.equal(requests.length, beforeFailure);
    assert.equal(calls.at(-1), 'llm');
    assert.deepEqual(errors, []);
});
