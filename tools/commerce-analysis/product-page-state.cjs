'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 淘宝商品页的字段在不同模板中会落在 ICE 初始化状态、页面可见参数区或两者
// 的组合里。这里把“商品信息”收敛成一份达笔式页面状态读取器，Electron 和
// Playwright 共用，避免两条采集链路各自退回旧 DOM 推断。

const CORE_PARAMETER_NAMES = [
  '厚薄', '领型', '裙长', '成分含量', '风格', '适用年龄', '材质', '面料', '图案',
  '版型', '腰型', '裤长', '鞋面材质', '鞋底材质', '闭合方式', '跟高',
];
const DETAIL_PARAMETER_NAMES = [
  '销售渠道类型', '上市年份季节', '适用季节', '适用人群', '适用对象', '款式', '品牌',
  '裤型', '产地', '袖长', '尺码', '颜色分类', '材质成分', '型号', '系列', '面料',
  '图案', '工艺', '功能', '裙型', '衣长', '裤长', '鞋面材质', '鞋底材质', '闭合方式',
  '跟高', '货号', '版型', '腰型', '材质', '风格', '厚薄', '领型', '裙长', '适用年龄',
];
const CATEGORY_KEYS = /category|categorypath|categoryname|breadcrumb|bread.?crumb|crumb|类目|分类/i;

// 主图资源在淘宝页面里经常和店铺头像、平台标识共用同一组图片字段。
// 这组纯 URL 规则供 Electron/Playwright 合并阶段复用；页面内的采集器还会
// 结合图片所在的可见画廊区域做一次更严格的筛选。
const DABI_MAIN_IMAGE_AUXILIARY_URL_RE = /(?:avatar|headimg|favicon|logo|qrcode|qr-code|recommend|guess|review|comment|(?:^|[-_/])icon(?:[-_.?/]|$)|(?:^|[-_/])rate(?:[-_.?/]|$))/i;
const DABI_MAIN_IMAGE_SMALL_ASSET_RE = /(?:tps[-_](\d+)[x-](\d+)|[-_](\d{2,4})[-x](\d{2,4})(?:\.(?:png|jpe?g|webp))(?:[_?]|$))/i;

function dabiImageCandidateUrl(value) {
  const raw = typeof value === 'object' && value !== null
    ? value.url || value.src || value.imageUrl || value.image || value.pic || value.currentSrc || value.href || ''
    : value;
  const text = String(raw || '').trim();
  if (!text || /^(?:data|blob):/i.test(text)) return '';
  try {
    return new URL(text.replace(/^\/\//, 'https://'), 'https://detail.tmall.com/').href;
  } catch {
    return '';
  }
}

function isDabiAuxiliaryMainImage(value) {
  const url = dabiImageCandidateUrl(value);
  if (!url) return true;
  const lower = url.toLowerCase();
  if (DABI_MAIN_IMAGE_AUXILIARY_URL_RE.test(lower)) return true;
  if (/(?:^|\/)tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\//i.test(lower)) return true;
  const size = lower.match(DABI_MAIN_IMAGE_SMALL_ASSET_RE);
  if (size) {
    const width = Number(size[1] || size[3] || 0);
    const height = Number(size[2] || size[4] || 0);
    if (width && height && (width < 160 || height < 160)) return true;
  }
  // 淘宝店铺头像常见的 CDN 规格是 760x760q30；商品画廊通常使用 q50
  // 或原图地址。把这个明确的头像规格挡在主图列表之外，避免 logo 占位。
  if (/(?:^|[_-])\d{2,4}x\d{2,4}q30(?:[._?-]|$)/i.test(lower)) return true;
  return false;
}

function filterDabiMainImages(values, limit = 5) {
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const url = dabiImageCandidateUrl(value);
    if (!url || isDabiAuxiliaryMainImage(url) || result.includes(url)) continue;
    result.push(url);
    if (result.length >= Math.max(1, Number(limit) || 5)) break;
  }
  return result;
}

function cleanParameterSource(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeParameterRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueParameterRows(rows) {
  const result = [];
  const seen = new Set();
  for (const row of rows || []) {
    const name = cleanParameterSource(row?.name).slice(0, 100);
    const value = cleanParameterSource(row?.value).replace(/^[：:;,，、]+|[：:;,，、]+$/g, '').slice(0, 2000);
    if (!name || !value || value === '…' || value === '...') continue;
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, value });
  }
  return result.slice(0, 80);
}

/**
 * Parse the visible “参数信息” text into the exact order used by Dabi's
 * 商品信息.txt. Core parameters on Taobao are rendered as value → label, while
 * detailed parameters are rendered as label → value; both forms are handled.
 */
function parseDabiProductParameters(source) {
  const content = cleanParameterSource(source);
  if (!content) return { core: [], detail: [], text: '' };
  const coreHeading = content.lastIndexOf('【核心参数】');
  const detailHeading = content.lastIndexOf('【详细参数】');
  if (coreHeading >= 0 && detailHeading > coreHeading) {
    const pairRows = (block, core) => {
      const rows = [];
      const pairPattern = /([^：:]{1,100})[：:]([^：:]+?)(?=\s+[^：:]{1,100}[：:]|$)/g;
      for (const match of block.matchAll(pairPattern)) {
        const left = cleanParameterSource(match[1]);
        const right = cleanParameterSource(match[2]);
        if (core && CORE_PARAMETER_NAMES.includes(right) && !CORE_PARAMETER_NAMES.includes(left)) rows.push({ name: right, value: left });
        else if (!core && DETAIL_PARAMETER_NAMES.includes(left)) rows.push({ name: left, value: right });
      }
      return rows;
    };
    const coreBlock = content.slice(coreHeading + '【核心参数】'.length, detailHeading);
    const detailBlock = content.slice(detailHeading + '【详细参数】'.length);
    return { core: uniqueParameterRows(pairRows(coreBlock, true)), detail: uniqueParameterRows(pairRows(detailBlock, false)), text: `${coreBlock.trim()} ${detailBlock.trim()}`.trim() };
  }
  const startMatches = [...content.matchAll(/参数信息/g)];
  const start = startMatches.length ? startMatches[startMatches.length - 1].index + '参数信息'.length : 0;
  const tail = content.slice(start);
  const endMatch = tail.search(/(?:尺码信息|图文详情|本店推荐|看了又看)/);
  const segment = cleanParameterSource(endMatch >= 0 ? tail.slice(0, endMatch) : tail).replace(/^新\s+/, '');
  if (!segment) return { core: [], detail: [], text: '' };

  const coreNames = new Set(CORE_PARAMETER_NAMES);
  const detailNames = new Set(DETAIL_PARAMETER_NAMES);
  const allNames = [...new Set([...CORE_PARAMETER_NAMES, ...DETAIL_PARAMETER_NAMES])]
    .sort((left, right) => right.length - left.length);
  const labelPattern = new RegExp(allNames.map(escapeParameterRegExp).join('|'), 'g');
  const matches = [...segment.matchAll(labelPattern)].map((match) => ({
    name: match[0],
    index: Number(match.index || 0),
    end: Number(match.index || 0) + match[0].length,
  }));
  if (!matches.length) return { core: [], detail: [], text: segment };

  const firstDetailIndex = matches.findIndex((match) => detailNames.has(match.name) && !coreNames.has(match.name));
  const coreMatches = firstDetailIndex >= 0 ? matches.slice(0, firstDetailIndex) : matches;
  const detailMatches = firstDetailIndex >= 0 ? matches.slice(firstDetailIndex) : [];
  const trimPair = (value) => cleanParameterSource(value)
    .replace(/^[：:;,，、\s]+|[：:;,，、\s]+$/g, '')
    .replace(/^(?:参数信息|核心参数|详细参数|新)\s*/i, '')
    .trim();
  const core = [];
  let cursor = 0;
  for (const match of coreMatches) {
    const value = trimPair(segment.slice(cursor, match.index));
    if (coreNames.has(match.name) && value) core.push({ name: match.name, value });
    cursor = match.end;
  }
  const detail = [];
  let previousValueSource = 'left';
  const detailStart = coreMatches.length ? coreMatches[coreMatches.length - 1].end : 0;
  for (let index = 0; index < detailMatches.length; index += 1) {
    const match = detailMatches[index];
    const next = detailMatches[index + 1];
    const previousEnd = index === 0 ? detailStart : detailMatches[index - 1].end;
    const left = trimPair(segment.slice(previousEnd, match.index));
    const right = trimPair(segment.slice(match.end, next ? next.index : segment.length));
    const useLeft = Boolean(left) && (index === 0 || previousValueSource !== 'right');
    const value = useLeft ? left : right;
    previousValueSource = useLeft ? 'left' : 'right';
    if (detailNames.has(match.name) && value) detail.push({ name: match.name, value });
  }

  // 对已经是“名称：值”形式的文本再补一次，兼容直接导入 Dabi TXT 或
  // 页面模板把核心参数也改成两列的情况；重复项会在这里去重。
  const explicit = [];
  for (const line of segment.split(/\s+(?=[^\s：:]{1,40}[：:])/)) {
    const match = line.match(/^\s*([^：:]{1,40})[：:]\s*(.+?)\s*$/);
    if (match) explicit.push({ name: match[1], value: match[2] });
  }
  return {
    core: uniqueParameterRows([...core, ...explicit.filter((row) => coreNames.has(row.name))]),
    detail: uniqueParameterRows([...detail, ...explicit.filter((row) => detailNames.has(row.name))]),
    text: segment,
  };
}

function parseDabiCategoryText(source) {
  const content = cleanParameterSource(source);
  const match = content.match(/(?:商品类目|类目)\s*[:：]\s*(.+?)(?=\s+(?:商品价格|商品销量|评价数量|核心参数|详细参数|$))/);
  return normalizeDabiCategoryPath(match?.[1] || '');
}

function normalizeDabiCategoryPath(value) {
  return cleanParameterSource(value)
    .replace(/[＞›»]+/g, '>')
    .replace(/\s+[／/]\s+/g, '>')
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('>')
    .slice(0, 240);
}

function readDabiCategoryResolverUrl(options = {}) {
  const explicit = String(
    options.url
      || process.env.XIAOMEI_TAOBAO_CATEGORY_RESOLVER_URL
      || process.env.DABI_TAOBAO_CATEGORY_RESOLVER_URL
      || '',
  ).trim();
  const configPaths = [
    options.configPath,
    process.env.DABI_OPENCLAW_CONFIG_PATH,
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.dabiai.desktop', 'openclaw', '.openclaw', 'openclaw.json'),
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  ].filter(Boolean);
  const candidates = explicit ? [explicit] : [];
  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const url = config?.mcp?.servers?.['taobao-launch']?.url;
      if (url) candidates.push(String(url));
    } catch {
      // Dabi is optional; a stale or malformed local config must not block采集。
    }
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp') continue;
      return url.href;
    } catch {
      // Ignore invalid optional resolver URLs.
    }
  }
  return '';
}

async function resolveDabiCategoryRemote(query, options = {}) {
  const normalizedQuery = cleanParameterSource(query);
  if (!normalizedQuery) return null;
  const resolverUrl = readDabiCategoryResolverUrl(options);
  if (!resolverUrl || typeof fetch !== 'function') return null;
  const timeoutMs = Math.max(300, Math.min(8000, Number(options.timeoutMs || process.env.XIAOMEI_TAOBAO_CATEGORY_RESOLVER_TIMEOUT_MS || 1800)));
  try {
    const response = await fetch(resolverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `xiaomei-category-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: 'taobao_launch_resolve_category_remote',
          arguments: { query: normalizedQuery },
        },
      }),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) return null;
    const envelope = await response.json();
    const text = envelope?.result?.content?.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
    if (!text) return null;
    const payload = JSON.parse(text);
    const match = payload?.match;
    if (!payload?.ok || !match) return null;
    const categoryPath = normalizeDabiCategoryPath(match.path || match.categoryPath || match.name || '');
    const categoryId = cleanParameterSource(match.id || '').slice(0, 80);
    if (!categoryPath || !categoryId) return null;
    return { id: categoryId, name: cleanParameterSource(match.name || '').slice(0, 120), path: categoryPath };
  } catch {
    return null;
  }
}

async function enrichDabiProductCategory(state, options = {}) {
  const result = state && typeof state === 'object' ? { ...state } : {};
  const product = result.product && typeof result.product === 'object' ? { ...result.product } : {};
  const existing = cleanParameterSource(product.category || product.categoryPath || '');
  if (existing && !/^\d+(?:\.\d+)?$/.test(existing)) {
    product.category = normalizeDabiCategoryPath(existing);
    result.product = product;
    return result;
  }
  const categoryId = cleanParameterSource(
    product.categoryId
      || (Array.isArray(product.categoryIds) ? product.categoryIds[0] : '')
      || '',
  );
  if (!categoryId) {
    result.product = product;
    return result;
  }
  const match = await resolveDabiCategoryRemote(categoryId, options);
  if (match?.path) {
    product.category = match.path;
    product.categoryPath = match.path;
    product.categoryId = match.id || categoryId;
    product.categoryName = match.name || product.categoryName || '';
  }
  result.product = product;
  return result;
}

function normalizeDabiParameterRows(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([name, item]) => ({ name, value: item }))
      : [];
  return uniqueParameterRows(source.map((row) => {
    if (row && typeof row === 'object') return { name: row.name || row.label || row.key, value: row.value || row.text || row.content };
    return { name: '', value: row };
  }));
}

function collectDabiProductState() {
  const tidy = (value, limit = 16000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const absolute = (value) => {
    try {
      const raw = value && typeof value === 'object'
        ? (value.url || value.src || value.image || value.imageUrl || value.picUrl || value.pic || value.fullPath || value.img || value.imagePath || value.standardImage || value.videoUrl || value.playUrl || value.contentUrl || '')
        : value;
      if (!raw) return '';
      return new URL(String(raw).replace(/^\/\//, 'https://'), location.href).href;
    } catch { return ''; }
  };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const first = (source, keys) => {
    if (!object(source)) return undefined;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };
  const numberText = (value, cents = false) => {
    if (value === null || value === undefined || value === '') return '';
    const raw = String(value).replace(/,/g, '').replace(/[¥￥$\s]/g, '');
    const match = raw.match(/\d+(?:\.\d+)?/);
    if (!match) return '';
    const number = Number(match[0]);
    if (!Number.isFinite(number)) return '';
    return (cents || (number >= 1000 && /^\d+$/.test(raw)) ? number / 100 : number).toFixed(2);
  };
  const parseParameters = (source) => {
    const content = String(source ?? '').replace(/\u00a0/g, ' ').replace(/[\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!content) return { core: [], detail: [], text: '' };
    const starts = [...content.matchAll(/参数信息/g)];
    const start = starts.length ? starts[starts.length - 1].index + '参数信息'.length : 0;
    const tail = content.slice(start);
    const end = tail.search(/(?:尺码信息|图文详情|本店推荐|看了又看)/);
    const segment = (end >= 0 ? tail.slice(0, end) : tail).replace(/^新\s+/, '').trim();
    if (!segment) return { core: [], detail: [], text: '' };
    const coreNames = new Set(['厚薄', '领型', '裙长', '成分含量', '风格', '适用年龄', '材质', '面料', '图案', '版型', '腰型', '裤长', '鞋面材质', '鞋底材质', '闭合方式', '跟高']);
    const detailNames = new Set(['销售渠道类型', '上市年份季节', '适用季节', '适用人群', '适用对象', '款式', '品牌', '裤型', '产地', '袖长', '尺码', '颜色分类', '材质成分', '型号', '系列', '面料', '图案', '工艺', '功能', '裙型', '衣长', '裤长', '鞋面材质', '鞋底材质', '闭合方式', '跟高', '货号', '版型', '腰型', '材质', '风格', '厚薄', '领型', '裙长', '适用年龄']);
    const names = [...new Set([...coreNames, ...detailNames])].sort((a, b) => b.length - a.length);
    const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...segment.matchAll(new RegExp(names.map(escape).join('|'), 'g'))].map((match) => ({ name: match[0], index: Number(match.index || 0), end: Number(match.index || 0) + match[0].length }));
    if (!matches.length) return { core: [], detail: [], text: segment };
    const firstDetail = matches.findIndex((match) => detailNames.has(match.name) && !coreNames.has(match.name));
    const coreMatches = firstDetail >= 0 ? matches.slice(0, firstDetail) : matches;
    const detailMatches = firstDetail >= 0 ? matches.slice(firstDetail) : [];
    const trim = (value) => String(value || '').replace(/\s+/g, ' ').trim().replace(/^[：:;,，、\s]+|[：:;,，、\s]+$/g, '').replace(/^(?:参数信息|核心参数|详细参数|新)\s*/i, '').trim();
    const core = [];
    let cursor = 0;
    for (const match of coreMatches) {
      const value = trim(segment.slice(cursor, match.index));
      if (coreNames.has(match.name) && value) core.push({ name: match.name, value });
      cursor = match.end;
    }
    const detail = [];
    let previousValueSource = 'left';
    const detailStart = coreMatches.length ? coreMatches[coreMatches.length - 1].end : 0;
    for (let index = 0; index < detailMatches.length; index += 1) {
      const match = detailMatches[index];
      const next = detailMatches[index + 1];
      const previousEnd = index === 0 ? detailStart : detailMatches[index - 1].end;
      const left = trim(segment.slice(previousEnd, match.index));
      const right = trim(segment.slice(match.end, next ? next.index : segment.length));
      const useLeft = Boolean(left) && (index === 0 || previousValueSource !== 'right');
      const value = useLeft ? left : right;
      previousValueSource = useLeft ? 'left' : 'right';
      if (detailNames.has(match.name) && value) detail.push({ name: match.name, value });
    }
    const dedupe = (rows) => {
      const seen = new Set();
      return rows.filter((row) => {
        const name = tidy(row.name, 100); const value = tidy(row.value, 2000);
        if (!name || !value || value === '…' || value === '...') return false;
        const key = `${name}\u0000${value}`;
        if (seen.has(key)) return false;
        seen.add(key); row.name = name; row.value = value; return true;
      }).slice(0, 80);
    };
    return { core: dedupe(core), detail: dedupe(detail), text: segment };
  };

  const bodyRaw = String(document.body?.innerText || '');
  const body = tidy(bodyRaw, 30000);
  const ice = globalThis.__ICE_APP_CONTEXT__;
  const loader = ice?.loaderData;
  const homeData = loader?.home?.data;
  const root = homeData?.res && object(homeData.res) ? homeData.res : {};
  const item = object(root.item) ? root.item : {};
  const seller = object(root.seller) ? root.seller : {};
  const components = object(root.componentsVO) ? root.componentsVO : {};
  const titleVO = object(components.titleVO) ? components.titleVO : {};
  const priceVO = object(components.priceVO) ? components.priceVO : {};
  const rateVO = object(components.rateVO) ? components.rateVO : {};
  const storeCard = object(components.storeCardVO) ? components.storeCardVO : {};

  const roots = [root, homeData, loader, ice];
  for (const key of ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
    try { if (object(globalThis[key])) roots.push(globalThis[key]); } catch {}
  }
  for (const script of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script#__INITIAL_STATE__')) {
    try { const value = JSON.parse(script.textContent || ''); if (object(value)) roots.push(value); } catch {}
  }
  const objects = [];
  const visited = new WeakSet();
  let visitedCount = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10 || visitedCount >= 30000 || visited.has(value)) return;
    visited.add(value); visitedCount += 1; objects.push(value);
    const entries = Array.isArray(value) ? value.slice(0, 500).map((child) => ['', child]) : Object.entries(value).slice(0, 300);
    for (const [, child] of entries) walk(child, depth + 1);
  };
  for (const value of roots) walk(value);

  const textValue = (value) => {
    if (typeof value === 'string' || typeof value === 'number') return tidy(value, 400);
    if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(' > ');
    if (object(value)) {
      const direct = first(value, ['path', 'fullPath', 'fullName', 'categoryPath', 'categoryName', 'catNamePath', 'catName', 'name', 'title', 'label', 'text', 'value']);
      if (direct !== undefined && direct !== null && direct !== '') return textValue(direct);
      return Object.entries(value)
        .filter(([key]) => /category|cat|path|name|title|label|text|value|level/i.test(key))
        .map(([, child]) => textValue(child))
        .filter(Boolean)
        .slice(0, 8)
        .join(' > ');
    }
    return '';
  };
  const categoryCandidates = [];
  for (const state of objects) {
    for (const [key, value] of Object.entries(state).slice(0, 300)) {
      if (!CATEGORY_KEYS.test(key) || /颜色分类|商品分类数量|categoryId/i.test(key)) continue;
      const candidate = textValue(value).replace(/[＞›»]+/g, '>').trim();
      if (candidate && !/^\d+(?:\.\d+)?$/.test(candidate) && candidate.length <= 300 && !candidate.includes('http') && !categoryCandidates.includes(candidate)) categoryCandidates.push(candidate);
    }
  }
  const visibleCategory = [...document.querySelectorAll('[class*="breadcrumb"], [class*="bread-crumb"], [class*="crumb"], nav a')]
    .map((node) => tidy(node.innerText || node.textContent || '', 300))
    .find((value) => value && /[>＞›»/]/.test(value) && !/网页无障碍|首页|淘宝网/.test(value));
  const category = (visibleCategory || categoryCandidates.find((value) => /[>＞›»/]/.test(value)) || categoryCandidates[0] || '')
    .replace(/[＞›»]+/g, '>').replace(/\s+[／/]\s+/g, '>')
    .replace(/^商品类目\s*[:：]\s*/i, '').split('>').map((part) => part.trim()).filter(Boolean).join('>').slice(0, 240);

  const categoryIdCandidates = [];
  const addCategoryIdCandidate = (key, value) => {
    const name = String(key || '');
    if (!/(?:category|cat)(?:id|_id)?$/i.test(name) && !/^(?:root|leaf)Category$/i.test(name)) return;
    const candidate = object(value) ? first(value, ['id', 'categoryId', 'category_id', 'catId', 'cat_id', 'value']) : value;
    const id = tidy(candidate, 80);
    if (!/^\d+$/.test(id) || categoryIdCandidates.some((item) => item.id === id)) return;
    const priority = /leaf/i.test(name) ? 100 : /category/i.test(name) ? 80 : /root/i.test(name) ? 20 : 50;
    categoryIdCandidates.push({ id, priority });
  };
  for (const state of objects) {
    for (const [key, value] of Object.entries(state).slice(0, 300)) addCategoryIdCandidate(key, value);
  }
  categoryIdCandidates.sort((left, right) => right.priority - left.priority || Number(right.id) - Number(left.id));
  const categoryIds = categoryIdCandidates.map((item) => item.id).slice(0, 8);
  const categoryId = categoryIds[0] || '';

  const imageValues = (value) => {
    const values = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.values(value)
        : [];
    return [...new Set(values.map(absolute).filter((url) => /^https?:/i.test(url)))];
  };
  const videoUrlPattern = /\.(?:mp4|m3u8|webm|mov|m4v|ts)(?:[?#]|$)|(?:\/video\/|\/playback|\/vod\/|\/stream\/|\/play\/|cloudvideo|video(?:[-_/?]|$))/i;
  const videoKeyPattern = /(?:video|playback|playUrl|vod|stream|m3u8|mp4)/i;
  const strongVideoKeyPattern = /(?:videoUrl|videoPath|playUrl|playbackUrl|contentUrl|sourceUrl|resourceUrl|streamUrl|hlsUrl|mp4Url|m3u8Url|cloudVideoUrl|feedVideoPathList)/i;
  const videoUrlsFromValue = (value, hint = '') => {
    const result = [];
    const visited = new WeakSet();
    const add = (candidate, keyHint = hint) => {
      const url = absolute(candidate);
      if (!/^https?:/i.test(url)) return;
      const key = String(keyHint || '');
      const canInferFromKey = strongVideoKeyPattern.test(key)
        || (/(?:^|[._])(?:video|videos|playback|vod|stream)(?:[._]|$)/i.test(key)
          && !/(?:image|pic|poster|cover|thumb|avatar|logo)/i.test(key));
      if (!videoUrlPattern.test(url) && !canInferFromKey) return;
      if (!result.includes(url)) result.push(url);
    };
    const visit = (current, keyHint = hint, depth = 0) => {
      if (current === null || current === undefined || depth > 6 || result.length >= 40) return;
      if (typeof current === 'string' || typeof current === 'number') {
        add(current, keyHint);
        return;
      }
      if (typeof current !== 'object') return;
      if (visited.has(current)) return;
      visited.add(current);
      if (Array.isArray(current)) {
        for (const child of current.slice(0, 80)) visit(child, keyHint, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(current).slice(0, 80)) {
        if (strongVideoKeyPattern.test(key) || videoKeyPattern.test(key) || videoUrlPattern.test(String(child || ''))) {
          visit(child, `${keyHint}.${key}`, depth + 1);
        }
      }
    };
    visit(value, hint, 0);
    return result;
  };
  const markerOf = (node) => {
    const values = [];
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      values.push(`${String(current.id || '')} ${String(current.className || '')} ${String(current.getAttribute?.('aria-label') || '')}`);
    }
    return values.join(' ');
  };
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const detailSelectors = [
    '#imageTextInfo-content', '#imageTextInfo-container', '#J_Detail', '#J_DivItemDesc', '#detail',
    '#description', '#desc', '[id*="imageTextInfo"]', '[id*="detail"]', '[id*="Detail"]',
    '[class*="detail-content"]', '[class*="DetailContent"]', '[class*="desc-content"]',
    '[class*="DescContent"]', '[class*="image-text"]', '[class*="ImageText"]',
  ];
  const detailRoots = detailSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter(visible)
    .filter((element) => !/(review|comment|rate|sku|ask|question)/i.test(`${element.id || ''} ${element.className || ''}`));
  const detailRoot = detailRoots.sort((left, right) => {
    const leftScore = left.querySelectorAll('img').length * 200 + tidy(left.innerText, 30000).length;
    const rightScore = right.querySelectorAll('img').length * 200 + tidy(right.innerText, 30000).length;
    return rightScore - leftScore;
  })[0] || null;
  const imageValue = (node) => {
    if (!node) return '';
    const lazy = node.dataset?.src || node.dataset?.original || node.dataset?.lazySrc || node.dataset?.ksLazyload || node.getAttribute?.('data-imgurl') || '';
    const current = node.currentSrc || node.src || '';
    return lazy && (!current || /(?:loading|placeholder|blank|transparent|s\.gif)/i.test(current)) ? lazy : current || lazy;
  };
  const excludedImage = (url, marker) => /(?:avatar|headimg|favicon|logo|icon|qrcode|qr-code|loading|placeholder|recommend|guess|店铺推荐|看了又看|s\.gif|(?:^|[-_/])rate(?:[-_.?/]|$)|review|comment)/i.test(`${url} ${marker}`);
  const smallAssetPattern = /(?:tps[-_](\d+)[x-](\d+)|-(\d{2,4})-(\d{2,4})(?:\.(?:png|jpe?g|webp))(?:[_?]|$))/i;
  const domImageEntries = [...document.querySelectorAll('img')]
    .filter(visible)
    .map((node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        url: absolute(imageValue(node)),
        marker: markerOf(node),
        width: Number(node.naturalWidth || node.width || 0),
        height: Number(node.naturalHeight || node.height || 0),
        renderedWidth: Number(rect.width || 0),
        renderedHeight: Number(rect.height || 0),
        top: Number(rect.top || 0),
        bottom: Number(rect.bottom || 0),
        left: Number(rect.left || 0),
        right: Number(rect.right || 0),
        order: index,
      };
    })
    .filter((entry) => /^https?:/i.test(entry.url) && !excludedImage(entry.url, entry.marker));
  const uniqueUrls = (entries, limit = 240) => [...new Set((entries || []).map((entry) => typeof entry === 'string' ? entry : entry?.url).filter((url) => /^https?:/i.test(url)))].slice(0, limit);
  const stateImages = imageValues(item.images);
  const galleryImages = domImageEntries.filter((entry) => /gallery|thumbnail|thumb|carousel|swiper|pic(?:ture)?viewer|mainpic|main-pic|商品图|主图|缩略/i.test(entry.marker));
  const mainGalleryMarker = (entry) => !/(?:shop|seller|store|header|brand|avatar|logo|recommend|guess|rate|review|comment|question|ask)/i.test(String(entry?.marker || ''));
  const isUsableMainImage = (entry) => {
    const value = typeof entry === 'string' ? { url: entry, marker: '' } : (entry || {});
    const url = String(value.url || '');
    const marker = String(value.marker || '');
    if (!/^https?:/i.test(url) || excludedImage(url, marker) || !mainGalleryMarker(value)) return false;
    if (/(?:^|\/)tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\//i.test(url)) return false;
    const width = Number(value.width || 0);
    const height = Number(value.height || 0);
    if (width && height && (width < 160 || height < 160)) return false;
    const size = url.match(smallAssetPattern);
    if (size) {
      const sizeWidth = Number(size[1] || size[3] || 0);
      const sizeHeight = Number(size[2] || size[4] || 0);
      if (sizeWidth && sizeHeight && (sizeWidth < 160 || sizeHeight < 160)) return false;
    }
    if (/(?:^|[_-])\d{2,4}x\d{2,4}q30(?:[._?-]|$)/i.test(url)) return false;
    return true;
  };
  const stateImageEntries = stateImages.map((url) => domImageEntries.find((entry) => entry.url === url) || { url, marker: '' });
  const viewportBottom = Math.max(900, Number(window.innerHeight || 900) * 1.25);
  const heroCandidates = domImageEntries
    .filter((entry) => isUsableMainImage(entry) && entry.renderedWidth >= 180 && entry.renderedHeight >= 180 && entry.top < viewportBottom && entry.bottom > -200)
    .sort((left, right) => (right.renderedWidth * right.renderedHeight) - (left.renderedWidth * left.renderedHeight));
  const hero = heroCandidates[0] || null;
  const visualGalleryImages = hero
    ? domImageEntries
      .filter((entry) => {
        if (!isUsableMainImage(entry)) return false;
        const verticalPad = Math.max(28, Math.min(82, hero.renderedHeight * 0.14));
        const horizontalPad = Math.max(260, hero.renderedWidth * 1.2);
        return entry.top >= hero.top - verticalPad
          && entry.bottom <= hero.bottom + verticalPad
          && entry.left >= hero.left - horizontalPad
          && entry.right <= hero.right + Math.max(36, hero.renderedWidth * 0.16);
      })
      .sort((left, right) => left.order - right.order)
    : [];
  // 新版淘宝的画廊容器经常使用动态 class，不能只依赖固定选择器；
  // 以首屏最大商品图为锚点，把同一纵向画廊范围内的缩略图收进来。
  // 只有画廊候选不足时才补初始化状态中的图片，避免 logo 排在真正主图前面。
  const selectorGalleryImages = galleryImages.filter(isUsableMainImage);
  const primaryGalleryImages = visualGalleryImages.length >= 2 ? visualGalleryImages : selectorGalleryImages;
  const mainImages = uniqueUrls([
    ...primaryGalleryImages,
    ...(primaryGalleryImages.length < 5 ? stateImageEntries.filter(isUsableMainImage) : []),
  ], 5);
  const detailImageEntries = detailRoot
    ? [...detailRoot.querySelectorAll('img')]
      .filter(visible)
      .map((node) => ({ url: absolute(imageValue(node)), marker: markerOf(node) }))
      .filter((entry) => /^https?:/i.test(entry.url) && !excludedImage(entry.url, entry.marker))
    : domImageEntries.filter((entry) => /detail|description|desc|图文详情|商品详情|详情页/i.test(entry.marker));
  const detailImages = uniqueUrls(detailImageEntries.filter((entry) => !mainImages.includes(entry.url)), 240);
  const detailText = tidy(
    detailRoot
      ? (detailRoot.innerText || detailRoot.textContent || '')
      : [...document.querySelectorAll('[class*="detail"],[class*="description"],[class*="desc"],[id*="detail"],[id*="description"]')]
        .filter(visible)
        .map((node) => node.innerText || node.textContent || '')
        .filter((value) => String(value).trim().length >= 20)
        .sort((left, right) => String(right).length - String(left).length)
        .slice(0, 4)
        .join(' '),
    30000,
  );
  const stateVideoUrls = [];
  const addStateVideos = (value, hint) => {
    for (const url of videoUrlsFromValue(value, hint)) if (!stateVideoUrls.includes(url)) stateVideoUrls.push(url);
  };
  addStateVideos(item.videos, 'item.videos');
  addStateVideos(item.video, 'item.video');
  addStateVideos(item.videoUrl, 'item.videoUrl');
  for (const state of objects) {
    const stateKeys = Object.keys(state).slice(0, 80).map((key) => String(key));
    if (stateKeys.some((key) => /(?:review|comment|rate|question|ask|feedPic|feedVideo)/i.test(key))) continue;
    for (const [key, value] of Object.entries(state).slice(0, 300)) {
      if (!videoKeyPattern.test(String(key)) || /(?:feedVideo|review|comment|rate|question)/i.test(String(key))) continue;
      addStateVideos(value, String(key));
      if (stateVideoUrls.length >= 40) break;
    }
    if (stateVideoUrls.length >= 40) break;
  }
  const domVideoUrls = [];
  let domVideoCandidateCount = 0;
  let performanceVideoEntryCount = 0;
  try {
    const nodes = [
      ...document.querySelectorAll('video, video source, [data-video], [data-video-url], [data-video-src], source[type*="video"]'),
    ];
    domVideoCandidateCount = nodes.length;
    for (const node of nodes) {
      const candidate = node.currentSrc || node.src || node.getAttribute?.('data-video-url') || node.getAttribute?.('data-video-src') || node.getAttribute?.('data-video') || '';
      for (const url of videoUrlsFromValue(candidate, 'dom.video')) if (!domVideoUrls.includes(url)) domVideoUrls.push(url);
    }
    for (const entry of performance.getEntriesByType('resource')) {
      const candidate = entry?.name || '';
      if (!videoUrlPattern.test(candidate)) continue;
      performanceVideoEntryCount += 1;
      for (const url of videoUrlsFromValue(candidate, 'performance.video')) if (!domVideoUrls.includes(url)) domVideoUrls.push(url);
      if (domVideoUrls.length >= 20) break;
    }
  } catch {
    // performance entries and media nodes are optional in some WebContentsView documents.
  }
  const videos = [
    ...stateVideoUrls.map((url) => ({ url, type: /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'video', source: 'product-state' })),
    ...domVideoUrls.map((url) => ({ url, type: /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'video', source: 'visible-page' })),
  ].filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index).slice(0, 20);
  const priceObject = object(priceVO.price) ? priceVO.price : priceVO;
  const titleValue = first(titleVO, ['title']);
  const stateTitle = tidy((object(titleValue) ? first(titleValue, ['title', 'text', 'value']) : titleValue), 300);
  // 部分淘宝模板的初始化状态会把通用助手说明写进 titleVO，
  // 但商品标题会稳定出现在可见的商品标题节点里。优先读取可见商品标题，
  // 避免右侧商品信息卡显示“基于大模型能力解答您的疑问”等通用文案。
  const ignoredTitle = /^(?:用户评价|问大家|参数信息|图文详情|本店推荐|看了又看|商品信息|商品详情|评价|规格|尺寸)(?:\s*[·:：]|$)/i;
  const genericTitle = /大模型|解答您的疑问|问问小美|商品信息待返回|待登录[／/]验证后读取/i;
  const visibleTitleCandidates = [...document.querySelectorAll('h1,[class*="item-title"],[class*="product-title"],[class*="goods-title"],[class*="title"]')]
    .filter(visible)
    .map((node, index) => {
      const value = tidy(node.innerText || node.textContent || '', 300);
      const tag = String(node.tagName || '').toLowerCase();
      const className = String(node.className || '').toLowerCase();
      const score = (tag === 'h1' ? 100 : 0)
        + (/(?:item|product|goods).*title|title.*(?:item|product|goods)/i.test(className) ? 80 : 0)
        + (className.includes('title') ? 20 : 0);
      return { value, score, index };
    })
    .filter((item) => item.value.length >= 8
      && !ignoredTitle.test(item.value)
      && !genericTitle.test(item.value)
      && !/淘宝|天猫|登录|加入购物车|立即购买|平台加补/i.test(item.value))
    .sort((left, right) => right.score - left.score || right.value.length - left.value.length || left.index - right.index)
    .map((item) => item.value);
  const fallbackTitleCandidates = [
    stateTitle,
    tidy(item.title, 300),
    tidy(document.querySelector('h1')?.innerText || '', 300),
    tidy(document.title, 300),
  ].filter(Boolean);
  const title = tidy(
    visibleTitleCandidates[0]
      || fallbackTitleCandidates.find((value) => !genericTitle.test(value))
      || fallbackTitleCandidates[0],
    300,
  );
  const store = tidy(first(seller, ['shopName', 'sellerNick', 'shopNameText']) || first(storeCard, ['shopName', 'sellerNick']) || document.querySelector('[class*="shop-name"], [class*="shopName"]')?.innerText, 160);
  const price = tidy(first(priceObject, ['priceText', 'displayPrice', 'price']) || '', 80) || numberText(first(priceObject, ['priceMoney', 'amount']), true);
  const bodyPrices = [];
  for (const match of body.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && value < 100000 && !bodyPrices.includes(value)) bodyPrices.push(value);
    if (bodyPrices.length >= 6) break;
  }
  const statePrices = [
    first(priceObject, ['priceText', 'displayPrice', 'price', 'currentPrice', 'salePrice']),
    first(priceObject, ['minPrice', 'lowPrice', 'priceMin']),
    first(priceObject, ['maxPrice', 'highPrice', 'priceMax', 'originalPrice']),
  ].map((value) => Number(numberText(value))).filter((value) => Number.isFinite(value) && value > 0);
  const prices = [...new Set([...statePrices, ...bodyPrices])].sort((a, b) => a - b);
  const moneyText = (value) => `¥${Number(value).toFixed(2)}`;
  const priceRange = prices.length >= 2 ? `${moneyText(prices[0])}～${moneyText(prices[prices.length - 1])}` : price ? (String(price).startsWith('¥') ? String(price) : `¥${price}`) : '';
  const evaluates = Array.isArray(seller.evaluates) ? seller.evaluates : Array.isArray(storeCard.evaluates) ? storeCard.evaluates : [];
  const rating = tidy(evaluates[0]?.score || evaluates[0]?.title, 40);
  const productId = String(item.itemId || item.id || new URL(location.href).searchParams.get('id') || new URL(location.href).searchParams.get('itemId') || '').trim();
  const countFromText = (labels) => {
    const labelPattern = labels.join('|');
    return body.match(new RegExp(`(?:${labelPattern})\\s*[·:：]?\\s*([0-9.万千kK+]+)`, 'i'))?.[1]
      || body.match(new RegExp(`([0-9.万千kK+]+)\\s*(?:${labelPattern})`, 'i'))?.[1]
      || '';
  };
  const stateCount = (scopePattern) => {
    for (const state of objects) {
      const entries = Object.entries(state).slice(0, 300);
      if (!entries.some(([key]) => scopePattern.test(String(key)))) continue;
      for (const [key, value] of entries) {
        if (!/(?:count|total|num|number|数量)/i.test(String(key))) continue;
        const match = String(value ?? '').replace(/,/g, '').match(/[0-9.万千kK+]+/);
        if (match) return match[0];
      }
    }
    return '';
  };
  const reviewCount = tidy(first(rateVO, ['totalCount', 'count', 'total']) || countFromText(['累计评价', '评价总数', '评论数', '用户评价']) || stateCount(/rate|review|comment|评价|评论/i), 80);
  const questionCount = tidy(countFromText(['问大家', '买家问答', '常见问题']) || stateCount(/question|ask|qa|answer|问大家|问答/i), 80);
  const sales = tidy(first(titleVO, ['salesDesc']) || item.vagueSellCount || body.match(/(?:已售|销量|成交|付款人数)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1], 100).replace(/^(?:已售|销量|成交|付款人数)\s*/i, '');
  const parameters = parseParameters(bodyRaw);
  const brand = tidy(first(item, ['brand', 'brandName']) || parameters.detail.find((row) => row.name === '品牌')?.value, 120);
  return {
    available: Boolean(title || mainImages.length || detailImages.length || detailText || parameters.core.length || parameters.detail.length),
    final_url: location.href,
    rawText: body,
    product: {
      id: productId,
      category,
      categoryId,
      categoryIds,
      title,
      store,
      price,
      priceRange,
      priceMin: prices.length ? prices[0].toFixed(2) : '',
      priceMax: prices.length ? prices[prices.length - 1].toFixed(2) : '',
      reviewCount,
      questionCount,
      sales,
      rating,
      brand,
      description: tidy(item.subtitle || item.desc || '', 2400),
      image: mainImages[0] || '',
      thumbnail: mainImages[0] || '',
      parameters,
      coreParams: parameters.core,
      detailParams: parameters.detail,
      parameterText: parameters.text,
    },
    mainImages,
    images: mainImages,
    videos,
    diagnostics: {
      hasIceContext: Boolean(ice),
      hasLoaderData: Boolean(loader),
      hasRes: Boolean(root && Object.keys(root).length),
      resKeys: Object.keys(root || {}).filter((key) => !/^__/.test(key)).slice(0, 80),
      itemVideoFieldCount: Array.isArray(item.videos) ? item.videos.length : item.videos ? 1 : 0,
      stateVideoCount: stateVideoUrls.length,
      domVideoCandidateCount,
      domVideoCount: domVideoUrls.length,
      performanceVideoEntryCount,
      detailRootFound: Boolean(detailRoot),
      detailDomImageCount: detailRoot ? detailRoot.querySelectorAll('img').length : 0,
    },
    detail: { text: detailText, images: detailImages, sections: [] },
    sku: { available: false, specs: [], items: [], itemCount: 0, text: '', source: 'dabi-product-state' },
    reviewStats: { totalCount: reviewCount },
    questionStats: questionCount ? { totalCount: questionCount } : {},
  };
}

function collectDabiProductCaptureScript() {
  return `(${collectDabiProductState.toString()})()`;
}

// 淘宝新版详情图片可能已经挂在首屏 DOM、懒加载属性或初始化状态里。
// 详情长图采集不应改变商品页位置，因此这里绝不点击标签、scrollIntoView
// 或 window.scrollBy；只读取当前已经存在的真实图片 URL，交给后端直接下载拼接。
function collectDabiDetailRevealScript() {
  return `(() => {
    const tidy = (value, limit = 30000) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    const absolute = (value) => {
      try {
        const raw = String(value || '').trim();
        if (!raw || /^(?:data|blob):/i.test(raw)) return '';
        return new URL(raw.replace(/^\\/\\//, 'https://'), location.href).href;
      } catch { return ''; }
    };
    const markerOf = (node) => {
      const values = [];
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        values.push(String(current.id || '') + ' ' + String(current.className || '') + ' ' + String(current.getAttribute?.('aria-label') || ''));
      }
      return values.join(' ');
    };
    const excluded = (url, marker) => /(?:avatar|headimg|favicon|logo|icon|qrcode|qr-code|loading|placeholder|recommend|guess|看了又看|s\\.gif|(?:^|[-_/])rate(?:[-_.?\\/]|$)|review|comment|question|ask|sku)/i.test(String(url || '') + ' ' + String(marker || ''));
    const detailSelectors = [
      '#imageTextInfo-content', '#imageTextInfo-container', '#J_Detail', '#J_DivItemDesc', '#detail',
      '#description', '#desc', '[id*="imageTextInfo"]', '[id*="detail"]', '[id*="Detail"]',
      '[class*="detail-content"]', '[class*="DetailContent"]', '[class*="desc-content"]',
      '[class*="DescContent"]', '[class*="image-text"]', '[class*="ImageText"]',
      '[data-spm*="detail"]', '[data-module*="detail"]',
    ];
    const mounted = (node) => {
      if (!node) return false;
      try { return node.isConnected && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'; } catch { return false; }
    };
    const roots = detailSelectors.flatMap((selector) => {
      try { return [...document.querySelectorAll(selector)]; } catch { return []; }
    })
      .filter(mounted)
      .filter((element) => !/(review|comment|rate|sku|ask|question)/i.test(String(element.id || '') + ' ' + String(element.className || '')))
      .filter((element, index, list) => list.indexOf(element) === index)
      .sort((left, right) => {
        const leftImages = left.querySelectorAll('img').length;
        const rightImages = right.querySelectorAll('img').length;
        const leftText = tidy(left.innerText || left.textContent || '').length;
        const rightText = tidy(right.innerText || right.textContent || '').length;
        return rightImages * 1000 + rightText - (leftImages * 1000 + leftText);
      })
      .slice(0, 12);
    const detailRoot = roots[0] || null;
    const imageEntries = [];
    const addImage = (candidate, marker = '', source = 'detail-dom') => {
      const url = absolute(candidate);
      if (!/^https?:/i.test(url) || excluded(url, marker)) return;
      if (imageEntries.some((item) => item.url === url)) return;
      imageEntries.push({ url, marker: String(marker || '').slice(0, 400), source });
    };
    const addNodeImage = (node) => {
      if (!node) return;
      const lazy = node.dataset?.src || node.dataset?.original || node.dataset?.lazySrc || node.dataset?.ksLazyload
        || node.getAttribute?.('data-imgurl') || node.getAttribute?.('data-original-src') || node.getAttribute?.('data-image') || '';
      const current = node.currentSrc || node.src || '';
      const srcset = node.getAttribute?.('srcset') || node.getAttribute?.('data-srcset') || '';
      const candidates = [lazy, current, ...String(srcset).split(',').map((item) => item.trim().split(/\\s+/)[0])];
      for (const candidate of candidates) addImage(candidate, markerOf(node), 'detail-dom');
    };
    for (const root of roots) for (const node of [...root.querySelectorAll('img')]) addNodeImage(node);
    const detailText = tidy(roots.map((root) => root.innerText || root.textContent || '').join(' '), 30000);

    // 一些淘宝模板把详情布局只放在 ICE/初始化对象中，DOM 里只有占位节点。
    // 这里只接受带 detail/desc/component 语义的对象，避免把商品主图、推荐图
    // 或评价图片混入详情长图；URL 查询串原样保留，供签名 CDN 下载。
    const stateRoots = [];
    for (const key of ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
      try { if (globalThis[key] && typeof globalThis[key] === 'object') stateRoots.push(globalThis[key]); } catch {}
    }
    for (const script of document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script#__INITIAL_STATE__')) {
      try { const value = JSON.parse(script.textContent || ''); if (value && typeof value === 'object') stateRoots.push(value); } catch {}
    }
    const seen = new WeakSet();
    let visitedCount = 0;
    const visitState = (value, hint = '', depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 10 || visitedCount >= 30000 || imageEntries.length >= 240) return;
      try {
        if (seen.has(value)) return;
        seen.add(value);
        visitedCount += 1;
      } catch { return; }
      if (Array.isArray(value)) { for (const child of value.slice(0, 500)) visitState(child, hint, depth + 1); return; }
      const semantic = /(?:detail|desc|description|imageText|component|layout|picUrl|imgUrl|imageUrl|picture)/i.test(String(hint || ''));
      if (Array.isArray(value.layout) && value.componentData && typeof value.componentData === 'object') {
        for (const entry of value.layout.slice(0, 300)) {
          const model = value.componentData?.[entry?.ID]?.model || value.componentData?.[entry?.id]?.model || value.componentData?.[entry?.ID] || value.componentData?.[entry?.id];
          if (!model || typeof model !== 'object') continue;
          addImage(model.picUrl || model.imageUrl || model.imgUrl || model.src, 'state.detail.layout', 'detail-state');
          const html = String(model.text || model.content || model.html || '');
          for (const match of html.matchAll(/(?:src|data-src|data-original|poster)\\s*=\\s*["']([^"']+)["']/gi)) addImage(match[1], 'state.detail.html', 'detail-state');
        }
      }
      let entries = [];
      try { entries = Object.entries(value).slice(0, 300); } catch { return; }
      for (const [key, child] of entries) {
        const nextHint = hint ? hint + '.' + key : key;
        // 先沿 ICE 的 loaderData.home.data.res 主链走到商品状态，
        // 再在 detail/desc/component 语义节点内收集图片，避免漏掉首屏
        // 已经返回但尚未渲染成完整详情 DOM 的布局。
        if (semantic || /(?:loader|home|data|res|item|seller|components?|componentData|layout|model|text|content|html|detail|desc|description|imageText|pic|img|image)/i.test(key)) visitState(child, nextHint, depth + 1);
      }
    };
    for (const value of stateRoots) visitState(value);
    const images = imageEntries.map((item) => item.url).slice(0, 240);
    return {
      ok: Boolean(detailRoot || images.length || detailText),
      clicked: false,
      scrolled: false,
      rootFound: Boolean(detailRoot),
      imageCount: images.length,
      images,
      text: detailText,
      detailHeight: Number(detailRoot?.scrollHeight || 0) || 0,
      passes: 0,
      changedPasses: 0,
      source: imageEntries.some((item) => item.source === 'detail-state') ? 'product-page-state' : 'visible-detail-dom',
    };
  })()`;
}

// 达笔在首屏状态有视频时直接读取 item.videos；另一些淘宝模板要先打开
// 商品画廊的“视频”入口才挂载播放器地址。此脚本只在入口已经可见时打开
// “视频”标签，不滚动、不播放、不点击具体商品或购买控件。
function collectDabiVideoRevealScript() {
  return `(() => {
    const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node) return false;
      try {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      } catch { return false; }
    };
    const nodes = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],li,span,div')]
      .filter((node) => visible(node))
      .map((node) => ({ node, text: tidy(node.innerText || node.textContent || '').slice(0, 80) }))
      .filter((item) => /^(?:视频|主图视频|商品视频)$/.test(item.text) || /(?:视频|video)/i.test(String(item.node.className || '')) && item.text.length <= 40)
      .sort((left, right) => (left.text === '视频' ? 0 : 1) - (right.text === '视频' ? 0 : 1) || left.text.length - right.text.length);
    const target = nodes[0]?.node;
    if (!target) return { ok: false, reason: 'video_entry_not_visible' };
    try { if (typeof target.click === 'function') target.click(); } catch {}
    return { ok: true, clicked: true, text: tidy(target.innerText || target.textContent || '').slice(0, 80) };
  })()`;
}

module.exports = {
  CORE_PARAMETER_NAMES,
  DETAIL_PARAMETER_NAMES,
  collectDabiProductCaptureScript,
  collectDabiDetailRevealScript,
  collectDabiProductState,
  collectDabiVideoRevealScript,
  enrichDabiProductCategory,
  filterDabiMainImages,
  isDabiAuxiliaryMainImage,
  normalizeDabiParameterRows,
  normalizeDabiCategoryPath,
  parseDabiCategoryText,
  parseDabiProductParameters,
  resolveDabiCategoryRemote,
};
