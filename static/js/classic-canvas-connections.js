(function (root) {
    'use strict';

    const kernel = root.XiaomeiNodeKernel;
    const curveSteps = 28;

    function center(element) {
        const { left, top, width, height } = element.getBoundingClientRect();
        return { x: left + width / 2, y: top + height / 2 };
    }

    function squaredDistance(point, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = dx * dx + dy * dy;
        const along = length ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / length : 0;
        const t = Math.max(0, Math.min(1, along));
        return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
    }

    function crosses(a, b, c, d) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ex = d.x - c.x;
        const ey = d.y - c.y;
        const determinant = dx * ey - dy * ex;
        if (!determinant) return squaredDistance(a, c, d) === 0 || squaredDistance(b, c, d) === 0;
        const x = c.x - a.x;
        const y = c.y - a.y;
        const along = (x * ey - y * ex) / determinant;
        const across = (x * dy - y * dx) / determinant;
        return along >= 0 && along <= 1 && across >= 0 && across <= 1;
    }

    function crossesBox(a, b, box) {
        let first = 0;
        let last = 1;
        for (const [start, end, low, high] of [[a.x, b.x, box.x, box.x + box.w], [a.y, b.y, box.y, box.y + box.h]]) {
            const delta = end - start;
            if (!delta) {
                if (start < low || start > high) return false;
                continue;
            }
            const near = (low - start) / delta;
            const far = (high - start) / delta;
            first = Math.max(first, Math.min(near, far));
            last = Math.min(last, Math.max(near, far));
            if (first > last) return false;
        }
        return true;
    }

    function visitCurve(segment, visit) {
        let previous = segment.a;
        for (let step = 1; step <= curveSteps; step++) {
            const next = kernel.sampleCurve(segment.a, segment.b, step / curveSteps, 'classic');
            if (visit(previous, next)) return true;
            previous = next;
        }
        return false;
    }

    function create(host) {
        const { cards, layer, controls, selected, mouse } = host;
        const document = cards.ownerDocument;
        const surface = root.XiaomeiCanvasSurface;
        const { background, drop: dropMenu, input, output } = host.menus;
        let graph;
        let draft;
        let stroke;
        let hovered = '';
        let segments = [];

        const card = id => cards.querySelector('.node[data-id="' + root.CSS.escape(id) + '"]');
        const inWorld = event => host.world(event.clientX, event.clientY);
        const opposite = kind => kind === 'in' ? 'out' : 'in';
        const isSelected = edge => selected.has(edge.from) || selected.has(edge.to);

        function allowed(fromId, toId) {
            if (!fromId || !toId || fromId === toId) return false;
            const from = host.node(fromId);
            const to = host.node(toId);
            if (!from || !to) return false;
            return kernel.classicMayConnect(from.type, to.type, {
                mediaOutput: host.hasMediaOutput(from),
                acyclic: !kernel.reaches(host.edges(), toId, fromId),
                loopImage: Boolean(to.imageInput),
                loopPrompt: Boolean(to.showPrompt),
            });
        }

        function writeEdges(next) {
            host.replaceEdges(next);
            host.syncInputs();
        }

        function commit() {
            host.paintNodes();
            host.save();
        }

        function append(from, to) {
            host.edges().push({ id: host.id('c'), from, to });
            host.relayOutput(from, to);
            host.syncInputs();
            commit();
        }

        function connect(from, to, snapshot = true) {
            if (!allowed(from, to) || host.edges().some(edge => edge.from === from && edge.to === to)) return false;
            if (snapshot) host.snapshot();
            append(from, to);
            return true;
        }

        function remove(id, event) {
            event?.preventDefault();
            event?.stopPropagation();
            const edges = host.edges();
            const next = edges.filter(edge => edge.id !== id);
            if (next.length === edges.length) return;
            host.snapshot();
            writeEdges(next);
            commit();
        }

        function anchor(node, kind, element) {
            const port = element?.querySelector('.port.' + kind);
            if (port) {
                const { x, y } = center(port);
                return host.world(x, y);
            }
            return kernel.edgeAnchor({
                x: Number(node.x) || 0, y: Number(node.y) || 0,
                w: element?.offsetWidth || node.w || 260, h: element?.offsetHeight || node.h || 160,
            }, kind);
        }

        function paint() {
            const anchors = new Map();
            for (const edge of host.edges()) {
                for (const id of [edge.from, edge.to]) {
                    if (anchors.has(id)) continue;
                    const node = host.node(id);
                    anchors.set(id, node ? { node, element: card(id) } : null);
                }
            }
            function point(record, kind) {
                return record[kind] ||= anchor(record.node, kind, record.element);
            }
            segments = [];
            for (const c of host.edges()) {
                const from = anchors.get(c.from);
                const to = anchors.get(c.to);
                if (from && to) segments.push({ c, a: point(from, 'out'), b: point(to, 'in'), selected: isSelected(c) });
            }
            if (!graph && (segments.length || draft || stroke)) graph = root.XiaomeiClassicEdges.mount(layer);
            graph?.render(segments, draft, stroke?.points);
            if (!segments.some(({ c }) => c.id === hovered)) hovered = '';
            const buttons = document.createDocumentFragment();
            for (const { c, a, b, selected } of segments) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'link-delete';
                button.classList.toggle('visible', selected);
                button.classList.toggle('hover', c.id === hovered);
                button.title = host.label('canvas.deleteLink');
                button.setAttribute('aria-label', button.title);
                button.dataset.connectionId = c.id;
                button.style.left = (a.x + b.x) / 2 + 'px';
                button.style.top = (a.y + b.y) / 2 + 'px';
                button.textContent = '×';
                button.onclick = event => remove(c.id, event);
                buttons.append(button);
            }
            controls.replaceChildren(buttons);
        }

        function hoverId(id) {
            if (id === hovered) return;
            const button = key => controls.querySelector('[data-connection-id="' + root.CSS.escape(key) + '"]');
            button(hovered)?.classList.remove('hover');
            hovered = id;
            button(id)?.classList.add('hover');
        }

        function hover(event, busy) {
            if (!host.ready() || busy) {
                hoverId('');
                return;
            }
            const button = document.elementFromPoint(event.clientX, event.clientY)?.closest('.link-delete');
            if (button) {
                hoverId(button.dataset.connectionId);
                return;
            }
            const pointer = inWorld(event);
            let closest = '';
            let distance = Math.max(12, 16 / host.scale()) ** 2;
            for (const segment of segments) {
                let best = Infinity;
                visitCurve(segment, (a, b) => { best = Math.min(best, squaredDistance(pointer, a, b)); });
                if (best < distance || (!closest && best === distance)) {
                    closest = segment.c.id;
                    distance = best;
                }
            }
            hoverId(closest);
        }

        function targetPort(event, kind) {
            const { clientX, clientY } = event;
            const selector = '.port.' + kind;
            const direct = document.elementFromPoint(clientX, clientY)?.closest(selector);
            const port = direct || kernel.nearestPoint(Array.from(cards.querySelectorAll(selector), port => ({
                port, ...center(port),
            })), clientX, clientY, 48)?.port;
            return port?.closest('.node')?.dataset.id;
        }

        function closeMenus() {
            for (const menu of [dropMenu, input, output]) {
                menu.classList.remove('open', 'node-port-menu');
                menu.replaceChildren();
            }
        }

        function choose(source, kind, point, type) {
            closeMenus();
            if (host.node(source.id) !== source) return;
            host.snapshot();
            const created = host.createNode(type, point);
            if (!created) return;
            if (kind === 'out') connect(source.id, created.id, false);
            else connect(created.id, source.id, false);
        }

        function menuItems(options, source, kind, point, compact = false) {
            return options.map(({ type, label, icon }) => ({
                icon,
                label: compact ? String(label || '').replace('生成', '') : label,
                title: compact ? label : '',
                dataset: compact ? { linkCreate: type, linkKind: kind } : { linkCreate: type },
                onClick(event) {
                    event.stopPropagation();
                    choose(source, kind, point, type);
                },
            }));
        }

        function showDropMenu(source, kind, event) {
            const options = surface.linkChoices(source, kind, host.catalog());
            if (!options.length) return;
            closeMenus();
            background.classList.remove('open');
            surface.paintMenu(dropMenu, [{ items: menuItems(options, source, kind, inWorld(event)) }]);
            surface.pinMenu(dropMenu, event.clientX, event.clientY);
            dropMenu.classList.add('open');
            host.icons();
        }

        function openNodeMenu(id, event) {
            const source = host.node(id);
            if (!source || !host.isGenerator(source)) return;
            const box = card(id)?.getBoundingClientRect();
            const point = inWorld(event);
            const catalog = host.catalog();
            closeMenus();
            background.classList.remove('open');
            const y = Math.max(10, Math.min(root.innerHeight - 260, (box?.top || event.clientY) + 36));
            const menus = [
                { menu: input, kind: 'in', title: '添加输入', options: surface.linkChoices(source, 'in', catalog),
                    x: Math.max(10, (box?.left || event.clientX) - 158) },
                { menu: output, kind: 'out', title: '添加输出', options: surface.outputChoices(source, catalog),
                    x: Math.min(root.innerWidth - 158, (box?.right || event.clientX) + 10) },
            ];
            for (const { menu, kind, title, options, x } of menus) {
                menu.classList.add('node-port-menu', 'open');
                surface.paintMenu(menu, [{ title, grid: true, items: menuItems(options, source, kind, point, true) }]);
                surface.pinMenu(menu, x, y);
            }
            host.icons();
        }

        function drop(source, kind, event) {
            const target = targetPort(event, opposite(kind));
            if (target) {
                if (kind === 'out') connect(source.id, target);
                else connect(target, source.id);
                return;
            }
            if (kind === 'out' && host.isGenerator(source)) {
                const point = inWorld(event);
                const output = { id: host.id('out'), type: 'output', x: point.x, y: point.y - 63, images: [] };
                host.snapshot();
                host.appendNode(output);
                append(source.id, output.id);
            } else {
                showDropMenu(source, kind, event);
            }
        }

        function start(event, id, kind) {
            const source = host.node(id);
            if (!source || mouse.busy()) return;
            const { x, y } = anchor(source, kind, card(id));
            event.stopPropagation();
            draft = { x1: x, y1: y, x2: x, y2: y };
            hoverId('');
            mouse.track(event, {
                move(next) {
                    const point = inWorld(next);
                    draft.x2 = point.x;
                    draft.y2 = point.y;
                    paint();
                },
                finish(released) {
                    draft = null;
                    paint();
                    if (released && host.node(id) === source) drop(source, kind, released);
                },
            });
        }

        function cut(a, b) {
            if (!segments.length) return;
            const limit = Math.max(8, 12 / host.scale()) ** 2;
            const hitNodes = new Set();
            for (const node of host.nodes()) {
                if (card(node.id) && crossesBox(a, b, host.nodeBox(node))) hitNodes.add(node.id);
            }
            const cutEdges = new Set();
            for (const segment of segments) {
                const { c } = segment;
                const hit = hitNodes.has(c.from) || hitNodes.has(c.to)
                    || visitCurve(segment, (from, to) => crosses(a, b, from, to)
                        || squaredDistance(from, a, b) <= limit || squaredDistance(to, a, b) <= limit);
                if (hit) cutEdges.add(c);
            }
            if (!cutEdges.size) return;
            if (!stroke.changed) host.snapshot();
            stroke.changed = true;
            writeEdges(host.edges().filter(edge => !cutEdges.has(edge)));
            host.refreshInputs();
            host.save();
        }

        function knifeMode(active) {
            document.body.classList.toggle('canvas-knife', Boolean(active && host.ready()));
            if (!active && stroke) mouse.cancel();
        }

        function startKnife(event) {
            if (!host.ready() || event.button !== 0 || !event.shiftKey || event.altKey || host.editable(event.target)) return false;
            if (!mouse.track(event, {
                move(next) {
                    if (!next.shiftKey) {
                        knifeMode(false);
                        return;
                    }
                    const point = inWorld(next);
                    cut(stroke.points.at(-1), point);
                    stroke.points.push(point);
                    if (stroke.points.length > 120) stroke.points.shift();
                    paint();
                },
                finish(released) {
                    const changed = stroke.changed;
                    stroke = null;
                    knifeMode(released?.shiftKey);
                    if (changed) host.paintNodes();
                    else paint();
                    host.paintMinimap();
                },
            })) return false;
            event.preventDefault();
            event.stopImmediatePropagation();
            host.dismiss();
            knifeMode(true);
            stroke = { points: [inWorld(event)], changed: false };
            hoverId('');
            paint();
            return true;
        }

        return { allowed, remove, start, paint, hover, clearHover: () => hoverId(''), startKnife, knifeMode, closeMenus, openNodeMenu };
    }

    root.XiaomeiClassicConnections = { create };
})(window);
