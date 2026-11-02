const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('commerce platforms affect planning and image requests while preserving saved output choices', {timeout:90000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:1500}});
    const errors = [], plans = [], images = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved, fail = false;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        if(url.hostname !== 'commerce-platforms.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,image_models:['gpt-image-2'],chat_models:['chat']}],comfy_instances:[]}});
        if(pathname === '/api/canvas-llm'){
            plans.push(request.postDataJSON());
            return fail ? route.fulfill({status:500,json:{detail:'fixture failure'}}) : route.fulfill({json:{text:JSON.stringify({visual_guide:'保持商品真实',screens:[{title:'首屏',prompt:'展示产品'},{title:'细节',prompt:'展示细节'}]})}});
        }
        if(pathname === '/api/canvas-image-tasks' && request.method() === 'POST'){
            images.push(request.postDataJSON());
            return route.fulfill({json:{task_id:`image-${images.length}`,status:'queued'}});
        }
        if(pathname.startsWith('/api/canvas-image-tasks/')) return route.fulfill({json:{id:pathname.split('/').pop(),status:'succeeded',result:{images:['/output/result.png']}}});
        if(pathname.startsWith('/output/') || pathname === '/api/media-preview') return route.fulfill({contentType:'image/png',body:png});
        if(pathname === '/api/canvases/platforms'){
            if(request.method() === 'PUT') saved = request.postDataJSON();
            return route.fulfill({json:{canvas:saved || {id:'platforms',nodes:[],connections:[],logs:[],settings:{}}}});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://commerce-platforms.test/static/smart-canvas.html?id=platforms');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'platforms');
    await page.evaluate(() => {
        nodes = [{id:'source',type:'smart-upload',x:-400,y:0,images:[{url:'/output/product.png',kind:'image'},{url:'/output/style.png',kind:'image'}]},
            {id:'batch',type:'smart-loop',batchUiMode:'paired',batchDetailModeV2:true,x:0,y:0,w:420,h:760,imageInput:true,showPrompt:true,loopStart:1,imageBatchSize:1,batchSourceNodeId:'local',batchSourceText:'真实材质和尺寸',batchAiTargetCount:2,batchAiProvider:'fixture',batchAiModel:'chat',variablePrompts:[''],
                batchCommerce:{mode:'主图',language:'法语',copy:'全部无文字',model:'允许使用模特'},
                batchImageSettings:{engine:'api',provider_id:'fixture',model:'gpt-image-2',ratio:'portrait43',resolution:'2k',count:1}}];
        canvas.connections = [{from:'source',to:'batch',kind:'input'}]; canvasUsesConnections = true;
        viewport = {x:60,y:20,scale:.8}; applyViewport(); render();
    });
    const batch = page.locator('[data-id="batch"]');
    const platformSelect = batch.locator('[data-loop-commerce="platform"]');
    const platforms = ['淘宝 / 天猫','京东','拼多多','抖音电商','亚马逊 · 主图组','亚马逊 · A+ 模块','Shopee','Lazada','TikTok Shop','Temu','eBay','Etsy','AliExpress','独立站 / Shopify','通用'];
    assert.deepEqual(await platformSelect.locator('option').allTextContents(), platforms);
    await batch.locator('[data-loop-commerce-role]').nth(1).selectOption('reference');
    const strategies = new Set();
    const plan = async name => {
        await platformSelect.selectOption(name);
        const hint = await batch.locator('[data-batch-platform-hint]').textContent();
        assert.ok(hint.length > 8);
        await batch.locator('[data-loop-commerce-plan]').click();
        await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
        const payload = plans.at(-1);
        assert.ok(payload.message.includes(`目标平台：${name}`));
        assert.ok(payload.message.includes(`平台设计策略（${name}）`));
        assert.ok(payload.system_prompt.includes(`平台设计策略（${name}）`));
        assert.match(payload.message, /输出语言：法语/);
        assert.match(payload.message, /文案：全部无文字/);
        assert.equal(payload.images.length, 2);
        const prompt = await page.evaluate(() => smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'))[0].promptDraftText);
        assert.ok(prompt.includes(`平台设计策略（${name}）`));
        assert.match(prompt, /语种：法语/);
        assert.match(prompt, /图中文字：全部无文字|图中文字：白底主图不叠加文字/);
        assert.deepEqual(await page.evaluate(() => {
            const node = nodes.find(n => n.id === 'batch'), settings = smartLoopBatchImageSettings(node);
            return [smartLoopCommerceFields(node).language, settings.ratio, settings.resolution];
        }), ['法语','portrait43','2k']);
        strategies.add(payload.message.match(/平台设计策略[^\n]+/)[0].replace(name, ''));
    };
    for(const name of platforms) await plan(name);
    assert.equal(strategies.size, platforms.length, 'each platform has its own content strategy');
    const generate = async index => {
        const before = images.length;
        await batch.locator(`[data-batch-screen-run="${index}"]`).click();
        await page.waitForFunction(() => !smartCascadeIsLoopRunning('batch'));
        assert.equal(images.length, before + 1);
        assert.equal(images.at(-1).aspect_ratio, '3:4');
        assert.equal(images.at(-1).reference_images.length, 2);
        return images.at(-1).prompt;
    };
    await plan('亚马逊 · 主图组');
    const main = await generate(0), secondary = await generate(1);
    assert.match(main, /当前屏执行白底主图：纯白背景/);
    assert.match(main, /不添加模特及无关道具/);
    assert.match(secondary, /当前屏执行副图：/);
    assert.doesNotMatch(secondary, /当前屏执行白底主图/);
    await plan('亚马逊 · A+ 模块');
    const aplus = await generate(0);
    assert.match(aplus, /每屏只承担一个模块职责/);
    assert.doesNotMatch(plans.at(-1).message, /每个方案独立/);
    assert.doesNotMatch(aplus, /当前屏执行白底主图/);
    assert.match(aplus, /图中文字：全部无文字/);
    await platformSelect.selectOption('拼多多');
    const switched = await generate(0);
    assert.match(switched, /平台设计策略（拼多多）/);
    assert.doesNotMatch(switched, /平台设计策略（亚马逊 · A\+ 模块）/);
    await platformSelect.selectOption('亚马逊 · A+ 模块');
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-commerce-platforms.png')});
    const before = await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts);
    fail = true;
    await batch.locator('[data-loop-commerce-plan]').click();
    await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts), before);
    await page.evaluate(async () => { clearTimeout(saveTimer); await saveCanvas(); });
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'batch'));
    assert.equal(await platformSelect.inputValue(), '亚马逊 · A+ 模块');
    assert.equal(await batch.locator('[data-loop-commerce="language"]').inputValue(), '法语');
    assert.match(await batch.locator('[data-batch-platform-hint]').textContent(), /品牌故事/);
    await page.evaluate(() => {
        nodes.find(n => n.id === 'batch').batchCommerce.platform = '自定义旧平台'; render();
    });
    assert.equal(await platformSelect.inputValue(), '自定义旧平台');
    assert.match(await page.evaluate(() => smartBatchPlatformRules(nodes.find(n => n.id === 'batch'))), /平台设计策略（自定义旧平台）/);
});
