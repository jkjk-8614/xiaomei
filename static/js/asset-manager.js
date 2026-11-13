const root = document.getElementById('assetManagerRoot');
const catalogView = XiaomeiAssetManagerCatalogs.createView(root);
const catalogWriter = XiaomeiAssetManagerCatalogs.createWriter(apiJson);
const promptTemplates = XiaomeiAssetManagerPrompts.create({
    root, request:apiJson, notice:setStatus, redraw:render, icons:refreshIcons,
    origin:promptPageScope, saved:applyPromptSave, removed:applyPromptRemoval, favored:applyPromptFavorite,
});
const statusEl = document.getElementById('assetStatus');
const refreshBtn = document.getElementById('refreshBtn');
const storageSettingsBtn = document.getElementById('storageSettingsBtn');
const assetMedia = XiaomeiAssetManagerMedia.create({notice:setStatus, icons:refreshIcons});
const avatarReviews = XiaomeiAssetManagerAvatar.create({
    request:apiJson, providers:() => apiProviders, find:findAssetDetailRecord,
    visible:isAssetDetailVisible, redraw:render, notice:setStatus, copyText:assetMedia.copyText,
});
const assetDetail = XiaomeiAssetManagerDetail.create({
    request:apiJson, resolve:findAssetDetailRecord, visible:isAssetDetailVisible, redraw:render, notice:setStatus,
    thumbnail:assetThumb, kind:assetKind, label:assetKindLabel, date:formatDate,
    classification:renderImageSpaceClassification, avatar:(...args) => avatarReviews.section(...args),
});
const workflows = XiaomeiAssetManagerWorkflows.create({
    request:apiJson, media:assetMedia, download:downloadUrl, notice:setStatus, redraw:render,
    scope:() => catalogScope('workflow'), visible:owner => catalogIsCurrent('workflow', owner),
    categories:workflowCategories, apply:reply => applyCatalogReply('workflow', reply), date:formatDate,
    select(owner, id){
        activeWorkflowLibraryId = owner.libraryId;
        activeWorkflowCategoryId = owner.categoryId;
        selectedWorkflowId = id;
        selectedWorkflowIds.clear();
    },
    remove(ids){
        for(const id of ids) selectedWorkflowIds.delete(id);
        if(ids.includes(selectedWorkflowId)) selectedWorkflowId = '';
    },
});
const marquee = XiaomeiAssetManagerInteractions.bindMarquee(root, marqueeScope, () => {
    if(activeTab === 'prompts') promptTemplates.clearConfirmation();
    pendingBatchDelete = '';
    render();
});
const annotations = XiaomeiAssetManagerAnnotations.create({
    request: apiJson,
    notice: setStatus,
    redraw: redrawAnnotations,
    providers: () => apiProviders,
    records: annotationRecords,
    refreshFiltered: refreshAnnotationFilters,
    isImage: item => assetKind(item) === 'image',
    copy: assetMedia.copyText,
});
const localFiles = XiaomeiAssetManagerLocalFiles.create({
    root, request:apiJson, notice:setStatus, redraw:render, find:findLocalUpload,
    tree:() => localUploadTree, scope:localFileScope, isCurrent:isLocalFileScopeCurrent,
    selection:() => selectedLocalUploadIds, selected:() => selectedLocalUploadId,
    select:id => { selectedLocalUploadId = id; }, selectFolder:applyLocalFolder,
    snapshot:applyLocalFileSnapshot, read:load => annotations.readFiles('local', load),
    readFailed:error => { if(activeTab === 'local') setStatus(error.message || '读取本地素材失败'); },
    favorites:loadFileFavorites, icons:refreshIcons, isMedia:isLocalMediaFile,
    focusFolder:() => focusTreeEditInput('localUploadFolderCreateInput'),
});
const localView = XiaomeiAssetManagerLocalView.create({
    source:() => localAssets, canvasSource:() => canvasAssetsData,
    folderAt:XiaomeiAssetManagerLocalFiles.folderAt, branch:renderAssetNavBranch,
    mediaTree:renderMaterialMediaTree, projectTree:renderMaterialProjectTree, matches:imageSpaceMatches,
    kind:assetKind, label:assetKindLabel, size:formatFileSize, date:formatDate, thumbnail:assetThumb,
    favorite:item => isFileFavorite('local', item), classification:renderImageSpaceClassification,
    annotation:item => annotations.detail('local', item),
});
const assetTransfers = XiaomeiAssetManagerTransfers.create({
    request:apiJson, redraw:render, notice:setStatus, scope:assetTransferScope, records:assetTransferRecords,
    selection:() => selectedAssetIds,
    clearSelection(){ selectedAssetIds.clear(); pendingBatchDelete = ''; },
    removeSelection(ids){
        for(const id of ids) selectedAssetIds.delete(id);
        if(ids.includes(selectedAssetId)) selectedAssetId = '';
        if(ids.includes(pendingDeleteAssetId)) pendingDeleteAssetId = '';
    },
    isCurrent:owner => catalogIsCurrent('asset', owner),
    apply:reply => applyCatalogReply('asset', reply),
});
const canvasProjects = XiaomeiAssetCanvasProjects.create({
    source:() => canvasAssetsData, thumbnail:assetThumb, kind:assetKind,
    label:assetKindLabel, date:formatDate, branch:renderAssetNavBranch,
});
const storageSettings = XiaomeiAssetManagerStorage.create({
    request: apiJson,
    notice: setStatus,
    thumbnail: assetThumb,
    kindLabel: assetKindLabel,
    fileSize: formatFileSize,
    icons: refreshIcons,
    videoThumbs: prepareVideoThumbs,
    captionSettings: annotations.captionSettings,
    saveCaptionSettings: annotations.saveCaptionSettings,
});
const uploadInput = document.getElementById('assetUploadInput');

let activeTab = 'assets';
let skillManagerOpen = false;
let assetLibrary = {libraries:[], categories:[]};
let promptLibrary = {libraries:[]};
let promptLibraryRevision = 0;
let apiProviders = [];
let activeAssetLibraryId = '';
let activeAssetCategoryId = '';
let activeWorkflowLibraryId = '';
let activeWorkflowCategoryId = '';
let activePromptLibraryId = '';
let activePromptCategory = 'all';
let assetTreeFocus = 'category';
let promptTreeFocus = 'category';
let selectedAssetId = '';
let selectedWorkflowId = '';
let selectedPromptId = '';
let selectedPromptLibraryId = '';
let selectedAssetIds = new Set();
let selectedWorkflowIds = new Set();
let selectedPromptIds = new Set();
let assetQuery = '';
let workflowQuery = '';
let promptQuery = '';
let assetManageMode = false;
let workflowManageMode = false;
let promptManageMode = false;
let pendingDeleteAssetId = '';
let pendingBatchDelete = '';
let assetTreeEdit = null;
let workflowTreeEdit = null;
let promptTreeEdit = null;
let pendingTreeDelete = '';
let localAssets = [];
let localAssetsLoaded = false;
let localUploadTree = null;
let activeLocalUploadFolder = '';
let localUploadProjectId = '';
let localUploadCanvasId = '';
let selectedLocalUploadId = '';
let selectedLocalUploadIds = new Set();
let localUploadQuery = '';
let localUploadMediaType = 'all';
let localUploadManageMode = false;
let localUploadFolderDragPath = '';
let localUploadCardDragIds = [];
let backgroundRemovalBusy = false;
let assetCategoryLocalImportBusy = false;
let assetContextMenuId = '';
let assetUploadBusy = false;
let uploadAssetsState = {view:'disk', items:[], projects:[], canvases:[], folders:[], mediaCounts:{image:0,video:0,audio:0}, unassigned_count:0, loading:false, loadingMore:false, hasMore:false, offset:0, total:0, allTotal:0, query:'', projectId:'', canvasId:'', folder:'', mediaType:'all', selectedId:'', selectedIds:new Set(), manageMode:false, favoritesOnly:false, loaded:false, pageSize:120, requestId:0, reloadPending:false, error:''};
let storageFileClipboards = {upload:null, generated:null};
let storageFileFolderDrag = null;
let storageFileCardDrag = null;
let canvasAssetsData = {categories:[], projects:[], canvases:[], items:[]};
let canvasAssetsRequestId = 0;
let activeCanvasAssetProjectId = '';
let activeCanvasAssetCanvasId = '';
let selectedCanvasAssetId = '';
let selectedCanvasAssetIds = new Set();
let canvasAssetQuery = '';
let canvasAssetSort = 'canvas_asc';
let canvasAssetManageMode = false;
let generatedManageMode = false;
let generatedAssetsState = {items:[], folders:[], selectedId:'', selectedIds:new Set(), query:'', folder:'', mediaType:'all', mediaCounts:{image:0,video:0,audio:0}, allTotal:0, loading:false, loadingMore:false, loaded:false, offset:0, total:0, hasMore:false, pageSize:80, restoreScrollTop:null};
const GENERATED_PROJECTS_COLLAPSED_KEY = 'asset_manager_generated_projects_collapsed_v1';
function readGeneratedProjectsCollapsed(){
    try { return localStorage.getItem(GENERATED_PROJECTS_COLLAPSED_KEY) === '1'; } catch(_) { return false; }
}
let generatedProjectsCollapsed = readGeneratedProjectsCollapsed();
const videoThumbPosterCache = new Map();
let searchCompositionActive = false;
let searchRenderTimer = null;
let lastSearchCompositionEndAt = 0;
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
const LOCAL_MEDIA_EXTS = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|mp3|wav|flac|ogg|m4a|aac)(\?|#|$)/i;
const ASSET_CATEGORY_DRAG_TYPE = 'application/x-xiaomei-asset-category';
let assetCategoryDragState = null;
const SEARCH_INPUT_IDS = new Set(['assetSearch','workflowSearch','promptSearch','hubSearch','localUploadSearch','canvasAssetSearch','generatedSearch']);

function refreshIcons(){ if(window.lucide) lucide.createIcons(); }
function setStatus(text='准备就绪'){
    if(statusEl) statusEl.textContent = text || '准备就绪';
}
function escapeHtml(value=''){
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function escapeAttr(value=''){ return escapeHtml(value); }
async function apiJson(url, options={}){
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if(!res.ok){
        const error = new Error(data.detail || data.message || '操作失败');
        error.status = res.status;
        throw error;
    }
    return data;
}
const IMAGE_SPACE_TABS = new Set(['assets','generated','local']);
function syncImageSpaceSubtabs(){
    const subTabs = document.getElementById('imageSpaceSubtabs');
    if(!subTabs) return;
    const inSpace = IMAGE_SPACE_TABS.has(activeTab);
    subTabs.hidden = !inSpace;
    subTabs.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
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
    const redraw = options.background !== true;
    if(uploadAssetsState.loading || uploadAssetsState.loadingMore){
        if(!append) uploadAssetsState.reloadPending = true;
        return;
    }
    if(append && !uploadAssetsState.hasMore) return;
    const grid = document.querySelector('[data-upload-file-grid]');
    const keepScrollTop = append && grid ? grid.scrollTop : null;
    const requestId = ++uploadAssetsState.requestId;
    const scopeSnapshot = {projectId:uploadAssetsState.projectId || '', canvasId:uploadAssetsState.canvasId || '', folder:uploadAssetsState.folder || '', mediaType:uploadAssetsState.mediaType || 'all', favoritesOnly:uploadAssetsState.favoritesOnly, query:uploadAssetsState.query || ''};
    if(append) uploadAssetsState.loadingMore = true;
    else { uploadAssetsState.loading = true; uploadAssetsState.items = []; uploadAssetsState.offset = 0; uploadAssetsState.total = 0; uploadAssetsState.hasMore = false; }
    if(redraw && activeTab === 'assets') render();
    try {
        const offset = append ? uploadAssetsState.offset : 0;
        const allScope = imageSpaceState.all.upload;
        const query = new URLSearchParams({kind:'upload', offset:String(offset), limit:String(uploadAssetsState.pageSize || 120), project_id:allScope ? '' : scopeSnapshot.projectId, canvas_id:allScope ? '' : scopeSnapshot.canvasId, folder:allScope ? '' : scopeSnapshot.folder});
        if(scopeSnapshot.mediaType !== 'all') query.set('media_type', scopeSnapshot.mediaType);
        if(scopeSnapshot.favoritesOnly) query.set('favorites', JSON.stringify([...fileFavoriteMap.values()].filter(entry => entry.kind === 'upload').map(entry => entry.key.slice('upload:'.length))));
        const filters = {...imageSpaceState.filters.upload, query:scopeSnapshot.query};
        if(Object.keys(filters).some(key => filters[key])) query.set('filters', JSON.stringify(filters));
        const data = await annotations.readFiles('upload', () => apiJson(`/api/storage-files?${query.toString()}`));
        const items = Array.isArray(data.items) ? data.items : [];
        // Ignore a slower response after the user changed project, canvas or search.
        if(requestId !== uploadAssetsState.requestId || scopeSnapshot.projectId !== (uploadAssetsState.projectId || '') || scopeSnapshot.canvasId !== (uploadAssetsState.canvasId || '') || scopeSnapshot.folder !== (uploadAssetsState.folder || '') || scopeSnapshot.mediaType !== (uploadAssetsState.mediaType || 'all') || scopeSnapshot.favoritesOnly !== uploadAssetsState.favoritesOnly || scopeSnapshot.query !== (uploadAssetsState.query || '')) return;
        uploadAssetsState.items = append ? [...uploadAssetsState.items, ...items] : items;
        uploadAssetsState.offset = offset + items.length;
        uploadAssetsState.total = Number(data.total || 0);
        uploadAssetsState.allTotal = Number(data.all_total || 0);
        uploadAssetsState.hasMore = Boolean(data.has_more);
        uploadAssetsState.folders = Array.isArray(data.folders) ? data.folders : [];
        uploadAssetsState.mediaCounts = data.media_counts || {image:0,video:0,audio:0};
        uploadAssetsState.projects = Array.isArray(data.projects) ? data.projects : [];
        uploadAssetsState.canvases = Array.isArray(data.canvases) ? data.canvases : [];
        uploadAssetsState.unassigned_count = Number(data.unassigned_count || 0);
        uploadAssetsState.loaded = true;
        uploadAssetsState.error = '';
        uploadAssetsState.selectedIds = new Set([...uploadAssetsState.selectedIds].filter(id => uploadAssetsState.items.some(item => item.id === id)));
        if(uploadAssetsState.selectedId && !findUploadAsset(uploadAssetsState.selectedId)) uploadAssetsState.selectedId = '';
        if(!uploadAssetsState.selectedId && items.length) uploadAssetsState.selectedId = items[0].id;
    } catch(err) {
        if(requestId === uploadAssetsState.requestId) uploadAssetsState.error = err?.message || '读取上传素材失败';
        throw err;
    } finally {
        uploadAssetsState.loading = false; uploadAssetsState.loadingMore = false;
        if(uploadAssetsState.reloadPending){
            uploadAssetsState.reloadPending = false;
            await loadUploadAssets();
        } else if(redraw && activeTab === 'assets' && uploadAssetsState.view === 'disk'){
            render();
            const next = document.querySelector('[data-upload-file-grid]');
            if(next && keepScrollTop !== null) next.scrollTop = keepScrollTop;
        }
    }
}
function uploadAssetProjectTree(){
    const projects = uploadAssetsState.projects || [];
    return [{id:'', name:'全部上传', count:uploadAssetsState.allTotal}, ...projects.map(item => ({...item, count:Number(item.count || 0)})), {id:'__unassigned__', name:'未归属项目', count:uploadAssetsState.unassigned_count}];
}
const assetNavExpanded = new Map();
function renderAssetNavBranch(key, label, row, children, defaultExpanded=true){
    if(!children) return row;
    const expanded = assetNavExpanded.get(key) ?? defaultExpanded;
    const childrenId = `asset-nav-${encodeURIComponent(key)}`;
    const action = `${expanded ? '收起' : '展开'}${label}`;
    const doubleClick = key === 'upload:media' || key === 'upload:projects';
    return `<div class="tree-branch asset-nav-branch" data-nav-branch="${escapeAttr(key)}">
        <div class="asset-nav-branch-head"><button class="asset-nav-toggle" type="button" data-nav-toggle="${escapeAttr(key)}" data-nav-label="${escapeAttr(label)}" ${doubleClick ? 'data-nav-double-click' : ''} aria-expanded="${expanded}" aria-controls="${escapeAttr(childrenId)}" aria-label="${escapeAttr(action)}" title="${escapeAttr(doubleClick ? `双击${action}` : action)}"><i data-lucide="chevron-down"></i></button>${row}</div>
        <div class="tree-children asset-nav-children" id="${escapeAttr(childrenId)}" ${expanded ? '' : 'hidden'}>${children}</div>
    </div>`;
}
function setAssetNavExpanded(button, expanded){
    assetNavExpanded.set(button.dataset.navToggle, expanded);
    button.setAttribute('aria-expanded', String(expanded));
    const label = `${expanded ? '收起' : '展开'}${button.dataset.navLabel}`;
    button.setAttribute('aria-label', label);
    button.title = button.hasAttribute('data-nav-double-click') ? `双击${label}` : label;
    document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
}
function renderMaterialMediaTree(kind, channels, activeType){
    const attr = kind === 'upload' ? 'upload' : 'localup';
    const rows = channels.map(([type,label,icon,count]) => `<button class="tree-row ${type === 'all' ? 'tree-parent' : 'tree-child'} ${activeType === type ? 'active' : ''}" type="button" data-${attr}-type="${type}"><span class="tree-row-icon"><i data-lucide="${icon}"></i></span><span class="tree-row-name">${label}</span><span class="tree-row-count">${count || 0}</span></button>`);
    return renderAssetNavBranch(`${kind}:media`, channels[0][1], rows[0], rows.slice(1).join(''));
}
function renderMaterialProjectTree(kind, projects, canvases, projectId, canvasId){
    const attr = kind === 'upload' ? 'upload' : 'localup';
    const rows = projects.map(project => {
        const row = `<button class="tree-row tree-parent ${projectId === project.id && !canvasId ? 'active' : ''}" type="button" data-${attr}-project="${escapeAttr(project.id)}"><span class="tree-row-icon"><i data-lucide="${project.id ? 'folder' : 'images'}"></i></span><span class="tree-row-name">${escapeHtml(project.name)}</span><span class="tree-row-count">${project.count || 0}</span></button>`;
        if(!project.id) return row;
        const children = canvases.filter(canvas => canvas.project === project.id).map(canvas => `<button class="tree-row tree-child ${projectId === project.id && canvasId === canvas.id ? 'active' : ''}" type="button" data-${attr}-canvas="${escapeAttr(canvas.id)}" data-material-project="${escapeAttr(project.id)}"><span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="layers"></i></span><span class="tree-row-name">${escapeHtml(canvas.title || '未命名画布')}</span><span class="tree-row-count">${canvas.count || 0}</span></button>`).join('');
        return renderAssetNavBranch(`${kind}:project:${project.id}`, project.name, row, children, projectId === project.id);
    });
    return renderAssetNavBranch(`${kind}:projects`, projects[0].name, rows[0], rows.slice(1).join(''));
}
function storageFileState(kind){ return kind === 'upload' ? uploadAssetsState : generatedAssetsState; }
function storageFileSelectedItems(kind){
    const state = storageFileState(kind);
    return state.items.filter(item => state.selectedIds.has(item.id));
}
function renderStorageFileManageTools(kind, visibleItems){
    const state = storageFileState(kind), selected = storageFileSelectedItems(kind);
    const imageCount = selected.filter(item => assetKind(item) === 'image').length;
    return `<div class="manage-tools storage-file-manage-tools">
        <div class="manage-group manage-select-group"><span class="manage-group-title">管理</span><span class="manage-summary">已选 ${selected.length} 个，其中 ${imageCount} 张图片</span>
            <div class="asset-tools"><button class="asset-btn" type="button" data-space-file-select-all ${visibleItems.length ? '' : 'disabled'}><i data-lucide="check-square"></i><span>全选</span></button>
            <button class="asset-btn" type="button" data-space-file-clear ${selected.length ? '' : 'disabled'}><i data-lucide="square"></i><span>清空</span></button>
            <button class="asset-btn" type="button" data-space-file-download ${selected.length ? '' : 'disabled'}><i data-lucide="download"></i><span>下载所选</span></button>
            <button class="asset-btn" type="button" data-space-file-canvas ${selected.length ? '' : 'disabled'}><i data-lucide="clipboard-paste"></i><span>复制到画布</span></button>
            <button class="asset-btn" type="button" data-space-file-import ${imageCount ? '' : 'disabled'}><i data-lucide="folder-input"></i><span>加入图片资产库</span></button>
            <button class="asset-btn" type="button" data-space-file-cut ${selected.length ? '' : 'disabled'}><i data-lucide="scissors"></i><span>剪切/移动</span></button>
            <button class="asset-btn" type="button" data-space-file-move ${selected.length ? '' : 'disabled'}><i data-lucide="folder-input"></i><span>移动</span></button>
            <button class="asset-btn danger" type="button" data-space-file-delete ${selected.length ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>移入回收站</span></button></div></div>
        <div class="manage-group manage-ai-group"><span class="manage-group-title">AI 处理</span>${annotations.toolbar(imageCount, kind)}
            <button class="asset-btn" type="button" data-space-file-background ${imageCount && !backgroundRemovalBusy ? '' : 'disabled'}><i data-lucide="eraser"></i><span>去背景</span></button></div>
    </div>`;
}
function renderStorageFileClipboardBar(kind){
    const clipboard = storageFileClipboards[kind];
    if(!clipboard?.rels?.length) return '';
    const folder = storageFileState(kind).folder || '';
    const sameFolder = clipboard.folders.every(value => value === folder);
    return `<div class="asset-clipboard-bar"><div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span>已剪切 ${clipboard.rels.length} 个素材</span></div>
        <div class="asset-tools"><button class="asset-btn primary" type="button" data-space-file-paste ${sameFolder ? 'disabled' : ''}><i data-lucide="clipboard-paste"></i><span>${sameFolder ? '切到其他文件夹后移动' : `移动到「${escapeHtml(folder || '根目录')}」`}</span></button>
        <button class="asset-icon-btn" type="button" data-space-file-cut-clear title="取消剪切"><i data-lucide="x"></i></button></div></div>`;
}
function renderStorageFileFolders(kind){
    const state = storageFileState(kind);
    const folders = state.folders || [];
    const paths = new Set(folders.map(folder => folder.path));
    const renderFolder = folder => {
        const row = `<button class="tree-row tree-child ${state.folder === folder.path ? 'active' : ''}" type="button" data-space-folder="${escapeAttr(folder.path)}" draggable="true" title="拖动素材到此文件夹可移动；拖动文件夹可调整同级顺序"><span class="tree-row-icon"><i data-lucide="folder"></i></span><span class="tree-row-name">${escapeHtml(folder.name)}</span><span class="tree-row-count">${folder.count || 0}</span></button>`;
        const children = folders.filter(child => storageFolderParentPath(child.path) === folder.path).map(renderFolder).join('');
        return renderAssetNavBranch(`${kind}:folder:${folder.path}`, folder.name, row, children);
    };
    const folderRows = folders.filter(folder => !paths.has(storageFolderParentPath(folder.path))).map(renderFolder).join('');
    return `<div class="storage-folder-section"><div class="generated-projects-toggle"><span>按文件夹</span><div class="panel-actions compact-actions">
        <button class="asset-icon-btn" type="button" data-space-folder-new="${kind}" title="新建文件夹"><i data-lucide="folder-plus"></i></button>
        <button class="asset-icon-btn" type="button" data-space-folder-rename="${kind}" title="重命名当前文件夹" ${state.folder ? '' : 'disabled'}><i data-lucide="pencil"></i></button>
        <button class="asset-icon-btn danger" type="button" data-space-folder-delete="${kind}" title="将当前文件夹移入回收站" ${state.folder ? '' : 'disabled'}><i data-lucide="trash-2"></i></button></div></div>
        ${renderAssetNavBranch(`${kind}:folders`, '全部文件夹', `<button class="tree-row tree-parent ${!state.folder && kind === 'generated' ? 'active' : ''}" type="button" data-space-folder=""><span class="tree-row-icon"><i data-lucide="folder-open"></i></span><span class="tree-row-name">全部文件夹</span></button>`, folderRows)}</div>`;
}
function renderStorageFileCard(kind, item){
    const state = storageFileState(kind), upload = kind === 'upload';
    const refs = Array.isArray(item.references) ? item.references : [];
    const location = upload ? (refs.length ? [...new Set(refs.map(ref => uploadAssetProjectName(ref.project_id)))].join('、') : item.upload_project_id ? uploadAssetProjectName(item.upload_project_id) : '未归属项目') : (item.folder || '生成目录');
    return `<article class="asset-card ${upload ? '' : 'generated-asset-card'} ${state.selectedId === item.id ? 'active' : ''} ${state.selectedIds.has(item.id) ? 'selected' : ''}" data-space-file-card="${escapeAttr(item.id)}" data-${upload ? 'upload' : 'generated'}-card="${escapeAttr(item.id)}" draggable="true" title="拖动到左侧文件夹可移动">
        <input class="asset-card-check" type="checkbox" data-space-file-check="${escapeAttr(item.id)}" ${state.selectedIds.has(item.id) ? 'checked' : ''} aria-label="选择 ${escapeAttr(item.name)}">
        <button class="asset-thumb generated-asset-preview" type="button" data-space-file-preview="${escapeAttr(item.id)}" title="预览">${assetThumb(item)}${assetKind(item) === 'video' ? '<span class="asset-kind-badge generated-kind-badge"><i data-lucide="play"></i></span>' : ''}</button>
        <button class="asset-card-quick asset-card-fav ${isFileFavorite(kind, item) ? 'is-fav' : ''}" type="button" data-space-file-favorite="${escapeAttr(item.id)}" title="${isFileFavorite(kind, item) ? '取消收藏' : '收藏'}"><i data-lucide="star"></i></button>
        <div class="asset-card-body"><div class="asset-card-name" title="${escapeAttr(item.name || '')}">${escapeHtml(item.name || '素材')}</div>
            <div class="asset-card-meta">${escapeHtml(assetKindLabel(item))} · ${escapeHtml(formatFileSize(item.size))}</div>
            <div class="asset-card-meta" title="${escapeAttr(location)}">${escapeHtml(location)}</div>
            <div class="asset-card-actions"><button type="button" data-space-file-preview="${escapeAttr(item.id)}"><i data-lucide="maximize-2"></i><span>预览</span></button>
            <button type="button" data-space-file-download-one="${escapeAttr(item.id)}"><i data-lucide="download"></i><span>下载</span></button></div></div></article>`;
}
function renderStorageFileDetail(kind, item){
    if(!item) return `<div class="panel-head"><div class="panel-title"><strong>素材详情</strong><span>选择一个素材查看</span></div></div><div class="detail-scroll"><div class="detail-empty"><i data-lucide="image"></i><span>暂无可预览素材</span></div></div>`;
    const refs = kind === 'upload' && Array.isArray(item.references) ? item.references : [];
    const labels = [...new Set(refs.map(ref => `${uploadAssetProjectName(ref.project_id)}${ref.canvas_title ? ` · ${ref.canvas_title}` : ''}`))];
    return `<div class="panel-head"><div class="panel-title"><strong>素材详情</strong><span>${escapeHtml(assetKindLabel(item))}</span></div>
        <div class="panel-actions"><button class="asset-icon-btn" type="button" data-space-file-rename="${escapeAttr(item.id)}" title="重命名"><i data-lucide="pencil"></i></button>
        <button class="asset-icon-btn" type="button" data-space-file-move-one="${escapeAttr(item.id)}" title="移动到文件夹"><i data-lucide="folder-input"></i></button>
        <button class="asset-icon-btn" type="button" data-space-file-download-one="${escapeAttr(item.id)}" title="下载"><i data-lucide="download"></i></button>
        <button class="asset-icon-btn danger" type="button" data-space-file-delete-one="${escapeAttr(item.id)}" title="移入回收站"><i data-lucide="trash-2"></i></button></div></div>
        <div class="detail-scroll"><div class="detail-media">${assetKind(item) === 'audio' ? `<audio controls preload="metadata" src="${escapeAttr(item.url)}"></audio>` : `<button class="detail-media-frame detail-media-zoomable" type="button" data-space-file-preview="${escapeAttr(item.id)}" title="点击放大预览">${assetThumb(item)}</button>`}</div>
        <div class="detail-body"><input class="detail-name-input" data-space-file-inline-name="${escapeAttr(item.id)}" type="text" value="${escapeAttr(item.name || '')}" title="直接修改名称">
            <div class="detail-meta-grid"><div class="detail-meta"><span>类型</span><strong>${escapeHtml(assetKindLabel(item))}</strong></div>
            <div class="detail-meta"><span>大小</span><strong>${escapeHtml(formatFileSize(item.size))}</strong></div>
            <div class="detail-meta"><span>修改时间</span><strong>${escapeHtml(formatDate(Number(item.created_at || 0) * 1000))}</strong></div>
            <div class="detail-meta"><span>文件夹</span><strong>${escapeHtml(item.folder || '根目录')}</strong></div></div>
            <div class="detail-url">${escapeHtml(item.url || '')}</div>
            ${assetKind(item) === 'image' ? renderImageSpaceClassification(item) + annotations.detail(kind, item) : ''}
            ${labels.length ? `<div class="detail-caption-card"><div class="detail-caption-head"><strong>关联画布</strong></div><div class="detail-classification-body">${labels.map(label => `<span class="classification-chip">${escapeHtml(label)}</span>`).join('')}</div></div>` : ''}</div></div>`;
}
function renderUploadManager(){
    const items = uploadAssetsState.items || [];
    const detail = findUploadAsset(uploadAssetsState.selectedId) || items[0] || null;
    const tree = uploadAssetProjectTree();
    const project = uploadAssetsState.projectId ? (uploadAssetsState.canvasId ? (uploadAssetsState.canvases || []).find(c => c.id === uploadAssetsState.canvasId)?.title || '画布素材' : uploadAssetProjectName(uploadAssetsState.projectId)) : '全部上传';
    const body = uploadAssetsState.error ? `<div class="empty-state" role="alert"><i data-lucide="triangle-alert"></i><strong>上传素材读取失败</strong><span>${escapeHtml(uploadAssetsState.error)}</span><button class="asset-btn primary" type="button" data-upload-retry><i data-lucide="refresh-cw"></i><span>重新读取</span></button></div>` : (uploadAssetsState.loading ? '<div class="storage-empty">正在读取上传素材目录...</div>' : `<div class="asset-grid"><button id="assetDrop" class="upload-grid-card ${assetUploadBusy ? 'uploading' : ''}" type="button" data-asset-upload><span class="upload-thumb"><i data-lucide="${assetUploadBusy ? 'loader-circle' : 'upload-cloud'}"></i></span><span class="upload-body"><strong>${assetUploadBusy ? '正在上传素材' : '上传到此项目/画布'}</strong><small>${assetUploadBusy ? '请稍候，不需要重复点击' : '拖入文件或点击上传'}</small></span></button>${items.map(item => renderStorageFileCard('upload', item)).join('')}${!items.length ? '<div class="empty-state">上传素材目录中还没有符合条件的文件。</div>' : ''}${uploadAssetsState.hasMore ? `<div class="storage-load-more">已加载 ${items.length} / ${uploadAssetsState.total}，向下滚动继续</div>` : ''}</div>`);
    root.innerHTML = `<aside class="asset-panel asset-nav"><div class="panel-head"><div class="panel-title"><strong>上传素材</strong><span>资产管理 / 上传素材</span></div></div>
        <div class="nav-scroll"><div class="nav-tree">
            <button class="tree-row tree-parent ${uploadAssetsState.favoritesOnly ? 'active' : ''}" type="button" data-upload-fav-filter><span class="tree-row-icon"><i data-lucide="star"></i></span><span class="tree-row-name">我的收藏</span><span class="tree-row-count">${favoriteFileCount('upload')}</span></button>
            <button class="tree-row tree-parent" type="button" data-upload-library-view><span class="tree-row-icon"><i data-lucide="library"></i></span><span class="tree-row-name">图片资产库</span></button>
            <div class="generated-projects-toggle"><span>按类型</span></div>
            ${renderMaterialMediaTree('upload', [['all','全部上传','images',uploadAssetsState.allTotal],['image','图片','image',uploadAssetsState.mediaCounts.image],['video','视频','video',uploadAssetsState.mediaCounts.video],['audio','音频','file-audio',uploadAssetsState.mediaCounts.audio]], uploadAssetsState.mediaType)}
            <div class="generated-projects-toggle"><span>按项目</span></div>
            ${renderMaterialProjectTree('upload', tree, uploadAssetsState.canvases || [], uploadAssetsState.projectId, uploadAssetsState.canvasId)}
            ${renderStorageFileFolders('upload')}${renderImageSpaceCollections()}</div><div class="nav-hint">素材归属来自画布引用或上传时的选择。</div></div></aside>
        <section class="asset-panel asset-content ${uploadAssetsState.manageMode ? 'manage-on' : ''}"><div class="content-toolbar"><div class="content-heading"><strong>${escapeHtml(uploadAssetsState.favoritesOnly ? '我的收藏 · 上传素材' : uploadAssetsState.folder || project)}</strong><span>资产管理 / 上传素材 · 共 ${uploadAssetsState.total} 个文件</span></div>
            <div class="asset-tools"><label class="asset-search-wrap"><i data-lucide="search"></i><input id="assetSearch" class="asset-search" type="search" value="${escapeAttr(uploadAssetsState.query)}" placeholder="搜索文件名或目录"></label>
            <button class="asset-btn primary" type="button" data-asset-upload><i data-lucide="upload-cloud"></i><span>上传文件</span></button><button class="asset-btn" type="button" data-upload-retry><i data-lucide="refresh-cw"></i><span>刷新</span></button>
            <button class="asset-btn ${uploadAssetsState.manageMode ? 'primary' : ''}" type="button" data-space-file-manage><i data-lucide="list-checks"></i><span>${uploadAssetsState.manageMode ? '完成管理' : '批量管理'}</span></button></div></div>
            ${renderImageSpaceFilterBar()}${renderStorageFileManageTools('upload', items)}${renderStorageFileClipboardBar('upload')}<div class="content-scroll" data-upload-file-grid>${body}</div></section>
        <aside class="asset-panel asset-detail">${renderStorageFileDetail('upload', detail)}</aside>`;
}
function generatedAssetTypeLabel(item){
    return assetKind(item) === 'video' ? '视频' : '图片';
}
function generatedMediaTypeLabel(type){
    return type === 'video' ? '视频' : type === 'audio' ? '音频' : type === 'image' ? '图片' : '生成素材';
}
function generatedMediaCounts(){
    const saved = generatedAssetsState.mediaCounts || {};
    const fallback = (generatedAssetsState.items || []).reduce((result, item) => {
        const kind = assetKind(item) === 'video' ? 'video' : assetKind(item) === 'audio' ? 'audio' : 'image';
        result[kind] += 1;
        return result;
    }, {image:0, video:0, audio:0});
    return {
        image: Number.isFinite(Number(saved.image)) ? Number(saved.image) : fallback.image,
        video: Number.isFinite(Number(saved.video)) ? Number(saved.video) : fallback.video,
        audio: Number.isFinite(Number(saved.audio)) ? Number(saved.audio) : fallback.audio,
    };
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
        if(!append) generatedAssetsState.reloadPending = options;
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
        generatedAssetsState.mediaCounts = {image:0, video:0, audio:0};
        generatedAssetsState.hasMore = false;
        if(!options.preserveSelection) generatedAssetsState.selectedIds.clear();
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
        const favoriteQuery = generatedFavoritesOnly ? `&favorites=${encodeURIComponent(JSON.stringify([...fileFavoriteMap.values()].filter(entry => entry.kind === 'generated').map(entry => entry.key.slice('generated:'.length))))}` : '';
        const data = await annotations.readFiles('generated', () => apiJson(`/api/storage-files?kind=generated&offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}${mediaTypeQuery}&filters=${filterQuery}&folder=${folderQuery}${favoriteQuery}`));
        const items = Array.isArray(data.items) ? data.items : [];
        generatedAssetsState.items = append ? [...generatedAssetsState.items, ...items] : items;
        generatedAssetsState.offset = offset + items.length;
        generatedAssetsState.total = Number(data.total || generatedAssetsState.items.length || 0);
        generatedAssetsState.allTotal = Number(data.all_total ?? data.total ?? generatedAssetsState.items.length ?? 0);
        const fallbackCounts = generatedAssetsState.items.reduce((result, item) => {
            const type = assetKind(item) === 'video' ? 'video' : assetKind(item) === 'audio' ? 'audio' : 'image';
            result[type] += 1;
            return result;
        }, {image:0, video:0, audio:0});
        const mediaCounts = data.media_counts || {};
        generatedAssetsState.mediaCounts = {
            image: Number.isFinite(Number(mediaCounts.image)) ? Number(mediaCounts.image) : fallbackCounts.image,
            video: Number.isFinite(Number(mediaCounts.video)) ? Number(mediaCounts.video) : fallbackCounts.video,
            audio: Number.isFinite(Number(mediaCounts.audio)) ? Number(mediaCounts.audio) : fallbackCounts.audio,
        };
        generatedAssetsState.hasMore = Boolean(data.has_more);
        generatedAssetsState.folders = Array.isArray(data.folders) ? data.folders : [];
        generatedAssetsState.loaded = true;
        generatedAssetsState.selectedIds = new Set([...generatedAssetsState.selectedIds].filter(id => generatedAssetsState.items.some(item => item.id === id)));
        if(generatedAssetsState.selectedId && !findGeneratedAsset(generatedAssetsState.selectedId)) generatedAssetsState.selectedId = '';
        if(!generatedAssetsState.selectedId && generatedAssetsState.items.length) generatedAssetsState.selectedId = generatedAssetsState.items[0].id;
    } finally {
        generatedAssetsState.loading = false;
        generatedAssetsState.loadingMore = false;
        generatedAssetsState.restoreScrollTop = keepScrollTop;
        if(generatedAssetsState.reloadPending){
            const pending = generatedAssetsState.reloadPending;
            generatedAssetsState.reloadPending = false;
            await loadGeneratedAssets(pending);
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
    const mediaType = generatedAssetsState.mediaType || 'all';
    const viewTotal = generatedAssetsState.total;
    const viewLabel = generatedAssetsState.folder || generatedMediaTypeLabel(mediaType);
    const detail = items.find(item => item.id === generatedAssetsState.selectedId) || items[0] || null;
    const cards = generatedAssetsState.loading
        ? '<div class="storage-empty">正在读取生成素材目录...</div>'
        : items.length
            ? items.map(item => renderStorageFileCard('generated', item)).join('') + (generatedFavoritesOnly
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
                    <button class="asset-btn primary" type="button" data-generated-upload><i data-lucide="upload-cloud"></i><span>上传文件</span></button>
                    <button class="asset-btn" type="button" data-generated-refresh><i data-lucide="refresh-cw"></i><span>刷新</span></button>
                    <button class="asset-btn ${generatedManageMode ? 'primary' : ''}" type="button" data-space-file-manage data-generated-manage><i data-lucide="list-checks"></i><span>${generatedManageMode ? '完成管理' : '批量管理'}</span></button>
                </div>
            </div>
            ${renderImageSpaceFilterBar()}
            ${renderStorageFileManageTools('generated', items)}
            ${renderStorageFileClipboardBar('generated')}
            <div class="content-scroll" data-generated-file-grid><div class="asset-grid generated-assets-grid"><button id="generatedDrop" class="upload-grid-card" type="button" data-generated-upload><span class="upload-thumb"><i data-lucide="upload-cloud"></i></span><span class="upload-body"><strong>上传到生成素材</strong><small>拖入图片、视频或音频</small></span></button>${cards}</div></div>
        </section>
        <aside class="asset-panel asset-detail">${renderStorageFileDetail('generated', detail)}</aside>`;
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
        {type:'audio', label:'音频', icon:'file-audio', count:mediaCounts.audio},
    ];
    return `<aside class="asset-panel asset-nav">
        <div class="panel-head"><div class="panel-title"><strong>生成素材</strong><span>资产管理 / 生成素材</span></div></div>
        <div class="nav-scroll generated-folder-list">
            <button class="tree-row tree-parent ${!projectView && generatedFavoritesOnly ? 'active contains-active' : ''}" type="button" data-generated-fav-filter title="收藏的生成素材">
                <span class="tree-row-icon"><i data-lucide="star"></i></span>
                <span class="tree-row-name">我的收藏</span>
                <span class="tree-row-count">${favoriteFileCount('generated')}</span>
            </button>
            ${renderAssetNavBranch('generated:media', '全部生成', `<button class="tree-row tree-parent ${!projectView && !generatedFavoritesOnly && !generatedAssetsState.folder && mediaType === 'all' ? 'active' : ''}" type="button" data-generated-type="all"><span class="tree-row-icon"><i data-lucide="images"></i></span><span class="tree-row-name">全部生成</span><span class="tree-row-count">${allTotal}</span></button>`, `${mediaChannels.map(channel => `<button class="tree-row tree-child ${!projectView && !generatedFavoritesOnly && !generatedAssetsState.folder && mediaType === channel.type ? 'active' : ''}" type="button" data-generated-type="${channel.type}"><span class="tree-elbow"></span><span class="tree-row-icon"><i data-lucide="${channel.icon}"></i></span><span class="tree-row-name">${channel.label}</span><span class="tree-row-count">${channel.count}</span></button>`).join('')}`)}
            <div class="generated-projects ${generatedProjectsCollapsed ? 'is-collapsed' : ''}">
                <button class="generated-projects-toggle" type="button" data-generated-projects-toggle aria-expanded="${generatedProjectsCollapsed ? 'false' : 'true'}" title="${generatedProjectsCollapsed ? '展开项目列表' : '收起项目列表'}">
                    <span>按项目</span><i data-lucide="chevron-down"></i>
                </button>
                ${generatedProjectsCollapsed ? '' : `<div class="nav-tree canvas-asset-tree">
                    ${canvasProjects.navigation(activeCanvasAssetProjectId, activeCanvasAssetCanvasId)}
                </div>`}
            </div>
            ${renderStorageFileFolders('generated')}
            ${renderImageSpaceCollections()}
        </div>
    </aside>`;
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
    return XiaomeiAssetManagerWorkflows.groups(assetLibraries());
}
function activeAssetCategory(){
    const cats = assetCategories();
    return cats.find(cat => cat.id === activeAssetCategoryId) || cats[0] || null;
}
function assetViewTitle(){
    const collection = imageSpaceState.collections.find(item => item.id === imageSpaceState.collectionId && item.source === 'assets');
    if(collection) return collection.name;
    if(imageSpaceState.all.assets) return '全部分组';
    return activeAssetCategory()?.name || '图片资产';
}
function activeWorkflowCategory(){
    return XiaomeiAssetManagerWorkflows.groupFor(workflowCategories(), {
        libraryId:activeWorkflowLibraryId, categoryId:activeWorkflowCategoryId,
    });
}
function promptLibraries(){
    const libs = Array.isArray(promptLibrary.libraries) ? promptLibrary.libraries.filter(Boolean) : [];
     if(!libs.length) return [{id:'system', name:'系统提示词模板库', system:true, items:[], categories:[]}];
    const system = libs.filter(lib => lib.id === 'system');
    const others = libs.filter(lib => lib.id !== 'system');
    return [...system, ...others];
}
function activePromptLibrary(){
    const libs = promptLibraries();
    return libs.find(lib => lib.id === activePromptLibraryId) || libs[0] || null;
}
const promptCategoriesFor = XiaomeiAssetManagerCatalogs.templateGroups;
function activePromptCategories(){
    return promptCategoriesFor(activePromptLibrary());
}
function assetKind(item){
    const url = String(item?.url || '').toLowerCase();
    const kind = String(item?.kind || item?.type || '').toLowerCase();
    if(kind.includes('video') || /\.(mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/.test(url)) return 'video';
    if(kind.includes('audio') || /\.(mp3|wav|flac|ogg|m4a|aac)(\?|#|$)/.test(url)) return 'audio';
    if(kind.includes('text') || /\.(txt|json|csv|srt|vtt|md)(\?|#|$)/.test(url)) return 'text';
    return 'image';
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
function isLocalMediaFile(file){
    if(!file) return false;
    const type = String(file.type || '').toLowerCase();
    if(type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')) return true;
    return LOCAL_MEDIA_EXTS.test(file.name || '');
}
function localFolderId(path=''){
    return path || '__root__';
}
function localChildPath(parentPath='', name=''){
    return parentPath ? `${parentPath}/${name}` : name;
}
function localFileScope(){
    return {folder:activeLocalUploadFolder, project:localUploadProjectId, canvas:localUploadCanvasId,
        type:localUploadMediaType, query:localUploadQuery};
}
function isLocalFileScopeCurrent(scope){
    return activeTab === 'local' && Object.entries(localFileScope()).every(([key,value]) => scope[key] === value);
}
function applyLocalFileSnapshot(data){
    if(Array.isArray(data.items)) localAssets = data.items;
    if(data.tree) localUploadTree = data.tree;
    localUploadTree ||= {id:'__root__', path:'', name:'全部上传', count:localAssets.length, items:[], children:[]};
    if(!localUploadFolderExists(activeLocalUploadFolder)) activeLocalUploadFolder = '';
    const ids = new Set(localAssets.map(item => item.id));
    selectedLocalUploadIds = new Set([...selectedLocalUploadIds].filter(id => ids.has(id)));
    if(!ids.has(selectedLocalUploadId)) selectedLocalUploadId = '';
    localAssetsLoaded = true;
}
function applyLocalFolder(folder){
    activeLocalUploadFolder = folder;
    selectedLocalUploadId = '';
    selectedLocalUploadIds.clear();
}
function currentAssetItems(){
    const source = imageSpaceState.all.assets ? assetCategories().flatMap(cat => cat.items || []) : (activeAssetCategory()?.items || []);
    return source.filter(item => imageSpaceMatches(item, {...imageSpaceState.filters.assets,query:assetQuery}));
}
function currentWorkflowItems(){
    return XiaomeiAssetManagerWorkflows.matching(activeWorkflowCategory(), workflowQuery);
}
function canvasProjectView(){
    return {projectId:activeCanvasAssetProjectId, canvasId:activeCanvasAssetCanvasId, query:canvasAssetQuery,
        sort:canvasAssetSort, selectedId:selectedCanvasAssetId, selection:selectedCanvasAssetIds, managing:canvasAssetManageMode};
}
function currentCanvasAssetItems(){
    return canvasProjects.assets(canvasProjectView());
}
function assetTransferScope(){
    return {libraryId:activeAssetLibrary()?.id || '', categoryId:activeAssetCategory()?.id || '', all:imageSpaceState.all.assets};
}
function assetTransferRecords(owner){
    const library = assetLibraries().find(entry => entry.id === owner.libraryId);
    const groups = (library?.categories || []).filter(group => (group.type || 'image') === 'image');
    const scoped = owner.all ? groups : groups.filter(group => group.id === owner.categoryId);
    return scoped.flatMap(group => (group.items || []).map(item => ({categoryId:group.id,item})));
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
function findAssetItem(id){
    for(const lib of assetLibraries()) for(const cat of lib.categories || []) for(const item of cat.items || []) if(item.id === id) return item;
    return null;
}
function findCanvasAssetItem(id){
    return canvasProjects.scoped(activeCanvasAssetProjectId, activeCanvasAssetCanvasId).find(item => item.id === id) || null;
}
function shellBatch(kind, fields){
    return XiaomeiShellKernel.assetBatch(kind, fields);
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
    return XiaomeiShellKernel.toggleMember(set, id);
}
function normalizeAssetState(){
    const libs = assetLibraries();
    if(!activeAssetLibraryId || !libs.some(lib => lib.id === activeAssetLibraryId)) activeAssetLibraryId = assetLibrary.active_library_id || libs[0]?.id || '';
    const cats = assetCategories();
    if(!activeAssetCategoryId || !cats.some(cat => cat.id === activeAssetCategoryId)) activeAssetCategoryId = cats[0]?.id || '';
    const items = currentAssetItems();
    if(selectedAssetId && !items.some(item => item.id === selectedAssetId)) selectedAssetId = '';
    if(!selectedAssetId && items.length) selectedAssetId = items[0].id;
    selectedAssetIds = new Set([...selectedAssetIds].filter(id => findAssetItem(id)));
}
function normalizeWorkflowState(){
    const group = activeWorkflowCategory();
    activeWorkflowCategoryId = group?.id || '';
    activeWorkflowLibraryId = group?.__libraryId || activeWorkflowLibrary()?.id || '';
    const items = currentWorkflowItems();
    if(!items.some(item => item.id === selectedWorkflowId)) selectedWorkflowId = items[0]?.id || '';
    const ids = new Set((group?.items || []).map(item => item.id));
    selectedWorkflowIds = new Set([...selectedWorkflowIds].filter(id => ids.has(id)));
}
function normalizePromptState(){
    const libs = promptLibraries();
    if(!activePromptLibraryId || !libs.some(lib => lib.id === activePromptLibraryId)) activePromptLibraryId = promptLibrary.active_library_id || libs[0]?.id || '';
    const cats = activePromptCategories();
    if(activePromptCategory !== 'all' && !cats.some(cat => cat.id === activePromptCategory)) activePromptCategory = 'all';
    const items = currentPromptItems();
    if(selectedPromptId && !items.some(item => item.id === selectedPromptId)) selectedPromptId = '';
    if(!selectedPromptId && items.length) selectedPromptId = items[0].id;
    const ids = new Set((activePromptLibrary()?.items || []).map(item => item.id));
    selectedPromptIds = new Set([...selectedPromptIds].filter(id => ids.has(id)));
}
function normalizeCanvasAssetState(){
    if(!canvasProjects.projectById(activeCanvasAssetProjectId)) activeCanvasAssetProjectId = canvasProjects.defaultProject();
    if(!canvasProjects.validCanvas(activeCanvasAssetCanvasId, activeCanvasAssetProjectId)) activeCanvasAssetCanvasId = '';
    const items = currentCanvasAssetItems();
    if(!items.some(item => item.id === selectedCanvasAssetId)) selectedCanvasAssetId = items[0]?.id || '';
    const ids = new Set(canvasProjects.scoped(activeCanvasAssetProjectId, activeCanvasAssetCanvasId).map(item => item.id));
    selectedCanvasAssetIds = new Set([...selectedCanvasAssetIds].filter(id => ids.has(id)));
}
async function loadCanvasAssets(){
    const version = ++canvasAssetsRequestId;
    try {
        const data = await apiJson('/api/canvas-assets', {cache:'no-store'});
        if(version !== canvasAssetsRequestId) return false;
        setCanvasAssetsData(data);
        return true;
    } catch(error) {
        if(version !== canvasAssetsRequestId) return false;
        throw error;
    }
}
async function refreshCanvasAssets(){
    try {
        setStatus('正在刷新画布资产...');
        if(!await loadCanvasAssets()) return;
        render();
        setStatus('画布资产已刷新');
    } catch(error) {
        setStatus(error.message || '刷新画布资产失败');
    }
}
function setCanvasAssetsData(data){
    canvasAssetsData = Object.fromEntries(['categories','projects','canvases','items'].map(key =>
        [key, Array.isArray(data?.[key]) ? data[key] : []]));
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
    const promptRevision = promptLibraryRevision;
    const promptRequest = apiJson('/api/prompt-libraries');
    const providerRequest = apiJson('/api/providers', {cache:'no-store'}).catch(() => ({providers:[]}));
    const canvasAssetRequest = loadCanvasAssets().catch(() => false);
    const localAssetsRequest = localFiles.load();
    const uploadAssetsRequest = loadUploadAssets({background:true}).catch(() => {});
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
    void workflows.hydrate();
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
    const [promptData, providerData] = await Promise.all([
        promptRequest,
        providerRequest,
        canvasAssetRequest,
        localAssetsRequest,
        uploadAssetsRequest,
        collectionsRequest,
        promptCasesRequest,
        fileFavoritesRequest
    ]);
    if(promptRevision === promptLibraryRevision) promptLibrary = promptData.library || {libraries:[]};
    apiProviders = Array.isArray(providerData.providers) ? providerData.providers : [];
    render();
    setStatus('准备就绪');
}
function render(){
    marquee.cancel();
    const nameInput = root.querySelector('[data-asset-name-draft]:focus, [data-workflow-name-key]:focus');
    const nameRange = nameInput && [nameInput.selectionStart, nameInput.selectionEnd, nameInput.selectionDirection];
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
    if(nameInput){
        const workflowKey = nameInput.dataset.workflowNameKey;
        const next = root.querySelector(workflowKey ? '[data-workflow-name-key]' : '[data-asset-name-draft]');
        if(next && next.dataset.workflowNameKey === workflowKey
            && next.dataset.assetNameDraft === nameInput.dataset.assetNameDraft && next.id === nameInput.id){
            next.focus({preventScroll:true});
            next.setSelectionRange(...nameRange);
        }
    }
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
    else if(id === 'localUploadSearch') localUploadQuery = value || '';
    else if(id === 'canvasAssetSearch') canvasAssetQuery = value || '';
    else if(id === 'generatedSearch') generatedAssetsState.query = value || '';
}
function clearSearchSelection(id){
    if(id === 'assetSearch') selectedAssetId = '';
    else if(id === 'workflowSearch') selectedWorkflowId = '';
    else if(id === 'promptSearch') selectedPromptId = '';
    else if(id === 'hubSearch') selectedHubCaseId = '';
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
    const model = canvasProjectView();
    const items = currentCanvasAssetItems();
    root.innerHTML = renderGeneratedNavigation() + canvasProjects.content(model, items)
        + '<aside class="asset-panel asset-detail">' + canvasProjects.detail(selectedCanvasAsset(), model.projectId) + '</aside>';
}
function refreshCanvasAssetSelectionOnly(){
    if(canvasAssetManageMode){ render(); return; }
    for(const card of root.querySelectorAll('[data-canvas-asset-card]')){
        card.classList.toggle('active', card.dataset.canvasAssetCard === selectedCanvasAssetId);
    }
    const detail = root.querySelector('.asset-detail');
    if(detail){
        detail.innerHTML = canvasProjects.detail(selectedCanvasAsset(), activeCanvasAssetProjectId);
        refreshIcons();
        prepareVideoThumbs(detail);
    }
}
function renderLocalUploadFolderCreate(){
    const draft = localFiles.folderDraft();
    if(!draft) return '';
    return catalogView.headEditor(
        {placement:'head', value:draft.name, label:'新建文件夹名称', pending:draft.saving},
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
function localUploadViewModel(){
    return {
        tree:localUploadTree, folder:activeLocalUploadFolder, project:localUploadProjectId, canvas:localUploadCanvasId,
        type:localUploadMediaType, query:localUploadQuery, filters:imageSpaceState.filters.local,
        allFolders:imageSpaceState.all.local, favoritesOnly:localFavoritesOnly,
        selected:selectedLocalUploadId, selection:selectedLocalUploadIds, managing:localUploadManageMode,
    };
}
function localUploadItems(){
    return localView.items(localUploadViewModel());
}
function localUploadVisibleItems(){
    return localFavoritesOnly ? localView.items(localUploadViewModel(), true) : localUploadItems();
}
function findLocalUpload(id){
    return localView.find(id);
}
function localUploadFolderExists(path=''){
    return !path || Boolean(localUploadFolderByPath(path));
}
function localUploadFolderByPath(path=''){
    return XiaomeiAssetManagerLocalFiles.folderAt(localUploadTree, path);
}
function clearLocalUploadFolderDropTargets(){
    root.querySelectorAll('.local-folder-drop-before, .local-folder-drop-after').forEach(node => {
        node.classList.remove('local-folder-drop-before', 'local-folder-drop-after');
    });
}
function selectedLocalUploadImageItems(){
    return [...selectedLocalUploadIds].map(id => findLocalUpload(id)).filter(item => item && assetKind(item) === 'image');
}
function selectedAssetImageItems(){
    return annotationRecords({kind:'library',libraryId:activeAssetLibrary()?.id})
        .filter(item => selectedAssetIds.has(item.id) && assetKind(item) === 'image');
}
function renderLocalManager(){
    const scope = localView.scope(localUploadViewModel());
    localUploadProjectId = scope.project;
    localUploadCanvasId = scope.canvas;
    const model = localUploadViewModel();
    const items = localView.items(model, model.favoritesOnly);
    if(!findLocalUpload(selectedLocalUploadId)) selectedLocalUploadId = items[0]?.id || '';
    const imageCount = selectedLocalUploadImageItems().length;
    root.innerHTML = localView.render({
        ...model, selected:selectedLocalUploadId, imageCount, removingBackground:backgroundRemovalBusy,
        favoriteCount:favoriteFileCount('local'), folderEditor:renderLocalUploadFolderCreate(),
        collections:renderImageSpaceCollections(), filterBar:renderImageSpaceFilterBar(),
        annotationToolbar:annotations.toolbar(imageCount, 'local'),
        clipboard:localFiles.clipboardMarkup(model.folder ? localView.title(model) : '根目录'),
    }, items, findLocalUpload(selectedLocalUploadId));
}
function refreshLocalUploadSelectionOnly(){
    for(const card of root.querySelectorAll('[data-localup-card]')){
        card.classList.toggle('active', card.dataset.localupCard === selectedLocalUploadId);
    }
    const detail = root.querySelector('.asset-detail');
    if(detail){
        detail.innerHTML = localView.detail(findLocalUpload(selectedLocalUploadId));
        refreshIcons();
        prepareVideoThumbs(detail);
    }
}
function renderAssetManager(){
    normalizeAssetState();
    const group = activeAssetCategory();
    const all = currentAssetItems();
    const favorites = all.filter(item => item.favorite);
    const items = assetFavoritesOnly ? favorites : all;
    const empty = assetFavoritesOnly
        ? '还没有收藏的上传素材。点击素材卡片右上角的 ⭐ 即可收藏。'
        : group ? '当前分组没有符合条件的素材，可清空筛选或上传文件。'
            : '当前资产库还没有分组。可直接上传文件，或先新建分组；直接上传的文件会显示在“上传目录”。';
    catalogView.render({
        type:'asset', libraries:assetLibraries(), libraryId:activeAssetLibraryId, categoryId:activeAssetCategoryId,
        focus:assetTreeFocus, edit:assetTreeEdit, pending:catalogWriter.pending(assetTreeEdit), confirmation:pendingTreeDelete,
        title:assetFavoritesOnly ? '我的收藏 · 上传素材' : '上传素材 · ' + assetViewTitle(),
        subtitle:assetFavoritesOnly ? '收藏的 ' + items.length + ' 个素材'
            : (activeAssetLibrary()?.name || '资产库') + ' / ' + items.length + ' 个素材',
        favorites:assetFavoritesOnly, favoriteCount:favorites.length, query:assetQuery, managing:assetManageMode,
        selectionCount:selectedAssetIds.size, imageCount:selectedAssetImageItems().length,
        classifying:annotations.classifyingLibrary(), removingBackground:backgroundRemovalBusy,
        filters:renderImageSpaceFilterBar(), collections:renderImageSpaceCollections(), clipboard:assetTransfers.view(),
        itemCount:items.length, cards:items.map(renderAssetCard).join(''), upload:assetFavoritesOnly ? '' : renderUploadCard(group),
        empty, detail:assetDetail.view(assetDetailRecord(), {
            confirmDelete:pendingDeleteAssetId === selectedAssetId, removingBackground:backgroundRemovalBusy,
        }),
    });
}
function renderWorkflowManager(){
    normalizeWorkflowState();
    const group = activeWorkflowCategory();
    const all = currentWorkflowItems();
    const favorites = all.filter(item => item.favorite);
    const items = workflowFavoritesOnly ? favorites : all;
    catalogView.render({
        type:'workflow', categories:workflowCategories(), libraryId:activeWorkflowLibraryId, categoryId:activeWorkflowCategoryId,
        edit:workflowTreeEdit, pending:catalogWriter.pending(workflowTreeEdit), confirmation:pendingTreeDelete,
        title:workflowFavoritesOnly ? '我的收藏 · 工作流' : (group?.name || '工作流'),
        subtitle:(workflowFavoritesOnly ? '收藏的 ' : '工作流库 / ') + items.length + ' 个工作流',
        favorites:workflowFavoritesOnly, favoriteCount:favorites.length, query:workflowQuery,
        managing:workflowManageMode, selectionCount:selectedWorkflowIds.size,
        itemCount:items.length, cards:items.map(item => workflows.card(item, selectedWorkflowId, selectedWorkflowIds)).join(''),
        upload:workflowFavoritesOnly ? '' : workflows.uploadCard(Boolean(group)),
        empty:workflowFavoritesOnly ? '还没有收藏的工作流。点击工作流卡片右上角的 ⭐ 即可收藏。'
            : '当前分组还没有工作流，可以上传 JSON / ZIP，或从传统画布导出到资产库。',
        detail:workflows.detail(selectedWorkflow(), group?.name),
    });
}
function renderUploadCard(cat){
    return `<button id="assetDrop" class="upload-grid-card ${assetUploadBusy ? 'uploading' : ''}" type="button" data-asset-upload ${assetUploadBusy ? 'disabled' : ''}>
        <span class="upload-thumb"><i data-lucide="${assetUploadBusy ? 'loader-circle' : 'upload-cloud'}"></i></span>
        <span class="upload-body">
            <strong>${assetUploadBusy ? '正在上传素材' : cat ? '上传到当前分组' : '上传文件'}</strong>
            <small>${assetUploadBusy ? '请稍候，不需要重复点击' : cat ? '拖入文件或点击上传' : '上传后在“上传目录”查看'}</small>
        </span>
    </button>`;
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
    if(kind === 'upload') return `upload:${item.rel || item.url || ''}`;
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
function hubPromptItemsForView(view){
    const query = hubQuery.trim().toLowerCase();
    const {userLibs, systemLib} = promptHubLibraryGroups();
    const sources = view === 'system' ? (systemLib ? [systemLib] : []) : userLibs;
    const items = [];
    const pushItem = (lib, item) => {
        if(query && ![item.name, item.scene, item.positive, item.negative].filter(Boolean).join('\n').toLowerCase().includes(query)) return;
        items.push({...item, __libId:lib.id, __readonly:Boolean(lib.readonly)});
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
            items.push({...item, __libId:lib.id, __readonly:Boolean(lib.readonly)});
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
        const detail = selectedHubPrompt(favPrompts);
        detailHtml = `<aside class="asset-panel asset-detail">${renderPromptDetail(detail, detail?.__readonly)}</aside>`;
    } else {
        const readonly = hubPromptView === 'system';
        const items = hubPromptItemsForView(hubPromptView);
        const detail = selectedHubPrompt(items);
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
        detailHtml = `<aside class="asset-panel asset-detail">${renderPromptDetail(detail, readonly || detail?.__readonly)}</aside>`;
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
    normalizePromptState();
    const library = activePromptLibrary();
    const readonly = Boolean(library?.readonly);
    const items = currentPromptItems();
    catalogView.render({
        type:'prompt', libraries:promptLibraries(), libraryId:activePromptLibraryId, categoryId:activePromptCategory,
        focus:promptTreeFocus, edit:promptTreeEdit, pending:catalogWriter.pending(promptTreeEdit), confirmation:pendingTreeDelete,
        title:library?.name || '提示词模板库', subtitle:'共 ' + items.length + ' 条提示词', query:promptQuery,
        managing:promptManageMode, selectionCount:selectedPromptIds.size, readonly, confirmDelete:promptTemplates.canConfirm(library?.id, selectedPromptIds),
        itemCount:items.length, cards:items.map(item => renderPromptRow(item, readonly)).join(''),
        empty:library?.items?.length ? '当前条件下没有提示词。可以切换分类或清空搜索条件。'
            : (library?.name || '当前提示词模板库') + ' 暂无提示词，点击「新增」添加。',
        detail:renderPromptDetail(selectedPrompt(), readonly),
    });
}
function promptCategoryFor(item, libraryId){
    const category = item?.category || 'custom';
    const library = promptLibraries().find(entry => entry.id === libraryId);
    return promptCategoriesFor(library).find(entry => entry.id === category)?.name
        || promptCategoriesFor(null).find(entry => entry.id === category)?.name
        || (category === 'mine' ? '我的' : category);
}
function renderPromptRow(item, readonly){
    const libraryId = item.__libId || activePromptLibrary()?.id;
    const inHub = activeTab === 'prompt-hub';
    return promptTemplates.row(item, {
        libraryId, category:promptCategoryFor(item, libraryId), readonly,
        active:item.id === selectedPromptId && (!inHub || !selectedPromptLibraryId || selectedPromptLibraryId === libraryId),
        selected:!inHub && selectedPromptIds.has(item.id),
    });
}
function renderPromptDetail(item, readonly){
    if(promptTemplates.creating()) item = null;
    const libraryId = item?.__libId || activePromptLibrary()?.id;
    return promptTemplates.detail(item, {libraryId, readonly, category:promptCategoryFor(item, libraryId)});
}
function selectedHubPrompt(items){
    return items.find(item => item.id === selectedPromptId
        && (!selectedPromptLibraryId || item.__libId === selectedPromptLibraryId)) || null;
}
function promptPageScope(){
    return activeTab === 'prompt-hub'
        ? JSON.stringify([activeTab, hubView, hubPromptView])
        : JSON.stringify([activeTab, activePromptLibrary()?.id, activePromptCategory]);
}
function promptControlTarget(id, control){
    const libraryId = control.dataset.promptOwner || control.closest('[data-prompt-owner]')?.dataset.promptOwner;
    const library = promptLibraries().find(entry => entry.id === libraryId);
    return {library, item:library?.items?.find(item => item.id === id)};
}
function applyPromptSave(scope, data){
    applyPromptCatalog(data);
    if(promptPageScope() === scope.origin){
        selectedPromptLibraryId = scope.libraryId;
        selectedPromptId = data.item?.id || scope.itemId || '';
    }
    render();
}
function applyPromptFavorite(libraryId, id, result){
    if(applyPromptCatalog(result)){
        render();
        return;
    }
    if(result.library) return;
    promptLibraryRevision++;
    const library = promptLibraries().find(entry => entry.id === libraryId);
    const item = library?.items?.find(entry => entry.id === id);
    if(item){
        item.favorite = Boolean(result.item?.favorite);
        if(result.item?.updated_at != null) item.updated_at = result.item.updated_at;
    }
    render();
}
function applyPromptRemoval(libraryId, ids, data){
    applyPromptCatalog(data);
    const selectionLibrary = activeTab === 'prompt-hub' ? selectedPromptLibraryId : activePromptLibrary()?.id;
    if(libraryId === selectionLibrary){
        for(const id of ids) selectedPromptIds.delete(id);
        if(ids.includes(selectedPromptId)) selectedPromptId = '';
    }
    render();
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
    const uploadView = uploadAssetsState.view === 'library' && !activeAssetCategory() ? 'disk' : uploadAssetsState.view;
    if(uploadView === 'disk') uploadAssetsState.view = 'disk';
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
        if(uploadAssetsState.folder) form.append('folder', uploadAssetsState.folder);
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
                body:JSON.stringify(shellBatch('copy', {libraryId:activeAssetLibraryId, categoryId:activeAssetCategoryId, items}))
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
async function uploadGeneratedFiles(files){
    const list = Array.from(files || []).filter(Boolean);
    if(!list.length) return;
    const form = new FormData();
    form.append('folder', generatedAssetsState.folder || '');
    list.forEach(file => form.append('files', file, file.name));
    setStatus(`正在上传 ${list.length} 个素材...`);
    const data = await uploadFormWithProgress('/api/storage-files/upload', form, percent => setStatus(`正在上传 ${list.length} 个素材 · ${percent}%`));
    await loadGeneratedAssets();
    setStatus(`已上传 ${data.count || 0} 个素材到生成素材`);
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
        await localFiles.load();
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
            body:JSON.stringify(shellBatch('import', {
                items,
                folder:targetFolder,
                folderParent:parentFolder,
                folderName:category.name || '素材分组'
            }))
        });
        targetFolder = String(data.folder || targetFolder).trim();
        const results = Array.isArray(data.items) ? data.items : [];
        const imported = Number(data.count || data.files?.length || results.filter(item => item?.ok).length || 0);
        if(!imported){
            const reason = results.find(item => item?.error)?.error;
            throw new Error(reason || '没有素材被移动到本地素材');
        }
        activeLocalUploadFolder = targetFolder;
        selectedLocalUploadId = '';
        selectedLocalUploadIds.clear();
        // 先用接口已返回的文件更新当前列表，让用户马上看到导入结果；
        // 完整树和数量在后台再刷新，避免整库扫描阻塞界面。
        const importedItems = (Array.isArray(data.files) ? data.files : results.map(result => result?.item).filter(Boolean))
            .filter(item => item?.id || item?.file);
        if(importedItems.length){
            const merged = new Map((localAssets || []).map(item => [item.id, item]));
            importedItems.forEach(item => merged.set(item.id || item.file, item));
            localFiles.invalidate();
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
        localFiles.load().then(() => {
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
                        body:JSON.stringify(shellBatch('delete', {
                        libraryId:payload.libraryId || '',
                        ids:importedSourceIds,
                        preserveReferenced:true,
                        removeEmptyCategoryId:payload.categoryId || ''
                    }))
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
function findLibraryMedia(id){
    return activeAssetCategory()?.items?.find(item => item.id === id)
        || assetCategories().flatMap(group => group.items || []).find(item => item.id === id);
}
function openAssetPreview(item){
    if(item) assetMedia.show(item, assetKind(item));
}
function copySelectedAssetsToCanvas(){
    copyStorageFileItemsToCanvas([...selectedAssetIds].map(findAssetItem), true);
}

function copySelectedLocalUploadsToCanvas(){
    copyStorageFileItemsToCanvas([...selectedLocalUploadIds].map(findLocalUpload), true);
}

function activeStorageFileKind(){
    if(activeTab === 'assets' && uploadAssetsState.view === 'disk') return 'upload';
    if(activeTab === 'generated') return 'generated';
    return '';
}
async function refreshStorageFileKind(kind){
    if(kind === 'upload') await loadUploadAssets();
    else await loadGeneratedAssets();
    await loadFileFavorites();
    render();
}
function copyStorageFileItemsToCanvas(items, reportEmpty=false){
    try {
        const count = XiaomeiCanvasAssetInbox.write(items);
        if(count) setStatus(`已复制 ${count} 个素材，去智能画布按 Ctrl+V 粘贴`);
        else if(reportEmpty) setStatus('没有可复制的素材');
    } catch(error){
        setStatus('复制失败：' + (error?.message || error));
    }
}

async function importStorageFileItems(items){
    const images = items.filter(item => assetKind(item) === 'image');
    if(!images.length){ setStatus('请先选择图片素材'); return; }
    normalizeAssetState();
    const category = activeAssetCategory();
    if(!category){ setStatus('请先在“图片资产库”中创建分组'); return; }
    const data = await apiJson('/api/asset-library/items/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({library_id:activeAssetLibraryId,category_id:category.id,items:images.map(item => ({url:item.url,name:item.name}))})});
    assetLibrary = data.library || assetLibrary;
    setStatus(`已加入图片资产库 ${data.items?.length || 0} 张图片`);
}
async function deleteStorageFileItems(kind, items){
    if(!items.length) return;
    if(!confirm(`确认将 ${items.length} 个素材移入回收站？被画布或历史记录引用的素材需要先移除引用。`)) return;
    const data = await apiJson('/api/storage-files/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,items:items.map(item => item.rel)})});
    storageFileState(kind).selectedIds.clear(); storageFileState(kind).selectedId = '';
    await refreshStorageFileKind(kind);
    setStatus(`已将 ${data.removed || 0} 个素材移入回收站`);
}
async function renameStorageFileItem(kind, item, name){
    if(!item) return;
    const nextName = String(name || '').trim();
    if(!nextName || nextName === item.name) return;
    const data = await apiJson('/api/storage-files/organize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,action:'rename',items:[item.rel],name:nextName})});
    const nextRel = data.items?.[0]?.to;
    if(nextRel) storageFileState(kind).selectedId = `${kind}:${nextRel}`;
    await refreshStorageFileKind(kind);
    setStatus(`已重命名「${nextName}」`);
}
async function moveStorageFileRelsToFolder(kind, rels, folder){
    const unique = [...new Set(rels)].filter(Boolean);
    if(!unique.length) return;
    const target = folder || '';
    if(target && !storageFileState(kind).folders.some(entry => entry.path === target)) throw new Error('目标文件夹不存在，请刷新后重试');
    const data = await apiJson('/api/storage-files/organize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,action:'move',items:unique,folder:target})});
    const state = storageFileState(kind);
    state.selectedIds.clear(); state.selectedId = '';
    storageFileClipboards[kind] = null;
    await refreshStorageFileKind(kind);
    setStatus(`已移动 ${data.moved || 0} 个素材`);
}
function storageFolderParentPath(path){ return String(path || '').split('/').slice(0,-1).join('/'); }
async function reorderStorageFileFolder(kind, source, target, after){
    if(!source || !target || source === target || storageFolderParentPath(source) !== storageFolderParentPath(target)) return;
    const state = storageFileState(kind), parent = storageFolderParentPath(source);
    const paths = state.folders.filter(folder => storageFolderParentPath(folder.path) === parent).map(folder => folder.path);
    if(!paths.includes(source) || !paths.includes(target)) return;
    paths.splice(paths.indexOf(source), 1);
    paths.splice(paths.indexOf(target) + (after ? 1 : 0), 0, source);
    await apiJson('/api/storage-files/folders/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,parent,paths})});
    await refreshStorageFileKind(kind);
    setStatus('文件夹顺序已保存');
}
function openStorageFileMoveDialog(kind, items){
    if(!items.length) return;
    const state = storageFileState(kind), dialog = document.createElement('dialog');
    dialog.className = 'image-space-dialog';
    const folderButtons = [{path:'',name:'根目录'},...(state.folders || [])].map(folder => `<button class="asset-btn" type="button" data-target-folder="${escapeAttr(folder.path)}"><i data-lucide="folder"></i>${escapeHtml(folder.path || folder.name)}</button>`).join('');
    dialog.innerHTML = `<div class="detail-caption-head"><strong>移动 ${items.length} 个素材到文件夹</strong><button class="asset-btn" type="button" data-close-move>关闭</button></div><div class="local-upload-move-folders">${folderButtons}</div>`;
    dialog.addEventListener('click', async event => {
        if(event.target.closest('[data-close-move]')){ dialog.close(); return; }
        const button = event.target.closest('[data-target-folder]');
        if(!button) return;
        button.disabled = true;
        try {
            await moveStorageFileRelsToFolder(kind, items.map(item => item.rel), button.dataset.targetFolder || '');
            dialog.close();
        } catch(error){ setStatus(error.message || '移动失败'); button.disabled = false; }
    });
    dialog.addEventListener('close', () => dialog.remove(), {once:true});
    document.body.append(dialog); dialog.showModal(); refreshIcons();
}
async function manageStorageFileFolder(kind, action){
    const state = storageFileState(kind), folder = state.folder || '';
    if(action !== 'create' && !folder) return;
    let name = '';
    if(action !== 'delete'){
        name = prompt(action === 'create' ? '新文件夹名称' : '重命名文件夹', action === 'create' ? '' : folder.split('/').pop());
        if(name === null || !name.trim()) return;
    } else if(!confirm(`将文件夹「${folder}」中的素材移入回收站？被引用的素材无法删除。`)) return;
    const data = await apiJson('/api/storage-files/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,action,folder,name})});
    if(action === 'rename') state.folder = data.folder || '';
    if(action === 'delete') state.folder = '';
    await refreshStorageFileKind(kind);
    setStatus(action === 'create' ? '文件夹已创建' : action === 'rename' ? '文件夹已重命名' : '文件夹已移入回收站');
}
function annotationRecords({kind, libraryId}){
    if(kind === 'local') return localAssets;
    if(kind === 'library'){
        const library = assetLibraries().find(entry => entry.id === libraryId);
        return (library?.categories || []).filter(group => (group.type || 'image') === 'image')
            .flatMap(group => group.items || []);
    }
    return storageFileState(kind).items;
}
function refreshAnnotationFilters({kind}, operation){
    if(operation !== 'classify' || !['upload','generated'].includes(kind)) return;
    const state = storageFileState(kind);
    const filters = imageSpaceState.filters[kind];
    const affected = state.query || filters.annotated || filters.tags
        || Object.keys(imageSpaceDimensions).some(key => filters[key]);
    if(!affected) return;
    if(kind === 'upload') return loadUploadAssets({background:true});
    return loadGeneratedAssets({preserveSelection:true});
}
function redrawAnnotations(){
    const focused = document.activeElement;
    const keepFocus = root.contains(focused) && focused.matches?.('[data-annotation-draft],#localCaptionPrompt,#localClassifyPrompt');
    const range = keepFocus ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    render();
    if(!keepFocus) return;
    const next = document.getElementById(focused.id);
    if(!next || next.dataset.annotationDraft !== focused.dataset.annotationDraft) return;
    next.focus({preventScroll:true});
    if(range[0] != null) next.setSelectionRange(...range);
}
async function backgroundStorageFileItems(items){
    const images = items.filter(item => assetKind(item) === 'image');
    if(!images.length || backgroundRemovalBusy) return;
    backgroundRemovalBusy = true; render();
    let done = 0, failed = [];
    try {
        const engine = await ensureBackgroundRemovalEngine();
        if(!engine) return;
        for(const item of images){
            try {
                const data = await apiJson('/api/image/background-removal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_url:item.url,name:item.name,auto_center:true,backend:engine.backend,model_id:engine.modelId})});
                if(data.pending) throw new Error('抠图任务尚未完成，请在任务列表查看');
                done++;
            } catch(error){ failed.push(`${item.name}：${error.message || '失败'}`); }
        }
        setStatus(failed.length ? `已生成 ${done} 张透明底图片，${failed.length} 张失败：${failed[0]}` : `已生成 ${done} 张透明底图片，可在生成素材中查看`);
    } finally { backgroundRemovalBusy = false; render(); }
}
const assetStorageActions = XiaomeiAssetManagerInteractions.create([{
    'generated-upload': () => document.getElementById('generatedUploadInput')?.click(),
    'upload-library-view'(){
        uploadAssetsState.view = 'library';
        imageSpaceState.collectionId = '';
        render();
    },
    'upload-fav-filter'(_value, _control, _event, {kind, state}){
        state.favoritesOnly = !state.favoritesOnly;
        return refreshStorageFileKind(kind);
    },
    'upload-type'(value, _control, _event, {kind, state}){
        state.mediaType = value || 'all';
        return refreshStorageFileKind(kind);
    },
    'space-folder'(value, _control, _event, {kind, state}){
        state.folder = value;
        imageSpaceState.all[kind] = false;
        imageSpaceState.collectionId = '';
        if(kind === 'generated') clearCanvasAssetScope();
        return refreshStorageFileKind(kind);
    },
    'space-folder-new': (_value, _control, _event, {kind}) => manageStorageFileFolder(kind, 'create'),
    'space-folder-rename': (_value, _control, _event, {kind}) => manageStorageFileFolder(kind, 'rename'),
    'space-folder-delete': (_value, _control, _event, {kind}) => manageStorageFileFolder(kind, 'delete'),
    async 'space-file-favorite'(id, _control, _event, {kind, state}){
        const item = state.items.find(record => record.id === id);
        if(!item) return;
        await toggleFileFavorite(kind, item);
        if(kind === 'upload' ? state.favoritesOnly : generatedFavoritesOnly) await refreshStorageFileKind(kind);
    },
    'space-file-preview': (id, _control, _event, {state}) => openAssetPreview(state.items.find(item => item.id === id)),
    'space-file-download-one': (id, _control, _event, {state}) => runStorageItemAction(state, id, items => assetMedia.download(items, 'storage')),
    'space-file-rename'(){
        const input = root.querySelector('[data-space-file-inline-name]');
        input?.focus();
        input?.select();
    },
    'space-file-move-one': (id, _control, _event, {kind, state}) =>
        runStorageItemAction(state, id, items => openStorageFileMoveDialog(kind, items)),
    'space-file-delete-one': (id, _control, _event, {kind, state}) =>
        runStorageItemAction(state, id, items => deleteStorageFileItems(kind, items)),
    'space-file-caption-one': (id, _control, _event, {kind, state}) =>
        runStorageItemAction(state, id, items => annotations.run(kind, 'caption', items, {single:true})),
    'space-file-caption-copy': (id, _control, _event, {kind, state}) =>
        annotations.copy(kind, state.items.find(record => record.id === id)),
    'space-file-caption-save': (id, _control, _event, {kind, state}) =>
        annotations.save(kind, state.items.find(record => record.id === id)),
    'space-file-manage'(_value, _control, _event, {kind, state}){
        const managing = kind === 'upload' ? (state.manageMode = !state.manageMode) : (generatedManageMode = !generatedManageMode);
        if(!managing) state.selectedIds.clear();
        render();
    },
    'space-file-select-all': (_value, _control, _event, {state}) => selectAssetItems(state.selectedIds, state.items),
    'space-file-clear': (_value, _control, _event, {state}) => clearAssetItems(state.selectedIds),
    'space-file-check'(id, checkbox, _event, {state}){
        state.selectedId = id;
        if(checkbox.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        render();
    },
    'space-file-download': (_value, _control, _event, {kind}) => assetMedia.download(storageFileSelectedItems(kind), 'storage'),
    'space-file-canvas': (_value, _control, _event, {kind}) => copyStorageFileItemsToCanvas(storageFileSelectedItems(kind)),
    'space-file-import': (_value, _control, _event, {kind}) => importStorageFileItems(storageFileSelectedItems(kind)),
    'space-file-cut'(_value, _control, _event, {kind, state}){
        const selected = storageFileSelectedItems(kind);
        if(!selected.length) return;
        storageFileClipboards[kind] = {rels:selected.map(item => item.rel), folders:selected.map(item => item.folder || '')};
        state.selectedIds.clear();
        render();
        setStatus('已剪切 ' + selected.length + ' 个素材，切换到目标文件夹后点击移动');
    },
    'space-file-cut-clear'(_value, _control, _event, {kind}){
        storageFileClipboards[kind] = null;
        render();
    },
    'space-file-paste'(_value, _control, _event, {kind, state}){
        const clipboard = storageFileClipboards[kind];
        if(clipboard) return moveStorageFileRelsToFolder(kind, clipboard.rels, state.folder || '');
    },
    'space-file-move': (_value, _control, _event, {kind}) => openStorageFileMoveDialog(kind, storageFileSelectedItems(kind)),
    'space-file-delete': (_value, _control, _event, {kind}) => deleteStorageFileItems(kind, storageFileSelectedItems(kind)),
    'space-file-classify': (_value, _control, _event, {kind}) => annotations.run(kind, 'classify', storageFileSelectedItems(kind)),
    'space-file-caption': (_value, _control, _event, {kind}) => annotations.run(kind, 'caption', storageFileSelectedItems(kind)),
    'space-file-background': (_value, _control, _event, {kind}) => backgroundStorageFileItems(storageFileSelectedItems(kind)),
    'space-file-card'(id, _control, _event, {kind, state}){
        state.selectedId = id;
        if(kind === 'upload' ? state.manageMode : generatedManageMode) toggleSelectionSet(state.selectedIds, id);
        render();
    },
}]);

function runStorageItemAction(state, id, action){
    const item = state.items.find(record => record.id === id);
    if(item) return action([item]);
}
function selectAssetItems(selection, items){
    for(const item of items) selection.add(item.id);
    pendingBatchDelete = '';
    render();
}
function clearAssetItems(selection){
    selection.clear();
    pendingBatchDelete = '';
    render();
}
function pickAssetItem(selection, current, id, managing){
    if(!managing) return id;
    if(toggleSelectionSet(selection, id)) return id;
    return current === id ? '' : current;
}
function copyAssetText(text, success){
    return assetMedia.copyText(text).then(ok => setStatus(ok ? success : '复制失败'));
}
function openAssetUpload(accept){
    if(!uploadInput) return;
    if(accept) uploadInput.accept = accept;
    uploadInput.click();
}
function selectAssetCard(id, checkbox){
    if(checkbox && !assetManageMode) return;
    selectedAssetId = pickAssetItem(selectedAssetIds, selectedAssetId, id, assetManageMode);
    if(!assetManageMode){
        assetDetail.clear();
        pendingDeleteAssetId = '';
    }
    pendingBatchDelete = '';
    render();
}
function selectWorkflowCard(id, checkbox){
    if(checkbox && !workflowManageMode) return;
    selectedWorkflowId = pickAssetItem(selectedWorkflowIds, selectedWorkflowId, id, workflowManageMode);
    if(!workflowManageMode) workflows.clearConfirmation();
    pendingBatchDelete = '';
    render();
}
function selectPromptRow(id, checkbox, control){
    const {library, item} = promptControlTarget(id, control);
    if(!item) return;
    if(activeTab === 'prompt-hub'){
        if(checkbox) return;
        selectedPromptId = id;
        selectedPromptLibraryId = library.id;
    } else {
        if(checkbox && !promptManageMode) return;
        selectedPromptId = pickAssetItem(selectedPromptIds, selectedPromptId, id, promptManageMode);
    }
    promptTemplates.clearConfirmation();
    pendingBatchDelete = '';
    render();
}
function selectLocalUploadCard(id, checkbox){
    selectedLocalUploadId = pickAssetItem(selectedLocalUploadIds, selectedLocalUploadId, id, checkbox || localUploadManageMode);
    pendingBatchDelete = '';
    if(checkbox || localUploadManageMode) render();
    else refreshLocalUploadSelectionOnly();
}
function selectCanvasAssetCard(id, checkbox){
    if(checkbox && !canvasAssetManageMode) return;
    selectedCanvasAssetId = pickAssetItem(selectedCanvasAssetIds, selectedCanvasAssetId, id, canvasAssetManageMode);
    pendingBatchDelete = '';
    refreshCanvasAssetSelectionOnly();
}
function selectLocalUploadScope({project = '', canvas = '', folder = '', folderSelected = false}){
    localFiles.cancelFolder(false);
    if(folderSelected) imageSpaceState.all.local = false;
    imageSpaceState.collectionId = '';
    localUploadProjectId = project;
    localUploadCanvasId = canvas;
    activeLocalUploadFolder = folder;
    selectedLocalUploadId = '';
    selectedLocalUploadIds.clear();
    if(folderSelected) pendingBatchDelete = pendingTreeDelete = '';
    render();
}
function selectCanvasAssetScope(project, canvas){
    activeTab = 'generated';
    generatedFavoritesOnly = false;
    imageSpaceState.collectionId = '';
    if(!canvas) generatedAssetsState.selectedIds.clear();
    activeCanvasAssetProjectId = project || canvasProjects.defaultProject();
    activeCanvasAssetCanvasId = canvas;
    selectedCanvasAssetId = '';
    selectedCanvasAssetIds.clear();
    render();
}
function selectAssetScope({library, category, focus}){
    assetDetail.clear();
    if(library) activeAssetLibraryId = library;
    if(focus === 'category'){
        imageSpaceState.all.assets = false;
        imageSpaceState.collectionId = '';
    }
    activeAssetCategoryId = category ?? (assetCategories()[0]?.id || '');
    assetTreeFocus = focus;
    selectedAssetId = '';
    selectedAssetIds.clear();
    render();
}
function selectPromptScope(library, category, focus){
    activePromptLibraryId = library;
    activePromptCategory = category || 'all';
    promptTreeFocus = focus;
    selectedPromptId = '';
    selectedPromptIds.clear();
    promptTemplates.clearConfirmation();
    render();
}
function selectWorkflowScope(library, category){
    workflows.clearConfirmation();
    activeWorkflowLibraryId = library;
    activeWorkflowCategoryId = category;
    selectedWorkflowId = '';
    selectedWorkflowIds.clear();
    render();
}
const treeDrafts = {
    asset: {get:() => assetTreeEdit, set:edit => { assetTreeEdit = edit; }},
    workflow: {get:() => workflowTreeEdit, set:edit => { workflowTreeEdit = edit; }},
    prompt: {get:() => promptTreeEdit, set:edit => { promptTreeEdit = edit; }},
};
const treeInputKinds = {
    assetTreeEditInput:'asset',
    workflowTreeEditInput:'workflow',
    promptTreeEditInput:'prompt',
};

function catalogScope(type){
    if(type === 'asset') return {libraryId:activeAssetLibrary()?.id || '', categoryId:activeAssetCategory()?.id || ''};
    if(type === 'workflow'){
        const category = activeWorkflowCategory();
        return {libraryId:category?.__libraryId || activeWorkflowLibrary()?.id || '', categoryId:category?.id || ''};
    }
    return {libraryId:activePromptLibrary()?.id || 'system', categoryId:activePromptCategory};
}
function catalogVisible(type){
    if(type === 'asset') return activeTab === 'assets' && uploadAssetsState.view === 'library';
    return activeTab === (type === 'prompt' ? 'prompts' : 'workflows');
}
function catalogIsCurrent(type, owner, compareCategory=true){
    const current = catalogScope(type);
    return catalogVisible(type) && current.libraryId === owner.libraryId
        && (!compareCategory || current.categoryId === owner.categoryId);
}
function applyCatalogReply(type, data){
    if(!data.library) return;
    if(type === 'prompt') applyPromptCatalog(data);
    else {
        const oldVersion = Number(assetLibrary.updated_at || 0);
        const nextVersion = Number(data.library.updated_at || 0);
        if(!oldVersion || !nextVersion || nextVersion >= oldVersion) assetLibrary = data.library;
    }
}
function applyPromptCatalog(data){
    if(!data.library) return false;
    const previous = Number(promptLibrary.updated_at || 0);
    const incoming = Number(data.library.updated_at || 0);
    if(previous && incoming && incoming < previous) return false;
    promptLibraryRevision++;
    promptLibrary = data.library;
    return true;
}
function startCatalogEdit(type, kind, position, value, label){
    treeDrafts[type].set({kind, position, value, label, ...catalogScope(type)});
    if(kind !== 'library-new' && (type !== 'prompt' || kind.startsWith('category-'))) pendingTreeDelete = '';
    render();
    if(position === 'head' || type === 'workflow') focusTreeEditInput(type + 'TreeEditInput');
}
function startAssetTreeEdit(kind, field, initial, label, placement){
    if(field) assetTreeFocus = field;
    startCatalogEdit('asset', kind, placement || (assetTreeFocus === 'category' ? 'child' : 'library'), initial, label);
}
function startPromptTreeEdit(kind, field, initial, label, placement){
    promptTreeFocus = field;
    startCatalogEdit('prompt', kind, placement || (field === 'category' ? 'child' : 'library'), initial, label);
}
function startWorkflowCategoryEdit(renaming){
    const category = activeWorkflowCategory();
    if(renaming && !category) return;
    startCatalogEdit('workflow', renaming ? 'category-rename' : 'category-new', renaming ? 'child' : 'head',
        renaming ? category.name || '' : '新工作流分组', '工作流分组名称');
}
function cancelCatalogEdit(type){
    treeDrafts[type].set(null);
    render();
}
function selectSavedCatalogEntry(type, edit, data){
    if(type === 'asset'){
        if(edit.kind === 'library-new'){
            activeAssetLibraryId = data.asset_library?.id || activeAssetLibraryId;
            activeAssetCategoryId = '';
        }
        if(edit.kind === 'category-new') activeAssetCategoryId = data.category?.id || activeAssetCategoryId;
        assetTreeFocus = edit.kind.startsWith('category-') ? 'category' : 'library';
    } else if(type === 'workflow'){
        activeWorkflowLibraryId = edit.libraryId;
        activeWorkflowCategoryId = data.category?.id || edit.categoryId;
    } else {
        if(edit.kind === 'library-new'){
            activePromptLibraryId = data.prompt_library?.id || activePromptLibraryId;
            activePromptCategory = 'all';
        }
        if(edit.kind === 'category-new') activePromptCategory = data.category?.id || activePromptCategory;
        promptTreeFocus = edit.kind.startsWith('category-') ? 'category' : 'library';
    }
}
async function saveCatalogEdit(type){
    const state = treeDrafts[type];
    const edit = state.get();
    if(!edit || catalogWriter.pending(edit)) return;
    const input = document.getElementById(type + 'TreeEditInput');
    if(input) edit.value = input.value;
    if(!edit.value.trim()){ setStatus('名称不能为空'); return; }
    if(edit.kind !== 'library-new' && !edit.libraryId){ setStatus('请先选择资产库'); return; }
    if(edit.kind === 'category-rename' && !edit.categoryId) return;
    const request = catalogWriter.save(type, edit);
    if(!request) return;
    const saveSelector = '[data-' + type + '-tree-edit-save]';
    const button = root.querySelector(saveSelector);
    if(button) button.disabled = true;
    if(input) input.disabled = true;
    try {
        const data = await request;
        const sameDraft = state.get() === edit;
        const keepScope = sameDraft && catalogIsCurrent(type, edit);
        applyCatalogReply(type, data);
        if(sameDraft) state.set(null);
        if(keepScope){
            pendingTreeDelete = '';
            selectSavedCatalogEntry(type, edit, data);
        }
        if(catalogVisible(type)) render();
        setStatus('已保存');
    } finally {
        if(state.get() === edit){
            const activeButton = root.querySelector(saveSelector);
            const activeInput = document.getElementById(type + 'TreeEditInput');
            if(activeButton) activeButton.disabled = false;
            if(activeInput) activeInput.disabled = false;
        }
    }
}
function selectAfterCatalogDelete(type, entity){
    if(type === 'asset'){
        if(entity === 'library') activeAssetLibraryId = assetLibrary.active_library_id || assetLibraries()[0]?.id || '';
        activeAssetCategoryId = '';
        selectedAssetId = '';
        selectedAssetIds.clear();
    } else if(type === 'workflow'){
        activeWorkflowCategoryId = '';
        selectedWorkflowId = '';
        selectedWorkflowIds.clear();
    } else {
        if(entity === 'library') {
            activePromptLibraryId = promptLibrary.active_library_id || promptLibraries()[0]?.id || 'system';
            selectedPromptId = '';
            selectedPromptIds.clear();
        }
        activePromptCategory = 'all';
    }
}
async function deleteCatalogEntry(type, entity){
    const owner = catalogScope(type);
    const category = entity === 'category';
    if(!owner.libraryId || (category && (!owner.categoryId || owner.categoryId === 'all'))) return;
    if(type === 'prompt' && !category && owner.libraryId === 'system'){
        setStatus('系统提示词模板库不能删除');
        return;
    }
    const name = category ? (type === 'workflow' ? '工作流分组' : '分组') : (type === 'prompt' ? '提示词模板库' : '资产库');
    const key = category ? type + '-cat:' + owner.libraryId + ':' + owner.categoryId : type + '-lib:' + owner.libraryId;
    if(pendingTreeDelete !== key){
        pendingTreeDelete = key;
        treeDrafts[type].set(null);
        if(type === 'workflow') workflows.clearConfirmation();
        render();
        setStatus('再次点击确认删除' + name);
        return;
    }
    const request = catalogWriter.remove(type, entity, owner.libraryId, owner.categoryId);
    if(!request) return;
    const data = await request;
    const keepScope = catalogIsCurrent(type, owner, category);
    applyCatalogReply(type, data);
    if(keepScope) selectAfterCatalogDelete(type, entity);
    if(pendingTreeDelete === key) pendingTreeDelete = '';
    if(catalogVisible(type)) render();
    setStatus(name + '已删除');
}


function useAssetTreeRow(control, category){
    const row = control.closest(category ? '[data-asset-cat]' : '[data-asset-lib]');
    if(!row) return;
    activeAssetLibraryId = (category ? row.dataset.assetCatLib : row.dataset.assetLib) || activeAssetLibraryId;
    if(category) activeAssetCategoryId = row.dataset.assetCat || activeAssetCategoryId;
}
function startPromptCreation(){
    promptTemplates.clearConfirmation();
    const category = activePromptCategory === 'all' ? 'custom' : activePromptCategory;
    promptTemplates.showEditor(activePromptLibrary(), null, category);
}
function clearPromptHubEditor(){
    selectedPromptId = '';
    selectedPromptLibraryId = '';
    promptTemplates.close(false);
    promptTemplates.clearConfirmation();
    render();
}
async function changeAssetTab(tab){
    imageSpaceState.collectionId = '';
    clearCanvasAssetScope();
    activeTab = tab || 'assets';
    localFiles.cancelFolder(false);
    localFiles.closeMove();
    promptTemplates.close(false);
    promptTemplates.clearConfirmation();
    selectedPromptLibraryId = '';
    if(activeTab === 'assets') uploadAssetsState.view = 'disk';
    const selections = [selectedAssetIds, selectedWorkflowIds, selectedPromptIds,
        selectedLocalUploadIds, selectedCanvasAssetIds, generatedAssetsState.selectedIds];
    for(const selection of selections) selection.clear();
    render();
    if(activeTab === 'generated' && !generatedAssetsState.loaded){
        await loadGeneratedAssets().catch(error => setStatus(error.message || '加载生成素材失败'));
    } else if(activeTab === 'assets' && !uploadAssetsState.loaded){
        await loadUploadAssets().catch(error => setStatus(error.message || '读取上传素材失败'));
    }
}
function refreshCurrentAssetPage(){
    if(isCanvasAssetView()) return refreshCanvasAssets();
    if(activeTab === 'generated') return loadGeneratedAssets();
    return loadAll();
}
function loadUploadScope(project, canvas, failure){
    Object.assign(uploadAssetsState, {view:'disk', projectId:project, canvasId:canvas, selectedId:''});
    return loadUploadAssets().catch(error => setStatus(error.message || failure));
}


const assetPageActions = XiaomeiAssetManagerInteractions.create([{
    'tab': changeAssetTab,
    '#refreshBtn': () => refreshCurrentAssetPage(),
    'image-space-retry': () => loadAll(),
    'asset-favorite': (id, _control, event) => runFavoriteAction(event, () => toggleAssetItemFavorite(id)),
    'workflow-favorite': (id, _control, event) => runFavoriteAction(event, () => workflows.favorite(id)),
    'localup-favorite': (id, _control, event) => runFavoriteAction(event, () => {
        const item = findLocalUpload(id);
        if(item) return toggleFileFavorite('local', item);
    }),
    'prompt-favorite': (id, control, event) => runFavoriteAction(event, () => {
        const {library, item} = promptControlTarget(id, control);
        return promptTemplates.toggleFavorite(library, item);
    }),
    'case-favorite': (id, _control, event) => runFavoriteAction(event, () => toggleCaseFavorite(id)),
    'asset-fav-filter'(){ assetFavoritesOnly = !assetFavoritesOnly; render(); },
    'workflow-fav-filter'(){ workflowFavoritesOnly = !workflowFavoritesOnly; render(); },
    'localup-fav-filter'(){ localFavoritesOnly = !localFavoritesOnly; render(); },
    'generated-fav-filter'(){
        clearCanvasAssetScope();
        generatedFavoritesOnly = !generatedFavoritesOnly;
        return loadGeneratedAssets();
    },
    'generated-projects-toggle'(){
        generatedProjectsCollapsed = !generatedProjectsCollapsed;
        try { localStorage.setItem(GENERATED_PROJECTS_COLLAPSED_KEY, generatedProjectsCollapsed ? '1' : '0'); } catch(_) {}
        render();
    },
    'generated-type'(type){
        const next = type || 'all';
        const reload = !generatedAssetsState.loaded || generatedAssetsState.mediaType !== next || generatedAssetsState.folder;
        clearCanvasAssetScope();
        generatedFavoritesOnly = false;
        Object.assign(generatedAssetsState, {mediaType:next, folder:'', selectedId:''});
        generatedAssetsState.selectedIds.clear();
        if(reload) return loadGeneratedAssets();
        render();
    },
    'generated-manage'(){
        generatedManageMode = !generatedManageMode;
        if(!generatedManageMode) generatedAssetsState.selectedIds.clear();
        render();
    },
    async 'generated-refresh'(){
        await loadGeneratedAssets();
        setStatus('生成素材已刷新');
    },
    'upload-disk-view'(){
        if(activeTab !== 'assets') return;
        uploadAssetsState.view = 'disk';
        render();
        if(!uploadAssetsState.loaded) return loadUploadAssets().catch(error => setStatus(error.message || '读取上传素材失败'));
    },
    'upload-retry': () => loadUploadAssets().catch(error => setStatus(error.message || '读取上传素材失败')),
    'upload-project': id => loadUploadScope(id, '', '读取项目素材失败'),
    'upload-canvas': (id, control) => loadUploadScope(control.dataset.materialProject || uploadAssetsState.projectId, id, '读取画布素材失败'),
    'asset-preview': id => openAssetPreview(findLibraryMedia(id)),
    'canvas-asset-preview': id => openAssetPreview(findCanvasAssetItem(id)),
    'localup-preview': id => openAssetPreview(findLocalUpload(id)),
}, {
    'hub-view'(view){
        hubView = view || 'cases';
        if(hubView === 'cases') hubCaseCategory = '';
        clearPromptHubEditor();
    },
    'hub-prompt-view'(view){
        hubView = 'prompts';
        hubPromptView = view || 'mine';
        clearPromptHubEditor();
    },
    'hub-case-cat'(category){ hubView = 'cases'; hubCaseCategory = category; render(); },
    'hub-case-tag'(tag){ hubTag = hubTag === tag ? '' : tag; render(); },
    'hub-case-tag-clear'(){ hubTag = ''; render(); },
    'hub-case-cats': () => openCaseCategoryModal(),
    'hub-cases-refresh': () => loadPromptCases(),
    'hub-clear-filters'(){ hubQuery = hubCaseCategory = hubTag = ''; render(); },
    'hub-prompt-new'(){
        const selected = promptLibraries().find(library => library.id === selectedPromptLibraryId && library.id !== 'system' && !library.readonly);
        const {userLibs, systemLib} = promptHubLibraryGroups();
        const library = selected || userLibs.find(entry => !entry.readonly) || systemLib;
        promptTemplates.showEditor(library, null, 'custom');
    },
    'hub-case-open': id => openPromptCase(id),
    'hub-case-card'(id){ selectedHubCaseId = id; render(); },
    'case-apply': id => applyCaseToCanvas(id),
    'case-copy': id => copyCasePrompt(id),
    'case-delete': id => deleteCaseItem(id),
    'case-cat-rename': id => renameCaseCategory(id),
    'case-cat-delete': id => removeCaseCategory(id),
    '#addCaseCategoryButton': () => addCaseCategory(),
    'close-case-drawer': () => closePromptCaseDrawer(),
    'close-case-category-modal': () => closeCaseCategoryModal(),
}, {
    'localup-upload': () => openAssetUpload(),
    async 'localup-refresh'(){
        const [files, scope] = await Promise.allSettled([localFiles.load(), loadCanvasAssets()]);
        render();
        if(files.value !== true) return;
        setStatus(scope.status === 'fulfilled' ? '本地素材已刷新'
            : '本地素材已刷新，项目归属更新失败：' + (scope.reason?.message || '请重试'));
    },
    'localup-type'(type){
        localUploadMediaType = type || 'all';
        imageSpaceState.collectionId = '';
        clearAssetItems(selectedLocalUploadIds);
    },
    'localup-project': project => selectLocalUploadScope({project}),
    'localup-canvas': (canvas, control) => selectLocalUploadScope({canvas, project:control.dataset.materialProject || localUploadProjectId}),
    'localup-folder-new': () => localFiles.startFolder(),
    'localup-folder-create-save': () => localFiles.folderAction('create'),
    'localup-folder-create-cancel': () => localFiles.cancelFolder(),
    'localup-folder-rename': () => localFiles.folderAction('rename'),
    'localup-folder-delete': () => localFiles.folderAction('delete'),
    'localup-folder': folder => selectLocalUploadScope({folder, folderSelected:true}),
    'localup-manage'(){
        localUploadManageMode = !localUploadManageMode;
        if(!localUploadManageMode) selectedLocalUploadIds.clear();
        render();
    },
    'localup-select-all': () => selectAssetItems(selectedLocalUploadIds, localUploadVisibleItems()),
    'localup-clear': () => clearAssetItems(selectedLocalUploadIds),
    'localup-download-selected': () => assetMedia.download([...selectedLocalUploadIds].map(findLocalUpload), 'local'),
    'localup-canvas-selected': () => copySelectedLocalUploadsToCanvas(),
    'localup-cut-selected': () => localFiles.cut(),
    'localup-move-selected': () => localFiles.openMove([...selectedLocalUploadIds]),
    'localup-import-selected': () => importStorageFileItems([...selectedLocalUploadIds].map(findLocalUpload).filter(Boolean)),
    'localup-background-selected': () => backgroundStorageFileItems([...selectedLocalUploadIds].map(findLocalUpload).filter(Boolean)),
    'localup-paste-clipboard': () => localFiles.paste(),
    'localup-clear-clipboard': () => localFiles.clearClipboard(),
    'localup-download': id => assetMedia.download([findLocalUpload(id)], 'local'),
    'localup-delete-selected': () => localFiles.remove([...selectedLocalUploadIds]),
    'local-classify-toggle': () => annotations.toggle(),
    'local-classify-run': () => annotations.run('local', 'classify', selectedLocalUploadImageItems()),
    'local-caption-run': () => annotations.run('local', 'caption', selectedLocalUploadImageItems()),
    'localup-caption-one': id => annotations.run('local', 'caption', [findLocalUpload(id)], {single:true}),
    'localup-caption-copy': id => annotations.copy('local', findLocalUpload(id)),
    'localup-caption-save': id => annotations.save('local', findLocalUpload(id)),
    'localup-rename'(id, _control, event){ event.stopPropagation(); localFiles.startRename(id); },
    'localup-move-one'(id, _control, event){ event.stopPropagation(); localFiles.openMove([id]); },
    'localup-delete-one': id => localFiles.remove([id]),
    'localup-background-one'(id){
        const item = findLocalUpload(id);
        if(item) return backgroundStorageFileItems([item]);
    },
    'localup-copy': id => copyAssetText(findLocalUpload(id)?.url || '', '已复制链接'),
    'localup-check': id => selectLocalUploadCard(id, true),
    'localup-card': id => selectLocalUploadCard(id, false),
}, {
    'canvas-asset-project': id => selectCanvasAssetScope(id, ''),
    'canvas-asset-canvas': (id, control) =>
        selectCanvasAssetScope(control.dataset.canvasAssetCanvasProject || activeCanvasAssetProjectId || 'default', id),
    'canvas-asset-manage'(){
        canvasAssetManageMode = !canvasAssetManageMode;
        if(!canvasAssetManageMode) selectedCanvasAssetIds.clear();
        render();
    },
    'canvas-asset-refresh': () => refreshCanvasAssets(),
    'canvas-asset-select-all': () => selectAssetItems(selectedCanvasAssetIds, currentCanvasAssetItems()),
    'canvas-asset-clear-selection': () => clearAssetItems(selectedCanvasAssetIds),
    'canvas-asset-download-selected': () => assetMedia.download([...selectedCanvasAssetIds].map(findCanvasAssetItem), 'canvas'),
    'canvas-asset-download': id => assetMedia.download([findCanvasAssetItem(id)], 'canvas'),
    'canvas-asset-open'(id){
        const url = findCanvasAssetItem(id)?.url;
        if(url) window.open(url, '_blank', 'noopener');
    },
    'canvas-asset-copy': id => copyAssetText(findCanvasAssetItem(id)?.url || '', '已复制画布资产链接'),
    'canvas-asset-check': id => selectCanvasAssetCard(id, true),
    'canvas-asset-card': id => selectCanvasAssetCard(id, false),
}, {
    'workflow-manage'(){
        workflowManageMode = !workflowManageMode;
        if(!workflowManageMode) selectedWorkflowIds.clear();
        workflows.clearConfirmation();
        render();
    },
    'workflow-select-all': () => selectAssetItems(selectedWorkflowIds, currentWorkflowItems()),
    'workflow-clear-selection': () => clearAssetItems(selectedWorkflowIds),
    'workflow-export-selected': () => workflows.exportFiles([...selectedWorkflowIds]),
    'workflow-export-desktop-selected': () => workflows.exportFiles([...selectedWorkflowIds], true),
    'workflow-delete-selected': () => workflows.trash([...selectedWorkflowIds]),
    'workflow-upload': () => openAssetUpload('.json,.zip,application/json,application/zip,application/x-zip-compressed'),
    'workflow-insert': id => workflows.insert(id),
    'workflow-export-desktop': id => workflows.exportFiles([id], true),
    'workflow-delete': id => workflows.trash([id], true),
    'workflow-cat-new': () => startWorkflowCategoryEdit(false),
    'workflow-cat-rename': () => startWorkflowCategoryEdit(true),
    'workflow-cat-delete': () => deleteCatalogEntry('workflow', 'category'),
    'workflow-cat': (category, control) => selectWorkflowScope(control.dataset.workflowCatLib || activeWorkflowLibraryId, category),
    'workflow-check': id => selectWorkflowCard(id, true),
    'workflow-card': id => selectWorkflowCard(id, false),
    'workflow-tree-edit-save': () => saveCatalogEdit('workflow'),
    'workflow-tree-edit-cancel': () => cancelCatalogEdit('workflow'),
}, {
    'asset-tree-edit-save': () => saveCatalogEdit('asset'),
    'asset-tree-edit-cancel': () => cancelCatalogEdit('asset'),
    'asset-edit-save': id => assetDetail.save(assetDetailRecord(id), true),
    'asset-edit-cancel'(){ assetDetail.clear(); render(); },
    'asset-context-background-remove'(){
        const id = document.getElementById('assetContextMenu')?.dataset.assetId || assetContextMenuId;
        if(id) return runAssetBackgroundRemoval([id]);
    },
    'asset-background-remove': id => runAssetBackgroundRemoval([id]),
    'asset-background-remove-selected': () => runAssetBackgroundRemoval([...selectedAssetIds]),
    'asset-edit-start'(id){
        pendingDeleteAssetId = '';
        assetDetail.start(assetDetailRecord(id));
    },
    'asset-manage'(){
        assetManageMode = !assetManageMode;
        pendingBatchDelete = '';
        if(!assetManageMode) selectedAssetIds.clear();
        render();
    },
    'asset-select-all': () => selectAssetItems(selectedAssetIds, currentAssetItems()),
    'asset-clear-selection': () => clearAssetItems(selectedAssetIds),
    'asset-cut-selected': () => assetTransfers.set('cut'),
    'asset-copy-selected': () => assetTransfers.set('copy'),
    'asset-paste-clipboard': () => assetTransfers.paste(),
    'asset-clear-clipboard': () => assetTransfers.clear(),
    'asset-delete': id => assetTransfers.remove([id]),
    'asset-download': id => assetMedia.download([findLibraryMedia(id)], 'asset'),
    'avatar-copy': uri => avatarReviews.copy(uri),
    'avatar-register': (id, control) => avatarReviews.handle(control, id, true),
    'avatar-check': (id, control) => avatarReviews.handle(control, id, false),
    'asset-classify-selected': () => annotations.run('library', 'classify', selectedAssetImageItems(), {libraryId:activeAssetLibrary()?.id}),
    'asset-download-selected': () => assetMedia.download([...selectedAssetIds].map(findLibraryMedia), 'asset'),
    'asset-copy-to-canvas': () => copySelectedAssetsToCanvas(),
    'asset-delete-selected': () => assetTransfers.remove(selectedAssetIds),
    'asset-upload': () => openAssetUpload('image/*,video/*,audio/*'),
    'asset-lib-new': () => startAssetTreeEdit('library-new', 'library', '新资产库', '资产库名称', 'head'),
    'asset-lib-rename'(_id, control){
        useAssetTreeRow(control, false);
        startAssetTreeEdit('library-rename', 'library', activeAssetLibrary()?.name || '', '资产库名称');
    },
    'asset-lib-delete'(_id, control){
        useAssetTreeRow(control, false);
        return deleteCatalogEntry('asset', 'library');
    },
    'asset-cat-new'(_id, control){
        useAssetTreeRow(control, false);
        const category = control.closest('[data-asset-cat]');
        if(category?.dataset.assetCatLib) activeAssetLibraryId = category.dataset.assetCatLib;
        startAssetTreeEdit('category-new', '', '新分组', '分组名称');
    },
    'asset-cat-rename'(_id, control){
        useAssetTreeRow(control, true);
        startAssetTreeEdit('category-rename', 'category', activeAssetCategory()?.name || '', '分组名称');
    },
    'asset-cat-delete'(_id, control){
        useAssetTreeRow(control, true);
        return deleteCatalogEntry('asset', 'category');
    },
    'asset-lib': library => selectAssetScope({library, focus:'library'}),
    'asset-cat': (category, control) => selectAssetScope({library:control.dataset.assetCatLib, category, focus:'category'}),
    'asset-check': id => selectAssetCard(id, true),
    'asset-card': id => selectAssetCard(id, false),
}, {
    'prompt-tree-edit-save': () => saveCatalogEdit('prompt'),
    'prompt-tree-edit-cancel': () => cancelCatalogEdit('prompt'),
    'prompt-edit-start'(id, control){
        const {library, item} = promptControlTarget(id, control);
        if(item) promptTemplates.showEditor(library, item);
    },
    'prompt-manage'(){
        promptManageMode = !promptManageMode;
        promptTemplates.clearConfirmation();
        pendingBatchDelete = '';
        if(!promptManageMode) selectedPromptIds.clear();
        render();
    },
    'prompt-select-all'(){
        promptTemplates.clearConfirmation();
        selectAssetItems(selectedPromptIds, currentPromptItems());
    },
    'prompt-clear-selection'(){
        promptTemplates.clearConfirmation();
        clearAssetItems(selectedPromptIds);
    },
    'prompt-delete'(id, control){
        const {library, item} = promptControlTarget(id, control);
        if(item) return promptTemplates.remove(library, [id]);
    },
    'prompt-delete-selected': () => promptTemplates.remove(activePromptLibrary(), [...selectedPromptIds], {batch:true}),
    'prompt-new'(_id, control){
        const library = control.dataset.libId || control.closest('[data-prompt-lib]')?.dataset.promptLib;
        const category = control.closest('[data-prompt-cat]')?.dataset;
        if(library){
            activePromptLibraryId = library;
            activePromptCategory = 'all';
        }
        if(category){
            activePromptLibraryId = category.promptCatLib || activePromptLibraryId;
            activePromptCategory = category.promptCat || activePromptCategory;
        }
        startPromptCreation();
    },
    'prompt-lib-new': () => startPromptTreeEdit('library-new', 'library', '新提示词模板库', '提示词模板库名称', 'head'),
    'prompt-cat-new'(_id, control){
        activePromptLibraryId = control.closest('[data-prompt-lib]')?.dataset.promptLib || activePromptLibraryId;
        startPromptTreeEdit('category-new', 'library', '新分组', '分组名称');
    },
    'prompt-cat-rename'(){
        const category = activePromptCategories().find(item => item.id === activePromptCategory);
        startPromptTreeEdit('category-rename', 'category', category?.name || '', '分组名称');
    },
    'prompt-cat-delete': () => deleteCatalogEntry('prompt', 'category'),
    'prompt-lib-rename'(_id, control){
        activePromptLibraryId = control.closest('[data-prompt-lib]')?.dataset.promptLib || control.dataset.libId || activePromptLibraryId;
        startPromptTreeEdit('library-rename', 'library', activePromptLibrary()?.name || '', '提示词模板库名称');
    },
    'prompt-lib-delete'(_id, control){
        if(control.dataset.libId) activePromptLibraryId = control.dataset.libId;
        return deleteCatalogEntry('prompt', 'library');
    },
    'prompt-lib': library => selectPromptScope(library, 'all', 'library'),
    'prompt-cat': (category, control) => selectPromptScope(control.dataset.promptCatLib || activePromptLibraryId, category, 'category'),
    'prompt-check': (id, control) => selectPromptRow(id, true, control),
    'prompt-row': (id, control) => selectPromptRow(id, false, control),

}]);

function runFavoriteAction(event, action){
    event.preventDefault();
    event.stopPropagation();
    return action();
}


function handleAssetNavigation(event, target){
    const button = target.closest('[data-nav-toggle]');
    const row = target.closest('.asset-nav-branch-head > .tree-row');
    const toggle = button || row?.previousElementSibling;
    if(toggle?.hasAttribute('data-nav-double-click')){
        const keyboard = button && event.detail === 0;
        if(keyboard || event.detail === 2){
            setAssetNavExpanded(toggle, toggle.getAttribute('aria-expanded') !== 'true');
            return true;
        }
        return Boolean(button);
    }
    if(button){
        event.preventDefault();
        setAssetNavExpanded(button, button.getAttribute('aria-expanded') !== 'true');
        return true;
    }
    if(row) setAssetNavExpanded(toggle, true);
    return false;
}
async function handleClick(event, boundary = root){
    const target = event.target?.closest?.('*');
    if(!target || handleAssetNavigation(event, target)) return;
    if(activeTab === 'generated' && target.closest('[data-space-collection]')) clearCanvasAssetScope();
    if(await handleImageSpaceClick(target)) return;
    const kind = activeStorageFileKind();
    if(kind && await assetStorageActions.dispatch(event, boundary, {kind, state:storageFileState(kind)})) return;
    await assetPageActions.dispatch(event, boundary);
}


function marqueeScope(){
    let view;
    if(activeTab === 'assets' && uploadAssetsState.view === 'library' && assetManageMode){
        view = ['asset-card', 'asset-check', selectedAssetIds];
    } else if(activeTab === 'prompts' && promptManageMode){
        if(activePromptLibrary()?.readonly) return null;
        view = ['prompt-row', 'prompt-check', selectedPromptIds];
    } else if(activeTab === 'local' && localUploadManageMode){
        view = ['localup-card', 'localup-check', selectedLocalUploadIds];
    } else if(isCanvasAssetView() && canvasAssetManageMode){
        view = ['canvas-asset-card', 'canvas-asset-check', selectedCanvasAssetIds];
    }
    if(!view) return null;
    const [card, check, selection] = view;
    return {card:'data-' + card, check:'data-' + check, selection};
}
function assetDetailRecord(expectedId){
    const item = selectedAsset();
    if(!item || (expectedId && item.id !== expectedId)) return null;
    const library = activeAssetLibrary();
    const category = assetCategories().find(group => group.items?.includes(item));
    if(!library || !category) return null;
    return {item, libraryId:library.id, categoryId:category.id, libraryName:library.name || '资产库', categoryName:category.name || '分组'};
}
function findAssetDetailRecord({libraryId,categoryId,id,url}){
    const library = assetLibraries().find(entry => entry.id === libraryId);
    const category = library?.categories?.find(group => group.id === categoryId);
    return category?.items?.find(item => item.id === id && item.url === url);
}
function isAssetDetailVisible({libraryId,categoryId,id,url}){
    if(!catalogVisible('asset')) return false;
    const current = assetDetailRecord(id);
    return current?.libraryId === libraryId && current.categoryId === categoryId && current.item.url === url;
}
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
    const dialog = event.target.closest?.('#promptCaseDrawer, #caseCategoryModal');
    if(dialog && !root.contains(dialog)){
        handleClick(event, dialog).catch(error => setStatus(error.message || '操作失败'));
        return;
    }
});
document.addEventListener('keydown', event => {
    if(event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && event.target?.matches?.('[data-workflow-name-key]')){
        event.preventDefault();
        void workflows.rename(event.target.dataset.workflowInlineName, event.target.dataset.workflowNameKey);
        return;
    }
    const treeKind = treeInputKinds[event.target?.id];
    if(treeKind && !event.isComposing && event.keyCode !== 229){
        if(event.key === 'Enter'){
            event.preventDefault();
            saveCatalogEdit(treeKind).catch(error => setStatus(error.message || '保存失败'));
        } else if(event.key === 'Escape'){
            event.preventDefault();
            cancelCatalogEdit(treeKind);
        }
        return;
    }
    if(event.target?.id === 'localUploadFolderCreateInput' && !event.isComposing && event.keyCode !== 229){
        if(event.key === 'Enter'){ event.preventDefault(); void localFiles.folderAction('create'); }
        if(event.key === 'Escape'){ event.preventDefault(); localFiles.cancelFolder(); }
    }
});
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
    if(searchId === 'localUploadFolderCreateInput'){
        const folder = localFiles.folderDraft();
        if(folder) folder.name = event.target.value;
        return;
    }
    const draft = treeDrafts[treeInputKinds[searchId]]?.get();
    if(draft){
        draft.value = event.target.value;
        return;
    }
    if(SEARCH_INPUT_IDS.has(searchId)){
        updateSearchQueryFromInput(searchId, event.target.value || '');
        if(event.isComposing || searchCompositionActive) return;
        if(Date.now() - lastSearchCompositionEndAt < 40) return;
        scheduleSearchRender(searchId, event.target.selectionStart || 0);
        return;
    }
    if(event.target.matches('[data-asset-name-draft]')) assetDetail.input(event.target);
    if(event.target.matches('[data-workflow-name-key]')) workflows.input(event.target);
    annotations.input(event.target);
});
root.addEventListener('submit', event => {
    if(!event.target.matches('[data-space-form]')) return;
    event.preventDefault();
    imageSpaceReadFilterForm();
    imageSpaceRefresh().catch(err => setStatus(err.message || '筛选失败'));
});
root.addEventListener('change', event => {
    const storageName = event.target.closest?.('[data-space-file-inline-name]');
    if(storageName){
        const kind = activeStorageFileKind();
        const item = storageFileState(kind).items.find(entry => entry.id === storageName.dataset.spaceFileInlineName);
        renameStorageFileItem(kind, item, storageName.value).catch(err => { setStatus(err.message || '重命名失败'); render(); });
        return;
    }
    if(event.target.matches('[data-space-all]')){
        imageSpaceReadFilterForm();
        imageSpaceState.all[imageSpaceSource()] = event.target.checked;
        imageSpaceRefresh().catch(err => setStatus(err.message || '筛选失败'));
        return;
    }

    const inlineLocalUploadName = event.target.closest?.('[data-localup-inline-name]');
    if(inlineLocalUploadName){
        localFiles.rename(inlineLocalUploadName.dataset.localupInlineName || '', inlineLocalUploadName.value || '').catch(err => setStatus(err.message || '保存失败'));
        return;
    }
    const inlineAssetName = event.target.closest?.('[data-asset-inline-name]');
    if(inlineAssetName){
        void assetDetail.save(assetDetailRecord(inlineAssetName.dataset.assetInlineName), false);
        return;
    }
    const workflowName = event.target.closest?.('[data-workflow-inline-name]');
    if(workflowName){
        void workflows.rename(workflowName.dataset.workflowInlineName, workflowName.dataset.workflowNameKey);
        return;
    }
    if(event.target?.id === 'canvasAssetSort'){
        canvasAssetSort = canvasProjects.sort(event.target.value);
        selectedCanvasAssetId = '';
        render();
    }
    annotations.change(event.target);
    const avatarProvider = event.target.closest?.('[data-avatar-provider]');
    if(avatarProvider) avatarReviews.choose(avatarProvider.value);
});
root.addEventListener('dragstart', event => {
    const storageKind = activeStorageFileKind();
    if(storageKind){
        const card = event.target.closest?.('[data-space-file-card]');
        if(card && event.dataTransfer){
            const state = storageFileState(storageKind), id = card.dataset.spaceFileCard || '';
            const ids = state.selectedIds.has(id) ? [...state.selectedIds] : [id];
            storageFileCardDrag = {kind:storageKind, rels:ids.map(value => state.items.find(item => item.id === value)?.rel).filter(Boolean)};
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-xiaomei-storage-assets', JSON.stringify(storageFileCardDrag.rels));
            event.dataTransfer.setData('text/plain', `${storageFileCardDrag.rels.length} 个素材`);
            card.classList.add('local-asset-dragging');
            return;
        }
        const folder = event.target.closest?.('[data-space-folder]');
        const path = folder?.dataset.spaceFolder || '';
        if(path && event.dataTransfer){
            storageFileFolderDrag = {kind:storageKind,path};
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', path);
            folder.classList.add('local-folder-dragging');
            return;
        }
    }
    if(activeTab === 'local'){
        const card = event.target.closest?.('[data-localup-card]');
        if(card && event.dataTransfer){
            const id = card.dataset.localupCard || '';
            localUploadCardDragIds = selectedLocalUploadIds.has(id) ? [...selectedLocalUploadIds] : [id];
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-xiaomei-local-assets', JSON.stringify(localUploadCardDragIds));
            event.dataTransfer.setData('text/plain', `${localUploadCardDragIds.length} 个素材`);
            card.classList.add('local-asset-dragging');
            return;
        }
        const folder = event.target.closest?.('[data-localup-folder]');
        const path = folder?.dataset.localupFolder || '';
        if(path && event.dataTransfer){
            localUploadFolderDragPath = path;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', path);
            folder.classList.add('local-folder-dragging');
            return;
        }
    }
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
    const record = workflows.dragRecord(id);
    if(!record) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-xiaomei-workflow', JSON.stringify(record));
    event.dataTransfer.setData('text/plain', id);
    card.classList.add('workflow-dragging');
});
root.addEventListener('dragend', event => {
    storageFileFolderDrag = null;
    storageFileCardDrag = null;
    localUploadFolderDragPath = '';
    localUploadCardDragIds = [];
    clearLocalUploadFolderDropTargets();
    root.querySelectorAll('.local-asset-drop-target, .local-asset-dragging').forEach(node => node.classList.remove('local-asset-drop-target', 'local-asset-dragging'));
    event.target.closest?.('[data-localup-folder]')?.classList.remove('local-folder-dragging');
    assetCategoryDragState = null;
    event.target.closest?.('[data-asset-cat]')?.classList.remove('asset-category-dragging');
    clearAssetCategoryDropTargets();
    event.target.closest?.('[data-workflow-drag]')?.classList.remove('workflow-dragging');
    root.querySelectorAll('[data-workflow-cat].workflow-drop-target').forEach(node => node.classList.remove('workflow-drop-target'));
});
root.addEventListener('dragover', event => {
    const storageKind = activeStorageFileKind();
    if(storageFileCardDrag?.kind === storageKind){
        const folder = event.target.closest?.('[data-space-folder]');
        root.querySelectorAll('[data-space-folder].local-asset-drop-target').forEach(node => node.classList.remove('local-asset-drop-target'));
        if(folder){ event.preventDefault(); event.dataTransfer.dropEffect = 'move'; folder.classList.add('local-asset-drop-target'); }
        return;
    }
    if(storageFileFolderDrag?.kind === storageKind){
        const folder = event.target.closest?.('[data-space-folder]');
        const target = folder?.dataset.spaceFolder || '', source = storageFileFolderDrag.path;
        clearLocalUploadFolderDropTargets();
        if(target && target !== source && storageFolderParentPath(target) === storageFolderParentPath(source)){
            event.preventDefault(); event.dataTransfer.dropEffect = 'move';
            const after = event.clientY > folder.getBoundingClientRect().top + folder.getBoundingClientRect().height / 2;
            folder.classList.add(after ? 'local-folder-drop-after' : 'local-folder-drop-before');
        }
        return;
    }
    if(activeTab === 'local' && localUploadCardDragIds.length){
        const folder = event.target.closest?.('[data-localup-folder]');
        root.querySelectorAll('.local-asset-drop-target').forEach(node => node.classList.remove('local-asset-drop-target'));
        if(folder){
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            folder.classList.add('local-asset-drop-target');
        }
        return;
    }
    if(activeTab !== 'local' || !localUploadFolderDragPath) return;
    event.preventDefault();
    const folder = event.target.closest?.('[data-localup-folder]');
    const targetPath = folder?.dataset.localupFolder || '';
    clearLocalUploadFolderDropTargets();
    if(!targetPath || targetPath === localUploadFolderDragPath ||
        XiaomeiAssetManagerLocalFiles.parentOf(targetPath) !== XiaomeiAssetManagerLocalFiles.parentOf(localUploadFolderDragPath)) return;
    event.dataTransfer.dropEffect = 'move';
    const after = event.clientY > folder.getBoundingClientRect().top + folder.getBoundingClientRect().height / 2;
    folder.classList.add(after ? 'local-folder-drop-after' : 'local-folder-drop-before');
});
root.addEventListener('drop', event => {
    const storageKind = activeStorageFileKind();
    if(storageFileCardDrag?.kind === storageKind){
        const folder = event.target.closest?.('[data-space-folder]');
        if(!folder) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const rels = storageFileCardDrag.rels;
        storageFileCardDrag = null;
        root.querySelectorAll('.local-asset-drop-target, .local-asset-dragging').forEach(node => node.classList.remove('local-asset-drop-target', 'local-asset-dragging'));
        moveStorageFileRelsToFolder(storageKind, rels, folder.dataset.spaceFolder || '').catch(err => setStatus(err.message || '移动素材失败'));
        return;
    }
    if(storageFileFolderDrag?.kind === storageKind){
        const folder = event.target.closest?.('[data-space-folder]');
        if(!folder) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const source = storageFileFolderDrag.path, target = folder.dataset.spaceFolder || '';
        storageFileFolderDrag = null;
        clearLocalUploadFolderDropTargets();
        root.querySelector('.local-folder-dragging')?.classList.remove('local-folder-dragging');
        if(target && target !== source && storageFolderParentPath(target) === storageFolderParentPath(source)){
            const after = event.clientY > folder.getBoundingClientRect().top + folder.getBoundingClientRect().height / 2;
            reorderStorageFileFolder(storageKind, source, target, after).catch(err => setStatus(err.message || '调整文件夹顺序失败'));
        }
        return;
    }
    if(activeTab === 'local' && localUploadCardDragIds.length){
        const folder = event.target.closest?.('[data-localup-folder]');
        if(!folder) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const ids = localUploadCardDragIds;
        localUploadCardDragIds = [];
        root.querySelectorAll('.local-asset-drop-target, .local-asset-dragging').forEach(node => node.classList.remove('local-asset-drop-target', 'local-asset-dragging'));
        localFiles.move(ids, folder.dataset.localupFolder || '');
        return;
    }
    if(activeTab !== 'local' || !localUploadFolderDragPath) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const folder = event.target.closest?.('[data-localup-folder]');
    const sourcePath = localUploadFolderDragPath;
    const targetPath = folder?.dataset.localupFolder || '';
    localUploadFolderDragPath = '';
    clearLocalUploadFolderDropTargets();
    root.querySelector('.local-folder-dragging')?.classList.remove('local-folder-dragging');
    if(!targetPath || targetPath === sourcePath ||
        XiaomeiAssetManagerLocalFiles.parentOf(targetPath) !== XiaomeiAssetManagerLocalFiles.parentOf(sourcePath)) return;
    const after = event.clientY > folder.getBoundingClientRect().top + folder.getBoundingClientRect().height / 2;
    localFiles.reorder(sourcePath, targetPath, after).catch(err => setStatus(err.message || '调整文件夹顺序失败'));
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
    } else if(target.matches?.('[data-localup-folder]')){
        // 拖到左侧树的具体文件夹时，以鼠标命中的文件夹为准；根目录的
        // data-localup-folder 为空字符串，不能继续沿用之前打开的子文件夹。
        activeLocalUploadFolder = target.dataset.localupFolder || '';
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
    let record;
    try { record = JSON.parse(event.dataTransfer.getData('application/x-xiaomei-workflow')); }
    catch(_) { return; }
    if(!record?.libraryId || !record.categoryId || !record.id || !record.url) return;
    const target = {libraryId:folder.dataset.workflowCatLib || activeWorkflowLibraryId, categoryId:folder.dataset.workflowCat};
    workflows.move(record, target).catch(err => setStatus(err.message || '移动工作流失败'));
});
root.addEventListener('dragover', event => {
    const drop = event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop, #generatedDrop');
    if(!drop) return;
    event.preventDefault();
    drop.classList.add('drag-over');
});
root.addEventListener('dragleave', event => {
    event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop, #generatedDrop')?.classList.remove('drag-over');
});
root.addEventListener('drop', event => {
    const drop = event.target.closest?.('#assetDrop, #localUploadDrop, #workflowDrop, #generatedDrop');
    if(!drop) return;
    event.preventDefault();
    drop.classList.remove('drag-over');
    if(drop.id === 'localUploadDrop') localFiles.upload(event.dataTransfer.files);
    else if(drop.id === 'generatedDrop') uploadGeneratedFiles(event.dataTransfer.files).catch(err => setStatus(err.message || '上传失败'));
    else if(drop.id === 'workflowDrop') workflows.upload(event.dataTransfer.files).catch(err => setStatus(err.message || '上传失败'));
    else uploadFiles(event.dataTransfer.files).catch(err => setStatus(err.message || '上传失败'));
});
uploadInput?.addEventListener('change', event => {
    const files = event.target.files;
    if(files?.length){
        if(activeTab === 'local') localFiles.upload(files);
        else if(activeTab === 'workflows') workflows.upload(files).catch(err => setStatus(err.message || '上传失败'));
        else uploadFiles(files).catch(err => setStatus(err.message || '上传失败'));
    }
    event.target.value = '';
});
document.getElementById('generatedUploadInput')?.addEventListener('change', event => {
    if(event.target.files?.length) uploadGeneratedFiles(event.target.files).catch(err => setStatus(err.message || '上传失败'));
    event.target.value = '';
});
document.querySelectorAll('[data-tab]').forEach(button => {
    if(root.contains(button)) return;
    button.addEventListener('click', () => {
        changeAssetTab(button.dataset.tab).catch(error => setStatus(error.message || '加载失败'));
    });
});
if(refreshBtn && !root.contains(refreshBtn)){
    refreshBtn.addEventListener('click', () => {
        refreshCurrentAssetPage().catch(error => setStatus(error.message || '加载失败'));
    });
}
storageSettingsBtn?.addEventListener('click', () => storageSettings.open());
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
        storageSettings.open({ tab: event.data.tab });
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
