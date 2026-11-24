const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const template = {
    id:'view-rule', name:'视觉规范', category:'view',
    positive:'保持商品形状与文字准确', negative:'不要改变包装', params:{ratio:'1:1'}
};

async function openPromptCanvas(t, {catalog, routeLibrary, init, empty = false} = {}) {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:950}});
    page.setDefaultTimeout(7000);
    const errors = [], calls = [];
    if(init) await page.addInitScript(init);
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'prompt-template.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, chat_models:['fixture-chat'], image_models:[]
        }], comfy_instances:[]}});
        if(url.pathname.startsWith('/api/prompt-libraries')){
            const reply = await routeLibrary?.(url.pathname, request);
            if(reply) return route.fulfill(reply);
            if(url.pathname === '/api/prompt-libraries') return route.fulfill({json:{library:{libraries:catalog || [{
                id:'system', name:'系统提示词库', readonly:false,
                categories:[{id:'view', name:'视频规范'}], items:[template]
            }]}}});
        }
        if(url.pathname === '/api/canvas-llm'){
            calls.push(request.postDataJSON());
            return route.fulfill({json:{text:'生成后的输出'}});
        }
        if(url.pathname === '/api/canvases/fixture'){
            if(request.method() === 'GET') return route.fulfill({json:{canvas:{
                id:'fixture', title:'模板验证', nodes:empty ? [] : [{
                    id:'prompt', type:'smart-prompt', x:100, y:100, w:316, h:240,
                    text:'已有输出', llmEnabled:false, llmSystemEnabled:false,
                    llmInstruction:'生成主图提示词', promptInstructionInitialized:true,
                    llmProvider:'fixture', llmModel:'fixture-chat'
                }], connections:[], logs:[], settings:{}
            }}});
            return route.fulfill({json:{canvas:{id:'fixture', updated_at:Date.now()}}});
        }
        return route.fulfill({json:{items:[], libraries:[], skills:[], workflows:[]}});
    });

    await page.goto('http://prompt-template.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture' && smartConfigReady);
    return {page, calls, errors, panel:page.locator('#promptTemplatePanel')};
}

test('the canvas toolbar opens a searchable prompt library on an empty canvas', {timeout:40000}, async t => {
    const custom = {id:'brand', name:'品牌模板', positive:'保留商标', negative:'不要加水印'};
    const {page, panel, errors} = await openPromptCanvas(t, {
        empty:true,
        catalog:[
            {id:'system', name:'系统提示词库', readonly:true, items:[template]},
            {id:'custom', name:'自建库', items:[custom]},
        ],
        init:() => {
            const execCommand = document.execCommand.bind(document);
            document.execCommand = (command, ...args) => {
                if(command !== 'copy') return execCommand(command, ...args);
                if(window.failCopy) return false;
                const clipboardData = new DataTransfer();
                document.dispatchEvent(new ClipboardEvent('copy', {clipboardData}));
                window.copiedPrompt = clipboardData.getData('text/plain');
                return true;
            };
        },
    });
    const toggle = page.locator('#smartPromptToggle');
    const search = panel.locator('#promptTemplateSearch');
    const workflow = page.locator('#smartWorkflowToggle');
    const back = page.locator('.smart-back');
    for(const width of [1500, 900, 390]){
        await page.setViewportSize({width, height:950});
        const [promptBox, workflowBox, backBox] = await Promise.all([toggle.boundingBox(), workflow.boundingBox(), back.boundingBox()]);
        assert.ok(promptBox.x + promptBox.width <= workflowBox.x, `toolbar fits at ${width}px`);
        assert.ok(backBox.x + backBox.width <= promptBox.x, `back button fits at ${width}px`);
        assert.equal(promptBox.y, workflowBox.y);
    }
    await toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    await search.fill('商品形状');
    await panel.locator('[data-template-id="view-rule"]').waitFor();
    await panel.locator('[data-template-copy="positive"]').click();
    assert.equal(await page.evaluate(() => window.copiedPrompt), template.positive);
    await page.locator('#toast').getByText('已复制', {exact:true}).waitFor();

    await search.fill('无匹配结果');
    assert.equal(await panel.locator('[data-template-copy]').count(), 0);
    await search.fill('');
    await panel.locator('#promptTemplateLibrarySelect').selectOption('custom');
    await panel.locator('[data-template-id="brand"]').waitFor();
    await panel.locator('[data-template-copy="full"]').click();
    assert.equal(await page.evaluate(() => window.copiedPrompt), custom.positive + '\n\nNegative prompt:\n' + custom.negative);

    await page.evaluate(() => { window.failCopy = true; });
    await panel.locator('[data-template-copy="full"]').click();
    await page.locator('#toast').getByText('复制失败，可选中提示词手动复制', {exact:true}).waitFor();
    assert.equal(await panel.getAttribute('data-target'), 'library');
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
    await toggle.click();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => nodes.length), 0);
    assert.deepEqual(errors, []);
});

test('prompt node template applies to system prompt and reaches the LLM request', {timeout:40000}, async t => {
    const {page, calls, errors} = await openPromptCanvas(t);
    const node = page.locator('[data-id="prompt"]');
    await node.locator('.prompt-preset-edit').click();
    await page.locator('[data-template-apply="positive"]').click();
    assert.equal(await node.locator('.prompt-llm-system').inputValue(), template.positive);
    assert.equal(await node.locator('.prompt-node-text').inputValue(), '已有输出');
    assert.equal(await page.evaluate(() => nodes.find(item => item.id === 'prompt').llmEnabled), true);

    await node.locator('.prompt-preset-edit').click();
    await page.locator('[data-template-apply="full"]').click();
    const full = await node.locator('.prompt-llm-system').inputValue();
    assert.match(full, /保持商品形状与文字准确/);
    assert.match(full, /Negative prompt:\n不要改变包装/);
    assert.match(full, /Params:\nratio: 1:1/);
    assert.equal(await node.locator('.prompt-node-text').inputValue(), '已有输出');

    await node.locator('.prompt-node-run').click();
    await page.waitForFunction(() => nodes.find(item => item.id === 'prompt').text === '生成后的输出');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system_prompt, full);
    assert.equal(calls[0].message, '生成主图提示词');
    await page.evaluate(() => {
        nodes.push({id:'agent', type:'smart-agent', x:520, y:100, w:430, h:540, systemPrompt:'原 Agent 提示词', images:[]});
        render();
    });
    const agent = page.locator('[data-id="agent"]');
    await agent.locator('.agent-prompt-assistant').click();
    await page.locator('[data-template-apply="positive"]').click();
    assert.equal(await agent.locator('.agent-system-prompt').inputValue(), template.positive);
    assert.equal(await page.evaluate(() => nodes.find(item => item.id === 'agent').agentPromptTemplateId), template.id);
    assert.deepEqual(errors, []);
});


test('smart template libraries retain failed drafts and send changes to the selected library', {timeout:40000}, async t => {
    const duplicate = {...template, positive:'逐项核对\n商品包装和字体。', scene:'逐项核对   商品包装', name:'系统规范'};
    const custom = {id:'custom-template', name:'品牌规范', category:'brand', positive:'保持品牌识别', scene:'适用于品牌物料', negative:'禁止更换商标'};
    const catalog = [
        {id:'system', name:'系统提示词库', readonly:false, categories:[{id:'view', name:'视频规范'}], items:[duplicate]},
        {id:'team', name:'团队模板', readonly:false, categories:[{id:'brand', name:'品牌'}], items:[custom]}
    ];
    const updates = [];
    const {page, panel, errors} = await openPromptCanvas(t, {
        catalog,
        routeLibrary(path, request){
            if(request.method() === 'PATCH' && path === '/api/prompt-libraries/items/custom-template'){
                const data = request.postDataJSON();
                updates.push(data);
                if(updates.length === 1) return {status:422, json:{detail:'Fixture save failure'}};
                Object.assign(custom, data);
                return {json:{library:{libraries:catalog}, item:custom}};
            }
            if(request.method() === 'POST' && path === '/api/prompt-libraries/items'){
                const data = request.postDataJSON();
                assert.equal(data.library_id, 'team');
                const item = {...data, id:'created'};
                catalog[1].items.unshift(item);
                return {json:{library:{libraries:catalog}, item}};
            }
            if(request.method() === 'DELETE' && path === '/api/prompt-libraries/items/created'){
                catalog[1].items = catalog[1].items.filter(item => item.id !== 'created');
                return {json:{library:{libraries:catalog}}};
            }
            if(request.method() === 'POST' && path === '/api/prompt-libraries/categories'){
                const data = request.postDataJSON();
                assert.deepEqual(data, {library_id:'team', name:'设计规范'});
                const category = {id:'design', name:data.name};
                catalog[1].categories.push(category);
                return {json:{library:{libraries:catalog}, category}};
            }
            if(path === '/api/prompt-libraries/categories/design'){
                if(request.method() === 'PATCH'){
                    const data = request.postDataJSON();
                    assert.deepEqual(data, {library_id:'team', name:'版式规范'});
                    catalog[1].categories.find(group => group.id === 'design').name = data.name;
                } else if(request.method() === 'DELETE'){
                    catalog[1].categories = catalog[1].categories.filter(group => group.id !== 'design');
                }
                return {json:{library:{libraries:catalog}}};
            }
        },
    });
    await page.evaluate(() => {
        const node = createPaintNodeAt({x:720, y:250});
        selectedId = node.id;
        render();
        updateComposer();
    });
    await page.locator('#composerTemplateBtn').click();
    const summary = panel.locator('[data-template-id="view-rule"] .prompt-template-scene');
    assert.equal(await summary.textContent(), duplicate.positive);
    await panel.locator('[data-template-cat="view"]').click();
    await panel.locator('#promptTemplateLibrarySelect').selectOption('team');
    assert.equal(await panel.locator('[data-template-cat="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await panel.locator('.prompt-template-scene').textContent(), custom.scene);

    await panel.locator('[data-template-edit]').click();
    await panel.locator('[data-template-edit-name]').fill('团队品牌规范');
    await panel.locator('[data-template-edit-text]').fill('调整字体，保留商品包装');
    await panel.locator('[data-template-edit-save]').click();
    await page.waitForFunction(() => document.getElementById('promptTemplatePanel').getAttribute('aria-busy') === 'false');
    assert.equal(await panel.locator('[data-template-edit-text]').inputValue(), '调整字体，保留商品包装');
    await panel.locator('[data-template-edit-save]').click();
    await panel.locator('[data-template-edit]').waitFor();
    assert.deepEqual(updates, Array(2).fill({
        name:'团队品牌规范', category:'brand', positive:'调整字体，保留商品包装',
        library_id:'team', scene:'适用于品牌物料', negative:'禁止更换商标'
    }));

    await panel.locator('#promptTemplateSearch').fill('no matching template');
    assert.equal(await panel.locator('[data-template-apply]').count(), 0);
    await panel.locator('[data-template-new]').click();
    await panel.locator('[data-template-edit-name]').waitFor();
    assert.equal(await panel.locator('[data-template-id="created"]').getAttribute('aria-pressed'), 'true');
    await panel.locator('[data-template-delete]').click();
    await panel.locator('[data-template-id="created"]').waitFor({state:'detached'});
    await panel.locator('[data-template-id="custom-template"]').waitFor();
    await panel.locator('[data-template-group-edit]').click();
    page.once('dialog', dialog => dialog.accept('设计规范'));
    await panel.locator('[data-template-cat-new]').click();
    const group = panel.locator('[data-template-cat="design"]');
    await group.waitFor();
    page.once('dialog', dialog => dialog.accept('版式规范'));
    await panel.locator('[data-template-cat-edit="design"]').click();
    await group.getByText('版式规范', {exact:true}).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await panel.locator('[data-template-cat-delete="design"]').click();
    await group.waitFor({state:'detached'});
    await panel.locator('[data-template-group-edit]').click();
    await panel.locator('[data-template-apply="positive"]').click();
    assert.equal(await page.locator('#promptInput').innerText(), custom.positive);
    assert.equal(await panel.evaluate(item => item.classList.contains('open')), false);
    assert.deepEqual(errors, []);
});

test('smart template switching ignores a late catalog and keeps legacy presets usable', {timeout:40000}, async t => {
    const system = {id:'system', name:'系统提示词库', readonly:true, categories:[{id:'view', name:'视角'}], items:[template]};
    const custom = {id:'team', name:'团队模板', readonly:true, items:[{id:'recent', name:'最新目录', positive:'最新提示词'}]};
    let holdNext = false;
    let releaseOld;
    let oldStarted;
    const oldRequested = new Promise(resolve => { oldStarted = resolve; });
    const {page, panel, errors} = await openPromptCanvas(t, {
        catalog:[system, custom],
        init:() => {
            localStorage.setItem('smart_canvas_prompt_presets_v1', JSON.stringify([
                {id:'saved-preset', name:'我的旧预设', text:'此前保存的内容', category:'mine', custom:'保留'}
            ]));
        },
        async routeLibrary(path){
            if(path !== '/api/prompt-libraries' || !holdNext) return;
            holdNext = false;
            await new Promise(resolve => { releaseOld = resolve; oldStarted(); });
            return {json:{library:{libraries:[system]}}};
        },
    });
    await page.locator('[data-id="prompt"] .prompt-preset-edit').click();
    await panel.locator('[data-template-id="view-rule"]').waitFor();
    await panel.locator('#promptTemplateClose').click();

    holdNext = true;
    await page.locator('[data-id="prompt"] .prompt-preset-edit').click();
    await oldRequested;
    const libraries = panel.locator('#promptTemplateLibrarySelect');
    const newer = page.waitForResponse(response => response.url().endsWith('/api/prompt-libraries'));
    await libraries.selectOption('team');
    await newer;
    await panel.locator('[data-template-id="recent"]').waitFor();
    const late = page.waitForResponse(response => response.url().endsWith('/api/prompt-libraries'));
    releaseOld();
    await (await late).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await libraries.inputValue(), 'team');
    assert.equal(await panel.locator('[data-template-id="recent"]').count(), 1);

    await libraries.selectOption('system');
    await panel.locator('[data-template-cat="custom"]').click();
    await panel.locator('[data-template-id="mine:saved-preset"]').click();
    await panel.locator('[data-template-edit]').click();
    await panel.locator('[data-template-edit-text]').fill('修改后的旧预设');
    await panel.locator('[data-template-edit-save]').click();
    await panel.locator('[data-template-apply="positive"]').click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('smart_canvas_prompt_presets_v1'))[0]);
    assert.equal(saved.text, '修改后的旧预设');
    assert.equal(saved.custom, '保留');
    assert.equal(await page.locator('[data-id="prompt"] .prompt-llm-system').inputValue(), saved.text);
    assert.deepEqual(errors, []);
});
