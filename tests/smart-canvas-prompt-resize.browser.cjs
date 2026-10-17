const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('prompt resize follows the handle through legacy sizes and stops at its visible minimum', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let savedCanvas = {
        id: 'prompt-resize-fixture', nodes: [
            { id: 'prompt', type: 'smart-prompt', x: 180, y: 100, w: 420, h: 600, text: '提示词\n'.repeat(100) }
        ], viewport: { x: 0, y: 0, scale: 1 }, connections: [], logs: [], settings: {}
    };
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'prompt-resize.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if(url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if(url.pathname === '/api/canvases/prompt-resize-fixture'){
            if(route.request().method() === 'PUT') savedCanvas = { ...savedCanvas, ...route.request().postDataJSON() };
            return route.fulfill({ json: { canvas: savedCanvas } });
        }
        return route.fulfill({ json: { skills: [], categories: [], items: [], cases: [], workflows: [] } });
    });
    await page.goto('http://prompt-resize.test/static/smart-canvas.html?id=prompt-resize-fixture');
    await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'prompt'));

    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const size = () => page.evaluate(() => {
        const node = nodes.find(item => item.id === 'prompt');
        const rect = document.querySelector('.image-node[data-id="prompt"]').getBoundingClientRect();
        return { width: rect.width / viewport.scale, height: rect.height / viewport.scale,
            w: node.w, h: node.h, manual: node.promptManualSize };
    });
    const drag = async (dx, dy, inspect) => {
        const handle = await page.locator('.image-node[data-id="prompt"] .node-resize-handle').boundingBox();
        const scale = await page.evaluate(() => viewport.scale);
        const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        assert.ok(await page.evaluate(() => Boolean(resizeState)));
        await page.mouse.move(start.x + dx * scale, start.y + dy * scale, { steps: 16 });
        await settle();
        const during = await size();
        if(inspect) await inspect(during);
        await page.mouse.up();
        await settle();
        assert.equal(await page.evaluate(() => resizeState), null, 'releasing over the text area ends resizing');
        const after = await size();
        assert.equal(after.w, during.w);
        assert.equal(after.h, during.h);
        assert.ok(Math.abs(after.width - during.width) < 2);
        assert.ok(Math.abs(after.height - during.height) < 2);
    };

    await drag(-60, -300, during => {
        assert.equal(during.w, 360);
        assert.equal(during.h, 300);
        assert.ok(Math.abs(during.width - 360) < 2, JSON.stringify(during));
        assert.ok(Math.abs(during.height - 300) < 2, JSON.stringify(during));
    });
    await drag(-100, -100, during => {
        assert.equal(during.w, 260);
        assert.equal(during.h, 240);
        assert.ok(Math.abs(during.width - 260) < 2, JSON.stringify(during));
        assert.ok(Math.abs(during.height - 240) < 2, JSON.stringify(during));
    });
    await drag(100, 100, during => {
        assert.equal(during.w, 360);
        assert.equal(during.h, 340);
        assert.ok(Math.abs(during.width - 360) < 2, JSON.stringify(during));
        assert.ok(Math.abs(during.height - 340) < 2, JSON.stringify(during));
    });

    await page.evaluate(() => { viewport.scale = 0.65; applyViewport(); render(); });
    await settle();
    await drag(-80, -60, during => {
        assert.equal(during.w, 280);
        assert.equal(during.h, 280);
        assert.ok(Math.abs(during.width - 280) < 2, JSON.stringify(during));
        assert.ok(Math.abs(during.height - 280) < 2, JSON.stringify(during));
    });

    await page.evaluate(() => { const node = nodes.find(item => item.id === 'prompt'); node.llmEnabled = true; node.h = 700; render(); });
    await settle();
    await drag(0, -300, during => {
        assert.equal(during.h, 490);
        assert.ok(Math.abs(during.height - 490) < 2, JSON.stringify(during));
    });
    assert.deepEqual(errors, []);
});
