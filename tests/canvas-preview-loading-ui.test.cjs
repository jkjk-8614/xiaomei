const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('preview loading handles slow originals, rapid switching and close', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], uploadCounts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const pending = new Map();
    const delayedPreviews = [];
    let delayPreviews = false;
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
        if (pathname.startsWith('/output/preview-')) { pending.set(pathname, route); return; }
        if (pathname.includes('media-preview')) {
            if (delayPreviews) { delayedPreviews.push(route); return; }
            return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (pathname.endsWith('.png')) {
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
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await page.evaluate(() => {
        window.previewFixture = createNode(0, 0, ['a','b','c'].map(name => ({url:`/output/preview-${name}.png`,kind:'image'})), {select:false});
        openImagePreview(window.previewFixture.id, 0);
    });
    const current = page.locator('#previewCurrentImage');
    await page.waitForFunction(() => document.getElementById('previewCurrentImage').naturalWidth > 0);
    await wait(300);
    assert.match(await current.getAttribute('src'), /media-preview.*preview-a/);
    await page.evaluate(() => navigatePreviewImage(1));
    await page.waitForFunction(() => document.getElementById('previewCurrentImage').getAttribute('src')?.includes('preview-b'));
    await pending.get('/output/preview-a.png').fulfill({contentType:'image/png',body:pixel}).catch(()=>{});
    await wait(150);
    assert.match(await current.getAttribute('src'), /preview-b/);
    await pending.get('/output/preview-b.png').fulfill({contentType:'image/png',body:pixel});
    await page.waitForFunction(() => document.getElementById('previewCurrentImage').getAttribute('src') === '/output/preview-b.png');
    await page.evaluate(() => { refreshComparePanel(); refreshComparePanel(); });
    assert.equal(await current.getAttribute('src'), '/output/preview-b.png');
    delayPreviews = true;
    await page.evaluate(() => {
        window.previewFixture.images[2].url = '/output/preview-c-slow.png';
        closeImageEditor();
        openImagePreview(window.previewFixture.id, 2);
    });
    await wait(300);
    assert.equal(await page.locator('#previewLoadingState').isHidden(), false);
    assert.equal(await page.locator('#previewLoadingText').textContent(), '正在加载预览…');
    assert.equal(await page.locator('#previewRetryBtn').isHidden(), true);
    assert.ok(delayedPreviews.length > 0, 'the preview request is held open for the loading-state check');
    await delayedPreviews.shift().fulfill({contentType:'image/png',body:pixel});
    await page.waitForFunction(() => document.getElementById('previewLoadingState')?.hidden === true);
    delayPreviews = false;
    await page.waitForFunction(() => document.getElementById('previewCurrentImage').getAttribute('src')?.includes('preview-c-slow'));
    await pending.get('/output/preview-c-slow.png').abort();
    await wait(150);
    assert.match(await current.getAttribute('src'), /preview-c/);
    await page.evaluate(() => closeImageEditor());
    assert.equal(await current.getAttribute('src'), null);
    assert.deepEqual(errors, []);
});
