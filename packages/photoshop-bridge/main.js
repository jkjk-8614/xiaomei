const BRIDGE_VERSION = "1.0.2";

let photoshopApi = null;
let uxpApi = null;
let app = null;
let core = null;
let action = null;
let imaging = null;
let fs = null;
let formats = null;

let autoTimer = null;
let statusTimer = null;
let heartbeatTimer = null;
let busy = false;
let layerSendBusy = false;
let initialized = false;
let latestStatus = null;
let lastBridgeLogKey = "";
let bridgeId = "";
let bridgeName = "";
let canvasOptions = [];
let targetCanvasId = "";
let targetListOpen = false;
let matchOriginalTarget = null;
let matchOriginalBusy = false;

function $(id) {
  return document.querySelector(`#${id}`);
}

function serverBase() {
  return ($("serverInput")?.value || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

function selectedCanvasId() {
  return targetCanvasId || "";
}

async function targetCanvasCenterPoint(canvasId) {
  if (!canvasId) return null;
  try {
    const data = await api(`/api/canvases/${encodeURIComponent(canvasId)}`);
    const canvas = data.canvas || data;
    const viewport = canvas && typeof canvas.viewport === "object" ? canvas.viewport : {};
    const scale = Math.max(0.01, Number(viewport.scale || 1));
    const viewWidth = Number(viewport.viewWidth || viewport.width || 1280);
    const viewHeight = Number(viewport.viewHeight || viewport.height || 720);
    const x = (viewWidth / 2 - Number(viewport.x || 0)) / scale;
    const y = (viewHeight / 2 - Number(viewport.y || 0)) / scale;
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  } catch (err) {
    pluginLog(`canvas center fallback: ${err.message || err}`, "warn");
  }
  return null;
}

function saveSelectedCanvasId(canvasId) {
  try { localStorage.setItem("infiniteCanvasBridgeTargetCanvasId", canvasId || ""); } catch (_) {}
}

function savedSelectedCanvasId() {
  try { return localStorage.getItem("infiniteCanvasBridgeTargetCanvasId") || ""; } catch (_) { return ""; }
}

function bridgeStorageKey(name) {
  return `infiniteCanvasBridge:${name}`;
}

function loadBridgeIdentity() {
  try {
    bridgeId = localStorage.getItem(bridgeStorageKey("bridgeId")) || "";
    bridgeName = localStorage.getItem(bridgeStorageKey("bridgeName")) || "";
  } catch (_) {}
  if (!bridgeId) {
    bridgeId = `ps-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    try { localStorage.setItem(bridgeStorageKey("bridgeId"), bridgeId); } catch (_) {}
  }
  if (!bridgeName) {
    bridgeName = `Photoshop ${bridgeId.slice(-4)}`;
    try { localStorage.setItem(bridgeStorageKey("bridgeName"), bridgeName); } catch (_) {}
  }
}

function bridgeSessionLabel() {
  return `${bridgeName || "Photoshop"} (${bridgeId || "no-id"})`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function statusLabel(status) {
  return {
    pending: "待导入",
    taken: "已领取",
    delivered: "已领取",
    importing: "导入中",
    done: "已导入",
    error: "失败"
  }[status || ""] || status || "未知";
}

function setStatus(text, kind = "") {
  const statusText = $("statusText");
  const statusDot = $("statusDot");
  if (statusText) statusText.textContent = text;
  if (statusDot) {
    const color = kind === "ready" ? "#74c0fc" : kind === "error" ? "#ff8787" : "#737b86";
    statusDot.style.background = color;
    statusDot.style.boxShadow = `0 0 0 4px ${kind === "ready" ? "rgba(116,192,252,.16)" : kind === "error" ? "rgba(255,135,135,.16)" : "rgba(115,123,134,.16)"}`;
  }
}

function logLine(text) {
  const log = $("log");
  if (!log) return;
  const stamp = new Date().toLocaleTimeString();
  log.textContent = `[${stamp}] ${text}\n${log.textContent}`.slice(0, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(`${serverBase()}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const detail = data.detail || data.error || "";
    if (detail && typeof detail === "object") {
      const err = new Error(detail.message || detail.code || `Request failed: ${response.status}`);
      err.code = detail.code || "";
      throw err;
    }
    if (response.status === 404 && path.includes("/canvas-send")) {
      throw new Error("后端未加载 PS→画布接口，请重启无限画布服务或重新安装更新包。");
    }
    throw new Error(detail || `Request failed: ${response.status}`);
  }
  return data;
}

function pluginLog(message, level = "info") {
  fetch(`${serverBase()}/api/photoshop-bridge/plugin-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, message })
  }).catch(() => {});
}

async function loadCanvasOptions() {
  try {
    const data = await api("/api/canvases");
    canvasOptions = Array.isArray(data.canvases) ? data.canvases : [];
    pluginLog(`canvas list loaded ${canvasOptions.length}`);
    renderCanvasOptions();
  } catch (err) {
    logLine(`画布列表加载失败：${err.message || err}`);
    const currentButton = $("targetCanvasCurrentBtn");
    if (currentButton) currentButton.textContent = "画布列表加载失败";
    const debug = $("targetCanvasDebug");
    if (debug) debug.textContent = "请确认无限画布服务已启动。";
  }
}

function renderCanvasOptions() {
  const currentButton = $("targetCanvasCurrentBtn");
  const debug = $("targetCanvasDebug");
  if (!currentButton) return;
  const saved = savedSelectedCanvasId();
  const query = String($("targetSearchInput")?.value || "").trim().toLowerCase();
  const filtered = canvasOptions.filter(item => {
    const title = String(item.title || "").toLowerCase();
    const owner = String(item.owner || "").toLowerCase();
    return !query || title.includes(query) || owner.includes(query) || String(item.id || "").includes(query);
  });
  const preferred = canvasOptions.find(item => item.id === targetCanvasId) || canvasOptions.find(item => item.id === saved) || filtered[0] || canvasOptions[0] || null;
  targetCanvasId = preferred?.id || "";
  const current = canvasOptions.find(item => item.id === targetCanvasId);
  currentButton.innerHTML = current
    ? `<span class="target-current-icon"></span><span>${escapeHtml(current.title || "未命名画布")}（${current.kind === "smart" ? "智能画布" : "普通画布"}）</span><span class="target-current-check"></span>`
    : `<span></span><span>未找到可用画布</span><span></span>`;
  currentButton.disabled = !canvasOptions.length;
  if (debug) debug.textContent = query ? `已识别 ${canvasOptions.length} 个画布，匹配 ${filtered.length} 个` : `已识别 ${canvasOptions.length} 个画布`;
  const menu = $("targetCanvasMenu");
  if (menu) {
    menu.style.display = targetListOpen ? "block" : "none";
    menu.innerHTML = filtered.map(item => {
      const kind = item.kind === "smart" ? "智能画布" : "普通画布";
      const active = item.id === targetCanvasId ? " active" : "";
      return `<button class="target-menu-item${active}" type="button" data-canvas-id="${escapeHtml(item.id)}">
        <span>${escapeHtml(item.title || "未命名画布")}</span>
        <small>${kind}</small>
      </button>`;
    }).join("") || `<div class="target-menu-empty">没有匹配的画布</div>`;
  }
  const toggleBtn = $("targetToggleBtn");
  if (toggleBtn) toggleBtn.textContent = targetListOpen ? "收起列表" : "展开选择";
  const hint = $("targetCanvasHint");
  if (hint) {
    hint.innerHTML = current ? `将发送到： <strong>${escapeHtml(current.title || "未命名画布")}（${current.kind === "smart" ? "智能画布" : "普通画布"}）</strong>` : "没有可用画布";
  }
}

function selectTargetCanvas(canvasId) {
  const item = canvasOptions.find(option => option.id === canvasId);
  if (!item) return;
  targetCanvasId = item.id;
  saveSelectedCanvasId(item.id);
  targetListOpen = false;
  renderCanvasOptions();
}

function moveTargetCanvas(step) {
  if (!canvasOptions.length) return;
  const currentIndex = Math.max(0, canvasOptions.findIndex(item => item.id === targetCanvasId));
  const nextIndex = (currentIndex + step + canvasOptions.length) % canvasOptions.length;
  selectTargetCanvas(canvasOptions[nextIndex].id);
}

function loadHostApis() {
  if (photoshopApi && uxpApi) return true;
  try {
    photoshopApi = require("photoshop");
    uxpApi = require("uxp");
    app = photoshopApi.app;
    core = photoshopApi.core;
    action = photoshopApi.action;
    imaging = photoshopApi.imaging;
    fs = uxpApi.storage.localFileSystem;
    formats = uxpApi.storage.formats;
    return true;
  } catch (err) {
    setStatus("Photoshop API 加载失败。", "error");
    logLine(err.message || String(err));
    pluginLog(err.message || String(err), "error");
    return false;
  }
}

function activeDocumentOpen() {
  return Boolean(app && app.documents && app.documents.length);
}

async function sendHeartbeat() {
  loadHostApis();
  try {
    await api("/api/photoshop-bridge/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: BRIDGE_VERSION,
        status: busy ? "importing" : "online",
        active_document: activeDocumentOpen(),
        auto_import: Boolean(autoTimer),
        bridge_id: bridgeId,
        bridge_name: bridgeName
      })
    });
  } catch (_) {}
}

function currentBridgeId() {
  return bridgeId || "";
}

function setQueueEmpty(message = "从无限画布点击回传后会出现在这里。") {
  const preview = $("queuePreview");
  if (preview) preview.innerHTML = "<span>无图片</span>";
  const title = $("queueTitle");
  if (title) title.textContent = "暂无队列图片";
  const sub = $("queueSub");
  if (sub) sub.textContent = message;
  const count = $("queueCountText");
  if (count) count.textContent = "0 待导入";
}

function unitValue(value) {
  if (value && typeof value === "object") return Number(value._value ?? value.value ?? 0);
  return Number(value || 0);
}

function normalizeBounds(raw) {
  const bounds = raw?.boundsNoEffects || raw?.bounds || raw || {};
  const left = unitValue(bounds.left);
  const top = unitValue(bounds.top);
  const right = unitValue(bounds.right);
  const bottom = unitValue(bounds.bottom);
  const width = right - left;
  const height = bottom - top;
  if (![left, top, right, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("无法读取图层边界，图层可能为空或不可见。");
  }
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2
  };
}

function activeLayerIdentity() {
  if (!activeDocumentOpen()) throw new Error("请先打开一个 Photoshop 文档。");
  const doc = app.activeDocument;
  const layer = doc.activeLayers && doc.activeLayers[0];
  if (!layer) throw new Error("请先选中一个图层。");
  const documentID = doc.id || doc._id;
  const layerID = layer.id || layer._id;
  if (!documentID || !layerID) throw new Error("无法读取当前文档或图层 ID。");
  return {
    documentID,
    layerID,
    layerName: layer.name || "未命名图层",
    documentName: doc.title || doc.name || "Photoshop Document"
  };
}

async function layerBoundsById(layerID) {
  const result = await action.batchPlay([{
    _obj: "get",
    _target: [
      { _property: "boundsNoEffects" },
      { _ref: "layer", _id: layerID }
    ]
  }], { synchronousExecution: true, modalBehavior: "execute" });
  try {
    return normalizeBounds(result?.[0]);
  } catch (_) {
    const fallback = await action.batchPlay([{
      _obj: "get",
      _target: [
        { _property: "bounds" },
        { _ref: "layer", _id: layerID }
      ]
    }], { synchronousExecution: true, modalBehavior: "execute" });
    return normalizeBounds(fallback?.[0]);
  }
}

function updateMatchOriginalUi() {
  const btn = $("matchOriginalBtn");
  const hint = $("matchOriginalHint");
  if (btn) {
    btn.disabled = matchOriginalBusy;
    btn.textContent = matchOriginalTarget ? "选择原图后再点" : "匹配原图";
  }
  if (hint) {
    hint.textContent = matchOriginalTarget
      ? `已记录：${matchOriginalTarget.layerName}。现在选中原图层，再点击按钮完成匹配。`
      : "选中回传图层后点击，再选原图层点击匹配。";
  }
}

async function selectLayerById(layerID) {
  await action.batchPlay([{
    _obj: "select",
    _target: [{ _ref: "layer", _id: layerID }],
    makeVisible: false
  }], { synchronousExecution: true, modalBehavior: "execute" });
}

async function transformLayerToBounds(targetLayerID, targetBounds, sourceBounds) {
  const widthPercent = (sourceBounds.width / targetBounds.width) * 100;
  const heightPercent = (sourceBounds.height / targetBounds.height) * 100;
  const dx = sourceBounds.centerX - targetBounds.centerX;
  const dy = sourceBounds.centerY - targetBounds.centerY;
  await action.batchPlay([{
    _obj: "transform",
    _target: [{ _ref: "layer", _id: targetLayerID }],
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: {
      _obj: "offset",
      horizontal: { _unit: "pixelsUnit", _value: dx },
      vertical: { _unit: "pixelsUnit", _value: dy }
    },
    width: { _unit: "percentUnit", _value: widthPercent },
    height: { _unit: "percentUnit", _value: heightPercent },
    linked: false,
    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" }
  }], { synchronousExecution: true, modalBehavior: "execute" });
}

async function matchSelectedLayerToOriginal() {
  if (matchOriginalBusy) return;
  if (!loadHostApis()) return;
  matchOriginalBusy = true;
  updateMatchOriginalUi();
  try {
    const current = activeLayerIdentity();
    if (!matchOriginalTarget) {
      matchOriginalTarget = current;
      setStatus("已记录回传图层，请选中原图层后再次点击匹配原图。", "ready");
      logLine(`已记录回传图层：${current.layerName}`);
      pluginLog(`match original target captured ${current.layerID} ${current.layerName}`);
      return;
    }
    if (current.documentID !== matchOriginalTarget.documentID) {
      throw new Error("原图层和回传图层必须在同一个 Photoshop 文档中。");
    }
    if (current.layerID === matchOriginalTarget.layerID) {
      matchOriginalTarget = null;
      setStatus("已取消匹配原图，请重新选中回传图层开始。", "");
      logLine("已取消匹配原图。");
      return;
    }
    const source = current;
    const target = matchOriginalTarget;
    await core.executeAsModal(async () => {
      const sourceBounds = await layerBoundsById(source.layerID);
      const targetBounds = await layerBoundsById(target.layerID);
      await selectLayerById(target.layerID);
      await transformLayerToBounds(target.layerID, targetBounds, sourceBounds);
    }, { commandName: "Match Infinite Canvas Layer to Original" });
    setStatus(`已按 ${source.layerName} 匹配 ${target.layerName} 的位置和大小。`, "ready");
    logLine(`已匹配原图：${target.layerName} → ${source.layerName}`);
    pluginLog(`matched layer ${target.layerID} to original ${source.layerID}`);
    matchOriginalTarget = null;
  } catch (err) {
    setStatus(err.message || "匹配原图失败。", "error");
    logLine(err.message || String(err));
    pluginLog(err.message || String(err), "error");
  } finally {
    matchOriginalBusy = false;
    updateMatchOriginalUi();
  }
}

async function renderLatest(data) {
  const job = data && data.latest;
  if (!job) {
    setQueueEmpty("桥接已连接，没有待导入图片。");
    return;
  }
  const preview = $("queuePreview");
  if (preview) preview.innerHTML = "<span>待导入</span>";
  const title = $("queueTitle");
  if (title) title.textContent = job.filename || job.name || "Canvas image";
  const sub = $("queueSub");
  if (sub) sub.textContent = `${data.pending || 1} 张待导入 · ${statusLabel(job.status || "pending")}`;
  const count = $("queueCountText");
  if (count) count.textContent = `${data.pending || 1} 待导入`;
}

async function renderRecent(data) {
  const list = $("recentList");
  if (!list) return;
  const jobs = (data && data.recent) || [];
  if (!jobs.length) {
    list.textContent = "暂无最近任务";
    return;
  }
  const rows = jobs.slice(0, 6).map(job => {
    const status = job.status || "pending";
    const color = status === "done" ? "#69db7c" : status === "error" ? "#ff8787" : status === "delivered" ? "#ffd43b" : "#a9b0ba";
    const disabled = status === "done" ? "disabled" : "";
    return `<div style="display:grid;grid-template-columns:44px 1fr 58px;gap:8px;align-items:center;">
      <div style="width:44px;height:44px;border:1px solid #3b4048;border-radius:6px;overflow:hidden;background:#17191d;display:flex;align-items:center;justify-content:center;color:#a9b0ba;font-size:10px;">
        ${escapeHtml(statusLabel(status)).slice(0, 3)}
      </div>
      <div style="min-width:0;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f1f3f5;font-weight:650;">${escapeHtml(job.filename || job.name || "Canvas image")}</div>
        <div style="color:${color};font-size:10px;">${escapeHtml(statusLabel(status))}${job.error ? " · " + escapeHtml(job.error).slice(0, 48) : ""}</div>
      </div>
      <button data-job-id="${escapeHtml(job.id)}" ${disabled} style="min-height:28px;border:1px solid #3b4048;border-radius:6px;background:#25282e;color:#f1f3f5;font-size:11px;font-weight:650;">导入</button>
    </div>`;
  });
  list.innerHTML = rows.join("");
}

async function renderBridgeStatus(data) {
  latestStatus = data || null;
  await renderLatest(data);
  await renderRecent(data);
  const ps = data && data.photoshop;
  const count = $("queueCountText");
  if (count) count.textContent = `${data?.pending || 0} 待导入`;
  if (data && data.pending) {
    const online = ps && ps.online ? "PS 在线" : "PS 离线";
    setStatus(`${data.pending} 张图片待导入。${online}。`, ps && ps.online ? "ready" : "");
  } else {
    setStatus(ps && ps.online ? "已连接，没有待导入图片。" : "等待 Photoshop 插件心跳。", ps && ps.online ? "ready" : "");
  }
}

async function refreshBridgeStatus({ silent = false } = {}) {
  try {
    const data = await api(`/api/photoshop-bridge/status${bridgeId ? `?bridge_id=${encodeURIComponent(bridgeId)}` : ""}`);
    await renderBridgeStatus(data);
    const online = Boolean(data?.photoshop?.online);
    const pending = Number(data?.pending || 0);
    const logKey = `${online}:${pending}`;
    if (logKey !== lastBridgeLogKey) {
      lastBridgeLogKey = logKey;
      logLine(pending ? `检测到 ${pending} 个待导入任务。` : online ? "已连接，正在检查回传队列。" : "正在等待 Photoshop 连接。");
    }
  } catch (err) {
    if (!silent) logLine(`Connection failed: ${err.message || err}`);
    setStatus("无法连接无限画布服务。", "error");
    setQueueEmpty("请确认无限画布服务正在运行。");
  }
}

async function ack(job, status, error = "", importMode = "") {
  try {
    await api("/api/photoshop-bridge/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: job.id, status, error, import_mode: importMode, bridge_id: bridgeId })
    });
  } catch (err) {
    logLine(`Ack failed: ${err.message || err}`);
  }
}

async function downloadJobFile(job) {
  const rawUrl = String(job?.file_url || job?.url || "").trim();
  if (!rawUrl) throw new Error("队列任务没有图片地址。");
  const fileUrl = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `${serverBase()}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  const bytes = await response.arrayBuffer();
  const temp = await fs.getTemporaryFolder();
  const file = await temp.createFile(job.filename || job.name || "infinite-canvas.png", { overwrite: true });
  await file.write(bytes, { format: formats.binary });
  return file;
}

async function ensureImportDocument() {
  if (activeDocumentOpen()) return;
  setStatus("正在创建 Photoshop 文档...", "ready");
  if (typeof app.createDocument !== "function") {
    throw new Error("请先打开或创建一个 Photoshop 文档。");
  }
  await app.createDocument({ name: "Infinite Canvas", width: 1024, height: 1024, resolution: 72 });
}

async function placeEmbedded(file, layerName) {
  const token = fs.createSessionToken(file);
  let importMode = "placed-layer";
  await core.executeAsModal(async () => {
    await action.batchPlay([{
      _obj: "placeEvent",
      null: { _path: token, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: 0 },
        vertical: { _unit: "pixelsUnit", _value: 0 }
      }
    }], { synchronousExecution: true, modalBehavior: "execute" });
    if (layerName && app.activeDocument?.activeLayers?.[0]) {
      app.activeDocument.activeLayers[0].name = layerName;
    }
    try {
      await action.batchPlay([{ _obj: "newPlacedLayer" }], { synchronousExecution: true, modalBehavior: "execute" });
      importMode = "smart-object";
    } catch (_) {
      importMode = "placed-layer";
    }
  }, { commandName: "Import Infinite Canvas Image" });
  return importMode;
}

async function fallbackOpenImage(file) {
  if (typeof app.open !== "function") throw new Error("Photoshop 备用打开方式不可用。");
  await core.executeAsModal(async () => {
    await app.open(file);
  }, { commandName: "Open Infinite Canvas Image" });
  return "opened-document";
}

async function fetchJob(jobId = "") {
  const bridgeParam = bridgeId ? `&bridge_id=${encodeURIComponent(bridgeId)}` : "";
  if (jobId) return await api(`/api/photoshop-bridge/jobs/${encodeURIComponent(jobId)}/take?consume=true${bridgeParam}`);
  return await api(`/api/photoshop-bridge/latest?consume=true${bridgeParam}`);
}

async function importJob(jobId = "", options = {}) {
  if (busy) return;
  if (!loadHostApis()) return;
  const autoMode = Boolean(options.auto);
  busy = true;
  const pullBtn = $("pullBtn");
  let currentJob = null;
  if (pullBtn) pullBtn.disabled = true;
  try {
    setStatus("正在检查回传队列...", "ready");
    const data = await fetchJob(jobId);
    const job = data.job;
    if (!job) {
      if (!autoMode) {
        setStatus("没有待导入图片。", "");
        await refreshBridgeStatus({ silent: true });
      }
      return;
    }
    currentJob = job;
    pluginLog(jobId ? `import job ${job.id}` : `import latest ${job.id}`);
    setStatus(`正在导入 ${job.filename}...`, "ready");
    const file = await downloadJobFile(job);
    let importMode = "";
    try {
      await ensureImportDocument();
      importMode = await placeEmbedded(file, job.name || "Infinite Canvas");
    } catch (placeErr) {
      logLine(`图层导入失败，尝试备用方式：${placeErr.message || placeErr}`);
      importMode = await fallbackOpenImage(file);
    }
    await ack(job, "done", "", importMode);
    pluginLog(`imported ${job.id} ${job.filename} ${importMode}`);
    setStatus(`已导入 ${job.filename}。`, "ready");
    logLine(`已导入 ${job.filename}（${importMode}）`);
    setTimeout(() => {
      sendHeartbeat();
      refreshBridgeStatus({ silent: true });
    }, 0);
  } catch (err) {
    setStatus(err.message || "Import failed.", "error");
    logLine(err.message || String(err));
    pluginLog(err.message || String(err), "error");
    if (currentJob?.id) await ack(currentJob, "error", err.message || String(err));
  } finally {
    if (pullBtn) pullBtn.disabled = false;
    busy = false;
  }
}

function startAutoImport() {
  if (autoTimer) return;
  const autoBtn = $("autoBtn");
  autoTimer = setInterval(() => importJob("", { auto: true }), 800);
  if (autoBtn) autoBtn.textContent = "自动开";
  setStatus("自动导入已开启。", "ready");
  importJob("", { auto: true });
}

function stopAutoImport() {
  if (!autoTimer) return;
  const autoBtn = $("autoBtn");
  clearInterval(autoTimer);
  autoTimer = null;
  if (autoBtn) autoBtn.textContent = "自动关";
  setStatus("自动导入已关闭。", "");
}

function toggleAuto() {
  if (autoTimer) stopAutoImport();
  else startAutoImport();
  sendHeartbeat();
}

async function clearQueue() {
  try {
    await api("/api/photoshop-bridge/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "pending", bridge_id: bridgeId })
    });
    logLine("已清空待导入队列。");
    await refreshBridgeStatus();
  } catch (err) {
    logLine(err.message || String(err));
  }
}

function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function selectDocumentById(documentID) {
  if (!documentID) return;
  await action.batchPlay([{
    _obj: "select",
    _target: [{ _ref: "document", _id: documentID }],
    makeVisible: false
  }], { synchronousExecution: true, modalBehavior: "execute" });
}

async function activeLayerToPngExport() {
  if (!activeDocumentOpen()) throw new Error("请先打开一个 Photoshop 文档。");
  if (!fs || !formats) throw new Error("UXP 文件系统未加载。");
  const doc = app.activeDocument;
  const layer = doc.activeLayers && doc.activeLayers[0];
  if (!layer) throw new Error("请先选中一个图层。");
  const documentID = doc.id || doc._id;
  if (!documentID) throw new Error("无法读取当前文档 ID。");
  const layerName = layer.name || "Photoshop Layer";
  const documentName = doc.title || doc.name || "Photoshop Document";
  const temp = await fs.getTemporaryFolder();
  const file = await temp.createFile(filenameForLayer(layerName), { overwrite: true });
  let exportDoc = null;
  try {
    await core.executeAsModal(async () => {
      const width = Math.max(1, Math.round(Number(doc.width) || 1024));
      const height = Math.max(1, Math.round(Number(doc.height) || 1024));
      exportDoc = await app.createDocument({
        name: "Infinite Canvas Layer Export",
        width,
        height,
        resolution: Number(doc.resolution) || 72,
        mode: "RGBColorMode",
        fill: "transparent"
      });
      await selectDocumentById(documentID);
      await doc.duplicateLayers([layer], exportDoc);
      try {
        await exportDoc.trim("transparent", true, true, true, true);
      } catch (_) {}
      await exportDoc.saveAs.png(file, { compression: 0, interlaced: false, method: "quick" }, true);
      exportDoc.closeWithoutSaving();
      exportDoc = null;
      await selectDocumentById(documentID);
    }, { commandName: "Send Photoshop Layer to Infinite Canvas" });
    const bytes = await file.read({ format: formats.binary });
    return {
      imageB64: bytesToBase64(bytes),
      layerName,
      documentName
    };
  } finally {
    if (exportDoc && typeof exportDoc.closeWithoutSaving === "function") {
      try { exportDoc.closeWithoutSaving(); } catch (_) {}
    }
  }
}

async function activeLayerToPixelExport() {
  if (!activeDocumentOpen()) throw new Error("请先打开一个 Photoshop 文档。");
  if (!imaging || typeof imaging.getPixels !== "function") {
    throw new Error("当前 Photoshop 版本不支持像素兜底导出。");
  }
  const doc = app.activeDocument;
  const layer = doc.activeLayers && doc.activeLayers[0];
  if (!layer) throw new Error("请先选中一个图层。");
  const documentID = doc.id || doc._id;
  const layerID = layer.id || layer._id;
  if (!documentID || !layerID) throw new Error("无法读取当前文档或图层 ID。");
  let result = null;
  let imageData = null;
  try {
    result = await core.executeAsModal(async () => await imaging.getPixels({
      documentID,
      layerID,
      colorSpace: "RGB",
      componentSize: 8,
      applyAlpha: false
    }), { commandName: "Read Photoshop Layer Pixels" });
    imageData = result.imageData || result;
    const bounds = result.sourceBounds || {};
    const width = Number(imageData.width || bounds.width || (bounds.right - bounds.left));
    const height = Number(imageData.height || bounds.height || (bounds.bottom - bounds.top));
    if (!width || !height) throw new Error("当前图层没有可发送的像素内容。");
    const data = typeof imageData.getData === "function" ? await imageData.getData() : imageData.data;
    const byteLength = Number(data?.byteLength || data?.length || 0);
    let components = Number(imageData.components || imageData.componentCount || 0);
    if (!components && byteLength === width * height * 3) components = 3;
    if (!components && byteLength === width * height * 4) components = 4;
    if (!components) components = 4;
    return {
      pixelsB64: bytesToBase64(data),
      width,
      height,
      components,
      layerName: layer.name || "Photoshop Layer",
      documentName: doc.title || doc.name || "Photoshop Document",
    };
  } finally {
    if (imageData && typeof imageData.dispose === "function") {
      imageData.dispose();
    }
  }
}

function filenameForLayer(layerName) {
  const clean = String(layerName || "Photoshop Layer").replace(/[\\/:*?"<>|]+/g, "_").trim() || "Photoshop Layer";
  return `${clean}.png`;
}

async function sendActiveLayerToCanvas() {
  if (layerSendBusy) return;
  if (!loadHostApis()) return;
  const sendBtn = $("sendLayerBtn");
  const shouldRestartAuto = Boolean(autoTimer);
  layerSendBusy = true;
  if (sendBtn) sendBtn.disabled = true;
  try {
    pluginLog("send layer clicked");
    if (shouldRestartAuto) stopAutoImport();
    const waitStarted = Date.now();
    while (busy && Date.now() - waitStarted < 5000) {
      setStatus("正在等待当前导入任务结束...", "ready");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (busy) throw new Error("当前自动导入仍在执行，请稍后再发送图层。");
    setStatus("正在读取当前 Photoshop 图层...", "ready");
    const exported = await activeLayerToPngExport();
    const imageB64 = exported.imageB64 || "";
    if (!imageB64) throw new Error("图层 PNG 导出为空。");
    setStatus("正在发送图层到无限画布...", "ready");
    const targetCanvasId = selectedCanvasId();
    if (!targetCanvasId) throw new Error("请先选择要发送到的画布。");
    saveSelectedCanvasId(targetCanvasId);
    const canvasPoint = await targetCanvasCenterPoint(targetCanvasId);
    let data = null;
    try {
      data = await api("/api/photoshop-bridge/canvas-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: filenameForLayer(exported.layerName),
          image_b64: imageB64,
          mime_type: "image/png",
          document_name: exported.documentName,
          layer_name: exported.layerName,
          canvas_point: canvasPoint,
          target_canvas_id: targetCanvasId
        })
      });
    } catch (err) {
      if (err.code !== "TRANSPARENT_IMAGE") throw err;
      setStatus("原生导出为空，正在使用像素兜底...", "ready");
      pluginLog("native layer export was transparent; using pixel fallback");
      const pixels = await activeLayerToPixelExport();
      data = await api("/api/photoshop-bridge/canvas-send-pixels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: filenameForLayer(pixels.layerName),
          pixels_b64: pixels.pixelsB64,
          width: pixels.width,
          height: pixels.height,
          components: pixels.components,
          document_name: pixels.documentName,
          layer_name: pixels.layerName,
          canvas_point: canvasPoint,
          target_canvas_id: targetCanvasId
        })
      });
    }
    setStatus("已发送到画布，打开画布后会自动出现。", "ready");
    logLine(`已发送图层到画布：${data.item?.filename || exported.layerName}`);
    const targetCanvas = canvasOptions.find(item => item.id === targetCanvasId);
    pluginLog(`sent layer to canvas ${data.item?.id || ""} ${data.item?.filename || exported.layerName} target=${targetCanvas?.title || targetCanvasId} kind=${targetCanvas?.kind || ""}`);
  } catch (err) {
    setStatus(err.message || "发送图层到画布失败。", "error");
    logLine(err.message || String(err));
    pluginLog(err.message || String(err), "error");
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    layerSendBusy = false;
    if (shouldRestartAuto && !autoTimer) startAutoImport();
    await sendHeartbeat();
    await refreshBridgeStatus({ silent: true });
  }
}

function bindRecentImports() {
  const list = $("recentList");
  if (!list) return;
  list.addEventListener("click", event => {
    const button = event.target && event.target.closest ? event.target.closest("button[data-job-id]") : null;
    if (!button || button.disabled) return;
    importJob(button.getAttribute("data-job-id") || "");
  });
}

function initializePanel() {
  if (initialized) return;
  initialized = true;
  loadBridgeIdentity();
  logLine(`插件已加载，正在连接无限画布服务。${bridgeSessionLabel()}`);
  pluginLog(`panel initialized v${BRIDGE_VERSION}`);
  $("pullBtn")?.addEventListener("click", () => importJob());
  $("autoBtn")?.addEventListener("click", toggleAuto);
  $("sendLayerBtn")?.addEventListener("click", sendActiveLayerToCanvas);
  $("matchOriginalBtn")?.addEventListener("click", matchSelectedLayerToOriginal);
  $("clearBtn")?.addEventListener("click", clearQueue);
  $("refreshCanvasBtn")?.addEventListener("click", loadCanvasOptions);
  $("targetPrevBtn")?.addEventListener("click", () => moveTargetCanvas(-1));
  $("targetNextBtn")?.addEventListener("click", () => moveTargetCanvas(1));
  $("targetCanvasCurrentBtn")?.addEventListener("click", () => {
    targetListOpen = !targetListOpen;
    renderCanvasOptions();
  });
  $("targetToggleBtn")?.addEventListener("click", () => {
    targetListOpen = !targetListOpen;
    renderCanvasOptions();
  });
  $("targetSearchInput")?.addEventListener("input", () => {
    targetListOpen = true;
    renderCanvasOptions();
  });
  $("targetCanvasMenu")?.addEventListener("click", event => {
    const button = event.target?.closest?.("[data-canvas-id]");
    if (button) selectTargetCanvas(button.getAttribute("data-canvas-id") || "");
  });
  $("logToggleBtn")?.addEventListener("click", () => {
    const card = $("logCard");
    if (!card) return;
    card.classList.toggle("expanded");
    const btn = $("logToggleBtn");
    if (btn) btn.textContent = card.classList.contains("expanded") ? "折叠" : "展开";
  });
  $("serverInput")?.addEventListener("change", () => {
    sendHeartbeat();
    refreshBridgeStatus();
    loadCanvasOptions();
  });
  bindRecentImports();
  updateMatchOriginalUi();
  setStatus("面板已加载，自动导入即将开启。", "");
  setQueueEmpty("画布回传后会自动导入到 Photoshop。");
  setTimeout(() => {
    sendHeartbeat();
    refreshBridgeStatus({ silent: true });
    loadCanvasOptions();
    heartbeatTimer = setInterval(sendHeartbeat, 5000);
    statusTimer = setInterval(() => {
      if (!busy && !layerSendBusy) refreshBridgeStatus({ silent: true });
    }, 5000);
    setTimeout(() => startAutoImport(), 700);
  }, 500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(initializePanel, 0));
} else {
  setTimeout(initializePanel, 0);
}

try {
  const { entrypoints } = require("uxp");
  if (entrypoints && entrypoints.setup) {
    entrypoints.setup({
      panels: {
        infiniteCanvasBridgePanel: {
          show() {
            initializePanel();
            sendHeartbeat();
          }
        }
      }
    });
  }
} catch (_) {
  // Static HTML still renders; initializePanel reports API/network errors.
}
