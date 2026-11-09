/* Xiaomei node kernel.
   Drag cohorts, connection curves, and group membership.
   This is the only node path. Query parameters, stored flags, and setActive
   do not select another implementation. */
(function (root) {
    'use strict';

    var GENERATOR = { generator: 1, msgen: 1, comfy: 1, ltxDirector: 1, video: 1, rh: 1 };
    var LOOP_IMAGE = { image: 1, group: 1, output: 1 };
    var LOOP_PROMPT = { prompt: 1, promptGroup: 1, loop: 1, llm: 1 };
    var LLM_SOURCE = { prompt: 1, loop: 1, promptGroup: 1, llm: 1, image: 1, group: 1, output: 1 };
    var FLOW_SOURCE = { image: 1, prompt: 1, loop: 1, group: 1, promptGroup: 1, output: 1, llm: 1 };

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-nodes', 'next');
    }

    function isActive() { return true; }

    function setActive() {
        markDocument();
        return true;
    }

    function worldDelta(pointer, origin, zoom) {
        var scale = Number(zoom);
        if (!Number.isFinite(scale) || scale === 0) scale = 1;
        return {
            x: (Number(pointer.x) - Number(origin.x)) / scale,
            y: (Number(pointer.y) - Number(origin.y)) / scale
        };
    }

    function snappedDelta(origin, rawDelta, grid) {
        var size = Number(grid);
        if (!Number.isFinite(size) || size <= 0) return rawDelta;
        var base = Number(origin) || 0;
        return Math.round((base + rawDelta) / size) * size - base;
    }

    function shiftPoint(x, y, dx, dy, round) {
        var nextX = (Number(x) || 0) + dx;
        var nextY = (Number(y) || 0) + dy;
        if (round) {
            nextX = Math.round(nextX);
            nextY = Math.round(nextY);
        }
        return { x: nextX, y: nextY };
    }

    function passedDeadzone(pointer, origin, radius) {
        return Math.hypot(pointer.x - origin.x, pointer.y - origin.y) >= (Number(radius) || 0);
    }

    function dragCompanions(records, dragged, selectedIds) {
        var seen = {};
        var companions = [];
        function visit(id) {
            if (!id || id === dragged.id || seen[id]) return;
            var node = records[id];
            if (!node) return;
            seen[id] = true;
            companions.push({ id: node.id, originX: Number(node.x) || 0, originY: Number(node.y) || 0 });
            if (node.group) (node.items || []).forEach(visit);
        }
        if (dragged.group) (dragged.items || []).forEach(visit);
        var selected = selectedIds || [];
        if (selected.indexOf(dragged.id) >= 0 && selected.length > 1) selected.forEach(visit);
        return companions;
    }

    function expandIds(seedIds, describe) {
        var seen = {};
        var out = [];
        function add(id) {
            if (!id || seen[id]) return;
            seen[id] = true;
            out.push(id);
            var info = describe ? describe(id) : null;
            if (!info) return;
            if (info.groupId) add(info.groupId);
            (info.memberIds || []).forEach(add);
        }
        (seedIds || []).forEach(add);
        return out;
    }

    function directMembers(groupId, itemIds, lookup, reject) {
        var seen = {};
        seen[groupId] = true;
        var out = [];
        (itemIds || []).forEach(function (id) {
            var member = lookup(id);
            if (!member || seen[member.id] || (reject && reject(member))) return;
            seen[member.id] = true;
            out.push(member.id);
        });
        return out;
    }

    function bend(from, to, floor) {
        return Math.max(floor, Math.abs(to.x - from.x) * 0.45);
    }

    function curveBetween(from, to, mode, sign) {
        var direction = sign === -1 ? -1 : 1;
        var span = bend(from, to, mode === 'classic' ? 80 : 50);
        var rise = Math.max(36, Math.abs(to.y - from.y) * 0.45);
        var d;
        if (mode === 'straight') d = 'M' + from.x + ' ' + from.y + ' L' + to.x + ' ' + to.y;
        else if (mode === 'history') d = 'M' + from.x + ' ' + from.y + ' C ' + from.x + ' ' + (from.y + rise) + ', ' + to.x + ' ' + (to.y - rise) + ', ' + to.x + ' ' + to.y;
        else if (mode === 'classic') d = 'M ' + from.x + ' ' + from.y + ' C ' + (from.x + span) + ' ' + from.y + ', ' + (to.x - span) + ' ' + to.y + ', ' + to.x + ' ' + to.y;
        else if (mode === 'port') d = 'M' + from.x + ' ' + from.y + ' C ' + (from.x + span * direction) + ' ' + from.y + ', ' + (to.x - span * direction) + ' ' + to.y + ', ' + to.x + ' ' + to.y;
        else d = 'M' + from.x + ' ' + from.y + ' C ' + (from.x + span) + ' ' + from.y + ', ' + (to.x - span) + ' ' + to.y + ', ' + to.x + ' ' + to.y;
        return {
            d: d,
            endX: to.x,
            endY: to.y,
            midX: (from.x + to.x) / 2,
            midY: (from.y + to.y) / 2
        };
    }

    function sampleCurve(from, to, t, mode) {
        var amount = Math.max(0, Math.min(1, t));
        var span = bend(from, to, mode === 'classic' ? 80 : 50);
        var c1 = { x: from.x + span, y: from.y };
        var c2 = { x: to.x - span, y: to.y };
        if (mode === 'history') {
            var rise = Math.max(36, Math.abs(to.y - from.y) * 0.45);
            c1 = { x: from.x, y: from.y + rise };
            c2 = { x: to.x, y: to.y - rise };
        }
        var u = 1 - amount;
        return {
            x: u * u * u * from.x + 3 * u * u * amount * c1.x + 3 * u * amount * amount * c2.x + amount * amount * amount * to.x,
            y: u * u * u * from.y + 3 * u * u * amount * c1.y + 3 * u * amount * amount * c2.y + amount * amount * amount * to.y
        };
    }

    function edgeAnchor(box, side, ratio) {
        var along = Number.isFinite(ratio) ? ratio : 0.5;
        var x = side === 'out' ? box.x + box.w : box.x;
        return { x: x, y: box.y + box.h * along };
    }

    function nearestPoint(points, x, y, radius) {
        var best = null;
        var bestDistance = Infinity;
        (points || []).forEach(function (point) {
            var distance = Math.hypot(x - point.x, y - point.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = point;
            }
        });
        return best && bestDistance <= radius ? best : null;
    }

    function reaches(edges, startId, goalId) {
        var seen = {};
        var stack = [startId];
        while (stack.length) {
            var id = stack.pop();
            if (id === goalId) return true;
            if (seen[id]) continue;
            seen[id] = true;
            (edges || []).forEach(function (edge) {
                if (edge.from === id) stack.push(edge.to);
            });
        }
        return false;
    }

    function classicMayConnect(fromType, toType, options) {
        var flags = options || {};
        if (!fromType || !toType) return false;
        if (GENERATOR[fromType]) {
            if (toType === 'output') return true;
            if (flags.mediaOutput && GENERATOR[toType]) return Boolean(flags.acyclic);
            return false;
        }
        if (toType === 'loop') {
            return Boolean((flags.loopImage && LOOP_IMAGE[fromType]) || (flags.loopPrompt && LOOP_PROMPT[fromType]));
        }
        if (toType === 'llm') return Boolean(LLM_SOURCE[fromType]);
        if (fromType === 'llm') return Boolean(GENERATOR[toType]);
        return Boolean(GENERATOR[toType] && FLOW_SOURCE[fromType]);
    }

    function centerInside(child, group) {
        var cx = child.x + child.w / 2;
        var cy = child.y + child.h / 2;
        return cx >= group.x && cx <= group.x + group.w && cy >= group.y && cy <= group.y + group.h;
    }

    function columnLayout(items, edges, gaps) {
        if (!items || items.length < 2) return null;
        var known = {};
        items.forEach(function (item) { known[item.id] = item; });
        var indegree = {};
        items.forEach(function (item) { indegree[item.id] = 0; });
        var internal = (edges || []).filter(function (edge) { return known[edge.from] && known[edge.to]; });
        internal.forEach(function (edge) { indegree[edge.to] = (indegree[edge.to] || 0) + 1; });
        var depth = {};
        items.forEach(function (item) { depth[item.id] = 0; });
        if (internal.length) {
            var roots = items.filter(function (item) { return !indegree[item.id]; }).map(function (item) { return item.id; });
            var queue = roots.length ? roots.slice() : [items[0].id];
            var seen = {};
            queue.forEach(function (id) { seen[id] = true; });
            while (queue.length) {
                var id = queue.shift();
                internal.forEach(function (edge) {
                    if (edge.from !== id) return;
                    depth[edge.to] = Math.max(depth[edge.to] || 0, (depth[id] || 0) + 1);
                    if (!seen[edge.to]) {
                        seen[edge.to] = true;
                        queue.push(edge.to);
                    }
                });
            }
        }
        var columns = {};
        items.forEach(function (item) {
            var level = depth[item.id] || 0;
            if (!columns[level]) columns[level] = [];
            columns[level].push(item);
        });
        var levels = Object.keys(columns).map(Number).sort(function (a, b) { return a - b; });
        var cursorX = Math.min.apply(null, items.map(function (item) { return item.x; }));
        var startY = Math.min.apply(null, items.map(function (item) { return item.y; }));
        var placed = [];
        levels.forEach(function (level) {
            var column = columns[level].slice().sort(function (a, b) {
                var ay = Number.isFinite(a.sortY) ? a.sortY : a.y;
                var by = Number.isFinite(b.sortY) ? b.sortY : b.y;
                return ay - by || String(a.id).localeCompare(String(b.id));
            });
            var cursorY = startY;
            var widest = 0;
            column.forEach(function (item) {
                placed.push({ id: item.id, x: cursorX, y: cursorY });
                cursorY += Math.max(gaps.minRow, item.h) + gaps.rowGap;
                widest = Math.max(widest, Math.max(gaps.minCol, item.w));
            });
            cursorX += widest + gaps.colGap;
        });
        return placed;
    }

    function uniqueEdges(edges, identify) {
        var seen = {};
        var out = [];
        (edges || []).forEach(function (edge) {
            if (!edge || !edge.from || !edge.to || edge.from === edge.to) return;
            var key = identify ? identify(edge) : edge.from + '\u0000' + edge.to;
            if (seen[key]) return;
            seen[key] = true;
            out.push(edge);
        });
        return out;
    }

    markDocument();

    root.XiaomeiNodeKernel = {
        isActive: isActive,
        setActive: setActive,
        worldDelta: worldDelta,
        snappedDelta: snappedDelta,
        shiftPoint: shiftPoint,
        passedDeadzone: passedDeadzone,
        dragCompanions: dragCompanions,
        expandIds: expandIds,
        directMembers: directMembers,
        curveBetween: curveBetween,
        sampleCurve: sampleCurve,
        edgeAnchor: edgeAnchor,
        nearestPoint: nearestPoint,
        reaches: reaches,
        classicMayConnect: classicMayConnect,
        centerInside: centerInside,
        columnLayout: columnLayout,
        uniqueEdges: uniqueEdges
    };
})(typeof window !== 'undefined' ? window : globalThis);
