const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('prompt optimization waits for confirmation and keeps replacement recoverable', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:1000}});
    const errors = [];
    const calls = [];
    let failNext = false;
    let savedCanvas = {
        id:'fixture', title:'优化提示词验证', nodes:[], connections:[], logs:[],
        settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'prompt-optimize.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{
            api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', image_models:['fixture-image'], chat_models:['fixture-chat']}],
            comfy_instances:[]
        }});
        if(url.pathname === '/api/canvases/fixture'){
            if(request.method() === 'GET') return route.fulfill({json:{canvas:savedCanvas}});
            savedCanvas = {...savedCanvas, ...request.postDataJSON(), id:'fixture', updated_at:Date.now()};
            return route.fulfill({json:{canvas:savedCanvas}});
        }
        if(url.pathname === '/api/canvas-llm'){
            calls.push(request.postDataJSON());
            if(failNext){ failNext = false; return route.fulfill({status:500, json:{detail:'模拟优化失败'}}); }
            return route.fulfill({json:{text:JSON.stringify({prompt:'优化后的提示词', changes:'整理表达', questions:'无'}), model:'fixture-chat'}});
        }
        return route.fulfill({json:{items:[], libraries:[], skills:[], workflows:[]}});
    });

    await page.goto('http://prompt-optimize.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture' && smartConfigReady);
    await page.evaluate(() => {
        window.testPaint = createPaintNodeAt({x:400, y:100});
        testPaint.runPrompt = '上次生成的旧提示词';
        render();
        updateComposer();
    });
    await page.locator('#promptInput').fill('还没有生成过的新原文');
    await page.locator('#promptOptimizeBtn').click();
    assert.equal(calls.length, 0, 'opening the dialog does not spend tokens');
    assert.equal(await page.locator('#promptOptimizeOriginal').inputValue(), '还没有生成过的新原文');
    assert.equal(await page.locator('#promptOptimizeRegenerate').textContent(), '开始优化');

    const beforePan = await page.evaluate(() => ({x:viewport.x, y:viewport.y}));
    const box = await page.locator('#promptOptimizeOriginal').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 80, {steps:5});
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({x:viewport.x, y:viewport.y})), beforePan, 'dialog drag does not pan canvas');
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('#promptOptimizeModal').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => ({x:viewport.x, y:viewport.y})), beforePan, 'closing on backdrop does not start canvas pan');
    assert.equal(calls.length, 0);
    await page.locator('#promptOptimizeBtn').click();

    await page.locator('#promptOptimizeRegenerate').click();
    await page.waitForFunction(() => document.getElementById('promptOptimizeCandidate').value === '优化后的提示词');
    assert.equal(calls.length, 1);
    await page.locator('#promptOptimizeApply').click();
    assert.equal(await page.evaluate(() => promptPlainText()), '优化后的提示词');
    assert.equal(await page.locator('#promptOptimizeRestore').isVisible(), true);

    await page.evaluate(() => {
        const id = testPaint.id;
        selectedId = '';
        updateComposer();
        selectedId = id;
        updateComposer();
    });
    assert.equal(await page.evaluate(() => promptPlainText()), '优化后的提示词', 'switching back must not load runPrompt');
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(() => promptPlainText()), '还没有生成过的新原文', 'canvas undo restores original');
    await page.evaluate(() => performRedo());
    assert.equal(await page.evaluate(() => promptPlainText()), '优化后的提示词');
    await page.evaluate(() => saveCanvas());
    assert.equal(savedCanvas.nodes.find(node => node.id === 'paint' || node.promptDraftText === '优化后的提示词')?.promptBeforeLastOptimizationText, '还没有生成过的新原文');
    const paintId = await page.evaluate(() => testPaint.id);
    await page.reload();
    await page.waitForFunction(() => canvas?.id === 'fixture' && smartConfigReady);
    await page.evaluate(id => { selectedId = id; updateComposer(); }, paintId);
    assert.equal(await page.evaluate(() => promptPlainText()), '优化后的提示词');
    await page.locator('#promptOptimizeRestore').click();
    assert.equal(await page.evaluate(() => promptPlainText()), '还没有生成过的新原文');
    assert.equal(await page.locator('#promptOptimizeRestore').isVisible(), false);
    failNext = true;
    await page.locator('#promptOptimizeBtn').click();
    await page.locator('#promptOptimizeRegenerate').click();
    await page.waitForFunction(() => document.getElementById('promptOptimizeModalStatus').textContent.includes('模拟优化失败'));
    assert.equal(await page.evaluate(() => promptPlainText()), '还没有生成过的新原文', 'failed optimization preserves the original');
    await page.locator('#promptOptimizeCancel').click();
    assert.deepEqual(errors, []);
});
