const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const originalUrls = ['A','B','C'].map(name => `/fixture-images/${name}.png`);

async function fixture(t, type='smart-agent'){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1200, height:800}});
    page.setDefaultTimeout(8000);
    const errors = [], calls = [];
    let stored = {id:'refs', title:'Node references', nodes:[], connections:[], logs:[], settings:{}};
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'node-refs.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/fixture-images/')){
            const name = path.basename(url.pathname, '.png');
            const [width,height,color] = name === 'A' ? [900,300,'#f2b86b'] : name === 'B' ? [300,900,'#74b5af'] : [600,600,'#a1add2'];
            return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-size="120" fill="#243040">${name}</text></svg>`});
        }
        if(url.pathname === '/api/canvases/refs'){
            if(request.method() === 'PUT') stored = {...stored, ...request.postDataJSON(), updated_at:Date.now()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname === '/api/canvas-llm'){
            calls.push(request.postDataJSON());
            return route.fulfill({json:{text:'已按参考图顺序分析。'}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',chat_models:['fixture-chat'],image_models:['fixture-image'],video_models:[]}],comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://node-refs.test/static/smart-canvas.html?id=refs');
    await page.waitForFunction(() => canvas?.id === 'refs');
    await page.evaluate(({type, urls}) => {
        nodes = [
            {id:'source',type:'smart-upload',x:-1000,y:150,images:urls.map((url,index) => ({url,name:['A','B','C'][index],kind:'image'}))},
            {id:'target',type,x:180,y:120,w:460,h:550,images:[],userPrompt:'按图1、图2、图3分析',text:'按图1、图2、图3分析',llmInstruction:'分析每张参考图',agentProvider:'fixture',agentModel:'fixture-chat'},
            {id:'downstream',type:'smart-paint',x:760,y:160,w:260,h:300,images:[]}
        ];
        canvas.connections = [{from:'source',to:'target',kind:'input'},{from:'target',to:'downstream',kind:'input'}];
        canvasUsesConnections = true;
        selectedId = ''; selectedIds = [];
        viewport = {x:0,y:0,scale:1};
        applyViewport(); render();
    }, {type,urls:originalUrls});
    return {page,calls,stored:() => stored};
}

const thumbsFor = page => page.locator('[data-id="target"] .smart-node-input-thumb');
const displayedUrls = page => thumbsFor(page).evaluateAll(elements => elements.map(el => el.dataset.inputPreviewUrl));

async function dragBefore(page, fromIndex, toIndex){
    const thumbs = thumbsFor(page);
    const from = await thumbs.nth(fromIndex).boundingBox();
    const to = await thumbs.nth(toIndex).boundingBox();
    await page.mouse.move(from.x + from.width/2, from.y + from.height/2);
    await page.mouse.down();
    await page.mouse.move(to.x + 2, to.y + to.height/2, {steps:8});
    assert.equal(await page.locator('.paint-ref-drag-ghost').count(),1,'the dragged image is visible');
    assert.equal(await thumbs.evaluateAll(elements => elements.some(el => el.getAnimations().length > 0)),true,'other images animate into their new positions');
    const ghost = await page.locator('.paint-ref-drag-ghost').boundingBox();
    assert.ok(Math.abs(ghost.width - from.width) < 1 && Math.abs(ghost.height - from.height) < 1,'dragged image keeps its screen size');
    await page.mouse.up();
    await page.locator('.paint-ref-drag-ghost').waitFor({state:'detached'});
    assert.equal(await page.locator('#smartLogLightbox.open').count(),0,'sorting does not open the image viewer');
}

test('Agent sorting persists C,A,B and submits the same order to the model and downstream generation', {timeout:40000}, async t => {
    const {page,calls,stored} = await fixture(t);
    const before = await page.evaluate(() => nodes.map(node => ({id:node.id,x:node.x,y:node.y,images:node.images.map(image => ({url:image.url,name:image.name,kind:image.kind}))})));
    await dragBefore(page,2,0);
    const expected = [originalUrls[2],originalUrls[0],originalUrls[1]];
    assert.deepEqual(await displayedUrls(page),expected);
    assert.deepEqual(await thumbsFor(page).locator('.smart-node-input-badge').allTextContents(),['图1','图2','图3']);
    assert.deepEqual(await page.evaluate(() => nodes.map(node => ({id:node.id,x:node.x,y:node.y,images:node.images.map(image => ({url:image.url,name:image.name,kind:image.kind}))}))),before,'sorting references never moves nodes or changes the source images');
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'target').inputRefOrder),['source|2','source|0','source|1']);
    assert.equal((await page.evaluate(() => runAgentNode('target'))).ok,true);
    assert.deepEqual(calls.at(-1).images,expected,'the actual canvas-llm HTTP body follows the displayed order');
    const generationOrder = await page.evaluate(async () => {
        const node = nodes.find(node => node.id === 'downstream');
        selectedId = node.id; updateComposer();
        const request = buildPromptRequest(node);
        const original = XiaomeiImageTaskClient.createImageTask;
        let payload;
        XiaomeiImageTaskClient.createImageTask = async value => { payload = value; return {task_id:'fixture-image-task'}; };
        try { await runApiGeneration('参考图改图',request.refs,{provider_id:'fixture',model:'fixture-image',count:1}); }
        finally { XiaomeiImageTaskClient.createImageTask = original; }
        await saveCanvas();
        return payload.reference_images.map(item => item.url);
    });
    assert.deepEqual(generationOrder,expected,'Agent reference order is preserved when passed to an image model');
    assert.deepEqual(stored().nodes.find(node => node.id === 'target').inputRefOrder,['source|2','source|0','source|1']);
    await page.reload();
    await page.waitForFunction(() => nodes?.some(node => node.id === 'target'));
    assert.deepEqual(await displayedUrls(page),expected,'the order survives reopening the canvas');
    assert.equal((await page.evaluate(() => runAgentNode('target'))).ok,true);
    assert.deepEqual(calls.at(-1).images,expected);
});

test('clicking a reference opens the full image; small pointer movement is a click and single references never drag the node', {timeout:40000}, async t => {
    const {page} = await fixture(t);
    for(const [index,ratio] of [[0,3],[1,1/3],[2,1]]){
        const thumb = thumbsFor(page).nth(index);
        await thumb.hover();
        await page.locator('.paint-input-ref-hover').waitFor({state:'visible'});
        await thumb.click();
        const image = page.locator('#smartLogLightbox.open img');
        await image.waitFor({state:'visible'});
        await page.waitForFunction(() => document.querySelector('#smartLogLightbox img').naturalWidth > 0);
        const actualRatio = await image.evaluate(el => {const rect=el.getBoundingClientRect();return rect.width/rect.height;});
        assert.ok(Math.abs(actualRatio - ratio) < .01);
        assert.equal(await page.locator('.paint-input-ref-hover').isVisible(),false);
        if(index === 1) await page.locator('#smartLogLightbox').click({position:{x:5,y:5}});
        else await page.keyboard.press('Escape');
        await page.locator('#smartLogLightbox').waitFor({state:'hidden'});
    }
    const rect = await thumbsFor(page).first().boundingBox();
    await page.mouse.move(rect.x+20,rect.y+20);
    await page.mouse.down();
    await page.mouse.move(rect.x+22,rect.y+21);
    assert.equal(await page.locator('.paint-ref-drag-ghost').count(),0,'small pointer movement does not start a drag');
    await page.mouse.up();
    await page.locator('#smartLogLightbox.open').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await page.evaluate(() => {nodes.find(node => node.id === 'source').images.splice(1);render();});
    await thumbsFor(page).first().click();
    assert.equal(await page.evaluate(() => dragState),null,'clicking a single reference does not start moving the node');
    assert.deepEqual(await page.evaluate(() => {const node=nodes.find(node=>node.id==='target');return {x:node.x,y:node.y};}),{x:180,y:120});
});

test('manual references remain available, more than ten images form one scrollable row, and deletion matches the model input', {timeout:40000}, async t => {
    const {page,calls} = await fixture(t);
    await page.evaluate(() => {
        selectedId = 'target'; updateComposer();
        for(let index=4;index<=13;index++) addManualReferenceToSelectedNode({url:`/fixture-images/${index}.png`,name:`Manual ${index}`,kind:'image'});
    });
    assert.equal(await thumbsFor(page).count(),13,'all references are available for ordering');
    const row = await page.locator('[data-id="target"] .smart-node-input-thumbs').evaluate(el => ({
        tops:[...el.children].map(child => child.offsetTop),overflow:getComputedStyle(el).overflowX,scrollWidth:el.scrollWidth,width:el.clientWidth
    }));
    assert.equal(new Set(row.tops).size,1,'thumbnails occupy a single row');
    assert.equal(row.overflow,'auto');
    assert.ok(row.scrollWidth > row.width);
    await thumbsFor(page).nth(3).hover();
    await thumbsFor(page).nth(3).locator('.smart-node-input-remove').click();
    assert.equal(await thumbsFor(page).count(),12);
    assert.deepEqual(await page.evaluate(() => nodes.find(node=>node.id==='source').images.map(image=>image.url)),originalUrls,'deleting a reference retains its original source');
    assert.equal((await page.evaluate(() => runAgentNode('target'))).ok,true);
    assert.deepEqual(calls.at(-1).images,await displayedUrls(page));
    assert.ok(!calls.at(-1).images.includes('/fixture-images/4.png'));
    assert.deepEqual(await thumbsFor(page).locator('.smart-node-input-badge').allTextContents(),Array.from({length:12},(_,index)=>`图${index+1}`));
});

test('Prompt references share smooth sorting and model input order; sorting supports canvas zoom and undo', {timeout:40000}, async t => {
    const {page,calls} = await fixture(t,'smart-prompt');
    for(const scale of [.55,1.5]){
        await page.evaluate(scale => {viewport.scale=scale;applyViewport();},scale);
        await dragBefore(page,2,0);
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Control+z');
        assert.deepEqual(await displayedUrls(page),originalUrls,'undo restores reference order');
        await dragBefore(page,2,0);
        assert.equal((await page.evaluate(() => runPromptLLMNode('target'))).ok,true);
        assert.deepEqual(calls.at(-1).images,await displayedUrls(page));
        await page.evaluate(() => {delete nodes.find(node=>node.id==='target').inputRefOrder;render();});
    }
    await page.evaluate(() => {viewport.scale=1;applyViewport();});
    const artifacts = path.join(os.tmpdir(),'xiaomei-node-reference-preview');
    fs.mkdirSync(artifacts,{recursive:true});
    await page.screenshot({path:path.join(artifacts,'references.png')});
    console.log(`Preview image: ${path.join(artifacts,'references.png')}`);
});
