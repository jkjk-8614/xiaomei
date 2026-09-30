'use strict';

const {
  classifyCommerceEndpoint,
  findCommercePayload,
  parseCommerceResponse,
  parseCommerceNetworkRecords,
} = require('../tools/commerce-analysis/commerce-network.cjs');

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
    // 新版淘宝给问答抽屉换过多次 CSS Module 名称；保留旧选择器，
    // 同时覆盖 role/Drawer/QuestionList 这类稳定语义标记。
    content: '[class*="AskAnswersWrap--"] [class*="ContentArea--"], [class*="AskAnswersWrap--"], [class*="leftDrawer"], [role="dialog"][aria-modal="true"], [class*="QuestionDrawer"], [class*="questionDrawer"], [class*="AskDrawer"], [class*="askDrawer"], [class*="QuestionList"], [class*="question-list"], [class*="AskList"], [class*="ask-list"]',
    close: '[class*="leftDrawer"] [class*="closeWrap"], [class*="AskAnswersWrap"] [class*="closeWrap"], [class*="QuestionDrawer"] [class*="close"], [class*="questionDrawer"] [class*="close"], [role="dialog"][aria-modal="true"] button[aria-label*="关闭"]',
  }),
});

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function attachDebugger(webContents) {
  if (!webContents || webContents.isDestroyed()) throw new Error('商品页已关闭');
  let owned = false;
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
    owned = true;
  }
  return owned;
}

function createCommerceNetworkCapture(webContents) {
  const records = { reviews: [], questions: [], detail: [] };
  const requests = new Map();
  const bodyReads = new Set();
  let attachedByUs = false;
  let enabled = false;
  let disposed = false;
  let generation = 0;

  const onMessage = (_event, method, params = {}) => {
    if (disposed) return;
    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      const kind = classifyCommerceEndpoint(request.url);
      if (kind) requests.set(String(params.requestId), {
        kind,
        url: String(request.url || ''),
        requestId: String(params.requestId || ''),
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const response = params.response || {};
      if (String(params.type || '') === 'Preflight') return;
      const requestId = String(params.requestId || '');
      const previous = requests.get(requestId);
      const kind = classifyCommerceEndpoint(response.url) || previous?.kind || '';
      if (!kind) return;
      requests.set(requestId, {
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
      const request = requests.get(requestId);
      if (!request) return;
      requests.delete(requestId);
      const taskGeneration = generation;
      const task = (async () => {
        try {
          const body = await webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
          const raw = body?.base64Encoded
            ? Buffer.from(String(body.body || ''), 'base64').toString('utf8')
            : String(body?.body || '');
          if (!raw || raw.length > 16 * 1024 * 1024) return;
          const data = parseCommerceResponse(raw);
          if (taskGeneration === generation && data && typeof data === 'object') {
            const questionPayload = findCommercePayload(data, 'questions');
            const questionResponse = Object.keys(questionPayload || {}).length > 0;
            const kinds = new Set([request.kind]);
            // Some Tmall revisions reuse a rate endpoint for the Q&A drawer.
            // Classify by the returned payload as well as the URL so a valid
            // questionList is not silently stored in the reviews bucket.
            if (questionResponse) kinds.add('questions');
            for (const kind of kinds) records[kind].push({ ...request, kind, data });
          }
        } catch {
          // 页面导航或请求取消时，响应体可能已经无法读取；保留已有数据。
        }
      })();
      bodyReads.add(task);
      task.finally(() => bodyReads.delete(task));
      return;
    }
    if (method === 'Network.loadingFailed') requests.delete(String(params.requestId || ''));
  };

  const ready = (async () => {
    attachedByUs = await attachDebugger(webContents);
    webContents.debugger.on('message', onMessage);
    await webContents.debugger.sendCommand('Network.enable');
    enabled = true;
  })();

  return {
    records,
    ready,
    async settle(milliseconds = 450) {
      await ready.catch(() => {});
      await pause(Math.max(0, Number(milliseconds) || 0));
      const pending = [...bodyReads];
      if (pending.length) await Promise.allSettled(pending);
    },
    parse(baseUrl = '') {
      return parseCommerceNetworkRecords(records, { baseUrl });
    },
    parseModule(kind, startIndex = 0, baseUrl = '') {
      const name = String(kind || '').trim();
      const offset = Math.max(0, Number(startIndex) || 0);
      const scoped = {
        reviews: name === 'reviews' ? records.reviews.slice(offset) : [],
        questions: name === 'questions' ? records.questions.slice(offset) : [],
        detail: name === 'detail' ? records.detail.slice(offset) : [],
      };
      return parseCommerceNetworkRecords(scoped, { baseUrl });
    },
    reset() {
      generation += 1;
      requests.clear();
      for (const list of Object.values(records)) list.length = 0;
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

const TARGET_SCRIPT = String.raw`(({ selector, reveal }) => {
  const visible = (node) => {
    if (!node) return false;
    try {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { return false; }
  };
  const node = [...document.querySelectorAll(selector || '')].find(visible);
  if (!node) return { ok: false, selector };
  if (reveal) { try { node.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {} }
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return {
    ok: true,
    selector,
    text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    x: Math.round(box.left + box.width / 2),
    y: Math.round(box.top + box.height / 2),
    scrollTop: Number(node.scrollTop || 0),
    scrollHeight: Number(node.scrollHeight || 0),
    clientHeight: Number(node.clientHeight || 0),
    overflowY: String(style.overflowY || ''),
  };
})`;

const DOM_CLICK_SCRIPT = String.raw`(({ selector }) => {
  const visible = (node) => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
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
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const delta = Math.max(240, Number(amount) || 600);
  const node = selector ? [...document.querySelectorAll(selector)].find(visible) : null;
  if (node) {
    const before = Number(node.scrollTop || 0);
    const limit = Math.max(0, Number(node.scrollHeight || 0) - Number(node.clientHeight || 0));
    node.scrollTop = Math.min(limit, before + delta);
    try { node.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
    return { ok: true, changed: node.scrollTop !== before, atEnd: node.scrollTop >= limit - 8, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
  }
  const before = Number(window.scrollY || document.documentElement?.scrollTop || 0);
  try { window.scrollBy(0, delta); } catch {}
  const after = Number(window.scrollY || document.documentElement?.scrollTop || 0);
  const limit = Math.max(0, Number(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0) - Number(window.innerHeight || 0));
  return { ok: true, changed: after !== before, atEnd: after >= limit - 8, scrollTop: after, scrollHeight: limit + Number(window.innerHeight || 0), clientHeight: Number(window.innerHeight || 0) };
})`;

async function resolveTarget(webContents, selector, reveal = false) {
  return webContents.executeJavaScript(
    `(${TARGET_SCRIPT})(${JSON.stringify({ selector, reveal })})`,
    true,
  );
}

async function mouseEvent(webContents, type, x, y, extra = {}) {
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,
    x: Math.max(1, Math.round(Number(x) || 1)),
    y: Math.max(1, Math.round(Number(y) || 1)),
    ...extra,
  });
}

function createCommerceVisibleAgent(webContents, options = {}) {
  const ready = attachDebugger(webContents);
  const backgrounded = async () => {
    try {
      if (typeof options.isBackgrounded === 'function' && await options.isBackgrounded()) return true;
    } catch {}
    return webContents.executeJavaScript(
      'Boolean(document.hidden || document.visibilityState !== "visible")',
      true,
    ).catch(() => false);
  };
  const screenshot = async () => {
    await ready;
    const result = await webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'jpeg', quality: 70, fromSurface: true,
    });
    return { mimeType: 'image/jpeg', data: String(result?.data || '') };
  };
  const scrollPage = async (amount = 600) => {
    await ready;
    const delta = Math.max(240, Number(amount) || 600);
    if (await backgrounded()) {
      const result = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ amount: delta })})`, true).catch(() => null);
      if (result?.ok) return { ...result, input: 'dom' };
    }
    const size = webContents.getContentSize?.() || [900, 700];
    const x = Math.max(1, Math.floor(Number(size[0]) || 900) / 2);
    const y = Math.max(1, Math.floor(Number(size[1]) || 700) / 2);
    const before = await webContents.executeJavaScript('Number(window.scrollY || document.documentElement?.scrollTop || 0)', true).catch(() => null);
    await mouseEvent(webContents, 'mouseMoved', x, y).catch(() => {});
    await mouseEvent(webContents, 'mouseWheel', x, y, { deltaX: 0, deltaY: delta }).catch(() => {});
    await pause(140);
    const after = await webContents.executeJavaScript('Number(window.scrollY || document.documentElement?.scrollTop || 0)', true).catch(() => null);
    if (Number.isFinite(Number(before)) && Number(after) !== Number(before)) return { ok: true, changed: true, input: 'cdp' };
    const fallback = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ amount: delta })})`, true).catch(() => null);
    return fallback?.ok ? { ...fallback, input: 'dom' } : { ok: true, changed: false, atEnd: true, input: 'cdp' };
  };
  const scrollUntilSelector = async (selector, maxPasses = 24) => {
    let target = await resolveTarget(webContents, selector, true).catch(() => null);
    let unchanged = 0;
    for (let pass = 0; pass < Math.max(1, Number(maxPasses) || 24); pass += 1) {
      if (target?.ok) return target;
      const result = await scrollPage(600);
      unchanged = result?.changed ? 0 : unchanged + 1;
      await pause(260);
      target = await resolveTarget(webContents, selector, true).catch(() => null);
      if (target?.ok || (result?.atEnd && unchanged >= 2)) break;
    }
    return target;
  };
  const clickSelector = async (selector, clickOptions = {}) => {
    await ready;
    let target = await resolveTarget(webContents, selector, true).catch(() => null);
    if (!target?.ok && clickOptions.scrollUntil) target = await scrollUntilSelector(selector, clickOptions.maxScrollPasses || 24);
    if (!target?.ok) return { ok: false, selector, reason: '目标当前不可见' };
    if (await backgrounded()) {
      const result = await webContents.executeJavaScript(`(${DOM_CLICK_SCRIPT})(${JSON.stringify({ selector })})`, true).catch(() => null);
      if (result?.ok) return { ...result, x: target.x, y: target.y, input: 'dom' };
    }
    await mouseEvent(webContents, 'mouseMoved', target.x, target.y);
    await pause(25);
    await mouseEvent(webContents, 'mousePressed', target.x, target.y, { button: 'left', buttons: 1, clickCount: 1 });
    await pause(40);
    await mouseEvent(webContents, 'mouseReleased', target.x, target.y, { button: 'left', buttons: 0, clickCount: 1 });
    return { ok: true, selector, text: target.text, x: target.x, y: target.y, input: 'cdp' };
  };
  const scrollSelector = async (selector, amount = 600) => {
    await ready;
    const target = selector ? await resolveTarget(webContents, selector, false).catch(() => null) : null;
    if (selector && !target?.ok) return { ok: false, selector, amount, changed: false, atEnd: true, targetMissing: true, reason: '目标采集内容区域当前不可见' };
    if (await backgrounded()) {
      const result = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector, amount })})`, true).catch(() => null);
      if (result?.ok) return { ...result, selector, input: 'dom' };
    }
    const size = webContents.getContentSize?.() || [900, 700];
    const x = target?.x || Math.max(1, Math.floor(Number(size[0]) || 900) / 2);
    const y = target?.y || Math.max(1, Math.floor(Number(size[1]) || 700) / 2);
    const before = target?.scrollTop;
    await mouseEvent(webContents, 'mouseMoved', x, y);
    await mouseEvent(webContents, 'mouseWheel', x, y, { deltaX: 0, deltaY: Number(amount) || 600 });
    await pause(130);
    const after = selector ? await resolveTarget(webContents, selector, false).catch(() => null) : null;
    const changed = target?.ok && after?.ok ? after.scrollTop !== before : Boolean(after?.ok);
    if (!changed) {
      const result = await webContents.executeJavaScript(`(${DOM_SCROLL_SCRIPT})(${JSON.stringify({ selector, amount })})`, true).catch(() => null);
      if (result?.ok) return { ...result, selector, input: 'dom' };
    }
    return { ok: true, selector, amount: Number(amount) || 600, changed, atEnd: Boolean(after?.ok && after.scrollTop + after.clientHeight >= after.scrollHeight - 8), text: after?.text || target?.text || '', input: 'cdp' };
  };
  const pressKey = async (key = 'Enter', code = key, windowsVirtualKeyCode = key === 'Enter' ? 13 : 0) => {
    await ready;
    const payload = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers: 0 };
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...payload, text: key === 'Enter' ? '\r' : undefined, unmodifiedText: key === 'Enter' ? '\r' : undefined });
    await pause(20);
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
    return { ok: true, key };
  };
  return { ready, screenshot, clickSelector, scrollSelector, scrollPage, scrollUntilSelector, pressKey, targets: MODULE_TARGETS };
}

module.exports = { MODULE_TARGETS, createCommerceNetworkCapture, createCommerceVisibleAgent };
