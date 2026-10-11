const { app, BrowserWindow, WebContentsView, ipcMain, clipboard, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  console.log('electron test ready');
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  let server, window;
  try {
    const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
    server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<html><head></head><body><button data-variant="single"><img style="width:120px;height:120px"></button><textarea></textarea></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({ show: false, width: 700, height: 500 });
    const view = new WebContentsView({ webPreferences: { preload: path.join(root, 'desktop/harness-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 700, height: 500 });
    let handler;
    const context = vm.createContext({ URL, Buffer, ArrayBuffer, BrowserWindow, nativeImage, clipboard,
      mainWindow: window, deepSeekHarnessView: view, deepSeekHarnessUrl: origin,
      ipcMain: { handle: (_name, callback) => { handler = callback; } },
    });
    vm.runInContext(source.match(/^function isHarnessClipboardSender\([^]*?^}/m)[0], context);
    vm.runInContext(source.match(/ipcMain\.handle\('clipboard:write-image',[^]*?^\}\);/m)[0], context);
    ipcMain.handle('clipboard:write-image', handler);
    console.log('loading fixture', origin);
    await Promise.race([
      view.webContents.loadURL(origin),
      new Promise((_, reject) => setTimeout(() => reject(new Error('fixture load timeout')), 10000)),
    ]);
    console.log('fixture loaded');
    const script = fs.readFileSync(path.join(root, 'desktop/harness-image-copy.js'), 'utf8');
    await view.webContents.executeJavaScript(script);
    await view.webContents.executeJavaScript(script);
    console.log('copy script injected');
    const initialButtonCount = await Promise.race([
      view.webContents.executeJavaScript('document.querySelectorAll("[data-xiaomei-image-copy]").length'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('button count timeout')), 5000)),
    ]);
    console.log('button count', initialButtonCount);
    assert.equal(initialButtonCount, 1);
    for (const mime of ['image/png', 'image/jpeg']) {
      console.log('starting', mime);
      const result = await view.webContents.executeJavaScript(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width=24; canvas.height=16;
        const ctx=canvas.getContext('2d'); ctx.fillStyle='#ff0000'; ctx.fillRect(0,0,24,16);
        const image=document.querySelector('img'); image.src=canvas.toDataURL(${JSON.stringify(mime)});
        await new Promise(resolve => setTimeout(resolve, 200));
        image.dispatchEvent(new PointerEvent('pointerover', {bubbles:true}));
        const button=document.querySelector('[data-xiaomei-image-copy]'); if(button.hidden) throw new Error('copy button hidden');
        button.click();
        await new Promise((resolve,reject)=> { const started=Date.now(); const id=setInterval(()=>{if(!button.disabled){clearInterval(id);resolve();}else if(Date.now()-started>5000){clearInterval(id);reject(new Error('copy timeout'));}},20); });
        return button.textContent;
      })()`);
      assert.equal(result, '已复制图片');
      assert.deepEqual(clipboard.readImage().getSize(), { width: 24, height: 16 });
      console.log(`${mime}: button -> native image clipboard passed`);
    }
    const frame = view.webContents.mainFrame;
    assert.equal(handler({ sender: view.webContents, senderFrame: { url: origin } }, new Uint8Array([0])).ok, false);
    assert.equal(handler({ sender: view.webContents, senderFrame: frame }, new Uint8Array([0])).ok, false);
    console.log('child-frame and invalid-image rejection passed');
    await view.webContents.executeJavaScript(`document.querySelector('textarea').focus(); window.pasteTypes=[]; document.addEventListener('paste',e=>{window.pasteTypes=[...e.clipboardData.items].map(x=>x.type);e.preventDefault();});`);
    view.webContents.paste();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok((await view.webContents.executeJavaScript('window.pasteTypes')).includes('image/png'));
    console.log('native paste exposes image/png passed');
    await view.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-modal="true"><img style="width:200px;height:200px" src="'+document.querySelector('img').src+'"></div>');`);
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("[data-xiaomei-image-copy]").hidden'), false);
    console.log('preview copy button passed');
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    clipboard.write(saved);
    window?.destroy();
    server?.close();
    app.exit(process.exitCode || 0);
  }
});
