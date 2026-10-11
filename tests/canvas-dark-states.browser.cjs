const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const rgb = value => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
const luminance = value => { const [r,g,b] = rgb(value); return (0.2126*r + 0.7152*g + 0.0722*b); };

test('dark canvas controls stay readable and selected links animate only for related nodes', {timeout:60000}, async t => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1600,height:1000}});
  page.setDefaultTimeout(10000);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'xiaomei-dark-canvas.test') return route.abort();
    if (url.pathname.startsWith('/static/')) {
      let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
      if (!fs.existsSync(file) || !file.startsWith(root + path.sep)) return route.fulfill({status:404,body:''});
      return route.fulfill({path:file});
    }
    if (url.pathname === '/api/canvases/dark-fixture') return route.fulfill({json:{canvas:{id:'dark-fixture',title:'Dark fixture',nodes:[],connections:[],logs:[],settings:{engine:'api',count:1}}}});
    if (url.pathname === '/api/config' || url.pathname === '/api/providers') return route.fulfill({json:{api_providers:[],comfy_instances:[]}});
    return route.fulfill({json:{}});
  });
  await page.addInitScript(() => { localStorage.setItem('studio_theme','dark'); localStorage.setItem('studio_appearance', JSON.stringify({skin:'dark',font:'system',fontSize:'normal',accent:'#0e7490',eyeCare:false})); });
  await page.goto('http://xiaomei-dark-canvas.test/static/smart-canvas.html?id=dark-fixture');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => document.body.classList.contains('theme-dark') && typeof openCreateMenu === 'function' && typeof render === 'function');
  await page.evaluate(() => openCreateMenu({clientX:100,clientY:100}));
  const menuColors = [];
  const cards = page.locator('#createMenu [data-create-type]');
  for (let i=0; i<await cards.count(); i++) {
    const card = cards.nth(i); await card.hover();
    await page.waitForTimeout(180);
    menuColors.push(await card.evaluate(el => ({type:el.dataset.createType, title:getComputedStyle(el.querySelector('.create-card-title')).color, sub:getComputedStyle(el.querySelector('.create-card-sub')).color, icon:getComputedStyle(el.querySelector('.create-card-icon')).color, bg:getComputedStyle(el).backgroundColor})));
  }
  assert.ok(menuColors.length >= 10);
  for (const item of menuColors) {
    assert.ok(luminance(item.title) > 150, `${item.type} title should be readable: ${item.title}`);
    assert.ok(luminance(item.icon) > 150, `${item.type} icon should be readable: ${item.icon}`);
    assert.ok(luminance(item.sub) > 100, `${item.type} description should be readable: ${item.sub}`);
    assert.equal(item.bg, 'rgb(59, 59, 59)', `${item.type} hover background should match dark menu`);
  }
  const compact = await page.evaluate(() => {
    openCreateMenu({clientX:100,clientY:100}, {pendingConnection:{from:'a',to:'',kind:'input'}});
    const card = document.querySelector('#createMenu [data-create-type="loop"]');
    return {title:getComputedStyle(card.querySelector('.create-card-title')).color, icon:getComputedStyle(card.querySelector('.create-card-icon')).color, bg:getComputedStyle(card).backgroundColor, compact:document.getElementById('createMenu').classList.contains('create-menu-compact')};
  });
  await page.locator('#createMenu [data-create-type="loop"]').hover();
  await page.waitForTimeout(220);
  const compactHovered = await page.locator('#createMenu [data-create-type="loop"]').evaluate(card => ({title:getComputedStyle(card.querySelector('.create-card-title')).color, icon:getComputedStyle(card.querySelector('.create-card-icon')).color, bg:getComputedStyle(card).backgroundColor}));
  Object.assign(compact, compactHovered);
  assert.equal(compact.compact, true); assert.ok(luminance(compact.title)>150); assert.ok(luminance(compact.icon)>150); assert.equal(compact.bg,'rgb(59, 59, 59)');
  const navColor = await page.locator('.canvas-nav-tool.active').first().evaluate(el => getComputedStyle(el).color);
  assert.ok(luminance(navColor) > 150, `active canvas tool should stay readable: ${navColor}`);

  const ids = await page.evaluate(() => {
    nodes=[]; canvas.connections=[]; selectedId=''; selectedIds=[]; selectedImage={nodeId:'',index:-1};
    const a=createNode(120,180,[{url:'/a.png',name:'a.png',kind:'image'}],{select:false,skipUndo:true});
    const b=createNode(700,180,[{url:'/b.png',name:'b.png',kind:'image'}],{select:false,skipUndo:true});
    const c=createNode(120,620,[{url:'/c.png',name:'c.png',kind:'image'}],{select:false,skipUndo:true});
    canvas.connections=[{from:a.id,to:b.id,kind:'input'},{from:c.id,to:b.id,kind:'input'}];
    render();
    return {a:a.id,b:b.id,c:c.id};
  });
  const states = await page.evaluate(ids => {
    selectedId=ids.b; selectedIds=[]; selectedImage={nodeId:'',index:-1}; render();
    const groups=[...document.querySelectorAll('.connection-layer .conn-group')];
    const selected=groups.filter(g=>g.querySelector('.conn-selected-flow'));
    const first=selected[0]?.querySelector('.conn-selected-flow');
    const base=selected[0]?.querySelector('.conn-line');
    return {groups:groups.length, selected:selected.length, animation:first?getComputedStyle(first).animationName:'', display:first?getComputedStyle(first).display:'', baseStroke:base?getComputedStyle(base).stroke:'', dash:first?getComputedStyle(first).strokeDasharray:''};
  }, ids);
  assert.equal(states.groups,2); assert.equal(states.selected,2); assert.equal(states.animation,'selected-connection-flow'); assert.equal(states.display,'block'); assert.equal(states.dash,'24px, 82px'); assert.match(states.baseStroke,/rgba?\(205, 209, 213/);
  await page.screenshot({path:path.join(root, 'tmp', 'dark-canvas-states.png'), fullPage:false});
  const deselected = await page.evaluate(() => { selectedId=''; selectedIds=[]; selectedImage={nodeId:'',index:-1}; render(); return {flows:document.querySelectorAll('.conn-selected-flow').length, groups:[...document.querySelectorAll('.conn-group')].map(g=>g.className.baseVal)}; });
  assert.equal(deselected.flows,0); assert.ok(deselected.groups.every(c => !c.includes('conn-selected')));
  const light = await page.evaluate(b => { document.documentElement.classList.remove('theme-dark','studio-theme-dark'); document.body.classList.remove('theme-dark','studio-theme-dark'); selectedId=b; render(); const flow=document.querySelector('.conn-selected-flow'); return flow ? getComputedStyle(flow).display : 'none'; }, ids.b);
  assert.equal(light,'none');
});
