const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('selected node composer keeps its screen size and position while the canvas zooms', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    // All requests stay inside this fixture; no canvas or asset data is written.
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;
        if (url.hostname !== 'xiaomei-composer.test') return route.abort();
        if (pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (pathname.endsWith('.png') || pathname.includes('media-preview')) {
            return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (pathname === '/api/config') return route.fulfill({ json: {
            api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', image_models: ['fixture-image'], chat_models: [], video_models: [] }],
            comfy_instances: []
        } });
        if (pathname === '/api/canvases/composer-fixture') return route.fulfill({ json: { canvas: {
            id: 'composer-fixture', title: 'Composer zoom fixture', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 1 }
        } } });
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });

    await page.goto('http://xiaomei-composer.test/static/smart-canvas.html?id=composer-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Composer zoom fixture');
    await page.evaluate(() => {
        window.testPaintNode = createPaintNodeAt({ x: 550, y: 200 });
        viewport = { x: 100, y: 80, scale: 1 };
        applyViewport();
        updateComposer();
    });
    await page.locator('#composer.open').waitFor({ state: 'visible' });

    const snapshot = () => page.evaluate(() => {
        const node = world.querySelector(`.image-node[data-id="${CSS.escape(window.testPaintNode.id)}"]`);
        const card = document.getElementById('composer');
        const n = node.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return {
            scale: viewport.scale,
            width: c.width,
            nodeCenterX: (n.left + n.right) / 2,
            composerCenterX: (c.left + c.right) / 2,
            nodeBottom: n.bottom,
            composerTop: c.top,
            nodeLeft: n.left,
            composerLeft: c.left
        };
    });
    const aligned = (sample, label) => {
        assert.ok(Math.abs(sample.composerCenterX - sample.nodeCenterX) < 3, `${label}: composer is not centered on its node`);
        assert.ok(Math.abs(sample.composerTop - sample.nodeBottom - 14) < 3, `${label}: composer lost its node gap`);
    };
    const initial = await snapshot();
    aligned(initial, '1x');

    await page.evaluate(() => { viewport.scale = 1.6; applyViewport(); });
    const zoomedIn = await snapshot();
    aligned(zoomedIn, '1.6x');
    assert.ok(Math.abs(zoomedIn.width - initial.width) < 2, `composer grew from ${initial.width}px to ${zoomedIn.width}px`);

    await page.evaluate(() => { viewport.scale = 0.7; applyViewport(); });
    const zoomedOut = await snapshot();
    aligned(zoomedOut, '0.7x');
    assert.ok(Math.abs(zoomedOut.width - initial.width) < 2, `composer shrank from ${initial.width}px to ${zoomedOut.width}px`);

    await page.evaluate(() => { viewport.x += 75; viewport.y += 35; applyViewport(); });
    const panned = await snapshot();
    aligned(panned, 'panned');
    assert.ok(Math.abs((panned.composerLeft - zoomedOut.composerLeft) - (panned.nodeLeft - zoomedOut.nodeLeft)) < 2);
    assert.ok(Math.abs((panned.composerTop - zoomedOut.composerTop) - (panned.nodeBottom - zoomedOut.nodeBottom)) < 2);

    // Rerendering must preserve the open editor and its screen-space geometry.
    await page.evaluate(() => render());
    const rerendered = await snapshot();
    aligned(rerendered, 'rerendered');
    assert.ok(Math.abs(rerendered.width - initial.width) < 2);

    await page.evaluate(() => {
        window.testPaintNode.manualInputRefs = [{ url: '/fixture-ref.png', name: 'Reference', kind: 'image' }];
        updateComposer();
        promptInput.textContent = '@';
        setPromptCaretToEnd();
        maybeOpenMentionPicker();
    });
    await page.locator('#mentionPicker.open').waitFor({ state: 'visible' });
    const mention = await page.evaluate(() => {
        const range = window.getSelection().getRangeAt(0);
        const caret = range.getClientRects()[0] || range.getBoundingClientRect();
        const picker = mentionPicker.getBoundingClientRect();
        const row = promptInput.closest('.prompt-row').getBoundingClientRect();
        return { caretBottom: caret.bottom, pickerTop: picker.top, pickerLeft: picker.left, pickerRight: picker.right, rowLeft: row.left, rowRight: row.right };
    });
    assert.ok(Math.abs(mention.pickerTop - mention.caretBottom - 2) < 7, `@ picker drifted from the caret: ${JSON.stringify(mention)}`);
    assert.ok(mention.pickerLeft >= mention.rowLeft - 2 && mention.pickerRight <= mention.rowRight + 2, `@ picker escaped the prompt row: ${JSON.stringify(mention)}`);
    assert.deepEqual(errors, []);
});
