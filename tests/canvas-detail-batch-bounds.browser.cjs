const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('detail batch outer frame follows all sections and resized copy fields', { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-batch.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            if(!fs.existsSync(file)) return route.fulfill({status:404, body:''});
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({path:file});
        }
        if(url.pathname === '/api/canvases/batch-bounds') return route.fulfill({json:{canvas:{
            id:'batch-bounds', title:'Batch bounds', connections:[], logs:[],
            nodes:[{id:'loop-bounds', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true,
                x:30, y:30, w:420, h:640, batchSourceNodeId:'local',
                batchSourceText:Array.from({length:10}, (_, index) => `### 第 ${index + 1} 屏：画面\n该屏文案与布局${index + 1}`).join('\n'),
                aiSplitError:'AI 拆分返回格式不完整，请重新拆分', variablePrompts:['']}]
        }}});
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2'], chat_models:['fixture-chat']
        }], comfy_instances:[]}});
        if(url.pathname === '/api/canvas-llm') return route.fulfill({json:{text:'拆分结果未按 JSON 格式返回。'}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://xiaomei-batch.test/static/smart-canvas.html?id=batch-bounds');
    await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'loop-bounds'));
    const bounds = async () => {
        await page.waitForTimeout(80);
        return page.evaluate(() => {
            const node = nodes.find(item => item.id === 'loop-bounds');
            const el = world.querySelector('[data-id="loop-bounds"]');
            const outer = el.getBoundingClientRect();
            const blocks = [...el.querySelector('.loop-paired-card').children].filter(child => !child.classList.contains('loop-batch-overview')).map(child => child.getBoundingClientRect());
            return {height:el.offsetHeight, modelHeight:nodeRect(node).height, nodeHeight:node.h, measured:smartLoopMeasuredHeights.get(node), cardHeight:el.querySelector('.loop-paired-card').offsetHeight,
                sourceHeight:el.querySelector('[data-loop-detail-text]').offsetHeight, sourceStyle:el.querySelector('[data-loop-detail-text]').style.height,
                manualOpen:el.querySelector('.loop-detail-manual').open,
                contained:blocks.every(box => box.top >= outer.top && box.bottom <= outer.bottom),
                footerGap:outer.bottom - el.querySelector('[data-loop-run]').getBoundingClientRect().bottom};
        });
    };
    const initial = await bounds();
    assert.ok(initial.contained, 'all sections must fit inside the frame, including the failed split state');
    assert.ok(initial.footerGap > 0 && initial.footerGap < 30, 'frame ends just below the final detail control');
    assert.equal(initial.modelHeight, initial.height, 'connection and minimap geometry matches the visible frame');
    await page.evaluate(() => {
        const el = world.querySelector('[data-id="loop-bounds"]');
        el.querySelector('.batch-advanced').open = true;
        el.querySelector('.loop-detail-manual').open = true;
        const input = el.querySelector('[data-loop-detail-text]');
        input.style.maxHeight = 'none';
        input.style.height = '300px';
    });
    const expanded = await bounds();
    assert.ok(expanded.height > initial.height + 150, `frame expands when the text box is resized and manual split opens: ${JSON.stringify({initial, expanded})}`);
    assert.ok(expanded.contained);
    assert.equal(expanded.modelHeight, expanded.height);
    await page.evaluate(() => {
        const node = nodes.find(item => item.id === 'loop-bounds');
        node.batchVisualGuide = '统一视觉规则';
    });
    await page.locator('[data-id="loop-bounds"] [data-loop-ai-split]').click();
    await page.waitForFunction(() => {
        const node = nodes.find(item => item.id === 'loop-bounds');
        return !node.aiSplitRunning && node.aiSplitPrompts?.length === 10;
    });
    const splitState = () => page.evaluate(() => {
        const node = nodes.find(item => item.id === 'loop-bounds');
        const targets = smartLoopDetailPaintNodes(node);
        return {error:node.aiSplitError, prompts:node.aiSplitPrompts.length, ids:targets.map(item => item.id),
            guide:node.batchVisualGuide, drafts:targets.map(item => item.promptDraftText)};
    });
    const firstSplit = await splitState();
    assert.equal(firstSplit.error, '');
    assert.equal(firstSplit.ids.length, 10, 'source recovery creates one paint node for each screen');
    assert.equal(firstSplit.guide, '', 'a split without a visual guide clears the previous guide');
    firstSplit.drafts.forEach((prompt, index) => {
        assert.ok(!prompt.includes('统一视觉规则'));
        assert.ok(prompt.includes(`该屏文案与布局${index + 1}`));
    });
    const hidden = await page.evaluate(() => {
        const targets = smartLoopDetailPaintNodes(nodes.find(item => item.id === 'loop-bounds'));
        return {hidden:targets.every(smartBatchIsHidden), cards:world.querySelectorAll('.batch-screen').length,
            domNodes:targets.filter(item => world.querySelector(`[data-id="${item.id}"]`)).length};
    });
    assert.equal(hidden.hidden, true, 'new screens stay in the overview');
    assert.equal(hidden.cards, 10);
    assert.equal(hidden.domNodes, 0, 'ten-screen batch does not flood the canvas');
    await page.evaluate(() => {
        smartLoopDetailPaintNodes(nodes.find(item => item.id === 'loop-bounds')).forEach((item, index) => {
            item.x += 17 + index;
            item.y += 23 + index * 3;
        });
        render();
    });
    const restoredGrid = await page.evaluate(() => {
        const loop = nodes.find(item => item.id === 'loop-bounds');
        return smartLoopDetailPaintNodes(loop).sort((a, b) => a.batchDetailScreenIndex - b.batchDetailScreenIndex).map(item => ({x:item.x, y:item.y}));
    });
    await page.evaluate(() => runSmartLoopAiSplit('loop-bounds'));
    assert.deepEqual((await splitState()).ids, firstSplit.ids, 'retry reuses the same ten paint nodes');
    assert.deepEqual(await page.evaluate(() => smartLoopDetailPaintNodes(nodes.find(n => n.id === 'loop-bounds')).map(n => ({x:n.x,y:n.y}))), restoredGrid, 'existing node positions survive replanning');
    const populated = await bounds();
    assert.ok(populated.contained, 'ten-screen batch stays inside the frame');
    assert.equal(populated.modelHeight, populated.height);
    assert.deepEqual(errors, []);
});
