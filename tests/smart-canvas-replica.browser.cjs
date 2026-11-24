const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const productUrls = Array.from({length:4}, (_, i) => `/fixture-images/product-${i+1}.png`);
const templateUrls = Array.from({length:6}, (_, i) => `/fixture-images/template-${i+1}.png`);

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(8000);
    const errors = [], generations = [], ocrRequests = [], removedRequests = [];
    let stored = {id:'replica-fixture',title:'同款产品复刻',nodes:[],connections:[],logs:[],settings:{}};
    let failNext = false;
    const tasks = new Map();
    const finalTasks = new Map(), cancellations = [];
    let holding = false, holdSubmit = false, saveFailure = false;
    const heldSubmissions = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if(url.hostname !== 'replica.test') return route.abort();
        if(p.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(p));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(p === '/api/config') return route.fulfill({json:{
            api_providers:[
                {id:'fixture',name:'测试平台',enabled:true,protocol:'openai',image_models:['fixture-image'],chat_models:['fixture-chat'],video_models:[]},
                {id:'api-6789',name:'6789API',enabled:true,protocol:'openai',image_models:['gpt-image-2-high']}
            ],
            comfy_instances:[],reference_image_limits:{default:20,models:{}}
        }});
        if(p === '/api/canvases/replica-fixture'){
            if(req.method() === 'PUT' && saveFailure) return route.fulfill({status:500,json:{detail:'模拟保存失败'}});
            if(req.method() === 'PUT') stored = {...stored,...req.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(p === '/api/canvas-image-tasks' && req.method() === 'POST'){
            const payload = req.postDataJSON();
            generations.push(payload);
            const id = `task-${generations.length}`;
            const resultUrl = `/fixture-images/result-${generations.length}.png`;
            const [natural_w,natural_h] = (payload.output_size || '').split('x').map(Number);
            finalTasks.set(id,failNext ? {status:'failed',error:'模拟平台失败'} : {
                status:'succeeded',result:{images:[resultUrl],...(natural_w ? {image_items:[{url:resultUrl,natural_w,natural_h}]} : {})}
            });
            tasks.set(id,holding ? {status:'queued'} : finalTasks.get(id));
            failNext = false;
            const submit = () => route.fulfill({json:{task_id:id}});
            if(holdSubmit){heldSubmissions.push(submit);return;}
            return submit();
        }
        if(p.startsWith('/api/canvas-image-tasks/')){
            if(p.endsWith('/cancel')){
                const id = p.split('/').at(-2);
                cancellations.push(id);
                tasks.set(id,{status:'cancelled'});
                return route.fulfill({json:{task_id:id,status:'cancelled'}});
            }
            const id = p.split('/').at(-1);
            return route.fulfill({json:{task_id:id,...tasks.get(id)}});
        }
        if(p === '/api/image-ocr'){
            ocrRequests.push(req.postDataJSON());
            return route.fulfill({json:{items:[{text:'旧标题',x:.2,y:.2,width:.3,height:.1}]}});
        }
        if(p === '/api/ai/upload') return route.fulfill({json:{files:[{url:'/fixture-images/uploaded-gift.png',name:'赠品.png',kind:'image'}]}});
        if(['/api/canvas-llm','/api/canvas-replica/product-search'].includes(p)){
            removedRequests.push(p);
            return route.fulfill({status:404,json:{detail:'Not Found'}});
        }
        if(p.startsWith('/fixture-images/') || p === '/api/media-preview'){
            const template = /template/.test(req.url());
            return route.fulfill({contentType:'image/svg+xml',body:
                `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${template ? 800 : 600}"><rect width="100%" height="100%" fill="${template ? '#eadbc3' : '#b9cdcf'}"/><rect x="180" y="120" width="240" height="360" rx="80" fill="#50777a"/><text x="300" y="550" text-anchor="middle" font-size="36" fill="#253f42">${path.basename(p,'.png')}</text></svg>`});
        }
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('https://replica.test/static/smart-canvas.html?id=replica-fixture');
    await page.waitForFunction(() => canvas?.id === 'replica-fixture' && smartConfigReady);
    await page.evaluate(({products,templates}) => {
        nodes = [
            {id:'product-source',type:'smart-upload',x:-1400,y:0,images:products.slice(0,2).map((url,i) => ({url,name:`产品${i+1}.png`,kind:'image'}))},
            {id:'template-source',type:'smart-upload',x:-1400,y:500,images:templates.map((url,i) => ({url,name:`模板${i+1}.png`,kind:'image',natural_w:600,natural_h:800}))},
            {id:'replica',type:'oneClickReplica',x:100,y:80,images:[],replica:{provider:'fixture',model:'fixture-image',
                inputs:{product:{uploads:products.slice(2).map((url,i) => ({url,name:`产品${i+3}.png`,kind:'image'}))}}}}
        ];
        canvas.connections = [
            {from:'product-source',to:'replica',kind:'input',input_slot:'product'},
            {from:'template-source',to:'replica',kind:'input',input_slot:'template'}
        ];
        canvasUsesConnections = true;
        SmartCanvasReplica.normalize(nodes.find(n => n.id === 'replica'));
        selectedId = ''; selectedIds = [];
        viewport = {x:0,y:0,scale:1};
        applyViewport(); render();
    },{products:productUrls,templates:templateUrls});
    return {page,generations,ocrRequests,removedRequests,cancellations,stored:() => stored,fail:() => {failNext = true;},
        hold:() => {holding = true;},pauseSubmit:() => {holdSubmit = true;},
        releaseSubmit:async () => {holdSubmit = false;await Promise.all(heldSubmissions.splice(0).map(submit => submit()));},
        complete:id => tasks.set(id,finalTasks.get(id)),setTask:(id,data) => tasks.set(id,data),failSave:value => {saveFailure = value;}};
}

const card = page => page.locator('[data-id="replica"]');
const productThumbs = page => card(page).locator('[data-replica-slot="product"] .replica-thumb');
const run = page => page.evaluate(() => SmartCanvasReplica.run(nodes.find(n => n.id === 'replica')));
const refUrls = payload => payload.reference_images.map(image => image.url);
const setTemplates = (page,urls) => page.evaluate(urls => {
    nodes.find(n => n.id === 'replica').replica.inputs.template.excluded = urls;
    render();
},urls);
const fastPoll = page => page.evaluate(() => {
    const poll = XiaomeiImageTaskClient.pollImageTask;
    XiaomeiImageTaskClient.pollImageTask = (id,options) => poll(id,{...options,intervalMs:40});
});

test('four same-product references generate six templates, then preserve the selected main image after reorder and reload', {timeout:60000}, async t => {
    const {page,generations,stored} = await fixture(t);
    const combination = card(page).locator('[data-replica-field="combination"]');
    assert.equal(await combination.inputValue(),'oneToMany');
    assert.deepEqual(await combination.locator('option').allTextContents(),['单组复刻','一款多版','多款同版']);
    assert.deepEqual(await productThumbs(page).locator(':scope > button small').allTextContents(),['主图','细节','细节','细节']);
    assert.match(await card(page).locator('.replica-run').textContent(),/6 张/);
    assert.ok(await card(page).locator('.replica-run').isEnabled());
    for(const slot of ['product','template']){
        const row = await card(page).locator(`[data-replica-slot="${slot}"]`).boundingBox();
        const port = await card(page).locator(`.port-in[data-input-slot="${slot}"]`).boundingBox();
        assert.ok(Math.abs(port.y + port.height/2 - row.y - row.height/2) < 4,`${slot} port stays centered`);
    }
    const panelBox = await card(page).boundingBox();
    const buttonBox = await card(page).locator('.replica-run').boundingBox();
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-replica-product-details.png')});
    assert.ok(buttonBox.y + buttonBox.height <= panelBox.y + panelBox.height,JSON.stringify({panelBox,buttonBox}));
    await run(page);
    assert.equal(generations.length,6);
    generations.forEach((payload,i) => {
        assert.deepEqual(refUrls(payload),[...productUrls,templateUrls[i]]);
        assert.deepEqual(payload.reference_images.map(image => image.role),['image_1','image_2','image_3','image_4','image_5']);
        assert.match(payload.prompt,/图1是产品主图/);
        assert.match(payload.prompt,/图2至图4均为图1同一产品的细节补充/);
        assert.match(payload.prompt,/图5是唯一的版式模板/);
        assert.doesNotMatch(payload.prompt,/款不同的产品|全部 4 款产品/);
        assert.equal(payload.n,1);
        assert.equal(payload.aspect_ratio,'3:4');
        assert.equal(payload.resolution,'4k');
        assert.equal(payload.output_size,undefined);
    });
    assert.equal(await page.evaluate(() => nodes.find(n => n.title === '复刻结果').images.length),6);

    await productThumbs(page).nth(3).locator('[data-replica-action="earlier"]').click({force:true});
    await productThumbs(page).nth(2).locator('[data-replica-action="earlier"]').click({force:true});
    await productThumbs(page).nth(1).locator('[data-replica-action="earlier"]').click({force:true});
    await productThumbs(page).first().locator('[data-replica-action="toggle"]').click();
    assert.deepEqual(await productThumbs(page).locator(':scope > button small').allTextContents(),['1','主图','细节','细节']);
    await page.evaluate(() => {
        nodes.find(n => n.id === 'replica').replica.combination = 'sameProduct';
        return saveCanvas();
    });
    assert.deepEqual(stored().nodes.find(n => n.id === 'replica').replica.inputs.product.order,[productUrls[3],...productUrls.slice(0,3)]);
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    assert.equal(await combination.inputValue(),'oneToMany','the saved reference-group choice opens as one-to-many');
    assert.deepEqual(await productThumbs(page).locator(':scope > button small').allTextContents(),['1','主图','细节','细节']);
    await setTemplates(page,templateUrls.slice(1));
    await run(page);
    assert.equal(generations.length,7);
    assert.deepEqual(refUrls(generations.at(-1)),[...productUrls.slice(0,3),templateUrls[0]]);
    assert.match(generations.at(-1).prompt,/图2至图3均为图1同一产品/);
    assert.match(generations.at(-1).prompt,/图4是唯一的版式模板/);
});

test('GPT replica maps each template or a saved custom size to exact output pixels', {timeout:60000}, async t => {
    const {page,generations,fail} = await fixture(t);
    await setTemplates(page,templateUrls.slice(2));
    await page.evaluate(() => {
        const [landscape,portrait] = nodes.find(n => n.id === 'template-source').images;
        Object.assign(landscape,{natural_w:1464,natural_h:600});
        delete portrait.natural_w;
        delete portrait.natural_h;
        render();
    });
    const select = async (field,label) => {
        await card(page).locator(`[data-replica-field="${field}"]`).click();
        await page.locator('#batch-select-menu').getByRole('option',{name:label,exact:true}).click();
    };
    const ratio = card(page).locator('[data-replica-field="ratio"]');
    assert.deepEqual(await ratio.locator('option[value="custom"]').allTextContents(),[]);
    await select('provider','6789API');
    await run(page);
    const requestSizes = () => generations.map(({size,output_size,aspect_ratio,resolution}) =>
        [size,output_size,aspect_ratio,resolution]);
    assert.deepEqual(requestSizes(),[
        ['1464x600','1464x600','61:25',undefined],
        ['600x800','600x800','3:4',undefined]
    ]);
    assert.equal(generations[0].model,'gpt-image-2-high');
    const resultSizes = () => page.evaluate(() => nodes.find(n => n.id === nodes.find(n => n.id === 'replica').replica.outputNodeId)
        .images.map(img => [img.natural_w,img.natural_h]));
    assert.deepEqual(await resultSizes(),[[1464,600],[600,800]]);

    await select('ratio','自定义尺寸');
    const width = card(page).getByRole('spinbutton',{name:'宽度 (px)'});
    const height = card(page).getByRole('spinbutton',{name:'高度 (px)'});
    await width.fill('8193');
    await height.fill('1001');
    await card(page).locator('.replica-run').click();
    assert.match(await card(page).getByRole('alert').textContent(),/1 到 8192 之间的整数/);
    assert.equal(generations.length,2);
    await width.fill('1803');
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    assert.equal(await width.inputValue(),'1803');
    assert.equal(await height.inputValue(),'1001');
    const panelBox = await card(page).boundingBox();
    const buttonBox = await card(page).locator('.replica-run').boundingBox();
    assert.ok(buttonBox.y + buttonBox.height <= panelBox.y + panelBox.height);
    fail();
    await run(page);
    assert.deepEqual(requestSizes().slice(2),Array.from({length:2},() => ['1803x1001','1803x1001','1803:1001',undefined]));
    await width.fill('900');
    await card(page).locator('[data-replica-action="retry"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(j => j.status === 'succeeded'));
    assert.deepEqual(requestSizes().at(-1),['1803x1001','1803x1001','1803:1001',undefined]);
    assert.deepEqual(await resultSizes(),[[1803,1001],[1803,1001]]);
});

test('the two copy modes use the same product references and OCR edits appear in the image request', {timeout:60000}, async t => {
    const {page,generations,ocrRequests,removedRequests} = await fixture(t);
    await setTemplates(page,templateUrls.slice(1));
    assert.deepEqual(await card(page).locator('[data-replica-mode]').allTextContents(),['保持原文','识别并修改']);
    assert.equal(await card(page).locator('[data-replica-mode="keep"]').getAttribute('aria-pressed'),'true');
    assert.equal(await card(page).locator('[data-replica-action="web-search"], [data-replica-field="facts"]').count(),0);
    await card(page).locator('[data-replica-mode="edit"]').click();
    await card(page).locator('[data-replica-action="recognize"]').click();
    await card(page).locator('[data-replica-rule-field="replacement"]').fill('新标题');
    assert.deepEqual(ocrRequests.map(({provider,model,poster_copy_only}) => [provider,model,poster_copy_only]),[['fixture','fixture-chat',true]]);
    await run(page);
    assert.match(generations[0].prompt,/图5是版式模板/);
    assert.match(generations[0].prompt,/新标题/);
    assert.deepEqual(refUrls(generations[0]),[...productUrls,templateUrls[0]]);
    assert.deepEqual(removedRequests,[]);
});

test('saved automatic-copy jobs resume without searching or regenerating copy', {timeout:60000}, async t => {
    const {page,generations,removedRequests,stored} = await fixture(t);
    await setTemplates(page,templateUrls.slice(1));
    await run(page);
    await page.evaluate(() => saveCanvas());
    const replica = stored().nodes.find(n => n.id === 'replica').replica;
    const {taskId,result,outputPublished,...previous} = replica.jobs[0];
    const research = {facts:'测试随行杯',provider:'fixture',model:'fixture-chat',webSearch:true};
    Object.assign(replica,{mode:'adapt',facts:research.facts,webSearch:true,jobs:[
        {...previous,taskId,status:'running',research},
        {...previous,requestId:'old-unprepared',status:'queued',research,prompt:'等待撰写文案'},
        {...previous,requestId:'old-inline',status:'queued',prompt:'旧提示\n用户提供的商品资料\n旧商品资料'},
        {...previous,requestId:'old-prepared',status:'queued',research,prompt:'排入已保存的文案',copyPlan:{lines:['细节呈现']}}
    ]});
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    assert.equal(await card(page).locator('[data-replica-mode="keep"]').getAttribute('aria-pressed'),'true');
    await card(page).locator('[data-replica-action="resume"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(job => job.status === 'succeeded'));
    assert.equal(generations.length,4,'the submitted task is queried by ID');
    for(const requestId of ['old-unprepared','old-inline']){
        const payload = generations.find(item => item.client_request_id === requestId);
        assert.deepEqual(refUrls(payload),[...productUrls,templateUrls[0]]);
        assert.match(payload.prompt,/逐字保留图5所有可见原文/);
        assert.doesNotMatch(payload.prompt,/旧商品资料|等待撰写文案/);
    }
    assert.match(generations.find(item => item.client_request_id === 'old-prepared').prompt,/指定的成图文案.*\n\["细节呈现"\]/);
    assert.deepEqual(removedRequests,[]);
});

test('empty selection and reference limits stop submission, and failed jobs retry their saved reference group', {timeout:60000}, async t => {
    const {page,generations,fail} = await fixture(t);
    await setTemplates(page,templateUrls.slice(1));
    for(let i=0;i<4;i++) await productThumbs(page).nth(i).locator('[data-replica-action="toggle"]').click();
    assert.ok(await card(page).locator('.replica-run').isDisabled());
    await run(page);
    assert.equal(generations.length,0);
    await productThumbs(page).first().locator('[data-replica-action="toggle"]').click();
    await run(page);
    assert.deepEqual(refUrls(generations[0]),[productUrls[0],templateUrls[0]]);
    assert.match(generations[0].prompt,/图2是唯一的版式模板/);
    await productThumbs(page).nth(1).locator('[data-replica-action="toggle"]').click();
    fail();
    await run(page);
    assert.deepEqual(refUrls(generations[1]),[...productUrls.slice(0,2),templateUrls[0]]);
    assert.match(generations[1].prompt,/图2均为图1同一产品的细节补充/);
    await productThumbs(page).nth(2).locator('[data-replica-action="toggle"]').click();
    await card(page).locator('[data-replica-action="retry"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(j => j.status === 'succeeded'));
    assert.equal(generations.length,3);
    assert.deepEqual(refUrls(generations[2]),refUrls(generations[1]),'retry uses its original product and detail snapshot');
    assert.notEqual(generations[2].client_request_id,generations[1].client_request_id);
    await page.evaluate(() => {
        const input = nodes.find(n => n.id === 'replica').replica.inputs.product;
        input.excluded = [];
        input.uploads = Array.from({length:19},(_,i) => ({url:`/fixture-images/extra-${i}.png`,name:`细节${i}`,kind:'image'}));
        render();
    });
    await run(page);
    assert.equal(generations.length,3,'too many references never submit a truncated group');
    assert.match(await card(page).locator('.replica-jobs').textContent(),/最多支持 20 张参考图/);
});

test('single and one-to-many share product details while many-to-one uses separate secondary references', {timeout:60000}, async t => {
    const {page,generations} = await fixture(t);
    const choose = async label => {
        await card(page).locator('[data-replica-field="combination"]').click();
        await page.locator('#batch-select-menu').getByRole('option',{name:label,exact:true}).click();
    };
    await choose('单组复刻');
    assert.ok(await card(page).locator('.replica-run').isEnabled());
    assert.deepEqual(await productThumbs(page).locator(':scope > button small').allTextContents(),['主图','细节','细节','细节']);
    await run(page);
    assert.equal(generations.length,6);
    generations.forEach((payload,i) => {
        assert.deepEqual(refUrls(payload),[...productUrls,templateUrls[i]]);
        assert.match(payload.prompt,/图2至图4均为图1同一产品的细节补充/);
    });

    await choose('一款多版');
    assert.ok(await card(page).locator('.replica-run').isEnabled());
    await run(page);
    assert.equal(generations.length,12);
    generations.slice(6).forEach((payload,i) => assert.deepEqual(refUrls(payload),[...productUrls,templateUrls[i]]));
    for(let i=1;i<4;i++) await productThumbs(page).nth(i).locator('[data-replica-action="toggle"]').click();
    await run(page);
    assert.equal(generations.length,18);
    generations.slice(12).forEach((payload,i) => assert.deepEqual(refUrls(payload),[productUrls[0],templateUrls[i]]));

    await choose('多款同版');
    assert.ok(await card(page).locator('.replica-run').isDisabled());
    await run(page);
    assert.equal(generations.length,18);
    await page.evaluate(urls => {
        nodes.find(n => n.id === 'replica').replica.inputs.secondary.uploads = urls.map((url,i) => ({url,name:`次要产品${i+1}`,kind:'image'}));
        render();
    },productUrls.slice(1));
    await setTemplates(page,templateUrls.slice(1));
    assert.match(await card(page).locator('.replica-run').textContent(),/1 张/);
    await run(page);
    assert.equal(generations.length,19);
    assert.deepEqual(refUrls(generations.at(-1)),[...productUrls,templateUrls[0]]);
    assert.match(generations.at(-1).prompt,/图2为次要产品参考/);
    assert.match(generations.at(-1).prompt,/主产品是画面的视觉主体/);

    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    assert.equal(await card(page).locator('[data-replica-field="combination"]').inputValue(),'manyToOne');
    assert.deepEqual(await productThumbs(page).locator(':scope > button small').allTextContents(),['主图','2','3','4']);
});

test('secondary products and gifts support connections, upload, roles, hidden inputs, reload and retry snapshots', {timeout:60000}, async t => {
    const {page,generations,fail} = await fixture(t);
    const secondary = () => card(page).locator('[data-replica-slot="secondary"]');
    const choose = async label => {
        await card(page).locator('[data-replica-field="combination"]').click();
        await page.locator('#batch-select-menu').getByRole('option',{name:label,exact:true}).click();
    };
    assert.equal(await secondary().count(),0);
    await choose('多款同版');
    assert.equal(await secondary().count(),1);
    await setTemplates(page,templateUrls.slice(1));
    assert.ok(await card(page).locator('.replica-run').isDisabled());
    assert.match(await card(page).locator('.replica-status').textContent(),/其他产品参考/);
    await run(page);
    assert.equal(generations.length,0);

    const secondaryUrl = '/fixture-images/secondary.png', giftUrl = '/fixture-images/uploaded-gift.png';
    assert.equal(await page.evaluate(url => {
        nodes.push({id:'secondary-source',type:'smart-upload',x:-1400,y:800,images:[{url,name:'次要产品.png',kind:'image'}]});
        return connectInputNode('secondary-source','replica','secondary');
    },secondaryUrl),true);
    const chooser = page.waitForEvent('filechooser');
    await secondary().getByRole('button',{name:'上传其他产品参考',exact:true}).click();
    await (await chooser).setFiles({name:'赠品.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64')});
    const giftRole = secondary().locator(`[data-replica-product-role="${giftUrl}"]`);
    await giftRole.selectOption('gift');
    assert.deepEqual(await secondary().locator('select').evaluateAll(els => els.map(el => el.value)),['secondary','gift']);
    for(const slot of ['product','template','secondary']){
        const row = await card(page).locator(`[data-replica-slot="${slot}"]`).boundingBox();
        const port = await card(page).locator(`.port-in[data-input-slot="${slot}"]`).boundingBox();
        assert.ok(Math.abs(port.y+port.height/2-row.y-row.height/2)<4,`${slot} port follows its row`);
    }
    const panelBox = await card(page).boundingBox(), runBox = await card(page).locator('.replica-run').boundingBox();
    assert.ok(runBox.y+runBox.height<=panelBox.y+panelBox.height);
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-replica-secondary-gift.png')});
    await run(page);
    assert.equal(generations.length,1);
    assert.deepEqual(refUrls(generations[0]),[...productUrls,secondaryUrl,giftUrl,templateUrls[0]]);
    assert.match(generations[0].prompt,/图2至图4均为图1同一产品的细节补充/);
    assert.match(generations[0].prompt,/图5为次要产品参考/);
    assert.match(generations[0].prompt,/图6为赠品参考/);
    assert.match(generations[0].prompt,/图7是唯一的版式模板/);
    assert.match(generations[0].prompt,/不得放大成视觉主体/);
    assert.doesNotMatch(generations[0].prompt,/分别是 6 款不同/);

    await choose('一款多版');
    assert.equal(await secondary().count(),0);
    assert.equal(await page.locator('.conn-group[data-conn-input-slot="secondary"]').count(),0);
    assert.equal(await page.evaluate(() => smartDependencyInputs(nodes.find(n => n.id === 'replica')).some(n => n.id === 'secondary-source')),false);
    assert.equal(await page.evaluate(() => smartRunGraph().ancestors('replica').some(n => n.id === 'secondary-source')),false);
    await run(page);
    assert.deepEqual(refUrls(generations.at(-1)),[...productUrls,templateUrls[0]],'hidden secondary references do not enter other combinations');
    await choose('多款同版');
    assert.equal(await page.locator('.conn-group[data-conn-input-slot="secondary"]').count(),1);
    assert.equal(await page.evaluate(() => smartDependencyInputs(nodes.find(n => n.id === 'replica')).some(n => n.id === 'secondary-source')),true);
    assert.equal(await page.evaluate(() => smartRunGraph().ancestors('replica').some(n => n.id === 'secondary-source')),true);
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    assert.equal(await giftRole.inputValue(),'gift');
    assert.equal(await secondary().locator('.replica-thumb').count(),2);

    await secondary().locator('.replica-thumb').nth(1).locator('[data-replica-action="earlier"]').click({force:true});
    assert.deepEqual(await secondary().locator('select').evaluateAll(els => els.map(el => el.value)),['gift','secondary']);
    fail();
    await run(page);
    const failed = generations.at(-1);
    assert.match(failed.prompt,/图5为赠品参考/);
    assert.match(failed.prompt,/图6为次要产品参考/);
    await giftRole.selectOption('secondary');
    await card(page).locator('[data-replica-action="retry"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(job => job.status === 'succeeded'));
    assert.deepEqual(refUrls(generations.at(-1)),refUrls(failed));
    assert.equal(generations.at(-1).prompt,failed.prompt,'retry keeps its saved product roles');
    assert.notEqual(generations.at(-1).client_request_id,failed.client_request_id);
    await page.evaluate(() => {
        nodes.find(n => n.id === 'replica').replica.inputs.secondary.uploads = Array.from({length:20},(_,i) => ({url:`/fixture-images/extra-secondary-${i}.png`,name:`次要${i}`,kind:'image'}));
        render();
    });
    const submitted = generations.length;
    await run(page);
    assert.equal(generations.length,submitted,'all product groups share the model reference limit');
    assert.match(await card(page).locator('.replica-jobs').textContent(),/最多支持 20 张参考图/);
});

test('replica creates its output before submission, ticks elapsed time, and uses real progress in the same result node', {timeout:60000}, async t => {
    const {page,generations,hold,pauseSubmit,releaseSubmit,complete,setTask} = await fixture(t);
    await setTemplates(page,templateUrls.slice(2));
    await fastPoll(page);
    hold();pauseSubmit();
    await card(page).locator('.replica-run').click();
    const output = page.locator('.replica-output');
    await output.waitFor();
    const outputId = await output.getAttribute('data-replica-output');
    const frame = page.locator(`[data-id="${outputId}"]`);
    assert.equal(await output.locator('.replica-output-slot').count(),2);
    assert.match(await output.locator('.replica-output-summary').textContent(),/已完成 0\/2/);
    assert.equal(await page.evaluate(id => nodes.find(n => n.id === id).images.length,outputId),0);
    assert.equal(await page.evaluate(id => canvas.connections.some(c => c.from === 'replica' && c.to === id),outputId),true);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'replica').replica.jobs.some(job => job.taskId)),false,'output exists before the API acknowledges submission');
    const before = await output.locator('.replica-output-summary').textContent();
    await page.waitForTimeout(1200);
    assert.notEqual(await output.locator('.replica-output-summary').textContent(),before,'elapsed time ticks while the API is accepting the task');
    assert.equal(await output.locator('[data-progress-source="indeterminate"]').count(),2);
    assert.doesNotMatch(await output.textContent(),/\d+%/);
    await releaseSubmit();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(job => job.taskId));
    await output.evaluate(element => {window.replicaOutputElement = element;});
    setTask('task-1',{status:'running',progress_percent:35});
    await page.waitForFunction(() => document.querySelector('.replica-output [data-progress-value="35"]'));
    assert.equal(await output.evaluate(element => element === window.replicaOutputElement),true,'polling updates progress without replacing the output DOM');
    assert.match(await output.locator('.replica-output-summary').textContent(),/已用/);
    await page.mouse.move(1300,800);
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-replica-output-progress.png')});
    const position = await page.evaluate(id => {const n=nodes.find(n => n.id === id);return [n.x,n.y];},outputId);
    complete('task-1');
    await page.waitForFunction(() => nodes.find(n => n.title === '复刻结果').images.length === 1);
    assert.match(await output.locator('.replica-output-summary').textContent(),/已完成 1\/2/);
    assert.equal(await output.locator('.generation-complete-cell').count(),1);
    setTask('task-2',{status:'failed',error:'模拟中途失败'});
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[1].status === 'failed');
    assert.match(await output.textContent(),/失败.*模拟中途失败/);
    await card(page).locator('[data-replica-action="retry"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[1].taskId === 'task-3');
    complete('task-3');
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs.every(job => job.status === 'succeeded'));
    assert.equal(await output.count(),0,'completed output uses normal image presentation');
    assert.equal(await frame.count(),1);
    assert.equal(await page.evaluate(() => nodes.filter(n => n.title === '复刻结果').length),1);
    assert.deepEqual(await page.evaluate(id => {const n=nodes.find(n => n.id === id);return [n.x,n.y,n.images.map(image => image.url)];},outputId),[...position,['/fixture-images/result-1.png','/fixture-images/result-3.png']]);
    assert.equal(generations.length,3);
});

test('pending output restores with its saved task and cancellation stops its timer', {timeout:60000}, async t => {
    const {page,generations,hold,cancellations} = await fixture(t);
    await setTemplates(page,templateUrls.slice(1));
    await fastPoll(page);hold();
    await card(page).locator('.replica-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[0]?.taskId);
    const outputId = await page.evaluate(() => nodes.find(n => n.id === 'replica').replica.outputNodeId);
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes?.some(n => n.id === 'replica') && smartConfigReady);
    await fastPoll(page);
    assert.equal(await page.locator('.replica-output').count(),1);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === 'replica').replica.outputNodeId),outputId);
    assert.equal(generations.length,1,'restoring progress never resubmits a paid task');
    await card(page).locator('[data-replica-action="resume"]').click();
    await card(page).locator('[data-replica-action="cancel"]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[0].status === 'cancelled');
    assert.ok(cancellations.includes('task-1'));
    assert.match(await page.locator('.replica-output').textContent(),/已取消/);
    const elapsed = await page.locator('.replica-output-summary').textContent();
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.replica-output-summary').textContent(),elapsed);
    assert.equal(generations.length,1);
});

test('deleted output stays deleted, and save failures show a terminal output without submitting', {timeout:60000}, async t => {
    const {page,generations,hold,complete,failSave} = await fixture(t);
    await setTemplates(page,templateUrls.slice(1));
    await fastPoll(page);hold();
    await card(page).locator('.replica-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[0]?.taskId);
    await page.evaluate(() => {
        const id = nodes.find(n => n.id === 'replica').replica.outputNodeId;
        nodes = nodes.filter(n => n.id !== id);
        canvas.connections = canvas.connections.filter(c => c.from !== id && c.to !== id);
        render();
    });
    complete('task-1');
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[0].status === 'succeeded');
    assert.equal(await page.evaluate(() => nodes.filter(n => n.title === '复刻结果').length),0);
    failSave(true);
    await card(page).locator('.replica-run').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'replica').replica.jobs[0].status === 'failed');
    assert.equal(generations.length,1);
    assert.match(await page.locator('.replica-output').textContent(),/失败.*画布未保存/);
    assert.equal(await page.locator('.replica-output .generation-progress-ring').count(),0);
    failSave(false);
});
