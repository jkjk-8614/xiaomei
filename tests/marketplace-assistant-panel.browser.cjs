const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(path.resolve(__dirname, '../tools/commerce-analysis/node_modules/playwright'));
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__captureModes = [];
      window.__heldCaptureModes = new Set();
      window.__emptyCaptureModes = new Set();
      window.__failedCaptureModes = new Set();
      window.__releaseCapture = {};
      window.electronAPI = {
        openProduct: async () => ({ ok: true }),
        captureAssistantContext: async ({ tabId, mode = 'base' }) => {
          window.__captureModes.push(mode);
          if (window.__heldCaptureModes.has(mode)) await new Promise((resolve) => { window.__releaseCapture[mode] = resolve; });
          if (window.__failedCaptureModes.has(mode)) return { ok: false, message: '模拟读取失败' };
          const hasSample = !window.__emptyCaptureModes.has(mode);
          const ebay = tabId === 'market-ebay';
          const site = ebay ? 'ebay' : 'amazon';
          const url = ebay ? 'https://www.ebay.com/itm/123456789012' : 'https://www.amazon.com/dp/B012345678';
          const productId = ebay ? '123456789012' : 'B012345678';
          const facts = [
            { label: '平台', value: ebay ? 'eBay' : '亚马逊' },
            { label: '站点', value: ebay ? 'www.ebay.com' : 'www.amazon.com' },
            { label: '标题', value: ebay ? 'eBay 阅读灯' : '亚马逊 阅读灯' },
            { label: ebay ? '刊登编号' : 'ASIN', value: productId },
            { label: '价格', value: 'US $29.99' },
          ];
          const resources = [{ id: `${site}-product-info`, token: '@商品信息', label: '商品信息' }];
          if (mode === 'detail' && hasSample) resources.push({ id: `${site}-detail-images`, token: '@详情图片', label: '详情图片' });
          if (mode === 'reviews' && hasSample) resources.push({ id: `${site}-reviews`, token: '@用户评价', label: '用户评价' });
          return { ok: true, url, page_context: {
            url, title: facts[2].value, structured: { kind: `${site}-product`, title: facts[2].value, facts, resources,
              excerpt: mode === 'detail' && hasSample ? '三档亮度，可折叠灯臂。' : '', marketplace: {
              productId, mainImage: 'https://images.example.test/main.jpg', mainImageCount: 1,
              detailImageCount: mode === 'detail' && hasSample ? 1 : 0, reviewSampleCount: mode === 'reviews' && hasSample ? 1 : 0, captureMode: mode,
            } },
            images: mode === 'detail' && hasSample ? [{ url: 'https://images.example.test/detail.jpg' }] : [],
            comments: mode === 'reviews' && hasSample ? [{ text: '亮度稳定，包装完整。' }] : [],
            capturedAt: Date.now(),
          } };
        },
      };
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'marketplace-panel.test') return route.abort();
      if (url.pathname.startsWith('/static/')) {
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
      }
      if (url.pathname === '/api/chat/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","content":"已收到资料"}\n\ndata: {"type":"done"}\n\n' });
      return route.fulfill({ json: { ok: true, items: [], providers: [], api_providers: [], conversations: [] } });
    });
    await page.goto('http://marketplace-panel.test/static/commerce-analysis.html?desktop=1');
    await page.evaluate(() => document.getElementById('commerceWorkbench').style.setProperty('--assistant-width', '880px'));
    const open = async (tabId, url, revision = 1) => page.evaluate(({ tabId, url, revision }) => window.postMessage({
      type: 'electron-commerce-surface', tabId, url, title: '商品页面', ready: true,
      navigationRevision: revision, committedNavigationRevision: revision, languageMode: 'native',
    }, '*'), { tabId, url, revision });
    await open('market-amazon', 'https://www.amazon.com/dp/B012345678');
    await page.locator('#productSummaryTitle').getByText('亚马逊 阅读灯').waitFor();
    assert.equal(await page.locator('#productInfoCard').isVisible(), true);
    assert.equal(await page.locator('#productInfoBody').isVisible(), true);
    assert.equal(await page.locator('#productSummaryIdLabel').innerText(), 'ASIN');
    assert.equal(await page.locator('#productSummaryId').innerText(), 'B012345678');
    assert.equal(await page.locator('.site-page-context-title').innerText(), '已帮你看了这个商品');
    assert.ok((await page.locator('.site-page-context-preview').innerText()).includes('价格：US $29.99'));
    assert.ok((await page.locator('.site-page-context-resources').innerText()).includes('@商品信息'));
    assert.equal(await page.locator('#siteQuickGrid').getByText('检查品牌、卖点与配送').count(), 1);
    await page.evaluate(() => document.getElementById('commerceWorkbench').style.setProperty('--assistant-width', '390px'));
    assert.equal(await page.locator('.assistant-panel').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, 'marketplace summary fits the normal assistant width');
    await page.evaluate(() => document.getElementById('commerceWorkbench').style.setProperty('--assistant-width', '880px'));
    assert.equal(await page.locator('.marketplace-review-preview p').count(), 0);
    assert.equal(await page.locator('.marketplace-image-preview img').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__captureModes), ['base']);
    await page.screenshot({ path: path.join(os.tmpdir(), 'xiaomei-marketplace-panel.png') });
    await page.locator('[data-marketplace-read="detail"]').click();
    await page.locator('.marketplace-image-preview img').waitFor();
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.locator('.marketplace-review-preview p').waitFor();
    assert.equal(await page.locator('#siteQuickGrid').getByText('检查商品描述结构').count(), 1, 'the clicked detail copy enables text structure analysis');
    assert.equal(await page.locator('#siteQuickGrid').getByText('分析买家评价').count(), 1, 'the clicked review sample enables review analysis');
    assert.deepEqual(await page.evaluate(() => window.__captureModes), ['base', 'detail', 'reviews']);
    await page.evaluate(() => { window.__heldCaptureModes.add('detail'); window.__heldCaptureModes.add('base'); });
    await page.locator('[data-marketplace-read="detail"]').click();
    await page.waitForFunction(() => typeof window.__releaseCapture.detail === 'function');
    await page.evaluate(() => document.getElementById('refreshPageContext').click());
    await page.waitForFunction(() => typeof window.__releaseCapture.base === 'function');
    await page.evaluate(() => window.__releaseCapture.detail());
    await page.locator('.marketplace-image-preview img').waitFor();
    await page.evaluate(() => window.__releaseCapture.base());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.marketplace-image-preview img').count(), 1, 'a delayed base response must keep a clicked detail sample');
    assert.equal(await page.locator('.marketplace-review-preview p').count(), 1, 'a delayed base response must keep an earlier review sample');
    await page.evaluate(() => window.__heldCaptureModes.clear());
    await page.locator('#chatInput').fill('这件商品的评价重点是什么？');
    const outgoing = page.waitForRequest('**/api/chat/stream');
    await page.locator('#chatSend').click();
    const payload = (await outgoing).postDataJSON();
    assert.equal(payload.page_context.comments.length, 1, 'clicked review sample reaches the model context');
    assert.equal(payload.page_context.images.length, 1, 'clicked detail image signal remains in the current context');
    assert.deepEqual(payload.link_job_ids, [], 'marketplace chat cannot attach a previous Taobao job');
    assert.deepEqual(await page.evaluate(() => window.__captureModes), ['base', 'detail', 'reviews', 'detail', 'base'], 'sending must preserve deferred samples');
    assert.equal(await page.locator('[data-marketplace-read="detail"]').count(), 1, 'sending keeps the marketplace resource cards');
    await page.evaluate(() => window.__failedCaptureModes.add('detail'));
    await page.locator('[data-marketplace-read="detail"]').click();
    await page.locator('[data-marketplace-read="detail"] .resource-count').getByText('读取失败，点击重试').waitFor();
    assert.equal(await page.locator('#siteQuickGrid').getByText('检查商品描述结构').count(), 0, 'failed detail retry removes its old text analysis');
    await page.evaluate(() => window.__failedCaptureModes.clear());
    await open('market-ebay', 'https://www.ebay.com/itm/123456789012');
    await page.locator('#productSummaryTitle').getByText('eBay 阅读灯').waitFor();
    assert.equal(await page.locator('#productSummaryIdLabel').innerText(), '刊登编号');
    assert.equal(await page.locator('.marketplace-review-preview p').count(), 0);
    assert.equal(await page.locator('.marketplace-image-preview img').count(), 0);
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.locator('.marketplace-review-preview p').waitFor();
    await page.evaluate(() => window.__failedCaptureModes.add('reviews'));
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.locator('[data-marketplace-read="reviews"] .resource-count').getByText('读取失败，点击重试').waitFor();
    assert.equal(await page.locator('#siteQuickGrid').getByText('分析商品评价').count(), 0, 'a failed retry cannot keep an old review sample available for analysis');
    await page.evaluate(() => window.__failedCaptureModes.clear());
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.locator('.marketplace-review-preview p').waitFor();
    await page.evaluate(() => window.__emptyCaptureModes.add('reviews'));
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.locator('[data-marketplace-read="reviews"] .resource-count').getByText('当前页未读取到').waitFor();
    assert.equal(await page.locator('.marketplace-review-preview p').count(), 0, 'an empty retry removes the previous review preview');
    assert.equal(await page.locator('#siteQuickGrid').getByText('分析商品评价').count(), 0, 'an empty retry removes the review analysis action');
    await page.evaluate(() => window.__emptyCaptureModes.clear());
    await page.evaluate(() => window.__heldCaptureModes.add('reviews'));
    await page.locator('[data-marketplace-read="reviews"]').click();
    await page.waitForFunction(() => typeof window.__releaseCapture.reviews === 'function');
    const capturesBeforeReload = await page.evaluate(() => window.__captureModes.length);
    await open('market-ebay', 'https://www.ebay.com/itm/123456789012', 2);
    await page.waitForFunction((count) => window.__captureModes.length > count, capturesBeforeReload);
    await page.evaluate(() => window.__releaseCapture.reviews());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.marketplace-review-preview p').count(), 0, 'a previous document cannot restore clicked reviews after reloading the same URL');
    assert.deepEqual(errors, []);
    console.log('Marketplace panel, deferred clicks, and tab isolation passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
