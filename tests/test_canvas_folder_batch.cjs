const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const source=readFileSync(path.join(root,'static/js/canvas-folder-batch.js'),'utf8');
const agent=readFileSync(path.join(root,'static/js/canvas-agent.js'),'utf8');
const css=readFileSync(path.join(root,'static/css/canvas-folder-batch.css'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
function batch(id='batch-a',conversation='chat-a',status='imported'){
    return {id,canvas_id:'canvas-a',conversation_id:conversation,name:`文件夹 ${id}`,status,revision:0,message:'状态提示',requirements:[],error:'',summary:'',analysis_done:0,analysis_total:0,generation:{},output_directory:'',created_at:1789341000,
        items:[1,2,3].map(number=>({id:`image-${number}`,number,name:`产品 ${number}.png`,relative_path:`子目录/产品 ${number}.png`,url:number===3?'':`/original-${number}.png`,width:800,height:1000,asset_ref_id:`asset-${number}`,description:'',prompt:'',selected:false,status:number===3?'unreadable':'pending',error:number===3?'无法读取图片':'',result_url:'',attempt:0,task_id:'',versions:[],duplicate_of:number===2?'image-1':''}))};
}
function ready(value){value.status='ready';value.analysis_done=2;value.analysis_total=2;value.revision++;value.items.slice(0,2).forEach(item=>Object.assign(item,{description:'实际图片观察',prompt:'保留产品，浅色背景',selected:true}));return value;}
async function setup(t,initial=[],shared=false){
    const context=await browser.newContext({viewport:{width:520,height:900}});
    t.after(()=>context.close());
    const page=await context.newPage();
    const data={page,context,requests:[],batches:new Map(initial.map(value=>[value.id,value])),handler:null,selected:true,errors:[]};
    page.on('pageerror',error=>data.errors.push(error.message));
    await page.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url()),pathname=url.pathname;
        if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><aside class="canvas-agent-panel open" style="display:flex;flex-direction:column;width:440px;height:800px"><section id="folder"></section><div class="canvas-agent-messages">普通对话</div><textarea id="composer"></textarea></aside></body></html>'});
        if(!pathname.startsWith('/api/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#e8d9c4"/></svg>'});
        const request={path:pathname,method:req.method(),body:req.postDataJSON(),query:Object.fromEntries(url.searchParams)};
        data.requests.push(request);
        if(data.handler){const response=await data.handler(request);if(response)return route.fulfill({status:response.status||200,json:clone(response.body)});}
        if(pathname==='/api/select-folder')return route.fulfill({json:{selected:data.selected,path:'D:\\素材\\产品图'}});
        if(pathname==='/api/canvas-folder-batches'){
            if(request.method==='POST'){const value=batch(`batch-${data.batches.size+1}`,request.body.conversation_id);data.batches.set(value.id,value);return route.fulfill({json:clone(value)});}
            return route.fulfill({json:{batches:clone([...data.batches.values()].filter(value=>value.canvas_id===request.query.canvas_id&&value.conversation_id===request.query.conversation_id))}});
        }
        const parts=pathname.split('/'),value=data.batches.get(parts[3]);
        if(!value)return route.fulfill({status:404,json:{detail:'任务不存在'}});
        if(request.method==='GET')return route.fulfill({json:clone(value)});
        if(request.body?.revision!==undefined&&request.body.revision!==value.revision)return route.fulfill({status:409,json:{detail:'计划已经更新，请刷新后确认'}});
        if(parts[4]==='plan'&&request.method==='POST'){
            value.status='analyzing';value.revision++;value.generation=request.body.generation;value.requirements.push(request.body.message);value.analysis_total=2;
        }else if(parts[4]==='plan'){
            for(const change of request.body.items)Object.assign(value.items.find(item=>item.id===change.id),change);
            value.revision++;
        }else if(parts[4]==='execute'){
            value.status='running';value.revision++;value.output_directory='D:\\生成素材\\folder-batches\\'+value.id;
            value.items.filter(item=>item.url).forEach(item=>{item.status=item.selected?'queued':'skipped';});
        }else if(parts[4]==='pause')value.status='paused';
        else if(parts[4]==='resume')value.status='running';
        else if(parts[4]==='items'){
            value.status='running';value.revision++;
            const item=value.items.find(item=>item.id===parts[5]);item.status='queued';item.attempt++;
        }
        return route.fulfill({json:clone(value)});
    });
    await page.goto(`http://folder.test/${shared?'?shared=1':''}`);
    await page.addStyleTag({content:css});
    await page.addScriptTag({content:source});
    await page.evaluate(async()=>{
        window.ctx={canvasId:'canvas-a',conversationId:'chat-a',provider:'chat-provider',model:'live-chat-model',skillId:'my-skill',generation:{provider_id:'image-provider',model:'live-image-model',size:'1024x1024',aspect_ratio:'1:1',quality:'high',background:'opaque'}};
        window.folder=window.CanvasFolderBatch.create({root:document.getElementById('folder'),getContext:()=>({...window.ctx,generation:{...window.ctx.generation}}),getMessage:()=>document.getElementById('composer').value,onChange:()=>document.querySelector('aside').classList.toggle('has-folder-task',Boolean(window.folder?.hasActive()))});
        await window.folder.refresh();
    });
    data.click=name=>page.locator(`[data-cfb-action="${name}"]`).click();
    data.import=()=>page.evaluate(()=>window.folder.startImport());
    data.openHistory=()=>page.evaluate(async()=>{
        const target=document.createElement('div');
        target.dataset.testHistory='true';
        document.body.appendChild(target);
        await window.folder.openHistory(target);
        return target.innerHTML;
    });
    data.selectTask=id=>page.evaluate(taskId=>window.folder.selectTask(taskId),id);
    data.refresh=()=>data.click('refresh');
    data.wait=async()=>{await page.waitForFunction(()=>!document.querySelector('.cfb-notice')?.textContent.includes('正在提交'));};
    data.switch=conversation=>page.evaluate(async id=>{window.ctx.conversationId=id;await window.folder.refresh();},conversation);
    t.after(()=>assert.deepEqual(data.errors,[]));
    return data;
}
test('folder import stays free; unreadable and duplicate images retain their identities',async t=>{
    const f=await setup(t);
    await f.import();await f.page.waitForSelector('.cfb-gallery[open] .cfb-grid img');
    assert.equal(await f.page.locator('.cfb-grid img').count(),3);
    assert.deepEqual(f.requests.find(req=>req.path==='/api/select-folder').body,{title:'选择要批量改图的文件夹'});
    assert.equal(f.requests.find(req=>req.path==='/api/canvas-folder-batches'&&req.method==='POST').body.conversation_id,'chat-a');
    assert.equal(f.requests.some(req=>/\/(plan|execute)$/.test(req.path)),false);
    f.selected=false;await f.import();await f.wait();
    assert.equal(f.batches.size,1);
    assert.equal(await f.page.evaluate(()=>window.folder.hasActive()),true);
});
test('planning uses dynamic context; editing survives reads and execute saves the current revision once',async t=>{
    const value=batch(),f=await setup(t,[value]);
    assert.equal(await f.page.evaluate(()=>window.folder.send('背景统一米白',window.ctx)),true);
    const plan=f.requests.find(req=>req.path.endsWith('/plan'));
    assert.equal(plan.body.provider,'chat-provider');assert.equal(plan.body.model,'live-chat-model');assert.equal(plan.body.skill_id,'my-skill');assert.equal(plan.body.generation.model,'live-image-model');
    assert.equal(f.requests.some(req=>req.path.endsWith('/execute')),false);
    ready(value);await f.refresh();await f.page.waitForSelector('[data-item-editor]:visible');
    assert.match(await f.page.locator('[data-item-duplicate]').nth(1).textContent(),/第 1 张/);
    const editor=f.page.locator('[data-item-editor]').first();
    await editor.fill('保留瓶身上的文字与标志');
    await editor.evaluate(element=>{window.editNode=element;element.focus();element.setSelectionRange(3,6);});
    await f.page.evaluate(()=>document.querySelector('[data-cfb-action="refresh"]').click());
    await f.wait();
    assert.deepEqual(await editor.evaluate(element=>({same:element===window.editNode,focused:document.activeElement===element,start:element.selectionStart,end:element.selectionEnd,value:element.value})),{same:true,focused:true,start:3,end:6,value:'保留瓶身上的文字与标志'});
    await f.page.locator('[data-item-selected]').nth(1).uncheck();
    assert.match(await f.page.locator('[data-cfb-action="execute"]').textContent(),/1 张/);
    await f.page.evaluate(()=>{const button=document.querySelector('[data-cfb-action="execute"]');button.click();button.click();});
    await f.page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='批量改图中');
    const save=f.requests.find(req=>req.method==='PATCH'),execute=f.requests.filter(req=>req.path.endsWith('/execute'));
    assert.equal(save.body.items.find(item=>item.id==='image-1').prompt,'保留瓶身上的文字与标志');assert.equal(save.body.items.find(item=>item.id==='image-2').selected,false);
    assert.equal(execute.length,1);assert.equal(execute[0].body.revision,save.body.revision+1);
    assert.equal(await f.page.locator('.cfb-output-details').evaluate(element=>element.open),false);
    assert.equal(await f.page.locator('[data-cfb-output]').textContent(),'输出文件夹：D:\\生成素材\\folder-batches\\batch-a');
});
test('plan failure and analysis-only plans never enable execution',async t=>{
    const value=batch();value.status='plan_failed';value.error='上游识别失败';const f=await setup(t,[value]);
    assert.equal(await f.page.locator('[data-cfb-action="execute"]').isVisible(),false);
    await f.click('plan');await f.page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='正在识别与规划');
    value.status='ready';value.items.slice(0,2).forEach(item=>item.description='仅分析');value.revision++;
    await f.refresh();await f.page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='待确认计划');
    assert.equal(await f.page.locator('[data-cfb-action="execute"]').isDisabled(),true);
    assert.equal(f.requests.some(req=>req.path.endsWith('/execute')),false);
});
test('paused planning restarts planning; confirmed pause offers resume and no replan',async t=>{
    const value=batch();value.status='paused';const f=await setup(t,[value]);
    assert.equal(await f.page.locator('[data-cfb-action="plan"]').isVisible(),true);
    assert.equal(await f.page.locator('[data-cfb-action="resume"]').isVisible(),false);
    await f.page.evaluate(()=>window.folder.send('改成浅灰背景',window.ctx));
    await f.click('pause');await f.wait();
    assert.equal(await f.page.locator('[data-cfb-action="resume"]').isVisible(),false);
    value.status='paused';value.output_directory='D:\\输出';value.items[0].status='queued';value.revision++;
    await f.refresh();await f.page.waitForSelector('[data-cfb-action="resume"]:visible');
    assert.equal(await f.page.locator('[data-cfb-action="plan"]').isVisible(),false);
    await f.click('resume');await f.page.waitForSelector('[data-cfb-action="pause"]:visible');
    assert.equal(f.requests.filter(req=>req.path.endsWith('/resume')).length,1);
});
test('retry waits for completion, retains the previous result, and cannot fall through into a new plan',async t=>{
    const value=ready(batch());value.status='completed';value.output_directory='D:\\输出';
    Object.assign(value.items[0],{status:'succeeded',attempt:1,task_id:'task-one',result_url:'/result-1.png',versions:[{attempt:1,url:'/result-1.png',prompt:'旧提示词',task_id:'task-one'}]});
    const f=await setup(t,[value]),feedback=f.page.locator('[data-item-feedback]').first();
    await feedback.fill('背景再浅一点');
    await f.page.evaluate(()=>{const button=document.querySelector('[data-cfb-action="retry"]');button.click();button.click();});
    await f.page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='批量改图中');
    assert.equal(f.requests.filter(req=>req.path.endsWith('/retry')).length,1);
    assert.equal(f.requests.find(req=>req.path.endsWith('/retry')).body.feedback,'背景再浅一点');
    assert.equal(await f.page.locator('[data-item-result] span').first().textContent(),'上一版结果');
    assert.equal(await feedback.inputValue(),'背景再浅一点');
    assert.equal(await f.page.evaluate(()=>window.folder.send('再来一张',window.ctx)),false);
    assert.equal(f.requests.some(req=>req.path.endsWith('/plan')),false);
    assert.match(await f.page.locator('[data-item-download]').first().getAttribute('href'),/\/items\/image-1\/download$/);
    assert.match(await f.page.locator('[data-cfb-zip]').getAttribute('href'),/\/batch-a\/download$/);
});
test('conversation switches and exit preserve drafts without borrowing another task',async t=>{
    const a=ready(batch()),b=ready(batch('batch-b','chat-b')),f=await setup(t,[a,b]);
    await f.page.locator('[data-item-editor]').first().fill('对话 A 的草稿');
    await f.switch('chat-b');assert.match(await f.page.locator('[data-cfb-name]').textContent(),/batch-b/);
    assert.equal(await f.page.locator('[data-item-editor]').first().inputValue(),'保留产品，浅色背景');
    await f.switch('chat-a');assert.equal(await f.page.locator('[data-item-editor]').first().inputValue(),'对话 A 的草稿');
    await f.click('exit');assert.equal(await f.page.evaluate(()=>window.folder.hasActive()),false);
    await f.switch('chat-b');await f.switch('chat-a');assert.equal(await f.page.evaluate(()=>window.folder.hasActive()),false);
    await f.openHistory();await f.selectTask('batch-a');
    assert.equal(await f.page.locator('[data-item-editor]').first().inputValue(),'对话 A 的草稿');
    await f.switch('chat-new');assert.equal(await f.page.evaluate(()=>window.folder.hasActive()),false);
    assert.equal(f.requests.filter(req=>req.method==='POST').length,0);
});
test('revision conflict preserves the draft and never implicitly retries execute',async t=>{
    const value=ready(batch()),f=await setup(t,[value]);
    await f.page.locator('[data-item-editor]').first().fill('本地修改');value.revision++;
    await f.click('execute');await f.page.waitForFunction(()=>document.querySelector('.cfb-notice').textContent.includes('计划已经更新'));
    assert.equal(await f.page.locator('[data-item-editor]').first().inputValue(),'本地修改');
    assert.equal(f.requests.some(req=>req.path.endsWith('/execute')),false);
    await f.click('save');await f.wait();
    assert.equal(f.requests.filter(req=>req.method==='PATCH').length,2);
    await f.click('execute');await f.page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='批量改图中');
    assert.equal(f.requests.filter(req=>req.path.endsWith('/execute')).length,1);
});
test('a late plan response stays with its original conversation',async t=>{
    const a=batch(),b=batch('batch-b','chat-b'),f=await setup(t,[a,b]);let release;
    f.handler=async req=>{if(req.path.endsWith('/plan')){await new Promise(resolve=>release=resolve);return {body:{...clone(a),status:'analyzing',revision:1}};}};
    await f.page.evaluate(()=>{window.pendingSend=window.folder.send('A 的要求',window.ctx);});
    await f.page.waitForFunction(()=>document.querySelector('.cfb-notice').textContent.includes('正在提交'));
    await f.switch('chat-b');release();await f.page.evaluate(()=>window.pendingSend);
    assert.match(await f.page.locator('[data-cfb-name]').textContent(),/batch-b/);
    assert.equal(await f.page.locator('[data-cfb-status]').textContent(),'待生成计划');
});
test('shared canvases expose no folder operations and issue no folder requests',async t=>{
    const f=await setup(t,[],true);
    assert.equal(await f.page.locator('#folder').isVisible(),false);
    assert.equal(await f.page.evaluate(()=>window.folder.hasActive()),false);
    assert.equal(await f.page.evaluate(()=>window.folder.send('改图',window.ctx)),false);
    assert.equal(f.requests.length,0);
});
test('Agent bridge resolves explicit ratios with the existing parser and dimension functions',()=>{
    const parser=agent.slice(agent.indexOf('    function generationRatioGcd('),agent.indexOf('    function requestedPlanNodeSettings('));
    const bridge=agent.slice(agent.indexOf('    function folderBatchContext('),agent.indexOf('    function refreshFolderBatch('));
    const mapper=agent.slice(agent.indexOf('    function ratioForCanvasTarget('),agent.indexOf('    function applyGenerationPreferencesToCurrentNode('));
    const ctx=vm.createContext({effectiveGenerationPreferences:()=>({ratio:'square',resolution:'2k',imageProvider:'dynamic-provider',imageModel:'dynamic-image',quality:'high',background:'transparent'}),generationModelEntries:()=>[],generationHasReferenceImage:()=>false,canvas:{id:'画布'},activeConversation:()=>({id:'对话'}),providerEl:{value:'chat-p'},modelEl:{value:'chat-m'},skillEl:{value:'chosen-skill'},canonicalSkillId:id=>id,noGenerationRequested:()=>false,sizeForRun:settings=>`${settings.resolution}:${settings.ratio}:${settings.customRatio||''}`,aspectRatioForRun:settings=>settings.customRatio||settings.ratio});
    vm.runInContext(parser+mapper+bridge,ctx);
    const result=vm.runInContext('folderBatchContext("输出比例4:5，保留包装文字")',ctx);
    assert.equal(result.generation.aspect_ratio,'4:5');assert.equal(result.generation.size,'2k:custom:4:5');assert.equal(result.generation.model,'dynamic-image');assert.equal(result.skillId,'chosen-skill');
});
test('bound folder send precedes edited messages and node scope, with no ordinary action fallback',async()=>{
    const start=agent.indexOf('    async function send(){');
    const end=agent.indexOf('    function renderHistory(',start);
    assert.ok(start>=0&&end>start,'Agent send function boundaries exist');
    const sendSource=agent.slice(start,end);
    const calls=[];
    const ctx=vm.createContext({sharedCanvasMode:false,folderBatch:{hasActive:()=>true,send:async(text,context)=>{calls.push({text,context});return true;}},input:{value:'改成浅色背景'},busy:false,folderBatchContext:()=>({canvasId:'canvas-a',conversationId:'chat-a'}),store:{activeId:'chat-a'},canvas:{id:'canvas-a'},resizeComposerInput:()=>{},editingUserMessageIndex:7,sendEditedUserMessage:()=>{throw Error('ordinary edit called');},currentTaskScope:()=>{throw Error('node scope called');}});
    vm.runInContext(sendSource,ctx);await vm.runInContext('send()',ctx);
    assert.equal(calls.length,1);assert.equal(ctx.input.value,'');
});

test('full canvas page opens folder plans with working composer and bounded layout',async t=>{
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    t.after(()=>context.close());
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    if(page.routeWebSocket)await page.routeWebSocket('**/*',ws=>ws.close());
    const value=ready(batch('full-page'));
    value.canvas_id='qa-canvas';
    value.generation={provider_id:'fixture',model:'fixture-image',size:'1024x1280',aspect_ratio:'4:5',quality:'auto',background:'opaque'};
    await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
        if(pathname.startsWith('/static/')){
            const file=path.resolve(root,'.'+decodeURIComponent(pathname));
            assert.ok(file.startsWith(root+path.sep));
            try{return route.fulfill({path:file});}catch(_){return route.fulfill({status:404,body:''});}
        }
        requests.push({path:pathname,method:request.method(),body:request.postDataJSON()});
        if(pathname==='/api/config')return route.fulfill({json:{api_providers:[{id:'fixture',name:'测试平台',protocol:'openai',enabled:true,image_models:['fixture-image'],chat_models:['fixture-chat'],video_models:[]}],chat_models:['fixture-chat'],image_models:['fixture-image'],comfy_instances:[]}});
        if(pathname==='/api/canvases/qa-canvas')return route.fulfill({json:{canvas:{id:'qa-canvas',title:'批量改图界面验收',project:'default',nodes:[],connections:[],logs:[]}}});
        if(pathname==='/api/canvas-folder-batches'){
            value.conversation_id=url.searchParams.get('conversation_id')||value.conversation_id;
            return route.fulfill({json:{batches:[clone(value)]}});
        }
        if(pathname==='/api/canvas-folder-batches/full-page')return route.fulfill({json:clone(value)});
        if(pathname==='/api/canvas-folder-batches/full-page/plan')return route.fulfill({json:{...clone(value),status:'analyzing',revision:value.revision+1}});
        if(pathname.endsWith('.png'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#e8d9c4"/><rect x="220" y="250" width="360" height="500" rx="30" fill="#9c674b"/></svg>'});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[]}});
    });
    await page.goto('http://xiaomei-qa.test/static/smart-canvas.html?id=qa-canvas');
    await page.waitForFunction(()=>document.getElementById('smartTitle').textContent==='批量改图界面验收');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('[data-cfb-action="execute"]').waitFor({state:'visible'});
    assert.equal(await page.locator('#canvasAgentHistoryToggle').getAttribute('title'),'历史对话');
    assert.equal(await page.locator('#canvasAgentHistoryToggle').getAttribute('aria-label'),'历史对话');
    assert.equal(await page.locator('#canvasAgentFolderBatch [data-cfb-action="import"]').count(),0);
    assert.equal(await page.locator('#canvasAgentFolderBatch [data-cfb-action="history"]').count(),0);
    await page.locator('#canvasAgentComposerMenuToggle').click();
    assert.equal(await page.locator('#canvasAgentComposerMenu').isVisible(),true);
    assert.match(await page.locator('#canvasAgentComposerMenu').textContent(),/选择文件夹批量改图/);
    assert.equal(await page.locator('#canvasAgentComposerMenu [data-composer-menu-action="images"]').count(),1);
    await page.locator('#canvasAgentComposerMenuToggle').click();
    await page.locator('#canvasAgentHistoryToggle').click();
    assert.equal(await page.locator('[data-history-tab="conversations"]').textContent(),'历史对话');
    assert.equal(await page.locator('[data-history-tab="batches"]').textContent(),'批量任务');
    await page.locator('[data-history-tab="batches"]').click();
    await page.locator('[data-cfb-history-id]').waitFor({state:'visible'});
    assert.equal(await page.locator('#canvasAgentHistory').getByText('历史任务',{exact:true}).count(),0);
    for(const width of [1440,1000]){
        await page.setViewportSize({width,height:900});
        const geometry=await page.locator('#canvasAgentPanel').evaluate(panel=>{
            const p=panel.getBoundingClientRect(),input=panel.querySelector('#canvasAgentInput').getBoundingClientRect();
            const scroll=panel.querySelector('.cfb-content');
            return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,inputTop:input.top,inputBottom:input.bottom,client:scroll.clientWidth,scroll:scroll.scrollWidth,contentHeight:scroll.clientHeight};
        });
        assert.ok(geometry.left>=0&&geometry.right<=width+1,JSON.stringify(geometry));
        assert.ok(geometry.inputBottom<=900&&geometry.inputTop>0,JSON.stringify(geometry));
        assert.ok(geometry.scroll<=geometry.client+1&&geometry.contentHeight>100,JSON.stringify(geometry));
    }
    if(process.env.XIAOMEI_QA_SCREENSHOT)await page.locator('#canvasAgentPanel').screenshot({path:process.env.XIAOMEI_QA_SCREENSHOT});
    await page.locator('#canvasAgentInput').fill('背景统一浅灰，输出比例4:5');
    await page.locator('#canvasAgentSend').click();
    await page.waitForFunction(()=>document.querySelector('[data-cfb-status]').textContent==='正在识别与规划');
    const plan=requests.find(x=>x.path==='/api/canvas-folder-batches/full-page/plan');
    assert.equal(plan.body.provider,'fixture');assert.equal(plan.body.generation.model,'fixture-image');
    assert.equal(plan.body.generation.aspect_ratio,'4:5');
    assert.equal(requests.some(x=>x.path==='/api/canvas-agent-action'||x.path==='/api/canvas-image-tasks'),false);
    assert.deepEqual(errors,[]);
});
