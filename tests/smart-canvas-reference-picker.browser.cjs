const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname,'..');
const urls = ['A','B','C'].map(name=>`/fixture-images/${name}.png`);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=','base64');

async function fixture(t){
    const browser=await chromium.launch({channel:'msedge',headless:true});
    t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1600,height:1000}});
    page.setDefaultTimeout(7000);
    const errors=[],calls=[];
    let imageRequests=0, saves=0;
    let stored={id:'picker',title:'连续参考图验收',nodes:[],connections:[],logs:[],settings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'fixture-image',videoProvider:'fixture',videoModel:'fixture-video',count:1}};
    page.on('pageerror',error=>errors.push(error.message));
    t.after(()=>assert.deepEqual(errors,[],'no browser exceptions'));
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',async route=>{
        const request=route.request(), url=new URL(request.url()), pathname=url.pathname;
        if(url.hostname!=='reference-picker.test')return route.abort();
        if(pathname.startsWith('/static/')){
            const file=path.resolve(root,'.'+decodeURIComponent(pathname));
            assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(pathname.includes('media-preview')||pathname.startsWith('/fixture-images/')){
            imageRequests++;
            const source=url.searchParams.get('url')||pathname;
            const name=source.match(/([A-F])\.png/)?.[1]||'图';
            const color={A:'#f3c883',B:'#9bc9c4',C:'#b6bce4',D:'#e4b5b1',E:'#b8d5ac',F:'#ddc6e9'}[name]||'#bcc6d4';
            return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${color}"/><circle cx="160" cy="120" r="65" fill="white" opacity=".45"/><text x="160" y="147" text-anchor="middle" font-family="sans-serif" font-size="76" fill="#303b49">${name}</text></svg>`});
        }
        if(pathname==='/api/config')return route.fulfill({json:{api_providers:[
            {id:'fixture',name:'Fixture',enabled:true,protocol:'openai',chat_models:['fixture-chat'],image_models:['fixture-image'],video_models:['fixture-video']},
            {id:'apimart',name:'APIMart',enabled:true,protocol:'apimart',video_models:['veo3.1-lite','veo3.1-fast']},
            {id:'volcengine',name:'火山',enabled:true,protocol:'volcengine',video_models:['doubao-seedance-2-0','doubao-seedance-1-0']}
        ],comfy_instances:[]}});
        if(pathname==='/api/canvases/picker'){
            if(request.method()==='PUT'){stored={...stored,...request.postDataJSON()};saves++;}
            return route.fulfill({json:{canvas:stored}});
        }
        if(pathname==='/api/ai/upload'){
            const names=[...request.postDataBuffer().toString('utf8').matchAll(/filename="([^"]+)"/g)].map(match=>match[1]);
            return route.fulfill({json:{files:names.map(name=>({url:`/fixture-images/${name}`,name,kind:'image'}))}});
        }
        if(request.method()==='POST')calls.push({path:pathname,body:request.postDataJSON()});
        if(pathname==='/api/canvas-llm')return route.fulfill({json:{text:'按引用顺序分析完成'}});
        if(pathname==='/api/canvas-agent-action')return route.fulfill({json:{no_generation:true,can_apply:false,summary:'已分析'}});
        if(pathname==='/api/canvas-video')return route.fulfill({json:{videos:['/fixture-video/output.mp4']}});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
    });
    await page.goto('http://reference-picker.test/static/smart-canvas.html?id=picker');
    await page.waitForFunction(()=>smartConfigReady&&canvas?.id==='picker'&&window.CanvasAgentReferenceBridge);
    return {page,calls,stored:()=>stored,imageRequests:()=>imageRequests,saves:()=>saves};
}

async function reset(page,type='smart-paint'){
    await page.evaluate(type=>{
        SmartCanvasReferencePicker.finish();
        closeCanvasAgentPanel();
        canvas.id='picker';
        nodes=[
            {id:'source',type:'smart-upload',x:60,y:100,w:330,h:330,images:['A','B','C'].map(name=>({url:`/fixture-images/${name}.png`,name,kind:'image',natural_w:320,natural_h:240,asset_uris:{fixture:`asset://${name}`},mime_type:'image/png'}))},
            {id:'single',type:'smart-upload',x:440,y:100,w:240,h:200,images:[{url:'/fixture-images/D.png',name:'D',kind:'image',natural_w:320,natural_h:240}]},
            {id:'results',type:'smart-paint',x:60,y:520,w:280,h:220,runAt:1,images:[{url:'/fixture-images/E.png',name:'E',kind:'image'},{url:'/fixture-images/F.png',name:'F',kind:'image'}]},
            {id:'target',type,x:1040,y:120,w:type==='smart-paint'?280:460,h:type==='smart-paint'?250:520,images:[],text:'请按图1、图2、图3分析',userPrompt:'请按图1、图2、图3分析',llmInstruction:'请按顺序分析',llmEnabled:true,llmProvider:'fixture',llmModel:'fixture-chat',agentProvider:'fixture',agentModel:'fixture-chat',runSettings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'fixture-image',videoProvider:'fixture',videoModel:'fixture-video',count:1}}
        ];
        canvas.connections=[];canvasUsesConnections=true;
        selectedId='target';selectedIds=[];selectedImage={nodeId:'',index:-1};
        activeComposerSubject=null;lastComposerNodeId='';
        viewport={x:0,y:0,scale:1};
        applyViewport();render();
        CanvasAgentReferenceBridge.restore({owner:CanvasAgentReferenceBridge.targetId(),canvas:[],files:[],removed:[]});
        undoStack.length=0;redoStack.length=0;
    },type);
}
const tile=(page,index,node='source')=>page.locator(`.image-node[data-id="${node}"] .thumb-item[data-image-index="${index}"],.image-node[data-id="${node}"] .image-wrap[data-image-index="${index}"]`).first();
const references=page=>page.evaluate(()=>nodeReferencePickerImages(nodes.find(node=>node.id==='target')).map(ref=>ref.url));
async function start(page){
    await page.locator('#inputThumbsRow [data-reference-picker-node="target"]').click();
    await page.locator('.reference-picker-bar').waitFor();
}
async function choose(page,indices=[0,1,2]){for(const index of indices)await tile(page,index).click();}

test('unified continuous reference selection', {timeout:180000},async t=>{
    const f=await fixture(t),{page}=f;
    await t.test('01 continuous selection of three images, fixed target and local DOM updates',async()=>{
        await reset(page);await start(page);
        await page.evaluate(()=>{window.pickerSourceElement=document.querySelector('[data-id="source"]');});
        await choose(page);
        assert.deepEqual(await references(page),urls);
        assert.equal(await page.evaluate(()=>selectedId),'target');
        assert.equal(await page.evaluate(()=>pickerSourceElement===document.querySelector('[data-id="source"]')),true);
        assert.equal(await page.locator('.reference-picker-bar').count(),1);
        assert.equal(await page.locator('[data-picker-count]').textContent(),'已选 3 张');
        assert.deepEqual(await page.locator('[data-id="source"] [data-picker-order]').evaluateAll(items=>items.map(item=>item.dataset.pickerOrder)),['1','2','3']);
    });
    await t.test('02 repeat click removes a single reference and renumbers',async()=>{
        await tile(page,1).click();
        assert.deepEqual(await references(page),[urls[0],urls[2]]);
        assert.deepEqual(await page.locator('[data-id="source"] [data-picker-order]').evaluateAll(items=>items.map(item=>item.dataset.pickerOrder)),['1','2']);
        await tile(page,1).click();
        assert.deepEqual(await references(page),[urls[0],urls[2],urls[1]]);
    });
    await t.test('03 Done and Escape preserve inputs and restore normal selection',async()=>{
        await page.locator('[data-reference-picker-done]').click();
        assert.deepEqual(await references(page),[urls[0],urls[2],urls[1]]);
        await start(page);await page.keyboard.press('Escape');
        assert.equal(await page.locator('.reference-picker-source').count(),0);
        await tile(page,0,'single').click();
        assert.equal(await page.evaluate(()=>selectedId),'single');
        assert.equal(await page.evaluate(()=>nodes.length),4);
    });
    await t.test('04 blank node regions do not select all images or change the target',async()=>{
        await reset(page);await start(page);
        await page.locator('[data-id="source"]').dispatchEvent('click',{bubbles:true});
        assert.deepEqual(await references(page),[]);
        assert.equal(await page.evaluate(()=>selectedId),'target');
    });
    await t.test('05 one image from a multi-image upload and a batch result',async()=>{
        await choose(page,[2]);await tile(page,1,'results').click();
        assert.deepEqual(await references(page),[urls[2],'/fixture-images/F.png']);
    });
    await t.test('06 grouped images resolve the actual child and index',async()=>{
        await reset(page);
        await page.evaluate(()=>{
            nodes.push({id:'group',type:'smart-group',x:60,y:100,w:330,h:330,images:[],items:['source']});
            canvas.connections.push({from:'source',to:'group',kind:'input'});
            nodes.find(node=>node.id==='source').x=-1800;
            render();
        });
        await start(page);
        const grouped=page.locator('[data-id="group"] [data-ref-node-id="source"][data-ref-image-index="1"]').first();
        await grouped.click();
        assert.deepEqual(await references(page),[urls[1]]);
        assert.equal(await page.evaluate(()=>nodes.find(node=>node.id==='target').manualInputRefs[0].nodeId),'source');
    });
    await t.test('07 zoom and blank-canvas panning keep the target and reference strip',async()=>{
        await reset(page);await start(page);
        await page.evaluate(()=>{viewport.scale=.65;applyViewport();});
        await choose(page,[0]);
        await page.mouse.move(800,750);await page.mouse.down();await page.mouse.move(830,775,{steps:5});await page.mouse.up();
        assert.equal(await page.evaluate(()=>selectedId),'target');
        assert.equal(await page.locator('#composer').evaluate(el=>el.classList.contains('open')),true);
        assert.deepEqual(await references(page),[urls[0]]);
        await page.mouse.wheel(0,-80);
        assert.equal(await page.evaluate(()=>SmartCanvasReferencePicker.active.targetId),'target');
    });
    await t.test('08 a thumbnail drag exceeds the threshold and never selects',async()=>{
        await reset(page);await start(page);
        const box=await tile(page,0).boundingBox();
        await page.mouse.move(box.x+15,box.y+15);await page.mouse.down();await page.mouse.move(box.x+70,box.y+35,{steps:6});await page.mouse.up();
        assert.deepEqual(await references(page),[]);
        assert.equal(await page.evaluate(()=>thumbDragState===null&&dragState===null),true);
    });
    await t.test('09 double clicks never open preview or detach media',async()=>{
        await tile(page,0).dblclick();
        assert.equal(await page.locator('#smartLogLightbox.open,.preview-modal.open').count(),0);
        assert.deepEqual(await references(page),[]);
        assert.equal(await page.evaluate(()=>nodes.length),4);
    });
    await t.test('10 selecting and removing automatic inputs preserves all connections',async()=>{
        await reset(page);
        await page.evaluate(()=>{canvas.connections=[{from:'source',to:'target',kind:'input'}];render();});
        await start(page);await tile(page,1).click();
        assert.deepEqual(await references(page),[urls[0],urls[2]]);
        await tile(page,1).click();
        assert.deepEqual(await references(page),[urls[0],urls[2],urls[1]]);
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[{from:'source',to:'target',kind:'input'}]);
        assert.equal(await page.evaluate(()=>nodes.length),4);
    });
    await t.test('11 image payload follows sorted UI order and retains media metadata',async()=>{
        await reset(page);await start(page);await choose(page,[2,0,1]);
        await page.evaluate(()=>{const node=nodes.find(item=>item.id==='target');reorderInputThumb(node,nodeReferencePickerImages(node),2,0);});
        const submitted=await page.evaluate(async()=>{
            let payload;
            const original=XiaomeiImageTaskClient.createImageTask;
            XiaomeiImageTaskClient.createImageTask=async body=>{payload=body;return {task_id:'picker-image'};};
            try{const request=buildPromptRequest(selectedNode());await runApiGeneration(request.prompt,request.refs,settings);}
            finally{XiaomeiImageTaskClient.createImageTask=original;}
            return payload.reference_images;
        });
        assert.deepEqual(submitted.map(ref=>ref.url),[urls[1],urls[2],urls[0]]);
        assert.equal(submitted[0].mime_type,'image/png');
        assert.deepEqual(submitted[0].asset_uris,{fixture:'asset://B'});
        assert.deepEqual(await references(page),submitted.map(ref=>ref.url));
    });
    await t.test('12 video first/last frame roles match order and a third frame is rejected',async()=>{
        await reset(page);
        await page.evaluate(()=>{settings.apiKind='video';settings.videoProvider='volcengine';settings.videoModel='doubao-seedance-2-0';settings.videoUseFrameRoles=true;settings.videoMultimodal=false;});
        await start(page);await choose(page,[2,0,1]);
        assert.deepEqual(await references(page),[urls[2],urls[0]]);
        assert.match(await page.locator('[data-picker-hint]').textContent(),/最多支持 2/);
        await page.evaluate(()=>runApiVideoGeneration('视频验收',buildPromptRequest(selectedNode()).refs,settings));
        const payload=f.calls.filter(call=>call.path==='/api/canvas-video').at(-1).body;
        assert.deepEqual(payload.images.map(ref=>[ref.url,ref.role]),[[urls[2],'first_frame'],[urls[0],'last_frame']]);
    });
    await t.test('13 Prompt node references are independent inputs and submitted in order',async()=>{
        await reset(page,'smart-prompt');
        await page.locator('[data-id="target"] .node-reference-picker-entry').click();await choose(page,[2,0]);
        assert.deepEqual(await references(page),[urls[2],urls[0]]);
        await page.keyboard.press('Escape');
        assert.equal((await page.evaluate(()=>runPromptLLMNode('target'))).ok,true);
        assert.deepEqual(f.calls.filter(call=>call.path==='/api/canvas-llm').at(-1).body.images,[urls[2],urls[0]]);
        assert.deepEqual(await page.evaluate(()=>imagesForNode(nodes.find(node=>node.id==='target'))),[]);
    });
    await t.test('14 Agent node uses the same interaction and original request path',async()=>{
        await reset(page,'smart-agent');
        await page.locator('[data-id="target"] .node-reference-picker-entry').click();await choose(page,[1,2]);await page.keyboard.press('Escape');
        assert.equal((await page.evaluate(()=>runAgentNode('target'))).ok,true);
        assert.deepEqual(f.calls.filter(call=>call.path==='/api/canvas-llm').at(-1).body.images,[urls[1],urls[2]]);
    });
    await t.test('15 Agent composer deduplicates uploads, submits and saves the actual snapshot',async()=>{
        await reset(page);
        await page.locator('#canvasAgentToggle').click();
        await page.locator('#canvasAgentComposerMenuToggle').click();
        await page.locator('[data-composer-menu-action="canvas"]').click();
        await choose(page,[0,2]);await page.keyboard.press('Escape');
        await page.locator('#canvasAgentComposerFileInput').setInputFiles([{name:'A.png',mimeType:'image/png',buffer:pixel},{name:'upload.png',mimeType:'image/png',buffer:pixel}]);
        await page.waitForFunction(()=>CanvasAgentReferenceBridge.references().length===3);
        assert.deepEqual(await page.evaluate(()=>CanvasAgentReferenceBridge.references().map(ref=>ref.url)),[urls[0],urls[2],'/fixture-images/upload.png']);
        await page.locator('#canvasAgentInput').fill('只分析这些图片，不要生成图片');
        await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(()=>!document.getElementById('canvasAgentSend').disabled);
        const request=f.calls.filter(call=>call.path==='/api/canvas-agent-action').at(-1);
        assert.deepEqual(request.body.images,[urls[0],urls[2],'/fixture-images/upload.png']);
        assert.deepEqual(await page.locator('.agent-message-refs img').last().getAttribute('alt'),'upload.png');
        assert.deepEqual(await references(page),[]);
    });
    await t.test('16 target sessions and Agent composer references stay isolated',async()=>{
        await reset(page);await start(page);await choose(page,[0]);await page.keyboard.press('Escape');
        await page.evaluate(()=>{nodes.push({...nodes.find(node=>node.id==='target'),id:'other',manualInputRefs:[],inputRefOrder:[]});startNodeReferencePicker('other');});
        await choose(page,[1]);await page.keyboard.press('Escape');
        assert.deepEqual(await references(page),[urls[0]]);
        assert.deepEqual(await page.evaluate(()=>nodeReferencePickerImages(nodes.find(node=>node.id==='other')).map(ref=>ref.url)),[urls[1]]);
        assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),1,'automatic task references remain derived from the selected target');
    });
    await t.test('17 saved references and order survive reload',async()=>{
        await reset(page);await start(page);await choose(page,[2,0,1]);await page.keyboard.press('Escape');
        await page.evaluate(()=>saveCanvas());await page.reload();
        await page.waitForFunction(()=>canvas?.id==='picker'&&nodes.some(node=>node.id==='target'));
        await page.evaluate(()=>{selectedId='target';selectedIds=[];updateComposer();});
        assert.deepEqual(await references(page),[urls[2],urls[0],urls[1]]);
        assert.deepEqual(f.stored().nodes.find(node=>node.id==='target').inputRefOrder,urls.map((_,i)=>`ref|${[urls[2],urls[0],urls[1]][i]}`));
    });
    await t.test('18 one session is one undo unit, including the Agent composer',async()=>{
        await reset(page);await start(page);await choose(page);await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(()=>undoStack.length),1);
        await page.evaluate(()=>performUndo());assert.deepEqual(await references(page),[]);
        await page.evaluate(()=>performRedo());assert.deepEqual(await references(page),urls);
        await reset(page);await page.locator('#canvasAgentToggle').click();
        await page.evaluate(()=>CanvasAgentReferenceBridge.start());await choose(page,[0,1]);await page.keyboard.press('Escape');
        await page.evaluate(()=>performUndo());assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),0);
        await page.evaluate(()=>performRedo());assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),2);
    });
    await t.test('19 light and dark themes retain visible selection and a fixed toolbar',async()=>{
        await reset(page);await start(page);await choose(page,[0]);
        const artifacts=path.join(os.tmpdir(),'xiaomei-reference-picker-qa');fs.mkdirSync(artifacts,{recursive:true});
        for(const theme of ['light','dark']){
            await page.evaluate(theme=>applyTheme(theme),theme);
            const bounds=await page.locator('.reference-picker-bar').boundingBox();
            assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1600);
            assert.notEqual(await tile(page,0).evaluate(el=>getComputedStyle(el).boxShadow),'none');
            await page.screenshot({path:path.join(artifacts,`${theme}.png`)});
        }
        console.log(`Picker screenshots: ${artifacts}`);
    });
    await t.test('20 large canvases keep virtualization and do not decode sources on entering',async()=>{
        await reset(page);
        await page.evaluate(()=>{for(let i=0;i<1500;i++)nodes.push({id:`offscreen-${i}`,type:'smart-upload',x:10000+i*400,y:5000,images:[{url:`/fixture-images/perf-${i}.png`,kind:'image'}]});render();});
        await page.waitForTimeout(100);
        const before=f.imageRequests(),visible=await page.locator('.image-node').count();
        const duration=await page.evaluate(()=>{const began=performance.now();startNodeReferencePicker('target');return performance.now()-began;});
        assert.ok(visible<100,`${visible} visible nodes for 1504 total`);
        assert.ok(duration<1500,`entering took ${duration.toFixed(1)}ms`);
        assert.equal(f.imageRequests(),before,'entering requests no new images');
        await choose(page);assert.deepEqual(await references(page),urls);
        console.log(`Picker performance: ${duration.toFixed(1)}ms, ${visible} rendered / 1504 total nodes`);
        const dense=await page.evaluate(()=>{
            SmartCanvasReferencePicker.finish();
            const source=nodes.find(node=>node.id==='source');
            source.images=[...source.images,...Array.from({length:125},(_,index)=>({url:`/fixture-images/dense-${index}.png`,kind:'image'}))];
            render();
            const original=imagesForNode;
            let scans=0;
            imagesForNode=function(node,...args){if(node?.id==='source')scans++;return original(node,...args);};
            try{
                const began=performance.now();startNodeReferencePicker('target');
                return {duration:performance.now()-began,scans,tiles:document.querySelectorAll('[data-id="source"] .reference-picker-source').length};
            }finally{imagesForNode=original;}
        });
        assert.equal(dense.tiles,128);assert.ok(dense.scans<20,`${dense.scans} full scans for 128 thumbnails`);
        assert.ok(dense.duration<1500,`dense group took ${dense.duration.toFixed(1)}ms`);
        console.log(`Picker dense group: ${dense.duration.toFixed(1)}ms, ${dense.scans} source scans / ${dense.tiles} thumbnails`);
    });
    await t.test('21 missing sources are explicit and target deletion safely exits',async()=>{
        await reset(page);await start(page);await choose(page,[1]);
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.splice(1,1);render();});
        await page.waitForFunction(()=>document.querySelector('[data-picker-hint]')?.textContent.includes('引用已失效'));
        assert.deepEqual(await references(page),[urls[1]],'the missing source never redirects to the shifted index');
        const error=await page.evaluate(async()=>{try{await runApiGeneration('测试',buildPromptRequest(selectedNode()).refs,settings);return '';}catch(error){return error.message;}});
        assert.match(error,/引用已失效/);
        await page.evaluate(()=>{nodes=nodes.filter(node=>node.id!=='target');render();});
        await page.locator('.reference-picker-bar').waitFor({state:'detached'});
    });
    await t.test('22 model switches revalidate counts and never silently truncate',async()=>{
        await reset(page);await page.evaluate(()=>{settings.apiKind='video';});await start(page);await choose(page);
        await page.evaluate(()=>{settings.videoUseFrameRoles=true;window.dispatchEvent(new CustomEvent('smart-canvas-generation-settings-change'));});
        await page.waitForFunction(()=>document.querySelector('[data-picker-hint]')?.textContent.includes('最多支持 2'));
        assert.deepEqual(await references(page),urls);
        const before=f.calls.filter(call=>call.path==='/api/canvas-video').length;
        const error=await page.evaluate(async()=>{try{await runApiVideoGeneration('测试',buildPromptRequest(selectedNode()).refs,settings);return '';}catch(error){return error.message;}});
        assert.match(error,/最多支持 2/);
        assert.equal(f.calls.filter(call=>call.path==='/api/canvas-video').length,before);
        await page.evaluate(()=>{settings.videoUseFrameRoles=false;settings.videoProvider='apimart';settings.videoModel='veo3.1-lite';SmartCanvasReferencePicker.refresh();});
        assert.match(await page.locator('[data-picker-hint]').textContent(),/不支持此素材/);
    });
    await t.test('23 source reorder uses stable identity and project switches clean up',async()=>{
        await reset(page);await start(page);await choose(page,[0,2]);
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.reverse();render();});
        assert.deepEqual(await references(page),[urls[0],urls[2]]);
        assert.deepEqual(await page.evaluate(()=>manualReferenceImagesFor(nodes.find(node=>node.id==='target')).map(ref=>ref.imageIndex)),[2,0]);
        await page.evaluate(()=>{canvas.id='another-project';render();});
        await page.locator('.reference-picker-bar').waitFor({state:'detached'});
        assert.equal(await page.locator('.reference-picker-selected').count(),0);
    });
    await t.test('24 real pointer sorting in a live session shares the same undo unit',async()=>{
        await reset(page);await start(page);await choose(page);
        const thumbs=page.locator('#inputThumbsRow .input-thumb');
        const from=await thumbs.nth(2).boundingBox(),to=await thumbs.first().boundingBox();
        await page.mouse.move(from.x+20,from.y+20);await page.mouse.down();await page.mouse.move(to.x+3,to.y+20,{steps:8});await page.mouse.up();
        assert.deepEqual(await references(page),[urls[2],urls[0],urls[1]]);
        assert.equal(await page.evaluate(()=>undoStack.length),1);
        await page.keyboard.press('Escape');await page.evaluate(()=>performUndo());assert.deepEqual(await references(page),[]);
    });
    await t.test('25 Agent composer drag order is used by the request and message snapshot',async()=>{
        await reset(page);await page.locator('#canvasAgentToggle').click();
        await page.evaluate(()=>CanvasAgentReferenceBridge.start());await choose(page);await page.keyboard.press('Escape');
        const thumbs=page.locator('#canvasAgentComposerAttachments .canvas-agent-composer-attachment');
        const from=await thumbs.first().boundingBox(),to=await thumbs.nth(2).boundingBox();
        await page.mouse.move(from.x+15,from.y+15);await page.mouse.down();await page.mouse.move(to.x+20,to.y+20,{steps:8});await page.mouse.up();
        const expected=[urls[1],urls[2],urls[0]];
        assert.deepEqual(await page.evaluate(()=>CanvasAgentReferenceBridge.references().map(ref=>ref.url)),expected);
        await page.locator('#canvasAgentInput').fill('只分析这些图片，不要生成图片');await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(()=>!document.getElementById('canvasAgentSend').disabled);
        assert.deepEqual(f.calls.filter(call=>call.path==='/api/canvas-agent-action').at(-1).body.images,expected);
        assert.deepEqual(await page.locator('.agent-message-refs').last().locator('img').evaluateAll(items=>items.map(item=>item.alt)),['B','C','A']);
        assert.equal(await page.locator('.reference-attachment-ghost').count(),0);
    });
    await t.test('26 removing automatic, canvas and uploaded composer inputs keeps only actual submitted images',async()=>{
        await reset(page);await page.evaluate(()=>{canvas.connections=[{from:'source',to:'target',kind:'input'}];render();});
        await page.locator('#canvasAgentToggle').click();await page.evaluate(()=>CanvasAgentReferenceBridge.start());
        await tile(page,0,'single').click();await page.keyboard.press('Escape');
        await page.locator('#canvasAgentComposerFileInput').setInputFiles({name:'upload.png',mimeType:'image/png',buffer:pixel});
        await page.waitForFunction(()=>CanvasAgentReferenceBridge.references().length===5);
        for(const name of ['B','D','upload.png'])await page.locator('.canvas-agent-composer-attachment').filter({has:page.locator(`img[alt="${name}"]`)}).locator('button').click();
        assert.deepEqual(await page.evaluate(()=>CanvasAgentReferenceBridge.references().map(ref=>ref.url)),[urls[0],urls[2]]);
        await page.locator('#canvasAgentInput').fill('只分析这些图片，不要生成图片');await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(()=>!document.getElementById('canvasAgentSend').disabled);
        assert.deepEqual(f.calls.filter(call=>call.path==='/api/canvas-agent-action').at(-1).body.images,[urls[0],urls[2]]);
        assert.deepEqual(await references(page),urls,'the node keeps its independent references');
    });
    await t.test('27 composer drafts survive reload and stay isolated by project and conversation',async()=>{
        await reset(page);await page.locator('#canvasAgentToggle').click();await page.evaluate(()=>CanvasAgentReferenceBridge.start());
        await choose(page,[0]);await page.keyboard.press('Escape');await page.evaluate(()=>saveCanvas());
        await page.reload();await page.waitForFunction(()=>smartConfigReady&&canvas?.id==='picker'&&window.CanvasAgentReferenceBridge);
        assert.deepEqual(await page.evaluate(()=>CanvasAgentReferenceBridge.references().map(ref=>ref.url)),[urls[0]]);
        await page.evaluate(()=>{canvas.id='other-project';render();});
        assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),0);
        await page.evaluate(()=>{canvas.id='picker';render();});
        assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),1);
        await page.locator('#canvasAgentToggle').click();await page.evaluate(()=>CanvasAgentReferenceBridge.start());
        await page.locator('#canvasAgentNew').click();
        assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references().length),0);
        assert.equal(await page.evaluate(()=>SmartCanvasReferencePicker.active),null);
    });
    await t.test('28 image model limits are read from server configuration and rechecked at submission',async()=>{
        await reset(page);await start(page);await choose(page);
        await page.evaluate(()=>{smartReferenceImageLimits={default:20,models:{fixture:{'fixture-image':2}}};window.dispatchEvent(new CustomEvent('smart-canvas-generation-settings-change'));});
        await page.waitForFunction(()=>document.querySelector('[data-picker-hint]')?.textContent.includes('最多支持 2'));
        const error=await page.evaluate(async()=>{try{await runApiGeneration('测试',buildPromptRequest(selectedNode()).refs,settings);return '';}catch(error){return error.message;}});
        assert.match(error,/最多支持 2/);assert.deepEqual(await references(page),urls);
        await page.evaluate(()=>{smartReferenceImageLimits={default:20,models:{}};});
    });
    await t.test('29 sorting mixed automatic and manual inputs keeps stable identities after source reorder',async()=>{
        await reset(page);
        await page.evaluate(()=>{canvas.connections=[{from:'source',to:'target',kind:'input'}];render();});
        await start(page);await tile(page,0,'single').click();
        const thumbs=page.locator('#inputThumbsRow .input-thumb');
        const from=await thumbs.nth(2).boundingBox(),to=await thumbs.first().boundingBox();
        await page.mouse.move(from.x+20,from.y+20);await page.mouse.down();await page.mouse.move(to.x+3,to.y+20,{steps:8});await page.mouse.up();
        const expected=[urls[2],urls[0],urls[1],'/fixture-images/D.png'];
        assert.deepEqual(await references(page),expected);
        assert.equal(await page.evaluate(()=>nodes.find(node=>node.id==='target').inputRefOrder.every(key=>key.startsWith('ref|'))),true);
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.reverse();render();});
        assert.deepEqual(await references(page),expected);
        assert.equal(await page.evaluate(()=>undoStack.length),1);
        await page.keyboard.press('Escape');await page.evaluate(()=>saveCanvas());
        await page.reload();await page.waitForFunction(()=>smartConfigReady&&canvas?.id==='picker');
        assert.deepEqual(await references(page),expected);
        assert.deepEqual(await page.evaluate(()=>buildPromptRequest(nodes.find(node=>node.id==='target')).refs.map(ref=>ref.url)),expected);
    });
    await t.test('30 video transport limits preserve supported audio and reject excess images before submitting',async()=>{
        await reset(page);
        const result=await page.evaluate(async()=>{
            apiProviders.push({id:'yuli-test',base_url:'https://yuli.host/v1',protocol:'openai'},{id:'lingjing',base_url:'https://apistudio.vip/v1',protocol:'openai'});
            const refs=imagesForNode(nodes.find(node=>node.id==='source'));
            const yuli=validateReferenceInputs(refs.slice(0,2),{videoProvider:'yuli-test',videoModel:'veo_3_1-fast'},'node-video');
            const lingjing=validateReferenceInputs([...refs,{url:'/fixture-images/D.png',kind:'image'}],{videoProvider:'lingjing',videoModel:'veo_3_1-fast'},'node-video');
            const audio={url:'/fixture-audio/input.mp3',kind:'audio',mime_type:'audio/mpeg'};
            const apimart=validateReferenceInputs([refs[0],audio],{videoProvider:'apimart',videoModel:'doubao-seedance-2.0'},'node-video');
            const mixedFrames=validateReferenceInputs([refs[0],{url:'/fixture-video/input.mp4',kind:'video'}],{videoProvider:'apimart',videoModel:'doubao-seedance-2.0',videoUseFrameRoles:true},'node-video');
            await runApiVideoGeneration('测试音频引用',[refs[0],audio],{videoProvider:'apimart',videoModel:'doubao-seedance-2.0',videoMultimodal:true});
            return {yuli,lingjing,apimart,mixedFrames};
        });
        assert.match(result.yuli,/最多支持 1/);assert.match(result.lingjing,/最多支持 3/);assert.equal(result.apimart,'');
        assert.match(result.mixedFrames,/不能同时使用参考视频/);
        const payload=f.calls.filter(call=>call.path==='/api/canvas-video').at(-1).body;
        assert.deepEqual(payload.audios,['/fixture-audio/input.mp3']);
        assert.deepEqual(payload.images.map(ref=>ref.url),[urls[0]]);
    });
    await t.test('31 rapid Agent selections debounce draft writes and finish persists the final references',async()=>{
        await reset(page);await page.locator('#canvasAgentToggle').click();await page.evaluate(()=>CanvasAgentReferenceBridge.start());
        const result=await page.evaluate(()=>{
            const original=Storage.prototype.setItem;
            let writes=0;
            Storage.prototype.setItem=function(...args){writes++;return original.apply(this,args);};
            try{
                for(const ref of imagesForNode(nodes.find(node=>node.id==='source')))SmartCanvasReferencePicker.toggle(ref);
                const before=writes;
                SmartCanvasReferencePicker.finish();
                return {before,after:writes,refs:CanvasAgentReferenceBridge.references().map(ref=>ref.url)};
            }finally{Storage.prototype.setItem=original;}
        });
        assert.equal(result.before,0);assert.equal(result.after,1);assert.deepEqual(result.refs,urls);
        await page.reload();await page.waitForFunction(()=>smartConfigReady&&canvas?.id==='picker'&&window.CanvasAgentReferenceBridge);
        assert.deepEqual(await page.evaluate(()=>CanvasAgentReferenceBridge.references().map(ref=>ref.url)),urls);
    });
    await t.test('32 manual canvas references show live lines without changing execution connections',async()=>{
        await reset(page);await start(page);await choose(page,[0]);await tile(page,0,'single').click();
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===2);
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
        await choose(page,[1]);
        assert.equal(await page.locator('.conn-reference').count(),2,'two images from one source share a line');
        await choose(page,[0,1]);
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.conn-reference').count(),1,'finishing keeps the reference line');
        await page.locator('#inputThumbsRow .input-thumb').hover();
        await page.locator('#inputThumbsRow .input-thumb-remove').click();
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===0);
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
    });
    await t.test('33 Agent sends the same resolved source index shown by its attachment after source reorder',async()=>{
        await reset(page);await page.locator('#canvasAgentToggle').click();
        await page.evaluate(()=>CanvasAgentReferenceBridge.start());await choose(page,[2]);await page.keyboard.press('Escape');
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.reverse();render();});
        assert.equal(await page.evaluate(()=>CanvasAgentReferenceBridge.references()[0].imageIndex),0);
        await page.locator('#canvasAgentInput').fill('只分析这些图片，不要生成图片');await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(()=>!document.getElementById('canvasAgentSend').disabled);
        const request=f.calls.filter(call=>call.path==='/api/canvas-agent-action').at(-1);
        assert.deepEqual(request.body.images,[urls[2]]);
        assert.equal(request.body.canvas_context.references[0].image_index,0);
        const snapshot=await page.evaluate(()=>{
            const saved=JSON.parse(localStorage.getItem('xiaomei_canvas_agent_v2_picker'));
            return saved.conversations.find(item=>item.id===saved.activeId).messages.filter(item=>item.role==='user').at(-1).referenceImages;
        });
        assert.equal(snapshot[0].imageIndex,0);
    });
    await t.test('34 grouped references use the visible group and never duplicate a formal connection',async()=>{
        await reset(page);
        await page.evaluate(()=>{
            nodes.push({id:'group',type:'smart-group',x:60,y:100,w:330,h:330,images:[],items:['source']});
            canvas.connections=[{from:'source',to:'group',kind:'input'}];
            nodes.find(node=>node.id==='source').x=-1800;render();
        });
        await start(page);
        for(const index of [0,2])await page.locator(`[data-id="group"] [data-ref-node-id="source"][data-ref-image-index="${index}"]`).first().click();
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
        assert.equal(await page.locator('.conn-reference').getAttribute('data-conn-from'),'group');
        assert.deepEqual(await references(page),[urls[0],urls[2]]);
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[{from:'source',to:'group',kind:'input'}]);
        await page.keyboard.press('Escape');
        await page.evaluate(()=>{canvas.connections.push({from:'group',to:'target',kind:'input'});render();});
        assert.equal(await page.locator('.conn-reference').count(),0);
        assert.equal(await page.locator('.conn-group').count(),1);
    });
    await t.test('35 reference endpoints follow a dragged target, canvas pan and zoom',async()=>{
        await reset(page);await start(page);await choose(page,[1]);await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
        const before=await page.evaluate(()=>nodes.find(node=>node.id==='target').x);
        const box=await page.locator('[data-id="target"]').boundingBox();
        await page.mouse.move(box.x+90,box.y+75);await page.mouse.down();
        await page.mouse.move(box.x+180,box.y+120,{steps:8});await page.mouse.up();
        assert.ok(await page.evaluate(before=>nodes.find(node=>node.id==='target').x>before,before));
        await page.mouse.move(800,800);await page.mouse.down();await page.mouse.move(845,825,{steps:5});await page.mouse.up();
        await page.evaluate(()=>setCanvasZoom(.7));
        await page.waitForFunction(()=>[...document.querySelectorAll('.conn-reference')].every(group=>{
            const path=group.querySelector('.conn-line'),from=nodes.find(node=>node.id===group.dataset.connFrom),to=nodes.find(node=>node.id===group.dataset.connTo);
            const start=path.getPointAtLength(0),end=path.getPointAtLength(path.getTotalLength());
            const expectedStart=nodeConnectionWorldPoint(from,'out'),expectedEnd=nodeConnectionWorldPoint(to,'in');
            return Math.hypot(start.x-expectedStart.x,start.y-expectedStart.y)<1&&Math.hypot(end.x-expectedEnd.x,end.y-expectedEnd.y)<1;
        }));
        assert.deepEqual(await references(page),[urls[1]]);assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
    });
    await t.test('36 reference lines survive undo, redo, saved reload and both themes',async()=>{
        await reset(page);await start(page);await choose(page,[2]);await tile(page,0,'single').click();await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===2);
        await page.evaluate(()=>performUndo());assert.equal(await page.locator('.conn-reference').count(),0);
        await page.evaluate(()=>performRedo());assert.equal(await page.locator('.conn-reference').count(),2);
        await page.evaluate(()=>saveCanvas());await page.reload();
        await page.waitForFunction(()=>smartConfigReady&&canvas?.id==='picker'&&document.querySelectorAll('.conn-reference').length===2);
        assert.deepEqual(await references(page),[urls[2],'/fixture-images/D.png']);
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
        await page.evaluate(()=>{
            nodes=nodes.filter(node=>node.id!=='results');
            Object.assign(nodes.find(node=>node.id==='source'),{x:60,y:60});
            Object.assign(nodes.find(node=>node.id==='single'),{x:60,y:500});
            Object.assign(nodes.find(node=>node.id==='target'),{x:1040,y:200});
        });
        const artifacts=path.join(os.tmpdir(),'xiaomei-reference-lines-qa');fs.mkdirSync(artifacts,{recursive:true});
        for(const theme of ['light','dark']){
            await page.evaluate(theme=>{selectedId='target';selectedIds=[];applyTheme(theme);render();},theme);
            assert.equal(await page.locator('.conn-reference .conn-line').evaluateAll(paths=>paths.every(path=>getComputedStyle(path).stroke!=='none'&&path.getTotalLength()>100)),true);
            await page.mouse.move(1530,850);await page.waitForTimeout(250);
            await page.screenshot({path:path.join(artifacts,`${theme}-lines.png`)});
        }
        console.log(`Reference line screenshots: ${artifacts}`);
    });
    await t.test('37 reference lines cannot erase or disconnect an unrelated formal connection',async()=>{
        await reset(page);await start(page);await choose(page,[0]);await page.keyboard.press('Escape');
        await page.evaluate(()=>{canvas.connections=[{from:'single',to:'target',kind:'input'}];render();});
        assert.equal(await page.locator('.conn-reference').count(),1);
        assert.equal(await page.locator('.conn-reference [data-conn-index],.conn-reference .conn-hit,.conn-reference .conn-cut').count(),0);
        assert.deepEqual(await page.evaluate(()=>buildConnectionEraseGeometryCache().paths.flatMap(entry=>entry.indices)),[0]);
        await page.locator('.conn-cut[data-conn-index="0"]').click();
        assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
        assert.equal(await page.locator('.conn-reference').count(),1);
        assert.deepEqual(await references(page),[urls[0]]);
    });
    await t.test('38 removing or replacing a source never leaves a line pointing to a different image',async()=>{
        await reset(page);await start(page);await choose(page,[1]);await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.splice(1,1);render();});
        assert.equal(await page.locator('.conn-reference').count(),0);
        assert.equal(await page.evaluate(()=>nodeReferencePickerImages(nodes.find(node=>node.id==='target'))[0].sourceMissing),true);
        assert.deepEqual(await references(page),[urls[1]]);
        await page.evaluate(()=>{nodes.find(node=>node.id==='source').images.push({url:'/fixture-images/B.png',kind:'image'});render();});
        assert.equal(await page.locator('.conn-reference').count(),1);
        await page.evaluate(()=>deleteSelectedNodes(['source']));
        assert.equal(await page.locator('.conn-reference').count(),0);
        assert.deepEqual(await references(page),[urls[1]]);
        await page.evaluate(()=>performUndo());assert.equal(await page.locator('.conn-reference').count(),1);
    });
    await t.test('39 Prompt, Agent and video nodes share reference lines while the Agent composer stays independent',async()=>{
        for(const type of ['smart-prompt','smart-agent','smart-paint']){
            await reset(page,type);
            await page.evaluate(type=>{if(type==='smart-paint')settings.apiKind='video';startNodeReferencePicker('target');},type);
            await choose(page,[0,2]);await page.keyboard.press('Escape');
            await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
            assert.deepEqual(await references(page),[urls[0],urls[2]]);
            assert.deepEqual(await page.evaluate(()=>canvas.connections),[]);
        }
        await reset(page);await page.locator('#canvasAgentToggle').click();await page.evaluate(()=>CanvasAgentReferenceBridge.start());
        await choose(page);await page.keyboard.press('Escape');
        assert.equal(await page.locator('.conn-group').count(),0);
        assert.deepEqual(await references(page),[]);
    });
    await t.test('40 reference rendering reuses normalized source metadata without replacing or decoding nodes',async()=>{
        await reset(page);await start(page);await choose(page);await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelectorAll('.conn-reference').length===1);
        const before=f.imageRequests();
        const result=await page.evaluate(()=>{
            for(let index=0;index<500;index++)nodes.push({id:`reference-target-${index}`,type:'smart-paint',x:12000,y:index*400,images:[],manualInputRefs:[{...nodes.find(node=>node.id==='target').manualInputRefs[0]}]});
            const source=world.querySelector('[data-id="source"]'),original=imagesForNode;
            let scans=0;
            imagesForNode=function(node,...args){if(node?.id==='source')scans++;return original(node,...args);};
            try{
                const began=performance.now();refreshConnectionLayer();
                return {duration:performance.now()-began,scans,preserved:source===world.querySelector('[data-id="source"]')};
            }finally{imagesForNode=original;}
        });
        assert.equal(result.scans,1);assert.equal(result.preserved,true);
        assert.equal(f.imageRequests(),before);assert.ok(result.duration<1500);
        console.log(`Reference line rendering: ${result.duration.toFixed(1)}ms, ${result.scans} source scan / 501 targets`);
    });
    await t.test('41 switching a project resolves uploaded references from the new draft on the first read',async()=>{
        await reset(page);await page.locator('#canvasAgentToggle').click();
        await page.locator('#canvasAgentComposerFileInput').setInputFiles({name:'upload.png',mimeType:'image/png',buffer:pixel});
        await page.waitForFunction(()=>JSON.parse(localStorage.getItem('xiaomei_canvas_agent_v2_picker')).conversations
            .some(item=>item.composerReferences?.files?.some(ref=>ref.url==='/fixture-images/upload.png')));
        const result=await page.evaluate(()=>{
            canvas.id='isolated-upload-project';
            const other=CanvasAgentReferenceBridge.references().map(ref=>ref.url);
            canvas.id='picker';
            return {other,restored:CanvasAgentReferenceBridge.references().map(ref=>ref.url)};
        });
        assert.deepEqual(result,{other:[],restored:['/fixture-images/upload.png']});
    });
});
