const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('each successful detail split refreshes the guide and all screen drafts', { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let reply = { visual_guide: '中古玄关、胡桃木色、暖光', screens: [
        { title: '首屏', prompt: '玄关整体画面' },
        { title: '细节', prompt: '地垫材质近景' }
    ] };
    let fail = false;
    let beforeReply = null;
    const requests = [];
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-guide.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            if(!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ path: file });
        }
        if(url.pathname === '/api/canvases/detail-guide') return route.fulfill({ json: { canvas: {
            id: 'detail-guide', title: 'Detail guide', connections: [], logs: [], nodes: [{
                id: 'loop-guide', type: 'smart-loop', batchUiMode: 'paired', batchDetailModeV2: true,
                x: 30, y: 30, w: 420, h: 640, batchSourceNodeId: 'local',
                batchSourceText: '生成中古玄关风格的两屏详情页，保留地垫产品与材质信息。',
                batchVisualGuide: '宋代极简、浅暖米白、克制留白', batchAiTargetCount: 2,
                variablePrompts: ['']
            }]
        } } });
        if(url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [{
            id: 'fixture', name: 'Fixture', enabled: true, image_models: ['gpt-image-2'], chat_models: ['fixture-chat']
        }], comfy_instances: [] } });
        if(url.pathname === '/api/canvas-llm'){
            requests.push(route.request().postDataJSON());
            if(beforeReply) await beforeReply();
            if(fail) return route.fulfill({ status: 503, json: { detail: 'fixture unavailable' } });
            return route.fulfill({ json: { text: JSON.stringify(reply) } });
        }
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-guide.test/static/smart-canvas.html?id=detail-guide');
    await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'loop-guide'));
    const state = () => page.evaluate(() => {
        const node = nodes.find(item => item.id === 'loop-guide');
        const targets = smartLoopDetailPaintNodes(node);
        return {
            guide: smartLoopDetailVisualGuide(node), error: node.aiSplitError,
            displayed: world.querySelector('[data-id="loop-guide"] [data-loop-detail-guide]').value,
            ids: targets.map(item => item.id), drafts: targets.map(item => item.promptDraftText)
        };
    });
    const split = () => page.evaluate(() => runSmartLoopAiSplit('loop-guide'));
    await page.locator('[data-id="loop-guide"] [data-loop-ai-split]').click();
    await page.waitForFunction(() => !nodes.find(item => item.id === 'loop-guide').aiSplitRunning && nodes.find(item => item.id === 'loop-guide').aiSplitPrompts?.length === 2);
    const first = await state();
    assert.equal(first.guide, reply.visual_guide);
    assert.equal(first.displayed, reply.visual_guide);
    assert.equal(first.ids.length, 2);
    first.drafts.forEach(prompt => {
        assert.ok(prompt.includes(reply.visual_guide));
        assert.ok(!prompt.includes('宋代极简'));
    });
    assert.ok(!requests[0].message.includes('宋代极简'), 'old extracted guide is not an input to the new split');

    reply.visual_guide = '工业风、深灰色、冷光';
    await split();
    const second = await state();
    assert.equal(second.displayed, reply.visual_guide);
    assert.deepEqual(second.ids, first.ids, 'resplitting updates the existing screen nodes');
    second.drafts.forEach(prompt => {
        assert.ok(prompt.includes(reply.visual_guide));
        assert.ok(!prompt.includes(first.guide));
    });

    fail = true;
    await split();
    const failed = await state();
    assert.match(failed.error, /fixture unavailable/);
    assert.equal(failed.guide, second.guide);
    assert.deepEqual(failed.drafts, second.drafts, 'failure preserves the last complete split');
    fail = false;

    beforeReply = () => page.evaluate(() => {
        nodes.find(item => item.id === 'loop-guide').batchSourceText += '输入在拆分期间变化';
    });
    await split();
    assert.match((await state()).error, /输入已改变/);
    assert.equal((await state()).guide, second.guide);
    beforeReply = null;

    reply.visual_guide = '';
    await split();
    const cleared = await state();
    assert.equal(cleared.guide, '');
    assert.equal(cleared.displayed, '');
    assert.deepEqual(cleared.drafts, reply.screens.map(item => item.prompt));

    await page.locator('[data-id="loop-guide"] [data-loop-detail-guide]').fill('手工修改后的统一风格');
    assert.equal((await state()).guide, '手工修改后的统一风格');
    (await state()).drafts.forEach(prompt => assert.ok(prompt.includes('手工修改后的统一风格')));
    reply.visual_guide = '重新拆分后的当前风格';
    await split();
    assert.equal((await state()).displayed, reply.visual_guide);

    await page.evaluate(() => {
        nodes.find(item => item.id === 'loop-guide').batchSourceText = '### 第 1 屏：首屏\n保留首屏原文\n### 第 2 屏：细节\n保留细节原文';
    });
    reply = {};
    await split();
    const recovered = await state();
    assert.equal(recovered.error, '');
    assert.equal(recovered.guide, '', 'recovery from source screens also clears an absent guide');
    assert.deepEqual(recovered.ids, first.ids);
    assert.ok(recovered.drafts[0].includes('保留首屏原文'));
    assert.ok(recovered.drafts[1].includes('保留细节原文'));

    await page.evaluate(() => {
        nodes.find(item => item.id === 'loop-guide').batchSourceText = [
            '### 第 1 屏：首屏', '**策划文案：**', '- **主标题：** 把回忆装进相框',
            '**AI 绘图提示词：**', 'Prompt: framed product',
            '### 第 2 屏：细节', '**策划文案：**', '- **主标题：** 细节值得珍藏',
            '**AI 绘图提示词：**', 'Prompt: product detail'
        ].join('\n');
    });
    reply = {visual_guide:'暖光', screens:[
        {title:'首屏', prompt:'framed product'}, {title:'细节', prompt:'product detail'}
    ]};
    await split();
    const withCopy = await state();
    assert.ok(withCopy.drafts[0].includes('把回忆装进相框'));
    assert.ok(withCopy.drafts[1].includes('细节值得珍藏'));
    assert.ok(!withCopy.drafts[0].includes('细节值得珍藏'));

    await page.evaluate(() => {
        const node = nodes.find(item => item.id === 'loop-guide');
        nodes.push({ id: 'linked-guide', type: 'smart-prompt', x: 0, y: 900, text: '独立连接的复古风格' });
        addConnection('linked-guide', node.id, 'input');
        node.batchGuideNodeId = 'linked-guide';
        render();
    });
    reply.visual_guide = '模型返回的另一种风格';
    await split();
    const linked = await state();
    assert.equal(linked.guide, '独立连接的复古风格');
    assert.equal(linked.displayed, linked.guide);
    assert.ok(requests.at(-1).message.includes(linked.guide));
    linked.drafts.forEach(prompt => {
        assert.ok(prompt.includes(linked.guide));
        assert.ok(!prompt.includes(reply.visual_guide));
    });
    assert.deepEqual(errors, []);
});
