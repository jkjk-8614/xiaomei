const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const provider = {id:'scnet-fixture', name:'超算互联网', base_url:'https://api.scnet.cn/api/llm/v1',
    protocol:'openai', enabled:true, primary:true, key_configured:true,
    image_models:[], chat_models:['chat-a'], video_models:['Seedance2.0']};
const note = '视频模型由官方文档动态补充，当前 Key 的调用权限以生成接口返回为准。';
const videoModels = ['HappyHorse-1.0-T2V','MiniMax-H3','Seedance2.0','Seedance2.5','Wan2.7-T2V'];

async function open(t, pagePath){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:920}});
    const calls = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'scnet.test') return route.abort();
        const pathname = url.pathname;
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404});
        }
        if(pathname === '/api/providers/fetch-models') return route.fulfill({json:{
            total:6, all:['chat-a',...videoModels], chat_models:['chat-a'], image_models:[],
            video_models:videoModels, message:note}});
        if(pathname === '/api/providers'){
            if(request.method() === 'PUT') calls.push({path:pathname, body:request.postDataJSON()});
            return route.fulfill({json:{ok:true,providers:[provider]}});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[provider],comfy_instances:[]}});
        if(pathname === '/api/canvases/scnet') return route.fulfill({json:{canvas:{id:'scnet', title:'SCNet test',
            nodes:[], connections:[], logs:[], settings:{engine:'api',apiKind:'video',videoProvider:provider.id,videoModel:'Seedance2.0'}}}});
        if(pathname === '/api/canvas-video'){
            calls.push({path:pathname, body:request.postDataJSON()});
            return route.fulfill({json:{videos:['/output/scnet.mp4']}});
        }
        if(pathname === '/api/provider-icon') return route.fulfill({status:404});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
    });
    await page.goto('http://scnet.test' + pagePath);
    return {page,calls};
}

test('SCNet model picker shows dynamically fetched video and its source', {timeout:60000}, async t => {
    const {page,calls} = await open(t, '/static/api-settings.html');
    await page.waitForSelector('.provider-card');
    await page.evaluate(async id => { selectProvider(id); await fetchModels(); }, provider.id);
    await page.locator('.picker-cat-tab[data-cat="video"]').click();
    assert.match(await page.locator('#pickerList').innerText(), /Seedance2\.0/);
    assert.equal(await page.locator('#pickerSourceNote').innerText(), note);
    assert.equal(await page.locator('.picker-cat-tab[data-cat="video"] .cat-count').innerText(), '1/5');
    for(const model of videoModels) assert.ok((await page.locator('#pickerList').innerText()).includes(model));
    await page.evaluate(() => applyModelPicker());
    assert.ok(calls.some(call => call.path === '/api/providers'));
});

test('SCNet video settings constrain output and permit multimodal inputs', {timeout:60000}, async t => {
    const {page,calls} = await open(t, '/static/smart-canvas.html?id=scnet');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'scnet');
    const snapshot = await page.evaluate(id => {
        settings.videoProvider=id;
        settings.videoModel='Seedance2.0';
        settings.videoDuration=30;
        settings.videoResolution='4k';
        settings.videoAspect='1:1';
        settings.videoMode='omni';
        settings.videoMultimodal=true;
        renderApiVideoParams();
        const values = key => [...dynamicParams.querySelectorAll(`[data-smart-param="${key}"]`)].map(node => node.dataset.smartValue);
        return {duration:values('videoDuration'), aspect:values('videoAspect'), resolution:values('videoResolution'),
            limits:referenceMediaLimits(settings,'node-video'), settings:{duration:settings.videoDuration,resolution:settings.videoResolution}};
    },provider.id);
    assert.deepEqual(snapshot.duration, Array.from({length:12},(_,index) => String(index+4)));
    assert.deepEqual(snapshot.aspect,['adaptive','16:9','9:16']);
    assert.deepEqual(snapshot.resolution,['480p','720p','1080p']);
    assert.equal(snapshot.settings.duration,4);
    assert.equal(snapshot.settings.resolution,'720p');
    assert.equal(snapshot.limits.video,3);
    assert.equal(snapshot.limits.audio,3);
    assert.equal(await page.locator('[data-toggle-param="videoEnhancePrompt"]').count(),0);
    assert.equal(await page.locator('[data-toggle-param="videoEnableUpsample"]').count(),0);
    const limits = await page.evaluate(() => [
        referenceMediaLimits({...settings,videoMultimodal:false},'node-video').image,
        referenceMediaLimits({...settings,videoMultimodal:false,videoUseFrameRoles:true},'node-video').image
    ]);
    assert.deepEqual(limits,[1,2]);
    await page.evaluate(async () => runApiVideoGeneration('Product turning',[],settings));
    const request=calls.find(call => call.path === '/api/canvas-video').body;
    assert.equal(request.provider_id,provider.id);
    assert.equal(request.model,'Seedance2.0');
    assert.equal(request.multimodal,true);
    const otherModels = await page.evaluate(() => ['MiniMax-H3','HappyHorse-1.0-T2V','Wan2.7-T2V','Seedance2.5'].map(model => {
        apiProviders.find(p=>p.id===settings.videoProvider).video_models.push(model);
        settings.videoModel=model;
        renderApiVideoParams();
        return {model, options:scnetVideoOptions(model), limits:referenceMediaLimits(settings,'node-video'),
            rendered:[...dynamicParams.querySelectorAll('[data-smart-param="videoResolution"]')].map(n=>n.dataset.smartValue)};
    }));
    assert.deepEqual(otherModels[0].rendered,['768p','2k']);
    assert.deepEqual(otherModels[1].rendered,['720p','1080p']);
    assert.equal(otherModels[1].limits.image,0);
    assert.equal(otherModels[2].limits.video,0);
    assert.equal(otherModels[3].options.durations.at(-1),30);
});

test('MiniMax H3 parameters match the model and persist through submission', {timeout:60000}, async t => {
    const {page,calls} = await open(t, '/static/smart-canvas.html?id=scnet');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'scnet');
    await page.evaluate(() => {
        apiProviders[0].video_models.push('MiniMax-H3');
        const node = createVideoNodeAt({x:600,y:300},{skipUndo:true});
        selectedId = node.id;
        selectedIds = [];
        node.runSettings = {...settings,engine:'api',apiKind:'video',videoProvider:apiProviders[0].id,
            videoModel:'MiniMax-H3',videoMode:'text',videoDuration:30,videoResolution:'4k',videoAspect:'9:21'};
        lastComposerNodeId = '';
        updateComposer();
    });
    const panel = page.locator('.minimax-h3-settings');
    await page.locator('.video-generation-settings-trigger').click();
    assert.deepEqual(await panel.locator('[data-video-mode]').evaluateAll(elements=>elements.map(el=>el.dataset.videoMode)),['omni','frames']);
    assert.deepEqual(await panel.locator('[data-smart-param="videoAspect"]').evaluateAll(elements=>elements.map(el=>el.dataset.smartValue)),['adaptive','16:9','4:3','1:1','3:4','9:16','21:9']);
    assert.deepEqual(await panel.locator('[data-smart-param="videoResolution"]').allTextContents(),['768P','2K']);
    assert.equal(await panel.locator('[data-video-duration-range]').getAttribute('min'),'4');
    assert.equal(await panel.locator('[data-video-duration-range]').getAttribute('max'),'15');
    assert.equal(await panel.locator('[data-video-duration-value]').textContent(),'15');
    assert.equal(await panel.getByRole('button',{name:'延长一秒'}).isDisabled(),true);
    assert.match(await panel.locator('.video-audio-unavailable').textContent(),/当前平台不支持切换/);
    await panel.locator('[data-smart-param="videoResolution"][data-smart-value="2k"]').click();
    await panel.locator('[data-smart-param="videoAspect"][data-smart-value="16:9"]').click();
    await panel.getByRole('button',{name:'缩短一秒'}).click();
    assert.equal(await panel.locator('[data-video-duration-value]').textContent(),'14');
    await panel.locator('[data-video-duration-range]').fill('4');
    assert.equal(await panel.getByRole('button',{name:'缩短一秒'}).isDisabled(),true);
    await panel.getByRole('button',{name:'延长一秒'}).click();
    assert.equal(await panel.locator('[data-video-duration-value]').textContent(),'5');
    await panel.locator('[data-video-mode="frames"]').click();
    const stored = await page.evaluate(() => activeComposerNode().runSettings);
    assert.equal(stored.videoMode,'frames');
    assert.equal(stored.videoUseFrameRoles,true);
    assert.equal(stored.videoMultimodal,false);
    assert.equal(stored.videoResolution,'2k');
    assert.equal(stored.videoDuration,5);
    await page.evaluate(async () => runApiVideoGeneration('Product turning',[
        {url:'https://media.example/first.png',kind:'image'},
        {url:'https://media.example/last.png',kind:'image'}],settings));
    const frameRequest = calls.find(call=>call.path === '/api/canvas-video').body;
    assert.deepEqual(frameRequest.images.map(image=>image.role),['first_frame','last_frame']);
    assert.equal(frameRequest.multimodal,false);
    assert.equal(frameRequest.duration,5);
    assert.equal(frameRequest.resolution,'2k');
    await panel.locator('[data-video-mode="omni"]').click();
    await page.evaluate(async () => runApiVideoGeneration('Product turning',[
        {url:'https://media.example/reference.png',kind:'image'},
        {url:'https://media.example/reference.mp4',kind:'video'},
        {url:'https://media.example/reference.mp3',kind:'audio'}],settings));
    const omniRequest = calls.filter(call=>call.path === '/api/canvas-video').at(-1).body;
    assert.equal(omniRequest.multimodal,true);
    assert.equal(omniRequest.images[0].role,undefined);
    assert.deepEqual(omniRequest.videos,['https://media.example/reference.mp4']);
    assert.deepEqual(omniRequest.audios,['https://media.example/reference.mp3']);
    await page.evaluate(() => {
        apiProviders.push({id:'gateway-fixture',enabled:true,protocol:'openai',base_url:'https://gateway.example/v1',video_models:['minimax-h3-2k','veo3-fast']});
        settings.videoProvider='gateway-fixture';
        settings.videoModel='minimax-h3-2k';
        settings.videoGenerateAudio=false;
        renderDynamicParams();
    });
    await panel.getByRole('switch',{name:'声音'}).click();
    assert.equal(await panel.getByRole('switch',{name:'声音'}).getAttribute('aria-checked'),'true');
    await page.evaluate(async () => runApiVideoGeneration('Sound on',[],settings));
    await panel.getByRole('switch',{name:'声音'}).click();
    assert.equal(await page.evaluate(() => activeComposerNode().runSettings.videoGenerateAudio),false);
    await page.evaluate(async () => runApiVideoGeneration('Sound off',[],settings));
    const audioRequests = calls.filter(call=>call.path === '/api/canvas-video').slice(-2).map(call=>call.body.generate_audio);
    assert.deepEqual(audioRequests,[true,false]);
    await panel.locator('[data-smart-param="videoAspect"][data-smart-value="16:9"]').click();
    await panel.locator('[data-video-duration-range]').fill('15');
    const track = await panel.locator('[data-video-duration-range]').evaluate(el=>({background:getComputedStyle(el).backgroundColor,panel:getComputedStyle(el.closest('.smart-popover')).backgroundColor}));
    assert.notEqual(track.background,track.panel,'focused slider track remains visible');
    await panel.getByRole('switch',{name:'声音'}).click();
    const panelRect = await panel.boundingBox();
    assert.ok(panelRect.y >= 0 && panelRect.y + panelRect.height <= 920,'parameter panel stays inside viewport');
    assert.equal(await panel.evaluate(el=>el.scrollWidth > el.clientWidth),false);
    const screenshot = path.join(require('node:os').tmpdir(),'xiaomei-minimax-h3-parameters.png');
    await panel.screenshot({path:screenshot});
    console.log('MiniMax H3 preview: ' + screenshot);
    await page.evaluate(() => { setDynamicSetting('videoModel','veo3-fast'); });
    assert.equal(await panel.count(),0);
    assert.equal(await page.locator('[data-video-duration-range]').getAttribute('max'),'60');
});
