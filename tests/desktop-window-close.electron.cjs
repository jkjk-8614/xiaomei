const { app, BrowserWindow, WebContentsView, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installWindowLifecycle } = require('../desktop/window-lifecycle.cjs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-close-test-')));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Close test timed out'); app.exit(1); }, 15000);

app.whenReady().then(async () => {
  let prompts = 0;
  let response = 0;
  dialog.showMessageBox = async () => { prompts++; return { response }; };
  for (const blocked of [false, true]) {
    const window = new BrowserWindow({ show: false });
    const view = new WebContentsView();
    const productContents = view.webContents;
    window.contentView.addChildView(view);
    let cleaned = 0;
    let revealed = false;
    const lifecycle = installWindowLifecycle(window, () => {
      cleaned++;
      view.webContents.close();
    });
    await window.loadURL('data:text/html,<p>Close test</p>');
    await view.webContents.loadURL('data:text/html,<p>Product test</p>');
    if (blocked) await window.webContents.executeJavaScript('window.onbeforeunload = e => { e.returnValue = false; }; void 0;');
    lifecycle.schedule(() => { revealed = true; }, 100);
    window.close();
    await delay(300);
    if (blocked) {
      assert.equal(prompts, 1, 'blocked close presents a choice');
      assert.equal(window.isDestroyed(), false, 'waiting preserves the window');
      assert.equal(cleaned, 0, 'waiting preserves product resources');
      response = 1;
      window.close();
      await delay(300);
      assert.equal(prompts, 2);
    }
    assert.equal(window.isDestroyed(), true);
    assert.equal(productContents.isDestroyed(), true);
    assert.equal(cleaned, 1);
    assert.equal(revealed, false, 'startup callback cannot reveal a closing window');
  }
  const delayedWindow = new BrowserWindow({ show: false });
  let delayedCleanup = 0;
  installWindowLifecycle(delayedWindow, () => { delayedCleanup++; });
  delayedWindow.on('close', event => event.preventDefault());
  const priorPrompts = prompts;
  delayedWindow.close();
  await delay(3300);
  assert.equal(prompts, priorPrompts + 1, 'stalled close prompts after timeout');
  assert.equal(delayedWindow.isDestroyed(), true);
  assert.equal(delayedCleanup, 1);
  clearTimeout(watchdog);
  console.log('PASS: normal close, blocked close, wait, force close, product cleanup, startup timers');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
