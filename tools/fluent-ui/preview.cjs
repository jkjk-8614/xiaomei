const { chromium } = require('../commerce-analysis/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const dest = path.join(root, 'output/fluent-ui-review');
const stage = process.argv[2] || 'after';
let browser;
(async () => {
  fs.mkdirSync(dest, {recursive:true});
  browser = await chromium.launch({channel:'msedge', headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:960}});
  await context.addInitScript(() => {
    localStorage.setItem('studio_ui_scale_mode', '100');
    localStorage.setItem('studio_last_page', 'canvas');
  });
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.routeWebSocket('**/*', s=>s.close());
  await page.route('**/*', async route=>{
    const u = new URL(route.request().url());
    if(u.hostname!=='fluent.test') return route.abort();
    if(u.pathname==='/' || u.pathname.startsWith('/static/')) {
      let file = path.resolve(root, '.'+decodeURIComponent(u.pathname==='/'?'/static/index.html':u.pathname));
      if(!fs.existsSync(file)) file=path.resolve(root,'ComfyUI/web',u.pathname.slice(8));
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) return route.fulfill({status:404,body:''});
      return route.fulfill({path:file});
    }
    if(u.pathname==='/api/config') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
    if(u.pathname==='/api/providers') return route.fulfill({json:{providers:[]}});
    if(u.pathname==='/api/canvases/fluent-review') return route.fulfill({json:{canvas:{id:'fluent-review',title:'春季新品 · 视觉工作流',nodes:[],connections:[],logs:[],settings:{engine:'api'}}}});
    if(u.pathname==='/api/canvases') return route.fulfill({json:{canvases:[]}});
    if(u.pathname==='/api/projects') return route.fulfill({json:{projects:[{id:'default',name:'默认项目'}]}});
    if(u.pathname==='/api/history') return route.fulfill({json:[]});
    return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[],providers:[],files:[],tasks:[]}});
  });
  for(const name of ['index','canvas-list','smart-canvas','api-settings','commerce','commerce-analysis','asset-manager','gpt-chat','history','comfyui','comfyui-settings']) {
    await page.goto(`http://fluent.test/static/${name}.html?id=fluent-review`);
    await page.waitForTimeout(800);
    if(name==='smart-canvas') {
      await page.evaluate(()=>{
        createNode(300,180,[],{select:false});
        document.getElementById('canvasAgentToggle').click();
      });
    }
    await page.screenshot({path:path.join(dest,`${stage}-${name}.png`)});
    if(stage!=='before') {
      await page.waitForFunction(()=>document.documentElement.dataset.fluentReady==='true');
      console.log(name,await page.evaluate(()=>({ready:document.documentElement.dataset.fluentReady,buttons:document.querySelectorAll('fluent-button').length,background:getComputedStyle(document.body).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth})));
      await page.evaluate(()=>StudioAppearance.set({skin:'dark'}));
      await page.screenshot({path:path.join(dest,`${stage}-${name}-dark.png`)});
      await page.evaluate(()=>StudioAppearance.set({skin:'minimal'}));
      if(name==='canvas-list') {
        await page.locator('#newProjectBtn').click();
        assert.equal(await page.locator('.ws-newproj-row').evaluate(el=>el.classList.contains('active')),true);
        await page.locator('#newProjectCancel').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.ws-newproj-row').evaluate(el=>el.classList.contains('active')),false);
        await page.locator('#newProjectBtn').evaluate(el=>el.disabled=true);
        await page.locator('#newProjectBtn').click({force:true});
        assert.equal(await page.locator('.ws-newproj-row').evaluate(el=>el.classList.contains('active')),false);
        await page.locator('#newProjectBtn').evaluate(el=>el.disabled=false);
        for(const skin of ['minimal','dark','soft','warm']) {
          const actual=await page.evaluate(skin=>{
            StudioAppearance.set({skin,accent:'#8800aa'});
            return {accent:getComputedStyle(document.documentElement).getPropertyValue('--colorBrandBackground').trim(),selectedAccent:StudioAppearance.get().accent,bg:getComputedStyle(document.body).backgroundColor};
          },skin);
          assert.equal(actual.selectedAccent,'#8800aa');
          if(skin === 'warm') assert.notEqual(actual.accent,'#8800aa');
          else assert.equal(actual.accent,'#8800aa');
          console.log('theme',skin,actual);
        }
        await page.evaluate(()=>StudioAppearance.set({skin:'minimal',accent:'#3b82f6'}));
      }
      if(name==='smart-canvas') {
        await page.locator('#canvasAgentSettingsToggle').click();
        assert.equal(await page.locator('#canvasAgentSettingsToggle').evaluate(el=>el.classList.contains('active')),true);
        await page.locator('#canvasAgentClose').focus();
        await page.keyboard.press('Space');
        assert.equal(await page.locator('#canvasAgentPanel').isVisible(),false);
      }
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:path.join(dest,`${stage}-${name}-mobile.png`)});
      console.log('mobile',name,await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth})));
      await page.setViewportSize({width:1440,height:960});
    }
  }
  console.log('page errors:',JSON.stringify([...new Set(errors)]));
  assert.deepEqual(errors,[]);
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>browser?.close());
