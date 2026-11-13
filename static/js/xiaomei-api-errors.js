(function (root) {
    'use strict';

    const generic = '请求失败';

    function printable(value) {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        try { return JSON.stringify(value) || ''; } catch (_) { return ''; }
    }

    function issue(value) {
        if (!value || typeof value !== 'object') return printable(value);
        const text = printable(value.msg ?? value.message ?? value);
        const path = Array.isArray(value.loc) ? value.loc.filter(part => part !== 'body').join('.') : '';
        return path && text ? path + ': ' + text : text;
    }

    function describe(data, fallback = generic) {
        if (!data) return fallback;
        if (typeof data === 'string') return data || fallback;
        const detail = data.detail ?? data.error ?? data.message;
        if (typeof detail === 'string') return detail || fallback;
        if (Array.isArray(detail)) return detail.map(issue).filter(Boolean).join('\n') || fallback;
        if (detail && typeof detail === 'object') return printable(detail.message ?? detail.msg ?? detail) || fallback;
        return printable(data) || fallback;
    }

    async function read(response, fallback = generic) {
        let body;
        try { body = await response.text(); } catch (_) { return fallback; }
        if (!body) return fallback;
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) { return body; }
        return describe(parsed, fallback);
    }

    root.XiaomeiApiErrors = { read, describe };
})(window);
