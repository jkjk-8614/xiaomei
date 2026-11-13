(function (root) {
    'use strict';

    const cellSize = 160;
    const radius = 16;
    const markClass = 'conn-erasing-mark';
    const excluded = '.image-node,.composer,.smart-back,.asset-panel,.asset-toggle,.smart-log-toggle,.smart-shortcut-toggle,.smart-workflow-toggle,.log-modal,.shortcut-modal,.image-edit-modal,.prompt-optimize-modal,.create-menu,.smart-minimap,.canvas-nav-panel';
    const svgNamespace = 'http://www.w3.org/2000/svg';

    function indices(spec, limit) {
        const parts = Array.isArray(spec) ? spec : String(spec ?? '').split(',');
        return [...new Set(parts.filter(value => String(value).trim()).map(Number)
            .filter(index => Number.isInteger(index) && index >= 0 && index < limit))];
    }

    function references(group) {
        try {
            const list = JSON.parse(group.dataset.connReferences || '[]');
            return Array.isArray(list) ? list.filter(item => item?.nodeId && item.key) : [];
        } catch {
            return [];
        }
    }

    function eachCell(a, b, pad, visit) {
        const firstX = Math.floor((Math.min(a.x, b.x) - pad) / cellSize);
        const lastX = Math.floor((Math.max(a.x, b.x) + pad) / cellSize);
        const firstY = Math.floor((Math.min(a.y, b.y) - pad) / cellSize);
        const lastY = Math.floor((Math.max(a.y, b.y) + pad) / cellSize);
        for (let x = firstX; x <= lastX; x++) {
            for (let y = firstY; y <= lastY; y++) visit(x + ':' + y);
        }
    }

    function nearSegment(point, start, end) {
        const x = end.x - start.x;
        const y = end.y - start.y;
        const px = point.x - start.x;
        const py = point.y - start.y;
        const length = x * x + y * y;
        const t = length ? Math.min(1, Math.max(0, (x * px + y * py) / length)) : 0;
        return (px - x * t) ** 2 + (py - y * t) ** 2 <= radius ** 2;
    }

    function strokeTouches(start, end, a, b) {
        const rx = end.x - start.x;
        const ry = end.y - start.y;
        const sx = b.x - a.x;
        const sy = b.y - a.y;
        const cross = rx * sy - ry * sx;
        if (cross) {
            const x = a.x - start.x;
            const y = a.y - start.y;
            const t = (x * sy - y * sx) / cross;
            const u = (x * ry - y * rx) / cross;
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
        }
        return nearSegment(start, a, b) || nearSegment(end, a, b)
            || nearSegment(a, start, end) || nearSegment(b, start, end);
    }

    function buildGrid(layer, connections, fallback) {
        const grid = new Map();
        if (!layer) return grid;
        for (const group of layer.querySelectorAll('.conn-group')) {
            const reference = group.classList.contains('conn-reference');
            const path = group.querySelector(reference ? 'path.conn-line' : 'path.conn-hit[data-conn-index]');
            if (!path) continue;
            const target = {
                edges: reference ? [] : indices(path.dataset.connIndex, connections.length).map(index => connections[index]),
                refs: reference ? references(group) : [],
                marks: [group, ...group.querySelectorAll('.conn-line,.conn-end,.conn-cut,.conn-hit')],
            };
            if (!target.edges.length && !target.refs.length) continue;
            try {
                const length = path.getTotalLength();
                if (!(length > 0 && Number.isFinite(length))) continue;
                const matrix = path.getScreenCTM();
                const hasMatrix = matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)
                    && matrix.a * matrix.d !== matrix.b * matrix.c;
                const project = hasMatrix ? ({ x, y }) => ({
                    x: matrix.a * x + matrix.c * y + matrix.e,
                    y: matrix.b * x + matrix.d * y + matrix.f,
                }) : fallback;
                const start = project(path.getPointAtLength(0));
                const end = project(path.getPointAtLength(length));
                if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) continue;
                const scale = hasMatrix ? Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) : 1;
                const steps = Math.min(256, Math.max(12, Math.ceil(length * (scale || 1) / 18)));
                let previous = start;
                for (let step = 1; step <= steps; step++) {
                    const point = step === steps ? end : project(path.getPointAtLength(length * step / steps));
                    const segment = { a: previous, b: point, target };
                    eachCell(previous, point, 0, key => {
                        if (!grid.has(key)) grid.set(key, []);
                        grid.get(key).push(segment);
                    });
                    previous = point;
                }
            } catch {
                // A detached SVG has no reliable geometry for this stroke.
            }
        }
        return grid;
    }

    function create(host) {
        const { world, surface } = host;
        const document = surface.ownerDocument;
        let stroke = null;
        let held = false;
        let trailSvg;
        let frame = 0;
        let fade = 0;
        const modifier = event => Boolean(event?.ctrlKey || event?.metaKey || held);
        const eraseButton = event => {
            if (event.button === 2 || event.button === 1) return event.button;
            if (event.buttons & 2) return 2;
            if (event.buttons & 4) return 1;
            return null;
        };
        const isPress = event => modifier(event) && eraseButton(event) !== null;
        const source = event => event.type.startsWith('pointer') ? 'pointer' : 'mouse';
        const position = event => ({ x: event.clientX, y: event.clientY });

        function createTrail() {
            clearTimeout(fade);
            fade = 0;
            if (trailSvg) {
                trailSvg.classList.remove('fading');
                return trailSvg;
            }
            trailSvg = document.createElementNS(svgNamespace, 'svg');
            trailSvg.setAttribute('class', 'connection-erase-trail');
            trailSvg.setAttribute('aria-hidden', 'true');
            for (const name of ['connection-erase-trail-glow', 'connection-erase-trail-line']) {
                const path = document.createElementNS(svgNamespace, 'path');
                path.setAttribute('class', name);
                path.setAttribute('fill', 'none');
                trailSvg.append(path);
            }
            surface.append(trailSvg);
            return trailSvg;
        }

        function drawTrail() {
            frame = 0;
            if (!stroke) return;
            const svg = createTrail();
            const { rect, points } = stroke;
            svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
            const path = points.map(({ x, y }, index) =>
                (index ? 'L' : 'M') + (x - rect.left).toFixed(1) + ' ' + (y - rect.top).toFixed(1)).join(' ');
            for (const child of svg.children) child.setAttribute('d', path);
        }

        function trace(event) {
            const point = position(event);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            const previous = stroke.last || point;
            const candidates = new Set();
            eachCell(previous, point, radius, key => {
                for (const segment of stroke.grid.get(key) || []) candidates.add(segment);
            });
            for (const { a, b, target } of candidates) {
                if (stroke.hits.has(target) || !strokeTouches(previous, point, a, b)) continue;
                stroke.hits.add(target);
                for (const element of target.marks) element.classList.add(markClass);
            }
            stroke.last = point;
            const last = stroke.points.at(-1);
            if (!last || (last.x - point.x) ** 2 + (last.y - point.y) ** 2 >= 2.25) {
                stroke.points.push(point);
                if (stroke.points.length > 80) stroke.points.shift();
            }
            if (!frame) frame = root.requestAnimationFrame(drawTrail);
        }

        function start(event) {
            if (!isPress(event) || !surface.contains(event.target) || event.target.closest?.(excluded)) return false;
            if (stroke) return true;
            const current = host.current();
            if (!current || !host.canEdit()) return false;
            host.beforeStart();
            const mapper = host.mapper();
            const origin = mapper(0, 0);
            const fallback = point => ({
                x: (point.x - (origin?.x ?? NaN)) * mapper.screenScaleX,
                y: (point.y - (origin?.y ?? NaN)) * mapper.screenScaleY,
            });
            stroke = {
                current, source: source(event), button: eraseButton(event),
                pointerId: event.pointerId,
                rect: surface.getBoundingClientRect(), points: [],
                grid: buildGrid(world.querySelector('svg.connection-layer'), current.connections || [], fallback),
                hits: new Set(),
            };
            if (Number.isFinite(event.pointerId)) {
                try { surface.setPointerCapture?.(event.pointerId); } catch {}
            }
            surface.classList.add('connection-erasing');
            trace(event);
            return true;
        }

        function move(event) {
            if (!stroke && (!(event.buttons & 6) || !start(event))) return false;
            if (stroke.current !== host.current()) return finish();
            if (stroke.source !== source(event) || (stroke.pointerId !== undefined && event.pointerId !== stroke.pointerId)) return true;
            event.preventDefault();
            if (stroke.source === 'pointer') event.stopPropagation();
            trace(event);
            return true;
        }

        function finish(event) {
            if (!stroke) return false;
            if (Number.isFinite(event?.pointerId) && event.pointerId !== stroke.pointerId) return false;
            const released = event?.type === 'pointerup' || event?.type === 'mouseup';
            if (released && event.button !== stroke.button) return true;
            if (released && stroke.current === host.current()) trace(event);
            const ended = stroke;
            stroke = null;
            event?.preventDefault();
            if (surface.hasPointerCapture?.(ended.pointerId)) surface.releasePointerCapture(ended.pointerId);
            surface.classList.remove('connection-erasing');
            root.cancelAnimationFrame(frame);
            frame = 0;
            if (trailSvg) {
                trailSvg.classList.add('fading');
                clearTimeout(fade);
                fade = setTimeout(() => {
                    trailSvg.remove();
                    trailSvg = undefined;
                    fade = 0;
                }, 180);
            }
            const targets = [...ended.hits];
            for (const target of targets) {
                for (const element of target.marks) element.classList.remove(markClass);
            }
            if (targets.length && ended.current === host.current()) {
                host.remove(targets.flatMap(target => target.edges), targets.flatMap(target => target.refs));
            }
            return true;
        }

        function press(event) {
            if (!start(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        document.addEventListener('pointerdown', press, true);
        document.addEventListener('mousedown', press, true);
        surface.addEventListener('pointermove', move, true);
        surface.addEventListener('pointerup', finish, true);
        surface.addEventListener('pointercancel', finish, true);

        return {
            modifier, isPress, move, finish,
            active: () => Boolean(stroke),
            hold: value => { held = value; },
        };
    }

    root.XiaomeiSmartConnectionEraser = { create, indices };
})(window);
