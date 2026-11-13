(function (root) {
    'use strict';

    const tools = new Set(['free', 'rect', 'ellipse', 'arrow', 'label', 'text', 'eraser']);
    const maskAlpha = 115 / 255;
    const gray = '#505050';
    const outline = 'rgba(255,255,255,.92)';
    const maximumHistory = 40;
    const isMask = mode => mode === 'mask' || mode === 'protection-mask';
    const isStroke = kind => kind === 'free' || kind === 'eraser';

    function clear(canvas) {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }

    function position(event, layer) {
        const rect = layer.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * layer.width / Math.max(1, rect.width),
            y: (event.clientY - rect.top) * layer.height / Math.max(1, rect.height),
        };
    }

    const font = size => '900 ' + size + 'px Arial, sans-serif';
    const linesOf = value => value.split('\n');
    function bounds(ctx, item) {
        ctx.save();
        ctx.font = font(item.size);
        const lines = linesOf(item.text);
        const metrics = lines.map(line => ctx.measureText(line));
        ctx.restore();
        const leading = item.size * 1.18;
        const inset = Math.max(6, Math.round(item.size * 0.24));
        const width = Math.max(16, ...metrics.map(metric => metric.width)) + inset * 2;
        const lineHeight = Math.max(12, ...metrics.map(metric => (metric.actualBoundingBoxAscent || item.size * 0.72)
            + (metric.actualBoundingBoxDescent || item.size * 0.22)));
        const height = lineHeight + leading * (lines.length - 1) + inset * 2;
        return { x: item.x - width / 2, y: item.y - height / 2, w: width, h: height, inset };
    }

    function drawText(ctx, item, asMask) {
        ctx.save();
        ctx.font = font(item.size);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = asMask ? gray : item.color;
        ctx.strokeStyle = asMask ? gray : outline;
        ctx.lineWidth = Math.max(item.marker ? 3 : 2, item.size / 8);
        const lines = linesOf(item.text);
        lines.forEach((line, index) => {
            const y = item.y + (index - (lines.length - 1) / 2) * item.size * 1.18;
            ctx.strokeText(line, item.x, y);
            ctx.fillText(line, item.x, y);
        });
        ctx.restore();
    }

    function renderMark(ctx, mark, asMask) {
        if (mark.kind === 'label') return drawText(ctx, mark, asMask);
        const { points } = mark;
        const first = points[0];
        const end = points.at(-1);
        ctx.save();
        const color = asMask ? gray : mark.mask ? 'rgba(80,80,80,' + maskAlpha + ')' : mark.color;
        ctx.strokeStyle = ctx.fillStyle = color;
        if (mark.kind === 'eraser') ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = mark.size;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        if (isStroke(mark.kind)) {
            if (points.length === 1) {
                ctx.arc(first.x, first.y, mark.size / 2, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.moveTo(first.x, first.y);
                for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
                ctx.stroke();
            }
        } else if (mark.kind === 'arrow') {
            const angle = Math.atan2(end.y - first.y, end.x - first.x);
            const head = Math.max(10, mark.size * 1.8);
            const wing = offset => ctx.lineTo(end.x - head * Math.cos(angle + offset), end.y - head * Math.sin(angle + offset));
            ctx.moveTo(first.x, first.y);
            ctx.lineTo(end.x, end.y);
            wing(-0.48);
            ctx.moveTo(end.x, end.y);
            wing(0.48);
            ctx.stroke();
        } else {
            const w = Math.abs(end.x - first.x), h = Math.abs(end.y - first.y);
            if (mark.kind === 'rect') ctx.strokeRect(Math.min(first.x, end.x), Math.min(first.y, end.y), w, h);
            else {
                ctx.ellipse((first.x + end.x) / 2, (first.y + end.y) / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    function create(host) {
        const { draw, text, frame, image } = host;
        const preview = root.document.createElement('canvas');
        preview.className = 'classic-ink-preview';
        preview.setAttribute('aria-hidden', 'true');
        draw.after(preview);
        draw.dataset.nativeTouch = '';
        text.dataset.nativeTouch = '';
        let marks = [];
        let captions = [];
        let selected = '';
        let nextNumber = 1;
        let tool = 'free';
        let past = [];
        let future = [];
        let drawing;
        let dragging;
        let editor;
        let styling = false;
        let scheduled = 0;
        const activeText = () => host.mode() === 'brush' && tool === 'text';
        const chosen = () => captions.find(item => item.id === selected);
        const defaultText = () => host.label('canvas.annotationTextHint');
        const textSize = () => Math.max(14, Math.min(120, Math.round(host.size() * 2)));

        function snapshot() {
            return { marks: [...marks], captions: captions.map(item => ({ ...item })), selected, nextNumber };
        }

        function updateButtons() {
            for (const [buttons, enabled] of [[host.undo, past.length], [host.redo, future.length]]) {
                for (const button of buttons) {
                    button.disabled = !enabled;
                    button.style.opacity = enabled ? '1' : '.42';
                }
            }
        }

        function record() {
            host.changed?.();
            past.push(snapshot());
            if (past.length > maximumHistory) past.shift();
            future = [];
            updateButtons();
        }

        function applySnapshot(state) {
            host.changed?.();
            finishInline(false);
            ({ marks, captions, selected, nextNumber } = state);
            styling = false;
            render();
            updateButtons();
        }

        function undo() {
            finishInline(true);
            if (!past.length) return;
            future.push(snapshot());
            applySnapshot(past.pop());
        }

        function redo() {
            finishInline(true);
            if (!future.length) return;
            past.push(snapshot());
            applySnapshot(future.pop());
        }

        function renderInk(pending) {
            if (host.mode() === 'grid') return;
            clear(draw);
            const ctx = draw.getContext('2d');
            const mask = isMask(host.mode());
            for (const mark of marks) renderMark(ctx, mark, mask);
            if (pending) renderMark(ctx, pending, mask);
            if (mask && marks.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-in';
                ctx.fillStyle = 'rgba(0,0,0,' + maskAlpha + ')';
                ctx.fillRect(0, 0, draw.width, draw.height);
                ctx.restore();
            }
        }

        function renderText() {
            clear(text);
            const ctx = text.getContext('2d');
            for (const item of captions) {
                if (item.id !== editor?.id) drawText(ctx, item, false);
            }
        }

        function showPreview() {
            clear(preview);
            const ctx = preview.getContext('2d');
            if (drawing?.mark.mask || drawing?.mark.kind === 'eraser') renderInk(drawing.mark);
            else if (drawing) renderMark(ctx, drawing.mark, false);
            const item = chosen();
            if (item && activeText() && !editor) {
                const box = bounds(ctx, item);
                ctx.save();
                ctx.setLineDash([7, 5]);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(15,23,42,.72)';
                ctx.strokeRect(box.x, box.y, box.w, box.h);
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.arc(box.x + box.w - box.inset, box.y + box.inset, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(15,23,42,.92)';
                ctx.fill();
                ctx.restore();
            }
        }

        function requestPreview() {
            if (scheduled) return;
            scheduled = root.requestAnimationFrame(() => {
                scheduled = 0;
                showPreview();
            });
        }

        function render() {
            renderInk();
            renderText();
            showPreview();
            placeEditor();
        }

        function refreshTools() {
            frame.classList.toggle('text-mode', activeText());
            for (const button of host.tools) {
                const checked = button.dataset.brushTool === tool;
                button.classList.toggle('primary', checked);
                button.classList.toggle('secondary', !checked);
                button.setAttribute('aria-pressed', String(checked));
            }
            updateButtons();
            render();
        }

        function setTool(next) {
            if (next !== tool) {
                finishInline(true);
                finishStroke();
                tool = tools.has(next) ? next : 'free';
                styling = false;
            }
            refreshTools();
        }

        function resize() {
            const w = Math.max(1, image.naturalWidth || image.clientWidth || 1);
            const h = Math.max(1, image.naturalHeight || image.clientHeight || 1);
            const display = host.displaySize?.() || { w: image.clientWidth, h: image.clientHeight };
            let resized = false;
            for (const layer of [draw, preview, text]) {
                if (layer.width !== w || layer.height !== h) {
                    layer.width = w;
                    layer.height = h;
                    resized = true;
                }
                layer.style.width = Math.max(1, display.w) + 'px';
                layer.style.height = Math.max(1, display.h) + 'px';
            }
            if (resized) render();
            else placeEditor();
        }

        function hasMarks(mode = host.mode()) {
            return marks.length > 0 || (mode === 'brush' && captions.length > 0);
        }

        function clearAll(silent = false) {
            finishInline(false);
            finishStroke(null, true);
            if (!silent && hasMarks('brush')) record();
            marks = [];
            captions = [];
            selected = '';
            nextNumber = 1;
            const pointer = dragging?.id;
            dragging = null;
            release(text, pointer);
            styling = false;
            clear(draw);
            clear(text);
            clear(preview);
            updateButtons();
        }

        function reset(release = false) {
            clearAll(true);
            root.cancelAnimationFrame(scheduled);
            scheduled = 0;
            past = [];
            future = [];
            if (release) for (const layer of [draw, preview, text]) { layer.width = 1; layer.height = 1; }
            updateButtons();
        }

        function stopPointer(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        function release(layer, pointer) {
            if (pointer != null && layer.hasPointerCapture(pointer)) layer.releasePointerCapture(pointer);
        }

        function beginStroke(event) {
            const mode = host.mode();
            if (!host.ready()) return;
            if (mode === 'grid') { host.grid.start(event, position(event, draw)); return; }
            if ((mode !== 'brush' && !isMask(mode)) || activeText() || event.button !== 0 || drawing) return;
            stopPointer(event);
            const first = position(event, draw);
            const size = host.size();
            const color = host.color();
            if (mode === 'brush' && tool === 'label') {
                record();
                const n = nextNumber++;
                marks.push({ kind: 'label', marker: true, text: n <= 20 ? String.fromCharCode(0x245f + n) : String(n),
                    x: first.x, y: first.y, size: Math.max(18, size * 2.2), color });
                renderInk();
                return;
            }
            draw.setPointerCapture(event.pointerId);
            drawing = {
                id: event.pointerId, mark: { kind: isMask(mode) ? 'free' : tool, mask: isMask(mode), size, color, points: [first] },
            };
            showPreview();
        }

        function moveStroke(event) {
            if (host.mode() === 'grid') { host.grid.move(event, position(event, draw)); return; }
            if (drawing?.id !== event.pointerId) return;
            stopPointer(event);
            const { mark } = drawing;
            const point = position(event, draw);
            if (isStroke(mark.kind)) {
                const samples = event.getCoalescedEvents?.();
                if (samples?.length) for (const sample of samples) mark.points.push(position(sample, draw));
                else mark.points.push(point);
            }
            else mark.points.splice(1, 1, point);
            requestPreview();
        }

        function finishStroke(event, cancelled = false) {
            if (!drawing || (event && drawing.id !== event.pointerId)) return;
            const { id, mark } = drawing;
            drawing = null;
            release(draw, id);
            if (!cancelled && (isStroke(mark.kind) || mark.points.length > 1)) {
                record();
                marks.push(mark);
            }
            renderInk();
            showPreview();
        }

        function hit(point) {
            const ctx = text.getContext('2d');
            return captions.findLast(item => {
                const box = bounds(ctx, item);
                return point.x >= box.x && point.y >= box.y && point.x <= box.x + box.w && point.y <= box.y + box.h;
            });
        }

        function placeEditor() {
            if (!editor) return;
            const item = chosen();
            if (!item) return;
            const metrics = bounds(text.getContext('2d'), item);
            const client = text.getBoundingClientRect();
            const outer = frame.getBoundingClientRect();
            const sx = text.clientWidth / text.width;
            const sy = text.clientHeight / text.height;
            const zoomX = client.width / Math.max(1, text.clientWidth);
            const zoomY = client.height / Math.max(1, text.clientHeight);
            const el = editor.el;
            el.style.left = (client.left - outer.left) / Math.max(0.001, zoomX) + metrics.x * sx + 'px';
            el.style.top = (client.top - outer.top) / Math.max(0.001, zoomY) + metrics.y * sy + 'px';
            el.style.font = font(Math.max(10, item.size * sy));
            el.style.color = item.color;
            el.style.width = 'auto';
            el.style.height = 'auto';
            el.style.minWidth = Math.max(48, metrics.w * sx) + 'px';
            el.style.minHeight = Math.max(28, metrics.h * sy) + 'px';
            el.style.width = el.scrollWidth + 10 + 'px';
            el.style.height = el.scrollHeight + 4 + 'px';
        }

        function finishInline(save = true) {
            if (!editor) return;
            const { el, id } = editor;
            const item = captions.find(candidate => candidate.id === id);
            const value = String(el.innerText || '').replace(/\u00a0/g, ' ').trim();
            editor = null;
            el.remove();
            if (save && item && value !== item.text) {
                record();
                if (value) item.text = value;
                else {
                    captions = captions.filter(candidate => candidate !== item);
                    selected = '';
                }
            }
            renderText();
            showPreview();
        }

        function editInline(event) {
            if (!activeText()) return;
            const item = hit(position(event, text));
            if (!item) return;
            stopPointer(event);
            finishInline(true);
            selected = item.id;
            const el = root.document.createElement('div');
            el.className = 'edit-text-inline';
            el.contentEditable = 'plaintext-only';
            el.spellcheck = false;
            el.setAttribute('role', 'textbox');
            el.setAttribute('aria-label', host.label('canvas.annotationTextEditor'));
            el.setAttribute('aria-multiline', 'true');
            el.textContent = item.text;
            frame.append(el);
            editor = { id: item.id, el };
            el.addEventListener('input', placeEditor);
            el.addEventListener('keydown', key => {
                if (key.isComposing || key.keyCode === 229) return;
                if (key.key === 'Escape' || (key.key === 'Enter' && !key.shiftKey)) {
                    stopPointer(key);
                    finishInline(key.key === 'Enter');
                }
            });
            el.addEventListener('blur', () => { if (editor?.el === el) finishInline(true); });
            placeEditor();
            renderText();
            showPreview();
            root.requestAnimationFrame(() => {
                if (editor?.el !== el) return;
                el.focus();
                const range = root.document.createRange();
                range.selectNodeContents(el);
                const selection = root.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            });
        }

        function beginText(event) {
            if (!activeText() || !host.ready() || event.button !== 0 || dragging) return;
            stopPointer(event);
            finishInline(true);
            styling = false;
            const point = position(event, text);
            const item = hit(point);
            if (item) {
                selected = item.id;
                dragging = { id: event.pointerId, item, point, x: item.x, y: item.y, moved: false };
                text.setPointerCapture(event.pointerId);
                text.style.cursor = 'grabbing';
            } else if (selected) selected = '';
            else {
                record();
                const item = { id: host.id('txt'), text: defaultText(), x: point.x, y: point.y, color: host.color(), size: textSize() };
                captions.push(item);
                selected = item.id;
            }
            renderText();
            showPreview();
        }

        function moveText(event) {
            if (!activeText()) return;
            const point = position(event, text);
            if (!dragging) { text.style.cursor = hit(point) ? 'move' : 'text'; return; }
            if (dragging.id !== event.pointerId) return;
            stopPointer(event);
            const dx = point.x - dragging.point.x, dy = point.y - dragging.point.y;
            if (!dragging.moved) {
                if (Math.abs(dx) + Math.abs(dy) < 1) return;
                record();
                dragging.moved = true;
            }
            dragging.item.x = dragging.x + dx;
            dragging.item.y = dragging.y + dy;
            renderText();
            requestPreview();
        }

        function endText(event) {
            if (dragging?.id !== event.pointerId) return;
            const { id } = dragging;
            dragging = null;
            release(text, id);
            text.style.cursor = 'move';
        }

        function styleText() {
            const item = activeText() && !editor && chosen();
            if (!item) return;
            const size = textSize(), color = host.color();
            if (size === item.size && color === item.color) return;
            if (!styling) record();
            styling = true;
            Object.assign(item, { size, color });
            renderText();
            showPreview();
        }

        draw.addEventListener('pointerdown', beginStroke);
        draw.addEventListener('pointermove', moveStroke);
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) draw.addEventListener(event, pointer => {
            host.grid.end(pointer);
            finishStroke(pointer, event !== 'pointerup');
        });
        text.addEventListener('pointerdown', beginText);
        text.addEventListener('pointermove', moveText);
        text.addEventListener('dblclick', editInline);
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) text.addEventListener(event, endText);
        for (const input of host.styleControls) {
            input.addEventListener('input', styleText);
            input.addEventListener('change', () => { styling = false; });
        }
        updateButtons();

        return { undo, redo, clear: clearAll, reset, setTool, refreshTools, resize, finishInline, finishStroke, hasMarks };
    }

    root.XiaomeiClassicAnnotations = { create };
})(window);
