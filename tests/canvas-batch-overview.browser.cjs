const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('batch materials, parameters, overview and single-screen editing survive reload', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge',headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1100}});
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'overview',nodes:[],connections:[],logs:[],settings:{}};
    let failPlan = false;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#e6e8df"/><rect x="55" y="35" width="290" height="430" fill="#f9faf7" stroke="#8b825c" stroke-width="9"/><path d="M200 35v430M140 250h120" stroke="#8b825c" stroke-width="4"/></svg>';
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if(url.hostname !== 'batch-overview.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.join(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/overview'){
            if(req.method() === 'PUT') saved = {...saved,...req.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'图片平台',enabled:true,image_models:['image-model'],chat_models:['text-model']}],comfy_instances:[]}});
        if(url.pathname === '/api/ai/upload') return route.fulfill({json:{files:[{url:'/fixture/reference.svg',name:'风格参考.svg',kind:'image'}]}});
        if(url.pathname.startsWith('/fixture/') || url.pathname.includes('preview')) return route.fulfill({contentType:'image/svg+xml',body:svg});
        if(url.pathname === '/api/canvas-llm'){
            requests.push(req.postDataJSON());
            return failPlan ? route.fulfill({status:500,json:{detail:'暂时无法生成'}}) : route.fulfill({json:{text:JSON.stringify({screens:[{title:'产品首屏',prompt:'正面展示产品全貌'},{title:'产品细节',prompt:'展示结构与材质细节'}]})}});
        }
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://batch-overview.test/static/smart-canvas.html?id=overview');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'overview');
    await page.addStyleTag({content:'#canvasNavPanel { display:none !important; }'});
    await page.evaluate(() => {
        nodes = [{id:'products',type:'smart-upload',x:-500,y:0,images:[{url:'/fixture/product.svg',kind:'image',name:'产品.svg'}]}];
        const loop = createLoopNode(0,0,{batchUiMode:'paired'}); loop.id = 'batch';
        loop.batchSourceNodeId = 'local'; loop.batchSourceText = '淋浴门，保持门框结构与玻璃材质'; loop.batchAiTargetCount = 2;
        loop.batchAiProvider = 'fixture'; loop.batchAiModel = 'text-model';
        canvas.connections = [{from:'products',to:'batch',kind:'input'}]; canvasUsesConnections = true;
        viewport = {x:40,y:80,scale:.92}; applyViewport(); render();
    });
    const batch = page.locator('[data-id="batch"]');
    assert.equal(await batch.locator('.loop-commerce').count(),0);
    assert.equal(await batch.locator('.loop-batch-overview').count(),0, 'new node does not show an empty overview');
    const chooser = page.waitForEvent('filechooser');
    await batch.locator('[data-batch-add-image="reference"]').click();
    await (await chooser).setFiles({name:'reference.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg)});
    await page.waitForFunction(() => nodes.find(n => n.id === 'batch').manualInputRefs?.length === 1);
    assert.match(await batch.locator('.batch-asset-row').nth(1).innerText(),/1 张/);
    await batch.locator('[data-loop-commerce="productName"]').fill('淋浴门');
    await batch.locator('[data-loop-commerce="language"]').selectOption({label:'英语'});
    await batch.locator('[data-loop-commerce="font"]').selectOption({label:'现代无衬线 · 干净'});
    await batch.locator('[data-loop-commerce="copy"]').selectOption({label:'全部无文字'});
    await batch.locator('[data-loop-commerce-plan]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'batch').aiSplitPrompts?.length === 2);
    assert.equal(await batch.locator('.loop-batch-overview').count(),1, 'planning prompts opens the overview so screens can be reviewed before spending');
    await page.evaluate(() => { window.originalDetailBatchRun = runSmartLoopDetailBatch; runSmartLoopDetailBatch = () => render(); });
    await batch.locator('[data-loop-run]').click();
    assert.equal(await batch.locator('.loop-batch-overview').count(),1, 'starting image generation opens the overview');
    await page.evaluate(() => { runSmartLoopDetailBatch = originalDetailBatchRun; });
    assert.equal(requests.length,1);
    assert.equal(requests[0].images.length,2);
    assert.match(requests[0].message,/仅参考风格和排版/);
    const state = await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        const paints = smartLoopDetailPaintNodes(loop);
        return {ids:paints.map(n => n.id),hidden:paints.map(smartBatchIsHidden),drafts:paints.map(n => n.promptDraftText),refs:smartLoopInputImages(loop).map(r => r.url)};
    });
    assert.deepEqual(state.hidden,[true,true]);
    assert.ok(state.drafts.every(p => /英语/.test(p) && /全部无文字/.test(p) && /图2/.test(p)));
    assert.deepEqual(state.refs,['/fixture/product.svg','/fixture/reference.svg']);
    for(const id of state.ids) assert.equal(await page.locator(`.image-node[data-id="${id}"]`).count(),0);
    await batch.locator('.batch-screen-prompt summary').first().click();
    await batch.locator('[data-batch-screen-prompt="0"]').fill('突出产品门框，留白充足');
    assert.match(await page.evaluate(id => nodes.find(n => n.id === id).promptDraftText,state.ids[0]),/突出产品门框/);
    await batch.locator('[data-loop-result-edit="0"]').click();
    await page.waitForFunction(id => selectedId === id,state.ids[0]);
    assert.equal(await page.locator(`.image-node[data-id="${state.ids[0]}"]`).count(),1);
    await page.evaluate(id => {
        const paint = nodes.find(n => n.id === id);
        setPromptDraftForNode(paint,'单屏精修后的完整提示词');
        smartBatchSyncPaintDraft(paint); render();
    },state.ids[0]);
    assert.equal(await page.locator('[data-batch-screen-prompt="0"]').inputValue(),'单屏精修后的完整提示词');
    await page.evaluate(async () => { await saveCanvas(); });
    await page.reload();
    await page.waitForFunction(() => nodes.find(n => n.id === 'batch')?.manualInputRefs?.length === 1);
    await page.addStyleTag({content:'#canvasNavPanel { display:none !important; }'});
    assert.equal(await page.locator('.loop-batch-overview').count(),1, 'overview remains visible after reload');
    assert.equal(await page.locator('[data-loop-commerce="language"]').inputValue(),'英语');
    assert.equal(await page.locator('[data-batch-screen-prompt="0"]').inputValue(),'单屏精修后的完整提示词');
    assert.equal(await page.locator(`.image-node[data-id="${state.ids[0]}"]`).count(),1);
    assert.equal(await page.locator(`.image-node[data-id="${state.ids[1]}"]`).count(),0);
    const changed = await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch'); loop.batchCommerce.language = '日语';
        ensureSmartLoopDetailPaintNodes(loop,2); render();
        return smartLoopDetailPaintNodes(loop)[0].promptDraftText;
    });
    assert.match(changed,/单屏精修后的完整提示词/);
    assert.match(changed,/语种：日语/);
    assert.equal((changed.match(/参考素材分工/g) || []).length,1,'shared instructions are appended once');
    await page.evaluate(() => { const loop=nodes.find(n => n.id === 'batch'); loop.batchCommerce.language='英语'; ensureSmartLoopDetailPaintNodes(loop,2); });
    // Exercise the real screen execution path with a deterministic model boundary.
    await page.evaluate(() => {
        window.batchCalls = []; window.failScreen = true;
        runApiGeneration = async (prompt,refs,runSettings) => {
            batchCalls.push({prompt,refs:refs.map(r => r.url),model:runSettings.model});
            if(failScreen) throw new Error('当前屏失败');
            return {taskIds:['fixture-task'],providerId:'fixture',model:'image-model'};
        };
        resumeSmartPendingNode = async paint => { paint.images = [{url:'/fixture/result.svg',kind:'image',name:'result.svg'}]; paint.pendingTasks = []; paint.pending = 0; paint.running = false; };
        viewport = {x:40,y:80,scale:.92}; applyViewport(); render();
    });
    await page.locator('[data-batch-screen-run="1"]').click();
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && nodes.find(n => n.id === 'batch').batchPaintNodeIds.some(id => nodes.find(n => n.id === id)?.runError));
    assert.match(await page.locator('.batch-screen').nth(1).innerText(),/生成失败/);
    await page.evaluate(() => { failScreen = false; });
    await page.locator('[data-batch-screen-run="1"]').click();
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch') && document.querySelector('[data-loop-result-preview="1"]'));
    const calls = await page.evaluate(() => batchCalls);
    assert.equal(calls.length,2);
    assert.match(calls[1].prompt,/英语/);
    assert.match(calls[1].prompt,/全部无文字/);
    assert.deepEqual(calls[1].refs,['/fixture/product.svg','/fixture/reference.svg']);
    assert.equal(calls[1].model,'image-model');
    assert.equal(await page.locator(`.image-node[data-id="${state.ids[1]}"]`).count(),0);
    const before = await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts);
    failPlan = true;
    await page.locator('[data-loop-commerce-plan]').click();
    await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts),before);
    await page.locator('[data-batch-add-screen]').click();
    await page.locator('[data-batch-screen-prompt="2"]').fill('新增第三屏');
    await page.locator('[data-batch-move-screen="2"][data-direction="-1"]').click();
    assert.equal(await page.locator('[data-batch-screen-prompt="1"]').inputValue(),'新增第三屏');
    await page.locator('[data-batch-remove-screen="1"]').click();
    assert.equal(await page.locator('.batch-screen').count(),2);
    assert.equal(await page.evaluate(() => nodes.filter(n => n.batchDetailOwnerId === 'batch').length),2);
    if(process.env.BATCH_SCREENSHOT){
        await page.evaluate(() => { document.activeElement?.blur(); const loop = nodes.find(n => n.id === 'batch'); loop.aiSplitError = ''; loop.batchAdvancedOpen = false; loop.batchEditingScreen = -1; selectedId = 'batch'; selectedIds = []; selectedImage = {nodeId:'',index:-1}; activeComposerSubject = null; lastComposerNodeId = ''; nodes.filter(n => n.batchDetailOwnerId === loop.id).forEach(n => n.batchOverviewOnly = true); viewport = {x:340,y:100,scale:.9}; applyViewport(); render(); shell.scrollTop = 0; shell.scrollLeft = 0; window.scrollTo(0,0); });
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        await page.screenshot({path:path.join(root,'.oil-ui/batch-node/shots/overview.png')});
        await page.evaluate(() => applyTheme('dark'));
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        await page.screenshot({path:path.join(root,'.oil-ui/batch-node/shots/overview-dark.png')});
    }
});
