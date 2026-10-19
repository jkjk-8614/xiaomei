(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text = '', cls = '') => { const value = document.createElement(tag); value.textContent = text; if (cls) value.className = cls; return value; };
  const categories = { checkpoints: '整合模型 / checkpoints', diffusion_models: '主模型 / diffusion_models', text_encoders: '文本编码器 / text_encoders', vae: 'VAE / vae', loras: 'LoRA / loras', controlnet: 'ControlNet / controlnet', clip_vision: '视觉编码器 / clip_vision', upscale_models: '放大模型 / upscale_models', embeddings: 'Embedding / embeddings', SEEDVR2: 'SeedVR2 / SEEDVR2' };
  const states = { queued: '等待下载', downloading: '下载中', verifying: '校验中', retrying: '等待重试', pausing: '正在暂停', paused: '已暂停', cancelling: '正在取消', cancelled: '已取消', failed: '下载失败', succeeded: '已完成' };
  const active = new Set(['queued', 'downloading', 'verifying', 'retrying', 'pausing', 'cancelling']);
  let tasks = [], selections = [], polling = false, resolving = false, pollTimer, settingsLoaded = false, hadSnapshot = false;
  const session = fetch('/api/app-info', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
  window.comfyModelSession = session;
  async function api(path, data, method) {
    await session;
    const options = { cache: 'no-store' };
    if (data !== undefined) Object.assign(options, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const response = await fetch('/api/comfy-apps/models' + path, options);
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '模型管理请求失败，请重试');
    return result;
  }
  function notice(id, value) { $(id).textContent = value?.message || value || ''; }
  function button(label, action, cls = '') {
    const result = node('button', label, cls); result.type = 'button';
    result.onclick = async () => { result.disabled = true; try { await action(); } catch (error) { notice('model-queue-notice', error); } finally { result.disabled = false; } };
    return result;
  }
  function bytes(value) {
    const amount = Math.max(0, Number(value) || 0);
    if (amount < 1024) return `${Math.round(amount)} B`;
    if (amount < 1024 ** 2) return `${(amount / 1024).toFixed(1)} KB`;
    if (amount < 1024 ** 3) return `${(amount / 1024 ** 2).toFixed(1)} MB`;
    return `${(amount / 1024 ** 3).toFixed(2)} GB`;
  }
  function sourceLink(value, label = '打开来源') {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !['civitai.com', 'civitai.red', 'huggingface.co'].includes(url.hostname)) return null;
      const link = node('a', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
    } catch (_) { return null; }
  }
  async function copy(value) {
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(value); return; } catch (_) { /* Use selection when clipboard permission is unavailable. */ } }
    const input = node('textarea'); input.value = value; document.body.append(input); input.select();
    const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('复制失败，请手动选择文字复制');
  }
  function show(downloads) {
    $('model-local-panel').hidden = downloads;
    $('model-download-panel').hidden = !downloads;
    $('model-view-local').setAttribute('aria-pressed', String(!downloads));
    $('model-view-downloads').setAttribute('aria-pressed', String(downloads));
    if (downloads) { poll(); if (!settingsLoaded) loadSettings(); }
  }
  $('model-view-local').onclick = () => show(false);
  $('model-view-downloads').onclick = () => show(true);
  $('model-add-download').onclick = () => { show(true); $('model-link-input').focus(); };
  $('models-tab').addEventListener('click', () => { if (!$('model-download-panel').hidden) poll(); });

  function renderFiles(result, url, holder) {
    holder.replaceChildren();
    const header = node('div', '', 'model-version-heading');
    header.append(node('h4', result.title));
    const source = sourceLink(result.source_url); if (source) header.append(source);
    const label = node('label', '版本'); const version = node('select'); version.setAttribute('aria-label', result.title + ' 版本');
    for (const item of result.versions || []) { const option = node('option', item.name); option.value = item.id; version.append(option); }
    version.value = result.version; label.append(version); header.append(label); holder.append(header);
    version.onchange = async () => {
      version.disabled = true;
      try { renderFiles(await api('/resolve', { url, version: version.value }), url, holder); notice('model-link-notice', '已切换版本，请重新选择文件。'); }
      catch (error) { version.value = result.version; notice('model-link-notice', error); }
      finally { version.disabled = false; }
    };
    selections = selections.filter(item => item.holder !== holder);
    if (!result.files?.length) holder.append(node('p', '这个版本没有可下载的权重文件，请打开来源确认文件与访问权限。', 'model-hint'));
    else {
      const selectAll = node('label', '', 'model-select-all'); const all = node('input'); all.type = 'checkbox';
      selectAll.append(all, node('span', '选择本版本全部可用文件')); holder.append(selectAll);
      const list = node('div', '', 'model-file-choices');
      for (const file of result.files) {
        const row = node('article', '', 'model-file-choice'); const choice = node('label', '', 'model-file-name');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.disabled = !file.eligible;
        checkbox.checked = Boolean(file.eligible && file.preferred); checkbox.setAttribute('aria-label', '下载 ' + file.name);
        const info = node('span'); info.append(node('strong', file.name), node('small', [bytes(file.size_bytes), file.variant].filter(Boolean).join(' · ')));
        choice.append(checkbox, info); row.append(choice);
        const category = node('select'); category.setAttribute('aria-label', file.name + ' 保存目录');
        for (const [value, label] of Object.entries(categories)) { const option = node('option', label); option.value = value; category.append(option); }
        category.value = file.category; row.append(category);
        if (file.disabled_reason) row.append(node('p', file.disabled_reason, 'model-file-warning'));
        if (file.sha256) { const sha = node('details', '', 'model-file-sha'); sha.append(node('summary', 'SHA-256'), node('code', file.sha256)); row.append(sha); }
        list.append(row); selections.push({ holder, file, checkbox, category });
      }
      all.onchange = () => { for (const selection of selections.filter(item => item.holder === holder && !item.checkbox.disabled)) selection.checkbox.checked = all.checked; };
      holder.append(list);
    }
    $('model-download-selected').hidden = !selections.some(item => item.file.eligible);
  }
  $('model-link-form').onsubmit = async event => {
    event.preventDefault(); if (resolving) return;
    const urls = [...new Set($('model-link-input').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    if (!urls.length || urls.length > 20) { notice('model-link-notice', '每次可解析 1–20 个链接，每行一个。'); return; }
    resolving = true; $('model-link-resolve').disabled = true; selections = []; $('model-link-results').replaceChildren(); $('model-download-selected').hidden = true;
    let successes = 0; const failures = [];
    try {
      for (const [index, url] of urls.entries()) {
        notice('model-link-notice', `正在解析 ${index + 1}/${urls.length} 个链接…`);
        try {
          const result = await api('/resolve', { url }); const holder = node('section', '', 'model-link-result'); $('model-link-results').append(holder);
          renderFiles(result, url, holder); successes++;
        } catch (error) { failures.push(`${url}\n${error.message}`); }
      }
      notice('model-link-notice', [successes ? `已解析 ${successes} 个链接。请选择具体文件和保存目录。` : '链接未解析成功。', ...failures].join('\n'));
    } finally { resolving = false; $('model-link-resolve').disabled = false; }
  };
  $('model-download-selected').onclick = async () => {
    const selected = selections.filter(item => item.checkbox.checked && !item.checkbox.disabled);
    if (!selected.length) { notice('model-link-notice', '请先勾选要下载的模型文件。'); return; }
    $('model-download-selected').disabled = true;
    try {
      const result = await api('/downloads', { files: selected.map(item => ({ selection_id: item.file.selection_id, category: item.category.value })) });
      for (const item of selected) item.checkbox.checked = false;
      notice('model-link-notice', `已提交 ${result.tasks.length} 个文件，请在下载队列查看进度。`); await poll();
    } catch (error) { notice('model-link-notice', error); }
    finally { $('model-download-selected').disabled = false; }
  };
  async function act(task, action, restart = false) {
    await api('/downloads/' + task.id + '/' + action, { restart });
    notice('model-queue-notice', ''); await poll();
  }
  function renderQueue() {
    const filter = $('model-download-filter').value;
    const visible = tasks.filter(task => filter === 'all' || (filter === 'active' ? active.has(task.status) : task.status === filter));
    const running = tasks.filter(task => active.has(task.status)); const done = tasks.filter(task => task.status === 'succeeded');
    const speed = running.reduce((total, task) => total + (Number(task.speed) || 0), 0);
    $('model-download-count').textContent = running.length ? String(running.length) : '';
    $('model-queue-summary').textContent = `${running.length} 个进行中 · ${done.length} 个已完成` + (speed ? ` · ${bytes(speed)}/s` : '');
    $('model-download-pause-all').disabled = !running.some(task => !['pausing', 'cancelling'].includes(task.status));
    $('model-download-resume-all').disabled = !tasks.some(task => ['paused', 'failed'].includes(task.status));
    const list = $('model-download-list');
    const existing = new Map([...list.children].map(item => [item.dataset.taskId, item]));
    if (!visible.length) { list.replaceChildren(node('p', tasks.length ? '当前筛选下没有下载任务。' : '还没有下载任务。解析模型链接并选择文件后，这里会显示下载进度。', 'model-empty')); return; }
    list.querySelectorAll('.model-empty').forEach(item => item.remove());
    for (const task of visible) {
      let row = existing.get(task.id); const shape = task.status + ':' + Boolean(task.source_url);
      if (!row || row.dataset.shape !== shape) {
        const next = node('article', '', 'model-download-row'); next.dataset.taskId = task.id; next.dataset.shape = shape;
        const heading = node('div', '', 'model-task-heading'); heading.append(node('strong', task.name), node('span', states[task.status] || task.status, 'model-task-status ' + task.status));
        next.append(heading, node('p', [task.origin, task.category, task.version].filter(Boolean).join(' · '), 'model-hint'));
        const progress = node('progress'); progress.max = 100; progress.setAttribute('aria-label', task.name + ' 下载进度'); next.append(progress);
        next.append(node('div', '', 'model-transfer-stats'), node('p', '', 'model-transfer-detail'), node('p', '', 'model-transfer-error'), node('p', task.destination, 'model-transfer-path'));
        const actions = node('div', '', 'model-task-actions');
        if (['queued', 'downloading', 'verifying', 'retrying'].includes(task.status)) actions.append(button('暂停', () => act(task, 'pause')));
        if (task.status === 'paused') actions.append(button('继续', () => act(task, 'resume')));
        if (['failed', 'cancelled'].includes(task.status)) actions.append(button('重试', () => act(task, 'retry')));
        if (task.status === 'failed') actions.append(button('重新下载', async () => {
          if (window.confirm(`清除“${task.name}”的未完成断点并重新下载？已安装的模型文件会保留。`)) await act(task, 'retry', true);
        }));
        if (!['succeeded', 'cancelled', 'cancelling'].includes(task.status)) actions.append(button('取消', () => act(task, 'cancel')));
        const source = sourceLink(task.source_url); if (source) actions.append(source);
        if (task.status === 'succeeded') actions.append(node('span', task.verification === 'sha256' ? 'SHA-256 已校验' : task.verification === 'size' ? '文件大小已校验' : '来源未提供校验值', 'model-verified'));
        next.append(actions);
        if (row) row.replaceWith(next); else list.append(next);
        row = next;
      }
      const progress = row.querySelector('progress');
      if (task.progress === null || task.progress === undefined) progress.removeAttribute('value'); else progress.value = task.progress;
      row.querySelector('.model-transfer-stats').textContent = `${bytes(task.downloaded)} / ${task.total ? bytes(task.total) : '大小待确认'}` + (task.speed ? ` · ${bytes(task.speed)}/s` : '') + (task.progress !== null && task.progress !== undefined ? ` · ${Math.floor(task.progress)}%` : '');
      row.querySelector('.model-transfer-detail').textContent = task.detail || '';
      row.querySelector('.model-transfer-error').textContent = task.error || '';
      existing.delete(task.id);
    }
    for (const row of existing.values()) row.remove();
  }
  async function poll() {
    if (polling) return; polling = true;
    try {
      const data = await api('/downloads');
      const previous = new Map(tasks.map(task => [task.id, task.status]));
      const completed = hadSnapshot && (data.tasks || []).some(task => task.status === 'succeeded' && previous.get(task.id) !== 'succeeded');
      tasks = data.tasks || []; hadSnapshot = true; renderQueue();
      notice('model-queue-notice', data.warning || '');
      if (completed) window.dispatchEvent(new CustomEvent('comfy-model-download-complete'));
    } catch (error) { notice('model-queue-notice', '获取下载进度失败：' + error.message); }
    finally { polling = false; }
  }
  $('model-download-filter').onchange = renderQueue;
  $('model-download-pause-all').onclick = async () => {
    try { for (const task of tasks.filter(task => ['queued', 'downloading', 'verifying', 'retrying'].includes(task.status))) await api('/downloads/' + task.id + '/pause', {}); await poll(); }
    catch (error) { notice('model-queue-notice', error); }
  };
  $('model-download-resume-all').onclick = async () => {
    try { for (const task of tasks.filter(task => ['paused', 'failed'].includes(task.status))) await api('/downloads/' + task.id + '/resume', {}); await poll(); }
    catch (error) { notice('model-queue-notice', error); }
  };
  async function loadSettings() {
    try {
      const data = await api('/download-settings'); settingsLoaded = true;
      $('model-download-concurrency').value = String(data.concurrency);
      notice('model-settings-status', `Civitai：${data.has_civitai_key ? (data.civitai_from_env ? '使用环境变量' : '已保存') : '未填写'}；Hugging Face：${data.has_hf_token ? (data.hf_from_env ? '使用环境变量' : '已保存') : '未填写'}；代理：${data.has_proxy ? '已保存' : '使用系统环境代理'}。留空保留原值。`);
    } catch (error) { notice('model-settings-status', error); }
  }
  $('model-settings-form').onsubmit = async event => {
    event.preventDefault(); const submit = event.currentTarget.querySelector('button[type=submit]'); submit.disabled = true;
    const payload = { concurrency: Number($('model-download-concurrency').value) };
    for (const [key, id] of Object.entries({ civitai_key: 'model-civitai-key', hf_token: 'model-hf-token', proxy_url: 'model-download-proxy' })) {
      if ($(id).value.trim() || $('model-clear-download-credentials').checked) payload[key] = $(id).value.trim();
    }
    try {
      await api('/download-settings', payload, 'PUT');
      for (const id of ['model-civitai-key', 'model-hf-token', 'model-download-proxy']) $(id).value = '';
      $('model-clear-download-credentials').checked = false; await loadSettings();
    } catch (error) { notice('model-settings-status', error); }
    finally { submit.disabled = false; }
  };
  $('model-browser-receiver').value = location.origin;
  $('model-copy-receiver').onclick = () => copy(location.origin).then(() => notice('model-queue-notice', '已复制本机接收地址。')).catch(error => notice('model-queue-notice', error));

  function decorateModel(row, item) {
    const metadata = item.metadata || {};
    if (metadata.cover_url?.startsWith('/api/comfy-apps/models/metadata/')) {
      const cover = node('img', '', 'model-local-cover'); cover.src = metadata.cover_url; cover.alt = (metadata.display_name || item.name) + ' 封面'; cover.loading = 'lazy'; row.prepend(cover); row.classList.add('has-cover');
    }
    const summary = node('div', '', 'model-source-summary');
    if (metadata.display_name) summary.append(node('strong', metadata.display_name));
    if (metadata.version) summary.append(node('span', metadata.version));
    const source = sourceLink(metadata.source_url, '来源页面'); if (source) summary.append(source);
    if (summary.childElementCount) row.append(summary);
    function updateSummary(result) {
      Object.assign(metadata, result); item.metadata = metadata;
      summary.replaceChildren();
      if (metadata.display_name) summary.append(node('strong', metadata.display_name));
      if (metadata.version) summary.append(node('span', metadata.version));
      const source = sourceLink(metadata.source_url, '来源页面'); if (source) summary.append(source);
      if (!summary.isConnected) row.insertBefore(summary, details);
      if (metadata.cover_source && !row.querySelector('.model-local-cover')) {
        const cover = node('img', '', 'model-local-cover'); cover.src = '/api/comfy-apps/models/metadata/' + item.id + '/cover'; cover.alt = (metadata.display_name || item.name) + ' 封面';
        cover.onerror = () => { cover.remove(); row.classList.remove('has-cover'); }; row.prepend(cover); row.classList.add('has-cover');
      }
    }
    const details = node('details', '', 'model-metadata-panel'); details.append(node('summary', '模型资料与触发词'));
    let built = false;
    details.ontoggle = () => {
      if (!details.open || built) return; built = true;
      const form = node('form'); const fields = {};
      for (const [key, label, initial] of [['display_name', '显示名称', metadata.display_name || ''], ['version', '模型版本', metadata.version || ''], ['source_url', '来源页面', metadata.source_url || ''], ['trigger_words', '触发词（每行一个）', (metadata.trigger_words || []).join('\n')]]) {
        const wrapper = node('label', label); const input = node(key === 'trigger_words' ? 'textarea' : 'input');
        input.value = initial; if (key === 'trigger_words') input.rows = 3; else input.type = 'text'; wrapper.append(input); fields[key] = input; form.append(wrapper);
      }
      const status = node('p', '', 'model-metadata-status'); status.setAttribute('role', 'status');
      const actions = node('div', '', 'model-task-actions'); const save = node('button', '保存资料'); save.type = 'submit'; actions.append(save);
      const identify = button('从 Civitai 识别资料', async () => {
        status.textContent = '正在计算文件 SHA-256 并查询 Civitai，大模型可能需要等待…';
        try {
          const result = await api('/metadata/' + item.id + '/identify', {});
          for (const [key, input] of Object.entries(fields)) input.value = key === 'trigger_words' ? (result.trigger_words || []).join('\n') : result[key] || '';
          status.textContent = '已识别并保存模型资料。';
          updateSummary(result);
        } catch (error) { status.textContent = error.message; }
      });
      actions.append(identify, button('复制触发词', async () => { await copy(fields.trigger_words.value); status.textContent = '触发词已复制。'; }));
      form.onsubmit = async event => {
        event.preventDefault(); save.disabled = true;
        try {
          const payload = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, key === 'trigger_words' ? input.value.split(/\r?\n/).filter(Boolean) : input.value]));
          const result = await api('/metadata/' + item.id, payload, 'PATCH'); status.textContent = '模型资料已保存。';
          updateSummary(result);
        } catch (error) { status.textContent = error.message; }
        finally { save.disabled = false; }
      };
      if (metadata.sha256) form.append(node('code', metadata.sha256, 'model-saved-sha'));
      form.append(actions, status); details.append(form);
    };
    row.append(details);
  }
  async function receiveLink() {
    const match = location.hash.match(/^#model-download=(.+)$/); if (!match) return;
    try {
      const value = decodeURIComponent(match[1]);
      const link = new URL(value); if (link.protocol !== 'https:' || !['civitai.com', 'civitai.red', 'www.civitai.com', 'www.civitai.red', 'huggingface.co'].includes(link.hostname)) throw new Error('不支持这个模型链接');
      await session;
      window.comfyWorkspace?.showMode('models'); show(true); $('model-link-input').value = value;
      history.replaceState(null, '', location.pathname + location.search);
      $('model-link-form').requestSubmit();
    } catch (error) { notice('model-link-notice', error); }
  }
  window.comfyModelDownloads = { decorateModel, show, refresh: poll };
  window.addEventListener('hashchange', receiveLink);
  window.addEventListener('load', receiveLink, { once: true });
  function schedule() { clearTimeout(pollTimer); pollTimer = setTimeout(async () => { if (!document.hidden && !$('models').hidden && !$('model-download-panel').hidden) await poll(); schedule(); }, 1500); }
  schedule();
})();
