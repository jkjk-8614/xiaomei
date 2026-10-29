const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('detail batches retain concurrency, screen pairing, sequential runs and stop behavior', { timeout: 60000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
    const errors = [], submissions = [], tasks = new Map(), saves = [];
    const screens = Array.from({length:10}, (_, index) => `画面${index + 1}内容`);
    let savedCanvas;
    page.on('pageerror', error => errors.push(error.message));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        if(url.hostname !== 'xiaomei-concurrency.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if(pathname === '/api/config') return route.fulfill({ json: { api_providers: [{
            id: 'fixture', name: 'Fixture', enabled: true, image_models: ['gpt-image-2'], chat_models: ['fixture-chat']
        }], comfy_instances: [] } });
        if(pathname === '/api/canvases/concurrency' && request.method() === 'GET') return route.fulfill({ json: { canvas: savedCanvas || {
            id: 'concurrency', title: 'Concurrency', connections: [{ from: 'product', to: 'loop', kind: 'input' }], logs: [], nodes: [
                { id: 'product', type: 'smart-upload', x: -400, y: 30, images: [{ url: '/output/product.png', name: 'product.png' }] },
                { id: 'loop', type: 'smart-loop', batchUiMode: 'paired', batchDetailModeV2: true,
                    x: 30, y: 30, w: 420, h: 640, mode: 'serial', batchVisualGuide: '共同风格规则',
                    batchAiTargetCount: screens.length, variablePrompts: screens,
                    aiSplitPrompts: screens.map(prompt => ({ prompt })),
                    batchImageSettings: { engine: 'api', provider_id: 'fixture', model: 'gpt-image-2', ratio: '9:16', resolution: '1k', count: 1 } }
            ]
        } } });
        if(pathname.startsWith('/api/canvases/') && request.method() !== 'GET'){
            savedCanvas = request.postDataJSON();
            saves.push(savedCanvas);
            return route.fulfill({ json: { success: true } });
        }
        if(pathname === '/api/canvas-image-tasks' && request.method() === 'POST'){
            const id = `task-${submissions.length + 1}`;
            submissions.push({ id, payload: request.postDataJSON() });
            tasks.set(id, 'running');
            return route.fulfill({ json: { task_id: id, status: 'queued' } });
        }
        if(pathname.startsWith('/api/canvas-image-tasks/')){
            const id = pathname.split('/').pop(), status = tasks.get(id);
            return route.fulfill({ json: { id, status,
                ...(status === 'succeeded' ? { result: { images: [`/output/${id}.png`] } } : {}),
                ...(status === 'failed' ? { error: 'fixture screen failed' } : {}) } });
        }
        if(pathname.startsWith('/output/') || pathname === '/api/media-preview') return route.fulfill({ contentType: 'image/png', body: png });
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-concurrency.test/static/smart-canvas.html?id=concurrency');
    await page.waitForFunction(() => smartConfigReady && smartLoopDetailPaintNodes(nodes.find(n => n.id === 'loop')).length === 10);
    await page.addStyleTag({content:'#canvasNavPanel{display:none!important}'});
    await page.evaluate(() => { viewport = { x: 80, y: 20, scale: 1 }; applyViewport(); });
    const loop = page.locator('[data-id="loop"]');
    await loop.locator('.batch-advanced > summary').click();
    await loop.locator('[data-loop-mode="parallel"]').click();
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'loop').mode), 'parallel');
    await loop.locator('[data-loop-switch-advanced]').click();
    assert.ok(await loop.locator('[data-loop-mode="parallel"]').evaluate(el => el.classList.contains('active')));
    await loop.locator('[data-loop-switch-paired]').click();
    assert.ok(await loop.locator('[data-loop-mode="parallel"]').evaluate(el => el.classList.contains('active')));
    await page.evaluate(() => render());
    assert.equal(await page.evaluate(() => validateSmartLoopPairedRun(nodes.find(n => n.id === 'loop')).ok), true);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'loop').mode), 'parallel');

    const waitSubmissions = async count => {
        await page.waitForFunction(count => nodes.some(n => (n.pendingTasks || []).some(task => task.taskId === `task-${count}`)), count, { timeout: 8000 });
        assert.equal(submissions.length, count);
    };
    const start = () => loop.locator('[data-loop-run]').click();
    const finish = () => page.waitForFunction(() => !smartCascadeIsLoopRunning('loop'));
    await start();
    await waitSubmissions(screens.length);
    await page.waitForTimeout(150);
    assert.equal(submissions.length, screens.length, 'all ten target screens start before any finishes');
    tasks.set('task-10', 'succeeded');
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n => n.id === 'loop'))[9].images?.[0]?.url === '/output/task-10.png');
    tasks.set('task-1', 'failed');
    for(let i = 2; i < 10; i++) tasks.set(`task-${i}`, 'succeeded');
    await finish();
    assert.equal(await page.evaluate(() => smartLoopContext), null, 'concurrent rounds do not leak a global context');
    const result = await page.evaluate(() => smartLoopDetailPaintNodes(nodes.find(n => n.id === 'loop')).map(n => ({ images: n.images, error: n.runError })));
    assert.match(result[0].error, /fixture screen failed/);
    for(let i = 1; i < screens.length; i++) assert.equal(result[i].images[0].url, `/output/task-${i + 1}.png`, 'out-of-order completion stays on its screen');
    submissions.forEach(({ payload }, index) => {
        assert.ok(payload.prompt.includes(screens[index]));
        assert.ok(payload.prompt.includes('共同风格规则'));
        assert.equal(payload.canvas_batch_concurrency, screens.length);
        assert.equal(payload.reference_images.length, 1);
        assert.equal(payload.reference_images[0].url, '/output/product.png');
    });

    submissions.length = 0; tasks.clear();
    await loop.locator('[data-loop-mode="serial"]').click();
    await start();
    for(let i = 1; i <= screens.length; i++){
        await page.waitForFunction(index => nodes.some(n => (n.pendingTasks || []).some(task => task.taskId === `task-${index}`)), i);
        assert.equal(submissions.length, i, 'sequential mode waits for each task to finish');
        assert.equal(submissions[i - 1].payload.canvas_batch_concurrency, undefined, 'serial requests use the ordinary task limiter');
        tasks.set(`task-${i}`, 'succeeded');
    }
    await finish();

    submissions.length = 0; tasks.clear();
    await page.evaluate(() => {
        const node = nodes.find(n => n.id === 'loop');
        node.batchAiTargetCount = 3;
        node.aiSplitPrompts = node.aiSplitPrompts.slice(0, 3);
        node.variablePrompts = node.variablePrompts.slice(0, 3);
        render();
    });
    await loop.locator('[data-loop-mode="parallel"]').click();
    await start();
    await waitSubmissions(3);
    submissions.forEach(({payload}) => assert.equal(payload.canvas_batch_concurrency, 3, 'concurrency follows the new screen count'));
    await loop.locator('[data-loop-run]').click();
    tasks.set('task-1', 'succeeded'); tasks.set('task-2', 'succeeded'); tasks.set('task-3', 'succeeded');
    await finish();
    assert.equal(submissions.length, 3, 'stopping lets all submitted screens finish without submitting extras');
    assert.equal(await page.evaluate(() => smartCascadeIsLoopRunning('loop')), false);
    assert.ok(saves.some(save => (save.nodes || save.canvas?.nodes || []).some(n => n.id === 'loop' && n.mode === 'parallel')), 'mode persists with the canvas');
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'loop'));
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'loop').mode), 'parallel', 'reopening retains parallel mode');
    assert.deepEqual(errors, []);
});

test('visual guide resizes with the mouse beyond its old height limit', { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
    let savedCanvas;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-resize.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if(url.pathname === '/api/canvases/resize' && route.request().method() === 'GET') return route.fulfill({ json: { canvas: savedCanvas || {
            id: 'resize', title: 'Resize', connections: [], logs: [], nodes: [{ id: 'loop', type: 'smart-loop', batchUiMode: 'paired', batchDetailModeV2: true,
                x: 30, y: 30, w: 420, h: 640, batchVisualGuide: '视觉风格规则\n'.repeat(50), variablePrompts: [''] }]
        } } });
        if(url.pathname === '/api/canvases/resize' && route.request().method() !== 'GET'){
            savedCanvas = route.request().postDataJSON();
            return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: { api_providers: [], skills: [], categories: [], libraries: [], items: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-resize.test/static/smart-canvas.html?id=resize');
    await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'loop'));
    await page.addStyleTag({content:'#canvasNavPanel{display:none!important}'});
    await page.evaluate(() => { viewport = { x: 40, y: 20, scale: 1 }; applyViewport(); });
    const guide = page.locator('[data-loop-detail-guide]');
    const before = await guide.boundingBox();
    await page.mouse.move(before.x + before.width - 4, before.y + before.height - 4);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width - 4, before.y + before.height + 200, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await guide.boundingBox();
    assert.ok(after.height > 200, `guide can be dragged taller: before ${before.height}, after ${after.height}`);
    const bounds = await page.evaluate(() => {
        const node = nodes.find(n => n.id === 'loop'), el = world.querySelector('[data-id="loop"]');
        const outer = el.getBoundingClientRect();
        return { height: el.offsetHeight, model: nodeRect(node).height,
            contained: [...el.querySelector('.loop-paired-card').children].every(child => child.getBoundingClientRect().bottom <= outer.bottom) };
    });
    assert.ok(bounds.contained);
    assert.equal(bounds.height, bounds.model);
    await page.locator('[data-id="loop"] .batch-advanced > summary').click();
    await page.locator('[data-loop-mode="parallel"]').click();
    assert.equal((await guide.boundingBox()).height, after.height, 'mode changes keep the resized guide height');
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'loop'));
    assert.equal(await guide.evaluate(el => el.offsetHeight), Math.round(after.height), 'reopening keeps the resized guide height');
    for(const scale of [0.65, 1.3]){
        await page.evaluate(scale => { viewport = { x: 40, y: 20, scale }; applyViewport(); }, scale);
        const box = await guide.boundingBox();
        const originalHeight = await guide.evaluate(el => el.offsetHeight);
        await page.mouse.move(box.x + box.width - 4 * scale, box.y + box.height - 4 * scale);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4 * scale, box.y + box.height + 80, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(100);
        assert.ok(await guide.evaluate(el => el.offsetHeight) > originalHeight + 30, `guide resizing works at scale ${scale}`);
    }
});
