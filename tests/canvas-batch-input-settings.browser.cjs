const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('batch text inlet, live text and settings groups survive toggles and reload', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1500}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'batch-input', nodes:[], connections:[], settings:{}, logs:[]};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if(url.hostname !== 'batch-input.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.join(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/batch-input'){
            if(req.method() === 'PUT') saved = {...saved, ...req.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'测试平台', enabled:true, image_models:['image-fixture'], chat_models:['text-fixture']
        }], comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://batch-input.test/static/smart-canvas.html?id=batch-input');
    await page.waitForFunction(() => smartConfigReady && lastConfigRefreshAt > 0 && canvas?.id === 'batch-input');
    await page.addStyleTag({content:'#canvasNavPanel {display:none !important}'});
    await page.evaluate(() => {
        nodes = [
            {id:'empty', type:'smart-prompt', x:-900, y:0, text:''},
            {id:'prompt', type:'smart-prompt', x:-900, y:400, text:'保持相框结构，使用暖光', title:'相框提示词'},
            {id:'agent', type:'smart-agent', x:-900, y:850, outputText:'突出相框的材质细节', title:'分析结果'}
        ];
        const loop = createLoopNode(0,0,{batchUiMode:'paired'});
        loop.id = 'batch'; loop.batchSourceNodeId = 'removed-node'; loop.batchSourceText = '保留的本地草稿';
        loop.batchAiProvider = 'fixture'; loop.batchAiModel = 'text-fixture'; loop.batchVisualGuide = '暖色、自然光';
        canvas.connections = [{from:'empty', to:'batch', kind:'input'}, {from:'prompt', to:'batch', kind:'flow'}];
        canvasUsesConnections = true; selectedId = 'batch'; viewport = {x:550,y:45,scale:.85}; applyViewport(); render();
    });
    const batch = page.locator('[data-id="batch"]');
    const source = batch.locator('[data-loop-detail-text]');
    assert.equal(await source.inputValue(), '保持相框结构，使用暖光', 'automatic source skips empty and missing nodes');
    assert.equal(await source.getAttribute('readonly'), '');
    assert.equal(await batch.locator('[data-loop-commerce="requirements"]').count(), 0);
    const copy = batch.locator('.batch-sec').filter({has:page.locator('.batch-sec-title', {hasText:'文案'})});
    for(const selector of ['[data-loop-ai-provider]', '[data-loop-ai-model]', '[data-loop-detail-guide]']){
        assert.equal(await copy.locator(selector).count(), 1, `${selector} belongs to the copy section`);
        assert.equal(await copy.locator(selector).isVisible(), true);
    }
    const picture = batch.locator('.batch-sec').filter({has:page.locator('.batch-sec-title', {hasText:'画面'})});
    for(const selector of ['[data-loop-commerce="model"]', '[data-loop-commerce="richness"]', '[data-loop-commerce="rhythm"]']){
        assert.equal(await picture.locator(selector).count(), 1, `${selector} belongs to the picture section`);
        assert.equal(await picture.locator(selector).isVisible(), true);
    }
    const advanced = batch.locator('.batch-advanced');
    const summary = advanced.locator(':scope > summary');
    assert.equal(await advanced.evaluate(el => el.open), false);
    const collapsedHeight = await batch.evaluate(el => el.offsetHeight);
    await summary.click();
    await page.waitForFunction(() => document.querySelector('.batch-advanced')?.open && nodes.find(n => n.id === 'batch').batchAdvancedOpen);
    await page.waitForFunction(height => document.querySelector('[data-id="batch"]').offsetHeight > height, collapsedHeight);
    await batch.locator('.batch-manual > summary').click();
    await page.waitForFunction(() => document.querySelector('.batch-manual')?.open && nodes.find(n => n.id === 'batch')?.batchManualSplitOpen);
    await page.evaluate(() => { nodes.find(n => n.id === 'batch').batchSplitSeparator = '---'; render(); });
    await summary.click();
    await page.waitForFunction(() => !document.querySelector('.batch-advanced')?.open && !nodes.find(n => n.id === 'batch').batchAdvancedOpen);
    assert.equal(await batch.locator('[data-loop-prompt-separator]').isVisible(), false);
    assert.equal(await page.evaluate(() => dragState), null, 'summary interaction does not start a node drag');
    await page.evaluate(() => render());
    assert.equal(await advanced.evaluate(el => el.open), false);
    await summary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.batch-advanced')?.open);
    assert.equal(await batch.locator('[data-loop-prompt-separator]').inputValue(), '---');

    const assertTextAnchor = async from => {
        await page.waitForFunction(fromId => {
            const el = world.querySelector('[data-id="batch"]');
            const field = el.querySelector('[data-loop-detail-text]').getBoundingClientRect();
            const port = el.querySelector('[data-input-slot="text"]').getBoundingClientRect();
            const line = world.querySelector(`.conn-group[data-conn-from="${fromId}"][data-conn-to="batch"] .conn-line`);
            if(!line) return false;
            const end = line.getPointAtLength(line.getTotalLength());
            const expected = createClientToWorldMapper()(el.getBoundingClientRect().left, field.top + field.height / 2);
            return Math.abs(port.top + port.height / 2 - field.top - field.height / 2) < 1 && Math.hypot(end.x - expected.x, end.y - expected.y) < 1;
        }, from);
    };
    await assertTextAnchor('prompt');
    await page.evaluate(() => {
        const input = world.querySelector('[data-id="batch"] [data-loop-detail-text]');
        input.style.height = '240px';
    });
    await assertTextAnchor('prompt');
    await page.evaluate(() => { viewport = {x:650,y:45,scale:.65}; applyViewport(); render(); });
    await assertTextAnchor('prompt');
    await batch.locator('[data-loop-detail-source]').selectOption('local');
    assert.equal(await source.inputValue(), '保留的本地草稿');
    await source.fill('新的本地草稿');
    const outputPort = page.locator('[data-id="agent"] .node-port.port-out');
    const inputPort = batch.locator('[data-input-slot="text"]');
    const fromBox = await outputPort.boundingBox(), toBox = await inputPort.boundingBox();
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.waitForFunction(() => getComputedStyle(world.querySelector('[data-id="agent"] .port-out')).pointerEvents !== 'none');
    await page.mouse.down();
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForFunction(() => nodes.find(n => n.id === 'batch').batchSourceNodeId === 'agent');
    assert.equal(await source.inputValue(), '突出相框的材质细节', 'connecting text selects it and preserves local draft');
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'batch').batchSourceText), '新的本地草稿');
    assert.equal(await batch.locator('[data-loop-detail-source]').inputValue(), 'agent');
    await assertTextAnchor('agent');
    await page.locator('[data-id="agent"] .agent-output-text').fill('更新后的材质提示词');
    assert.equal(await source.inputValue(), '更新后的材质提示词', 'agent output edits update the connected field immediately');
    await batch.locator('[data-loop-detail-source]').selectOption('prompt');
    await page.locator('[data-id="prompt"] .prompt-node-text').fill('更新后的相框提示词');
    assert.equal(await source.inputValue(), '更新后的相框提示词', 'prompt edits update the connected field immediately');

    await page.evaluate(async () => {
        const loop = nodes.find(n => n.id === 'batch');
        nodes.push({id:'image', type:'smart-upload', x:-900,y:1300, images:[]});
        window.rejectedImageText = connectInputNode('image','batch','text');
        window.acceptedImage = connectInputNode('image','batch');
        loop.batchCommerce = {...smartLoopCommerceFields(loop), richness:'丰富'};
        render(); await saveCanvas();
    });
    assert.deepEqual(await page.evaluate(() => [rejectedImageText,acceptedImage]), [false,true]);
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.find(n => n.id === 'batch')?.batchSourceNodeId === 'prompt');
    await page.addStyleTag({content:'#canvasNavPanel {display:none !important}'});
    assert.equal(await source.inputValue(), '更新后的相框提示词');
    assert.equal(await advanced.evaluate(el => el.open), true);
    assert.equal(await batch.locator('[data-loop-commerce="richness"]').inputValue(), '丰富');
    await assertTextAnchor('prompt');
    await page.evaluate(() => {
        nodes.push({id:'group-text', type:'smart-prompt', text:'分组中的提示词', x:-1500,y:0});
        nodes.push({id:'text-group', type:'smart-group', items:['group-text'], x:-1500,y:0});
        if(!connectInputNode('text-group','batch','text')) throw new Error('group text connection failed');
        render();
    });
    assert.equal(await source.inputValue(), '分组中的提示词');
    await batch.locator('[data-loop-detail-source]').selectOption('prompt');
    await summary.click();
    await page.waitForFunction(() => !document.querySelector('.batch-advanced')?.open);
    await page.evaluate(() => { selectedId='batch'; viewport={x:550,y:45,scale:.85}; applyViewport(); render(); });
    const shot = path.join(os.tmpdir(), 'xiaomei-batch-input-settings.png');
    await page.screenshot({path:shot});
    t.diagnostic(`Screenshot: ${shot}`);
});
