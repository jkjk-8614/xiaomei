const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const { filterCommerceMainImages } = require('../tools/commerce-analysis/commerce-product-state.cjs');
const extract = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
const url = 'https://detail.tmall.com/item.htm?id=123456789';

function setup(options = {}) {
  const reads = [];
  const progress = [];
  const network = { records: { reviews: [], questions: [], detail: [{}] }, ready: Promise.resolve(),
    settle: async () => {}, parseModule: () => ({ detail: { images: ['https://img.example/detail.jpg'] } }) };
  const webContents = { id: 1, getURL: () => url, getTitle: () => '测试商品',
    executeJavaScript: async script => {
      reads.push(script);
      if (options.hang) return new Promise(() => {});
      if (script === 'product') return { product: { id: '123456789', title: '测试商品', reviewCount: '20', questionCount: '3' },
        mainImages: ['https://img.example/main.jpg'], detail: { images: ['https://img.example/detail.jpg'] },
        videos: [{ url: 'https://img.example/video.mp4' }], reviewStats: { totalCount: '20' }, questionStats: { totalCount: '3' } };
      if (script === 'sku') return { available: true, matrixComplete: true, items: [{ id: '1', propPath: '1:2', specs: '红色' }], itemCount: 1 };
      if (script === 'detail') return { ok: true, images: ['https://img.example/detail.jpg'] };
      throw new Error('Unexpected duplicate DOM scan');
    } };
  const entry = { id: 'tab', view: { webContents }, domReady: true, pageLoaded: false, navigationRevision: 1, url, networkCapture: network, ...options.entry };
  if (options.hangNetwork) network.ready = new Promise(() => {});
  const context = vm.createContext({
    URL, Map, Set, Date, Promise, setTimeout, clearTimeout, process,
    productViews: new Map([['tab', entry]]), activeProductEntry: () => entry, productView: entry.view, productUrl: url, activeProductTabId: 'tab',
    activeCommerceCollections: new Map(), INTERACTIVE_COMMERCE_MODULES: new Set(['reviews', 'questions', 'reviews_questions']),
    COMMERCE_REVIEW_SAMPLE_LIMIT: 2000,
    hostAllowed: () => true, isLoginUrl: () => false, isVerificationUrl: () => false, isCommerceLoginRedirectUrl: () => false,
    productNavigationIsCurrent: (target, revision) => revision === target.navigationRevision,
    sendCollectionProgress: (_entry, value) => progress.push(value),
    ELECTRON_COMMERCE_PRODUCT_STATE_SCRIPT: 'product', ELECTRON_COMMERCE_STRUCTURED_SKU_SCRIPT: 'sku', ELECTRON_COMMERCE_DETAIL_REVEAL_SCRIPT: 'detail',
    enrichCommerceProductCategory: async value => value, filterCommerceMainImages,
    reconcileCommerceCapturePayload: value => value, redact: value => value,
  });
  vm.runInContext(extract('captureProduct'), context);
  return { context, entry, reads, progress, capture: () => context.captureProduct({ tabId: 'tab', module: 'base' }) };
}

test('DOM-ready product returns images without waiting for full page load or rescanning product state', async () => {
  const fixture = setup();
  const result = await fixture.capture();
  assert.equal(result.ok, true);
  assert.equal(result.mainImages[0], 'https://img.example/main.jpg');
  assert.equal(result.reviewStats.totalCount, '20');
  assert.equal(result.questionStats.totalCount, '3');
  assert.deepEqual(fixture.reads, ['product', 'sku', 'detail']);
  assert.equal(fixture.context.activeCommerceCollections.size, 0);
});

test('failed or unopened documents do not start a collection', async () => {
  for (const entry of [{ loadFailed: true }, { domReady: false, pageLoaded: false }]) {
    const fixture = setup({ entry });
    const result = await fixture.capture();
    assert.equal(result.ok, false);
    assert.match(result.status, /^page_/);
    assert.equal(fixture.reads.length, 0);
    assert.equal(fixture.progress.length, 0);
  }
});

test('a stalled Network.enable does not block product images', async () => {
  const fixture = setup({ hangNetwork: true });
  const started = Date.now();
  assert.equal((await fixture.capture()).ok, true);
  assert.ok(Date.now() - started < 2500);
});

test('a stalled page script returns failure and releases the collection', async () => {
  const fixture = setup({ hang: true });
  const started = Date.now();
  const result = await fixture.capture();
  assert.equal(result.ok, false);
  assert.equal(fixture.context.activeCommerceCollections.size, 0);
  assert.ok(Date.now() - started < 11000);
});

test('cancelled Chromium navigation is guarded before retry and failure handling', () => {
  const body = source.slice(source.indexOf('function failProductNavigation'), source.indexOf('function rejectProductNavigation'));
  assert.match(body, /if \(Number\(errorCode\) === -3\) return 'aborted';/);
  assert.ok(body.indexOf("errorCode) === -3") < body.indexOf('retryProductNavigation'));
});
