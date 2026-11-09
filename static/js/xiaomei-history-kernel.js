/* Xiaomei history kernel.
   Bounded undo stacks, paste placement, id remapping, and shortcut chords.
   This is the only history path. Query parameters, stored flags, and setActive
   do not select another implementation. */
(function (root) {
    'use strict';

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-history', 'next');
    }

    function isActive() { return true; }

    function setActive() {
        markDocument();
        return true;
    }

    function cloneData(value) {
        if (value == null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function push(past, future, snapshot, limit, clearFuture) {
        if (clearFuture && future) future.length = 0;
        past.push(snapshot);
        var cap = Number(limit) || 0;
        if (cap > 0) {
            while (past.length > cap) past.shift();
        }
        return past;
    }

    function undo(past, future, current) {
        if (!past || !past.length) return null;
        if (future) future.push(current);
        return past.pop();
    }

    function redo(past, future, current) {
        if (!future || !future.length) return null;
        past.push(current);
        return future.pop();
    }

    function centerShift(points, target) {
        var list = points || [];
        if (!list.length) return { x: 0, y: 0 };
        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        list.forEach(function (point) {
            var x = Number(point.x);
            var y = Number(point.y);
            if (!Number.isFinite(x)) x = 0;
            if (!Number.isFinite(y)) y = 0;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        });
        return {
            x: Number(target.x) - (minX + maxX) / 2,
            y: Number(target.y) - (minY + maxY) / 2
        };
    }

    function lookupId(table, id, keepUnknown, allow) {
        if (table && Object.prototype.hasOwnProperty.call(table, id) && table[id]) return table[id];
        if (keepUnknown && (!allow || allow(id))) return id;
        return '';
    }

    function remapEdges(edges, table, options) {
        var flags = options || {};
        return (edges || []).map(function (edge) {
            var from = lookupId(table, edge.from, flags.keepUnknownFrom, flags.allowUnknownFrom);
            var to = lookupId(table, edge.to, flags.keepUnknownTo, flags.allowUnknownTo);
            var next = {};
            Object.keys(edge).forEach(function (key) { next[key] = edge[key]; });
            next.from = from;
            next.to = to;
            if (flags.newId) next.id = flags.newId(edge);
            return next;
        }).filter(function (edge) {
            return edge.from && edge.to && edge.from !== edge.to;
        });
    }

    function remapIdList(ids, table, keepUnknown) {
        return (ids || []).map(function (id) {
            return lookupId(table, id, keepUnknown);
        }).filter(Boolean);
    }

    function pasteStillFresh(requestedAt, laterMarks) {
        var marks = laterMarks || [];
        for (var i = 0; i < marks.length; i += 1) {
            if (Number(marks[i]) >= requestedAt) return false;
        }
        return true;
    }

    function chord(input, context) {
        var key = String(input.key || '').toLowerCase();
        var command = Boolean(input.ctrl || input.meta);
        var profile = context.profile || 'classic';
        if (!command && !input.alt && key === 'z') {
            if (context.plainEditable || context.modal) return null;
            if (input.repeat) return { type: 'ignore' };
            return { type: 'zoom-preview' };
        }
        if (!command) return null;
        if (key === 'g') {
            if (profile === 'smart' && context.commandEditable) return null;
            if (profile === 'smart' && input.shift) return { type: 'ungroup' };
            if (input.shift) return null;
            return { type: 'group' };
        }
        if (context.commandEditable) return null;
        if (key === 'c') {
            if (context.textSelected) return null;
            return { type: 'copy' };
        }
        if (key === 'v') {
            if (!context.canPaste) return null;
            return { type: 'paste-deferred', delay: 90 };
        }
        if (key === 'y') {
            if (profile !== 'smart') return null;
            return { type: 'redo' };
        }
        if (key === 'z') {
            if (profile === 'smart' && input.shift) return { type: 'redo' };
            return { type: 'undo' };
        }
        return null;
    }

    markDocument();

    root.XiaomeiHistoryKernel = {
        isActive: isActive,
        setActive: setActive,
        cloneData: cloneData,
        push: push,
        undo: undo,
        redo: redo,
        centerShift: centerShift,
        lookupId: lookupId,
        remapEdges: remapEdges,
        remapIdList: remapIdList,
        pasteStillFresh: pasteStillFresh,
        chord: chord
    };
})(typeof window !== 'undefined' ? window : globalThis);
