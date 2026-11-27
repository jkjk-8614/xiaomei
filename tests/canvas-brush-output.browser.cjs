const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const sourceUrl = '/output/brush-source.png';
const outputUrl = '/output/brush-result.png';
const otherUrl = '/output/brush-other.png';
const source = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#e6d5bb"/><rect x="300" width="300" height="800" fill="#9e8060"/></svg>';

async function fixture(t, {legacy=false, group=false, upload=false, different=false, paint=false}={}){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    const dialogs = [];
    const state = {uploads:0, png:null, parts:[], failure:'', release:null};
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
            const signature = Buffer.from('\x89PNG\r\n\x1a\n','latin1');
            state.parts = [];
            let offset = 0;
            for(let start; (start = multipart.indexOf(signature,offset)) >= 0;){
                const end = multipart.indexOf(Buffer.from('IEND'),start) + 8;
                assert.ok(end > start);
                const name = multipart.subarray(offset,start).toString('utf8').match(/filename="([^"]+)"/)?.[1];
                const url = state.parts.length ? outputUrl.replace('.png','-' + state.parts.length + '.png') : outputUrl;
                state.parts.push({name, url, png:multipart.subarray(start,end)});
                offset = end;
            }
            assert.ok(state.parts.length);
            state.png = state.parts[0].png;
            if(state.failure === 'pending') await new Promise(resolve => {state.release = resolve;});
            const parts = state.failure === 'partial' ? state.parts.slice(0,1) : state.parts;
            return route.fulfill({json:{files:parts.map(({url,name}) => ({url,name,kind:'image',asset_ref_id:'asset_brush_result'}))}});
        }
        const part = state.parts.find(item => item.url === pathname);
        if(part) return route.fulfill({contentType:'image/png',body:part.png});
        if(pathname === otherUrl) return route.fulfill({contentType:'image/svg+xml',body:
            '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#0088cc"/></svg>'});
        if(pathname === sourceUrl || pathname === '/api/media-preview'){
            if(url.searchParams.get('url') === outputUrl && state.png) return route.fulfill({contentType:'image/png',body:state.png});
            return route.fulfill({contentType:'image/svg+xml',body:source});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });
    await page.goto(`http://canvas-brush.test/static/${legacy?'canvas':'smart-canvas'}.html?id=brush-fixture`);
    await page.waitForFunction(legacy ? () => canvas?.id === 'brush-fixture' : () => document.getElementById('smartTitle')?.textContent === 'Brush fixture');
    const sourceId = await page.evaluate(({legacy,group,upload,secondUrl,paint}) => {
        const image = {url:'/output/brush-source.png',name:'source.png',kind:'image',asset_ref_id:'asset_original',
            originalLocalUrl:'/output/brush-source.png',localUrl:'/output/brush-source.png',sourceUrl:'/output/brush-source.png',
            natural_w:600,natural_h:800};
        let node;
        if(legacy){
            node = {id:'original',type:'image',x:100,y:100,w:300,h:400,...image};
            nodes.push(node);
        } else {
            const second = {...image,name:'second.png'};
            if(secondUrl) for(const field of ['url','originalLocalUrl','localUrl','sourceUrl']) second[field] = secondUrl;
            const nodeType = paint ? 'smart-paint' : upload ? 'smart-upload' : 'smart-image';
            node = createNode(100,100,group ? [image,second] : [image],{nodeType});
        }
        window.brushSourceId = node.id;
        window.brushSnapshot = n => ({id:n.id,type:n.type,x:n.x,y:n.y,images:(n.images || [n]).map(item => ({
            url:item.url,name:item.name,asset_ref_id:item.asset_ref_id,
            originalLocalUrl:item.originalLocalUrl,localUrl:item.localUrl,sourceUrl:item.sourceUrl,
            natural_w:item.natural_w,natural_h:item.natural_h
        }))});
        render();
        if(legacy) openImageEditor(node.id,'brush');
        else if(!paint) {openImageEditor(node.id,group&&!secondUrl?1:0);setImageEditMode('brush',true);}
        return node.id;
    }, {legacy,group,upload,secondUrl:different?otherUrl:'',paint});
    if(paint){
        const card = page.locator(`[data-id="${sourceId}"]`);
        await card.locator('[data-smart-node-settings]').click();
        await page.locator(`[data-smart-node-action="brush"][data-node-id="${sourceId}"]`).click();
    }
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 600
        && document.getElementById('editDrawCanvas').width === 600);
    await page.locator('[data-brush-tool="rect"]').click();
    await page.evaluate(() => {
        document.getElementById('paintBrushColor').value = '#ff0000';
        document.getElementById('paintBrushSize').value = '8';
    });
    const bounds = await page.locator('#editDrawCanvas').boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.7,{steps:8});
    await page.mouse.up();
    assert.equal(await page.locator('#editDrawCanvas').evaluate(el => el.getContext('2d').getImageData(120,300,1,1).data[3]),255);
    await page.evaluate(() => {window.brushSourceBefore = JSON.stringify(brushSnapshot(nodes.find(n => n.id === brushSourceId)));});
    return {page,errors,dialogs,state,stored:() => stored};
}

for(const options of [{paint:true},{group:true},{upload:true},{legacy:true}]){
    const label = options.legacy ? 'legacy canvas' : options.group ? 'image group' : options.upload ? 'upload node' : 'paint node';
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
        const connection = {from:result.original.id,to:result.output.id,kind:'flow'};
        if(!options.legacy){
            assert.equal(result.output.type,'smart-upload');
            assert.equal(await page.locator('#composer').evaluate(el => el.classList.contains('open')),false);
            const line = page.locator(`[data-conn-from="${connection.from}"][data-conn-to="${connection.to}"] .conn-line`);
            assert.ok(await line.evaluate(el => el.getTotalLength() > 0 && getComputedStyle(el).stroke !== 'none'));
            assert.equal(result.image.asset_ref_id,'asset_brush_result');
            assert.equal(result.image.originalLocalUrl,undefined,'the result does not inherit the original preview URL');
        }
        await page.evaluate(() => {
            if(typeof saveTimer !== 'undefined') clearTimeout(saveTimer);
            return saveCanvas();
        });
        assert.equal(stored().nodes.length,2,'both images are saved');
        if(!options.legacy){
            assert.equal(stored().nodes.find(node => node.id === result.output.id).type,'smart-upload');
            assert.deepEqual(stored().connections,[connection]);
        }
        const restored = await page.evaluate(() => {
            performUndo();
            const afterUndo = nodes.length;
            const originalUnchanged = JSON.stringify(brushSnapshot(nodes.find(n => n.id === brushSourceId))) === brushSourceBefore;
            if(typeof performRedo !== 'function') return {afterUndo,originalUnchanged};
            const connectionsAfterUndo = canvas.connections.length;
            performRedo();
            return {afterUndo,afterRedo:nodes.length,originalUnchanged,connectionsAfterUndo,connectionsAfterRedo:canvas.connections};
        });
        assert.deepEqual(restored,options.legacy ? {afterUndo:1,originalUnchanged:true}
            : {afterUndo:1,afterRedo:2,originalUnchanged:true,connectionsAfterUndo:0,connectionsAfterRedo:[connection]});
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
    assert.equal(await page.evaluate(() => canvas.connections.length),0);
    assert.deepEqual(errors,[]);
});

async function dragOn(page, selector, from, to) {
    const rect = await page.locator(selector).boundingBox();
    await page.mouse.move(rect.x + rect.width * from[0], rect.y + rect.height * from[1]);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * to[0], rect.y + rect.height * to[1], {steps:5});
    await page.mouse.up();
}

async function outputPixels(page, points) {
    return page.evaluate(async ({url,points}) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const layer = XiaomeiImageEditGeometry.flatten(img, []);
        return points.map(([x,y]) => Array.from(layer.context.getImageData(x,y,1,1).data));
    }, {url:outputUrl,points});
}

test('smart brush exports arrows, erasures and text without the selection frame', {timeout:40000}, async t => {
    const {page,errors} = await fixture(t);
    await page.locator('[data-brush-tool="arrow"]').click();
    await dragOn(page, '#editDrawCanvas', [.2,.8], [.65,.8]);
    await page.locator('[data-brush-tool="eraser"]').click();
    await dragOn(page, '#editDrawCanvas', [.2,.35], [.2,.55]);
    const erased = () => page.evaluate(() => editDrawCanvas().getContext('2d').getImageData(120,360,1,1).data[3]);
    assert.equal(await erased(),0);
    await page.locator('#brushUndoBtn').click();
    assert.equal(await erased(),255);
    await page.locator('#brushRedoBtn').click();
    assert.equal(await erased(),0);
    await page.locator('[data-brush-tool="text"]').click();
    const layer = await page.locator('#editTextCanvas').boundingBox();
    const center = [layer.x + layer.width * .47, layer.y + layer.height * .42];
    await page.mouse.click(...center);
    await page.mouse.dblclick(...center);
    const editor = page.locator('.edit-text-inline');
    await editor.fill('Hello');
    await editor.press('Enter');
    const sample = await page.evaluate(() => {
        const draw = editDrawCanvas(), text = editTextCanvas(), preview = document.querySelector('.classic-ink-preview');
        const pixels = layer => layer.getContext('2d').getImageData(0,0,layer.width,layer.height).data;
        const a = pixels(draw), b = pixels(text), c = pixels(preview);
        const offset = c.findIndex((value,index) => index % 4 === 3 && value > 80 && !a[index] && !b[index]);
        if(offset < 0) throw new Error('selection preview is missing');
        const pixel = (offset - 3) / 4;
        return {frame:[pixel % draw.width,Math.floor(pixel / draw.width)], textPainted:b.some((value,index) => index % 4 === 3 && value > 0)};
    });
    assert.equal(sample.textPainted,true);
    await page.locator('#imageEditApplyBtn').click();
    await page.locator('#imageEditModal').waitFor({state:'hidden'});
    const [arrow, background, frame] = await outputPixels(page, [[280,640],[120,360],sample.frame]);
    assert.deepEqual(arrow,[255,0,0,255]);
    assert.deepEqual(background,[230,213,187,255]);
    assert.deepEqual(frame,sample.frame[0] < 300 ? [230,213,187,255] : [158,128,96,255]);
    assert.deepEqual(errors,[]);
});

test('protection mask keeps a capped gray preview and outputs an opaque binary PNG', {timeout:40000}, async t => {
    const {page,errors} = await fixture(t);
    await page.evaluate(() => {clearEditDrawing(true); setImageEditMode('protection-mask',true);});
    for(let i = 0; i < 4; i++) await dragOn(page, '#editDrawCanvas', [.2,.4], [.8,.4]);
    const preview = await page.evaluate(() => Array.from(editDrawCanvas().getContext('2d').getImageData(300,320,1,1).data));
    assert.equal(preview[3],115);
    assert.ok(preview.slice(0,3).every(value => Math.abs(value - 80) <= 1));
    await page.locator('#imageEditApplyBtn').click();
    await page.locator('#imageEditModal').waitFor({state:'hidden'});
    assert.deepEqual(await outputPixels(page,[[300,320],[1,1]]),[[255,255,255,255],[0,0,0,255]]);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id !== brushSourceId).images[0].role),'product-mask');
    assert.deepEqual(errors,[]);
});

test('erase uses the mask and original as inputs to a connected paint node', {timeout:40000}, async t => {
    const {page,errors} = await fixture(t);
    await page.evaluate(() => {
        clearEditDrawing(true);
        setImageEditMode('mask',true);
        window.runGeneration = async (...args) => { window.eraseRequest = args; };
    });
    await dragOn(page, '#editDrawCanvas', [.2,.4], [.8,.4]);
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(() => Boolean(window.eraseRequest));
    const result = await page.evaluate(() => {
        const output = nodes.find(node => node.id !== brushSourceId);
        const [kind,[original,mask],prompt] = window.eraseRequest;
        return {kind, connected:canvas.connections.some(edge => edge.from === brushSourceId && edge.to === output.id),
            ratio:output.runSettings.customRatio, original:original.url, role:mask.role, mask:mask.url, prompt};
    });
    assert.equal(result.kind,'default');
    assert.equal(result.connected,true);
    assert.equal(result.ratio,'600:800');
    assert.equal(result.original,sourceUrl);
    assert.equal(result.mask,outputUrl);
    assert.equal(result.role,'mask');
    assert.match(result.prompt,/白色区域/);
    assert.deepEqual(await outputPixels(page,[[300,320],[1,1]]),[[255,255,255,255],[0,0,0,255]]);
    assert.deepEqual(errors,[]);
});

test('smart grid previews manual cuts, preserves tile order and retries an incomplete upload', {timeout:40000}, async t => {
    const {page,state,errors} = await fixture(t);
    await page.evaluate(() => setImageEditMode('grid',true));
    const count = page.locator('#gridSplitCount');
    await page.locator('#gridCustomToggle').click();
    await dragOn(page, '#editDrawCanvas', [.25,.4], [.25,.55]);
    assert.match(await count.textContent(), /2/);
    await page.locator('#gridUndoBtn').click();
    assert.match(await count.textContent(), /1/);
    await page.locator('#gridCustomToggle').click();
    await page.locator('[data-grid-preset="2,2"]').click();
    await page.locator('#gridGapSize').evaluate(el => {el.value = '10'; el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.match(await count.textContent(), /4/);
    state.failure = 'partial';
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('切片上传不完整'));
    assert.equal(await page.evaluate(() => nodes.length),1);
    state.failure = '';
    await page.locator('#imageEditApplyBtn').click();
    await page.locator('#imageEditModal').waitFor({state:'hidden'});
    assert.deepEqual(state.parts.map(({name,png}) => [name,png.readUInt32BE(16),png.readUInt32BE(20)]),
        ['1_r1_c1','2_r1_c2','3_r2_c1','4_r2_c2'].map(id => ['brush-source_' + id + '.png',295,395]));
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.title === 'Grid').images.map(({grid}) => [grid.row,grid.col,grid.w,grid.h])),
        [[0,0,295,395],[0,1,295,395],[1,0,295,395],[1,1,295,395]]);
    assert.deepEqual(errors,[]);
});

test('smart grid join drag swaps tiles, preserves output size and restores the source when switching modes', {timeout:40000}, async t => {
    const {page,state,errors} = await fixture(t,{group:true,different:true});
    await page.evaluate(() => {
        const first = nodes.find(node => node.id === brushSourceId);
        const second = createNode(first.x + 500,first.y,first.images.splice(1));
        const group = createSmartGroupNode(first.x,first.y);
        group.items = [second.id,first.id];
        openGroupGridJoin(group);
    });
    const stage = page.locator('#gridJoinCanvas');
    const tiles = stage.locator('.grid-join-item');
    await page.waitForFunction(() => [...document.querySelectorAll('.grid-join-item')].filter(el => el.naturalWidth).length === 2);
    await dragOn(page, '#gridJoinCanvas', [.25,.5], [.75,.5]);
    assert.deepEqual(await tiles.evaluateAll(items => items.map(el => el.dataset.gridJoinIndex)),['1','0']);
    await page.locator('[data-image-edit-mode="crop"]').click();
    assert.equal(await stage.isVisible(),false);
    assert.equal(await page.locator('#cropImage').isVisible(),true);
    await page.locator('[data-image-edit-mode="grid"]').click();
    assert.deepEqual(await tiles.evaluateAll(items => items.map(el => el.dataset.gridJoinIndex)),['1','0']);
    await page.locator('[data-grid-join-size="1024"]').click();
    await page.locator('#imageEditApplyBtn').click();
    await page.locator('#imageEditModal').waitFor({state:'hidden'});
    assert.deepEqual([state.png.readUInt32BE(16),state.png.readUInt32BE(20)],[1024,683]);
    assert.deepEqual(await outputPixels(page,[[50,100],[550,100]]),[[0,136,204,255],[230,213,187,255]]);
    assert.equal(await page.evaluate(() => nodes.find(n => n.title === 'Grid Join').images[0].natural_w),1024);
    assert.deepEqual(errors,[]);
});
