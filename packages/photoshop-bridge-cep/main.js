(function () {
  "use strict";

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const NodeBuffer = require("buffer").Buffer;
  const bridgeId = "cep-direct-" + Math.random().toString(36).slice(2, 9);
  let busy = false;
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

  async function heartbeat() {
    try {
      await api("/api/photoshop-bridge/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bridge_id: bridgeId,
          bridge_name: "小美画布 PS 直连",
          name: "小美画布 PS 直连",
          version: "1.0.0-cep",
          status: busy ? "importing" : "online",
          auto_import: true
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
    const filePath = path.join(os.tmpdir(), `xiaomei_ps_${job.id}.png`);
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
    if (busy) return;
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
      $("jobSub").textContent = "正在置入当前 Photoshop 文档…";
      log(`领取任务 ${job.id.slice(0, 8)}`);
      tempFile = await downloadJob(job);
      const mode = await evalScript(`importInfiniteCanvasImage(${scriptString(tempFile)}, ${scriptString(job.name || "小美画布图片")})`);
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
    $("server").addEventListener("change", () => {
      heartbeat();
      refresh();
    });
    heartbeatTimer = setInterval(heartbeat, 5000);
    pollTimer = setInterval(importLatest, 1000);
    heartbeat();
    refresh();
    importLatest();
  }

  window.addEventListener("load", start);
})();
