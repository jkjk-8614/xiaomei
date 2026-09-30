(() => {
  const $ = id => document.getElementById(id);
  let selected = '', mode = 'library', connecting = false, starting = false;
  let pendingWorkflow = null, editorLoaded = false, loadNonce = '', loadTimer = null;
  let installing = false;

  function isUiWorkflow(item) {
    return Boolean(item?.source && Array.isArray(item.source.nodes));
  }

  function editorOrigin() { return selected ? `http://${selected}` : ''; }

  function updateInstallAction() {
    const button = $('install-missing');
    if (!button) return;
    const visible = mode === 'editor' && Boolean(pendingWorkflow?.appId)
      && pendingWorkflow?.hasMissingModels !== false;
    button.hidden = !visible;
    button.disabled = installing;
    button.textContent = installing ? '正在安装模型…' : '自动安装可用模型';
  }

  async function comfyAppApi(path, options = {}) {
    const response = await fetch('/api/comfy-apps' + path, { ...options, cache: 'no-store' });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { detail: text }; }
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data));
    return data;
  }

  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function modelNames(entries) {
    return (entries || []).filter(entry => entry.kind === '模型').map(entry => String(entry.name || '').trim()).filter(Boolean);
  }

  function preparationLines(preparation, autoModels, manualModels) {
    const task = preparation?.task || {};
    const progress = task.progress || {};
    const value = Number(progress.value), max = Number(progress.max);
    const percent = progress.indeterminate || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0
      ? '处理中' : `${Math.floor(value / max * 100)}%`;
    const lines = [
      `自动安装：${autoModels.join('、')}`,
      `当前进度：${percent}`,
      progress.detail || task.stage || '正在准备本地环境…',
    ];
    if (manualModels.length) lines.push(`仍需手动准备：${manualModels.join('、')}。下载后请回到应用库，点击“导入此模型”。`);
    return lines;
  }

  async function sendModelDownloadConfig() {
    if (!selected || !pendingWorkflow?.appId || !$('editor').contentWindow) return;
    try {
      const preparation = await comfyAppApi(`/${encodeURIComponent(pendingWorkflow.appId)}/preparation`);
      const names = modelNames(preparation.preflight?.dependencies?.auto_installable);
      $('editor').contentWindow.postMessage({ type: 'xiaomei-model-download-config', names }, editorOrigin());
    } catch (_) { /* The native download link remains available if the app is not ready. */ }
  }

  function reloadEditor() {
    if (!selected) return;
    editorLoaded = false;
    stopLoadTimer();
    loadNonce = '';
    const url = editorOrigin() + '/';
    $('editor').src = 'about:blank';
    setTimeout(() => { if (selected) $('editor').src = url; }, 0);
  }

  async function watchModelPreparation(appId, autoModels, initialTask, manualModels, contextLines) {
    let preparation = { task: initialTask };
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      preparation = await comfyAppApi(`/${encodeURIComponent(appId)}/preparation`);
      const task = preparation.task || initialTask || {};
      const status = String(task.status || 'running');
      if (['succeeded', 'failed', 'cancelled'].includes(status)) return preparation;
      report('正在安装缺失模型', [...contextLines, ...preparationLines(preparation, autoModels, manualModels)], null, task.progress);
      await wait(1500);
    }
    throw new Error('模型安装等待超时；任务仍会在本地后台继续，请稍后回到应用库查看。');
  }

  async function installMissingModels(triggerName = '') {
    if (installing) return;
    const appId = pendingWorkflow?.appId;
    if (!appId) {
      report('无法定位当前应用', ['请先回到应用库打开该工作流，再使用“自动安装可用模型”。']);
      return;
    }
    installing = true;
    updateInstallAction();
    const contextLines = triggerName
      ? [`已接管 ComfyUI 下载：${triggerName}。`, '文件将直接写入对应模型目录，不会保存到“下载”文件夹。']
      : [];
    try {
      const preparation = await comfyAppApi(`/${encodeURIComponent(appId)}/preparation`);
      const dependencies = preparation.preflight?.dependencies || {};
      const autoModels = modelNames(dependencies.auto_installable).filter((name, index, list) => list.indexOf(name) === index);
      const manualModels = modelNames(dependencies.manual).filter((name, index, list) => list.indexOf(name) === index);
      if (!autoModels.length) {
        report(triggerName ? '此模型不能自动安装' : '模型依赖检查完成', [
          ...contextLines,
          ...(manualModels.length
            ? [`当前没有可自动安装的模型。`, `请回到应用库，在“需要手动准备”中点击“导入此模型”：${manualModels.join('、')}。`]
            : ['当前工作流没有可自动安装的缺失模型，请重新扫描依赖。']),
        ]);
        return;
      }
      let task = preparation.task;
      if (!task || !['queued', 'running'].includes(String(task.status || ''))) {
        task = await comfyAppApi(`/${encodeURIComponent(appId)}/prepare`, { method: 'POST' });
      }
      report('正在安装缺失模型', [...contextLines, ...preparationLines({ task }, autoModels, manualModels)], null, task.progress);
      const finalPreparation = await watchModelPreparation(appId, autoModels, task, manualModels, contextLines);
      const finalTask = finalPreparation.task || {};
      if (finalTask.status !== 'succeeded') {
        throw new Error(finalTask.error || `模型安装${finalTask.status === 'cancelled' ? '已取消' : '失败'}。`);
      }
      const remaining = modelNames(finalPreparation.preflight?.dependencies?.manual);
      pendingWorkflow.hasMissingModels = remaining.length > 0;
      sessionStorage.setItem('comfy-editor-workflow', JSON.stringify(pendingWorkflow));
      const lines = [...contextLines, `已自动安装：${autoModels.join('、')}。`, '模型已写入 ComfyUI 对应模型目录。'];
      if (remaining.length) lines.push(`仍缺少：${remaining.join('、')}。请回到应用库点击“导入此模型”。`);
      report('模型安装完成', lines, {
        label: '刷新高级编辑',
        action: () => reloadEditor(),
      }, finalTask.progress);
      sendModelDownloadConfig();
    } catch (error) {
      report('模型安装未完成', [error.message || String(error), '已完成的文件会保留；可稍后再次点击“自动安装可用模型”继续。']);
    } finally {
      installing = false;
      updateInstallAction();
    }
  }

  async function handleNativeModelDownload(data) {
    const name = String(data?.name || '').trim();
    if (!name) return;
    if (installing) {
      report('模型安装正在进行', [`${name} 已加入当前模型检查，请等待当前任务完成。`]);
      return;
    }
    const appId = pendingWorkflow?.appId;
    if (!appId) {
      report('无法接管模型下载', ['当前工作流没有关联应用。请回到应用库打开该工作流后再下载模型。']);
      return;
    }
    try {
      const preparation = await comfyAppApi(`/${encodeURIComponent(appId)}/preparation`);
      const autoNames = modelNames(preparation.preflight?.dependencies?.auto_installable);
      if (!autoNames.includes(name)) {
        report('未接管此模型下载', [
          `${name} 不在当前应用的可信自动安装清单中。`,
          '请回到应用库查看依赖来源；没有可信来源的模型请使用“导入此模型”。',
        ]);
        return;
      }
      await installMissingModels(name);
    } catch (error) {
      report('模型下载未开始', [error.message || String(error), '请回到应用库重试，或使用“导入此模型”。']);
    }
  }

  function showMode(next) {
    mode = next;
    $('library').hidden = mode !== 'library';
    $('library-tab').setAttribute('aria-pressed', String(mode === 'library'));
    $('models').hidden = mode !== 'models';
    $('models-tab').setAttribute('aria-pressed', String(mode === 'models'));
    $('editor-tab').setAttribute('aria-pressed', String(mode === 'editor'));
    $('settings-tab').setAttribute('aria-pressed', String(mode === 'settings'));
    const editorVisible = mode === 'editor' && Boolean(selected && pendingWorkflow && isUiWorkflow(pendingWorkflow));
    const editorEmptyVisible = mode === 'editor' && Boolean(selected && (!pendingWorkflow || !isUiWorkflow(pendingWorkflow)));
    $('editor').hidden = !editorVisible;
    $('editor-empty').hidden = !editorEmptyVisible;
    $('offline').hidden = mode !== 'editor' || Boolean(selected);
    $('settings').hidden = mode !== 'settings';
    if (editorVisible) ensureEditorFrame();
    else if (mode !== 'editor' && $('editor').src && $('editor').src !== 'about:blank') {
      $('editor').src = 'about:blank';
      editorLoaded = false;
      stopLoadTimer();
      loadNonce = '';
    }
    updateInstallAction();
    if (mode === 'settings' && !$('settings').src) $('settings').src = '/static/comfyui-settings.html';
    if (editorEmptyVisible) {
      const apiOnly = Boolean(pendingWorkflow && !isUiWorkflow(pendingWorkflow));
      $('editor-empty-title').textContent = apiOnly ? '当前工作流没有节点布局' : '先选择一个工作流';
      $('editor-empty-detail').textContent = apiOnly
        ? `「${pendingWorkflow.title || pendingWorkflow.name || '当前工作流'}」是 API JSON，只能在应用库运行；导入 UI JSON 后才能编辑完整节点。`
        : '从应用库打开工作流后，这里会加载完整的 ComfyUI 节点布局。不会创建空白的 Unsaved Workflow。';
      $('editor-library').textContent = apiOnly ? '返回应用库' : '返回应用库选择';
    }
    if (mode === 'editor' && selected && !editorVisible) {
      if (pendingWorkflow && !isUiWorkflow(pendingWorkflow)) {
        report('只能运行，缺少节点布局文件', [
          `「${pendingWorkflow.title || pendingWorkflow.name || '当前工作流'}」是 API JSON。`,
          '它可以在应用库中运行，但没有 ComfyUI 原生 UI 节点布局，无法伪装成完整的高级编辑画布。',
          '请回到应用库使用“打开高级编辑”，或导入同一工作流的 UI JSON。',
        ]);
      } else {
        $('report').hidden = true;
      }
    }
  }

  function stopLoadTimer() {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
  }

  function ensureEditorFrame() {
    if (mode !== 'editor' || !selected || !pendingWorkflow || !isUiWorkflow(pendingWorkflow)) return;
    const frame = $('editor');
    const origin = editorOrigin();
    if (!frame.src.startsWith(origin + '/')) {
      editorLoaded = false;
      stopLoadTimer();
      loadNonce = '';
      frame.src = origin + '/';
    }
  }

  function sendPendingWorkflow() {
    stopLoadTimer();
    if (!selected || !pendingWorkflow || !isUiWorkflow(pendingWorkflow) || !$('editor').contentWindow) return;
    const origin = editorOrigin();
    const nonce = crypto.randomUUID();
    loadNonce = nonce;
    let attempts = 0;
    const send = () => {
      if (!selected || !pendingWorkflow || loadNonce !== nonce) return;
      attempts += 1;
      $('editor').contentWindow.postMessage({
        type: 'xiaomei-load-workflow', nonce, format: 'UI',
        workflow: pendingWorkflow.source,
      }, origin);
      if (attempts < 30) loadTimer = setTimeout(send, 500);
      else {
        loadNonce = '';
        report('高级编辑器桥接未响应', [
          '工作流原文件已保留，但当前 ComfyUI 没有回应“小美画布工作流加载桥”。',
          '请在应用库先准备本地环境，或在 ComfyUI 中安装/启用小美画布桥接后重启服务，再重新打开高级编辑。',
        ]);
      }
    };
    send();
  }

  function isRetryableWorkflowLoadError(error) {
    // Older managed runtimes do not include a retryable flag yet. Keep their
    // transient bridge responses compatible while newer bridges can use the
    // explicit flag below.
    const text = String(error || '');
    return text.includes('仍在初始化') || text.includes('另一个工作流操作正在进行');
  }

  async function connect(preferredAddress = '') {
    if (connecting) return;
    connecting = true;
    $('refresh').disabled = true;
    $('status').textContent = '正在连接本地服务…';
    try {
      const response = await fetch('/api/comfyui/status', {cache: 'no-store', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('无法读取 ComfyUI 状态');
      const data = await response.json();
      const local = (data.instances || []).filter(item => /^(127\.0\.0\.1|localhost):\d+$/.test(item.address));
      const preferred = String(preferredAddress || pendingWorkflow?.backend || '')
        .replace(/^https?:\/\//i, '').replace(/\/$/, '');
      // The managed application backend (8190 by default) is intentionally
      // not part of the user's COMFYUI_INSTANCES list.  Once the app page
      // gives us that verified local address, include it as the editor target
      // instead of silently falling back to the base 8188 instance.
      const candidates = [...local];
      if (preferred && /^(127\.0\.0\.1|localhost):\d+$/.test(preferred)
          && !candidates.some(item => item.address === preferred)) {
        candidates.push({address: preferred, online: true, managed: true});
      }
      const active = candidates.find(item => item.online && preferred && item.address === preferred)
        || candidates.find(item => item.online);
      const next = active ? active.address : '';
      if (next !== selected) {
        selected = next;
        editorLoaded = false;
        stopLoadTimer();
        loadNonce = '';
        $('editor').src = 'about:blank';
        if (selected) $('external').href = `http://${selected}/`;
      }
      if (selected) {
        $('status').textContent = `本地服务在线 · ${selected}`;
        if (pendingWorkflow && isUiWorkflow(pendingWorkflow) && editorLoaded) sendPendingWorkflow();
        $('editor-direct').href = `http://${selected}/`;
        $('editor-direct').hidden = false;
      } else {
        $('status').textContent = '本地服务未连接';
        $('offline-detail').textContent = local.length ? `已检查：${local.map(i => i.address).join('、')}` : '已检查 127.0.0.1:8188 和已准备的独立环境。';
        $('editor-direct').hidden = true;
      }
      $('external').hidden = !selected;
    } catch (error) {
      selected = '';
      editorLoaded = false;
      stopLoadTimer();
      $('external').hidden = true;
      $('status').textContent = error.message;
      $('offline-detail').textContent = '请确认小美画布后台服务正常运行。';
    } finally {
      connecting = false;
      $('refresh').disabled = false;
      showMode(mode);
    }
  }

  async function startLocalService() {
    if (starting) return;
    starting = true;
    const startButton = $('start-comfyui');
    if (startButton) { startButton.disabled = true; startButton.textContent = '正在启动…'; }
    $('status').textContent = '正在启动本地 ComfyUI…';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 135000);
    let probeTimer;
    const ready = new Promise(resolve => {
      const probe = async () => {
        if (controller.signal.aborted) return;
        try {
          const response = await fetch('/api/comfyui/status', {cache: 'no-store', signal: AbortSignal.timeout(5000)});
          const data = response.ok ? await response.json() : {};
          const active = (data.instances || []).find(item => item.managed && item.online);
          if (active) { resolve(active); return; }
        } catch (_) { /* Startup can continue while the status service is unavailable. */ }
        if (!controller.signal.aborted) probeTimer = setTimeout(probe, 2000);
      };
      probeTimer = setTimeout(probe, 2000);
    });
    try {
      const requested = (async () => {
        const response = await fetch('/api/comfyui/start', {method: 'POST', signal: controller.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || '本地 ComfyUI 启动失败');
        return data;
      })();
      const data = await Promise.race([requested, ready]);
      $('status').textContent = `${data.message || '本地服务已启动'} · ${data.address}`;
      await connect(data.address);
    } catch (error) {
      report('本地 ComfyUI 连接未完成', [
        error.name === 'AbortError' ? '等待启动超时，请点击“重新连接”检查状态；仍未连接时查看 ComfyUI/comfy_apps_runtime/server.log。' : (error.message || String(error)),
        '如果这是外部 ComfyUI，请先启动它的启动脚本，再点击“重新连接”。',
        '已有本地应用和模型文件不会因本次连接失败被删除。',
      ]);
      await connect();
    } finally {
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(probeTimer);
      starting = false;
      if (startButton) { startButton.disabled = false; startButton.textContent = '启动本地 ComfyUI'; }
    }
  }

  function report(title, lines, action, progress) {
    const content = $('report-content');
    content.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = title;
    content.append(heading);
    const value = Number(progress?.value), max = Number(progress?.max);
    if (progress && !progress.indeterminate && Number.isFinite(value) && Number.isFinite(max) && max > 0) {
      const bar = document.createElement('progress');
      bar.max = max; bar.value = Math.min(max, Math.max(0, value));
      bar.setAttribute('aria-label', '模型安装进度');
      const label = document.createElement('span');
      label.className = 'report-progress-label';
      label.textContent = `${Math.floor(value / max * 100)}%`;
      content.append(bar, label);
    } else if (progress) {
      const label = document.createElement('span');
      label.className = 'report-progress-label';
      label.textContent = '处理中，正在等待下载源返回进度…';
      content.append(label);
    }
    for (const text of lines) {
      const p = document.createElement('p'); p.textContent = text; content.append(p);
    }
    if (action?.label && typeof action.action === 'function') {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = action.label; button.onclick = () => Promise.resolve(action.action()).catch(error => report('操作未完成', [error.message || String(error)]));
      content.append(button);
    }
    $('report').hidden = false;
  }

  function selectWorkflow(item) {
    stopLoadTimer();
    loadNonce = '';
    pendingWorkflow = null;
    if (!item?.source) {
      sessionStorage.removeItem('comfy-editor-workflow');
      return false;
    }
    pendingWorkflow = {
      source: item.source,
      name: item.workflow_ref || item.workflow || '',
      title: item.title || item.workflow_ref || '当前工作流',
      backend: item.backend || '',
      appId: item.entry_type === 'app' ? item.id : '',
      hasMissingModels: Boolean(item.report?.missing_models?.length),
    };
    sessionStorage.setItem('comfy-editor-workflow', JSON.stringify(pendingWorkflow));
    if (selected) $('status').textContent = `本地服务在线 · ${selected}`;
    return true;
  }

  function openWorkflow(item) {
    if (!selectWorkflow(item)) {
      report('工作流文件不可用', ['当前应用没有保存原始工作流文件，不能加载高级节点布局。请重新导入原 JSON。']);
      showMode('editor');
      return;
    }
    showMode('editor');
    if (!selected || (pendingWorkflow.backend && selected !== pendingWorkflow.backend)) connect(pendingWorkflow.backend);
    else if (isUiWorkflow(pendingWorkflow) && editorLoaded) {
      sendPendingWorkflow();
      sendModelDownloadConfig();
    }
  }

  $('editor').addEventListener('load', () => {
    editorLoaded = true;
    if (mode === 'editor' && pendingWorkflow && isUiWorkflow(pendingWorkflow)) sendPendingWorkflow();
    sendModelDownloadConfig();
  });
  $('file').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    $('inspect').disabled = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('工作流 JSON 超过 20MB，请移除内嵌图片后重试。');
      const workflow = JSON.parse(await file.text());
      const response = await fetch('/api/comfyui/inspect-workflow', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || '依赖检查失败');
      report(file.name, [
        `${data.format} 工作流 · ${data.node_count} 个节点`,
        data.missing_nodes.length ? `缺少节点：\n${data.missing_nodes.join('\n')}` : '节点类型检查通过。',
        data.missing_models.length ? `缺少模型：\n${data.missing_models.join('\n')}` : '已识别的模型加载器检查通过。',
        data.review_nodes.length ? `需要确认是否联网或收费的节点：\n${data.review_nodes.join('\n')}` : '名称检查未发现常见云端 API 节点；这不等于已确认所有自定义节点离线运行。',
        data.swarm_inputs?.length ? `发现 ${data.swarm_inputs.length} 个 SwarmInput 参数节点；应用库会优先按这些节点生成表单。` : '',
        data.note,
        '此检查不会执行工作流。导入请将原 JSON 拖进节点编辑器；原工作流中的产品图和场景图需要重新上传。'
      ].filter(Boolean));
    } catch (error) { report('检查未完成', [error.message]); }
    finally { $('inspect').disabled = false; event.target.value = ''; }
  };
  $('inspect').onclick = () => $('file').click();
  $('close-report').onclick = () => { $('report').hidden = true; };
  $('editor-tab').onclick = () => {
    document.querySelector('.workspace-tools').open = false;
    showMode('editor');
  };
  $('library-tab').onclick = () => showMode('library');
  $('install-missing').onclick = installMissingModels;
  $('settings-tab').onclick = () => showMode('settings');
  $('refresh').onclick = connect;
  $('start-comfyui').onclick = startLocalService;
  $('refresh-offline').onclick = connect;
  $('open-settings').onclick = () => showMode('settings');
  $('editor-library').onclick = () => showMode('library');
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.data?.type === 'comfy-instances-changed') { connect(); return; }
    if (event.origin === location.origin && event.data?.type === 'open-comfyui-settings') {
      showMode('settings');
      return;
    }
    if (event.origin === location.origin && event.data?.type === 'open-comfyui-workflow-settings') {
      const workflowName = String(event.data.workflowName || '').trim();
      if (!workflowName) return;
      try { sessionStorage.setItem('comfy-settings-workflow', workflowName); } catch (_) {}
      showMode('settings');
      const settingsFrame = $('settings');
      const sendWorkflow = () => {
        try { settingsFrame.contentWindow?.postMessage({ type:'select-comfy-workflow', workflowName }, '*'); } catch (_) {}
      };
      if (settingsFrame.contentDocument?.readyState === 'complete') window.setTimeout(sendWorkflow, 0);
      else settingsFrame.addEventListener('load', () => window.setTimeout(sendWorkflow, 0), { once:true });
      window.setTimeout(sendWorkflow, 500);
      return;
    }
    if (!selected || event.origin !== editorOrigin() || event.source !== $('editor').contentWindow) return;
    if (event.data?.type === 'xiaomei-model-download') {
      handleNativeModelDownload(event.data);
      return;
    }
    if (event.data?.type === 'xiaomei-workflow-loaded' && event.data.nonce === loadNonce) {
      if (event.data.error && (event.data.retryable || isRetryableWorkflowLoadError(event.data.error))) return;
      stopLoadTimer(); loadNonce = '';
      if (event.data.error) report('工作流未加载', [event.data.error, '原始工作流文件仍然保留。']);
      else {
        $('report').hidden = true;
        $('status').textContent = `本地服务在线 · ${selected} · 已加载「${pendingWorkflow?.title || '工作流'}」`;
      }
    }
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('comfy-editor-workflow') || 'null');
    const savedSource = saved?.workflow || saved?.source;
    if (savedSource) pendingWorkflow = {
      source: savedSource, name: saved.name || '', title: saved.title || saved.name || '当前工作流',
      backend: saved.backend || '', appId: saved.appId || sessionStorage.getItem('comfy-app-selected') || '',
      hasMissingModels: saved.hasMissingModels,
    };
  } catch (_) { /* Ignore stale browser session data. */ }
  if (pendingWorkflow && !pendingWorkflow.appId && pendingWorkflow.name) {
    const restoredWorkflow = pendingWorkflow;
    comfyAppApi('/workflows/' + encodeURIComponent(pendingWorkflow.name)).then(item => {
      if (pendingWorkflow !== restoredWorkflow) return;
      if (item?.entry_type !== 'app' || !item.id) return;
      pendingWorkflow.appId = item.id;
      pendingWorkflow.hasMissingModels = Boolean(item.report?.missing_models?.length);
      sessionStorage.setItem('comfy-editor-workflow', JSON.stringify(pendingWorkflow));
      updateInstallAction();
      sendModelDownloadConfig();
    }).catch(() => {});
  }
  window.comfyWorkspace = { showMode, selectWorkflow, openWorkflow, address: () => selected, refresh: connect };
  connect();
})();
