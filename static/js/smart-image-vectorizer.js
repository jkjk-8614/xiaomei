(function(global){
    'use strict';
    const sessions = new Map();
    let activeDialog = null;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const redrawStages = {
        preparing:'正在准备识图请求。',
        vision:'第 1 步，共 2 步。正在等待识图模型描述原图。',
        svg:'第 2 步，共 2 步。正在请求 SVG 模型重绘。',
        waiting:'第 2 步，共 2 步。平台已受理，正在等待 SVG 结果。'
    };

    async function request(url, body, signal){
        const response = await fetch(url, body ? {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal
        } : {cache:'no-store', signal});
        const data = await response.json();
        if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请重试');
        return data;
    }

    async function pollRedrawStage(state, requestId){
        if(state.requestId !== requestId) return;
        updateRedrawElapsed(state);
        try {
            const {stage} = await request(`/api/image-vectorizer/status?request_id=${encodeURIComponent(requestId)}`, null, AbortSignal.timeout(3000));
            if(state.requestId === requestId && state.stage !== stage && Object.hasOwn(redrawStages, stage)){
                state.stage = stage;
                renderState(state);
            }
        } catch {
            // The original conversion request still delivers the result or error.
        }
        if(state.requestId === requestId) setTimeout(() => void pollRedrawStage(state, requestId), 1200);
    }

    function updateRedrawElapsed(state){
        if(activeDialog?.vectorState !== state) return;
        const elapsed = activeDialog.querySelector('[data-vector-elapsed]');
        elapsed.textContent = state.requestId ? ` 已等待 ${Math.floor((performance.now() - state.redrawStartedAt) / 1000)} 秒。` : '';
    }

    function renderState(state){
        const dialog = activeDialog;
        if(!dialog?.isConnected || dialog.vectorState !== state) return;
        const result = state.result;
        const api = state.mode === 'api';
        const vision = dialog.querySelector('[data-vector-vision]');
        const svg = dialog.querySelector('[data-vector-svg]');
        dialog.querySelector('[data-vector-local-controls]').hidden = api;
        dialog.querySelector('[data-vector-api-controls]').hidden = !api;
        const convert = dialog.querySelector('[data-vector-convert]');
        const loadingModels = state.loadingModels || state.modelError;
        convert.disabled = state.busy || (api ? !vision.value || !svg.value || loadingModels : !state.status?.vtracer_ready);
        const localAction = result && result.engine !== 'api' ? '重新转换' : '转换为 SVG';
        convert.textContent = api ? (state.busy ? '重绘中…' : '重绘为 SVG') : (state.busy ? '转换中…' : localAction);
        dialog.querySelectorAll('input, select').forEach(control => control.disabled = state.busy);
        vision.disabled ||= loadingModels || vision.options.length <= 1;
        svg.disabled ||= loadingModels || svg.options.length <= 1;
        dialog.querySelector('[data-vector-download]').disabled = !result || state.busy;
        dialog.querySelector('[data-vector-refresh]').disabled = !result || state.busy;
        const resultSummary = result && [
            result.engine === 'api' ? `AI 重绘 · ${result.svg_model}` : '本地转换',
            `${result.width} × ${result.height}`,
            result.path_count != null ? `${result.path_count} 条路径` : '',
            `${(result.size_bytes / 1024).toFixed(1)} KB`
        ].filter(Boolean).join(' · ');
        const progress = api ? `${redrawStages[state.stage]}关闭面板后任务会继续。` : 'VTracer 正在本机转换。关闭面板后转换会继续。';
        const status = dialog.querySelector('[data-vector-status]');
        status.firstElementChild.textContent = state.error || (state.busy ? progress : resultSummary || (api ? '选择识图模型和 SVG 模型后开始重绘。' : '选择图片类型和细节程度，然后开始转换。'));
        status.classList.toggle('has-error', Boolean(state.error));
        updateRedrawElapsed(state);
        const apiStatus = state.loadingModels ? '正在读取 API 设置…'
            : state.modelError ? '读取 API 设置失败，请切回本地模型后重新选择外接 API。'
            : vision.options.length <= 1 || svg.options.length <= 1 ? '请在 API 设置中启用支持图片输入的对话模型和支持 SVG 的 GPT Image 2.6。'
            : '原图会发送给识图模型，画面描述会发送给 SVG 模型。两次调用均可能计费，重绘结果可能与原图有差异。';
        dialog.querySelector('[data-vector-engine]').textContent = api ? apiStatus
            : state.localError || (!state.status ? '正在检测转换引擎…' : state.status.vtracer_ready ? 'VTracer 已就绪 · 本机转换' : 'VTracer 未安装，请安装项目依赖后重启小美画布。');
        const image = dialog.querySelector('[data-vector-result]');
        dialog.querySelector('[data-vector-empty]').hidden = Boolean(result);
        image.hidden = !result;
        const previewUrl = result ? `${result.url}${result.url.includes('?') ? '&' : '?'}vector-preview=${state.revision || 0}` : '';
        if(result && image.getAttribute('src') !== previewUrl) image.src = previewUrl;
    }

    async function detect(state){
        state.localError = '';
        try { state.status = await request('/api/image-vectorizer/status'); }
        catch(error){ state.localError = error.message; }
        renderState(state);
    }

    function fillApiModels(dialog, state){
        const fill = (key, modelsKey, placeholder) => {
            const select = dialog.querySelector(`[data-vector-${key}]`);
            select.replaceChildren(new Option(placeholder, ''));
            for(const provider of state.providers || []){
                const models = provider[modelsKey] || [];
                if(!models.length) continue;
                const group = document.createElement('optgroup');
                group.label = provider.name || provider.id;
                for(const model of new Set(models)) group.append(new Option(model, JSON.stringify([provider.id, model])));
                select.append(group);
            }
            const value = state.apiSettings[key];
            if(value && Array.from(select.options).some(option => option.value === value)) select.value = value;
        };
        fill('vision', 'chat_models', '请选择支持图片输入的模型');
        fill('svg', 'svg_image_models', '请选择 GPT Image 2.6');
    }

    async function loadApiModels(state){
        if(state.loadingModels) return;
        state.loadingModels = true;
        state.modelError = false;
        renderState(state);
        try {
            const data = await request('/api/providers');
            state.providers = (data.providers || []).filter(provider => provider.enabled !== false);
            if(activeDialog?.vectorState === state) fillApiModels(activeDialog, state);
        } catch {
            state.modelError = true;
        } finally {
            state.loadingModels = false;
            renderState(state);
        }
    }

    function close(){
        const dialog = activeDialog;
        if(!dialog) return;
        activeDialog = null;
        dialog.close();
        dialog.remove();
        dialog.returnFocus?.focus();
    }

    function open(options){
        close();
        const key = options.key || options.sourceUrl;
        let state = sessions.get(key);
        if(!state){
            const result = options.result;
            state = {
                busy:false, result:result || null, status:null, error:'', revision:0,
                mode:result?.engine === 'api' ? 'api' : 'local',
                apiSettings:result?.engine === 'api' ? {
                    vision:JSON.stringify([result.vision_provider, result.vision_model]),
                    svg:JSON.stringify([result.svg_provider, result.svg_model])
                } : {}
            };
            sessions.set(key, state);
        } else if(!state.busy) state.result = options.result || null;
        state.options = options;
        const dialog = document.createElement('dialog');
        dialog.className = 'smart-vector-dialog';
        dialog.vectorState = state;
        dialog.returnFocus = options.anchor || document.activeElement;
        dialog.setAttribute('aria-labelledby', 'smartVectorTitle');
        const settings = state.settings || state.result || {};
        dialog.innerHTML = `
            <header class="smart-vector-head"><div><strong id="smartVectorTitle">矢量转换</strong><p>转换为可编辑的 SVG，下载后可在矢量软件中继续编辑。</p></div><button type="button" data-vector-close aria-label="关闭矢量转换"><i data-lucide="x"></i></button></header>
            <div class="smart-vector-mode" role="radiogroup" aria-label="转换方式">
                <label><input type="radio" name="smart-vector-mode" value="local"><span>本地模型</span></label>
                <label><input type="radio" name="smart-vector-mode" value="api"><span>外接 API</span></label>
            </div>
            <div class="smart-vector-controls" data-vector-local-controls>
                <label>图片类型<select data-vector-preset><option value="logo">Logo / 图标</option><option value="illustration">插画</option></select></label>
                <label>细节程度<select data-vector-detail><option value="simple">简化</option><option value="balanced">均衡</option><option value="fine">保留细节</option></select></label>
                <label>颜色模式<select data-vector-color><option value="color">彩色</option><option value="binary">黑白</option></select></label>
            </div>
            <div class="smart-vector-controls smart-vector-api-controls" data-vector-api-controls hidden>
                <label>识图模型<select data-vector-vision></select></label>
                <label>SVG 模型<select data-vector-svg></select></label>
            </div>
            <div class="smart-vector-previews">
                <figure><figcaption>原图</figcaption><div class="smart-vector-image"><img src="${esc(options.previewUrl || options.sourceUrl)}" alt="待转换的原图"></div></figure>
                <figure><figcaption>SVG 预览<button type="button" data-vector-refresh disabled>刷新预览</button></figcaption><div class="smart-vector-image"><span data-vector-empty>转换后在这里查看效果</span><img data-vector-result alt="SVG 转换结果" hidden></div></figure>
            </div>
            <p class="smart-vector-status" data-vector-status><span role="status"></span><span data-vector-elapsed aria-hidden="true"></span></p>
            <div class="smart-vector-tools"><span data-vector-engine></span></div>
            <footer class="smart-vector-footer"><button type="button" class="image-edit-btn primary" data-vector-convert disabled>转换为 SVG</button><button type="button" class="image-edit-btn secondary" data-vector-download disabled>下载 SVG</button></footer>`;
        document.body.append(dialog);
        activeDialog = dialog;
        dialog.querySelector('[data-vector-preset]').value = settings.preset || 'logo';
        dialog.querySelector('[data-vector-detail]').value = settings.detail || 'balanced';
        dialog.querySelector('[data-vector-color]').value = settings.color_mode || 'color';
        dialog.querySelector(`input[value="${state.mode}"]`).checked = true;
        fillApiModels(dialog, state);
        dialog.querySelectorAll('[name="smart-vector-mode"]').forEach(control => {
            control.onchange = () => {
                state.mode = control.value;
                state.error = '';
                renderState(state);
                if(state.mode === 'api') void loadApiModels(state);
            };
        });
        for(const key of ['vision', 'svg']){
            dialog.querySelector(`[data-vector-${key}]`).onchange = event => {
                state.apiSettings[key] = event.target.value;
                state.error = '';
                renderState(state);
            };
        }
        dialog.querySelector('[data-vector-close]').onclick = close;
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('keydown', event => event.stopPropagation());
        dialog.addEventListener('paste', event => event.stopPropagation());
        dialog.addEventListener('wheel', event => event.stopPropagation(), {passive:true});
        dialog.querySelector('[data-vector-refresh]').onclick = () => { state.revision = Date.now(); state.error = ''; renderState(state); };
        dialog.querySelector('[data-vector-result]').onerror = () => { state.error = 'SVG 预览加载失败，请重新转换或下载文件检查。'; renderState(state); };
        dialog.querySelector('[data-vector-download]').onclick = () => {
            if(state.result) options.download(`${state.result.url}?download-version=${Date.now()}`, state.result.name);
        };
        dialog.querySelector('[data-vector-convert]').onclick = async () => {
            if(state.busy || dialog.querySelector('[data-vector-convert]').disabled) return;
            const body = {source_url:options.sourceUrl, name:options.name || ''};
            if(state.mode === 'api'){
                const [vision_provider, vision_model] = JSON.parse(dialog.querySelector('[data-vector-vision]').value);
                const [svg_provider, svg_model] = JSON.parse(dialog.querySelector('[data-vector-svg]').value);
                const request_id = crypto.getRandomValues(new Uint32Array(4)).join('-');
                Object.assign(body, {mode:'api', vision_provider, vision_model, svg_provider, svg_model, request_id});
                state.requestId = request_id;
                state.stage = 'preparing';
                state.redrawStartedAt = performance.now();
            } else {
                state.settings = {
                    preset:dialog.querySelector('[data-vector-preset]').value,
                    detail:dialog.querySelector('[data-vector-detail]').value,
                    color_mode:dialog.querySelector('[data-vector-color]').value
                };
                Object.assign(body, state.settings);
            }
            state.busy = true; state.error = ''; renderState(state);
            if(body.request_id) void pollRedrawStage(state, body.request_id);
            try {
                const result = await request('/api/image/vectorize', body);
                state.result = result; state.revision = Date.now();
                if(state.options.onResult?.(result) === false) state.error = '原图节点已改变。SVG 仍可下载，请重新选择图片继续转换。';
            } catch(error){ state.error = error.message; }
            finally { state.requestId = ''; state.busy = false; renderState(state); }
        };
        dialog.showModal();
        global.lucide?.createIcons({root:dialog});
        renderState(state);
        void detect(state);
        if(state.mode === 'api' && !state.busy) void loadApiModels(state);
    }
    global.XiaomeiImageVectorizer = {open, close};
})(window);
