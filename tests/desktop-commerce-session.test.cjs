const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const functions = [
  'commerceSessionPartition', 'isCommerceLoginRedirectUrl', 'isLoginUrl', 'is1688LoginTarget',
  'encodedValueTargets1688', 'is1688LoginBridgeUrl', 'isTaobaoWebsiteUrl',
  'navigationHostFamily', 'is1688WebsiteUrl', 'is1688LoginNavigationUrl',
  'matchesPending1688Navigation', 'navigationMatchesTarget', 'normalizeNavigationUrl',
  'detailProductKey', 'reconcileCommerceCapturePayload', 'waitForCommerceProductAfterLoginRedirect',
  'ensureProductView', 'activateProductView', 'loadProduct', 'isLegacy1688Cookie',
  'cookieMigrationKey', 'migrateLegacy1688Cookies',
];
const taobao = 'persist:xiaomei-commerce';
const wholesale = 'persist:xiaomei-1688';
const home = 'https://www.1688.com/';
const detail = 'https://detail.1688.com/offer/123456789.html';

function setup() {
  const sessions = new Map();
  const context = vm.createContext({
    URL, URLSearchParams, String, Map, setTimeout,
    TAOBAO_SESSION_PARTITION: taobao,
    SESSION_1688_PARTITION: wholesale,
    SELLER_SESSION_PARTITION: 'persist:xiaomei-qianniu',
    OZON_DIRECT_SESSION_PARTITION: 'persist:xiaomei-ozon-direct',
    LEGACY_1688_COOKIE_URLS: [
      'https://www.1688.com/', 'https://login.1688.com/',
      'https://pass.1688.com/', 'https://login.taobao.com/',
    ],
    NAVIGATION_HOST_FAMILIES: { taobao: ['taobao.com', 'tmall.com', 'tb.cn'], '1688': ['1688.com'] },
    productViews: new Map(), activeProductTabId: '', productView: null, productUrl: '', lastSurfaceBounds: null,
    mainWindow: { contentView: { addChildView() {} } },
    WebContentsView: class {
      constructor({ webPreferences: { partition } }) {
        if (!sessions.has(partition)) sessions.set(partition, { marker: '' });
        let url = '';
        this.webContents = {
          session: sessions.get(partition), getURL: () => url, getTitle: () => '',
          getUserAgent: () => 'test-browser', setBackgroundThrottling() {}, isDestroyed: () => false,
          loadURL: async value => { url = value; },
        };
      }
    },
    disposeProductView(entry) { entry.disposed = true; },
    attachProductView() {}, setProductViewVisibilityState() {}, hideProductViews() {},
    refreshProductViewVisibility() {}, sendSurfaceState() {}, scheduleCommerceSurfaceResync() {},
    normalizeNavigationUrl: value => String(value || ''), desktop1688EntryUrl: value => value,
    preferAmazonChineseUrl: value => value, navigationHostAllowed: () => true,
    isDetailUrl: value => /detail\.1688\.com\/offer\/|detail\.tmall\.com\/item\.htm|item\.taobao\.com\/item\.htm/i.test(String(value || '')), applyCommerceUserAgent() {},
    ensureProductNetworkCapture() {}, releaseProductNetworkCapture() {},
    isAmazonUrl: () => false, productNavigationIsCurrent: () => true,
    beginProductNavigation(entry, value) {
      entry.navigationTarget = value;
      entry.pendingNavigation = value;
      return { navigationRevision: 1 };
    },
    shouldRecover1688LoginLanding: () => false,
    committedNavigationUrl: (_entry, value) => value,
    commitProductNavigation: (entry, value) => { entry.url = value; },
    syncCommercePageActiveFromRenderer: async () => {},
  });
  const copied = [];
  const sourceCookies = [
    { domain: '.1688.com', path: '/', name: 'auth_cookie', value: 'source-only', secure: true, httpOnly: true },
    { domain: 'login.taobao.com', path: '/', name: 'sso_cookie', value: 'sso-only', secure: true, httpOnly: true },
    { domain: '.taobao.com', path: '/', name: 'parent_sso_cookie', value: 'parent-sso', secure: true, httpOnly: true },
    { domain: '.1688.com', path: '/', name: 'existing_cookie', value: 'old-value', secure: true },
    { domain: '.example.com', path: '/', name: 'unrelated', value: 'must-not-copy', secure: true },
  ];
  const targetCookies = [{ domain: '.1688.com', path: '/', name: 'existing_cookie', value: 'new-value', secure: true }];
  const makeCookieSession = (cookies, canSet) => ({ cookies: {
    get: async () => cookies,
    set: async cookie => { if (canSet) copied.push(cookie); },
  } });
  context.__copied = copied;
  context.session = { fromPartition: partition => partition === taobao
    ? makeCookieSession(sourceCookies, false)
    : makeCookieSession(targetCookies, true) };
  const code = functions.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `Missing function: ${name}`);
    return match[0];
  }).join('\n');
  vm.runInContext(code, context);
  return context;
}

test('1688 unified login keeps the original view and new detail tabs share its session', async () => {
  const app = setup();
  await app.loadProduct(home, 'home');
  const original = app.productViews.get('home');
  original.view.webContents.session.marker = 'synthetic-login';
  await app.loadProduct('https://login.taobao.com/jump?from=1688web', 'home', 'login');
  assert.equal(app.productViews.get('home'), original);
  assert.equal(original.loginSite, '1688');
  assert.equal(app.navigationMatchesTarget(original, 'https://pass.1688.com/'), true);
  await original.view.webContents.loadURL(home);
  await app.loadProduct(detail, 'detail');
  assert.equal(app.productViews.get('detail').view.webContents.session, original.view.webContents.session);
  assert.equal(app.productViews.get('detail').view.webContents.session.marker, 'synthetic-login');
  assert.equal(original.disposed, undefined);
});

test('unlabelled official login inherits 1688 context and permits its return path', async () => {
  const app = setup();
  await app.loadProduct(detail, 'detail');
  const original = app.productViews.get('detail');
  await app.loadProduct('https://login.taobao.com/member/login.jhtml', 'detail', 'login');
  assert.equal(app.productViews.get('detail'), original);
  assert.equal(original.loginSite, '1688');
  const pendingLogin = { ...original, navigationTarget: 'https://login.taobao.com/member/login.jhtml' };
  assert.equal(app.navigationMatchesTarget(pendingLogin, detail), true);
  assert.equal(app.navigationMatchesTarget(pendingLogin, 'https://example.com/'), false);
  assert.equal(app.navigationMatchesTarget(pendingLogin, 'https://www.taobao.com/'), false);
  assert.equal(app.activateProductView('detail', { kind: 'login', site: '1688', url: 'https://login.taobao.com/' }), original);
});

test('explicit 1688 login return parameters select the same partition in a new tab', () => {
  const app = setup();
  for (const name of ['target', 'redirect_url', 'redirectUrl', 'Done', 'done', 'return_url', 'returnUrl']) {
    const url = `https://login.taobao.com/jump?${name}=${encodeURIComponent(encodeURIComponent(detail))}`;
    assert.equal(app.commerceSessionPartition('login', '', url), wholesale, name);
  }
  assert.equal(app.commerceSessionPartition('login', '', 'https://www.taobao.com/markets/sso?Done=' + encodeURIComponent(home)), wholesale);
});

test('ordinary Taobao navigation leaves the 1688 partition and seller sessions stay separate', async () => {
  const app = setup();
  await app.loadProduct(home, 'tab');
  const original = app.productViews.get('tab');
  await app.loadProduct('https://www.taobao.com/', 'tab');
  assert.equal(app.productViews.get('tab').partition, taobao);
  assert.equal(original.disposed, true);
  assert.equal(app.commerceSessionPartition('login', '', 'https://login.taobao.com/'), taobao);
  assert.equal(app.commerceSessionPartition('home', '1688', 'https://www.taobao.com/', wholesale), taobao);
  assert.equal(app.commerceSessionPartition('seller', '', 'https://myseller.taobao.com/'), 'persist:xiaomei-qianniu');
  assert.equal(app.commerceSessionPartition('seller', '', 'https://sycm.taobao.com/'), 'persist:xiaomei-qianniu');
  assert.equal(app.commerceSessionPartition('login', '', 'https://login.taobao.com/?Done=https%3A%2F%2Fnot1688.com%2F'), taobao);
});

test('Tmall login_jump is treated as an official login redirect', () => {
  const app = setup();
  const redirect = 'https://detail.tmall.com/wow/z/app/tbpc/pc-detail-ssr-2025/home/_____tmd_____/page/login_jump';
  assert.equal(app.isCommerceLoginRedirectUrl(redirect), true);
  assert.equal(app.isLoginUrl(redirect), true);
  assert.equal(app.isLoginUrl(detail), false);
});

test('transient login_jump waits for the requested product page to return', async () => {
  const app = setup();
  const requested = 'https://detail.1688.com/offer/123456789.html';
  let current = 'https://detail.1688.com/wow/z/app/tbpc/page/login_jump';
  const webContents = { getURL: () => current };
  const pending = app.waitForCommerceProductAfterLoginRedirect(webContents, requested, 2000);
  setTimeout(() => { current = requested; }, 250);
  assert.equal(await pending, requested);
});

test('transient Tmall login_jump does not invalidate a matching product capture', () => {
  const app = setup();
  const requested = 'https://detail.tmall.com/item.htm?id=895845491285&skuId=5914991846544';
  const redirect = 'https://detail.tmall.com/wow/z/app/tbpc/pc-detail-ssr-2025/home/_____tmd_____/page/login_jump';
  const capture = {
    original_url: redirect,
    final_url: redirect,
    product: { title: '铝合金画框定制a3海报框裱框挂墙a4卡纸装裱展示框正方形相框空框' },
    mainImages: ['https://img.alicdn.com/example.jpg'],
  };
  const reconciled = app.reconcileCommerceCapturePayload(capture, requested, [redirect, requested]);
  assert.equal(reconciled.original_url, requested);
  assert.equal(reconciled.final_url, requested);
});

test('capture URL reconciliation does not accept a different product', () => {
  const app = setup();
  const requested = 'https://detail.tmall.com/item.htm?id=895845491285';
  const redirect = 'https://detail.tmall.com/wow/z/app/tbpc/pc-detail-ssr-2025/home/_____tmd_____/page/login_jump';
  const otherProduct = 'https://detail.tmall.com/item.htm?id=1000000000000';
  const capture = { final_url: redirect, product: { title: '商品标题' } };
  const reconciled = app.reconcileCommerceCapturePayload(capture, requested, [otherProduct]);
  assert.equal(reconciled, capture);
});

test('legacy 1688 cookies migrate into the new partition without overwriting target state', async () => {
  const app = setup();
  const result = await app.migrateLegacy1688Cookies();
  assert.equal(result.ok, true);
  assert.equal(result.copied, 3);
  assert.deepEqual(app.__copied.map(cookie => cookie.name).sort(), ['auth_cookie', 'parent_sso_cookie', 'sso_cookie']);
  assert.equal(app.__copied.some(cookie => cookie.name === 'existing_cookie'), false);
  assert.equal(app.__copied.some(cookie => cookie.name === 'unrelated'), false);
});
