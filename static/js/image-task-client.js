(function (global) {
    'use strict';

    const DEFAULT_TASK_PATH = taskId => `/api/canvas-image-tasks/${encodeURIComponent(taskId)}`;
    const DEFAULT_INTERVAL_MS = 1800;
    const DEFAULT_MAX_ATTEMPTS = 900;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
    }

    function fetchImplFrom(options = {}) {
        if (typeof options.fetchImpl === 'function') return options.fetchImpl;
        if (typeof global.fetch === 'function') return global.fetch.bind(global);
        throw new Error('当前环境不支持 fetch');
    }

    function httpError(message, status = 0) {
        const error = new Error(String(message || '请求失败'));
        error.status = Number(status) || 0;
        return error;
    }

    async function responseBody(response) {
        const text = await response.text().catch(() => '');
        if (!text) return { text: '', data: null };
        try {
            return { text, data: JSON.parse(text) };
        } catch (_) {
            return { text, data: null };
        }
    }

    function responseMessageFromBody(body, fallback = '请求失败') {
        const data = body?.data;
        if (data && typeof data === 'object') {
            const detail = data.detail || data.error || data.message;
            if (typeof detail === 'string' && detail.trim()) return detail.trim();
            if (detail && typeof detail === 'object') {
                try { return JSON.stringify(detail); } catch (_) {}
            }
        }
        return String(body?.text || fallback || '请求失败').trim() || String(fallback || '请求失败');
    }

    function createClientRequestId() {
        try {
            if (global.crypto && typeof global.crypto.randomUUID === 'function') {
                return `canvas-${global.crypto.randomUUID()}`;
            }
        } catch (_) {}
        return `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function isNetworkFailure(error) {
        if (!error || error.status) return false;
        const name = String(error.name || '').toLowerCase();
        const message = String(error.message || '').toLowerCase();
        return error.code === 'NETWORK_ERROR'
            || name === 'typeerror'
            || name === 'networkerror'
            || /failed to fetch|networkerror|load failed|fetch failed/.test(message);
    }

    function normalizeFetchError(error, path) {
        if (!isNetworkFailure(error)) return error;
        const normalized = new Error(
            `无法连接本地生图服务（${path}）。请确认小美画布后端仍在运行；` +
            '如果任务已经提交，系统会先尝试找回任务，不会直接重复扣费。',
        );
        normalized.name = 'NetworkError';
        normalized.code = 'NETWORK_ERROR';
        normalized.path = path;
        normalized.cause = error;
        return normalized;
    }

    async function requestJson(path, options = {}) {
        const fetchImpl = fetchImplFrom(options);
        const method = String(options.method || 'GET').toUpperCase();
        const init = {
            ...(options.requestInit || {}),
            method,
            headers: {
                ...(options.requestInit?.headers || {}),
                ...(options.headers || {}),
            },
        };
        const timeoutMs = Number(options.timeoutMs);
        let timeoutController = null;
        let timeoutId = null;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0
            && typeof AbortController !== 'undefined' && !init.signal) {
            timeoutController = new AbortController();
            init.signal = timeoutController.signal;
            timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        }
        if (options.body !== undefined) {
            init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        } else if (options.payload !== undefined) {
            init.body = JSON.stringify(options.payload);
            if (!Object.keys(init.headers).some(key => key.toLowerCase() === 'content-type')) {
                init.headers['Content-Type'] = 'application/json';
            }
        }
        try {
            let response;
            try {
                response = await fetchImpl(path, init);
            } catch (error) {
                if (timeoutController?.signal.aborted) {
                    const timeoutError = httpError(options.timeoutMessage || '请求超时');
                    timeoutError.name = 'TimeoutError';
                    timeoutError.code = 'TIMEOUT';
                    timeoutError.path = path;
                    timeoutError.cause = error;
                    throw timeoutError;
                }
                throw normalizeFetchError(error, path);
            }
            const body = await responseBody(response);
            if (!response.ok) {
                const error = httpError(responseMessageFromBody(body, options.fallbackMessage), response.status);
                error.path = path;
                error.body = body.data;
                throw error;
            }
            if (body.data !== null) return body.data;
            if (!body.text) return {};
            return body.text;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    function mediaItems(value, output = [], seen = new Set(), depth = 0) {
        if (value == null || depth > 8) return output;
        if (typeof value === 'string') {
            const url = value.trim();
            if (url && !seen.has(url)) {
                seen.add(url);
                output.push(url);
            }
            return output;
        }
        if (Array.isArray(value)) {
            value.forEach(item => mediaItems(item, output, seen, depth + 1));
            return output;
        }
        if (typeof value !== 'object') return output;

        const direct = [value.url, value.image_url, value.file_url, value.download_url, value.uri]
            .filter(item => typeof item === 'string' && item.trim());
        direct.forEach(item => mediaItems(item, output, seen, depth + 1));

        [
            'image_items', 'images', 'videos', 'audios', 'files', 'outputs',
            'items', 'data', 'result', 'results', 'output',
        ].forEach(key => {
            if (value[key] !== undefined) mediaItems(value[key], output, seen, depth + 1);
        });
        return output;
    }

    function extractMediaUrls(value) {
        return mediaItems(value, [], new Set(), 0);
    }

    function taskErrorMessage(task, fallback = '生图失败') {
        const value = task?.error ?? task?.message;
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (value && typeof value === 'object') {
            const message = value.message || value.detail || value.reason || value.description;
            if (typeof message === 'string' && message.trim()) return message.trim();
            try { return JSON.stringify(value); } catch (_) {}
        }
        return fallback;
    }

    function taskHasMediaResult(task) {
        return [task?.result, task]
            .filter(value => value !== undefined && value !== null)
            .some(value => extractMediaUrls(value).length > 0);
    }

    async function requestOnlineImage(payload, options = {}) {
        return requestJson(options.onlinePath || '/api/online-image', {
            ...options,
            method: 'POST',
            payload,
            fallbackMessage: options.fallbackMessage || '生图失败',
        });
    }

    async function recoverCanvasImageTask(clientRequestId, options = {}) {
        const requestId = String(clientRequestId || '').trim();
        if (!requestId) return null;
        const fetchImpl = fetchImplFrom(options);
        const attempts = Math.max(1, Number(options.recoveryAttempts ?? 8));
        const intervalMs = Math.max(100, Number(options.recoveryIntervalMs ?? 350));
        const path = `/api/canvas-image-tasks/recover?client_request_id=${encodeURIComponent(requestId)}`;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (attempt) await sleep(intervalMs);
            try {
                const data = await requestJson(path, {
                    ...options,
                    fetchImpl,
                    method: 'GET',
                    fallbackMessage: '找回画布生图任务失败',
                });
                if (data?.task_id) return data;
            } catch (error) {
                // The POST may have failed before the server persisted the
                // record, or the server may be restarting.  Keep checking
                // those non-terminal lookup errors; never submit the image
                // request again from this recovery path.
                if (error?.status === 404 || isNetworkFailure(error) || Number(error?.status) >= 500) continue;
                throw error;
            }
        }
        return null;
    }

    async function createImageTask(payload, options = {}) {
        const requestPayload = {
            ...(payload || {}),
            client_request_id: String(payload?.client_request_id || '').trim() || createClientRequestId(),
        };
        try {
            return await requestJson(options.createPath || '/api/canvas-image-tasks', {
                ...options,
                method: 'POST',
                payload: requestPayload,
                fallbackMessage: options.fallbackMessage || '创建生图任务失败',
            });
        } catch (error) {
            if (!isNetworkFailure(error)) throw error;
            const recovered = await recoverCanvasImageTask(requestPayload.client_request_id, options);
            if (recovered?.task_id) return recovered;
            throw error;
        }
    }

    function defaultTaskDecision(task) {
        const status = String(task?.status || task?.task_status || '').toLowerCase();
        if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'complete') {
            if (!taskHasMediaResult(task)) {
                const message = task?.error
                    ? taskErrorMessage(task, '上游任务已完成，但没有返回可显示的图片')
                    : '上游任务已完成，但没有返回可显示的图片';
                return { action: 'reject', error: httpError(message) };
            }
            return { action: 'resolve', value: task };
        }
        if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
            return { action: 'reject', error: httpError(taskErrorMessage(task)) };
        }
        return { action: 'continue' };
    }

    async function pollImageTask(taskId, options = {}) {
        const id = String(taskId || '').trim();
        if (!id) throw httpError(options.missingTaskMessage || '生图任务不存在');

        const fetchImpl = fetchImplFrom(options);
        const intervalMs = Math.max(0, Number(options.intervalMs ?? DEFAULT_INTERVAL_MS));
        const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? intervalMs));
        const maxAttempts = Math.max(1, Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
        const taskPath = typeof options.taskPath === 'function'
            ? options.taskPath
            : () => String(options.taskPath || DEFAULT_TASK_PATH(id));
        const classifyTask = typeof options.classifyTask === 'function' ? options.classifyTask : defaultTaskDecision;
        const maxNetworkFailures = Math.max(0, Number(options.maxNetworkFailures || 0));
        let networkFailures = 0;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            if (typeof options.beforePoll === 'function') {
                const preDecision = await options.beforePoll({ attempt, taskId: id });
                if (preDecision?.action === 'resolve') return preDecision.value;
                if (preDecision?.action === 'reject') {
                    throw preDecision.error instanceof Error ? preDecision.error : httpError(preDecision.error);
                }
            }
            const delay = attempt === 0 ? initialDelayMs : intervalMs;
            if (delay) await sleep(delay);
            let task;
            try {
                task = await requestJson(taskPath(id, attempt), {
                    ...options,
                    fetchImpl,
                    method: 'GET',
                    fallbackMessage: options.fallbackMessage || '查询生图任务失败',
                });
                networkFailures = 0;
                if (typeof options.onTaskUpdate === 'function') {
                    try {
                        await options.onTaskUpdate(task, { attempt, taskId: id });
                    } catch (_) {
                        // 进度观察器只更新界面；它本身不能中断真实的生图轮询。
                    }
                }
            } catch (error) {
                if (error?.status) {
                    if (typeof options.onHttpError === 'function') {
                        const transformed = await options.onHttpError(error, { attempt, taskId: id });
                        throw transformed instanceof Error ? transformed : error;
                    }
                    if (options.retryHttpErrors !== true) throw error;
                }
                networkFailures += 1;
                if (networkFailures <= maxNetworkFailures) {
                    if (typeof options.onNetworkError === 'function') {
                        await options.onNetworkError(error, { attempt, networkFailures });
                    }
                    continue;
                }
                throw error;
            }

            const decision = (await classifyTask(task, { attempt, taskId: id })) || defaultTaskDecision(task);
            if (decision?.action === 'resolve') return decision.value;
            if (decision?.action === 'reject') throw decision.error instanceof Error ? decision.error : httpError(decision.error);
        }
        throw httpError(options.timeoutMessage || '生图任务超时');
    }

    async function runImage(payload, options = {}) {
        const mode = String(options.mode || 'sync').toLowerCase();
        if (mode === 'sync') return requestOnlineImage(payload, options);
        const created = await createImageTask(payload, options);
        const taskId = created?.task_id || created?.taskId || created?.id;
        if (!taskId) throw httpError(options.missingTaskMessage || '接口没有返回生图任务 ID');
        const task = await pollImageTask(taskId, options);
        return task?.result !== undefined ? task.result : task;
    }

    global.XiaomeiImageTaskClient = {
        createImageTask,
        extractMediaUrls,
        httpError,
        pollImageTask,
        requestJson,
        requestOnlineImage,
        responseMessageFromBody,
        runImage,
        sleep,
    };
})(window);
