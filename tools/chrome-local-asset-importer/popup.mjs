import {lowResolution, readFrameMedia, scanFrame} from './collector.mjs';
import {zipFiles} from './archive.mjs';

const $ = id => document.getElementById(id);
const side = new URL(location.href).searchParams.has('side');
document.body.toggleAttribute('data-side', side);
$('pin').hidden = side;
let candidates = [], checked = new Set(), providers = [], busy = false, scanned = false;
let windowId, preferredProvider = '', preferredModel = '';
const inlineCache = new WeakMap();
const preferences = ['server', 'folder', 'classify', 'autoScroll', 'filterLowRes', 'provider', 'model', 'prompt'];
const uploadLimit = 200;
const batchBytes = 8 * 1024 * 1024;

function status(message) {
    $('status').textContent = message;
}

function visible() {
    return $('filterLowRes').checked ? candidates.filter(item => !lowResolution(item)) : candidates;
}

function chosen() {
    return visible().filter(item => checked.has(item.url) && item.kind !== 'stream');
}

function refreshControls() {
    const count = chosen().length;
    $('count').textContent = scanned ? `找到 ${visible().length} 项 · 已选 ${count}` : '未扫描';
    for (const id of ['download', 'import']) $(id).disabled = busy || !count;
    for (const id of ['scan', 'capture', 'connect', 'all', 'clear']) $(id).disabled = busy;
}

function address() {
    const value = $('server').value.trim() || '127.0.0.1:3000';
    let url;
    try { url = new URL(value.includes('://') ? value : 'http://' + value); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password) {
        throw new Error('请输入小美画布的本机服务地址');
    }
    return url.origin;
}

function savePreferences() {
    $('addressSummary').textContent = $('server').value || '127.0.0.1:3000';
    return chrome.storage.local.set({
        server: $('server').value.trim(), folder: $('folder').value, prompt: $('prompt').value,
        classify: $('classify').checked, autoScroll: $('autoScroll').checked, filterLowRes: $('filterLowRes').checked,
        provider: preferredProvider, model: preferredModel, settingsCollapsed: !$('settings').open,
    });
}

async function post(action, body) {
    let response;
    try {
        response = await fetch(`${address()}/api/browser-import/${action}`, {
            method: 'POST', credentials: 'omit', redirect: 'error',
            headers: {'Content-Type': 'application/json', 'X-Xiaomei-Importer': '1'},
            body: JSON.stringify(body),
        });
    } catch (error) {
        if (error instanceof TypeError) throw new Error('无法连接小美画布，请确认应用已启动并检查服务地址');
        throw error;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `连接失败（HTTP ${response.status}）`);
    return result;
}

function fillSelect(id, rows, value, placeholder) {
    const select = $(id);
    select.replaceChildren(new Option(placeholder, ''), ...rows.map(row => new Option(row.name, row.id)));
    select.value = rows.some(row => row.id === value) ? value : '';
}

function renderModels() {
    const provider = providers.find(row => row.id === preferredProvider);
    const rows = (provider?.chat_models || []).map(id => ({id, name: id}));
    fillSelect('model', rows, preferredModel, '默认模型');
    preferredModel = $('model').value;
}

async function connect() {
    status('正在连接本机小美画布…');
    const result = await post('connect', {});
    providers = Array.isArray(result.providers) ? result.providers : [];
    if (!providers.some(row => row.id === preferredProvider)) preferredProvider = providers.find(row => row.primary)?.id || providers[0]?.id || '';
    fillSelect('provider', providers, preferredProvider, '首选平台');
    renderModels();
    await savePreferences();
    status('已连接小美画布');
}

async function activePage() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) throw new Error('请先打开要采集的网页');
    windowId = tab.windowId;
    return tab;
}

function appendItems(items) {
    const byUrl = new Map(candidates.map(item => [item.url, item]));
    for (const item of items) {
        const previous = byUrl.get(item.url);
        if (!previous || (!previous.width && item.width) || item.kind === 'stream') byUrl.set(item.url, item);
    }
    candidates = [...byUrl.values()];
}

async function scan() {
    status('正在扫描网页…');
    const tab = await activePage();
    const frames = await chrome.scripting.executeScript({
        target: {tabId: tab.id, allFrames: true}, func: scanFrame, args: [$('autoScroll').checked],
    });
    const media = frames.flatMap(frame => (frame.result || []).map(item => ({
        ...item, tabId: tab.id, frameId: frame.frameId, documentId: frame.documentId,
    })));
    const observed = await chrome.runtime.sendMessage({type: 'observed-media', tabId: tab.id}).catch(() => []);
    candidates = [];
    checked.clear();
    appendItems([...media, ...(observed || []).map(item => ({...item, tabId: tab.id}))]);
    scanned = true;
    render();
    status(candidates.length ? '' : '当前页未发现可采集素材');
}

async function capture() {
    const tab = await activePage();
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
    appendItems([{url: data, kind: 'image', name: '网页截图.png'}]);
    checked.add(data);
    scanned = true;
    render();
    status('已截取可见画面');
}

function safeName(value, fallback) {
    const clean = String(value || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '');
    return clean || fallback;
}

function label(item, mime = '') {
    let file = item.name;
    if (!file && /^https?:/.test(item.url)) {
        try { file = decodeURIComponent(new URL(item.url).pathname.split('/').at(-1)); } catch {}
    }
    const type = mime || (item.url.startsWith('data:') ? item.url.slice(5).split(/[;,]/)[0] : '');
    const known = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
        'image/svg+xml': '.svg', 'image/avif': '.avif', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/mp4': '.mp4'};
    const name = safeName(file, item.kind === 'video' ? '网页视频' : item.kind === 'stream' ? '流媒体清单' : '网页图片');
    return /\.[a-z0-9]{2,5}$/i.test(name) || item.kind === 'stream' ? name
        : name + (known[type] || (item.kind === 'video' ? '.mp4' : '.png'));
}

async function readInPage(item) {
    const target = item.documentId ? {tabId: item.tabId, documentIds: [item.documentId]}
        : {tabId: item.tabId, frameIds: [item.frameId || 0]};
    const [frame] = await chrome.scripting.executeScript({target, func: readFrameMedia, args: [item.url]});
    if (!frame?.result?.data) throw new Error('原网页已切换，无法读取此素材');
    return frame.result;
}

async function fetchBlob(item) {
    if (item.url.startsWith('blob:')) {
        const inline = await readInPage(item);
        return await (await fetch(inline.data)).blob();
    }
    try {
        const response = await fetch(item.url);
        const type = response.headers.get('content-type') || '';
        if (response.ok && !/^(text\/html|application\/json)\b/i.test(type)) return await response.blob();
    } catch {}
    const inline = await readInPage(item);
    return await (await fetch(inline.data)).blob();
}

function inlineData(item) {
    if (item.url.startsWith('data:') && /^data:[^,]*;base64,/i.test(item.url)) {
        return Promise.resolve({data: item.url, type: item.url.slice(5).split(/[;,]/)[0]});
    }
    if (!inlineCache.has(item)) {
        const ready = (async () => {
            if (item.url.startsWith('blob:')) return await readInPage(item);
            const blob = await fetchBlob(item);
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve({data: reader.result, type: blob.type});
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
        })();
        inlineCache.set(item, ready);
        ready.catch(() => inlineCache.delete(item));
    }
    return inlineCache.get(item);
}

async function importSelected() {
    const items = chosen();
    await savePreferences();
    status(`正在导入 ${items.length} 项素材…`);
    const configuration = {folder: $('folder').value.trim() || '网页采集', classify: $('classify').checked,
        provider: preferredProvider, model: preferredModel, prompt: $('prompt').value.trim()};
    let successes = 0, firstError = '';
    let sent = [], size = 0;
    async function flush() {
        if (!sent.length) return;
        const result = await post('items', {...configuration, items: sent});
        successes += result.count || 0;
        firstError ||= result.items?.find(row => !row.ok)?.error || '';
        sent = [];
        size = 0;
    }
    for (const item of items) {
        let inline;
        try {
            inline = await inlineData(item);
        } catch (error) {
            firstError ||= error.message;
            continue;
        }
        if (sent.length >= uploadLimit || size + inline.data.length > batchBytes) await flush();
        sent.push({url: /^https?:/.test(item.url) ? item.url : '',
            name: label(item, inline.type), data: inline.data, content_type: inline.type});
        size += inline.data.length;
        if (!item.url.startsWith('blob:')) inlineCache.delete(item);
    }
    await flush();
    status(`已导入 ${successes} 项${successes < items.length ? `，失败 ${items.length - successes} 项${firstError ? ' · ' + firstError : ''}` : ''}`);
}

async function startDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    try { await chrome.downloads.download({url, filename, conflictAction: 'uniquify'}); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

async function downloadSelected() {
    const items = chosen();
    const files = [];
    for (const [index, item] of items.entries()) {
        status(`正在准备下载 ${index + 1}/${items.length}…`);
        try {
            const blob = await fetchBlob(item);
            files.push({blob, name: label(item, blob.type)});
        } catch {
            if (items.length === 1 && /^https?:/.test(item.url)) {
                await chrome.downloads.download({url: item.url, filename: label(item), conflictAction: 'uniquify'});
                status('已交给浏览器下载');
                return;
            }
        }
    }
    if (!files.length) throw new Error('没有可下载的素材');
    if (items.length === 1) await startDownload(files[0].blob, files[0].name);
    else {
        const content = [];
        for (const file of files) content.push({name: file.name, bytes: new Uint8Array(await file.blob.arrayBuffer())});
        await startDownload(zipFiles(content), safeName($('folder').value, '网页采集') + '.zip');
    }
    status(`已交给浏览器下载 ${files.length} 项${files.length < items.length ? `，失败 ${items.length - files.length} 项` : ''}`);
}

async function openPreview(item) {
    if (item.kind === 'stream') {
        await navigator.clipboard.writeText(item.url);
        status('已复制流媒体清单地址');
        return;
    }
    const media = document.createElement(item.kind === 'video' ? 'video' : 'img');
    if (item.kind === 'video') media.controls = true;
    else media.alt = label(item);
    media.src = item.url.startsWith('blob:') ? (await inlineData(item)).data : item.url;
    $('previewBody').replaceChildren(media);
    $('preview').showModal();
}

function render() {
    const children = visible().map(item => {
        const card = document.createElement('article');
        card.className = 'card';
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'thumb';
        preview.title = item.kind === 'stream' ? '复制流媒体清单地址' : '预览 ' + label(item);
        if (item.kind === 'image' && !item.url.startsWith('blob:')) {
            const image = new Image();
            image.loading = 'lazy';
            image.alt = label(item);
            image.src = item.url;
            preview.append(image);
        } else {
            preview.textContent = item.kind === 'stream' ? '复制流媒体链接' : item.kind === 'video' ? '预览视频' : '预览图片';
        }
        preview.addEventListener('click', () => openPreview(item).catch(error => status(error.message)));
        const name = document.createElement('p');
        name.textContent = label(item);
        name.title = name.textContent;
        card.append(preview, name);
        if (item.kind !== 'stream') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = checked.has(item.url);
            input.setAttribute('aria-label', '选择 ' + name.textContent);
            input.addEventListener('change', () => {
                if (input.checked) checked.add(item.url);
                else checked.delete(item.url);
                refreshControls();
            });
            card.append(input);
        }
        return card;
    });
    if (!children.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = scanned ? '没有符合条件的素材' : '扫描当前页面，选择要采集的素材。';
        children.push(empty);
    }
    $('grid').replaceChildren(...children);
    refreshControls();
}

function run(action) {
    return async () => {
        if (busy) return;
        busy = true;
        refreshControls();
        try { await action(); }
        catch (error) { status(error.message || '操作失败，请重试'); }
        finally { busy = false; refreshControls(); }
    };
}

$('connect').onclick = run(connect);
$('scan').onclick = run(scan);
$('capture').onclick = run(capture);
$('import').onclick = run(importSelected);
$('download').onclick = run(downloadSelected);
$('all').onclick = () => {
    for (const item of visible()) if (item.kind !== 'stream') checked.add(item.url);
    render();
};
$('clear').onclick = () => { checked.clear(); render(); };
$('closePreview').onclick = () => $('preview').close();
$('preview').addEventListener('close', () => $('previewBody').replaceChildren());
$('pin').onclick = () => {
    if (!chrome.sidePanel?.open || !windowId) { status('当前浏览器无法打开侧边栏'); return; }
    chrome.sidePanel.open({windowId}).then(() => window.close(), error => status(error.message));
};
for (const key of preferences) {
    $(key).addEventListener('change', () => {
        if (key === 'provider') {
            preferredProvider = $('provider').value;
            preferredModel = '';
            renderModels();
        }
        if (key === 'model') preferredModel = $('model').value;
        if (key === 'filterLowRes') render();
        void savePreferences();
    });
}
$('settings').addEventListener('toggle', () => void savePreferences());

const saved = await chrome.storage.local.get([...preferences, 'port', 'settingsCollapsed']);
$('server').value = saved.server || (saved.port ? `127.0.0.1:${saved.port}` : '127.0.0.1:3000');
$('folder').value = saved.folder || '';
$('prompt').value = saved.prompt || '';
$('classify').checked = saved.classify !== false;
for (const key of ['filterLowRes', 'autoScroll']) $(key).checked = !!saved[key];
preferredProvider = saved.provider || '';
preferredModel = saved.model || '';
$('settings').open = saved.settingsCollapsed === false;
$('addressSummary').textContent = $('server').value;
fillSelect('provider', [], '', '连接后选择平台');
fillSelect('model', [], '', '默认模型');
windowId = (await chrome.windows.getCurrent()).id;
render();
