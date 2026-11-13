(function (root) {
    'use strict';

    const base = () => ({ zoom: 1, panX: 0, panY: 0 });
    const ignore = '.output-preview-actions, .output-resolution, button, a, video';

    function create(host) {
        const get = id => root.document.getElementById(id);
        const modal = get('outputLightbox');
        const stage = get('outputPreview');
        const image = get('outputLightboxImg');
        const video = get('outputLightboxVideo');
        const compare = get('outputCompareContainer');
        const original = get('outputCompareOriginal');
        const originalClip = get('outputCompareOriginalWrap');
        const result = get('outputCompareResult');
        const divider = get('outputCompareSlider');
        const resolution = get('outputResolution');
        const panel = get('outputPromptPanel');
        const prompt = get('outputPromptText');
        const copy = get('outputCopyPromptBtn');
        const copyCaption = copy.querySelector('span');
        const rerun = get('outputRerunBtn');
        const download = get('outputDownloadBtn');
        const downloadAll = get('outputDownloadAllBtn');
        const pictures = [image, original, result];
        let item;
        let pose = base();
        let split = 50;
        let gesture;
        let copiedTimer;

        stage.dataset.nativeTouch = '';
        pictures.forEach(element => { element.draggable = false; });
        divider.setAttribute('role', 'slider');
        divider.setAttribute('aria-orientation', 'horizontal');
        divider.setAttribute('aria-valuemin', '0');
        divider.setAttribute('aria-valuemax', '100');
        divider.tabIndex = 0;
        const label = key => host.label('canvas.' + key);

        function renderPose() {
            const { panX, panY, zoom } = pose;
            const transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
            for (const picture of pictures) picture.style.transform = transform;
            stage.classList.toggle('zoomed', zoom > 1.001);
        }

        function renderSplit(value) {
            split = Math.max(0, Math.min(100, value));
            originalClip.style.clipPath = 'inset(0 ' + (100 - split) + '% 0 0)';
            divider.style.left = split + '%';
            divider.setAttribute('aria-valuenow', String(Math.round(split)));
        }

        function splitAt(x) {
            const box = compare.getBoundingClientRect();
            if (box.width) renderSplit(100 * (x - box.left) / box.width);
        }

        function stopGesture() {
            const old = gesture;
            gesture = null;
            if (old && stage.hasPointerCapture(old.id)) stage.releasePointerCapture(old.id);
            stage.classList.remove('panning');
        }

        function resetPose() {
            stopGesture();
            pose = base();
            renderPose();
            stage.classList.remove('compare-mode');
            renderSplit(50);
        }

        function consume(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        stage.addEventListener('wheel', event => {
            if (!item || item.video) return;
            consume(event);
            const box = stage.getBoundingClientRect();
            pose = root.XiaomeiShellKernel.previewWheel(pose, {
                x: event.clientX - box.left, y: event.clientY - box.top,
            }, event.deltaY, { min: 1, max: 6 });
            renderPose();
        }, { passive: false });

        stage.addEventListener('pointerdown', event => {
            if (!item || item.video || gesture || event.button !== 0 || event.target.closest(ignore)) return;
            if (stage.classList.contains('compare-mode') && compare.contains(event.target)) {
                gesture = { id: event.pointerId, type: 'compare' };
                if (!divider.contains(event.target)) splitAt(event.clientX);
            } else if (pose.zoom > 1.001) {
                gesture = { id: event.pointerId, type: 'pan', x: event.clientX, y: event.clientY, panX: pose.panX, panY: pose.panY };
                stage.classList.add('panning');
            } else return;
            consume(event);
            stage.setPointerCapture(event.pointerId);
        });
        stage.addEventListener('pointermove', event => {
            if (gesture?.id !== event.pointerId) return;
            consume(event);
            if (gesture.type === 'compare') splitAt(event.clientX);
            else {
                pose.panX = gesture.panX + event.clientX - gesture.x;
                pose.panY = gesture.panY + event.clientY - gesture.y;
                renderPose();
            }
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, event => {
            if (gesture?.id === event.pointerId) stopGesture();
        });
        stage.addEventListener('dblclick', event => {
            if (!item?.comparison || item.video || event.target.closest(ignore) || divider.contains(event.target)) return;
            consume(event);
            stopGesture();
            if (stage.classList.toggle('compare-mode')) renderSplit(50);
        });
        divider.addEventListener('keydown', event => {
            const next = { ArrowLeft: split - 5, ArrowRight: split + 5, Home: 0, End: 100 };
            if (!Object.hasOwn(next, event.key)) return;
            consume(event);
            renderSplit(next[event.key]);
        });

        function dimensions(width, height, record) {
            if (item !== record) return;
            resolution.replaceChildren(width && height ? width + ' x ' + height : record?.video ? label('outputVideo') : '--');
            if (record?.meta?.runMs) {
                const divider = root.document.createElement('span');
                divider.style.opacity = '.38';
                divider.textContent = '|';
                const time = root.document.createElement('span');
                time.textContent = host.duration(record.meta.runMs);
                resolution.append(divider, time);
            }
        }

        function clearCopy() {
            root.clearTimeout(copiedTimer);
            copy.classList.remove('copied');
            copyCaption.textContent = label('copyPrompt');
        }

        modal.addEventListener('click', event => {
            if (event.target === modal) close();
        });
        modal.querySelector('[data-output-preview-close]')?.addEventListener('click', close);

        copy.addEventListener('click', async event => {
            event.stopPropagation();
            const record = item;
            const value = record?.meta?.run?.prompt;
            if (!value || !await host.copy(value) || record !== item) return;
            clearCopy();
            copy.classList.add('copied');
            copyCaption.textContent = label('copied');
            copiedTimer = root.setTimeout(clearCopy, 1200);
        });
        rerun.addEventListener('click', event => {
            event.stopPropagation();
            if (item?.meta?.run) host.rerun(item.meta);
        });
        download.addEventListener('click', async event => {
            event.stopPropagation();
            if (!item) return;
            try { await host.download(item.url); } catch (error) { host.error(error); }
        });
        downloadAll.addEventListener('click', async event => {
            event.stopPropagation();
            if (!item?.sourceId) return;
            try { await host.downloadGroup(item.sourceId); } catch (error) { host.error(error); }
        });

        function unload() {
            image.onload = null;
            video.onloadedmetadata = null;
            pictures.forEach(picture => picture.removeAttribute('src'));
            if (video.hasAttribute('src')) {
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
        }

        function open(url, source) {
            if (!url) return;
            const meta = host.metadata(url, source);
            const record = {
                url, meta, sourceId: source?.id || '',
                comparison: host.comparison(url, source),
                video: host.isVideo(meta && Object.keys(meta).length ? { ...meta, url } : url),
            };
            item = record;
            host.viewed(source, url);
            unload();
            resetPose();
            clearCopy();
            divider.setAttribute('aria-label', label('outputCompareDivider'));
            dimensions(0, 0, record);
            stage.classList.toggle('video-mode', record.video);
            panel.classList.toggle('open', Boolean(meta?.run));
            prompt.textContent = meta?.run?.prompt || label('noPromptMeta');
            downloadAll.style.display = host.groupSize(source) > 1 ? 'flex' : 'none';
            image.style.display = record.video ? 'none' : 'block';
            video.style.display = record.video ? 'block' : 'none';
            const src = host.mediaUrl(url);
            if (record.video) {
                video.onloadedmetadata = () => dimensions(video.videoWidth, video.videoHeight, record);
                video.src = src;
            } else {
                image.onload = () => dimensions(image.naturalWidth, image.naturalHeight, record);
                image.src = src;
                if (record.comparison) {
                    original.src = host.mediaUrl(record.comparison);
                    result.src = src;
                }
            }
            modal.classList.add('open');
            host.icons();
        }

        function close() {
            modal.classList.remove('open');
            item = null;
            unload();
            resetPose();
            clearCopy();
            video.style.display = 'none';
            image.style.display = 'block';
            stage.classList.remove('video-mode');
            panel.classList.remove('open');
            prompt.textContent = '';
            downloadAll.style.display = 'none';
        }

        function navigate(delta) {
            if (!item || !modal.classList.contains('open')) return false;
            const source = item.sourceId ? host.node(item.sourceId) : null;
            const choices = host.items(source);
            if (choices.length < 2) return false;
            const index = Math.max(0, choices.findIndex(entry => entry.url === item.url));
            const next = choices[(index + delta + choices.length) % choices.length];
            open(next.url, next.outId ? host.node(next.outId) : null);
            return true;
        }

        return { open, close, navigate, isOpen: () => modal.classList.contains('open') };
    }

    root.XiaomeiClassicOutputPreview = { create };
})(window);
