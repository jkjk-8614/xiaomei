const fieldTypes = ['text', 'textarea', 'number', 'slider', 'dropdown', 'image', 'video', 'audio', 'boolean'];

const mediaTypes = {
    image: { accept: 'image/*', select: 'comfy.clickUploadImage', failure: 'comfy.imageUploadFailed', count: 'comfy.imageCount' },
    video: { accept: 'video/*', select: 'comfy.clickUploadVideo', failure: 'comfy.videoUploadFailed', count: 'comfy.videoCount' },
    audio: { accept: 'audio/*', select: 'comfy.clickUploadAudio', failure: 'comfy.audioUploadFailed', count: 'comfy.audioCount' },
};

const nodeGroups = {
    loader: ['CheckpointLoaderSimple', 'UNETLoader', 'VAELoader', 'CLIPLoader', 'DualCLIPLoader', 'ControlNetLoader'],
    sampler: ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'],
    prompt: ['CLIPTextEncode', 'CLIPTextEncodeFlux', 'ConditioningCombine', 'ConditioningConcat'],
    lora: ['LoraLoader', 'LoraLoaderModelOnly'],
    image: ['LoadImage', 'ImageScale'],
    output: ['SaveImage', 'PreviewImage'],
    vae: ['VAEDecode', 'VAEEncode'],
    latent: ['EmptyLatentImage', 'LatentUpscaleBy'],
    controlnet: ['ControlNetApply'],
    misc: ['PrimitiveNode', 'Note'],
};

const groupIcons = { loader: '📦', sampler: '⚙', prompt: '✎', lora: '⚡', misc: '◆' };
const nodeIcons = {
    ConditioningCombine: '⊕', ConditioningConcat: '⊕', ControlNetApply: '⇨',
    EmptyLatentImage: '▦', ImageScale: '⇆', LatentUpscaleBy: '↗',
    LoadImage: '🖼', Note: '≡', PreviewImage: '👁', PrimitiveNode: '•',
    SaveImage: '💾', VAEDecode: '◐', VAEEncode: '◑',
};
const nodeCategories = new Map(Object.entries(nodeGroups).flatMap(([group, nodes]) => nodes.map((node) => [node, group])));

function tr(key){
    return window.StudioI18n?.t(key) ?? key;
}

function tf(key, values){
    return tr(key).replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? values[name] : placeholder);
}

function translatedOr(key, fallback){
    const translation = tr(key);
    return translation === key ? fallback : translation;
}

function typeLabel(type){
    return translatedOr('comfy.type.' + type, type);
}

function inputLabel(name){
    return translatedOr('comfy.input.' + name, name);
}

function nodePresentation(node){
    const type = typeof node.class_type === 'string' ? node.class_type : '';
    const title = typeof node._meta?.title === 'string' ? node._meta.title.trim() : '';
    const category = nodeCategories.get(type) || 'misc';
    const label = translatedOr('comfy.node.' + type, type);
    return {
        title: title || label || tr('comfy.unnamedNode'),
        detail: title && label !== type ? [label, type].join(' · ') : type,
        icon: (Object.hasOwn(nodeIcons, type) ? nodeIcons[type] : groupIcons[category]) || groupIcons.misc,
        category,
    };
}

function refreshIcons(){
    window.lucide?.createIcons();
}

function refreshLanguageView(){
    document.title = tr('comfy.title');
    for(const element of document.querySelectorAll('[data-i18n-aria-label]')){
        element.setAttribute('aria-label', tr(element.dataset.i18nAriaLabel));
    }
    renderAddresses();
    renderList();
    renderEditor();
    renderPreview();
}

let workflows = [];
let selectedName = '';
let currentWorkflow = null;     // 原始 JSON
let currentConfig = null;       // { title, fields:[...] }
let isBuiltin = false;
let previewValues = Object.create(null);         // field_id -> 发给后端的值（图片：comfy 文件名）
let previewRandomActive = Object.create(null);   // field_id -> 筛子运行时是否激活；未设置时默认激活
let previewImageUrls = Object.create(null);      // field_id -> 浏览器可显示的本地 URL（仅图片字段）
let runResult = null;           // url 或 null
let workspaceMode = 'graph';
let miniTestNodes = [];

const statusEl = document.querySelector('#status');
const listEl = document.querySelector('#workflowList');
const workflowTitleInput = document.querySelector('#workflowTitleInput');
const subEl = document.querySelector('#editorSub');
const deleteBtn = document.querySelector('#deleteBtn');
const saveBtn = document.querySelector('#saveBtn');
const nodeListEl = document.querySelector('#nodeList');
const previewCard = document.querySelector('#previewContent');
const miniCanvasHost = document.querySelector('#miniCanvasHost');

function setStatus(message = ''){
    statusEl.textContent = message;
}

const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (character) => htmlEntities[character]);
}
const escapeAttr = escapeHtml;

function isMediaField(field){
    return Object.hasOwn(mediaTypes, field.type);
}

function fieldKind(field){
    if(isMediaField(field)) return field.type;
    const label = [field.input, field.name].join(' ');
    const prompt = field.type === 'textarea' || /prompt|text|提示词|正向|负向/i.test(label) || /^(positive|negative)$/i.test(field.input);
    return prompt ? 'prompt' : 'setting';
}

function mediaFieldLabel(kind, count){
    return tf(mediaTypes[kind].count, { count });
}

function mediaUploadText(kind){
    return tr(mediaTypes[kind].select);
}

function mediaPreviewHtml(kind, url, name, compact){
    if(!url) return escapeHtml(mediaUploadText(kind));
    const src = ' src="' + escapeAttr(url) + '"';
    if(kind === 'image') return '<img' + src + ' alt="' + escapeAttr(name || typeLabel(kind)) + '">';
    const player = '<' + kind + src + ' controls preload="metadata"' + (kind === 'video' ? ' muted playsinline' : '') + '></' + kind + '>';
    if(kind === 'video') return player;
    return '<div class="media-file-chip">' + testIcon('file-audio', compact ? 'w-5 h-5' : 'w-6 h-6') +
        '<span class="media-file-name">' + escapeHtml(name || typeLabel(kind)) + '</span>' + player + '</div>';
}

const savedCardDefaults = {
    prompt: { x: 24, y: 30 },
    image: { x: 24, y: 210 },
    custom: { x: 280, y: 78 },
    output: { x: 540, y: 120 },
};
const initialTrialCards = [
    ['prompt', 36, 96],
    ['image', 36, 286],
    ['comfy', 330, 150],
    ['output', 670, 190],
];

function createInitialTrialCards(){
    return initialTrialCards.map(([type, x, y]) => ({ id: type + '_1', type, x, y }));
}

const instanceEndpoint = '/api/comfyui/instances';
const workflowEndpoint = '/api/workflows';
const handoffKey = 'comfy-settings-workflow';
const workflowPath = (name) => workflowEndpoint + '/' + encodeURIComponent(name);
const workflowItems = (value) => Array.isArray(value) ? value : [];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
let instanceAddresses = [];
let instanceRevision = 0;
let savingAddresses = false;
let listVersion = 0;
let selectionVersion = 0;
let catalogTask;
let selectedRequest;
let requestedWorkflow = new URLSearchParams(location.search).get('workflow') || '';
let notifications;

async function settingsRequest(path, { method = 'GET', json, body, signal, fallback } = {}){
    const headers = json === undefined ? undefined : { 'Content-Type': 'application/json' };
    const response = await fetch(path, { method, headers, signal, body: json === undefined ? body : JSON.stringify(json) });
    const result = await response.json().catch(() => null);
    if(!response.ok || !result){
        const detail = typeof result?.detail === 'string' ? result.detail : result?.detail?.message;
        throw new Error(detail || fallback || 'HTTP ' + response.status);
    }
    return result;
}

function emitSettingsUpdate(type, parentToo = false){
    try {
        notifications ||= new BroadcastChannel('studio-api');
        notifications.postMessage({ type });
    } catch(_) {}
    if(parentToo && parent !== window) parent.postMessage({ type }, location.origin);
}

function renderAddresses(){
    const list = document.getElementById('comfyInstancesList');
    const rows = instanceAddresses.map((address, index) =>
        '<div class="backend-row"><span class="backend-order">' + (index + 1) + '</span>'
        + '<input class="small-input backend-address" data-backend-address="' + index + '" aria-label="'
        + escapeAttr(tf('comfy.backendAddress', { number: index + 1 })) + '" type="text" placeholder="host:port" value="' + escapeAttr(address) + '">'
        + '<button class="opt-del" type="button" data-remove-backend="' + index + '" aria-label="' + escapeAttr(tr('comfy.backendRemove')) + '">'
        + '<i data-lucide="x" class="w-3 h-3"></i></button></div>');
    list.innerHTML = rows.join('');
    for(const input of list.querySelectorAll('[data-backend-address]')){
        input.addEventListener('input', () => {
            instanceRevision += 1;
            instanceAddresses[Number(input.dataset.backendAddress)] = input.value;
        });
    }
    for(const button of list.querySelectorAll('[data-remove-backend]')){
        button.addEventListener('click', () => {
            instanceRevision += 1;
            instanceAddresses.splice(Number(button.dataset.removeBackend), 1);
            renderAddresses();
        });
    }
    refreshIcons();
}

async function loadComfyInstances(){
    const revision = instanceRevision;
    try {
        const data = await settingsRequest(instanceEndpoint);
        if(revision !== instanceRevision) return;
        instanceAddresses = workflowItems(data.instances);
        renderAddresses();
    } catch(error) {
        if(revision === instanceRevision) setStatus(tr('comfy.backendLoadingFailed') + ' · ' + error.message);
    }
}

function addComfyInstance(){
    instanceRevision += 1;
    instanceAddresses.push('');
    renderAddresses();
    document.querySelector('#comfyInstancesList .backend-row:last-child input')?.focus();
}

async function saveComfyInstances(){
    if(savingAddresses) return;
    const addresses = instanceAddresses.map((address) => address.trim()).filter(Boolean);
    if(!addresses.length){
        alert(tr('comfy.backendRequired'));
        return;
    }
    const revision = ++instanceRevision;
    const button = document.getElementById('saveComfyInstancesBtn');
    savingAddresses = true;
    if(button) button.disabled = true;
    setStatus(tr('comfy.backendSaving'));
    try {
        const data = await settingsRequest(instanceEndpoint, { method: 'PUT', json: { instances: addresses }, fallback: tr('comfy.backendSaveFailed') });
        if(revision === instanceRevision){
            instanceAddresses = workflowItems(data.instances);
            renderAddresses();
        }
        emitSettingsUpdate('comfy-instances-changed', true);
        setStatus(tr('comfy.backendSaved'));
    } catch(error) {
        setStatus(tr('comfy.backendSaveFailed'));
        alert(error.message);
    } finally {
        savingAddresses = false;
        if(button) button.disabled = false;
    }
}

function currentHandoff(){
    try {
        return sessionStorage.getItem(handoffKey)?.trim() || requestedWorkflow.trim();
    } catch(_) {
        return requestedWorkflow.trim();
    }
}

function forgetHandoff(){
    requestedWorkflow = '';
    try {
        sessionStorage.removeItem(handoffKey);
    } catch(_) {}
}

function openFromWorkspace(name){
    requestedWorkflow = name;
    if(workflows.some((row) => row.name === name)){
        forgetHandoff();
        return selectWorkflow(name);
    }
    return loadList();
}

async function loadList(preferred){
    if(catalogTask && preferred === undefined) return catalogTask;
    const version = ++listVersion;
    catalogTask = (async () => {
        try {
            const data = await settingsRequest(workflowEndpoint, { fallback: tr('comfy.loadFailed') });
            if(version !== listVersion) return;
            workflows = workflowItems(data.workflows).filter((entry) => typeof entry?.name === 'string' && entry.name);
            renderList();
            const desired = currentHandoff() || preferred;
            const candidate = workflows.find((entry) => entry.name === desired);
            if(candidate){
                forgetHandoff();
                if(selectedName !== candidate.name || !currentWorkflow) await selectWorkflow(candidate.name);
            } else if(!selectedRequest && !workflows.some((entry) => entry.name === selectedName)){
                if(workflows.length) await selectWorkflow(workflows[0].name);
                else if(currentWorkflow) clearWorkflow();
            }
        } catch(error) {
            if(version === listVersion) setStatus(tr('comfy.loadFailed') + ' · ' + error.message);
        } finally {
            if(version === listVersion) catalogTask = null;
        }
    })();
    return catalogTask;
}

function renderList(){
    const projects = new Map();
    for(const entry of workflows){
        const folder = String(entry.folder || entry.project || '').trim() || tr('comfy.workflowLibrary');
        if(!projects.has(folder)) projects.set(folder, []);
        projects.get(folder).push(entry);
    }
    listEl.innerHTML = Array.from(projects, ([folder, entries]) => {
        const cards = entries.map((entry) => {
            const active = entry.name === selectedName;
            const title = (active && currentConfig?.title) || entry.title || entry.name;
            const icon = entry.builtin ? 'package' : 'file-json-2';
            const badge = entry.builtin ? '<span class="builtin-badge">' + escapeHtml(tr('comfy.builtin')) + '</span>' : '';
            return '<button class="workflow-card' + (active ? ' active' : '') + '" type="button"'
                + ' data-workflow-name="' + escapeAttr(entry.name) + '" aria-label="' + escapeAttr(title) + '"'
                + ' aria-pressed="' + active + '"><span class="workflow-icon"><i data-lucide="' + icon + '" class="w-3.5 h-3.5"></i></span>'
                + '<span class="min-w-0" style="flex:1"><span class="workflow-name">' + escapeHtml(title) + '</span>'
                + '<span class="workflow-meta">' + escapeHtml(tf('comfy.fieldCount', { count: entry.field_count || 0 }))
                + '</span></span>' + badge + '</button>';
        }).join('');
        return '<section class="workflow-group" data-workflow-group="' + escapeAttr(folder) + '">'
            + '<div class="workflow-group-head"><span class="workflow-group-title"><i data-lucide="folder-open"></i>'
            + escapeHtml(folder) + '</span><span class="workflow-group-count">' + entries.length + '</span></div>'
            + '<div class="workflow-group-items">' + cards + '</div></section>';
    }).join('') || '<div class="workflow-empty">' + escapeHtml(tr('comfy.noWorkflow')) + '</div>';
    refreshIcons();
}

listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-workflow-name]');
    if(button && listEl.contains(button)) selectWorkflow(button.dataset.workflowName);
});

function dropMediaUrl(url){
    if(typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function resetWorkspace(){
    closeNodePopup();
    closeImagePreview();
    for(const url of Object.values(previewImageUrls)) dropMediaUrl(url);
    for(const node of miniTestNodes) dropMediaUrl(node.url);
    previewImageUrls = Object.create(null);
    previewValues = Object.create(null);
    previewRandomActive = Object.create(null);
    runResult = null;
    finishGraphDrag();
    Object.assign(graphCamera, { x: 0, y: 0, scale: 1 });
    graphNeedsFit = true;
    finishTestDrag();
    testSizeObserver.disconnect();
    Object.assign(testCamera, { x: 0, y: 0, scale: 1 });
    miniTestNodes = createInitialTrialCards();
}

function clearWorkflow(){
    resetWorkspace();
    selectedName = '';
    currentWorkflow = null;
    currentConfig = null;
    isBuiltin = false;
    renderList();
    renderEditor();
    renderPreview();
}

async function selectWorkflow(name){
    if(!name) return;
    const version = ++selectionVersion;
    selectedRequest?.abort();
    const controller = new AbortController();
    selectedRequest = controller;
    setStatus(tr('comfy.loading'));
    try {
        const data = await settingsRequest(workflowPath(name), { signal: controller.signal, fallback: tr('comfy.openFailed') });
        if(version !== selectionVersion) return;
        if(!isRecord(data.workflow)) throw new Error(tr('comfy.openFailed'));
        resetWorkspace();
        const config = isRecord(data.config) ? data.config : {};
        selectedName = name;
        currentWorkflow = data.workflow;
        isBuiltin = Boolean(data.builtin);
        const miniCards = { ...savedCardDefaults, ...(isRecord(config.mini_cards) ? config.mini_cards : {}) };
        currentConfig = { ...config, title: config.title || name.replace(/\.json$/i, ''),
            fields: workflowItems(config.fields), mini_cards: miniCards };
        for(const field of currentConfig.fields){
            if(field.default != null) previewValues[field.id] = field.default;
        }
        renderList();
        renderEditor();
        renderPreview();
        setStatus('');
    } catch(error) {
        if(version === selectionVersion && error.name !== 'AbortError') setStatus(tr('comfy.openFailed') + ' · ' + error.message);
    } finally {
        if(selectedRequest === controller) selectedRequest = null;
    }
}

function fieldFor(node, input){
    return currentConfig.fields.find(f => String(f.node) === node && f.input === input);
}
const mediaInputPatterns = [
    ['video', /video|movie|mp4|webm|mov|m4v|vhs/i, /\.(mp4|webm|mov|m4v|avi|mkv)$/i],
    ['audio', /audio|sound|music|voice|wav|mp3/i, /\.(mp3|wav|m4a|aac|ogg|flac)$/i],
    ['image', /image|img|mask|filename|file/i, /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i],
];

function inferInputType(name, value){
    switch(typeof value){
        case 'boolean':
            return 'boolean';
        case 'number':
            return /strength|cfg|denoise/i.test(name) ? 'slider' : 'number';
        case 'string': {
            if(/prompt|text|description/i.test(name)) return 'textarea';
            const filename = value.split(/[?#]/, 1)[0].trim();
            for(const [kind, keyPattern, extension] of mediaInputPatterns){
                if(keyPattern.test(name) || extension.test(filename)) return kind;
            }
            return value.length > 60 ? 'textarea' : 'text';
        }
        default:
            return 'text';
    }
}

function exposeInput(node, input, value){
    const type = inferInputType(input, value);
    const entropy = crypto.getRandomValues(new Uint32Array(2));
    const field = {
        id: 'f_' + entropy[0].toString(36) + '_' + entropy[1].toString(36),
        node, input, type, name: inputLabel(input), options: [],
        default: value == null || typeof value === 'object' ? null : value,
    };
    if(typeof value === 'number'){
        Object.assign(field, { min: 0, max: Math.max(10, value * 2), step: value > 0 && value < 5 ? 0.1 : 1 });
    }
    if(type === 'number') field.random_enabled = false;
    currentConfig.fields.push(field);
    if(field.default !== null) previewValues[field.id] = field.default;
}

function toggleField(node, input){
    const inputs = currentWorkflow?.[node]?.inputs;
    if(!inputs || !Object.hasOwn(inputs, input)) return;
    const field = fieldFor(node, input);
    if(field){
        currentConfig.fields.splice(currentConfig.fields.indexOf(field), 1);
        dropMediaUrl(previewImageUrls[field.id]);
        for(const map of [previewValues, previewRandomActive, previewImageUrls]) delete map[field.id];
    } else {
        exposeInput(node, input, inputs[input]);
    }
    renderEditor();
    renderPreview();
}

function updateWorkflowTitle(value){
    const config = currentConfig;
    if(!config) return;
    config.title = value;
    const name = value || selectedName.replace(/\.json$/i, '');
    const entry = workflows.find(({ name }) => name === selectedName);
    if(entry) entry.title = name;
    const active = listEl.querySelector('.workflow-card.active');
    if(active?.dataset.workflowName === selectedName){
        active.querySelector('.workflow-name').textContent = name;
        active.setAttribute('aria-label', name);
    }
    const trialTitle = miniCanvasHost.querySelector('.comfy-card .mini-node-title');
    if(trialTitle) trialTitle.textContent = name + ' · ' + tr('canvas.comfyCustom');
}

const graphCard = document.getElementById('graphCard');
const graphSvg = document.getElementById('graphSvg');
const graphShell = graphSvg.parentElement;
const nodePopup = document.getElementById('nodePopup');
const popupBackdrop = document.getElementById('popupBackdrop');
const nodesToggle = document.getElementById('nodesToggle');
const graphCamera = { x: 0, y: 0, scale: 1 };
const cameraMath = window.XiaomeiViewportKernel;
const nodeSize = { w: 130, h: 50 };
const graphOrder = new Intl.Collator(undefined, { numeric: true });
const svgNS = 'http://www.w3.org/2000/svg';
let graphBounds = [];
let graphNeedsFit = true;
let graphDrag = null;
let popupNodeId = null;
let graphNodes = new Map();

function workflowInputSource(value){
    if(!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[1])) return null;
    const source = value[0];
    return typeof source === 'string' || typeof source === 'number' ? String(source) : null;
}

function editableInputs(node){
    return Object.entries(node?.inputs || {}).filter(([, value]) => workflowInputSource(value) === null);
}

function layoutWorkflow(entries){
    const steps = new Map(entries.map(([id]) => [id, { upstream: 0, column: 0, dependents: [], resolved: false }]));
    const edges = [];
    for(const [id, node] of entries){
        const upstream = new Set(Object.values(node?.inputs || {}).map(workflowInputSource));
        for(const source of upstream){
            if(!steps.has(source)) continue;
            steps.get(id).upstream += 1;
            steps.get(source).dependents.push(id);
            edges.push([source, id]);
        }
    }
    const ready = [...steps].filter(([, step]) => step.upstream === 0).map(([id]) => id);
    for(let index = 0; index < ready.length; index += 1){
        const step = steps.get(ready[index]);
        step.resolved = true;
        for(const childId of step.dependents){
            const child = steps.get(childId);
            child.column = Math.max(child.column, step.column + 1);
            child.upstream -= 1;
            if(child.upstream === 0) ready.push(childId);
        }
    }
    const rows = new Map();
    let rowCount = 0;
    const locations = new Map();
    for(const [id, step] of steps){
        const column = step.resolved ? step.column : 0;
        const row = rows.get(column) || 0;
        rows.set(column, row + 1);
        rowCount = Math.max(rowCount, row + 1);
        locations.set(id, { x: 16 + column * 166, y: 16 + row * 64 });
    }
    return { locations, edges, columns: rows.size, rows: rowCount };
}

function svgElement(tag, attributes = {}, label){
    const element = document.createElementNS(svgNS, tag);
    for(const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if(label !== undefined) element.textContent = label;
    return element;
}

function compactLabel(label, limit){
    const characters = Array.from(label);
    return characters.length > limit ? characters.slice(0, limit).join('') + '…' : label;
}

function renderGraph(entries, fieldCounts){
    const { locations, edges, columns, rows } = layoutWorkflow(entries);
    const viewport = svgElement('g', { id: 'graphViewport' });
    for(const [source, destination] of edges){
        const from = locations.get(source);
        const to = locations.get(destination);
        const x = from.x + nodeSize.w;
        const y = from.y + nodeSize.h / 2;
        const endY = to.y + nodeSize.h / 2;
        const midX = (x + to.x) / 2;
        viewport.append(svgElement('path', {
            class: 'gedge',
            d: 'M' + x + ' ' + y + ' C' + midX + ' ' + y + ' ' + midX + ' ' + endY + ' ' + to.x + ' ' + endY,
        }));
    }
    graphNodes = new Map();
    for(const [id, node] of entries){
        const point = locations.get(id);
        const { title: label, category, icon } = nodePresentation(node);
        const count = fieldCounts.get(id) || 0;
        const item = svgElement('g', {
            class: 'gnode cat-' + category,
            'data-node-id': id, role: 'button', tabindex: '0',
            'aria-label': label + ' #' + id, 'aria-expanded': String(id === popupNodeId),
            transform: 'translate(' + point.x + ',' + point.y + ')',
        });
        item.classList.toggle('has-exposed', count > 0);
        item.classList.toggle('is-active', id === popupNodeId);
        item.append(
            svgElement('rect', { width: nodeSize.w, height: nodeSize.h, rx: 8 }),
            svgElement('text', { class: 'gn-icon', x: 10, y: 20, 'font-size': 14 }, icon),
            svgElement('text', { class: 'gn-title', x: 28, y: 20 }, compactLabel(label, 12)),
            svgElement('text', { class: 'gn-sub', x: 28, y: 35 }, compactLabel(node.class_type || '', 16)),
            svgElement('text', { class: 'gn-sub', x: 122, y: 20, 'text-anchor': 'end' }, '#' + id),
        );
        if(count) item.append(svgElement('text', { class: 'gbadge', x: 122, y: 42, 'text-anchor': 'end' },
            tf('comfy.usedCount', { count })));
        graphNodes.set(id, item);
        viewport.append(item);
    }
    graphBounds = entries.length ? [{ x: 0, y: 0, w: columns * 166 + 16, h: rows * 64 + 16 }] : [];
    graphSvg.replaceChildren(viewport);
    updateGraphCamera();
}

function updateGraphCamera(){
    const { x, y, scale } = graphCamera;
    graphSvg.firstElementChild?.setAttribute('transform', 'translate(' + x + ',' + y + ') scale(' + scale + ')');
    document.getElementById('zoomPill').textContent = Math.round(scale * 100) + '%';
    if(popupNodeId !== null) placeNodePopup();
}

function resizeGraph(){
    const width = graphSvg.clientWidth;
    const height = graphSvg.clientHeight;
    if(width && height) graphSvg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    if(popupNodeId !== null) placeNodePopup();
}

function graphFit(){
    const { clientWidth: width, clientHeight: height } = graphSvg;
    if(!width || !height || !graphBounds.length) return;
    cameraMath.fitBoxes(graphCamera, { width, height }, graphBounds, {
        pad: 0, inset: 40, minZoom: 0.2, maxZoom: 2, allowEmpty: false,
    });
    graphNeedsFit = false;
    updateGraphCamera();
}

function surfacePoint(surface, { clientX, clientY }){
    const rect = surface.getBoundingClientRect();
    const horizontal = rect.width / (surface.offsetWidth || surface.clientWidth) || 1;
    const vertical = rect.height / (surface.offsetHeight || surface.clientHeight) || 1;
    return {
        x: (clientX - rect.left) / horizontal - surface.clientLeft,
        y: (clientY - rect.top) / vertical - surface.clientTop,
    };
}

function zoomAtPointer(camera, surface, event, scale){
    const point = surfacePoint(surface, event);
    cameraMath.zoomAboutClient(camera, { left: 0, top: 0 }, point.x, point.y, scale);
}

function adjustGraphZoom(factor, point){
    const scale = Math.max(0.2, Math.min(3, graphCamera.scale * factor));
    if(point){
        zoomAtPointer(graphCamera, graphSvg, point, scale);
    } else {
        cameraMath.zoomAboutCenter(graphCamera, { width: graphSvg.clientWidth, height: graphSvg.clientHeight }, scale);
    }
    updateGraphCamera();
}

function finishGraphDrag(){
    if(!graphDrag) return;
    const { pointer } = graphDrag;
    graphDrag = null;
    graphShell.classList.remove('is-panning');
    if(graphSvg.hasPointerCapture(pointer)) graphSvg.releasePointerCapture(pointer);
}

function placeNodePopup(){
    const anchor = graphNodes.get(popupNodeId);
    if(!anchor) return;
    const bounds = anchor.getBoundingClientRect();
    const width = graphShell.clientWidth;
    const height = graphShell.clientHeight;
    const maxHeight = Math.max(0, Math.min(height - 40, window.innerHeight * 0.7));
    nodePopup.style.maxHeight = maxHeight + 'px';
    const panelWidth = nodePopup.offsetWidth;
    const leftTop = surfacePoint(graphShell, { clientX: bounds.left, clientY: bounds.top });
    const right = surfacePoint(graphShell, { clientX: bounds.right, clientY: bounds.top }).x + 12;
    const preferred = right + panelWidth <= width - 8 ? right : leftTop.x - panelWidth - 12;
    nodePopup.style.left = Math.max(8, Math.min(preferred, width - panelWidth - 8)) + 'px';
    nodePopup.style.top = Math.max(8, Math.min(leftTop.y, height - maxHeight - 8)) + 'px';
}

function openNodePopup(id){
    const node = currentWorkflow?.[id];
    if(!node) return;
    closeNodePopup();
    popupNodeId = id;
    const anchor = graphNodes.get(id);
    anchor.classList.add('is-active');
    anchor.setAttribute('aria-expanded', 'true');
    nodePopup.hidden = false;
    popupBackdrop.hidden = false;
    refreshPopupBody();
    nodePopup.querySelector('.popup-close').focus({ preventScroll: true });
}

function refreshPopupBody(){
    if(popupNodeId === null) return;
    const node = currentWorkflow?.[popupNodeId];
    if(!node) return;
    const { title, detail, icon } = nodePresentation(node);
    nodePopup.querySelector('.popup-icon').textContent = icon;
    nodePopup.querySelector('.popup-title').textContent = title;
    nodePopup.querySelector('.popup-sub').textContent = detail + ' · #' + popupNodeId;
    const inputs = editableInputs(node);
    nodePopup.querySelector('.popup-body').innerHTML = inputs.length
        ? inputs.map(([key, value]) => renderInputRow(popupNodeId, key, value)).join('')
        : '<div class="popup-empty">' + escapeHtml(tr('comfy.noConfigFields')) + '</div>';
    placeNodePopup();
    refreshIcons();
}

function closeNodePopup(restoreFocus = false){
    const previous = graphNodes.get(popupNodeId);
    previous?.classList.remove('is-active');
    previous?.setAttribute('aria-expanded', 'false');
    popupNodeId = null;
    nodePopup.hidden = true;
    popupBackdrop.hidden = true;
    if(restoreFocus){
        previous?.focus({ preventScroll: true });
        if(!nodeListEl.classList.contains('hidden')) renderWorkflowNodeList();
    }
}

function syncNodeListToggle(){
    const hidden = nodeListEl.classList.contains('hidden');
    nodesToggle.setAttribute('aria-expanded', String(!hidden));
    const key = hidden ? 'comfy.showNodeList' : 'comfy.hideNodeList';
    const label = document.getElementById('nodesToggleText');
    label.dataset.i18n = key;
    label.textContent = tr(key);
}

function bindWorkflowGraph(){
    const observer = new ResizeObserver(resizeGraph);
    observer.observe(graphSvg);
    graphSvg.addEventListener('pointerdown', (event) => {
        if(event.button !== 0 || !event.isPrimary || event.target.closest('.gnode')) return;
        graphDrag = { pointer: event.pointerId, ...surfacePoint(graphSvg, event), originX: graphCamera.x, originY: graphCamera.y };
        graphSvg.setPointerCapture(event.pointerId);
        graphShell.classList.add('is-panning');
    });
    graphSvg.addEventListener('pointermove', (event) => {
        if(graphDrag?.pointer !== event.pointerId) return;
        const point = surfacePoint(graphSvg, event);
        cameraMath.dragCamera(graphCamera, graphDrag.originX, graphDrag.originY,
            point.x - graphDrag.x, point.y - graphDrag.y);
        updateGraphCamera();
    });
    for(const type of ['pointerup', 'pointercancel', 'lostpointercapture']){
        graphSvg.addEventListener(type, (event) => {
            if(graphDrag?.pointer === event.pointerId) finishGraphDrag();
        });
    }
    graphSvg.addEventListener('wheel', (event) => {
        event.preventDefault();
        if(event.deltaY) adjustGraphZoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event);
    }, { passive: false });
    graphSvg.addEventListener('click', (event) => {
        const node = event.target.closest('.gnode');
        if(node) openNodePopup(node.dataset.nodeId);
    });
    graphSvg.addEventListener('keydown', (event) => {
        const node = event.target.closest('.gnode');
        if(!node || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openNodePopup(node.dataset.nodeId);
    });
    document.getElementById('graphZoomOut').addEventListener('click', () => adjustGraphZoom(1 / 1.2));
    document.getElementById('graphZoomIn').addEventListener('click', () => adjustGraphZoom(1.2));
    document.getElementById('graphFit').addEventListener('click', graphFit);
    popupBackdrop.addEventListener('click', () => closeNodePopup(true));
    nodePopup.querySelector('.popup-close').addEventListener('click', () => closeNodePopup(true));
    nodesToggle.addEventListener('click', () => {
        if(!nodeListEl.classList.toggle('hidden')) renderWorkflowNodeList();
        syncNodeListToggle();
    });
    bindFieldEditor(nodePopup);
    bindFieldEditor(nodeListEl);
    nodeListEl.addEventListener('click', (event) => {
        const trigger = event.target.closest('.node-card-head');
        if(!trigger) return;
        const expanded = trigger.parentElement.classList.toggle('expanded');
        trigger.setAttribute('aria-expanded', String(expanded));
    });
    document.addEventListener('keydown', (event) => {
        if(event.key !== 'Escape') return;
        if(popupNodeId !== null) closeNodePopup(true);
        closeImagePreview();
    });
}

function renderNodeCard(id, node){
    const { title, detail, icon } = nodePresentation(node);
    const inputs = editableInputs(node);
    const count = inputs.filter(([key]) => fieldFor(id, key)).length;
    return '<section class="node-card' + (count ? ' expanded' : '') + '" data-node-id="' + escapeAttr(id) + '">' +
        '<button class="node-card-head" type="button" aria-expanded="' + Boolean(count) + '">' +
        '<span class="node-card-label"><span class="node-card-icon" aria-hidden="true">' + escapeHtml(icon) + '</span>' +
        '<span class="node-card-names"><span class="node-class">' + escapeHtml(title) + '</span>' +
        '<span class="node-id">' + escapeHtml(detail + ' · #' + id + ' · ' +
            tf('comfy.configurableCount', { count: inputs.length })) + '</span></span></span>' +
        '<span class="node-card-meta"><span class="node-stats">' + (count ? tf('comfy.exposedCount', { count }) : '') + '</span>' +
        '<i data-lucide="chevron-down" class="w-4 h-4 node-chev"></i></span></button>' +
        '<div class="node-inputs">' +
        (inputs.length ? inputs.map(([key, value]) => renderInputRow(id, key, value)).join('') :
            '<div class="node-inputs-empty">' + escapeHtml(tr('comfy.noConfigInputs')) + '</div>') +
        '</div></section>';
}

function sortedWorkflowNodes(){
    return Object.entries(currentWorkflow || {}).filter(([, node]) => isRecord(node))
        .sort(([a], [b]) => graphOrder.compare(a, b));
}

function renderWorkflowNodeList(entries = sortedWorkflowNodes()){
    nodeListEl.innerHTML = entries.map(([id, node]) => renderNodeCard(id, node)).join('');
    refreshIcons();
}

function renderEditor(){
    const entries = sortedWorkflowNodes();
    graphCard.hidden = !entries.length;
    if(!currentWorkflow){
        nodeListEl.replaceChildren();
        graphSvg.replaceChildren();
        graphNodes.clear();
        graphBounds = [];
        nodesToggle.hidden = true;
        miniCanvasHost.hidden = true;
        return;
    }
    deleteBtn.hidden = isBuiltin;
    const fields = currentConfig.fields;
    const counts = new Map();
    for(const field of fields){
        const id = String(field.node);
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    workflowTitleInput.value = currentConfig.title || selectedName.replace(/\.json$/i, '');
    const stats = tf('comfy.nodeStats', { nodes: entries.length, fields: fields.length });
    subEl.textContent = stats + (isBuiltin ? ' · ' + tr('comfy.builtin') : '');
    renderWorkflowNodeList(entries);
    renderGraph(entries, counts);
    renderWorkspaceView();
    syncNodeListToggle();
    if(popupNodeId !== null) refreshPopupBody();
    refreshIcons();
}

const editableNumberKeys = ['min', 'max', 'step', 'default'];

function sourceValueHtml(value){
    const kind = typeof value;
    if(kind === 'string') return '<span class="input-value-quote">"</span><strong>' +
        escapeHtml(compactLabel(value, 50)) + '</strong><span class="input-value-quote">"</span>';
    if(kind === 'number') return '<strong class="input-value-number">' + value + '</strong>';
    if(kind === 'boolean') return '<strong class="input-value-boolean ' + (value ? 'is-true">✓ true' : '">✗ false') + '</strong>';
    return '<span class="input-value-other">' + escapeHtml(String(value)) + '</span>';
}

function optionIsNumeric(value){
    return String(value).trim() !== '' && Number.isFinite(Number(value));
}

function fieldEditorExtras(field){
    if(field.type === 'dropdown'){
        const options = workflowItems(field.options).map((value, index) => {
            const numeric = optionIsNumeric(value);
            const label = escapeAttr(tf('comfy.optionIndex', { number: index + 1 }));
            return '<div class="dropdown-opt-row">' +
                '<span class="opt-index" aria-hidden="true">' + (index + 1) + '</span>' +
                '<input class="small-input" type="text" data-option-index="' + index + '" placeholder="' + label +
                '" aria-label="' + label + '" value="' + escapeAttr(value) + '">' +
                '<span class="opt-type-tag' + (numeric ? ' is-num' : '') + '">' + typeLabel(numeric ? 'number' : 'text') + '</span>' +
                '<button class="opt-del" type="button" data-remove-option="' + index + '" title="' + tr('common.delete') +
                '"><i data-lucide="x" class="w-3 h-3"></i></button></div>';
        }).join('');
        return '<div class="extras-row field-option-editor"><div class="field-option-heading">' +
            tr('comfy.dropdownHeading') + ' <span>· ' + tr('comfy.numericOptionHint') + '</span></div>' + options +
            '<button class="ghost-btn field-option-add" type="button" data-add-option>' +
            '<i data-lucide="plus" class="w-3.5 h-3.5"></i><span>' + tr('comfy.addOption') + '</span></button></div>';
    }
    if(field.type !== 'slider' && field.type !== 'number') return '';
    const numbers = editableNumberKeys.map((key) => '<label class="extra-pair">' +
        (key === 'default' ? tr('comfy.defaultValue') : key) +
        '<input class="small-input" type="number" step="any" data-field-key="' + key +
        '" value="' + escapeAttr(field[key] ?? '') + '"></label>').join('');
    const random = field.type === 'number'
        ? '<label class="random-toggle"><input type="checkbox" data-field-key="random_enabled"' +
            (field.random_enabled === true ? ' checked' : '') + '>' + tr('comfy.randomNumber') + '</label>'
        : '';
    return '<div class="extras-row">' + numbers + random + '</div>';
}

function renderInputRow(nodeId, inputKey, rawValue){
    const field = fieldFor(nodeId, inputKey);
    const label = inputLabel(inputKey);
    const extras = field ? fieldEditorExtras(field) : '';
    const kinds = fieldTypes.map((v) => '<option value="' + v + '"' +
        (v === field?.type ? ' selected' : '') + '>' + typeLabel(v) + '</option>').join('');
    const identity = ' data-node-id="' + escapeAttr(nodeId) + '" data-input-key="' + escapeAttr(inputKey) + '"';
    const displayName = tr('comfy.displayName');
    const enabled = Boolean(field);
    return '<div class="input-row' + (enabled ? ' is-active' : '') + (extras ? ' has-extras' : '') + '"' + identity + '>' +
        '<button type="button" class="check-toggle' + (enabled ? ' checked' : '') + '" aria-label="' + escapeAttr(label) +
        '" aria-pressed="' + enabled + '">' + (enabled ? '<i data-lucide="check" class="w-3 h-3"></i>' : '') + '</button>' +
        '<div class="input-info"><div class="input-key">' + escapeHtml(label) +
        (label === inputKey ? '' : ' <span class="input-source-key">' + escapeHtml(inputKey) + '</span>') +
        '</div><div class="input-orig">' + tr('comfy.defaultValue') + sourceValueHtml(rawValue) + '</div></div>' +
        '<input class="small-input" type="text" data-field-key="name" placeholder="' + escapeAttr(displayName) +
        '" aria-label="' + escapeAttr(displayName) + '" value="' + escapeAttr(field?.name ?? label) + '"' + (enabled ? '' : ' disabled') + '>' +
        '<select class="small-select" data-field-key="type" aria-label="' + escapeAttr(tr('comfy.fieldType')) + '"' +
        (enabled ? '' : ' disabled') + '>' + kinds + '</select>' + extras + '</div>';
}

function fieldRowSelector(node, input){
    return '.input-row[data-node-id="' + CSS.escape(node) + '"][data-input-key="' + CSS.escape(input) + '"]';
}

function repaintFieldRows(field, origin, focusTarget){
    const { node, input } = field;
    const selector = fieldRowSelector(node, input);
    const markup = renderInputRow(String(node), input, currentWorkflow?.[node]?.inputs?.[input]);
    for(const root of [nodePopup, nodeListEl]){
        const row = root.querySelector(selector);
        if(!row) continue;
        const focused = row.contains(document.activeElement) && root === origin;
        row.outerHTML = markup;
        if(focused && focusTarget) root.querySelector(selector)?.querySelector(focusTarget)?.focus({ preventScroll: true });
    }
    refreshIcons();
}

function syncDropdownChoice(field, previous){
    if(field.type !== 'dropdown') return;
    const options = workflowItems(field.options);
    const current = previewValues[field.id];
    const selected = options.find((option) => String(option) === String(current));
    if(selected !== undefined) return;
    if(previous !== undefined && current !== undefined && String(current) === String(previous) && options.length) previewValues[field.id] = options[0];
    else if(current !== undefined && !options.length) delete previewValues[field.id];
}

function changeFieldSetting(field, key, value, root){
    const previous = field[key];
    if(Object.is(previous, value)) return;
    field[key] = value;
    if(key === 'type'){
        dropMediaUrl(previewImageUrls[field.id]);
        delete previewImageUrls[field.id];
        delete previewRandomActive[field.id];
        previewValues[field.id] = field.type === 'boolean' ? false :
            (field.type === 'number' || field.type === 'slider' ? 0 : '');
        if(field.type !== 'number') field.random_enabled = false;
        repaintFieldRows(field, root, '[data-field-key="type"]');
    } else {
        if(key === 'random_enabled') delete previewRandomActive[field.id];
        if(key === 'default' && (previewValues[field.id] === undefined || previewValues[field.id] === previous)){
            if(value == null) delete previewValues[field.id];
            else previewValues[field.id] = value;
        }
        const selector = fieldRowSelector(field.node, field.input) + ' [data-field-key="' + key + '"]';
        const other = (root === nodePopup ? nodeListEl : nodePopup).querySelector(selector);
        if(other?.type === 'checkbox') other.checked = value;
        else if(other) other.value = value ?? '';
    }
    renderTrialViews();
}

function bindFieldEditor(root){
    root.addEventListener('click', (event) => {
        const action = event.target.closest('.check-toggle, [data-add-option], [data-remove-option]');
        const row = action?.closest('.input-row');
        if(!row) return;
        const { nodeId, inputKey } = row.dataset;
        if(action.classList.contains('check-toggle')){
            const focused = document.activeElement === action;
            toggleField(nodeId, inputKey);
            if(focused) root.querySelector(fieldRowSelector(nodeId, inputKey))?.querySelector('.check-toggle')?.focus({ preventScroll: true });
            return;
        }
        const field = fieldFor(nodeId, inputKey);
        if(field?.type !== 'dropdown') return;
        const options = [...workflowItems(field.options)];
        const add = action.hasAttribute('data-add-option');
        const previous = add ? undefined : options.splice(Number(action.dataset.removeOption), 1)[0];
        if(add) options.push('');
        field.options = options;
        syncDropdownChoice(field, previous);
        repaintFieldRows(field, root, add ? '[data-option-index="' + (options.length - 1) + '"]' : '[data-add-option]');
        renderTrialViews();
    });
    root.addEventListener('input', (event) => {
        const control = event.target;
        const row = control.closest('.input-row');
        if(!row || control.tagName !== 'INPUT' || control.type === 'checkbox') return;
        const field = fieldFor(row.dataset.nodeId, row.dataset.inputKey);
        if(!field) return;
        const { fieldKey, optionIndex } = control.dataset;
        if(optionIndex !== undefined){
            const index = Number(optionIndex);
            const previous = field.options[index];
            field.options[index] = control.value;
            if(previewValues[field.id] !== undefined && String(previous) === String(previewValues[field.id])){
                previewValues[field.id] = control.value;
            }
            const numeric = optionIsNumeric(control.value);
            const other = (root === nodePopup ? nodeListEl : nodePopup).querySelector(
                fieldRowSelector(field.node, field.input) + ' [data-option-index="' + index + '"]');
            if(other) other.value = control.value;
            for(const editor of [control, other].filter(Boolean)){
                const tag = editor.nextElementSibling;
                tag.classList.toggle('is-num', numeric);
                tag.textContent = typeLabel(numeric ? 'number' : 'text');
            }
            renderTrialViews();
        } else if(fieldKey === 'name'){
            changeFieldSetting(field, fieldKey, control.value, root);
        } else if(editableNumberKeys.includes(fieldKey) && !control.validity.badInput){
            changeFieldSetting(field, fieldKey, Number.isFinite(control.valueAsNumber) ? control.valueAsNumber : null, root);
        }
    });
    root.addEventListener('change', (event) => {
        const control = event.target;
        const row = control.closest('.input-row');
        if(!row) return;
        const field = fieldFor(row.dataset.nodeId, row.dataset.inputKey);
        if(!field) return;
        if(control.dataset.fieldKey === 'type') changeFieldSetting(field, 'type', control.value, root);
        if(control.dataset.fieldKey === 'random_enabled') changeFieldSetting(field, 'random_enabled', control.checked, root);
    });
}

function fieldSupportsRandom(field){
    return field?.type === 'number' && field.random_enabled === true;
}

function isPreviewRandomActive(id){
    return previewRandomActive[id] !== false;
}

function sampleTrialNumber(field){
    const seed = /seed|noise|随机|噪/i.test([field.input, field.name].join(' '));
    const explicitMin = field.min == null ? NaN : Number(field.min);
    const min = Number.isFinite(explicitMin) ? explicitMin : seed ? 1 : 0;
    const explicitMax = Number(field.max);
    const max = explicitMax > min && Number.isFinite(explicitMax) ? explicitMax : seed ? 1e15 : 999999;
    if(max <= min) return min;
    const sample = min + (max - min) * Math.random();
    const step = Number(field.step);
    if(!(step > 0 && step < 1)) return Math.max(Math.ceil(min), Math.floor(sample));
    const places = Math.min(8, Math.max(1, String(step).split('.')[1]?.length || 2));
    return Math.max(min, Math.min(max, Number(sample.toFixed(places))));
}

function applyActiveRandomValues(values){
    const fields = Object.assign(Object.create(null), values);
    for(const field of currentConfig.fields){
        if(!fieldSupportsRandom(field) || !isPreviewRandomActive(field.id)) continue;
        const value = sampleTrialNumber(field);
        fields[field.id] = value;
        writeTrialValue(field, value);
    }
    return fields;
}

const imageDialog = document.getElementById('imageLightbox');
const enlargedImage = document.getElementById('imageLightboxImg');

function openImagePreview(url){
    if(!url) return;
    enlargedImage.src = url;
    if(!imageDialog.open) imageDialog.showModal();
}

function closeImagePreview(){
    if(imageDialog.open) imageDialog.close();
}

function bindSettingsPage(){
    document.getElementById('addComfyInstanceBtn').addEventListener('click', addComfyInstance);
    document.getElementById('saveComfyInstancesBtn').addEventListener('click', saveComfyInstances);
    const upload = document.getElementById('uploadInput');
    document.getElementById('chooseWorkflowBtn').addEventListener('click', () => upload.click());
    upload.addEventListener('change', onUpload);
    workflowTitleInput.addEventListener('input', () => updateWorkflowTitle(workflowTitleInput.value));
    deleteBtn.addEventListener('click', onDelete);
    saveBtn.addEventListener('click', onSave);
    document.getElementById('workspaceGraphTab').addEventListener('click', () => setWorkspaceMode('graph'));
    document.getElementById('workspaceCanvasTab').addEventListener('click', () => setWorkspaceMode('canvas'));
    imageDialog.addEventListener('click', (event) => {
        if(event.target === imageDialog) closeImagePreview();
    });
    imageDialog.addEventListener('close', () => {
        if(!imageDialog.open) enlargedImage.removeAttribute('src');
    });
}

function renderTrialResult(compact){
    if(!runResult) return '';
    return '<div class="' + (compact ? 'mini-result' : 'run-result') + '">' +
        '<img src="' + escapeAttr(runResult) + '" alt="' + escapeAttr(tr('comfy.output')) + '" role="button" tabindex="0" data-trial-result>' +
        '<div class="run-status">' + tr('comfy.runSuccess') + '</div></div>';
}

function renderRunButton(compact){
    return '<button class="run-btn' + (compact ? ' mini-run' : '') + '" type="button" data-trial-run>' +
        '<i data-lucide="play" class="w-4 h-4"></i><span>' + tr('comfy.runTest') + '</span></button>';
}

function renderPreview(){
    const fields = currentConfig?.fields || [];
    previewCard.innerHTML = fields.length ?
        fields.map((field) => renderTrialField(field)).join('') + renderRunButton(false) + renderTrialResult(false) :
        '<div class="preview-empty">' + tr('comfy.previewEmpty') + '</div>';
    refreshIcons();
    syncWorkflowActions();
}

function renderTrialViews(){
    renderPreview();
    if(workspaceMode === 'canvas') renderTestCanvas();
}

function trialRowSelector(fieldId){
    return '.pfield[data-trial-field="' + CSS.escape(fieldId) + '"]';
}

function trialFieldValue(field){
    const value = previewValues[field.id] ?? field.default;
    if(field.type === 'number' || field.type === 'slider') return Number.isFinite(Number(value)) ? Number(value) : 0;
    if(field.type === 'boolean') return value === true;
    return value ?? '';
}

function renderTrialField(field, compact = false){
    const label = field.name || field.input;
    const title = escapeAttr(label);
    const value = trialFieldValue(field);
    const inputClass = compact ? 'mini-input' : 'pfield-input';
    let control;
    if(isMediaField(field)){
        const url = previewImageUrls[field.id] || (typeof value === 'string' && /^(\/|https?:|blob:|data:)/.test(value) ? value : '');
        const className = compact ? 'mini-image-drop' : 'pfield-image-drop' + (url ? ' has-image' : '');
        control = '<div class="' + className + '" role="button" tabindex="0" aria-label="' +
            escapeAttr(mediaUploadText(fieldKind(field))) + '" data-trial-action="media">' +
            mediaPreviewHtml(fieldKind(field), url, value, compact) + '</div>';
    } else if(field.type === 'textarea'){
        control = '<textarea class="' + (compact ? 'mini-textarea' : 'pfield-textarea') +
            '" aria-label="' + title + '" data-trial-value>' + escapeHtml(value) + '</textarea>';
    } else if(field.type === 'slider'){
        control = '<div class="pfield-random-row trial-single-control"><div class="pfield-slider">' +
            '<input type="range" aria-label="' + title + '" data-trial-value min="' + escapeAttr(field.min ?? 0) +
            '" max="' + escapeAttr(field.max ?? 10) + '" step="' + escapeAttr(field.step ?? 1) +
            '" value="' + escapeAttr(value) + '"><span class="pfield-slider-val">' + escapeHtml(value) + '</span></div></div>';
    } else if(field.type === 'dropdown'){
        const options = workflowItems(field.options).map((option) => '<option value="' + escapeAttr(option) + '"' +
            (String(option) === String(value) ? ' selected' : '') + '>' + escapeHtml(option) + '</option>').join('');
        control = '<select class="pfield-select" aria-label="' + title + '" data-trial-value>' +
            (options || '<option value="">' + tr('comfy.noOptions') + '</option>') + '</select>';
    } else if(field.type === 'boolean'){
        control = '<div class="pfield-bool"><button type="button" class="pfield-bool-track' +
            (value ? ' on' : '') + '" data-trial-action="boolean" role="switch" aria-label="' + title +
            '" aria-checked="' + value + '"><span class="pfield-bool-thumb"></span></button></div>';
    } else {
        const numeric = field.type === 'number';
        control = '<input class="' + inputClass + '" type="' + (numeric ? 'number' : 'text') + '" aria-label="' +
            title + '" data-trial-value value="' + escapeAttr(value) + '"' + (numeric ? ' step="any"' : '') + '>';
        if(numeric){
            const random = fieldSupportsRandom(field) ? renderTrialRandom(field) : '';
            control = '<div class="pfield-random-row' + (random ? '' : ' trial-single-control') + '">' + control + random + '</div>';
        }
    }
    return '<div class="pfield" data-trial-field="' + escapeAttr(field.id) + '"><div class="pfield-label">' +
        escapeHtml(label) + '</div>' + control + '</div>';
}

function renderTrialRandom(field){
    const active = isPreviewRandomActive(field.id);
    const title = tr(active ? 'comfy.randomDisable' : 'comfy.randomEnable');
    return '<button class="random-btn' + (active ? ' active' : '') + '" type="button" data-trial-action="random" title="' +
        escapeAttr(title) + '" aria-pressed="' + active + '"><i data-lucide="dice-5" class="w-4 h-4"></i></button>';
}

function trialControls(fieldId){
    return [previewCard, miniCanvasHost].map((root) => root.querySelector(trialRowSelector(fieldId))).filter(Boolean);
}

function writeTrialValue(field, value, source){
    previewValues[field.id] = value;
    for(const row of trialControls(field.id)){
        const input = row.querySelector('[data-trial-value]');
        if(input && input !== source) input.value = value;
        const display = row.querySelector('.pfield-slider-val');
        if(display) display.textContent = input?.value ?? value;
        const toggle = row.querySelector('[data-trial-action="boolean"]');
        if(toggle){
            toggle.classList.toggle('on', value === true);
            toggle.setAttribute('aria-checked', String(value === true));
        }
    }
}

function bindTrialControls(root){
    const fieldForControl = (control) => currentConfig?.fields.find((field) =>
        field.id === control.closest('[data-trial-field]')?.dataset.trialField);
    root.addEventListener('input', (event) => {
        const input = event.target;
        if(!input.hasAttribute('data-trial-value') || input.validity?.badInput) return;
        const field = fieldForControl(input);
        if(!field) return;
        const numeric = input.type === 'number' || input.type === 'range';
        writeTrialValue(field, numeric ? (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0) : input.value, input);
    });
    function performTrialAction(control){
        const field = fieldForControl(control);
        if(!field) return;
        switch(control.dataset.trialAction){
            case 'media':
                pickImage(field.id);
                break;
            case 'boolean':
                writeTrialValue(field, trialFieldValue(field) !== true);
                break;
            case 'random': {
                const enabled = !isPreviewRandomActive(field.id);
                previewRandomActive[field.id] = enabled;
                for(const row of trialControls(field.id)){
                    const button = row.querySelector('[data-trial-action="random"]');
                    if(!button) continue;
                    button.classList.toggle('active', enabled);
                    button.setAttribute('aria-pressed', String(enabled));
                    button.title = tr(enabled ? 'comfy.randomDisable' : 'comfy.randomEnable');
                }
                break;
            }
        }
    }
    root.addEventListener('click', (event) => {
        if(event.target.closest('[data-trial-run]')){
            onRun();
            return;
        }
        const image = event.target.closest('[data-trial-result]');
        if(image){
            openImagePreview(image.src);
            return;
        }
        const action = event.target.closest('[data-trial-action]');
        if(action && !event.target.closest('video, audio')) performTrialAction(action);
    });
    root.addEventListener('keydown', (event) => {
        if(event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target;
        if(target.hasAttribute('data-trial-result')){
            event.preventDefault();
            openImagePreview(target.src);
        } else if(target.dataset.trialAction === 'media'){
            event.preventDefault();
            performTrialAction(target);
        }
    });
}


const testMediaKinds = Object.keys(mediaTypes);
const testIcons = { prompt: 'text-cursor-input', image: 'image-plus', video: 'file-video', audio: 'file-audio' };
const testCamera = { x: 0, y: 0, scale: 1 };
const testSizeObserver = new ResizeObserver(drawTestConnections);
let testDrag = null;

function setWorkspaceMode(mode){
    closeNodePopup();
    workspaceMode = mode === 'canvas' ? 'canvas' : 'graph';
    renderWorkspaceView();
}

function renderWorkspaceView(){
    const showGraph = workspaceMode === 'graph';
    for(const [id, selected] of [['workspaceGraphTab', showGraph], ['workspaceCanvasTab', !showGraph]]){
        const button = document.getElementById(id);
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    }
    graphShell.hidden = !showGraph;
    nodesToggle.hidden = !currentWorkflow || !showGraph;
    if(currentWorkflow && !showGraph){
        renderTestCanvas();
    } else {
        finishTestDrag();
        testSizeObserver.disconnect();
        miniCanvasHost.hidden = true;
        if(currentWorkflow){
            resizeGraph();
            if(graphNeedsFit) graphFit();
        }
    }
    syncWorkflowActions();
}

function testToolLabel(kind){
    if(kind === 'prompt') return tr('comfy.addPrompt');
    if(kind === 'image') return tr('comfy.addImage');
    return typeLabel(kind);
}

function testIcon(name, size = 'w-3.5 h-3.5'){
    return '<i data-lucide="' + name + '" class="' + size + '" aria-hidden="true"></i>';
}

function testInputBody(node){
    if(node.type === 'prompt'){
        const hint = escapeAttr(tr('comfy.promptPlaceholder'));
        return '<textarea class="mini-textarea" placeholder="' + hint + '" aria-label="' + hint +
            '" data-test-text>' + escapeHtml(node.text) + '</textarea>';
    }
    const label = escapeAttr(mediaUploadText(node.type));
    return '<div class="mini-image-drop" role="button" tabindex="0" aria-label="' + label +
        '" data-test-media>' + mediaPreviewHtml(node.type, node.url, node.name || node.value, true) + '</div>';
}

function testWorkflowBody(){
    const counts = { prompt: 0, image: 0, video: 0, audio: 0 };
    const settings = [];
    for(const field of currentConfig.fields){
        const kind = fieldKind(field);
        if(Object.hasOwn(counts, kind)) counts[kind] += 1;
        else settings.push(field);
    }
    const summary = testMediaKinds.map((kind) => mediaFieldLabel(kind, counts[kind]));
    summary.push(tr(counts.prompt ? 'comfy.acceptsPrompt' : 'comfy.noPromptField'));
    const controls = settings.length
        ? settings.map((field) => renderTrialField(field, true)).join('')
        : '<div class="preview-empty test-empty-settings">' + tr('comfy.otherParamsHere') + '</div>';
    return '<div class="test-input-heading">' + tr('comfy.inputs') + '</div>' +
        '<div class="preview-empty test-input-summary">' + summary.join(' · ') + '</div>' +
        '<div class="mini-settings-list">' + controls + '</div>' + renderRunButton(true);
}

function testCard(node, count){
    const workflow = node.type === 'comfy';
    const output = node.type === 'output';
    const source = !workflow && !output;
    const title = workflow ? (currentConfig.title || selectedName.replace(/\.json$/i, '')) + ' · ' + tr('canvas.comfyCustom')
        : output ? tr('comfy.output')
        : (node.type === 'prompt' ? tr('comfy.promptNode') : typeLabel(node.type)) + ' ' + count;
    const symbol = workflow ? 'workflow' : output ? 'circle-dot' : node.type === 'image' ? 'image' : testIcons[node.type];
    const body = workflow ? testWorkflowBody() : output ?
        renderTrialResult(true) || '<div class="preview-empty test-empty-output">' + tr('comfy.resultHere') + '</div>' :
        testInputBody(node);
    const remove = source ? '<button class="mini-delete" type="button" data-test-remove title="' +
        escapeAttr(tr('common.delete')) + '">' + testIcon('x', 'w-3 h-3') + '</button>' : '';
    return '<section class="mini-card' + (workflow ? ' comfy-card' : '') + '" data-node="' + node.id +
        '" style="left:' + node.x + 'px;top:' + node.y + 'px">' +
        (!source ? '<span class="mini-port in"></span>' : '') + (!output ? '<span class="mini-port out"></span>' : '') +
        '<header class="mini-card-head">' + testIcon(symbol) + '<span class="mini-node-title">' + escapeHtml(title) +
        '</span>' + remove + '</header><div class="mini-card-body">' + body + '</div></section>';
}

function renderTestCanvas(){
    finishTestDrag();
    testSizeObserver.disconnect();
    const numbering = new Map();
    const ordered = ['prompt', ...testMediaKinds, 'comfy', 'output'].flatMap((type) =>
        miniTestNodes.filter((node) => node.type === type));
    const cards = ordered.map((node) => {
        const count = (numbering.get(node.type) || 0) + 1;
        numbering.set(node.type, count);
        return testCard(node, count);
    }).join('');
    const tools = ['prompt', ...testMediaKinds].map((kind) =>
        '<button class="mini-tool" type="button" data-test-add="' + kind + '">' +
        testIcon(testIcons[kind]) + testToolLabel(kind) + '</button>').join('');
    miniCanvasHost.hidden = false;
    miniCanvasHost.innerHTML = '<div id="miniCanvas" class="mini-canvas large"><div class="mini-toolbar">' +
        tools + '</div><div id="miniWorld" class="mini-world"><div class="test-connections" aria-hidden="true"></div>' + cards + '</div></div>';
    updateTestCamera();
    for(const card of miniCanvasHost.querySelectorAll('.mini-card')) testSizeObserver.observe(card);
    drawTestConnections();
    syncWorkflowActions();
    refreshIcons();
}

function drawTestConnections(){
    const lines = miniCanvasHost.querySelector('.test-connections');
    if(!lines || !miniCanvasHost.clientWidth) return;
    const core = miniTestNodes.find((node) => node.type === 'comfy');
    const output = miniTestNodes.find((node) => node.type === 'output');
    if(!core || !output) return;
    const cards = new Map([...miniCanvasHost.querySelectorAll('.mini-card')].map((card) => [card.dataset.node, card]));
    const pairs = miniTestNodes.filter((node) => node !== core && node !== output).map((node) => [node, core]);
    pairs.push([core, output]);
    lines.replaceChildren(...pairs.map(([from, to]) => {
        const source = cards.get(from.id);
        const destination = cards.get(to.id);
        const x = from.x + source.offsetWidth;
        const y = from.y + source.offsetHeight / 2;
        const dx = to.x - x;
        const dy = to.y + destination.offsetHeight / 2 - y;
        const line = document.createElement('span');
        line.className = 'mini-line';
        line.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + Math.hypot(dx, dy) +
            'px;transform:rotate(' + Math.atan2(dy, dx) + 'rad)';
        return line;
    }));
}

function updateTestCamera(){
    const world = miniCanvasHost.querySelector('#miniWorld');
    if(!world) return;
    const { x, y, scale } = testCamera;
    world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
}

function createTestInput(kind){
    const count = miniTestNodes.filter((node) => node.type === kind).length;
    const id = kind + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    miniTestNodes.push({ id, type: kind, x: 42 + 26 * count,
        y: (kind === 'prompt' ? 86 : 286) + 170 * count, text: '', url: '', value: '' });
    renderTestCanvas();
}

function chooseTestMedia(node){
    const config = currentConfig;
    const name = selectedName;
    if(!config || !testMediaKinds.includes(node.type)) return;
    chooseMedia(node.type, (file) => transferMedia({
        config, name, key: 'test:' + node.id, kind: node.type, file,
        valid: () => miniTestNodes.includes(node),
        apply: (url, value) => {
            dropMediaUrl(node.url);
            Object.assign(node, { url, value, name: file.name });
        },
    }));
}

function finishTestDrag(){
    if(!testDrag) return;
    const { id, canvas } = testDrag;
    testDrag = null;
    canvas.classList.remove('is-panning');
    if(miniCanvasHost.hasPointerCapture(id)) miniCanvasHost.releasePointerCapture(id);
}

function testNodeFor(element){
    const id = element.closest('.mini-card')?.dataset.node;
    return miniTestNodes.find((node) => node.id === id);
}

function bindTestCanvas(){
    miniCanvasHost.addEventListener('click', (event) => {
        const button = event.target.closest('[data-test-add], [data-test-remove], [data-test-media]');
        if(!button || event.target.closest('video,audio')) return;
        const kind = button.dataset.testAdd;
        if(kind){
            createTestInput(kind);
            return;
        }
        const node = testNodeFor(button);
        if(!node) return;
        if(button.hasAttribute('data-test-media')){
            chooseTestMedia(node);
        } else {
            dropMediaUrl(node.url);
            miniTestNodes = miniTestNodes.filter((entry) => entry !== node);
            renderTestCanvas();
        }
    });
    miniCanvasHost.addEventListener('keydown', (event) => {
        if(!event.target.hasAttribute('data-test-media') || (event.key !== 'Enter' && event.key !== ' ')) return;
        const node = testNodeFor(event.target);
        if(!node) return;
        event.preventDefault();
        chooseTestMedia(node);
    });
    miniCanvasHost.addEventListener('input', (event) => {
        if(!event.target.hasAttribute('data-test-text')) return;
        const node = testNodeFor(event.target);
        if(node) node.text = event.target.value;
    });
    miniCanvasHost.addEventListener('pointerdown', (event) => {
        const canvas = event.target.closest('.mini-canvas');
        if(!canvas || event.button !== 0 || !event.isPrimary ||
            event.target.closest('button,input,textarea,select,[role="button"],audio,video')) return;
        const header = event.target.closest('.mini-card-head');
        const node = header ? testNodeFor(header) : null;
        if(!node && event.target.closest('.mini-card')) return;
        const start = node || testCamera;
        testDrag = { id: event.pointerId, canvas, node, point: surfacePoint(canvas, event), x: start.x, y: start.y };
        if(!node) canvas.classList.add('is-panning');
        miniCanvasHost.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    miniCanvasHost.addEventListener('pointermove', (event) => {
        if(testDrag?.id !== event.pointerId) return;
        const { canvas, node, point, x, y } = testDrag;
        const current = surfacePoint(canvas, event);
        const dx = current.x - point.x;
        const dy = current.y - point.y;
        if(node){
            node.x = x + dx / testCamera.scale;
            node.y = y + dy / testCamera.scale;
            const card = miniCanvasHost.querySelector('[data-node="' + node.id + '"]');
            card.style.left = node.x + 'px';
            card.style.top = node.y + 'px';
            drawTestConnections();
        } else {
            cameraMath.dragCamera(testCamera, x, y, dx, dy);
            updateTestCamera();
        }
    });
    for(const type of ['pointerup', 'pointercancel', 'lostpointercapture']){
        miniCanvasHost.addEventListener(type, (event) => {
            if(testDrag?.id === event.pointerId) finishTestDrag();
        });
    }
    miniCanvasHost.addEventListener('wheel', (event) => {
        const canvas = event.target.closest('.mini-canvas');
        const scroller = event.target.closest('.mini-settings-list,textarea');
        if(!canvas || !event.deltaY || (scroller && scroller.scrollHeight > scroller.clientHeight)) return;
        event.preventDefault();
        const factor = event.deltaY > 0 ? 0.9 : 1.1;
        const scale = Math.max(0.45, Math.min(1.8, testCamera.scale * factor));
        zoomAtPointer(testCamera, canvas, event, scale);
        updateTestCamera();
    }, { passive: false });
}

const workflowRuns = new WeakSet();
const workflowWrites = new WeakSet();
const mediaTransfers = new WeakMap();

function syncWorkflowActions(){
    const saving = currentConfig && workflowWrites.has(currentConfig);
    const running = currentConfig && workflowRuns.has(currentConfig);
    const uploading = currentConfig && mediaTransfers.get(currentConfig)?.size;
    saveBtn.disabled = Boolean(saving);
    deleteBtn.disabled = Boolean(saving);
    for(const button of document.querySelectorAll('.run-btn')){
        button.disabled = Boolean(running || uploading);
        const label = button.querySelector('span');
        if(label) label.textContent = tr(running ? 'comfy.runningTest' : 'comfy.runTest');
    }
}

function chooseMedia(kind, receive){
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = mediaTypes[kind].accept;
    picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if(file) receive(file);
    }, { once: true });
    picker.click();
}

async function transferMedia({ config, name, key, kind, file, valid, apply }){
    if(config !== currentConfig || !valid()) return;
    let transfers = mediaTransfers.get(config);
    if(!transfers) mediaTransfers.set(config, transfers = new Map());
    const token = Symbol();
    transfers.set(key, token);
    syncWorkflowActions();
    const belongs = () => config === currentConfig && transfers.get(key) === token && valid();
    const form = new FormData();
    form.set('files', file);
    form.set('workflow_json', name);
    try {
        const data = await settingsRequest('/api/upload', { method: 'POST', body: form, fallback: tr(mediaTypes[kind].failure) });
        if(!belongs()) return;
        const uploaded = data.files?.[0];
        const value = uploaded?.comfy_name || uploaded?.filename;
        if(!value) throw new Error(tr(mediaTypes[kind].failure));
        apply(URL.createObjectURL(file), value);
        renderPreview();
        renderWorkspaceView();
    } catch(error) {
        if(belongs()) alert(error.message);
    } finally {
        if(transfers.get(key) === token) transfers.delete(key);
        if(config === currentConfig) syncWorkflowActions();
    }
}

function pickImage(fieldId){
    const config = currentConfig;
    const name = selectedName;
    const field = config?.fields.find((entry) => entry.id === fieldId);
    if(!field) return;
    const kind = fieldKind(field);
    chooseMedia(kind, (file) => transferMedia({
        config, name, key: 'field:' + fieldId, kind, file,
        valid: () => config.fields.includes(field) && fieldKind(field) === kind,
        apply(url, value){
            dropMediaUrl(previewImageUrls[fieldId]);
            previewImageUrls[fieldId] = url;
            previewValues[fieldId] = value;
        },
    }));
}

async function onRun(){
    const config = currentConfig;
    const name = selectedName;
    if(!name || !config || workflowRuns.has(config) || mediaTransfers.get(config)?.size) return;
    workflowRuns.add(config);
    syncWorkflowActions();
    setStatus(tr('comfy.runningTest'));
    try {
        const draft = workspaceMode === 'canvas' ? fieldsFromMiniCanvas() : { ...previewValues };
        const fields = applyActiveRandomValues(draft);
        const data = await settingsRequest(workflowPath(name) + '/run', {
            method: 'POST', json: { fields, config, client_id: 'workflow-test' }, fallback: tr('comfy.runFailed'),
        });
        if(currentConfig !== config) return;
        runResult = workflowItems(data.images)[0] || null;
        renderPreview();
        renderWorkspaceView();
        setStatus(tr('comfy.runSuccess'));
    } catch(error) {
        if(currentConfig === config){
            alert(error.message);
            setStatus(tr('comfy.runFailed'));
        }
    } finally {
        workflowRuns.delete(config);
        if(currentConfig === config) syncWorkflowActions();
    }
}

function fieldsFromMiniCanvas(){
    const draft = Object.assign(Object.create(null), previewValues);
    const references = new Map(testMediaKinds.map((kind) => [kind, []]));
    const prompts = [];
    for(const node of miniTestNodes){
        if(node.type === 'prompt' && node.text) prompts.push(node.text);
        if(node.value && references.has(node.type)) references.get(node.type).push(node.value);
    }
    const prompt = prompts.join('\n\n');
    for(const field of currentConfig.fields){
        const kind = fieldKind(field);
        if(kind === 'prompt') draft[field.id] = prompt || draft[field.id] || '';
        else if(references.has(kind)) draft[field.id] = references.get(kind).shift() || draft[field.id] || '';
    }
    return draft;
}

async function onUpload(event){
    const file = event.target.files?.[0];
    event.target.value = '';
    if(!file) return;
    let workflow;
    try {
        workflow = JSON.parse(await file.text());
    } catch(_) {
        alert(tr('comfy.invalidJson'));
        return;
    }
    const name = prompt(tr('comfy.namePrompt'), file.name.replace(/\.json$/i, ''))?.trim();
    if(!name) return;
    try {
        const result = await settingsRequest(workflowEndpoint, {
            method: 'POST', json: { name, workflow }, fallback: tr('comfy.uploadFailed'),
        });
        emitSettingsUpdate('workflows-changed');
        await loadList(result.name);
        if(selectedName === result.name) setStatus(tr('comfy.uploaded') + ' · ' + result.name);
    } catch(error) {
        alert(error.message);
    }
}

async function onSave(){
    const config = currentConfig;
    const name = selectedName;
    if(!name || !config || workflowWrites.has(config)) return;
    const blank = config.fields.find((field) => !field.name?.trim());
    if(blank){
        alert(tf('comfy.saveMissingName', { field: blank.input }));
        return;
    }
    workflowWrites.add(config);
    syncWorkflowActions();
    setStatus(tr('comfy.saving'));
    try {
        await settingsRequest(workflowPath(name) + '/config', { method: 'PUT', json: config, fallback: tr('comfy.saveFailed') });
        emitSettingsUpdate('workflows-changed');
        await loadList('');
        if(currentConfig === config) setStatus(tr('comfy.saved'));
    } catch(error) {
        if(currentConfig === config){
            alert(error.message);
            setStatus(tr('comfy.saveFailed'));
        }
    } finally {
        workflowWrites.delete(config);
        syncWorkflowActions();
    }
}

async function onDelete(){
    const config = currentConfig;
    const name = selectedName;
    if(!name || !config || isBuiltin || workflowWrites.has(config)) return;
    if(!confirm(tf('comfy.deleteConfirm', { name: config.title || name }))) return;
    workflowWrites.add(config);
    syncWorkflowActions();
    try {
        const result = await settingsRequest(workflowPath(name), { method: 'DELETE', fallback: tr('comfy.deleteFailed') });
        if(currentConfig === config) clearWorkflow();
        emitSettingsUpdate('workflows-changed');
        await loadList('');
        const removed = workflowItems(result.removed_apps).length;
        if(removed) setStatus(tf('comfy.removedApps', { count: removed }));
    } catch(error) {
        if(currentConfig === config) alert(error.message);
    } finally {
        workflowWrites.delete(config);
        syncWorkflowActions();
    }
}

window.addEventListener('message', (event) => {
    if(event.origin !== location.origin) return;
    const message = event.data;
    if(message?.type === 'studio-theme') window.StudioTheme?.set(message.theme);
    if(message?.type === 'studio-lang') window.StudioI18n?.set(message.lang);
    if(message?.type === 'select-comfy-workflow' && typeof message.workflowName === 'string'){
        const name = message.workflowName.trim();
        if(name) openFromWorkspace(name);
    }
});
window.addEventListener('studio-lang-change', refreshLanguageView);
window.addEventListener('pageshow', () => {
    if(!currentWorkflow) loadList();
});
document.addEventListener('DOMContentLoaded', () => {
    bindSettingsPage();
    bindWorkflowGraph();
    bindTrialControls(previewCard);
    bindTrialControls(miniCanvasHost);
    bindTestCanvas();
    refreshIcons();
    loadList();
    loadComfyInstances();
});
