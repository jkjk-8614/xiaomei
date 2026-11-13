(function (root) {
    'use strict';

    const textTypes = [
        'text/uri-list', 'text/plain', 'text/html', 'DownloadURL', 'text/x-moz-url',
        'text/x-file-url', 'public.file-url', 'public.url', 'UniformResourceLocator', 'FileName', 'FileNameW',
    ];
    const typeHints = /^(?:files?|image\/|application\/x-(?:qt-|moz-file)|com\.eagle)/i;
    const imageExtension = /\.(?:png|jpe?g|webp|gif)$/i;
    const assetType = 'application/x-smart-asset';
    const historyType = 'application/x-smart-history-image';
    const inputType = 'application/x-smart-input-thumb';
    const remote = /^(?:https?:\/\/.+|data:image\/|blob:)/i;
    const windowsPath = /^[a-z]:[\\/]/i;
    const managedPath = /^\/(?:assets|output|api\/storage-files)\//i;
    const absent = () => ({ type: 'none' });

    function types(transfer) {
        return Array.from(transfer?.types || [], type => String(type).toLowerCase());
    }

    function read(transfer, type) {
        try { return transfer?.getData?.(type) || ''; }
        catch (_) { return ''; }
    }

    function entry(item) {
        try { return item.webkitGetAsEntry?.() || null; }
        catch (_) { return null; }
    }

    function file(item) {
        try { return item.getAsFile?.() || null; }
        catch (_) { return null; }
    }

    async function appendEntry(item, accepted, accept, limit) {
        if (accepted.length >= limit) return;
        if (item.isFile) {
            const child = await new Promise(resolve => item.file(resolve, () => resolve(null)));
            if (child && accept(child)) accepted.push(child);
            return;
        }
        if (!item.isDirectory) return;
        const reader = item.createReader();
        while (accepted.length < limit) {
            const children = await new Promise(resolve => reader.readEntries(resolve, () => resolve([])));
            if (!children.length) return;
            for (const child of children) {
                if (accepted.length >= limit) return;
                await appendEntry(child, accepted, accept, limit);
            }
        }
    }

    async function collectFiles(transfer, accept, limit) {
        const direct = Array.from(transfer?.files || []).filter(accept);
        const items = Array.from(transfer?.items || []).filter(item => item.kind === 'file')
            .map(item => ({ entry: entry(item), file: file(item) }));
        if (direct.length && !items.some(item => item.entry?.isDirectory)) return direct.slice(0, limit);
        const accepted = [];
        for (const item of items) {
            if (accepted.length >= limit) break;
            if (item.entry?.isDirectory) await appendEntry(item.entry, accepted, accept, limit);
            else if (item.file && accept(item.file)) accepted.push(item.file);
            else if (item.entry) await appendEntry(item.entry, accepted, accept, limit);
        }
        return accepted.length ? accepted : direct.slice(0, limit);
    }

    function fragments(text) {
        const values = [];
        if (/<(?:a|img)\b/i.test(text)) {
            const fragment = root.document.createElement('template');
            fragment.innerHTML = text;
            for (const element of fragment.content.querySelectorAll('img[src], a[href]')) {
                values.push(element.getAttribute('src') || element.getAttribute('href'));
            }
        }
        for (const line of text.split(/\r?\n/)) {
            const download = line.match(/^image\/[^:\s]+:(?:[^:]+:)?((?:https?|file|blob):.+)$/i);
            if (download) values.push(download[1]);
            values.push(line);
        }
        return values;
    }

    function textCandidates(transfer) {
        const offered = new Set([...textTypes, ...Array.from(transfer?.types || [])]);
        const values = new Set();
        for (const type of offered) {
            const raw = read(transfer, type);
            if (!raw) continue;
            for (const value of fragments(raw)) {
                const text = String(value || '').trim();
                const quoted = (text[0] === '"' || text[0] === "'") && text.length > 1 && text.at(-1) === text[0];
                const candidate = quoted ? text.slice(1, -1) : text;
                if (candidate && !candidate.startsWith('#')) values.add(candidate);
            }
        }
        return [...values];
    }

    function localPath(text) {
        let path = text;
        if (/^file:/i.test(path)) {
            try {
                const uri = new URL(path);
                if (uri.hostname && uri.hostname !== 'localhost') return '';
                path = decodeURIComponent(uri.pathname);
            } catch (_) { return ''; }
        }
        if (path[0] === '/' && windowsPath.test(path.slice(1))) path = path.slice(1);
        return (windowsPath.test(path) || path.startsWith('/')) && imageExtension.test(path) ? path : '';
    }

    function remoteUrl(text) {
        if (remote.test(text)) return text;
        if (!/^(?:https?|blob|data)%3a/i.test(text)) return '';
        try {
            const decoded = decodeURIComponent(text);
            return remote.test(decoded) ? decoded : '';
        } catch (_) { return ''; }
    }

    function hasMedia(transfer, accept) {
        return types(transfer).some(type => typeHints.test(type) || textTypes.some(name => name.toLowerCase() === type))
            || Array.from(transfer?.files || []).some(accept)
            || Array.from(transfer?.items || []).some(item => item.kind === 'file' &&
                (entry(item)?.isDirectory || accept(file(item))));
    }

    async function resolve(transfer, accept, limit = Infinity) {
        const candidates = textCandidates(transfer);
        const files = await collectFiles(transfer, accept, limit);
        if (files.length) return { type: 'files', files };
        const paths = [...new Set(candidates.map(localPath).filter(Boolean))].slice(0, limit);
        if (paths.length) return { type: 'localPaths', localPaths: paths };
        const url = candidates.map(remoteUrl).find(Boolean);
        return url ? { type: 'url', url } : absent();
    }

    function readRecord(transfer, type) {
        try { return JSON.parse(read(transfer, type)); }
        catch (_) { return null; }
    }

    async function resolveSmart(transfer, { accept, originalUrl, assetReference }) {
        if (types(transfer).includes(inputType)) return absent();
        const asset = readRecord(transfer, assetType);
        if (typeof asset?.url === 'string' && asset.url && asset.kind !== 'workflow') {
            const image = assetReference(asset);
            if (image.kind !== 'workflow') return { type: 'asset', image };
        }
        const history = readRecord(transfer, historyType);
        if (history?.source === 'history' && history.kind === 'image') {
            const url = originalUrl(history.url);
            if (/^https?:\/\//i.test(url) || managedPath.test(url)) {
                const width = Number(history.natural_w);
                const height = Number(history.natural_h);
                const hasSize = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
                return hasSize ? { type: 'url', url, natural_w: width, natural_h: height } : { type: 'url', url };
            }
        }
        return resolve(transfer, accept);
    }

    function hasSmartMedia(transfer, accept) {
        const offered = types(transfer);
        return !offered.includes(inputType) &&
            (offered.includes(assetType) || offered.includes(historyType) || hasMedia(transfer, accept));
    }

    root.XiaomeiCanvasDropData = { types, read, resolve, hasMedia, resolveSmart, hasSmartMedia, inputType };
}(window));
