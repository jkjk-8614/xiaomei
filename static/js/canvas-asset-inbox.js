(function (root) {
    'use strict';

    const key = 'smart_canvas_asset_inbox';
    const lifetime = 30 * 60 * 1000;
    const dimensions = ['natural_w', 'natural_h', 'width', 'height', 'w', 'h', 'layout_w', 'layout_h'];
    const hasUrl = item => typeof item?.url === 'string' && item.url.trim().length > 0;

    function write(items) {
        const records = [];
        for (const item of items) {
            if (!hasUrl(item)) continue;
            const record = { url: item.url, name: item.name || '素材', kind: item.kind || '' };
            const id = item.asset_ref_id || item.asset_id || (String(item.id || '').startsWith('asset_') ? item.id : '');
            if (id) record.asset_ref_id = id;
            if (item.asset_uris && typeof item.asset_uris === 'object') record.asset_uris = item.asset_uris;
            for (const key of dimensions) {
                const size = Number(item[key]);
                if (Number.isFinite(size) && size > 0) record[key] = size;
            }
            records.push(record);
        }
        if (records.length) root.localStorage.setItem(key, JSON.stringify({ items: records, ts: Date.now() }));
        return records.length;
    }

    function read() {
        try {
            const stored = root.localStorage.getItem(key);
            if (!stored) return null;
            const entry = JSON.parse(stored);
            const timestamp = Number(entry?.ts);
            if (!Array.isArray(entry?.items) || (timestamp && Date.now() - timestamp > lifetime)) return null;
            const items = entry.items.filter(hasUrl);
            return items.length ? { items, stored } : null;
        } catch (_) {
            return null;
        }
    }

    function consume(entry) {
        try {
            if (root.localStorage.getItem(key) === entry.stored) root.localStorage.removeItem(key);
        } catch (_) {}
    }

    root.XiaomeiCanvasAssetInbox = { write, read, consume };
}(window));
