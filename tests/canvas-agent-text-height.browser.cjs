const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('Agent user text height survives canvas clicks, zoom, vertical resizing and reload', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let savedCanvas = {
        id: 'agent-height-fixture', title: 'Agent height fixture',
        nodes: [{ id: 'agent-height', type: 'smart-agent', x: 400, y: 150, w: 460, h: 1000,
            agentUserPromptHeight: 350, agentManualSizeV2: true,
            systemPrompt: '', userPrompt: '', outputText: '' }],
        viewport: { x: 80, y: 40, scale: 0.65 }, connections: [], logs: [], settings: { engine: 'api' },
    };
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'agent-height.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if (url.pathname === '/api/canvases/agent-height-fixture') {
            if (route.request().method() === 'PUT') {
                savedCanvas = { ...savedCanvas, ...route.request().postDataJSON() };
            }
            return route.fulfill({ json: { canvas: savedCanvas } });
        }
        return route.fulfill({ json: { skills: [], categories: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    const open = async () => {
        await page.goto('http://agent-height.test/static/smart-canvas.html?id=agent-height-fixture');
        await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'agent-height'));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const snapshot = () => page.evaluate(() => ({
        height: document.querySelector('.agent-user-prompt').offsetHeight,
        savedHeight: nodes.find(n => n.id === 'agent-height').agentUserPromptHeight,
        nodeHeight: nodes.find(n => n.id === 'agent-height').h,
    }));
    const expectHeight = async (height, label) => {
        const sample = await snapshot();
        assert.equal(sample.height, height, `${label}: displayed height`);
        assert.equal(sample.savedHeight, height, `${label}: saved height`);
        assert.equal(sample.nodeHeight, 1000, `${label}: card height`);
    };
    await open();
    await expectHeight(350, 'loaded at 65%');
    const dragVertically = async delta => {
        const rect = await page.locator('.agent-user-prompt').boundingBox();
        const scale = await page.evaluate(() => viewport.scale);
        await page.mouse.move(rect.x + rect.width - 3 * scale, rect.y + rect.height - 3 * scale);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width - 3 * scale, rect.y + rect.height - 3 * scale + delta * scale, { steps: 12 });
        await page.mouse.up();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await dragVertically(100);
    const enlarged = (await snapshot()).height;
    assert.ok(enlarged > 430, `native drag enlarges textarea: ${enlarged}`);
    for (const scale of [0.65, 1, 1.5, 0.5]) {
        await page.evaluate(scale => { viewport.scale = scale; applyViewport(); render(); }, scale);
        for (let i = 0; i < 3; i++) {
            await page.mouse.click(1450, 500);
            await page.evaluate(() => render());
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expectHeight(enlarged, `canvas click at ${scale}`);
        }
    }
    await dragVertically(-100);
    const shortened = (await snapshot()).height;
    assert.ok(shortened < enlarged - 80, 'native drag can shorten textarea');
    await expectHeight(shortened, 'manual shortening');
    await page.evaluate(() => saveCanvas());
    assert.equal(savedCanvas.nodes[0].agentUserPromptHeight, shortened, 'save request preserves manual height');
    await open();
    await expectHeight(shortened, 'reopened canvas');
    await page.evaluate(() => { nodes[0].agentUserPromptHeight = 1300; render(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectHeight(1300, 'large manual height');
    assert.deepEqual(errors, []);
});
