const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const app = new EventEmitter();
  let quitCount = 0;
  app.quit = () => { quitCount++; };
  const window = new EventEmitter();
  Object.assign(window, {
    visible: true, minimized: false, closed: false, restored: 0,
    hide() { this.visible = false; },
    show() { this.visible = true; this.emit('show'); },
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; this.restored++; },
    moveTop() {}, focus() {},
  });
  let tray;
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.destroyed = false; tray = this; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const context = vm.createContext({
    module: { exports: {} },
    require: () => ({ app, Tray, Menu: { buildFromTemplate: items => items } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../desktop/tray.cjs'), 'utf8'), context);
  const control = context.module.exports.installDesktopTray(window, { isClosing: () => window.closed }, '小美图标.ico', '小美画布');
  return { app, window, tray, control, quitCount: () => quitCount };
}

test('hide retains window; tray click and double click restore it', () => {
  const { window, tray, control } = setup();
  for (const event of ['click', 'double-click']) {
    assert.equal(control.hide().ok, true);
    assert.equal(window.visible, false);
    assert.equal(control.isHidden(), true);
    assert.equal(tray.menu[1].enabled, false);
    assert.match(tray.tooltip, /后台运行中/);
    window.minimized = true;
    tray.emit(event);
    assert.equal(window.visible, true);
    assert.equal(window.minimized, false);
    assert.equal(control.isHidden(), false);
    assert.equal(tray.menu[1].enabled, true);
  }
  assert.equal(window.restored, 2);
});

test('external restore and tray menu use the same visibility state', () => {
  const { window, tray, control } = setup();
  tray.menu[1].click();
  window.show();
  assert.equal(control.isHidden(), false);
  tray.menu[1].click();
  tray.menu[0].click();
  assert.equal(window.visible, true);
  assert.equal(control.isHidden(), false);
});

test('closing window or destroyed tray cannot hide the window', () => {
  const { window, tray, control } = setup();
  window.closed = true;
  assert.equal(control.hide().ok, false);
  assert.equal(window.visible, true);
  tray.emit('click');
  assert.equal(control.isHidden(), false);
  window.closed = false;
  tray.destroy();
  assert.equal(control.hide().ok, false);
  assert.equal(window.visible, true);
});

test('exit reveals window for unload confirmation; tray survives canceled quit', () => {
  const fixture = setup();
  fixture.control.hide();
  fixture.tray.menu[3].click();
  assert.equal(fixture.window.visible, true);
  assert.equal(fixture.quitCount(), 1);
  fixture.app.emit('before-quit');
  assert.equal(fixture.tray.isDestroyed(), false);
  fixture.app.emit('will-quit');
  assert.equal(fixture.tray.isDestroyed(), true);
});

test('normal close removes tray', () => {
  const { window, tray } = setup();
  window.emit('closed');
  assert.equal(tray.isDestroyed(), true);
});

test('only a local main window can call the tray IPC', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
  const code = source.match(/ipcMain\.handle\('app:hide-to-tray',[\s\S]*?\n\}\);/)[0];
  let handler;
  let hides = 0;
  const window = {};
  const context = vm.createContext({
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    BrowserWindow: { fromWebContents: sender => sender.owner },
    mainWindow: window, LOCAL_ORIGIN: 'http://127.0.0.1:3001',
    desktopTray: { hide: () => { hides++; return { ok: true }; } },
  });
  vm.runInContext(code, context);
  assert.equal(handler({ sender: { owner: window }, senderFrame: { url: 'http://127.0.0.1:3001/static/index.html' } }).ok, true);
  for (const [owner, url] of [[{}, 'http://127.0.0.1:3001/'], [window, 'https://example.com/'], [window, 'http://127.0.0.1:3001.evil/']]) {
    assert.equal(handler({ sender: { owner }, senderFrame: { url } }).ok, false);
  }
  assert.equal(hides, 1);
  context.desktopTray = null;
  assert.equal(handler({ sender: { owner: window }, senderFrame: { url: 'http://127.0.0.1:3001/' } }).ok, false);
});
