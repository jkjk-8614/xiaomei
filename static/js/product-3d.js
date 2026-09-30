import * as THREE from 'three';

const LOADER_BASE = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/';
const INBOX_KEY = 'soft_furnishing_canvas_inbox_v1';
const MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj']);
const CATEGORY_LABELS = {
    sofa: '沙发', chair: '单椅', table: '茶几', rug: '地毯', bed: '床', cabinet: '柜体', other: '自由块体'
};
const ROLE_COLORS = {
    sofa: '#e95e59', chair: '#4886c9', table: '#e6a12e', rug: '#b57bdb', bed: '#55a987', cabinet: '#7583aa', other: '#7c5cff'
};
const STUDIO_DEFAULTS = Object.freeze({
    camera: { yaw: 28, pitch: 14, distance: 5.2, fov: 42 },
    lighting: { key: 1.4, fill: .55 },
    environment: { url: '', name: '', intensity: 1, rotation: 0 },
    views: [], primary_view_url: ''
});
const SCENE_DEFAULTS = Object.freeze({
    camera: { yaw: 0, pitch: 0, distance: 6.5, fov: 43 },
    lighting: { key: 1.4, fill: .55 }
});

const $ = id => document.getElementById(id);
const ui = {
    assetList: $('assetList'), assetEmpty: $('assetEmpty'), sceneList: $('sceneList'), sceneEmpty: $('sceneEmpty'),
    studioPanel: $('studioPanel'), scenePanel: $('scenePanel'), studioTitle: $('studioTitle'), sceneTitle: $('sceneTitle'),
    studioViewport: $('studioViewport'), sceneViewport: $('sceneViewport'), studioEmpty: $('studioViewportEmpty'), sceneEmptyViewport: $('sceneViewportEmpty'),
    studioStatus: $('studioStatus'), sceneStatus: $('sceneStatus'), studioDot: $('studioStatusDot'), sceneDot: $('sceneStatusDot'),
    studioViews: $('studioViewsGrid'), sceneAssetSelect: $('sceneAssetSelect'), sceneObjectList: $('sceneObjectList'),
    scenePrompt: $('scenePrompt'), sceneRenderPreview: $('sceneRenderPreview'), inspectorTitle: $('inspectorTitle'),
    inspectorBadge: $('inspectorBadge'), inspectorContent: $('inspectorContent'), environmentName: $('environmentName'),
    assetDialog: $('assetDialog'), assetForm: $('assetForm'), labToast: $('labToast')
};

const state = {
    assets: [], scenes: [], mode: 'studio', selectedAssetId: '', selectedSceneId: '', selectedObjectId: '',
    studioConfig: studioConfig(), studioEngine: null, sceneEngine: null, loadersPromise: null, rgbePromise: null,
    assetPrototypes: new Map(), studioToken: 0, sceneToken: 0, assetDraft: { imageFile: null, modelFile: null },
    assetSaveTimer: 0, sceneSaveTimer: 0, toastTimer: 0, renderLoop: 0, generatingViews: false, generatingScene: false
};

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function mergeDeep(base, value) {
    const target = deepClone(base);
    if (!value || typeof value !== 'object') return target;
    Object.entries(value).forEach(([key, next]) => {
        if (next && typeof next === 'object' && !Array.isArray(next) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) target[key] = mergeDeep(target[key], next);
        else target[key] = next;
    });
    return target;
}
function studioConfig(value) { return mergeDeep(STUDIO_DEFAULTS, value); }
function sceneSettings(scene) {
    if (!scene) return mergeDeep(SCENE_DEFAULTS, null);
    scene.settings = mergeDeep(SCENE_DEFAULTS, scene.settings);
    return scene.settings;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function escapeAttr(value) { return escapeHtml(value).replace(/\n/g, '&#10;'); }
function shortName(value, fallback = '未命名') { const text = String(value || '').trim(); return text || fallback; }
function clamp(value, min, max, fallback = min) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function degree(value) { return THREE.MathUtils.degToRad(Number(value) || 0); }
function extension(urlOrName) { return String(urlOrName || '').split('?')[0].split('.').pop().toLowerCase(); }
function assetById(id = state.selectedAssetId) { return state.assets.find(item => item.id === id) || null; }
function sceneById(id = state.selectedSceneId) { return state.scenes.find(item => item.id === id) || null; }
function selectedSceneObject() { const scene = sceneById(); return scene?.objects?.find(item => item.id === state.selectedObjectId) || null; }
function hasLocalImage(url) { return /^\/(?:assets|output|api\/storage-files)\//.test(String(url || '')); }

function refreshIcons() { try { window.lucide?.createIcons?.(); } catch (_) {} }
function toast(message, type = '') {
    if (!ui.labToast) return;
    clearTimeout(state.toastTimer);
    ui.labToast.textContent = message || '';
    ui.labToast.classList.toggle('error', type === 'error');
    ui.labToast.classList.add('show');
    state.toastTimer = window.setTimeout(() => ui.labToast.classList.remove('show'), 3300);
}
async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `请求失败 (${response.status})`);
    return data;
}
async function uploadFile(file, fallbackName = 'asset') {
    if (!file) return null;
    const form = new FormData();
    form.append('files', file, file.name || fallbackName);
    const data = await requestJson('/api/ai/upload', { method: 'POST', body: form });
    const uploaded = Array.isArray(data.files) ? data.files[0] : null;
    if (!uploaded?.url) throw new Error('上传后没有返回素材地址');
    return uploaded;
}
function blobFromCanvas(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器无法导出当前预览；请使用本地上传的场景图和模型')), type, quality));
}
function status(kind, text, mode = '') {
    const textEl = kind === 'studio' ? ui.studioStatus : ui.sceneStatus;
    const dot = kind === 'studio' ? ui.studioDot : ui.sceneDot;
    textEl.textContent = text;
    dot.className = `status-dot${mode ? ` ${mode}` : ''}`;
}

function renderAssetList() {
    const assets = state.assets || [];
    ui.assetEmpty.hidden = assets.length > 0;
    ui.assetList.innerHTML = assets.map(asset => {
        const active = asset.id === state.selectedAssetId ? ' active' : '';
        const thumb = asset.image_url ? `<img src="${escapeAttr(asset.image_url)}" alt="">` : '<i data-lucide="box"></i>';
        const sub = asset.model_url ? `3D 模型 · ${String(asset.model_name || extension(asset.model_url).toUpperCase()).toUpperCase()}` : '产品图占位体';
        return `<button class="asset-item${active}" type="button" data-asset-id="${escapeAttr(asset.id)}"><span class="asset-thumb">${thumb}</span><span class="asset-item-copy"><strong>${escapeHtml(shortName(asset.name))}</strong><small>${escapeHtml(sub)}</small><em class="asset-tag">${escapeHtml(CATEGORY_LABELS[asset.category] || '其他')}</em></span></button>`;
    }).join('');
    ui.assetList.querySelectorAll('[data-asset-id]').forEach(button => button.addEventListener('click', () => selectAsset(button.dataset.assetId)));
}
function renderSceneList() {
    const scenes = state.scenes || [];
    ui.sceneEmpty.hidden = scenes.length > 0;
    ui.sceneList.innerHTML = scenes.map(scene => {
        const active = scene.id === state.selectedSceneId ? ' active' : '';
        const thumb = scene.control_image_url || scene.background_url;
        const visual = thumb ? `<img src="${escapeAttr(thumb)}" alt="">` : '<i data-lucide="lamp-desk"></i>';
        const count = (scene.objects || []).length;
        return `<button class="scene-item${active}" type="button" data-scene-id="${escapeAttr(scene.id)}"><span class="scene-thumb">${visual}</span><span class="scene-item-copy"><strong>${escapeHtml(shortName(scene.name))}</strong><small>${count ? `${count} 个对象` : '等待上传场景图'}</small></span></button>`;
    }).join('');
    ui.sceneList.querySelectorAll('[data-scene-id]').forEach(button => button.addEventListener('click', () => selectScene(button.dataset.sceneId)));
}
function renderAssetOptions() {
    const selected = ui.sceneAssetSelect.value;
    ui.sceneAssetSelect.innerHTML = `<option value="">不绑定，使用占位体</option>${state.assets.map(asset => `<option value="${escapeAttr(asset.id)}">${escapeHtml(asset.name)}</option>`).join('')}`;
    if (state.assets.some(item => item.id === selected)) ui.sceneAssetSelect.value = selected;
}
function renderStudioViews() {
    const asset = assetById();
    const views = Array.isArray(asset?.studio?.views) ? asset.studio.views : [];
    if (!asset) {
        ui.studioViews.innerHTML = '<div class="views-placeholder"><i data-lucide="panels-top-left"></i><span>选择商品后可生成前、后、左、右、顶、底六视图</span></div>';
    } else if (!views.length) {
        ui.studioViews.innerHTML = '<div class="views-placeholder"><i data-lucide="images"></i><span>当前还没有六视图。调整相机与灯光后点击“生成六视图”。</span></div>';
    } else {
        ui.studioViews.innerHTML = views.map(view => `<button class="view-card" type="button" data-view-url="${escapeAttr(view.url || '')}" title="设为主视角"><img src="${escapeAttr(view.url || '')}" alt="${escapeAttr(view.name || '预演图')}"><span>${escapeHtml(view.label || view.name || '视图')}</span></button>`).join('');
        ui.studioViews.querySelectorAll('[data-view-url]').forEach(button => button.addEventListener('click', () => setPrimaryView(button.dataset.viewUrl)));
    }
    refreshIcons();
}
function renderSceneObjectList() {
    const scene = sceneById();
    const objects = scene?.objects || [];
    if (!objects.length) {
        ui.sceneObjectList.innerHTML = '<div class="views-placeholder"><i data-lucide="box-select"></i><span>还没有对象。先从右侧添加沙发、单椅、茶几或地毯。</span></div>';
    } else {
        ui.sceneObjectList.innerHTML = objects.map(object => {
            const asset = assetById(object.asset_id);
            const active = object.id === state.selectedObjectId ? ' active' : '';
            const color = ROLE_COLORS[object.role] || object.color || ROLE_COLORS.other;
            const label = asset?.name || object.name || `${CATEGORY_LABELS[object.role] || '对象'}占位`;
            const sub = asset?.model_url ? '真实 3D 模型' : asset?.image_url ? '产品图 + 占位体' : '几何占位体';
            return `<button class="scene-object-card${active}" type="button" data-object-id="${escapeAttr(object.id)}"><span class="scene-object-shape" style="background:${escapeAttr(color)}"><i data-lucide="box"></i></span><span class="scene-object-card-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(sub)}</small></span></button>`;
        }).join('');
        ui.sceneObjectList.querySelectorAll('[data-object-id]').forEach(button => button.addEventListener('click', () => selectSceneObject(button.dataset.objectId)));
    }
    refreshIcons();
}

function renderInspector() {
    const asset = state.mode === 'studio' ? assetById() : null;
    const object = state.mode === 'scene' ? selectedSceneObject() : null;
    if (asset) {
        ui.inspectorTitle.textContent = '产品模型';
        ui.inspectorBadge.textContent = CATEGORY_LABELS[asset.category] || '其他';
        const dimensions = asset.dimensions || {};
        const visual = asset.image_url ? `<img src="${escapeAttr(asset.image_url)}" alt="${escapeAttr(asset.name)}">` : '<i data-lucide="box"></i>';
        ui.inspectorContent.innerHTML = `
            <div class="inspector-asset-thumb">${visual}</div>
            <section class="inspector-group"><div class="inspector-group-title">商品信息</div>
                <label class="inspector-field"><span>商品名称</span><input data-asset-field="name" type="text" maxlength="120" value="${escapeAttr(asset.name)}"></label>
                <label class="inspector-field"><span>占位分类</span><select data-asset-field="category">${Object.entries(CATEGORY_LABELS).map(([key, label]) => `<option value="${key}"${asset.category === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
                <p class="asset-meta-line">${asset.model_url ? `已绑定 ${escapeHtml(extension(asset.model_url).toUpperCase())} 模型` : '当前使用产品图绑定的占位体'}<br>${asset.image_url ? '产品图已保存，可在软装场景中绑定。' : ''}</p>
            </section>
            <section class="inspector-group"><div class="inspector-group-title">真实尺寸（mm）</div>
                <div class="inspector-row"><label class="inspector-field"><span>宽</span><input data-dimension="width_mm" type="number" min="1" max="100000" value="${escapeAttr(dimensions.width_mm || 800)}"></label><label class="inspector-field"><span>深</span><input data-dimension="depth_mm" type="number" min="1" max="100000" value="${escapeAttr(dimensions.depth_mm || 800)}"></label></div>
                <label class="inspector-field"><span>高</span><input data-dimension="height_mm" type="number" min="1" max="100000" value="${escapeAttr(dimensions.height_mm || 800)}"></label>
            </section>`;
        ui.inspectorContent.querySelectorAll('[data-asset-field]').forEach(input => input.addEventListener('change', () => updateAssetFromInspector(input)));
        ui.inspectorContent.querySelectorAll('[data-dimension]').forEach(input => input.addEventListener('change', () => updateAssetFromInspector(input)));
    } else if (object) {
        ui.inspectorTitle.textContent = '场景对象';
        ui.inspectorBadge.textContent = CATEGORY_LABELS[object.role] || '对象';
        ui.inspectorContent.innerHTML = `
            <section class="inspector-group"><div class="inspector-group-title">绑定与名称</div>
                <label class="inspector-field"><span>对象名称</span><input data-object-field="name" type="text" maxlength="120" value="${escapeAttr(object.name)}"></label>
                <label class="inspector-field"><span>绑定商品</span><select data-object-field="asset_id"><option value="">不绑定，使用占位体</option>${state.assets.map(asset => `<option value="${escapeAttr(asset.id)}"${object.asset_id === asset.id ? ' selected' : ''}>${escapeHtml(asset.name)}</option>`).join('')}</select></label>
                <label class="inspector-field"><span>占位类型</span><select data-object-field="role">${Object.entries(CATEGORY_LABELS).map(([key, label]) => `<option value="${key}"${object.role === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
            </section>
            <section class="inspector-group"><div class="inspector-group-title">空间变换</div>
                <div class="inspector-row"><label class="inspector-field"><span>水平 X</span><input data-object-number="x" type="number" step="0.05" min="-30" max="30" value="${escapeAttr(object.x)}"></label><label class="inspector-field"><span>前后 Z</span><input data-object-number="z" type="number" step="0.05" min="-30" max="30" value="${escapeAttr(object.z)}"></label></div>
                <label class="inspector-field"><span>上下 Y</span><input data-object-number="y" type="number" step="0.05" min="-10" max="10" value="${escapeAttr(object.y)}"></label>
                <label class="inspector-field"><span>水平旋转（°）</span><input data-object-number="rotation" type="number" step="1" min="-360" max="360" value="${escapeAttr(object.rotation)}"></label>
                <label class="inspector-field"><span>等比缩放</span><input data-object-number="scale" type="number" step="0.05" min="0.05" max="20" value="${escapeAttr(object.scale)}"></label>
                <button class="inspector-object-delete" type="button" data-delete-object>从场景移除</button>
            </section>`;
        ui.inspectorContent.querySelectorAll('[data-object-field]').forEach(input => input.addEventListener('change', () => updateObjectFromInspector(input)));
        ui.inspectorContent.querySelectorAll('[data-object-number]').forEach(input => input.addEventListener('change', () => updateObjectFromInspector(input)));
        ui.inspectorContent.querySelector('[data-delete-object]')?.addEventListener('click', deleteSelectedSceneObject);
    } else {
        ui.inspectorTitle.textContent = state.mode === 'scene' ? '场景对象' : '产品模型';
        ui.inspectorBadge.textContent = '未选择';
        ui.inspectorContent.innerHTML = '<div class="inspector-empty"><i data-lucide="mouse-pointer-square-dashed"></i><strong>选择一个商品或场景对象</strong><span>商品可编辑尺寸与分类；对象可调整位置、旋转和缩放。</span></div>';
    }
    refreshIcons();
}

function renderAll() {
    renderAssetList(); renderSceneList(); renderAssetOptions(); renderStudioViews(); renderSceneObjectList(); renderInspector();
    const asset = assetById(); const scene = sceneById();
    ui.studioTitle.textContent = asset ? shortName(asset.name) : '选择一个商品资产';
    ui.sceneTitle.textContent = scene ? shortName(scene.name) : '新建一个软装场景';
    ui.scenePrompt.value = scene?.composition_prompt || '';
    $('saveStudioButton').disabled = !asset || state.generatingViews;
    $('sixViewsButton').disabled = !asset || state.generatingViews;
    $('saveSceneButton').disabled = !scene || state.generatingScene;
    $('renderSceneButton').disabled = !scene || state.generatingScene;
    $('sendCanvasButton').disabled = !scene?.control_image_url || state.generatingScene;
    renderScenePreview(); refreshIcons();
}
function renderScenePreview() {
    const scene = sceneById();
    if (scene?.control_image_url) ui.sceneRenderPreview.innerHTML = `<img src="${escapeAttr(scene.control_image_url)}" alt="场景编排图">`;
    else ui.sceneRenderPreview.innerHTML = '<div class="views-placeholder"><i data-lucide="image"></i><span>生成后，这张图可以作为小美画布的布局参考。</span></div>';
}

function updateRangeVisual(input) {
    const min = Number(input.min || 0); const max = Number(input.max || 100); const value = Number(input.value || min);
    input.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, (value - min) / Math.max(.001, max - min) * 100))}%`);
    const label = document.querySelector(`[data-value-for="${input.id}"]`);
    if (label) {
        const precision = Number(input.step || 1) < 1 ? 1 : 0;
        const suffix = /Yaw|Pitch|Fov|Rotation/i.test(input.id) ? '°' : '';
        label.textContent = `${Number(value).toFixed(precision)}${suffix}`;
    }
}
function applyStudioControls(config = state.studioConfig) {
    const fields = {
        studioYaw: config.camera.yaw, studioPitch: config.camera.pitch, studioDistance: config.camera.distance, studioFov: config.camera.fov,
        studioEnvIntensity: config.environment.intensity, studioEnvRotation: config.environment.rotation, studioKeyLight: config.lighting.key, studioFillLight: config.lighting.fill
    };
    Object.entries(fields).forEach(([id, value]) => { const input = $(id); input.value = value; updateRangeVisual(input); });
    ui.environmentName.textContent = config.environment.name || '未使用环境贴图';
}
function readStudioControls() {
    const config = state.studioConfig;
    config.camera.yaw = clamp($('studioYaw').value, -180, 180, 28);
    config.camera.pitch = clamp($('studioPitch').value, -70, 80, 14);
    config.camera.distance = clamp($('studioDistance').value, 1.5, 14, 5.2);
    config.camera.fov = clamp($('studioFov').value, 18, 90, 42);
    config.environment.intensity = clamp($('studioEnvIntensity').value, 0, 3, 1);
    config.environment.rotation = clamp($('studioEnvRotation').value, 0, 360, 0);
    config.lighting.key = clamp($('studioKeyLight').value, 0, 4, 1.4);
    config.lighting.fill = clamp($('studioFillLight').value, 0, 3, .55);
    return config;
}

async function selectAsset(assetId) {
    if (!state.assets.some(item => item.id === assetId)) return;
    state.selectedAssetId = assetId;
    state.studioConfig = studioConfig(assetById()?.studio);
    applyStudioControls(); renderAll();
    await ensureStudioEngine();
    await loadStudioAsset();
}
async function selectScene(sceneId) {
    if (!state.scenes.some(item => item.id === sceneId)) return;
    state.selectedSceneId = sceneId; state.selectedObjectId = '';
    renderAll(); await ensureSceneEngine(); await syncSceneVisuals();
}
function selectSceneObject(objectId) {
    state.selectedObjectId = objectId; renderSceneObjectList(); renderInspector(); updateSceneOutline();
}

function setStudioCameraView(view) {
    const configs = {
        front: { yaw: 0, pitch: 0 }, back: { yaw: 180, pitch: 0 }, left: { yaw: -90, pitch: 0 }, right: { yaw: 90, pitch: 0 }, top: { yaw: 0, pitch: 78 }, bottom: { yaw: 0, pitch: -70 }
    };
    const target = configs[view]; if (!target) return;
    state.studioConfig.camera = { ...state.studioConfig.camera, ...target };
    applyStudioControls(); renderStudio();
    document.querySelectorAll('[data-studio-view]').forEach(button => button.classList.toggle('active', button.dataset.studioView === view));
}

function makeRenderer(host, alpha = false) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);
    return renderer;
}
function resizeEngine(engine) {
    if (!engine?.renderer || !engine.host?.clientWidth) return;
    const width = Math.max(1, Math.round(engine.host.clientWidth)); const height = Math.max(1, Math.round(engine.host.clientHeight));
    if (engine.renderer.domElement.width !== width || engine.renderer.domElement.height !== height) engine.renderer.setSize(width, height, false);
    engine.camera.aspect = width / Math.max(1, height); engine.camera.updateProjectionMatrix();
}
function addStudioLights(scene) {
    const hemisphere = new THREE.HemisphereLight(0xc8d9ff, 0x1e2438, .6); scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xfff5e3, 1.4); key.position.set(3.5, 5.5, 4); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9d5ff, .55); fill.position.set(-4, 2.4, 2); scene.add(fill);
    return { key, fill };
}
function createStudioEngine() {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x20283a);
    const renderer = makeRenderer(ui.studioViewport);
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 100);
    const root = new THREE.Group(); root.position.y = -1; scene.add(root);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x293348, roughness: .82, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1.01; ground.receiveShadow = true; scene.add(ground);
    const grid = new THREE.GridHelper(12, 18, 0x626d91, 0x38445d); grid.position.y = -1; grid.material.opacity = .38; grid.material.transparent = true; scene.add(grid);
    const lights = addStudioLights(scene);
    const engine = { kind: 'studio', host: ui.studioViewport, renderer, scene, camera, root, ground, grid, lights, target: new THREE.Vector3(0, -.1, 0), environmentTexture: null, dragging: null };
    attachOrbit(engine, false); state.studioEngine = engine; return engine;
}
async function ensureStudioEngine() { return state.studioEngine || createStudioEngine(); }
function disposeEngine(engine) {
    if (!engine) return;
    engine.renderer?.dispose?.(); engine.renderer?.forceContextLoss?.(); engine.renderer?.domElement?.remove?.();
    engine.environmentTexture?.dispose?.();
}

function assetColor(asset) {
    const id = String(asset?.id || asset?.name || 'asset'); let number = 0;
    for (let index = 0; index < id.length; index += 1) number = ((number << 5) - number + id.charCodeAt(index)) | 0;
    const base = [0x8d70ee, 0x3e8bc8, 0xdd8657, 0x57a879, 0xcf6e9f][Math.abs(number) % 5];
    return base;
}
function standardMaterial(color, roughness = .66) { return new THREE.MeshStandardMaterial({ color, roughness, metalness: .04 }); }
function boxMesh(width, height, depth, material, x = 0, y = 0, z = 0) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }
function addCoverPlane(group, asset, width, height, z) {
    if (!asset?.image_url) return;
    new THREE.TextureLoader().load(asset.image_url, texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const aspect = Number(texture.image?.width || 1) / Math.max(1, Number(texture.image?.height || 1));
        const planeHeight = Math.min(height * .72, width / Math.max(.35, aspect));
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeHeight * aspect, planeHeight), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .97, side: THREE.DoubleSide }));
        plane.position.set(0, height * .52, z); group.add(plane);
    }, undefined, () => {});
}
function createProxyAsset(asset, overrideRole = '') {
    const role = overrideRole || asset?.category || 'other';
    const group = new THREE.Group(); const color = new THREE.Color(asset?.color || ROLE_COLORS[role] || assetColor(asset)); const material = standardMaterial(color);
    const dark = standardMaterial(color.clone().multiplyScalar(.75)); const light = standardMaterial(color.clone().lerp(new THREE.Color(0xffffff), .25));
    if (role === 'sofa') {
        group.add(boxMesh(2.15, .46, .82, material, 0, .43, 0), boxMesh(2.15, .78, .18, dark, 0, .95, .32), boxMesh(.24, .7, .86, light, -1.0, .64, 0), boxMesh(.24, .7, .86, light, 1.0, .64, 0));
        addCoverPlane(group, asset, 1.3, 1.18, -.425);
    } else if (role === 'chair') {
        group.add(boxMesh(.86, .43, .84, material, 0, .43, 0), boxMesh(.84, .72, .16, dark, 0, .93, .33), boxMesh(.12, .68, .78, light, -.42, .6, 0), boxMesh(.12, .68, .78, light, .42, .6, 0));
        addCoverPlane(group, asset, .62, 1.05, -.43);
    } else if (role === 'table') {
        const top = new THREE.Mesh(new THREE.CylinderGeometry(.72, .72, .13, 40), material); top.position.y = .72; top.castShadow = true; group.add(top);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(.18, .25, .7, 28), dark); leg.position.y = .35; leg.castShadow = true; group.add(leg);
    } else if (role === 'rug') {
        const rug = new THREE.Mesh(new THREE.BoxGeometry(2.4, .06, 1.45), material); rug.position.y = .03; rug.castShadow = true; rug.receiveShadow = true; group.add(rug);
        addCoverPlane(group, asset, 1.9, .12, -.73);
    } else if (role === 'bed') {
        group.add(boxMesh(2.1, .35, 1.45, material, 0, .32, 0), boxMesh(2.1, .9, .18, dark, 0, .75, .62), boxMesh(1.72, .23, 1.15, light, 0, .63, -.04));
    } else if (role === 'cabinet') {
        group.add(boxMesh(1.3, 1.45, .45, material, 0, .73, 0), boxMesh(1.08, .57, .03, dark, 0, .98, -.235)); addCoverPlane(group, asset, .96, 1.18, -.245);
    } else {
        group.add(boxMesh(1.15, 1.15, 1.15, material, 0, .58, 0)); addCoverPlane(group, asset, .8, 1.02, -.585);
    }
    group.userData.xmProxy = true; return group;
}
function normalizeModel(object, asset) {
    object.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(object); const rawSize = box.getSize(new THREE.Vector3());
    const largest = Math.max(rawSize.x, rawSize.y, rawSize.z, .001);
    const dimensions = asset?.dimensions || {}; const requested = Math.max(Number(dimensions.width_mm) || 800, Number(dimensions.depth_mm) || 800, Number(dimensions.height_mm) || 800) / 1000;
    const desired = clamp(requested, .3, 3.2, 1.2); object.scale.multiplyScalar(desired / largest);
    object.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(object); const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x; object.position.z -= center.z; object.position.y -= box.min.y;
    object.traverse(node => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; if (node.material?.map) node.material.map.colorSpace = THREE.SRGBColorSpace; } });
    return object;
}
async function getLoaders() {
    if (!state.loadersPromise) state.loadersPromise = Promise.all([
        import(`${LOADER_BASE}GLTFLoader.js`), import(`${LOADER_BASE}OBJLoader.js`)
    ]).then(([gltf, obj]) => ({ GLTFLoader: gltf.GLTFLoader, OBJLoader: obj.OBJLoader }));
    return state.loadersPromise;
}
async function modelPrototype(asset) {
    const key = `${asset.id}|${asset.model_url || ''}|${asset.image_url || ''}|${asset.category || ''}|${JSON.stringify(asset.dimensions || {})}`;
    const cached = state.assetPrototypes.get(key); if (cached) return cached;
    const promise = (async () => {
        if (!asset.model_url || !MODEL_EXTENSIONS.has(extension(asset.model_url))) return { object: createProxyAsset(asset), source: 'proxy', warning: '' };
        try {
            const loaders = await getLoaders(); const ext = extension(asset.model_url);
            let object;
            if (ext === 'obj') object = await new loaders.OBJLoader().loadAsync(asset.model_url);
            else { const loaded = await new loaders.GLTFLoader().loadAsync(asset.model_url); object = loaded.scene || loaded.scenes?.[0]; }
            if (!object) throw new Error('模型没有可显示的场景');
            return { object: normalizeModel(object, asset), source: 'model', warning: '' };
        } catch (error) {
            return { object: createProxyAsset(asset), source: 'proxy', warning: `3D 模型预览失败，已使用占位体：${error?.message || '未知错误'}` };
        }
    })();
    state.assetPrototypes.set(key, promise); return promise;
}
async function instantiateAsset(asset, role = '') {
    if (!asset) return createProxyAsset({ category: role || 'other', color: ROLE_COLORS[role] || ROLE_COLORS.other }, role);
    const source = await modelPrototype(asset);
    // 占位体上的产品图是异步贴上的；每次实例化一份，才能让贴图附着到
    // 当前工作台/场景中的对象，而不是只附着在缓存原型上。
    if (source.source === 'proxy') return createProxyAsset(asset, role);
    return source.object.clone(true);
}

async function loadStudioAsset() {
    const engine = await ensureStudioEngine(); const asset = assetById(); const token = ++state.studioToken;
    engine.root.clear(); ui.studioEmpty.hidden = Boolean(asset);
    if (!asset) { status('studio', '等待商品模型'); renderStudio(); return; }
    status('studio', '正在加载商品资产…', 'loading');
    const model = await instantiateAsset(asset);
    if (token !== state.studioToken) return;
    engine.root.add(model); engine.root.userData.assetId = asset.id;
    await applyStudioEnvironment();
    const source = await modelPrototype(asset);
    status('studio', source.warning || (source.source === 'model' ? '真实 3D 模型已加载' : '产品图绑定占位体已加载'), source.warning ? '' : 'ready');
    renderStudio();
}
function positionCamera(camera, config, target) {
    const yaw = degree(config.yaw); const pitch = degree(config.pitch); const distance = Number(config.distance) || 5;
    const flat = distance * Math.cos(pitch);
    camera.position.set(Math.sin(yaw) * flat, target.y + Math.sin(pitch) * distance, Math.cos(yaw) * flat);
    camera.fov = Number(config.fov) || 42; camera.lookAt(target); camera.updateProjectionMatrix();
}
function renderStudio() {
    const engine = state.studioEngine; if (!engine) return;
    resizeEngine(engine); const config = state.studioConfig; positionCamera(engine.camera, config.camera, engine.target);
    engine.lights.key.intensity = Number(config.lighting.key) || 0; engine.lights.fill.intensity = Number(config.lighting.fill) || 0;
    engine.renderer.render(engine.scene, engine.camera);
}
async function applyStudioEnvironment() {
    const engine = state.studioEngine; if (!engine) return;
    const config = state.studioConfig.environment || {}; const url = String(config.url || '');
    if (engine.environmentUrl === url && engine.environmentTexture) { applyEnvironmentIntensity(engine); return; }
    engine.environmentUrl = url;
    if (engine.environmentTexture) { engine.environmentTexture.dispose?.(); engine.environmentTexture = null; }
    engine.scene.environment = null; engine.scene.background = new THREE.Color(0x20283a);
    if (!url) { applyEnvironmentIntensity(engine); return; }
    try {
        const ext = extension(url); let texture = null;
        if (ext === 'hdr') {
            if (!state.rgbePromise) state.rgbePromise = import(`${LOADER_BASE}RGBELoader.js`).then(module => module.RGBELoader);
            const RGBELoader = await state.rgbePromise; texture = await new RGBELoader().loadAsync(url); texture.mapping = THREE.EquirectangularReflectionMapping;
        } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
            texture = await new THREE.TextureLoader().loadAsync(url); texture.colorSpace = THREE.SRGBColorSpace; texture.mapping = THREE.EquirectangularReflectionMapping;
        } else if (ext === 'exr') {
            toast('EXR 已保存为环境参数；浏览器预览暂不解析 EXR。'); applyEnvironmentIntensity(engine); return;
        }
        if (texture) { engine.environmentTexture = texture; engine.scene.environment = texture; applyEnvironmentIntensity(engine); }
    } catch (error) { toast(`环境贴图未能载入：${error?.message || '未知错误'}`, 'error'); }
}
function applyEnvironmentIntensity(engine) {
    const intensity = Number(state.studioConfig.environment?.intensity) || 0;
    const rotation = degree(state.studioConfig.environment?.rotation || 0);
    if ('environmentIntensity' in engine.scene) engine.scene.environmentIntensity = intensity;
    if ('environmentRotation' in engine.scene) engine.scene.environmentRotation.y = rotation;
    if (engine.environmentTexture && !('environmentRotation' in engine.scene)) engine.environmentTexture.rotation = rotation;
}
function updateStudioFromControls() { readStudioControls(); applyEnvironmentIntensity(state.studioEngine || {}); renderStudio(); }
async function saveStudioSettings(showToast = true) {
    const asset = assetById(); if (!asset) return;
    readStudioControls(); asset.studio = studioConfig({ ...asset.studio, ...state.studioConfig });
    const data = await requestJson(`/api/product-3d/assets/${encodeURIComponent(asset.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: asset.studio }) });
    state.assets = data.assets || state.assets; state.studioConfig = studioConfig(assetById(asset.id)?.studio); renderAll();
    if (showToast) toast('商品预演参数已保存');
}
async function setPrimaryView(url) {
    const asset = assetById(); if (!asset || !url) return;
    state.studioConfig.primary_view_url = url;
    asset.studio = studioConfig(asset.studio); asset.studio.primary_view_url = url;
    await saveStudioSettings(false); toast('已设为商品主视角');
}
async function generateSixViews() {
    const asset = assetById(); const engine = state.studioEngine; if (!asset || !engine || state.generatingViews) return;
    state.generatingViews = true; renderAll(); status('studio', '正在生成六视图…', 'loading');
    const original = deepClone(state.studioConfig.camera); const specs = [
        ['front', '前视图', 0, 0], ['back', '后视图', 180, 0], ['left', '左视图', -90, 0], ['right', '右视图', 90, 0], ['top', '顶视图', 0, 78], ['bottom', '底视图', 0, -70]
    ];
    try {
        const views = [];
        for (const [id, label, yaw, pitch] of specs) {
            state.studioConfig.camera = { ...state.studioConfig.camera, yaw, pitch }; applyStudioControls(); renderStudio();
            const blob = await blobFromCanvas(engine.renderer.domElement); const file = new File([blob], `${asset.name || 'product'}-${id}.png`, { type: 'image/png' });
            const uploaded = await uploadFile(file, `product-${id}.png`); views.push({ id, label, name: `${label}.png`, url: uploaded.url });
        }
        state.studioConfig.camera = original; applyStudioControls(); renderStudio();
        state.studioConfig.views = views;
        state.studioConfig.primary_view_url = views[0]?.url || '';
        asset.studio = studioConfig({ ...asset.studio, ...state.studioConfig, views, primary_view_url: views[0]?.url || '' });
        await saveStudioSettings(false); status('studio', '六视图已保存到商品资产', 'ready'); toast('商品六视图已生成并保存');
    } catch (error) {
        state.studioConfig.camera = original; applyStudioControls(); renderStudio(); status('studio', '六视图生成失败'); toast(error?.message || '六视图生成失败', 'error');
    } finally { state.generatingViews = false; renderAll(); }
}

function createSceneEngine() {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x252d40);
    const renderer = makeRenderer(ui.sceneViewport);
    const camera = new THREE.PerspectiveCamera(43, 1, .1, 100);
    const target = new THREE.Vector3(0, -.05, 0);
    const objects = new THREE.Group(); scene.add(objects);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.ShadowMaterial({ color: 0x101420, opacity: .3 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -1.35; ground.receiveShadow = true; scene.add(ground);
    const lights = addStudioLights(scene); const backgroundGroup = new THREE.Group(); scene.add(backgroundGroup);
    const engine = { kind: 'scene', host: ui.sceneViewport, renderer, scene, camera, target, objects, ground, lights, backgroundGroup, background: null, backgroundUrl: '', objectMap: new Map(), outline: null, dragging: null };
    attachOrbit(engine, true); state.sceneEngine = engine; return engine;
}
async function ensureSceneEngine() { return state.sceneEngine || createSceneEngine(); }
function defaultSceneObject(role = 'other', assetId = '') {
    const index = (sceneById()?.objects || []).length;
    return { id: `sceneobj_${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Date.now().toString(36)}`, name: `${CATEGORY_LABELS[role] || '对象'}占位`, role, asset_id: assetId, x: (index % 3 - 1) * 1.1, y: -1.35, z: -Math.floor(index / 3) * .45, rotation: 0, scale: 1, color: ROLE_COLORS[role] || ROLE_COLORS.other, created_at: Date.now() };
}
async function addSceneObject(role = $('sceneRoleSelect').value || 'other', assetId = ui.sceneAssetSelect.value || '') {
    const scene = await ensureSelectedScene(); if (!scene) return;
    const asset = assetById(assetId); const resolvedRole = asset?.category || role;
    const object = defaultSceneObject(resolvedRole, assetId); object.name = asset?.name || object.name;
    scene.objects = [...(scene.objects || []), object]; state.selectedObjectId = object.id;
    renderAll(); await syncSceneObjects(); scheduleSceneSave(); toast(`${object.name} 已添加到场景`);
}
async function ensureSelectedScene() {
    if (sceneById()) return sceneById();
    return createScene();
}
async function createScene() {
    try {
        const now = new Date(); const name = `软装场景 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const data = await requestJson('/api/soft-furnishing/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, settings: mergeDeep(SCENE_DEFAULTS, null) }) });
        state.scenes = data.scenes || state.scenes; state.selectedSceneId = data.scene?.id || state.scenes[0]?.id || ''; state.selectedObjectId = '';
        renderAll(); await ensureSceneEngine(); await syncSceneVisuals(); toast('已创建新的软装场景'); return sceneById();
    } catch (error) { toast(error?.message || '创建场景失败', 'error'); return null; }
}
async function applySceneBackground() {
    const engine = state.sceneEngine; const scene = sceneById(); if (!engine) return;
    const url = String(scene?.background_url || ''); if (engine.backgroundUrl === url) return;
    engine.backgroundUrl = url; engine.backgroundGroup.clear(); engine.background = null;
    if (!url) return;
    try {
        const texture = await new THREE.TextureLoader().loadAsync(url); texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.MeshBasicMaterial({ map: texture, depthWrite: false, side: THREE.DoubleSide }); const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        plane.renderOrder = -10; engine.backgroundGroup.add(plane); engine.background = { plane, texture, aspect: Number(texture.image?.width || 1) / Math.max(1, Number(texture.image?.height || 1)) };
    } catch (error) { toast(`场景图无法加载：${error?.message || '未知错误'}`, 'error'); }
}
async function syncSceneObjects() {
    const engine = await ensureSceneEngine(); const scene = sceneById(); const token = ++state.sceneToken;
    engine.objects.clear(); engine.objectMap.clear(); updateSceneOutline();
    if (!scene) { ui.sceneEmptyViewport.hidden = false; renderScene(); return; }
    const items = Array.isArray(scene.objects) ? scene.objects : [];
    const loaded = await Promise.all(items.map(async object => {
        const asset = assetById(object.asset_id); const model = await instantiateAsset(asset || { category: object.role, color: object.color }, object.role);
        model.position.set(Number(object.x) || 0, Number(object.y) || -1.35, Number(object.z) || 0); model.rotation.y = degree(object.rotation); model.scale.setScalar(Number(object.scale) || 1); model.userData.sceneObjectId = object.id;
        return { object, model };
    }));
    if (token !== state.sceneToken) return;
    loaded.forEach(({ object, model }) => { engine.objects.add(model); engine.objectMap.set(object.id, model); });
    ui.sceneEmptyViewport.hidden = Boolean(scene.background_url || items.length); updateSceneOutline(); renderScene();
}
async function syncSceneVisuals() {
    await applySceneBackground(); await syncSceneObjects();
    const scene = sceneById(); status('scene', scene?.background_url ? '场景图已加载，可继续摆放商品' : '添加场景图与商品', scene?.background_url ? 'ready' : '');
}
function updateSceneBackgroundTransform(engine) {
    const background = engine.background; if (!background?.plane) return;
    const width = engine.renderer.domElement.clientWidth || 1; const height = engine.renderer.domElement.clientHeight || 1; const screenAspect = width / Math.max(1, height);
    const distance = 4.6; const fov = THREE.MathUtils.degToRad(engine.camera.fov); const screenHeight = 2 * Math.tan(fov / 2) * distance; const screenWidth = screenHeight * screenAspect;
    const textureAspect = background.aspect || 1; let planeWidth; let planeHeight;
    if (textureAspect >= screenAspect) { planeHeight = screenHeight * 1.04; planeWidth = planeHeight * textureAspect; } else { planeWidth = screenWidth * 1.04; planeHeight = planeWidth / textureAspect; }
    const forward = new THREE.Vector3(); engine.camera.getWorldDirection(forward);
    background.plane.position.copy(engine.target).addScaledVector(forward, distance); background.plane.quaternion.copy(engine.camera.quaternion); background.plane.scale.set(planeWidth, planeHeight, 1);
}
function updateSceneOutline() {
    const engine = state.sceneEngine; if (!engine) return;
    if (engine.outline) { engine.outline.removeFromParent(); engine.outline = null; }
    const model = engine.objectMap.get(state.selectedObjectId); if (!model) return;
    const outline = new THREE.BoxHelper(model, 0xa78cff); outline.material.depthTest = false; outline.renderOrder = 10; engine.scene.add(outline); engine.outline = outline;
}
function renderScene() {
    const engine = state.sceneEngine; const scene = sceneById(); if (!engine) return;
    resizeEngine(engine); const settings = sceneSettings(scene); positionCamera(engine.camera, settings.camera, engine.target);
    engine.lights.key.intensity = Number(settings.lighting.key) || 0; engine.lights.fill.intensity = Number(settings.lighting.fill) || 0;
    updateSceneBackgroundTransform(engine); engine.outline?.update?.(); engine.renderer.render(engine.scene, engine.camera);
}

function attachOrbit(engine, selectable) {
    const host = engine.host;
    const move = event => {
        const drag = engine.drag; if (!drag) return; const dx = event.clientX - drag.x; const dy = event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
        const config = engine.kind === 'studio' ? state.studioConfig.camera : sceneSettings(sceneById()).camera;
        config.yaw = clamp(config.yaw + dx * .42, -180, 180, 0); config.pitch = clamp(config.pitch - dy * .32, -70, 80, 0);
        if (engine.kind === 'studio') { applyStudioControls(); renderStudio(); } else { renderScene(); scheduleSceneSave(); }
    };
    const end = event => {
        const drag = engine.drag; if (!drag) return; engine.drag = null; try { host.releasePointerCapture(event.pointerId); } catch (_) {}
        if (selectable && drag.moved < 7) pickSceneObject(event);
    };
    host.addEventListener('pointerdown', event => { if (event.button !== 0) return; engine.drag = { x: event.clientX, y: event.clientY, moved: 0 }; host.setPointerCapture?.(event.pointerId); });
    host.addEventListener('pointermove', move); host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
    host.addEventListener('wheel', event => {
        event.preventDefault(); const config = engine.kind === 'studio' ? state.studioConfig.camera : sceneSettings(sceneById()).camera;
        config.distance = clamp(config.distance + event.deltaY * .01, 1.5, 14, 5.2);
        if (engine.kind === 'studio') { applyStudioControls(); renderStudio(); } else { renderScene(); scheduleSceneSave(); }
    }, { passive: false });
}
function pickSceneObject(event) {
    const engine = state.sceneEngine; if (!engine) return;
    const rect = engine.renderer.domElement.getBoundingClientRect(); const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, engine.camera); const hits = raycaster.intersectObjects(engine.objects.children, true);
    const hit = hits.find(item => { let node = item.object; while (node) { if (node.userData?.sceneObjectId) return true; node = node.parent; } return false; });
    if (!hit) return; let node = hit.object; while (node && !node.userData?.sceneObjectId) node = node.parent; if (node?.userData?.sceneObjectId) selectSceneObject(node.userData.sceneObjectId);
}

async function saveScene(showToast = false) {
    const scene = sceneById(); if (!scene) return;
    const payload = { name: scene.name, background_url: scene.background_url, background_name: scene.background_name, objects: scene.objects || [], settings: sceneSettings(scene), composition_prompt: scene.composition_prompt || '', control_image_url: scene.control_image_url || '' };
    try {
        const data = await requestJson(`/api/soft-furnishing/scenes/${encodeURIComponent(scene.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        state.scenes = data.scenes || state.scenes; renderAll(); if (showToast) toast('软装场景已保存');
    } catch (error) { toast(error?.message || '保存场景失败', 'error'); }
}
function scheduleSceneSave() { clearTimeout(state.sceneSaveTimer); state.sceneSaveTimer = window.setTimeout(() => saveScene(false), 650); }
function scheduleAssetSave() { clearTimeout(state.assetSaveTimer); state.assetSaveTimer = window.setTimeout(() => persistAsset(false), 650); }
async function persistAsset(showToast = false) {
    const asset = assetById(); if (!asset) return;
    try {
        const data = await requestJson(`/api/product-3d/assets/${encodeURIComponent(asset.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: asset.name, category: asset.category, dimensions: asset.dimensions, studio: asset.studio }) });
        state.assets = data.assets || state.assets; renderAll(); if (showToast) toast('商品资产已保存');
    } catch (error) { toast(error?.message || '保存商品资产失败', 'error'); }
}
function updateAssetFromInspector(input) {
    const asset = assetById(); if (!asset) return;
    if (input.dataset.assetField) asset[input.dataset.assetField] = input.value;
    if (input.dataset.dimension) asset.dimensions = { ...asset.dimensions, [input.dataset.dimension]: clamp(input.value, 1, 100000, 800) };
    state.assetPrototypes.clear(); renderAssetList(); scheduleAssetSave(); loadStudioAsset();
}
function updateObjectFromInspector(input) {
    const object = selectedSceneObject(); if (!object) return;
    if (input.dataset.objectField) object[input.dataset.objectField] = input.value;
    if (input.dataset.objectNumber) {
        const ranges = { x: [-30, 30, 0], y: [-10, 10, -1.35], z: [-30, 30, 0], rotation: [-360, 360, 0], scale: [.05, 20, 1] };
        const [min, max, fallback] = ranges[input.dataset.objectNumber]; object[input.dataset.objectNumber] = clamp(input.value, min, max, fallback);
    }
    renderAssetList(); renderSceneObjectList(); scheduleSceneSave(); syncSceneObjects();
}
function deleteSelectedSceneObject() {
    const scene = sceneById(); const object = selectedSceneObject(); if (!scene || !object) return;
    if (!window.confirm(`从场景移除“${object.name}”？`)) return;
    scene.objects = scene.objects.filter(item => item.id !== object.id); state.selectedObjectId = ''; renderAll(); syncSceneObjects(); scheduleSceneSave(); toast('已从场景移除对象');
}

async function chooseSceneBackground() {
    const scene = await ensureSelectedScene(); if (!scene) return;
    $('sceneBackgroundInput').click();
}
async function handleSceneBackground(file) {
    if (!file) return; const scene = await ensureSelectedScene(); if (!scene) return;
    status('scene', '正在上传场景图…', 'loading');
    try {
        const uploaded = await uploadFile(file, 'room-background.png'); scene.background_url = uploaded.url; scene.background_name = uploaded.name || file.name; renderAll(); await applySceneBackground(); await syncSceneObjects(); scheduleSceneSave(); status('scene', '场景图已加载，可继续摆放商品', 'ready'); toast('场景图已上传');
    } catch (error) { status('scene', '场景图上传失败'); toast(error?.message || '场景图上传失败', 'error'); }
}
async function handleEnvironmentFile(file) {
    const asset = assetById(); if (!asset || !file) { if (!asset) toast('请先选择一个商品资产', 'error'); return; }
    status('studio', '正在上传环境文件…', 'loading');
    try {
        const uploaded = await uploadFile(file, 'environment.hdr'); state.studioConfig.environment = { ...state.studioConfig.environment, url: uploaded.url, name: uploaded.name || file.name }; applyStudioControls(); await applyStudioEnvironment(); await saveStudioSettings(false); status('studio', '环境参数已保存', 'ready'); toast('环境文件已保存到商品预演参数');
    } catch (error) { status('studio', '环境文件上传失败'); toast(error?.message || '环境文件上传失败', 'error'); }
}
async function createSceneControlImage() {
    const scene = sceneById(); const engine = state.sceneEngine; if (!scene || !engine || state.generatingScene) return;
    state.generatingScene = true; renderAll(); status('scene', '正在导出场景编排图…', 'loading'); renderScene();
    try {
        const blob = await blobFromCanvas(engine.renderer.domElement); const file = new File([blob], `${scene.name || 'soft-furnishing'}-编排图.png`, { type: 'image/png' }); const uploaded = await uploadFile(file, 'soft-furnishing-control.png');
        scene.control_image_url = uploaded.url; await saveScene(false); status('scene', '编排图已保存，可发送到画布', 'ready'); toast('场景编排图已生成');
    } catch (error) { status('scene', '编排图导出失败'); toast(error?.message || '编排图导出失败', 'error'); }
    finally { state.generatingScene = false; renderAll(); }
}
async function sendToCanvas() {
    const scene = sceneById(); if (!scene?.control_image_url) { toast('请先生成场景编排图', 'error'); return; }
    const prompt = String(scene.composition_prompt || '').trim() || '以此软装编排图为严格空间布局参考：保留各产品的位置、尺寸比例、朝向和相机透视；产品主体材质准确、结构完整，环境光自然，画面真实。';
    const payload = { nonce: `soft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, queued_at: Date.now(), image: { url: scene.control_image_url, name: `${scene.name || '软装场景'}-编排图.png`, kind: 'image' }, prompt, scene_name: scene.name || '软装场景' };
    try { localStorage.setItem(INBOX_KEY, JSON.stringify(payload)); } catch (_) {}
    try {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'soft-furnishing-send-to-canvas', payload }, '*');
            toast('已发送到小美画布');
        } else {
            window.location.href = '/static/canvas-list.html?v=2026.09.05.4';
        }
    }
    catch (error) { toast(error?.message || '无法发送到画布', 'error'); }
}

function openAssetDialog() {
    state.assetDraft = { imageFile: null, modelFile: null }; $('assetForm').reset(); $('assetCategory').value = 'sofa'; $('assetWidth').value = '800'; $('assetDepth').value = '800'; $('assetHeight').value = '800';
    $('assetImageLabel').textContent = '可选 · PNG / JPG / WEBP'; $('assetModelLabel').textContent = '可选 · GLB / GLTF / OBJ'; $('assetImageButton').classList.remove('has-file'); $('assetModelButton').classList.remove('has-file');
    if (typeof ui.assetDialog.showModal === 'function') ui.assetDialog.showModal(); else ui.assetDialog.setAttribute('open', ''); refreshIcons();
}
function closeAssetDialog() { if (typeof ui.assetDialog.close === 'function') ui.assetDialog.close(); else ui.assetDialog.removeAttribute('open'); }
async function submitAssetDialog(event) {
    event.preventDefault(); const name = $('assetName').value.trim(); const imageFile = state.assetDraft.imageFile; const modelFile = state.assetDraft.modelFile;
    if (!imageFile && !modelFile) { toast('请至少选择产品图或 3D 模型', 'error'); return; }
    const button = $('assetDialogSave'); button.disabled = true; button.querySelector('span').textContent = '正在上传…';
    try {
        const [image, model] = await Promise.all([imageFile ? uploadFile(imageFile, 'product.png') : Promise.resolve(null), modelFile ? uploadFile(modelFile, 'product.glb') : Promise.resolve(null)]);
        const payload = { name: name || (image?.name || model?.name || '未命名商品模型').replace(/\.[^.]+$/, ''), category: $('assetCategory').value, image_url: image?.url || '', image_name: image?.name || '', model_url: model?.url || '', model_name: model?.name || '', dimensions: { width_mm: $('assetWidth').value, depth_mm: $('assetDepth').value, height_mm: $('assetHeight').value }, studio: studioConfig() };
        const data = await requestJson('/api/product-3d/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        state.assets = data.assets || state.assets; state.selectedAssetId = data.asset?.id || state.assets[0]?.id || ''; state.studioConfig = studioConfig(assetById()?.studio); closeAssetDialog(); applyStudioControls(); renderAll(); await ensureStudioEngine(); await loadStudioAsset(); toast('商品资产已保存');
    } catch (error) { toast(error?.message || '保存商品资产失败', 'error'); }
    finally { button.disabled = false; button.querySelector('span').textContent = '保存商品资产'; }
}

function bindUi() {
    document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));
    $('addAssetButton').addEventListener('click', openAssetDialog);
    document.querySelectorAll('[data-open-asset-dialog]').forEach(button => {
        button.addEventListener('pointerdown', event => event.stopPropagation());
        button.addEventListener('click', openAssetDialog);
    });
    $('newSceneButton').addEventListener('click', async () => { await createScene(); await switchMode('scene'); });
    $('assetDialogClose').addEventListener('click', closeAssetDialog); $('assetDialogCancel').addEventListener('click', closeAssetDialog); ui.assetForm.addEventListener('submit', submitAssetDialog);
    $('assetImageButton').addEventListener('click', () => $('assetImageInput').click()); $('assetModelButton').addEventListener('click', () => $('assetModelInput').click());
    $('assetImageInput').addEventListener('change', event => { const file = event.target.files?.[0]; if (!file) return; state.assetDraft.imageFile = file; $('assetImageLabel').textContent = file.name; $('assetImageButton').classList.add('has-file'); });
    $('assetModelInput').addEventListener('change', event => { const file = event.target.files?.[0]; if (!file) return; if (!MODEL_EXTENSIONS.has(extension(file.name))) { toast('3D 模型仅支持 GLB、GLTF 或 OBJ', 'error'); return; } state.assetDraft.modelFile = file; $('assetModelLabel').textContent = file.name; $('assetModelButton').classList.add('has-file'); });
    $('environmentSelectButton').addEventListener('click', () => { if (!assetById()) toast('请先选择一个商品资产', 'error'); else $('environmentInput').click(); }); $('environmentInput').addEventListener('change', event => handleEnvironmentFile(event.target.files?.[0]));
    $('sceneBackgroundButton').addEventListener('click', chooseSceneBackground); $('sceneBackgroundInput').addEventListener('change', event => handleSceneBackground(event.target.files?.[0]));
    $('addSceneObjectButton').addEventListener('click', () => addSceneObject()); document.querySelectorAll('[data-add-proxy]').forEach(button => button.addEventListener('click', () => addSceneObject(button.dataset.addProxy, '')));
    $('saveStudioButton').addEventListener('click', () => saveStudioSettings(true)); $('sixViewsButton').addEventListener('click', generateSixViews); $('saveSceneButton').addEventListener('click', () => saveScene(true)); $('renderSceneButton').addEventListener('click', createSceneControlImage); $('sendCanvasButton').addEventListener('click', sendToCanvas);
    $('scenePrompt').addEventListener('input', event => { const scene = sceneById(); if (!scene) return; scene.composition_prompt = event.target.value; scheduleSceneSave(); });
    document.querySelectorAll('#studioViewButtons [data-studio-view]').forEach(button => button.addEventListener('click', () => setStudioCameraView(button.dataset.studioView)));
    document.querySelectorAll('.studio-controls input[type="range"]').forEach(input => input.addEventListener('input', () => { updateRangeVisual(input); updateStudioFromControls(); }));
    document.querySelector('[data-reset-studio]').addEventListener('click', () => { state.studioConfig.camera = deepClone(STUDIO_DEFAULTS.camera); applyStudioControls(); renderStudio(); });
    window.addEventListener('resize', () => { renderStudio(); renderScene(); });
    window.addEventListener('beforeunload', () => { disposeEngine(state.studioEngine); disposeEngine(state.sceneEngine); });
}
async function switchMode(mode) {
    state.mode = mode === 'scene' ? 'scene' : 'studio';
    document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
    ui.studioPanel.classList.toggle('active', state.mode === 'studio'); ui.scenePanel.classList.toggle('active', state.mode === 'scene'); ui.studioPanel.hidden = state.mode !== 'studio'; ui.scenePanel.hidden = state.mode !== 'scene';
    renderInspector();
    if (state.mode === 'studio') { await ensureStudioEngine(); await loadStudioAsset(); }
    else { await ensureSceneEngine(); await syncSceneVisuals(); }
}
function startRenderLoop() {
    const frame = () => { if (state.mode === 'studio') renderStudio(); else renderScene(); state.renderLoop = requestAnimationFrame(frame); };
    if (!state.renderLoop) state.renderLoop = requestAnimationFrame(frame);
}
async function boot() {
    bindUi();
    document.querySelectorAll('input[type="range"]').forEach(updateRangeVisual);
    try {
        const [assets, scenes] = await Promise.all([requestJson('/api/product-3d/assets'), requestJson('/api/soft-furnishing/scenes')]);
        state.assets = assets.assets || []; state.scenes = scenes.scenes || []; state.selectedAssetId = state.assets[0]?.id || ''; state.selectedSceneId = state.scenes[0]?.id || '';
        state.studioConfig = studioConfig(assetById()?.studio); applyStudioControls(); renderAll(); await ensureStudioEngine(); await loadStudioAsset(); startRenderLoop();
    } catch (error) { toast(error?.message || '无法加载 3D 软装数据', 'error'); renderAll(); }
}

boot();
