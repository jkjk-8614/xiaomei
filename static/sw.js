/* 小美画布 · 生图通知点击跳转 Service Worker */
self.addEventListener('notificationclick', event => {
    const data = (event.notification && event.notification.data) || {};
    const targetUrl = data.url || '/';
    const normalized = new URL(targetUrl, self.location.origin).href;
    event.notification.close();
    event.waitUntil((async () => {
        try {
            const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
            let target = windowClients.find(client => client.url === normalized);
            if (!target) {
                target = windowClients.find(client => client.url.indexOf(self.location.origin) === 0 && client.url.indexOf('/static/smart-canvas.html') !== -1);
            }
            if (!target) {
                target = windowClients.find(client => client.url.indexOf(self.location.origin) === 0);
            }
            if (target) {
                await target.focus();
                try { target.postMessage({ type: 'smart-generation-notice-click', nodeId: data.nodeId || '' }); } catch (e) {}
                return;
            }
            await clients.openWindow(normalized);
        } catch (e) {
            try { await clients.openWindow(normalized); } catch (err) {}
        }
    })());
});