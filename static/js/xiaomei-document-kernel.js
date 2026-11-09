/* Xiaomei document kernel.
   Canvas JSON envelope, older node migration, and save bodies.
   Disk writes stay in the existing client. This is the only document path.
   Query parameters, stored flags, and setActive do not select another implementation. */
(function (root) {
    'use strict';

    var CLASSIC_RUNTIME = ['_ltxEditor', 'running', 'runStatus', 'runError', '_cascadeIdx', '_cascadeFailed', '_activeLoopCtx'];

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-document', 'next');
    }

    function isActive() { return true; }

    function setActive() {
        markDocument();
        return true;
    }

    function copyValue(value) {
        if (value == null || typeof value !== 'object') return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
    }

    function finite(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function normalizeViewport(value) {
        var source = value && typeof value === 'object' ? value : {};
        var scale = finite(source.scale, 1);
        if (!(scale > 0)) scale = 1;
        return { x: finite(source.x, 0), y: finite(source.y, 0), scale: scale };
    }

    function cleanConnections(list) {
        var seen = {};
        var out = [];
        (Array.isArray(list) ? list : []).forEach(function (edge) {
            if (!edge || !edge.from || !edge.to || edge.from === edge.to) return;
            var kind = edge.kind || 'flow';
            var slot = edge.input_slot || edge.inputSlot || '';
            var key = String(edge.from) + '\u0000' + String(edge.to) + '\u0000' + kind + '\u0000' + slot;
            if (seen[key]) return;
            seen[key] = true;
            out.push(copyValue(edge));
        });
        return out;
    }

    function mediaFromInput(input) {
        if (!input || !input.url) return null;
        return {
            url: input.url,
            name: input.name || 'image',
            kind: input.kind || 'image',
            natural_w: Number(input.natural_w || 0),
            natural_h: Number(input.natural_h || 0)
        };
    }

    function hasRecordedRun(node) {
        return Boolean(node.runAt || node.runPrompt || node.runModelPrompt || node.sourceNodeId
            || node.generatedBatchRootId || node.pending || node.queued || node.running || node.jimengPending);
    }

    function hasGenerationSetup(node) {
        return Boolean((Array.isArray(node.inputNodeIds) && node.inputNodeIds.length)
            || node.promptDraftText || node.promptDraftHtml);
    }

    function migrateSmartNode(node, options) {
        if (!node || typeof node !== 'object') return null;
        var labels = options.labels || {};
        var next = copyValue(node);
        var migrations = options.migrations;
        if (next.type === 'smart-container') {
            var fallback = mediaFromInput(next.inputImage);
            var images = Array.isArray(next.images) && next.images.length ? next.images : (fallback ? [fallback] : []);
            next.type = 'smart-image';
            next.title = images.length > 1 ? (labels.group || 'Group') : (images.length ? (labels.image || 'Image') : (labels.upload || 'Import'));
            next.images = images;
            delete next.imageMode;
            delete next.inputImage;
            delete next.steps;
            delete next.resultGrouping;
            migrations.container += 1;
            return next;
        }
        var videoKind = next.runSettings && next.runSettings.apiKind === 'video';
        if ((next.type === 'smart-paint' || next.type === 'smart-image') && next.productFidelityNode !== true && videoKind) {
            next.type = 'smart-video';
            if (!next.title || next.title === labels.paint) next.title = labels.video || 'Video';
            migrations.video += 1;
        }
        if (!next.type) next.type = 'smart-image';
        if (next.type === 'smart-image') delete next.imageMode;
        if (next.type === 'smart-image' && next.historyFor) next.isHistoryGroup = true;
        if (next.type === 'smart-image' && next.retouchOwnerId && !next.isHistoryGroup) {
            next.type = 'smart-upload';
            migrations.upload += 1;
        }
        if (next.type === 'smart-image' && !next.historyFor && !next.isHistoryGroup && !hasRecordedRun(next) && !hasGenerationSetup(next)) {
            next.type = 'smart-upload';
            if (!(next.images || []).length) next.title = labels.upload || next.title;
            migrations.upload += 1;
        }
        return next;
    }

    function migrateClassicNode(node, stripRuntime) {
        if (!node || typeof node !== 'object') return null;
        var next = copyValue(node);
        if (next.type === 'msgen') {
            next.type = 'generator';
            next.ratio = next.msRatio || next.ratio || 'square';
            next.resolution = next.msResolution || next.resolution || '1k';
        }
        if (stripRuntime) CLASSIC_RUNTIME.forEach(function (key) { delete next[key]; });
        return next;
    }

    function adopt(raw, options) {
        var flags = options || {};
        var source = raw && typeof raw === 'object' ? raw : {};
        var migrations = { upload: 0, video: 0, container: 0, classic: 0 };
        var drop = {};
        (flags.dropNodeIds || []).forEach(function (id) { drop[id] = true; });
        var profile = flags.profile === 'smart' ? 'smart' : 'classic';
        var nodes = (Array.isArray(source.nodes) ? source.nodes : []).filter(function (node) {
            return node && !drop[node.id];
        }).map(function (node) {
            if (profile === 'smart') return migrateSmartNode(node, { labels: flags.labels, migrations: migrations });
            var classic = migrateClassicNode(node, flags.stripRuntime === true);
            if (classic && classic.type === 'generator' && node.type === 'msgen') migrations.classic += 1;
            return classic;
        }).filter(Boolean);
        var document = copyValue(source) || {};
        document.nodes = nodes;
        document.connections = cleanConnections(source.connections);
        document.viewport = normalizeViewport(source.viewport);
        document.logs = Array.isArray(source.logs) ? source.logs : [];
        document.settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
        if (!document.title) document.title = flags.fallbackTitle || '';
        if (!document.icon) document.icon = flags.fallbackIcon || '';
        return { document: document, migrations: migrations };
    }

    function saveBody(prepared, meta) {
        var info = meta || {};
        var adopted = adopt(prepared, {
            profile: info.profile,
            labels: info.labels,
            dropNodeIds: info.dropNodeIds,
            stripRuntime: info.profile !== 'smart',
            fallbackTitle: info.fallbackTitle,
            fallbackIcon: info.fallbackIcon
        });
        var doc = adopted.document;
        var body = {
            title: doc.title || info.fallbackTitle || '',
            icon: doc.icon || info.fallbackIcon || '',
            nodes: doc.nodes,
            connections: doc.connections,
            viewport: doc.viewport,
            logs: doc.logs,
            base_updated_at: Number(info.baseUpdatedAt || 0),
            client_id: info.clientId || ''
        };
        if (info.includeSettings) body.settings = doc.settings || {};
        return body;
    }

    markDocument();

    root.XiaomeiDocumentKernel = {
        isActive: isActive,
        setActive: setActive,
        normalizeViewport: normalizeViewport,
        cleanConnections: cleanConnections,
        adopt: adopt,
        saveBody: saveBody
    };
})(typeof window !== 'undefined' ? window : globalThis);
