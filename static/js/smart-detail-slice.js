(function (global) {
    'use strict';

    const MIN_SLICE_GAP = 24;
    const MAX_HISTORY = 40;
    let activeDialog = null;

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    // ---- 纯前端标准 ZIP (Store) 打包工具（无需第三方库） ----
    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
            crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    async function buildZipBlob(entries) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        const now = new Date();
        const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
        const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

        for (const entry of entries) {
            const nameBytes = encoder.encode(entry.name);
            const data = new Uint8Array(await entry.blob.arrayBuffer());
            const crc = crc32(data);

            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true); // UTF-8
            lv.setUint16(8, 0, true); // Store
            lv.setUint16(10, dosTime, true);
            lv.setUint16(12, dosDate, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);
            local.set(nameBytes, 30);

            localParts.push(local, data);

            const central = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(central.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, dosTime, true);
            cv.setUint16(14, dosDate, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);
            cv.setUint16(32, 0, true);
            cv.setUint16(34, 0, true);
            cv.setUint16(36, 0, true);
            cv.setUint32(38, 0, true);
            cv.setUint32(42, offset, true);
            central.set(nameBytes, 46);
            centralParts.push(central);

            offset += local.length + data.length;
        }

        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);
        ev.setUint16(20, 0, true);

        return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
    }

    function triggerBlobDownload(blob, filename) {
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1500);
    }

    // ---- 切片核心算法 ----
    function normalizeCuts(rawCuts, height) {
        const sorted = Array.from(new Set(
            (rawCuts || [])
                .map(y => Math.round(Number(y)))
                .filter(y => Number.isFinite(y) && y >= MIN_SLICE_GAP && y <= height - MIN_SLICE_GAP)
        )).sort((a, b) => a - b);
        const result = [];
        for (const y of sorted) {
            if (!result.length || y - result[result.length - 1] >= MIN_SLICE_GAP) {
                result.push(y);
            }
        }
        return result;
    }

    function buildSegments(cuts, width, height) {
        const points = [0, ...normalizeCuts(cuts, height), height];
        const segments = [];
        for (let i = 0; i < points.length - 1; i++) {
            const top = points[i];
            const bottom = points[i + 1];
            const h = bottom - top;
            if (h <= 0) continue;
            segments.push({ index: i, top, bottom, width, height: h });
        }
        return segments;
    }

    function computeEqualCountCuts(height, count) {
        const n = clamp(Math.round(Number(count) || 4), 1, 60);
        if (n <= 1) return [];
        const cuts = [];
        for (let i = 1; i < n; i++) {
            cuts.push(Math.round((height * i) / n));
        }
        return normalizeCuts(cuts, height);
    }

    // ---- 加载支持像素读取的原图 ----
    function loadSliceImage(imageItem) {
        const directUrl = typeof global.displayMediaUrl === 'function'
            ? global.displayMediaUrl(imageItem)
            : (imageItem?.url || '');
        const rawUrl = String(imageItem?.url || directUrl || '').trim();
        const proxyUrl = rawUrl && !rawUrl.startsWith('data:') && !rawUrl.startsWith('blob:') && !rawUrl.startsWith('/')
            ? `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`
            : '';

        const tryLoad = (url, useCors) => new Promise((resolve, reject) => {
            if (!url) { reject(new Error('图片地址无效')); return; }
            const img = new Image();
            if (useCors) img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => {
                img.onload = img.onerror = null;
                reject(new Error('图片加载超时'));
            }, 25000);
            img.onload = () => {
                clearTimeout(timer);
                if (!img.naturalWidth || !img.naturalHeight) {
                    reject(new Error('图片尺寸无效'));
                    return;
                }
                resolve(img);
            };
            img.onerror = () => {
                clearTimeout(timer);
                reject(new Error('图片加载失败'));
            };
            img.src = url;
        });

        return (async () => {
            try {
                const img = await tryLoad(directUrl, true);
                // 验证是否可读取像素（非跨域污染）
                const probe = document.createElement('canvas');
                probe.width = 2;
                probe.height = 2;
                const pctx = probe.getContext('2d');
                pctx.drawImage(img, 0, 0, 2, 2);
                pctx.getImageData(0, 0, 1, 1);
                return img;
            } catch (_) {
                if (proxyUrl && proxyUrl !== directUrl) {
                    return tryLoad(proxyUrl, true);
                }
                return tryLoad(directUrl, false);
            }
        })();
    }

    function renderSegmentToBlob(img, seg, options) {
        const format = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = options.format === 'jpeg' ? 0.92 : undefined;
        const targetW = options.targetWidth > 0 ? Math.min(options.targetWidth, img.naturalWidth) : img.naturalWidth;
        const scale = targetW / img.naturalWidth;
        const targetH = Math.max(1, Math.round(seg.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (format === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetW, targetH);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, seg.top, img.naturalWidth, seg.height, 0, 0, targetW, targetH);

        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (!blob) reject(new Error('切片导出失败'));
                else resolve({ blob, width: targetW, height: targetH });
            }, format, quality);
        });
    }

    function baseFileName(imageItem) {
        const raw = typeof global.downloadNameForMediaItem === 'function'
            ? global.downloadNameForMediaItem(imageItem, 'detail')
            : (imageItem?.name || 'detail');
        const cleaned = String(raw || 'detail').replace(/\.[^.]+$/, '');
        return typeof global.safeExportFileName === 'function'
            ? global.safeExportFileName(cleaned, 'detail')
            : (cleaned.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'detail');
    }

    // ---- 主弹窗工作台 ----
    function openSmartDetailSlice(nodeId, imageIndex = 0) {
        const canvasNodes = typeof nodes !== 'undefined' ? nodes : global.nodes;
        if (!Array.isArray(canvasNodes)) return;
        const node = canvasNodes.find(item => item.id === nodeId);
        const rawItem = node?.images?.[imageIndex];
        const imageItem = typeof global.imageForDisplay === 'function' ? global.imageForDisplay(rawItem) : rawItem;
        if (!node || !imageItem?.url) {
            global.toast?.('当前节点没有可切片的图片');
            return;
        }

        if (activeDialog) {
            try { activeDialog.close(); } catch (_) {}
            activeDialog.remove();
            activeDialog = null;
        }

        const dialog = document.createElement('dialog');
        dialog.className = 'smart-slice-dialog';
        dialog.setAttribute('aria-label', '详情页长图切片');
        dialog.innerHTML = `
            <header class="smart-slice-header">
                <div class="smart-slice-title-wrap">
                    <strong>详情页长图切片</strong>
                    <span class="smart-slice-meta" data-slice-meta>正在加载原图…</span>
                </div>
                <button type="button" class="smart-slice-close" data-slice-close title="关闭" aria-label="关闭">
                    <i data-lucide="x"></i>
                </button>
            </header>
            <div class="smart-slice-body">
                <section class="smart-slice-stage-col">
                    <div class="smart-slice-toolbar">
                        <div class="smart-slice-toolbar-group">
                            <button type="button" class="smart-slice-tool-btn" data-slice-add-mode title="开启后单击长图即可添加分割线">
                                <i data-lucide="plus"></i><span>点击加线</span>
                            </button>
                            <button type="button" class="smart-slice-tool-btn" data-slice-undo disabled title="撤销上一步分割线操作">
                                <i data-lucide="undo-2"></i><span>撤销</span>
                            </button>
                            <button type="button" class="smart-slice-tool-btn" data-slice-clear disabled title="清空所有分割线">
                                <i data-lucide="trash-2"></i><span>清空</span>
                            </button>
                        </div>
                        <div class="smart-slice-toolbar-group">
                            <label class="smart-slice-zoom-wrap">
                                <span>预览宽度</span>
                                <input type="range" min="260" max="760" step="20" value="460" data-slice-zoom>
                                <span class="smart-slice-zoom-val" data-slice-zoom-val>460px</span>
                            </label>
                        </div>
                    </div>
                    <div class="smart-slice-viewport" data-slice-viewport>
                        <div class="smart-slice-loading" data-slice-loading>正在加载高清原图…</div>
                        <div class="smart-slice-canvas-wrap" data-slice-wrap hidden>
                            <img class="smart-slice-img" data-slice-img alt="长图预览" draggable="false">
                            <div class="smart-slice-overlay" data-slice-overlay></div>
                            <div class="smart-slice-hover-line" data-slice-hover hidden><span></span></div>
                        </div>
                    </div>
                    <div class="smart-slice-stage-tip">
                        提示：直接上下拖拽蓝色分割线微调位置（按住 Shift 以 10px 对齐）；双击长图任意位置可快速新增分割线。
                    </div>
                </section>
                <aside class="smart-slice-sidebar">
                    <div class="smart-slice-controls-scroll">
                        <div class="smart-slice-tabs" role="tablist">
                            <button type="button" class="smart-slice-tab active" data-slice-tab="manual" role="tab">手动自定义</button>
                            <button type="button" class="smart-slice-tab" data-slice-tab="count" role="tab">等分数量</button>
                        </div>

                        <!-- 模式1：手动自定义 -->
                        <div class="smart-slice-panel" data-slice-panel="manual">
                            <p class="smart-slice-manual-hint">
                                已自动开启点击加线：在左侧长图任意位置<strong>单击</strong>即可落刀切分，拖拽蓝色分割线微调，点线尾 × 删除。
                            </p>
                            <div class="smart-slice-field">
                                <label for="smartSliceManualY">按精确 Y 坐标加线 (px)</label>
                                <div class="smart-slice-input-inline">
                                    <input id="smartSliceManualY" class="smart-slice-input" type="number" min="24" step="10" placeholder="例如 1200" data-slice-manual-y>
                                    <button type="button" class="smart-slice-tool-btn" data-slice-add-y>添加</button>
                                </div>
                            </div>
                            <div class="smart-slice-field">
                                <label for="smartSliceManualStep">按单屏高度逐屏追加 (+px)</label>
                                <div class="smart-slice-input-inline">
                                    <input id="smartSliceManualStep" class="smart-slice-input" type="number" min="24" step="50" value="1000" data-slice-manual-step>
                                    <button type="button" class="smart-slice-tool-btn" data-slice-append-step>追加一刀</button>
                                </div>
                            </div>
                            <div class="smart-slice-manual-actions">
                                <button type="button" class="smart-slice-tool-btn" data-slice-manual-clear>清空重切</button>
                                <button type="button" class="smart-slice-tool-btn" data-slice-manual-undo>撤销上一步</button>
                            </div>
                        </div>

                        <!-- 模式2：等分数量 -->
                        <div class="smart-slice-panel" data-slice-panel="count" hidden>
                            <div class="smart-slice-field">
                                <label for="smartSliceEqualCount">切分份数 (2 ~ 40)</label>
                                <div class="smart-slice-input-inline">
                                    <input id="smartSliceEqualCount" class="smart-slice-input" type="number" min="2" max="40" step="1" value="6" data-slice-equal-count>
                                    <button type="button" class="smart-slice-tool-btn" data-slice-apply-count>应用</button>
                                </div>
                            </div>
                            <div class="smart-slice-presets">
                                <button type="button" class="smart-slice-chip" data-count-preset="4">4 屏</button>
                                <button type="button" class="smart-slice-chip" data-count-preset="6">6 屏</button>
                                <button type="button" class="smart-slice-chip" data-count-preset="8">8 屏</button>
                                <button type="button" class="smart-slice-chip" data-count-preset="10">10 屏</button>
                                <button type="button" class="smart-slice-chip" data-count-preset="12">12 屏</button>
                            </div>
                        </div>

                        <!-- 导出参数 -->
                        <div class="smart-slice-export-grid">
                            <div class="smart-slice-field">
                                <label for="smartSliceFormat">导出格式</label>
                                <select id="smartSliceFormat" class="smart-slice-select" data-slice-format>
                                    <option value="png">PNG (无损)</option>
                                    <option value="jpeg">JPG (体积小)</option>
                                </select>
                            </div>
                            <div class="smart-slice-field">
                                <label for="smartSliceTargetWidth">导出宽度</label>
                                <select id="smartSliceTargetWidth" class="smart-slice-select" data-slice-target-width>
                                    <option value="0">保持原图宽度</option>
                                    <option value="750">750px (手淘)</option>
                                    <option value="790">790px (天猫)</option>
                                    <option value="800">800px</option>
                                </select>
                            </div>
                            <div class="smart-slice-field" style="grid-column: 1 / -1;">
                                <label for="smartSliceCanvasLayout">输出到画布方式</label>
                                <select id="smartSliceCanvasLayout" class="smart-slice-select" data-slice-layout>
                                    <option value="separate">每张切片单独创建上传节点</option>
                                    <option value="grouped">合并到一个上传节点</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div class="smart-slice-list-head">
                        <span data-slice-list-title>切片列表 (0)</span>
                        <div class="smart-slice-list-actions">
                            <button type="button" class="smart-slice-link-btn" data-slice-select-all>全选</button>
                            <button type="button" class="smart-slice-link-btn" data-slice-invert>反选</button>
                        </div>
                    </div>
                    <div class="smart-slice-list" data-slice-list></div>
                </aside>
            </div>
            <footer class="smart-slice-footer">
                <div class="smart-slice-status" data-slice-status>正在加载图片…</div>
                <div class="smart-slice-footer-actions">
                    <button type="button" class="smart-slice-btn" data-slice-download-zip disabled>
                        <i data-lucide="archive"></i><span>打包下载 ZIP</span>
                    </button>
                    <button type="button" class="smart-slice-btn primary" data-slice-output-canvas disabled>
                        <i data-lucide="layout-grid"></i><span>输出到画布</span>
                    </button>
                </div>
            </footer>
        `;

        document.body.appendChild(dialog);
        activeDialog = dialog;
        global.lucide?.createIcons?.({ root: dialog });

        const q = sel => dialog.querySelector(sel);
        const metaEl = q('[data-slice-meta]');
        const loadingEl = q('[data-slice-loading]');
        const viewportEl = q('[data-slice-viewport]');
        const wrapEl = q('[data-slice-wrap]');
        const imgEl = q('[data-slice-img]');
        const overlayEl = q('[data-slice-overlay]');
        const hoverLineEl = q('[data-slice-hover]');
        const listEl = q('[data-slice-list]');
        const listTitleEl = q('[data-slice-list-title]');
        const statusEl = q('[data-slice-status]');
        const zoomInput = q('[data-slice-zoom]');
        const zoomValEl = q('[data-slice-zoom-val]');
        const addModeBtn = q('[data-slice-add-mode]');
        const undoBtn = q('[data-slice-undo]');
        const clearBtn = q('[data-slice-clear]');
        const zipBtn = q('[data-slice-download-zip]');
        const outputBtn = q('[data-slice-output-canvas]');
        const equalCountInput = q('[data-slice-equal-count]');
        const manualYInput = q('[data-slice-manual-y]');
        const manualStepInput = q('[data-slice-manual-step]');
        const manualClearBtn = q('[data-slice-manual-clear]');
        const manualUndoBtn = q('[data-slice-manual-undo]');
        const formatSelect = q('[data-slice-format]');
        const widthSelect = q('[data-slice-target-width]');
        const layoutSelect = q('[data-slice-layout]');

        const state = {
            img: null,
            natW: 0,
            natH: 0,
            mode: 'manual',
            cuts: [],
            history: [],
            excluded: new Set(),
            addMode: true,
            previewWidth: 460,
            busy: false,
            highlightTimer: null,
            highlightIndex: -1,
            drag: null
        };

        function setStatus(text, isError = false) {
            statusEl.textContent = text;
            statusEl.classList.toggle('has-error', Boolean(isError));
        }

        function pushHistory() {
            state.history.push([...state.cuts]);
            if (state.history.length > MAX_HISTORY) state.history.shift();
        }

        function setCuts(nextCuts, { recordHistory = true, resetExcluded = false } = {}) {
            if (recordHistory) pushHistory();
            state.cuts = normalizeCuts(nextCuts, state.natH);
            if (resetExcluded) state.excluded.clear();
            else {
                const maxIdx = state.cuts.length;
                for (const idx of Array.from(state.excluded)) {
                    if (idx > maxIdx) state.excluded.delete(idx);
                }
            }
            renderAll();
        }

        function exportOptions() {
            return {
                format: formatSelect.value === 'jpeg' ? 'jpeg' : 'png',
                targetWidth: Number(widthSelect.value) || 0,
                layout: layoutSelect.value === 'grouped' ? 'grouped' : 'separate'
            };
        }

        function outputSizeFor(seg) {
            const opts = exportOptions();
            const targetW = opts.targetWidth > 0 ? Math.min(opts.targetWidth, state.natW) : state.natW;
            const scale = state.natW > 0 ? targetW / state.natW : 1;
            return {
                w: targetW,
                h: Math.max(1, Math.round(seg.height * scale))
            };
        }

        function renderAll() {
            if (!state.img) return;
            const segments = buildSegments(state.cuts, state.natW, state.natH);
            const selectedCount = segments.filter(seg => !state.excluded.has(seg.index)).length;

            // 预览宽度
            wrapEl.style.width = `${state.previewWidth}px`;
            wrapEl.classList.toggle('add-mode', state.addMode);
            addModeBtn.classList.toggle('active', state.addMode);
            zoomValEl.textContent = `${state.previewWidth}px`;
            undoBtn.disabled = state.busy || state.history.length === 0;
            clearBtn.disabled = state.busy || state.cuts.length === 0;
            if (manualUndoBtn) manualUndoBtn.disabled = undoBtn.disabled;
            if (manualClearBtn) manualClearBtn.disabled = clearBtn.disabled;
            zipBtn.disabled = state.busy || selectedCount === 0;
            outputBtn.disabled = state.busy || selectedCount === 0;

            // 渲染长图覆盖层：切片区间 + 分割线
            const segHtml = segments.map(seg => {
                const topPct = (seg.top / state.natH) * 100;
                const heightPct = (seg.height / state.natH) * 100;
                const excluded = state.excluded.has(seg.index);
                const highlighted = state.highlightIndex === seg.index;
                const out = outputSizeFor(seg);
                const label = `#${String(seg.index + 1).padStart(2, '0')} · ${out.w}×${out.h}`;
                return `<div class="smart-slice-segment${excluded ? ' is-excluded' : ''}${highlighted ? ' is-highlight' : ''}" data-seg-idx="${seg.index}" style="top:${topPct}%;height:${heightPct}%;">
                    <span class="smart-slice-badge">${esc(label)}${excluded ? ' (已跳过)' : ''}</span>
                </div>`;
            }).join('');

            const guideHtml = state.cuts.map((y, idx) => {
                const topPct = (y / state.natH) * 100;
                const dragging = state.drag && state.drag.index === idx;
                return `<div class="smart-slice-guide${dragging ? ' is-dragging' : ''}" data-guide-idx="${idx}" style="top:${topPct}%;">
                    <span class="smart-slice-guide-pill">
                        <span>Y ${y}px</span>
                        <button type="button" class="smart-slice-guide-del" data-guide-del="${idx}" title="删除此分割线" aria-label="删除此分割线">×</button>
                    </span>
                </div>`;
            }).join('');

            overlayEl.innerHTML = segHtml + guideHtml;

            // 渲染右侧切片清单
            listTitleEl.textContent = `切片列表 (${selectedCount} / ${segments.length})`;
            listEl.innerHTML = segments.map(seg => {
                const excluded = state.excluded.has(seg.index);
                const out = outputSizeFor(seg);
                const idxText = `#${String(seg.index + 1).padStart(2, '0')}`;
                return `<div class="smart-slice-item${excluded ? ' is-excluded' : ''}" data-list-seg="${seg.index}">
                    <input type="checkbox" ${excluded ? '' : 'checked'} data-list-check="${seg.index}" aria-label="选择切片 ${idxText}">
                    <span class="smart-slice-item-idx">${esc(idxText)}</span>
                    <div class="smart-slice-item-info">
                        <span class="smart-slice-item-size">${out.w} × ${out.h} px</span>
                        <span class="smart-slice-item-range">Y: ${seg.top} ~ ${seg.bottom} px</span>
                    </div>
                    <button type="button" class="smart-slice-item-dl" data-list-dl="${seg.index}" title="单独下载此切片" aria-label="单独下载此切片">
                        <i data-lucide="download"></i>
                    </button>
                </div>`;
            }).join('');
            global.lucide?.createIcons?.({ root: listEl });

            if (!state.busy) {
                setStatus(`共 ${segments.length} 张切片，已勾选 ${selectedCount} 张 · ${exportOptions().format.toUpperCase()}`);
            }
        }

        function applyModeCuts(mode, { recordHistory = true } = {}) {
            if (!state.img) return;
            if (mode === 'count') {
                const n = Number(equalCountInput.value) || 6;
                const cuts = computeEqualCountCuts(state.natH, n);
                setCuts(cuts, { recordHistory, resetExcluded: true });
            }
        }

        function clientYToNaturalY(clientY) {
            const rect = wrapEl.getBoundingClientRect();
            if (!rect.height || !state.natH) return 0;
            const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);
            return Math.round(ratio * state.natH);
        }

        function scrollToSegment(segIndex) {
            const segEl = overlayEl.querySelector(`[data-seg-idx="${segIndex}"]`);
            if (!segEl) return;
            segEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            state.highlightIndex = segIndex;
            renderAll();
            clearTimeout(state.highlightTimer);
            state.highlightTimer = setTimeout(() => {
                state.highlightIndex = -1;
                if (dialog.isConnected) renderAll();
            }, 950);
        }

        // ---- 事件绑定 ----
        const closeDialog = () => {
            if (state.busy) return;
            clearTimeout(state.highlightTimer);
            dialog.close();
        };
        q('[data-slice-close]').addEventListener('click', closeDialog);
        dialog.addEventListener('cancel', event => {
            if (state.busy) event.preventDefault();
        });
        dialog.addEventListener('close', () => {
            clearTimeout(state.highlightTimer);
            if (activeDialog === dialog) activeDialog = null;
            dialog.remove();
        });

        // 缩放
        zoomInput.addEventListener('input', () => {
            state.previewWidth = Number(zoomInput.value) || 460;
            renderAll();
        });

        // 点击加线 / 撤销 / 清空
        addModeBtn.addEventListener('click', () => {
            state.addMode = !state.addMode;
            hoverLineEl.hidden = true;
            renderAll();
        });
        undoBtn.addEventListener('click', () => {
            if (!state.history.length || state.busy) return;
            state.cuts = state.history.pop();
            renderAll();
        });
        clearBtn.addEventListener('click', () => {
            if (!state.cuts.length || state.busy) return;
            setCuts([], { recordHistory: true, resetExcluded: true });
        });

        // 模式 Tab
        dialog.querySelectorAll('[data-slice-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (state.busy) return;
                const mode = btn.dataset.sliceTab;
                state.mode = mode;
                dialog.querySelectorAll('[data-slice-tab]').forEach(t => t.classList.toggle('active', t === btn));
                dialog.querySelectorAll('[data-slice-panel]').forEach(p => { p.hidden = p.dataset.slicePanel !== mode; });
                if (mode === 'manual') {
                    state.addMode = true;
                    hoverLineEl.hidden = true;
                    renderAll();
                    setStatus('手动自定义模式：单击左侧长图即可落刀加线，拖拽分割线微调位置');
                    return;
                }
                state.addMode = false;
                hoverLineEl.hidden = true;
                applyModeCuts(mode, { recordHistory: true });
            });
        });

        // 手动自定义模式操作
        const addManualYCut = () => {
            if (state.busy || !state.img) return;
            const y = Math.round(Number(manualYInput.value));
            if (!Number.isFinite(y) || y < MIN_SLICE_GAP || y > state.natH - MIN_SLICE_GAP) {
                setStatus(`请输入 ${MIN_SLICE_GAP} ~ ${Math.max(MIN_SLICE_GAP, state.natH - MIN_SLICE_GAP)} 之间的像素坐标`, true);
                return;
            }
            const before = state.cuts.length;
            setCuts([...state.cuts, y], { recordHistory: true });
            if (state.cuts.length === before) {
                setStatus(`位置 Y ${y}px 与已有分割线距离过近（需 ≥ ${MIN_SLICE_GAP}px）`, true);
                return;
            }
            manualYInput.value = '';
            const insertedIdx = state.cuts.indexOf(y);
            if (insertedIdx >= 0) scrollToSegment(insertedIdx);
        };
        q('[data-slice-add-y]').addEventListener('click', addManualYCut);
        manualYInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') addManualYCut();
        });

        const appendManualStepCut = () => {
            if (state.busy || !state.img) return;
            const step = Math.round(Number(manualStepInput.value));
            if (!Number.isFinite(step) || step < MIN_SLICE_GAP) {
                setStatus(`单屏高度不能小于 ${MIN_SLICE_GAP}px`, true);
                return;
            }
            const lastY = state.cuts.length ? state.cuts[state.cuts.length - 1] : 0;
            const nextY = lastY + step;
            if (nextY > state.natH - MIN_SLICE_GAP) {
                setStatus(`已接近长图底部（剩余 ${Math.max(0, state.natH - lastY)}px），无法继续追加`, true);
                return;
            }
            setCuts([...state.cuts, nextY], { recordHistory: true });
            const insertedIdx = state.cuts.indexOf(nextY);
            if (insertedIdx >= 0) scrollToSegment(insertedIdx);
        };
        q('[data-slice-append-step]').addEventListener('click', appendManualStepCut);
        manualStepInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') appendManualStepCut();
        });
        manualClearBtn.addEventListener('click', () => {
            if (!state.cuts.length || state.busy) return;
            setCuts([], { recordHistory: true, resetExcluded: true });
            setStatus('已清空全部分割线，请单击左侧长图或输入坐标手动切片');
        });
        manualUndoBtn.addEventListener('click', () => {
            if (!state.history.length || state.busy) return;
            state.cuts = state.history.pop();
            renderAll();
        });

        // 等分数量参数
        q('[data-slice-apply-count]').addEventListener('click', () => applyModeCuts('count', { recordHistory: true }));
        equalCountInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') applyModeCuts('count', { recordHistory: true });
        });
        dialog.querySelectorAll('[data-count-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                equalCountInput.value = btn.dataset.countPreset;
                applyModeCuts('count', { recordHistory: true });
            });
        });

        // 导出设置变更实时刷新尺寸标注
        formatSelect.addEventListener('change', renderAll);
        widthSelect.addEventListener('change', renderAll);

        // 列表全选 / 反选 / 勾选 / 定位 / 单张下载
        q('[data-slice-select-all]').addEventListener('click', () => {
            state.excluded.clear();
            renderAll();
        });
        q('[data-slice-invert]').addEventListener('click', () => {
            const segments = buildSegments(state.cuts, state.natW, state.natH);
            const next = new Set();
            for (const seg of segments) {
                if (!state.excluded.has(seg.index)) next.add(seg.index);
            }
            state.excluded = next;
            renderAll();
        });

        listEl.addEventListener('click', async event => {
            const dlBtn = event.target.closest('[data-list-dl]');
            if (dlBtn) {
                event.stopPropagation();
                if (state.busy || !state.img) return;
                const idx = Number(dlBtn.dataset.listDl);
                const segments = buildSegments(state.cuts, state.natW, state.natH);
                const seg = segments[idx];
                if (!seg) return;
                try {
                    const opts = exportOptions();
                    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
                    const digits = Math.max(2, String(segments.length).length);
                    const { blob } = await renderSegmentToBlob(state.img, seg, opts);
                    triggerBlobDownload(blob, `${baseFileName(imageItem)}_${String(idx + 1).padStart(digits, '0')}.${ext}`);
                } catch (err) {
                    setStatus(err.message || '下载失败', true);
                }
                return;
            }
            const checkbox = event.target.closest('[data-list-check]');
            if (checkbox) {
                event.stopPropagation();
                const idx = Number(checkbox.dataset.listCheck);
                if (checkbox.checked) state.excluded.delete(idx);
                else state.excluded.add(idx);
                renderAll();
                return;
            }
            const item = event.target.closest('[data-list-seg]');
            if (item) {
                scrollToSegment(Number(item.dataset.listSeg));
            }
        });

        // 长图交互：拖拽分割线 / 删除分割线 / 单击或双击加线
        wrapEl.addEventListener('pointermove', event => {
            if (state.drag) return;
            if (!state.addMode || !state.img || event.target.closest('.smart-slice-guide')) {
                hoverLineEl.hidden = true;
                return;
            }
            const y = clientYToNaturalY(event.clientY);
            if (y < MIN_SLICE_GAP || y > state.natH - MIN_SLICE_GAP) {
                hoverLineEl.hidden = true;
                return;
            }
            hoverLineEl.hidden = false;
            hoverLineEl.style.top = `${(y / state.natH) * 100}%`;
            hoverLineEl.firstElementChild.textContent = `+ 添加分割线 Y ${y}px`;
        });
        wrapEl.addEventListener('pointerleave', () => { hoverLineEl.hidden = true; });

        wrapEl.addEventListener('click', event => {
            const delBtn = event.target.closest('[data-guide-del]');
            if (delBtn) {
                event.stopPropagation();
                if (state.busy) return;
                const idx = Number(delBtn.dataset.guideDel);
                const next = state.cuts.filter((_, i) => i !== idx);
                setCuts(next, { recordHistory: true });
                return;
            }
            if (!state.addMode || state.busy || !state.img) return;
            if (event.target.closest('.smart-slice-guide')) return;
            const y = clientYToNaturalY(event.clientY);
            if (y < MIN_SLICE_GAP || y > state.natH - MIN_SLICE_GAP) return;
            setCuts([...state.cuts, y], { recordHistory: true });
        });

        wrapEl.addEventListener('dblclick', event => {
            if (state.busy || !state.img || event.target.closest('.smart-slice-guide')) return;
            const y = clientYToNaturalY(event.clientY);
            if (y < MIN_SLICE_GAP || y > state.natH - MIN_SLICE_GAP) return;
            setCuts([...state.cuts, y], { recordHistory: true });
        });

        overlayEl.addEventListener('pointerdown', event => {
            if (state.busy || event.button !== 0) return;
            if (event.target.closest('[data-guide-del]')) return;
            const guide = event.target.closest('[data-guide-idx]');
            if (!guide) return;
            event.preventDefault();
            const index = Number(guide.dataset.guideIdx);
            const prevBound = index > 0 ? state.cuts[index - 1] + MIN_SLICE_GAP : MIN_SLICE_GAP;
            const nextBound = index < state.cuts.length - 1 ? state.cuts[index + 1] - MIN_SLICE_GAP : state.natH - MIN_SLICE_GAP;
            pushHistory();
            state.drag = {
                pointerId: event.pointerId,
                index,
                minY: prevBound,
                maxY: nextBound,
                moved: false
            };
            guide.setPointerCapture(event.pointerId);
            guide.classList.add('is-dragging');
        });

        overlayEl.addEventListener('pointermove', event => {
            if (!state.drag || state.drag.pointerId !== event.pointerId) return;
            event.preventDefault();
            let y = clientYToNaturalY(event.clientY);
            if (event.shiftKey) y = Math.round(y / 10) * 10;
            y = clamp(y, state.drag.minY, state.drag.maxY);
            if (state.cuts[state.drag.index] !== y) {
                state.cuts[state.drag.index] = y;
                state.drag.moved = true;
                // 高性能局部 DOM 更新，避免拖拽时重建整个 overlay
                const guide = overlayEl.querySelector(`[data-guide-idx="${state.drag.index}"]`);
                if (guide) {
                    guide.style.top = `${(y / state.natH) * 100}%`;
                    const label = guide.querySelector('.smart-slice-guide-pill span');
                    if (label) label.textContent = `Y ${y}px`;
                }
                const segments = buildSegments(state.cuts, state.natW, state.natH);
                for (const segIdx of [state.drag.index, state.drag.index + 1]) {
                    const seg = segments[segIdx];
                    const segEl = overlayEl.querySelector(`[data-seg-idx="${segIdx}"]`);
                    if (seg && segEl) {
                        segEl.style.top = `${(seg.top / state.natH) * 100}%`;
                        segEl.style.height = `${(seg.height / state.natH) * 100}%`;
                        const badge = segEl.querySelector('.smart-slice-badge');
                        if (badge) {
                            const out = outputSizeFor(seg);
                            const excluded = state.excluded.has(seg.index);
                            badge.textContent = `#${String(seg.index + 1).padStart(2, '0')} · ${out.w}×${out.h}${excluded ? ' (已跳过)' : ''}`;
                        }
                    }
                }
            }
        });

        const endGuideDrag = event => {
            if (!state.drag || (event && state.drag.pointerId !== event.pointerId)) return;
            const { moved } = state.drag;
            state.drag = null;
            if (!moved && state.history.length) state.history.pop();
            renderAll();
        };
        overlayEl.addEventListener('pointerup', endGuideDrag);
        overlayEl.addEventListener('pointercancel', endGuideDrag);

        // ---- 导出：打包下载 ZIP ----
        zipBtn.addEventListener('click', async () => {
            if (state.busy || !state.img) return;
            const segments = buildSegments(state.cuts, state.natW, state.natH)
                .filter(seg => !state.excluded.has(seg.index));
            if (!segments.length) return;
            state.busy = true;
            renderAll();
            try {
                const opts = exportOptions();
                const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
                const base = baseFileName(imageItem);
                const digits = Math.max(2, String(segments.length).length);
                const entries = [];
                for (let i = 0; i < segments.length; i++) {
                    setStatus(`正在渲染切片 ${i + 1} / ${segments.length}…`);
                    const { blob } = await renderSegmentToBlob(state.img, segments[i], opts);
                    entries.push({
                        name: `${base}_${String(i + 1).padStart(digits, '0')}.${ext}`,
                        blob
                    });
                }
                setStatus('正在打包 ZIP…');
                const zipBlob = await buildZipBlob(entries);
                triggerBlobDownload(zipBlob, `${base}_切片(${segments.length}张).zip`);
                global.toast?.(`已打包下载 ${segments.length} 张切片`);
                setStatus(`已下载 ${segments.length} 张切片 ZIP`);
            } catch (err) {
                setStatus(err.message || '打包下载失败', true);
            } finally {
                state.busy = false;
                renderAll();
            }
        });

        // ---- 导出：输出到画布 ----
        outputBtn.addEventListener('click', async () => {
            if (state.busy || !state.img) return;
            const segments = buildSegments(state.cuts, state.natW, state.natH)
                .filter(seg => !state.excluded.has(seg.index));
            if (!segments.length) return;
            if (typeof global.uploadImageBlobs !== 'function') {
                setStatus('画布上传接口不可用', true);
                return;
            }
            state.busy = true;
            renderAll();
            try {
                const opts = exportOptions();
                const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
                const base = baseFileName(imageItem);
                const digits = Math.max(2, String(segments.length).length);
                const blobs = [];
                const dims = [];
                for (let i = 0; i < segments.length; i++) {
                    setStatus(`正在生成切片 ${i + 1} / ${segments.length}…`);
                    const { blob, width, height } = await renderSegmentToBlob(state.img, segments[i], opts);
                    blobs.push({
                        blob,
                        name: `${base}_${String(i + 1).padStart(digits, '0')}.${ext}`
                    });
                    dims.push({ width, height });
                }

                setStatus(`正在上传 ${blobs.length} 张切片到画布…`);
                // 分批上传，避免单次 multipart 过大
                const uploaded = [];
                const chunkSize = 8;
                for (let start = 0; start < blobs.length; start += chunkSize) {
                    const batch = blobs.slice(start, start + chunkSize);
                    const files = await global.uploadImageBlobs(batch);
                    if (!Array.isArray(files) || files.length !== batch.length || files.some(f => !f?.url)) {
                        throw new Error('部分切片上传失败，请重试');
                    }
                    uploaded.push(...files);
                }

                const sliceImages = uploaded.map((file, i) => ({
                    ...file,
                    kind: 'image',
                    name: file.name || blobs[i].name,
                    natural_w: dims[i].width,
                    natural_h: dims[i].height,
                    width: dims[i].width,
                    height: dims[i].height
                }));

                const rect = typeof global.nodeRect === 'function'
                    ? global.nodeRect(node)
                    : { x: Number(node.x) || 0, y: Number(node.y) || 0, width: Number(node.w) || 260, height: Number(node.h) || 400 };
                const startX = rect.x + rect.width + 64;
                const startY = rect.y;

                global.pushUndo?.();
                const createdIds = [];
                if (opts.layout === 'grouped') {
                    const outNode = global.createNode?.(startX, startY, sliceImages, {
                        nodeType: SMART_UPLOAD_NODE_TYPE,
                        skipUndo: true,
                        select: true,
                        title: `${base} · 切片 (${sliceImages.length})`
                    });
                    if (outNode?.id) createdIds.push(outNode.id);
                } else {
                    const cols = Math.min(4, sliceImages.length);
                    const gapX = 28;
                    const gapY = 36;
                    let cursorX = startX;
                    let cursorY = startY;
                    let rowMaxH = 0;

                    for (let i = 0; i < sliceImages.length; i++) {
                        const imgObj = sliceImages[i];
                        const created = global.createNode?.(cursorX, cursorY, [imgObj], {
                            nodeType: SMART_UPLOAD_NODE_TYPE,
                            skipUndo: true,
                            select: false,
                            title: `${base}_${String(i + 1).padStart(digits, '0')}`
                        });
                        if (created) {
                            createdIds.push(created.id);
                            const cRect = typeof global.nodeRect === 'function'
                                ? global.nodeRect(created)
                                : { width: Number(created.w) || 240, height: Number(created.h) || 320 };
                            rowMaxH = Math.max(rowMaxH, cRect.height);
                            if ((i + 1) % cols === 0) {
                                cursorX = startX;
                                cursorY += rowMaxH + gapY;
                                rowMaxH = 0;
                            } else {
                                cursorX += cRect.width + gapX;
                            }
                        }
                    }
                    if (createdIds.length) {
                        if (typeof selectedId !== 'undefined') selectedId = createdIds[0];
                        if (typeof selectedIds !== 'undefined' && Array.isArray(selectedIds)) {
                            selectedIds = createdIds.slice();
                        }
                    }
                }

                global.render?.();
                global.scheduleSave?.();
                global.toast?.(`已切分并输出 ${sliceImages.length} 张切片到画布`);
                state.busy = false;
                dialog.close();
            } catch (err) {
                state.busy = false;
                renderAll();
                setStatus(err.message || '输出到画布失败', true);
            }
        });

        // ---- 打开弹窗并加载原图 ----
        dialog.showModal();
        loadSliceImage(imageItem).then(img => {
            if (!dialog.isConnected) return;
            state.img = img;
            state.natW = img.naturalWidth;
            state.natH = img.naturalHeight;
            const ratio = (state.natH / Math.max(1, state.natW)).toFixed(2);
            metaEl.textContent = `${state.natW} × ${state.natH} px · 高宽比 1 : ${ratio}`;
            imgEl.src = img.src;
            loadingEl.hidden = true;
            wrapEl.hidden = false;

            // 根据原图宽度自动设置更合理的预览宽度
            const stageW = Math.max(320, viewportEl.clientWidth - 90);
            state.previewWidth = clamp(Math.min(state.natW, Math.round(stageW * 0.72)), 300, 620);
            zoomInput.value = String(state.previewWidth);

            // 默认进入手动自定义模式，直接开启点击加线
            state.mode = 'manual';
            state.addMode = true;
            setCuts([], { recordHistory: false, resetExcluded: true });
            setStatus('手动自定义模式：单击左侧长图即可落刀加线，或切换到「等分数量」一键均分');
        }).catch(err => {
            if (!dialog.isConnected) return;
            loadingEl.textContent = err.message || '原图加载失败，请重试';
            setStatus(err.message || '原图加载失败', true);
        });
    }

    global.openSmartDetailSlice = openSmartDetailSlice;
    global.XiaomeiDetailSlice = {
        open: openSmartDetailSlice,
        computeEqualCountCuts,
        buildSegments,
        normalizeCuts
    };
})(window);
