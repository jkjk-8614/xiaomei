(function (root) {
    'use strict';

    const modes = {
        preview: ['eye', 'previewImage', 'previewHint'],
        crop: ['crop', 'cropImage', 'cropHint', 'applyCrop'],
        outpaint: ['expand', 'outpaintImage', 'outpaintHint', 'applyOutpaint'],
        mask: ['brush', 'maskEdit', 'maskHint2', 'applyMask'],
        brush: ['paintbrush', 'brushEdit', 'brushHint', 'applyBrush'],
        resize: ['minimize-2', 'imageResizeTitle', 'imageResizeHint', 'imageResizeApply'],
        grid: ['grid-3x3', 'modeGrid', 'gridHint', 'applyGrid'],
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const px = value => value + 'px';

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const modal = get('imageEditModal');
        const stage = get('imageEditStage');
        const frame = get('cropCanvas');
        const image = get('cropImage');
        const cropBox = get('cropBox');
        const outpaint = get('outpaintFrame');
        const draw = get('editDrawCanvas');
        const text = get('editTextCanvas');
        const apply = get('imageEditApplyBtn');
        const resizeRange = get('imageResizeScaleRange');
        const resizeInput = get('imageResizeScaleInput');
        const zoomLabel = get('imageEditZoomLabel');
        const modeButtons = modal.querySelectorAll('[data-image-edit-mode]');
        const ratioButtons = modal.querySelectorAll('[data-crop-ratio]');
        const tools = { crop: get('imageCropTools'), mask: get('imageMaskTools'), brush: get('imageBrushTools'),
            resize: get('imageResizeTools'), grid: get('imageGridTools') };
        const geometry = root.XiaomeiImageEditGeometry;
        const label = key => host.label('canvas.' + key);
        let session;
        let drag;

        const mode = () => session?.mode || 'crop';
        const bounds = () => ({ w: Math.max(1, image.clientWidth), h: Math.max(1, image.clientHeight) });
        const changed = () => { if (session) session.revision++; };
        const grid = root.XiaomeiClassicGrid.create({ modal, frame, draw, changed, label: host.label, active: () => mode() === 'grid' });
        const undo = ['maskUndoBtn', 'brushUndoBtn'].map(get);
        const redo = ['maskRedoBtn', 'brushRedoBtn'].map(get);
        const brushTools = modal.querySelectorAll('[data-brush-tool]');

        function ready() {
            return Boolean(session && host.node(session.node.id) === session.node && session.node.url === session.url
                && host.canvas() === session.canvas && image.getAttribute('src') === session.full
                && image.complete && image.naturalWidth && image.naturalHeight);
        }

        const ink = root.XiaomeiClassicAnnotations.create({
            draw, text, frame, image, mode, ready, changed,
            size: () => Number(get(mode() === 'mask' ? 'maskBrushSize' : 'paintBrushSize').value || 20),
            color: () => get('paintBrushColor').value || '#ff2d55',
            tools: brushTools, undo, redo, styleControls: ['paintBrushSize', 'paintBrushColor'].map(get),
            label: host.label, id: host.id, grid,
        });

        function editBox() {
            return mode() === 'outpaint' ? session.expansion : session.crop;
        }

        function aspect() {
            return root.XiaomeiCanvasEditorCore.cropRatioFromPreset(session.aspect, bounds);
        }

        function cropDefault(size) {
            const box = { x: Math.round(size.w * 0.08), y: Math.round(size.h * 0.08),
                w: Math.round(size.w * 0.84), h: Math.round(size.h * 0.84) };
            return aspect() ? geometry.fittedCrop(box, size, aspect()) : box;
        }

        function resetBox() {
            if (!session) return;
            const size = bounds();
            if (mode() === 'outpaint') session.expansion = { x: 0, y: 0, ...size };
            else session.crop = cropDefault(size);
            changed();
            paintBox();
            overflow();
        }

        function styleBox(element, box) {
            element.style.left = px(box.x);
            element.style.top = px(box.y);
            element.style.width = px(box.w);
            element.style.height = px(box.h);
        }

        function paintBox() {
            if (!session?.crop) return;
            const expanding = mode() === 'outpaint';
            const box = editBox();
            frame.style.width = expanding ? px(Math.round(box.w)) : '';
            frame.style.height = expanding ? px(Math.round(box.h)) : '';
            for (const layer of [image, draw, text]) {
                layer.style.left = expanding ? px(Math.round(box.x)) : '';
                layer.style.top = expanding ? px(Math.round(box.y)) : '';
            }
            const area = expanding ? { ...box, x: 0, y: 0 } : box;
            styleBox(cropBox, area);
            styleBox(outpaint, area);
            if (expanding) {
                const size = bounds();
                const width = Math.max(1, Math.round(box.w * (image.naturalWidth || 1) / size.w));
                const height = Math.max(1, Math.round(box.h * (image.naturalHeight || 1) / size.h));
                get('outpaintResolution').textContent = width + ' x ' + height;
                frame.classList.toggle('outpaint-warning', host.exceedsFourK(width, height));
            } else frame.classList.remove('outpaint-warning');
        }

        function overflow() {
            const rect = frame.getBoundingClientRect();
            const x = rect.width + 36 > stage.clientWidth;
            const y = rect.height + 36 > stage.clientHeight;
            stage.classList.toggle('overflowing', x || y);
            stage.classList.toggle('overflow-x', x);
            stage.classList.toggle('overflow-y', y);
        }

        function resizeInfo() {
            const scale = session?.resize || 0.5;
            return {
                scale,
                targetW: Math.max(1, Math.round((image.naturalWidth || 1) * scale)),
                targetH: Math.max(1, Math.round((image.naturalHeight || 1) * scale)),
            };
        }

        function syncResize() {
            const { scale, targetW, targetH } = resizeInfo();
            if (Number(resizeRange.value) !== scale) resizeRange.value = scale;
            if (Number(resizeInput.value) !== scale) resizeInput.value = scale;
            get('imageResizeResolution').textContent = get('resizeResolutionOverlay').textContent = targetW + '×' + targetH;
        }

        function availability() {
            apply.disabled = !ready() || Boolean(session?.busy);
        }

        function rebase(size) {
            const previous = session.size;
            if (!previous || !session.crop) {
                session.crop = cropDefault(size);
                session.expansion = { x: 0, y: 0, ...size };
            } else if (previous.w !== size.w || previous.h !== size.h) {
                const sx = size.w / previous.w;
                const sy = size.h / previous.h;
                const scaled = box => ({ x: Math.round(box.x * sx), y: Math.round(box.y * sy),
                    w: Math.round(box.w * sx), h: Math.round(box.h * sy) });
                session.crop = geometry.boundCrop(scaled(session.crop), size);
                session.expansion = geometry.boundExpansion(scaled(session.expansion), size);
                if (drag) {
                    drag.box = { ...editBox() };
                    drag.start = drag.last;
                }
            }
            session.size = size;
        }

        function measure() {
            rebase(bounds());
            paintBox();
            ink.resize();
            grid.paint();
            syncResize();
            overflow();
            zoomLabel.textContent = Math.round(session.zoom * 100) + '%';
            availability();
        }

        function setZoomSize() {
            if (!session.base) return;
            const size = root.XiaomeiCanvasEditorCore.imageEditZoomSize(session.base.w, session.base.h, session.zoom);
            image.style.maxWidth = image.style.maxHeight = 'none';
            image.style.width = px(size.width);
            image.style.height = 'auto';
        }

        function updateZoom(next, point) {
            if (!session?.base) return;
            const before = session.zoom;
            if (point && next === before) return;
            session.zoom = next;
            session.explicitZoom = true;
            changed();
            const left = stage.scrollLeft;
            const top = stage.scrollTop;
            setZoomSize();
            measure();
            stage.scrollLeft = point ? (left + point.x) * next / before - point.x : 0;
            stage.scrollTop = point ? (top + point.y) * next / before - point.y : 0;
        }

        function fitImage() {
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            const factor = Math.min(Math.max(1, Math.min(1300, root.innerWidth - 100)) / width,
                Math.max(1, Math.min(840, root.innerHeight - 200)) / height);
            session.base = { w: Math.max(1, Math.round(width * factor)), h: Math.max(1, Math.round(height * factor)) };
            if (session.explicitZoom) setZoomSize();
            measure();
        }

        function syncRatio() {
            for (const button of ratioButtons) button.classList.toggle('active', button.dataset.cropRatio === session?.aspect);
        }

        function endDrag(event) {
            if (!drag || (event && event.pointerId !== drag.id)) return;
            const { target, id } = drag;
            drag = null;
            if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
            frame.classList.remove('dragging-image');
        }

        function setMode(next) {
            if (!session) return;
            const before = mode();
            if (before !== next) {
                if (before === 'brush') ink.finishInline(true);
                ink.finishStroke();
                grid.end();
                endDrag();
                session.mode = next;
                changed();
            }
            for (const name of Object.keys(modes)) frame.classList.toggle(name + '-mode', next === name);
            for (const button of modeButtons) button.classList.toggle('active', button.dataset.imageEditMode === next);
            for (const [name, control] of Object.entries(tools)) control.classList.toggle('active', name === next);
            const [glyph, title, description, action] = modes[next];
            get('imageEditTitle').textContent = label(title);
            get('imageEditSub').textContent = label(description);
            apply.style.display = action ? '' : 'none';
            if (action) {
                const icon = doc.createElement('i');
                icon.className = 'w-4 h-4';
                icon.dataset.lucide = glyph;
                const span = doc.createElement('span');
                span.textContent = label(action);
                apply.replaceChildren(icon, span);
            }
            if (['preview', 'crop', 'resize'].includes(next) || (before === 'grid' && next !== 'grid')) ink.clear(true);
            if (next === 'outpaint' && before !== next && session.crop) {
                session.expansion = { x: 0, y: 0, ...bounds() };
            }
            paintBox();
            ink.refreshTools();
            grid.paint();
            syncResize();
            availability();
            host.icons();
        }

        function present(state, src) {
            function loaded() {
                if (session !== state || image.getAttribute('src') !== src || !image.naturalWidth || !image.complete) return;
                fitImage();
            }
            image.onload = loaded;
            image.onerror = () => {
                if (session === state && src === state.full) host.error(label('imageEditSourceFailed'));
            };
            image.src = src;
            if (image.complete) root.queueMicrotask(loaded);
        }

        function open(id, initial = 'crop') {
            const node = host.node(id);
            if (!node?.url || host.kind(node) !== 'image') return;
            close();
            const next = Object.hasOwn(modes, initial) ? initial : 'crop';
            const full = host.full(node.url, node.name || '');
            const quick = host.quick(node.url, next === 'preview' ? 1536 : 2048);
            const state = { node, url: node.url, canvas: host.canvas(), full, mode: next, zoom: 1, resize: 0.5, aspect: 'free', revision: 0 };
            session = state;
            modal.classList.add('open');
            stage.scrollLeft = stage.scrollTop = 0;
            zoomLabel.textContent = '100%';
            syncRatio();
            setMode(next);
            image.crossOrigin = 'anonymous';
            if (!quick || quick === full) {
                present(state, full);
                return;
            }
            present(state, quick);
            const preload = new root.Image();
            preload.crossOrigin = image.crossOrigin;
            preload.onload = () => { if (session === state) present(state, full); };
            preload.onerror = () => { if (session === state) host.error(label('imageEditSourceFailed')); };
            preload.src = full;
        }

        function close() {
            endDrag();
            grid.end();
            session = null;
            modal.classList.remove('open');
            image.onload = image.onerror = null;
            image.removeAttribute('src');
            for (const item of [image, frame, draw, text]) {
                for (const prop of ['width', 'height', 'maxWidth', 'maxHeight', 'top', 'left']) item.style[prop] = '';
            }
            for (const name of Object.keys(modes)) frame.classList.remove(name + '-mode');
            frame.classList.remove('outpaint-warning', 'text-mode', 'dragging-image');
            stage.classList.remove('overflowing', 'overflow-x', 'overflow-y');
            grid.reset();
            ink.reset(true);
        }

        function cropHandle(event) {
            const explicit = event.target.closest('[data-crop-handle]')?.dataset.cropHandle;
            if (explicit) return 'crop-' + explicit;
            const box = cropBox.getBoundingClientRect();
            const near = 16;
            const y = event.clientY - box.top;
            const x = event.clientX - box.left;
            const row = y <= near ? 'n' : box.height - y <= near ? 's' : '';
            const col = x <= near ? 'w' : box.width - x <= near ? 'e' : '';
            return row || col ? 'crop-' + row + col : 'move';
        }

        function startDrag(event, action) {
            if (event.button !== 0 || !session?.crop || drag) return;
            const target = event.currentTarget;
            event.preventDefault();
            event.stopPropagation();
            const start = { x: event.clientX, y: event.clientY };
            drag = { target, action, id: event.pointerId, start, last: start, box: { ...editBox() } };
            if (action === 'image') frame.classList.add('dragging-image');
            target.setPointerCapture(event.pointerId);
        }

        function moveDrag(event) {
            if (drag?.id !== event.pointerId) return;
            drag.last = { x: event.clientX, y: event.clientY };
            const box = geometry.dragBox(drag.box, bounds(), drag.action, drag.last.x - drag.start.x,
                drag.last.y - drag.start.y, aspect(), mode() === 'outpaint');
            Object.assign(editBox(), box);
            changed();
            paintBox();
            if (mode() === 'outpaint') overflow();
        }

        function snapshot() {
            if (!ready() || mode() === 'preview') return null;
            const active = mode();
            if (active === 'brush') ink.finishInline(true);
            if (active === 'brush' || active === 'mask') {
                ink.finishStroke();
                if (!ink.hasMarks(active)) {
                    if (active === 'brush') host.error(label('imageEditNeedPaint'));
                    return null;
                }
            }
            return {
                identity: session, revision: session.revision, node: session.node, image, mode: active,
                box: { ...editBox() },
                rects: active === 'grid' ? grid.rects(image.naturalWidth, image.naturalHeight) : [],
                size: active === 'resize' ? resizeInfo() : null,
                layers: active === 'brush' ? [draw, text] : active === 'mask' ? [draw] : [],
            };
        }

        const exporter = root.XiaomeiClassicMediaEdits.create({
            label: host.label, snapshot,
            current: edit => session === edit.identity && session.revision === edit.revision && ready(),
            busy: (edit, value) => {
                if (session !== edit.identity) return;
                session.busy = value;
                availability();
            },
            upload: host.upload, commit: host.commit,
            error: error => host.error(error?.message || label('imageEditUploadFailed')),
        });

        for (const target of [cropBox, outpaint, image]) {
            target.dataset.nativeTouch = '';
            target.addEventListener('pointermove', moveDrag);
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) target.addEventListener(name, endDrag);
        }
        cropBox.addEventListener('pointerdown', event => startDrag(event, cropHandle(event)));
        outpaint.addEventListener('pointerdown', event => {
            const handle = event.target.closest('[data-outpaint-handle]')?.dataset.outpaintHandle;
            startDrag(event, handle ? 'outpaint-' + handle : 'image');
        });
        image.addEventListener('pointerdown', event => { if (mode() === 'outpaint') startDrag(event, 'image'); });
        image.draggable = false;
        for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.imageEditMode));
        for (const button of ratioButtons) button.addEventListener('click', () => {
            if (!session) return;
            session.aspect = button.dataset.cropRatio;
            syncRatio();
            if (session.crop && aspect()) session.crop = geometry.fittedCrop(session.crop, bounds(), aspect());
            changed();
            paintBox();
        });
        for (const input of [resizeRange, resizeInput]) input.addEventListener('input', () => {
            if (!session) return;
            const value = Number(input.value);
            session.resize = Number.isFinite(value) ? clamp(Math.round(value * 100) / 100, 0.05, 1) : 0.5;
            changed();
            syncResize();
        });
        for (const button of brushTools) button.addEventListener('click', () => ink.setTool(button.dataset.brushTool));
        for (const button of undo) button.addEventListener('click', () => ink.undo());
        for (const button of redo) button.addEventListener('click', () => ink.redo());
        for (const button of modal.querySelectorAll('[data-ink-clear]')) button.addEventListener('click', () => ink.clear());
        for (const button of modal.querySelectorAll('[data-editor-close]')) button.addEventListener('click', close);
        modal.addEventListener('click', event => { if (event.target === modal) close(); });
        modal.querySelector('[data-editor-reset]').addEventListener('click', resetBox);
        apply.addEventListener('click', exporter.apply);
        zoomLabel.addEventListener('dblclick', () => updateZoom(1));
        stage.addEventListener('wheel', event => {
            if (!session) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = stage.getBoundingClientRect();
            updateZoom(clamp(session.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.15, 6),
                { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }, { passive: false });
        root.addEventListener('resize', () => { if (session) overflow(); });
        root.addEventListener('blur', () => { endDrag(); grid.end(); });

        return { open, close, isOpen: () => Boolean(session) };
    }

    root.XiaomeiClassicImageEditor = { create };
})(window);
