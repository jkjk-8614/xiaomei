(function (root) {
    'use strict';

    const gap = 8;
    const inset = 16;
    const groupHeader = 44;
    const minTile = 28;
    const markupDocument = root.document.createElement('template').content.ownerDocument;

    function selectionBounds(rectangles) {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const box of rectangles) {
            left = Math.min(left, box.x);
            top = Math.min(top, box.y);
            right = Math.max(right, box.x + box.width);
            bottom = Math.max(bottom, box.y + box.height);
        }
        return {
            x: Math.round(left - 18),
            y: Math.round(top - groupHeader),
            w: Math.max(340, Math.round(right - left + 36)),
            h: Math.max(220, Math.round(bottom - top + 72)),
        };
    }

    function standalonePositions(container, layout, items, smart, fit) {
        const columns = Math.max(1, layout.cols || 1);
        const square = Math.max(minTile, Math.round(layout.thumb || 96));
        const width = smart ? Math.max(minTile, Math.round(layout.thumbW || square)) : square;
        const height = smart ? Math.max(minTile, Math.round(layout.thumbH || square)) : square;
        const left = Number(container.x) || 0;
        const top = Number(container.y) || 0;
        return items.map((item, index) => {
            const fitted = fit(item, Math.min(width, height));
            const x = left + inset + (index % columns) * (width + gap) + (width - fitted.width) / 2;
            const y = top + (smart ? groupHeader : inset)
                + Math.floor(index / columns) * (height + gap) + (height - fitted.height) / 2;
            return {x:Math.round(x), y:Math.round(y), w:fitted.width, h:fitted.height};
        });
    }

    function createGraph({keyOf, unique}) {
        function reroute(edges, from, to) {
            const removed = [];
            const updated = edges.map(edge => {
                if (edge?.from !== from && edge?.to !== from) return edge;
                removed.push(edge);
                return {
                    ...edge,
                    from: edge.from === from ? to : edge.from,
                    to: edge.to === from ? to : edge.to,
                };
            });
            return {removed, edges:unique(updated)};
        }

        function expand({groupId, edges, originals, placements, members, liveIds, deleted}) {
            const retiredIds = new Set([groupId]);
            const copies = new Map();
            for (const {origin, id} of placements) {
                if (!origin) continue;
                if (!liveIds.has(origin)) retiredIds.add(origin);
                if (!copies.has(origin)) copies.set(origin, []);
                copies.get(origin).push(id);
            }
            const aggregate = placements.length ? placements.map(item => item.id) : members;
            const detached = [], remaining = [];
            for (const edge of unique(edges)) {
                (edge.from === groupId || edge.to === groupId ? detached : remaining).push(edge);
            }

            const active = new Set([...remaining, ...detached].map(edge => keyOf(edge)));
            const restored = [];
            const represented = new Set();
            const endpoint = id => copies.get(id) || (id !== groupId && liveIds.has(id) ? [id] : []);
            const projected = id => copies.has(id) || !liveIds.has(id) ? groupId : id;

            function append(edge, sources, targets) {
                for (const from of sources) {
                    for (const to of targets) {
                        if (from !== to && liveIds.has(from) && liveIds.has(to)) restored.push({...edge, from, to});
                    }
                }
            }

            for (const edge of unique(originals)) {
                const from = projected(edge.from), to = projected(edge.to);
                const key = keyOf(edge, from, to);
                // Missing originals still account for their old aggregate edge.
                const groupEdge = from === groupId || to === groupId;
                if (groupEdge) represented.add(key);
                const boundary = groupEdge && from !== to;
                if (!active.has(key) && (boundary || deleted.has(key))) continue;
                append(edge, endpoint(edge.from), endpoint(edge.to));
            }

            // A live edge with no matching origin was drawn for the group as a whole.
            for (const edge of detached) {
                if (represented.has(keyOf(edge))) continue;
                append(edge, edge.from === groupId ? aggregate : [edge.from],
                    edge.to === groupId ? aggregate : [edge.to]);
            }
            const added = unique(restored);
            return {edges:unique([...remaining, ...added]), removed:detached, added, retiredIds};
        }

        function updateInputIds(nodes, retiredIds, added) {
            const lookup = new Map(nodes.map(node => [node.id, node]));
            for (const node of nodes) {
                if (Array.isArray(node.inputNodeIds)) node.inputNodeIds = node.inputNodeIds.filter(id => !retiredIds.has(id));
            }
            const byTarget = new Map();
            for (const edge of added) {
                if (edge.kind !== 'input') continue;
                const target = lookup.get(edge.to);
                if (!target) continue;
                if (!byTarget.has(target)) byTarget.set(target, new Set(target.inputNodeIds || []));
                byTarget.get(target).add(edge.from);
            }
            for (const [target, ids] of byTarget) target.inputNodeIds = [...ids];
        }

        return {reroute, expand, updateInputIds};
    }

    function renderBody({group, members, layout, selection, limits, single, thumbnail, badges, deleteTitle}) {
        const make = (tag, className) => {
            const element = markupDocument.createElement(tag);
            if (className) element.className = className;
            return element;
        };
        const icon = name => {
            const element = make('i');
            element.dataset.lucide = name;
            return element;
        };
        const refs = layout?.refs || [];
        const counts = new Map([['smart-prompt', 0], ['smart-loop', 0]]);
        for (const member of members) {
            if (counts.has(member.type)) counts.set(member.type, counts.get(member.type) + 1);
        }
        const captions = [
            [counts.get('smart-prompt'), '提示词'],
            [refs.length, '图片'],
            [counts.get('smart-loop'), '循环'],
        ];
        const label = make('span');
        label.textContent = captions.filter(([count]) => count).map(([count, name]) => count + ' ' + name).join(' · ')
            || '双击或拖入图片';
        const card = make('div', refs.length ? 'smart-group-card has-thumbs' : 'smart-group-card');
        const summary = make('div', 'smart-group-summary');
        summary.append(icon('group'), label);
        card.append(summary);

        if (!refs.length) {
            if (!members.length) {
                const empty = make('div', 'smart-group-empty');
                const hint = make('span');
                hint.textContent = '拖入图片自动收进分组';
                empty.append(icon('plus'), hint);
                card.append(empty);
            }
            return card.outerHTML;
        }

        summary.title = '拖动移动分组，按住 Ctrl 拖动缩略图可移出单张图片';
        function tile(ref, className, markup) {
            const element = make('div', className);
            element.classList.toggle('image-selected', selection.nodeId === ref.nodeId && selection.index === Number(ref.index));
            Object.assign(element.dataset, {refNodeId:ref.nodeId, refImageIndex:ref.index, imageIndex:ref.index});
            element.innerHTML = markup + badges(ref.item);
            if (ref.nodeId === group.id) {
                const remove = make('button', 'mini-x image-delete');
                remove.type = 'button';
                remove.dataset.imageIndex = ref.index;
                remove.title = deleteTitle;
                remove.append(icon('trash-2'));
                element.append(remove);
            }
            return element;
        }

        const singleSlot = (layout.cols || 1) * (layout.rows || 1) === 1 && refs.length === 1;
        if (singleSlot) {
            const width = Math.max(24, Number(layout.innerW || layout.width || limits.width));
            const height = Math.max(24, Number(layout.innerH || layout.height || limits.height));
            const frame = tile(refs[0], 'image-wrap smart-group-single-thumb', single(refs[0].item, width, height));
            frame.style.setProperty('--node-img-w', width + 'px');
            frame.style.setProperty('--node-img-h', height + 'px');
            card.append(frame);
        } else {
            const grid = make('div', 'thumb-grid smart-group-thumb-grid');
            const rows = Number(layout.rows || 1);
            const visible = Math.max(1, Math.min(layout.compactMembers?.length ? rows : limits.rows, Number(layout.visibleRows || rows)));
            const thumbHeight = layout.thumbH || layout.thumb;
            grid.dataset.thumbScroll = '1';
            const properties = {
                '--thumb-cols': layout.cols,
                '--thumb-size': layout.thumb + 'px',
                '--thumb-w': (layout.thumbW || layout.thumb) + 'px',
                '--thumb-h': thumbHeight + 'px',
                '--thumb-max-height': Math.max(44, visible * Number(thumbHeight || 96) + (visible - 1) * gap) + 'px',
            };
            for (const [name, value] of Object.entries(properties)) grid.style.setProperty(name, value);
            for (const ref of refs) grid.append(tile(ref, 'thumb-item', thumbnail(ref.item)));
            card.append(grid);
        }
        return card.outerHTML;
    }

    root.XiaomeiSmartGroups = {selectionBounds, standalonePositions, createGraph, renderBody};
})(window);
