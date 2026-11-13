(function (root) {
    'use strict';

    const runnable = new Set(['generator', 'msgen', 'comfy', 'ltxDirector', 'llm', 'video', 'rh']);
    const relays = new Set(['output', 'loop']);

    function index(nodes, connections) {
        const byId = new Map(nodes.map(node => [node.id, node]));
        const incoming = new Map();
        const outgoing = new Map();
        for (const { from, to } of connections) {
            if (!incoming.has(to)) incoming.set(to, []);
            if (!outgoing.has(from)) outgoing.set(from, []);
            incoming.get(to).push(from);
            outgoing.get(from).push(to);
        }
        return { byId, incoming, outgoing };
    }

    function terminal(id, { byId, outgoing }) {
        const seen = new Set([id]);
        const pending = [...(outgoing.get(id) || [])];
        while (pending.length) {
            const next = pending.pop();
            if (seen.has(next)) continue;
            seen.add(next);
            const type = byId.get(next)?.type;
            if (runnable.has(type)) return false;
            if (relays.has(type)) pending.push(...(outgoing.get(next) || []));
        }
        return true;
    }

    function order(nodes, connections, target) {
        const { byId, incoming } = index(nodes, connections);
        const seen = new Set();
        const plan = [];
        function visit(id) {
            if (seen.has(id)) return;
            seen.add(id);
            const node = byId.get(id);
            if (!node) return;
            for (const parent of incoming.get(id) || []) {
                const parentType = byId.get(parent)?.type;
                if (runnable.has(parentType) || relays.has(parentType)) visit(parent);
            }
            if (runnable.has(node.type)) plan.push(id);
        }
        visit(target);
        return plan;
    }

    function upstream(nodes, connections, target) {
        const { incoming } = index(nodes, connections);
        const seen = new Set();
        const pending = [target];
        while (pending.length) {
            const next = pending.pop();
            for (const id of incoming.get(next) || []) {
                if (seen.has(id)) continue;
                seen.add(id);
                pending.push(id);
            }
        }
        return seen;
    }

    function loopTarget(nodes, connections, loop) {
        const graph = index(nodes, connections);
        const seen = new Set();
        let best;
        let bestTerminal;
        function visit(id, depth) {
            if (seen.has(id)) return;
            seen.add(id);
            for (const next of graph.outgoing.get(id) || []) {
                if (!graph.byId.has(next)) continue;
                const distance = depth + 1;
                if (runnable.has(graph.byId.get(next).type)) {
                    if (!best || distance > best.distance) best = { id: next, distance };
                    if ((!bestTerminal || distance > bestTerminal.distance) && terminal(next, graph)) {
                        bestTerminal = { id: next, distance };
                    }
                }
                visit(next, distance);
            }
        }
        visit(loop, 0);
        return (bestTerminal || best)?.id || '';
    }

    root.XiaomeiClassicWorkflow = {
        order,
        upstream,
        loopTarget,
        terminal: (nodes, connections, id) => terminal(id, index(nodes, connections)),
    };
}(window));
