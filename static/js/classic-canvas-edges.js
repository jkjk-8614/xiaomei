(function (root) {
    'use strict';

    const connector = 'xiaomei-classic';
    const { Graph, Path } = root.X6;
    Graph.registerConnector(connector, (source, target, vertices, options) => {
        const { d } = root.XiaomeiNodeKernel.curveBetween(source, target, 'classic');
        return options?.raw ? Path.parse(d) : d;
    });

    function mount(container) {
        const graph = new Graph({
            container,
            interacting: false,
            async: false,
        });
        const saved = new Map();
        let draft = null;
        let trail = null;

        function add(source, target, className, options = {}) {
            return graph.addEdge({
                source,
                target,
                connector: options.connector || connector,
                vertices: options.vertices,
                zIndex: options.zIndex ?? 0,
                attrs: {
                    line: { class: className, targetMarker: null },
                    wrap: options.hitId === undefined ? { display: 'none' } : {
                        class: 'link-hit',
                        'data-connection-id': options.hitId,
                    },
                },
            });
        }

        function move(edge, source, target) {
            const previousSource = edge.getSource();
            const previousTarget = edge.getTarget();
            if (source.x !== previousSource.x || source.y !== previousSource.y) edge.setSource(source);
            if (target.x !== previousTarget.x || target.y !== previousTarget.y) edge.setTarget(target);
        }

        function render(segments, preview, knifePoints = []) {
            const active = new Set();
            for (const { c, a, b, selected } of segments) {
                active.add(c);
                const className = selected ? 'link link-active' : 'link';
                const edge = saved.get(c);
                if (!edge) {
                    saved.set(c, add(a, b, className, { hitId: String(c.id) }));
                    continue;
                }
                move(edge, a, b);
                if (edge.getAttrByPath('line/class') !== className) edge.setAttrByPath('line/class', className);
            }
            for (const [connection, edge] of saved) {
                if (active.has(connection)) continue;
                edge.remove();
                saved.delete(connection);
            }

            if (preview) {
                const source = { x: preview.x1, y: preview.y1 };
                const target = { x: preview.x2, y: preview.y2 };
                if (draft) move(draft, source, target);
                else draft = add(source, target, 'link temp', { zIndex: 1 });
            } else if (draft) {
                draft.remove();
                draft = null;
            }

            if (knifePoints.length > 1) {
                const source = knifePoints[0];
                const target = knifePoints.at(-1);
                const vertices = knifePoints.slice(1, -1);
                if (trail) {
                    move(trail, source, target);
                    trail.setVertices(vertices);
                } else {
                    trail = add(source, target, 'link knife-trail', { connector: 'normal', vertices, zIndex: 2 });
                }
            } else if (trail) {
                trail.remove();
                trail = null;
            }
        }

        return { render };
    }

    root.XiaomeiClassicEdges = { mount };
}(window));
