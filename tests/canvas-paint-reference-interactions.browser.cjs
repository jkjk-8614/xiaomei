const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const names = ['wide', 'tall', 'square'];

async function fixture(t){
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(5000);
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
    return {page, errors, nodeId, stored:() => storedCanvas};
}

test('composer reference bar uses its available width and keeps only canvas selection', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    const selectButton = page.locator('#inputThumbsRow [data-reference-picker-node]');
    const setReferences = count => page.evaluate(count => {
        const node = selectedNode();
        const referenceNames = ['wide','tall','square'];
        node.y = 20;
        node.manualInputRefs = Array.from({length:count}, (_, index) => ({
            url:`/fixture-images/${referenceNames[index % referenceNames.length]}.png?ref=${index}`,
            name:`Reference ${index + 1}`, kind:'image', manualAdded:true
        }));
        delete node.inputRefOrder;
        render();
        updateComposer();
    }, count);
    const measure = () => page.locator('#inputThumbsRow').evaluate(row => {
        const list = row.querySelector('.input-thumb-list');
        const actions = row.querySelector('.input-thumb-actions').getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        const strip = list.getBoundingClientRect();
        return {
            clientWidth:list.clientWidth, scrollWidth:list.scrollWidth,
            contained:strip.left >= bounds.left - 1 && strip.right <= actions.left && actions.right <= bounds.right + 1,
            aligned:Math.abs((strip.top + strip.bottom - actions.top - actions.bottom) / 2) < 1,
            buttonCount:row.querySelectorAll('.input-thumb-actions button').length
        };
    });
    assert.equal(await page.locator('[data-input-add-reference], .input-thumb-add').count(), 0);
    for(const count of [0,1,2,18]){
        await setReferences(count);
        assert.equal(await page.locator('#inputThumbsRow .input-thumb').count(), count);
        const sample = await measure();
        assert.ok(sample.contained && sample.aligned, `aligned controls with ${count} references: ${JSON.stringify(sample)}`);
        assert.equal(sample.buttonCount, 1);
        if(count <= 2) assert.equal(sample.scrollWidth, sample.clientWidth, 'few references do not show a horizontal scrollbar');
        else assert.ok(sample.scrollWidth > sample.clientWidth, 'long reference lists remain scrollable');
    }
    await setReferences(2);
    assert.equal(await page.evaluate(() => {
        const first = inputThumbsRow.querySelector('.input-thumb');
        renderInputThumbsRow(selectedNode());
        return first === inputThumbsRow.querySelector('.input-thumb');
    }), true, 'unchanged references retain their thumbnail DOM');
    for(const width of [1000,420]){
        await page.setViewportSize({width,height:700});
        await page.evaluate(() => updateComposer());
        for(const theme of ['light','dark']){
            await page.evaluate(theme => applyTheme(theme), theme);
            const sample = await measure();
            assert.ok(sample.contained && sample.aligned, `${theme} reference controls fit at ${width}px`);
            assert.equal(sample.scrollWidth, sample.clientWidth, `${theme} two references fit at ${width}px`);
            const artifacts = path.join(os.tmpdir(), 'xiaomei-composer-layout-qa');
            fs.mkdirSync(artifacts, {recursive:true});
            await page.locator('#composer').screenshot({path:path.join(artifacts, `${theme}-${width}.png`)});
        }
    }
    await selectButton.click();
    await page.locator('.reference-picker-bar').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.reference-picker-bar').count(), 0);
    assert.equal(await page.locator('#inputThumbsRow .input-thumb').count(), 2);
    assert.deepEqual(errors, []);
    console.log(`Reference layout screenshots: ${path.join(os.tmpdir(), 'xiaomei-composer-layout-qa')}`);
});

test('paint references preview, reorder, submit and survive a canvas reload', { timeout: 40000 }, async t => {
    const {page, errors, nodeId, stored} = await fixture(t);
    const thumbs = page.locator('#inputThumbsRow .input-thumb');
    assert.deepEqual(await thumbs.evaluateAll(items => items.map(item => item.dataset.url.split('/').pop())), names.map(name => `${name}.png`));
    assert.deepEqual(await page.evaluate(() => sourceDimensionsForRun(selectedNode())), {w:400,h:200});

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
    assert.deepEqual(await page.evaluate(() => sourceDimensionsForRun(selectedNode())), {w:300,h:300});
    assert.equal(await page.locator('#smartLogLightbox.open').count(), 0, 'drag does not open the large preview');

    const request = await page.evaluate(async () => {
        const node = selectedNode();
        setPromptDraftForNode(node, '将图1中的产品放到图2的场景');
        const numberedPrompt = buildPromptRequestForNode(node).prompt;
        const refs = buildPromptRequest(node).refs;
        const original = XiaomeiImageTaskClient.createImageTask;
        let payload;
        XiaomeiImageTaskClient.createImageTask = async value => { payload = value; return {task_id:'fixture-task'}; };
        try { await runApiGeneration(numberedPrompt, refs, {provider_id:'fixture',model:'fixture-image',count:1}); }
        finally { XiaomeiImageTaskClient.createImageTask = original; }
        await saveCanvas();
        return {refs:refs.map(ref => ref.url), submitted:payload.reference_images.map(ref => ref.url), prompt:payload.prompt, stored:node.inputRefOrder};
    });
    const expected = ['square','wide','tall'].map(name => `/fixture-images/${name}.png`);
    assert.deepEqual(request.refs, expected);
    assert.deepEqual(request.submitted, expected);
    assert.match(request.prompt, /图1：square[\s\S]*图2：wide[\s\S]*图3：tall/);
    assert.equal(request.stored.length, 3);
    assert.deepEqual(stored().nodes.find(node => node.id === nodeId).inputRefOrder, request.stored);

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

test('zoomed reference previews use the space above the composer without covering canvas images', {timeout:40000}, async t => {
    const {page, errors, nodeId} = await fixture(t);
    await page.setViewportSize({width:1600,height:1000});
    await page.evaluate(id => {
        const node = nodes.find(item => item.id === id);
        node.images = [{url:'/fixture-images/tall.png',width:200,height:400}];
        nodes.push({id:'source',type:'smart-upload',x:node.x-480,y:node.y,images:[{url:'/fixture-images/tall.png',width:200,height:400}]});
        render();
    }, nodeId);
    for(const scale of [.7,1,1.6,2]){
        await page.mouse.move(5,990);
        await page.evaluate(({scale,id}) => {
            viewport.scale = scale;
            applyViewport();
            const rect = world.querySelector(`[data-id="${id}"]`).getBoundingClientRect();
            viewport.x += 920 - rect.left;
            viewport.y += 70 - rect.top;
            applyViewport();
            updateComposer();
        }, {scale,id:nodeId});
        const previewNames = await page.locator('#inputThumbsRow .input-thumb').evaluateAll(items => items.map(el => el.dataset.url.split('/').pop()));
        for(const [index,name] of previewNames.entries()){
            await page.locator('#inputThumbsRow .input-thumb').nth(index).hover();
            await page.waitForFunction(name => {
                const preview = document.querySelector('.paint-input-ref-hover');
                return preview && !preview.hidden && preview.querySelector('img').dataset.refUrl.includes(name);
            }, name, {timeout:5000});
            const sample = await page.evaluate(() => {
                const preview = document.querySelector('.paint-input-ref-hover').getBoundingClientRect();
                const card = composer.getBoundingClientRect();
                const overlaps = rect => preview.left < rect.right && preview.right > rect.left && preview.top < rect.bottom && preview.bottom > rect.top;
                return {preview:preview.toJSON(),card:card.toJSON(),covered:[...world.querySelectorAll('.image-node')].filter(el => overlaps(el.getBoundingClientRect())).map(el => el.dataset.id)};
            });
            assert.ok(sample.preview.bottom <= sample.card.top - 7, `preview stays above the editor at ${scale}x: ${JSON.stringify(sample)}`);
            assert.deepEqual(sample.covered, [], `preview leaves canvas images visible at ${scale}x`);
        }
    }
    const screenshot = path.join(os.tmpdir(),'xiaomei-reference-preview-fixed.png');
    await page.screenshot({path:screenshot});
    console.log(`Composer preview: ${screenshot}`);
    assert.deepEqual(errors, []);
});

test('reference dragging stays in its row and an outside release restores every thumbnail', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    await page.setViewportSize({width:1600,height:1200});
    const thumbs = page.locator('#inputThumbsRow .input-thumb');
    for(const scale of [1,1.6,2]){
        await page.evaluate(scale => {viewport.scale=scale; viewport.y=40-selectedNode().y*scale; applyViewport(); updateComposer();},scale);
        const original = await thumbs.evaluateAll(items => items.map(el => el.dataset.url));
        const source = await thumbs.nth(1).boundingBox();
        await page.mouse.move(source.x+source.width/2,source.y+source.height/2);
        await page.mouse.down();
        await page.mouse.move(20,100,{steps:8});
        const sample = await page.locator('.paint-ref-drag-ghost').evaluate(el => ({ghost:el.getBoundingClientRect().toJSON(),row:document.querySelector('.input-thumb-list').getBoundingClientRect().toJSON()}));
        assert.ok(sample.ghost.left >= sample.row.left-1 && sample.ghost.right <= sample.row.right+1 && Math.abs(sample.ghost.top-source.y)<2, `drag stays in the reference row at ${scale}x: ${JSON.stringify(sample)}`);
        assert.ok(Math.abs(sample.ghost.width-source.width)<1 && Math.abs(sample.ghost.height-source.height)<1, 'drag keeps its screen size');
        await page.mouse.up();
        await page.locator('.paint-ref-drag-ghost').waitFor({state:'detached'});
        assert.deepEqual(await thumbs.evaluateAll(items => items.map(el => el.dataset.url)),original);
        assert.equal(await thumbs.evaluateAll(items => items.every(el => getComputedStyle(el).visibility === 'visible')),true);
        assert.equal(await page.locator('body.smart-input-thumb-drag').count(),0);
        assert.equal(await page.locator('#smartLogLightbox.open').count(),0);
        const first = await thumbs.first().boundingBox();
        const last = await thumbs.last().boundingBox();
        await page.mouse.move(last.x+last.width/2,last.y+last.height/2);
        await page.mouse.down();
        await page.mouse.move(first.x+2,first.y+first.height/2,{steps:8});
        await page.mouse.up();
        const settling = await page.locator('#inputThumbsRow .paint-ref-drag-source').evaluateAll(items => items.map(el => el.dataset.url));
        assert.ok(settling.every(url => url === original.at(-1)), 'the return animation targets the dragged reference');
        await page.locator('.paint-ref-drag-ghost').waitFor({state:'detached'});
        const expected = [original.at(-1), ...original.slice(0,-1)];
        assert.deepEqual(await thumbs.evaluateAll(items => items.map(el => el.dataset.url)),expected, `sorting works at ${scale}x`);
        assert.deepEqual(await page.evaluate(() => buildPromptRequest(selectedNode()).refs.map(ref => ref.url)),expected);
    }
    assert.deepEqual(errors, []);
});

test('interrupted reference sorting clears the ghost and restores the previous order', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    const thumbs = page.locator('#inputThumbsRow .input-thumb');
    const original = await thumbs.evaluateAll(items => items.map(el => el.dataset.url));
    for(const interruption of ['Escape','pointercancel','lostpointercapture','blur','render','zoom']){
        const first = await thumbs.first().boundingBox();
        const third = await thumbs.nth(2).boundingBox();
        await page.mouse.move(third.x+third.width/2,third.y+third.height/2);
        await page.mouse.down();
        await page.mouse.move(first.x+2,first.y+first.height/2,{steps:8});
        await page.locator('.paint-ref-drag-ghost').waitFor({state:'visible'});
        if(interruption === 'Escape') await page.keyboard.press('Escape');
        else await page.evaluate(kind => {
            if(kind === 'blur') window.dispatchEvent(new Event('blur'));
            else if(kind === 'render') render();
            else if(kind === 'zoom'){viewport.scale=.9;applyViewport();}
            else document.querySelector('.input-thumb-list').dispatchEvent(new PointerEvent(kind,{pointerId:1,bubbles:true}));
        },interruption);
        await page.locator('.paint-ref-drag-ghost').waitFor({state:'detached',timeout:2000});
        await page.mouse.up();
        assert.deepEqual(await thumbs.evaluateAll(items => items.map(el => el.dataset.url)),original, interruption);
        assert.equal(await thumbs.evaluateAll(items => items.every(el => getComputedStyle(el).visibility === 'visible')),true,interruption);
        assert.equal(await page.locator('body.smart-input-thumb-drag').count(),0,interruption);
        assert.equal(await page.locator('#smartLogLightbox.open').count(),0,interruption);
    }
    assert.deepEqual(errors, []);
});
