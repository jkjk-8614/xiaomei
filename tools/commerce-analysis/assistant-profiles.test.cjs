const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../static/js/commerce-assistant-profiles.js'), 'utf8');
const analysisSource = fs.readFileSync(path.resolve(__dirname, '../../static/js/commerce-analysis.js'), 'utf8');
const analysisMarkup = fs.readFileSync(path.resolve(__dirname, '../../static/commerce-analysis.html'), 'utf8');
const analysisCss = fs.readFileSync(path.resolve(__dirname, '../../static/css/commerce-analysis.css'), 'utf8');
const desktopMainSource = fs.readFileSync(path.resolve(__dirname, '../../desktop/main.cjs'), 'utf8');
const sandbox = { window: {}, URL, Set, String, Object, Array, Number, Date, RegExp, Math };
vm.runInNewContext(source, sandbox, { filename: 'commerce-assistant-profiles.js' });
const profiles = sandbox.window.XiaomeiCommerceAssistantProfiles;

test('识别六站点代表页型', () => {
  assert.equal(profiles.classify('https://myseller.taobao.com/app/customer-service/toolPage/Message').id, 'qianniu-service');
  assert.equal(profiles.classify('https://sycm.taobao.com/marketing').id, 'sycm-marketing');
  assert.equal(profiles.classify('https://dmp.taobao.com/items/growup-path').id, 'dmp-growup-path');
  assert.equal(profiles.classify('https://www.xiaohongshu.com/explore/6a9134be000000002a03325e').id, 'xhs-current-note');
  assert.equal(profiles.classify('https://www.douyin.com/user/MS4wLjABAAAA').id, 'douyin-creator');
  assert.equal(profiles.classify('https://www.douyin.com/video/7450000000000000000').id, 'douyin-current-work');
  assert.equal(profiles.classify('https://detail.1688.com/offer/123456789.html').id, '1688-detail');
});

test('同一 URL 内的详情弹窗按实况页型切换，不误作站点首页', () => {
  const xhsNote = profiles.build({
    // 用户截图中的首页弹窗保持这个 URL；详情身份来自桌面端可见 DOM。
    url: 'https://www.xiaohongshu.com/',
    structured: {
      title: '小红书图文',
      kind: 'xhs-note',
      facts: [
        { label: '博主', value: '示例博主' },
        { label: '标题', value: '当前笔记标题' },
        { label: '图片', value: '2 张' },
        { label: '评论', value: '829' },
      ],
      resources: [
        { id: 'xhs-content', token: '@图文', label: '图文', available: true },
        { id: 'xhs-comments', token: '@评论', label: '评论', available: true },
      ],
    },
    comments: [{ author: '用户', text: '可见评论' }],
  });
  assert.equal(xhsNote.profile.id, 'xhs-current-note');
  assert.equal(xhsNote.profile.pageType, 'content');
  assert.ok(xhsNote.actions.some((item) => item.id === 'xhs-analyze-current-note'));
  assert.ok(xhsNote.actions.some((item) => item.id === 'xhs-analyze-comments'));
  assert.deepEqual(Array.from(xhsNote.resources, (item) => item.token), ['@图文', '@评论']);
  assert.equal(profiles.pagePreview(xhsNote).title, '小红书图文 · 实况');
});

test('页面键与安全 URL 不保留临时凭据参数', () => {
  const raw = 'https://www.xiaohongshu.com/search_result?keyword=%E8%8C%B6%E5%85%B7&xsec_token=secret&sessionid=bad';
  const safe = profiles.safeContextUrl(raw);
  assert.match(safe, /keyword=/);
  assert.doesNotMatch(safe, /xsec_token|sessionid|secret/);
  assert.equal(profiles.contextKey(raw), profiles.contextKey('https://www.xiaohongshu.com/search_result?keyword=%E8%8C%B6%E5%85%B7'));
  assert.notEqual(
    profiles.contextKey('https://www.xiaohongshu.com/explore/6a9134be000000002a03325e'),
    profiles.contextKey('https://www.xiaohongshu.com/explore/6a9134be000000002a03325f'),
  );
  assert.notEqual(
    profiles.tabContextKey('https://www.xiaohongshu.com/search_result?keyword=tea', undefined, 'commerce-1'),
    profiles.tabContextKey('https://www.xiaohongshu.com/search_result?keyword=tea', undefined, 'commerce-2'),
  );
  assert.doesNotMatch(
    profiles.tabContextKey('https://www.xiaohongshu.com/search_result?keyword=tea', undefined, 'commerce-1<script>'),
    /<|>/,
  );
});

test('快捷指令只在真实可见资料存在时出现', () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/6a9134be000000002a03325e?xsec_token=drop-me';
  const withoutComments = profiles.build({
    url: noteUrl,
    title: '笔记标题',
    rawText: '正文可见文字',
    images: [{ url: 'https://img.example/note.jpg?token=temporary' }],
    comments: [],
    structured: {
      kind: 'xhs-note',
      title: '小红书图文',
      facts: [{ label: '标题', value: '笔记标题' }],
      resources: [{ id: 'xhs-content', token: '@图文', label: '图文', available: true }],
    },
  });
  assert.ok(withoutComments.actions.some((item) => item.id === 'xhs-analyze-current-note'));
  assert.ok(!withoutComments.actions.some((item) => item.id === 'xhs-analyze-comments'));
  assert.doesNotMatch(withoutComments.context.url, /xsec_token/);

  const withComments = profiles.build({
    url: noteUrl,
    title: '笔记标题',
    rawText: '正文可见文字',
    images: [{ url: 'https://img.example/note.jpg' }],
    comments: [{ author: '用户', text: '评论内容' }],
    structured: {
      kind: 'xhs-note',
      title: '小红书图文',
      facts: [{ label: '标题', value: '笔记标题' }],
      resources: [
        { id: 'xhs-content', token: '@图文', label: '图文', available: true },
        { id: 'xhs-comments', token: '@评论', label: '评论', available: true },
      ],
    },
  });
  assert.ok(withComments.actions.some((item) => item.id === 'xhs-analyze-comments'));
  assert.deepEqual(Array.from(withComments.resources, (item) => item.token), ['@图文', '@评论']);

  const noVisibleData = profiles.build({ url: noteUrl, title: '笔记标题' });
  assert.deepEqual(Array.from(noVisibleData.actions), []);
  assert.deepEqual(Array.from(noVisibleData.resources), []);
});

test('达摩盘与 1688 仅暴露各自页型的快捷分析', () => {
  const report = profiles.build({
    url: 'https://dmp.taobao.com/items/growup-path',
    rawText: '商品成长阶段 可见指标',
    metrics: ['成交额 1000'],
    structured: {
      kind: 'dmp-growup-path',
      title: '达摩盘 > 商品打爆路径',
      facts: [
        { label: '当前商品', value: '本品 A' },
        { label: '对比商品', value: '竞品 B' },
      ],
      resources: [{ id: 'dmp-growup-path', token: '@本品与竞品打爆路径对比', label: '本品与竞品打爆路径对比', available: true }],
    },
  });
  assert.deepEqual(Array.from(report.actions, (item) => item.id), ['dmp-growup-analyze', 'dmp-growup-summary', 'dmp-growup-plan']);

  const factory = profiles.build({
    url: 'https://s.1688.com/company/pc/factory_search.htm?keywords=%E6%9D%AF%E5%AD%90',
    rawText: '工厂搜索结果',
    cards: [{ title: '工厂 A', text: '主营杯子' }],
    structured: {
      kind: '1688-factory-search',
      title: '1688 找工厂',
      facts: [{ label: '关键词', value: '杯子' }],
      resources: [{ id: '1688-factory-search', token: '@工厂搜索结果', label: '工厂搜索结果', available: true }],
    },
  });
  assert.equal(factory.profile.id, '1688-factory-search');
  assert.ok(factory.actions.some((item) => item.id === '1688-factory-search-strength'));

  [
    'https://myseller.taobao.com/',
    'https://sycm.taobao.com/',
    'https://dmp.taobao.com/',
    'https://www.xiaohongshu.com/',
    'https://www.douyin.com/',
    'https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%9D%AF%E5%AD%90',
  ].forEach((url) => assert.equal(profiles.keepsProductQuickActions(profiles.classify(url)), false, url));
  assert.equal(profiles.keepsProductQuickActions(profiles.classify('https://detail.1688.com/offer/123456789.html')), true);
});

test('六站点只接受各自页型的资源，不跨站点借用图文或报表规则', () => {
  const cases = [
    {
      name: '千牛', url: 'https://myseller.taobao.com/app/customer-service/toolPage/Message', kind: 'qianniu-service',
      resources: [{ id: 'qianniu-chat-records', token: '@聊天记录', label: '聊天记录' }], expected: ['@聊天记录'], forbidden: ['@图文', '@当前报表'],
    },
    {
      name: '生意参谋', url: 'https://sycm.taobao.com/marketing', kind: 'sycm-marketing',
      resources: [{ id: 'sycm-current-report', token: '@营销概况', label: '营销概况' }], expected: ['@营销概况'], forbidden: ['@图文', '@聊天记录'],
    },
    {
      name: '达摩盘', url: 'https://dmp.taobao.com/items/shop-insight', kind: 'dmp-shop-insight',
      resources: [{ id: 'dmp-shop-overview', token: '@店铺概况', label: '店铺概况' }, { id: 'dmp-shop-items', token: '@商品列表', label: '商品列表' }], expected: ['@店铺概况', '@商品列表'], forbidden: ['@图文', '@当前报表'],
    },
    {
      name: '小红书', url: 'https://www.xiaohongshu.com/explore/6a9134be000000002a03325e', kind: 'xhs-note',
      resources: [{ id: 'xhs-content', token: '@图文', label: '图文' }, { id: 'xhs-comments', token: '@评论', label: '评论' }], expected: ['@图文', '@评论'], forbidden: ['@聊天记录', '@当前报表'],
    },
    {
      name: '抖音', url: 'https://www.douyin.com/video/7450000000000000000', kind: 'douyin-work',
      resources: [{ id: 'douyin-content', token: '@视频', label: '视频' }], expected: ['@视频'], forbidden: ['@评论', '@当前报表'],
    },
    {
      name: '1688', url: 'https://detail.1688.com/offer/123456789.html', kind: '1688-detail',
      resources: [
        { id: '1688-product-info', token: '@商品信息', label: '商品信息' },
        { id: '1688-main-videos', token: '@主图视频', label: '主图视频' },
        { id: '1688-main-images', token: '@主图', label: '主图' },
        { id: '1688-detail-images', token: '@详情页长图', label: '详情页长图' },
        { id: '1688-detail-image-files', token: '@详情页多图', label: '详情页多图' },
        { id: '1688-sku-images', token: '@SKU图', label: 'SKU图' },
        { id: '1688-sku-list', token: '@SKU列表', label: 'SKU列表' },
        { id: '1688-reviews', token: '@评价数据', label: '评价数据' },
      ], expected: ['@商品信息', '@主图视频', '@主图', '@详情页长图', '@详情页多图', '@SKU图', '@SKU列表', '@评价数据'], forbidden: ['@图文', '@聊天记录'],
    },
  ];
  for (const current of cases) {
    const view = profiles.build({
      url: current.url,
      rawText: '当前页面已渲染资料',
      cards: [{ title: '当前卡片', text: '当前资料' }],
      comments: [{ author: '用户', text: '当前评论' }],
      structured: {
        title: `${current.name}当前页`, kind: current.kind,
        facts: [{ label: '页面字段', value: '已读取' }],
        resources: current.resources,
      },
    });
    const tokens = Array.from(view.resources, (item) => item.token);
    assert.deepEqual(tokens, current.expected, current.name);
    for (const token of current.forbidden) assert.ok(!tokens.includes(token), `${current.name} 不应出现 ${token}`);
  }
});

test('六站点页面隐藏淘宝商品任务快捷栏', () => {
  assert.match(analysisMarkup, /id="productQuickGrid"/);
  assert.match(analysisCss, /\.quick-grid\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(analysisSource, /grid\.hidden = !retainProductQuickActions/);
});

test('六站点只展示页型提取的实况字段，不转储整页文字', () => {
  const cases = [
    { url: 'https://myseller.taobao.com/app/customer-service/toolPage/Message', kind: 'qianniu-service', expected: 'qianniu-service', resources: [{ id: 'qianniu-chat-records', token: '@聊天记录', label: '聊天记录' }] },
    { url: 'https://sycm.taobao.com/marketing', kind: 'sycm-marketing', expected: 'sycm-marketing', resources: [{ id: 'sycm-current-report', token: '@营销概况', label: '营销概况' }] },
    { url: 'https://dmp.taobao.com/items/growup-path', kind: 'dmp-growup-path', expected: 'dmp-growup-path', resources: [{ id: 'dmp-growup-path', token: '@本品与竞品打爆路径对比', label: '本品与竞品打爆路径对比' }] },
    { url: 'https://www.xiaohongshu.com/', kind: 'xhs-note', expected: 'xhs-current-note', resources: [{ id: 'xhs-content', token: '@图文', label: '图文' }] },
    { url: 'https://www.douyin.com/', kind: 'douyin-work', expected: 'douyin-current-work', resources: [{ id: 'douyin-content', token: '@视频', label: '视频' }] },
    { url: 'https://detail.1688.com/offer/123456789.html', kind: '1688-detail', expected: '1688-detail', resources: [{ id: '1688-product-info', token: '@商品信息', label: '商品信息' }] },
  ];
  for (const { url, kind, expected, resources } of cases) {
    const view = profiles.build({
      url,
      title: '当前页面标题',
      headings: ['可见标题'],
      metrics: ['可见指标 100'],
      cards: [{ title: '可见卡片', text: '当前页面资料' }],
      comments: [{ author: '用户', text: '可见评论' }],
      images: [{ url: 'https://img.example/current.jpg?temporary=1' }],
      rawText: '无关背景瀑布流、导航和登录提示，不应出现在实况卡中',
      structured: {
        title: '当前页型',
        kind,
        facts: [
          { label: '核心字段', value: '已提取的业务数据' },
          { label: '统计周期', value: '近 7 天' },
        ],
        resources,
        excerpt: '仅供分析使用的主体摘录',
      },
    });
    const preview = profiles.pagePreview(view);
    assert.ok(preview, url);
    assert.equal(view.profile.id, expected, url);
    assert.match(preview.title, /实况/, url);
    assert.deepEqual(Array.from(preview.facts, (entry) => entry.label), ['核心字段', '统计周期'], url);
    assert.doesNotMatch(preview.copyText, /无关背景|img\.example|temporary/, url);
  }
  assert.match(analysisSource, /pageContextPlaceholder: true/);
  assert.match(analysisSource, /upsertSiteAssistantPreview\(view\)/);
  assert.match(analysisSource, /currentTab\.siteAssistantProfile = view\.profile/);
  assert.match(analysisMarkup, /commerce-assistant-profiles\.js\?v=/);
  assert.match(desktopMainSource, /const structuredPage = \(\) =>/);
  assert.match(desktopMainSource, /const modalNote = root !== document\.body/);
  for (const title of ['小红书图文', '抖音当前视频', '客服 > 聊天记录', '生意参谋 > ', '达摩盘 > ', '1688 商品详情']) {
    assert.match(desktopMainSource, new RegExp(title), title);
  }
  for (const host of ['myseller.taobao.com', 'qianniu.taobao.com', 'sycm.taobao.com', 'dmp.taobao.com', 'xiaohongshu.com', 'rednote.com', 'douyin.com', '1688.com']) {
    assert.match(desktopMainSource, new RegExp(`ASSISTANT_CONTEXT_HOSTS\\s*=\\s*\\[[\\s\\S]*?'${host.replace('.', '\\.')}'`), host);
  }
});
