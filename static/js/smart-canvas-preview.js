(function (root) {
    'use strict';

    const loadDeadline = 15000;
    const initialPose = () => ({ x: 0, y: 0, scale: 1 });
    const isMedia = item => Boolean(item?.url);
    const wrap = (value, count) => ((value % count) + count) % count;

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const stage = get('previewStage');
        const frame = get('previewFrame');
        const image = get('previewCurrentImage');
        const video = get('previewCurrentVideo');
        const comparison = get('previewCompareImage');
        const overlay = get('previewCompareLayer');
        const handle = get('previewCompareHandle');
        const thumbnails = get('compareThumbs');
        const compareButton = get('compareToggleBtn');
        const panoramaButton = get('panoramaToggleBtn');
        const loading = get('previewLoadingState');
        const loadingText = get('previewLoadingText');
        const retryButton = get('previewRetryBtn');
        const meta = get('previewMetaHint');
        const panorama = host.panorama;
        let session;
        let request;
        let comparisonUrl = '';
        let videoUrl = '';
        let videoCapture;
        let pose = initialPose();
        let gesture;
        let comparisonNodeId = '';
        let comparing = false;
        let referenceIndex = -1;
        let hint = '';

        function showLoading(state) {
            loading.hidden = state === 'idle';
            loading.classList.toggle('is-error', state === 'error');
            loadingText.textContent = host.label(state === 'error' ? 'smart.previewLoadFailed' : 'smart.previewLoading');
            retryButton.hidden = state !== 'error';
        }

        function dimensions(element) {
            return [element.videoWidth || element.naturalWidth || 0, element.videoHeight || element.naturalHeight || 0];
        }

        function paintMeta() {
            const { image: item } = host.current();
            const visible = videoUrl ? video : image;
            const [actualW, actualH] = dimensions(visible);
            const w = Number(item?.natural_w || item?.width || item?.w) || actualW;
            const h = Number(item?.natural_h || item?.height || item?.h) || actualH;
            const resolution = w && h ? host.label('smart.resolution') + ': ' + Math.round(w) + ' x ' + Math.round(h) : '';
            meta.textContent = [resolution, hint].filter(Boolean).join(' · ');
        }

        function syncFrame() {
            if (panorama.enabled()) {
                panorama.resize();
                return;
            }
            const visible = videoUrl ? video : image;
            const [naturalW, naturalH] = dimensions(visible);
            if (!naturalW || !naturalH) return;
            const width = (visible.clientWidth || naturalW) + 'px';
            const height = (visible.clientHeight || naturalH) + 'px';
            frame.style.width = comparison.style.width = width;
            frame.style.height = comparison.style.height = height;
        }

        const gif = typeof root.createSmartGifPreview === 'function' ? root.createSmartGifPreview(syncFrame) : null;

        function isGif(item) {
            const url = host.original(item);
            const format = item.mime || item.mime_type || item.type || item.format || '';
            return /^data:image\/gif[;,]/i.test(url) || /\.gif(?:[?#]|$)/i.test(url)
                || /\.gif$/i.test(item.name || '') || /^(?:image\/)?gif(?:;|$)/i.test(format);
        }

        function loaded(element, original) {
            if (!session || !host.visible()) return;
            const [width, height] = dimensions(element);
            if (original && width && height) host.recordSize(session.nodeId, session.index, width, height);
            syncFrame();
            paintMeta();
            const item = host.current().image;
            if (element === image && original && item && !panorama.enabled() && isGif(item)) {
                void gif?.load(image.getAttribute('src'));
            }
        }

        function discardLoad() {
            gif?.reset();
            if (request) {
                root.clearTimeout(request.deadline);
                for (const probe of request.probes) {
                    probe.onload = probe.onerror = null;
                    probe.removeAttribute('src');
                }
                request = null;
            }
            image.onload = image.onerror = null;
            image.removeAttribute('src');
            image.style.visibility = 'hidden';
            delete image.dataset.previewQuick;
            showLoading('idle');
        }

        function loadImage(item) {
            const primary = host.display(item);
            if (request?.primary === primary) {
                if (image.complete && image.naturalWidth) loaded(image, request.quality > 1);
                return;
            }
            discardLoad();
            const thumbnail = host.thumbnailUrl(item);
            const original = host.original(item);
            const sourceUrls = [...new Set([primary, original].filter(Boolean))];
            const showThumbnail = thumbnail && !sourceUrls.includes(thumbnail);
            const job = { primary, probes: new Set(), quality: 0, pending: showThumbnail ? 2 : 1, deadline: 0 };
            request = job;
            showLoading('loading');
            const current = () => request === job && host.open()
                && host.display(host.current().image || '') === primary;
            job.deadline = root.setTimeout(() => {
                if (current() && !job.quality) showLoading('error');
            }, loadDeadline);

            function finish() {
                job.pending -= 1;
                if (!job.pending) {
                    root.clearTimeout(job.deadline);
                    if (!job.quality) showLoading('error');
                }
            }

            function probe(urls, quality) {
                if (!urls.length) {
                    finish();
                    return;
                }
                const [url, ...alternatives] = urls;
                const candidate = new root.Image();
                job.probes.add(candidate);
                function settle() {
                    candidate.onload = candidate.onerror = null;
                    job.probes.delete(candidate);
                    return current();
                }
                candidate.onload = () => {
                    if (!settle()) return;
                    if (job.quality < quality) {
                        job.quality = quality;
                        root.clearTimeout(job.deadline);
                        image.dataset.previewQuick = quality === 1 ? '1' : '';
                        image.onload = () => {
                            if (current() && job.quality === quality && image.getAttribute('src') === url) loaded(image, quality > 1);
                        };
                        image.src = url;
                        image.style.visibility = '';
                        showLoading('idle');
                    }
                    finish();
                };
                candidate.onerror = () => {
                    if (settle()) probe(alternatives, quality);
                };
                candidate.src = url;
            }

            if (showThumbnail) probe([thumbnail], 1);
            probe(sourceUrls, 2);
        }

        function clearVideo() {
            if (videoUrl) {
                videoCapture?.abort();
                videoUrl = '';
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
            video.style.display = 'none';
        }

        function showVideo(item) {
            const src = host.display(item);
            video.style.display = 'block';
            if (videoUrl !== src) {
                videoCapture?.abort();
                videoUrl = src;
                video.src = src;
                video.load();
            } else if (video.readyState >= 1) {
                loaded(video, true);
            }
        }

        for (const event of ['loadedmetadata', 'loadeddata']) {
            video.addEventListener(event, () => {
                if (videoUrl && host.display(host.current().image || '') === videoUrl) loaded(video, true);
            });
        }

        function frameInterval() {
            const { image: item } = host.current();
            const fps = Number(item?.fps || item?.frameRate || item?.frame_rate || item?.framespersecond || item?.frames_per_second);
            return 1 / (Number.isFinite(fps) && fps > 0 ? Math.min(120, Math.max(1, fps)) : 30);
        }

        function stepVideo(direction) {
            if (!host.visible() || !videoUrl || video.readyState < 1) return false;
            if (videoCapture && !videoCapture.signal.aborted) return true;
            video.pause();
            const interval = frameInterval();
            const lastFrame = Number.isFinite(video.duration) && video.duration > 0
                ? Math.max(0, video.duration - interval / 2)
                : Number.MAX_SAFE_INTEGER;
            video.currentTime = Math.min(lastFrame, Math.max(0, video.currentTime + direction * interval));
            return true;
        }

        function waitForFrame(ready, signal) {
            const available = () => !signal.aborted && !video.error && ready();
            if (signal.aborted || video.error || ready()) return Promise.resolve(available());
            return new Promise(resolve => {
                const events = ['loadeddata', 'canplay', 'seeked'];
                const check = () => { if (ready()) finish(); };
                const finish = () => {
                    root.clearTimeout(timeout);
                    for (const event of events) video.removeEventListener(event, check);
                    video.removeEventListener('error', finish);
                    signal.removeEventListener('abort', finish);
                    resolve(available());
                };
                const timeout = root.setTimeout(finish, 2200);
                for (const event of events) video.addEventListener(event, check);
                video.addEventListener('error', finish);
                signal.addEventListener('abort', finish);
            });
        }

        async function captureVideoFrame(which) {
            if (!host.visible() || !videoUrl) throw new Error('没有可导出的视频帧');
            if (videoCapture && !videoCapture.signal.aborted) return null;
            const capture = new AbortController();
            videoCapture = capture;
            const { signal } = capture;
            const time = video.currentTime;
            const interval = frameInterval();
            const surface = doc.createElement('canvas');
            const decoded = () => video.readyState >= 2;
            let moved = false;
            try {
                video.pause();
                const ready = await waitForFrame(decoded, signal);
                if (signal.aborted) return null;
                if (!ready) throw new Error('视频还没有加载完成');
                let target = time;
                if (which === 'first') target = 0;
                if (which === 'last') {
                    const duration = Number.isFinite(video.duration) ? video.duration : 0;
                    target = Math.max(0, duration - interval / 2);
                }
                moved = Math.abs(video.currentTime - target) > 0.002;
                if (moved) video.currentTime = target;
                const seeked = await waitForFrame(() => !video.seeking && decoded(), signal);
                if (signal.aborted) return null;
                if (!seeked) throw new Error('导出帧失败');
                surface.width = video.videoWidth;
                surface.height = video.videoHeight;
                surface.getContext('2d').drawImage(video, 0, 0);
            } finally {
                if (videoCapture === capture) videoCapture = null;
                if (moved && which !== 'current' && !signal.aborted) video.currentTime = time;
            }
            const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
            if (!blob) throw new Error('导出帧失败');
            return { blob, width: surface.width, height: surface.height };
        }

        function comparisonImage(show, ref) {
            stage.classList.toggle('compare-on', show);
            overlay.style.display = handle.style.display = show ? '' : 'none';
            if (!show) {
                comparison.onload = null;
                comparison.removeAttribute('src');
                comparison.style.visibility = 'hidden';
                comparisonUrl = '';
                return;
            }
            if (comparisonUrl !== ref.url) {
                comparisonUrl = ref.url;
                comparison.onload = syncFrame;
                comparison.src = ref.url;
            }
            comparison.style.visibility = '';
            syncFrame();
        }

        function updateThumbnails(sources) {
            thumbnails.replaceChildren();
            thumbnails.style.display = comparing ? 'inline-flex' : 'none';
            if (!comparing) return;
            for (const [index, item] of sources.entries()) {
                const element = doc.createElement(comparisonNodeId ? 'div' : 'button');
                element.className = 'compare-thumb';
                if (comparisonNodeId) {
                    const text = host.sideLabel(index + 1);
                    element.classList.add('compare-node-thumb');
                    element.title = text + '：' + host.name(item);
                    const badge = doc.createElement('span');
                    badge.className = 'compare-node-thumb-label';
                    badge.textContent = text;
                    element.innerHTML = host.thumbnail(item);
                    element.append(badge);
                } else {
                    const selected = index === referenceIndex;
                    element.type = 'button';
                    element.dataset.compareIdx = index;
                    element.classList.toggle('active', selected);
                    element.title = host.label(selected ? 'smart.compareCancelTip' : 'smart.compareUseTip');
                    element.setAttribute('aria-label', element.title);
                    element.setAttribute('aria-pressed', String(selected));
                    element.innerHTML = host.thumbnail(item);
                }
                thumbnails.append(element);
            }
            host.bindThumbnails(thumbnails);
        }

        function render() {
            const { node, image: item } = host.current();
            if (!host.visible() || !item?.url || !session) return;
            const isVideo = host.kind(item) === 'video';
            const orbiting = panorama.enabled();
            const toolbar = !isVideo && !comparisonNodeId;
            const sources = !isVideo && !orbiting ? host.sources(node, comparisonNodeId) : [];
            if (orbiting) {
                comparing = false;
            } else if (!sources.length) {
                comparing = false;
                referenceIndex = -1;
            }
            panoramaButton.style.display = toolbar ? 'inline-flex' : 'none';
            compareButton.style.display = toolbar && !orbiting ? 'inline-flex' : 'none';
            compareButton.disabled = !sources.length;
            compareButton.style.opacity = sources.length ? '1' : '.45';
            compareButton.title = host.label(sources.length ? 'smart.compareHover' : 'smart.compareEmpty');
            compareButton.classList.toggle('active', comparing);
            const reference = comparing && sources[referenceIndex];
            if (reference && comparisonNodeId) {
                get('previewCompareLeftLabel').textContent = host.sideLabel(referenceIndex + 1);
                get('previewCompareRightLabel').textContent = host.sideLabel(2);
            }
            comparisonImage(Boolean(reference), reference);
            updateThumbnails(sources);
            hint = orbiting ? host.label('smart.panoramaHint')
                : comparisonNodeId ? host.compareHint()
                : node?.runPrompt ? host.label('smart.runPromptPrefix') + node.runPrompt.slice(0, 60) : '';
            if (comparing && !reference) hint = [hint, host.label('smart.compareHintPick')].filter(Boolean).join(' · ');

            if (isVideo || orbiting) gif?.setVisible(false);
            image.style.display = isVideo || orbiting ? 'none' : 'block';
            if (isVideo) {
                discardLoad();
                showVideo(item);
            } else {
                clearVideo();
                if (orbiting) showLoading('idle');
                else loadImage(item);
            }
            paintMeta();
        }

        function toggleCompare() {
            if (!host.visible() || panorama.enabled()) return;
            const { node } = host.current();
            const sources = host.sources(node, comparisonNodeId);
            if (!sources.length) {
                host.error(host.label('smart.compareNoSource'));
                return;
            }
            comparing = !comparing;
            if (!comparing) referenceIndex = -1;
            else if (!sources[referenceIndex]) referenceIndex = 0;
            render();
        }

        thumbnails.addEventListener('click', event => {
            const button = event.target.closest('[data-compare-idx]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const index = Number(button.dataset.compareIdx);
            referenceIndex = index === referenceIndex ? -1 : index;
            render();
        });

        retryButton.addEventListener('click', () => {
            if (!host.visible()) return;
            discardLoad();
            render();
        });

        function applyPose() {
            const { x, y, scale } = pose;
            frame.style.transform = panorama.enabled() ? '' : 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
            host.zoomChanged();
        }

        function wheel(event) {
            if (panorama.enabled()) {
                panorama.zoom(event.deltaY);
                return;
            }
            const bounds = frame.getBoundingClientRect();
            const origin = {
                left: bounds.left + bounds.width / 2 - pose.x,
                top: bounds.top + bounds.height / 2 - pose.y
            };
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            root.XiaomeiViewportKernel.zoomAboutClient(pose, origin, event.clientX, event.clientY, Math.max(0.05, pose.scale * factor));
            applyPose();
        }

        function divider(clientX) {
            const bounds = frame.getBoundingClientRect();
            const fraction = (clientX - bounds.left) / Math.max(1, bounds.width);
            stage.style.setProperty('--compare-pos', Math.max(0, Math.min(1, fraction)) * 100 + '%');
        }

        function start(event, kind) {
            if (!host.visible() || event.button !== 0 || gesture) return;
            event.preventDefault();
            event.stopPropagation();
            gesture = {
                kind,
                id: event.pointerId,
                element: event.currentTarget,
                x: event.clientX,
                y: event.clientY,
                pose: { ...pose },
                orbit: panorama.position()
            };
            gesture.element.setPointerCapture?.(gesture.id);
            if (kind === 'compare') divider(event.clientX);
            else stage.classList.add('panning');
        }

        function finish(id = gesture?.id) {
            if (!gesture || gesture.id !== id) return;
            const { element } = gesture;
            gesture = null;
            stage.classList.remove('panning');
            if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
        }

        stage.addEventListener('pointerdown', event => {
            if (event.target.closest('video, .preview-compare-handle, .preview-tools-overlay, .preview-download-overlay')) return;
            start(event, panorama.enabled() ? 'orbit' : 'pan');
        });
        handle.addEventListener('pointerdown', event => {
            if (stage.classList.contains('compare-on')) start(event, 'compare');
        });
        for (const surface of [stage, handle]) {
            surface.addEventListener('pointermove', event => {
                if (gesture?.id !== event.pointerId || gesture.element !== surface) return;
                event.preventDefault();
                event.stopPropagation();
                const dx = event.clientX - gesture.x;
                const dy = event.clientY - gesture.y;
                if (gesture.kind === 'compare') divider(event.clientX);
                else if (gesture.kind === 'orbit') panorama.orbit(gesture.orbit, dx, dy);
                else {
                    pose.x = gesture.pose.x + dx;
                    pose.y = gesture.pose.y + dy;
                    applyPose();
                }
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                surface.addEventListener(type, event => finish(event.pointerId));
            }
        }

        function resetPose(resetDivider = true) {
            finish();
            pose = initialPose();
            if (resetDivider) stage.style.setProperty('--compare-pos', '50%');
            applyPose();
        }

        function updateNavigation() {
            const show = host.visible() && !comparisonNodeId && entries().length > 1;
            for (const id of ['previewPrevBtn', 'previewNextBtn']) get(id).classList.toggle('visible', show);
        }

        function entries() {
            if (!session) return [];
            const possible = session.sequence || (host.node(session.nodeId)?.images || [])
                .map((item, index) => ({ nodeId: session.nodeId, index }));
            return possible.filter(({ nodeId, index }) => isMedia(host.node(nodeId)?.images?.[index]));
        }

        function stop() {
            finish();
            panorama.leave();
            discardLoad();
            clearVideo();
            comparisonImage(false);
            thumbnails.replaceChildren();
            thumbnails.style.display = 'none';
            frame.style.width = frame.style.height = '';
            session = null;
            comparing = false;
            comparisonNodeId = '';
            referenceIndex = -1;
            hint = '';
            resetPose();
        }

        function begin(nodeId, index) {
            stop();
            session = { nodeId, index };
        }

        function openSequence(sequence, position, groupId = '') {
            const target = sequence[position];
            if (!target) return;
            const previous = session;
            host.openEditor(target.nodeId, target.index);
            if (!session || session === previous || session.nodeId !== target.nodeId || session.index !== target.index) return;
            session.sequence = sequence;
            session.groupId = groupId;
            host.showPreview();
        }

        function navigate(delta) {
            if (!host.visible() || comparisonNodeId || !session) return;
            const list = entries();
            if (list.length <= 1) return;
            const index = list.findIndex(entry => entry.nodeId === session.nodeId && entry.index === session.index);
            const origin = index < 0 && delta < 0 ? 0 : index;
            const next = wrap(origin + delta, list.length);
            if (session.sequence) openSequence(list, next, session.groupId);
            else host.openEditor(list[next].nodeId, list[next].index);
        }

        function compareNode(id, target) {
            const previous = session;
            host.openEditor(target.nodeId, target.index);
            if (!session || session === previous || session.nodeId !== target.nodeId || session.index !== target.index) return false;
            comparisonNodeId = id;
            comparing = true;
            referenceIndex = 0;
            host.showPreview();
            return true;
        }

        function suspend() {
            finish();
            panorama.leave();
            clearVideo();
            gif?.setVisible(false);
            compareButton.style.display = panoramaButton.style.display = thumbnails.style.display = 'none';
        }

        function togglePanorama() {
            const { image: item } = host.current();
            if (!host.visible() || comparisonNodeId || host.kind(item || {}) !== 'image') return;
            if (panorama.enabled()) panorama.leave();
            else panorama.enter(item);
            resetPose(false);
            render();
        }

        function resetView() {
            if (panorama.enabled()) panorama.reset();
            else resetPose();
        }

        let logPanel;
        let logImage;

        function closeLog() {
            if (!logPanel?.classList.contains('open')) return;
            logPanel.classList.remove('open');
            logImage.onerror = null;
            logImage.removeAttribute('src');
        }

        function openLog(url, kind) {
            if (!url) return;
            const item = { url };
            if (kind === 'video' || host.isVideoUrl(url)) {
                root.open(host.display(item), '_blank', 'noopener');
                return;
            }
            if (!logPanel) {
                logPanel = doc.createElement('div');
                logPanel.id = 'smartLogLightbox';
                logPanel.className = 'smart-log-lightbox';
                logImage = doc.createElement('img');
                logImage.alt = 'preview';
                logImage.draggable = false;
                const dismiss = doc.createElement('button');
                dismiss.type = 'button';
                dismiss.className = 'smart-log-lightbox-close';
                dismiss.setAttribute('aria-label', host.label('common.close') || '关闭');
                const icon = doc.createElement('i');
                icon.dataset.lucide = 'x';
                dismiss.append(icon);
                logPanel.append(logImage, dismiss);
                dismiss.addEventListener('click', closeLog);
                logPanel.addEventListener('click', event => {
                    if (event.target === logPanel) closeLog();
                });
                doc.body.append(logPanel);
            }
            const primary = host.display(item);
            const fallback = host.largeThumbnailUrl(item);
            logImage.onerror = () => {
                logImage.onerror = null;
                if (fallback && fallback !== primary && logImage.getAttribute('src') === primary) logImage.src = fallback;
            };
            logImage.src = primary;
            logPanel.classList.add('open');
            host.icons();
        }

        return {
            begin, stop, suspend, render, paintMeta, updateNavigation, navigate, openSequence, compareNode,
            toggleCompare, togglePanorama, resetView, wheel, syncFrame, openLog, closeLog,
            location: () => session || { nodeId: '', index: 0 },
            zoom: () => panorama.enabled() ? panorama.scale() : pose.scale,
            comparingNode: () => Boolean(comparisonNodeId),
            stepVideo, captureVideoFrame
        };
    }

    root.XiaomeiSmartCanvasPreview = { create };
})(window);
