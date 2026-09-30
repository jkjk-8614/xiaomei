const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.join(root, 'tools/commerce-analysis/node_modules/playwright'));
(async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true});
 try {
  const page = await browser.newPage({viewport:{width:2000,height:1080}});
  page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*', route => {
   const u=new URL(route.request().url());
   if(u.hostname!=='commerce-bounds.test')return route.abort();
   if(u.pathname==='/host')return route.fulfill({contentType:'text/html',body:`<style>body{margin:0}iframe{position:absolute;left:74px;top:28px;width:calc(100% - 74px);height:calc(100% - 28px);border:0}</style><script>window.sent=[];window.posted=[];window.electronAPI={setProductBounds:(b)=>sent.push(b)};addEventListener('message',e=>{if(e.data?.type==='commerce-surface-bounds')posted.push(e.data.bounds)})</script><iframe class="active" id="frame-commerce-analysis" src="/static/commerce-analysis.html"></iframe>`});
   if(u.pathname.startsWith('/static/'))return route.fulfill({path:path.join(root,decodeURIComponent(u.pathname))});
   return route.fulfill({json:{}});
  });
  await page.goto('http://commerce-bounds.test/host');
  const frame=page.frames().find(f=>f.url().includes('/static/commerce-analysis.html'));
  await frame.waitForFunction(()=>typeof window.xiaomeiCommerceSurfaceBounds==='function');
  assert.equal(await frame.locator('[data-desktop-app]').count(),19);
  await page.screenshot({path:path.join(require('os').tmpdir(),'xiaomei-workspace-compact.png')});
  for(const scale of [0.85,0.95,1,1.15]) {
   await frame.evaluate(scale=>window.postMessage({type:'studio-ui-scale',mode:'auto',scale},'*'),scale);
   await frame.waitForTimeout(100);
   const size=await frame.evaluate(()=>({width:innerWidth,root:document.getElementById('commerceWorkbench').getBoundingClientRect().width}));
   assert(Math.abs(size.width-size.root)<1,`unfilled viewport at ${scale}`);
   await frame.evaluate(()=>{document.getElementById('analysisDesktop').hidden=true;document.getElementById('commerceWorkbench').classList.remove('assistant-hidden');document.getElementById('assistantPanel').hidden=false;});
   const geometry=await frame.evaluate(()=>({bounds:window.xiaomeiCommerceSurfaceBounds(),local:window.xiaomeiCommerceSurfaceBounds(false),panel:document.getElementById('assistantPanel').getBoundingClientRect().left,frame:window.frameElement.getBoundingClientRect().toJSON()}));
   assert(geometry.bounds.x+geometry.bounds.width<=geometry.frame.left+geometry.panel+0.1,`native overlap at ${scale}`);
   assert(Math.abs(geometry.bounds.x-geometry.local.x-74)<0.1,'frame offset must occur exactly once');
   // The desktop resynchronization must use the same measured rectangle.
   const source=fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');
   const code=source.match(/^async function syncProductSurfaceBoundsFromRenderer\([^]*?^}/m)[0];let desktopBounds;
   const context={mainWindow:{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,executeJavaScript:code=>page.evaluate(code)}},hasUsableSurfaceBounds:b=>b?.width>80,updateViewBounds:b=>desktopBounds=b,activeProductTabId:'fixture'};
   vm.createContext(context);vm.runInContext(code,context);assert(await context.syncProductSurfaceBoundsFromRenderer());assert.equal(desktopBounds.width,geometry.bounds.width);
  }
  // The message-only path must emit iframe-local coordinates.
  await page.evaluate(()=>{delete window.electronAPI;window.posted=[]});
  await frame.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.waitForFunction(()=>window.posted.length>0);
  const local=await frame.evaluate(()=>window.xiaomeiCommerceSurfaceBounds(false));
  const posted=await page.evaluate(()=>window.posted.at(-1));assert(Math.abs(posted.x-local.x)<0.1);
  for(const width of [1000,600]){
   await page.setViewportSize({width,height:900});await frame.evaluate(()=>{document.getElementById('analysisDesktop').hidden=false;window.postMessage({type:'studio-ui-scale',mode:'auto',scale:1},'*')});await frame.waitForTimeout(150);
   const overflow=await frame.evaluate(()=>{const r=document.getElementById('commerceWorkbench').getBoundingClientRect();return [...document.querySelectorAll('[data-desktop-app]')].some(n=>n.getBoundingClientRect().right>r.right+1)});assert(!overflow,`launcher overflow at ${width}`);
  }
  assert.deepEqual(errors,[]);console.log('PASS: 19 launchers, full width at 85/95/100/115%, native sidebar boundary, single iframe offset, desktop resync and narrow layouts.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
