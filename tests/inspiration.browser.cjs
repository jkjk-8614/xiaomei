const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('inspiration filters, opens provenance, saves favorite and applies image prompt without generation', {timeout: 40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {window.appliedCases = [];window.addEventListener('message', event => {if(event.data?.type === 'prompt-case-apply-request') window.appliedCases.push(event.data.case);});});
    let favorite = false;
    let incomplete = false;
    const synced = [];
    const fixture = {
        id:'leaderai:image:abc123',source_id:'leaderai',title:'护肤品主图',kind:'image',model_family:'Nano Banana',
        model_variant:'Nano Banana Pro',task:'商品主图',author:'作者甲',tags:['电商','护肤'],prompt:Array(40).fill('将护肤品放在干净的白色背景中，保留标签细节。').join('\n'),
        workflow:[],preview_url:'',source_url:'https://www.leaderai.top/#/preset-prompt-page',license:'查看原站使用条款',favorite:false,verified:false
    };
    const videoFixture = {...fixture,id:'leaderai:video:vid123',title:'开箱视频',kind:'video',model_family:'Seedance',model_variant:'Seedance 2.0',prompt:'A product reveal on a clean white table.',video_url:'https://example.com/preview.mp4'};
    const freeFixture = {...fixture,id:'youmind_grok:free',source_id:'youmind_grok',title:'Free Chinese Video',title_zh:'免费视频案例',kind:'video',model_family:'Grok Imagine',model_variant:'Grok Imagine',prompt:'The characters face the Architect.',prompt_zh:'角色们面向建筑师。',watch_url:'https://youmind.com/grok-imagine-prompts?id=12348'};
    const skillFixture = {...fixture,id:'moke:91',source_id:'moke',title:'世界观构建 Skill',kind:'skill',model_family:'通用',model_variant:'',prompt:'',workflow:[{step:'用于构建可延展世界观。'}],source_url:'https://www.mokeaigc.com/skills/maker/maker--personal/worldbuilding'};
    let installed = false;
    let installFailure = false;
    let translateFailure = false;
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(__dirname,'..','.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/inspiration/sources') return route.fulfill({json:{sources:[
            {id:'leaderai',name:'LeaderAI',url:'https://www.leaderai.top/#/preset-prompt-page',kind:'案例目录',local_count:1,synced_at:1},
            {id:'minimax_h3',name:'MiniMax H3 官方',url:'https://github.com/MiniMax-AI/MiniMax-H3',kind:'官方案例',local_count:1,synced_at:1},
            {id:'moke',name:'MOKE SkillHub',url:'https://www.mokeaigc.com/skill.html',kind:'Skill 索引',local_count:1,synced_at:1}
        ]}});
        if(url.pathname.startsWith('/api/inspiration/sources/') && url.pathname.endsWith('/sync')){
            const id = url.pathname.split('/')[4];
            synced.push(id);
            return id === 'minimax_h3' ? route.fulfill({status:502,json:{detail:'来源暂时不可用'}}) : route.fulfill({json:{source_id:id,item_count:1}});
        }
        if(url.pathname === '/api/inspiration/cases'){
            const kind = url.searchParams.get('kind');
            const available = [fixture,videoFixture,freeFixture,skillFixture].filter(item => !kind || item.kind === kind);
            const cases = available.filter(item => (!url.searchParams.get('model') || url.searchParams.get('model') === item.model_family)
                && (!url.searchParams.get('favorites') || favorite)).map(item => ({...item,favorite}));
            return route.fulfill({json:{cases,total:cases.length,page:1,limit:36,
                models:available.map(item => ({name:item.model_family,count:1})),tasks:[{name:'商品主图',count:1}]}});
        }
        if(url.pathname === '/api/inspiration/cases/leaderai%3Aimage%3Aabc123' && request.method() === 'GET') return route.fulfill({json:{case:{...fixture,favorite,prompt_incomplete:incomplete}}});
        if(url.pathname === '/api/inspiration/cases/leaderai%3Avideo%3Avid123' && request.method() === 'GET') return route.fulfill({json:{case:videoFixture}});
        if(url.pathname === '/api/inspiration/cases/youmind_grok%3Afree' && request.method() === 'GET') return route.fulfill({json:{case:freeFixture}});
        if(url.pathname === '/api/inspiration/cases/moke%3A91' && request.method() === 'GET') return route.fulfill({json:{case:skillFixture}});
        if(url.pathname === '/api/inspiration/cases/moke%3A91/install-skill' && request.method() === 'POST'){
            if(installFailure) return route.fulfill({status:502,json:{detail:'MOKE 暂时无法下载 Skill'}});
            installed = true;
            return route.fulfill({json:{skill_id:'worldbuilding',imported:[{id:'worldbuilding'}],skipped:[],conflicts:[],errors:[]}});
        }
        if(url.pathname === '/api/agent-skills') return route.fulfill({json:{skills:installed ? [{id:'worldbuilding',name:'世界观构建 Skill',enabled:true}] : []}});
        if(url.pathname === '/api/providers') return route.fulfill({json:{providers:[{id:'configured-provider',enabled:true,has_key:true,image_models:['Nano Banana Pro'],chat_models:['chat-model']}]}});
        if(url.pathname === '/api/canvas-llm'){
            assert.equal(request.postDataJSON().message,videoFixture.prompt);
            if(translateFailure) return route.fulfill({status:502,json:{detail:'聊天模型暂时不可用'}});
            return route.fulfill({json:{text:'产品出现在干净的白色桌面上。'}});
        }
        if(url.pathname.endsWith('/favorite')){favorite = request.postDataJSON().favorite;return route.fulfill({json:{id:fixture.id,favorite}});}
        return route.fulfill({status:404,body:'unmocked request'});
    });
    await page.goto('http://localhost/static/inspiration.html');
    await page.getByRole('button',{name:'Seedance',exact:true}).click();
    await page.getByRole('button',{name:'图片',exact:true}).click();
    await page.getByRole('button',{name:'Seedance',exact:true}).waitFor({state:'detached'});
    await page.getByRole('button',{name:'Nano Banana',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Seedance',exact:true}).count(),0);
    await page.getByRole('button',{name:'视频',exact:true}).click();
    await page.getByRole('button',{name:'Nano Banana',exact:true}).waitFor({state:'detached'});
    await page.getByRole('button',{name:'Seedance',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Nano Banana',exact:true}).count(),0);
    await page.getByRole('button',{name:'Skill',exact:true}).click();
    await page.getByText('世界观构建 Skill',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Seedance',exact:true}).count(),0);
    await page.getByRole('button',{name:'查看 世界观构建 Skill'}).click();
    await page.getByText('Skill 简介',{exact:true}).waitFor();
    assert.match(await page.locator('#detailBody').innerText(),/用于构建可延展世界观。/);
    assert.equal(await page.getByRole('link',{name:'查看原站 Skill ↗'}).getAttribute('href'),skillFixture.source_url);
    await page.getByRole('button',{name:'导入并使用'}).click();
    await page.locator('.skill-install-status').getByText('已在 Skill 管理中安装并使用“世界观构建 Skill”。').waitFor();
    assert.equal(installed,true);
    assert.equal(await page.evaluate(() => localStorage.getItem('xiaomei_agent_skill_selection_v1')),'worldbuilding');
    installFailure = true;
    await page.getByRole('button',{name:'导入并使用'}).click();
    await page.locator('.skill-install-status').getByText('导入失败：MOKE 暂时无法下载 Skill').waitFor();
    assert.equal(await page.getByRole('button',{name:'导入并使用'}).isEnabled(),true);
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.getByRole('button',{name:'图片',exact:true}).click();
    await page.getByRole('button',{name:'Nano Banana',exact:true}).click();
    await assert.doesNotReject(page.getByText('护肤品主图',{exact:true}).first().waitFor());
    if(process.env.INSPIRATION_SCREENSHOT) await page.screenshot({path:process.env.INSPIRATION_SCREENSHOT,fullPage:true});
    await page.getByRole('button',{name:'查看 护肤品主图'}).click();
    await page.getByText('原始提示词',{exact:true}).waitFor();
    assert.match(await page.locator('#detailBody').innerText(), /原始提示词/);
    assert.equal(await page.locator('.detail-section pre').first().textContent(),fixture.prompt);
    assert.equal(await page.locator('.detail-section pre').first().evaluate(node => getComputedStyle(node).maxHeight),'none');
    await page.locator('#detailBody [data-favorite]').click();
    assert.equal(favorite,true);
    await page.locator('#detailBody [data-apply]').click();
    await page.waitForFunction(() => window.appliedCases.length === 1);
    const applied = await page.evaluate(() => window.appliedCases);
    assert.equal(applied.length,1);
    assert.equal(applied[0].prompt.display,fixture.prompt);
    assert.equal(applied[0].settings.model,fixture.model_variant);
    assert.equal(applied[0].settings.provider_id,'configured-provider');
    incomplete = true;
    await page.getByRole('button',{name:'查看 护肤品主图'}).click();
    await page.getByText('提示词预览',{exact:true}).waitFor();
    assert.equal(await page.locator('#detailBody [data-apply], #detailBody [data-copy]').count(),0);
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.getByRole('button',{name:'视频',exact:true}).click();
    await page.getByRole('button',{name:'查看 开箱视频'}).click();
    assert.equal(await page.locator('#detailBody video').getAttribute('src'),videoFixture.video_url);
    await page.getByRole('button',{name:'用聊天模型翻译'}).click();
    await page.getByText('产品出现在干净的白色桌面上。').waitFor();
    assert.equal(await page.locator('#detailBody .detail-section pre').first().textContent(),videoFixture.prompt);
    translateFailure = true;
    await page.getByRole('button',{name:'用聊天模型翻译'}).click();
    await page.getByText('翻译失败：聊天模型暂时不可用').waitFor();
    assert.equal(await page.locator('#detailBody .detail-section pre').first().textContent(),videoFixture.prompt);
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.getByRole('button',{name:'查看 Free Chinese Video'}).click();
    await page.getByText('免费视频案例').waitFor();
    await page.getByText('角色们面向建筑师。').waitFor();
    assert.equal(await page.locator('#detailBody [data-translate]').count(),0);
    assert.equal(await page.getByRole('link',{name:'在原站观看视频 ↗'}).getAttribute('href'),freeFixture.watch_url);
    await page.getByRole('button',{name:'关闭详情'}).click();
    await page.getByRole('button',{name:'同步全部'}).click();
    await page.getByRole('button',{name:'管理来源'}).click();
    await page.waitForFunction(() => document.querySelector('#syncAllStatus')?.textContent?.startsWith('同步完成：'));
    assert.equal(await page.locator('#syncAllStatus').textContent(),'同步完成：2 个成功，1 个失败（MiniMax H3 官方）。');
    assert.deepEqual(synced,['leaderai','minimax_h3','moke']);
    assert.deepEqual(errors,[]);
});
