(function () {
    'use strict';

    const state = {
        cases: [],
        categories: [],
        selectedId: '',
        selectedVariant: 0,
        query: '',
        category: '',
        sort: 'recent',
        tag: '',
        loading: false,
        toastTimer: null,
    };

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const esc = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    function icon(name, extra = '') {
        return `<i data-lucide="${esc(name)}"${extra ? ` class="${esc(extra)}"` : ''}></i>`;
    }

    function refreshIcons() {
        try { window.lucide?.createIcons?.(); } catch (error) { /* optional icon enhancement */ }
    }

    let overlayBodyMinHeightSnapshot = null;

    function extendOverlayViewportHost(scale, scrollTop) {
        if (!document.body) return;
        if (overlayBodyMinHeightSnapshot === null) {
            overlayBodyMinHeightSnapshot = {
                value: document.body.style.getPropertyValue('min-height'),
                priority: document.body.style.getPropertyPriority('min-height'),
            };
        }
        const requiredHeight = (window.innerHeight + scrollTop) / scale;
        document.body.style.setProperty('min-height', `${requiredHeight.toFixed(3)}px`, 'important');
    }

    function restoreOverlayViewportHost() {
        if (!document.body || overlayBodyMinHeightSnapshot === null) return;
        const { value, priority } = overlayBodyMinHeightSnapshot;
        if (value) document.body.style.setProperty('min-height', value, priority);
        else document.body.style.removeProperty('min-height');
        overlayBodyMinHeightSnapshot = null;
    }

    function resetOverlayViewport(node) {
        if (!node) return;
        ['top', 'bottom', 'height'].forEach(property => node.style.removeProperty(property));
    }

    function syncOverlayViewport(node) {
        if (!node) return;
        const root = document.documentElement;
        const scaleValue = Number(getComputedStyle(root).getPropertyValue('--studio-ui-scale'));
        const scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
        const scaled = root.classList.contains('studio-ui-scaled') && Math.abs(scale - 1) > 0.01;
        if (!scaled) {
            resetOverlayViewport(node);
            restoreOverlayViewportHost();
            return;
        }
        const scrollTop = Math.max(0, Number(window.scrollY || root.scrollTop || 0));
        extendOverlayViewportHost(scale, scrollTop);
        node.style.top = `${(scrollTop / scale).toFixed(3)}px`;
        node.style.bottom = 'auto';
        node.style.height = `${(window.innerHeight / scale).toFixed(3)}px`;
    }

    function syncOpenOverlays() {
        const drawer = $('#caseDrawer');
        const categoryModal = $('#categoryModal');
        if (drawer && !drawer.hidden) syncOverlayViewport(drawer);
        if (categoryModal && !categoryModal.hidden) syncOverlayViewport(categoryModal);
        if ((!drawer || drawer.hidden) && (!categoryModal || categoryModal.hidden)) restoreOverlayViewportHost();
    }

    function notify(message) {
        const toast = $('#toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
    }

    function categoryName(categoryId) {
        return state.categories.find(item => item.id === categoryId)?.name ||
            (state.categories[0]?.name || categoryId || '未命名分类');
    }

    function mediaUrl(item) {
        if (!item) return '';
        return item.url || item.media_url || item.path || '';
    }

    function caseCover(item) {
        return mediaUrl(item) || '/static/images/logo.png';
    }

    function getVisibleCases() {
        const query = state.query.trim().toLowerCase();
        return state.cases.filter(item => {
            if (state.category && item.category !== state.category) return false;
            if (state.tag && !(item.tags || []).includes(state.tag)) return false;
            if (!query) return true;
            const haystack = [
                item.title, item.category, categoryName(item.category), item.note,
                item.prompt?.display, item.prompt?.request, item.settings?.model,
                item.settings?.model_name, item.settings?.provider,
                ...(item.tags || []),
            ].filter(Boolean).join('\n').toLowerCase();
            return haystack.includes(query);
        }).sort((a, b) => {
            if (state.sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
            if (state.sort === 'used') return Number(b.last_used_at || 0) - Number(a.last_used_at || 0) || Number(b.updated_at || 0) - Number(a.updated_at || 0);
            return Number(b.created_at || 0) - Number(a.created_at || 0) || Number(b.updated_at || 0) - Number(a.updated_at || 0);
        });
    }

    function renderCategoryOptions() {
        const select = $('#caseCategorySelect');
        if (!select) return;
        const categories = state.categories.filter(item => item.id !== 'uncategorized');
        select.innerHTML = '<option value="">全部分类</option>' + categories.map(item =>
            `<option value="${esc(item.id)}"${state.category === item.id ? ' selected' : ''}>${esc(item.name)}</option>`
        ).join('');
    }

    function renderTagFilters() {
        const container = $('#caseTagFilters');
        if (!container) return;
        const counts = new Map();
        state.cases.forEach(item => (item.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 18);
        container.innerHTML = tags.map(([tag, count]) =>
            `<button type="button" class="tag-chip${state.tag === tag ? ' active' : ''}" data-filter-tag="${esc(tag)}">${esc(tag)} <small>${count}</small></button>`
        ).join('');
        $$('#caseTagFilters [data-filter-tag]').forEach(button => button.addEventListener('click', () => {
            state.tag = state.tag === button.dataset.filterTag ? '' : button.dataset.filterTag;
            render();
        }));
    }

    function renderCards() {
        const grid = $('#caseGrid');
        const empty = $('#caseEmptyState');
        const visible = getVisibleCases();
        if (!grid || !empty) return;
        grid.innerHTML = visible.map(item => {
            const variants = item.variants || [];
            const tags = (item.tags || []).slice(0, 4).map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('');
            const model = item.settings?.model_name || item.settings?.model || item.settings?.model_id || item.settings?.provider || '';
            return `<article class="case-card" data-case-id="${esc(item.id)}">
                <button class="case-card-cover" type="button" data-open-case="${esc(item.id)}" aria-label="打开 ${esc(item.title)}">
                    <img src="${esc(caseCover(item.cover))}" alt="${esc(item.title)}" loading="lazy" onerror="this.src='/static/images/logo.png'">
                    <span class="case-card-star" title="已收藏">${icon('star')}</span>
                    ${variants.length > 1 ? `<span class="case-card-variant-count">${variants.length} 张变体</span>` : ''}
                    <span class="case-card-hover-label">查看详情 ${icon('arrow-up-right')}</span>
                </button>
                <div class="case-card-body">
                    <h2 class="case-card-title" title="${esc(item.title)}">${esc(item.title || '未命名案例')}</h2>
                    <div class="case-card-meta"><span class="category-badge">${esc(categoryName(item.category))}</span><span class="model-badge" title="${esc(model)}">${esc(model || '参数未记录')}</span></div>
                    ${tags ? `<div class="case-card-tags">${tags}</div>` : ''}
                    <div class="case-card-footer"><span>${item.use_count ? `已使用 ${esc(item.use_count)} 次` : '可再次应用'}</span><span class="case-card-open">打开案例 ${icon('arrow-up-right')}</span></div>
                </div>
            </article>`;
        }).join('');
        $$('#caseGrid [data-open-case]').forEach(button => button.addEventListener('click', () => openCase(button.dataset.openCase)));
        empty.hidden = visible.length > 0;
        grid.hidden = visible.length === 0;
        const hasFilters = Boolean(state.query || state.category || state.tag);
        $('#clearCaseFiltersButton').hidden = !hasFilters;
        $('#emptyStateTitle').textContent = state.cases.length && hasFilters ? '没有匹配的案例' : '还没有收藏的生成案例';
        $('#emptyStateText').textContent = state.cases.length && hasFilters ? '试试换一个关键词，或者清除筛选条件。' : '在画布生成满意图片后，点击图片节点上的收藏按钮。';
        $('#emptyStateAction').hidden = state.cases.length && hasFilters;
        refreshIcons();
    }

    function render() {
        renderCategoryOptions();
        renderTagFilters();
        renderCards();
        const visible = getVisibleCases();
        const total = state.cases.length;
        $('#caseSummary').textContent = total === visible.length ? `共 ${total} 个生成案例` : `显示 ${visible.length} / ${total} 个生成案例`;
    }

    async function api(url, options = {}) {
        const response = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
        let payload = null;
        try { payload = await response.json(); } catch (error) { payload = {}; }
        if (!response.ok) throw new Error(payload.detail || payload.message || `请求失败（${response.status}）`);
        return payload;
    }

    async function loadCases() {
        if (state.loading) return;
        state.loading = true;
        $('#caseSummary').textContent = '正在读取案例…';
        try {
            const payload = await api('/api/prompt-cases?limit=500&sort=recent');
            state.cases = Array.isArray(payload.cases) ? payload.cases : [];
            state.categories = Array.isArray(payload.categories) ? payload.categories : [];
            render();
        } catch (error) {
            $('#caseSummary').textContent = error.message || '案例读取失败';
            notify(error.message || '案例读取失败');
        } finally {
            state.loading = false;
        }
    }

    function caseById(id) { return state.cases.find(item => item.id === id) || null; }

    function renderDetail(item) {
        const body = $('#caseDetailBody');
        if (!body || !item) return;
        const variants = item.variants || [];
        const variantIndex = Math.max(0, Math.min(state.selectedVariant, Math.max(variants.length - 1, 0)));
        state.selectedVariant = variantIndex;
        const currentCover = variants[variantIndex] || item.cover;
        const settings = item.settings && typeof item.settings === 'object' ? item.settings : {};
        const apiKind = String(settings.apiKind || '').trim().toLowerCase();
        // 图片节点也会保存一份通用设置，其中包含默认的 videoDuration 等视频字段。
        // 详情页只在视频案例中展示 video* 参数，避免图片案例出现“视频时长 5”。
        const isVideoCase = apiKind === 'video' || (
            !apiKind && Boolean(String(settings.videoModel || settings.videoProvider || '').trim())
        );
        const settingEntries = Object.entries(settings)
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .slice(0, 18)
            .filter(([key]) => !/^_?video/i.test(String(key)) || isVideoCase);
        const references = Array.isArray(item.references) ? item.references : [];
        const source = item.source || {};
        body.innerHTML = `
            <div class="detail-cover"><img src="${esc(caseCover(currentCover))}" alt="${esc(item.title)}" onerror="this.src='/static/images/logo.png'"></div>
            ${variants.length > 1 ? `<div class="detail-variants">${variants.map((variant, index) => `<button class="variant-thumb${index === variantIndex ? ' active' : ''}" type="button" data-variant-index="${index}" title="变体 ${index + 1}"><img src="${esc(caseCover(variant))}" alt="变体 ${index + 1}"></button>`).join('')}</div>` : ''}
            <div class="detail-actions">
                <button class="primary-button" type="button" data-apply-case="${esc(item.id)}">${icon('wand-2')}应用到画布</button>
                <button class="secondary-button" type="button" data-copy-prompt="${esc(item.id)}">${icon('copy')}复制提示词</button>
                <button class="secondary-button" type="button" data-delete-case="${esc(item.id)}">${icon('trash-2')}删除</button>
            </div>
            <section class="detail-section"><h3>案例信息 <span>可编辑</span></h3>
                <form class="detail-form" id="caseMetadataForm">
                    <label class="field-label">标题<input class="field-input" name="title" maxlength="120" value="${esc(item.title || '')}"></label>
                    <div class="detail-form-row"><label class="field-label">分类<select class="field-input" name="category">${state.categories.filter(category => category.id !== 'uncategorized').map(category => `<option value="${esc(category.id)}"${item.category === category.id ? ' selected' : ''}>${esc(category.name)}</option>`).join('')}</select></label><label class="field-label">标签<input class="field-input" name="tags" maxlength="300" value="${esc((item.tags || []).join('、'))}" placeholder="用顿号或逗号分隔"></label></div>
                    <label class="field-label">备注<textarea class="field-textarea" name="note" maxlength="1000" placeholder="补充使用心得或适用场景">${esc(item.note || '')}</textarea></label>
                    <div class="detail-form-actions"><button class="secondary-button" type="submit">保存修改</button></div>
                </form>
            </section>
            <section class="detail-section"><h3>可编辑提示词</h3><div class="prompt-block">${esc(item.prompt?.display || '')}</div></section>
            ${references.length ? `<section class="detail-section"><h3>参考图 <span>${references.length} 张</span></h3><div class="detail-references">${references.map((reference, index) => `<div><a class="reference-thumb" href="${esc(mediaUrl(reference))}" target="_blank" rel="noreferrer"><img src="${esc(mediaUrl(reference))}" alt="参考图 ${index + 1}" onerror="this.style.opacity='.25'"></a><div class="detail-reference-name">${esc(reference.name || `参考图 ${index + 1}`)}</div></div>`).join('')}</div></section>` : ''}
            ${settingEntries.length ? `<section class="detail-section"><h3>生成参数</h3><dl class="detail-settings">${settingEntries.map(([key, value]) => `<div class="setting-item"><dt>${esc(settingLabel(key))}</dt><dd title="${esc(formatSetting(value, key))}">${esc(formatSetting(value, key))}</dd></div>`).join('')}</dl></section>` : ''}
            <section class="detail-section"><h3>来源</h3><div class="detail-source">${esc(source.canvas_title || '小美画布')}${source.node_id ? ` · 节点 ${esc(source.node_id)}` : ''}<br>${source.run_at ? esc(formatDate(source.run_at)) : '生成时间未记录'}${item.use_count ? ` · 已使用 ${item.use_count} 次` : ''}</div></section>
        `;
        $$('#caseDetailBody [data-variant-index]').forEach(button => button.addEventListener('click', () => {
            state.selectedVariant = Number(button.dataset.variantIndex) || 0;
            renderDetail(item);
        }));
        $('#caseMetadataForm')?.addEventListener('submit', event => saveMetadata(event, item));
        $$('#caseDetailBody [data-apply-case]').forEach(button => button.addEventListener('click', () => applyCase(item)));
        $$('#caseDetailBody [data-copy-prompt]').forEach(button => button.addEventListener('click', () => copyPrompt(item)));
        $$('#caseDetailBody [data-delete-case]').forEach(button => button.addEventListener('click', () => deleteCase(item)));
        refreshIcons();
    }

    const SETTING_LABELS = Object.freeze({
        engine: '引擎',
        apiKind: '接口类型',
        provider_id: '平台',
        model: '模型',
        ratio: '比例',
        resolution: '清晰度',
        customRatio: '自定义比例',
        customRatioWidth: '自定义比例宽度',
        customRatioHeight: '自定义比例高度',
        customSize: '自定义尺寸',
        quality: '质量',
        count: '生成数量',
        imageOperation: '图像操作',
        upscaleResolution: '放大清晰度',
        requestMode: '任务模式',
        videoProvider: '视频平台',
        videoModel: '视频模型',
        videoAspect: '视频画幅',
        videoResolution: '视频清晰度',
        videoDuration: '视频时长',
        videoEnhancePrompt: '视频提示词增强',
        videoEnableUpsample: '视频启用超分',
        size: '尺寸',
        customWidth: '自定义宽度',
        customHeight: '自定义高度',
        enhanceUpscaleRes: '增强清晰度',
        editUpscaleRes: '编辑清晰度',
        comfyMode: 'ComfyUI 模式',
        comfyWorkflow: 'ComfyUI 工作流',
        rhConfigKey: 'RunningHub 配置',
        rhPayment: 'RunningHub 计费',
        rhInstanceType: 'RunningHub 实例类型',
    });

    const SETTING_VALUE_LABELS = Object.freeze({
        engine: { api: '在线 API', comfyui: 'ComfyUI', codex: 'Codex', gemini: 'Gemini', jimeng: '即梦', runninghub: 'RunningHub', volcengine: '火山引擎' },
        apiKind: { image: '图片', video: '视频' },
        imageOperation: { generate: '生成', upscale: '放大' },
        requestMode: { async: '异步', sync: '同步' },
        resolution: { auto: '自动', '1k': '1K', '2k': '2K', '4k': '4K' },
        upscaleResolution: { auto: '自动', '1k': '1K', '2k': '2K', '4k': '4K' },
        videoResolution: { auto: '自动', '1k': '1K', '2k': '2K', '4k': '4K' },
        quality: { auto: '自动', low: '低', medium: '中', high: '高' },
    });

    function settingLabel(key) {
        return SETTING_LABELS[key] || key;
    }

    function formatSetting(value, key = '') {
        if (Array.isArray(value)) return value.map(item => formatSetting(item, key)).join(', ');
        if (typeof value === 'object') return JSON.stringify(value);
        if (typeof value === 'boolean') return value ? '是' : '否';
        const valueLabels = SETTING_VALUE_LABELS[key];
        const normalized = String(value).toLowerCase();
        if (valueLabels?.[normalized]) return valueLabels[normalized];
        return String(value);
    }

    function formatDate(value) {
        const raw = Number(value);
        const date = new Date(raw > 100000000000 ? raw : raw * 1000);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    async function openCase(id) {
        let item = caseById(id);
        if (!item) {
            try {
                const payload = await api(`/api/prompt-cases/${encodeURIComponent(id)}`);
                item = payload.case || null;
                if (item) {
                    state.cases = [...state.cases.filter(caseItem => caseItem.id !== item.id), item];
                    if (Array.isArray(payload.categories)) state.categories = payload.categories;
                }
            } catch (error) { notify(error.message || '案例读取失败'); return; }
        }
        if (!item) return;
        state.selectedId = item.id;
        state.selectedVariant = 0;
        $('#detailTitle').textContent = item.title || '未命名案例';
        const drawer = $('#caseDrawer');
        drawer.hidden = false;
        document.body.classList.add('drawer-open');
        syncOverlayViewport(drawer);
        renderDetail(item);
        window.requestAnimationFrame(syncOpenOverlays);
    }

    function closeDrawer() {
        const drawer = $('#caseDrawer');
        drawer.hidden = true;
        resetOverlayViewport(drawer);
        document.body.classList.remove('drawer-open');
        state.selectedId = '';
        syncOpenOverlays();
    }

    async function saveMetadata(event, item) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const tags = String(data.get('tags') || '').split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);
        try {
            const updated = await api(`/api/prompt-cases/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ title: data.get('title') || '', category: data.get('category') || state.categories[0]?.id || 'product', tags, note: data.get('note') || '' }) });
            const index = state.cases.findIndex(caseItem => caseItem.id === item.id);
            if (index >= 0) state.cases[index] = updated.case || updated;
            $('#detailTitle').textContent = state.cases[index]?.title || '未命名案例';
            render();
            renderDetail(state.cases[index]);
            notify('案例信息已保存');
            broadcast({ type: 'prompt-cases-updated' });
        } catch (error) { notify(error.message || '保存失败'); }
    }

    async function deleteCase(item) {
        if (!window.confirm(`确定删除“${item.title || '未命名案例'}”吗？案例副本会被删除，原画布素材不会受影响。`)) return;
        try {
            await api(`/api/prompt-cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            state.cases = state.cases.filter(caseItem => caseItem.id !== item.id);
            closeDrawer();
            render();
            notify('案例已删除');
            broadcast({
                type: 'prompt-cases-updated',
                deleted_case_id: item.id,
                deleted_media_urls: Array.isArray(item.source?.media_urls) ? item.source.media_urls : [],
            });
        } catch (error) { notify(error.message || '删除失败'); }
    }

    async function copyPrompt(item) {
        const prompt = item.prompt?.display || '';
        try {
            await navigator.clipboard.writeText(prompt);
            notify('可编辑提示词已复制');
        } catch (error) {
            const area = document.createElement('textarea'); area.value = prompt; document.body.appendChild(area); area.select();
            document.execCommand('copy'); area.remove(); notify('可编辑提示词已复制');
        }
    }

    async function applyCase(item) {
        const message = { type: 'prompt-case-apply-request', case: item };
        try { window.parent?.postMessage(message, location.origin); } catch (error) { /* parent may be unavailable in standalone view */ }
        try {
            await api(`/api/prompt-cases/${encodeURIComponent(item.id)}/use`, { method: 'POST', body: '{}' });
            item.use_count = Number(item.use_count || 0) + 1;
            item.last_used_at = Date.now();
        } catch (error) { /* application should remain useful if usage telemetry fails */ }
        notify('已发送到小美画布，不会自动生成');
    }

    function broadcast(message) {
        try { const channel = new BroadcastChannel('studio-prompt-cases'); channel.postMessage(message); channel.close(); } catch (error) { /* optional */ }
    }

    function openCategoryModal() {
        const modal = $('#categoryModal');
        modal.hidden = false;
        syncOverlayViewport(modal);
        renderCategoryList();
        $('#newCategoryInput')?.focus();
        window.requestAnimationFrame(syncOpenOverlays);
    }

    function closeCategoryModal() {
        const modal = $('#categoryModal');
        modal.hidden = true;
        resetOverlayViewport(modal);
        syncOpenOverlays();
    }

    function renderCategoryList() {
        const list = $('#categoryList');
        if (!list) return;
        list.innerHTML = state.categories.filter(category => category.id !== 'uncategorized').map(category => `<div class="category-row"><span class="category-row-name" title="${esc(category.name)}">${esc(category.name)}</span><div class="category-row-actions"><button class="icon-button" type="button" data-rename-category="${esc(category.id)}" title="重命名">${icon('pencil')}</button><button class="icon-button" type="button" data-delete-category="${esc(category.id)}" title="删除">${icon('trash-2')}</button></div></div>`).join('');
        $$('[data-rename-category]', list).forEach(button => button.addEventListener('click', () => renameCategory(button.dataset.renameCategory)));
        $$('[data-delete-category]', list).forEach(button => button.addEventListener('click', () => removeCategory(button.dataset.deleteCategory)));
        refreshIcons();
    }

    async function addCategory() {
        const input = $('#newCategoryInput');
        const name = input?.value.trim();
        if (!name) return notify('请先输入分类名称');
        try {
            const payload = await api('/api/prompt-cases/categories', { method: 'POST', body: JSON.stringify({ name }) });
            state.categories = payload.categories || state.categories;
            input.value = '';
            renderCategoryList(); render(); notify('分类已新增');
        } catch (error) { notify(error.message || '分类新增失败'); }
    }

    async function renameCategory(id) {
        const category = state.categories.find(item => item.id === id);
        if (!category) return;
        const name = window.prompt('请输入新的分类名称', category.name);
        if (!name || name.trim() === category.name) return;
        try {
            const payload = await api(`/api/prompt-cases/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
            state.categories = payload.categories || state.categories;
            renderCategoryList(); render(); notify('分类已重命名');
        } catch (error) { notify(error.message || '分类重命名失败'); }
    }

    async function removeCategory(id) {
        const category = state.categories.find(item => item.id === id);
        if (!category) return;
        const fallbackCategory = state.categories.find(item => item.id !== id && item.id !== 'uncategorized');
        const fallbackName = fallbackCategory?.name || '第一个可用分类';
        if (!window.confirm(`删除“${category.name}”？对应案例会自动归入“${fallbackName}”。`)) return;
        try {
            const payload = await api(`/api/prompt-cases/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
            state.categories = payload.categories || state.categories;
            state.cases = Array.isArray(payload.cases)
                ? payload.cases
                : state.cases.map(item => item.category === id ? { ...item, category: fallbackCategory?.id || state.categories[0]?.id || 'product' } : item);
            if (state.category === id) state.category = '';
            renderCategoryList(); render(); notify('分类已删除');
        } catch (error) { notify(error.message || '分类删除失败'); }
    }

    function clearFilters() {
        state.query = ''; state.category = ''; state.tag = '';
        $('#caseSearchInput').value = '';
        render();
    }

    function goCanvas() {
        try { window.parent?.postMessage({ type: 'open-canvas' }, location.origin); } catch (error) {}
    }

    function bindEvents() {
        $('#caseSearchInput').addEventListener('input', event => { state.query = event.target.value; render(); });
        $('#caseCategorySelect').addEventListener('change', event => { state.category = event.target.value; render(); });
        $('#caseSortSelect').addEventListener('change', event => { state.sort = event.target.value; render(); });
        $('#refreshCasesButton').addEventListener('click', loadCases);
        $('#clearCaseFiltersButton').addEventListener('click', clearFilters);
        $('#emptyStateAction').addEventListener('click', goCanvas);
        $('#openCategoryManagerButton').addEventListener('click', openCategoryModal);
        $('#addCategoryButton').addEventListener('click', addCategory);
        $('#newCategoryInput').addEventListener('keydown', event => { if (event.key === 'Enter') addCategory(); });
        $$('[data-close-drawer]').forEach(node => node.addEventListener('click', closeDrawer));
        $$('[data-close-category-modal]').forEach(node => node.addEventListener('click', closeCategoryModal));
        window.addEventListener('keydown', event => { if (event.key === 'Escape') { closeDrawer(); closeCategoryModal(); } });
        window.addEventListener('resize', syncOpenOverlays);
        window.addEventListener('scroll', syncOpenOverlays, { passive: true });
        window.addEventListener('studio-ui-scale-change', syncOpenOverlays);
        window.addEventListener('message', event => {
            if (event.origin && event.origin !== location.origin) return;
            if (event.data?.type === 'studio-theme') document.documentElement.dataset.theme = event.data.theme;
            if (event.data?.type === 'prompt-cases-updated') loadCases();
            if (event.data?.type === 'prompt-case-open') openCase(event.data.case_id || event.data.caseId);
        });
        try {
            const channel = new BroadcastChannel('studio-prompt-cases');
            channel.onmessage = event => { if (event.data?.type === 'prompt-cases-updated') loadCases(); };
        } catch (error) { /* optional */ }
        refreshIcons();
    }

    document.addEventListener('DOMContentLoaded', () => { bindEvents(); loadCases(); });
})();
