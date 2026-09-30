(function (global) {
    'use strict';

    const STORAGE_KEY = 'xiaomei_generation_notifications_enabled_v2';
    const SERVICE_WORKER_URL = '/static/sw.js?v=2026.08.19.2';
    const SERVICE_WORKER_SCOPE = '/static/';
    const signatures = new Set();
    let permissionPromise = null;
    let serviceWorkerPromise = null;

    function hasNotificationApi() {
        return typeof global.Notification === 'function';
    }

    function electronNotificationApi() {
        try {
            const api = global.electronAPI;
            return api && typeof api.showGenerationNotification === 'function' ? api : null;
        } catch (error) {
            return null;
        }
    }

    function notificationPermission() {
        if (!hasNotificationApi()) return 'unsupported';
        try { return global.Notification.permission || 'default'; } catch (error) { return 'default'; }
    }

    function rememberPermission() {
        try { global.localStorage.setItem(STORAGE_KEY, '1'); } catch (error) {}
    }

    function parentNotificationApi() {
        if (global.parent === global) return null;
        try {
            const api = global.parent.XiaomeiGenerationNotifications;
            return api && typeof api.notify === 'function' && typeof api.requestPermission === 'function' ? api : null;
        } catch (error) {
            return null;
        }
    }

    async function requestLocalPermission() {
        if (!hasNotificationApi()) return false;
        const current = notificationPermission();
        if (current === 'granted') {
            rememberPermission();
            return true;
        }
        if (current === 'denied') return false;
        if (permissionPromise) return permissionPromise;
        permissionPromise = (async () => {
            try {
                const permission = await global.Notification.requestPermission();
                if (permission === 'granted') rememberPermission();
                return permission === 'granted';
            } catch (error) {
                return false;
            }
        })().finally(() => {
            permissionPromise = null;
        });
        return permissionPromise;
    }

    async function requestPermission() {
        if (electronNotificationApi()) return true;
        const parentApi = parentNotificationApi();
        if (parentApi) {
            try {
                return Boolean(await parentApi.requestPermission());
            } catch (error) {}
        }
        return requestLocalPermission();
    }

    function waitForActive(registration) {
        if (!registration || registration.active) return Promise.resolve(registration);
        const worker = registration.installing || registration.waiting;
        if (!worker) return Promise.resolve(registration);
        return new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                worker.removeEventListener('statechange', onStateChange);
                resolve(registration);
            };
            const onStateChange = () => {
                if (worker.state === 'activated' || worker.state === 'redundant') finish();
            };
            worker.addEventListener('statechange', onStateChange);
            global.setTimeout(finish, 4000);
        });
    }

    function ensureServiceWorker() {
        const serviceWorker = global.navigator && global.navigator.serviceWorker;
        if (!serviceWorker) return Promise.resolve(null);
        if (!serviceWorkerPromise) {
            serviceWorkerPromise = serviceWorker.register(SERVICE_WORKER_URL, {scope: SERVICE_WORKER_SCOPE})
                .then(waitForActive)
                .catch(() => null);
        }
        return serviceWorkerPromise;
    }

    function normalizeEntry(entry) {
        const raw = entry && typeof entry === 'object' ? entry : {};
        const outputs = Array.isArray(raw.outputs) ? raw.outputs : [];
        const urls = outputs.map(item => {
            if (typeof item === 'string') return item;
            return item?.url || item?.path || item?.src || item?.uri || '';
        }).filter(Boolean);
        const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(raw.status || '').toLowerCase());
        const model = String(raw.model || raw.platform || '图片模型').trim() || '图片模型';
        const error = String(raw.error || raw.message || '').replace(/\s+/g, ' ').trim();
        const id = String(raw.id || raw.taskId || raw.task_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        return {
            ...raw,
            id,
            status: failed ? 'failed' : 'success',
            model,
            outputs: urls.map(url => ({url})),
            error,
            nodeId: String(raw.nodeId || raw.node_id || ''),
            url: String(raw.url || global.location?.href || '/'),
        };
    }

    function entrySignature(entry) {
        return [
            entry.id,
            entry.status,
            entry.nodeId,
            entry.error,
            entry.outputs.map(item => item.url).join('|'),
        ].join('::');
    }

    function showNotificationOptions(entry) {
        const failed = entry.status === 'failed';
        const count = Math.max(1, entry.outputs.length);
        const body = failed
            ? `${entry.model} 生成失败：${(entry.error || '请打开小美画布查看详情').slice(0, 140)}`
            : `${entry.model} 已完成，生成 ${count} 张图片`;
        return {
            title: entry.title || (failed ? '小美画布 · 生图失败' : '小美画布 · 生图完成'),
            options: {
                body,
                tag: `xiaomei-generation-${entry.id}`,
                renotify: false,
                data: {
                    url: entry.url,
                    nodeId: entry.nodeId,
                },
            },
        };
    }

    function forwardNotificationClick(data) {
        if (global.parent !== global || !global.document) return;
        const frame = global.document.getElementById('frame-canvas')
            || [...global.document.querySelectorAll('iframe')].find(item => {
                try { return /smart-canvas\.html/.test(item.contentWindow?.location?.pathname || ''); } catch (error) { return false; }
            });
        try { frame?.contentWindow?.postMessage(data, global.location.origin); } catch (error) {}
    }

    if (global.parent === global && global.navigator?.serviceWorker) {
        global.navigator.serviceWorker.addEventListener('message', event => {
            const data = event?.data || {};
            if (data.type === 'smart-generation-notice-click') forwardNotificationClick(data);
        });
        global.addEventListener('message', event => {
            if (event.origin && event.origin !== global.location.origin) return;
            if (event.data?.type === 'xiaomei-generation-notification') {
                notifyLocal(event.data.entry);
            }
        });
    }

    async function showLocal(entry) {
        let permission = notificationPermission();
        if (permission !== 'granted' && permissionPromise) {
            await permissionPromise;
            permission = notificationPermission();
        }
        if (permission !== 'granted') return false;
        const {title, options} = showNotificationOptions(entry);
        const registration = await ensureServiceWorker();
        if (registration && typeof registration.showNotification === 'function') {
            try {
                await registration.showNotification(title, options);
                return true;
            } catch (error) {
                // Service Worker notifications can reject asynchronously on older Chromium builds.
                // Fall through to the page Notification API instead of losing the notice silently.
            }
        }
        if (!hasNotificationApi()) return false;
        try {
            const notice = new global.Notification(title, options);
            notice.onclick = () => {
                try { global.focus(); } catch (error) {}
                forwardNotificationClick({type: 'smart-generation-notice-click', nodeId: entry.nodeId || ''});
                try { notice.close(); } catch (error) {}
            };
            return true;
        } catch (error) {
            return false;
        }
    }

    function notifyLocal(entry) {
        const normalized = normalizeEntry(entry);
        const electronApi = electronNotificationApi();
        const task = (async () => {
            const signature = entrySignature(normalized);
            if (signatures.has(signature)) return false;
            if (electronApi) {
                const {title, options} = showNotificationOptions(normalized);
                try {
                    const result = await electronApi.showGenerationNotification({
                        title,
                        body: options.body,
                        status: normalized.status,
                        model: normalized.model,
                        count: normalized.outputs.length,
                        error: normalized.error,
                        nodeId: normalized.nodeId,
                    });
                    if (result?.ok) {
                        signatures.add(signature);
                        return true;
                    }
                } catch (error) {}
            }
            let permission = notificationPermission();
            if (permission !== 'granted' && permissionPromise) {
                await permissionPromise;
                permission = notificationPermission();
            }
            if (permission !== 'granted') return false;
            signatures.add(signature);
            if (signatures.size > 500) {
                const first = signatures.values().next().value;
                if (first) signatures.delete(first);
            }
            return showLocal(normalized);
        })();
        return task.catch(() => false);
    }

    function notify(entry) {
        const parentApi = parentNotificationApi();
        if (parentApi) {
            try { return Promise.resolve(parentApi.notify(entry)).catch(() => false); } catch (error) {}
        }
        return notifyLocal(entry);
    }

    global.XiaomeiGenerationNotifications = {
        notify,
        requestPermission,
        supported: () => Boolean(electronNotificationApi() || hasNotificationApi()),
    };
})(window);
