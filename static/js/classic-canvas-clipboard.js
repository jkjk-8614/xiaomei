(function (root) {
    'use strict';

    function create(host) {
        const history = root.XiaomeiHistoryKernel;
        const { selectedGraph, rewriteReferences } = root.XiaomeiClassicWorkflowTransfer;
        let contents;

        function portable(node) {
            const copy = history.cloneData(host.transferable(node));
            if (Array.isArray(copy._pending)) copy._pending = [];
            delete copy._naturalSizeLoading;
            return copy;
        }

        function capture() {
            if (!host.ready()) return;
            const fragment = selectedGraph(host.nodes(), host.edges(), host.selected);
            if (!fragment.nodes.length) return;
            contents = {
                nodes: fragment.nodes.map(portable),
                connections: history.cloneData(fragment.connections),
            };
        }

        function insert(fragment, shift, keepUpstream) {
            const ids = Object.create(null);
            for (const node of fragment.nodes) ids[node.id] = host.id(node.type);
            const identify = id => history.lookupId(ids, id, keepUpstream, key => Boolean(host.node(key)));
            const order = host.mapInputOrder(fragment.nodes, identify);
            const copies = fragment.nodes.map(node => {
                const next = portable(node);
                next.id = ids[node.id];
                next.x = Number(node.x || 0) + shift.x;
                next.y = Number(node.y || 0) + shift.y;
                next.running = false;
                rewriteReferences(next, identify);
                if (Array.isArray(next.inputs)) next.inputs = next.inputs.map(order);
                return next;
            });
            const edges = history.remapEdges(fragment.connections, ids, {
                keepUnknownFrom: keepUpstream,
                allowUnknownFrom: key => Boolean(host.node(key)),
                newId: () => host.id('c'),
            });
            host.snapshot();
            host.nodes().push(...copies);
            for (const edge of edges) {
                if (host.allowed(edge.from, edge.to) && !host.edges().some(item => item.from === edge.from && item.to === edge.to)) {
                    host.edges().push(edge);
                }
            }
            return { copies, ids };
        }

        function paste() {
            if (!host.ready() || !contents?.nodes.length) return;
            const shift = history.centerShift(contents.nodes, host.pointer());
            const { copies } = insert(contents, shift, false);
            host.selected.clear();
            for (const node of copies) host.selected.add(node.id);
            host.pasted();
        }

        function duplicate(node, keepUpstream) {
            const graph = selectedGraph(host.nodes(), host.edges(), [node.id]);
            const connections = keepUpstream ? host.edges().filter(edge => graph.ids.has(String(edge.to))) : [];
            const { copies, ids } = insert({ nodes: graph.nodes, connections }, { x: 0, y: 0 }, keepUpstream);
            return copies.find(copy => copy.id === ids[node.id]);
        }

        return { capture, paste, duplicate, count: () => contents?.nodes.length || 0 };
    }

    root.XiaomeiClassicClipboard = { create };
})(window);
