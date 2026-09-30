(function(){
    'use strict';

    const DEFAULT_INTENSITY = 80;
    const ANALYSIS_MAX_EDGE = 192;
    const LOCAL_DB_NAME = 'xiaomei-canvas-local';
    const LOCAL_DB_VERSION = 1;
    const LOCAL_RESULT_STORE = 'smart-color-results';

    let localDbPromise = null;

    function clamp(value, min, max){
        return Math.max(min, Math.min(max, value));
    }

    function escapeHtml(value){
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value){
        return escapeHtml(value).replace(/\n/g, '&#10;');
    }

    function normalizeState(node){
        if(!node || typeof node !== 'object') return {
            intensity:DEFAULT_INTENSITY,
            preserveLuminance:true
        };
        const intensity = clamp(Math.round(Number(node.colorIntensity ?? node.restoreStrength ?? DEFAULT_INTENSITY) || 0), 0, 100);
        const preserveLuminance = node.preserveLuminance !== false;
        node.title = '色彩还原';
        node.colorIntensity = intensity;
        node.preserveLuminance = preserveLuminance;
        node.w = Math.max(320, Math.round(Number(node.w) || 380));
        node.h = Math.max(360, Math.round(Number(node.h) || 394));
        if(node.colorProcessing !== true) node.colorProcessing = false;
        return {intensity, preserveLuminance};
    }

    function imageUrl(source){
        return String(source?.url || source?.originalUrl || source?.src || '').trim();
    }

    function defaultPreview(item, role){
        const url = imageUrl(item);
        if(!url) return '';
        const label = role === 'output' ? '色彩还原结果' : role === 'reference' ? '参考图' : '待修复图片';
        return `<img class="color-node-preview-image" src="${escapeAttr(url)}" alt="${escapeAttr(label)}" loading="lazy" decoding="async">`;
    }

    function previewMarkup(item, role, context){
        if(!imageUrl(item)) return '';
        const html = typeof context.renderImage === 'function'
            ? context.renderImage(item, role)
            : defaultPreview(item, role);
        if(role !== 'output') return html;
        return `<div class="color-node-output-wrap image-wrap" data-image-index="0">${html}</div>`;
    }

    function inputPlaceholder(icon, label, detail){
        return `<div class="color-node-preview-empty"><i data-lucide="${escapeAttr(icon)}"></i><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div>`;
    }

    function bodyHtml(node, context={}){
        const state = normalizeState(node);
        const target = context.target || null;
        const reference = context.reference || null;
        const output = context.output || null;
        const hasInputs = Boolean(target?.url && reference?.url);
        const previewHeight = Number(context.previewHeight);
        const previewRatio = Number(context.previewRatio);
        const previewStyle = (Number.isFinite(previewHeight) && previewHeight > 0 ? '--color-node-preview-height:' + Math.round(previewHeight) + 'px;' : '')
            + (Number.isFinite(previewRatio) && previewRatio > 0 ? '--color-node-preview-ratio:' + Math.max(0.18, Math.min(5.5, previewRatio)) + ';' : '');
        const previewStyleAttr = previewStyle ? ' style="' + escapeAttr(previewStyle) + '"' : '';
        let preview = '';
        if(output?.url){
            preview = previewMarkup(output, 'output', context);
        } else if(target?.url){
            preview = `<div class="color-node-source-preview">${previewMarkup(target, 'target', context)}<span class="color-node-preview-badge">待修复</span></div>`;
        } else {
            preview = inputPlaceholder('image-plus', '连接待修复图片', '从左侧第一个输入端口接入');
        }
        let status = '连接两张图片后开始还原';
        let statusClass = '';
        if(node.colorProcessing){
            status = '正在还原色彩…';
            statusClass = 'running';
        } else if(node.colorLocalHydrating){
            status = '正在读取本地结果…';
            statusClass = 'running';
        } else if(node.colorError){
            status = String(node.colorError);
            statusClass = 'error';
        } else if(node.colorLocalError){
            status = String(node.colorLocalError);
            statusClass = 'error';
        } else if(target?.url && !reference?.url){
            status = '还需连接参考图片';
        } else if(hasInputs && output?.url){
            status = node.colorStorage === 'indexeddb' ? '已完成，已保存到浏览器本地' : '已完成，可继续调整强度';
        } else if(hasInputs){
            status = '准备还原色彩';
        }
        const statusIcon = statusClass === 'error' ? 'circle-alert' : (node.colorProcessing || node.colorLocalHydrating) ? 'loader-circle' : hasInputs ? 'check-circle-2' : 'info';
        const previewBadge = output?.url ? '<span class="color-node-output-badge">输出</span>' : '';
        return `<div class="color-node-card">
            <div class="color-node-title-row"><span class="color-node-title-icon">C</span><strong>色彩还原</strong></div>
            <div class="color-node-preview ${output?.url ? 'has-output' : ''}"${previewStyleAttr}>${preview}${previewBadge}</div>
            <div class="color-node-control-head"><span>还原强度</span><strong data-color-intensity-value>${state.intensity}%</strong></div>
            <input class="color-node-intensity" data-color-intensity type="range" min="0" max="100" step="1" value="${state.intensity}" aria-label="还原强度" style="--color-node-intensity:${state.intensity}%">
            <label class="color-node-preserve"><input data-color-preserve type="checkbox" ${state.preserveLuminance ? 'checked' : ''}><span class="color-node-check" aria-hidden="true"><i data-lucide="check"></i></span><span>保持原有明暗</span></label>
            <div class="color-node-status ${statusClass}" role="status" aria-live="polite"><i data-lucide="${statusIcon}"></i><span>${escapeHtml(status)}</span></div>
        </div>`;
    }

    function bindNode(el, node, callbacks={}){
        if(!el || !node) return;
        const controls = el.querySelectorAll('.color-node-card input, .color-node-card button, .color-node-output-wrap');
        const stop = event => event.stopPropagation();
        controls.forEach(control => {
            control.addEventListener('mousedown', stop);
            control.addEventListener('click', stop);
            control.addEventListener('dblclick', stop);
            control.addEventListener('wheel', stop, {passive:true});
        });
        let undoStarted = false;
        const beginChange = () => {
            if(undoStarted) return;
            undoStarted = true;
            callbacks.onBeforeChange?.(node);
        };
        const finishChange = detail => {
            callbacks.onChange?.(node, detail || {});
            undoStarted = false;
        };
        const intensity = el.querySelector('[data-color-intensity]');
        const value = el.querySelector('[data-color-intensity-value]');
        const updateIntensityUi = raw => {
            const next = clamp(Math.round(Number(raw) || 0), 0, 100);
            if(value) value.textContent = `${next}%`;
            if(intensity){
                intensity.value = String(next);
                intensity.style.setProperty('--color-node-intensity', `${next}%`);
            }
        };
        if(intensity){
            intensity.addEventListener('pointerdown', beginChange);
            intensity.addEventListener('keydown', beginChange);
            intensity.addEventListener('input', event => {
                beginChange();
                node.colorIntensity = clamp(Math.round(Number(event.target.value) || 0), 0, 100);
                updateIntensityUi(node.colorIntensity);
                callbacks.onChange?.(node, {input:true, committed:false});
            });
            intensity.addEventListener('change', event => {
                node.colorIntensity = clamp(Math.round(Number(event.target.value) || 0), 0, 100);
                updateIntensityUi(node.colorIntensity);
                finishChange({input:true, committed:true});
            });
        }
        const preserve = el.querySelector('[data-color-preserve]');
        if(preserve){
            preserve.addEventListener('pointerdown', beginChange);
            preserve.addEventListener('change', event => {
                beginChange();
                node.preserveLuminance = Boolean(event.target.checked);
                finishChange({preserve:true, committed:true});
            });
        }
    }

    function loadImage(source){
        const url = imageUrl(source);
        if(!url) return Promise.reject(new Error('缺少可读取的图片地址'));
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.crossOrigin = 'anonymous';
            image.decoding = 'async';
            let settled = false;
            const fail = () => {
                if(settled) return;
                settled = true;
                reject(new Error('读取输入图片失败，请确认图片仍可访问'));
            };
            image.onload = () => {
                if(settled) return;
                settled = true;
                if(!image.naturalWidth || !image.naturalHeight) return reject(new Error('输入图片没有有效尺寸'));
                resolve(image);
            };
            image.onerror = fail;
            image.src = url;
            if(image.complete && image.naturalWidth){
                const decoded = typeof image.decode === 'function' ? image.decode() : null;
                if(decoded?.finally) decoded.catch(() => {}).finally(() => image.onload?.());
                else image.onload?.();
            }
        });
    }

    function scaledSize(width, height, maxEdge=ANALYSIS_MAX_EDGE){
        const longestEdge = Math.max(width, height);
        const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
        return {
            width:Math.max(1, Math.round(width * scale)),
            height:Math.max(1, Math.round(height * scale))
        };
    }

    function createCanvas(width, height){
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', {willReadFrequently:true});
        if(!ctx) throw new Error('当前浏览器不支持图片色彩处理');
        return {canvas, ctx};
    }

    function openLocalDatabase(){
        if(!globalThis.indexedDB){
            return Promise.reject(new Error('当前浏览器不支持本地数据库'));
        }
        if(localDbPromise) return localDbPromise;
        localDbPromise = new Promise((resolve, reject) => {
            const request = globalThis.indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if(!database.objectStoreNames.contains(LOCAL_RESULT_STORE)){
                    database.createObjectStore(LOCAL_RESULT_STORE, {autoIncrement:true});
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('打开本地数据库失败'));
        }).catch(error => {
            localDbPromise = null;
            throw error;
        });
        return localDbPromise;
    }

    function putLocalResult(record){
        return openLocalDatabase().then(database => new Promise((resolve, reject) => {
            const transaction = database.transaction(LOCAL_RESULT_STORE, 'readwrite');
            const request = transaction.objectStore(LOCAL_RESULT_STORE).add(record);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('写入本地结果失败'));
        }));
    }

    function getLocalResult(id){
        const numericId = Number(id);
        if(!Number.isFinite(numericId)) return Promise.resolve(null);
        return openLocalDatabase().then(database => new Promise((resolve, reject) => {
            const transaction = database.transaction(LOCAL_RESULT_STORE, 'readonly');
            const request = transaction.objectStore(LOCAL_RESULT_STORE).get(numericId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('读取本地结果失败'));
        }));
    }

    async function saveResult(blob, metadata={}){
        const url = URL.createObjectURL(blob);
        let localDbId = '';
        try{
            localDbId = await putLocalResult({
                blob,
                name:metadata.name || '色彩还原.png',
                width:metadata.width || 0,
                height:metadata.height || 0,
                derivedFrom:metadata.derivedFrom || '',
                referenceFrom:metadata.referenceFrom || '',
                createdAt:Date.now()
            });
        }catch(error){
            // IndexedDB 失败时保留本次会话的 Blob URL，仍不上传到外部接口。
            console.warn('[SmartColorNode] 本地数据库保存失败，将仅保留本次会话结果', error);
        }
        return {
            url,
            name:metadata.name || '色彩还原.png',
            kind:'image',
            natural_w:metadata.width || 0,
            natural_h:metadata.height || 0,
            local_db_id:localDbId || '',
            local_storage:localDbId ? 'indexeddb' : 'session',
            _localBlobReady:true,
            _localBlobUrl:url
        };
    }

    async function hydrateMediaItem(item){
        if(!item || !item.local_db_id) return false;
        if(item._localBlobReady && item._localBlobUrl && item.url === item._localBlobUrl) return false;
        const record = await getLocalResult(item.local_db_id);
        if(!record || !record.blob) return false;
        if(item._localBlobUrl && item._localBlobUrl !== item.url){
            URL.revokeObjectURL(item._localBlobUrl);
        }
        const url = URL.createObjectURL(record.blob);
        item.url = url;
        item.name = item.name || record.name || '色彩还原.png';
        item.kind = item.kind || 'image';
        item.natural_w = item.natural_w || record.width || 0;
        item.natural_h = item.natural_h || record.height || 0;
        item.local_storage = 'indexeddb';
        item._localBlobReady = true;
        item._localBlobUrl = url;
        return true;
    }

    function srgbToLinear(value){
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function linearToSrgb(value){
        const v = clamp(value, 0, 1);
        return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    }

    function pivotLab(value){
        const delta = 6 / 29;
        return value > delta * delta * delta ? Math.cbrt(value) : value / (3 * delta * delta) + 4 / 29;
    }

    function pivotLabInverse(value){
        const delta = 6 / 29;
        return value > delta ? value * value * value : 3 * delta * delta * (value - 4 / 29);
    }

    function rgbToLab(r, g, b){
        const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
        const x = pivotLab((rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047);
        const y = pivotLab((rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000);
        const z = pivotLab((rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    }

    function labToRgb(l, a, b){
        const y = (l + 16) / 116;
        const x = a / 500 + y;
        const z = y - b / 200;
        const xr = pivotLabInverse(x) * 0.95047;
        const yr = pivotLabInverse(y);
        const zr = pivotLabInverse(z) * 1.08883;
        const rl = xr * 3.2404542 + yr * -1.5371385 + zr * -0.4985314;
        const gl = xr * -0.9692660 + yr * 1.8760108 + zr * 0.0415560;
        const bl = xr * 0.0556434 + yr * -0.2040259 + zr * 1.0572252;
        return [
            Math.round(clamp(linearToSrgb(rl) * 255, 0, 255)),
            Math.round(clamp(linearToSrgb(gl) * 255, 0, 255)),
            Math.round(clamp(linearToSrgb(bl) * 255, 0, 255))
        ];
    }

    function imageStats(data, width, height){
        const total = width * height;
        const stride = Math.max(1, Math.ceil(Math.sqrt(total / 500000)));
        const sum = [0, 0, 0];
        const sumSq = [0, 0, 0];
        let count = 0;
        for(let y=0; y<height; y+=stride){
            for(let x=0; x<width; x+=stride){
                const offset = (y * width + x) * 4;
                if(data[offset + 3] < 8) continue;
                const lab = rgbToLab(data[offset], data[offset + 1], data[offset + 2]);
                for(let i=0; i<3; i++){
                    sum[i] += lab[i];
                    sumSq[i] += lab[i] * lab[i];
                }
                count += 1;
            }
        }
        if(!count) return {mean:[50, 0, 0], std:[1, 1, 1]};
        const mean = sum.map(value => value / count);
        const std = sumSq.map((value, index) => Math.max(0.0001, Math.sqrt(Math.max(0, value / count - mean[index] * mean[index]))));
        return {mean, std};
    }

    async function process(options={}){
        const targetImage = await loadImage(options.target);
        const referenceImage = await loadImage(options.reference);
        // 统计只看最长边 192px 的缩略图，输出画布仍保持待修复图片的原始尺寸。
        const targetSize = {
            width:Math.max(1, Math.round(targetImage.naturalWidth)),
            height:Math.max(1, Math.round(targetImage.naturalHeight))
        };
        const targetAnalysisSize = scaledSize(targetSize.width, targetSize.height);
        const referenceAnalysisSize = scaledSize(referenceImage.naturalWidth, referenceImage.naturalHeight);
        const targetCanvas = createCanvas(targetSize.width, targetSize.height);
        const targetAnalysisCanvas = createCanvas(targetAnalysisSize.width, targetAnalysisSize.height);
        const referenceAnalysisCanvas = createCanvas(referenceAnalysisSize.width, referenceAnalysisSize.height);
        targetCanvas.ctx.drawImage(targetImage, 0, 0, targetSize.width, targetSize.height);
        targetAnalysisCanvas.ctx.drawImage(targetImage, 0, 0, targetAnalysisSize.width, targetAnalysisSize.height);
        referenceAnalysisCanvas.ctx.drawImage(referenceImage, 0, 0, referenceAnalysisSize.width, referenceAnalysisSize.height);
        const targetData = targetCanvas.ctx.getImageData(0, 0, targetSize.width, targetSize.height);
        const targetAnalysisData = targetAnalysisCanvas.ctx.getImageData(0, 0, targetAnalysisSize.width, targetAnalysisSize.height);
        const referenceAnalysisData = referenceAnalysisCanvas.ctx.getImageData(0, 0, referenceAnalysisSize.width, referenceAnalysisSize.height);
        const targetStats = imageStats(targetAnalysisData.data, targetAnalysisSize.width, targetAnalysisSize.height);
        const referenceStats = imageStats(referenceAnalysisData.data, referenceAnalysisSize.width, referenceAnalysisSize.height);
        const amount = clamp(Number(options.intensity) || 0, 0, 100) / 100;
        const preserveLuminance = options.preserveLuminance !== false;
        const pixels = targetData.data;
        for(let offset=0; offset<pixels.length; offset+=4){
            if(pixels[offset + 3] < 8) continue;
            const sourceLab = rgbToLab(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
            const mapped = sourceLab.map((value, index) => referenceStats.mean[index] + ((value - targetStats.mean[index]) / targetStats.std[index]) * referenceStats.std[index]);
            if(preserveLuminance) mapped[0] = sourceLab[0];
            const blended = sourceLab.map((value, index) => value + (mapped[index] - value) * amount);
            const rgb = labToRgb(blended[0], blended[1], blended[2]);
            pixels[offset] = rgb[0];
            pixels[offset + 1] = rgb[1];
            pixels[offset + 2] = rgb[2];
        }
        targetCanvas.ctx.putImageData(targetData, 0, 0);
        const blob = await new Promise(resolve => targetCanvas.canvas.toBlob(resolve, 'image/png'));
        if(!blob) throw new Error('色彩还原结果导出失败');
        return {blob, width:targetSize.width, height:targetSize.height};
    }

    window.SmartColorNode = {
        bodyHtml,
        bindNode,
        normalizeState,
        process,
        saveResult,
        hydrateMediaItem
    };
})();
