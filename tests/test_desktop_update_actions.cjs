const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');

test('failure dialog offers retry and opens only the official download page', async () => {
  let response = 0;
  let opened;
  const prompts = [];
  const context = vm.createContext({
    APP_DISPLAY_VERSION: '1.06', RELEASES_URL: 'https://github.com/jkjk-8614/xiaomei/releases/latest',
    desktopUpdateOwnerWindow: () => undefined,
    dialog: { showMessageBox: async options => { prompts.push(options); return { response }; } },
    shell: { openExternal: async url => { opened = url; } },
  });
  vm.runInContext(source.slice(source.indexOf('async function showDesktopUpdateResult('), source.indexOf('function desktopUpdatePromptOptions(')), context);
  assert.equal(await context.showDesktopUpdateResult({ status: 'unavailable', message: '网络超时' }), 'retry');
  assert.deepEqual(Array.from(prompts[0].buttons), ['重试', '打开下载页面', '稍后']);
  assert.equal(prompts[0].cancelId, 2);
  response = 1;
  await context.showDesktopUpdateResult({ status: 'invalid' });
  assert.equal(opened, context.RELEASES_URL);
  context.shell.openExternal = async () => { throw new Error('browser unavailable'); };
  assert.equal((await context.openDesktopUpdatePage()).ok, false);
  assert.equal(prompts.at(-1).detail, context.RELEASES_URL);
});

test('retry and download-page IPC require the update window main frame', async () => {
  const handlers = {};
  const updateWindow = {};
  let retries = 0;
  let pages = 0;
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    BrowserWindow: { fromWebContents: sender => sender.owner },
    updateWindow, desktopUpdateOperationPromise: null,
    desktopUpdateWindowState: { state: 'error' }, desktopUpdateRetryManifest: { version: '1.0.6' },
    startDesktopUpdate: () => { retries++; }, openDesktopUpdatePage: () => { pages++; },
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('app:update-retry'"), source.indexOf("ipcMain.handle('deepseek-harness:visible'")), context);
  const frame = {};
  const event = { sender: { owner: updateWindow, mainFrame: frame }, senderFrame: frame };
  for (const handler of Object.values(handlers)) {
    assert.equal(handler({ ...event, senderFrame: {} }).ok, false);
    assert.equal(handler({ ...event, sender: { owner: {}, mainFrame: frame } }).ok, false);
    handler(event);
  }
  assert.equal(retries, 1); assert.equal(pages, 1);
  context.desktopUpdateOperationPromise = Promise.resolve();
  assert.equal(handlers['app:update-retry'](event).ok, false);
  assert.equal(retries, 1);
});
