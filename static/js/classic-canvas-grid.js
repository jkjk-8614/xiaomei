(function (root) {
    'use strict';

    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
    const fraction = (line, point, canvas) => line.type === 'h' ? point.y / canvas.height : point.x / canvas.width;

    function create(host) {
        const { modal, frame, draw, active, changed, label } = host;
        const get = id => modal.querySelector('#' + id);
        const h = get('gridHorizontalLines');
        const v = get('gridVerticalLines');
        const gap = get('gridGapSize');
        const toggle = get('gridCustomToggle');
        const custom = get('gridCustomControls');
        const regular = get('gridRegularControls');
        const presets = modal.querySelector('.grid-preset-row.grid-split-control');
        const undo = get('gridUndoBtn');
        const count = get('gridSplitCount');
        const orient = { h: get('gridOrientH'), v: get('gridOrientV') };
        let manual = false;
        let direction = 'h';
        let lines = [];
        let history = [];
        let drag;

        function settings() {
            return {
                rows: clamp(Math.floor(Number(h.value) || 0), 0, 20) + 1,
                cols: clamp(Math.floor(Number(v.value) || 0), 0, 20) + 1,
                gap: clamp(Number(gap.value) || 0, 0, 240),
                lines: manual ? lines : null,
            };
        }

        function rects(width, height) {
            return root.XiaomeiImageEditGeometry.gridRects(width, height, settings());
        }

        function highlight(button, on) {
            button.classList.toggle('primary', on);
            button.classList.toggle('secondary', !on);
        }

        function controls() {
            const hidden = host.joining?.();
            highlight(toggle, manual);
            h.disabled = v.disabled = manual;
            custom.style.display = manual && !hidden ? 'flex' : 'none';
            if (presets) {
                regular.style.display = hidden || manual ? 'none' : 'contents';
                presets.style.display = hidden || manual ? 'none' : 'flex';
                toggle.style.display = hidden ? 'none' : '';
            }
            highlight(orient.h, direction === 'h');
            highlight(orient.v, direction === 'v');
            undo.disabled = !history.length;
            undo.style.opacity = history.length ? '1' : '.4';
            frame.classList.toggle('grid-custom-h', active() && manual && direction === 'h');
            frame.classList.toggle('grid-custom-v', active() && manual && direction === 'v');
        }

        function paint() {
            controls();
            const { rows, cols, gap: spacing } = settings();
            get('gridGapValue').textContent = String(spacing);
            if (!active()) return;
            const { width, height } = draw;
            count.textContent = label('canvas.gridWillOutput').replace('{n}', rects(width, height).length);
            const ctx = draw.getContext('2d');
            ctx.clearRect(0, 0, width, height);
            const thickness = Math.max(2, Math.round(Math.min(width, height) / 320));
            const guides = manual ? lines : [
                ...Array.from({ length: rows - 1 }, (_, i) => ({ type: 'h', pos: (i + 1) / rows })),
                ...Array.from({ length: cols - 1 }, (_, i) => ({ type: 'v', pos: (i + 1) / cols })),
            ];
            ctx.save();
            for (const { type, pos } of guides) {
                const horizontal = type === 'h';
                const center = pos * (horizontal ? height : width);
                for (const offset of spacing ? [-spacing / 2, spacing / 2] : [0]) {
                    const at = center + offset;
                    ctx.beginPath();
                    ctx.moveTo(horizontal ? 0 : at, horizontal ? at : 0);
                    ctx.lineTo(horizontal ? width : at, horizontal ? at : height);
                    ctx.lineWidth = thickness + 2;
                    ctx.strokeStyle = 'rgba(2,6,23,0.72)';
                    ctx.stroke();
                    ctx.lineWidth = thickness;
                    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
                    ctx.stroke();
                }
            }
            ctx.restore();
        }

        function end(event) {
            if (!drag || (event && event.pointerId !== drag.pointerId)) return;
            const { pointerId } = drag;
            drag = null;
            if (draw.hasPointerCapture(pointerId)) draw.releasePointerCapture(pointerId);
        }

        function reset() {
            end();
            manual = false;
            direction = 'h';
            lines = [];
            history = [];
            controls();
        }

        function update() {
            changed();
            paint();
            host.updated?.();
        }

        function position(point) {
            const line = lines[drag.index];
            line.pos = clamp(fraction(line, point, draw), 0.001, 0.999);
            update();
        }

        function start(event, point) {
            if (!active() || !manual || drag || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const limit = Math.max(8, Math.min(draw.width, draw.height) / 80);
            let index = -1;
            let closest = limit;
            for (const [i, line] of lines.entries()) {
                const distance = Math.abs(fraction(line, point, draw) - line.pos) * (line.type === 'h' ? draw.height : draw.width);
                if (distance <= closest) { index = i; closest = distance; }
            }
            history.push(lines.map(line => ({ ...line })));
            if (index < 0) {
                index = lines.length;
                lines.push({ type: direction, pos: 0.5 });
            }
            drag = { pointerId: event.pointerId, index };
            draw.setPointerCapture(event.pointerId);
            position(point);
        }

        function move(event, point) {
            if (drag?.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            position(point);
        }

        for (const input of [h, v, gap]) input.addEventListener('input', update);
        toggle.addEventListener('click', () => {
            end();
            manual = !manual;
            if (!manual) { lines = []; history = []; }
            update();
        });
        for (const [key, button] of Object.entries(orient)) button.addEventListener('click', () => {
            direction = key;
            controls();
        });
        for (const button of modal.querySelectorAll('[data-grid-preset]')) button.addEventListener('click', () => {
            end();
            manual = false;
            lines = [];
            history = [];
            const [rows, cols] = button.dataset.gridPreset.split(',').map(Number);
            h.value = rows - 1;
            v.value = cols - 1;
            update();
        });
        undo.addEventListener('click', () => {
            if (!history.length) return;
            end();
            lines = history.pop();
            update();
        });
        modal.querySelector('[data-grid-clear]').addEventListener('click', () => {
            end();
            lines = [];
            history = [];
            update();
        });

        return { start, move, end, reset, rects, paint };
    }

    root.XiaomeiClassicGrid = { create };
})(window);
