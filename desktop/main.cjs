const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, Notification, Menu, clipboard, nativeImage } = require('electron');
// 让内嵌跨境平台优先按简体中文协商页面语言；站点仍可依据自己的能力或已保存偏好决定最终显示。
app.commandLine.appendSwitch('lang', 'zh-CN');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { DesktopUpdater } = require('./updater.cjs');
const {
  MODULE_TARGETS: DABI_MODULE_TARGETS,
  createDabiNetworkCapture,
  createDabiVisibleAgent,
} = require('./dabi-agent.cjs');
const { collectDabiSkuCaptureScript, collectDabiSkuRevealScript } = require('../tools/commerce-analysis/sku-page-state.cjs');
const {
  collectDabiProductCaptureScript,
  collectDabiDetailRevealScript,
  collectDabiVideoRevealScript,
  enrichDabiProductCategory,
  filterDabiMainImages,
} = require('../tools/commerce-analysis/product-page-state.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const APP_NAME = '小美画布-测试版';
const TEST_API_PORT = 3300;
const TEST_BROWSER_PORT = 9327;
const APP_DATA_ROOT = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || app.getPath('appData'))
  : app.getPath('appData');
const TEST_RUNTIME_DATA_ROOT = app.isPackaged
  ? path.join(APP_DATA_ROOT, APP_NAME)
  : PROJECT_ROOT;
const TEST_USER_DATA_ROOT = app.isPackaged
  ? path.join(TEST_RUNTIME_DATA_ROOT, 'electron')
  : path.join(PROJECT_ROOT, 'user_data');
const TEST_TEMP_ROOT = path.join(TEST_RUNTIME_DATA_ROOT, 'tmp');
try {
  [TEST_RUNTIME_DATA_ROOT, TEST_USER_DATA_ROOT, TEST_TEMP_ROOT].forEach((directory) => {
    fs.mkdirSync(directory, { recursive: true });
  });
  process.env.XIAOMEI_CANVAS_DATA_ROOT = TEST_RUNTIME_DATA_ROOT;
  process.env.XIAOMEI_CANVAS_PORT = String(TEST_API_PORT);
  process.env.COMMERCE_ANALYSIS_BROWSER_PORT = String(TEST_BROWSER_PORT);
  process.env.TEMP = TEST_TEMP_ROOT;
  process.env.TMP = TEST_TEMP_ROOT;
  const bundledSkills = path.join(PROJECT_ROOT, 'data', 'agent_skills');
  const runtimeSkills = path.join(TEST_RUNTIME_DATA_ROOT, 'data', 'agent_skills');
  if (TEST_RUNTIME_DATA_ROOT !== PROJECT_ROOT && fs.existsSync(bundledSkills) && !fs.existsSync(runtimeSkills)) {
    fs.cpSync(bundledSkills, runtimeSkills, { recursive: true });
  }
} catch {}
const APP_ICON_PATH = path.join(PROJECT_ROOT, 'static', 'images', 'app-icon.ico');
const CONFIGURED_API_PORT = TEST_API_PORT;
let API_PORT = CONFIGURED_API_PORT;
let LOCAL_ORIGIN = `http://127.0.0.1:${API_PORT}`;

function setApiEndpoint(port) {
  const value = Math.max(1, Math.min(65535, Number(port) || CONFIGURED_API_PORT));
  API_PORT = value;
  LOCAL_ORIGIN = `http://127.0.0.1:${value}`;
}
function readApiEnvValue(name) {
  try {
    const envPath = path.join(TEST_RUNTIME_DATA_ROOT, 'API', '.env');
    const key = String(name || '').trim();
    if (!key || !fs.existsSync(envPath)) return '';
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] !== key) continue;
      return String(match[2] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return '';
}
const DEFAULT_TRANSLATION_ENDPOINT = 'http://127.0.0.1:5000/translate';
const TRANSLATION_ENDPOINT = String(
  process.env.XIAOMEI_TRANSLATE_URL
    || readApiEnvValue('XIAOMEI_TRANSLATE_URL')
    || DEFAULT_TRANSLATION_ENDPOINT,
).trim();
const TRANSLATION_API_KEY = String(
  process.env.XIAOMEI_TRANSLATE_API_KEY
    || readApiEnvValue('XIAOMEI_TRANSLATE_API_KEY')
    || '',
).trim();
const TRANSLATION_MAX_SEGMENTS = 240;
const TRANSLATION_MAX_CHARS = 24000;
const TRANSLATION_BATCH_ITEMS = 32;
const TRANSLATION_BATCH_CHARS = 6000;
const configuredReviewSamples = process.env.XIAOMEI_DABI_MAX_REVIEW_SAMPLES
  || process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES
  || readApiEnvValue('XIAOMEI_DABI_MAX_REVIEW_SAMPLES')
  || readApiEnvValue('COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES');
if (configuredReviewSamples && !process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES) {
  process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES = String(configuredReviewSamples);
}
const START_PAGE = ['online', 'gpt-chat', 'canvas', 'commerce', 'commerce-analysis', 'asset-manager', 'prompt-library', 'api-settings']
  .includes(String(process.env.XIAOMEI_CANVAS_START_PAGE || 'commerce-analysis'))
  ? String(process.env.XIAOMEI_CANVAS_START_PAGE || 'commerce-analysis')
  : 'commerce-analysis';
const ALLOWED_HOSTS = [
  '127.0.0.1', 'localhost', 'taobao.com', 'tmall.com', 'alicdn.com',
  'taobaocdn.com', 'myseller.taobao.com', 'qianniu.taobao.com', 'sycm.taobao.com',
  'dmp.taobao.com', '1688.com', 'tb.cn', 'xiaohongshu.com', 'rednote.com', 'douyin.com',
];
// 跨境平台会按地区把首页跳到不同国家/地区域名。白名单必须覆盖这些
// 官方域名，否则“打开了页面但地址栏/标签仍停在旧平台”的状态会再次出现。
// 这里仍然保持显式后缀白名单，不使用过宽的 *.com 规则。
const MARKETPLACE_HOST_FAMILIES = Object.freeze({
  amazon: [
    'amazon.com', 'amazon.cn', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it',
    'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.in',
    'amazon.com.mx', 'amazon.com.br', 'amazon.nl', 'amazon.pl', 'amazon.se',
    'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.tr', 'amazon.eg',
  ],
  tiktok: ['tiktok.com', 'tiktokshop.com'],
  temu: [
    'temu.com', 'temu.co.uk', 'temu.de', 'temu.fr', 'temu.it', 'temu.es', 'temu.nl',
    'temu.pl', 'temu.se', 'temu.au', 'temu.ca', 'temu.mx', 'temu.cl', 'temu.co',
    'temu.com.br', 'temu.jp', 'temu.kr',
  ],
  shopee: [
    'shopee.com', 'shopee.co.id', 'shopee.sg', 'shopee.co.th', 'shopee.co.my',
    'shopee.vn', 'shopee.ph', 'shopee.tw', 'shopee.com.br', 'shopee.cl', 'shopee.pl',
  ],
  ozon: ['ozon.ru', 'ozon.com'],
  ebay: [
    'ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.ca',
    'ebay.com.au', 'ebay.at', 'ebay.be', 'ebay.ch', 'ebay.ie', 'ebay.nl', 'ebay.pl',
    'ebay.com.sg', 'ebay.com.my', 'ebay.ph', 'ebay.in',
  ],
  aliexpress: ['aliexpress.com', 'aliexpress.ru', 'aliexpress.us'],
  shein: ['shein.com', 'shein.co.uk', 'shein.de', 'shein.fr', 'shein.it', 'shein.es'],
});
const MARKETPLACE_NAVIGATION_HOSTS = Object.freeze([
  ...new Set(Object.values(MARKETPLACE_HOST_FAMILIES).flat()),
]);
const NAVIGATION_HOSTS = [...ALLOWED_HOSTS, ...MARKETPLACE_NAVIGATION_HOSTS];
const AMAZON_PREFERRED_LANGUAGE = 'zh_CN';
const AMAZON_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.7';
const AMAZON_LANGUAGE_URL_PATTERNS = Object.freeze(
  MARKETPLACE_HOST_FAMILIES.amazon.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]),
);
const TAOBAO_CHROME_URL_PATTERNS = Object.freeze([
  '*://taobao.com/*', '*://*.taobao.com/*',
  '*://tmall.com/*', '*://*.tmall.com/*',
  '*://1688.com/*', '*://*.1688.com/*',
  '*://tb.cn/*', '*://*.tb.cn/*',
]);
const COMMERCE_REQUEST_HEADER_URL_PATTERNS = Object.freeze([
  ...new Set([...AMAZON_LANGUAGE_URL_PATTERNS, ...TAOBAO_CHROME_URL_PATTERNS]),
]);
const COMMERCE_REQUEST_HEADER_SESSIONS = new WeakSet();
const SELLER_HOSTS = ['myseller.taobao.com', 'qianniu.taobao.com', 'sycm.taobao.com', '1688.com'];
const ASSISTANT_CONTEXT_HOSTS = ['myseller.taobao.com', 'qianniu.taobao.com', 'sycm.taobao.com', 'dmp.taobao.com', '1688.com', 'xiaohongshu.com', 'rednote.com', 'douyin.com'];
// 淘宝、1688 和千牛必须使用不同的 Chromium 持久会话。保留旧的淘宝
// partition 作为淘宝侧，避免升级后让已有淘宝登录态失效；1688 使用新的
// 独立分区，避免淘宝页面/登录态覆盖 1688 页面。
const TAOBAO_SESSION_PARTITION = 'persist:xiaomei-canvas-test-commerce';
const SESSION_1688_PARTITION = 'persist:xiaomei-canvas-test-1688';
const SELLER_SESSION_PARTITION = 'persist:xiaomei-canvas-test-qianniu';
const OZON_DIRECT_SESSION_PARTITION = 'persist:xiaomei-canvas-test-ozon';
const SHARED_CANVAS_PRELOAD_PATH = path.join(__dirname, 'shared-canvas-preload.cjs');
const VERIFICATION_HOST_RE = /(?:^|\.)(?:captcha|verify|security|sec|punish)\.(?:taobao|tmall)\.com$/i;
const SAFE_AGENT_ACTIONS = new Set(['inspect', 'scroll', 'click_tab', 'expand', 'paginate', 'extract', 'wait', 'finish']);
const SAFE_AGENT_MODULES = new Set(['product', 'images', 'reviews', 'questions', 'detail', 'sku', 'videos', 'operations', 'page']);
const COMMERCE_REVIEW_SAMPLE_LIMIT = Math.max(
  20,
  Math.min(
    5000,
    Number(configuredReviewSamples || 200) || 200,
  ),
);
const SAFE_AGENT_LABELS = new Set([
  '用户评价', '累计评价', '评价', '问大家', '问答', '参数信息', '图文详情', '详情', '商品详情', 'SKU', '规格',
  '视频', '主图视频', '商品视频',
  '更多', '更多评价', '更多回答', '查看全部', '查看全部评价', '查看全部问答', '查看更多问答', '查看更多', '加载更多', '展开', '下一页', '后一页', '下页', '下一组',
]);

let mainWindow;
let updateWindow;
let productView;
const productViews = new Map();
const sharedCanvasWindows = new Map();
let activeProductTabId = '';
let apiProcess;
let desktopUpdateCheckPromise = null;
let desktopUpdatePromptPromise = null;
let desktopUpdateOperationPromise = null;
let desktopUpdateAbortController = null;
let desktopUpdateLaunchInProgress = false;
let desktopUpdateWindowState = null;
let desktopUpdateWindowProgress = null;
let desktopUpdateStartupTimer = null;
let productUrl = '';
let lastSurfaceBounds = null;
let ozonDirectSessionReady = false;
let commerceSurfaceResyncToken = 0;
// 顶层商品 WebContentsView 只能在“商品分析”外层页面拥有显示权。
// 商品分析 iframe 切走后，仍可能有迟到的异步标签回调请求 setVisible(true)，
// 这里在主进程再做一层闸门，避免商品页重新盖到画布或其它工作区上。
let commercePageActive = false;
// syncCommercePageActiveFromRenderer() 会跨越一次异步的 executeJavaScript。
// 若用户在这段时间切走工作区，旧的读取结果不能把商品页重新激活。
let commercePageActiveRevision = 0;
// 普通 DOM 的弹层（例如外观设置）无法覆盖顶层 WebContentsView。
// 弹层打开时临时屏蔽商品视图，并在关闭后只恢复打开弹层前确实可见的那一个标签。
let commerceSurfaceBlocked = false;
let commerceSurfaceWasVisible = false;
let commerceSurfaceWasVisibleTabId = '';
const activeDabiCollections = new Map();
const INTERACTIVE_DABI_MODULES = new Set(['reviews', 'questions', 'reviews_questions']);

// 注入到商品 WebContentsView 的达笔式操作提示。商品页是独立的顶层视图，
// 因此提示必须跟随页面注入，不能只放在小美 iframe 后面的 HTML 层。
const ELECTRON_DABI_OPERATION_OVERLAY_SCRIPT = String.raw`(({ visible, message }) => {
  const rootId = '__xiaomei_dabi_operation_overlay__';
  const styleId = '__xiaomei_dabi_operation_overlay_style__';
  const stopSignal = '__XIAOMEI_DABI_STOP__';
  const existing = document.getElementById(rootId);
  if (!visible) {
    existing?.remove();
    document.getElementById(styleId)?.remove();
    return { ok: true, visible: false };
  }
  if (!document.body) return { ok: false, reason: 'body_not_ready' };
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = '#__xiaomei_dabi_operation_overlay__{position:fixed;inset:7px;z-index:2147483647;pointer-events:none;border:2px solid rgba(54,120,239,.82);border-radius:10px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.72),0 0 0 4px rgba(74,137,244,.08);animation:__xiaomei_agent_frame_pulse 1.8s ease-in-out infinite}#__xiaomei_dabi_operation_overlay__ .x-agent-banner{display:flex;align-items:center;gap:8px;min-width:min(510px,92%);max-width:calc(100% - 18px);margin:12px auto 0;padding:8px 10px;border:1px solid #9fc3ff;border-radius:18px;background:rgba(239,247,255,.96);color:#1d5dbd;box-shadow:0 7px 17px rgba(47,104,202,.16);pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}#__xiaomei_dabi_operation_overlay__ .x-agent-icon{position:relative;display:grid;place-items:center;width:21px;height:21px;flex:0 0 21px;border-radius:50%;background:#2f76e9;color:#fff;font-size:11px;animation:__xiaomei_agent_icon_pulse 1.2s ease-in-out infinite}#__xiaomei_dabi_operation_overlay__ .x-agent-icon:after{position:absolute;inset:-4px;border:1px solid rgba(47,118,233,.35);border-radius:50%;content:"";animation:__xiaomei_agent_icon_ring 1.2s ease-out infinite}#__xiaomei_dabi_operation_overlay__ .x-agent-copy{display:flex;align-items:baseline;gap:7px;min-width:0;flex:1}#__xiaomei_dabi_operation_overlay__ .x-agent-copy strong{color:#1b5bb9;font-size:12px;white-space:nowrap}#__xiaomei_dabi_operation_overlay__ .x-agent-copy span{min-width:0;overflow:hidden;color:#5575a5;font-size:10px;text-overflow:ellipsis;white-space:nowrap}#__xiaomei_dabi_operation_overlay__ button{height:24px;padding:0 11px;border:1px solid #6ca1f2;border-radius:13px;background:#fff;color:#2e6fd5;font-size:10px;font-weight:700;cursor:pointer}#__xiaomei_dabi_operation_overlay__ button:hover{border-color:#2f76e9;background:#edf5ff}@keyframes __xiaomei_agent_frame_pulse{0%,100%{opacity:.78}50%{opacity:1}}@keyframes __xiaomei_agent_icon_pulse{0%,100%{transform:scale(.9)}50%{transform:scale(1)}}@keyframes __xiaomei_agent_icon_ring{0%{opacity:.7;transform:scale(.7)}100%{opacity:0;transform:scale(1.35)}}';
    document.documentElement.appendChild(style);
  }
  let root = document.getElementById(rootId);
  if (!root) {
    root = document.createElement('div');
    root.id = rootId;
    const banner = document.createElement('div');
    banner.className = 'x-agent-banner';
    const icon = document.createElement('span');
    icon.className = 'x-agent-icon';
    icon.textContent = '✦';
    const copy = document.createElement('span');
    copy.className = 'x-agent-copy';
    const title = document.createElement('strong');
    title.textContent = '智能体正在操作';
    const detail = document.createElement('span');
    detail.dataset.agentMessage = 'true';
    detail.textContent = '不要切换页面，请耐心等待';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止';
    stop.addEventListener('click', () => console.log(stopSignal));
    copy.append(title, detail);
    banner.append(icon, copy, stop);
    root.appendChild(banner);
    document.body.appendChild(root);
  }
  const detail = root.querySelector('[data-agent-message="true"]');
  if (detail && message) detail.textContent = String(message).slice(0, 180);
  return { ok: true, visible: true };
})`;

function setDabiAgentOverlay(entry, visible, message = '') {
  const webContents = entry?.view?.webContents;
  if (!webContents || webContents.isDestroyed()) return Promise.resolve();
  const task = () => webContents.executeJavaScript(`(${ELECTRON_DABI_OPERATION_OVERLAY_SCRIPT})(${JSON.stringify({ visible: Boolean(visible), message: String(message || '') })})`, true).catch(() => null);
  entry.agentOverlayPromise = (entry.agentOverlayPromise || Promise.resolve()).then(task).catch(() => null);
  return entry.agentOverlayPromise;
}

// 淘宝新版页面不会把 SKU 作为普通商品字段返回，规格选项通常只存在于
// 当前可见 DOM 或页面初始化状态中。桌面版不能直接复用 CDP 采集器，因此
// 在 WebContentsView 内执行一个只读提取脚本，把真实可见的规格、选项和当前
// 组合带回 FastAPI；没有找到时仍返回空结构，不生成样例数据。
const ELECTRON_DABI_STRUCTURED_SKU_SCRIPT = collectDabiSkuCaptureScript();
const ELECTRON_DABI_SKU_REVEAL_SCRIPT = collectDabiSkuRevealScript();

// 达比在淘宝新版页面上直接读取初始化状态，不等待整页滚动或逐个点击标签。
// Electron 商品页先使用同一份可见页面状态读取商品、主图、视频和 SKU，
// 再通过下方的达比式可见操作链采集评价和问大家样本，不把整棵页面状态外传。
const ELECTRON_DABI_PRODUCT_STATE_SCRIPT = collectDabiProductCaptureScript();
const ELECTRON_DABI_DETAIL_REVEAL_SCRIPT = collectDabiDetailRevealScript();
const ELECTRON_DABI_VIDEO_REVEAL_SCRIPT = collectDabiVideoRevealScript();

// 商品基础信息先从页面可见状态读取；评价正文由目标 mtop 响应提供，问大家在
// 响应不可回读时只读取已打开抽屉里的可见问答卡。这里不扫描整页，也不注入
// 外部脚本、不读取 Cookie、不提交订单或修改商品。
const ELECTRON_DABI_QUESTION_VISIBLE_ACTION_SCRIPT = String.raw`(() => {
  const tidy = (value, limit = 2400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const textOf = (node) => tidy(node?.innerText || node?.textContent || '', 2400);
  const module = 'questions';
  const countPattern = /(?:问大家|买家问答|常见问题)\s*[·:：]?\s*([0-9.万千kK+]+)/i;
  const parseQuestionPairs = (value) => {
    const compact = String(value || '').replace(/\s+/g, ' ').trim()
      .replace(/^.*?问大家\s*[·:：]?\s*\d+(?:\.\d+)?[万千kK+]?\s*/i, '')
      .replace(/\s*(?:查看全部问答|查看全部回答|查看更多问答).*$/i, '');
    const parts = compact.split(/\s+(?=问\s*[:：]?)/).filter((part) => /^问\s*[:：]?/.test(part));
    return parts.map((part) => {
      const clean = part.replace(/^问\s*[:：]?\s*/i, '').replace(/\s*更多回答(?:\s+\d+)?\s*$/i, '').trim();
      const qa = clean.match(/^(.+?(?:[?？]|吗|呢|啊|呀|怎样|怎么样|如何|怎么|多少|哪里|多久|什么|能不能|可不可以|好不好|是否)[。！？!?]?)(?:\s+(.+))?$/);
      return qa ? { question: qa[1].trim(), answer: tidy(qa[2] || '', 1200) } : null;
    }).filter((item) => item && item.question.length >= 4);
  };
  const questionRoot = () => [...document.querySelectorAll('[class*="AskAnswersWrap--"] [class*="ContentArea--"], [class*="AskAnswersWrap--"], [class*="leftDrawer"]')]
    .filter(visible)
    .sort((left, right) => textOf(left).length - textOf(right).length)[0] || null;
  const questionItems = () => {
    const root = questionRoot();
    if (!root) return [];
    const nodes = [root, ...root.querySelectorAll('*')]
      .filter(visible)
      .map((node) => ({ node, text: textOf(node), pairs: parseQuestionPairs(node.innerText) }))
      .filter((item) => item.pairs.length === 1);
    const selected = new Map();
    for (const item of nodes) {
      const pair = item.pairs[0];
      const key = pair.question.replace(/\s+/g, ' ').trim().toLowerCase();
      const score = pair.answer.length * 10 + Math.min(item.text.length, 1800);
      if (!selected.has(key) || score > selected.get(key).score) selected.set(key, { ...pair, score });
    }
    return [...selected.values()].slice(0, 2000).map(({ score, ...item }) => ({ ...item, text: item.question }));
  };
  const extract = () => {
    const values = questionItems();
    const drawerText = questionRoot() ? textOf(questionRoot()) : '';
    return {
      ok: true,
      module,
      samples: values,
      sampleCount: values.length,
      totalCount: drawerText.match(countPattern)?.[1] || '',
      scrollY: Math.round(window.scrollY || 0),
      bodyHeight: Number(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0),
    };
  };
  return { ...extract(), action: 'inspect', module };
})()`;

function sendCollectionProgress(entry, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const progress = {
    tabId: entry?.id || activeProductTabId,
    url: entry?.url || productUrl,
    at: Date.now(),
    ...payload,
  };
  const status = String(progress.status || '').toLowerCase();
  const requestedModule = String(progress.module || '').trim();
  const interactionMode = String(
    progress.interactionMode
      || (INTERACTIVE_DABI_MODULES.has(requestedModule) ? 'visible' : 'passive'),
  ).toLowerCase() === 'visible' ? 'visible' : 'passive';
  progress.interactionMode = interactionMode;
  if (status === 'running') void setDabiAgentOverlay(entry, interactionMode === 'visible', progress.message || '');
  else if (['ready', 'partial', 'stopped', 'error'].includes(status)) void setDabiAgentOverlay(entry, false, progress.message || '');
  mainWindow.webContents.send('commerce:collection-progress', progress);
}

function stopActiveDabiCollection(entry = activeProductEntry()) {
  let targetEntry = entry;
  let webContents = targetEntry?.view?.webContents;
  let key = webContents?.id;
  let token = key ? activeDabiCollections.get(key) : null;
  if (!token) {
    for (const candidate of productViews.values()) {
      const candidateContents = candidate?.view?.webContents;
      const candidateToken = candidateContents ? activeDabiCollections.get(candidateContents.id) : null;
      if (candidateToken) { targetEntry = candidate; webContents = candidateContents; key = candidateContents.id; token = candidateToken; break; }
    }
  }
  if (!token) return { ok: false, message: '当前没有正在运行的桌面智能体' };
  token.cancelled = true;
  token.stopMessage = '已停止桌面智能体操作，已保留停止前读取到的数据。';
  sendCollectionProgress(targetEntry, { status: 'stopped', action: 'stop', message: token.stopMessage });
  return { ok: true, status: 'stopped', message: token.stopMessage };
}

const visibleRecordKey = (item, field) => String(item?.[field] || item?.text || item?.content || item?.question || '').replace(/\s+/g, ' ').trim();
function mergeVisibleRecords(left, right, field, limit = 200) {
  const output = [];
  for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    const key = visibleRecordKey(item, field);
    if (!key || key.length < 4) continue;
    const existingIndex = output.findIndex((entry) => {
      const current = visibleRecordKey(entry, field);
      return current === key || current.includes(key) || key.includes(current);
    });
    if (existingIndex >= 0) {
      if (JSON.stringify(item).length > JSON.stringify(output[existingIndex]).length) output[existingIndex] = { ...output[existingIndex], ...item };
      continue;
    }
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

// 桌面版的真实采集器：截图/固定目标定位/鼠标点击/滚轮由 Dabi 风格 CDP
// Agent 完成，评价样本优先由同一时间窗里的目标 mtop 响应解析；问大家在
// 页面已预载入但没有可回读响应时，只从已打开抽屉的可见问答卡精确提取，
// 不把整页 innerText 当作评价或问大家记录。
async function collectDabiNetworkModule(entry, webContents, module, collection, capture, agent, options = {}) {
  const target = DABI_MODULE_TARGETS[module];
  if (!target) throw new Error(`未知达比采集模块：${module}`);
  const maxPasses = Math.max(4, Math.min(200, Number(options.maxPasses) || 40));
  const delay = Math.max(220, Math.min(1200, Number(options.delay) || 360));
  const pageTotalCount = String(options.pageTotalCount || options.knownTotalCount || '').trim();
  const label = target.label;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isCancelled = () => Boolean(options.isCancelled?.());
  let unchanged = 0;
  let endStalls = 0;
  let lastSampleCount = 0;
  let lastVisibleSampleCount = 0;
  let noDataPasses = 0;
  let screenshotCount = 0;
  const beforeResponses = capture.records[module].length;
  let lastResponseCount = beforeResponses;
  const sampleLimit = module === 'reviews' ? COMMERCE_REVIEW_SAMPLE_LIMIT : 2000;
  let visibleTotalCount = pageTotalCount;
  let visibleSamples = [];
  const dismissDabiPanels = async () => {
    // 淘宝新版问大家抽屉的关闭按钮会随模板变化，固定 closeWrap
    // 选择器可能找不到；Esc 是同一可见页面操作链里的安全兜底。
    for (const close of [DABI_MODULE_TARGETS.reviews.close, DABI_MODULE_TARGETS.questions.close]) {
      await agent.clickSelector(close).catch(() => {});
    }
    for (let pass = 0; pass < 2; pass += 1) {
      await Promise.resolve(agent.pressKey?.('Escape', 'Escape', 27)).catch(() => {});
      await wait(100);
    }
  };
  const inspectVisibleQuestions = async () => {
    if (module !== 'questions') return null;
    const script = ELECTRON_DABI_QUESTION_VISIBLE_ACTION_SCRIPT;
    const result = await webContents.executeJavaScript(script, true).catch(() => null);
    if (result?.totalCount) visibleTotalCount = String(result.totalCount).trim();
    if (Array.isArray(result?.samples)) visibleSamples = mergeVisibleRecords(visibleSamples, result.samples, 'question', 2000);
    return result;
  };
  if (isCancelled()) return { samples: [], stats: {}, networkCount: 0, screenshotCount: 0, opened: false, stopped: true };
  sendCollectionProgress(entry, { status: 'running', module, action: 'screenshot', message: `正在截屏识别${label}入口…`, sampleCount: 0 });
  await agent.screenshot().then(() => { screenshotCount += 1; }).catch(() => {});

  // 页面可能在上一次模块关闭动画中；先关闭两个固定抽屉并用 Esc
  // 清理没有稳定 closeWrap 类名的问大家抽屉，再点击当前模块入口。
  if (isCancelled()) return { samples: [], stats: {}, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: false, stopped: true };
  await dismissDabiPanels();
  if (isCancelled()) return { samples: [], stats: {}, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: false, stopped: true };
  // 达笔脚本会先逐步滚动到“查看全部评价/问大家”入口，再点击；
  // 淘宝新版页面常在滚动后才挂载这个懒加载控件，不能只查一次 DOM。
  const focus = await agent.clickSelector(target.entry, { scrollUntil: true, maxScrollPasses: 24 });
  collection.actions.push({ action: 'click_tab', module, target: label, clicked: focus.text || '', ok: Boolean(focus.ok), input: 'cdp-mouse' });
  if (!focus.ok) {
    sendCollectionProgress(entry, { status: 'running', module, action: 'click_tab', message: `当前页面未找到${label}入口，未生成伪造样本。`, sampleCount: 0 });
    return { samples: [], stats: {}, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: false };
  }
  await wait(900);
  await inspectVisibleQuestions();
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (isCancelled()) return { samples: [], stats: {}, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: true, stopped: true };
    const result = await agent.scrollSelector(target.content, 600).catch(() => ({ ok: false, changed: false, atEnd: true }));
    if (result?.targetMissing) {
      // 内容抽屉没有打开时，不能回退滚动商品整页；否则会在没有任何
      // 新响应/样本的情况下连续运行几十轮，让用户误以为智能体卡死。
      if (pass === 1) {
        await wait(900);
        const retry = await agent.scrollSelector(target.content, 600).catch(() => ({ ok: false, changed: false, atEnd: true, targetMissing: true }));
        if (!retry?.targetMissing) {
          // 首轮只是抽屉动画尚未结束，继续使用重试后的结果。
          Object.assign(result, retry);
        }
      }
      if (result?.targetMissing) {
        collection.actions.push({ action: 'scroll', module, pass, amount: 600, changed: false, atEnd: true, status: 'missing', reason: result.reason || '目标采集内容区域当前不可见' });
        sendCollectionProgress(entry, { status: 'running', module, action: 'error', message: `未找到${label}内容区域，已停止本次采集；请关闭当前抽屉后重试。`, sampleCount: 0, totalCount: pageTotalCount });
        break;
      }
    }
    await capture.settle(320);
    const currentResponses = capture.records[module].length;
    const currentParsed = capture.parseModule(module, beforeResponses, webContents.getURL());
    const currentSamples = Array.isArray(currentParsed?.[module]) ? currentParsed[module] : [];
    const currentStats = module === 'reviews' ? (currentParsed?.reviewStats || {}) : (currentParsed?.questionStats || {});
    await inspectVisibleQuestions();
    const visibleSampleCount = visibleSamples.length;
    const progressSampleCount = currentSamples.length || visibleSampleCount;
    const hasNext = currentStats.hasNext === true || currentStats.hasMore === true || currentStats.hasNextPage === true;
    const sampleProgress = currentSamples.length > lastSampleCount || visibleSampleCount > lastVisibleSampleCount;
    const responseProgress = currentResponses > lastResponseCount;
    if (!responseProgress && !sampleProgress) noDataPasses += 1; else noDataPasses = 0;
    lastResponseCount = currentResponses;
    const changed = Boolean(result.changed) || currentResponses > beforeResponses || sampleProgress;
    if (!changed) unchanged += 1; else unchanged = 0;
    if (result.atEnd && !changed) endStalls += 1; else if (changed) endStalls = 0;
    lastSampleCount = currentSamples.length;
    lastVisibleSampleCount = visibleSampleCount;
    collection.actions.push({ action: 'scroll', module, pass, amount: 600, changed, atEnd: Boolean(result.atEnd), input: 'cdp-mouse-wheel', networkResponses: currentResponses - beforeResponses, visibleSampleCount });
    const liveTotalCount = pageTotalCount || String(currentStats.totalCount || '').trim() || visibleTotalCount;
    const liveCountText = liveTotalCount ? `已采集 ${progressSampleCount} 条，页面总量 ${liveTotalCount}` : `已采集 ${progressSampleCount} 条`;
    sendCollectionProgress(entry, { status: 'running', module, action: 'scroll', pass, maxPasses, message: `正在滚动采集${label}：${liveCountText}…`, sampleCount: progressSampleCount, totalCount: liveTotalCount, networkResponses: currentResponses - beforeResponses });
    await wait(delay);
    if (progressSampleCount >= sampleLimit) break;
    if (progressSampleCount === 0 && noDataPasses >= 8 && !hasNext) {
      collection.actions.push({ action: 'extract', module, target: label, sampleCount: 0, totalCount: liveTotalCount, status: 'no_data_progress' });
      sendCollectionProgress(entry, { status: 'running', module, action: 'error', message: `${label}暂未返回真实样本，已结束本轮采集；可关闭抽屉后重试。`, sampleCount: 0, totalCount: liveTotalCount });
      break;
    }
    if (result.atEnd && hasNext && endStalls < 8) continue;
    if (result.atEnd || unchanged >= 2) break;
  }
  if (isCancelled()) return { samples: [], stats: {}, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: true, stopped: true };
  await capture.settle(700);
  await inspectVisibleQuestions();
  await agent.screenshot().then(() => { screenshotCount += 1; }).catch(() => {});
  const parsed = capture.parseModule(module, beforeResponses, webContents.getURL());
  const networkSamples = Array.isArray(parsed[module]) ? parsed[module] : [];
  const visibleFallback = module === 'questions' && !networkSamples.length && visibleSamples.length > 0;
  const samples = visibleFallback ? visibleSamples : networkSamples;
  const responseStats = module === 'reviews' ? (parsed.reviewStats || {}) : (parsed.questionStats || {});
  const responseTotalCount = String(responseStats.totalCount || '').trim();
  const totalCount = pageTotalCount || responseTotalCount || visibleTotalCount;
  const sampleSource = visibleFallback ? 'dabi-visible-question' : 'mtop-rateList/questionList';
  const resolvedPageTotalCount = pageTotalCount || (visibleFallback ? visibleTotalCount : '');
  const stats = {
    ...responseStats,
    totalCount,
    ...(visibleFallback ? { sampleCount: samples.length } : {}),
    ...(resolvedPageTotalCount
      ? { pageTotalCount: resolvedPageTotalCount, totalCountSource: 'product-page-count' }
      : totalCount ? { totalCountSource: 'mtop-rateList/questionList' } : {}),
    ...(resolvedPageTotalCount && responseTotalCount && resolvedPageTotalCount !== responseTotalCount ? { responseTotalCount } : {}),
  };
  const finalTotalText = stats.totalCount ? `，页面总量 ${stats.totalCount}` : '';
  collection.actions.push({ action: 'extract', module, target: label, sampleCount: samples.length, totalCount: stats.totalCount || '', responseTotalCount, networkResponses: capture.records[module].length - beforeResponses, visibleSampleCount: visibleSamples.length, source: sampleSource });
  const extractMessage = visibleFallback ? `${label}页面可见内容采集完成，得到 ${samples.length} 条真实样本${finalTotalText}。` : `${label}真实接口采集完成，得到 ${samples.length} 条样本${finalTotalText}。`;
  sendCollectionProgress(entry, { status: 'running', module, action: 'extract', message: extractMessage, sampleCount: samples.length, totalCount: stats.totalCount || '', responseTotalCount, networkResponses: capture.records[module].length - beforeResponses, sampleSource });
  await agent.clickSelector(target.close).catch(() => {});
  await Promise.resolve(agent.pressKey?.('Escape', 'Escape', 27)).catch(() => {});
  return { samples, stats, networkCount: capture.records[module].length - beforeResponses, screenshotCount, opened: true, stopped: false, visibleFallback, sampleSource };
}

// 搜索结果页采用达比式的轻量页面策略：只读取当前可见商品卡片和搜索条件，
// 不滚动、不点击、不创建商品详情页任务。这样“问问小美”可以先回答市场概览，
// 用户需要评价/详情等深度数据时仍走原有商品采集链路。
const ELECTRON_SEARCH_CONTEXT_SCRIPT = String.raw`(() => {
  const tidy = (value, limit = 1200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const absolute = (value) => {
    try { return new URL(value, location.href).href; } catch { return ''; }
  };
  const imageUrl = (node) => {
    if (!node) return '';
    const value = node.currentSrc || node.getAttribute?.('data-src') || node.getAttribute?.('data-original')
      || node.getAttribute?.('data-lazy-src') || node.getAttribute?.('data-imgurl') || node.src || '';
    const srcset = node.getAttribute?.('srcset') || node.getAttribute?.('data-srcset') || '';
    const fallback = srcset.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
    return absolute(value || fallback);
  };
  const textOf = (node, limit = 1600) => tidy(node?.innerText || node?.textContent || '', limit);
  const itemLinkSelector = [
    'a[href*="item.taobao.com/item.htm"]',
    'a[href*="detail.tmall.com/item.htm"]',
    'a[href*="detail.tmall.hk/item.htm"]',
    'a[href*="item.htm?id="]'
  ].join(',');
  const itemIdFromUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      return String(url.searchParams.get('id') || url.searchParams.get('itemId') || url.searchParams.get('item_id') || '').match(/^\d{1,32}$/)?.[0] || '';
    } catch {
      return String(href || '').match(/[?&](?:id|itemId|item_id)=(\d{1,32})(?:[&#]|$)/)?.[1] || '';
    }
  };
  const cardFor = (link) => link.closest('[class*="doubleCardWrapper"],[class*="itemCard"],[class*="ItemCard"],[data-testid*="item-card"],li') || link.parentElement;
  const candidateTitle = (card, link) => {
    const nodes = [
      ...card.querySelectorAll('[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]'),
      link,
    ];
    const values = nodes.map((node) => textOf(node, 260)).filter((value) => value.length >= 4 && value.length <= 220);
    values.sort((a, b) => b.length - a.length);
    return values.find((value) => !/^(?:搜索|筛选|综合|销量|价格|新品|收藏|加入购物车|立即购买|淘宝|天猫)$/i.test(value)) || '';
  };
  const numberFromText = (value) => {
    const raw = String(value || '').replace(/,/g, '').trim();
    const match = raw.match(/(\d+(?:\.\d+)?)(万|千|k|K)?/);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    return match[2] ? base * ({ 万: 10000, 千: 1000, k: 1000, K: 1000 }[match[2]] || 1) : base;
  };
  const shippingFromText = (value) => {
    const text = tidy(value, 1800);
    const labeled = text.match(/(?:发货地|产地|所在地)\s*[:：]?\s*([^\s|｜]{2,24})/);
    if (labeled) return labeled[1];
    const province = text.match(/(北京|上海|天津|重庆|广东|江苏|浙江|山东|福建|河北|河南|湖北|湖南|四川|安徽|江西|陕西|山西|辽宁|吉林|黑龙江|广西|云南|贵州|甘肃|新疆|内蒙古|海南|宁夏|青海|西藏)[^\s|｜]{0,10}/);
    return province ? province[0] : '';
  };
  const bodyText = tidy(document.body?.innerText || '', 24000);
  const params = new URL(location.href).searchParams;
  let keyword = tidy(params.get('q') || params.get('keyword') || params.get('query') || '', 180);
  if (!keyword) keyword = tidy(document.querySelector('input[name="q"],input[aria-label*="搜索"],input[placeholder*="搜索"]')?.value || '', 180);
  const pageSize = Math.max(1, Number(params.get('pageSize') || params.get('n') || 48) || 48);
  const offset = Number(params.get('s') || 0);
  const page = Math.max(1, Number(params.get('page') || (Number.isFinite(offset) && offset >= 0 ? Math.floor(offset / pageSize) + 1 : 1)) || 1);
  const items = [];
  const seen = new Set();
  for (const link of [...document.querySelectorAll(itemLinkSelector)]) {
    if (!visible(link)) continue;
    const itemId = itemIdFromUrl(link.href || link.getAttribute('href') || '');
    if (!itemId || seen.has(itemId)) continue;
    const card = cardFor(link);
    if (!card || !visible(card)) continue;
    const cardText = textOf(card, 1800);
    if (!cardText) continue;
    const priceMatch = cardText.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/) || cardText.match(/(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s*元(?:\s|$)/);
    const salesMatch = cardText.match(/([0-9]+(?:\.[0-9]+)?\s*(?:万|千|k|K)?\+?)\s*(?:人付款|人收货|已售|销量|付款)/i)
      || cardText.match(/(?:已售|付款|销量)\s*([0-9]+(?:\.[0-9]+)?\s*(?:万|千|k|K)?\+?)/i);
    const sellerNode = card.querySelector('[class*="shop"],[class*="Shop"],[class*="seller"],[class*="Seller"]');
    const image = [...card.querySelectorAll('img')].map(imageUrl).find((value) => /^https?:/i.test(value)) || '';
    const itemUrl = absolute(link.href || link.getAttribute('href') || '');
    const price = priceMatch ? Number(priceMatch[1]) : null;
    const salesText = salesMatch ? tidy(salesMatch[1], 40) : '';
    items.push({
      itemId,
      title: candidateTitle(card, link),
      price: Number.isFinite(price) ? price : null,
      sales: numberFromText(salesText),
      salesText,
      shipping: shippingFromText(cardText),
      seller: textOf(sellerNode, 120),
      mainImage: image,
      itemUrl,
      text: cardText,
      sourcePage: page,
    });
    seen.add(itemId);
    if (items.length >= 80) break;
  }
  const totalMatch = bodyText.match(/(?:共|约)\s*(\d+)\s*(?:个商品|件商品|个宝贝|件宝贝)/) || bodyText.match(/(\d+)\s*(?:个商品|件商品|个宝贝|件宝贝)/);
  const priceRanges = [];
  for (const node of [...document.querySelectorAll('body *')].slice(0, 2600)) {
    if (!visible(node)) continue;
    const value = textOf(node, 120);
    if (!value || value.length > 100 || !/价格/.test(value)) continue;
    const ranges = value.match(/\d+(?:\.\d+)?\s*(?:-|~|至)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*以上/g) || [];
    for (const label of ranges) if (!priceRanges.includes(label)) priceRanges.push(label);
    if (priceRanges.length >= 8) break;
  }
  const regions = [...new Set(items.map((item) => item.shipping).filter(Boolean))].slice(0, 20);
  return {
    ok: Boolean(keyword || items.length),
    pageType: 'search',
    url: location.href,
    title: tidy(document.title, 300),
    keyword,
    page,
    pageSize,
    totalCount: totalMatch ? Number(totalMatch[1]) : null,
    visibleCount: items.length,
    priceRanges,
    shippingRegions: regions,
    items,
    rawText: bodyText,
  };
})()`;

// 六个工作应用共用的轻量只读快照。它只看当前视口中已经渲染的 DOM，
// 不滚动、不点击、不请求平台接口，也不会读取 Cookie、localStorage 或输入框值。
const ELECTRON_ASSISTANT_CONTEXT_SCRIPT = String.raw`(() => {
  const tidy = (value, limit = 1200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const rendered = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const onScreen = (node) => {
    if (!rendered(node)) return false;
    try {
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    } catch { return false; }
  };
  const textOf = (node, limit = 1600) => {
    if (!node) return '';
    const parts = [];
    const seen = new Set();
    try {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const parent = walker.currentNode?.parentElement;
        const value = tidy(walker.currentNode?.nodeValue || '', Math.min(limit, 500));
        if (!value || !parent || !onScreen(parent) || seen.has(value)) continue;
        seen.add(value);
        parts.push(value);
        if (parts.join(' ').length >= limit) break;
      }
    } catch {}
    return tidy(parts.join(' '), limit);
  };
  const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return ''; } };
  const imageUrl = (node) => {
    if (!node) return '';
    const value = node.currentSrc || node.getAttribute?.('data-src') || node.getAttribute?.('data-original') || node.getAttribute?.('data-lazy-src') || node.src || '';
    return absolute(value);
  };
  const unique = (values, limit) => [...new Set(values.filter(Boolean))].slice(0, limit);
  const headings = unique([...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],strong')]
    .filter(onScreen).map((node) => textOf(node, 240)).filter((value) => value.length >= 2), 80);
  const metrics = unique([...document.querySelectorAll('[class*="metric"],[class*="Metric"],[class*="data"],[class*="Data"],[class*="number"],[class*="Number"],[class*="count"],[class*="Count"]')]
    .filter(onScreen).map((node) => textOf(node, 320)).filter((value) => value.length >= 2), 80);
  const tables = [...document.querySelectorAll('table')].filter(onScreen).slice(0, 24).map((table) => ({
    title: textOf(table.querySelector('caption'), 180),
    rows: [...table.querySelectorAll('tr')].filter(onScreen).slice(0, 120).map((row) => [...row.querySelectorAll('th,td')].slice(0, 24).map((cell) => textOf(cell, 180)).filter(Boolean)).filter((row) => row.length),
  })).filter((table) => table.title || table.rows.length);
  const cardNodes = [...document.querySelectorAll('article,[class*="card"],[class*="Card"],[class*="item"],[class*="Item"],[class*="note"],[class*="Note"]')]
    .filter(onScreen).slice(0, 180);
  const seenCards = new Set();
  const cards = [];
  for (const node of cardNodes) {
    const text = textOf(node, 1200);
    if (text.length < 8) continue;
    const title = textOf(node.querySelector('h1,h2,h3,h4,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]'), 260);
    const key = title + '|' + text.slice(0, 180);
    if (seenCards.has(key)) continue;
    seenCards.add(key);
    const image = [...node.querySelectorAll('img')].filter(onScreen).map(imageUrl).find((value) => /^https?:/i.test(value)) || '';
    cards.push({ title, text, mainImage: image });
    if (cards.length >= 60) break;
  }
  const commentSelectors = '[class*="comment"],[class*="Comment"],[data-testid*="comment"],[data-e2e*="comment"]';
  const comments = [];
  const seenComments = new Set();
  for (const node of [...document.querySelectorAll(commentSelectors)].filter(onScreen).slice(0, 180)) {
    const text = textOf(node, 700);
    if (text.length < 2 || seenComments.has(text)) continue;
    seenComments.add(text);
    const author = textOf(node.querySelector('[class*="author"],[class*="Author"],[class*="user"],[class*="User"]'), 100);
    comments.push({ author, text });
    if (comments.length >= 60) break;
  }
  const images = [];
  const seenImages = new Set();
  for (const node of [...document.images].filter(onScreen)) {
    const url = imageUrl(node);
    if (!/^https?:/i.test(url) || seenImages.has(url)) continue;
    seenImages.add(url);
    images.push({ url, alt: tidy(node.alt || '', 160) });
    if (images.length >= 12) break;
  }
  const videoCount = [...document.querySelectorAll('video,[data-video],[data-video-url]')].filter(onScreen).length;
  // document.body.innerText 会混入视口外的整页内容；逐个文字节点按可见父节点
  // 采样，保证快照只代表当前屏幕已经呈现的资料。
  const visibleTextParts = [];
  const seenTextParts = new Set();
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode?.parentElement;
      const value = tidy(walker.currentNode?.nodeValue || '', 500);
      if (!value || !parent || !onScreen(parent) || seenTextParts.has(value)) continue;
      seenTextParts.add(value);
      visibleTextParts.push(value);
      if (visibleTextParts.length >= 600) break;
    }
  } catch {}
  const rawText = tidy(visibleTextParts.join(' '), 24000);
  // 右侧“问问小美”展示的是当前页的业务字段，而不是整页文字转储。
  // 下面只从已渲染、当前可见的 DOM 中提取少量字段；不读脚本、网络响应、
  // Cookie、存储或输入框。原始可见文字仅留给受限的分析上下文，不直接展示。
  const textList = (root, limit = 420) => {
    const values = [];
    const seen = new Set();
    if (!root) return values;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const parent = walker.currentNode && walker.currentNode.parentElement;
        const value = tidy(walker.currentNode && walker.currentNode.nodeValue || '', 420);
        if (!value || !parent || !onScreen(parent) || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
        if (values.length >= limit) break;
      }
    } catch {}
    return values;
  };
  const selectorValues = (root, selectors, limit = 40) => {
    const values = [];
    const seen = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = [...root.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes) {
        if (!onScreen(node)) continue;
        const value = textOf(node, 320);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
        if (values.length >= limit) return values;
      }
    }
    return values;
  };
  const attributeValues = (root, limit = 260) => {
    const values = [];
    const seen = new Set();
    for (const node of [...root.querySelectorAll('[aria-label],[title],[data-e2e],[data-testid]')]) {
      if (!onScreen(node)) continue;
      const attributes = [node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-e2e'), node.getAttribute('data-testid'), node.className]
        .map((value) => tidy(value, 120)).filter(Boolean).join(' ');
      const value = tidy(attributes + ' ' + textOf(node, 180), 320);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
      if (values.length >= limit) break;
    }
    return values;
  };
  const contentRoot = () => {
    const selectors = [
      '[role="dialog"]', '[aria-modal="true"]', '[class*="note-detail"]', '[class*="noteDetail"]',
      '[class*="detail-container"]', '[class*="detailContainer"]', '[class*="content-detail"]', '[class*="contentDetail"]',
    ];
    const candidates = [];
    const seen = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes) {
        if (!onScreen(node) || seen.has(node)) continue;
        seen.add(node);
        const sample = textOf(node, 3000);
        if (sample.length < 20) continue;
        let area = 0;
        try { const rect = node.getBoundingClientRect(); area = Math.max(0, rect.width * rect.height); } catch {}
        candidates.push({ node, sample, score: Math.min(sample.length, 3000) + Math.sqrt(area) });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] ? candidates[0].node : document.body;
  };
  const factValue = (value, limit = 280) => tidy(value, limit);
  const findText = (values, matcher, limit = 180) => {
    for (const value of values) {
      const text = factValue(value, limit);
      if (text && matcher.test(text)) return text;
    }
    return '';
  };
  const numberSignal = (value) => {
    const match = String(value || '').match(/(?:[¥￥]\s*)?\d+(?:[,.]\d+)*(?:\s*(?:万|w|W|k|K|%|\+|次|人|条|件|个|元|单|笔))?/);
    return match ? factValue(match[0], 48).replace(/\s+/g, '') : '';
  };
  const escapeRegExp = (value) => String(value || '').replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const metricValue = (values, aliases) => {
    const names = aliases.map(escapeRegExp).filter(Boolean).join('|');
    if (!names) return '';
    const forward = new RegExp('(?:' + names + ')\\s*(?:[:：]|\\s)*([¥￥]?\\s*\\d+(?:[,.]\\d+)*(?:\\s*(?:万|w|W|k|K|%|\\+|次|人|条|件|个|元|单|笔))?)', 'i');
    const reverse = new RegExp('([¥￥]?\\s*\\d+(?:[,.]\\d+)*(?:\\s*(?:万|w|W|k|K|%|\\+|次|人|条|件|个|元|单|笔))?)\\s*(?:' + names + ')', 'i');
    for (const value of values) {
      const text = factValue(value, 360);
      const match = text.match(forward) || text.match(reverse);
      const signal = numberSignal(match && match[1] || '');
      if (signal) return signal;
    }
    return '';
  };
  // 互动数字在小红书、抖音等页面常以“图标 + 数字”渲染，文字节点本身
  // 没有“点赞/收藏”标签。只在当前可见的带语义 class/aria/title 的控件内
  // 查找数字，避免把评论正文或页面其它数字误当作互动指标。
  const semanticMetricValue = (root, aliases) => {
    if (!root || !Array.isArray(aliases) || !aliases.length) return '';
    const selectors = new Set();
    for (const rawAlias of aliases) {
      const alias = String(rawAlias || '').trim();
      if (!alias) continue;
      const escaped = alias.replace(/"/g, '\\"');
      selectors.add('[aria-label*="' + escaped + '"]');
      selectors.add('[title*="' + escaped + '"]');
      selectors.add('[data-e2e*="' + escaped + '"]');
      selectors.add('[data-testid*="' + escaped + '"]');
      // 类名仅使用平台常见的英文语义词；中文别名不会被强行套进 class 选择器。
      if (/^[a-z0-9_-]+$/i.test(alias)) selectors.add('[class*="' + escaped + '"]');
    }
    const nodes = [];
    const seen = new Set();
    for (const selector of selectors) {
      let candidates = [];
      try { candidates = [...root.querySelectorAll(selector)]; } catch { continue; }
      for (const node of candidates) {
        if (!onScreen(node) || seen.has(node)) continue;
        seen.add(node);
        const classText = tidy(typeof node.className === 'string' ? node.className : '', 240).toLowerCase();
        const isCommentChild = Boolean(node.closest && node.closest('[class*="comment"],[class*="Comment"],[data-testid*="comment"],[data-e2e*="comment"]'));
        const isCommentRecord = isCommentChild && /(?:comment|reply).*(?:item|content|list)|(?:item|content|list).*(?:comment|reply)/i.test(classText);
        const interactionContainer = node.closest && node.closest('[class*="interact"],[class*="Interact"],[class*="action"],[class*="Action"],[class*="toolbar"],[class*="Toolbar"],[class*="operate"],[class*="Operate"],[class*="bottom"],[class*="Bottom"],[class*="engage"],[class*="Engage"]');
        const isInteractionControl = Boolean(interactionContainer) || (!isCommentRecord && /(?:like|liked|digg|collect|favorite|fav|share|forward|chat|reply|comment)/i.test(classText));
        const asksComment = aliases.some((value) => /评论|comment/i.test(String(value || '')));
        const semanticText = tidy([
          node.getAttribute && node.getAttribute('aria-label'),
          node.getAttribute && node.getAttribute('title'),
          node.getAttribute && node.getAttribute('data-e2e'),
          node.getAttribute && node.getAttribute('data-testid'),
          classText,
        ].filter(Boolean).join(' '), 420).toLowerCase();
        let score = 0;
        if (aliases.some((value) => semanticText.includes(String(value || '').toLowerCase()))) score += 12;
        if (isInteractionControl) score += 10;
        if (isCommentChild && !asksComment) score -= 30;
        // “评论”语义会同时命中评论正文和评论按钮。正文里也可能带订单号、
        // 年份或昵称数字，不能把它当成评论总数；优先互动控件或带标签的总数。
        if (isCommentRecord && asksComment) score -= 16;
        nodes.push({ node, score, isInteractionControl });
      }
    }
    nodes.sort((left, right) => right.score - left.score);
    for (const entry of nodes) {
      let cursor = entry.node;
      for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
        const value = textOf(cursor, 360);
        // 优先读取控件本身的纯数字；父节点只作“标签+数值”兼容兜底。
        const labelled = metricValue([value], aliases);
        if (labelled) return labelled;
        const direct = numberSignal(value);
        if (direct && (depth === 0 || entry.isInteractionControl && value.length <= 120)) return direct;
      }
    }
    return '';
  };
  const visibleImageCount = (root) => {
    const urls = new Set();
    for (const node of [...root.querySelectorAll('img')]) {
      if (!onScreen(node)) continue;
      try {
        const rect = node.getBoundingClientRect();
        if (rect.width * rect.height < 2500) continue;
      } catch { continue; }
      const url = imageUrl(node);
      if (url) urls.add(url);
      if (urls.size >= 12) break;
    }
    return urls.size;
  };
  const visibleImageCountFor = (root, selectors, limit = 12) => {
    const urls = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = [...root.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes) {
        const images = node?.tagName === 'IMG' ? [node] : [...(node?.querySelectorAll?.('img') || [])];
        for (const image of images) {
          if (!onScreen(image)) continue;
          try {
            const rect = image.getBoundingClientRect();
            if (rect.width * rect.height < 900) continue;
          } catch { continue; }
          const url = imageUrl(image);
          if (url) urls.add(url);
          if (urls.size >= limit) return urls.size;
        }
      }
    }
    return urls.size;
  };
  const visibleVideoCount = (root) => [...root.querySelectorAll('video,[data-video],[data-video-url]')].filter(onScreen).slice(0, 12).length;
  const titleFrom = (values, fallback = '') => {
    const ignored = /^(?:小红书|抖音|登录|关注|评论|收藏|分享|点赞|发布|首页|发现|更多|展开|关闭|搜索)$/;
    for (const value of values) {
      const text = factValue(value, 300);
      if (!text || text.length < 3 || text.length > 300 || ignored.test(text) || /^\d+(?:[.,]\d+)?(?:万|%|条|个)?$/.test(text)) continue;
      if (/(?:\d{1,2}[:：]\d{2}|昨天|今天|刚刚|分钟前|小时前|天前)/.test(text) && text.length < 80) continue;
      return text;
    }
    return factValue(fallback, 300);
  };
  const dateFrom = (values) => findText(values, /(?:\d{1,2}[-/.]\d{1,2}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|今天|昨天|前天|刚刚|\d+\s*(?:分钟前|小时前|天前)|编辑于|发布于)/, 120);
  const tagsFrom = (values) => {
    const tags = [];
    const seen = new Set();
    for (const value of values) {
      const matches = String(value || '').match(/#[^\s#]{1,40}/g) || [];
      for (const tag of matches) {
        const clean = factValue(tag.replace(/[，。；、]+$/g, ''), 48);
        if (clean && !seen.has(clean)) { seen.add(clean); tags.push(clean); }
        if (tags.length >= 8) return tags;
      }
    }
    return tags;
  };
  const excerptFrom = (values, title, author) => {
    for (const value of values) {
      const text = factValue(value, 420);
      if (text.length < 18 || text === title || text === author) continue;
      if (/^(?:关注|评论|收藏|分享|点赞|发布|登录)/.test(text)) continue;
      if (/(?:\d{1,2}[:：]\d{2}|昨天|今天|刚刚|分钟前|小时前|天前)/.test(text) && text.length < 120) continue;
      return text;
    }
    return '';
  };
  const addFact = (facts, label, value, limit = 320) => {
    const text = factValue(value, limit);
    if (!text || facts.some((item) => item.label === label)) return;
    facts.push({ label, value: text });
  };
  // 资源不是由页面任意文字拼出来的。六个站点的“@引用”只来自各自
  // 页型识别器的固定白名单，既避免把广告/导航当数据，也不会把某个站点的
  // 资源标准套用到另一个站点。
  const addResource = (resources, id, token, label, available = true) => {
    const safeId = String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
    const safeToken = factValue(token, 120);
    const safeLabel = factValue(label, 120);
    if (!available || !safeId || !safeToken || !safeLabel) return;
    if (resources.some((item) => item.id === safeId || item.token === safeToken)) return;
    resources.push({ id: safeId, token: safeToken, label: safeLabel, available: true });
  };
  const labelledValue = (values, labels, limit = 180) => {
    const names = (Array.isArray(labels) ? labels : []).map(escapeRegExp).filter(Boolean).join('|');
    if (!names) return '';
    const expression = new RegExp('(?:^|[\\s|｜])(?:' + names + ')\\s*(?:[:：]\\s*|\\s+)([^|｜\\n，；]{1,160})', 'i');
    for (const value of values) {
      const text = factValue(value, Math.max(260, limit + 100));
      const match = text.match(expression);
      const result = factValue(match && match[1] || '', limit).replace(/^(?:[：:、\-\s]+)/, '').trim();
      if (result && !/^(?:加载中|暂无数据|--|-|无)$/i.test(result)) return result;
    }
    return '';
  };
  const dateRangeFrom = (values) => {
    const range = findText(values, /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2})(?:\s*(?:至|~|～|—|-)\s*)(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2})/, 140);
    return range || dateFrom(values);
  };
  const visibleNodeCount = (root, selectors, limit = 180) => {
    const seen = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = [...root.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes) {
        if (!onScreen(node)) continue;
        const value = textOf(node, 700);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        if (seen.size >= limit) return seen.size;
      }
    }
    return seen.size;
  };
  const hasVisibleText = (values, matcher) => values.some((value) => matcher.test(factValue(value, 600)));
  const reportMetricFacts = (values, facts, definitions, max = 4) => {
    let added = 0;
    for (const definition of definitions) {
      const value = metricValue(values, definition[1]);
      if (!value) continue;
      addFact(facts, definition[0], value, 64);
      added += 1;
      if (added >= max) break;
    }
  };
  const mediaCountFrom = (values, fallback = 0) => {
    let count = 0;
    for (const value of values) {
      const text = factValue(value, 240);
      const match = text.match(/(?:^|\\s)(?:\d+\s*\/\s*)(\d{1,3})(?:\\s|$)/);
      const total = Number(match && match[1]);
      if (Number.isFinite(total) && total > count && total <= 99) count = total;
    }
    return Math.max(count, Number(fallback) || 0);
  };
  const structuredPage = () => {
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const root = contentRoot();
    const scopeText = textList(root, 460);
    const attributes = attributeValues(root, 300);
    const signals = unique(scopeText.concat(attributes), 700);
    const scopedHeadings = unique(selectorValues(root, ['h1,h2,h3,h4,[role="heading"],strong,[class*="title"],[class*="Title"]'], 40).concat(headings), 60);
    const scopedImages = visibleImageCount(root);
    const scopedVideos = visibleVideoCount(root);
    const facts = [];
    const resources = [];
    const hasLoginOverlay = /(?:手机号登录|扫码登录|获取验证码|登录后推荐|请登录后继续)/.test(scopeText.join(' '));
    const hasVerificationOverlay = /(?:安全验证|滑块验证|风险验证|请完成验证|验证码)/.test(scopeText.join(' '));
    if (hasVerificationOverlay) return { status: 'verification_required', message: '当前页面需要完成验证；请先在网页中手动完成验证' };
    if (hasLoginOverlay) return { status: 'login_required', message: '当前页面需要登录；完成登录后可重新读取可见资料' };
    const firstTitle = titleFrom(scopedHeadings.concat(scopeText), '');
    const date = dateFrom(scopeText);
    const tags = tagsFrom(scopeText);
    // 作者必须来自个人信息元素；取不到就留空，不能把正文标题或评论作者误当博主。
    // “关注”按钮经常和昵称共用一个可见容器，展示前去掉这个交互文案。
    const authorFrom = (selectors) => {
      for (const rawValue of selectorValues(root, selectors, 24)) {
        // “作者 / 博主”可以是昵称本身的结尾，不能把它们当作按钮文案截掉。
        // 只去掉实际的关注状态；前置的“作者：”标签单独处理。
        const value = factValue(rawValue, 160)
          .replace(/^\s*(?:作者|博主)\s*[:：]\s*/i, '')
          .replace(/\s*(?:已关注|关注|互关)(?:\s+.*)?$/, '')
          .trim();
        if (value && !/^(?:关注|已关注|互关)$/i.test(value)) return value;
      }
      return '';
    };
    const socialMetrics = () => ({
      likes: semanticMetricValue(root, ['点赞', '获赞', 'like', 'liked', 'digg']) || metricValue(signals, ['点赞', '获赞', 'like', 'liked', 'digg']),
      comments: semanticMetricValue(root, ['评论', 'comment', 'chat']) || metricValue(signals, ['评论', 'comment', 'chat']),
      collects: semanticMetricValue(root, ['收藏', 'collect', 'favorite', 'fav']) || metricValue(signals, ['收藏', 'collect', 'favorite', 'fav']),
      shares: semanticMetricValue(root, ['分享', '转发', 'share', 'forward']) || metricValue(signals, ['分享', '转发', 'share', 'forward']),
    });
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'rednote.com' || host.endsWith('.rednote.com')) {
      // 小红书从首页打开笔记时，地址栏有时仍然是 /；只要当前可见详情
      // 弹窗同时具备媒体和评论区信号，也按“当前笔记”处理。不能仅靠 URL，
      // 否则会把图文详情误显示为“小红书首页”。
      const modalNote = root !== document.body
        && /(?:共|全部)\s*\d+\s*条评论/.test(scopeText.join(' '))
        && Boolean(scopedImages || scopedVideos);
      const isNote = /^\/(?:explore|red_video)\/[0-9a-f]{24}$/i.test(location.pathname) || modalNote;
      const isCreator = /^\/user\/profile\/[0-9a-f]{24}$/i.test(location.pathname);
      const isSearch = path === '/search_result' || path === '/search_result_ai';
      if (isNote) {
        const isVideo = /^\/red_video\//.test(path) || scopedVideos > 0 && !scopedImages;
        const author = authorFrom(['a[href*="/user/profile/"],[class*="author"],[class*="Author"],[class*="user-info"],[class*="userInfo"]']);
        const title = titleFrom(scopedHeadings.concat(scopeText), document.title);
        const interaction = socialMetrics();
        const mediaCount = mediaCountFrom(scopeText, scopedImages);
        const commentSamples = visibleNodeCount(root, [commentSelectors], 60);
        addFact(facts, '博主', author, 120);
        addFact(facts, '标题', title, 360);
        addFact(facts, '日期', date, 120);
        addFact(facts, '来源', /^\/explore\//.test(path) || modalNote ? '首页详情' : '作品详情', 80);
        if (!isVideo && mediaCount) addFact(facts, '图片', String(mediaCount) + ' 张', 40);
        if (isVideo || scopedVideos) addFact(facts, '视频', String(Math.max(scopedVideos, 1)) + ' 个', 40);
        addFact(facts, '点赞', interaction.likes, 48);
        addFact(facts, '评论', interaction.comments, 48);
        addFact(facts, '收藏', interaction.collects, 48);
        addFact(facts, '分享', interaction.shares, 48);
        if (tags.length) addFact(facts, '话题', tags.join(' '), 300);
        // 达比的小红书当前笔记只有“图文/视频”和已实际出现的评论是可引用资源；
        // 不把图片数量、评论总数自动当成已读完的图片或评论正文。
        const noteReady = Boolean(title || author || mediaCount || scopedVideos);
        addResource(resources, 'xhs-content', isVideo ? '@视频' : '@图文', isVideo ? '视频' : '图文', noteReady);
        addResource(resources, 'xhs-comments', '@评论', '评论', Boolean(commentSamples));
        return { title: isVideo ? '小红书视频' : '小红书图文', kind: 'xhs-note', facts, resources, excerpt: excerptFrom(scopeText, title, author) };
      }
      if (isCreator) {
        const author = authorFrom(['[class*="user"],[class*="author"],h1,h2']);
        addFact(facts, '博主', author || firstTitle, 120);
        addFact(facts, '小红书号', findText(scopeText, /(?:小红书号|RED号|red id)/i, 120), 120);
        addFact(facts, '粉丝', metricValue(signals, ['粉丝']), 48);
        addFact(facts, '关注', metricValue(signals, ['关注']), 48);
        addFact(facts, '获赞与收藏', metricValue(signals, ['获赞与收藏']), 48);
        addFact(facts, 'IP属地', findText(scopeText, /IP属地/i, 100), 100);
        addResource(resources, 'xhs-creator-profile', '@博主信息', '博主信息', Boolean(author || facts.length));
        addResource(resources, 'xhs-creator-notes', '@笔记信息', '笔记信息', Boolean(cards.length));
        return { title: '小红书博主', kind: 'xhs-creator', facts, resources, excerpt: excerptFrom(scopeText, author, '') };
      }
      if (isSearch) {
        let keyword = '';
        try { keyword = tidy(new URL(location.href).searchParams.get('keyword') || new URL(location.href).searchParams.get('q') || '', 120); } catch {}
        addFact(facts, '关键词', keyword || firstTitle, 160);
        addFact(facts, '可见笔记', String(Math.max(0, cards.length)) + ' 条', 48);
        addResource(resources, 'xhs-search-notes', '@笔记信息', '笔记信息', Boolean(cards.length));
        return { title: '小红书搜索', kind: 'xhs-search', facts, resources };
      }
      addFact(facts, '页面', firstTitle || '小红书当前页面', 240);
      return { title: '小红书', kind: 'xhs-page', facts, resources };
    }
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
      const query = new URL(location.href).searchParams;
      const isSearch = /\/(?:search|root\/search|jingxuan\/search)\//.test(path) && ['general', 'video'].includes(query.get('type') || '') && !query.get('modal_id');
      const isCreator = path.startsWith('/user/') && !query.get('modal_id');
      const isWork = /^\/(?:video|note)\/.+/.test(path) || /^\/article\/\d+$/.test(path) || query.get('modal_id') || query.get('recommend') === '1' || ['/follow', '/friend', '/jingxuan'].includes(path);
      if (isWork) {
        const author = authorFrom(['a[href*="/user/"],[class*="author"],[class*="Author"],[class*="user"],[class*="User"]']);
        const title = titleFrom(scopedHeadings.concat(scopeText), document.title);
        const interaction = socialMetrics();
        const duration = findText(scopeText, /(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/, 40);
        const isArticle = /^\/article\//.test(path);
        const isLive = /(?:直播中|正在直播|直播间|观看人数)/.test(scopeText.join(' '));
        const isImage = !isArticle && !scopedVideos && scopedImages > 0 && !/^\/video\//.test(path);
        const isAd = /(?:广告|推广)/.test(scopeText.join(' '));
        const contentLabel = isArticle ? '文章' : isImage ? '图文' : '视频';
        const contentToken = isArticle ? '@文章' : isImage ? '@图文' : '@视频';
        const contentTitle = isLive ? '抖音当前直播' : isAd ? '抖音当前广告' : isArticle ? '抖音当前文章' : isImage ? '抖音当前图文' : '抖音当前视频';
        addFact(facts, '作者', author, 120);
        addFact(facts, '标题', title, 360);
        addFact(facts, '日期', date, 120);
        addFact(facts, '来源', root !== document.body ? '首页详情' : '作品详情', 80);
        if (!isLive && duration && !isImage && !isArticle) addFact(facts, '时长', duration, 40);
        if (!isLive && isImage) addFact(facts, '图片', String(mediaCountFrom(scopeText, scopedImages)) + ' 张', 40);
        if (!isLive && !isImage && !isArticle && (scopedVideos || /^\/video\//.test(path))) addFact(facts, '视频', String(Math.max(scopedVideos, 1)) + ' 个', 40);
        if (isAd) addFact(facts, '类型', '广告', 40);
        if (isLive) addFact(facts, '当前在线', metricValue(signals, ['当前在线', '观看人数', '在线']), 48);
        addFact(facts, '点赞', interaction.likes, 48);
        addFact(facts, '评论', interaction.comments, 48);
        addFact(facts, '收藏', interaction.collects, 48);
        addFact(facts, '转发', interaction.shares, 48);
        if (tags.length) addFact(facts, '话题', tags.join(' '), 300);
        // 达比的抖音当前作品不复用小红书的“评论资源”。它只按作品类型引用
        // 视频、图文或文章；直播明确不能发起作品分析。
        addResource(resources, 'douyin-content', contentToken, contentLabel, !isLive && Boolean(title || author || scopedImages || scopedVideos || isArticle || /^\/video\//.test(path)));
        return { title: contentTitle, kind: isLive ? 'douyin-live' : 'douyin-work', facts, resources, excerpt: excerptFrom(scopeText, title, author) };
      }
      if (isCreator) {
        const author = authorFrom(['[class*="user"],[class*="author"],h1,h2']);
        addFact(facts, '博主', author || firstTitle, 120);
        addFact(facts, '抖音号', findText(scopeText, /(?:抖音号|douyin id)/i, 120), 120);
        addFact(facts, '粉丝', metricValue(signals, ['粉丝']), 48);
        addFact(facts, '获赞', metricValue(signals, ['获赞']), 48);
        addFact(facts, '关注', metricValue(signals, ['关注']), 48);
        addResource(resources, 'douyin-creator-profile', '@博主信息', '博主信息', Boolean(author || facts.length));
        addResource(resources, 'douyin-creator-works', '@作品信息', '作品信息', Boolean(cards.length));
        return { title: '抖音博主主页', kind: 'douyin-creator', facts, resources, excerpt: excerptFrom(scopeText, author, '') };
      }
      if (isSearch) {
        addFact(facts, '关键词', tidy(query.get('keyword') || query.get('query') || query.get('q') || firstTitle, 160), 160);
        addFact(facts, '可见作品', String(Math.max(0, cards.length)) + ' 条', 48);
        const searchIsVideo = query.get('type') === 'video';
        addResource(resources, searchIsVideo ? 'douyin-search-videos' : 'douyin-search-works', searchIsVideo ? '@视频信息' : '@作品信息', searchIsVideo ? '视频信息' : '作品信息', Boolean(cards.length));
        return { title: searchIsVideo ? '抖音视频搜索' : '抖音综合搜索', kind: 'douyin-search', facts, resources };
      }
      addFact(facts, '页面', firstTitle || '抖音当前页面', 240);
      return { title: '抖音', kind: 'douyin-page', facts, resources };
    }
    if (host === 'myseller.taobao.com' || host.endsWith('.myseller.taobao.com') || host === 'qianniu.taobao.com' || host.endsWith('.qianniu.taobao.com')) {
      const isService = /(?:customer-service|customer_service|message|chat|session)/.test(path);
      const conversation = titleFrom(scopedHeadings.concat(scopeText), '');
      const messageCount = visibleNodeCount(root, ['[class*="message-item"],[class*="messageItem"],[class*="message-content"],[class*="messageContent"],[class*="chat-message"],[class*="chatMessage"]', '[data-message-id]'], 180);
      const conversationCount = visibleNodeCount(root, ['[class*="conversation-item"],[class*="conversationItem"],[class*="session-item"],[class*="sessionItem"]', '[data-conversation-id]'], 180);
      const queriedConversationCount = metricValue(signals, ['查询会话', '会话数']) || (conversationCount ? String(conversationCount) : '');
      const capturedConversationCount = metricValue(signals, ['已读会话', '已读取会话']);
      const queryCountNumber = Number(String(queriedConversationCount).replace(/[^0-9.]/g, '')) || 0;
      const shopName = labelledValue(signals, ['店铺名称', '当前店铺', '店铺']);
      const accountName = labelledValue(signals, ['当前账号', '账号', '接待账号']);
      const customer = labelledValue(signals, ['客户昵称', '客户', '买家昵称', '买家']);
      const employee = labelledValue(signals, ['员工账号', '员工', '客服']);
      const range = dateRangeFrom(scopeText);
      addFact(facts, '店铺', shopName, 160);
      addFact(facts, '当前账号', accountName, 120);
      addFact(facts, '客户', customer, 120);
      addFact(facts, isService ? '当前会话' : '页面', conversation || (isService ? '客服 > 聊天记录' : '千牛工作台'), 240);
      addFact(facts, '员工', employee, 120);
      addFact(facts, '筛选范围', range, 140);
      addFact(facts, '接待状态', findText(scopeText, /(?:接待中|待回复|已回复|已结束|转交|排队|未读)/, 100), 100);
      if (queriedConversationCount) addFact(facts, '查询会话', /(?:个|条)$/.test(queriedConversationCount) ? queriedConversationCount : String(queriedConversationCount) + ' 个', 48);
      if (capturedConversationCount) addFact(facts, '已读会话', /(?:个|条)$/.test(capturedConversationCount) ? capturedConversationCount : String(capturedConversationCount) + ' 个', 48);
      if (messageCount) addFact(facts, '聊天消息', String(messageCount) + ' 条', 48);
      // 与达比一致，千牛只有实际出现聊天记录时才提供聊天分析；不能把
      // 经营看板中的 PV、成交额等通用指标误混入客服数据。
      addResource(resources, 'qianniu-chat-records', queryCountNumber > 120 ? '@聊天记录-前100' : '@聊天记录', queryCountNumber > 120 ? '聊天记录（前100）' : '聊天记录', Boolean(isService && messageCount));
      return { title: isService ? '客服 > 聊天记录' : '千牛工作台', kind: isService ? 'qianniu-service' : 'qianniu-page', facts, resources, excerpt: isService ? excerptFrom(scopeText, conversation, '') : '' };
    }
    if (host === 'sycm.taobao.com' || host.endsWith('.sycm.taobao.com')) {
      const moduleDefinitions = [
        ['marketing', '营销'], ['customer', '客户'], ['flow', '流量'], ['trade', '交易'],
        ['market', '市场'], ['product', '商品'], ['business', '经营'], ['service', '服务'],
      ];
      const matchedModule = moduleDefinitions.find((item) => path.includes(item[0]));
      const moduleId = matchedModule ? matchedModule[0] : 'home';
      const moduleTitle = matchedModule ? matchedModule[1] : '首页';
      const reportTitle = titleFrom(scopedHeadings.concat(scopeText), document.title);
      const tableNames = unique([...root.querySelectorAll('table')].filter(onScreen).slice(0, 4).map((table) => textOf(table.querySelector('caption'), 120)).filter(Boolean), 4);
      const reportSurface = Boolean(tables.length || metrics.length || tableNames.length || hasVisibleText(scopeText, /(?:同比|环比|访客数|支付金额|转化率|消耗|ROI)/));
      const reportMetricDefinitions = {
        home: [['支付金额', ['支付金额']], ['访客数', ['访客数']], ['支付买家数', ['支付买家数']], ['支付转化率', ['支付转化率']]],
        marketing: [['消耗', ['消耗', '花费']], ['引导支付金额', ['引导支付金额']], ['ROI', ['ROI', '投资回报']], ['点击率', ['点击率']]],
        customer: [['支付买家数', ['支付买家数']], ['新客', ['新客']], ['老客', ['老客']], ['客单价', ['客单价']]],
        flow: [['访客数', ['访客数']], ['浏览量', ['浏览量', 'PV']], ['平均停留时长', ['平均停留时长']], ['跳失率', ['跳失率']]],
        trade: [['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['客单价', ['客单价']], ['支付转化率', ['支付转化率']]],
        market: [['搜索人气', ['搜索人气']], ['点击人气', ['点击人气']], ['支付转化率', ['支付转化率']], ['竞争度', ['竞争度']]],
        product: [['商品访客数', ['商品访客数']], ['商品支付金额', ['商品支付金额']], ['商品支付买家数', ['商品支付买家数']], ['商品支付转化率', ['商品支付转化率']]],
        business: [['支付金额', ['支付金额']], ['访客数', ['访客数']], ['支付买家数', ['支付买家数']], ['客单价', ['客单价']]],
        service: [['询单人数', ['询单人数']], ['咨询转化率', ['咨询转化率']], ['平均响应时长', ['平均响应时长']], ['旺旺响应率', ['旺旺响应率']]],
      };
      addFact(facts, '当前模块', moduleTitle, 80);
      addFact(facts, '当前报表', reportTitle, 240);
      addFact(facts, '店铺', labelledValue(signals, ['店铺名称', '当前店铺', '店铺']), 160);
      addFact(facts, '统计时间', labelledValue(signals, ['统计时间', '日期范围', '日期']) || dateRangeFrom(scopeText), 160);
      addFact(facts, '筛选条件', labelledValue(signals, ['筛选条件', '筛选', '终端', '指标']), 200);
      if (tableNames.length) addFact(facts, '可见数据表', tableNames.join('；'), 300);
      else if (tables.length) addFact(facts, '可见数据表', String(tables.length) + ' 张', 48);
      // 生意参谋按模块读取各自指标，不再把一套“浏览/成交/ROI”通用字段
      // 填到所有报表中。页面资源也只在当前报表已实际渲染时出现。
      reportMetricFacts(signals, facts, reportMetricDefinitions[moduleId] || reportMetricDefinitions.home, 4);
      const reportLabel = reportTitle && reportTitle.length <= 80 ? reportTitle : '当前报表';
      addResource(resources, 'sycm-current-report', '@' + reportLabel, reportLabel, reportSurface);
      return { title: '生意参谋 > ' + moduleTitle, kind: 'sycm-' + moduleId, facts, resources };
    }
    if (host === 'dmp.taobao.com' || host.endsWith('.dmp.taobao.com')) {
      const definitions = [
        ['items/shop-insight', 'shop-insight', '店铺概况'], ['items/growup-path', 'growup-path', '商品打爆路径'],
        ['compete/market-rank', 'market-rank', '市场榜单'], ['compete/compete-situation', 'compete', '竞品分析'],
        ['compete/compete-detect', 'compete-detect', '竞品监测'], ['audience', 'audience', '人群分析'],
        ['home-new/index', 'home', '首页概览'],
      ];
      const matched = definitions.find((item) => path.includes(item[0]));
      const moduleId = matched ? matched[1] : 'report';
      const moduleTitle = matched ? matched[2] : '当前报表';
      const reportTitle = titleFrom(scopedHeadings.concat(scopeText), document.title);
      const tableNames = unique([...root.querySelectorAll('table')].filter(onScreen).slice(0, 4).map((table) => textOf(table.querySelector('caption'), 120)).filter(Boolean), 4);
      const reportSurface = Boolean(tables.length || metrics.length || tableNames.length || hasVisibleText(scopeText, /(?:同比|环比|人群|竞品|排名|打爆|支付金额|转化率|成交)/));
      const dmpMetricDefinitions = {
        home: [['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['访客数', ['访客数']], ['收藏加购', ['收藏加购']]],
        'shop-insight': [['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['商品数', ['商品数']], ['推广消耗', ['推广消耗']]],
        'growup-path': [['商品支付金额', ['商品支付金额', '支付金额']], ['访客数', ['访客数']], ['支付转化率', ['支付转化率']], ['收藏加购', ['收藏加购']]],
        'market-rank': [['交易指数', ['交易指数']], ['搜索指数', ['搜索指数']], ['浏览指数', ['浏览指数']], ['竞争度', ['竞争度']]],
        compete: [['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['转化率', ['转化率']], ['访客数', ['访客数']]],
        'compete-detect': [['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['转化率', ['转化率']], ['访客数', ['访客数']]],
        audience: [['人群规模', ['人群规模']], ['支付金额', ['支付金额']], ['支付买家数', ['支付买家数']], ['转化率', ['转化率']]],
      };
      const currentProduct = labelledValue(signals, ['当前商品', '本品', '商品名称']);
      const competitor = labelledValue(signals, ['对比商品', '竞品', '竞店']);
      addFact(facts, '当前模块', moduleTitle, 100);
      addFact(facts, '当前报表', reportTitle, 240);
      addFact(facts, '店铺', labelledValue(signals, ['店铺名称', '当前店铺', '店铺']), 160);
      addFact(facts, '统计时间', labelledValue(signals, ['统计时间', '日期范围', '日期']) || dateRangeFrom(scopeText), 160);
      addFact(facts, '筛选条件', labelledValue(signals, ['筛选条件', '类目', '行业', '人群']), 200);
      if (moduleId === 'growup-path') {
        addFact(facts, '当前商品', currentProduct, 220);
        addFact(facts, '对比商品', competitor, 220);
      }
      if (tableNames.length) addFact(facts, '可见数据表', tableNames.join('；'), 300);
      else if (tables.length) addFact(facts, '可见数据表', String(tables.length) + ' 张', 48);
      reportMetricFacts(signals, facts, dmpMetricDefinitions[moduleId] || [], 4);
      const addIfVisible = (id, token, label, matcher, fallback = false) => addResource(resources, id, token, label, reportSurface && (fallback || hasVisibleText(scopeText.concat(scopedHeadings), matcher)));
      if (moduleId === 'shop-insight') {
        addIfVisible('dmp-shop-overview', '@店铺概况', '店铺概况', /(?:店铺概况|全店经营|经营表现)/, true);
        addIfVisible('dmp-shop-categories', '@类目数据', '类目数据', /(?:类目数据|类目表现|类目)/);
        addIfVisible('dmp-shop-items', '@商品列表', '商品列表', /(?:商品列表|商品表现|商品明细)/);
      } else if (moduleId === 'growup-path') {
        addResource(resources, 'dmp-growup-path', '@本品与竞品打爆路径对比', '本品与竞品打爆路径对比', Boolean(reportSurface && currentProduct && competitor));
      } else if (moduleId === 'home') {
        addIfVisible('dmp-home-marketing', '@营销概况', '营销概况', /营销概况/);
        addIfVisible('dmp-home-business', '@生意总览', '生意总览', /(?:生意总览|经营总览)/);
        addIfVisible('dmp-home-consumer-assets', '@店铺消费者资产', '店铺消费者资产', /(?:消费者资产|潜客|新客|老客)/);
        addIfVisible('dmp-home-leaf-cate', '@重点类目', '重点类目', /重点类目/);
        if (!resources.length) addResource(resources, 'dmp-home-overview', '@首页概览', '首页概览', reportSurface);
      } else if (moduleId === 'market-rank') {
        const isShopRank = /店铺/.test(scopeText.concat(scopedHeadings).join(' '));
        const rankName = reportTitle && reportTitle.length <= 50 ? reportTitle : '当前榜单';
        addResource(resources, 'dmp-market-rank', '@市场·' + (isShopRank ? '店铺' : '宝贝') + '·' + rankName, '市场·' + (isShopRank ? '店铺' : '宝贝') + '·' + rankName, reportSurface);
      } else if (moduleId === 'compete') {
        const tabName = hasVisibleText(scopeText, /竞店/) ? '竞店' : hasVisibleText(scopeText, /竞品/) ? '竞品' : '当前竞品报表';
        addResource(resources, 'dmp-compete', '@' + tabName, tabName, reportSurface);
      } else if (moduleId === 'compete-detect') {
        const tabName = hasVisibleText(scopeText, /竞店/) ? '竞店数据' : hasVisibleText(scopeText, /竞品/) ? '竞品数据' : '竞品监测数据';
        addResource(resources, 'dmp-compete-detect', '@' + tabName, tabName, reportSurface);
      } else if (moduleId === 'audience') {
        addResource(resources, 'dmp-audience', '@人群数据', '人群数据', reportSurface);
      } else {
        addResource(resources, 'dmp-current-report', '@当前报表', '当前报表', reportSurface);
      }
      return { title: '达摩盘 > ' + moduleTitle, kind: 'dmp-' + moduleId, facts, resources };
    }
    if (host === '1688.com' || host.endsWith('.1688.com')) {
      const isLogin = /^(?:login|passport|havanalogin)\.1688\.com$/i.test(host);
      const isDetail = host === 'detail.1688.com' || host.endsWith('.detail.1688.com');
      const isFactorySearch = (host === 's.1688.com' || host.endsWith('.s.1688.com')) && /\/company\/pc\/factory_search\.htm/.test(path);
      const isCompanySearch = (host === 's.1688.com' || host.endsWith('.s.1688.com')) && /\/company\/company_search\.htm/.test(path);
      const isSearch = (host === 's.1688.com' || host.endsWith('.s.1688.com')) || path === '/zw/page.html';
      const isFactoryDetail = (host === 'sale.1688.com' || host.endsWith('.sale.1688.com')) && /\/factory\/card\.html/.test(path);
      const isFactoryProducts = (host === 'sale.1688.com' || host.endsWith('.sale.1688.com')) && /\/factory\/l[a-z0-9]{5,}\.html/.test(path);
      const isHome = (host === '1688.com' || host === 'www.1688.com') && (path === '/' || path === '');
      const isShop = /^[a-z0-9][a-z0-9-]{0,61}\.1688\.com$/i.test(host) && !['www.1688.com', 's.1688.com', 'detail.1688.com', 'sale.1688.com'].includes(host);
      const offerTitle = titleFrom(scopedHeadings.concat(scopeText), document.title);
      const price = findText(scopeText, /[¥￥]\s*\d+(?:\.\d+)?/, 64);
      const minOrder = findText(scopeText, /\d+(?:件|个|套|箱|只|包).{0,12}(?:起批|起订)/, 100);
      const supplier = findText(scopeText, /(?:有限公司|工厂|商行|企业店|旗舰店|专营店|专卖店)/, 160);
      if (isLogin) {
        addFact(facts, '页面', '1688登录', 120);
        return { title: '1688登录', kind: '1688-page', facts, resources };
      }
      if (isDetail) {
        const hasSku = hasVisibleText(scopeText.concat(scopedHeadings), /(?:SKU|规格|颜色|尺码|型号)/);
        const detailImageCount = visibleImageCountFor(root, ['[class*="detail"] img,[class*="Detail"] img,[id*="detail"] img,[id*="Detail"] img', '[data-testid*="detail"] img']);
        const skuImageCount = visibleImageCountFor(root, ['[class*="sku"] img,[class*="SKU"] img,[class*="spec"] img,[class*="Spec"] img', '[data-testid*="sku"] img,[data-testid*="spec"] img']);
        const hasDetailImages = hasVisibleText(scopeText.concat(scopedHeadings), /(?:图文详情|详情描述|商品详情)/) && Boolean(detailImageCount);
        const hasReviewSamples = Boolean(visibleNodeCount(root, [commentSelectors, '[class*="review"],[class*="Review"]'], 60));
        addFact(facts, '商品', offerTitle, 360);
        addFact(facts, '价格', price, 64);
        addFact(facts, '起订量', minOrder, 100);
        addFact(facts, '供应商', supplier, 180);
        // 1688 的成交/评价只能从页面上明确带标签的文字提取，不能像社交
        // 平台那样从“图标+数字”猜语义，以免把店铺其它数字当商品数据。
        addFact(facts, '成交', metricValue(signals, ['已售', '成交', '交易']), 48);
        addFact(facts, '评价', metricValue(signals, ['评价', '评论']), 48);
        if (scopedImages) addFact(facts, '主图信号', String(scopedImages) + ' 张', 40);
        if (scopedVideos) addFact(facts, '主图视频信号', String(scopedVideos) + ' 个', 40);
        addResource(resources, '1688-product-info', '@商品信息', '商品信息', Boolean(offerTitle || price || supplier));
        addResource(resources, '1688-main-videos', '@主图视频', '主图视频', Boolean(scopedVideos));
        addResource(resources, '1688-main-images', '@主图', '主图', Boolean(scopedImages));
        addResource(resources, '1688-detail-images', '@详情页长图', '详情页长图', hasDetailImages);
        addResource(resources, '1688-detail-image-files', '@详情页多图', '详情页多图', hasDetailImages);
        addResource(resources, '1688-sku-images', '@SKU图', 'SKU图', Boolean(skuImageCount));
        addResource(resources, '1688-sku-list', '@SKU列表', 'SKU列表', hasSku);
        addResource(resources, '1688-reviews', '@评价数据', '评价数据', hasReviewSamples);
        return { title: '1688 商品详情', kind: '1688-detail', facts, resources, excerpt: excerptFrom(scopeText, offerTitle, supplier) };
      }
      if (isSearch) {
        let keyword = '';
        try { keyword = tidy(new URL(location.href).searchParams.get('keywords') || new URL(location.href).searchParams.get('keyword') || new URL(location.href).searchParams.get('q') || '', 120); } catch {}
        addFact(facts, '关键词', keyword || offerTitle, 160);
        addFact(facts, '可见结果', String(Math.max(0, cards.length)) + ' 条', 48);
        addFact(facts, '当前页码', labelledValue(signals, ['第', '页码']), 48);
        if (!isFactorySearch && !isCompanySearch) addFact(facts, '价格样本', price, 64);
        addFact(facts, '筛选条件', labelledValue(signals, ['筛选条件', '筛选', '排序']), 200);
        if (isFactorySearch) {
          addResource(resources, '1688-factory-search', '@工厂搜索结果', '工厂搜索结果', Boolean(cards.length));
          return { title: '1688 找工厂', kind: '1688-factory-search', facts, resources };
        }
        if (isCompanySearch) {
          addResource(resources, '1688-company-search', '@供应商搜索结果', '供应商搜索结果', Boolean(cards.length));
          return { title: '1688 找供应商', kind: '1688-company-search', facts, resources };
        }
        addResource(resources, '1688-search-products', '@商品搜索结果', '商品搜索结果', Boolean(cards.length));
        addResource(resources, '1688-search-main-images', '@商品主图', '商品主图', Boolean(cards.length && scopedImages));
        addResource(resources, '1688-search-promoted-images', '@推广车图', '推广车图', Boolean(cards.length && hasVisibleText(scopeText, /(?:推广|广告|实力商家)/) && scopedImages));
        return { title: '1688 商品搜索', kind: '1688-search', facts, resources };
      }
      if (isFactoryDetail) {
        const reviewSamples = Boolean(visibleNodeCount(root, [commentSelectors, '[class*="review"],[class*="Review"]'], 60));
        addFact(facts, '工厂', supplier || offerTitle, 240);
        addFact(facts, '工厂等级', labelledValue(signals, ['工厂等级', '实力等级']), 100);
        addFact(facts, '主营产品', labelledValue(signals, ['主营产品', '主营']), 240);
        addFact(facts, '工厂面积', labelledValue(signals, ['工厂面积', '厂房面积']), 100);
        addFact(facts, '员工人数', labelledValue(signals, ['员工人数', '员工']), 100);
        addFact(facts, '回头率', metricValue(signals, ['回头率']), 48);
        addResource(resources, '1688-factory-profile', '@工厂信息', '工厂信息', Boolean(supplier || offerTitle || facts.length));
        addResource(resources, '1688-factory-images', '@工厂图集', '工厂图集', Boolean(scopedImages));
        addResource(resources, '1688-factory-videos', '@工厂视频', '工厂视频', Boolean(scopedVideos));
        addResource(resources, '1688-factory-reviews', '@买家评价', '买家评价', reviewSamples);
        return { title: '1688 工厂详情', kind: '1688-factory-detail', facts, resources };
      }
      if (isFactoryProducts) {
        addFact(facts, '工厂', supplier || offerTitle, 240);
        addFact(facts, '当前分类', labelledValue(signals, ['当前分类', '分类']), 160);
        addFact(facts, '可见商品', String(Math.max(0, cards.length)) + ' 条', 48);
        addResource(resources, '1688-factory-products', '@工厂商品', '工厂商品', Boolean(cards.length));
        return { title: '1688 工厂商品', kind: '1688-factory-products', facts, resources };
      }
      if (isHome) {
        addFact(facts, '页面', '1688首页', 120);
        return { title: '1688首页', kind: '1688-page', facts, resources };
      }
      if (isShop) {
        const productResourceToken = hasVisibleText(scopeText, /店内搜索/) ? '@店内搜索商品' : hasVisibleText(scopeText, /当前分类|分类/) ? '@当前分类商品' : '@全店商品';
        const productResourceLabel = productResourceToken.slice(1);
        addFact(facts, '店铺', supplier || offerTitle || '1688 当前店铺', 240);
        addFact(facts, '经营年限', findText(scopeText, /(?:经营|成立).{0,12}\d+年|\d+年(?:店|工厂|经营)/, 100), 100);
        addFact(facts, '回头率', metricValue(signals, ['回头率']), 48);
        addFact(facts, '所在地区', labelledValue(signals, ['所在地区', '地区', '地址']), 160);
        addFact(facts, '可见商品', String(Math.max(0, cards.length)) + ' 条', 48);
        addResource(resources, '1688-shop-profile', '@店铺信息', '店铺信息', Boolean(supplier || offerTitle || facts.length));
        addResource(resources, '1688-shop-products', productResourceToken, productResourceLabel, Boolean(cards.length));
        return { title: '1688 店铺', kind: '1688-shop', facts, resources };
      }
      addFact(facts, '页面', offerTitle || '1688 当前页面', 240);
      return { title: '1688', kind: '1688-page', facts, resources };
    }
    return { title: tidy(document.title || '当前页面', 240), kind: 'page', facts: [{ label: '页面', value: tidy(document.title || '当前页面', 240) }], resources };
  };
  const structured = structuredPage();
  return {
    ok: !structured.status && Boolean(rawText || headings.length || metrics.length || tables.length || cards.length || structured.facts && structured.facts.length || structured.resources && structured.resources.length),
    status: structured.status || '',
    message: structured.message || '',
    url: location.href,
    title: tidy(document.title, 300),
    headings,
    metrics,
    tables,
    cards,
    comments,
    images,
    videoCount,
    visibleCount: cards.length,
    rawText,
    structured,
    capturedAt: Date.now(),
  };
})()`;

if (process.platform === 'win32') {
  app.setAppUserModelId('com.xiaomei.canvas.desktop.test');
}
try {
  app.setPath('userData', TEST_USER_DATA_ROOT);
  app.setPath('sessionData', path.join(TEST_USER_DATA_ROOT, 'session'));
  app.setPath('cache', path.join(TEST_USER_DATA_ROOT, 'cache'));
  app.setPath('logs', path.join(TEST_RUNTIME_DATA_ROOT, 'logs'));
  app.setPath('crashDumps', path.join(TEST_USER_DATA_ROOT, 'crash-dumps'));
  app.setPath('temp', TEST_TEMP_ROOT);
  app.setName(APP_NAME);
} catch {}

const desktopUpdater = new DesktopUpdater({
  app,
  runtimeRoot: TEST_RUNTIME_DATA_ROOT,
  configPath: path.join(__dirname, 'update-config.json'),
  allowInsecure: !app.isPackaged && process.env.XIAOMEI_UPDATE_ALLOW_HTTP === '1',
});

const generationNotifications = new Set();
function showGenerationNotification(sender, payload = {}) {
  if (!Notification || (typeof Notification.isSupported === 'function' && !Notification.isSupported())) {
    return { ok: false, reason: 'electron_notifications_unsupported' };
  }
  const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(payload.status || '').toLowerCase());
  const title = String(payload.title || (failed ? `${APP_NAME} · 生图失败` : `${APP_NAME} · 生图完成`)).slice(0, 120);
  const body = String(payload.body || (failed
    ? `${String(payload.model || '图片模型')} 生成失败：${String(payload.error || '请打开小美画布查看详情')}`
    : `${String(payload.model || '图片模型')} 已完成，生成 ${Math.max(1, Number(payload.count) || 1)} 张图片`)).slice(0, 300);
  try {
    const notification = new Notification({ title, body, icon: APP_ICON_PATH });
    generationNotifications.add(notification);
    notification.once('close', () => generationNotifications.delete(notification));
    notification.once('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.moveTop();
          mainWindow.focus();
        }
      } catch {}
      try {
        if (sender && !sender.isDestroyed()) sender.send('generation:notification-click', { nodeId: String(payload.nodeId || '') });
      } catch {}
    });
    notification.show();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error || 'electron_notification_failed').slice(0, 240) };
  }
}

const DESKTOP_UPDATE_STATE_PATH = path.join(TEST_RUNTIME_DATA_ROOT, 'data', 'desktop-update-state.json');

function readDesktopUpdateState() {
  try {
    const value = JSON.parse(fs.readFileSync(DESKTOP_UPDATE_STATE_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeDesktopUpdateState(patch) {
  try {
    fs.mkdirSync(path.dirname(DESKTOP_UPDATE_STATE_PATH), { recursive: true });
    const current = readDesktopUpdateState();
    const temporary = `${DESKTOP_UPDATE_STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, DESKTOP_UPDATE_STATE_PATH);
  } catch {}
}

function sendDesktopUpdateWindow(channel, payload) {
  try {
    if (updateWindow && !updateWindow.isDestroyed() && !updateWindow.webContents.isDestroyed()) {
      updateWindow.webContents.send(channel, payload);
    }
  } catch {}
}

function setDesktopUpdateWindowState(state, extra = {}) {
  desktopUpdateWindowState = { state: String(state || 'downloading'), ...extra };
  sendDesktopUpdateWindow('app:update-state', desktopUpdateWindowState);
}

function setDesktopUpdateWindowProgress(payload = {}) {
  desktopUpdateWindowProgress = { ...payload };
  sendDesktopUpdateWindow('app:update-progress', desktopUpdateWindowProgress);
}

function showDesktopUpdateWindow(version) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    try { updateWindow.show(); updateWindow.focus(); } catch {}
    return;
  }
  updateWindow = new BrowserWindow({
    width: 500,
    height: 310,
    minWidth: 500,
    minHeight: 310,
    maxWidth: 500,
    maxHeight: 310,
    title: `${APP_NAME} · 更新`,
    icon: APP_ICON_PATH,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  updateWindow.on('closed', () => {
    updateWindow = null;
    if (!desktopUpdateLaunchInProgress) {
      try { desktopUpdateAbortController?.abort(); } catch {}
    }
  });
  updateWindow.webContents.once('did-finish-load', () => {
    sendDesktopUpdateWindow('app:update-state', desktopUpdateWindowState || { state: 'downloading', version });
    if (desktopUpdateWindowProgress) sendDesktopUpdateWindow('app:update-progress', desktopUpdateWindowProgress);
    try { updateWindow?.show(); updateWindow?.focus(); } catch {}
  });
  void updateWindow.loadFile(path.join(__dirname, 'update-window.html'), { query: { version: String(version || '') } }).catch((error) => {
    console.warn(`[desktop-updater] 无法打开更新窗口：${String(error?.message || error).slice(0, 180)}`);
  });
}

function closeDesktopUpdateWindow() {
  try {
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
  } catch {}
}

function desktopUpdateOwnerWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

async function showDesktopUpdateResult(result) {
  const status = String(result?.status || 'error');
  const title = status === 'current' ? '检查更新' : status === 'disabled' ? '桌面版更新' : '更新检查失败';
  const message = status === 'current'
    ? `当前已经是最新版本（${result.version || app.getVersion()}）`
    : String(result?.message || '暂时无法检查更新');
  const options = {
    type: status === 'current' || status === 'disabled' ? 'info' : 'error',
    title,
    message,
    detail: status === 'disabled'
      ? '请在发布前配置 desktop/update-config.json 中的 GitHub 仓库或 manifestUrl。'
      : '',
    buttons: ['知道了'],
    noLink: true,
  };
  const owner = desktopUpdateOwnerWindow();
  if (owner) return dialog.showMessageBox(owner, options);
  return dialog.showMessageBox(options);
}

function desktopUpdatePromptOptions(result) {
  const notes = Array.isArray(result?.notes) && result.notes.length
    ? `\n\n本次更新：\n${result.notes.map((item) => `· ${item}`).join('\n')}`
    : '';
  return {
    type: 'info',
    title: `${APP_NAME} · 发现新版本`,
    message: `发现新版本 ${result.version}`,
    detail: `当前版本：${result.version ? app.getVersion() : '未知'}\n${process.platform === 'darwin' ? '更新会在后台下载 macOS ZIP，完成后打开文件位置供你替换应用。个人数据不会被删除。' : '更新会在后台下载新的安装程序，完成后自动重启。个人数据不会被删除。'}${notes}`,
    buttons: result.mandatory ? ['立即更新'] : ['立即更新', '稍后提醒'],
    defaultId: 0,
    cancelId: result.mandatory ? 0 : 1,
    noLink: true,
  };
}

async function promptDesktopUpdate(result) {
  const owner = desktopUpdateOwnerWindow();
  const options = desktopUpdatePromptOptions(result);
  const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (answer.response !== 0) {
    writeDesktopUpdateState({ dismissedVersion: result.version, dismissedAt: Date.now() });
    return { ...result, status: 'available', dismissed: true, message: '用户选择稍后更新' };
  }
  return startDesktopUpdate(result);
}

function startDesktopUpdate(result) {
  if (desktopUpdateOperationPromise) return desktopUpdateOperationPromise;
  desktopUpdateAbortController = new AbortController();
  desktopUpdateLaunchInProgress = false;
  desktopUpdateWindowState = { state: 'downloading', version: result.version };
  desktopUpdateWindowProgress = null;
  showDesktopUpdateWindow(result.version);
  desktopUpdateOperationPromise = (async () => {
    try {
      setDesktopUpdateWindowState('downloading', { version: result.version });
      const downloaded = await desktopUpdater.download(result, {
        signal: desktopUpdateAbortController.signal,
        onProgress: (progress) => setDesktopUpdateWindowProgress(progress),
      });
      setDesktopUpdateWindowState('verifying', { version: result.version });
      await new Promise((resolve) => setTimeout(resolve, 350));
      setDesktopUpdateWindowState('ready', { version: result.version });
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (process.platform === 'darwin') {
        const openError = await shell.openPath(downloaded.path);
        if (openError) throw new Error(`无法打开 macOS 更新包：${openError}`);
        setDesktopUpdateWindowState('downloaded', { version: result.version, path: downloaded.path });
        setTimeout(closeDesktopUpdateWindow, 1800);
        return { ...result, status: 'downloaded', installerPath: downloaded.path };
      }
      const installDirectory = path.dirname(app.getPath('exe'));
      const installer = spawn(downloaded.path, ['/S', `/D=${installDirectory}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      installer.unref();
      desktopUpdateLaunchInProgress = true;
      setDesktopUpdateWindowState('installing', { version: result.version });
      setTimeout(() => { try { app.quit(); } catch {} }, 300);
      return { ...result, status: 'installing', installerPath: downloaded.path };
    } catch (error) {
      if (error?.code === 'cancelled' || error?.name === 'AbortError') {
        setDesktopUpdateWindowState('cancelled', { version: result.version });
        setTimeout(closeDesktopUpdateWindow, 900);
        return { ...result, status: 'cancelled', message: '已取消更新' };
      }
      const message = String(error?.message || error || '更新失败').slice(0, 300);
      setDesktopUpdateWindowState('error', { version: result.version, message });
      return { ...result, status: 'error', message };
    } finally {
      desktopUpdateAbortController = null;
      desktopUpdateOperationPromise = null;
    }
  })();
  return desktopUpdateOperationPromise;
}

async function checkDesktopUpdate({ manual = false } = {}) {
  if (desktopUpdateOperationPromise) {
    return { status: 'downloading', message: '更新正在进行中' };
  }
  const check = desktopUpdateCheckPromise || (desktopUpdateCheckPromise = desktopUpdater.check().finally(() => {
    desktopUpdateCheckPromise = null;
  }));
  const result = await check;
  if (result.status === 'available') {
    const state = readDesktopUpdateState();
    if (!manual && state.dismissedVersion === result.version) return result;
    if (!desktopUpdatePromptPromise) {
      desktopUpdatePromptPromise = promptDesktopUpdate(result).finally(() => {
        desktopUpdatePromptPromise = null;
      });
    }
    return desktopUpdatePromptPromise;
  }
  if (manual) await showDesktopUpdateResult(result);
  return result;
}

function scheduleDesktopUpdateCheck() {
  if (!app.isPackaged || desktopUpdateStartupTimer) return;
  if (!desktopUpdater.readConfig().checkOnStartup) return;
  desktopUpdateStartupTimer = setTimeout(() => {
    desktopUpdateStartupTimer = null;
    void checkDesktopUpdate({ manual: false }).catch((error) => {
      console.warn(`[desktop-updater] 启动检查失败：${String(error?.message || error).slice(0, 180)}`);
    });
  }, 7000);
}

function hostAllowed(value, sellerOnly = false) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const list = sellerOnly ? SELLER_HOSTS : ALLOWED_HOSTS;
    return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function assistantContextHostAllowed(value) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return ASSISTANT_CONTEXT_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function navigationHostAllowed(value) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return NAVIGATION_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

const NAVIGATION_HOST_FAMILIES = Object.freeze({
  dmp: ['dmp.taobao.com'],
  taobao: ['taobao.com', 'tmall.com', 'tb.cn'],
  '1688': ['1688.com'],
  xiaohongshu: ['xiaohongshu.com', 'rednote.com'],
  douyin: ['douyin.com'],
  ...MARKETPLACE_HOST_FAMILIES,
});

function navigationHostFamily(value) {
  let host = '';
  try { host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
  for (const [family, suffixes] of Object.entries(NAVIGATION_HOST_FAMILIES)) {
    if (suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return family;
  }
  return host;
}

function amazonHostSuffix(value) {
  let host = '';
  try { host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
  return MARKETPLACE_HOST_FAMILIES.amazon.find((suffix) => host === suffix || host.endsWith(`.${suffix}`)) || '';
}

function isAmazonUrl(value) {
  return Boolean(amazonHostSuffix(value));
}

function isTaobaoChromeCompatibleUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
    return ['taobao.com', 'tmall.com', '1688.com', 'tb.cn'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function commerceChromePlatformIdentity() {
  if (process.platform === 'darwin') {
    return { userAgentPlatform: 'Macintosh; Intel Mac OS X 10_15_7', clientHintPlatform: 'macOS' };
  }
  if (process.platform === 'linux') {
    return { userAgentPlatform: 'X11; Linux x86_64', clientHintPlatform: 'Linux' };
  }
  return { userAgentPlatform: 'Windows NT 10.0; Win64; x64', clientHintPlatform: 'Windows' };
}

function buildCommerceChromeIdentity() {
  const chromiumVersion = String(process.versions?.chrome || '').match(/^\d+(?:\.\d+){2,3}$/)?.[0] || '126.0.0.0';
  const majorVersion = chromiumVersion.split('.')[0] || '126';
  const platform = commerceChromePlatformIdentity();
  const brands = `"Not/A)Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
  const fullVersionList = `"Not/A)Brand";v="8.0.0.0", "Chromium";v="${chromiumVersion}", "Google Chrome";v="${chromiumVersion}"`;
  return {
    userAgent: `Mozilla/5.0 (${platform.userAgentPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`,
    brands,
    fullVersionList,
    platform: platform.clientHintPlatform,
  };
}

const COMMERCE_CHROME_IDENTITY = Object.freeze(buildCommerceChromeIdentity());

function setRequestHeader(headers, name, value) {
  const needle = String(name || '').toLowerCase();
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === needle) delete headers[key];
  });
  headers[name] = value;
}

function hasRequestHeader(headers, name) {
  const needle = String(name || '').toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function applyTaobaoChromeRequestHeaders(requestHeaders) {
  const headers = requestHeaders || {};
  // 仅使用当前 Electron 内核实际提供的 Chromium 版本；不伪造不存在的
  // 浏览器能力，也不尝试绕过登录、验证码或风控页面。
  setRequestHeader(headers, 'User-Agent', COMMERCE_CHROME_IDENTITY.userAgent);
  setRequestHeader(headers, 'Sec-CH-UA', COMMERCE_CHROME_IDENTITY.brands);
  setRequestHeader(headers, 'Sec-CH-UA-Mobile', '?0');
  setRequestHeader(headers, 'Sec-CH-UA-Platform', `"${COMMERCE_CHROME_IDENTITY.platform}"`);
  // 高熵 Client Hints 只会在站点通过 Accept-CH 请求后由 Chromium 发送。
  // 此处只同步已存在的版本字段，避免无条件扩展指纹面。
  if (hasRequestHeader(headers, 'Sec-CH-UA-Full-Version')) {
    setRequestHeader(headers, 'Sec-CH-UA-Full-Version', `"${String(process.versions?.chrome || '126.0.0.0')}"`);
  }
  if (hasRequestHeader(headers, 'Sec-CH-UA-Full-Version-List')) {
    setRequestHeader(headers, 'Sec-CH-UA-Full-Version-List', COMMERCE_CHROME_IDENTITY.fullVersionList);
  }
  return headers;
}

function preferAmazonChineseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || !isAmazonUrl(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (!parsed.searchParams.get('language')) parsed.searchParams.set('language', AMAZON_PREFERRED_LANGUAGE);
    return parsed.toString();
  } catch {
    return raw;
  }
}

async function primeAmazonChineseLocale(entry, url) {
  if (!isAmazonUrl(url)) return false;
  const suffix = amazonHostSuffix(url);
  const webContents = entry?.view?.webContents;
  if (!suffix || !webContents || webContents.isDestroyed()) return false;
  try {
    const parsed = new URL(url);
    await webContents.session.cookies.set({
      url: `${parsed.protocol}//${parsed.hostname}/`,
      domain: `.${suffix}`,
      path: '/',
      name: 'lc-main',
      value: AMAZON_PREFERRED_LANGUAGE,
      secure: parsed.protocol === 'https:',
    });
    return true;
  } catch {
    // 请求头仍会提供中文协商；Cookie 写入失败不应阻塞官方页面加载。
    return false;
  }
}

function configureCommerceRequestHeaders(commerceSession) {
  if (!commerceSession || COMMERCE_REQUEST_HEADER_SESSIONS.has(commerceSession)) return;
  COMMERCE_REQUEST_HEADER_SESSIONS.add(commerceSession);
  commerceSession.webRequest.onBeforeSendHeaders(
    { urls: COMMERCE_REQUEST_HEADER_URL_PATTERNS },
    (details, callback) => {
      const requestHeaders = { ...(details.requestHeaders || {}) };
      if (isAmazonUrl(details.url)) {
        setRequestHeader(requestHeaders, 'Accept-Language', AMAZON_ACCEPT_LANGUAGE);
      }
      if (isTaobaoChromeCompatibleUrl(details.url)) {
        applyTaobaoChromeRequestHeaders(requestHeaders);
      }
      callback({ requestHeaders });
    },
  );
}

function isDouyinUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'douyin.com' || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

// Electron 的默认 UA 会携带 Electron/<version>。淘系统一登录页会将该内嵌
// 运行时标识与 Client Hints 一起判断。淘系页使用当前 Electron Chromium 的真实
// 版本组织成一致的 Chrome UA；其它已适配站点仍只移除 Electron 标记。
function requiresBrowserLikeUserAgent(value) {
  if (isDouyinUrl(value) || isAmazonUrl(value)) return true;
  return isTaobaoChromeCompatibleUrl(value);
}

function applyCommerceUserAgent(entry, url = '') {
  const webContents = entry?.view?.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  const defaultUserAgent = String(entry.defaultUserAgent || webContents.getUserAgent?.() || '').trim();
  if (!defaultUserAgent) return;
  const nextUserAgent = isTaobaoChromeCompatibleUrl(url)
    ? COMMERCE_CHROME_IDENTITY.userAgent
    : requiresBrowserLikeUserAgent(url)
      ? defaultUserAgent.replace(/\s+Electron\/[^\s]+/i, '').replace(/\s{2,}/g, ' ').trim()
      : defaultUserAgent;
  try {
    if (webContents.getUserAgent?.() !== nextUserAgent) webContents.setUserAgent(nextUserAgent);
  } catch {}
}

function safeSite(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (VERIFICATION_HOST_RE.test(host) || /\/(?:captcha|verify|security|punish)(?:\/|$)/i.test(parsed.pathname)) return '验证码拦截';
    if (host === 'dmp.taobao.com' || host.endsWith('.dmp.taobao.com')) return '达摩盘';
    if (host.includes('sycm')) return '生意参谋';
    if (host.includes('myseller') || host.includes('qianniu')) return '千牛';
    if (host.includes('tmall')) return '天猫';
    if (host.includes('taobao')) return '淘宝';
    if (host.includes('1688')) return '1688';
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'rednote.com' || host.endsWith('.rednote.com')) return '小红书';
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) return '抖音';
    const marketplaceFamily = navigationHostFamily(value);
    if (marketplaceFamily === 'amazon') return '亚马逊';
    if (marketplaceFamily === 'tiktok') return 'TikTok Shop';
    if (marketplaceFamily === 'temu') return 'Temu';
    if (marketplaceFamily === 'shopee') return '虾皮 Shopee';
    if (marketplaceFamily === 'ozon') return 'Ozon';
    if (marketplaceFamily === 'ebay') return 'eBay';
    if (marketplaceFamily === 'aliexpress') return '速卖通';
    if (marketplaceFamily === 'shein') return 'SHEIN';
    if (host === 'amazon.com' || host.endsWith('.amazon.com')) return '亚马逊';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok Shop';
    if (host === 'temu.com' || host.endsWith('.temu.com')) return 'Temu';
    if (host === 'shopee.com' || host.endsWith('.shopee.com')) return '虾皮 Shopee';
    if (host === 'ozon.ru' || host.endsWith('.ozon.ru')) return 'Ozon';
    if (host === 'ebay.com' || host.endsWith('.ebay.com')) return 'eBay';
    if (host === 'aliexpress.com' || host.endsWith('.aliexpress.com')) return '速卖通';
    if (host === 'shein.com' || host.endsWith('.shein.com')) return 'SHEIN';
    return '商品页';
  } catch { return '商品页'; }
}

function commerceSessionPartition(kind = '', site = '', url = '') {
  const kindValue = String(kind || '').trim().toLowerCase();
  const siteValue = String(site || '').trim().toLowerCase();
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch {}
  if (host === 'ozon.ru' || host.endsWith('.ozon.ru') || (!host && siteValue === 'ozon')) return OZON_DIRECT_SESSION_PARTITION;
  if (host === '1688.com' || host.endsWith('.1688.com') || (!host && siteValue === '1688')) return SESSION_1688_PARTITION;
  if (/(?:^|\.)(?:myseller|qianniu|sycm)\.taobao\.com$/.test(host)) return SELLER_SESSION_PARTITION;
  // 只要有明确 URL，就以实际站点为准，避免从千牛标签跳转到淘宝时
  // 因为旧的 site/kind 标记而继续沿用公司会话。
  if (host) return TAOBAO_SESSION_PARTITION;
  if (kindValue === 'seller' || ['seller', 'qianniu', 'sycm'].includes(siteValue)) return SELLER_SESSION_PARTITION;
  return TAOBAO_SESSION_PARTITION;
}

function commerceSessionProfile(partition, site = '') {
  if (partition === OZON_DIRECT_SESSION_PARTITION) {
    return ozonDirectSessionReady
      ? { id: 'ozon-direct', label: 'Ozon 直连会话' }
      : { id: 'ozon', label: 'Ozon 独立会话' };
  }
  if (partition === SESSION_1688_PARTITION) return { id: '1688', label: '1688独立会话' };
  if (partition === SELLER_SESSION_PARTITION) return { id: 'qianniu', label: '千牛工作台独立会话' };
  return String(site || '').trim() === '1688'
    ? { id: '1688', label: '1688独立会话' }
    : { id: 'taobao', label: '淘宝独立会话' };
}

function ensureProductNetworkCapture(entry) {
  if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) return null;
  if (entry.networkCapture) return entry.networkCapture;
  entry.networkCapture = createDabiNetworkCapture(entry.view.webContents);
  entry.networkCapture.ready.catch(() => {});
  return entry.networkCapture;
}

function releaseProductNetworkCapture(entry) {
  const capture = entry?.networkCapture;
  if (!capture) return;
  entry.networkCapture = null;
  try { void Promise.resolve(capture.dispose?.()).catch(() => {}); } catch {}
}

async function configureCommerceSessions() {
  for (const partition of [TAOBAO_SESSION_PARTITION, SESSION_1688_PARTITION, SELLER_SESSION_PARTITION, OZON_DIRECT_SESSION_PARTITION]) {
    const commerceSession = session.fromPartition(partition);
    commerceSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    configureCommerceRequestHeaders(commerceSession);
  }

  // Ozon 会把 Windows 系统代理识别为 VPN；仅它的独立会话绕过该代理，
  // 不改变其他工作应用的网络路径或既有登录会话。
  try {
    await session.fromPartition(OZON_DIRECT_SESSION_PARTITION).setProxy({ mode: 'direct' });
    ozonDirectSessionReady = true;
  } catch (error) {
    ozonDirectSessionReady = false;
    console.warn('Ozon 直连会话配置失败，将沿用系统网络设置：', error?.message || error);
  }
}

function isVerificationUrl(value, title = '') {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return VERIFICATION_HOST_RE.test(host)
      || /\/(?:captcha|verify|security|punish)(?:\/|$)/i.test(path)
      || /验证码|安全验证|滑块验证|风险验证|验证拦截/.test(String(title || ''));
  } catch {
    return /验证码|安全验证|滑块验证|风险验证|验证拦截/.test(String(title || ''));
  }
}

function isLoginUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return /^(?:login|passport|havanalogin|pass)\.(?:taobao|tmall|1688)\.com$/i.test(host);
  } catch {
    return false;
  }
}

function isTaobaoWebsiteUrl(value) {
  return navigationHostFamily(value) === 'taobao' && !isLoginUrl(value);
}

function surfaceSite(entry, value) {
  const currentUrl = String(value || '');
  // 1688 的官方登录链会短暂经过 login.taobao.com；这是阿里统一登录
  // 的桥接地址，不代表当前标签已经切换成淘宝。
  if (entry?.loginSite === '1688' && (isLoginUrl(currentUrl) || isTaobaoWebsiteUrl(currentUrl))) return '1688';
  if (entry?.partition === SESSION_1688_PARTITION && isLoginUrl(currentUrl)) return '1688';
  return safeSite(currentUrl);
}

function isDetailUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (host === 'item.taobao.com' || host.endsWith('.item.taobao.com')) && /\/item\.htm/.test(path)
      || (host === 'detail.tmall.com' || host.endsWith('.detail.tmall.com')) && /\/item\.htm/.test(path)
      || host === 'detail.1688.com' || host.endsWith('.detail.1688.com');
  } catch { return false; }
}

function is1688WebsiteUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
    return (host === '1688.com' || host.endsWith('.1688.com')) && !isLoginUrl(value);
  } catch {
    return false;
  }
}

function desktop1688EntryUrl(value) {
  const original = String(value || '').trim();
  try {
    const parsed = new URL(original);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'm.1688.com' && (parsed.pathname === '/' || parsed.pathname === '')) {
      return 'https://www.1688.com/';
    }
  } catch {}
  return original;
}

function is1688LoginTarget(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const direct1688Login = host.endsWith('.1688.com');
    const targetParam = String(parsed.searchParams.get('target') || parsed.searchParams.get('redirect_url') || '').toLowerCase();
    const from1688 = String(parsed.searchParams.get('from') || '').toLowerCase() === '1688web';
    // 1688 首页当前使用 login.1688.com/member/signin.htm；登录后有时
    // 还会先跳到 login.taobao.com/jump，再经过 pass.1688.com。只要
    // 淘宝统一登录地址自身带有指向 1688 的参数，就属于同一条官方链路；
    // 不能因为跨了阿里统一登录域名就拦掉重定向。
    return isLoginUrl(parsed.toString())
      && (direct1688Login
        || String(parsed.searchParams.get('bizName') || '').trim() === '1688'
        || targetParam.includes('1688.com')
        || from1688);
  } catch {
    return false;
  }
}

function matchesPending1688Navigation(entry, value) {
  const target = String(entry?.navigationTarget || '').trim();
  // 只约束 1688 主页和 1688 官方登录跳转，其他平台继续沿用现有的
  // 跨子域导航规则。
  if (!target || (!is1688WebsiteUrl(target) && !is1688LoginTarget(target))) return true;
  // 打开 1688 首页时只接受 1688 自身的提交；登录页由显式“登录1688”动作
  // 打开，避免上一轮遗留的淘宝登录页也被误当作新首页完成。
  if (is1688WebsiteUrl(target)) return is1688WebsiteUrl(value);
  return is1688WebsiteUrl(value) || isLoginUrl(value);
}

function navigationMatchesTarget(entry, value) {
  const target = String(entry?.navigationTarget || entry?.pendingNavigation || '').trim();
  if (!target) return true;
  if (!matchesPending1688Navigation(entry, value)) return false;
  // 1688 的登录页可能在 login.1688.com 与淘宝统一登录域名之间切换；
  // 这里只放行 1688 自身页面或已识别的登录域名。不能对登录目标无条件
  // 返回 true，否则统一登录页跳到 www.taobao.com 的错误页时，会把淘宝内容
  // 当成 1688 当前页面，造成“地址栏是 1688、页面却是淘宝”的错位。
  if (is1688LoginTarget(target)) return is1688WebsiteUrl(value) || isLoginUrl(value);
  return navigationHostFamily(target) === navigationHostFamily(value);
}

function navigationIsBlocked(entry) {
  const revision = Number(entry?.navigationRevision || 0);
  return Boolean(revision && Number(entry?.blockedNavigationRevision || 0) === revision);
}

function productEntryIsLive(entry) {
  const webContents = entry?.view?.webContents;
  return Boolean(
    entry
      && productViews.get(entry.id) === entry
      && webContents
      && !webContents.isDestroyed(),
  );
}

function productNavigationIsCurrent(entry, navigationRevision) {
  return productEntryIsLive(entry)
    && Number(entry.navigationRevision || 0) === Number(navigationRevision || 0);
}

function navigationEventMatchesCurrent(entry, value) {
  if (!productEntryIsLive(entry) || navigationIsBlocked(entry)) return false;
  const eventUrl = normalizeNavigationUrl(value);
  const currentUrl = normalizeNavigationUrl(entry?.view?.webContents?.getURL?.() || '');
  if (!eventUrl || !currentUrl || currentUrl === eventUrl) return true;
  // While a target is pending, a same-site delayed event is still stale. Do
  // not use the broad host-family allowance until the active navigation has
  // committed or the target has been cleared.
  if (entry?.navigationTarget || entry?.pendingNavigation) return false;
  // Electron 在地区域名切换时可能先报告旧 URL；同一平台族仍视为同一次导航。
  return navigationHostFamily(currentUrl) === navigationHostFamily(eventUrl);
}

function currentNavigationUrl(entry, value = '') {
  if (!productEntryIsLive(entry) || navigationIsBlocked(entry)) return '';
  const current = normalizeNavigationUrl(value || entry?.view?.webContents?.getURL?.() || '');
  return current && navigationMatchesTarget(entry, current) ? current : '';
}

function committedNavigationUrl(entry, value = '') {
  const current = currentNavigationUrl(entry, value);
  const target = normalizeNavigationUrl(entry?.navigationTarget || entry?.pendingNavigation || '');
  const source = normalizeNavigationUrl(entry?.navigationSourceUrl || '');
  // did-stop-loading has no navigation ID. If a replacement navigation is
  // pending and Chromium is still on the document it started from, that event
  // belongs to the old page even when both URLs share a host family.
  if (current && target && source && target !== source && current === source) return '';
  return current;
}

function normalizeNavigationUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(value || '');
  }
}

function validSharedCanvasUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const pathName = parsed.pathname.replace(/\/+$/, '') || '/';
    const invitePath = /^\/share\/[^/]+$/i.test(pathName);
    const sharedPage = /^\/static\/(?:smart-canvas|canvas)\.html$/i.test(pathName)
      && parsed.searchParams.get('shared') === '1'
      && Boolean(parsed.searchParams.get('share_id') || parsed.searchParams.get('share'));
    const token = parsed.searchParams.get('token') || parsed.searchParams.get('share_token');
    if (!token || (!invitePath && !sharedPage)) return null;
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function openSharedCanvasWindow(rawUrl, sender) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, message: '小美画布主窗口尚未准备好' };
  if (sender && BrowserWindow.fromWebContents(sender) !== mainWindow) return { ok: false, message: '只能从小美画布主窗口打开协同链接' };
  const parsed = validSharedCanvasUrl(rawUrl);
  if (!parsed) return { ok: false, message: '分享链接格式不正确，必须包含完整的 /share/ 地址和 token' };
  const url = parsed.toString();
  for (const [window, record] of sharedCanvasWindows) {
    if (window.isDestroyed()) {
      sharedCanvasWindows.delete(window);
      continue;
    }
    if (record.url === url) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return { ok: true, reused: true };
    }
  }
  const sharedWindow = new BrowserWindow({
    parent: mainWindow,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#f4f7fb',
    title: `${APP_NAME} · 协同画布`,
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // Each invitation gets an in-memory session. Share cookies from two
      // links on the same host must not overwrite one another.
      partition: `canvas-share-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      preload: SHARED_CANVAS_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  sharedWindow.setMenuBarVisibility(false);
  const record = { url, origin: parsed.origin };
  sharedCanvasWindows.set(sharedWindow, record);
  let showTimer = setTimeout(() => {
    if (sharedWindow.isDestroyed()) return;
    sharedWindow.show();
    sharedWindow.focus();
  }, 2500);
  const revealSharedWindow = () => {
    clearTimeout(showTimer);
    showTimer = null;
    if (sharedWindow.isDestroyed()) return;
    sharedWindow.show();
    sharedWindow.focus();
  };
  sharedWindow.on('closed', () => {
    if (showTimer) clearTimeout(showTimer);
    sharedCanvasWindows.delete(sharedWindow);
  });
  sharedWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sharedWindow.webContents.on('will-navigate', (event, nextUrl) => {
    try {
      // The invite endpoint redirects to the host's static canvas page. Keep
      // every later navigation on that same host and block external pages.
      if (new URL(nextUrl).origin !== record.origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  sharedWindow.once('ready-to-show', () => {
    revealSharedWindow();
  });
  sharedWindow.webContents.once('did-fail-load', revealSharedWindow);
  sharedWindow.loadURL(url).catch(() => {});
  return { ok: true, reused: false };
}

function detailProductKey(value) {
  if (!isDetailUrl(value)) return '';
  try {
    const parsed = new URL(String(value || ''));
    const id = parsed.searchParams.get('id')
      || parsed.searchParams.get('itemId')
      || parsed.searchParams.get('item_id')
      || parsed.searchParams.get('offerId')
      || parsed.searchParams.get('offer_id')
      || '';
    return `${parsed.hostname.toLowerCase()}:${id || parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function redact(value, limit = 24000) {
  return String(value || '')
    .replace(/(?:password|passwd|pwd|cookie|authorization|token|secret|sessionid|手机号|手机|电话|mobile|phone)\s*[:=：]\s*[^\s,;，；]+/gi, '[已脱敏字段]')
    .replace(/(?<!\d)(?:1[3-9]\d{9}|\+?86[- ]?1[3-9]\d{9})(?!\d)/g, '[已脱敏手机号]')
    .slice(0, Math.max(1, Number(limit) || 24000));
}

// 右侧助手只需要用 URL 区分页型；绝不把登录态、追踪或临时签名带回渲染器/后端。
const ASSISTANT_CONTEXT_QUERY_KEYS = new Set(['keyword', 'keywords', 'q', 'query', 'type', 'tab', 'showTab', 'showSubTab']);
function safeAssistantContextUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!/^https?:$/.test(parsed.protocol)) return '';
    const safe = new URL(`${parsed.origin}${parsed.pathname}`);
    for (const [key, item] of parsed.searchParams.entries()) {
      if (ASSISTANT_CONTEXT_QUERY_KEYS.has(key) && String(item || '').trim()) {
        safe.searchParams.set(key, redact(item, 180));
      }
    }
    return safe.toString();
  } catch {
    return '';
  }
}

function safeAssistantContextImageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!/^https?:$/.test(parsed.protocol)) return '';
    // 可见图片只作为视觉参考；去掉查询参数和 hash，避免携带 CDN 临时签名。
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function isAssistantContextLogin(value, title = '') {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return isLoginUrl(value)
      || /(?:^|\.)(?:login|passport|signin|account)\./i.test(host)
      || /\/(?:login|signin|passport|account)(?:\/|$)/i.test(path)
      || /(?:请先)?登录(?:后|$)|登录账号/.test(String(title || ''));
  } catch {
    return /(?:请先)?登录(?:后|$)|登录账号/.test(String(title || ''));
  }
}

function cleanAssistantContextPayload(payload, current, title = '') {
  const list = (value, limit, mapper = (item) => redact(item)) => Array.isArray(value)
    ? value.slice(0, limit).map(mapper).filter(Boolean)
    : [];
  const rawStructured = payload?.structured && typeof payload.structured === 'object' ? payload.structured : {};
  const facts = list(rawStructured.facts, 16, (fact) => {
    if (!fact || typeof fact !== 'object') return null;
    const label = redact(fact.label || fact.name || '', 80);
    const value = redact(fact.value || fact.text || '', 420);
    return label && value ? { label, value } : null;
  });
  // 资源只传达“当前页已实际读到哪一类资料”，不携带下载链接、选择器、
  // 请求参数或平台响应。前端会再按站点/页型白名单核对它们。
  const resources = list(rawStructured.resources, 24, (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
    const token = redact(entry.token || '', 120);
    const label = redact(entry.label || entry.title || '', 120);
    return id && token && label && entry.available !== false ? { id, token, label, available: true } : null;
  });
  const structured = {
    kind: redact(rawStructured.kind || '', 80),
    title: redact(rawStructured.title || '', 160),
    facts,
    resources,
    // 仅保存页内主体的短摘录，不能回退为整页 rawText；避免聊天上下文
    // 把背景瀑布流、导航和登录提示误当成当前作品资料。
    excerpt: redact(rawStructured.excerpt || '', 600),
  };
  const tables = list(payload?.tables, 24, (table) => {
    const rows = list(table?.rows, 120, (row) => Array.isArray(row)
      ? row.slice(0, 24).map((cell) => redact(cell, 180)).filter(Boolean)
      : []).filter((row) => row.length);
    const caption = redact(table?.title || table?.caption || '', 180);
    return caption || rows.length ? { title: caption, rows } : null;
  });
  const cards = list(payload?.cards, 60, (card) => {
    const cardTitle = redact(card?.title || '', 260);
    const text = redact(card?.text || '', 1200);
    const mainImage = safeAssistantContextImageUrl(card?.mainImage || '');
    return cardTitle || text || mainImage ? { title: cardTitle, text, mainImage } : null;
  });
  const comments = list(payload?.comments, 60, (comment) => {
    const author = redact(comment?.author || '', 100);
    const text = redact(comment?.text || '', 700);
    return text ? { author, text } : null;
  });
  const images = list(payload?.images, 12, (image) => {
    const url = safeAssistantContextImageUrl(image?.url || image || '');
    return url ? { url, alt: redact(image?.alt || '', 160) } : null;
  });
  return {
    source: 'electron-visible-dom-assistant',
    url: safeAssistantContextUrl(current),
    title: redact(payload?.title || title || '', 300),
    headings: list(payload?.headings, 80, (item) => redact(item, 240)),
    metrics: list(payload?.metrics, 80, (item) => redact(item, 320)),
    tables,
    cards,
    comments,
    images,
    videoCount: Math.max(0, Math.min(20, Number(payload?.videoCount) || 0)),
    visibleCount: Math.max(0, Math.min(180, Number(payload?.visibleCount) || cards.length)),
    rawText: redact(payload?.rawText || '', 24000),
    structured,
    capturedAt: Number(payload?.capturedAt) || Date.now(),
  };
}

function safeAgentAction(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const action = String(value.action || value.type || '').trim().toLowerCase();
  const module = String(value.module || 'page').trim().toLowerCase();
  let target = String(value.target || value.label || '').trim().slice(0, 120);
  if (!SAFE_AGENT_ACTIONS.has(action)) throw new Error(`网页智能体动作不在白名单内：${action || '空动作'}`);
  if (!SAFE_AGENT_MODULES.has(module)) throw new Error(`网页智能体模块不支持：${module}`);
  const rawKeys = Object.keys(value);
  if (rawKeys.some((key) => /selector|script|javascript|code|password|passwd|cookie|token|authorization|input|value|url/i.test(key))) {
    throw new Error('网页智能体不得提交脚本、选择器、凭据、输入值或外部 URL');
  }
  if (/javascript:|https?:\/\/|cookie|token|authorization|password|passwd|付款|购买|提交订单|改价|删除|发布/i.test(target)) {
    throw new Error('网页智能体目标包含被禁止的操作');
  }
  if (['click_tab', 'expand', 'paginate'].includes(action)) {
    const defaults = { reviews: '用户评价', questions: '问大家', detail: '图文详情', sku: '规格', product: '商品信息', images: '商品信息', videos: '视频', page: '更多' };
    if (!target) target = defaults[module] || '';
    if (!SAFE_AGENT_LABELS.has(target)) throw new Error(`网页智能体目标不在可见控件白名单内：${target || '空目标'}`);
  }
  let amount = Number(value.amount ?? value.pixels ?? 720);
  if (!Number.isFinite(amount)) amount = 720;
  amount = Math.max(200, Math.min(1600, Math.round(amount)));
  const direction = String(value.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
  return { action, module, target, amount, direction, max_items: Math.max(1, Math.min(200, Number(value.max_items) || 40)) };
}

function choosePython() {
  const bundled = path.join(PROJECT_ROOT, 'python', 'python.exe');
  const bundledWin = path.join(PROJECT_ROOT, 'build', 'win-api', 'xiaomei-api.exe');
  const bundledMac = path.join(PROJECT_ROOT, 'build', 'mac-api', 'xiaomei-api');
  return process.platform === 'win32' && fs.existsSync(bundledWin)
    ? bundledWin
    : process.platform === 'win32' && fs.existsSync(bundled)
      ? bundled
    : process.platform === 'darwin' && fs.existsSync(bundledMac)
      ? bundledMac
      : (process.platform === 'win32' ? 'python' : 'python3');
}

function chooseApiArguments(command) {
  const bundledWin = path.join(PROJECT_ROOT, 'build', 'win-api', 'xiaomei-api.exe');
  const bundledMac = path.join(PROJECT_ROOT, 'build', 'mac-api', 'xiaomei-api');
  return command === bundledWin || command === bundledMac
    ? []
    : ['main.py'];
}

async function probeApiAt(port, timeout = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(200, Number(timeout) || 900));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/app-info`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      try { server.close(() => resolve(available)); } catch { resolve(available); }
    };
    server.once('error', () => resolve(false));
    // main.py binds 0.0.0.0, so probe the same address family/scope to avoid
    // selecting a port that Python will immediately reject as occupied.
    server.listen({ host: '0.0.0.0', port }, () => finish(true));
  });
}

async function findFreeApiPort(start = CONFIGURED_API_PORT) {
  const first = Math.max(1, Math.min(65535, Number(start) || 3000));
  const last = Math.min(65535, first + 200);
  for (let port = first; port <= last; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`本地端口 ${first}-${last} 均不可用`);
}

function startApi(port = API_PORT) {
  if (process.env.XIAOMEI_CANVAS_DESKTOP_NO_API === '1') return;
  setApiEndpoint(port);
  const env = {
    ...process.env,
    XIAOMEI_CANVAS_PROJECT_ROOT: PROJECT_ROOT,
    XIAOMEI_CANVAS_DATA_ROOT: TEST_RUNTIME_DATA_ROOT,
    XIAOMEI_CANVAS_PORT: String(API_PORT),
    COMMERCE_ANALYSIS_BROWSER_PORT: String(TEST_BROWSER_PORT),
    TEMP: TEST_TEMP_ROOT,
    TMP: TEST_TEMP_ROOT,
  };
  try {
    const command = choosePython();
    apiProcess = spawn(command, chooseApiArguments(command), { cwd: PROJECT_ROOT, env, windowsHide: true, stdio: 'ignore' });
    apiProcess.on('error', () => { apiProcess = null; });
  } catch { apiProcess = null; }
}

async function ensureApi() {
  // Reuse an already-running Xiaomei API instead of spawning a second Python
  // process. This is important because main.py may otherwise fall back from
  // 3000 to 3001 while the Electron page continues to use the old origin.
  if (await probeApiAt(CONFIGURED_API_PORT)) {
    setApiEndpoint(CONFIGURED_API_PORT);
    return true;
  }
  const port = await findFreeApiPort(CONFIGURED_API_PORT);
  startApi(port);
  return waitForApi();
}

async function waitForApi(timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${LOCAL_ORIGIN}/api/app-info`);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function activeProductEntry(tabId = activeProductTabId) {
  return productViews.get(tabId) || (productViews.size ? [...productViews.values()][0] : null);
}

function productEntryForTab(tabId = '') {
  const id = String(tabId || '').trim();
  return id ? productViews.get(id) || null : activeProductEntry();
}

function browserSurfaceState(entry) {
  const webContents = entry?.view?.webContents;
  let canGoBack = false;
  let canGoForward = false;
  let zoom = 100;
  try {
    const navigationHistory = webContents?.navigationHistory;
    canGoBack = Boolean(navigationHistory?.canGoBack?.());
    canGoForward = Boolean(navigationHistory?.canGoForward?.());
  } catch {}
  // Electron 31 exposes both navigationHistory and the older WebContents
  // helpers. A WebContentsView can briefly report an out-of-date
  // navigationHistory value while a redirect or in-page navigation commits.
  try {
    if (!canGoBack && typeof webContents?.canGoBack === 'function') canGoBack = Boolean(webContents.canGoBack());
    if (!canGoForward && typeof webContents?.canGoForward === 'function') canGoForward = Boolean(webContents.canGoForward());
  } catch {}
  try {
    const factor = Number(webContents?.getZoomFactor?.());
    if (Number.isFinite(factor) && factor > 0) zoom = Math.round(factor * 100);
  } catch {}
  return { canGoBack, canGoForward, loading: Boolean(entry?.loading), zoom };
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// 只收集可见文本节点，不触碰输入框、脚本、媒体和可编辑区域；翻译结果
// 由主进程发给本机 LibreTranslate，再回写到原文本节点，页面行为仍由平台
// 自己的脚本控制。
const PAGE_TRANSLATION_COLLECT_SCRIPT = [
  '(() => {',
  '  const current = window.__xiaomeiPageTranslationState;',
  '  if (current && current.active) return { active: true, segments: [], truncated: false };',
  '  const body = document.body;',
  '  if (!body) return { active: false, segments: [], truncated: false };',
  '  const nodes = [];',
  '  const originals = [];',
  '  const segments = [];',
  '  const blockedSelector = \'script,style,noscript,template,svg,canvas,video,audio,textarea,input,select,option,[contenteditable="true"],[aria-hidden="true"],[data-xiaomei-no-translate]\';',
  '  const chinesePattern = /[\\u3400-\\u9fff]/g;',
  '  const isVisible = (element) => {',
  '    if (!element || !element.closest || element.closest(blockedSelector)) return false;',
  '    const style = window.getComputedStyle(element);',
  '    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;',
  '    const rect = element.getBoundingClientRect();',
  '    return rect.width > 0 && rect.height > 0;',
  '  };',
  '  const walker = document.createTreeWalker(body, window.NodeFilter ? window.NodeFilter.SHOW_TEXT : 4);',
  '  let node;',
  '  let chars = 0;',
  '  let truncated = false;',
  '  while ((node = walker.nextNode())) {',
  '    if (segments.length >= ' + TRANSLATION_MAX_SEGMENTS + ' || chars >= ' + TRANSLATION_MAX_CHARS + ') { truncated = true; break; }',
  '    const parent = node.parentElement;',
  '    if (!isVisible(parent)) continue;',
  '    const normalized = String(node.nodeValue || "").replace(/\\s+/g, " ").trim();',
  '    if (normalized.length < 2 || normalized.length > 1000) continue;',
  '    const foreignLetters = normalized.match(/[A-Za-z\\u00c0-\\u024f\\u0370-\\u03ff\\u0400-\\u04ff\\u3040-\\u30ff]/g) || [];',
  '    if (!foreignLetters.length) continue;',
  '    const chineseCount = (normalized.match(chinesePattern) || []).length;',
  '    if (chineseCount >= foreignLetters.length) continue;',
  '    nodes.push(node);',
  '    originals.push(String(node.nodeValue || ""));',
  '    segments.push({ index: nodes.length - 1, text: normalized });',
  '    chars += normalized.length;',
  '  }',
  '  window.__xiaomeiPageTranslationState = { active: false, nodes, originals };',
  '  return { active: false, segments, truncated };',
  '})()',
].join('\n');

const PAGE_TRANSLATION_RESTORE_SCRIPT = [
  '(() => {',
  '  const state = window.__xiaomeiPageTranslationState;',
  '  if (!state || !state.active) return { ok: false, count: 0 };',
  '  let count = 0;',
  '  (state.nodes || []).forEach((node, index) => {',
  '    if (!node || !node.isConnected || !Array.isArray(state.originals) || state.originals[index] == null) return;',
  '    node.nodeValue = state.originals[index];',
  '    count += 1;',
  '  });',
  '  state.active = false;',
  '  return { ok: true, count };',
  '})()',
].join('\n');

function pageTranslationApplyScript(updates) {
  const payload = safeScriptJson(Array.isArray(updates) ? updates : []);
  return [
    '(() => {',
    '  const state = window.__xiaomeiPageTranslationState;',
    '  const updates = ' + payload + ';',
    '  if (!state || !Array.isArray(state.nodes)) return { ok: false, count: 0 };',
    '  let count = 0;',
    '  updates.forEach((item) => {',
    '    const index = Number(item && item.index);',
    '    const node = Number.isInteger(index) ? state.nodes[index] : null;',
    '    const translated = String(item && item.text || "").trim();',
    '    if (!node || !node.isConnected || !translated) return;',
    '    const original = String(state.originals?.[index] ?? node.nodeValue ?? "");',
    '    const leading = (original.match(/^\\s*/) || [""])[0];',
    '    const trailing = (original.match(/\\s*$/) || [""])[0];',
    '    node.nodeValue = leading + translated + trailing;',
    '    count += 1;',
  '  });',
  '  state.active = count > 0;',
  '  return { ok: state.active, count };',
  '})()',
  ].join('\n');
}

function translationEndpointConfig() {
  const raw = TRANSLATION_ENDPOINT || DEFAULT_TRANSLATION_ENDPOINT;
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, message: '本地翻译服务地址必须使用 HTTP 或 HTTPS' };
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      return { ok: false, message: '为保护平台页面隐私，翻译服务地址必须是本机地址（127.0.0.1、localhost 或 ::1）' };
    }
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/translate';
    parsed.hash = '';
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, message: '本地翻译服务地址格式不正确，请检查 XIAOMEI_TRANSLATE_URL' };
  }
}

function translationBatches(texts) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const text of Array.isArray(texts) ? texts : []) {
    const value = String(text || '').trim();
    if (!value) continue;
    if (current.length && (current.length >= TRANSLATION_BATCH_ITEMS || chars + value.length > TRANSLATION_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(value);
    chars += value.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function requestTranslationPayload(endpoint, texts, singleText = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const payload = { q: singleText ? texts[0] : texts, source: 'auto', target: 'zh', format: 'text' };
    if (TRANSLATION_API_KEY) payload.api_key = TRANSLATION_API_KEY;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data?.error || ('HTTP ' + response.status)));
    const translated = Array.isArray(data?.translatedText)
      ? data.translatedText
      : typeof data?.translatedText === 'string' && texts.length === 1
        ? [data.translatedText]
        : [];
    if (translated.length !== texts.length || translated.some((item) => typeof item !== 'string')) {
      throw new Error('翻译服务返回的文字数量不匹配');
    }
    return translated.map((item) => String(item || '').trim());
  } finally {
    clearTimeout(timer);
  }
}

async function requestTranslationBatch(endpoint, texts) {
  try {
    return await requestTranslationPayload(endpoint, texts, false);
  } catch (error) {
    // 兼容只接受单条 q 字段的 LibreTranslate 版本；批量接口失败时，
    // 不让整个页面翻译直接失效。
    if (texts.length <= 1) throw error;
    const translated = [];
    for (const text of texts) {
      translated.push(...await requestTranslationPayload(endpoint, [text], true));
    }
    return translated;
  }
}

async function clearPageTranslationState(webContents) {
  try {
    if (webContents && !webContents.isDestroyed()) {
      await webContents.executeJavaScript('window.__xiaomeiPageTranslationState = null; true;', true);
    }
  } catch {}
}

async function translateProductPage(tabId = '') {
  const entry = productEntryForTab(tabId);
  const webContents = entry?.view?.webContents;
  if (!entry || !webContents || webContents.isDestroyed()) {
    return { ok: false, code: 'no_page', message: '当前没有可翻译的官方页面' };
  }
  const endpoint = translationEndpointConfig();
  if (!endpoint.ok) return endpoint;
  try {
    const alreadyTranslated = await webContents.executeJavaScript(
      'Boolean(window.__xiaomeiPageTranslationState && window.__xiaomeiPageTranslationState.active)',
      true,
    );
    if (alreadyTranslated) {
      const restored = await webContents.executeJavaScript(PAGE_TRANSLATION_RESTORE_SCRIPT, true);
      return {
        ok: true,
        translated: false,
        restored: true,
        count: Number(restored?.count) || 0,
        message: '已恢复当前页面原文',
      };
    }
    const collected = await webContents.executeJavaScript(PAGE_TRANSLATION_COLLECT_SCRIPT, true);
    const segments = Array.isArray(collected?.segments)
      ? collected.segments
        .map((item) => ({ index: Number(item?.index), text: String(item?.text || '').trim() }))
        .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.text)
      : [];
    const uniqueTexts = [];
    const seen = new Set();
    for (const segment of segments) {
      if (seen.has(segment.text)) continue;
      seen.add(segment.text);
      uniqueTexts.push(segment.text);
    }
    if (!uniqueTexts.length) {
      await clearPageTranslationState(webContents);
      return { ok: false, code: 'no_translatable_text', message: '当前页面没有检测到可翻译的外文文字' };
    }
    const translatedByText = new Map();
    for (const batch of translationBatches(uniqueTexts)) {
      const translated = await requestTranslationBatch(endpoint.url, batch);
      batch.forEach((source, index) => translatedByText.set(source, translated[index] || ''));
    }
    const updates = segments
      .map((segment) => ({ index: segment.index, text: translatedByText.get(segment.text) || '' }))
      .filter((item) => item.text);
    const applied = await webContents.executeJavaScript(pageTranslationApplyScript(updates), true);
    if (!applied?.ok || !Number(applied.count)) {
      await clearPageTranslationState(webContents);
      return { ok: false, code: 'translation_not_applied', message: '翻译结果暂未能应用到当前页面，请刷新后重试' };
    }
    return {
      ok: true,
      translated: true,
      count: Number(applied.count) || 0,
      truncated: Boolean(collected?.truncated),
      message: collected?.truncated
        ? '已将页面中的部分外文翻译为中文'
        : '已将当前页面外文翻译为中文',
    };
  } catch (error) {
    await clearPageTranslationState(webContents);
    const rawMessage = String(error?.message || '').trim();
    const serviceUnavailable = /failed to fetch|fetch failed|econnrefused|networkerror|aborted|连接被拒绝|无法连接/i.test(rawMessage);
    return {
      ok: false,
      code: serviceUnavailable ? 'translation_service_unavailable' : 'translation_failed',
      message: serviceUnavailable
        ? `翻译服务未启动：请先启动本机 LibreTranslate（${endpoint.url}），再点击“翻译中文”`
        : '页面翻译失败：' + (rawMessage || '本地翻译服务暂未响应') + '。请确认 LibreTranslate 已在 ' + endpoint.url + ' 运行',
    };
  }
}

function hideProductViews() {
  for (const entry of productViews.values()) {
    setProductViewVisibilityState(entry, false);
    // 保留 WebContentsView 在内容树中。移除后再挂回会让部分 Electron/Windows
    // 组合丢失已有的渲染层，切回商品标签时就会出现中间区域白屏。
    // setVisible(false) 已足够让它不遮挡其它工作区。
  }
}

function hasUsableSurfaceBounds(bounds = lastSurfaceBounds) {
  if (!bounds || typeof bounds !== 'object') return false;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  return Number.isFinite(width) && Number.isFinite(height) && width >= 80 && height >= 80;
}

function isProductViewVisible(entry) {
  return Boolean(entry?.visible);
}

function setProductViewVisibilityState(entry, visible) {
  if (!entry?.view) return;
  const next = Boolean(visible);
  try {
    entry.view.setVisible(next);
    entry.visible = next;
  } catch {
    entry.visible = false;
  }
}

// 商品页是 BrowserWindow 内容视图里的原生顶层视图。主窗口页面重新加载、
// 切换工作区或新增标签后，渲染器里的 iframe 仍然正常；商品页只在需要时
// 隐藏，恢复时通过 addChildView() 提升层级，避免破坏已有的页面渲染进程。
function promoteProductView(entry) {
  if (!entry?.view || !mainWindow || mainWindow.isDestroyed()) return;
  // Electron 会把已存在的子视图重新添加到最上层；不要先 removeChildView，
  // 否则商品页的 WebContentsView 在切换标签/遮罩后可能只剩一块白色渲染层。
  try { mainWindow.contentView.addChildView(entry.view); } catch {}
}

function applyProductViewVisibility(entry, visible) {
  if (!entry?.view || !mainWindow || mainWindow.isDestroyed()) return;
  const shouldShow = Boolean(
    visible
      && commercePageActive
      && !commerceSurfaceBlocked
       && entry.url
       && (entry.pageLoaded || entry.domReady || entry.verification)
       && hasUsableSurfaceBounds(),
  );
  if (!shouldShow) {
    setProductViewVisibilityState(entry, false);
    return;
  }
  // 先设置有效尺寸，再打开原生视图。首次导航时如果先以 0x0 显示，
  // Windows 合成层偶尔会保留一块白色渲染层，即使随后收到正确尺寸也不重绘。
  // 普通页面至少等当前文档完成 DOM 初始化后再显示，避免复用标签时旧的淘宝
  // 画面覆盖正在加载的 1688 页面；不必再等待图片、字体等全部子资源结束。
  // 已确认的验证页可以提前显示滑块，加载期间由前端状态栏显示加载或验证提示。
  try { entry.view.setBounds(lastSurfaceBounds); } catch {}
  promoteProductView(entry);
  setProductViewVisibilityState(entry, true);
}

function refreshProductViewVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 商品分析 iframe 里还可能停留在“新标签页/工作应用首页”。这时
  // activeProductTabId 必须为空；不能用 activeProductEntry() 的历史回退
  // 值重新显示旧商品页，否则迟到的尺寸同步会把旧 WebContentsView 盖回来。
  const active = activeProductTabId ? productViews.get(activeProductTabId) : null;
  const canShow = commercePageActive && !commerceSurfaceBlocked && Boolean(active);
  for (const entry of productViews.values()) {
    const visible = Boolean(canShow && entry === active && entry.url);
    applyProductViewVisibility(entry, visible);
  }
}

// 启动时商品分析 iframe 可能比主页面的首次路由恢复晚完成。若首次
// setCommercePageActive IPC 落在这个窗口期，原生商品页会已经加载完成，
// 但一直被 pageActive 闸门隐藏。用主页面当前真正 active 的 iframe 做一次
// 只读校准，避免依赖单次 IPC 的时序。
async function syncCommercePageActiveFromRenderer() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) return commercePageActive;
  const revision = commercePageActiveRevision;
  try {
    const activeFrameId = await mainWindow.webContents.executeJavaScript(
      "document.querySelector('iframe.active')?.id || ''",
      true,
    );
    // 读取 iframe 状态期间如果收到了新的显式切换通知，当前结果已经过期。
    if (revision !== commercePageActiveRevision) return commercePageActive;
    // 主页面刚启动或正在恢复路由时，active iframe 可能暂时还不存在。
    // 这不是“已切离商品分析台”，不能用这个瞬间状态把原生商品页隐藏掉。
    if (!String(activeFrameId || '').trim()) return commercePageActive;
    const next = String(activeFrameId) === 'frame-commerce-analysis';
    if (next !== commercePageActive) {
      commercePageActive = next;
      if (!next) hideProductViews();
      else refreshProductViewVisibility();
    }
  } catch {}
  return commercePageActive;
}

async function syncProductSurfaceBoundsFromRenderer() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) return false;
  try {
    const bounds = await mainWindow.webContents.executeJavaScript(`(() => {
      const frame = document.getElementById('frame-commerce-analysis');
      if (!frame || !frame.classList.contains('active')) return null;
      const surface = frame.contentDocument?.getElementById('commerceBrowserSurface');
      if (!surface) return null;
      const frameRect = frame.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      return {
        x: frameRect.left + surfaceRect.left,
        y: frameRect.top + surfaceRect.top,
        width: surfaceRect.width,
        height: surfaceRect.height,
      };
    })()`, true);
    if (!hasUsableSurfaceBounds(bounds)) return false;
    updateViewBounds(bounds, activeProductTabId);
    return true;
  } catch { return false; }
}

function scheduleCommerceSurfaceResync() {
  const token = ++commerceSurfaceResyncToken;
  [0, 60, 180, 450, 900].forEach((delay) => {
    setTimeout(() => {
      if (token !== commerceSurfaceResyncToken || !mainWindow || mainWindow.isDestroyed()) return;
      void (async () => {
        await syncCommercePageActiveFromRenderer();
        if (token !== commerceSurfaceResyncToken || !commercePageActive || commerceSurfaceBlocked) return;
        await syncProductSurfaceBoundsFromRenderer();
        refreshProductViewVisibility();
      })();
    }, delay);
  });
}

function setCommerceSurfaceBlocked(blocked) {
  const next = Boolean(blocked);
  if (next === commerceSurfaceBlocked) {
    if (next) hideProductViews();
    else refreshProductViewVisibility();
    return;
  }
  if (next) {
    const visibleEntry = [...productViews.values()].find((entry) => {
      return isProductViewVisible(entry);
    });
    commerceSurfaceWasVisible = Boolean(visibleEntry);
    commerceSurfaceWasVisibleTabId = visibleEntry?.id || activeProductTabId || '';
    commerceSurfaceBlocked = true;
    hideProductViews();
    return;
  }

  commerceSurfaceBlocked = false;
  commerceSurfaceWasVisible = false;
  commerceSurfaceWasVisibleTabId = '';
  refreshProductViewVisibility();
}

function sendSurfaceState(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const activeTabId = String(activeProductTabId || '').trim();
  const requestedTabId = String(extra.tabId || '').trim();
  // 不让已切走标签的异步导航事件回填当前页面。尤其是在渲染器重载后，
  // 旧 WebContentsView 的 did-finish-load 曾会把淘宝页重新创建/激活，
  // 从而造成“地址栏是 1688，内容仍是淘宝”的状态错位。
  if (!activeTabId || (requestedTabId && requestedTabId !== activeTabId)) return;
  const stateTabId = activeTabId;
  const stateEntry = productViews.get(stateTabId);
  if (!stateEntry) return;
  // entry.url is the last committed main-frame URL. Do not publish a requested
  // URL here: a delayed event from an old document must never make the renderer
  // show a new address above an old page.
  const stateUrl = normalizeNavigationUrl(stateEntry?.url || '');
  const requestedUrl = normalizeNavigationUrl(stateEntry?.requestedUrl || stateEntry?.pendingNavigation || '');
  const title = stateEntry?.view?.webContents?.getTitle?.() || '';
  const site = surfaceSite(stateEntry, stateUrl || requestedUrl);
  const verification = extra.verification ?? stateEntry?.verification ?? isVerificationUrl(stateUrl, title);
  mainWindow.webContents.send('commerce:surface-state', {
    tabId: stateTabId,
    url: stateUrl,
    requestedUrl,
    navigationRevision: Number(stateEntry?.navigationRevision || 0),
    committedNavigationRevision: Number(stateEntry?.committedNavigationRevision || 0),
    site,
    title,
    ready: Boolean(stateEntry?.pageLoaded),
    verification: Boolean(verification),
    verificationMessage: verification ? `当前是${site}官方验证页面，请手动完成验证；小美不会自动跳转。` : '',
    ...browserSurfaceState(stateEntry),
    ...extra,
    // These values describe the committed document and must not be overridden
    // by a caller that only knows the requested navigation target.
    tabId: stateTabId,
    url: stateUrl,
    requestedUrl,
    navigationRevision: Number(stateEntry?.navigationRevision || 0),
    committedNavigationRevision: Number(stateEntry?.committedNavigationRevision || 0),
    visible: isProductViewVisible(stateEntry),
  });
}

// 淘宝/1688 的统一登录或 CDN 首跳偶尔会把已经开始的顶层导航以
// net::ERR_FAILED 等瞬时网络错误结束。该错误并不总是代表站点不可用，
// 但原先会立即隐藏 WebContentsView，让用户只能看到失败占位页。
// 仅对仍指向当前目标地址、且尚未加载出文档的首跳重试一次；登录、验证、
// 非白名单和用户发起的后续导航不在此范围内。
const TRANSIENT_COMMERCE_NAVIGATION_ERROR_CODES = new Set([
  -2,   // ERR_FAILED
  -7,   // ERR_TIMED_OUT
  -101, // ERR_CONNECTION_RESET
  -102, // ERR_CONNECTION_REFUSED
  -104, // ERR_CONNECTION_FAILED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
  -324, // ERR_EMPTY_RESPONSE
]);
const COMMERCE_NAVIGATION_RETRY_DELAY_MS = 500;

function clearProductNavigationRetry(entry, { resetCount = true } = {}) {
  if (!entry) return;
  if (entry.navigationRetryTimer) clearTimeout(entry.navigationRetryTimer);
  entry.navigationRetryTimer = null;
  entry.retryingNavigation = false;
  if (resetCount) entry.navigationRetryCount = 0;
}

function canRetryProductNavigation(entry, attemptedUrl, errorCode) {
  const targetUrl = normalizeNavigationUrl(entry?.navigationTarget || entry?.pendingNavigation || '');
  const failedUrl = normalizeNavigationUrl(attemptedUrl);
  return Boolean(
    entry
      && !entry.pageLoaded
      && !entry.retryingNavigation
      && !entry.navigationRetryTimer
      && Number(entry.navigationRetryCount || 0) < 1
      && TRANSIENT_COMMERCE_NAVIGATION_ERROR_CODES.has(Number(errorCode))
      && targetUrl
      && failedUrl === targetUrl
      && navigationHostAllowed(targetUrl)
      && !isVerificationUrl(targetUrl),
  );
}

function retryProductNavigation(entry, attemptedUrl, errorCode) {
  if (!canRetryProductNavigation(entry, attemptedUrl, errorCode)) return false;
  const retryUrl = normalizeNavigationUrl(attemptedUrl);
  const sourceRevision = Number(entry.navigationRevision || 0);
  entry.navigationRetryCount = Number(entry.navigationRetryCount || 0) + 1;
  entry.retryingNavigation = true;
  entry.loading = true;
  entry.loadFailed = false;
  entry.navigationRetryTimer = setTimeout(() => {
    entry.navigationRetryTimer = null;
    if (!productNavigationIsCurrent(entry, sourceRevision) || !entry.retryingNavigation) return;
    const next = beginProductNavigation(entry, retryUrl, { preserveRetry: true });
    entry.retryingNavigation = false;
    applyCommerceUserAgent(entry, next.targetUrl);
    if (isDetailUrl(next.targetUrl)) ensureProductNetworkCapture(entry);
    else releaseProductNetworkCapture(entry);
    entry.view.webContents.loadURL(next.targetUrl).catch((error) => {
      if (!productNavigationIsCurrent(entry, next.navigationRevision)) return;
      failProductNavigation(entry, {
        navigationRevision: next.navigationRevision,
        attemptedUrl: next.targetUrl,
        message: redact(error?.message || '页面加载失败'),
      });
    });
  }, COMMERCE_NAVIGATION_RETRY_DELAY_MS);
  sendSurfaceState({ tabId: entry.id, ready: false, loading: true });
  return true;
}

function failProductNavigation(entry, {
  navigationRevision = entry?.navigationRevision,
  attemptedUrl = '',
  message = '页面加载失败',
  errorCode = NaN,
} = {}) {
  if (!productNavigationIsCurrent(entry, navigationRevision)) return false;
  // loadURL() rejection and did-fail-load can arrive for the same failed
  // navigation. Once a retry is scheduled, the second signal must not turn
  // the temporary recovery state into a visible failure.
  if (entry.retryingNavigation || entry.navigationRetryTimer) return 'retrying';
  if (retryProductNavigation(entry, attemptedUrl, errorCode)) return 'retrying';
  clearProductNavigationRetry(entry);
  entry.blockedNavigationRevision = Number(navigationRevision || 0);
  entry.loading = false;
  entry.pageLoaded = false;
  entry.domReady = false;
  entry.loadFailed = true;
  entry.verification = false;
  entry.requestedUrl = '';
  entry.pendingNavigation = '';
  entry.navigationTarget = '';
  entry.navigationSourceUrl = '';
  setProductViewVisibilityState(entry, false);
  refreshProductViewVisibility();
  sendSurfaceState({
    tabId: entry.id,
    url: entry.url || normalizeNavigationUrl(attemptedUrl),
    title: '页面加载失败',
    ready: false,
    loading: false,
    loadError: message,
  });
  return true;
}

function rejectProductNavigation(entry, attemptedUrl = '', message = '页面跳转到未匹配的官方站点，已阻止旧页面覆盖当前标签') {
  return failProductNavigation(entry, { attemptedUrl, message });
}

function updateViewBounds(bounds, tabId = activeProductTabId) {
  const id = String(tabId || activeProductTabId || '').trim();
  if (!id) return;
  const entry = productViews.get(id);
  if (!entry || !mainWindow || !bounds) return;
  const numeric = ['x', 'y', 'width', 'height'].reduce((out, key) => { const value = Number(bounds[key]); out[key] = Number.isFinite(value) ? Math.round(value) : 0; return out; }, {});
  if (numeric.width < 80 || numeric.height < 80) return;
  lastSurfaceBounds = numeric;
  entry.view.setBounds(numeric);
  refreshProductViewVisibility();
}

function requestProductTab(entry, url) {
  if (!mainWindow || mainWindow.isDestroyed() || entry?.id !== activeProductTabId || !hostAllowed(url) || !isDetailUrl(url)) return;
  const normalized = normalizeNavigationUrl(url);
  const requestKey = detailProductKey(normalized) || normalized;
  const now = Date.now();
  // 淘宝商品页会在打开后追加追踪参数、跳转风控页再回跳。按商品 ID 去重，
  // 否则同一次点击会被当成多个“新商品标签”。
  if (entry.lastRequestedKey === requestKey && now - (entry.lastRequestedAt || 0) < 10000) return;
  entry.lastRequestedKey = requestKey;
  entry.lastRequestedAt = now;
  mainWindow.webContents.send('commerce:new-tab-request', { url: normalized, sourceTabId: entry.id, kind: 'detail' });
}

function promote1688LoginToTopLevel(entry, targetUrl = '') {
  const webContents = entry?.view?.webContents;
  const currentUrl = webContents?.getURL?.() || entry?.url || '';
  // 在 will-redirect / will-frame-navigate 回调里，Electron 有时已经把
  // getURL() 更新成了即将离开的登录地址；此时不能只看 currentUrl，
  // 还要看本次导航建立的目标，否则 1688 首页的登录跳转会被通用白名单
  // 拦截，旧的淘宝错误页就会继续留在可见视图里。
  const sourceIs1688 = is1688WebsiteUrl(currentUrl)
    || is1688WebsiteUrl(entry?.navigationTarget)
    || is1688WebsiteUrl(entry?.pendingNavigation);
  if (!webContents || webContents.isDestroyed() || entry?.id !== activeProductTabId || !sourceIs1688 || entry.promoting1688Login) return;
  entry.promoting1688Login = true;
  const requestedUrl = normalizeNavigationUrl(targetUrl);
  const loginUrl = isLoginUrl(requestedUrl) && navigationHostAllowed(requestedUrl)
    ? requestedUrl
    : commerceLoginUrl('1688', entry.id);
  void loadProduct(loginUrl, entry.id, 'login')
    .catch(() => {})
    .finally(() => { entry.promoting1688Login = false; });
}

function shouldPromote1688Login(entry, targetUrl) {
  // 当前已经在把同一条 1688 登录链提升到顶层时，后续经过
  // pass.1688.com / login.1688.com 的跳转应交给 navigationTarget 继续，
  // 不能再次 preventDefault 造成登录链半途停住。
  if (entry?.promoting1688Login) return false;
  const currentUrl = entry?.view?.webContents?.getURL?.() || entry?.url || '';
  // getURL() 在重定向事件触发前后都可能先于事件参数变化；保留当前
  // 1688 网址之外，还要用 navigationTarget/pendingNavigation 识别这条
  // 导航的来源，避免首页跳登录时误落回旧淘宝页面。
  const sourceIs1688 = is1688WebsiteUrl(currentUrl)
    || is1688WebsiteUrl(entry?.navigationTarget)
    || is1688WebsiteUrl(entry?.pendingNavigation);
  return sourceIs1688 && isLoginUrl(targetUrl);
}

function shouldRecover1688LoginLanding(entry, targetUrl) {
  return entry?.loginSite === '1688' && isTaobaoWebsiteUrl(targetUrl);
}

function recover1688LoginLanding(entry) {
  if (!entry || entry.recovering1688Login || productViews.get(entry.id) !== entry) return;
  entry.recovering1688Login = true;
  void loadProduct('https://www.1688.com/', entry.id, 'home')
    .catch(() => {})
    .finally(() => {
      if (productViews.get(entry.id) === entry) entry.recovering1688Login = false;
    });
}

function beginProductNavigation(entry, value, { preserveRetry = false } = {}) {
  const targetUrl = normalizeNavigationUrl(value);
  if (!entry || !targetUrl) return { targetUrl: '', navigationRevision: 0 };
  if (!preserveRetry) clearProductNavigationRetry(entry);
  const navigationRevision = Number(entry.navigationRevision || 0) + 1;
  entry.navigationRevision = navigationRevision;
  entry.blockedNavigationRevision = 0;
  entry.navigationStartedRevision = 0;
  entry.navigationSourceUrl = normalizeNavigationUrl(entry.view?.webContents?.getURL?.() || entry.url || '');
  entry.requestedUrl = targetUrl;
  entry.pendingNavigation = targetUrl;
  entry.navigationTarget = targetUrl;
  entry.pageLoaded = false;
  entry.domReady = false;
  entry.loading = true;
  entry.loadFailed = false;
  entry.verification = false;
  setProductViewVisibilityState(entry, false);
  refreshProductViewVisibility();
  sendSurfaceState({ tabId: entry.id, title: '', ready: false, loading: true });
  return { targetUrl, navigationRevision };
}

function commitProductNavigation(entry, value = '') {
  if (!entry || navigationIsBlocked(entry)) return '';
  const committedUrl = committedNavigationUrl(entry, value);
  if (!committedUrl) return '';
  entry.url = committedUrl;
  entry.committedNavigationRevision = Number(entry.navigationRevision || 0);
  return committedUrl;
}

function attachProductView(entry) {
  const view = entry.view;
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = String(input.key || '').toLowerCase();
    const control = Boolean(input.control || input.meta);
    const sendShortcut = (action, extra = {}) => mainWindow?.webContents?.send('commerce:browser-shortcut', { tabId: entry.id, action, ...extra });
    if (control && !input.shift && key === 't') { event.preventDefault(); sendShortcut('new-tab'); return; }
    if (control && input.shift && key === 'delete') { event.preventDefault(); sendShortcut('clear-data'); return; }
    if (control && !input.shift && key === 'l') { event.preventDefault(); sendShortcut('focus-address'); return; }
    if (control && !input.shift && key === 'r') { event.preventDefault(); reloadProduct(entry.id); return; }
    if (control && !input.shift && key === 'w') { event.preventDefault(); sendShortcut('close-tab'); return; }
    if (control && key === 'tab') { event.preventDefault(); sendShortcut(input.shift ? 'prev-tab' : 'next-tab'); return; }
    if (control && !input.shift && /^[1-8]$/.test(key)) { event.preventDefault(); sendShortcut('jump-tab', { index: Number(key) - 1 }); return; }
    if (input.alt && key === 'arrowleft') { event.preventDefault(); navigateProductHistory('back', entry.id); return; }
    if (input.alt && key === 'arrowright') { event.preventDefault(); navigateProductHistory('forward', entry.id); return; }
  });
  view.webContents.on('console-message', (_event, _level, message) => {
    const value = String(message || '').trim();
    if (value === '__XIAOMEI_DABI_STOP__') stopActiveDabiCollection(entry);
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldRecover1688LoginLanding(entry, url)) {
      queueMicrotask(() => recover1688LoginLanding(entry));
      return { action: 'deny' };
    }
    if (shouldPromote1688Login(entry, url)) {
      queueMicrotask(() => promote1688LoginToTopLevel(entry, url));
      return { action: 'deny' };
    }
    if (!navigationHostAllowed(url)) return { action: 'deny' };
    if (isVerificationUrl(url)) {
      const next = beginProductNavigation(entry, url);
      view.webContents.loadURL(next.targetUrl).catch((error) => {
        failProductNavigation(entry, {
          navigationRevision: next.navigationRevision,
          attemptedUrl: next.targetUrl,
          message: redact(error?.message || '页面加载失败'),
        });
      });
      return { action: 'deny' };
    }
    if (isDetailUrl(url)) {
      const targetKey = detailProductKey(url);
      const currentKey = detailProductKey(entry.stableUrl || entry.url || entry.pendingNavigation);
      if (entry.kind === 'detail' && (!entry.pageLoaded || (targetKey && currentKey && targetKey === currentKey))) {
        const next = beginProductNavigation(entry, url);
        view.webContents.loadURL(next.targetUrl).catch((error) => {
          failProductNavigation(entry, {
            navigationRevision: next.navigationRevision,
            attemptedUrl: next.targetUrl,
            message: redact(error?.message || '页面加载失败'),
          });
        });
      } else {
        requestProductTab(entry, url);
      }
      return { action: 'deny' };
    }
    if (!isDetailUrl(url)) {
      releaseProductNetworkCapture(entry);
      applyCommerceUserAgent(entry, url);
    }
    const next = beginProductNavigation(entry, url);
    view.webContents.loadURL(next.targetUrl).catch((error) => {
      failProductNavigation(entry, {
        navigationRevision: next.navigationRevision,
        attemptedUrl: next.targetUrl,
        message: redact(error?.message || '页面加载失败'),
      });
    });
    return { action: 'deny' };
  });
  view.webContents.on('will-frame-navigate', (event, url, isMainFrame) => {
    if (!isMainFrame && shouldRecover1688LoginLanding(entry, url)) {
      event.preventDefault();
      recover1688LoginLanding(entry);
      return;
    }
    if (isMainFrame || !shouldPromote1688Login(entry, url)) return;
    event.preventDefault();
    promote1688LoginToTopLevel(entry, url);
  });
  view.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) {
      if (shouldRecover1688LoginLanding(entry, url)) {
        event.preventDefault();
        recover1688LoginLanding(entry);
        return;
      }
      if (!shouldPromote1688Login(entry, url)) return;
      event.preventDefault();
      promote1688LoginToTopLevel(entry, url);
      return;
    }
    if (shouldRecover1688LoginLanding(entry, url)) {
      event.preventDefault();
      recover1688LoginLanding(entry);
      return;
    }
    if (!navigationHostAllowed(url)) {
      event.preventDefault();
      if (!entry.navigationTarget && !entry.pendingNavigation) {
        rejectProductNavigation(entry, url, '目标平台跳转到了不在白名单内的地址，已阻止加载');
      }
      return;
    }
    if (shouldPromote1688Login(entry, url)) {
      event.preventDefault();
      promote1688LoginToTopLevel(entry, url);
      return;
    }
    if (!navigationMatchesTarget(entry, url)) {
      event.preventDefault();
      if (!entry.navigationTarget && !entry.pendingNavigation) rejectProductNavigation(entry, url);
    }
  });
  view.webContents.on('will-navigate', (event, url) => {
    const normalized = normalizeNavigationUrl(url);
    if (shouldRecover1688LoginLanding(entry, normalized)) {
      event.preventDefault();
      recover1688LoginLanding(entry);
      return;
    }
    if (!navigationHostAllowed(url)) {
      event.preventDefault();
      if (!entry.navigationTarget && !entry.pendingNavigation) {
        rejectProductNavigation(entry, url, '目标平台跳转到了不在白名单内的地址，已阻止加载');
      }
      return;
    }
    // 1688 若把首页主框架重定向到统一登录页，也走同一个显式顶层登录
    // 路径，确保新的 navigationTarget 先建立，再允许登录页提交。
    if (is1688WebsiteUrl(entry.navigationTarget) && isLoginUrl(normalized)) {
      event.preventDefault();
      promote1688LoginToTopLevel(entry, normalized);
      return;
    }
    // 复用标签时上一个淘宝详情页可能正在结束导航。新的 1688 导航已经
    // 发起后，不能再让旧页提交并覆盖目标页面的生命周期状态。
    if (!navigationMatchesTarget(entry, normalized)) {
      event.preventDefault();
      if (!entry.navigationTarget && !entry.pendingNavigation) rejectProductNavigation(entry, normalized);
      return;
    }
    if (!isDetailUrl(normalized)) {
      // 站点标签不需要商品采集的 CDP 网络监听。尤其是抖音，不能让
      // 一个从旧商品页遗留的调试器继续参与登录页导航。
      releaseProductNetworkCapture(entry);
      applyCommerceUserAgent(entry, normalized);
    }
    // 后退/前进由 Electron 的 navigationHistory 发起。达比会让这类导航
    // 穿过普通的“不同商品开新标签”拦截逻辑，否则浏览器后退会被误判成新商品。
    if (entry.historyTraversal) { entry.networkCapture?.reset?.(); entry.pendingNavigation = ''; return; }
    if (entry.pendingNavigation && entry.pendingNavigation === normalized) { entry.networkCapture?.reset?.(); entry.pendingNavigation = ''; return; }
    if (isVerificationUrl(url)) {
      entry.networkCapture?.reset?.();
      entry.verification = true;
      entry.pendingNavigation = '';
      return;
    }
    // 新商品标签首次加载时允许淘宝自身的多次重定向；同一个商品追加追踪参数
    // 或回跳时也留在原标签。加载完成后，只有不同商品才创建新标签。
    const targetKey = detailProductKey(url);
    const currentKey = detailProductKey(entry.stableUrl || entry.url || entry.pendingNavigation);
    if (entry.kind === 'detail' && isDetailUrl(url) && (!entry.pageLoaded || (targetKey && currentKey && targetKey === currentKey))) {
      entry.networkCapture?.reset?.();
      entry.pendingNavigation = '';
      return;
    }
    if (isDetailUrl(url)) {
      event.preventDefault();
      requestProductTab(entry, url);
    }
  });
  view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace || !productEntryIsLive(entry) || navigationIsBlocked(entry)) return;
    const normalized = normalizeNavigationUrl(url);
    const target = normalizeNavigationUrl(entry.navigationTarget || entry.pendingNavigation || '');
    if (target && normalized === target) entry.navigationStartedRevision = Number(entry.navigationRevision || 0);
  });
  view.webContents.on('did-navigate', (_event, url) => {
    const normalized = normalizeNavigationUrl(url);
    if (!navigationEventMatchesCurrent(entry, normalized)) return;
    if (shouldRecover1688LoginLanding(entry, normalized)) {
      recover1688LoginLanding(entry);
      return;
    }
    if (!navigationMatchesTarget(entry, normalized)) {
      if (!entry.navigationTarget && !entry.pendingNavigation) rejectProductNavigation(entry, normalized);
      return;
    }
    if (entry.navigationTarget || entry.pendingNavigation) entry.navigationStartedRevision = Number(entry.navigationRevision || 0);
    if (!commitProductNavigation(entry, normalized)) return;
    entry.historyTraversal = false;
    const title = view.webContents.getTitle();
    if (entry.loginSite === '1688' && is1688WebsiteUrl(normalized)) entry.loginSite = '';
    entry.pageLoaded = false;
    entry.domReady = false;
    entry.verification = isVerificationUrl(normalized, title);
    refreshProductViewVisibility();
    if (entry.restoringNavigation && entry.restoreUrl === normalized) {
      entry.restoringNavigation = false;
      entry.restoreUrl = '';
      entry.pendingNavigation = '';
    }
    if (!entry.restoringNavigation && !entry.verification) entry.stableUrl = normalized;
    if (entry.id === activeProductTabId) productUrl = normalized;
    sendSurfaceState({ tabId: entry.id, url: normalized, title, verification: entry.verification });
  });
  view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    const normalized = normalizeNavigationUrl(url);
    if (!navigationEventMatchesCurrent(entry, normalized)) return;
    if (shouldRecover1688LoginLanding(entry, normalized)) {
      recover1688LoginLanding(entry);
      return;
    }
    if (!navigationMatchesTarget(entry, normalized)) {
      if (!entry.navigationTarget && !entry.pendingNavigation) rejectProductNavigation(entry, normalized);
      return;
    }
    if (entry.navigationTarget || entry.pendingNavigation) entry.navigationStartedRevision = Number(entry.navigationRevision || 0);
    if (!commitProductNavigation(entry, normalized)) return;
    const fromHistory = Boolean(entry.historyTraversal);
    entry.historyTraversal = false;
    const title = view.webContents.getTitle();
    const verification = isVerificationUrl(normalized, title);
    if (verification) {
      entry.verification = true;
      if (entry.id === activeProductTabId) productUrl = normalized;
      refreshProductViewVisibility();
      sendSurfaceState({ tabId: entry.id, url: normalized, title, verification: true });
      return;
    }
    const stableUrl = entry.stableUrl || entry.url;
    const nextKey = detailProductKey(normalized);
    const stableKey = detailProductKey(stableUrl);
    const changedDetail = isMainFrame && Boolean(nextKey) && (!stableKey || nextKey !== stableKey);
    const canOpenDetailTab = changedDetail && (entry.kind !== 'detail' || entry.pageLoaded);
    if (canOpenDetailTab && !entry.restoringNavigation && !fromHistory) {
      const now = Date.now();
      if (entry.lastInPageKey === nextKey && now - (entry.lastInPageAt || 0) < 10000) return;
      entry.lastInPageKey = nextKey;
      entry.lastInPageAt = now;
      requestProductTab(entry, normalized);
      if (stableUrl && stableUrl !== normalized) {
        entry.restoringNavigation = true;
        entry.restoreUrl = stableUrl;
        const restore = beginProductNavigation(entry, stableUrl);
        view.webContents.loadURL(restore.targetUrl).catch((error) => {
          if (!productNavigationIsCurrent(entry, restore.navigationRevision)) return;
          entry.restoringNavigation = false;
          entry.restoreUrl = '';
          failProductNavigation(entry, {
            navigationRevision: restore.navigationRevision,
            attemptedUrl: restore.targetUrl,
            message: redact(error?.message || '页面加载失败'),
          });
        });
      }
      return;
    }
    if (entry.loginSite === '1688' && is1688WebsiteUrl(normalized)) entry.loginSite = '';
    entry.verification = false;
    if (entry.restoringNavigation && entry.restoreUrl === normalized) {
      entry.restoringNavigation = false;
      entry.restoreUrl = '';
      entry.pendingNavigation = '';
    }
    if (!isDetailUrl(normalized) && !entry.restoringNavigation) entry.stableUrl = normalized;
    if (entry.id === activeProductTabId) productUrl = normalized;
    sendSurfaceState({ tabId: entry.id, url: normalized, title, verification: false });
  });
  view.webContents.on('dom-ready', () => {
    if (!productEntryIsLive(entry) || navigationIsBlocked(entry)) return;
    if ((entry.navigationTarget || entry.pendingNavigation)
      && Number(entry.navigationStartedRevision || 0) !== Number(entry.navigationRevision || 0)) return;
    const actualUrl = normalizeNavigationUrl(view.webContents.getURL());
    const current = committedNavigationUrl(entry, actualUrl);
    if (!current || (!entry.url && !entry.navigationTarget && !entry.pendingNavigation)) return;
    if (!navigationMatchesTarget(entry, current)) return;
    const committed = commitProductNavigation(entry, current);
    if (!committed && !entry.url) return;
    entry.domReady = true;
    refreshProductViewVisibility();
    sendSurfaceState({
      tabId: entry.id,
      url: committed || current,
      title: view.webContents.getTitle(),
      ready: false,
      loading: Boolean(entry.loading),
    });
  });
  view.webContents.on('did-finish-load', () => {
    if ((entry.navigationTarget || entry.pendingNavigation)
      && Number(entry.navigationStartedRevision || 0) !== Number(entry.navigationRevision || 0)) return;
    const actualUrl = normalizeNavigationUrl(view.webContents.getURL());
    if (shouldRecover1688LoginLanding(entry, actualUrl)) {
      recover1688LoginLanding(entry);
      return;
    }
    const current = committedNavigationUrl(entry, actualUrl);
    if (!current) return;
    if (!navigationMatchesTarget(entry, current)) {
      if (!entry.navigationTarget && !entry.pendingNavigation) rejectProductNavigation(entry, current);
      return;
    }
    entry.loading = false;
    entry.loadFailed = false;
    entry.domReady = true;
    entry.pageLoaded = true;
    const title = view.webContents.getTitle();
    entry.verification = isVerificationUrl(current, title);
    if (entry.loginSite === '1688' && is1688WebsiteUrl(current)) entry.loginSite = '';
    if (current) {
      commitProductNavigation(entry, current);
      if (!entry.verification) entry.stableUrl = current;
    }
    entry.requestedUrl = '';
    entry.pendingNavigation = '';
    entry.navigationTarget = '';
    refreshProductViewVisibility();
    if (entry.id === activeProductTabId) scheduleCommerceSurfaceResync();
    sendSurfaceState({ tabId: entry.id, url: current || entry.url, title, verification: entry.verification });
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || Number(errorCode) === -3) return;
    if (!productEntryIsLive(entry) || navigationIsBlocked(entry)) return;
    const failedUrl = normalizeNavigationUrl(validatedURL);
    if (shouldRecover1688LoginLanding(entry, failedUrl)) {
      recover1688LoginLanding(entry);
      return;
    }
    const target = normalizeNavigationUrl(entry.navigationTarget || entry.pendingNavigation || '');
    const failedCurrentTarget = Boolean(target && failedUrl === target);
    if (!failedCurrentTarget && !navigationEventMatchesCurrent(entry, failedUrl)) return;
    if (!failedCurrentTarget && !committedNavigationUrl(entry, failedUrl)) return;
    if (!navigationMatchesTarget(entry, failedUrl)) {
      if (!entry.navigationTarget && !entry.pendingNavigation) {
        rejectProductNavigation(entry, failedUrl, '页面跳转结果与当前标签不一致，已阻止旧页面覆盖');
      }
      return;
    }
    entry.historyTraversal = false;
    failProductNavigation(entry, {
      attemptedUrl: failedUrl,
      message: redact(errorDescription || `错误码 ${errorCode}`),
      errorCode,
    });
  });
  view.webContents.on('did-start-loading', () => {
    if (!productEntryIsLive(entry) || navigationIsBlocked(entry)) return;
    // did-start-loading itself has no URL. During a replacement navigation it
    // can belong to the document being replaced, so only accept it once the
    // current WebContents URL belongs to the active target.
    if ((entry.navigationTarget || entry.pendingNavigation) && !committedNavigationUrl(entry)) return;
    entry.loading = true;
    entry.domReady = false;
    entry.pageLoaded = false;
    entry.loadFailed = false;
    refreshProductViewVisibility();
    sendSurfaceState({ tabId: entry.id });
  });
  view.webContents.on('did-stop-loading', () => {
    if ((entry.navigationTarget || entry.pendingNavigation)
      && Number(entry.navigationStartedRevision || 0) !== Number(entry.navigationRevision || 0)) return;
    const current = committedNavigationUrl(entry);
    // A late stop event from the previous document must not publish its title
    // or visibility state for the target currently being opened.
    if (!current) return;
    entry.loading = false;
    // 少数淘宝登录跳转会在顶层文档完成后继续交换子资源，Windows 上偶发
    // 没有把 did-finish-load 回调到 WebContentsView。若仍继续把视图当作
    // “未加载”隐藏，商品区域会永久空白。did-stop-loading 已表示当前主导航
    // 停止；仅对仍匹配当前标签、且没有收到失败事件的页面补齐可见状态。
    if (!entry.pageLoaded && !entry.loadFailed) {
      entry.domReady = true;
      entry.pageLoaded = true;
      const title = view.webContents.getTitle();
      entry.verification = isVerificationUrl(current, title);
      commitProductNavigation(entry, current);
      if (!entry.verification) entry.stableUrl = current;
      entry.requestedUrl = '';
      entry.pendingNavigation = '';
      entry.navigationTarget = '';
      refreshProductViewVisibility();
    }
    sendSurfaceState({ tabId: entry.id });
  });
  view.webContents.on('page-title-updated', (_event, title) => {
    const current = committedNavigationUrl(entry);
    if (!current) return;
    if (isVerificationUrl(current, title)) {
      entry.verification = true;
      refreshProductViewVisibility();
    }
    sendSurfaceState({ tabId: entry.id, title });
  });
}

function disposeProductView(entry) {
  if (!entry) return;
  clearProductNavigationRetry(entry);
  releaseProductNetworkCapture(entry);
  setProductViewVisibilityState(entry, false);
  try { mainWindow?.contentView?.removeChildView(entry.view); } catch {}
  try { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.destroy(); } catch {}
}

function ensureProductView(tabId = 'commerce-default', options = {}) {
  const id = String(tabId || 'commerce-default');
  const existing = productViews.get(id);
  const hasPartitionHint = Boolean(options && (options.partition || options.kind || options.site || options.url));
  const requestedPartition = hasPartitionHint
    ? String(options.partition || commerceSessionPartition(options.kind, options.site, options.url))
    : existing?.partition || TAOBAO_SESSION_PARTITION;
  if (existing && existing.partition === requestedPartition) return existing;
  if (existing) {
    if (existing.id === activeProductTabId) productView = null;
    disposeProductView(existing);
    productViews.delete(id);
  }
  const view = new WebContentsView({ webPreferences: { partition: requestedPartition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try { view.webContents.setBackgroundThrottling(false); } catch {}
  const entry = { id, view, partition: requestedPartition, defaultUserAgent: String(view.webContents.getUserAgent?.() || ''), url: '', requestedUrl: '', stableUrl: '', pendingNavigation: '', navigationTarget: '', navigationSourceUrl: '', navigationRevision: 0, committedNavigationRevision: 0, blockedNavigationRevision: 0, navigationStartedRevision: 0, navigationRetryCount: 0, navigationRetryTimer: null, retryingNavigation: false, restoreUrl: '', restoringNavigation: false, historyTraversal: false, loading: false, loadFailed: false, kind: 'home', loginSite: '', recovering1688Login: false, pageLoaded: false, domReady: false, verification: false, visible: false, lastRequestedKey: '', lastRequestedAt: 0, lastInPageKey: '', lastInPageAt: 0, networkCapture: null, promoting1688Login: false };
  productViews.set(id, entry);
  mainWindow.contentView.addChildView(view);
  setProductViewVisibilityState(entry, false);
  attachProductView(entry);
  return entry;
}

function activateProductView(tabId, options = {}) {
  const entry = ensureProductView(tabId, options);
  if (options?.kind) entry.kind = String(options.kind);
  activeProductTabId = entry.id;
  productView = entry.view;
  hideProductViews();
  refreshProductViewVisibility();
  if (lastSurfaceBounds) updateViewBounds(lastSurfaceBounds, entry.id);
  return entry;
}

async function loadProduct(url, tabId = 'commerce-default', kind = '') {
  const requestedEntryUrl = preferAmazonChineseUrl(desktop1688EntryUrl(url));
  if (!navigationHostAllowed(requestedEntryUrl)) throw new Error('官方页面域名不在白名单内');
  const requestedUrl = normalizeNavigationUrl(requestedEntryUrl);
  const requestedKind = kind || (isDetailUrl(requestedUrl) ? 'detail' : 'home');
  const entry = activateProductView(tabId, { kind: requestedKind, url: requestedUrl });
  const requested1688Login = requestedKind === 'login'
    && (is1688LoginTarget(requestedUrl) || is1688WebsiteUrl(requestedUrl));
  entry.kind = requestedKind;
  entry.loginSite = requested1688Login ? '1688' : '';
  entry.recovering1688Login = false;
  applyCommerceUserAgent(entry, requestedUrl);
  if (isDetailUrl(requestedUrl)) ensureProductNetworkCapture(entry);
  else releaseProductNetworkCapture(entry);
  entry.historyTraversal = false;
  entry.restoringNavigation = false;
  entry.restoreUrl = '';
  // Keep the committed document URL separate from the requested target. The
  // renderer may show loading state for requestedUrl, but the address remains
  // tied to entry.url until Chromium commits a matching main-frame URL.
  const { navigationRevision } = beginProductNavigation(entry, requestedUrl);
  if (isAmazonUrl(requestedUrl)) {
    await primeAmazonChineseLocale(entry, requestedUrl);
    if (!productNavigationIsCurrent(entry, navigationRevision)) {
      return { ok: false, stale: true, url: entry.url || '', tabId: entry.id };
    }
  }
  // WebContentsView 在首次导航前可能还没有渲染进程。此时等待
  // Network.enable 会一直挂起，导致下面的 loadURL 永远不会执行，
  // 最终表现为“地址栏已切换但淘宝区域一片空白”。网络采集器会在
  // 页面启动后继续完成初始化，真正采集时再等待 ready 即可。
  if (!productNavigationIsCurrent(entry, navigationRevision)) {
    return { ok: false, stale: true, url: entry.url || '', tabId: entry.id };
  }
  try {
    await entry.view.webContents.loadURL(requestedUrl);
  } catch (error) {
    if (!productNavigationIsCurrent(entry, navigationRevision)) {
      return { ok: false, stale: true, url: entry.url || '', tabId: entry.id };
    }
    const outcome = failProductNavigation(entry, {
      navigationRevision,
      attemptedUrl: requestedUrl,
      message: redact(error?.message || '页面加载失败'),
    });
    if (outcome === 'retrying') {
      return { ok: false, retrying: true, url: entry.url || '', tabId: entry.id };
    }
    throw error;
  }
  if (!productNavigationIsCurrent(entry, navigationRevision)) {
    return { ok: false, stale: true, url: entry.url || '', tabId: entry.id };
  }
  const actualFinalUrl = normalizeNavigationUrl(entry.view.webContents.getURL());
  if (shouldRecover1688LoginLanding(entry, actualFinalUrl)) {
    recover1688LoginLanding(entry);
    return { ok: false, recovered: true, url: actualFinalUrl, tabId: entry.id };
  }
  const finalUrl = committedNavigationUrl(entry, actualFinalUrl);
  if (!finalUrl || !navigationMatchesTarget(entry, finalUrl)) {
    failProductNavigation(entry, {
      navigationRevision,
      attemptedUrl: actualFinalUrl || requestedUrl,
      message: '页面没有进入请求的官方站点，已阻止旧页面显示',
    });
    return { ok: false, mismatch: true, url: entry.url || '', tabId: entry.id };
  }
  entry.navigationStartedRevision = navigationRevision;
  entry.pendingNavigation = '';
  entry.navigationTarget = '';
  if (entry.loginSite === '1688' && is1688WebsiteUrl(finalUrl)) entry.loginSite = '';
  commitProductNavigation(entry, finalUrl);
  entry.requestedUrl = '';
  if (!entry.verification) entry.stableUrl = finalUrl;
  if (entry.id === activeProductTabId) productUrl = finalUrl;
  await syncCommercePageActiveFromRenderer();
  if (!productNavigationIsCurrent(entry, navigationRevision)) {
    return { ok: false, stale: true, url: entry.url || '', tabId: entry.id };
  }
  refreshProductViewVisibility();
  if (lastSurfaceBounds) updateViewBounds(lastSurfaceBounds, entry.id);
  scheduleCommerceSurfaceResync();
  sendSurfaceState({ tabId: entry.id, url: finalUrl, title: entry.view.webContents.getTitle(), verification: entry.verification });
  return { ok: true, url: finalUrl, tabId: entry.id, verification: entry.verification };
}

function navigateProductHistory(direction, tabId = '') {
  const entry = productEntryForTab(tabId);
  const webContents = entry?.view?.webContents;
  const navigationHistory = webContents?.navigationHistory;
  if (!entry || !webContents || webContents.isDestroyed()) return { ok: false, message: '当前没有可用的商品标签页' };
  const isBack = direction === 'back';
  let available = false;
  try {
    const historyMethod = isBack ? navigationHistory?.canGoBack : navigationHistory?.canGoForward;
    if (typeof historyMethod === 'function') available = Boolean(historyMethod.call(navigationHistory));
    const legacyMethod = isBack ? webContents.canGoBack : webContents.canGoForward;
    if (!available && typeof legacyMethod === 'function') available = Boolean(legacyMethod.call(webContents));
  } catch {}
  if (!available) return { ok: false, message: isBack ? '已经是最早页面' : '已经是最新页面' };
  try {
    entry.historyTraversal = true;
    entry.loading = true;
    const historyMethod = isBack ? navigationHistory?.goBack : navigationHistory?.goForward;
    const legacyMethod = isBack ? webContents.goBack : webContents.goForward;
    if (typeof historyMethod === 'function') historyMethod.call(navigationHistory);
    else if (typeof legacyMethod === 'function') legacyMethod.call(webContents);
    else throw new Error('当前 Electron 不支持浏览历史操作');
    sendSurfaceState({ tabId: entry.id });
    // History traversal updates asynchronously. Refresh once after Chromium
    // has committed the history entry so the toolbar cannot stay disabled
    // with the pre-navigation state.
    setTimeout(() => {
      if (productViews.get(entry.id) === entry && !webContents.isDestroyed()) sendSurfaceState({ tabId: entry.id });
    }, 120);
    return { ok: true, tabId: entry.id };
  } catch (error) {
    entry.historyTraversal = false;
    entry.loading = false;
    return { ok: false, message: error.message || '浏览历史操作失败' };
  }
}

function reloadProduct(tabId = '', options = {}) {
  const entry = productEntryForTab(tabId);
  const webContents = entry?.view?.webContents;
  if (!entry || !webContents || webContents.isDestroyed()) return { ok: false, message: '当前没有可刷新的商品标签页' };
  const currentUrl = normalizeNavigationUrl(
    webContents.getURL?.() || entry.url || entry.stableUrl || productUrl,
  );
  if (!currentUrl || currentUrl === 'about:blank' || !navigationHostAllowed(currentUrl)) {
    return { ok: false, message: '当前标签页没有可刷新的官方页面' };
  }
  const wasVerification = Boolean(entry.verification);
  entry.historyTraversal = false;
  const { targetUrl, navigationRevision } = beginProductNavigation(entry, currentUrl);
  applyCommerceUserAgent(entry, targetUrl);
  if (isDetailUrl(targetUrl)) ensureProductNetworkCapture(entry);
  else releaseProductNetworkCapture(entry);
  if (!wasVerification) entry.stableUrl = targetUrl;
  if (entry.id === activeProductTabId) productUrl = targetUrl;
  try { entry.networkCapture?.reset?.(); } catch {}
  try {
    const reloadMethod = options?.hard ? webContents.reloadIgnoringCache : webContents.reload;
    if (typeof reloadMethod === 'function') reloadMethod.call(webContents);
    else {
      webContents.loadURL(targetUrl).catch((error) => {
        failProductNavigation(entry, {
          navigationRevision,
          attemptedUrl: targetUrl,
          message: redact(error?.message || '刷新页面失败'),
        });
      });
    }
    sendSurfaceState({
      tabId: entry.id,
      ready: false,
      loading: true,
      title: webContents.getTitle?.() || '',
    });
    return { ok: true, tabId: entry.id, url: targetUrl, hard: Boolean(options?.hard) };
  } catch (error) {
    failProductNavigation(entry, {
      navigationRevision,
      attemptedUrl: targetUrl,
      message: redact(error?.message || '刷新页面失败'),
    });
    return { ok: false, message: error.message || '刷新页面失败' };
  }
}

function stopProduct(tabId = '') {
  const entry = productEntryForTab(tabId);
  const webContents = entry?.view?.webContents;
  if (!entry || !webContents || webContents.isDestroyed()) return { ok: false, message: '当前没有正在加载的商品页面' };
  try { webContents.stop(); } catch {}
  entry.loading = false;
  entry.historyTraversal = false;
  sendSurfaceState({ tabId: entry.id });
  return { ok: true, tabId: entry.id };
}

function changeProductZoom(action, tabId = '') {
  const entry = productEntryForTab(tabId);
  const webContents = entry?.view?.webContents;
  if (!entry || !webContents || webContents.isDestroyed()) return { ok: false, message: '当前没有可缩放的商品页面' };
  const levels = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
  let current = Math.round(Number(webContents.getZoomFactor?.() || 1) * 100);
  if (action === 'reset') current = 100;
  else if (action === 'in') current = levels.find((level) => level > current) || levels[levels.length - 1];
  else if (action === 'out') current = [...levels].reverse().find((level) => level < current) || levels[0];
  else current = Math.max(levels[0], Math.min(levels[levels.length - 1], current));
  try { webContents.setZoomFactor(current / 100); } catch (error) { return { ok: false, message: error.message || '缩放页面失败' }; }
  sendSurfaceState({ tabId: entry.id, zoom: current });
  return { ok: true, tabId: entry.id, zoom: current };
}

function closeProductTab(tabId = '') {
  const id = String(tabId || '').trim();
  if (!id || id === 'commerce-default') return { ok: false, message: '默认商品标签不能关闭' };
  const entry = productViews.get(id);
  if (!entry) return { ok: true, tabId: id, closed: false };
  const wasActive = activeProductTabId === id;
  disposeProductView(entry);
  productViews.delete(id);
  if (wasActive) {
    const next = [...productViews.values()][0] || null;
    activeProductTabId = next?.id || 'commerce-default';
    productView = next?.view || productViews.get('commerce-default')?.view || null;
    // The renderer may switch back to the analysis tab immediately after
    // closing the last product tab. Do not let the old global URL leak into
    // the follow-up surface-state event, otherwise the renderer treats it as
    // a newly opened product tab with an empty WebContentsView.
    productUrl = next?.url || '';
    refreshProductViewVisibility();
    sendSurfaceState({
      tabId: next?.id || activeProductTabId,
      url: next?.url || '',
      title: next?.view?.webContents?.getTitle?.() || '',
      ready: Boolean(next?.pageLoaded),
      loading: Boolean(next?.loading),
    });
  }
  return { ok: true, tabId: id, closed: true };
}

async function loadSeller(site, tabId = 'commerce-default') {
  const urls = { qianniu: 'https://myseller.taobao.com/', seller: 'https://myseller.taobao.com/', sycm: 'https://sycm.taobao.com/' };
  const url = urls[String(site || '').toLowerCase()] || urls.qianniu;
  return loadProduct(url, tabId, 'seller');
}

function commerceLoginUrl(site, tabId = '', requestedReturnUrl = '') {
  const siteKey = String(site || '').trim().toLowerCase();
  if (siteKey !== '1688') return 'https://login.taobao.com/';
  const entry = productEntryForTab(tabId);
  // 登录标签是新建的，不能只从它自己的 URL 推导 Done；否则登录成功后
  // 总会回到首页，用户还得手动回到刚才要求登录的商品页。只接受 1688
  // 官方页面作为回跳目标，既保留当前商品，也不把登录跳转开放给其它站点。
  const returnUrl = [requestedReturnUrl, entry?.restoreUrl, entry?.requestedUrl, entry?.stableUrl, entry?.url, productUrl]
    .map((value) => normalizeNavigationUrl(desktop1688EntryUrl(value)))
    .find((value) => value
      && value !== 'about:blank'
      && is1688WebsiteUrl(value))
    || 'https://www.1688.com/';
  // 1688 首页的“登录”实际进入 login.1688.com 的 B2B 登录页，
  // 不是淘宝通用的 /havanaone 页面。后者在内嵌 Electron 页面中常被
  // 返回淘宝错误页，表现为地址栏是 1688、内容却是淘宝。
  const params = new URLSearchParams({
    from: 'sm',
    banThirdPartyCookie: 'true',
    cbuAdd: 'true',
    redirectType: 'topRedirect',
    Done: returnUrl,
  });
  return `https://login.1688.com/member/signin.htm?${params.toString()}`;
}

function sessionStatus(tabId = activeProductTabId) {
  const requestedTabId = String(tabId || activeProductTabId || '').trim();
  const entry = requestedTabId ? productViews.get(requestedTabId) || null : null;
  const current = entry?.view?.webContents?.getURL?.() || '';
  let parsed;
  try { parsed = new URL(current); } catch { parsed = null; }
  const host = parsed?.hostname?.toLowerCase() || '';
  const title = redact(entry?.view?.webContents?.getTitle?.() || '');
  const loginPage = isLoginUrl(current);
  const verification = isVerificationUrl(current, title);
  const site = surfaceSite(entry, current);
  const profile = commerceSessionProfile(entry?.partition, site);
  return {
    ok: true,
    backend: 'electron',
    state: !host ? 'not_started' : loginPage ? 'login_page_open' : verification ? 'verification_required' : 'browser_connected',
    host,
    site,
    title,
    visible: isProductViewVisible(entry),
    tabId: entry?.id || String(tabId || ''),
    profile: profile.id,
    profileLabel: profile.label,
    verification,
    message: verification ? `当前是${profile.label}中的官方验证页面，请手动完成验证。` : '',
  };
}

async function clearCommerceSession() {
  const commercePartitions = [TAOBAO_SESSION_PARTITION, SESSION_1688_PARTITION];
  await Promise.all(commercePartitions.map(async (partition) => {
    const commerceSession = session.fromPartition(partition);
    await commerceSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    await commerceSession.clearCache().catch(() => {});
  }));
  productUrl = '';
  const commerceEntries = [...productViews.values()].filter((entry) => commercePartitions.includes(entry.partition));
  for (const entry of commerceEntries) {
    entry.navigationRevision = Number(entry.navigationRevision || 0) + 1;
    entry.blockedNavigationRevision = Number(entry.navigationRevision || 0);
    entry.navigationStartedRevision = 0;
    entry.navigationSourceUrl = '';
    entry.requestedUrl = '';
    entry.pendingNavigation = '';
    entry.navigationTarget = '';
  }
  await Promise.all(commerceEntries.map((entry) => entry.view.webContents.loadURL('about:blank').catch(() => {})));
  for (const entry of commerceEntries) {
    clearProductNavigationRetry(entry);
    entry.url = ''; entry.requestedUrl = ''; entry.stableUrl = ''; entry.pendingNavigation = ''; entry.navigationTarget = ''; entry.restoreUrl = '';
    entry.restoringNavigation = false; entry.loginSite = ''; entry.recovering1688Login = false;
    entry.pageLoaded = false; entry.domReady = false; entry.loading = false; entry.loadFailed = false; entry.verification = false; setProductViewVisibilityState(entry, false);
  }
  if (commercePartitions.includes(activeProductEntry()?.partition)) sendSurfaceState({ url: '', title: '', site: '淘宝/1688' });
  return {
    ...sessionStatus(),
    state: 'cleared',
    clearedProfile: 'taobao-1688',
    message: '已清除淘宝/1688独立会话，不会影响千牛工作台公司账号',
  };
}

async function executeSafePageAction(raw) {
  const action = safeAgentAction(raw);
  const entry = activeProductEntry();
  const webContents = entry?.view?.webContents || productView?.webContents;
  if (!webContents) return { ok: false, action, message: '内嵌商品页面尚未打开' };
  const current = webContents.getURL();
  if (!hostAllowed(current)) return { ok: false, action, message: '当前页面不在网页智能体白名单内' };
  if (action.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(100, action.amount))));
    return { ok: true, action, page_context: { url: current, state: 'waited' } };
  }
  if (action.action === 'finish') return { ok: true, action, done: true, page_context: { url: current, state: 'finished' } };
  if (action.action === 'extract') {
    const snapshot = await captureProduct({ deep: false });
    return { ok: Boolean(snapshot?.ok), action, snapshot, page_context: { url: current, title: snapshot?.product?.title || '' } };
  }
  const target = JSON.stringify(action.target || '');
  const result = await webContents.executeJavaScript(`(() => {
    const action = ${JSON.stringify(action.action)};
    const wanted = ${target};
    const visible = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const tidy = (value, limit = 220) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    const controls = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],[class*="tab"],[class*="Tab"],li,span')]
      .filter(visible)
      .map((node) => ({ node, text: tidy(node.innerText || node.textContent || '') }))
      .filter((item) => item.text && item.text.length <= 60 && (item.text === wanted || item.text.includes(wanted)));
    if (action === 'scroll') {
      const delta = ${JSON.stringify(action.amount)} * (${JSON.stringify(action.direction)} === 'up' ? -1 : 1);
      window.scrollBy(0, delta);
      const scrollables = [...document.querySelectorAll('*')].filter((node) => { const style = getComputedStyle(node); return visible(node) && /(auto|scroll)/.test(style.overflowY || '') && node.scrollHeight > node.clientHeight + 40; }).slice(0, 12);
      for (const node of scrollables) node.scrollTop = Math.max(0, Math.min(node.scrollHeight, node.scrollTop + delta));
      return { ok: true, changed: true, scrollY: window.scrollY, bodyHeight: document.body?.scrollHeight || 0 };
    }
    if (action === 'click_tab' || action === 'expand' || action === 'paginate') {
      const sorted = controls.sort((a, b) => (a.text === wanted ? -1 : 1) - (b.text === wanted ? -1 : 1) || a.text.length - b.text.length);
      const item = sorted[0];
      if (!item) return { ok: false, changed: false, reason: '未找到当前可见控件' };
      item.node.scrollIntoView({ block: 'center', inline: 'nearest' });
      item.node.click();
      return { ok: true, changed: true, clicked: item.text };
    }
    if (action === 'inspect') {
      const buttons = controls.slice(0, 80).map((item) => item.text);
      const videos = [...document.querySelectorAll('video,video source,[data-video],[data-video-url]')].filter(visible).length;
      return { ok: true, title: tidy(document.title, 300), body: tidy(document.body?.innerText || '', 12000), controls: [...new Set(buttons)], imageCount: document.images.length, videoCount: videos, url: location.href };
    }
    return { ok: false, changed: false, reason: '动作未实现' };
  })()`, true);
  await new Promise((resolve) => setTimeout(resolve, action.action === 'scroll' ? 250 : 700));
  const clean = { ...(result || {}), url: current, action };
  if (clean.body) clean.body = redact(clean.body);
  if (clean.title) clean.title = redact(clean.title);
  return { ok: Boolean(clean.ok), action, page_context: clean, message: clean.reason || '' };
}

async function captureMerchantReport(kind = 'operations') {
  const entry = activeProductEntry();
  const webContents = entry?.view?.webContents || productView?.webContents;
  if (!webContents) return { ok: false, message: '桌面商品页面尚未打开' };
  const current = webContents.getURL();
  if (!hostAllowed(current, true)) return { ok: false, message: '请先打开千牛或生意参谋白名单页面' };
  const payload = await webContents.executeJavaScript(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const r = node.getBoundingClientRect();
      const s = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const text = (node) => String(node?.innerText || '').replace(/\\s+/g, ' ').trim();
    const labels = [...document.querySelectorAll('h1,h2,h3,[class*="metric"],[class*="Metric"],[class*="data"],[class*="Data"],[class*="number"],[class*="Number"]')]
      .filter(visible).slice(0, 140).map(text).filter(Boolean);
    const tables = [...document.querySelectorAll('table')].filter(visible).slice(0, 80).map((table) => ({
      caption: text(table.querySelector('caption')),
      rows: [...table.querySelectorAll('tr')].slice(0, 400).map((row) => [...row.querySelectorAll('th,td')].slice(0, 80).map(text)).filter((row) => row.some(Boolean)),
    })).filter((table) => table.rows.length);
    return {
      title: document.title || '',
      url: location.href,
      text: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24000),
      metrics: labels.slice(0, 80),
      tables,
    };
  })()`, true);
  const safeTables = Array.isArray(payload?.tables) ? payload.tables.slice(0, 80).map((table) => ({
    caption: redact(table?.caption || ''),
    rows: Array.isArray(table?.rows) ? table.rows.slice(0, 400).map((row) => Array.isArray(row) ? row.slice(0, 80).map(redact) : []).filter((row) => row.length) : [],
  })).filter((table) => table.rows.length) : [];
  return {
    ok: true,
    kind: String(kind || 'operations'),
    source: current.includes('sycm') ? 'sycm' : 'qianniu',
    backend: 'electron-visible-dom',
    session_id: entry?.partition || '',
    tab_id: String(webContents.id),
    ...payload,
    text: redact(payload?.text),
    title: redact(payload?.title),
    metrics: Array.isArray(payload?.metrics) ? payload.metrics.map(redact).slice(0, 80) : [],
    tables: safeTables,
  };
}

async function captureOperations() {
  return captureMerchantReport('operations');
}

async function importMerchantReport(kind = 'operations') {
  if (!mainWindow) return { ok: false, message: '桌面窗口尚未打开' };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: String(kind || 'operations') === 'audience' ? '导入官方人群结构 CSV' : '导入官方运营数据 CSV',
    properties: ['openFile'],
    filters: [{ name: '官方报表 CSV', extensions: ['csv', 'txt'] }, { name: 'JSON 数据', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true, message: '已取消选择文件' };
  const filePath = picked.filePaths[0];
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2_000_000) return { ok: false, message: '官方报表文件需小于 2 MB' };
    const entry = activeProductEntry();
    const webContents = entry?.view?.webContents || productView?.webContents;
    const current = webContents?.getURL?.() || '';
    const text = fs.readFileSync(filePath, 'utf8');
    return {
      ok: true,
      kind: String(kind || 'operations'),
      source: 'official-export',
      backend: 'electron-file',
      session_id: entry?.partition || '',
      tab_id: webContents ? String(webContents.id) : '',
      url: current,
      title: redact(webContents?.getTitle?.() || ''),
      file_name: path.basename(filePath),
      text: redact(text, 2_000_000),
      metrics: {},
      tables: [],
    };
  } catch (error) {
    return { ok: false, message: `读取官方报表失败：${redact(error?.message || error)}` };
  }
}

async function captureProduct(options = {}) {
  const requestedTabId = String(options?.tabId || '').trim();
  const entry = requestedTabId ? productViews.get(requestedTabId) : activeProductEntry();
  if (requestedTabId && !entry) return { ok: false, status: 'tab_not_found', message: '当前商品标签页不存在或已关闭' };
  const webContents = entry?.view?.webContents || productView?.webContents;
  if (!webContents) return { ok: false, message: '桌面商品页面尚未打开' };
  const current = webContents.getURL();
  if (!hostAllowed(current)) return { ok: false, message: '当前页面不是允许的商品页' };
  if (isLoginUrl(current)) return { ok: false, status: 'login_required', message: `当前仍在${safeSite(current)}官方登录页，请完成登录后再采集商品` };
  if (isVerificationUrl(current, webContents.getTitle())) return { ok: false, status: 'verification_required', message: `当前是${safeSite(current)}官方验证页面，请手动完成验证后再采集商品` };
  if (activeDabiCollections.has(webContents.id)) return { ok: false, status: 'running', message: '桌面智能体正在操作，请等待当前采集完成' };
  const collectionToken = { cancelled: false, stopMessage: '' };
  activeDabiCollections.set(webContents.id, collectionToken);
  const requestedModule = String(options?.module || '').trim();
  const combinedReviewsAndQuestions = requestedModule === 'reviews_questions';
  const baseModules = ['images', 'detail', 'sku', 'videos'];
  const baseOnly = !requestedModule || requestedModule === 'base';
  const interactionMode = INTERACTIVE_DABI_MODULES.has(requestedModule) ? 'visible' : 'passive';
  const collectionTrigger = String(options?.trigger || (baseOnly ? 'auto_open' : 'resource_click')).trim() || 'resource_click';
  const modulesToCollect = combinedReviewsAndQuestions
    ? ['reviews', 'questions']
    : ['reviews', 'questions'].includes(requestedModule)
      ? [requestedModule]
      : [];
  // 基础采集只读取商品页初始化状态和可见基础内容；用户点击评价/问大家
  // 资源卡后，才由达比式可见操作链截图识别固定目标，使用 CDP 鼠标点击/滚轮
  // 打开目标模块并监听对应 mtop 响应。只读操作不触碰登录凭据、订单、购物车或商品编辑控件。
  const collection = {
    ok: true,
    actions: [],
    mode: 'dabi-network',
    source: 'electron-dabi-network',
    fastMode: true,
    modules: {},
    agent: interactionMode === 'visible' ? 'cdp-screenshot-mouse-keyboard' : 'none',
    interactionMode,
    trigger: collectionTrigger,
    requestedModule,
    tabId: entry?.id || activeProductTabId,
  };
  sendCollectionProgress(entry, {
    status: 'running',
    action: 'start',
    module: requestedModule || 'base',
    interactionMode,
    trigger: collectionTrigger,
    message: baseOnly
      ? '正在自动读取商品信息、主图、详情、SKU 和视频；评价和问大家仅保留数量…'
      : interactionMode === 'visible'
        ? combinedReviewsAndQuestions
          ? '已启动桌面智能体，准备采集评价和问大家…'
          : requestedModule === 'questions'
            ? '已启动桌面智能体，准备采集问大家…'
            : '已启动桌面智能体，准备采集评价…'
        : baseModules.includes(requestedModule)
          ? `正在读取${({ images: '主图', detail: '详情页图文', sku: 'SKU', videos: '视频' })[requestedModule]}…`
          : '正在读取商品基础信息…',
  });
  // 商品详情标签在 loadProduct() 导航前就会启动持续 Network 监听，因此首屏
  // 返回的 detail.getdesc 也能被保留下来。兼容没有标签对象的旧调用时，才
  // 创建一次性监听器；普通抖音/小红书等站点不会在打开时附着 CDP 调试器。
  let networkCapture = entry?.networkCapture || null;
  let ownsNetworkCapture = false;
  if (!networkCapture && entry) networkCapture = ensureProductNetworkCapture(entry);
  if (!networkCapture) {
    networkCapture = createDabiNetworkCapture(webContents);
    ownsNetworkCapture = true;
  }
  const captureStartCounts = Object.fromEntries(
    Object.entries(networkCapture.records || {}).map(([key, values]) => [key, Array.isArray(values) ? values.length : 0]),
  );
  collectionToken.cleanup = ownsNetworkCapture
    ? () => networkCapture.dispose().catch(() => {})
    : () => Promise.resolve();
  await networkCapture.ready.catch(() => null);
  // 只有评价/问大家正文采集需要可见鼠标键盘操作。打开商品页的基础读取
  // 只使用页面状态、DOM 和网络响应，不创建可视化 Agent，也不显示遮罩。
  let visibleAgent = null;
  if (interactionMode === 'visible') {
    // 先完成 CDP 调试器初始化，再创建可见操作 Agent，避免两个初始化协程
    // 同时 attach 同一个 WebContents，导致偶发丢失 Network 响应监听。
    visibleAgent = createDabiVisibleAgent(webContents, {
      isBackgrounded: () => {
        try {
          return Boolean(
            !mainWindow
            || mainWindow.isDestroyed()
            || !mainWindow.isVisible()
            || mainWindow.isMinimized()
            || !mainWindow.isFocused()
          );
        } catch {
          return true;
        }
      },
    });
    await visibleAgent.ready.catch(() => null);
  }
  let dabiState = {};
  try {
    dabiState = await webContents.executeJavaScript(ELECTRON_DABI_PRODUCT_STATE_SCRIPT, true) || {};
  } catch {
    // 淘宝旧模板可能没有页面初始化状态，继续使用同一次可见 DOM 读取。
  }
  let payload = {
    original_url: current,
    final_url: current,
    rawText: '',
    product: {},
    reviewStats: {},
    questionStats: {},
    mainImages: [],
    images: [],
    videos: [],
    reviews: [],
    questions: [],
    detail: { text: '', images: [] },
  };
  try {
    payload = await webContents.executeJavaScript(String.raw`(() => {
      // 商品基础字段来自页面初始化状态和下方的单次可见读取；评价/问大家
      // 正文只允许由达笔触发的 mtop 响应提供，不保留旧版 body 扫描兜底。
    const visible = (node) => { if (!node) return false; const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
     const tidy = (value, limit = 6000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
     const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return ''; } };
     const markerOf = (node) => { const values = []; let current = node; for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) values.push(String(current.id || '') + ' ' + String(current.className || '') + ' ' + String(current.getAttribute?.('aria-label') || '')); return values.join(' '); };
     const imageEntries = [...document.querySelectorAll('img')].filter(visible).map((node, index) => { const rect = node.getBoundingClientRect(); return { node, index, url: absolute(node.dataset?.src || node.dataset?.original || node.currentSrc || node.src || ''), marker: markerOf(node), width: Number(node.naturalWidth || node.width || 0), height: Number(node.naturalHeight || node.height || 0), renderedWidth: Number(rect.width || 0), renderedHeight: Number(rect.height || 0), top: Number(rect.top || 0), bottom: Number(rect.bottom || 0), left: Number(rect.left || 0), right: Number(rect.right || 0) }; });
     const usable = (entry) => { const value = String(entry.url || '') + ' ' + String(entry.marker || ''); if (!/^https?:/i.test(entry.url) || /(?:avatar|headimg|favicon|logo|icon|qrcode|qr-code|loading|placeholder|recommend|guess|review|comment)/i.test(value)) return false; if (/(?:^|\/)tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\//i.test(entry.url)) return false; if (entry.width && entry.height && (entry.width < 160 || entry.height < 160)) return false; const small = entry.url.match(/(?:tps[-_](\d+)[x-](\d+)|[-_](\d{2,4})[-x](\d{2,4})(?:\.(?:png|jpe?g|webp))(?:[_?]|$))/i); if (small && ((Number(small[1] || small[3]) || 0) < 160 || (Number(small[2] || small[4]) || 0) < 160)) return false; if (/(?:^|[_-])\d{2,4}x\d{2,4}q30(?:[._?-]|$)/i.test(entry.url)) return false; return true; };
     const usableEntries = imageEntries.filter(usable);
     const hero = usableEntries.filter((entry) => entry.renderedWidth >= 180 && entry.renderedHeight >= 180).sort((left, right) => right.renderedWidth * right.renderedHeight - left.renderedWidth * left.renderedHeight)[0];
     const gallery = hero ? usableEntries.filter((entry) => { const verticalPad = Math.max(28, Math.min(82, hero.renderedHeight * 0.14)); const horizontalPad = Math.max(260, hero.renderedWidth * 1.2); return entry.top >= hero.top - verticalPad && entry.bottom <= hero.bottom + verticalPad && entry.left >= hero.left - horizontalPad && entry.right <= hero.right + Math.max(36, hero.renderedWidth * 0.16); }).sort((left, right) => left.index - right.index) : usableEntries.filter((entry) => /gallery|thumbnail|thumb|carousel|swiper|pic(?:ture)?viewer|mainpic|main-pic|商品图|主图|缩略/i.test(entry.marker));
     const images = [...new Set(gallery.map((entry) => entry.url).filter(Boolean))].slice(0, 20);
    const videoCandidates = [
      ...document.querySelectorAll('video, video source, [data-video], [data-video-url], [data-video-url*="http"], [class*="video"] source'),
       ...performance.getEntriesByType('resource').filter((entry) => /\.(?:mp4|m3u8|webm|mov|m4v|ts)(?:[?#]|$)|(?:\/video\/|\/playback|\/vod\/|\/play\/|\/stream\/|video(?:[-_/?]|$)|cloud\.video)/i.test(entry.name)),
    ];
    const videos = [];
    for (const node of videoCandidates) {
      const value = typeof node === 'string' ? node : (node.name || node.currentSrc || node.src || node.dataset?.src || node.dataset?.video || node.dataset?.videoUrl || node.getAttribute?.('data-video-url') || '');
      const url = absolute(value);
      if (!/^https?:/i.test(url) || videos.some((item) => item.url === url)) continue;
      videos.push({ url, type: /\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'video', source: 'visible-page' });
      if (videos.length >= 20) break;
    }
    const body = tidy(document.body?.innerText || '', 24000);
     const ignoredTitle = /^(用户评价|问大家|参数信息|图文详情|本店推荐|看了又看|商品信息|商品详情|评价|规格|尺寸)(?:\s*[·:：]|$)/i;
     const genericTitle = /大模型|解答您的疑问|问问小美|商品信息待返回|待登录[／/]验证后读取/i;
     const titleCandidates = [...document.querySelectorAll('h1,[class*="item-title"],[class*="product-title"],[class*="goods-title"],[class*="title"]')].filter(visible).map((node, index) => { const value = tidy(node.innerText, 300); const tag = String(node.tagName || '').toLowerCase(); const className = String(node.className || '').toLowerCase(); const score = (tag === 'h1' ? 100 : 0) + (/(?:item|product|goods).*title|title.*(?:item|product|goods)/i.test(className) ? 80 : 0) + (className.includes('title') ? 20 : 0); return { value, score, index }; }).filter((item) => item.value.length >= 8 && !ignoredTitle.test(item.value) && !genericTitle.test(item.value) && !/淘宝|天猫|登录|加入购物车|立即购买|平台加补/i.test(item.value)).sort((a, b) => b.score - a.score || b.value.length - a.value.length || a.index - b.index).map((item) => item.value);
    const title = titleCandidates[0] || tidy(document.querySelector('meta[property="og:title"]')?.content || document.title, 300);
      // 基础采集只保留页面显示的评价/问大家总量；正文必须在用户点击资源卡
      // 后由可见操作触发对应 mtop 响应，禁止从 body 文本推断样本。
      const reviews = [];
      const questions = [];
     const detailText = tidy([...document.querySelectorAll('[class*="detail"],[class*="description"],[id*="detail"],[id*="description"]')].filter(visible).map((node) => node.innerText).join(' '), 30000);
     const productId = new URL(location.href).searchParams.get('id') || new URL(location.href).searchParams.get('itemId') || new URL(location.href).searchParams.get('item_id') || new URL(location.href).searchParams.get('offerId') || '';
     const firstVisibleText = (selectors, limit = 160) => [...document.querySelectorAll(selectors)].filter(visible).map((node) => tidy(node.innerText, limit)).find((value) => value && value.length <= limit) || '';
     const store = firstVisibleText('[class*="shop-name"],[class*="shopName"],[class*="seller-name"],[class*="sellerName"],[class*="store-name"],[class*="storeName"]', 120);
     const category = firstVisibleText('[class*="breadcrumb"],[class*="bread-crumb"],[class*="crumb"]', 240);
     const price = body.match(/(?:￥|¥)\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] || '';
     const reviewCount = body.match(/(?:累计评价|评价总数|评论数|用户评价)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1] || '';
     const questionCount = body.match(/(?:问大家|买家问答|常见问题)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1] || '';
     const sales = body.match(/(?:已售|销量|成交|付款人数)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1] || '';
      // 详情图片必须来自限定的详情容器或 detail.getdesc 响应；不能把
      // “前 5 张以后的所有页面图片”当作详情页，否则会混入评价、推荐和资质图片。
      return { original_url: location.href, final_url: location.href, rawText: body, product: { id: productId, category, store, title, price, reviewCount, sales }, reviewStats: reviewCount ? { totalCount: reviewCount } : {}, questionStats: questionCount ? { totalCount: questionCount } : {}, mainImages: [...new Set(images)].slice(0, 5), images: [...new Set(images)].slice(0, 5), videos: videos.slice(0, 20), reviews, questions, detail: { text: detailText, images: [] } };
    })()`, true);
  } catch {
    // 可见 DOM 在淘宝模板切换或 WebContentsView 切换瞬间可能暂时不可执行；
    // 达比式初始化状态已经包含商品、主图、视频和 SKU，不能因此丢弃整次采集。
    collection.domFallback = true;
  }
  const visibleMaxPasses = Number(process.env.XIAOMEI_DABI_VISIBLE_SCROLL_PASSES || 40);
  const visibleDelay = Number(process.env.XIAOMEI_DABI_VISIBLE_SCROLL_DELAY || 360);
  for (const module of modulesToCollect) {
    if (collectionToken.cancelled) break;
    try {
      const pageTotalCount = module === 'reviews'
        ? String(dabiState.product?.reviewCount || payload.product?.reviewCount || payload.reviewStats?.totalCount || '').trim()
        : String(dabiState.product?.questionCount || payload.product?.questionCount || payload.questionStats?.totalCount || '').trim();
      const captured = await collectDabiNetworkModule(entry, webContents, module, collection, networkCapture, visibleAgent, { maxPasses: visibleMaxPasses, delay: visibleDelay, pageTotalCount, isCancelled: () => collectionToken.cancelled });
      payload[module] = Array.isArray(captured.samples) ? captured.samples : [];
      const stats = captured.stats || {};
      if (module === 'reviews') payload.reviewStats = { ...(payload.reviewStats || {}), ...stats };
      if (module === 'questions') payload.questionStats = { ...(payload.questionStats || {}), ...stats };
      const sampleSource = captured.sampleSource || 'mtop-rateList/questionList';
      const visibleFallback = Boolean(captured.visibleFallback);
      collection.modules[module] = {
        status: payload[module].length ? 'ready' : captured.networkCount ? 'partial' : 'missing',
        sampleCount: payload[module].length,
        realResponseSampleCount: payload[module].length,
        responseCount: captured.networkCount || 0,
        totalCount: stats.totalCount || '',
        pageTotalCount: stats.pageTotalCount || pageTotalCount || '',
        responseTotalCount: stats.responseTotalCount || '',
        totalCountSource: stats.totalCountSource || (stats.totalCount ? (visibleFallback ? 'product-page-count' : 'mtop-rateList/questionList') : '未返回'),
        networkResponses: captured.networkCount || 0,
        screenshotCount: captured.screenshotCount || 0,
        source: sampleSource,
        sourceStepIds: [],
        reason: payload[module].length
          ? (visibleFallback ? '已从问大家抽屉的可见问答卡精确提取真实样本' : '已从对应 mtop 真实响应归一化样本')
          : captured.networkCount
            ? '捕获到对应 mtop 响应但未解析出可展示样本'
            : `未捕获${module === 'questions' ? '问大家 questionList' : '评价 rateList'}真实响应；未使用演示数据`,
      };
      if (!payload[module].length && !captured.networkCount) collection.errors = [...(collection.errors || []), { module, message: `未捕获${module === 'questions' ? '问大家 questionList' : '评价 rateList'}接口响应` }].slice(0, 8);
      if (captured.stopped) { collection.stopped = true; break; }
    } catch (error) {
      collection.modules[module] = { status: 'failed', sampleCount: 0, realResponseSampleCount: 0, responseCount: 0, reason: redact(error?.message || error), source: 'mtop-rateList/questionList', sourceStepIds: [] };
      collection.errors = [...(collection.errors || []), { module, message: redact(error?.message || error) }].slice(0, 8);
      sendCollectionProgress(entry, { status: 'running', module, action: 'error', message: `${module === 'questions' ? '问大家' : '用户评价'}采集遇到页面限制，已保留已读取内容。`, sampleCount: payload[module]?.length || 0 });
    }
  }
  if (baseOnly) {
    for (const module of ['reviews', 'questions']) {
      const stats = module === 'reviews' ? payload.reviewStats : payload.questionStats;
      const pageTotalCount = module === 'reviews'
        ? String(dabiState.product?.reviewCount || stats?.totalCount || '').trim()
        : String(dabiState.product?.questionCount || stats?.totalCount || '').trim();
      collection.modules[module] = {
        status: 'deferred',
        sampleCount: 0,
        realResponseSampleCount: 0,
        responseCount: 0,
        totalCount: pageTotalCount,
        pageTotalCount,
        totalCountSource: pageTotalCount ? 'product-page-count' : '未返回',
        source: 'product-page-count',
        sourceStepIds: [],
        reason: '基础采集阶段不读取正文，保留商品页显示的数量；点击资源卡后再采集正文。',
      };
    }
  }
  if (collectionToken.cancelled) collection.stopped = true;
  collection.actionTrace = collection.actions;
  let sku = { available: false, id: '', text: '', specs: [], items: [], itemCount: 0 };
  // 旧的可见 DOM SKU 推断只能拿到当前选中项或尺码表，已经移除出基础采集；
  // 下方只接受带真实 SKU ID + 规格路径的共享页面状态结果。
  const mergeUnique = (left, right, limit = 20) => [...new Set([...(left || []), ...(right || [])].filter(Boolean))].slice(0, limit);
  const mergeMainImages = (left, right) => filterDabiMainImages([...(left || []), ...(right || [])], 5);
  const mergeSkuData = (primary = {}, secondary = {}) => {
    const result = { ...(secondary || {}), ...(primary || {}) };
    const specs = [];
    const groups = new Map();
    for (const source of [secondary, primary]) {
      for (const rawGroup of (source?.specs || [])) {
        if (!rawGroup || typeof rawGroup !== 'object') continue;
        const name = String(rawGroup.name || rawGroup.title || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        let group = groups.get(name);
        if (!group) { group = { name, values: [] }; groups.set(name, group); specs.push(group); }
        for (const rawValue of (rawGroup.values || [])) {
          if (rawValue === null || rawValue === undefined) continue;
          const value = rawValue && typeof rawValue === 'object' ? { ...rawValue } : { name: rawValue };
          const valueName = String(value.name || value.value || value.title || value.text || '').replace(/\s+/g, ' ').trim();
          if (!valueName) continue;
          const image = value.image || value.imageUrl || value.pic || value.picUrl || '';
          const existing = group.values.find((item) => item.name === valueName);
          if (existing) {
            if (!existing.image && image) existing.image = image;
            if (!existing.id && (value.id || value.valueId || value.vid)) existing.id = value.id || value.valueId || value.vid;
            existing.selected = existing.selected || Boolean(value.selected);
            existing.disabled = existing.disabled && Boolean(value.disabled);
          } else if (group.values.length < 100) {
            group.values.push({ ...value, name: valueName, image });
          }
        }
      }
    }
    const items = [];
    const seenItems = new Set();
    const isRealSkuItem = (rawItem) => {
      if (!rawItem || typeof rawItem !== 'object') return false;
      const id = String(rawItem.id || rawItem.skuId || rawItem.sku_id || rawItem.skuID || '').trim();
      const path = String(rawItem.propPath || rawItem.prop_path || rawItem.propertyPath || '').trim();
      const specs = Array.isArray(rawItem.specs)
        ? rawItem.specs.filter((item) => item && (item.value || item.name)).length
        : String(rawItem.specs || rawItem.specText || '').trim().length;
      return Boolean(id && (path || specs || rawItem.source === 'dabi-root-sku'));
    };
    for (const source of [secondary, primary]) {
      for (const rawItem of (source?.items || [])) {
        if (!isRealSkuItem(rawItem)) continue;
        let key = String(rawItem.id || rawItem.skuId || rawItem.sku_id || rawItem.propPath || rawItem.prop_path || '').trim();
        if (!key) {
          try { key = JSON.stringify(rawItem.specs || rawItem.properties || rawItem); } catch { key = String(items.length); }
        }
        if (seenItems.has(key)) continue;
        seenItems.add(key);
        items.push(rawItem);
        if (items.length >= 500) break;
      }
      if (items.length >= 500) break;
    }
    const itemCount = Math.max(
      Number(primary.itemCount || 0),
      Number(secondary.itemCount || 0),
      items.length,
    );
    const explicitTotalCount = Math.max(Number(primary.totalCount || 0), Number(secondary.totalCount || 0));
    const totalCount = explicitTotalCount || itemCount;
    const specImageUrls = new Set([
      ...items.map((item) => item?.image || item?.imageUrl || item?.pic || item?.picUrl || '').filter(Boolean),
      ...specs.flatMap((group) => group.values.map((value) => value?.image || value?.imageUrl || value?.pic || value?.picUrl || '').filter(Boolean)),
    ]);
    result.specs = specs;
    result.items = items;
    result.totalCount = totalCount;
    result.itemCount = itemCount;
    result.matrixComplete = Boolean(itemCount && (!explicitTotalCount || itemCount >= totalCount));
    result.specImageCount = Math.max(Number(primary.specImageCount || 0), Number(secondary.specImageCount || 0), specImageUrls.size);
    result.available = Boolean(result.available || specs.length || items.length || totalCount);
    return result;
  };
  let structuredSku = null;
  try {
    structuredSku = await webContents.executeJavaScript(ELECTRON_DABI_STRUCTURED_SKU_SCRIPT, true) || null;
  } catch {
    // 页面还未完成初始化时会暂时没有结构化 SKU；保持空列表，不能补当前选中项。
  }
  const hasSkuState = (value) => Boolean(value?.items?.length || value?.specs?.length || value?.totalCount);
  const mergePageState = (previous = {}, next = {}) => ({
    ...previous,
    ...next,
    product: { ...(previous.product || {}), ...(next.product || {}) },
    mainImages: mergeMainImages(next.mainImages || next.images, previous.mainImages || previous.images),
    images: mergeMainImages(next.images || next.mainImages, previous.images || previous.mainImages),
    videos: [...new Map([
      ...(next.videos || []),
      ...(previous.videos || []),
    ].map((item) => [item?.url || item, typeof item === 'string' ? { url: item, type: 'video', source: 'product-state' } : item])).values()].slice(0, 20),
    detail: {
      ...(previous.detail || {}),
      ...(next.detail || {}),
      images: mergeUnique(next.detail?.images, previous.detail?.images, 240),
    },
  });
  let detailRevealResult = null;
  let networkDetailState = {};
  const refreshDetailState = async () => {
    const beforeResponses = networkCapture.records.detail.length;
    try {
      detailRevealResult = await webContents.executeJavaScript(ELECTRON_DABI_DETAIL_REVEAL_SCRIPT, true);
      // 详情读取脚本只检查当前页面和初始化状态，不触发滚动或点击。
      // 它返回的真实图片 URL 直接并入详情状态，后端随后按达笔方式下载拼接。
      if (detailRevealResult && typeof detailRevealResult === 'object') {
        dabiState = mergePageState(dabiState, {
          detail: {
            text: String(detailRevealResult.text || ''),
            images: Array.isArray(detailRevealResult.images) ? detailRevealResult.images : [],
            source: String(detailRevealResult.source || 'visible-detail-dom'),
          },
        });
      }
      // 保留很短的 settle，用来接收页面已经在本次采集开始前后产生的
      // detail.getdesc 响应；不再等待滚动触发的网络请求。
      await networkCapture.settle(450);
      const refreshedDetailState = await webContents.executeJavaScript(ELECTRON_DABI_PRODUCT_STATE_SCRIPT, true) || {};
      if (refreshedDetailState && typeof refreshedDetailState === 'object') dabiState = mergePageState(dabiState, refreshedDetailState);
      await networkCapture.settle(250);
      const parsedNew = networkCapture.parseModule('detail', beforeResponses, webContents.getURL());
      const parsedAll = networkCapture.parseModule('detail', 0, webContents.getURL());
      const candidates = [parsedNew?.detail, parsedAll?.detail]
        .filter((item) => item && ((Array.isArray(item.images) && item.images.length > 0) || String(item.text || '').trim()))
        .sort((left, right) => {
          const imageDelta = (right.images?.length || 0) - (left.images?.length || 0);
          return imageDelta || String(right.text || '').length - String(left.text || '').length;
        });
      networkDetailState = candidates[0] || {};
      collection.actions.push({
        action: 'inspect',
        module: 'detail',
        target: '已挂载的详情页图文',
        clicked: Boolean(detailRevealResult?.clicked),
        scrolled: false,
        ok: Boolean(detailRevealResult?.ok || Object.keys(networkDetailState).length),
        imageCount: Number(detailRevealResult?.imageCount || 0) || 0,
        passes: Number(detailRevealResult?.passes || 0) || 0,
        changedPasses: Number(detailRevealResult?.changedPasses || 0) || 0,
        networkResponses: networkCapture.records.detail.length - beforeResponses,
        source: networkDetailState.images?.length || networkDetailState.text ? 'mtop-detail-getdesc' : 'product-page-state',
      });
    } catch (error) {
      detailRevealResult = { ok: false, reason: String(error?.message || error).slice(0, 180) };
      collection.actions.push({ action: 'inspect', module: 'detail', target: '已挂载的详情页图文', clicked: false, scrolled: false, ok: false, source: 'product-page-state', reason: detailRevealResult.reason });
    }
  };
  if (baseOnly || requestedModule === 'detail') await refreshDetailState();
  let videoRevealResult = null;
  const refreshVideoState = async () => {
    if (dabiState.videos?.length || payload.videos?.length) return;
    try {
      // 先打开商品画廊的视频入口，再处理可能会弹出的规格面板；否则
      // 规格弹层会挡住视频标签，导致基础自动采集漏掉主图视频。
      videoRevealResult = await webContents.executeJavaScript(ELECTRON_DABI_VIDEO_REVEAL_SCRIPT, true);
      // 播放器地址通常在标签点击后的异步资源加载阶段才出现；短轮询
      // 同一页面状态，最多等待约 2.5 秒，不播放视频也不生成地址。
      for (let attempt = 0; attempt < 6 && !dabiState.videos?.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 720 : 360));
        const refreshedMediaState = await webContents.executeJavaScript(ELECTRON_DABI_PRODUCT_STATE_SCRIPT, true) || {};
        if (refreshedMediaState && typeof refreshedMediaState === 'object') dabiState = mergePageState(dabiState, refreshedMediaState);
      }
    } catch {
      // 页面没有可读取的真实视频时保持 missing，由前端显示“暂无视频”。
    }
  };
  if (!dabiState.videos?.length && !payload.videos?.length && (baseOnly || requestedModule === 'videos')) {
    await refreshVideoState();
  }
  // 达笔的 SKU 查询不点击某一个颜色/尺码，而是读取规格区加载后的完整
  // skuBase + skuCore。首屏没有初始化矩阵时，只检查已经可见的规格入口，
  // 不为补采而移动商品页；随后重新读取同一份页面状态，仍没有真实组合就保持 missing。
  if (!hasSkuState(structuredSku) && (baseOnly || requestedModule === 'sku')) {
    try {
      await webContents.executeJavaScript(ELECTRON_DABI_SKU_REVEAL_SCRIPT, true);
      await new Promise((resolve) => setTimeout(resolve, 720));
      const refreshedState = await webContents.executeJavaScript(ELECTRON_DABI_PRODUCT_STATE_SCRIPT, true) || {};
      if (refreshedState && typeof refreshedState === 'object') dabiState = mergePageState(dabiState, refreshedState);
      structuredSku = await webContents.executeJavaScript(ELECTRON_DABI_STRUCTURED_SKU_SCRIPT, true) || structuredSku;
    } catch {
      // 规格区不是所有淘宝模板都会渲染；继续保留真实空状态，不补选中项。
    }
  }
  // 如果页面在规格区加载过程中才挂载播放器，再做一次同页重读；不播放、
  // 不伪造 URL，也不把详情图当成视频。
  if (!dabiState.videos?.length && !payload.videos?.length && (baseOnly || requestedModule === 'videos')) await refreshVideoState();
  collection.pageStateSignals = {
    product: dabiState.diagnostics || {},
    sku: structuredSku?.diagnostics || {},
    videoReveal: videoRevealResult && typeof videoRevealResult === 'object'
      ? { ok: Boolean(videoRevealResult.ok), clicked: Boolean(videoRevealResult.clicked), reason: String(videoRevealResult.reason || '').slice(0, 120), text: String(videoRevealResult.text || '').slice(0, 80) }
      : {},
  };
  dabiState = await enrichDabiProductCategory(dabiState).catch(() => dabiState);
  const directProduct = Object.fromEntries(Object.entries(dabiState.product || {}).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  const mergedPayload = {
    ...payload,
    product: { ...(payload.product || {}), ...directProduct },
    mainImages: mergeMainImages(dabiState.mainImages, payload.mainImages),
    images: mergeMainImages(dabiState.mainImages || dabiState.images, payload.images),
    videos: [...new Map([...(dabiState.videos || []), ...(payload.videos || [])].map((item) => [item.url || item, typeof item === 'string' ? { url: item, type: 'video', source: 'visible-page' } : item])).values()].slice(0, 20),
    detail: {
      ...(payload.detail || {}),
      ...(dabiState.detail || {}),
      ...(networkDetailState || {}),
      source: networkDetailState.images?.length || networkDetailState.text
        ? 'mtop-detail-getdesc'
        : (dabiState.detail?.source || payload.detail?.source || 'product-page-state'),
      // mtop.detail.getdesc is the authoritative detail layout. Do not append
      // the page-wide DOM image list after a successful response: that list
      // also contains gallery, review and recommendation assets, which turn
      // the long image into the unrelated collage seen in older tasks.
      images: Array.isArray(networkDetailState.images) && networkDetailState.images.length
        ? networkDetailState.images.slice(0, 240)
        : mergeUnique(dabiState.detail?.images, payload.detail?.images, 240),
    },
  };
  if (structuredSku) sku = mergeSkuData(structuredSku, sku);
  const directSku = dabiState.sku && (dabiState.sku.items?.length || dabiState.sku.specs?.length || dabiState.sku.totalCount) ? dabiState.sku : null;
  if (directSku) sku = mergeSkuData(directSku, sku);
  const skuTotalCount = Number(sku.totalCount || 0);
  const skuItemCount = Number(sku.itemCount || sku.items?.length || 0);
  if (skuTotalCount) mergedPayload.product = { ...(mergedPayload.product || {}), skuCount: skuTotalCount };
  // 仅保留不含 URL、标题、Cookie 或响应正文的字段信号，便于确认淘宝模板
  // 是否把 SKU/视频挂到了达笔同一条页面状态链上；具体数据仍只从解析结果输出。
  collection.pageStateSignals = {
    product: dabiState.diagnostics || collection.pageStateSignals?.product || {},
    sku: structuredSku?.diagnostics || {},
    detailReveal: detailRevealResult && typeof detailRevealResult === 'object'
      ? { ok: Boolean(detailRevealResult.ok), clicked: Boolean(detailRevealResult.clicked), scrolled: false, rootFound: Boolean(detailRevealResult.rootFound), imageCount: Number(detailRevealResult.imageCount || 0) || 0, passes: Number(detailRevealResult.passes || 0) || 0, changedPasses: Number(detailRevealResult.changedPasses || 0) || 0, reason: String(detailRevealResult.reason || '').slice(0, 120) }
      : {},
    videoReveal: collection.pageStateSignals?.videoReveal || {},
  };
  collection.modules.sku = {
    status: sku.matrixComplete || (skuItemCount && !skuTotalCount) ? 'ready' : skuTotalCount || skuItemCount ? 'partial' : 'missing',
    sampleCount: skuItemCount,
    realResponseSampleCount: 0,
    responseCount: 0,
    totalCount: skuTotalCount || skuItemCount || '',
    totalCountSource: skuTotalCount ? 'product-page-sku-count' : skuItemCount ? 'sku-page-state-rows' : '未返回',
    source: 'dabi-page-state',
    sourceStepIds: [],
    reason: skuTotalCount && !sku.matrixComplete
      ? `页面返回 SKU 总量 ${skuTotalCount}，当前已解析 ${skuItemCount} 条真实明细`
      : skuItemCount
        ? '已读取商品页真实 SKU 规格与组合'
        : '当前页面未返回真实 SKU 组合；未使用当前选中项或尺寸表生成伪数据',
  };
  collection.networkModules = {
    reviews: Math.max(0, networkCapture.records.reviews.length - Number(captureStartCounts.reviews || 0)),
    questions: Math.max(0, networkCapture.records.questions.length - Number(captureStartCounts.questions || 0)),
    detail: Math.max(0, networkCapture.records.detail.length - Number(captureStartCounts.detail || 0)),
  };
  const baseModuleReady = {
    images: Boolean(mergedPayload.mainImages?.length),
    // 详情文字可用于参数解析，但不能代表详情长图已采集完成；
    // 只有真实详情图片 URL 才能让详情资源进入可下载/可预览状态。
    detail: Boolean(mergedPayload.detail?.images?.length),
    sku: Boolean(sku?.items?.length || sku?.specs?.length || sku?.totalCount),
    videos: Boolean(mergedPayload.videos?.length),
  };
  const baseModulesToCheck = baseOnly
    ? baseModules
    : baseModules.includes(requestedModule)
      ? [requestedModule]
      : [];
  collection.missingModules = [
    ...modulesToCollect.filter((module) => ['reviews', 'questions'].includes(module) ? !payload[module]?.length : !baseModuleReady[module]),
    ...baseModulesToCheck.filter((module) => !baseModuleReady[module]),
  ].filter((module, index, values) => values.indexOf(module) === index);
  collection.deferredModules = baseOnly ? ['reviews', 'questions'] : [];
  collection.strategy = baseOnly
    ? '先读取商品页初始化状态、主图、详情、SKU、视频和评价/问大家数量；评价/问大家正文仅在点击对应资源卡后，通过可见操作触发 mtop rateList/questionList。'
    : baseModules.includes(requestedModule)
      ? `只读取用户点击的${({ images: '主图', detail: '详情页图文', sku: 'SKU', videos: '视频' })[requestedModule]}模块；详情模块只读取当前已挂载图片 URL，不滚动、不改变商品页位置。`
    : '可见页面截图识别入口，CDP 鼠标点击/滚轮触发；评价优先取 mtop rateList，问大家无可回读响应时从已打开抽屉的可见问答卡精确提取';
  collection.finishedAt = new Date().toISOString();
  const sourceSteps = collection.actions.map((action, index) => ({
    id: action.id || `step-${String(index + 1).padStart(2, '0')}`,
    module: action.module || 'product',
    action: action.action || 'inspect',
    target: action.target || '商品页可见状态',
    status: action.status || (action.ok === false ? 'failed' : 'completed'),
    source: action.source || (action.module === 'reviews' || action.module === 'questions' ? 'mtop-rateList/questionList' : 'electron-dabi-network'),
    responseCount: Number(action.networkResponses || action.responseCount || 0) || 0,
    realResponseSampleCount: Number(action.realResponseSampleCount || action.sampleCount || 0) || 0,
  }));
  const productStateStep = sourceSteps.find((step) => step.module === 'product')?.id || 'step-product-state';
  if (!sourceSteps.some((step) => step.id === productStateStep)) sourceSteps.unshift({ id: productStateStep, module: 'product', action: 'inspect', target: '商品页初始化状态', status: 'completed', source: 'product-page-state', responseCount: 0, realResponseSampleCount: 0 });
  for (const module of ['reviews', 'questions']) {
    const moduleState = collection.modules[module] || {};
    let ids = sourceSteps.filter((step) => step.module === module).map((step) => step.id);
    const endpoint = module === 'reviews' ? 'mtop-rateList' : 'mtop-questionList';
    if (moduleState.responseCount && !sourceSteps.some((step) => step.module === module && String(step.source || '').includes(endpoint))) {
      const id = `step-${module}-response`;
      sourceSteps.push({ id, module, action: 'read_mtop_response', target: module === 'reviews' ? '评价 rateList 响应' : '问大家 questionList 响应', status: 'completed', source: endpoint, responseCount: moduleState.responseCount, realResponseSampleCount: moduleState.realResponseSampleCount || 0 });
      ids.push(id);
    }
    if (!ids.length && moduleState.status === 'deferred') ids = [productStateStep];
    moduleState.sourceStepIds = ids.slice(0, 30);
    moduleState.sourceSteps = sourceSteps.filter((step) => moduleState.sourceStepIds.includes(step.id)).slice(0, 30);
    collection.modules[module] = moduleState;
  }
  collection.sourceSteps = sourceSteps.slice(0, 80);
  collection.productId = String(mergedPayload.product?.id || '').trim();
  collection.normalizedUrl = current;
  collection.collectedAt = collection.finishedAt;
  collection.rawResponsesPersisted = false;
  collection.sensitiveDataStored = false;
  collection.privacy = { cookiesSaved: false, tokensSaved: false, rawResponsesSaved: false };
  const finishStatus = collection.stopped ? 'stopped' : collection.missingModules.length ? 'partial' : 'ready';
  const countLabel = (value) => value || '未返回';
  const finishMessage = collection.stopped
    ? (collectionToken.stopMessage || '已停止桌面智能体操作，已保留停止前读取到的数据。')
    : baseOnly
      ? `商品基础信息已读取完成；评价 ${countLabel(payload.reviewStats?.totalCount)}、问大家 ${countLabel(payload.questionStats?.totalCount)}，正文暂不采集。`
      : requestedModule === 'reviews'
        ? `评价已采集完成：${payload.reviews.length} 条；问大家暂未采集。`
        : requestedModule === 'questions'
          ? `问大家已采集完成：${payload.questions.length} 条；评价暂未采集。`
          : baseModules.includes(requestedModule)
            ? `${({ images: '主图', detail: '详情页图文', sku: 'SKU', videos: '视频' })[requestedModule]}已读取完成${collection.missingModules.length ? '，当前页面未返回有效数据' : ''}。`
          : `评价和问大家已采集完成：评价 ${payload.reviews.length} 条，问大家 ${payload.questions.length} 条。`;
  collection.message = finishMessage;
  sendCollectionProgress(entry, { status: finishStatus, action: 'finish', message: finishMessage, reviews: payload.reviews.length, questions: payload.questions.length, reviewTotalCount: payload.reviewStats?.totalCount || '', questionTotalCount: payload.questionStats?.totalCount || '', deferredModules: collection.deferredModules, missingModules: collection.missingModules, interactionMode, trigger: collectionTrigger });
  activeDabiCollections.delete(webContents.id);
  if (ownsNetworkCapture) await networkCapture.dispose().catch(() => {});
  return {
    ok: true,
    status: finishStatus,
    message: finishMessage,
    backend: 'electron',
    source: 'electron-dabi-network',
    session_id: 'electron-window',
    tab_id: entry?.id || activeProductTabId,
    web_contents_id: String(webContents.id),
    collection,
    ...mergedPayload,
    productId: collection.productId,
    normalized_url: collection.normalizedUrl,
    collectedAt: collection.collectedAt,
    sku,
    rawText: redact(mergedPayload.rawText),
    product: {
      ...mergedPayload.product,
      sku: sku.id || mergedPayload.product?.sku || '',
      title: redact(mergedPayload.product?.title),
      price: redact(mergedPayload.product?.price),
      reviewCount: redact(mergedPayload.product?.reviewCount),
      sales: redact(mergedPayload.product?.sales),
    },
    reviews: mergedPayload.reviews?.map((item) => ({ ...item, content: redact(item.content), text: redact(item.text) })).slice(0, COMMERCE_REVIEW_SAMPLE_LIMIT) || [],
    questions: mergedPayload.questions?.map((item) => ({
      ...item,
      question: redact(item.question),
      text: redact(item.text),
      answer: redact(item.answer),
      answers: Array.isArray(item.answers) ? item.answers.map((answer) => redact(answer)) : item.answers,
    })) || [],
    detail: { ...mergedPayload.detail, text: redact(mergedPayload.detail?.text) },
  };
}

async function capturePageContext(options = {}) {
  const entry = activeProductEntry();
  const webContents = entry?.view?.webContents || productView?.webContents;
  if (!webContents) return { ok: false, message: '桌面商品页面尚未打开' };
  const current = webContents.getURL?.() || productUrl;
  if (!hostAllowed(current)) return { ok: false, message: '当前页面不在网页智能体白名单内' };
  if (isLoginUrl(current)) return { ok: false, status: 'login_required', message: `当前仍在${safeSite(current)}官方登录页` };
  if (isVerificationUrl(current, webContents.getTitle?.())) return { ok: false, status: 'verification_required', message: `当前是${safeSite(current)}官方验证页面` };
  let payload;
  try {
    payload = await webContents.executeJavaScript(ELECTRON_SEARCH_CONTEXT_SCRIPT, true);
  } catch (error) {
    return { ok: false, message: `读取当前搜索页失败：${error.message || error}` };
  }
  if (!payload?.ok || payload.pageType !== 'search') {
    return { ok: false, message: '当前页面不是可读取的淘宝搜索结果页' };
  }
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 80).map((item) => ({
    ...item,
    title: redact(item.title),
    seller: redact(item.seller),
    text: redact(item.text),
  })) : [];
  return {
    ok: true,
    backend: 'electron',
    source: 'electron-visible-dom-search',
    tab_id: String(webContents.id),
    url: current,
    page_context: {
      ...payload,
      url: current,
      title: redact(payload.title || webContents.getTitle?.() || ''),
      rawText: redact(payload.rawText),
      items,
    },
    requested: String(options?.kind || 'search'),
  };
}

// 供“问问小美”使用的通用只读快照。它不复用商品采集器，因此不会滚动、
// 点击、调用平台接口或接触 Cookie / 存储；仅返回当前可见 DOM 的脱敏摘要。
async function captureAssistantContext(options = {}) {
  const requestedTabId = String(options?.tabId || '').trim();
  const entry = productEntryForTab(requestedTabId);
  if (requestedTabId && !entry) return { ok: false, status: 'tab_not_found', message: '当前网页标签已关闭或不存在' };
  const webContents = entry?.view?.webContents || productView?.webContents;
  if (!webContents) return { ok: false, status: 'not_open', message: '桌面网页尚未打开' };
  const current = webContents.getURL?.() || entry?.url || productUrl;
  const title = webContents.getTitle?.() || '';
  if (isAssistantContextLogin(current, title)) return { ok: false, status: 'login_required', message: `当前${safeSite(current)}页面需要登录；完成登录后可重新读取可见资料` };
  if (isVerificationUrl(current, title)) return { ok: false, status: 'verification_required', message: '当前是验证页面；请先在网页中手动完成验证' };
  if (!assistantContextHostAllowed(current)) return { ok: false, status: 'unsupported_page', message: '当前页面不在六站点可读范围内' };
  let payload;
  try {
    payload = await webContents.executeJavaScript(ELECTRON_ASSISTANT_CONTEXT_SCRIPT, true);
  } catch (error) {
    return { ok: false, status: 'capture_failed', message: `读取当前可见页面失败：${redact(error?.message || error, 240)}` };
  }
  if (!payload?.ok) {
    const status = ['login_required', 'verification_required'].includes(String(payload?.status || ''))
      ? String(payload.status)
      : 'no_visible_data';
    const fallback = status === 'login_required'
      ? `当前${safeSite(current)}页面需要登录；完成登录后可重新读取可见资料`
      : status === 'verification_required'
        ? '当前页面需要完成验证；请先在网页中手动完成验证'
        : '当前页面尚未加载出可见资料；请等待页面加载后重试';
    return { ok: false, status, message: redact(payload?.message || fallback, 240) };
  }
  const pageContext = cleanAssistantContextPayload(payload, current, title);
  const structuredFacts = Array.isArray(pageContext?.structured?.facts) ? pageContext.structured.facts : [];
  const structuredResources = Array.isArray(pageContext?.structured?.resources) ? pageContext.structured.resources : [];
  const hasVisibleData = Boolean(
    pageContext.rawText
    || pageContext.headings.length
    || pageContext.metrics.length
    || pageContext.tables.length
    || pageContext.cards.length
    || structuredFacts.length
    || structuredResources.length,
  );
  if (!hasVisibleData) return { ok: false, status: 'no_visible_data', message: '当前页面没有可读取的可见资料' };
  return {
    ok: true,
    backend: 'electron-visible-dom-assistant',
    source: 'electron-visible-dom-assistant',
    tab_id: entry?.id || requestedTabId || String(webContents.id),
    web_contents_id: String(webContents.id),
    url: pageContext.url,
    page_context: pageContext,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700, backgroundColor: '#f4f7fb',
    title: APP_NAME,
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    // 先隐藏再最大化，避免启动时先闪出一个缩小窗口，随后再改变布局。
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(APP_NAME);
  });
  try { mainWindow.webContents.setBackgroundThrottling(false); } catch {}
  mainWindow.setMenuBarVisibility(false);
  ensureProductView('commerce-default');
  let mainWindowPresented = false;
  const revealMainWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { if (mainWindow.isMinimized()) mainWindow.restore(); } catch {}
      if (!mainWindowPresented) {
        try {
          mainWindow.maximize();
          mainWindowPresented = true;
        } catch {}
      }
      try { mainWindow.show(); } catch {}
      try { mainWindow.moveTop(); } catch {}
      try { mainWindow.focus(); } catch {}
    }
  };
  // 在隐藏启动器或 Windows 任务栏恢复场景下，不等待渲染器事件也先把窗口最大化并显示。
  revealMainWindow();
  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(revealMainWindow, 150);
    [0, 150, 600, 1500].forEach((delay) => setTimeout(() => { void syncCommercePageActiveFromRenderer(); }, delay));
    scheduleCommerceSurfaceResync();
  });
  [200, 700, 1500, 3000, 6000, 10000].forEach((delay) => setTimeout(revealMainWindow, delay));
  // The renderer owns the surface layout. Re-applying the previous bounds on
  // resize leaves a maximized window with a view sized for the old window,
  // which shows up as a white strip beside the official page. Re-read the
  // current iframe/surface rectangles after the renderer has laid them out.
  mainWindow.on('resize', () => scheduleCommerceSurfaceResync());
  mainWindow.webContents.on('did-finish-load', () => {
    void syncCommercePageActiveFromRenderer();
    scheduleCommerceSurfaceResync();
  });
  // Electron 的顶层页面必须是完整的小美画布；商品分析台通过 iframe 作为其中一个工作区加载。
  mainWindow.loadURL(`${LOCAL_ORIGIN}/static/index.html?page=${encodeURIComponent(START_PAGE)}&v=2026.09.15.desktop-update1`);
}

app.whenReady().then(async () => {
  try {
    // 桌面端只使用应用内工具栏；移除 Electron 默认的 File/Edit/... 原生菜单，
    // 避免按 Alt 或窗口状态变化时菜单栏再次弹出。
    Menu.setApplicationMenu(null);
    const apiReady = await ensureApi();
    if (!apiReady) throw new Error('本地服务启动超时，请检查 Python 环境和项目依赖。');
    await configureCommerceSessions();
    createWindow();
    scheduleDesktopUpdateCheck();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox(APP_NAME, `桌面端启动失败：${error?.message || error}`);
    app.quit();
  }
});

ipcMain.handle('commerce:open-product', async (_event, url, tabId) => {
  await syncCommercePageActiveFromRenderer();
  return loadProduct(String(url || '').trim(), String(tabId || 'commerce-default'));
});
ipcMain.handle('canvas-share:open', (event, url) => openSharedCanvasWindow(url, event.sender));
ipcMain.on('canvas-share:close', (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || !sharedCanvasWindows.has(owner) || owner.isDestroyed()) return;
  owner.close();
});
ipcMain.handle('generation:notify', (event, payload) => showGenerationNotification(event.sender, payload || {}));
ipcMain.handle('app:check-update', async (event, options = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) return { status: 'denied', message: '只能从小美画布主窗口检查更新' };
  return checkDesktopUpdate({ manual: options?.manual !== false });
});
ipcMain.handle('app:update-cancel', (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== updateWindow) return { ok: false, message: '更新窗口不可用' };
  try { desktopUpdateAbortController?.abort(); } catch {}
  return { ok: true };
});
ipcMain.handle('clipboard:write-image', (event, payload) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, message: '当前窗口不可用' };
  }
  let buffer = null;
  if (payload instanceof ArrayBuffer) {
    buffer = Buffer.from(new Uint8Array(payload));
  } else if (ArrayBuffer.isView(payload)) {
    buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (!buffer?.length) return { ok: false, message: '图片数据为空' };
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return { ok: false, message: '图片数据无法解析' };
  clipboard.writeImage(image);
  return { ok: true };
});
ipcMain.handle('app:open-external', async (event, url) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) return { ok: false, message: '无法打开外部网页' };
  try {
    const parsed = new URL(String(url || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, message: '仅支持打开网页地址' };
    await shell.openExternal(parsed.toString());
    return { ok: true, url: parsed.toString() };
  } catch (error) {
    return { ok: false, message: error?.message || '无法打开外部网页' };
  }
});
ipcMain.handle('commerce:open-login', async (_event, site, tabId, returnUrl) => {
  await syncCommercePageActiveFromRenderer();
  const siteKey = String(site || '').trim().toLowerCase();
  const loginUrl = commerceLoginUrl(siteKey, String(tabId || 'commerce-default'), String(returnUrl || ''));
  return loadProduct(loginUrl, String(tabId || 'commerce-default'), 'login');
});
ipcMain.handle('commerce:open-seller', async (_event, site, tabId) => {
  await syncCommercePageActiveFromRenderer();
  return loadSeller(site, String(tabId || 'commerce-default'));
});
ipcMain.handle('commerce:activate-tab', async (_event, tabId, options = {}) => {
  await syncCommercePageActiveFromRenderer();
  const id = String(tabId || '');
  let entry = productViews.get(id) || (options && (options.kind || options.site || options.url) ? ensureProductView(id, options) : null);
  if (!entry) return { ok: false, tabId: id, message: '内嵌标签尚未创建' };
  entry = activateProductView(id, options || {});
  productUrl = entry.url || '';
  sendSurfaceState({ tabId: id, url: entry.url || '', title: entry.view.webContents.getTitle() });
  return { ok: true, tabId: id, url: entry.url || '' };
});
ipcMain.handle('commerce:navigate-back', (_event, tabId) => navigateProductHistory('back', String(tabId || '')));
ipcMain.handle('commerce:navigate-forward', (_event, tabId) => navigateProductHistory('forward', String(tabId || '')));
ipcMain.handle('commerce:reload-product', (_event, tabId, options = {}) => reloadProduct(String(tabId || ''), options || {}));
ipcMain.handle('commerce:stop-product', (_event, tabId) => stopProduct(String(tabId || '')));
ipcMain.handle('commerce:translate-page', (_event, tabId) => translateProductPage(String(tabId || '')));
ipcMain.handle('commerce:close-tab', (_event, tabId) => closeProductTab(String(tabId || '')));
ipcMain.handle('commerce:browser-zoom', (_event, action, tabId) => changeProductZoom(String(action || ''), String(tabId || '')));
ipcMain.handle('commerce:toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, fullScreen: false };
  const fullScreen = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(fullScreen);
  return { ok: true, fullScreen };
});
ipcMain.on('commerce:set-page-active', (_event, active) => {
  commercePageActiveRevision += 1;
  commercePageActive = Boolean(active);
  if (!commercePageActive) {
    commerceSurfaceResyncToken += 1;
    hideProductViews();
    // 页面切走时报告抽屉可能还留在 iframe 中；清掉阻塞状态，
    // 防止重新进入商品分析台后顶层商品页一直无法恢复。
    setCommerceSurfaceBlocked(false);
  } else {
    // 外层 iframe 从其它工作区返回时，商品页视图不会收到新的 load 事件；
    // 此处主动恢复活动标签的可见性和层级。
    refreshProductViewVisibility();
    scheduleCommerceSurfaceResync();
  }
});
ipcMain.on('commerce:set-overlay-active', (_event, active) => setCommerceSurfaceBlocked(active));
ipcMain.on('commerce:set-product-bounds', (_event, bounds, tabId) => updateViewBounds(bounds, String(tabId || activeProductTabId)));
ipcMain.on('commerce:set-product-visible', (_event, visible, tabId) => {
  const requestedTabId = String(tabId || '').trim();
  if (!visible) {
    // 非商品标签（例如 analysis-1）没有对应的 WebContentsView。清空主进程
    // 的活动商品选择，避免此前商品标签的异步激活/尺寸同步回调再次显示旧页。
    // 外层工作区切换不带 tabId，只隐藏视图并保留选择，回来时可直接恢复当前商品。
    if (requestedTabId && !productViews.has(requestedTabId)) {
      commerceSurfaceResyncToken += 1;
      activeProductTabId = '';
      productView = null;
    }
    hideProductViews();
    return;
  }
  if (!commercePageActive || commerceSurfaceBlocked) return;
  const entry = requestedTabId ? productViews.get(requestedTabId) : null;
  // 显示请求必须指向主进程当前活动的商品标签。迟到的旧标签回调不能
  // 借助 activeProductEntry() 的历史回退值重新抢回顶层视图。
  if (!entry || entry.id !== activeProductTabId) return;
  applyProductViewVisibility(entry, true);
  void syncProductSurfaceBoundsFromRenderer();
  scheduleCommerceSurfaceResync();
});
ipcMain.handle('commerce:capture-operations', () => captureOperations());
ipcMain.handle('commerce:capture-merchant-report', (_event, kind) => captureMerchantReport(String(kind || 'operations')));
ipcMain.handle('commerce:import-merchant-report', (_event, kind) => importMerchantReport(String(kind || 'operations')));
ipcMain.handle('commerce:capture-product', async (_event, options) => {
  const requestedTabId = String(options?.tabId || '').trim();
  const capturedEntry = requestedTabId ? productViews.get(requestedTabId) : activeProductEntry();
  const capturedWebContents = capturedEntry?.view?.webContents;
  // 若已有采集在运行，本次调用只是重复请求，不能在 finally 中清掉第一条
  // 采集的运行锁；否则下一次点击会并发启动第二套评价/问大家采集。
  const hadActiveCollection = Boolean(capturedWebContents && activeDabiCollections.has(capturedWebContents.id));
  try { return await captureProduct(options || {}); }
  finally {
    if (capturedWebContents && !hadActiveCollection) {
      const activeToken = activeDabiCollections.get(capturedWebContents.id);
      activeDabiCollections.delete(capturedWebContents.id);
      void activeToken?.cleanup?.();
      void setDabiAgentOverlay(capturedEntry, false, '');
    }
  }
});
ipcMain.handle('commerce:stop-collection', () => stopActiveDabiCollection());
ipcMain.handle('commerce:capture-page-context', (_event, options) => capturePageContext(options || {}));
ipcMain.handle('commerce:capture-assistant-context', (_event, options) => captureAssistantContext(options || {}));
ipcMain.handle('commerce:session-status', () => sessionStatus());
ipcMain.handle('commerce:clear-session', () => clearCommerceSession());
ipcMain.handle('commerce:agent-action', (_event, action) => executeSafePageAction(action));
ipcMain.handle('commerce:status', () => {
  const entry = activeProductTabId ? productViews.get(activeProductTabId) || null : null;
  const webContents = entry?.view?.webContents || null;
  // 未选择任何商品标签时不要拿全局历史 URL 伪造“当前页面”，否则刚回到
  // 工作应用首页就会把上一页淘宝/1688重新同步进前端。
  const url = normalizeNavigationUrl(entry?.url || '') || currentNavigationUrl(entry);
  const title = webContents?.getTitle?.() || '';
  const verification = Boolean(entry?.verification || isVerificationUrl(url, title));
  return {
    ok: true,
    backend: 'electron',
    url,
    requestedUrl: normalizeNavigationUrl(entry?.requestedUrl || entry?.pendingNavigation || ''),
    navigationRevision: Number(entry?.navigationRevision || 0),
    committedNavigationRevision: Number(entry?.committedNavigationRevision || 0),
    site: safeSite(url),
    title,
    tabId: entry?.id || activeProductTabId,
    ready: Boolean(entry?.pageLoaded),
    verification,
    ...browserSurfaceState(entry),
    visible: isProductViewVisible(entry),
  };
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (!desktopUpdateLaunchInProgress) {
    try { desktopUpdateAbortController?.abort(); } catch {}
  }
  closeDesktopUpdateWindow();
  for (const window of sharedCanvasWindows.keys()) {
    try { if (!window.isDestroyed()) window.destroy(); } catch {}
  }
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
});
