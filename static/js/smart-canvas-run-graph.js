(function (root) {
    'use strict';

    const flowKinds = new Set(['input', 'flow']);
    const loopNode = node => node?.type === 'smart-loop';
    const edgeKey = (from, to) => from + '->' + to;
    const x = node => Number(node.x) || 0;
    const y = node => Number(node.y) || 0;
    const fromLeft = (a, b) => x(a) - x(b) || y(a) - y(b);
    const nearestInput = (a, b) => x(b) - x(a) || y(a) - y(b);

    function index(nodes, connections, options) {
        const { isImage, isHistory, isBoard, loopCount, legacyInputs } = options;
        const byId = new Map(nodes.map(node => [node.id, node]));
        const incoming = new Map(), outgoing = new Map();
        for (const edge of connections) {
            const kind = edge.kind || 'flow';
            if (!flowKinds.has(kind)) continue;
            if (!incoming.has(edge.to)) incoming.set(edge.to, []);
            if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
            incoming.get(edge.to).push({ id: edge.from, kind });
            outgoing.get(edge.from).add(edge.to);
        }

        const eligible = node => isImage(node) && !isHistory(node);
        const hasImage = node => eligible(node) && node.images?.some(item => item?.url);
        const lookup = ids => Array.from(ids, id => byId.get(id)).filter(Boolean);
        const after = id => lookup(outgoing.get(id) || []);
        function before(id, includeFlow = true, includeLegacy = legacyInputs) {
            const ids = new Set((incoming.get(id) || []).filter(edge => includeFlow || edge.kind === 'input').map(edge => edge.id));
            if (includeLegacy) for (const input of byId.get(id)?.inputNodeIds || []) ids.add(input);
            return lookup(ids);
        }

        function traverse(id, links, afterChildren = false) {
            const seen = new Set([id]);
            const result = [];
            const stack = [{ node: null, links: links(id).values() }];
            while (stack.length) {
                const frame = stack.at(-1);
                const next = frame.links.next();
                if (next.done) {
                    if (afterChildren && frame.node) result.push(frame.node);
                    stack.pop();
                    continue;
                }
                const node = next.value;
                if (seen.has(node.id)) continue;
                seen.add(node.id);
                if (!afterChildren) result.push(node);
                stack.push({ node, links: links(node.id).values() });
            }
            return result;
        }

        const ancestors = id => traverse(id, current => before(current, true, false), true);
        const descendants = id => traverse(id, after);
        const imageTargets = id => after(id).filter(eligible).sort(fromLeft);
        const isWorkflowTarget = (source, target) => target.sourceNodeId !== source.id;
        const hasWorkflowTarget = source => imageTargets(source.id).some(target => isWorkflowTarget(source, target));

        function loopFor(id) {
            const node = traverse(id, before, true).findLast(loopNode);
            return node ? { node, count: loopCount(node), mode: node.mode === 'parallel' ? 'parallel' : 'serial' } : null;
        }

        function inputChain(tail) {
            const path = [];
            const visited = new Set();
            for (let node = tail; node && !visited.has(node.id);) {
                path.push(node);
                visited.add(node.id);
                const inputs = before(node.id);
                const direct = inputs.filter(hasImage).sort(nearestInput)[0];
                const loop = inputs.find(loopNode);
                node = direct || (loop?.imageInput ? before(loop.id).find(item => isImage(item) && item.images?.some(image => image?.url)) : null);
            }
            return path.reverse().filter(eligible);
        }

        function branches(rootNode) {
            const children = new Map();
            const edges = [];
            const parents = new Set();
            let cycle = false;
            function visit(node) {
                const next = after(node.id).filter(target => !isHistory(target) && (isImage(target) || loopNode(target))).sort(fromLeft);
                children.set(node.id, next);
                parents.add(node.id);
                return { node, next: next.values() };
            }
            const stack = [visit(rootNode)];
            while (stack.length) {
                const frame = stack.at(-1);
                const next = frame.next.next();
                if (next.done) {
                    parents.delete(frame.node.id);
                    stack.pop();
                    continue;
                }
                const target = next.value;
                edges.push({ source: frame.node, target, key: edgeKey(frame.node.id, target.id) });
                if (parents.has(target.id)) cycle = true;
                else if (!children.has(target.id)) stack.push(visit(target));
            }
            return { children, edges, cycle };
        }

        function plan(id) {
            const tail = byId.get(id);
            const loop = loopFor(id);
            if (!eligible(tail)) return { loop, root: null, path: [], edges: [], children: new Map(), direct: false, runnable: false };
            const path = inputChain(tail);
            const pathIds = new Set(path.map(node => node.id));
            const loopTargets = loop ? imageTargets(loop.node.id) : [];
            const rootNode = loopTargets.find(node => pathIds.has(node.id)) || path[0];
            const branch = branches(rootNode);
            const direct = rootNode === tail && loopTargets.includes(tail) && !hasWorkflowTarget(tail);
            const runnable = !isBoard(tail) && !branch.cycle && (direct ||
                (!descendants(id).some(eligible) && (Boolean(loop) || branch.edges.length > 0)));
            return { root: rootNode, path, loop, direct, runnable, ...branch };
        }

        function tailForLoop(id) {
            const linked = imageTargets(id);
            if (loopNode(byId.get(id))) {
                const terminal = linked.findLast(node => !hasWorkflowTarget(node));
                if (terminal) return terminal;
            }
            const direct = new Set(linked.map(node => node.id));
            const ranked = descendants(id).filter(eligible).sort((a, b) =>
                Number(direct.has(a.id)) - Number(direct.has(b.id)) || x(b) - x(a) || y(b) - y(a));
            return ranked.find(node => plan(node.id).runnable) || null;
        }

        function connectionKeys(activeLoops) {
            const keys = new Set();
            const loops = nodes.filter(node => loopNode(node) && (!activeLoops.size || activeLoops.has(node.id)));
            for (const loop of loops) {
                const tail = tailForLoop(loop.id);
                if (!tail) continue;
                const graph = plan(tail.id);
                if (!graph.root || graph.cycle) continue;
                for (const edge of graph.edges) keys.add(edge.key);
                const path = new Set(graph.path.map(node => node.id));
                const joinsPath = id => path.has(id) || descendants(id).some(node => path.has(node.id));
                for (const edge of connections) {
                    if (edge.from === loop.id && edge.kind !== 'history' && joinsPath(edge.to)) keys.add(edgeKey(edge.from, edge.to));
                }
                for (const id of path) {
                    if (!connections.some(edge => edge.to === id && edge.kind !== 'history')) continue;
                    for (const input of before(id, false)) {
                        if (loopNode(input) && input.showPrompt) keys.add(edgeKey(input.id, id));
                    }
                }
            }
            return keys;
        }

        return { ancestors, descendants, imageTargets, loopFor, plan, tailForLoop, connectionKeys };
    }

    root.XiaomeiSmartRunGraph = { index };
})(window);
