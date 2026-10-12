const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const names = ['wide', 'tall', 'square'];

test('paint references preview, reorder, submit and survive a canvas reload', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    let storedCanvas = { id:'paint-refs', title:'Paint references', nodes:[], connections:[], logs:[], settings:{engine:'api',provider_id:'fixture',model:'fixture-image',count:1} };
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if(url.hostname !== 'xiaomei-paint-ref.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path:file }) : route.fulfill({ status:404, body:'' });
        }
        if(pathname.startsWith('/fixture-images/') || pathname.includes('media-preview')){
            const source = decodeURIComponent(url.href);
            const [width,height] = source.includes('wide') ? [400,200] : source.includes('tall') ? [200,400] : [300,300];
            return route.fulfill({ contentType:'image/svg+xml', body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#30a9b3"/></svg>` });
        }
        if(pathname === '/api/config') return route.fulfill({ json:{ api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',image_models:['fixture-image'],chat_models:[],video_models:[]}], comfy_instances:[] } });
        if(pathname === '/api/canvases/paint-refs'){
            if(request.method() === 'PUT'){
                storedCanvas = { ...storedCanvas, ...request.postDataJSON(), id:'paint-refs', updated_at:Date.now() };
            }
            return route.fulfill({ json:{ canvas:storedCanvas } });
        }
        return route.fulfill({ json:{ skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[] } });
    });
    await page.goto('http://xiaomei-paint-ref.test/static/smart-canvas.html?id=paint-refs');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Paint references');
    const nodeId = await page.evaluate(() => {
        const node = createPaintNodeAt({x:500,y:250});
        node.manualInputRefs = ['wide','tall','square'].map(name => ({url:`/fixture-images/${name}.png`,name,kind:'image',manualAdded:true}));
        render();
        updateComposer();
        return node.id;
    });
    const thumbs = page.locator('#inputThumbsRow .input-thumb');
    assert.deepEqual(await thumbs.evaluateAll(items => items.map(item => item.dataset.url.split('/').pop())), names.map(name => `${name}.png`));

    await thumbs.nth(1).hover();
    await page.locator('.paint-input-ref-hover img').waitFor({state:'visible'});
    const hover = await page.locator('.paint-input-ref-hover img').evaluate(img => {
        const rect = img.getBoundingClientRect();
        return {ratio:rect.width/rect.height, left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom};
    });
    assert.ok(Math.abs(hover.ratio - .5) < .01, 'portrait preview keeps its ratio');
    assert.ok(hover.left >= 0 && hover.top >= 0 && hover.right <= 1000 && hover.bottom <= 700, 'hover preview stays in the viewport');
    for(const [index, ratio] of [[0,2],[2,1]]){
        await thumbs.nth(index).hover();
        await page.waitForFunction(([name, expected]) => {
            const img = document.querySelector('.paint-input-ref-hover img');
            if(!img?.dataset.refUrl?.includes(name)) return false;
            const rect = img.getBoundingClientRect();
            return Math.abs(rect.width / rect.height - expected) < .01;
        }, [names[index], ratio]);
        const actual = await page.locator('.paint-input-ref-hover img').evaluate(img => img.getBoundingClientRect().width / img.getBoundingClientRect().height);
        assert.ok(Math.abs(actual - ratio) < .01, `${names[index]} preview keeps its ratio`);
    }
    await page.mouse.move(5, 5);
    await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});

    await thumbs.nth(1).click();
    await page.locator('#smartLogLightbox.open').waitFor({state:'visible'});
    assert.ok((await page.locator('#smartLogLightbox img').getAttribute('src')).includes('tall.png'));
    await page.keyboard.press('Escape');
    await page.locator('#smartLogLightbox.open').waitFor({state:'hidden'});
    await thumbs.nth(1).click();
    await page.locator('#smartLogLightbox.open').waitFor({state:'visible'});
    await page.locator('#smartLogLightbox').click({position:{x:5,y:5}});
    await page.locator('#smartLogLightbox.open').waitFor({state:'hidden'});

    const third = await thumbs.nth(2).boundingBox();
    const first = await thumbs.nth(0).boundingBox();
    await page.mouse.move(third.x + third.width/2, third.y + third.height/2);
    await page.mouse.down();
    await page.mouse.move(first.x + 2, first.y + first.height/2, {steps:8});
    assert.equal(await page.locator('.paint-ref-drag-ghost').count(), 1, 'dragged image stays visible');
    assert.equal(await page.locator('.input-thumb').evaluateAll(items => items.some(item => item.getAnimations().length > 0)), true, 'other images animate into place');
    await page.mouse.up();
    await page.waitForFunction(() => [...document.querySelectorAll('#inputThumbsRow .input-thumb')].map(item => item.dataset.url).join('|').includes('square.png|/fixture-images/wide.png'));
    assert.deepEqual(await thumbs.evaluateAll(items => items.map(item => item.dataset.url.split('/').pop())), ['square.png','wide.png','tall.png']);
    assert.deepEqual(await page.locator('#inputThumbsRow .input-thumb-label').allTextContents(), ['图1','图2','图3']);
    assert.equal(await page.locator('#smartLogLightbox.open').count(), 0, 'drag does not open the large preview');

    const request = await page.evaluate(async () => {
        const node = selectedNode();
        const refs = buildPromptRequest(node).refs;
        const original = XiaomeiImageTaskClient.createImageTask;
        let payload;
        XiaomeiImageTaskClient.createImageTask = async value => { payload = value; return {task_id:'fixture-task'}; };
        try { await runApiGeneration('fixture prompt', refs, {provider_id:'fixture',model:'fixture-image',count:1}); }
        finally { XiaomeiImageTaskClient.createImageTask = original; }
        await saveCanvas();
        return {refs:refs.map(ref => ref.url), submitted:payload.reference_images.map(ref => ref.url), stored:node.inputRefOrder};
    });
    const expected = ['square','wide','tall'].map(name => `/fixture-images/${name}.png`);
    assert.deepEqual(request.refs, expected);
    assert.deepEqual(request.submitted, expected);
    assert.equal(request.stored.length, 3);
    assert.deepEqual(storedCanvas.nodes.find(node => node.id === nodeId).inputRefOrder, request.stored);

    await page.reload();
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Paint references');
    const restored = await page.evaluate(id => {
        const node = nodes.find(item => item.id === id);
        selectedId = id;
        updateComposer();
        return {refs:buildPromptRequest(node).refs.map(ref => ref.url),order:node.inputRefOrder};
    }, nodeId);
    assert.deepEqual(restored.refs, expected);
    assert.deepEqual(restored.order, request.stored);
    assert.deepEqual(errors, []);
});
