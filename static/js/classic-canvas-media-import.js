(function (root) {
    'use strict';

    const outputType = 'application/x-canvas-output-image';
    const assetType = 'application/x-canvas-asset';
    const inputType = 'application/x-canvas-input';
    const { types, read: data, resolve: resolveTransfer, hasMedia: hasTransferMedia } = root.XiaomeiCanvasDropData;
    const fileImage = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
    const fileAudio = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
    const fileVideo = /\.(mp4|webm|mov|m4v|avi|mkv)$/i;
    const maximum = 20;

    function fileKind(file) {
        if (!file) return '';
        const mime = file.type || '';
        if (/^video\//i.test(mime) || fileVideo.test(file.name)) return 'video';
        if (/^audio\//i.test(mime) || fileAudio.test(file.name)) return 'audio';
        return /^image\//i.test(mime) || fileImage.test(file.name) ? 'image' : '';
    }

    const hasMedia = transfer => hasTransferMedia(transfer, fileKind);

    async function resolve(transfer, limit = maximum) {
        const payload = await resolveTransfer(transfer, fileKind, limit);
        return payload.type === 'localPaths' ? { type: 'paths', paths: payload.localPaths } : payload;
    }

    function assetPayload(transfer) {
        try {
            const item = JSON.parse(data(transfer, assetType));
            return typeof item?.url === 'string' && item.url ? { ...item, kind: String(item.kind || '').toLowerCase() } : null;
        } catch (_) { return null; }
    }

    function create(host) {
        const latest = new WeakMap();
        const label = name => host.label('canvas.' + name);
        const inputDrag = transfer => host.internalDrag() || types(transfer).includes(inputType);
        const transferable = transfer => types(transfer).some(type => type === assetType || type === outputType);
        const mayDrop = transfer => !inputDrag(transfer) && (transferable(transfer) || hasMedia(transfer));

        function point(event) {
            return host.toWorld(event.clientX, event.clientY);
        }

        async function request(path, body, json = false) {
            const response = await root.fetch(path, {
                method: 'POST', body: json ? JSON.stringify(body) : body,
                ...(json ? { headers: { 'Content-Type': 'application/json' } } : {}),
            });
            if (!response.ok) throw new Error(await host.responseError(response, label('mediaImportFailed')));
            const result = await response.json();
            return (result.files || []).filter(file => file?.url);
        }

        async function upload(files, limit = maximum) {
            const accepted = Array.from(files || []).filter(fileKind).slice(0, limit);
            if (!accepted.length) return [];
            const form = new FormData();
            for (const file of accepted) form.append('files', file);
            const result = await request('/api/ai/upload', form);
            return result.map((file, index) => ({ ...file, kind: file.kind || fileKind(accepted[index]) || 'image' }));
        }

        async function material(payload) {
            if (payload.type === 'files') return upload(payload.files);
            if (payload.type === 'paths') return request('/api/ai/import-local-image', { paths: payload.paths }, true);
            if (payload.type === 'url') return [{ url: payload.url, name: payload.name, kind: payload.kind }];
            return [];
        }

        function record(file) {
            return { url: file.url, name: file.name || host.name(file.url), mediaKind: file.kind || host.kind(file.url) };
        }

        function append(files, at, group) {
            const cols = Math.min(3, Math.ceil(Math.sqrt(files.length)));
            const created = files.map((file, index) => ({
                id: host.id('img'), type: 'image', ...record(file),
                x: group ? at.x - (cols - 1) * 140 + index % cols * 280 : at.x + index * 36,
                y: group ? at.y + Math.floor(index / cols) * 250 : at.y + index * 36,
            }));
            host.nodes().push(...created);
            if (!group || created.length < 2) return null;
            return host.makeGroup(created);
        }

        async function onBoard(payload, at, canvasId) {
            const files = await material(payload);
            if (!files.length || host.canvasId() !== canvasId) return;
            host.undo();
            append(files, at, payload.type === 'files' && files.length > 1);
            host.changed(false);
        }

        function claim(node) {
            const token = { node, url: node.url, canvasId: host.canvasId() };
            latest.set(node, token);
            return token;
        }

        function current(token) {
            const { node, url, canvasId } = token;
            return host.canvasId() === canvasId && host.node(node.id) === node && node.url === url && latest.get(node) === token;
        }

        async function onNode(token, payload, group) {
            if (payload.type === 'none' || !current(token)) return;
            const pick = payload.type === 'files' && !group ? { ...payload, files: payload.files.slice(0, 1) } : payload;
            const files = await material(pick);
            if (!files.length || !current(token)) return;
            const { node } = token;
            host.undo();
            if (group && files.length > 1) {
                const wrapper = append(files, { x: Number(node.x) || 0, y: Number(node.y) || 0 }, true);
                host.replaceWithGroup(node.id, wrapper);
            } else {
                const replacement = record(files[0]);
                if (replacement.url !== node.url) {
                    delete node.natural_w;
                    delete node.natural_h;
                    delete node._naturalSizeLoading;
                    delete node.originalLocalUrl;
                }
                Object.assign(node, replacement);
            }
            host.changed(true);
        }

        function report(error) {
            host.error(error?.message || label('mediaImportFailed'), label('mediaImportFailed'));
        }

        function pick(id) {
            const input = root.document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,video/*,audio/*';
            input.multiple = true;
            input.onchange = () => {
                const node = host.node(id);
                if (node?.type !== 'image' || !input.files.length) return;
                onNode(claim(node), { type: 'files', files: Array.from(input.files) }, true).catch(report);
            };
            input.click();
        }

        function allowNode(event, card) {
            if (!mayDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            card?.classList.add('drag-over');
            host.overlay(false);
        }

        function fromOutput(transfer) {
            const url = data(transfer, outputType);
            return url && host.kind(url) === 'image' ? { type: 'url', url, kind: 'image' } : { type: 'none' };
        }

        function assetMedia(item) {
            return item && item.kind !== 'workflow' ? { ...item, type: 'url' } : { type: 'none' };
        }

        async function dropNode(event, id, card) {
            event.preventDefault();
            event.stopPropagation();
            card?.classList.remove('drag-over');
            host.overlay(false);
            const transfer = event.dataTransfer;
            const node = host.node(id);
            if (!host.canvasId() || node?.type !== 'image' || inputDrag(transfer)) return;
            const token = claim(node);
            try {
                const offered = types(transfer);
                const payload = offered.includes(outputType) ? fromOutput(transfer)
                    : offered.includes(assetType) ? assetMedia(assetPayload(transfer)) : await resolve(transfer);
                await onNode(token, payload, payload.type === 'files');
            } catch (error) { report(error); }
        }

        async function addAsset(item, at = host.defaultPoint()) {
            if (!host.canvasId() || !item?.url) return;
            try {
                if (item?.kind === 'workflow') await host.workflow(item.url, item.name || 'workflow', at);
                else await onBoard(assetMedia(item), at, host.canvasId());
            } catch (error) { report(error); }
        }

        host.board.addEventListener('dragover', event => {
            if (event.target.closest('.image-node') || !mayDrop(event.dataTransfer)) {
                host.overlay(false);
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            host.overlay(true);
        });
        host.board.addEventListener('dragleave', event => {
            if (!host.board.contains(event.relatedTarget)) host.overlay(false);
        });
        host.board.addEventListener('drop', async event => {
            event.preventDefault();
            host.overlay(false);
            const canvasId = host.canvasId();
            if (!canvasId || event.target.closest('.image-node')) return;
            const transfer = event.dataTransfer;
            if (inputDrag(transfer)) {
                host.clearInternalDrag();
                return;
            }
            const at = point(event);
            try {
                const offered = types(transfer);
                if (offered.includes(assetType)) await addAsset(assetPayload(transfer), at);
                else await onBoard(offered.includes(outputType) ? fromOutput(transfer) : await resolve(transfer), at, canvasId);
            } catch (error) { report(error); }
        });
        for (const event of ['dragend', 'drop']) root.addEventListener(event, () => host.overlay(false));
        root.addEventListener('paste', event => {
            const canvasId = host.canvasId();
            if (!canvasId) return;
            const files = Array.from(event.clipboardData?.items || [], item => item.kind === 'file' ? item.getAsFile() : null).filter(fileKind);
            if (!files.length) return;
            event.preventDefault();
            host.pasteAt();
            const blank = host.selected().find(node => node?.type === 'image' && !node.url);
            const payload = { type: 'files', files };
            (blank ? onNode(claim(blank), payload, false) : onBoard(payload, host.center(), canvasId)).catch(report);
        });

        return { addAsset, pick, allowNode, dropNode, upload };
    }

    root.XiaomeiClassicMediaImport = { create, resolve, hasMedia, outputType, assetType, data };
})(window);
