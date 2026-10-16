const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');

async function fixture(t){
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1900,height:1100}});
    const errors=[],previews=[],paid=[],uploads=[];
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
        if(url.pathname==='/api/ai/upload'){
            const multipart=req.postDataBuffer(),start=multipart.indexOf('\r\n\r\n')+4,end=multipart.lastIndexOf('\r\n--');
            uploads.push(multipart.subarray(start,end));
            return route.fulfill({json:{files:[{url:'/fixture/mask-'+uploads.length+'.png',name:'保护蒙版.png'}]}});
        }
        const maskMatch=url.pathname.match(/^\/fixture\/mask-(\d+)\.png$/);
        if(maskMatch)return route.fulfill({contentType:'image/png',body:uploads[Number(maskMatch[1])-1]});
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
    return {page,previews,paid,uploads,stored:()=>stored};
}
async function install(page){
    return page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:50,y:260,images:[{url:'/fixture/A.png',kind:'image',name:'产品正面'},{url:'/fixture/B.png',kind:'image',name:'产品细节'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();render();
        openCreateMenu({clientX:600,clientY:160},{point:{x:900,y:510},pendingConnection:{fromId:'product',fromPort:'out'}});
    });
}
async function showSetting(node,key){
    await node.locator('[data-pf-ui-mode="all"]').click();
    const input=node.locator('[data-pf-field="'+key+'"]');
    const summaries=await input.evaluate(el=>{
        const result=[];for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)result.unshift(parent.querySelector('summary').textContent);
        return result;
    });
    for(const label of summaries)await node.locator('summary').filter({hasText:label}).click();
}

test('editor follows the three steps and keeps single and multiple product names readable',{timeout:45000},async t=>{
    const {page,previews,paid}=await fixture(t);
    await page.route('**/fixture/portrait.png',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1501" height="2048"><defs><linearGradient id="paper" x2="1" y2="1"><stop stop-color="#fafafa"/><stop offset="1" stop-color="#e6e6eb"/></linearGradient></defs><rect width="1501" height="2048" fill="#f4f4f5"/><rect x="65" y="65" width="1371" height="1918" fill="#353337"/><rect x="135" y="135" width="1231" height="1778" fill="url(#paper)"/></svg>'}));
    const name='黑色相框 60×80.png',id=await page.evaluate(name=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/portrait.png',kind:'image',name:encodeURIComponent(name)}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const node=createProductFidelityNodeAt({x:900,y:510});connectInputNode('product',node.id);selectedId=node.id;render();return node.id;
    },name);
    const node=page.locator('.image-node[data-id="'+id+'"]');
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    assert.equal(await node.locator('[data-pf-source-name]').textContent(),name);
    assert.equal(await node.locator('[data-pf-source-name]').getAttribute('title'),name);
    assert.equal(await node.locator('[data-pf-field="productReferenceId"]').isVisible(),false);
    assert.equal(await node.locator('[data-pf-source-info]').textContent(),'1501 × 2048 · 原图');
    assert.equal(await node.locator('[data-pf-brush-size]').textContent(),'60 px');
    assert.equal(await page.evaluate(()=>fidelityReferenceLabel({name:'100% 原图.png'},0)),'100% 原图.png');
    const steps=await node.locator('.pf-image-heading strong,[data-pf-ui-panel="simple"] h2').allTextContents();
    assert.deepEqual(steps,['1. 选择商品原图','2. 标记保留区域','3. 选择出图方式']);
    const tools=await node.locator('.pf-toolbar-card').boundingBox(),image=await node.locator('.pf-canvas-stage').boundingBox(),actions=await node.locator('.pf-control-actions').boundingBox();
    assert.ok(tools.y+tools.height<=image.y+1&&image.y+image.height<=actions.y,'tools, image and history follow the editing order');
    await node.locator('[data-pf-brush]').fill('8');
    assert.equal(await node.locator('[data-pf-brush-size]').textContent(),'120 px');
    await page.evaluate(id=>{render({nodeIds:[id]});},id);
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    assert.equal(await node.locator('[data-pf-brush]').inputValue(),'8');
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await node.locator('[data-pf-brush]').evaluate(el=>el.blur());await page.mouse.move(10,10);
        await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-protection-steps-light.png')});
        await node.locator('.pf-image-column').screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-protection-editor-light.png')});
    }
    await page.evaluate(id=>{
        const product=nodes.find(n=>n.id==='product');product.images.push({url:'/fixture/B.png',kind:'image',name:encodeURIComponent('细节图.png')});
        bindProductFidelityNode(document.querySelector('[data-id="'+id+'"]'),nodes.find(n=>n.id===id));
    },id);
    const selection=node.locator('[data-pf-field="productReferenceId"]');
    await selection.selectOption({label:'细节图.png'});
    await page.waitForFunction(()=>document.querySelector('[data-pf-source-info]').textContent==='600 × 450 · 原图');
    assert.equal(await selection.isVisible(),true);
    assert.equal(await selection.getAttribute('title'),'细节图.png');
    assert.equal(await node.locator('[data-pf-brush-size]').textContent(),'36 px');
    await page.evaluate(id=>{const n=nodes.find(item=>item.id===id);n.w=760;n.h=700;render();applyTheme('dark');},id);
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    await node.locator('.pf-control-actions').scrollIntoViewIfNeeded();
    assert.equal(await node.locator('[data-pf-root]').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    const narrowTools=await node.locator('.pf-toolbar-card').boundingBox(),narrowActions=await node.locator('.pf-control-actions').boundingBox();
    assert.ok(narrowTools.y+narrowTools.height<narrowActions.y);
    await node.locator('[data-pf-expand]').click();
    await page.waitForFunction(()=>document.querySelector('[data-pf-expand]').getAttribute('aria-expanded')==='true');
    assert.equal(await node.locator('[data-pf-expand]').textContent(),'收起编辑');
    const popover=await node.locator('.pf-image-column').boundingBox();
    assert.ok(popover.x>=0&&popover.y>=0&&popover.x+popover.width<=1900&&popover.y+popover.height<=1100);
    await node.locator('[data-pf-expand]').click();
    assert.equal(previews.length,0);assert.equal(paid.length,0);
});

test('canvas tools show only relevant controls and clear the selected kind',{timeout:45000},async t=>{
    const {page}=await fixture(t);
    const id=await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/A.png',kind:'image',name:'产品主图'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const node=createProductFidelityNodeAt({x:900,y:510});connectInputNode('product',node.id);selectedId=node.id;render();return node.id;
    });
    const node=page.locator('.image-node[data-id="'+id+'"]'),editor=node.locator('[data-pf-canvas]');
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    assert.deepEqual(await node.locator('[data-pf-tool]').allTextContents(),['涂抹商品','橡皮擦','框选商品']);
    assert.equal(await node.locator('[data-pf-field="enabled"]').count(),0);
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.enabled,id),true);
    assert.equal(await page.evaluate(id=>{const item=nodes.find(n=>n.id===id);item.fidelityConfig.enabled=false;normalizeProductFidelityNode(item);return item.fidelityConfig.enabled;},id),true);
    assert.equal(await node.locator('.pf-brush').isVisible(),true);
    assert.equal(await node.locator('[data-pf-action="clear-mask"]').isVisible(),true);
    assert.equal(await node.locator('[data-pf-action="clear-rois"]').isVisible(),false);
    const box=await editor.boundingBox();
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.4,box.y+box.height*.4,{steps:5});await page.mouse.up();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),1);
    await node.locator('[data-pf-tool="erase"]').click();
    assert.equal(await node.locator('.pf-brush').isVisible(),true);
    assert.equal(await node.locator('[data-pf-action="clear-mask"]').isVisible(),true);
    assert.match(await node.locator('[data-pf-roi-info]').textContent(),/擦掉不小心涂出/);
    await node.locator('[data-pf-tool="rect"]').click();
    await page.waitForTimeout(200);
    const activeColors=await node.locator('[data-pf-tool="rect"]').evaluate(el=>({text:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));
    assert.notEqual(activeColors.text,activeColors.background);
    assert.equal(await node.locator('.pf-brush').isVisible(),false);
    assert.equal(await node.locator('[data-pf-roi-hint]').isVisible(),true);
    assert.equal(await node.locator('[data-pf-action="clear-mask"]').isVisible(),true);
    assert.equal(await node.locator('[data-pf-action="clear-rois"]').isVisible(),false);
    assert.match(await node.locator('[data-pf-roi-info]').textContent(),/框内背景也会被保留/);
    await page.mouse.move(box.x+box.width*.15,box.y+box.height*.15);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.25,box.y+box.height*.25,{steps:5});await page.mouse.up();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),2);
    const rect=await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes[1].rect,id);
    assert.ok(rect[0]>=0&&rect[1]>=0&&rect[0]+rect[2]<=1&&rect[1]+rect[3]<=1);
    assert.ok(Math.abs(rect[2]-.1)<.01&&Math.abs(rect[3]-.1)<.01);
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.rois.length,id),0);
    await showSetting(node,'detail.cropCount');
    await node.locator('[data-pf-action="manual-rois"]').click();
    assert.doesNotMatch(await node.locator('[data-pf-roi-info]').textContent(),/已圈/);
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.45);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.55,{steps:5});await page.mouse.up();
    assert.match(await node.locator('[data-pf-roi-info]').textContent(),/已圈 1 处/);
    await node.locator('[data-pf-action="clear-rois"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.rois.length,id),0);
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),2);
    await node.locator('[data-pf-tool="mask"]').click();
    await node.locator('[data-pf-action="clear-mask"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),0);
    assert.equal(await node.locator('.pf-brush').isVisible(),true);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await page.evaluate(id=>{const n=nodes.find(item=>item.id===id);n.w=760;n.h=700;render();applyTheme('dark');},id);
        await node.locator('.pf-toolbar-card').scrollIntoViewIfNeeded();
        assert.equal(await node.locator('[data-pf-root]').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
        await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-toolbar-narrow-dark.png')});
    }
});

test('simple and all views share the original config and guard linked changes',{timeout:45000},async t=>{
    const {page,paid,previews}=await fixture(t);
    const id=await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/A.png',kind:'image',name:'产品主图'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const node=createProductFidelityNodeAt({x:900,y:510});connectInputNode('product',node.id);selectedId=node.id;render();return node.id;
    });
    const node=page.locator('.image-node[data-id="'+id+'"]');
    assert.equal(await node.locator('[data-pf-ui-mode="simple"]').getAttribute('aria-selected'),'true');
    assert.match(await node.locator('[data-pf-mode-explanation]').textContent(),/已选：仅换背景.*左侧仍显示商品原图/);
    assert.equal(await node.locator('[data-pf-simple-view-open]').isVisible(),false);
    assert.equal(await node.locator('[data-pf-group]').count(),8);
    assert.equal(await node.locator('[data-pf-action="preview"]').textContent(),'应用并生成锁定图');
    assert.equal(await node.locator('[data-pf-status]').textContent(),'设置已就绪，点击右侧按钮即可生效');
    assert.equal(await node.locator('.pf-footer-action span').count(),0);
    assert.equal(await node.locator('.pf-asset-panel').isVisible(),false);
    assert.match(await node.locator('[data-pf-route]').textContent(),/^将本节点连线至「AI生图」节点/);
    await node.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(id=>Boolean(nodes.find(item=>item.id===id).fidelityPreview),id);
    assert.equal(await node.locator('.pf-asset-panel').isVisible(),false);
    const get=()=>page.evaluate(id=>JSON.stringify(nodes.find(item=>item.id===id).fidelityConfig),id);
    const previewSignature=await page.evaluate(id=>nodes.find(item=>item.id===id).fidelityPreview.signature,id);
    const before=await get();
    await node.locator('[data-pf-ui-mode="all"]').click();
    assert.equal(await node.locator('.pf-asset-panel').isVisible(),true);
    await node.locator('[data-pf-ui-mode="simple"]').click();
    assert.equal(await node.locator('.pf-asset-panel').isVisible(),false);
    assert.equal(await get(),before,'view switching leaves generation settings untouched');
    assert.equal(await page.evaluate(id=>nodes.find(item=>item.id===id).fidelityPreview?.signature,id),previewSignature,'view switching keeps local reference assets');
    assert.equal(previews.length,1);
    await showSetting(node,'category');
    await node.locator('[data-pf-field="category"]').selectOption('frame');
    await node.locator('[data-pf-ui-mode="simple"]').click();
    assert.equal(await node.locator('[data-pf-custom-warning]').isVisible(),true);
    const customized=await get();
    await node.locator('[data-pf-preset="structure"]').click();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="cancel"]').click();
    assert.equal(await get(),customized);
    assert.match(await node.locator('[data-pf-mode-title]').textContent(),/仅换背景/);
    await node.locator('[data-pf-preset="structure"]').click();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(item=>item.id===id).fidelityConfig.mode,id),'structure');
    assert.match(await node.locator('[data-pf-mode-explanation]').textContent(),/已选：光影融合.*商品的颜色和细节可能变化/);
    await node.locator('[data-pf-simple-dimensions]').check();
    if(await page.locator('.pf-confirm-dialog').count())await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    await node.locator('[data-pf-simple-dimension="width"]').fill('30');
    await node.locator('[data-pf-simple-dimension="height"]').fill('40');
    await node.locator('[data-pf-ui-mode="all"]').click();
    await node.locator('[data-pf-group="size"] > summary').click();
    assert.equal(await node.locator('[data-pd-field="width"]').inputValue(),'30');
    await node.locator('[data-pd-field="unit"]').selectOption('mm');
    assert.equal(await node.locator('[data-pd-field="width"]').inputValue(),'300');
    await node.locator('[data-pf-ui-mode="simple"]').click();
    assert.equal(await node.locator('[data-pf-simple-dimension="width"]').inputValue(),'300');
    assert.equal(await page.evaluate(id=>nodes.find(item=>item.id===id).fidelityConfig.dimensions.width,id),300);
    await node.locator('[data-pf-ui-mode="all"]').click();
    await node.locator('[data-pd-field="constraintMode"]').selectOption('protect');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="cancel"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(item=>item.id===id).fidelityConfig.dimensions.constraintMode,id),'prompt');
    await node.locator('[data-pd-field="constraintMode"]').selectOption('protect');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    await node.locator('[data-pf-ui-mode="simple"]').click();
    await node.locator('[data-pf-preset="view"]').click();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="cancel"]').click();
    assert.deepEqual(await page.evaluate(id=>{const c=nodes.find(item=>item.id===id).fidelityConfig;return [c.mode,c.dimensions.constraintMode];},id),['strict','protect']);
    assert.match(await node.locator('[data-pf-mode-title]').textContent(),/仅换背景/);
    await node.locator('[data-pf-preset="view"]').click();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.deepEqual(await page.evaluate(id=>{const c=nodes.find(item=>item.id===id).fidelityConfig;return [c.mode,c.dimensions.constraintMode,c.dimensions.width];},id),['view','prompt',300]);
    assert.match(await node.locator('[data-pf-mode-explanation]').textContent(),/已选：换拍摄角度.*下游「绘画（AI 生图）」出图时看到/);
    assert.equal(await node.locator('[data-pf-simple-view-open]').isEnabled(),true);
    await node.locator('[data-pf-simple-view-open]').click();
    const viewDialog=page.locator('dialog.pf-view-dialog');
    await viewDialog.locator('[data-pf-view-preset="right"]').click();
    await viewDialog.locator('[data-pf-view-apply]').click();
    assert.match(await node.locator('[data-pf-simple-view-summary]').textContent(),/相机向右 45°/);
    assert.match(await node.locator('[data-pf-mode-next]').textContent(),/角度已设置/);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-protection-wide-light.png')});
    }
    const light=await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color);
    await page.evaluate(id=>{const n=nodes.find(item=>item.id===id);n.w=760;n.h=700;render();applyTheme('dark');},id);
    assert.equal(await node.locator('.pf-layout').evaluate(el=>getComputedStyle(el).display),'block');
    assert.equal(await node.locator('[data-pf-root]').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.notEqual(await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color),light);
    await node.locator('.pf-layout').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    assert.equal(await node.locator('[data-pf-preset="view"]').isVisible(),true);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-protection-narrow-dark.png')});
    }
    assert.equal(paid.length,0);
});

test('dual view navigation, editor undo and actionable local validation',{timeout:45000},async t=>{
    const {page,paid,previews}=await fixture(t);
    const id=await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/A.png',kind:'image',name:'1234567890123456789.png'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const n=createProductFidelityNodeAt({x:900,y:510});connectInputNode('product',n.id);selectedId=n.id;render();return n.id;
    });
    const node=page.locator('.image-node[data-id="'+id+'"]');
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    assert.equal(await node.locator('[data-pf-field="productReferenceId"] option:checked').textContent(),'产品图 1');
    assert.equal(await node.locator('[data-pf-field="productReferenceId"]').evaluate(el=>Boolean(el.closest('.pf-image-column'))),true);
    assert.equal(await node.locator('[data-pf-field="detail.highPassRadiusPx"]').isVisible(),false);
    const config=await page.evaluate(id=>JSON.stringify(nodes.find(n=>n.id===id).fidelityConfig),id);
    await node.locator('[data-pf-ui-mode="simple"]').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await node.locator('[data-pf-ui-mode="all"]').getAttribute('aria-selected'),'true');
    assert.equal(await node.locator('[data-pf-ui-panel="simple"]').isVisible(),false);
    await showSetting(node,'view.enabled');
    await node.locator('[data-pf-field="view.enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    await node.locator('[data-pf-view-open]').click();
    const viewDialog=page.locator('dialog.pf-view-dialog');
    await viewDialog.locator('[data-pf-view-preset="right"]').click();
    assert.equal(await viewDialog.locator('[data-pf-view-number="yaw"]').inputValue(),'45');
    assert.equal(await viewDialog.locator('[data-pf-view-preset="right"]').getAttribute('aria-pressed'),'true');
    await viewDialog.locator('[data-pf-view-apply]').click();
    assert.match(await node.locator('[data-pf-view-summary]').textContent(),/相机向右 45°/);
    await node.locator('[data-pf-view-open]').click();
    await viewDialog.locator('[data-pf-view-number="yaw"]').fill('15');await viewDialog.locator('[data-pf-view-number="yaw"]').press('Tab');
    assert.equal(await viewDialog.locator('[data-pf-view-preset="right"]').getAttribute('aria-pressed'),'false');
    await viewDialog.locator('[data-pf-view-apply]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.view.yaw,id),15);
    assert.equal(paid.length,0,'choosing a viewpoint is local until paint runs');
    await node.locator('[data-pf-ui-mode="all"]').focus();await page.keyboard.press('End');
    assert.equal(await node.locator('[data-pf-ui-mode="all"]').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    assert.equal(await node.locator('[data-pf-ui-mode="simple"]').getAttribute('aria-selected'),'true');
    await node.locator('[data-pf-history="undo"]').click();await node.locator('[data-pf-history="undo"]').click();await node.locator('[data-pf-history="undo"]').click();
    assert.equal(await page.evaluate(id=>JSON.stringify(nodes.find(n=>n.id===id).fidelityConfig),id),config);
    const editor=node.locator('[data-pf-canvas]'),box=await editor.boundingBox();
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:5});await page.mouse.up();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),1);
    await node.locator('[data-pf-history="undo"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),0);
    await node.locator('[data-pf-history="redo"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),1);
    await node.locator('[data-pf-brush]').focus();
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.35);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.65,box.y+box.height*.35,{steps:5});await page.mouse.up();
    assert.equal(await editor.evaluate(el=>document.activeElement===el),true,'drawing takes focus from the brush size slider');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),2);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),1);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),2);
    await showSetting(node,'category');await node.locator('[data-pf-field="category"]').focus();
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.maskStrokes.length,id),2,'shortcuts in settings controls do not undo canvas edits');
    await node.locator('[data-pf-group="size"] > summary').click();
    assert.equal(await node.locator('[data-pf-validation-status]').isVisible(),false);
    assert.equal(await node.locator('[data-pd-content]').isVisible(),false);
    await node.locator('[data-pd-field="enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.equal(await node.locator('[data-pf-action="preview"]').isDisabled(),true);
    assert.match(await node.locator('[data-pf-validation-status]').textContent(),/产品尺寸/);
    await node.locator('[data-pd-field="width"]').fill('30');await node.locator('[data-pd-field="height"]').fill('40');
    assert.equal(await node.locator('[data-pf-validation-status]').isVisible(),false);
    assert.equal(await node.locator('[data-pf-action="preview"]').isEnabled(),true);
    await page.route('**/api/product-fidelity/preview',route=>route.fulfill({status:400,json:{detail:'请重新选择有效蒙版'}}));
    await node.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-pf-status]').textContent==='请重新选择有效蒙版');
    assert.equal(await node.locator('[data-pf-action="preview"]').isEnabled(),true);
    assert.equal(paid.length,0);assert.equal(previews.length,0);
    await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);n.w=760;n.h=650;render();},id);
    assert.equal(await node.locator('[data-pf-ui-mode="all"]').getAttribute('aria-selected'),'true');
    assert.equal(await node.locator('[data-pf-root]').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
});

test('viewpoint drag, reverse preset and framing reach the downstream image request',{timeout:45000},async t=>{
    const {page,paid}=await fixture(t);
    const id=await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/A.png',kind:'image',name:'产品主图'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const fidelity=createProductFidelityNodeAt({x:850,y:510});connectInputNode('product',fidelity.id);
        const paint=createNode(1550,250,[],{nodeType:'smart-paint',title:'绘画'});
        paint.runSettings={engine:'api',apiKind:'image',provider_id:'fixture',model:'gpt-image-2',count:1,ratio:'4:3'};
        connectInputNode(fidelity.id,paint.id);selectedId=fidelity.id;render();return fidelity.id;
    });
    const node=page.locator('.image-node[data-id="'+id+'"]');
    await showSetting(node,'view.enabled');
    await node.locator('[data-pf-field="view.enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.match(await node.locator('[data-pf-view-summary]').textContent(),/原图俯仰/);
    await node.locator('[data-pf-view-open]').click();
    const dialog=page.locator('dialog.pf-view-dialog'),orbit=dialog.locator('[data-pf-view-orbit]'),box=await orbit.boundingBox();
    assert.ok(await orbit.locator('svg.pf-view-globe path').count()>40,'the orbit uses a dense spherical grid');
    const globeWidth=(await orbit.locator('svg.pf-view-globe').boundingBox()).width;
    await dialog.locator('[data-pf-view-framing]').fill('0');
    assert.equal(await dialog.locator('[data-pf-view-framing-label]').textContent(),'远景');
    await page.waitForTimeout(230);
    const wide=(await orbit.locator('img').boundingBox()).width;
    const wideGlobeWidth=(await orbit.locator('svg.pf-view-globe').boundingBox()).width;
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await dialog.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'view-orbit-wide.png')});
    }
    await dialog.locator('[data-pf-view-framing]').fill('4');
    assert.equal(await dialog.locator('[data-pf-view-framing-label]').textContent(),'特写');
    await page.waitForTimeout(230);
    const closeup=(await orbit.locator('img').boundingBox()).width;
    const closeupGlobeWidth=(await orbit.locator('svg.pf-view-globe').boundingBox()).width;
    assert.ok(closeup>wide*1.7,'framing visibly scales the product inside the sphere');
    assert.ok(wideGlobeWidth<globeWidth&&closeupGlobeWidth>globeWidth,'the wire sphere scales with framing');
    if(process.env.FIDELITY_SCREENSHOT_DIR)await dialog.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'view-orbit-closeup.png')});
    await dialog.locator('[data-pf-view-framing]').fill('2');
    await dialog.locator('[data-pf-view-range="yaw"]').fill('15');
    await dialog.locator('[data-pf-view-range="pitch"]').fill('-15');
    const previewLayers=await orbit.evaluate(el=>{
        const image=el.querySelector('img'),marker=el.querySelector('[data-pf-view-marker]'),globe=el.querySelector('[data-pf-view-globe]');
        const imageBox=image.getBoundingClientRect(),markerBox=marker.getBoundingClientRect(),globeBox=globe.getBoundingClientRect();
        const cx=globeBox.left+globeBox.width/2,cy=globeBox.top+globeBox.height/2,radius=globeBox.width*92/240;
        const corners=[[imageBox.left,imageBox.top],[imageBox.right,imageBox.top],[imageBox.left,imageBox.bottom],[imageBox.right,imageBox.bottom]];
        return {
            imageInsideSphere:corners.every(([x,y])=>Math.hypot(x-cx,y-cy)<radius),
            cameraOverImage:markerBox.left<imageBox.right&&markerBox.right>imageBox.left&&markerBox.top<imageBox.bottom&&markerBox.bottom>imageBox.top,
            cameraAboveImage:Number(getComputedStyle(marker).zIndex)>Number(getComputedStyle(image).zIndex)
        };
    });
    assert.deepEqual(previewLayers,{imageInsideSphere:true,cameraOverImage:true,cameraAboveImage:true});
    if(process.env.FIDELITY_SCREENSHOT_DIR)await dialog.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'view-orbit-camera-overlay.png')});
    await dialog.locator('[data-pf-view-framing]').fill('4');
    await dialog.locator('[data-pf-view-range="yaw"]').fill('0');
    await dialog.locator('[data-pf-view-range="pitch"]').fill('0');
    const gridBefore=await orbit.locator('svg.pf-view-globe path').first().getAttribute('d');
    await orbit.locator('[data-pf-view-nudge="right"]').click();
    assert.equal(await dialog.locator('[data-pf-view-number="yaw"]').inputValue(),'15');
    assert.notEqual(await orbit.locator('svg.pf-view-globe path').first().getAttribute('d'),gridBefore,'the wire grid rotates with the camera');
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.mouse.move(box.x+box.width/2+65,box.y+box.height/2-35,{steps:5});await page.mouse.up();
    assert.ok(Number(await dialog.locator('[data-pf-view-number="yaw"]').inputValue())>35);
    assert.ok(Number(await dialog.locator('[data-pf-view-number="pitch"]').inputValue())>15);
    await dialog.locator('[data-pf-view-preset="back"]').click();
    await dialog.locator('[data-pf-view-framing]').fill('4');
    await dialog.locator('.pf-view-advanced summary').click();
    await dialog.locator('[data-pf-view-fisheye]').check();
    assert.match(await dialog.locator('[data-pf-view-warning]').textContent(),/产品外形变形/);
    await dialog.locator('[data-pf-view-preset="back"]').focus();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(id=>nodes.some(n=>n.id===id&&n.fidelityConfig.view.enabled),id),true,'dialog keys leave the canvas untouched');
    await dialog.locator('[data-pf-view-apply]').click();
    const saved=await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.view,id);
    assert.equal(saved.yaw,180);assert.equal(saved.framing,'closeup');assert.equal(saved.fov,110);
    assert.equal(paid.length,0);
    await node.locator('[data-pf-view-open]').click();
    await dialog.locator('[data-pf-view-preset="original"]').click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(),0,'Escape closes the editor');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.view.yaw,id),180,'cancel keeps the saved viewpoint');
    const run=await page.evaluate(()=>{const paint=nodes.find(n=>n.type==='smart-paint');return runGenerationDirect('default',null,'展示产品背面',paint,smartSettingsForNode(paint));});
    assert.equal(run.ok,true,JSON.stringify(run));
    assert.equal(paid.length,1);
    assert.equal(paid[0].product_fidelity.view.yaw,180);
    assert.equal(paid[0].product_fidelity.view.framing,'closeup');
    assert.equal(paid[0].product_fidelity.view.fov,110);
    const conflict=await page.evaluate(()=>{
        const paint=nodes.find(n=>n.type==='smart-paint'),camera=createCameraNode(1450,700);
        connectInputNode('product',camera.id);connectInputNode(camera.id,paint.id);
        try{validateProductFidelityRun(paint,smartSettingsForNode(paint));return '';}
        catch(error){return error.message;}
    });
    assert.match(conflict,/只保留一个视角来源/);
    await node.locator('[data-pf-group="size"] > summary').click();
    await node.locator('[data-pd-field="enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    await node.locator('[data-pd-field="width"]').fill('30');
    await node.locator('[data-pd-field="height"]').fill('20');
    await node.locator('[data-pd-field="constraintMode"]').selectOption('protect');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.deepEqual(await page.evaluate(id=>{
        const c=nodes.find(n=>n.id===id).fidelityConfig;
        return [c.mode,c.view.enabled,c.dimensions.constraintMode];
    },id),['strict',false,'protect']);
    await showSetting(node,'view.enabled');
    await node.locator('[data-pf-field="view.enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.deepEqual(await page.evaluate(id=>{
        const c=nodes.find(n=>n.id===id).fidelityConfig;
        return [c.mode,c.view.enabled,c.dimensions.constraintMode];
    },id),['view',true,'prompt']);
});
test('dedicated inline processor, local editing, live downstream generation and reference order',{timeout:60000},async t=>{
    const {page,previews,paid,stored}=await fixture(t);await install(page);
    const card=page.locator('[data-create-type="product-fidelity"]');assert.equal(await card.locator('.create-card-title').textContent(),'产品保护');await card.click();
    const id=await page.evaluate(()=>selectedNode().id),node=page.locator('.image-node[data-id="'+id+'"]');
    assert.equal(await page.evaluate(()=>selectedNode().type),'smart-product-fidelity');
    assert.equal(await page.evaluate(()=>selectedNode().fidelityConfig.enabled),true);
    assert.equal(await page.evaluate(()=>selectedNode().runSettings),undefined,'processor owns no generation settings');
    assert.equal(await page.locator('.product-fidelity-dialog').count(),0);
    assert.equal(await page.locator('#composer').evaluate(el=>el.classList.contains('open')),false,'processor has no prompt or model composer');
    assert.deepEqual(await node.locator('[data-pf-ui-mode]').allTextContents(),['简单设置','全部设置']);
    assert.equal(await node.getByText('失败重试',{exact:true}).count(),0);
    assert.equal(await node.locator('[data-pf-field="categoryCustom"]').isVisible(),false);
    await showSetting(node,'category');
    const categoryLayout=await node.locator('[data-pf-field="category"]').evaluate(select=>{
        const label=select.closest('.pf-field').querySelector('span').getBoundingClientRect();
        const input=select.getBoundingClientRect();
        return {stacked:input.top>label.bottom,height:input.height,radius:parseFloat(getComputedStyle(select).borderTopLeftRadius)};
    });
    assert.equal(categoryLayout.stacked,true);
    assert.ok(categoryLayout.height>=38&&categoryLayout.radius>=7,JSON.stringify(categoryLayout));
    await node.locator('[data-pf-field="category"]').selectOption('other');
    await node.locator('[data-pf-field="categoryCustom"]').fill('入户门垫');
    await node.locator('[data-pf-field="categoryCustom"]').dispatchEvent('change');
    await node.locator('[data-pf-field="geometry"]').selectOption('custom');
    await node.locator('[data-pf-field="geometryCustom"]').fill('半圆形带直边');
    await node.locator('[data-pf-field="geometryCustom"]').dispatchEvent('change');
    await node.locator('[data-pf-field="category"]').selectOption('textile');
    assert.equal(await node.locator('[data-pf-field="categoryCustom"]').isVisible(),false);
    await node.locator('[data-pf-field="category"]').selectOption('other');
    assert.equal(await node.locator('[data-pf-field="categoryCustom"]').inputValue(),'入户门垫');
    assert.ok(await node.locator('[data-pf-field="geometry"] option').count()>=12);
    assert.equal(await node.locator('[data-pf-group="detail"] > summary').textContent(),'Logo、文字与纹理');
    const selection=node.locator('[data-pf-field="productReferenceId"]');
    const ids=await selection.locator('option').evaluateAll(els=>els.map(e=>e.value));assert.equal(new Set(ids).size,2);
    await selection.selectOption(ids[1]);
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    const editor=node.locator('[data-pf-canvas]'),box=await editor.boundingBox();
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.7,{steps:12});await page.mouse.up();
    await showSetting(node,'detail.cropCount');
    await node.locator('[data-pf-action="manual-rois"]').click();
    await page.mouse.move(box.x+box.width*.35,box.y+box.height*.35);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.55,{steps:5});await page.mouse.up();
    await node.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(id=>nodes.find(n=>n.id===id).fidelityPreview,id);
    assert.equal(paid.length,0);assert.equal(previews.length,1);assert.equal(previews[0].local_only,true);
    assert.equal(previews[0].provider_id,'');assert.equal(previews[0].model,'');
    assert.equal(previews[0].product_fidelity.productReferenceId,ids[1]);
    assert.equal(previews[0].product_fidelity.rois.length,1);assert.ok(previews[0].product_fidelity.maskStrokes[0].points.length>5);
    assert.deepEqual(previews[0].reference_images.map(r=>r.url),['/fixture/A.png','/fixture/B.png']);
    await showSetting(node,'advanced.enabled');
    await node.locator('[data-pf-field="advanced.enabled"]').check();
    const radius=node.locator('[data-pf-field="detail.highPassRadiusPx"]');await radius.fill('5');await radius.dispatchEvent('change');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityPreview,id),undefined,'local controls invalidate stale preview');
    await showSetting(node,'detail.autoCrops');
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
    await showSetting(node,'mode');
    await node.locator('[data-pf-field="mode"]').selectOption('structure');
    await showSetting(node,'detail.restoreMode');
    await node.locator('[data-pf-field="detail.restoreMode"]').selectOption('auto');
    await showSetting(node,'mode');
    await node.locator('[data-pf-field="mode"]').selectOption('view');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.equal(await node.locator('[data-pf-field="detail.restoreMode"]').isDisabled(),true);
    assert.equal(await node.locator('[data-pf-field="detail.restoreMode"]').inputValue(),'off');
    await node.locator('[data-pf-field="mode"]').selectOption('strict');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="cancel"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.view.enabled,id),true);
    await node.locator('[data-pf-field="mode"]').selectOption('strict');
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    // Generate through the actual dependency runner, task client and poll parser.
    const run=await page.evaluate(()=>{const p=nodes.find(n=>n.id==='paint');return runSmartNodeWithDependencies(p,n=>runGenerationDirect('default',null,'放在简洁的摄影棚背景中',n,smartSettingsForNode(n)));});
    assert.equal(run.ok,true,JSON.stringify(run));assert.equal(paid.length,1,'only downstream paint makes a paid submission');
    assert.equal(paid[0].product_fidelity.sourceNodeId,id);assert.equal(paid[0].product_fidelity.productReferenceId,ids[1]);
    assert.equal(paid[0].product_fidelity.detail.highPassRadiusPx,5,'latest control edits apply without preview');
    assert.equal(paid[0].product_fidelity.categoryCustom,'入户门垫');
    assert.equal(paid[0].product_fidelity.geometryCustom,'半圆形带直边');
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
    // Disconnecting the processor removes its inherited protection.
    const detached=await page.evaluate(id=>{
        const p=nodes.find(n=>n.id==='paint');
        canvas.connections=canvas.connections.filter(c=>!(c.from===id&&c.to===p.id));const disconnected=smartSettingsForNode(p).productFidelity;
        connectInputNode(id,p.id);selectedId=id;selectedIds=[];render();updateComposer();return {disconnected};
    },id);
    assert.deepEqual(detached,{disconnected:undefined});
    await showSetting(node,'advanced.enabled');
    assert.equal(await node.locator('[data-pf-group="more"]').isVisible(),true);
    assert.equal(await node.locator('[data-pf-ui-panel="simple"]').isVisible(),false);
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
        for(const mode of ['simple','all','simple']){
            await node.locator('[data-pf-ui-mode="'+mode+'"]').click();
            assert.equal(await node.locator('[data-pf-ui-mode="'+mode+'"]').getAttribute('aria-selected'),'true');
            assert.equal(await node.locator('[data-pf-ui-panel="'+mode+'"]').isVisible(),true);
            assert.equal(await node.locator('[data-pf-ui-panel]:visible').count(),1);
        }
        await page.evaluate(()=>applyTheme('light'));await page.mouse.move(10,10);await page.waitForTimeout(200);await page.screenshot({path:path.join(dir,'product-fidelity-workflow-light.png')});
        const light=await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color);
        await page.evaluate(()=>applyTheme('dark'));await page.waitForTimeout(200);await page.screenshot({path:path.join(dir,'product-fidelity-workflow-dark.png')});
        assert.notEqual(await node.locator('[data-pf-root]').evaluate(el=>getComputedStyle(el).color),light);
        const contrast=await node.locator('[data-pf-field="category"]').evaluate(el=>{
            const css=getComputedStyle(el),rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number),luminance=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((total,v,i)=>total+v*[.2126,.7152,.0722][i],0);
            const text=luminance(css.color),background=luminance(css.backgroundColor);return (Math.max(text,background)+.05)/(Math.min(text,background)+.05);
        });
        assert.ok(contrast>=4.5,'dark input contrast '+contrast);
        await node.locator('[data-pf-ui-mode="all"]').click();await node.locator('[data-pf-group="size"] > summary').click();
        await node.screenshot({path:path.join(dir,'product-fidelity-inline-lower-sections.png')});
        await node.locator('[data-pf-group="detail"] > summary').click();
        await node.screenshot({path:path.join(dir,'product-fidelity-inline-detail.png')});
    }
    await page.evaluate(()=>saveCanvas());
    assert.equal(stored().nodes.find(n=>n.id===id).type,'smart-product-fidelity');
    await page.reload();await page.waitForFunction(id=>nodes.some(n=>n.id===id),id);
    const restored=await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);return {type:n.type,enabled:n.fidelityConfig.enabled,main:n.fidelityConfig.productReferenceId,refs:productFidelityInputImages(n).length};},id);
    assert.deepEqual(restored,{type:'smart-product-fidelity',enabled:true,main:ids[1],refs:2});
    assert.deepEqual(await page.evaluate(id=>{const c=nodes.find(n=>n.id===id).fidelityConfig;return [c.category,c.categoryCustom,c.geometry,c.geometryCustom];},id),['other','入户门垫','custom','半圆形带直边']);
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

test('legacy node migration, composer actions, ordinary defaults and upstream execution',{timeout:40000},async t=>{
    const {page,paid}=await fixture(t);
    const converted=await page.evaluate(()=>{
        const old={id:'old',type:'smart-paint',productFidelityNode:true,images:[{url:'/fixture/legacy.png',kind:'image'}],runSettings:{productFidelity:{enabled:true,mode:'structure',detail:{highPassGain:3}}}};
        normalizeLegacySmartNode(old);const migrated={type:old.type,image:old.images[0].url,gain:old.fidelityConfig.detail.highPassGain};
        nodes=[{id:'source',type:'smart-upload',images:[{url:'/fixture/A.png',kind:'image'},{url:'/fixture/B.png',kind:'image'}]},
            {id:'p',type:'smart-paint',x:1300,y:120,images:[],manualInputRefs:[{url:'/fixture/C.png',kind:'image'}],inputRefOrder:['url|/fixture/C.png','source|1','source|0'],runSettings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'gemini-3.1-flash-image'}}];
        canvas.connections=[{from:'source',to:'p',kind:'input'}];canvasUsesConnections=true;selectedId='p';selectedIds=[];render();updateComposer();
        const before=document.querySelectorAll('#composer [data-product-fidelity]').length;
        const source=createProductFidelityNodeAt({x:800,y:510}),p=nodes.find(n=>n.id==='p');
        canvas.connections=[];p.inputNodeIds=[];
        connectInputNode('source',source.id);connectInputNode(source.id,p.id);
        p.inputRefOrder=['url|/fixture/C.png',source.id+'|1',source.id+'|0'];
        selectedId='p';selectedIds=[];render();updateComposer();
        const after=document.querySelectorAll('#composer [data-product-fidelity]').length;
        return {migrated,type:source.type,refs:productFidelityInputImages(source).map(r=>r.url),downstream:referenceImagesFor(p).map(r=>r.url),
            inputMirror:p.inputNodeIds,sourceId:source.id,manual:p.manualInputRefs.length,before,after};
    });
    assert.deepEqual(converted.migrated,{type:'smart-product-fidelity',image:'/fixture/legacy.png',gain:3});
    assert.equal(converted.type,'smart-product-fidelity');
    assert.deepEqual(converted.refs,['/fixture/A.png','/fixture/B.png']);
    assert.deepEqual(converted.downstream,['/fixture/C.png','/fixture/B.png','/fixture/A.png']);
    assert.deepEqual(converted.inputMirror,[converted.sourceId]);assert.equal(converted.manual,1);
    assert.equal(converted.before,0,'ordinary paint has no fidelity shortcut');
    assert.equal(converted.after,0,'connected paint has no fidelity shortcut');
    assert.equal(paid.length,0);
    const dependency=await page.evaluate(async()=>{
        const source=nodes.find(n=>isProductFidelityNode(n)),paint=nodes.find(n=>n.id==='p'),upload=nodes.find(n=>n.id==='source');
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

test('settings mask exports a full-size protection PNG and imports into fidelity without generation',{timeout:40000},async t=>{
    const {page,paid,uploads,previews}=await fixture(t);
    await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:220,y:220,images:[{url:'/fixture/A.png',kind:'image',name:'产品.png'}]}];
        canvas.connections=[];canvasUsesConnections=true;selectedId='product';selectedIds=[];viewport={x:0,y:0,scale:1};applyViewport();render();
    });
    const source=page.locator('.image-node[data-id="product"]');
    await source.locator('[data-smart-node-settings]').click();
    assert.equal(await source.locator('[data-smart-node-action="mask"]').textContent().then(s=>s.trim()),'抹除');
    await source.locator('[data-smart-node-action="protection-mask"]').click();
    await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth===600&&editDrawCanvas().width===600);
    assert.equal(await page.locator('#imageEditTitle').textContent(),'保护蒙版');
    await page.locator('#imageEditApplyBtn').click();
    assert.equal(uploads.length,0,'empty drawing does not export');
    const drawing=page.locator('#editDrawCanvas'),box=await drawing.boundingBox();
    await page.mouse.move(box.x+box.width*.4,box.y+box.height*.5);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:8});await page.mouse.up();
    assert.equal(await page.locator('#maskUndoBtn').isDisabled(),false);
    await page.locator('#maskUndoBtn').click();
    assert.equal(await page.evaluate(()=>editCanvasHasPixels()),false);
    await page.locator('#maskRedoBtn').click();
    assert.equal(await page.evaluate(()=>editCanvasHasPixels()),true);
    await page.route('**/api/ai/upload',route=>route.fulfill({status:503,json:{detail:'模拟保存失败'}}));
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(()=>document.body.textContent.includes('蒙版保存失败'));
    assert.equal(await page.evaluate(()=>nodes.length),1,'failed save keeps source and drawing');
    assert.equal(await page.evaluate(()=>editCanvasHasPixels()),true);
    await page.unroute('**/api/ai/upload');
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(()=>nodes.some(n=>n.title==='保护蒙版'));
    assert.equal(uploads.length,1);assert.equal(paid.length,0);
    const pixels=await page.evaluate(async()=>{
        const node=nodes.find(n=>n.title==='保护蒙版'),ref=node.images[0],img=new Image();img.src=ref.url;await img.decode();
        const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
        const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
        return {size:[c.width,c.height],white:[...ctx.getImageData(300,225,1,1).data],black:[...ctx.getImageData(0,0,1,1).data],role:ref.role,source:nodes.find(n=>n.id==='product').images[0].url};
    });
    assert.deepEqual(pixels,{size:[600,450],white:[255,255,255,255],black:[0,0,0,255],role:'product-mask',source:'/fixture/A.png'});
    const fidelityId=await page.evaluate(()=>{
        const n=createProductFidelityNodeAt({x:850,y:530});connectInputNode('product',n.id);selectedId=n.id;render();return n.id;
    });
    const fidelity=page.locator('.image-node[data-id="'+fidelityId+'"]');
    assert.equal(await fidelity.locator('input[type=file]').count(),0);
    await fidelity.locator('[data-pf-ui-mode="all"]').click();
    await fidelity.locator('[data-pf-group="shape"] > summary').click();
    await fidelity.locator('[data-pf-mask-select]').selectOption('/fixture/mask-1.png');
    await page.waitForFunction(id=>Boolean(nodes.find(n=>n.id===id).fidelityConfig.maskUrl),fidelityId);
    await fidelity.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(id=>Boolean(nodes.find(n=>n.id===id).fidelityPreview),fidelityId);
    assert.equal(previews.at(-1).product_fidelity.maskUrl,'/fixture/mask-1.png');
    assert.equal(uploads.length,1,'selecting an existing canvas mask never uploads again');
    assert.equal(paid.length,0);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        await showSetting(fidelity,'category');
        await fidelity.locator('[data-pf-field="category"]').selectOption('other');
        await fidelity.locator('[data-pf-field="categoryCustom"]').fill('入户门垫');
        await fidelity.locator('[data-pf-field="geometry"]').selectOption('custom');
        await fidelity.locator('[data-pf-field="geometryCustom"]').fill('半圆形带直边');
        await page.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-fidelity-custom-and-mask.png')});
    }
});

test('section switches, large editor and incorrect automatic detail region can be corrected',{timeout:45000},async t=>{
    const {page,previews,paid}=await fixture(t);
    const id=await page.evaluate(()=>{
        nodes=[{id:'product',type:'smart-upload',x:30,y:170,images:[{url:'/fixture/A.png',kind:'image',name:'产品.png'}]}];
        canvas.connections=[];canvasUsesConnections=true;viewport={x:0,y:0,scale:1};applyViewport();
        const n=createProductFidelityNodeAt({x:900,y:510});connectInputNode('product',n.id);selectedId=n.id;render();return n.id;
    });
    const node=page.locator('.image-node[data-id="'+id+'"]'),editor=node.locator('[data-pf-canvas]');
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.draw),id);
    assert.equal(await node.locator('[data-pf-module] > .pf-section-heading input[type=checkbox]').count(),7);
    const normal=await editor.boundingBox();
    await node.locator('[data-pf-expand]').click();
    await page.waitForFunction(()=>document.querySelector('.pf-image-column')?.matches(':popover-open'));
    await page.waitForFunction(width=>document.querySelector('[data-pf-canvas]')?.getBoundingClientRect().width>width*1.5,normal.width);
    const expanded=await editor.boundingBox();
    assert.ok(expanded.width>normal.width*1.5,JSON.stringify({normal,expanded}));
    assert.ok(expanded.height>normal.height*1.5,JSON.stringify({normal,expanded}));
    await node.locator('[data-pf-expand]').click();
    await page.waitForFunction(()=>!document.querySelector('.pf-image-column')?.matches(':popover-open'));
    await showSetting(node,'identification.enabled');
    await node.locator('[data-pf-field="identification.enabled"]').uncheck();
    assert.equal(await node.locator('[data-pf-field="category"]').isDisabled(),true);
    assert.equal(await node.locator('[data-pf-field="productReferenceId"]').isDisabled(),false);
    await node.locator('[data-pf-field="identification.enabled"]').check();
    await showSetting(node,'structure.enabled');
    await node.locator('[data-pf-field="structure.enabled"]').uncheck();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    await showSetting(node,'detail.enabled');
    assert.equal(await node.locator('[data-pf-field="structure.lockRatio"]').isDisabled(),true);
    assert.equal(await node.locator('[data-pf-field="detail.enabled"]').isDisabled(),false);
    await node.locator('[data-pf-field="detail.enabled"]').uncheck();
    assert.equal(await node.locator('[data-pf-field="detail.inputMode"]').isDisabled(),true);
    await node.locator('[data-pf-field="detail.enabled"]').check();
    await showSetting(node,'structure.enabled');
    await node.locator('[data-pf-field="structure.enabled"]').check();
    await showSetting(node,'generation.enabled');
    await node.locator('[data-pf-field="generation.enabled"]').uncheck();
    assert.equal(await node.locator('[data-pf-field="generation.allowedEdits"]').isDisabled(),true);
    await node.locator('[data-pf-field="generation.enabled"]').check();
    await showSetting(node,'advanced.enabled');
    await node.locator('[data-pf-field="advanced.enabled"]').check();
    await node.locator('[data-pf-field="advanced.enabled"]').uncheck();
    assert.equal(await node.locator('[data-pf-field="maskFeatherPx"]').isDisabled(),true);
    await showSetting(node,'validation.enabled');
    await node.locator('[data-pf-field="validation.enabled"]').uncheck();
    assert.equal(await node.locator('[data-pf-field="validation.ratioTolerancePct"]').isDisabled(),true);
    await node.locator('[data-pf-field="validation.enabled"]').check();
    await showSetting(node,'view.enabled');
    await node.locator('[data-pf-field="view.enabled"]').check();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.mode,id),'view');
    await node.locator('[data-pf-field="view.enabled"]').uncheck();
    await page.locator('.pf-confirm-dialog [data-pf-confirm="accept"]').click();
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.mode,id),'structure');
    await showSetting(node,'detail.autoCrops');
    await node.locator('[data-pf-action="auto-crops"]').click();
    await page.waitForFunction(id=>productFidelitySessions.get(id)?.detectedRois.length===1,id);
    assert.equal(await node.locator('[data-pf-roi-preview]').count(),1);
    assert.equal(await node.locator('[data-pf-roi-preview]').evaluate(el=>el.getBoundingClientRect().bottom<=el.closest('.pf-image-column').getBoundingClientRect().bottom+1),true);
    assert.equal(await node.locator('[data-pf-roi-preview] canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some(Boolean)),true);
    assert.match(await node.locator('[data-pf-roi-info]').textContent(),/涂成灰色的商品区域/);
    assert.doesNotMatch(await node.locator('[data-pf-roi-info]').textContent(),/自动候选|0 个/);
    const candidate=await page.evaluate(id=>productFidelitySessions.get(id).detectedRois[0],id);
    await node.locator('[data-pf-roi-preview="0"]').click();
    assert.match(await node.locator('[data-pf-roi-info]').textContent(),/已圈 1 处/);
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.detail.autoCrops,id),false);
    const beforeThumb=await node.locator('[data-pf-roi-preview="0"] canvas').evaluate(canvas=>canvas.toDataURL());
    const moveBox=await editor.boundingBox();
    await page.mouse.move(moveBox.x+moveBox.width*(candidate.x+.1),moveBox.y+moveBox.height*(candidate.y+.1));await page.mouse.down();
    await page.mouse.move(moveBox.x+moveBox.width*(candidate.x+.2),moveBox.y+moveBox.height*(candidate.y+.16),{steps:6});await page.mouse.up();
    const moved=await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.rois[0],id);
    assert.ok(moved.x>candidate.x+.05,JSON.stringify(moved));
    assert.notEqual(await node.locator('[data-pf-roi-preview="0"] canvas').evaluate(canvas=>canvas.toDataURL()),beforeThumb);
    assert.equal(await node.locator('[data-pf-roi-preview="0"]').evaluate(el=>el.getBoundingClientRect().bottom<=el.closest('.pf-image-column').getBoundingClientRect().bottom+1),true);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.FIDELITY_SCREENSHOT_DIR,{recursive:true});
        await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-roi-preview-light.png')});
    }
    assert.deepEqual(await page.evaluate(id=>{const s=productFidelitySessions.get(id);return [s.tool,s.selectedRoi,typeof s.root.querySelector('[data-pf-canvas]').onkeydown];},id),['roi',0,'function']);
    await editor.press('Delete');
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.rois.length,id),0);
    assert.equal(await node.locator('[data-pf-roi-preview]').count(),0);
    const drawBox=await editor.boundingBox();
    await page.mouse.move(drawBox.x+drawBox.width*.52,drawBox.y+drawBox.height*.52);await page.mouse.down();
    await page.mouse.move(drawBox.x+drawBox.width*.79,drawBox.y+drawBox.height*.75,{steps:6});await page.mouse.up();
    const redrawn=await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.rois[0],id);
    assert.ok(redrawn.x>.5&&redrawn.w>.2,JSON.stringify(redrawn));
    await page.evaluate(id=>{const n=nodes.find(item=>item.id===id);n.w=760;n.h=700;render();applyTheme('dark');},id);
    await page.waitForFunction(id=>Boolean(productFidelitySessions.get(id)?.roiSourceImage),id);
    await node.locator('[data-pf-roi-preview="0"]').scrollIntoViewIfNeeded();
    assert.equal(await node.locator('[data-pf-roi-preview="0"]').isVisible(),true);
    assert.equal(await node.locator('[data-pf-root]').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    if(process.env.FIDELITY_SCREENSHOT_DIR)await node.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-roi-preview-narrow-dark.png')});
    await node.locator('[data-pf-action="preview"]').click();
    await page.waitForFunction(id=>Boolean(nodes.find(n=>n.id===id).fidelityPreview),id);
    assert.equal(previews.at(-1).product_fidelity.rois.length,1);
    assert.equal(previews.at(-1).product_fidelity.detail.autoCrops,false);
    assert.equal(paid.length,0);
    await node.locator('[data-pf-action="auto-crops"]').click();
    await page.waitForFunction(id=>productFidelitySessions.get(id)?.detectedRois.length===1,id);
    await node.locator('[data-pf-action="manual-rois"]').click();
    assert.equal(await page.evaluate(id=>productFidelitySessions.get(id).detectedRois.length,id),0);
    assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).fidelityConfig.detail.autoCrops,id),false);
    if(process.env.FIDELITY_SCREENSHOT_DIR){
        await node.locator('[data-pf-expand]').click();
        await page.waitForFunction(()=>document.querySelector('[data-pf-expand]')?.getAttribute('aria-expanded')==='true');
        await page.screenshot({path:path.join(process.env.FIDELITY_SCREENSHOT_DIR,'product-fidelity-large-editor.png')});
    }
    await page.evaluate(()=>saveCanvas());
    await page.reload();
    await page.waitForFunction(id=>nodes.some(n=>n.id===id),id);
    const restored=await page.evaluate(id=>{
        const c=nodes.find(n=>n.id===id).fidelityConfig;
        return {mode:c.mode,view:c.view.enabled,validation:c.validation.enabled,rois:c.rois.length,auto:c.detail.autoCrops};
    },id);
    assert.deepEqual(restored,{mode:'structure',view:false,validation:true,rois:1,auto:false});
});
