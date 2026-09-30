(function (global) {
  'use strict';

  const SELECTION_KEY = 'xiaomei_agent_skill_selection_v1';
  const state = {
    tab: 'library', query: '', category: 'all', status: 'all', skills: [], selectedId: '',
    detailId: '', detail: null, detailTab: 'examples', detailLoading: false, loading: false, error: '',
    uploadFiles: [], sourceDir: '', scan: null, busy: false, message: '', focusSkillId: '',
  };
  let mount = null;
  let config = {};
  let session = 0;

  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
  const clean = (value) => String(value ?? '').trim();
  const skillId = (skill) => clean(skill?.id || skill?.slug);
  const skillName = (skill) => clean(skill?.display_name || skill?.name || skillId(skill) || '未命名 Skill');
  const skillDescription = (skill) => clean(skill?.description || '暂无简介');
  const notify = (message) => { if (typeof config.notify === 'function') config.notify(String(message || '')); };
  const readSelection = () => {
    try {
      if (global.StudioSharedSkill?.getSelected) return clean(global.StudioSharedSkill.getSelected());
      return clean(localStorage.getItem(SELECTION_KEY));
    } catch { return ''; }
  };
  const setSelection = (id) => {
    let next = clean(id);
    try {
      if (global.StudioSharedSkill?.setSelected) next = clean(global.StudioSharedSkill.setSelected(next));
      else {
        localStorage.setItem(SELECTION_KEY, next);
        global.dispatchEvent(new CustomEvent('studio-shared-skill-change', { detail: { id: next } }));
      }
    } catch {}
    state.selectedId = next;
    return next;
  };
  const currentSkill = () => state.skills.find((skill) => skillId(skill) === state.selectedId) || null;
  const statusLabel = (skill) => clean(skill?.status_label || (skill?.enabled === false ? '已停用' : '对话可用'));
  const statusKey = (skill) => clean(skill?.enabled === false ? 'disabled' : skill?.status || 'ready') || 'ready';
  const categoryLabel = (skill) => clean(skill?.category_label || skill?.category || '其他');
  const versionLabel = (skill) => clean(skill?.version) ? `v${clean(skill.version)}` : '本地 Skill';
  const isPackageSkill = (skill) => clean(skill?.kind) === 'package' || clean(skill?.source) === 'package';

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(clean(data?.detail || data?.message) || `请求失败（${response.status}）`);
    return data;
  }

  function setHeader() {
    const eyebrow = document.getElementById('desktopDrawerEyebrow');
    const title = document.getElementById('desktopDrawerTitle');
    const description = document.getElementById('desktopDrawerDescription');
    if (eyebrow) eyebrow.textContent = 'AVAILABLE SKILLS';
    if (title) title.textContent = '技能市场';
    if (description) description.textContent = '从已安装的真实 Skill 列表中选择一个，后续“问问小美”将带上它的受控指令。';
  }

  function categories() {
    const result = new Map();
    state.skills.forEach((skill) => {
      const value = clean(skill?.category || 'other') || 'other';
      if (!result.has(value)) result.set(value, categoryLabel(skill));
    });
    return [...result.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  }

  function filteredSkills() {
    const query = state.query.toLocaleLowerCase();
    return state.skills.filter((skill) => {
      const haystack = [skillName(skill), skillDescription(skill), skill?.slug, skill?.category, categoryLabel(skill), statusLabel(skill)]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || haystack.includes(query))
        && (state.category === 'all' || clean(skill?.category || 'other') === state.category)
        && (state.status === 'all' || statusKey(skill) === state.status);
    }).sort((a, b) => {
      const activeA = skillId(a) === state.selectedId ? 0 : 1;
      const activeB = skillId(b) === state.selectedId ? 0 : 1;
      return activeA - activeB || skillName(a).localeCompare(skillName(b), 'zh-CN');
    });
  }

  function statusMarkup(skill) {
    const key = statusKey(skill);
    return `<span class="skill-market-status skill-market-status-${esc(key)}"><i></i>${esc(statusLabel(skill))}</span>`;
  }

  function skillCard(skill) {
    const id = skillId(skill); const selected = id && id === state.selectedId; const enabled = skill?.enabled !== false;
    const toggle = isPackageSkill(skill) ? `<button type="button" class="skill-market-card-action skill-market-card-toggle" data-skill-market-toggle="${esc(id)}">${enabled ? '停用' : '启用'}</button>` : '';
    return `<article class="skill-market-card${selected ? ' is-selected' : ''}${enabled ? '' : ' is-disabled'}" data-skill-market-card="${esc(id)}">
      <button type="button" class="skill-market-card-main" data-skill-market-select="${esc(id)}" ${enabled ? '' : 'aria-disabled="true"'}>
        <span class="skill-market-card-icon"><span>✦</span></span>
        <span class="skill-market-card-copy"><strong>${esc(skillName(skill))}</strong><span class="skill-market-card-meta">${statusMarkup(skill)}<em>${esc(versionLabel(skill))}</em></span><small>${esc(skillDescription(skill))}</small></span>
      </button>
      <div class="skill-market-card-actions"><button type="button" class="skill-market-card-action" data-skill-market-detail="${esc(id)}">详情</button>${toggle}<button type="button" class="skill-market-card-action${selected ? ' is-current' : ''}" data-skill-market-select="${esc(id)}" ${enabled ? '' : 'disabled'}>${selected ? '已选择' : enabled ? '选择' : '先启用'}</button></div>
    </article>`;
  }

  function libraryMarkup() {
    const visible = filteredSkills(); const selected = currentSkill();
    const categoryOptions = categories().map(([value, label]) => `<option value="${esc(value)}" ${state.category === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
    const empty = state.loading
      ? '<div class="skill-market-empty"><span class="skill-market-spinner"></span><strong>正在读取已安装 Skill…</strong><small>列表来自小美画布本地 Skill 库。</small></div>'
      : state.error
        ? `<div class="skill-market-empty is-error"><strong>技能列表暂时无法刷新</strong><small>${esc(state.error)}</small><button type="button" class="skill-market-button primary" data-skill-market-reload>重新读取</button></div>`
        : !state.skills.length
          ? '<div class="skill-market-empty"><strong>当前还没有已安装的 Skill</strong><small>可以从“安装 Skill”导入文件夹，或新建一个 Markdown Skill。</small><button type="button" class="skill-market-button primary" data-skill-market-tab="install">安装 Skill</button></div>'
          : !visible.length
            ? '<div class="skill-market-empty"><strong>没有匹配的 Skill</strong><small>换个关键词，或清除筛选条件试试。</small></div>'
            : `<div class="skill-market-list">${visible.map(skillCard).join('')}</div>`;
    return `<div class="skill-market-root skill-market-library">
      <div class="skill-market-current${selected ? ' has-selection' : ''}"><span class="skill-market-current-icon">✦</span><span class="skill-market-current-copy"><small>当前使用的 Skill</small><strong>${esc(selected ? skillName(selected) : '通用助手')}</strong></span>${selected ? '<button type="button" class="skill-market-clear" data-skill-market-clear>清除</button>' : '<span class="skill-market-current-default">默认</span>'}</div>
      <div class="skill-market-toolbar"><label class="skill-market-search"><span aria-hidden="true">⌕</span><input data-skill-market-search type="search" value="${esc(state.query)}" placeholder="搜索技能名称或说明" autocomplete="off"></label><span class="skill-market-result-count">${state.query || state.category !== 'all' || state.status !== 'all' ? `${visible.length} / ` : ''}${state.skills.length} 个</span><button type="button" class="skill-market-button subtle" data-skill-market-tab="install">安装 Skill</button></div>
      <div class="skill-market-filter-row"><label><span>分类</span><select data-skill-market-category><option value="all">全部分类</option>${categoryOptions}</select></label><label><span>状态</span><select data-skill-market-status><option value="all">全部状态</option><option value="ready" ${state.status === 'ready' ? 'selected' : ''}>对话可用</option><option value="prompt-only" ${state.status === 'prompt-only' ? 'selected' : ''}>脚本待适配</option><option value="warning" ${state.status === 'warning' ? 'selected' : ''}>有导入警告</option><option value="disabled" ${state.status === 'disabled' ? 'selected' : ''}>已停用</option></select></label><button type="button" class="skill-market-filter-reset" data-skill-market-reset ${state.query || state.category !== 'all' || state.status !== 'all' ? '' : 'hidden'}>清除筛选</button></div>
      <div class="skill-market-list-head"><strong>已安装 Skill</strong><span>点击“选择”供问问小美使用，详情可查看指令与资料</span></div>${empty}${state.message ? `<p class="skill-market-message">${esc(state.message)}</p>` : ''}
    </div>`;
  }

  function detailMarkup() {
    const skill = state.skills.find((item) => skillId(item) === state.detailId);
    if (!skill) return '<div class="skill-market-empty"><strong>Skill 不存在</strong><button type="button" class="skill-market-button subtle" data-skill-market-back>返回列表</button></div>';
    const detail = state.detail || {}; const resources = detail.resources || {}; let content = '';
    if (state.detailLoading) content = '<div class="skill-market-detail-loading"><span class="skill-market-spinner"></span>正在读取 Skill 详情…</div>';
    else if (state.detailTab === 'tutorial') content = resources.tutorial ? `<pre>${esc(resources.tutorial)}</pre>` : '<div class="skill-market-detail-empty">这个 Skill 没有附带使用教程。</div>';
    else if (state.detailTab === 'example') content = resources.example ? `<pre>${esc(resources.example)}</pre>` : '<div class="skill-market-detail-empty">这个 Skill 没有附带对话示例。</div>';
    else content = detail.instructions ? `<pre>${esc(String(detail.instructions).slice(0, 14000))}${String(detail.instructions).length > 14000 ? '\n\n…内容较长，已在界面中截断。' : ''}</pre>` : '<div class="skill-market-detail-empty">没有可显示的指令正文。</div>';
    const refs = Array.isArray(resources.reference_files) ? resources.reference_files : []; const scripts = Array.isArray(resources.script_files) ? resources.script_files : []; const enabled = skill.enabled !== false;
    return `<div class="skill-market-root skill-market-detail-view"><button type="button" class="skill-market-back" data-skill-market-back>‹ 返回 Skill 列表</button><div class="skill-market-detail-head"><span class="skill-market-detail-icon">✦</span><div><span class="skill-market-kicker">SKILL DETAIL</span><h3>${esc(skillName(skill))}</h3><p>${esc(skillDescription(skill))}</p><div class="skill-market-detail-meta">${statusMarkup(skill)}<em>${esc(versionLabel(skill))}</em><em>${esc(categoryLabel(skill))}</em></div></div><button type="button" class="skill-market-button primary" data-skill-market-select="${esc(skillId(skill))}" ${enabled ? '' : 'disabled'}>${state.selectedId === skillId(skill) ? '已选择' : enabled ? '选择这个 Skill' : '请先启用'}</button></div><div class="skill-market-detail-facts"><div><small>能力</small><strong>${esc((skill.capabilities || ['对话指令']).join(' · '))}</strong></div><div><small>参考资料</small><strong>${refs.length} 个文件</strong></div><div><small>脚本</small><strong>${scripts.length ? `${scripts.length} 个（不自动执行）` : '无'}</strong></div></div><nav class="skill-market-detail-tabs" role="tablist"><button type="button" class="${state.detailTab === 'examples' ? 'is-active' : ''}" data-skill-detail-tab="examples">指令预览</button><button type="button" class="${state.detailTab === 'example' ? 'is-active' : ''}" data-skill-detail-tab="example">对话示例</button><button type="button" class="${state.detailTab === 'tutorial' ? 'is-active' : ''}" data-skill-detail-tab="tutorial">使用教程</button></nav><section class="skill-market-detail-content">${content}</section><div class="skill-market-detail-files"><strong>资源状态</strong><span>${refs.length ? `参考资料：${refs.slice(0, 4).map(esc).join('、')}` : '无已登记参考资料'}</span><span>${scripts.length ? '包含脚本，但宿主不会自动运行脚本、CLI 或安装依赖。' : '未发现脚本依赖。'}</span></div></div>`;
  }

  function installMarkup() {
    const files = state.uploadFiles.length ? `已选择文件夹，共 ${state.uploadFiles.length} 个文件` : '选择一个包含 SKILL.md 的文件夹';
    const preview = state.scan ? (() => { const entries = Array.isArray(state.scan.skills) ? state.scan.skills : []; const valid = entries.filter((item) => item.valid !== false); const warnings = (state.scan.warnings || []).length + entries.reduce((sum, item) => sum + (item.warnings || []).length, 0); return `<div class="skill-market-scan-result ${valid.length ? 'is-valid' : 'is-invalid'}"><strong>${valid.length ? `检查到 ${valid.length} 个可导入 Skill` : '没有找到可导入的 Skill'}</strong><span>${valid.map((item) => esc(item.name || item.display_name || item.id || '未命名')).join('、') || '请选择包含 SKILL.md 的文件夹。'}</span>${warnings ? `<small>有 ${warnings} 项导入提示，仍可继续导入。</small>` : ''}</div>`; })() : '';
    return `<div class="skill-market-root skill-market-install"><div class="skill-market-install-top"><button type="button" class="skill-market-back" data-skill-market-tab="library">‹ 返回 Skill 库</button><span>只复制到小美画布本地 Skill 库，不修改源目录，也不会自动执行包内脚本。</span></div><section class="skill-market-install-card"><div class="skill-market-install-title"><span class="skill-market-install-icon">⇧</span><div><strong>从本地目录导入</strong><small>支持浏览器选择文件夹；也可在桌面版粘贴本地目录路径。</small></div></div><label class="skill-market-source-label"><span>Skill 文件夹</span><div class="skill-market-source-row"><input data-skill-market-source type="text" value="${esc(state.sourceDir)}" placeholder="粘贴目录路径，或点击右侧选择文件夹"><button type="button" class="skill-market-button subtle" data-skill-market-browse>选择文件夹</button></div></label><input class="skill-market-directory-input" data-skill-market-directory type="file" webkitdirectory directory multiple><p class="skill-market-file-hint">${esc(files)}</p>${preview}<div class="skill-market-install-actions"><button type="button" class="skill-market-button subtle" data-skill-market-inspect>检查文件夹</button><button type="button" class="skill-market-button primary" data-skill-market-import ${state.scan?.valid_count ? '' : 'disabled'}>${state.busy ? '处理中…' : '导入 Skill'}</button></div>${state.message ? `<p class="skill-market-message">${esc(state.message)}</p>` : ''}</section><form class="skill-market-create-card" data-skill-market-create><div class="skill-market-install-title"><span class="skill-market-install-icon is-secondary">＋</span><div><strong>新建 Markdown Skill</strong><small>把稳定的提示词规则保存为可复用能力。</small></div></div><div class="skill-market-create-grid"><label><span>名称</span><input name="name" maxlength="120" placeholder="例如：电商主图策划" required></label><label><span>一句话说明</span><input name="description" maxlength="2000" placeholder="这个 Skill 适合解决什么问题？"></label></div><label class="skill-market-create-instructions"><span>Skill 指令</span><textarea name="instructions" rows="5" maxlength="50000" placeholder="写下 Agent 必须遵循的规则、输出格式和边界…" required></textarea></label><div class="skill-market-install-actions"><span></span><button type="submit" class="skill-market-button primary" ${state.busy ? 'disabled' : ''}>保存并启用</button></div></form><div class="skill-market-safety">▣ 仅注入 SKILL.md 与正文明确引用的文本资料；不会执行脚本、CLI、第三方依赖或外部授权。</div></div>`;
  }

  function render() {
    if (!mount?.body) return;
    setHeader();
    mount.body.innerHTML = state.detailId ? detailMarkup() : state.tab === 'install' ? installMarkup() : libraryMarkup();
    bind();
    if (state.focusSkillId) {
      const target = mount.body.querySelector(`[data-skill-market-card="${CSS.escape(state.focusSkillId)}"]`);
      if (target) target.scrollIntoView({ block: 'nearest' });
      state.focusSkillId = '';
    }
  }

  async function loadSkills(force = false, token = session) {
    if (token !== session) return false;
    state.loading = true; state.error = ''; render();
    try {
      const data = await requestJson('/api/agent-skills', { cache: 'no-store' });
      if (token !== session) return false;
      state.skills = Array.isArray(data?.skills) ? data.skills : [];
      const persisted = global.StudioSharedSkill?.canonicalId?.(state.selectedId || readSelection()) ?? clean(state.selectedId || readSelection());
      state.selectedId = state.skills.some((skill) => skillId(skill) === persisted && skill.enabled !== false) ? persisted : '';
      if (persisted && !state.selectedId) setSelection('');
      return true;
    } catch (error) { if (token === session) state.error = error.message || '无法读取 Skill 列表'; return false; }
    finally { if (token === session) { state.loading = false; render(); } }
  }

  async function selectSkill(id) {
    const item = state.skills.find((skill) => skillId(skill) === clean(id)); if (!item) return;
    if (item.enabled === false) {
      await toggleSkill(id, true, true);
      const refreshed = state.skills.find((skill) => skillId(skill) === clean(id));
      if (!refreshed || refreshed.enabled === false) return;
    }
    const next = setSelection(id); const selected = state.skills.find((skill) => skillId(skill) === next) || item;
    // 选择 Skill 只更新共享状态；外层面板的开关由用户明确点击关闭，不能由选择动作接管。
    if (typeof config.onSelected === 'function') config.onSelected(next, selected, { close: false });
    notify(`已选择 Skill：${skillName(selected)}`); render();
  }

  async function toggleSkill(id, enabled, silent = false) {
    const item = state.skills.find((skill) => skillId(skill) === clean(id));
    if (!item || !isPackageSkill(item)) { if (!silent) notify('这个 Skill 由单文件兼容模式提供，不能在这里切换状态。'); return false; }
    try {
      const data = await requestJson(`/api/agent-skills/${encodeURIComponent(skillId(item))}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: Boolean(enabled) }) });
      const next = data?.skill || data; state.skills = state.skills.map((skill) => skillId(skill) === skillId(item) ? { ...skill, ...next } : skill);
      if (!enabled && state.selectedId === skillId(item)) { setSelection(''); if (typeof config.onSelected === 'function') config.onSelected('', null, { close: false }); }
      if (!silent) notify(enabled ? 'Skill 已启用' : 'Skill 已停用'); render(); return true;
    } catch (error) { if (!silent) notify(`更新 Skill 失败：${error.message || error}`); return false; }
  }

  async function openDetail(id) {
    const item = state.skills.find((skill) => skillId(skill) === clean(id)); if (!item) return;
    state.detailId = skillId(item); state.detail = null; state.detailTab = 'examples'; state.detailLoading = true; render();
    try { state.detail = await requestJson(`/api/agent-skills/${encodeURIComponent(state.detailId)}`, { cache: 'no-store' }); }
    catch (error) { notify(`读取 Skill 详情失败：${error.message || error}`); }
    finally { state.detailLoading = false; render(); }
  }

  async function inspectUpload(files) {
    if (!files?.length) return;
    state.busy = true; state.message = '正在检查这个文件夹…'; render();
    try {
      const form = new FormData(); const paths = files.map((file) => file.webkitRelativePath || file.name || '');
      files.forEach((file, index) => form.append('files', file, paths[index])); form.append('relative_paths', JSON.stringify(paths));
      state.scan = await requestJson('/api/agent-skills/inspect-upload', { method: 'POST', body: form }); state.sourceDir = clean(state.scan?.source_dir); state.message = state.scan?.valid_count ? `检查完成：发现 ${state.scan.valid_count} 个可导入 Skill。` : '没有找到包含 SKILL.md 的可导入 Skill。';
    } catch (error) { state.scan = null; state.sourceDir = ''; state.message = `检查失败：${error.message || error}`; }
    finally { state.busy = false; render(); }
  }

  async function inspectSource() {
    const input = mount?.body?.querySelector('[data-skill-market-source]'); const source = clean(input?.value || state.sourceDir);
    if (!source && !state.uploadFiles.length) { state.message = '请选择 Skill 文件夹，或粘贴本地目录路径。'; render(); return; }
    if (state.uploadFiles.length) return inspectUpload(state.uploadFiles);
    state.busy = true; state.message = '正在检查这个文件夹…'; render();
    try { state.scan = await requestJson('/api/agent-skills/inspect-package', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_dir: source }) }); state.sourceDir = clean(state.scan?.source_dir || source); state.message = state.scan?.valid_count ? `检查完成：发现 ${state.scan.valid_count} 个可导入 Skill。` : '没有找到可导入的 Skill。'; }
    catch (error) { state.scan = null; state.message = `检查失败：${error.message || error}`; }
    finally { state.busy = false; render(); }
  }

  async function importPackage(replace = false) {
    if (!state.scan?.valid_count || !state.sourceDir || state.busy) return;
    state.busy = true; state.message = replace ? '正在覆盖已有 Skill…' : '正在导入 Skill…'; render();
    try {
      const data = await requestJson('/api/agent-skills/import-package', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_dir: state.sourceDir, replace }) });
      const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
      if (conflicts.length && !replace) { state.busy = false; state.message = `有 ${conflicts.length} 个 Skill 已存在。`; render(); if (global.confirm(`以下 Skill 已存在：${conflicts.map((item) => item.id || '未命名').join('、')}\n是否覆盖？`)) return importPackage(true); return; }
      const imported = Array.isArray(data?.imported) ? data.imported : []; const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
      state.uploadFiles = []; state.scan = null; state.sourceDir = ''; await loadSkills(true); state.tab = 'library'; state.message = imported.length ? `已导入 ${imported.length} 个 Skill；当前选择保持不变。` : skipped.length ? '这些 Skill 已存在，未重复导入。' : '没有新增 Skill。'; state.focusSkillId = imported[0]?.id || ''; render(); notify(state.message);
    } catch (error) { state.message = `导入失败：${error.message || error}`; state.busy = false; render(); }
  }

  async function createSkill(form) {
    const values = new FormData(form); const name = clean(values.get('name')); const description = clean(values.get('description')); const instructions = clean(values.get('instructions'));
    if (!name || !instructions || state.busy) return;
    state.busy = true; state.message = '正在保存 Skill…'; render();
    try { const data = await requestJson('/api/agent-skills/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, instructions }) }); const createdId = skillId(data?.skill); await loadSkills(true); state.tab = 'library'; state.message = `已创建“${name}”，当前对话仍使用原来的 Skill。`; state.focusSkillId = createdId; render(); notify(`Skill 已创建：${name}`); }
    catch (error) { state.busy = false; state.message = `保存失败：${error.message || error}`; render(); }
  }

  function bind() {
    if (!mount?.body) return;
    mount.body.querySelectorAll('[data-skill-market-tab]').forEach((button) => { button.onclick = () => { state.tab = button.dataset.skillMarketTab || 'library'; state.detailId = ''; state.message = ''; render(); }; });
    mount.body.querySelector('[data-skill-market-search]')?.addEventListener('input', (event) => { state.query = event.target.value || ''; render(); const input = mount.body.querySelector('[data-skill-market-search]'); input?.focus(); input?.setSelectionRange(state.query.length, state.query.length); });
    mount.body.querySelector('[data-skill-market-category]')?.addEventListener('change', (event) => { state.category = event.target.value || 'all'; render(); });
    mount.body.querySelector('[data-skill-market-status]')?.addEventListener('change', (event) => { state.status = event.target.value || 'all'; render(); });
    mount.body.querySelector('[data-skill-market-reset]')?.addEventListener('click', () => { state.query = ''; state.category = 'all'; state.status = 'all'; render(); });
    mount.body.querySelector('[data-skill-market-reload]')?.addEventListener('click', () => loadSkills(true));
    mount.body.querySelector('[data-skill-market-clear]')?.addEventListener('click', () => { setSelection(''); if (typeof config.onSelected === 'function') config.onSelected('', null, { close: false }); notify('已切换为通用助手'); render(); });
    mount.body.querySelectorAll('[data-skill-market-back]').forEach((button) => { button.onclick = () => { state.detailId = ''; state.detail = null; state.message = ''; render(); }; });
    mount.body.querySelectorAll('[data-skill-market-select]').forEach((button) => { button.onclick = () => selectSkill(button.dataset.skillMarketSelect); });
    mount.body.querySelectorAll('[data-skill-market-detail]').forEach((button) => { button.onclick = () => openDetail(button.dataset.skillMarketDetail); });
    mount.body.querySelectorAll('[data-skill-market-toggle]').forEach((button) => { button.onclick = () => { const item = state.skills.find((skill) => skillId(skill) === button.dataset.skillMarketToggle); if (item) toggleSkill(skillId(item), item.enabled === false); }; });
    mount.body.querySelectorAll('[data-skill-detail-tab]').forEach((button) => { button.onclick = () => { state.detailTab = button.dataset.skillDetailTab || 'examples'; render(); }; });
    mount.body.querySelector('[data-skill-market-browse]')?.addEventListener('click', () => mount.body.querySelector('[data-skill-market-directory]')?.click());
    mount.body.querySelector('[data-skill-market-directory]')?.addEventListener('change', (event) => { state.uploadFiles = [...(event.target.files || [])]; state.sourceDir = ''; state.scan = null; void inspectUpload(state.uploadFiles); });
    mount.body.querySelector('[data-skill-market-source]')?.addEventListener('input', (event) => { state.sourceDir = event.target.value || ''; });
    mount.body.querySelector('[data-skill-market-inspect]')?.addEventListener('click', () => inspectSource());
    mount.body.querySelector('[data-skill-market-import]')?.addEventListener('click', () => importPackage(false));
    mount.body.querySelector('[data-skill-market-create]')?.addEventListener('submit', (event) => { event.preventDefault(); void createSkill(event.currentTarget); });
  }

  async function open(options = {}) {
    mount = { body: options.body || document.getElementById('desktopDrawerBody') }; config = { ...options }; session += 1;
    state.tab = options.tab || 'library'; state.detailId = ''; state.detail = null; state.query = ''; state.category = 'all'; state.status = 'all'; state.message = ''; state.selectedId = clean(global.StudioSharedSkill?.canonicalId?.(options.selectedId ?? readSelection()) ?? (options.selectedId ?? readSelection())); setHeader(); render(); await loadSkills(true, session); return state.skills;
  }
  function close() { session += 1; mount = null; config = {}; }
  function syncSelected(id) { state.selectedId = clean(global.StudioSharedSkill?.canonicalId?.(id) || id); if (mount) render(); }

  global.XiaomeiSkillMarket = { open, close, render, syncSelected, getSelected: () => state.selectedId, selectionKey: SELECTION_KEY };
})(window);
