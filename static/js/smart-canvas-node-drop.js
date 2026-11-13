(function (root) {
    'use strict';

    const pointerTargets = new Set(['smart-prompt', 'smart-loop', 'smart-agent']);
    const hasMedia = node => Boolean(node?.images?.length);
    const centerOf = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const contains = (rect, point) => point.x >= rect.x && point.x <= rect.x + rect.width
        && point.y >= rect.y && point.y <= rect.y + rect.height;
    const movedNodes = state => state.moveGroup || state.group || [{ id: state.id, ox: state.ox, oy: state.oy }];

    function create(host) {
        function closestConnection(source, center, lookup) {
            let closest = null;
            for (const [index, edge] of host.edges().entries()) {
                if (edge.kind && edge.kind !== 'flow' && edge.kind !== 'input') continue;
                if (source.id === edge.from || source.id === edge.to) continue;
                const from = lookup.get(edge.from);
                const to = lookup.get(edge.to);
                if (!from || !to || host.isHistory(from) || host.isHistory(to) || !host.canEdit(from) || !host.canEdit(to)) continue;
                const midpoint = host.midpoint(edge, from, to);
                const distance = Math.hypot(center.x - midpoint.x, center.y - midpoint.y);
                if (distance <= 96 && (!closest || distance < closest.distance)) closest = { edge, index, distance };
            }
            return closest;
        }

        function resolve(state, pointer, overLibrary = false) {
            const nodes = host.nodes();
            const source = nodes.find(node => node.id === state.id);
            if (!source || !host.canEdit(source)) return { source, actions: [] };
            if (overLibrary && hasMedia(source)) return { source, actions: [{ type: 'library' }] };
            const center = centerOf(host.rect(source));
            const single = (state.group?.length || 0) <= 1;
            const modified = Boolean(state.ctrlGroup);
            const excluded = new Set(state.groupIds || []);
            excluded.add(source.id);
            const available = node => !excluded.has(node.id) && host.canEdit(node);
            const actions = [];
            if (source.type === 'smart-loop' && single && modified) {
                const hit = closestConnection(source, center, new Map(nodes.map(node => [node.id, node])));
                if (hit) actions.push({ type: 'insert', hit });
            }
            const originId = state.returnGroupId || source.detachedFromNodeId;
            const origin = originId && host.isImage(source) && nodes.find(node => node.id === originId);
            const returning = origin && available(origin) && contains(host.rect(origin), center);
            if (returning && !host.isGroup(origin) && host.isImage(origin)) {
                actions.push({ type: 'merge', target: origin });
            }
            if (modified || !state.groupRoots?.size) {
                let group = returning && host.isGroup(origin) ? origin : null;
                for (let i = nodes.length - 1; !group && i >= 0; i--) {
                    const node = nodes[i];
                    if (host.isGroup(node) && available(node) && contains(host.rect(node), center)) group = node;
                }
                if (group) {
                    const members = (state.group || []).map(item => nodes.find(node => node.id === item.id))
                        .filter(node => node && !state.groupRoots?.has(host.groupOf(node.id)?.id));
                    const joining = members.length ? members : [source];
                    if (joining.every(host.canEdit)) actions.push({ type: 'group', target: group, members: joining });
                }
            }
            if (modified && single) {
                const at = point => nodes.find(node => available(node) && contains(host.rect(node), point));
                const overlap = hasMedia(source) ? at(center) : null;
                if (overlap?.images?.length > 1 && !host.isGroup(overlap)) actions.push({ type: 'merge', target: overlap });
                const target = pointer && pointerTargets.has(source.type) ? at(pointer) : overlap || at(center);
                if (target && host.canConnect(source, target)) actions.push({ type: 'connect', target, restore: true });
                if (overlap && overlap !== target && host.canConnect(source, overlap)) {
                    actions.push({ type: 'connect', target: overlap, restore: !state.thumbDetached });
                }
            }
            return { source, actions };
        }

        function apply({ source, actions }) {
            for (const action of actions) {
                switch (action.type) {
                    case 'library':
                        host.saveMedia(source);
                        return action;
                    case 'insert':
                        if (host.insert(source, action.hit)) return action;
                        break;
                    case 'group':
                        if (host.join(action.members, action.target)) return action;
                        break;
                    case 'merge':
                        if (host.merge(source.id, action.target.id)) return action;
                        break;
                    case 'connect':
                        if (host.connect(source.id, action.target.id)) return action;
                        break;
                }
            }
            return null;
        }

        function position(state, point, scale, grid) {
            if (!state || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
            if (point.x === state.lastX && point.y === state.lastY) return null;
            const start = { x: state.startX, y: state.startY };
            if (!state.moved && Math.hypot(point.x - start.x, point.y - start.y) < 4) return null;
            const nodes = host.nodes();
            const node = nodes.find(candidate => candidate.id === state.id);
            if (!node) return null;
            const { x, y } = root.XiaomeiNodeKernel.worldDelta(point, start, scale);
            const dx = grid ? root.XiaomeiNodeKernel.snappedDelta(state.ox, x, grid) : x;
            const dy = grid ? root.XiaomeiNodeKernel.snappedDelta(state.oy, y, grid) : y;
            const origins = new Map(movedNodes(state).map(item => [item.id, item]));
            for (const candidate of origins.size === 1 ? [node] : nodes) {
                const origin = origins.get(candidate.id);
                if (origin) Object.assign(candidate, { x: origin.ox + dx, y: origin.oy + dy });
            }
            Object.assign(state, { lastX: point.x, lastY: point.y, moved: true });
            return { node, dx, dy };
        }

        function moved(state) {
            return movedNodes(state).some(item => {
                const node = host.nodes().find(candidate => candidate.id === item.id);
                return node && (Math.abs((Number(node.x) || 0) - item.ox) > 1 || Math.abs((Number(node.y) || 0) - item.oy) > 1);
            });
        }

        function restore(state) {
            const nodes = host.nodes();
            for (const item of movedNodes(state)) {
                const node = nodes.find(candidate => candidate.id === item.id);
                if (node) Object.assign(node, { x: item.ox, y: item.oy });
            }
        }

        return { resolve, apply, position, moved, restore };
    }

    root.XiaomeiSmartNodeDrop = { create };
})(window);
