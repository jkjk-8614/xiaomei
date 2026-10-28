const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('canvas commerce planner uses roles and preserves prior prompts on failure', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:1200}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let payload, fail = false;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'commerce-planner.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,image_models:['image'],chat_models:['chat']}],comfy_instances:[]}});
        if(url.pathname === '/api/canvas-llm'){
            payload = route.request().postDataJSON();
            return fail ? route.fulfill({status:500,json:{detail:'失败'}}) : route.fulfill({json:{text:JSON.stringify({screens:[{title:'首屏',prompt:'展示产品'},{title:'细节',prompt:'展示细节'}]})}});
        }
        if(url.pathname === '/api/canvases/commerce-planner') return route.fulfill({json:{canvas:{id:'commerce-planner',nodes:[],connections:[],logs:[],settings:{}}}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://commerce-planner.test/static/smart-canvas.html?id=commerce-planner');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'commerce-planner');
    await page.evaluate(() => {
        nodes = [{id:'source',type:'smart-upload',x:0,y:0,images:[{url:'/product.png',kind:'image'},{url:'/style.png',kind:'image'}]},
            {id:'batch',type:'smart-loop',batchUiMode:'paired',batchDetailModeV2:true,x:400,y:0,w:420,h:760,imageInput:true,showPrompt:true,loopStart:1,imageBatchSize:1,batchSourceNodeId:'local',batchSourceText:'防水',batchAiTargetCount:2,batchAiProvider:'fixture',batchAiModel:'chat',batchCommerceOpen:true,variablePrompts:['']}];
        canvas.connections = [{from:'source',to:'batch',kind:'input'}]; canvasUsesConnections = true; render();
    });
    await page.locator('[data-id="batch"] [data-loop-commerce-role]').nth(1).selectOption('reference');
    await page.locator('[data-id="batch"] [data-loop-commerce="productName"]').fill('淋浴门');
    await page.locator('[data-id="batch"] [data-loop-commerce-plan]').click();
    await page.waitForFunction(() => nodes.find(n => n.id === 'batch').aiSplitPrompts?.length === 2);
    assert.match(payload.message, /淋浴门/);
    assert.match(payload.message, /图2：仅参考风格和排版/);
    assert.equal(payload.images.length, 2);
    assert.equal(await page.locator('[data-id="batch"] [data-loop-result-edit]').count(), 2);
    const before = await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts.map(x => x.prompt));
    fail = true;
    await page.locator('[data-id="batch"] [data-loop-commerce-plan]').click();
    await page.waitForFunction(() => !nodes.find(n => n.id === 'batch').aiSplitRunning);
    assert.deepEqual(await page.evaluate(() => nodes.find(n => n.id === 'batch').aiSplitPrompts.map(x => x.prompt)), before);
});
