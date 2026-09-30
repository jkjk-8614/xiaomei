const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname,'..');

test('canvas outpaint, layer progress/history, and layered smart-object PSD round trip', {timeout:60000}, async t => {
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let progressOffline=false, photoshopOnline=true, nativeOpen=null;
  let analysisPending=true, saved=false, job=null, postCount=0, uploadedPsd=null, restoredCanvas=null, photoshopSend=null, loseSubmission=false, pendingBodies=[];
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#ddb987"/><rect x="60" y="30" width="60" height="70" fill="#b14842"/></svg>';
  await page.context().route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    if(url.hostname!=='xiaomei-layers.test')return route.abort();
    if(p.startsWith('/static/')){
      const file=path.resolve(root,'.'+decodeURIComponent(p));
      assert.ok(file.startsWith(root+path.sep));
      return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({body:''});
    }
    if(p.endsWith('.png')||p.includes('media-preview'))return route.fulfill({contentType:'image/svg+xml',body:svg});
    if(p==='/api/config')return route.fulfill({json:{api_providers:[{id:'fixture',name:'测试平台',enabled:true,protocol:'openai',chat_models:['vision'],image_models:['image']}],comfy_instances:[]}});
    if(p==='/api/canvases/layers-fixture')return route.fulfill({json:{canvas:restoredCanvas || {id:'layers-fixture',title:'Layers fixture',nodes:[],connections:[],logs:[],settings:{engine:'api',provider_id:'fixture',model:'image',count:1}}}});
    if(p==='/api/image-layers'&&req.method()==='GET')return route.fulfill({json:job?[job]:[]});
    if(p==='/api/image-layers'&&req.method()==='POST'){
      postCount++;const request=req.postDataJSON();
      if(loseSubmission) {pendingBodies.push(request);return route.abort();}
      job={id:(postCount===1?'a':'c').repeat(32),request,source_url:request.source_url,width:200,height:120,status:'running',phase:'生成图层',created_at:Date.now()/1000,layers:[]};
      return route.fulfill({json:job});
    }
    if(p.endsWith('/psd')){uploadedPsd=req.postDataBuffer();saved=true;return route.fulfill({json:{url:'/output/layers.psd'}});}
    if(p==='/api/photoshop-bridge/status')return route.fulfill({json:{online:photoshopOnline,bridge:{capabilities:['open-layered-psd']}}});
    if(p.endsWith('/photoshop/open')){nativeOpen=url;return route.fulfill({json:{status:'launched',message:'已交给本机 Photoshop 打开，请查看新文档标签。'}});}
    if(p==='/api/photoshop-bridge/send'){photoshopSend=req.postDataJSON();return route.fulfill({json:{job:{id:'ps-receipt',status:'pending'}}});}
    if(p==='/api/photoshop-bridge/jobs/ps-receipt')return route.fulfill({json:{job:{id:'ps-receipt',status:'done',import_mode:'opened-document'}}});
    if(p.startsWith('/api/image-layers/') && progressOffline) return route.abort();
    if(p.startsWith('/api/image-layers/') && (analysisPending || job.status==='failed')) return route.fulfill({json:job});
    if(p.startsWith('/api/image-layers/')){
      job={...job,status:'needs-review',phase:'分层完成，请复核',composite_url:'/output/composite.png',original_url:'/output/source.png',layers:job.layers.map((x,i)=>({...x,status:i?'needs-review':'ready',issues:i?['文字边缘需要复核']:[],url:`/output/raw-${i}.png`,aligned_url:`/output/layer-${i}.png`,native_width:200,native_height:120,transform:[0,0,200,0,200,120,0,120]}))};
      return route.fulfill({json:job});
    }
    return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
  });
  await page.goto('http://xiaomei-layers.test/static/smart-canvas.html?id=layers-fixture');
  await page.waitForFunction(()=>document.getElementById('smartTitle')?.textContent==='Layers fixture', {timeout:10000}).catch(async error=>{console.log(errors,await page.evaluate(()=>({title:document.getElementById('smartTitle')?.textContent,text:document.body.innerText.slice(-900)})));throw error;});
  await page.evaluate(()=>{apiProviders=[{id:'fixture',name:'测试平台',enabled:true,protocol:'openai',chat_models:['vision'],image_models:['image']}];});
  const id=await page.evaluate(()=>createNode(200,160,[{url:'/output/source.png',name:'source.png',kind:'image',natural_w:200,natural_h:120}],{nodeType:'smart-image',select:true}).id);
  await page.locator(`[data-smart-node-action="ai-layers"][data-node-id="${id}"]`).click();
  await page.waitForSelector('.image-layers-dialog[open]');
  assert.equal(await page.locator('[data-analysis] option').count(),1);
  await page.selectOption('[data-mode]','custom');
  await page.locator('[data-count]').fill('2');
  await page.locator('[data-start]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.imageLayerId==='composite'));
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  assert.equal(await page.locator('.image-layers-node-state').count(),1);
  await page.locator('[data-image-layer-job]').first().click();
  await page.waitForSelector('.image-layers-dialog[open]');
  assert.equal(await page.locator('[data-hide], [data-arrange]').count(),0);
  await page.locator('[data-close]').click();
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  const editing = await page.evaluate(() => {
    const other = createNode(50, 700, [], {select:true});
    viewport = {x:123,y:234,scale:.7}; applyViewport();
    return {id:other.id, viewport:{...viewport}};
  });
  assert.ok(await page.evaluate(id=>canvas.connections.some(c=>c.from===id&&nodes.find(n=>n.id===c.to)?.imageLayerId==='composite'),id));
  job.layers=[{id:'layer-1',name:'背景',status:'generating'},{id:'layer-2',name:'商品',status:'queued'}];
  await page.waitForFunction(()=>nodes.find(n=>n.imageLayerId==='composite')?.imageLayerPhase.includes('已生成 0/2 层'));
  assert.match(await page.locator('.image-layers-node-state').last().textContent(),/生成中|等待/);
  assert.match(await page.evaluate(()=>nodes.find(n=>n.imageLayerId==='composite').imageLayerPhase),/生成中 1 层 · 等待 1 层/);
  progressOffline=true;
  await page.waitForFunction(()=>nodes.find(n=>n.imageLayerId==='composite')?.imageLayerPhase.includes('进度暂时无法确认'));
  progressOffline=false;
  analysisPending=false;
  await page.waitForFunction(()=>nodes.filter(n=>n.imageLayerJobId).length===3,null,{timeout:10000}).catch(async error=>{console.log('pipeline',errors,postCount,job?.status,await page.evaluate(()=>({error:document.querySelector('[data-error]')?.textContent,status:document.querySelector('[data-status]')?.textContent,nodes:nodes.map(n=>({id:n.id,job:n.imageLayerJobId,title:n.title}))})));throw error;});
  assert.equal(postCount,1);
  await page.waitForFunction(()=>nodes.find(n=>n.imageLayerId==='composite')?.images?.length>0);
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  assert.deepEqual(await page.evaluate(()=>({...viewport})),editing.viewport);
  assert.equal(await page.evaluate(()=>selectedId),editing.id);
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),1);
  const previewBox=await page.locator('.image-layers-preview').boundingBox();
  const layersBox=await page.locator('.image-layers-list').boundingBox();
  assert.ok(layersBox.x >= previewBox.x + previewBox.width);
  assert.equal(await page.locator('.image-layers-preview .image-layers-list').count(),0);
  assert.equal(job.request.method,'regenerate');
  assert.equal(job.request.layer_count,2);
  assert.equal(job.request.concurrency,3);
  assert.equal(job.request.max_retries,1);
  assert.match(await page.locator('[data-budget]').textContent(), /最多调用生图 4 次/);
  assert.equal(await page.locator('.image-layers-list article').count(),2);
  const positions = () => page.evaluate(() => nodes.filter(n=>n.imageLayerJobId).map(n=>({id:n.imageLayerId,x:n.x,y:n.y,w:n.w,h:n.h})));
  const aligned = await positions();
  const first = aligned.find(n=>n.id==='layer-1'), second = aligned.find(n=>n.id==='layer-2');
  assert.equal(first.y,second.y);
  assert.equal(second.x-first.x,first.w+140);
  await page.locator('[data-close]').click();
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  assert.deepEqual(await positions(),aligned);
  assert.deepEqual(await page.evaluate(()=>({...viewport})),editing.viewport);
  await page.evaluate(id=>openSmartImageLayers(id),id);
  const graph=await page.evaluate(id=>({source:nodes.find(n=>n.id===id).images[0].url,connections:canvas.connections.length,serialized:nodes.filter(n=>n.imageLayerJobId).map(serializableSmartNode)}),id);
  assert.equal(graph.source,'/output/source.png');assert.equal(graph.connections,4);assert.equal(graph.serialized[0].imageLayerJobId,job.id);
  await page.locator('[data-view="composite"]').click();
  await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-image-layers-review.png')});
  // Parse generated bytes independently of the exporter assertion, including linked source images.
  const check=await page.evaluate(async info=>{
    const bytes=await XiaomeiLayerPsd.build(info);
    const psd=AgPsd.readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
    return {width:psd.width,height:psd.height,layers:psd.children.map(x=>({name:x.name,hidden:x.hidden,placed:!!x.placedLayer})),linked:psd.linkedFiles.length};
  },job);
  assert.equal(check.width,200);assert.equal(check.height,120);assert.equal(check.layers.length,3);assert.equal(check.layers[0].hidden,true);assert.equal(check.linked,2);assert.ok(check.layers[1].placed&&check.layers[2].placed);
  await page.locator('[data-psd]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-psd]').disabled);
  assert.ok(saved);assert.equal(uploadedPsd.subarray(0,4).toString(),'8BPS');
  await page.locator('[data-photoshop]').click();
  await page.waitForFunction(()=>document.querySelector('[data-photoshop-status]').textContent.includes('已确认打开'));
  assert.equal(photoshopSend.open_mode,'document');
  assert.equal(photoshopSend.url,'/output/layers.psd');
  await page.locator('[data-close]').click();
  // Export from the composite node without reopening the settings dialog.
  const exportViewport=await page.evaluate(()=>{
    const previous={...viewport};const node=nodes.find(n=>n.imageLayerId==='composite');
    viewport={scale:1,x:400-node.x,y:300-node.y};applyViewport();return previous;
  });
  saved=false;photoshopSend=null;
  await page.locator('[data-layer-export="download"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-layer-export="download"]').disabled);
  assert.ok(saved);
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  await page.locator('[data-layer-export="photoshop"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-layer-export="photoshop"]').disabled);
  assert.equal(photoshopSend.open_mode,'document');
  assert.equal(photoshopSend.url,'/output/layers.psd');
  photoshopOnline=false;
  await page.locator('[data-layer-export="photoshop"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-layer-export="photoshop"]').disabled);
  assert.ok(nativeOpen.pathname.includes(job.id));
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  photoshopOnline=true;
  await page.evaluate(previous=>{viewport=previous;applyViewport();},exportViewport);
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.locator('[data-history] option').count(),2);
  await page.locator('[data-close]').click();
  await page.evaluate(id=>{openImageEditor(id,0);setImageEditMode('outpaint',true);},id);
  await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth>0&&cropState);
  assert.equal(await page.locator('[data-outpaint-handle]').count(),8);
  const before=await page.evaluate(()=>({...cropState}));
  const handle=page.locator('[data-outpaint-handle="nw"]');const rect=await handle.boundingBox();
  await page.keyboard.down('Alt');await page.mouse.move(rect.x+5,rect.y+5);await page.mouse.down();await page.mouse.move(rect.x-25,rect.y-15,{steps:4});await page.mouse.up();await page.keyboard.up('Alt');
  const after=await page.evaluate(()=>({...cropState}));assert.ok(after.w>before.w);assert.ok(after.h>before.h);
  assert.ok(Math.abs((after.x-before.x)-(after.w-before.w)/2)<2);
  await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-outpaint-review.png')});
  const expanded=await page.evaluate(async id=>{
    uploadCroppedBlob=async()=>({url:'/output/expanded.png',name:'expanded.png'});
    await applyImageOutpaint({autoRun:false});
    const original=nodes.find(n=>n.id===id);
    const output=nodes.find(n=>n.outpaintPreserve);
    return {original:original.images[0].url,output:output?.images[0].url,source:output?.outpaintPreserve.sourceUrl,connected:canvas.connections.some(c=>c.from===id&&c.to===output?.id)};
  },id);
  assert.equal(expanded.original,'/output/source.png');assert.equal(expanded.output,'/output/expanded.png');assert.equal(expanded.source,'/output/source.png');assert.ok(expanded.connected);
  const legacy=await page.evaluate(async()=>{
    const bytes=await XiaomeiLayerPsd.build({width:200,height:120,layers:[{name:'ComfyUI 图层',url:'/output/layer.png',left:20,top:10,right:120,bottom:90}]});
    const psd=AgPsd.readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
    return {count:psd.children.length,left:psd.children[0].left,top:psd.children[0].top};
  });
  assert.deepEqual(legacy,{count:1,left:20,top:10});
  await page.evaluate(id=>{
    openImageEditor(id,0);setImageEditMode('outpaint',true);
  },id);
  await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth>0&&cropState);
  await page.evaluate(()=>{
    window.nodeCountBeforeUpload=nodes.length;
    uploadCroppedBlob=()=>new Promise(resolve=>{window.finishOutpaintUpload=resolve;});
    window.cancelledOutpaint=applyImageOutpaint({autoRun:false}).then(()=>null,error=>error.message);
  });
  await page.waitForFunction(()=>!!window.finishOutpaintUpload);
  const cancelled=await page.evaluate(async()=>{
    closeImageEditor();window.finishOutpaintUpload({url:'/output/cancelled.png',name:'cancelled.png'});
    return {message:await window.cancelledOutpaint,sameCount:nodes.length===window.nodeCountBeforeUpload};
  });
  assert.match(cancelled.message,/编辑状态已改变/);assert.ok(cancelled.sameCount);
  // A grouped node's second image must not inherit the first image's task history.
  await page.evaluate(id=>{nodes.find(n=>n.id===id).images.push({url:'/output/second.png',name:'second.png',kind:'image'});return openSmartImageLayers(id,1);},id);
  assert.equal(await page.locator('[data-history] option').count(),1);
  await page.locator('[data-close]').click();
  // Deleting a generated layer must survive later task refreshes and canvas reloads.
  const deleted=await page.evaluate(({id,jobId})=>{
    const output=nodes.find(n=>n.imageLayerId==='layer-1');
    deleteNode(output.id);
    return {key:`${jobId}:${output.imageLayerId}`,source:nodes.find(n=>n.id===id).imageLayerDeletedNodeKeys};
  },{id,jobId:job.id});
  assert.ok(deleted.source.includes(deleted.key));
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.evaluate(()=>nodes.some(n=>n.imageLayerId==='layer-1')),false);
  await page.locator('[data-close]').click();
  await page.evaluate(()=>{
    nodes.filter(n=>n.imageLayerJobId).map(n=>n.id).forEach(deleteNode);
  });
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.evaluate(()=>nodes.filter(n=>n.imageLayerJobId).length),0);
  const mergedCount=await page.evaluate(savedJob=>{
    const source=nodes.find(n=>n.imageLayerTaskIds?.includes(savedJob.id));
    const stale=[...nodes, ...savedJob.layers.map(layer=>({id:`stale-${layer.id}`,imageLayerJobId:savedJob.id,imageLayerId:layer.id,images:[]}))];
    stale.push({id:'stale-composite',imageLayerJobId:savedJob.id,imageLayerId:'composite',images:[]});
    const merged=mergeSmartNodeLists(stale,[{...source,imageLayerHiddenJobIds:[savedJob.id]}]);
    return merged.filter(n=>n.imageLayerJobId===savedJob.id).length;
  },job);
  assert.equal(mergedCount,0,'canvas merge must respect deleted layer job markers');
  await page.locator('[data-close]').click();
  restoredCanvas=await page.evaluate(id=>({id:canvasId,title:'Layers fixture',settings:canvas.settings,logs:[],connections:[],nodes:[serializableSmartNode(nodes.find(n=>n.id===id))]}),id);
  assert.ok(restoredCanvas.nodes[0].imageLayerTaskIds.includes(job.id));
  await page.reload();
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(()=>nodes.filter(n=>n.imageLayerJobId).length),0);
  assert.equal(postCount,1,'restoring completed job must not submit generation');
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.evaluate(()=>nodes.filter(n=>n.imageLayerJobId).length),0);
  await page.locator('[data-start]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.imageLayerId==='composite'));
  assert.deepEqual(await page.evaluate(()=>nodes.filter(n=>n.imageLayerJobId).map(n=>n.imageLayerJobId)),['c'.repeat(32)]);
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),0);
  // Lost POSTs retain the exact payload, including across closing/reopening the panel.
  loseSubmission=true;
  await page.evaluate(id=>openSmartImageLayers(id,1),id);
  await page.locator('[data-start]').click();
  await page.waitForFunction(()=>document.querySelector('[data-start]').textContent==='确认上次提交');
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),1);
  assert.ok(await page.locator('[data-mode]').isDisabled());
  await page.locator('[data-close]').click();
  await page.evaluate(id=>openSmartImageLayers(id,1),id);
  assert.ok(await page.locator('[data-mode]').isDisabled());
  await page.locator('[data-start]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-start]').disabled);
  assert.equal(pendingBodies.length,2);
  assert.deepEqual(pendingBodies[1],pendingBodies[0]);
  await page.locator('[data-close]').click();
  const savedComposite=await page.evaluate(()=>serializableSmartNode(nodes.find(n=>n.imageLayerId==='composite')));
  job={...job,id:'b'.repeat(32),status:'failed',phase:'分层处理中断',error:'分析模型未返回图层规划，请继续处理',layers:[],composite_url:null};
  restoredCanvas.nodes[0].imageLayerTaskIds=[job.id];
  restoredCanvas.nodes.push({...savedComposite,id:'restored-failed-composite',imageLayerJobId:job.id,images:[]});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.image-layers-node-state')?.textContent.includes('分析模型未返回'));
  assert.equal(await page.locator('.image-layers-node-state').count(),1);
  await page.locator('[data-image-layer-job]').click();
  await page.waitForSelector('.image-layers-dialog[open]');
  assert.match(await page.locator('[data-error]').textContent(),/分析模型未返回/);
  await page.locator('[data-resume]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-resume]').disabled);
  assert.equal(await page.locator('.image-layers-dialog[open]').count(),1);
  job={...job,layers:Array.from({length:9},(_,i)=>({id:`grid-${i}`,name:`图层 ${i+1}`,status:'queued'}))};
  await page.locator('[data-close]').click();
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.match(await page.locator('[data-status]').textContent(),/任务失败 · 已生成 0\/9 层/);
  assert.equal(await page.locator('.image-layers-list').getByText('未生成 · 任务失败',{exact:true}).count(),9);
  await page.locator('[data-close]').click();
  const grid=await page.evaluate(()=>nodes.filter(n=>n.imageLayerId?.startsWith('grid-')).map(n=>({x:n.x,y:n.y,w:n.w,h:n.h})));
  assert.equal(grid.length,9);
  assert.equal(new Set(grid.map(n=>n.x)).size,3);
  assert.equal(new Set(grid.map(n=>n.y)).size,3);
  for(let i=0;i<9;i++) {
    assert.equal(grid[i].x,grid[0].x+(i%3)*(grid[0].w+140));
    assert.equal(grid[i].y,grid[0].y+Math.floor(i/3)*(grid[0].h+100));
  }
  // Existing untouched two-column layouts must migrate on the next task refresh.
  await page.evaluate(info=>{
    const source=nodes.find(n=>n.id===info.request.source_node_id);
    const width=Math.min(320,Math.max(220,nodeRect(source).width));
    const height=Math.min(480,Math.max(180,width/(info.width/info.height)));
    info.layers.forEach((layer,i)=>{
      const n=nodes.find(n=>n.imageLayerJobId===info.id&&n.imageLayerId===layer.id);
      n.x=source.x+nodeRect(source).width+140+(i%2)*(width+140);
      n.y=source.y+Math.floor(i/2)*(height+100);
    });
  },job);
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.evaluate(()=>new Set(nodes.filter(n=>n.imageLayerId?.startsWith('grid-')).map(n=>n.x)).size),3);
  await page.evaluate(()=>{nodes.find(n=>n.imageLayerId==='grid-0').x+=55;});
  const movedX=await page.evaluate(()=>nodes.find(n=>n.imageLayerId==='grid-0').x);
  await page.locator('[data-close]').click();
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.imageLayerId==='grid-0').x),movedX);
  job={...job,status:'paused',phase:'已停止后续处理',layers:job.layers.map((layer,i)=>({...layer,status:i?'generating':'generated',url:i?null:'/output/done.png'}))};
  await page.locator('[data-close]').click();
  await page.evaluate(id=>openSmartImageLayers(id),id);
  assert.match(await page.locator('[data-status]').textContent(),/已暂停 · 已生成 1\/9 层 · 未生成 8 层/);
  assert.equal(await page.locator('.image-layers-list').getByText('未生成 · 已暂停',{exact:true}).count(),8);
  assert.equal(await page.locator('.image-layers-spinner').count(),0);
  assert.deepEqual(errors,[]);
});
