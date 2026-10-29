const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('batch copies retain inputs and prompts, run with another model, persist and undo independently', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1100}});
    const errors = [], submissions = [];
    page.on('pageerror', e => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'batch-copy', title:'Batch copy', nodes:[], connections:[], logs:[], settings:{}};
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#e4dca1"/></svg>';
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if(url.hostname !== 'batch-copy.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/batch-copy'){
            if(req.method() === 'PUT') saved = {...saved,...req.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2','gpt-image-2.5'], chat_models:['text-model']
        }],comfy_instances:[]}});
        if(url.pathname === '/api/canvas-image-tasks' && req.method() === 'POST'){
            submissions.push(req.postDataJSON());
            return route.fulfill({json:{task_id:'copy-task',status:'queued'}});
        }
        if(url.pathname === '/api/canvas-image-tasks/copy-task') return route.fulfill({json:{id:'copy-task',status:'succeeded',result:{images:['/output/copy.svg']}}});
        if(url.pathname.startsWith('/output/') || url.pathname.includes('preview')) return route.fulfill({contentType:'image/svg+xml',body:svg});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://batch-copy.test/static/smart-canvas.html?id=batch-copy');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'batch-copy');
    await page.evaluate(() => {
        nodes = [
            {id:'product',type:'smart-upload',x:-500,y:0,images:[{url:'/output/product.svg',name:'产品'}]},
            {id:'style',type:'smart-upload',x:-500,y:400,images:[{url:'/output/style.svg',name:'风格'}]},
            {id:'source',type:'smart-prompt',x:-800,y:0,text:'产品卖点原文'},
            {id:'guide',type:'smart-prompt',x:-800,y:400,text:'暖黄配色'}
        ];
        const owner = createLoopNode(0,0,{batchUiMode:'paired'}); owner.id = 'original';
        Object.assign(owner, {
            batchSourceNodeId:'source',batchGuideNodeId:'guide',batchAiTargetCount:2,
            aiSplitPrompts:[{title:'首屏',prompt:'展示产品全貌'},{title:'细节',prompt:'特写展示细节'}],
            variablePrompts:['展示产品全貌','特写展示细节'],
            batchImageSettings:{provider_id:'fixture',model:'gpt-image-2',ratio:'9:16',resolution:'1k'}
        });
        canvas.connections = ['product','style','source','guide'].map(from => ({from,to:owner.id,kind:'input',input_slot:from === 'style' ? 'reference' : 'product'}));
        canvasUsesConnections = true;
        owner.aiSplitSourceText = smartLoopDetailSourceText(owner);
        owner.aiSplitGuideInput = smartLoopDetailGuideInput(owner);
        ensureSmartLoopDetailPaintNodes(owner,2);
        const paints = smartLoopDetailPaintNodes(owner);
        paints[0].images = [{url:'/output/original.svg',name:'原始结果'}];
        paints[1].runError = '旧任务失败';
        paints[1].pending = 1; paints[1].pendingTasks = [{taskId:'old-task',status:'running'}];
        owner.aiSplitRunning = true;
        viewport = {x:20,y:30,scale:.7}; applyViewport(); render();
        undoStack.length = 0; redoStack.length = 0;
    });
    const original = page.locator('[data-id="original"]');
    await page.evaluate(() => { nodes.find(n => n.id === 'original').batchOverviewSize = {width:360,height:740}; render(); });
    assert.equal(await original.locator('[data-batch-duplicate]').evaluate(el => {
        const header = el.closest('header').getBoundingClientRect();
        return [...el.parentElement.querySelectorAll('button')].every(button => {
            const box = button.getBoundingClientRect();
            return box.left >= header.left && box.right <= header.right && box.bottom <= header.bottom;
        });
    }),true,'all actions fit at minimum width');
    await original.getByRole('button',{name:'复制整组',exact:true}).click();
    const copyId = await page.evaluate(() => selectedId);
    assert.notEqual(copyId,'original');
    const inspect = id => page.evaluate(id => {
        const owner = nodes.find(n => n.id === id), paints = smartLoopDetailPaintNodes(owner);
        return {owner:JSON.parse(JSON.stringify(owner)),paints:JSON.parse(JSON.stringify(paints)),
            refs:smartLoopPreviewImages(owner).map(ref => ({url:ref.url,role:smartBatchRole(owner,ref),missing:!!ref.sourceMissing})),
            stale:smartLoopAiSplitIsStale(owner),source:smartLoopDetailSourceText(owner),guide:smartLoopDetailVisualGuide(owner)};
    },id);
    let copy = await inspect(copyId);
    assert.equal(copy.paints.length,2);
    assert.ok(copy.paints.every(p => p.batchDetailOwnerId === copyId && !p.images.length && !p.pending && !p.pendingTasks && !p.runError));
    assert.equal(copy.owner.aiSplitRunning,false);
    assert.equal(copy.stale,false);
    assert.equal(copy.source,(await inspect('original')).source);
    assert.equal(copy.guide,'暖黄配色');
    assert.deepEqual(copy.refs,[{url:'/output/product.svg',role:'product',missing:false},{url:'/output/style.svg',role:'reference',missing:false}]);
    assert.equal(submissions.length,0,'copying never submits a generation');
    assert.equal(await page.evaluate(() => undoStack.length),1);
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(id => nodes.some(n => n.id === id),copyId),false);
    await page.evaluate(() => performRedo());
    assert.equal((await inspect(copyId)).paints.length,2);

    const copiedNode = page.locator(`[data-id="${copyId}"]`);
    await copiedNode.locator('[data-loop-batch-image-param="model"]').selectOption('gpt-image-2.5');
    await copiedNode.locator('[data-batch-screen-run="0"]').click();
    await page.waitForFunction(id => smartLoopDetailPaintNodes(nodes.find(n => n.id === id))[0].images.some(img => img.url === '/output/copy.svg'),copyId);
    assert.equal(submissions.length,1);
    assert.equal(submissions[0].model,'gpt-image-2.5');
    assert.equal(submissions[0].reference_images.length,2);
    assert.match(submissions[0].prompt,/展示产品全貌/);
    assert.match(submissions[0].prompt,/暖黄配色/);
    if(process.env.BATCH_COPY_SCREENSHOT){
        await page.evaluate(id => {
            const owner = nodes.find(n => n.id === id);
            owner.batchOverviewSize = {width:730,height:620};
            viewport = {x:40-owner.x*.65,y:40-owner.y*.65,scale:.65};
            applyViewport(); render();
        },copyId);
        await page.screenshot({path:process.env.BATCH_COPY_SCREENSHOT});
    }
    const unchanged = await inspect('original');
    assert.equal(unchanged.owner.batchImageSettings.model,'gpt-image-2');
    assert.equal(unchanged.paints[0].images[0].url,'/output/original.svg');
    assert.equal(unchanged.paints[1].pendingTasks[0].taskId,'old-task');
    await page.evaluate(async () => {
        const owner = nodes.find(n => n.id === 'original');
        owner.aiSplitRunning = false;
        smartLoopDetailPaintNodes(owner)[1].pending = 0;
        delete smartLoopDetailPaintNodes(owner)[1].pendingTasks;
        await saveCanvas();
    });
    await page.reload();
    await page.waitForFunction(id => smartConfigReady && nodes.some(n => n.id === id),copyId);
    assert.equal((await inspect(copyId)).owner.batchImageSettings.model,'gpt-image-2.5');
    assert.equal((await inspect(copyId)).paints.length,2);

    // A keyboard copy can be pasted into a different canvas without its upstream nodes.
    await page.evaluate(() => {
        selectedId = 'original'; selectedIds = []; document.activeElement?.blur();
    });
    await page.keyboard.press('Control+c');
    await page.evaluate(() => {
        nodes = []; canvas.connections = []; render();
    });
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => nodes.some(smartLoopIsPaired));
    const pasted = await page.evaluate(() => nodes.find(smartLoopIsPaired).id);
    const crossCanvas = await inspect(pasted);
    assert.equal(crossCanvas.paints.length,2);
    assert.deepEqual(crossCanvas.refs,copy.refs);
    assert.equal(crossCanvas.stale,false);
    assert.ok(crossCanvas.paints.every(p => p.batchDetailOwnerId === pasted));
    const before = await page.evaluate(() => nodes.length);
    await page.evaluate(id => { sharedCanvasReadOnly = true; duplicateSmartBatchOverview(nodes.find(n => n.id === id)); pasteNodes(); sharedCanvasReadOnly = false; },pasted);
    assert.equal(await page.evaluate(() => nodes.length),before,'read-only canvas rejects copies');
});
