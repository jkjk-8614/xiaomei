(function (root) {
    'use strict';

    const imageDragType = 'application/x-canvas-output-image';
    const gridType = 'grid-split';
    const urlOf = item => typeof item === 'string' ? item : item?.url || '';
    const record = item => item && typeof item === 'object' ? item : {};
    const extension = /\.[a-z0-9]{2,8}$/i;
    const baseName = value => String(value || '').split(/[?#]/, 1)[0];

    function fileName(url) {
        const encoded = baseName(url).split('/').filter(Boolean).at(-1);
        if (!encoded) return 'output image';
        try { return decodeURIComponent(encoded); } catch (_) { return encoded; }
    }

    function metadata(url, node) {
        return record(node?.images?.find(item => urlOf(item) === url));
    }

    function comparison(url, node) {
        const value = node?.imageComparisons?.[url];
        return (typeof value === 'string' ? value : value?.url)
            || metadata(url, node).run?.refs?.find(ref => ref?.url)?.url || '';
    }

    function append(node, items, reference, metas = [], layout = null) {
        if (!node) return;
        const added = [];
        for (const [index, item] of (items || []).filter(Boolean).entries()) {
            const url = urlOf(item);
            if (!url) continue;
            const source = record(item);
            const meta = metas[index] || metas[0] || {};
            const next = { url, viewed: false, runMs: meta.runMs || 0, run: meta.run || null };
            const kind = meta.kind || source.kind || source.mediaKind;
            if (kind) next.kind = kind;
            if (source.name) next.name = source.name;
            if (meta.grid) next.grid = meta.grid;
            added.push(next);
        }
        if (!added.length) return;
        if (layout?.type === gridType) {
            node.images = added;
            node.outputLayout = layout;
            delete node.imageComparisons;
        } else {
            node.images = (node.images || []).concat(added);
            delete node.outputLayout;
        }
        if (reference?.url) {
            node.imageComparisons = {
                ...node.imageComparisons,
                ...Object.fromEntries(added.map(({ url }) => [url, { url: reference.url, name: reference.name || 'input image' }])),
            };
        }
    }

    function layoutFor(node) {
        const layout = node.outputLayout;
        const images = node.images || [];
        return layout?.type === gridType && layout.groupId && images.length && !node._pending?.length
            && images.every(item => item?.grid?.groupId === layout.groupId) ? layout : null;
    }

    function create(host) {
        const doc = host.layer.ownerDocument;
        const grids = new WeakMap();
        const label = name => host.label('canvas.' + name);
        let timer;

        function element(tag, className, text) {
            const el = doc.createElement(tag);
            if (className) el.className = className;
            if (text != null) el.textContent = text;
            return el;
        }

        function icon(name, className) {
            const el = element('i', className);
            el.dataset.lucide = name;
            return el;
        }

        function fragment(html) {
            const template = doc.createElement('template');
            template.innerHTML = html;
            return template.content;
        }

        function button(className, title, handler) {
            const el = element('button', className);
            el.type = 'button';
            if (title) {
                el.title = title;
                el.setAttribute('aria-label', title);
            }
            el.onmousedown = event => event.stopPropagation();
            el.onclick = event => {
                event.stopPropagation();
                handler();
            };
            return el;
        }

        function remove(state, entry) {
            const { node } = state;
            if (entry.pending) {
                node._pending = (node._pending || []).filter(item => item.id !== entry.pending.id);
            } else {
                node.images = (node.images || []).filter(item => urlOf(item) !== entry.url);
                if (node.imageComparisons) delete node.imageComparisons[entry.url];
            }
            host.changed(node.id);
        }

        function makeCell(state, entry) {
            const wrap = element('div', 'output-img-wrap');
            const del = button('output-del', host.label('common.delete'), () => remove(state, entry));
            del.textContent = '×';
            if (entry.pending) wrap.dataset.pendingId = entry.pending.id;
            else wrap.dataset.outputUrl = entry.url;
            wrap.append(del);
            return { wrap, del };
        }

        function renderPending(state, cell, pending) {
            const { wrap, del } = cell;
            const size = host.pendingSize(pending.previewSize);
            wrap.style.aspectRatio = size ? Math.max(1, size.w) + ' / ' + Math.max(1, size.h) : '';
            wrap.classList.add('loading-wrap');
            wrap.classList.toggle('recoverable', Boolean(pending.failed));
            const pill = element('span', 'output-time-pill');
            if (!pending.failed) {
                pill.classList.add('running');
                pill.dataset.startedAt = String(pending.startedAt || 0);
                paintTime(pill);
                wrap.replaceChildren(pill, element('div', 'output-spinner'), del);
                return;
            }

            const recovery = host.recovery(pending);
            const receipt = recovery.type === 'receipt';
            const task = receipt ? '' : recovery.id;
            const progress = Boolean(pending.querying);
            pill.classList.add('failed');
            pill.textContent = label('outputFailed');
            const body = element('div', 'output-recover-state');
            const status = progress ? label('outputQuerying') : label(receipt ? 'imageReceiptPending' : 'outputTaskRecoverable');
            const hint = receipt ? label('imageReceiptMissing') : task
                ? label('outputTaskId').replace('{id}', () => String(task))
                : label('outputNoTaskId');
            const detail = element('div', 'output-recover-sub', hint);
            detail.title = pending.error || label('generationFailed');
            const query = button('output-recover-query', '', () => host.recover(pending.id, state.node.id));
            query.textContent = progress ? label('outputQueryingAction') : label('outputQueryResult');
            query.disabled = progress || (!task && !receipt);
            body.append(icon('refresh-cw', progress ? 'spinning' : ''), element('div', 'output-recover-title', status), detail, query);
            wrap.replaceChildren(pill, body, del);
        }

        function bindDrag(wrap) {
            const preview = wrap.querySelector('img[data-url]');
            if (!preview) return;
            preview.draggable = true;
            preview.ondragstart = event => {
                const transfer = event.dataTransfer;
                if (!transfer) return;
                event.stopPropagation();
                preview.dataset.dragging = '1';
                transfer.effectAllowed = 'copy';
                transfer.setData(imageDragType, preview.dataset.url);
                transfer.setData('text/uri-list', preview.dataset.url);
                const sample = element('div', 'output-drag-preview');
                const clone = preview.cloneNode();
                clone.removeAttribute('id');
                sample.append(clone);
                doc.body.append(sample);
                const { width, height } = preview.getBoundingClientRect();
                transfer.setDragImage(sample, Math.min(120, width / 2), Math.min(120, height / 2));
                root.setTimeout(() => sample.remove(), 0);
            };
            preview.ondragend = () => root.setTimeout(() => delete preview.dataset.dragging, 0);
        }

        function renderMedia(state, cell, { url, kind, missing, layout }) {
            const { wrap, del } = cell;
            const pixels = layout ? 512 : 768;
            if (missing) {
                wrap.dataset.missingUrl = url;
                wrap.prepend(fragment(host.missingView(url)));
            } else if (kind === 'audio') {
                wrap.classList.add('output-audio-wrap');
                const card = element('div', 'output-audio-card');
                const player = element('audio');
                player.src = url;
                player.dataset.url = url;
                player.controls = true;
                player.preload = 'metadata';
                card.append(icon('file-audio', 'w-7 h-7'), element('span', '', fileName(url)), player);
                wrap.prepend(card);
            } else if (kind === 'file' || kind === 'text') {
                wrap.classList.add('output-file-wrap');
                const card = element('div', 'output-file-card');
                cell.name = element('span');
                card.append(icon(kind === 'text' ? 'file-text' : 'file', 'w-7 h-7'), cell.name, element('small', '', kind.toUpperCase()));
                wrap.prepend(card);
            } else {
                wrap.prepend(fragment(host.thumbnail(url, pixels, kind)));
                bindDrag(wrap);
                if (kind === 'video') {
                    const play = button('canvas-video-play output-video-play', label('outputPlay'), () => host.play(wrap));
                    play.append(icon('play'));
                    const badge = element('div', 'output-video-badge', 'VIDEO');
                    badge.prepend(icon('play', 'w-3 h-3'));
                    wrap.insertBefore(play, del);
                    wrap.insertBefore(badge, del);
                }
            }
            cell.pill = element('span', 'output-time-pill');
            wrap.onclick = event => {
                const target = event.target;
                if (target.closest('.output-file-card')) {
                    event.stopPropagation();
                    host.download(url).catch(error => host.alert(error.message || label('outputDownloadFailed')));
                    return;
                }
                const media = target.closest('img[data-url], video[data-url]');
                if (media && wrap.contains(media)) {
                    event.stopPropagation();
                    if (!media.dataset.dragging) host.preview(media.dataset.url, state.node);
                }
            };
        }

        function updateMedia(cell, item, layout) {
            const meta = record(item);
            const grid = layout && meta.grid;
            const style = cell.wrap.style;
            style.gridRow = grid ? String(Number(grid.row || 0) + 1) : '';
            style.gridColumn = grid ? String(Number(grid.col || 0) + 1) : '';
            style.aspectRatio = grid ? Math.max(1, Number(grid.w || 1)) + ' / ' + Math.max(1, Number(grid.h || 1)) : '';
            if (cell.name) cell.name.textContent = meta.name || fileName(urlOf(item));
            if (meta.runMs && !meta.viewed) {
                cell.pill.textContent = host.duration(meta.runMs);
                if (!cell.pill.parentNode) cell.wrap.insertBefore(cell.pill, cell.del);
            } else cell.pill.remove();
        }

        function update(state, node) {
            state.node = node;
            const { grid, cells } = state;
            const layout = layoutFor(node);
            grid.classList.toggle('grid-layout', Boolean(layout));
            if (layout) grid.style.setProperty('--grid-cols', String(Math.max(1, Number(layout.cols || 1))));
            else grid.style.removeProperty('--grid-cols');

            const order = [];
            const counts = new Map();
            function cellFor(parts, entry) {
                const base = JSON.stringify(parts);
                const index = counts.get(base) || 0;
                counts.set(base, index + 1);
                const key = base + ':' + index;
                let cell = cells.get(key);
                if (!cell) {
                    cell = makeCell(state, entry);
                    if (!entry.pending) renderMedia(state, cell, entry);
                    cells.set(key, cell);
                }
                order.push({ key, el: cell.wrap });
                return cell;
            }

            for (const item of node.images || []) {
                const url = urlOf(item);
                const kind = host.kind(item);
                const missing = host.missing(url);
                const cell = cellFor([url, kind, missing], { url, kind, missing, layout });
                updateMedia(cell, item, layout);
            }
            for (const pending of node._pending || []) {
                const cell = cellFor(['pending', pending.id], { pending });
                const signature = JSON.stringify([
                    pending.previewSize, pending.startedAt, pending.failed, pending.querying,
                    pending.recoverTaskId, pending.waitStopped, pending.canvasTaskId, pending.clientRequestId, pending.error,
                ]);
                if (cell.signature !== signature) {
                    cell.signature = signature;
                    renderPending(state, cell, pending);
                }
            }

            const present = new Set(order.map(item => item.key));
            for (const [key, cell] of cells) {
                if (present.has(key)) continue;
                cell.wrap.remove();
                cells.delete(key);
            }
            let cursor = grid.firstElementChild;
            for (const { el } of order) {
                if (el !== cursor) grid.insertBefore(el, cursor);
                cursor = el.nextElementSibling;
            }
        }

        function mount(node, body) {
            const grid = element('div', 'output-grid');
            const state = { grid, cells: new Map() };
            grids.set(grid, state);
            body.append(grid);
            body.onwheel = event => event.stopPropagation();
            update(state, node);
        }

        function patch(node) {
            const grid = host.layer.querySelector('.output-node[data-id="' + root.CSS.escape(node.id) + '"] .output-grid');
            const state = grids.get(grid);
            if (!state) return false;
            update(state, node);
            return true;
        }

        function paintTime(pill) {
            const started = Number(pill.dataset.startedAt);
            pill.textContent = host.duration(started ? Date.now() - started : 0);
        }

        function refreshTimers() {
            const running = host.layer.querySelectorAll('.output-time-pill.running');
            if (!running.length && timer) {
                root.clearInterval(timer);
                timer = 0;
            } else if (running.length && !timer) {
                timer = root.setInterval(() => {
                    host.layer.querySelectorAll('.output-time-pill.running').forEach(paintTime);
                }, 1000);
            }
        }

        function viewed(source, url) {
            const node = source?.id ? host.node(source.id) || source : source;
            const unread = node?.images?.some(item => record(item).url === url && !item.viewed);
            if (!unread) return;
            node.images = node.images.map(item => record(item).url === url ? { ...item, viewed: true } : item);
            host.changed(node.id);
        }

        function images(node) {
            return (node?.images || []).filter(item => host.kind(item) === 'image').map(urlOf).filter(Boolean);
        }

        function groupImages(group) {
            if (group?.type !== 'group') return [];
            const result = [];
            for (const id of group.items || []) {
                const node = host.node(id);
                if (node?.type !== 'image' || !node.url || host.nodeKind(node) !== 'image' || host.missing(node.url)) continue;
                result.push({ url: node.url, name: node.name || fileName(node.url), kind: 'image', nodeId: id, __index: result.length });
            }
            return result;
        }

        function lightboxItems(source) {
            const toEntries = (items, id = '') => items.flatMap(item => {
                const url = urlOf(item);
                return url && host.kind(item) === 'image' ? [{ url, outId: id }] : [];
            });
            const node = source?.id && (host.node(source.id) || source);
            if (node?.type === 'group') return toEntries(groupImages(node), node.id);
            if (node?.type === 'image' && node.url) return toEntries([{ url: node.url, kind: host.nodeKind(node) }], node.id);
            if (node) return toEntries(node.images || [], node.id);
            const current = host.nodes().flatMap(item => item.type === 'output' ? toEntries(item.images || [], item.id) : []);
            return current.length ? current : host.logs().flatMap(log => toEntries(log.outputs || []));
        }

        function bundle(node, copy) {
            const urls = images(node);
            if (!urls.length) return null;
            const cols = Math.min(4, Math.ceil(Math.sqrt(urls.length)));
            const rows = Math.ceil(urls.length / cols);
            const w = 260, h = 336, gap = 24;
            const offset = copy ? 36 : 0;
            const x = Number(node.x || 0) + offset, y = Number(node.y || 0) + offset;
            const children = urls.map((url, index) => ({
                id: host.id('img'), type: 'image', url, name: fileName(url), w, h,
                x: x + 24 + index % cols * (w + gap), y: y + 58 + Math.floor(index / cols) * (h + gap),
            }));
            const group = {
                id: host.id('grp'), type: 'group', x, y, items: children.map(child => child.id),
                w: cols * (w + gap) - gap + 48, h: rows * (h + gap) - gap + 90,
            };
            return { group, children };
        }

        const localFiles = node => (node?.images || []).map(urlOf).filter(url => /^\/(output|assets)\//.test(url) && !host.missing(url));
        const safeName = name => String(name).replace(/[\\/:*?"<>|]+/g, '_').trim();

        async function zip(payload) {
            if (!payload.urls.length) {
                host.alert(label('outputDownloadEmpty'));
                return;
            }
            try {
                const response = await root.fetch('/api/canvas-assets/download', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                });
                if (!response.ok) throw new Error(await host.responseError(response, label('outputDownloadEmpty')));
                const href = root.URL.createObjectURL(await response.blob());
                const link = element('a');
                link.href = href;
                link.download = payload.filename;
                doc.body.append(link);
                link.click();
                link.remove();
                root.setTimeout(() => root.URL.revokeObjectURL(href), 1200);
            } catch (error) {
                host.alert(error.message || label('outputDownloadEmpty'));
            }
        }

        function downloadOutput(node) {
            return zip({ urls: localFiles(node), filename: (host.title() || 'canvas-output').slice(0, 48) + '-' + node.id + '.zip' });
        }

        function downloadGroup(id) {
            const items = groupImages(host.node(id)).map(({ url, name }, index) => {
                const known = [name, url].map(baseName).find(value => extension.test(value));
                const ext = known?.match(extension)?.[0] || '.png';
                const sanitized = safeName(name) || 'image-' + String(index + 1).padStart(2, '0') + ext;
                return { url, name: extension.test(sanitized) ? sanitized : sanitized + ext };
            });
            const filename = safeName((host.title() || 'canvas-group') + '-' + id + '.zip') || 'canvas-group.zip';
            return zip({ filename, urls: items.map(item => item.url), items });
        }

        function menu(node, x, y) {
            const surface = root.XiaomeiCanvasSurface;
            const target = host.menu;
            const makeGroup = copy => {
                const current = host.node(node.id);
                const value = current && bundle(current, copy);
                if (value) host.commitGroup(current, value, copy);
            };
            const action = (icon, name, enabled, run) => ({
                icon, label: label(name), disabled: !enabled, onClick: event => {
                    event.stopPropagation();
                    host.closeMenu();
                    run();
                },
            });
            const hasImages = images(node).length > 0;
            target.classList.add('output-node-menu');
            surface.paintMenu(target, [
                { title: label('outputGroupActions'), divider: true, items: [
                    action('replace', 'outputConvertToInputGroup', hasImages, () => makeGroup(false)),
                    action('copy-plus', 'outputCopyToInputGroup', hasImages, () => makeGroup(true)),
                ] },
                { title: label('outputFileActions'), items: [
                    action('download', 'outputDownloadAllImages', localFiles(node).length > 0, () => downloadOutput(host.node(node.id) || node)),
                ] },
            ]);
            surface.pinMenu(target, Math.max(10, Math.min(root.innerWidth - 270, x)), y);
            target.classList.add('open');
            host.icons();
        }

        return { mount, patch, refreshTimers, viewed, groupImages, lightboxItems, downloadGroup, menu };
    }

    root.XiaomeiClassicOutputCards = { create, append, metadata, comparison, fileName, urlOf };
})(window);
