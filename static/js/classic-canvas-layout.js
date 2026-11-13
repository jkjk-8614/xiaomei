(function (root) {
    'use strict';

    const isGroup = node => node?.type === 'group' || node?.type === 'promptGroup';
    const canGroup = node => node?.type === 'image' || node?.type === 'prompt';
    const childrenOf = node => isGroup(node) && Array.isArray(node.items) ? node.items : [];

    function descendants(byId, ids) {
        const seen = new Set();
        const queue = [...ids];
        for (let i = 0; i < queue.length; i++) {
            const id = queue[i];
            if (seen.has(id)) continue;
            seen.add(id);
            queue.push(...childrenOf(byId.get(id)));
        }
        return seen;
    }

    function groupIndex(byId) {
        const parent = new Map();
        for (const [id, node] of byId) {
            for (const child of childrenOf(node)) {
                if (child !== id && byId.has(child) && !parent.has(child)) parent.set(child, id);
            }
        }
        const resolved = new Map();
        return function atom(id) {
            const path = new Map();
            while (parent.has(id) && !resolved.has(id)) {
                if (path.has(id)) {
                    id = [...path.keys()].slice(path.get(id)).sort()[0];
                    break;
                }
                path.set(id, path.size);
                id = parent.get(id);
            }
            const owner = resolved.get(id) || id;
            for (const child of path.keys()) resolved.set(child, owner);
            return owner;
        };
    }

    function connectedTo(seed, edges) {
        const neighbors = new Map();
        for (const { from, to } of edges) {
            if (!neighbors.has(from)) neighbors.set(from, []);
            if (!neighbors.has(to)) neighbors.set(to, []);
            neighbors.get(from).push(to);
            neighbors.get(to).push(from);
        }
        const connected = new Set([seed]);
        for (const id of connected) {
            for (const neighbor of neighbors.get(id) || []) connected.add(neighbor);
        }
        return [...connected];
    }

    function create(host) {
        const { layer, box, board, selected } = host;
        const document = board.ownerDocument;
        const kernel = root.XiaomeiNodeKernel;
        const byId = () => new Map(host.nodes().map(node => [node.id, node]));
        let marquee;

        function replaceSelection(ids) {
            selected.clear();
            for (const id of ids) selected.add(id);
        }

        function paintMarquee(event) {
            const { x, y } = marquee;
            const frame = board.getBoundingClientRect();
            const left = Math.min(x, event.clientX);
            const top = Math.min(y, event.clientY);
            const right = Math.max(x, event.clientX);
            const bottom = Math.max(y, event.clientY);
            box.style.left = left - frame.left - board.clientLeft + 'px';
            box.style.top = top - frame.top - board.clientTop + 'px';
            box.style.width = right - left + 'px';
            box.style.height = bottom - top + 'px';
            return { left, top, right, bottom };
        }

        function cancelMarquee() {
            if (!marquee) return false;
            marquee = null;
            box.style.display = 'none';
            document.body.classList.remove('canvas-selecting');
            root.removeEventListener('mousemove', paintMarquee);
            root.removeEventListener('mouseup', finishMarquee);
            return true;
        }

        function finishMarquee(event) {
            if (event.button !== 0) return;
            const area = paintMarquee(event);
            cancelMarquee();
            const ids = [];
            for (const card of layer.children) {
                if (!card.matches('.node')) continue;
                const { left, top, right, bottom } = card.getBoundingClientRect();
                if (left < area.right && right > area.left && top < area.bottom && bottom > area.top) ids.push(card.dataset.id);
            }
            replaceSelection(ids);
            host.selectionChanged();
        }

        function startMarquee(event) {
            event.preventDefault();
            event.stopPropagation();
            cancelMarquee();
            marquee = { x: event.clientX, y: event.clientY };
            document.body.classList.add('canvas-selecting');
            box.style.display = 'block';
            paintMarquee(event);
            root.addEventListener('mousemove', paintMarquee);
            root.addEventListener('mouseup', finishMarquee);
        }

        root.addEventListener('blur', cancelMarquee);
        root.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !cancelMarquee()) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);

        function rect(node, fallbackHeight = 200) {
            const card = layer.querySelector('.node[data-id="' + root.CSS.escape(node.id) + '"]');
            return {
                x: Number(node.x) || 0,
                y: Number(node.y) || 0,
                w: card?.offsetWidth || Number(node.w) || 260,
                h: card?.offsetHeight || Number(node.h) || fallbackHeight,
            };
        }

        function makeGroup(members, point) {
            const id = host.id('grp');
            if (!members.length) return { id, type: 'group', x: point.x, y: point.y, w: 300, h: 220, items: [] };
            const bounds = members.reduce((box, node) => {
                const { x, y, w, h } = rect(node, 220);
                return {
                    left: Math.min(box.left, x), top: Math.min(box.top, y),
                    right: Math.max(box.right, x + w), bottom: Math.max(box.bottom, y + h),
                };
            }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
            return {
                id, type: 'group', x: bounds.left - 24, y: bounds.top - 58,
                w: bounds.right - bounds.left + 48, h: bounds.bottom - bounds.top + 90,
                items: members.map(member => member.id),
            };
        }

        function handoff(edges, group, ids, lookup) {
            const targets = new Set();
            for (const { from, to } of edges) {
                if (ids.has(from) && host.isGenerator(lookup.get(to)) && host.canConnect(group.id, to)) targets.add(to);
            }
            if (!targets.size) return edges;
            const existing = new Set(edges.filter(edge => edge.from === group.id).map(edge => edge.to));
            const next = edges.filter(edge => !ids.has(edge.from) || !targets.has(edge.to));
            for (const to of targets) {
                if (!existing.has(to)) next.push({ id: host.id('c'), from: group.id, to });
            }
            return next;
        }

        function groupSelection() {
            const lookup = byId();
            const members = [...selected].map(id => lookup.get(id)).filter(canGroup);
            const group = makeGroup(members, host.defaultPoint());
            host.undo();
            host.nodes().push(group);
            if (members.length) host.setEdges(handoff(host.edges(), group, new Set(group.items), lookup));
            replaceSelection([group.id]);
            host.changed(true);
        }

        function groupUploads(members) {
            const group = makeGroup(members);
            host.nodes().push(group);
            replaceSelection([group.id]);
            return group;
        }

        function updateMembership(moved) {
            const children = moved.filter(canGroup);
            if (!children.length || moved.some(isGroup)) return;
            const all = host.nodes();
            const normal = all.filter(node => node.type === 'group');
            const prompts = all.filter(node => node.type === 'promptGroup');
            const lookup = byId();
            const before = host.edges();
            let edges = before;
            let changed = false;

            function place(child, groups, rects, childBox) {
                const target = groups.find(group => kernel.centerInside(childBox, rects.get(group.id)));
                for (const group of groups) {
                    const current = childrenOf(group);
                    const member = current.includes(child.id);
                    if (group === target && !member) {
                        group.items = current.concat(child.id);
                        changed = true;
                    } else if (group !== target && member) {
                        group.items = current.filter(id => id !== child.id);
                        changed = true;
                    }
                }
                return target;
            }

            const rects = new Map([...normal, ...prompts].map(group => [group.id, rect(group)]));
            for (const child of children) {
                const bounds = rect(child);
                const target = place(child, normal, rects, bounds);
                if (target) edges = handoff(edges, target, new Set([child.id]), lookup);
                if (child.type === 'prompt') place(child, prompts, rects, bounds);
            }
            if (edges !== before) host.setEdges(edges);
            if (changed || edges !== before) host.changed(true);
        }

        function arrange() {
            const lookup = byId();
            const atom = groupIndex(lookup);
            const explicit = [...new Set([...selected].filter(id => lookup.has(id)).map(atom))];
            if (!explicit.length) return;
            const edges = kernel.uniqueEdges(host.edges().filter(edge => lookup.has(edge.from) && lookup.has(edge.to))
                .map(edge => ({ from: atom(edge.from), to: atom(edge.to) })));
            const ids = explicit.length === 1 && selected.size === 1 ? connectedTo(explicit[0], edges) : explicit;
            const boxes = ids.map(id => ({ id, ...rect(lookup.get(id)) }));
            const layout = kernel.columnLayout(boxes, edges, { minRow: 120, rowGap: 56, minCol: 220, colGap: 180 });
            if (!layout) return;

            const updates = new Map();
            for (const spot of layout) {
                const anchor = lookup.get(spot.id);
                const dx = Math.round(spot.x - (Number(anchor.x) || 0));
                const dy = Math.round(spot.y - (Number(anchor.y) || 0));
                for (const id of descendants(lookup, [spot.id])) {
                    if (updates.has(id) || !lookup.has(id)) continue;
                    const node = lookup.get(id);
                    updates.set(id, kernel.shiftPoint(node.x, node.y, dx, dy, true));
                }
            }
            if (![...updates].some(([id, point]) => point.x !== lookup.get(id).x || point.y !== lookup.get(id).y)) return;
            host.undo();
            for (const [id, point] of updates) Object.assign(lookup.get(id), point);
            host.changed(false);
        }

        function remove(ids, includeMembers) {
            const lookup = byId();
            const targets = ids.filter(id => lookup.has(id));
            if (!targets.length) return;
            const dropped = includeMembers ? descendants(lookup, targets) : new Set(targets);
            host.undo();
            const kept = [];
            for (const node of lookup.values()) {
                if (dropped.has(node.id)) continue;
                const items = childrenOf(node);
                if (items.some(id => dropped.has(id))) node.items = items.filter(id => !dropped.has(id));
                kept.push(node);
            }
            host.setNodes(kept);
            host.setEdges(host.edges().filter(edge => !dropped.has(edge.from) && !dropped.has(edge.to)));
            for (const id of dropped) selected.delete(id);
            host.changed(true);
        }

        return { startMarquee, cancelMarquee, makeGroup, groupSelection, groupUploads, updateMembership, arrange, rect, remove };
    }

    root.XiaomeiClassicLayout = { create };
})(window);
