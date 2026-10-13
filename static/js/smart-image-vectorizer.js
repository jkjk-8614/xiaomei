(function(global){
    'use strict';
    const sessions = new Map();
    let activeDialog = null;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    async function request(url, body){
        const response = await fetch(url, body ? {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
        } : {cache:'no-store'});
        const data = await response.json();
        if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请重试');
        return data;
    }

    function renderState(state){
        const dialog = activeDialog;
        if(!dialog?.isConnected || dialog.vectorState !== state) return;
        const result = state.result;
        dialog.querySelector('[data-vector-convert]').disabled = state.busy || !state.status?.vtracer_ready;
        dialog.querySelector('[data-vector-convert]').textContent = state.busy ? '转换中…' : result ? '重新转换' : '转换为 SVG';
        dialog.querySelectorAll('select').forEach(control => control.disabled = state.busy);
        dialog.querySelector('[data-vector-download]').disabled = !result || state.busy;
        dialog.querySelector('[data-vector-refresh]').disabled = !result || state.busy;
        dialog.querySelector('[data-vector-status]').textContent = state.error || (state.busy ? 'VTracer 正在本机转换。关闭面板后转换会继续。' : result ? `${result.width} × ${result.height} · ${result.path_count} 条路径 · ${(result.size_bytes / 1024).toFixed(1)} KB` : '选择图片类型和细节程度，然后开始转换。');
        dialog.querySelector('[data-vector-status]').classList.toggle('has-error', Boolean(state.error));
        dialog.querySelector('[data-vector-status]').setAttribute('aria-busy', String(state.busy));
        dialog.querySelector('[data-vector-engine]').textContent = !state.status ? '正在检测转换引擎…' : state.status.vtracer_ready ? 'VTracer 已就绪 · 本机转换' : 'VTracer 未安装，请安装项目依赖后重启小美画布。';
        const image = dialog.querySelector('[data-vector-result]');
        dialog.querySelector('[data-vector-empty]').hidden = Boolean(result);
        image.hidden = !result;
        const previewUrl = result ? `${result.url}${result.url.includes('?') ? '&' : '?'}vector-preview=${state.revision || 0}` : '';
        if(result && image.getAttribute('src') !== previewUrl) image.src = previewUrl;
    }

    async function detect(state){
        state.error = '';
        try { state.status = await request('/api/image-vectorizer/status'); }
        catch(error){ state.error = error.message; }
        renderState(state);
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
            state = {busy:false, result:options.result || null, status:null, error:'', revision:0};
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
            <div class="smart-vector-controls">
                <label>图片类型<select data-vector-preset><option value="logo">Logo / 图标</option><option value="illustration">插画</option></select></label>
                <label>细节程度<select data-vector-detail><option value="simple">简化</option><option value="balanced">均衡</option><option value="fine">保留细节</option></select></label>
                <label>颜色模式<select data-vector-color><option value="color">彩色</option><option value="binary">黑白</option></select></label>
            </div>
            <div class="smart-vector-previews">
                <figure><figcaption>原图</figcaption><div class="smart-vector-image"><img src="${esc(options.previewUrl || options.sourceUrl)}" alt="待转换的原图"></div></figure>
                <figure><figcaption>SVG 预览<button type="button" data-vector-refresh disabled>刷新预览</button></figcaption><div class="smart-vector-image"><span data-vector-empty>转换后在这里查看效果</span><img data-vector-result alt="SVG 转换结果" hidden></div></figure>
            </div>
            <p class="smart-vector-status" data-vector-status role="status" aria-live="polite"></p>
            <div class="smart-vector-tools"><span data-vector-engine></span></div>
            <footer class="smart-vector-footer"><button type="button" class="image-edit-btn primary" data-vector-convert disabled>转换为 SVG</button><button type="button" class="image-edit-btn secondary" data-vector-download disabled>下载 SVG</button></footer>`;
        document.body.append(dialog);
        activeDialog = dialog;
        dialog.querySelector('[data-vector-preset]').value = settings.preset || 'logo';
        dialog.querySelector('[data-vector-detail]').value = settings.detail || 'balanced';
        dialog.querySelector('[data-vector-color]').value = settings.color_mode || 'color';
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
            if(state.busy) return;
            state.settings = {
                preset:dialog.querySelector('[data-vector-preset]').value,
                detail:dialog.querySelector('[data-vector-detail]').value,
                color_mode:dialog.querySelector('[data-vector-color]').value
            };
            state.busy = true; state.error = ''; renderState(state);
            try {
                const result = await request('/api/image/vectorize', {source_url:options.sourceUrl, name:options.name || '', ...state.settings});
                state.result = result; state.revision = Date.now();
                if(state.options.onResult?.(result) === false) state.error = '原图节点已改变。SVG 仍可下载，请重新选择图片继续转换。';
            } catch(error){ state.error = error.message; }
            finally { state.busy = false; renderState(state); }
        };
        dialog.showModal();
        global.lucide?.createIcons({root:dialog});
        renderState(state);
        void detect(state);
    }
    global.XiaomeiImageVectorizer = {open, close};
})(window);
