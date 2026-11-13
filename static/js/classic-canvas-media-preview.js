(function (root) {
    'use strict';

    const { originalMediaUrl: original, proxyMediaUrl: proxy } = root.XiaomeiCanvasEditorCore;
    const previewable = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|avi|mkv|flv)(?:[?#]|$)/i;
    const kinds = new Set(['image', 'video', 'audio', 'text', 'file']);
    const extensions = {
        video: new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'flv']),
        audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']),
        text: new Set(['txt', 'json', 'csv', 'srt', 'vtt', 'md']),
    };
    const localMedia = /^\/(?:output|assets)\//;
    const players = 'video[data-url], audio[data-url]';
    const videoThumb = 'img[data-preview-kind="video"]';
    const imageThumbs = 'img[data-preview-src][data-original-src]';
    const upgradeDelay = 320;

    const displayUrl = (url, name = '') => proxy(original(url), name, { inline: true });

    function extension(url) {
        const path = original(url).split(/[?#]/, 1)[0].replace(/^[a-z]+:\/\/[^/]+/i, '');
        return path.match(/\.([a-z0-9]+)$/i)?.[1] || '';
    }

    function mediaKind(url) {
        const ext = extension(url).toLowerCase();
        for (const [kind, formats] of Object.entries(extensions)) {
            if (formats.has(ext)) return kind;
        }
        return 'image';
    }

    function referenceKind(ref) {
        const declared = String(ref?.kind || ref?.mediaKind || '').toLowerCase();
        return kinds.has(declared) ? declared : mediaKind(typeof ref === 'string' ? ref : ref?.url);
    }

    function nodeKind(node) {
        if (node?.mediaKind) return node.mediaKind;
        const kind = mediaKind(node?.url);
        return kind === 'text' ? 'image' : kind;
    }

    function kindTitle(kind) {
        if (kind === 'video') return 'Video';
        if (kind === 'audio') return 'Audio';
        return 'Image';
    }

    const nodeTitle = node => kindTitle(nodeKind(node));
    const refsOfKind = (refs, kind) => (refs || []).filter(ref => ref?.url && referenceKind(ref) === kind);
    const imageRefs = refs => refsOfKind(refs, 'image').slice(0, 20);
    const videoRefs = refs => refsOfKind(refs, 'video');
    const audioRefs = refs => refsOfKind(refs, 'audio');
    const isVideo = url => mediaKind(url) === 'video';
    const downloadName = url => 'canvas-output-' + Date.now() + '.' + (extension(url) || 'png');

    function previewUrl(url, size = 512) {
        const source = original(url);
        if (!localMedia.test(source)) return displayUrl(source);
        if (!previewable.test(source)) return source;
        const width = Math.max(64, Math.min(2048, Math.round(Number(size) || 512)));
        return '/api/media-preview?w=' + width + '&url=' + encodeURIComponent(source);
    }

    function normalizedSize(size) {
        const w = Number(size?.w ?? size?.width ?? 0);
        const h = Number(size?.h ?? size?.height ?? 0);
        return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
    }

    function create(host) {
        const { layer, escape } = host;
        const document = layer.ownerDocument;
        const watched = new WeakSet();
        const failedPreviews = new WeakSet();
        const measured = new WeakMap();
        const probes = new Map();
        let upgradeTimer;
        let revision = 0;

        function thumbnail(url, size, attrs, video = false) {
            const source = original(url);
            const preview = escape(previewUrl(source, size));
            const raw = escape(source);
            const flags = video ? ' data-preview-kind="video"' : '';
            return '<img loading="lazy" decoding="async" src="' + preview + '" data-preview-src="' + preview
                + '" data-original-src="' + raw + '" data-url="' + raw + '"' + flags + (attrs ? ' ' + attrs : '') + '>';
        }

        const imageHtml = (url, size, attrs) => thumbnail(url, size, attrs);
        const videoHtml = (url, size, attrs) => thumbnail(url, size, attrs, true);

        function replaceVideoThumbnail(image, autoPlay) {
            const url = original(image.dataset.originalSrc || image.dataset.url || image.getAttribute('src'));
            if (!url) return null;
            const video = document.createElement('video');
            video.dataset.url = url;
            video.preload = 'metadata';
            video.playsInline = true;
            video.disablePictureInPicture = true;
            video.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
            video.controls = autoPlay || image.hasAttribute('data-preview-controls');
            video.autoplay = autoPlay;
            video.defaultMuted = !autoPlay;
            video.muted = !autoPlay;
            video.src = displayUrl(url);
            image.replaceWith(video);
            return video;
        }

        function playQuietly(player) {
            player.play()?.catch(() => {});
        }

        function playVideo(target) {
            const thumb = target?.matches(videoThumb) ? target : target?.querySelector(videoThumb);
            const player = thumb ? replaceVideoThumbnail(thumb, true)
                : target?.matches('video[data-url]') ? target : target?.querySelector('video[data-url]');
            if (!player) return false;
            player.controls = true;
            player.muted = false;
            player.parentElement?.querySelector('.canvas-video-play')?.style.setProperty('display', 'none');
            playQuietly(player);
            return true;
        }

        function fallback(image) {
            if (!image.isConnected) return;
            if (image.matches(videoThumb)) {
                replaceVideoThumbnail(image, false);
                return;
            }
            const { originalSrc, previewSrc } = image.dataset;
            const source = image.getAttribute('src');
            if (source !== previewSrc || !originalSrc || originalSrc === previewSrc) return;
            failedPreviews.add(image);
            image.src = originalSrc;
        }

        function bindFallbacks(container) {
            for (const image of container.querySelectorAll(imageThumbs)) {
                if (watched.has(image)) continue;
                watched.add(image);
                image.addEventListener('error', () => fallback(image));
                if (image.complete && image.currentSrc && !image.naturalWidth) fallback(image);
            }
        }

        function isThumbnail(image) {
            const { previewSrc, originalSrc } = image?.dataset || {};
            return Boolean(previewSrc && originalSrc && previewSrc !== originalSrc && image.getAttribute('src') === previewSrc);
        }

        function probe(src) {
            if (!probes.has(src)) {
                const entry = { size: null };
                entry.task = new Promise(resolve => {
                    const image = new root.Image();
                    image.decoding = 'async';
                    image.onload = () => resolve(normalizedSize({ w: image.naturalWidth, h: image.naturalHeight }));
                    image.onerror = () => resolve(null);
                    image.src = src;
                }).then(size => {
                    entry.size = size;
                    if (!size) probes.delete(src);
                    return size;
                });
                probes.set(src, entry);
            }
            return probes.get(src).task;
        }

        async function dimensions(url) {
            const size = await probe(url);
            if (!size) throw new Error('Image dimensions unavailable');
            return { width: size.w, height: size.h };
        }

        function updateSelection() {
            root.clearTimeout(upgradeTimer);
            const pass = ++revision;
            const upgrades = [];
            for (const image of layer.querySelectorAll('.node ' + imageThumbs)) {
                if (image.matches(videoThumb)) continue;
                const id = image.closest('.node').dataset.id;
                const { previewSrc, originalSrc } = image.dataset;
                if (!host.selected(id)) {
                    if (!failedPreviews.has(image) && image.getAttribute('src') !== previewSrc) image.src = previewSrc;
                    continue;
                }
                const target = displayUrl(originalSrc);
                if (!target || image.getAttribute('src') === target || host.editorOpen()) continue;
                if (probes.get(target)?.size) image.src = target;
                else upgrades.push({ image, id, target });
            }
            if (!upgrades.length || host.editorOpen()) return;
            upgradeTimer = root.setTimeout(() => {
                for (const { image, id, target } of upgrades) {
                    probe(target).then(size => {
                        if (!size || pass !== revision || !image.isConnected || host.editorOpen() || !host.selected(id)) return;
                        image.src = target;
                    });
                }
            }, upgradeDelay);
        }

        function measureNodes() {
            for (const image of layer.querySelectorAll('.image-node img[data-original-src]')) {
                if (image.matches(videoThumb)) continue;
                const id = image.closest('.image-node').dataset.id;
                const node = host.node(id);
                if (node?.type !== 'image' || !node.url || node.natural_w || node.natural_h) continue;
                const source = node.url;
                const url = image.dataset.originalSrc;
                if (!url || /^(data|blob):/i.test(url) || measured.get(node) === source) continue;
                measured.set(node, source);
                probe(url).then(size => {
                    if (measured.get(node) !== source) return;
                    measured.delete(node);
                    if (!size || host.node(id) !== node || node.url !== source || node.natural_w || node.natural_h) return;
                    Object.assign(node, { natural_w: size.w, natural_h: size.h });
                    host.save();
                });
            }
        }

        function mediaSlots(card) {
            const slots = new Map();
            for (const element of card.querySelectorAll(players + ', ' + videoThumb)) {
                const kind = element.tagName === 'AUDIO' ? 'audio' : 'video';
                const url = original(element.dataset.originalSrc || element.dataset.url);
                if (!url) continue;
                const key = kind + ':' + url;
                if (!slots.has(key)) slots.set(key, []);
                slots.get(key).push(element);
            }
            return slots;
        }

        function carryPlayback(previous, next) {
            const slots = mediaSlots(previous);
            for (const [key, targets] of mediaSlots(next)) {
                const existing = slots.get(key) || [];
                for (const [index, target] of targets.entries()) {
                    const player = existing[index];
                    if (!player?.matches(players)) continue;
                    const playing = !player.paused;
                    target.replaceWith(player);
                    if (playing && player.paused) playQuietly(player);
                }
            }
        }

        function domSize(element) {
            if (!element || isThumbnail(element)) return null;
            return normalizedSize({ w: element.naturalWidth || element.videoWidth, h: element.naturalHeight || element.videoHeight });
        }

        function nodeSize(node) {
            if (!node) return null;
            const stored = normalizedSize({ w: node.natural_w || node.width, h: node.natural_h || node.height });
            if (stored) return stored;
            if (node.type === 'output') {
                const item = node.images?.findLast(host.outputUrl);
                return normalizedSize(item);
            }
            if (node.type !== 'image') return null;
            return domSize(layer.querySelector('.image-node[data-id="' + root.CSS.escape(node.id) + '"] img'));
        }

        function pendingSize(node, { requestSize, refs = [] } = {}) {
            const requested = normalizedSize(requestSize) || normalizedSize(host.parseSize(requestSize));
            if (requested) return requested;
            if (node?.type === 'comfy' && (node.mode || 'text') === 'text') {
                return normalizedSize({ w: node.width || 1024, h: node.height || 1024 });
            }
            for (const ref of refs || []) {
                const direct = normalizedSize(ref);
                if (direct) return direct;
                if (!ref?.url) continue;
                const source = host.nodes().find(item => item.type === 'image' && item.url === ref.url
                    || item.type === 'output' && item.images?.some(value => host.outputUrl(value) === ref.url));
                const stored = nodeSize(source);
                if (stored) return stored;
                const url = root.CSS.escape(ref.url);
                const matched = layer.querySelector('[data-url="' + url + '"], [data-output-url="' + url + '"] img, img[src="' + url + '"]');
                const current = domSize(matched);
                if (current) return current;
            }
            return null;
        }

        return { imageHtml, videoHtml, playVideo, bindFallbacks, updateSelection, measureNodes, pendingSize, carryPlayback, dimensions,
            hasPlayer: card => Boolean(card?.querySelector(players)) };
    }

    root.XiaomeiClassicMediaPreview = { create, original, displayUrl, previewUrl, normalizedSize, referenceKind, nodeKind,
        nodeTitle, kindTitle, imageRefs, videoRefs, audioRefs, isVideo, downloadName };
})(window);
