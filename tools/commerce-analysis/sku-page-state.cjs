'use strict';

// 淘宝页面的 SKU 状态会随页面版本落在不同的初始化对象中。这个函数只在
// 商品页 renderer 内执行，返回已经收敛的 SKU 规格/组合，不把整份页面状态
// 带回主进程。它同时给 Electron executeJavaScript 和 Playwright evaluate 使用。
function collectDabiSkuState() {
  const tidy = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const absolute = (value) => {
    try {
      if (Array.isArray(value)) return absolute(value[0]);
      const raw = typeof value === 'object' && value !== null
        ? (value.url || value.src || value.image || value.imageUrl || value.picUrl || value.pic || value.img || value.fullPath || value.standardImage || '')
        : value;
      if (!raw) return '';
      return new URL(String(raw).replace(/^\/\//, 'https://'), location.href).href;
    } catch {
      return '';
    }
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
  const display = (value) => {
    if (object(value)) return tidy(first(value, ['name', 'value', 'valueName', 'title', 'label', 'text', 'displayName', 'desc']) || '');
    return tidy(value);
  };
  const numeric = (value) => {
    const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  };
  const money = (value, cents = false) => {
    if (value === null || value === undefined || value === '') return '';
    if (object(value)) {
      const direct = first(value, ['priceText', 'displayPrice', 'formattedPrice', 'amountText', 'valueText']);
      if (direct !== undefined) return money(direct, false);
      const amount = first(value, ['priceMoney', 'amount', 'money', 'cent', 'cents']);
      if (amount !== undefined) return money(amount, true);
      const nested = first(value, ['price', 'value', 'amountValue', 'sellPrice', 'salePrice', 'promotionPrice']);
      if (nested !== undefined && nested !== value) return money(nested, false);
      return '';
    }
    const raw = String(value).replace(/,/g, '').replace(/[¥￥$\s]/g, '').trim();
    const number = numeric(raw);
    if (number === null) return '';
    const normalized = cents || (number >= 1000 && /^\d+$/.test(raw)) ? number / 100 : number;
    return Number.isFinite(normalized) ? normalized.toFixed(2) : '';
  };
  const stock = (value) => {
    if (value === null || value === undefined || value === '') return { quantity: '', status: '' };
    if (object(value)) {
      const nested = first(value, ['quantity', 'stock', 'inventory', 'stockNum', 'quantityNum', 'num', 'count', 'availableQuantity', 'skuStock']);
      if (nested !== undefined) return stock(nested);
      const status = display(first(value, ['status', 'stockStatus', 'skuStatus', 'text', 'label']));
      return { quantity: '', status };
    }
    const raw = tidy(value, 80);
    const number = numeric(raw);
    if (number !== null && /^\s*\d+(?:\.\d+)?\s*$/.test(raw)) return { quantity: String(number), status: number > 0 ? '有货' : '缺货' };
    if (/无货|缺货|售罄|不可售|下架|false/i.test(raw)) return { quantity: '0', status: '缺货' };
    if (/有货|现货|可售|true/i.test(raw)) return { quantity: '', status: '有货' };
    return { quantity: '', status: raw };
  };
  const normalizePath = (value) => {
    if (Array.isArray(value)) return value.map((part) => tidy(part, 120)).filter(Boolean).join(';');
    return tidy(value, 1000).replace(/\s+/g, '');
  };
  const propPathOf = (value) => normalizePath(first(value, [
    'propPath', 'prop_path', 'propertyPath', 'property_path', 'salePropPath', 'sale_prop_path',
    'skuPropPath', 'sku_prop_path', 'path', 'key', 'keyName',
  ]) || '');

  const roots = [];
  const ice = globalThis.__ICE_APP_CONTEXT__;
  const loader = ice?.loaderData;
  const home = loader?.home;
  const homeData = home?.data;
  const res = homeData?.res;
  for (const candidate of [res, homeData, home, loader, ice]) if (object(candidate)) roots.push(candidate);
  for (const key of ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
    try { if (object(globalThis[key])) roots.push(globalThis[key]); } catch {}
  }
  for (const script of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script#__INITIAL_STATE__')) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      if (object(parsed)) roots.push(parsed);
    } catch {}
  }

  // 部分淘宝模板不会把 skuBase/skuCore 挂到 loaderData，而是把同一份
  // 数据留在商品组件的 React props 或 data-* 属性中。这里仅读取商品规格
  // 相关节点的页面状态，再走同一套真实 SKU ID + propPath 校验；不读取
  // Cookie、Token，也不把 DOM 文本直接当成 SKU 组合。
  const domSkuNodes = [
    ...document.querySelectorAll('[data-sku-id], [data-skuid], [data-sku], [data-prop-path], [data-property-path], [class*="sku"], [class*="Sku"], [class*="spec"], [class*="Spec"], [class*="property"], [class*="Property"], [class*="saleProp"]'),
  ].slice(0, 500);
  const domStateRoots = [];
  for (const node of domSkuNodes) {
    for (const key of Object.keys(node).filter((name) => /^(?:__reactProps|__reactEventHandlers)/i.test(name)).slice(0, 4)) {
      try {
        const value = node[key];
        if (value && typeof value === 'object') domStateRoots.push(value);
      } catch {}
    }
    try {
      const data = {};
      for (const attribute of [...(node.attributes || [])]) {
        const name = String(attribute.name || '').toLowerCase();
        if (/(?:sku|prop|spec|price|stock|quantity|inventory|image|pic)/i.test(name)) data[attribute.name] = attribute.value;
      }
      if (Object.keys(data).length) domStateRoots.push(data);
    } catch {}
  }
  roots.push(...domStateRoots);

  const objectKeyCount = (value) => value && typeof value === 'object' ? Object.keys(value).length : 0;
  const listCount = (value) => Array.isArray(value) ? value.length : object(value) ? Object.keys(value).length : 0;
  const keyNames = (value) => object(value) ? Object.keys(value).filter((key) => !/^__/.test(key)).slice(0, 80) : [];
  const skuDiagnostics = {
    hasIceContext: Boolean(ice),
    hasLoaderData: Boolean(loader),
    hasHomeData: Boolean(homeData),
    hasRes: Boolean(res),
    resKeys: keyNames(res),
    resKeyCount: objectKeyCount(res),
    skuBaseType: Array.isArray(res?.skuBase) ? 'array' : object(res?.skuBase) ? 'object' : '',
    skuBaseKeys: keyNames(res?.skuBase),
    skuBasePropsCount: listCount(res?.skuBase?.props),
    skuBaseSkusCount: listCount(res?.skuBase?.skus),
    skuCoreType: Array.isArray(res?.skuCore) ? 'array' : object(res?.skuCore) ? 'object' : '',
    skuCoreKeys: keyNames(res?.skuCore),
    sku2infoCount: listCount(res?.skuCore?.sku2info),
    domSkuNodeCount: domSkuNodes.length,
    domStateRootCount: domStateRoots.length,
  };

  const objects = [];
  const visited = new WeakSet();
  let visitedCount = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10 || visitedCount >= 30000) return;
    if (visited.has(value)) return;
    visited.add(value);
    visitedCount += 1;
    objects.push(value);
    const entries = Array.isArray(value) ? value.slice(0, 500).map((child) => ['', child]) : Object.entries(value).slice(0, 300);
    for (const [, child] of entries) walk(child, depth + 1);
  };
  for (const root of roots) walk(root);

  // 淘宝会把 SKU 总量放在不同版本的初始化对象中。只接受明确带有
  // SKU/规格上下文的计数字段，避免把评价、库存或推荐列表的 count 误当成
  // SKU 数量。itemCount 则始终表示下面成功解析出的真实组合行数。
  const integerCount = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    const raw = String(value ?? '').replace(/,/g, '').trim();
    const match = raw.match(/^(\d+)(?:\.\d+)?\s*\+?$/);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const explicitSkuCountKeys = new Set([
    'skuCount', 'skuNum', 'skuNumber', 'skuTotal', 'skuTotalCount',
    'totalSkuCount', 'totalSkuNum', 'totalSkuNumber',
    'sku_count', 'sku_num', 'sku_number', 'sku_total', 'sku_total_count',
    'total_sku_count', 'total_sku_num', 'total_sku_number',
  ]);
  const genericSkuCountKeys = new Set(['totalCount', 'totalNum', 'totalNumber', 'count', 'number']);
  const skuCountCandidates = [];
  for (const state of objects) {
    const entries = Object.entries(state).slice(0, 300);
    const keys = entries.map(([key]) => String(key));
    const hasSkuShape = keys.some((key) => /sku|variant|combination|saleProp|property/i.test(key))
      || (keys.includes('items') && keys.some((key) => /spec|prop|option|dimension/i.test(key)));
    for (const [key, value] of entries) {
      const name = String(key);
      const isExplicit = explicitSkuCountKeys.has(name);
      const isScopedGeneric = hasSkuShape && genericSkuCountKeys.has(name);
      if (!isExplicit && !isScopedGeneric) continue;
      const count = integerCount(value);
      if (count !== null) skuCountCandidates.push({ count, explicit: isExplicit });
    }
  }
  const explicitSkuCount = skuCountCandidates
    .filter((candidate) => candidate.explicit)
    .reduce((max, candidate) => Math.max(max, candidate.count), 0);
  const scopedSkuCount = skuCountCandidates
    .reduce((max, candidate) => Math.max(max, candidate.count), 0);

  const propGroups = [];
  const addPropGroup = (rawGroup) => {
    if (!object(rawGroup)) return;
    const name = tidy(first(rawGroup, ['name', 'title', 'label', 'nameText', 'propName', 'propertyName', 'propertyTitle']) || '', 100);
    const rawValues = first(rawGroup, ['values', 'valueList', 'valueMap', 'options', 'propValues', 'items']);
    if (!name || rawValues === undefined) return;
    const valueEntries = Array.isArray(rawValues)
      ? rawValues.map((value) => [first(value, ['vid', 'valueId', 'value_id', 'id']) ?? '', value])
      : Object.entries(rawValues || {}).map(([id, value]) => [id, value]);
    const values = [];
    const seen = new Set();
    for (const [fallbackId, rawValue] of valueEntries) {
      const valueName = display(rawValue);
      if (!valueName || seen.has(valueName)) continue;
      seen.add(valueName);
      const valueId = tidy(first(rawValue, ['vid', 'valueId', 'value_id', 'id']) ?? fallbackId, 120);
      values.push({
        id: valueId,
        name: valueName,
        image: absolute(first(rawValue, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'imagePath', 'standardImage']) || ''),
      });
    }
    if (!values.length) return;
    const key = name;
    const existing = propGroups.find((group) => group.name === key);
    if (existing) {
      for (const value of values) if (!existing.values.some((item) => item.name === value.name || (value.id && item.id === value.id))) existing.values.push(value);
    } else {
      propGroups.push({
        pid: tidy(first(rawGroup, ['pid', 'propId', 'propertyId', 'id']) ?? '', 120),
        name,
        values: values.slice(0, 200),
      });
    }
  };
  const addPropContainer = (raw) => {
    if (Array.isArray(raw)) for (const group of raw) addPropGroup(group);
    else if (object(raw)) {
      if (first(raw, ['name', 'title', 'label', 'propName', 'propertyName']) !== undefined && first(raw, ['values', 'valueList', 'valueMap', 'options', 'propValues', 'items']) !== undefined) addPropGroup(raw);
      else for (const [name, value] of Object.entries(raw)) if (Array.isArray(value) || object(value)) addPropGroup({ name, values: value });
    }
  };
  for (const state of objects) {
    for (const key of ['props', 'properties', 'skuProps', 'skuProperties', 'propertyList', 'saleProps', 'saleProp', 'dimensions']) {
      if (state[key] !== undefined) addPropContainer(state[key]);
    }
  }
  const sizeChartValues = new Set(['肩宽', '胸围', '袖长', '衣长', '身高', '体重']);
  const isChartOnly = (group) => group.name === '尺码' && group.values.length > 0 && group.values.every((value) => sizeChartValues.has(value.name) || /^\d+(?:\.\d+)?(?:cm|厘米)?$/i.test(value.name));
  const dimensions = propGroups.filter((group) => !isChartOnly(group)).map((group) => ({
    name: group.name,
    values: group.values.slice(0, 100).map((value) => ({ name: value.name, image: value.image, id: value.id })),
  }));
  const propMap = new Map();
  for (const group of propGroups) {
    const key = String(group.pid || '');
    if (!key) continue;
    const valueMap = new Map(group.values.map((value) => [String(value.id), value]));
    propMap.set(key, valueMap);
  }
  const specsFromPath = (path) => {
    const result = [];
    for (const token of String(path || '').split(/[;；|｜]/).map((value) => value.trim()).filter(Boolean)) {
      const split = token.split(':');
      const pid = split.shift();
      const vid = split.join(':');
      const mapped = propMap.get(String(pid || ''))?.get(String(vid || ''));
      if (mapped?.name) result.push({ name: propGroups.find((group) => String(group.pid || '') === String(pid || ''))?.name || '', value: mapped.name, image: mapped.image || '' });
    }
    return result.filter((item) => item.value);
  };
  const specsFromRaw = (raw, path = '') => {
    if (Array.isArray(raw)) return raw.flatMap((item) => specsFromRaw(item, path));
    if (object(raw)) {
      const name = tidy(first(raw, ['name', 'propName', 'label', 'propertyName', 'title']) || '', 100);
      const value = display(first(raw, ['value', 'nameValue', 'valueName', 'option', 'text', 'desc']) || (name ? raw : ''));
      if (value && value !== name) return [{ name, value, image: absolute(first(raw, ['image', 'imageUrl', 'pic', 'picUrl']) || '') }];
      const nested = first(raw, ['specs', 'properties', 'props', 'options', 'values']);
      if (nested && nested !== raw) return specsFromRaw(nested, path);
      return [];
    }
    const text = tidy(raw, 1000);
    if (!text) return [];
    return text.split(/[;,；，|｜]+/).map((part) => {
      const match = part.match(/^([^:：]+)[:：](.+)$/);
      return match ? { name: tidy(match[1], 100), value: tidy(match[2], 180), image: '' } : { name: '', value: tidy(part, 180), image: '' };
    }).filter((item) => item.value);
  };

  // 达笔的淘宝详情脚本优先读取这一条稳定链路：
  // __ICE_APP_CONTEXT__.loaderData.home.data.res.skuBase + skuCore。
  // 新版页面会把规格路径放在 skuBase.skus，把价格/库存放在
  // skuCore.sku2info；如果只做通用深度遍历，两个对象很容易被分别去重，
  // 最后得到“规格有了但没有组合”或“SKU 卡片点击采集”的空结果。
  // 这里先按达笔同样的 ID 合并方式收敛；没有这套真实结构时再继续走下方
  // 兼容旧模板的通用解析，不使用当前选中 SKU 或尺码表制造组合。
  const exactDabiRootState = (() => {
    const candidates = [res, homeData?.res, homeData, home, loader]
      .filter((candidate) => object(candidate));
    const root = candidates.find((candidate) => object(candidate.skuBase) || object(candidate.skuCore));
    if (!root) return null;
    const skuBase = object(root.skuBase) ? root.skuBase : {};
    const skuCore = object(root.skuCore) ? root.skuCore : {};
    const rawProps = Array.isArray(skuBase.props)
      ? skuBase.props
      : object(skuBase.props)
        ? Object.entries(skuBase.props).map(([name, values]) => ({ name, values }))
        : [];
    const exactProps = rawProps.map((rawGroup) => {
      if (!object(rawGroup)) return null;
      const name = tidy(first(rawGroup, ['name', 'title', 'label', 'propName', 'propertyName']) || '', 100);
      const pid = tidy(first(rawGroup, ['pid', 'propId', 'propertyId', 'id']) ?? '', 120);
      const rawValues = first(rawGroup, ['values', 'valueList', 'valueMap', 'options', 'propValues', 'items']);
      const entries = Array.isArray(rawValues)
        ? rawValues.map((value) => [first(value, ['vid', 'valueId', 'value_id', 'id']) ?? '', value])
        : object(rawValues)
          ? Object.entries(rawValues)
          : [];
      const values = [];
      const seen = new Set();
      for (const [fallbackId, rawValue] of entries) {
        const valueName = display(rawValue);
        const id = tidy(first(rawValue, ['vid', 'valueId', 'value_id', 'id']) ?? fallbackId, 120);
        if (!valueName || seen.has(valueName)) continue;
        seen.add(valueName);
        values.push({
          id,
          name: valueName,
          image: absolute(first(rawValue, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'standardImage']) || ''),
        });
      }
      return name && values.length ? { pid, name, values: values.slice(0, 200) } : null;
    }).filter(Boolean);
    const exactPropMap = new Map(exactProps.map((group) => [
      String(group.pid),
      new Map(group.values.map((value) => [String(value.id), value])),
    ]));
    const exactSpecsFromPath = (path) => String(path || '')
      .split(/[;；|｜]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const split = part.split(':');
        const pid = split.shift();
        const vid = split.join(':');
        const value = exactPropMap.get(String(pid || ''))?.get(String(vid || ''));
        const group = exactProps.find((item) => String(item.pid) === String(pid || ''));
        return value?.name ? { name: group?.name || '', value: value.name, image: value.image || '' } : null;
      })
      .filter(Boolean);
    const exactDimensions = exactProps.map((group) => ({
      name: group.name,
      values: group.values.slice(0, 100).map((value) => ({ name: value.name, image: value.image, id: value.id })),
    }));
    const baseRows = new Map();
    const rawBaseRows = Array.isArray(skuBase.skus)
      ? skuBase.skus.map((row) => [first(row, ['skuId', 'sku_id', 'id']) ?? '', row])
      : object(skuBase.skus)
        ? Object.entries(skuBase.skus)
        : [];
    for (const [fallbackId, rawRow] of rawBaseRows) {
      if (!object(rawRow)) continue;
      const id = tidy(first(rawRow, ['skuId', 'sku_id', 'skuID', 'id']) ?? fallbackId, 120);
      if (id && id !== '0') baseRows.set(id, rawRow);
    }
    const rawSku2Info = first(skuCore, ['sku2info', 'sku2Info', 'skuMap', 'skuInfoMap']);
    const coreRows = object(rawSku2Info) ? rawSku2Info : {};
    const ids = [...new Set([
      ...baseRows.keys(),
      ...Object.keys(coreRows).map((id) => tidy(id, 120)),
    ])].filter((id) => id && id !== '0' && id !== 'undefined' && id !== 'null');
    if (!ids.length && !exactDimensions.length) return null;
    const items = [];
    for (const id of ids.slice(0, 500)) {
      const base = baseRows.get(id) || {};
      const core = object(coreRows[id]) ? coreRows[id] : {};
      const raw = { ...base, ...core };
      const path = propPathOf(base) || propPathOf(core) || propPathOf(raw);
      const specs = exactSpecsFromPath(path);
      const fallbackSpecs = specsFromRaw(
        first(core, ['specs', 'properties', 'props', 'propNames', 'propertyList'])
          || first(base, ['specs', 'properties', 'props', 'propNames', 'propertyList'])
          || '',
      );
      const resolvedSpecs = specs.length ? specs : fallbackSpecs;
      const priceRaw = first(core, ['price', 'skuPrice', 'salePrice', 'currentPrice', 'sellPrice', 'priceInfo', 'priceVO', 'priceText'])
        ?? first(base, ['price', 'skuPrice', 'salePrice', 'currentPrice', 'sellPrice', 'priceInfo', 'priceVO', 'priceText']);
      const promoRaw = first(core, ['subPrice', 'promoPrice', 'promotionPrice', 'discountPrice', 'promotion', 'promotionPriceInfo'])
        ?? first(base, ['subPrice', 'promoPrice', 'promotionPrice', 'discountPrice', 'promotion', 'promotionPriceInfo']);
      const stockRaw = first(core, ['quantity', 'stock', 'inventory', 'stockNum', 'quantityNum', 'availableQuantity', 'skuStock'])
        ?? first(base, ['quantity', 'stock', 'inventory', 'stockNum', 'quantityNum', 'availableQuantity', 'skuStock']);
      const stockStatus = first(core, ['skuStatus', 'stockStatus', 'status']) ?? first(base, ['skuStatus', 'stockStatus', 'status']);
      const inventory = stockRaw !== undefined ? stock(stockRaw) : stock(stockStatus);
      const image = absolute(
        first(core, ['image', 'imageUrl', 'pic', 'picUrl', 'skuPicture', 'skuSearchImage', 'skuImage', 'skuImg', 'imgUrl', 'imagePath', 'standardImage'])
          || first(base, ['image', 'imageUrl', 'pic', 'picUrl', 'skuPicture', 'skuSearchImage', 'skuImage', 'skuImg', 'imgUrl', 'imagePath', 'standardImage'])
          || '',
      ) || resolvedSpecs.map((item) => item.image).find(Boolean) || '';
      const skuName = resolvedSpecs.map((item) => item.value).filter(Boolean).join(' ')
        || tidy(first(core, ['skuName', 'name', 'title']) || first(base, ['skuName', 'name', 'title']) || '', 400);
      items.push({
        id,
        sku_id: id,
        sku_name: skuName,
        name: skuName,
        specs: resolvedSpecs.map((item) => ({ name: item.name || '', value: item.value, image: item.image || '' })),
        specText: resolvedSpecs.map((item) => `${item.name ? `${item.name}:` : ''}${item.value}`).join('; '),
        propPath: path,
        prop_path: path,
        price: money(priceRaw, false),
        original_price: money(
          first(core, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice'])
            ?? first(base, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice']),
          false,
        ),
        promo_price: money(promoRaw, false) || money(priceRaw, false),
        stock: inventory.quantity || inventory.status,
        quantity: inventory.quantity,
        stock_status: inventory.status || (inventory.quantity && Number(inventory.quantity) > 0 ? '有货' : ''),
        image,
        logistics_time: tidy(first(core, ['logisticsTime', 'deliveryTime', 'sendTime']) || first(base, ['logisticsTime', 'deliveryTime', 'sendTime']) || '', 120),
        source: 'dabi-root-sku',
      });
    }
    const totalCount = items.length || ids.length;
    const specImageUrls = new Set([
      ...items.map((item) => item.image).filter(Boolean),
      ...exactDimensions.flatMap((group) => group.values.map((value) => value.image).filter(Boolean)),
    ]);
    return {
      available: Boolean(exactDimensions.length || items.length),
      id: items[0]?.id || '',
      text: exactDimensions.map((group) => `${group.name}: ${group.values.map((value) => value.name).join(' / ')}`).join(' '),
      specs: exactDimensions,
      items,
      totalCount,
      itemCount: items.length,
      matrixComplete: Boolean(items.length && items.length >= totalCount),
      specImageCount: specImageUrls.size,
      source: 'dabi-root-sku',
      diagnostics: skuDiagnostics,
    };
  })();
  if (exactDabiRootState?.items?.length || exactDabiRootState?.totalCount) return exactDabiRootState;

  const baseById = new Map();
  const mapRecords = [];
  const addRecord = (id, raw, hint = '') => {
    if (raw === null || raw === undefined) return;
    if (!object(raw)) {
      if (id) mapRecords.push({ id: tidy(id, 120), raw: { stock: raw }, hint });
      return;
    }
    const candidateId = tidy(first(raw, ['skuId', 'sku_id', 'skuID', 'id', 'skuIdStr', 'outerId']) ?? id ?? '', 120);
    const path = propPathOf(raw);
    const skuLike = Boolean(candidateId || path || first(raw, ['skuPrice', 'skuStock', 'skuStatus', 'skuPicture', 'price', 'quantity', 'inventory', 'stock']));
    if (skuLike) mapRecords.push({ id: candidateId, raw, hint });
  };
  for (const state of objects) {
    for (const key of ['skuBase', 'skuCore', 'skuInfo', 'skuData', 'itemSku']) {
      if (object(state[key])) {
        const nested = state[key];
        for (const listKey of ['skus', 'skuList', 'items', 'variants', 'skuItems', 'combinations']) {
          const list = nested[listKey];
          if (Array.isArray(list)) for (const item of list) addRecord(first(item, ['skuId', 'sku_id', 'id']) ?? '', item, listKey);
          else if (object(list)) for (const [id, item] of Object.entries(list)) addRecord(id, item, listKey);
        }
        for (const mapKey of ['sku2info', 'sku2Info', 'skuMap', 'skuInfoMap', 'map']) {
          const map = nested[mapKey];
          if (object(map)) for (const [id, item] of Object.entries(map)) addRecord(id, item, mapKey);
        }
      }
    }
    for (const key of ['sku2info', 'sku2Info', 'skuMap', 'skuInfoMap']) {
      const map = state[key];
      if (object(map)) for (const [id, item] of Object.entries(map)) addRecord(id, item, key);
    }
    for (const key of ['skus', 'skuList', 'variants', 'skuItems', 'combinations']) {
      const list = state[key];
      if (Array.isArray(list)) for (const item of list) addRecord(first(item, ['skuId', 'sku_id', 'id']) ?? '', item, key);
      else if (object(list)) for (const [id, item] of Object.entries(list)) addRecord(id, item, key);
    }
  }
  // 淘宝新版会把 skuBase 的路径和 sku2info 的价格拆到更深的组件树里，
  // 键名也不总是固定在 root.skuBase。对象遍历已经限制了深度和总量，
  // 因此可以安全地把“明确带 skuId 或规格路径”的深层记录补入同一索引；
  // 不接受只有页面文本/当前选中项的对象，避免再次生成伪 SKU。
  for (const state of objects) {
    const directSkuId = first(state, ['skuId', 'sku_id', 'skuID', 'outerId']);
    if (directSkuId || propPathOf(state)) addRecord(directSkuId || '', state, 'deep-sku-record');
    for (const [key, value] of Object.entries(state).slice(0, 300)) {
      if (!/sku2?info|sku(?:List|Map|Info|Data|Base)|variants|combinations/i.test(key)) continue;
      if (Array.isArray(value)) {
        for (const item of value) addRecord(first(item, ['skuId', 'sku_id', 'skuID', 'id']) ?? '', item, `deep-${key}`);
      } else if (object(value)) {
        for (const [id, item] of Object.entries(value)) addRecord(id, item, `deep-${key}`);
      }
    }
  }
  // 先把带 propPath 的基础 SKU 建成索引，后面给 sku2info 补规格路径。
  for (const record of mapRecords) {
    const path = propPathOf(record.raw);
    if (record.id && path) baseById.set(record.id, record.raw);
  }
  // 同一条 SKU 通常拆在 skuBase（规格路径）和 sku2info（价格/库存）两处；
  // 先按 ID 合并，避免先读到基础行后把带价格的 sku2info 行去重掉。
  const mergedRecords = new Map();
  for (const record of mapRecords) {
    if (!record.id || record.id === '0') continue;
    const existing = mergedRecords.get(record.id);
    if (!existing) {
      mergedRecords.set(record.id, { ...record, raw: { ...(record.raw || {}) } });
      continue;
    }
    const merged = { ...(existing.raw || {}), ...(record.raw || {}) };
    for (const key of ['price', 'priceInfo', 'priceVO', 'subPrice', 'promotionPrice', 'skuPicture']) {
      if (object(existing.raw?.[key]) && object(record.raw?.[key])) merged[key] = { ...existing.raw[key], ...record.raw[key] };
    }
    existing.raw = merged;
    existing.hint = `${existing.hint || ''},${record.hint || ''}`;
  }
  const rows = [];
  const rowKeys = new Set();
  for (const record of mergedRecords.values()) {
    const raw = record.raw;
    const id = record.id;
    if (!id || id === '0' || id === 'undefined' || id === 'null') continue;
    const base = baseById.get(id) || {};
    const path = propPathOf(raw) || propPathOf(base);
    let specs = specsFromPath(path);
    if (!specs.length) specs = specsFromRaw(first(raw, ['specs', 'properties', 'props', 'skuProps', 'propertyList', 'options']) || first(base, ['specs', 'properties', 'props', 'skuProps', 'propertyList', 'options']) || '');
    const priceRaw = first(raw, ['skuPrice', 'price', 'salePrice', 'currentPrice', 'sellPrice', 'priceInfo', 'priceVO', 'priceText']) ?? first(base, ['skuPrice', 'price', 'salePrice', 'currentPrice', 'sellPrice', 'priceInfo', 'priceVO', 'priceText']);
    const price = money(priceRaw, false);
    const promoRaw = first(raw, ['subPrice', 'promoPrice', 'promotionPrice', 'discountPrice', 'salePrice', 'promotion', 'promotionPriceInfo']) ?? first(base, ['subPrice', 'promoPrice', 'promotionPrice', 'discountPrice', 'salePrice', 'promotion', 'promotionPriceInfo']);
    const promo = money(promoRaw, false) || price;
    const originalSource = first(raw, ['price', 'priceInfo', 'priceVO']);
    const baseOriginalSource = first(base, ['price', 'priceInfo', 'priceVO']);
    const originalRaw = first(raw, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice', 'priceOrigin'])
      ?? first(originalSource, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice', 'priceOrigin'])
      ?? first(base, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice', 'priceOrigin'])
      ?? first(baseOriginalSource, ['originalPrice', 'originPrice', 'marketPrice', 'listPrice', 'tagPrice', 'priceOrigin']);
    const original = money(originalRaw, false);
    const stockValue = first(raw, ['quantity', 'stock', 'inventory', 'stockNum', 'quantityNum', 'availableQuantity', 'skuStock']) ?? first(base, ['quantity', 'stock', 'inventory', 'stockNum', 'quantityNum', 'availableQuantity', 'skuStock']);
    const rawSkuStatus = first(raw, ['skuStatus', 'stockStatus', 'status']) ?? first(base, ['skuStatus', 'stockStatus', 'status']);
    const inventory = stockValue !== undefined
      ? stock(stockValue)
      : (/^(?:1|true|有货|现货|可售)$/i.test(String(rawSkuStatus ?? ''))
        ? { quantity: '', status: '有货' }
        : /^(?:0|false|无货|缺货|售罄)$/i.test(String(rawSkuStatus ?? ''))
          ? { quantity: '0', status: '缺货' }
          : stock(rawSkuStatus));
    const image = absolute(first(raw, ['image', 'imageUrl', 'pic', 'picUrl', 'skuPicture', 'skuSearchImage']) || first(base, ['image', 'imageUrl', 'pic', 'picUrl', 'skuPicture', 'skuSearchImage']) || '') || specs.map((item) => item.image).find(Boolean) || '';
    if (!specs.length && !path) continue;
    const key = `${id}|${path}|${specs.map((item) => `${item.name}:${item.value}`).join('|')}`;
    if (rowKeys.has(key)) continue;
    rowKeys.add(key);
    const skuName = specs.map((item) => item.value).filter(Boolean).join(' ');
    rows.push({
      id,
      sku_id: id,
      sku_name: skuName,
      name: skuName,
      specs: specs.map((item) => ({ name: item.name || '', value: item.value, image: item.image || '' })),
      specText: specs.map((item) => `${item.name ? `${item.name}:` : ''}${item.value}`).join('; '),
      propPath: path,
      prop_path: path,
      price,
      original_price: original,
      promo_price: promo,
      stock: inventory.quantity || inventory.status,
      quantity: inventory.quantity,
      stock_status: inventory.status || (inventory.quantity && Number(inventory.quantity) > 0 ? '有货' : ''),
      image,
      logistics_time: tidy(first(raw, ['logisticsTime', 'deliveryTime', 'sendTime']) || first(base, ['logisticsTime', 'deliveryTime', 'sendTime']) || '', 120),
    });
  }
  const uniqueRows = rows.filter((row, index, values) => values.findIndex((item) => item.id === row.id) === index).slice(0, 500);
  const text = dimensions.map((group) => `${group.name}: ${group.values.map((value) => value.name).join(' / ')}`).join(' ');
  const specImageUrls = new Set([
    ...uniqueRows.map((row) => row.image).filter(Boolean),
    ...dimensions.flatMap((group) => group.values.map((value) => value.image).filter(Boolean)),
  ]);
  const itemCount = uniqueRows.length;
  const totalCount = explicitSkuCount || scopedSkuCount || itemCount;
  return {
    available: Boolean(dimensions.length || uniqueRows.length || totalCount),
    id: uniqueRows[0]?.id || '',
    text,
    specs: dimensions,
    items: uniqueRows,
    totalCount,
    itemCount,
    matrixComplete: Boolean(itemCount && (!scopedSkuCount || itemCount >= totalCount)),
    specImageCount: specImageUrls.size,
    source: uniqueRows.length ? 'dabi-page-state' : 'dabi-page-state-no-matrix',
    diagnostics: skuDiagnostics,
  };
}

function collectDabiSkuCaptureScript() {
  return `(${collectDabiSkuState.toString()})()`;
}

function collectDabiSkuRevealScript() {
  return `(() => {
    const tidy = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node) return false;
      try {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      } catch { return false; }
    };
    const score = (node) => {
      const marker = String(node.id || '') + ' ' + String(node.className || '') + ' ' + tidy(node.innerText || '').slice(0, 240);
      return (/(?:sku|spec|property|skuinfo)/i.test(marker) ? 100 : 0)
        + (/(?:颜色分类|尺码|规格|选择规格)/i.test(marker) ? 60 : 0)
        - Math.min(tidy(node.innerText || '').length, 240) / 20;
    };
    const candidates = [
      ...document.querySelectorAll('[class*=sku], [class*=Sku], [class*=spec], [class*=Spec], [class*=property], [class*=Property], [id*=sku], [id*=spec]'),
    ].filter((node) => visible(node) && /(?:颜色分类|尺码|规格|选择规格|sku)/i.test(tidy(node.innerText || '').slice(0, 1000)));
    const broadCandidates = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],li,section,div')]
      .filter((node) => visible(node) && /(?:选择规格|颜色分类|尺码|规格)/i.test(tidy(node.innerText || '').slice(0, 600)))
      .filter((node) => tidy(node.innerText || '').length <= 2400);
    const target = [...candidates, ...broadCandidates].sort((left, right) => score(right) - score(left))[0];
    if (!target) return { ok: false, reason: 'sku_section_not_visible' };
    // 只允许打开“选择规格/规格”入口，不点击具体颜色或尺码，避免改变当前
    // 选中项；打开后页面会按模板懒加载真实 skuBase/skuCore 或组件 props。
    const targetText = tidy(target.innerText || '').slice(0, 160);
    const canOpen = /^(?:选择规格|规格)(?:\s*[>＞])?$/i.test(targetText);
    if (canOpen && typeof target.click === 'function') {
      try { target.click(); return { ok: true, clicked: true, text: targetText, tag: String(target.tagName || '') }; } catch {}
    }
    return { ok: true, clicked: false, text: targetText, tag: String(target.tagName || '') };
  })()`;
}

module.exports = { collectDabiSkuState, collectDabiSkuCaptureScript, collectDabiSkuRevealScript };
