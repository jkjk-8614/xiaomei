const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.join(root, 'tools/commerce-analysis/node_modules/playwright'));
const output = path.join(require('node:os').tmpdir(), 'xiaomei-commerce-review');
const label = process.argv[2] || 'review';
const fixtureUrl = 'https://item.taobao.com/item.htm?id=123456789012';
const resources = ['product', 'images', 'sku_images', 'sku_list', 'detail', 'detail_more', 'videos', 'reviews', 'questions', 'operations', 'people'].map((id, i) => ({ id, status:i < 6 ? 'ready' : i < 9 ? 'deferred' : 'missing', sampleCount:i < 6 ? 5 : 0, totalCount:i < 6 ? 5 : null }));
const result = {status:'ready', productId:'123456789012', normalizedUrl:fixtureUrl, product:{id:'123456789012', title:'可调光桌面阅读灯 · 原木灯座 / 三档色温 / USB 充电', category:'家居照明', store:'小美家居', price:'129', thumbnail:'/static/images/desktop-app-taobao.png'}, mainImages:Array.from({length:5},()=>({url:'/static/images/desktop-app-taobao.png'})), detail:{images:Array.from({length:5},()=>({url:'/static/images/desktop-app-taobao.png'}))}, sku:{items:[{id:'1', image:'/static/images/desktop-app-taobao.png'}]}, resources};
(async () => {
 const browser = await chromium.launch({channel:'msedge', headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1920,height:1000}});
  page.setDefaultTimeout(8000);
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('studio_ui_scale_mode','100');localStorage.setItem('xiaomei_commerce_assistant_width_v1','900');});
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.hostname!=='commerce-review.test')return route.abort();
    if(u.pathname.startsWith('/static/')){const file=path.resolve(root,'.'+decodeURIComponent(u.pathname));return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});}
    if(u.pathname==='/api/commerce-analysis/jobs/ui-fixture')return route.fulfill({json:{id:'ui-fixture',status:'ready',url:fixtureUrl,result}});
    if(u.pathname==='/api/providers')return route.fulfill({json:{providers:[{id:'fixture',name:'本地测试',enabled:true,chat_models:['gemini-3.8-flash-high']}],api_providers:[{id:'fixture',name:'本地测试',enabled:true,chat_models:['gemini-3.8-flash-high']}]}});
    return route.fulfill({json:{ok:true,items:[],conversations:[],skills:[],categories:[],providers:[],api_providers:[]}});
  });
  await page.goto('http://commerce-review.test/static/commerce-analysis.html?desktop=1');
  await page.waitForFunction(()=>document.documentElement.dataset.fluentReady==='true');
  fs.mkdirSync(output,{recursive:true});
  await page.evaluate(()=>StudioAppearance.set({skin:'warm'}));
  for (const width of [1714, 1280, 760, 390]) {
    await page.setViewportSize({width,height:1000});
    const layout = await page.evaluate(() => {
      const area = document.querySelector('.analysis-desktop-scroll');
      const grid = document.getElementById('desktopAppGrid');
      const box = grid.getBoundingClientRect();
      return {
        titleSize: parseFloat(getComputedStyle(document.querySelector('.desktop-app-bar strong')).fontSize),
        left: box.left, right: innerWidth - box.right,
        overflow: area.scrollWidth > area.clientWidth,
        cards: grid.querySelectorAll('.desktop-app-card').length,
        imagesLoaded: [...grid.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0),
        readable: [...grid.querySelectorAll('.desktop-app-card')].every(card => {
          const icon = card.querySelector('.desktop-app-icon').getBoundingClientRect();
          const title = card.querySelector('strong').getBoundingClientRect();
          return title.left >= icon.right && title.width >= 60;
        }),
      };
    });
    assert.ok(layout.titleSize >= 26, 'workspace title must lead the hierarchy');
    assert.ok(layout.left <= 28 && layout.right <= 28, JSON.stringify(layout));
    assert.equal(layout.overflow, false);
    assert.equal(layout.cards, 19);
    assert.equal(layout.imagesLoaded, true);
    assert.equal(layout.readable, true, `platform labels need room at ${width}px`);
    await page.screenshot({path:path.join(output,`${label}-directory-${width}.png`),fullPage:true});
    if (width === 390) {
      await page.locator('[data-desktop-app="skills"]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('[data-desktop-app="skills"]').isVisible(), true);
      await page.screenshot({path:path.join(output,`${label}-directory-mobile-bottom.png`)});
    }
  }
  await page.setViewportSize({width:1920,height:1000});
  await page.evaluate(()=>document.getElementById('commerceWorkbench').style.setProperty('--assistant-width','900px'));
  await page.locator('[data-desktop-app="tasks"]').click();
  assert.equal(await page.locator('#desktopDrawer').isVisible(), true);
  await page.locator('#desktopDrawerClose').click();
  await page.evaluate(()=>window.postMessage({type:'task-open-report',jobId:'ui-fixture'},'*'));
  await page.locator('#reportDrawer.is-open, #reportDrawer.open, #reportDrawer[aria-hidden="false"]').waitFor({state:'visible'});
  await page.locator('#reportClose').click();
  const toggle=page.locator('[data-toggle="productInfoBody"]');
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await page.waitForFunction(()=>document.querySelectorAll('#resourceList .resource-card').length===11);
  await page.evaluate(()=>document.getElementById('commerceWorkbench').style.setProperty('--assistant-width','900px'));
  assert.equal(await page.locator('#resourceList .resource-icon svg').count(), 11);
  assert.equal(await page.locator('#resourceList .resource-download[download]').count() > 0, true);
  assert.equal(await page.locator('#resourceList [data-preview-resource-id="detail"]').count(), 1);
  await toggle.click();
  assert.equal(await page.locator('#productInfoBody').isVisible(), false);
  await toggle.click();
  await page.locator('[data-resource-id="images"]').click();
  assert.match(await page.locator('#chatInput').inputValue(), /@主图/);
  assert.equal(await page.locator('[data-resource-id="images"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#quickImages').click();
  assert.ok((await page.locator('#chatInput').inputValue()).length > 3);
  await page.locator('#chatInput').fill('');
  await page.locator('[data-toggle="quickToolsBody"]').click();
  assert.equal(await page.locator('#quickToolsBody').isVisible(), false);
  await page.locator('[data-toggle="quickToolsBody"]').click();
  await page.locator('#modelPickerButton').click();
  assert.equal(await page.locator('#modelPickerPopover').isVisible(), true);
  assert.match(await page.locator('#modelPickerPopover').innerText(), /gemini-3.8-flash-high/);
  await page.locator('#modelPickerClose').click();
  async function assertLayout() {
    const problems = await page.evaluate(() => {
      const issues = [];
      const panel = document.getElementById('assistantPanel').getBoundingClientRect();
      for (const selector of ['.chat-compose', '#chatSend', '#modelPickerButton', '#chatInput', '.quick-card']) {
        const element = document.querySelector(selector), box = element.getBoundingClientRect();
        if (box.left < panel.left - 1 || box.right > panel.right + 1 || box.bottom > panel.bottom + 1) issues.push(selector + ' outside panel');
      }
      const send = document.getElementById('chatSend').getBoundingClientRect();
      const model = document.getElementById('modelPickerButton').getBoundingClientRect();
      if (model.right > send.left) issues.push('model overlaps send');
      if (document.querySelector('.chat-messages').clientHeight < 80) issues.push('chat too short');
      for (const card of document.querySelectorAll('.resource-card')) {
        const main = card.querySelector('.resource-card-main').getBoundingClientRect();
        const action = card.querySelector('.resource-actions').getBoundingClientRect();
        if (main.right > action.left + 1) issues.push('resource action overlap');
      }
      if (getComputedStyle(document.getElementById('chatInput')).backgroundColor !== 'rgba(0, 0, 0, 0)') issues.push('textarea theme mismatch');
      return issues;
    });
    assert.deepEqual(problems, []);
  }
  fs.mkdirSync(output,{recursive:true});
  for(const skin of ['minimal','warm','dark']) {
    await page.evaluate(skin=>StudioAppearance.set({skin,font:'sans',fontSize:'normal'}),skin);
    await page.waitForTimeout(120);
    await assertLayout();
    assert.ok(await page.locator('#productInfoBody').evaluate(el => el.scrollHeight <= el.clientHeight + 1));
    await page.locator('#assistantPanel').screenshot({path:path.join(output,`${label}-${skin}-wide.png`)});
  }
  await page.evaluate(()=>StudioAppearance.set({skin:'minimal'}));
  for(const width of [520,390,320]) {
    await page.evaluate(width=>document.getElementById('commerceWorkbench').style.setProperty('--assistant-width',`${width}px`),width);
    await assertLayout();
    await page.locator('#assistantPanel').screenshot({path:path.join(output,`${label}-${width}.png`)});
  }
  await page.setViewportSize({width:1280,height:720});
  await assertLayout();
  await page.setViewportSize({width:390,height:844});
  await assertLayout();
  await page.locator('#assistantPanel').screenshot({path:path.join(output,`${label}-mobile.png`)});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({output,errors,metrics:await page.evaluate(()=>Object.fromEntries(['assistantPanel','productInfoCard','productInfoBody','chatMessages','chatInput'].map(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect(),s=getComputedStyle(el);return[id,{width:r.width,height:r.height,scroll:el.scrollHeight,bg:s.backgroundColor,color:s.color}]})))},null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
