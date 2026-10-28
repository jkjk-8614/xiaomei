const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge',headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let stored = {id:'render-refs',title:'Render references',nodes:[],connections:[],logs:[],settings:{}};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'render-refs.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/fixture-images/') || url.pathname.includes('media-preview')){
            return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#80b5c6"/></svg>'});
        }
        if(url.pathname === '/api/canvases/render-refs'){
            if(request.method() === 'PUT') stored = {...stored,...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',image_models:['fixture-image']}],comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://render-refs.test/static/smart-canvas.html?id=render-refs');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'render-refs');
    await page.evaluate(() => {
        const image = name => ({url:`/fixture-images/${name}.png`,name,kind:'image',natural_w:320,natural_h:240});
        nodes = [
            {id:'product',type:'smart-upload',x:80,y:120,w:300,h:260,images:[image('caster')]},
            {id:'style',type:'smart-upload',x:80,y:470,w:300,h:260,images:[image('scene')]},
            {id:'batch',type:'smart-upload',x:440,y:470,w:260,h:260,images:[image('extra-1'),image('extra-2')]},
            {id:'target',type:'smart-ai-render',x:800,y:120,w:480,h:470,images:[],aiRender:{provider:'fixture',model:'fixture-image'}},
            {id:'other',type:'smart-paint',x:1600,y:-600,w:260,h:260,images:[]}
        ];
        canvas.connections = [{from:'product',to:'other',kind:'input'},{from:'style',to:'other',kind:'input'}];
        canvasUsesConnections = true;
        selectedId = ''; selectedIds = [];
        viewport = {x:0,y:0,scale:1}; applyViewport(); render();
        undoStack.length = 0; redoStack.length = 0;
    });
    return page;
}

async function chooseRole(page, role, source, index=0){
    await page.locator(`[data-id="target"] [data-ai-render-picker="${role}"]`).click();
    await page.locator(`[data-id="${source}"] .image-wrap[data-image-index="${index}"],[data-id="${source}"] .thumb-item[data-image-index="${index}"]`).first().click();
    await page.locator('[data-reference-picker-done]').click();
}
const groups = page => page.evaluate(() => Object.fromEntries(Object.entries(smartAiRenderInputGroups(nodes.find(node => node.id === 'target'))).map(([role,refs]) => [role,refs.map(ref => ref.name)])));
const positions = page => page.evaluate(() => nodes.map(({id,x,y}) => ({id,x,y})));

async function eraseLine(page, selector){
    const point = await page.locator(selector).evaluate(path => {
        const p = path.getPointAtLength(path.getTotalLength() * .72), m = path.getScreenCTM();
        return {x:m.a*p.x+m.c*p.y+m.e,y:m.b*p.x+m.d*p.y+m.f};
    });
    await page.keyboard.down('Control');
    await page.mouse.move(point.x,point.y-20);
    await page.mouse.down({button:'right'});
    await page.mouse.move(point.x,point.y+20,{steps:6});
    const hits = await page.evaluate(point => ({point,indices:[...(connectionEraseState?.indices || [])],paths:connectionEraseState?.geometryCache?.paths.map(({indices,minX,maxX,minY,maxY}) => ({indices,minX,maxX,minY,maxY}))}),point);
    await page.mouse.up({button:'right'});
    await page.keyboard.up('Control');
    return hits;
}

test('product then style selection keeps connected images in their chosen slots and at their canvas positions', {timeout:40000}, async t => {
    const page = await fixture(t), before = await positions(page);
    await chooseRole(page,'product','product');
    assert.deepEqual(await groups(page),{white:[],style:[],product:['caster']});
    await chooseRole(page,'style','style');
    assert.deepEqual(await groups(page),{white:[],style:['scene'],product:['caster']});
    await chooseRole(page,'product','batch',1);
    assert.deepEqual(await groups(page),{white:[],style:['scene'],product:['caster','extra-2']});
    assert.deepEqual(await positions(page),before);
    const preview = path.join(require('node:os').tmpdir(),'xiaomei-link-repro','fixed-slots.png');
    fs.mkdirSync(path.dirname(preview),{recursive:true});
    await page.screenshot({path:preview});
    console.log(`Fixed slot preview: ${preview}`);
    const payload = await page.evaluate(() => buildPromptRequestForNode(nodes.find(node => node.id === 'target'),null).refs.map(ref => [ref.name,ref.role]));
    assert.deepEqual(payload,[['scene','style'],['caster','product'],['extra-2','product']]);
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes?.some(node => node.id === 'target'));
    assert.deepEqual(await groups(page),{white:[],style:['scene'],product:['caster','extra-2']});
    assert.deepEqual(await positions(page),before);
});

test('Ctrl and right drag erases picker references, preserves other module connections and supports undo', {timeout:40000}, async t => {
    const page = await fixture(t), before = await positions(page);
    assert.deepEqual(await page.evaluate(() => connectionIndicesFromSpec('')),[],'an empty hit must not select formal connection zero');
    await chooseRole(page,'product','product');
    await page.waitForFunction(() => document.querySelector('.conn-reference .conn-line'));
    const hits = await eraseLine(page,'.conn-reference .conn-line');
    assert.deepEqual(await groups(page),{white:[],style:[],product:[]});
    assert.equal(await page.locator('.conn-reference').count(),0);
    assert.deepEqual(await page.evaluate(() => canvas.connections),[{from:'product',to:'other',kind:'input'},{from:'style',to:'other',kind:'input'}],JSON.stringify(hits));
    assert.deepEqual(await positions(page),before);
    await page.evaluate(() => performUndo());
    assert.deepEqual(await groups(page),{white:[],style:[],product:['caster']});
    await page.evaluate(() => performRedo());
    assert.deepEqual(await groups(page),{white:[],style:[],product:[]});
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes?.some(node => node.id === 'target'));
    assert.deepEqual(await groups(page),{white:[],style:[],product:[]});
});

test('continuous slot selection keeps its role after removing a choice and rejects extra style images', {timeout:40000}, async t => {
    const page = await fixture(t);
    await chooseRole(page,'product','product');
    await page.locator('[data-id="target"] [data-ai-render-picker="style"]').click();
    const first = page.locator('[data-id="batch"] .thumb-item[data-image-index="0"]');
    const second = page.locator('[data-id="batch"] .thumb-item[data-image-index="1"]');
    await first.click(); await second.click();
    assert.match(await page.locator('[data-picker-hint]').textContent(),/风格参考最多选择 1/);
    assert.deepEqual(await groups(page),{white:[],style:['extra-1'],product:['caster']});
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'target').manualInputRefs.length),2,'rejected images are not stored as hidden references');
    await first.click(); await second.click();
    await page.locator('[data-reference-picker-done]').click();
    assert.deepEqual(await groups(page),{white:[],style:['extra-2'],product:['caster']});
    await page.evaluate(() => performUndo());
    assert.deepEqual(await groups(page),{white:[],style:[],product:['caster']});
    await page.evaluate(() => performRedo());
    await chooseRole(page,'white','style');
    assert.deepEqual(await groups(page),{white:['scene'],style:['extra-2'],product:['caster']});
    for(const role of ['white','style','product']){
        assert.equal(await page.locator(`.conn-reference[data-conn-input-slot="${role}"]`).count(),1,'each reference line ends at its assigned slot');
    }
});

test('switching directly between Add buttons retains each active selection slot', {timeout:40000}, async t => {
    const page = await fixture(t), before = await positions(page);
    for(const [role,source] of [['product','product'],['style','style'],['white','batch']]){
        await page.locator(`[data-id="target"] [data-ai-render-picker="${role}"]`).click();
        await page.locator(`[data-id="${source}"] .image-wrap[data-image-index="0"],[data-id="${source}"] .thumb-item[data-image-index="0"]`).first().click();
    }
    await page.locator('[data-reference-picker-done]').click();
    assert.deepEqual(await groups(page),{white:['extra-1'],style:['scene'],product:['caster']});
    assert.deepEqual(await positions(page),before);
});

test('zoomed picker-line erasure removes all chosen images on that line for image, Prompt and Agent nodes', {timeout:60000}, async t => {
    const page = await fixture(t);
    for(const [type,scale] of [['smart-paint',.65],['smart-prompt',1],['smart-agent',.8]]){
        await page.evaluate(({type,scale}) => {
            const target = nodes.find(node => node.id === 'target');
            target.type = type; target.x = 1000;
            delete target.manualInputRefs; delete target.blockedInputRefs; delete target.inputRefOrder;
            nodes.find(node => node.id === 'batch').x = 80;
            nodes.find(node => node.id === 'batch').y = 120;
            nodes.find(node => node.id === 'product').x = -2000;
            nodes.find(node => node.id === 'style').x = -2000;
            viewport = {x:0,y:0,scale}; applyViewport(); render(); startNodeReferencePicker(target.id);
        },{type,scale});
        const before = await positions(page);
        for(const index of [0,1]) await page.locator(`[data-id="batch"] .thumb-item[data-image-index="${index}"]`).click();
        await page.locator('[data-reference-picker-done]').click();
        await page.waitForFunction(() => document.querySelectorAll('.conn-reference').length === 1);
        await eraseLine(page,'.conn-reference .conn-line');
        assert.deepEqual(await page.evaluate(() => nodeReferencePickerImages(nodes.find(node => node.id === 'target')).map(ref => ref.url)),[],type);
        assert.deepEqual(await positions(page),before);
        await page.evaluate(() => performUndo());
        assert.equal(await page.evaluate(() => nodeReferencePickerImages(nodes.find(node => node.id === 'target')).length),2,type);
    }
});
