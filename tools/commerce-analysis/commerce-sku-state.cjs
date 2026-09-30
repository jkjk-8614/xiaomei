'use strict';

// 规格读取器只接受页面已经暴露的 SKU 标识、规格路径和库存/价格字段。
// 没有真实组合标识时返回空集合，不用当前选中项推算其它组合。

function collectCommerceSkuState() {
  const tidy = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const imageKeys = [
    'url', 'src', 'currentSrc', 'image', 'imageUrl', 'img', 'imgUrl', 'pic', 'picUrl',
    'skuImage', 'skuImageUrl', 'valueImage', 'valueImageUrl', 'smallImage', 'bigImage',
    'thumbnail', 'thumb', 'imagePath',
  ];
  const first = (source, keys) => {
    if (!object(source)) return '';
    for (const key of keys) if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    return '';
  };
  const absolute = (value) => {
    try {
      let raw = object(value) ? first(value, imageKeys) : value;
      if (object(raw)) raw = first(raw, imageKeys);
      const text = String(raw || '').trim();
      return text ? new URL(text.replace(/^\/\//, 'https://'), location.href).href : '';
    } catch { return ''; }
  };
  const generatedStatePath = (value) => /^(?:\.[A-Za-z0-9_$-]+)+\.?$/.test(tidy(value, 600));
  const scalar = (value) => object(value) ? tidy(first(value, ['name', 'value', 'valueName', 'title', 'label', 'text', 'displayName', 'desc']), 180) : tidy(value, 180);
  const number = (value) => { const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return match ? Number(match[0]) : null; };
  const money = (value) => { const n = number(value); if (n === null) return ''; const raw = String(value ?? '').trim(); return n >= 1000 && /^\d+$/.test(raw) ? (n / 100).toFixed(2) : n.toFixed(2); };
  const roots = [];
  for (const key of ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
    try { if (object(globalThis[key])) roots.push(globalThis[key]); } catch {}
  }
  const items = [];
  const itemById = new Map();
  const specs = [];
  const groupsById = new Map();
  const valuesByKey = new Map();
  const valuesById = new Map();
  const declaredCounts = [];

  const asList = (value) => {
    if (Array.isArray(value)) return value;
    if (object(value)) return Object.entries(value).map(([key, child]) => {
      if (object(child)) return { ...child, __mapKey: key };
      return { __mapKey: key, value: child, name: child };
    });
    return value === undefined || value === null || value === '' ? [] : [value];
  };

  const rawSpecList = (value) => {
    if (Array.isArray(value)) return value;
    if (object(value)) return Object.entries(value).map(([name, child]) => ({ name, value: child }));
    const text = tidy(value, 1000);
    if (!text || generatedStatePath(text)) return [];
    return text.split(/[;,；|｜]+/).map((part) => tidy(part, 180)).filter(Boolean);
  };

  const addSpecGroup = (source) => {
    if (!object(source)) return null;
    const groupId = tidy(first(source, ['propId', 'prop_id', 'propertyId', 'property_id', 'pid', 'id', 'key', '__mapKey']), 120);
    const name = tidy(first(source, ['name', 'propName', 'propertyName', 'title', 'label', 'nameText', 'displayName']), 120);
    const rawValues = first(source, ['values', 'valueList', 'options', 'propValues', 'items', 'list', 'value']);
    const values = [];
    for (const rawValue of asList(rawValues)) {
      const valueObject = object(rawValue) ? rawValue : { name: rawValue };
      const valueId = tidy(first(valueObject, ['valueId', 'value_id', 'vid', 'id', 'key', '__mapKey']), 120);
      const valueName = tidy(first(valueObject, ['name', 'valueName', 'value', 'title', 'label', 'text', 'displayName', 'desc']), 180);
      if (!valueName || generatedStatePath(valueName)) continue;
      const image = absolute(first(valueObject, imageKeys));
      const groupKey = groupId ? `id:${groupId}` : `name:${name}`;
      let group = specs.find((item) => item.__key === groupKey || (!groupId && item.name === name));
      if (!group) {
        group = { __key: groupKey, id: groupId, name: name || (groupId ? `规格${groupId}` : '规格'), values: [] };
        specs.push(group);
        if (groupId) groupsById.set(groupId, group);
      }
      let existing = group.values.find((item) => (valueId && item.id === valueId) || item.name === valueName);
      if (!existing) {
        existing = { id: valueId, name: valueName, value: valueName, image, selected: Boolean(valueObject.selected || valueObject.active || valueObject.isSelected), disabled: Boolean(valueObject.disabled || valueObject.soldOut || valueObject.outOfStock) };
        group.values.push(existing);
      } else {
        if (!existing.id && valueId) existing.id = valueId;
        if (!existing.image && image) existing.image = image;
        existing.selected = existing.selected || Boolean(valueObject.selected || valueObject.active || valueObject.isSelected);
        existing.disabled = existing.disabled && Boolean(valueObject.disabled || valueObject.soldOut || valueObject.outOfStock);
      }
      if (groupId && valueId) valuesByKey.set(`${groupId}:${valueId}`, { group, value: existing });
      if (valueId) {
        const previous = valuesById.get(valueId);
        valuesById.set(valueId, previous && previous !== existing ? null : existing);
      }
    }
    return specs.find((item) => item.__key === (groupId ? `id:${groupId}` : `name:${name}`) || (!groupId && item.name === name)) || null;
  };

  const specsForPath = (path) => {
    const result = [];
    const images = [];
    for (const token of String(path || '').split(/[;；]+/)) {
      const match = token.trim().match(/^([^:：]+)[:：]([^:：]+)$/);
      if (!match) continue;
      const propId = tidy(match[1], 120);
      const valueId = tidy(match[2], 120);
      const mapped = valuesByKey.get(`${propId}:${valueId}`);
      const group = groupsById.get(propId) || mapped?.group;
      const value = mapped?.value || (valuesById.get(valueId) || null);
      const valueName = value?.name || valueId;
      if (value?.image) images.push(value.image);
      result.push({ name: group?.name || propId, value: valueName, id: value?.id || valueId, image: value?.image || '' });
    }
    return { specs: result, images };
  };

  const normalizeItemSpecs = (raw) => {
    const result = [];
    for (const entry of rawSpecList(raw)) {
      if (entry === null || entry === undefined) continue;
      const source = object(entry) ? entry : { value: entry };
      const name = tidy(first(source, ['name', 'propName', 'propertyName', 'label', 'key']), 120);
      const value = tidy(first(source, ['value', 'nameValue', 'valueName', 'option', 'desc', 'text', 'displayName', 'title', 'name']), 180);
      if (!value || generatedStatePath(value)) continue;
      result.push({ name, value, id: tidy(first(source, ['id', 'valueId', 'vid', 'value_id']), 120), image: absolute(first(source, imageKeys)) });
    }
    return result;
  };

  const addItem = (source) => {
    if (!object(source)) return;
    const explicitId = first(source, ['skuId', 'sku_id', 'skuID']);
    const path = tidy(first(source, ['propPath', 'prop_path', 'propertyPath', 'property_path', 'salePropPath', 'path', 'key']), 600);
    const rawSpecs = first(source, ['specs', 'properties', 'props', 'skuName', 'sku_name', 'name']);
    const id = tidy(explicitId || (path ? first(source, ['id', 'itemId']) : ''), 160);
    if (!id || (!path && !rawSpecs)) return;
    const mapped = specsForPath(path);
    const normalizedSpecs = mapped.specs.length ? mapped.specs : normalizeItemSpecs(rawSpecs);
    const directImage = absolute(first(source, imageKeys));
    const next = {
      id,
      skuId: id,
      propPath: path,
      specs: normalizedSpecs.slice(0, 20),
      specText: normalizedSpecs.map((value) => value.value || value.name).filter(Boolean).join(' / '),
      sku_name: tidy(first(source, ['sku_name', 'skuName', 'displayName', 'name']), 400),
      price: money(first(source, ['price', 'salePrice', 'promotionPrice', 'sellPrice', 'currentPrice'])),
      stock: tidy(first(source, ['stock', 'quantity', 'inventory', 'stockNum', 'availableQuantity']), 80),
      status: scalar(first(source, ['status', 'stockStatus', 'skuStatus'])),
      image: directImage || mapped.images[0] || '',
      source: 'visible-product-state',
    };
    const existing = itemById.get(id);
    if (!existing) {
      itemById.set(id, next);
      items.push(next);
      return;
    }
    if (!existing.propPath && next.propPath) existing.propPath = next.propPath;
    if (mapped.specs.length || (!existing.specs || !existing.specs.length)) existing.specs = next.specs;
    if (mapped.specs.length || !existing.specText) existing.specText = next.specText;
    if (!existing.sku_name && next.sku_name && !generatedStatePath(next.sku_name)) existing.sku_name = next.sku_name;
    if (!existing.price && next.price) existing.price = next.price;
    if (!existing.stock && next.stock) existing.stock = next.stock;
    if (!existing.status && next.status) existing.status = next.status;
    if (!existing.image && next.image) existing.image = next.image;
  };

  const parseSkuContainer = (container) => {
    if (!object(container)) return;
    const rawGroups = first(container, ['props', 'properties', 'skuProps', 'propList', 'propertyList', 'specs']);
    for (const rawGroup of asList(rawGroups)) addSpecGroup(rawGroup);

    const rawItems = first(container, ['skus', 'skuList', 'skuItems', 'items', 'variants', 'combinations']);
    if (Array.isArray(rawItems)) declaredCounts.push(rawItems.length);
    else if (object(rawItems)) declaredCounts.push(Object.keys(rawItems).length);
    for (const rawItem of asList(rawItems)) {
      if (object(rawItem)) addItem(rawItem);
      else if (rawItem !== null && rawItem !== undefined && rawItem !== '') addItem({ skuId: rawItem });
    }

    for (const mapKey of ['sku2info', 'skuInfoMap', 'skuMap', 'sku_map', 'map']) {
      const rawMap = container[mapKey];
      if (!object(rawMap)) continue;
      declaredCounts.push(Object.keys(rawMap).length);
      for (const [key, rawItem] of Object.entries(rawMap)) {
        if (object(rawItem)) addItem({ ...rawItem, skuId: first(rawItem, ['skuId', 'sku_id', 'skuID', 'id']) || key });
        else addItem({ skuId: key, stock: rawItem });
      }
    }
  };

  const stateContainers = [];
  const visited = new WeakSet();
  const walk = (value, hint = '', depth = 0) => {
    if (items.length >= 500 || !value || typeof value !== 'object' || depth > 9 || visited.has(value)) return;
    visited.add(value);
    if (object(value)) {
      const lastKey = String(hint || '').split('.').pop() || '';
      if (/^(?:skuBase|skuCore|skuInfo|skuMap|sku2info)$/i.test(lastKey) || (Array.isArray(value.skus) && (value.props || value.properties))) stateContainers.push(value);
      addItem(value);
    }
    const entries = Array.isArray(value) ? value.slice(0, 180).map((child) => ['', child]) : Object.entries(value).slice(0, 220);
    for (const [key, child] of entries) walk(child, `${hint}.${key}`, depth + 1);
  };
  roots.forEach((root) => walk(root));
  stateContainers.forEach(parseSkuContainer);
  for (const node of document.querySelectorAll('[data-sku-id],[data-skuid],[data-sku],[data-prop-path],[data-property-path]')) {
    const data = node.dataset || {};
    const propPath = data.propPath || data.propertyPath;
    if (propPath) addItem({ skuId: data.skuId || data.skuid || data.sku, propPath, specs: tidy(node.innerText || node.textContent || '', 500), price: data.price, stock: data.stock || data.quantity });
  }

  const visible = (node) => {
    try {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const nodeImage = (node) => {
    const image = node?.querySelector?.('img');
    const styleImage = String(node?.getAttribute?.('style') || '').match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i)?.[1] || '';
    return absolute(image?.currentSrc || image?.src || image?.dataset?.src || image?.dataset?.original || image?.getAttribute?.('data-imgurl') || styleImage);
  };
  const optionSelector = '[data-value],[data-pv],[data-sku-value],[data-value-id],[role="option"],[class*="value"],[class*="Value"],[class*="option"],[class*="Option"],button,li,a';
  const optionNodes = typeof document === 'undefined' ? [] : [...document.querySelectorAll(optionSelector)].filter(visible).slice(0, 1600);
  const optionText = (node) => {
    const host = node?.closest?.(optionSelector) || node;
    return tidy(node?.innerText || node?.textContent || host?.getAttribute?.('title') || host?.getAttribute?.('aria-label')
      || host?.getAttribute?.('data-value') || host?.getAttribute?.('data-pv') || host?.getAttribute?.('data-sku-value')
      || host?.getAttribute?.('data-value-id') || node?.querySelector?.('img')?.alt || '', 240);
  };
  const optionInfo = (node) => {
    const host = node?.closest?.(optionSelector) || node;
    return {
      name: optionText(node),
      id: host?.getAttribute?.('data-value-id') || host?.getAttribute?.('data-value') || host?.getAttribute?.('data-pv') || host?.getAttribute?.('data-sku-value') || '',
      image: nodeImage(node) || nodeImage(host),
      selected: host?.getAttribute?.('aria-selected') === 'true' || /(?:selected|active|checked|tb-selected)/i.test(String(host?.className || '')),
      disabled: host?.getAttribute?.('aria-disabled') === 'true' || /(?:disabled|soldout|out-stock|缺货|无货)/i.test(String(host?.className || '')),
    };
  };
  if (typeof document !== 'undefined') {
    const labels = [...document.querySelectorAll('body *')].filter(visible).filter((node) => /^(?:颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合)$/.test(tidy(node.innerText || node.textContent || '', 80))).slice(0, 120);
    for (const label of labels) {
      let ancestor = label.parentElement;
      let best = null;
      for (let level = 0; ancestor && level < 6; level += 1, ancestor = ancestor.parentElement) {
        const candidates = [...ancestor.querySelectorAll(optionSelector)].filter((node) => visible(node) && node !== label && !label.contains(node));
        const leafNodes = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)));
        const values = leafNodes.map(optionInfo).filter((item) => item.name && !/^(?:选择|请选择|规格|颜色|尺码|尺寸|分类|有货|无货|库存)$/i.test(item.name));
        if (values.length >= 2 && values.length <= 120) {
          best = values;
          break;
        }
      }
      if (best?.length) addSpecGroup({ name: tidy(label.innerText || label.textContent || '', 80), values: best });
    }
  }
  for (const group of specs) {
    for (const value of group.values || []) {
      if (value.image || !value.name) continue;
      const match = optionNodes.find((node) => {
        const text = optionText(node);
        return text === value.name || text.includes(value.name) || value.name.includes(text);
      });
      if (match) value.image = nodeImage(match);
    }
  }

  if (!specs.length && typeof document !== 'undefined') {
    const groupSeen = new Set();
    for (const node of [...document.querySelectorAll('[class*="sku"],[class*="Sku"],[class*="spec"],[class*="Spec"],[class*="property"],[class*="Property"]')].filter(visible).slice(0, 300)) {
      const text = tidy(node.innerText || node.textContent || '', 400);
      if (!text || generatedStatePath(text) || groupSeen.has(text)) continue;
      groupSeen.add(text);
      const values = text.split(/\n+/).map((value) => tidy(value, 80)).filter((value) => value && !/^(?:选择|规格|颜色|尺码|分类)$/i.test(value));
      if (values.length > 1) specs.push({ name: values[0], values: values.slice(1, 60).map((value) => ({ name: value, value })) });
      if (specs.length >= 30) break;
    }
  }
  // 当规格组只从当前可见 DOM 的文本兜底得到时，再做一次图片回填；
  // 这样新版页面即使不把 props 放进初始化状态，也不会丢掉缩略图。
  for (const group of specs) {
    for (const value of group.values || []) {
      if (value.image || !value.name) continue;
      const match = optionNodes.find((node) => {
        const text = optionText(node);
        return text === value.name || text.includes(value.name) || value.name.includes(text);
      });
      if (match) value.image = nodeImage(match);
    }
  }
  for (const group of specs) delete group.__key;
  const totalCount = Math.max(items.length, ...declaredCounts, 0);
  const specImageCount = new Set([
    ...items.map((item) => item.image || '').filter(Boolean),
    ...specs.flatMap((group) => (group.values || []).map((value) => value.image || '').filter(Boolean)),
  ]).size;
  const text = specs.map((group) => `${group.name}: ${(group.values || []).map((value) => value.value || value.name).join('、')}`).join('；');
  return { available: Boolean(items.length || specs.length), specs, items, itemCount: items.length, totalCount, matrixComplete: Boolean(items.length && items.length >= totalCount), specImageCount, text, source: 'commerce-product-state', diagnostics: { stateRootCount: roots.length, itemCount: items.length, groupCount: specs.length, stateContainerCount: stateContainers.length } };
}

function collectCommerceSkuCaptureScript() { return `(${collectCommerceSkuState.toString()})()`; }

function collectCommerceSkuRevealScript() {
  return `(() => {
    const visible = (node) => { if (!node) return false; try { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; } catch { return false; } };
    const candidates = [...document.querySelectorAll('button,[role="button"],[role="tab"],a,li,span,div')]
      .filter(visible)
      .map((node) => {
        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        const clickable = node.matches?.('button,[role="button"],[role="tab"],a') || node.closest?.('button,[role="button"],[role="tab"],a');
        const actionText = /^(?:选择规格|展开规格|更多规格)$/.test(text);
        return { node: clickable && clickable !== true ? clickable : node, text, score: (actionText ? 1000 : 0) + (clickable ? 200 : 0) + (/sku|spec|规格/i.test(String(node.className || '')) ? 100 : 0) };
      })
      .filter((item) => /^(?:选择规格|规格|颜色|尺码|展开规格|更多规格)$/.test(item.text) && (item.score > 0 || /^(?:选择规格|展开规格|更多规格)$/.test(item.text)))
      .sort((left, right) => right.score - left.score);
    const target = candidates[0]?.node;
    if (!target) return { ok: false, clicked: false, reason: 'sku_entry_not_visible' };
    try { target.click(); } catch {}
    return { ok: true, clicked: true, text: String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
  })()`;
}

module.exports = { collectCommerceSkuState, collectCommerceSkuCaptureScript, collectCommerceSkuRevealScript };
