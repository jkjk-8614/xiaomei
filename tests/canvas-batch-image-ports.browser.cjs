const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

function assertScreenPromptStandards(request){
    assert.equal(request.prompt_purpose,undefined);
    const rules = request.system_prompt;
    assert.match(rules,/你是电商视觉策划师/);
    assert.match(rules,/先讲消费者得到的利益，再讲产品特点，最大好处放进标题/);
    assert.match(rules,/核心到辅助/);
    assert.match(rules,/原料、工艺、设计、功效、价格、服务、工厂、品牌/);
    assert.match(rules,/F\/A是属性功能与优势，B是消费者好处，E是情感吸引力/);
    assert.match(rules,/顾虑 → 回答 → 画面或数据证据/);
    assert.match(rules,/缺失标待确认/);
    assert.match(rules,/主体、构图、材质、光线、背景和氛围/);
    assert.match(rules,/落实参考图的可借鉴点/);
    assert.match(rules,/字体、设计主辅色、逻辑、排版各不超过3种/);
    assert.match(rules,/HEX色值/);
    assert.match(rules,/字体、字级、品牌位置和产品机位/);
    assert.match(rules,/无文字或预留文案区域/);
    assert.doesNotMatch(rules,/750px|至少1条可检查的验收点|商品→核心卖点|固定5张/);
}

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:1100}});
    page.setDefaultTimeout(8000);
    const errors = [], calls = [];
    const submissions = [], tasks = new Map();
    let reply = {visual_guide:'统一自然光', screens:[{title:'主图',prompt:'保持产品外观'}]};
    let replyStatus = 200;
    let beforeReply = null;
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'batch-ports', nodes:[], connections:[], settings:{}, logs:[]};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if(url.hostname !== 'batch-ports.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/fixture-images/')) return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#abc"/></svg>'});
        if(url.pathname === '/api/canvases/batch-ports'){
            if(req.method() === 'PUT') saved = {...saved, ...req.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/canvas-llm'){
            calls.push(req.postDataJSON());
            if(beforeReply) await beforeReply();
            return route.fulfill({status:replyStatus,json:replyStatus === 200 ? {text:JSON.stringify(reply)} : {detail:'fixture unavailable'}});
        }
        if(url.pathname === '/api/canvas-image-tasks' && req.method() === 'POST'){
            const taskId = `screen-task-${submissions.length + 1}`;
            submissions.push({taskId,payload:req.postDataJSON()});
            tasks.set(taskId,'running');
            return route.fulfill({json:{task_id:taskId,status:'queued'}});
        }
        if(url.pathname.startsWith('/api/canvas-image-tasks/')){
            const taskId = url.pathname.split('/').pop(), status = tasks.get(taskId);
            return route.fulfill({json:{id:taskId,status,...(status === 'succeeded' ? {result:{images:[`/fixture-images/${taskId}.svg`]}} : {}),...(status === 'failed' ? {error:'模拟失败'} : {})}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'测试平台',enabled:true,image_models:['fixture-image'],chat_models:['fixture-chat']}],comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://batch-ports.test/static/smart-canvas.html?id=batch-ports');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'batch-ports');
    await page.addStyleTag({content:'#canvasNavPanel {display:none !important}'});
    await page.evaluate(() => {
        nodes = [
            {id:'product',type:'smart-upload',x:30,y:30,images:[{url:'/fixture-images/product.svg',kind:'image'}]},
            {id:'reference',type:'smart-upload',x:30,y:360,images:[{url:'/fixture-images/style.svg',kind:'image'}]},
            {id:'text',type:'smart-prompt',x:-1200,y:20,text:'展示产品的材质细节'}
        ];
        const batch = createLoopNode(550,30,{batchUiMode:'paired'});
        batch.id = 'batch'; batch.batchAiProvider = 'fixture'; batch.batchAiModel = 'fixture-chat'; batch.batchAiTargetCount = 1;
        canvas.connections = []; canvasUsesConnections = true;
        selectedId = ''; selectedIds = []; viewport = {x:20,y:20,scale:.85};
        applyViewport(); render();
    });
    return {page,calls,submissions,setTaskState:(index,status) => tasks.set(submissions[index].taskId,status),saved:() => saved,setReply:(value,status=200) => {reply=value; replyStatus=status;},setBeforeReply:fn => {beforeReply=fn;}};
}

async function dragImage(page, source, role, reverse=false){
    const image = page.locator(`[data-id="${source}"] .port-out`);
    const input = page.locator(`[data-id="batch"] .port-in[data-input-slot="${role}"]`);
    const start = await (reverse ? input : image).boundingBox();
    const end = await (reverse ? image : input).boundingBox();
    await page.mouse.move(start.x + start.width/2, start.y + start.height/2);
    await page.waitForTimeout(180);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width/2, end.y + end.height/2, {steps:16});
    await page.mouse.up();
    await page.waitForFunction(({source,role}) => canvas.connections.some(conn => conn.from === source && conn.to === 'batch' && conn.input_slot === role), {source,role});
}

async function assertAnchors(page){
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => {
        const batch = world.querySelector('[data-id="batch"]');
        const mapper = createClientToWorldMapper();
        return ['product','reference'].every(role => {
            const port = batch.querySelector(`.port-in[data-input-slot="${role}"]`).getBoundingClientRect();
            const label = batch.querySelector(`[data-batch-input-slot="${role}"] .batch-asset-meta > span`).getBoundingClientRect();
            if(Math.abs(port.top + port.height/2 - label.top - label.height/2) > 1) return false;
            const line = world.querySelector(`.conn-group[data-conn-to="batch"][data-conn-input-slot="${role}"] .conn-line`);
            if(!line) return false;
            const endpoint = line.getPointAtLength(line.getTotalLength());
            const expected = mapper(batch.getBoundingClientRect().left, label.top + label.height/2);
            return Math.hypot(endpoint.x - expected.x, endpoint.y - expected.y) < 1;
        });
    }), true, 'ports and connection endpoints follow their material labels');
}

test('batch product and reference ports route real drags, preserve roles in requests and survive reload', {timeout:45000}, async t => {
    const {page,calls,saved} = await fixture(t);
    await dragImage(page,'product','product');
    await dragImage(page,'reference','reference');
    const row = role => page.locator(`[data-id="batch"] [data-batch-input-slot="${role}"]`);
    assert.equal(await row('product').locator('.smart-node-input-thumb').count(),1);
    assert.equal(await row('reference').locator('.smart-node-input-thumb').count(),1);
    await assertAnchors(page);
    await page.evaluate(() => {
        const source = nodes.find(n => n.id === 'product');
        source.images.push(...Array.from({length:12}, (_,i) => ({url:`/fixture-images/product-${i}.svg`,kind:'image'})));
        viewport = {x:50,y:30,scale:.7}; applyViewport(); render();
    });
    assert.equal(await row('product').locator('.smart-node-input-thumb').count(),13);
    await assertAnchors(page);
    assert.deepEqual(await page.evaluate(() => {
        const batch = nodes.find(n => n.id === 'batch');
        return [connectInputNode('text','batch','text'), smartLoopDetailSourceText(batch), smartLoopInputImages(batch,{index:1}).length];
    }),[true,'展示产品的材质细节',14]);
    await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
    assert.equal(calls.length,1);
    assertScreenPromptStandards(calls[0]);
    assert.equal(calls[0].images.length,14);
    assert.match(calls[0].message,/图1：产品图，保持产品外观/);
    assert.match(calls[0].message,/图14：仅参考风格和排版/);
    assert.match(calls[0].system_prompt,/图14是本套图片的主要设计风格基准/);
    assert.match(calls[0].system_prompt,/写入visual_guide，注明对应参考图号/);
    const prompt = await page.evaluate(() => smartBatchScreenPrompt(nodes.find(n => n.id === 'batch'),0));
    assert.match(prompt,/图14：仅参考配色、排版和风格，不替换产品/);
    assert.match(prompt,/图14是本套图片的主要设计风格基准/);
    assert.match(prompt,/产品图自带的背景、道具、海报配色和文字排版不作为设计风格来源/);
    await page.evaluate(() => saveCanvas());
    assert.equal(saved().connections.find(c => c.from === 'reference').input_slot,'reference');
    await page.reload();
    await page.waitForFunction(() => nodes.some(n => n.id === 'batch'));
    await page.addStyleTag({content:'#canvasNavPanel {display:none !important}'});
    assert.equal(await row('reference').locator('.smart-node-input-thumb').count(),1);
    await assertAnchors(page);
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-batch-image-ports.png')});
});

test('screen planning preserves explicit settings, shared guide and existing drafts on failure', {timeout:45000}, async t => {
    const {page,calls,setReply} = await fixture(t);
    await page.evaluate(() => connectInputNode('product','batch','product'));
    for(const [count, mode, copy] of [[10,'详情页','每屏需要文案'],[1,'主图','全部无文字'],[2,'详情页','预留文案区域']]){
        await page.evaluate(({count,mode,copy}) => {
            const batch = nodes.find(n => n.id === 'batch');
            batch.batchAiTargetCount = count;
            batch.batchCommerce = {...smartLoopCommerceFields(batch),mode,copy,language:'英语',platform:'通用',model:'无模特',productName:'相框'};
            batch.batchVisualGuide = '米白背景，保留原框色';
            batch.batchSourceText = '实拍木纹外观，未提供尺寸';
            render();
        },{count,mode,copy});
        const screens = Array.from({length:count},(_,i) => ({title:`屏${i+1}`,prompt:`第${i+1}屏：展示真实相框；验收：结构与产品图一致`}));
        setReply({visual_guide:'#F5F1E8米白底，统一自然光',screens});
        await page.locator('[data-id="batch"] [data-loop-commerce-plan]').click();
        await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
        const request = calls.at(-1);
        assertScreenPromptStandards(request);
        assert.doesNotMatch(request.system_prompt,/主要设计风格基准/,'product-only inputs do not invent a style reference');
        assert.ok(request.message.startsWith(`请生成${count}个${mode}的生图提示词。`));
        assert.ok(request.message.includes(`必须正好${count}项`));
        assert.ok(request.message.includes(`文案：${copy}`));
        assert.match(request.message,/输出语言：英语/);
        assert.match(request.message,/模特：无模特/);
        assert.match(request.message,/目标平台：通用；比例：.+；分辨率：.+。/);
        assert.ok(request.message.includes(mode === '主图' ? '每个方案独立，构图不同' : '各屏职责明确、前后连贯，构图不同'));
        assert.match(request.message,/不要编造产品参数/);
        assert.match(request.message,/先确定统一的配色、字体与光线/);
        assert.match(request.message,/米白背景，保留原框色/);
        assert.match(request.message,/未提供尺寸/);
        const state = await page.evaluate(() => {
            const batch = nodes.find(n => n.id === 'batch');
            return {count:batch.aiSplitPrompts.length,prompt:smartBatchScreenPrompt(batch,0),error:batch.aiSplitError};
        });
        assert.equal(state.count,count);
        assert.equal(state.error,'');
        assert.match(state.prompt,/#F5F1E8/);
        assert.match(state.prompt,/验收：结构与产品图一致/);
    }
    const before = await page.evaluate(() => JSON.stringify(nodes.find(n => n.id === 'batch').aiSplitPrompts));
    for(const [reply,status] of [[{screens:[{prompt:'只有一屏'}]},200],[{},503]]){
        setReply(reply,status);
        await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
        const state = await page.evaluate(() => {
            const batch = nodes.find(n => n.id === 'batch');
            return {prompts:JSON.stringify(batch.aiSplitPrompts),error:batch.aiSplitError,running:batch.aiSplitRunning};
        });
        assert.equal(state.prompts,before);
        assert.ok(state.error);
        assert.equal(state.running,false);
    }
});

test('batch image ports reject text, reconnect without duplicates, and keep legacy roles and manual overrides', {timeout:40000}, async t => {
    const {page,calls} = await fixture(t);
    assert.deepEqual(await page.evaluate(() => {
        const before = JSON.stringify(canvas.connections);
        return [connectInputNode('text','batch','reference'),connectInputNode('text','batch','product'),JSON.stringify(canvas.connections) === before];
    }),[false,false,true]);
    await dragImage(page,'reference','reference',true);
    await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
    assert.equal(calls.length,0,'a style reference cannot satisfy the product requirement');
    await page.evaluate(() => {
        const batch = nodes.find(n => n.id === 'batch');
        const ref = smartLoopPreviewImages(batch)[0];
        batch.batchCommerceRoles = {[inputRefKey(ref)]:'product'};
        render();
    });
    assert.equal(await page.locator('[data-batch-input-slot="product"] .smart-node-input-thumb').count(),1);
    await dragImage(page,'reference','product');
    assert.equal(await page.evaluate(() => canvas.connections.filter(c => c.from === 'reference' && c.to === 'batch').length),1);
    await dragImage(page,'reference','reference');
    assert.equal(await page.locator('[data-batch-input-slot="reference"] .smart-node-input-thumb').count(),1);
    assert.deepEqual(await page.evaluate(() => {
        const batch = nodes.find(n => n.id === 'batch');
        canvas.connections.push({from:'product',to:'batch',kind:'input'});
        render();
        return smartLoopPreviewImages(batch).map(ref => [ref.nodeId,smartBatchRole(batch,ref)]);
    }),[['reference','reference'],['product','product']]);
});

test('prompt button shows preflight errors, pending state and completion beside the button', {timeout:40000}, async t => {
    const {page,calls,setReply,setBeforeReply} = await fixture(t);
    const button = () => page.locator('[data-id="batch"] [data-loop-commerce-plan]');
    const status = () => page.locator('[data-id="batch"] [data-batch-prompt-status]');
    const besideButton = async () => {
        const observation = await page.waitForFunction(() => {
            const el = document.querySelector('[data-id="batch"] [data-batch-prompt-status]');
            const section = el?.closest('.batch-sec'), node = el?.closest('.image-node');
            if(!section || !node) return null;
            const box = el.getBoundingClientRect(), outer = node.getBoundingClientRect();
            return {sameSection:section.contains(node.querySelector('[data-loop-commerce-plan]')),contained:box.top >= outer.top && box.bottom <= outer.bottom};
        });
        const bounds = await observation.jsonValue();
        assert.equal(bounds.sameSection,true);
        assert.equal(bounds.contained,true);
    };
    await button().click();
    assert.equal(calls.length,0);
    assert.match(await status().textContent(),/请先连接产品图/);
    assert.equal(await status().getAttribute('role'),'alert');
    await besideButton();

    await page.evaluate(() => connectInputNode('product','batch','product'));
    let release;
    const gate = new Promise(resolve => {release=resolve;});
    setBeforeReply(() => gate);
    try {
        await page.locator('[data-id="batch"] [data-loop-commerce="productName"]').fill('衣服');
        await button().click();
        await page.waitForFunction(() => nodes.find(n => n.id === 'batch').aiSplitRunning);
        assert.equal(calls.length,1);
        assert.match(await button().textContent(),/正在生成提示词/);
        assert.equal(await button().isDisabled(),true);
        assert.match(await status().textContent(),/正在分析素材/);
        assert.equal(await status().locator('[role="progressbar"]').getAttribute('aria-valuenow'),null,'no fabricated percentage while waiting for the model');
        const initialElapsed = await status().locator('[data-batch-prompt-elapsed]').textContent();
        await page.waitForFunction(initial => document.querySelector('[data-batch-prompt-elapsed]')?.textContent !== initial,initialElapsed);
        await status().screenshot({path:path.join(os.tmpdir(),'xiaomei-batch-prompt-progress.png')});
        await besideButton();
        // A second call during the pending request must not charge twice.
        await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
        assert.equal(calls.length,1);
    } finally {release();}
    await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
    assert.match(await status().textContent(),/已准备 1 屏提示词/);
    assert.equal(await page.evaluate(() => smartBatchPromptProgress.has(nodes.find(n => n.id === 'batch'))),false);
    assert.equal(await button().isDisabled(),false);
    await besideButton();

    setBeforeReply(null);
    setReply({screens:[]});
    await button().click();
    await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
    assert.equal(await status().getAttribute('role'),'alert');
    assert.match(await status().textContent(),/格式不完整|未返回完整/);
    await besideButton();

    await page.evaluate(() => {apiProviders = []; render();});
    const before = calls.length;
    await button().click();
    assert.equal(calls.length,before);
    assert.match(await status().textContent(),/选择可用的平台和模型/);
});

for (const operation of ['undo', 'merge', 'replace']) {
    for (const split of [false, true]) {
        test(`pending ${split ? 'split' : 'generation'} survives ${operation}`, {timeout:30000}, async t => {
            const {page,calls,setBeforeReply,setReply} = await fixture(t);
            await page.evaluate(() => {
                connectInputNode('product','batch','product');
                const batch = nodes.find(n => n.id === 'batch');
                batch.batchSourceNodeId = 'local';
                batch.batchSourceText = '展示产品的材质细节';
                render();
            });
            let release;
            const gate = new Promise(resolve => {release=resolve;});
            setBeforeReply(() => gate);
            if(operation === 'replace') setReply({},503);
            try {
                await page.evaluate(split => { void (split ? runSmartLoopAiSplit('batch') : runSmartBatchPromptGeneration('batch')); },split);
                await page.waitForFunction(() => nodes.find(n => n.id === 'batch').aiSplitRunning);
                await page.evaluate(operation => {
                    const server = JSON.parse(JSON.stringify({...canvas,nodes}));
                    if(operation === 'undo') restoreSmartUndoSnapshot(snapshotForUndo());
                    else if(operation === 'merge') applyMergedServerCanvas(server);
                    else collabReplaceWithServerCanvas(server);
                    render();
                },operation);
                assert.match(await page.locator('[data-batch-prompt-phase]').textContent(), split ? /正在拆分已有文案/ : /正在分析素材/);
                assert.equal(await page.evaluate(() => smartBatchPromptProgress.has(nodes.find(n => n.id === 'batch'))),true);
                assert.equal(await page.evaluate(() => {
                    canvas.nodes = nodes;
                    return canvasForStorage().nodes.find(n => n.id === 'batch').aiSplitRunning;
                }),undefined,'request state must not be saved as a persistent task');
                const elapsed = await page.locator('[data-batch-prompt-elapsed]').textContent();
                await page.waitForFunction(initial => document.querySelector('[data-batch-prompt-elapsed]')?.textContent !== initial,elapsed);
                await page.evaluate(split => { void (split ? runSmartLoopAiSplit('batch') : runSmartBatchPromptGeneration('batch')); },split);
                assert.equal(calls.length,1);
            } finally {release();}
            await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
            const result = await page.evaluate(() => {
                const batch = nodes.find(n => n.id === 'batch');
                return {error:batch.aiSplitError,prompts:batch.aiSplitPrompts,tracked:smartBatchPromptProgress.has(batch)};
            });
            assert.equal(result.tracked,false);
            if(operation === 'replace') assert.match(result.error,/fixture unavailable/);
            else { assert.equal(result.error,''); assert.equal(result.prompts.length,1); }
        });
    }
}

test('restoring a snapshot without a live prompt request leaves the button usable', {timeout:30000}, async t => {
    const {page} = await fixture(t);
    await page.evaluate(() => {
        const snap = snapshotForUndo();
        snap.nodes.find(n => n.id === 'batch').aiSplitRunning = true;
        restoreSmartUndoSnapshot(snap);
    });
    assert.equal(await page.locator('[data-id="batch"] [data-loop-commerce-plan]').isDisabled(),false);
    assert.equal(await page.locator('[data-batch-prompt-progress]').count(),0);
});

test('product and reference add tiles share the same label, icon and dimensions', {timeout:30000}, async t => {
    const {page} = await fixture(t);
    const check = async () => {
        const tiles = await page.locator('[data-id="batch"] [data-batch-add-image]').evaluateAll(elements => elements.map(el => ({
            role:el.dataset.batchAddImage,label:el.textContent.trim(),width:el.offsetWidth,height:el.offsetHeight,icon:el.querySelector('svg')?.outerHTML,help:el.querySelector('em')?.textContent
        })));
        assert.equal(tiles.length,2);
        assert.equal(tiles[0].label,'添加');
        assert.equal(tiles[1].label,'添加');
        assert.equal(tiles[0].width,tiles[1].width);
        assert.equal(tiles[0].height,tiles[1].height);
        assert.equal(tiles[0].icon,tiles[1].icon);
        assert.equal(tiles[1].help,undefined);
    };
    await check();
    await page.evaluate(() => {connectInputNode('product','batch','product'); connectInputNode('reference','batch','reference');});
    await check();
    await page.locator('[data-id="batch"] .batch-sec').first().screenshot({path:path.join(os.tmpdir(),'xiaomei-batch-add-tiles.png')});
});

test('different screens can retry concurrently, with independent completion and duplicate protection', {timeout:45000}, async t => {
    const {page,submissions,setTaskState} = await fixture(t);
    await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        loop.x=0; loop.y=0; loop.batchAiTargetCount=3;
        loop.aiSplitPrompts = Array.from({length:3},(_,i) => ({title:`画面${i+1}`,prompt:`第${i+1}屏展示产品`}));
        loop.batchImageSettings = {engine:'api',provider_id:'fixture',model:'fixture-image',ratio:'9:16',resolution:'1k',count:1};
        setSmartLoopPromptFieldValues(loop,loop.aiSplitPrompts.map(s=>s.prompt));
        connectInputNode('product','batch','product');
        ensureSmartLoopDetailPaintNodes(loop,3).forEach(paint => {paint.runError='模拟上次生成失败';});
        viewport={x:30,y:20,scale:.8}; applyViewport(); render();
    });
    const button = i => page.locator(`[data-id="batch"] [data-batch-screen-run="${i}"]`);
    await button(0).click();
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n=>n.id==='batch'))[0].pendingTasks?.length);
    assert.equal(await button(0).isDisabled(),true);
    assert.equal(await button(1).isEnabled(),true);
    assert.equal(await button(2).isEnabled(),true);
    await page.evaluate(() => runSmartBatchScreen(nodes.find(n=>n.id==='batch'),0));
    assert.equal(submissions.length,1,'the same pending screen cannot submit twice');
    await button(1).click();
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n=>n.id==='batch'))[1].pendingTasks?.length);
    assert.equal(submissions.length,2);
    assert.equal(await button(0).isDisabled(),true);
    assert.equal(await button(1).isDisabled(),true);
    assert.equal(await button(2).isEnabled(),true);
    assert.notEqual(submissions[0].payload.prompt,submissions[1].payload.prompt);
    assert.equal(submissions[0].payload.canvas_batch_concurrency,3);
    assert.equal(submissions[1].payload.canvas_batch_concurrency,3);

    setTaskState(0,'succeeded');
    await page.waitForFunction(() => smartCascadeRunForLoop('batch')?.screenRuns?.size === 1);
    assert.equal(await page.evaluate(() => smartCascadeIsLoopRunning('batch')),true,'one completion cannot clear another screen run');
    assert.equal(await button(0).isEnabled(),true);
    assert.equal(await button(1).isDisabled(),true);
    await button(2).click();
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n=>n.id==='batch'))[2].pendingTasks?.length);
    assert.equal(submissions.length,3);
    setTaskState(1,'failed');
    await page.waitForFunction(() => smartCascadeRunForLoop('batch')?.screenRuns?.size === 1);
    assert.equal(await button(1).isEnabled(),true);
    assert.match(await button(1).textContent(),/重试/);
    assert.equal(await button(2).isDisabled(),true);
    setTaskState(2,'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch'));
    for(let i=0;i<3;i++) assert.equal(await button(i).isEnabled(),true);
    assert.equal(await page.evaluate(() => smartCascadeRuns.size),0);
});

test('whole-batch parallel and sequential scheduling retain their stop behavior', {timeout:45000}, async t => {
    const {page,submissions,setTaskState,setReply} = await fixture(t);
    await page.evaluate(() => {
        const loop = nodes.find(n=>n.id==='batch');
        loop.x=0; loop.y=0; loop.batchAiTargetCount=3;
        loop.batchImageSettings={engine:'api',provider_id:'fixture',model:'fixture-image',ratio:'9:16',resolution:'1k',count:1};
        connectInputNode('product','batch','product');
        viewport={x:30,y:20,scale:.8}; applyViewport(); render();
    });
    setReply({screens:Array.from({length:3},(_,i)=>({title:`画面${i+1}`,prompt:`第${i+1}屏产品展示`}))});
    await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
    await page.evaluate(() => {nodes.find(n=>n.id==='batch').mode='parallel';render();});
    const run = () => page.locator('[data-id="batch"] [data-loop-run]');
    await run().click();
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n=>n.id==='batch')).every(p=>p.pendingTasks?.length));
    assert.equal(submissions.length,3);
    assert.equal(await page.locator('[data-id="batch"] [data-batch-screen-run]:enabled').count(),0,'the batch scheduler owns its queued rounds');
    for(let i=0;i<3;i++) setTaskState(i,'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch'));
    await page.evaluate(() => {nodes.find(n=>n.id==='batch').mode='serial';render();});
    await run().click();
    await page.waitForFunction(() => nodes.some(n=>n.pendingTasks?.some(task=>task.taskId==='screen-task-4')));
    assert.equal(submissions.length,4,'sequential mode submits one screen at a time');
    setTaskState(3,'succeeded');
    await page.waitForFunction(() => nodes.some(n=>n.pendingTasks?.some(task=>task.taskId==='screen-task-5')));
    assert.equal(submissions.length,5);
    await run().click();
    setTaskState(4,'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch'));
    assert.equal(submissions.length,5,'stop does not submit the next sequential screen');
    assert.equal(await page.locator('[data-id="batch"] [data-batch-screen-run]:enabled').count(),3);
});

test('style-reference priorities and image numbers reach planning and real image requests in source order', {timeout:30000}, async t => {
    const {page,calls,submissions,setTaskState} = await fixture(t);
    await page.evaluate(() => {
        const loop = nodes.find(n=>n.id==='batch');
        loop.x=0; loop.y=0;
        loop.batchImageSettings={engine:'api',provider_id:'fixture',model:'fixture-image',ratio:'9:16',resolution:'1k',count:1};
        connectInputNode('reference','batch','reference');
        connectInputNode('product','batch','product');
        viewport={x:30,y:20,scale:.8}; applyViewport(); render();
    });
    await page.evaluate(() => runSmartBatchPromptGeneration('batch'));
    assert.deepEqual(calls[0].images,['/fixture-images/style.svg','/fixture-images/product.svg']);
    assert.match(calls[0].system_prompt,/图1是本套图片的主要设计风格基准/);
    assert.match(calls[0].system_prompt,/图2是产品图，只锁定商品自身/);
    assert.match(calls[0].system_prompt,/主辅色HEX及面积比例、版式骨架、标题字形与层级/);
    assert.match(calls[0].system_prompt,/每屏prompt说明借用了哪张参考的哪个局部或模块/);
    await page.evaluate(() => {
        const loop = nodes.find(n=>n.id==='batch');
        loop.batchVisualGuide='保留用户明确指定的无衬线字体';
        loop.batchCommerce={...smartLoopCommerceFields(loop),copy:'全部无文字'};
        ensureSmartLoopDetailPaintNodes(loop,1); render();
    });
    await page.locator('[data-id="batch"] [data-batch-screen-run="0"]').click();
    await page.waitForFunction(() => smartLoopDetailPaintNodes(nodes.find(n=>n.id==='batch'))[0].pendingTasks?.length);
    assert.equal(submissions.length,1);
    const payload=submissions[0].payload;
    assert.deepEqual(payload.reference_images.map(r=>r.url),['/fixture-images/style.svg','/fixture-images/product.svg']);
    assert.match(payload.prompt,/图1是本套图片的主要设计风格基准/);
    assert.match(payload.prompt,/图2是产品图，只锁定商品自身/);
    assert.match(payload.prompt,/用户明确的视觉要求、表单设置和产品真实性/);
    assert.match(payload.prompt,/全部无文字/);
    assert.match(payload.prompt,/保留用户明确指定的无衬线字体/);
    assert.match(payload.prompt,/多屏长图或拼贴时借用其中与当前屏职责对应的局部版式/);
    assert.equal((payload.prompt.match(/参考图设计执行要求：/g)||[]).length,1);
    setTaskState(0,'succeeded');
    await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch'));
});
