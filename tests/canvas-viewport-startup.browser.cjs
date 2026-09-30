const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('canvas startup and stable wheel zoom', { timeout: 40000 }, async t => {
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
            if (!require('node:fs').existsSync(file)) return route.fulfill({status:404, body:''});
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
        if (['/api/prompt-libraries', '/api/asset-library', '/api/local-assets'].some(p => pathname.startsWith(p))) { pending.set(pathname, route); return; }
        requests.push({ path: pathname, method: request.method(), body: request.postDataJSON() });
        if (['/api/config', '/api/workflows', '/api/comfy-apps/catalog'].includes(pathname)) { pending.set(pathname, route); return; }
        if (pathname === '/api/canvases/reference-fixture') return route.fulfill({ json: { canvas: {
            id: 'reference-fixture', title: 'Reference sync fixture', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 3 }
        } } });
        if (pathname === '/api/canvas-agent-action') return route.fulfill({ json: { no_generation: true, can_apply: false, summary: 'Analysis complete' } });
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-reference.test/static/smart-canvas.html?id=reference-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Reference sync fixture');
    assert.ok(pending.size > 0);
    assert.equal(await page.evaluate(() => settings.model), 'fixture-image');
    assert.equal(await page.evaluate(() => settings.provider_id), 'fixture');
    await page.evaluate(() => { createNode(100,100,[],{select:false}); viewport={x:120,y:80,scale:1}; applyViewport(); });
    await page.evaluate(() => { window.zoomComposerNodeId = createNode(600,300,[],{nodeType:SMART_PAINT_NODE_TYPE,select:true}).id; });
    await page.waitForTimeout(220);
    const composerZoom = await page.evaluate(() => {
        const node = nodes.find(candidate => candidate.id === window.zoomComposerNodeId);
        composer.style.transition = 'none';
        promptInput.textContent = '@';
        const range = document.createRange();
        range.selectNodeContents(promptInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const sample = scale => {
            viewport.scale = scale;
            applyViewport();
            positionMentionPickerAtCaret();
            const card = composer.getBoundingClientRect();
            const target = world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"]`).getBoundingClientRect();
            return {width:card.width, height:card.height, gap:card.top-target.bottom,
                layoutWidth:composer.offsetWidth, layoutHeight:composer.offsetHeight,
                visualScale:parseFloat(getComputedStyle(composer).getPropertyValue('--composer-canvas-scale')),
                nodeCenter:target.left+target.width/2, cardLeft:card.left, cardRight:card.right,
                mentionLeft:parseFloat(mentionPicker.style.left), mentionTop:parseFloat(mentionPicker.style.top), parent:composer.parentElement.id};
        };
        const samples = [sample(1), sample(0.9), sample(0.8), sample(0.4), sample(0.15), sample(1.8)];
        selectedId = null;
        updateComposer();
        composer.style.removeProperty('transition');
        viewport = {x:120,y:80,scale:1};
        applyViewport();
        return samples;
    });
    assert.deepEqual(composerZoom.map(sample => sample.parent), Array(composerZoom.length).fill('shell'));
    assert.deepEqual(composerZoom.map(sample => sample.visualScale), [1,1,1,1,1,1.8]);
    assert.ok(composerZoom.every(sample => Math.abs(sample.width-sample.layoutWidth*sample.visualScale) < 1),
        'composer should follow canvas zoom until reaching its readable-size floor');
    assert.ok(composerZoom.every(sample => Math.abs(sample.height-sample.layoutHeight*sample.visualScale) < 1),
        'composer height should follow the same readable-size floor');
    assert.ok(composerZoom.every(sample => Math.abs(sample.gap-20) < 1), 'composer should stay below its node during canvas zoom: '+JSON.stringify(composerZoom));
    assert.ok(composerZoom.every(sample => sample.nodeCenter >= sample.cardLeft && sample.nodeCenter <= sample.cardRight),
        'composer should stay near its selected node during canvas zoom');
    assert.ok(composerZoom.every(sample => Math.abs(sample.mentionLeft-composerZoom[0].mentionLeft) < 1
        && Math.abs(sample.mentionTop-composerZoom[0].mentionTop) < 1), 'mention picker should stay next to the caret during canvas zoom: '+JSON.stringify(composerZoom));
    const connectionVisibilityDuringViewportGestures = await page.evaluate(() => {
        const layer = world.querySelector('svg.connection-layer');
        shell.classList.add('panning');
        const duringPan = getComputedStyle(layer).visibility;
        shell.classList.remove('panning');
        shell.classList.add('canvas-zooming');
        const duringZoom = getComputedStyle(layer).visibility;
        shell.classList.remove('canvas-zooming');
        return {duringPan, duringZoom};
    });
    assert.deepEqual(connectionVisibilityDuringViewportGestures, {duringPan:'visible', duringZoom:'visible'});
    const stableDecorations = await page.evaluate(() => {
        const imageNode = createNode(180, 120, [{url:'/fixture.png',name:'fixture.png',kind:'image',natural_w:240,natural_h:180}], {select:true});
        const element = world.querySelector(`.image-node[data-id="${CSS.escape(imageNode.id)}"]`);
        const root = document.documentElement;
        const skin = root.getAttribute('data-studio-skin');
        const dark = root.classList.contains('studio-theme-dark');
        const read = () => [world, element, ...element.querySelectorAll('.smart-node-floating-menu,.node-resize-handle,.mini-x,.image-resolution-badge,.node-port')].map(el => {
            const style = getComputedStyle(el);
            return {visibility:style.visibility,shadow:style.boxShadow,filter:style.backdropFilter,pointer:style.pointerEvents};
        });
        const samples = ['minimal','warm','soft','dark'].map(theme => {
            root.setAttribute('data-studio-skin', theme === 'dark' ? 'minimal' : theme);
            root.classList.toggle('studio-theme-dark', theme === 'dark');
            viewport.scale = 1; applyViewport();
            const before = read();
            shell.classList.add('canvas-zooming');
            const during = read();
            viewport.scale = 0.9; applyViewport();
            const scaled = read();
            shell.classList.remove('canvas-zooming');
            return {theme,before,during,scaled,after:read()};
        });
        root.setAttribute('data-studio-skin',skin);
        root.classList.toggle('studio-theme-dark',dark);
        selectedId = null; updateComposer();
        viewport = {x:120,y:80,scale:1}; applyViewport();
        return samples;
    });
    for(const sample of stableDecorations) {
        assert.deepEqual(sample.during,sample.before,`${sample.theme}: zoom must not hide controls or switch shadows/filters`);
        assert.deepEqual(sample.scaled,sample.before,`${sample.theme}: crossing 1x must not switch filters`);
        assert.deepEqual(sample.after,sample.before,`${sample.theme}: stopping zoom must not flash decorations`);
    }
    const frameZoom = await page.evaluate(async () => {
        const before = {...viewport};
        for(let i=0;i<4;i++) shell.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,clientX:800,clientY:500,bubbles:true,cancelable:true}));
        const queued = {...viewport};
        await new Promise(requestAnimationFrame);
        const applied = {...viewport};
        for(let i=0;i<4;i++) await new Promise(requestAnimationFrame);
        const stopped = {...viewport};
        viewport = before; applyViewport();
        return {before,queued,applied,stopped};
    });
    assert.deepEqual(frameZoom.queued,frameZoom.before,'wheel bursts are batched into one frame');
    assert.ok(Math.abs(frameZoom.applied.scale-frameZoom.before.scale*Math.pow(1.04,4))<1e-10,'one frame applies the complete input');
    assert.deepEqual(frameZoom.stopped,frameZoom.applied,'no inertial zoom after wheel input ends');
    await page.waitForFunction(() => !viewportInteractionActive);
    const fineInput = await page.evaluate(async () => {
        const original = {...viewport};
        const wheel = (deltaY, deltaMode=0) => shell.dispatchEvent(new WheelEvent('wheel',{deltaY,deltaMode,clientX:800,clientY:500,bubbles:true,cancelable:true}));
        const frame = () => new Promise(requestAnimationFrame);
        wheel(-1); await frame();
        const fine = viewport.scale / original.scale;
        wheel(50000); await frame();
        const cappedOut = viewport.scale / (original.scale * fine);
        wheel(-3,1); await frame();
        const lineMode = viewport.scale / (original.scale * fine * cappedOut);
        const beforeCancel = {...viewport};
        wheel(-20); cancelViewportWheelAnimation(); await frame();
        const cancelled = JSON.stringify(viewport) === JSON.stringify(beforeCancel);
        const unchanged = {...viewport};
        wheel(0); queueViewportWheel({deltaY:Infinity,clientX:800,clientY:500}); await frame();
        const invalidIgnored = JSON.stringify(viewport) === JSON.stringify(unchanged);
        viewport = original; applyViewport();
        return {fine,cappedOut,lineMode,cancelled,invalidIgnored};
    });
    assert.ok(Math.abs(fineInput.fine-1.002)<1e-10,'trackpad-scale deltas remain fine-grained');
    assert.ok(Math.abs(fineInput.cappedOut-0.85)<1e-10,'large zoom-out input is capped');
    assert.ok(Math.abs(fineInput.lineMode-1.096)<1e-10,'line-mode wheel units are normalized');
    assert.ok(fineInput.cancelled,'a new viewport action cancels queued zoom');
    assert.ok(fineInput.invalidIgnored,'zero and invalid input leave the viewport unchanged');
    await page.waitForFunction(() => !viewportInteractionActive);
    await page.evaluate(() => {
        window.zoomSamples = [];
        window.zoomObserver = new ResizeObserver(() => window.zoomSamples.push('resize'));
        window.zoomObserver.observe(world.querySelector('.image-node'));
        window.zoomAnchor = screenToWorld({clientX:800, clientY:500});
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => { window.zoomSamples = []; });
    await page.mouse.move(800,500);
    await page.mouse.wheel(0,-500);
    await page.waitForFunction(() => viewportInteractionActive && viewport.scale > 1.05);
    const sampleZoom = () => page.evaluate(() => new Promise(resolve => {
        const samples = [];
        const sample = () => {
            const anchor = screenToWorld({clientX:800,clientY:500});
            samples.push(Math.hypot(anchor.x-window.zoomAnchor.x, anchor.y-window.zoomAnchor.y)*viewport.scale);
            if(viewportInteractionActive) requestAnimationFrame(sample);
            else resolve({drift:Math.max(...samples),resizes:window.zoomSamples.length});
        };
        requestAnimationFrame(sample);
    }));
    const zoomIn = await sampleZoom();
    assert.ok(Math.abs(await page.evaluate(()=>viewport.scale)-1.15)<1e-10,'large wheel deltas must not exceed a 15% step');
    assert.ok(zoomIn.drift < 0.1, 'zoom-in anchor drift: '+zoomIn.drift);
    assert.equal(zoomIn.resizes, 0);
    await page.waitForFunction(() => !viewportInteractionActive);
    await page.mouse.wheel(0,700);
    await page.waitForFunction(() => viewportInteractionActive && viewport.scale < 1);
    const zoomOut = await sampleZoom();
    assert.ok(zoomOut.drift < 0.1, 'zoom-out anchor drift: '+zoomOut.drift);
    assert.equal(zoomOut.resizes, 0);
    assert.equal(await page.evaluate(() => {
        const event = new WheelEvent('wheel', {deltaY:-10, ctrlKey:true, clientX:800, clientY:500, bubbles:true, cancelable:true});
        shell.dispatchEvent(event);
        return event.defaultPrevented;
    }), true);
    await page.waitForFunction(() => !viewportInteractionActive);
    await page.evaluate(() => {
        selectedId = window.zoomComposerNodeId;
        updateComposer();
        viewport = {x:120,y:80,scale:0.17};
        applyViewport();
        window.minimumZoomAnchor = screenToWorld({clientX:1500,clientY:850});
    });
    await page.waitForTimeout(220);
    await page.mouse.move(1500,850);
    for(let i=0;i<4;i++) await page.mouse.wheel(0,700);
    await page.waitForFunction(() => !viewportInteractionActive && viewport.scale < 0.1);
    const deepZoom = await page.evaluate(() => {
        const card = composer.getBoundingClientRect();
        const node = world.querySelector(`.image-node[data-id="${CSS.escape(window.zoomComposerNodeId)}"]`).getBoundingClientRect();
        const anchor = screenToWorld({clientX:1500,clientY:850});
        return {scale:viewport.scale, gap:card.top-node.bottom, nodeCenter:node.left+node.width/2,
            cardLeft:card.left, cardRight:card.right, cardWidth:card.width, layoutWidth:composer.offsetWidth,
            anchorDrift:Math.hypot(anchor.x-window.minimumZoomAnchor.x, anchor.y-window.minimumZoomAnchor.y)*viewport.scale};
    });
    assert.ok(Math.abs(deepZoom.gap-20) < 1, 'composer should remain below node during deep zoom-out');
    assert.ok(Math.abs(deepZoom.cardWidth-deepZoom.layoutWidth) < 1, 'composer should stop shrinking at its original readable size');
    assert.ok(deepZoom.anchorDrift < 0.1, 'deep zoom-out should preserve cursor anchor');
    assert.ok(deepZoom.nodeCenter >= deepZoom.cardLeft && deepZoom.nodeCenter <= deepZoom.cardRight,
        'composer should remain near selected node during deep zoom-out');
    const firstDeepScale = deepZoom.scale;
    await page.mouse.wheel(0,700);
    await page.waitForFunction(scale => !viewportInteractionActive && viewport.scale < scale, firstDeepScale);
    await page.evaluate(() => window.zoomObserver.disconnect());
    await pending.get('/api/config').fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',image_models:['fixture-image'],chat_models:['fixture-chat'],video_models:[]}],comfy_instances:[]}});
    pending.delete('/api/config');
    await page.waitForFunction(() => smartConfigReady);
    assert.equal(await page.evaluate(() => settings.model), 'fixture-image');
    for(const route of pending.values()) await route.fulfill({status:503,json:{}}).catch(()=>{});
    await page.waitForTimeout(200);
    assert.deepEqual(errors,[]);
});
