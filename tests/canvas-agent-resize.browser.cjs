const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('Agent content follows the resize handle during generation and keeps its size afterward', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let savedCanvas = {
        id: 'agent-resize', nodes: [{ id: 'agent', type: 'smart-agent', x: 200, y: 100, w: 460, h: 720,
            userPrompt: '分析商品', systemPrompt: '你是一名视觉策划师。', outputText: '商品分析\n'.repeat(200) }],
        viewport: { x: 0, y: 0, scale: 1 }, connections: [], logs: [], settings: {},
    };
    let pendingRequest;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'agent-resize.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/canvas-llm') { pendingRequest = route; return; }
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if (url.pathname === '/api/canvases/agent-resize') {
            if (route.request().method() === 'PUT') savedCanvas = { ...savedCanvas, ...route.request().postDataJSON() };
            return route.fulfill({ json: { canvas: savedCanvas } });
        }
        return route.fulfill({ json: { skills: [], categories: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    const open = async () => {
        await page.goto('http://agent-resize.test/static/smart-canvas.html?id=agent-resize');
        await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'agent'));
        await settle();
    };
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = () => page.evaluate(() => {
        const el = document.querySelector('.image-node[data-id="agent"]');
        const rect = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width / viewport.scale, height: r.height / viewport.scale };
        };
        return { node: rect(el), card: rect(el.querySelector('.agent-node-card')),
            output: rect(el.querySelector('.agent-output-text')), footer: rect(el.querySelector('.agent-node-footer')),
            w: nodes[0].w, h: nodes[0].h, running: nodes[0].running };
    });
    const drag = async (dx, dy) => {
        const handle = await page.locator('.image-node[data-id="agent"] .node-resize-handle').boundingBox();
        const scale = await page.evaluate(() => viewport.scale);
        const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + dx * scale, start.y + dy * scale, { steps: 12 });
        await settle();
    };
    await open();
    await page.evaluate(() => { window.agentResizeRun = runAgentNode('agent'); });
    await page.waitForFunction(() => nodes[0].running === true);
    for (const scale of [1, 0.65, 1.5]) {
        await page.evaluate(scale => { viewport.scale = scale; applyViewport(); render(); }, scale);
        await settle();
        for (const [dx, dy] of [[120, 100], [-120, -100]]) {
            const before = await geometry();
            await drag(dx, dy);
            const during = await geometry();
            assert.equal(during.running, true);
            assert.equal(during.w, before.w + dx);
            assert.equal(during.h, before.h + dy);
            assert.ok(Math.abs(during.card.width - before.card.width - dx) < 2, JSON.stringify({ before, during }));
            assert.ok(Math.abs(during.card.height - before.card.height - dy) < 2, JSON.stringify({ before, during }));
            assert.ok(Math.abs(during.output.width - before.output.width - dx) < 2, 'output width follows drag');
            assert.ok(Math.abs(during.output.height - before.output.height - dy) < 2, 'output height follows drag');
            await page.evaluate(() => { refreshRunningNodeProgress(); render(); });
            await settle();
            const refreshed = await geometry();
            assert.ok(Math.abs(refreshed.card.width - during.card.width) < 2, 'running refresh keeps content width');
            assert.ok(Math.abs(refreshed.card.height - during.card.height) < 2, 'running refresh keeps content height');
            await page.mouse.up();
            await settle();
            const after = await geometry();
            assert.equal(after.w, during.w);
            assert.equal(after.h, during.h);
        }
    }
    await drag(100, 160);
    const enlarged = await geometry();
    await pendingRequest.fulfill({ json: { text: '新的商品分析\n'.repeat(300) } });
    await page.evaluate(() => window.agentResizeRun);
    await settle();
    assert.equal((await geometry()).h, enlarged.h, 'completion during drag preserves height');
    await page.mouse.up();
    await page.evaluate(() => saveCanvas());
    await open();
    const reopened = await geometry();
    assert.equal(reopened.w, enlarged.w);
    assert.equal(reopened.h, enlarged.h);
    assert.deepEqual(errors, []);
});
