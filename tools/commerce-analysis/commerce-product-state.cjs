'use strict';

// 商品页状态读取器：只读取当前页面的可见内容和公开初始化数据，
// 返回给分析台的是经过筛选的商品字段，不保存完整页面状态。

function imageUrl(value, base = 'https://detail.tmall.com/') {
  const raw = value && typeof value === 'object'
    ? (value.url || value.src || value.imageUrl || value.image || value.picUrl || value.pic || value.currentSrc || '')
    : value;
  const text = String(raw || '').trim();
  if (!text || /^(?:data|blob):/i.test(text)) return '';
  try { return new URL(text.startsWith('//') ? `https:${text}` : text, base).href; } catch { return ''; }
}

function filterCommerceMainImages(values, limit = 5) {
  const output = [];
  const auxiliary = /(?:avatar|headimg|favicon|logo|icon|qrcode|qr-code|loading|placeholder|recommend|guess|review|comment|question|ask)/i;
  const smallAsset = /(?:tps[-_]([0-9]+)[x-]([0-9]+)|[-_]([0-9]{2,4})[-x]([0-9]{2,4})(?:[.](?:png|jpe?g|webp))(?:[_?]|$))/i;
  for (const value of Array.isArray(values) ? values : [values]) {
    const url = imageUrl(value);
    if (!url || auxiliary.test(url.toLowerCase())) continue;
    const size = url.match(smallAsset);
    if (size && ((Number(size[1] || size[3]) || 0) < 160 || (Number(size[2] || size[4]) || 0) < 160)) continue;
    if (/(?:^|[_-])[0-9]{2,4}x[0-9]{2,4}q30(?:[._?-]|$)/i.test(url)) continue;
    if (!output.includes(url)) output.push(url);
    if (output.length >= Math.max(1, Number(limit) || 5)) break;
  }
  return output;
}

function normalizeCommerceCategory(value) {
  return String(value || '').replace(/[＞›»]+/g, '>').replace(/[ \t]+[/／][ \t]+/g, '>')
    .split('>').map((part) => part.trim()).filter(Boolean).join('>').slice(0, 240);
}

async function enrichCommerceProductCategory(state) {
  if (!state || typeof state !== 'object') return state;
  const product = state.product && typeof state.product === 'object' ? state.product : {};
  const category = normalizeCommerceCategory(product.category || product.categoryPath || '');
  return category ? { ...state, product: { ...product, category, categoryPath: category } } : state;
}

function collectCommerceProductState() {
  const tidy = (value, limit = 2400) => String(value ?? '').replace(/[ \t\r\n]+/g, ' ').trim().slice(0, limit);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const absolute = (value) => {
    const raw = value && typeof value === 'object'
      ? (value.url || value.src || value.imageUrl || value.image || value.picUrl || value.pic || value.currentSrc || '')
      : value;
    const text = String(raw || '').trim();
    if (!text || /^(?:data|blob):/i.test(text)) return '';
    try { return new URL(text.startsWith('//') ? `https:${text}` : text, location.href).href; } catch { return ''; }
  };
  const visible = (node) => {
    if (!node) return false;
    try {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const marker = (node) => {
    const parts = [];
    for (let current = node, depth = 0; current && depth < 6; current = current.parentElement, depth += 1) {
      parts.push(`${current.id || ''} ${current.className || ''} ${current.getAttribute?.('aria-label') || ''}`);
    }
    return parts.join(' ');
  };
  const roots = [];
  for (const key of ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
    try { if (object(globalThis[key])) roots.push(globalThis[key]); } catch {}
  }
  // 标题和图片都来自同一批初始化状态对象。之前两次调用 stateValues
  // 会把 __ICE_APP_CONTEXT__ 等大对象树完整递归两遍，页面状态越大越明显；
  // 合并为一次遍历，只在叶节点分别保留两类字段。
  const stateValueBuckets = { title: [], image: [] };
  const stateTitlePatterns = [/itemTitle$/i, /title$/i, /subject$/i];
  const stateImagePatterns = [/image|img|pic|picture/i];
  const stateScan = (value, hint = '', depth = 0, seen = new WeakSet()) => {
    if (depth > 9 || value === null || value === undefined || (stateValueBuckets.title.length >= 40 && stateValueBuckets.image.length >= 120)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      if (stateValueBuckets.title.length < 40 && stateTitlePatterns.some((pattern) => pattern.test(hint))) stateValueBuckets.title.push(value);
      if (stateValueBuckets.image.length < 120 && stateImagePatterns.some((pattern) => pattern.test(hint))) stateValueBuckets.image.push(value);
      return;
    }
    if (!object(value) && !Array.isArray(value)) return;
    try { if (seen.has(value)) return; seen.add(value); } catch { return; }
    const entries = Array.isArray(value) ? value.slice(0, 160).map((item) => ['', item]) : Object.entries(value).slice(0, 240);
    for (const [key, child] of entries) stateScan(child, `${hint}.${key}`, depth + 1, seen);
  };
  const stateScanSeen = new WeakSet();
  roots.forEach((root) => stateScan(root, '', 0, stateScanSeen));
  const firstText = (selectors) => {
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const text = tidy(node.getAttribute?.('content') || node.innerText || node.textContent || '', 2400);
        if (text) return text;
      }
    }
    return '';
  };
  const normalizeTitle = (value) => tidy(value, 2400).replace(/\s*[-|｜]\s*(?:淘宝网|天猫|1688)\s*$/i, '').trim();
  const ignoredTitle = /^(?:用户评价|问大家|参数信息|图文详情|本店推荐|看了又看|商品信息|商品详情|评价|规格|尺寸)(?:\s*[·:：]|$)|(?:好评率|客服满意度|平均\s*\d+\s*天内发货|店铺评分|宝贝评分|商品评分|描述相符|平台加补|累计评价|评论数|已售)/i;
  const genericTitle = /^(?:商品详情|商品页|淘宝(?:网)?|天猫|1688|登录|购物车|商品分类|商品分析台)$/i;
  const isUsableTitle = (value) => {
    const normalized = normalizeTitle(value);
    return normalized.length >= 8 && !ignoredTitle.test(normalized) && !genericTitle.test(normalized);
  };
  const firstTitleText = (selectors) => {
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const candidate = normalizeTitle(node.getAttribute?.('content') || node.innerText || node.textContent || '');
        if (isUsableTitle(candidate)) return candidate;
      }
    }
    return '';
  };
  const bodyText = tidy(document.body?.innerText || '', 30000);
  const stateTitle = stateValueBuckets.title.map(normalizeTitle).find(isUsableTitle) || '';
  const metadataTitle = normalizeTitle(
    document.querySelector('meta[property="og:title"]')?.getAttribute?.('content')
      || document.querySelector('meta[name="title"]')?.getAttribute?.('content')
      || '',
  );
  const documentTitle = normalizeTitle(document.title || '');
  const title = [
    stateTitle,
    isUsableTitle(metadataTitle) ? metadataTitle : '',
    firstTitleText(['h1', '[class*="item-title"]', '[class*="itemTitle"]', '[class*="product-title"]', '[class*="productTitle"]', '[class*="goods-title"]', '[class*="goodsTitle"]']),
    isUsableTitle(documentTitle) ? documentTitle : '',
    firstTitleText(['[class*="title"]', '[class*="Title"]']),
  ].find(isUsableTitle) || '';
  const priceText = firstText(['meta[property="product:price:amount"]', '[class*="price"]', '[class*="Price"]']);
  const priceMatch = `${priceText} ${bodyText}`.match(/(?:¥|￥|RMB|价格)[ \t]*([0-9]+(?:[.][0-9]{1,2})?)/i);
  const price = priceMatch ? priceMatch[1] : '';
  const numberAfter = (pattern) => { const match = bodyText.match(pattern); return match ? tidy(match[1], 80) : ''; };
  const reviewCount = numberAfter(/(?:累计评价|评价)[ \t]*([0-9.万千kK+]+)/i);
  const questionCount = numberAfter(/(?:问大家|买家问答)[ \t]*([0-9.万千kK+]+)/i);
  const sales = numberAfter(/(?:已售|销量|月销)[ \t]*([0-9.万千kK+]+)/i);
  const store = firstText(['[class*="shop-name"]', '[class*="ShopName"]', '[class*="store-name"]']);

  const imageEntries = [...document.querySelectorAll('img')].filter(visible).map((node, index) => {
    const box = node.getBoundingClientRect();
    return { index, url: absolute(node.dataset?.src || node.dataset?.original || node.currentSrc || node.src || ''), marker: marker(node), width: Number(node.naturalWidth || node.width || 0), height: Number(node.naturalHeight || node.height || 0), renderedWidth: Number(box.width || 0), renderedHeight: Number(box.height || 0), top: Number(box.top || 0), bottom: Number(box.bottom || 0), left: Number(box.left || 0), right: Number(box.right || 0) };
  }).filter((item) => /^https?:/i.test(item.url))
    .filter((item) => !/(?:avatar|headimg|favicon|logo|icon|qrcode|loading|placeholder|recommend|guess|review|comment|question|ask)/i.test(`${item.url} ${item.marker}`))
    .filter((item) => !item.width || !item.height || (item.width >= 160 && item.height >= 160));
  const hero = [...imageEntries].filter((item) => item.renderedWidth >= 180 && item.renderedHeight >= 180)
    .sort((left, right) => right.renderedWidth * right.renderedHeight - left.renderedWidth * left.renderedHeight)[0];
  const gallery = hero
    ? imageEntries.filter((item) => item.top >= hero.top - 80 && item.bottom <= hero.bottom + 80 && item.left >= hero.left - Math.max(280, hero.renderedWidth * 1.4) && item.right <= hero.right + 80)
    : imageEntries.filter((item) => /gallery|thumbnail|thumb|carousel|swiper|mainpic|main-pic|商品图|主图/i.test(item.marker));
  const stateImageUrls = stateValueBuckets.image.map(absolute).filter(Boolean);
  const mainImages = [...new Set([...gallery.map((item) => item.url), ...stateImageUrls])]
    .filter((url) => !/(?:recommend|guess|avatar|logo|icon|review|comment)/i.test(url)).slice(0, 20);

  const videos = [];
  const addVideo = (value) => {
    const url = absolute(value);
    if (!/^https?:/i.test(url) || videos.some((item) => item.url === url)) return;
    videos.push({ url, type: /[.]m3u8(?:$|[?])/i.test(url) ? 'hls' : 'video', source: 'visible-page' });
  };
  for (const node of [...document.querySelectorAll('video,video source,[data-video-url],[data-video]')]) addVideo(node.currentSrc || node.src || node.dataset?.videoUrl || node.dataset?.video || node.getAttribute?.('data-video-url') || '');
  for (const entry of performance.getEntriesByType('resource')) if (/(?:[.]mp4|[.]m3u8|[.]webm|[.]mov|[?&]video|[?&]playback|[?&]vod|\/video\/|\/playback\/|\/vod\/)/i.test(entry.name)) addVideo(entry.name);
  const detailSelectors = ['#J_Detail', '#J_DivItemDesc', '#detail', '#description', '#desc', '[id*="imageTextInfo"]', '[class*="detail-content"]', '[class*="DetailContent"]', '[class*="desc-content"]', '[class*="ImageText"]'];
  const detailRoot = detailSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(visible).sort((a, b) => b.querySelectorAll('img').length - a.querySelectorAll('img').length)[0] || null;
  const detailImages = detailRoot ? [...detailRoot.querySelectorAll('img')].map((node) => absolute(node.dataset?.src || node.dataset?.original || node.currentSrc || node.src || '')).filter((url) => /^https?:/i.test(url)).slice(0, 240) : [];
  const detailText = detailRoot ? tidy(detailRoot.innerText || detailRoot.textContent || '', 30000) : '';
  const parameterNode = [...document.querySelectorAll('[class*="param"],[class*="Param"],[class*="property"],[class*="Property"],[class*="spec"],[class*="Spec"]')].find(visible);
  const parameterText = tidy(parameterNode?.innerText || '', 10000);
  const parameters = [...parameterText.matchAll(/([^ \t\r\n：:]{1,40})[ \t]*[：:][ \t]*([^\r\n]{1,200})/g)].slice(0, 80).map((match) => ({ name: tidy(match[1], 80), value: tidy(match[2], 240) }));
  const category = tidy((bodyText.match(/(?:商品类目|类目)[ \t]*[:：][ \t]*([^\r\n]{2,180})/i) || [])[1] || '', 240);
  return {
    originalUrl: location.href,
    finalUrl: location.href,
    product: { title, store, price, priceRange: price, image: mainImages[0] || '', thumbnail: mainImages[0] || '', reviewCount, questionCount, sales, category, categoryPath: category, parameters, parameterText },
    mainImages, images: mainImages, videos: videos.slice(0, 20),
    diagnostics: { stateRootCount: roots.length, visibleImageCount: imageEntries.length, detailRootFound: Boolean(detailRoot), detailDomImageCount: detailImages.length, stateImageCount: stateImageUrls.length, videoCount: videos.length },
    detail: { text: detailText, images: detailImages, sections: [] },
    sku: { available: false, specs: [], items: [], itemCount: 0, text: '', source: 'commerce-product-state' },
    reviewStats: { totalCount: reviewCount }, questionStats: questionCount ? { totalCount: questionCount } : {},
  };
}

function collectCommerceProductCaptureScript() { return `(${collectCommerceProductState.toString()})()`; }

function collectCommerceDetailRevealScript() {
  return `(() => {
    const tidy = (value, limit = 30000) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    const absolute = (value) => { try { const raw = String(value || '').trim(); return raw && !/^(?:data|blob):/i.test(raw) ? new URL(raw.replace(/^\\/\\//, 'https://'), location.href).href : ''; } catch { return ''; } };
    const visible = (node) => { if (!node) return false; try { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; } catch { return false; } };
    const selectors = ['#J_Detail','#J_DivItemDesc','#detail','#description','#desc','[id*="imageTextInfo"]','[class*="detail-content"]','[class*="DetailContent"]','[class*="desc-content"]','[class*="ImageText"]'];
    const roots = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(visible).sort((a, b) => b.querySelectorAll('img').length - a.querySelectorAll('img').length);
    const root = roots[0] || null;
    const images = [...new Set(root ? [...root.querySelectorAll('img')].map((node) => absolute(node.dataset?.src || node.dataset?.original || node.currentSrc || node.src || '')).filter((url) => /^https?:/i.test(url) && !/(?:avatar|logo|icon|recommend|review|comment|question)/i.test(url)) : [])].slice(0, 240);
    const text = root ? tidy(root.innerText || root.textContent || '') : '';
    return { ok: Boolean(root || images.length || text), clicked: false, scrolled: false, rootFound: Boolean(root), imageCount: images.length, images, text, source: 'visible-detail-dom' };
  })()`;
}

function collectCommerceVideoRevealScript() {
  return `(() => {
    const visible = (node) => { if (!node) return false; try { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; } catch { return false; } };
    const nodes = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],li,span,div')].filter(visible).map((node) => ({ node, text: String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) })).filter((item) => /^(?:视频|主图视频|商品视频)$/.test(item.text) || /video/i.test(String(item.node.className || '')) && item.text.length <= 40).sort((a, b) => a.text.length - b.text.length);
    const target = nodes[0]?.node;
    if (!target) return { ok: false, reason: 'video_entry_not_visible' };
    try { target.click(); } catch {}
    return { ok: true, clicked: true, text: String(target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
  })()`;
}

module.exports = { collectCommerceProductCaptureScript, collectCommerceDetailRevealScript, collectCommerceProductState, collectCommerceVideoRevealScript, enrichCommerceProductCategory, filterCommerceMainImages, imageUrl, normalizeCommerceCategory };
