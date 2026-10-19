const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const providers=[{id:'fixture',name:'测试平台',enabled:true,protocol:'openai',chat_models:['chat'],image_models:['image'],video_models:[]}];

test('smart allocation uses existing canvas nodes, real task polling, approval and project isolation',{timeout:90000},async t=>{
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],submits=[],receipts=[];let stopped=false,created=false,releaseResults=false,currentStep=0;
    let fixture={id:'multi-fixture',project:'project_a',title:'相框智能分工测试',nodes:[{id:'frame',type:'smart-upload',title:'相框产品图',x:80,y:120,w:280,h:280,images:[{url:'/assets/frame.png',name:'相框.png'}]}],connections:[],logs:[],settings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'image',ratio:'square',resolution:'1k',count:1},updated_at:1};
    const actions=[],outputs=[],tasks=[{task_id:'main',parent_task_id:null,depth:0,agent_role:'main',goal:'制作三张场景主图并检查',status:'running',messages:[],result_refs:[],provider_id:'fixture',model:'chat'},
        {task_id:'analysis',parent_task_id:'main',depth:1,agent_role:'产品分析',goal:'分析相框结构',status:'completed',summary:'木色矩形框与支架，尺寸未知',messages:[{role:'assistant',content:'独立分析测试结果'}],result_refs:[],provider_id:'fixture',model:'chat'},
        {task_id:'scene',parent_task_id:'main',depth:1,agent_role:'场景设计',goal:'三种商品场景',status:'completed',summary:'客厅、书房、床头',messages:[],result_refs:[],provider_id:'fixture',model:'chat'}];
    function actionForStep(){
        if(currentStep>=9)return;
        const imageIndex=Math.floor(currentStep/3),kind=currentStep%3;
        if(actions[currentStep])return actions[currentStep];
        const op=kind===0?{tool:'canvas.create_node',target:'current',args:{type:'smart-paint',title:`场景主图${imageIndex+1}`,prompt:'保持参考图中相框的边框、内框和支架结构，制作电商场景主图',settings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'image',ratio:'square',resolution:'1k',count:1}}}
            :kind===1?{tool:'canvas.connect',target:'current',args:{from:'frame',to:outputs[imageIndex],kind:'input'}}
                :{tool:'canvas.run_node',target:{node_id:outputs[imageIndex],image_index:0},args:{}};
        const action={action_id:`action-${currentStep}`,run_id:'run-fixture',task_id:`image-${imageIndex}`,project_id:'project_a',canvas_id:'multi-fixture',operation:op,status:kind===2?'awaiting_approval':'registered',approved:kind!==2,paid:kind===2,stage:'registered',generation_task_ids:[]};
        actions.push(action);return action;
    }
    function snapshot(){
        actionForStep();
        for(const action of actions){
            if(action.operation.tool==='canvas.run_node'&&action.receipt&&releaseResults){
                const node=fixture.nodes.find(n=>n.id===action.operation.target.node_id);
                if(node?.images?.some(m=>m.url===`/output/${action.action_id}.png`))action.status='completed';
            }
        }
        const completed=actions.filter(a=>a.operation.tool==='canvas.run_node'&&a.status==='completed');
        const done=completed.length===3;
        tasks[0].status=stopped?'cancelled':done?'completed':'running';
        tasks[0].summary=done?'三张场景主图已返回画布。几何尺寸未提供，需要人工复核。':'';
        tasks[0].result_refs=done?outputs.map(id=>({kind:'node',id})):[];
        return {run_id:'run-fixture',run:{run_id:'run-fixture',project_id:'project_a',canvas_id:'multi-fixture',goal:'分析相框并制作三张场景主图',status:tasks[0].status,recovery_required:false},
            tasks:[...tasks,...outputs.map((id,i)=>({task_id:`image-${i}`,parent_task_id:'scene',depth:2,agent_role:`场景制作${i+1}`,goal:`制作第${i+1}张主图`,status:completed.some(a=>a.operation.target.node_id===id)?'completed':'waiting_result',messages:[],result_refs:[{kind:'node',id}],provider_id:'fixture',model:'chat'}))],actions,events:[],cursor:1};
    }
    page.on('pageerror',error=>errors.push(error.message));
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),p=url.pathname;
        if(url.hostname!=='multi-agent.test')return route.abort();
        if(p.startsWith('/static/')){
            let file=path.resolve(root,'.'+decodeURIComponent(p));if(!fs.existsSync(file))file=path.resolve(root,'ComfyUI/web',p.slice('/static/'.length));
            assert.ok(file.startsWith(root+path.sep));return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(p==='/assets/frame.png'||p.startsWith('/output/')||p==='/api/media-preview')return route.fulfill({contentType:'image/svg+xml',body:fs.readFileSync(path.join(__dirname,'fixtures/multi-agent-frame.svg'))});
        if(p==='/api/config')return route.fulfill({json:{api_providers:providers,comfy_instances:[]}});
        if(p==='/api/providers')return route.fulfill({json:{providers}});
        if(p==='/api/canvases/multi-fixture'){
            if(request.method()==='PUT'){const data=request.postDataJSON();fixture={...fixture,...data,updated_at:++fixture.updated_at};}
            return route.fulfill({json:{canvas:fixture}});
        }
        if(p==='/api/canvas-agent/multi/config')return route.fulfill({json:{enabled:true,limits:{},policy:{}}});
        if(p==='/api/canvas-agent/multi/runs'&&request.method()==='POST'){
            const body=request.postDataJSON();assert.deepEqual(body.source_images,['/assets/frame.png']);assert.equal(body.provider_id,'fixture');
            assert.equal(body.model,'chat');created=true;return route.fulfill({json:snapshot()});
        }
        if(p==='/api/canvas-agent/multi/runs')return route.fulfill({json:{runs:created&&url.searchParams.get('project_id')==='project_a'?[snapshot().run]:[],usage:{}}});
        if(p==='/api/canvas-agent/multi/runs/run-fixture')return route.fulfill({json:snapshot()});
        if(p.endsWith('/interrupt')){stopped=true;return route.fulfill({json:{ok:true}});}
        const action=actions.find(a=>p.includes('/actions/'+a.action_id+'/'));
        if(action){
            const body=request.postDataJSON();
            if(p.endsWith('/approve')){action.approved=body.approved;action.status=body.approved?'registered':'failed';return route.fulfill({json:{ok:true}});}
            if(p.endsWith('/claim')){assert.equal(action.status,'registered');action.status='claimed';return route.fulfill({json:{action:{...action,lease_token:'browser-execution-token'}}});}
            if(p.endsWith('/receipt')){
                receipts.push(body);assert.equal(body.status,'applied',body.error);action.receipt=body;action.status=action.operation.tool==='canvas.run_node'?'waiting_result':'completed';
                if(action.operation.tool==='canvas.create_node'){outputs.push(body.node_ids[0]);assert.ok(fixture.nodes.some(n=>n.id===body.node_ids[0]));}
                currentStep++;return route.fulfill({json:{ok:true}});
            }
        }
        if(p==='/api/canvas-image-tasks'&&request.method()==='POST'){
            const body=request.postDataJSON();submits.push(body);assert.equal(body.n,1);assert.ok(body.multi_agent_action_id);assert.equal(body.multi_agent_execution_token,'browser-execution-token');
            assert.ok(body.reference_images.some(ref=>ref.url==='/assets/frame.png'));
            const action=actions.find(a=>a.action_id===body.multi_agent_action_id);action.generation_task_ids=[body.multi_agent_action_id];action.status='waiting_result';return route.fulfill({json:{task_id:body.multi_agent_action_id,status:'queued'}});
        }
        if(p.startsWith('/api/canvas-image-tasks/')){
            const id=p.split('/').pop();return route.fulfill({json:releaseResults?{id,status:'succeeded',result:{images:[`/output/${id}.png`]}}:{id,status:'running'}});
        }
        if(p.includes('/project-agent/'))return route.fulfill({json:{memories:[],settings:{proactive_enabled:false},global_settings:{enabled:false},suggestions:[]}});
        return route.fulfill({json:{providers,skills:[],categories:[],libraries:[],workflows:[],items:[],batches:[],canvases:[]}});
    });
    await page.goto('http://multi-agent.test/static/smart-canvas.html?id=multi-fixture');
    await page.waitForFunction(()=>canvas?.id==='multi-fixture'&&window.CanvasMultiAgent);
    await page.evaluate(()=>{
        selectedId='frame';selectedIds=[];render();
        const provider=document.getElementById('canvasAgentProvider');provider.value='fixture';provider.dispatchEvent(new Event('change'));
        document.getElementById('canvasAgentModel').value='chat';
    });
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#canvasMultiAgentOpen').click();
    await page.locator('#canvasAgentInput').fill('帮我分析这款相框，制作三张不同场景的电商主图，确保产品结构保持一致，完成后检查生成结果。');
    await page.locator('#canvasAgentSend').click();
    for(let i=0;i<3;i++){
        const approve=page.locator('.multi-agent-approval button').filter({hasText:'确认'});
        await approve.waitFor({state:'visible',timeout:20000});
        assert.equal(submits.length,i,'paid operation must wait for the confirmation button');
        await approve.click();
        await page.waitForFunction(n=>nodes.filter(node=>node.pendingTasks?.length).length>=n,i+1);
    }
    assert.equal(submits.length,3,'independent image jobs are submitted before any results return');
    assert.equal(new Set(submits.map(s=>s.client_request_id)).size,3);
    for(let i=0;i<100&&receipts.length<9;i++)await page.waitForTimeout(25);
    assert.equal(receipts.length,9);
    // A closed browser may have saved action ownership but lost its task-ID response.
    await page.goto('about:blank');
    for(const node of fixture.nodes)delete node.pendingTasks;
    await page.goto('http://multi-agent.test/static/smart-canvas.html?id=multi-fixture');
    await page.waitForFunction(()=>nodes.filter(node=>node.pendingTasks?.length).length===3);
    assert.equal(submits.length,3,'recovery must only query the original task IDs');
    if(!await page.locator('#canvasMultiAgentOpen').isVisible())await page.locator('#canvasAgentToggle').click();
    if(await page.locator('#canvasMultiAgentDrawer').isHidden())await page.locator('#canvasMultiAgentOpen').click();
    releaseResults=true;
    await page.waitForFunction(()=>nodes.filter(node=>node.type==='smart-paint'&&node.images?.length).length===3);
    await page.waitForFunction(()=>document.querySelector('.multi-agent-summary')?.textContent.includes('已完成'));
    assert.equal(receipts.length,9);
    assert.equal(fixture.connections.filter(c=>c.from==='frame').length,3);
    const qaDir=process.env.XIAOMEI_MULTI_AGENT_QA_DIR;
    if(qaDir){fs.mkdirSync(qaDir,{recursive:true});await page.screenshot({path:path.join(qaDir,'multi-agent-light.png')});}
    await page.evaluate(()=>StudioAppearance.set({skin:'dark'}));
    if(qaDir)await page.screenshot({path:path.join(qaDir,'multi-agent-dark.png')});
    await page.setViewportSize({width:390,height:844});
    const bounds=await page.locator('#canvasMultiAgentDrawer').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391,JSON.stringify(bounds));
    if(qaDir)await page.screenshot({path:path.join(qaDir,'multi-agent-narrow.png')});
    await page.evaluate(()=>{canvas.project='project_b';canvas.id='other-canvas';});
    await page.waitForFunction(()=>!document.querySelector('.multi-agent-task'));
    assert.equal(await page.locator('.multi-agent-body').getByText('木色矩形框与支架，尺寸未知').count(),0);
    assert.deepEqual(errors,[]);
});

test('Comfy recovery queries its original job and a delayed image submission cannot write into another canvas',{timeout:60000},async t=>{
    const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage();
    const errors=[],submits=[],queries=[];let releaseComfy=false,releaseImage;
    const imageGate=new Promise(resolve=>releaseImage=resolve);
    let fixture={id:'recovery-fixture',project:'project_a',title:'恢复检查',updated_at:1,connections:[],logs:[],
        settings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'image',ratio:'square',resolution:'1k',count:1},nodes:[
            {id:'local-output',type:'smart-paint',title:'已有工作流结果',x:50,y:80,w:280,h:280,images:[],pending:1,
                _agent_action_ids:['local-action'],_agent_output_action_id:'local-action',runSettings:{engine:'comfy'}},
            {id:'api-output',type:'smart-paint',title:'延迟提交',promptDraftText:'相框商品场景',runPrompt:'相框商品场景',x:380,y:80,w:280,h:280,images:[],
                runSettings:{engine:'api',apiKind:'image',provider_id:'fixture',model:'image',ratio:'square',resolution:'1k',count:1}}
        ]};
    page.on('pageerror',error=>errors.push(error.message));
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),p=url.pathname;
        if(url.hostname!=='agent-recovery.test')return route.abort();
        if(p.startsWith('/static/')){
            let file=path.resolve(root,'.'+decodeURIComponent(p));if(!fs.existsSync(file))file=path.resolve(root,'ComfyUI/web',p.slice('/static/'.length));
            assert.ok(file.startsWith(root+path.sep));return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(p.startsWith('/output/')||p==='/api/media-preview')return route.fulfill({contentType:'image/svg+xml',body:fs.readFileSync(path.join(__dirname,'fixtures/multi-agent-frame.svg'))});
        if(p==='/api/config')return route.fulfill({json:{api_providers:providers,comfy_instances:[]}});
        if(p==='/api/providers')return route.fulfill({json:{providers}});
        if(p==='/api/canvases/recovery-fixture'){
            if(request.method()==='PUT')fixture={...fixture,...request.postDataJSON(),updated_at:++fixture.updated_at};
            return route.fulfill({json:{canvas:fixture}});
        }
        if(p==='/api/canvas-comfy-tasks/canvas_comfy_existing'){
            queries.push(p);return route.fulfill({json:releaseComfy?{status:'succeeded',result:{images:['/output/local-result.png']}}:{status:'running'}});
        }
        if((p==='/api/canvas-image-tasks'||p==='/api/canvas-comfy-tasks')&&request.method()==='POST'){
            submits.push(request.postDataJSON());await imageGate;
            return route.fulfill({json:{task_id:'submitted-before-switch',status:'queued'}});
        }
        if(p.includes('/project-agent/'))return route.fulfill({json:{memories:[],settings:{proactive_enabled:false},global_settings:{enabled:false},suggestions:[]}});
        return route.fulfill({json:{providers,runs:[],skills:[],categories:[],libraries:[],workflows:[],items:[],batches:[],canvases:[]}});
    });
    await page.goto('http://agent-recovery.test/static/smart-canvas.html?id=recovery-fixture');
    await page.waitForFunction(()=>canvas?.id==='recovery-fixture'&&window.CanvasMultiAgentBridge);
    const action={action_id:'local-action',canvas_id:'recovery-fixture',project_id:'project_a',operation:{tool:'canvas.run_node',target:'local-output',args:{}},
        status:'waiting_result',local_gpu:true,generation_kind:'comfy',generation_task_ids:['canvas_comfy_existing']};
    await page.evaluate(async action=>{await CanvasMultiAgentBridge.restore(action);await CanvasMultiAgentBridge.restore(action);},action);
    await page.waitForFunction(()=>nodes.find(n=>n.id==='local-output').pendingTasks?.[0]?.executor==='comfy');
    releaseComfy=true;
    await page.waitForFunction(()=>nodes.find(n=>n.id==='local-output').images?.[0]?.url==='/output/local-result.png');
    assert.ok(queries.length>0);
    assert.equal(submits.length,0,'restoring a Comfy job must not submit another workflow');
    const started=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/canvas-image-tasks'&&request.method()==='POST');
    await page.evaluate(()=>{
        window.lateAgentExecution=CanvasMultiAgentBridge.execute({action_id:'late-action',canvas_id:'recovery-fixture',project_id:'project_a',lease_token:'test-lease',
            operation:{tool:'canvas.run_node',target:'api-output',args:{}}}).then(()=>{window.lateAgentOutcome='unexpected success';},error=>{window.lateAgentOutcome=error.message;});
    });
    await Promise.race([started,page.waitForFunction(()=>window.lateAgentOutcome).then(async()=>{
        throw new Error('Submission ended early: '+await page.evaluate(()=>window.lateAgentOutcome));
    })]);
    await page.evaluate(()=>{
        canvas={id:'other-canvas',project:'project_b',title:'其他项目',nodes:[],connections:[],settings:{}};
        nodes=[{id:'private-node',type:'smart-upload',images:[],x:0,y:0,w:280,h:280}];connections=[];
        settings={scopeMarker:'project-b'};
        render();
    });
    releaseImage();
    await page.waitForFunction(()=>window.lateAgentOutcome);
    assert.match(await page.evaluate(()=>window.lateAgentOutcome),/画布已切换/);
    const other=await page.evaluate(()=>nodes.map(n=>({id:n.id,images:n.images,pending:n.pending||0,tasks:n.pendingTasks||[]})));
    assert.deepEqual(other,[{id:'private-node',images:[],pending:0,tasks:[]}]);
    assert.equal(await page.evaluate(()=>settings.scopeMarker),'project-b');
    assert.equal(submits.length,1);
    assert.equal(submits[0].multi_agent_action_id,'late-action');
    assert.deepEqual(errors,[]);
});
