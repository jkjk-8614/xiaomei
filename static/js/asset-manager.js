const root = document.getElementById('assetManagerRoot');
const statusEl = document.getElementById('assetStatus');
const refreshBtn = document.getElementById('refreshBtn');
const storageSettingsBtn = document.getElementById('storageSettingsBtn');
const uploadInput = document.getElementById('assetUploadInput');

const LOCAL_CAPTION_SETTINGS_KEY = 'asset_manager_local_caption_settings_v1';
function readLocalCaptionSettings(){
    try {
        const data = JSON.parse(localStorage.getItem(LOCAL_CAPTION_SETTINGS_KEY) || '{}');
        return data && typeof data === 'object' ? data : {};
    } catch(_) {
        return {};
    }
}
function writeLocalCaptionSettings(){
    try {
        localStorage.setItem(LOCAL_CAPTION_SETTINGS_KEY, JSON.stringify({
            provider:localCaptionProvider || '',
            model:localCaptionModel || '',
            captionPrompt:localCaptionPrompt || '描述图片',
            classifyPrompt:localClassifyPrompt || ''
        }));
    } catch(_) {}
}
const savedLocalCaptionSettings = readLocalCaptionSettings();

let activeTab = 'assets';
let skillManagerOpen = false;
let assetLibrary = {libraries:[], categories:[]};
let promptLibrary = {libraries:[]};
let apiProviders = [];
let avatarRegisterProvider = '';
let avatarBusyId = '';
let activeAssetLibraryId = '';
let activeAssetCategoryId = '';
let activeAssetClassFilter = '';
let openAssetClassGroup = 'environment';
let activeWorkflowLibraryId = '';
let activeWorkflowCategoryId = '';
let activePromptLibraryId = '';
let activePromptCategory = 'all';
let assetTreeFocus = 'category';
let promptTreeFocus = 'category';
let selectedAssetId = '';
let selectedWorkflowId = '';
let selectedPromptId = '';
let selectedAssetIds = new Set();
let selectedWorkflowIds = new Set();
let selectedPromptIds = new Set();
let assetQuery = '';
let workflowQuery = '';
let promptQuery = '';
let assetManageMode = false;
let workflowManageMode = false;
let promptManageMode = false;
let assetMoveTarget = '';
let assetClipboard = null;
let managedSelectionPointerGuard = null;
let assetEditMode = false;
let promptEditMode = false;
let promptCreateMode = false;
let pendingDeleteAssetId = '';
let pendingDeletePromptId = '';
let pendingBatchDelete = '';
let assetTreeEdit = null;
let workflowTreeEdit = null;
let promptTreeEdit = null;
let pendingTreeDelete = '';
let marqueeState = null;
let sharedFolders = [];
let activeSharedFolderId = '';
let activeSharedFolderName = '';
let localFolders = [];
let localFolderMap = new Map();
let localItemMap = new Map();
let activeLocalFolderId = '';
let selectedLocalId = '';
let selectedLocalIds = new Set();
let localQuery = '';
let localManageMode = false;
let localClipboard = null;
let localCaptionBusy = false;
let localCaptionProvider = savedLocalCaptionSettings.provider || '';
let localCaptionModel = savedLocalCaptionSettings.model || '';
let localCaptionPrompt = savedLocalCaptionSettings.captionPrompt || '描述图片';
let localClassifyPrompt = savedLocalCaptionSettings.classifyPrompt || '';
let localClassifyPromptOpen = false;
let localAssets = [];
let localAssetsLoaded = false;
let localUploadTree = null;
let activeLocalUploadFolder = '';
let activeLocalUploadClassFilter = '';
let openLocalUploadClassGroup = '';
let selectedLocalUploadId = '';
let selectedLocalUploadIds = new Set();
let localUploadQuery = '';
let localUploadManageMode = false;
let localUploadClipboard = null;
let localUploadFolderCreateMode = false;
let assetClassifyBusy = false;
let backgroundRemovalBusy = false;
let assetCategoryLocalImportBusy = false;
let assetContextMenuId = '';
let localClassifyBusy = false;
let assetUploadBusy = false;
let uploadAssetsState = {view:'disk', items:[], projects:[], canvases:[], unassigned_count:0, loading:false, loadingMore:false, hasMore:false, offset:0, total:0, query:'', projectId:'', canvasId:'', selectedId:'', loaded:false, pageSize:120, requestId:0, reloadPending:false, error:''};
let lightboxPanState = null;
let canvasAssetsData = {categories:[], projects:[], canvases:[], items:[]};
let activeCanvasAssetProjectId = '';
let activeCanvasAssetCanvasId = '';
let selectedCanvasAssetId = '';
let selectedCanvasAssetIds = new Set();
let canvasAssetQuery = '';
let canvasAssetSort = 'canvas_asc';
let canvasAssetManageMode = false;
let generatedManageMode = false;
let generatedAssetsState = {items:[], selectedId:'', selectedIds:new Set(), query:'', folder:'', mediaType:'all', mediaCounts:{image:0,video:0}, allTotal:0, loading:false, loadingMore:false, loaded:false, offset:0, total:0, hasMore:false, pageSize:80, restoreScrollTop:null};
const GENERATED_PROJECTS_COLLAPSED_KEY = 'asset_manager_generated_projects_collapsed_v1';
function readGeneratedProjectsCollapsed(){
    try { return localStorage.getItem(GENERATED_PROJECTS_COLLAPSED_KEY) === '1'; } catch(_) { return false; }
}
let generatedProjectsCollapsed = readGeneratedProjectsCollapsed();
const videoThumbPosterCache = new Map();
let searchCompositionActive = false;
let searchRenderTimer = null;
let lastSearchCompositionEndAt = 0;
let storageSettingsState = {open:false, tab:'prefs', editor:'', imageSpace:'', dirs:{}, defaults:{}, kind:'generated', items:[], selected:new Set(), loading:false, loadingMore:false, offset:0, total:0, hasMore:false, pageSize:80, restoreScrollTop:null, classificationPrompt:'', defaultClassificationPrompt:''};
// ===== 资产管理：提示词集合（原独立提示词库页并入）与收藏状态 =====
let promptCases = [];
let promptCaseCategories = [];
let promptCasesLoaded = false;
let promptCasesLoading = false;
let hubView = 'cases'; // 'favorites' | 'cases' | 'prompts'
let hubPromptView = 'mine'; // 'mine' | 'system'
let hubCaseCategory = '';
let hubQuery = '';
let hubSort = 'recent';
let hubTag = '';
let selectedHubCaseId = '';
let hubCaseVariantIndex = 0;
let hubCaseDrawerOpen = false;
let caseCategoryModalOpen = false;
let pendingDeleteCaseId = '';
// 生成素材/本地素材等文件型资源的收藏登记（key -> 收藏条目）
let fileFavoriteMap = new Map();
let fileFavoriteBusy = new Set();
let assetFavoritesOnly = false;
let workflowFavoritesOnly = false;
let generatedFavoritesOnly = false;
let localFavoritesOnly = false;
let promptDetailContext = 'manager'; // 'manager' = 提示词模板标签页 | 'hub' = 提示词标签页
let storageFolderPickerBusy = false;
let storageFolderPickerRequestId = 0;
let imageSpaceSettings = {root:'', dirs:{}, legacyDirs:{}, unified:false};

const LOCAL_MEDIA_EXTS = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|mp3|wav|flac|ogg|m4a|aac)(\?|#|$)/i;
const ASSET_CATEGORY_DRAG_TYPE = 'application/x-xiaomei-asset-category';
let assetCategoryDragState = null;
const SEARCH_INPUT_IDS = new Set(['assetSearch','workflowSearch','promptSearch','hubSearch','localSearch','localUploadSearch','canvasAssetSearch','generatedSearch']);

function refreshIcons(){ if(window.lucide) lucide.createIcons(); }
function setStatus(text='准备就绪'){ if(statusEl) statusEl.textContent = text || '准备就绪'; }
function escapeHtml(value=''){
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function escapeAttr(value=''){ return escapeHtml(value); }
async function copyTextToClipboard(text){
    const value = String(text || '');
    if(!value) return false;
    try {
        if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(value); return true; }
    } catch(_) {}
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch(_) { return false; }
}
async function apiJson(url, options={}){
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.detail || data.message || '操作失败');
    return data;
}
const STORAGE_KIND_LABELS = {upload:'上传素材', generated:'生成素材', local:'本地素材'};
const IMAGE_SPACE_TABS = new Set(['assets','generated','local']);
function syncImageSpaceSubtabs(){
    const subTabs = document.getElementById('imageSpaceSubtabs');
    if(!subTabs) return;
    const inSpace = IMAGE_SPACE_TABS.has(activeTab);
    subTabs.hidden = !inSpace;
    subTabs.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
}
async function openStorageSettings(options={}){
    storageSettingsState.open = true;
    storageSettingsState.tab = options.tab || 'manage';
    storageSettingsState.editor = '';
    storageSettingsState.selected = new Set();
    renderStorageSettingsModal();
    try {
        const [data, promptData] = await Promise.all([
            apiJson('/api/storage-settings'),
            apiJson('/api/asset-classification-prompt')
        ]);
        imageSpaceSettings = {
            root:data.image_space || data.root || '',
            dirs:data.dirs || {},
            legacyDirs:data.legacy_dirs || {},
            unified:Boolean(data.unified)
        };
        storageSettingsState.imageSpace = imageSpaceSettings.root;
        storageSettingsState.dirs = data.dirs || {};
        storageSettingsState.defaults = data.defaults || {};
        storageSettingsState.classificationPrompt = promptData.prompt || '';
        storageSettingsState.defaultClassificationPrompt = promptData.default_prompt || '';
        await loadStorageFiles(storageSettingsState.kind || 'generated');
    } catch(err){
        setStatus(err.message || '加载存储设置失败');
        renderStorageSettingsModal();
    }
}
function closeStorageSettings(){
    storageSettingsState.open = false;
    document.getElementById('storageSettingsOverlay')?.remove();
}
function syncStorageSettingsInputsToState(){
    storageSettingsState.dirs = storageSettingsState.dirs || {};
    ['upload','generated','local'].forEach(kind => {
        const el = document.getElementById(`storageDir_${kind}`);
        if(el) storageSettingsState.dirs[kind] = el.value.trim();
    });
    const rootEl = document.getElementById('storageImageSpaceRoot');
    if(rootEl) storageSettingsState.imageSpace = rootEl.value.trim();
    const providerEl = document.getElementById('prefCaptionProvider');
    const modelEl = document.getElementById('prefCaptionModel');
    const captionEl = document.getElementById('prefCaptionPrompt');
    const classifyEl = document.getElementById('prefClassifyPrompt');
    const ruleEl = document.getElementById('prefClassificationRulePrompt');
    if(providerEl) localCaptionProvider = providerEl.value || '';
    if(modelEl) localCaptionModel = modelEl.value || '';
    if(captionEl) localCaptionPrompt = captionEl.value || '描述图片';
    if(classifyEl) localClassifyPrompt = classifyEl.value || '';
    if(ruleEl) storageSettingsState.classificationPrompt = ruleEl.value || '';
}
async function saveStorageSettings(options={}){
    syncStorageSettingsInputsToState();
    normalizeLocalCaptionSettings();
    writeLocalCaptionSettings();
    const hasDirInputs = Boolean(document.getElementById('storageImageSpaceRoot')) || ['upload','generated','local'].some(kind => document.getElementById(`storageDir_${kind}`));
    const hasClassificationInput = Boolean(document.getElementById('prefClassificationRulePrompt'));
    const shouldSaveDirs = options.saveDirs ?? hasDirInputs;
    const shouldSaveClassification = options.saveClassification ?? hasClassificationInput;
    const tasks = {};
    if(shouldSaveDirs){
        const payload = {image_space:storageSettingsState.imageSpace || imageSpaceSettings.root || '', migrate_legacy:true};
        tasks.dirs = apiJson('/api/storage-settings', {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(payload)
        });
    }
    if(shouldSaveClassification){
        tasks.classification = apiJson('/api/asset-classification-prompt', {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({prompt:storageSettingsState.classificationPrompt || ''})
        });
    }
    const [data, promptData] = await Promise.all([
        tasks.dirs || Promise.resolve(null),
        tasks.classification || Promise.resolve(null)
    ]);
    if(data){
        storageSettingsState.dirs = data.dirs || storageSettingsState.dirs || {};
        storageSettingsState.imageSpace = data.image_space || data.root || storageSettingsState.imageSpace || '';
        storageSettingsState.lastMigration = data.migration || null;
        imageSpaceSettings = {root:storageSettingsState.imageSpace, dirs:storageSettingsState.dirs, legacyDirs:data.legacy_dirs || {}, unified:Boolean(data.unified)};
    }
    if(promptData) storageSettingsState.classificationPrompt = promptData.prompt || storageSettingsState.classificationPrompt || '';
    storageSettingsState.selected = new Set();
    if(data) await loadStorageFiles(storageSettingsState.kind);
    setStatus('偏好设置已保存');
}
async function loadStorageFiles(kind, options={}){
    const append = Boolean(options.append);
    const nextKind = kind || 'generated';
    if(storageSettingsState.loading || storageSettingsState.loadingMore) return;
    const currentGrid = document.querySelector('[data-storage-file-grid]');
    const keepScrollTop = append && currentGrid ? currentGrid.scrollTop : null;
    storageSettingsState.kind = nextKind;
    if(append){
        if(!storageSettingsState.hasMore) return;
        storageSettingsState.loadingMore = true;
    } else {
        storageSettingsState.items = [];
        storageSettingsState.offset = 0;
        storageSettingsState.total = 0;
        storageSettingsState.hasMore = false;
        storageSettingsState.selected = new Set();
        storageSettingsState.loading = true;
    }
    if(!append) renderStorageSettingsModal();
    try {
        const offset = append ? storageSettingsState.offset : 0;
        const limit = storageSettingsState.pageSize || 80;
        const data = await apiJson(`/api/storage-files?kind=${encodeURIComponent(storageSettingsState.kind)}&offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`);
        const items = data.items || [];
        storageSettingsState.items = append ? [...storageSettingsState.items, ...items] : items;
        storageSettingsState.offset = offset + items.length;
        storageSettingsState.total = Number(data.total || storageSettingsState.items.length || 0);
        storageSettingsState.hasMore = Boolean(data.has_more);
        storageSettingsState.selected = new Set([...storageSettingsState.selected].filter(id => storageSettingsState.items.some(item => item.id === id)));
    } finally {
        storageSettingsState.loading = false;
        storageSettingsState.loadingMore = false;
        storageSettingsState.restoreScrollTop = keepScrollTop;
        renderStorageSettingsModal();
    }
}
function handleStorageFileGridScroll(event){
    const grid = event.currentTarget;
    if(!grid || storageSettingsState.loading || storageSettingsState.loadingMore || !storageSettingsState.hasMore) return;
    if(grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 260){
        loadStorageFiles(storageSettingsState.kind, {append:true}).catch(err => setStatus(err.message || '加载更多图片失败'));
    }
}
function renderStorageSettingsModal(){
    if(!storageSettingsState.open) return;
    normalizeLocalCaptionSettings();
    const providers = localCaptionProviders();
    const models = localCaptionModels();
    let overlay = document.getElementById('storageSettingsOverlay');
    if(!overlay){
        overlay = document.createElement('div');
        overlay.id = 'storageSettingsOverlay';
        overlay.className = 'storage-settings-overlay';
        document.body.appendChild(overlay);
    }
    const dirs = storageSettingsState.dirs || {};
    const kind = storageSettingsState.kind || 'generated';
    const selectedCount = storageSettingsState.selected.size;
    const imageSpaceRoot = storageSettingsState.imageSpace || imageSpaceSettings.root || '';
    const displayDirs = ['upload','generated','local'].reduce((result, key) => {
        result[key] = imageSpaceRoot ? `${imageSpaceRoot.replace(/[\\/]+$/, '')}\\${STORAGE_KIND_LABELS[key]}` : (dirs[key] || '');
        return result;
    }, {});
    const rows = ['upload','generated','local'].map(key => `
        <label class="storage-dir-row">
            <span>${STORAGE_KIND_LABELS[key]}</span>
            <div class="storage-dir-control">
                <input id="storageDir_${key}" value="${escapeAttr(displayDirs[key])}" placeholder="${escapeAttr(storageSettingsState.defaults?.[key] || '')}" readonly>
            </div>
        </label>
    `).join('');
    const tabs = ['generated','upload','local'].map(key => `
        <button class="${kind === key ? 'active' : ''}" type="button" data-storage-kind="${key}">
            <span>${STORAGE_KIND_LABELS[key]}</span>
        </button>
    `).join('');
    const loadedCount = storageSettingsState.items.length;
    const cards = storageSettingsState.loading
        ? `<div class="storage-empty">正在读取目录...</div>`
        : storageSettingsState.items.length
        ? storageSettingsState.items.map(item => `
            <label class="storage-file-card ${storageSettingsState.selected.has(item.id) ? 'selected' : ''}">
                <input type="checkbox" data-storage-file="${escapeAttr(item.id)}" data-storage-rel="${escapeAttr(item.rel)}" ${storageSettingsState.selected.has(item.id) ? 'checked' : ''}>
                <div class="storage-file-thumb">${assetThumb(item)}</div>
                <span title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</span>
                <em>${assetKindLabel(item)} · ${formatFileSize(item.size)}${item.width ? ` · ${item.width}×${item.height}` : ''}</em>
            </label>
        `).join('') + (storageSettingsState.hasMore || storageSettingsState.loadingMore
            ? `<div class="storage-load-more">${storageSettingsState.loadingMore ? '继续加载中...' : `已加载 ${loadedCount} / ${storageSettingsState.total || loadedCount}，向下滚动继续`}</div>`
            : `<div class="storage-load-more done">已加载全部 ${loadedCount} 个</div>`)
        : `<div class="storage-empty">这个目录里暂时没有素材</div>`;
    const activePrefTab = storageSettingsState.tab || 'prefs';
    const captionOpen = storageSettingsState.editor === 'caption';
    const classifyOpen = storageSettingsState.editor === 'classify';
    const prefsBody = `
        <div class="asset-pref-section">
            <button class="asset-pref-fold ${captionOpen ? 'open' : ''}" type="button" data-pref-editor="caption">
                <span><i data-lucide="message-square-text"></i><b>反推提示词</b></span>
                <em>${escapeHtml(localCaptionPrompt || '描述图片')}</em>
                <i data-lucide="${captionOpen ? 'chevron-up' : 'chevron-down'}"></i>
            </button>
            ${captionOpen ? `
                <div class="asset-pref-editor">
                    <label class="storage-dir-row">
                        <span>反推提示词</span>
                        <textarea id="prefCaptionPrompt" placeholder="描述图片">${escapeHtml(localCaptionPrompt || '描述图片')}</textarea>
                    </label>
                    <div class="asset-pref-editor-actions">
                        <button class="asset-btn primary" type="button" data-pref-editor-save="caption"><i data-lucide="save"></i><span>保存</span></button>
                    </div>
                </div>
            ` : ''}
            <button class="asset-pref-fold ${classifyOpen ? 'open' : ''}" type="button" data-pref-editor="classify">
                <span><i data-lucide="tags"></i><b>智能分类提示词</b></span>
                <em>编辑分类规则和追加要求</em>
                <i data-lucide="${classifyOpen ? 'chevron-up' : 'chevron-down'}"></i>
            </button>
            ${classifyOpen ? `
                <div class="asset-pref-editor">
                    <label class="storage-dir-row">
                        <span>智能分类追加要求</span>
                        <textarea id="prefClassifyPrompt" placeholder="可追加分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。">${escapeHtml(localClassifyPrompt || '')}</textarea>
                    </label>
                    <label class="storage-dir-row">
                        <span>智能分类规则 <button class="asset-inline-link" type="button" data-class-rule-reset>恢复内置规则</button></span>
                        <textarea id="prefClassificationRulePrompt" class="asset-pref-rule-textarea" placeholder="这里显示内置分类提示词，可按你的素材体系编辑后保存。">${escapeHtml(storageSettingsState.classificationPrompt || storageSettingsState.defaultClassificationPrompt || '')}</textarea>
                    </label>
                    <div class="asset-pref-editor-actions">
                        <button class="asset-btn primary" type="button" data-pref-editor-save="classify"><i data-lucide="save"></i><span>保存</span></button>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    const manageBody = `
        <div class="asset-pref-section">
            <div class="asset-pref-title"><i data-lucide="folder-cog"></i><span>资产管理</span></div>
            <label class="storage-dir-row image-space-root-row">
                <span>资产管理根目录</span>
                <div class="storage-dir-control">
                    <input id="storageImageSpaceRoot" class="storage-root-input" value="${escapeAttr(imageSpaceRoot)}" placeholder="例如：F:\\图片空间" readonly role="button" tabindex="0" data-storage-browse="root" title="点击选择资产管理根目录" aria-label="选择资产管理根目录">
                    <button type="button" data-storage-browse="root" title="选择资产管理根目录"><i data-lucide="folder-open"></i><span>选择</span></button>
                </div>
            </label>
                <div class="image-space-hint">资产管理包含以下三个文件夹：上传素材、生成素材、本地素材。点击上方路径或“选择”即可更换根目录；已有旧目录会保留为兼容来源，切换后不会自动删除。</div>
            <div class="storage-dir-grid">${rows}</div>
            <div class="storage-settings-actions inline">
                <button class="asset-btn primary" type="button" data-storage-save><i data-lucide="save"></i><span>保存资产管理设置</span></button>
            </div>
        </div>
        <div class="storage-file-head">
            <div class="storage-tabs">${tabs}</div>
            <div class="storage-file-actions">
                <button class="asset-btn" type="button" data-storage-select-all ${storageSettingsState.items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                <button class="asset-btn danger" type="button" data-storage-delete ${selectedCount ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>移入回收站 ${selectedCount || ''}</span></button>
            </div>
        </div>
        <div class="storage-file-grid" data-storage-file-grid>${cards}</div>
    `;
    overlay.innerHTML = `
        <div class="storage-settings-modal">
            <div class="storage-settings-head">
                <div>
                    <strong>资产管理</strong>
                    <span>统一管理上传素材、生成素材和本地素材。</span>
                </div>
                <button type="button" data-storage-close><i data-lucide="x"></i></button>
            </div>
            <div class="asset-pref-tabs">
                <button class="${activePrefTab === 'prefs' ? 'active' : ''}" type="button" data-pref-tab="prefs"><i data-lucide="sliders-horizontal"></i><span>偏好设置</span></button>
                <button class="${activePrefTab === 'manage' ? 'active' : ''}" type="button" data-pref-tab="manage"><i data-lucide="images"></i><span>素材管理</span></button>
            </div>
            <div class="asset-pref-body">${activePrefTab === 'manage' ? manageBody : prefsBody}</div>
        </div>
    `;
    const fileGrid = overlay.querySelector('[data-storage-file-grid]');
    fileGrid?.addEventListener('scroll', handleStorageFileGridScroll, {passive:true});
    if(fileGrid && storageSettingsState.restoreScrollTop !== null){
        fileGrid.scrollTop = storageSettingsState.restoreScrollTop;
        storageSettingsState.restoreScrollTop = null;
    }
    refreshIcons();
    prepareVideoThumbs(overlay);
}
async function deleteSelectedStorageFiles(){
    const selected = storageSettingsState.items.filter(item => storageSettingsState.selected.has(item.id));
    if(!selected.length) return;
    if(!confirm(`确认将 ${selected.length} 个素材移入回收站？之后可从统一素材回收站恢复。`)) return;
    const data = await apiJson('/api/storage-files/delete', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind:storageSettingsState.kind, items:selected.map(item => item.rel)})
    });
    storageSettingsState.selected.clear();
    await loadStorageFiles(storageSettingsState.kind);
    setStatus(`已将 ${data.removed || 0} 个文件移入回收站`);
}
function generatedAssetItems(){
    return generatedAssetsState.items || [];
}
function findGeneratedAsset(id){
    return (generatedAssetsState.items || []).find(item => item.id === id) || null;
}
function findUploadAsset(id){ return (uploadAssetsState.items || []).find(item => item.id === id) || null; }
function uploadAssetProjectName(id){ return (uploadAssetsState.projects || []).find(project => project.id === id)?.name || '未归属项目'; }
async function loadUploadAssets(options={}){
    const append = Boolean(options.append);
    if(uploadAssetsState.loading || uploadAssetsState.loadingMore){
        if(!append) uploadAssetsState.reloadPending = true;
        return;
    }
    if(append && !uploadAssetsState.hasMore) return;
    const grid = document.querySelector('[data-upload-file-grid]');
    const keepScrollTop = append && grid ? grid.scrollTop : null;
    const requestId = ++uploadAssetsState.requestId;
    const scopeSnapshot = {projectId:uploadAssetsState.projectId || '', canvasId:uploadAssetsState.canvasId || '', query:uploadAssetsState.query || ''};
    if(append) uploadAssetsState.loadingMore = true;
    else { uploadAssetsState.loading = true; uploadAssetsState.items = []; uploadAssetsState.offset = 0; uploadAssetsState.total = 0; uploadAssetsState.hasMore = false; }
    if(activeTab === 'assets') render();
    try {
        const offset = append ? uploadAssetsState.offset : 0;
        const query = new URLSearchParams({kind:'upload', offset:String(offset), limit:String(uploadAssetsState.pageSize || 120), project_id:scopeSnapshot.projectId, canvas_id:scopeSnapshot.canvasId});
        const filters = {...imageSpaceState.filters.assets, query:scopeSnapshot.query};
        if(Object.keys(filters).some(key => filters[key])) query.set('filters', JSON.stringify(filters));
        const data = await apiJson(`/api/storage-files?${query.toString()}`);
        const items = Array.isArray(data.items) ? data.items : [];
        // Ignore a slower response after the user changed project, canvas or search.
        if(requestId !== uploadAssetsState.requestId || scopeSnapshot.projectId !== (uploadAssetsState.projectId || '') || scopeSnapshot.canvasId !== (uploadAssetsState.canvasId || '') || scopeSnapshot.query !== (uploadAssetsState.query || '')) return;
        uploadAssetsState.items = append ? [...uploadAssetsState.items, ...items] : items;
        uploadAssetsState.offset = offset + items.length;
        uploadAssetsState.total = Number(data.total || 0);
        uploadAssetsState.hasMore = Boolean(data.has_more);
        uploadAssetsState.projects = Array.isArray(data.projects) ? data.projects : [];
        uploadAssetsState.canvases = Array.isArray(data.canvases) ? data.canvases : [];
        uploadAssetsState.unassigned_count = Number(data.unassigned_count || 0);
        uploadAssetsState.loaded = true;
        uploadAssetsState.error = '';
        if(!uploadAssetsState.selectedId && items.length) uploadAssetsState.selectedId = items[0].id;
    } catch(err) {
        if(requestId === uploadAssetsState.requestId) uploadAssetsState.error = err?.message || '读取上传素材失败';
        throw err;
    } finally {
        uploadAssetsState.loading = false; uploadAssetsState.loadingMore = false;
        if(uploadAssetsState.reloadPending){
            uploadAssetsState.reloadPending = false;
            await loadUploadAssets();
        } else if(activeTab === 'assets' && uploadAssetsState.view === 'disk') { render(); const next = document.querySelector('[data-upload-file-grid]'); if(next && keepScrollTop !== null) next.scrollTop = keepScrollTop; }
    }
}
function uploadAssetProjectTree(){
    const projects = uploadAssetsState.projects || [];
    return [{id:'', name:'全部上传', count:uploadAssetsState.total}, ...projects.map(item => ({...item, count:Number(item.count || 0)})), {id:'__unassigned__', name:'未归属项目', count:uploadAssetsState.unassigned_count}];
}
function renderUploadAssetCard(item){
    const refs = Array.isArray(item.references) ? item.references : [];
    const projectLabel = refs.length ? [...new Set(refs.map(ref => uploadAssetProjectName(ref.project_id)))].join('、') : '未归属项目';
    return `<article class="asset-card" data-upload-card="${escapeAttr(item.id)}"><div class="asset-thumb">${assetThumb(item)}</div><div class="asset-card-body"><div class="asset-card-name" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || '上传素材')}</div><div class="asset-card-meta">${escapeHtml(assetKindLabel(item))} · ${escapeHtml(projectLabel)}</div></div></article>`;
}
function renderUploadAssetDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>素材预览</strong><span>选择一个上传素材查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="image"></i><span>暂无可预览素材</span></div></div>`;
    const refs = Array.isArray(item.references) ? item.references : [];
    const labels = refs.length ? [...new Set(refs.map(ref => `${uploadAssetProjectName(ref.project_id)}${ref.canvas_title ? ` · ${ref.canvas_title}` : ''}`))] : [];
    return `<div class="panel-head"><div class="panel-title"><strong>素材预览</strong><span>${escapeHtml(assetKindLabel(item))}</span></div><div class="panel-actions"><button class="asset-icon-btn" type="button" data-upload-download="${escapeAttr(item.id)}" title="下载素材"><i data-lucide="download"></i></button></div></div><div class="detail-scroll"><div class="detail-media"><button class="detail-media-frame detail-media-zoomable" type="button" data-upload-preview="${escapeAttr(item.id)}" title="点击放大预览">${assetThumb(item)}</button></div><div class="detail-body"><div class="detail-name">${escapeHtml(item.name || '上传素材')}</div><div class="detail-meta-grid"><div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div><div class="detail-meta"><span>项目</span><strong>${escapeHtml(labels.length ? labels.map(label => label.split(' · ')[0]).join('、') : '未归属项目')}</strong></div><div class="detail-meta"><span>大小</span><strong>${escapeHtml(formatFileSize(item.size))}</strong></div><div class="detail-meta"><span>修改时间</span><strong>${escapeHtml(formatDate(item.created_at))}</strong></div></div><div class="detail-url">${escapeHtml(item.url || '')}</div>${labels.length ? `<div class="detail-caption-card"><div class="detail-caption-head"><strong>关联画布</strong></div><div class="detail-classification-body">${labels.map(label => `<span class="classification-chip">${escapeHtml(label)}</span>`).join('')}</div></div>` : '<div class="detail-caption-card"><div class="detail-classification-body"><span class="classification-empty">这张素材暂未被画布引用</span></div></div>'}</div></div>`;
}
function renderUploadManager(){
    const items = uploadAssetsState.items || [];
    const detail = findUploadAsset(uploadAssetsState.selectedId);
    const tree = uploadAssetProjectTree();
    const project = uploadAssetsState.projectId ? (uploadAssetsState.canvasId ? (uploadAssetsState.canvases || []).find(c => c.id === uploadAssetsState.canvasId)?.title || '画布素材' : uploadAssetProjectName(uploadAssetsState.projectId)) : '全部上传';
    const body = uploadAssetsState.error ? `<div class="empty-state" role="alert"><i data-lucide="triangle-alert"></i><strong>上传素材读取失败</strong><span>${escapeHtml(uploadAssetsState.error)}</span><button class="asset-btn primary" type="button" data-upload-retry><i data-lucide="refresh-cw"></i><span>重新读取</span></button></div>` : (uploadAssetsState.loading ? '<div class="storage-empty">正在读取上传素材目录...</div>' : `<div class="asset-grid"><button id="assetDrop" class="upload-grid-card ${assetUploadBusy ? 'uploading' : ''}" type="button" data-asset-upload><span class="upload-thumb"><i data-lucide="${assetUploadBusy ? 'loader-circle' : 'upload-cloud'}"></i></span><span class="upload-body"><strong>${assetUploadBusy ? '正在上传素材' : '上传到此项目/画布'}</strong><small>${assetUploadBusy ? '请稍候，不需要重复点击' : '拖入文件或点击上传'}</small></span></button>${items.map(renderUploadAssetCard).join('')}${!items.length ? '<div class="empty-state">上传素材目录中还没有符合条件的文件。</div>' : ''}${uploadAssetsState.hasMore ? `<div class="storage-load-more">已加载 ${items.length} / ${uploadAssetsState.total}，向下滚动继续</div>` : ''}</div>`);
    root.innerHTML = `<aside class="asset-panel asset-nav"><div class="panel-head"><div class="panel-title"><strong>上传素材</strong><span>按画布项目和画布分类</span></div><div class="panel-actions"><button class="asset-btn" type="button" data-asset-library-view><i data-lucide="layers-3"></i><span>图片资产库</span></button></div></div><div class="nav-scroll"><div class="nav-tree">${tree.map(item => `<button class="tree-row tree-parent ${uploadAssetsState.projectId === item.id && !uploadAssetsState.canvasId ? 'active' : ''}" type="button" data-upload-project="${escapeAttr(item.id)}"><span class="tree-row-icon"><i data-lucide="${item.id ? 'folder' : 'images'}"></i></span><span class="tree-row-name">${escapeHtml(item.name)}</span><span class="tree-row-count">${item.count || 0}</span></button>${item.id && uploadAssetsState.projectId === item.id ? (uploadAssetsState.canvases || []).filter(canvas => canvas.project === item.id).map(canvas => `<button class="tree-row tree-child ${uploadAssetsState.canvasId === canvas.id ? 'active' : ''}" type="button" data-upload-canvas="${escapeAttr(canvas.id)}"><span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="layers"></i></span><span class="tree-row-name">${escapeHtml(canvas.title || '未命名画布')}</span><span class="tree-row-count">${canvas.count || 0}</span></button>`).join('') : ''}`).join('')}</div><div class="nav-hint">归属来自画布引用和上传时选择的项目/画布；未关联的文件放在“未归属项目”。</div></div></aside><section class="asset-panel asset-content"><div class="content-toolbar"><div class="content-heading"><strong>${escapeHtml(project)}</strong><span>图片空间 / 上传素材 · ${uploadAssetsState.total} 个文件</span></div><div class="asset-tools"><label class="asset-search-wrap"><i data-lucide="search"></i><input id="assetSearch" class="asset-search" type="search" value="${escapeAttr(uploadAssetsState.query)}" placeholder="搜索上传素材"></label><button class="asset-btn" type="button" data-asset-upload><i data-lucide="upload-cloud"></i><span>上传素材</span></button><button class="asset-btn" type="button" data-upload-retry><i data-lucide="refresh-cw"></i><span>刷新</span></button></div></div><div class="content-scroll" data-upload-file-grid>${body}</div></section><aside class="asset-panel asset-detail">${renderUploadAssetDetail(detail)}</aside>`;
}
function generatedAssetTypeLabel(item){
    return assetKind(item) === 'video' ? '视频' : '图片';
}
function generatedMediaTypeLabel(type){
    return type === 'video' ? '视频' : type === 'image' ? '图片' : '生成素材';
}
function generatedMediaCounts(){
    const saved = generatedAssetsState.mediaCounts || {};
    const fallback = (generatedAssetsState.items || []).reduce((result, item) => {
        const kind = assetKind(item) === 'video' ? 'video' : 'image';
        result[kind] += 1;
        return result;
    }, {image:0, video:0});
    return {
        image: Number.isFinite(Number(saved.image)) ? Number(saved.image) : fallback.image,
        video: Number.isFinite(Number(saved.video)) ? Number(saved.video) : fallback.video,
    };
}
function generatedAssetSelectedItems(){
    return generatedAssetsState.items.filter(item => generatedAssetsState.selectedIds.has(item.id));
}
function renderGeneratedAssetViews(){
    if(activeTab === 'generated') render();
}
function isCanvasAssetView(){
    return activeTab === 'generated' && Boolean(activeCanvasAssetProjectId);
}
function clearCanvasAssetScope(){
    activeCanvasAssetProjectId = '';
    activeCanvasAssetCanvasId = '';
    selectedCanvasAssetId = '';
    selectedCanvasAssetIds.clear();
    canvasAssetManageMode = false;
}
async function loadGeneratedAssets(options={}){
    const append = Boolean(options.append);
    if(generatedAssetsState.loading || generatedAssetsState.loadingMore){
        if(!append) generatedAssetsState.reloadPending = true;
        return;
    }
    const currentGrid = document.querySelector('[data-generated-file-grid]');
    const keepScrollTop = append && currentGrid ? currentGrid.scrollTop : null;
    if(append){
        if(!generatedAssetsState.hasMore) return;
        generatedAssetsState.loadingMore = true;
    } else {
        generatedAssetsState.loading = true;
        generatedAssetsState.items = [];
        generatedAssetsState.offset = 0;
        generatedAssetsState.total = 0;
        generatedAssetsState.allTotal = 0;
        generatedAssetsState.mediaCounts = {image:0, video:0};
        generatedAssetsState.hasMore = false;
        generatedAssetsState.selectedIds.clear();
        renderGeneratedAssetViews();
    }
    try {
        const offset = append ? generatedAssetsState.offset : 0;
        const limit = generatedAssetsState.pageSize || 80;
        const mediaTypeQuery = generatedAssetsState.mediaType && generatedAssetsState.mediaType !== 'all'
            ? `&media_type=${encodeURIComponent(generatedAssetsState.mediaType)}`
            : '';
        const filterQuery = encodeURIComponent(JSON.stringify({...imageSpaceState.filters.generated,query:generatedAssetsState.query}));
        const folderQuery = encodeURIComponent(imageSpaceState.all.generated ? '' : generatedAssetsState.folder);
        const data = await apiJson(`/api/storage-files?kind=generated&offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}${mediaTypeQuery}&filters=${filterQuery}&folder=${folderQuery}`);
        const items = Array.isArray(data.items) ? data.items : [];
        generatedAssetsState.items = append ? [...generatedAssetsState.items, ...items] : items;
        generatedAssetsState.offset = offset + items.length;
        generatedAssetsState.total = Number(data.total || generatedAssetsState.items.length || 0);
        generatedAssetsState.allTotal = Number(data.all_total ?? data.total ?? generatedAssetsState.items.length ?? 0);
        const fallbackCounts = generatedAssetsState.items.reduce((result, item) => {
            const type = assetKind(item) === 'video' ? 'video' : 'image';
            result[type] += 1;
            return result;
        }, {image:0, video:0});
        const mediaCounts = data.media_counts || {};
        generatedAssetsState.mediaCounts = {
            image: Number.isFinite(Number(mediaCounts.image)) ? Number(mediaCounts.image) : fallbackCounts.image,
            video: Number.isFinite(Number(mediaCounts.video)) ? Number(mediaCounts.video) : fallbackCounts.video,
        };
        generatedAssetsState.hasMore = Boolean(data.has_more);
        generatedAssetsState.loaded = true;
        generatedAssetsState.selectedIds = new Set([...generatedAssetsState.selectedIds].filter(id => generatedAssetsState.items.some(item => item.id === id)));
        if(generatedAssetsState.selectedId && !findGeneratedAsset(generatedAssetsState.selectedId)) generatedAssetsState.selectedId = '';
        if(!generatedAssetsState.selectedId && generatedAssetsState.items.length) generatedAssetsState.selectedId = generatedAssetsState.items[0].id;
    } finally {
        generatedAssetsState.loading = false;
        generatedAssetsState.loadingMore = false;
        generatedAssetsState.restoreScrollTop = keepScrollTop;
        if(generatedAssetsState.reloadPending){
            generatedAssetsState.reloadPending = false;
            await loadGeneratedAssets();
        } else renderGeneratedAssetViews();
    }
}
function handleGeneratedGridScroll(event){
    const grid = event.currentTarget;
    if(!grid || generatedAssetsState.loading || generatedAssetsState.loadingMore || !generatedAssetsState.hasMore) return;
    if(grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 260){
        loadGeneratedAssets({append:true}).catch(err => setStatus(err.message || '加载更多生成素材失败'));
    }
}
function renderGeneratedManager(){
    if(isCanvasAssetView()){
        renderCanvasAssetsManager();
        return;
    }
    const allItems = generatedAssetItems();
    const items = generatedFavoritesOnly ? allItems.filter(item => isFileFavorite('generated', item)) : allItems;
    const selectedCount = generatedAssetsState.selectedIds.size;
    const selectedItems = generatedAssetSelectedItems();
    const selectedImageCount = selectedItems.filter(item => assetKind(item) === 'image').length;
    const selectedVideoCount = selectedItems.filter(item => assetKind(item) === 'video').length;
    const mediaType = generatedAssetsState.mediaType || 'all';
    const viewTotal = generatedAssetsState.total;
    const viewLabel = generatedAssetsState.folder || generatedMediaTypeLabel(mediaType);
    const detail = items.find(item => item.id === generatedAssetsState.selectedId) || items[0] || null;
    const detailKind = detail ? assetKind(detail) : 'image';
    const cards = generatedAssetsState.loading
        ? '<div class="storage-empty">正在读取生成素材目录...</div>'
        : items.length
            ? items.map(item => `<article class="asset-card generated-asset-card ${item.id === generatedAssetsState.selectedId ? 'active' : ''} ${generatedAssetsState.selectedIds.has(item.id) ? 'selected' : ''}" data-generated-card="${escapeAttr(item.id)}">
                <input class="asset-card-check generated-card-check" type="checkbox" data-generated-check="${escapeAttr(item.id)}" ${generatedAssetsState.selectedIds.has(item.id) ? 'checked' : ''} aria-label="选择 ${escapeAttr(item.name)}" title="选择这个素材">
                <button class="asset-thumb generated-asset-preview" type="button" data-generated-preview="${escapeAttr(item.id)}" title="${assetKind(item) === 'video' ? '预览视频' : '预览原图'}">${assetThumb(item)}${assetKind(item) === 'video' ? '<span class="asset-kind-badge generated-kind-badge" title="视频"><i data-lucide="play"></i></span>' : ''}</button>
                <button class="asset-card-quick asset-card-fav ${isFileFavorite('generated', item) ? 'is-fav' : ''}" type="button" data-generated-favorite="${escapeAttr(item.id)}" title="${isFileFavorite('generated', item) ? '取消收藏' : '收藏'}" aria-label="${isFileFavorite('generated', item) ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
                <div class="asset-card-body">
                    <div class="asset-card-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</div>
                    <div class="asset-card-meta">${generatedAssetTypeLabel(item)} · ${formatFileSize(item.size)}${item.width ? ` · ${item.width}×${item.height}` : ''}</div>
                    <div class="asset-card-meta" title="${escapeAttr(item.folder || '生成目录')}">${escapeHtml(item.folder || '生成目录')}</div>
                    <div class="asset-card-actions">
                        <button type="button" data-generated-preview="${escapeAttr(item.id)}" title="${assetKind(item) === 'video' ? '预览视频' : '预览'}"><i data-lucide="${assetKind(item) === 'video' ? 'play' : 'maximize-2'}"></i><span>${assetKind(item) === 'video' ? '预览视频' : '预览'}</span></button>
                        <a class="generated-card-download" href="${escapeAttr(item.url)}" download="${escapeAttr(item.name)}" title="下载"><i data-lucide="download"></i><span>下载</span></a>
                    </div>
                </div>
            </article>`).join('') + (generatedFavoritesOnly
                ? ''
                : (generatedAssetsState.hasMore || generatedAssetsState.loadingMore
                    ? `<div class="storage-load-more">${generatedAssetsState.loadingMore ? '继续加载中...' : `已加载 ${generatedAssetsState.items.length} / ${generatedAssetsState.total || generatedAssetsState.items.length}，向下滚动继续`}</div>`
                    : `<div class="storage-load-more done">已加载全部 ${generatedAssetsState.items.length} 个</div>`))
            : '<div class="storage-empty">没有找到生成素材</div>';
    root.innerHTML = `
        ${renderGeneratedNavigation()}
        <section class="asset-panel asset-content generated-assets-content ${generatedManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading"><strong>${generatedFavoritesOnly ? '我的收藏 · 生成素材' : escapeHtml(viewLabel)}</strong><span>${generatedFavoritesOnly ? `收藏的 ${items.length} 个生成素材` : `资产管理 / 生成素材${mediaType === 'all' && !generatedAssetsState.folder ? '' : ` / ${escapeHtml(generatedMediaTypeLabel(mediaType))}`} · 最新生成的素材排在前面，共 ${viewTotal} 个`}</span></div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="generatedSearch" class="asset-search" value="${escapeAttr(generatedAssetsState.query)}" placeholder="搜索文件名或目录"></label>
                    <button class="asset-btn" type="button" data-generated-refresh><i data-lucide="refresh-cw"></i><span>刷新</span></button>
                    <button class="asset-btn ${generatedManageMode ? 'primary' : ''}" type="button" data-generated-manage><i data-lucide="list-checks"></i><span>${generatedManageMode ? '完成管理' : '管理'}</span></button>
                </div>
            </div>
            ${renderImageSpaceFilterBar()}
            <div class="manage-tools generated-manage-tools">
                <div class="manage-group"><span class="manage-group-title">管理</span><span class="manage-summary">已选 ${selectedCount} 个，共 ${viewTotal} 个素材${selectedVideoCount ? ` · ${selectedVideoCount} 个视频` : ''}</span><button class="asset-btn" type="button" data-generated-select-all ${items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button><button class="asset-btn" type="button" data-generated-clear-selection ${selectedCount ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button></div>
                <div class="manage-group"><button class="asset-btn primary" type="button" data-generated-import ${selectedImageCount ? '' : 'disabled'} title="${selectedVideoCount && !selectedImageCount ? '视频暂不支持加入图片资产库' : ''}"><i data-lucide="folder-input"></i><span>加入图片资产库${selectedImageCount ? ` (${selectedImageCount})` : ''}</span></button><button class="asset-btn danger" type="button" data-generated-delete ${selectedCount ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>移入回收站 ${selectedCount ? `(${selectedCount})` : ''}</span></button></div>
            </div>
            <div class="content-scroll" data-generated-file-grid><div class="asset-grid generated-assets-grid">${cards}</div></div>
        </section>
        <aside class="asset-panel asset-detail">
            <div class="panel-head"><div class="panel-title"><strong>素材详情</strong><span>${detail ? escapeHtml(detail.name) : '选择素材查看'}</span></div></div>
            <div class="detail-scroll">${detail ? `<button class="generated-detail-preview" type="button" data-generated-preview="${escapeAttr(detail.id)}" title="${detailKind === 'video' ? '点击预览视频' : '点击查看原图'}">${assetThumb(detail)}${detailKind === 'video' ? '<span class="asset-kind-badge generated-kind-badge" title="视频"><i data-lucide="play"></i></span>' : ''}</button>${renderImageSpaceClassification(detail)}<div class="generated-detail-meta"><strong>${escapeHtml(detail.name)}</strong><span>${generatedAssetTypeLabel(detail)} · ${formatFileSize(detail.size)}${detail.width ? ` · ${detail.width}×${detail.height}` : ''}</span><span>${escapeHtml(detail.folder || '生成目录')}</span></div><div class="asset-tools"><button class="asset-btn" type="button" data-generated-preview="${escapeAttr(detail.id)}"><i data-lucide="${detailKind === 'video' ? 'play' : 'maximize-2'}"></i><span>${detailKind === 'video' ? '视频预览' : '原图预览'}</span></button><a class="asset-btn" href="${escapeAttr(detail.url)}" download="${escapeAttr(detail.name)}"><i data-lucide="download"></i><span>下载</span></a></div>` : '<div class="detail-empty"><i data-lucide="images"></i><span>暂无生成素材</span></div>'}</div>
        </aside>`;
    const grid = root.querySelector('[data-generated-file-grid]');
    grid?.addEventListener('scroll', handleGeneratedGridScroll, {passive:true});
    if(grid && generatedAssetsState.restoreScrollTop !== null){
        grid.scrollTop = generatedAssetsState.restoreScrollTop;
        generatedAssetsState.restoreScrollTop = null;
    }
}
function renderGeneratedNavigation(){
    const projectView = isCanvasAssetView();
    const mediaType = generatedAssetsState.mediaType || 'all';
    const mediaCounts = generatedMediaCounts();
    const allTotal = Number(generatedAssetsState.allTotal || generatedAssetsState.total || generatedAssetsState.items.length || 0);
    const folders = [...new Set((generatedAssetsState.items || []).map(item => item.folder || '').filter(Boolean))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
    const mediaChannels = [
        {type:'image', label:'图片', icon:'image', count:mediaCounts.image},
        {type:'video', label:'视频', icon:'video', count:mediaCounts.video},
    ];
    return `<aside class="asset-panel asset-nav">
        <div class="panel-head"><div class="panel-title"><strong>生成素材</strong><span>资产管理 / 生成素材</span></div></div>
        <div class="nav-scroll generated-folder-list">
            <button class="tree-row tree-parent ${!projectView && generatedFavoritesOnly ? 'active contains-active' : ''}" type="button" data-generated-fav-filter title="收藏的生成素材">
                <span class="tree-row-icon"><i data-lucide="star"></i></span>
                <span class="tree-row-name">我的收藏</span>
                <span class="tree-row-count">${favoriteFileCount('generated')}</span>
            </button>
            <div class="tree-branch expanded">
                <button class="tree-row tree-parent ${!projectView && !generatedFavoritesOnly && !generatedAssetsState.folder && mediaType === 'all' ? 'active' : ''}" type="button" data-generated-type="all"><span class="tree-row-icon"><i data-lucide="images"></i></span><span class="tree-row-name">全部生成</span><span class="tree-row-count">${allTotal}</span></button>
                <div class="tree-children generated-media-channels">
                    ${mediaChannels.map(channel => `<button class="tree-row tree-child ${!projectView && !generatedFavoritesOnly && !generatedAssetsState.folder && mediaType === channel.type ? 'active' : ''}" type="button" data-generated-type="${channel.type}"><span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="${channel.icon}"></i></span><span class="tree-row-name">${channel.label}</span><span class="tree-row-count">${channel.count}</span></button>`).join('')}
                </div>
            </div>
            <div class="generated-projects ${generatedProjectsCollapsed ? 'is-collapsed' : ''}">
                <button class="generated-projects-toggle" type="button" data-generated-projects-toggle aria-expanded="${generatedProjectsCollapsed ? 'false' : 'true'}" title="${generatedProjectsCollapsed ? '展开项目列表' : '收起项目列表'}">
                    <span>按项目</span><i data-lucide="chevron-down"></i>
                </button>
                ${generatedProjectsCollapsed ? '' : `<div class="nav-tree canvas-asset-tree">
                    ${canvasAssetProjects().map(project => renderCanvasAssetTreeBranch(project)).join('')}
                </div>`}
            </div>
            ${folders.map(folder => `<button class="tree-row tree-child ${!projectView && !generatedFavoritesOnly && generatedAssetsState.folder === folder ? 'active' : ''}" type="button" data-generated-folder="${escapeAttr(folder)}"><span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="folder"></i></span><span class="tree-row-name" title="${escapeAttr(folder)}">${escapeHtml(folder)}</span><span class="tree-row-count">${generatedAssetsState.items.filter(item => (item.folder || '') === folder).length}</span></button>`).join('')}
            ${renderImageSpaceCollections()}
        </div>
    </aside>`;
}
async function importSelectedGeneratedAssets(){
    const selected = generatedAssetSelectedItems();
    const imageItems = selected.filter(item => assetKind(item) === 'image');
    const skippedVideoCount = selected.length - imageItems.length;
    if(!imageItems.length){
        if(skippedVideoCount) setStatus('视频可预览、下载或删除，暂不支持加入图片资产库');
        return;
    }
    normalizeAssetState();
    const category = activeAssetCategory();
    if(!category){ setStatus('请先在图片资产中创建一个分组'); return; }
    const data = await apiJson('/api/asset-library/items/batch', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:activeAssetLibraryId, category_id:category.id, items:imageItems.map(item => ({url:item.url, name:item.name}))})});
    assetLibrary = data.library || assetLibrary;
    generatedAssetsState.selectedIds.clear();
    renderGeneratedAssetViews();
    setStatus(`已加入图片资产库 ${data.items?.length || 0} 张${skippedVideoCount ? `，已跳过 ${skippedVideoCount} 个视频` : ''}`);
}
async function deleteSelectedGeneratedAssets(){
    const selected = generatedAssetsState.items.filter(item => generatedAssetsState.selectedIds.has(item.id));
    if(!selected.length) return;
    if(!confirm(`确认将 ${selected.length} 个生成素材移入回收站？仍被画布或历史记录引用的素材需要先移除引用。`)) return;
    const data = await apiJson('/api/storage-files/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'generated', items:selected.map(item => item.rel)})});
    generatedAssetsState.selectedIds.clear();
    generatedAssetsState.selectedId = '';
    await loadGeneratedAssets();
    setStatus(`已将 ${data.removed || 0} 个生成素材移入回收站`);
}
function uploadFormWithProgress(url, form, onProgress){
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.upload.onprogress = event => {
            if(event.lengthComputable && typeof onProgress === 'function'){
                onProgress(Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100))));
            }
        };
        xhr.onerror = () => reject(new Error('上传连接失败，请重试'));
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); } catch(_) {}
            if(xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.detail || data.message || `上传失败（${xhr.status}）`));
            resolve(data);
        };
        xhr.send(form);
    });
}
async function browseStorageFolder(kind){
    if(!['root'].includes(kind)) return;
    if(storageFolderPickerBusy){
        setStatus('请先完成或关闭当前文件夹选择窗口');
        return;
    }
    syncStorageSettingsInputsToState();
    const requestId = ++storageFolderPickerRequestId;
    storageFolderPickerBusy = true;
    document.querySelectorAll(`[data-storage-browse="${kind}"]`).forEach(target => {
        target.disabled = true;
        target.setAttribute('aria-busy', 'true');
    });
    setStatus('请选择资产管理根目录...');
    const controller = new AbortController();
    // 后端原生选择窗口最长等待 180 秒；前端略晚于后端超时，避免请求先
    // 中断而后端选择锁仍被占用，导致下一个“选择”按钮暂时没有反应。
    const timeout = setTimeout(() => controller.abort(), 190000);
    try {
        const data = await apiJson('/api/select-folder', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            signal:controller.signal,
            body:JSON.stringify({
                 kind:'',
                 initial_path:storageSettingsState.imageSpace || imageSpaceSettings.root || '',
                 title:'选择资产管理根目录'
            })
        });
        if(requestId !== storageFolderPickerRequestId) return;
        if(data.selected && data.path){
            storageSettingsState.imageSpace = data.path;
            const input = document.getElementById('storageImageSpaceRoot');
            if(input) input.value = data.path;
            const imageSpaceRoot = data.path;
            storageSettingsState.dirs = {
                upload:`${imageSpaceRoot}\\上传素材`,
                generated:`${imageSpaceRoot}\\生成素材`,
                local:`${imageSpaceRoot}\\本地素材`
            };
            ['upload','generated','local'].forEach(key => {
                const field = document.getElementById(`storageDir_${key}`);
                if(field) field.value = storageSettingsState.dirs[key];
            });
            setStatus('已选择资产管理根目录，请点击“保存资产管理设置”');
        } else {
            setStatus('已取消选择文件夹');
        }
    } catch(err) {
        if(err?.name === 'AbortError') setStatus('文件夹选择超时，请重新点击“选择”');
        else throw err;
    } finally {
        clearTimeout(timeout);
        if(requestId === storageFolderPickerRequestId){
            storageFolderPickerBusy = false;
            document.querySelectorAll(`[data-storage-browse="${kind}"]`).forEach(target => {
                target.disabled = false;
                target.removeAttribute('aria-busy');
            });
        }
    }
}
function formatDate(value){
    const num = Number(value || 0);
    if(!num) return '未知';
    try { return new Date(num).toLocaleString('zh-CN', {hour12:false}); }
    catch(e) { return '未知'; }
}
function formatFileSize(bytes=0){
    const size = Number(bytes || 0);
    if(!size) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
    return `${(size / Math.pow(1024, idx)).toFixed(idx ? 1 : 0)} ${units[idx]}`;
}
function assetLibraries(){
    return Array.isArray(assetLibrary.libraries) && assetLibrary.libraries.length
        ? assetLibrary.libraries
        : [{id:'default', name:'默认资产库', categories:assetLibrary.categories || []}];
}
function activeAssetLibrary(){
    const libs = assetLibraries();
    return libs.find(lib => lib.id === activeAssetLibraryId) || libs[0] || null;
}
function activeWorkflowLibrary(){
    const libs = assetLibraries();
    return libs.find(lib => lib.id === activeWorkflowLibraryId) || libs[0] || null;
}
function assetCategories(){
    return (activeAssetLibrary()?.categories || []).filter(cat => (cat.type || 'image') === 'image');
}
function workflowCategories(){
    const cats = [];
    assetLibraries().forEach(lib => {
        (lib.categories || []).filter(cat => (cat.type || '') === 'workflow').forEach(cat => {
            cats.push({...cat, __libraryId:lib.id, __libraryName:lib.name || '资产库'});
        });
    });
    return cats;
}
function activeAssetCategory(){
    const cats = assetCategories();
    return cats.find(cat => cat.id === activeAssetCategoryId) || cats[0] || null;
}
function assetViewTitle(){
    const collection = imageSpaceState.collections.find(item => item.id === imageSpaceState.collectionId && item.source === 'assets');
    if(collection) return collection.name;
    if(imageSpaceState.all.assets) return '全部分组';
    const entry = activeAssetClassEntry();
    if(entry) return entry.tag || '智能分类';
    return activeAssetCategory()?.name || '图片资产';
}
function assetViewSubtitle(items){
    const libName = activeAssetLibrary()?.name || '资产库';
    const entry = activeAssetClassEntry();
    if(entry) return `${libName} / 智能分类：${entry.label} / ${items.length} 个素材`;
    return `${libName} / ${items.length} 个素材`;
}
function activeWorkflowCategory(){
    const cats = workflowCategories();
    return cats.find(cat => cat.id === activeWorkflowCategoryId && cat.__libraryId === activeWorkflowLibraryId)
        || cats.find(cat => cat.id === activeWorkflowCategoryId)
        || cats[0]
        || null;
}
function workflowCount(){
    return workflowCategories().reduce((sum, cat) => sum + ((cat.items || []).length), 0);
}
async function hydrateWorkflowPreviews(){
    const items = workflowCategories().flatMap(cat => cat.items || []).filter(item => item?.id && !item.preview_graph);
    if(!items.length) return;
    let changed = false;
    await Promise.all(items.slice(0, 80).map(async item => {
        try {
            const response = await fetch(`/api/asset-library/workflows/${encodeURIComponent(item.id)}/preview`, {cache:'no-store'});
            if(!response.ok) return;
            const preview = await response.json();
            if(preview?.preview_graph){
                Object.assign(item, preview);
                changed = true;
            }
        } catch(_){ /* 单个旧工作流无法读取时保留兼容预览 */ }
    }));
    if(changed && activeTab === 'workflows') render();
}
function assetCountForLibrary(lib){
    return (lib?.categories || [])
        .filter(cat => (cat.type || 'image') === 'image')
        .reduce((sum, cat) => sum + ((cat.items || []).length), 0);
}
function promptLibraries(){
    const libs = Array.isArray(promptLibrary.libraries) ? promptLibrary.libraries.filter(Boolean) : [];
     if(!libs.length) return [{id:'system', name:'系统提示词模板库', system:true, items:[], categories:[]}];
    const system = libs.filter(lib => lib.id === 'system');
    const others = libs.filter(lib => lib.id !== 'system');
    return [...system, ...others];
}
function isSystemPromptLibrary(lib){
    return !lib || lib.id === 'system';
}
function activePromptLibrary(){
    const libs = promptLibraries();
    return libs.find(lib => lib.id === activePromptLibraryId) || libs[0] || null;
}
// 按“某个库自身”解析分类：库有自己的分类就用它；只有系统库在完全为空时才补默认内置分类。
// 新建的普通库分类为空 → 返回 []，不能借用当前激活库/系统库的分类（否则树里会错显系统分类）。
function promptCategoriesFor(lib){
    const fromLib = Array.isArray(lib?.categories) ? lib.categories.filter(c => c?.id) : [];
    if(fromLib.length) return fromLib;
    if(!isSystemPromptLibrary(lib)) return [];
    return [
        {id:'view', name:'视角'},
        {id:'storyboard', name:'分镜'},
        {id:'character', name:'角色'},
        {id:'product', name:'产品'},
        {id:'lighting', name:'光影'},
        {id:'custom', name:'我的'}
    ];
}
function activePromptCategories(){
    return promptCategoriesFor(activePromptLibrary());
}
const PROMPT_BUILTIN_CATEGORY_IDS = new Set(['view','storyboard','character','product','lighting','custom']);
const ASSET_CLASS_GROUPS = [
    {id:'environment', name:'环境', dims:['environment','scene','space','mood']},
    {id:'composition', name:'构图', dims:['composition']},
    {id:'lighting', name:'光影', dims:['lighting','color']},
    {id:'model', name:'模特', dims:['model','people']},
    {id:'subject', name:'主体', dims:['subject','objects','materials']},
    {id:'style', name:'风格', dims:['style','use_case','quality']},
    {id:'tags', name:'标签', dims:['tags']},
];
const ASSET_CLASS_GROUP_BY_DIM = new Map(ASSET_CLASS_GROUPS.flatMap(group => group.dims.map(dim => [dim, group])));
const ASSET_CLASSIFICATION_LABELS = {
    environment:'环境',
    scene:'场景',
    space:'空间',
    subject:'主体',
    model:'模特',
    people:'人物',
    style:'风格',
    lighting:'光影',
    color:'色彩',
    composition:'构图',
    mood:'氛围',
    use_case:'用途',
    objects:'物体',
    materials:'材质',
    quality:'质量',
    tags:'标签'
};
function promptCategoryLabel(category='custom'){
    const found = activePromptCategories().find(cat => cat.id === category);
    if(found?.name) return found.name;
    const map = {view:'视角', storyboard:'分镜', character:'角色', product:'产品', lighting:'光影', mine:'我的', custom:'我的'};
    return map[category] || category || '自定义';
}
function promptCountForCategory(category, lib=activePromptLibrary()){
    const items = lib?.items || [];
    if(category === 'all') return items.length;
    return items.filter(item => (item.category || 'custom') === category).length;
}
function assetKind(item){
    const url = String(item?.url || '').toLowerCase();
    const kind = String(item?.kind || item?.type || '').toLowerCase();
    if(kind.includes('video') || /\.(mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/.test(url)) return 'video';
    if(kind.includes('audio') || /\.(mp3|wav|flac|ogg|m4a)(\?|#|$)/.test(url)) return 'audio';
    if(kind.includes('text') || /\.(txt|json|csv|srt|vtt|md)(\?|#|$)/.test(url)) return 'text';
    return 'image';
}
function assetClassificationChips(item, limit=10){
    const flat = Array.isArray(item?.classification?.flat) ? item.classification.flat : [];
    return flat.slice(0, limit).map(entry => {
        const label = entry?.label || entry?.dimension || '分类';
        const tag = entry?.tag || '';
        const key = assetClassFilterKey(entry);
        return tag ? {label, tag, key, dimension:entry?.dimension || ''} : null;
    }).filter(Boolean);
}
function assetClassFilterKey(entry){
    const dimension = String(entry?.dimension || '').trim();
    const tag = String(entry?.tag || '').trim();
    return dimension && tag ? `${dimension}::${tag}` : '';
}
function parseAssetClassFilterKey(key=''){
    const text = String(key || '');
    const index = text.indexOf('::');
    if(index < 0) return null;
    return {dimension:text.slice(0, index), tag:text.slice(index + 2)};
}
function assetClassificationEntriesForLibrary(lib=activeAssetLibrary()){
    const items = [];
    (lib?.categories || []).filter(cat => (cat.type || 'image') === 'image').forEach(cat => items.push(...(cat.items || [])));
    return assetClassificationEntriesForItems(items);
}
function assetClassificationEntriesForItems(items=[]){
    const groups = new Map();
    (items || []).forEach(item => {
        const flat = Array.isArray(item?.classification?.flat) ? item.classification.flat : [];
        flat.forEach(entry => {
            const key = assetClassFilterKey(entry);
            if(!key) return;
            const current = groups.get(key) || {
                key,
                dimension:String(entry.dimension || ''),
                label:String(entry.label || entry.dimension || '分类'),
                tag:String(entry.tag || ''),
                count:0
            };
            current.count += 1;
            groups.set(key, current);
        });
    });
    return [...groups.values()].sort((a, b) => {
        if(a.label !== b.label) return a.label.localeCompare(b.label, 'zh-Hans-CN', {numeric:true, sensitivity:'base'});
        return b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN', {numeric:true, sensitivity:'base'});
    });
}
function assetClassificationEntryGroup(entry){
    const dim = String(entry?.dimension || '');
    if(dim === 'subject' && /人|人物|模特|男|女|儿童|老人|青年|肖像|半身|全身/.test(String(entry?.tag || ''))) {
        return ASSET_CLASS_GROUPS.find(group => group.id === 'model') || ASSET_CLASS_GROUPS[0];
    }
    return ASSET_CLASS_GROUP_BY_DIM.get(dim) || ASSET_CLASS_GROUPS.find(group => group.id === 'tags') || ASSET_CLASS_GROUPS[0];
}
function assetClassificationSearchText(item){
    const classification = item?.classification || {};
    const flat = Array.isArray(classification.flat) ? classification.flat : [];
    const flatText = flat.map(entry => {
        const group = assetClassificationEntryGroup(entry);
        return [group?.name, entry?.label, entry?.dimension, entry?.tag].filter(Boolean).join(' ');
    }).join(' ');
    const categoryText = classification.categories && typeof classification.categories === 'object'
        ? Object.entries(classification.categories).map(([key, values]) => {
            const group = ASSET_CLASS_GROUP_BY_DIM.get(String(key || ''));
            const label = ASSET_CLASSIFICATION_LABELS[key] || key;
            const list = Array.isArray(values) ? values : [values];
            return [group?.name, label, key, ...list].filter(Boolean).join(' ');
        }).join(' ')
        : '';
    const tags = Array.isArray(classification.tags) ? classification.tags.join(' ') : '';
    return [classification.summary, flatText, categoryText, tags].filter(Boolean).join(' ');
}
function groupedAssetClassificationEntries(entries=[]){
    const byGroup = new Map(ASSET_CLASS_GROUPS.map(group => [group.id, {...group, count:0, entries:[]}]));
    (entries || []).forEach(entry => {
        const group = assetClassificationEntryGroup(entry);
        const bucket = byGroup.get(group.id) || byGroup.get('tags');
        bucket.entries.push(entry);
        bucket.count += Number(entry.count || 0);
    });
    return [...byGroup.values()].filter(group => group.entries.length);
}
function assetClassificationGroupIdForFilter(key='', entries=[]){
    const entry = (entries || []).find(item => item.key === key);
    return entry ? assetClassificationEntryGroup(entry)?.id || '' : '';
}
function activeAssetClassEntry(){
    return assetClassificationEntriesForLibrary().find(entry => entry.key === activeAssetClassFilter) || null;
}
function assetItemsForClassFilter(key=activeAssetClassFilter){
    const parsed = parseAssetClassFilterKey(key);
    if(!parsed) return [];
    return assetCategories().flatMap(cat => cat.items || []).filter(item => {
        const flat = Array.isArray(item?.classification?.flat) ? item.classification.flat : [];
        return flat.some(entry => String(entry.dimension || '') === parsed.dimension && String(entry.tag || '') === parsed.tag);
    });
}
function renderClassificationChips(item, limit=10, options={}){
    const chips = assetClassificationChips(item, limit);
    const kind = options.kind || '';
    const libAttr = options.libraryId ? ` data-asset-class-lib="${escapeAttr(options.libraryId)}"` : '';
    const activeKey = kind === 'localup' ? activeLocalUploadClassFilter : kind === 'asset' ? activeAssetClassFilter : '';
    return chips.length
        ? `<div class="classification-chips">${chips.map(chip => {
            const filterAttr = kind === 'localup'
                ? ` data-localup-class-filter="${escapeAttr(chip.key)}"`
                : kind === 'asset'
                    ? ` data-asset-class-filter="${escapeAttr(chip.key)}"${libAttr}`
                    : '';
            return `<button class="${activeKey === chip.key ? 'active' : ''}" type="button"${filterAttr} title="${escapeAttr(chip.label)}">${escapeHtml(chip.tag)}</button>`;
        }).join('')}</div>`
        : '';
}
function workflowKindLabel(item){
    const format = String(item?.format || '').toLowerCase();
    const url = String(item?.url || '').toLowerCase();
    if(format === 'json' || url.endsWith('.json')) return 'JSON 工作流';
    return 'ZIP 工作流包';
}
function assetKindLabel(item){
    const kind = assetKind(item);
    if(kind === 'video') return '视频';
    if(kind === 'audio') return '音频';
    if(kind === 'text') return '文本';
    return '图片';
}
// 缩略图走服务端缩放代理（/api/media-preview），把大原图降到 ~256px 再传给浏览器。素材多时滚动只解码小图，
// 不再因为加载/解码整张原图而卡。对 /output、/assets 和本地存储接口生效，其它地址原样返回。
function assetPreviewUrl(url, w=256){
    const raw = String(url || '');
    if(!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    let path = raw;
    if(/^https?:\/\//i.test(raw)){
        try { path = new URL(raw).pathname; } catch(e) { return raw; }
    }
    if(!(path.startsWith('/output/') || path.startsWith('/assets/') || path.startsWith('/api/storage-files/'))) return raw;
    if(!/\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/i.test(path)) return raw;
    const width = Math.max(64, Math.min(2048, Math.round(Number(w) || 256)));
    return `/api/media-preview?w=${width}&url=${encodeURIComponent(path)}`;
}
function assetThumb(item){
    const kind = assetKind(item);
    // 视频缩略图由浏览器解码可见视频并抓取一帧，避免依赖服务端 ffmpeg。
    if(kind === 'video'){
        const videoKey = String(item?.id || item?.url || '');
        const cachedPoster = videoThumbPosterCache.get(videoKey) || '';
        const posterAttr = cachedPoster ? ` poster="${escapeAttr(cachedPoster)}"` : '';
        return `<video class="asset-thumb-video" data-video-thumb="true" data-video-thumb-key="${escapeAttr(videoKey)}" src="${escapeAttr(item.url)}"${posterAttr} muted preload="metadata" playsinline></video><span class="asset-video-play" aria-hidden="true"><i data-lucide="play"></i></span>`;
    }
    if(kind === 'audio') return `<div class="asset-file-icon"><i data-lucide="file-audio"></i><span>音频</span></div>`;
    if(kind === 'text') return `<div class="asset-file-icon"><i data-lucide="file-text"></i><span>文本</span></div>`;
    return `<img src="${escapeAttr(assetPreviewUrl(item.url, 256))}" alt="${escapeAttr(item.name || 'asset')}" loading="lazy" decoding="async">`;
}
function hydrateVideoThumb(video){
    if(!video || video.dataset.videoThumbLoading === '1' || video.dataset.videoThumbReady === '1') return;
    const cacheKey = video.dataset.videoThumbKey || video.currentSrc || video.src || '';
    const cachedPoster = videoThumbPosterCache.get(cacheKey);
    if(cachedPoster){
        video.poster = cachedPoster;
        video.dataset.videoThumbReady = '1';
        return;
    }
    video.dataset.videoThumbLoading = '1';
    let finished = false;
    let seekRequested = false;
    let timer = 0;
    const cleanup = () => {
        if(timer) window.clearTimeout(timer);
        delete video.dataset.videoThumbLoading;
        video.removeEventListener('loadedmetadata', onMetadata);
        video.removeEventListener('loadeddata', onLoadedData);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('error', onError);
    };
    const fail = () => {
        if(finished) return;
        finished = true;
        video.dataset.videoThumbError = '1';
        cleanup();
    };
    const capture = () => {
        if(finished || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
        try {
            const width = Math.min(640, video.videoWidth);
            const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if(!context) return false;
            context.drawImage(video, 0, 0, width, height);
            video.poster = canvas.toDataURL('image/jpeg', 0.82);
            if(cacheKey) videoThumbPosterCache.set(cacheKey, video.poster);
            video.dataset.videoThumbReady = '1';
            finished = true;
            cleanup();
            return true;
        } catch(_) {
            fail();
            return false;
        }
    };
    function onMetadata(){
        if(!Number.isFinite(video.duration) || video.duration <= 0){
            capture();
            return;
        }
        seekRequested = true;
        try {
            video.currentTime = Math.min(video.duration, Math.min(0.5, Math.max(0, video.duration * 0.08)));
        } catch(_) {
            capture();
        }
    }
    function onLoadedData(){ if(!seekRequested) capture(); }
    function onSeeked(){ capture(); }
    function onCanPlay(){ if(!seekRequested) capture(); }
    function onError(){ fail(); }
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    timer = window.setTimeout(() => { if(!capture()) fail(); }, 5000);
    // 服务端没有 ffmpeg 时，直接借助浏览器解码视频并抓取一帧作为 poster。
    video.preload = 'auto';
    video.load();
}
function prepareVideoThumbs(scope=document){
    const videos = Array.from(scope?.querySelectorAll?.('video[data-video-thumb]') || []);
    if(!videos.length) return;
    const start = video => hydrateVideoThumb(video);
    if('IntersectionObserver' in window){
        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if(!entry.isIntersecting) return;
                start(entry.target);
                observer.unobserve(entry.target);
            });
        }, {root:null, rootMargin:'320px'});
        videos.forEach(video => {
            const rect = video.getBoundingClientRect();
            if(rect.width > 0 && rect.bottom >= -320 && rect.top <= window.innerHeight + 320){
                start(video);
                observer.unobserve(video);
            } else {
                observer.observe(video);
            }
        });
    } else {
        videos.forEach(start);
    }
}
function workflowThumb(item, options={}){
    if(item?.preview_graph && window.XiaomeiWorkflowPreview?.markup){
        return window.XiaomeiWorkflowPreview.markup(item, {name:item.name || '工作流', large:Boolean(options.large)});
    }
    const nodeCount = Math.max(0, Number(item?.node_count || item?.nodes_count || 0));
    const visible = Math.min(nodeCount || 3, 6);
    const boxes = Array.from({length:visible}, (_, index) => {
        const x = 12 + (index % 3) * 42;
        const y = 18 + Math.floor(index / 3) * 38;
        return `<rect x="${x}" y="${y}" width="28" height="18" rx="4" class="workflow-preview-node"></rect>`;
    }).join('');
    const links = Array.from({length:Math.max(0, visible - 1)}, (_, index) => {
        const x1 = 40 + (index % 3) * 42;
        const y1 = 27 + Math.floor(index / 3) * 38;
        const x2 = 54 + ((index + 1) % 3) * 42;
        const y2 = 27 + Math.floor((index + 1) / 3) * 38;
        return `<path d="M${x1} ${y1} C${x1 + 10} ${y1}, ${x2 - 10} ${y2}, ${x2} ${y2}" class="workflow-preview-link"></path>`;
    }).join('');
    return `<div class="workflow-preview"><svg viewBox="0 0 140 82" aria-hidden="true">${links}${boxes}</svg><span>${nodeCount ? `${nodeCount} 个节点` : escapeHtml(workflowKindLabel(item))}</span></div>`;
}
function isLocalMediaFile(file){
    if(!file) return false;
    const type = String(file.type || '').toLowerCase();
    if(type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')) return true;
    return LOCAL_MEDIA_EXTS.test(file.name || '');
}
function localItemKind(item){
    // 共享文件夹的 item 已带 kind；兜底按名称判断
    if(item && item.kind) return item.kind;
    const name = String(item?.name || '').toLowerCase();
    if(/\.(mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/i.test(name)) return 'video';
    if(/\.(mp3|wav|flac|ogg|m4a|aac)(\?|#|$)/i.test(name)) return 'audio';
    return 'image';
}
function localObjectUrl(item){
    // 共享文件夹素材直接走后端 URL（局域网也可访问），不再用 createObjectURL
    return item?.url || '';
}
function localAssetThumb(item){
    return assetThumb({url:localObjectUrl(item), name:item?.name || 'local', kind:item?.kind || localItemKind(item)});
}
function activeLocalFolder(){
    return localFolderMap.get(activeLocalFolderId) || localFolders[0] || null;
}
function localItemsForFolder(folderId=activeLocalFolderId){
    const query = localQuery.trim().toLowerCase();
    const folder = localFolderMap.get(folderId) || activeLocalFolder();
    const items = folder?.items || [];
    return items.filter(item => {
        if(!query) return true;
        return [item.name, item.relativePath, assetKindLabel(item)].join(' ').toLowerCase().includes(query);
    });
}
function localCaptionProviders(){
    return (apiProviders || []).filter(p => p && p.enabled !== false && Array.isArray(p.chat_models) && p.chat_models.length);
}
function normalizeLocalCaptionSettings(){
    const providers = localCaptionProviders();
    const beforeProvider = localCaptionProvider;
    const beforeModel = localCaptionModel;
    if(!providers.length){
        localCaptionProvider = '';
        localCaptionModel = '';
        if(beforeProvider || beforeModel) writeLocalCaptionSettings();
        return;
    }
    let provider = providers.find(p => p.id === localCaptionProvider) || providers[0];
    localCaptionProvider = provider.id || '';
    const models = (provider.chat_models || []).filter(Boolean);
    if(!models.includes(localCaptionModel)) localCaptionModel = models[0] || '';
    if(beforeProvider !== localCaptionProvider || beforeModel !== localCaptionModel) writeLocalCaptionSettings();
}
function localCaptionModels(){
    normalizeLocalCaptionSettings();
    const provider = localCaptionProviders().find(p => p.id === localCaptionProvider);
    return (provider?.chat_models || []).filter(Boolean);
}
function renderLocalCaptionTools(imageCount){
    normalizeLocalCaptionSettings();
    const providers = localCaptionProviders();
    const models = localCaptionModels();
    const captionDisabled = !imageCount || !providers.length || !localCaptionModel || localCaptionBusy || localClassifyBusy;
    const classifyDisabled = !imageCount || !providers.length || !localCaptionModel || localCaptionBusy || localClassifyBusy;
    return `
        <div class="local-caption-tools">
            <div class="local-caption-main-row">
            <select id="localCaptionProvider" class="manage-select" title="平台" ${providers.length ? '' : 'disabled'}>
                ${providers.length ? providers.map(p => `<option value="${escapeAttr(p.id)}" ${p.id === localCaptionProvider ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`).join('') : '<option value="">暂无聊天平台</option>'}
            </select>
            <select id="localCaptionModel" class="manage-select" title="模型" ${models.length ? '' : 'disabled'}>
                ${models.length ? models.map(m => `<option value="${escapeAttr(m)}" ${m === localCaptionModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('') : '<option value="">暂无模型</option>'}
            </select>
            <input id="localCaptionPrompt" class="local-caption-prompt-input" type="text" value="${escapeAttr(localCaptionPrompt || '描述图片')}" placeholder="描述图片">
            <button class="asset-btn" type="button" data-local-classify-run ${classifyDisabled ? 'disabled' : ''}><i data-lucide="${localClassifyBusy ? 'loader-2' : 'tags'}"></i><span>${localClassifyBusy ? '分类中' : '智能分类'}</span></button>
            <button class="asset-btn primary" type="button" data-local-caption-run ${captionDisabled ? 'disabled' : ''}><i data-lucide="${localCaptionBusy ? 'loader-2' : 'wand-sparkles'}"></i><span>${localCaptionBusy ? '反推中' : '提示词反推'}</span></button>
            <button class="asset-icon-btn" type="button" data-local-classify-toggle title="智能分类要求"><i data-lucide="${localClassifyPromptOpen ? 'chevron-up' : 'sliders-horizontal'}"></i></button>
            </div>
            ${localClassifyPromptOpen ? `<textarea id="localClassifyPrompt" class="local-classify-prompt-input" placeholder="默认已内置室内/室外、空间、主体、光影、模特、风格、色彩等分类。这里可以追加你的分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。">${escapeHtml(localClassifyPrompt || '')}</textarea>` : ''}
        </div>
    `;
}
function findLocalItem(id){
    return localItemMap.get(id) || null;
}
function normalizeLocalState(){
    if(!activeLocalFolderId || !localFolderMap.has(activeLocalFolderId)) activeLocalFolderId = localFolders[0]?.id || '';
    const items = localItemsForFolder();
    if(selectedLocalId && !localItemMap.has(selectedLocalId)) selectedLocalId = '';
    if(!selectedLocalId && items.length) selectedLocalId = items[0].id;
    selectedLocalIds = new Set([...selectedLocalIds].filter(id => localItemMap.has(id)));
}
function localFolderTotal(folder){
    if(!folder) return 0;
    return (folder.items || []).length + (folder.children || []).reduce((sum, child) => sum + localFolderTotal(child), 0);
}
function localFolderId(path=''){
    return path || '__root__';
}
function localChildPath(parentPath='', name=''){
    return parentPath ? `${parentPath}/${name}` : name;
}
// ---------------- 共享文件夹（服务端登记 + 只读浏览/引用，局域网可用） ----------------
async function loadSharedFolders(){
    try {
        const data = await apiJson('/api/shared-folders');
        sharedFolders = Array.isArray(data.folders) ? data.folders : [];
    } catch(err) {
        sharedFolders = [];
    }
    return sharedFolders;
}
async function loadLocalAssets(){
    try {
        const data = await apiJson('/api/local-assets');
        localAssets = Array.isArray(data.items) ? data.items : [];
        localUploadTree = data.tree || {id:'__root__', path:'', name:'全部上传', count:localAssets.length, items:[], children:[]};
    } catch(err) {
        localAssets = [];
        localUploadTree = {id:'__root__', path:'', name:'全部上传', count:0, items:[], children:[]};
    }
    if(activeLocalUploadFolder && !localUploadFolderExists(activeLocalUploadFolder)) activeLocalUploadFolder = '';
    if(activeLocalUploadClassFilter && !activeLocalUploadClassEntry()) activeLocalUploadClassFilter = '';
    selectedLocalUploadIds = new Set([...selectedLocalUploadIds].filter(id => localAssets.some(item => item.id === id)));
    localAssetsLoaded = true;
    return localAssets;
}
async function registerSharedFolder(){
    const tip = '请输入要登记的共享文件夹路径（必须位于项目目录内，例如 assets\\library 或 output）：';
    const path = window.prompt(tip, '');
    if(!String(path || '').trim()) return;
    try {
        setStatus('正在登记共享文件夹...');
        const data = await apiJson('/api/shared-folders', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path})
        });
        await loadSharedFolders();
        const folder = data.folder;
        if(folder?.id) await openSharedFolder(folder.id);
        else render();
        setStatus(`已登记「${folder?.name || '共享文件夹'}」`);
    } catch(err) {
        setStatus(err.message || '登记共享文件夹失败');
    }
}
async function unregisterSharedFolder(folderId){
    if(!folderId) return;
    try {
        await apiJson(`/api/shared-folders/${encodeURIComponent(folderId)}`, {method:'DELETE'});
        if(activeSharedFolderId === folderId){
            activeSharedFolderId = '';
            activeSharedFolderName = '';
            localFolders = [];
            localFolderMap = new Map();
            localItemMap = new Map();
            activeLocalFolderId = '';
            selectedLocalId = '';
            selectedLocalIds.clear();
            localClipboard = null;
        }
        await loadSharedFolders();
        render();
        setStatus('已移除共享文件夹登记（不会删除磁盘文件）');
    } catch(err) {
        setStatus(err.message || '移除共享文件夹失败');
    }
}
function indexSharedTree(node){
    if(!node) return;
    localFolderMap.set(node.id, node);
    (node.items || []).forEach(item => localItemMap.set(item.id, item));
    (node.children || []).forEach(child => indexSharedTree(child));
}
async function openSharedFolder(folderId){
    if(!folderId) return;
    try {
        setStatus('正在读取共享文件夹...');
        const data = await apiJson(`/api/shared-folders/${encodeURIComponent(folderId)}/tree`);
        const tree = data.tree;
        localFolders = tree ? [tree] : [];
        localFolderMap = new Map();
        localItemMap = new Map();
        if(tree) indexSharedTree(tree);
        activeSharedFolderId = folderId;
        activeSharedFolderName = data.folder?.name || tree?.name || '共享文件夹';
        activeLocalFolderId = tree?.id || '';
        selectedLocalId = '';
        selectedLocalIds.clear();
        localClipboard = null;
        normalizeLocalState();
        render();
        setStatus(`已读取「${activeSharedFolderName}」`);
    } catch(err) {
        setStatus(err.message || '读取共享文件夹失败');
    }
}
function currentAssetItems(){
    const source = imageSpaceState.all.assets ? assetCategories().flatMap(cat => cat.items || []) : (activeAssetCategory()?.items || []);
    return source.filter(item => imageSpaceMatches(item, {...imageSpaceState.filters.assets,query:assetQuery}));
}
function currentWorkflowItems(){
    const query = workflowQuery.trim().toLowerCase();
    return (activeWorkflowCategory()?.items || []).filter(item => {
        if(!query) return true;
        return [item.name, item.url, workflowKindLabel(item)].join(' ').toLowerCase().includes(query);
    });
}
function canvasAssetProjects(){
    const canvases = (canvasAssetsData.canvases || []).filter(canvas => canvas.kind === 'smart');
    const items = uniqueCanvasAssets(canvasAssetsData.items || []).filter(item => item.canvas_kind === 'smart');
    const projects = Array.isArray(canvasAssetsData.projects) ? canvasAssetsData.projects.slice() : [];
    const knownIds = new Set(projects.map(project => project.id));
    canvases.forEach(canvas => {
        const id = canvas.project || 'default';
        if(!knownIds.has(id)){
            projects.push({id, name:id === 'default' ? '默认项目' : `项目 ${id.slice(0, 8)}`, order:Number.MAX_SAFE_INTEGER});
            knownIds.add(id);
        }
    });
    return projects.sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map(project => ({
        ...project,
        canvas_count:canvases.filter(canvas => (canvas.project || 'default') === project.id).length,
        count:items.filter(item => (item.project || 'default') === project.id).length
    }));
}
function activeCanvasAssetProjectInfo(){
    return canvasAssetProjects().find(project => project.id === activeCanvasAssetProjectId) || canvasAssetProjects()[0] || {id:'default', name:'默认项目', count:0, canvas_count:0};
}
function defaultCanvasAssetProject(){
    const projects = canvasAssetProjects();
    return projects.find(project => Number(project.canvas_count || 0) > 0)?.id || projects[0]?.id || 'default';
}
function uniqueCanvasAssets(items){
    const seen = new Set();
    const result = [];
    (items || []).forEach(item => {
        const key = `${item.canvas_id || ''}::${item.url || ''}`;
        if(!item?.url || seen.has(key)) return;
        seen.add(key);
        result.push(item);
    });
    return result;
}
function canvasAssetCountForCanvas(canvasId){
    return uniqueCanvasAssets(canvasAssetsData.items || []).filter(item => item.canvas_id === canvasId).length;
}
function canvasAssetsForProject(projectId=activeCanvasAssetProjectId){
    let list = Array.isArray(canvasAssetsData.canvases) ? canvasAssetsData.canvases.slice() : [];
    list = list.filter(canvas => canvas.kind === 'smart' && (canvas.project || 'default') === projectId);
    return list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN', {numeric:true, sensitivity:'base'}));
}
function canvasAssetOpenUrl(canvas){
    if(!canvas?.id) return '';
    const id = encodeURIComponent(canvas.id);
return canvas.kind === 'smart' ? `/static/smart-canvas.html?id=${id}&v=2026.10.11.local-assets-default.1` : `/static/canvas.html?id=${id}`;
}
function activeCanvasAssetCanvas(){
    if(!activeCanvasAssetCanvasId) return null;
    return (canvasAssetsData.canvases || []).find(canvas => canvas.id === activeCanvasAssetCanvasId) || null;
}
function canvasAssetViewTitle(){
    return activeCanvasAssetCanvas()?.title || activeCanvasAssetProjectInfo().name || '画布资产';
}
function canvasAssetViewSubtitle(items){
    const canvas = activeCanvasAssetCanvas();
    if(canvas) return `${escapeHtml(activeCanvasAssetProjectInfo().name)} / ${items.length} 个资产 / ${escapeHtml(canvasAssetSortLabel())}`;
    const project = activeCanvasAssetProjectInfo();
    return `${Number(project.canvas_count || 0)} 个画布 / ${items.length} 个资产 / ${escapeHtml(canvasAssetSortLabel())}`;
}
function canvasAssetKindLabel(item){
    const kind = assetKind(item);
    if(kind === 'video') return '视频';
    if(kind === 'audio') return '音频';
    if(String(item?.kind || '').toLowerCase() === 'text') return '文本';
    return '图片';
}
function canvasKindLabel(kind){
    return kind === 'smart' ? '智能画布' : '普通画布';
}
function canvasAssetSortLabel(){
    const map = {canvas_asc:'画布名称', updated_desc:'最近更新', updated_asc:'最早更新', name_asc:'名称 A-Z', kind:'类型'};
    return map[canvasAssetSort] || map.canvas_asc;
}
function currentCanvasAssetItems(){
    const q = String(canvasAssetQuery || '').trim().toLowerCase();
    const projectName = activeCanvasAssetProjectInfo().name;
    let list = uniqueCanvasAssets(canvasAssetsData.items || []).filter(item => {
        if(item.canvas_kind !== 'smart' || (item.project || 'default') !== activeCanvasAssetProjectId) return false;
        if(activeCanvasAssetCanvasId && item.canvas_id !== activeCanvasAssetCanvasId) return false;
        if(!q) return true;
        return [
            item.name,
            item.url,
            item.canvas_title,
            item.node_title,
            item.node_type,
            projectName,
            canvasAssetKindLabel(item),
            canvasKindLabel(item.canvas_kind)
        ].join(' ').toLowerCase().includes(q);
    });
    list = list.slice();
    const byTime = item => Number(item.canvas_updated_at || item.created_at || 0);
    const byCanvasName = (a, b) => String(a.canvas_title || '').localeCompare(String(b.canvas_title || ''), 'zh-Hans-CN', {numeric:true, sensitivity:'base'})
        || String(a.canvas_id || '').localeCompare(String(b.canvas_id || ''), 'zh-Hans-CN')
        || byTime(b) - byTime(a);
    if(canvasAssetSort === 'canvas_asc') list.sort(byCanvasName);
    else if(canvasAssetSort === 'updated_asc') list.sort((a, b) => byTime(a) - byTime(b));
    else if(canvasAssetSort === 'name_asc') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', {numeric:true, sensitivity:'base'}));
    else if(canvasAssetSort === 'kind') list.sort((a, b) => canvasAssetKindLabel(a).localeCompare(canvasAssetKindLabel(b), 'zh-Hans-CN') || byTime(b) - byTime(a));
    else list.sort((a, b) => byTime(b) - byTime(a));
    return list;
}
function groupCanvasAssetItems(items){
    if(canvasAssetSort !== 'canvas_asc') return [{key:'__all__', title:'', subtitle:'', items}];
    const groups = [];
    const map = new Map();
    (items || []).forEach(item => {
        const key = item.canvas_id || item.canvas_title || '__unknown__';
        if(!map.has(key)){
            const group = {
                key,
                title:item.canvas_title || '未命名画布',
                subtitle:`${canvasKindLabel(item.canvas_kind)} / ${formatDate(item.canvas_updated_at || item.created_at)}`,
                items:[]
            };
            map.set(key, group);
            groups.push(group);
        }
        map.get(key).items.push(item);
    });
    return groups;
}
function assetMoveTargets(){
    const currentKey = `${activeAssetLibraryId}::${activeAssetCategoryId}`;
    const targets = [];
    assetLibraries().forEach(lib => {
        (lib.categories || []).filter(cat => (cat.type || 'image') === 'image').forEach(cat => {
            const key = `${lib.id}::${cat.id}`;
            if(key !== currentKey) targets.push({key, libraryId:lib.id, categoryId:cat.id, label:`${lib.name || '资产库'} / ${cat.name || '分组'}`});
        });
    });
    return targets;
}
function normalizeAssetMoveTarget(){
    const targets = assetMoveTargets();
    if(!targets.some(item => item.key === assetMoveTarget)) assetMoveTarget = targets[0]?.key || '';
    return targets;
}
function currentPromptItems(){
    const lib = activePromptLibrary();
    const query = promptQuery.trim().toLowerCase();
    return (lib?.items || []).filter(item => {
        if(activePromptCategory !== 'all' && (item.category || 'custom') !== activePromptCategory) return false;
        if(!query) return true;
        return [item.name, item.scene, item.positive, item.negative, item.category].join(' ').toLowerCase().includes(query);
    });
}
// 认证支持的平台键（与后端 AVATAR_SUPPORTED_PLATFORMS 保持一致；新增平台时同步）
const AVATAR_SUPPORTED_PLATFORMS = ['apimart', 'volcengine'];
const AVATAR_PLATFORM_LABELS = {apimart:'APIMart', volcengine:'火山引擎'};
function providerAvatarPlatform(p){
    const proto = String(p?.protocol || '').toLowerCase();
    const base = String(p?.base_url || '').toLowerCase();
    if(proto === 'apimart' || base.includes('apimart.ai')) return 'apimart';
    if(proto === 'volcengine') return 'volcengine';
    return '';
}
function providerAvatarSupported(p){
    return AVATAR_SUPPORTED_PLATFORMS.includes(providerAvatarPlatform(p));
}
function avatarPlatformLabel(platform){
    return AVATAR_PLATFORM_LABELS[String(platform || '')] || String(platform || '平台');
}
// 列出 API 设置里所有启用的 provider 作为认证候选（以 API 设置为中心，由用户自己选平台）；
// 不支持的平台也列出，在下拉里标注「待接入」，避免用户以为漏了。
function avatarCandidateProviders(){
    return (apiProviders || []).filter(p => p && p.enabled !== false);
}
function activeAvatarProvider(){
    const list = avatarCandidateProviders();
    if(!list.length) return null;
    return list.find(p => p.id === avatarRegisterProvider)
        || list.find(p => providerAvatarSupported(p))
        || list[0];
}
function avatarProviderOptionLabel(p){
    const name = p.name || p.id;
    const platform = providerAvatarPlatform(p);
    if(!platform) return `${name}（暂不支持，待接入）`;
    if(!providerAvatarSupported(p)) return `${name}（${avatarPlatformLabel(platform)}·待接入）`;
    return `${name}（${avatarPlatformLabel(platform)}）`;
}
// 找出某平台当前可用的 provider_id（优先注册时记录的，其次同平台任一启用 provider）
function avatarProviderIdForPlatform(platform, preferredId=''){
    const list = avatarCandidateProviders();
    if(preferredId && list.some(p => p.id === preferredId)) return preferredId;
    const match = list.find(p => providerAvatarPlatform(p) === platform);
    return match ? match.id : '';
}
function findAssetItem(id){
    for(const lib of assetLibraries()) for(const cat of lib.categories || []) for(const item of cat.items || []) if(item.id === id) return item;
    return null;
}
function findWorkflowItem(id){
    for(const lib of assetLibraries()) for(const cat of lib.categories || []) {
        if((cat.type || '') !== 'workflow') continue;
        for(const item of cat.items || []) if(item.id === id) return item;
    }
    return null;
}
function findPromptItem(id){
    for(const lib of promptLibraries()) for(const item of lib.items || []) if(item.id === id) return item;
    return null;
}
function findCanvasAssetItem(id){
    return (canvasAssetsData.items || []).find(item => item.id === id) || null;
}
function selectedAsset(){
    const items = currentAssetItems();
    return items.find(item => item.id === selectedAssetId) || items[0] || null;
}
function selectedWorkflow(){
    const items = currentWorkflowItems();
    return items.find(item => item.id === selectedWorkflowId) || items[0] || null;
}
function selectedPrompt(){
    const items = currentPromptItems();
    return items.find(item => item.id === selectedPromptId) || items[0] || null;
}
function selectedCanvasAsset(){
    const items = currentCanvasAssetItems();
    return items.find(item => item.id === selectedCanvasAssetId) || items[0] || null;
}
function toggleSelectionSet(set, id){
    if(!id) return false;
    if(set.has(id)){
        set.delete(id);
        return false;
    }
    set.add(id);
    return true;
}
function managedSelectionTarget(target){
    if(activeTab === 'assets' && assetManageMode){
        const check = target.closest?.('[data-asset-check]');
        const card = target.closest?.('[data-asset-card]');
        const id = check?.dataset.assetCheck || card?.dataset.assetCard || '';
        if(id) return {kind:'asset', id};
    }
    if(activeTab === 'local' && localUploadManageMode){
        const check = target.closest?.('[data-localup-check]');
        const card = target.closest?.('[data-localup-card]');
        const id = check?.dataset.localupCheck || card?.dataset.localupCard || '';
        if(id) return {kind:'localup', id};
    }
    if(activeTab === 'local' && localManageMode){
        const check = target.closest?.('[data-local-check]');
        const card = target.closest?.('[data-local-card]');
        const id = check?.dataset.localCheck || card?.dataset.localCard || '';
        if(id) return {kind:'local', id};
    }
    if(activeTab === 'workflows' && workflowManageMode){
        const check = target.closest?.('[data-workflow-check]');
        const card = target.closest?.('[data-workflow-card]');
        const id = check?.dataset.workflowCheck || card?.dataset.workflowCard || '';
        if(id) return {kind:'workflow', id};
    }
    if(activeTab === 'prompts' && promptManageMode){
        const check = target.closest?.('[data-prompt-check]');
        const row = target.closest?.('[data-prompt-row]');
        const id = check?.dataset.promptCheck || row?.dataset.promptRow || '';
        if(id) return {kind:'prompt', id};
    }
    if(isCanvasAssetView() && canvasAssetManageMode){
        const check = target.closest?.('[data-canvas-asset-check]');
        const card = target.closest?.('[data-canvas-asset-card]');
        const id = check?.dataset.canvasAssetCheck || card?.dataset.canvasAssetCard || '';
        if(id) return {kind:'canvasAsset', id};
    }
    return null;
}
function applyManagedSelection(kind, id){
    if(kind === 'asset'){
        const selected = toggleSelectionSet(selectedAssetIds, id);
        selectedAssetId = selected ? id : (selectedAssetId === id ? '' : selectedAssetId);
    } else if(kind === 'localup'){
        const selected = toggleSelectionSet(selectedLocalUploadIds, id);
        selectedLocalUploadId = selected ? id : (selectedLocalUploadId === id ? '' : selectedLocalUploadId);
    } else if(kind === 'local'){
        const selected = toggleSelectionSet(selectedLocalIds, id);
        selectedLocalId = selected ? id : (selectedLocalId === id ? '' : selectedLocalId);
    } else if(kind === 'workflow'){
        const selected = toggleSelectionSet(selectedWorkflowIds, id);
        selectedWorkflowId = selected ? id : (selectedWorkflowId === id ? '' : selectedWorkflowId);
    } else if(kind === 'prompt'){
        const selected = toggleSelectionSet(selectedPromptIds, id);
        selectedPromptId = selected ? id : (selectedPromptId === id ? '' : selectedPromptId);
        promptEditMode = false;
        promptCreateMode = false;
    } else if(kind === 'canvasAsset'){
        const selected = toggleSelectionSet(selectedCanvasAssetIds, id);
        selectedCanvasAssetId = selected ? id : (selectedCanvasAssetId === id ? '' : selectedCanvasAssetId);
    }
    pendingBatchDelete = '';
}
function guardMatchesManagedSelection(target){
    const current = managedSelectionTarget(target);
    return !!current
        && !!managedSelectionPointerGuard
        && current.kind === managedSelectionPointerGuard.kind
        && current.id === managedSelectionPointerGuard.id
        && Date.now() - managedSelectionPointerGuard.at < 600;
}
function normalizeAssetState(){
    const libs = assetLibraries();
    if(!activeAssetLibraryId || !libs.some(lib => lib.id === activeAssetLibraryId)) activeAssetLibraryId = assetLibrary.active_library_id || libs[0]?.id || '';
    const cats = assetCategories();
    if(!activeAssetCategoryId || !cats.some(cat => cat.id === activeAssetCategoryId)) activeAssetCategoryId = cats[0]?.id || '';
    if(activeAssetClassFilter && !activeAssetClassEntry()) activeAssetClassFilter = '';
    const items = currentAssetItems();
    if(selectedAssetId && !items.some(item => item.id === selectedAssetId)) selectedAssetId = '';
    if(!selectedAssetId && items.length) selectedAssetId = items[0].id;
    selectedAssetIds = new Set([...selectedAssetIds].filter(id => findAssetItem(id)));
}
function normalizeWorkflowState(){
    const libs = assetLibraries();
    if(!activeWorkflowLibraryId || !libs.some(lib => lib.id === activeWorkflowLibraryId)) activeWorkflowLibraryId = assetLibrary.active_library_id || libs[0]?.id || '';
    const cats = workflowCategories();
    if(
        !activeWorkflowCategoryId
        || !cats.some(cat => cat.id === activeWorkflowCategoryId && cat.__libraryId === activeWorkflowLibraryId)
    ){
        activeWorkflowCategoryId = cats[0]?.id || '';
        activeWorkflowLibraryId = cats[0]?.__libraryId || activeWorkflowLibraryId;
    }
    const activeCat = cats.find(cat => cat.id === activeWorkflowCategoryId && cat.__libraryId === activeWorkflowLibraryId) || null;
    if(activeCat?.__libraryId) activeWorkflowLibraryId = activeCat.__libraryId;
    const items = currentWorkflowItems();
    if(selectedWorkflowId && !items.some(item => item.id === selectedWorkflowId)) selectedWorkflowId = '';
    if(!selectedWorkflowId && items.length) selectedWorkflowId = items[0].id;
    selectedWorkflowIds = new Set([...selectedWorkflowIds].filter(id => findWorkflowItem(id)));
}
function normalizePromptState(){
    const libs = promptLibraries();
    if(!activePromptLibraryId || !libs.some(lib => lib.id === activePromptLibraryId)) activePromptLibraryId = promptLibrary.active_library_id || libs[0]?.id || '';
    const cats = activePromptCategories();
    if(activePromptCategory !== 'all' && !cats.some(cat => cat.id === activePromptCategory)) activePromptCategory = 'all';
    const items = currentPromptItems();
    if(selectedPromptId && !items.some(item => item.id === selectedPromptId)) selectedPromptId = '';
    if(!selectedPromptId && items.length) selectedPromptId = items[0].id;
    selectedPromptIds = new Set([...selectedPromptIds].filter(id => findPromptItem(id)));
}
function normalizeCanvasAssetState(){
    const projects = canvasAssetProjects();
    if(!projects.some(project => project.id === activeCanvasAssetProjectId)) activeCanvasAssetProjectId = defaultCanvasAssetProject();
    const activeCanvas = activeCanvasAssetCanvas();
    if(
        activeCanvasAssetCanvasId
        && (
            !activeCanvas
            || activeCanvas.kind !== 'smart'
            || (activeCanvas.project || 'default') !== activeCanvasAssetProjectId
        )
    ) activeCanvasAssetCanvasId = '';
    const items = currentCanvasAssetItems();
    if(selectedCanvasAssetId && !items.some(item => item.id === selectedCanvasAssetId)) selectedCanvasAssetId = '';
    if(!selectedCanvasAssetId && items.length) selectedCanvasAssetId = items[0].id;
    selectedCanvasAssetIds = new Set([...selectedCanvasAssetIds].filter(id => findCanvasAssetItem(id)));
}
async function refreshCanvasAssets(){
    try {
        setStatus('正在刷新画布资产...');
        const data = await apiJson('/api/canvas-assets', {cache:'no-store'});
        canvasAssetsData = {
            categories:Array.isArray(data.categories) ? data.categories : [],
            projects:Array.isArray(data.projects) ? data.projects : [],
            canvases:Array.isArray(data.canvases) ? data.canvases : [],
            items:Array.isArray(data.items) ? data.items : []
        };
        if(activeCanvasAssetProjectId) normalizeCanvasAssetState();
        render();
        setStatus('画布资产已刷新');
    } catch(err) {
        setStatus(err.message || '刷新画布资产失败');
    }
}
function renderStartupState(message='正在打开资产管理…', detail='正在读取素材，画布资产会在后台继续准备。'){
    root.innerHTML = `
        <section class="asset-panel asset-content asset-startup-state">
            <div class="empty-state" role="status">
                <i data-lucide="loader-circle" class="is-loading"></i>
                <strong>${escapeHtml(message)}</strong>
                <span>${escapeHtml(detail)}</span>
            </div>
        </section>
    `;
    refreshIcons();
}
function renderStartupError(error){
    const detail = String(error?.message || '暂时无法读取素材库');
    root.innerHTML = `
        <section class="asset-panel asset-content asset-startup-state">
            <div class="empty-state" role="alert">
                <i data-lucide="triangle-alert"></i>
                <strong>资产管理暂时没有加载完成</strong>
                <span>${escapeHtml(detail)}</span>
                <button class="asset-btn primary" type="button" data-image-space-retry><i data-lucide="refresh-cw"></i><span>重新加载</span></button>
            </div>
        </section>
    `;
    refreshIcons();
}
async function loadAll(){
    setStatus('加载中...');
    renderStartupState();
    const collectionsRequest = apiJson('/api/image-space/collections').then(data => { imageSpaceState.collections = data.collections || []; }).catch(err => setStatus(err.message || '合集加载失败'));
    const assetRequest = apiJson('/api/asset-library');
    const promptRequest = apiJson('/api/prompt-libraries');
    const providerRequest = apiJson('/api/providers', {cache:'no-store'}).catch(() => ({providers:[]}));
    const canvasAssetRequest = apiJson('/api/canvas-assets', {cache:'no-store'}).catch(() => ({categories:[], canvases:[], items:[]}));
    const sharedFoldersRequest = loadSharedFolders();
    const localAssetsRequest = loadLocalAssets();
    const uploadAssetsRequest = loadUploadAssets();
    const promptCasesRequest = loadPromptCases();
    const fileFavoritesRequest = loadFileFavorites();
    let assetData;
    try {
        assetData = await assetRequest;
    } catch(err) {
        renderStartupError(err);
        throw err;
    }
    assetLibrary = assetData.library || {libraries:[], categories:[]};
    void hydrateWorkflowPreviews();
    // 先渲染当前资产管理；提示词、平台、画布索引和本地素材不应阻塞这一屏。
    const libs = assetLibraries();
    activeAssetLibraryId = (libs.find(lib => lib.id === 'default') || libs[0])?.id || '';
    activeWorkflowLibraryId = (libs.find(lib => lib.id === 'default') || libs[0])?.id || '';
    activeAssetCategoryId = '';
    activeWorkflowCategoryId = '';
    selectedAssetId = '';
    selectedWorkflowId = '';
    selectedAssetIds.clear();
    selectedWorkflowIds.clear();
    selectedPromptIds.clear();
    selectedCanvasAssetIds.clear();
    render();
    setStatus('资产管理已显示，正在准备其它内容...');
    const [promptData, providerData, canvasAssetData] = await Promise.all([
        promptRequest,
        providerRequest,
        canvasAssetRequest,
        sharedFoldersRequest,
        localAssetsRequest,
        uploadAssetsRequest,
        collectionsRequest,
        promptCasesRequest,
        fileFavoritesRequest
    ]);
    promptLibrary = promptData.library || {libraries:[]};
    apiProviders = Array.isArray(providerData.providers) ? providerData.providers : [];
    canvasAssetsData = {
        categories:Array.isArray(canvasAssetData.categories) ? canvasAssetData.categories : [],
        projects:Array.isArray(canvasAssetData.projects) ? canvasAssetData.projects : [],
        canvases:Array.isArray(canvasAssetData.canvases) ? canvasAssetData.canvases : [],
        items:Array.isArray(canvasAssetData.items) ? canvasAssetData.items : []
    };
    render();
    setStatus('准备就绪');
}
function render(){
    const scrollState = [...document.querySelectorAll('.nav-scroll,.content-scroll,.detail-scroll')]
        .map((el, index) => ({index, top:el.scrollTop, left:el.scrollLeft}));
    document.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab || btn.id === 'assetTabAssets' && IMAGE_SPACE_TABS.has(activeTab)));
    syncImageSpaceSubtabs();
    root.classList.toggle('generated-mode', activeTab === 'generated');
    root.classList.toggle('hub-cases-mode', activeTab === 'prompt-hub' && hubView === 'cases');
    if(activeTab !== 'skills' && skillManagerOpen){ window.XiaomeiSkillMarket?.close?.(); skillManagerOpen = false; }
    if(activeTab === 'skills') renderSkillManager();
    else if(activeTab === 'prompt-hub') renderPromptHubManager();
    else if(activeTab === 'prompts') renderPromptManager();
    else if(activeTab === 'workflows') renderWorkflowManager();
    else if(activeTab === 'local') renderLocalManager();
    else if(activeTab === 'generated') renderGeneratedManager();
    else if(activeTab === 'assets') uploadAssetsState.view === 'disk' ? renderUploadManager() : renderAssetManager();
    else renderAssetManager();
    refreshIcons();
    prepareVideoThumbs(root);
    syncPromptCaseOverlays();
    if(scrollState.length){
        requestAnimationFrame(() => {
            document.querySelectorAll('.nav-scroll,.content-scroll,.detail-scroll').forEach((el, index) => {
                const saved = scrollState.find(item => item.index === index);
                if(!saved) return;
                el.scrollTop = saved.top;
                el.scrollLeft = saved.left;
            });
        });
    }
}
function renderSkillManager(){
    if(skillManagerOpen) return;
    skillManagerOpen = true;
    root.innerHTML = '<section class="asset-panel asset-content skill-manager-panel"><div id="assetSkillManagerMount" class="skill-manager-mount"></div></section>';
    const mount = root.querySelector('#assetSkillManagerMount');
    if(!window.XiaomeiSkillMarket?.open){
        mount.innerHTML = '<div class="empty-state"><i data-lucide="triangle-alert"></i><strong>Skill 管理暂不可用</strong><span>请刷新资产管理后重试。</span></div>';
        refreshIcons();
        return;
    }
    window.XiaomeiSkillMarket.open({
        body:mount,
        selectedId:window.StudioSharedSkill?.getSelected?.() || '',
        notify:setStatus,
        onSelected:(id)=>window.XiaomeiSkillMarket?.syncSelected?.(id)
    }).catch(err=>setStatus(err.message || '加载 Skill 失败'));
}
function updateSearchQueryFromInput(id, value){
    if(id === 'assetSearch') { assetQuery = value || ''; uploadAssetsState.query = assetQuery; }
    else if(id === 'workflowSearch') workflowQuery = value || '';
    else if(id === 'promptSearch') promptQuery = value || '';
    else if(id === 'hubSearch') hubQuery = value || '';
    else if(id === 'localSearch') localQuery = value || '';
    else if(id === 'localUploadSearch') localUploadQuery = value || '';
    else if(id === 'canvasAssetSearch') canvasAssetQuery = value || '';
    else if(id === 'generatedSearch') generatedAssetsState.query = value || '';
}
function clearSearchSelection(id){
    if(id === 'assetSearch') selectedAssetId = '';
    else if(id === 'workflowSearch') selectedWorkflowId = '';
    else if(id === 'promptSearch') selectedPromptId = '';
    else if(id === 'hubSearch') selectedHubCaseId = '';
    else if(id === 'localSearch') selectedLocalId = '';
    else if(id === 'localUploadSearch') selectedLocalUploadId = '';
    else if(id === 'canvasAssetSearch') selectedCanvasAssetId = '';
    else if(id === 'generatedSearch') generatedAssetsState.selectedId = '';
}
function scheduleSearchRender(id, pos=0, delay=140){
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
        clearSearchSelection(id);
        if(id === 'generatedSearch') loadGeneratedAssets().catch(err => setStatus(err.message || '筛选失败'));
        else if(id === 'assetSearch') {
            if(uploadAssetsState.view === 'disk') loadUploadAssets().catch(err => setStatus(err.message || '筛选上传素材失败'));
            else render();
        }
        else render();
        requestAnimationFrame(() => {
            const input = document.getElementById(id);
            input?.focus();
            try { input?.setSelectionRange?.(pos, pos); } catch(_) {}
        });
    }, Math.max(0, delay));
}
function renderCanvasAssetsManager(){
    normalizeCanvasAssetState();
    const items = currentCanvasAssetItems();
    const groups = groupCanvasAssetItems(items);
    const total = activeCanvasAssetProjectInfo().count;
    const detail = selectedCanvasAsset();
    root.innerHTML = `
        ${renderGeneratedNavigation()}
        <section class="asset-panel asset-content ${canvasAssetManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading">
                    <strong>${escapeHtml(canvasAssetViewTitle())}</strong>
                    <span>生成素材 / ${canvasAssetViewSubtitle(items)}</span>
                </div>
                <div class="asset-tools">
                    <button class="asset-btn" type="button" data-canvas-asset-refresh title="重新读取画布中的图片、视频、音频资源"><i data-lucide="refresh-cw"></i><span>刷新资源</span></button>
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="canvasAssetSearch" class="asset-search" type="search" value="${escapeAttr(canvasAssetQuery)}" placeholder="搜索画布资产"></label>
                    <select id="canvasAssetSort" class="manage-select canvas-sort-select" title="排序方法">
                        <option value="canvas_asc" ${canvasAssetSort === 'canvas_asc' ? 'selected' : ''}>画布名称</option>
                        <option value="updated_desc" ${canvasAssetSort === 'updated_desc' ? 'selected' : ''}>最近更新</option>
                        <option value="updated_asc" ${canvasAssetSort === 'updated_asc' ? 'selected' : ''}>最早更新</option>
                        <option value="name_asc" ${canvasAssetSort === 'name_asc' ? 'selected' : ''}>资产名称</option>
                        <option value="kind" ${canvasAssetSort === 'kind' ? 'selected' : ''}>类型</option>
                    </select>
                    <button class="asset-btn ${canvasAssetManageMode ? 'primary' : ''}" type="button" data-canvas-asset-manage ${total ? '' : 'disabled'}><i data-lucide="list-checks"></i><span>${canvasAssetManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            <div class="manage-tools">
                <span>已选择 ${selectedCanvasAssetIds.size} 个画布资产，支持拖拽框选或逐个勾选。</span>
                <div class="asset-tools">
                    <button class="asset-btn" type="button" data-canvas-asset-select-all ${items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                    <button class="asset-btn" type="button" data-canvas-asset-clear-selection ${selectedCanvasAssetIds.size ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
                    <button class="asset-btn primary" type="button" data-canvas-asset-download-selected ${selectedCanvasAssetIds.size ? '' : 'disabled'}><i data-lucide="download"></i><span>下载所选</span></button>
                </div>
            </div>
            <div class="content-scroll">
                <div class="asset-grid">
                    ${groups.map(group => renderCanvasAssetGroup(group)).join('')}
                    ${items.length ? '' : '<div class="empty-state">当前项目没有可下载的画布资产。可以点击“刷新资源”，或在画布中生成/导入图片、视频、音频后再查看。</div>'}
                </div>
            </div>
        </section>
        <aside class="asset-panel asset-detail">
            ${renderCanvasAssetDetail(detail)}
        </aside>
    `;
}
function renderCanvasAssetTreeBranch(project){
    const canvases = canvasAssetsForProject(project.id);
    const activeParent = project.id === activeCanvasAssetProjectId && !activeCanvasAssetCanvasId;
    const containsActive = project.id === activeCanvasAssetProjectId && !!activeCanvasAssetCanvasId;
    return `<div class="tree-branch ${project.id === activeCanvasAssetProjectId ? 'expanded' : ''}">
        <button class="tree-row tree-parent ${activeParent ? 'active' : ''} ${containsActive ? 'contains-active' : ''}" type="button" data-canvas-asset-project="${escapeAttr(project.id)}">
            <span class="tree-row-icon"><i data-lucide="folder"></i></span>
            <span class="tree-row-name" title="${escapeAttr(project.name || '未命名项目')}">${escapeHtml(project.name || '未命名项目')}</span>
            <span class="tree-row-count">${Number(project.count || 0)}</span>
        </button>
        <div class="tree-children">
            ${canvases.length ? canvases.map(canvas => {
                const active = canvas.id === activeCanvasAssetCanvasId && project.id === activeCanvasAssetProjectId;
                const count = canvasAssetCountForCanvas(canvas.id);
                return `<button class="tree-row tree-child ${active ? 'active' : ''}" type="button" data-canvas-asset-canvas="${escapeAttr(canvas.id)}" data-canvas-asset-canvas-project="${escapeAttr(project.id)}">
                    <span class="tree-elbow"></span>
                    <span class="tree-row-icon"><i data-lucide="${canvas.kind === 'smart' ? 'sparkles' : 'file-image'}"></i></span>
                    <span class="tree-row-name" title="${escapeAttr(canvas.title || '未命名画布')}">${escapeHtml(canvas.title || '未命名画布')}</span>
                    <span class="tree-row-count">${count}</span>
                </button>`;
            }).join('') : '<div class="tree-empty">暂无画布</div>'}
        </div>
    </div>`;
}
function renderCanvasAssetGroup(group){
    if(!group?.title) return (group?.items || []).map(item => renderCanvasAssetCard(item)).join('');
    return `<section class="canvas-asset-group">
        <div class="canvas-asset-group-head">
            <div>
                <strong title="${escapeAttr(group.title)}">${escapeHtml(group.title)}</strong>
                <span>${escapeHtml(group.subtitle || '')}</span>
            </div>
            <small>${(group.items || []).length} 个资产</small>
        </div>
        <div class="canvas-asset-group-grid">
            ${(group.items || []).map(item => renderCanvasAssetCard(item)).join('')}
        </div>
    </section>`;
}
function renderCanvasAssetCard(item){
    return `<article class="asset-card canvas-asset-card ${item.id === selectedCanvasAssetId ? 'active' : ''}" data-canvas-asset-card="${escapeAttr(item.id)}">
        <input class="asset-card-check" type="checkbox" data-canvas-asset-check="${escapeAttr(item.id)}" ${selectedCanvasAssetIds.has(item.id) ? 'checked' : ''}>
        <div class="asset-thumb canvas-asset-thumb">${assetThumb(item)}${renderCanvasAssetKindBadge(item)}</div>
        <div class="asset-card-body">
            <div class="asset-card-name" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || 'canvas asset')}</div>
            <div class="asset-card-meta">${escapeHtml(canvasAssetKindLabel(item))} · ${escapeHtml(item.canvas_title || '未命名画布')}</div>
        </div>
    </article>`;
}
function renderCanvasAssetKindBadge(item){
    const kind = assetKind(item);
    const icon = kind === 'video' ? 'play' : kind === 'audio' ? 'file-audio' : kind === 'text' ? 'file-text' : 'image';
    return `<span class="asset-kind-badge ${escapeAttr(kind)}" title="${escapeAttr(canvasAssetKindLabel(item))}"><i data-lucide="${icon}"></i></span>`;
}
function renderCanvasAssetDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>画布资产详情</strong><span>选择一个画布资产查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="layout-dashboard"></i><span>暂无画布资产</span></div></div>`;
    const kind = assetKind(item);
    const canPreview = ['image','video'].includes(kind);
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>画布资产详情</strong><span>${escapeHtml(canvasAssetKindLabel(item))}</span></div>
            <div class="panel-actions">
                ${canPreview ? `<button class="asset-icon-btn" type="button" data-canvas-asset-preview="${escapeAttr(item.id)}" title="${kind === 'video' ? '预览视频' : '放大预览'}"><i data-lucide="${kind === 'video' ? 'play' : 'maximize-2'}"></i></button>` : ''}
                <button class="asset-icon-btn" type="button" data-canvas-asset-open="${escapeAttr(item.id)}" title="打开链接"><i data-lucide="external-link"></i></button>
                <button class="asset-icon-btn" type="button" data-canvas-asset-copy="${escapeAttr(item.id)}" title="复制链接"><i data-lucide="copy"></i></button>
                <button class="asset-btn primary" type="button" data-canvas-asset-download="${escapeAttr(item.id)}"><i data-lucide="download"></i><span>下载</span></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="detail-media">
                ${canPreview
                    ? `<button class="detail-media-frame detail-media-zoomable" type="button" data-canvas-asset-preview="${escapeAttr(item.id)}" title="${kind === 'video' ? '点击预览视频' : '点击放大预览'}">${assetThumb(item)}</button>`
                    : `<div class="detail-media-frame">${assetThumb(item)}</div>`}
            </div>
            <div class="detail-body">
                <div class="detail-name">${escapeHtml(item.name || '画布资产')}</div>
                <div class="detail-meta-grid">
                    <div class="detail-meta"><span>类型</span><strong>${escapeHtml(canvasAssetKindLabel(item))}</strong></div>
                    <div class="detail-meta"><span>所属项目</span><strong>${escapeHtml(canvasAssetProjects().find(project => project.id === (item.project || 'default'))?.name || '未命名项目')}</strong></div>
                    <div class="detail-meta"><span>来源画布</span><strong title="${escapeAttr(item.canvas_title || '')}">${escapeHtml(item.canvas_title || '未命名画布')}</strong></div>
                    <div class="detail-meta"><span>更新时间</span><strong>${escapeHtml(formatDate(item.canvas_updated_at || item.created_at))}</strong></div>
                    <div class="detail-meta"><span>来源节点</span><strong title="${escapeAttr(item.node_title || item.node_type || '')}">${escapeHtml(item.node_title || item.node_type || '节点')}</strong></div>
                    <div class="detail-meta"><span>节点类型</span><strong>${escapeHtml(item.node_type || '-')}</strong></div>
                </div>
                <div class="detail-url">${escapeHtml(item.url || '')}</div>
            </div>
        </div>
    `;
}
function refreshCanvasAssetSelectionOnly(){
    if(canvasAssetManageMode){ render(); return; }
    document.querySelectorAll('[data-canvas-asset-card]').forEach(card => {
        card.classList.toggle('active', card.dataset.canvasAssetCard === selectedCanvasAssetId);
    });
    document.querySelectorAll('[data-canvas-asset-check]').forEach(input => {
        input.checked = selectedCanvasAssetIds.has(input.dataset.canvasAssetCheck);
    });
    const detail = root.querySelector('.asset-detail');
    if(detail){
        detail.innerHTML = renderCanvasAssetDetail(selectedCanvasAsset());
        refreshIcons();
    }
}
function renderHeadTreeInlineEdit(edit, inputId, saveAttr, cancelAttr){
    if(!edit || edit.placement !== 'head') return '';
    const label = edit.label || '名称';
    return `<div class="head-inline-edit">
        <input id="${escapeAttr(inputId)}" type="text" value="${escapeAttr(edit.value || '')}" placeholder="${escapeAttr(label)}">
        <button type="button" class="primary" ${saveAttr} title="保存"><i data-lucide="check"></i><span>保存</span></button>
        <button type="button" ${cancelAttr} title="取消"><i data-lucide="x"></i><span>取消</span></button>
    </div>`;
}
function renderLocalUploadFolderCreate(){
    if(!localUploadFolderCreateMode) return '';
    return renderHeadTreeInlineEdit(
        {placement:'head', value:'新文件夹', label:'新建文件夹名称'},
        'localUploadFolderCreateInput',
        'data-localup-folder-create-save',
        'data-localup-folder-create-cancel'
    );
}
function focusTreeEditInput(id){
    requestAnimationFrame(() => {
        const input = document.getElementById(id);
        input?.focus();
        input?.select?.();
    });
}
function localUploadItems(){
    return (localAssets || []).filter(item =>
        (imageSpaceState.all.local || !activeLocalUploadFolder || String(item.folder || '') === activeLocalUploadFolder) &&
        imageSpaceMatches(item, {...imageSpaceState.filters.local,query:localUploadQuery}));
}
function findLocalUpload(id){
    return (localAssets || []).find(it => it.id === id) || null;
}
function localUploadFolderExists(path=''){
    const target = String(path || '');
    let found = !target;
    function walk(node){
        if(!node || found) return;
        if(String(node.path || '') === target){ found = true; return; }
        (node.children || []).forEach(walk);
    }
    walk(localUploadTree);
    return found;
}
function localUploadFolderByPath(path=''){
    const target = String(path || '');
    let match = null;
    function walk(node){
        if(!node || match) return;
        if(String(node.path || '') === target){ match = node; return; }
        (node.children || []).forEach(walk);
    }
    walk(localUploadTree);
    return match;
}
function localUploadFolderTitle(){
    const entry = activeLocalUploadClassEntry();
    if(entry) return entry.tag || '智能分类';
    if(!activeLocalUploadFolder) return '本地上传';
    return localUploadFolderByPath(activeLocalUploadFolder)?.name || activeLocalUploadFolder.split('/').pop() || '本地上传';
}
function localUploadViewSubtitle(items){
    const entry = activeLocalUploadClassEntry();
    if(entry) return `智能分类：${entry.label} / ${items.length} 个素材`;
    return `${items.length} / ${(localAssets || []).length} 个素材`;
}
function localUploadClassEntries(){
    return assetClassificationEntriesForItems((localAssets || []).filter(item => assetKind(item) === 'image'));
}
function activeLocalUploadClassEntry(){
    return localUploadClassEntries().find(entry => entry.key === activeLocalUploadClassFilter) || null;
}
function localUploadItemsForClassFilter(key=activeLocalUploadClassFilter){
    const parsed = parseAssetClassFilterKey(key);
    if(!parsed) return [];
    return (localAssets || []).filter(item => {
        const flat = Array.isArray(item?.classification?.flat) ? item.classification.flat : [];
        return flat.some(entry => String(entry.dimension || '') === parsed.dimension && String(entry.tag || '') === parsed.tag);
    });
}
function renderLocalUploadFolderBranch(folder, depth=0){
    if(!folder) return '';
    const path = folder.path || '';
    const active = !activeLocalUploadClassFilter && path === activeLocalUploadFolder;
    const contains = !active && (folder.children || []).some(child => localUploadFolderContainsActive(child));
    return `<div class="tree-branch">
        <button class="tree-row ${depth ? 'tree-child' : 'tree-parent'} ${active ? 'active' : ''} ${contains ? 'contains-active' : ''}" type="button" data-localup-folder="${escapeAttr(path)}">
            ${depth ? '<span class="tree-elbow"></span>' : ''}
            <span class="tree-row-icon"><i data-lucide="${active ? 'folder-open' : (depth ? 'folder' : 'upload-cloud')}"></i></span>
            <span class="tree-row-name">${escapeHtml(folder.name || '文件夹')}</span>
            <span class="tree-row-count">${Number(folder.count || 0)}</span>
        </button>
        ${(folder.children || []).length ? `<div class="tree-children">${folder.children.map(child => renderLocalUploadFolderBranch(child, depth + 1)).join('')}</div>` : ''}
    </div>`;
}
function localUploadFolderContainsActive(folder){
    if(!folder) return false;
    if(activeLocalUploadClassFilter) return false;
    if(String(folder.path || '') === activeLocalUploadFolder) return true;
    return (folder.children || []).some(child => localUploadFolderContainsActive(child));
}
function renderLocalUploadSmartClassTree(){
    return '';
    /* 智能分类树已从素材库界面移除，底层旧数据保留以兼容历史素材。 */
    const entries = localUploadClassEntries();
    const groups = groupedAssetClassificationEntries(entries);
    const activeEntry = activeLocalUploadClassEntry();
    const activeGroup = activeEntry ? assetClassificationEntryGroup(activeEntry)?.id : '';
    return `<div class="tree-smart-class">
        <button class="tree-row tree-parent ${activeLocalUploadClassFilter ? 'contains-active' : ''}" type="button" data-localup-class-root>
            <span class="tree-row-icon"><i data-lucide="tags"></i></span>
            <span class="tree-row-name">智能分类</span>
            <span class="tree-row-count">${groups.length}</span>
        </button>
        ${groups.length ? groups.map(group => `<div class="smart-class-group">
            <button class="smart-class-group-btn ${openLocalUploadClassGroup === group.id ? 'open' : ''} ${activeGroup === group.id ? 'active' : ''}" type="button" data-localup-class-group="${escapeAttr(group.id)}">
                <span>${escapeHtml(group.name)}</span><small>${group.entries.length}</small><i data-lucide="${openLocalUploadClassGroup === group.id ? 'chevron-up' : 'chevron-down'}"></i>
            </button>
            ${openLocalUploadClassGroup === group.id ? `<div class="smart-class-pills">
                ${group.entries.map(entry => `<button class="smart-class-pill ${activeLocalUploadClassFilter === entry.key ? 'active' : ''}" type="button" data-localup-class-filter="${escapeAttr(entry.key)}" title="${escapeAttr(entry.label)}">
                    <span>${escapeHtml(entry.tag)}</span><small>${entry.count}</small>
                </button>`).join('')}
            </div>` : ''}
        </div>`).join('') : '<div class="tree-empty">暂无分类，先选择图片点“智能分类”</div>'}
    </div>`;
}
function selectedLocalUploadImageItems(){
    return [...selectedLocalUploadIds].map(id => findLocalUpload(id)).filter(item => item && assetKind(item) === 'image');
}
function selectedAssetImageItems(){
    return [...selectedAssetIds].map(id => findAssetItem(id)).filter(item => item && assetKind(item) === 'image');
}
function renderLocalManager(){
    activeLocalUploadClassFilter = '';
    openLocalUploadClassGroup = '';
    normalizeLocalCaptionSettings();
    const allItems = localUploadItems();
    const items = localFavoritesOnly ? allItems.filter(item => isFileFavorite('local', item)) : allItems;
    // 只有当选中的素材"真的不存在了"(被删除)才清空；只是被分类/筛选挡住时仍保留预览，
    // 这样切换分类时中间预览不会跳回第一张，方便对照着找相似图片。
    if(selectedLocalUploadId && !findLocalUpload(selectedLocalUploadId)) selectedLocalUploadId = '';
    if(!selectedLocalUploadId && items.length) selectedLocalUploadId = items[0].id;
    const detail = findLocalUpload(selectedLocalUploadId);
    const total = (localAssets || []).length;
    const imageCount = selectedLocalUploadImageItems().length;
    const folderTitle = localUploadFolderTitle();
    root.innerHTML = `
        <aside class="asset-panel asset-nav">
            <div class="panel-head">
                <div class="panel-title"><strong>本地素材</strong><span>资产管理 / 本地素材</span></div>
                ${renderLocalUploadFolderCreate()}
                <div class="panel-actions compact-actions" ${localUploadFolderCreateMode ? 'hidden' : ''}>
                    <button class="asset-icon-btn" type="button" data-localup-folder-new title="新建文件夹"><i data-lucide="folder-plus"></i></button>
                    <button class="asset-icon-btn" type="button" data-localup-folder-rename title="重命名文件夹" ${activeLocalUploadFolder ? '' : 'disabled'}><i data-lucide="pencil"></i></button>
                    <button class="asset-icon-btn danger" type="button" data-localup-folder-delete title="移入回收站" aria-label="移入回收站" ${activeLocalUploadFolder ? '' : 'disabled'}><i data-lucide="trash-2"></i></button>
                </div>
            </div>
            <div class="nav-scroll">
                <div class="nav-tree">
                    <button class="tree-row tree-parent ${localFavoritesOnly ? 'active contains-active' : ''}" type="button" data-localup-fav-filter title="收藏的本地素材">
                        <span class="tree-row-icon"><i data-lucide="star"></i></span>
                        <span class="tree-row-name">我的收藏</span>
                        <span class="tree-row-count">${favoriteFileCount('local')}</span>
                    </button>
                    ${renderLocalUploadFolderBranch(localUploadTree || {path:'', name:'全部上传', count:total, children:[]})}
                    ${renderLocalUploadSmartClassTree()}
                    ${renderImageSpaceCollections()}
                </div>
                <div class="nav-hint">选择图片、视频或音频即可上传；当前文件夹支持新建、重命名和删除。</div>
            </div>
        </aside>
        <section class="asset-panel asset-content ${localUploadManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading">
                    <strong>${localFavoritesOnly ? '我的收藏 · 本地素材' : escapeHtml(folderTitle)}</strong>
                    <span>${localFavoritesOnly ? `收藏的 ${items.length} 个本地素材` : localUploadViewSubtitle(items)}</span>
                </div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="localUploadSearch" class="asset-search" type="search" value="${escapeAttr(localUploadQuery)}" placeholder="搜索本地上传"></label>
                    <button class="asset-btn primary" type="button" data-localup-upload><i data-lucide="upload"></i><span>上传文件</span></button>
                    <button class="asset-btn ${localUploadManageMode ? 'primary' : ''}" type="button" data-localup-manage ${total ? '' : 'disabled'}><i data-lucide="list-checks"></i><span>${localUploadManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            ${renderImageSpaceFilterBar()}
            <div class="manage-tools local-manage-tools">
                <div class="manage-group manage-select-group">
                    <span class="manage-group-title">管理</span>
                    <span class="manage-summary">已选 ${selectedLocalUploadIds.size} 个，其中 ${imageCount} 张图片</span>
                    <div class="asset-tools local-manage-actions">
                        <button class="asset-btn" type="button" data-localup-select-all ${items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                        <button class="asset-btn" type="button" data-localup-clear ${selectedLocalUploadIds.size ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
                        <button class="asset-btn" type="button" data-localup-download-selected ${selectedLocalUploadIds.size ? '' : 'disabled'}><i data-lucide="download"></i><span>下载</span></button>
                        <button class="asset-btn" type="button" data-localup-canvas-selected ${selectedLocalUploadIds.size ? '' : 'disabled'}><i data-lucide="clipboard-paste"></i><span>复制到画布</span></button>
                        <button class="asset-btn" type="button" data-localup-cut-selected ${selectedLocalUploadIds.size ? '' : 'disabled'}><i data-lucide="scissors"></i><span>剪切/移动</span></button>
                        <button class="asset-btn danger" type="button" data-localup-delete-selected ${selectedLocalUploadIds.size ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>删除</span></button>
                    </div>
                </div>
            </div>
            ${renderLocalUploadClipboardBar()}
            <div class="content-scroll">
                <div class="asset-grid">
                    ${localFavoritesOnly ? '' : renderLocalUploadAddCard()}
                    ${items.map(item => renderLocalUploadCard(item)).join('')}
                    ${items.length ? '' : `<div class="empty-state">${localFavoritesOnly ? '还没有收藏的本地素材。点击素材卡片右上角的 ⭐ 即可收藏。' : '当前文件夹还没有内容，可点击上传。'}</div>`}
                </div>
            </div>
        </section>
        <aside class="asset-panel asset-detail">
            ${renderLocalUploadDetail(detail)}
        </aside>
    `;
}
function renderLocalUploadAddCard(){
    return `<button id="localUploadDrop" class="upload-grid-card" type="button" data-localup-upload>
        <span class="upload-thumb"><i data-lucide="upload-cloud"></i></span>
        <span class="upload-body">
            <strong>上传本地素材</strong>
            <small>拖入文件或点击上传</small>
        </span>
    </button>`;
}
function renderLocalUploadCard(item){
    const hasCaption = assetKind(item) === 'image' && String(item.caption || '').trim();
    return `<article class="asset-card ${item.id === selectedLocalUploadId ? 'active' : ''}" data-localup-card="${escapeAttr(item.id)}">
        <input class="asset-card-check" type="checkbox" data-localup-check="${escapeAttr(item.id)}" ${selectedLocalUploadIds.has(item.id) ? 'checked' : ''}>
        <div class="asset-thumb">${assetThumb(item)}</div>
        <button class="asset-card-quick asset-card-fav ${isFileFavorite('local', item) ? 'is-fav' : ''}" type="button" data-localup-favorite="${escapeAttr(item.id)}" title="${isFileFavorite('local', item) ? '取消收藏' : '收藏'}" aria-label="${isFileFavorite('local', item) ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
        <div class="asset-card-body">
            <div class="asset-card-name" data-localup-rename="${escapeAttr(item.id)}" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || '本地素材')}</div>
            <div class="asset-card-meta">${escapeHtml(assetKindLabel(item))} · ${escapeHtml(formatFileSize(item.size))}${hasCaption ? ' · 有提示词' : ''}</div>
        </div>
    </article>`;
}
function renderLocalUploadDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>素材预览</strong><span>选择一个素材查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="image"></i><span>暂无可预览素材</span></div></div>`;
    const isImage = assetKind(item) === 'image';
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>素材预览</strong><span>${escapeHtml(assetKindLabel(item))}</span></div>
            <div class="panel-actions">
                <button class="asset-icon-btn" type="button" data-localup-rename="${escapeAttr(item.id)}" title="重命名"><i data-lucide="pencil"></i></button>
                <button class="asset-icon-btn" type="button" data-localup-download="${escapeAttr(item.id)}" title="下载"><i data-lucide="download"></i></button>
                <button class="asset-icon-btn" type="button" data-localup-open="${escapeAttr(item.id)}" title="新窗口打开"><i data-lucide="external-link"></i></button>
                <button class="asset-icon-btn" type="button" data-localup-copy="${escapeAttr(item.id)}" title="复制链接"><i data-lucide="link"></i></button>
                <button class="asset-icon-btn danger" type="button" data-localup-delete-one="${escapeAttr(item.id)}" title="删除"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="detail-media"><button class="detail-media-frame detail-media-zoomable" type="button" data-localup-preview="${escapeAttr(item.id)}" title="点击放大预览">${assetThumb(item)}</button></div>
            <div class="detail-body">
                <input class="detail-name-input" data-localup-inline-name="${escapeAttr(item.id)}" type="text" value="${escapeAttr(item.name || '本地素材')}" title="直接修改名称">
                <div class="detail-meta-grid">
                    <div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div>
                    <div class="detail-meta"><span>大小</span><strong>${escapeHtml(formatFileSize(item.size))}</strong></div>
                    <div class="detail-meta"><span>上传时间</span><strong>${escapeHtml(formatDate((item.created_at||0)*1000))}</strong></div>
                    <div class="detail-meta"><span>来源</span><strong>本地上传</strong></div>
                </div>
                <div class="detail-url">${escapeHtml(item.url || '')}</div>
                ${isImage ? renderImageSpaceClassification(item) : ''}
                ${isImage ? `
                    <div class="detail-caption-card">
                        <div class="detail-caption-head">
                            <strong>反推提示词</strong>
                            <div class="detail-caption-actions">
                                <button class="asset-btn" type="button" data-localup-caption-one="${escapeAttr(item.id)}" ${localCaptionBusy || localClassifyBusy ? 'disabled' : ''}><i data-lucide="${localCaptionBusy ? 'loader-2' : 'wand-sparkles'}"></i><span>${localCaptionBusy ? '反推中' : '反推'}</span></button>
                                <button class="asset-btn" type="button" data-localup-caption-copy="${escapeAttr(item.id)}"><i data-lucide="copy"></i><span>复制</span></button>
                                <button class="asset-btn primary" type="button" data-localup-caption-save="${escapeAttr(item.id)}"><i data-lucide="save"></i><span>保存</span></button>
                            </div>
                        </div>
                        <textarea id="localUploadCaptionEdit" class="detail-caption-textarea" placeholder="暂无反推提示词，可以批量反推后自动写入，也可以在这里手动编辑。">${escapeHtml(item.caption || '')}</textarea>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}
function refreshLocalUploadSelectionOnly(){
    document.querySelectorAll('[data-localup-card]').forEach(card => {
        card.classList.toggle('active', card.dataset.localupCard === selectedLocalUploadId);
    });
    document.querySelectorAll('[data-localup-check]').forEach(input => {
        input.checked = selectedLocalUploadIds.has(input.dataset.localupCheck);
    });
    const detail = root.querySelector('.asset-detail');
    if(detail){
        detail.innerHTML = renderLocalUploadDetail(findLocalUpload(selectedLocalUploadId));
        refreshIcons();
    }
}
function renderLocalFolderBranch(folder, depth=0){
    const active = folder.id === activeLocalFolderId;
    const contains = !active && (folder.children || []).some(child => child.id === activeLocalFolderId || folderContainsLocalActive(child));
    return `<div class="tree-branch">
        <button class="tree-row ${depth ? 'tree-child' : 'tree-parent'} ${active ? 'active' : ''} ${contains ? 'contains-active' : ''}" type="button" data-local-folder="${escapeAttr(folder.id)}">
            ${depth ? '<span class="tree-elbow"></span>' : ''}
            <span class="tree-row-icon"><i data-lucide="${active ? 'folder-open' : 'folder'}"></i></span>
            <span class="tree-row-name">${escapeHtml(folder.name || '文件夹')}</span>
            <span class="tree-row-count">${localFolderTotal(folder)}</span>
        </button>
        ${(folder.children || []).length ? `<div class="tree-children">${folder.children.map(child => renderLocalFolderBranch(child, depth + 1)).join('')}</div>` : ''}
    </div>`;
}
function folderContainsLocalActive(folder){
    if(!folder) return false;
    if(folder.id === activeLocalFolderId) return true;
    return (folder.children || []).some(child => folderContainsLocalActive(child));
}
function renderLocalCard(item){
    const hasCaption = localItemKind(item) === 'image' && String(item.caption || '').trim();
    return `<article class="asset-card ${item.id === selectedLocalId ? 'active' : ''}" data-local-card="${escapeAttr(item.id)}">
        <input class="asset-card-check" type="checkbox" data-local-check="${escapeAttr(item.id)}" ${selectedLocalIds.has(item.id) ? 'checked' : ''}>
        <div class="asset-thumb">${localAssetThumb(item)}</div>
        <div class="asset-card-body">
            <div class="asset-card-name" title="${escapeAttr(item.relativePath || item.name || '')}">${escapeHtml(item.name || 'local')}</div>
            <div class="asset-card-meta">${escapeHtml(assetKindLabel(item))} · ${escapeHtml(formatFileSize(item.size))}${hasCaption ? ' · 有提示词' : ''}</div>
        </div>
    </article>`;
}
function renderLocalClipboardBar(){
    if(!localClipboard?.items?.length) return '';
    const modeLabel = localClipboard.mode === 'cut' ? '剪切' : '复制';
    const target = activeAssetCategory();
    return `<div class="asset-clipboard-bar">
        <div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span>${escapeHtml(modeLabel)}了 ${localClipboard.items.length} 个本地素材，目标：${escapeHtml(activeAssetLibrary()?.name || '图片资产')} / ${escapeHtml(target?.name || '未选择分组')}</span></div>
        <div class="asset-tools">
            <button class="asset-btn primary" type="button" data-local-import-clipboard ${target ? '' : 'disabled'}><i data-lucide="clipboard-paste"></i><span>导入到图片资产</span></button>
            <button class="asset-icon-btn" type="button" data-local-clear-clipboard title="清空本地剪贴板"><i data-lucide="x"></i></button>
        </div>
    </div>`;
}
function renderLocalDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>本地预览</strong><span>选择一个本地素材查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="folder-open"></i><span>暂无可预览素材</span></div></div>`;
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>本地预览</strong><span>${escapeHtml(assetKindLabel(item))}</span></div>
            <div class="panel-actions">
                <button class="asset-icon-btn" type="button" data-local-open="${escapeAttr(item.id)}" title="打开预览"><i data-lucide="external-link"></i></button>
                <button class="asset-btn primary" type="button" data-local-import-one="${escapeAttr(item.id)}"><i data-lucide="download"></i><span>导入</span></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="detail-media"><button class="detail-media-frame detail-media-zoomable" type="button" data-local-preview="${escapeAttr(item.id)}" title="点击放大预览">${localAssetThumb(item)}</button></div>
            <div class="detail-body">
                <div class="detail-name">${escapeHtml(item.name || '本地素材')}</div>
                <div class="detail-meta-grid">
                    <div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div>
                    <div class="detail-meta"><span>大小</span><strong>${escapeHtml(formatFileSize(item.size))}</strong></div>
                    <div class="detail-meta"><span>修改时间</span><strong>${escapeHtml(formatDate(item.lastModified))}</strong></div>
                    <div class="detail-meta"><span>来源</span><strong>${escapeHtml(activeSharedFolderName || '共享文件夹')}</strong></div>
                </div>
                <div class="detail-url">${escapeHtml(item.relativePath || item.name || '')}</div>
            </div>
        </div>
    `;
}
function renderAssetManager(){
    activeAssetClassFilter = '';
    openAssetClassGroup = '';
    normalizeAssetState();
    const libs = assetLibraries();
    const cats = assetCategories();
    const lib = activeAssetLibrary();
    const cat = activeAssetCategory();
    const allItems = currentAssetItems();
    const items = assetFavoritesOnly ? allItems.filter(item => item.favorite) : allItems;
    const favoriteCount = currentAssetItems().filter(item => item.favorite).length;
    const detail = selectedAsset();
    const imageCount = selectedAssetImageItems().length;
    root.innerHTML = `
        <aside class="asset-panel asset-nav">
            <div class="panel-head">
                <div class="panel-title"><strong>资产层级</strong><span>先选库，再选分组</span></div>
                <div class="panel-actions compact-actions">
                    <button class="asset-btn" type="button" data-upload-disk-view><i data-lucide="upload"></i><span>上传目录</span></button>
                    ${assetTreeEdit?.placement === 'head' ? '' : '<button class="asset-icon-btn" type="button" data-asset-lib-new title="新建资产库"><i data-lucide="plus"></i></button>'}
                    ${renderHeadTreeInlineEdit(assetTreeEdit, 'assetTreeEditInput', 'data-asset-tree-edit-save', 'data-asset-tree-edit-cancel')}
                </div>
            </div>
            <div class="nav-scroll">
                <div class="nav-tree">
                    <button class="tree-row tree-parent ${assetFavoritesOnly ? 'active contains-active' : ''}" type="button" data-asset-fav-filter title="收藏的素材">
                        <span class="tree-row-icon"><i data-lucide="star"></i></span>
                        <span class="tree-row-name">我的收藏</span>
                        <span class="tree-row-count">${favoriteCount}</span>
                    </button>
                    ${libs.map(item => renderAssetTreeBranch(item)).join('')}
                    ${renderImageSpaceCollections()}
                </div>
            </div>
        </aside>
        <section class="asset-panel asset-content ${assetManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading">
                    <strong>${assetFavoritesOnly ? '我的收藏 · 上传素材' : `上传素材 · ${escapeHtml(assetViewTitle())}`}</strong>
                    <span>${assetFavoritesOnly ? `收藏的 ${items.length} 个素材` : assetViewSubtitle(items)}</span>
                </div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="assetSearch" class="asset-search" type="search" value="${escapeAttr(assetQuery)}" placeholder="搜索素材"></label>
                    <button class="asset-btn ${assetManageMode ? 'primary' : ''}" type="button" data-asset-manage><i data-lucide="list-checks"></i><span>${assetManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            ${renderImageSpaceFilterBar()}
            ${renderAssetClipboardBar()}
            ${renderLocalClipboardBar()}
            <div class="manage-tools">
                <div class="manage-group manage-select-group">
                    <span class="manage-group-title">管理</span>
                    <span class="manage-summary">已选 ${selectedAssetIds.size} 个，其中 ${imageCount} 张图片</span>
                    <div class="asset-tools">
                        <button class="asset-btn" type="button" data-asset-select-all ${items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                        <button class="asset-btn" type="button" data-asset-clear-selection ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
                        <button class="asset-btn" type="button" data-asset-cut-selected ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="scissors"></i><span>剪切</span></button>
                        <button class="asset-btn" type="button" data-asset-copy-selected ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="copy"></i><span>复制</span></button>
                        <button class="asset-btn" type="button" data-asset-download-selected ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="download"></i><span>下载所选</span></button>
                        <button class="asset-btn" type="button" data-asset-copy-to-canvas ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="clipboard-paste"></i><span>复制到画布</span></button>
                        <button class="asset-btn danger" type="button" data-asset-delete-selected ${selectedAssetIds.size ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>移入回收站</span></button>
                    </div>
                </div>
                <div class="manage-group manage-ai-group">
                    <span class="manage-group-title">AI 处理</span>
                        <button class="asset-btn" type="button" data-asset-classify-selected ${imageCount && !assetClassifyBusy ? '' : 'disabled'}><i data-lucide="${assetClassifyBusy ? 'loader-2' : 'tags'}"></i><span>${assetClassifyBusy ? '分类中' : '智能分类'}</span></button>
                        <button class="asset-btn" type="button" data-asset-background-remove-selected ${imageCount && !backgroundRemovalBusy ? '' : 'disabled'}><i data-lucide="${backgroundRemovalBusy ? 'loader-2' : 'eraser'}"></i><span>${backgroundRemovalBusy ? '抠图中' : '去背景'}</span></button>
                </div>
            </div>
            <div class="content-scroll">
                <div class="asset-grid">
                    ${activeAssetClassFilter || assetFavoritesOnly ? '' : renderUploadCard(cat)}
                    ${items.map(item => renderAssetCard(item)).join('')}
                    ${items.length ? '' : `<div class="empty-state">${assetFavoritesOnly ? '还没有收藏的上传素材。点击素材卡片右上角的 ⭐ 即可收藏。' : '没有符合条件的素材，可清空筛选或上传素材。'}</div>`}
                </div>
            </div>
        </section>
        <aside class="asset-panel asset-detail">
            ${renderAssetDetail(detail)}
        </aside>
        <div id="assetContextMenu" class="asset-context-menu" role="menu" aria-label="素材操作" hidden>
            <button type="button" data-asset-context-background-remove role="menuitem"><i data-lucide="eraser"></i><span>去背景并生成透明底</span></button>
        </div>
    `;
}
function renderWorkflowManager(){
    normalizeWorkflowState();
    const cats = workflowCategories();
    const cat = activeWorkflowCategory();
    const allItems = currentWorkflowItems();
    const items = workflowFavoritesOnly ? allItems.filter(item => item.favorite) : allItems;
    const favoriteCount = currentWorkflowItems().filter(item => item.favorite).length;
    const detail = selectedWorkflow();
    root.innerHTML = `
        <aside class="asset-panel asset-nav">
            <div class="panel-head">
                <div class="panel-title"><strong>工作流层级</strong><span>独立管理工作流分组</span></div>
                <div class="panel-actions compact-actions">
                    ${workflowTreeEdit?.placement === 'head' ? '' : '<button class="asset-icon-btn" type="button" data-workflow-cat-new title="新建工作流分组"><i data-lucide="folder-plus"></i></button>'}
                    ${renderHeadTreeInlineEdit(workflowTreeEdit, 'workflowTreeEditInput', 'data-workflow-tree-edit-save', 'data-workflow-tree-edit-cancel')}
                </div>
            </div>
            <div class="nav-scroll">
                <div class="nav-tree">
                    <button class="tree-row tree-parent ${workflowFavoritesOnly ? 'active contains-active' : ''}" type="button" data-workflow-fav-filter title="收藏的工作流">
                        <span class="tree-row-icon"><i data-lucide="star"></i></span>
                        <span class="tree-row-name">我的收藏</span>
                        <span class="tree-row-count">${favoriteCount}</span>
                    </button>
                    <div class="tree-branch expanded">
                        <button class="tree-row tree-parent contains-active ${workflowFavoritesOnly ? '' : 'contains-active'}" type="button" data-workflow-root>
                            <span class="tree-row-icon"><i data-lucide="folder-open"></i></span>
                            <span class="tree-row-name">工作流库</span>
                            <span class="tree-row-count">${workflowCount()}</span>
                        </button>
                        <div class="tree-children">
                            ${cats.length ? cats.map(c => {
                                const active = c.id === activeWorkflowCategoryId && c.__libraryId === activeWorkflowLibraryId;
                                return `<button class="tree-row tree-child ${active ? 'active' : ''}" type="button" data-workflow-cat="${escapeAttr(c.id)}" data-workflow-cat-lib="${escapeAttr(c.__libraryId || '')}">
                                <span class="tree-elbow"></span>
                                <span class="tree-row-icon"><i data-lucide="workflow"></i></span>
                                <span class="tree-row-name">${escapeHtml(c.name || '工作流')}</span>
                                <span class="tree-row-count">${(c.items || []).length}</span>
                            </button>${active ? renderWorkflowTreeActionBar() : ''}`;
                            }).join('') : '<div class="tree-empty">暂无工作流分组</div>'}
                        </div>
                    </div>
                </div>
            </div>
        </aside>
        <section class="asset-panel asset-content ${workflowManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading">
                    <strong>${workflowFavoritesOnly ? '我的收藏 · 工作流' : escapeHtml(cat?.name || '工作流')}</strong>
                    <span>${workflowFavoritesOnly ? `收藏的 ${items.length} 个工作流` : `工作流库 / ${items.length} 个工作流`}</span>
                </div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="workflowSearch" class="asset-search" type="search" value="${escapeAttr(workflowQuery)}" placeholder="搜索工作流"></label>
                    <button class="asset-btn ${workflowManageMode ? 'primary' : ''}" type="button" data-workflow-manage><i data-lucide="list-checks"></i><span>${workflowManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            <div class="manage-tools">
                <span>已选择 ${selectedWorkflowIds.size} 个工作流。</span>
                <div class="asset-tools">
                    <button class="asset-btn" type="button" data-workflow-select-all ${items.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                    <button class="asset-btn" type="button" data-workflow-clear-selection ${selectedWorkflowIds.size ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
                    <button class="asset-btn" type="button" data-workflow-export-selected ${selectedWorkflowIds.size ? '' : 'disabled'}><i data-lucide="download"></i><span>导出所选</span></button>
                    <button class="asset-btn" type="button" data-workflow-export-desktop-selected ${selectedWorkflowIds.size ? '' : 'disabled'}><i data-lucide="folder-down"></i><span>导出所选到桌面</span></button>
                    <button class="asset-btn danger" type="button" data-workflow-delete-selected ${selectedWorkflowIds.size ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>移入回收站</span></button>
                </div>
            </div>
            <div class="content-scroll">
                <div class="asset-grid">
                    ${workflowFavoritesOnly ? '' : renderWorkflowUploadCard(cat)}
                    ${items.map(item => renderWorkflowCard(item)).join('')}
                    ${items.length ? '' : `<div class="empty-state">${workflowFavoritesOnly ? '还没有收藏的工作流。点击工作流卡片右上角的 ⭐ 即可收藏。' : '当前分组还没有工作流，可以上传 JSON / ZIP，或从传统画布导出到资产库。'}</div>`}
                </div>
            </div>
        </section>
        <aside class="asset-panel asset-detail">
            ${renderWorkflowDetail(detail)}
        </aside>
    `;
}
function renderWorkflowUploadCard(cat){
    return `<button id="workflowDrop" class="upload-grid-card" type="button" data-workflow-upload ${!cat ? 'disabled' : ''}>
        <span class="upload-thumb"><i data-lucide="upload-cloud"></i></span>
        <span class="upload-body">
            <strong>上传工作流</strong>
            <small>支持 JSON / ZIP</small>
        </span>
    </button>`;
}
function renderWorkflowTreeActionBar(){
    const editHtml = renderWorkflowTreeInlineEdit();
    if(editHtml) return editHtml;
    const deleteKey = `workflow-cat:${activeWorkflowLibraryId}:${activeWorkflowCategoryId}`;
    return `<div class="tree-action-bar child-actions">
        <button type="button" data-workflow-cat-rename><i data-lucide="pencil"></i><span>重命名</span></button>
        <button type="button" class="danger ${pendingTreeDelete === deleteKey ? 'detail-confirm' : ''}" data-workflow-cat-delete><i data-lucide="trash-2"></i><span>${pendingTreeDelete === deleteKey ? '确认删除' : '删除'}</span></button>
    </div>`;
}
function renderWorkflowTreeInlineEdit(){
    if(!workflowTreeEdit || workflowTreeEdit.placement === 'head') return '';
    if(workflowTreeEdit.kind !== 'category-rename') return '';
    const label = workflowTreeEdit.label || '名称';
    return `<div class="tree-inline-edit child-actions">
        <input id="workflowTreeEditInput" type="text" value="${escapeAttr(workflowTreeEdit.value || '')}" placeholder="${escapeAttr(label)}">
        <button type="button" class="primary" data-workflow-tree-edit-save><i data-lucide="check"></i><span>保存</span></button>
        <button type="button" data-workflow-tree-edit-cancel><i data-lucide="x"></i><span>取消</span></button>
    </div>`;
}
function renderWorkflowCard(item){
    return `<article class="asset-card workflow-card ${item.id === selectedWorkflowId ? 'active' : ''}" data-workflow-card="${escapeAttr(item.id)}" draggable="true" data-workflow-drag="${escapeAttr(item.id)}">
        <input class="asset-card-check" type="checkbox" data-workflow-check="${escapeAttr(item.id)}" ${selectedWorkflowIds.has(item.id) ? 'checked' : ''}>
        <div class="asset-thumb">${workflowThumb(item)}</div>
        <button class="asset-card-quick asset-card-fav ${item.favorite ? 'is-fav' : ''}" type="button" data-workflow-favorite="${escapeAttr(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
        <div class="asset-card-body">
            <div class="asset-card-name" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || 'workflow')}</div>
            <div class="asset-card-meta">${escapeHtml(workflowKindLabel(item))}${item.node_count ? ` · ${Number(item.node_count)} 节点` : ''}${item.connection_count ? ` · ${Number(item.connection_count)} 连线` : ''}</div>
            <div class="asset-card-meta">${escapeHtml(formatDate(item.created_at))}</div>
        </div>
    </article>`;
}
function renderWorkflowDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>工作流详情</strong><span>选择一个工作流查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="workflow"></i><span>暂无工作流</span></div></div>`;
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>工作流详情</strong><span>${escapeHtml(workflowKindLabel(item))}</span></div>
            <div class="panel-actions">
                <button class="asset-btn primary" type="button" data-workflow-insert="${escapeAttr(item.id)}" title="插入小美画布"><i data-lucide="corner-down-left"></i><span>插入画布</span></button>
                <button class="asset-btn" type="button" data-workflow-export-desktop="${escapeAttr(item.id)}" title="保存到系统桌面"><i data-lucide="folder-down"></i><span>导出桌面</span></button>
                <button class="asset-icon-btn danger ${pendingDeleteAssetId === item.id ? 'detail-confirm' : ''}" type="button" data-workflow-delete="${escapeAttr(item.id)}" title="${pendingDeleteAssetId === item.id ? '再次点击确认移入回收站' : '移入回收站'}"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="detail-media"><div class="detail-media-frame">${workflowThumb(item, {large:true})}</div></div>
            <div class="detail-body">
                <input class="detail-name-input" data-workflow-inline-name="${escapeAttr(item.id)}" type="text" value="${escapeAttr(item.name || 'workflow')}" title="直接修改名称">
                <div class="detail-meta-grid">
                    <div class="detail-meta"><span>类型</span><strong>${escapeHtml(workflowKindLabel(item))}</strong></div>
                    <div class="detail-meta"><span>结构</span><strong>${item.node_count ? `${Number(item.node_count)} 节点 · ${Number(item.connection_count || 0)} 连线` : '打开后读取结构'}</strong></div>
                    <div class="detail-meta"><span>创建时间</span><strong>${escapeHtml(formatDate(item.created_at))}</strong></div>
                    <div class="detail-meta"><span>位置</span><strong>工作流库</strong></div>
                    <div class="detail-meta"><span>分组</span><strong>${escapeHtml(activeWorkflowCategory()?.name || '工作流')}</strong></div>
                </div>
                <div class="detail-url">${escapeHtml(item.url || '')}</div>
            </div>
        </div>
    `;
}
function renderUploadCard(cat){
    return `<button id="assetDrop" class="upload-grid-card ${assetUploadBusy ? 'uploading' : ''}" type="button" data-asset-upload ${!cat || assetUploadBusy ? 'disabled' : ''}>
        <span class="upload-thumb"><i data-lucide="${assetUploadBusy ? 'loader-circle' : 'upload-cloud'}"></i></span>
        <span class="upload-body">
            <strong>${assetUploadBusy ? '正在上传素材' : '上传到当前分组'}</strong>
            <small>${assetUploadBusy ? '请稍候，不需要重复点击' : '拖入文件或点击上传'}</small>
        </span>
    </button>`;
}
function renderAssetClipboardBar(){
    if(!assetClipboard?.ids?.length) return '';
    const modeLabel = assetClipboard.mode === 'cut' ? '剪切' : '复制';
    const sameTarget = assetClipboard.sourceLibraryId === activeAssetLibraryId && assetClipboard.sourceCategoryId === activeAssetCategoryId;
    const pasteText = sameTarget && assetClipboard.mode === 'cut' ? '选择其他分组后粘贴' : '粘贴到当前分组';
    return `<div class="asset-clipboard-bar">
        <div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span>${escapeHtml(modeLabel)}了 ${assetClipboard.ids.length} 个素材</span></div>
        <div class="asset-tools">
            <button class="asset-btn primary" type="button" data-asset-paste-clipboard ${sameTarget && assetClipboard.mode === 'cut' ? 'disabled' : ''}><i data-lucide="clipboard-paste"></i><span>${escapeHtml(pasteText)}</span></button>
            <button class="asset-icon-btn" type="button" data-asset-clear-clipboard title="清空剪贴板"><i data-lucide="x"></i></button>
        </div>
    </div>`;
}
function renderAssetTreeBranch(lib){
    const isActiveLib = lib.id === activeAssetLibraryId;
    const cats = (lib.categories || []).filter(cat => (cat.type || 'image') === 'image');
    const smartClasses = isActiveLib ? assetClassificationEntriesForLibrary(lib) : [];
    const smartGroups = groupedAssetClassificationEntries(smartClasses);
    const activeClassEntry = isActiveLib ? activeAssetClassEntry() : null;
    const activeClassGroup = activeClassEntry ? assetClassificationEntryGroup(activeClassEntry)?.id : '';
    const showLibActions = isActiveLib && assetTreeFocus === 'library';
    return `<div class="tree-branch ${isActiveLib ? 'expanded' : ''}">
        <button class="tree-row tree-parent ${isActiveLib ? 'contains-active' : ''} ${showLibActions ? 'active' : ''}" type="button" data-asset-lib="${escapeAttr(lib.id)}">
            <span class="tree-row-icon"><i data-lucide="${isActiveLib ? 'folder-open' : 'folder'}"></i></span>
            <span class="tree-row-name">${escapeHtml(lib.name || '资产库')}</span>
            <span class="tree-row-count">${assetCountForLibrary(lib)}</span>
        </button>
        ${showLibActions ? renderAssetTreeActionBar('library') : ''}
        <div class="tree-children">
            ${cats.length ? cats.map(cat => `<button class="tree-row tree-child asset-category-draggable ${isActiveLib && cat.id === activeAssetCategoryId && assetTreeFocus === 'category' ? 'active' : ''}" type="button" draggable="true" data-asset-cat="${escapeAttr(cat.id)}" data-asset-cat-lib="${escapeAttr(lib.id)}" title="拖到本地素材，移动此分组中的 ${(cat.items || []).length} 个素材">
                <span class="tree-elbow"></span>
                <span class="tree-row-icon"><i data-lucide="image"></i></span>
                <span class="tree-row-name">${escapeHtml(cat.name || '分组')}</span>
                <span class="tree-row-count">${(cat.items || []).length}</span>
            </button>${isActiveLib && cat.id === activeAssetCategoryId && assetTreeFocus === 'category' ? renderAssetTreeActionBar('category') : ''}`).join('') : '<div class="tree-empty">暂无分组</div>'}
            ${false && isActiveLib ? `<div class="tree-smart-class">
                <button class="tree-row tree-parent ${activeAssetClassFilter ? 'contains-active' : ''}" type="button" data-asset-class-root="${escapeAttr(lib.id)}">
                    <span class="tree-row-icon"><i data-lucide="tags"></i></span>
                    <span class="tree-row-name">智能分类</span>
                    <span class="tree-row-count">${smartGroups.length}</span>
                </button>
                ${smartGroups.length ? smartGroups.map(group => `<div class="smart-class-group">
                    <button class="smart-class-group-btn ${openAssetClassGroup === group.id ? 'open' : ''} ${activeClassGroup === group.id ? 'active' : ''}" type="button" data-asset-class-group="${escapeAttr(group.id)}">
                        <span>${escapeHtml(group.name)}</span><small>${group.entries.length}</small><i data-lucide="${openAssetClassGroup === group.id ? 'chevron-up' : 'chevron-down'}"></i>
                    </button>
                    ${openAssetClassGroup === group.id ? `<div class="smart-class-pills">
                        ${group.entries.map(entry => `<button class="smart-class-pill ${activeAssetClassFilter === entry.key ? 'active' : ''}" type="button" data-asset-class-filter="${escapeAttr(entry.key)}" data-asset-class-lib="${escapeAttr(lib.id)}" title="${escapeAttr(entry.label)}">
                            <span>${escapeHtml(entry.tag)}</span><small>${entry.count}</small>
                        </button>`).join('')}
                    </div>` : ''}
                </div>`).join('') : '<div class="tree-empty">暂无分类，先选择图片点“智能分类”</div>'}
            </div>` : ''}
        </div>
    </div>`;
}
function renderAssetTreeActionBar(kind){
    const editHtml = renderAssetTreeInlineEdit(kind);
    if(editHtml) return editHtml;
    const deleteKey = kind === 'library' ? `asset-lib:${activeAssetLibraryId}` : `asset-cat:${activeAssetCategoryId}`;
    if(kind === 'library'){
        return `<div class="tree-action-bar library-actions">
            <button type="button" data-asset-cat-new><i data-lucide="folder-plus"></i><span>新分组</span></button>
            <button type="button" data-asset-lib-rename><i data-lucide="pencil"></i><span>重命名</span></button>
            <button type="button" class="danger ${pendingTreeDelete === deleteKey ? 'detail-confirm' : ''}" data-asset-lib-delete><i data-lucide="trash-2"></i><span>${pendingTreeDelete === deleteKey ? '确认删除' : '删除库'}</span></button>
        </div>`;
    }
    return `<div class="tree-action-bar child-actions">
        <button type="button" data-asset-cat-new><i data-lucide="folder-plus"></i><span>新分组</span></button>
        <button type="button" data-asset-cat-rename><i data-lucide="pencil"></i><span>重命名</span></button>
        <button type="button" class="danger ${pendingTreeDelete === deleteKey ? 'detail-confirm' : ''}" data-asset-cat-delete><i data-lucide="trash-2"></i><span>${pendingTreeDelete === deleteKey ? '确认删除' : '删除'}</span></button>
    </div>`;
}
function renderAssetTreeInlineEdit(kind){
    if(!assetTreeEdit) return '';
    if(assetTreeEdit.placement === 'head') return '';
    const expectedKinds = kind === 'library'
        ? ['library-new', 'library-rename', 'category-new']
        : ['category-new', 'category-rename'];
    if(!expectedKinds.includes(assetTreeEdit.kind)) return '';
    const label = assetTreeEdit.label || '名称';
    return `<div class="tree-inline-edit ${kind === 'category' ? 'child-actions' : 'library-actions'}">
        <input id="assetTreeEditInput" type="text" value="${escapeAttr(assetTreeEdit.value || '')}" placeholder="${escapeAttr(label)}">
        <button type="button" class="primary" data-asset-tree-edit-save><i data-lucide="check"></i><span>保存</span></button>
        <button type="button" data-asset-tree-edit-cancel><i data-lucide="x"></i><span>取消</span></button>
    </div>`;
}
function renderAssetCard(item){
    return `<article class="asset-card ${item.id === selectedAssetId ? 'active' : ''}" data-asset-card="${escapeAttr(item.id)}">
        <input class="asset-card-check" type="checkbox" data-asset-check="${escapeAttr(item.id)}" ${selectedAssetIds.has(item.id) ? 'checked' : ''}>
        <div class="asset-thumb">${assetThumb(item)}</div>
        <button class="asset-card-quick asset-card-fav ${item.favorite ? 'is-fav' : ''}" type="button" data-asset-favorite="${escapeAttr(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
        ${assetKind(item) === 'image' ? `<button class="asset-card-quick asset-bg-remove-quick" type="button" data-asset-background-remove="${escapeAttr(item.id)}" aria-label="去背景，生成透明底" title="去背景，生成透明底"><i data-lucide="eraser"></i></button>` : ''}
        <div class="asset-card-body">
            <div class="asset-card-name" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || 'asset')}</div>
            <div class="asset-card-meta">${escapeHtml(assetKindLabel(item))}${item.background_removal ? ' · 透明底' : ''} · ${escapeHtml(formatDate(item.created_at))}</div>
        </div>
    </article>`;
}
function renderAvatarRegistrationCard(item, platform, reg, busy){
    const status = String(reg.status || '');
    const tag = `<span class="avatar-platform-tag">${escapeHtml(avatarPlatformLabel(platform))}</span>`;
    const providerId = avatarProviderIdForPlatform(platform, reg.provider_id || '');
    const provAttr = `data-avatar-prov="${escapeAttr(providerId)}"`;
    if(status === 'Active' && reg.asset_uri){
        return `<div class="avatar-card registered">
            <div class="avatar-head"><i data-lucide="badge-check"></i><span>已认证可用</span>${tag}</div>
            <div class="avatar-uri" title="只能在 ${escapeAttr(avatarPlatformLabel(platform))} 平台的视频生成中通过 @ 调用">${escapeHtml(reg.asset_uri)}</div>
            <div class="asset-tools">
                <button class="asset-btn" type="button" data-avatar-copy="${escapeAttr(reg.asset_uri)}"><i data-lucide="copy"></i><span>复制 asset:// 地址</span></button>
                <button class="asset-btn" type="button" data-avatar-register="${escapeAttr(item.id)}" ${provAttr} ${busy ? 'disabled' : ''}><i data-lucide="refresh-cw"></i><span>${busy ? '处理中…' : '重新注册'}</span></button>
            </div>
        </div>`;
    }
    if(status === 'Processing'){
        return `<div class="avatar-card processing">
            <div class="avatar-head"><i data-lucide="loader"></i><span>审核中</span>${tag}</div>
            <div class="avatar-hint">已提交到 ${escapeHtml(avatarPlatformLabel(platform))} 审核（任务 ${escapeHtml(reg.task_id || '')}），通过后会自动生成 asset:// 地址。审核通常需要几十秒到几分钟。</div>
            <div class="asset-tools">
                <button class="asset-btn primary" type="button" data-avatar-check="${escapeAttr(item.id)}" ${provAttr} ${busy ? 'disabled' : ''}><i data-lucide="refresh-cw"></i><span>${busy ? '查询中…' : '刷新审核状态'}</span></button>
            </div>
        </div>`;
    }
    return `<div class="avatar-card failed">
        <div class="avatar-head"><i data-lucide="x-circle"></i><span>审核未通过</span>${tag}</div>
        <div class="avatar-hint warn">${escapeHtml(reg.detail || '审核未通过，请更换素材后重试。')}</div>
        <div class="asset-tools">
            <button class="asset-btn" type="button" data-avatar-register="${escapeAttr(item.id)}" ${provAttr} ${busy ? 'disabled' : ''}><i data-lucide="refresh-cw"></i><span>${busy ? '处理中…' : '重新提交'}</span></button>
        </div>
    </div>`;
}
function renderAvatarSection(item){
    const busy = avatarBusyId === item.id;
    const regs = (item.registrations && typeof item.registrations === 'object') ? item.registrations : {};
    const cards = Object.keys(regs)
        .filter(platform => regs[platform] && regs[platform].task_id)
        .map(platform => renderAvatarRegistrationCard(item, platform, regs[platform], busy))
        .join('');
    const providers = avatarCandidateProviders();
    if(!providers.length){
        return `<div class="avatar-section">
            ${cards}
            <div class="avatar-head"><i data-lucide="user-round-cog"></i><span>注册为真人/数字人</span></div>
            <div class="avatar-hint">未检测到可用平台。请先在「API 平台管理」中添加并启用 API 平台（如 APIMart）并填写 Key。</div>
        </div>`;
    }
    const selected = activeAvatarProvider();
    const selPlatform = providerAvatarPlatform(selected);
    const supported = providerAvatarSupported(selected);
    const noKey = selected && selected.has_key === false;
    const alreadyRegistered = supported && regs[selPlatform] && regs[selPlatform].task_id;
    const select = `<select class="avatar-provider-select" data-avatar-provider>${providers.map(p => `<option value="${escapeAttr(p.id)}" ${p.id === selected?.id ? 'selected' : ''}>${escapeHtml(avatarProviderOptionLabel(p))}</option>`).join('')}</select>`;
    let registerUI;
    if(!supported){
        registerUI = `<div class="avatar-hint">认证是跨平台功能，但「${escapeHtml(selPlatform ? avatarPlatformLabel(selPlatform) : (selected?.name || selected?.id || '该平台'))}」的资产认证 API 尚未接入（待接入）。请选择已支持的平台，或继续使用官方控制台认证。</div>${select}`;
    } else {
        registerUI = `
            <div class="avatar-hint">提交到 ${escapeHtml(avatarPlatformLabel(selPlatform))} 私域素材审核，通过后生成 asset:// 地址，可在该平台的视频生成中通过 @ 直接调用（一个素材可注册到多个平台，平台间互相隔离）。</div>
            ${select}
            ${noKey ? '<div class="avatar-hint warn">该平台尚未配置 API Key。</div>' : ''}
            ${alreadyRegistered ? '<div class="avatar-hint">该平台已注册，再次提交会覆盖该平台的认证。</div>' : ''}
            <button class="asset-btn primary" type="button" data-avatar-register="${escapeAttr(item.id)}" data-avatar-prov="${escapeAttr(selected?.id || '')}" ${busy || noKey ? 'disabled' : ''}><i data-lucide="user-round-plus"></i><span>${busy ? '注册中，请稍候…' : (alreadyRegistered ? '重新注册到该平台' : '注册并等待审核')}</span></button>`;
    }
    return `<div class="avatar-section">
        ${cards}
        <div class="avatar-head"><i data-lucide="user-round-cog"></i><span>注册到平台</span></div>
        ${registerUI}
    </div>`;
}
function assetBackgroundRemovalNote(item){
    const info = item?.background_removal || {};
    const model = info.model_name || '本地抠图';
    const device = info.device || 'CPU';
    const gpu = info.device_is_gpu || /nvidia|geforce|rtx|gtx|radeon|amd|arc|graphics|cuda/i.test(device);
    return `${model} · ${device}${gpu ? ' · GPU' : ''} · 主体已自动居中 · 原图保留`;
}
function renderAssetDetail(item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>素材预览</strong><span>选择一个素材查看详情</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="image"></i><span>暂无可预览素材</span></div></div>`;
    const isImage = assetKind(item) === 'image';
    if(assetEditMode && item.id === selectedAssetId){
        return `
            <div class="panel-head">
                <div class="panel-title"><strong>编辑素材</strong><span>当前分组内直接保存</span></div>
                <div class="panel-actions">
                    <button class="asset-btn primary" type="button" data-asset-edit-save="${escapeAttr(item.id)}"><i data-lucide="check"></i><span>保存</span></button>
                    <button class="asset-icon-btn" type="button" data-asset-edit-cancel title="取消"><i data-lucide="x"></i></button>
                </div>
            </div>
            <div class="detail-scroll">
                <div class="detail-media"><button class="detail-media-frame detail-media-zoomable" type="button" data-asset-preview="${escapeAttr(item.id)}" title="点击放大预览">${assetThumb(item)}</button></div>
                <div class="inline-edit-form">
                    <label class="inline-edit-field"><span>素材名称</span><input id="assetEditName" type="text" value="${escapeAttr(item.name || '')}" placeholder="素材名称"></label>
                    <div class="detail-meta-grid">
                        <div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div>
                        <div class="detail-meta"><span>创建时间</span><strong>${escapeHtml(formatDate(item.created_at))}</strong></div>
                    </div>
                    <div class="detail-url">${escapeHtml(item.url || '')}</div>
                </div>
            </div>
        `;
    }
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>素材预览</strong><span>${escapeHtml(assetKindLabel(item))}</span></div>
            <div class="panel-actions">
                <button class="asset-icon-btn" type="button" data-asset-download="${escapeAttr(item.id)}" title="下载素材"><i data-lucide="download"></i></button>
                ${isImage ? `<button class="asset-icon-btn" type="button" data-asset-background-remove="${escapeAttr(item.id)}" ${backgroundRemovalBusy ? 'disabled' : ''} title="去背景，生成透明底"><i data-lucide="eraser"></i></button>` : ''}
                <button class="asset-icon-btn" type="button" data-asset-edit-start="${escapeAttr(item.id)}" title="编辑"><i data-lucide="pencil"></i></button>
                <button class="asset-icon-btn danger ${pendingDeleteAssetId === item.id ? 'detail-confirm' : ''}" type="button" data-asset-delete="${escapeAttr(item.id)}" title="${pendingDeleteAssetId === item.id ? '再次点击确认移入回收站' : '移入回收站'}"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="detail-media"><button class="detail-media-frame detail-media-zoomable" type="button" data-asset-preview="${escapeAttr(item.id)}" title="点击放大预览">${assetThumb(item)}</button></div>
            <div class="detail-body">
                <input class="detail-name-input" data-asset-inline-name="${escapeAttr(item.id)}" type="text" value="${escapeAttr(item.name || 'asset')}" title="直接修改名称">
                <div class="detail-meta-grid">
                    <div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div>
                    <div class="detail-meta"><span>创建时间</span><strong>${escapeHtml(formatDate(item.created_at))}</strong></div>
                    <div class="detail-meta"><span>资产库</span><strong>${escapeHtml(activeAssetLibrary()?.name || '资产库')}</strong></div>
                    <div class="detail-meta"><span>分组</span><strong>${escapeHtml(activeAssetCategory()?.name || '分组')}</strong></div>
                </div>
                <div class="detail-url">${escapeHtml(item.url || '')}</div>
                ${item.background_removal ? `<div class="detail-processing-note"><i data-lucide="eraser"></i><span>${escapeHtml(assetBackgroundRemovalNote(item))}</span></div>` : ''}
                ${isImage ? renderImageSpaceClassification(item) : ''}
                ${renderAvatarSection(item)}
            </div>
        </div>
    `;
}
// ===== 资产管理：提示词集合（我的收藏 / 收藏提示词 / 我的提示词 / 提示词模板） =====
async function loadPromptCases(){
    if(promptCasesLoading) return;
    promptCasesLoading = true;
    try {
        const data = await apiJson('/api/prompt-cases?limit=500&sort=recent');
        promptCases = Array.isArray(data.cases) ? data.cases : [];
        promptCaseCategories = Array.isArray(data.categories) ? data.categories : [];
        promptCasesLoaded = true;
        if(activeTab === 'prompt-hub') render();
    } catch(err) {
        if(activeTab === 'prompt-hub') setStatus(err.message || '收藏案例读取失败');
    } finally {
        promptCasesLoading = false;
    }
}
function broadcastPromptCases(message){
    try { const channel = new BroadcastChannel('studio-prompt-cases'); channel.postMessage(message); channel.close(); } catch(err) { /* optional */ }
}
async function loadFileFavorites(){
    try {
        const data = await apiJson('/api/asset-favorites');
        fileFavoriteMap = new Map((Array.isArray(data.items) ? data.items : []).map(item => [item.key, item]));
    } catch(err) {
        fileFavoriteMap = new Map();
    }
}
function fileFavoriteKey(kind, item){
    if(!item) return '';
    if(kind === 'generated') return `generated:${item.rel || item.url || ''}`;
    if(kind === 'local') return `local:${item.id || item.path || item.url || ''}`;
    return `${kind}:${item.id || item.rel || item.url || ''}`;
}
function isFileFavorite(kind, item){ return fileFavoriteMap.has(fileFavoriteKey(kind, item)); }
function favoriteFileCount(kind){
    let count = 0;
    for(const item of fileFavoriteMap.values()){
        if(!kind || item.kind === kind) count += 1;
    }
    return count;
}
async function toggleFileFavorite(kind, item){
    const key = fileFavoriteKey(kind, item);
    if(!key || fileFavoriteBusy.has(key)) return;
    fileFavoriteBusy.add(key);
    try {
        const data = await apiJson('/api/asset-favorites/toggle', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
            key,
            name:item.name || '',
            kind,
            url:item.url || '',
            media_type:assetKind(item) === 'video' ? 'video' : 'image',
            folder:item.folder || ''
        })});
        fileFavoriteMap = new Map((Array.isArray(data.items) ? data.items : []).map(entry => [entry.key, entry]));
        setStatus(data.favorite ? `已收藏「${item.name || key}」，可在「我的收藏」中查看` : `已取消收藏「${item.name || key}」`);
        render();
    } catch(err) {
        setStatus(err.message || '收藏状态更新失败');
    } finally {
        fileFavoriteBusy.delete(key);
    }
}
async function toggleAssetItemFavorite(id){
    const item = findAssetItem(id);
    if(!item) return;
    try {
        const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/favorite`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({favorite:!item.favorite})});
        if(data.library) assetLibrary = data.library;
        const next = findAssetItem(id);
        setStatus(next?.favorite ? `已收藏「${next.name || '素材'}」，可在「我的收藏」中查看` : '已取消收藏素材');
        render();
    } catch(err) {
        setStatus(err.message || '收藏状态更新失败');
    }
}
async function toggleWorkflowItemFavorite(id){
    const item = findWorkflowItem(id);
    if(!item) return;
    try {
        const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/favorite`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({favorite:!item.favorite})});
        if(data.library) assetLibrary = data.library;
        const next = findWorkflowItem(id);
        setStatus(next?.favorite ? `已收藏工作流「${next.name || ''}」，可在「我的收藏」中查看` : '已取消收藏工作流');
        render();
    } catch(err) {
        setStatus(err.message || '收藏状态更新失败');
    }
}
async function togglePromptItemFavorite(id){
    const item = findPromptItem(id);
    if(!item) return;
    try {
        const data = await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}/favorite`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({favorite:!item.favorite})});
        item.favorite = Boolean(data.item?.favorite ?? !item.favorite);
        setStatus(item.favorite ? `已收藏「${item.name || '提示词'}」，可在「我的收藏」中查看` : '已取消收藏提示词');
        render();
    } catch(err) {
        setStatus(err.message || '收藏状态更新失败');
    }
}
async function toggleCaseFavorite(id){
    const item = promptCases.find(entry => entry.id === id);
    if(!item) return;
    try {
        const data = await apiJson(`/api/prompt-cases/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({favorite:!item.favorite})});
        const next = data.case || {...item, favorite:!item.favorite};
        const index = promptCases.findIndex(entry => entry.id === id);
        if(index >= 0) promptCases[index] = next;
        broadcastPromptCases({type:'prompt-cases-updated'});
        setStatus(next.favorite ? '已收藏案例' : '已取消收藏案例');
        render();
        if(hubCaseDrawerOpen && selectedHubCaseId === id) renderCaseDetail(next);
    } catch(err) {
        setStatus(err.message || '收藏状态更新失败');
    }
}
function promptHubLibraryGroups(){
    const libs = promptLibraries();
    return {
        userLibs: libs.filter(lib => lib.id !== 'system'),
        systemLib: libs.find(lib => lib.id === 'system') || null
    };
}
// 内置模板分类（系统库随应用预置的提示词模板）；其余条目（我的/custom、自建分组、自建库）都算“我的提示词”。
const PROMPT_TEMPLATE_BUILTIN_CATS = new Set(['view', 'storyboard', 'character', 'product', 'lighting']);
function promptItemIsMine(lib, item){
    if(!lib || lib.id !== 'system') return true;
    const cat = String(item.category || '');
    return cat === 'custom' || !PROMPT_TEMPLATE_BUILTIN_CATS.has(cat);
}
function hubPromptReadonly(itemId){
    for(const lib of promptLibraries()){
        if((lib.items || []).some(item => item.id === itemId)) return Boolean(lib.readonly);
    }
    return false;
}
function hubPromptSourceLabel(item){
    const lib = promptLibraries().find(entry => entry.id === item.__libId);
    const libName = lib?.name || item.__libName || '';
    const catName = promptCategoryLabel(item.category || 'custom');
    return [libName, catName].filter(Boolean).join(' · ') || '提示词';
}
function hubPromptItemsForView(view){
    const query = hubQuery.trim().toLowerCase();
    const {userLibs, systemLib} = promptHubLibraryGroups();
    const sources = view === 'system' ? (systemLib ? [systemLib] : []) : userLibs;
    const items = [];
    const pushItem = (lib, item) => {
        if(query && ![item.name, item.scene, item.positive, item.negative].filter(Boolean).join('\n').toLowerCase().includes(query)) return;
        items.push({...item, __libId:lib.id, __libName:lib.name || '', __readonly:Boolean(lib.readonly)});
    };
    for(const lib of sources){
        for(const item of (lib.items || [])) pushItem(lib, item);
    }
    // 用户在系统库里自建的提示词（custom/自建分组）归入“我的提示词”，避免与内置模板混在一起。
    if(view !== 'system' && systemLib){
        for(const item of (systemLib.items || [])){
            if(promptItemIsMine(systemLib, item)) pushItem(systemLib, item);
        }
    }
    return items.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}
function favoritePromptItems(){
    const query = hubQuery.trim().toLowerCase();
    const items = [];
    for(const lib of promptLibraries()){
        for(const item of (lib.items || [])){
            if(!item.favorite) continue;
            if(query && ![item.name, item.scene, item.positive].filter(Boolean).join('\n').toLowerCase().includes(query)) continue;
            items.push({...item, __libId:lib.id, __libName:lib.name || '', __readonly:Boolean(lib.readonly)});
        }
    }
    return items.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}
function favoriteCaseItems(){
    const query = hubQuery.trim().toLowerCase();
    return promptCases.filter(item => {
        if(!item.favorite) return false;
        if(!query) return true;
        const haystack = [item.title, item.note, item.prompt?.display, item.settings?.model, item.settings?.model_name, ...(item.tags || [])].filter(Boolean).join('\n').toLowerCase();
        return haystack.includes(query);
    }).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}
function hubVisibleCases(){
    const query = hubQuery.trim().toLowerCase();
    return promptCases.filter(item => {
        if(hubCaseCategory && item.category !== hubCaseCategory) return false;
        if(hubTag && !(item.tags || []).includes(hubTag)) return false;
        if(!query) return true;
        const haystack = [item.title, item.category, item.note, item.prompt?.display, item.prompt?.request, item.settings?.model, item.settings?.model_name, item.settings?.provider, ...(item.tags || [])].filter(Boolean).join('\n').toLowerCase();
        return haystack.includes(query);
    }).sort((a, b) => {
        if(hubSort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
        if(hubSort === 'used') return Number(b.last_used_at || 0) - Number(a.last_used_at || 0) || Number(b.updated_at || 0) - Number(a.updated_at || 0);
        return Number(b.created_at || 0) - Number(a.created_at || 0) || Number(b.updated_at || 0) - Number(a.updated_at || 0);
    });
}
function promptCaseName(caseId){
    return promptCaseCategories.find(item => item.id === caseId)?.name || (caseId === 'uncategorized' ? '未分类' : caseId || '未分类');
}
function renderHubTreeRow(options){
    const {icon, name, count, active, attrs = '', child = false, children = ''} = options;
    return `<div class="tree-branch ${active ? 'expanded' : ''}">
        <button class="tree-row ${child ? 'tree-child' : 'tree-parent'} ${active ? 'active contains-active' : ''}" type="button" ${attrs}>
            ${child ? '<span class="tree-elbow"></span>' : ''}
            <span class="tree-row-icon"><i data-lucide="${icon}"></i></span>
            <span class="tree-row-name">${escapeHtml(name)}</span>
            <span class="tree-row-count">${count}</span>
        </button>
        ${children ? `<div class="tree-children">${children}</div>` : ''}
    </div>`;
}
function renderPromptHubManager(){
    promptDetailContext = 'hub';
    const {userLibs, systemLib} = promptHubLibraryGroups();
    const mineCount = userLibs.reduce((sum, lib) => sum + (lib.items || []).length, 0)
        + (systemLib ? (systemLib.items || []).filter(item => promptItemIsMine(systemLib, item)).length : 0);
    const systemCount = systemLib ? (systemLib.items || []).filter(item => !promptItemIsMine(systemLib, item)).length : 0;
    const favPrompts = favoritePromptItems();
    const favCases = favoriteCaseItems();
    const favCount = favPrompts.length + favCases.length;
    const caseCategories = promptCaseCategories.filter(item => item.id !== 'uncategorized');
    const treeHtml = [
        renderHubTreeRow({icon:'star', name:'我的收藏', count:favCount, active:hubView === 'favorites', attrs:'data-hub-view="favorites" title="收藏的提示词与案例"'}),
        renderHubTreeRow({
            icon:'heart', name:'收藏提示词', count:promptCases.length, active:hubView === 'cases', attrs:'data-hub-view="cases" title="小美画布收藏的生成案例"',
            children:[
                `<button class="tree-row tree-child ${hubView === 'cases' && !hubCaseCategory ? 'active' : ''}" type="button" data-hub-case-cat="">
                    <span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="layout-list"></i></span>
                    <span class="tree-row-name">全部案例</span><span class="tree-row-count">${promptCases.length}</span>
                </button>`,
                ...caseCategories.map(cat => `<button class="tree-row tree-child ${hubView === 'cases' && hubCaseCategory === cat.id ? 'active' : ''}" type="button" data-hub-case-cat="${escapeAttr(cat.id)}">
                    <span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="tag"></i></span>
                    <span class="tree-row-name">${escapeHtml(cat.name || cat.id)}</span><span class="tree-row-count">${promptCases.filter(item => item.category === cat.id).length}</span>
                </button>`)
            ].join('')
        }),
        renderHubTreeRow({icon:'book-open', name:'我的提示词', count:mineCount, active:hubView === 'prompts' && hubPromptView === 'mine', attrs:'data-hub-prompt-view="mine" title="提示词模板库里的提示词"'}),
        renderHubTreeRow({icon:'sparkles', name:'提示词模板', count:systemCount, active:hubView === 'prompts' && hubPromptView === 'system', attrs:'data-hub-prompt-view="system" title="系统内置提示词模板"'})
    ].join('');
    root.classList.toggle('hub-cases-mode', hubView === 'cases');
    let contentHtml = '';
    let detailHtml = '';    if(hubView === 'cases'){
        contentHtml = renderHubCasesPanel();
    } else if(hubView === 'favorites'){
        contentHtml = renderHubFavoritesPanel(favPrompts, favCases);
        const detail = promptCreateMode ? null : findPromptItem(selectedPromptId);
        detailHtml = `<aside class="asset-panel asset-detail">${renderPromptDetail(detail, detail ? hubPromptReadonly(detail.id) : false)}</aside>`;
    } else {
        const readonly = hubPromptView === 'system';
        const items = hubPromptItemsForView(hubPromptView);
        const detail = promptCreateMode ? null : findPromptItem(selectedPromptId);
        // 选中条目时同步激活库，保证编辑/保存走 savePromptEdit 的 activePromptLibrary()
        if(detail) activePromptLibraryId = promptLibraries().find(lib => (lib.items || []).some(item => item.id === detail.id))?.id || activePromptLibraryId;
        const emptyText = items.length
            ? '当前条件下没有提示词，可清空搜索。'
            : (hubPromptView === 'system' ? '系统提示词模板为空。' : '还没有自己的提示词，点「新增」创建一条。');
        contentHtml = `
            <section class="asset-panel asset-content ${promptManageMode ? 'manage-on' : ''}">
                <div class="content-toolbar">
                    <div class="content-heading">
                        <strong>${hubPromptView === 'system' ? '提示词模板' : '我的提示词'}</strong>
                        <span>共 ${items.length} 条提示词</span>
                    </div>
                    <div class="asset-tools">
                        <label class="asset-search-wrap"><i data-lucide="search"></i><input id="hubSearch" class="asset-search" type="search" value="${escapeAttr(hubQuery)}" placeholder="搜索名称、说明或正文"></label>
                        ${hubPromptView === 'system' ? '' : `<button class="asset-btn primary" type="button" data-hub-prompt-new><i data-lucide="file-plus-2"></i><span>新增</span></button>`}
                    </div>
                </div>
                <div class="content-scroll">
                    ${items.length ? `<div class="prompt-list">${items.map(item => renderPromptRow(item, item.__readonly)).join('')}</div>` : `<div class="empty-state">${escapeHtml(emptyText)}</div>`}
                </div>
            </section>`;
        detailHtml = `<aside class="asset-panel asset-detail">${renderPromptDetail(detail, readonly || (detail ? hubPromptReadonly(detail.id) : false))}</aside>`;
    }
    root.innerHTML = `
        <aside class="asset-panel asset-nav">
            <div class="panel-head">
                <div class="panel-title"><strong>提示词</strong><span>收藏案例与可复用提示词</span></div>
            </div>
            <div class="nav-scroll">
                <div class="nav-tree">${treeHtml}</div>
            </div>
        </aside>
        ${contentHtml}
        ${detailHtml}
    `;
}
function renderHubCasesToolbar(){
    const tags = new Map();
    promptCases.forEach(item => (item.tags || []).forEach(tag => tags.set(tag, (tags.get(tag) || 0) + 1)));
    const tagChips = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 18).map(([tag, count]) =>
        `<button type="button" class="case-tag-chip${hubTag === tag ? ' active' : ''}" data-hub-case-tag="${escapeAttr(tag)}">${escapeHtml(tag)}<small>${count}</small></button>`
    ).join('');
    return `
        <div class="content-toolbar">
            <div class="content-heading">
                <strong>${hubCaseCategory ? escapeHtml(promptCaseName(hubCaseCategory)) : '收藏提示词'}</strong>
                <span>小美画布收藏的生成案例，可应用回画布</span>
            </div>
            <div class="asset-tools">
                <label class="asset-search-wrap"><i data-lucide="search"></i><input id="hubSearch" class="asset-search" type="search" value="${escapeAttr(hubQuery)}" placeholder="搜索标题、提示词、标签或模型"></label>
                <label class="case-sort-field"><span>排序</span><select id="hubSortSelect" class="case-sort-select" aria-label="排序">
                    <option value="recent" ${hubSort === 'recent' ? 'selected' : ''}>最近收藏</option>
                    <option value="used" ${hubSort === 'used' ? 'selected' : ''}>最近使用</option>
                    <option value="title" ${hubSort === 'title' ? 'selected' : ''}>标题 A-Z</option>
                </select></label>
                <button class="asset-btn" type="button" data-hub-case-cats><i data-lucide="settings-2"></i><span>管理分类</span></button>
                <button class="asset-btn" type="button" data-hub-cases-refresh title="刷新案例"><i data-lucide="refresh-cw"></i><span>刷新</span></button>
            </div>
        </div>
        ${tagChips ? `<div class="hub-tag-bar"><span class="hub-tag-label">标签</span>${tagChips}${hubTag ? '<button type="button" class="case-tag-chip" data-hub-case-tag-clear>清除标签</button>' : ''}</div>` : ''}
    `;
}
function renderHubCaseCard(item){
    const variants = item.variants || [];
    const model = item.settings?.model_name || item.settings?.model || item.settings?.model_id || item.settings?.provider || '';
    const tags = (item.tags || []).slice(0, 3).map(tag => `<span class="prompt-tag">${escapeHtml(tag)}</span>`).join('');
    return `<article class="case-card ${item.id === selectedHubCaseId ? 'active' : ''}" data-hub-case-card="${escapeAttr(item.id)}">
        <button class="case-card-cover" type="button" data-hub-case-open="${escapeAttr(item.id)}" aria-label="打开 ${escapeAttr(item.title || '案例')}">
            <img src="${escapeAttr(item.cover?.url || variants[0]?.url || '/static/images/logo.png')}" alt="${escapeAttr(item.title || '案例')}" loading="lazy" onerror="this.src='/static/images/logo.png'">
            ${variants.length > 1 ? `<span class="case-card-badge">${variants.length} 张变体</span>` : ''}
        </button>
        <div class="asset-card-body">
            <div class="asset-card-name" title="${escapeAttr(item.title || '')}">${escapeHtml(item.title || '未命名案例')}</div>
            <div class="asset-card-meta">${escapeHtml(promptCaseName(item.category))}${model ? ` · ${escapeHtml(model)}` : ''}</div>
            ${tags ? `<div class="case-card-tags">${tags}</div>` : ''}
            <div class="case-card-foot">
                <span>${item.use_count ? `已使用 ${escapeHtml(String(item.use_count))} 次` : '可再次应用'}</span>
                <span class="case-card-open">查看详情 <i data-lucide="arrow-up-right"></i></span>
            </div>
        </div>
        <button class="asset-card-quick asset-card-fav ${item.favorite ? 'is-fav' : ''}" type="button" data-case-favorite="${escapeAttr(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
    </article>`;
}
function renderHubCasesPanel(){
    const items = hubVisibleCases();
    const cards = promptCasesLoading && !promptCasesLoaded
        ? '<div class="storage-empty">正在读取收藏案例...</div>'
        : items.map(item => renderHubCaseCard(item)).join('');
    const summary = promptCases.length === items.length ? `共 ${promptCases.length} 个案例` : `显示 ${items.length} / ${promptCases.length} 个案例`;
    const hasFilters = Boolean(hubQuery || hubCaseCategory || hubTag);
    return `
        <section class="asset-panel asset-content">
            ${renderHubCasesToolbar()}
            <div class="hub-cases-summary"><span>${promptCasesLoaded ? summary : '正在读取案例…'}</span>${hasFilters ? '<button type="button" class="asset-btn" data-hub-clear-filters><i data-lucide="x"></i><span>清除筛选</span></button>' : ''}</div>
            <div class="content-scroll">
                <div class="case-grid">${cards}</div>
                ${promptCasesLoaded && !items.length ? `<div class="empty-state">${promptCases.length ? '没有匹配的案例，试试清除筛选条件。' : '还没有收藏的生成案例。在小美画布生成满意的结果后，点击「收藏」即可保存到这里。'}</div>` : ''}
            </div>
        </section>`;
}
function renderHubFavoritesPanel(favPrompts, favCases){
    return `
        <section class="asset-panel asset-content">
            <div class="content-toolbar">
                <div class="content-heading">
                    <strong>我的收藏</strong>
                    <span>收藏的提示词与生成案例</span>
                </div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="hubSearch" class="asset-search" type="search" value="${escapeAttr(hubQuery)}" placeholder="搜索收藏内容"></label>
                </div>
            </div>
            <div class="content-scroll">
                ${favPrompts.length ? `
                    <div class="hub-section-head"><strong>提示词</strong><span>${favPrompts.length} 条</span></div>
                    <div class="prompt-list" style="margin-bottom:18px;">${favPrompts.map(item => renderPromptRow(item, item.__readonly)).join('')}</div>` : ''}
                ${favCases.length ? `
                    <div class="hub-section-head"><strong>生成案例</strong><span>${favCases.length} 个</span></div>
                    <div class="case-grid">${favCases.map(item => renderHubCaseCard(item)).join('')}</div>` : ''}
                ${!favPrompts.length && !favCases.length ? `<div class="empty-state">还没有收藏内容。在素材、工作流、提示词或案例上点击 ⭐ 收藏，都会汇集到这里。</div>` : ''}
            </div>
        </section>`;
}
// ===== 资产管理：案例详情抽屉与分类管理 =====
const CASE_SETTING_LABELS = Object.freeze({
    engine:'引擎', apiKind:'接口类型', provider_id:'平台', model:'模型', ratio:'比例', resolution:'清晰度',
    customRatio:'自定义比例', customRatioWidth:'自定义比例宽度', customRatioHeight:'自定义比例高度', customSize:'自定义尺寸',
    quality:'质量', count:'生成数量', imageOperation:'图像操作', upscaleResolution:'放大清晰度', requestMode:'任务模式',
    videoProvider:'视频平台', videoModel:'视频模型', videoAspect:'视频画幅', videoResolution:'视频清晰度', videoDuration:'视频时长',
    videoEnhancePrompt:'视频提示词增强', videoEnableUpsample:'视频启用超分', size:'尺寸', customWidth:'自定义宽度', customHeight:'自定义高度',
    enhanceUpscaleRes:'增强清晰度', editUpscaleRes:'编辑清晰度', comfyMode:'ComfyUI 模式', comfyWorkflow:'ComfyUI 工作流',
    rhConfigKey:'RunningHub 配置', rhPayment:'RunningHub 计费', rhInstanceType:'RunningHub 实例类型'
});
const CASE_SETTING_VALUE_LABELS = Object.freeze({
    engine:{api:'在线 API', comfyui:'ComfyUI', codex:'Codex', gemini:'Gemini', jimeng:'即梦', runninghub:'RunningHub', volcengine:'火山引擎'},
    apiKind:{image:'图片', video:'视频'}, imageOperation:{generate:'生成', upscale:'放大'}, requestMode:{async:'异步', sync:'同步'},
    resolution:{auto:'自动', '1k':'1K', '2k':'2K', '4k':'4K'}, upscaleResolution:{auto:'自动', '1k':'1K', '2k':'2K', '4k':'4K'},
    videoResolution:{auto:'自动', '1k':'1K', '2k':'2K', '4k':'4K'}, quality:{auto:'自动', low:'低', medium:'中', high:'高'}
});
function caseSettingLabel(key){ return CASE_SETTING_LABELS[key] || key; }
function formatCaseSetting(value, key = ''){
    if(Array.isArray(value)) return value.map(item => formatCaseSetting(item, key)).join(', ');
    if(typeof value === 'object') return JSON.stringify(value);
    if(typeof value === 'boolean') return value ? '是' : '否';
    const labels = CASE_SETTING_VALUE_LABELS[key];
    const normalized = String(value).toLowerCase();
    return labels?.[normalized] || String(value);
}
function formatCaseDate(value){
    const raw = Number(value);
    const date = new Date(raw > 100000000000 ? raw : raw * 1000);
    if(Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}
let caseOverlayBodyMinHeight = null;
function extendCaseOverlayHost(scale, scrollTop){
    if(!document.body) return;
    if(caseOverlayBodyMinHeight === null){
        caseOverlayBodyMinHeight = {value:document.body.style.getPropertyValue('min-height'), priority:document.body.style.getPropertyPriority('min-height')};
    }
    document.body.style.setProperty('min-height', `${((window.innerHeight + scrollTop) / scale).toFixed(3)}px`, 'important');
}
function restoreCaseOverlayHost(){
    if(!document.body || caseOverlayBodyMinHeight === null) return;
    const {value, priority} = caseOverlayBodyMinHeight;
    if(value) document.body.style.setProperty('min-height', value, priority);
    else document.body.style.removeProperty('min-height');
    caseOverlayBodyMinHeight = null;
}
function syncCaseOverlayViewport(node){
    if(!node) return;
    const rootEl = document.documentElement;
    const scaleValue = Number(getComputedStyle(rootEl).getPropertyValue('--studio-ui-scale'));
    const scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
    const scaled = rootEl.classList.contains('studio-ui-scaled') && Math.abs(scale - 1) > 0.01;
    if(!scaled){
        ['top', 'bottom', 'height'].forEach(prop => node.style.removeProperty(prop));
        restoreCaseOverlayHost();
        return;
    }
    const scrollTop = Math.max(0, Number(window.scrollY || rootEl.scrollTop || 0));
    extendCaseOverlayHost(scale, scrollTop);
    node.style.top = `${(scrollTop / scale).toFixed(3)}px`;
    node.style.bottom = 'auto';
    node.style.height = `${(window.innerHeight / scale).toFixed(3)}px`;
}
function syncPromptCaseOverlays(){
    const drawer = document.getElementById('promptCaseDrawer');
    const modal = document.getElementById('caseCategoryModal');
    if(drawer && !drawer.hidden) syncCaseOverlayViewport(drawer);
    if(modal && !modal.hidden) syncCaseOverlayViewport(modal);
    if((!drawer || drawer.hidden) && (!modal || modal.hidden)) restoreCaseOverlayHost();
}
function caseById(id){ return promptCases.find(item => item.id === id) || null; }
function renderCaseDetail(item){
    const body = document.getElementById('caseDetailBody');
    if(!body || !item) return;
    const variants = item.variants || [];
    hubCaseVariantIndex = Math.max(0, Math.min(hubCaseVariantIndex, Math.max(variants.length - 1, 0)));
    const currentCover = variants[hubCaseVariantIndex] || item.cover;
    const settings = item.settings && typeof item.settings === 'object' ? item.settings : {};
    const apiKind = String(settings.apiKind || '').trim().toLowerCase();
    const isVideoCase = apiKind === 'video' || (!apiKind && Boolean(String(settings.videoModel || settings.videoProvider || '').trim()));
    const settingEntries = Object.entries(settings)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .slice(0, 18)
        .filter(([key]) => !/^_?video/i.test(String(key)) || isVideoCase);
    const references = Array.isArray(item.references) ? item.references : [];
    const source = item.source || {};
    const coverUrl = currentCover?.url || item.cover?.url || variants[0]?.url || '/static/images/logo.png';
    body.innerHTML = `
        <div class="case-detail-cover"><img src="${escapeAttr(coverUrl)}" alt="${escapeAttr(item.title || '案例')}" onerror="this.src='/static/images/logo.png'"></div>
        ${variants.length > 1 ? `<div class="case-detail-variants">${variants.map((variant, index) => `<button class="case-variant-thumb${index === hubCaseVariantIndex ? ' active' : ''}" type="button" data-case-variant="${index}" title="变体 ${index + 1}"><img src="${escapeAttr(variant?.url || '/static/images/logo.png')}" alt="变体 ${index + 1}"></button>`).join('')}</div>` : ''}
        <div class="case-detail-actions">
            <button class="asset-btn primary" type="button" data-case-apply="${escapeAttr(item.id)}"><i data-lucide="wand-2"></i><span>应用到画布</span></button>
            <button class="asset-btn" type="button" data-case-copy="${escapeAttr(item.id)}"><i data-lucide="copy"></i><span>复制提示词</span></button>
            <button class="asset-btn" type="button" data-case-favorite="${escapeAttr(item.id)}"><i data-lucide="star" class="${item.favorite ? 'case-fav-on' : ''}"></i><span>${item.favorite ? '取消收藏' : '收藏'}</span></button>
            <button class="asset-btn danger ${pendingDeleteCaseId === item.id ? 'detail-confirm' : ''}" type="button" data-case-delete="${escapeAttr(item.id)}"><i data-lucide="trash-2"></i><span>${pendingDeleteCaseId === item.id ? '确认删除' : '删除'}</span></button>
        </div>
        <section class="case-detail-section">
            <h3>案例信息 <span>可编辑</span></h3>
            <form class="case-detail-form" id="caseMetadataForm">
                <label>标题<input name="title" maxlength="120" value="${escapeAttr(item.title || '')}"></label>
                <div class="case-form-row">
                    <label>分类<select name="category">${promptCaseCategories.filter(cat => cat.id !== 'uncategorized').map(cat => `<option value="${escapeAttr(cat.id)}" ${item.category === cat.id ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`).join('')}</select></label>
                    <label>标签<input name="tags" maxlength="300" value="${escapeAttr((item.tags || []).join('、'))}" placeholder="用顿号或逗号分隔"></label>
                </div>
                <label>备注<textarea name="note" maxlength="1000" placeholder="补充使用心得或适用场景">${escapeHtml(item.note || '')}</textarea></label>
                <div class="case-form-actions"><button class="asset-btn" type="submit"><i data-lucide="save"></i><span>保存修改</span></button></div>
            </form>
        </section>
        <section class="case-detail-section"><h3>可编辑提示词</h3><div class="case-prompt-block">${escapeHtml(item.prompt?.display || '')}</div></section>
        ${references.length ? `<section class="case-detail-section"><h3>参考图 <span>${references.length} 张</span></h3><div class="case-detail-refs">${references.map((reference, index) => `<div><a href="${escapeAttr(reference?.url || '')}" target="_blank" rel="noreferrer"><img src="${escapeAttr(reference?.url || '')}" alt="参考图 ${index + 1}" onerror="this.style.opacity='.25'"></a><span>${escapeHtml(reference?.name || `参考图 ${index + 1}`)}</span></div>`).join('')}</div></section>` : ''}
        ${settingEntries.length ? `<section class="case-detail-section"><h3>生成参数</h3><dl class="case-detail-settings">${settingEntries.map(([key, value]) => `<div><dt>${escapeHtml(caseSettingLabel(key))}</dt><dd title="${escapeAttr(formatCaseSetting(value, key))}">${escapeHtml(formatCaseSetting(value, key))}</dd></div>`).join('')}</dl></section>` : ''}
        <section class="case-detail-section"><h3>来源</h3><p class="case-detail-source">${escapeHtml(source.canvas_title || '小美画布')}${source.node_id ? ` · 节点 ${escapeHtml(source.node_id)}` : ''}<br>${source.run_at ? escapeHtml(formatCaseDate(source.run_at)) : '生成时间未记录'}${item.use_count ? ` · 已使用 ${escapeHtml(String(item.use_count))} 次` : ''}</p></section>
    `;
    body.querySelectorAll('[data-case-variant]').forEach(button => button.addEventListener('click', () => {
        hubCaseVariantIndex = Number(button.dataset.caseVariant) || 0;
        renderCaseDetail(item);
    }));
    document.getElementById('caseMetadataForm')?.addEventListener('submit', event => saveCaseMetadata(event, item));
    refreshIcons();
}
function openPromptCase(id){
    const item = caseById(id);
    if(!item) return;
    selectedHubCaseId = item.id;
    hubCaseVariantIndex = 0;
    pendingDeleteCaseId = '';
    document.getElementById('caseDetailTitle').textContent = item.title || '案例详情';
    const drawer = document.getElementById('promptCaseDrawer');
    drawer.hidden = false;
    hubCaseDrawerOpen = true;
    syncCaseOverlayViewport(drawer);
    renderCaseDetail(item);
    window.requestAnimationFrame(syncPromptCaseOverlays);
}
function closePromptCaseDrawer(){
    const drawer = document.getElementById('promptCaseDrawer');
    if(!drawer) return;
    drawer.hidden = true;
    hubCaseDrawerOpen = false;
    selectedHubCaseId = '';
    pendingDeleteCaseId = '';
    syncPromptCaseOverlays();
}
async function saveCaseMetadata(event, item){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const tags = String(data.get('tags') || '').split(/[、,，\n]/).map(tag => tag.trim()).filter(Boolean);
    try {
        const updated = await apiJson(`/api/prompt-cases/${encodeURIComponent(item.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
            title:data.get('title') || '',
            category:data.get('category') || item.category,
            tags,
            note:data.get('note') || ''
        })});
        const next = updated.case || updated;
        const index = promptCases.findIndex(entry => entry.id === item.id);
        if(index >= 0) promptCases[index] = next;
        document.getElementById('caseDetailTitle').textContent = next.title || '案例详情';
        broadcastPromptCases({type:'prompt-cases-updated'});
        render();
        renderCaseDetail(next);
        setStatus('案例信息已保存');
    } catch(err) {
        setStatus(err.message || '案例保存失败');
    }
}
async function deleteCaseItem(id){
    const item = caseById(id);
    if(!item) return;
    if(pendingDeleteCaseId !== id){
        pendingDeleteCaseId = id;
        renderCaseDetail(item);
        setStatus('再次点击「删除」确认');
        return;
    }
    if(!window.confirm(`确定删除「${item.title || '未命名案例'}」吗？案例副本会被删除，原画布素材不会受影响。`)) return;
    try {
        await apiJson(`/api/prompt-cases/${encodeURIComponent(id)}`, {method:'DELETE'});
        promptCases = promptCases.filter(entry => entry.id !== id);
        closePromptCaseDrawer();
        broadcastPromptCases({type:'prompt-cases-updated', deleted_case_id:id, deleted_media_urls:Array.isArray(item.source?.media_urls) ? item.source.media_urls : []});
        render();
        setStatus('案例已删除');
    } catch(err) {
        pendingDeleteCaseId = '';
        setStatus(err.message || '案例删除失败');
    }
}
async function copyCasePrompt(id){
    const item = caseById(id);
    const prompt = item?.prompt?.display || '';
    if(!prompt) return;
    try {
        await navigator.clipboard.writeText(prompt);
        setStatus('提示词已复制');
    } catch(err) {
        const area = document.createElement('textarea');
        area.value = prompt;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        setStatus('提示词已复制');
    }
}
async function applyCaseToCanvas(id){
    const item = caseById(id);
    if(!item) return;
    try { window.parent?.postMessage({type:'prompt-case-apply-request', case:item}, location.origin); } catch(err) { /* standalone view */ }
    try {
        await apiJson(`/api/prompt-cases/${encodeURIComponent(id)}/use`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
        item.use_count = Number(item.use_count || 0) + 1;
        item.last_used_at = Date.now();
    } catch(err) { /* usage telemetry is best-effort */ }
    setStatus('已发送到小美画布，不会自动生成');
}
function openCaseCategoryModal(){
    caseCategoryModalOpen = true;
    const modal = document.getElementById('caseCategoryModal');
    modal.hidden = false;
    syncCaseOverlayViewport(modal);
    renderCaseCategoryList();
    window.requestAnimationFrame(syncPromptCaseOverlays);
}
function closeCaseCategoryModal(){
    caseCategoryModalOpen = false;
    const modal = document.getElementById('caseCategoryModal');
    if(modal) modal.hidden = true;
    syncPromptCaseOverlays();
}
function renderCaseCategoryList(){
    const list = document.getElementById('caseCategoryList');
    if(!list) return;
    list.innerHTML = promptCaseCategories.filter(cat => cat.id !== 'uncategorized').map(cat => `
        <div class="case-category-row">
            <span title="${escapeAttr(cat.name)}">${escapeHtml(cat.name)}</span>
            <span class="case-category-actions">
                <button class="asset-icon-btn" type="button" data-case-cat-rename="${escapeAttr(cat.id)}" title="重命名"><i data-lucide="pencil"></i></button>
                <button class="asset-icon-btn danger" type="button" data-case-cat-delete="${escapeAttr(cat.id)}" title="删除"><i data-lucide="trash-2"></i></button>
            </span>
        </div>`).join('');
    refreshIcons();
}
async function addCaseCategory(){
    const input = document.getElementById('newCaseCategoryInput');
    const name = input?.value.trim();
    if(!name) return setStatus('请先输入分类名称');
    try {
        const data = await apiJson('/api/prompt-cases/categories', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        promptCaseCategories = data.categories || promptCaseCategories;
        if(input) input.value = '';
        renderCaseCategoryList();
        render();
        setStatus('分类已新增');
    } catch(err) {
        setStatus(err.message || '分类新增失败');
    }
}
async function renameCaseCategory(id){
    const cat = promptCaseCategories.find(item => item.id === id);
    if(!cat) return;
    const name = window.prompt('请输入新的分类名称', cat.name);
    if(!name || name.trim() === cat.name) return;
    try {
        const data = await apiJson(`/api/prompt-cases/categories/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name.trim()})});
        promptCaseCategories = data.categories || promptCaseCategories;
        renderCaseCategoryList();
        render();
        setStatus('分类已重命名');
    } catch(err) {
        setStatus(err.message || '分类重命名失败');
    }
}
async function removeCaseCategory(id){
    const cat = promptCaseCategories.find(item => item.id === id);
    if(!cat) return;
    const fallback = promptCaseCategories.find(item => item.id !== id && item.id !== 'uncategorized');
    if(!window.confirm(`删除「${cat.name}」？对应案例会自动归入「${fallback?.name || '第一个可用分类'}」。`)) return;
    try {
        const data = await apiJson(`/api/prompt-cases/categories/${encodeURIComponent(id)}`, {method:'DELETE'});
        promptCaseCategories = data.categories || promptCaseCategories;
        promptCases = Array.isArray(data.cases) ? data.cases : promptCases;
        if(hubCaseCategory === id) hubCaseCategory = '';
        renderCaseCategoryList();
        render();
        setStatus('分类已删除');
    } catch(err) {
        setStatus(err.message || '分类删除失败');
    }
}
function renderPromptManager(){
    promptDetailContext = 'manager';
    normalizePromptState();
    const libs = promptLibraries();
    const lib = activePromptLibrary();
    const readonly = Boolean(lib?.readonly);
    const cats = activePromptCategories();
    const items = currentPromptItems();
    const detail = promptCreateMode ? null : selectedPrompt();
    const promptEmptyText = (lib?.items || []).length
        ? '当前条件下没有提示词。可以切换分类或清空搜索条件。'
        : `${lib?.name || '当前提示词模板库'} 暂无提示词，点击「新增」添加。`;
    root.innerHTML = `
        <aside class="asset-panel asset-nav">
            <div class="panel-head">
                <div class="panel-title"><strong>提示词模板库</strong><span>可创建多个提示词模板库</span></div>
                <div class="panel-actions compact-actions">
                    ${promptTreeEdit?.placement === 'head' ? '' : '<button class="asset-icon-btn" type="button" data-prompt-lib-new title="新建提示词模板库"><i data-lucide="plus"></i></button>'}
                    ${renderHeadTreeInlineEdit(promptTreeEdit, 'promptTreeEditInput', 'data-prompt-tree-edit-save', 'data-prompt-tree-edit-cancel')}
                </div>
            </div>
            <div class="nav-scroll">
                <div class="nav-tree">
                    ${libs.map(item => renderPromptTreeBranch(item)).join('')}
                </div>
            </div>
        </aside>
        <section class="asset-panel asset-content ${promptManageMode ? 'manage-on' : ''}">
            <div class="content-toolbar">
                <div class="content-heading">
                     <strong>${escapeHtml(lib?.name || '提示词模板库')}</strong>
                    <span>共 ${items.length} 条提示词</span>
                </div>
                <div class="asset-tools">
                    <label class="asset-search-wrap"><i data-lucide="search"></i><input id="promptSearch" class="asset-search" type="search" value="${escapeAttr(promptQuery)}" placeholder="搜索名称、说明或正文"></label>
                    <button class="asset-btn primary" type="button" data-prompt-new ${readonly ? 'disabled' : ''}><i data-lucide="file-plus-2"></i><span>新增</span></button>
                    <button class="asset-btn ${promptManageMode ? 'primary' : ''}" type="button" data-prompt-manage><i data-lucide="list-checks"></i><span>${promptManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            <div class="manage-tools">
                <span>已选择 ${selectedPromptIds.size} 条提示词，支持拖拽框选或逐个勾选。</span>
                <div class="asset-tools">
                    <button class="asset-btn" type="button" data-prompt-select-all ${items.length && !readonly ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
                    <button class="asset-btn" type="button" data-prompt-clear-selection ${selectedPromptIds.size ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
                    <button class="asset-btn danger ${pendingBatchDelete === 'prompt' ? 'detail-confirm' : ''}" type="button" data-prompt-delete-selected ${readonly || !selectedPromptIds.size ? 'disabled' : ''}><i data-lucide="trash-2"></i><span>${pendingBatchDelete === 'prompt' ? '确认删除' : '删除所选'}</span></button>
                </div>
            </div>
            <div class="content-scroll">
                ${items.length ? `<div class="prompt-list">${items.map(item => renderPromptRow(item, readonly)).join('')}</div>` : `<div class="empty-state">${escapeHtml(promptEmptyText)}</div>`}
            </div>
        </section>
        <aside class="asset-panel asset-detail">
            ${renderPromptDetail(detail, readonly)}
        </aside>
    `;
}
function renderPromptTreeBranch(lib){
    const isActiveLib = lib.id === activePromptLibraryId;
    // 每个库渲染自己的分类，不再回退到激活库/系统库的分类（修复新库错显系统分类）。
    const cats = promptCategoriesFor(lib);
    const libId = escapeAttr(lib.id);
    const readonly = Boolean(lib.readonly);
    const showLibActions = isActiveLib && promptTreeFocus === 'library';
    return `<div class="tree-branch ${isActiveLib ? 'expanded' : ''}">
        <button class="tree-row tree-parent ${isActiveLib ? 'contains-active' : ''} ${showLibActions ? 'active' : ''}" type="button" data-prompt-lib="${libId}">
            <span class="tree-row-icon"><i data-lucide="${lib.id === 'system' ? 'sparkles' : 'book-open'}"></i></span>
             <span class="tree-row-name">${escapeHtml(lib.name || '提示词模板库')}</span>
            <span class="tree-row-count">${(lib.items || []).length}</span>
        </button>
        ${showLibActions ? renderPromptTreeActionBar('library') : ''}
        <div class="tree-children">
            <button class="tree-row tree-child ${isActiveLib && activePromptCategory === 'all' && promptTreeFocus === 'category' ? 'active' : ''}" type="button" data-prompt-cat="all" data-prompt-cat-lib="${libId}">
                <span class="tree-elbow"></span>
                <span class="tree-row-icon"><i data-lucide="layout-list"></i></span>
                <span class="tree-row-name">全部提示词</span>
                <span class="tree-row-count">${promptCountForCategory('all', lib)}</span>
            </button>
            ${cats.map(cat => {
                const active = isActiveLib && cat.id === activePromptCategory && promptTreeFocus === 'category';
                return `<button class="tree-row tree-child ${active ? 'active' : ''}" type="button" data-prompt-cat="${escapeAttr(cat.id)}" data-prompt-cat-lib="${libId}">
                <span class="tree-elbow"></span>
                <span class="tree-row-icon"><i data-lucide="tag"></i></span>
                <span class="tree-row-name">${escapeHtml(cat.name || promptCategoryLabel(cat.id))}</span>
                <span class="tree-row-count">${promptCountForCategory(cat.id, lib)}</span>
            </button>${active ? renderPromptTreeActionBar('category') : ''}`;
            }).join('')}
        </div>
    </div>`;
}
function renderPromptTreeActionBar(kind){
    const editHtml = renderPromptTreeInlineEdit(kind);
    if(editHtml) return editHtml;
    if(kind === 'library'){
        const lib = activePromptLibrary();
        const isSystem = isSystemPromptLibrary(lib);
        const deleteKey = `prompt-lib:${lib?.id || ''}`;
        return `<div class="tree-action-bar library-actions">
            <button type="button" data-prompt-cat-new><i data-lucide="folder-plus"></i><span>新分组</span></button>
            <button type="button" data-prompt-lib-rename><i data-lucide="pencil"></i><span>重命名</span></button>
            ${isSystem ? '' : `<button type="button" class="danger ${pendingTreeDelete === deleteKey ? 'detail-confirm' : ''}" data-prompt-lib-delete><i data-lucide="trash-2"></i><span>${pendingTreeDelete === deleteKey ? '确认删除' : '删除库'}</span></button>`}
        </div>`;
    }
    if(activePromptCategory === 'all'){
        return `<div class="tree-action-bar child-actions muted-actions"><span><i data-lucide="lock"></i>请选择具体分组后编辑</span></div>`;
    }
    const deleteKey = `prompt-cat:${activePromptCategory}`;
    return `<div class="tree-action-bar child-actions">
        <button type="button" data-prompt-cat-rename><i data-lucide="pencil"></i><span>重命名</span></button>
        <button type="button" class="danger ${pendingTreeDelete === deleteKey ? 'detail-confirm' : ''}" data-prompt-cat-delete><i data-lucide="trash-2"></i><span>${pendingTreeDelete === deleteKey ? '确认删除' : '删除'}</span></button>
    </div>`;
}
function renderPromptTreeInlineEdit(kind){
    if(!promptTreeEdit) return '';
    if(promptTreeEdit.placement === 'head') return '';
    const expectedKinds = kind === 'library' ? ['library-new', 'library-rename', 'category-new'] : ['category-new', 'category-rename'];
    if(!expectedKinds.includes(promptTreeEdit.kind)) return '';
    const label = promptTreeEdit.label || '名称';
    return `<div class="tree-inline-edit ${kind === 'category' ? 'child-actions' : 'library-actions'}">
        <input id="promptTreeEditInput" type="text" value="${escapeAttr(promptTreeEdit.value || '')}" placeholder="${escapeAttr(label)}">
        <button type="button" class="primary" data-prompt-tree-edit-save><i data-lucide="check"></i><span>保存</span></button>
        <button type="button" data-prompt-tree-edit-cancel><i data-lucide="x"></i><span>取消</span></button>
    </div>`;
}
function renderPromptRow(item, readonly){
    return `<article class="prompt-row ${item.id === selectedPromptId ? 'active' : ''}" data-prompt-row="${escapeAttr(item.id)}">
        <input class="prompt-row-check" type="checkbox" data-prompt-check="${escapeAttr(item.id)}" ${selectedPromptIds.has(item.id) ? 'checked' : ''} ${readonly ? 'disabled' : ''}>
        <div class="prompt-row-main">
            <div class="prompt-row-title"><strong>${escapeHtml(item.name || '提示词')}</strong><span class="prompt-tag">${escapeHtml(promptCategoryLabel(item.category || 'custom'))}</span><button class="prompt-row-fav ${item.favorite ? 'is-fav' : ''}" type="button" data-prompt-favorite="${escapeAttr(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button></div>
            <div class="prompt-row-scene">${escapeHtml(item.scene || '未填写用途说明')}</div>
            <div class="prompt-row-text">${escapeHtml(item.positive || '')}</div>
        </div>
    </article>`;
}
function renderPromptDetail(item, readonly){
    if(promptCreateMode && !readonly){
        return `
            <div class="panel-head">
                 <div class="panel-title"><strong>新增提示词</strong><span>${promptDetailContext === 'hub' ? '保存到「我的提示词」' : '保存到当前提示词模板库'}</span></div>
                <div class="panel-actions">
                    <button class="asset-btn primary" type="button" data-prompt-create-save><i data-lucide="check"></i><span>保存</span></button>
                    <button class="asset-icon-btn" type="button" data-prompt-edit-cancel title="取消"><i data-lucide="x"></i></button>
                </div>
            </div>
            <div class="detail-scroll">
                <div class="inline-edit-form">
                    <label class="inline-edit-field"><span>名称</span><input id="promptEditName" type="text" value="" placeholder="提示词名称"></label>
                    <label class="inline-edit-field"><span>用途说明 / 提示词正文</span><textarea id="promptEditScene" placeholder="用途说明；也可直接填写提示词正文"></textarea></label>
                    <label class="inline-edit-field"><span>正向提示词</span><textarea id="promptEditPositive" placeholder="正向提示词"></textarea></label>
                    <label class="inline-edit-field"><span>负向提示词</span><textarea id="promptEditNegative" placeholder="负向提示词"></textarea></label>
                </div>
            </div>
        `;
    }
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>提示词预览</strong><span>选择一条提示词查看全文</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="text-cursor-input"></i><span>暂无可预览提示词</span></div></div>`;
    if(promptEditMode && item.id === selectedPromptId && !readonly){
        return `
            <div class="panel-head">
                <div class="panel-title"><strong>编辑提示词</strong><span>在当前库内保存</span></div>
                <div class="panel-actions">
                    <button class="asset-btn primary" type="button" data-prompt-edit-save="${escapeAttr(item.id)}"><i data-lucide="check"></i><span>保存</span></button>
                    <button class="asset-icon-btn" type="button" data-prompt-edit-cancel title="取消"><i data-lucide="x"></i></button>
                </div>
            </div>
            <div class="detail-scroll">
                <div class="inline-edit-form">
                    <label class="inline-edit-field"><span>名称</span><input id="promptEditName" type="text" value="${escapeAttr(item.name || '')}" placeholder="提示词名称"></label>
                    <label class="inline-edit-field"><span>用途说明</span><textarea id="promptEditScene" placeholder="用途说明">${escapeHtml(item.scene || '')}</textarea></label>
                    <label class="inline-edit-field"><span>正向提示词</span><textarea id="promptEditPositive" placeholder="正向提示词">${escapeHtml(item.positive || '')}</textarea></label>
                    <label class="inline-edit-field"><span>负向提示词</span><textarea id="promptEditNegative" placeholder="负向提示词">${escapeHtml(item.negative || '')}</textarea></label>
                </div>
            </div>
        `;
    }
    const params = item.params && typeof item.params === 'object' ? Object.entries(item.params) : [];
    return `
        <div class="panel-head">
            <div class="panel-title"><strong>提示词预览</strong><span>${escapeHtml(promptCategoryLabel(item.category || 'custom'))}</span></div>
            <div class="panel-actions">
                <button class="asset-icon-btn prompt-detail-fav ${item.favorite ? 'is-fav' : ''}" type="button" data-prompt-favorite="${escapeAttr(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
                <button class="asset-icon-btn" type="button" data-prompt-edit-start="${escapeAttr(item.id)}" ${readonly ? 'disabled' : ''} title="编辑"><i data-lucide="pencil"></i></button>
                <button class="asset-icon-btn danger ${pendingDeletePromptId === item.id ? 'detail-confirm' : ''}" type="button" data-prompt-delete="${escapeAttr(item.id)}" ${readonly ? 'disabled' : ''} title="${pendingDeletePromptId === item.id ? '再次点击确认删除' : '删除'}"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
        <div class="detail-scroll">
            <div class="prompt-detail-head">
                <div class="prompt-detail-title">${escapeHtml(item.name || '提示词')}</div>
                <div class="prompt-detail-scene">${escapeHtml(item.scene || '未填写用途说明')}</div>
            </div>
            <section class="prompt-block">
                <div class="prompt-block-head"><span>正向提示词</span><span>${String(item.positive || '').length} 字符</span></div>
                <textarea class="prompt-block-body" readonly spellcheck="false">${escapeHtml(item.positive || '未填写')}</textarea>
            </section>
            <section class="prompt-block">
                <div class="prompt-block-head"><span>负向提示词</span><span>${String(item.negative || '').length} 字符</span></div>
                <textarea class="prompt-block-body negative" readonly spellcheck="false">${escapeHtml(item.negative || '未填写')}</textarea>
            </section>
            ${params.length ? `<div class="params-list">${params.map(([key, value]) => `<div class="param-row"><strong>${escapeHtml(key)}</strong><span>${escapeHtml(value)}</span></div>`).join('')}</div>` : ''}
        </div>
    `;
}
async function ensureBackgroundRemovalEngine(){
    if(!window.XiaomeiBackgroundRemovalBridge?.ensureEngine) throw new Error('本地抠图模块未加载，请刷新页面后重试');
    return window.XiaomeiBackgroundRemovalBridge.ensureEngine({
        onDownloadProgress:(percent, total, model) => setStatus(`正在准备${model?.name || '本地抠图模型'} · ${percent}%（${Math.round(Number(total || 0) / (1024 * 1024))} MB）`)
    });
}
async function runAssetBackgroundRemoval(ids=[]){
    const sourceIds = [...new Set((ids || []).filter(Boolean))];
    const imageIds = sourceIds.filter(id => {
        const item = findAssetItem(id);
        return item && assetKind(item) === 'image';
    });
    if(!imageIds.length){
        setStatus('请先选择图片素材');
        return;
    }
    if(backgroundRemovalBusy) return;
    backgroundRemovalBusy = true;
    assetContextMenuId = '';
    render();
    try {
        const engine = await ensureBackgroundRemovalEngine();
        if(!engine) return;
        const engineLabel = `${engine.modelName || '本地抠图'} · ${engine.device || 'CPU'}${engine.deviceIsGpu ? (engine.providerVerified ? ' · GPU' : ' · GPU优先') : ''}`;
        setStatus(`正在启动 ${engineLabel} · ${imageIds.length} 张，原图不会被覆盖`);
        const data = await apiJson('/api/asset-library/items/background-removal', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:activeAssetLibraryId, ids:imageIds, auto_center:true, backend:engine.backend, model_id:engine.modelId})
        });
        assetLibrary = data.library || assetLibrary;
        selectedAssetIds.clear();
        selectedAssetId = data.items?.[0]?.id || selectedAssetId;
        const failed = data.failed?.length || 0;
        setStatus(data.count ? `已生成 ${data.count} 个透明底素材${failed ? `，${failed} 个失败` : ''} · 主体已自动居中` : (data.failed?.[0]?.error || '没有生成透明底素材'));
    } finally {
        backgroundRemovalBusy = false;
        render();
    }
}
async function uploadFiles(files){
    const uploadView = uploadAssetsState.view;
    const uploadProjectId = uploadAssetsState.projectId || '';
    const uploadCanvasId = uploadAssetsState.canvasId || '';
    const cat = activeAssetCategory();
    if(assetUploadBusy) return;
    const list = [...files].filter(Boolean);
    if(!list.length) throw new Error('没有选择文件');
    const form = new FormData();
    list.forEach(file => form.append('files', file));
    if(uploadView === 'disk'){
        if(uploadProjectId && uploadProjectId !== '__unassigned__') form.append('project_id', uploadProjectId);
        if(uploadCanvasId) form.append('canvas_id', uploadCanvasId);
    }
    assetUploadBusy = true;
    setStatus(`准备上传 ${list.length} 个素材...`);
    render();
    try {
        const uploaded = await uploadFormWithProgress('/api/ai/upload', form, percent => {
            setStatus(`正在上传 ${list.length} 个素材 · ${percent}%`);
        });
        const items = (uploaded.files || []).filter(file => file?.url).map(file => ({
            library_id:activeAssetLibraryId,
            category_id:activeAssetCategoryId,
            url:file.url,
            name:file.name || 'asset'
        }));
        if(!items.length) throw new Error('没有可保存的素材');
        let data = {items:[]};
        if(uploadView === 'library' && cat && activeAssetCategoryId){
            setStatus('上传完成，正在写入当前资产分组...');
            data = await apiJson('/api/asset-library/items/batch', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({library_id:activeAssetLibraryId, category_id:activeAssetCategoryId, items})
            });
            assetLibrary = data.library || assetLibrary;
        }
        if(uploadView === 'disk'){
            uploadAssetsState.loaded = false;
            await loadUploadAssets();
        }
        setStatus(uploadView === 'disk' ? `已上传 ${items.length} 个素材，已归入当前上传目录` : `已上传 ${items.length} 个素材，已显示在当前分组`);
        return {count:items.length, items:data.items || items};
    } finally {
        assetUploadBusy = false;
        render();
    }
}
function assetCategoryForDrag(libraryId, categoryId){
    const library = (assetLibrary?.libraries || []).find(item => item?.id === libraryId);
    return (library?.categories || []).find(item => item?.id === categoryId && (item.type || 'image') === 'image') || null;
}
function assetCategoryDragPayload(event){
    const types = Array.from(event?.dataTransfer?.types || []);
    if(types.includes(ASSET_CATEGORY_DRAG_TYPE)){
        try {
            const raw = event.dataTransfer.getData(ASSET_CATEGORY_DRAG_TYPE);
            const payload = JSON.parse(raw || '{}');
            if(payload?.libraryId && payload?.categoryId) return payload;
        } catch(_) {}
    }
    // Chromium on Windows may omit custom MIME types while dragging over a button.
    // Keep the in-page payload as a fallback so the local-material drop target still works.
    return assetCategoryDragState?.libraryId && assetCategoryDragState?.categoryId ? assetCategoryDragState : null;
}
function isAssetCategoryDrag(event){
    return Array.from(event?.dataTransfer?.types || []).includes(ASSET_CATEGORY_DRAG_TYPE) || Boolean(assetCategoryDragState);
}
function assetUrlForLocalImport(url){
    const raw = String(url || '').trim();
    if(!raw) return '';
    try {
        const resolved = new URL(raw, window.location.origin);
        // Keep same-origin media as a local path so the server can copy it
        // directly instead of downloading it through its own HTTP endpoint.
        if(resolved.origin === window.location.origin || ['localhost','127.0.0.1','::1'].includes(resolved.hostname)){
            return `${resolved.pathname}${resolved.search}`;
        }
        return resolved.href;
    } catch(_) { return raw; }
}
function clearAssetCategoryDropTargets(){
    document.querySelectorAll('.asset-category-drop-target').forEach(node => node.classList.remove('asset-category-drop-target'));
}
function assetCategoryDropTarget(event){
    const target = event?.target;
    if(!target || typeof target.closest !== 'function') return null;
    const tab = target.closest('[data-tab="local"]');
    if(tab) return tab;
    if(activeTab === 'local' && root.contains(target)){
        const folder = target.closest('[data-localup-folder]');
        if(folder) return folder;
        return target.closest('.asset-content');
    }
    return null;
}
function openLocalTabForAssetDrop(tab){
    if(!tab || activeTab === 'local') return;
    activeTab = 'local';
    imageSpaceState.collectionId = '';
    selectedLocalUploadId = '';
    selectedLocalUploadIds.clear();
    activeLocalUploadClassFilter = '';
    render();
}
function localUploadChildFolder(parentPath='', name=''){
    const parent = localUploadFolderByPath(parentPath) || (parentPath ? null : localUploadTree);
    const wanted = String(name || '').trim().toLocaleLowerCase();
    return (parent?.children || []).find(child => String(child.name || '').trim().toLocaleLowerCase() === wanted) || null;
}
function mergeLocalUploadItemsIntoTree(items){
    if(!Array.isArray(items) || !items.length) return;
    if(!localUploadTree) localUploadTree = {id:'__root__', path:'', name:'全部上传', items:[], children:[], count:0};
    const rootNode = localUploadTree;
    const nodeForPath = folderPath => {
        const parts = String(folderPath || '').replace(/\\/g, '/').split('/').map(part => part.trim()).filter(Boolean);
        let node = rootNode;
        let currentPath = '';
        for(const part of parts){
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            let child = (node.children || []).find(entry => String(entry.path || '') === currentPath);
            if(!child){
                child = {id:currentPath, path:currentPath, name:part, items:[], children:[], count:0};
                node.children = node.children || [];
                node.children.push(child);
            }
            node = child;
        }
        return node;
    };
    for(const item of items){
        if(!item || !(item.id || item.file)) continue;
        const node = nodeForPath(item.folder || '');
        node.items = node.items || [];
        const key = item.id || item.file;
        const index = node.items.findIndex(existing => (existing?.id || existing?.file) === key);
        if(index >= 0) node.items[index] = item;
        else node.items.push(item);
    }
    const updateCounts = node => {
        let count = (node.items || []).length;
        for(const child of node.children || []) count += updateCounts(child);
        node.count = count;
        return count;
    };
    updateCounts(rootNode);
}
async function ensureLocalUploadImportFolder(name){
    const parent = activeLocalUploadFolder || '';
    const existing = localUploadChildFolder(parent, name);
    if(existing?.path !== undefined) return existing.path || '';
    try {
        const data = await apiJson('/api/local-assets/folders', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({parent, name})
        });
        return String(data.folder?.path || '').trim();
    } catch(err) {
        // A second tab may have created the same folder between the tree read and
        // this request. Re-read once and use it when the folder now exists.
        await loadLocalAssets();
        const concurrent = localUploadChildFolder(parent, name);
        if(concurrent?.path !== undefined) return concurrent.path || '';
        throw err;
    }
}
async function importAssetCategoryToLocal(payload){
    if(assetCategoryLocalImportBusy) return;
    const category = assetCategoryForDrag(payload?.libraryId || '', payload?.categoryId || '');
    const importEntries = (category?.items || []).filter(item => item?.url).map(source => ({
        source,
        item:{url:assetUrlForLocalImport(source.url), name:source.name || '本地素材'}
    })).filter(entry => entry.item.url);
    const sourceItems = importEntries.map(entry => entry.source);
    const items = importEntries.map(entry => entry.item);
    if(!category || !items.length){
        setStatus('这个分组里没有可移动的素材');
        return;
    }
    assetCategoryLocalImportBusy = true;
    // 先打开目标界面，让拖拽到“本地素材”后立即有可见反馈；网络导入在界面内继续执行。
    activeTab = 'local';
    imageSpaceState.collectionId = '';
    selectedLocalUploadId = '';
    selectedLocalUploadIds.clear();
    render();
    setStatus(`正在移动「${category.name || '素材分组'}」中的 ${items.length} 个素材到本地素材...`);
    try {
        // The import endpoint creates the category folder atomically.  Avoid
        // loading the complete local tree or making a second folder request
        // before any bytes are copied.
        const parentFolder = activeLocalUploadFolder || '';
        const existingFolder = localUploadChildFolder(parentFolder, category.name || '素材分组');
        let targetFolder = existingFolder?.path !== undefined
            ? existingFolder.path || ''
            : [parentFolder, category.name || '素材分组'].filter(Boolean).join('/');
        const data = await apiJson('/api/local-assets/import-urls', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                items,
                folder:targetFolder,
                folder_parent:parentFolder,
                folder_name:category.name || '素材分组'
            })
        });
        targetFolder = String(data.folder || targetFolder).trim();
        const results = Array.isArray(data.items) ? data.items : [];
        const imported = Number(data.count || data.files?.length || results.filter(item => item?.ok).length || 0);
        if(!imported){
            const reason = results.find(item => item?.error)?.error;
            throw new Error(reason || '没有素材被移动到本地素材');
        }
        activeLocalUploadFolder = targetFolder;
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        // 先用接口已返回的文件更新当前列表，让用户马上看到导入结果；
        // 完整树和数量在后台再刷新，避免整库扫描阻塞界面。
        const importedItems = (Array.isArray(data.files) ? data.files : results.map(result => result?.item).filter(Boolean))
            .filter(item => item?.id || item?.file);
        if(importedItems.length){
            const merged = new Map((localAssets || []).map(item => [item.id, item]));
            importedItems.forEach(item => merged.set(item.id || item.file, item));
            localAssets = [...merged.values()];
            localAssetsLoaded = true;
            mergeLocalUploadItemsIntoTree(importedItems);
        }
        render();
        // The copy is complete at this point.  Source cleanup can involve
        // scanning large history/canvas files, so it must not hold the import
        // operation open or make the newly copied cards look stuck.
        const failed = Math.max(0, items.length - imported);
        const immediateStatus = `已导入 ${imported} 个素材到「${category.name || '素材分组'}」${failed ? `，${failed} 个导入失败` : ''}，原素材正在后台整理`;
        setStatus(immediateStatus);
        const importedSourceIds = results.length
            ? results.map((result, index) => result?.ok ? sourceItems[index]?.id : '').filter(Boolean)
            : sourceItems.slice(0, imported).map(item => item?.id).filter(Boolean);
        // Refresh the local tree independently of the source-library cleanup.
        loadLocalAssets().then(() => {
            if(activeTab === 'local' && activeLocalUploadFolder === targetFolder){
                render();
            }
        }).catch(() => {});
        const cleanupSourceAssets = async()=>{
            let removed = 0;
            let preservedReferenced = 0;
            let removeError = '';
            if(importedSourceIds.length){
                try {
                    const removedData = await apiJson('/api/asset-library/items/delete', {
                        method:'POST',
                        headers:{'Content-Type':'application/json'},
                        body:JSON.stringify({
                            library_id:payload.libraryId || '',
                            ids:importedSourceIds,
                            preserve_referenced:true,
                            remove_empty_category_id:payload.categoryId || ''
                        })
                    });
                    assetLibrary = removedData.library || assetLibrary;
                    removed = Number(removedData.removed || 0);
                    preservedReferenced = Number(removedData.preserved_referenced || 0);
                    if(activeTab === 'assets') render();
                } catch(err){
                    removeError = err.message || '原上传素材移除失败';
                }
            }
            const movedLabel = removed ? `，已移除上传素材 ${removed} 个` : '';
            const preservedLabel = preservedReferenced ? `，保留 ${preservedReferenced} 个仍被画布或历史记录引用的原文件` : '';
            const removeErrorLabel = removeError ? `，${removeError}` : '';
            const doneStatus = `已移动 ${imported} 个素材到本地素材${failed ? `，${failed} 个导入失败` : ''}${movedLabel}${preservedLabel}${removeErrorLabel}`;
            if(activeTab === 'local' && activeLocalUploadFolder === targetFolder && statusEl?.textContent === immediateStatus){
                setStatus(doneStatus);
            }
        };
        cleanupSourceAssets().catch(err => {
            if(activeTab === 'local' && activeLocalUploadFolder === targetFolder && statusEl?.textContent === immediateStatus){
                setStatus(`已导入 ${imported} 个素材，原素材后台整理失败：${err.message || '请稍后重试'}`);
            }
        });
    } catch(err) {
        setStatus(err.message || '移动到本地素材失败');
    } finally {
        assetCategoryLocalImportBusy = false;
        clearAssetCategoryDropTargets();
    }
}
async function uploadWorkflowFiles(files){
    const cat = activeWorkflowCategory();
    if(!cat) throw new Error('请先创建工作流分组');
    const list = [...files].filter(file => /\.(json|zip)$/i.test(file.name || '') || ['application/json','application/zip','application/x-zip-compressed'].includes(String(file.type || '').toLowerCase()));
    if(!list.length) throw new Error('没有可上传的工作流文件');
    const form = new FormData();
    form.append('library_id', activeWorkflowLibraryId || '');
    form.append('category_id', activeWorkflowCategoryId || '');
    list.forEach(file => form.append('files', file));
    const data = await apiJson('/api/asset-library/workflows/upload', {method:'POST', body:form});
    assetLibrary = data.library || assetLibrary;
    selectedWorkflowIds.clear();
    selectedWorkflowId = data.items?.[0]?.id || selectedWorkflowId;
    render();
    setStatus(`已上传 ${data.items?.length || 0} 个工作流`);
}
function workflowDesktopApi(){
    try { return window.electronAPI || window.parent?.electronAPI || window.top?.electronAPI || null; } catch(_) { return null; }
}
async function exportWorkflowItems(ids, options = {}){
    const items = (ids || []).map(id => findWorkflowItem(id)).filter(item => item?.url);
    if(!items.length) return;
    const item = items[0];
    const ext = String(item.url || '').split(/[?#]/)[0].toLowerCase().endsWith('.json') ? '.json' : '.zip';
    const filename = items.length === 1 ? `${String(item.name || 'workflow').replace(/\.(json|zip)$/i, '')}${ext}` : 'workflows.zip';
    const desktopApi = options.desktop ? workflowDesktopApi() : null;
    if(options.desktop && !desktopApi?.saveWorkflowToDesktop){
        setStatus('请重启小美画布桌面端后导出到桌面；浏览器中可通过批量管理的“导出所选”下载');
        return;
    }
    if(items.length === 1 && !options.desktop){
        await downloadUrl(item.url, filename);
        setStatus('已开始下载工作流');
        return;
    }
    setStatus(items.length === 1 ? '正在读取工作流文件…' : `正在打包 ${items.length} 个工作流…`);
    const res = items.length === 1 ? await fetch(item.url) : await fetch('/api/canvas-assets/download', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({filename:'workflows.zip', items:items.map(item => ({url:item.url, name:item.name || 'workflow'}))})
    });
    if(!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '导出工作流失败');
    const blob = await res.blob();
    if(options.desktop){
        setStatus('请选择工作流保存位置');
        const result = await desktopApi.saveWorkflowToDesktop({filename, bytes:await blob.arrayBuffer()});
        if(result?.canceled){ setStatus('已取消导出'); return; }
        if(!result?.ok) throw new Error(result?.message || '保存工作流失败，请重新导出');
        setStatus(`已保存到 ${result.path}`);
        return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'workflows.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1200);
    setStatus(`已开始下载 ${items.length} 个工作流`);
}
const SMART_CANVAS_WORKFLOW_INBOX_KEY = 'smart_canvas_workflow_inbox_v1';
function sendWorkflowToCanvas(id){
    const item = findWorkflowItem(id);
    if(!item?.url) return;
    const payload = {url:item.url, name:item.name || '工作流', ts:Date.now()};
    try { localStorage.setItem(SMART_CANVAS_WORKFLOW_INBOX_KEY, JSON.stringify(payload)); } catch(_) {}
    window.parent?.postMessage({type:'smart-workflow-to-canvas', payload}, '*');
    setStatus('已发送到小美画布');
}
async function downloadCanvasAssetItems(ids){
    const items = (ids || []).map(id => findCanvasAssetItem(id)).filter(item => item?.url);
    if(!items.length){
        setStatus('没有可下载的画布资产');
        return;
    }
    if(items.length === 1){
        const item = items[0];
        downloadUrl(item.url, item.name || 'canvas-asset');
        setStatus('已下载画布资产');
        return;
    }
    setStatus(items.length === 1 ? '正在下载画布资产...' : `正在打包 ${items.length} 个画布资产...`);
    const res = await fetch('/api/canvas-assets/download', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({filename:'canvas-assets.zip', items:items.map(item => ({url:item.url, name:item.name || 'canvas-asset'}))})
    });
    if(!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '下载画布资产失败');
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = items.length === 1 ? (items[0].name || 'canvas-asset') : 'canvas-assets.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1200);
    setStatus(`已下载 ${items.length} 个画布资产`);
}
function assetDownloadName(item){
    let name = String(item?.name || 'asset');
    const urlPath = String(item?.url || '').split('?')[0];
    const dot = urlPath.lastIndexOf('.');
    const ext = dot > urlPath.lastIndexOf('/') ? urlPath.slice(dot) : '';
    if(ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
    return name;
}
function downloadAssetItem(id){
    const item = findAssetItem(id);
    if(!item || !item.url){ setStatus('没有可下载的素材'); return; }
    const name = assetDownloadName(item);
    // 统一走下载客户端，保留正确文件名/后缀并兼容本地、远程与 data/blob URL。
    downloadUrl(item.url, name);
    setStatus('已开始下载');
}
const SMART_CANVAS_ASSET_INBOX_KEY = 'smart_canvas_asset_inbox';
function canvasInboxAssetFromItem(item){
    const out = {url:item?.url || '', name:item?.name || '素材', kind:item?.kind || ''};
    ['natural_w','natural_h','width','height','w','h','layout_w','layout_h'].forEach(key => {
        const n = Number(item?.[key]);
        if(Number.isFinite(n) && n > 0) out[key] = n;
    });
    return out;
}
function copySelectedAssetsToCanvas(){
    const items = [...selectedAssetIds]
        .map(id => findAssetItem(id))
        .filter(it => it?.url)
        .map(canvasInboxAssetFromItem);
    if(!items.length){ setStatus('没有可复制的素材'); return; }
    try {
        // 写入跨页剪贴板，画布页按 Ctrl+V 读取并批量粘贴
        localStorage.setItem(SMART_CANVAS_ASSET_INBOX_KEY, JSON.stringify({items, ts: Date.now()}));
    } catch(err){
        setStatus('复制失败：' + (err?.message || err));
        return;
    }
    setStatus(`已复制 ${items.length} 个素材，去智能画布按 Ctrl+V 粘贴`);
}
async function downloadSelectedAssets(){
    const items = [...selectedAssetIds].map(id => findAssetItem(id)).filter(it => it?.url);
    if(!items.length){ setStatus('没有可下载的素材'); return; }
    if(items.length === 1){ downloadAssetItem(items[0].id); return; }
    setStatus(`正在打包 ${items.length} 个素材...`);
    try {
        const res = await fetch('/api/canvas-assets/download', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({filename:'assets.zip', items:items.map(it => ({url:it.url, name:assetDownloadName(it)}))})
        });
        if(!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '下载失败');
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'assets.zip';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1200);
        setStatus(`已下载 ${items.length} 个素材`);
    } catch(err){
        setStatus(err.message || '下载失败');
    }
}
function downloadLocalUpload(id){
    const item = findLocalUpload(id);
    if(!item || !item.url){ setStatus('没有可下载的素材'); return; }
    const name = assetDownloadName(item);
    downloadUrl(item.url, name);
    setStatus('已开始下载');
}
async function downloadSelectedLocalUploads(){
    const items = [...selectedLocalUploadIds].map(id => findLocalUpload(id)).filter(it => it?.url);
    if(!items.length){ setStatus('没有可下载的素材'); return; }
    if(items.length === 1){ downloadLocalUpload(items[0].id); return; }
    setStatus(`正在打包 ${items.length} 个素材...`);
    try {
        const res = await fetch('/api/canvas-assets/download', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({filename:'local-assets.zip', items:items.map(it => ({url:it.url, name:assetDownloadName(it)}))})
        });
        if(!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '下载失败');
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'local-assets.zip';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1200);
        setStatus(`已下载 ${items.length} 个素材`);
    } catch(err){
        setStatus(err.message || '下载失败');
    }
}
function copySelectedLocalUploadsToCanvas(){
    const items = [...selectedLocalUploadIds].map(id => findLocalUpload(id)).filter(it => it?.url).map(canvasInboxAssetFromItem);
    if(!items.length){ setStatus('没有可复制的素材'); return; }
    try {
        localStorage.setItem(SMART_CANVAS_ASSET_INBOX_KEY, JSON.stringify({items, ts: Date.now()}));
    } catch(err){
        setStatus('复制失败：' + (err?.message || err));
        return;
    }
    setStatus(`已复制 ${items.length} 个素材，去智能画布按 Ctrl+V 粘贴`);
}
function renderLocalUploadClipboardBar(){
    if(!localUploadClipboard?.ids?.length) return '';
    const sameFolder = String(localUploadClipboard.sourceFolder || '') === String(activeLocalUploadFolder || '');
    const hereLabel = activeLocalUploadFolder ? localUploadFolderTitle() : '根目录';
    return `<div class="asset-clipboard-bar">
        <div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span>已剪切 ${localUploadClipboard.ids.length} 个素材</span></div>
        <div class="asset-tools">
            <button class="asset-btn primary" type="button" data-localup-paste-clipboard ${sameFolder ? 'disabled' : ''}><i data-lucide="clipboard-paste"></i><span>${sameFolder ? '切到其他文件夹后移动' : `移动到「${escapeHtml(hereLabel)}」`}</span></button>
            <button class="asset-icon-btn" type="button" data-localup-clear-clipboard title="取消剪切"><i data-lucide="x"></i></button>
        </div>
    </div>`;
}
function setLocalUploadClipboard(){
    const ids = [...selectedLocalUploadIds];
    if(!ids.length){ setStatus('没有选中的素材'); return; }
    localUploadClipboard = {ids, sourceFolder: activeLocalUploadFolder || ''};
    selectedLocalUploadIds.clear();
    render();
    setStatus(`已剪切 ${ids.length} 个素材，切换到目标文件夹后点"移动到此文件夹"`);
}
async function pasteLocalUploadClipboard(){
    if(!localUploadClipboard?.ids?.length) return;
    const names = localUploadClipboard.ids.map(id => findLocalUpload(id)?.file).filter(Boolean);
    if(!names.length){ localUploadClipboard = null; render(); return; }
    setStatus('正在移动...');
    try {
        const data = await apiJson('/api/local-assets/move', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({names, folder: activeLocalUploadFolder || ''})
        });
        await loadLocalAssets();
        localUploadClipboard = null;
        selectedLocalUploadIds.clear();
        render();
        setStatus(`已移动 ${data?.moved ?? names.length} 个素材`);
    } catch(err){
        setStatus(err.message || '移动失败');
    }
}
async function renameWorkflowItem(id){
    const item = findWorkflowItem(id);
    const name = window.prompt('工作流名称', item?.name || '');
    if(!item || !String(name || '').trim()) return;
    const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    render();
    setStatus('已重命名工作流');
}
async function deleteWorkflowItem(id){
    const item = findWorkflowItem(id);
    if(!item) return;
    if(pendingDeleteAssetId !== id){
        pendingDeleteAssetId = id;
        render();
        setStatus('再次点击确认将工作流移入回收站');
        return;
    }
    const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, {method:'DELETE'});
    assetLibrary = data.library || assetLibrary;
    selectedWorkflowIds.delete(id);
    selectedWorkflowId = '';
    pendingDeleteAssetId = '';
    render();
    setStatus('工作流已移入回收站');
}
async function deleteSelectedWorkflows(){
    const ids = [...selectedWorkflowIds];
    if(!ids.length) return;
    const data = await apiJson('/api/asset-library/items/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:activeWorkflowLibraryId, ids})});
    assetLibrary = data.library || assetLibrary;
    selectedWorkflowIds.clear();
    selectedWorkflowId = '';
    render();
    setStatus(`已将 ${data.removed || 0} 个工作流移入回收站`);
}
async function moveWorkflowToCategory(itemId, targetLibraryId, targetCategoryId){
    const item = findWorkflowItem(itemId);
    if(!item || !targetCategoryId) return;
    if(targetLibraryId === activeWorkflowLibraryId && targetCategoryId === activeWorkflowCategoryId){
        setStatus('工作流已经在这个文件夹中');
        return;
    }
    setStatus('正在移动工作流...');
    try {
        const data = await apiJson('/api/asset-library/items/move', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                ids:[itemId],
                library_id:activeWorkflowLibraryId,
                target_library_id:targetLibraryId || activeWorkflowLibraryId,
                target_category_id:targetCategoryId
            })
        });
        assetLibrary = data.library || assetLibrary;
        activeWorkflowLibraryId = targetLibraryId || activeWorkflowLibraryId;
        activeWorkflowCategoryId = targetCategoryId;
        selectedWorkflowId = itemId;
        selectedWorkflowIds.clear();
        render();
        setStatus(`已将「${item.name || '工作流'}」移动到目标文件夹`);
    } catch(err){
        setStatus(err.message || '移动工作流失败');
    }
}
async function uploadLocalAssets(files){
    const list = [...files].filter(f => isLocalMediaFile(f));
    if(!list.length){ setStatus('没有可上传的图片/视频/音频文件'); return; }
    const form = new FormData();
    form.append('folder', activeLocalUploadFolder || '');
    list.forEach(file => form.append('files', file));
    setStatus('正在上传...');
    try {
        const data = await apiJson('/api/local-assets/upload', {method:'POST', body:form});
        const uploaded = Array.isArray(data.files) ? data.files : [];
        await loadLocalAssets();
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = uploaded[0]?.id || selectedLocalUploadId;
        render();
        setStatus(`已上传 ${uploaded.length} 个素材`);
    } catch(err) {
        setStatus(err.message || '上传失败');
    }
}
async function deleteLocalAssets(ids){
    const names = (ids || []).map(id => findLocalUpload(id)?.file).filter(Boolean);
    if(!names.length) return;
    setStatus('正在移入回收站...');
    try {
        await apiJson('/api/local-assets/delete', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({names})
        });
        await loadLocalAssets();
        if(activeLocalUploadClassFilter && !activeLocalUploadClassEntry()) activeLocalUploadClassFilter = '';
        selectedLocalUploadIds.clear();
        if(selectedLocalUploadId && !findLocalUpload(selectedLocalUploadId)) selectedLocalUploadId = '';
        render();
        setStatus(`已将 ${names.length} 个素材移入回收站`);
    } catch(err) {
        setStatus(err.message || '删除失败');
    }
}
async function saveLocalUploadInlineName(id, name){
    const item = findLocalUpload(id);
    if(!item) return;
    if(!String(name || '').trim()) return;
    if(String(item.name || '') === String(name || '')) return;
    try {
        const data = await apiJson('/api/local-assets/items', {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path:item.file || item.id, name})
        });
        localAssets = Array.isArray(data.items) ? data.items : localAssets;
        localUploadTree = data.tree || localUploadTree;
        selectedLocalUploadId = data.item?.id || data.item?.file || selectedLocalUploadId;
        if(selectedLocalUploadIds.has(id)){
            selectedLocalUploadIds.delete(id);
            if(data.item?.id) selectedLocalUploadIds.add(data.item.id);
        }
        render();
        setStatus('已重命名素材，反推提示词和分类索引已同步');
    } catch(err) {
        setStatus(err.message || '重命名失败');
    }
}
function beginLocalUploadInlineRename(id){
    const item = findLocalUpload(id);
    const card = [...root.querySelectorAll('[data-localup-card]')].find(el => el.dataset.localupCard === id);
    const nameEl = card?.querySelector('.asset-card-name');
    if(!item || !card || !nameEl || card.querySelector('.asset-card-name-input')) return;
    const previousName = item.name || '本地素材';
    const input = document.createElement('input');
    input.className = 'asset-card-name-input';
    input.type = 'text';
    input.value = previousName;
    input.setAttribute('aria-label', '素材名称');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const restore = () => {
        if(input.isConnected) input.replaceWith(nameEl);
    };
    const finish = async save => {
        if(done) return;
        done = true;
        const name = input.value.trim();
        if(!save || !name || name === previousName){
            restore();
            return;
        }
        input.disabled = true;
        await saveLocalUploadInlineName(id, name);
    };
    input.addEventListener('keydown', event => {
        event.stopPropagation();
        if(event.key === 'Enter'){
            event.preventDefault();
            finish(true);
        } else if(event.key === 'Escape'){
            event.preventDefault();
            finish(false);
        }
    });
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('mousedown', event => event.stopPropagation());
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
}
function beginCreateLocalUploadFolder(){
    localUploadFolderCreateMode = true;
    render();
    focusTreeEditInput('localUploadFolderCreateInput');
}
function cancelCreateLocalUploadFolder(){
    localUploadFolderCreateMode = false;
    render();
}
async function createLocalUploadFolder(){
    const input = document.getElementById('localUploadFolderCreateInput');
    const name = String(input?.value || '').trim();
    if(!name){
        input?.focus();
        return;
    }
    if(input) input.disabled = true;
    try {
        const data = await apiJson('/api/local-assets/folders', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({parent:activeLocalUploadFolder || '', name})
        });
        localAssets = Array.isArray(data.items) ? data.items : localAssets;
        localUploadTree = data.tree || localUploadTree;
        activeLocalUploadFolder = data.folder?.path || activeLocalUploadFolder;
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        localUploadFolderCreateMode = false;
        render();
        setStatus('已新建本地素材文件夹');
    } catch(err) {
        setStatus(err.message || '新建文件夹失败');
        if(input){
            input.disabled = false;
            input.focus();
            input.select();
        }
    }
}
async function renameLocalUploadFolder(){
    if(!activeLocalUploadFolder){
        setStatus('根目录不能重命名');
        return;
    }
    const current = localUploadFolderTitle();
    const name = window.prompt('重命名文件夹', current);
    if(!String(name || '').trim() || name === current) return;
    try {
        const data = await apiJson('/api/local-assets/folders', {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path:activeLocalUploadFolder, name})
        });
        localAssets = Array.isArray(data.items) ? data.items : localAssets;
        localUploadTree = data.tree || localUploadTree;
        activeLocalUploadFolder = data.folder?.path || activeLocalUploadFolder;
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        render();
        setStatus('已重命名本地素材文件夹');
    } catch(err) {
        setStatus(err.message || '重命名文件夹失败');
    }
}
async function deleteLocalUploadFolder(){
    const folderPath = String(activeLocalUploadFolder || '').trim();
    if(!folderPath){
        setStatus('根目录不能删除');
        return;
    }
    const folderName = localUploadFolderByPath(folderPath)?.name || folderPath.split('/').pop() || '文件夹';
    const parentPath = folderPath.split('/').slice(0, -1).join('/');
    localUploadFolderCreateMode = false;
    pendingTreeDelete = '';
    setStatus(`正在将「${folderName}」移入回收站...`);
    try {
        const data = await apiJson('/api/local-assets/folders', {
            method:'DELETE',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path:folderPath})
        });
        localAssets = Array.isArray(data.items) ? data.items : localAssets;
        localUploadTree = data.tree || localUploadTree;
        activeLocalUploadFolder = parentPath;
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        pendingTreeDelete = '';
        render();
        setStatus(data.already_missing
            ? `文件夹「${folderName}」已不存在，已刷新本地素材`
            : `文件夹「${folderName}」及其中的素材已移入回收站`);
    } catch(err) {
        pendingTreeDelete = '';
        render();
        setStatus(err.message || '删除文件夹失败');
    }
}
async function runLocalUploadCaptionSelected(){
    const images = selectedLocalUploadImageItems();
    if(!images.length || localCaptionBusy) return;
    normalizeLocalCaptionSettings();
    if(!localCaptionProvider || !localCaptionModel){
        setStatus('请先在 API 设置中配置可用的聊天/视觉模型');
        return;
    }
    localCaptionBusy = true;
    render();
    setStatus(`正在反推 ${images.length} 张本地图片的提示词...`);
    try {
        const data = await apiJson('/api/local-assets/caption', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                names:images.map(item => item.file || item.id),
                provider:localCaptionProvider,
                model:localCaptionModel,
                prompt:(localCaptionPrompt || '描述图片').trim() || '描述图片'
            })
        });
        await loadLocalAssets();
        selectedLocalUploadIds.clear();
        if(images[0]?.id) selectedLocalUploadId = images[0].id;
        render();
        const failed = (data.items || []).filter(item => !item.ok);
        setStatus(failed.length ? `已完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '反推失败'}` : `已反推并保存 ${data.count || images.length} 张图片提示词`);
    } catch(err) {
        setStatus(err.message || '提示词反推失败');
    } finally {
        localCaptionBusy = false;
        render();
    }
}
async function runLocalUploadCaptionOne(id){
    const item = findLocalUpload(id);
    if(!item || assetKind(item) !== 'image' || localCaptionBusy || localClassifyBusy) return;
    normalizeLocalCaptionSettings();
    if(!localCaptionProvider || !localCaptionModel){
        setStatus('请先在 API 设置中配置可用的聊天/视觉模型');
        return;
    }
    localCaptionBusy = true;
    selectedLocalUploadId = item.id;
    render();
    setStatus(`正在反推「${item.name || '本地图片'}」的提示词...`);
    try {
        const data = await apiJson('/api/local-assets/caption', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                names:[item.file || item.id],
                provider:localCaptionProvider,
                model:localCaptionModel,
                prompt:(localCaptionPrompt || '描述图片').trim() || '描述图片'
            })
        });
        const result = (data.items || [])[0] || null;
        if(result && !result.ok) throw new Error(result.error || '反推失败');
        await loadLocalAssets();
        selectedLocalUploadId = item.id;
        render();
        setStatus('已反推并保存当前图片提示词');
    } catch(err) {
        setStatus(err.message || '提示词反推失败');
    } finally {
        localCaptionBusy = false;
        render();
    }
}
async function copyLocalUploadCaption(id){
    const item = findLocalUpload(id);
    if(!item || assetKind(item) !== 'image') return;
    const textarea = document.getElementById('localUploadCaptionEdit');
    const text = textarea ? textarea.value : (item.caption || '');
    if(!String(text || '').trim()){
        setStatus('当前图片暂无可复制的提示词');
        return;
    }
    const ok = await copyTextToClipboard(text);
    setStatus(ok ? '已复制提示词' : '复制失败，请手动复制');
}
async function runLocalUploadClassifySelected(){
    const images = selectedLocalUploadImageItems();
    if(!images.length || localClassifyBusy) return;
    normalizeLocalCaptionSettings();
    if(!localCaptionProvider || !localCaptionModel){
        setStatus('请先在 API 设置中配置可用的聊天/视觉模型');
        return;
    }
    localClassifyBusy = true;
    render();
    setStatus(`正在智能分类 ${images.length} 张本地图片...`);
    try {
        const data = await apiJson('/api/local-assets/classify', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                names:images.map(item => item.file || item.id),
                provider:localCaptionProvider,
                model:localCaptionModel,
                prompt:(localClassifyPrompt || '').trim()
            })
        });
        await loadLocalAssets();
        if(images[0]?.id) selectedLocalUploadId = images[0].id;
        render();
        const failed = (data.items || []).filter(item => !item.ok);
        setStatus(failed.length ? `处理完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '分类失败'}` : `处理完成 ${data.count || images.length} 张图片`);
    } catch(err) {
        setStatus(err.message || '智能分类失败');
    } finally {
        localClassifyBusy = false;
        render();
    }
}
async function runAssetClassifySelected(){
    const images = selectedAssetImageItems();
    if(!images.length || assetClassifyBusy) return;
    normalizeLocalCaptionSettings();
    if(!localCaptionProvider || !localCaptionModel){
        setStatus('请先在 API 设置中配置可用的聊天/视觉模型');
        return;
    }
    assetClassifyBusy = true;
    render();
    setStatus(`正在智能分类 ${images.length} 张资产图片...`);
    try {
        const data = await apiJson('/api/asset-library/items/classify', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                library_id:activeAssetLibraryId,
                ids:images.map(item => item.id),
                provider:localCaptionProvider,
                model:localCaptionModel,
                prompt:(localClassifyPrompt || '').trim()
            })
        });
        assetLibrary = data.library || assetLibrary;
        if(images[0]?.id) selectedAssetId = images[0].id;
        render();
        const failed = (data.items || []).filter(item => !item.ok);
        setStatus(failed.length ? `处理完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '分类失败'}` : `处理完成 ${data.count || images.length} 张资产图片`);
    } catch(err) {
        setStatus(err.message || '智能分类失败');
    } finally {
        assetClassifyBusy = false;
        render();
    }
}
async function saveLocalUploadCaption(id){
    const item = findLocalUpload(id);
    if(!item || assetKind(item) !== 'image') return;
    const textarea = document.getElementById('localUploadCaptionEdit');
    const caption = textarea ? textarea.value : (item.caption || '');
    try {
        const data = await apiJson('/api/local-assets/caption', {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name:item.file || item.id, caption})
        });
        item.caption = data.caption || '';
        item.caption_file = data.caption_file || item.caption_file || '';
        render();
        setStatus('已保存反推提示词');
    } catch(err) {
        setStatus(err.message || '保存提示词失败');
    }
}
async function handleClick(event){
    const target = event.target;
    if(activeTab === 'generated' && target.closest?.('[data-space-collection]')) clearCanvasAssetScope();
    if(await handleImageSpaceClick(target)) return;
    // ===== 资产管理：收藏星标与提示词集合（放在最前，星标点击优先于卡片选中） =====
    const favToggle = async (selector, attr, handler) => {
        const button = target.closest?.(selector);
        if(!button) return false;
        event.preventDefault();
        event.stopPropagation();
        await handler(button.dataset[attr] || '');
        return true;
    };
    if(await favToggle('[data-asset-favorite]', 'assetFavorite', id => toggleAssetItemFavorite(id))) return;
    if(await favToggle('[data-workflow-favorite]', 'workflowFavorite', id => toggleWorkflowItemFavorite(id))) return;
    if(await favToggle('[data-generated-favorite]', 'generatedFavorite', id => { const item = findGeneratedAsset(id); return item ? toggleFileFavorite('generated', item) : Promise.resolve(); })) return;
    if(await favToggle('[data-localup-favorite]', 'localupFavorite', id => { const item = findLocalUpload(id); return item ? toggleFileFavorite('local', item) : Promise.resolve(); })) return;
    if(await favToggle('[data-prompt-favorite]', 'promptFavorite', id => togglePromptItemFavorite(id))) return;
    if(await favToggle('[data-case-favorite]', 'caseFavorite', id => toggleCaseFavorite(id))) return;
    if(target.closest?.('[data-asset-fav-filter]')){ assetFavoritesOnly = !assetFavoritesOnly; render(); return; }
    if(target.closest?.('[data-workflow-fav-filter]')){ workflowFavoritesOnly = !workflowFavoritesOnly; render(); return; }
    if(target.closest?.('[data-generated-fav-filter]')){ clearCanvasAssetScope(); generatedFavoritesOnly = !generatedFavoritesOnly; render(); return; }
    if(target.closest?.('[data-localup-fav-filter]')){ localFavoritesOnly = !localFavoritesOnly; render(); return; }
    if(target.closest?.('[data-generated-projects-toggle]')){
        generatedProjectsCollapsed = !generatedProjectsCollapsed;
        try { localStorage.setItem(GENERATED_PROJECTS_COLLAPSED_KEY, generatedProjectsCollapsed ? '1' : '0'); } catch(_) {}
        render();
        return;
    }
    const hubViewBtn = target.closest?.('[data-hub-view]');
    if(hubViewBtn){ hubView = hubViewBtn.dataset.hubView || 'cases'; if(hubView === 'cases') hubCaseCategory = ''; selectedPromptId = ''; promptEditMode = false; promptCreateMode = false; render(); return; }
    const hubPromptViewBtn = target.closest?.('[data-hub-prompt-view]');
    if(hubPromptViewBtn){ hubView = 'prompts'; hubPromptView = hubPromptViewBtn.dataset.hubPromptView || 'mine'; selectedPromptId = ''; promptEditMode = false; promptCreateMode = false; render(); return; }
    const hubCaseCatBtn = target.closest?.('[data-hub-case-cat]');
    if(hubCaseCatBtn){ hubView = 'cases'; hubCaseCategory = hubCaseCatBtn.dataset.hubCaseCat || ''; render(); return; }
    const hubCaseTagBtn = target.closest?.('[data-hub-case-tag]');
    if(hubCaseTagBtn){ hubTag = hubTag === (hubCaseTagBtn.dataset.hubCaseTag || '') ? '' : (hubCaseTagBtn.dataset.hubCaseTag || ''); render(); return; }
    if(target.closest?.('[data-hub-case-tag-clear]')){ hubTag = ''; render(); return; }
    if(target.closest?.('[data-hub-case-cats]')){ openCaseCategoryModal(); return; }
    if(target.closest?.('[data-hub-cases-refresh]')){ loadPromptCases(); return; }
    if(target.closest?.('[data-hub-clear-filters]')){ hubQuery = ''; hubCaseCategory = ''; hubTag = ''; render(); return; }
    if(target.closest?.('[data-hub-prompt-new]')){
        const {userLibs} = promptHubLibraryGroups();
        if(!activePromptLibraryId || isSystemPromptLibrary(activePromptLibrary())){
            activePromptLibraryId = userLibs[0]?.id || 'system';
        }
        activePromptCategory = 'custom'; // 资产管理新增的提示词默认进“我的”分组
        promptCreateMode = true; promptEditMode = false; pendingDeletePromptId = '';
        render();
        return;
    }
    const hubCaseOpenBtn = target.closest?.('[data-hub-case-open]');
    if(hubCaseOpenBtn){ openPromptCase(hubCaseOpenBtn.dataset.hubCaseOpen || ''); return; }
    const hubCaseCard = target.closest?.('[data-hub-case-card]');
    if(hubCaseCard){ selectedHubCaseId = hubCaseCard.dataset.hubCaseCard || ''; render(); return; }
    const caseApplyBtn = target.closest?.('[data-case-apply]');
    if(caseApplyBtn){ await applyCaseToCanvas(caseApplyBtn.dataset.caseApply || ''); return; }
    const caseCopyBtn = target.closest?.('[data-case-copy]');
    if(caseCopyBtn){ await copyCasePrompt(caseCopyBtn.dataset.caseCopy || ''); return; }
    const caseDeleteBtn = target.closest?.('[data-case-delete]');
    if(caseDeleteBtn){ await deleteCaseItem(caseDeleteBtn.dataset.caseDelete || ''); return; }
    const caseCatRenameBtn = target.closest?.('[data-case-cat-rename]');
    if(caseCatRenameBtn){ await renameCaseCategory(caseCatRenameBtn.dataset.caseCatRename || ''); return; }
    const caseCatDeleteBtn = target.closest?.('[data-case-cat-delete]');
    if(caseCatDeleteBtn){ await removeCaseCategory(caseCatDeleteBtn.dataset.caseCatDelete || ''); return; }
    if(target.closest?.('#addCaseCategoryButton')){ await addCaseCategory(); return; }
    if(target.closest?.('[data-close-case-drawer]')){ closePromptCaseDrawer(); return; }
    if(target.closest?.('[data-close-case-category-modal]')){ closeCaseCategoryModal(); return; }
    if(target.closest?.('[data-storage-close]')){ closeStorageSettings(); return; }
    const storageBrowseBtn = target.closest?.('[data-storage-browse]');
    if(storageBrowseBtn){
        event.preventDefault();
        event.stopPropagation();
        await browseStorageFolder(storageBrowseBtn.dataset.storageBrowse || '');
        return;
    }
    const prefTabBtn = target.closest?.('[data-pref-tab]');
    if(prefTabBtn){
        syncStorageSettingsInputsToState();
        storageSettingsState.tab = prefTabBtn.dataset.prefTab || 'prefs';
        storageSettingsState.editor = '';
        renderStorageSettingsModal();
        return;
    }
    const prefEditorSaveBtn = target.closest?.('[data-pref-editor-save]');
    if(prefEditorSaveBtn){
        try {
            const editor = prefEditorSaveBtn.dataset.prefEditorSave || '';
            await saveStorageSettings({saveDirs:false, saveClassification:editor === 'classify'});
            storageSettingsState.editor = '';
            renderStorageSettingsModal();
        } catch(err){
            setStatus(err.message || '保存偏好设置失败');
        }
        return;
    }
    const prefEditorBtn = target.closest?.('[data-pref-editor]');
    if(prefEditorBtn){
        syncStorageSettingsInputsToState();
        const editor = prefEditorBtn.dataset.prefEditor || '';
        storageSettingsState.editor = storageSettingsState.editor === editor ? '' : editor;
        renderStorageSettingsModal();
        return;
    }
    if(target.closest?.('[data-storage-save]')){
        try {
            await saveStorageSettings({saveDirs:true, saveClassification:false});
            if(storageSettingsState.lastMigration?.moved){
                setStatus(`资产管理已保存，已整理 ${storageSettingsState.lastMigration.moved} 个旧素材`);
            }
        }
        catch(err){ setStatus(err.message || '保存存储设置失败'); }
        return;
    }
    const storageKindBtn = target.closest?.('[data-storage-kind]');
    if(storageKindBtn){
        await loadStorageFiles(storageKindBtn.dataset.storageKind || 'generated');
        return;
    }
    const storageFileInput = target.closest?.('[data-storage-file]');
    if(storageFileInput){
        const id = storageFileInput.dataset.storageFile || '';
        if(storageFileInput.checked) storageSettingsState.selected.add(id);
        else storageSettingsState.selected.delete(id);
        renderStorageSettingsModal();
        return;
    }
    if(target.closest?.('[data-storage-select-all]')){
        storageSettingsState.items.forEach(item => storageSettingsState.selected.add(item.id));
        renderStorageSettingsModal();
        return;
    }
    if(target.closest?.('[data-storage-delete]')){
        try { await deleteSelectedStorageFiles(); }
        catch(err){ setStatus(err.message || '删除文件失败'); }
        return;
    }
    const generatedPreview = target.closest?.('[data-generated-preview]');
    if(generatedPreview){
        showDetailPreview('generated', generatedPreview.dataset.generatedPreview || '');
        return;
    }
    if(target.closest?.('.generated-card-download')) return;
    if(target.closest?.('[data-generated-manage]')){
        generatedManageMode = !generatedManageMode;
        if(!generatedManageMode) generatedAssetsState.selectedIds.clear();
        render();
        return;
    }
    const generatedCheck = target.closest?.('[data-generated-check]');
    if(generatedCheck){
        event.stopPropagation();
        const id = generatedCheck.dataset.generatedCheck || '';
        if(generatedCheck.checked) generatedAssetsState.selectedIds.add(id);
        else generatedAssetsState.selectedIds.delete(id);
        generatedAssetsState.selectedId = id;
        render();
        return;
    }
    const generatedCard = target.closest?.('[data-generated-card]');
    if(generatedCard){
        const id = generatedCard.dataset.generatedCard || '';
        generatedAssetsState.selectedId = id;
        if(generatedManageMode){
            if(generatedAssetsState.selectedIds.has(id)) generatedAssetsState.selectedIds.delete(id);
            else generatedAssetsState.selectedIds.add(id);
        }
        render();
        return;
    }
    const generatedType = target.closest?.('[data-generated-type]');
    if(generatedType){
        clearCanvasAssetScope();
        generatedFavoritesOnly = false;
        const nextType = generatedType.dataset.generatedType || 'all';
        const shouldReload = !generatedAssetsState.loaded || generatedAssetsState.mediaType !== nextType || generatedAssetsState.folder;
        generatedAssetsState.mediaType = nextType;
        generatedAssetsState.folder = '';
        generatedAssetsState.selectedId = '';
        generatedAssetsState.selectedIds.clear();
        if(shouldReload) await loadGeneratedAssets();
        else render();
        return;
    }
    const generatedFolder = target.closest?.('[data-generated-folder]');
    if(generatedFolder){
        clearCanvasAssetScope();
        generatedFavoritesOnly = false;
        imageSpaceState.all.generated = false;
        imageSpaceState.collectionId = '';
        const shouldReload = true;
        generatedAssetsState.folder = generatedFolder.dataset.generatedFolder || '';
        generatedAssetsState.mediaType = 'all';
        generatedAssetsState.selectedId = '';
        generatedAssetsState.selectedIds.clear();
        if(shouldReload) await loadGeneratedAssets();
        else render();
        return;
    }
    if(target.closest?.('[data-generated-refresh]')){
        await loadGeneratedAssets();
        setStatus('生成素材已刷新');
        return;
    }
    if(target.closest?.('[data-generated-select-all]')){
        generatedAssetItems().forEach(item => generatedAssetsState.selectedIds.add(item.id));
        render();
        return;
    }
    if(target.closest?.('[data-generated-clear-selection]')){
        generatedAssetsState.selectedIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-generated-import]')){
        try { await importSelectedGeneratedAssets(); }
        catch(err){ setStatus(err.message || '加入图片资产库失败'); }
        return;
    }
    if(target.closest?.('[data-generated-delete]')){
        try { await deleteSelectedGeneratedAssets(); }
        catch(err){ setStatus(err.message || '删除生成素材失败'); }
        return;
    }
    if(target.closest?.('[data-class-rule-reset]')){
        const ta = document.getElementById('prefClassificationRulePrompt');
        if(ta) ta.value = storageSettingsState.defaultClassificationPrompt || '';
        return;
    }
    if(guardMatchesManagedSelection(target)){
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    if(activeTab === 'assets' && assetManageMode){
        const assetCheck = target.closest?.('[data-asset-check]');
        const assetCard = target.closest?.('[data-asset-card]');
        if(assetCheck || assetCard){
            event.preventDefault();
            event.stopPropagation();
            const id = assetCheck?.dataset.assetCheck || assetCard?.dataset.assetCard || '';
            const selected = toggleSelectionSet(selectedAssetIds, id);
            selectedAssetId = selected ? id : (selectedAssetId === id ? '' : selectedAssetId);
            pendingBatchDelete = '';
            render();
            return;
        }
    }
    if(activeTab === 'local' && localUploadManageMode){
        const localUpCheck = target.closest?.('[data-localup-check]');
        const localUpCard = target.closest?.('[data-localup-card]');
        if(localUpCheck || localUpCard){
            event.preventDefault();
            event.stopPropagation();
            const id = localUpCheck?.dataset.localupCheck || localUpCard?.dataset.localupCard || '';
            const selected = toggleSelectionSet(selectedLocalUploadIds, id);
            selectedLocalUploadId = selected ? id : (selectedLocalUploadId === id ? '' : selectedLocalUploadId);
            pendingBatchDelete = '';
            render();
            return;
        }
    }
    if(activeTab === 'local' && localManageMode){
        const localCheck = target.closest?.('[data-local-check]');
        const localCard = target.closest?.('[data-local-card]');
        if(localCheck || localCard){
            event.preventDefault();
            event.stopPropagation();
            const id = localCheck?.dataset.localCheck || localCard?.dataset.localCard || '';
            const selected = toggleSelectionSet(selectedLocalIds, id);
            selectedLocalId = selected ? id : (selectedLocalId === id ? '' : selectedLocalId);
            pendingBatchDelete = '';
            render();
            return;
        }
    }
    if(activeTab === 'workflows' && workflowManageMode){
        const workflowCheck = target.closest?.('[data-workflow-check]');
        const workflowCard = target.closest?.('[data-workflow-card]');
        if(workflowCheck || workflowCard){
            event.preventDefault();
            event.stopPropagation();
            const id = workflowCheck?.dataset.workflowCheck || workflowCard?.dataset.workflowCard || '';
            const selected = toggleSelectionSet(selectedWorkflowIds, id);
            selectedWorkflowId = selected ? id : (selectedWorkflowId === id ? '' : selectedWorkflowId);
            pendingBatchDelete = '';
            render();
            return;
        }
    }
    if(activeTab === 'prompts' && promptManageMode){
        const promptCheck = target.closest?.('[data-prompt-check]');
        const promptRow = target.closest?.('[data-prompt-row]');
        if(promptCheck || promptRow){
            event.preventDefault();
            event.stopPropagation();
            const id = promptCheck?.dataset.promptCheck || promptRow?.dataset.promptRow || '';
            const selected = toggleSelectionSet(selectedPromptIds, id);
            selectedPromptId = selected ? id : (selectedPromptId === id ? '' : selectedPromptId);
            promptEditMode = false;
            promptCreateMode = false;
            pendingBatchDelete = '';
            render();
            return;
        }
    }
    if(isCanvasAssetView() && canvasAssetManageMode){
        const canvasCheck = target.closest?.('[data-canvas-asset-check]');
        const canvasCard = target.closest?.('[data-canvas-asset-card]');
        if(canvasCheck || canvasCard){
            event.preventDefault();
            event.stopPropagation();
            const id = canvasCheck?.dataset.canvasAssetCheck || canvasCard?.dataset.canvasAssetCard || '';
            const selected = toggleSelectionSet(selectedCanvasAssetIds, id);
            selectedCanvasAssetId = selected ? id : (selectedCanvasAssetId === id ? '' : selectedCanvasAssetId);
            refreshCanvasAssetSelectionOnly();
            return;
        }
    }
    const tabBtn = target.closest?.('[data-tab]');
    if(tabBtn){ imageSpaceState.collectionId = ''; clearCanvasAssetScope(); activeTab = tabBtn.dataset.tab || 'assets'; selectedAssetIds.clear(); selectedWorkflowIds.clear(); selectedPromptIds.clear(); selectedLocalIds.clear(); selectedLocalUploadIds.clear(); selectedCanvasAssetIds.clear(); generatedAssetsState.selectedIds.clear(); render(); if(activeTab === 'generated' && !generatedAssetsState.loaded) await loadGeneratedAssets(); if(activeTab === 'assets' && !uploadAssetsState.loaded) await loadUploadAssets(); return; }
    if(target.closest?.('#refreshBtn')){ await loadAll(); return; }
    if(activeTab === 'assets'){
        if(target.closest?.('[data-asset-library-view]')){ uploadAssetsState.view = 'library'; render(); return; }
        if(target.closest?.('[data-upload-disk-view]')){ uploadAssetsState.view = 'disk'; render(); if(!uploadAssetsState.loaded) loadUploadAssets().catch(err => setStatus(err.message || '读取上传素材失败')); return; }
        if(target.closest?.('[data-upload-retry]')){ loadUploadAssets().catch(err => setStatus(err.message || '读取上传素材失败')); return; }
        const uploadProject = target.closest?.('[data-upload-project]');
        if(uploadProject){ uploadAssetsState.view = 'disk'; uploadAssetsState.projectId = uploadProject.dataset.uploadProject || ''; uploadAssetsState.canvasId = ''; uploadAssetsState.selectedId = ''; loadUploadAssets().catch(err => setStatus(err.message || '读取项目素材失败')); return; }
        const uploadCanvas = target.closest?.('[data-upload-canvas]');
        if(uploadCanvas){ uploadAssetsState.view = 'disk'; uploadAssetsState.canvasId = uploadCanvas.dataset.uploadCanvas || ''; uploadAssetsState.selectedId = ''; loadUploadAssets().catch(err => setStatus(err.message || '读取画布素材失败')); return; }
        const uploadPreview = target.closest?.('[data-upload-preview]');
        if(uploadPreview){ showDetailPreview('upload', uploadPreview.dataset.uploadPreview || ''); return; }
        const uploadDownload = target.closest?.('[data-upload-download]');
        if(uploadDownload){ const item = findUploadAsset(uploadDownload.dataset.uploadDownload || ''); if(item) downloadUrl(item.url, assetDownloadName(item)); return; }
        const uploadCard = target.closest?.('[data-upload-card]');
        if(uploadCard){ uploadAssetsState.selectedId = uploadCard.dataset.uploadCard || ''; render(); return; }
    }
    const assetPreview = target.closest?.('[data-asset-preview]');
    if(assetPreview){ showDetailPreview('asset', assetPreview.dataset.assetPreview || ''); return; }
    const canvasAssetPreview = target.closest?.('[data-canvas-asset-preview]');
    if(canvasAssetPreview){ showDetailPreview('canvas-asset', canvasAssetPreview.dataset.canvasAssetPreview || ''); return; }
    const localPreview = target.closest?.('[data-local-preview]');
    if(localPreview){ showDetailPreview('local', localPreview.dataset.localPreview || ''); return; }
    const localUpPreview = target.closest?.('[data-localup-preview]');
    if(localUpPreview){ showDetailPreview('localup', localUpPreview.dataset.localupPreview || ''); return; }
    if(target.closest?.('[data-localup-upload]')){ uploadInput?.click(); return; }
    if(target.closest?.('[data-localup-folder-new]')){ beginCreateLocalUploadFolder(); return; }
    if(target.closest?.('[data-localup-folder-create-save]')){ await createLocalUploadFolder(); return; }
    if(target.closest?.('[data-localup-folder-create-cancel]')){ cancelCreateLocalUploadFolder(); return; }
    if(target.closest?.('[data-localup-folder-rename]')){ await renameLocalUploadFolder(); return; }
    if(target.closest?.('[data-localup-folder-delete]')){ await deleteLocalUploadFolder(); return; }
    const localUpFolder = target.closest?.('[data-localup-folder]');
    if(localUpFolder){
        imageSpaceState.all.local = false;
        imageSpaceState.collectionId = '';
        activeLocalUploadFolder = localUpFolder.dataset.localupFolder || '';
        activeLocalUploadClassFilter = '';
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        pendingBatchDelete = '';
        pendingTreeDelete = '';
        render();
        return;
    }
    if(target.closest?.('[data-localup-class-root]')){
        if(!localUploadClassEntries().length) setStatus('暂无智能分类，请先选择图片并点击“智能分类”');
        return;
    }
    const localUpClassGroup = target.closest?.('[data-localup-class-group]');
    if(localUpClassGroup){
        const groupId = localUpClassGroup.dataset.localupClassGroup || '';
        openLocalUploadClassGroup = openLocalUploadClassGroup === groupId ? '' : groupId;
        render();
        return;
    }
    const localUpClass = target.closest?.('[data-localup-class-filter]');
    if(localUpClass){
        const nextFilter = localUpClass.dataset.localupClassFilter || '';
        activeLocalUploadClassFilter = activeLocalUploadClassFilter === nextFilter ? '' : nextFilter;
        // 不再联动展开左侧「智能分类」分组；也不再清空预览选中——切换分类时保持当前预览的那张图，
        // 方便频繁切分类找相似图片。
        selectedLocalUploadIds.clear();
        pendingBatchDelete = '';
        render();
        return;
    }
    if(target.closest?.('[data-localup-manage]')){
        localUploadManageMode = !localUploadManageMode;
        if(!localUploadManageMode) selectedLocalUploadIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-localup-select-all]')){ localUploadItems().forEach(item => selectedLocalUploadIds.add(item.id)); render(); return; }
    if(target.closest?.('[data-localup-clear]')){ selectedLocalUploadIds.clear(); render(); return; }
    if(target.closest?.('[data-localup-download-selected]')){ await downloadSelectedLocalUploads(); return; }
    if(target.closest?.('[data-localup-canvas-selected]')){ copySelectedLocalUploadsToCanvas(); return; }
    if(target.closest?.('[data-localup-cut-selected]')){ setLocalUploadClipboard(); return; }
    if(target.closest?.('[data-localup-paste-clipboard]')){ await pasteLocalUploadClipboard(); return; }
    if(target.closest?.('[data-localup-clear-clipboard]')){ localUploadClipboard = null; render(); return; }
    const localUpDownload = target.closest?.('[data-localup-download]');
    if(localUpDownload){ downloadLocalUpload(localUpDownload.dataset.localupDownload || ''); return; }
    if(target.closest?.('[data-localup-delete-selected]')){ await deleteLocalAssets([...selectedLocalUploadIds]); return; }
    if(target.closest?.('[data-local-classify-toggle]')){ localClassifyPromptOpen = !localClassifyPromptOpen; render(); return; }
    if(target.closest?.('[data-local-classify-run]')){ await runLocalUploadClassifySelected(); return; }
    if(target.closest?.('[data-local-caption-run]')){ await runLocalUploadCaptionSelected(); return; }
    const localUpCaptionOne = target.closest?.('[data-localup-caption-one]');
    if(localUpCaptionOne){ await runLocalUploadCaptionOne(localUpCaptionOne.dataset.localupCaptionOne || ''); return; }
    const localUpCaptionCopy = target.closest?.('[data-localup-caption-copy]');
    if(localUpCaptionCopy){ await copyLocalUploadCaption(localUpCaptionCopy.dataset.localupCaptionCopy || ''); return; }
    const localUpCaptionSave = target.closest?.('[data-localup-caption-save]');
    if(localUpCaptionSave){ await saveLocalUploadCaption(localUpCaptionSave.dataset.localupCaptionSave || ''); return; }
    const localUpRename = target.closest?.('[data-localup-rename]');
    if(localUpRename){ event.stopPropagation(); beginLocalUploadInlineRename(localUpRename.dataset.localupRename || ''); return; }
    const localUpDeleteOne = target.closest?.('[data-localup-delete-one]');
    if(localUpDeleteOne){ await deleteLocalAssets([localUpDeleteOne.dataset.localupDeleteOne || '']); return; }
    const localUpCheck = target.closest?.('[data-localup-check]');
    if(localUpCheck){
        const id = localUpCheck.dataset.localupCheck || '';
        const selected = toggleSelectionSet(selectedLocalUploadIds, id);
        selectedLocalUploadId = selected ? id : (selectedLocalUploadId === id ? '' : selectedLocalUploadId);
        pendingBatchDelete = '';
        render();
        return;
    }
    const localUpOpen = target.closest?.('[data-localup-open]');
    if(localUpOpen){ const it = findLocalUpload(localUpOpen.dataset.localupOpen || ''); if(it?.url) window.open(it.url, '_blank'); return; }
    const localUpCopy = target.closest?.('[data-localup-copy]');
    if(localUpCopy){ const it = findLocalUpload(localUpCopy.dataset.localupCopy || ''); const ok = await copyTextToClipboard(it?.url || ''); setStatus(ok ? '已复制链接' : '复制失败'); return; }
    const localUpCard = target.closest?.('[data-localup-card]');
    if(localUpCard){
        const id = localUpCard.dataset.localupCard || '';
        if(localUploadManageMode){
            const selected = toggleSelectionSet(selectedLocalUploadIds, id);
            selectedLocalUploadId = selected ? id : (selectedLocalUploadId === id ? '' : selectedLocalUploadId);
            pendingBatchDelete = '';
            render();
        } else {
            selectedLocalUploadId = id;
            pendingBatchDelete = '';
            refreshLocalUploadSelectionOnly();
        }
        return;
    }
    if(target.closest?.('[data-local-pick-folder]')){ await registerSharedFolder(); return; }
    const canvasAssetProject = target.closest?.('[data-canvas-asset-project]');
    if(canvasAssetProject){
        activeTab = 'generated';
        generatedFavoritesOnly = false;
        imageSpaceState.collectionId = '';
        generatedAssetsState.selectedIds.clear();
        activeCanvasAssetProjectId = canvasAssetProject.dataset.canvasAssetProject || defaultCanvasAssetProject();
        activeCanvasAssetCanvasId = '';
        selectedCanvasAssetId = '';
        selectedCanvasAssetIds.clear();
        render();
        return;
    }
    const canvasAssetCanvas = target.closest?.('[data-canvas-asset-canvas]');
    if(canvasAssetCanvas){
        activeTab = 'generated';
        generatedFavoritesOnly = false;
        imageSpaceState.collectionId = '';
        activeCanvasAssetProjectId = canvasAssetCanvas.dataset.canvasAssetCanvasProject || activeCanvasAssetProjectId || 'default';
        activeCanvasAssetCanvasId = canvasAssetCanvas.dataset.canvasAssetCanvas || '';
        selectedCanvasAssetId = '';
        selectedCanvasAssetIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-canvas-asset-manage]')){
        canvasAssetManageMode = !canvasAssetManageMode;
        if(!canvasAssetManageMode) selectedCanvasAssetIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-canvas-asset-refresh]')){ await refreshCanvasAssets(); return; }
    if(target.closest?.('[data-canvas-asset-select-all]')){ currentCanvasAssetItems().forEach(item => selectedCanvasAssetIds.add(item.id)); render(); return; }
    if(target.closest?.('[data-canvas-asset-clear-selection]')){ selectedCanvasAssetIds.clear(); render(); return; }
    if(target.closest?.('[data-canvas-asset-download-selected]')){ await downloadCanvasAssetItems([...selectedCanvasAssetIds]); return; }
    const canvasAssetDownload = target.closest?.('[data-canvas-asset-download]');
    if(canvasAssetDownload){ await downloadCanvasAssetItems([canvasAssetDownload.dataset.canvasAssetDownload || '']); return; }
    const canvasAssetOpen = target.closest?.('[data-canvas-asset-open]');
    if(canvasAssetOpen){ const it = findCanvasAssetItem(canvasAssetOpen.dataset.canvasAssetOpen || ''); if(it?.url) window.open(it.url, '_blank', 'noopener'); return; }
    const canvasAssetCopy = target.closest?.('[data-canvas-asset-copy]');
    if(canvasAssetCopy){ const it = findCanvasAssetItem(canvasAssetCopy.dataset.canvasAssetCopy || ''); const ok = await copyTextToClipboard(it?.url || ''); setStatus(ok ? '已复制画布资产链接' : '复制失败'); return; }
    const canvasAssetCheck = target.closest?.('[data-canvas-asset-check]');
    if(canvasAssetCheck){
        event.preventDefault();
        event.stopPropagation();
        if(canvasAssetManageMode){
            const id = canvasAssetCheck.dataset.canvasAssetCheck || '';
            const selected = toggleSelectionSet(selectedCanvasAssetIds, id);
            selectedCanvasAssetId = selected ? id : (selectedCanvasAssetId === id ? '' : selectedCanvasAssetId);
            refreshCanvasAssetSelectionOnly();
        }
        return;
    }
    const canvasAssetCard = target.closest?.('[data-canvas-asset-card]');
    if(canvasAssetCard){
        const id = canvasAssetCard.dataset.canvasAssetCard || '';
        if(canvasAssetManageMode){
            const selected = toggleSelectionSet(selectedCanvasAssetIds, id);
            selectedCanvasAssetId = selected ? id : (selectedCanvasAssetId === id ? '' : selectedCanvasAssetId);
        } else {
            selectedCanvasAssetId = id;
        }
        refreshCanvasAssetSelectionOnly();
        return;
    }
    const sharedRemove = target.closest?.('[data-shared-remove]');
    if(sharedRemove){ event.stopPropagation(); await unregisterSharedFolder(sharedRemove.dataset.sharedRemove || ''); return; }
    const sharedOpen = target.closest?.('[data-shared-open]');
    if(sharedOpen){ await openSharedFolder(sharedOpen.dataset.sharedOpen || ''); return; }
    if(target.closest?.('[data-local-manage]')){
        localManageMode = !localManageMode;
        pendingBatchDelete = '';
        if(!localManageMode) selectedLocalIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-local-select-all]')){ localItemsForFolder().forEach(item => selectedLocalIds.add(item.id)); pendingBatchDelete = ''; render(); return; }
    if(target.closest?.('[data-local-clear-selection]')){ selectedLocalIds.clear(); pendingBatchDelete = ''; render(); return; }
    if(target.closest?.('[data-local-copy-selected]')){ setLocalClipboard('copy'); return; }
    if(target.closest?.('[data-local-import-clipboard]')){ await pasteLocalClipboardToAssets(); return; }
    if(target.closest?.('[data-local-clear-clipboard]')){ localClipboard = null; render(); return; }
    const localImportOne = target.closest?.('[data-local-import-one]');
    if(localImportOne){ setLocalClipboard('copy', [localImportOne.dataset.localImportOne || '']); await pasteLocalClipboardToAssets(); return; }
    const localOpen = target.closest?.('[data-local-open]');
    if(localOpen){ openLocalItem(localOpen.dataset.localOpen || ''); return; }
    const localFolder = target.closest?.('[data-local-folder]');
    if(localFolder){ activeLocalFolderId = localFolder.dataset.localFolder || ''; selectedLocalId = ''; selectedLocalIds.clear(); pendingBatchDelete = ''; render(); return; }
    const localCheck = target.closest?.('[data-local-check]');
    if(localCheck){
        event.preventDefault();
        event.stopPropagation();
        if(localManageMode){
            const id = localCheck.dataset.localCheck || '';
            const selected = toggleSelectionSet(selectedLocalIds, id);
            selectedLocalId = selected ? id : (selectedLocalId === id ? '' : selectedLocalId);
            pendingBatchDelete = '';
            render();
        }
        return;
    }
    const localCard = target.closest?.('[data-local-card]');
    if(localCard){
        const id = localCard.dataset.localCard || '';
        if(localManageMode){
            const selected = toggleSelectionSet(selectedLocalIds, id);
            selectedLocalId = selected ? id : (selectedLocalId === id ? '' : selectedLocalId);
        } else {
            selectedLocalId = id;
        }
        pendingBatchDelete = '';
        render();
        return;
    }
    if(target.closest?.('[data-workflow-manage]')){
        workflowManageMode = !workflowManageMode;
        if(!workflowManageMode) selectedWorkflowIds.clear();
        pendingDeleteAssetId = '';
        render();
        return;
    }
    if(target.closest?.('[data-workflow-select-all]')){ currentWorkflowItems().forEach(item => selectedWorkflowIds.add(item.id)); render(); return; }
    if(target.closest?.('[data-workflow-clear-selection]')){ selectedWorkflowIds.clear(); render(); return; }
    if(target.closest?.('[data-workflow-export-selected]')){ await exportWorkflowItems([...selectedWorkflowIds]); return; }
    if(target.closest?.('[data-workflow-export-desktop-selected]')){ await exportWorkflowItems([...selectedWorkflowIds], {desktop:true}); return; }
    if(target.closest?.('[data-workflow-delete-selected]')){ await deleteSelectedWorkflows(); return; }
    if(target.closest?.('[data-workflow-upload]')){
        if(uploadInput) uploadInput.accept = '.json,.zip,application/json,application/zip,application/x-zip-compressed';
        uploadInput?.click();
        return;
    }
    const workflowInsert = target.closest?.('[data-workflow-insert]');
    if(workflowInsert){ sendWorkflowToCanvas(workflowInsert.dataset.workflowInsert || ''); return; }
    const workflowDesktopExport = target.closest?.('[data-workflow-export-desktop]');
    if(workflowDesktopExport){ await exportWorkflowItems([workflowDesktopExport.dataset.workflowExportDesktop || ''], {desktop:true}); return; }
    const workflowRename = target.closest?.('[data-workflow-rename]');
    if(workflowRename){ await renameWorkflowItem(workflowRename.dataset.workflowRename || ''); return; }
    const workflowDelete = target.closest?.('[data-workflow-delete]');
    if(workflowDelete){ await deleteWorkflowItem(workflowDelete.dataset.workflowDelete || ''); return; }
    if(target.closest?.('[data-workflow-cat-new]')){
        workflowTreeEdit = {kind:'category-new', placement:'head', value:'新工作流分组', label:'工作流分组名称'};
        pendingTreeDelete = '';
        render();
        focusTreeEditInput('workflowTreeEditInput');
        return;
    }
    if(target.closest?.('[data-workflow-cat-rename]')){
        const cat = activeWorkflowCategory();
        if(!cat) return;
        workflowTreeEdit = {kind:'category-rename', value:cat.name || '', label:'工作流分组名称', categoryId:cat.id};
        pendingTreeDelete = '';
        render();
        focusTreeEditInput('workflowTreeEditInput');
        return;
    }
    if(target.closest?.('[data-workflow-cat-delete]')){ await deleteWorkflowCategory(); return; }
    const workflowLib = target.closest?.('[data-workflow-lib]');
    if(workflowLib){ activeWorkflowLibraryId = workflowLib.dataset.workflowLib || ''; activeWorkflowCategoryId = ''; selectedWorkflowId = ''; selectedWorkflowIds.clear(); render(); return; }
    const workflowCat = target.closest?.('[data-workflow-cat]');
    if(workflowCat){ activeWorkflowLibraryId = workflowCat.dataset.workflowCatLib || activeWorkflowLibraryId; activeWorkflowCategoryId = workflowCat.dataset.workflowCat || ''; selectedWorkflowId = ''; selectedWorkflowIds.clear(); render(); return; }
    const workflowCard = target.closest?.('[data-workflow-card]');
    if(workflowCard){
        const id = workflowCard.dataset.workflowCard || '';
        if(workflowManageMode){
            const selected = toggleSelectionSet(selectedWorkflowIds, id);
            selectedWorkflowId = selected ? id : (selectedWorkflowId === id ? '' : selectedWorkflowId);
        } else {
            selectedWorkflowId = id;
        }
        pendingDeleteAssetId = '';
        render();
        return;
    }
    if(target.closest?.('[data-asset-tree-edit-save]')){ await saveAssetTreeEdit(); return; }
    if(target.closest?.('[data-asset-tree-edit-cancel]')){ assetTreeEdit = null; render(); return; }
    if(target.closest?.('[data-workflow-tree-edit-save]')){ await saveWorkflowTreeEdit(); return; }
    if(target.closest?.('[data-workflow-tree-edit-cancel]')){ workflowTreeEdit = null; render(); return; }
    if(target.closest?.('[data-prompt-tree-edit-save]')){ await savePromptTreeEdit(); return; }
    if(target.closest?.('[data-prompt-tree-edit-cancel]')){ promptTreeEdit = null; render(); return; }
    const assetEditSave = target.closest?.('[data-asset-edit-save]');
    if(assetEditSave){ await saveAssetEdit(assetEditSave.dataset.assetEditSave || ''); return; }
    if(target.closest?.('[data-asset-edit-cancel]')){ assetEditMode = false; render(); return; }
    if(target.closest?.('[data-asset-context-background-remove]')){
        const menu = document.getElementById('assetContextMenu');
        const id = menu?.dataset.assetId || assetContextMenuId;
        if(id) await runAssetBackgroundRemoval([id]);
        return;
    }
    const assetBackgroundRemove = target.closest?.('[data-asset-background-remove]');
    if(assetBackgroundRemove){ await runAssetBackgroundRemoval([assetBackgroundRemove.dataset.assetBackgroundRemove || '']); return; }
    if(target.closest?.('[data-asset-background-remove-selected]')){ await runAssetBackgroundRemoval([...selectedAssetIds]); return; }
    const assetEditStart = target.closest?.('[data-asset-edit-start]');
    if(assetEditStart){ selectedAssetId = assetEditStart.dataset.assetEditStart || selectedAssetId; assetEditMode = true; pendingDeleteAssetId = ''; render(); return; }
    if(target.closest?.('[data-asset-manage]')){
        assetManageMode = !assetManageMode;
        pendingBatchDelete = '';
        if(!assetManageMode) selectedAssetIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-asset-select-all]')){ currentAssetItems().forEach(item => selectedAssetIds.add(item.id)); pendingBatchDelete = ''; render(); return; }
    if(target.closest?.('[data-asset-clear-selection]')){ selectedAssetIds.clear(); pendingBatchDelete = ''; render(); return; }
    if(target.closest?.('[data-asset-cut-selected]')){ setAssetClipboard('cut'); return; }
    if(target.closest?.('[data-asset-copy-selected]')){ setAssetClipboard('copy'); return; }
    if(target.closest?.('[data-asset-paste-clipboard]')){ await pasteAssetClipboard(); return; }
    if(target.closest?.('[data-asset-clear-clipboard]')){ assetClipboard = null; render(); return; }
    const assetRename = target.closest?.('[data-asset-rename]');
    if(assetRename){ await renameAssetItem(assetRename.dataset.assetRename || ''); return; }
    const assetDelete = target.closest?.('[data-asset-delete]');
    if(assetDelete){ await deleteAssetItem(assetDelete.dataset.assetDelete || ''); return; }
    const assetDownload = target.closest?.('[data-asset-download]');
    if(assetDownload){ downloadAssetItem(assetDownload.dataset.assetDownload || ''); return; }
    const assetOpen = target.closest?.('[data-asset-open]');
    if(assetOpen){ openAssetItem(assetOpen.dataset.assetOpen || ''); return; }
    const avatarCopy = target.closest?.('[data-avatar-copy]');
    if(avatarCopy){
        const uri = avatarCopy.dataset.avatarCopy || '';
        const ok = await copyTextToClipboard(uri);
        setStatus(ok ? '已复制 asset:// 地址' : `复制失败，请手动复制：${uri}`);
        return;
    }
    const avatarRegister = target.closest?.('[data-avatar-register]');
    if(avatarRegister){ await registerAssetAvatar(avatarRegister.dataset.avatarRegister || '', avatarRegister.dataset.avatarProv || ''); return; }
    const avatarCheck = target.closest?.('[data-avatar-check]');
    if(avatarCheck){ await checkAssetAvatarStatus(avatarCheck.dataset.avatarCheck || '', false, avatarCheck.dataset.avatarProv || ''); return; }
    if(target.closest?.('[data-asset-classify-selected]')){ await runAssetClassifySelected(); return; }
    if(target.closest?.('[data-asset-download-selected]')){ await downloadSelectedAssets(); return; }
    if(target.closest?.('[data-asset-copy-to-canvas]')){ copySelectedAssetsToCanvas(); return; }
    if(target.closest?.('[data-asset-delete-selected]')){ await deleteSelectedAssets(); return; }
    if(target.closest?.('[data-asset-upload]')){
        if(uploadInput) uploadInput.accept = 'image/*,video/*,audio/*';
        uploadInput?.click();
        return;
    }
    if(target.closest?.('[data-asset-lib-new]')){ assetTreeFocus = 'library'; assetTreeEdit = {kind:'library-new', placement:'head', value:'新资产库', label:'资产库名称'}; render(); focusTreeEditInput('assetTreeEditInput'); return; }
    if(target.closest?.('[data-asset-lib-rename]')){
        const row = target.closest('[data-asset-lib]');
        if(row) activeAssetLibraryId = row.dataset.assetLib || activeAssetLibraryId;
        assetTreeFocus = 'library';
        assetTreeEdit = {kind:'library-rename', value:activeAssetLibrary()?.name || '', label:'资产库名称'};
        pendingTreeDelete = '';
        render(); return;
    }
    if(target.closest?.('[data-asset-lib-delete]')){
        const row = target.closest('[data-asset-lib]');
        if(row) activeAssetLibraryId = row.dataset.assetLib || activeAssetLibraryId;
        await deleteAssetLibrary(); return;
    }
    if(target.closest?.('[data-asset-cat-new]')){
        const row = target.closest('[data-asset-lib]');
        const catRow = target.closest('[data-asset-cat]');
        if(row) activeAssetLibraryId = row.dataset.assetLib || activeAssetLibraryId;
        if(catRow) activeAssetLibraryId = catRow.dataset.assetCatLib || activeAssetLibraryId;
        assetTreeEdit = {kind:'category-new', value:'新分组', label:'分组名称'};
        pendingTreeDelete = '';
        render(); return;
    }
    if(target.closest?.('[data-asset-cat-rename]')){
        const row = target.closest('[data-asset-cat]');
        if(row){ activeAssetLibraryId = row.dataset.assetCatLib || activeAssetLibraryId; activeAssetCategoryId = row.dataset.assetCat || activeAssetCategoryId; }
        assetTreeFocus = 'category';
        assetTreeEdit = {kind:'category-rename', value:activeAssetCategory()?.name || '', label:'分组名称'};
        pendingTreeDelete = '';
        render(); return;
    }
    if(target.closest?.('[data-asset-cat-delete]')){
        const row = target.closest('[data-asset-cat]');
        if(row){ activeAssetLibraryId = row.dataset.assetCatLib || activeAssetLibraryId; activeAssetCategoryId = row.dataset.assetCat || activeAssetCategoryId; }
        await deleteAssetCategory(); return;
    }
    const assetLib = target.closest?.('[data-asset-lib]');
    if(assetLib){ activeAssetLibraryId = assetLib.dataset.assetLib || ''; assetTreeFocus = 'library'; activeAssetClassFilter = ''; activeAssetCategoryId = assetCategories()[0]?.id || ''; selectedAssetId = ''; selectedAssetIds.clear(); render(); return; }
    const assetClassRoot = target.closest?.('[data-asset-class-root]');
    if(assetClassRoot){
        activeAssetLibraryId = assetClassRoot.dataset.assetClassRoot || activeAssetLibraryId;
        assetTreeFocus = 'class';
        if(!assetClassificationEntriesForLibrary(activeAssetLibrary()).length) setStatus('暂无智能分类，请先选择图片并点击“智能分类”');
        return;
    }
    const assetClassGroup = target.closest?.('[data-asset-class-group]');
    if(assetClassGroup){
        openAssetClassGroup = openAssetClassGroup === (assetClassGroup.dataset.assetClassGroup || '') ? '' : (assetClassGroup.dataset.assetClassGroup || '');
        render();
        return;
    }
    const assetClass = target.closest?.('[data-asset-class-filter]');
    if(assetClass){
        activeAssetLibraryId = assetClass.dataset.assetClassLib || activeAssetLibraryId;
        const nextFilter = assetClass.dataset.assetClassFilter || '';
        activeAssetClassFilter = activeAssetClassFilter === nextFilter ? '' : nextFilter;
        if(activeAssetClassFilter) {
            openAssetClassGroup = assetClassificationGroupIdForFilter(activeAssetClassFilter, assetClassificationEntriesForLibrary(activeAssetLibrary())) || openAssetClassGroup;
        }
        assetTreeFocus = 'class';
        selectedAssetId = '';
        selectedAssetIds.clear();
        pendingBatchDelete = '';
        render();
        return;
    }
    const assetCat = target.closest?.('[data-asset-cat]');
    if(assetCat){ imageSpaceState.all.assets = false; imageSpaceState.collectionId = ''; activeAssetLibraryId = assetCat.dataset.assetCatLib || activeAssetLibraryId; activeAssetCategoryId = assetCat.dataset.assetCat || ''; activeAssetClassFilter = ''; assetTreeFocus = 'category'; selectedAssetId = ''; selectedAssetIds.clear(); render(); return; }
    const assetCheck = target.closest?.('[data-asset-check]');
    if(assetCheck){
        event.preventDefault();
        event.stopPropagation();
        if(assetManageMode){
            const id = assetCheck.dataset.assetCheck || '';
            const selected = toggleSelectionSet(selectedAssetIds, id);
            selectedAssetId = selected ? id : (selectedAssetId === id ? '' : selectedAssetId);
            pendingBatchDelete = '';
            render();
        }
        return;
    }
    const assetCard = target.closest?.('[data-asset-card]');
    if(assetCard){
        const id = assetCard.dataset.assetCard || '';
        if(assetManageMode){
            const selected = toggleSelectionSet(selectedAssetIds, id);
            selectedAssetId = selected ? id : (selectedAssetId === id ? '' : selectedAssetId);
        } else {
            selectedAssetId = id;
        }
        assetEditMode = false;
        pendingDeleteAssetId = '';
        pendingBatchDelete = '';
        render();
        return;
    }

    const promptEditSave = target.closest?.('[data-prompt-edit-save]');
    if(promptEditSave){ await savePromptEdit(promptEditSave.dataset.promptEditSave || ''); return; }
    if(target.closest?.('[data-prompt-create-save]')){ await savePromptCreate(); return; }
    if(target.closest?.('[data-prompt-edit-cancel]')){ promptEditMode = false; promptCreateMode = false; render(); return; }
    const promptEditStart = target.closest?.('[data-prompt-edit-start]');
    if(promptEditStart){ selectedPromptId = promptEditStart.dataset.promptEditStart || selectedPromptId; promptEditMode = true; promptCreateMode = false; pendingDeletePromptId = ''; render(); return; }
    if(target.closest?.('[data-prompt-manage]')){
        promptManageMode = !promptManageMode;
        pendingBatchDelete = '';
        if(!promptManageMode) selectedPromptIds.clear();
        render();
        return;
    }
    if(target.closest?.('[data-prompt-select-all]')){ currentPromptItems().forEach(item => selectedPromptIds.add(item.id)); pendingBatchDelete = ''; render(); return; }
    if(target.closest?.('[data-prompt-clear-selection]')){ selectedPromptIds.clear(); pendingBatchDelete = ''; render(); return; }
    const promptEdit = target.closest?.('[data-prompt-edit]');
    if(promptEdit){ await editPromptItem(promptEdit.dataset.promptEdit || ''); return; }
    const promptDelete = target.closest?.('[data-prompt-delete]');
    if(promptDelete){ await deletePromptItem(promptDelete.dataset.promptDelete || ''); return; }
    if(target.closest?.('[data-prompt-delete-selected]')){ await deleteSelectedPrompts(); return; }
    const promptNewBtn = target.closest?.('[data-prompt-new]');
    if(promptNewBtn){
        const libId = promptNewBtn.dataset.libId || target.closest('[data-prompt-lib]')?.dataset.promptLib;
        const catRow = target.closest('[data-prompt-cat]');
        if(libId){ activePromptLibraryId = libId; activePromptCategory = 'all'; }
        if(catRow){ activePromptLibraryId = catRow.dataset.promptCatLib || activePromptLibraryId; activePromptCategory = catRow.dataset.promptCat || activePromptCategory; }
        promptCreateMode = true; promptEditMode = false; pendingDeletePromptId = ''; render(); return;
    }
     if(target.closest?.('[data-prompt-lib-new]')){ promptTreeFocus = 'library'; promptTreeEdit = {kind:'library-new', placement:'head', value:'新提示词模板库', label:'提示词模板库名称'}; render(); focusTreeEditInput('promptTreeEditInput'); return; }
    if(target.closest?.('[data-prompt-cat-new]')){
        const libRow = target.closest('[data-prompt-lib]');
        if(libRow) activePromptLibraryId = libRow.dataset.promptLib || activePromptLibraryId;
        promptTreeFocus = 'library';
        promptTreeEdit = {kind:'category-new', value:'新分组', label:'分组名称'};
        pendingTreeDelete = '';
        render(); return;
    }
    if(target.closest?.('[data-prompt-cat-rename]')){
        promptTreeFocus = 'category';
        const cat = activePromptCategories().find(c => c.id === activePromptCategory);
        promptTreeEdit = {kind:'category-rename', value:cat?.name || '', label:'分组名称'};
        pendingTreeDelete = '';
        render(); return;
    }
    if(target.closest?.('[data-prompt-cat-delete]')){ await deletePromptCategory(); return; }
    const promptLibRenameBtn = target.closest?.('[data-prompt-lib-rename]');
    if(promptLibRenameBtn){
        const libRow = target.closest('[data-prompt-lib]');
        if(promptLibRenameBtn.dataset.libId) activePromptLibraryId = promptLibRenameBtn.dataset.libId;
        if(libRow) activePromptLibraryId = libRow.dataset.promptLib || activePromptLibraryId;
        promptTreeFocus = 'library';
         promptTreeEdit = {kind:'library-rename', value:activePromptLibrary()?.name || '', label:'提示词模板库名称'};
        render(); return;
    }
    const promptLibDeleteBtn = target.closest?.('[data-prompt-lib-delete]');
    if(promptLibDeleteBtn){
        if(promptLibDeleteBtn.dataset.libId) activePromptLibraryId = promptLibDeleteBtn.dataset.libId;
        await deletePromptLibrary(); return;
    }
    const promptLib = target.closest?.('[data-prompt-lib]');
    if(promptLib){ activePromptLibraryId = promptLib.dataset.promptLib || ''; activePromptCategory = 'all'; promptTreeFocus = 'library'; selectedPromptId = ''; promptCreateMode = false; promptEditMode = false; selectedPromptIds.clear(); render(); return; }
    const promptCat = target.closest?.('[data-prompt-cat]');
    if(promptCat){ activePromptLibraryId = promptCat.dataset.promptCatLib || activePromptLibraryId; activePromptCategory = promptCat.dataset.promptCat || 'all'; promptTreeFocus = 'category'; selectedPromptId = ''; promptCreateMode = false; promptEditMode = false; selectedPromptIds.clear(); render(); return; }
    const promptRow = target.closest?.('[data-prompt-row]');
    if(promptRow){
        const id = promptRow.dataset.promptRow || '';
        if(promptManageMode){
            const selected = toggleSelectionSet(selectedPromptIds, id);
            selectedPromptId = selected ? id : (selectedPromptId === id ? '' : selectedPromptId);
        } else {
            selectedPromptId = id;
        }
        promptEditMode = false;
        promptCreateMode = false;
        pendingDeletePromptId = '';
        pendingBatchDelete = '';
        render();
        return;
    }
}
function openAssetItem(id){
    const item = findAssetItem(id);
    if(item?.url) window.open(item.url, '_blank', 'noopener');
}
function showDetailPreview(source, id){
    const item = source === 'upload'
        ? findUploadAsset(id)
        : source === 'local'
        ? findLocalItem(id)
        : source === 'generated'
            ? findGeneratedAsset(id)
        : source === 'localup'
            ? findLocalUpload(id)
            : source === 'canvas-asset'
                ? findCanvasAssetItem(id)
                : findAssetItem(id);
    if(!item) return;
    const kind = source === 'local' ? (item.kind || localItemKind(item)) : assetKind(item);
    if(!['image','video'].includes(kind)){
        setStatus('仅图片和视频支持预览');
        return;
    }
    const url = source === 'local' ? localObjectUrl(item) : item.url;
    if(!url) return;
    document.querySelector('.asset-lightbox')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'asset-lightbox';
    overlay.dataset.scale = '1';
    overlay.dataset.x = '0';
    overlay.dataset.y = '0';
    overlay.innerHTML = `
        <div class="asset-lightbox-inner" role="dialog" aria-modal="true" aria-label="${kind === 'video' ? '视频预览' : '图片预览'}">
            ${kind === 'video'
                ? `<video class="asset-lightbox-video" src="${escapeAttr(url)}" controls autoplay playsinline preload="metadata"></video>`
                : `<img class="asset-lightbox-image" src="${escapeAttr(url)}" alt="${escapeAttr(item.name || 'preview')}" draggable="false">`}
        </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add('asset-lightbox-open');
}
function closeDetailPreview(){
    document.querySelector('.asset-lightbox')?.remove();
    document.body.classList.remove('asset-lightbox-open');
    lightboxPanState = null;
}
function applyLightboxTransform(overlay){
    const image = overlay?.querySelector?.('.asset-lightbox-image');
    if(!image) return;
    const scale = Number(overlay.dataset.scale || 1);
    const x = Number(overlay.dataset.x || 0);
    const y = Number(overlay.dataset.y || 0);
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    overlay.classList.toggle('zoomed', scale > 1.01);
}
function zoomDetailPreview(event){
    const overlay = event.target.closest?.('.asset-lightbox');
    const image = event.target.closest?.('.asset-lightbox-image');
    if(!overlay || !image) return;
    event.preventDefault();
    const current = Number(overlay.dataset.scale || 1);
    const next = Math.max(0.25, Math.min(8, current * (event.deltaY < 0 ? 1.15 : 0.87)));
    const rect = overlay.getBoundingClientRect();
    const anchorX = event.clientX - (rect.left + rect.width / 2);
    const anchorY = event.clientY - (rect.top + rect.height / 2);
    const currentX = Number(overlay.dataset.x || 0);
    const currentY = Number(overlay.dataset.y || 0);
    const ratio = next / current;
    overlay.dataset.scale = String(next);
    if(next <= 1.01){
        overlay.dataset.x = '0';
        overlay.dataset.y = '0';
    } else {
        overlay.dataset.x = String(anchorX - ratio * (anchorX - currentX));
        overlay.dataset.y = String(anchorY - ratio * (anchorY - currentY));
    }
    applyLightboxTransform(overlay);
}
function beginLightboxPan(event){
    const image = event.target.closest?.('.asset-lightbox-image');
    const overlay = event.target.closest?.('.asset-lightbox');
    if(!image || !overlay) return;
    const scale = Number(overlay.dataset.scale || 1);
    if(scale <= 1.01) return;
    event.preventDefault();
    lightboxPanState = {
        overlay,
        pointerId:event.pointerId,
        startX:event.clientX,
        startY:event.clientY,
        originX:Number(overlay.dataset.x || 0),
        originY:Number(overlay.dataset.y || 0)
    };
    image.setPointerCapture?.(event.pointerId);
    overlay.classList.add('dragging');
}
function updateLightboxPan(event){
    if(!lightboxPanState || event.pointerId !== lightboxPanState.pointerId) return;
    const {overlay, startX, startY, originX, originY} = lightboxPanState;
    overlay.dataset.x = String(originX + event.clientX - startX);
    overlay.dataset.y = String(originY + event.clientY - startY);
    applyLightboxTransform(overlay);
}
function endLightboxPan(event){
    if(!lightboxPanState || event.pointerId !== lightboxPanState.pointerId) return;
    lightboxPanState.overlay?.classList.remove('dragging');
    lightboxPanState = null;
}
function rectsIntersect(a, b){
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
function marqueeTargetSelector(){
    if(activeTab === 'assets' && assetManageMode) return '[data-asset-card]';
    if(activeTab === 'prompts' && promptManageMode) return '[data-prompt-row]';
    if(activeTab === 'local' && localUploadManageMode) return '[data-localup-card]';
    if(isCanvasAssetView() && canvasAssetManageMode) return '[data-canvas-asset-card]';
    return '';
}
function beginMarqueeSelection(event){
    const selector = marqueeTargetSelector();
    if(!selector) return;
    if(event.button !== 0) return;
    if(event.target.closest?.('button,input,textarea,select,.side-upload-card,.upload-grid-card,.asset-search-wrap')) return;
    const area = event.target.closest?.('.content-scroll');
    if(!area) return;
    event.preventDefault();
    const box = document.createElement('div');
    box.className = 'selection-marquee';
    area.appendChild(box);
    marqueeState = {
        startX:event.clientX,
        startY:event.clientY,
        area,
        box,
        selector,
        baseAsset:new Set(selectedAssetIds),
        basePrompt:new Set(selectedPromptIds),
        baseLocal:new Set(selectedLocalUploadIds),
        baseCanvasAsset:new Set(selectedCanvasAssetIds)
    };
    updateMarqueeSelection(event);
}
function updateMarqueeSelection(event){
    if(!marqueeState) return;
    const left = Math.min(marqueeState.startX, event.clientX);
    const top = Math.min(marqueeState.startY, event.clientY);
    const right = Math.max(marqueeState.startX, event.clientX);
    const bottom = Math.max(marqueeState.startY, event.clientY);
    const areaRect = marqueeState.area.getBoundingClientRect();
    const boxLeft = left - areaRect.left + marqueeState.area.scrollLeft;
    const boxTop = top - areaRect.top + marqueeState.area.scrollTop;
    Object.assign(marqueeState.box.style, {
        left:`${boxLeft}px`,
        top:`${boxTop}px`,
        width:`${Math.max(1, right - left)}px`,
        height:`${Math.max(1, bottom - top)}px`
    });
    const rect = {left, top, right, bottom};
    if(activeTab === 'assets'){
        selectedAssetIds = new Set(marqueeState.baseAsset);
        document.querySelectorAll(marqueeState.selector).forEach(el => {
            if(rectsIntersect(rect, el.getBoundingClientRect())) selectedAssetIds.add(el.dataset.assetCard);
        });
    } else if(activeTab === 'prompts') {
        selectedPromptIds = new Set(marqueeState.basePrompt);
        document.querySelectorAll(marqueeState.selector).forEach(el => {
            if(rectsIntersect(rect, el.getBoundingClientRect())) selectedPromptIds.add(el.dataset.promptRow);
        });
    } else if(activeTab === 'local') {
        selectedLocalUploadIds = new Set(marqueeState.baseLocal);
        document.querySelectorAll(marqueeState.selector).forEach(el => {
            if(rectsIntersect(rect, el.getBoundingClientRect())) selectedLocalUploadIds.add(el.dataset.localupCard);
        });
    } else if(isCanvasAssetView()) {
        selectedCanvasAssetIds = new Set(marqueeState.baseCanvasAsset);
        document.querySelectorAll(marqueeState.selector).forEach(el => {
            if(rectsIntersect(rect, el.getBoundingClientRect())) selectedCanvasAssetIds.add(el.dataset.canvasAssetCard);
        });
    }
    document.querySelectorAll('[data-asset-check]').forEach(input => { input.checked = selectedAssetIds.has(input.dataset.assetCheck); });
    document.querySelectorAll('[data-prompt-check]').forEach(input => { input.checked = selectedPromptIds.has(input.dataset.promptCheck); });
    document.querySelectorAll('[data-localup-check]').forEach(input => { input.checked = selectedLocalUploadIds.has(input.dataset.localupCheck); });
    document.querySelectorAll('[data-canvas-asset-check]').forEach(input => { input.checked = selectedCanvasAssetIds.has(input.dataset.canvasAssetCheck); });
}
function endMarqueeSelection(){
    if(!marqueeState) return;
    marqueeState.box.remove();
    marqueeState = null;
    pendingBatchDelete = '';
    render();
}
async function createAssetLibrary(){
    const name = window.prompt('资产库名称', '新资产库');
    if(!String(name || '').trim()) return;
    const data = await apiJson('/api/asset-library/libraries', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    activeAssetLibraryId = data.asset_library?.id || activeAssetLibraryId;
    activeAssetCategoryId = '';
    selectedAssetId = '';
    render();
}
async function saveAssetTreeEdit(){
    if(!assetTreeEdit) return;
    const name = document.getElementById('assetTreeEditInput')?.value || '';
    if(!String(name || '').trim()){
        setStatus('名称不能为空');
        return;
    }
    let data = null;
    if(assetTreeEdit.kind === 'library-new'){
        data = await apiJson('/api/asset-library/libraries', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        assetLibrary = data.library || assetLibrary;
        activeAssetLibraryId = data.asset_library?.id || activeAssetLibraryId;
        activeAssetClassFilter = '';
        assetTreeFocus = 'library';
    } else if(assetTreeEdit.kind === 'library-rename'){
        const lib = activeAssetLibrary();
        if(!lib) return;
        data = await apiJson(`/api/asset-library/libraries/${encodeURIComponent(lib.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        assetLibrary = data.library || assetLibrary;
        assetTreeFocus = 'library';
    } else if(assetTreeEdit.kind === 'category-new'){
        data = await apiJson('/api/asset-library/categories', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:activeAssetLibraryId, name, type:'image'})});
        assetLibrary = data.library || assetLibrary;
        activeAssetCategoryId = data.category?.id || activeAssetCategoryId;
        activeAssetClassFilter = '';
        assetTreeFocus = 'category';
    } else if(assetTreeEdit.kind === 'category-rename'){
        const cat = activeAssetCategory();
        if(!cat) return;
        data = await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        assetLibrary = data.library || assetLibrary;
        assetTreeFocus = 'category';
    }
    assetTreeEdit = null;
    pendingTreeDelete = '';
    render();
    setStatus('已保存');
}
async function saveWorkflowTreeEdit(){
    if(!workflowTreeEdit) return;
    const name = document.getElementById('workflowTreeEditInput')?.value || '';
    if(!String(name || '').trim()){
        setStatus('名称不能为空');
        return;
    }
    if(workflowTreeEdit.kind === 'category-new'){
        const lib = activeWorkflowLibrary();
        if(!lib){
            setStatus('请先选择资产库');
            return;
        }
        activeWorkflowLibraryId = lib.id || activeWorkflowLibraryId;
        const data = await apiJson('/api/asset-library/categories', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:activeWorkflowLibraryId, name, type:'workflow'})
        });
        assetLibrary = data.library || assetLibrary;
        activeWorkflowCategoryId = data.category?.id || activeWorkflowCategoryId;
    } else if(workflowTreeEdit.kind === 'category-rename'){
        const cat = activeWorkflowCategory();
        const categoryId = workflowTreeEdit.categoryId || cat?.id || activeWorkflowCategoryId;
        if(!categoryId) return;
        const data = await apiJson(`/api/asset-library/categories/${encodeURIComponent(categoryId)}`, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name, library_id:activeWorkflowLibraryId})
        });
        assetLibrary = data.library || assetLibrary;
        activeWorkflowCategoryId = categoryId;
    }
    workflowTreeEdit = null;
    pendingTreeDelete = '';
    render();
    setStatus('已保存');
}
async function deleteWorkflowCategory(){
    const cat = activeWorkflowCategory();
    if(!cat) return;
    const libraryId = cat.__libraryId || activeWorkflowLibraryId;
    const key = `workflow-cat:${libraryId}:${cat.id}`;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        workflowTreeEdit = null;
        render();
        setStatus('再次点击确认删除工作流分组');
        return;
    }
    const data = await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}?library_id=${encodeURIComponent(libraryId)}`, {method:'DELETE'});
    assetLibrary = data.library || assetLibrary;
    activeWorkflowCategoryId = '';
    selectedWorkflowId = '';
    selectedWorkflowIds.clear();
    pendingTreeDelete = '';
    render();
    setStatus('工作流分组已删除');
}
async function renameAssetLibrary(){
    const lib = activeAssetLibrary();
    const name = window.prompt('资产库名称', lib?.name || '');
    if(!lib || !String(name || '').trim()) return;
    const data = await apiJson(`/api/asset-library/libraries/${encodeURIComponent(lib.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    render();
}
async function deleteAssetLibrary(){
    const lib = activeAssetLibrary();
    if(!lib) return;
    const key = `asset-lib:${lib.id}`;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        assetTreeEdit = null;
        render();
        setStatus('再次点击确认删除资产库');
        return;
    }
    const data = await apiJson(`/api/asset-library/libraries/${encodeURIComponent(lib.id)}`, {method:'DELETE'});
    assetLibrary = data.library || assetLibrary;
    activeAssetLibraryId = assetLibrary.active_library_id || assetLibraries()[0]?.id || '';
    activeAssetCategoryId = '';
    activeAssetClassFilter = '';
    selectedAssetId = '';
    selectedAssetIds.clear();
    pendingTreeDelete = '';
    render();
}
async function createAssetCategory(){
    const name = window.prompt('分组名称', '新分组');
    if(!String(name || '').trim()) return;
    const data = await apiJson('/api/asset-library/categories', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:activeAssetLibraryId, name, type:'image'})});
    assetLibrary = data.library || assetLibrary;
    activeAssetCategoryId = data.category?.id || activeAssetCategoryId;
    activeAssetClassFilter = '';
    selectedAssetId = '';
    render();
}
async function renameAssetCategory(){
    const cat = activeAssetCategory();
    const name = window.prompt('分组名称', cat?.name || '');
    if(!cat || !String(name || '').trim()) return;
    const data = await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    render();
}
async function deleteAssetCategory(){
    const cat = activeAssetCategory();
    if(!cat) return;
    const key = `asset-cat:${cat.id}`;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        assetTreeEdit = null;
        render();
        setStatus('再次点击确认删除分组');
        return;
    }
    const data = await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}`, {method:'DELETE'});
    assetLibrary = data.library || assetLibrary;
    activeAssetCategoryId = '';
    activeAssetClassFilter = '';
    selectedAssetId = '';
    selectedAssetIds.clear();
    pendingTreeDelete = '';
    render();
}
async function renameAssetItem(id){
    const item = findAssetItem(id);
    if(!item) return;
    selectedAssetId = id;
    render();
    requestAnimationFrame(() => {
        const input = [...root.querySelectorAll('[data-asset-inline-name]')].find(el => el.dataset.assetInlineName === id);
        input?.focus();
        input?.select?.();
    });
}
async function saveAssetEdit(id){
    const item = findAssetItem(id);
    const name = document.getElementById('assetEditName')?.value || '';
    if(!item || !String(name || '').trim()) {
        setStatus('素材名称不能为空');
        return;
    }
    const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    selectedAssetId = id;
    assetEditMode = false;
    render();
    setStatus('素材已保存');
}
async function saveAssetInlineName(id, name){
    const item = findAssetItem(id);
    if(!item || !String(name || '').trim()) return;
    if(String(item.name || '') === String(name || '')) return;
    const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    assetLibrary = data.library || assetLibrary;
    selectedAssetId = id;
    render();
    setStatus('素材名称已保存');
}
async function registerAssetAvatar(id, providerId=''){
    const item = findAssetItem(id);
    if(!item) return;
    const provider = (providerId && (apiProviders || []).find(p => p.id === providerId)) || activeAvatarProvider();
    if(!provider){ setStatus('请先在 API 平台管理中添加并启用 API 平台'); return; }
    if(!providerAvatarSupported(provider)){ setStatus(`「${avatarPlatformLabel(providerAvatarPlatform(provider))}」的资产认证 API 尚未接入`); return; }
    if(avatarBusyId) return;
    avatarBusyId = id;
    selectedAssetId = id;
    render();
    setStatus(`正在上传素材并提交 ${avatarPlatformLabel(providerAvatarPlatform(provider))} 审核…`);
    try {
        const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/register-avatar`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:activeAssetLibraryId, provider_id:provider.id})
        });
        assetLibrary = data.library || assetLibrary;
        setStatus(`已提交审核，正在等待 ${avatarPlatformLabel(providerAvatarPlatform(provider))} 通过…`);
        scheduleAvatarPoll(id, provider.id);
    } catch(err) {
        setStatus(err.message || '数字人提交失败');
    } finally {
        avatarBusyId = '';
        render();
    }
}
function avatarRegistrationOf(item, platform){
    const regs = (item && item.registrations && typeof item.registrations === 'object') ? item.registrations : {};
    return regs[platform] || null;
}
async function checkAssetAvatarStatus(id, silent=false, providerId=''){
    const item = findAssetItem(id);
    if(!item) return;
    const provider = (providerId && (apiProviders || []).find(p => p.id === providerId)) || activeAvatarProvider();
    if(!provider) return;
    const platform = providerAvatarPlatform(provider);
    const reg = avatarRegistrationOf(item, platform);
    if(!reg || !reg.task_id) return;
    if(!silent){ avatarBusyId = id; render(); setStatus('正在查询审核状态…'); }
    try {
        const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/avatar-status`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:activeAssetLibraryId, provider_id:provider.id})
        });
        assetLibrary = data.library || assetLibrary;
        const newReg = (data.item?.registrations && data.item.registrations[platform]) || {};
        const status = newReg.status || '';
        if(status === 'Active') setStatus('审核通过，已生成 asset:// 地址，可在视频生成中通过 @ 调用');
        else if(status === 'Failed') setStatus(newReg.detail || '审核未通过');
        else { setStatus('仍在审核中，稍后会自动刷新…'); scheduleAvatarPoll(id, provider.id); }
    } catch(err) {
        if(!silent) setStatus(err.message || '查询审核状态失败');
    } finally {
        avatarBusyId = '';
        render();
    }
}
function scheduleAvatarPoll(id, providerId){
    setTimeout(() => {
        const item = findAssetItem(id);
        const provider = (apiProviders || []).find(p => p.id === providerId);
        if(!item || !provider) return;
        const reg = avatarRegistrationOf(item, providerAvatarPlatform(provider));
        if(reg && reg.task_id && reg.status === 'Processing'){
            checkAssetAvatarStatus(id, true, providerId);
        }
    }, 6000);
}
async function deleteAssetItem(id){
    const item = findAssetItem(id);
    if(!item) return;
    const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, {method:'DELETE'});
    assetLibrary = data.library || assetLibrary;
    selectedAssetIds.delete(id);
    if(selectedAssetId === id) selectedAssetId = '';
    pendingDeleteAssetId = '';
    render();
    setStatus('素材已移入回收站');
}
async function deleteSelectedAssets(){
    if(!selectedAssetIds.size) return;
    const ids = [...selectedAssetIds];
    const data = await apiJson('/api/asset-library/items/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:activeAssetLibraryId, ids})});
    assetLibrary = data.library || assetLibrary;
    if(ids.includes(selectedAssetId)) selectedAssetId = '';
    selectedAssetIds.clear();
    pendingBatchDelete = '';
    render();
    setStatus(`已将 ${data.removed || ids.length} 个素材移入回收站`);
}
function setAssetClipboard(mode){
    if(!selectedAssetIds.size) return;
    assetClipboard = {
        mode,
        ids:[...selectedAssetIds],
        sourceLibraryId:activeAssetLibraryId,
        sourceCategoryId:activeAssetCategoryId,
        items:[...selectedAssetIds].map(id => findAssetItem(id)).filter(Boolean)
    };
    selectedAssetIds.clear();
    pendingBatchDelete = '';
    render();
    const label = mode === 'cut' ? '剪切' : '复制';
    setStatus(`${label}了 ${assetClipboard.ids.length} 个素材，切换分组后粘贴`);
}
async function pasteAssetClipboard(){
    if(!assetClipboard?.ids?.length) return;
    if(assetClipboard.mode === 'cut'){
        if(assetClipboard.sourceLibraryId === activeAssetLibraryId && assetClipboard.sourceCategoryId === activeAssetCategoryId) return;
        const data = await apiJson('/api/asset-library/items/move', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:assetClipboard.sourceLibraryId, target_library_id:activeAssetLibraryId, target_category_id:activeAssetCategoryId, ids:assetClipboard.ids})
        });
        assetLibrary = data.library || assetLibrary;
        setStatus(`已移动 ${data.moved || 0} 个素材`);
    } else {
        const items = (assetClipboard.items || []).map(item => ({url:item.url, name:item.name || 'asset'})).filter(item => item.url);
        const data = await apiJson('/api/asset-library/items/batch', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({library_id:activeAssetLibraryId, category_id:activeAssetCategoryId, items})
        });
        assetLibrary = data.library || assetLibrary;
        setStatus(`已复制 ${data.items?.length || 0} 个素材`);
    }
    assetClipboard = null;
    selectedAssetIds.clear();
    selectedAssetId = '';
    render();
}
function setLocalClipboard(mode, ids=null){
    // 共享文件夹只读，仅支持「复制」（引用导入），不支持剪切删除源文件
    const sourceIds = Array.isArray(ids) ? ids.filter(Boolean) : [...selectedLocalIds];
    if(!sourceIds.length) return;
    const items = sourceIds.map(id => findLocalItem(id)).filter(Boolean);
    if(!items.length) return;
    localClipboard = {
        mode:'copy',
        ids:items.map(item => item.id),
        items,
        sourceRootName:activeSharedFolderName || '共享文件夹'
    };
    selectedLocalIds.clear();
    pendingBatchDelete = '';
    render();
    setStatus(`复制了 ${items.length} 个共享素材，导入后会拷贝到图片资产分组（共享文件夹原文件保留）`);
}
async function pasteLocalClipboardToAssets(){
    if(!localClipboard?.items?.length) return;
    if(!activeAssetCategory()){
        setStatus('请先在图片资产中创建或选择分组');
        return;
    }
    const clip = localClipboard;
    // 按所属共享文件夹分组，调用后端按路径导入（复制到素材库，无需走浏览器文件对象）
    const groups = new Map();
    clip.items.forEach(item => {
        if(!item || !item.folderId || !item.relativePath) return;
        if(!groups.has(item.folderId)) groups.set(item.folderId, []);
        groups.get(item.folderId).push(item.relativePath);
    });
    if(!groups.size) return;
    setStatus('正在导入共享素材...');
    let imported = 0;
    try {
        for(const [folderId, paths] of groups){
            const data = await apiJson('/api/shared-folders/import', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({library_id:activeAssetLibraryId, category_id:activeAssetCategoryId, folder_id:folderId, paths})
            });
            assetLibrary = data.library || assetLibrary;
            imported += (data.items?.length || 0);
        }
    } catch(err) {
        setStatus(err.message || '导入共享素材失败');
        return;
    }
    localClipboard = null;
    selectedLocalIds.clear();
    selectedLocalId = '';
    render();
    setStatus(`已导入 ${imported} 个素材到图片资产`);
}
async function moveSelectedAssets(){
    if(!selectedAssetIds.size || !assetMoveTarget) return;
    const [targetLibraryId, targetCategoryId] = assetMoveTarget.split('::');
    if(!targetLibraryId || !targetCategoryId) return;
    const ids = [...selectedAssetIds];
    const data = await apiJson('/api/asset-library/items/move', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({library_id:activeAssetLibraryId, target_library_id:targetLibraryId, target_category_id:targetCategoryId, ids})
    });
    assetLibrary = data.library || assetLibrary;
    selectedAssetIds.clear();
    if(ids.includes(selectedAssetId)) selectedAssetId = '';
    render();
    setStatus(`已移动 ${data.moved || 0} 个素材`);
}
function openLocalItem(id){
    const item = findLocalItem(id);
    if(!item) return;
    const url = localObjectUrl(item);
    if(url) window.open(url, '_blank', 'noopener');
}
async function createPromptLibrary(){
     const name = window.prompt('提示词模板库名称', '新提示词模板库');
    if(!String(name || '').trim()) return;
    const data = await apiJson('/api/prompt-libraries', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    promptLibrary = data.library || promptLibrary;
    activePromptLibraryId = data.prompt_library?.id || activePromptLibraryId;
    activePromptCategory = 'all';
    selectedPromptId = '';
    render();
}
async function savePromptTreeEdit(){
    if(!promptTreeEdit) return;
    const name = document.getElementById('promptTreeEditInput')?.value || '';
    if(!String(name || '').trim()){
        setStatus('名称不能为空');
        return;
    }
    let data = null;
    if(promptTreeEdit.kind === 'library-new'){
        data = await apiJson('/api/prompt-libraries', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        promptLibrary = data.library || promptLibrary;
        activePromptLibraryId = data.prompt_library?.id || activePromptLibraryId;
        activePromptCategory = 'all';
        promptTreeFocus = 'library';
    } else if(promptTreeEdit.kind === 'library-rename'){
        const lib = activePromptLibrary();
        if(!lib) return;
        data = await apiJson(`/api/prompt-libraries/${encodeURIComponent(lib.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        promptLibrary = data.library || promptLibrary;
        promptTreeFocus = 'library';
    } else if(promptTreeEdit.kind === 'category-new'){
        const lib = activePromptLibrary();
        data = await apiJson('/api/prompt-libraries/categories', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:lib?.id || 'system', name})});
        promptLibrary = data.library || promptLibrary;
        activePromptCategory = data.category?.id || activePromptCategory;
        promptTreeFocus = 'category';
    } else if(promptTreeEdit.kind === 'category-rename'){
        data = await apiJson(`/api/prompt-libraries/categories/${encodeURIComponent(activePromptCategory)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
        promptLibrary = data.library || promptLibrary;
        promptTreeFocus = 'category';
    }
    promptTreeEdit = null;
    pendingTreeDelete = '';
    render();
    setStatus('已保存');
}
async function deletePromptCategory(){
    if(activePromptCategory === 'all'){
        setStatus('请选择具体分组后删除');
        return;
    }
    const key = `prompt-cat:${activePromptCategory}`;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        promptTreeEdit = null;
        render();
        setStatus('再次点击确认删除分组');
        return;
    }
    const data = await apiJson(`/api/prompt-libraries/categories/${encodeURIComponent(activePromptCategory)}`, {method:'DELETE'});
    promptLibrary = data.library || promptLibrary;
    activePromptCategory = 'all';
    pendingTreeDelete = '';
    render();
    setStatus('分组已删除');
}
async function renamePromptLibrary(){
    const lib = activePromptLibrary();
     const name = window.prompt('提示词模板库名称', lib?.name || '');
    if(!lib || !String(name || '').trim()) return;
    const data = await apiJson(`/api/prompt-libraries/${encodeURIComponent(lib.id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    promptLibrary = data.library || promptLibrary;
    render();
}
async function deletePromptLibrary(){
    const lib = activePromptLibrary();
    if(!lib) return;
     if(isSystemPromptLibrary(lib)){ setStatus('系统提示词模板库不能删除'); return; }
    const key = `prompt-lib:${lib.id}`;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        promptTreeEdit = null;
        render();
         setStatus('再次点击确认删除提示词模板库');
        return;
    }
    const data = await apiJson(`/api/prompt-libraries/${encodeURIComponent(lib.id)}`, {method:'DELETE'});
    promptLibrary = data.library || promptLibrary;
    activePromptLibraryId = promptLibrary.active_library_id || promptLibraries()[0]?.id || 'system';
    activePromptCategory = 'all';
    selectedPromptId = '';
    selectedPromptIds.clear();
    pendingTreeDelete = '';
    render();
     setStatus('提示词模板库已删除');
}
async function createPromptItem(){
    const lib = activePromptLibrary();
    if(!lib) return;
    const name = window.prompt('提示词名称', '新提示词');
    if(!String(name || '').trim()) return;
    const scene = window.prompt('用途说明', '') || '';
    const positive = window.prompt('正向提示词内容', '');
    if(!String(positive || '').trim()) return;
    const negative = window.prompt('负向提示词内容', '') || '';
    const category = activePromptCategory === 'all' ? 'custom' : activePromptCategory;
    const data = await apiJson('/api/prompt-libraries/items', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:lib.id, name, positive, negative, category, scene})});
    promptLibrary = data.library || promptLibrary;
    selectedPromptId = data.item?.id || selectedPromptId;
    render();
}
async function savePromptCreate(){
    const lib = activePromptLibrary();
    const name = document.getElementById('promptEditName')?.value || '';
    const scene = document.getElementById('promptEditScene')?.value || '';
    const positive = document.getElementById('promptEditPositive')?.value || '';
    const negative = document.getElementById('promptEditNegative')?.value || '';
    if(!lib) return;
    // 新建面板中不少用户会直接把完整提示词粘贴到“用途说明”。
    // 保留用途说明，同时把它作为缺省正向提示词提交，避免内容已经填写却无法保存。
    const promptText = String(positive || '').trim() || String(scene || '').trim();
    if(!String(name || '').trim() || !promptText){
        setStatus('请输入名称和提示词内容');
        return;
    }
    const category = activePromptCategory === 'all' ? 'custom' : activePromptCategory;
    const data = await apiJson('/api/prompt-libraries/items', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:lib.id, name, positive:promptText, negative, category, scene})});
    promptLibrary = data.library || promptLibrary;
    selectedPromptId = data.item?.id || selectedPromptId;
    promptCreateMode = false;
    render();
    setStatus('提示词已新增');
}
async function editPromptItem(id){
    const item = findPromptItem(id);
    const lib = activePromptLibrary();
    if(!item || !lib) return;
    const name = window.prompt('提示词名称', item.name || '');
    if(!String(name || '').trim()) return;
    const scene = window.prompt('用途说明', item.scene || '') || '';
    const positive = window.prompt('正向提示词内容', item.positive || '');
    if(!String(positive || '').trim()) return;
    const negative = window.prompt('负向提示词内容', item.negative || '') || '';
    const data = await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:lib.id, name, positive, negative, category:item.category || 'custom', scene})});
    promptLibrary = data.library || promptLibrary;
    selectedPromptId = id;
    render();
}
async function savePromptEdit(id){
    const item = findPromptItem(id);
    const lib = activePromptLibrary();
    const name = document.getElementById('promptEditName')?.value || '';
    const scene = document.getElementById('promptEditScene')?.value || '';
    const positive = document.getElementById('promptEditPositive')?.value || '';
    const negative = document.getElementById('promptEditNegative')?.value || '';
    if(!item || !lib) return;
    if(!String(name || '').trim() || !String(positive || '').trim()){
        setStatus('名称和正向提示词不能为空');
        return;
    }
    const data = await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:lib.id, name, positive, negative, category:item.category || 'custom', scene})});
    promptLibrary = data.library || promptLibrary;
    selectedPromptId = id;
    promptEditMode = false;
    render();
    setStatus('提示词已保存');
}
async function deletePromptItem(id){
    const item = findPromptItem(id);
    if(!item) return;
    const data = await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, {method:'DELETE'});
    promptLibrary = data.library || promptLibrary;
    selectedPromptIds.delete(id);
    if(selectedPromptId === id) selectedPromptId = '';
    pendingDeletePromptId = '';
    render();
    setStatus('提示词已删除');
}
async function deleteSelectedPrompts(){
    if(!selectedPromptIds.size) return;
    if(pendingBatchDelete !== 'prompt'){
        pendingBatchDelete = 'prompt';
        render();
        setStatus('再次点击确认删除所选提示词');
        return;
    }
    const ids = [...selectedPromptIds];
    const data = await apiJson('/api/prompt-libraries/items/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids})});
    promptLibrary = data.library || promptLibrary;
    if(ids.includes(selectedPromptId)) selectedPromptId = '';
    selectedPromptIds.clear();
    pendingBatchDelete = '';
    render();
}
root.addEventListener('pointerdown', event => {
    if(event.button !== 0) return;
    const target = managedSelectionTarget(event.target);
    if(!target) return;
    event.preventDefault();
    event.stopPropagation();
    applyManagedSelection(target.kind, target.id);
    managedSelectionPointerGuard = {...target, at:Date.now()};
    render();
}, true);
root.addEventListener('click', event => {
    handleClick(event).catch(err => setStatus(err.message || '操作失败'));
});
root.addEventListener('scroll', event => {
    if(activeTab !== 'assets' || uploadAssetsState.view !== 'disk' || event.target?.dataset?.uploadFileGrid === undefined) return;
    const grid = event.target;
    if(grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 260) loadUploadAssets({append:true}).catch(err => setStatus(err.message || '加载更多上传素材失败'));
}, true);
document.addEventListener('click', event => {
    const assetContextMenu = document.getElementById('assetContextMenu');
    if(assetContextMenu && !assetContextMenu.hidden && !assetContextMenu.contains(event.target)){
        assetContextMenu.hidden = true;
        assetContextMenuId = '';
    }
    // 案例详情抽屉与分类弹窗在 #assetManagerRoot 之外，也要走统一的点击分发
    if(event.target.closest?.('#promptCaseDrawer, #caseCategoryModal')){
        handleClick(event).catch(err => setStatus(err.message || '操作失败'));
        return;
    }
    if(event.target.closest?.('#storageSettingsOverlay')){
        handleClick(event).catch(err => setStatus(err.message || '操作失败'));
        return;
    }
    if(event.target.closest?.('.asset-lightbox') && !event.target.closest?.('.asset-lightbox-image,.asset-lightbox-video')) closeDetailPreview();
});
document.addEventListener('keydown', event => {
    const storageRootTarget = event.target?.closest?.('[data-storage-browse="root"]');
    if(storageRootTarget && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')){
        event.preventDefault();
        browseStorageFolder('root').catch(err => setStatus(err.message || '选择资产管理根目录失败'));
        return;
    }
    if(event.key === 'Escape') closeDetailPreview();
    if(event.target?.id === 'assetTreeEditInput'){
        if(event.key === 'Enter'){ event.preventDefault(); saveAssetTreeEdit().catch(err => setStatus(err.message || '保存失败')); }
        if(event.key === 'Escape'){ event.preventDefault(); assetTreeEdit = null; render(); }
    }
    if(event.target?.id === 'workflowTreeEditInput'){
        if(event.key === 'Enter'){ event.preventDefault(); saveWorkflowTreeEdit().catch(err => setStatus(err.message || '保存失败')); }
        if(event.key === 'Escape'){ event.preventDefault(); workflowTreeEdit = null; render(); }
    }
    if(event.target?.id === 'promptTreeEditInput'){
        if(event.key === 'Enter'){ event.preventDefault(); savePromptTreeEdit().catch(err => setStatus(err.message || '保存失败')); }
        if(event.key === 'Escape'){ event.preventDefault(); promptTreeEdit = null; render(); }
    }
    if(event.target?.id === 'localUploadFolderCreateInput'){
        if(event.key === 'Enter'){ event.preventDefault(); createLocalUploadFolder().catch(err => setStatus(err.message || '新建文件夹失败')); }
        if(event.key === 'Escape'){ event.preventDefault(); cancelCreateLocalUploadFolder(); }
    }
});
document.addEventListener('wheel', zoomDetailPreview, {passive:false});
document.addEventListener('pointerdown', beginLightboxPan);
document.addEventListener('pointermove', updateLightboxPan);
document.addEventListener('pointerup', endLightboxPan);
document.addEventListener('pointercancel', endLightboxPan);
root.addEventListener('pointerdown', beginMarqueeSelection);
root.addEventListener('contextmenu', event => {
    if(activeTab !== 'assets') return;
    const card = event.target.closest?.('[data-asset-card]');
    if(!card || assetManageMode) return;
    const id = card.dataset.assetCard || '';
    const item = findAssetItem(id);
    if(!id || !item || assetKind(item) !== 'image') return;
    const menu = document.getElementById('assetContextMenu');
    if(!menu) return;
    event.preventDefault();
    event.stopPropagation();
    assetContextMenuId = id;
    menu.dataset.assetId = id;
    menu.hidden = false;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin);
    menu.style.left = `${Math.min(Math.max(margin, event.clientX), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(margin, event.clientY), maxTop)}px`;
    menu.querySelector('button')?.focus({preventScroll:true});
});
root.addEventListener('pointerdown', event => {
    const menu = document.getElementById('assetContextMenu');
    if(!menu || menu.hidden || menu.contains(event.target)) return;
    menu.hidden = true;
    assetContextMenuId = '';
});
document.addEventListener('pointermove', event => updateMarqueeSelection(event));
document.addEventListener('pointerup', endMarqueeSelection);
root.addEventListener('compositionstart', event => {
    if(SEARCH_INPUT_IDS.has(event.target?.id || '')){
        searchCompositionActive = true;
        clearTimeout(searchRenderTimer);
    }
});
root.addEventListener('compositionend', event => {
    const id = event.target?.id || '';
    if(!SEARCH_INPUT_IDS.has(id)) return;
    searchCompositionActive = false;
    lastSearchCompositionEndAt = Date.now();
    updateSearchQueryFromInput(id, event.target.value || '');
    scheduleSearchRender(id, event.target.selectionStart || String(event.target.value || '').length, 0);
});
root.addEventListener('input', event => {
    const searchId = event.target?.id || '';
    if(SEARCH_INPUT_IDS.has(searchId)){
        updateSearchQueryFromInput(searchId, event.target.value || '');
        if(event.isComposing || searchCompositionActive) return;
        if(Date.now() - lastSearchCompositionEndAt < 40) return;
        scheduleSearchRender(searchId, event.target.selectionStart || 0);
        return;
    }
    if(event.target?.id === 'localCaptionPrompt'){
        localCaptionPrompt = event.target.value || '';
        writeLocalCaptionSettings();
    }
    if(event.target?.id === 'localClassifyPrompt'){
        localClassifyPrompt = event.target.value || '';
        writeLocalCaptionSettings();
    }
});
root.addEventListener('submit', event => {
    if(!event.target.matches('[data-space-form]')) return;
    event.preventDefault();
    imageSpaceReadFilterForm();
    imageSpaceRefresh().catch(err => setStatus(err.message || '筛选失败'));
});
root.addEventListener('change', event => {
    if(event.target.matches('[data-space-all]')){
        imageSpaceState.all[activeTab] = event.target.checked;
        imageSpaceRefresh().catch(err => setStatus(err.message || '筛选失败'));
        return;
    }

    const inlineLocalUploadName = event.target.closest?.('[data-localup-inline-name]');
    if(inlineLocalUploadName){
        saveLocalUploadInlineName(inlineLocalUploadName.dataset.localupInlineName || '', inlineLocalUploadName.value || '').catch(err => setStatus(err.message || '保存失败'));
        return;
    }
    const inlineAssetName = event.target.closest?.('[data-asset-inline-name]');
    if(inlineAssetName){
        saveAssetInlineName(inlineAssetName.dataset.assetInlineName || '', inlineAssetName.value || '').catch(err => setStatus(err.message || '保存失败'));
        return;
    }
    const inlineWorkflowName = event.target.closest?.('[data-workflow-inline-name]');
    if(inlineWorkflowName){
        apiJson(`/api/asset-library/items/${encodeURIComponent(inlineWorkflowName.dataset.workflowInlineName || '')}`, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name:inlineWorkflowName.value || ''})
        }).then(data => {
            assetLibrary = data.library || assetLibrary;
            render();
            setStatus('已保存工作流名称');
        }).catch(err => setStatus(err.message || '保存失败'));
        return;
    }
    if(event.target?.id === 'canvasAssetSort'){
        canvasAssetSort = event.target.value || 'canvas_asc';
        selectedCanvasAssetId = '';
        render();
    }
    if(event.target?.id === 'assetMoveTarget'){
        assetMoveTarget = event.target.value || '';
        pendingBatchDelete = '';
        render();
    }
    if(event.target?.id === 'localCaptionProvider'){
        localCaptionProvider = event.target.value || '';
        localCaptionModel = '';
        normalizeLocalCaptionSettings();
        writeLocalCaptionSettings();
        render();
    }
    if(event.target?.id === 'localCaptionModel'){
        localCaptionModel = event.target.value || '';
        writeLocalCaptionSettings();
        render();
    }
    const avatarProvider = event.target.closest?.('[data-avatar-provider]');
    if(avatarProvider){
        avatarRegisterProvider = avatarProvider.value || '';
        render();
    }
});
document.addEventListener('change', event => {
    if(!event.target?.closest?.('#storageSettingsOverlay')) return;
    if(event.target?.id === 'prefCaptionProvider'){
        localCaptionProvider = event.target.value || '';
        localCaptionModel = '';
        normalizeLocalCaptionSettings();
        renderStorageSettingsModal();
    }
    if(event.target?.id === 'prefCaptionModel'){
        localCaptionModel = event.target.value || '';
    }
});
root.addEventListener('dragstart', event => {
    if(activeTab === 'assets'){
        const category = event.target.closest?.('[data-asset-cat]');
        const libraryId = category?.dataset.assetCatLib || '';
        const categoryId = category?.dataset.assetCat || '';
        const source = assetCategoryForDrag(libraryId, categoryId);
        if(category && source && event.dataTransfer){
            const payload = {libraryId, categoryId, name:source.name || '', count:(source.items || []).length};
            assetCategoryDragState = payload;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(ASSET_CATEGORY_DRAG_TYPE, JSON.stringify(payload));
            event.dataTransfer.setData('text/plain', `${source.name || '素材分组'} · ${payload.count} 个素材`);
            category.classList.add('asset-category-dragging');
            return;
        }
    }
    if(activeTab !== 'workflows') return;
    const card = event.target.closest?.('[data-workflow-drag]');
    if(!card || !event.dataTransfer) return;
    const id = card.dataset.workflowDrag || '';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-xiaomei-workflow', id);
    event.dataTransfer.setData('text/plain', id);
    card.classList.add('workflow-dragging');
});
root.addEventListener('dragend', event => {
    assetCategoryDragState = null;
    event.target.closest?.('[data-asset-cat]')?.classList.remove('asset-category-dragging');
    clearAssetCategoryDropTargets();
    event.target.closest?.('[data-workflow-drag]')?.classList.remove('workflow-dragging');
    root.querySelectorAll('[data-workflow-cat].workflow-drop-target').forEach(node => node.classList.remove('workflow-drop-target'));
});
document.addEventListener('dragenter', event => {
    if(!isAssetCategoryDrag(event)) return;
    const target = assetCategoryDropTarget(event);
    if(!target) return;
    event.preventDefault();
    event.stopPropagation();
    // 打到顶部“本地素材”按钮时立即打开本地素材页，避免必须等 drop
    // 之后才切换导致用户看不到有效的投放目标。
    if(target.matches?.('[data-tab="local"]')) openLocalTabForAssetDrop(target);
    clearAssetCategoryDropTargets();
    target.classList.add('asset-category-drop-target');
}, true);
document.addEventListener('dragover', event => {
    if(!isAssetCategoryDrag(event)) return;
    const target = assetCategoryDropTarget(event);
    if(!target) return;
    if(target.matches?.('[data-tab="local"]')) openLocalTabForAssetDrop(target);
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearAssetCategoryDropTargets();
    target.classList.add('asset-category-drop-target');
}, true);
document.addEventListener('dragleave', event => {
    if(!isAssetCategoryDrag(event)) return;
    const target = assetCategoryDropTarget(event) || event.target.closest?.('[data-tab="local"], .asset-content');
    if(target && !target.contains(event.relatedTarget)) target.classList.remove('asset-category-drop-target');
}, true);
document.addEventListener('drop', event => {
    const payload = assetCategoryDragPayload(event);
    if(!payload) return;
    const target = assetCategoryDropTarget(event);
    if(!target) return;
    event.preventDefault();
    event.stopPropagation();
    clearAssetCategoryDropTargets();
    assetCategoryDragState = null;
    if(target.matches?.('[data-tab="local"]')){
        // 拖到顶部“本地素材”入口时，在本地素材根目录创建分组；拖到内容区时保留当前文件夹。
        activeLocalUploadFolder = '';
        activeLocalUploadClassFilter = '';
    } else if(target.matches?.('[data-localup-folder]')){
        // 拖到左侧树的具体文件夹时，以鼠标命中的文件夹为准；根目录的
        // data-localup-folder 为空字符串，不能继续沿用之前打开的子文件夹。
        activeLocalUploadFolder = target.dataset.localupFolder || '';
        activeLocalUploadClassFilter = '';
    }
    importAssetCategoryToLocal(payload);
}, true);
root.addEventListener('dragover', event => {
    if(activeTab !== 'workflows') return;
    const folder = event.target.closest?.('[data-workflow-cat]');
    if(!folder || !Array.from(event.dataTransfer?.types || []).includes('application/x-xiaomei-workflow')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('[data-workflow-cat].workflow-drop-target').forEach(node => { if(node !== folder) node.classList.remove('workflow-drop-target'); });
    folder.classList.add('workflow-drop-target');
});
root.addEventListener('dragleave', event => {
    const folder = event.target.closest?.('[data-workflow-cat]');
    if(folder && !folder.contains(event.relatedTarget)) folder.classList.remove('workflow-drop-target');
});
root.addEventListener('drop', event => {
    if(activeTab !== 'workflows') return;
    const folder = event.target.closest?.('[data-workflow-cat]');
    if(!folder || !Array.from(event.dataTransfer?.types || []).includes('application/x-xiaomei-workflow')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    folder.classList.remove('workflow-drop-target');
    const itemId = event.dataTransfer.getData('application/x-xiaomei-workflow') || event.dataTransfer.getData('text/plain');
    moveWorkflowToCategory(itemId, folder.dataset.workflowCatLib || activeWorkflowLibraryId, folder.dataset.workflowCat || '').catch(err => setStatus(err.message || '移动工作流失败'));
});
root.addEventListener('dragover', event => {
    const drop = event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop');
    if(!drop) return;
    event.preventDefault();
    drop.classList.add('drag-over');
});
root.addEventListener('dragleave', event => {
    event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop')?.classList.remove('drag-over');
});
root.addEventListener('drop', event => {
    const drop = event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop');
    if(!drop) return;
    event.preventDefault();
    drop.classList.remove('drag-over');
    if(drop.id === 'localUploadDrop') uploadLocalAssets(event.dataTransfer.files);
    else if(drop.id === 'workflowDrop') uploadWorkflowFiles(event.dataTransfer.files).catch(err => setStatus(err.message || '上传失败'));
    else uploadFiles(event.dataTransfer.files).catch(err => setStatus(err.message || '上传失败'));
});
uploadInput?.addEventListener('change', event => {
    const files = event.target.files;
    if(files?.length){
        if(activeTab === 'local') uploadLocalAssets(files);
        else if(activeTab === 'workflows') uploadWorkflowFiles(files).catch(err => setStatus(err.message || '上传失败'));
        else uploadFiles(files).catch(err => setStatus(err.message || '上传失败'));
    }
    event.target.value = '';
});
document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
        imageSpaceState.collectionId = '';
        clearCanvasAssetScope();
        activeTab = btn.dataset.tab || 'assets';
        selectedAssetIds.clear();
        selectedWorkflowIds.clear();
        selectedPromptIds.clear();
        selectedLocalIds.clear();
        selectedLocalUploadIds.clear();
        selectedCanvasAssetIds.clear();
        generatedAssetsState.selectedIds.clear();
        render();
        if(activeTab === 'generated' && !generatedAssetsState.loaded){
            try { await loadGeneratedAssets(); }
            catch(err){ setStatus(err.message || '加载生成素材失败'); }
        }
    });
});
refreshBtn?.addEventListener('click', () => {
    const task = isCanvasAssetView() ? refreshCanvasAssets() : activeTab === 'generated' ? loadGeneratedAssets() : loadAll();
    task.catch(err => setStatus(err.message || '加载失败'));
});
storageSettingsBtn?.addEventListener('click', () => openStorageSettings({tab:'manage'}).catch(err => setStatus(err.message || '打开资产管理设置失败')));
root.addEventListener('change', event => {
    if(event.target?.id === 'hubSortSelect'){
        hubSort = event.target.value || 'recent';
        render();
    }
});
window.addEventListener('keydown', event => {
    if(event.key !== 'Escape') return;
    if(hubCaseDrawerOpen){ closePromptCaseDrawer(); return; }
    if(caseCategoryModalOpen){ closeCaseCategoryModal(); return; }
});
window.addEventListener('resize', syncPromptCaseOverlays);
window.addEventListener('scroll', syncPromptCaseOverlays, {passive:true});
window.addEventListener('studio-ui-scale-change', syncPromptCaseOverlays);
window.addEventListener('message', event => {
    if(event.origin && event.origin !== location.origin) return;
    if(event.data?.type === 'studio-theme') window.StudioTheme?.apply?.(event.data.theme);
    if(event.data?.type === 'open-storage-settings'){
        openStorageSettings({tab:event.data.tab || 'manage'}).catch(err => setStatus(err.message || '打开资产管理设置失败'));
    }
    if(event.data?.type === 'launcher-focus' && event.data.focus === 'workflows'){
        activeTab = 'workflows';
        workflowFavoritesOnly = false;
        render();
    }
    // 小美画布收藏案例后跳转过来：切换到资产管理·提示词并打开对应案例
    if(event.data?.type === 'prompt-case-open' && event.data.case_id){
        activeTab = 'prompt-hub';
        hubView = 'cases';
        hubCaseCategory = '';
        render();
        loadPromptCases().then(() => openPromptCase(event.data.case_id));
    }
});
try {
    const promptCaseChannel = new BroadcastChannel('studio-prompt-cases');
    promptCaseChannel.onmessage = event => {
        if(event.data?.type === 'prompt-cases-updated') loadPromptCases();
    };
} catch(err) { /* optional */ }
document.addEventListener('DOMContentLoaded', () => loadAll().catch(err => setStatus(err.message || '加载失败')));
