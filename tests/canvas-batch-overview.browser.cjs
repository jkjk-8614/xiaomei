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
    const overview = batch.locator('.loop-batch-overview');
    const link = batch.locator('.batch-overview-link path');
    await page.waitForFunction(() => document.querySelector('.batch-overview-link path')?.getAttribute('d'));
    const startCurve = await link.getAttribute('d');
    const oldBox = await overview.boundingBox();
    const head = await overview.locator('.batch-ov-title').boundingBox();
    await page.mouse.move(head.x + 30, head.y + 5);
    await page.mouse.down();
    await page.mouse.move(head.x + 65, head.y + 35, {steps:5});
    await page.mouse.up();
    const movedBox = await overview.boundingBox();
    assert.ok(Math.abs(movedBox.x - oldBox.x - 35) < 2);
    assert.ok(Math.abs(movedBox.y - oldBox.y - 30) < 2);
    assert.notEqual(await link.getAttribute('d'), startCurve, 'overview connector follows header drag');
    const checkConnector = async () => {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const distances = await page.evaluate(() => {
        const card = document.querySelector('[data-id="batch"]');
        const path = card.querySelector('.batch-overview-link path');
        const port = card.querySelector('.port-out').getBoundingClientRect();
        const panel = card.querySelector('.loop-batch-overview').getBoundingClientRect();
        const matrix = path.getScreenCTM();
        const start = path.getPointAtLength(0).matrixTransform(matrix);
        const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
        return {start:Math.hypot(start.x - port.left - port.width / 2,start.y - port.top - port.height / 2),end:Math.hypot(end.x - panel.left,end.y - panel.top - panel.height / 2)};
        });
        assert.ok(distances.start < 2 && distances.end < 2, JSON.stringify(distances));
    };
    await checkConnector();
    const resizeOverview = async (width, height) => {
        const box = await overview.boundingBox();
        const handle = await overview.locator('[data-batch-overview-resize]').boundingBox();
        const scale = await page.evaluate(() => viewport.scale);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + width * scale - box.width, handle.y + handle.height / 2 + height * scale - box.height, {steps:8});
        await page.mouse.up();
        const actual = await overview.boundingBox();
        assert.ok(Math.abs(actual.width - width * scale) < 2, `width follows drag at ${scale}`);
        assert.ok(Math.abs(actual.height - height * scale) < 2, `height follows drag at ${scale}`);
        await checkConnector();
    };
    const columns = () => overview.locator('.batch-overview-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    const checkCardSpacing = async () => {
        const problems = await overview.locator('.batch-overview-grid').evaluate(grid => {
            const cards = [...grid.querySelectorAll('.batch-screen')];
            const scale = grid.getBoundingClientRect().width / grid.offsetWidth;
            const gap = parseFloat(getComputedStyle(grid).rowGap) * scale;
            const problems = [];
            cards.forEach((card,index) => {
                const box = card.getBoundingClientRect();
                const actions = card.querySelector('.batch-screen-actions').getBoundingClientRect();
                if(actions.bottom > box.bottom + 1 || actions.height < 40 * scale) problems.push({index,kind:'clipped-actions',height:box.height,actionsHeight:actions.height,overflow:actions.bottom - box.bottom});
                const next = cards.slice(index + 1).find(other => Math.abs(other.getBoundingClientRect().left - box.left) < 1);
                if(next){
                    const actual = next.getBoundingClientRect().top - box.bottom;
                    if(Math.abs(actual - gap) > 1) problems.push({index,kind:'row-gap',actual,expected:gap});
                }
            });
            return problems;
        });
        assert.deepEqual(problems, [], 'every card keeps its controls and the full row gap');
    };
    await resizeOverview(500,480);
    assert.equal(await columns(),2);
    await page.evaluate(() => { viewport.scale = .6; applyViewport(); });
    await resizeOverview(360,360);
    assert.equal(await columns(),1, 'narrow overview adapts to one column');
    assert.equal(await overview.evaluate(el => el.scrollWidth === el.clientWidth),true);
    assert.equal(await overview.locator('.batch-overview-grid').evaluate(el => el.scrollHeight > el.clientHeight),true, 'cards scroll within resized height');
    await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        window.overviewTestPrompts = loop.aiSplitPrompts;
        loop.aiSplitPrompts = Array.from({length:10}, (_,index) => ({title:`第${index + 1}屏`,prompt:'展示产品'}));
        render();
    });
    await resizeOverview(1040,700);
    assert.equal(await columns(),4, 'wide overview adapts to four columns');
    await checkCardSpacing();
    await resizeOverview(730,620);
    assert.equal(await columns(),3, 'ten screens use three columns at default width');
    await checkCardSpacing();
    await page.evaluate(() => {
        const paints = smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'));
        paints[0].runError = '当前屏生成失败，请重试';
        paints[1].images = [{url:'/fixture/spacing-result.svg',kind:'image'}];
        paints[1].runStartedAt = Date.now() - 65000;
        paints[1].runFinishedAt = Date.now();
        viewport = {x:40,y:80,scale:.75};
        applyViewport(); render();
    });
    await resizeOverview(650,980);
    assert.equal(await columns(),2, 'tall overview uses two columns');
    await overview.locator('.batch-screen-media img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
    await checkCardSpacing();
    if(process.env.BATCH_SCREENSHOT) await page.screenshot({path:path.join(root,'.oil-ui/batch-node/shots/overview-spacing.png')});
    await overview.locator('.batch-screen-prompt summary').first().click();
    await checkCardSpacing();
    await page.evaluate(() => applyTheme('dark'));
    await checkCardSpacing();
    await page.evaluate(() => applyTheme('light'));
    await overview.locator('.batch-screen-prompt summary').first().click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        smartLoopDetailPaintNodes(loop).forEach(paint => {
            paint.images = []; delete paint.runError; delete paint.runStartedAt; delete paint.runFinishedAt;
        });
        loop.aiSplitPrompts = overviewTestPrompts;
        loop.batchEditingScreen = -1;
        delete window.overviewTestPrompts;
        render();
    });
    await page.evaluate(() => { viewport.scale = .92; applyViewport(); });
    await resizeOverview(730,620);
    const storedPanel = await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        return {size:loop.batchOverviewSize,offset:loop.batchOverviewOffset};
    });
    await page.evaluate(() => {
        const paints = smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'));
        paints.forEach((paint,index) => {
            paint.runStartedAt = Date.now() - 65000;
            paint.pending = 1;
            paint.pendingTasks = [{taskId:`fixture-progress-${index}`,status:index ? 'running' : 'queued',...(index ? {progress:37} : {queue_info:{position:2,total:3}})}];
            if(index) paint.images = [{url:'/fixture/previous-result.svg',kind:'image'}];
        });
        render();
    });
    const progress = overview.locator('[data-generation-progress]');
    assert.equal(await progress.count(),2, 'hidden screen tasks display progress in overview');
    assert.equal(await progress.nth(0).getAttribute('data-progress-phase'),'queued');
    assert.equal(await progress.nth(1).getAttribute('data-progress-value'),'37');
    assert.equal(await overview.locator('.is-regenerating [data-generation-progress]').count(),1, 'regeneration shows progress over the previous result');
    assert.match(await overview.locator('.generation-progress-label').first().innerText(),/排队中/);
    assert.doesNotMatch(await overview.locator('.batch-screen-empty').first().innerText(),/等待生成/);
    const elapsedBefore = await overview.locator('[data-batch-screen-time]').nth(1).innerText();
    await overview.evaluate(el => el.dataset.timerIdentity = 'preserved');
    await page.waitForFunction(before => document.querySelectorAll('[data-batch-screen-time]')[1].textContent !== before,elapsedBefore);
    assert.equal(await overview.getAttribute('data-timer-identity'),'preserved', 'timer refresh preserves panel DOM');
    await page.evaluate(() => {
        const paints = smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'));
        paints[0].pendingTasks[0] = {taskId:'fixture-progress-0',status:'running',progress:53};
        paints[1].pendingTasks[0].progress = 74;
        requestSmartProgressRender();
    });
    await page.waitForFunction(() => document.querySelectorAll('.batch-screen [data-generation-progress]')[1]?.dataset.progressValue === '74');
    assert.equal(await progress.nth(0).getAttribute('data-progress-value'),'53');
    assert.equal(await progress.nth(0).getAttribute('data-progress-phase'),'running');
    if(process.env.BATCH_SCREENSHOT) await page.screenshot({path:path.join(root,'.oil-ui/batch-node/shots/overview-progress.png')});
    await page.evaluate(() => {
        smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch')).forEach(paint => {
            paint.pending = 0; paint.pendingTasks = []; paint.images = []; delete paint.runStartedAt;
        });
        render();
    });
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
    assert.deepEqual(await page.evaluate(() => {
        const loop = nodes.find(n => n.id === 'batch');
        return {size:loop.batchOverviewSize,offset:loop.batchOverviewOffset};
    }),storedPanel, 'panel size and position survive reload');
    await page.waitForFunction(() => document.querySelector('.batch-overview-link path')?.getAttribute('d'));
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
