const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');
async function fixture(t){
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1700,height:1100}});const errors=[],requests=[],previews=[];
    page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
    let stored={id:'physical',title:'尺寸隔离测试',nodes:[],connections:[],settings:{},logs:[]};
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',route=>{
        const req=route.request(),url=new URL(req.url());if(url.hostname!=='physical.test')return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(url.pathname==='/api/canvases/physical'){
            if(req.method()==='PUT')stored={...stored,...req.postDataJSON()};return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname==='/api/config')return route.fulfill({json:{api_providers:[{id:'gpt',name:'GPT fixture',protocol:'openai',enabled:true,image_models:['gpt-image-2.5-flare'],chat_models:[],video_models:[]},{id:'google',name:'Google fixture',protocol:'gemini',enabled:true,image_models:['gemini-3.1-flash-image'],chat_models:[],video_models:[]}],comfy_instances:[]}});
        if(url.pathname.startsWith('/fixture/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect x="50" y="50" width="300" height="400" fill="#8296ad"/></svg>'});
        if(url.pathname==='/api/product-fidelity/capabilities')return route.fulfill({json:{supported:true,applicationReferenceLimit:14,localFeatureAlignment:true}});
        if(url.pathname==='/api/product-fidelity/preview'){
            const body=req.postDataJSON();previews.push(body);
            const guide={url:'/fixture/guide.png',role:'geometry_reference',reference_id:'geometry-'+body.product_fidelity.dimensions.width,name:'尺寸结构图'};
            return route.fulfill({json:{generatedAssets:[guide],reference_images:[...body.reference_images,guide],warnings:[],paidApiCalled:false}});
        }
        if(url.pathname==='/api/canvas-image-tasks'&&req.method()==='POST'){
            requests.push(req.postDataJSON());return route.fulfill({json:{task_id:'dim-'+requests.length,status:'queued'}});
        }
        if(url.pathname.startsWith('/api/canvas-image-tasks/')){
            const body=requests.at(-1);return route.fulfill({json:{status:'succeeded',result:{images:['/fixture/result.png'],product_fidelity:{dimensions:body.product_fidelity.dimensions,geometryGuideUsed:body.product_fidelity.dimensions.constraintMode==='guide',validationStatus:'unknown',validations:[{status:'unknown',physicalGeometry:{status:'unknown',reason:'缺少可靠商品四角',thicknessReason:'无法验证厚度'}}],warnings:[]}}}});
        }
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://physical.test/static/smart-canvas.html?id=physical');await page.waitForFunction(()=>canvas?.id==='physical');
    return {page,requests,previews,stored:()=>stored};
}
test('processor dimensions: real-time preview, unit invariance, undo/redo, copy/save/reopen and stale guides',{timeout:60000},async t=>{
    const {page,requests,previews,stored}=await fixture(t);
    const id=await page.evaluate(()=>{viewport={x:0,y:0,scale:1};applyViewport();const node=createProductFidelityNodeAt({x:600,y:500});return node.id;});
    const panel=page.locator('[data-id="'+id+'"] [data-pd-root]');
    await page.locator('[data-id="'+id+'"] [data-pf-ui-mode="all"]').click();
    await page.locator('[data-id="'+id+'"] [data-pf-group="size"] > summary').click();
    await panel.locator('[data-pd-field="enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    for(const [key,value] of [['width','30'],['height','40'],['depth','2']])await panel.locator('[data-pd-field="'+key+'"]').fill(value);
    await panel.locator('[data-pd-field="constraintMode"]').selectOption('guide');
    await page.waitForFunction(id=>document.querySelector('[data-id="'+id+'"] [data-pd-ratio]').textContent.includes('3:4'),id);
    assert.equal(await panel.locator('[data-pd-preview]').isVisible(),true);
    const get=()=>page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.dimensions,id);
    const initial=await get();assert.deepEqual([initial.width,initial.height,initial.depth],[300,400,20]);
    assert.equal(requests.length,0);assert.equal(previews.length,0,'local input and preview canvas make no API request');
    await panel.locator('[data-pd-field="unit"]').selectOption('mm');
    assert.equal(await panel.locator('[data-pd-field="width"]').inputValue(),'300');
    await panel.locator('[data-pd-field="unit"]').selectOption('in');
    assert.ok(Math.abs(Number(await panel.locator('[data-pd-field="height"]').inputValue())-400/25.4)<1e-9);
    await panel.locator('[data-pd-field="unit"]').selectOption('cm');
    assert.equal((await get()).width,300);
    await panel.locator('[data-pd-field="depth"]').fill('');assert.equal((await get()).depth,null);
    await page.evaluate(()=>performUndo());assert.equal((await get()).depth,20);
    await page.evaluate(()=>performRedo());assert.equal((await get()).depth,null);
    await panel.locator('[data-pd-field="depth"]').fill('0');
    await page.waitForFunction(id=>document.querySelector('[data-id="'+id+'"] [data-pd-error]').textContent.includes('大于 0'),id);
    await panel.locator('[data-pd-field="depth"]').fill('');
    await page.locator('[data-id="'+id+'"] [data-pf-action="preview"]').click();
    await page.waitForFunction(id=>nodes.find(n=>n.id===id).fidelityPreview,id);
    assert.equal((await get()).guideAssetId,'geometry-300');assert.equal(previews.length,1);
    await panel.locator('[data-pd-field="width"]').fill('31');
    assert.equal((await get()).guideAssetId,null);assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityPreview,id),undefined);
    await page.evaluate(async()=>{await saveCanvas();});
    assert.equal(stored().nodes.find(n=>n.id===id).fidelityConfig.dimensions.width,310);
    const copy=await page.evaluate(id=>cloneSmartNode(nodes.find(n=>n.id===id),20,20).fidelityConfig.dimensions,id);
    assert.deepEqual(copy,await get());
    await page.reload();await page.waitForFunction(()=>canvas?.id==='physical');
    assert.equal((await get()).width,310);assert.equal((await get()).depth,null);
    assert.equal(requests.length,0);
    if(process.env.PHYSICAL_DIMENSIONS_SCREENSHOT){
        await page.locator('[data-id="'+id+'"] [data-pf-ui-mode="all"]').click();
        await page.locator('[data-id="'+id+'"] [data-pf-group="size"] > summary').click();
        await page.locator('[data-id="'+id+'"] [data-pd-root]').scrollIntoViewIfNeeded();
        await page.locator('[data-id="'+id+'"]').screenshot({path:path.resolve(process.env.PHYSICAL_DIMENSIONS_SCREENSHOT)});
    }
});
test('saved ordinary AI node dimensions preserve 16:9, reference order, provider and user prompt',{timeout:60000},async t=>{
    const {page,requests}=await fixture(t);
    await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:50,y:50,images:[{url:'/fixture/A.png',kind:'image'},{url:'/fixture/B.png',kind:'image'}]}];
        canvas.connections=[];canvasUsesConnections=true;
        const paint=createNode(550,100,[],{nodeType:'smart-paint',title:'尺寸生图'});paint.id='paint';paint.promptDraftText='保留我的提示词';
        paint.runSettings={engine:'api',apiKind:'image',provider_id:'gpt',model:'gpt-image-2.5-flare',count:1,ratio:'wide',resolution:'1k'};
        paint.runSettings.productFidelity=fidelityConfig({enabled:true,mode:'structure',detail:{enabled:false},validation:{enabled:false},dimensions:{...XiaomeiPhysicalDimensions.defaults(),enabled:true,width:300,height:400,constraintMode:'guide'}});
        connectInputNode('product','paint');paint.inputRefOrder=['product|1','product|0'];selectedId='paint';selectedIds=[];render();updateComposer();
    });
    assert.equal(await page.locator('.pf-dimensions-control, [data-pd-open-source]').count(),0);
    assert.equal(await page.locator('#dynamicParams').getByRole('button',{name:/产品保真设置/}).count(),0);
    const result=await page.evaluate(()=>{const node=nodes.find(n=>n.id==='paint');return runGenerationDirect('default',null,'保留我的提示词',node,smartSettingsForNode(node));});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(requests.length,1);
    assert.equal(requests[0].aspect_ratio,'16:9');assert.equal(requests[0].product_fidelity.dimensions.width,300);assert.equal(requests[0].product_fidelity.dimensions.depth,null);
    assert.equal(requests[0].prompt,'保留我的提示词');
    assert.deepEqual(requests[0].reference_images.map(r=>r.url),['/fixture/B.png','/fixture/A.png']);
    assert.equal(requests[0].reference_images[0].role,'product_reference');
    await page.evaluate(async()=>{const node=nodes.find(n=>n.id==='paint');node.runSettings.provider_id='google';node.runSettings.model='gemini-3.1-flash-image';await runApiGeneration('第二平台',referenceImagesFor(node),smartSettingsForNode(node));});
    assert.equal(requests[1].provider_id,'google');assert.equal(requests[1].product_fidelity.dimensions.width,300);assert.equal(requests[1].aspect_ratio,'16:9');
    await page.evaluate(async()=>{const node=nodes.find(n=>n.id==='paint');node.manualInputRefs=[];canvas.connections=[];selectedId='paint';render();updateComposer();});
    assert.equal(await page.locator('.pf-dimensions-control, [data-pd-open-source]').count(),0);
    await page.evaluate(()=>{const source=createProductFidelityNodeAt({x:100,y:100});connectInputNode(source.id,'paint');selectedId='paint';selectedIds=[];render();updateComposer();});
    assert.equal(await page.locator('#dynamicParams').getByRole('button',{name:/产品保真设置/}).count(),0);
});
