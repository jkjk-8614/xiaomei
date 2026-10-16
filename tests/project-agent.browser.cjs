const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('project memory, local suggestion and plan draft stay in the existing Agent panel', {timeout:60000}, async t => {
    const browser = await chromium.launch({executablePath:edge, headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    await page.routeWebSocket('**/*', socket => socket.close());
    const errors = [], calls = [];
    let revision = 1, memories = [], suggestion;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'project-agent.test') return route.abort();
        const pathname = url.pathname;
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
        if(pathname === '/api/providers') return route.fulfill({json:{providers:[{id:'test',name:'Test',enabled:true,chat_models:['chat'],image_models:[]}]}});
        if(pathname === '/api/canvas-share/session') return route.fulfill({json:{canvas_id:'a',role:'viewer'}});
        if(pathname === '/api/canvases/a') return route.fulfill({json:{canvas:{id:'a',project:'project_a',title:'Agent test',updated_at:revision,nodes:[],connections:[],logs:[],settings:{engine:'api'}}}});
        if(pathname === '/api/project-agent/projects/project_a/state') return route.fulfill({json:{
            project:{id:'project_a',name:'相框项目'},revision:memories.length,canvas_revision:revision,global_settings:{enabled:true,revision:0},
            memories,settings:{proactive_enabled:true,paused:false,frequency:'standard',allow_model_analysis:false,allow_image_analysis:false,daily_limit:20,provider:'',model:''},
            suggestions:[],analysis_today:{count:0},progress:{stage:'planning',goal:memories.find(m=>m.type==='goal')?.text || '',todos:[],result_count:0,failed_count:0,running_count:0}
        }});
        if(pathname === '/api/project-agent/projects/project_a/memories' && route.request().method() === 'POST'){
            const data = route.request().postDataJSON();
            const memory = {id:'memory-a',project_id:'project_a',type:data.type,text:data.text,status:'confirmed',revision:1,source:{type:'user_confirmation'}};
            memories.push(memory);
            return route.fulfill({json:{memory}});
        }
        if(pathname === '/api/project-agent/analyze'){
            calls.push('analyze');
            const data = route.request().postDataJSON();
            suggestion = {id:'suggestion-a',project_id:'project_a',canvas_id:'a',canvas_revision:data.canvas_revision,status:'ready',trigger:'assets_added',
                suggestion:{title:'画布里有新素材',body:'想做主图、详情页，还是先整理素材？',options:[{key:'main_image',label:'做主图'},{key:'detail_page',label:'做详情页'},{key:'organize_assets',label:'整理素材'}]}};
            return route.fulfill({json:{project_id:'project_a',canvas_id:'a',canvas_revision:data.canvas_revision,suggestion}});
        }
        if(pathname === '/api/project-agent/suggestions/suggestion-a/feedback'){
            calls.push('feedback');
            return route.fulfill({json:{ok:true,action:'accept',draft:'请先规划商品详情页，不要直接执行。',plan_mode:true,project_id:'project_a',canvas_id:'a'}});
        }
        if(pathname.includes('/canvas-plan') || pathname.includes('/canvas-agent-action') || pathname.includes('/generate')) calls.push('execution');
        return route.fulfill({json:{providers:[],skills:[],categories:[],workflows:[],items:[],canvases:[]}});
    });
    await page.goto('http://project-agent.test/static/smart-canvas.html?id=a');
    await page.waitForFunction(() => document.getElementById('projectAgentName').textContent === '相框项目');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#projectAgentOpen').click();
    await page.waitForFunction(() => !!document.querySelector('#projectAgentSettings select[name=provider] option[value=test]'));
    await page.locator('#projectAgentMemoryText').fill('制作相框详情页');
    await page.locator('#projectAgentMemoryForm button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#projectAgentMemoryList')?.textContent.includes('制作相框详情页'));
    assert.equal(memories.length,1);
    if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR){
        fs.mkdirSync(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'project-agent-memory.png')});
    }
    await page.locator('#projectAgentClose').click();
    await page.locator('#canvasAgentClose').click();
    revision = 2;
    await page.evaluate(() => window.ProjectAgent.savedCanvas({id:'a',project:'project_a',updated_at:2,
        nodes:[{id:'node-a',type:'smart-upload',images:[{url:'/assets/a.png'}]}],connections:[]}));
    await page.locator('#projectAgentSuggestion').waitFor({state:'visible',timeout:12000});
    assert.deepEqual(calls,['analyze']);
    for(const skin of ['minimal','dark']){
        await page.evaluate(skin => StudioAppearance.set({skin,accent:'#bb44cc'}),skin);
        assert.equal(await page.locator('#projectAgentSuggestion').isVisible(),true);
        if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR){
            fs.mkdirSync(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,{recursive:true});
            await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'project-agent-'+skin+'.png')});
        }
    }
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(() => StudioScale.set('125'));
    const bounds = await page.locator('#projectAgentSuggestion').evaluate(el => {
        const rect=el.getBoundingClientRect();return {left:rect.left,right:rect.right,bottom:rect.bottom,animation:getComputedStyle(el).animationName};
    });
    assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.bottom <= 844,JSON.stringify(bounds));
    assert.equal(bounds.animation,'none');
    const minimap = await page.locator('#minimap').boundingBox();
    assert.ok(bounds.bottom + 8 <= minimap.y, 'suggestion should remain above the canvas navigator');
    if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR) await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'project-agent-narrow.png')});
    await page.locator('#projectAgentSuggestion button').filter({hasText:'做详情页'}).click();
    await page.waitForFunction(() => document.getElementById('canvasAgentInput').value.includes('商品详情页'));
    assert.equal(await page.locator('#canvasAgentPlanMode').isChecked(),true);
    await page.locator('#projectAgentOpen').click();
    const drawerBounds = await page.locator('#projectAgentDrawer').boundingBox();
    assert.ok(drawerBounds.x >= 0 && drawerBounds.x + drawerBounds.width <= 390, JSON.stringify(drawerBounds));
    if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR) await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'project-agent-memory-narrow.png')});
    assert.equal(calls.includes('execution'),false);
    const unrelated=errors.filter(message => message.includes("reading 'offsetWidth'"));
    assert.deepEqual(errors.filter(message => !unrelated.includes(message)),[]);
});

test('a late suggestion from project A is discarded after switching to project B', {timeout:30000}, async t => {
    const browser = await chromium.launch({executablePath:edge,headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1200,height:800}});
    await page.routeWebSocket('**/*', socket => socket.close());
    let releaseAnalysis, analysisStarted;
    const started = new Promise(resolve => {analysisStarted=resolve;});
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'project-agent-switch.test') return route.abort();
        const pathname=url.pathname;
        if(pathname.startsWith('/static/')){
            let file=path.resolve(root,'.'+decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file=path.resolve(root,'ComfyUI/web',pathname.slice('/static/'.length));
            return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(pathname==='/api/config') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
        if(pathname==='/api/canvas-share/session') return route.fulfill({json:{canvas_id:'a',role:'viewer'}});
        if(pathname==='/api/canvases/a') return route.fulfill({json:{canvas:{id:'a',project:'project_a',title:'A',updated_at:1,nodes:[],connections:[],logs:[],settings:{engine:'api'}}}});
        if(pathname.startsWith('/api/project-agent/projects/') && pathname.endsWith('/state')){
            const b=pathname.includes('/project_b/');
            return route.fulfill({json:{project:{id:b?'project_b':'project_a',name:b?'项目 B':'项目 A'},
                revision:0,canvas_revision:b?1:2,global_settings:{enabled:true,revision:0},memories:[],suggestions:[],
                settings:{proactive_enabled:true,paused:false,frequency:'standard',allow_model_analysis:false},
                progress:{stage:'new',goal:'',todos:[],result_count:0,failed_count:0,running_count:0}}});
        }
        if(pathname==='/api/project-agent/analyze'){
            analysisStarted();
            await new Promise(resolve => {releaseAnalysis=resolve;});
            try{return await route.fulfill({json:{project_id:'project_a',canvas_id:'a',canvas_revision:2,
                suggestion:{id:'old-a',canvas_id:'a',canvas_revision:2,status:'ready',suggestion:{title:'A 的建议',body:'旧内容',options:[]}}}});}
            catch{return;}
        }
        return route.fulfill({json:{providers:[],skills:[],categories:[],workflows:[],items:[],canvases:[]}});
    });
    await page.goto('http://project-agent-switch.test/static/smart-canvas.html?id=a');
    await page.waitForFunction(() => document.getElementById('projectAgentName').textContent === '项目 A');
    await page.evaluate(() => window.ProjectAgent.savedCanvas({id:'a',project:'project_a',updated_at:2,
        nodes:[{id:'photo-a',type:'smart-upload',images:[{url:'/assets/a.png'}]}],connections:[]}));
    await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('analysis did not start')),8000))]);
    await page.evaluate(() => window.ProjectAgent.openCanvas({id:'b',project:'project_b',updated_at:1,nodes:[],connections:[]}));
    releaseAnalysis();
    await page.waitForFunction(() => document.getElementById('projectAgentName').textContent === '项目 B');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#projectAgentSuggestion').isVisible(),false);
});


test('project settings show clear on/off choices and preserve saved values', {timeout:60000}, async t => {
    const browser = await chromium.launch({executablePath:edge,headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    await page.routeWebSocket('**/*', socket => socket.close());
    const projectSaves = [], globalSaves = [], errors = [];
    let revision = 1, global = {enabled:true,revision:0};
    let settings = {proactive_enabled:true,paused:true,frequency:'standard',allow_model_analysis:false,
        allow_image_analysis:false,daily_limit:20,provider:'',model:''};
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => {assert.match(dialog.message(), /可能产生 API 费用/); void dialog.accept();});
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'project-agent-settings.test') return route.abort();
        const pathname = url.pathname;
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
        if(pathname === '/api/providers') return route.fulfill({json:{providers:[{id:'test',name:'测试平台',enabled:true,chat_models:['chat']}]}});
        if(pathname === '/api/canvas-share/session') return route.fulfill({json:{canvas_id:'a',role:'viewer'}});
        if(pathname === '/api/canvases/a') return route.fulfill({json:{canvas:{id:'a',project:'project_a',title:'设置测试',updated_at:1,nodes:[],connections:[],logs:[],settings:{engine:'api'}}}});
        if(pathname === '/api/project-agent/projects/project_a/state') return route.fulfill({json:{
            project:{id:'project_a',name:'相框项目'},revision,canvas_revision:1,global_settings:global,
            memories:[],settings,suggestions:[],analysis_today:{count:0},
            progress:{stage:'new',goal:'',todos:[],result_count:0,failed_count:0,running_count:0}
        }});
        if(pathname === '/api/project-agent/settings'){
            if(route.request().method() === 'PUT'){
                const data = route.request().postDataJSON();
                assert.equal(data.expected_revision,global.revision);
                globalSaves.push(data.enabled);
                global = {enabled:data.enabled,revision:global.revision+1};
            }
            return route.fulfill({json:global});
        }
        if(pathname === '/api/project-agent/projects/project_a/settings' && route.request().method() === 'PUT'){
            const data = route.request().postDataJSON();
            assert.equal(data.expected_revision,revision);
            projectSaves.push(data);
            settings = {...settings,...data};
            delete settings.expected_revision; delete settings.consent;
            revision += 1;
            return route.fulfill({json:{revision,settings}});
        }
        return route.fulfill({json:{providers:[],skills:[],categories:[],workflows:[],items:[],canvases:[]}});
    });
    await page.goto('http://project-agent-settings.test/static/smart-canvas.html?id=a');
    await page.waitForFunction(() => document.getElementById('projectAgentName').textContent === '相框项目');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#projectAgentOpen').click();
    await page.waitForFunction(() => !!document.querySelector('#projectAgentSettings select[name=provider] option[value=test]'));
    assert.equal(await page.locator('input[name=proactive_enabled][value=off]').isChecked(),true);
    assert.equal(await page.locator('.project-agent-model-options').isHidden(),true);
    await page.locator('input[name=global_enabled][value=off]').check();
    await page.waitForFunction(() => document.querySelector('#projectAgentSettings')?.textContent.includes('所有项目已关闭'));
    await page.locator('input[name=global_enabled][value=on]').check();
    await page.waitForFunction(() => document.querySelector('#projectAgentSettings')?.textContent.includes('只影响当前项目'));
    assert.deepEqual(globalSaves,[false,true]);
    await page.locator('input[name=proactive_enabled][value=on]').check();
    await page.locator('input[name=allow_model_analysis][value=on]').check();
    await page.locator('select[name=provider]').selectOption('test');
    await page.locator('select[name=model]').selectOption('chat');
    await page.locator('input[name=allow_image_analysis][value=on]').check();
    await page.locator('input[name=daily_limit]').fill('5');
    if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR){
        fs.mkdirSync(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'settings-light.png')});
    }
    await page.locator('.project-agent-save').click();
    await page.waitForFunction(() => document.querySelector('#projectAgentSettings form')?.dataset.dirty !== '1');
    assert.equal(projectSaves.length,1);
    assert.equal(projectSaves[0].proactive_enabled,true);
    assert.equal(projectSaves[0].paused,false);
    assert.equal(projectSaves[0].allow_model_analysis,true);
    assert.equal(projectSaves[0].allow_image_analysis,true);
    assert.equal(projectSaves[0].consent,true);
    await page.evaluate(() => StudioAppearance.set({skin:'dark',accent:'#bb44cc'}));
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(() => StudioScale.set('125'));
    const bounds = await page.locator('#projectAgentSettings .project-agent-setting-section').evaluateAll(items => items.map(item => {
        const rect=item.getBoundingClientRect(); return {left:rect.left,right:rect.right};
    }));
    assert.ok(bounds.every(box => box.left >= 0 && box.right <= 390),JSON.stringify(bounds));
    if(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR){
        await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'settings-dark-narrow.png')});
        await page.locator('.project-agent-save').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.XIAOMEI_PROJECT_AGENT_QA_DIR,'settings-dark-narrow-bottom.png')});
    }
    await page.locator('input[name=proactive_enabled][value=off]').check();
    await page.locator('input[name=allow_model_analysis][value=off]').check();
    assert.equal(await page.locator('.project-agent-model-options').isHidden(),true);
    await page.locator('.project-agent-save').click();
    await page.waitForFunction(() => document.querySelector('#projectAgentSettings form')?.dataset.dirty !== '1');
    assert.equal(projectSaves.length,2);
    assert.equal(projectSaves[1].proactive_enabled,false);
    assert.equal(projectSaves[1].allow_model_analysis,false);
    assert.equal(projectSaves[1].allow_image_analysis,false);
    assert.equal(projectSaves[1].provider,'test');
    assert.equal(projectSaves[1].model,'chat');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('projectAgentName').textContent === '相框项目');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#projectAgentOpen').click();
    assert.equal(await page.locator('input[name=proactive_enabled][value=off]').isChecked(),true);
    assert.equal(await page.locator('input[name=allow_model_analysis][value=off]').isChecked(),true);
    assert.deepEqual(errors.filter(message => !message.includes("reading 'offsetWidth'")),[]);
});
