/* Shared online generation for the local workflow studio pages. */
(() => {
    'use strict';
    let providers = [];
    let pendingLoad;
    const storageKey = `studio_api_image:${location.pathname}`;
    const panel = document.createElement('div');
    panel.style.cssText = 'display:grid;gap:8px;margin:12px 0;font-size:12px;width:240px;max-width:100%;min-width:0';
    panel.innerHTML = '<label>API 平台<select aria-label="在线 API 平台" style="display:block;width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;background:var(--bg,#fff);color:inherit"></select></label><label>生图模型<select aria-label="在线生图模型" style="display:block;width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;background:var(--bg,#fff);color:inherit"></select></label><span role="status"></span>';
    const [providerSelect, modelSelect] = panel.querySelectorAll('select');
    const status = panel.querySelector('[role="status"]');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) {}

    function remember() {
        saved = {provider: providerSelect.value, model: modelSelect.value};
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch (_) {}
    }
    function options(select, values, empty) {
        select.replaceChildren(...values.map(([id, name]) => new Option(name, id)));
        if (!values.length) select.add(new Option(empty, ''));
        select.disabled = !values.length;
    }
    function fillModels(preferred) {
        const provider = providers.find(item => item.id === providerSelect.value);
        const models = provider?.image_models || [];
        options(modelSelect, models.map(model => [model, model]), '请先在 API 设置中拉取生图模型');
        if (models.includes(preferred)) modelSelect.value = preferred;
    }
    async function load() {
        status.textContent = '正在读取 API 平台…';
        try {
            const response = await fetch('/api/providers', {cache: 'no-store'});
            if (!response.ok) throw new Error('读取 API 平台失败，请重试');
            const data = await response.json();
            providers = (data.providers || []).filter(item => item.enabled !== false && item.image_models?.length);
            options(providerSelect, providers.map(item => [item.id, item.name || item.id]), '请先在 API 设置中添加平台');
            const preferred = providers.find(item => item.id === saved.provider) || providers.find(item => item.primary) || providers[0];
            if (preferred) providerSelect.value = preferred.id;
            fillModels(preferred?.id === saved.provider ? saved.model : '');
            status.textContent = providers.length ? '' : '请在 API 设置中添加平台并拉取生图模型。';
        } catch (error) {
            providers = [];
            options(providerSelect, [], '平台读取失败');
            fillModels();
            status.textContent = error.message;
        }
    }
    providerSelect.onchange = () => { fillModels(); remember(); };
    modelSelect.onchange = remember;
    const button = document.getElementById('modeCloud') || document.getElementById('cloudBtn');
    button.parentElement.insertAdjacentElement('afterend', panel);
    function syncVisibility() { panel.style.display = button.classList.contains('active') ? 'grid' : 'none'; }
    new MutationObserver(syncVisibility).observe(button, {attributes: true, attributeFilter: ['class']});
    syncVisibility();
    pendingLoad = load();
    window.addEventListener('message', event => {
        if (event.origin && event.origin !== location.origin) return;
        if (event.data?.type === 'providers-changed') { remember(); pendingLoad = load(); }
    });

    async function read(response) {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '在线生图请求失败');
        return data;
    }
    window.StudioApiImage = {
        async generate({prompt, size = '1024x1024', images = [], onProgress} = {}) {
            await pendingLoad;
            const provider = providers.find(item => item.id === providerSelect.value);
            const model = modelSelect.value;
            if (!provider || !model) throw new Error('请先在 API 设置中添加平台并拉取生图模型。');
            remember();
            const created = await read(await fetch('/api/canvas-image-tasks', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({prompt, size, provider_id: provider.id, model,
                    history_source: location.pathname.match(/\/(angle|klein|zimage)\.html$/)?.[1] || 'online',
                    reference_images: images.map(url => ({url})), n: 1}),
            }));
            const taskId = created.task_id || created.task?.id;
            if (!taskId) throw new Error('生图服务没有返回任务编号');
            for (;;) {
                const data = await read(await fetch(`/api/canvas-image-tasks/${encodeURIComponent(taskId)}`, {cache: 'no-store'}));
                const task = data.task || data;
                onProgress?.(task.message || '正在生成…');
                if (task.status === 'succeeded') {
                    const result = task.result || {};
                    if (!result.images?.length) throw new Error('所选模型没有返回图片');
                    return {...result, url: result.images[0], model, provider_id: provider.id};
                }
                if (['failed', 'cancelled', 'jimeng_pending'].includes(task.status)) throw new Error(task.error || task.message || '生图任务未完成，请到任务记录查看');
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        },
    };
})();
