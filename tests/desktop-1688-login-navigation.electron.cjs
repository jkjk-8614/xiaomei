// Run with the project's Electron executable, not Node.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-login-navigation-')));
const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const home = 'https://www.1688.com/';
const login = 'https://login.1688.com/member/signin.htm';
const functions = [
  'isLoginUrl', 'is1688WebsiteUrl', 'is1688LoginTarget', 'encodedValueTargets1688',
  'isTaobaoWebsiteUrl', 'navigationHostFamily', 'is1688LoginBridgeUrl',
  'is1688LoginNavigationUrl', 'matchesPending1688Navigation', 'navigationMatchesTarget',
  'shouldRecover1688LoginLanding', 'shouldPromote1688Login', 'promote1688LoginToTopLevel',
];
const code = functions.map(name => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');
const eventCode = ['will-frame-navigate', 'will-navigate', 'will-redirect'].map(name => {
  const start = source.indexOf(`  view.webContents.on('${name}',`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  });', start);
  return source.slice(start, end + '\n  });'.length);
}).join('\n');

async function checkNavigation(mode) {
  const partition = `login-navigation-${mode}-${Date.now()}`;
  const isolated = session.fromPartition(partition);
  await isolated.protocol.handle('https', request => {
    if (request.url === home) return new Response(`<a id="login" href="${login}">Login fixture</a><iframe src="https://www.1688.com/frame"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
    return new Response('<p>Local navigation fixture</p>', { headers: { 'Content-Type': 'text/html' } });
  });
  const window = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true } });
  window.contentView.addChildView(view);
  const entry = { id: mode, view, url: home, navigationTarget: '', pendingNavigation: '', pageLoaded: true, kind: 'home' };
  let calls = 0;
  let complete;
  let fail;
  const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const timeout = setTimeout(() => fail(new Error(`${mode}: login was not promoted`)), 6000);
  const context = vm.createContext({
    URL, URLSearchParams, view, entry,
    activeProductTabId: mode,
    NAVIGATION_HOST_FAMILIES: { taobao: ['taobao.com', 'tmall.com'], '1688': ['1688.com'] },
    normalizeNavigationUrl: value => String(value || ''),
    navigationHostAllowed: value => ['www.1688.com', 'login.1688.com'].includes(new URL(value).hostname),
    commerceLoginUrl: () => login,
    loadProduct: async (url, tabId, kind) => {
      try {
        calls += 1;
        assert.equal(url, login);
        assert.equal(tabId, mode);
        assert.equal(kind, 'login');
        entry.navigationTarget = url;
        entry.pendingNavigation = url;
        entry.loginSite = '1688';
        await view.webContents.loadURL(url);
        complete();
      } catch (error) { fail(error); }
    },
    recover1688LoginLanding: () => fail(new Error('Unexpected recovery')),
    rejectProductNavigation: () => fail(new Error('Unexpected rejection')),
    releaseProductNetworkCapture() {}, applyCommerceUserAgent() {},
    isDetailUrl: () => false, isVerificationUrl: () => false, detailProductKey: () => '',
  });
  try {
    await view.webContents.loadURL(home);
    vm.runInContext(code + '\n' + eventCode, context);
    const trigger = mode === 'frame'
      ? `document.querySelector('iframe').contentWindow.location.href = ${JSON.stringify(login)}`
      : "document.getElementById('login').click()";
    void view.webContents.executeJavaScript(trigger, true).catch(fail);
    await completed;
    assert.equal(calls, 1, 'Login should be promoted exactly once');
    assert.equal(view.webContents.getURL(), login);
    console.log(`PASS ${mode}: Chromium page navigation reached login once`);
  } finally {
    clearTimeout(timeout);
    window.destroy();
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  await checkNavigation('frame');
  await checkNavigation('main');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
