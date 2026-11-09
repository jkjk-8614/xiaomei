/* Xiaomei dispatch kernel, phase 2 step 5.
   Task poll decisions and the opt-in header for the server protocol path. */
(function (root) {
    'use strict';

    var STORAGE_KEY = 'xiaomei.dispatchKernel';
    var QUERY_KEY = 'xmDispatch';
    var HEADER = 'X-Xiaomei-Dispatch';

    function storage() {
        try { return root.localStorage || null; } catch (error) { return null; }
    }

    function readQuery() {
        try {
            return new URLSearchParams(root.location && root.location.search || '').get(QUERY_KEY);
        } catch (error) {
            return null;
        }
    }

    function persist(mode) {
        var store = storage();
        if (!store) return;
        try { store.setItem(STORAGE_KEY, mode); } catch (error) {}
    }

    function initialActive() {
        var query = readQuery();
        if (query === '1' || query === 'next') {
            persist('next');
            return true;
        }
        if (query === '0' || query === 'legacy') {
            persist('legacy');
            return false;
        }
        var saved = '';
        try { saved = storage() ? storage().getItem(STORAGE_KEY) || '' : ''; } catch (error) { saved = ''; }
        return saved === 'next';
    }

    var active = initialActive();

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-dispatch', active ? 'next' : 'legacy');
    }

    function isActive() { return active; }

    function setActive(next) {
        active = Boolean(next);
        persist(active ? 'next' : 'legacy');
        markDocument();
        if (active) installFetch();
        return active;
    }

    function localApi(input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/') === 0) return true;
        try {
            var parsed = new URL(url, root.location && root.location.href);
            return parsed.pathname.indexOf('/api/') === 0;
        } catch (error) {
            return false;
        }
    }

    function installFetch() {
        if (!root.fetch || root.__xiaomeiDispatchFetch) return;
        var nativeFetch = root.fetch.bind(root);
        root.fetch = function (input, init) {
            if (!isActive() || !localApi(input)) return nativeFetch(input, init);
            var headers = new root.Headers((init && init.headers) || (input && input.headers) || undefined);
            if (!headers.has(HEADER)) headers.set(HEADER, 'next');
            var nextInit = Object.assign({}, init || {}, { headers: headers });
            return nativeFetch(input, nextInit);
        };
        root.__xiaomeiDispatchFetch = true;
    }

    function mediaUrls(result) {
        var found = [];
        function add(value) {
            if (typeof value === 'string' && value && found.indexOf(value) < 0) found.push(value);
            else if (value && typeof value === 'object') add(value.url || value.image_url || value.video_url);
        }
        var source = result && typeof result === 'object' ? result : {};
        add(source.url);
        (source.images || source.outputs || []).forEach(add);
        return found;
    }

    function pollDecision(task) {
        var status = String((task && (task.status || task.task_status)) || '').trim().toLowerCase();
        if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'complete') {
            if (!mediaUrls(task && task.result).length) {
                return { state: 'empty', message: (task && (task.error || task.message)) || '任务已完成，但没有返回可显示的图片' };
            }
            return { state: 'succeeded' };
        }
        if (status === 'jimeng_pending') return { state: 'jimeng_pending' };
        if (status === 'cancelled' || status === 'canceled') return { state: 'cancelled', message: (task && task.error) || '生图已取消' };
        if (status === 'failed' || status === 'error') {
            return {
                state: 'failed',
                message: (task && task.error) || '',
                terminal: Boolean(task && task.upstream_terminal_error),
                recoverId: (task && task.upstream_task_id) || ''
            };
        }
        return { state: 'pending' };
    }

    function taskRequest(kind, spec) {
        var source = spec || {};
        return {
            kind: kind,
            provider_id: source.providerId || source.provider_id || '',
            model: source.model || '',
            prompt: source.prompt || '',
            history_source: source.historySource || source.history_source || 'canvas',
            project_id: source.projectId || source.project_id || '',
            client_request_id: source.clientRequestId || source.client_request_id || ''
        };
    }

    markDocument();
    if (active) installFetch();

    root.XiaomeiDispatchKernel = {
        STORAGE_KEY: STORAGE_KEY,
        QUERY_KEY: QUERY_KEY,
        HEADER: HEADER,
        isActive: isActive,
        setActive: setActive,
        pollDecision: pollDecision,
        mediaUrls: mediaUrls,
        taskRequest: taskRequest
    };
})(typeof window !== 'undefined' ? window : globalThis);
