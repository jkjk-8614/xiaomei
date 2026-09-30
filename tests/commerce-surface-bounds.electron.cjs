// Run with desktop/node_modules/electron/dist/小美画布.exe.
// Uses temporary sessions, local fixtures and the real WebContentsView.
const { app, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-native-surface-'));
const reportFile = path.join(os.tmpdir(), 'xiaomei-native-surface-result.json');
app.setPath('userData', path.join(outputDir, 'profile'));
let server, window, view;
const results = [];
const pause = (ms=120) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/host') return res.end(`<style>body{margin:0}iframe{position:absolute;left:74px;top:28px;width:calc(100% - 74px);height:calc(100% - 28px);border:0}</style><script>window.electronAPI={setProductBounds:b=>window.lastBounds=b};window.posted=[];addEventListener('message',e=>{if(e.data?.type==='commerce-surface-bounds')posted.push(e.data.bounds)})</script><iframe class="active" id="frame-commerce-analysis" src="/static/commerce-analysis.html"></iframe>`);
      if (url.pathname === '/product') return res.end('<style>body{margin:0;background:#327fba;color:white;font:24px sans-serif;padding:24px}</style>商品网页 · 原生视图边界检查');
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end('{}');
      }
      try {
        const file = path.join(root, decodeURIComponent(url.pathname));
        res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        const baseline = process.env.XIAOMEI_BOUNDS_BASELINE;
        res.end(fs.readFileSync(baseline && url.pathname === '/static/js/commerce-analysis.js' ? baseline : file));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({ width:1800, height:1000, show:false, webPreferences:{contextIsolation:true, sandbox:true, backgroundThrottling:false} });
    view = new WebContentsView({webPreferences:{sandbox:true}});
    window.contentView.addChildView(view);
    await window.loadURL(`${origin}/host`);
    await view.webContents.loadURL(`${origin}/product`);
    await pause(350);
    await window.webContents.executeJavaScript(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.createElement('style');s.textContent='#commerceBrowserSurface{background:rgb(227,17,199)!important;border-radius:0!important}#commerceBrowserSurface>*{visibility:hidden!important}';d.head.appendChild(s)})()`);
    // Use rasterized pixels as the oracle: old Chromium's CDP quads also omit CSS zoom.
    function paintedSurface(screenshot) {
      const {width,height} = screenshot.getSize(), pixels = screenshot.toBitmap();
      let left=width,top=height,right=0,bottom=0;
      for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
        const i=(y*width+x)*4;
        if (pixels[i]===199 && pixels[i+1]===17 && pixels[i+2]===227) {
          left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
        }
      }
      assert(right>left && bottom>top, 'surface marker must be visible');
      const factor=width/window.getContentBounds().width;
      return {left:left/factor,top:top/factor,right:right/factor,bottom:bottom/factor};
    }
    const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
    const code = ['updateViewBounds', 'syncProductSurfaceBoundsFromRenderer'].map(name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');
    const context = vm.createContext({mainWindow:window,productViews:new Map([['fixture',{view}]]),activeProductTabId:'fixture',lastSurfaceBounds:null,refreshProductViewVisibility(){},hasUsableSurfaceBounds:b=>b?.width>80 && b?.height>80});
    vm.runInContext(code, context);
    for (const width of [1400, 1800]) {
      window.setContentSize(width, 900);
      for (const scale of [.85, .95, 1, 1.15]) {
        for (const panelWidth of [300, 450]) {
          await window.webContents.executeJavaScript(`(()=>{const f=document.querySelector('iframe'),d=f.contentDocument;f.contentWindow.postMessage({type:'studio-ui-scale',mode:'auto',scale:${scale}},'*');d.getElementById('analysisDesktop').hidden=true;d.getElementById('commerceWorkbench').classList.remove('assistant-hidden');d.getElementById('assistantPanel').hidden=false;d.getElementById('commerceWorkbench').style.setProperty('--assistant-width','${panelWidth}px')})()`);
          await pause(250);
          await window.capturePage();
          assert(await context.syncProductSurfaceBoundsFromRenderer());
          await pause();
          const native = view.getBounds();
          const screenshot = await window.capturePage();
          const surface = paintedSurface(screenshot);
          results.push({width,scale,panelWidth,native,surface});
          assert(native.x + native.width <= surface.right + 2, `sidebar overlap: ${JSON.stringify(results.at(-1))}`);
          assert(Math.abs(native.x-surface.left)<2, 'left edge mismatch');
          assert(Math.abs(native.y-surface.top)<2, 'top edge mismatch');
          assert(Math.abs(native.x+native.width-surface.right)<2, 'right edge mismatch');
          assert(Math.abs(native.y+native.height-surface.bottom)<2, 'bottom edge mismatch');
          if (width===1800 && scale===.95 && panelWidth===450) {
            fs.writeFileSync(path.join(outputDir,'native-view-95.png'),(await window.capturePage()).toPNG());
          }
        }
        const draggedWidth = await window.webContents.executeJavaScript(`(()=>{const w=document.querySelector('iframe').contentWindow,d=w.document,h=d.getElementById('assistantResizer');h.setPointerCapture=()=>{};h.dispatchEvent(new w.PointerEvent('pointerdown'));h.dispatchEvent(new w.PointerEvent('pointermove',{clientX:w.innerWidth-480*${scale}}));const width=parseFloat(d.getElementById('commerceWorkbench').style.getPropertyValue('--assistant-width'));h.dispatchEvent(new w.PointerEvent('pointercancel'));return width})()`);
        assert(Math.abs(draggedWidth-480)<2, `drag must follow the pointer at ${scale}: ${draggedWidth}`);
        await pause(300);
      }
    }
    // The direct IPC sender and message-only sender must agree with the resync path.
    await window.webContents.executeJavaScript(`document.querySelector('iframe').contentWindow.dispatchEvent(new Event('resize'))`);
    await window.capturePage();
    await pause(350);
    await window.capturePage();
    await pause();
    const direct = await window.webContents.executeJavaScript('window.lastBounds');
    context.updateViewBounds(direct);
    const directNative = view.getBounds();
    assert(await context.syncProductSurfaceBoundsFromRenderer());
    assert.deepEqual(view.getBounds(), directNative);
    await window.webContents.executeJavaScript(`delete window.electronAPI;document.querySelector('iframe').contentWindow.dispatchEvent(new Event('resize'))`);
    await window.capturePage();
    await pause();
    const posted = await window.webContents.executeJavaScript('window.posted.at(-1)');
    assert(posted);
    assert(Math.abs(posted.x+74-direct.x)<1);
    assert(Math.abs(posted.width-direct.width)<1);
    fs.writeFileSync(reportFile, JSON.stringify({ok:true,electron:process.versions.electron,outputDir,results},null,2));
  } catch (error) {
    if (window) fs.writeFileSync(path.join(outputDir,'failure.png'),(await window.capturePage()).toPNG());
    fs.writeFileSync(reportFile,JSON.stringify({ok:false,error:error.stack,outputDir,results},null,2));
    process.exitCode=1;
  } finally {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    window?.destroy();
    server?.close();
    app.exit(process.exitCode || 0);
  }
});
