(function (global) {
    'use strict';

    function copyTextWithCopyEvent(value, documentRef = global.document) {
        if (!documentRef) return false;
        let handled = false;
        const onCopy = event => {
            if (!event.clipboardData) return;
            event.preventDefault();
            event.clipboardData.setData('text/plain', String(value ?? ''));
            handled = true;
        };
        documentRef.addEventListener('copy', onCopy);
        try {
            return documentRef.execCommand('copy') && handled;
        } catch (_) {
            return false;
        } finally {
            documentRef.removeEventListener('copy', onCopy);
        }
    }

    function copyViaSelection(value) {
        const document = global.document;
        if (!document?.body) return false;
        const active = document.activeElement;
        const offsets = Number.isInteger(active?.selectionStart)
            ? [active.selectionStart, active.selectionEnd, active.selectionDirection || 'none'] : null;
        const selection = document.getSelection();
        const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, index) => selection.getRangeAt(index).cloneRange());
        const field = document.createElement('textarea');
        field.value = value;
        field.readOnly = true;
        field.tabIndex = -1;
        Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0' });
        document.body.append(field);
        try {
            field.focus({ preventScroll: true });
            field.select();
            return document.execCommand('copy');
        } catch (_) {
            return false;
        } finally {
            field.remove();
            active?.focus({ preventScroll: true });
            if (offsets) active.setSelectionRange(...offsets);
            else if (selection && ranges.length) {
                selection.removeAllRanges();
                for (const range of ranges) selection.addRange(range);
            }
        }
    }

    async function copiedTextMatches(value) {
        if (!global.isSecureContext) return undefined;
        try {
            const clipboard = global.navigator.clipboard;
            if (clipboard?.readText) return (await clipboard.readText()) === value;
        } catch (_) {}
        return undefined;
    }

    async function copyText(value) {
        const text = String(value || '');
        if (!text) return false;
        const copied = copyTextWithCopyEvent(text) || copyViaSelection(text);
        if (copied && await copiedTextMatches(text) !== false) return true;
        if (global.isSecureContext === false) return false;
        try {
            const clipboard = global.navigator.clipboard;
            if (!clipboard?.writeText) return false;
            await clipboard.writeText(text);
            return await copiedTextMatches(text) !== false;
        } catch (_) {
            return false;
        }
    }

    function boundedTextSize(value) {
        const size = Number(value);
        const base = Number.isFinite(size) ? size : 28;
        return Math.max(10, Math.min(120, base));
    }

    function textItemFont(item) {
        return `900 ${boundedTextSize(item?.size)}px Arial, sans-serif`;
    }

    function readTextMetrics(item, ctx) {
        const size = boundedTextSize(item?.size);
        ctx.save();
        ctx.font = textItemFont(item);
        const metrics = ctx.measureText(String(item?.text || ''));
        ctx.restore();
        const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : size * 0.8;
        const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : size * 0.25;
        return {
            width: Math.max(1, metrics.width || 1),
            textH: ascent + descent,
            inset: Math.max(4, Math.round(size * 0.18)),
        };
    }

    function measureEditTextItem(item, ctx) {
        if (!item || !ctx) return {x:0, y:0, w:0, h:0};
        const metrics = readTextMetrics(item, ctx);
        const w = metrics.width + metrics.inset * 2;
        const h = metrics.textH + metrics.inset * 2;
        return {
            x:item.x - w / 2,
            y:item.y - h / 2,
            w,
            h,
            textW:metrics.width,
            textH:metrics.textH,
            pad:metrics.inset,
        };
    }

    function hitEditTextItem(point, items, ctx) {
        if (!point || !ctx) return null;
        const list = Array.isArray(items) ? items : [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const item = list[i];
            const box = measureEditTextItem(item, ctx);
            if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) return item;
        }
        return null;
    }

    function cropRatioFromPreset(preset, getBounds) {
        if (!preset || preset === 'free') return null;
        if (preset === 'source') {
            const bounds = typeof getBounds === 'function' ? getBounds() : null;
            const w = Number(bounds?.w || 0);
            const h = Number(bounds?.h || 0);
            return w > 0 && h > 0 ? w / h : null;
        }
        const parts = String(preset).split(':').map(value => Math.max(0, Number(value)));
        return parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : null;
    }

    function viewportKernel() {
        const kernel = global.XiaomeiViewportKernel;
        if (!kernel) throw new Error('XiaomeiViewportKernel is required');
        return kernel;
    }

    function cameraRecord(viewport) {
        const view = viewport || {};
        const scale = Number(view.scale);
        return {
            x: Number(view.x) || 0,
            y: Number(view.y) || 0,
            scale: scale > 0 ? scale : 1,
        };
    }

    function frameFromRect(rect) {
        return {
            left: Number(rect?.left || 0),
            top: Number(rect?.top || 0),
            width: Number(rect?.width || 0),
            height: Number(rect?.height || 0),
        };
    }

    function screenToWorld(clientX, clientY, rect, viewport) {
        return viewportKernel().pointerToWorld(cameraRecord(viewport), frameFromRect(rect), clientX, clientY);
    }

    function boardCenterWorld(width, height, viewport) {
        const frame = { left: 0, top: 0, width: Number(width || 0), height: Number(height || 0) };
        const visible = viewportKernel().visibleWorldRect(cameraRecord(viewport), frame);
        return { x: visible.x + visible.w / 2, y: visible.y + visible.h / 2 };
    }

    function editCanvasScale(canvasEl) {
        const rect = canvasEl?.getBoundingClientRect?.();
        const width = Math.max(1, Number(canvasEl?.width || 1));
        const height = Math.max(1, Number(canvasEl?.height || 1));
        return {
            x: (rect?.width || width) / width,
            y: (rect?.height || height) / height,
            rect,
        };
    }

    function imageEditZoomSize(baseW, baseH, zoom) {
        const scale = Number(zoom) || 1;
        return {
            width: Math.round(Math.max(0, Number(baseW) || 0) * scale),
            height: Math.round(Math.max(0, Number(baseH) || 0) * scale),
        };
    }

    function originalMediaUrl(url, locationRef = global.location) {
        const raw = typeof url === 'string' ? url : (url?.url || '');
        if (!raw) return '';
        try {
            const parsed = new URL(raw, locationRef?.origin || undefined);
            if (parsed.pathname === '/api/media-preview') return parsed.searchParams.get('url') || raw;
        } catch (_) {}
        return raw;
    }

    function proxyMediaUrl(url, filename = '', options = {}) {
        const raw = originalMediaUrl(url);
        if (!raw || raw.startsWith('/assets/') || raw.startsWith('/output/')
            || raw.startsWith('/api/storage-files/') || raw.startsWith('data:') || raw.startsWith('blob:')) {
            return raw;
        }
        if (!/^https?:\/\//i.test(raw)) return raw;
        const name = filename || (typeof url === 'object' ? url.name : '') || fileNameFromUrl(raw) || 'preview';
        const inline = options.inline ? '&inline=1' : '';
        return `/api/download-output?${inline ? 'inline=1&' : ''}url=${encodeURIComponent(raw)}&name=${encodeURIComponent(name)}`;
    }

    function fileNameFromUrl(url, locationRef = global.location) {
        try {
            const parsed = new URL(String(url || ''), locationRef?.href || undefined);
            return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
        } catch (_) {
            return decodeURIComponent(String(url || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '');
        }
    }

    function downloadHref(url, filename = 'download') {
        const raw = originalMediaUrl(url);
        if (!raw) return '';
        if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('/api/download-output')) return raw;
        const name = filename || fileNameFromUrl(raw) || 'download';
        return `/api/download-output?url=${encodeURIComponent(raw)}&name=${encodeURIComponent(name)}`;
    }

    function downloadUrl(url, filename = 'download', documentRef = global.document) {
        const href = downloadHref(url, filename);
        if (!href || !documentRef) return Promise.resolve(false);
        const link = documentRef.createElement('a');
        link.href = href;
        link.download = filename || '';
        link.target = '_blank';
        documentRef.body.appendChild(link);
        link.click();
        link.remove();
        return Promise.resolve(true);
    }

    function gridPresetState(rows, cols) {
        return {
            customMode:false,
            customLines:[],
            customHistory:[],
            customDrag:null,
            horizontalLines:Math.max(0, Number(rows || 1) - 1),
            verticalLines:Math.max(0, Number(cols || 1) - 1),
        };
    }

    function toggleGridState(state = {}) {
        const next = {...state, customMode:!Boolean(state.customMode), customDrag:null};
        if (next.customMode) {
            next.customLines = [];
            next.customHistory = [];
        }
        return next;
    }

    function undoGridState(state = {}) {
        const history = Array.isArray(state.customHistory) ? state.customHistory.slice() : [];
        if (!history.length) return {...state, customHistory:history, customDrag:null};
        return {
            ...state,
            customLines:Array.isArray(history[history.length - 1]) ? history[history.length - 1] : [],
            customHistory:history.slice(0, -1),
            customDrag:null,
        };
    }

    function commitGridState(state = {}, nextLines = []) {
        const currentLines = Array.isArray(state.customLines) ? state.customLines : [];
        const history = Array.isArray(state.customHistory) ? state.customHistory : [];
        return {
            ...state,
            customLines: Array.isArray(nextLines) ? nextLines.map(line => ({...line})) : [],
            customHistory: [...history, currentLines.map(line => ({...line}))],
            customDrag: null,
        };
    }

    global.XiaomeiCanvasEditorCore = {
        boardCenterWorld,
        commitGridState,
        copyTextWithCopyEvent,
        copyText,
        cropRatioFromPreset,
        downloadHref,
        editCanvasScale,
        downloadUrl,
        fileNameFromUrl,
        gridPresetState,
        hitEditTextItem,
        imageEditZoomSize,
        measureEditTextItem,
        originalMediaUrl,
        proxyMediaUrl,
        screenToWorld,
        textItemFont,
        toggleGridState,
        undoGridState,
    };
    if (typeof global.downloadUrl !== 'function') global.downloadUrl = downloadUrl;
})(window);
