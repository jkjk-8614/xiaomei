const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '../tools/commerce-analysis/node_modules/playwright'));
const { marketplaceCaptureScript } = require('../desktop/marketplace-assistant.cjs');

const cases = [
  ['amazon', 'https://www.amazon.com/dp/B012345678', '<div id="altImages"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div id="aplus"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div id="cm_cr-review_list"><div data-hook="review">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['aliexpress', 'https://www.aliexpress.com/item/1005001234567890.html', '<div class="slider"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div id="product-description"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div id="nav-review"><div class="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['shopee', 'https://shopee.sg/desk-light-i.12345.67890', '<div class="product-image"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div class="product-detail"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div class="product-ratings"><div class="rating-main">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['temu', 'https://www.temu.com/goods.html?goods_id=987654321', '<div class="goods-gallery"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div class="goods-detail"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div class="review-list"><div class="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['ozon', 'https://www.ozon.ru/product/desk-light-123456789/', '<div data-widget="webGallery"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div data-widget="webDescription"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div data-widget="webReviews"><div class="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['ebay', 'https://www.ebay.com/itm/123456789012', '<div class="ux-image-carousel"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div data-testid="item-description"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div data-testid="reviews-section"><div data-testid="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['shein', 'https://www.shein.com/desk-light-p-12345678.html', '<div class="product-intro__gallery"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div id="product-intro-detail"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div id="product-review"><div class="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
  ['tiktok-shop', 'https://shop.tiktok.com/view/product/123456789012', '<div data-e2e="product-gallery"><img src="https://images.example.test/main.jpg" style="width:180px;height:180px"></div>', '<div data-e2e="product-description"><img src="https://images.example.test/detail.jpg" style="width:180px;height:180px"></div>', '<div data-e2e="product-reviews"><div data-e2e="review-item">包装很好，尺寸准确，做工也符合预期。</div></div>'],
];
const platformExtras = {
  temu: '<del>US $49.99</del>',
  ebay: '<div class="x-item-condition-text">Used</div><button id="bidBtn_btn">Bid</button><div class="ux-labels-values--returns">30 day returns</div>',
  shein: '<div class="size-guide">Size guide</div><div class="color-list"><img src="https://images.example.test/sku.jpg" style="width:180px;height:180px"></div>',
};
const expectedProductActions = {
  amazon: '检查品牌、卖点与配送',
  aliexpress: '检查规格与跨境配送',
  shopee: '检查本地卖点与履约',
  temu: '检查价格与规格表达',
  ozon: '检查参数与配送',
  ebay: '检查成色与交易风险',
  shein: '检查尺码与面料',
  'tiktok-shop': '检查商品卖点与视频线索',
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [site, url, gallery, detail, reviews] of cases) {
      const page = await browser.newPage();
      const describedDetail = detail.replace(/<\/div>$/, '<p>三档亮度，可折叠灯臂。</p></div>');
      await page.route('**/*', (route) => route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body><h1>桌面阅读灯</h1>${gallery}${platformExtras[site] || ''}${describedDetail}${reviews}</body></html>` })
        : route.abort());
      await page.goto(url);
      await page.addScriptTag({ path: path.resolve(__dirname, '../static/js/commerce-assistant-profiles.js') });
      const classified = await page.evaluate((value) => window.XiaomeiCommerceAssistantProfiles.classify(value), url);
      assert.equal(classified.pageType, 'product', `${site} page type`);
      const base = await page.evaluate(marketplaceCaptureScript(site));
      assert.equal(base.ok, true, `${site} base capture`);
      assert.equal(base.pageType, 'product', `${site} capture type`);
      assert.equal(base.images.length, 0, `${site} detail images must wait for click`);
      assert.equal(base.comments.length, 0, `${site} reviews must wait for click`);
      assert.equal(base.structured.marketplace.mainImageCount, 1, `${site} main image`);
      const facts = new Map(base.structured.facts.map((entry) => [entry.label, entry.value]));
      if (site === 'temu') assert.equal(facts.get('划线价'), 'US $49.99');
      if (site === 'ebay') { assert.equal(facts.get('成色'), 'Used'); assert.equal(facts.get('交易方式'), '拍卖'); assert.equal(facts.get('退货'), '30 day returns'); }
      if (site === 'shein') { assert.equal(facts.get('尺码表'), 'Size guide'); assert.equal(base.structured.marketplace.skuImageCount, 1); }
      const view = await page.evaluate((snapshot) => window.XiaomeiCommerceAssistantProfiles.build({ ...snapshot, url: location.href }), base);
      assert.equal(view.profile.site, site);
      assert.ok(view.resources.some((item) => item.id === `${site}-product-info`));
      assert.ok(!view.resources.some((item) => item.id === `${site}-reviews`));
      assert.ok(view.actions.some((item) => item.label === expectedProductActions[site]), `${site} product analysis must match the platform`);
      assert.ok(!view.actions.some((item) => /诊断.*图|视频诊断/.test(item.label)), `${site} cannot claim visual diagnosis from image URLs`);
      const preview = await page.evaluate((snapshot) => {
        const built = window.XiaomeiCommerceAssistantProfiles.build({ ...snapshot, url: location.href });
        return window.XiaomeiCommerceAssistantProfiles.pagePreview(built);
      }, base);
      assert.equal(preview.title, '已帮你看了这个商品');
      assert.ok(preview.resources.some((item) => item.token === '@商品信息'));
      assert.ok(preview.facts.some((item) => item.label === '主图' && /页面可见 1 张/.test(item.value)));
      assert.match(preview.note, /画面未送入模型/);
      if (site === 'ebay') assert.ok(preview.facts.some((item) => item.label === '成色' && item.value === 'Used'));
      const detailResult = await page.evaluate(marketplaceCaptureScript(site, 'detail'));
      assert.equal(detailResult.images.length, 1, `${site} detail image after click`);
      assert.match(detailResult.structured.excerpt, /三档亮度/, `${site} captures visible detail copy after click`);
      const detailView = await page.evaluate((snapshot) => window.XiaomeiCommerceAssistantProfiles.build({ ...snapshot, url: location.href }), detailResult);
      assert.ok(detailView.actions.some((item) => item.id === `${site}-detail-analysis`));
      const reviewResult = await page.evaluate(marketplaceCaptureScript(site, 'reviews'));
      assert.equal(reviewResult.comments.length, 1, `${site} review after click`);
      const reviewView = await page.evaluate((snapshot) => window.XiaomeiCommerceAssistantProfiles.build({ ...snapshot, url: location.href }), reviewResult);
      assert.ok(reviewView.actions.some((item) => item.id === `${site}-review-analysis`));
      await page.close();
    }
    const pageTypes = [
      ['amazon', 'https://www.amazon.com/s?k=lamp', 'https://www.amazon.com/stores/example/page/123'],
      ['aliexpress', 'https://www.aliexpress.com/w/wholesale-lamp.html', 'https://www.aliexpress.com/store/123'],
      ['shopee', 'https://shopee.sg/search?keyword=lamp', 'https://shopee.sg/shop/123'],
      ['temu', 'https://www.temu.com/search_result.html?search_key=lamp', 'https://www.temu.com/store/123'],
      ['ozon', 'https://www.ozon.ru/search/?text=lamp', 'https://www.ozon.ru/seller/123'],
      ['ebay', 'https://www.ebay.com/sch/i.html?_nkw=lamp', 'https://www.ebay.com/str/example'],
      ['shein', 'https://www.shein.com/pdsearch/lamp/', 'https://www.shein.com/store/123'],
      ['tiktok-shop', 'https://shop.tiktok.com/search?keyword=lamp', 'https://shop.tiktok.com/shop/123'],
    ];
    for (const [site, searchUrl, shopUrl] of pageTypes) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: `<html><head><title>商品列表</title></head><body><a href="${cases.find((item) => item[0] === site)[1]}">桌面阅读灯</a></body></html>` })
        : route.abort());
      for (const [url, expected] of [[searchUrl, 'search'], [shopUrl, 'shop']]) {
        await page.goto(url);
        await page.addScriptTag({ path: path.resolve(__dirname, '../static/js/commerce-assistant-profiles.js') });
        assert.equal(await page.evaluate((value) => window.XiaomeiCommerceAssistantProfiles.classify(value)?.pageType, url), expected, `${site} ${expected} profile`);
        const snapshot = await page.evaluate(marketplaceCaptureScript(site));
        assert.equal(snapshot.pageType, expected, `${site} ${expected} capture`);
        const view = await page.evaluate((value) => window.XiaomeiCommerceAssistantProfiles.build({ ...value, url: location.href }), snapshot);
        assert.deepEqual(view.actions.map((item) => item.label), [expected === 'shop' ? '分析当前店铺商品' : '分析当前搜索结果'], `${site} ${expected} uses a page-specific action`);
        assert.ok(view.actions[0].prompt.includes('@商品列表'));
      }
      await page.close();
    }
    const deferredPage = await browser.newPage();
    await deferredPage.route('**/*', (route) => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<html><body><h1 id="productTitle">阅读灯</h1><button onclick="document.getElementById(\'cm_cr-review_list\').style.display=\'block\'">Reviews</button><div id="cm_cr-review_list" style="display:none"><div data-hook="review">颜色准确，包装完整，亮度适合阅读。</div></div></body></html>' })
      : route.abort());
    await deferredPage.goto('https://www.amazon.com/dp/B012345678');
    const deferredBase = await deferredPage.evaluate(marketplaceCaptureScript('amazon'));
    assert.equal(deferredBase.comments.length, 0);
    const deferredReviews = await deferredPage.evaluate(marketplaceCaptureScript('amazon', 'reviews'));
    assert.equal(deferredReviews.comments.length, 1, 'review tab opens only after the explicit request');
    await deferredPage.close();
    const missingPage = await browser.newPage();
    await missingPage.route('**/*', (route) => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<html><body><h1>阅读灯</h1></body></html>' })
      : route.abort());
    await missingPage.goto('https://www.ebay.com/itm/123456789012');
    const missingReviews = await missingPage.evaluate(marketplaceCaptureScript('ebay', 'reviews'));
    assert.equal(missingReviews.comments.length, 0);
    assert.equal(missingReviews.structured.resources.some((item) => item.id === 'ebay-reviews'), false);
    assert.match(missingReviews.structured.marketplace.reason, /未找到已加载的评价区/);
    await missingPage.close();
    const searchWithProductLink = await browser.newPage();
    await searchWithProductLink.route('**/*', (route) => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<html><head><title>阅读灯搜索</title></head><body><a href="/dp/B012345678">桌面阅读灯</a></body></html>' })
      : route.abort());
    await searchWithProductLink.goto('https://www.amazon.com/s?k=lamp&next=/dp/B012345678');
    assert.equal((await searchWithProductLink.evaluate(marketplaceCaptureScript('amazon'))).pageType, 'search', 'a product path in the query cannot turn search into a product page');
    await searchWithProductLink.close();
    const lazyDetailPage = await browser.newPage();
    await lazyDetailPage.route('**/*', (route) => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<html><body><h1 id="productTitle">桌面阅读灯</h1><div id="aplus"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="https://images.example.test/lazy-detail.jpg" style="width:180px;height:180px"></div></body></html>' })
      : route.abort());
    await lazyDetailPage.goto('https://www.amazon.com/dp/B012345678');
    await lazyDetailPage.addScriptTag({ path: path.resolve(__dirname, '../static/js/commerce-assistant-profiles.js') });
    const lazyDetail = await lazyDetailPage.evaluate(marketplaceCaptureScript('amazon', 'detail'));
    assert.equal(lazyDetail.images[0]?.url, 'https://images.example.test/lazy-detail.jpg', 'a lazy image with a tiny placeholder still has a readable detail URL');
    const imageOnlyView = await lazyDetailPage.evaluate((snapshot) => window.XiaomeiCommerceAssistantProfiles.build({ ...snapshot, url: location.href }), lazyDetail);
    assert.ok(!imageOnlyView.actions.some((item) => item.id === 'amazon-detail-analysis'), 'image URLs without visible copy cannot enable a text structure analysis');
    await lazyDetailPage.close();
    const delayedSectionPage = await browser.newPage();
    const delayedBody = `<html><body><h1 id="productTitle">桌面阅读灯</h1>
      <button onclick="setTimeout(() => { document.getElementById('aplus').style.display = 'block'; }, 900)">Details</button>
      <div id="aplus" style="display:none"><img src="https://images.example.test/delayed-detail.jpg" style="width:180px;height:180px"></div>
      <button onclick="setTimeout(() => { const item = document.createElement('div'); item.setAttribute('data-hook', 'review'); item.textContent = '包装完整，灯光稳定，放在桌面上很好用。'; document.getElementById('reviewsMedley').append(item); }, 900)">Reviews</button>
      <div id="reviewsMedley"></div></body></html>`;
    await delayedSectionPage.route('**/*', (route) => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: delayedBody })
      : route.abort());
    await delayedSectionPage.goto('https://www.amazon.com/dp/B012345678');
    const delayedDetail = await delayedSectionPage.evaluate(marketplaceCaptureScript('amazon', 'detail'));
    assert.equal(delayedDetail.images[0]?.url, 'https://images.example.test/delayed-detail.jpg', 'the clicked detail tab may render its content after the first half-second');
    const delayedReviews = await delayedSectionPage.evaluate(marketplaceCaptureScript('amazon', 'reviews'));
    assert.equal(delayedReviews.comments.length, 1, 'the clicked review tab may populate its section after the first half-second');
    await delayedSectionPage.close();
    console.log('Eight marketplace product, search, shop, and deferred section checks passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
