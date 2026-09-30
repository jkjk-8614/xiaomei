'use strict';

const {
  classifyDabiEndpoint,
  parseDabiResponseBody,
  parseDabiNetworkRecords,
} = require('../tools/commerce-analysis/dabi-taobao.cjs');

const MODULE_TARGETS = Object.freeze({
  reviews: Object.freeze({
    label: '用户评价',
    entry: '[class*="ShowButton"], [class*="footer"] [class*="ShowButton"]',
    content: '[class*="detailContentClassName"] [class*="Comment"] [class*="comments"]',
    close: '[class*="detailContentClassName"] [class*="closeWrap"]',
  }),
  questions: Object.freeze({
    label: '问大家',
    entry: '[class*="bottomBtnWrap"] > [class*="bottomBtn"], [class*="bottomBtn--"]',
    content: '[class*="AskAnswersWrap--"] [class*="ContentArea--"]',
    close: '[class*="leftDrawer"] [class*="closeWrap"], [class*="AskAnswersWrap"] [class*="closeWrap"]',
  }),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDebugger(webContents) {
  if (!webContents || webContents.isDestroyed()) throw new Error('商品页 WebContents 已销毁');
  let attachedByUs = false;
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
    attachedByUs = true;
  }
  return { attachedByUs };
}

function createDabiNetworkCapture(webContents) {
  const records = { reviews: [], questions: [], detail: [] };
  const pending = new Map();
  const bodyTasks = new Set();
  let attachedByUs = false;
  let enabled = false;
  let disposed = false;
  let generation = 0;

  const onMessage = (_event, method, params = {}) => {
    if (disposed) return;
    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      const kind = classifyDabiEndpoint(request.url);
      if (kind) pending.set(String(params.requestId), { kind, url: String(request.url || ''), requestId: String(params.requestId) });
      return;
    }
    if (method === 'Network.responseReceived') {
      const response = params.response || {};
      if (String(params.type || '') === 'Preflight') return;
      const requestId = String(params.requestId || '');
      const previous = pending.get(requestId);
      const kind = classifyDabiEndpoint(response.url) || previous?.kind || '';
      if (!kind) return;
      pending.set(requestId, {
        ...(previous || {}),
        kind,
        requestId,
        url: String(response.url || previous?.url || ''),
        status: Number(response.status || 0),
        mimeType: String(response.mimeType || ''),
      });
      return;
    }
    if (method === 'Network.loadingFinished') {
      const requestId = String(params.requestId || '');
      const candidate = pending.get(requestId);
      if (!candidate) return;
      pending.delete(requestId);
      const taskGeneration = generation;
      const task = (async () => {
        try {
          const body = await webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
          const raw = body?.base64Encoded
            ? Buffer.from(String(body.body || ''), 'base64').toString('utf8')
            : String(body?.body || '');
          if (!raw || raw.length > 16 * 1024 * 1024) return;
          const data = parseDabiResponseBody(raw);
          if (taskGeneration === generation && data && typeof data === 'object') records[candidate.kind].push({ ...candidate, data });
        } catch {
          // 页面切换或淘宝取消请求时，响应体可能已经不可读；不把页面文字
          // 伪装成样本，保留已有真实响应即可。
        }
      })();
      bodyTasks.add(task);
      task.finally(() => bodyTasks.delete(task));
      return;
    }
    if (method === 'Network.loadingFailed') pending.delete(String(params.requestId || ''));
  };

  const ready = (async () => {
    const state = await ensureDebugger(webContents);
    attachedByUs = state.attachedByUs;
    webContents.debugger.on('message', onMessage);
    await webContents.debugger.sendCommand('Network.enable');
    enabled = true;
  })();

  return {
    records,
    ready,
    async settle(waitMs = 450) {
      await ready.catch(() => {});
      await sleep(Math.max(0, Number(waitMs) || 0));
      const tasks = [...bodyTasks];
      if (tasks.length) await Promise.allSettled(tasks);
    },
    parse(baseUrl = '') {
      return parseDabiNetworkRecords(records, { baseUrl });
    },
    parseModule(kind, startIndex = 0, baseUrl = '') {
      const module = String(kind || '').trim();
      const offset = Math.max(0, Number(startIndex) || 0);
      const scoped = {
        reviews: module === 'reviews' ? records.reviews.slice(offset) : [],
        questions: module === 'questions' ? records.questions.slice(offset) : [],
        detail: module === 'detail' ? records.detail.slice(offset) : [],
      };
      return parseDabiNetworkRecords(scoped, { baseUrl });
    },
    reset() {
      generation += 1;
      pending.clear();
      for (const key of Object.keys(records)) records[key].length = 0;
    },
    async dispose() {
      disposed = true;
      await ready.catch(() => {});
      try { webContents.debugger.removeListener('message', onMessage); } catch {}
      if (enabled) await webContents.debugger.sendCommand('Network.disable').catch(() => {});
      if (attachedByUs && webContents.debugger.isAttached()) {
        try { webContents.debugger.detach(); } catch {}
      }
    },
  };
}

const TARGET_RESOLVE_SCRIPT = String.raw`(({ selector, scrollIntoView = false }) => {
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const nodes = [...document.querySelectorAll(selector || '')].filter(visible);
  const node = nodes[0];
  if (!node) return { ok: false, selector };
  if (scrollIntoView) { try { node.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {} }
  const rect = node.getBoundingClientRect();
  const scrollStyle = getComputedStyle(node);
  return {
    ok: true,
    selector,
    text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scrollTop: Number(node.scrollTop || 0),
    scrollHeight: Number(node.scrollHeight || 0),
    clientHeight: Number(node.clientHeight || 0),
    overflowY: String(scrollStyle.overflowY || ''),
  };
})`;

// WebContentsView 在主窗口最小化、失焦或被其它工作区遮住时，CDP 的
// Input.dispatchMouseEvent 可能不会真正交给页面。后台采集仍然只操作
// 白名单 DOM 目标，因此在鼠标动作没有产生页面变化时，用同一目标做一次
// 页面内回退；前台仍优先使用截图识别后的 CDP 鼠标/滚轮动作。
const DOM_CLICK_SCRIPT = String.raw`(({ selector }) => {
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const node = [...document.querySelectorAll(selector || '')].find(visible);
  if (!node) return { ok: false, selector, reason: '目标当前不可见' };
  try {
    node.click();
    return { ok: true, selector, text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
  } catch (error) {
    return { ok: false, selector, reason: String(error?.message || error) };
  }
})`;

const DOM_SCROLL_SCRIPT = String.raw`(({ selector, amount }) => {
  const visible = (node) => {
    if (!node) return false;
    try {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const delta = Math.max(240, Number(amount) || 600);
  const root = selector ? [...document.querySelectorAll(selector)].find(visible) : null;
  if (root) {
    const before = Number(root.scrollTop || 0);
    const limit = Math.max(0, Number(root.scrollHeight || 0) - Number(root.clientHeight || 0));
    root.scrollTop = Math.min(limit, before + delta);
    if (root.scrollTop !== before) {
      try { root.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
    }
    return {
      ok: true,
      selector,
      amount: delta,
      changed: root.scrollTop !== before,
      atEnd: limit <= 0 || root.scrollTop >= limit - 8,
      scrollTop: Number(root.scrollTop || 0),
      scrollHeight: Number(root.scrollHeight || 0),
      clientHeight: Number(root.clientHeight || 0),
    };
  }
  const before = Number(window.scrollY || document.documentElement?.scrollTop || 0);
  try { window.scrollBy(0, delta); } catch {}
  const after = Number(window.scrollY || document.documentElement?.scrollTop || 0);
  const limit = Math.max(0, Number(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0) - Number(window.innerHeight || 0));
  return { ok: true, selector, amount: delta, changed: after !== before, atEnd: limit <= 0 || after >= limit - 8, scrollTop: after, scrollHeight: limit + Number(window.innerHeight || 0), clientHeight: Number(window.innerHeight || 0) };
})`;

const PAGE_HIDDEN_SCRIPT = 'Boolean(document.hidden || document.visibilityState !== "visible")';

async function resolveTarget(webContents, selector, scrollIntoView = false) {
  const expression = `(${TARGET_RESOLVE_SCRIPT})(${JSON.stringify({ selector, scrollIntoView })})`;
  return webContents.executeJavaScript(expression, true);
}

async function dispatchMouse(webContents, type, x, y, extra = {}) {
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,
    x: Math.max(1, Math.round(Number(x) || 1)),
    y: Math.max(1, Math.round(Number(y) || 1)),
    ...extra,
  });
}

async function clickAt(webContents, target) {
  const startX = Math.max(1, Number(target.x) || 1);
  const startY = Math.max(1, Number(target.y) || 1);
  await dispatchMouse(webContents, 'mouseMoved', startX, startY);
  await sleep(30);
  await dispatchMouse(webContents, 'mousePressed', startX, startY, { button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await dispatchMouse(webContents, 'mouseReleased', startX, startY, { button: 'left', buttons: 0, clickCount: 1 });
}

async function captureScreenshot(webContents) {
  const result = await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 70,
    fromSurface: true,
  });
  return { mimeType: 'image/jpeg', data: String(result?.data || '') };
}

function createDabiVisibleAgent(webContents, options = {}) {
  const ready = ensureDebugger(webContents);
  const isBackgrounded = async () => {
    try {
      if (typeof options.isBackgrounded === 'function' && await options.isBackgrounded()) return true;
    } catch {}
    return webContents.executeJavaScript(PAGE_HIDDEN_SCRIPT, true).catch(() => false);
  };
  const screenshot = async () => {
    await ready;
    return captureScreenshot(webContents);
  };
  const scrollPage = async (amount = 600) => {
    await ready;
    const delta = Math.max(240, Number(amount) || 600);
    const backgrounded = await isBackgrounded();
    if (backgrounded) {
      const fallback = await webContents.executeJavaScript(
        `(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector: null, amount: delta })})`,
        true,
      ).catch(() => null);
      if (fallback?.ok) return { ...fallback, input: 'dom-background-fallback' };
    }
    let size = [900, 700];
    try { size = webContents.getContentSize?.() || size; } catch {}
    const x = Math.max(1, Math.floor(Number(size?.[0]) || 900) / 2);
    const y = Math.max(1, Math.floor(Number(size?.[1]) || 700) / 2);
    const before = await webContents.executeJavaScript(
      'Number(window.scrollY || document.documentElement?.scrollTop || 0)',
      true,
    ).catch(() => null);
    await dispatchMouse(webContents, 'mouseMoved', x, y).catch(() => {});
    await dispatchMouse(webContents, 'mouseWheel', x, y, { deltaX: 0, deltaY: delta }).catch(() => {});
    await sleep(140);
    const after = await webContents.executeJavaScript(
      'Number(window.scrollY || document.documentElement?.scrollTop || 0)',
      true,
    ).catch(() => null);
    const changed = Number.isFinite(Number(before)) && Number.isFinite(Number(after))
      ? Number(after) !== Number(before)
      : false;
    if (changed) return { ok: true, amount: delta, changed, input: 'cdp-mouse-wheel' };
    const fallback = await webContents.executeJavaScript(
      `(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector: null, amount: delta })})`,
      true,
    ).catch(() => null);
    return fallback?.ok
      ? { ...fallback, input: 'dom-scroll-fallback' }
      : { ok: true, amount: delta, changed: false, atEnd: true, input: 'cdp-mouse-wheel' };
  };
  const scrollUntilSelector = async (selector, maxPasses = 24) => {
    let target = await resolveTarget(webContents, selector, true);
    let unchanged = 0;
    for (let pass = 0; pass < Math.max(1, Number(maxPasses) || 24); pass += 1) {
      if (target?.ok) return target;
      const result = await scrollPage(600);
      if (result?.changed) unchanged = 0;
      else unchanged += 1;
      await sleep(260);
      target = await resolveTarget(webContents, selector, true);
      if (target?.ok) return target;
      if (result?.atEnd && unchanged >= 2) break;
    }
    return target;
  };
  const clickSelector = async (selector, options = {}) => {
    await ready;
    let target = await resolveTarget(webContents, selector, true);
    if (!target?.ok && options.scrollUntil) {
      target = await scrollUntilSelector(selector, options.maxScrollPasses || 24);
    }
    if (!target?.ok) return { ok: false, selector, reason: '目标当前不可见' };
    if (await isBackgrounded()) {
      const clicked = await webContents.executeJavaScript(`(${DOM_CLICK_SCRIPT})(${JSON.stringify({ selector })})`, true).catch(() => null);
      if (clicked?.ok) return { ...clicked, x: target.x, y: target.y, input: 'dom-background-fallback' };
    }
    const refreshed = await resolveTarget(webContents, selector, false);
    await clickAt(webContents, refreshed?.ok ? refreshed : target);
    return { ok: true, selector, text: target.text, x: target.x, y: target.y };
  };
  const scrollSelector = async (selector, amount = 600) => {
    await ready;
    const target = selector ? await resolveTarget(webContents, selector, false) : null;
    // 模块采集只能滚动目标抽屉。目标不存在时如果继续回退到整页滚动，
    // 会把“上一个模块的抽屉仍未关闭”误判成采集进度，并白跑满全部轮次。
    if (selector && !target?.ok) {
      return {
        ok: false,
        selector,
        amount: Number(amount) || 600,
        changed: false,
        atEnd: true,
        targetMissing: true,
        reason: '目标采集内容区域当前不可见',
      };
    }
    if (await isBackgrounded()) {
      const fallback = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector, amount })})`, true).catch(() => null);
      if (fallback?.ok) return { ...fallback, text: target?.text || '' , input: 'dom-background-fallback' };
    }
    const x = target?.ok ? target.x :  Math.max(1, Math.floor((Number(webContents.getContentSize?.()[0]) || 900) / 2));
    const y = target?.ok ? target.y :  Math.max(1, Math.floor((Number(webContents.getContentSize?.()[1]) || 700) / 2));
    const before = target?.ok ? target.scrollTop : null;
    await dispatchMouse(webContents, 'mouseMoved', x, y);
    await dispatchMouse(webContents, 'mouseWheel', x, y, { deltaX: 0, deltaY: Number(amount) || 600 });
    await sleep(130);
    const after = selector ? await resolveTarget(webContents, selector, false) : null;
    const mouseChanged = target?.ok && after?.ok ? after.scrollTop !== before : Boolean(after?.ok);
    if (!mouseChanged) {
      const fallback = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector, amount })})`, true).catch(() => null);
      if (fallback?.ok) return { ...fallback, text: after?.text || target?.text || '', input: 'dom-scroll-fallback' };
    }
    return {
      ok: true,
      selector,
      amount: Number(amount) || 600,
      changed: mouseChanged,
      atEnd: Boolean(after?.ok && after.scrollHeight > 0 && after.scrollTop + after.clientHeight >= after.scrollHeight - 8),
      text: after?.text || target?.text || '',
    };
  };
  const pressKey = async (key = 'Enter', code = key, windowsVirtualKeyCode = key === 'Enter' ? 13 : 0) => {
    await ready;
    const payload = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers: 0 };
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...payload, text: key === 'Enter' ? '\r' : undefined, unmodifiedText: key === 'Enter' ? '\r' : undefined });
    await sleep(20);
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
    return { ok: true, key };
  };
  return { ready, screenshot, clickSelector, scrollSelector, scrollPage, scrollUntilSelector, pressKey, targets: MODULE_TARGETS };
}

module.exports = {
  MODULE_TARGETS,
  createDabiNetworkCapture,
  createDabiVisibleAgent,
};
