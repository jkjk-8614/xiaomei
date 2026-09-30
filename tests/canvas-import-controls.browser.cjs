const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('ordinary generation uses API controls while ComfyUI keeps its node controls', { timeout: 40000 }, async t => {
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
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            if (!require('node:fs').existsSync(file)) return route.fulfill({status:404, body:''});
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
            return route.fulfill({ json: { files: names.map(name => ({ url: `/fixture-images/${name}`, name, kind: 'image', natural_w: 300, natural_h: 450 })) } });
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
    delayPreviews = true;
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 300; canvas.height = 450;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d34829'; ctx.fillRect(0,0,300,450);
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        await handleFiles([new File([blob], 'paste.png', {type:'image/png'})], '', {forceNew:true, deferComposer:true});
    });
    const img = page.locator('.image-wrap > img').first();
    await img.evaluate(el => el.decode());
    assert.match(await img.getAttribute('src'), /^data:image\/png/);
    assert.equal(await img.getAttribute('data-original-src'), '/fixture-images/paste.png');
    assert.equal(await img.getAttribute('loading'), 'eager');
    assert.equal(await img.evaluate(el => getComputedStyle(el.closest('.image-node')).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('[data-smart-node-action="upscale"]').count(), 0);
    assert.equal(await page.locator('#smartUpscalePopover').count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(nodes).includes('data:image/png')), false);
    await page.evaluate(() => { window.paintFixture = createPaintNodeAt({x:1050,y:250}); updateComposer(); });
    assert.equal(await page.locator('#promptInput').isVisible(), true);
    await page.locator('.composer .param-row').waitFor({state:'visible'});
    assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).width), '540px');
    await page.evaluate(() => { window.comfyFixture = createComfyWorkflowNodeAt({x:1600,y:250}, {workflow_ref:'fixture.json'}); updateComposer(); });
    assert.equal(await page.locator('#promptInput').isVisible(), false);
    assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).width), '104px');
    assert.equal(await page.locator('.comfy-node-workflow-select').count() > 0, true);
    assert.equal(await page.evaluate(() => smartSettingsForNode(window.comfyFixture).engine), 'comfy');
    await page.evaluate(() => { selectedId = window.paintFixture.id; render(); updateComposer(); });
    assert.equal(await page.locator('#promptInput').isVisible(), true);
    await page.evaluate(() => {
        window.paintFixture.runSettings = {...window.paintFixture.runSettings, engine:'comfy', comfyMode:'custom', comfyWorkflow:'saved.json'};
        lastComposerNodeId = '';
        updateComposer(); renderDynamicParams();
    });
    assert.equal(await page.evaluate(() => settings.engine), 'api');
    await page.locator('.composer .model-control').waitFor({state:'visible'});
    assert.equal(await page.locator('.smart-source-control').count(), 0);
    assert.equal(await page.evaluate(() => window.paintFixture.runSettings.engine), 'api');
    assert.equal(await page.evaluate(() => smartSettingsForNode(window.paintFixture).model), 'fixture-image');
    await page.evaluate(() => {
        createComfyWorkflowNodeAt({x:1600,y:250}, {workflow_ref:'fixture.json'});
        updateComposer(); renderDynamicParams();
        window.newPaint = createPaintNodeAt({x:1050,y:250});
        updateComposer(); renderDynamicParams();
    });
    assert.equal(await page.evaluate(() => window.newPaint.runSettings.engine), 'api');
    await page.locator('.composer .model-control').waitFor({state:'visible'});
    assert.equal(await page.evaluate(async () => prepareSmartImportedPreview(new File(['broken'], 'bad.png', {type:'image/png'}))), null);
    await page.locator('.composer .model-control').waitFor({state:'visible'});
    await page.screenshot({path: path.join(require('node:os').tmpdir(), 'xiaomei-canvas-controls-review.png')});
    assert.deepEqual(errors, []);
});
