(function (root) {
    'use strict';

    function gridSize(base, count, scale) {
        const total = Math.max(1, Number(count) || 1);
        if (total === 1) return { w: Math.round(base.w), h: Math.round(base.h) };
        const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(total))));
        const rows = Math.ceil(total / columns);
        const longerSide = Math.max(base.w, base.h);
        const tileEdge = Math.min(220, Math.max(96, longerSide * 0.42));
        const shortEdge = Math.max(40 * scale, Math.round(tileEdge * Math.min(base.w, base.h) / longerSide));
        const tile = base.w >= base.h ? { w: tileEdge, h: shortEdge } : { w: shortEdge, h: tileEdge };
        return { w: columns * (tile.w + 8) + 16, h: rows * (tile.h + 8) + 16 };
    }

    function references(items, includeKind = false) {
        const entries = [];
        for (const item of items || []) {
            if (!item?.url) continue;
            const ref = { url: item.url, name: item.name || '', nodeId: item.nodeId || '', imageIndex: item.imageIndex ?? '' };
            if (includeKind) ref.kind = item.kind || '';
            entries.push(ref);
        }
        return entries;
    }

    function mentionDraft(text, refs, escape, token) {
        const draft = String(text || '');
        if (!draft.includes('@')) return '';
        const byName = new Map();
        for (const ref of refs || []) {
            if (ref?.url && ref.name && !byName.has(String(ref.name))) byName.set(String(ref.name), ref);
        }
        if (!byName.size) return '';
        const names = [...byName.keys()].sort((left, right) => right.length - left.length);
        const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const matches = draft.matchAll(new RegExp('@(' + alternatives.join('|') + ')', 'g'));
        let html = '';
        let cursor = 0;
        for (const match of matches) {
            html += escape(draft.slice(cursor, match.index)) + token(byName.get(match[1]));
            cursor = match.index + match[0].length;
        }
        return html + escape(draft.slice(cursor));
    }

    function stripImageGenerationMeta(image) {
        if (!image) return image;
        for (const field of ['runPrompt', 'runModelPrompt', 'runSettings', 'sourceNodeId', 'runAt', 'promptDraftHtml', 'promptDraftText']) {
            delete image[field];
        }
        return image;
    }


    const nonPreview = images => (images || []).filter(item => item?.url && !item.loopInputPreview);

    function uniqueMedia(images) {
        const output = [];
        const byKind = new Map();
        for (const item of nonPreview(images)) {
            const kind = item.kind || '';
            if (!byKind.has(kind)) byKind.set(kind, new Set());
            const urls = byKind.get(kind);
            if (urls.has(item.url)) continue;
            urls.add(item.url);
            output.push(stripImageGenerationMeta({ ...item }));
        }
        return output;
    }

    function mediaTitle(kind, count) {
        const names = { image: ['Image', 'Group'], video: ['Video', 'Videos'], audio: ['Audio', 'Audios'],
            text: ['Text', 'Texts'], file: ['File', 'Group'] };
        return (Object.hasOwn(names, kind) ? names[kind] : names.image)[Number(count) > 1 ? 1 : 0];
    }

    function createHistory(host) {
        const title = '历史分组';

        function connected(sourceId, archiveId) {
            return Boolean(sourceId && archiveId && host.connections().some(
                edge => edge.kind === 'history' && edge.from === sourceId && edge.to === archiveId
            ));
        }

        function detach(group) {
            if (!group) return;
            delete group.historyFor;
            delete group.isHistoryGroup;
            if (group.title === title) {
                const count = group.images?.length || 0;
                group.title = count ? mediaTitle('image', count) : host.emptyTitle();
            }
        }

        function groupFor(node) {
            if (!node?.id) return null;
            let first = null;
            for (const group of host.nodes()) {
                if (group.historyFor !== node.id || !host.isHistory(group)) continue;
                if (connected(node.id, group.id)) first ??= group;
                else detach(group);
            }
            return first;
        }

        function position(node, group) {
            if (!node || !group) return;
            const source = host.rect(node);
            if (!Number.isFinite(Number(group.x))) {
                const offset = Math.max(0, (source.width - host.rect(group).width) / 2);
                group.x = Math.round((Number(node.x) || 0) + offset);
            }
            if (!Number.isFinite(Number(group.y))) group.y = Math.round((Number(node.y) || 0) + source.height + 56);
        }

        function archive(node, additions, kind) {
            if (!node?.id) return null;
            let group = groupFor(node);
            if (!group && additions.length) {
                group = {
                    id: host.id(), images: [], created_at: Date.now(),
                    x: Math.round(Number(node.x || 0)),
                    y: Math.round(Number(node.y || 0) + host.rect(node).height + 56),
                };
                host.addNode(group);
            }
            if (!group) return null;
            Object.assign(group, {
                type: 'smart-image', title, historyFor: node.id, isHistoryGroup: true,
                images: uniqueMedia([...additions, ...(group.images || [])]), outputKind: kind, scale: host.scale,
            });
            delete group.w;
            delete group.h;
            host.connect(node.id, group.id);
            position(node, group);
            return group;
        }

        return { connected, detach, groupFor, position, archive };
    }

    root.XiaomeiSmartOutput = {
        gridSize, references, mentionDraft, stripImageGenerationMeta, nonPreview, uniqueMedia, mediaTitle, createHistory,
    };
}(window));
