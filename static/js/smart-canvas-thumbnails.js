(function (root) {
    'use strict';

    const thumbnailSelector = 'img[data-preview-src][data-original-src]';
    const videoThumbnail = 'img[data-preview-kind="video"]';
    const mediaContainer = '.media-video-card,.video-thumb,.image-wrap,.thumb-item';
    const cardControl = 'video,audio,.image-delete,.image-name-badge,.media-document-preview,.smart-video-play';
    const playerControls = 'nodownload noplaybackrate noremoteplayback';
    const thumbnailFormat = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|avi|mkv)(?:[?#]|$)/i;
    const thumbnailPath = /^\/(?:output|assets|api\/storage-files)\//;

    function create(host) {
        const { original, display, escape } = host;
        const bound = new WeakSet();

        function previewUrl(item, size = 512) {
            const source = original(item);
            const imported = host.imported(source);
            if (imported !== undefined) return imported;
            if (thumbnailPath.test(source) && thumbnailFormat.test(source)) {
                const width = Math.max(64, Math.min(2048, Math.round(Number(size) || 512)));
                return `/api/media-preview?w=${width}&url=${encodeURIComponent(source)}`;
            }
            return display(item);
        }

        function thumbnail(item, size, attributes, video) {
            const source = escape(original(item));
            const preview = escape(previewUrl(item, size));
            const decoding = /\bdecoding\s*=/i.test(attributes) ? '' : ' decoding="async"';
            const kind = video ? ` data-url="${source}" data-preview-kind="video"` : '';
            return `<img src="${preview}" data-preview-src="${preview}" data-original-src="${source}"${kind}${decoding}${attributes ? ' ' + attributes : ''}>`;
        }

        function playerHtml(item) {
            const source = original(item);
            return `<video src="${escape(display(source))}" data-url="${escape(source)}" data-inline-video-active="1" controls autoplay playsinline preload="metadata" disablepictureinpicture controlslist="${playerControls}"></video>`;
        }

        function replaceWithVideo(image, source, active) {
            const video = image.ownerDocument.createElement('video');
            video.dataset.url = source;
            video.playsInline = true;
            video.preload = 'metadata';
            video.disablePictureInPicture = true;
            video.setAttribute('controlslist', playerControls);
            video.defaultMuted = video.muted = !active;
            video.controls = video.autoplay = active;
            if (active) video.dataset.inlineVideoActive = '1';
            video.src = display(source);
            image.replaceWith(video);
            return video;
        }

        function isPreviewImage(image) {
            if (!image?.matches(thumbnailSelector)) return false;
            const { previewSrc, originalSrc } = image.dataset;
            return Boolean(previewSrc && originalSrc && previewSrc !== originalSrc && image.getAttribute('src') !== originalSrc);
        }

        function bindThumbnails(container = root.document) {
            for (const image of container.querySelectorAll(thumbnailSelector)) {
                if (bound.has(image)) continue;
                bound.add(image);
                image.addEventListener('error', () => {
                    const { originalSrc, previewKind } = image.dataset;
                    if (previewKind === 'video') {
                        replaceWithVideo(image, originalSrc || '', false);
                    } else if (host.managed(originalSrc)) {
                        // A failed thumbnail must avoid loading a full-resolution local asset.
                        image.dataset.previewFailed = '1';
                        image.removeAttribute('src');
                    } else if (originalSrc && image.getAttribute('src') !== originalSrc) {
                        image.src = originalSrc;
                    }
                });
            }
        }

        function mediaLocation(element, nodeId) {
            const { refNodeId, refImageIndex, imageIndex } = element?.dataset || {};
            return { nodeId: refNodeId || nodeId, index: Number(refImageIndex ?? imageIndex ?? 0) };
        }

        function playPreview(target) {
            const container = target?.closest(mediaContainer) || target?.parentElement;
            const thumbnail = target?.matches(videoThumbnail) ? target : container?.querySelector(videoThumbnail);
            let player;
            if (thumbnail) {
                const source = original(thumbnail.dataset.originalSrc || thumbnail.dataset.url || thumbnail.getAttribute('src'));
                if (!source) return false;
                player = replaceWithVideo(thumbnail, source, true);
            } else {
                const selector = 'video[data-url]';
                player = target?.matches(selector) ? target : container?.querySelector(selector);
                if (!player) return false;
            }

            const card = player.closest('.image-node');
            const slot = player.closest('[data-ref-node-id], [data-image-index]');
            const {nodeId, index} = mediaLocation(slot, card?.dataset.id);
            const media = host.node(nodeId)?.images?.[index];
            if (media) media._inlineVideoActive = true;
            player.dataset.inlineVideoActive = '1';
            player.controls = true;
            player.muted = false;
            player.parentElement?.querySelector('.smart-video-play')?.style.setProperty('display', 'none');
            player.play().catch(() => {});
            return true;
        }

        function stopControl(event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        function bindCardActions(card, cardId) {
            for (const button of card.querySelectorAll('.image-delete')) {
                button.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    host.remove(cardId, Number(button.dataset.imageIndex));
                });
            }
            for (const badge of card.querySelectorAll('.image-name-badge')) {
                badge.addEventListener('mousedown', stopControl, true);
                badge.addEventListener('click', stopControl, true);
                badge.addEventListener('dblclick', event => {
                    stopControl(event);
                    const { nodeId, index } = mediaLocation(badge.closest('[data-image-index]'), cardId);
                    host.suppressClick();
                    host.rename(nodeId, index);
                }, true);
            }
            for (const button of card.querySelectorAll('.smart-video-play')) {
                button.addEventListener('mousedown', stopControl, true);
                button.addEventListener('click', event => {
                    stopControl(event);
                    const { nodeId, index } = mediaLocation(button.closest('[data-image-index]'), cardId);
                    const owner = host.node(nodeId);
                    if (host.kind(owner?.images?.[index] || {}) !== 'video') return;
                    host.suppressClick();
                    host.hideTimer(owner);
                    playPreview(button);
                }, true);
            }
        }

        function bindCardGestures(card, cardId) {
            for (const tile of card.querySelectorAll('.thumb-item,.image-wrap')) {
                const locate = () => {
                    const location = mediaLocation(tile, cardId);
                    const owner = host.node(location.nodeId);
                    return { ...location, owner, image: owner?.images?.[location.index] };
                };
                const activate = media => {
                    host.suppressClick();
                    if (host.kind(media.image || {}) === 'video') {
                        host.hideTimer(media.owner || host.node(cardId));
                        playPreview(tile);
                    } else {
                        host.preview(cardId, media);
                    }
                };

                tile.draggable = false;
                tile.addEventListener('dragstart', event => event.preventDefault());
                tile.addEventListener('mousedown', event => {
                    if (event.button !== 0 || event.target.closest(cardControl)) return;
                    tile.ownerDocument.activeElement?.blur?.();
                    if (event.shiftKey && !event.altKey) {
                        stopControl(event);
                        host.modifySelection(cardId, event);
                    } else if (event.detail > 1) {
                        stopControl(event);
                        if (!host.clickSuppressed()) activate(locate());
                    }
                }, true);
                tile.addEventListener('click', event => {
                    if (event.target.closest(cardControl)) return;
                    stopControl(event);
                    if (host.clickSuppressed()) return;
                    const media = locate();
                    host.revealOutput(media.nodeId, media.index);
                    if (host.kind(media.image || {}) === 'video') {
                        activate(media);
                    } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
                        host.modifySelection(cardId, event);
                    } else if (event.detail > 1 || (tile.dataset.generationComplete === '1' && media.image?.url)) {
                        activate(media);
                    } else {
                        host.select(cardId, media);
                    }
                });
                tile.addEventListener('dblclick', event => {
                    if (event.target.closest(cardControl)) return;
                    stopControl(event);
                    if (!host.clickSuppressed()) activate(locate());
                }, true);

                if (!tile.matches('.thumb-item,.smart-group-single-thumb')) continue;
                tile.addEventListener('mousedown', event => {
                    if (event.button !== 0 || event.detail > 1 || event.target.closest(cardControl)) return;
                    if (host.beginDrag(cardId, tile, locate(), event)) stopControl(event);
                });
            }
        }

        return {
            previewUrl, playerHtml, isPreviewImage, bindThumbnails, bindCardActions, bindCardGestures,
            imageHtml: (item, size, attributes = '') => thumbnail(item, size, attributes, false),
            videoHtml: (item, size, attributes = '') => thumbnail(item, size, attributes, true),
        };
    }

    root.XiaomeiSmartCanvasThumbnails = { create };
})(window);
