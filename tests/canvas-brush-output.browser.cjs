const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const sourceUrl = '/output/brush-source.png';
const outputUrl = '/output/brush-result.png';
const source = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#e6d5bb"/><rect x="300" width="300" height="800" fill="#9e8060"/></svg>';

async function fixture(t, {legacy=false, group=false, upload=false}={}){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    const dialogs = [];
    const state = {uploads:0, png:null, failure:'', release:null};
    let stored = {id:'brush-fixture',title:'Brush fixture',nodes:[],connections:[],logs:[],settings:{}};
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if(url.hostname !== 'canvas-brush.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/canvases/brush-fixture'){
            if(request.method() === 'PUT') stored = {...stored,...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(pathname === '/api/canvases') return route.fulfill({json:{canvases:[stored]}});
        if(pathname === '/api/ai/upload'){
            state.uploads++;
            if(state.failure === 'http') return route.fulfill({status:500,json:{detail:'上传暂时失败，请重试'}});
            if(state.failure === 'missing') return route.fulfill({json:{files:[]}});
            const multipart = request.postDataBuffer();
            const start = multipart.indexOf(Buffer.from('\x89PNG\r\n\x1a\n','latin1'));
            const end = multipart.indexOf(Buffer.from('IEND'),start) + 8;
            assert.ok(start >= 0 && end > start);
            state.png = multipart.subarray(start,end);
            if(state.failure === 'pending') await new Promise(resolve => {state.release = resolve;});
            return route.fulfill({json:{files:[{url:outputUrl,name:'source_paint.png',kind:'image',asset_ref_id:'asset_brush_result'}]}});
        }
        if(pathname === outputUrl && state.png) return route.fulfill({contentType:'image/png',body:state.png});
        if(pathname === sourceUrl || pathname === '/api/media-preview'){
            if(url.searchParams.get('url') === outputUrl && state.png) return route.fulfill({contentType:'image/png',body:state.png});
            return route.fulfill({contentType:'image/svg+xml',body:source});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });
    await page.goto(`http://canvas-brush.test/static/${legacy?'canvas':'smart-canvas'}.html?id=brush-fixture`);
    await page.waitForFunction(legacy ? () => canvas?.id === 'brush-fixture' : () => document.getElementById('smartTitle')?.textContent === 'Brush fixture');
    await page.evaluate(({legacy,group,upload}) => {
        const image = {url:'/output/brush-source.png',name:'source.png',kind:'image',asset_ref_id:'asset_original',
            originalLocalUrl:'/output/brush-source.png',localUrl:'/output/brush-source.png',sourceUrl:'/output/brush-source.png',
            natural_w:600,natural_h:800};
        let node;
        if(legacy){
            node = {id:'original',type:'image',x:100,y:100,w:300,h:400,...image};
            nodes.push(node);
        } else {
            node = createNode(100,100,group ? [image,{...image,name:'second.png'}] : [image],{nodeType:upload?'smart-upload':'smart-image'});
        }
        window.brushSourceId = node.id;
        window.brushSnapshot = n => ({id:n.id,type:n.type,x:n.x,y:n.y,images:(n.images || [n]).map(item => ({
            url:item.url,name:item.name,asset_ref_id:item.asset_ref_id,
            originalLocalUrl:item.originalLocalUrl,localUrl:item.localUrl,sourceUrl:item.sourceUrl,
            natural_w:item.natural_w,natural_h:item.natural_h
        }))});
        render();
        if(legacy) openImageEditor(node.id,'brush');
        else {openImageEditor(node.id,group?1:0);setImageEditMode('brush',true);}
    }, {legacy,group,upload});
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 600 && editDrawCanvas().width === 600 && cropState?.w > 0);
    await page.evaluate(() => {
        setBrushTool('rect');
        document.getElementById('paintBrushColor').value = '#ff0000';
        document.getElementById('paintBrushSize').value = '8';
    });
    const bounds = await page.locator('#editDrawCanvas').boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.7,{steps:8});
    await page.mouse.up();
    assert.equal(await page.evaluate(() => editCanvasHasPixels()),true,'rectangle tool produced marks');
    await page.evaluate(() => {window.brushSourceBefore = JSON.stringify(brushSnapshot(nodes.find(n => n.id === brushSourceId)));});
    return {page,errors,dialogs,state,stored:() => stored};
}

for(const options of [{},{group:true},{upload:true},{legacy:true}]){
    const label = options.legacy ? 'legacy canvas' : options.group ? 'image group' : options.upload ? 'upload node' : 'image node';
    test(`brush exports a separate image on the right and closes the editor: ${label}`, {timeout:40000}, async t => {
        const {page,errors,state,stored} = await fixture(t,options);
        const undoBefore = await page.evaluate(() => undoStack.length);
        await page.locator('#imageEditApplyBtn').click();
        await page.waitForFunction(() => !document.getElementById('imageEditModal').classList.contains('open'));
        assert.equal(state.uploads,1);
        assert.equal(state.png.readUInt32BE(16),600);
        assert.equal(state.png.readUInt32BE(20),800);
        const result = await page.evaluate(async legacy => {
            const original = nodes.find(n => n.id === brushSourceId);
            const output = nodes.find(n => n.id !== brushSourceId);
            const image = legacy ? output : output.images[0];
            const img = new Image();
            img.src = image.url;
            await img.decode();
            const pixels = document.createElement('canvas');
            pixels.width = img.naturalWidth; pixels.height = img.naturalHeight;
            const ctx = pixels.getContext('2d');
            ctx.drawImage(img,0,0);
            const pixel = (x,y) => Array.from(ctx.getImageData(x,y,1,1).data);
            return {
                original:brushSnapshot(original),before:JSON.parse(brushSourceBefore),
                count:nodes.length,output,image,
                originalRight:legacy ? original.x+original.w : nodeRect(original).x+nodeRect(original).width,
                undoCount:undoStack.length,background:pixel(1,1),mark:pixel(120,300)
            };
        },Boolean(options.legacy));
        assert.deepEqual(result.original,result.before);
        assert.equal(result.count,2);
        assert.ok(result.output.x > result.originalRight,'result is on the right of the entire source node');
        assert.equal(result.image.url,outputUrl);
        assert.equal(result.image.natural_w,600);
        assert.equal(result.image.natural_h,800);
        assert.equal(result.undoCount,undoBefore+1);
        assert.deepEqual(result.background,[230,213,187,255]);
        assert.deepEqual(result.mark,[255,0,0,255]);
        if(!options.legacy){
            assert.equal(result.image.asset_ref_id,'asset_brush_result');
            assert.equal(result.image.originalLocalUrl,undefined,'the result does not inherit the original preview URL');
        }
        await page.evaluate(() => {clearTimeout(saveTimer); return saveCanvas();});
        assert.equal(stored().nodes.length,2,'both images are saved');
        const restored = await page.evaluate(() => {
            performUndo();
            const afterUndo = nodes.length;
            const originalUnchanged = JSON.stringify(brushSnapshot(nodes.find(n => n.id === brushSourceId))) === brushSourceBefore;
            if(typeof performRedo !== 'function') return {afterUndo,originalUnchanged};
            performRedo();
            return {afterUndo,afterRedo:nodes.length,originalUnchanged};
        });
        assert.deepEqual(restored,options.legacy ? {afterUndo:1,originalUnchanged:true} : {afterUndo:1,afterRedo:2,originalUnchanged:true});
        if(!options.legacy && !options.group && !options.upload){
            const dir = path.join(os.tmpdir(),'xiaomei-brush-output-qa');
            fs.mkdirSync(dir,{recursive:true});
            await page.screenshot({path:path.join(dir,'separate-result.png')});
        }
        assert.deepEqual(errors,[]);
    });
}

test('brush keeps marks on export/upload failure, supports retry, and prevents duplicate submission', {timeout:40000}, async t => {
    const {page,errors,state} = await fixture(t);
    for(const failure of ['export','http','missing']){
        state.failure = failure;
        if(failure === 'export') await page.evaluate(() => {
            window.brushToBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function(callback){callback(null);};
        });
        await page.locator('#imageEditApplyBtn').click();
        await page.waitForFunction(() => document.getElementById('toast').textContent.includes('画笔保存失败') && !document.getElementById('imageEditApplyBtn').disabled);
        assert.deepEqual(await page.evaluate(() => ({open:document.getElementById('imageEditModal').classList.contains('open'),marks:editCanvasHasPixels(),count:nodes.length})),{open:true,marks:true,count:1});
        if(failure === 'export') await page.evaluate(() => {HTMLCanvasElement.prototype.toBlob = window.brushToBlob;});
    }
    state.failure = 'pending';
    const requestStarted = page.waitForRequest(request => request.url().endsWith('/api/ai/upload'));
    await page.locator('#imageEditApplyBtn').click();
    await requestStarted;
    assert.equal(await page.locator('#imageEditApplyBtn').isDisabled(),true);
    await page.evaluate(() => applyImageBrush());
    assert.equal(state.uploads,3,'only one pending retry is submitted');
    await page.evaluate(() => {clearTimeout(saveTimer); return saveCanvas();});
    state.release();
    await page.waitForFunction(() => !document.getElementById('imageEditModal').classList.contains('open'));
    assert.equal(await page.evaluate(() => nodes.length),2);
    assert.deepEqual(errors,[]);
});

test('finishing an upload after closing the brush editor does not change the canvas', {timeout:40000}, async t => {
    const {page,errors,state} = await fixture(t);
    state.failure = 'pending';
    const requestStarted = page.waitForRequest(request => request.url().endsWith('/api/ai/upload'));
    await page.locator('#imageEditApplyBtn').click();
    await requestStarted;
    await page.evaluate(() => closeImageEditor());
    state.release();
    await page.waitForFunction(() => !document.getElementById('imageEditApplyBtn').disabled);
    assert.equal(await page.evaluate(() => nodes.length),1);
    assert.deepEqual(errors,[]);
});
