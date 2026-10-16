const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('dragged nodes stay aligned with their canvas coordinates after a background redraw', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-drag-position.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ path: file });
        }
        if(url.pathname === '/api/canvases/drag-position-fixture'){
            return route.fulfill({ json: { canvas: {
                id: 'drag-position-fixture', title: 'Drag position fixture', nodes: [], connections: [], logs: [], settings: {}
            } } });
        }
        if(url.pathname === '/api/config' || url.pathname === '/api/providers'){
            return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://xiaomei-drag-position.test/static/smart-canvas.html?id=drag-position-fixture');
    await page.waitForFunction(() => typeof render === 'function' && canvas?.id === 'drag-position-fixture');
    await page.evaluate(() => {
        nodes = [
            { id: 'first', type: 'smart-paint', x: 150, y: 170, images: [], w: 260, h: 300 },
            { id: 'second', type: 'smart-paint', x: 570, y: 170, images: [], w: 260, h: 300 }
        ];
        canvasViewPrefs.snap = false;
        viewport = { x: 0, y: 0, scale: 1 };
        applyViewport();
        render();
    });

    for(const id of ['first', 'second']){
        const node = page.locator(`.image-node[data-id="${id}"]`);
        const box = await node.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + 90, box.y + 75);
        await page.mouse.down();
        await page.mouse.move(box.x + 170, box.y + 115, { steps: 5 });
        await page.evaluate(id => {
            // Background synchronization can replace node objects during a drag.
            nodes = nodes.map(node => ({ ...node }));
            canvas.nodes = nodes;
            const el = world.querySelector(`.image-node[data-id="${id}"]`);
            // The same update can leave the DOM origin behind the model position.
            el.style.left = `${Number.parseFloat(el.style.left) + 35}px`;
            render({ nodeIds: [id] });
        }, id);
        await page.mouse.move(box.x + 210, box.y + 135, { steps: 5 });
        const during = await page.evaluate(id => {
            const model = nodes.find(node => node.id === id);
            const el = world.querySelector(`.image-node[data-id="${id}"]`);
            const bounds = el.getBoundingClientRect();
            const origin = world.getBoundingClientRect();
            return { modelX: model.x, modelY: model.y, visibleX: bounds.left - origin.left, visibleY: bounds.top - origin.top };
        }, id);
        assert.ok(Math.abs(during.visibleX - during.modelX) < 2, JSON.stringify(during));
        assert.ok(Math.abs(during.visibleY - during.modelY) < 2, JSON.stringify(during));
        await page.mouse.up();
    }
    assert.deepEqual(errors, []);
});
