(function (root) {
    'use strict';

    const constrain = (value, min, max) => Math.min(max, Math.max(min, value));
    const rectangle = ({ x, y, w, h }) => ({ x, y, w, h });
    const px = value => value + 'px';

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const stage = get('imageEditStage');
        const frame = get('cropCanvas');
        const source = get('cropImage');
        const box = get('cropBox');
        const expansion = get('outpaintFrame');
        const applyButton = get('imageEditApplyBtn');
        const fields = ['imageResizeScaleRange', 'imageResizeScaleInput'].map(get);
        const ratioButtons = frame.closest('#imageEditModal').querySelectorAll('[data-crop-ratio]');
        const geometry = root.XiaomeiImageEditGeometry;
        const fitRatio = root.XiaomeiCanvasEditorCore.cropRatioFromPreset;
        let base;
        let scale = 1;
        let preset = 'free';
        let resizeBy = 0.5;
        let gesture;
        let load;
        let timer;
        const submitting = new WeakSet();
        const expanding = () => host.mode() === 'outpaint';

        function displaySize() {
            const width = source.clientWidth;
            const height = source.clientHeight;
            if (width > 2 && height > 2) return { w: width, h: height };
            return {
                w: Math.max(1, Math.round((base?.w || source.naturalWidth || 1) * scale)),
                h: Math.max(1, Math.round((base?.h || source.naturalHeight || 1) * scale))
            };
        }

        function refit(force = false) {
            if (base && !force) return;
            const width = source.naturalWidth;
            const height = source.naturalHeight;
            if (!width || !height) return;
            const ocr = host.mode() === 'ocr';
            const maxW = ocr && stage.clientWidth ? Math.min(760, stage.clientWidth - 64) : Math.min(1300, root.innerWidth - 100);
            const maxH = ocr && stage.clientHeight ? Math.min(760, stage.clientHeight - 64) : Math.min(840, root.innerHeight - 200);
            const fit = Math.min(Math.max(1, maxW) / width, Math.max(1, maxH) / height);
            base = { w: Math.max(1, Math.round(width * fit)), h: Math.max(1, Math.round(height * fit)) };
        }

        function position(element, { x, y, w, h }) {
            Object.assign(element.style, { left: px(x), top: px(y), width: px(w), height: px(h) });
        }

        function outpaintSize() {
            const state = host.state();
            if (!state) return { w: 1, h: 1 };
            const display = displaySize();
            return {
                w: Math.max(1, Math.round(state.w * (source.naturalWidth || 1) / display.w)),
                h: Math.max(1, Math.round(state.h * (source.naturalHeight || 1) / display.h))
            };
        }

        function paint() {
            const state = host.state();
            if (!state) return;
            const outpaint = expanding();
            frame.style.width = outpaint ? px(Math.round(state.w)) : '';
            frame.style.height = outpaint ? px(Math.round(state.h)) : '';
            source.style.position = outpaint ? 'absolute' : '';
            for (const layer of [source, get('editDrawCanvas'), get('editTextCanvas')]) {
                layer.style.left = outpaint ? px(Math.round(state.x)) : '';
                layer.style.top = outpaint ? px(Math.round(state.y)) : '';
            }
            const visible = outpaint ? { ...state, x: 0, y: 0 } : state;
            position(box, visible);
            position(expansion, visible);
            const { w, h } = outpaintSize();
            frame.classList.toggle('outpaint-warning', outpaint && host.exceedsFourK(w, h));
            if (outpaint) get('outpaintResolution').textContent = w + ' x ' + h;
        }

        function overflow() {
            const bounds = frame.getBoundingClientRect();
            stage.classList.toggle('overflow-x', bounds.width + 36 > stage.clientWidth);
            stage.classList.toggle('overflow-y', bounds.height + 36 > stage.clientHeight);
        }

        function resizeSize() {
            return {
                targetW: Math.max(1, Math.round((source.naturalWidth || 1) * resizeBy)),
                targetH: Math.max(1, Math.round((source.naturalHeight || 1) * resizeBy))
            };
        }

        function resizeControls() {
            for (const field of fields) {
                if (Number(field.value) !== resizeBy) field.value = resizeBy;
            }
            const { targetW, targetH } = resizeSize();
            const size = targetW + '×' + targetH;
            get('imageResizeResolution').textContent = get('resizeResolutionOverlay').textContent = size;
        }

        for (const field of fields) {
            field.addEventListener('input', () => {
                const value = Number(field.value);
                resizeBy = Number.isFinite(value) ? constrain(Math.round(value * 100) / 100, 0.05, 1) : 0.5;
                resizeControls();
            });
        }

        function setRegion(rect) {
            const state = host.state();
            if (!state) return;
            const bound = expanding() ? geometry.boundExpansion : geometry.boundCrop;
            Object.assign(state, bound(rect, displaySize()));
            paint();
        }

        function applyZoom(factor) {
            if (!ready()) return;
            refit();
            if (!base) return;
            const before = displaySize();
            const size = root.XiaomeiCanvasEditorCore.imageEditZoomSize(base.w, base.h, scale);
            Object.assign(source.style, { width: px(size.width), height: 'auto', maxWidth: 'none', maxHeight: 'none' });
            const after = displaySize();
            const state = host.state();
            if (state) {
                const sx = factor || after.w / before.w;
                const sy = factor || after.h / before.h;
                setRegion({ x: Math.round(state.x * sx), y: Math.round(state.y * sy),
                    w: Math.round(state.w * sx), h: Math.round(state.h * sy) });
            }
            host.resizeDrawing();
            if (host.mode() === 'grid') host.refreshGrid();
            resizeControls();
            overflow();
            host.zoomChanged();
        }

        function resetZoom() {
            scale = 1;
            applyZoom();
            stage.scrollLeft = stage.scrollTop = 0;
        }

        function wheel(event) {
            const previous = scale;
            scale = constrain(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.15, 6);
            const factor = scale / previous;
            const rect = stage.getBoundingClientRect();
            const uiX = rect.width / Math.max(1, stage.offsetWidth);
            const uiY = rect.height / Math.max(1, stage.offsetHeight);
            const x = (event.clientX - rect.left) / (uiX || 1);
            const y = (event.clientY - rect.top) / (uiY || 1);
            const nextLeft = (stage.scrollLeft + x) * factor - x;
            const nextTop = (stage.scrollTop + y) * factor - y;
            if (host.gridJoin()) {
                host.refreshGrid();
                overflow();
                host.zoomChanged();
            } else applyZoom(factor);
            stage.scrollLeft = nextLeft;
            stage.scrollTop = nextTop;
        }

        function syncRatio() {
            for (const button of ratioButtons) {
                button.classList.toggle('active', button.dataset.cropRatio === preset);
            }
        }

        function resetCrop() {
            if (!ready()) return;
            const size = displaySize();
            const initial = { x: Math.round(size.w * 0.08), y: Math.round(size.h * 0.08),
                w: Math.round(size.w * 0.84), h: Math.round(size.h * 0.84) };
            const ratio = fitRatio(preset, displaySize);
            setRegion(ratio ? geometry.fittedCrop(initial, size, ratio) : initial);
        }

        function fitOutpaint() {
            if (!ready()) return;
            const source = displaySize();
            const { ratio, scale } = host.outpaint();
            const w = source.w * scale, h = source.h * scale;
            const size = ratio ? { w: Math.max(w, h * ratio), h: Math.max(h, w / ratio) } : { w, h };
            const width = Math.max(source.w, Math.round(size.w));
            const height = Math.max(source.h, Math.round(size.h));
            setRegion({ w: width, h: height, x: Math.round((width - source.w) / 2), y: Math.round((height - source.h) / 2) });
            overflow();
        }

        for (const button of ratioButtons) {
            button.addEventListener('click', event => {
                event.stopPropagation();
                preset = button.dataset.cropRatio || 'free';
                syncRatio();
                const state = host.state();
                const ratio = fitRatio(preset, displaySize);
                if (state && host.mode() === 'crop' && ratio) setRegion(geometry.fittedCrop(state, displaySize(), ratio));
            });
        }

        function cropHandle(event) {
            const explicit = event.target.closest('[data-crop-handle]')?.dataset.cropHandle;
            if (explicit) return 'crop-' + explicit;
            if (host.mode() !== 'crop') return 'move';
            const rect = box.getBoundingClientRect();
            const near = 16;
            const vertical = event.clientY - rect.top <= near ? 'n' : rect.bottom - event.clientY <= near ? 's' : '';
            const horizontal = event.clientX - rect.left <= near ? 'w' : rect.right - event.clientX <= near ? 'e' : '';
            return vertical || horizontal ? 'crop-' + vertical + horizontal : 'move';
        }

        function finish(id = gesture?.id) {
            if (!gesture || gesture.id !== id) return;
            gesture = null;
            frame.classList.remove('dragging-image');
            if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id);
        }

        stage.addEventListener('pointerdown', event => {
            const state = host.state();
            const target = event.target;
            if (!state || host.mode() === 'preview' || gesture || event.button !== 0) return;
            let action;
            if (expanding() && (expansion.contains(target) || target === source)) {
                action = target.closest('[data-outpaint-handle]')?.dataset.outpaintHandle;
                action = action ? 'outpaint-' + action : 'image';
            } else if (box.contains(target)) {
                action = cropHandle(event);
            } else {
                if (target.closest('.image-edit-actions, .preview-tools-overlay, .preview-download-overlay, .crop-handle')) return;
                if (host.mode() !== 'crop' && target.closest('#editDrawCanvas, #editTextCanvas, .edit-text-inline')) return;
                if (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight) return;
                action = 'scroll';
            }
            const display = displaySize();
            const area = source.getBoundingClientRect();
            const stageRect = stage.getBoundingClientRect();
            const sx = action === 'scroll' ? stageRect.width / stage.offsetWidth : area.width / display.w;
            const sy = action === 'scroll' ? stageRect.height / stage.offsetHeight : area.height / display.h;
            gesture = { id: event.pointerId, action, state, mode: host.mode(), start: rectangle(state),
                x: event.clientX, y: event.clientY, sx: sx || 1, sy: sy || 1,
                left: stage.scrollLeft, top: stage.scrollTop, alt: event.altKey };
            event.preventDefault();
            event.stopPropagation();
            stage.setPointerCapture?.(event.pointerId);
            frame.classList.toggle('dragging-image', action === 'image');
        });

        stage.addEventListener('pointermove', event => {
            if (!gesture || gesture.id !== event.pointerId) return;
            const { state, mode, start, action } = gesture;
            if (host.state() !== state || host.mode() !== mode) {
                finish();
                return;
            }
            const dx = (event.clientX - gesture.x) / gesture.sx;
            const dy = (event.clientY - gesture.y) / gesture.sy;
            if (action === 'scroll') {
                stage.scrollLeft = gesture.left - dx;
                stage.scrollTop = gesture.top - dy;
                return;
            }
            const bounds = displaySize();
            const next = action.startsWith('outpaint-')
                ? root.XiaomeiOutpaintGeometry.resize(start, bounds, action.slice(9), dx, dy, gesture.alt, host.outpaint().ratio)
                : geometry.dragBox(start, bounds, action, dx, dy, fitRatio(preset, displaySize), expanding());
            setRegion(next);
        });

        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            stage.addEventListener(event, event => finish(event.pointerId));
        }

        function stop() {
            finish();
            root.clearTimeout(timer);
            load = null;
            base = null;
            scale = 1;
            preset = 'free';
            resizeBy = 0.5;
            syncRatio();
            source.onload = source.onerror = null;
            source.removeAttribute('src');
            source.removeAttribute('crossorigin');
            delete source.dataset.proxyFallbackTried;
            for (const key of ['width', 'height', 'maxWidth', 'maxHeight', 'position', 'left', 'top']) source.style[key] = '';
            applyButton.disabled = false;
        }

        function stillOpen(state) {
            return host.state() === state && host.visible();
        }

        function loadSource(item) {
            const urls = [...new Set(host.urls(item).filter(Boolean))];
            const state = host.state();
            const job = { state, owner: host.owner(), uri: item.url, ready: false };
            load = job;
            const current = () => load === job && stillOpen(state) && host.owner() === job.owner && host.current().image?.url === job.uri;

            function tryUrl(index) {
                if (!current() || !urls[index]) return;
                const url = urls[index];
                source.onload = () => {
                    if (!current() || source.getAttribute('src') !== url || !source.naturalWidth) return;
                    source.onload = source.onerror = null;
                    job.ready = true;
                    refit(true);
                    host.loaded(index === 0, source.naturalWidth, source.naturalHeight);
                };
                source.onerror = () => tryUrl(index + 1);
                source.src = url;
            }
            // Let the visible preview request begin before decoding the editor image.
            timer = root.setTimeout(() => tryUrl(0), 0);
        }

        function ready() {
            return load?.ready && stillOpen(load.state) && host.owner() === load.owner
                && host.current().image?.url === load.uri && source.naturalWidth > 0 && source.naturalHeight > 0;
        }

        async function apply(mode) {
            const state = host.state();
            if (!state || submitting.has(state)) return;
            const current = host.current();
            if (mode === 'crop') {
                if (!current.node) return host.error('裁剪失败：原图节点已不在画布上，请关闭编辑器后重试');
                if (!current.image) return host.error('裁剪失败：原图已被更新，请关闭编辑器后重新打开');
                if (!ready()) return host.error('裁剪失败：当前图片尚未加载，请稍后重试');
            } else if (!current.node || !current.image || !ready()) return;

            const edit = { ...current, localRepair: state.localRepair, region: rectangle(state), resizeBy,
                sourceW: source.naturalWidth, sourceH: source.naturalHeight, owner: host.owner(),
                sourceUrl: current.node.images[current.index]?.url };
            function owns() {
                const now = host.current();
                return stillOpen(state) && host.owner() === edit.owner && now.node === edit.node
                    && now.index === edit.index && now.node?.images?.[now.index]?.url === edit.sourceUrl
                    && now.image?.url === edit.image.url && host.mode() === mode
                    && (mode === 'resize' ? resizeBy === edit.resizeBy
                        : Object.keys(edit.region).every(key => edit.region[key] === state[key]));
            }

            submitting.add(state);
            applyButton.disabled = true;
            let phase = 'export';
            try {
                const output = mode === 'crop' ? geometry.crop(source, edit.region) : geometry.resize(source, resizeSize());
                const blob = await geometry.png(output.canvas);
                if (!owns()) return;
                phase = 'upload';
                const file = await host.upload(blob, host.filename(edit, mode));
                if (owns()) host.commit(edit, mode, output, file);
            } catch (error) {
                if (!owns()) return;
                if (mode === 'resize' && phase === 'export') {
                    host.error('缩放失败：当前图片无法写入画布，请换成本地图片或重新上传后再试');
                } else {
                    const action = mode === 'crop' ? '裁剪保存失败' : '缩放失败';
                    host.error(action + '：' + (error.message || '请重试'));
                }
            } finally {
                submitting.delete(state);
                if (stillOpen(state)) applyButton.disabled = false;
            }
        }

        function outpaintPixels(resolution) {
            if (!ready()) return null;
            const bounds = displaySize();
            const region = geometry.boundExpansion(host.state(), bounds);
            const placement = root.XiaomeiOutpaintGeometry.output(region, bounds,
                { w: source.naturalWidth, h: source.naturalHeight }, resolution);
            const { canvas, context } = geometry.surface(placement.w, placement.h);
            if (!context) throw new Error('无法创建扩图画布');
            context.drawImage(source, placement.x, placement.y, placement.sourceW, placement.sourceH);
            return { canvas, placement };
        }

        return { stop, loadSource, ready, apply, outpaintPixels, displaySize, outpaintSize,
            refit, applyZoom, resetZoom, wheel, resizeControls, paint, overflow, resetCrop, fitOutpaint,
            zoom: () => scale };
    }

    root.XiaomeiSmartImageEditor = { create };
})(window);
