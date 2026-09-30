const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('live Agent references follow the input strip and retain all uploaded/request/history images', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], uploadCounts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    // Serve only repository assets and fixtures: no live canvas writes or model calls.
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        if (url.hostname !== 'xiaomei-reference.test') return route.abort();
        if (pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if (!require('node:fs').existsSync(file)) {
                file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            }
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ path: file });
        }
        if (pathname.endsWith('.png') || pathname.includes('media-preview')) {
            return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (pathname === '/api/ai/upload') {
            const names = [...request.postDataBuffer().toString('utf8').matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
            uploadCounts.push(names.length);
            return route.fulfill({ json: { files: names.map(name => ({ url: `/fixture-images/${name}`, name, kind: 'image', natural_w: 100, natural_h: 100 })) } });
        }
        requests.push({ path: pathname, method: request.method(), body: request.postDataJSON() });
        if (pathname === '/api/config') return route.fulfill({ json: {
            api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', chat_models: ['fixture-chat'], image_models: ['fixture-image'], video_models: [] }],
            comfy_instances: []
        } });
        if (pathname === '/api/canvases/reference-fixture') return route.fulfill({ json: { canvas: {
            id: 'reference-fixture', title: 'Reference sync fixture', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 3 }
        } } });
        if (pathname === '/api/canvas-agent-action') return route.fulfill({ json: { no_generation: true, can_apply: false, summary: 'Analysis complete' } });
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-reference.test/static/smart-canvas.html?id=reference-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Reference sync fixture');
    await page.locator('#canvasAgentToggle').click();
    await page.evaluate(() => {
        const ref = name => ({ url: `/fixture-images/${name}.png`, name: `${name}.png`, kind: 'image', natural_w: 100, natural_h: 100 });
        const ancestor = createNode(0, 0, [ref('old-a'), ref('old-b')], { select: false });
        const source = createNode(100, 100, ['a', 'b', 'c', 'd'].map(ref), { select: false });
        source.runAt = 1;
        const target = createPaintNodeAt({ x: 700, y: 300 });
        connectInputNode(ancestor.id, source.id);
        connectInputNode(source.id, target.id);
        window.referenceFixture = { source, target };
        render();
    });
    async function assertSynced(expectedNames) {
        const actual = await page.evaluate(() => ({
            left: [...document.querySelectorAll('#inputThumbsRow .input-thumb')].map(item => item.dataset.url.split('/').pop()),
            right: [...document.querySelectorAll('#canvasAgentComposerAttachments .canvas-agent-composer-attachment img')].map(item => item.alt),
            labels: [...document.querySelectorAll('#canvasAgentComposerAttachments .canvas-agent-composer-attachment em')].map(item => item.textContent)
        }));
        assert.deepEqual(actual.left, expectedNames);
        assert.deepEqual(actual.right, expectedNames);
        assert.deepEqual(actual.labels, expectedNames.map((_, i) => String(i + 1)));
    }
    await assertSynced(['a.png', 'b.png', 'c.png', 'd.png']);
    await page.evaluate(() => {
        const { source, target } = window.referenceFixture;
        outputImagesForNode(source).slice(2).forEach(ref => toggleInputRefBlocked(target, ref));
    });
    await assertSynced(['a.png', 'b.png']);
    assert.equal(await page.locator('#inputThumbsRow .input-thumb-nav').count(), 0);
    const firstThumb = await page.locator('#inputThumbsRow .input-thumb').nth(0).boundingBox();
    const secondThumb = await page.locator('#inputThumbsRow .input-thumb').nth(1).boundingBox();
    await page.mouse.move(firstThumb.x + firstThumb.width / 2, firstThumb.y + firstThumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondThumb.x + secondThumb.width / 2, secondThumb.y + secondThumb.height / 2, { steps: 5 });
    await page.mouse.up();
    await assertSynced(['b.png', 'a.png']);
    await page.evaluate(() => {
        const { target } = window.referenceFixture;
        visibleReferenceImagesFor(target).forEach(ref => toggleInputRefBlocked(target, ref));
    });
    await assertSynced([]);
    await page.evaluate(() => {
        const { source, target } = window.referenceFixture;
        outputImagesForNode(source).forEach(ref => toggleInputRefBlocked(target, ref));
    });
    await assertSynced(['b.png', 'a.png', 'c.png', 'd.png']);

    await page.evaluate(async () => {
        const target = createPaintNodeAt({ x: 700, y: 300 });
        settings.count = 3;
        persistActiveSmartSettings();
        const files = Array.from({ length: 25 }, (_, i) => new File(['fixture'], `left-${i}.png`, { type: 'image/png' }));
        await handleFiles(files, target.id);
    });
    const leftNames = Array.from({ length: 25 }, (_, i) => `left-${i}.png`);
    await assertSynced(leftNames);
    const rightNames = Array.from({ length: 25 }, (_, i) => `right-${i}.png`);
    await page.locator('#canvasAgentComposerFileInput').setInputFiles(rightNames.map(name => ({ name, mimeType: 'image/png', buffer: pixel })));
    await page.waitForFunction(() => document.querySelectorAll('#canvasAgentComposerAttachments .canvas-agent-composer-attachment').length === 50);
    assert.deepEqual(uploadCounts, [25, 25]);
    const allNames = [...leftNames, ...rightNames];
    assert.deepEqual(await page.locator('#canvasAgentComposerAttachments img').evaluateAll(items => items.map(item => item.alt)), allNames);
    assert.equal(await page.evaluate(() => smartSettingsForNode(selectedNode()).count), 3);
    await page.locator('#canvasAgentInput').fill('只分析这些图片，不要生成图片');
    await page.locator('#canvasAgentSend').click();
    await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled);
    const action = requests.find(request => request.path === '/api/canvas-agent-action');
    assert.ok(action, 'the Agent sends its analysis request');
    assert.deepEqual(action.body.images, allNames.map(name => `/fixture-images/${name}`));
    assert.equal(await page.evaluate(() => smartSettingsForNode(selectedNode()).count), 3);
    assert.deepEqual(await page.locator('.agent-message-refs img').evaluateAll(items => items.map(item => item.alt)), allNames);
    await assertSynced(leftNames);
    assert.equal(requests.some(request => request.path === '/api/canvas-image-tasks'), false);
    assert.deepEqual(errors, []);
});
