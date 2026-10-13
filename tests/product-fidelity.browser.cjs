const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');

async function fixture(t){
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1900,height:1100}});
    const errors=[],previews=[],paid=[];
    page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
    let stored={id:'fidelity',title:'产品保真工作流',nodes:[],connections:[],settings:{},logs:[]};
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.hostname!=='fidelity.test')return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/fixture/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect x="100" y="90" width="400" height="270" rx="4" fill="#788896" stroke="#ddd" stroke-width="15"/><rect x="118" y="108" width="364" height="234" fill="#c9d1d3"/><text x="240" y="240" fill="#273b43" font-size="30">XM 4:3</text></svg>'});
        if(url.pathname==='/api/canvases/fidelity'){
            if(req.method()==='PUT')stored={...stored,...req.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname==='/api/config')return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',protocol:'openai',enabled:true,image_models:['gpt-image-2','gpt-image-2.5-flare','gemini-3.1-flash-image'],chat_models:[],video_models:[]}],comfy_instances:[]}});
        if(url.pathname==='/api/product-fidelity/capabilities')return route.fulfill({json:{supported:true,modelId:url.searchParams.get('model'),channelId:'fixture',transport:'existing-adapter',applicationReferenceLimit:16,localFeatureAlignment:true}});
        if(url.pathname==='/api/product-fidelity/preview'){
            const body=req.postDataJSON();previews.push(body);
            return route.fulfill({json:{reference_images:[...body.reference_images,{url:'/fixture/high.png',reference_id:'high',role:'highpass',parentReferenceId:body.product_fidelity.productReferenceId}],
                generatedAssets:[{url:'/fixture/high.png',name:'高反差辅助图',reference_id:'high',role:'highpass'}],detectedRois:body.product_fidelity.detail.autoCrops?[{x:.15,y:.2,w:.2,h:.2,source:'auto'}]:[],
                warnings:[],paidApiCalled:false}});
        }
        if(url.pathname==='/api/canvas-image-tasks'&&req.method()==='POST'){
            paid.push(req.postDataJSON());return route.fulfill({json:{task_id:'task-'+paid.length,status:'queued'}});
        }
        if(url.pathname.startsWith('/api/canvas-image-tasks/'))return route.fulfill({json:{status:'succeeded',result:{images:['/fixture/result.png'],product_fidelity:{validationStatus:'passed',validations:[{reason:'本地产品核心像素保留'}],warnings:[]}}}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://fidelity.test/static/smart-canvas.html?id=fidelity');
    await page.waitForFunction(()=>canvas?.id==='fidelity');
    return {page,previews,paid,stored:()=>stored};
}
async function install(page){
    return page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:50,y:260,images:[{url:'/fixture/A.png',kind:'image',name:'产品正面'},{url:'/fixture/B.png',kind:'image',name:'产品细节'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();render();
        openCreateMenu({clientX:600,clientY:160},{point:{x:900,y:510},pendingConnection:{fromId:'product',fromPort:'out'}});
    });
}
test('dedicated inline processor, local editing, live downstream generation and reference order',{timeout:60000},async t=>{
    const {page,previews,paid,stored}=await fixture(t);await install(page);
    const card=page.locator('[data-create-type="product-fidelity"]');assert.equal(await card.locator('.create-card-title').textContent(),'产品保真');await card.click();
    const id=await page.evaluate(()=>selectedNode().id),node=page.locator('.image-node[data-id="'+id+'"]');
    assert.equal(await page.evaluate(()=>selectedNode().type),'smart-product-fidelity');
    assert.equal(await page.evaluate(()=>selectedNode().fidelityConfig.enabled),true);
    assert.equal(await page.evaluate(()=>selectedNode().runSettings),undefined,'processor owns no generation settings');
    assert.equal(await page.locator('.product-fidelity-dialog').count(),0);
    assert.equal(await page.locator('#composer').evaluate(el=>el.classList.contains('open')),false,'processor has no prompt or model composer');
    assert.deepEqual(await node.locator('.pf-section h3').allTextContents(),['01 产品识别','02 结构约束','03 视角控制','04 生成强度','05 校验规则','06 失败重试','07 高级模式']);
    assert.equal(await node.locator('.pf-detail h4').textContent(),'细节保护');
    const selection=node.locator('[data-pf-field="productReferenceId"]');
    const ids=await selection.locator('option').evaluateAll(els=>els.map(e=>e.value));assert.equal(new Set(ids).size,2);
    await selection.selectOption(ids[1]);
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    const editor=node.locator('[data-pf-canvas]'),box=await editor.boundingBox();
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.7,{steps:12});await page.mouse.up();
    await node.locator('[data-pf-tool="roi"]').click();
    await page.mouse.move(box.x+box.width*.35,box.y+box.height*.35);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.55,{steps:5});await page.mouse.up();
    await node.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(id=>nodes.find(n=>n.id===id).fidelityPreview,id);
    assert.equal(paid.length,0);assert.equal(previews.length,1);assert.equal(previews[0].local_only,true);
    assert.equal(previews[0].provider_id,'');assert.equal(previews[0].model,'');
    assert.equal(previews[0].product_fidelity.productReferenceId,ids[1]);
    assert.equal(previews[0].product_fidelity.rois.length,1);assert.ok(previews[0].product_fidelity.maskStrokes[0].points.length>5);
    assert.deepEqual(previews[0].reference_images.map(r=>r.url),['/fixture/A.png','/fixture/B.png']);
    const radius=node.locator('[data-pf-field="detail.highPassRadiusPx"]');await radius.fill('5');await radius.dispatchEvent('change');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityPreview,id),undefined,'local controls invalidate stale preview');
    await node.locator('[data-pf-action="auto-crops"]').click();
    await page.waitForFunction(id=>nodes.find(n=>n.id===id).fidelityPreview?.detectedRois.length===1,id);
    assert.equal(previews.at(-1).product_fidelity.rois.length,1);assert.equal(paid.length,0);
    // Add the ordinary downstream paint with an extra manual reference.
    await page.evaluate(id=>{
        const paint=createNode(1490,300,[],{nodeType:'smart-paint',title:'绘画'});
        paint.id='paint';paint.manualInputRefs=[{url:'/fixture/C.png',kind:'image',name:'场景参考'}];
        paint.runSettings={engine:'api',apiKind:'image',provider_id:'fixture',model:'gpt-image-2',count:1,ratio:'4:3'};
        connectInputNode(id,paint.id);paint.inputRefOrder=[id+'|1',id+'|0','url|/fixture/C.png'];
        selectedId=id;selectedIds=[];render();updateComposer();
    },id);
    assert.equal(await selection.inputValue(),ids[1],'sorting downstream never changes product identity');
    assert.deepEqual(await page.evaluate(()=>referenceImagesFor(nodes.find(n=>n.id==='paint')).map(r=>r.url)),['/fixture/B.png','/fixture/A.png','/fixture/C.png']);
    await node.locator('[data-pf-field="mode"]').selectOption('structure');
    await node.locator('[data-pf-field="detail.restoreMode"]').selectOption('auto');
    await node.locator('[data-pf-field="mode"]').selectOption('view');
    assert.equal(await node.locator('[data-pf-field="detail.restoreMode"]').isDisabled(),true);
    assert.equal(await node.locator('[data-pf-field="detail.restoreMode"]').inputValue(),'off');
    await node.locator('[data-pf-field="mode"]').selectOption('strict');
    // Generate through the actual dependency runner, task client and poll parser.
    const run=await page.evaluate(()=>{const p=nodes.find(n=>n.id==='paint');return runSmartNodeWithDependencies(p,n=>runGenerationDirect('default',null,'放在简洁的摄影棚背景中',n,smartSettingsForNode(n)));});
    assert.equal(run.ok,true,JSON.stringify(run));assert.equal(paid.length,1,'only downstream paint makes a paid submission');
    assert.equal(paid[0].product_fidelity.sourceNodeId,id);assert.equal(paid[0].product_fidelity.productReferenceId,ids[1]);
    assert.equal(paid[0].product_fidelity.detail.highPassRadiusPx,5,'latest control edits apply without preview');
    assert.deepEqual(paid[0].reference_images.map(r=>r.url),['/fixture/B.png','/fixture/A.png','/fixture/C.png'],'auxiliary preview assets are not duplicated in frontend payload');
    assert.deepEqual(paid[0].reference_images.slice(0,2).map(r=>r.reference_id),[ids[1],ids[0]]);
    await page.waitForFunction(id=>document.querySelector('[data-id="'+id+'"] [data-pf-results]').textContent.includes('原产品核心像素已保留'),id);
    const refs2=await page.evaluate(async()=>{
        const p=nodes.find(n=>n.id==='paint'),s=smartSettingsForNode(p);
        await runApiGeneration('第二次',referenceImagesFor(p),s);return s.productFidelity.referenceIds;
    });
    assert.equal(paid[1].reference_images.find(r=>r.url==='/fixture/C.png').reference_id,paid[0].reference_images.find(r=>r.url==='/fixture/C.png').reference_id,'extra user reference identities remain stable');
    assert.ok(refs2['/fixture/C.png']);
    const copy=await page.evaluate(id=>{selectedId=id;selectedIds=[];copySelectedNodes();return nodeClipboard.nodes[0];},id);
    assert.equal(copy.type,'smart-product-fidelity');assert.equal(copy.fidelityConfig.productReferenceId,ids[1]);
    assert.equal(copy.fidelityConfig.rois.length,1);
    // Undo and restore live settings through normal history.
    await node.locator('[data-pf-field="mode"]').selectOption('structure');
    await page.evaluate(()=>performUndo());
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.mode,id),'strict');
    const errors=await page.evaluate(id=>{
        const p=nodes.find(n=>n.id==='paint'),source=nodes.find(n=>n.id===id),messages=[];
        for(const patch of [{apiKind:'video'},{imageOperation:'upscale'},{engine:'comfy'}]){
            try{validateProductFidelityRun(p,{...smartSettingsForNode(p),...patch});}catch(e){messages.push(e.message);}
        }
        const another={id:'another',type:'smart-product-fidelity',fidelityConfig:{...cloneSmartSettings(source.fidelityConfig)}};nodes.push(another);
        canvas.connections.push({from:'another',to:'paint',kind:'input'});
        try{validateProductFidelityRun(p,smartSettingsForNode(p));}catch(e){messages.push(e.message);}
        nodes=nodes.filter(n=>n.id!=='another');canvas.connections=canvas.connections.filter(c=>c.from!=='another');
        return {messages,cycle:validateProductFidelityConnection(p,source)};
    },id);
    assert.equal(errors.messages.length,4);assert.match(errors.messages.at(-1),/多个/);assert.equal(errors.cycle,false);
    // Disabling or disconnecting the processor removes its inherited protection.
    const detached=await page.evaluate(id=>{
        const source=nodes.find(n=>n.id===id),p=nodes.find(n=>n.id==='paint');source.fidelityConfig.enabled=false;
        const disabled=smartSettingsForNode(p).productFidelity;source.fidelityConfig.enabled=true;
        canvas.connections=canvas.connections.filter(c=>!(c.from===id&&c.to===p.id));const disconnected=smartSettingsForNode(p).productFidelity;
        connectInputNode(id,p.id);selectedId=id;selectedIds=[];render();updateComposer();return {disabled,disconnected};
    },id);
    assert.deepEqual(detached,{disabled:undefined,disconnected:undefined});
    // All seven sections exist in the scrollable inline grid, in both themes.
    await node.locator('[data-pf-jump="07"]').click();
    assert.ok(await node.locator('.pf-settings-column').evaluate(el=>el.scrollTop>1000));
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        const dir=process.env.FIDELITY_SCREENSHOT_DIR;fs.mkdirSync(dir,{recursive:true});
        await page.evaluate(id=>{
            const source=nodes.find(n=>n.id==='product'),paint=nodes.find(n=>n.id==='paint');
            Object.assign(source,{x:45,y:330,w:290,h:150,manualSize:true});
            Object.assign(paint,{x:1480,y:330,w:310,h:245,manualSize:true,title:'绘画'});
            selectedId=id;selectedIds=[];render();updateComposer();
            document.querySelectorAll('.toast').forEach(el=>el.remove());
        },id);
        await node.locator('[data-pf-action="preview"]').click();
        await page.waitForFunction(id=>nodes.find(n=>n.id===id).fidelityPreview,id);
        await node.locator('.pf-settings-column').evaluate(el=>el.scrollTop=0);
        await page.evaluate(()=>applyTheme('light'));await page.screenshot({path:path.join(dir,'product-fidelity-workflow-light.png')});
        const light=await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color);
        await page.evaluate(()=>applyTheme('dark'));await page.screenshot({path:path.join(dir,'product-fidelity-workflow-dark.png')});
        assert.notEqual(await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color),light);
        await node.locator('.pf-settings-column').evaluate(el=>el.scrollTop=el.scrollHeight);
        await node.screenshot({path:path.join(dir,'product-fidelity-inline-lower-sections.png')});
        await node.locator('[data-pf-jump="02"]').click();
        await node.screenshot({path:path.join(dir,'product-fidelity-inline-detail.png')});
    }
    await page.evaluate(()=>saveCanvas());
    assert.equal(stored().nodes.find(n=>n.id===id).type,'smart-product-fidelity');
    await page.reload();await page.waitForFunction(id=>nodes.some(n=>n.id===id),id);
    const restored=await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);return {type:n.type,enabled:n.fidelityConfig.enabled,main:n.fidelityConfig.productReferenceId,refs:productFidelityInputImages(n).length};},id);
    assert.deepEqual(restored,{type:'smart-product-fidelity',enabled:true,main:ids[1],refs:2});
    const missingMain=await page.evaluate(id=>{
        const product=nodes.find(n=>n.id==='product'),source=nodes.find(n=>n.id===id);
        product.images=product.images.slice(0,1);render();
        return {main:source.fidelityConfig.productReferenceId,label:document.querySelector('[data-id="'+id+'"] [data-pf-field="productReferenceId"] option:checked').textContent};
    },id);
    assert.equal(missingMain.main,ids[1]);assert.match(missingMain.label,/重新选择/);
    // Read-only shared canvases cannot mutate either fields or editor strokes.
    const readonly=await page.evaluate(id=>{
        selectedId=id;selectedIds=[];sharedCanvasReadOnly=true;render();updateComposer();
        const n=nodes.find(n=>n.id===id),before=JSON.stringify(n.fidelityConfig),el=document.querySelector('[data-id="'+id+'"] [data-pf-field="mode"]');
        el.value='view';el.dispatchEvent(new Event('change'));return {same:before===JSON.stringify(n.fidelityConfig),disabled:el.disabled};
    },id);
    assert.deepEqual(readonly,{same:true,disabled:true});
});

test('legacy node migration, inserting processor preserves manual refs, ordinary defaults and upstream execution',{timeout:40000},async t=>{
    const {page,paid}=await fixture(t);
    const converted=await page.evaluate(()=>{
        const old={id:'old',type:'smart-paint',productFidelityNode:true,images:[{url:'/fixture/legacy.png',kind:'image'}],runSettings:{productFidelity:{enabled:true,mode:'structure',detail:{highPassGain:3}}}};
        normalizeLegacySmartNode(old);const migrated={type:old.type,image:old.images[0].url,gain:old.fidelityConfig.detail.highPassGain};
        nodes=[{id:'source',type:'smart-upload',images:[{url:'/fixture/A.png',kind:'image'},{url:'/fixture/B.png',kind:'image'}]},
            {id:'p',type:'smart-paint',x:1300,y:120,images:[],manualInputRefs:[{url:'/fixture/C.png',kind:'image'}],inputRefOrder:['url|/fixture/C.png','source|1','source|0'],runSettings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'gemini-3.1-flash-image'}}];
        canvas.connections=[{from:'source',to:'p',kind:'input'}];canvasUsesConnections=true;selectedId='p';selectedIds=[];render();updateComposer();
        openProductFidelity();
        const p=nodes.find(n=>n.id==='p'),source=selectedNode();
        return {migrated,type:source.type,refs:productFidelityInputImages(source).map(r=>r.url),downstream:referenceImagesFor(p).map(r=>r.url),
            inputMirror:p.inputNodeIds,sourceId:source.id,manual:source.manualInputRefs.length};
    });
    assert.deepEqual(converted.migrated,{type:'smart-product-fidelity',image:'/fixture/legacy.png',gain:3});
    assert.equal(converted.type,'smart-product-fidelity');
    assert.deepEqual(converted.refs,['/fixture/C.png','/fixture/B.png','/fixture/A.png']);
    assert.deepEqual(converted.downstream,converted.refs);assert.deepEqual(converted.inputMirror,[converted.sourceId]);assert.equal(converted.manual,1);
    assert.equal(paid.length,0);
    const dependency=await page.evaluate(async()=>{
        const source=selectedNode(),paint=nodes.find(n=>n.id==='p'),upload=nodes.find(n=>n.id==='source');
        upload.type='smart-paint';upload.images=[];setPromptDraftForNode(upload,'先生成产品');
        upload.runSettings={engine:'api',apiKind:'image',provider_id:'fixture',model:'gpt-image-2',count:1};
        const seen=[],execute=executeSmartDependencyNode;
        executeSmartDependencyNode=async node=>{seen.push(node.id);return execute(node);};
        const result=await runSmartNodeWithDependencies(paint,async node=>{seen.push(node.id);return {ok:true,refs:referenceImagesFor(node).map(r=>r.url),config:smartSettingsForNode(node).productFidelity};});
        executeSmartDependencyNode=execute;
        rememberRecentSmartSettings(smartSettingsForNode(paint),paint);
        canvasDefaultSmartSettings={...canvasDefaultSmartSettings,productFidelity:source.fidelityConfig};
        return {seen,result,executable:smartDependencyExecutable(source),old:smartSettingsForNode({id:'ordinary',type:'smart-paint',runSettings:{engine:'api'}}).productFidelity,fresh:recentSmartSettingsForMode('api:image').productFidelity};
    });
    assert.equal(dependency.result.ok,true,JSON.stringify(dependency.result));assert.deepEqual(dependency.seen,['source','p']);
    assert.ok(dependency.result.refs.includes('/fixture/result.png'));
    assert.equal(dependency.result.config.sourceNodeId,converted.sourceId);assert.equal(dependency.executable,false);
    assert.equal(dependency.old,undefined);assert.equal(dependency.fresh,undefined);
});
