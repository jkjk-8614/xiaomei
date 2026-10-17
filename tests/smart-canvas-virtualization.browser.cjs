const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('smart canvas keeps only nearby nodes and connections in the DOM', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'xiaomei-virtualization.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            if (!fs.existsSync(file) || !file.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ path: file });
        }
        if (url.pathname === '/api/canvases/virtualization-fixture') {
            return route.fulfill({ json: { canvas: {
                id: 'virtualization-fixture', title: 'Virtualization fixture', nodes: [], connections: [], logs: [], settings: {}
            } } });
        }
        if (url.pathname === '/api/config' || url.pathname === '/api/providers') {
            return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        }
        if (url.pathname === '/api/workflows' || url.pathname === '/api/comfy-apps/catalog') {
            return route.fulfill({ json: { workflows: [], items: [] } });
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://xiaomei-virtualization.test/static/smart-canvas.html?id=virtualization-fixture');
    await page.waitForFunction(() => typeof render === 'function' && canvas?.id === 'virtualization-fixture');
    await page.evaluate(() => {
        nodes = [
            { id: 'near', type: 'smart-paint', x: 120, y: 160, images: [], w: 260, h: 300 },
            { id: 'other', type: 'smart-paint', x: 520, y: 160, images: [], w: 260, h: 300 },
            { id: 'far', type: 'smart-paint', x: 10000, y: 160, images: [], w: 260, h: 300 }
        ];
        canvas.connections = [{ from: 'near', to: 'far', kind: 'input' }];
        viewport = { x: 0, y: 0, scale: 1 };
        selectedId = '';
        selectedIds = [];
        selectedImage = { nodeId: '', index: -1 };
        applyViewport();
        render();
    });
    await page.waitForTimeout(80);
    let result = await page.evaluate(() => ({
        nodeIds: [...world.querySelectorAll('.image-node')].map(el => el.dataset.id),
        connectionCount: world.querySelectorAll('.conn-group').length,
        dataCount: nodes.length
    }));
    assert.deepEqual(result, { nodeIds: ['near', 'other'], connectionCount: 1, dataCount: 3 });

    await page.evaluate(() => {
        window.partialRenderIdentity = {
            near: world.querySelector('[data-id="near"]'),
            other: world.querySelector('[data-id="other"]')
        };
        nodes.find(node => node.id === 'near').pending = 2;
        render({ nodeIds: ['near'] });
    });
    assert.deepEqual(await page.evaluate(() => ({
        nearPreserved: world.querySelector('[data-id="near"]') === partialRenderIdentity.near,
        otherPreserved: world.querySelector('[data-id="other"]') === partialRenderIdentity.other,
        nearPending: world.querySelector('[data-id="near"]')?.classList.contains('node-pending')
    })), { nearPreserved: true, otherPreserved: true, nearPending: true });

    await page.evaluate(() => {
        window.viewportRenderCalls = 0;
        const originalRender = render;
        window.render = (...args) => {
            window.viewportRenderCalls++;
            return originalRender(...args);
        };
        viewport = { x: -120, y: 0, scale: 1 };
        applyViewport();
        scheduleCanvasViewportRender();
    });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.viewportRenderCalls), 0);
    await page.evaluate(() => {
        viewport = { x: -9700, y: 0, scale: 1 };
        applyViewport();
        scheduleCanvasViewportRender();
    });
    await page.waitForTimeout(80);
    result = await page.evaluate(() => ({
        nodeIds: [...world.querySelectorAll('.image-node')].map(el => el.dataset.id),
        connectionCount: world.querySelectorAll('.conn-group').length,
        dataCount: nodes.length,
        viewportRenderCalls: window.viewportRenderCalls
    }));
    assert.deepEqual(result, { nodeIds: ['far'], connectionCount: 1, dataCount: 3, viewportRenderCalls: 1 });
    assert.deepEqual(errors, []);
});
