(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const q = (selector, root = document) => [...root.querySelectorAll(selector)];
  const SHARED_SKILL_SELECTION_KEY = 'xiaomei_agent_skill_selection_v1';
  function readSharedSkillId() {
    try { return String(localStorage.getItem(SHARED_SKILL_SELECTION_KEY) || '').trim(); } catch { return ''; }
  }
  const state = {
    url: $('productUrl')?.value || '', productUrl: $('productUrl')?.value || '', jobId: '', job: null, result: null, operation: null,
    browserSession: null, embeddedUrl: '', polling: null, pageContext: null, pageContextKey: '', pageContextUrl: '', pageContextTimer: null, pageContextShownKey: '', pageContextLoading: false, siteContext: null, siteContextKey: '', siteContextUrl: '', siteContextTimer: null, siteContextLoading: false, siteContextStatus: '', conversationId: '', conversationProductKey: '', messages: [], chatAttachments: [], chatAttachmentsUploading: false, chatAttachmentUploadSerial: 0, reportTab: 'overview', skillId: readSharedSkillId(), skillItems: [], skillLoading: false, skillError: '', skillQuery: '', selectedResourceIds: new Set(), resourceSelectionProductKey: '',
    productKey: '', analysisProductKey: '', analysisRequestToken: '', analysisStarting: false, autoCollectionProductKey: '', autoCollectionAuthRetryKeys: new Set(), surfaceSyncTimer: null, productInfoExpanded: null,
    modelProviders: [], modelLoading: false, modelError: '', chatProvider: '', chatModel: '',
    tabs: [{ id: 'analysis', title: '商品分析台', type: 'analysis', url: '', closable: true }], activeTabId: 'analysis', tabSerial: 0,
    browserNav: { canGoBack: false, canGoForward: false, loading: false, zoom: 100 }, browserMenuPage: 'main',
    assistantOverride: false, assistantManualHidden: false, assistantOpen: true, assistantWidth: 390, assistantMode: 'analysis',
    desktop: Boolean(shellApi() || new URLSearchParams(location.search).get('desktop')),
  };
  const collectionProgress = new Map();
  // Surface-state events can arrive after Electron has disposed a WebContentsView.
  // Remember locally closed IDs so a late event cannot resurrect an empty tab.
  const closedCommerceTabIds = new Set();
  let commerceTabDragState = null;
  const BASE_COLLECTION_MODULE = 'base';
  const REVIEW_QUESTIONS_COLLECTION_MODULE = 'reviews_questions';
  const moduleLabels = { base: '商品基础信息', product: '商品信息', images: '主图', detail: '详情页', reviews: '评价', questions: '问大家', reviews_questions: '评价和问大家', sku: 'SKU', videos: '视频', operations: '运营' };
  const moduleOrder = ['product', 'images', 'detail', 'reviews', 'questions', 'sku', 'videos'];
  const resourceOrder = ['product', 'videos', 'images', 'detail', 'detail_more', 'sku_images', 'sku_list', 'reviews', 'questions', 'operations', 'people'];
  const resourceLabels = { product: '商品信息', images: '主图', detail: '详情页长图', detail_more: '详情页多图', sku_images: 'SKU图', sku_list: 'SKU列表', reviews: '评价', questions: '问大家', videos: '主图视频', operations: '运营数据报表', people: '人群结构数据' };
  const resourceIcons = { product: '▣', images: '▧', detail: '▤', detail_more: '▤', sku_images: '◇', sku_list: '▥', reviews: '◉', questions: '?', videos: '▶', operations: '⌁', people: '♙' };
  const mediaResourceIds = new Set(['images', 'detail', 'detail_more', 'sku_images', 'videos']);
  const CHAT_SETTINGS_KEY = 'gpt_chat_settings_v1';
  const COMMERCE_CHAT_SETTINGS_KEY = 'xiaomei_commerce_chat_model_v1';
  const CHAT_USER_KEY = 'gpt_chat_browser_user';
  const CHAT_LAST_CONVERSATION_KEY = 'gpt_chat_last_conversation_v1';
  const CHAT_CONVERSATION_TOUCH_KEY = 'gpt_chat_conversation_touch_v1';
  const PRODUCT_CONVERSATION_MAP_KEY = 'xiaomei_commerce_conversation_by_product_v1';
  const ASSISTANT_WIDTH_KEY = 'xiaomei_commerce_assistant_width_v1';
  const BROWSER_HISTORY_KEY = 'xiaomei_browser_history_v1';
  const BROWSER_BOOKMARKS_KEY = 'xiaomei_browser_bookmarks_v1';
  const CHAT_ATTACHMENT_MAX = 20;
  let conversationRestoreSerial = 0;
  let lastConversationRestoreKey = '';
  let lastConversationRestoreTabId = '';
  function createBrowserId() { try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch {} return `u-${Math.random().toString(16).slice(2)}${Date.now()}`; }
  function sharedChatUserId() { try { const current = String(localStorage.getItem(CHAT_USER_KEY) || '').trim(); if (current) return current; const next = createBrowserId(); localStorage.setItem(CHAT_USER_KEY, next); return next; } catch { return 'anonymous'; } }
  const chatUserId = sharedChatUserId();
  function readSharedConversationId() { try { return String(localStorage.getItem(CHAT_LAST_CONVERSATION_KEY) || '').trim(); } catch { return ''; } }
  function notifySharedConversation(id, notify = true, options = {}) {
    const conversationId = String(id || '').trim();
    if (options.remember !== false && (conversationId || state.conversationProductKey || state.productKey)) {
      rememberConversationForProduct(state.conversationProductKey || state.productKey, conversationId);
    }
    try {
      if (conversationId) localStorage.setItem(CHAT_LAST_CONVERSATION_KEY, conversationId);
      else localStorage.removeItem(CHAT_LAST_CONVERSATION_KEY);
      if (notify) localStorage.setItem(CHAT_CONVERSATION_TOUCH_KEY, JSON.stringify({ id: conversationId, at: Date.now(), source: 'commerce-analysis' }));
    } catch {}
  }

  function readProductConversationMap() {
    try {
      const value = JSON.parse(localStorage.getItem(PRODUCT_CONVERSATION_MAP_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function storedProductConversationId(productKey) {
    const key = String(productKey || '').trim();
    if (!key) return '';
    const value = readProductConversationMap()[key];
    return String(value || '').trim();
  }
  function writeProductConversationId(productKey, conversationId) {
    const key = String(productKey || '').trim();
    if (!key) return;
    try {
      const map = readProductConversationMap();
      const id = String(conversationId || '').trim();
      if (id) map[key] = id;
      else delete map[key];
      localStorage.setItem(PRODUCT_CONVERSATION_MAP_KEY, JSON.stringify(map));
    } catch {}
  }
  function isConversationProductTab(tab) {
    return Boolean(conversationContextKey(tab));
  }
  function tabProductConversationKey(tab) {
    return isConversationProductTab(tab) ? conversationContextKey(tab) : '';
  }
  function rememberConversationForProduct(productKey, conversationId = state.conversationId, messages = state.messages, tab = null) {
    const key = String(productKey || '').trim();
    if (!key) return;
    const id = String(conversationId || '').trim();
    writeProductConversationId(key, id);
    const targetTab = tab || activeCommerceTab();
    if (targetTab && tabProductConversationKey(targetTab) === key) {
      targetTab.conversationProductKey = key;
      targetTab.conversationId = id;
      targetTab.conversationMessages = Array.isArray(messages) ? messages.slice() : [];
    }
  }
  function rememberActiveTabConversation() {
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    const key = tabProductConversationKey(tab) || (tab?.type === 'commerce' ? (state.conversationProductKey || state.productKey) : '');
    if (key) rememberConversationForProduct(key, state.conversationId, state.messages, tab);
  }
  function conversationIdForProduct(productKey, tab = null) {
    const key = String(productKey || '').trim();
    const targetTab = tab || activeCommerceTab();
    if (targetTab && tabProductConversationKey(targetTab) === key && targetTab.conversationProductKey === key && targetTab.conversationId !== undefined && targetTab.conversationId !== null) {
      return String(targetTab.conversationId || '').trim();
    }
    return storedProductConversationId(key);
  }
  let boundsEmitFrame = 0;
  const quickPrompts = {
    reviews: '请结合这个商品的评价数据和问大家数据，分析用户真实需求和购买顾虑，包括：1. 高频好评诉求和差评焦点；2. 反复出现的使用场景、人群和痛点；3. 问大家里最显著的购买顾虑；4. 可以反映到主图、详情页和客服话术的优化建议。请输出结构化结论，并引用数据来源。',
    detail: '请以附带的详情页长图连续屏幕片段为准，先核对实际屏数，再逐屏分析这个电商详情页的内容结构，包括：1) 每屏的视觉焦点和文案内容；2) 卖点呈现顺序；3) 视觉风格和配色；4) 转化逻辑（如何一步步引导购买）。不要把原始图片素材数量当作屏数，也不要把淘宝平台级促销横幅、价格说明、推荐或评价等公共图片算入商品详情主体。请详细描述。 @详情页长图',
    images: '请逐张分析这个商品主图的点击转化能力，包括：1) 每张主图的视觉焦点、构图和文案内容；2) 核心卖点是否清晰突出；3) 人群、场景、规格、价格等关键信息是否表达充分；4) 主图顺序是否能逐步建立购买兴趣；5) 可优化的主图顺序和改图建议。请详细描述。 @主图',
    videos: '请分析这个商品主图视频的内容结构和转化逻辑，包括：1）前3秒是否抓住注意力；2）展示了哪些使用场景、功能卖点和信任证据；3）镜头节奏、字幕和文案表达是否清晰；4）用户购买顾虑是否被解决；5）可复用的视频脚本结构和优化建议。请详细描述。 @主图视频',
    operations: '请结合这个商品的运营数据和商品页数据，分析当前商品的经营信号、风险与优先级，并给出主图、详情页、客服和投放的优化建议。请明确哪些结论来自运营数据。',
    people: '请结合这个商品的人群结构数据和商品页数据，分析核心人群、购买场景和产品表达机会，并给出主图、详情页、标题和客服话术的优化建议。请明确哪些结论来自人群结构数据。',
  };
  const searchPrompts = {
    market: '我正在分析当前淘宝搜索关键词的市场机会。请基于当前搜索结果页的真实可见商品数据，回答：1. 主要人群、场景和显性/隐性需求；2. 供给密度与竞争强弱；3. 哪些卖点、价格和标题表达值得开发；4. 给出一个可执行的新品开发建议。只引用当前页已返回的数据，不要编造未返回的销量或市场规模。',
    priceSales: '请基于当前淘宝搜索结果，分析价格带和销量分布，重点回答：1. 商品主要集中在哪些价格带，供给密度和销量信号如何；2. 哪些价格带竞争最激烈，哪些可能存在差异化空间；3. 高销量商品通常落在哪些价格段，它们的标题、卖点和店铺特征是什么；4. 新品应主攻哪个价格带、避开哪个价格带。请区分页面真实数据与推断。',
    titleTerms: '请基于当前淘宝搜索结果，拆解商品标题里的高频词和词根，按功能词、材质词、人群词、场景词、款式/规格词分类；说明哪些词与高销量、价格或商品定位相关，并给出可用于标题、主图文案和搜索投放的词组建议。只使用当前页返回的标题样本。',
    competitors: '请从当前淘宝搜索结果中筛选值得重点观察的高销量低价竞品。先说明低价和高销量的筛选口径，再列出 5-10 个候选商品，包含标题、价格、销量信号、店铺、发货地和商品链接；分析它们低价还能卖动的原因，并标出疑似引流款或异常低价款。',
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  function safeMarkdownHref(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, window.location.href);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '';
      return escapeHtml(parsed.href);
    } catch {
      return '';
    }
  }
  function renderInlineMarkdown(value) {
    let source = String(value ?? '');
    const protectedTokens = [];
    const protect = (html) => `\uE000${protectedTokens.push(html) - 1}\uE001`;
    source = source.replace(/`([^`\n]+)`/g, (_, code) => protect(`<code>${escapeHtml(code)}</code>`));
    source = source.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) => {
      const href = safeMarkdownHref(url);
      return href ? protect(`<a href="${href}" target="_blank" rel="noreferrer noopener">${renderInlineMarkdown(label)}</a>`) : label;
    });
    source = source.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
      const trailing = (url.match(/[),.;!?]+$/) || [''])[0];
      const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
      const href = safeMarkdownHref(cleanUrl);
      return href ? `${prefix}${protect(`<a href="${href}" target="_blank" rel="noreferrer noopener">${escapeHtml(cleanUrl)}</a>`)}${trailing}` : match;
    });
    let html = escapeHtml(source);
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    return html.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedTokens[Number(index)] || '');
  }
  function splitMarkdownTableRow(value) {
    let row = String(value || '').trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }
  function isMarkdownTableSeparator(value) {
    const cells = splitMarkdownTableRow(value);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }
  function renderMarkdownMessage(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map((line) => renderInlineMarkdown(line)).join('<br>')}</p>`);
      paragraph = [];
    };
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        index += 1;
        continue;
      }
      const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
      if (fence) {
        flushParagraph();
        const code = [];
        let cursor = index + 1;
        while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor])) { code.push(lines[cursor]); cursor += 1; }
        const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
        blocks.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
        index = cursor < lines.length ? cursor + 1 : cursor;
        continue;
      }
      const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        blocks.push('<hr>');
        index += 1;
        continue;
      }
      if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
        flushParagraph();
        const header = splitMarkdownTableRow(line);
        const rows = [];
        let cursor = index + 2;
        while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
          rows.push(splitMarkdownTableRow(lines[cursor]));
          cursor += 1;
        }
        const normalizeRow = (row) => [...row, ...Array(Math.max(0, header.length - row.length)).fill('')].slice(0, header.length);
        blocks.push(`<div class="md-table-wrap"><table><thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${normalizeRow(row).map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        index = cursor;
        continue;
      }
      const quote = line.match(/^\s{0,3}>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        const quoteLines = [];
        let cursor = index;
        while (cursor < lines.length) {
          const match = lines[cursor].match(/^\s{0,3}>\s?(.*)$/);
          if (!match) break;
          quoteLines.push(match[1]);
          cursor += 1;
        }
        blocks.push(`<blockquote>${renderMarkdownMessage(quoteLines.join('\n'))}</blockquote>`);
        index = cursor;
        continue;
      }
      const unordered = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s{0,3}(\d+)[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const orderedList = Boolean(ordered);
        const items = [];
        let cursor = index;
        let start = ordered ? Number(ordered[1]) : 1;
        while (cursor < lines.length) {
          const match = lines[cursor].match(orderedList ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-*+]\s+(.+)$/);
          if (!match) break;
          let item = match[1];
          cursor += 1;
          while (cursor < lines.length && /^\s{2,}\S/.test(lines[cursor]) && !/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[cursor])) {
            item += ` ${lines[cursor].trim()}`;
            cursor += 1;
          }
          items.push(item);
        }
        const tag = orderedList ? 'ol' : 'ul';
        const startAttr = orderedList && start !== 1 ? ` start="${start}"` : '';
        blocks.push(`<${tag}${startAttr}>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`);
        index = cursor;
        continue;
      }
      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
    return blocks.join('') || '<p></p>';
  }
  const text = (value, fallback = '未返回') => String(value ?? '').trim() || fallback;
  function isUsableProductTitle(value) {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized || /^(?:商品详情|商品页|淘宝(?:网)?|天猫|1688|商品分析台|未读取商品|商品信息待返回|待登录[／/]验证后读取|验证码拦截)$/i.test(normalized)) return false;
    return !/大模型|解答您的疑问|问问小美|正在加载商品|商品页已打开/i.test(normalized);
  }
  function productDisplayTitle(result = currentResult()) {
    const product = result?.product || {};
    const tabTitle = activeCommerceTab()?.title || '';
    const candidates = [
      product.title,
      product.name,
      result?.productTitle,
      result?.title,
      tabTitle,
    ].map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return candidates.find(isUsableProductTitle) || candidates[0] || '';
  }
  function toast(message) { const node = $('toast'); if (!node) return; node.textContent = message; node.classList.add('is-visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('is-visible'), 3000); }
  function uniqueModels(values) { const seen = new Set(); return (Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter((value) => value && !seen.has(value) && seen.add(value)); }
  function shortModelName(value) { return String(value || '').split('/').pop().split(':')[0] || '当前模型'; }
  function readJsonStorage(key) { try { const parsed = JSON.parse(localStorage.getItem(key) || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
  function chatModelProviders() { return (state.modelProviders || []).filter((provider) => provider && provider.id !== 'modelscope' && provider.enabled !== false && uniqueModels(provider.chat_models).length); }
  function storedModelSelection() {
    const shared = readJsonStorage(CHAT_SETTINGS_KEY); const own = readJsonStorage(COMMERCE_CHAT_SETTINGS_KEY); const provider = String(shared.provider || own.provider || '').trim();
    const providerModels = shared.chatProviderModels && typeof shared.chatProviderModels === 'object' ? shared.chatProviderModels : {};
    return { provider, model: String(providerModels[provider] || shared.activeChatModel || own.model || '').trim(), providerModels };
  }
  function saveModelSelection() {
    if (!state.chatProvider || !state.chatModel) return;
    try {
      const shared = readJsonStorage(CHAT_SETTINGS_KEY); const providerModels = shared.chatProviderModels && typeof shared.chatProviderModels === 'object' ? { ...shared.chatProviderModels } : {};
      providerModels[state.chatProvider] = state.chatModel;
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ ...shared, provider: state.chatProvider, activeChatModel: state.chatModel, chatProviderModels: providerModels }));
      localStorage.setItem(COMMERCE_CHAT_SETTINGS_KEY, JSON.stringify({ provider: state.chatProvider, model: state.chatModel }));
    } catch {}
  }
  function currentChatProvider() { return chatModelProviders().find((provider) => provider.id === state.chatProvider) || chatModelProviders()[0] || null; }
  function syncModelSelection() {
    const providers = chatModelProviders(); const saved = storedModelSelection();
    if (!providers.length) { state.chatProvider = ''; state.chatModel = ''; updateModelButton(); return; }
    const provider = providers.find((item) => item.id === saved.provider) || providers[0]; const models = uniqueModels(provider.chat_models);
    const savedForProvider = saved.providerModels[provider.id]; state.chatProvider = provider.id; state.chatModel = models.includes(savedForProvider) ? savedForProvider : models.includes(saved.model) ? saved.model : models[0] || '';
    saveModelSelection(); updateModelButton();
  }
  function updateModelButton() {
    const button = $('modelPickerButton'); const label = $('modelPickerLabel'); if (!button || !label) return;
    const provider = currentChatProvider(); const modelLabel = state.chatModel ? shortModelName(state.chatModel) : state.modelLoading ? '读取模型…' : '选择模型';
    label.textContent = modelLabel; button.title = state.chatModel ? `${provider?.name || provider?.id || 'API'} · ${state.chatModel}` : '选择对话模型';
  }
  function renderModelPicker() {
    const providerList = $('modelProviderList'); const modelList = $('modelModelList'); const status = $('modelPickerStatus'); if (!providerList || !modelList) return;
    const providers = chatModelProviders(); const currentProvider = currentChatProvider();
    providerList.innerHTML = providers.length ? providers.map((provider) => `<button class="model-provider-option ${provider.id === state.chatProvider ? 'active' : ''}" type="button" data-model-provider="${escapeHtml(provider.id)}"><span>${escapeHtml(provider.name || provider.id)}</span><small>${uniqueModels(provider.chat_models).length} 个模型</small></button>`).join('') : `<div class="model-picker-empty">${state.modelLoading ? '正在读取可用模型…' : state.modelError || '当前没有可用的对话模型'}</div>`;
    const models = currentProvider ? uniqueModels(currentProvider.chat_models) : [];
    modelList.innerHTML = models.length ? models.map((model) => `<button class="model-option ${model === state.chatModel ? 'active' : ''}" type="button" data-chat-model="${escapeHtml(model)}"><span>${escapeHtml(shortModelName(model))}</span><small>${escapeHtml(model)}</small>${model === state.chatModel ? '<b>✓</b>' : ''}</button>`).join('') : `<div class="model-picker-empty">${state.modelError || '请先选择一个有聊天模型的平台'}</div>`;
    if (status) status.textContent = state.modelError ? state.modelError : state.modelLoading ? '正在同步 API 模型…' : currentProvider ? `当前：${currentProvider.name || currentProvider.id} · ${shortModelName(state.chatModel)}` : '未选择模型';
    q('[data-model-provider]', providerList).forEach((button) => { button.onclick = () => selectChatProvider(button.dataset.modelProvider); });
    q('[data-chat-model]', modelList).forEach((button) => { button.onclick = () => selectChatModel(button.dataset.chatModel); });
    updateModelButton();
  }
  function selectChatProvider(providerId) {
    const provider = chatModelProviders().find((item) => item.id === providerId); if (!provider) return;
    const models = uniqueModels(provider.chat_models); const saved = storedModelSelection(); state.chatProvider = provider.id; state.chatModel = models.includes(saved.providerModels[provider.id]) ? saved.providerModels[provider.id] : models[0] || '';
    saveModelSelection(); renderModelPicker();
  }
  function selectChatModel(model) {
    const provider = currentChatProvider(); const models = uniqueModels(provider?.chat_models); if (!provider || !models.includes(model)) return;
    state.chatModel = model; saveModelSelection(); renderModelPicker(); toggleModelPicker(false); toast(`已切换到 ${shortModelName(model)}`);
  }
  async function loadModelProviders() {
    state.modelLoading = true; state.modelError = ''; renderModelPicker();
    try {
      const response = await fetch('/api/providers', { cache: 'no-store' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || data.message || `模型列表请求失败（${response.status}）`);
      state.modelProviders = Array.isArray(data.providers) ? data.providers : [];
      if (!chatModelProviders().length) {
        const configResponse = await fetch('/api/config', { cache: 'no-store' }); const config = await configResponse.json().catch(() => ({})); const fallbackModels = uniqueModels(config.chat_models || [config.chat_model]);
        if (fallbackModels.length) state.modelProviders = [{ id: 'local-api', name: '本地 API', enabled: true, chat_models: fallbackModels }];
      }
      syncModelSelection();
    } catch (error) { state.modelError = error.message || '无法读取模型列表'; }
    finally { state.modelLoading = false; renderModelPicker(); }
  }
  function toggleModelPicker(force) {
    const button = $('modelPickerButton'); const popover = $('modelPickerPopover'); if (!button || !popover) return;
    const open = typeof force === 'boolean' ? force : popover.hidden; popover.hidden = !open; popover.classList.toggle('is-open', open); button.setAttribute('aria-expanded', String(open));
    if (open) { renderModelPicker(); if (!state.modelProviders.length && !state.modelLoading) loadModelProviders(); }
  }
  function setSiteState(message, kind = 'ok') { const node = $('siteState'); if (!node) return; node.innerHTML = `<i></i>${escapeHtml(message)}`; node.querySelector('i').style.background = kind === 'error' ? '#e96474' : kind === 'busy' ? '#f6ae24' : ''; }
  function setJobState(message, kind = '') { $('jobMessage').textContent = text(message, '尚未开始采集'); const pulse = $('jobPulse'); pulse.className = `status-pulse ${kind ? `is-${kind}` : ''}`; }
  function postParent(message) { try { window.parent?.postMessage(message, '*'); } catch {} }
  function shellApi() { return window.electronAPI || window.parent?.electronAPI || null; }
  function assistantProfileApi() { return window.XiaomeiCommerceAssistantProfiles || null; }
  function assistantProfileForTab(tab = activeCommerceTab()) {
    const url = safeCommerceUrl(tab?.url || '');
    const api = assistantProfileApi();
    if (url && isCommerceLoginUrl(url)) {
      const target = commerceLoginTarget(url, tab?.site || tab?.platform);
      return { site: target.site, id: `${target.site}-login`, pageType: 'other', title: `${target.label}登录` };
    }
    const matched = url ? api?.classify?.(url) || null : null;
    // 有些站点在同一 URL 内切换详情弹窗。桌面采集器确认页型后，优先
    // 使用该同站点页型；站内跳转会在 updateCommerceTabFromSurface 中清掉它。
    const remembered = tab?.siteAssistantProfile;
    if (matched && remembered?.site === matched.site && remembered?.id) return remembered;
    if (matched) return matched;
    // 站点跳到统一登录/验证域名时仍保留右侧面板，避免用户失去“完成后重试”的入口。
    const site = String(tab?.site || tab?.platform || '').trim().toLowerCase();
    const title = api?.siteLabels?.[site];
    return title && url ? { site, id: `${site}-pending`, pageType: 'other', title } : null;
  }
  function isSiteAssistantTab(tab = activeCommerceTab()) { return Boolean(assistantProfileForTab(tab)); }
  function siteAssistantContextKey(tab = activeCommerceTab()) {
    const api = assistantProfileApi();
    const url = safeCommerceUrl(tab?.url || '');
    const profile = assistantProfileForTab(tab);
    const key = url && profile ? (api?.tabContextKey?.(url, profile, tab?.id) || api?.contextKey?.(url, profile)) : '';
    return key ? `site:${key}` : '';
  }
  // 1688 商品详情沿用已有的商品对话和任务键；其他五站点及 1688 非详情页
  // 使用脱敏页面键，确保标签切换/站内跳转不会串上下文。
  function usesDedicatedSiteConversation(tab = activeCommerceTab()) {
    return Boolean(isSiteAssistantTab(tab) && !isDetailCommerceUrl(tab?.url || ''));
  }
  function conversationContextKey(tab = activeCommerceTab()) {
    if (usesDedicatedSiteConversation(tab)) return siteAssistantContextKey(tab);
    if (tab?.type === 'commerce' && (tab.kind === 'detail' || tab.kind === 'product') && (tab.productUrl || tab.url)) return productContextKey(tab.productUrl || tab.url);
    return '';
  }
  function activeConversationContextKey() { return conversationContextKey(activeCommerceTab()); }
  function activeSiteAssistantView(tab = activeCommerceTab()) {
    const key = siteAssistantContextKey(tab);
    if (!key || !state.siteContext || state.siteContextKey !== key) return null;
    return state.siteContext;
  }

  function browserList(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
    } catch { return []; }
  }
  function saveBrowserList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(Array.isArray(list) ? list.slice(0, 100) : [])); } catch {}
  }
  function hasPendingNativeNavigation(tab = activeCommerceTab()) {
    const requestedUrl = safeCommerceUrl(tab?.requestedUrl || '');
    const committedUrl = safeCommerceUrl(tab?.url || '');
    const revisionPending = Number(tab?.surfaceRevision || 0) > Number(tab?.committedNavigationRevision || 0);
    return Boolean(shellApi()?.openProduct && tab?.browserNav?.loading && (revisionPending || (requestedUrl && requestedUrl !== committedUrl)));
  }
  function browserCurrentUrl() {
    const tab = activeCommerceTab();
    if (hasPendingNativeNavigation(tab)) return '';
    return safeCommerceUrl(tab?.url || state.productUrl || $('productUrl')?.value || '');
  }
  function browserCurrentTitle(url = browserCurrentUrl()) {
    const tab = activeCommerceTab();
    if (tab?.title && tab.title !== '商品分析台' && tab.title !== '新标签页') return tab.title;
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return '当前页面'; }
  }
  function rememberBrowserHistory(url, title = '') {
    const safeUrl = safeCommerceUrl(url);
    if (!safeUrl) return;
    const list = browserList(BROWSER_HISTORY_KEY).filter((item) => item.url !== safeUrl);
    list.unshift({ url: safeUrl, title: String(title || browserCurrentTitle(safeUrl)).trim() || '当前页面', at: Date.now() });
    saveBrowserList(BROWSER_HISTORY_KEY, list);
  }
  function updateBrowserNavigation(payload = {}) {
    const next = {
      canGoBack: Boolean(payload.canGoBack),
      canGoForward: Boolean(payload.canGoForward),
      loading: Boolean(payload.loading),
      zoom: Number.isFinite(Number(payload.zoom)) ? Math.round(Number(payload.zoom)) : state.browserNav.zoom || 100,
    };
    state.browserNav = next;
    const back = $('browserBack');
    const forward = $('browserForward');
    const reload = $('browserReload');
    if (back) { back.disabled = !next.canGoBack; back.title = next.canGoBack ? '后退' : '没有可后退的页面'; }
    if (forward) { forward.disabled = !next.canGoForward; forward.title = next.canGoForward ? '前进' : '没有可前进的页面'; }
    if (reload) { reload.textContent = next.loading ? '■' : '↻'; reload.title = next.loading ? '停止加载' : '刷新'; reload.setAttribute('aria-label', next.loading ? '停止加载' : '刷新'); }
    const zoom = $('browserZoomValue'); if (zoom) zoom.textContent = `${next.zoom}%`;
    updateBrowserTranslationButton();
  }
  function updateBrowserTranslationButton() {
    const button = $('browserTranslate');
    if (!button) return;
    const tab = activeCommerceTab();
    const active = Boolean(tab?.pageTranslationActive);
    const available = tab?.type === 'commerce';
    button.textContent = active ? '恢复原文' : '翻译中文';
    button.title = active ? '恢复当前页面原文' : '将当前页面翻译成中文（需要本机 LibreTranslate）';
    button.setAttribute('aria-label', button.title);
    button.disabled = !available || Boolean(state.browserNav.loading);
  }
  function closeBrowserMenu() {
    const popover = $('browserMenuPopover'); const button = $('browserMenuButton');
    if (!popover) return;
    const wasOpen = !popover.hidden;
    popover.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    state.browserMenuPage = 'main';
    $('browserMenuMain')?.removeAttribute('hidden');
    $('browserMenuSubpage')?.setAttribute('hidden', '');
    // In the Electron desktop build the product page is a native WebContentsView
    // above this iframe. Restore it only after the menu has actually been closed;
    // otherwise the native view covers the menu and a click appears to do nothing.
    if (wasOpen) setCommerceNativeOverlayActive(false);
  }
  function browserMenuNavigate(url) {
    const safeUrl = safeCommerceUrl(url);
    if (!safeUrl) return toast('该历史记录不属于允许的官方页面');
    closeBrowserMenu();
    // 桌面版商品页由原生 WebContentsView 承载；复用 openProduct 才会真正
    // 调用桌面桥接加载地址，避免只切换标签状态而留下空白页面。
    openProduct(safeUrl);
  }
  function addCurrentBrowserBookmark() {
    const url = browserCurrentUrl();
    if (!url) return toast('新标签页没有可收藏的地址');
    const list = browserList(BROWSER_BOOKMARKS_KEY).filter((item) => item.url !== url);
    list.unshift({ url, title: browserCurrentTitle(url), at: Date.now() });
    saveBrowserList(BROWSER_BOOKMARKS_KEY, list);
    renderBrowserMenuSubpage('bookmarks');
    toast('已添加到书签和清单');
  }
  function renderBrowserMenuSubpage(page) {
    const main = $('browserMenuMain'); const subpage = $('browserMenuSubpage'); const title = $('browserMenuSubpageTitle'); const content = $('browserMenuSubpageContent');
    if (!main || !subpage || !title || !content) return;
    state.browserMenuPage = page;
    main.hidden = true; subpage.hidden = false;
    const isHistory = page === 'history';
    title.textContent = isHistory ? '历史记录' : '书签和清单';
    const list = browserList(isHistory ? BROWSER_HISTORY_KEY : BROWSER_BOOKMARKS_KEY);
    const head = isHistory ? '' : '<button type="button" data-browser-bookmark-add><strong>添加当前页面到书签</strong><small>保存当前标签页地址</small></button>';
    const rows = list.slice(0, 30).map((item, index) => `<button type="button" data-browser-menu-url="${escapeHtml(item.url)}" data-browser-menu-index="${index}"><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.url)}</small></button>`).join('');
    content.innerHTML = `${head}${rows || '<div class="browser-menu-empty">这里还没有记录</div>'}`;
  }
  function toggleBrowserMenu(force) {
    const popover = $('browserMenuPopover'); const button = $('browserMenuButton');
    if (!popover) return;
    const open = typeof force === 'boolean' ? force : popover.hidden;
    if (!open) return closeBrowserMenu();
    if (popover.hidden) setCommerceNativeOverlayActive(true);
    popover.hidden = false;
    button?.setAttribute('aria-expanded', 'true');
    state.browserMenuPage = 'main';
    $('browserMenuMain')?.removeAttribute('hidden');
    $('browserMenuSubpage')?.setAttribute('hidden', '');
    updateBrowserNavigation(state.browserNav);
  }
  async function importBrowserData(file) {
    if (!file) return;
    try {
      const source = await file.text();
      const imported = [];
      const add = (value, fallbackTitle = '') => {
        const rawUrl = typeof value === 'string' ? value : value?.url || value?.href || '';
        const url = safeCommerceUrl(rawUrl);
        if (!url) return;
        const title = typeof value === 'object' ? value.title || value.name || fallbackTitle : fallbackTitle;
        if (!imported.some((item) => item.url === url)) imported.push({ url, title: String(title || url).trim(), at: Date.now() });
      };
      if (/\.json$/i.test(file.name) || /^s*[[{]/.test(source)) {
        const data = JSON.parse(source);
        const visit = (value) => {
          if (!value) return;
          if (Array.isArray(value)) return value.forEach(visit);
          if (typeof value !== 'object') return;
          if (value.url) add(value, value.name || value.title || '导入书签');
          if (Array.isArray(value.children)) value.children.forEach(visit);
          if (Array.isArray(value.roots)) value.roots.forEach(visit);
          Object.entries(value).forEach(([key, child]) => { if (key !== 'children' && key !== 'roots' && child && typeof child === 'object') visit(child); });
        };
        visit(data);
      } else {
        const documentFragment = new DOMParser().parseFromString(source, 'text/html');
        q('a[href]', documentFragment).forEach((anchor) => add({ url: anchor.getAttribute('href'), title: anchor.textContent.trim() || '导入书签' }));
      }
      if (!imported.length) throw new Error('没有找到允许的国内或跨境平台官网地址');
      const merged = [...imported, ...browserList(BROWSER_BOOKMARKS_KEY)].filter((item, index, all) => item.url && all.findIndex((candidate) => candidate.url === item.url) === index);
      saveBrowserList(BROWSER_BOOKMARKS_KEY, merged);
      closeBrowserMenu();
      toast(`已导入 ${imported.length} 条书签`);
    } catch (error) { toast(error.message || '浏览器数据导入失败'); }
  }
  function handleBrowserMenuAction(action) {
    if (action === 'new-tab') { closeBrowserMenu(); openNewAnalysisTab(); return; }
    if (action === 'history' || action === 'bookmarks') { renderBrowserMenuSubpage(action); return; }
    if (action === 'menu-back') { toggleBrowserMenu(true); return; }
    if (action === 'import') { $('browserImportFile')?.click(); return; }
    if (action === 'passwords') { closeBrowserMenu(); toast('小美浏览器不会保存或读取密码'); return; }
    if (action === 'clear-data') { closeBrowserMenu(); clearBrowserData(); return; }
    const shell = shellApi();
    if (action === 'zoom-out' || action === 'zoom-in' || action === 'zoom-reset') {
      if (shell?.changeBrowserZoom) Promise.resolve(shell.changeBrowserZoom(action === 'zoom-in' ? 'in' : action === 'zoom-out' ? 'out' : 'reset', state.activeTabId)).then((result) => { if (result?.zoom) updateBrowserNavigation({ ...state.browserNav, zoom: result.zoom }); }).catch(() => {});
      else updateBrowserNavigation({ ...state.browserNav, zoom: action === 'zoom-in' ? Math.min(200, state.browserNav.zoom + 10) : action === 'zoom-out' ? Math.max(50, state.browserNav.zoom - 10) : 100 });
      return;
    }
    if (action === 'fullscreen') { closeBrowserMenu(); if (shell?.toggleBrowserFullscreen) Promise.resolve(shell.toggleBrowserFullscreen()).catch(() => {}); else toast('当前浏览器模式不支持全屏'); }
  }
  async function clearBrowserData() {
    const confirmed = window.confirm('删除小美浏览器数据？\n将清除本地历史记录，并可清除当前淘宝会话；书签不会被删除。');
    if (!confirmed) return;
    try { localStorage.removeItem(BROWSER_HISTORY_KEY); } catch {}
    const shell = shellApi();
    if (shell?.clearCommerceSession) {
      try {
        const result = await shell.clearCommerceSession();
        if (!result?.ok) return toast(result?.message || '清除淘宝会话失败');
      } catch (error) { return toast(error.message || '清除淘宝会话失败'); }
    }
    toast('浏览数据已清除');
  }
  // 商品页是 Electron 的顶层 WebContentsView，iframe 内的弹层无法覆盖它。
  // 优先调用桌面桥接；普通浏览器/旧版 preload 则交给外层应用壳转发。
  function setCommerceNativeOverlayActive(active) {
    const next = Boolean(active);
    try {
      const shell = shellApi();
      if (typeof shell?.setCommerceOverlayActive === 'function') {
        shell.setCommerceOverlayActive(next);
        return;
      }
    } catch {}
    postParent({ type: 'commerce-overlay', active: next });
  }
  function handleCollectionProgress(payload = {}) {
    const activeTab = activeCommerceTab();
    if (payload.tabId && activeTab?.id && payload.tabId !== activeTab.id) return;
    const progressModule = String(payload.module || '').toLowerCase();
    const isReviewModule = ['reviews', 'questions'].includes(progressModule);
    const progressSampleCount = Number(payload.sampleCount);
    let message = String(payload.message || '').trim();
    if (!message) return;
    // 兼容旧版桌面桥接仍发送“（28/120）”的进度文案：真实进度以当前
    // 已解析样本数为准，120 只是滚动上限，不能再作为评价总量展示。
    if (payload.action === 'scroll' && Number.isFinite(progressSampleCount) && progressSampleCount >= 0) {
      const label = progressModule === 'questions' ? '问大家' : '用户评价';
      const totalCount = String(payload.totalCount ?? '').trim();
      message = `正在滚动采集${label}：已采集 ${progressSampleCount} 条${totalCount ? `，页面总量 ${totalCount}` : ''}…`;
    }
    const status = String(payload.status || 'running').toLowerCase();
    if (isReviewModule && ['scroll', 'extract'].includes(payload.action) && Number.isFinite(progressSampleCount) && progressSampleCount >= 0) {
      collectionProgress.set(progressModule, {
        sampleCount: progressSampleCount,
        totalCount: String(payload.totalCount ?? '').trim(),
      });
    } else if (isReviewModule && payload.action === 'start') {
      collectionProgress.delete(progressModule);
    } else if (payload.action === 'finish' || ['ready', 'partial', 'stopped'].includes(status)) {
      collectionProgress.delete('reviews');
      collectionProgress.delete('questions');
    }
    if (state.result && (isReviewModule || payload.action === 'finish')) renderResources(state.result);
    $('surfaceStatus').textContent = message;
    const terminal = ['ready', 'partial', 'stopped'].includes(status);
    setJobState(message, terminal ? 'ready' : status === 'error' ? 'error' : 'running');
    setSiteState(message, terminal || status === 'stopped' ? 'ok' : status === 'error' ? 'error' : 'busy');
    const operationOverlay = $('agentOperationOverlay');
    if (operationOverlay) {
      const interactive = payload.interactionMode === 'visible' || ['reviews', 'questions', 'reviews_questions'].includes(String(payload.module || '').toLowerCase());
      operationOverlay.hidden = !interactive || terminal || status === 'error';
      operationOverlay.classList.toggle('is-stopped', interactive && status === 'stopped');
      const messageNode = operationOverlay.querySelector('[data-agent-operation-message]');
      if (messageNode) messageNode.textContent = message;
    }
  }
  function commerceFrameIsActive() {
    try {
      if (window.top === window) return true;
      return Boolean(window.frameElement?.classList.contains('active'));
    } catch { return true; }
  }
  function setProductViewVisible(visible, tabId = state.activeTabId) {
    if (visible && !commerceFrameIsActive()) return;
    shellApi()?.setProductVisible?.(Boolean(visible), tabId);
  }
  // 跨境平台入口优先请求简体中文；最终语言仍以平台自身能力和已保存的站点偏好为准。
  const desktopPlatformDefinitions = Object.freeze({
    '1688': { id: '1688', label: '1688', url: 'https://www.1688.com/', glyph: '源', className: 'source-dot', hostSuffixes: ['1688.com'] },
    dmp: { id: 'dmp', label: '达摩盘', url: 'https://dmp.taobao.com/', glyph: '摩', className: 'dmp-dot', hostSuffixes: ['dmp.taobao.com'] },
    xiaohongshu: { id: 'xiaohongshu', label: '小红书', url: 'https://www.xiaohongshu.com/', glyph: '红', className: 'xiaohongshu-dot', hostSuffixes: ['xiaohongshu.com', 'rednote.com'] },
    douyin: { id: 'douyin', label: '抖音', url: 'https://www.douyin.com/', glyph: '抖', className: 'douyin-dot', hostSuffixes: ['douyin.com'] },
    amazon: { id: 'amazon', label: '亚马逊', url: 'https://www.amazon.com/?language=zh_CN', glyph: 'a', className: 'amazon-dot', hostSuffixes: ['amazon.com', 'amazon.cn', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.in', 'amazon.com.mx', 'amazon.com.br', 'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.tr', 'amazon.eg'] },
    'tiktok-shop': { id: 'tiktok-shop', label: 'TikTok Shop', url: 'https://shop.tiktok.com/?lang=zh-Hans', glyph: '♪', className: 'tiktok-shop-dot', hostSuffixes: ['tiktok.com', 'tiktokshop.com'] },
    temu: { id: 'temu', label: 'Temu', url: 'https://www.temu.com/?language=zh', glyph: 'T', className: 'temu-dot', hostSuffixes: ['temu.com', 'temu.co.uk', 'temu.de', 'temu.fr', 'temu.it', 'temu.es', 'temu.nl', 'temu.pl', 'temu.se', 'temu.au', 'temu.ca', 'temu.mx', 'temu.cl', 'temu.co', 'temu.com.br', 'temu.jp', 'temu.kr'] },
    shopee: { id: 'shopee', label: '虾皮 Shopee', url: 'https://shopee.com/?language=zh-Hans', glyph: 'S', className: 'shopee-dot', hostSuffixes: ['shopee.com', 'shopee.co.id', 'shopee.sg', 'shopee.co.th', 'shopee.co.my', 'shopee.vn', 'shopee.ph', 'shopee.tw', 'shopee.com.br', 'shopee.cl', 'shopee.pl'] },
    ozon: { id: 'ozon', label: 'Ozon', url: 'https://www.ozon.ru/?language=zh', glyph: 'O', className: 'ozon-dot', hostSuffixes: ['ozon.ru', 'ozon.com'] },
    ebay: { id: 'ebay', label: 'eBay', url: 'https://www.ebay.com/?locale=zh-CN', glyph: 'e', className: 'ebay-dot', hostSuffixes: ['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.ca', 'ebay.com.au', 'ebay.at', 'ebay.be', 'ebay.ch', 'ebay.ie', 'ebay.nl', 'ebay.pl', 'ebay.com.sg', 'ebay.com.my', 'ebay.ph', 'ebay.in'] },
    aliexpress: { id: 'aliexpress', label: '速卖通', url: 'https://www.aliexpress.com/?lang=zh_CN', glyph: 'Ali', className: 'aliexpress-dot', hostSuffixes: ['aliexpress.com', 'aliexpress.ru', 'aliexpress.us'] },
    shein: { id: 'shein', label: 'SHEIN', url: 'https://www.shein.com/?language=zh', glyph: 'S', className: 'shein-dot', hostSuffixes: ['shein.com', 'shein.co.uk', 'shein.de', 'shein.fr', 'shein.it', 'shein.es'] },
  });
  const taobaoHomePlatform = Object.freeze({ id: 'taobao', label: '淘宝网', url: 'https://www.taobao.com/', glyph: '淘', className: 'taobao-dot', hostSuffixes: ['taobao.com'] });
  function isTaobaoHomeUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      return (host === 'taobao.com' || host === 'www.taobao.com') && (!parsed.pathname || parsed.pathname === '/');
    } catch { return false; }
  }
  function platformForCommerceTab(tab, value = '') {
    return platformForUrl(value)
      || (isTaobaoHomeUrl(value) || tab?.platform === 'taobao' || tab?.site === 'taobao' ? taobaoHomePlatform : null);
  }
  const commerceHostSuffixes = ['dmp.taobao.com', 'taobao.com', 'tmall.com', '1688.com', 'tb.cn', 'xiaohongshu.com', 'rednote.com', 'douyin.com'];
  const desktopNavigationHostSuffixes = Object.freeze([...new Set([
    ...commerceHostSuffixes,
    ...Object.values(desktopPlatformDefinitions).flatMap((platform) => platform.hostSuffixes || []),
  ])]);
  function hostMatchesSuffix(hostname, suffixes) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }
  function platformForUrl(value) {
    let host = '';
    try { host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
    return Object.values(desktopPlatformDefinitions).find((platform) => hostMatchesSuffix(host, platform.hostSuffixes || [])) || null;
  }
  function isCommerceHost(hostname) { return hostMatchesSuffix(hostname, commerceHostSuffixes); }
  function isDesktopNavigationHost(hostname) { return hostMatchesSuffix(hostname, desktopNavigationHostSuffixes); }
  function isDetailCommerceUrl(value) { try { const parsed = new URL(String(value || '')); const host = parsed.hostname.toLowerCase(); const path = parsed.pathname.toLowerCase(); return ((host === 'item.taobao.com' || host.endsWith('.item.taobao.com')) && /\/item\.htm/.test(path)) || ((host === 'detail.tmall.com' || host.endsWith('.detail.tmall.com')) && /\/item\.htm/.test(path)) || host === 'detail.1688.com' || host.endsWith('.detail.1688.com'); } catch { return false; } }
  function isSearchCommerceUrl(value) { try { const parsed = new URL(String(value || '')); const host = parsed.hostname.toLowerCase(); const path = parsed.pathname.toLowerCase(); return isCommerceHost(host) && (/\/search(?:\.htm)?(?:\/|$)/.test(path) || host === 's.taobao.com' || host === 's.tmall.com'); } catch { return false; } }
  function commerceSearchKey(value) {
    if (!isSearchCommerceUrl(value)) return '';
    try {
      const parsed = new URL(String(value || ''));
      const ignored = /^(?:spm|initiative_id|preload|preloadorigin|clientpreloadid|commend|source)$/i;
      const query = [...parsed.searchParams.entries()]
        .filter(([name]) => !ignored.test(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, item]) => `${name}=${item}`)
        .join('&');
      return `${parsed.hostname.toLowerCase()}:${parsed.pathname.toLowerCase()}:${query}`;
    } catch { return ''; }
  }
  function commerceProductKey(value) { if (!isDetailCommerceUrl(value)) return ''; try { const parsed = new URL(String(value || '')); const id = parsed.searchParams.get('id') || parsed.searchParams.get('itemId') || parsed.searchParams.get('item_id') || parsed.searchParams.get('offerId') || parsed.searchParams.get('offer_id') || ''; return `${parsed.hostname.toLowerCase()}:${id || parsed.pathname.replace(/\/+$/, '')}`; } catch { return ''; } }
  function productContextKey(value) {
    const safeUrl = safeCommerceUrl(value);
    if (!safeUrl) return '';
    const detailKey = commerceProductKey(safeUrl);
    if (detailKey) return detailKey;
    const searchKey = commerceSearchKey(safeUrl);
    if (searchKey) return `search:${searchKey}`;
    try {
      const parsed = new URL(safeUrl);
      return `page:${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '') || '/'}`;
    } catch { return ''; }
  }
  function resultSourceUrl(result = currentResult()) {
    return result?.originalUrl || result?.original_url || result?.finalUrl || result?.final_url || result?.collection?.originalUrl || result?.collection?.finalUrl || state.job?.url || '';
  }
  function resultProductId(result = currentResult()) {
    const product = result?.product || {};
    return String(result?.productId || result?.product_id || result?.collection?.productId || product.id || product.itemId || product.productId || '').trim();
  }
  function resultNormalizedUrl(result = currentResult()) {
    return String(result?.normalizedUrl || result?.normalized_url || result?.collection?.normalizedUrl || resultSourceUrl(result) || '').trim();
  }
  function urlProductId(value) {
    try {
      const parsed = new URL(String(value || ''));
      return String(parsed.searchParams.get('id') || parsed.searchParams.get('itemId') || parsed.searchParams.get('item_id') || parsed.searchParams.get('offerId') || parsed.searchParams.get('offer_id') || '').trim();
    } catch { return ''; }
  }
  function resultMatchesCurrentProduct(result) {
    if (!result) return true;
    const currentUrl = activeProductUrl();
    const currentId = urlProductId(currentUrl);
    const resultId = resultProductId(result);
    if (currentId && resultId && currentId !== resultId) return false;
    if (currentId && !resultId && result.status !== 'login_required' && result.status !== 'failed') return false;
    const currentKey = productContextKey(currentUrl);
    const resultKey = productContextKey(resultNormalizedUrl(result));
    return !(currentKey && resultKey && currentKey !== resultKey);
  }
  function activeProductUrl() {
    const tab = activeCommerceTab();
    if (tab?.type === 'commerce' && tab.kind === 'platform') return '';
    if (hasPendingNativeNavigation(tab)) return '';
    const canonicalUrl = tab?.productUrl || tab?.url || '';
    return tab?.type === 'commerce' && (tab.kind === 'detail' || tab.kind === 'product') && canonicalUrl ? canonicalUrl : (state.productUrl || $('productUrl')?.value.trim() || state.url || '');
  }
  function renderConversationPlaceholder(message = '', options = {}) {
    const box = $('chatMessages');
    if (!box) return;
    state.messages = [];
    box.innerHTML = '';
    const siteView = activeSiteAssistantView();
    const siteProfile = assistantProfileForTab();
    const defaultMessage = siteView?.greeting || (siteProfile
      ? `你好，我是小美。${siteProfile.title}的页面资料将在读取当前可见内容后用于分析。`
      : '你好，我是小美。登录淘宝或 1688 并完成商品采集后，我可以帮你分析评价、主图、详情页、视频和运营数据。');
    appendMessage(
      'assistant',
      message || defaultMessage,
      message || siteProfile ? [] : ['先看看这个商品的核心卖点和风险', '评价里用户最在意什么？'],
      [],
      { skipState: true, pageContextPlaceholder: Boolean(options.pageContextPlaceholder) },
    );
  }
  function restoreSiteAssistantPreviewAfterConversation(tab = activeCommerceTab()) {
    if (!tab || tab.id !== state.activeTabId || !usesDedicatedSiteConversation(tab)) return;
    const view = activeSiteAssistantView(tab);
    if (view) renderSiteAssistant(view);
  }
  async function restoreConversationForProduct(productKey, options = {}) {
    const key = String(productKey || '').trim();
    if (!key) return null;
    const token = ++conversationRestoreSerial;
    const candidateTab = options.tab || activeCommerceTab();
    const targetTab = candidateTab && tabProductConversationKey(candidateTab) === key ? candidateTab : null;
    const targetId = conversationIdForProduct(key, targetTab);
    const cachedMessages = Array.isArray(targetTab?.conversationMessages) ? targetTab.conversationMessages.slice() : [];
    lastConversationRestoreKey = key;
    lastConversationRestoreTabId = targetTab?.id || '';
    const isCurrent = () => {
      if (token !== conversationRestoreSerial) return false;
      const currentKey = activeConversationContextKey();
      return !currentKey || currentKey === key;
    };
    if (!isCurrent()) return null;
    state.conversationProductKey = key;
    if (!targetId) {
      state.conversationId = '';
      if (cachedMessages.length) renderSavedConversation(cachedMessages);
      else if (options.emptyMessage) renderConversationPlaceholder(options.emptyMessage, options);
      else renderSavedConversation([]);
      restoreSiteAssistantPreviewAfterConversation(targetTab);
      rememberConversationForProduct(key, '', state.messages, targetTab);
      notifySharedConversation('', true, { remember: false });
      return null;
    }
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(targetId)}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (!isCurrent()) return null;
      const conversation = data.conversation || {};
      state.conversationId = conversation.id || targetId;
      state.conversationProductKey = key;
      renderSavedConversation(conversation.messages || []);
      restoreSiteAssistantPreviewAfterConversation(targetTab);
      rememberConversationForProduct(key, state.conversationId, state.messages, targetTab);
      notifySharedConversation(state.conversationId, options.notify !== false);
      if (options.announce) toast('已载入同步对话记录');
      return conversation;
    } catch (error) {
      if (!isCurrent()) return null;
      if (cachedMessages.length) renderSavedConversation(cachedMessages);
      restoreSiteAssistantPreviewAfterConversation(targetTab);
      if (!options.silent) toast(`无法读取对话记录：${error.message}`);
      return null;
    }
  }
  function resetProductContext(nextUrl = '', options = {}) {
    clearTimeout(state.polling); state.polling = null;
    state.jobId = ''; state.job = null; state.result = null; state.operation = null;
    state.analysisProductKey = ''; state.analysisRequestToken = ''; state.analysisStarting = false; state.autoCollectionProductKey = ''; state.autoCollectionAuthRetryKeys = new Set();
    state.pageContext = null; state.pageContextKey = ''; state.pageContextUrl = ''; state.pageContextLoading = false; state.pageContextShownKey = '';
    state.selectedResourceIds = new Set(); state.resourceSelectionProductKey = '';
    clearChatAttachments();
    const nextKey = productContextKey(nextUrl);
    const previousKey = state.conversationProductKey || state.productKey;
    if (previousKey && previousKey !== nextKey) rememberConversationForProduct(previousKey, state.conversationId, state.messages);
    state.productKey = nextKey; if (nextUrl) state.productUrl = nextUrl;
    state.conversationProductKey = nextKey;
    if (options.resetChat !== false) {
      state.conversationId = ''; state.messages = [];
      notifySharedConversation('', true, { remember: false });
      const searchContextReset = isSearchCommerceUrl(nextUrl);
      renderConversationPlaceholder(
        options.message || (searchContextReset ? '正在读取当前搜索结果页，读取完成后可以直接分析价格带、标题和竞品。' : '已切换到新商品，正在自动读取商品基础信息；评价和问大家正文可按需采集。'),
        { pageContextPlaceholder: searchContextReset },
      );
      const activeKey = productContextKey(activeProductUrl());
      if (nextKey && (!activeKey || activeKey === nextKey)) {
        void restoreConversationForProduct(nextKey, { emptyMessage: options.message || (searchContextReset ? '正在读取当前搜索结果页，读取完成后可以直接分析价格带、标题和竞品。' : '已切换到新商品，正在自动读取商品基础信息；评价和问大家正文可按需采集。'), pageContextPlaceholder: searchContextReset });
      }
    }
    $('jobIdText').textContent = ''; renderInfo(null); renderModules();
    if (isDetailCommerceUrl(nextUrl)) {
      applyProductInfoExpandedForTab(false);
      renderResources(null);
    }
    setJobState('尚未开始采集'); setSiteState('本地分析服务');
    if ($('reportDrawer')?.classList.contains('is-open')) renderReport();
  }
  function syncProductContext(nextUrl = '', options = {}) {
    const nextKey = productContextKey(nextUrl);
    const fallbackUrl = state.url || state.embeddedUrl || $('productUrl')?.value || '';
    const previousKey = state.productKey || productContextKey(fallbackUrl);
    if (nextKey && previousKey && nextKey !== previousKey) {
      // 商品采集结果和搜索页快照都属于当前标签页。切换到另一个标签前，
      // 先把旧标签的内存状态留下，避免 resetProductContext() 清空后切回来
      // 又被 ready 事件当成新商品重新采集。
      rememberProductAnalysisForTab();
      rememberPageContextForTab();
      resetProductContext(nextUrl, options);
    }
    else if (nextKey) state.productKey = nextKey;
    if (nextUrl) { state.url = nextUrl; state.productUrl = nextUrl; }
    return nextKey;
  }
  function autoCollectBaseForProduct(url = activeProductUrl(), options = {}) {
    if (!isDetailCommerceUrl(url)) return;
    const key = productContextKey(url);
    const retry = options.retry === true;
    if (!key || (!retry && state.autoCollectionProductKey === key)) return;
    if (!retry && hasCachedProductAnalysisForTab(activeCommerceTab(), key)) {
      state.autoCollectionProductKey = key;
      return;
    }
    if (!retry && state.jobId && jobMatchesCurrentProduct() && currentResult()) {
      state.autoCollectionProductKey = key;
      return;
    }
    if (state.analysisStarting || ['queued', 'running'].includes(state.job?.status)) return;
    state.autoCollectionProductKey = key;
    applyProductInfoExpandedForTab(false);
    renderResources();
    setJobState('正在自动读取商品基础信息、主图、详情、SKU 和视频…', 'running');
    const pending = Promise.resolve(startAnalysis(false, BASE_COLLECTION_MODULE));
    // startAnalysis() 在第一次 await 前会同步设置 analysisStarting；把这个
    // “正在进行”状态也绑定到当前标签，切换回来时不会再开第二套采集链。
    rememberProductAnalysisForTab();
    pending.catch((error) => {
      if (productContextKey(activeProductUrl()) === key) {
        setJobState(error?.message || '自动读取商品基础信息失败', 'error');
        setSiteState('商品基础信息读取失败，请点击开始分析重试', 'error');
      }
    });
  }
  function jobMatchesCurrentProduct() {
    if (!state.jobId) return true;
    const currentKey = productContextKey(activeProductUrl());
    const jobKey = productContextKey(state.job?.url || resultSourceUrl());
    return Boolean(currentKey && jobKey && currentKey === jobKey);
  }
  function guardCurrentJob() {
    if (isSiteAssistantTab()) return true;
    const inputKey = productContextKey($('productUrl')?.value || '');
    const activeKey = productContextKey(activeProductUrl());
    // 搜索页使用当前可见页面快照；输入框可能还保留上一个详情链接，不能因此阻塞搜索页即时分析。
    if (isSearchCommerceUrl(activeProductUrl())) return true;
    if (inputKey && activeKey && inputKey !== activeKey) {
      resetProductContext($('productUrl').value.trim(), { message: '链接已切换，但当前页面还未打开这件商品。请先打开商品页，再开始分析。' });
      toast('链接已切换，请先打开对应商品页');
      return false;
    }
    if (jobMatchesCurrentProduct()) return true;
    const currentUrl = activeProductUrl();
    resetProductContext(currentUrl, { message: '已检测到当前页面换了商品，正在自动读取当前商品基础信息。' });
    toast('旧分析任务不属于当前商品，正在重新读取当前商品');
    return false;
  }
  function findCommerceDetailTab(url) { const key = commerceProductKey(url); if (!key) return null; return state.tabs.find((tab) => tab.type === 'commerce' && (tab.productKey || commerceProductKey(tab.productUrl || tab.url)) === key) || null; }
  function tabTitleFromPage(value, fallback = '商品详情') { const raw = String(value || '').replace(/\s+/g, ' ').trim(); if (!raw || /^(淘宝|淘宝网|天猫|1688|商品页|商品详情|淘宝商品页|正在加载.*)$/i.test(raw)) return fallback; const cleaned = raw.replace(/\s*[-_|｜].*?(淘宝|天猫|1688).*$/i, '').trim(); return (cleaned || fallback).slice(0, 28); }
  function ensureCommerceTabFromSurface(payload = {}, url = '') {
    const requestedId = String(payload.tabId || '').trim();
    if (requestedId && closedCommerceTabIds.has(requestedId)) return { tab: null, created: false, ignored: true };
    let tab = requestedId ? state.tabs.find((item) => item.id === requestedId) : null;
    if (!tab && url) tab = findCommerceDetailTab(url);
    if (tab || !url) return { tab, created: false };
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {}
    if (!isDesktopNavigationHost(hostname)) return { tab: null, created: false };
    const detail = isDetailCommerceUrl(url);
    const platform = platformForUrl(url);
    const loginPage = isCommerceLoginUrl(url);
    const id = requestedId || `commerce-${++state.tabSerial}`;
    tab = {
      id,
      title: loginPage ? `${platform?.label || '官方'}登录` : detail ? tabTitleFromPage(payload.title) : platform?.label || tabDisplayTitle(payload.site || '淘宝', url),
      type: 'commerce',
      url,
      closable: true,
      kind: loginPage ? 'login' : detail ? 'detail' : platform ? 'platform' : 'product',
      site: platform?.id || payload.site || '',
      platform: platform?.id || '',
      productKey: detail ? commerceProductKey(url) : '',
      productUrl: detail ? url : '',
      verification: Boolean(payload.verification),
      ready: Boolean(payload.ready),
      productInfoExpanded: inheritedProductInfoExpanded(),
      conversationProductKey: null,
      conversationId: null,
      conversationMessages: [],
    };
    state.tabs.push(tab);
    return { tab, created: true };
  }
  function setAssistantVisible(visible) {
    const root = $('commerceWorkbench'); const panel = $('assistantPanel'); const button = $('showAssistant');
    state.assistantOpen = Boolean(visible);
    root?.classList.toggle('assistant-hidden', !state.assistantOpen);
    if (panel) { panel.hidden = !state.assistantOpen; panel.setAttribute('aria-hidden', String(!state.assistantOpen)); }
    if (button) { button.hidden = state.assistantOpen; button.setAttribute('aria-expanded', String(state.assistantOpen)); }
    setTimeout(emitBounds, 0);
  }
  // 商品信息卡的展开状态属于当前商品标签页。切换链接时保留用户最后一次
  // 选择，避免新页面加载过程把用户主动收起的卡片又强制打开。
  function productInfoPreferenceForTab(tab = activeCommerceTab()) {
    if (typeof tab?.productInfoExpanded === 'boolean') return tab.productInfoExpanded;
    return typeof state.productInfoExpanded === 'boolean' ? state.productInfoExpanded : null;
  }
  function inheritedProductInfoExpanded() {
    return productInfoPreferenceForTab();
  }
  function applyProductInfoExpandedForTab(defaultExpanded = false) {
    const tab = activeCommerceTab();
    let expanded = productInfoPreferenceForTab(tab);
    if (typeof expanded !== 'boolean') expanded = Boolean(defaultExpanded);
    if (tab && tab.type === 'commerce' && typeof tab.productInfoExpanded !== 'boolean') tab.productInfoExpanded = expanded;
    state.productInfoExpanded = expanded;
    setProductInfoExpanded(expanded, { remember: false });
    return expanded;
  }
  function assistantWidthRange() {
    const root = $('commerceWorkbench');
    const availableWidth = Math.max(0, Math.round(root?.getBoundingClientRect?.().width || window.innerWidth || 0));
    // The only bounds are the two edges of the work area. Do not impose a
    // minimum panel width or reserve a fixed minimum width for the product page.
    return { min: 0, max: availableWidth };
  }
  function assistantCssWidth() {
    const root = $('commerceWorkbench');
    const parsed = Number.parseFloat(getComputedStyle(root || document.documentElement).getPropertyValue('--assistant-width'));
    return Number.isFinite(parsed) ? parsed : 390;
  }
  function requestBoundsUpdate() {
    if (boundsEmitFrame) return;
    const flush = () => { boundsEmitFrame = 0; emitBounds(); };
    boundsEmitFrame = window.setTimeout(flush, 0);
  }
  function setAssistantWidth(nextWidth, options = {}) {
    const root = $('commerceWorkbench');
    if (!root) return 0;
    const range = assistantWidthRange();
    const numeric = Number(nextWidth);
    const width = Math.round(Math.max(range.min, Math.min(range.max, Number.isFinite(numeric) ? numeric : assistantCssWidth())));
    root.style.setProperty('--assistant-width', `${width}px`);
    state.assistantWidth = width;
    const handle = $('assistantResizer');
    if (handle) {
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
      handle.setAttribute('aria-valuenow', String(width));
    }
    if (options.persist !== false) {
      try { localStorage.setItem(ASSISTANT_WIDTH_KEY, String(width)); } catch {}
    }
    if (options.emit !== false) requestBoundsUpdate();
    return width;
  }
  function readAssistantWidth() {
    let saved = NaN;
    try { saved = Number.parseFloat(localStorage.getItem(ASSISTANT_WIDTH_KEY) || ''); } catch {}
    if (Number.isFinite(saved)) return saved;
    const root = $('commerceWorkbench');
    const availableWidth = Math.round(root?.getBoundingClientRect?.().width || window.innerWidth || 0);
    if (availableWidth > 600 && availableWidth <= 900) return Math.round(Math.max(420, Math.min(540, availableWidth - 96)));
    return assistantCssWidth();
  }
  function initAssistantResizer() {
    const handle = $('assistantResizer');
    const root = $('commerceWorkbench');
    if (!handle || !root) return;
    setAssistantWidth(readAssistantWidth(), { persist: false, emit: false });
    let dragging = false;
    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('assistant-resizing');
      setAssistantWidth(state.assistantWidth, { persist: true });
    };
    handle.addEventListener('pointerdown', (event) => {
      if (window.matchMedia?.('(max-width: 900px)').matches || root.classList.contains('assistant-hidden')) return;
      dragging = true;
      handle.classList.add('is-dragging');
      document.body.classList.add('assistant-resizing');
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = root.getBoundingClientRect();
      setAssistantWidth(rect.right - event.clientX, { persist: false, emit: false });
      requestBoundsUpdate();
    });
    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
    handle.addEventListener('lostpointercapture', stopDragging);
    window.addEventListener('pointerup', stopDragging);
    handle.addEventListener('keydown', (event) => {
      const range = assistantWidthRange();
      const step = event.shiftKey ? 64 : 16;
      let next = state.assistantWidth;
      if (event.key === 'ArrowLeft') next += step;
      else if (event.key === 'ArrowRight') next -= step;
      else if (event.key === 'Home') next = range.max;
      else if (event.key === 'End') next = range.min;
      else return;
      event.preventDefault();
      setAssistantWidth(next);
    });
  }
  function applyAssistantVisibility(tab = activeCommerceTab()) {
    const analysisHome = tab?.type === 'analysis';
    const standardCommercePage = tab?.type === 'commerce' && tab.kind !== 'platform';
    // 六站点即使在 platform 标签页也保留右侧助手；其它未在范围内的平台仍维持原行为。
    setAssistantVisible(!analysisHome && (standardCommercePage || isSiteAssistantTab(tab)) && !state.assistantManualHidden);
  }
  function safeCommerceUrl(value) { try { const parsed = new URL(String(value || '').trim()); if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || !isDesktopNavigationHost(parsed.hostname)) return ''; return parsed.href; } catch { return ''; } }
  function isCommerceLoginUrl(value) { try { const host = new URL(String(value || '')).hostname.toLowerCase(); return /^(?:login|passport|havanalogin|pass)\.(?:taobao|tmall|1688)\.com$/i.test(host); } catch { return false; } }
  function commerceLoginTarget(value = '', fallbackSite = '') {
    const platform = platformForUrl(value);
    if (platform && platform.id !== '1688') {
      return { site: platform.id, label: platform.label, loginUrl: '', supported: false };
    }
    const site = String(platform?.id || fallbackSite || '').trim().toLowerCase();
    return site === '1688'
      ? { site: '1688', label: '1688', loginUrl: 'https://login.1688.com/member/signin.htm?from=sm&banThirdPartyCookie=true&cbuAdd=true&redirectType=topRedirect&Done=https%3A%2F%2Fwww.1688.com%2F', supported: true }
      : { site: 'taobao', label: '淘宝', loginUrl: 'https://login.taobao.com/', supported: true };
  }
  function activeCommerceLoginTarget() {
    const tab = activeCommerceTab();
    return commerceLoginTarget(tab?.requestedUrl || tab?.url || state.embeddedUrl || state.productUrl || state.url, tab?.site || tab?.platform);
  }
  function activeCommerceTab() { return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0]; }
  function isProductAnalysisTab(tab = activeCommerceTab()) {
    return Boolean(tab?.type === 'commerce' && (tab.kind === 'detail' || tab.kind === 'product'));
  }
  function tabProductAnalysisKey(tab = activeCommerceTab()) {
    return isProductAnalysisTab(tab) ? productContextKey(tab.productUrl || tab.url) : '';
  }
  function hasCachedProductAnalysisForTab(tab = activeCommerceTab(), key = tabProductAnalysisKey(tab)) {
    if (!key || !isProductAnalysisTab(tab) || tab.analysisProductKey !== key) return false;
    return Boolean(tab.analysisResult || tab.analysisJob || tab.analysisJobId || tab.analysisPending);
  }
  function hasCachedPageContextForTab(tab = activeCommerceTab(), key = tabProductAnalysisKey(tab)) {
    return Boolean(
      key
      && isSearchCommerceUrl(tab?.url || '')
      && tab?.pageContext
      && tab.pageContextKey === key,
    );
  }
  function rememberPageContextForTab(tab = activeCommerceTab()) {
    const key = tabProductAnalysisKey(tab);
    if (!key || !isSearchCommerceUrl(tab?.url || '') || !state.pageContext || state.pageContextKey !== key) return;
    tab.pageContext = state.pageContext;
    tab.pageContextKey = key;
    tab.pageContextUrl = state.pageContextUrl || state.pageContext.url || tab.url || '';
    tab.pageContextShownKey = state.pageContextShownKey || '';
  }
  function restorePageContextForTab(tab = activeCommerceTab(), key = tabProductAnalysisKey(tab)) {
    if (!hasCachedPageContextForTab(tab, key)) {
      state.pageContext = null;
      state.pageContextKey = '';
      state.pageContextUrl = '';
      state.pageContextShownKey = '';
      state.pageContextLoading = false;
      return false;
    }
    state.pageContext = tab.pageContext;
    state.pageContextKey = key;
    state.pageContextUrl = tab.pageContextUrl || tab.pageContext.url || tab.url || '';
    state.pageContextShownKey = tab.pageContextShownKey || '';
    state.pageContextLoading = false;
    showPageContext(state.pageContext);
    return true;
  }
  function rememberProductAnalysisForTab(tab = activeCommerceTab()) {
    if (!isProductAnalysisTab(tab)) return;
    const key = tabProductAnalysisKey(tab);
    if (!key) return;
    const result = state.result || state.job?.result || null;
    const stateKey = state.analysisProductKey || productContextKey(state.job?.url || resultSourceUrl(result));
    // 异步回调可能晚于标签切换到达，不能把另一个商品的结果写进当前标签。
    if (stateKey && stateKey !== key) return;
    const busy = ['queued', 'running'].includes(String(state.job?.status || '').toLowerCase());
    const pending = Boolean(state.analysisStarting || busy);
    const jobId = String(state.jobId || state.job?.id || result?.jobId || '').trim();
    if (!result && !state.job && !jobId && !pending) {
      if (tab.analysisProductKey === key) tab.analysisPending = false;
      return;
    }
    const job = state.job ? { ...state.job } : (result ? {
      id: jobId,
      url: tab.productUrl || tab.url || '',
      status: result.status || 'ready',
      message: result.message || '',
      result,
    } : null);
    if (job && result && !job.result) job.result = result;
    tab.analysisProductKey = key;
    tab.analysisJobId = jobId;
    tab.analysisJob = job;
    tab.analysisResult = result;
    tab.analysisOperation = state.operation || null;
    tab.analysisSelectedResourceIds = [...state.selectedResourceIds];
    tab.analysisResourceSelectionProductKey = state.resourceSelectionProductKey || '';
    tab.analysisAutoCollectionProductKey = state.autoCollectionProductKey === key ? key : '';
    tab.analysisPending = pending;
  }
  function restoreProductAnalysisForTab(tab = activeCommerceTab(), key = tabProductAnalysisKey(tab)) {
    if (!hasCachedProductAnalysisForTab(tab, key)) return false;
    clearTimeout(state.polling);
    state.polling = null;
    state.jobId = String(tab.analysisJobId || tab.analysisJob?.id || tab.analysisResult?.jobId || '').trim();
    state.job = tab.analysisJob ? { ...tab.analysisJob } : null;
    state.result = tab.analysisResult || state.job?.result || null;
    state.operation = tab.analysisOperation || null;
    state.analysisProductKey = key;
    state.analysisRequestToken = '';
    state.analysisStarting = false;
    state.autoCollectionProductKey = tab.analysisAutoCollectionProductKey || ((tab.analysisPending || Boolean(state.result || state.job)) ? key : '');
    state.selectedResourceIds = new Set(Array.isArray(tab.analysisSelectedResourceIds) ? tab.analysisSelectedResourceIds : []);
    state.resourceSelectionProductKey = tab.analysisResourceSelectionProductKey || '';
    if (state.job || state.result) {
      const job = state.job || {
        id: state.jobId,
        url: tab.productUrl || tab.url || '',
        status: state.result.status || 'ready',
        message: state.result.message || '',
        result: state.result,
      };
      renderJob(job);
      if (['queued', 'running'].includes(String(job.status || '').toLowerCase())) poll();
    } else {
      renderInfo(null);
      renderModules();
      renderResources();
      setJobState('正在自动读取商品基础信息、主图、详情、SKU 和视频…', 'running');
    }
    return true;
  }
  function invalidateTabAnalysisCache(tab = activeCommerceTab()) {
    if (!tab) return;
    tab.analysisProductKey = '';
    tab.analysisJobId = '';
    tab.analysisJob = null;
    tab.analysisResult = null;
    tab.analysisOperation = null;
    tab.analysisSelectedResourceIds = [];
    tab.analysisResourceSelectionProductKey = '';
    tab.analysisAutoCollectionProductKey = '';
    tab.analysisPending = false;
    tab.pageContext = null;
    tab.pageContextKey = '';
    tab.pageContextUrl = '';
    tab.pageContextShownKey = '';
    tab.siteAssistantContextKey = '';
    tab.siteAssistantView = null;
    tab.siteAssistantStatus = '';
    tab.siteAssistantProfile = null;
  }
  function hasCachedSiteAssistantContextForTab(tab = activeCommerceTab(), key = siteAssistantContextKey(tab)) {
    return Boolean(key && tab?.siteAssistantContextKey === key && tab.siteAssistantView);
  }
  function rememberSiteAssistantContextForTab(tab = activeCommerceTab()) {
    const key = siteAssistantContextKey(tab);
    if (!key || !state.siteContext || state.siteContextKey !== key) return;
    tab.siteAssistantContextKey = key;
    tab.siteAssistantView = state.siteContext;
    tab.siteAssistantStatus = state.siteContextStatus || '';
  }
  function clearActiveSiteAssistantContext() {
    clearTimeout(state.siteContextTimer);
    state.siteContextTimer = null;
    state.siteContext = null;
    state.siteContextKey = '';
    state.siteContextUrl = '';
    state.siteContextLoading = false;
    state.siteContextStatus = '';
  }
  function updateSiteProductInfoVisibility(view = activeSiteAssistantView()) {
    const productCard = $('productInfoCard');
    if (!productCard) return;
    const keepProductCard = view?.profile?.id === '1688-detail';
    productCard.hidden = Boolean(view && !keepProductCard);
  }
  function renderSiteAssistantPending(tab = activeCommerceTab(), message = '') {
    const profile = assistantProfileForTab(tab);
    if (!profile) return;
    const card = $('pageContextCard');
    if (!card) return;
    const statusMessage = message || tab?.siteAssistantStatus || '正在读取当前已渲染且可见资料…';
    updateSiteProductInfoVisibility({ profile });
    card.hidden = false;
    $('pageContextTitle').textContent = profile.title || '当前页面';
    $('pageContextStatus').textContent = statusMessage;
    $('pageContextSummary').textContent = '只提取当前页的关键业务字段；不会转储整页文字，不会滚动、点击、调用平台接口或读取 Cookie、存储与密码。';
    $('pageContextReferences').innerHTML = '';
    $('chatContextLabel').textContent = `${profile.title || '当前页面'} · 等待可读资料`;
    const chip = $('contextChip');
    if (chip) { chip.textContent = '当前页面'; chip.title = '等待当前页面可见资料'; }
    updateQuickActions();
    setSiteAssistantPlaceholderMessage(statusMessage);
  }
  function renderSiteAssistant(view = activeSiteAssistantView()) {
    if (!view?.profile || !view?.context) return false;
    const card = $('pageContextCard');
    if (!card) return false;
    updateSiteProductInfoVisibility(view);
    const context = view.context;
    const visibleTitle = context.structuredTitle || view.profile.title || '当前页面';
    const referenceCount = context.facts?.length || context.items?.length || context.comments?.length || context.tables?.length || context.metrics?.length || context.visibleCount || 0;
    const resources = Array.isArray(view.resources) ? view.resources : [];
    card.hidden = false;
    $('pageContextTitle').textContent = visibleTitle;
    $('pageContextStatus').textContent = `已提取当前页关键字段${referenceCount ? ` · ${referenceCount} 项` : ''}`;
    $('pageContextSummary').textContent = `${view.greeting || '已读取当前页面资料。'} 展示内容仅来自当前已渲染页面；不会把整页背景文字或图片链接传给模型。`;
    $('pageContextReferences').innerHTML = resources.length
      ? resources.map((entry) => `<span class="page-context-reference" title="仅引用当前可见${escapeHtml(entry.label || '资料')}">${escapeHtml(entry.token || entry.label || '当前页面')}</span>`).join('')
      : '<span class="page-context-reference">当前没有可引用的专用资料</span>';
    $('chatContextLabel').textContent = `${visibleTitle} · 已读取可见资料`;
    const chip = $('contextChip');
    if (chip) { chip.textContent = resources[0]?.token || '当前页面'; chip.title = resources.map((entry) => entry.label || entry.token).join('、') || '当前页面可见资料'; }
    updateQuickActions();
    replaceSiteAssistantPlaceholder(view);
    return true;
  }
  function siteContextPreviewKey(view = activeSiteAssistantView()) {
    const context = view?.context || {};
    return [context.pageKey || siteAssistantContextKey(), context.capturedAt || 0, context.structuredTitle || '', context.facts?.length || 0, context.comments?.length || 0].join('|');
  }
  async function copySiteContextPreview(button) {
    const node = button?.closest?.('[data-site-context-preview="true"]');
    const value = node?.dataset.copyText || '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast('已复制当前页面资料');
    } catch {
      const area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); toast('已复制当前页面资料');
    }
  }
  function upsertSiteAssistantPreview(view = activeSiteAssistantView()) {
    const box = $('chatMessages');
    const preview = assistantProfileApi()?.pagePreview?.(view);
    if (!box || !preview) return false;
    const key = siteContextPreviewKey(view);
    const current = box.querySelector('[data-site-context-preview="true"]');
    if (current?.dataset.siteContextKey === key) return true;
    box.querySelectorAll('[data-page-context-placeholder="true"]').forEach((node) => node.remove());
    current?.remove();
    const facts = Array.isArray(preview.facts) ? preview.facts : [];
    const node = document.createElement('div');
    node.className = 'chat-message assistant site-page-context-preview';
    node.dataset.siteContextPreview = 'true';
    node.dataset.siteContextKey = key;
    node.dataset.copyText = String(preview.copyText || '');
    node.innerHTML = `<div class="message-avatar">小</div><div class="message-bubble"><div class="site-page-context-title">${escapeHtml(preview.title || '当前页面 · 实况')}</div><ul class="site-page-context-facts">${facts.map((entry) => `<li><b>${escapeHtml(entry.label || '资料')}：</b>${escapeHtml(entry.value || '')}</li>`).join('')}</ul><div class="site-page-context-meta"><span>仅当前已渲染、可见的页面资料</span><button type="button" data-copy-site-context aria-label="复制当前页面资料" title="复制当前页面资料">⧉</button></div></div>`;
    box.appendChild(node);
    box.scrollTop = box.scrollHeight;
    return true;
  }
  function replaceSiteAssistantPlaceholder(view = activeSiteAssistantView()) {
    if (!view?.profile) return;
    if (upsertSiteAssistantPreview(view)) return;
    setSiteAssistantPlaceholderMessage(
      `${view.greeting || `已读取当前${view.profile.title || '页面'}的可见资料。`} 现在可以选择下方快捷分析，或直接提问。`,
      { complete: true },
    );
  }
  function setSiteAssistantPlaceholderMessage(message = '', options = {}) {
    const box = $('chatMessages');
    const placeholder = box?.querySelector('.chat-message.assistant[data-page-context-placeholder="true"]');
    if (!placeholder || state.messages.length || !message) return;
    const content = placeholder.querySelector('.md-content');
    if (!content) return;
    content.innerHTML = renderMarkdownMessage(message);
    if (options.complete) delete placeholder.dataset.pageContextPlaceholder;
    box.scrollTop = box.scrollHeight;
  }
  function restoreSiteAssistantContextForTab(tab = activeCommerceTab(), key = siteAssistantContextKey(tab)) {
    if (!hasCachedSiteAssistantContextForTab(tab, key)) {
      clearActiveSiteAssistantContext();
      return false;
    }
    state.siteContext = tab.siteAssistantView;
    state.siteContextKey = key;
    state.siteContextUrl = tab.siteAssistantView?.context?.url || tab.url || '';
    state.siteContextLoading = false;
    state.siteContextStatus = tab.siteAssistantStatus || '';
    renderSiteAssistant(state.siteContext);
    return true;
  }
  async function captureSiteAssistantContext(options = {}) {
    const tab = options.tab || activeCommerceTab();
    const key = siteAssistantContextKey(tab);
    if (!tab || !key) return null;
    if (!options.force && hasCachedSiteAssistantContextForTab(tab, key)) {
      if (tab.id === state.activeTabId) restoreSiteAssistantContextForTab(tab, key);
      return tab.siteAssistantView;
    }
    const profile = assistantProfileForTab(tab);
    const tabId = tab.id;
    const isCurrent = () => state.activeTabId === tabId && siteAssistantContextKey(activeCommerceTab()) === key;
    const shell = shellApi();
    if (!shell?.captureAssistantContext) {
      tab.siteAssistantStatus = '普通浏览器受跨域隔离限制，需在小美画布桌面端读取页面资料';
      if (isCurrent()) { clearActiveSiteAssistantContext(); renderSiteAssistantPending(tab, tab.siteAssistantStatus); }
      return null;
    }
    tab.siteAssistantStatus = '正在读取当前已渲染且可见资料…';
    if (isCurrent()) {
      state.siteContext = null;
      state.siteContextKey = key;
      state.siteContextUrl = assistantProfileApi()?.safeContextUrl?.(tab.url) || tab.url || '';
      state.siteContextLoading = true;
      state.siteContextStatus = tab.siteAssistantStatus;
      renderSiteAssistantPending(tab, tab.siteAssistantStatus);
    }
    try {
      const snapshot = await shell.captureAssistantContext({ tabId });
      const currentTab = state.tabs.find((item) => item.id === tabId);
      if (!currentTab || siteAssistantContextKey(currentTab) !== key) return null;
      if (!snapshot?.ok) {
        currentTab.siteAssistantStatus = snapshot?.message || '当前页面没有可读取的可见资料';
        currentTab.siteAssistantContextKey = key;
        currentTab.siteAssistantView = null;
        if (isCurrent()) {
          clearActiveSiteAssistantContext();
          renderSiteAssistantPending(currentTab, currentTab.siteAssistantStatus);
        }
        return null;
      }
      const rawContext = snapshot.page_context || snapshot.pageContext || snapshot;
      const view = assistantProfileApi()?.build?.({ ...rawContext, url: snapshot.url || rawContext.url || currentTab.url }) || null;
      if (!view?.profile || view.profile.site !== profile?.site) throw new Error('当前页面类型发生变化，请重新读取页面资料');
      // 同一 URL 的作品弹窗/详情抽屉不会触发导航。采集器确认的结构化页型
      // 才是当前右侧面板和快捷指令的依据；不把它误判为页面切换失败。
      currentTab.siteAssistantProfile = view.profile;
      const resolvedKey = siteAssistantContextKey(currentTab);
      if (!resolvedKey) throw new Error('当前页面资料缺少可用的上下文标识');
      // pageKey 也按工作标签隔离；这样相同 URL 的并行标签不会复用对话映射。
      view.context.pageKey = resolvedKey;
      currentTab.siteAssistantContextKey = resolvedKey;
      currentTab.siteAssistantView = view;
      currentTab.siteAssistantStatus = '已读取当前可见资料';
      if (state.activeTabId === tabId) {
        state.siteContext = view;
        state.siteContextKey = resolvedKey;
        state.siteContextUrl = view.context?.url || '';
        state.siteContextLoading = false;
        state.siteContextStatus = currentTab.siteAssistantStatus;
        renderSiteAssistant(view);
      }
      return view;
    } catch (error) {
      const currentTab = state.tabs.find((item) => item.id === tabId);
      if (currentTab && siteAssistantContextKey(currentTab) === key) {
        currentTab.siteAssistantStatus = error?.message || '当前页面资料读取失败';
        if (isCurrent()) {
          clearActiveSiteAssistantContext();
          renderSiteAssistantPending(currentTab, currentTab.siteAssistantStatus);
        }
      }
      if (!options.silent) toast(error?.message || '当前页面资料读取失败');
      return null;
    } finally {
      if (isCurrent()) state.siteContextLoading = false;
    }
  }
  function scheduleSiteAssistantContext(tab = activeCommerceTab(), options = {}) {
    const key = siteAssistantContextKey(tab);
    if (!tab || !key) return;
    if (!options.force && hasCachedSiteAssistantContextForTab(tab, key)) {
      if (tab.id === state.activeTabId) restoreSiteAssistantContextForTab(tab, key);
      return;
    }
    clearTimeout(state.siteContextTimer);
    state.siteContextTimer = setTimeout(() => {
      state.siteContextTimer = null;
      const current = state.tabs.find((item) => item.id === tab.id);
      if (!current || siteAssistantContextKey(current) !== key) return;
      void captureSiteAssistantContext({ tab: current, force: Boolean(options.force), silent: options.silent !== false });
    }, Number.isFinite(options.delayMs) ? options.delayMs : 260);
  }
  async function runSiteQuickAction(actionId) {
    const tab = activeCommerceTab();
    const key = siteAssistantContextKey(tab);
    if (!key) return;
    const view = await captureSiteAssistantContext({ tab, force: true });
    if (state.activeTabId !== tab.id || siteAssistantContextKey(activeCommerceTab()) !== key) return;
    const action = view?.actions?.find((item) => item.id === actionId);
    if (!action) return toast('当前页面尚未读取到该快捷分析所需资料');
    await sendChat(action.prompt, { pageContext: view.context, siteQuickAction: true });
  }
  function updateQuickActions() {
    const grid = $('productQuickGrid') || document.querySelector('.quick-grid:not(.site-quick-grid)');
    const siteGrid = $('siteQuickGrid');
    const operationsButton = $('quickOperations');
    if (operationsButton && operationsButton.dataset.labelVersion !== 'dabi-resource-state1') {
      operationsButton.innerHTML = '<span>⌁</span>分析商品运营及人群数据 <b>›</b>';
      operationsButton.dataset.labelVersion = 'dabi-resource-state1';
    }
    if (grid && !grid.querySelector('[data-page-module]')) {
      grid.insertAdjacentHTML('beforeend', '<button type="button" hidden data-page-module="market"><span>⌁</span>寻找市场机会 <b>›</b></button><button type="button" hidden data-page-module="priceSales"><span>⌗</span>分析价格带和销量分布 <b>›</b></button><button type="button" hidden data-page-module="titleTerms"><span>≋</span>总结标题高频词 <b>›</b></button><button type="button" hidden data-page-module="competitors"><span>◇</span>找出高销量低价竞品 <b>›</b></button>');
    }
    const siteProfile = assistantProfileForTab();
    const siteView = activeSiteAssistantView();
    if (siteProfile) {
      const retainProductQuickActions = assistantProfileApi()?.keepsProductQuickActions?.(siteProfile) || siteProfile.id === '1688-detail';
      if (grid) { grid.hidden = !retainProductQuickActions; grid.setAttribute('aria-hidden', String(!retainProductQuickActions)); }
      if (retainProductQuickActions) {
        q('.quick-grid:not(.site-quick-grid) [data-module]').forEach((button) => { button.hidden = false; });
        q('.quick-grid:not(.site-quick-grid) [data-page-module]').forEach((button) => { button.hidden = true; });
      }
      if (siteGrid) {
        const actions = Array.isArray(siteView?.actions) ? siteView.actions : [];
        siteGrid.hidden = !actions.length;
        siteGrid.innerHTML = actions.map((entry) => `<button type="button" data-site-action="${escapeHtml(entry.id)}"><span>⌁</span>${escapeHtml(entry.label)} <b>›</b></button>`).join('');
      }
      const heading = document.querySelector('.quick-heading strong');
      const caption = document.querySelector('.quick-heading span');
      if (heading) heading.textContent = `${siteProfile.title || '当前页面'}快捷分析`;
      if (caption) caption.textContent = retainProductQuickActions ? '商品任务与当前页面可见资料' : siteView ? '基于当前页面可见资料' : '等待当前页面可读资料';
      return;
    }
    if (grid) { grid.hidden = false; grid.setAttribute('aria-hidden', 'false'); }
    if (siteGrid) { siteGrid.hidden = true; siteGrid.innerHTML = ''; }
    const searchMode = isSearchCommerceUrl(activeProductUrl());
    q('.quick-grid [data-module]').forEach((button) => { button.hidden = searchMode; });
    q('.quick-grid [data-page-module]').forEach((button) => { button.hidden = !searchMode; });
    const heading = document.querySelector('.quick-heading strong');
    const caption = document.querySelector('.quick-heading span');
    if (heading) heading.textContent = searchMode ? '搜索页快捷分析' : '快捷分析';
    if (caption) caption.textContent = searchMode ? '基于当前搜索结果页' : '基于当前商品任务';
  }
  function pageContextSummary(context) {
    const keyword = String(context?.keyword || '当前关键词').trim() || '当前关键词';
    const page = context?.page || context?.currentPage || 1;
    const count = context?.totalCount || context?.visibleCount || 0;
    return `已读取关键词【${keyword}】的第 ${page} 页搜索结果，共识别 ${count} 个商品。`;
  }
  function searchPageContextItems(context = {}) {
    const items = Array.isArray(context.items) ? context.items : Array.isArray(context.visibleItems) ? context.visibleItems : [];
    return items.filter((item) => item && typeof item === 'object');
  }
  function searchNumericValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value && typeof value === 'object') return searchNumericValue(value.value ?? value.amount ?? value.price ?? value.min);
    const match = String(value ?? '').replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }
  function searchShippingName(item) {
    const direct = item && typeof item === 'object' ? (item.shipping ?? item.shippingRegion ?? item.location ?? item.region ?? item.origin) : '';
    const directText = String(direct || '').replace(/\s+/g, ' ').trim();
    if (directText && directText !== '[object Object]') {
      const cleaned = directText.replace(/^(?:发货地|产地|所在地)\s*[:：]?\s*/i, '').split(/[|｜,，;；]/)[0].trim();
      return cleaned.replace(/^(?:北京|上海|天津|重庆|广东|江苏|浙江|山东|福建|河北|河南|湖北|湖南|四川|安徽|江西|陕西|山西|辽宁|吉林|黑龙江|广西|云南|贵州|甘肃|新疆|内蒙古|海南|宁夏|青海|西藏)(?:省|市)?\s*/i, '') || cleaned;
    }
    const body = String(item?.text || item?.rawText || '').replace(/\s+/g, ' ').trim();
    const match = body.match(/(?:发货地|产地|所在地)\s*[:：]?\s*([^|｜,，;；\s]+)/i);
    return match ? match[1].trim() : '';
  }
  function searchContextFingerprint(context = {}) {
    const items = searchPageContextItems(context);
    const itemKey = items.slice(0, 32).map((item) => [item.itemId || item.id || item.item_id || '', searchNumericValue(item.price), searchShippingName(item)].join(':')).join('~');
    const regions = Array.isArray(context.shippingRegions) ? context.shippingRegions.join(',') : String(context.shippingRegions || '');
    const ranges = Array.isArray(context.priceRanges) ? context.priceRanges.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(',') : String(context.priceRanges || '');
    return [context.keyword || '', context.page || context.currentPage || 1, context.totalCount ?? '', context.visibleCount ?? '', itemKey, ranges, regions].join('|');
  }
  function formatSearchNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }
  function parseSearchPriceBand(value) {
    const source = value && typeof value === 'object' ? value : {};
    const raw = String(source.label || source.name || source.range || source.text || value || '').replace(/￥|¥/g, '').replace(/\s+/g, '');
    const lowerValue = searchNumericValue(source.min ?? source.lower ?? source.from);
    const upperValue = searchNumericValue(source.max ?? source.upper ?? source.to);
    if (Number.isFinite(lowerValue) || Number.isFinite(upperValue)) return { lower: Number.isFinite(lowerValue) ? lowerValue : 0, upper: Number.isFinite(upperValue) ? upperValue : null };
    const above = raw.match(/(\d+(?:\.\d+)?)(?:元)?(?:以上|\+)/i);
    if (above) return { lower: Number(above[1]), upper: null };
    const range = raw.match(/(\d+(?:\.\d+)?)(?:元)?(?:-|~|～|至)(\d+(?:\.\d+)?)/i);
    if (range) return { lower: Number(range[1]), upper: Number(range[2]) };
    return null;
  }
  function searchBandCount(entry, index, all, prices) {
    if (!prices.length) return Number.isFinite(entry.count) ? entry.count : 0;
    return prices.filter((price) => {
      const lowerOk = index === 0 ? price >= (entry.lower ?? -Infinity) : price > (entry.lower ?? -Infinity);
      const upperOk = entry.upper === null || entry.upper === undefined ? true : price <= entry.upper;
      return lowerOk && upperOk;
    }).length;
  }
  function searchPriceBands(context = {}) {
    const items = searchPageContextItems(context);
    const prices = items.map((item) => searchNumericValue(item.price ?? item.priceValue ?? item.amount)).filter((value) => value !== null && value >= 0).sort((a, b) => a - b);
    const raw = Array.isArray(context.priceBands) ? context.priceBands : Array.isArray(context.priceDistribution?.bands) ? context.priceDistribution.bands : Array.isArray(context.priceRanges) ? context.priceRanges : [];
    const explicit = raw.map((entry) => {
      const parsed = parseSearchPriceBand(entry);
      if (!parsed || parsed.upper !== null && parsed.upper < parsed.lower) return null;
      const source = entry && typeof entry === 'object' ? entry : {};
      let percent = searchNumericValue(source.percentage ?? source.percent ?? source.ratio);
      if (!Number.isFinite(percent) && typeof entry === 'string') percent = searchNumericValue(entry.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 1) percent *= 100;
      const count = searchNumericValue(source.count ?? source.itemCount ?? source.totalCount ?? source.itemsCount);
      return { ...parsed, count, percent };
    }).filter(Boolean);
    const denominator = searchNumericValue(context.totalCount) || prices.length || searchNumericValue(context.visibleCount) || 0;
    if (explicit.length >= 2 && (prices.length || explicit.some((entry) => Number.isFinite(entry.count) || Number.isFinite(entry.percent)))) {
      return explicit.slice(0, 4).map((entry, index, all) => {
        const count = Number.isFinite(entry.count) ? entry.count : searchBandCount(entry, index, all, prices);
        const percent = Number.isFinite(entry.percent) ? Math.round(entry.percent) : denominator ? Math.round(count / denominator * 100) : 0;
        return { ...entry, count, percent };
      });
    }
    if (!prices.length) return [];
    const min = prices[0]; const max = prices[prices.length - 1];
    if (min === max) return [{ lower: min, upper: null, count: prices.length, percent: 100 }];
    const unique = [...new Set(prices)];
    let cuts = [prices[Math.floor(prices.length * .25)], prices[Math.floor(prices.length * .5)], prices[Math.floor(prices.length * .75)]]
      .filter((value) => value > min && value < max);
    cuts = [...new Set(cuts)];
    if (cuts.length < 3 && unique.length > 3) {
      cuts = [...new Set([1, 2, 3].map((part) => min + (max - min) * part / 4).map((value) => Math.round(value)).filter((value) => value > min && value < max))];
    }
    const boundaries = [0, ...cuts];
    const bands = boundaries.map((lower, index) => ({ lower, upper: index < cuts.length ? cuts[index] : null }));
    return bands.map((entry, index, all) => {
      const count = searchBandCount(entry, index, all, prices);
      return { ...entry, count, percent: Math.round(count / prices.length * 100) };
    });
  }
  function searchShippingRegions(context = {}) {
    const counts = new Map();
    searchPageContextItems(context).forEach((item) => {
      const name = searchShippingName(item);
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (!counts.size) {
      const regions = Array.isArray(context.shippingRegions) ? context.shippingRegions : Array.isArray(context.shipping_regions) ? context.shipping_regions : [];
      regions.forEach((entry) => {
        const source = entry && typeof entry === 'object' ? entry : {};
        const name = String(source.name || source.region || source.city || source.label || entry || '').replace(/\s*[（(].*?[）)]\s*$/, '').trim();
        if (!name || name === '[object Object]') return;
        const count = searchNumericValue(source.count ?? source.total ?? source.value) || 0;
        counts.set(name, Math.max(counts.get(name) || 0, count || 1));
      });
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN')).slice(0, 5).map(([name]) => name);
  }
  function searchPageGreetingDetails(context = {}) {
    const bands = searchPriceBands(context);
    const details = [];
    if (bands.length) {
      const labels = bands.map((band, index) => {
        const isOpenEnded = band.upper === null || band.upper === undefined;
        const label = isOpenEnded ? `${formatSearchNumber(band.lower)}以上` : `${index === 0 ? '0' : formatSearchNumber(band.lower)}-${formatSearchNumber(band.upper)}元`;
        return `${label}（${band.percent || 0}%的选择）`;
      });
      details.push(`💰 价格段：${labels.join(' / ')}`);
    }
    const regions = searchShippingRegions(context);
    if (regions.length) details.push(`🏠 发货地（前5名）：${regions.join('、')}。`);
    return details;
  }
  function searchPageGreetingText(context = {}) {
    const keyword = String(context.keyword || '当前关键词').trim() || '当前关键词';
    const page = context.page || context.currentPage || 1;
    const count = searchNumericValue(context.totalCount) || searchNumericValue(context.visibleCount) || searchPageContextItems(context).length || 0;
    return [`已经帮你看过关键词【${keyword}】的第 ${page} 页搜索结果了，一共是 ${count} 个商品了。👇`, ...searchPageGreetingDetails(context)].join('\n');
  }
  async function copySearchPageGreeting(button) {
    const node = button?.closest?.('.search-page-greeting');
    const value = node?.dataset.copyText || '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast('已复制分析摘要');
    } catch {
      const area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); toast('已复制分析摘要');
    }
  }
  function upsertSearchPageGreeting(context) {
    const box = $('chatMessages'); if (!box || !context) return;
    const key = searchContextFingerprint(context);
    const current = box.querySelector('.search-page-greeting');
    if (current && state.pageContextShownKey === key) return;
    box.querySelectorAll('[data-page-context-placeholder="true"]').forEach((node) => node.remove());
    current?.remove();
    const textValue = searchPageGreetingText(context);
    const lines = textValue.split('\n');
    const node = document.createElement('div');
    node.className = 'chat-message assistant search-page-greeting';
    node.dataset.searchContextKey = key;
    node.dataset.copyText = textValue;
    const content = lines.map((line, index) => `<p class="${index === 0 ? 'search-page-greeting-main' : 'search-page-greeting-detail'}">${escapeHtml(line)}</p>`).join('');
    node.innerHTML = `<div class="message-bubble"><div class="search-page-greeting-content">${content}</div><div class="search-page-greeting-meta"><span>小美 · ${escapeHtml(productIntroTime())}</span><button type="button" data-copy-search-context aria-label="复制分析摘要" title="复制分析摘要">⧉</button></div></div>`;
    box.appendChild(node);
    state.pageContextShownKey = key;
    state.messages = state.messages.filter((item) => item?.kind !== 'search-page-context');
    state.messages.push({ role: 'assistant', kind: 'search-page-context', content: textValue, attachments: [] });
    renderChatHistory();
    box.scrollTop = box.scrollHeight;
  }
  function showPageContext(context) {
    if (!context) return;
    $('chatContextLabel').textContent = `已读取搜索页 · ${context.visibleCount || context.totalCount || 0} 个商品`;
    $('contextChip').textContent = '搜索结果';
    updateQuickActions();
    upsertSearchPageGreeting(context);
  }
  async function captureCurrentPageContext(options = {}) {
    const safeUrl = safeCommerceUrl(options.url || activeProductUrl());
    if (!safeUrl || !isSearchCommerceUrl(safeUrl)) return null;
    const key = productContextKey(safeUrl);
    if (!options.force && state.pageContext && state.pageContextKey === key) return state.pageContext;
    if (state.pageContextLoading && state.pageContextKey === key) return state.pageContext;
    state.pageContextLoading = true;
    state.pageContextKey = key;
    setJobState('正在读取当前搜索结果页…', 'running');
    setSiteState('正在读取当前搜索页', 'busy');
    try {
      const shell = shellApi();
      const snapshot = shell?.capturePageContext
        ? await shell.capturePageContext({ kind: 'search' })
        : await api('/api/commerce-analysis/page-context', { method: 'POST', body: JSON.stringify({ url: safeUrl }) });
      if (!snapshot?.ok) throw new Error(snapshot?.message || '当前搜索页没有返回可读数据');
      const context = snapshot.page_context || snapshot.pageContext || snapshot;
      const actualUrl = safeCommerceUrl(snapshot.url || context.url || safeUrl) || safeUrl;
      const actualKey = productContextKey(actualUrl);
      if (actualKey && key && actualKey !== key) return null;
      state.pageContext = { ...context, url: actualUrl, source: snapshot.source || context.source || 'current-page' };
      state.pageContextKey = actualKey || key;
      state.pageContextUrl = actualUrl;
      setJobState(pageContextSummary(state.pageContext), 'ready');
      setSiteState('当前搜索页已连接', 'ok');
      showPageContext(state.pageContext);
      return state.pageContext;
    } catch (error) {
      setJobState(error.message || '当前搜索页暂未读取成功', 'error');
      setSiteState('当前搜索页读取失败', 'error');
      if (!options.silent) toast(error.message || '当前搜索页暂未读取成功');
      return null;
    } finally {
      state.pageContextLoading = false;
    }
  }
  function schedulePageContext(url, options = {}) {
    const safeUrl = safeCommerceUrl(url);
    if (!safeUrl || !isSearchCommerceUrl(safeUrl)) return;
    const key = productContextKey(safeUrl);
    if (!options.force && state.pageContext && state.pageContextKey === key) { showPageContext(state.pageContext); return; }
    clearTimeout(state.pageContextTimer);
    state.pageContextTimer = setTimeout(() => {
      state.pageContextTimer = null;
      if (productContextKey(activeProductUrl()) !== key) return;
      captureCurrentPageContext({ url: safeUrl, force: Boolean(options.force), silent: options.silent !== false }).catch(() => {});
    }, Number.isFinite(options.delayMs) ? options.delayMs : 220);
  }
  function tabDisplayTitle(label = '淘宝', url = '') { const value = String(label || '淘宝'); const platform = platformForUrl(url); if (platform) return platform.label; if (isDetailCommerceUrl(url)) return tabTitleFromPage(value); if (value.includes('千牛')) return '千牛'; if (value.includes('生意参谋')) return '生意参谋'; if (value.includes('1688')) return '1688'; if (value.includes('分析')) return '商品分析台'; return '淘宝'; }
  function updateCommerceAuthLabels(tab = activeCommerceTab()) {
    const target = commerceLoginTarget(tab?.url || state.embeddedUrl || state.productUrl || state.url, tab?.site || tab?.platform);
    const canLogin = tab?.type === 'commerce' && Boolean(target.supported && target.loginUrl);
    const label = canLogin ? `登录${target.label}` : '站点内登录';
    const loginButton = $('loginTaobao');
    if (loginButton) { loginButton.hidden = !canLogin; loginButton.textContent = label; loginButton.title = canLogin ? `打开${target.label}官方登录页` : '跨境平台请在当前官方页面内登录'; }
    const surfaceLogin = $('surfaceLogin');
    if (surfaceLogin) { surfaceLogin.hidden = !canLogin; surfaceLogin.textContent = label; }
    const browserLogin = $('browserLogin');
    if (browserLogin) { browserLogin.hidden = !canLogin; browserLogin.textContent = label; browserLogin.title = canLogin ? `打开${target.label}官方登录页` : '跨境平台请在当前官方页面内登录'; }
    for (const id of ['checkTaobaoLogin', 'clearCommerceSession']) {
      const button = $(id);
      if (button) button.hidden = !canLogin;
    }
  }
  function commerceTabVisual(tab = {}) {
    const title = String(tab.title || '').trim();
    const site = String(tab.site || '').trim().toLowerCase();
    const platform = platformForUrl(tab.url);
    if (tab.type === 'analysis') return { className: 'canvas-dot', glyph: '小' };
    if (platform) return { className: platform.className, glyph: platform.glyph };
    if (site === 'sycm' || site.includes('生意参谋') || title.includes('生意参谋')) return { className: 'insight-dot', glyph: '参' };
    if (tab.kind === 'seller' || site === 'qianniu' || site.includes('千牛') || title.includes('千牛')) return { className: 'qianniu-dot', glyph: '千' };
    if (title === '1688' || site === '1688') return { className: 'source-dot', glyph: '源' };
    return { className: 'taobao-dot', glyph: '淘' };
  }
  function clearCommerceTabDragState() {
    commerceTabDragState = null;
    q('[data-commerce-tab]').forEach((button) => {
      button.classList.remove('is-dragging', 'drop-before', 'drop-after');
      button.removeAttribute('aria-grabbed');
    });
  }
  function reorderCommerceTabs(sourceId, targetId, placeAfter = false) {
    const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceId);
    if (sourceIndex < 0 || sourceId === targetId) return;
    const [movedTab] = state.tabs.splice(sourceIndex, 1);
    const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId);
    if (targetIndex < 0) {
      state.tabs.splice(sourceIndex, 0, movedTab);
      return;
    }
    state.tabs.splice(targetIndex + (placeAfter ? 1 : 0), 0, movedTab);
    renderCommerceTabs();
  }
  function bindCommerceTabDrag(button) {
    button.draggable = true;
    button.addEventListener('dragstart', (event) => {
      const tabId = String(button.dataset.commerceTab || '').trim();
      if (!tabId || event.target.closest?.('.tab-close')) {
        event.preventDefault();
        return;
      }
      commerceTabDragState = { tabId };
      button.classList.add('is-dragging');
      button.setAttribute('aria-grabbed', 'true');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabId);
      }
    });
    button.addEventListener('dragover', (event) => {
      const sourceId = commerceTabDragState?.tabId || event.dataTransfer?.getData('text/plain');
      const targetId = String(button.dataset.commerceTab || '').trim();
      if (!sourceId || !targetId || sourceId === targetId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = button.getBoundingClientRect();
      const placeAfter = event.clientX >= rect.left + rect.width / 2;
      button.classList.toggle('drop-before', !placeAfter);
      button.classList.toggle('drop-after', placeAfter);

      // Keep the destination reachable when the tab strip contains more tabs
      // than the available width.
      const strip = $('tabStrip');
      if (strip) {
        const stripRect = strip.getBoundingClientRect();
        if (event.clientX < stripRect.left + 28) strip.scrollLeft -= 12;
        else if (event.clientX > stripRect.right - 28) strip.scrollLeft += 12;
      }
    });
    button.addEventListener('dragleave', (event) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      button.classList.remove('drop-before', 'drop-after');
    });
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = commerceTabDragState?.tabId || event.dataTransfer?.getData('text/plain');
      const targetId = String(button.dataset.commerceTab || '').trim();
      const rect = button.getBoundingClientRect();
      const placeAfter = event.clientX >= rect.left + rect.width / 2;
      if (sourceId && targetId) reorderCommerceTabs(sourceId, targetId, placeAfter);
      clearCommerceTabDragState();
    });
    button.addEventListener('dragend', clearCommerceTabDragState);
  }
  function renderCommerceTabs() {
    const strip = $('tabStrip'); if (!strip) return;
    updateCommerceAuthLabels();
    const tabs = state.tabs.map((tab) => { const visual = commerceTabVisual(tab); const canClose = Boolean(tab.closable && state.tabs.length > 1); return `<button class="browser-tab ${tab.id === state.activeTabId ? 'is-active' : ''}" type="button" data-commerce-tab="${escapeHtml(tab.id)}" aria-label="切换到${escapeHtml(tab.title)}，左右拖动可调整标签顺序" title="左右拖动可调整标签顺序"><span class="tab-dot ${visual.className}">${visual.glyph}</span><span class="tab-title">${escapeHtml(tab.title)}</span>${canClose ? `<span class="tab-close" data-close-commerce-tab="${escapeHtml(tab.id)}" aria-label="关闭${escapeHtml(tab.title)}">×</span>` : ''}</button>`; }).join('');
    strip.innerHTML = `${tabs}<button class="tab-add" id="tabAdd" type="button" title="新建标签页" aria-label="新建标签页">＋</button>`;
    q('[data-commerce-tab]', strip).forEach((button) => { button.onclick = () => activateCommerceTab(button.dataset.commerceTab); bindCommerceTabDrag(button); });
    q('[data-close-commerce-tab]', strip).forEach((button) => { button.onclick = (event) => { event.stopPropagation(); closeCommerceTab(button.dataset.closeCommerceTab); }; });
    $('tabAdd').onclick = () => openNewAnalysisTab();
  }
  function openNewAnalysisTab() {
    const tab = {
      id: `analysis-${++state.tabSerial}`,
      title: '新标签页',
      type: 'analysis',
      url: '',
      closable: true,
      kind: 'home',
    };
    state.tabs.push(tab);
    activateCommerceTab(tab.id, { load: false, resetAssistant: true });
    showAnalysisDesktop();
    return tab;
  }
  function switchCommerceTabByOffset(offset) {
    const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
    if (index < 0 || state.tabs.length < 2) return;
    const nextIndex = (index + offset + state.tabs.length) % state.tabs.length;
    activateCommerceTab(state.tabs[nextIndex].id);
  }
  function switchCommerceTabByIndex(index) {
    const tab = state.tabs[Math.max(0, Math.min(Number(index) || 0, state.tabs.length - 1))];
    if (tab) activateCommerceTab(tab.id);
  }
  function handleBrowserShortcut(payload = {}) {
    const action = String(payload.action || '').trim();
    if (action === 'new-tab') { openNewAnalysisTab(); return; }
    if (action === 'clear-data') { clearBrowserData(); return; }
    if (action === 'focus-address') { const input = $('productUrl'); input?.focus(); input?.select(); return; }
    if (action === 'close-tab') { closeCommerceTab(payload.tabId || state.activeTabId); return; }
    if (action === 'next-tab') { switchCommerceTabByOffset(1); return; }
    if (action === 'prev-tab') { switchCommerceTabByOffset(-1); return; }
    if (action === 'jump-tab') { switchCommerceTabByIndex(payload.index); }
  }
  async function translateActiveCommercePage() {
    const tab = activeCommerceTab();
    if (tab?.type !== 'commerce') return toast('请先打开一个官方平台页面');
    const shell = shellApi();
    if (typeof shell?.translateProductPage !== 'function') return toast('翻译当前页面需要使用小美画布桌面版');
    const button = $('browserTranslate');
    const wasTranslated = Boolean(tab.pageTranslationActive);
    if (button) {
      button.disabled = true;
      button.textContent = wasTranslated ? '正在恢复…' : '正在翻译…';
    }
    try {
      const result = await shell.translateProductPage(tab.id);
      if (!result?.ok) return toast(result?.message || '当前页面翻译失败');
      tab.pageTranslationActive = Boolean(result.translated);
      if (state.activeTabId === tab.id) {
        setSiteState(tab.pageTranslationActive ? '页面已翻译为中文' : '已恢复页面原文', 'ok');
      }
      toast(result.message || (tab.pageTranslationActive ? '页面已翻译为中文' : '已恢复页面原文'));
    } catch (error) {
      toast(error?.message || '当前页面翻译失败');
    } finally {
      updateBrowserTranslationButton();
    }
  }
  async function reloadActiveCommercePage() {
    const tab = activeCommerceTab();
    if (tab?.type !== 'commerce') return openProduct();
    const shell = shellApi();
    const loading = Boolean(state.browserNav.loading);
    if (!loading) tab.pageTranslationActive = false;
    const method = loading ? shell?.stopProduct : shell?.reloadProduct;
    if (!loading) {
      // 显式刷新代表用户要求重新读取页面；清掉该标签的快照，
      // 但普通的标签切换仍只恢复缓存，不会走到这里。
      invalidateTabAnalysisCache(tab);
      clearTimeout(state.polling);
      state.polling = null;
      state.jobId = ''; state.job = null; state.result = null; state.operation = null;
      state.analysisProductKey = ''; state.analysisRequestToken = ''; state.analysisStarting = false;
      state.autoCollectionProductKey = '';
      state.selectedResourceIds = new Set(); state.resourceSelectionProductKey = '';
      renderInfo(null); renderModules(); renderResources(null);
      setJobState('正在重新读取商品基础信息…', 'running');
    }
    if (typeof method === 'function') {
      try {
        const result = loading
          ? await method.call(shell, tab.id)
          : await method.call(shell, tab.id, { hard: false });
        if (!result?.ok && result?.message) toast(result.message);
        return result;
      } catch (error) {
        toast(error?.message || (loading ? '停止加载失败' : '刷新页面失败'));
        return null;
      }
    }
    toast(loading ? '当前页面无法停止加载，请稍后重试' : '官方商品页仅支持小美画布桌面版内置浏览器');
    return null;
  }
  function activateCommerceTab(tabId, options = {}) {
    const tab = state.tabs.find((item) => item.id === tabId); if (!tab) return;
    const previousTabId = state.activeTabId;
    if (previousTabId !== tab.id) {
      clearChatAttachments();
      rememberActiveTabConversation();
      const previousTab = state.tabs.find((item) => item.id === previousTabId);
      rememberProductAnalysisForTab(previousTab);
      rememberPageContextForTab(previousTab);
      rememberSiteAssistantContextForTab(previousTab);
    }
    state.activeTabId = tab.id;
    const home = $('analysisDesktop'); const center = $('centerStage'); const surface = $('commerceBrowserSurface'); const shell = shellApi(); const commerce = tab.type === 'commerce';
    if (commerce) applyProductInfoExpandedForTab(false);
    if (previousTabId !== tab.id || options.resetAssistant) state.assistantOverride = false;
    applyAssistantVisibility(tab);
    if (home) { home.hidden = commerce; home.setAttribute('aria-hidden', commerce ? 'true' : 'false'); }
    const requiresDesktop = Boolean(commerce && !shell?.openProduct);
    center?.classList.toggle('is-commerce-tab', commerce); surface?.classList.toggle('requires-desktop', requiresDesktop);
    if (commerce) {
      const navigationUrl = safeCommerceUrl(tab.requestedUrl || tab.url || '');
      const committedUrl = safeCommerceUrl(tab.url || '');
      const requestedKind = tab.requestedKind || tab.kind;
      const requestedSite = tab.requestedSite || tab.site;
      const requestedPlatform = tab.requestedPlatform || tab.platform;
      updateBrowserNavigation(tab.browserNav || { canGoBack: false, canGoForward: false, loading: false, zoom: 100 });
      const productTab = tab.kind === 'detail' || tab.kind === 'product';
      if (productTab) {
        if (!committedUrl) { state.url = ''; state.productUrl = ''; state.embeddedUrl = ''; if ($('productUrl')) $('productUrl').value = ''; }
        const targetKey = productContextKey(tab.url);
        const hasCachedAnalysis = hasCachedProductAnalysisForTab(tab, targetKey);
        const hasCachedPageContext = hasCachedPageContextForTab(tab, targetKey);
        if (hasCachedAnalysis) {
          // 已完成的商品标签直接恢复自己的快照；不要先走
          // syncProductContext() 清空全局状态，再被页面 ready 事件重新采集。
          state.productKey = targetKey;
          state.url = tab.url || state.url;
          state.productUrl = tab.url || state.productUrl;
          state.embeddedUrl = tab.url || state.embeddedUrl;
          if (tab.url) $('productUrl').value = tab.url;
          restoreProductAnalysisForTab(tab, targetKey);
          restorePageContextForTab(tab, targetKey);
        } else {
          syncProductContext(tab.url);
          if (hasCachedPageContext) restorePageContextForTab(tab, targetKey);
        }
        state.url = tab.url || state.url; state.productUrl = tab.url || state.productUrl; state.embeddedUrl = tab.url || state.embeddedUrl; if (tab.url) $('productUrl').value = tab.url;
        const targetConversationId = conversationIdForProduct(targetKey, tab);
        const hasCachedMessages = Array.isArray(tab.conversationMessages) && tab.conversationMessages.length > 0 && tab.conversationProductKey === targetKey;
        const conversationNeedsRestore = previousTabId !== tab.id || state.conversationProductKey !== targetKey || state.conversationId !== targetConversationId || (hasCachedMessages && !state.messages.length);
        const restoreAlreadyRequested = lastConversationRestoreKey === targetKey && (!lastConversationRestoreTabId || lastConversationRestoreTabId === tab.id);
        if (targetKey && conversationNeedsRestore && !restoreAlreadyRequested) void restoreConversationForProduct(targetKey, { tab });
      }
      else if (tab.url) {
        state.embeddedUrl = tab.url;
        const platformPage = platformForCommerceTab(tab, tab.url);
        if (platformPage && tab.id === state.activeTabId) {
          state.url = tab.url;
          state.productUrl = '';
          if ($('productUrl')) $('productUrl').value = tab.url;
        }
      }
      const siteAssistant = isSiteAssistantTab(tab);
      if (siteAssistant) {
        const siteKey = siteAssistantContextKey(tab);
        if (!restoreSiteAssistantContextForTab(tab, siteKey)) {
          renderSiteAssistantPending(tab);
          scheduleSiteAssistantContext(tab, { force: false });
        }
        if (usesDedicatedSiteConversation(tab)) {
          const targetConversationId = conversationIdForProduct(siteKey, tab);
          const hasCachedMessages = Array.isArray(tab.conversationMessages) && tab.conversationMessages.length > 0 && tab.conversationProductKey === siteKey;
          const conversationNeedsRestore = previousTabId !== tab.id || state.conversationProductKey !== siteKey || state.conversationId !== targetConversationId || (hasCachedMessages && !state.messages.length);
          const restoreAlreadyRequested = lastConversationRestoreKey === siteKey && (!lastConversationRestoreTabId || lastConversationRestoreTabId === tab.id);
          if (siteKey && conversationNeedsRestore && !restoreAlreadyRequested) void restoreConversationForProduct(siteKey, { tab, emptyMessage: `正在读取${assistantProfileForTab(tab)?.title || '当前页面'}的可见资料…`, pageContextPlaceholder: true });
        }
      } else {
        clearActiveSiteAssistantContext();
        $('pageContextCard').hidden = true;
        $('productInfoCard').hidden = false;
      }
      if (surface) $('surfacePlaceholder').classList.add('is-embedded'); $('surfaceStatus').textContent = requiresDesktop ? '官方商品页仅支持桌面版内置浏览器' : `正在前往${tab.title}`;
      const loadTab = () => { if (!shell || !navigationUrl) return; const task = requestedKind === 'seller' ? shell.openSeller?.(requestedSite, tab.id) : requestedKind === 'login' ? shell.openLogin?.(requestedSite || requestedPlatform || 'taobao', tab.id) : shell.openProduct?.(navigationUrl, tab.id); Promise.resolve(task).catch((error) => toast(error.message)); };
      if (requiresDesktop) {
        setProductViewVisible(false, tab.id);
      } else if (shell?.activateProductTab && options.load !== false) Promise.resolve(shell.activateProductTab(tab.id, { kind: requestedKind, site: requestedSite, url: navigationUrl })).then((result) => {
        // 标签切换期间，旧标签的激活请求可能晚于新标签完成。只有
        // 该商品标签仍是当前活动标签时，才能把原生视图重新显示出来。
        const stillActive = state.activeTabId === tab.id && activeCommerceTab()?.type === 'commerce' && !analysisDesktopVisible();
        if (result?.ok && stillActive) setProductViewVisible(true, tab.id);
        else if (!result?.ok && stillActive) loadTab();
      }).catch((error) => { if (state.activeTabId === tab.id) toast(error.message); });
      else if (options.load !== false) loadTab();
    } else {
      state.embeddedUrl = ''; surface?.classList.remove('requires-desktop'); $('surfacePlaceholder')?.classList.remove('is-embedded'); $('surfaceStatus').textContent = '等待打开商品页'; setProductViewVisible(false);
      updateBrowserNavigation({ canGoBack: false, canGoForward: false, loading: false, zoom: 100 });
    }
    syncCommerceLoadingState(tab);
    renderCommerceTabs();
    if (commerce && (tab.kind === 'detail' || tab.kind === 'product') && tab.ready && isSearchCommerceUrl(tab.url)) {
      schedulePageContext(tab.url, { tabId: tab.id, force: false });
    }
    updateQuickActions();
    setTimeout(emitBounds, 0);
  }
  function closeCommerceTab(tabId) {
    if (state.tabs.length <= 1) return;
    const index = state.tabs.findIndex((tab) => tab.id === tabId); if (index < 0) return;
    const tab = state.tabs[index];
    closedCommerceTabIds.add(tabId);
    if (tab?.type === 'commerce') Promise.resolve(shellApi()?.closeProductTab?.(tabId)).catch(() => {});
    const wasActive = state.activeTabId === tabId; state.tabs.splice(index, 1);
    if (wasActive) {
      const nextTabId = state.tabs[Math.max(0, index - 1)]?.id || 'analysis';
      activateCommerceTab(nextTabId);
      if (nextTabId === 'analysis' && !state.tabs.some((item) => item.type === 'commerce')) {
        state.url = ''; state.productUrl = ''; state.embeddedUrl = '';
        if ($('productUrl')) $('productUrl').value = '';
      }
    } else renderCommerceTabs();
  }
  function openCommerceTab(url, label = '淘宝', options = {}) {
    const safeUrl = safeCommerceUrl(url); if (!safeUrl) { toast('仅支持已加入工作应用的平台官网'); return null; }
    const shell = shellApi(); const nativeDesktop = Boolean(shell?.openProduct);
    const detail = isDetailCommerceUrl(safeUrl); const platform = platformForUrl(safeUrl); const kind = detail ? 'detail' : (options.kind || (platform ? 'platform' : 'product')); const title = detail ? tabTitleFromPage(options.pageTitle || label) : platform?.label || tabDisplayTitle(label, safeUrl); let tab = !options.newTab && activeCommerceTab()?.type === 'commerce' ? activeCommerceTab() : null;
    if (!tab) {
      tab = { id: `commerce-${++state.tabSerial}`, title, type: 'commerce', url: nativeDesktop ? '' : safeUrl, requestedUrl: safeUrl, productUrl: !nativeDesktop && detail ? safeUrl : '', closable: true, kind, site: options.site || platform?.id || '', platform: options.platform || platform?.id || '', productKey: detail ? commerceProductKey(safeUrl) : '', requestedKind: '', requestedSite: '', requestedPlatform: '', requestedProductKey: '', verification: false, loadError: '', ready: false, authPageSeen: false, productInfoExpanded: inheritedProductInfoExpanded(), conversationProductKey: null, conversationId: null, conversationMessages: [], pageTranslationActive: false, browserNav: { canGoBack: false, canGoForward: false, loading: true } };
      state.tabs.push(tab);
    } else {
      tab.title = title; tab.requestedUrl = safeUrl;
      const nextSite = options.site || platform?.id || (kind === 'seller' ? (tab.site || '') : '');
      const nextPlatform = options.platform || platform?.id || '';
      if (!nativeDesktop || !tab.url) {
        if (!nativeDesktop) { tab.url = safeUrl; tab.productUrl = detail ? safeUrl : ''; }
        tab.kind = kind; tab.site = nextSite; tab.platform = nextPlatform; tab.productKey = detail ? commerceProductKey(safeUrl) : '';
        tab.requestedKind = ''; tab.requestedSite = ''; tab.requestedPlatform = ''; tab.requestedProductKey = '';
      } else {
        // The native page remains the committed document until Electron reports
        // the new main-frame URL. Keep its product context intact while this
        // request is loading instead of relabelling old content as new content.
        tab.requestedKind = kind; tab.requestedSite = nextSite; tab.requestedPlatform = nextPlatform; tab.requestedProductKey = detail ? commerceProductKey(safeUrl) : '';
      }
      tab.verification = false; tab.loadError = ''; tab.ready = false; tab.authPageSeen = false; tab.siteAssistantProfile = null; tab.pageTranslationActive = false; tab.browserNav = { ...(tab.browserNav || {}), loading: true };
    }
    if (!nativeDesktop) {
      if (kind === 'detail' || kind === 'product') { syncProductContext(safeUrl); state.url = safeUrl; state.productUrl = safeUrl; state.embeddedUrl = safeUrl; $('productUrl').value = safeUrl; }
      else { state.embeddedUrl = safeUrl; if (platform) { state.url = safeUrl; $('productUrl').value = safeUrl; } }
    }
    activateCommerceTab(tab.id, { load: options.load !== false }); return tab;
  }
  function syncCommerceLoadingState(tab = activeCommerceTab()) {
    const center = $('centerStage');
    const commerce = tab?.type === 'commerce';
    const nativeDesktop = Boolean(shellApi()?.openProduct);
    const targetUrl = safeCommerceUrl(tab?.requestedUrl || tab?.url || '');
    const hasTarget = Boolean(targetUrl);
    const loading = Boolean(commerce && nativeDesktop && hasTarget && !tab.loadError
      && (tab.browserNav?.loading || (tab.requestedUrl && !tab.ready)));
    const failed = Boolean(commerce && nativeDesktop && hasTarget && tab.loadError);
    center?.classList.toggle('is-commerce-loading', loading);
    center?.classList.toggle('is-commerce-error', failed);
    if (!commerce || (!loading && !failed) || tab.id !== state.activeTabId) return;
    const platform = platformForUrl(targetUrl) || (isTaobaoHomeUrl(targetUrl) ? taobaoHomePlatform : null);
    const pageLabel = platform?.label || (isDetailCommerceUrl(targetUrl) ? '商品详情' : tab.title || '官方页面');
    const status = $('surfaceStatus');
    const title = $('previewTitle');
    const description = $('previewDescription');
    const mediaLabel = $('previewMediaLabel');
    if (failed) {
      if (status) status.textContent = '页面加载失败';
      if (title) title.textContent = `${pageLabel}加载失败`;
      if (description) description.textContent = '页面没有成功打开。请点击右上角刷新按钮重试。';
      if (mediaLabel) mediaLabel.textContent = '无法显示页面';
      return;
    }
    if (status) status.textContent = `正在打开${pageLabel}…`;
    if (title) title.textContent = `正在打开${pageLabel}`;
    if (description) description.textContent = '页面内容正在加载，加载完成后会显示在这里。';
    if (mediaLabel) mediaLabel.textContent = '页面加载中…';
  }
  function updateCommerceTabFromSurface(payload = {}) {
    const url = safeCommerceUrl(payload.url || '');
    const ensured = ensureCommerceTabFromSurface(payload, url);
    if (ensured.ignored) return false;
    const tab = ensured.tab || state.tabs.find((item) => item.id === payload.tabId) || activeCommerceTab();
    if (!tab || tab.type !== 'commerce') return false;
    const hasPayloadField = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    const surfaceRevision = Number(payload.navigationRevision || 0);
    // A legacy title-only event is harmless, but a revision-less URL must not
    // overwrite a tab that is already tracking a newer native navigation.
    if (!surfaceRevision && Number(tab.surfaceRevision || 0) > 0
      && (hasPayloadField('url') || hasPayloadField('requestedUrl'))) return false;
    if (surfaceRevision && Number(tab.surfaceRevision || 0) > surfaceRevision) return false;
    if (surfaceRevision) tab.surfaceRevision = surfaceRevision;
    const committedRevision = Number(payload.committedNavigationRevision || 0);
    if (hasPayloadField('committedNavigationRevision')) tab.committedNavigationRevision = committedRevision;
    const documentCommitted = Boolean(url) && (!surfaceRevision || committedRevision >= surfaceRevision);
    const requestedUrl = safeCommerceUrl(payload.requestedUrl || '');
    if (hasPayloadField('requestedUrl')) tab.requestedUrl = requestedUrl;
    if (hasPayloadField('loadError')) tab.loadError = String(payload.loadError || '').trim();
    else if (payload.ready === true) tab.loadError = '';
    if (ensured.created) activateCommerceTab(tab.id, { load: false });
    const carriesNavigationState = Boolean(surfaceRevision || hasPayloadField('url') || hasPayloadField('requestedUrl') || hasPayloadField('loadError'));
    if (carriesNavigationState && !documentCommitted) {
      tab.ready = false;
      tab.browserNav = { ...(tab.browserNav || {}), canGoBack: Boolean(payload.canGoBack), canGoForward: Boolean(payload.canGoForward), loading: Boolean(payload.loading), zoom: Number.isFinite(Number(payload.zoom)) ? Math.round(Number(payload.zoom)) : (tab.browserNav?.zoom || 100) };
      if (tab.id === state.activeTabId) {
        updateBrowserNavigation(tab.browserNav);
        if (payload.loadError) {
          $('surfaceStatus').textContent = `页面加载失败：${payload.loadError}`;
          setSiteState('页面加载失败', 'error');
        } else {
          const requestedPlatform = platformForUrl(requestedUrl || tab.requestedUrl || '');
          const pageLabel = requestedPlatform?.label || tab.title || '官方页面';
          $('surfaceStatus').textContent = `正在前往${pageLabel}`;
          setSiteState(`正在打开${pageLabel}`, 'busy');
        }
      }
      syncCommerceLoadingState(tab);
      updateQuickActions();
      renderCommerceTabs();
      return true;
    }
    const previousUrl = safeCommerceUrl(tab.url || '');
    if (url && previousUrl && url !== previousUrl) tab.pageTranslationActive = false;
    const previousSiteContextKey = siteAssistantContextKey(tab);
    const nextUrl = documentCommitted ? url : tab.url;
    const nextIsDetail = isDetailCommerceUrl(nextUrl);
    const platform = platformForCommerceTab(tab, nextUrl);
    const loginPage = isCommerceLoginUrl(nextUrl);
    const loginTarget = commerceLoginTarget(nextUrl, tab.site || tab.platform);
    const verification = Boolean(payload.verification);
    const wasAuthPage = Boolean(tab.authPageSeen);
    if (nextIsDetail) {
      syncProductContext(nextUrl);
      tab.productUrl = nextUrl;
    }
    if (documentCommitted) {
      tab.url = url; tab.requestedUrl = '';
      tab.requestedKind = ''; tab.requestedSite = ''; tab.requestedPlatform = ''; tab.requestedProductKey = '';
    }
    if (nextUrl && nextUrl !== previousUrl) tab.siteAssistantProfile = null;
    const nextSiteContextKey = siteAssistantContextKey(tab);
    if (previousSiteContextKey && previousSiteContextKey !== nextSiteContextKey) {
      tab.siteAssistantContextKey = '';
      tab.siteAssistantView = null;
      tab.siteAssistantStatus = '';
      tab.siteAssistantProfile = null;
      if (tab.id === state.activeTabId) clearActiveSiteAssistantContext();
    }
    if (tab.id === state.activeTabId && nextIsDetail) {
      const targetKey = productContextKey(tab.productUrl || tab.url);
      const targetConversationId = conversationIdForProduct(targetKey, tab);
      const hasCachedMessages = Array.isArray(tab.conversationMessages) && tab.conversationMessages.length > 0 && tab.conversationProductKey === targetKey;
      const conversationNeedsRestore = state.conversationProductKey !== targetKey || state.conversationId !== targetConversationId || (hasCachedMessages && !state.messages.length);
      const restoreAlreadyRequested = lastConversationRestoreKey === targetKey && (!lastConversationRestoreTabId || lastConversationRestoreTabId === tab.id);
      if (targetKey && conversationNeedsRestore && !restoreAlreadyRequested) void restoreConversationForProduct(targetKey, { tab });
    }
    if (loginPage || verification) {
      // 登录/验证页是当前商品的临时导航，不得把商品上下文改成 login.taobao.com。
      tab.authPageSeen = true;
      tab.ready = false;
    } else if (payload.ready === true) tab.ready = true;
    else if (payload.ready === false) tab.ready = false;
    const detail = nextIsDetail;
    const recoveredFromAuth = detail && wasAuthPage && !loginPage && !verification;
    if (verification) {
      tab.kind = 'detail'; tab.verification = true; tab.ready = false; tab.title = '验证码拦截';
    } else if (loginPage) {
      tab.kind = 'login'; tab.site = loginTarget.site; tab.platform = loginTarget.site; tab.verification = false; tab.title = `${loginTarget.label}登录`;
    } else if (detail) {
      tab.kind = 'detail'; tab.verification = false; tab.authPageSeen = false; tab.productKey = commerceProductKey(tab.url); if (payload.title) tab.title = tabTitleFromPage(payload.title);
    } else if (platform) {
      tab.kind = 'platform'; tab.platform = platform.id; tab.site = platform.id; tab.verification = false; tab.title = platform.label;
    } else if (tab.kind !== 'detail' || !tab.productKey) {
      tab.kind = 'product'; tab.verification = false; tab.title = tabDisplayTitle(payload.site || '淘宝', tab.url);
    } else { tab.verification = false; }
    if (tab.id === state.activeTabId) {
      state.browserNav = { ...state.browserNav, canGoBack: Boolean(payload.canGoBack), canGoForward: Boolean(payload.canGoForward), loading: Boolean(payload.loading), zoom: Number.isFinite(Number(payload.zoom)) ? Math.round(Number(payload.zoom)) : state.browserNav.zoom };
      updateBrowserNavigation(state.browserNav);
      const productTab = tab.kind === 'detail' || tab.kind === 'product';
      const pageLabel = loginPage ? loginTarget.label : platform?.label || payload.site || tab.title || '官方页面';
      if (productTab) { const canonicalUrl = tab.productUrl || (detail ? tab.url : state.productUrl); state.url = canonicalUrl || state.url; state.productUrl = canonicalUrl || state.productUrl; state.embeddedUrl = tab.url || state.embeddedUrl; if (canonicalUrl) $('productUrl').value = canonicalUrl; }
      else if (tab.url) {
        state.embeddedUrl = tab.url;
        if (platform) {
          state.url = tab.url;
          state.productUrl = '';
          if ($('productUrl')) $('productUrl').value = tab.url;
        }
      }
      if (usesDedicatedSiteConversation(tab)) {
        const siteKey = siteAssistantContextKey(tab);
        const targetConversationId = conversationIdForProduct(siteKey, tab);
        const hasCachedMessages = Array.isArray(tab.conversationMessages) && tab.conversationMessages.length > 0 && tab.conversationProductKey === siteKey;
        const conversationNeedsRestore = state.conversationProductKey !== siteKey || state.conversationId !== targetConversationId || (hasCachedMessages && !state.messages.length);
        const restoreAlreadyRequested = lastConversationRestoreKey === siteKey && (!lastConversationRestoreTabId || lastConversationRestoreTabId === tab.id);
        if (siteKey && conversationNeedsRestore && !restoreAlreadyRequested) void restoreConversationForProduct(siteKey, { tab, emptyMessage: `正在读取${assistantProfileForTab(tab)?.title || '当前页面'}的可见资料…`, pageContextPlaceholder: true });
      }
      const authLabel = loginPage ? `${loginTarget.label}官方登录页，请手动完成登录` : (payload.verificationMessage || `${pageLabel}官方验证页面，请手动完成验证`);
      $('surfaceStatus').textContent = verification ? authLabel : loginPage ? authLabel : (payload.loadError ? `页面加载失败：${payload.loadError}` : payload.ready === true ? (isDetailCommerceUrl(tab.url) ? `${payload.title || tab.title || '商品页'}已加载，正在自动读取基础数据…` : `${payload.title || tab.title || pageLabel}已加载`) : payload.title || `正在加载${tab.title}`);
      applyAssistantVisibility(tab);
      setSiteState(verification || loginPage ? authLabel : payload.loadError ? `${platform ? pageLabel : '商品页面'}加载失败` : payload.ready === true ? (isDetailCommerceUrl(tab.url) ? '商品页已打开，正在自动读取基础数据…' : `${pageLabel}页面已打开`) : (payload.site || `${pageLabel}页面已打开`), verification || loginPage || payload.loadError ? 'busy' : payload.ready === true && isDetailCommerceUrl(tab.url) ? 'busy' : 'ok');
      if (!verification && !loginPage && !payload.loadError && payload.ready === true) {
        rememberBrowserHistory(tab.url, payload.title || tab.title);
        if (isSiteAssistantTab(tab)) scheduleSiteAssistantContext(tab, { force: false });
        if (isSearchCommerceUrl(tab.url)) schedulePageContext(tab.url, { tabId: tab.id, force: false });
        else if (tab.id === state.activeTabId && isDetailCommerceUrl(tab.url)) {
          const productKey = productContextKey(tab.productUrl || tab.url);
          const authRetryAllowed = recoveredFromAuth && productKey && !state.autoCollectionAuthRetryKeys.has(productKey);
          if (authRetryAllowed) state.autoCollectionAuthRetryKeys.add(productKey);
          autoCollectBaseForProduct(tab.productUrl || tab.url, { retry: authRetryAllowed });
        }
      }
    }
    tab.browserNav = { ...(tab.browserNav || {}), canGoBack: Boolean(payload.canGoBack), canGoForward: Boolean(payload.canGoForward), loading: Boolean(payload.loading), zoom: Number.isFinite(Number(payload.zoom)) ? Math.round(Number(payload.zoom)) : (tab.browserNav?.zoom || 100) };
    syncCommerceLoadingState(tab);
    updateQuickActions();
    renderCommerceTabs();
    return true;
  }
  async function syncDesktopSurfaceState(attempt = 0) {
    const shell = shellApi();
    if (!shell?.getDesktopStatus) return;
    try {
      const status = await shell.getDesktopStatus();
      const url = safeCommerceUrl(status?.url || '');
      if (!url && !status?.tabId) return;
      const payload = { ...status, url, ready: Boolean(status.ready), visible: status.visible !== false };
      updateCommerceTabFromSurface(payload);
      if (isDetailCommerceUrl(url) && !payload.ready && attempt < 8) {
        clearTimeout(state.surfaceSyncTimer);
        state.surfaceSyncTimer = setTimeout(() => syncDesktopSurfaceState(attempt + 1), 350);
      }
    } catch {}
  }
    function updateActiveCommerceTabTitle(title) { const tab = activeCommerceTab(); if (tab?.kind === 'detail' && /^(淘宝|天猫|1688|商品页)$/i.test(String(title || '').trim())) return; updateCommerceTabFromSurface({ title }); }
  function emitBounds() {
    const surface = $('commerceBrowserSurface'); if (!surface) return;
    const rect = surface.getBoundingClientRect();
    let x = rect.left; let y = rect.top;
    // 商品分析台通常运行在小美画布的 iframe 中。WebContentsView 属于顶层窗口，
    // 因此需要把 iframe 在外层画布中的偏移加回去，避免内嵌淘宝盖住左侧导航或问问小美。
    try {
      if (window.top !== window && window.frameElement) {
        const frameRect = window.frameElement.getBoundingClientRect();
        x += frameRect.left; y += frameRect.top;
      }
    } catch {}
    const bounds = { x, y, width: rect.width, height: rect.height };
    const shell = shellApi();
    if (shell?.setProductBounds) shell.setProductBounds(bounds, state.activeTabId); else postParent({ type:'commerce-surface-bounds', bounds });
  }
  function currentResult() { return state.result || state.job?.result || null; }
  function resourceObservedCount(result, id) {
    const product = result?.product || {};
    const sku = result?.sku || {};
    const detailImages = result?.detail?.images || result?.detailImages || [];
    const skuItems = (Array.isArray(sku.items) ? sku.items : []).filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const id = String(item.id || item.skuId || item.sku_id || '').trim();
      const path = String(item.propPath || item.prop_path || item.propertyPath || '').trim();
      const specs = Array.isArray(item.specs) ? item.specs.some((spec) => spec && (spec.value || spec.name)) : String(item.specs || item.specText || '').trim();
      return Boolean(id && (path || specs));
    });
    const skuImageUrls = new Set();
    [...skuItems, ...(Array.isArray(sku.specs) ? sku.specs : []).flatMap((spec) => Array.isArray(spec?.values) ? spec.values : [])].forEach((entry) => {
      const url = entry && typeof entry === 'object' ? String(entry.image || entry.imageUrl || entry.pic || '').trim() : '';
      if (url) skuImageUrls.add(url);
    });
    const skuImageCount = skuImageUrls.size;
    const people = result?.peopleStructure || result?.audience || result?.people || {};
    const peopleItems = Array.isArray(people)
      ? people
      : Array.isArray(people?.items)
        ? people.items
        : Array.isArray(people?.groups)
          ? people.groups.flatMap((group) => Array.isArray(group?.rows) ? group.rows : [])
          : people?.rawRows?.length ? [{ rawRows: people.rawRows }] : (people && typeof people === 'object' && Object.keys(people).length ? [people] : []);
    return {
      product: product.title || product.description ? 1 : 0,
      videos: Array.isArray(result?.videos) ? result.videos.length : 0,
      images: (result?.mainImages || result?.images || []).length,
      detail: Array.isArray(detailImages) ? detailImages.length : 0,
      detail_more: Array.isArray(detailImages) ? detailImages.length : 0,
      sku_images: skuImageCount,
      sku_list: skuItems.length,
      reviews: Array.isArray(result?.reviews) ? result.reviews.length : 0,
      questions: Array.isArray(result?.questions) ? result.questions.length : 0,
      operations: Array.isArray(result?.operations?.items) ? result.operations.items.length : 0,
      people: peopleItems.length,
    }[id] || 0;
  }
  function resourceCountRank(value) {
    const match = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }
  function resourceCountValue(result, id, item = {}) {
    const moduleId = id === 'detail_more' ? 'detail' : id === 'sku_images' || id === 'sku_list' ? 'sku' : id;
    const moduleState = result?.moduleStatus?.[moduleId] || {};
    const exactResource = Array.isArray(result?.resources) ? result.resources.find((entry) => entry?.id === id) : null;
    const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';
    const product = result?.product || {};
    const sku = result?.sku || {};
    const firstPresent = (...values) => values.find(hasValue);
    const countFallback = id === 'reviews'
      ? firstPresent(product.reviewCount, result?.reviewStats?.pageTotalCount, moduleState.pageTotalCount, result?.reviewStats?.totalCount, result?.metrics?.reviewCount)
      : id === 'questions'
        ? firstPresent(product.questionCount, result?.questionStats?.pageTotalCount, moduleState.pageTotalCount, result?.questionStats?.totalCount, result?.metrics?.questionCount)
        : undefined;
    // 详情模块的数量还可能包含正文和分段证据；详情媒体只能按真实图片
    // 数组计数，不能使用 moduleStatus.detail.sampleCount 兜底。
    if (id === 'detail' || id === 'detail_more') {
      const observed = resourceObservedCount(result, id);
      return observed > 0 ? observed : '';
    }
    // SKU 图是 SKU 模块的子资源，不能拿 SKU 列表/规格组数量兜底；否则没有图片
    // 时也会把一个当前 SKU 误显示成“SKU 图 ×1”。
    if (id === 'sku_images') {
      return firstPresent(exactResource?.totalCount, exactResource?.sampleCount, sku.specImageCount, resourceObservedCount(result, id)) || '';
    }
    if (id === 'sku_list') {
      return firstPresent(exactResource?.totalCount, moduleState.totalCount, sku.totalCount, product.skuCount, exactResource?.sampleCount, resourceObservedCount(result, id)) || '';
    }
    // 商品页上的“累计评价/问大家”数量是用户实际看到的口径；接口响应里的
    // totalCount 有时只是当前分页或当前筛选的数量，不能覆盖商品页数量。
    const explicitTotal = ['reviews', 'questions'].includes(id)
      ? [countFallback, item.pageTotalCount, moduleState.pageTotalCount, item.totalCount, moduleState.totalCount].find(hasValue)
      : [item.totalCount, moduleState.totalCount, countFallback].find(hasValue);
    if (explicitTotal !== undefined) return explicitTotal;
    const explicit = [item.sampleCount, moduleState.sampleCount].find((value) => hasValue(value) && String(value).trim() !== '0');
    if (explicit !== undefined) return explicit;
    const observed = resourceObservedCount(result, id);
    const candidates = [observed].filter((value) => value !== null && value !== undefined && String(value).trim() !== '' && String(value).trim() !== '0');
    if (!candidates.length) return '';
    return candidates.sort((a, b) => resourceCountRank(b) - resourceCountRank(a))[0];
  }
  function resourceItems(result = currentResult()) {
    if (!result) return [];
    const existing = new Map((Array.isArray(result.resources) ? result.resources : []).filter((item) => item && item.id).map((item) => [item.id, item]));
    const status = result.moduleStatus || {};
    const product = result.product || {};
    const sku = result.sku || {};
    const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';
    const firstPresent = (...values) => values.find(hasValue);
    return resourceOrder.map((id) => {
      const sourceId = id === 'detail_more' ? 'detail' : id === 'sku_images' ? 'sku' : id;
      const hasExactResource = existing.has(id);
      const source = existing.get(id) || existing.get(sourceId) || {};
      const observedCount = resourceObservedCount(result, id);
      const count = resourceCountValue(result, id, source);
      const moduleState = status[id === 'sku_list' || id === 'sku_images' || id === 'detail_more' ? (id === 'detail_more' ? 'detail' : 'sku') : id] || {};
      const liveProgress = ['reviews', 'questions'].includes(id) ? collectionProgress.get(id) : null;
      const skuImageSampleCount = id === 'sku_images'
        ? (observedCount > 0 ? observedCount : (hasExactResource ? Number(source.sampleCount || 0) : 0))
        : null;
      const skuListSampleCount = id === 'sku_list' && hasExactResource ? Number(source.sampleCount || 0) : null;
      const isDetailMedia = id === 'detail' || id === 'detail_more';
      const sampleCount = isDetailMedia
        ? observedCount
        : skuListSampleCount !== null
        ? skuListSampleCount
        : skuImageSampleCount !== null
          ? skuImageSampleCount
          : (observedCount || source.sampleCount || moduleState.sampleCount || 0);
      const displayedSampleCount = liveProgress && Number.isFinite(Number(liveProgress.sampleCount))
        ? Number(liveProgress.sampleCount)
        : sampleCount;
      const pageTotalCount = id === 'reviews'
        ? firstPresent(liveProgress?.totalCount, product.reviewCount, result?.reviewStats?.pageTotalCount, moduleState.pageTotalCount)
        : id === 'questions'
          ? firstPresent(liveProgress?.totalCount, product.questionCount, result?.questionStats?.pageTotalCount, moduleState.pageTotalCount)
          : undefined;
      const totalCount = isDetailMedia
        ? (sampleCount || null)
        : id === 'sku_images'
        ? (hasExactResource ? (source.totalCount ?? (sampleCount || null)) : (hasValue(sku?.specImageCount) ? sku.specImageCount : (sampleCount || null)))
        : id === 'sku_list' && hasExactResource
          ? (source.totalCount ?? (sampleCount || null))
        : ['reviews', 'questions'].includes(id)
          ? (hasValue(pageTotalCount) ? pageTotalCount : (hasValue(source.pageTotalCount) ? source.pageTotalCount : (hasValue(source.totalCount) ? source.totalCount : (hasValue(moduleState.totalCount) ? moduleState.totalCount : (hasValue(count) ? count : null)))))
        : (hasValue(source.totalCount) ? source.totalCount : hasValue(moduleState.totalCount) ? moduleState.totalCount : (hasValue(count) ? count : null));
      let operationStatus = liveProgress ? 'running' : ['operations', 'people'].includes(id) && count ? 'ready' : source.status || moduleState.status || (count ? 'ready' : 'missing');
      const totalRank = resourceCountRank(totalCount);
      if (isDetailMedia && !sampleCount) operationStatus = 'missing';
      if (id === 'sku_images' && !sampleCount) operationStatus = 'missing';
      if (id === 'sku_list') {
        if (totalRank && Number(sampleCount || 0) < totalRank) operationStatus = 'partial';
        else if (!sampleCount) operationStatus = 'missing';
      }
      const skuListComplete = id !== 'sku_list' || !totalRank || Number(sampleCount || 0) >= totalRank;
      return {
        ...source,
        id,
        title: resourceLabels[id],
        kind: id,
        status: operationStatus,
        sampleCount: displayedSampleCount,
        realResponseSampleCount: liveProgress ? displayedSampleCount : source.realResponseSampleCount ?? moduleState.realResponseSampleCount ?? (['reviews', 'questions'].includes(id) ? observedCount : 0),
        responseCount: source.responseCount ?? moduleState.responseCount ?? 0,
        totalCount,
        matrixComplete: source.matrixComplete ?? moduleState.matrixComplete ?? (id === 'sku_list' ? skuListComplete : null),
        displayCount: id === 'product' ? '' : (hasValue(totalCount) ? totalCount : hasValue(count) ? count : sampleCount),
        downloadId: existing.has(id) ? id : sourceId,
        downloadable: Boolean(displayedSampleCount && ['ready', 'partial', 'captured', 'stopped'].includes(operationStatus) && skuListComplete),
        reason: source.reason || moduleState.reason || '',
         sourceStepIds: source.sourceStepIds?.length ? source.sourceStepIds : moduleState.sourceStepIds || [],
         sourceSteps: source.sourceSteps?.length ? source.sourceSteps : moduleState.sourceSteps || [],
         evidenceIds: source.evidenceIds?.length ? source.evidenceIds : moduleState.evidenceIds || [],
        productId: source.productId || result.productId || result.product?.id || '',
        normalizedUrl: source.normalizedUrl || result.normalizedUrl || '',
        collectedAt: source.collectedAt || result.collectedAt || result.collection?.collectedAt || '',
      };
    });
  }
  function resourceDownloadUrl(resource) {
    const item = typeof resource === 'string' ? { id: resource, downloadId: resource } : (resource || {});
    const isMedia = mediaResourceIds.has(String(item.id || '').trim());
    const resourceId = isMedia ? item.id : item.downloadId || item.id;
    const suffix = isMedia ? '/media' : '';
    return state.jobId && resourceId ? `/api/commerce-analysis/jobs/${encodeURIComponent(state.jobId)}/resources/${encodeURIComponent(resourceId)}${suffix}` : '';
  }
  function resourcePreviewUrl(resource) {
    const item = typeof resource === 'string' ? { id: resource, downloadId: resource } : (resource || {});
    if (String(item.id || '').trim() !== 'detail') return '';
    const url = resourceDownloadUrl(item);
    // 版本参数让已打开过旧错误长图的 Chromium 不继续复用旧缓存。
     return url ? `${url}${url.includes('?') ? '&' : '?'}preview=1&v=20260829-detail-v9` : '';
  }
  function detailLongPreviewFilename(item = {}) {
    const result = currentResult() || {};
    const product = result.product || {};
    const productId = String(item.productId || result.productId || product.id || '').trim();
    return productId ? `详情页_${productId}.png` : '详情页长图.png';
  }
  let detailLongPreviewFocus = null;
  let detailLongPreviewRequest = 0;
  const DETAIL_LONG_PREVIEW_ZOOM_MIN = 50;
  const DETAIL_LONG_PREVIEW_ZOOM_MAX = 300;
  const DETAIL_LONG_PREVIEW_ZOOM_STEP = 10;
  let detailLongPreviewZoom = 100;
  function detailLongPreviewBaseWidth() {
    const body = $('detailLongPreviewBody');
    if (!body) return 900;
    return Math.max(1, Math.min(body.clientWidth || 900, 900));
  }
  function updateDetailLongPreviewZoomUi() {
    const value = $('detailLongPreviewZoomReset');
    const zoomOut = $('detailLongPreviewZoomOut');
    const zoomIn = $('detailLongPreviewZoomIn');
    if (value) {
      value.textContent = `${detailLongPreviewZoom}%`;
      value.setAttribute('aria-label', `当前缩放比例 ${detailLongPreviewZoom}%，点击重置为100%`);
    }
    if (zoomOut) zoomOut.disabled = detailLongPreviewZoom <= DETAIL_LONG_PREVIEW_ZOOM_MIN;
    if (zoomIn) zoomIn.disabled = detailLongPreviewZoom >= DETAIL_LONG_PREVIEW_ZOOM_MAX;
  }
  function applyDetailLongPreviewZoom() {
    const image = $('detailLongPreviewImage');
    if (!image) return;
    const width = Math.max(1, Math.round(detailLongPreviewBaseWidth() * detailLongPreviewZoom / 100));
    image.style.width = `${width}px`;
    image.style.maxWidth = 'none';
    image.classList.toggle('is-zoomed', detailLongPreviewZoom !== 100);
    updateDetailLongPreviewZoomUi();
  }
  function setDetailLongPreviewZoom(nextZoom) {
    const numeric = Number(nextZoom);
    if (!Number.isFinite(numeric)) return;
    const stepped = Math.round(numeric / DETAIL_LONG_PREVIEW_ZOOM_STEP) * DETAIL_LONG_PREVIEW_ZOOM_STEP;
    detailLongPreviewZoom = Math.min(DETAIL_LONG_PREVIEW_ZOOM_MAX, Math.max(DETAIL_LONG_PREVIEW_ZOOM_MIN, stepped));
    applyDetailLongPreviewZoom();
  }
  function closeDetailLongPreview() {
    const modal = $('detailLongPreview');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    setCommerceNativeOverlayActive(false);
    document.body.classList.remove('detail-long-preview-open');
    detailLongPreviewRequest += 1;
    const image = $('detailLongPreviewImage');
    if (image) {
      image.removeAttribute('src'); image.hidden = true;
      image.style.removeProperty('width'); image.style.removeProperty('max-width');
      image.classList.remove('is-zoomed');
    }
    detailLongPreviewZoom = 100;
    updateDetailLongPreviewZoomUi();
    const loading = $('detailLongPreviewLoading'); if (loading) loading.hidden = false;
    const error = $('detailLongPreviewError'); if (error) error.hidden = true;
    const focus = detailLongPreviewFocus;
    detailLongPreviewFocus = null;
    if (focus && typeof focus.focus === 'function' && document.contains(focus)) focus.focus();
  }
  async function openDetailLongPreview(item) {
    const modal = $('detailLongPreview');
    if (!modal) return;
    const result = currentResult() || {};
    const detailReveal = result.collection?.pageStateSignals?.detailReveal;
    // 旧任务保存的是污染过的 DOM 图片列表，没有 detailReveal 证据。桌面
    // 版本支持时先补采一次详情模块，避免用户只能看到旧的错误长图。
    const resultSource = String(result.source || result.collection?.source || '').toLowerCase();
    if (shellApi()?.captureProduct && (resultSource === 'electron' || resultSource.includes('electron-dabi-network')) && !detailReveal) {
      toast('正在重新读取详情页图文，请稍候…');
      const refreshed = await requestResourceCollection('detail');
      if (!refreshed?.resources) return;
      item = resourceItems(currentResult()).find((entry) => entry.id === 'detail') || item;
    }
    const url = resourcePreviewUrl(item);
    if (!url) return toast('详情页长图当前没有可预览内容');
    detailLongPreviewFocus = document.activeElement;
    const filename = detailLongPreviewFilename(item);
    const image = $('detailLongPreviewImage');
    const loading = $('detailLongPreviewLoading');
    const error = $('detailLongPreviewError');
    const body = $('detailLongPreviewBody');
    const title = $('detailLongPreviewTitle');
    const meta = $('detailLongPreviewMeta');
    const download = $('detailLongPreviewDownload');
    if (title) title.textContent = filename;
    if (meta) meta.textContent = `${resourceCount(item) || '详情页长图'} · 可滚动预览 · 可缩放`;
    if (download) { download.href = resourceDownloadUrl(item); download.download = filename; }
    if (image) { image.hidden = true; image.removeAttribute('src'); }
    if (loading) loading.hidden = false;
    if (error) error.hidden = true;
    if (body) { body.scrollTop = 0; body.scrollLeft = 0; }
    setCommerceNativeOverlayActive(true);
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('detail-long-preview-open');
    setDetailLongPreviewZoom(100);
    $('detailLongPreviewClose')?.focus();
    const requestId = ++detailLongPreviewRequest;
    if (image) {
      image.dataset.previewRequest = String(requestId);
      image.decoding = 'async';
      image.loading = 'eager';
      image.src = url;
    }
  }
  function resourceDownloadLabel(item) {
    if (mediaResourceIds.has(String(item?.id || '').trim())) return ({ detail: '下载长图', detail_more: '下载详情多图', images: '下载主图', sku_images: '下载 SKU 图', videos: '下载视频' })[item.id] || '下载媒体';
    if (item?.id === 'people') return '下载人群结构数据';
    return '下载 CSV';
  }
  function resourceStatusLabel(item) { const labels = { ready: '已准备', partial: '部分返回', captured: '已捕获', running: '采集中', missing: '未返回', failed: '采集失败', login_required: '需登录', verification_required: '需验证', deferred: '仅有页面计数', not_requested: '本次未请求', stopped: '已停止' }; return labels[item.status] || text(item.status, '未返回'); }
  function resourcePendingLabel(item) {
    const id = String(item?.id || '');
    const status = String(item?.status || '').toLowerCase();
    if (status === 'deferred' && ['reviews', 'questions'].includes(id)) return '点击采集正文';
    if (status === 'running') return '采集中…';
    if (status === 'login_required' || status === 'verification_required') return '需登录/验证';
    if (status === 'failed') return '采集失败，点击重试';
    if (status === 'stopped') return '已停止，点击继续';
    if (status === 'partial') return '部分返回';
    if (id === 'videos' && status === 'missing' && !item?.pending) return '暂无视频，可点击重试';
    if (id === 'operations' || id === 'people') return '打开报表采集';
    return item?.pending ? '自动读取中' : '点击采集';
  }
  function resourceStateClass(item) {
    const status = String(item?.status || '').toLowerCase();
    if (status === 'deferred') return 'is-deferred';
    if (status === 'running') return 'is-running';
    if (status === 'failed' || status === 'login_required' || status === 'verification_required') return 'is-error';
    if (status === 'partial') return 'is-partial';
    if (status === 'missing') return 'is-missing';
    return '';
  }
  function resourceCount(item) {
    const id = String(item?.id || '');
    if (['reviews', 'questions'].includes(id)) {
      const total = String(item.totalCount ?? '').trim();
      const sample = String(item.realResponseSampleCount ?? item.sampleCount ?? '').trim();
      if (total) return `总量 ${total} · 真实样本 ${sample || '0'}`;
      if (sample && sample !== '0') return `真实样本 ${sample}`;
      return '';
    }
    const value = item.displayCount ?? item.sampleCount ?? item.totalCount ?? '';
    const label = String(value ?? '').trim(); if (!label || label === '0') return ''; return `×${label}`;
  }
  function resourceCollectionModule(resourceId) {
    const id = String(resourceId || '').trim();
    if (id === 'product') return BASE_COLLECTION_MODULE;
    if (id === 'detail_more') return 'detail';
    if (id === 'sku_images' || id === 'sku_list') return 'sku';
    if (id === 'people') return 'people';
    if (['reviews', 'questions', 'images', 'detail', 'videos', 'operations', 'sku'].includes(id)) return id;
    return '';
  }
  function pendingResourceItems() {
    if (!isDetailCommerceUrl(activeProductUrl()) && !isDetailCommerceUrl(state.productUrl)) return [];
    return resourceOrder.map((id) => ({
      id,
      title: resourceLabels[id],
      kind: id,
      status: 'missing',
      sampleCount: 0,
      totalCount: null,
      displayCount: '',
      downloadable: false,
      pending: true,
        reason: ['reviews', 'questions'].includes(id) ? `页面数量可见，点击后采集${resourceLabels[id]}正文` : '商品页打开后会自动读取基础数据，完成后可引用该资源',
     }));
  }
  function resourceSelectionKey(result = currentResult()) { return result ? String(state.jobId || result.jobId || productContextKey(resultSourceUrl(result)) || 'current') : ''; }
  function ensureResourceSelection(result = currentResult()) {
    const key = resourceSelectionKey(result);
    if (!key) { state.selectedResourceIds = new Set(); state.resourceSelectionProductKey = ''; return; }
    if (state.resourceSelectionProductKey !== key) {
      state.resourceSelectionProductKey = key;
      // 资源勾选只属于当前消息；没有明确选择时，不把商品快照默认带入对话。
      state.selectedResourceIds = new Set();
    }
  }
  function updateContextChip() {
    const chip = $('contextChip'); if (!chip) return;
    const siteView = activeSiteAssistantView();
    if (isSiteAssistantTab()) {
      const profile = siteView?.profile || assistantProfileForTab();
      const resources = Array.isArray(siteView?.resources) ? siteView.resources : [];
      chip.textContent = resources[0]?.token || '当前页面';
      chip.title = resources.map((entry) => entry.label || entry.token).join('、') || `${profile?.title || '当前页面'}可见资料`;
      return;
    }
    const selected = [...state.selectedResourceIds];
    if (!selected.length && isSearchCommerceUrl(activeProductUrl()) && state.pageContext) {
      chip.textContent = '搜索结果'; chip.title = '当前搜索结果页'; return;
    }
    chip.textContent = selected.length <= 1 && selected[0] === 'product' ? '当前商品' : selected.length ? `已选 ${selected.length} 项资源` : '未选择资源';
    chip.title = selected.length ? selected.map((id) => resourceLabels[id] || id).join('、') : '点击 + 选择电脑文件';
  }
  function chatAttachmentName(ref, index = 0) {
    const fallback = `附件${Number(index) + 1}`;
    return String(ref?.name || ref?.filename || fallback).trim() || fallback;
  }
  function chatAttachmentBadge(name) {
    const match = String(name || '').trim().match(/\.([^.]+)$/);
    return (match?.[1] || '文件').slice(0, 4).toUpperCase();
  }
  function isChatImageReference(ref) {
    const kind = String(ref?.kind || '').trim().toLowerCase();
    const mime = String(ref?.mime || ref?.mimeType || '').trim().toLowerCase();
    const url = String(ref?.url || '').trim();
    return kind === 'image'
      || mime.startsWith('image/')
      || url.startsWith('data:image/')
      || /\.(png|jpe?g|webp|gif|bmp|tiff?)(?:[?#]|$)/i.test(url);
  }
  function renderChatAttachments() {
    const strip = $('chatAttachments');
    if (!strip) return;
    const refs = Array.isArray(state.chatAttachments) ? state.chatAttachments : [];
    strip.hidden = !refs.length;
    strip.innerHTML = refs.map((ref, index) => {
      const url = String(ref?.url || '').trim();
      if (!url) return '';
      const name = chatAttachmentName(ref, index);
      const isImage = isChatImageReference(ref);
      const preview = isImage
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`
        : `<span class="chat-attachment-file-icon" aria-hidden="true">${escapeHtml(chatAttachmentBadge(name))}</span>`;
      return `<div class="chat-attachment-chip ${isImage ? 'is-image' : 'is-file'}">${preview}<span title="${escapeHtml(name)}">${escapeHtml(name)}</span><button class="chat-attachment-remove" type="button" data-remove-chat-attachment="${index}" aria-label="移除${escapeHtml(name)}">×</button></div>`;
    }).join('');
    q('[data-remove-chat-attachment]', strip).forEach((button) => {
      button.onclick = () => {
        const index = Number(button.dataset.removeChatAttachment);
        if (!Number.isInteger(index) || index < 0) return;
        state.chatAttachments.splice(index, 1);
        renderChatAttachments();
      };
    });
  }
  function clearChatAttachments() {
    state.chatAttachmentUploadSerial += 1;
    state.chatAttachments = [];
    state.chatAttachmentsUploading = false;
    renderChatAttachments();
  }
  function isChatImageFile(file) {
    if (!file) return false;
    const type = String(file.type || '').trim().toLowerCase();
    const name = String(file.name || '').trim();
    return type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
  }
  async function uploadChatAttachments(fileList) {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return;
    if (state.chatAttachmentsUploading) return toast('附件正在上传，请稍候');
    const available = Math.max(0, CHAT_ATTACHMENT_MAX - state.chatAttachments.length);
    if (!available) return toast(`最多添加 ${CHAT_ATTACHMENT_MAX} 张图片`);
    const selectedFiles = files.slice(0, available);
    const uploadSerial = state.chatAttachmentUploadSerial + 1;
    state.chatAttachmentUploadSerial = uploadSerial;
    state.chatAttachmentsUploading = true;
    try {
      const form = new FormData();
      selectedFiles.forEach((file, index) => form.append('files', file, file.name || `粘贴图片-${Date.now()}-${index + 1}.png`));
      const response = await fetch('/api/ai/upload', { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.message || `上传失败（${response.status}）`);
      if (state.chatAttachmentUploadSerial !== uploadSerial) return;
      const uploaded = (Array.isArray(data.files) ? data.files : []).filter((ref) => ref?.url);
      if (!uploaded.length) throw new Error('服务器没有返回可用的附件');
      state.chatAttachments.push(...uploaded);
      renderChatAttachments();
      const suffix = files.length > selectedFiles.length ? `，最多保留 ${CHAT_ATTACHMENT_MAX} 张` : '';
      toast(`${uploaded.length} 个附件已添加，请继续输入问题${suffix}`);
    } catch (error) {
      if (state.chatAttachmentUploadSerial === uploadSerial) toast(`附件上传失败：${error.message || '请重试'}`);
    } finally {
      if (state.chatAttachmentUploadSerial === uploadSerial) state.chatAttachmentsUploading = false;
    }
  }
  function handleChatPaste(event) {
    const input = $('chatInput');
    if (!input || event.target !== input) return;
    const itemFiles = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    const files = [...new Set([...itemFiles, ...(event.clipboardData?.files || [])])].filter(isChatImageFile);
    if (!files.length) return;
    event.preventDefault();
    void uploadChatAttachments(files);
  }
  function appendResourceMention(item) {
    const input = $('chatInput'); if (!input || !item) return;
    const mention = `@${item.title}`;
    const prefix = input.value.trim(); input.value = `${prefix ? `${prefix} ` : ''}${mention} `; input.focus();
  }
  function toggleResourceSelection(resourceId, options = {}) {
    const item = resourceItems(currentResult()).find((entry) => entry.id === resourceId);
    if (!item) return;
    if (!item.downloadable && resourceId !== 'product') return toast(`${item.title}当前没有可引用内容`);
    if (state.selectedResourceIds.has(resourceId)) state.selectedResourceIds.delete(resourceId);
    else state.selectedResourceIds.add(resourceId);
    if (options.mention !== false) appendResourceMention(item);
    renderResources(); renderResourcePicker(); updateContextChip();
  }
  function setSelectedResourceIds(resourceIds = [], options = {}) {
    const available = new Set(resourceItems(currentResult()).filter((item) => item.downloadable || item.id === 'product').map((item) => item.id));
    state.selectedResourceIds = new Set(resourceIds.filter((id) => available.has(id)));
    if (options.mention) {
      const names = [...state.selectedResourceIds].map((id) => resourceLabels[id] || id);
      if (names.length) appendResourceMention({ title: names.join('、') });
    }
    renderResources(); renderResourcePicker(); updateContextChip();
  }
  function clearResourceSelection(options = {}) {
    state.selectedResourceIds = new Set();
    if (options.resetKey) state.resourceSelectionProductKey = '';
    if (options.render !== false) {
      renderResources(); renderResourcePicker(); updateContextChip();
    }
    if (options.remember !== false) rememberProductAnalysisForTab();
  }
  async function requestResourceCollection(resourceId) {
    const module = resourceCollectionModule(resourceId);
    if (!module) return toast('请先打开商品页，再点击资源卡选择采集内容');
    if (state.analysisStarting || ['queued', 'running'].includes(state.job?.status)) return toast('桌面智能体正在操作，请耐心等待完成');
    if (!guardCurrentJob()) return;
    if (module === 'operations' || module === 'people') return quickAction(module);
    const shell = shellApi();
    if (shell?.captureProduct) {
      return startAnalysis(false, module);
    }
    return state.jobId ? retryModule(module) : startAnalysis(false, module);
  }
  function renderResourcePicker() {
    const list = $('resourcePickerList'); if (!list) return;
    const items = resourceItems(currentResult());
    list.innerHTML = items.length ? items.map((item) => {
      const selected = state.selectedResourceIds.has(item.id); const disabled = !item.downloadable && item.id !== 'product';
      return `<button class="resource-picker-option ${selected ? 'is-selected' : ''}" type="button" data-resource-picker-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''}><span class="resource-picker-icon">${escapeHtml(resourceIcons[item.id] || '·')}</span><span>${escapeHtml(item.title)}</span><small>${escapeHtml(resourceCount(item) || (disabled ? resourceStatusLabel(item) : '可引用'))}</small><b>${selected ? '✓' : '+'}</b></button>`;
    }).join('') : '<div class="resource-picker-empty">先完成商品采集，这里会出现可引用资源。</div>';
    q('[data-resource-picker-id]', list).forEach((button) => { button.onclick = () => toggleResourceSelection(button.dataset.resourcePickerId); });
  }
  function renderResources(result = currentResult()) {
    const list = $('resourceList'); if (!list) return;
    if (!result) {
      const pending = pendingResourceItems();
      if (!pending.length) { list.innerHTML = ''; updateContextChip(); renderResourcePicker(); return; }
       list.innerHTML = `<div class="resource-heading"><strong>商品页资源</strong><span>正在自动读取商品基础信息；评价和问大家正文按需采集</span></div><div class="resource-grid">${pending.map((item) => { const deferred = ['reviews', 'questions'].includes(item.id); return `<div class="resource-card is-missing is-pending ${deferred ? 'is-deferred' : 'is-running'}"><button class="resource-card-main" type="button" data-resource-id="${escapeHtml(item.id)}" title="${escapeHtml(item.reason)}"><span class="resource-icon">${escapeHtml(resourceIcons[item.id] || '·')}</span><span class="resource-copy"><span class="resource-title">${escapeHtml(item.title)}</span><span class="resource-count">${deferred ? '点击采集正文' : '自动读取中'}</span></span></button><span class="resource-actions"><span class="resource-trigger" title="${escapeHtml(deferred ? '点击采集正文' : '基础数据正在自动读取')}">${deferred ? '▶' : '…'}</span></span></div>`; }).join('')}</div>`;
      q('[data-resource-id]', list).forEach((button) => { button.onclick = () => requestResourceCollection(button.dataset.resourceId); });
      updateContextChip(); renderResourcePicker(); return;
    }
    ensureResourceSelection(result);
    const items = resourceItems(result);
    const cards = items.map((item) => {
      const ready = Boolean(item.downloadable && resourceDownloadUrl(item));
      const selected = state.selectedResourceIds.has(item.id);
      const isDetailPreview = item.id === 'detail' && ready;
      const previewAction = `<button class="resource-preview" type="button" data-preview-resource-id="${escapeHtml(item.id)}" aria-label="预览详情页长图" title="详情页长图已下载，点击预览">◉</button>`;
       const downloadAction = `<a class="resource-download" href="${escapeHtml(resourceDownloadUrl(item))}" download title="${escapeHtml(resourceDownloadLabel(item))}">⇩</a>`;
       const action = ready ? `<span class="resource-actions">${selected ? '<span class="resource-selected" title="已选为对话上下文">✓</span>' : ''}${isDetailPreview ? previewAction : ''}${downloadAction}</span>` : selected ? '<span class="resource-actions"><span class="resource-selected" title="已选为对话上下文">✓</span></span>' : '<span class="resource-actions"><span class="resource-download is-disabled" title="当前没有可下载内容">⇩</span></span>';
       const status = resourceStateClass(item);
       const pendingLabel = resourcePendingLabel(item);
       const clickableTitle = isDetailPreview ? '详情页长图已下载，点击预览' : ready ? `选择${item.title}作为对话上下文` : `${pendingLabel}：${item.title}`;
      const visibleAction = ready ? action : `<span class="resource-actions"><span class="resource-trigger" title="${escapeHtml(clickableTitle)}">▶</span></span>`;
      const sourceLabel = item.sourceStepIds?.length ? `来源 ${item.sourceStepIds.slice(0, 2).join('、')}` : item.source ? `来源 ${item.source}` : '';
      const pressed = item.id === 'detail' ? '' : `aria-pressed="${selected}"`;
       return `<div class="resource-card ${item.id !== 'detail' && selected ? 'is-selected' : ''} ${status}"><button class="resource-card-main" type="button" data-resource-id="${escapeHtml(item.id)}" ${pressed} title="${escapeHtml(`${clickableTitle}${item.reason ? `；${item.reason}` : ''}`)}"><span class="resource-icon">${escapeHtml(resourceIcons[item.id] || '·')}</span><span class="resource-copy"><span class="resource-title">${escapeHtml(item.title)}</span><span class="resource-count">${escapeHtml(resourceCount(item) || (ready ? resourceStatusLabel(item) : pendingLabel))}</span>${sourceLabel ? `<span class="resource-audit-source">${escapeHtml(sourceLabel)}</span>` : ''}</span></button>${visibleAction}</div>`;
    }).join('');
     const authNotice = resultNeedsAuth(result)
       ? '<div class="resource-auth-notice" role="status"><div><strong>当前商品页需要登录/验证</strong><span>已识别商品 ID，但平台没有返回可采集字段；完成官方登录/验证后会自动重试。</span></div><button type="button" data-resource-auth>打开登录/验证</button></div>'
       : '';
     list.innerHTML = `${authNotice}<div class="resource-grid">${cards}</div>`;
     q('[data-resource-auth]', list).forEach((button) => { button.onclick = () => login(); });
    q('[data-preview-resource-id]', list).forEach((button) => {
      button.onclick = (event) => {
        event.preventDefault(); event.stopPropagation();
        const item = resourceItems(currentResult()).find((entry) => entry.id === button.dataset.previewResourceId);
        if (item) openDetailLongPreview(item);
      };
    });
    q('[data-resource-id]', list).forEach((button) => {
      button.onclick = () => {
        const item = resourceItems(currentResult()).find((entry) => entry.id === button.dataset.resourceId);
        if (item?.id === 'detail' && item.downloadable && resourcePreviewUrl(item)) openDetailLongPreview(item);
        else if (item?.downloadable && resourceDownloadUrl(item)) toggleResourceSelection(button.dataset.resourceId);
        else requestResourceCollection(button.dataset.resourceId);
      };
    });
    renderResourcePicker(); updateContextChip();
  }
  function resourceStatValue(result, id, fallback = '') {
    const item = resourceItems(result).find((entry) => entry.id === id);
    const product = result?.product || {};
    const pageCount = id === 'reviews' ? product.reviewCount : id === 'questions' ? product.questionCount : '';
    const values = ['reviews', 'questions'].includes(id)
      ? [pageCount, item?.totalCount, item?.sampleCount, fallback]
      : [item?.totalCount, item?.sampleCount, fallback];
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (normalized && normalized !== '0' && normalized !== '×0') return normalized.replace(/^×/, '');
    }
    return '';
  }
  const AUTH_REQUIRED_STATUSES = new Set(['login_required', 'verification_required', 'needs_login']);
  function isAuthRequiredStatus(value) {
    return AUTH_REQUIRED_STATUSES.has(String(value || '').trim().toLowerCase());
  }
  function resultNeedsAuth(result = {}) {
    if (!result || typeof result !== 'object') return false;
    const moduleStatuses = result.moduleStatus && typeof result.moduleStatus === 'object' ? Object.values(result.moduleStatus) : [];
    const resourceStatuses = Array.isArray(result.resources) ? result.resources : [];
    const statuses = [
      result.status,
      result.collection?.status,
      result.product?.status,
      ...moduleStatuses.map((item) => item?.status),
      ...resourceStatuses.map((item) => item?.status),
    ];
    if (statuses.some(isAuthRequiredStatus)) return true;
    const message = [result.message, result.error, result.collection?.message, result.collection?.error]
      .filter(Boolean)
      .join(' ');
    return !resultHasProductData(result) && /登录|验证|验证码|风控|login|required|captcha|verify/i.test(message);
  }
  function resultHasProductData(result = {}) {
    const product = result.product || {};
    const imageCount = Array.isArray(result.mainImages || result.images) ? (result.mainImages || result.images).length : 0;
    return Boolean(
      String(product.title || '').trim()
      || String(product.price || product.priceRange || '').trim()
      || String(product.store || product.brand || product.category || '').trim()
      || imageCount
      || String(product.description || '').trim(),
    );
  }
  function productResultDisplayState(result = {}) {
    const hasData = resultHasProductData(result);
    const needsAuth = resultNeedsAuth(result);
    const status = String(result.status || '').trim().toLowerCase();
    const failedWithoutData = !hasData && (result.ok === false || ['failed', 'needs_login'].includes(status));
    return { hasData, needsAuth, waiting: !hasData && !needsAuth && !failedWithoutData, failedWithoutData };
  }
  function formatProductStat(value, plus = false) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';
    if (!plus || /[+＋]$/.test(normalized)) return normalized;
    const number = Number(normalized.replace(/[,，]/g, ''));
    return Number.isFinite(number) && number >= 100 ? `${normalized}+` : normalized;
  }
  function productIntroTime() {
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); } catch { return ''; }
  }
  function isLikelyProductImage(value) {
    const raw = String(value || '').trim();
    if (!raw || !/^(?:https?:|\/)/i.test(raw)) return false;
    const lower = raw.toLowerCase();
    if (/(?:\/tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\/|avatar|headimg|favicon|logo|qrcode|qr-code|recommend|guess|review|comment|(?:^|[-_/])icon(?:[-_.?/]|$)|(?:^|[-_/])rate(?:[-_.?/]|$))/i.test(lower)) return false;
    const size = lower.match(/(?:tps[-_](\d+)[x-](\d+)|-(\d{2,4})-(\d{2,4})(?:\.(?:png|jpe?g|webp))(?:[_?]|$))/i);
    if (size) {
      const width = Number(size[1] || size[3] || 0);
      const height = Number(size[2] || size[4] || 0);
      if (width && height && (width < 160 || height < 160)) return false;
    }
    return true;
  }
  function productSummaryImageUrl(result) {
    const product = result?.product || {};
    const candidates = [
      product.thumbnail, product.thumb, product.image, product.imageUrl, product.mainImage,
      ...(Array.isArray(result?.mainImages) ? result.mainImages : []),
      ...(Array.isArray(result?.images) ? result.images : []),
    ];
    return candidates.find(isLikelyProductImage) || '';
  }
  function renderProductAssistantIntro(result) {
    const box = $('chatMessages');
    if (!box || !result) return;
    const product = result.product || {};
    const metrics = result.metrics || {};
    const displayState = productResultDisplayState(result);
    const blocked = displayState.needsAuth;
     const title = text(productDisplayTitle(result), blocked ? '待登录/验证后读取' : '商品信息待返回');
    const price = text(product.priceRange || product.price || (product.minPrice && product.maxPrice ? `¥${product.minPrice} 到 ¥${product.maxPrice}` : ''), '').replace(/[～~]/g, ' 到 ');
    const sku = formatProductStat(resourceStatValue(result, 'sku_list', product.skuCount || result.sku?.totalCount || result.sku?.items?.length || result.sku?.specs?.length), false);
    const sales = formatProductStat(product.sales || product.salesCount || metrics.sales || metrics.salesSignal || '', true);
    const reviews = formatProductStat(resourceStatValue(result, 'reviews', product.reviewCount || metrics.reviewCount), true);
    const lines = [
      price ? `<p class="product-intro-stat">💰 价格从 ${escapeHtml(price)}</p>` : '',
      sku ? `<p class="product-intro-stat">🎨 一共有 ${escapeHtml(sku)} 个 SKU</p>` : '',
      sales ? `<p class="product-intro-stat">🔥 已售 ${escapeHtml(sales)}</p>` : '',
      reviews ? `<p class="product-intro-stat">⭐ 共有 ${escapeHtml(reviews)} 条评价</p>` : '',
    ].filter(Boolean).join('');
    const existing = box.querySelector('[data-product-intro]');
    const hasConversation = state.messages.some((item) => String(item?.content || '').trim());
    if (!hasConversation && !existing) box.innerHTML = '';
    const node = existing || document.createElement('div');
    node.className = 'chat-message assistant product-intro-message';
    node.dataset.productIntro = 'true';
    const lead = blocked
      ? '商品页已打开，完成登录/验证后会继续读取。'
      : displayState.hasData
        ? '已经帮你看了这个商品'
        : displayState.failedWithoutData
          ? '商品采集未返回可用字段，请完成登录/验证后重试。'
          : '商品页已打开，正在等待商品信息返回。';
    node.innerHTML = `<div class="message-avatar">小</div><div class="message-bubble"><p>${lead} <span class="intro-emoji">👇</span></p><p class="product-intro-product">商品：${escapeHtml(title)}</p>${lines}<p class="product-intro-note">在对话中可以通过 <span class="mention-chip">@</span> 来引用页面上的资源/数据，比如 <span class="mention-chip">@主图</span> 可以把主图发给AI进行分析，<span class="mention-chip">@详情页长图</span> 可以发送详情页长图</p></div><div class="product-intro-meta">小美 · ${escapeHtml(productIntroTime())}<span aria-hidden="true">▢</span></div>`;
    if (!existing) box.prepend(node);
    box.scrollTop = box.scrollHeight;
  }
  function renderProductSummary(result) {
    const summary = $('productSummary'); const image = $('productThumbImage'); const thumb = $('productThumb'); if (!summary || !image || !thumb) return;
    if (!result) { summary.hidden = true; image.removeAttribute('src'); thumb.classList.remove('has-image'); return; }
    const product = result.product || {}; const imageUrl = productSummaryImageUrl(result);
     summary.hidden = false; const displayState = productResultDisplayState(result); const blocked = displayState.needsAuth; const title = text(productDisplayTitle(result), blocked ? '待登录/验证后读取' : '商品信息待返回'); const titleNode = $('productSummaryTitle'); titleNode.textContent = title; titleNode.title = title; $('productSummaryId').textContent = text(product.id || product.itemId || product.productId); $('productSummaryCategory').textContent = text(product.category || product.categoryPath);
    if (imageUrl) { image.src = imageUrl; thumb.classList.add('has-image'); image.onerror = () => { thumb.classList.remove('has-image'); image.removeAttribute('src'); }; } else { thumb.classList.remove('has-image'); image.removeAttribute('src'); }
  }
  function mentionedResourceIds(message, result = currentResult()) {
    const input = String(message || '');
    if (!input || !result) return [];
    return resourceItems(result)
      .filter((item) => item.downloadable)
      .sort((left, right) => String(right.title || '').length - String(left.title || '').length)
      .filter((item) => {
        const title = String(item.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`@${title}(?=\\s|$|[，。！？!?、,.;；])`, 'i').test(input);
      })
      .map((item) => item.id);
  }
  function setProductInfoExpanded(expanded, options = {}) {
    const body = $('productInfoBody'); const toggle = document.querySelector('[data-toggle="productInfoBody"]');
    if (!body || !toggle) return;
    const nextExpanded = Boolean(expanded);
    body.classList.toggle('is-hidden', !nextExpanded);
    toggle.setAttribute('aria-expanded', String(nextExpanded));
    const indicator = toggle.querySelector('span:last-child');
    if (indicator) indicator.textContent = nextExpanded ? '⌄' : '›';
    if (options.syncState !== false) state.productInfoExpanded = nextExpanded;
    if (options.remember !== false) {
      const tab = activeCommerceTab();
      if (tab?.type === 'commerce') tab.productInfoExpanded = nextExpanded;
    }
  }
  function verificationDownloadUrl(format) {
    return state.jobId ? `/api/commerce-analysis/jobs/${encodeURIComponent(state.jobId)}/verification.${format}` : '';
  }
  function renderInfo(result = currentResult()) {
    const content = $('productInfoContent'); const empty = document.querySelector('.info-empty');
    if (!content) return;
    if (!result) { content.classList.remove('has-data'); if (empty) empty.style.display = ''; renderProductSummary(null); renderResources(null); const preference = productInfoPreferenceForTab(); setProductInfoExpanded(typeof preference === 'boolean' ? preference : false, { remember: false, syncState: typeof preference === 'boolean' }); if (!isSiteAssistantTab()) $('chatContextLabel').textContent = '未关联商品任务'; updateContextChip(); return; }
    const product = result.product || {}; const quality = result.quality || result.analysis?.coverage || {}; const metrics = result.metrics || {};
    const price = product.priceRange || (product.price ? (String(product.price).startsWith('¥') ? product.price : `¥${product.price}`) : '');
    const parameterGroups = product.parameters || {};
    const coreParameters = Array.isArray(product.coreParams) ? product.coreParams : (Array.isArray(parameterGroups.core) ? parameterGroups.core : []);
    const detailParameters = Array.isArray(product.detailParams) ? product.detailParams : (Array.isArray(parameterGroups.detail) ? parameterGroups.detail : []);
    const renderParameterGroup = (label, rows, core) => rows.length ? `<div class="product-parameters wide"><small>${escapeHtml(label)}</small><div class="product-parameter-list">${rows.map((row) => `<span><b>${escapeHtml(core ? (row.value || '') : (row.name || ''))}</b><em>${escapeHtml(core ? (row.name || '') : (row.value || ''))}</em></span>`).join('')}</div></div>` : '';
     $('productInfoCard').hidden = false; if (empty) empty.style.display = 'none'; content.classList.add('has-data'); renderProductSummary(result);
     applyProductInfoExpandedForTab(false);
    content.innerHTML = [
       ['标题', productDisplayTitle(result), true], ['价格', price], ['店铺', product.store], ['品牌', product.brand], ['商品ID', product.id || product.itemId || product.productId],
      ['类目', product.category || product.categoryPath], ['销量信号', product.sales || metrics.salesSignal], ['评价数', product.reviewCount || result.reviewStats?.totalCount || metrics.reviewCount], ['问大家数', product.questionCount || result.questionStats?.totalCount || metrics.questionCount],
      ['覆盖', quality.coveragePercent != null ? `${quality.coveragePercent}%` : ''], ['任务状态', result.status],
    ].map(([key, value, wide]) => `<div class="info-kv${wide ? ' wide' : ''}"><small>${escapeHtml(key)}</small><strong title="${escapeHtml(value)}">${escapeHtml(text(value))}</strong></div>`).join('') + renderParameterGroup('核心参数', coreParameters, true) + renderParameterGroup('详细参数', detailParameters, false);
    renderResources(result); renderProductAssistantIntro(result);
    const displayState = productResultDisplayState(result);
    const blocked = displayState.needsAuth;
    const blockedSite = blocked ? commerceLoginTarget(resultSourceUrl(result), activeCommerceLoginTarget().site).label : '';
     $('previewTitle').textContent = text(productDisplayTitle(result), blocked ? '商品页需要登录/验证' : displayState.hasData ? '已读取商品页，可在右侧继续分析' : displayState.failedWithoutData ? '商品采集未返回可用字段' : '商品信息待返回'); $('previewDescription').textContent = text(product.description, blocked ? `完成${blockedSite}登录或验证后，系统会自动重试当前商品。` : displayState.hasData ? '商品数据已经绑定到问问小美上下文。' : '当前没有可展示的真实商品字段，请完成页面加载后重试。');
    if (!isSiteAssistantTab()) $('chatContextLabel').textContent = state.jobId ? `已关联任务 ${state.jobId.slice(0, 8)}` : '已读取当前商品'; updateContextChip();
  }
  function renderModules(result = currentResult()) { const box = $('modulePills'); if (!box) return; const statuses = result?.moduleStatus || {}; box.innerHTML = moduleOrder.map((key) => { const item = statuses[key] || {}; const status = item.status || 'missing'; const label = moduleLabels[key]; const rawCount = item.totalCount ?? item.sampleCount; const count = rawCount !== null && rawCount !== undefined && String(rawCount).trim() ? ` ${rawCount}` : ''; return `<span class="module-pill ${status}"><i></i>${label}${count}</span>`; }).join(''); }
  function renderJob(job) {
    if (!job) return false;
    const jobUrl = job.url || resultSourceUrl(job.result);
    const currentKey = productContextKey(activeProductUrl());
    const jobKey = productContextKey(jobUrl);
    if (jobUrl && currentKey && jobKey && currentKey !== jobKey) return false;
    if (job.result && !resultMatchesCurrentProduct(job.result)) return false;
    state.job = job; state.jobId = job.id || state.jobId; state.analysisProductKey = jobKey || state.analysisProductKey || state.productKey;
    $('jobIdText').textContent = state.jobId ? `#${state.jobId.slice(0, 8)}` : '';
    const busy = ['queued', 'running'].includes(job.status); const kind = busy ? 'running' : ['ready', 'partial', 'stopped'].includes(job.status) ? 'ready' : ['failed', 'needs_login'].includes(job.status) ? 'error' : '';
    setJobState(job.message || job.stage, kind); setSiteState(busy ? '正在读取商品页' : job.status === 'needs_login' ? '等待登录' : '本地分析服务', busy ? 'busy' : job.status === 'failed' ? 'error' : 'ok');
    if (job.result) { state.result = job.result; renderInfo(job.result); renderModules(job.result); }
    rememberProductAnalysisForTab();
    if (job.status === 'needs_login') toast(`请在可见${activeCommerceLoginTarget().label}页面完成登录/验证后重试`);
    return true;
  }
  async function api(url, options = {}) { const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-User-ID': chatUserId, ...(options.headers || {}) } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || data.message || `请求失败（${response.status}）`); return data; }
  async function checkLogin(silent = false) {
    try {
      const currentTab = activeCommerceTab();
      if (currentTab?.type !== 'commerce') return { ok: false, code: 'no_commerce_tab', message: '当前没有官方平台标签页' };
      const shell = shellApi();
      const target = activeCommerceLoginTarget();
      if (!target.supported) {
        const message = `${target.label}请直接在当前官方页面内登录，小美不会把跨境平台跳转到淘宝登录页`;
        setSiteState(`${target.label}页面内登录`, 'busy');
        if (!silent) toast(message);
        return { ok: false, code: 'site_login_in_page', site: target.site, message };
      }
      const session = shell?.getCommerceSession
        ? await shell.getCommerceSession()
        : await api('/api/commerce-analysis/browser/session');
      state.browserSession = session;
      const sessionSite = String(session.site || '').trim();
      const profileLabel = session.profileLabel || (session.backend === 'edge'
        ? '商品分析专用 Edge'
        : sessionSite === '1688' || target.site === '1688'
          ? '1688独立会话'
          : sessionSite === '千牛' || sessionSite === '生意参谋'
            ? '千牛工作台独立会话'
            : '淘宝独立会话');
      // “页面已连接”并不表示账号已登录：1688 首页允许访客浏览，而商品页
      // 可能才要求登录。状态只描述可确认的页面连接情况，避免误导用户。
      const label = session.state === 'browser_connected' ? `${profileLabel}页面已打开` : session.state === 'login_page_open' ? `${profileLabel}登录页已打开` : session.browserAvailable ? `${profileLabel}浏览器已打开` : '等待登录';
      const kind = session.state === 'browser_connected' ? 'ok' : session.state === 'login_page_open' ? 'busy' : session.browserAvailable ? 'ok' : 'busy';
      setSiteState(label, kind);
      if (!silent) toast(session.message || label);
      return session;
    } catch (error) {
      if (!silent) toast(error.message);
      setSiteState('服务不可用', 'error');
      return null;
    }
  }
  async function login() {
    try {
      const currentTab = activeCommerceTab();
      if (currentTab?.type !== 'commerce') return toast('请先打开一个官方平台页面');
      const target = activeCommerceLoginTarget();
      if (!target.supported || !target.loginUrl) return toast(`${target.label}请直接在当前官方页面内登录，不会打开淘宝登录页`);
      const currentKey = productContextKey(activeProductUrl());
      if (currentKey) state.autoCollectionAuthRetryKeys.delete(currentKey);
      const shell = shellApi();
      if (shell?.openLogin) {
        const activeUrl = safeCommerceUrl(activeProductUrl());
        const returnUrl = target.site === '1688'
          && platformForUrl(activeUrl)?.id === '1688'
          && isDetailCommerceUrl(activeUrl)
          ? activeUrl
          : '';
        const tab = openCommerceTab(target.loginUrl, target.label, { kind: 'login', site: target.site, platform: target.site, load: false });
        await shell.openLogin(target.site, tab?.id, returnUrl);
        toast(`已在小美画布当前窗口打开${target.label}官方登录页，请手动完成登录`);
      } else {
        const session = await api('/api/commerce-analysis/browser/login', { method: 'POST' });
        state.browserSession = session;
        toast(session.message || '已打开商品分析专用 Edge，请在官方页面完成登录');
      }
      await checkLogin(true);
    } catch (error) { toast(error.message); }
  }
  function openCommerceLinkInNewTab(event) {
    const link = event?.target?.closest?.('a[href]');
    if (!link) return false;
    const safeUrl = safeCommerceUrl(link.href || '');
    if (!safeUrl) return false;
    event.preventDefault();
    event.stopPropagation();
    openProduct(safeUrl, { newTab: true });
    return true;
  }
  function openProduct(url = $('productUrl').value.trim(), options = {}) {
    if (!url) return toast('请先填写商品链接');
    const safeUrl = safeCommerceUrl(url);
    if (!safeUrl) return toast('仅支持已加入工作应用的平台官网');
    const newTab = options === true || Boolean(options?.newTab);
    const detail = isDetailCommerceUrl(safeUrl);
    const platform = platformForUrl(safeUrl) || (isTaobaoHomeUrl(safeUrl) ? taobaoHomePlatform : null);
    const label = detail ? '商品详情' : platform?.label || '淘宝';
    const kind = detail ? 'detail' : platform ? 'platform' : 'product';
    if (platform && !detail) {
      state.url = safeUrl;
      state.productUrl = '';
      state.embeddedUrl = safeUrl;
      if ($('productUrl')) $('productUrl').value = safeUrl;
    }
    const shell = shellApi();
    if (shell?.openProduct) {
      const tab = openCommerceTab(safeUrl, label, { newTab, kind, platform: platform?.id || '', site: platform?.id || '', load: false });
      if (!tab) return null;
      Promise.resolve(shell.openProduct(safeUrl, tab.id)).catch((error) => toast(error.message));
      $('surfacePlaceholder').classList.add('is-embedded');
      $('surfaceStatus').textContent = `正在前往${label}`;
      syncCommerceLoadingState(tab);
      toast(`正在打开${label}官方页面`);
      return tab;
    }
    const tab = openCommerceTab(safeUrl, label, { newTab, kind, platform: platform?.id || '', site: platform?.id || '', load: false });
    if (tab) toast(platform ? `${label}需要在桌面版内置浏览器中打开` : detail ? '当前浏览器不嵌入商品页；点击开始分析将使用商品分析专用 Edge' : '官方商品页仅支持桌面版内置浏览器');
    return tab;
  }
  async function startAnalysis(force = false, module = '') {
    if (hasPendingNativeNavigation()) { toast('页面仍在加载，请在官方页面显示后再开始分析'); return null; }
    const url = $('productUrl').value.trim();
    if (!url) { toast('请先填写淘宝、天猫或 1688 商品链接'); return null; }
    const platform = platformForUrl(url);
    if (platform && !isDetailCommerceUrl(url)) { toast(`当前是${platform.label}官方页面，商品分析请切换到淘宝、天猫或 1688 商品详情页`); return null; }
    const requestedKey = productContextKey(url); const loadedKey = productContextKey(activeProductUrl());
    if (loadedKey && requestedKey && loadedKey !== requestedKey && shellApi()?.captureProduct) {
      openProduct(url); toast('链接与当前内嵌页面不是同一件商品，已切换页面；页面加载完成后请再点击开始分析'); return null;
    }
    syncProductContext(url); state.url = url;
    if (state.analysisStarting || ['queued', 'running'].includes(state.job?.status)) {
      toast('商品采集正在进行，请耐心等待');
      return null;
    }
    state.analysisStarting = true;
    try {
      const requestToken = `${requestedKey}:${Date.now()}`; state.analysisRequestToken = requestToken;
      const shell = shellApi();
      if (!shell?.captureProduct) {
        setJobState('正在创建浏览器采集任务', 'running');
        try {
          const job = await api('/api/commerce-analysis/jobs', { method: 'POST', body: JSON.stringify({ url, browser: true, force, module }) });
          if (state.analysisRequestToken !== requestToken) return null;
          state.job = job; state.jobId = job.id; state.result = null; renderJob(job); poll();
          toast(module ? `已开始采集${moduleLabels[module] || module}` : '商品分析任务已开始');
          return job;
        } catch (error) { setJobState(error.message, 'error'); toast(error.message); return null; }
      }
      setJobState('正在创建采集任务', 'running');
      try {
        // Electron 采集固定走达比式可见操作链；进度由桌面桥实时回传，结果仍统一导入 FastAPI 合同。
        const activeTab = activeCommerceTab();
        const captureTabId = activeTab?.type === 'commerce' ? activeTab.id : '';
        if (activeTab?.type === 'commerce' && shell.activateProductTab) {
          await shell.activateProductTab(activeTab.id).catch(() => null);
        }
        const previousJobId = state.jobId || '';
        const snapshot = await shell.captureProduct({
          deep: false,
          module,
          tabId: captureTabId,
          trigger: module === BASE_COLLECTION_MODULE ? 'auto_open' : module ? 'resource_click' : 'manual_start',
        });
        if (state.analysisRequestToken !== requestToken || (requestedKey && productContextKey(activeProductUrl()) !== requestedKey)) return null;
        // 另一个入口已经在桌面进程中采集时，captureProduct 会返回 running。
        // 这不是失败，不能继续创建第二条后端采集任务，否则会出现评价采完又重采。
        if (snapshot?.status === 'running') {
          const runningMessage = snapshot.message || '桌面智能体正在操作，请耐心等待完成';
          setJobState(runningMessage, 'running');
          setSiteState(runningMessage, 'busy');
          return snapshot;
        }
        if (snapshot?.ok) {
          const imported = await api('/api/commerce-analysis/import', { method: 'POST', body: JSON.stringify({ url, data: snapshot, filename: 'electron-dabi-network.json', previous_job_id: previousJobId }) });
          if (state.analysisRequestToken !== requestToken || (requestedKey && productContextKey(activeProductUrl()) !== requestedKey)) return null;
          state.result = imported; state.jobId = imported.jobId || '';
          renderJob({ id: state.jobId, status: imported.status, message: imported.message, result: imported });
          toast(module ? `已采集${moduleLabels[module] || module}` : '已读取桌面商品页可见内容');
          return imported;
        }
        // 登录/验证是当前可见页面的确定性状态，不要再降级创建一条
        // 浏览器后端任务。直接导入这次捕获结果，保留真实商品 ID、资源状态
        // 和“需登录/验证”的原因，避免刷新或重复事件制造并发失败任务。
        if (['login_required', 'verification_required', 'needs_login'].includes(String(snapshot?.status || '').toLowerCase())) {
          const imported = await api('/api/commerce-analysis/import', { method: 'POST', body: JSON.stringify({ url, data: snapshot, filename: 'electron-dabi-auth-state.json', previous_job_id: previousJobId }) });
          if (state.analysisRequestToken !== requestToken || (requestedKey && productContextKey(activeProductUrl()) !== requestedKey)) return null;
          state.result = imported; state.jobId = imported.jobId || '';
          renderJob({ id: state.jobId, status: imported.status, message: imported.message || snapshot.message, result: imported });
          toast(snapshot.message || '当前商品页需要完成登录/验证');
          return imported;
        }
        // Electron 商品页已经有唯一的达笔式可见采集链。捕获失败时不能再
        // 回退创建 FastAPI 商品任务，否则一次点击会启动第二套采集器，
        // 造成重复登录/验证任务、旧商品串数据和并发采集。
        const failureStatus = String(snapshot?.status || '').trim().toLowerCase();
        const failureMessage = snapshot?.message || '桌面商品页未返回可采集内容，请确认页面已加载并完成登录/验证后重试';
        setJobState(failureMessage, 'error');
        setSiteState(
          ['login_required', 'verification_required', 'needs_login'].includes(failureStatus)
            ? '当前商品页需要完成官方登录/验证'
            : '桌面商品页采集未完成',
          'error',
        );
        toast(failureMessage);
        return snapshot;
      } catch (error) { setJobState(error.message, 'error'); toast(error.message); return null; }
    } finally {
      state.analysisStarting = false;
    }
  }
  async function clearCommerceSession() { const shell = shellApi(); const target = activeCommerceLoginTarget(); if (!target.supported) return toast(`${target.label}使用站点自己的登录会话，不能清除淘宝/1688会话`); if (!shell?.clearCommerceSession) return toast(`会话清除仅支持小美画布桌面版；浏览器采集会话请在商品分析专用 Edge 中自行退出登录`); if (!window.confirm(`确认清除小美画布桌面版淘宝/1688登录会话？不会删除商品分析报告。`)) return; try { const result = await shell.clearCommerceSession(); state.browserSession = result; setSiteState('淘宝/1688会话已清除', 'busy'); toast(result.message || '淘宝/1688会话已清除'); } catch (error) { toast(error.message); } }
  async function retryModule(module) { if (!guardCurrentJob()) return null; if (shellApi()?.captureProduct) return startAnalysis(false, module); if (!state.jobId) return startAnalysis(false, module); try { const job = await api(`/api/commerce-analysis/jobs/${encodeURIComponent(state.jobId)}/retry?module=${encodeURIComponent(module)}`, { method: 'POST', body: '{}' }); if (renderJob(job)) { toast(`已重新采集${moduleLabels[module] || module}`); poll(); } return job; } catch (error) { toast(error.message); return null; } }
  async function poll() { clearTimeout(state.polling); if (!state.jobId) return; const pollingJobId = state.jobId; try { const job = await api(`/api/commerce-analysis/jobs/${encodeURIComponent(pollingJobId)}`); if (state.jobId !== pollingJobId || !renderJob(job)) return; if (['queued', 'running'].includes(job.status)) state.polling = setTimeout(poll, 1500); } catch (error) { if (state.jobId === pollingJobId) setJobState(error.message, 'error'); } }
  function resourceAttachmentMarkup(items = []) { return items.filter((item) => item?.downloadable && resourceDownloadUrl(item)).map((item) => `<a class="message-attachment" href="${escapeHtml(resourceDownloadUrl(item))}" download><span>${escapeHtml(resourceIcons[item.id] || '▣')}</span><span>${escapeHtml(item.title || resourceLabels[item.id] || item.id)}</span><small>${escapeHtml(resourceCount(item) || resourceDownloadLabel(item))}</small></a>`).join(''); }
  function renderChatHistory() {
    const count = $('chatHistoryCount'); const list = $('chatHistoryList'); if (!count || !list) return;
    count.textContent = `${state.messages.length} 条消息`;
    list.innerHTML = state.messages.length ? state.messages.slice(-20).map((item, index) => `<button type="button" class="chat-history-item" data-history-index="${Math.max(0, state.messages.length - Math.min(20, state.messages.length) + index)}"><span>${item.role === 'user' ? '我' : '小美'}</span><strong>${escapeHtml(String(item.content || '').replace(/\s+/g, ' ').slice(0, 48) || '空消息')}</strong></button>`).join('') : '<div class="chat-history-empty">当前还没有可回看的消息。</div>';
    q('[data-history-index]', list).forEach((button) => { button.onclick = () => { $('chatHistoryPopover').hidden = true; const nodes = q('.chat-message', $('chatMessages')); const target = nodes[Number(button.dataset.historyIndex)]; target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }; });
  }
  function toggleChatHistory(force) { const popover = $('chatHistoryPopover'); if (!popover) return; const open = typeof force === 'boolean' ? force : popover.hidden; popover.hidden = !open; if (open) renderChatHistory(); }
  function startNewChat() { const siteProfile = assistantProfileForTab(); state.conversationId = ''; state.conversationProductKey = activeConversationContextKey(); state.messages = []; clearChatAttachments(); clearResourceSelection(); notifySharedConversation(''); $('chatMessages').innerHTML = ''; toggleChatHistory(false); appendMessage('assistant', siteProfile ? `新的${siteProfile.title}页面分析对话已开始。只会结合本标签当前可见资料回答。` : '新的商品研究对话已开始。你可以问我主图、评价、详情、视频或运营数据。'); }
  function toggleChatFocus() { const panel = $('assistantPanel'); if (!panel) return; const focused = panel.classList.toggle('chat-focus'); $('chatPopout')?.setAttribute('aria-pressed', String(focused)); toast(focused ? '已展开问答区，可专注查看分析结果' : '已恢复商品信息与问答并列视图'); }
  async function copyProductValue(elementId, label) { const value = $(elementId)?.textContent?.trim(); if (!value || value === '未返回') return toast(`当前没有可复制的${label}`); try { await navigator.clipboard.writeText(value); toast(`${label}已复制`); } catch { toast(`复制失败，请手动选择${label}`); } }
  async function copyProductId() { return copyProductValue('productSummaryId', '商品ID'); }
  async function copyProductCategory() { return copyProductValue('productSummaryCategory', '商品类目'); }
  function toggleResourcePicker(force) { const popover = $('resourcePickerPopover'); if (!popover) return; const open = typeof force === 'boolean' ? force : popover.hidden; popover.hidden = !open; if (open) renderResourcePicker(); }
  function assistantSkillId(skill) { return String(skill?.id || skill?.slug || '').trim(); }
  function assistantSkillName(skill) { return String(skill?.display_name || skill?.name || assistantSkillId(skill) || '未命名 Skill').trim(); }
  function assistantSkillDescription(skill) { return String(skill?.description || skill?.category_label || '可用于当前对话的本地 Skill').trim(); }
  function updateAssistantSkillButton() {
    const button = $('skillPicker');
    if (!button) return;
    const selected = state.skillItems.find((skill) => assistantSkillId(skill) === state.skillId && skill.enabled !== false);
    const label = $('skillPickerLabel');
    const name = selected ? assistantSkillName(selected) : '';
    // 保持入口始终叫“技能”，避免当前 Skill 名称（如 gpt-image）看起来像生图模型。
    // 当前选中项会在弹层中用勾选状态显示，悬停按钮也能看到完整名称。
    if (label) label.textContent = '技能';
    button.classList.toggle('has-selection', Boolean(selected));
    button.title = selected ? `当前技能：${name}，点击选择其他 Skill` : '打开技能选择';
    button.setAttribute('aria-label', selected ? `当前使用技能：${name}，打开技能选择` : '打开技能选择');
  }
  function assistantSkillItems() {
    const query = String(state.skillQuery || '').trim().toLocaleLowerCase();
    return state.skillItems.filter((skill) => {
      if (!skill || skill.enabled === false) return false;
      const haystack = `${assistantSkillName(skill)} ${assistantSkillDescription(skill)} ${assistantSkillId(skill)}`.toLocaleLowerCase();
      return !query || haystack.includes(query);
    }).sort((left, right) => {
      const rank = (skill) => {
        const id = assistantSkillId(skill).toLocaleLowerCase();
        const name = assistantSkillName(skill);
        if (id === 'buyer-show-generation' || id === 'buyer-show-generator' || name.includes('买家秀')) return 0;
        if (id === 'dabi-browser' || id.includes('browser')) return 1;
        return 2;
      };
      return rank(left) - rank(right) || assistantSkillName(left).localeCompare(assistantSkillName(right), 'zh-CN');
    });
  }
  function renderAssistantSkillPicker() {
    updateAssistantSkillButton();
    const list = $('assistantSkillList'); const empty = $('assistantSkillEmpty');
    if (!list || !empty) return;
    const items = assistantSkillItems();
    list.innerHTML = items.map((skill) => {
      const id = assistantSkillId(skill); const selected = id && id === state.skillId;
      return `<button type="button" class="assistant-skill-option${selected ? ' is-selected' : ''}" data-assistant-skill-id="${escapeHtml(id)}" role="option" aria-selected="${selected ? 'true' : 'false'}"><span class="assistant-skill-option-icon" aria-hidden="true">ϟ</span><span class="assistant-skill-option-copy"><strong>${escapeHtml(assistantSkillName(skill))}</strong><small>${escapeHtml(assistantSkillDescription(skill))}</small></span>${selected ? '<span class="assistant-skill-option-check" aria-label="当前使用">✓</span>' : ''}</button>`;
    }).join('');
    empty.hidden = Boolean(items.length) || state.skillLoading === false && !state.skillError;
    if (state.skillLoading) { empty.hidden = false; empty.textContent = '正在读取 Skill…'; }
    else if (state.skillError) { empty.hidden = false; empty.textContent = `读取失败：${state.skillError}`; }
    else if (!items.length) { empty.hidden = false; empty.textContent = state.skillQuery ? '没有匹配的 Skill' : '暂无可用 Skill'; }
  }
  async function loadAssistantSkills(force = false) {
    if (!force && (state.skillItems.length || state.skillLoading)) return state.skillItems;
    state.skillLoading = true; state.skillError = ''; renderAssistantSkillPicker();
    try {
      const data = window.StudioSharedSkill?.load
        ? await window.StudioSharedSkill.load(force)
        : await fetch('/api/agent-skills', { cache: 'no-store' }).then((response) => { if (!response.ok) throw new Error(`Skill API ${response.status}`); return response.json(); }).then((payload) => payload?.skills || []);
      state.skillItems = Array.isArray(data) ? data : [];
      updateAssistantSkillButton();
      return state.skillItems;
    } catch (error) {
      state.skillError = error.message || '无法读取 Skill 列表';
      return [];
    } finally { state.skillLoading = false; renderAssistantSkillPicker(); positionAssistantSkillPicker(); }
  }
  function positionAssistantSkillPicker() {
    const button = $('skillPicker'); const popover = $('assistantSkillPicker');
    if (!button || !popover || popover.hidden) return;
    // 选择器属于助手栏。以前用 position: fixed + 全窗口坐标，外层 iframe
    // 或界面缩放启用时会把弹层计算到助手栏以外，结果是按钮已有点击反馈但
    // 用户看不到任何内容。改用助手栏本地坐标，始终在输入框上方可见。
    const panel = $('assistantPanel');
    if (!panel) return;
    const anchor = button.getBoundingClientRect(); const panelRect = panel.getBoundingClientRect();
    const width = Math.min(360, Math.max(0, panelRect.width - 16));
    popover.style.width = `${width}px`;
    const height = popover.getBoundingClientRect().height;
    const maxLeft = Math.max(8, panelRect.width - width - 8);
    const left = Math.min(Math.max(8, anchor.left - panelRect.left), maxLeft);
    let top = anchor.top - panelRect.top - height - 8;
    if (top < 8) top = Math.min(anchor.bottom - panelRect.top + 8, Math.max(8, panelRect.height - height - 8));
    popover.style.left = `${left}px`; popover.style.top = `${top}px`;
  }
  function toggleAssistantSkillPicker(force) {
    const button = $('skillPicker'); const popover = $('assistantSkillPicker'); if (!button || !popover) return;
    const open = typeof force === 'boolean' ? force : popover.hidden;
    popover.hidden = !open; button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    toggleModelPicker(false); toggleResourcePicker(false); toggleChatHistory(false); toggleConversationHistory(false);
    state.skillQuery = ''; if ($('assistantSkillSearch')) $('assistantSkillSearch').value = '';
    renderAssistantSkillPicker(); positionAssistantSkillPicker();
    // 列表为空或上次读取失败时，每次打开都重新请求。这样旧页面里被中断的
    // 首次请求不会让“技能”按钮一直停在空列表状态。
    if (!state.skillItems.length || state.skillError) void loadAssistantSkills(true);
    requestAnimationFrame(positionAssistantSkillPicker);
  }
  function selectAssistantSkill(id) {
    const next = String(id || '').trim();
    const selected = state.skillItems.find((skill) => assistantSkillId(skill) === next && skill.enabled !== false);
    if (!selected) return;
    state.skillId = next;
    updateAssistantSkillButton();
    if (window.StudioSharedSkill?.setSelected) window.StudioSharedSkill.setSelected(next);
    else { try { localStorage.setItem(SHARED_SKILL_SELECTION_KEY, next); } catch {} }
    toggleAssistantSkillPicker(false); toast(`已选择 Skill：${assistantSkillName(selected)}`);
  }
  function conversationAttachmentMarkup(items = []) {
    return items.map((item, index) => {
      const resourceId = typeof item === 'string' ? item : String(item?.id || '').trim();
      const resourceUrl = resourceId ? resourceDownloadUrl({ id: resourceId, downloadId: resourceId }) : '';
      const url = String(item?.url || resourceUrl || '').trim();
      if (!url) return '';
      const label = String(item?.name || item?.title || (resourceId ? resourceLabels[resourceId] : '') || chatAttachmentName(item, index)).trim() || '附件';
      const image = isChatImageReference(item);
      const isMedia = resourceId && mediaResourceIds.has(resourceId);
      const kind = image ? '图片' : resourceId ? (isMedia ? '媒体' : 'CSV') : '附件';
      const filename = resourceId && !isMedia ? `${label}_${state.jobId || 'data'}.csv` : label;
      const meta = resourceId ? (resourceCount(item) || resourceDownloadLabel({ id: resourceId })) : '';
      const preview = image ? `<img class="message-attachment-preview" src="${escapeHtml(url)}" alt="${escapeHtml(label)}">` : `<span class="message-attachment-kind">${escapeHtml(kind)}</span>`;
      return `<a class="message-attachment${image ? ' is-image' : ''}" href="${escapeHtml(url)}" download="${escapeHtml(filename)}" target="_blank" rel="noreferrer">${preview}<span>${escapeHtml(filename)}</span>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</a>`;
    }).join('');
  }
  const merchantKindLabels = { visual_plan: '主图 / 详情页视觉方案', listing_copy: '商品文案修改稿', campaign_plan: '推广活动与素材计划', generation_batch: '待执行批量生图任务' };
  const merchantStatusLabels = { pending: '待确认', approved: '已批准', applied: '已送达', discarded: '已丢弃', failed: '失败' };
  function merchantExecutionSummary(change = {}) {
    const after = change?.after && typeof change.after === 'object' ? change.after : {};
    const kind = String(change?.kind || '');
    if (kind === 'visual_plan') {
      const segments = Array.isArray(after.segments) ? after.segments : [];
      return segments.slice(0, 5).map((item, index) => `${index + 1}. ${String(item?.title || `方案 ${index + 1}`)}${item?.purpose ? `：${String(item.purpose)}` : ''}`).join('\n') || '将填充可编辑的分段提示词。';
    }
    if (kind === 'generation_batch') return (Array.isArray(after.prompts) ? after.prompts : []).slice(0, 5).map((item, index) => `${index + 1}. ${String(item)}`).join('\n') || '将进入现有批量生图草稿。';
    if (kind === 'listing_copy') return [after.title && `标题：${after.title}`, ...(Array.isArray(after.selling_points) ? after.selling_points.map((item) => `卖点：${item}`) : []), after.detail_copy && '详情文案已准备', after.customer_service && '客服话术已准备'].filter(Boolean).slice(0, 5).join('\n') || '将导出可编辑文案稿。';
    if (kind === 'campaign_plan') return (Array.isArray(after.assets) ? after.assets : []).slice(0, 5).map((item, index) => `${index + 1}. ${String(item)}`).join('\n') || '将送到电商工作台继续制作。';
    return '待确认方案。';
  }
  function merchantChangeCardMarkup(change = {}) {
    const id = String(change?.id || '').trim(); if (!id) return '';
    const kind = String(change?.kind || ''); const status = String(change?.status || 'pending');
    const after = change?.after && typeof change.after === 'object' ? change.after : {};
    const evidence = Array.isArray(change?.evidence) ? change.evidence.slice(0, 5) : [];
    const title = String(after.title || merchantKindLabels[kind] || '经营方案');
    const summary = String(after.summary || '基于本次读取的商品资料整理，尚未执行。');
    const actionLabel = kind === 'listing_copy' ? '导出修改稿' : kind === 'generation_batch' ? '送到批量生图' : kind === 'campaign_plan' ? '送到电商工作台' : '送到一键主图 / 详情页';
    const pendingActions = `<button type="button" data-merchant-change-action="edit" data-change-id="${escapeHtml(id)}">在对话中编辑</button><button type="button" data-merchant-change-action="approve" data-change-id="${escapeHtml(id)}">批准</button><button type="button" data-merchant-change-action="discard" data-change-id="${escapeHtml(id)}">丢弃</button>`;
    const approvedActions = `<button type="button" data-merchant-change-action="apply" data-change-id="${escapeHtml(id)}">${escapeHtml(actionLabel)}</button><button type="button" data-merchant-change-action="discard" data-change-id="${escapeHtml(id)}">丢弃</button>`;
    const actions = status === 'pending' ? pendingActions : status === 'approved' ? approvedActions : '';
    const evidenceHtml = evidence.length ? `<div class="merchant-change-evidence">${evidence.map((item) => `<span title="${escapeHtml(String(item?.locator || item?.label || item?.id || ''))}">${escapeHtml(String(item?.id || '证据'))}${item?.label ? ` · ${escapeHtml(String(item.label))}` : ''}</span>`).join('')}</div>` : '<div class="merchant-change-evidence"><span>证据未返回</span></div>';
    return `<article class="merchant-change-card is-${escapeHtml(status)}" data-merchant-change-card="${escapeHtml(id)}"><div class="merchant-change-head"><strong>${escapeHtml(title)}</strong><span class="merchant-change-status">${escapeHtml(merchantStatusLabels[status] || status)}</span></div><div class="merchant-change-body"><p><b>依据</b>\n${escapeHtml(summary)}</p><p><b>拟执行</b>\n${escapeHtml(merchantExecutionSummary(change))}</p>${evidenceHtml}</div>${actions ? `<div class="merchant-change-actions">${actions}</div>` : ''}</article>`;
  }
  function appendMerchantChangeCards(node, changes = []) {
    const list = Array.isArray(changes) ? changes.filter((item) => item && item.id) : [];
    if (!node || !list.length) return;
    const wrapper = document.createElement('div'); wrapper.className = 'merchant-change-list'; wrapper.innerHTML = list.map(merchantChangeCardMarkup).join(''); node.appendChild(wrapper);
  }
  function replaceMerchantChangeCard(change = {}) {
    const id = String(change?.id || '').trim(); const card = id ? document.querySelector(`[data-merchant-change-card="${id}"]`) : null;
    if (!card) return;
    const container = document.createElement('div'); container.innerHTML = merchantChangeCardMarkup(change); const replacement = container.firstElementChild; if (replacement) card.replaceWith(replacement);
  }
  function setAssistantMode(mode) {
    const next = mode === 'merchant' ? 'merchant' : 'analysis'; state.assistantMode = next;
    $('assistantPanel')?.classList.toggle('is-merchant-mode', next === 'merchant');
    q('[data-assistant-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.assistantMode === next));
    const input = $('chatInput'); if (input) input.placeholder = next === 'merchant' ? '让经营助手读取当前商品并暂存可确认方案' : '输入问题、粘贴图片，或用 @ 引用页面资源';
    const label = $('chatContextLabel'); if (label && next === 'merchant') label.textContent = state.jobId ? '经营助手仅可读取当前已完成商品任务' : '请先完成商品采集后使用经营助手';
  }
  function merchantListingCopyText(change = {}) {
    const after = change?.after && typeof change.after === 'object' ? change.after : {};
    return [
      '# 商品文案修改稿',
      after.title ? `\n## 标题\n${after.title}` : '',
      Array.isArray(after.selling_points) && after.selling_points.length ? `\n## 卖点\n${after.selling_points.map((item) => `- ${item}`).join('\n')}` : '',
      after.detail_copy ? `\n## 详情文案\n${after.detail_copy}` : '',
      after.customer_service ? `\n## 客服话术\n${after.customer_service}` : '',
      change?.id ? `\n\n---\n来源变更 ID：${change.id}` : '',
    ].filter(Boolean).join('\n');
  }
  function downloadMerchantListingCopy(change = {}) {
    const blob = new Blob([merchantListingCopyText(change)], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '小美经营助手-商品文案.md'; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  async function handleMerchantChangeAction(button) {
    const action = String(button?.dataset?.merchantChangeAction || ''); const id = String(button?.dataset?.changeId || '').trim(); if (!action || !id) return;
    if (action === 'edit') {
      setAssistantMode('merchant'); const input = $('chatInput'); if (input) { input.value = '请基于当前商品重新生成一份方案，我希望这样修改：'; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      return;
    }
    button.disabled = true;
    try {
      const body = action === 'approve' ? JSON.stringify({}) : action === 'discard' ? JSON.stringify({}) : undefined;
      const data = await api(`/api/merchant-agent/changes/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
      if (data?.change) replaceMerchantChangeCard(data.change);
      if (action === 'approve') toast('方案已批准；仍需点击下一步送到工作台。');
      else if (action === 'discard') toast('方案已丢弃。');
      else if (action === 'apply') {
        if (data?.export?.content || data?.change?.kind === 'listing_copy') { downloadMerchantListingCopy(data.change); toast('已导出可编辑文案稿；不会写入店铺。'); }
        if (data?.handoff?.change_id) { postParent({ type: 'merchant-change-handoff', change_id: data.handoff.change_id }); toast('已送到电商工作台，可继续核对和生成。'); }
      }
    } catch (error) { toast(error.message || '变更操作失败'); }
    finally { button.disabled = false; }
  }
  function appendMessage(role, message, suggestions = [], attachments = [], options = {}) {
    const box = $('chatMessages'); if (!box) return;
    const node = document.createElement('div');
    node.className = `chat-message ${role}`;
    node.dataset.messageIndex = String(state.messages.length);
    if (options.pageContextPlaceholder) node.dataset.pageContextPlaceholder = 'true';
    const attachmentHtml = attachments.length ? `<div class="message-attachments">${conversationAttachmentMarkup(attachments)}</div>` : '';
    const contentHtml = role === 'assistant' ? `<div class="md-content">${renderMarkdownMessage(message)}</div>` : `<p class="message-text">${escapeHtml(message)}</p>`;
    const suggestionsHtml = suggestions.length ? `<div class="suggestions">${suggestions.map((item) => `<button type="button" data-suggest="${escapeHtml(item)}"><span>${escapeHtml(item)}</span></button>`).join('')}</div>` : '';
    node.innerHTML = `${role === 'assistant' ? '<div class="message-avatar">小</div>' : ''}<div class="message-bubble">${contentHtml}</div>${suggestionsHtml}${attachmentHtml}`;
    appendMerchantChangeCards(node, options.merchantChanges);
    box.appendChild(node); box.scrollTop = box.scrollHeight;
    if (!options.skipState) { state.messages.push({ role, content: message, attachments: attachments.map((item) => item?.id || item?.url || ''), merchant_changes: Array.isArray(options.merchantChanges) ? options.merchantChanges : [] }); renderChatHistory(); }
  }
  function renderSavedConversation(messages = []) { const box = $('chatMessages'); if (!box) return; state.messages = Array.isArray(messages) ? messages.slice() : []; box.innerHTML = ''; if (!state.messages.length) { const siteView = activeSiteAssistantView(); const siteProfile = assistantProfileForTab(); appendMessage('assistant', siteView?.greeting || (siteProfile ? `你好，我是小美。${siteProfile.title}的当前可见资料会随本标签页单独保存和分析。` : '你好，我是小美。登录淘宝或 1688 并完成商品采集后，我可以帮你分析评价、主图、详情页、视频和运营数据。'), siteProfile ? [] : ['先看看这个商品的核心卖点和风险', '评价里用户最在意什么？'], [], { skipState: true }); return; } state.messages.forEach((item) => { const role = item?.role === 'user' ? 'user' : 'assistant'; const content = item?.type === 'image' ? (item.agent_reply || '已生成图片') : String(item?.content || ''); appendMessage(role, content, [], Array.isArray(item?.attachments) ? item.attachments : [], { skipState: true, merchantChanges: item?.merchant_changes }); }); renderChatHistory(); }
  function renderConversationHistoryList(items = []) { const list = $('conversationHistoryList'); if (!list) return; if (!items.length) { list.innerHTML = '<div class="conversation-history-empty">还没有已保存的对话。</div>'; return; } list.innerHTML = items.slice(0, 50).map((item) => `<button type="button" class="conversation-history-item ${item.id === state.conversationId ? 'is-active' : ''}" data-shared-conversation-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title || '新对话')}</strong><small>${escapeHtml(item.last_message || '暂无消息')}</small></button>`).join(''); }
  async function loadConversationHistoryList() { try { const data = await api('/api/conversations', { headers: { 'Cache-Control': 'no-cache' } }); renderConversationHistoryList(Array.isArray(data.conversations) ? data.conversations : []); } catch (error) { const list = $('conversationHistoryList'); if (list) list.innerHTML = `<div class="conversation-history-empty">无法读取记录：${escapeHtml(error.message)}</div>`; } }
  function toggleConversationHistory(force) { const popover = $('conversationHistoryPopover'); const button = $('conversationHistoryButton'); if (!popover) return; const open = typeof force === 'boolean' ? force : popover.hidden; popover.hidden = !open; button?.setAttribute('aria-expanded', String(open)); if (open) loadConversationHistoryList(); }
  async function loadSharedConversation(id = '', options = {}) {
    let targetId = String(id || readSharedConversationId()).trim();
    try {
      if (!targetId && options.pickLatest !== false) {
        const list = await api('/api/conversations', { headers: { 'Cache-Control': 'no-cache' } });
        targetId = String(list.conversations?.[0]?.id || '').trim();
      }
    } catch {}
    if (!targetId) {
      state.conversationId = '';
      state.messages = [];
      renderSavedConversation([]);
      return null;
    }
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(targetId)}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (options.switchToken && options.switchToken !== conversationRestoreSerial) return null;
      const expectedKey = String(options.productKey || '').trim();
      const currentKey = activeConversationContextKey();
      if (expectedKey && currentKey && expectedKey !== currentKey) return null;
      const conversation = data.conversation || {};
      state.conversationId = conversation.id || targetId;
      state.conversationProductKey = expectedKey || currentKey;
      renderSavedConversation(conversation.messages || []);
      notifySharedConversation(state.conversationId, options.notify !== false);
      if (options.announce) toast('已载入同步对话记录');
      return conversation;
    } catch (error) {
      if (!options.silent) toast(`无法读取对话记录：${error.message}`);
      return null;
    }
  }
  async function startNewSharedConversation() { clearChatAttachments(); try { const data = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '新对话' }) }); const conversation = data.conversation || {}; state.conversationId = conversation.id || ''; state.conversationProductKey = activeConversationContextKey(); clearResourceSelection(); renderSavedConversation([]); notifySharedConversation(state.conversationId); toggleConversationHistory(false); } catch (error) { startNewChat(); toast(`新建同步对话失败：${error.message}`); } }
  function openGptConversation() { const message = { type: 'studio-switch-ui', page: 'gpt-chat', focus: 'conversation', conversationId: state.conversationId || readSharedConversationId() }; if (window.parent && window.parent !== window) postParent(message); else window.location.href = `/static/gpt-chat.html?v=2026.08.14.gpt-sync1${message.conversationId ? `&conversation_id=${encodeURIComponent(message.conversationId)}` : ''}`; }
  async function handleSharedConversationTouch(value) { try { const payload = JSON.parse(String(value || '{}')); const id = String(payload.id || '').trim(); if (!id) { state.conversationId = ''; state.messages = []; rememberConversationForProduct(state.conversationProductKey || state.productKey, ''); renderSavedConversation([]); return; } if (id !== state.conversationId || payload.source !== 'commerce-analysis') await loadSharedConversation(id, { notify: false, silent: true }); else if (payload.source !== 'commerce-analysis') await loadSharedConversation(id, { notify: false, silent: true }); } catch {} }
  function defaultAttachmentPrompt(attachments = []) {
    if (attachments.length === 1) return isChatImageReference(attachments[0]) ? '请分析这张图片。' : '请分析这个附件。';
    return '请分析这些附件。';
  }
  async function sendChat(raw = '', options = {}) {
    const input = $('chatInput');
    const pendingAttachments = Array.isArray(options.attachments) ? options.attachments.slice() : state.chatAttachments.slice();
    if (state.chatAttachmentsUploading) return toast('附件正在上传，请稍候再发送');
    const typedMessage = String(raw || input.value || '').trim();
    const message = typedMessage || (pendingAttachments.length ? defaultAttachmentPrompt(pendingAttachments) : '');
    if (!message) return;
    const merchantMode = state.assistantMode === 'merchant';
    if (!guardCurrentJob()) return;
    const requestTabId = state.activeTabId;
    const requestTab = state.tabs.find((item) => item.id === requestTabId) || null;
    const sitePage = isSiteAssistantTab(requestTab);
    const activeUrl = activeProductUrl();
    const requestKey = conversationContextKey(requestTab);
    const searchPage = isSearchCommerceUrl(activeUrl);
    if (merchantMode && (sitePage || searchPage || !state.jobId)) return toast('经营助手只能基于当前已完成的商品分析任务工作');
    let siteView = sitePage ? activeSiteAssistantView(requestTab) : null;
    if (sitePage) {
      siteView = await captureSiteAssistantContext({ tab: requestTab, force: true });
      if (!siteView) return;
    } else if (searchPage && (!state.pageContext || state.pageContextKey !== productContextKey(activeUrl))) {
      const context = await captureCurrentPageContext({ url: activeUrl });
      if (!context) return;
    }
    if (state.activeTabId !== requestTabId || (requestKey && activeConversationContextKey() !== requestKey)) return;
    const currentKey = activeConversationContextKey();
    if (state.conversationProductKey && currentKey && state.conversationProductKey !== currentKey) {
      if (sitePage) {
        void restoreConversationForProduct(currentKey, { tab: requestTab, emptyMessage: `已切换到新的${siteView?.profile?.title || '页面'}资料，正在恢复该页面对话。`, pageContextPlaceholder: true });
        return toast('页面已切换，正在恢复当前页面的独立对话');
      }
      const switchedSearch = isSearchCommerceUrl(activeUrl);
      resetProductContext(activeUrl, { message: switchedSearch ? '已切换到新的搜索结果页，正在读取当前页面数据。' : '已切换到新商品，正在自动读取商品基础信息。' });
      if (switchedSearch) await captureCurrentPageContext({ url: activeUrl });
      return toast(switchedSearch ? '已切换搜索页，正在重新读取当前结果' : '已切换商品，正在自动读取基础数据');
    }
    if (currentKey) state.conversationProductKey = currentKey;
    const availableResources = resourceItems(currentResult()).filter((item) => item.downloadable);
    const availableIds = new Set(availableResources.map((item) => item.id));
    const explicitIds = Array.isArray(options.resourceIds) ? options.resourceIds : [...state.selectedResourceIds];
    const mentionedIds = mentionedResourceIds(message);
    const merchantResourceIds = resourceItems(currentResult()).filter((item) => item?.id && ['ready', 'partial'].includes(String(item.status || ''))).map((item) => item.id);
    if (!merchantResourceIds.includes('product')) merchantResourceIds.unshift('product');
    const selectedIds = merchantMode ? [...new Set(merchantResourceIds)] : [...new Set([...explicitIds, ...mentionedIds])].filter((id) => availableIds.has(id));
    const selectedResources = merchantMode ? [] : (options.resources || availableResources.filter((item) => selectedIds.includes(item.id)));
    const requestConversationId = state.conversationId;
    // 只有本次消息明确选了资源，才把商品任务交给后端；普通追问不应隐式引用整份快照。
    const requestJobId = merchantMode ? state.jobId : (selectedIds.length ? state.jobId : '');
    const pageContext = merchantMode ? {} : (sitePage ? (options.pageContext || siteView?.context || {}) : searchPage ? (options.pageContext || state.pageContext || {}) : {});
    const requestStillActive = () => state.activeTabId === requestTabId && (!requestKey || activeConversationContextKey() === requestKey);
    const rememberBackgroundConversation = (payload) => {
      const conversation = payload?.conversation || {};
      const id = String(conversation.id || '').trim();
      if (requestKey && id) rememberConversationForProduct(requestKey, id, Array.isArray(conversation.messages) ? conversation.messages : [], requestTab);
    };
    input.value = '';
    state.chatAttachments = [];
    renderChatAttachments();
    appendMessage('user', message, [], pendingAttachments);
    if (selectedResources.length) appendMessage('assistant', `已准备 ${selectedResources.length} 个网页数据资源，下面的分析会引用这些真实内容。`, [], selectedResources);
    clearResourceSelection();
    const box = $('chatMessages'); const streaming = document.createElement('div'); streaming.className = 'chat-message assistant';
    streaming.innerHTML = `<div class="message-avatar">小</div><div class="message-bubble"><div class="md-content message-thinking"><p>${merchantMode ? '经营助手正在核对商品资料和证据…' : (sitePage ? '正在结合当前页面资料整理…' : '正在结合当前商品数据整理…')}</p></div></div>`;
    const answerNode = streaming.querySelector('.md-content'); box.appendChild(streaming); box.scrollTop = box.scrollHeight;
    try {
      const response = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-ID': chatUserId }, body: JSON.stringify({ conversation_id: requestConversationId, message, model: state.chatModel || '', provider: state.chatProvider || '', ms_model: state.chatProvider === 'modelscope' ? state.chatModel || '' : '', reference_images: pendingAttachments, link_job_ids: requestJobId ? [requestJobId] : [], link_resource_ids: selectedIds, page_context: pageContext, skill_id: merchantMode ? '' : (state.skillId || ''), mode: merchantMode ? 'merchant-agent' : 'commerce-analysis' }) });
      if (!response.ok || !response.body) { const data = await response.json().catch(() => ({})); throw new Error(data.detail || data.message || `请求失败（${response.status}）`); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let answer = ''; let streamError = ''; let merchantChanges = []; let completedMessages = null;
      const consumeEvent = (payload) => {
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'meta' && payload.conversation?.id) {
          if (!requestStillActive()) { rememberBackgroundConversation(payload); return; }
          state.conversationId = payload.conversation.id; notifySharedConversation(state.conversationId);
        }
        if (payload.type === 'delta') {
          if (!requestStillActive()) return;
          answer += String(payload.delta || ''); answerNode.innerHTML = renderMarkdownMessage(answer || '正在生成…'); box.scrollTop = box.scrollHeight;
        }
        if (payload.type === 'merchant_change' && payload.change) { merchantChanges = [...merchantChanges.filter((item) => item?.id !== payload.change.id), payload.change]; }
        if (payload.type === 'error') { if (requestStillActive()) streamError = String(payload.detail || payload.message || '模型没有返回内容'); }
        if (payload.type === 'done') {
          if (!requestStillActive()) { rememberBackgroundConversation(payload); return; }
          state.conversationId = payload.conversation?.id || state.conversationId; notifySharedConversation(state.conversationId); if (payload.conversation?.messages) completedMessages = payload.conversation.messages.slice(); if (Array.isArray(payload.message?.merchant_changes)) merchantChanges = payload.message.merchant_changes; if (!answer && payload.message?.content) answer = String(payload.message.content);
        }
      };
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || '';
        events.forEach((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).forEach((line) => { try { consumeEvent(JSON.parse(line.slice(5).trim())); } catch {} }));
      }
      if (buffer.trim()) buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).forEach((line) => { try { consumeEvent(JSON.parse(line.slice(5).trim())); } catch {} });
      if (!requestStillActive()) return;
      if (streamError) throw new Error(streamError);
      answer = answer.trim() || '当前模型没有返回内容。'; answerNode.classList.remove('message-thinking'); answerNode.innerHTML = renderMarkdownMessage(answer); appendMerchantChangeCards(streaming, merchantChanges); if (completedMessages) state.messages = completedMessages; else state.messages.push({ role: 'assistant', content: answer, merchant_changes: merchantChanges }); rememberConversationForProduct(requestKey, state.conversationId, state.messages, requestTab); renderChatHistory();
    } catch (error) { if (!requestStillActive()) return; streaming.remove(); appendMessage('assistant', `暂时无法调用模型：${error.message}`); }
  }
  function reportHtml(tab = state.reportTab) {
    const result = currentResult();
    if (!result && tab !== 'agent') return '<div class="empty-report">还没有可查看的完整报告。先打开商品页并开始分析。</div>';
    const product = result?.product || {};
    const reviews = result?.reviews || [];
    const questions = result?.questions || [];
    const videos = result?.videos || [];
    const detail = result?.detail || {};
    const ops = result?.operations || {};
    const people = result?.peopleStructure || result?.audience || result?.people || {};
    const peopleItems = Array.isArray(people) ? people : Array.isArray(people?.items) ? people.items : Array.isArray(people?.groups) ? people.groups.flatMap((group) => Array.isArray(group?.rows) ? group.rows : []) : [];
    const collection = result?.collection || {};
    const statuses = result?.moduleStatus || {};
    if (tab === 'overview') {
      const q = result.quality || result.analysis?.coverage || {};
      const auditRows = moduleOrder.map((key) => {
        const item = statuses[key] || {};
        const sample = item.realResponseSampleCount ?? item.sampleCount ?? 0;
        return `<tr><td>${escapeHtml(moduleLabels[key] || key)}</td><td>${escapeHtml(resourceStatusLabel(item))}</td><td>总量 ${escapeHtml(text(item.totalCount, '未返回'))} · 真实样本 ${escapeHtml(text(sample, '0'))}</td><td>${escapeHtml((item.sourceStepIds || []).join('、') || '未记录')}</td></tr>`;
      }).join('');
      return `<div class="report-grid"><article class="report-card"><h3>采集状态</h3><div class="metric-big">${escapeHtml(text(result.status))}</div><p>${escapeHtml(text(result.message))}</p></article><article class="report-card"><h3>数据覆盖</h3><div class="metric-big">${q.coveragePercent != null ? `${q.coveragePercent}%` : '—'}</div><p>证据 ${q.evidenceCount || 0} 条 · 模块 ${q.moduleCount || 0} 个</p></article><article class="report-card"><h3>商品身份</h3><p><strong>${escapeHtml(text(product.title))}</strong><br>商品 ID：${escapeHtml(text(result.productId || collection.productId || product.id, '未返回'))}<br>规范化链接：${escapeHtml(text(result.normalizedUrl || collection.normalizedUrl, '未返回'))}<br>采集时间：${escapeHtml(text(result.collectedAt || collection.collectedAt || collection.receivedAt, '未返回'))}</p></article><article class="report-card"><h3>下一步建议</h3><ul class="report-list">${(result.analysis?.priorities || ['可继续在右侧问问小美追问']).slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article></div><article class="report-card report-audit-card"><h3>模块核验</h3><p>每条评价和问大家样本均保留对应证据 ID；来源步骤仅记录动作和计数，不保存 Cookie、Token 或原始响应。</p><table class="report-table"><thead><tr><th>模块</th><th>状态</th><th>计数</th><th>来源步骤</th></tr></thead><tbody>${auditRows}</tbody></table></article>`;
    }
    if (tab === 'reviews') {
      const reviewState = statuses.reviews || {};
      const questionState = statuses.questions || {};
       const rows = [
        ...reviews.slice(0, 50).map((item, index) => { const audit = item.audit || item; const evidenceId = item.evidenceId || audit.evidenceId || `reviews:${index + 1}`; const stepIds = audit.sourceStepIds || reviewState.sourceStepIds || []; return `<tr><td>评价</td><td>${escapeHtml(item.content || item.text || '未返回')}</td><td>${escapeHtml(item.rating || '')}</td><td>${escapeHtml(evidenceId)}</td><td>${escapeHtml(stepIds.join('、') || '未记录')}</td></tr>`; }),
        ...questions.slice(0, 30).map((item, index) => { const audit = item.audit || item; const evidenceId = item.evidenceId || audit.evidenceId || `questions:${index + 1}`; const stepIds = audit.sourceStepIds || questionState.sourceStepIds || []; return `<tr><td>问大家</td><td>${escapeHtml(item.question || item.text || '未返回')}</td><td>${escapeHtml(item.answer || '未回答')}</td><td>${escapeHtml(evidenceId)}</td><td>${escapeHtml(stepIds.join('、') || '未记录')}</td></tr>`; }),
      ].join('');
      return `<div class="report-card"><h3>评价真实样本 ${reviews.length} 条 · 问大家真实样本 ${questions.length} 条</h3><p class="report-audit-note">评价：页面总量 ${escapeHtml(text(reviewState.totalCount, '未返回'))}，真实响应样本 ${escapeHtml(text(reviewState.realResponseSampleCount, '0'))}；问大家：页面总量 ${escapeHtml(text(questionState.totalCount, '未返回'))}，真实响应样本 ${escapeHtml(text(questionState.realResponseSampleCount, '0'))}。</p><table class="report-table"><thead><tr><th>类型</th><th>内容</th><th>评分/回答</th><th>证据 ID</th><th>来源步骤</th></tr></thead><tbody>${rows || '<tr><td colspan="5">当前模块没有真实样本；未使用演示数据。</td></tr>'}</tbody></table></div>`;
    }
    if (tab === 'images') { const images = result.mainImages || result.images || []; return `<div class="report-grid">${images.length ? images.map((url, index) => `<article class="report-card"><h3>主图 ${index + 1}</h3><img src="${escapeHtml(url)}" alt="主图 ${index + 1}" style="width:100%;max-height:340px;object-fit:contain;border-radius:8px;background:#f4f6fa" /></article>`).join('') : '<div class="empty-report">当前页面未返回主图</div>'}</div>`; }
    if (tab === 'detail') return `<article class="report-card"><h3>详情页图文</h3><p>${escapeHtml(text(detail.text))}</p><p style="margin-top:12px">详情图片：${detail.images?.length || result.detailImages?.length || 0} 张</p></article>`;
    if (tab === 'videos') return videos.length ? `<div class="report-grid">${videos.map((item, index) => `<article class="report-card"><h3>视频 ${index + 1}</h3><a class="video-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a><p>来源：${escapeHtml(item.source || '商品页可见资源')}</p></article>`).join('')}</div>` : '<div class="empty-report">当前页面未返回视频，不伪造结果。</div>';
    if (tab === 'sku') return `<article class="report-card"><h3>SKU / 规格</h3><p>${escapeHtml(result.sku?.text || '当前页面未返回可选规格')}</p><pre class="ops-raw">${escapeHtml(JSON.stringify(result.sku || {}, null, 2))}</pre></article>`;
    return `<div class="report-grid"><article class="report-card"><h3>运营数据报表</h3><div class="metric-big">${escapeHtml(text(ops.status, '未捕获'))}</div><p>${escapeHtml(text(ops.message, '先在千牛/生意参谋打开运营报表，再读取当前页面或导入官方 CSV。'))}</p><div class="report-button-row"><button class="primary-button" id="captureOperationsButton" type="button">读取当前页面</button><button class="ghost-button" id="importOperationsButton" type="button">导入官方 CSV</button></div></article><article class="report-card"><h3>人群结构数据</h3><div class="metric-big">${peopleItems.length ? `已捕获 ${peopleItems.length} 行` : '未捕获'}</div><p>${escapeHtml(peopleItems.length ? '已按人群维度整理，可下载达笔兼容结构 CSV。' : '进入生意参谋的人群/商品分析页面后读取，或导入官方 CSV。')}</p><div class="report-button-row"><button class="primary-button" id="capturePeopleButton" type="button">读取当前页面</button><button class="ghost-button" id="importPeopleButton" type="button">导入官方 CSV</button></div></article><article class="report-card"><h3>捕获记录</h3><pre class="ops-raw">${escapeHtml(JSON.stringify(ops.items || (state.operation ? [state.operation] : []), null, 2))}</pre></article><article class="report-card"><h3>人群结构明细</h3><pre class="ops-raw">${escapeHtml(JSON.stringify(people || {}, null, 2))}</pre></article></div>`;
  }
  function renderReport() { $('reportBody').innerHTML = reportHtml(); $('reportSummary').textContent = currentResult()?.message || '基于当前实际采集结果，未返回的字段会明确标注。'; q('#reportTabs button').forEach((button) => button.classList.toggle('is-active', button.dataset.reportTab === state.reportTab)); $('captureOperationsButton')?.addEventListener('click', () => captureMerchantReport('operations', 'page')); $('importOperationsButton')?.addEventListener('click', () => captureMerchantReport('operations', 'file')); $('capturePeopleButton')?.addEventListener('click', () => captureMerchantReport('people', 'page')); $('importPeopleButton')?.addEventListener('click', () => captureMerchantReport('people', 'file')); }
  function openReport(tab = 'overview') { state.reportTab = tab; renderReport(); $('reportDrawer').classList.add('is-open'); $('reportDrawer').setAttribute('aria-hidden', 'false'); setCommerceNativeOverlayActive(true); }
  function closeReport() { $('reportDrawer').classList.remove('is-open'); $('reportDrawer').setAttribute('aria-hidden', 'true'); setCommerceNativeOverlayActive(false); }
  function moduleReady(module, result = currentResult()) {
    if (!result) return false;
    if (module === 'operations') return Boolean(result.operations?.items?.length);
    if (module === 'people') {
      const people = result.peopleStructure || result.audience || result.people || {};
      return Boolean((Array.isArray(people) ? people : Array.isArray(people.items) ? people.items : Array.isArray(people.groups) ? people.groups.flatMap((group) => Array.isArray(group?.rows) ? group.rows : []) : []).length);
    }
    const hasSamples = (key) => {
      const status = result.moduleStatus?.[key] || {};
      const observed = Array.isArray(result[key]) ? result[key].length : 0;
      const realResponse = Number(status.realResponseSampleCount || 0);
      const statusName = String(status.status || '').trim().toLowerCase();
      // 已有真实样本即可直接分析。不要因为状态是 captured/stopped，或因为
      // 页面总量大于本次样本而再次启动同一模块采集。
      return (observed > 0 || (Number.isFinite(realResponse) && realResponse > 0))
        && !['queued', 'running', 'failed', 'login_required', 'verification_required'].includes(statusName);
    };
    if (module === REVIEW_QUESTIONS_COLLECTION_MODULE) return hasSamples('reviews') && hasSamples('questions');
    if (module === 'reviews' || module === 'questions') return hasSamples(module);
    return ['ready', 'partial'].includes(result.moduleStatus?.[module]?.status);
  }
  async function runQuickAnalysis(module) {
    const prompt = quickPrompts[module]; if (!prompt) return;
    const ids = module === 'reviews' ? ['reviews', 'questions'] : [module];
    setSelectedResourceIds(['product', ...ids]);
    const resources = resourceItems(currentResult()).filter((item) => ids.includes(item.id) && item.downloadable);
    await sendChat(prompt, { resources, resourceIds: ids });
  }
  async function runSearchQuickAnalysis(module) {
    const url = activeProductUrl();
    if (!isSearchCommerceUrl(url)) return toast('请先打开淘宝搜索结果页');
    const context = await captureCurrentPageContext({ url });
    if (!context) return;
    const prompt = searchPrompts[module];
    if (!prompt) return;
    await sendChat(prompt, { pageContext: context });
  }
  async function waitForQuickCollection(module, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (moduleReady(module)) return true;
      if (!state.jobId) {
        if (state.analysisStarting) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        return false;
      }
      try {
        const job = await api(`/api/commerce-analysis/jobs/${encodeURIComponent(state.jobId)}`);
        if (!renderJob(job)) return false;
        if (!['queued', 'running'].includes(job.status)) return moduleReady(module);
      } catch (error) {
        toast(`等待商品数据采集失败：${error.message}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return moduleReady(module);
  }
  async function ensureQuickAnalysisCollection(module) {
    if (module !== 'reviews') {
      if (moduleReady(module)) return true;
      const started = state.jobId ? await retryModule(module) : await startAnalysis(false, module);
      if (!started && !state.jobId) return false;
      if (moduleReady(module)) return true;
      if (['queued', 'running'].includes(state.job?.status)) await waitForQuickCollection(module);
      return moduleReady(module);
    }
    const missingModules = ['reviews', 'questions'].filter((key) => !moduleReady(key));
    if (!missingModules.length) return true;
    // 只补采缺失模块。尤其是评价已经有样本、问大家尚未采集时，不能
    // 再把“评价和问大家”作为组合任务提交，否则会重复点击并采集评价。
    const collectionModule = missingModules.length === 1 ? missingModules[0] : REVIEW_QUESTIONS_COLLECTION_MODULE;
    if (!state.jobId && state.analysisStarting) {
      await waitForQuickCollection(collectionModule);
      if (!['reviews', 'questions'].some((key) => !moduleReady(key))) return true;
    }
    if (state.jobId && ['queued', 'running'].includes(state.job?.status)) {
      await waitForQuickCollection(collectionModule);
      if (!['reviews', 'questions'].some((key) => !moduleReady(key))) return true;
    }
    const started = state.jobId
      ? await retryModule(collectionModule)
      : await startAnalysis(false, collectionModule);
    if (!started && !state.jobId) return false;
    if (!['reviews', 'questions'].some((key) => !moduleReady(key))) return true;
    if (['queued', 'running'].includes(state.job?.status)) await waitForQuickCollection(collectionModule);
    return moduleReady('reviews') && moduleReady('questions');
  }
  async function quickAction(module) {
    if (!guardCurrentJob()) return;
    if (['operations', 'people'].includes(module) && !moduleReady(module)) {
      const shell = shellApi();
      const site = module === 'people' ? 'sycm' : 'qianniu';
      const label = site === 'sycm' ? '生意参谋' : '千牛工作台';
      const url = site === 'sycm' ? 'https://sycm.taobao.com/' : 'https://myseller.taobao.com/';
      if (shell?.openSeller) { const tab = openCommerceTab(url, label, { newTab: true, kind: 'seller', site, load: false }); await shell.openSeller(site, tab?.id); toast(`已打开${label}，请手动登录并进入${module === 'people' ? '人群/商品分析' : '运营报表'}页面`); }
      else toast(`${label}页面仅支持小美画布桌面版内置浏览器；可导入官方导出的报表文件`);
      openReport('operations'); return;
    }
    if (module === 'reviews') {
      const ready = await ensureQuickAnalysisCollection(module);
      if (ready) return runQuickAnalysis(module);
      if (state.job?.status === 'needs_login') return toast(`请先在${activeCommerceLoginTarget().label}页面完成登录/验证，再重新分析评价和问大家`);
      return toast('评价和问大家未能完整采集，请检查商品页后重试');
    }
    if (!state.jobId) {
      const started = await startAnalysis(false, module);
      if (!started) return;
    }
    if (moduleReady(module)) return runQuickAnalysis(module);
    if (['queued', 'running'].includes(state.job?.status)) return toast('商品数据仍在采集中，完成后再点击一次快捷分析');
    await retryModule(module);
  }
  async function captureMerchantReport(kind = 'operations', mode = 'page') {
    const normalizedKind = kind === 'people' || kind === 'audience' ? 'audience' : 'operations';
    const shell = shellApi();
    try {
      let data = null;
      if (mode === 'file' && shell?.importMerchantReport) data = await shell.importMerchantReport(normalizedKind);
      else if (mode !== 'file' && shell?.captureMerchantReport) data = await shell.captureMerchantReport(normalizedKind);
      else if (mode !== 'file' && normalizedKind === 'operations' && shell?.captureOperations) data = await shell.captureOperations();
      else {
        const textValue = window.prompt(`粘贴${normalizedKind === 'audience' ? '人群结构' : '运营'}页面或官方 CSV 数据（不会保存 Cookie 或密码）`, '');
        if (!textValue) return;
        data = { kind: normalizedKind, source: 'official-export', backend: 'edge', url: '', title: '浏览器手动导入', text: textValue, metrics: {}, tables: [] };
      }
      if (!data?.ok) return data?.canceled ? null : toast(data?.message || '当前页面无法读取报表数据');
      await saveMerchantReport(normalizedKind, data);
    } catch (error) {
      toast(error.message);
    }
  }
  async function saveMerchantReport(kind, data) {
    try {
      const response = await api('/api/commerce-analysis/reports/capture', { method: 'POST', body: JSON.stringify({ ...data, kind, job_id: state.jobId || '' }) });
      state.operation = response.record || state.operation;
      if (response.result) {
        state.result = response.result;
        state.job = { ...(state.job || {}), id: state.jobId || response.result.jobId || '', result: response.result, message: response.result.message || '' };
        state.jobId = state.jobId || response.result.jobId || '';
        renderInfo(state.result); renderModules(state.result); renderResources(state.result);
        rememberProductAnalysisForTab();
      }
      toast(kind === 'audience' ? '人群结构数据已捕获并生成兼容 CSV' : '运营数据已捕获并生成兼容 CSV');
      openReport('operations');
    } catch (error) {
      toast(error.message);
    }
  }
  async function captureOperations() { return captureMerchantReport('operations', 'page'); }
  async function saveOperations(data) { return saveMerchantReport('operations', data); }
  function exportText(filename, content, type = 'application/json') { const blob = new Blob([content], { type }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 500); }
  function exportReport() { const result = currentResult(); if (!result) return toast('暂无可导出的报告'); exportText(`商品分析-${state.jobId || 'report'}.json`, JSON.stringify(result, null, 2)); }
  function exportVerification(format) { if (!currentResult() || !state.jobId) return toast('暂无可下载的核验快照'); const url = verificationDownloadUrl(format); if (!url) return toast('核验文件地址不可用'); const link = document.createElement('a'); link.href = url; link.download = ''; link.click(); }
  function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`; }
  function exportCsv() { const result = currentResult(); if (!result) return toast('暂无可导出的报告'); const rows = [['类型', '内容', '评分/回答', '来源']]; (result.reviews || []).forEach((item) => rows.push(['评价', item.content || item.text || '', item.rating || '', result.finalUrl || result.originalUrl || state.url])); (result.questions || []).forEach((item) => rows.push(['问大家', item.question || item.text || '', item.answer || '', result.finalUrl || result.originalUrl || state.url])); (result.sku?.items || []).filter((item) => item && (item.id || item.skuId || item.sku_id) && (item.propPath || item.prop_path || item.specs || item.specText)).forEach((item) => rows.push(['SKU列表', item.sku_name || item.skuName || item.name || item.id || '', Array.isArray(item.specs) ? item.specs.map((spec) => `${spec.name || ''}:${spec.value || ''}`).join('; ') : item.specText || item.specs || '', result.finalUrl || state.url])); (result.operations?.items || []).forEach((item) => rows.push(['运营数据', item.title || item.source || '', item.text || JSON.stringify(item.metrics || {}), item.url || ''])); exportText(`商品分析-${state.jobId || 'report'}.csv`, `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`, 'text/csv;charset=utf-8'); }
  function exportMarkdown() {
    const result = currentResult();
    if (!result) return toast('暂无可导出的报告');
    const product = result.product || {};
    const lines = ['# 商品分析报告', '', `- 标题：${product.title || '未返回'}`, `- 价格：${product.price || '未返回'}`, `- 店铺：${product.store || '未返回'}`, `- 状态：${result.status || 'unknown'}`, '', '## 模块状态', ...Object.entries(result.moduleStatus || {}).map(([key, value]) => `- ${moduleLabels[key] || key}：${value.status || 'missing'}（样本 ${value.sampleCount || 0}）`), '', '## 采集说明', result.message || '未返回'];
    exportText(`商品分析-${state.jobId || 'report'}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
  function exportChat() { if (!state.messages.length) return toast('暂无对话记录'); exportText(`问问小美-${state.jobId || 'chat'}.json`, JSON.stringify({ conversationId: state.conversationId, jobId: state.jobId, messages: state.messages }, null, 2)); }
  function importResult(file) { const reader = new FileReader(); reader.onload = async () => { try { const data = JSON.parse(reader.result); const importUrl = state.url || $('productUrl').value.trim(); syncProductContext(importUrl); const result = await api('/api/commerce-analysis/import', { method: 'POST', body: JSON.stringify({ url: importUrl, data, filename: file.name }) }); state.result = result; state.jobId = result.jobId || ''; renderInfo(result); renderModules(result); renderJob({ id: state.jobId, status: result.status, message: result.message, result }); toast('商品分析结果已导入'); } catch (error) { toast(error.message); } }; reader.readAsText(file, 'utf-8'); }

  // 商品分析台内部桌面：真实入口、真实任务、真实素材库和真实 Skills，不修改外层应用导航。
  let desktopDrawerRequest = 0;
  function setRailActive(nav) { q('.rail-item').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === nav)); }
  function desktopTimeText(value) { try { return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(value); } catch { return ''; } }
  function updateDesktopClock() { const now = new Date(); const clock = $('desktopClock'); const date = $('desktopDate'); if (clock) clock.textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); if (date) date.textContent = desktopTimeText(now); }
  function analysisDesktopVisible() { return !$('analysisDesktop')?.hidden; }
  function syncProductViewVisibility() {
    const tab = activeCommerceTab();
    const visible = Boolean(tab?.type === 'commerce' && !analysisDesktopVisible());
    setProductViewVisible(visible, tab?.id || state.activeTabId);
  }
  function showAnalysisDesktop(drawerKind = '', activeNav = 'desktop') {
    const home = $('analysisDesktop'); if (!home) return;
    if (activeCommerceTab()?.type !== 'analysis') activateCommerceTab('analysis', { load: false });
    setAssistantVisible(false);
    home.hidden = false; home.setAttribute('aria-hidden', 'false'); setRailActive(activeNav); updateDesktopClock();
    syncProductViewVisibility();
    if (drawerKind) openDesktopDrawer(drawerKind); else closeDesktopDrawer();
  }
  function hideAnalysisDesktop(options = {}) {
    const home = $('analysisDesktop'); if (!home) return;
    home.hidden = true; home.setAttribute('aria-hidden', 'true'); closeDesktopDrawer();
    if (!options.keepProductHidden) syncProductViewVisibility();
    setTimeout(emitBounds, 50);
  }
  function conciseUrl(value) { try { const parsed = new URL(String(value || '')); return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`; } catch { return String(value || '商品分析任务'); } }
  function formatJobTime(value) { const date = value ? new Date(value) : null; if (!date || Number.isNaN(date.getTime())) return ''; try { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); } catch { return ''; } }
  function desktopJobRow(job, compact = false) {
    const title = conciseUrl(job.url); const status = String(job.status || 'unknown').toLowerCase(); const message = text(job.message || job.stage, '等待采集');
    return `<button class="desktop-${compact ? 'job-row' : 'data-row'}" type="button" data-open-job="${escapeHtml(job.id)}"><span class="${compact ? 'desktop-job-dot' : 'desktop-data-row-icon'} ${escapeHtml(status)}">${compact ? '' : '⌁'}</span>${compact ? `<strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><time>${escapeHtml(formatJobTime(job.updated_at || job.created_at))}</time>` : `<span class="desktop-data-row-main"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small>${escapeHtml(message)}</small></span><span class="desktop-data-row-action">查看报告</span>`}</button>`;
  }
  function closeDesktopDrawer() {
    const drawer = $('desktopDrawer'); if (!drawer) return;
    drawer.hidden = true; drawer.setAttribute('aria-hidden', 'true');
    drawer.classList.remove('is-full-page');
    drawer.removeAttribute('data-desktop-view');
    const close = $('desktopDrawerClose');
    if (close) { close.textContent = '×'; close.setAttribute('aria-label', '关闭'); close.removeAttribute('title'); }
    window.XiaomeiSkillMarket?.close?.();
  }
  function openDesktopDrawer(kind) {
    const drawer = $('desktopDrawer'); if (!drawer) return; drawer.hidden = false; drawer.setAttribute('aria-hidden', 'false');
    const fullPage = kind === 'skills' || kind === 'tasks';
    drawer.classList.toggle('is-full-page', fullPage);
    drawer.dataset.desktopView = kind;
    const close = $('desktopDrawerClose');
    if (close) {
      close.textContent = fullPage ? '← 返回工作应用' : '×';
      close.setAttribute('aria-label', fullPage ? '返回工作应用' : '关闭');
      if (fullPage) close.setAttribute('title', '返回工作应用'); else close.removeAttribute('title');
    }
    const request = ++desktopDrawerRequest; const body = $('desktopDrawerBody'); body.classList.toggle('is-task-manager', kind === 'tasks'); body.innerHTML = '<div class="desktop-drawer-empty">正在读取本地数据…</div>';
    if (kind === 'files') renderDesktopFiles(request); else if (kind === 'skills') renderDesktopSkills(request); else renderDesktopTasks(request);
  }
  function switchDesktopTaskView(view = 'scheduled') {
    const next = view === 'commerce' ? 'commerce' : 'scheduled';
    q('[data-task-view]').forEach((button) => {
      const active = button.dataset.taskView === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    q('[data-task-panel]').forEach((panel) => { panel.hidden = panel.dataset.taskPanel !== next; });
  }
  async function renderDesktopTasks(request) {
    $('desktopDrawerEyebrow').textContent = 'TASK CENTER'; $('desktopDrawerTitle').textContent = '任务管理'; $('desktopDrawerDescription').textContent = '在商品分析台统一管理定时任务和商品采集任务。';
    const body = $('desktopDrawerBody');
    if (!body || request !== desktopDrawerRequest) return;
    body.innerHTML = `<div class="desktop-task-center">
      <div class="desktop-task-tabs" role="tablist" aria-label="任务类型">
        <button type="button" class="desktop-task-tab is-active" data-task-view="scheduled" role="tab" aria-selected="true">定时任务</button>
        <button type="button" class="desktop-task-tab" data-task-view="commerce" role="tab" aria-selected="false">商品采集任务</button>
      </div>
      <section class="desktop-task-panel" data-task-panel="scheduled" role="tabpanel">
        <iframe id="desktopTaskManagerFrame" class="desktop-task-manager-frame" src="/static/task-manager.html?v=2026.09.04.task-management-page2" title="定时任务管理" loading="eager"></iframe>
      </section>
      <section class="desktop-task-panel" data-task-panel="commerce" role="tabpanel" hidden>
        <div id="desktopCommerceTaskList" class="desktop-data-list"><div class="desktop-drawer-empty">正在读取商品采集任务…</div></div>
      </section>
    </div>`;
    switchDesktopTaskView('scheduled');
    try {
      const data = await api('/api/commerce-analysis/jobs?limit=60');
      if (request !== desktopDrawerRequest) return;
      const items = Array.isArray(data.items) ? data.items : [];
      const list = $('desktopCommerceTaskList');
      if (!list) return;
      list.innerHTML = items.length
        ? items.map((job) => desktopJobRow(job)).join('')
        : '<div class="desktop-drawer-empty">还没有商品采集任务。打开淘宝、天猫或 1688 商品页并点击“开始分析”即可创建。</div>';
    } catch (error) {
      if (request === desktopDrawerRequest) {
        const list = $('desktopCommerceTaskList');
        if (list) list.innerHTML = `<div class="desktop-drawer-empty">无法读取商品采集任务：${escapeHtml(error.message)}</div>`;
      }
    }
  }
  function flattenAssetLibrary(library) {
    const rows = []; (library?.libraries || []).forEach((group) => (group.categories || []).forEach((category) => {
      const items = Array.isArray(category.items) ? category.items : []; rows.push({ library: group.name || '素材库', category: category.name || '未分类', count: items.length, items });
    })); return rows;
  }
  async function renderDesktopFiles(request) {
    $('desktopDrawerEyebrow').textContent = 'LOCAL ASSETS'; $('desktopDrawerTitle').textContent = '文件系统'; $('desktopDrawerDescription').textContent = '展示本机素材库的真实分类和数量；不会上传或覆盖你的素材。';
    try {
      const data = await api('/api/asset-library'); if (request !== desktopDrawerRequest) return;
      const groups = flattenAssetLibrary(data.library); const total = groups.reduce((sum, group) => sum + group.count, 0);
      const list = groups.filter((group) => group.count > 0).slice(0, 18);
      $('desktopDrawerBody').innerHTML = list.length ? `<div class="desktop-data-list">${list.map((group) => `<button type="button" class="desktop-data-row" data-open-assets="1"><span class="desktop-data-row-icon">▱</span><span class="desktop-data-row-main"><strong>${escapeHtml(group.category)}</strong><small>${escapeHtml(group.library)} · ${group.count} 个素材</small></span><span class="desktop-data-row-action">打开素材库</span></button>`).join('')}</div><div class="desktop-drawer-footer"><button type="button" class="primary-button" data-open-assets="1">打开完整素材库（${total} 个素材）</button></div>` : '<div class="desktop-drawer-empty">当前素材库还没有可显示的素材。</div>';
    } catch (error) { if (request === desktopDrawerRequest) $('desktopDrawerBody').innerHTML = `<div class="desktop-drawer-empty">无法读取素材库：${escapeHtml(error.message)}</div>`; }
  }
  async function renderDesktopSkills(request) {
    const body = $('desktopDrawerBody');
    if (!body || request !== desktopDrawerRequest) return;
    state.skillId = readSharedSkillId() || state.skillId;
    if (window.XiaomeiSkillMarket?.open) {
      await window.XiaomeiSkillMarket.open({
        body,
        selectedId: state.skillId,
        notify: (message) => message && toast(message),
        onSelected: (id, skill) => {
          state.skillId = String(id || '').trim();
          const shared = window.StudioSharedSkill;
          if (shared?.setSelected && shared.getSelected?.() !== state.skillId) shared.setSelected(state.skillId);
        },
      });
      return;
    }
    $('desktopDrawerEyebrow').textContent = 'AVAILABLE SKILLS'; $('desktopDrawerTitle').textContent = '技能市场'; $('desktopDrawerDescription').textContent = '从已安装的真实 Skill 列表中选择一个，后续“问问小美”将带上它的受控指令。';
    try {
      const data = await api('/api/agent-skills'); if (request !== desktopDrawerRequest) return;
      const skills = (Array.isArray(data.skills) ? data.skills : []).filter((skill) => skill && skill.enabled !== false).slice(0, 60);
      $('desktopDrawerBody').innerHTML = skills.length ? `<div class="desktop-data-list">${skills.map((skill) => { const id = String(skill.id || skill.slug || ''); const selected = id && id === state.skillId; return `<button type="button" class="desktop-data-row" data-select-skill="${escapeHtml(id)}"><span class="desktop-data-row-icon">✦</span><span class="desktop-data-row-main"><strong>${escapeHtml(skill.display_name || skill.name || id)}</strong><small>${escapeHtml(skill.description || skill.category_label || '可用于商品研究对话')}</small></span>${selected ? '<span class="desktop-skill-selected">已选择</span>' : '<span class="desktop-data-row-action">选择</span>'}</button>`; }).join('')}</div>` : '<div class="desktop-drawer-empty">当前没有已启用的 Skill。可在技能管理中安装或启用。</div>';
    } catch (error) { if (request === desktopDrawerRequest) $('desktopDrawerBody').innerHTML = `<div class="desktop-drawer-empty">无法读取 Skill：${escapeHtml(error.message)}</div>`; }
  }
  async function openSavedJob(id) {
    if (!id) return; try { const job = await api(`/api/commerce-analysis/jobs/${encodeURIComponent(id)}`); const sourceUrl = job.url || resultSourceUrl(job.result); if (sourceUrl && isDetailCommerceUrl(sourceUrl)) { const tab = openCommerceTab(sourceUrl, '商品详情', { newTab: true, kind: 'detail', load: false }); const shell = shellApi(); if (tab && shell?.openProduct) Promise.resolve(shell.openProduct(sourceUrl, tab.id)).catch((error) => toast(error.message)); } else if (sourceUrl) { syncProductContext(sourceUrl); $('productUrl').value = sourceUrl; state.embeddedUrl = sourceUrl; } if (!renderJob(job)) return toast('这条报告不属于当前商品，已阻止混用'); hideAnalysisDesktop(); openReport('overview'); toast('已打开这条商品分析报告'); } catch (error) { toast(error.message); }
  }
  function openOuterAssets() { closeDesktopDrawer(); postParent({ type: 'studio-switch-ui', page: 'asset-manager' }); }
  function selectDesktopSkill(id) {
    const next = String(id || '').trim(); if (!next) return;
    state.skillId = next;
    if (window.StudioSharedSkill?.setSelected) window.StudioSharedSkill.setSelected(next);
    else { try { localStorage.setItem(SHARED_SKILL_SELECTION_KEY, next); } catch {} }
    toast('已选择 Skill，后续问问小美会带上它');
  }
  async function openSellerFromDesktop(site) {
    try {
      const shell = shellApi();
      const label = site === 'sycm' ? '生意参谋' : '千牛工作台';
      const url = site === 'sycm' ? 'https://sycm.taobao.com/' : 'https://myseller.taobao.com/';
      if (!shell?.openSeller) return toast(`${label}页面仅支持小美画布桌面版内置浏览器`);
      const tab = openCommerceTab(url, label, { newTab: true, kind: 'seller', site, load: false });
      await shell.openSeller(site, tab?.id);
      hideAnalysisDesktop();
      toast(`${label}已打开，请手动登录`);
    } catch (error) { toast(error.message); }
  }
  async function openPlatformFromDesktop(appId) {
    const platformId = String(appId || '').trim().toLowerCase();
    // 淘宝首页是工作台的固定入口，但不属于商品分析平台定义：把它
    // 作为平台页打开，避免复用“商品链接”占位逻辑后停在空白区域。
    const platform = desktopPlatformDefinitions[platformId] || (platformId === 'taobao' ? taobaoHomePlatform : null);
    if (!platform) return;
    try {
      const shell = shellApi();
      const officialUrl = safeCommerceUrl(platform.url);
      if (!officialUrl) return;
      // 淘宝首页入口必须幂等：重复点击时复用已有官方首页标签，
      // 不再生成多个同名标签造成“打开了但看不到当前页面”的错觉。
      if (platformId === 'taobao') {
        const existing = state.tabs.find((item) => item?.type === 'commerce'
          && item.kind !== 'detail'
          && (item.platform === 'taobao' || item.site === 'taobao' || isTaobaoHomeUrl(item.url) || isTaobaoHomeUrl(item.requestedUrl)));
        if (existing) {
          existing.kind = 'platform';
          existing.platform = 'taobao';
          existing.site = 'taobao';
          existing.productUrl = '';
          state.url = safeCommerceUrl(existing.url || existing.requestedUrl) || officialUrl;
          state.productUrl = '';
          state.embeddedUrl = state.url;
          if ($('productUrl')) $('productUrl').value = state.url;
          hideAnalysisDesktop();
          activateCommerceTab(existing.id);
          toast(`${platform.label}已打开`);
          return;
        }
      }
      state.url = officialUrl;
      state.productUrl = '';
      state.embeddedUrl = officialUrl;
      if ($('productUrl')) $('productUrl').value = officialUrl;
      // 先切出工作台首页，避免原生 WebContentsView 已加载但被首页覆盖。
      hideAnalysisDesktop();
      if (!shell?.openProduct) {
        openCommerceTab(officialUrl, platform.label, { newTab: true, kind: 'platform', platform: platform.id, site: platform.id, load: false });
        return toast(`${platform.label}页面仅支持小美画布桌面版内置浏览器`);
      }
      const tab = openCommerceTab(officialUrl, platform.label, { newTab: true, kind: 'platform', platform: platform.id, site: platform.id, load: false });
      if (!tab) return;
      await shell.openProduct(officialUrl, tab.id);
      toast(`${platform.label}已打开`);
    } catch (error) { toast(error.message); }
  }
  function routeDesktopApp(appId) {
    if (appId === 'taobao' || desktopPlatformDefinitions[appId]) { openPlatformFromDesktop(appId); return; }
    if (appId === 'qianniu' || appId === 'sycm') { openSellerFromDesktop(appId); return; }
    if (appId === 'ai') { openGptConversation(); return; }
    if (appId === 'files' || appId === 'skills' || appId === 'tasks') { showAnalysisDesktop(appId, appId); }
  }
  function filterDesktopApps(value) { const needle = String(value || '').trim().toLowerCase(); q('[data-desktop-app]').forEach((button) => { if (!button.classList.contains('desktop-app-card')) return; button.classList.toggle('is-filtered', Boolean(needle) && !String(button.dataset.search || '').toLowerCase().includes(needle)); }); }
  function wire() {
    const shell = shellApi();
    // Skill 是聊天区的独立入口，提前绑定，避免旧版桌面页面缺少其它可选控件时
    // 中断后续初始化，导致按钮可见但点击无反应。
    $('skillPicker')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAssistantSkillPicker();
    });
    updateAssistantSkillButton();
    $('agentStopButton')?.addEventListener('click', async () => {
      if (!shell?.stopCollection) return toast('当前采集不在桌面端内置浏览器中，请等待任务结束或在任务列表重试');
      try {
        const result = await shell.stopCollection();
        if (!result?.ok) toast(result?.message || '当前没有正在运行的桌面智能体');
      } catch (error) { toast(error.message || '停止桌面智能体失败'); }
    });
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || (event.origin && event.origin !== location.origin)) return;
    if (event.data?.type === 'commerce-shell-layout') { syncProductViewVisibility(); requestBoundsUpdate(); syncDesktopSurfaceState(); }
    });
    $('openProduct').onclick = () => openProduct(); $('productUrl').onfocus = (event) => event.target.select(); $('productUrl').onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); openProduct(); } }; $('surfaceOpenProduct').onclick = () => openProduct();
    $('browserReload').onclick = () => { void reloadActiveCommercePage(); };
    $('browserTranslate')?.addEventListener('click', () => { void translateActiveCommercePage(); });
    $('browserBack').onclick = () => {
      const tab = activeCommerceTab();
      if (shell?.navigateBack && tab?.type === 'commerce') return shell.navigateBack(tab.id).then((result) => { if (!result?.ok && result?.message) toast(result.message); }).catch((error) => toast(error.message || '后退失败'));
      toast('商品页后退请在嵌入页面内操作');
    };
    $('browserForward').onclick = () => {
      const tab = activeCommerceTab();
      if (shell?.navigateForward && tab?.type === 'commerce') return shell.navigateForward(tab.id).then((result) => { if (!result?.ok && result?.message) toast(result.message); }).catch((error) => toast(error.message || '前进失败'));
      toast('商品页前进请在嵌入页面内操作');
    };
    $('browserMenuButton')?.addEventListener('click', (event) => { event.stopPropagation(); toggleBrowserMenu(); });
    $('browserMenuPopover')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const menuButton = event.target.closest('[data-browser-menu-action]');
      if (menuButton) { handleBrowserMenuAction(menuButton.dataset.browserMenuAction); return; }
      const link = event.target.closest('[data-browser-menu-url]');
      if (link) { browserMenuNavigate(link.dataset.browserMenuUrl); return; }
      if (event.target.closest('[data-browser-bookmark-add]')) addCurrentBrowserBookmark();
    });
    $('browserImportFile')?.addEventListener('change', (event) => { const file = event.target.files?.[0]; if (file) importBrowserData(file); event.target.value = ''; });
    $('loginTaobao').onclick = login; $('browserLogin')?.addEventListener('click', login); $('surfaceLogin').onclick = login; $('checkTaobaoLogin').onclick = () => checkLogin(); $('clearCommerceSession').onclick = clearCommerceSession; $('startAnalysis').onclick = () => startAnalysis();
    $('analysisFile').onchange = (event) => event.target.files?.[0] && importResult(event.target.files[0]); $('openReport').onclick = () => openReport(); $('reportClose').onclick = closeReport; $('reportBackdrop').onclick = closeReport; $('exportReport').onclick = exportReport; $('exportCsv').onclick = exportCsv; $('exportMarkdown').onclick = exportMarkdown; $('exportVerificationCsv').onclick = () => exportVerification('csv'); $('exportVerificationJson').onclick = () => exportVerification('json');
    $('detailLongPreviewClose')?.addEventListener('click', closeDetailLongPreview); $('detailLongPreviewBackdrop')?.addEventListener('click', closeDetailLongPreview);
    $('detailLongPreviewZoomOut')?.addEventListener('click', () => setDetailLongPreviewZoom(detailLongPreviewZoom - DETAIL_LONG_PREVIEW_ZOOM_STEP));
    $('detailLongPreviewZoomReset')?.addEventListener('click', () => setDetailLongPreviewZoom(100));
    $('detailLongPreviewZoomIn')?.addEventListener('click', () => setDetailLongPreviewZoom(detailLongPreviewZoom + DETAIL_LONG_PREVIEW_ZOOM_STEP));
    window.addEventListener('resize', () => { if (!$('detailLongPreview')?.hidden) applyDetailLongPreviewZoom(); });
    $('detailLongPreviewImage')?.addEventListener('load', () => { const image = $('detailLongPreviewImage'); if (!image || Number(image.dataset.previewRequest || 0) !== detailLongPreviewRequest || $('detailLongPreview')?.hidden) return; $('detailLongPreviewLoading')?.setAttribute('hidden', ''); image.hidden = false; applyDetailLongPreviewZoom(); });
    $('detailLongPreviewImage')?.addEventListener('error', () => { const image = $('detailLongPreviewImage'); if (!image || Number(image.dataset.previewRequest || 0) !== detailLongPreviewRequest || $('detailLongPreview')?.hidden) return; $('detailLongPreviewLoading')?.setAttribute('hidden', ''); image.hidden = true; const error = $('detailLongPreviewError'); if (error) error.hidden = false; });
    document.addEventListener('keydown', (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 't') { event.preventDefault(); closeBrowserMenu(); openNewAnalysisTab(); return; }
      if (modifier && event.shiftKey && event.key === 'Delete') { event.preventDefault(); closeBrowserMenu(); clearBrowserData(); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); $('productUrl')?.focus(); $('productUrl')?.select(); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'w') { event.preventDefault(); closeCommerceTab(state.activeTabId); return; }
      if (modifier && event.key === 'Tab') { event.preventDefault(); switchCommerceTabByOffset(event.shiftKey ? -1 : 1); return; }
      if (modifier && !event.shiftKey && /^[1-8]$/.test(event.key)) { event.preventDefault(); switchCommerceTabByIndex(Number(event.key) - 1); return; }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); $('browserBack')?.click(); return; }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); $('browserForward')?.click(); return; }
      if (modifier && event.key.toLowerCase() === 'r') { event.preventDefault(); $('browserReload')?.click(); return; }
      if (event.key === 'Escape' && !$('browserMenuPopover')?.hidden) { event.preventDefault(); closeBrowserMenu(); return; }
      if (!$('detailLongPreview')?.hidden && !modifier && !event.altKey) {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); setDetailLongPreviewZoom(detailLongPreviewZoom + DETAIL_LONG_PREVIEW_ZOOM_STEP); return; }
        if (event.key === '-' || event.key === '_') { event.preventDefault(); setDetailLongPreviewZoom(detailLongPreviewZoom - DETAIL_LONG_PREVIEW_ZOOM_STEP); return; }
        if (event.key === '0') { event.preventDefault(); setDetailLongPreviewZoom(100); return; }
      }
       if (event.key === 'Escape' && !$('detailLongPreview')?.hidden) { event.preventDefault(); closeDetailLongPreview(); }
    });
    $('newChat')?.addEventListener('click', startNewSharedConversation); $('chatNew')?.addEventListener('click', startNewSharedConversation); $('exportChat')?.addEventListener('click', exportChat); $('chatDownload')?.addEventListener('click', exportChat); $('chatHistory')?.addEventListener('click', () => toggleChatHistory()); $('chatPopout')?.addEventListener('click', toggleChatFocus);
    $('conversationHistoryButton')?.addEventListener('click', (event) => { event.stopPropagation(); toggleConversationHistory(); }); $('conversationHistoryClose')?.addEventListener('click', () => toggleConversationHistory(false)); $('conversationHistoryOpenGpt')?.addEventListener('click', openGptConversation); $('openGptChat')?.addEventListener('click', openGptConversation);
    $('conversationHistoryList')?.addEventListener('click', (event) => { const button = event.target.closest('[data-shared-conversation-id]'); if (!button) return; toggleConversationHistory(false); loadSharedConversation(button.dataset.sharedConversationId, { announce: true }); });
    $('attachButton')?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); $('chatFileInput')?.click(); });
    $('chatFileInput')?.addEventListener('change', (event) => { void uploadChatAttachments(event.target.files); event.target.value = ''; });
    $('chatInput')?.addEventListener('paste', handleChatPaste);
    $('resourcePickerClose')?.addEventListener('click', () => toggleResourcePicker(false)); $('resourcePickerPopover')?.addEventListener('click', (event) => event.stopPropagation()); $('copyProductId')?.addEventListener('click', copyProductId); $('copyProductCategory')?.addEventListener('click', copyProductCategory); $('chatSend')?.addEventListener('click', () => sendChat()); $('chatInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } }); renderChatAttachments();
    $('modelPickerButton').onclick = (event) => { event.stopPropagation(); toggleModelPicker(); };
    $('modelPickerClose').onclick = () => toggleModelPicker(false);
    $('modelSettingsLink').onclick = () => { toggleModelPicker(false); postParent({ type: 'studio-switch-ui', page: 'api-settings' }); };
    $('modelPickerPopover').onclick = (event) => event.stopPropagation();
    updateAssistantSkillButton();
    $('assistantSkillPicker')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const option = event.target.closest('[data-assistant-skill-id]');
      if (option) selectAssistantSkill(option.dataset.assistantSkillId);
    });
    $('assistantSkillSearch')?.addEventListener('input', (event) => { state.skillQuery = event.target.value || ''; renderAssistantSkillPicker(); positionAssistantSkillPicker(); });
    $('assistantSkillSearch')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); toggleAssistantSkillPicker(false); return; }
      if (event.key === 'Enter') {
        const first = $('assistantSkillList')?.querySelector('[data-assistant-skill-id]');
        if (first) { event.preventDefault(); selectAssistantSkill(first.dataset.assistantSkillId); }
      }
    });
    $('closeAssistant')?.addEventListener('click', () => { state.assistantManualHidden = true; state.assistantOverride = false; setAssistantVisible(false); });
    $('showAssistant')?.addEventListener('click', () => { state.assistantManualHidden = false; state.assistantOverride = true; setAssistantVisible(true); });
    q('[data-assistant-mode]').forEach((button) => button.addEventListener('click', () => setAssistantMode(button.dataset.assistantMode)));
    setAssistantMode(state.assistantMode);
    q('.quick-grid:not(.site-quick-grid) button').forEach((button) => { button.onclick = () => button.dataset.pageModule ? runSearchQuickAnalysis(button.dataset.pageModule) : quickAction(button.dataset.module); }); $('quickCard')?.addEventListener('click', (event) => { const button = event.target.closest('[data-page-module]'); if (button) runSearchQuickAnalysis(button.dataset.pageModule); }); document.querySelector('.quick-grid:not(.site-quick-grid)')?.addEventListener('click', (event) => { const button = event.target.closest('[data-page-module]'); if (button && !button.onclick) runSearchQuickAnalysis(button.dataset.pageModule); }); $('siteQuickGrid')?.addEventListener('click', (event) => { const button = event.target.closest('[data-site-action]'); if (button) void runSiteQuickAction(button.dataset.siteAction); }); $('refreshPageContext')?.addEventListener('click', () => { const tab = activeCommerceTab(); if (isSiteAssistantTab(tab)) void captureSiteAssistantContext({ tab, force: true }); else if (isSearchCommerceUrl(activeProductUrl())) void captureCurrentPageContext({ url: activeProductUrl(), force: true }); }); $('chatMessages').addEventListener('click', (event) => { const merchantAction = event.target.closest?.('[data-merchant-change-action]'); if (merchantAction) { event.preventDefault(); void handleMerchantChangeAction(merchantAction); return; } const suggestion = event.target.closest?.('[data-suggest]'); if (suggestion) { event.preventDefault(); sendChat(suggestion.dataset.suggest); return; } const copyButton = event.target.closest?.('[data-copy-search-context]'); if (copyButton) { event.preventDefault(); copySearchPageGreeting(copyButton); return; } const siteCopyButton = event.target.closest?.('[data-copy-site-context]'); if (siteCopyButton) { event.preventDefault(); void copySiteContextPreview(siteCopyButton); } });
    $('chatMessages').addEventListener('click', openCommerceLinkInNewTab);
    q('[data-toggle]').forEach((button) => button.onclick = () => { const target = $(button.dataset.toggle); if (!target) return; const expanded = target.classList.contains('is-hidden'); if (button.dataset.toggle === 'productInfoBody') setProductInfoExpanded(expanded); else { target.classList.toggle('is-hidden', !expanded); button.setAttribute('aria-expanded', String(expanded)); const indicator = button.querySelector('span:last-child'); if (indicator) indicator.textContent = expanded ? '⌄' : '›'; } }); q('#reportTabs button').forEach((button) => button.onclick = () => { state.reportTab = button.dataset.reportTab; renderReport(); });
    const openDesktop = () => showAnalysisDesktop(); q('[data-nav="desktop"]').forEach((button) => button.onclick = openDesktop);
    q('.rail-item').filter((button) => button.dataset.nav !== 'desktop').forEach((button) => button.onclick = () => { const nav = button.dataset.nav; if (nav === 'ai') { openGptConversation(); return; } showAnalysisDesktop(nav, nav); });
    $('desktopAppGrid')?.addEventListener('click', (event) => { const button = event.target.closest('[data-desktop-app]'); if (button) routeDesktopApp(button.dataset.desktopApp); });
    $('desktopDrawerClose')?.addEventListener('click', closeDesktopDrawer); $('desktopDrawerBackdrop')?.addEventListener('click', closeDesktopDrawer); $('desktopDrawerBody')?.addEventListener('click', (event) => { const taskView = event.target.closest('[data-task-view]'); const job = event.target.closest('[data-open-job]'); const assets = event.target.closest('[data-open-assets]'); const skill = event.target.closest('[data-select-skill]'); if (taskView) switchDesktopTaskView(taskView.dataset.taskView); else if (job) openSavedJob(job.dataset.openJob); else if (assets) openOuterAssets(); else if (skill) selectDesktopSkill(skill.dataset.selectSkill); });
    const syncSharedSkill = (id) => {
      state.skillId = String(id || '').trim();
      updateAssistantSkillButton();
      renderAssistantSkillPicker();
      window.XiaomeiSkillMarket?.syncSelected?.(state.skillId);
    };
    if (window.StudioSharedSkill?.subscribe) window.StudioSharedSkill.subscribe(syncSharedSkill);
    else window.addEventListener('storage', (event) => { if (event.key === SHARED_SKILL_SELECTION_KEY) syncSharedSkill(event.newValue); });
    initAssistantResizer();
    window.addEventListener('resize', () => { setAssistantWidth(state.assistantWidth, { persist: false, emit: false }); emitBounds(); });
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data?.type === 'electron-commerce-surface') updateCommerceTabFromSurface(event.data);
    });
    window.addEventListener('message', (event) => {
      // Desktop surface events already pass through updateCommerceTabFromSurface.
      // Only retain this legacy title bridge for messages that lack revision data.
      if (event.data?.type === 'electron-commerce-surface' && !event.data.navigationRevision) {
        if (!event.data.verification && !event.data.loadError) {
          $('surfaceStatus').textContent = event.data.title || '商品页已打开';
          updateActiveCommerceTabTitle(event.data.site || '淘宝');
        }
      }
      if (event.data?.type === 'electron-operations-captured') saveOperations(event.data.payload || event.data);
      if (event.data?.type === 'launcher-focus') {
        if (event.data.url) {
          openCommerceTab(event.data.url, event.data.site || '淘宝', { kind: 'product', load: false });
        }
        if (event.data.focus === 'tasks') showAnalysisDesktop('tasks', 'tasks');
        else if (event.data.focus === 'ai') $('chatInput')?.focus();
      }
      if (event.data?.type === 'task-open-report' && event.data.jobId) openSavedJob(event.data.jobId);
    });
    if (shell?.onSurfaceState) {
      shell.onSurfaceState((payload) => {
        const surfacePayload = payload || {};
        if (!updateCommerceTabFromSurface(surfacePayload)) return;
        const tab = state.tabs.find((item) => item.id === surfacePayload.tabId) || activeCommerceTab();
        if (surfacePayload.ready && isSiteAssistantTab(tab)) scheduleSiteAssistantContext(tab, { force: false });
        if (surfacePayload.ready && isSearchCommerceUrl(surfacePayload.url || activeProductUrl())) schedulePageContext(surfacePayload.url || activeProductUrl(), { force: false });
        window.postMessage({ type: 'electron-commerce-surface', ...surfacePayload }, '*');
      });
    }
    if (shell?.onBrowserShortcut) shell.onBrowserShortcut((payload) => handleBrowserShortcut(payload || {}));
    if (shell?.onCollectionProgress) shell.onCollectionProgress((payload) => handleCollectionProgress(payload || {}));
    if (shell?.onNewTabRequest) shell.onNewTabRequest((payload) => { const url = safeCommerceUrl(payload?.url); if (!url) return; const existing = findCommerceDetailTab(url); if (existing) { activateCommerceTab(existing.id, { load: false }); if (shell?.activateProductTab) Promise.resolve(shell.activateProductTab(existing.id)).then((result) => { if (result?.ok && state.activeTabId === existing.id && activeCommerceTab()?.type === 'commerce' && !analysisDesktopVisible()) setProductViewVisible(true, existing.id); }).catch(() => {}); return; } const tab = openCommerceTab(url, '商品详情', { newTab: true, kind: 'detail', pageTitle: payload?.title || '', load: false }); if (tab && shell?.openProduct) Promise.resolve(shell.openProduct(url, tab.id)).catch((error) => toast(error.message)); });
    if (shell?.onOperationsCaptured) shell.onOperationsCaptured((payload) => saveOperations(payload));
    syncDesktopSurfaceState();
    window.addEventListener('scroll', () => positionAssistantSkillPicker(), true);
    window.addEventListener('resize', () => positionAssistantSkillPicker());
    try { const channel = new BroadcastChannel('studio-api'); channel.onmessage = (event) => { if (event.data?.type === 'providers-changed') loadModelProviders(); }; } catch {}
    window.addEventListener('storage', (event) => { if (event.key === CHAT_CONVERSATION_TOUCH_KEY) handleSharedConversationTouch(event.newValue); });
    document.addEventListener('click', (event) => { if (!event.target?.closest?.('#browserMenuPopover, #browserMenuButton')) closeBrowserMenu(); if (!event.target?.closest?.('#modelPickerPopover, #modelPickerButton')) toggleModelPicker(false); if (!event.target?.closest?.('#resourcePickerPopover')) toggleResourcePicker(false); if (!event.target?.closest?.('#chatHistoryPopover, #chatHistory')) toggleChatHistory(false); if (!event.target?.closest?.('#conversationHistoryPopover, #conversationHistoryButton')) toggleConversationHistory(false); if (!event.target?.closest?.('#assistantSkillPicker, #skillPicker')) toggleAssistantSkillPicker(false); });
    renderCommerceTabs(); updateBrowserTranslationButton(); updateQuickActions(); updateDesktopClock(); setInterval(updateDesktopClock, 30000); applyAssistantVisibility(activeCommerceTab()); if (analysisDesktopVisible()) { setRailActive('desktop'); syncProductViewVisibility(); } else syncProductViewVisibility(); loadModelProviders(); loadSharedConversation('', { silent: true, notify: false }); setTimeout(emitBounds, 300);
  }
  wire(); checkLogin(true); renderModules();
})();
