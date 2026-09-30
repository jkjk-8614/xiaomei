(function () {
    'use strict';
    let dialog, activeJob, sourceNode, sourceImage, busy = false, pollTimer, requestId, pendingPayload;
    const jobs = new Map();
    const createdOnCanvas = new Set();
    const pollErrors = new Set();
    const photoshopReceipts = new Map();
    const pendingKey = () => `xiaomei:layers:pending:${canvasId}:${sourceNode?.id}:${encodeURIComponent(sourceImage?.url || '')}`;
    const esc = value => escapeHtml(String(value ?? ''));
    const statuses = {queued:'等待生成', generating:'生成中', generated:'等待检查', ready:'检查通过', 'needs-review':'需要复核', failed:'生成失败'};
    function layerPhase(job, layer) {
        if (pollErrors.has(job.id)) return '进度暂时无法确认，正在重新查询';
        if (layer.cutout_url && !layer.url) return layer.status === 'generating' ? '已抠取 · 正在补齐' : '已抠取 · 待补齐';
        if (!layer.url && !layer.aligned_url) {
            if (job.status === 'failed') return '未生成 · 任务失败';
            if (job.status === 'paused') return '未生成 · 已暂停';
            if (job.status !== 'running') return '未生成';
        }
        if (job.status !== 'running' && ['queued','generating','generated'].includes(layer.status)) return '已生成 · 尚未检查';
        return statuses[layer.status] || job.phase || '等待生成';
    }
    function progress(job) {
        const layers = job.layers || [];
        const done = layers.filter(layer => layer.url || layer.aligned_url).length;
        const state = {running:'处理中',paused:'已暂停',failed:'任务失败',completed:'已完成','needs-review':'待复核'}[job.status] || job.status;
        if (pollErrors.has(job.id)) return `进度暂时无法确认，正在重新查询${layers.length ? ` · 上次已生成 ${done}/${layers.length} 层` : ''}`;
        if (!layers.length) return `${state} · ${job.phase || '等待图层规划'}`;
        const generating = layers.filter(layer => layer.status === 'generating').length;
        const waiting = layers.filter(layer => !layer.url && !layer.aligned_url && layer.status === 'queued').length;
        return `${state} · 已生成 ${done}/${layers.length} 层${job.status === 'running' ? ` · 生成中 ${generating} 层 · 等待 ${waiting} 层` : ` · 未生成 ${layers.length-done} 层`}\n${job.phase || ''}`;
    }
    async function api(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(()=>controller.abort(),30000);
        try {
            const response = await fetch('/api/image-layers' + path, {...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}),signal:controller.signal});
            const data = await response.json();
            if (!response.ok) {const error = new Error(typeof data.detail === 'string' ? data.detail : '分层请求失败，请检查参数和模型配置');error.status=response.status;throw error;}
            return data;
        } finally {clearTimeout(timeout);}
    }
    function options(entries) {
        return entries.map(x => `<option value="${escapeAttr(JSON.stringify([x.providerId,x.model]))}">${esc(x.providerName)} · ${esc(x.model)}</option>`).join('');
    }
    function showPreview(url, view) {
        if (!url) return;
        dialog.querySelector('.image-layers-stage img').src = url;
        dialog.querySelectorAll('[data-view]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.view === view));
        });
    }
    function ensureDialog() {
        if (dialog) return;
        dialog = document.createElement('dialog'); dialog.className = 'image-layers-dialog'; dialog.tabIndex = -1; dialog.setAttribute('aria-label', 'AI 分层');
        dialog.innerHTML = `<header><div><strong>AI 分层</strong><p>由 AI 生成独立图层，保留原图对照</p></div><button data-close aria-label="关闭">×</button></header>
          <div class="image-layers-body"><section class="image-layers-preview"><nav aria-label="预览图像"><button data-view="original" aria-pressed="true">原图</button><button data-view="composite" aria-pressed="false">合成预览</button></nav><div class="image-layers-stage"><img alt="分层预览"></div></section>
          <aside aria-label="分层设置与图层"><section class="image-layers-results"><h3>分层图层</h3><div class="image-layers-list"></div></section><fieldset class="image-layers-settings"><legend>分层设置</legend>
          <div class="image-layers-field image-layers-field-full"><label>图层数量<select data-mode aria-label="图层数量模式"><option value="auto">智能</option><option value="custom">自定义</option></select></label><small>包含一个背景层，其余按主体、文字和装饰分配。</small><label data-count-label hidden>目标层数 <output>5</output> 层<input data-count type="range" min="2" max="12" value="5"></label></div>
          <label class="image-layers-field image-layers-field-full">分析模型<select data-analysis aria-label="分析模型"></select></label>
          <label class="image-layers-field image-layers-field-full">生图模型<select data-image aria-label="生图模型"></select></label>
          <label class="image-layers-field">输出分辨率<select data-resolution><option>auto</option><option>1K</option><option selected>2K</option><option>4K</option></select></label>
          <label class="image-layers-field">同时处理<select data-concurrency aria-label="同时生成层数"><option value="1">1 层</option><option value="2">2 层</option><option value="3" selected>3 层</option></select></label>
          <label class="image-layers-field image-layers-field-full">自动纠错<select data-retries aria-label="自动纠错次数"><option value="0">关闭，仅标记问题</option><option value="1" selected>每层最多 1 次</option><option value="2">每层最多 2 次</option></select></label></fieldset>
          <div class="image-layers-history"><label>分层记录<select data-history aria-label="分层记录"><option value="">新建分层</option></select></label></div>
          <details class="image-layers-note"><summary>分层与费用说明</summary><p>新分层由 AI 分析图片并生成背景、主体、文字和装饰等独立图层，再合成预览。分析、生成、检查与纠错可能计费。网络错误先恢复原任务。文字默认是图像图层；选中文字层后可提交智能改字，结果仍需对照原图复核。选项只影响新建或重新分层，继续与单层重试沿用原任务设置。</p></details>
          <div class="image-layers-feedback"><p data-status role="status" aria-live="polite"></p><p data-error role="alert"></p><p data-review></p></div></aside></div>
          <footer><div class="image-layers-footer-info"><small data-budget></small><small>合成预览不代表检查通过。PSD 包含独立图层、智能对象及隐藏的原图对照。</small><small data-photoshop-status role="status"></small></div><div class="image-layers-actions"><button data-compose type="button" hidden>生成合成预览</button><button data-stop hidden>停止后续处理</button><button data-resume hidden>继续处理</button><button data-psd hidden>下载 PSD</button><button data-photoshop hidden>在 Photoshop 打开</button><button data-start class="primary">开始分层</button></div></footer>`;
        document.body.append(dialog);
        dialog.querySelector('[data-close]').onclick = () => dialog.close();
        dialog.querySelector('[data-close]').title = '收起窗口，不停止已提交的分层任务';
        dialog.querySelector('[data-compose]').onclick = () => act(async () => {
            accept(await api('/' + activeJob.id + '/preview', {}));
            showPreview(activeJob.composite_url, 'composite');
        });
        dialog.querySelector('[data-mode]').onchange = e => { dialog.querySelector('[data-count-label]').hidden = e.target.value !== 'custom'; paint(); };
        dialog.querySelector('[data-count]').oninput = e => { dialog.querySelector('output').textContent = e.target.value; paint(); };
        dialog.querySelector('[data-retries]').onchange = () => paint();
        dialog.querySelector('[data-start]').onclick = () => act(start);
        dialog.querySelector('[data-stop]').onclick = () => act(async () => accept(await api('/'+activeJob.id+'/stop', {})));
        dialog.querySelector('[data-resume]').onclick = () => act(async () => {
            const job = await api('/'+activeJob.id+'/resume', {});
            createdOnCanvas.add(job.id);
            accept(job);
        });
        dialog.querySelector('[data-psd]').onclick = () => act(exportPsd);
        dialog.querySelector('[data-photoshop]').onclick = () => act(sendPhotoshop);
        dialog.querySelector('[data-history]').onchange = e => act(async () => {
            activeJob = e.target.value ? await api('/'+e.target.value) : null;
            if(activeJob) {applyControls(activeJob.request);accept(activeJob);}
            showPreview(activeJob?.source_url || sourceImage.url, 'original');
            paint();
        });
        dialog.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
            const url = button.dataset.view === 'original' ? (activeJob?.source_url || sourceImage.url) : activeJob?.composite_url;
            showPreview(url, button.dataset.view);
        });
    }
    function applyControls(req) {
        dialog.querySelector('[data-analysis]').value = JSON.stringify([req.analysis_provider,req.analysis_model]);
        dialog.querySelector('[data-image]').value = JSON.stringify([req.image_provider,req.image_model]);
        dialog.querySelector('[data-resolution]').value = req.resolution;
        dialog.querySelector('[data-concurrency]').value = req.concurrency ?? 1;
        dialog.querySelector('[data-retries]').value = req.max_retries ?? 0;
        dialog.querySelector('[data-mode]').value = req.layer_count ? 'custom' : 'auto';
        dialog.querySelector('[data-count]').value = req.layer_count || 5;
        dialog.querySelector('output').textContent = req.layer_count || 5;
        dialog.querySelector('[data-count-label]').hidden = !req.layer_count;
    }
    async function act(fn) {
        if (busy) return;
        busy = true; paint();
        dialog.querySelector('[data-error]').textContent = '';
        try { await fn(); }
        catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
        finally { busy = false; paint(false); }
    }
    function paint(clearError=true) {
        if (!dialog) return;
        const running = activeJob?.status === 'running';
        const count = dialog.querySelector('[data-mode]').value === 'custom' ? Number(dialog.querySelector('[data-count]').value) : 12;
        const attempts = 1 + Number(dialog.querySelector('[data-retries]').value);
        const cutoutHistory = activeJob?.request.method === 'cutout_fill';
        dialog.querySelector('[data-budget]').textContent = `本次自动流程最多调用生图 ${count * attempts} 次${dialog.querySelector('[data-mode]').value === 'auto' ? '（智能分层按最多 12 层估算）' : ''}，另有分析与检查调用。手动重试另计。${cutoutHistory ? '当前为历史抠图任务，点击“重新分层”将使用 AI 生成整层。' : ''}`;
        dialog.querySelector('[data-history]').disabled = busy || !!pendingPayload;
        dialog.querySelector('fieldset').disabled = busy || running || !!pendingPayload;
        dialog.querySelector('[data-start]').disabled = busy || running || !dialog.querySelector('[data-analysis]').value || !dialog.querySelector('[data-image]').value;
        dialog.querySelector('[data-stop]').hidden = !running;
        dialog.querySelector('[data-compose]').hidden = running || !!activeJob?.composite_url
            || !activeJob?.layers?.length || !activeJob.layers.every(layer => layer.url);
        dialog.querySelector('[data-resume]').hidden = !activeJob || !['paused','failed'].includes(activeJob.status);
        dialog.querySelector('[data-psd]').hidden = !activeJob?.composite_url || running;
        dialog.querySelector('[data-photoshop]').hidden = !activeJob?.composite_url || running;
        const psReceipt = photoshopReceipts.get(activeJob?.id);
        dialog.querySelector('[data-photoshop-status]').textContent = psReceipt?.revision === activeJob?.revision ? psReceipt?.message || '' : '';
        dialog.querySelector('[data-view="composite"]').disabled = !activeJob?.composite_url;
        dialog.querySelector('[data-status]').textContent = pendingPayload ? '上次提交尚未确认，继续查询原请求；确认后才能修改参数。' : (activeJob ? progress(activeJob) : '选择模型后开始分层');
        dialog.querySelector('[data-start]').textContent = pendingPayload ? '确认上次提交' : activeJob && !running ? '重新分层' : '开始分层';
        if (pendingPayload) dialog.querySelector('[data-start]').disabled = busy;
        const finalIssues = [...(activeJob?.composition_issues || []), ...(activeJob?.composite_review?.issues || [])];
        dialog.querySelector('[data-review]').textContent = Array.isArray(finalIssues) && finalIssues.length ? '合成复核：' + finalIssues.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('；') : '';
        if (clearError) dialog.querySelector('[data-error]').textContent = activeJob?.error || '';
        dialog.querySelectorAll('.image-layers-actions button:not([data-start])').forEach(b => {b.disabled = busy;});
        const list = dialog.querySelector('.image-layers-list');
        list.innerHTML = (activeJob?.layers || []).map(layer => {
            const url = layer.aligned_url || layer.url || layer.cutout_url;
            const issues = [layer.alpha_issue, layer.alpha_repair, layer.completion_issue, layer.alignment_issue, layer.aspect_issue, layer.resolution_issue, layer.error, ...(Array.isArray(layer.issues) ? layer.issues : [])].filter(Boolean).map(x => typeof x === 'string' ? x : JSON.stringify(x));
            return `<article><button data-layer-preview="${esc(layer.id)}" ${url ? '' : 'disabled'}>${url ? `<img src="${escapeAttr(url)}" alt="">` : '<span>⋯</span>'}</button><div><strong>${esc(layer.name)}</strong><small>${layer.method_label ? esc(layer.method_label) + ' · ' : ''}${esc(layerPhase(activeJob, layer))}${layer.auto_retries ? ` · 已自动纠错 ${esc(layer.auto_retries)} 次` : ''}</small>${issues.length ? `<p>${esc(issues.join('；'))}</p>` : ''}</div>${url ? `<a href="${escapeAttr(url)}" download="${escapeAttr(layer.name)}.png">PNG</a>` : ''}<button data-retry="${esc(layer.id)}" ${busy || running || (layer.source_locked && !layer.needs_fill) ? 'disabled' : ''}>${layer.source_locked ? '重试补齐' : '重试'}</button></article>`;
        }).join('');
        list.querySelectorAll('[data-layer-preview]').forEach(button => button.onclick = () => {
            const layer = activeJob.layers.find(x => x.id === button.dataset.layerPreview);
            showPreview(layer.aligned_url || layer.url || layer.cutout_url, null);
        });
        list.querySelectorAll('[data-retry]').forEach(button => button.onclick = () => {
            const layer = activeJob.layers.find(x => x.id === button.dataset.retry);
            if (!confirm(`${layer.source_locked ? '重新补齐' : '重新生成'}「${layer.name}」将再次调用模型，可能产生费用。${layer.upstream_task_id || layer.recovery_id ? '此层留有生成回执，建议先点“继续处理”恢复原结果。' : ''}继续？`)) return;
            act(async () => accept(await api(`/${activeJob.id}/layers/${layer.id}/retry`, {})));
        });
    }
    function syncCanvas(job, arrange = false) {
        if (!canvas || canvasId !== job.request.project_id || sharedCanvasReadOnly) return;
        const source = nodes.find(n => n.id === job.request.source_node_id);
        if (!source) return;
        if (source.imageLayerHiddenJobIds?.includes(job.id)) return;
        const existingComposite = nodes.find(n => n.imageLayerJobId === job.id && n.imageLayerId === 'composite');
        // A saved canvas with no composite has had this task's output removed.
        if (!existingComposite && !createdOnCanvas.has(job.id)) return;
        const sourceRect = nodeRect(source);
        const width = Math.min(320, Math.max(220, sourceRect.width));
        const ratio = (job.width || job.source_width || 3) / (job.height || job.source_height || 4);
        const height = Math.min(480, Math.max(180, width / ratio));
        const startX = source.x + sourceRect.width + 140;
        const layers = job.layers || [];
        const columns = Math.min(3, Math.max(1, layers.length));
        const rows = Math.ceil(layers.length / columns);
        const centerY = source.y + sourceRect.height / 2;
        const startY = centerY - (rows * height + Math.max(0, rows - 1) * 100) / 2;
        // Migrate only untouched legacy two-column placement, not user-arranged nodes.
        if (!arrange && layers.length > 2) {
            arrange = layers.every((layer, i) => {
                const n = nodes.find(n => n.imageLayerJobId === job.id && n.imageLayerId === layer.id);
                return n && Math.abs(n.x - (startX + (i % 2) * (width + 140))) < 2
                    && Math.abs(n.y - (source.y + Math.floor(i / 2) * (height + 100))) < 2;
            });
        }
        let changed = false;
        const update = (node, values) => {
            for (const [key, value] of Object.entries(values)) {
                if (node[key] !== value) {node[key] = value; changed = true;}
            }
        };
        let combined = existingComposite;
        if (!combined) {
            combined = createNode(startX, source.y, [], {skipUndo:true, select:false, title:'分层合成'});
            if (!combined) return;
            Object.assign(combined, {imageLayerJobId:job.id, imageLayerId:'composite', w:width, h:height, manualSize:true});
            addConnection(source.id, combined.id, 'flow');
            changed = true;
        }
        const expanding = layers.length && !combined.imageLayerExpanded;
        if (expanding || (arrange && layers.length)) {
            update(combined, {x:startX + columns * (width + 140), y:centerY - height / 2,
                w:width, h:height, manualSize:true, imageLayerExpanded:true});
            canvas.connections = canvas.connections.filter(c => !(c.from === source.id && c.to === combined.id && (c.kind || 'flow') === 'flow'));
        }
        for (const [i, layer] of layers.entries()) {
            if (source.imageLayerDeletedNodeKeys?.includes(`${job.id}:${layer.id}`)) continue;
            let node = nodes.find(n => n.imageLayerJobId === job.id && n.imageLayerId === layer.id);
            if (!node) {
                if (!createdOnCanvas.has(job.id) && job.status !== 'running') continue;
                node = createNode(startX + (i % columns) * (width + 140), startY + Math.floor(i / columns) * (height + 100), [], {skipUndo:true, select:false, title:layer.name});
                if (!node) continue;
                Object.assign(node, {imageLayerJobId:job.id, imageLayerId:layer.id, w:width, h:height, manualSize:true});
                addConnection(source.id, node.id, 'flow');
                addConnection(node.id, combined.id, 'flow');
                changed = true;
            }
            if (arrange) update(node, {x:startX + (i % columns) * (width + 140),
                y:startY + Math.floor(i / columns) * (height + 100), w:width, h:height, manualSize:true});
            update(node, {title:`${layer.name} · ${layerPhase(job, layer)}`,
                imageLayerStatus:job.status, imageLayerPhase:layerPhase(job, layer),
                imageLayerError:layer.error || (['failed','paused'].includes(job.status) ? job.error : '')});
            const url = layer.aligned_url || layer.url || layer.cutout_url;
            if ((url && node.images?.[0]?.url !== url) || (!url && node.images?.length)) {
                node.images = url ? [{url, name:layer.name+'.png', kind:'image', natural_w:job.width, natural_h:job.height}] : [];
                changed = true;
            }
        }
        update(combined, {title:job.status === 'completed' ? '分层合成' : `分层合成 · ${job.phase || '等待分析'}`,
            imageLayerStatus:job.status, imageLayerPhase:progress(job), imageLayerError:job.error || ''});
        if ((job.composite_url && combined.images?.[0]?.url !== job.composite_url) || (!job.composite_url && combined.images?.length)) {
            combined.images = job.composite_url ? [{url:job.composite_url, name:'分层合成.png', kind:'image', natural_w:job.width, natural_h:job.height}] : [];
            changed = true;
        }
        if (changed) {render(); scheduleSave();}
    }
    window.smartImageLayerBodyHtml = function(node) {
        const running = ['queued','running'].includes(node.imageLayerStatus);
        return `<div class="image-layers-node-state" role="status">${running ? '<span class="image-layers-spinner" aria-hidden="true"></span>' : ''}<strong>${esc(node.imageLayerPhase || '分层记录')}</strong>${node.imageLayerError ? `<p>${esc(node.imageLayerError)}</p>` : ''}<button type="button" data-image-layer-job="${escapeAttr(node.imageLayerJobId)}">${running ? '查看进度' : '查看分层'}</button></div>`;
    };
    const exportingJobs = new Set();
    window.smartImageLayerActionsHtml = function(node) {
        if (sharedCanvasReadOnly || node.imageLayerId !== 'composite' || !node.images?.some(image => image.url)) return '';
        const disabled = exportingJobs.has(node.imageLayerJobId) || ['queued', 'running'].includes(node.imageLayerStatus);
        return `<div class="image-layer-node-actions"><button type="button" data-layer-editor-job="${escapeAttr(node.imageLayerJobId)}" title="编辑分层" aria-label="编辑分层" ${disabled ? 'disabled' : ''}>编辑</button><button type="button" data-layer-export="photoshop" data-layer-export-job="${escapeAttr(node.imageLayerJobId)}" title="在 Photoshop 打开完整分层 PSD" aria-label="在 Photoshop 打开" ${disabled ? 'disabled' : ''}>Ps</button><button type="button" data-layer-export="download" data-layer-export-job="${escapeAttr(node.imageLayerJobId)}" title="下载 PSD" aria-label="下载 PSD" ${disabled ? 'disabled' : ''}>↓ PSD</button></div>`;
    };
    document.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-layer-export]')) event.stopPropagation();
    }, true);
    document.addEventListener('click', async event => {
        const editor = event.target.closest('[data-layer-editor-job]');
        if (editor) {
            event.preventDefault(); event.stopPropagation();
            try { await openLayerEditor(editor.dataset.layerEditorJob); }
            catch (error) { toast(error.message || '打开分层编辑器失败'); }
            return;
        }
        const button = event.target.closest('[data-layer-export]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        const id = button.dataset.layerExportJob;
        if (sharedCanvasReadOnly || exportingJobs.has(id)) return;
        exportingJobs.add(id); render();
        try {
            const job = await api('/' + id);
            if (['queued', 'running'].includes(job.status)) throw new Error('图层正在处理，请完成后再导出');
            if (button.dataset.layerExport === 'photoshop') {
                await sendPhotoshop(job);
            } else {
                await exportPsd(true, job);
                toast('PSD 已打包，开始下载');
            }
        } catch (error) {toast(error.message);}
        finally {exportingJobs.delete(id); render();}
    }, true);

    async function openLayerEditor(jobId) {
        const response = await fetch(`/api/image-layers/${encodeURIComponent(jobId)}`);
        const job = await response.json();
        if (!response.ok) throw new Error(job.detail || '分层任务不存在');
        if (!job.layers?.length || !job.composite_url) throw new Error('请等待分层合成完成');
        const dialog = document.createElement('dialog');
        dialog.className = 'image-layer-editor-dialog';
        const state = job.layers.map(layer => ({
            id: layer.id, name: layer.name, kind: layer.kind || 'object',
            edit: {...(layer.edit || {})}, url: layer.aligned_url || layer.url,
            visible: layer.edit?.visible !== false, locked: !!layer.edit?.locked
        }));
        const renderRows = () => state.map((layer, index) => `<article data-editor-row="${escapeAttr(layer.id)}"><button class="image-layer-editor-eye" data-eye="${escapeAttr(layer.id)}">${layer.visible ? '显示' : '隐藏'}</button><strong>${escapeHtml(layer.name)}</strong><small>${escapeHtml(layer.kind)} · ${layer.locked ? '已锁定' : '可编辑'}</small><div><label>X <input data-edit="x" data-id="${escapeAttr(layer.id)}" type="number" step="1" value="${Number(layer.edit.x || 0)}"></label><label>Y <input data-edit="y" data-id="${escapeAttr(layer.id)}" type="number" step="1" value="${Number(layer.edit.y || 0)}"></label><label>缩放 <input data-edit="scale" data-id="${escapeAttr(layer.id)}" type="number" min="0.05" max="8" step="0.05" value="${Number(layer.edit.scale || 1)}"></label><label>旋转 <input data-edit="rotation" data-id="${escapeAttr(layer.id)}" type="number" min="-180" max="180" step="1" value="${Number(layer.edit.rotation || 0)}"></label>${layer.kind === 'text' ? `<label class="image-layer-editor-text">AI 改字 <input data-text-id="${escapeAttr(layer.id)}" type="text" maxlength="500" placeholder="输入替换文字"></label><button type="button" data-text-edit="${escapeAttr(layer.id)}">生成改字图</button>` : ''}</div></article>`).join('');
        dialog.innerHTML = `<form method="dialog"><header><div><strong>编辑分层</strong><p>调整位置和显示状态不会调用模型，保存后生成新的合成版本。</p></div><button value="cancel" aria-label="关闭">×</button></header><div class="image-layer-editor-body"><section class="image-layer-editor-preview"><img src="${escapeAttr(job.composite_url)}" alt="分层合成预览"><p data-editor-status>可以调整图层位置、缩放、旋转、顺序和可见性。</p></section><aside class="image-layer-editor-list"><div data-editor-rows>${renderRows()}</div></aside></div><footer><button value="cancel">取消</button><button type="button" data-editor-save class="primary">保存编辑</button></footer></form>`;
        document.body.append(dialog); dialog.showModal();
        const rows = dialog.querySelector('[data-editor-rows]');
        rows.addEventListener('input', event => { const id=event.target.dataset.id, key=event.target.dataset.edit, item=state.find(x=>x.id===id); if(item&&key){item.edit[key]=Number(event.target.value);}});
        rows.addEventListener('click', event => { const button=event.target.closest('[data-eye]'); if(!button)return; const item=state.find(x=>x.id===button.dataset.eye); if(!item)return; item.visible=!item.visible; item.edit.visible=item.visible; rows.innerHTML=renderRows(); });
        rows.addEventListener('click', async event => { const button=event.target.closest('[data-text-edit]'); if(!button)return; const input=rows.querySelector(`[data-text-id="${CSS.escape(button.dataset.textEdit)}"]`); const text=input?.value?.trim(); if(!text){dialog.querySelector('[data-editor-status]').textContent='请输入要替换的文字';return;} button.disabled=true; try { const response=await fetch(`/api/image-layers/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(button.dataset.textEdit)}/text-edit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}); const data=await response.json(); if(!response.ok) throw new Error(data.detail||'智能改字提交失败'); dialog.querySelector('[data-editor-status]').textContent='改字任务已提交，关闭后可在分层记录中查看进度'; toast('智能改字任务已提交'); } catch(error){dialog.querySelector('[data-editor-status]').textContent=error.message;} finally {button.disabled=false;} });
        dialog.querySelector('[data-editor-save]').onclick = async () => {
            const save = dialog.querySelector('[data-editor-save]'); save.disabled=true;
            try { const result=await fetch(`/api/image-layers/${encodeURIComponent(jobId)}/editor`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({layers:state.map(x=>({id:x.id,edit:{...x.edit,visible:x.visible,locked:x.locked}}))})}); const data=await result.json(); if(!result.ok) throw new Error(data.detail || '保存分层编辑失败'); jobs.set(data.id, data); syncCanvas(data); if(activeJob?.id === data.id) { activeJob=data; paint(); } dialog.close(); dialog.remove(); toast('分层编辑已保存'); }
            catch(error){ dialog.querySelector('[data-editor-status]').textContent=error.message; save.disabled=false; }
        };
        dialog.addEventListener('close', () => dialog.remove(), {once:true});
    }
    document.addEventListener('click', async event => {
        const button = event.target.closest('[data-image-layer-job]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        try {
            const job = await api('/' + button.dataset.imageLayerJob);
            const source = nodes.find(n => n.id === job.request.source_node_id);
            const index = source?.images?.findIndex(img => smartOriginalMediaUrl(img) === job.request.source_url);
            if (index == null || index < 0) {toast('原图节点已移除，请从分层记录查看结果'); return;}
            await window.openSmartImageLayers(source.id, index);
            activeJob = job; applyControls(job.request); accept(job);
            dialog.querySelector('[data-history]').value = job.id;
        } catch (error) {toast(error.message);}
    }, true);
    function accept(job) {
        pollErrors.delete(job.id); jobs.set(job.id, job); syncCanvas(job);
        if (!activeJob || activeJob.id === job.id) {
            activeJob = job; paint();
        }
        if (job.status === 'running') schedulePoll();
    }
    function schedulePoll() {
        if (pollTimer) return;
        pollTimer = setTimeout(async () => {
            pollTimer = null;
            for (const job of jobs.values()) {
                if (job.status !== 'running') continue;
                try { const current = await api('/'+job.id); pollErrors.delete(job.id); jobs.set(current.id, current); syncCanvas(current); if(activeJob?.id===current.id){activeJob=current;paint();} }
                catch (_) { pollErrors.add(job.id); syncCanvas(job); if (activeJob?.id === job.id) paint(); }
            }
            if ([...jobs.values()].some(j => j.status === 'running')) schedulePoll();
        }, 2000);
    }
    async function start() {
        const [analysis_provider, analysis_model] = pendingPayload ? [pendingPayload.analysis_provider, pendingPayload.analysis_model] : JSON.parse(dialog.querySelector('[data-analysis]').value);
        const [image_provider, image_model] = pendingPayload ? [pendingPayload.image_provider, pendingPayload.image_model] : JSON.parse(dialog.querySelector('[data-image]').value);
        requestId ||= window.XiaomeiLayerPsd.uuid();
        const payload = pendingPayload || {source_url:sourceImage.url, source_node_id:sourceNode.id, project_id:canvasId, request_id:requestId,
            analysis_provider, analysis_model, image_provider, image_model, method:'regenerate',
            resolution:dialog.querySelector('[data-resolution]').value,
            concurrency:Number(dialog.querySelector('[data-concurrency]').value), max_retries:Number(dialog.querySelector('[data-retries]').value),
            layer_count:dialog.querySelector('[data-mode]').value === 'custom' ? Number(dialog.querySelector('[data-count]').value) : null};
        try {localStorage.setItem(pendingKey(), JSON.stringify(payload));} catch (_) {}
        pendingPayload = payload;
        // Pending submissions made by older clients keep their original generation method.
        if (!payload.method) payload.method = 'regenerate';
        let job;
        try {job = await api('', payload);}
        catch(error) {
            if([400,404,409,422].includes(error.status)) {requestId=null;pendingPayload=null;try{localStorage.removeItem(pendingKey());}catch(_){}}
            throw error;
        }
        try {localStorage.removeItem(pendingKey());} catch (_) {}
        pendingPayload = null;
        pushUndo();
        sourceNode.imageLayerTaskIds = [...new Set([...(sourceNode.imageLayerTaskIds || []),job.id])];
        createdOnCanvas.add(job.id);
        scheduleSave(); activeJob = job; accept(job); requestId = null;
        const history = dialog.querySelector('[data-history]');
        const option = new Option(new Date(job.created_at*1000).toLocaleString(), job.id); history.add(option, 1); history.value = job.id;
        dialog.close();
        toast('分层已开始，请在画布查看输出节点和进度。');
    }
    async function exportPsd(download=true, job=activeJob) {
        if (!job) return;
        const exportingJob = JSON.parse(JSON.stringify(job));
        if (dialog && activeJob?.id === job.id) dialog.querySelector('[data-status]').textContent = '正在打包 PSD…';
        const bytes = await window.XiaomeiLayerPsd.build(exportingJob);
        const response = await fetch(`/api/image-layers/${exportingJob.id}/psd?revision=${encodeURIComponent(exportingJob.revision || '')}`, {method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:bytes});
        const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'PSD 保存失败');
        if (download) {const link = document.createElement('a'); link.href = result.url; link.download = 'AI分层.psd'; link.click();}
        if (activeJob?.id === exportingJob.id && activeJob.revision === exportingJob.revision) activeJob.psd_url = result.url;
        return {...exportingJob, psd_url:result.url};
    }
    async function bridge(path, body) {
        const response = await fetch('/api/photoshop-bridge' + path, {...(body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(30000)});
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Photoshop 桥接请求失败');
        return data;
    }
    async function sendPhotoshop(job=activeJob) {
        if (!job) return;
        const selectedJob = JSON.parse(JSON.stringify(job));
        const status = await bridge('/status');
        const snapshot = selectedJob.psd_url ? selectedJob : await exportPsd(false, selectedJob);
        if (!status.online || !status.bridge?.capabilities?.includes('open-layered-psd')) {
            const result = await api(`/${snapshot.id}/photoshop/open?revision=${encodeURIComponent(snapshot.revision || '')}`, {});
            photoshopReceipts.set(snapshot.id, {revision:snapshot.revision, message:result.message});
            if (activeJob?.id === snapshot.id) paint();
            toast(result.message);
            return;
        }
        const result = await bridge('/send', {url:snapshot.psd_url, name:'AI分层.psd', canvas_id:snapshot.request.project_id, node_id:snapshot.request.source_node_id,
            open_mode:'document', request_id:`layers-${snapshot.id}-${snapshot.revision}`});
        const receipt = {revision:snapshot.revision, message:''};
        photoshopReceipts.set(snapshot.id, receipt);
        const update = job => {
            receipt.message = job.status === 'done' ? 'Photoshop 已确认打开分层文档。' : job.status === 'failed' ? 'Photoshop 打开失败：' + (job.error || '请在插件面板查看') : 'PSD 已进入 Photoshop 队列，等待插件确认打开。';
            if (!dialog?.open || activeJob?.id !== snapshot.id) toast(receipt.message);
            if (activeJob?.id === snapshot.id) paint();
        };
        update(result.job);
        let attempts = 0;
        const poll = async () => {
            try {
                const current = await bridge('/jobs/' + result.job.id);
                update(current.job);
                if (['done','failed'].includes(current.job.status)) return;
            } catch (_) {receipt.message = '暂时无法查询 Photoshop 回执，请在插件面板查看；重复点击会查询同一发送记录。';if(activeJob?.id===snapshot.id)paint();}
            if (++attempts < 60) setTimeout(poll, 2000);
        };
        if (!['done','failed'].includes(result.job.status)) setTimeout(poll, 2000);
    }
    window.openSmartImageLayers = async function(nodeId, index=0) {
        if (sharedCanvasReadOnly) return;
        if (busy) {toast('正在处理分层操作，请稍候');return;}
        sourceNode = nodes.find(n => n.id === nodeId);
        if (!sourceNode?.images?.[index]) return;
        sourceImage = {...sourceNode.images[index], url:smartOriginalMediaUrl(sourceNode.images[index])};
        ensureDialog(); activeJob = null; requestId = null; pendingPayload = null;
        let pending;
        try {pending = JSON.parse(localStorage.getItem(pendingKey()) || 'null');requestId = pending?.request_id || null;} catch (_) {}
        pendingPayload = pending || null;
        showPreview(sourceImage.url, 'original');
        dialog.querySelector('[data-analysis]').innerHTML = options(chatApiProviders().flatMap(p => providerChatModels(p.id).map(model => ({providerId:p.id, providerName:p.name || p.id, model}))));
        dialog.querySelector('[data-image]').innerHTML = options(outpaintImageModelEntries());
        if (pending) applyControls(pending);
        dialog.showModal(); dialog.focus({preventScroll:true}); paint();
        await act(async () => {
            const allHistory = await api(`?project_id=${encodeURIComponent(canvasId)}&source_node_id=${encodeURIComponent(nodeId)}`);
            const history = allHistory.filter(j=>j.request.source_url===sourceImage.url);
            dialog.querySelector('[data-history]').innerHTML = '<option value="">新建分层</option>' + history.map(j => `<option value="${j.id}">${esc(new Date(j.created_at*1000).toLocaleString())} · ${esc(j.phase || j.status)}</option>`).join('');
            const recovered = history.find(j=>j.request.request_id===requestId);
            if (history.length && (!pendingPayload || recovered)) {
                activeJob=recovered || history[0];dialog.querySelector('[data-history]').value=activeJob.id;applyControls(activeJob.request);accept(activeJob);
                showPreview(activeJob.source_url || sourceImage.url, 'original');
                if (recovered) {requestId=null;pendingPayload=null;try{localStorage.removeItem(pendingKey());}catch(_){}}
            }
        });
    };
    // Resume progress subscriptions once the saved canvas has loaded.
    const restore = setInterval(async () => {
        if (!canvas || !canvasId) return;
        clearInterval(restore);
        try { for (const job of await api(`?project_id=${encodeURIComponent(canvasId)}`)) {
            jobs.set(job.id,job);
            if (job.status==='running' || nodes.some(n=>n.imageLayerJobId===job.id || n.imageLayerTaskIds?.includes(job.id))) syncCanvas(job);
            if(job.status==='running') schedulePoll();
        } } catch (_) { /* Opening the panel offers another history lookup. */ }
    }, 1500);
})();
