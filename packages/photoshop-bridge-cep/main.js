(function () {
  "use strict";

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const NodeBuffer = require("buffer").Buffer;
  const bridgeId = "cep-direct-" + Math.random().toString(36).slice(2, 9);
  let busy = false;
  let sendBusy = false;
  let pollTimer = null;
  let heartbeatTimer = null;

  const $ = (id) => document.getElementById(id);
  const server = () => String($("server").value || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const log = (message) => {
    const el = $("log");
    if (!el) return;
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    el.textContent = `${line}\n${el.textContent}`.slice(0, 4000);
  };

  async function json(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    return data;
  }

  async function api(url, options) {
    return fetch(`${server()}${url}`, options).then(json);
  }

  function setConnection(online, message) {
    $("dot").className = `dot ${online ? "ok" : "bad"}`;
    $("status").textContent = message;
  }

  function evalScript(code) {
    return new Promise((resolve, reject) => {
      if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") {
        reject(new Error("Photoshop CEP 脚本接口不可用。"));
        return;
      }
      window.__adobe_cep__.evalScript(code, (result) => {
        const text = String(result || "");
        if (text.indexOf("ERROR:") === 0) reject(new Error(text.slice(6)));
        else resolve(text);
      });
    });
  }

  function scriptString(value) {
    return JSON.stringify(String(value == null ? "" : value));
  }

  function setCanvasMessage(message, isError) {
    const el = $("canvasSub");
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "#ff8787" : "#aeb4bd";
  }

  function canvasLabel(item) {
    const kind = item.kind === "smart" ? "智能画布" : "普通画布";
    return `${item.title || "未命名画布"}（${kind}）`;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  async function loadCanvases() {
    const select = $("canvasSelect");
    if (!select) return;
    try {
      const data = await api("/api/canvases");
      const canvases = Array.isArray(data.canvases) ? data.canvases : [];
      const saved = localStorage.getItem("xiaomeiCepTargetCanvas") || "";
      select.innerHTML = canvases.length
        ? canvases.map((item) => `<option value="${escapeHtml(item.id || "")}">${escapeHtml(canvasLabel(item))}</option>`).join("")
        : '<option value="">没有可用画布</option>';
      if (saved && canvases.some((item) => item.id === saved)) select.value = saved;
      setCanvasMessage(canvases.length ? `已加载 ${canvases.length} 个画布。` : "请先在小美画布创建一个画布。");
    } catch (error) {
      select.innerHTML = '<option value="">画布列表加载失败</option>';
      setCanvasMessage(`无法读取画布列表：${error.message}`, true);
    }
  }

  async function canvasCenter(canvasId) {
    if (!canvasId) return null;
    try {
      const data = await api(`/api/canvases/${encodeURIComponent(canvasId)}`);
      const viewport = (data.canvas || data).viewport || {};
      const scale = Math.max(0.01, Number(viewport.scale || 1));
      const width = Number(viewport.viewWidth || viewport.width || 1280);
      const height = Number(viewport.viewHeight || viewport.height || 720);
      return { x: (width / 2 - Number(viewport.x || 0)) / scale, y: (height / 2 - Number(viewport.y || 0)) / scale };
    } catch (_) { return null; }
  }

  async function sendActiveLayer() {
    if (sendBusy || busy) {
      setCanvasMessage("Photoshop 正在处理另一项桥接任务，请稍后再试。", true);
      return;
    }
    const canvasSelect = $("canvasSelect");
    const canvasId = String(canvasSelect ? canvasSelect.value : "");
    if (!canvasId) { setCanvasMessage("请先选择目标画布。", true); return; }
    sendBusy = true;
    $("sendLayer").disabled = true;
    let tempPath = "";
    try {
      setCanvasMessage("正在导出当前图层…");
      tempPath = path.join(os.tmpdir(), `xiaomei_canvas_layer_${Date.now()}.png`);
      const result = await evalScript(`exportActiveLayerToPng(${scriptString(tempPath)})`);
      if (!result || result.indexOf("OK|") !== 0) throw new Error(result || "图层导出失败");
      const parts = result.split("|");
      const layerName = parts[1] || "Photoshop 图层";
      const documentName = parts.slice(2).join("|") || "Photoshop 文档";
      const imageB64 = fs.readFileSync(tempPath).toString("base64");
      setCanvasMessage("正在发送到小美画布…");
      const point = await canvasCenter(canvasId);
      await api("/api/photoshop-bridge/canvas-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: /\.png$/i.test(layerName) ? layerName : `${layerName}.png`, image_b64: imageB64, mime_type: "image/png",
          document_name: documentName, layer_name: layerName,
          target_canvas_id: canvasId, canvas_point: point || {}
        })
      });
      localStorage.setItem("xiaomeiCepTargetCanvas", canvasId);
      setCanvasMessage("已发送，打开目标画布后会自动出现图层节点。");
      log(`已发送图层到画布：${layerName}`);
    } catch (error) {
      setCanvasMessage(`发送失败：${error.message}`, true);
      log(`发送图层失败：${error.message}`);
    } finally {
      if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
      sendBusy = false;
      $("sendLayer").disabled = false;
    }
  }

  async function heartbeat() {
    try {
      await api("/api/photoshop-bridge/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bridge_id: bridgeId,
          bridge_name: "小美画布 PS 直连",
          name: "小美画布 PS 直连",
          version: "1.1.0-cep",
          status: busy ? "importing" : "online",
          auto_import: true,
          capabilities: ["open-layered-psd", "send-layer-to-canvas"]
        })
      });
      setConnection(true, "已连接，自动导入已开启");
    } catch (error) {
      setConnection(false, "无法连接小美画布服务");
      if (!busy) log(error.message);
    }
  }

  async function downloadJob(job) {
    const rawUrl = String(job.file_url || job.url || "");
    const response = await fetch(/^https?:\/\//i.test(rawUrl) ? rawUrl : `${server()}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`);
    if (!response.ok) throw new Error(`下载图片失败：${response.status}`);
    const bytes = NodeBuffer.from(await response.arrayBuffer());
    const filePath = path.join(os.tmpdir(), `xiaomei_ps_${job.id}${job.open_mode === "document" ? '.psd' : '.png'}`);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }

  async function ack(job, status, error, importMode) {
    try {
      await api("/api/photoshop-bridge/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: job.id,
          status,
          error: error || "",
          import_mode: importMode || "",
          bridge_id: bridgeId
        })
      });
    } catch (ackError) {
      log(`任务确认失败：${ackError.message}`);
    }
  }

  async function importLatest() {
    if (busy || sendBusy) return;
    busy = true;
    $("pull").disabled = true;
    let job = null;
    let tempFile = "";
    try {
      const data = await api(`/api/photoshop-bridge/latest?consume=true&bridge_id=${encodeURIComponent(bridgeId)}`);
      job = data.job;
      if (!job) {
        $("jobTitle").textContent = "暂无待导入图片";
        $("jobSub").textContent = "从小美画布点击“发送到 PS”后会自动处理。";
        return;
      }
      $("jobTitle").textContent = job.filename || job.name || "画布图片";
      $("jobSub").textContent = job.open_mode === "document" ? "正在打开分层 PSD 文档…" : "正在置入当前 Photoshop 文档…";
      log(`领取任务 ${job.id.slice(0, 8)}`);
      tempFile = await downloadJob(job);
      const mode = await evalScript(`importInfiniteCanvasImage(${scriptString(tempFile)}, ${scriptString(job.name || "小美画布图片")}, ${scriptString(job.open_mode || "place")})`);
      await ack(job, "done", "", mode);
      $("jobSub").textContent = mode === "opened-document" ? "已在 Photoshop 打开新文档。" : "已置入当前 Photoshop 文档。";
      log(`已导入 ${job.name || job.id}`);
    } catch (error) {
      $("jobSub").textContent = `导入失败：${error.message}`;
      log(error.message);
      if (job) await ack(job, "failed", error.message, "");
    } finally {
      if (tempFile) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
      busy = false;
      $("pull").disabled = false;
      heartbeat();
    }
  }

  async function refresh() {
    try {
      const data = await api("/api/photoshop-bridge/status");
      const pending = Number(data.pending || 0);
      const latest = data.latest;
      $("jobTitle").textContent = latest ? (latest.filename || latest.name || "画布图片") : "暂无待导入图片";
      $("jobSub").textContent = pending ? `${pending} 张待导入，直连面板会自动处理。` : "从小美画布点击“发送到 PS”后会自动处理。";
      setConnection(true, `已连接，${pending} 张待导入`);
    } catch (error) {
      setConnection(false, "无法连接小美画布服务");
    }
  }

  function start() {
    $("pull").addEventListener("click", importLatest);
    $("refresh").addEventListener("click", refresh);
    $("sendLayer").addEventListener("click", sendActiveLayer);
    $("refreshCanvases").addEventListener("click", loadCanvases);
    $("canvasSelect").addEventListener("change", () => localStorage.setItem("xiaomeiCepTargetCanvas", $("canvasSelect").value || ""));
    $("server").addEventListener("change", () => {
      heartbeat();
      refresh();
      loadCanvases();
    });
    heartbeatTimer = setInterval(heartbeat, 5000);
    pollTimer = setInterval(importLatest, 1000);
    heartbeat();
    refresh();
    loadCanvases();
    importLatest();
  }

  window.addEventListener("load", start);
})();
