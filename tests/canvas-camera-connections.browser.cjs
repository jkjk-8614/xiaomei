const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('camera connects to painting and LLM and passes reference images and camera instructions', { timeout:60000 }, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-camera.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        if(url.pathname === '/api/canvases/camera-fixture') return route.fulfill({json:{canvas:{
            id:'camera-fixture', title:'Camera fixture', nodes:[], connections:[], logs:[], settings:{}
        }}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://xiaomei-camera.test/static/smart-canvas.html?id=camera-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Camera fixture');

    const result = await page.evaluate(() => {
        const source = {id:'reference', type:'smart-upload', images:[{url:'/output/reference.png', kind:'image'}]};
        const camera = {id:'camera', type:'smart-camera', yaw:48.5, distance:11.4, previewSnapshot:'data:image/png;base64,preview'};
        const paint = {id:'paint', type:'smart-paint'};
        const prompt = {id:'prompt', type:'smart-prompt'};
        const timeline = {id:'timeline', type:'smart-timeline'};
        nodes = [source, camera, paint, prompt, timeline];
        canvas.connections = [];
        const connected = [connectInputNode(source.id, camera.id), connectInputNode(camera.id, paint.id), connectInputNode(camera.id, prompt.id)];
        connectInputNode(camera.id, paint.id);
        const refs = inputImagesFor(paint);
        const paintPrompt = inputPromptTextFor(paint);
        const llmPrompt = inputPromptTextFor(prompt);
        const generation = cameraGenerationContextFor(paint, refs);
        const edgeCount = canvas.connections.length;
        const rejected = connectInputNode(prompt.id, timeline.id);
        // Removing the reference must keep the camera link usable for text,
        // while generation still reports the missing reference.
        canvas.connections = canvas.connections.filter(conn => conn.from !== source.id);
        canvasUsesConnections = true;
        let missingReference = '';
        try { cameraGenerationContextFor(paint, inputImagesFor(paint)); }
        catch(error){ missingReference = error.message; }
        return {
            connected, edgeCount, rejected, refs:refs.map(ref => ref.url),
            paintPrompt, llmPrompt, cameraPrompt:camera.cameraPrompt,
            generationRefs:generation.refs.map(ref => ref.url),
            generationPrompt:generation.prompt, missingReference,
            stillConnectable:window.SmartCanvasDataVideo.canConnect(camera, paint)
        };
    });
    assert.deepEqual(result.connected, [true, true, true]);
    assert.equal(result.edgeCount, 3);
    assert.equal(result.rejected, false);
    assert.deepEqual(result.refs, ['/output/reference.png']);
    assert.ok(result.cameraPrompt.includes('48.5'));
    assert.ok(result.cameraPrompt.includes('11.4'));
    assert.equal(result.paintPrompt, result.cameraPrompt);
    assert.equal(result.llmPrompt, result.cameraPrompt);
    assert.equal(result.generationPrompt, result.cameraPrompt);
    assert.deepEqual(result.generationRefs, result.refs);
    assert.match(result.missingReference, /缺少参考图/);
    assert.equal(result.stillConnectable, true);

    await t.test('reset zeroes the orientation and restores the default framing', async () => {
        const id = await page.evaluate(() => createCameraNode(100, 100).id);
        const edit = page.locator(`[data-id="${id}"] .camera-edit-btn`);
        await edit.click();
        const editor = page.locator('.smart-camera-editor');
        const expected = {pitch:'0', yaw:'0', distance:'6.5', fov:'50', roll:'0'};
        for(const [field, value] of Object.entries({pitch:'-20', yaw:'60', distance:'9', fov:'70', roll:'15'})){
            await editor.locator(`[data-camera-number="${field}"]`).fill(value);
        }
        await editor.locator('[data-camera-view-mode="thirdPerson"]').click();
        await editor.locator('.smart-camera-reset').click();
        const values = attribute => editor.locator(`[${attribute}]`).evaluateAll((inputs, name) =>
            Object.fromEntries(inputs.map(input => [input.getAttribute(name), input.value])), attribute);
        assert.deepEqual(await values('data-camera-number'), expected);
        assert.deepEqual(await values('data-camera-field'), expected);
        assert.equal(await editor.locator('[data-camera-view-mode="firstPerson"]').getAttribute('aria-pressed'), 'true');

        await editor.locator('.smart-camera-done').click();
        const prompt = await page.evaluate(nodeId => nodes.find(node => node.id === nodeId).cameraPrompt, id);
        assert.match(prompt, /yaw 0°.*pitch 0°.*distance 6\.5.*FOV 50°.*roll 0°/);
        await edit.click();
        assert.deepEqual(await values('data-camera-number'), expected);
        await editor.locator('.smart-camera-done').click();
    });
    assert.deepEqual(errors, []);
});
