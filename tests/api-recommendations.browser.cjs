const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('推荐 API 添加、刷新保留、编辑、失败重试、配置 Key 和移除', {timeout:90000}, async t => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-recommend-browser-'));
    fs.mkdirSync(path.join(data,'static'));
    fs.writeFileSync(path.join(data,'static/index.html'), '<!doctype html><title>fixture</title>');
    const port = await new Promise(resolve => {
        const server = net.createServer(); server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
    });
    const base = `http://127.0.0.1:${port}`;
    let processHandle, logs = '';
    const start = async () => {
        processHandle = spawn(process.env.XIAOMEI_TEST_PYTHON || path.join(root,'python/python.exe'), ['-c',`import sys; sys.path.insert(0,${JSON.stringify(root)}); import uvicorn,main; uvicorn.run(main.app,host='127.0.0.1',port=${port},log_level='error')`], {
            cwd:root, windowsHide:true, env:{...process.env,XIAOMEI_CANVAS_PROJECT_ROOT:data,XIAOMEI_CANVAS_DATA_ROOT:data,PYTHONIOENCODING:'utf-8'}
        });
        processHandle.stdout.on('data', chunk => logs=(logs+chunk).slice(-4000));
        processHandle.stderr.on('data', chunk => logs=(logs+chunk).slice(-4000));
        for(let i=0;i<100;i++){
            if(processHandle.exitCode !== null) throw new Error(logs);
            try { if((await fetch(base+'/')).ok) return; } catch(_) {}
            await new Promise(r=>setTimeout(r,100));
        }
        throw new Error('server timeout: '+logs);
    };
    const stop = async () => { if(processHandle?.exitCode === null){ const exited=new Promise(r=>processHandle.once('exit',r)); processHandle.kill(); await exited; } };
    t.after(async()=>{await stop();fs.rmSync(data,{recursive:true,force:true});});
    await start();
    const browser=await chromium.launch({channel:'msedge',headless:true});
    t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1680,height:1050}});
    const errors=[],saves=[]; let failSave=false, failLoad=false, failProviderSave=false;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>d.accept());
    await page.route('**/*',async route=>{
        const request=route.request(), url=new URL(request.url());
        if(url.pathname.startsWith('/api/recommended-apis')){
            if(failSave && request.method()==='POST'){failSave=false;return route.fulfill({status:500,json:{detail:'fixture write failure'}});}
            if(failLoad && request.method()==='GET'){failLoad=false;return route.fulfill({status:503,json:{detail:'fixture read failure'}});}
            return route.continue();
        }
        if(url.pathname==='/api/providers'){
            if(request.method()==='PUT'){
                if(failProviderSave){failProviderSave=false;return route.fulfill({status:500,json:{detail:'fixture provider save failure'}});}
                const items=request.postDataJSON();saves.push(items);
                return route.fulfill({json:{providers:items.map(({api_key,...item})=>({...item,has_key:!!api_key}))}});
            }
            return route.fulfill({json:{providers:[{id:'existing',name:'Existing',base_url:'https://existing.example',protocol:'openai',enabled:true,image_models:['existing-image'],chat_models:[],video_models:[]}]}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        if(url.pathname==='/') return route.continue();
        const file=path.join(root,decodeURIComponent(url.pathname));
        if(file.startsWith(root+path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({path:file});
        return route.fulfill({status:404,body:''});
    });
    await page.goto(base+'/');
    const open=async()=>{
        await page.goto(base+'/');
        await page.goto(base+'/static/api-settings.html');
        await page.waitForSelector('.provider-card');
        await page.locator('.api-link-btn').click();
        await page.waitForFunction(()=>customRecommendationsLoaded && !customRecommendationsLoading);
    };
    await open();
    assert.deepEqual(await page.locator('#recommendPanel .rec-name').allTextContents(),['6789API','Existing']);
    const review=path.join(os.tmpdir(),'xiaomei-recommend-ui-review');fs.mkdirSync(review,{recursive:true});
    await page.screenshot({path:path.join(review,'add-card.png')});
    await page.locator('[data-recommend-key="0"]').fill('unsaved-fixture-key');
    await page.locator('[data-filter="ready"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-filter="ready"]').evaluate(el=>el===document.activeElement),true,'筛选后键盘焦点仍在当前按钮');
    assert.match(await page.locator('.rec-empty').innerText(),/还没有已配置/);
    await page.locator('[data-filter="pending"]').click();
    assert.equal(await page.locator('.rec-row').count(),2,'已有平台缺少 Key 时也属于待配置');
    await page.locator('[data-filter="all"]').click();
    assert.equal(await page.locator('[data-recommend-key="0"]').inputValue(),'unsaved-fixture-key','切换筛选后保留 Key 草稿');
    await page.locator('.recommend-add-card').click();
    const form=page.locator('#recommendationForm'), editor=page.locator('#recommendationEditor');
    await form.locator('[name="name"]').fill('自定义平台');
    await form.locator('[name="base_url"]').fill('https://api.fixture.example/v1');
    await form.locator('[name="register_url"]').fill('https://fixture.example/register?aff=abc');
    await form.locator('[name="summary"]').fill('<img src=x onerror=alert(1)>');
    await page.screenshot({path:path.join(review,'editor.png')});
    failSave=true;
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(()=>!recommendationBusy);
    assert.equal(await editor.isVisible(),true);
    assert.equal(await form.locator('[name="name"]').inputValue(),'自定义平台');
    assert.match(await page.locator('#recommendationError').innerText(),/fixture write failure/);
    await form.locator('[type="submit"]').click();
    await editor.waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-recommend-key="0"]').inputValue(),'unsaved-fixture-key');
    assert.equal(await page.locator('#recommendPanel .rec-name').count(),3);
    assert.equal(await page.locator('#recommendPanel .rec-desc img').count(),0);
    assert.equal(saves.length,0,'添加推荐不应写入实际平台');
    await stop(); await start(); await open();
    assert.equal(await page.locator('#recommendPanel .rec-name').count(),3,'服务重启仍保留推荐');
    const custom=page.locator('#recommendPanel .rec-row').nth(1);
    assert.equal(await custom.locator('a.rec-btn').getAttribute('href'),'https://fixture.example/register?aff=abc');
    await custom.locator('[aria-label="编辑推荐 API"]').click();
    await form.locator('[name="name"]').fill('修改后的平台');
    await form.locator('[name="protocol"]').selectOption('apimart');
    await form.locator('[name="image_request_mode"]').selectOption('openai-video-proxy');
    await form.locator('[name="summary"]').fill('图片与视频模型');
    await form.locator('[type="submit"]').click();await editor.waitFor({state:'hidden'});
    await custom.locator('[data-recommend-key]').fill('fixture-key');
    failProviderSave=true;
    await custom.getByRole('button',{name:'保存',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('fixture provider save failure'));
    assert.equal(await page.evaluate(()=>recommendInlineOpen),true,'保存失败后保留推荐列表以便重试');
    assert.equal(await custom.locator('[data-recommend-key]').inputValue(),'fixture-key','保存失败不丢失输入的 Key');
    assert.equal(await page.evaluate(()=>providers.some(item=>item.name==='修改后的平台')),false,'保存失败不将推荐误报为已配置平台');
    assert.equal(saves.length,0);
    await custom.getByRole('button',{name:'保存',exact:true}).click();
    await page.waitForFunction(()=>!recommendInlineOpen);
    assert.equal(saves.at(-1).find(p=>p.name==='修改后的平台').api_key,'fixture-key');
    assert.equal(saves.at(-1).find(p=>p.name==='修改后的平台').protocol,'apimart');
    assert.deepEqual(saves.at(-1).find(p=>p.id==='existing').image_models,['existing-image']);
    await page.locator('.api-link-btn').click();
    await custom.locator('[aria-label="移除推荐 API"]').click();
    await page.waitForFunction(()=>customRecommendedApis.length===0);
    assert.equal(saves.length,1,'移除推荐不应删除平台 Key');
    await page.evaluate(()=>StudioI18n.set('en'));
    assert.match(await page.locator('.recommend-add-card').innerText(),/Add Recommended API/);
    await page.locator('.recommend-add-card').click();
    await page.setViewportSize({width:480,height:850});
    await page.evaluate(()=>{document.documentElement.classList.add('studio-theme-dark');document.body.classList.add('studio-theme-dark');});
    await page.waitForTimeout(350);
    const contrast = await form.locator('[name="protocol"]').evaluate(el=>{
        const color=getComputedStyle(el);
        const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
        const a=luminance(color.color),b=luminance(color.backgroundColor);
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    assert.ok(contrast>=4.5,'深色主题下选项文字应清晰可读');
    await page.screenshot({path:path.join(review,'narrow-dark.png')});
    const bounds=await page.locator('.recommendation-editor').boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=480);
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=850);
    await page.keyboard.press('Escape');assert.equal(await editor.isVisible(),false);
    failLoad=true;
    await page.reload();await page.waitForSelector('.provider-card');
    await page.waitForFunction(()=>!!customRecommendationsError);
    await page.locator('.recommend-add-card').click();
    await page.waitForFunction(()=>customRecommendationsLoaded && !customRecommendationsError);
    await page.evaluate(()=>{
        StudioI18n.set('zh');
        document.documentElement.classList.remove('studio-theme-dark');
        document.body.classList.remove('studio-theme-dark');
        providers = [
            {id:'api-6789',name:'6789API',base_url:'https://www.6789api.top',protocol:'openai',has_key:true,image_models:['image-a'],chat_models:[],video_models:[]},
            {id:'openrouter',name:'openrouter',base_url:'https://openrouter.example/api/v1',protocol:'openai',has_key:true,image_models:[],chat_models:['chat-a'],video_models:[]},
            {id:'qwen',name:'千问',base_url:'https://qwen.example/v1',protocol:'openai',has_key:false,image_models:[],chat_models:[],video_models:[]},
            {id:'soon',name:'soon',base_url:'https://soon.example/v1',protocol:'openai',has_key:true,image_models:['image-b'],chat_models:['chat-b'],video_models:['video-a']},
            {id:'scnet',name:'超算互联网',base_url:'https://scnet.example/v1',protocol:'openai',has_key:true,enabled:false,image_models:[],chat_models:[],video_models:['video-b']},
            {id:'codex',name:'GPT CLI',base_url:'',protocol:'codex'},
            {id:'gemini-cli',name:'Antigravity CLI',base_url:'',protocol:'gemini-cli'},
            {id:'runninghub',name:'RunningHub',base_url:'https://runninghub.example',protocol:'runninghub'}
        ];
        customRecommendedApis = [{id:'rec-fixture',name:'重复推荐',base_url:'https://soon.example/v1/',protocol:'openai',summary:'自定义说明',kinds:['image']}];
        selectedId = 'api-6789';
        renderEditor();
        openRecommendApi();
    });
    const expected=['6789API','soon','openrouter','千问','超算互联网'];
    assert.deepEqual(await page.locator('#recommendPanel .rec-name').allTextContents(),expected);
    assert.equal(await page.locator('#recommendPanel [data-recommend-key]').count(),0,'已有平台直接管理配置，不要求重填 Key');
    const qwen=page.locator('#recommendPanel .rec-row').filter({has:page.locator('.rec-name',{hasText:'千问'})});
    assert.match(await qwen.innerText(),/未配置 Key/);
    const scnet=page.locator('#recommendPanel .rec-row').filter({has:page.locator('.rec-name',{hasText:'超算互联网'})});
    assert.match(await scnet.innerText(),/已停用/);
    await page.locator('[data-filter="pending"]').click();
    assert.deepEqual(await page.locator('.rec-name').allTextContents(),['千问']);
    await page.locator('[data-filter="ready"]').click();
    assert.equal(await page.locator('.rec-row').count(),4,'已保存 Key 的停用平台保留配置状态，行内仍标明停用');
    await page.locator('[data-filter="all"]').click();
    const soon=page.locator('#recommendPanel .rec-row').filter({has:page.locator('.rec-name',{hasText:'soon'})});
    assert.equal(await soon.locator('[aria-label="编辑推荐 API"]').count(),1,'去重后仍可管理自定义推荐');
    const savedBefore=saves.length;
    const snapshot=await page.evaluate(()=>JSON.stringify(providers.map(({id,name,base_url,protocol,has_key,image_models,chat_models,video_models})=>({id,name,base_url,protocol,has_key,image_models,chat_models,video_models}))));
    const router=page.locator('#recommendPanel .rec-row').filter({has:page.locator('.rec-name',{hasText:'openrouter'})});
    await router.getByRole('button',{name:'openrouter · 管理配置',exact:true}).click();
    assert.equal(await page.evaluate(()=>selectedId),'openrouter');
    assert.equal(await page.locator('#baseInput').inputValue(),'https://openrouter.example/api/v1');
    await page.evaluate(()=>openRecommendApi());
    assert.equal(await page.evaluate(()=>JSON.stringify(providers.map(({id,name,base_url,protocol,has_key,image_models,chat_models,video_models})=>({id,name,base_url,protocol,has_key,image_models,chat_models,video_models})))),snapshot,'展示与跳转不改写现有平台配置');
    assert.equal(saves.length,savedBefore);
    await page.setViewportSize({width:1680,height:1050});
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(review,'existing-providers.png'),fullPage:true});
    assert.deepEqual(errors,[]);
});
