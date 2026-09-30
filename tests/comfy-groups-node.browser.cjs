const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const id = 'a'.repeat(32), childId = 'b'.repeat(32);
    const groups = [{id:'1',title:'Z-image t2i 文生图'}, {id:'2',title:'Z-image i2i 图生图'}, {id:'3',title:'图像对比'}];
    const fields = [{id:'6:text',node:'6',input:'text',name:'提示词',type:'textarea',default:'柔和自然光下的商品摄影'},
      ...['width','height','seed','steps','cfg','denoise'].map((input,i) => ({id:'70:'+input,node:'70',input,name:['宽度','高度','随机种子','步数','提示词强度','重绘强度'][i],type:'number',advanced:true,default:[1280,1920,0,8,1,1][i]}))];
    const preset = {id:'3:settings_preset',node:'3',input:'settings',name:'增强档位',type:'dropdown',
      default:'原工作流默认',options:['原工作流默认','低','中','高'],
      preset_links:{低:['30',0],中:['24',0],高:['31',0]},preset_controls:[
        {input:'upscaling_mode',name:'upscaling_mode',type:'dropdown',options:['1x (DLAA / native)','1.5x (Quality)','1.724x (Balanced)','2x (Performance)','3x (Ultra Performance)'],defaults:{低:'1x (DLAA / native)',中:'1x (DLAA / native)',高:'1x (DLAA / native)'}},
        {input:'nr_preset',name:'nr_preset',type:'dropdown',options:['Default','Preset #1','Preset #2','Preset #3'],defaults:{低:'Default',中:'Default',高:'Default'}},
        {input:'nr_style',name:'nr_style',type:'dropdown',options:['Default','Natural','Cinematic'],defaults:{低:'Natural',中:'Default',高:'Cinematic'}},
        {input:'nr_intensity',name:'nr_intensity',type:'number',min:0,max:2,step:0.01,defaults:{低:0.5,中:0.8,高:1}},
        {input:'local_tone_strength',name:'local_tone_strength',type:'number',min:0,max:2,step:0.01,defaults:{低:0.8,中:1,高:1.5}},
        {input:'local_structure_strength',name:'local_structure_strength',type:'number',min:0,max:2,step:0.01,defaults:{低:1.2,中:1.5,高:1.8}},
        {input:'skin_structure_strength',name:'skin_structure_strength',type:'number',min:-1,max:2,step:0.01,defaults:{低:0.8,中:1.5,高:1.8}},
        {input:'automatic_mask',name:'automatic_mask',type:'boolean',defaults:{低:true,中:true,高:true}},
        {input:'dlss_model_preset',name:'dlss_model_preset',type:'dropdown',options:['Default','J','K','L','M'],defaults:{低:'K',中:'L',高:'M'}},
        {input:'motion',name:'motion',type:'dropdown',options:['auto','optical_flow','none'],advanced:true,defaults:{低:'auto',中:'auto',高:'auto'}},
        {input:'scene_change_threshold',name:'scene_change_threshold',type:'number',min:0.01,max:1,step:0.01,advanced:true,defaults:{低:0.24,中:0.24,高:0.24}},
        {input:'warmup_frames',name:'warmup_frames',type:'number',min:0,max:16,step:1,advanced:true,defaults:{低:0,中:0,高:0}},
        {input:'runtime_dir',name:'runtime_dir',type:'text',advanced:true,defaults:{低:'',中:'',高:''}},
      ]};
    const item = {id,title:'Z-image 文生图 / 图生图',description:'本地工作流',entry_type:'app',workflow:'custom/test.json',
      api:{},fields,workflow_groups:groups,state:'ready',workflow_status:'ready',readiness:{can_run:true},tasks:[]};
    const child = {...item,id:childId,group_parent:id,workflow_groups:[groups[1]],selected_group:'2',title:'Z-image · 图生图',fields:[{id:'48:image',node:'48',input:'image',type:'image',name:'上传原图'},preset,...fields]};
    const orphan = {...child,id:'c'.repeat(32),group_parent:'d'.repeat(32),title:'独立保留的分组'};
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = decodeURIComponent(url.pathname);
      if (url.hostname !== 'xiaomei-fixture.test') return route.abort();
      if (p.startsWith('/static/')) {
        let file = path.join(root, decodeURIComponent(p));
        if (!fs.existsSync(file)) file = path.join(root,'ComfyUI/web',p.slice(8));
        return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
      }
      requests.push(p);
      let json = {items:[],workflows:[],skills:[],categories:[],cases:[],libraries:[],batches:[]};
      if (p.endsWith('/catalog')) json = {entries:[item,child,orphan]};
      else if (p === '/api/workflows/custom/test.json') json = {config:{title:child.title,fields:child.fields}};
      else if (p.endsWith('/groups/2/enable') || p.endsWith('/'+childId)) json = child;
      else if (p.endsWith('/'+id)) json = item;
      else if (p.endsWith('/preparation')) json = {models:[],preflight:{status:'pass',hardware:{},dependencies:{manual:[],auto_installable:[]}}};
      else if (p === '/api/config') json = {api_providers:[],comfy_instances:[]};
      else if (p === '/api/canvases/fixture') json = {canvas:{id:'fixture',title:'Test canvas',nodes:[],connections:[],logs:[],settings:{engine:'comfy',comfyMode:'custom'}}};
      else if (p.endsWith('/models')) json = {models:[],summary:{}};
      else if (p.endsWith('/status')) json = {instances:[]};
      return route.fulfill({json});
    });
    await page.goto('http://xiaomei-fixture.test/static/comfyui.html');
    await page.locator('.app-group-choice').first().waitFor();
    assert.equal(await page.locator('.app-group-choice').count(),3);
    assert.equal(await page.locator('.app-card').count(),2);
    assert.equal(await page.locator('.app-card').filter({hasText:child.title}).count(),0);
    assert.equal(await page.locator('.app-card').filter({hasText:orphan.title}).count(),1);
    await page.getByRole('button',{name:groups[1].title,exact:true}).click();
    await page.locator('#app-detail input[type=file]').waitFor();
    assert.deepEqual(await page.locator('select[id="app-field-3:settings_preset"] option').allTextContents(),
      ['原工作流默认','低','中','高']);
    assert.equal(await page.locator('.app-group-choice.active').innerText(),groups[1].title);
    assert.equal(await page.locator('.app-group-choice').count(),3);
    assert.equal(await page.locator('.app-card.selected').getAttribute('data-key'),id);
    await page.reload();
    await page.locator('.app-group-choice').first().waitFor();
    assert.equal(await page.locator('.app-card').count(),2);
    assert.equal(await page.locator('.app-card.selected').getAttribute('data-key'),id);
    assert(requests.some(p=>p.endsWith('/groups/2/enable')));
    await page.screenshot({path:path.join(root,'logs/comfy-groups-preview.png'),fullPage:true});

    await page.goto('http://xiaomei-fixture.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(()=>document.getElementById('smartTitle').textContent==='Test canvas');
    await page.evaluate(async ({fields})=>{
      const imageFields = [{id:'48:image',node:'48',input:'image',name:'上传原图',type:'image'},...fields];
      nodes = [{id:'source-image',type:'smart-image',x:20,y:100,w:180,h:180,
          images:[{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',name:'原图.png'}]},
        {id:'comfy-test',type:SMART_COMFY_WORKFLOW_NODE_TYPE,x:260,y:100,w:390,h:620,
        images:[],workflowRef:'custom/test.json',workflowTitle:'Z-image 文生图',workflowFields:imageFields,
        workflowStatus:'ready',workflowReadiness:{can_run:true},runSettings:{engine:'comfy',comfyMode:'custom',comfyWorkflow:'custom/test.json',comfyParams:{}}}];
      canvas.connections = [{from:'source-image',to:'comfy-test',kind:'input'}];
      canvasUsesConnections = true;
      selectedId='comfy-test'; selectedIds=[];
      viewport={x:0,y:0,scale:1}; render(); applyViewport(); syncRunButtonState();
      await loadConfig();
      window.testRuns=0;
      runGeneration=async()=>{window.testRuns++; await new Promise(resolve=>window.finishTestRun=resolve);};
    },{fields});
    const run = page.locator('[data-comfy-node-run]');
    await run.waitFor();
    const linkedMedia = page.locator('.comfy-node-media-slot.has-media');
    await linkedMedia.waitFor();
    assert.equal(await linkedMedia.locator('img').count(),1);
    assert.equal(await linkedMedia.locator('.comfy-node-media-copy strong').innerText(),'已连接');
    assert.equal(await linkedMedia.locator('.comfy-node-media-copy small').innerText(),'原图.png');
    const presetSelect = page.locator('[data-comfy-node-param="3:settings_preset"]');
    await presetSelect.waitFor();
    assert.deepEqual(await presetSelect.locator('option').allTextContents(),['原工作流默认','低','中','高']);
    await presetSelect.selectOption('中');
    assert.deepEqual(await page.evaluate(()=>{
      const node=nodes.find(item=>item.id==='comfy-test');
      return comfyParamsFromWorkflowValues({fields:node.workflowFields},node.runSettings.comfyParams)['3'];
    }),{settings:['24',0]});
    const mediumIntensity = page.locator('[data-comfy-node-param="3:settings_preset:中:nr_intensity"]');
    await mediumIntensity.waitFor();
    assert.equal(await mediumIntensity.inputValue(),'0.8');
    await presetSelect.selectOption('高');
    const highIntensity = page.locator('[data-comfy-node-param="3:settings_preset:高:nr_intensity"]');
    assert.equal(await highIntensity.inputValue(),'1');
    assert.deepEqual(await page.locator('.comfy-node-preset-section .comfy-node-field-label > span').allTextContents(),[
      '放大模式','神经渲染预设','神经渲染风格','神经渲染强度','局部色调强度','局部结构强度','皮肤结构强度',
      '自动遮罩','DLSS 模型预设','运动处理','场景切换阈值','预热帧数','运行目录'
    ]);
    assert.deepEqual(await page.locator('[data-comfy-node-param="3:settings_preset:高:upscaling_mode"] option').allTextContents(),
      ['1 倍（原尺寸 / DLAA）','1.5 倍（画质优先）','1.724 倍（均衡）','2 倍（性能优先）','3 倍（极致性能）']);
    assert.deepEqual(await page.locator('[data-comfy-node-param="3:settings_preset:高:nr_preset"] option').allTextContents(),
      ['默认','预设 1','预设 2','预设 3']);
    assert.deepEqual(await page.locator('[data-comfy-node-param="3:settings_preset:高:nr_style"] option').allTextContents(),['默认','自然','电影感']);
    assert.deepEqual(await page.locator('[data-comfy-node-param="3:settings_preset:高:dlss_model_preset"] option').allTextContents(),
      ['默认','预设 J','预设 K','预设 L','预设 M']);
    assert.deepEqual(await page.locator('[data-comfy-node-param="3:settings_preset:高:motion"] option').allTextContents(),['自动','光流','无']);
    assert.equal(await page.locator('[data-comfy-node-param="3:settings_preset:高:nr_style"] option:checked').getAttribute('value'),'Cinematic');
    await highIntensity.fill('1.25');
    assert.deepEqual(await page.evaluate(()=>{
      const node=nodes.find(item=>item.id==='comfy-test');
      const params=comfyParamsFromWorkflowValues({fields:node.workflowFields},node.runSettings.comfyParams,node.runSettings.comfyParams);
      return {'3':params['3'],'31':params['31']};
    }),{'3':{settings:['31',0]},'31':{nr_intensity:1.25}});
    await presetSelect.selectOption('低');
    assert.equal(await page.locator('[data-comfy-node-param="3:settings_preset:低:nr_intensity"]').inputValue(),'0.5');
    await presetSelect.selectOption('高');
    assert.equal(await highIntensity.inputValue(),'1.25');
    assert.equal(await page.locator('.comfy-node-preset-section [data-comfy-node-param],.comfy-node-preset-section [data-comfy-node-bool]').count(),13);
    assert(await page.locator('.comfy-node-fields').evaluate(el=>el.scrollHeight > el.clientHeight));
    const paramScroller = page.locator('.comfy-node-fields');
    await paramScroller.hover();
    await paramScroller.evaluate(el => { el.scrollTop = 0; });
    await page.mouse.wheel(0,350);
    await page.waitForFunction(() => document.querySelector('.comfy-node-fields').scrollTop > 0);
    const scrollBeforeRender = await paramScroller.evaluate(el => el.scrollTop);
    assert(scrollBeforeRender > 0);
    await page.evaluate(() => render());
    assert.equal(await paramScroller.evaluate(el => el.scrollTop),scrollBeforeRender);
    await page.locator('[data-comfy-node-param="3:settings_preset:高:runtime_dir"]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-comfy-node-param="70:cfg"]').getAttribute('type'),'number');
    assert(await page.locator('#runBtn').isHidden());
    assert(await page.locator('.composer').isHidden());
    const widthField = await page.locator('[data-comfy-node-param="70:width"]').boundingBox();
    const heightField = await page.locator('[data-comfy-node-param="70:height"]').boundingBox();
    assert.equal(widthField.y,heightField.y);
    assert(heightField.x > widthField.x);
    const card = await page.locator('.comfy-workflow-node-card').boundingBox(), button = await run.boundingBox();
    assert(button.y >= card.y && button.y+button.height <= card.y+card.height);
    await page.screenshot({path:path.join(root,'logs/comfy-node-preview.png'),fullPage:true});
    await run.click();
    await page.evaluate(()=>render());
    assert(await run.isDisabled());
    assert.equal(await page.evaluate(()=>window.testRuns),1);
    await page.evaluate(()=>window.finishTestRun());
    await page.waitForFunction(()=>!document.querySelector('[data-comfy-node-run]').disabled);
    assert.deepEqual(errors,[]);
    console.log('PASS: grouped workflow controls, Chinese DLSS labels, preserved parameter scroll, inline run. All API writes mocked.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
