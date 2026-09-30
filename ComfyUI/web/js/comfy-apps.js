(() => {
  const $ = id => document.getElementById(id);
  let active = null, polling = null, submitting = false, requestId = null, opening = 0, uploading = 0;
  let catalogEntries = [];
  const values = {};
  const autoConverted = new Set();
  const elapsed = seconds => `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
  function updateClocks() {
    document.querySelectorAll('[data-task-start]').forEach(node => {
      node.textContent = '已等待 / 运行 ' + elapsed(Math.max(0, Date.now() / 1000 - Number(node.dataset.taskStart)));
    });
  }
  setInterval(updateClocks, 1000);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, action, cls) => { const b = el('button', text, cls); b.type = 'button'; b.onclick = () => Promise.resolve(action()).catch(notice); return b; };
  function notice(error) { $('app-notice').textContent = error.message || String(error); }
  async function exportToCanvas(item) {
    if (!item || item.workflow_error) {
      throw new Error('当前工作流文件无法读取，修复后才能导出到小美画布。');
    }
    let source = item;
    // 工作流库中的原始 UI JSON 还没有可执行 API 图时，沿用现有的
    // “启用为应用”入口生成稳定的本地工作流引用；已经是应用的条目不重复创建。
    if (item.entry_type === 'workflow') {
      source = await post('/workflows/' + encodeURIComponent(item.workflow_ref) + '/enable', {});
    }
    const workflowRef = String(source.workflow || '').trim();
    if (!workflowRef) throw new Error('这个工作流还没有可执行引用，请先打开并完成准备。');
    const readiness = source.readiness || {};
    const payload = {
      workflow_ref: workflowRef,
      workflow_title: String(source.title || item.title || workflowRef.replace(/\.json$/i, '')).trim(),
      workflow_description: String(source.description || item.description || '').trim(),
      workflow_source: String(source.workflow_source || source.workflow_ref || item.workflow_ref || '').trim(),
      app_id: String(source.id || '').trim(),
      fields: Array.isArray(source.fields) ? source.fields : [],
      readiness: {
        can_run: Boolean(readiness.can_run || source.state === 'ready' || source.verified === true),
        workflow_status: String(source.workflow_status || '').trim(),
        summary: String(readiness.summary || '').trim(),
      },
      queued_at: Date.now(),
    };
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'comfy-workflow-to-canvas', payload }, location.origin);
    } else {
      localStorage.setItem('comfy_canvas_workflow_inbox_v1', JSON.stringify(payload));
      window.location.href = '/static/index.html?page=canvas';
      return;
    }
    notice(`已发送“${payload.workflow_title}”，正在打开小美画布…`);
  }
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  async function api(path = '', options = {}) {
    const request = { ...options };
    if (!request.method || String(request.method).toUpperCase() === 'GET') request.cache = 'no-store';
    const response = await fetch('/api/comfy-apps' + path, request);
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data));
    return data;
  }
  const post = (path, data = {}) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  async function deleteApp(item) {
    notice('正在检查应用和模型的使用情况…');
    const plan = await api(`/${item.id}/delete-preview?remove_source=true`);
    if (!plan.can_delete) throw new Error(plan.notes?.[0] || '请等待本地任务结束后再删除。');
    const lines = [`确定删除应用「${plan.title}」吗？`, ''];
    if (plan.workflow_shared) lines.push('工作流文件被其他应用共用，将保留；本应用配置会移入回收区。');
    else lines.push('本应用的工作流和字段配置会移入本地回收区。');
    lines.push('生成结果和历史记录保留。');
    if (plan.source_to_archive) lines.push('原工作流也会移入回收区：' + plan.source_to_archive);
    if (plan.source_kept) lines.push('原工作流仍被其他应用使用，将保留。');
    const exclusive = plan.models?.exclusive || [];
    const shared = plan.models?.shared || [];
    const protectedModels = plan.models?.protected || [];
    if (exclusive.length) {
      lines.push('', '确认后删除以下未被其他应用使用的模型文件：');
      for (const model of exclusive) lines.push(`· ${model.name}（${formatBytes(model.size)}，${model.file_count} 个文件）`);
    } else lines.push('', '没有找到可安全删除的独占模型文件。');
    if (shared.length) {
      lines.push('', '以下共用模型会保留：');
      for (const model of shared) lines.push(`· ${model.name}（仍被${model.users.join('、') || '其他应用'}使用）`);
    }
    if (protectedModels.length) {
      lines.push('', '以下是你手动勾选保留的模型，会保留：');
      for (const model of protectedModels) lines.push(`· ${model.name}（手动保留）`);
    }
    if ((plan.unresolved || []).length) {
      lines.push('', '以下模型无法安全确认，不会自动删除：');
      for (const model of plan.unresolved) lines.push(`· ${model.name}：${model.reason}`);
    }
    lines.push('', '独立 ComfyUI 环境和自定义节点不会删除。');
    if (!window.confirm(lines.join('\n'))) { notice('已取消删除。'); return; }
    notice('正在删除应用并清理独占模型…');
    const result = await api(`/${item.id}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: plan.token, confirmed: true, delete_models: true }),
    });
    const failed = result.model_errors?.length || 0;
    const sharedKept = result.shared_models_kept?.length || 0;
    const protectedKept = result.protected_models_kept?.length || 0;
    const kept = sharedKept + protectedKept;
    notice(failed ? `应用已删除，但有 ${failed} 个模型未能删除；请查看模型是否仍被占用。`
      : `应用已删除${kept ? `，${kept} 个受保护模型已保留` : ''}。`);
    active = null; clearTimeout(polling);
    sessionStorage.removeItem('comfy-app-selected');
    sessionStorage.removeItem('comfy-workflow-selected');
    await library();
  }
  const workflowStatusLabels = {
    ready: '可运行', needs_conversion: '需要转换', conversion_failed: '转换失败',
    missing_models: '缺少模型', missing_nodes: '缺少节点', cloud_review: '需确认云端节点',
    manual_review: '需人工检查', needs_bridge: '需要本地桥接', needs_configuration: '待配置',
    'workflow-unconfigured': '待配置', needs_check: '待检查',
  };
  function workflowStatus(item) {
    if (item.workflow_error) return item.workflow_status || 'conversion_failed';
    if (!item.simple_enabled && item.entry_type === 'workflow') return 'workflow-unconfigured';
    return item.workflow_status || (item.state === 'ready' ? 'ready' : 'needs_configuration');
  }
  function workflowStatusText(item) {
    const status = workflowStatus(item);
    if (status === 'workflow-unconfigured') return '首次准备';
    if (item.environment_status === 'running') return '环境准备中';
    if (item.environment_status === 'failed' || item.environment_status === 'cancelled') return '环境未完成';
    return workflowStatusLabels[status] || '需要检查';
  }
  function workflowCanRun(item) {
    return Boolean(item.readiness?.can_run || (item.state === 'ready' && item.verified));
  }
  async function library(select = true) {
    const data = await api('/catalog');
    const entries = data.entries || data.apps || [];
    catalogEntries = entries;
    const search = $('app-search'), filter = $('catalog-filter');
    const render = () => {
      const query = (search.value || '').trim().toLocaleLowerCase();
      const mode = filter?.value || 'all';
      const visible = catalogEntries.filter(item => {
        if (item.group_parent && catalogEntries.some(parent => parent.id === item.group_parent)) return false;
        if (mode === 'ready' && !workflowCanRun(item)) return false;
        if (mode === 'attention' && workflowCanRun(item)) return false;
        return !query || `${item.title} ${item.description} ${item.workflow_ref || ''}`.toLocaleLowerCase().includes(query);
      });
      $('app-cards').replaceChildren();
      if (!visible.length) {
        $('app-cards').append(el('p', query ? '没有找到匹配的工作流。' : mode !== 'all' ? '没有符合此状态的工作流，请切换“全部工作流”。' : '还没有导入工作流，请点击上方“导入工作流”。', 'app-empty'));
        return;
      }
      for (const item of visible) {
        const card = el('article', '', 'app-card');
        card.dataset.key = entryKey(item);
        card.classList.toggle('selected', entryKey(item) === active || item.id === catalogEntries.find(entry => entry.id === active)?.group_parent);
        const body = el('div', '', 'app-card-body');
        const title = el('div', '', 'app-card-title');
        const status = workflowStatus(item), ready = workflowCanRun(item);
        title.append(el('h2', item.title), el('span', ready ? '可运行' : workflowStatusText(item), 'app-badge ' + (ready ? 'ready' : status)));
        body.append(title, el('p', item.description || '本地 ComfyUI 工作流'));
        const footer = el('div', '', 'app-card-footer');
        footer.append(el('span', item.builtin ? '系统保留' : (item.entry_type === 'workflow' ? '来自工作流库' : (ready ? '本地运行' : '查看处理项')), 'app-card-local'));
        const actions = el('span', '', 'app-card-actions');
        actions.append(button('打开', () => item.entry_type === 'workflow' ? openWorkflow(item.workflow_ref) : open(item.id), 'app-card-action app-card-open'));
        actions.append(button('导出到画布', () => exportToCanvas(item), 'app-card-action app-card-export'));
        if (item.entry_type === 'app') actions.append(button('删除', () => deleteApp(item), 'app-card-delete'));
        footer.append(actions);
        body.append(footer); card.append(body); $('app-cards').append(card);
      }
    };
    if (search && !search.dataset.bound) { search.addEventListener('input', render); search.dataset.bound = 'true'; }
    if (filter && !filter.dataset.bound) { filter.addEventListener('change', render); filter.dataset.bound = 'true'; }
    render();
    if (select && !active) {
      const saved = sessionStorage.getItem('comfy-app-selected');
      const savedWorkflow = sessionStorage.getItem('comfy-workflow-selected');
      const savedItem = entries.find(item => item.id === saved || item.workflow_ref === savedWorkflow);
      const item = entries.find(item => item.id === savedItem?.group_parent) || savedItem || entries.find(workflowCanRun) || entries[0];
      if (item) await (item.entry_type === 'workflow' ? openWorkflow(item.workflow_ref) : open(item.id));
      else {
        $('app-detail').hidden = false;
        $('app-detail').replaceChildren(el('div', '导入 ComfyUI 工作流后，在这里上传商品图、填写提示词并生成。', 'app-empty'));
      }
    }
  }
  let modelCatalogData = null, modelCatalogLoading = false;
  function modelNotice(message) { $('model-notice').textContent = message || ''; }
  function modelDeleteBlockReason(item) {
    const users = (item.users || []).filter(Boolean);
    if (users.length) {
      return item.delete_reason || `不能删除模型“${item.name}”：它正被以下内容使用：${users.join('、')}。请先在对应工作流中更换模型或移除引用。`;
    }
    if (item.user_protected) {
      return item.delete_reason || `不能删除模型“${item.name}”：它已被手动保留。请先取消“手动保留”后再删除。`;
    }
    return item.delete_reason || `当前不能删除模型“${item.name}”，请刷新扫描后查看占用情况。`;
  }
  async function deleteModel(item) {
    const canDelete = item.can_delete !== false && !item.protected && !(item.users || []).length && !item.user_protected;
    if (!canDelete) {
      const reason = modelDeleteBlockReason(item);
      modelNotice(reason);
      window.alert(reason);
      return;
    }
    const location = `${item.root_label || '本地模型'} / ${item.relative_path || item.name}`;
    const confirmed = window.confirm([
      `确定删除模型“${item.name}”吗？`,
      '',
      `位置：${location}`,
      `占用：${formatBytes(item.size)}`,
      '',
      '删除后文件将从本地模型目录移除，不能撤销。',
    ].join('\n'));
    if (!confirmed) { modelNotice('已取消删除。'); return; }
    modelNotice(`正在删除模型“${item.name}”…`);
    let result;
    try {
      result = await api('/models/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model_id: item.id, confirmed: true}),
      });
    } catch (error) {
      modelNotice('删除失败：' + (error.message || error));
      return;
    }
    const refreshed = await loadModelCatalog();
    modelNotice((result.message || `已删除模型“${item.name}”。`) + (refreshed ? '' : '列表刷新失败，请点击“刷新扫描”。'));
  }
  function renderModelCatalog(data) {
    modelCatalogData = data;
    const models = data.models || [];
    const referenced = models.filter(item => (item.users || []).length).length;
    const manuallyKept = models.filter(item => item.user_protected).length;
    const roots = (data.roots || []).filter(item => item.exists).length;
    $('model-summary').replaceChildren(
      ...[['模型文件', String(models.length)], ['占用空间', formatBytes(data.total_size)], ['已被引用', `${referenced} 个`], ['手动保留', `${manuallyKept} 个`], ['已扫描目录', `${roots} 个`]].map(([label, value]) => {
        const card = el('div', '', 'model-summary-card'); card.append(el('span', label), el('strong', value)); return card;
      })
    );
    const draw = () => {
      const query = ($('model-search').value || '').trim().toLocaleLowerCase();
      const state = $('model-status-filter').value;
      const visible = models.filter(item => {
        if (state === 'protected' && !item.protected || state === 'unused' && item.protected) return false;
        const text = [item.name, item.category, item.root_label, item.relative_path, ...(item.users || [])].join(' ').toLocaleLowerCase();
        return !query || text.includes(query);
      });
      const list = $('model-list'); list.replaceChildren();
      if (!visible.length) { list.append(el('div', query ? '没有找到匹配的模型。' : '没有扫描到模型文件。', 'model-empty')); return; }
      for (const item of visible) {
        const row = el('article', '', 'model-row ' + (item.protected ? 'shared' : 'unused') + (item.user_protected ? ' manual' : ''));
        const heading = el('div', '', 'model-row-heading');
        heading.append(el('h3', item.name));
        heading.append(el('span', item.user_protected ? '手动保留' : (item.protected ? '共用 · 保留' : '暂未发现引用'), 'model-status ' + (item.user_protected ? 'manual' : (item.protected ? 'shared' : 'unused'))));
        const keep = el('label', '', 'model-keep');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.checked = Boolean(item.user_protected);
        checkbox.setAttribute('aria-label', '手动保留 ' + item.name);
        checkbox.onchange = async () => {
          const next = checkbox.checked;
          checkbox.disabled = true;
          try {
            await api('/models/protection', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({model_id: item.id, protected: next}),
            });
            await loadModelCatalog();
          } catch (error) {
            checkbox.checked = !next;
            checkbox.disabled = false;
            modelNotice('保存模型保留设置失败：' + (error.message || error));
          }
        };
        keep.append(checkbox, el('span', '手动保留'));
        const actions = el('div', '', 'model-row-actions');
        actions.append(keep);
        const deleteButton = button('删除模型', () => deleteModel(item), 'model-delete');
        const canDelete = item.can_delete !== false && !item.protected && !(item.users || []).length && !item.user_protected;
        deleteButton.setAttribute('aria-label', '删除模型 ' + item.name);
        if (!canDelete) {
          const reason = modelDeleteBlockReason(item);
          deleteButton.classList.add('blocked');
          deleteButton.setAttribute('aria-disabled', 'true');
          deleteButton.title = reason;
        }
        actions.append(deleteButton);
        heading.append(actions);
        const location = el('p', `${item.root_label} / ${item.relative_path}`, 'model-location');
        const meta = el('div', '', 'model-row-meta');
        meta.append(el('span', formatBytes(item.size)), el('span', item.category), el('span', item.modified_at ? new Date(item.modified_at * 1000).toLocaleString() : '修改时间未知'));
        const users = el('p', '', 'model-users');
        users.append(el('strong', '引用关系：'), el('span', item.users?.length ? item.users.join('、') : '暂未在应用、工作流或画布中发现引用'));
        row.append(heading, location, meta, users); list.append(row);
      }
    };
    if (!$('model-search').dataset.bound) { $('model-search').addEventListener('input', draw); $('model-status-filter').addEventListener('change', draw); $('model-search').dataset.bound = 'true'; }
    draw();
    const warning = (data.warnings || []).join('\n');
    modelNotice(`扫描完成：${models.length} 个模型文件，占用 ${formatBytes(data.total_size)}。${warning ? '\n' + warning : ''}`);
  }
  async function loadModelCatalog() {
    if (modelCatalogLoading) return;
    modelCatalogLoading = true; $('model-refresh').disabled = true; modelNotice('正在扫描本地模型目录…');
    try { renderModelCatalog(await api('/models')); return true; }
    catch (error) { modelNotice('扫描失败：' + (error.message || error)); return false; }
    finally { modelCatalogLoading = false; $('model-refresh').disabled = false; }
  }
  function safeLink(url) { return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//'); }
  function sourceLink(entry) {
    if (!/^https?:\/\//i.test(entry?.source || '')) return null;
    const link = el('a', '来源'); link.href = entry.source; link.target = '_blank'; link.rel = 'noopener'; return link;
  }
  async function importMissingModel(id, entry, replace = false, row = null) {
    row = row || document.querySelector('.app-preflight');
    let status = row?.querySelector('.app-model-import-status');
    if (!status) { status = el('small', '', 'app-model-import-status'); status.setAttribute('role', 'status'); row?.append(status); }
    const report = message => { status.textContent = message.message || String(message); notice(message); };
    const picker = document.createElement('input');
    picker.type = 'file'; picker.accept = [...(window.modelFileExtensions || []), '.safetensors,.ckpt,.pt,.pth,.bin,.onnx,.gguf,.ggml,.sft,.tflite,.msgpack,.pkl,.npz'].join(',');
    picker.hidden = true; document.body.append(picker);
    report(replace ? '请选择要替换的本地模型文件。' : `请选择本地模型文件：${entry.name}。文件名不同时，请使用“替换模型”。`);
    picker.oncancel = () => { report('已取消选择模型。'); picker.remove(); };
    picker.onchange = async () => {
      const file = picker.files?.[0]; picker.remove(); if (!file) return;
      const body = new FormData(); body.append('file', file);
      body.append('dependency', entry.name || ''); body.append('category', entry.category || 'models');
      const expectedName = String(entry.name || '').replace(/^.*[\\/]/, '');
      const renamed = Boolean(expectedName && file.name !== expectedName);
      const useReplacement = replace || renamed;
      if (useReplacement) body.append('replace', 'true');
      report(renamed && !replace
        ? `文件名为 ${file.name}，将按“替换模型”更新此加载器引用；正在导入并复查…`
        : `正在导入模型 ${file.name}（${formatBytes(file.size)}），导入完成后会自动复查…`);
      try {
        const result = await api('/' + id + '/models/import', { method: 'POST', body });
        await open(id);
        report(result.message || '模型已导入并完成复查。');
        $('app-notice').scrollIntoView({ block: 'nearest' });
      } catch (error) { report(error); }
    };
    picker.click();
  }
  async function replacementPicker(id, entry, row) {
    const existing = row.querySelector('.app-model-replacement');
    if (existing) { existing.remove(); return; }
    const panel = el('div', '', 'app-model-replacement');
    panel.append(el('small', '选择与当前工作流基础模型兼容的文件。替换会改变生成效果，原始工作流会保留。'));
    row.append(panel);
    const data = await api('/' + id + '/models/replacements?dependency=' + encodeURIComponent(entry.name) + '&category=' + encodeURIComponent(entry.category));
    if (data.models?.length) {
      const select = el('select'); select.setAttribute('aria-label', '选择替换模型');
      for (const name of data.models) { const option = el('option', name); option.value = name; select.append(option); }
      panel.append(select, button('使用所选模型', async () => {
        const result = await post('/' + id + '/models/replace', { dependency: entry.name, category: entry.category, replacement: select.value });
        notice(result.message); await open(id);
      }));
    } else panel.append(el('small', '对应目录暂无其他模型，可以上传替换文件。'));
    panel.append(button('上传另一个文件并替换', () => importMissingModel(id, entry, true, row)));
  }
  function preflightPanel(preflight, appId = '') {
    const panel = el('div', '', 'app-preflight');
    if (!preflight) { panel.append(el('p', '正在读取硬件和依赖检查…')); return panel; }
    const labels = { pass: '检查通过', warning: '可以安装，但有风险或手动项目', blocked: '无法开始安装' };
    const status = el('div', '', 'app-preflight-status ' + (preflight.status || 'warning'));
    status.append(el('strong', labels[preflight.status] || '需要检查'), el('span', preflight.summary || '请查看下面的检查结果。'));
    panel.append(status);
    const hardware = preflight.hardware || {};
    const rows = el('div', '', 'app-hardware-grid');
    const gpu = (hardware.gpu || []).map(item => item.vram_gb == null ? item.name : `${item.name}（显存 ${item.vram_gb} GB）`).join('、') || '未检测到或无法确认';
    const ram = hardware.ram_gb == null ? '无法确认' : `${hardware.ram_gb} GB`;
    const disk = hardware.disk_free_gb == null ? '无法确认' : `${hardware.disk_free_gb} GB 可用`;
    for (const [label, value] of [['显卡', gpu], ['内存', ram], ['工作区磁盘', disk], ['基础环境', hardware.base_comfyui_ready ? '已找到本机 ComfyUI' : '未找到 core/.venv']]) {
      const row = el('div', '', 'app-hardware-row'); row.append(el('span', label), el('strong', value)); rows.append(row);
    }
    const hardwareSection = el('section', '', 'app-preflight-section app-hardware-section');
    const hardwareHeading = el('div', '', 'app-preflight-section-heading');
    hardwareHeading.append(el('strong', '本机环境'), el('span', '已识别信息'));
    hardwareSection.append(hardwareHeading, rows);
    panel.append(hardwareSection);

    const guidanceEntries = preflight.guidance || [];
    if (guidanceEntries.length) {
      const guidanceSection = el('section', '', 'app-preflight-section app-guidance-section');
      const guidanceHeading = el('div', '', 'app-preflight-section-heading');
      guidanceHeading.append(el('strong', '运行建议'), el('span', '开始前先看这里'));
      const guidanceList = el('div', '', 'app-guidance-list');
      for (const [index, guidance] of guidanceEntries.entries()) {
        const tone = ['reference', 'recommendation', 'verification'][index] || 'default';
        const card = el('article', '', 'app-guidance-card app-guidance-card-' + tone);
        const cardHeading = el('div', '', 'app-guidance-card-heading');
        cardHeading.append(el('h4', guidance.label || '运行说明'));
        card.append(cardHeading, el('p', guidance.detail || ''));
        if (guidance.source?.startsWith('https://')) {
          const actions = el('div', '', 'app-guidance-actions');
          const link = el('a', '查看官方说明', 'app-guidance-source'); link.href = guidance.source; link.target = '_blank'; link.rel = 'noopener';
          actions.append(link); card.append(actions);
        }
        guidanceList.append(card);
      }
      guidanceSection.append(guidanceHeading, guidanceList);
      panel.append(guidanceSection);
    }

    const requirements = preflight.requirements || {};
    const requirementEntries = [];
    for (const requirement of requirements.known || []) {
      const actual = requirement.actual_gb == null ? '无法确认' : `${requirement.actual_gb} GB`;
      requirementEntries.push(`${requirement.label}：最低 ${requirement.minimum_gb} GB，检测到 ${actual}。`);
    }
    for (const requirement of requirements.unknown || []) requirementEntries.push(`${requirement.label}：${requirement.reason}`);
    if (requirementEntries.length) {
      const requirementSection = el('section', '', 'app-preflight-section app-requirement-section');
      const requirementHeading = el('div', '', 'app-preflight-section-heading');
      requirementHeading.append(el('strong', '资源要求'), el('span', '工作流声明'));
      const list = el('div', '', 'app-requirement-list');
      for (const message of requirementEntries) list.append(el('p', message, 'app-preflight-note'));
      requirementSection.append(requirementHeading, list); panel.append(requirementSection);
    }

    const alerts = el('div', '', 'app-preflight-alerts');
    for (const reason of preflight.hard_failures || []) alerts.append(el('p', '不能安装：' + reason, 'app-preflight-error'));
    for (const warning of preflight.warnings || []) alerts.append(el('p', '提示：' + warning, 'app-preflight-warning'));
    if (alerts.children.length) panel.append(alerts);

    /* Keep the setup flow in reading order: inspect the machine, read the
       guidance, resolve alerts, then review the full dependency list. */
    const dependencies = preflight.dependencies || {};
    const dependencySection = el('section', '', 'app-dependency-section');
    dependencySection.append(el('strong', '工作流模型与节点'));
    const groups = [['待补齐', dependencies.manual, 'manual'], ['可自动安装', dependencies.auto_installable, 'install'], ['已准备', dependencies.installed, 'ready']];
    for (const [title, entries, kind] of groups) {
      if (!entries?.length) continue;
      const group = el('div', '', 'app-dependency-group ' + kind); group.append(el('strong', title));
      for (const entry of entries) {
        const row = el('div', '', 'app-dependency-row');
        const roles = { diffusion_models: '主模型 · 图像生成', checkpoints: '整合模型', text_encoders: '文本编码器 · 理解提示词', vae: 'VAE · 图像编解码', loras: 'LoRA · 风格 / 效果', upscale_models: '放大模型', SEEDVR2: 'SeedVR2 · 高清放大', controlnet: 'ControlNet · 结构控制', clip_vision: '视觉编码器' };
        row.append(el('strong', entry.kind === '模型' ? (roles[entry.category] || '模型') : entry.kind || '依赖'));
        row.append(el('span', entry.name, 'app-dependency-name'));
        if (entry.status) row.append(el('small', entry.status));
        if (entry.kind === '模型' && entry.category) row.append(el('small', `模型目录：${entry.category}`));
        if (entry.detail) row.append(el('small', entry.detail));
        const link = sourceLink(entry); if (link) row.append(link);
        if (entry.search) {
          const searched = entry.search.searched || [];
          if (searched.length) row.append(el('small', '已查询：' + [...new Set(searched)].join('、')));
          for (const found of entry.search.links || []) {
            if (!/^https:\/\//i.test(found.url || '') || found.url === entry.source) continue;
            const link = el('a', found.label || '查看来源'); link.href = found.url; link.target = '_blank'; link.rel = 'noopener'; row.append(link);
          }
          for (const error of entry.search.errors || []) row.append(el('small', `${error.source}：${error.reason}`));
        }
        if (kind === 'install' && entry.kind === '模型' && entry.download_id && appId) {
          row.append(button('自动安装', async () => {
            await post('/' + appId + '/prepare');
            notice('已开始自动下载模型；右侧会显示真实进度。');
            await open(appId);
          }, 'app-primary'));
        }
        if (kind === 'install' && ['节点包', '兼容桥接', '环境检查'].includes(entry.kind) && appId) {
          const label = entry.kind === '兼容桥接' ? '更新兼容桥接'
            : entry.kind === '环境检查' ? '启动并检查节点' : '安装缺失节点';
          row.append(button(label, async () => {
            await post('/' + appId + '/install-nodes');
            notice('正在安装已识别的缺失节点；完成后会重启并重新检查，不下载模型。');
            await open(appId);
          }, 'app-primary'));
        }
        if (kind === 'manual' && entry.kind === '模型' && appId) {
          row.append(button('导入此模型', () => importMissingModel(appId, entry, false, row)));
        }
        if (entry.kind === '模型' && entry.category && appId) {
          row.append(button(entry.category === 'loras' ? '替换 LoRA' : '替换模型', () => replacementPicker(appId, entry, row)));
        }
        group.append(row);
      }
      dependencySection.append(group);
    }
    if (dependencySection.children.length > 1) panel.append(dependencySection);
    return panel;
  }
  function preparationLive(task, id, log = '', existing = null) {
    const status = existing || el('div');
    if (!existing) {
      const cancel = button('取消安装', async () => { await post('/' + id + '/prepare/cancel'); notice('正在取消安装；已下载文件会保留。'); });
      cancel.className = 'app-prepare-cancel';
      const retry = button('重试搜索 / 下载', async () => { await post('/' + id + '/prepare'); await open(id); });
      retry.className = 'app-prepare-retry';
      const details = el('details', '', 'app-prepare-log');
      details.append(el('summary', '查看安装日志尾部'), el('pre'));
      status.append(el('progress'), el('strong'), el('p', '', 'app-prepare-detail'), el('p', '', 'app-prepare-error'), cancel, retry,
        el('small', '进度条按安装阶段更新；下载源未提供文件百分比时会显示“处理中”。'), details);
    }
    status.className = 'app-prepare-live ' + (task.status || 'running');
    const progress = task.progress || {};
    const bar = status.querySelector('progress'); bar.max = Number(progress.max) > 0 ? Number(progress.max) : 100; bar.setAttribute('aria-label', '环境安装进度');
    const value = Number(progress.value), max = Number(progress.max);
    if (!progress.indeterminate && Number.isFinite(value) && Number.isFinite(max) && max > 0) bar.value = Math.min(max, Math.max(0, value));
    else bar.removeAttribute('value');
    const percent = !progress.indeterminate && Number.isFinite(value) && max > 0 ? ` ${Math.floor(value / max * 100)}%` : ' 处理中';
    const detailText = String(progress.detail || task.stage || '').toLowerCase();
    const phase = detailText.includes('模型') || detailText.includes('下载') ? '模型下载' : '本地环境准备';
    const updateText = (selector, text) => { const node = status.querySelector(selector); if (node.textContent !== text) node.textContent = text; };
    updateText('strong', `${phase}：${task.stage || task.status}${percent}`);
    updateText('.app-prepare-detail', progress.detail || '');
    updateText('.app-prepare-error', task.error || '');
    status.querySelector('.app-prepare-error').hidden = !task.error;
    status.querySelector('.app-prepare-cancel').hidden = !['queued', 'running'].includes(task.status);
    status.querySelector('.app-prepare-retry').hidden = !['failed', 'cancelled'].includes(task.status);
    status.querySelector('details').hidden = !log;
    updateText('pre', log);
    return status;
  }
  async function exportPsd(task) {
    const info = task.result.layers;
    for (const layer of info.layers) {
      if (!safeLink(layer.url)) throw new Error('图层下载地址无效');
    }
    const bytes = await window.XiaomeiLayerPsd.build(info);
    const result = await api(`/${task.app_id}/tasks/${task.task_id}/psd`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const a = el('a'); a.href = result.url; a.download = ''; a.click(); notice('PSD 已生成并保存在本次任务中。');
  }
  function taskPreview(task) {
    const generated = (task.result?.items || []).filter(item => item.kind === 'image' && item.class_type === 'SaveImage').map(item => item.url);
    const candidates = generated.length ? generated : (task.result?.images || []);
    return candidates.find(safeLink) || '';
  }
  function taskDownloads(task) {
    const actions = el('div', '', 'app-downloads');
    const preview = taskPreview(task);
    if (preview) {
      const image = el('a', '下载图片', 'download-primary'); image.href = preview; image.download = ''; actions.append(image);
    }
    for (const url of task.result?.files || []) {
      if (!safeLink(url)) continue;
      const link = el('a', /\.zip(?:\?|$)/i.test(url) ? '下载图层 ZIP' : '下载文件'); link.href = url; link.download = ''; actions.append(link);
    }
    if (task.result?.psd && safeLink(task.result.psd)) {
      const link = el('a', '下载 PSD'); link.href = task.result.psd; link.download = ''; actions.append(link);
    } else if (task.result?.layers) {
      const link = button('下载 PSD', () => exportPsd(task)); link.setAttribute('aria-label', '下载分层 PSD'); actions.append(link);
    }
    return actions;
  }
  function layerDetails(task) {
    if (!task.result?.layers) return null;
    const info = task.result.layers;
    const details = el('details', '', 'app-layer-details');
    details.append(el('summary', `透明 PNG 图层（${info.layers.length}）`));
    const grid = el('div', '', 'app-layer-grid');
    for (const layer of info.layers) {
      if (!safeLink(layer.url)) continue;
      const link = el('a'), image = el('img'); link.href = layer.url; link.download = layer.filename;
      image.src = layer.url; image.alt = layer.name; image.loading = 'lazy'; link.append(image, el('span', layer.name)); grid.append(link);
    }
    details.append(grid); return details;
  }
  function liveStatus(task) {
    const status = el('div', '', 'app-live-status');
    const bar = el('progress'); bar.max = 100; bar.setAttribute('aria-label', '当前任务进度');
    const value = Number(task.progress?.value), max = Number(task.progress?.max);
    if (task.status === 'running' && Number.isFinite(value) && max > 0 && value >= 0 && value < max) {
      bar.value = Math.min(100, value / max * 100);
      status.append(el('p', `当前节点 ${value} / ${max}（${Math.floor(bar.value)}%）。`));
    } else {
      status.append(el('p', task.status === 'queued' ? '正在等待本机执行，请勿重复提交。' : '处理中，当前阶段未提供准确百分比。加载模型和生成图层可能需要数分钟。'));
    }
    const clock = el('p'); clock.dataset.taskStart = task.created_at;
    status.prepend(bar); status.append(clock, el('small', '每 2.5 秒更新一次，可以离开页面后回来查看。'));
    return status;
  }
  function results(tasks, target) {
    const signature = JSON.stringify(tasks);
    if (target.resultSignature === signature) return;
    target.resultSignature = signature;
    const historyWasOpen = target.querySelector('.app-history')?.open || false;
    const layersWereOpen = target.querySelector('.app-layer-details')?.open || false;
    target.replaceChildren();
    const ordered = [...tasks].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    if (!ordered.length) { target.append(el('div', '运行后，结果会显示在这里。', 'app-empty-result')); return; }
    const live = ordered.filter(task => ['queued', 'running'].includes(task.status));
    const current = live[0] || ordered[0];
    const older = ordered.filter(task => task !== current).slice(0, 12);
    const row = el('article', '', 'app-task ' + current.status);
    row.append(el('h3', live.length ? '当前任务' : '最近一次结果'));
    row.append(el('strong', current.stage || current.status), el('p', new Date(current.created_at * 1000).toLocaleString()));
    if (['queued', 'running'].includes(current.status)) row.append(liveStatus(current));
    if (current.error) row.append(el('p', current.error));
    if (current.status === 'succeeded') {
      const preview = taskPreview(current);
      if (preview) {
        const main = el('div', '', 'app-main-result'), figure = el('figure'), image = el('img');
        image.src = preview; image.alt = '本次运行结果'; figure.append(image, el('figcaption', '本次运行结果')); main.append(figure, taskDownloads(current));
        const layers = layerDetails(current);
        if (layers) { layers.open = layersWereOpen; main.append(layers); }
        row.append(main);
      } else row.append(el('div', '任务已完成，但没有可显示的图片结果。', 'app-empty-result'));
    }
    target.append(row);
    if (older.length) {
      const history = el('details', '', 'app-history'); history.open = historyWasOpen;
      history.append(el('summary', `历史运行（${older.length}）`));
      const grid = el('div', '', 'app-history-grid');
      for (const task of older) {
        const preview = taskPreview(task);
        if (!preview) { grid.append(el('div', task.error ? '运行失败' : task.stage || task.status, 'app-history-failed')); continue; }
        const link = el('a', '', 'app-history-item'); link.href = preview; link.target = '_blank'; link.rel = 'noopener';
        const image = el('img'); image.src = preview; image.alt = '历史运行结果'; image.loading = 'lazy';
        link.append(image, el('strong', task.status === 'succeeded' ? '已完成' : task.stage || task.status), el('small', new Date(task.created_at * 1000).toLocaleString())); grid.append(link);
      }
      history.append(grid); target.append(history);
    }
    updateClocks();
  }
  async function poll(id, target) {
    if (active !== id) return;
    try {
      const item = await api('/' + id);
      if (active !== id) return;
      const prepareTaskId = String(item.prepare_task || '');
      if (target.prepareTaskId !== prepareTaskId) {
        target.prepareTaskId = prepareTaskId;
        target.preparationDone = !prepareTaskId;
      }
      results(item.tasks, target);
      const badge = document.querySelector('.app-heading > .app-badge');
      if (badge) { badge.textContent = workflowCanRun(item) ? '可生成' : workflowStatusText(item); badge.className = 'app-badge ' + workflowStatus(item); }
      const readyCard = document.querySelector('.app-run-panel > .app-readiness');
      const readinessKey = JSON.stringify(item.readiness);
      if (readyCard && target.readinessKey !== readinessKey) { readyCard.replaceWith(readinessPanel(item)); target.readinessKey = readinessKey; }
      const entry = catalogEntries.find(entry => entry.id === id);
      if (entry) Object.assign(entry, { readiness: item.readiness, workflow_status: item.workflow_status, environment_status: item.environment_status });
      const sidebarBadge = document.querySelector('.app-card.selected .app-badge');
      if (sidebarBadge) sidebarBadge.textContent = workflowStatusText(item);
      const run = $('app-run');
      const pending = item.tasks.some(t => ['queued', 'running'].includes(t.status));
      if (run && !submitting) { run.disabled = !workflowCanRun(item) || pending || uploading > 0; run.textContent = pending ? '生成中…' : '生成'; }
      if (workflowCanRun(item) && target.dataset.wasReady === 'false') { await open(id); return; }
      if (requestId && item.tasks.some(t => t.client_request_id === requestId && ['succeeded', 'failed'].includes(t.status))) requestId = null;
      const conversionKey = 'workflow:' + id + ':' + (item.updated_at || '');
      if (!item.prepare_task && !item.api && item.managed && item.report?.backend_available && !item.report?.missing_nodes?.length && Array.isArray(item.source?.nodes) && !autoConverted.has(conversionKey)) {
        autoConverted.add(conversionKey);
        try { await convert(item); return; } catch (error) { notice(error); }
      }
      if (item.prepare_task && !target.preparationDone) {
        const prep = await api('/' + id + '/preparation');
        if (active !== id) return;
        if (prep.task) {
          const setup = document.querySelector('.app-run-panel .app-setup-card');
          if (setup && setup.dataset.prepareStatus !== prep.task.status) {
            setup.dataset.prepareStatus = prep.task.status;
            const running = ['queued', 'running'].includes(prep.task.status);
            setup.querySelector(':scope > strong').textContent = running ? '正在准备本地运行环境' : prep.task.status === 'succeeded' ? '本地环境已完成，但工作流仍需要处理' : '本次准备未完成，可在右侧继续下载';
            setup.querySelector('.app-preflight')?.replaceWith(preflightPanel(prep.preflight, id));
            const hint = setup.querySelector('.app-prepare-hint');
            if (hint) hint.textContent = running ? '安装进度会显示在右侧结果区域；可以取消，已下载文件会保留。' : '依赖检查已更新；仍缺少的文件见上方清单。';
            const checklist = document.querySelector('.app-preparation-details > .app-checklist');
            if (checklist) checklist.replaceChildren(...(item.report?.reasons || []).map(reason => el('li', reason)));
            const missingModels = [...(prep.preflight?.dependencies?.manual || []), ...(prep.preflight?.dependencies?.auto_installable || [])].some(entry => entry.kind === '模型');
            let searchButton = setup.querySelector('.app-search-models');
            if (!running && missingModels && !searchButton) {
              searchButton = button('自动寻找并下载缺失模型', async () => { await post('/' + id + '/prepare'); await open(id); }, 'app-primary app-search-models');
              setup.append(searchButton);
            }
            if (searchButton) searchButton.disabled = running;
          }
          const slot = target.preparationTarget;
          const current = slot.firstElementChild;
          const panel = preparationLive(prep.task, id, prep.log, current);
          if (!current) slot.append(panel);
          if (prep.task.status === 'succeeded' && !item.api && !(item.report?.missing_nodes || []).length && Array.isArray(item.source?.nodes) && !autoConverted.has(prep.task.task_id)) {
            autoConverted.add(prep.task.task_id);
            try { await convert(item); return; } catch (error) { notice(error); }
          }
          if (['succeeded', 'failed', 'cancelled'].includes(String(prep.task.status || ''))) {
            target.preparationDone = true;
          }
        } else {
          target.preparationDone = true;
        }
      }
      if (pending || (item.prepare_task && !target.preparationDone)) {
        polling = setTimeout(() => poll(id, target), 2500);
      } else {
        polling = null;
      }
    } catch (error) { notice('任务状态更新失败，5 秒后重试；当前显示的是上次查询结果。' + (error.message || error)); polling = setTimeout(() => poll(id, target), 5000); }
  }
  function fieldControl(field, panel, id, canRun = false) {
    const input = el(field.type === 'text' || field.type === 'textarea' ? 'textarea' : field.type === 'dropdown' ? 'select' : 'input');
    input.id = 'app-field-' + field.id;
    if (field.type === 'image') {
      const label = el('div', field.name, 'app-field-label');
      const upload = el('label', '', 'app-upload');
      const title = el('strong', '上传商品图');
      const help = el('small', 'PNG、JPG 或 WebP，文件只上传到本机');
      input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
      const preview = el('img'); preview.className = 'app-preview'; preview.hidden = true;
      const previewWrap = el('div', '', 'app-preview-wrap');
      const replace = button('更换商品图', () => input.click(), 'app-preview-replace');
      replace.hidden = true;
      replace.setAttribute('aria-label', '更换商品图');
      previewWrap.hidden = true;
      previewWrap.append(preview, replace);
      upload.append(title, help, input);
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        input.disabled = true; replace.disabled = true; uploading++; if ($('app-run')) $('app-run').disabled = true;
        notice('正在上传到本机 ComfyUI…');
        try {
          const body = new FormData(); body.append('image', file);
          const result = await api('/' + id + '/upload', { method: 'POST', body });
          if (active !== id) return;
          values[field.id] = result.name; requestId = null;
          if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
          preview.src = URL.createObjectURL(file); preview.hidden = false; previewWrap.hidden = false;
          upload.hidden = true; replace.hidden = false;
          input.value = '';
          notice('图片已上传，仅保存在本机。');
        } catch (error) { notice(error); } finally {
          input.disabled = false; replace.disabled = false; uploading--;
          const runButton = $('app-run');
          if (runButton && active === id && !submitting) runButton.disabled = !canRun || uploading > 0;
        }
      };
      panel.append(label); if (field.description) panel.append(el('small', field.description, 'app-field-help')); panel.append(upload, previewWrap); return;
    }
    if (field.type === 'audio' || field.type === 'video') {
      input.type = 'text'; input.disabled = true;
      const label = el('label', field.name, 'app-field-label'); label.htmlFor = input.id;
      panel.append(label, el('small', '当前本地应用库暂不支持此类上传；请打开高级编辑器配置。', 'app-field-help'), input);
      return;
    }
    const label = el('label', field.name, 'app-field-label'); label.htmlFor = input.id;
    if (field.type === 'number') { input.type = 'number'; for (const k of ['min', 'max', 'step']) if (field[k] != null) input[k] = field[k]; }
    if (field.type === 'boolean') {
      input.type = 'checkbox'; input.checked = Boolean(field.default);
      input.style.width = '18px'; input.style.height = '18px'; input.style.accentColor = 'var(--app-accent)';
    }
    if (field.type === 'dropdown') {
      for (const option of field.options || []) {
        const choice = el('option', String(option)); choice.value = String(option); input.append(choice);
      }
      input.value = field.default ?? (field.options || [])[0] ?? '';
    } else if (field.type === 'boolean') {
      values[field.id] = Boolean(field.default);
    } else {
      input.value = field.default ?? ''; values[field.id] = field.default;
    }
    input.oninput = () => {
      values[field.id] = field.type === 'number' ? Number(input.value) : field.type === 'boolean' ? input.checked : input.value;
      requestId = null;
    };
    panel.append(label); if (field.description) panel.append(el('small', field.description, 'app-field-help')); panel.append(input);
  }
  async function waitForManagedBackend(address, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('/api/comfyui/status', { cache: 'no-store' });
        if (response.ok) {
          const status = await response.json();
          const instance = (status.instances || []).find(item => address
            ? item.address === address
            : item.managed);
          if (instance?.online) return String(instance.address || '');
        }
      } catch (_) { /* The next probe can still succeed while the service starts. */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return '';
  }
  async function ensureManagedBackend(item, address) {
    if (!item.managed) return address;
    notice('本地 ComfyUI 未运行，正在启动已准备的环境…');
    let response;
    try {
      response = await fetch('/api/comfyui/start', { method: 'POST', cache: 'no-store' });
    } catch (error) {
      throw new Error('启动本地 ComfyUI 失败：' + (error.message || error));
    }
    let data = {};
    try { data = await response.json(); } catch (_) { /* Use the HTTP status below. */ }
    if (!response.ok) {
      // A preparation or another start request may already own the runtime
      // lock.  Wait for that operation rather than asking the user to retry
      // blindly; a 409 is expected during this short hand-off.
      if (response.status === 409) {
        const readyAddress = await waitForManagedBackend(address);
        if (readyAddress) return readyAddress;
      }
      throw new Error(data.detail || '本地 ComfyUI 启动失败，请查看运行日志。');
    }
    const startedAddress = String(data.address || address || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
    // The start endpoint only returns after its own identity and node probe
    // succeeds.  Keep the fallback for lightweight test/local proxies that
    // acknowledge the request without echoing an address.
    const readyAddress = startedAddress && data.address
      ? await waitForManagedBackend(startedAddress)
      : startedAddress;
    if (readyAddress) {
      window.comfyWorkspace?.refresh?.(readyAddress);
      return readyAddress;
    }
    throw new Error('本地 ComfyUI 启动后仍未响应，请查看运行日志并重试。');
  }
  async function configure(item) {
    const container = el('section', '', 'app-panel');
    container.append(el('h2', '应用名称与输入项'));
    const title = el('input'); title.value = item.title; title.setAttribute('aria-label', '应用名称'); container.append(title);
    const rows = el('div');
    for (const field of item.fields) {
      const row = el('div', '', 'app-editor-row'), name = el('input'); name.value = field.name; name.setAttribute('aria-label', field.name); row.dataset.id = field.id;
      row.append(name, button('上移', () => { if (row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling); }), button('下移', () => { if (row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row); })); rows.append(row);
    }
    container.append(rows, button('保存', async () => {
      await api('/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.value, fields: [...rows.children].map(row => ({ id: row.dataset.id, name: row.querySelector('input').value })) }) });
      await open(item.id);
    }, 'app-primary'));
    $('app-detail').replaceChildren(container);
  }
  async function convert(item) {
    if (item.report?.missing_nodes?.length) throw new Error('请先安装缺失节点，再生成操作表单：' + item.report.missing_nodes.join('、'));
    const frame = $('converter');
    let address = item.backend || window.comfyWorkspace.address();
    if (item.managed) address = await ensureManagedBackend(item, address);
    if (!address) throw new Error('请先启动本地 ComfyUI 并重新连接。');
    const origin = 'http://' + address, nonce = crypto.randomUUID();
    if (!frame.src.startsWith(origin + '/')) {
      frame.src = origin + '/';
    }
    notice('正在等待本地 ComfyUI 完成初始化…');
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearInterval(ping); clearTimeout(timeout); window.removeEventListener('message', receive); };
      const receive = event => {
        if (event.origin === origin && event.source === frame.contentWindow && event.data?.type === 'xiaomei-ready' && event.data.nonce === nonce && event.data.ready) { cleanup(); resolve(); }
      };
      const ping = setInterval(() => frame.contentWindow.postMessage({ type: 'xiaomei-ping', nonce }, origin), 500);
      const timeout = setTimeout(() => { cleanup(); reject(new Error('本地转换桥接未就绪，请启动本地 ComfyUI 后重试。')); }, 45000);
      window.addEventListener('message', receive);
    });
    notice('正在使用 ComfyUI 原生能力转换工作流…');
    const answer = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); };
      const receive = event => {
        if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.nonce !== nonce || event.data?.type !== 'xiaomei-converted') return;
        cleanup(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.prompt);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('本地桥接未响应。请先准备桥接扩展、重启 ComfyUI，再点“重新连接”。原工作流已保留。')); }, 25000);
      window.addEventListener('message', receive);
      frame.contentWindow.postMessage({ type: 'xiaomei-convert', nonce, workflow: item.source }, origin);
    });
    await post('/' + item.id + '/convert', { prompt: answer });
    notice('转换完成。'); await open(item.id);
  }
  function entryKey(item) { return item.entry_type === 'workflow' ? 'workflow:' + item.workflow_ref : item.id; }
  function showOpeningDetail() {
    window.comfyWorkspace.selectWorkflow(null);
    $('app-detail').hidden = false;
    $('app-detail').replaceChildren(el('p', '正在读取工作流与本机依赖…', 'app-loading'));
  }
  async function openWorkflow(name) {
    const turn = ++opening;
    active = null;
    showOpeningDetail();
    notice('正在打开工作流…');
    const item = await post('/workflows/' + encodeURIComponent(name) + '/enable');
    if (turn !== opening) return;
    await library(false);
    if (turn !== opening) return;
    notice('');
    return open(item.id);
  }
  function openEditor(item) {
    if (!item || active !== entryKey(item)) return;
    window.comfyWorkspace.openWorkflow(item);
  }
  function readinessPanel(item) {
    const readiness = item.readiness || {};
    const state = readiness.environment === 'running' ? 'running' : readiness.can_run ? 'ready' : 'blocked';
    const panel = el('div', '', 'app-readiness ' + state);
    panel.append(el('strong', readiness.can_run ? '工作流可以运行' : (readiness.environment === 'running' ? '正在准备本地环境' : '工作流还不能运行')),
      el('span', readiness.summary || workflowStatusText(item)));
    return panel;
  }
  async function open(idOrItem) {
    const turn = ++opening;
    active = null;
    clearTimeout(polling); submitting = false; requestId = null;
    showOpeningDetail();
    let item = typeof idOrItem === 'object' ? idOrItem : await api('/' + idOrItem);
    if (item.entry_type === 'app' && item.readiness?.environment !== 'running') {
      try { const checked = await post('/' + item.id + '/rescan'); if (checked?.id === item.id) item = checked; } catch (error) { notice('暂时无法复查本地节点：' + (error.message || error)); }
    }
    if (turn !== opening) return;
    for (const k of Object.keys(values)) delete values[k];
    const key = entryKey(item); active = key;
    sessionStorage.removeItem('comfy-app-selected'); sessionStorage.removeItem('comfy-workflow-selected');
    if (item.entry_type === 'workflow') sessionStorage.setItem('comfy-workflow-selected', item.workflow_ref);
    else sessionStorage.setItem('comfy-app-selected', item.id);
    if (active !== key) return;
    document.querySelectorAll('.app-card').forEach(card => card.classList.toggle('selected', card.dataset.key === key || card.dataset.key === item.group_parent));
    $('app-cards').hidden = false; $('app-detail').hidden = false;
    const heading = el('div', '', 'app-heading');
    const ready = workflowCanRun(item);
    const badgeStatus = ready ? 'ready' : workflowStatus(item);
    heading.append(el('h2', item.title), el('span', ready ? '可生成' : workflowStatusText(item), 'app-badge ' + badgeStatus));
    heading.append(button('导出到小美画布', () => exportToCanvas(item), 'app-export-canvas'));
    if (item.entry_type === 'workflow') {
      heading.append(button('启用为应用', async () => { const enabled = await post('/workflows/' + encodeURIComponent(item.workflow_ref) + '/enable'); notice('已加入应用库。'); await open(enabled.id); }, 'app-primary'));
    } else {
      const manage = el('details', '', 'app-manage'); manage.append(el('summary', '管理工作流'));
      manage.append(button('编辑表单', () => configure(item)), button('删除工作流', () => deleteApp(item), 'app-danger'));
      heading.append(manage);
    }
    if (!item.workflow_error) heading.append(button('打开高级编辑', () => openEditor(item)));
    const layout = el('div', '', 'app-layout'), right = el('div', '', 'app-panel app-result-panel');
    let left = el('div', '', 'app-panel app-run-panel');
    const intro = el('div', '', 'app-run-intro');
    intro.append(el('p', item.description));
    intro.append(el('p', item.profile ? (/8GB|省显存/.test(item.profile) ? '省显存配置' : '原工作流配置') : '本地运行', 'app-profile'));
    if (!ready) left.append(readinessPanel(item));
    const preparation = el('details', '', 'app-preparation-details');
    preparation.append(el('summary', ready ? '模型与运行环境' : '查看缺失项 / 下载模型'));
    const form = left; left = preparation;
    if (item.report?.reasons?.length) {
      const list = el('ul', '', 'app-checklist');
      for (const reason of item.report.reasons) list.append(el('li', reason));
      if (item.conversion_error) list.append(el('li', item.conversion_error));
      if (item.rescan_error) list.append(el('li', '重新扫描失败：' + item.rescan_error));
      left.append(list); if (item.entry_type === 'app') left.append(button('重新扫描', async () => { await post('/' + item.id + '/rescan'); await open(item.id); }));
    }
    if (item.workflow_error) {
      const error = el('div', '', 'app-checklist');
      error.append(el('strong', '文件无法读取'), el('p', item.workflow_error));
      error.append(button('返回工作流库重新扫描', library));
      left.append(error);
    }
    if (item.entry_type === 'workflow') {
      const found = el('div', '', 'app-setup-card');
      if (!item.workflow_error) {
        found.append(el('strong', '已发现本地工作流'), el('span', '启用后会复用原文件，并生成可编辑的应用配置；不会删除或覆盖原工作流。'));
        found.append(button('启用为简单应用', async () => { const enabled = await post('/workflows/' + encodeURIComponent(item.workflow_ref) + '/enable'); await open(enabled.id); }, 'app-primary'));
        left.append(found);
      }
    }
    if (item.entry_type === 'app' && !item.api) left.append(button('生成操作表单', () => convert(item)));
    if (item.entry_type === 'app') {
      const setup = el('div', '', 'app-setup-card');
      const prep = await api('/' + item.id + '/preparation');
      setup.dataset.prepareStatus = prep.task?.status || '';
      const activePrepare = prep.task && ['queued', 'running'].includes(prep.task.status);
      const environmentDone = prep.task?.status === 'succeeded' || item.environment_status === 'ready' || item.environment_status === 'available';
      setup.append(el('strong', ready ? '模型与运行环境' : activePrepare ? '正在准备本地运行环境' : environmentDone ? '本地环境已完成，但工作流仍需要处理' : '工作流需要准备本地环境'), el('span', '替换模型后会重新检查依赖，实际兼容性以运行结果为准。'));
      if (item.prepare_error) setup.append(el('p', item.prepare_error));
      setup.append(preflightPanel(prep.preflight, item.id));
      const resources = el('details'); resources.append(el('summary', '查看文件来源'));
      const source = el('a', 'SeeThrough 节点作者仓库'); source.href = prep.source; source.target = '_blank'; source.rel = 'noopener';
      if (item.description.startsWith('SeeThrough')) resources.append(source);
      for (const model of prep.models) {
        const entry = el('p', `${model.installed ? '已准备' : '需要准备'} · ${model.downloaded_bytes ? (model.downloaded_bytes / 1024 ** 3).toFixed(2) + ' GB' : '大小待核实'}`);
        const link = el('a', '模型来源'); link.href = model.source; link.target = '_blank'; link.rel = 'noopener'; resources.append(entry, link);
      }
      resources.append(el('p', '无法确认来源或匹配不唯一的节点需要从原作者获取。需要授权的文件请从原作者页面取得后再检查。')); setup.append(resources);
      if (activePrepare) {
        const progressHint = el('p', '安装进度会显示在右侧结果区域；可以取消，已下载文件会保留。', 'app-prepare-hint'); setup.append(progressHint);
      } else if (prep.preflight?.status === 'blocked') {
        setup.append(button('重新检查硬件', async () => { await post('/' + item.id + '/rescan').catch(() => {}); await open(item.id); }));
      } else {
        const autoEntries = prep.preflight?.dependencies?.auto_installable || [];
        const autoModels = autoEntries.filter(entry => entry.kind === '模型' && entry.download_id);
        const missingModels = (prep.preflight?.dependencies?.manual || []).some(entry => entry.kind === '模型');
        const autoBridge = autoEntries.some(entry => entry.kind === '兼容桥接');
        const startPreparation = async () => {
          await post('/' + item.id + '/prepare');
          notice(autoModels.length || missingModels
            ? '正在寻找缺失模型与 LoRA；找到匹配文件后自动下载，进度在右侧显示。'
            : '本地环境准备已开始；右侧会显示真实阶段进度。');
          await open(item.id);
        };
        if (autoModels.length || missingModels) {
          setup.append(button('自动寻找并下载缺失模型', startPreparation, 'app-primary app-search-models'));
        } else if (autoBridge) {
          setup.append(button('更新本地兼容桥并重启', startPreparation, 'app-primary'));
        } else if (!environmentDone && autoEntries.length) {
          setup.append(button('安装可自动安装依赖', startPreparation, 'app-primary'));
        }
        if ((prep.preflight?.dependencies?.manual || []).length) setup.append(el('p', '仍有项目需要手动补齐，请按清单处理后点击“重新扫描”。', 'app-prepare-hint'));
        setup.append(button('重新扫描工作流', async () => { await post('/' + item.id + '/rescan'); await open(item.id); }));
      }
      left.append(setup);
    }
    left = form;
    if (turn !== opening) return;
    const workflowGroups = catalogEntries.find(entry => entry.id === item.group_parent)?.workflow_groups || item.workflow_groups;
    if (item.entry_type === 'app' && workflowGroups?.length > 1) {
      const groups = el('div', '', 'app-workflow-groups');
      groups.append(el('strong', '工作流分组'), el('p', '选择要运行的分组，所需的上游节点会一同启用。'));
      for (const group of workflowGroups) {
        const choice = button(group.title, async () => {
          choice.disabled = true;
          try {
            const selected = await post('/' + item.id + '/groups/' + encodeURIComponent(group.id) + '/enable');
            if (!selected.api && selected.backend && !selected.report?.missing_nodes?.length) {
              try { await convert(selected); }
              catch (error) { await open(selected.id); throw error; }
            } else await open(selected.id);
          } finally { choice.disabled = false; }
        }, item.selected_group === group.id ? 'app-group-choice active' : 'app-group-choice');
        choice.setAttribute('aria-pressed', String(item.selected_group === group.id));
        groups.append(choice);
      }
      left.append(groups);
    }
    if (item.entry_type === 'app') for (const field of item.fields.filter(field => !field.advanced).sort((a, b) => Number(b.type === 'image') - Number(a.type === 'image'))) fieldControl(field, left, item.id, ready);
    const more = el('details', '', 'app-settings'); more.append(el('summary', '生成参数'));
    if (item.original_api) {
      more.append(button('使用省显存配置', async () => { await post('/' + item.id + '/profile', { profile: 'low-vram' }); await open(item.id); }), button('恢复原工作流配置', async () => { await post('/' + item.id + '/profile', { profile: 'original' }); await open(item.id); }));
    }
    if (item.entry_type === 'app') for (const field of item.fields.filter(field => field.advanced)) fieldControl(field, more, item.id, ready);
    if (more.children.length > 1) left.append(more);
    const run = button('生成', async () => {
      if (submitting) return;
      submitting = true; run.disabled = true; requestId ||= crypto.randomUUID();
      try {
        await post('/' + item.id + '/run', { request_id: requestId, fields: values });
        notice('任务已提交到本机。可以离开页面，回来查看结果。');
        clearTimeout(polling); polling = null;
        poll(item.id, history);
      }
      finally { submitting = false; }
    }, 'app-primary');
    run.id = 'app-run'; run.disabled = item.entry_type !== 'app' || !workflowCanRun(item); left.append(run);
    if (preparation.children.length > 1) left.append(preparation);
    const resultHeader = el('div', '', 'app-result-header'); resultHeader.append(el('h2', '结果'), el('span', '最新结果显示在这里'));
    const history = el('div'); history.dataset.wasReady = String(ready);
    history.preparationTarget = el('div', '', 'app-preparation-slot');
    right.append(resultHeader, history.preparationTarget, history); results(item.tasks || [], history);
    layout.append(left, right); $('app-detail').replaceChildren(heading, layout);
    window.comfyWorkspace.selectWorkflow(item);
    if (item.entry_type === 'app') {
      const hasLiveTask = (item.tasks || []).some(task => ['queued', 'running'].includes(task.status));
      const preparing = Boolean(item.prepare_task) || item.environment_status === 'running' || item.state === 'preparing';
      if (hasLiveTask || preparing) {
        poll(item.id, history);
      } else if (!item.api && item.managed && !(item.report?.missing_nodes || []).length
                 && Array.isArray(item.source?.nodes)) {
        // A completed preparation can be restored after the desktop process
        // restarts.  In that case there is no live task to drive poll(), but
        // the UI workflow still needs one native conversion pass.
        const conversionKey = 'open:' + item.id + ':' + (item.updated_at || '');
        if (!autoConverted.has(conversionKey)) {
          autoConverted.add(conversionKey);
          try { await convert(item); return; } catch (error) { notice(error); }
        }
      }
    }
  }
  $('import-app').onclick = () => $('app-file').click();
  $('app-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    $('import-app').disabled = true; notice('正在保存并检查工作流…');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('工作流超过 20MB，请移除内嵌图片后重试');
      const item = await post('/import', { name: file.name.replace(/\.json$/i, ''), workflow: JSON.parse(await file.text()) });
      window.comfyWorkspace.showMode('library'); await library(false); await open(item.id);
      notice('工作流已导入。');
      {
        const downloadModels = $('auto-download-models').checked;
        const prep = await api('/' + item.id + '/preparation');
        const dependencies = prep.preflight?.dependencies?.auto_installable || [];
        const missingModels = (prep.preflight?.dependencies?.manual || []).some(entry => entry.kind === '模型');
        const needsNodes = dependencies.some(entry => entry.kind !== '模型');
        if (prep.preflight?.status !== 'blocked' && (needsNodes || (downloadModels && (dependencies.length || missingModels)))) {
          await post('/' + item.id + (downloadModels ? '/prepare' : '/install-nodes'));
          notice(downloadModels ? '正在自动安装缺失节点、寻找并下载缺失模型与 LoRA，可在进度区域取消。' : '正在自动安装缺失节点并准备转换表单，可在进度区域取消。');
          if (active === item.id) await open(item.id);
          return;
        }
      }
      if (!item.api && Array.isArray(item.source?.nodes) && item.backend && !(item.report?.missing_nodes || []).length) await convert(item);
    } catch (error) { notice(error); } finally { $('import-app').disabled = false; event.target.value = ''; }
  };
  $('models-tab').onclick = () => { window.comfyWorkspace.showMode('models'); loadModelCatalog(); };
  $('model-refresh').onclick = () => loadModelCatalog();
  $('library-tab').addEventListener('click', () => library().catch(notice));
  try {
    const workflowChannel = new BroadcastChannel('studio-api');
    workflowChannel.addEventListener('message', event => {
      if (event.data?.type !== 'workflows-changed') return;
      if (!$('library').hidden || !$('app-detail').hidden) library().catch(notice);
    });
  } catch (_) { /* BroadcastChannel is optional in older embedded WebViews. */ }
  $('auto-download-models').checked = localStorage.getItem('comfy-auto-download') !== 'false';
  $('auto-download-models').onchange = event => localStorage.setItem('comfy-auto-download', String(event.target.checked));
  library().catch(notice);
})();
