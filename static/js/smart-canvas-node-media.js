(function (root) {
    'use strict';

    const cardSelector = '.image-node';
    const frameSelector = '.image-wrap, .thumb-item, .batch-screen-media, .collapsed-text-stack-image-card';
    const mediaSelector = 'img[data-original-src], video[data-url], audio[data-url]';
    const videoMeasurement = '.image-node video[data-url]';
    const measurementSelector = [
        `.image-node :is(${frameSelector}) img[data-original-src]`,
        '.image-node :is(.smart-ai-render-output-image, .color-node-preview-image)[data-original-src]',
        videoMeasurement,
    ].join(',');

    function sourceOf(element) {
        return element.dataset.originalSrc || element.dataset.url || element.getAttribute('src') || '';
    }

    function locationOf(element, card = element.closest(cardSelector)) {
        const slot = element.closest('[data-ref-node-id], [data-image-index]');
        const {refNodeId, refImageIndex, imageIndex} = slot?.dataset || {};
        return {
            nodeId: refNodeId || card?.dataset.id,
            index: Number(refImageIndex ?? imageIndex ?? 0),
            slot,
            card,
        };
    }

    function cardMedia(card) {
        return [...card.querySelectorAll(mediaSelector)].filter(element =>
            element.closest(frameSelector) || element.matches('video[data-url], audio[data-url]')
        );
    }

    function queueBy(items, keyOf) {
        const queues = new Map();
        for (const item of items) {
            const key = keyOf(item);
            if (!queues.has(key)) queues.set(key, []);
            queues.get(key).push(item);
        }
        return queues;
    }

    function mediaKeys(element, card) {
        const {nodeId, index} = locationOf(element, card);
        const source = JSON.stringify([element.localName, element.dataset.previewKind, sourceOf(element)]);
        return {element, source, slot:JSON.stringify([nodeId, index, source])};
    }

    function size(element, width, height) {
        element.style.width = width;
        element.style.height = height;
    }

    function patchSize(card, layout, options) {
        const width = `${layout.width}px`;
        const height = `${layout.height}px`;
        size(card, width, height);
        const body = card.querySelector('.node-body');
        if (!body) return;

        if (options.agent) {
            for (const part of [body, body.querySelector('.agent-node-card')].filter(Boolean)) {
                size(part, '100%', '100%');
                part.style.minHeight = '0';
            }
        }
        const loading = body.querySelector('.loading-cell.single');
        if (loading) size(loading, width, height);
        const skeleton = body.querySelector('.loading-skeleton');
        if (skeleton) {
            const count = Math.max(1, options.images.length + options.pending);
            const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));
            const rows = Math.ceil(count / columns);
            size(skeleton, width, height);
            skeleton.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
            skeleton.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
        }

        const grid = body.querySelector('.thumb-grid');
        if (grid) {
            const rows = Math.max(1, Math.min(options.visibleRows, Number(layout.visibleRows || layout.rows || 1)));
            const thumbHeight = layout.thumbH || layout.thumb;
            const gap = 8;
            const properties = {
                '--thumb-cols': layout.cols,
                '--thumb-size': `${layout.thumb}px`,
                '--thumb-w': `${layout.thumbW || layout.thumb}px`,
                '--thumb-h': `${thumbHeight}px`,
                '--thumb-max-height': `${rows * (Number(thumbHeight) || 96) + (rows - 1) * gap}px`,
            };
            for (const [key, value] of Object.entries(properties)) grid.style.setProperty(key, value);
            [...grid.querySelectorAll('.thumb-item')].forEach((tile, index) => {
                options.updateThumbnail(tile, options.images[index], layout.thumb);
            });
        }

        const mediaWidth = options.grouped ? `${Math.max(24, Number(layout.innerW) || layout.width - 32)}px` : width;
        const mediaHeight = options.grouped ? `${Math.max(24, Number(layout.innerH) || layout.height - 60)}px` : height;
        const frame = body.querySelector('.image-wrap');
        if (frame) {
            frame.style.setProperty('--node-img-w', mediaWidth);
            frame.style.setProperty('--node-img-h', mediaHeight);
        }
        const media = body.querySelector('.node-img');
        if (media) size(media, mediaWidth, mediaHeight);
    }

    function create(host) {
        const world = host.world;
        const observed = new WeakSet();
        const fallbackTried = new WeakSet();
        const playbackMoves = new WeakSet();

        function liveItem(element, lookup = host.node) {
            const location = locationOf(element);
            const node = lookup(location.nodeId);
            const item = node?.images?.[location.index];
            if (!item?.url) return null;
            const source = sourceOf(element);
            if (!source || !host.matchesSource(item, source)) return null;
            return {...location, node, item};
        }

        function rememberActivations(lookup) {
            for (const player of world.querySelectorAll('video[data-inline-video-active="1"]')) {
                const entry = liveItem(player, lookup);
                if (entry && host.isVideo(entry.item)) entry.item._inlineVideoActive = true;
            }
        }

        function restoreAfterMove(player) {
            if (playbackMoves.has(player)) return;
            playbackMoves.add(player);
            const state = {
                time:player.currentTime,
                playing:!player.paused && !player.ended,
                volume:player.volume,
                rate:player.playbackRate,
                muted:player.muted,
            };
            const apply = () => {
                if (!world.contains(player)) {
                    playbackMoves.delete(player);
                    return;
                }
                if (!player.readyState) {
                    player.addEventListener('loadedmetadata', apply, {once:true});
                    return;
                }
                playbackMoves.delete(player);
                player.playbackRate = state.rate;
                player.volume = state.volume;
                player.muted = state.muted;
                if ((state.time > player.currentTime || !state.playing || player.paused)
                    && Math.abs(player.currentTime - state.time) > .05) {
                    player.currentTime = state.time;
                }
                if (state.playing && player.paused) player.play().catch(() => {});
                if (!state.playing && !player.paused) player.pause();
            };
            root.requestAnimationFrame(apply);
        }

        function moveMedia(previous, fresh) {
            const oldMedia = previous.element;
            const replacement = fresh.element;
            if (oldMedia.localName === 'img') {
                for (const name of ['class', 'style', 'alt', 'draggable', 'loading', 'decoding', 'data-preview-src']) {
                    const value = replacement.getAttribute(name);
                    if (value === null) oldMedia.removeAttribute(name);
                    else if (oldMedia.getAttribute(name) !== value) oldMedia.setAttribute(name, value);
                }
            } else {
                restoreAfterMove(oldMedia);
            }
            replacement.replaceWith(oldMedia);
        }

        function reuse(previousCard, freshCard) {
            const previous = cardMedia(previousCard).filter(sourceOf).map(element => mediaKeys(element, previousCard));
            if (!previous.length) return;
            const incoming = cardMedia(freshCard).filter(sourceOf).map(element => mediaKeys(element, freshCard));
            if (!incoming.length) return;
            // A template has a separate owner document. Keep live players in their current document.
            previousCard.ownerDocument.adoptNode(freshCard);
            // Reserve exact slots first so identical URLs can keep separate players.
            const exact = queueBy(previous, item => item.slot);
            const moved = new Set();
            const remaining = [];
            for (const destination of incoming) {
                const match = exact.get(destination.slot)?.shift();
                if (match) {
                    moved.add(match);
                    moveMedia(match, destination);
                } else {
                    remaining.push(destination);
                }
            }
            const bySource = queueBy(previous.filter(item => !moved.has(item)), item => item.source);
            for (const destination of remaining) {
                const match = bySource.get(destination.source)?.shift();
                if (match) moveMedia(match, destination);
            }
        }

        function measure(element, lookup) {
            if (!world.contains(element)) return;
            const entry = liveItem(element, lookup);
            if (!entry || entry.item.natural_w || entry.item.natural_h) return;
            const {item} = entry;
            const video = element.localName === 'video';
            const width = video ? element.videoWidth : element.naturalWidth;
            const height = video ? element.videoHeight : element.naturalHeight;
            if (!(width > 0 && height > 0)) return;
            if (!video && host.isPreview(element)) {
                if (item.layout_w && item.layout_h) return;
                Object.assign(item, {layout_w:width, layout_h:height});
            } else {
                item.natural_w = width;
                item.natural_h = height;
                delete item.layout_w;
                delete item.layout_h;
            }
            host.measured(entry);
        }

        function imageFailed(element) {
            if (!world.contains(element) || fallbackTried.has(element) || host.isPreview(element)) return;
            const entry = liveItem(element);
            if (!entry) return;
            const source = host.proxy(entry.item);
            if (source && source !== element.getAttribute('src')) {
                fallbackTried.add(element);
                element.src = source;
            }
        }

        world.addEventListener('loadedmetadata', event => {
            if (event.target.matches(videoMeasurement)) measure(event.target);
        }, true);

        function observe(lookup) {
            for (const element of world.querySelectorAll(measurementSelector)) {
                if (element.localName === 'img' && !observed.has(element)) {
                    observed.add(element);
                    element.addEventListener('load', () => measure(element));
                    element.addEventListener('error', () => imageFailed(element));
                }
                measure(element, lookup);
            }
        }

        return {observe, rememberActivations, reuse};
    }

    root.XiaomeiSmartNodeMedia = {create, patchSize};
})(window);
