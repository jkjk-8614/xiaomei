'use strict';

// Runs inside the visible marketplace tab. Only reads rendered page elements;
// a detail or review section is visited after the user requests that section.
function readMarketplacePage(site, mode) {
  const configs = {
    amazon: {
      product: /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?]|$)/i,
      search: /^\/s(?:\/|$)/i, shop: /^\/(?:stores|sp)(?:\/|$)/i,
      title: ['#productTitle', '#title h1', 'h1'], price: ['.a-price .a-offscreen', '#corePriceDisplay_desktop_feature_div .a-offscreen'],
      store: ['#bylineInfo', '#sellerProfileTriggerId'], gallery: ['#altImages img', '#imageBlock img', '#landingImage'],
      detail: ['#aplus', '#productDescription', '#feature-bullets'], reviews: ['#cm_cr-review_list', '#reviewsMedley', '#customerReviews'],
      reviewItem: ['[data-hook="review"]', '.review'], rating: ['#acrPopover', '[data-hook="rating-out-of-text"]'], reviewCount: ['#acrCustomerReviewText'],
      brand: ['#bylineInfo'], variants: ['#variation_color_name', '#variation_size_name'], skuImages: ['#variation_color_name img'],
      shipping: ['#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE'],
    },
    aliexpress: {
      product: /\/item\/[^/]+\.html(?:[?#]|$)/i,
      search: /^\/(?:w\/wholesale[^/]*|af|category|search)(?:\/|$)/i, shop: /^\/(?:store|shop)(?:\/|$)/i,
      title: ['h1[data-pl="product-title"]', '.product-title-text', 'h1'], price: ['[class*="price--current"]', '[class*="price--value"]'],
      store: ['[class*="store-header"]', '[class*="store-name"]'], gallery: ['[class*="slider"] img', '[class*="gallery"] img'],
      detail: ['#product-description', '[class*="detail--content"]', '[class*="product-description"]'], reviews: ['#nav-review', '[class*="review-list"]', '[class*="feedback-list"]'],
      reviewItem: ['[class*="review-item"]', '[class*="feedback-item"]'], rating: ['[class*="rating--"]'], reviewCount: ['[class*="review-count"]'], variants: ['[class*="sku-item"]'], skuImages: ['[class*="sku-item"] img'], shipping: ['[class*="shipping--"]'],
    },
    shopee: {
      product: /(?:-i\.\d+\.\d+|\/product\/\d+\/\d+|\/[^/]+-i\.\d+\.\d+)(?:[/?#]|$)/i,
      search: /^\/(?:search|search_result)(?:\/|$)/i, shop: /^\/(?:shop|mall)(?:\/|$)/i,
      title: ['[class*="product-briefing"] h1', 'h1'], price: ['[class*="product-briefing"] [class*="price"]', '[class*="product-price"]'],
      store: ['[class*="shop-name"]', '[class*="seller-name"]'], gallery: ['[class*="product-image"] img', '[class*="product-briefing"] img'],
      detail: ['[class*="product-detail"]', '[class*="product-description"]'], reviews: ['[class*="product-ratings"]', '[class*="product-review"]'],
      reviewItem: ['[class*="rating-main"]', '[class*="rating-item"]'], rating: ['[class*="rating-overview"]'], reviewCount: ['[class*="rating-count"]'], variants: ['[class*="product-variation"]'], skuImages: ['[class*="product-variation"] img'], sold: ['[class*="sold"]'], shipping: ['[class*="shipping"]'],
    },
    temu: {
      product: /(?:\/goods\.html|\/[^/]+-g-\d+\.html)(?:[?#]|$)/i,
      search: /^\/(?:search|search_result)(?:\.html|\/|$)/i, shop: /^\/(?:shop|store)(?:\/|$)/i,
      title: ['[data-testid="product-title"]', '[class*="goods-title"]', 'h1'], price: ['[data-testid="product-price"]', '[class*="price-value"]'],
      store: ['[class*="store-name"]'], gallery: ['[class*="goods-gallery"] img', '[class*="product-gallery"] img'],
      detail: ['[class*="goods-detail"]', '[class*="product-detail"]'], reviews: ['[class*="review-list"]', '[class*="comment-list"]'],
      reviewItem: ['[class*="review-item"]', '[class*="comment-item"]'], rating: ['[class*="rating-score"]'], reviewCount: ['[class*="review-count"]'], variants: ['[class*="sku-list"]', '[class*="specification"]'], skuImages: ['[class*="sku-list"] img'], sold: ['[class*="sold-count"]'],
      originalPrice: ['[class*="origin-price"]', '[class*="original-price"]', 'del'], shipping: ['[class*="delivery-time"]'],
    },
    ozon: {
      product: /\/product\/[^/?]+-\d+(?:[/?#]|$)/i,
      search: /^\/(?:search|category)(?:\/|$)/i, shop: /^\/(?:seller|shop)(?:\/|$)/i,
      title: ['[data-widget="webProductHeading"] h1', 'h1'], price: ['[data-widget="webPrice"]', '[class*="price"]'],
      store: ['[data-widget="webSellerName"]', '[class*="seller-name"]'], gallery: ['[data-widget="webGallery"] img', '[class*="gallery"] img'],
      detail: ['[data-widget="webDescription"]', '[data-widget="webCharacteristics"]'], reviews: ['[data-widget="webReviews"]', '[class*="review-list"]'],
      reviewItem: ['[class*="review-item"]'], rating: ['[data-widget="webRating"]'], reviewCount: ['[class*="review-count"]'], variants: ['[data-widget="webVariant"]'], skuImages: ['[data-widget="webVariant"] img'], shipping: ['[data-widget="webDelivery"]'],
    },
    ebay: {
      product: /\/itm\/(?:[^/?]+\/)?\d+(?:[/?#]|$)/i,
      search: /^\/(?:sch|b)(?:\/|$)/i, shop: /^\/(?:str|shop)(?:\/|$)/i,
      title: ['h1.x-item-title__mainTitle', '[data-testid="x-item-title"] h1', 'h1'], price: ['.x-price-primary', '[data-testid="x-price-primary"]'],
      store: ['.x-sellercard-atf__info', '[data-testid="seller-info"]'], gallery: ['#vi_main_img_fs img', '.ux-image-carousel img', '[data-testid="ux-image-carousel"] img'],
      detail: ['#desc_ifr', '#viTabs_0_is', '[data-testid="item-description"]'], reviews: ['[data-testid="reviews-section"]', '.reviews-content'],
      reviewItem: ['[data-testid="review-item"]', '.review-item'], rating: ['[data-testid="reviews-section"]'], reviewCount: ['[data-testid="review-count"]'],
      condition: ['.x-item-condition-text', '[data-testid="item-condition"]'], shipping: ['.ux-labels-values--shipping', '[data-testid="shipping-section"]'], returns: ['.ux-labels-values--returns', '[data-testid="returns-section"]'], variants: ['.x-msku__select-box'], skuImages: ['.x-msku img'],
      sellerFeedback: ['[data-testid="seller-feedback"]', '[class*="seller-feedback"]'], auction: ['#bidBtn_btn', '[data-testid="bid-action"]'],
    },
    shein: {
      product: /-p-\d+\.html(?:[?#]|$)/i,
      search: /^\/(?:pdsearch|search|category)(?:\/|$)/i, shop: /^\/(?:store|brand)(?:\/|$)/i,
      title: ['.product-intro__head-name', '[class*="goods-title"]', 'h1'], price: ['.product-intro__head-price', '[class*="sale-price"]'],
      store: ['[class*="store-name"]'], gallery: ['.product-intro__gallery img', '[class*="goods-gallery"] img'],
      detail: ['#product-intro-detail', '[class*="product-detail"]', '[class*="goods-description"]'], reviews: ['#product-review', '[class*="review-list"]'],
      reviewItem: ['[class*="review-item"]', '[class*="comment-item"]'], rating: ['[class*="rating-score"]'], reviewCount: ['[class*="review-count"]'], variants: ['[class*="size-list"]', '[class*="color-list"]'], skuImages: ['[class*="color-list"] img'], shipping: ['[class*="shipping-info"]'],
      size: ['[class*="size-guide"]'], fabric: ['[class*="material"]'],
    },
    'tiktok-shop': {
      product: /\/(?:view\/)?product\/\d+(?:[/?#]|$)/i,
      search: /^\/(?:search|search_result)(?:\/|$)/i, shop: /^\/(?:shop|store)(?:\/|$)/i,
      title: ['[data-e2e="product-title"]', '[data-testid="product-title"]', 'h1'], price: ['[data-e2e="product-price"]', '[data-testid="product-price"]'],
      store: ['[data-e2e="shop-name"]', '[data-testid="shop-name"]'], gallery: ['[data-e2e="product-gallery"] img', '[class*="product-gallery"] img'],
      detail: ['[data-e2e="product-description"]', '[data-testid="product-description"]'], reviews: ['[data-e2e="product-reviews"]', '[data-testid="product-reviews"]'],
      reviewItem: ['[data-e2e="review-item"]', '[data-testid="review-item"]'], rating: ['[data-e2e="product-rating"]'], reviewCount: ['[data-e2e="review-count"]'], variants: ['[data-e2e="sku-selector"]'], skuImages: ['[data-e2e="sku-selector"] img'], sold: ['[data-e2e="sold-count"]'], shipping: ['[data-e2e="delivery-info"]'],
    },
  };
  const config = configs[site];
  if (!config) return { ok: false, status: 'unsupported_page', message: '当前平台未配置商品资料读取' };
  const tidy = (value, limit = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const rendered = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const first = (selectors, root = document) => {
    for (const selector of selectors || []) {
      const node = [...root.querySelectorAll(selector)].find(rendered);
      if (node) return node;
    }
    return null;
  };
  const read = (selectors, limit = 240) => tidy(first(selectors)?.innerText || '', limit);
  const add = (facts, label, value) => { const clean = tidy(value, 360); if (clean) facts.push({ label, value: clean }); };
  const imgUrl = (node) => {
    for (const value of [node?.getAttribute('data-zoom-image'), node?.getAttribute('data-original'), node?.getAttribute('data-src'), node?.getAttribute('data-lazy-src'), node?.currentSrc, node?.src]) {
      if (!value) continue;
      try { const url = new URL(value, location.href); if (/^https?:$/.test(url.protocol)) return url.href; } catch {}
    }
    return '';
  };
  const imagesIn = (roots, limit = 12) => {
    const urls = new Set();
    for (const selector of roots || []) {
      for (const node of document.querySelectorAll(selector)) {
        const candidates = node.matches('img') ? [node] : node.querySelectorAll('img');
        for (const image of candidates) {
          const hasDeferredSource = ['data-zoom-image', 'data-original', 'data-src', 'data-lazy-src'].some((name) => image.getAttribute(name));
          if (!rendered(image) || image.naturalWidth && image.naturalWidth < 120 && !hasDeferredSource) continue;
          const url = imgUrl(image);
          if (url) urls.add(url);
          if (urls.size >= limit) return [...urls].map((item) => ({ url: item }));
        }
      }
    }
    return [...urls].map((item) => ({ url: item }));
  };
  const waitFor = async (readValue, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    let value = readValue();
    while (!value && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      value = readValue();
    }
    return value;
  };
  const path = location.pathname;
  const isProduct = config.product.test(path);
  const isSearch = !isProduct && config.search.test(path);
  const isShop = !isProduct && !isSearch && (config.shop.test(path) || site === 'aliexpress' && /^store\./i.test(location.hostname));
  const pageType = isProduct ? 'product' : isSearch ? 'search' : isShop ? 'shop' : 'other';
  const kind = `${site}-${pageType}`;
  const title = isProduct ? read(config.title, 260) : tidy(document.title, 260);
  const idMatch = isProduct ? location.href.match({
    amazon: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
    aliexpress: /\/item\/[^/]*?(\d{8,})\.html/i,
    shopee: /-i\.\d+\.(\d+)|\/product\/\d+\/(\d+)/i,
    temu: /(?:[?&]goods_id=|\-g\-)(\d+)/i,
    ozon: /\/(\d{6,})(?:[/?#]|$)/i,
    ebay: /\/itm\/(?:[^/?]+\/)?(\d+)/i,
    shein: /-p-(\d+)\.html/i,
    'tiktok-shop': /\/(?:view\/)?product\/(\d+)/i,
  }[site]) : null;
  const productId = idMatch?.[1] || idMatch?.[2] || '';
  const facts = [];
  const resources = [];
  const label = { amazon: '亚马逊', aliexpress: '速卖通', shopee: '虾皮 Shopee', temu: 'Temu', ozon: 'Ozon', ebay: 'eBay', shein: 'SHEIN', 'tiktok-shop': 'TikTok Shop' }[site];
  add(facts, '平台', label);
  add(facts, '站点', location.hostname);
  if (isProduct) {
    add(facts, '标题', title);
    add(facts, site === 'amazon' ? 'ASIN' : site === 'ebay' ? '刊登编号' : '商品ID', productId);
    add(facts, '价格', read(config.price, 160));
    add(facts, '划线价', read(config.originalPrice, 120));
    add(facts, '店铺', read(config.store, 160));
    add(facts, '品牌', read(config.brand, 120));
    add(facts, '规格', read(config.variants, 220));
    add(facts, '成色', read(config.condition, 120));
    add(facts, '尺码表', read(config.size, 120));
    add(facts, '面料', read(config.fabric, 120));
    add(facts, '评分', read(config.rating, 100));
    add(facts, '评价数', read(config.reviewCount, 100));
    add(facts, '销量信号', read(config.sold, 100));
    add(facts, '配送', read(config.shipping, 180));
    add(facts, '退货', read(config.returns, 180));
    add(facts, '卖家反馈', read(config.sellerFeedback, 120));
    if (site === 'ebay' && first(config.auction)) add(facts, '交易方式', '拍卖');
    const gallery = imagesIn(config.gallery, 10);
    const skuGallery = imagesIn(config.skuImages, 8);
    if (title || productId) resources.push({ id: `${site}-product-info`, token: '@商品信息', label: '商品信息' });
    if (gallery.length) resources.push({ id: `${site}-main-images`, token: '@主图', label: '主图' });
    if (skuGallery.length) resources.push({ id: `${site}-sku-images`, token: '@规格图', label: '规格图' });
    if (read(config.variants, 220)) resources.push({ id: `${site}-variants`, token: '@规格', label: '规格' });
    const video = first(['video', '[data-e2e="product-video"]']);
    if (video) resources.push({ id: `${site}-video`, token: '@商品视频', label: '商品视频' });
    const result = {
      ok: Boolean(title || productId), pageType, title: title || tidy(document.title, 260),
      structured: { title: title || `${label}商品`, kind, facts, resources, marketplace: {
        productId, mainImage: gallery[0]?.url || '', mainImageCount: gallery.length, skuImageCount: skuGallery.length,
        detailImageCount: 0, reviewSampleCount: 0, captureMode: mode || 'base',
      } }, images: [], comments: [], cards: [], capturedAt: Date.now(),
    };
    if (!result.ok) return { ok: false, status: 'no_visible_data', message: '当前商品页未显示可读取的标题或商品编号；请等待加载后重试' };
    if (mode === 'detail' || mode === 'reviews') {
      return (async () => {
        const selectors = mode === 'detail' ? config.detail : config.reviews;
        let section = first(selectors);
        const hasReviewItems = () => Boolean(section && (config.reviewItem || []).some((selector) => section.querySelector(selector)));
        if (!section || mode === 'reviews' && !hasReviewItems()) {
          const tabText = mode === 'detail'
            ? /^(?:详情|商品详情|描述|description|details|описание|descripción|détails)$/i
            : /^(?:评价|评论|用户评价|商品评价|reviews?|ratings?|feedback|отзывы|оценки|avis|bewertungen|reseñas)(?:\s*\d+)?$/i;
          const tab = [...document.querySelectorAll('button,[role="tab"]')].find((node) => rendered(node) && tabText.test(tidy(node.innerText, 50)));
          if (tab) tab.click();
          section = await waitFor(() => first(selectors));
        }
        if (!section) {
          result.structured.marketplace.reason = mode === 'detail'
            ? '当前页未找到已加载的详情图片区；请在网页中打开详情后重试'
            : '当前页未找到已加载的评价区；请在网页中打开评价后重试';
          return result;
        }
        section.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (mode === 'detail') {
          result.images = await waitFor(() => {
            const images = imagesIn(config.detail, 12);
            return images.length ? images : null;
          }) || [];
          result.structured.marketplace.detailImageCount = result.images.length;
          if (result.images.length) result.structured.resources.push({ id: `${site}-detail-images`, token: '@详情图片', label: '详情图片' });
        } else {
          result.comments = await waitFor(() => {
            const comments = [];
            const seen = new Set();
            for (const selector of config.reviewItem || []) {
              for (const node of section.querySelectorAll(selector)) {
                const value = tidy(node.innerText, 700);
                if (rendered(node) && value.length >= 8 && !seen.has(value)) { seen.add(value); comments.push({ text: value }); }
                if (comments.length >= 24) break;
              }
              if (comments.length) break;
            }
            return comments.length ? comments : null;
          }) || [];
          result.structured.marketplace.reviewSampleCount = result.comments.length;
          if (result.comments.length) result.structured.resources.push({ id: `${site}-reviews`, token: '@用户评价', label: '用户评价' });
        }
        if (!result.images.length && !result.comments.length) result.structured.marketplace.reason = mode === 'detail'
          ? '当前详情区域没有可读取的图片；请展开详情后重试'
          : '当前评价区域没有可读取的评价正文；请展开评价后重试';
        return result;
      })();
    }
    return result;
  }
  const anchors = [...document.querySelectorAll('a[href]')].filter(rendered).filter((node) => {
    try { return config.product.test(new URL(node.href, location.href).pathname); } catch { return false; }
  }).slice(0, 30);
  const cards = anchors.map((node) => ({ title: tidy(node.innerText || node.querySelector('img')?.alt, 220) })).filter((item) => item.title);
  if (cards.length) resources.push({ id: `${site}-${pageType}-items`, token: '@商品列表', label: '商品列表' });
  add(facts, '当前页', title);
  if (cards.length) add(facts, '可见商品', `${cards.length} 件`);
  return { ok: Boolean(title || cards.length), pageType, title, cards, structured: { title: `${label}${pageType === 'search' ? '搜索' : pageType === 'shop' ? '店铺' : '页面'}`, kind, facts, resources }, images: [], comments: [], capturedAt: Date.now() };
}

function marketplaceCaptureScript(site, mode = 'base') {
  return `(${readMarketplacePage.toString()})(${JSON.stringify(site)},${JSON.stringify(mode)})`;
}

module.exports = { marketplaceCaptureScript };
