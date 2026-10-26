/* 设计大脑 · 阶段 1+2：审美档案 + 灵感案例（引用模式）+ 项目经验状态机 + Skill 生命周期。
 * 数据全部走本地服务；AI 提炼只在档案隐私开关开启并经用户确认后，
 * 把本地组装的文本发给用户自选的对话模型（/api/canvas-llm）。 */
(() => {
    'use strict';

    const WEIGHT_OPTIONS = [[0.3, '低'], [0.6, '中'], [0.9, '高']];
    const AESTHETIC_GROUPS = [
        {key: 'style_tags', label: '风格偏好', hint: '喜欢的设计风格，例如：极简、国风、轻奢、赛博。'},
        {key: 'color_preferences', label: '色彩偏好', hint: '常用的色彩倾向，例如：低饱和、暖调、莫兰迪。'},
        {key: 'composition', label: '构图偏好', hint: '偏好的画面结构，例如：居中对称、留白、特写。'},
        {key: 'lighting', label: '光线偏好', hint: '偏好的光线处理，例如：柔光、自然光、逆光。'},
        {key: 'mood', label: '氛围偏好', hint: '希望画面传达的感受，例如：干净、高级、烟火气。'},
    ];
    const PATCH_GROUPS = [...AESTHETIC_GROUPS.map(group => ({key: group.key, label: group.label})), {key: 'avoid_tags', label: '避免风格'}];
    const ANALYSIS_FIELDS = [
        {key: 'style', label: '风格'},
        {key: 'color', label: '色彩'},
        {key: 'composition', label: '构图'},
        {key: 'lighting', label: '光线'},
        {key: 'mood', label: '氛围'},
    ];
    const EXP_STATUS_LABELS = {candidate: '候选', pending_review: '待审核', published: '已发布', rejected: '已拒绝'};
    const RUN_STATUS_LABELS = {awaiting_confirmation: '待确认', executing: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消'};
    const RUN_STATUS_CLASS = {awaiting_confirmation: 'status-pending_review', executing: 'status-candidate', completed: 'status-published', failed: 'status-rejected', cancelled: 'status-rejected'};
    const ISSUE_LABELS = {composition: '构图', color: '色彩', text: '文字', subject: '主体', texture: '质感', background: '背景', other: '其他'};
    const COMPARE_FIELD_LABELS = {skill_id: 'Skill', model: '模型', provider_id: '平台', reference_digest: '参考图', size: '尺寸', quality: '质量'};
    const DISTILL_SYSTEM = [
        '你是电商视觉设计经验提炼助手。用户会提供若干条历史生成记录（提示词与参数）。',
        '请只依据给定文本总结可复用的设计经验，不要编造文本里没有的信息。',
        '只输出 JSON，不要输出任何其他文字，格式：',
        '{"title":"不超过30字的经验标题","observations":["每条不超过120字的具体经验观察"],"profile_patch":[{"group":"style_tags|color_preferences|composition|lighting|mood|avoid_tags","tag":"不超过12字标签","weight":0.3到0.9}]}',
        'observations 给 3 到 6 条；profile_patch 可以为空数组。',
    ].join('\n');

    const state = {
        profile: null,
        revision: 0,
        draft: null,
        cases: [],
        categories: [],
        filters: {q: '', tag: '', category: '', favorite: false},
        picker: {selected: new Map(), items: [], kind: 'upload', folder: '', query: '', folders: [], total: 0, offset: 0, hasMore: false, loading: false, requestId: 0, controller: null, cache: new Map(), previewUrl: '', returnFocus: null},
        references: [],
        refTotal: 0,
        refFacets: null,
        refPresets: {category: [], purpose: [], expression: []},
        refFilters: {q: '', category: '', purpose: '', expression: '', analysis: '', favorite: false},
        refSelection: new Set(),
        refImport: null,
        refAnalysis: null,
        currentRefId: '',
        experiences: [],
        experienceFilter: '',
        expDraft: null,
        expEditingId: '',
        skills: [],
        runs: [],
        providers: null,
        historyPick: {records: [], selected: new Set(), query: ''},
    };

    const $ = (id) => document.getElementById(id);

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
    }

    let toastTimer = null;
    function toast(message, isError) {
        let node = document.querySelector('.db-toast');
        if (!node) {
            node = document.createElement('div');
            node.className = 'db-toast';
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.classList.toggle('error', Boolean(isError));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { node.remove(); }, 3400);
    }

    async function api(path, options = {}) {
        const init = {method: options.method || 'GET', headers: {}};
        if (options.signal) init.signal = options.signal;
        if (options.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(options.body);
        }
        const response = await fetch(path, init);
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok) {
            const error = new Error((data && (data.detail || data.message)) || `请求失败（${response.status}）`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    /* ---------------- 审美档案 ---------------- */

    function weightLabel(weight) {
        let best = WEIGHT_OPTIONS[1];
        for (const option of WEIGHT_OPTIONS) {
            if (Math.abs(option[0] - Number(weight)) < Math.abs(best[0] - Number(weight))) best = option;
        }
        return best[1];
    }

    function renderProfile() {
        const draft = state.draft;
        const aesthetics = draft.aesthetics || {};
        const tone = draft.tone || {};
        const defaults = draft.task_defaults || {};
        const privacy = draft.privacy || {};
        const groupsHtml = AESTHETIC_GROUPS.map((group) => {
            const items = aesthetics[group.key] || [];
            return `<div class="db-group" data-group="${group.key}">
                <h3>${esc(group.label)}</h3><p class="group-hint">${esc(group.hint)}</p>
                <div class="chip-row">${items.map((item, index) => tagChipHtml(group.key, item, index)).join('')}
                    <span class="chip-add"><input class="inline-input" type="text" data-add-tag-input="${group.key}" placeholder="添加标签" aria-label="添加${esc(group.label)}"><button class="subtle-button" type="button" data-add-tag="${group.key}">添加</button></span>
                </div></div>`;
        }).join('');
        const avoidItems = aesthetics.avoid_tags || [];
        const avoidHtml = `<div class="db-group" data-group="avoid_tags">
            <h3>避免风格</h3><p class="group-hint">不希望出现在生成结果里的元素或风格。</p>
            <div class="chip-row">${avoidItems.map((item, index) => tagChipHtml('avoid_tags', item, index, true)).join('')}
                <span class="chip-add"><input class="inline-input" type="text" data-add-tag-input="avoid_tags" placeholder="添加标签" aria-label="添加避免风格"><button class="subtle-button" type="button" data-add-tag="avoid_tags">添加</button></span>
            </div></div>`;
        const toneHtml = (key, label, hint) => `<div class="db-group" data-tone="${key}">
            <h3>${esc(label)}</h3><p class="group-hint">${esc(hint)}</p>
            <div class="chip-row">${(tone[key] || []).map((word, index) => `<span class="tag-chip">${esc(word)}<button class="remove" type="button" data-remove-word="${key}" data-index="${index}" aria-label="移除">×</button></span>`).join('')}
                <span class="chip-add"><input class="inline-input" type="text" data-add-word-input="${key}" placeholder="添加词语" aria-label="添加${esc(label)}"><button class="subtle-button" type="button" data-add-word="${key}">添加</button></span>
            </div></div>`;
        $('profileForm').innerHTML = `
            ${groupsHtml}
            ${avoidHtml}
            ${toneHtml('brand_words', '品牌关键词', '希望提示词里常出现的关键词。')}
            ${toneHtml('banned_words', '禁用词', '不希望出现在文案或提示词里的词。')}
            <div class="db-group">
                <h3>任务默认</h3><p class="group-hint">新任务的起始参数，仅保存在本机，不绑定任何模型。</p>
                <div class="form-grid">
                    <div class="form-field"><label for="defaultRatio">主图比例</label>
                        <select id="defaultRatio" class="inline-input wide-input">
                            ${['1:1', '3:4', '4:3', '16:9', '9:16', 'auto'].map((value) => `<option value="${value}"${(defaults.main_image || {}).preferred_ratio === value ? ' selected' : ''}>${value === 'auto' ? '自动' : value}</option>`).join('')}
                        </select></div>
                    <div class="form-field"><label for="defaultSegments">详情页分段数</label>
                        <input id="defaultSegments" class="inline-input wide-input" type="number" min="1" max="24" value="${(defaults.detail_page || {}).segments ?? 8}"></div>
                </div></div>
            <div class="db-group">
                <h3>隐私</h3>
                <label class="privacy-box"><input id="allowCloud" type="checkbox"${privacy.allow_cloud_analysis ? ' checked' : ''}>
                    <span>允许「AI 提炼经验」把所选记录的<strong>提示词与参数文本</strong>发送给我选择的对话模型。<strong>默认关闭</strong>；关闭时档案与经验只在本地处理。生图请求不会附带档案。</span></label>
                <label class="privacy-box" style="margin-top:10px"><input id="allowReferenceAnalysis" type="checkbox"${privacy.allow_reference_analysis ? ' checked' : ''}>
                    <span>允许「AI 设计分析」把<strong>参考素材图片</strong>发送给我选择的对话模型做设计分析。<strong>默认关闭</strong>；每次批量分析前仍会单独确认，AI 的建议分类不会自动写入审美档案。</span></label>
            </div>`;
        updateProfileSummary();
    }

    function tagChipHtml(groupKey, item, index, noWeight) {
        const weight = `<select aria-label="权重" data-weight-group="${groupKey}" data-index="${index}">${WEIGHT_OPTIONS.map(([value, label]) => `<option value="${value}"${weightLabel(item.weight) === label ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
        return `<span class="tag-chip">${esc(item.tag)}${noWeight ? '' : weight}<button class="remove" type="button" data-remove-tag="${groupKey}" data-index="${index}" aria-label="移除 ${esc(item.tag)}">×</button></span>`;
    }

    function updateProfileSummary() {
        const aesthetics = (state.profile || {}).aesthetics || {};
        const count = AESTHETIC_GROUPS.reduce((total, group) => total + ((aesthetics[group.key] || []).length), 0);
        $('profileSummary').textContent = count ? `档案已有 ${count} 个偏好标签` : '档案还未建立标签';
    }

    function groupOf(draft, key) {
        if (key === 'avoid_tags') draft.aesthetics.avoid_tags = draft.aesthetics.avoid_tags || [];
        else draft.aesthetics[key] = draft.aesthetics[key] || [];
        return draft.aesthetics[key];
    }

    function addTag(key) {
        const input = document.querySelector(`[data-add-tag-input="${key}"]`);
        const text = (input.value || '').trim();
        if (!text) return;
        const items = groupOf(state.draft, key);
        if (items.some((item) => item.tag === text)) { toast('标签已存在'); return; }
        if (key === 'avoid_tags') items.push({tag: text, origin: 'user'});
        else items.push({tag: text, weight: 0.6, origin: 'user'});
        renderProfile();
        markProfileDirty();
    }

    function markProfileDirty() {
        $('profileStatus').textContent = '有未保存的修改';
    }

    async function loadProfile() {
        const data = await api('/api/design-brain/profile');
        state.profile = data.profile || {};
        state.revision = Number(data.revision || 0);
        state.draft = JSON.parse(JSON.stringify(state.profile));
        renderProfile();
    }

    async function saveProfile() {
        const button = $('saveProfileButton');
        button.disabled = true;
        try {
            const ratio = $('defaultRatio') ? $('defaultRatio').value : '1:1';
            const segments = $('defaultSegments') ? Number($('defaultSegments').value || 8) : 8;
            const allowCloud = $('allowCloud') ? $('allowCloud').checked : false;
            const allowReferenceAnalysis = $('allowReferenceAnalysis') ? $('allowReferenceAnalysis').checked : false;
            state.draft.task_defaults = {
                main_image: {preferred_ratio: ratio, quality: ((state.draft.task_defaults || {}).main_image || {}).quality || 'high'},
                detail_page: {segments},
            };
            state.draft.privacy = {allow_cloud_analysis: allowCloud, allow_reference_analysis: allowReferenceAnalysis};
            const data = await api('/api/design-brain/profile', {method: 'PUT', body: {profile: state.draft, expected_revision: state.revision}});
            state.profile = data.profile;
            state.revision = Number(data.revision || 0);
            state.draft = JSON.parse(JSON.stringify(state.profile));
            renderProfile();
            $('profileStatus').textContent = '已保存';
            $('profileStatus').classList.remove('error');
            updateProfileSummary();
        } catch (error) {
            const status = $('profileStatus');
            status.classList.add('error');
            if (error.status === 409) {
                status.textContent = '档案已在其他窗口更新，已为你重新加载最新内容，请确认后再保存。';
                if (error.data && error.data.current) {
                    state.profile = error.data.current.profile || {};
                    state.revision = Number(error.data.current.revision || 0);
                    state.draft = JSON.parse(JSON.stringify(state.profile));
                    renderProfile();
                }
            } else {
                status.textContent = error.message || '保存失败';
            }
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 灵感案例库（阶段 1） ---------------- */

    let searchTimer = null;
    async function loadCases() {
        $('caseCount').textContent = '正在读取案例…';
        const params = new URLSearchParams({media_mode: 'refs', limit: '200'});
        const query = state.filters.q.trim();
        if (query) params.set('q', query);
        if (state.filters.category) params.set('category', state.filters.category);
        try {
            const data = await api(`/api/prompt-cases?${params.toString()}`);
            state.cases = data.cases || [];
            state.categories = data.categories || [];
            renderCategoryFilter();
            renderTagChips();
            renderCases();
        } catch (error) {
            state.cases = [];
            renderCases();
            $('caseCount').textContent = error.message || '案例读取失败';
        }
    }

    function visibleCases() {
        return state.cases.filter((item) => {
            if (state.filters.favorite && !item.favorite) return false;
            if (state.filters.tag && !(item.tags || []).includes(state.filters.tag)) return false;
            return true;
        });
    }

    function renderCategoryFilter() {
        const select = $('categoryFilter');
        const current = state.filters.category;
        select.innerHTML = '<option value="">全部分类</option>' + state.categories.map((item) => `<option value="${esc(item.id)}"${current === item.id ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
    }

    function renderTagChips() {
        const counts = new Map();
        for (const item of state.cases) {
            for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
            for (const link of item.profile_links || []) counts.set(link.tag, (counts.get(link.tag) || 0) + 1);
        }
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([tag]) => tag);
        $('tagChips').innerHTML = tags.map((tag) => `<button type="button" data-filter-tag="${esc(tag)}" class="${state.filters.tag === tag ? 'active' : ''}">${esc(tag)} · ${counts.get(tag)}</button>`).join('');
    }

    function caseCoverUrl(item) {
        const cover = item.cover || {};
        return cover.url || ((item.variants || [])[0] || {}).url || '';
    }

    function renderCases() {
        const cases = visibleCases();
        $('caseCount').textContent = `${cases.length} 个参考案例`;
        if (!cases.length) {
            $('caseGrid').innerHTML = '<div class="empty"><strong>还没有参考案例</strong><span>在历史记录点「收藏到灵感库」，或用右上角「新增参考」从图片空间选图。</span></div>';
            return;
        }
        $('caseGrid').innerHTML = cases.map((item) => {
            const url = caseCoverUrl(item);
            const cover = url ? `<img src="${esc(url)}" alt="" loading="lazy">` : '<span class="cover-placeholder">无图</span>';
            const model = (item.settings || {}).model || '';
            return `<article class="case-card" data-case-id="${esc(item.id)}">
                <button class="cover-button" type="button" data-open-case="${esc(item.id)}" aria-label="查看 ${esc(item.title)}">${cover}</button>
                <button class="favorite-button${item.favorite ? ' on' : ''}" type="button" data-favorite-case="${esc(item.id)}" aria-label="收藏">${item.favorite ? '★' : '☆'}</button>
                <div class="case-info">
                    <h3 class="case-title">${esc(item.title)}</h3>
                    <p class="case-sub">${esc(model || originLabel(item))}</p>
                    <div class="case-tags">${(item.tags || []).slice(0, 5).map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>
                </div></article>`;
        }).join('');
    }

    function originLabel(item) {
        const type = ((item.origin || {}).type) || '';
        return {history_pick: '来自历史记录', image_space: '来自图片空间', canvas_save: '来自画布', inspiration_import: '来自灵感案例', user_saved: '手动收藏'}[type] || '参考案例';
    }

    function findCase(id) {
        return state.cases.find((item) => item.id === id) || null;
    }

    async function toggleFavorite(id) {
        const item = findCase(id);
        if (!item) return;
        try {
            const data = await api(`/api/prompt-cases/${encodeURIComponent(id)}`, {method: 'PATCH', body: {favorite: !item.favorite}});
            Object.assign(item, data.case || {});
            renderCases();
            if (state.currentDetailId === id) openDetail(id);
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    function openDetail(id) {
        const item = findCase(id);
        if (!item) return;
        state.currentDetailId = id;
        const media = [...(item.variants || []), ...(item.references || [])];
        const promptText = ((item.prompt || {}).display) || '';
        const settings = item.settings || {};
        const analysis = item.analysis || {};
        const links = item.profile_links || [];
        const profileTagOptions = [...new Set([
            ...AESTHETIC_GROUPS.flatMap((group) => ((state.profile || {}).aesthetics || {})[group.key] || []).map((entry) => entry.tag),
            ...links.map((link) => link.tag),
        ])];
        $('detailBody').innerHTML = `
            <h2 id="detailTitle">${esc(item.title)}</h2>
            <p class="muted">${esc(originLabel(item))}${settings.model ? ` · ${esc(settings.model)}` : ''}${(item.use_count || 0) ? ` · 已应用 ${item.use_count} 次` : ''}</p>
            <div class="detail-actions">
                <button class="primary-button" type="button" data-apply-case="${esc(item.id)}">应用到画布</button>
                <button class="subtle-button" type="button" data-save-case="${esc(item.id)}">保存修改</button>
                <button class="subtle-button" type="button" data-copy-prompt>复制提示词</button>
                <button class="subtle-button danger" type="button" data-delete-case="${esc(item.id)}">删除案例</button>
            </div>
            ${media.length ? `<div class="detail-section"><h3>图片（引用原图，未复制文件）</h3><div class="media-strip">${media.map((entry) => `<figure><img src="${esc(entry.url)}" alt="${esc(entry.name || '')}" loading="lazy"><figcaption>${esc(entry.name || '图片')}${entry.missing_snapshot ? ' · 原图已不在本机' : ''}</figcaption></figure>`).join('')}</div></div>` : ''}
            ${promptText ? `<div class="detail-section"><h3>提示词</h3><pre id="detailPrompt">${esc(promptText)}</pre></div>` : ''}
            <div class="detail-section"><h3>设计特征分析</h3>
                <div class="analysis-grid">
                    ${ANALYSIS_FIELDS.map((field) => `<div><label for="analysis_${field.key}">${esc(field.label)}</label><input id="analysis_${field.key}" class="inline-input" type="text" data-analysis="${field.key}" value="${esc(analysis[field.key] || '')}"></div>`).join('')}
                    <div class="full"><label for="analysis_notes">备注</label><textarea id="analysis_notes" class="inline-input" data-analysis="notes">${esc(analysis.notes || '')}</textarea></div>
                </div></div>
            <div class="detail-section"><h3>关联审美标签</h3>
                <div class="chip-row" id="detailLinks">
                    ${links.map((link, index) => `<span class="tag-chip">${esc(link.tag)}<select aria-label="权重" data-link-weight="${index}">${WEIGHT_OPTIONS.map(([value, label]) => `<option value="${value}"${weightLabel(link.weight) === label ? ' selected' : ''}>${label}</option>`).join('')}</select><button class="remove" type="button" data-remove-link="${index}" aria-label="移除">×</button></span>`).join('')}
                    <span class="chip-add"><input class="inline-input" type="text" id="linkTagInput" list="profileTagOptions" placeholder="标签"><datalist id="profileTagOptions">${profileTagOptions.map((tag) => `<option value="${esc(tag)}"></option>`).join('')}</datalist><button class="subtle-button" type="button" id="linkAddButton">关联</button></span>
                </div></div>
            <div class="detail-section"><h3>案例标签</h3>
                <input id="detailTagsInput" class="inline-input wide-input" type="text" value="${esc((item.tags || []).join(', '))}" placeholder="用逗号分隔，用于检索">
            </div>`;
        $('caseOverlay').hidden = false;
    }

    function collectDetailEdits() {
        const item = findCase(state.currentDetailId);
        if (!item) return null;
        const analysis = {};
        document.querySelectorAll('[data-analysis]').forEach((input) => { analysis[input.dataset.analysis] = input.value; });
        const profile_links = (item.profile_links || []).map((link, index) => ({
            tag: link.tag,
            weight: Number((document.querySelector(`[data-link-weight="${index}"]`) || {value: link.weight}).value),
        }));
        const tags = ($('detailTagsInput').value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        return {analysis, profile_links, tags};
    }

    async function saveDetail() {
        const id = state.currentDetailId;
        const item = findCase(id);
        const edits = collectDetailEdits();
        if (!item || !edits) return;
        try {
            const data = await api(`/api/prompt-cases/${encodeURIComponent(id)}`, {method: 'PATCH', body: edits});
            Object.assign(item, data.case || {});
            renderTagChips();
            renderCases();
            openDetail(id);
            toast('已保存');
        } catch (error) {
            toast(error.message || '保存失败', true);
        }
    }

    function applyCaseToCanvas(id) {
        const item = findCase(id);
        if (!item) return;
        const references = (item.variants || []).map((entry, index) => ({url: entry.url, name: entry.name || `图${index + 1}`, role: `image_${index + 1}`}));
        window.parent.postMessage({type: 'prompt-case-apply-request', case: {
            id: item.id,
            title: item.title,
            prompt: item.prompt || {},
            settings: item.settings || {},
            references,
        }}, '*');
        fetch(`/api/prompt-cases/${encodeURIComponent(id)}/use`, {method: 'POST'}).catch(() => {});
        toast('已发送到画布，请切换到小美画布查看');
    }

    async function deleteCase(id) {
        if (!window.confirm('删除这个参考案例？仅删除引用记录，不会删除图片文件。')) return;
        try {
            await api(`/api/prompt-cases/${encodeURIComponent(id)}`, {method: 'DELETE'});
            state.cases = state.cases.filter((item) => item.id !== id);
            $('caseOverlay').hidden = true;
            renderTagChips();
            renderCases();
            toast('已删除案例');
        } catch (error) {
            toast(error.message || '删除失败', true);
        }
    }

    /* ---------------- 图片空间选图 ---------------- */

    const PICKER_SOURCE_NAMES = {upload: '上传素材', generated: '生成素材', local: '本地素材'};
    let pickerSearchTimer = null;

    function pickerProductMode() { return state.picker.product === true; }

    function pickerImageName(item) {
        if (item.name) return item.name;
        try { return decodeURIComponent(String(item.url || '').split('?')[0].split('/').pop()) || '图片'; }
        catch (error) { return '图片'; }
    }

    function pickerThumb(url) { return `/api/media-preview?w=256&url=${encodeURIComponent(url)}`; }

    function openImagePicker(product, images = []) {
        const picker = state.picker;
        picker.returnFocus = document.activeElement;
        picker.product = Boolean(product);
        picker.selected.clear();
        if (product) images.forEach((url) => picker.selected.set(url, {url}));
        $('pickerTitle').textContent = product ? '选择商品图' : '新增参考';
        $('pickerDescription').textContent = product ? '按文件夹找图，点击勾选；可跨来源选择多张图片。' : '选择图片，收藏为可复用的设计参考。';
        $('pickerCaseFields').hidden = product;
        $('pickerStatus').textContent = '';
        $('pickerOverlay').hidden = false;
        $('pickerSearch').value = picker.query;
        updatePickerSelection();
        loadPicker();
        $('pickerSearch').focus();
    }

    function closeImagePicker() {
        const picker = state.picker;
        clearTimeout(pickerSearchTimer);
        picker.controller?.abort();
        picker.requestId += 1;
        picker.loading = false;
        closePickerPreview(false);
        $('pickerOverlay').hidden = true;
        picker.product = false;
        $('pickerTitle').textContent = '新增参考';
        picker.returnFocus?.focus();
    }

    function renderPickerNavigation() {
        const picker = state.picker;
        document.querySelectorAll('[data-picker-source]').forEach((button) => {
            const active = button.dataset.pickerSource === picker.kind;
            button.classList.toggle('active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        $('pickerFolders').innerHTML = `<button class="picker-folder${!picker.folder ? ' active' : ''}" type="button" data-picker-folder=""><i data-lucide="layout-grid"></i><span>全部图片</span></button>` + picker.folders.map((folder) => {
            const parts = folder.path.split('/');
            return `<button class="picker-folder${picker.folder === folder.path ? ' active' : ''}" type="button" data-picker-folder="${esc(folder.path)}" style="--folder-depth:${Math.min(parts.length - 1, 5)}" title="${esc(folder.path)}"><i data-lucide="folder"></i><span>${esc(folder.name || parts.at(-1))}</span></button>`;
        }).join('');
        const segments = picker.folder.split('/').filter(Boolean);
        $('pickerBreadcrumb').innerHTML = `<button type="button" data-picker-folder="">${PICKER_SOURCE_NAMES[picker.kind]}</button>` + segments.map((name, index) => `<span>/</span><button type="button" data-picker-folder="${esc(segments.slice(0, index + 1).join('/'))}">${esc(name)}</button>`).join('') + (!segments.length ? '<span>/</span><span>全部图片</span>' : '');
        window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
    }

    function pickerCard(item) {
        const name = pickerImageName(item);
        const size = item.width && item.height ? `${item.width} × ${item.height}` : (item.size ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : '');
        return `<div class="picker-tile">
            <button class="picker-item" type="button" data-picker-url="${esc(item.url)}" aria-label="选择 ${esc(name)}" aria-pressed="false" title="${esc(item.folder ? `${item.folder}/${name}` : name)}">
                <span class="picker-thumb"><img src="${esc(pickerThumb(item.url))}" alt="${esc(name)}" loading="lazy" decoding="async"><span class="mark" aria-hidden="true"></span></span>
                <span class="picker-filename">${esc(name)}</span><span class="picker-file-meta">${esc(size || item.folder || PICKER_SOURCE_NAMES[state.picker.kind])}</span>
            </button>
            <button class="picker-preview-button" type="button" data-picker-preview="${esc(item.url)}" aria-label="预览 ${esc(name)}" title="放大预览"><i data-lucide="maximize-2"></i></button>
        </div>`;
    }

    function renderPicker() {
        const picker = state.picker;
        $('pickerGrid').innerHTML = picker.items.length ? picker.items.map(pickerCard).join('') : (picker.loading ? '<div class="picker-skeleton" aria-hidden="true"></div>'.repeat(12) : `<div class="picker-empty"><i data-lucide="image"></i><strong>${picker.query ? '没有找到匹配的图片' : '这里还没有图片'}</strong><p>${picker.query ? '试试其他名称或标签，也可以切换文件夹。' : '切换左侧来源或文件夹，查看其他素材。'}</p></div>`);
        $('pickerResultCount').textContent = picker.loading && !picker.items.length ? '正在读取…' : `已显示 ${picker.items.length} / ${picker.total} 张`;
        $('pickerLoadMore').hidden = !picker.hasMore;
        $('pickerLoadMore').disabled = picker.loading;
        $('pickerLoadMore').textContent = picker.loading ? '正在读取…' : '加载更多图片';
        $('pickerGrid').setAttribute('aria-busy', String(picker.loading));
        updatePickerSelection();
        window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
    }

    async function loadPicker({append = false, force = false} = {}) {
        const picker = state.picker;
        picker.controller?.abort();
        const requestId = ++picker.requestId;
        const key = JSON.stringify([picker.kind, picker.folder, picker.query]);
        const cached = !append && !force && picker.cache.get(key);
        if (cached && Date.now() - cached.at < 30000) {
            Object.assign(picker, cached.data, {loading: false});
            $('pickerLoadState').innerHTML = '';
            renderPickerNavigation(); renderPicker();
            return;
        }
        const sameLocation = picker.loadedKey === key;
        if (!append && !sameLocation) {
            picker.items = [];
            picker.total = 0;
            picker.offset = 0;
            picker.hasMore = false;
            if (picker.loadedKind !== picker.kind) picker.folders = [];
            $('pickerScroll').scrollTop = 0;
        }
        const offset = append ? picker.offset : 0;
        picker.loading = true;
        const controller = new AbortController();
        picker.controller = controller;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 18000);
        $('pickerLoadState').textContent = picker.items.length ? '正在更新图片列表…' : '正在读取图片…';
        renderPickerNavigation();
        if (!append) renderPicker();
        else { $('pickerLoadMore').disabled = true; $('pickerLoadMore').textContent = '正在读取…'; }
        try {
            const query = new URLSearchParams({kind: picker.kind, view: 'picker', media_type: 'image', limit: '80', offset: String(offset)});
            if (picker.folder) query.set('folder', picker.folder);
            if (picker.query) query.set('filters', JSON.stringify({query: picker.query}));
            const data = await api(`/api/storage-files?${query}`, {signal: controller.signal});
            if (requestId !== picker.requestId || $('pickerOverlay').hidden) return;
            const incoming = (data.items || []).filter((item) => item.url);
            incoming.forEach((item) => {
                const selected = picker.selected.get(item.url);
                if (selected && !selected.name) selected.name = pickerImageName(item);
            });
            picker.items = append ? [...new Map([...picker.items, ...incoming].map((item) => [item.url, item])).values()] : incoming;
            picker.offset = offset + incoming.length;
            picker.total = Number(data.total ?? picker.items.length);
            picker.hasMore = Boolean(data.has_more) && incoming.length > 0;
            picker.folders = data.folders || [];
            picker.loadedKey = key;
            picker.loadedKind = picker.kind;
            picker.loading = false;
            const snapshot = {items: picker.items.slice(), folders: picker.folders.slice(), offset: picker.offset, total: picker.total, hasMore: picker.hasMore, loadedKey: key, loadedKind: picker.kind};
            picker.cache.delete(key);
            picker.cache.set(key, {at: Date.now(), data: snapshot});
            if (picker.cache.size > 12) picker.cache.delete(picker.cache.keys().next().value);
            $('pickerLoadState').textContent = '';
            if (append) {
                const existing = new Set([...$('pickerGrid').querySelectorAll('[data-picker-url]')].map((node) => node.dataset.pickerUrl));
                $('pickerGrid').insertAdjacentHTML('beforeend', incoming.filter((item) => !existing.has(item.url)).map(pickerCard).join(''));
                $('pickerResultCount').textContent = `已显示 ${picker.items.length} / ${picker.total} 张`;
                $('pickerLoadMore').hidden = !picker.hasMore;
                updatePickerSelection();
                window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
            } else renderPicker();
            renderPickerNavigation();
        } catch (error) {
            if (requestId !== picker.requestId || $('pickerOverlay').hidden || (controller.signal.aborted && !timedOut)) return;
            picker.loading = false;
            if (!picker.items.length) { $('pickerGrid').innerHTML = ''; $('pickerResultCount').textContent = '读取失败'; }
            $('pickerLoadState').innerHTML = `<span>${esc(timedOut ? '图片读取时间较长，请重试或切换来源。' : `图片读取失败：${error.message}`)}</span><button class="subtle-button" type="button" data-picker-retry="${append ? 'more' : 'page'}">重试</button>`;
        } finally {
            clearTimeout(timeout);
            if (requestId === picker.requestId) {
                picker.loading = false;
                $('pickerGrid').setAttribute('aria-busy', 'false');
                $('pickerLoadMore').disabled = false;
                $('pickerLoadMore').textContent = '加载更多图片';
            }
        }
    }

    function togglePickerItem(url) {
        const picker = state.picker;
        if (picker.selected.has(url)) picker.selected.delete(url);
        else {
            const item = picker.items.find((entry) => entry.url === url);
            if (!item) return;
            picker.selected.set(url, {url, name: pickerImageName(item), ...(item.asset_id || item.asset_ref_id ? {asset_ref_id: item.asset_id || item.asset_ref_id} : {})});
        }
        $('pickerStatus').textContent = '';
        updatePickerSelection();
    }

    function updatePickerSelection() {
        const selected = state.picker.selected;
        const urls = [...selected.keys()];
        // 勾选时保留已有图片节点，避免重新加载缩略图和丢失滚动位置。
        $('pickerGrid').querySelectorAll('[data-picker-url]').forEach((button) => {
            const rank = urls.indexOf(button.dataset.pickerUrl) + 1;
            button.classList.toggle('selected', Boolean(rank));
            button.setAttribute('aria-pressed', String(Boolean(rank)));
            button.querySelector('.mark').textContent = rank || '';
        });
        $('pickerSelectedCount').textContent = selected.size ? `已选 ${selected.size} 张` : '尚未选择图片';
        $('pickerClear').disabled = !selected.size;
        $('pickerSelected').innerHTML = selected.size ? [...selected.values()].map((item, index) => `<div class="picker-selected-item"><img src="${esc(pickerThumb(item.url))}" alt="${esc(pickerImageName(item))}" title="${esc(pickerImageName(item))}"><span>${index + 1}</span><button type="button" data-picker-remove="${esc(item.url)}" aria-label="移除 ${esc(pickerImageName(item))}">×</button></div>`).join('') : '<span class="picker-selection-empty">点击图片即可勾选，选中的图片会出现在这里。</span>';
        $('pickerCreate').textContent = pickerProductMode() ? `完成选择${selected.size ? `（${selected.size}）` : ''}` : '收藏所选';
        updatePickerCreate();
        if (!$('pickerPreview').hidden) updatePickerPreviewSelection();
    }

    function updatePickerCreate() {
        $('pickerCreate').disabled = !state.picker.selected.size || (!pickerProductMode() && !($('pickerTitleInput').value || '').trim());
    }

    function openPickerPreview(url) {
        const picker = state.picker;
        const index = picker.items.findIndex((item) => item.url === url);
        if (index < 0) return;
        picker.previewUrl = url;
        const item = picker.items[index];
        $('pickerPreviewName').textContent = pickerImageName(item);
        $('pickerPreviewStatus').textContent = '正在读取原图…';
        $('pickerPreviewImage').src = url;
        $('pickerPreviewImage').alt = pickerImageName(item);
        $('pickerPreviewPosition').textContent = `${index + 1} / ${picker.items.length}`;
        $('pickerPreviewPrev').disabled = index === 0;
        $('pickerPreviewNext').disabled = index === picker.items.length - 1;
        $('pickerPreview').hidden = false;
        updatePickerPreviewSelection();
        $('pickerPreviewClose').focus();
    }

    function updatePickerPreviewSelection() {
        const selected = state.picker.selected.has(state.picker.previewUrl);
        $('pickerPreviewSelect').textContent = selected ? '取消选中' : '选中这张';
        $('pickerPreviewSelect').disabled = false;
        $('pickerPreviewSelect').setAttribute('aria-pressed', String(selected));
    }

    function closePickerPreview(restoreFocus = true) {
        const url = state.picker.previewUrl;
        $('pickerPreview').hidden = true;
        $('pickerPreviewImage').removeAttribute('src');
        state.picker.previewUrl = '';
        if (restoreFocus) [...$('pickerGrid').querySelectorAll('[data-picker-preview]')].find((node) => node.dataset.pickerPreview === url)?.focus();
    }

    function movePickerPreview(direction) {
        const index = state.picker.items.findIndex((item) => item.url === state.picker.previewUrl);
        const item = state.picker.items[index + direction];
        if (item) openPickerPreview(item.url);
    }

    async function createPickerCase() {
        if (pickerProductMode()) {
            const images = [...state.picker.selected.keys()];
            closeImagePicker();
            document.dispatchEvent(new CustomEvent('design-brain-images-selected', {detail: {images}}));
            return;
        }
        const title = ($('pickerTitleInput').value || '').trim();
        if (!title) { toast('请填写案例标题', true); return; }
        const variants = [...state.picker.selected.values()];
        const tags = ($('pickerTagsInput').value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        try {
            const data = await api('/api/prompt-cases', {method: 'POST', body: {
                media_mode: 'refs',
                title,
                tags,
                variants,
                origin: {type: 'image_space'},
            }});
            closeImagePicker();
            toast(data.existing ? '这些图片已在灵感库中' : '已收藏为参考案例（不复制图片文件）');
            await loadCases();
        } catch (error) {
            $('pickerStatus').textContent = error.message || '收藏失败';
        }
    }

    /* ---------------- 项目经验（阶段 2） ---------------- */

    async function loadExperiences() {
        try {
            const data = await api('/api/design-brain/experiences');
            state.experiences = data.experiences || [];
            renderExperienceStatusChips();
            renderExperiences();
        } catch (error) {
            state.experiences = [];
            renderExperiences();
            $('experienceCount').textContent = error.message || '经验读取失败';
        }
    }

    function visibleExperiences() {
        if (!state.experienceFilter) return state.experiences;
        return state.experiences.filter((item) => item.status === state.experienceFilter);
    }

    function renderExperienceStatusChips() {
        const counts = {candidate: 0, pending_review: 0, published: 0, rejected: 0};
        state.experiences.forEach((item) => { counts[item.status] = (counts[item.status] || 0) + 1; });
        $('experienceStatusChips').innerHTML = [
            `<button type="button" data-exp-filter="" class="${state.experienceFilter === '' ? 'active' : ''}">全部 ${state.experiences.length}</button>`,
            ...Object.entries(EXP_STATUS_LABELS).map(([key, label]) =>
                `<button type="button" data-exp-filter="${key}" class="${state.experienceFilter === key ? 'active' : ''}">${label} ${counts[key] || 0}</button>`),
        ].join('');
    }

    function renderExperiences() {
        const items = visibleExperiences();
        $('experienceCount').textContent = `${items.length} 条经验`;
        if (!items.length) {
            $('experienceGrid').innerHTML = '<div class="empty"><strong>还没有项目经验</strong><span>用右上角「从历史提炼」选择生成记录，或「新建经验」手动记录。</span></div>';
            return;
        }
        $('experienceGrid').innerHTML = items.map((item) => {
            const evidenceCount = ((item.evidence || {}).asset_refs || []).length;
            const skillNote = ((item.publish || {}).skill_id) ? ' · 已生成 Skill' : '';
            return `<article class="exp-card" data-exp-id="${esc(item.id)}">
                <h3>${esc(item.title)}</h3>
                <p class="exp-sub"><span class="status-badge status-${esc(item.status)}">${EXP_STATUS_LABELS[item.status] || item.status}</span>
                    <span style="margin-left:8px">${evidenceCount} 份证据 · ${(item.observations || []).length} 条观察${skillNote}</span></p>
                <p class="exp-obs">${esc((item.observations || []).slice(0, 3).join('；'))}</p>
            </article>`;
        }).join('');
    }

    function findExperience(id) {
        return state.experiences.find((item) => item.id === id) || null;
    }

    function openExperienceForm(prefill) {
        state.expEditingId = '';
        state.expDraft = normalizeExperienceDraft(prefill || {});
        renderExperienceDetail(true);
        $('experienceOverlay').hidden = false;
    }

    function openExperienceDetail(id) {
        const item = findExperience(id);
        if (!item) return;
        state.expEditingId = id;
        state.expDraft = JSON.parse(JSON.stringify(item));
        renderExperienceDetail(false);
        $('experienceOverlay').hidden = false;
    }

    function normalizeExperienceDraft(raw) {
        return {
            title: raw.title || '',
            project_id: raw.project_id || '',
            status: raw.status || 'candidate',
            origin: raw.origin || {type: 'manual', note: ''},
            observations: raw.observations || [],
            evidence: raw.evidence || {history_timestamps: [], asset_refs: [], canvas_ids: []},
            proposals: raw.proposals || {profile_patch: [], skill: null},
            review: raw.review || {requested_at: 0, decided_at: 0, comment: ''},
            publish: raw.publish || {published_at: 0, applied_profile_tags: [], skill_id: ''},
            distill_meta: raw.distill_meta || {provider: '', model: '', at: 0},
        };
    }

    function patchRowHtml(entry, index) {
        const groupOptions = PATCH_GROUPS.map((group) => `<option value="${group.key}"${entry.group === group.key ? ' selected' : ''}>${group.label}</option>`).join('');
        const weight = entry.group === 'avoid_tags' ? '' :
            `<select class="inline-input patch-weight" data-patch-index="${index}" aria-label="权重">${WEIGHT_OPTIONS.map(([value, label]) => `<option value="${value}"${weightLabel(entry.weight) === label ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
        return `<div class="patch-row" data-patch-row="${index}">
            <select class="inline-input patch-group" data-patch-group="${index}" aria-label="标签组">${groupOptions}</select>
            <input class="inline-input patch-tag" type="text" data-patch-tag="${index}" value="${esc(entry.tag || '')}" placeholder="标签">
            ${weight}
            <button class="remove" type="button" data-remove-patch="${index}" aria-label="移除">×</button>
        </div>`;
    }

    function renderExperienceDetail(isNew) {
        const draft = state.expDraft;
        const editable = isNew || ['candidate', 'rejected'].includes(draft.status);
        const evidence = draft.evidence || {};
        const patches = ((draft.proposals || {}).profile_patch) || [];
        const statusActions = isNew ? '' : statusActionsHtml(draft);
        $('experienceBody').innerHTML = `
            <h2 id="experienceTitle">${isNew ? '新建候选经验' : esc(draft.title)}</h2>
            <p class="muted">${isNew ? '候选经验只保存在本机；提交审核并发布后才会影响审美档案或生成 Skill。'
                : `<span class="status-badge status-${esc(draft.status)}">${EXP_STATUS_LABELS[draft.status] || draft.status}</span>
                   <span style="margin-left:8px">${(evidence.asset_refs || []).length} 份证据 · ${(evidence.history_timestamps || []).length} 条历史记录</span>`}</p>
            ${!isNew && draft.status === 'published' && ((draft.publish || {}).applied_profile_tags || []).length ? `
                <div class="publish-effects">发布时已写入档案标签：${draft.publish.applied_profile_tags.map((tag) => esc(`${groupLabel(tag.group)}·${tag.tag}`)).join('、')}</div>` : ''}
            ${!isNew && draft.status === 'rejected' && ((draft.review || {}).comment) ? `<p class="muted review-comment">拒绝原因：${esc(draft.review.comment)}</p>` : ''}
            ${statusActions ? `<div class="detail-actions">${statusActions}</div>` : ''}
            <div class="exp-form">
                <label for="expTitle">标题</label>
                <input id="expTitle" class="inline-input" type="text" value="${esc(draft.title)}" ${editable ? '' : 'disabled'}>
                <label for="expProject">所属项目（可选）</label>
                <input id="expProject" class="inline-input" type="text" value="${esc(draft.project_id || '')}" placeholder="项目 ID" ${editable ? '' : 'disabled'}>
                <label for="expObservations">经验观察（每行一条）</label>
                <textarea id="expObservations" ${editable ? '' : 'disabled'}>${esc((draft.observations || []).join('\n'))}</textarea>
                ${editable ? `
                <div class="ai-bar" id="distillBar">
                    <button class="subtle-button" type="button" id="distillButton">AI 提炼观察</button>
                    <select id="distillProvider" class="inline-input" aria-label="对话平台"></select>
                    <select id="distillModel" class="inline-input" aria-label="对话模型"></select>
                </div>
                <p class="ai-note" id="distillNote"></p>` : ''}
                <label>发布时写入档案的标签（仅在「发布」时生效）</label>
                <div id="patchRows">${patches.map(patchRowHtml).join('')}</div>
                ${editable ? `<button class="subtle-button" type="button" id="patchAdd">添加档案标签</button>` : ''}
                ${(evidence.asset_refs || []).length ? `<label>证据图片（引用原图，未复制）</label>
                <div class="evidence-strip">${evidence.asset_refs.slice(0, 12).map((ref) => `<figure><img src="${esc(ref.url)}" alt="" loading="lazy"><figcaption>${esc(String(ref.url).split('/').pop() || '')}</figcaption></figure>`).join('')}</div>` : ''}
                ${editable ? `<div class="detail-actions" style="margin-top:18px">
                    <button class="primary-button" type="button" id="expSave">${isNew ? '创建候选经验' : '保存修改'}</button>
                </div>` : ''}
            </div>`;
        if (editable) {
            bindExperienceForm(isNew);
        } else {
            bindExperienceStatusActions();
        }
    }

    function groupLabel(key) {
        return (PATCH_GROUPS.find((group) => group.key === key) || {}).label || key;
    }

    function statusActionsHtml(draft) {
        switch (draft.status) {
            case 'candidate':
                return `<button class="primary-button" type="button" data-exp-action="submit">提交审核</button>
                        <button class="subtle-button danger" type="button" data-exp-action="delete">删除</button>`;
            case 'pending_review':
                return `<button class="primary-button" type="button" data-exp-action="publish">审核通过并发布</button>
                        <button class="subtle-button danger" type="button" data-exp-action="reject">拒绝</button>`;
            case 'rejected':
                return `<button class="subtle-button" type="button" data-exp-action="requeue">恢复为候选</button>
                        <button class="subtle-button danger" type="button" data-exp-action="delete">删除</button>`;
            case 'published':
                return `<button class="primary-button" type="button" data-exp-action="skill">生成 Skill 草稿</button>`;
            default:
                return '';
        }
    }

    function bindExperienceForm(isNew) {
        bindExperienceStatusActions();
        const draft = state.expDraft;
        $('expSave').addEventListener('click', async () => {
            draft.title = ($('expTitle').value || '').trim();
            draft.project_id = ($('expProject').value || '').trim();
            draft.observations = ($('expObservations').value || '').split('\n').map((line) => line.trim()).filter(Boolean);
            collectPatchRows();
            if (!draft.observations.length) { toast('请至少填写一条经验观察', true); return; }
            const button = $('expSave');
            button.disabled = true;
            try {
                const body = {
                    title: draft.title,
                    project_id: draft.project_id,
                    origin: draft.origin,
                    observations: draft.observations,
                    evidence: draft.evidence,
                    proposals: draft.proposals,
                    distill_meta: draft.distill_meta,
                };
                if (isNew) {
                    const data = await api('/api/design-brain/experiences', {method: 'POST', body});
                    state.experiences = [data.experience, ...state.experiences];
                    toast('已创建候选经验');
                } else {
                    const data = await api(`/api/design-brain/experiences/${encodeURIComponent(state.expEditingId)}`, {method: 'PATCH', body});
                    const index = state.experiences.findIndex((item) => item.id === state.expEditingId);
                    if (index >= 0) state.experiences[index] = data.experience;
                    toast('已保存修改');
                }
                renderExperienceStatusChips();
                renderExperiences();
                $('experienceOverlay').hidden = true;
            } catch (error) {
                toast(error.message || '保存失败', true);
            } finally {
                button.disabled = false;
            }
        });
        $('patchAdd').addEventListener('click', () => {
            collectPatchRows();
            draft.proposals.profile_patch.push({group: 'style_tags', tag: '', weight: 0.6});
            renderExperienceDetail(isNew);
            const lastIndex = draft.proposals.profile_patch.length - 1;
            const input = document.querySelector(`[data-patch-tag="${lastIndex}"]`);
            if (input) input.focus();
        });
        document.querySelectorAll('[data-remove-patch]').forEach((button) => {
            button.addEventListener('click', () => {
                collectPatchRows();
                draft.proposals.profile_patch.splice(Number(button.dataset.removePatch), 1);
                renderExperienceDetail(isNew);
            });
        });
        document.querySelectorAll('[data-patch-group]').forEach((select) => {
            select.addEventListener('change', () => {
                collectPatchRows();
                draft.proposals.profile_patch[Number(select.dataset.patchGroup)].group = select.value;
                renderExperienceDetail(isNew);
            });
        });
        setupDistillBar();
    }

    function collectPatchRows() {
        const draft = state.expDraft;
        const patches = [];
        document.querySelectorAll('[data-patch-row]').forEach((row) => {
            const index = row.dataset.patchRow;
            const group = (document.querySelector(`[data-patch-group="${index}"]`) || {}).value || 'style_tags';
            const tag = ((document.querySelector(`[data-patch-tag="${index}"]`) || {}).value || '').trim();
            const weightInput = document.querySelector(`[data-patch-index="${index}"]`);
            const weight = weightInput ? Number(weightInput.value) : 0.6;
            if (tag) patches.push({group, tag, weight});
        });
        draft.proposals.profile_patch = patches;
    }

    function bindExperienceStatusActions() {
        document.querySelectorAll('[data-exp-action]').forEach((button) => {
            button.addEventListener('click', () => handleExperienceAction(button.dataset.expAction));
        });
    }

    async function handleExperienceAction(action) {
        const id = state.expEditingId;
        if (!id) return;
        try {
            if (action === 'submit') {
                const data = await api(`/api/design-brain/experiences/${encodeURIComponent(id)}/submit`, {method: 'POST'});
                updateExperienceInState(data.experience);
                toast('已提交审核');
            } else if (action === 'publish') {
                if (!window.confirm('发布这条经验？发布后建议的标签会写入审美档案（已存在的标签不会重复添加）。')) return;
                const data = await api(`/api/design-brain/experiences/${encodeURIComponent(id)}/publish`, {method: 'POST'});
                updateExperienceInState(data.experience);
                const applied = (data.applied_profile_tags || []).length;
                toast(applied ? `已发布；写入 ${applied} 个档案标签` : '已发布');
                await loadProfile();
            } else if (action === 'reject') {
                const comment = window.prompt('拒绝原因（可选）：') || '';
                const data = await api(`/api/design-brain/experiences/${encodeURIComponent(id)}/reject`, {method: 'POST', body: {comment}});
                updateExperienceInState(data.experience);
                toast('已拒绝');
            } else if (action === 'requeue') {
                const data = await api(`/api/design-brain/experiences/${encodeURIComponent(id)}/requeue`, {method: 'POST'});
                updateExperienceInState(data.experience);
                toast('已恢复为候选');
            } else if (action === 'delete') {
                if (!window.confirm('删除这条经验记录？不会影响图片与档案。')) return;
                await api(`/api/design-brain/experiences/${encodeURIComponent(id)}`, {method: 'DELETE'});
                state.experiences = state.experiences.filter((item) => item.id !== id);
                renderExperienceStatusChips();
                renderExperiences();
                $('experienceOverlay').hidden = true;
                toast('已删除经验');
                return;
            } else if (action === 'skill') {
                await generateSkillFromExperience(id);
                return;
            }
            renderExperienceStatusChips();
            renderExperiences();
            openExperienceDetail(id);
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    function updateExperienceInState(item) {
        const index = state.experiences.findIndex((entry) => entry.id === item.id);
        if (index >= 0) state.experiences[index] = item;
        else state.experiences = [item, ...state.experiences];
    }

    async function generateSkillFromExperience(experienceId) {
        const experience = findExperience(experienceId);
        if (!experience) return;
        const name = window.prompt('Skill 名称：', `${experience.title}`.slice(0, 40)) || '';
        if (!name.trim()) return;
        try {
            const data = await api(`/api/design-brain/experiences/${encodeURIComponent(experienceId)}/skill`, {
                method: 'POST',
                body: {name: name.trim()},
            });
            toast(`已生成 Skill 草稿「${data.skill.display_name || data.skill.name}」（默认停用）`);
            $('experienceOverlay').hidden = true;
            await loadExperiences();
            await loadSkills();
            switchTab('skills');
        } catch (error) {
            toast(error.message || '生成失败', true);
        }
    }

    /* ---------------- AI 提炼（隐私开关 + 用户确认） ---------------- */

    async function ensureProviders() {
        if (state.providers !== null) return state.providers;
        try {
            const data = await api('/api/providers');
            state.providers = (data.providers || []).filter((provider) => (provider.chat_models || []).length && provider.enabled !== false);
        } catch (error) {
            state.providers = [];
        }
        return state.providers;
    }

    async function setupDistillBar() {
        const bar = $('distillBar');
        if (!bar) return;
        const allowed = ((state.profile || {}).privacy || {}).allow_cloud_analysis === true;
        const button = $('distillButton');
        const note = $('distillNote');
        const providerSelect = $('distillProvider');
        const modelSelect = $('distillModel');
        const providers = await ensureProviders();
        providerSelect.innerHTML = providers.map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name || provider.id)}</option>`).join('') || '<option value="">（未配置对话模型）</option>';
        const fillModels = () => {
            const provider = providers.find((item) => item.id === providerSelect.value);
            modelSelect.innerHTML = (provider ? provider.chat_models : []).map((model) => `<option value="${esc(model)}">${esc(model)}</option>`).join('') || '<option value="">（无模型）</option>';
        };
        providerSelect.addEventListener('change', fillModels);
        fillModels();
        if (!allowed) {
            button.disabled = true;
            note.textContent = 'AI 提炼需要先在「审美档案」中打开隐私开关（允许发送文本给对话模型）。本地手动记录不受影响。';
            return;
        }
        if (!providers.length) {
            button.disabled = true;
            note.textContent = '尚未配置可用的对话平台，请先在 API 设置中添加。';
            return;
        }
        note.textContent = '点击后会把所选历史记录的提示词与参数文本发送给你选择的对话模型；图片与档案不会发送。';
        button.addEventListener('click', runDistill);
    }

    async function runDistill() {
        const draft = state.expDraft;
        const selected = selectedHistoryRecords();
        if (!selected.length) { toast('请先从历史记录选择证据', true); return; }
        const providerId = $('distillProvider').value;
        const model = $('distillModel').value;
        if (!providerId || !model) { toast('请选择对话平台与模型', true); return; }
        const summary = selected.slice(0, 20).map((record, index) => {
            const params = record.params || {};
            const size = [params.size, params.quality].filter(Boolean).join(' / ');
            return `记录${index + 1}：模型=${record.model || params.model || '未知'}${size ? `；参数=${size}` : ''}\n提示词：${String(record.prompt || '').slice(0, 600)}`;
        }).join('\n\n');
        const providerName = (($('distillProvider').selectedOptions[0] || {}).textContent || providerId);
        if (!window.confirm(`将把 ${selected.length} 条记录的提示词与参数文本发送给「${providerName}」的 ${model}。确认继续？`)) return;
        const button = $('distillButton');
        button.disabled = true;
        button.textContent = '提炼中…';
        try {
            const data = await api('/api/canvas-llm', {method: 'POST', body: {
                message: `请从以下历史生成记录中提炼设计经验：\n\n${summary}`,
                system_prompt: DISTILL_SYSTEM,
                provider: providerId,
                model,
            }});
            const parsed = parseDistillJson(data.text || '');
            if (!parsed) throw new Error('模型返回无法解析，请重试或手动填写');
            if (Array.isArray(parsed.observations) && parsed.observations.length) {
                draft.observations = parsed.observations.slice(0, 20).map((text) => String(text).slice(0, 500));
                $('expObservations').value = draft.observations.join('\n');
            }
            if (Array.isArray(parsed.profile_patch) && parsed.profile_patch.length) {
                const existing = new Set((((draft.proposals || {}).profile_patch) || []).map((patch) => `${patch.group}|${patch.tag}`));
                draft.proposals = draft.proposals || {profile_patch: [], skill: null};
                for (const patch of parsed.profile_patch.slice(0, 20)) {
                    const key = `${patch.group}|${patch.tag}`;
                    if (!existing.has(key)) {
                        draft.proposals.profile_patch.push({group: patch.group, tag: String(patch.tag || '').slice(0, 40), weight: Number(patch.weight) || 0.6});
                        existing.add(key);
                    }
                }
                renderExperienceDetail(!state.expEditingId);
                const obsButton = document.getElementById('expObservations');
                if (obsButton) obsButton.value = (draft.observations || []).join('\n');
            }
            if (parsed.title && !$('expTitle').value.trim()) $('expTitle').value = String(parsed.title).slice(0, 80);
            draft.distill_meta = {provider: providerId, model, at: Date.now()};
            toast('已填入 AI 提炼结果，请人工核对后再提交审核');
        } catch (error) {
            toast(error.message || '提炼失败', true);
        } finally {
            button.disabled = false;
            button.textContent = 'AI 提炼观察';
        }
    }

    function parseDistillJson(text) {
        const match = String(text || '').match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            const parsed = JSON.parse(match[0]);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch (error) {
            return null;
        }
    }

    /* ---------------- 历史选择器 ---------------- */

    async function openHistoryPicker(prefillTimestamps) {
        $('historyOverlay').hidden = false;
        $('historyPickCount').textContent = '正在读取历史记录…';
        if (!state.historyPick.records.length) {
            try {
                const records = await api('/api/history?view=manager');
                state.historyPick.records = Array.isArray(records) ? records : [];
            } catch (error) {
                $('historyList').innerHTML = `<p class="muted">${esc(error.message || '历史记录读取失败')}</p>`;
                return;
            }
        }
        state.historyPick.selected = new Set();
        if (Array.isArray(prefillTimestamps)) {
            for (const ts of prefillTimestamps) {
                const record = state.historyPick.records.find((item) => Math.abs(Number(item.timestamp || 0) - Number(ts)) < 0.001);
                if (record) state.historyPick.selected.add(String(record.timestamp));
            }
        }
        renderHistoryList();
    }

    function historyPickVisible() {
        const query = ($('historySearch').value || '').trim().toLowerCase();
        const records = state.historyPick.records;
        if (!query) return records.slice(0, 80);
        return records.filter((item) => [item.prompt, item.model, item.params && item.params.model]
            .some((value) => String(value || '').toLowerCase().includes(query))).slice(0, 80);
    }

    function renderHistoryList() {
        const records = historyPickVisible();
        $('historyList').innerHTML = records.length ? records.map((record) => {
            const ts = String(record.timestamp || 0);
            const media = ((record.media_items || [])[0]) || {};
            const thumb = media.kind === 'video' ? '' : `<img src="${esc(media.url || '')}" alt="" loading="lazy">`;
            return `<div class="history-pick-row${state.historyPick.selected.has(ts) ? ' selected' : ''}" data-history-ts="${esc(ts)}" role="listitem" tabindex="0">
                ${thumb || '<span class="hp-video">▶</span>'}
                <div class="hp-text"><div class="hp-prompt">${esc(record.prompt || '（无提示词）')}</div>
                <div class="hp-meta">${esc(record.model || (record.params || {}).model || '')} · ${new Date(Number(record.timestamp || 0) * 1000).toLocaleString()}</div></div>
                <input class="hp-check" type="checkbox" aria-label="选择该记录" ${state.historyPick.selected.has(ts) ? 'checked' : ''}>
            </div>`;
        }).join('') : '<p class="muted" style="padding:14px">没有匹配的历史记录。</p>';
        updateHistoryPickCount();
    }

    function updateHistoryPickCount() {
        const count = state.historyPick.selected.size;
        $('historyPickCount').textContent = `已选 ${count} 条`;
        $('historyConfirm').disabled = !count;
    }

    function selectedHistoryRecords() {
        return state.historyPick.records.filter((record) => state.historyPick.selected.has(String(record.timestamp || 0)));
    }

    function confirmHistoryPick() {
        const records = selectedHistoryRecords();
        if (!records.length) return;
        const evidence = {history_timestamps: [], asset_refs: [], canvas_ids: []};
        for (const record of records) {
            evidence.history_timestamps.push(Number(record.timestamp || 0));
            for (const media of (record.media_items || []).slice(0, 4)) {
                if (media.kind === 'video' || !media.url) continue;
                if (!evidence.asset_refs.some((ref) => ref.url === media.url)) {
                    evidence.asset_refs.push({url: media.url});
                }
            }
        }
        const firstPrompt = String((records[0] || {}).prompt || '');
        $('historyOverlay').hidden = true;
        switchTab('experiences');
        openExperienceForm({
            title: firstPrompt ? firstPrompt.split('\n')[0].slice(0, 40) : '',
            origin: {type: 'history_distill', note: `来自 ${records.length} 条历史记录`},
            observations: [],
            evidence,
        });
    }

    /* ---------------- Skill 管理（阶段 2） ---------------- */

    async function loadSkills() {
        try {
            const data = await api('/api/design-brain/skills');
            state.skills = data.skills || [];
            renderSkills();
        } catch (error) {
            renderSkills();
            $('skillCount').textContent = error.message || 'Skill 读取失败';
        }
    }

    function renderSkills() {
        const items = state.skills;
        $('skillCount').textContent = `${items.length} 个经验技能`;
        if (!items.length) {
            $('skillGrid').innerHTML = '<div class="empty"><strong>还没有从经验提炼的技能</strong><span>发布项目经验后可生成技能草稿；已有技能可在上方选择或导入。</span></div>';
            return;
        }
        $('skillGrid').innerHTML = items.map((item) => {
            const experience = state.experiences.find((entry) => entry.id === item.experience_id);
            return `<article class="exp-card" data-skill-id="${esc(item.skill_id)}">
                <h3>${esc(item.display_name || item.skill_id)}</h3>
                <p class="exp-sub">
                    <span class="lifecycle-badge lifecycle-${esc(item.lifecycle)}">${item.lifecycle === 'published' ? '已发布' : '草稿'}</span>
                    <span style="margin-left:8px">${item.installed ? (item.enabled ? '已启用' : '已停用') : '未安装'}</span>
                    <span style="margin-left:8px">v${item.current_version}${experience ? ` · 来自经验「${esc(experience.title)}」` : ''}</span>
                </p>
                <p class="exp-obs">${item.installed ? '点击编辑内容、查看版本历史或调整启用状态。' : '安装目录已被删除；可解除占用后重新生成。'}</p>
            </article>`;
        }).join('');
    }

    function findSkill(id) {
        return state.skills.find((item) => item.skill_id === id) || null;
    }

    async function openSkillDetail(id) {
        let data;
        try {
            data = await api(`/api/design-brain/skills/${encodeURIComponent(id)}`);
        } catch (error) {
            toast(error.message || '读取失败', true);
            return;
        }
        const skill = data.skill;
        state.skillDraft = {id, ...skill};
        const parsed = parseSkillFrontMatter(skill.content || '');
        $('skillBody').innerHTML = `
            <h2 id="skillTitle">${esc(skill.display_name || id)}</h2>
            <p class="muted">
                <span class="lifecycle-badge lifecycle-${esc(skill.lifecycle)}">${skill.lifecycle === 'published' ? '已发布' : '草稿'}</span>
                <span style="margin-left:8px">${skill.installed ? (skill.enabled ? '已启用' : '已停用') : '未安装'} · 当前 v${skill.current_version}${skill.experience_id ? ` · 来源经验 <button class="link-button" type="button" data-open-experience="${esc(skill.experience_id)}">查看</button>` : ''}</span>
            </p>
            <div class="detail-actions">
                ${skill.lifecycle === 'draft' ? `<button class="primary-button" type="button" data-skill-action="publish">发布 Skill</button>` : ''}
                ${skill.installed ? `<button class="subtle-button" type="button" data-skill-action="${skill.enabled ? 'disable' : 'enable'}">${skill.enabled ? '停用' : '启用'}</button>` : ''}
                <button class="subtle-button" type="button" data-skill-action="save">保存新版本</button>
            </div>
            ${skill.lifecycle === 'draft' && skill.installed ? '<p class="ai-note">草稿 Skill 不能被启用；发布后才允许在画布 Agent 与对话中使用。</p>' : ''}
            <div class="skill-form">
                <label for="skillName">名称</label>
                <input id="skillName" class="inline-input" type="text" value="${esc(parsed.name)}">
                <label for="skillDescription">描述</label>
                <input id="skillDescription" class="inline-input" type="text" value="${esc(parsed.description)}">
                <label for="skillInstructions">指令内容（SKILL.md 正文）</label>
                <textarea id="skillInstructions" class="inline-input skill-instructions">${esc(parsed.instructions)}</textarea>
            </div>
            <div class="detail-section"><h3>版本历史（回退会生成新版本，不丢弃记录）</h3>
                <ul class="version-list" id="versionList">
                    ${(skill.versions || []).slice().reverse().map((version) => `
                        <li><span class="v-num">v${version.version}</span><span class="v-note">${esc(version.note || '')} · ${new Date(Number(version.created_at || 0)).toLocaleString()}</span>
                        ${version.version !== skill.current_version ? `<button type="button" data-rollback="${version.version}">回退到此版</button>` : '<span class="muted">当前版本</span>'}</li>`).join('')}
                </ul>
            </div>`;
        $('skillOverlay').hidden = false;
        document.querySelectorAll('[data-skill-action]').forEach((button) => {
            button.addEventListener('click', () => handleSkillAction(button.dataset.skillAction));
        });
        document.querySelectorAll('[data-rollback]').forEach((button) => {
            button.addEventListener('click', () => rollbackSkill(Number(button.dataset.rollback)));
        });
        const openExperienceButton = document.querySelector('[data-open-experience]');
        if (openExperienceButton) {
            openExperienceButton.addEventListener('click', () => {
                $('skillOverlay').hidden = true;
                openExperienceDetail(openExperienceButton.dataset.openExperience);
            });
        }
    }

    function parseSkillFrontMatter(content) {
        const match = String(content || '').match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
        if (!match) return {name: '', description: '', instructions: content};
        const read = (key) => {
            const line = match[1].split('\n').find((row) => row.trim().startsWith(`${key}:`));
            if (!line) return '';
            const value = line.slice(line.indexOf(':') + 1).trim();
            try { return JSON.parse(value); } catch (error) { return (value || '').replace(/^["']|["']$/g, ''); }
        };
        return {name: read('name'), description: read('description'), instructions: match[2] || ''};
    }

    async function handleSkillAction(action) {
        const id = state.skillDraft.id;
        try {
            if (action === 'publish') {
                if (!window.confirm('发布该 Skill？发布后才能启用并用于画布 Agent 与对话。')) return;
                await api(`/api/design-brain/skills/${encodeURIComponent(id)}/publish`, {method: 'POST'});
                toast('Skill 已发布，现在可以启用');
            } else if (action === 'enable' || action === 'disable') {
                await api(`/api/agent-skills/${encodeURIComponent(id)}`, {method: 'PATCH', body: {enabled: action === 'enable'}});
                toast(action === 'enable' ? '已启用' : '已停用');
            } else if (action === 'save') {
                const instructions = ($('skillInstructions').value || '').trim();
                if (!instructions) { toast('指令内容不能为空', true); return; }
                await api(`/api/design-brain/skills/${encodeURIComponent(id)}`, {method: 'PATCH', body: {
                    name: ($('skillName').value || '').trim(),
                    description: ($('skillDescription').value || '').trim(),
                    instructions,
                }});
                toast('已保存为新版本');
            }
            await loadSkills();
            await openSkillDetail(id);
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    async function rollbackSkill(version) {
        const id = state.skillDraft.id;
        if (!window.confirm(`回退到 v${version}？当前内容会先存为新版本，不会丢失。`)) return;
        try {
            await api(`/api/design-brain/skills/${encodeURIComponent(id)}/rollback`, {method: 'POST', body: {version}});
            toast(`已回退到 v${version}`);
            await loadSkills();
            await openSkillDetail(id);
        } catch (error) {
            toast(error.message || '回退失败', true);
        }
    }

    /* ---------------- 执行记录（阶段 3） ---------------- */

    async function loadRuns() {
        try {
            const data = await api('/api/design-brain/runs?limit=100');
            state.runs = data.runs || [];
            renderRuns();
        } catch (error) {
            state.runs = [];
            renderRuns();
            $('runCount').textContent = error.message || '执行记录读取失败';
        }
    }

    function renderRuns() {
        const items = state.runs;
        $('runCount').textContent = `${items.length} 条执行记录`;
        if (!items.length) {
            $('runGrid').innerHTML = '<div class="empty"><strong>还没有执行记录</strong><span>在画布 Agent 面板打开「设计大脑方案」，生成并确认方案后，这里会记录档案版本、Skill、任务与结果。</span></div>';
            return;
        }
        $('runGrid').innerHTML = items.map((run) => {
            const execution = run.execution || {};
            const skill = run.skill || {};
            const cases = run.case_ids || [];
            const result = run.result || {};
            const statusNote = run.status === 'failed' && result.error ? ` · ${esc(result.error)}` : (result.note ? ` · ${esc(result.note)}` : '');
            return `<article class="exp-card" data-run-id="${esc(run.id)}">
                <h3>${esc(run.title)}</h3>
                <p class="exp-sub"><span class="status-badge ${RUN_STATUS_CLASS[run.status] || 'status-candidate'}">${RUN_STATUS_LABELS[run.status] || run.status}</span>
                    <span style="margin-left:8px">${new Date(Number(run.created_at || 0)).toLocaleString()}${statusNote}</span></p>
                <p class="exp-obs">档案 v${run.profile_revision ?? 0}${skill.skill_id ? ` · Skill ${esc(skill.name)} ${esc(skill.version || '')}` : ''}${cases.length ? ` · 案例 ×${cases.length}` : ''} · 任务 ×${(execution.canvas_task_ids || []).length} · 图片 ×${(execution.asset_refs || []).length}${(execution.models || []).length ? ` · ${esc((execution.models || []).join('、'))}` : ''}</p>
                <div class="run-detail" hidden>
                    ${(run.plan && run.plan.summary) ? `<p class="exp-obs">${esc(run.plan.summary)}</p>` : ''}
                    ${(run.plan && run.plan.prompt) ? `<p class="exp-obs">提示词：${esc(String(run.plan.prompt).slice(0, 400))}</p>` : ''}
                    ${cases.length ? `<p class="exp-obs">参考案例：${cases.map((entry) => esc(entry.title)).join('、')}</p>` : ''}
                    ${(run.events || []).length ? `<ul class="version-list">${run.events.slice(-12).map((event) => `<li><span class="v-num">${new Date(Number(event.at || 0)).toLocaleTimeString()}</span><span class="v-note">${esc(event.note || event.type)}</span></li>`).join('')}</ul>` : ''}
                </div>
            </article>`;
        }).join('');
    }

    /* ---------------- 质量反馈与数据管理（阶段 4） ---------------- */

    async function loadReviews() {
        try {
            const params = new URLSearchParams({limit: '200'});
            if (state.reviewFilter) params.set('skill_id', state.reviewFilter);
            const data = await api(`/api/design-brain/reviews?${params.toString()}`);
            state.reviews = data.reviews || [];
            renderReviewFilter();
            renderReviews();
            if (state.reviewFilter) await loadSkillStats(state.reviewFilter);
            else $('skillStatsBox').innerHTML = '';
        } catch (error) {
            state.reviews = [];
            renderReviews();
            $('reviewCount').textContent = error.message || '评价读取失败';
        }
    }

    function renderReviewFilter() {
        const seen = new Map();
        for (const review of state.reviews) {
            const id = (review.context || {}).skill_id || '';
            if (id && !seen.has(id)) seen.set(id, (review.context || {}).skill_name || id);
        }
        // 已选筛选可能不在当前结果里（列表按 skill 过滤过），补充显示。
        const select = $('reviewSkillFilter');
        const current = state.reviewFilter;
        const options = ['<option value="">全部评价</option>'];
        for (const [id, name] of seen) options.push(`<option value="${esc(id)}"${current === id ? ' selected' : ''}>${esc(name)}</option>`);
        if (current && !seen.has(current)) options.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
        select.innerHTML = options.join('');
    }

    function starsText(rating) {
        return '★★★★★'.slice(0, rating) + '☆☆☆☆☆'.slice(0, 5 - rating);
    }

    function renderReviews() {
        const items = state.reviews;
        $('reviewCount').textContent = `${items.length} 条评价`;
        if (!items.length) {
            $('reviewGrid').innerHTML = '<div class="empty"><strong>还没有质量评价</strong><span>在历史记录点「质量评价」给生成结果打分；评分会关联图片、设计任务与 Skill 版本。</span></div>';
            return;
        }
        $('reviewGrid').innerHTML = items.map((review) => {
            const context = review.context || {};
            const feedback = review.user_feedback || {};
            const checks = review.auto_checks || {};
            const meta = [
                context.skill_id ? `${context.skill_name || context.skill_id} ${context.skill_version || ''}`.trim() : '未用 Skill',
                context.model || '',
                context.reference_count ? `参考图 ×${context.reference_count}` : '',
                feedback.selected_as_final ? '★ 成品' : '',
                checks.note || '',
            ].filter(Boolean).join(' · ');
            return `<article class="exp-card" data-review-id="${esc(review.id)}">
                ${(review.target || {}).url ? `<img src="${esc(review.target.url)}" alt="" loading="lazy" style="width:100%;height:120px;object-fit:cover;border-radius:9px;background:#e9efed;margin-bottom:8px;">` : ''}
                <h3 style="color:${feedback.rating <= 2 ? '#a24a44' : '#25764f'};">${starsText(feedback.rating || 0)}${review.issue_tag ? ` · ${ISSUE_LABELS[review.issue_tag] || review.issue_tag}` : ''}</h3>
                <p class="exp-sub">${esc(meta)}</p>
                ${feedback.comment ? `<p class="exp-obs">${esc(feedback.comment)}</p>` : ''}
                <p class="exp-sub" style="margin-top:6px;">${new Date(Number(review.created_at || 0)).toLocaleString()} · ${((review.target || {}).run_id) ? '关联执行记录' : '无执行记录'}
                    <button class="link-button" type="button" data-delete-review="${esc(review.id)}" style="margin-left:8px;">删除</button></p>
            </article>`;
        }).join('');
    }

    async function loadSkillStats(skillId) {
        try {
            const data = await api(`/api/design-brain/skills/${encodeURIComponent(skillId)}/stats`);
            const stats = data.stats || {};
            const versions = (stats.by_version || []).map(item => `${item.version}：${item.average} 分 / ${item.count} 条`).join('；');
            let html = `<div class="publish-effects"><b>${esc(skillId)}</b> · 均分 ${stats.average ?? 0}（${stats.count ?? 0} 条评价）${versions ? `<br>版本分布：${esc(versions)}` : ''}</div>`;
            if (data.suggestion) {
                html += `<div class="publish-effects" style="border-color:#e3d9b8;background:#fdf9ec;color:#7a7259;">
                    <b>经验优化建议</b>（${esc(data.suggestion.reason)}）——${esc((data.suggestion.observations || [])[0] || '')}
                    <br>${esc(data.suggestion.notice || '')}
                    <br><button class="subtle-button" type="button" id="suggestExperienceButton" style="margin-top:8px;">生成优化建议经验（候选）</button>
                </div>`;
            }
            $('skillStatsBox').innerHTML = html;
            const button = $('suggestExperienceButton');
            if (button) button.addEventListener('click', () => createSuggestedExperience(skillId));
        } catch (error) {
            $('skillStatsBox').innerHTML = `<div class="publish-effects">${esc(error.message || '统计读取失败')}</div>`;
        }
    }

    async function createSuggestedExperience(skillId) {
        if (!window.confirm('根据低分评价生成一条候选经验？它只会进入「候选」状态，需要人工审核发布后才可能升级 Skill。')) return;
        try {
            const data = await api(`/api/design-brain/skills/${encodeURIComponent(skillId)}/suggest-experience`, {method: 'POST'});
            toast('已生成候选经验；请到「项目经验」中审核');
            await loadExperiences();
            switchTab('experiences');
        } catch (error) {
            toast(error.message || '生成失败', true);
        }
    }

    function fillCompareSelects() {
        const options = state.reviews.slice(0, 50).map(review => {
            const context = review.context || {};
            const label = `${new Date(Number(review.created_at || 0)).toLocaleString()} · ${(context.skill_name || context.skill_id || '无 Skill')} ${context.skill_version || ''} · ${starsText((review.user_feedback || {}).rating || 0)}`;
            return `<option value="${esc(review.id)}">${esc(label)}</option>`;
        }).join('');
        $('compareA').innerHTML = options;
        $('compareB').innerHTML = options;
    }

    async function runComparison() {
        const a = $('compareA').value, b = $('compareB').value;
        if (!a || !b || a === b) { $('compareVerdict').textContent = '请选择两条不同的评价。'; return; }
        try {
            const data = await api(`/api/design-brain/reviews/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
            const comparison = data.comparison || {};
            if (comparison.comparable) {
                $('compareVerdict').innerHTML = `<b style="color:#25764f;">可比 ✓</b>：生成条件一致（同模型/平台/参考图/尺寸/质量）。${esc(comparison.left.skill_version || '?')} 星 ${(comparison.left.rating || 0)} vs ${esc(comparison.right.skill_version || '?')} 星 ${(comparison.right.rating || 0)}；只有这种对比才可作为 Skill 升级效果的依据。`;
            } else {
                const fields = (comparison.differences || []).map(field => COMPARE_FIELD_LABELS[field] || field).join('、');
                $('compareVerdict').innerHTML = `<b style="color:#a24a44;">不可比 ✗</b>：以下生成条件不同——${esc(fields)}。结果差异可能来自这些条件，不能据此判断 Skill 升级效果。`;
            }
        } catch (error) {
            $('compareVerdict').textContent = error.message || '比较失败';
        }
    }

    async function exportData() {
        try {
            const response = await fetch('/api/design-brain/export');
            if (!response.ok) throw new Error('导出失败');
            const blob = await response.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `design-brain-export-${Date.now()}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
            $('dataStatus').textContent = '已导出 JSON 快照（仅保存在本机下载目录）';
        } catch (error) {
            $('dataStatus').textContent = error.message || '导出失败';
        }
    }

    async function deleteData() {
        const scope = $('deleteScopeSelect').value;
        const confirmText = ($('deleteConfirmInput').value || '').trim();
        if (confirmText !== '删除') { $('dataStatus').textContent = '请先输入「删除」两个字'; return; }
        if (!window.confirm(`确认删除「${$('deleteScopeSelect').selectedOptions[0].textContent}」？该操作不可恢复。`)) return;
        try {
            const data = await api('/api/design-brain/data/delete', {method: 'POST', body: {scope, confirm: confirmText}});
            $('dataStatus').textContent = `已删除：${(data.cleared || []).join('、')}。${data.note || ''}`;
            $('deleteConfirmInput').value = '';
            await Promise.all([loadProfile(), loadExperiences(), loadSkills(), loadRuns(), loadReviews(), loadCases()]);
            renderProfile();
        } catch (error) {
            $('dataStatus').textContent = error.message || '删除失败';
        }
    }

    /* ---------------- 参考素材库（参考素材阶段） ---------------- */

    const REF_ANALYSIS_FIELDS = [
        {key: 'purpose', label: '设计用途'},
        {key: 'composition', label: '构图'},
        {key: 'material', label: '材质'},
        {key: 'lighting', label: '光线'},
        {key: 'takeaways', label: '可借鉴点'},
        {key: 'restrictions', label: '使用限制'},
    ];
    const REF_ANALYSIS_LABELS = {none: '未分析', pending: '分析中', ready: '已分析', failed: '分析失败'};
    const REF_DIMENSIONS = [
        {key: 'category', label: '品类'},
        {key: 'purpose', label: '设计用途'},
        {key: 'expression', label: '视觉表达'},
    ];
    const REF_IMPORT_CHUNK = 8;
    const REFERENCE_ANALYSIS_SYSTEM = [
        '你是电商视觉参考图设计分析助手。用户会提供一张设计参考图。',
        '请只依据图片可见内容分析，不要编造画面里没有的信息；用中文回答，每项不超过 120 字。',
        '只输出 JSON，不要输出任何其他文字，格式：',
        '{"purpose":"这张图适合的设计用途","composition":"构图与画面结构","material":"材质与质感表现","lighting":"光线与影调","takeaways":"可借鉴的点","restrictions":"直接套用的限制或注意事项","suggested":{"category":"品类","purpose":"设计用途","expression":"视觉表达","tags":["最多6个短标签"]}}',
        'suggested 的取值尽量从下列预设中选择，没有合适的才写自定义短词：',
        '品类：家居、相框、电子产品、服饰、箱包、美妆、食品、饮料、珠宝配饰、母婴玩具、文具礼品、其他',
        '设计用途：主图、详情页、Banner、场景图、白底图、海报、封面、其他',
        '视觉表达：材质表现、创意展示、场景氛围、极简留白、撞色对比、叙事插画、写实摄影、其他',
    ].join('\n');

    const capFirst = (text) => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);

    function refImageUrl(id, variant) {
        return `/api/design-brain/references/${encodeURIComponent(id)}/image?variant=${variant === 'original' ? 'original' : 'thumb'}`;
    }

    function findReference(id) {
        return state.references.find((item) => item.id === id) || null;
    }

    function applyRefToState(item) {
        if (!item || !item.id) return;
        const index = state.references.findIndex((entry) => entry.id === item.id);
        if (index >= 0) state.references[index] = item;
    }

    async function loadReferences() {
        $('refCount').textContent = '正在读取参考素材…';
        const params = new URLSearchParams({limit: '200'});
        const filters = state.refFilters;
        if (filters.q.trim()) params.set('q', filters.q.trim());
        for (const key of ['category', 'purpose', 'expression', 'analysis']) {
            if (filters[key]) params.set(key, filters[key]);
        }
        if (filters.favorite) params.set('favorite', 'true');
        try {
            const data = await api(`/api/design-brain/references?${params.toString()}`);
            state.references = data.items || [];
            state.refTotal = data.total || 0;
            state.refFacets = data.facets || null;
            if (data.presets) state.refPresets = data.presets;
            for (const id of [...state.refSelection]) {
                if (!findReference(id)) state.refSelection.delete(id);
            }
            renderRefFilters();
            renderReferences();
        } catch (error) {
            state.references = [];
            renderReferences();
            $('refCount').textContent = error.message || '参考素材读取失败';
        }
    }

    function refDimensionValues(dimension) {
        const preset = state.refPresets[dimension] || [];
        const facet = (state.refFacets || {})[dimension] || {};
        return [...new Set([...preset, ...Object.keys(facet)])];
    }

    function renderRefFilters() {
        for (const dim of REF_DIMENSIONS) {
            const select = $(`ref${capFirst(dim.key)}Filter`);
            const datalist = $(`ref${capFirst(dim.key)}Options`);
            const values = refDimensionValues(dim.key);
            const current = state.refFilters[dim.key];
            if (select) {
                select.innerHTML = `<option value="">全部${esc(dim.label)}</option>` +
                    values.map((value) => `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(value)}</option>`).join('');
            }
            if (datalist) datalist.innerHTML = values.map((value) => `<option value="${esc(value)}"></option>`).join('');
        }
        $('refAnalysisFilter').value = state.refFilters.analysis;
        $('refFavoriteFilter').checked = state.refFilters.favorite;
    }

    function refAnalysisBadge(item) {
        const status = ((item.analysis || {}).status) || 'none';
        return `<span class="analysis-badge analysis-${esc(status)}">${REF_ANALYSIS_LABELS[status] || status}</span>`;
    }

    function updateRefAnalyzeButton() {
        const counts = (state.refFacets || {}).analysis || {};
        const pending = (counts.none || 0) + (counts.failed || 0);
        $('refAnalyzeButton').textContent = pending ? `AI 分析未分析（${pending}）` : 'AI 分析未分析';
    }

    function updateRefBatchBar() {
        const bar = $('refBatchBar');
        const count = state.refSelection.size;
        bar.hidden = !count;
        if (count) $('refBatchCount').textContent = `已选 ${count} 张`;
    }

    function renderReferences() {
        updateRefAnalyzeButton();
        updateRefBatchBar();
        const items = state.references;
        const counts = (state.refFacets || {}).analysis || {};
        $('refCount').textContent = `${state.refTotal} 张参考图 · 已分析 ${counts.ready || 0} · 未分析 ${counts.none || 0} · 失败 ${counts.failed || 0}`;
        if (!items.length) {
            $('refGrid').innerHTML = '<div class="empty"><strong>还没有参考素材</strong><span>用上方「导入图片 / 导入文件夹」批量导入本地参考图。图片保存在本机运行数据目录，不进入图片空间，删除素材库或历史不会影响这里。</span></div>';
            return;
        }
        $('refGrid').innerHTML = items.map((item) => {
            const cls = item.classification || {};
            const badges = [cls.category, cls.purpose, cls.expression].filter(Boolean)
                .map((value) => `<span>${esc(value)}</span>`).join('');
            const folder = (item.source || {}).folder || (item.file || {}).name || '';
            return `<article class="ref-card${state.refSelection.has(item.id) ? ' selected' : ''}" data-ref-id="${esc(item.id)}">
                <label class="ref-check"><input type="checkbox" data-ref-check="${esc(item.id)}"${state.refSelection.has(item.id) ? ' checked' : ''} aria-label="选择 ${esc(item.title)}"></label>
                <button class="cover-button" type="button" data-open-ref="${esc(item.id)}" aria-label="查看 ${esc(item.title)}"><img src="${esc(refImageUrl(item.id, 'thumb'))}" alt="" loading="lazy"></button>
                <button class="favorite-button${item.favorite ? ' on' : ''}" type="button" data-ref-favorite="${esc(item.id)}" aria-label="收藏">${item.favorite ? '★' : '☆'}</button>
                <div class="case-info">
                    <h3 class="case-title">${esc(item.title)}</h3>
                    <p class="case-sub">${esc(folder)}</p>
                    <div class="case-tags">${badges}${refAnalysisBadge(item)}</div>
                </div></article>`;
        }).join('');
    }

    function openRefDetail(id) {
        const item = findReference(id);
        if (!item) return;
        state.currentRefId = id;
        renderRefDetail(item);
        $('referenceOverlay').hidden = false;
    }

    function renderRefDetail(item) {
        const analysis = item.analysis || {};
        const content = analysis.content || {};
        const suggested = analysis.suggested || {};
        const file = item.file || {};
        const source = item.source || {};
        const dims = [file.width, file.height].filter(Boolean).join('×');
        const size = file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : '';
        const metaText = [source.folder ? `来源目录：${source.folder}` : '', file.name, dims, size].filter(Boolean).join(' · ');
        const dimInputs = REF_DIMENSIONS.map((dim) => `<div class="form-field">
            <label for="refDetail_${esc(dim.key)}">${esc(dim.label)}</label>
            <input id="refDetail_${esc(dim.key)}" class="inline-input wide-input" list="ref${capFirst(dim.key)}Options" data-ref-dim="${esc(dim.key)}" value="${esc((item.classification || {})[dim.key] || '')}" placeholder="选择预设或输入自定义值"></div>`).join('');
        const suggestedText = [suggested.category, suggested.purpose, suggested.expression].filter(Boolean).join(' / ');
        const suggestedTags = (suggested.tags || []).join('、');
        const analysisMeta = analysis.status === 'ready'
            ? `由 ${analysis.provider || '平台'} · ${analysis.model || '模型'} 分析${analysis.edited ? '，内容经人工修改' : ''}`
            : analysis.status === 'failed' ? `上次分析失败：${analysis.error || '未知原因'}`
            : analysis.status === 'pending' ? '分析进行中…' : '尚未分析；点击上方「AI 分析这张」生成。';
        $('referenceBody').innerHTML = `
            <h2 id="referenceTitle">${esc(item.title)}</h2>
            <p class="muted">${esc(metaText)}</p>
            <img class="ref-preview" src="${esc(refImageUrl(item.id, 'original'))}" alt="${esc(item.title)}">
            <div class="detail-actions">
                <button class="primary-button" type="button" data-ref-action="save">保存修改</button>
                <button class="subtle-button" type="button" data-ref-action="analyze">${analysis.status === 'ready' ? '重新分析这张' : 'AI 分析这张'}</button>
                <button class="subtle-button danger" type="button" data-ref-action="delete">删除</button>
            </div>
            <div class="detail-section"><h3>分类（品类 / 设计用途 / 视觉表达）</h3>
                <div class="form-grid">${dimInputs}
                    <div class="form-field"><label for="refDetailTags">标签</label>
                        <input id="refDetailTags" class="inline-input wide-input" value="${esc(((item.classification || {}).tags || []).join(', '))}" placeholder="用逗号分隔，用于检索"></div>
                </div>
                ${(suggestedText || suggestedTags) ? `<div class="publish-effects">AI 建议分类：${esc(suggestedText)}${suggestedTags ? ` · 标签 ${esc(suggestedTags)}` : ''} <button class="link-button" type="button" data-ref-action="apply-suggested">采用建议</button><span class="muted">（只填入表单，保存后生效）</span></div>` : ''}
            </div>
            <div class="detail-section"><h3>AI 设计分析${analysis.edited ? '（已人工修改）' : ''}</h3>
                <p class="muted">${esc(analysisMeta)}</p>
                <div class="analysis-grid">
                    ${REF_ANALYSIS_FIELDS.map((field) => `<div class="${field.key === 'takeaways' || field.key === 'restrictions' ? 'full' : ''}">
                        <label for="refAnalysis_${esc(field.key)}">${esc(field.label)}</label>
                        <textarea id="refAnalysis_${esc(field.key)}" class="inline-input" data-ref-analysis="${esc(field.key)}">${esc(content[field.key] || '')}</textarea></div>`).join('')}
                </div>
                <div class="picker-bar"><button class="subtle-button" type="button" data-ref-action="save-analysis">只保存分析内容</button></div>
            </div>
            <div class="detail-section"><h3>备注（可保存原始链接、授权信息等）</h3>
                <textarea id="refNotes" class="inline-input wide-input" style="min-height:80px">${esc(item.notes || '')}</textarea>
            </div>`;
    }

    async function toggleRefFavorite(id) {
        const item = findReference(id);
        if (!item) return;
        try {
            const data = await api(`/api/design-brain/references/${encodeURIComponent(id)}`, {method: 'PATCH', body: {favorite: !item.favorite}});
            applyRefToState(data.reference);
            renderReferences();
            if (!$('referenceOverlay').hidden && state.currentRefId === id) renderRefDetail(data.reference);
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    async function saveRefDetail() {
        const item = findReference(state.currentRefId);
        if (!item) return;
        const classification = {};
        for (const dim of REF_DIMENSIONS) {
            const input = document.querySelector(`[data-ref-dim="${dim.key}"]`);
            classification[dim.key] = (input && input.value || '').trim();
        }
        classification.tags = ($('refDetailTags').value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        try {
            const data = await api(`/api/design-brain/references/${encodeURIComponent(item.id)}`, {method: 'PATCH', body: {classification, notes: $('refNotes').value || ''}});
            applyRefToState(data.reference);
            renderReferences();
            toast('已保存');
        } catch (error) {
            toast(error.message || '保存失败', true);
        }
    }

    async function saveRefAnalysisEdits() {
        const item = findReference(state.currentRefId);
        if (!item) return;
        const content = {};
        document.querySelectorAll('[data-ref-analysis]').forEach((node) => { content[node.dataset.refAnalysis] = node.value; });
        try {
            const data = await api(`/api/design-brain/references/${encodeURIComponent(item.id)}/analysis`, {method: 'PATCH', body: {content}});
            applyRefToState(data.reference);
            renderReferences();
            toast('已保存分析修改');
        } catch (error) {
            toast(error.message || '保存失败', true);
        }
    }

    function applySuggestedToForm() {
        const item = findReference(state.currentRefId);
        if (!item) return;
        const suggested = (item.analysis || {}).suggested || {};
        for (const dim of REF_DIMENSIONS) {
            const input = document.querySelector(`[data-ref-dim="${dim.key}"]`);
            const value = (suggested[dim.key] || '').trim();
            if (input && value) input.value = value;
        }
        if ((suggested.tags || []).length) {
            const tagsInput = $('refDetailTags');
            const merged = [...new Set([...(tagsInput.value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), ...suggested.tags])];
            tagsInput.value = merged.join(', ');
        }
        toast('已填入建议分类，保存后生效');
    }

    async function deleteRefItem(id) {
        if (!window.confirm('删除这张参考素材？会连同本机保存的原图与缩略图一起删除。')) return;
        try {
            await api(`/api/design-brain/references/${encodeURIComponent(id)}`, {method: 'DELETE'});
            state.references = state.references.filter((item) => item.id !== id);
            state.refSelection.delete(id);
            $('referenceOverlay').hidden = true;
            await loadReferences();
            toast('已删除');
        } catch (error) {
            toast(error.message || '删除失败', true);
        }
    }

    /* ----- 本地批量导入（进度、去重结果、失败重试） ----- */

    function refAcceptFiles(fileList) {
        const entries = [];
        for (const file of Array.from(fileList || [])) {
            const name = file.name || '';
            entries.push({file, name, path: String(file.webkitRelativePath || name).replace(/\\/g, '/')});
        }
        if (!entries.length) return;
        const supported = entries.filter((entry) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(entry.name));
        const skipped = entries.length - supported.length;
        if (!supported.length) {
            toast('没有可导入的图片（支持 jpg / png / webp / gif / bmp）', true);
            return;
        }
        state.refImport = {queue: supported, total: supported.length, done: 0, imported: 0, duplicates: 0, failed: [], running: false};
        $('refImportProgress').hidden = false;
        updateRefImportProgress(skipped ? `已跳过 ${skipped} 个不支持的文件类型` : '');
        runRefImport();
    }

    async function runRefImport() {
        const job = state.refImport;
        if (!job || job.running) return;
        job.running = true;
        while (job.queue.length) {
            const batch = job.queue.splice(0, REF_IMPORT_CHUNK);
            const form = new FormData();
            const metas = [];
            for (const entry of batch) {
                form.append('files', entry.file, entry.name);
                metas.push({name: entry.name, path: entry.path});
            }
            form.append('meta', JSON.stringify(metas));
            try {
                const response = await fetch('/api/design-brain/references/import', {method: 'POST', body: form});
                let data = null;
                try { data = await response.json(); } catch (error) { data = null; }
                if (!response.ok || !data) throw new Error((data && data.detail) || `导入失败（${response.status}）`);
                for (const result of data.results || []) {
                    job.done += 1;
                    if (result.status === 'imported') job.imported += 1;
                    else if (result.status === 'duplicate') job.duplicates += 1;
                    else job.failed.push({name: result.name || '未命名文件', error: result.error || '导入失败'});
                }
            } catch (error) {
                // 整批请求失败（网络/服务错误）：全部记为失败；文件对象仍在，
                // 会话内可一键重试（刷新页面后需重新选择文件）。
                for (const entry of batch) {
                    job.done += 1;
                    job.failed.push({name: entry.name, error: error.message || '导入失败', entry});
                }
            }
            updateRefImportProgress();
        }
        job.running = false;
        updateRefImportProgress();
        $('refStatus').textContent = `导入完成：新增 ${job.imported}，重复 ${job.duplicates}，失败 ${job.failed.length}`;
        await loadReferences();
    }

    function retryFailedImports() {
        const job = state.refImport;
        if (!job || job.running) return;
        const entries = job.failed.map((failure) => failure.entry).filter(Boolean);
        if (!entries.length) {
            toast('失败文件已不可用（页面刷新后需重新选择文件导入）', true);
            return;
        }
        state.refImport = {queue: entries, total: entries.length, done: 0, imported: 0, duplicates: 0, failed: [], running: false};
        updateRefImportProgress('重试失败项');
        runRefImport();
    }

    function updateRefImportProgress(prefix) {
        const job = state.refImport;
        if (!job) return;
        const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
        $('refImportBar').style.width = `${percent}%`;
        $('refImportCount').textContent = `${job.done}/${job.total}`;
        const parts = [`已导入 ${job.imported}`];
        if (job.duplicates) parts.push(`重复跳过 ${job.duplicates}`);
        if (job.failed.length) parts.push(`失败 ${job.failed.length}`);
        if (!job.running && job.done >= job.total) parts.push('完成');
        $('refImportSummary').textContent = `${prefix ? `${prefix}；` : ''}${parts.join(' · ')}`;
        $('refImportFailures').innerHTML = job.failed.map((failure) =>
            `<div class="import-failure-row"><span class="if-name">${esc(failure.name)}</span><span class="if-error">${esc(failure.error)}</span></div>`).join('') +
            ((job.failed.length && !job.running) ? `<div class="picker-bar"><button class="subtle-button" type="button" id="refRetryImports">重试失败项</button></div>` : '');
        const retry = $('refRetryImports');
        if (retry) retry.addEventListener('click', retryFailedImports);
    }

    /* ----- AI 设计分析（隐私开关 + 逐张确认发送 + 失败记录） ----- */

    async function setupRefAnalysisBar() {
        const providerSelect = $('refProvider');
        const modelSelect = $('refModel');
        const providers = await ensureProviders();
        const rememberedProvider = localStorage.getItem('design-brain-ref-provider') || '';
        providerSelect.innerHTML = providers.map((provider) =>
            `<option value="${esc(provider.id)}"${provider.id === rememberedProvider ? ' selected' : ''}>${esc(provider.name || provider.id)}</option>`).join('') ||
            '<option value="">（未配置对话模型）</option>';
        const fillModels = () => {
            const provider = providers.find((item) => item.id === providerSelect.value);
            const rememberedModel = localStorage.getItem('design-brain-ref-model') || '';
            modelSelect.innerHTML = (provider ? provider.chat_models : []).map((model) =>
                `<option value="${esc(model)}"${model === rememberedModel ? ' selected' : ''}>${esc(model)}</option>`).join('') || '<option value="">（无模型）</option>';
        };
        providerSelect.onchange = () => {
            fillModels();
            localStorage.setItem('design-brain-ref-provider', providerSelect.value);
            localStorage.setItem('design-brain-ref-model', '');
        };
        modelSelect.onchange = () => localStorage.setItem('design-brain-ref-model', modelSelect.value);
        fillModels();
    }

    async function refAnalysisAllowed() {
        if (((state.profile || {}).privacy || {}).allow_reference_analysis === true) return true;
        toast('请先在「审美档案」中打开「允许 AI 设计分析」隐私开关', true);
        switchTab('profile');
        return false;
    }

    function pendingReferenceIds() {
        return state.references
            .filter((item) => ['none', 'failed'].includes(((item.analysis || {}).status) || 'none'))
            .map((item) => item.id);
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(blob);
        });
    }

    async function analyzeReferences(ids, options = {}) {
        if (state.refAnalysis && state.refAnalysis.running) {
            toast('已有分析任务在进行中', true);
            return;
        }
        if (!ids.length) { toast('没有需要分析的图片', true); return; }
        if (!(await refAnalysisAllowed())) return;
        const providerId = $('refProvider').value;
        const model = $('refModel').value;
        if (!providerId || !model) { toast('请先选择对话平台与模型', true); return; }
        const providerName = (($('refProvider').selectedOptions[0] || {}).textContent || providerId);
        if (!window.confirm(`将把 ${ids.length} 张参考图逐张发送给「${providerName}」的 ${model} 进行设计分析（图片会离开本机发送给你配置的 API 平台）。确认继续？`)) return;
        const job = state.refAnalysis = {ids: [...ids], total: ids.length, done: 0, ok: 0, failed: 0, running: true, cancel: false};
        $('refAnalysisProgress').hidden = false;
        for (const id of job.ids) {
            api(`/api/design-brain/references/${encodeURIComponent(id)}/analysis`, {method: 'POST', body: {status: 'pending'}}).catch(() => {});
        }
        updateRefAnalysisProgress();
        for (const id of [...job.ids]) {
            if (job.cancel) break;
            try {
                const blob = await fetch(refImageUrl(id, 'original')).then((response) => {
                    if (!response.ok) throw new Error('读取原图失败');
                    return response.blob();
                });
                const dataUrl = await blobToDataUrl(blob);
                const data = await api('/api/canvas-llm', {method: 'POST', body: {
                    message: '请分析这张电商设计参考图。',
                    system_prompt: REFERENCE_ANALYSIS_SYSTEM,
                    provider: providerId,
                    model,
                    images: [dataUrl],
                }});
                const parsed = parseDistillJson(data.text || '');
                if (!parsed || typeof parsed !== 'object') throw new Error('模型返回无法解析，请重试');
                const content = {};
                for (const field of REF_ANALYSIS_FIELDS) content[field.key] = String(parsed[field.key] || '').slice(0, 600);
                const suggestedRaw = (parsed.suggested && typeof parsed.suggested === 'object') ? parsed.suggested : {};
                const saved = await api(`/api/design-brain/references/${encodeURIComponent(id)}/analysis`, {method: 'POST', body: {
                    status: 'ready',
                    content,
                    suggested: {
                        category: String(suggestedRaw.category || '').slice(0, 24),
                        purpose: String(suggestedRaw.purpose || '').slice(0, 24),
                        expression: String(suggestedRaw.expression || '').slice(0, 24),
                        tags: Array.isArray(suggestedRaw.tags) ? suggestedRaw.tags.slice(0, 6).map((tag) => String(tag).slice(0, 24)) : [],
                    },
                    provider: providerId,
                    model,
                }});
                applyRefToState(saved.reference);
                job.ok += 1;
            } catch (error) {
                job.failed += 1;
                try {
                    const saved = await api(`/api/design-brain/references/${encodeURIComponent(id)}/analysis`, {method: 'POST', body: {
                        status: 'failed', error: String(error.message || '分析失败').slice(0, 300), provider: providerId, model,
                    }});
                    applyRefToState(saved.reference);
                } catch (writeError) {
                    // 回写失败状态失败时只计数，列表刷新后仍显示未分析。
                }
            }
            job.done += 1;
            updateRefAnalysisProgress();
        }
        job.running = false;
        updateRefAnalysisProgress();
        await loadReferences();
        if (options.fromDetail && state.currentRefId) {
            const item = findReference(state.currentRefId);
            if (item && !$('referenceOverlay').hidden) renderRefDetail(item);
        }
    }

    function updateRefAnalysisProgress() {
        const job = state.refAnalysis;
        if (!job) return;
        const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
        $('refAnalysisBar').style.width = `${percent}%`;
        $('refAnalysisCount').textContent = `${job.done}/${job.total}`;
        $('refAnalysisSummary').textContent = job.running
            ? `进行中：成功 ${job.ok} · 失败 ${job.failed} · 剩余 ${job.total - job.done}`
            : (job.cancel ? `已停止：成功 ${job.ok} · 失败 ${job.failed} · 未处理 ${job.total - job.done}`
                : `完成：成功 ${job.ok} · 失败 ${job.failed}。失败的图片会保留失败原因，可单独重试。`);
    }

    /* ----- 批量操作 ----- */

    async function applyRefClassify() {
        const ids = [...state.refSelection];
        if (!ids.length) return;
        const dims = {
            category: ($('refBatchCategory').value || '').trim(),
            purpose: ($('refBatchPurpose').value || '').trim(),
            expression: ($('refBatchExpression').value || '').trim(),
        };
        const extraTags = ($('refBatchTags').value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        const hasDims = Object.values(dims).some(Boolean);
        if (!hasDims && !extraTags.length) { toast('请至少填写一个分类维度或标签', true); return; }
        const button = $('refClassifyApply');
        button.disabled = true;
        try {
            if (extraTags.length) {
                // 追加标签需要与每张图原有标签合并，逐张更新避免覆盖。
                let updated = 0;
                for (const id of ids) {
                    const item = findReference(id);
                    if (!item) continue;
                    const classification = {};
                    for (const [key, value] of Object.entries(dims)) if (value) classification[key] = value;
                    classification.tags = [...new Set([...(((item.classification || {}).tags) || []), ...extraTags])].slice(0, 12);
                    await api(`/api/design-brain/references/${encodeURIComponent(id)}`, {method: 'PATCH', body: {classification}});
                    updated += 1;
                }
                toast(`已更新 ${updated} 张图片`);
            } else {
                const classification = {};
                for (const [key, value] of Object.entries(dims)) if (value) classification[key] = value;
                await api('/api/design-brain/references/batch-update', {method: 'POST', body: {ids, patch: {classification}}});
                toast(`已更新 ${ids.length} 张图片`);
            }
            $('refClassifyOverlay').hidden = true;
            await loadReferences();
        } catch (error) {
            toast(error.message || '批量分类失败', true);
        } finally {
            button.disabled = false;
        }
    }

    async function batchRefDelete() {
        const ids = [...state.refSelection];
        if (!ids.length) return;
        if (!window.confirm(`删除所选 ${ids.length} 张参考素材？会连同本机保存的原图与缩略图一起删除。`)) return;
        try {
            await api('/api/design-brain/references/batch-delete', {method: 'POST', body: {ids}});
            state.refSelection.clear();
            await loadReferences();
            toast('已删除所选参考素材');
        } catch (error) {
            toast(error.message || '删除失败', true);
        }
    }

    async function batchRefFavorite() {
        const ids = [...state.refSelection];
        if (!ids.length) return;
        try {
            await api('/api/design-brain/references/batch-update', {method: 'POST', body: {ids, patch: {favorite: true}}});
            await loadReferences();
            toast(`已收藏 ${ids.length} 张`);
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    /* ---------------- 设计任务与成果 ---------------- */

    const STUDIO_STATUS_LABELS = {
        intake: '理解需求', reference_analysis: '参考分析', planning: '制定方案',
        awaiting_confirmation: '等待确认', executing: '生成中', quality_check: '质量检查',
        revision: '自动修正', delivered: '已完成', failed: '失败', cancelled: '已取消',
    };
    const STUDIO_STATUS_CLASS = {
        intake: 'studio-badge-info', reference_analysis: 'studio-badge-info', planning: 'studio-badge-info',
        awaiting_confirmation: 'studio-badge-warn', executing: 'studio-badge-run', quality_check: 'studio-badge-run',
        revision: 'studio-badge-run', delivered: 'studio-badge-ok', failed: 'studio-badge-bad', cancelled: 'studio-badge-mute',
    };
    const STUDIO_WORKSPACE_TABS = [
        {key: 'overview', label: '任务概览'},
        {key: 'plan', label: '设计方案'},
        {key: 'references', label: '参考案例'},
        {key: 'results', label: '生成结果'},
        {key: 'reviews', label: '质量检查'},
        {key: 'events', label: '执行记录'},
    ];
    function studioState() {
        if (!state.studio) {
            state.studio = {
                tasks: [], currentId: '', current: null, taskQuery: '',
                pollTimer: null, pollBusy: false, listBusy: false, listTimer: null,
                shotEdits: {}, workspaceTab: 'overview',
                revisionSelection: new Set(),
                planDrafts: {}, pendingAction: null,
                deletingTasks: new Set(), listRevision: 0,
            };
        }
        return state.studio;
    }

    function studioTime(value) {
        const ts = Number(value) || 0;
        if (!ts) return '';
        const date = new Date(ts < 1e12 ? ts * 1000 : ts);
        const pad = (num) => String(num).padStart(2, '0');
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function loadStudioTasks() {
        const studio = studioState();
        if (studio.listBusy) return;
        studio.listBusy = true;
        const revision = studio.listRevision;
        let stale = false;
        const before = JSON.stringify(studio.tasks);
        try {
            const data = await api('/api/design-brain/bot/tasks?limit=100');
            if (revision !== studio.listRevision) return;
            studio.tasks = data.tasks || [];
        } catch (error) {
            stale = true;
        } finally {
            studio.listBusy = false;
        }
        if (before !== JSON.stringify(studio.tasks)) renderStudioTaskList();
        document.dispatchEvent(new CustomEvent('design-brain-task-snapshots', {detail: {tasks: studio.tasks, stale}}));
    }

    function selectStudioTask(taskId) {
        const studio = studioState();
        if (studio.deletingTasks.has(taskId)) return;
        setStudioView('workspace');
        studio.currentId = taskId || '';
        studio.current = null;
        studio.shotEdits = {};
        studio.revisionSelection = new Set();
        studio.workspaceTab = 'overview';
        stopStudioPolling();
        renderStudioAll();
        if (taskId) {
            pollStudioTask(true);
            startStudioPolling();
        }
    }

    function startStudioPolling() {
        const studio = studioState();
        stopStudioPolling();
        if (!studio.currentId) return;
        studio.pollTimer = setInterval(() => pollStudioTask(false), 1500);
    }

    function stopStudioPolling() {
        const studio = studioState();
        if (studio.pollTimer) clearInterval(studio.pollTimer);
        studio.pollTimer = null;
    }

    async function pollStudioTask(force) {
        const studio = studioState();
        if (!studio.currentId || (studio.pollBusy && !force)) return;
        const taskId = studio.currentId;
        studio.pollBusy = true;
        try {
            const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}`);
            if (taskId !== studio.currentId || studio.deletingTasks.has(taskId)) return;
            const task = data.task || null;
            if (!task) throw new Error('任务读取失败，请重试');
            const before = studio.current;
            studio.current = task;
            const index = studio.tasks.findIndex(item => item.id === task.id);
            if (index >= 0) studio.tasks[index] = task;
            document.dispatchEvent(new CustomEvent('design-brain-task-snapshots', {detail: {tasks: studio.tasks, stale: false}}));
            if (force || before?.status !== task.status) {
                if (task.status === 'awaiting_confirmation') studio.workspaceTab = 'plan';
                else if (task.status === 'delivered') studio.workspaceTab = 'results';
            }
            if (force || !before || before.updated_at !== task.updated_at || before.status !== task.status) {
                renderStudioAll();
            }
            if (['delivered', 'failed', 'cancelled', 'awaiting_confirmation'].includes(task.status)) {
                stopStudioPolling();
                await loadStudioTasks();
            }
        } catch (error) {
            if (force && taskId === studio.currentId) {
                $('studioWorkspaceBody').textContent = `${error.message || '任务读取失败'}；请点击左侧任务重试。`;
                toast(error.message || '任务读取失败', true);
            }
        } finally {
            studio.pollBusy = false;
        }
    }

    function studioCurrent() {
        const studio = studioState();
        return studio.tasks.find((task) => task.id === studio.currentId) || null;
    }

    function renderStudioAll() {
        const studio = studioState();
        const task = studio.current || studioCurrent();
        if (task && task.id === studio.currentId) studio.current = task;
        renderStudioTaskList();
        renderStudioWorkspaceHead(task);
        renderStudioWorkspace(task);
        renderStudioStepper(task);
        renderStudioWorkspaceFoot(task);
        window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
    }

    const STUDIO_TASK_GROUPS = [
        {label: '进行中', match: (status) => !['delivered', 'failed', 'cancelled'].includes(status)},
        {label: '已完成', match: (status) => status === 'delivered'},
        {label: '已结束', match: (status) => ['failed', 'cancelled'].includes(status)},
    ];

    function renderStudioTaskList() {
        const studio = studioState();
        $('dbStudioNav').classList.toggle('is-empty', !studio.tasks.length);
        const count = $('studioTaskCount');
        if (count) count.textContent = `${studio.tasks.length} 个`;
        if (!studio.tasks.length) {
            $('studioTaskList').innerHTML = '<p class="muted studio-task-empty">还没有任务。在对话里描述设计需求即可开始。</p>';
            return;
        }
        const query = (studio.taskQuery || '').trim().toLowerCase();
        const matched = query
            ? studio.tasks.filter((task) => `${task.title || ''}`.toLowerCase().includes(query))
            : studio.tasks;
        const html = STUDIO_TASK_GROUPS.map((group) => {
            const tasks = matched.filter((task) => group.match(task.status));
            if (!tasks.length) return '';
            return `<div class="studio-task-group">${group.label}</div>` + tasks.map((task) => `
                <div class="studio-task-row">
                <button class="studio-task-item${task.id === studio.currentId ? ' active' : ''}" type="button" data-studio-task="${esc(task.id)}"${studio.deletingTasks.has(task.id) ? ' disabled' : ''}>
                    <span class="studio-task-title">${esc(task.title || '设计任务')}</span>
                    <span class="studio-task-meta">
                        <span class="studio-status-badge ${STUDIO_STATUS_CLASS[task.status] || ''}">${esc(STUDIO_STATUS_LABELS[task.status] || task.status)}</span>
                        <span class="studio-task-time">${esc(studioTime(task.updated_at))}</span>
                    </span>
                    ${window.DesignBrainProgress.markup(task)}
                </button>
                <button class="studio-task-delete" type="button" data-studio-delete="${esc(task.id)}" aria-label="删除任务：${esc(task.title || '设计任务')}"${studio.deletingTasks.has(task.id) ? ' disabled' : ''}>${studio.deletingTasks.has(task.id) ? '删除中…' : '删除'}</button>
                </div>`).join('');
        }).join('');
        $('studioTaskList').innerHTML = html || '<p class="muted studio-task-empty">没有匹配的任务。</p>';
    }

    async function deleteStudioTask(taskId) {
        const studio = studioState();
        const task = studio.tasks.find(item => item.id === taskId);
        if (!task || studio.deletingTasks.has(taskId)) return;
        if (studio.pendingAction?.taskId === taskId) {
            toast('任务正在提交操作，请稍后再删除', true);
            return;
        }
        const active = !['delivered', 'failed', 'cancelled'].includes(task.status);
        if (!window.confirm(`删除任务「${task.title || '设计任务'}」？${active ? '会先停止此任务。' : ''}任务记录删除后无法恢复，已生成的图片和历史记录会保留。`)) return;
        studio.deletingTasks.add(taskId);
        renderStudioTaskList();
        try {
            await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}`, {method: 'DELETE'});
            studio.listRevision += 1;
            studio.tasks = studio.tasks.filter(item => item.id !== taskId);
            delete studio.planDrafts[taskId];
            if (studio.currentId === taskId) {
                stopStudioPolling();
                studio.currentId = '';
                studio.current = null;
                studio.shotEdits = {};
                studio.revisionSelection.clear();
                setStudioView('chat');
                renderStudioAll();
            } else {
                renderStudioTaskList();
            }
            document.dispatchEvent(new CustomEvent('design-brain-task-snapshots', {detail: {tasks: studio.tasks, stale: false}}));
            toast('任务已删除');
        } catch (error) {
            toast(`删除任务失败：${error.message || '请重试'}`, true);
        } finally {
            studio.deletingTasks.delete(taskId);
            renderStudioTaskList();
        }
    }

    function renderStudioWorkspaceHead(task) {
        if (!task) {
            $('studioTaskTitle').textContent = '方案与成图';
            $('studioTaskStatus').innerHTML = '';
            return;
        }
        $('studioTaskTitle').textContent = task.title || '设计任务';
        $('studioTaskStatus').innerHTML = `<span class="studio-status-badge ${STUDIO_STATUS_CLASS[task.status] || ''}">${esc(STUDIO_STATUS_LABELS[task.status] || task.status)}</span>`;
    }

    const STUDIO_ADJUSTMENT_OPTIONS = [
        {label: '突出商品主体', feedback: '优化主体占比和视觉层次，减少干扰元素，保留已锁定的构图与商品约束。'},
        {label: '简化背景', feedback: '简化背景与道具，保持系列视觉统一，不改变已锁定的场景要求。'},
        {label: '加强材质细节', feedback: '加强商品真实材质、边缘与厚度的表现，保持商品结构、颜色和比例。'},
        {label: '优化光线层次', feedback: '优化光线与阴影层次，使主体细节更清晰，保留已确定的整体色调。'},
    ];

    function studioPlanDraft(task) {
        const studio = studioState();
        return studio.planDrafts[task.id] ||= {open: false, selected: new Set(), directionId: '', text: '', error: ''};
    }

    function studioAdjustmentOptions(task) {
        const options = (task.plan?.adjustment_options || []).filter(option => option?.label && option?.feedback).slice(0, 6);
        return options.length ? options : STUDIO_ADJUSTMENT_OPTIONS;
    }

    // 操作栏固定在工作区底部，方案再长也不用滚回顶部找确认按钮。
    function renderStudioWorkspaceFoot(task) {
        const foot = $('studioTaskActions');
        if (!task) {
            foot.innerHTML = '';
            return;
        }
        const actions = [];
        if (task.status === 'awaiting_confirmation') {
            const draft = studioPlanDraft(task);
            const options = studioAdjustmentOptions(task);
            const busy = studioState().pendingAction?.taskId === task.id;
            const hasFeedback = draft.selected.size || draft.text.trim();
            const directionChoice = task.design?.confirmation === 'direction';
            const batchChoice = task.design?.confirmation === 'batch';
            foot.innerHTML = `<div class="studio-plan-actions">
                ${directionChoice ? `<p class="muted">先选择一个设计方向。选择后会继续生成该方向的具体分镜，不会开始生图。</p>` : ''}
                ${batchChoice ? `<p class="muted">代表性样图已审核通过。确认后才会继续批量生成剩余分镜。</p>` : ''}
                <div id="studioPlanFeedback" class="studio-plan-feedback" ${draft.open ? '' : 'hidden'}>
                    <strong>${task.plan?.adjustment_options?.length ? '设计规划 Bot · 建议调整方向' : '选择调整方向'}</strong>
                    <p class="muted">可多选，选好后直接提交。重新规划后仍需确认才会生图。</p>
                    <div class="studio-adjustment-options">${options.map((option, index) => `<button type="button" class="studio-adjustment-option" data-studio-adjustment="${index}" aria-pressed="${draft.selected.has(option.feedback)}" ${busy ? 'disabled' : ''}><strong>${esc(option.label)}</strong><span>${esc(option.feedback)}</span></button>`).join('')}</div>
                    <label for="studioActionInput">补充说明（选填）</label>
                    <textarea id="studioActionInput" rows="3" maxlength="1200" placeholder="例如：第 3 张保留暖色光，其他图的背景再简洁一些" ${busy ? 'disabled' : ''}>${esc(draft.text)}</textarea>
                </div>
                <div class="studio-action-row">
                    <button class="primary-button" type="button" data-studio-action="confirm" ${busy ? 'disabled' : ''}>${busy && studioState().pendingAction.action === 'confirm' ? '正在提交…' : directionChoice ? '选择方向并继续' : batchChoice ? '确认批量生成' : '确认方案并生成'}</button>
                    <button class="subtle-button" type="button" data-studio-feedback-toggle aria-expanded="${draft.open}" aria-controls="studioPlanFeedback" ${busy ? 'disabled' : ''}>${draft.open ? '收起调整选项' : '选择调整方向'}</button>
                    ${draft.open ? `<button class="subtle-button" type="button" data-studio-action="replan" ${busy ? 'disabled' : ''}>${busy && studioState().pendingAction.action === 'replan' ? '正在提交调整…' : '按所选项重新规划'}</button>` : ''}
                    <button class="subtle-button" type="button" data-studio-action="cancel" ${busy ? 'disabled' : ''}>取消</button>
                </div>
                <p id="studioActionStatus" class="${draft.error ? 'studio-error-text' : 'muted'}" role="${draft.error ? 'alert' : 'status'}">${esc(draft.error || (hasFeedback ? '已填写调整意见，请先重新规划，避免直接生成原方案。' : ''))}</p>
            </div>`;
            return;
        } else if (task.status === 'delivered') {
            actions.push(`<select id="studioFeedbackRating" class="inline-input" aria-label="评分"><option value="5">满意 5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">不满意 1</option></select>`);
            actions.push(`<input id="studioFeedbackComment" class="inline-input" type="text" placeholder="反馈（可留空）">`);
            actions.push(`<button class="subtle-button" type="button" data-studio-action="feedback">提交反馈</button>`);
            actions.push(`<input id="studioReviseFeedback" class="inline-input" type="text" placeholder="修改意见，例如：木纹再明显一点">`);
            actions.push(`<button class="subtle-button" type="button" data-studio-action="revise">按方案重新生成</button>`);
            actions.push(`<button class="subtle-button" type="button" data-studio-action="revise_local">局部修改并保留原图</button>`);
            if (task.brief?.task_type === 'detail_images') {
                actions.push(`<input id="studioAppendCount" class="inline-input" style="width:90px" type="number" min="1" step="1" value="1" aria-label="追加屏数">`);
                actions.push(`<button class="subtle-button" type="button" data-studio-action="append">继续加屏</button>`);
            }
        } else if (task.status === 'failed') {
            actions.push(`<button class="primary-button" type="button" data-studio-action="resume">重试失败阶段</button>`);
            actions.push(`<button class="subtle-button" type="button" data-studio-action="cancel">取消</button>`);
        } else if (!['delivered', 'cancelled'].includes(task.status)) {
            actions.push(`<button class="subtle-button" type="button" data-studio-action="cancel">取消任务</button>`);
        }
        if (task.error) actions.push(`<span class="studio-error-text" title="${esc(task.error)}">${esc(task.error.slice(0, 60))}</span>`);
        foot.innerHTML = actions.join('');
    }

    const STUDIO_PHASE_STEPS = ['参考分析', '设计规划', '生成执行', '质量检查'];
    // 各状态对应的 stepper 形态：done=已完成的步数，now=当前步（-1 表示没有进行中的步）。
    const STUDIO_PHASE_STATE = {
        intake: {done: 0, now: 0}, reference_analysis: {done: 0, now: 0},
        planning: {done: 1, now: 1}, awaiting_confirmation: {done: 2, now: -1},
        executing: {done: 2, now: 2}, revision: {done: 2, now: 2},
        quality_check: {done: 3, now: 3}, delivered: {done: 4, now: -1},
    };

    function renderStudioStepper(task) {
        const box = $('studioStepper');
        if (!box) return;
        const shape = task ? STUDIO_PHASE_STATE[task.status] : null;
        if (!shape) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        box.innerHTML = STUDIO_PHASE_STEPS.map((label, index) => {
            const cls = index < shape.done ? 'done' : (index === shape.now ? 'now' : '');
            const mark = index < shape.done ? '✓' : index + 1;
            const arrow = index < STUDIO_PHASE_STEPS.length - 1 ? '<em></em>' : '';
            return `<span class="studio-step ${cls}"><i>${mark}</i>${label}</span>${arrow}`;
        }).join('');
    }

    function renderStudioWorkspace(task) {
        const studio = studioState();
        $('studioWorkspaceTabs').innerHTML = STUDIO_WORKSPACE_TABS.map((tab) =>
            `<button class="${studio.workspaceTab === tab.key ? 'active' : ''}" type="button" data-studio-tab="${tab.key}">${tab.label}</button>`).join('');
        const body = $('studioWorkspaceBody');
        if (!task) {
            body.innerHTML = '<p class="muted">在讨论里告诉团队你的需求。建立任务后，在这里确认方案、查看进度和成图；已有任务可从左侧打开。</p>';
            return;
        }
        if (studio.workspaceTab === 'overview') body.innerHTML = studioOverviewHtml(task);
        else if (studio.workspaceTab === 'plan') body.innerHTML = studioPlanHtml(task);
        else if (studio.workspaceTab === 'references') body.innerHTML = studioReferencesHtml(task);
        else if (studio.workspaceTab === 'results') body.innerHTML = studioResultsHtml(task);
        else if (studio.workspaceTab === 'reviews') body.innerHTML = studioReviewsHtml(task);
        else body.innerHTML = studioEventsHtml(task);
    }

    function studioOverviewHtml(task) {
        const brief = task.brief || {};
        const product = brief.product || {};
        const plan = task.plan || {};
        const rows = (items) => items.length ? `<ul>${items.map((item) => `<li>${esc(typeof item === 'string' ? item : (item.text || ''))}</li>`).join('')}</ul>` : '<span class="muted">无</span>';
        return `<div class="studio-cards">
            <div class="studio-card"><h4>任务目标</h4><p>${esc(brief.goal || '—')}</p>
                ${task.skill?.skill_id ? `<p class="muted">使用技能：${esc(task.skill.name || task.skill.skill_id)}${task.skill.version ? ` · v${esc(task.skill.version)}` : ''}（${esc(task.skill.selection_reason || '任务关联')}）</p>` : ''}
                ${brief.style_direction ? `<p class="muted">视觉方向：${esc(brief.style_direction)}</p>` : ''}
                ${(brief.adjustments || []).length ? `<p class="muted">历次调整：</p>${rows(brief.adjustments)}` : ''}
                ${(task.design?.experience_context || []).length ? `<p class="card-sub">采用的个人经验（参考）</p>${rows(task.design.experience_context)}` : ''}</div>
            <div class="studio-card"><h4>商品信息</h4>
                <p>${esc(product.name || '未命名商品')}${product.category ? `（${esc(product.category)}）` : ''}</p>
                <p class="card-sub">卖点特征</p>${rows(product.features || [])}
                <p class="card-sub">结构/文案约束（不可违反）</p>${rows(product.constraints || [])}</div>
            <div class="studio-card"><h4>交付物</h4>${rows(brief.deliverables || [])}
                ${brief.image_count ? `<p class="muted">目标 ${esc(brief.image_count)} 张${brief.resolution ? ` · 画质 ${esc(brief.resolution.toUpperCase())}` : ''}</p>` : ''}
                <p class="card-sub">商品图</p>
                <div class="studio-thumb-row">${(task.product_images || []).map((url) => `<img src="${esc(url)}" class="studio-thumb-img" loading="lazy" data-studio-preview="${esc(url)}" alt="商品图">`).join('') || '<span class="muted">未附商品图</span>'}</div></div>
            <div class="studio-card"><h4>当前阶段</h4>
                ${window.DesignBrainProgress.markup(task)}
                <p>${esc(STUDIO_STATUS_LABELS[task.status] || task.status)}${task.execution && task.execution.design_run_id ? ` · 执行记录 ${esc(task.execution.design_run_id)}` : ''}</p>
                <p class="card-sub">方案方向</p><p>${esc(plan.direction || '尚未生成')}</p>
                <p class="card-sub">用量</p><p class="muted">模型调用 ${task.usage.llm_calls} 次 · 生图 ${task.usage.image_calls} 次 · 自动修正 ${task.usage.auto_revisions} 轮</p></div>
        </div>`;
    }

    function studioPlanHtml(task) {
        const plan = task.plan || {};
        if (!(plan.shots || []).length) return '<p class="muted">方案尚未生成。</p>';
        const editable = task.status === 'awaiting_confirmation';
        const sku = task.brief?.series_mode === 'sku';
        const skuVariants = task.brief?.series_mode === 'sku_variants';
        const studio = studioState();
        const chips = (items) => (items || []).length ? items.map((item) => `<span class="studio-chip">${esc(item)}</span>`).join('') : '<span class="muted">无</span>';
        const directions = task.design?.directions || [];
        const draft = studioPlanDraft(task);
        const directionCards = task.design?.confirmation === 'direction' && directions.length ? `<div class="studio-direction-grid"><h4>设计方向候选</h4>${directions.map((item) => `<button type="button" class="studio-direction-card${draft.directionId === item.id ? ' selected' : ''}" data-studio-direction="${esc(item.id)}" aria-pressed="${draft.directionId === item.id}"><strong>${esc(item.title)}</strong><span>${esc(item.intent)}</span><small>${esc(item.composition)}</small><em>${esc(item.focus)}</em></button>`).join('')}</div>` : '';
        return directionCards + `<div class="studio-card"><h4>设计方向</h4><p>${esc(plan.direction || (directions.find(item => item.id === draft.directionId)?.intent || '—'))}</p>
            ${plan.visual_framework?.palette?.length ? `<p class="muted">全组配色：${plan.visual_framework.palette.map(esc).join(' · ')} · 字体：${(plan.visual_framework.fonts || []).map(esc).join('、')}</p>` : ''}
            ${sku ? '<p class="muted">整组共用同一底图。只编辑参数、赠品和属性名称；产品、背景、版式、字号与品牌标识保持一致。</p>' : ''}
            ${skuVariants ? '<p class="muted">按款生成，共用首张场景参考。请逐张核对框色、照片来源与组合；背景、构图、工艺和光线保持统一。设计配色不包含商品实色与照片中的自然颜色。</p>' : ''}
            ${skuVariants && plan.sku_scene ? `<p class="muted">共同场景：${esc(plan.sku_scene)}</p>` : ''}
            ${plan.rationale ? `<p class="muted">${esc(plan.rationale)}</p>` : ''}</div>
        ${(plan.test_schedule || []).length ? `<details class="studio-card"><summary>7 天测图计划（独立于正式五张图）</summary>
            <ol>${plan.test_schedule.map(day => `<li>第 ${esc(day.day)} 天${day.time ? ` ${esc(day.time)}` : ''}：${esc(day.action)}；${esc(day.variable)}</li>`).join('')}</ol>
            <p class="muted">需要真实展现量、点击量和点击率数据选优；此处仅提供计划。</p></details>` : ''}
        <div class="studio-cards-row">
            <div class="studio-card"><h4>必须遵守</h4>${chips(plan.constraints_locked)}</div>
            <div class="studio-card"><h4>可自由发挥</h4>${chips(plan.flexible)}</div>
            <div class="studio-card"><h4>整体验收标准</h4>${chips(plan.acceptance)}</div>
        </div>
        <h4 class="studio-shots-head">分镜（${plan.shots.length} 张）${editable ? '<span class="muted"> · 可直接编辑提示词与尺寸，确认时生效</span>' : ''}</h4>
        ${plan.shots.map((shot, index) => {
            if (!editable || index < (task.brief?.append_from || 0)) {
                return `<div class="studio-shot" data-shot-id="${esc(shot.id)}">
                    <div class="studio-shot-head"><strong>${esc(shot.purpose || shot.kind)}</strong>
                        <span class="studio-chip">${esc(shot.kind)}</span>${shot.resolution ? `<span class="studio-chip">画质 ${esc(shot.resolution.toUpperCase())}</span>` : ''}<span class="studio-chip">${esc(shot.size)}</span>${shot.revised ? `<span class="studio-chip">修正×${shot.revised}</span>` : ''}</div>
                    <p class="studio-prompt">${esc(shot.prompt)}</p>
                    ${shot.negative ? `<p class="muted">避免：${esc(shot.negative)}</p>` : ''}
                    ${(shot.acceptance || []).length ? `<p class="muted">验收：${esc(shot.acceptance.join('；'))}</p>` : ''}</div>`;
            }
            const edit = studio.shotEdits[shot.id] || {};
            if (sku) {
                const values = {...shot.sku_values, ...edit.sku_values};
                return `<div class="studio-shot studio-shot-edit" data-shot-id="${esc(shot.id)}">
                    <strong>${esc(shot.purpose || shot.id)}</strong><span class="studio-chip">${esc(shot.size)}</span>
                    ${[['parameters', '参数'], ['gifts', '赠品'], ['attributes', '属性名称']].map(([key, label]) => `
                        <label>${label}<textarea class="inline-input wide-input" rows="2" data-shot-edit-sku="${esc(shot.id)}" data-sku-field="${key}" aria-label="${label}">${esc(values[key] || '')}</textarea></label>`).join('')}
                    <p class="muted">${esc(shot.prompt)}</p></div>`;
            }
            return `<div class="studio-shot studio-shot-edit" data-shot-id="${esc(shot.id)}">
                <div class="studio-shot-head"><strong>${esc(shot.purpose || shot.kind)}</strong>
                    <span class="studio-chip">${esc(shot.kind)}</span>
                    ${shot.resolution ? `<span class="studio-chip">画质 ${esc(shot.resolution.toUpperCase())}</span>` : ''}
                    <input class="inline-input" style="width:110px" value="${esc(edit.size || shot.size)}" data-shot-edit-size="${esc(shot.id)}" aria-label="尺寸">
                    <input class="inline-input" style="width:52px" value="${esc(String(edit.count || shot.count))}" data-shot-edit-count="${esc(shot.id)}" aria-label="数量"></div>
                <textarea class="inline-input wide-input" rows="4" data-shot-edit-prompt="${esc(shot.id)}" aria-label="提示词">${esc(edit.prompt || shot.prompt)}</textarea>
                <input class="inline-input wide-input" type="text" value="${esc(edit.negative !== undefined ? edit.negative : shot.negative)}" placeholder="避免出现（可选）" data-shot-edit-negative="${esc(shot.id)}">
                ${(shot.acceptance || []).length ? `<p class="muted">验收：${esc(shot.acceptance.join('；'))}</p>` : ''}</div>`;
        }).join('')}`;
    }

    function studioReferencesHtml(task) {
        const refs = task.references || [];
        if (!refs.length) return '<p class="muted">本任务没有使用参考案例（参考库可能还没有相关内容，可到「参考素材」导入并分析）。</p>';
        return `<div class="studio-ref-grid">${refs.map((ref) => `
            <div class="studio-ref-card">
                <img src="${esc(ref.thumb_url)}" alt="${esc(ref.title)}" loading="lazy" data-studio-preview="${esc(ref.thumb_url)}">
                <div class="studio-ref-body">
                    <strong>${esc(ref.title)}</strong>
                    <span class="studio-chip">相关度 ${Math.round((Number(ref.score) || 0) * 100)}%</span>
                    <p>${esc(ref.reason || '')}</p>
                    ${ref.takeaways ? `<p class="muted">可借鉴：${esc(ref.takeaways)}</p>` : ''}
                </div>
            </div>`).join('')}</div>`;
    }

    function studioResultsHtml(task) {
        const execution = task.execution || {};
        const shots = execution.shots || [];
        const planShots = (task.plan || {}).shots || [];
        if (!shots.length) return '<p class="muted">尚未开始生成。</p>';
        const selectable = task.status === 'delivered';
        const studio = studioState();
        return shots.map((shot) => {
            const plan = planShots.find((item) => item.id === shot.id) || {};
            const statusBadge = {
                pending: '<span class="studio-status-badge studio-badge-mute">排队中</span>',
                running: '<span class="studio-status-badge studio-badge-run">生成中</span>',
                succeeded: '<span class="studio-status-badge studio-badge-ok">成功</span>',
                failed: '<span class="studio-status-badge studio-badge-bad">失败</span>',
                skipped: '<span class="studio-status-badge studio-badge-mute">跳过</span>',
            }[shot.status] || '';
            return `<div class="studio-shot studio-result" data-shot-id="${esc(shot.id)}">
                <div class="studio-shot-head"><strong>${esc(plan.purpose || shot.id)}</strong>${statusBadge}
                    ${selectable ? `<label class="favorite-toggle"><input type="checkbox" data-studio-revise-check="${esc(shot.id)}"${studio.revisionSelection.has(shot.id) ? ' checked' : ''}> 选中修改</label>` : ''}</div>
                ${shot.error ? `<p class="studio-error-text">${esc(shot.error)}</p>` : ''}
                <div class="studio-output-row">${(shot.outputs || []).map((output) => `
                    <img src="${esc(output.url)}" class="studio-output-img" loading="lazy" data-studio-preview="${esc(output.url)}" alt="生成结果">`).join('') || '<span class="muted">暂无产物</span>'}</div>
                ${plan.prompt ? `<details class="studio-details"><summary>使用的提示词</summary><p class="studio-prompt">${esc(shot.prompt_used || plan.prompt)}</p></details>` : ''}
            </div>`;
        }).join('');
    }

    function studioReviewsHtml(task) {
        const reviews = task.reviews || [];
        if (!reviews.length) return '<p class="muted">尚未进行质量检查。</p>';
        const verdictLabel = {pass: '通过', issues: '有问题', needs_human: '需人工确认'};
        const verdictClass = {pass: 'studio-badge-ok', issues: 'studio-badge-warn', needs_human: 'studio-badge-warn'};
        const severityLabel = {critical: '严重', major: '较大', minor: '轻微'};
        return [...reviews].reverse().map((review) => `
            <div class="studio-review">
                <div class="studio-shot-head"><strong>${esc(((task.plan || {}).shots || []).find((shot) => shot.id === review.shot_id)?.purpose || review.shot_id)}</strong>
                    <span class="studio-status-badge ${verdictClass[review.verdict] || ''}">${esc(verdictLabel[review.verdict] || review.verdict)}</span>
                    <span class="muted">第 ${review.round} 轮 · ${esc(studioTime(review.checked_at))}</span></div>
                ${review.local_checks?.status ? `<p class="muted">本地确定性检查：${review.local_checks.status === 'pass' ? '通过' : review.local_checks.status === 'fail' ? '发现文件或画幅问题' : '无法在本机读取原图，未作像素判断'}</p>` : ''}
                ${(review.issues || []).length ? `<ul class="studio-issue-list">${review.issues.map((issue) => `
                    <li><span class="studio-chip ${issue.severity === 'critical' ? 'studio-chip-bad' : ''}">${esc(severityLabel[issue.severity] || issue.severity)}·${esc(issue.area || 'other')}</span>
                        ${esc(issue.description)}
                        ${issue.evidence ? `<p class="muted">证据：${esc(issue.evidence)}</p>` : ''}
                        ${issue.suggestion ? `<p class="muted">建议：${esc(issue.suggestion)}</p>` : ''}</li>`).join('')}</ul>` : '<p class="muted">未发现问题。</p>'}
            </div>`).join('');
    }

    function studioEventsHtml(task) {
        const events = task.events || [];
        if (!events.length) return '<p class="muted">暂无执行记录。</p>';
        return `<div class="studio-timeline">${[...events].reverse().map((event) => `
            <div class="studio-timeline-item">
                <span class="studio-chip">${esc(STUDIO_STATUS_LABELS[event.phase] || event.phase || '任务')}</span>
                <span class="muted">${esc(studioTime(event.at))}</span>
                <span>${esc(event.note)}</span>
            </div>`).join('')}</div>`;
    }

    function collectShotEdits() {
        const studio = studioState();
        document.querySelectorAll('[data-shot-edit-sku]').forEach((node) => {
            const id = node.dataset.shotEditSku;
            const edit = studio.shotEdits[id] || {};
            studio.shotEdits[id] = {...edit, sku_values: {...edit.sku_values, [node.dataset.skuField]: node.value}};
        });
        document.querySelectorAll('[data-shot-edit-prompt]').forEach((node) => {
            const id = node.dataset.shotEditPrompt;
            studio.shotEdits[id] = {...(studio.shotEdits[id] || {}), prompt: node.value};
        });
        document.querySelectorAll('[data-shot-edit-negative]').forEach((node) => {
            const id = node.dataset.shotEditNegative;
            studio.shotEdits[id] = {...(studio.shotEdits[id] || {}), negative: node.value};
        });
        document.querySelectorAll('[data-shot-edit-size]').forEach((node) => {
            const id = node.dataset.shotEditSize;
            studio.shotEdits[id] = {...(studio.shotEdits[id] || {}), size: node.value};
        });
        document.querySelectorAll('[data-shot-edit-count]').forEach((node) => {
            const id = node.dataset.shotEditCount;
            studio.shotEdits[id] = {...(studio.shotEdits[id] || {}), count: node.value};
        });
        return Object.entries(studio.shotEdits).map(([id, edit]) => ({id, ...edit}));
    }

    async function submitStudioPlanAction(action, task) {
        const studio = studioState();
        if (studio.pendingAction) return;
        const draft = studioPlanDraft(task);
        draft.error = '';
        const feedback = [...draft.selected, draft.text.trim()].filter(Boolean).join('\n');
        const shotEdits = collectShotEdits();
        if (action === 'confirm' && feedback) {
            draft.error = '已有调整意见，请点击「按所选项重新规划」，或清空调整意见后确认原方案。';
            draft.open = true;
            renderStudioWorkspaceFoot(task);
            return;
        }
        if (action === 'replan' && (!feedback || feedback.length > 2000)) {
            draft.error = feedback ? '调整意见超过 2000 字，请减少选项或缩短补充说明。' : '请选择至少一个调整方向，或填写补充说明。';
            renderStudioWorkspaceFoot(task);
            return;
        }
        studio.pendingAction = {taskId: task.id, action};
        renderStudioWorkspaceFoot(task);
        try {
            const directionChoice = task.design?.confirmation === 'direction';
        const confirmation = task.design?.confirmation || 'generate';
        if (action === 'confirm' && directionChoice && !draft.directionId) {
            draft.error = '请选择一个设计方向后继续。';
            renderStudioWorkspaceFoot(task);
            return;
        }
        const body = action === 'confirm' ? {approved: true, shot_edits: shotEdits, expected_revision: task.design?.revision, confirmation, direction_id: draft.directionId || '', feedback: draft.text.trim()} : {feedback, expected_revision: task.design?.revision};
            const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(task.id)}/${action}`, {method: 'POST', body});
            delete studio.planDrafts[task.id];
            const index = studio.tasks.findIndex(item => item.id === task.id);
            if (index >= 0) studio.tasks[index] = data.task;
            if (studio.currentId === task.id) {
                studio.current = data.task;
                studio.workspaceTab = action === 'confirm' ? 'results' : 'plan';
                renderStudioAll();
                startStudioPolling();
            }
            await loadStudioTasks();
        } catch (error) {
            draft.error = `${action === 'confirm' ? '确认方案失败' : '提交调整失败'}：${error.message || '请重试'}。已保留当前修改，可重试。`;
            toast(draft.error, true);
        } finally {
            studio.pendingAction = null;
            renderStudioWorkspaceFoot(studio.current);
        }
    }

    async function studioAction(action) {
        const studio = studioState();
        const task = studio.current;
        if (!task) return;
        if (studio.deletingTasks.has(task.id)) return;
        if (['confirm', 'replan'].includes(action)) return submitStudioPlanAction(action, task);
        const taskId = task.id;
        try {
            if (action === 'cancel') {
                if (!window.confirm('确定取消这个设计任务？')) return;
                const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}/cancel`, {method: 'POST', body: {reason: '用户在工作台取消'}});
                studio.current = data.task;
                stopStudioPolling();
                await loadStudioTasks();
                renderStudioAll();
            } else if (action === 'resume') {
                const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}/resume`, {method: 'POST'});
                studio.current = data.task;
                renderStudioAll();
                startStudioPolling();
            } else if (action === 'feedback') {
                const rating = Number($('studioFeedbackRating')?.value || 5);
                const comment = ($('studioFeedbackComment')?.value || '').trim();
                const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}/feedback`, {method: 'POST', body: {rating, comment}});
                studio.current = data.task;
                toast('反馈已保存；提炼出的经验只是候选，需在「项目经验」审核后才影响档案');
                renderStudioAll();
            } else if (action === 'revise' || action === 'revise_local') {
                const feedback = ($('studioReviseFeedback')?.value || '').trim();
                const shotIds = [...studio.revisionSelection];
                if (!shotIds.length && !feedback) { toast('请勾选要修改的图，或填写修改意见', true); return; }
                const mode = action === 'revise_local' ? 'local_edit' : 'replace';
                const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}/revise`, {method: 'POST', body: {shot_ids: shotIds, feedback, mode}});
                studio.current = data.task;
                if (data.task.status === 'awaiting_confirmation') {
                    studio.workspaceTab = 'plan';
                    studio.shotEdits = {};
                    toast(mode === 'local_edit' ? '将保留原图作为编辑源，仅修改目标分镜' : '请在方案中修改所选 SKU 的参数、赠品或属性名称，再确认生成');
                }
                studio.revisionSelection = new Set();
                renderStudioAll();
                startStudioPolling();
            } else if (action === 'append') {
                const count = Number($('studioAppendCount')?.value);
                if (!Number.isSafeInteger(count) || count < 1) { toast('请填写要追加的屏数（至少1屏）', true); return; }
                const feedback = ($('studioReviseFeedback')?.value || '').trim();
                const data = await api(`/api/design-brain/bot/tasks/${encodeURIComponent(taskId)}/append`, {method: 'POST', body: {count, feedback}});
                studio.current = data.task;
                studio.shotEdits = {};
                renderStudioAll();
                startStudioPolling();
            }
        } catch (error) {
            toast(error.message || '操作失败', true);
        }
    }

    function setStudioView(view) {
        const open = view === 'workspace';
        if (open) document.dispatchEvent(new CustomEvent('design-brain-workspace-open'));
        $('studioPanel').hidden = !open;
        document.querySelector('.team-split').classList.toggle('team-workspace-open', open);
        $('studioWorkspaceToggle').setAttribute('aria-expanded', String(open));
    }

    async function initStudio() {
        await loadStudioTasks();
        renderStudioAll();
    }

    function bindStudioEvents() {
        document.addEventListener('design-brain-tab', event => {
            const studio = studioState();
            clearInterval(studio.listTimer);
            studio.listTimer = null;
            if (event.detail?.tab === 'team') {
                loadStudioTasks();
                studio.listTimer = setInterval(loadStudioTasks, 1500);
            }
        });
        document.addEventListener('design-brain-tasks-changed', loadStudioTasks);
        document.addEventListener('design-brain-workspace-close', () => setStudioView('chat'));
        $('studioWorkspaceToggle').addEventListener('click', () => setStudioView($('studioPanel').hidden ? 'workspace' : 'chat'));
        $('studioWorkspaceClose').addEventListener('click', () => { setStudioView('chat'); $('studioWorkspaceToggle').focus(); });
        document.addEventListener('design-brain-open-task', (event) => {
            if (!event.detail?.taskId) return;
            switchTab('team');
            selectStudioTask(event.detail.taskId);
            loadStudioTasks();
        });
        document.addEventListener('design-brain-pick-images', (event) => openImagePicker(true, event.detail?.images || []));
        document.addEventListener('design-brain-images-uploaded', () => { state.picker.items = []; state.picker.cache.clear(); });
        $('teamNewDiscussion').addEventListener('click', () => {
            switchTab('team');
            document.dispatchEvent(new CustomEvent('design-brain-new-discussion'));
        });
        $('studioTaskSearch').addEventListener('input', () => {
            studioState().taskQuery = $('studioTaskSearch').value;
            renderStudioTaskList();
        });
        $('studioTaskList').addEventListener('click', (event) => {
            const deleteButton = event.target.closest('[data-studio-delete]');
            if (deleteButton) { deleteStudioTask(deleteButton.dataset.studioDelete); return; }
            const button = event.target.closest('[data-studio-task]');
            if (button) selectStudioTask(button.dataset.studioTask);
        });
        $('studioWorkspaceTabs').addEventListener('click', (event) => {
            const tab = event.target.closest('[data-studio-tab]');
            if (!tab) return;
            collectShotEdits();
            studioState().workspaceTab = tab.dataset.studioTab;
            renderStudioWorkspace(studioState().current);
        });
        $('studioTaskActions').addEventListener('click', (event) => {
            const task = studioState().current;
            if (!task || studioState().pendingAction) return;
            if (event.target.closest('[data-studio-feedback-toggle]')) {
                const draft = studioPlanDraft(task);
                draft.open = !draft.open;
                renderStudioWorkspaceFoot(task);
                return;
            }
            const option = event.target.closest('[data-studio-adjustment]');
            if (option) {
                const draft = studioPlanDraft(task);
                const feedback = studioAdjustmentOptions(task)[Number(option.dataset.studioAdjustment)]?.feedback;
                if (!feedback) return;
                if (draft.selected.has(feedback)) draft.selected.delete(feedback);
                else draft.selected.add(feedback);
                option.setAttribute('aria-pressed', String(draft.selected.has(feedback)));
                $('studioActionStatus').textContent = draft.selected.size ? `已选 ${draft.selected.size} 项，点击「按所选项重新规划」提交。` : '';
                return;
            }
            const button = event.target.closest('[data-studio-action]');
            if (button) studioAction(button.dataset.studioAction);
        });
        $('studioTaskActions').addEventListener('input', (event) => {
            if (event.target.id !== 'studioActionInput' || !studioState().current) return;
            studioPlanDraft(studioState().current).text = event.target.value;
        });
        $('studioWorkspaceBody').addEventListener('click', (event) => {
            const direction = event.target.closest('[data-studio-direction]');
            if (direction && studioState().current) {
                const draft = studioPlanDraft(studioState().current);
                draft.directionId = direction.dataset.studioDirection || '';
                document.querySelectorAll('[data-studio-direction]').forEach(node => { const active = node.dataset.studioDirection === draft.directionId; node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active)); });
                renderStudioWorkspaceFoot(studioState().current);
                return;
            }
            const preview = event.target.closest('[data-studio-preview]');
            if (preview) {
                const url = preview.dataset.studioPreview;
                window.parent.postMessage({type: 'history-preview-open', items: [{url, kind: 'image'}], index: 0}, '*');
            }
        });
        $('studioWorkspaceBody').addEventListener('change', (event) => {
            const check = event.target.closest('[data-studio-revise-check]');
            if (!check) return;
            const studio = studioState();
            if (check.checked) studio.revisionSelection.add(check.dataset.studioReviseCheck);
            else studio.revisionSelection.delete(check.dataset.studioReviseCheck);
        });
    }

    /* ---------------- 事件绑定与启动 ---------------- */

    const TAB_PANELS = {team: 'teamPanel', cases: 'casesPanel', references: 'referencesPanel', experiences: 'experiencesPanel', skills: 'skillsPanel', runs: 'runsPanel', reviews: 'reviewsPanel', profile: 'profilePanel'};
    const TAB_GROUPS = {
        cases: 'asset', references: 'asset', experiences: 'asset', profile: 'asset',
        team: 'team', skills: 'team',
        runs: 'log', reviews: 'log',
    };
    const GROUP_DEFAULT_TAB = {asset: 'cases', team: 'team', log: 'runs'};

    function syncTabGroups(tab) {
        const group = TAB_GROUPS[tab] || 'team';
        document.querySelector('.db-page').dataset.section = group;
        $('dbStudioNav').hidden = tab !== 'team';
        $('dbTeamNav').hidden = group !== 'team' || tab === 'skills';
        $('dbAssetActions').hidden = group !== 'asset';
        $('teamHeaderActions').hidden = tab !== 'team';
        $('studioWorkspaceToggle').hidden = tab !== 'team';
        const headings = {team: ['设计讨论', '从想法到方案，一起完成设计'], cases: ['灵感库', '收藏值得借鉴的设计'], references: ['参考素材', '整理与分析你的视觉参考'], experiences: ['项目经验', '留下每一次设计的收获'], profile: ['审美档案', '让团队了解你的设计偏好'], skills: ['设计技能', '管理可复用的设计能力'], runs: ['执行记录', '查看项目的执行过程'], reviews: ['质量反馈', '回看结果，持续改进']};
        $('dbPageTitle').textContent = headings[tab][0];
        $('dbPageHint').textContent = headings[tab][1];
        document.querySelectorAll('.db-group-tab').forEach((button) => {
            button.classList.toggle('active', button.dataset.dbGroup === group);
            if (button.dataset.dbGroup === group) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        let visible = 0;
        document.querySelectorAll('#dbSubTabs button').forEach((button) => {
            const show = button.dataset.dbGroup === group;
            button.hidden = !show;
            if (show) visible += 1;
        });
        const subRow = $('dbSubRow');
        if (subRow) subRow.hidden = visible <= 1;
        const note = $('profileSummary');
        if (note) note.hidden = group !== 'asset';
    }

    function switchTab(tab) {
        if (tab === 'skills') {
            window.XiaomeiSkillMarket?.open({
                body: $('installedSkillLibrary'),
                selectionHint: '选择后用于设计团队讨论与规划；详情可查看指令与资料',
                defaultLabel: '按需求自动匹配',
                notify: (message) => toast(message),
                onSelected: (id) => window.XiaomeiSkillMarket?.syncSelected(id),
            });
            void loadSkills();
        } else {
            window.XiaomeiSkillMarket?.close();
        }
        if (!TAB_PANELS[tab]) return;
        for (const [key, panelId] of Object.entries(TAB_PANELS)) {
            const button = $(`tab${key[0].toUpperCase()}${key.slice(1)}`);
            if (button) button.classList.toggle('active', key === tab);
            $(panelId).hidden = key !== tab;
        }
        syncTabGroups(tab);
        // Bot 团队模块在独立文件里：切走时停轮询，切回来再拉增量。
        document.dispatchEvent(new CustomEvent('design-brain-tab', {detail: {tab}}));
    }

    function bindEvents() {
        window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
        const toggleNavigation = (open) => {
            document.querySelector('.db-page').classList.toggle('db-nav-open', open);
            $('dbNavToggle').setAttribute('aria-expanded', String(open));
            $('dbNavBackdrop').hidden = !open;
        };
        $('dbNavToggle').addEventListener('click', () => toggleNavigation($('dbNavToggle').getAttribute('aria-expanded') !== 'true'));
        $('dbNavBackdrop').addEventListener('click', () => { toggleNavigation(false); $('dbNavToggle').focus(); });
        $('dbSidebar').addEventListener('click', (event) => {
            if (event.target.closest('[data-db-group], [data-team-chat], #teamNewDiscussion, #teamNewGroup')) toggleNavigation(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && $('dbNavToggle').getAttribute('aria-expanded') === 'true') { toggleNavigation(false); $('dbNavToggle').focus(); }
        });
        window.matchMedia('(max-width:600px)').addEventListener('change', () => toggleNavigation(false));
        document.querySelectorAll('.db-group-tab').forEach((button) => {
            button.addEventListener('click', () => switchTab(GROUP_DEFAULT_TAB[button.dataset.dbGroup]));
        });
        syncTabGroups('team');
        $('tabTeam').addEventListener('click', () => switchTab('team'));
        $('tabCases').addEventListener('click', () => switchTab('cases'));
        $('tabReferences').addEventListener('click', () => switchTab('references'));
        $('tabExperiences').addEventListener('click', () => switchTab('experiences'));
        $('tabSkills').addEventListener('click', () => switchTab('skills'));
        $('tabRuns').addEventListener('click', () => switchTab('runs'));
        $('tabReviews').addEventListener('click', () => switchTab('reviews'));
        $('tabProfile').addEventListener('click', () => switchTab('profile'));
        $('saveProfileButton').addEventListener('click', saveProfile);
        $('addReferenceButton').addEventListener('click', () => openImagePicker(false));
        $('newExperienceButton').addEventListener('click', () => { switchTab('experiences'); openExperienceForm(); });
        $('pickHistoryButton').addEventListener('click', () => openHistoryPicker());
        $('pickerReload').addEventListener('click', () => loadPicker({force: true}));
        $('pickerLoadMore').addEventListener('click', () => loadPicker({append: true}));
        $('pickerSearch').addEventListener('input', () => {
            clearTimeout(pickerSearchTimer);
            state.picker.query = $('pickerSearch').value.trim();
            // 输入变化即作废旧请求，防止防抖期间旧结果覆盖新关键字。
            state.picker.controller?.abort();
            state.picker.requestId += 1;
            pickerSearchTimer = setTimeout(() => loadPicker(), 250);
        });
        $('pickerClear').addEventListener('click', () => { state.picker.selected.clear(); $('pickerStatus').textContent = ''; updatePickerSelection(); });
        $('pickerOverlay').addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.pickerSource !== undefined || button.dataset.pickerFolder !== undefined) {
                clearTimeout(pickerSearchTimer);
                if (button.dataset.pickerSource !== undefined) { state.picker.kind = button.dataset.pickerSource; state.picker.folder = ''; }
                else state.picker.folder = button.dataset.pickerFolder;
                loadPicker();
            } else if (button.dataset.pickerUrl) togglePickerItem(button.dataset.pickerUrl);
            else if (button.dataset.pickerPreview) openPickerPreview(button.dataset.pickerPreview);
            else if (button.dataset.pickerRemove) {
                state.picker.selected.delete(button.dataset.pickerRemove);
                updatePickerSelection();
                ($('pickerSelected').querySelector('button') || $('pickerSearch')).focus();
            }
            else if (button.dataset.pickerRetry) loadPicker({append: button.dataset.pickerRetry === 'more', force: true});
        });
        $('pickerGrid').addEventListener('error', (event) => {
            if (event.target.tagName !== 'IMG') return;
            const thumb = event.target.closest('.picker-thumb');
            if (!thumb || thumb.querySelector('.picker-thumb-error')) return;
            event.target.hidden = true;
            const label = document.createElement('span');
            label.className = 'picker-thumb-error';
            label.textContent = '缩略图暂不可用';
            thumb.append(label);
        }, true);
        $('pickerPreviewClose').addEventListener('click', () => closePickerPreview());
        $('pickerPreviewSelect').addEventListener('click', () => togglePickerItem(state.picker.previewUrl));
        $('pickerPreviewPrev').addEventListener('click', () => movePickerPreview(-1));
        $('pickerPreviewNext').addEventListener('click', () => movePickerPreview(1));
        $('pickerPreviewImage').addEventListener('load', () => { $('pickerPreviewStatus').textContent = ''; });
        $('pickerPreviewImage').addEventListener('error', () => { if (state.picker.previewUrl) $('pickerPreviewStatus').textContent = '原图暂时无法读取，请稍后重试。'; });
        document.addEventListener('keydown', (event) => {
            if ($('pickerOverlay').hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation();
                if (!$('pickerPreview').hidden) closePickerPreview(); else closeImagePicker();
            } else if (!$('pickerPreview').hidden && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault(); movePickerPreview(event.key === 'ArrowLeft' ? -1 : 1);
            } else if (event.key === 'Tab') {
                const area = !$('pickerPreview').hidden ? $('pickerPreview') : document.querySelector('.image-picker-dialog');
                const nodes = [...area.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter((node) => node.getClientRects().length);
                const first = nodes[0], last = nodes.at(-1);
                if (!area.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        }, true);
        $('pickerTitleInput').addEventListener('input', updatePickerCreate);
        $('pickerCreate').addEventListener('click', createPickerCase);
        document.querySelectorAll('[data-close-picker]').forEach((node) => node.addEventListener('click', closeImagePicker));
        document.querySelectorAll('[data-close-case]').forEach((node) => node.addEventListener('click', () => { $('caseOverlay').hidden = true; }));
        document.querySelectorAll('[data-close-experience]').forEach((node) => node.addEventListener('click', () => { $('experienceOverlay').hidden = true; }));
        document.querySelectorAll('[data-close-skill]').forEach((node) => node.addEventListener('click', () => { $('skillOverlay').hidden = true; }));
        document.querySelectorAll('[data-close-history]').forEach((node) => node.addEventListener('click', () => { $('historyOverlay').hidden = true; }));
        document.querySelectorAll('[data-close-reference]').forEach((node) => node.addEventListener('click', () => { $('referenceOverlay').hidden = true; }));
        document.querySelectorAll('[data-close-classify]').forEach((node) => node.addEventListener('click', () => { $('refClassifyOverlay').hidden = true; }));

        // ---- 参考素材库 ----
        $('refImportButton').addEventListener('click', () => $('refFileInput').click());
        $('refImportFolderButton').addEventListener('click', () => $('refFolderInput').click());
        $('refFileInput').addEventListener('change', (event) => { refAcceptFiles(event.target.files); event.target.value = ''; });
        $('refFolderInput').addEventListener('change', (event) => { refAcceptFiles(event.target.files); event.target.value = ''; });
        $('refImportHide').addEventListener('click', () => { $('refImportProgress').hidden = true; });
        $('refAnalysisCancel').addEventListener('click', () => {
            if (state.refAnalysis) state.refAnalysis.cancel = true;
        });
        $('refAnalyzeButton').addEventListener('click', () => analyzeReferences(pendingReferenceIds()));
        let refSearchTimer = null;
        $('refSearch').addEventListener('input', (event) => {
            clearTimeout(refSearchTimer);
            refSearchTimer = setTimeout(() => {
                state.refFilters.q = event.target.value;
                loadReferences();
            }, 280);
        });
        for (const dim of REF_DIMENSIONS) {
            $(`ref${capFirst(dim.key)}Filter`).addEventListener('change', (event) => {
                state.refFilters[dim.key] = event.target.value;
                loadReferences();
            });
        }
        $('refAnalysisFilter').addEventListener('change', (event) => {
            state.refFilters.analysis = event.target.value;
            loadReferences();
        });
        $('refFavoriteFilter').addEventListener('change', (event) => {
            state.refFilters.favorite = event.target.checked;
            loadReferences();
        });
        $('refGrid').addEventListener('click', (event) => {
            const favorite = event.target.closest('[data-ref-favorite]');
            if (favorite) { toggleRefFavorite(favorite.dataset.refFavorite); return; }
            const open = event.target.closest('[data-open-ref]');
            if (open) { openRefDetail(open.dataset.openRef); return; }
        });
        $('refGrid').addEventListener('change', (event) => {
            const check = event.target.closest('[data-ref-check]');
            if (!check) return;
            if (check.checked) state.refSelection.add(check.dataset.refCheck);
            else state.refSelection.delete(check.dataset.refCheck);
            renderReferences();
        });
        $('referenceBody').addEventListener('click', (event) => {
            const button = event.target.closest('[data-ref-action]');
            if (!button) return;
            const action = button.dataset.refAction;
            if (action === 'save') saveRefDetail();
            else if (action === 'save-analysis') saveRefAnalysisEdits();
            else if (action === 'apply-suggested') applySuggestedToForm();
            else if (action === 'analyze') analyzeReferences([state.currentRefId], {fromDetail: true});
            else if (action === 'delete') deleteRefItem(state.currentRefId);
        });
        $('refBatchClassify').addEventListener('click', () => {
            if (!state.refSelection.size) return;
            $('refClassifyOverlay').hidden = false;
        });
        $('refClassifyApply').addEventListener('click', applyRefClassify);
        $('refBatchAnalyze').addEventListener('click', () => analyzeReferences([...state.refSelection]));
        $('refBatchFavorite').addEventListener('click', batchRefFavorite);
        $('refBatchDelete').addEventListener('click', batchRefDelete);

        $('historySearch').addEventListener('input', renderHistoryList);
        $('historyConfirm').addEventListener('click', confirmHistoryPick);

        $('caseSearch').addEventListener('input', (event) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.filters.q = event.target.value;
                loadCases();
            }, 280);
        });
        $('categoryFilter').addEventListener('change', (event) => {
            state.filters.category = event.target.value;
            loadCases();
        });
        $('favoriteFilter').addEventListener('change', (event) => {
            state.filters.favorite = event.target.checked;
            renderCases();
        });

        $('experienceGrid').addEventListener('click', (event) => {
            const card = event.target.closest('[data-exp-id]');
            if (card) openExperienceDetail(card.dataset.expId);
        });
        $('experienceStatusChips').addEventListener('click', (event) => {
            const button = event.target.closest('[data-exp-filter]');
            if (!button) return;
            state.experienceFilter = button.dataset.expFilter || '';
            renderExperienceStatusChips();
            renderExperiences();
        });
        $('skillGrid').addEventListener('click', (event) => {
            const card = event.target.closest('[data-skill-id]');
            if (card) openSkillDetail(card.dataset.skillId);
        });
        $('runGrid').addEventListener('click', (event) => {
            const card = event.target.closest('[data-run-id]');
            if (!card) return;
            const detail = card.querySelector('.run-detail');
            if (detail) detail.hidden = !detail.hidden;
        });
        $('reviewSkillFilter').addEventListener('change', (event) => {
            state.reviewFilter = event.target.value;
            loadReviews();
        });
        $('compareToggleButton').addEventListener('click', () => {
            const bar = $('compareBar');
            bar.hidden = !bar.hidden;
            if (!bar.hidden) fillCompareSelects();
        });
        $('compareRunButton').addEventListener('click', runComparison);
        $('exportDataButton').addEventListener('click', exportData);
        $('deleteDataButton').addEventListener('click', deleteData);
        $('reviewGrid').addEventListener('click', async (event) => {
            const button = event.target.closest('[data-delete-review]');
            if (!button) return;
            if (!window.confirm('删除这条质量评价？')) return;
            try {
                await api(`/api/design-brain/reviews/${encodeURIComponent(button.dataset.deleteReview)}`, {method: 'DELETE'});
                await loadReviews();
                toast('已删除评价');
            } catch (error) {
                toast(error.message || '删除失败', true);
            }
        });
        $('historyList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-history-ts]');
            if (!row) return;
            const ts = row.dataset.historyTs;
            if (state.historyPick.selected.has(ts)) state.historyPick.selected.delete(ts);
            else state.historyPick.selected.add(ts);
            renderHistoryList();
        });

        document.addEventListener('click', (event) => {
            const target = event.target.closest('button');
            if (!target) return;
            const filterTag = target.dataset.filterTag;
            if (filterTag !== undefined) {
                state.filters.tag = state.filters.tag === filterTag ? '' : filterTag;
                renderTagChips();
                renderCases();
                return;
            }
            const openId = target.dataset.openCase;
            if (openId) { openDetail(openId); return; }
            const favoriteId = target.dataset.favoriteCase;
            if (favoriteId) { toggleFavorite(favoriteId); return; }
            const applyId = target.dataset.applyCase;
            if (applyId) { applyCaseToCanvas(applyId); return; }
            const saveId = target.dataset.saveCase;
            if (saveId) { saveDetail(); return; }
            const deleteId = target.dataset.deleteCase;
            if (deleteId) { deleteCase(deleteId); return; }
            if (target.dataset.copyPrompt !== undefined) {
                const node = $('detailPrompt');
                if (node) navigator.clipboard.writeText(node.textContent).then(() => toast('提示词已复制'));
                return;
            }
            const addTagKey = target.dataset.addTag;
            if (addTagKey) { addTag(addTagKey); return; }
            const addWordKey = target.dataset.addWord;
            if (addWordKey) {
                const input = document.querySelector(`[data-add-word-input="${addWordKey}"]`);
                const text = (input.value || '').trim();
                if (!text) return;
                const words = state.draft.tone[addWordKey] = state.draft.tone[addWordKey] || [];
                if (!words.includes(text)) words.push(text);
                renderProfile();
                markProfileDirty();
                return;
            }
            const removeWord = target.dataset.removeWord;
            if (removeWord !== undefined) {
                state.draft.tone[removeWord].splice(Number(target.dataset.index), 1);
                renderProfile();
                markProfileDirty();
                return;
            }
            const removeTag = target.dataset.removeTag;
            if (removeTag !== undefined) {
                groupOf(state.draft, removeTag).splice(Number(target.dataset.index), 1);
                renderProfile();
                markProfileDirty();
                return;
            }
            const removeLink = target.dataset.removeLink;
            if (removeLink !== undefined) {
                const item = findCase(state.currentDetailId);
                if (item) {
                    item.profile_links = (item.profile_links || []);
                    item.profile_links.splice(Number(removeLink), 1);
                    openDetail(state.currentDetailId);
                }
                return;
            }
            if (target.id === 'linkAddButton') {
                const item = findCase(state.currentDetailId);
                const input = $('linkTagInput');
                const text = (input.value || '').trim();
                if (item && text) {
                    item.profile_links = (item.profile_links || []).filter((link) => link.tag !== text);
                    item.profile_links.push({tag: text, weight: 0.6});
                    openDetail(state.currentDetailId);
                }
                return;
            }
        });

        document.addEventListener('change', (event) => {
            const target = event.target;
            const weightGroup = target.dataset.weightGroup;
            if (weightGroup !== undefined) {
                const entry = groupOf(state.draft, weightGroup)[Number(target.dataset.index)];
                if (entry) { entry.weight = Number(target.value); markProfileDirty(); }
                return;
            }
            const linkWeight = target.dataset.linkWeight;
            if (linkWeight !== undefined) {
                const item = findCase(state.currentDetailId);
                const link = item && (item.profile_links || [])[Number(linkWeight)];
                if (link) link.weight = Number(target.value);
                return;
            }
            const patchIndex = target.dataset.patchIndex;
            if (patchIndex !== undefined && state.expDraft) {
                collectPatchRows();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            const addInput = event.target.dataset && event.target.dataset.addTagInput;
            if (addInput) { addTag(addInput); return; }
            const wordInput = event.target.dataset && event.target.dataset.addWordInput;
            if (wordInput) {
                const input = event.target;
                const text = (input.value || '').trim();
                if (text) {
                    const words = state.draft.tone[wordInput] = state.draft.tone[wordInput] || [];
                    if (!words.includes(text)) words.push(text);
                    renderProfile();
                    markProfileDirty();
                }
            }
        });

        // 历史页「提炼到设计大脑」桥：index.html 转发所选记录时间戳。
        window.addEventListener('message', (event) => {
            if (event.origin && event.origin !== location.origin) return;
            const data = event.data || {};
            if (data.type === 'providers-changed') {
                state.providers = null;
                Promise.all([setupRefAnalysisBar()]).catch(error => toast(error.message, true));
            }
            if (data.type === 'design-brain-prefill' && Array.isArray(data.timestamps)) {
                switchTab('experiences');
                openHistoryPicker(data.timestamps);
            }
        });
    }

    async function init() {
        bindEvents();
        bindStudioEvents();
        switchTab('team');
        try {
            await Promise.all([loadProfile(), loadCases(), loadReferences(), loadExperiences()]);
            await Promise.all([loadSkills(), loadRuns(), loadReviews(), setupRefAnalysisBar(), initStudio()]);
        } catch (error) {
            toast(error.message || '初始化失败', true);
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();
