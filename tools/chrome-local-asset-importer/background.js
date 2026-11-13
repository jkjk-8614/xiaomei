const mediaByTab = new Map();

function classify(url, headers) {
    const path = new URL(url).pathname;
    const mime = (headers || []).find(header => header.name.toLowerCase() === 'content-type')?.value || '';
    if (/\.(m3u8|mpd)$/i.test(path) || /mpegurl|dash\+xml/i.test(mime)) return 'stream';
    if (/\.(ts|m4s)$/i.test(path) || /mp2t|iso\.segment/i.test(mime)) return '';
    if (/\.(mp4|webm|mov|m4v|flv)$/i.test(path) || /^video\//i.test(mime)) return 'video';
    return '';
}

function tabMedia(tabId) {
    const key = 'media:' + tabId;
    if (!mediaByTab.has(tabId)) {
        mediaByTab.set(tabId, chrome.storage.session.get(key).then(data => data[key] || []));
    }
    return mediaByTab.get(tabId);
}

async function remember(details) {
    if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
    const kind = classify(details.url, details.responseHeaders);
    if (!kind) return;
    const pending = tabMedia(details.tabId);
    const records = await pending;
    if (mediaByTab.get(details.tabId) !== pending) return;
    const index = records.findIndex(item => item.url === details.url);
    if (index >= 0) return;
    records.push({url: details.url, kind, frameId: Math.max(0, details.frameId)});
    if (records.length > 200) records.shift();
    await chrome.storage.session.set({['media:' + details.tabId]: records});
}

function forget(tabId) {
    mediaByTab.delete(tabId);
    void chrome.storage.session.remove('media:' + tabId).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(details => {
    void remember(details).catch(() => {});
}, {urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other']}, ['responseHeaders']);
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') forget(tabId); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'observed-media' || !Number.isInteger(message.tabId)) {
        return false;
    }
    tabMedia(message.tabId).then(reply, () => reply([]));
    return true;
});
