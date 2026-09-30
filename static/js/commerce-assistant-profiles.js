(() => {
  'use strict';

  const SITE_LABELS = Object.freeze({
    qianniu: '千牛工作台',
    sycm: '生意参谋',
    dmp: '达摩盘',
    xiaohongshu: '小红书',
    douyin: '抖音',
    '1688': '1688',
  });

  const SAFE_QUERY_KEYS = new Set(['keyword', 'keywords', 'q', 'query', 'type', 'tab', 'showTab', 'showSubTab']);

  function compactText(value, limit = 1200) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function parsedUrl(value) {
    try { return new URL(String(value || '')); } catch { return null; }
  }

  function hostIs(host, suffix) {
    const normalized = String(host || '').toLowerCase().replace(/\.$/, '');
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  }

  function shortHash(value) {
    let hash = 5381;
    for (const char of String(value || '')) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
    return (hash >>> 0).toString(36);
  }

  function safeContextUrl(value) {
    const url = parsedUrl(value);
    if (!url) return '';
    const result = new URL(url.origin + url.pathname);
    for (const [key, item] of url.searchParams.entries()) {
      if (SAFE_QUERY_KEYS.has(key) && compactText(item, 180)) result.searchParams.set(key, compactText(item, 180));
    }
    return result.href;
  }

  function profile(site, id, pageType, title, options = {}) {
    return { site, id, pageType, title, ...options };
  }

  function classify(value) {
    const url = parsedUrl(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const lowerPath = path.toLowerCase();

    if (hostIs(host, 'myseller.taobao.com') || hostIs(host, 'qianniu.taobao.com')) {
      const servicePage = /(?:customer-service|customer_service|message|chat|session)/.test(lowerPath);
      return profile('qianniu', servicePage ? 'qianniu-service' : 'qianniu-page', 'seller-admin', '千牛工作台');
    }
    if (hostIs(host, 'sycm.taobao.com')) {
      const modules = ['marketing', 'customer', 'flow', 'trade', 'market', 'product', 'business', 'service'];
      const module = modules.find((item) => path.toLowerCase().includes(item)) || 'home';
      return profile('sycm', `sycm-${module}`, 'report', '生意参谋', { module });
    }
    if (hostIs(host, 'dmp.taobao.com')) {
      const definitions = [
        ['items/shop-insight', 'dmp-shop-insight', '店铺概况'],
        ['items/growup-path', 'dmp-growup-path', '商品打爆路径'],
        ['compete/market-rank', 'dmp-market-rank', '市场榜单'],
        ['compete/compete-situation', 'dmp-compete', '竞品分析'],
        ['compete/compete-detect', 'dmp-compete-detect', '竞品监测'],
        ['audience', 'dmp-audience', '人群分析'],
        ['home-new/index', 'dmp-home', '首页概览'],
      ];
      const hit = definitions.find(([needle]) => path.toLowerCase().includes(needle));
      return profile('dmp', hit?.[1] || 'dmp-report', 'report', '达摩盘', { moduleTitle: hit?.[2] || '当前报表' });
    }
    if (hostIs(host, 'xiaohongshu.com') || hostIs(host, 'rednote.com')) {
      if (/^\/(?:explore|red_video)\/[0-9a-f]{24}$/i.test(path)) return profile('xiaohongshu', 'xhs-current-note', 'content', '小红书笔记');
      if (/^\/user\/profile\/[0-9a-f]{24}$/i.test(path)) return profile('xiaohongshu', 'xhs-creator', 'creator', '小红书博主主页');
      if (path === '/search_result' || path === '/search_result_ai') return profile('xiaohongshu', 'xhs-search', 'search', '小红书搜索');
      return profile('xiaohongshu', 'xhs-page', 'other', '小红书');
    }
    if (hostIs(host, 'douyin.com')) {
      const type = url.searchParams.get('type') || '';
      if ((path.includes('/search/') || path.includes('/root/search/') || path.includes('/jingxuan/search/')) && ['general', 'video'].includes(type) && !url.searchParams.get('modal_id')) return profile('douyin', 'douyin-search', 'search', type === 'video' ? '抖音视频搜索' : '抖音综合搜索');
      if (/^\/user\/.+/.test(path) && !url.searchParams.get('modal_id')) return profile('douyin', 'douyin-creator', 'creator', '抖音博主主页');
      if (/^\/(?:video|note)\/.+/.test(path) || /^\/article\/\d+$/.test(path) || url.searchParams.get('modal_id') || url.searchParams.get('recommend') === '1' || ['/follow', '/friend', '/jingxuan'].includes(path)) return profile('douyin', 'douyin-current-work', 'content', '抖音当前作品');
      return profile('douyin', 'douyin-page', 'other', '抖音');
    }
    if (hostIs(host, '1688.com')) {
      if (/^(?:login|passport)\.1688\.com$/i.test(host)) return profile('1688', '1688-login', 'other', '1688登录');
      if (host === 'detail.1688.com' && /^\/offer\/\d+\.html$/i.test(path)) return profile('1688', '1688-detail', 'product', '1688 商品详情');
      if (host === 's.1688.com' && path === '/company/pc/factory_search.htm') return profile('1688', '1688-factory-search', 'search', '1688 找工厂');
      if (host === 's.1688.com' && path === '/company/company_search.htm') return profile('1688', '1688-company-search', 'search', '1688 找供应商');
      if (host === 's.1688.com' && ['/selloffer/offer_search.htm', '/selloffer/imall_search.htm'].includes(path)) return profile('1688', '1688-search', 'search', '1688 商品搜索');
      if (host === 'www.1688.com' && path === '/zw/page.html') return profile('1688', '1688-search', 'search', '1688 商品搜索');
      if (host === 'sale.1688.com' && path === '/factory/card.html' && url.searchParams.get('memberid')) return profile('1688', '1688-factory-detail', 'shop', '1688 工厂详情');
      if (host === 'sale.1688.com' && /^\/factory\/l[a-z0-9]{5,}\.html$/i.test(path)) return profile('1688', '1688-factory-products', 'shop', '1688 工厂商品');
      if (/^[a-z0-9][a-z0-9-]{0,61}\.1688\.com$/i.test(host) && !['www.1688.com', 's.1688.com', 'detail.1688.com', 'sale.1688.com'].includes(host)) return profile('1688', '1688-shop', 'shop', '1688 店铺');
      if ((host === '1688.com' || host === 'www.1688.com') && path === '/') return profile('1688', '1688-home', 'other', '1688首页');
      return profile('1688', '1688-page', 'other', '1688');
    }
    return null;
  }

  // 部分平台（例如小红书首页内的笔记弹窗）不会同步更新地址栏。
  // URL 只用来识别站点和常规页型；桌面端已从当前可见 DOM 确认的页型
  // 可以把同站点的“当前页面”升级为作品/搜索/详情，避免把笔记当首页。
  function profileForSnapshot(snapshot = {}) {
    const base = classify(snapshot?.url);
    if (!base) return null;
    const structured = snapshot?.structured && typeof snapshot.structured === 'object' ? snapshot.structured : {};
    const kind = compactText(structured.kind || '', 80).toLowerCase();
    if (!kind) return base;
    if (base.site === 'xiaohongshu') {
      if (kind === 'xhs-note') return profile('xiaohongshu', 'xhs-current-note', 'content', '小红书笔记');
      if (kind === 'xhs-creator') return profile('xiaohongshu', 'xhs-creator', 'creator', '小红书博主主页');
      if (kind === 'xhs-search') return profile('xiaohongshu', 'xhs-search', 'search', '小红书搜索');
    }
    if (base.site === 'douyin') {
      if (kind === 'douyin-work') return profile('douyin', 'douyin-current-work', 'content', '抖音当前作品');
      if (kind === 'douyin-creator') return profile('douyin', 'douyin-creator', 'creator', '抖音博主主页');
      if (kind === 'douyin-search') return profile('douyin', 'douyin-search', 'search', '抖音综合搜索');
    }
    if (base.site === 'qianniu' && kind === 'qianniu-service') {
      return profile('qianniu', 'qianniu-service', 'seller-admin', '千牛工作台');
    }
    if (base.site === '1688') {
      if (kind === '1688-detail') return profile('1688', '1688-detail', 'product', '1688 商品详情');
      if (kind === '1688-search' && base.id === '1688-page') return profile('1688', '1688-search', 'search', '1688 商品搜索');
      if (kind === '1688-shop' && base.id === '1688-page') return profile('1688', '1688-shop', 'shop', '1688 店铺');
    }
    return base;
  }

  function contextKey(value, item = classify(value)) {
    const url = parsedUrl(value);
    if (!url || !item) return '';
    const stableUrl = safeContextUrl(url.href);
    const identity = `${item.id}:${stableUrl}`;
    return `${item.site}:${item.id}:${shortHash(identity)}`;
  }

  // 同一链接可以在多个工作标签中同时打开。标签标识只用于本地会话隔离，
  // 经过字符白名单处理，不会把页面 URL、账号或临时凭据写入页面键。
  function tabContextKey(value, item = classify(value), tabId = '') {
    const key = contextKey(value, item);
    const safeTabId = String(tabId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return key && safeTabId ? `${key}:tab:${safeTabId}` : key;
  }

  function normalizedArray(values, limit, mapper) {
    return (Array.isArray(values) ? values : []).slice(0, limit).map(mapper).filter(Boolean);
  }

  function normalizeContext(snapshot = {}, item = profileForSnapshot(snapshot)) {
    if (!item) return null;
    const sourceUrl = safeContextUrl(snapshot.url || '');
    const rawStructured = snapshot.structured && typeof snapshot.structured === 'object' ? snapshot.structured : {};
    const facts = normalizedArray(rawStructured.facts, 16, (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const label = compactText(entry.label || entry.name || '', 80);
      const value = compactText(entry.value || entry.text || '', 420);
      return label && value ? { label, value } : null;
    });
    // 桌面端已经按达比对应平台包的页型确认资源。这里不从 rawText、图片
    // 数量或通用卡片推断资源，避免把小红书/抖音的规则误带到报表、客服或
    // 1688 页面。资源 id 是固定白名单键，token/label 仅作展示和引用。
    const capturedResources = normalizedArray(rawStructured.resources, 24, (entry) => {
      if (!entry || typeof entry !== 'object' || entry.available === false) return null;
      const id = String(entry.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      const token = compactText(entry.token || '', 120);
      const label = compactText(entry.label || entry.title || '', 120);
      return id && token.startsWith('@') && label ? { id, token, label, available: true } : null;
    });
    const cards = normalizedArray(snapshot.cards || snapshot.items || snapshot.visibleItems, 60, (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const title = compactText(entry.title || entry.name || '', 260);
      const text = compactText(entry.text || entry.content || entry.description || '', 1200);
      const image = String(entry.mainImage || entry.image || entry.url || '').trim();
      return (title || text) ? { title, text, mainImage: /^https?:/i.test(image) ? image : '' } : null;
    });
    const images = normalizedArray(snapshot.images, 12, (entry) => {
      if (typeof entry === 'string') return /^https?:/i.test(entry) ? { url: entry, alt: '' } : null;
      const url = String(entry?.url || entry?.src || '').trim();
      return /^https?:/i.test(url) ? { url, alt: compactText(entry?.alt || '', 160) } : null;
    });
    const comments = normalizedArray(snapshot.comments, 60, (entry) => {
      if (typeof entry === 'string') return compactText(entry, 600) || null;
      const author = compactText(entry?.author || entry?.user || '', 100);
      const text = compactText(entry?.text || entry?.content || '', 600);
      return text ? { author, text } : null;
    });
    const tables = normalizedArray(snapshot.tables, 24, (entry) => {
      const title = compactText(entry?.title || entry?.caption || '', 180);
      const rows = normalizedArray(entry?.rows, 120, (row) => {
        const values = Array.isArray(row) ? row.slice(0, 24).map((value) => compactText(value, 180)).filter(Boolean) : [];
        return values.length ? values : null;
      });
      return (title || rows.length) ? { title, rows } : null;
    });
    const context = {
      source: 'electron-visible-dom-assistant',
      site: item.site,
      pageType: item.pageType,
      pageKey: contextKey(snapshot.url, item),
      url: sourceUrl,
      title: compactText(snapshot.title || item.title, 300),
      structuredTitle: compactText(rawStructured.title || '', 160),
      structuredKind: compactText(rawStructured.kind || '', 80),
      facts,
      excerpt: compactText(rawStructured.excerpt || '', 600),
      capturedResources,
      structured: {
        title: compactText(rawStructured.title || '', 160),
        kind: compactText(rawStructured.kind || '', 80),
        facts,
        resources: capturedResources,
        excerpt: compactText(rawStructured.excerpt || '', 600),
      },
      headings: normalizedArray(snapshot.headings, 80, (value) => compactText(value, 240)),
      metrics: normalizedArray(snapshot.metrics, 80, (value) => compactText(typeof value === 'object' ? `${value.label || value.name || ''} ${value.value || value.text || ''}` : value, 320)),
      tables,
      items: cards,
      comments,
      images,
      videoCount: Math.max(0, Number(snapshot.videoCount || 0) || 0),
      visibleCount: Number(snapshot.visibleCount || cards.length || 0) || 0,
      rawText: compactText(snapshot.rawText || snapshot.text || snapshot.bodyText || '', 24000),
      capturedAt: Number(snapshot.capturedAt || Date.now()) || Date.now(),
      resources: [],
    };
    return context;
  }

  function availability(context) {
    const factLabels = new Set((Array.isArray(context?.facts) ? context.facts : []).map((item) => compactText(item?.label || '', 80)));
    const hasImageSignal = factLabels.has('图片') || Boolean(context?.images?.length);
    const hasVideoSignal = factLabels.has('视频') || Boolean(context?.videoCount);
    const hasPage = Boolean(context?.facts?.length || context?.excerpt || context?.rawText || context?.headings?.length || context?.metrics?.length || context?.tables?.length || context?.items?.length);
    return {
      page: hasPage,
      report: Boolean(context?.facts?.length || context?.metrics?.length || context?.tables?.length || context?.rawText),
      content: hasPage,
      creator: hasPage,
      search: Boolean(context?.items?.length || context?.rawText),
      comments: Boolean(context?.comments?.length),
      images: hasImageSignal,
      video: hasVideoSignal,
      works: Boolean(context?.items?.length),
      product: hasPage,
      shop: hasPage,
    };
  }

  function resource(id, token, label, available) {
    return { id, token, label, available: Boolean(available) };
  }

  function capturedResource(context, id) {
    const entry = (Array.isArray(context?.capturedResources) ? context.capturedResources : [])
      .find((item) => item?.id === id && item?.available !== false);
    return entry ? resource(id, entry.token, entry.label, true) : null;
  }

  function capturedResources(context, ids) {
    return (Array.isArray(ids) ? ids : []).map((id) => capturedResource(context, id)).filter(Boolean);
  }

  function resourceById(resources, id) {
    return (Array.isArray(resources) ? resources : []).find((entry) => entry?.id === id && entry?.available !== false) || null;
  }

  function factValue(context, label) {
    const entry = (Array.isArray(context?.facts) ? context.facts : []).find((item) => compactText(item?.label || '', 80) === label);
    return compactText(entry?.value || '', 420);
  }

  function action(id, label, prompt, requires = ['page']) {
    return { id, label, prompt, requires };
  }

  function keywordFromContext(context) {
    const url = parsedUrl(context?.url || '');
    return compactText(url?.searchParams.get('keyword') || url?.searchParams.get('keywords') || context?.headings?.find((value) => /关键词|搜索/.test(value)) || '当前关键词', 80);
  }

  function actionsFor(item, context, ready, resources = []) {
    const title = compactText(context?.title || item?.moduleTitle || item?.title || '当前页面', 80);
    const keyword = keywordFromContext(context);
    const getResource = (id) => resourceById(resources, id);
    switch (item.id) {
      case 'qianniu-service':
      case 'qianniu-page': {
        const chat = getResource('qianniu-chat-records');
        if (!chat) return [];
        const customer = factValue(context, '客户');
        const employee = factValue(context, '员工');
        // 达比会在“客户 / 员工 / 全部筛选”三种千牛数据范围中只给一个
        // 对应入口，不让同一份聊天记录同时被误当成三种分析样本。
        if (customer) return [action('qianniu-analyze-conversation', '分析当前对话', `请以“用户需求分析 + 客服接待复盘”的视角分析客户“${customer}”相关的当前客服对话。聚焦消费者核心问题、购买顾虑、关键回复与处理结果；只依据当前聊天记录下结论，不从单次对话推断员工整体能力。 ${chat.token}`, ['page'])];
        if (employee) return [action('qianniu-analyze-employee', '分析员工接待表现', `请以“客服主管质检 + 用户反馈分析”的视角分析员工“${employee}”在当前筛选范围内的接待表现。重点判断需求识别、答非所问、准确完整、方案可执行性和沟通态度；样本不足时明确说明，不排名、不编造。 ${chat.token}`, ['page'])];
        return [action('qianniu-analyze-service-quality', '分析客服接待质量', `请以“客服运营负责人 + 产品负责人”的视角分析当前筛选内客服接待记录，只保留对经营、产品或客服改进有价值的结论。归纳消费者需求、明确产品反馈、共性问题和可执行优化建议。 ${chat.token}`, ['page'])];
      }
      case 'sycm-home':
      case 'sycm-marketing':
      case 'sycm-customer':
      case 'sycm-flow':
      case 'sycm-trade':
      case 'sycm-market':
      case 'sycm-product':
      case 'sycm-business':
      case 'sycm-service':
        {
          const report = getResource('sycm-current-report');
          return report
          ? [action('sycm-analyze-report', `分析${report.label}`, `分析这张生意参谋报表 ${report.token}`, ['page'])]
          : [action('sycm-page-summary', '解读当前页面', '结合当前生意参谋页面，说明页面重点和下一步应该查看哪些报表。 @当前页面', ['page'])];
        }
      case 'dmp-growup-path': {
        const pathData = getResource('dmp-growup-path');
        return pathData ? [
          action('dmp-growup-analyze', '分析当前商品打爆路径', `请结合当前达摩盘打爆路径页面，分析当前商品的成长阶段、优势、不足和关键增长机会。 ${pathData.token}`, ['page']),
          action('dmp-growup-summary', '总结优势与不足', `请结合当前达摩盘打爆路径页面，总结当前商品相对成功商品的主要优势与不足。 ${pathData.token}`, ['page']),
          action('dmp-growup-plan', '给出下一阶段建议', `请结合当前达摩盘打爆路径页面，为当前商品给出下一成长阶段的优先行动建议。 ${pathData.token}`, ['page']),
        ] : [];
      }
      case 'dmp-shop-insight': {
        const overview = getResource('dmp-shop-overview');
        const categories = getResource('dmp-shop-categories');
        const items = getResource('dmp-shop-items');
        return [
          overview ? action('dmp-shop-overview', '分析店铺概况', `请分析当前达摩盘店铺概况中的经营表现、货品结构和页面结论。 ${overview.token}`, ['page']) : null,
          categories ? action('dmp-shop-categories', '分析类目数据', `请分析当前店铺各类目的支付、商品、推广、市场表现和机会潜力。 ${categories.token}`, ['page']) : null,
          items ? action('dmp-shop-items', '分析商品列表', `请分析当前筛选条件下的全店商品经营表现、诊断策略和生命周期。 ${items.token}`, ['page']) : null,
        ].filter(Boolean);
      }
      case 'dmp-home':
        return resources.filter((entry) => /^dmp-home-/.test(entry.id)).map((entry) => action(
          `dmp-home-${entry.id.replace(/^dmp-home-/, '')}`,
          `分析${entry.label}`,
          `请分析当前达摩盘${entry.label}。 ${entry.token}`,
          ['page'],
        ));
      case 'dmp-market-rank':
      case 'dmp-compete':
      case 'dmp-compete-detect':
      case 'dmp-audience':
      case 'dmp-report': {
        const report = resources[0] || null;
        return report ? [action('dmp-analyze-report', `分析${report.label}`, `请分析当前达摩盘${report.label}页面，归纳核心数据、趋势、问题和下一步机会。 ${report.token}`, ['page'])] : [];
      }
      case 'xhs-current-note': {
        const content = getResource('xhs-content');
        const comments = getResource('xhs-comments');
        if (!content) return [];
        const isVideo = content.token === '@视频';
        return [
          action('xhs-analyze-current-note', isVideo ? '分析当前视频' : '分析当前图文', isVideo
            ? `请仅依据当前小红书视频页面已返回的可见文字、结构、指标和视频存在信号，分析选题、开头、内容结构、受众与互动亮点，并给出可复用的创作建议。未返回视频帧或字幕时请明确说明。 ${content.token}`
            : `请仅依据当前小红书图文页面已返回的可见文字、结构、指标和图片存在信号，分析选题、文案、内容结构、受众与互动亮点，并给出可复用的创作建议。未返回图片细节时请明确说明。 ${content.token}`, ['content']),
          comments ? action('xhs-analyze-comments', '分析评论', `请结合当前小红书作品内容和已读取的评论，分析评论反馈、主要观点、情绪、争议点、用户关注点以及作品内容与评论反馈之间的关系。 ${content.token} ${comments.token}`, ['content']) : null,
        ].filter(Boolean);
      }
      case 'xhs-creator': {
        const creator = getResource('xhs-creator-profile');
        const notes = getResource('xhs-creator-notes');
        return [
          creator ? action('xhs-analyze-creator-positioning', '分析博主定位', `请结合当前博主资料，分析这个账号的内容定位、受众特征和账号特点。 ${creator.token}`, ['creator']) : null,
          creator && notes ? action('xhs-analyze-creator-notes', '分析笔记内容特点', `请结合当前博主资料和笔记信息，分析这个博主在选题、文案、内容形式和互动表现上的主要特点。 ${creator.token} ${notes.token}`, ['creator']) : null,
        ].filter(Boolean);
      }
      case 'xhs-search': {
        const notes = getResource('xhs-search-notes');
        return notes ? [action('xhs-analyze-search', '分析热门笔记特点', `请结合当前“${keyword}”搜索范围内的笔记信息，分析热门笔记在选题、标题、正文、内容形式和互动表现上的共同特点。 ${notes.token}`, ['search'])] : [];
      }
      case 'douyin-current-work': {
        const isArticle = /^\/article\//.test(parsedUrl(context?.url || '')?.pathname || '');
        const content = getResource('douyin-content');
        if (!content) return [];
        const isImage = content.token === '@图文';
        const contentIsArticle = content.token === '@文章' || isArticle;
        return [action('douyin-analyze-current-work', contentIsArticle ? '分析当前文章' : isImage ? '分析当前图文' : '分析当前视频', contentIsArticle
          ? `请仅依据当前文章已返回的可见文字和结构，分析它的选题、核心观点、论证结构、写作风格、目标读者与传播亮点，并给出可复用的写作建议。 ${content.token}`
          : isImage
            ? `请仅依据当前图文作品已返回的可见文字、结构、指标和图片存在信号，分析它的选题、文案、内容结构、受众与互动亮点，并给出可复用的创作建议。未返回图片细节时请明确说明。 ${content.token}`
            : `请仅依据当前视频页面已返回的可见文字、结构、指标和视频存在信号，分析它的选题、开头、内容结构、受众与互动亮点，并给出可复用的创作建议。未返回画面、口播或字幕时请明确说明。 ${content.token}`, ['content'])];
      }
      case 'douyin-creator': {
        const creator = getResource('douyin-creator-profile');
        const works = getResource('douyin-creator-works');
        return [
          creator ? action('douyin-analyze-creator-positioning', '分析博主定位', `请结合当前博主资料，分析这个账号的内容定位、受众特征和账号特点。 ${creator.token}`, ['creator']) : null,
          creator && works ? action('douyin-analyze-creator-works', '分析作品内容特点', `请结合当前博主资料和作品信息，分析这个博主在选题、文案、内容形式和互动表现上的主要特点。 ${creator.token} ${works.token}`, ['creator']) : null,
        ].filter(Boolean);
      }
      case 'douyin-search': {
        const videos = getResource('douyin-search-videos');
        const works = getResource('douyin-search-works');
        const result = videos || works;
        if (!result) return [];
        return [action('douyin-analyze-search', videos ? '分析热门视频特点' : '分析热门作品特点', `请结合当前“${keyword}”搜索结果，分析表现较好的${videos ? '视频' : '作品'}在选题、文案和内容形式上的共同特点。 ${result.token}`, ['search'])];
      }
      case '1688-detail': {
        const review = getResource('1688-reviews');
        const detail = getResource('1688-detail-images');
        const images = getResource('1688-main-images');
        const videos = getResource('1688-main-videos');
        const product = getResource('1688-product-info');
        return [
          review ? action('1688-review-analysis', '分析评价', `请结合这个 1688 商品已读取的评价数据，分析采购者的真实需求和购买顾虑，包括高频好评点和差评点、使用场景、人群、痛点，以及可反哺主图、详情页和客服话术的优化建议。请给出结构化结论。 ${review.token}`, ['page']) : null,
          detail ? action('1688-detail-analysis', '分析详情页长图', `请仅依据当前 1688 商品页已返回的详情页可见资料，分析卖点表达顺序、采购信息完整性、转化风险与可优化内容。未返回图像像素时请明确说明。 ${detail.token}`, ['page']) : null,
          images ? action('1688-main-image-analysis', '分析主图', `请仅依据当前 1688 商品页已返回的主图关联资料和可见文字，分析主图信息表达、采购决策要点与需要补充的内容。未返回图片像素时请明确说明。 ${images.token}`, ['page']) : null,
          videos ? action('1688-main-video-analysis', '分析主图视频', `请仅依据当前 1688 商品页已返回的主图视频关联资料和可见文字，分析视频承载的卖点、采购信息与需要补充的内容。未返回画面或字幕时请明确说明。 ${videos.token}`, ['page']) : null,
          !detail && product ? action('1688-page-structure', '分析商品页资料', `请仅依据当前 1688 商品页已返回的可见文字、标题、规格和商品资料，分析卖点表达顺序、采购信息完整性、转化风险与可优化内容。 ${product.token}`, ['page']) : null,
        ].filter(Boolean);
      }
      case '1688-search': {
        const products = getResource('1688-search-products');
        if (!products) return [];
        return [
          action('1688-search-market', '寻找市场机会', `我是卖“${keyword}”的商家，请结合当前 1688 商品列表的可见文字、价格和卡片资料，分析这个关键词下的人群需求、隐性需求和市场机会，并给出商品开发建议。 ${products.token}`, ['search']),
          action('1688-search-price', '分析价格带和成交分布', `请基于当前 1688 商品列表，分析价格带和成交分布，说明商品数量、竞争强弱、差异化机会与新品主攻价格带。请输出价格带概览、竞争判断和选品建议。 ${products.token}`, ['search']),
          action('1688-search-title', '总结标题高频词', `请基于当前 1688 商品列表，拆解商品标题中的高频词和词根，重点分析功能、材质、人群、场景、款式和规格词。请区分基础必备词和可能的差异化机会词，并给出可用于选品、标题和主图文案的词组建议。 ${products.token}`, ['search']),
          action('1688-search-competitors', '找出低价高成交商品', `请从当前 1688 商品列表中找出值得重点观察的低价高成交商品，列出标题、价格、成交信息、供应商和位置类型，并分析可借鉴的选品、定价和标题策略。 ${products.token}`, ['search']),
        ];
      }
      case '1688-factory-search': {
        const factories = getResource('1688-factory-search');
        return factories ? [
          action('1688-factory-search-strength', '分析工厂实力', `请基于当前工厂列表，从经营年限、工厂规模、响应率、履约率、回头率、认证和加工能力等维度分析工厂实力，并列出值得优先联系的工厂及理由。 ${factories.token}`, ['search']),
          action('1688-factory-search-shortlist', '筛选合作工厂', `请基于当前工厂列表，筛选适合进一步打样或询盘的候选工厂，说明各自优势、需要核实的风险点和建议询问的问题。 ${factories.token}`, ['search']),
        ] : [];
      }
      case '1688-company-search': {
        const companies = getResource('1688-company-search');
        return companies ? [
          action('1688-company-search-compare', '对比供应商', `请基于当前供应商列表，从经营年限、经营模式、回头率、响应率、成交、服务分、工厂规模和加工能力等维度对比，并列出值得优先联系的供应商及理由。 ${companies.token}`, ['search']),
          action('1688-company-search-shortlist', '筛选合作供应商', `请基于当前供应商列表筛选适合进一步询盘或打样的候选供应商，说明优势、风险点和建议核实的问题。 ${companies.token}`, ['search']),
        ] : [];
      }
      case '1688-factory-detail': {
        const factory = getResource('1688-factory-profile');
        const review = getResource('1688-factory-reviews');
        return [
          factory ? action('1688-factory-detail-strengths', '分析工厂实力', `结合工厂规模、履约、生产能力和资质信息分析这家工厂的优势与风险。 ${factory.token}`, ['shop']) : null,
          review ? action('1688-factory-detail-reviews', '分析买家评价', `归纳当前页面已读取买家评价中的优点、问题和采购风险。 ${review.token}`, ['shop']) : null,
        ].filter(Boolean);
      }
      case '1688-factory-products': {
        const products = getResource('1688-factory-products');
        return products ? [action('1688-factory-products-analysis', '分析商品结构', `分析当前工厂商品的标题、价格、销量、起订量和商品标签结构。 ${products.token}`, ['search'])] : [];
      }
      case '1688-shop': {
        const products = getResource('1688-shop-products');
        return products ? [action('1688-shop-analysis', '分析商品结构', `请结合当前 1688 店铺已读取商品的价格、成交和标题结构，分析店铺商品结构、供给特点与采购机会。 ${products.token}`, ['shop'])] : [];
      }
      default:
        return [action('site-page-summary', '解读当前页面', `请基于当前${SITE_LABELS[item.site] || item.title}页面的可见资料，说明页面重点、已观察到的数据和下一步值得查看的内容。 @当前页面`, ['page'])];
    }
  }

  function resourcesFor(item, context) {
    // 每个页面只能显示桌面端站点采集器已经确认的对应资源。这里不用
    // “有图片/有表格/有正文”作跨站点兜底，防止出现用户指出的把小红书
    // 标准套到千牛、生意参谋、达摩盘或 1688 的问题。
    switch (item.id) {
      case 'qianniu-service':
      case 'qianniu-page': return capturedResources(context, ['qianniu-chat-records']);
      case 'sycm-home':
      case 'sycm-marketing':
      case 'sycm-customer':
      case 'sycm-flow':
      case 'sycm-trade':
      case 'sycm-market':
      case 'sycm-product':
      case 'sycm-business':
      case 'sycm-service': return capturedResources(context, ['sycm-current-report']);
      case 'dmp-home': return capturedResources(context, ['dmp-home-marketing', 'dmp-home-business', 'dmp-home-consumer-assets', 'dmp-home-leaf-cate', 'dmp-home-overview']);
      case 'dmp-growup-path': return capturedResources(context, ['dmp-growup-path']);
      case 'dmp-shop-insight': return capturedResources(context, ['dmp-shop-overview', 'dmp-shop-categories', 'dmp-shop-items']);
      case 'dmp-market-rank': return capturedResources(context, ['dmp-market-rank']);
      case 'dmp-compete': return capturedResources(context, ['dmp-compete']);
      case 'dmp-compete-detect': return capturedResources(context, ['dmp-compete-detect']);
      case 'dmp-audience': return capturedResources(context, ['dmp-audience']);
      case 'dmp-report': return capturedResources(context, ['dmp-current-report']);
      case 'xhs-current-note': return capturedResources(context, ['xhs-content', 'xhs-comments']);
      case 'xhs-creator': return capturedResources(context, ['xhs-creator-profile', 'xhs-creator-notes']);
      case 'xhs-search': return capturedResources(context, ['xhs-search-notes']);
      case 'douyin-current-work': return capturedResources(context, ['douyin-content']);
      case 'douyin-creator': return capturedResources(context, ['douyin-creator-profile', 'douyin-creator-works']);
      case 'douyin-search': return capturedResources(context, ['douyin-search-videos', 'douyin-search-works']);
      case '1688-detail': return capturedResources(context, ['1688-product-info', '1688-main-videos', '1688-main-images', '1688-detail-images', '1688-detail-image-files', '1688-sku-images', '1688-sku-list', '1688-reviews']);
      case '1688-search': return capturedResources(context, ['1688-search-products', '1688-search-main-images', '1688-search-promoted-images']);
      case '1688-factory-search': return capturedResources(context, ['1688-factory-search']);
      case '1688-company-search': return capturedResources(context, ['1688-company-search']);
      case '1688-factory-detail': return capturedResources(context, ['1688-factory-profile', '1688-factory-images', '1688-factory-videos', '1688-factory-reviews']);
      case '1688-factory-products': return capturedResources(context, ['1688-factory-products']);
      case '1688-shop': return capturedResources(context, ['1688-shop-profile', '1688-shop-products']);
      default: return [];
    }
  }

  function keepsProductQuickActions(item) {
    return item?.site === '1688' && item?.id === '1688-detail';
  }

  // 读取完成后先呈现当前页“实况”资料；它不是模型结论，也不会触发网络请求。
  // 六站点只展示采集器明确标注的业务字段，绝不把整页文字、背景卡片或
  // 登录提示拼进面板。快捷分析会把同一份受限快照交给模型。
  function pagePreview(view = {}) {
    const item = view?.profile;
    const context = view?.context;
    if (!item || !context) return null;
    const facts = normalizedArray(context.facts, 12, (entry) => {
      const label = compactText(entry?.label || '', 80);
      const value = compactText(entry?.value || '', 420);
      return label && value ? { label, value } : null;
    });
    if (!facts.length) {
      facts.push({ label: '资料状态', value: '当前页面未读取到可展示的关键字段；请等待页面加载完成后重试。' });
    }
    const baseTitle = compactText(context.structuredTitle || item.title || SITE_LABELS[item.site] || '当前页面', 160);
    const title = `${baseTitle} · 实况`;
    return {
      title,
      facts: facts.slice(0, 12),
      copyText: [title, ...facts.slice(0, 12).map((entry) => `${entry.label}：${entry.value}`), '资料仅来自当前已渲染且可见的页面内容。'].join('\n'),
    };
  }

  function build(snapshot = {}) {
    const item = profileForSnapshot(snapshot);
    if (!item) return null;
    const context = normalizeContext(snapshot, item);
    if (!context) return null;
    const ready = availability(context);
    const resources = resourcesFor(item, context).filter((entry, index, list) => entry.available && list.findIndex((candidate) => candidate.token === entry.token) === index);
    context.resources = resources;
    const actions = actionsFor(item, context, ready, resources).filter((entry) => entry.requires.every((required) => Boolean(ready[required])));
    const count = context.facts.length || context.visibleCount || context.items.length || context.comments.length || context.tables.length || 0;
    const greeting = context.facts.length || context.excerpt || context.rawText
      ? `已读取当前${item.title}的可见页面资料${count ? `（${count} 项）` : ''}。`
      : `正在等待${item.title}页面加载可读取内容。`;
    return { profile: item, context, resources, actions, greeting, ready };
  }

  window.XiaomeiCommerceAssistantProfiles = Object.freeze({
    siteLabels: SITE_LABELS,
    classify,
    profileForSnapshot,
    contextKey,
    tabContextKey,
    safeContextUrl,
    keepsProductQuickActions,
    pagePreview,
    build,
  });
})();
