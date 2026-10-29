const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');

test('local crop provenance, versions, preview, output, undo, reload and cancellation',{timeout:60000},async t=>{
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.routeWebSocket('**/*',s=>s.close());
    const source='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#bbb4a9"/><rect x="130" y="100" width="360" height="260" rx="12" fill="#8c5942"/><rect x="150" y="120" width="320" height="220" fill="#f4e6c9"/><text x="230" y="245" font-size="46" fill="#352d27">XIAOMEI</text></svg>';
    let cropped,saved={id:'fusion-fixture',title:'局部修复测试',nodes:[],connections:[],logs:[],settings:{}},requests=[],cancelled=false,waiting=false;
    await page.route('**/*',route=>{
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        if(url.hostname!=='fusion.test')return route.abort();
        if(p.startsWith('/static/')){const file=path.resolve(root,'.'+decodeURIComponent(p));assert.ok(file.startsWith(root+path.sep));return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});}
        if(p==='/api/canvases/fusion-fixture'){
            if(req.method()==='PUT'){saved=req.postDataJSON();saved=saved.canvas||saved;return route.fulfill({json:{success:true,canvas:saved}});}
            return route.fulfill({json:{canvas:saved}});
        }
        if(p==='/api/ai/upload'){
            const data=req.postDataBuffer(),start=data.indexOf(Buffer.from('\x89PNG\r\n\x1a\n','latin1')),end=data.indexOf(Buffer.from('IEND'),start)+8;
            cropped=data.subarray(start,end);return route.fulfill({json:{files:[{url:'/output/crop.png',name:'crop.png'}]}});
        }
        if(p==='/api/local-fusion/jobs'){
            requests.push(req.postDataJSON());cancelled=false;return route.fulfill({status:202,json:{id:'job'+requests.length,status:'queued'}});
        }
        if(p.startsWith('/api/local-fusion/jobs/')){
            if(req.method()==='DELETE'){cancelled=true;return route.fulfill({json:{status:'cancelled'}});}
            return route.fulfill({json:cancelled?{status:'cancelled',message:'已取消融合'}:waiting?{status:'running',message:'正在处理区域 1/1'}:{status:'completed',message:'融合预览完成',result:{url:'/output/result.png',maskUrl:'/output/mask.png',width:640,height:480,name:'局部融合结果.png',report:{warnings:[],outsideUnchanged:true,regions:[]}}}});
        }
        if(p==='/output/crop.png'&&cropped)return route.fulfill({contentType:'image/png',body:cropped});
        if(p.startsWith('/output/')||p==='/api/media-preview')return route.fulfill({contentType:'image/svg+xml',body:source});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });
    await page.goto('http://fusion.test/static/smart-canvas.html?id=fusion-fixture');
    await page.waitForFunction(()=>document.getElementById('smartTitle')?.textContent==='局部修复测试');
    await page.evaluate(()=>{
        const original=createNode(40,120,[{url:'/output/source.png',name:'商品场景.png',kind:'image',natural_w:640,natural_h:480}],{nodeType:'smart-image'});
        window.originalId=original.id;startLocalRepairCrop(original.id,0);
    });
    await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth===640&&cropState?.localRepair);
    await page.evaluate(()=>{const img=document.getElementById('cropImage');cropState.x=img.clientWidth*.25;cropState.y=img.clientHeight*.25;cropState.w=img.clientWidth*.5;cropState.h=img.clientHeight*.5;renderCropBox();});
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(()=>nodes.some(n=>n.images?.[0]?.localRepair));
    const provenance=await page.evaluate(()=>{
        const crop=nodes.find(n=>n.images?.[0]?.localRepair);window.cropId=crop.id;
        const region=crop.images[0].localRepair;
        const meta=snapshotRunMeta('修复相框边角',crop.id,'修复相框边角',crop.images);
        const paint=createNode(600,120,[],{nodeType:'smart-paint'});window.paintId=paint.id;
        addConnection(crop.id,paint.id,'input');
        paint.pendingTasks=[{taskId:'repair-1',kind:'image',localRepair:meta.localRepair}];
        finalizeSmartPendingTask(paint,'repair-1',[{url:'/output/edited1.png',width:640,height:480}]);
        paint.pendingTasks=[{taskId:'repair-2',kind:'image',localRepair:meta.localRepair}];
        finalizeSmartPendingTask(paint,'repair-2',[{url:'/output/edited2.png',width:1280,height:960}]);
        const fusion=createLocalFusionNodeAt({x:1060,y:420});window.fusionId=fusion.id;
        addConnection(originalId,fusion.id,'input');addConnection(paint.id,fusion.id,'input');
        render();scheduleSave();
        return {region,original:nodes.find(n=>n.id===originalId).images[0].url,versions:paint.images.map(i=>i.localRepair?.id),payload:localFusionPayload(fusion)};
    });
    assert.equal(provenance.original,'/output/source.png');
    assert.deepEqual([provenance.region.x,provenance.region.y,provenance.region.width,provenance.region.height],[160,120,320,240]);
    assert.deepEqual(provenance.versions,[provenance.region.id,provenance.region.id]);
    assert.equal(provenance.payload.patches.length,1);assert.equal(provenance.payload.patches[0].url,'/output/edited2.png');
    const fusion=page.locator('.local-fusion-smart-node');await assert.equal(await fusion.count(),1);
    await fusion.locator('[data-lf-version]').selectOption('/output/edited1.png');
    await fusion.locator('[data-lf-run]').click();
    await page.waitForFunction(()=>nodes.find(n=>n.id===fusionId)?.fusionPreview);
    assert.equal(requests.length,1);assert.equal(requests[0].patches[0].url,'/output/edited1.png');
    await fusion.locator('[data-lf-preview]').click();await page.getByRole('button',{name:'原图',exact:true}).click();
    assert.equal(await page.locator('.lf-large-preview').getAttribute('src'),'/output/source.png');
    await page.locator('[data-lf-zoom]').fill('200');await page.locator('[data-lf-zoom]').dispatchEvent('input');
    assert.equal(await page.locator('[data-lf-zoom-label]').textContent(),'200%');
    assert.equal(await page.locator('.lf-large-preview').evaluate(el=>el.style.width),'1280px');
    await page.getByRole('button',{name:'修改范围',exact:true}).click();assert.ok(await page.locator('.lf-preview-mask').isVisible());
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await fusion.locator('[data-lf-output]').click();
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.title==='局部修复结果')?.images[0].natural_w),640);
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.title==='局部修复结果')?.images[0].fusionRecord.sourceUrl),'/output/source.png');
    const outputBox=await page.locator('.image-node').filter({has:page.locator('[data-original-src="/output/result.png"]')}).last().boundingBox();
    assert.ok(outputBox.x>=0&&outputBox.x+outputBox.width<=1440,'new full-image output is brought into view');
    const undo=await page.evaluate(()=>{performUndo();const absent=!nodes.some(n=>n.title==='局部修复结果');performRedo();return absent&&nodes.some(n=>n.title==='局部修复结果');});assert.ok(undo);
    await fusion.locator('[data-lf-color]').uncheck();assert.ok(await fusion.locator('[data-lf-output]').isDisabled());
    waiting=true;await fusion.locator('[data-lf-run]').click();await fusion.locator('[data-lf-cancel]').click();
    await page.waitForFunction(()=>!nodes.find(n=>n.id===fusionId).fusionJobId);assert.ok(cancelled);
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===fusionId).fusionPreview.url),'/output/result.png');
    await page.evaluate(async()=>{await saveCanvas();});
    const id=await page.evaluate(()=>fusionId);await page.reload();await page.waitForFunction(id=>nodes.some(n=>n.id===id),id);
    const loaded=await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);return {preview:n.fusionPreview.url,regions:localFusionState(n).patches.length,color:n.fusionConfig.colorMatch};},id);
    assert.deepEqual(loaded,{preview:'/output/result.png',regions:1,color:false});
    await page.locator('.lf-advanced summary').click();
    await page.locator('[data-lf-position]').click();
    await page.locator('.lf-dialog input[name=x]').fill('-1');
    await page.locator('.lf-dialog [data-save]').click();
    assert.match(await page.locator('.lf-dialog [role=status]').textContent(),/超出/);
    await page.locator('.lf-dialog input[name=x]').fill('160');
    await page.locator('.lf-dialog [data-save]').click();
    assert.equal(await page.evaluate(id=>localFusionPayload(nodes.find(n=>n.id===id)).patches[0].alignment,id),'manual');
    await page.locator('[data-lf-mask]').click();
    await page.waitForFunction(()=>document.querySelector('.lf-mask-canvas')?.width===320);
    const box=await page.locator('.lf-mask-canvas').boundingBox();
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.7,{steps:6});await page.mouse.up();
    const nodeCount=await page.evaluate(()=>nodes.length);await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.length),nodeCount);
    await page.locator('.lf-dialog [data-save]').click();
    await page.waitForFunction(()=>!document.querySelector('.lf-dialog[open]'));
    assert.equal(await page.evaluate(id=>localFusionPayload(nodes.find(n=>n.id===id)).patches[0].maskUrl,id),'/output/crop.png');
    await page.locator('[data-lf-clear-mask]').click();
    await page.locator('.lf-advanced summary').click();
    const artifacts=path.join(root,'.fusion-artifacts');fs.mkdirSync(artifacts,{recursive:true});
    await page.screenshot({path:path.join(artifacts,'fusion-canvas.png')});
    assert.deepEqual(errors,[]);
});
