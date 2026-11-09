/* Xiaomei dispatch kernel.
   Task poll decisions for the only dispatch path.
   Query parameters, stored flags, request headers, and setActive do not
   select another implementation. */
(function (root) {
    'use strict';

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-dispatch', 'next');
    }

    function isActive() { return true; }

    function setActive() {
        markDocument();
        return true;
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

    root.XiaomeiDispatchKernel = {
        isActive: isActive,
        setActive: setActive,
        pollDecision: pollDecision,
        mediaUrls: mediaUrls,
        taskRequest: taskRequest
    };
})(typeof window !== 'undefined' ? window : globalThis);
