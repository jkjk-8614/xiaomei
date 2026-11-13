function refreshIcons(){ if(window.lucide) lucide.createIcons(); }
refreshIcons();
function tr(key){ return window.StudioI18n ? StudioI18n.t(key) : key; }
function trf(key, values={}){
    return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), tr(key));
}
function langIsEn(){ return window.StudioI18n?.lang?.() === 'en'; }
const { read:responseErrorMessage } = XiaomeiApiErrors;
const { copyText:copyTextToClipboard } = XiaomeiCanvasEditorCore;
function actionFailed(labelKey, detail=''){
    const label = tr(labelKey);
    return langIsEn() ? `${label} failed${detail ? `: ${detail}` : ''}` : `${label}失败${detail ? `：${detail}` : ''}`;
}
function noReturnedImage(labelKey){ return langIsEn() ? `${tr(labelKey)} failed: no image returned` : `${tr(labelKey)}失败：未返回图片`; }
function applyLanguage(lang){
    if(lang && window.StudioI18n) StudioI18n.set(lang);
    document.title = tr('canvas.title');
    classicShell.refreshTitle();
    render();
}
const configNotices = new Set(['providers-changed', 'workflows-changed', 'comfy-instances-changed']);
async function refreshCanvasConfigFromSettings(){
    await loadConfig();
    render();
}
function handleConfigNotice(event){
    if(configNotices.has(event.data?.type)) refreshCanvasConfigFromSettings();
}
window.addEventListener('message', event => {
    if(event.origin && event.origin !== location.origin) return;
    if(event.data?.type === 'studio-lang') applyLanguage(event.data.lang);
    if(event.data?.type === 'canvas_updated') canvasSession.receive(event.data);
    handleConfigNotice(event);
    if(event.data?.type === 'canvas-focus'){
        // 从其他标签页切换回画布时，重新拉取工作流列表并刷新节点
        refreshCanvasConfigFromSettings();
        if(canvas) canvasSession.sync();
    }
});
window.addEventListener('studio-lang-change', () => {
    document.title = tr('canvas.title');
    classicShell.refreshTitle();
    render();
});
const shell = document.getElementById('shell');
const board = document.getElementById('board');
const world = document.getElementById('world');
const nodesEl = document.getElementById('nodes');
const {
    original:canvasOriginalMediaUrl, displayUrl:canvasDisplayMediaUrl, previewUrl:canvasMediaPreviewUrl,
    normalizedSize:normalizedPendingPreviewSize, referenceKind:mediaKindForRef, referenceKind:mediaKindForOutputItem,
    nodeKind:mediaKindForNode, nodeTitle:nodeTitleForMedia, kindTitle:mediaKindTitle,
    imageRefs:imageRefsOnly, videoRefs:videoRefsOnly, audioRefs:audioRefsOnly, isVideo:isVideoUrl, downloadName:outputDownloadName
} = XiaomeiClassicMediaPreview;
const classicMedia = XiaomeiClassicMediaPreview.create({
    layer:nodesEl,
    escape:escapeAttr,
    node:id => nodes.find(node => node.id === id),
    nodes:() => nodes,
    selected:id => selected.has(id),
    editorOpen:() => classicEditor.isOpen(),
    outputUrl:item => outputUrlValue(item),
    parseSize:XiaomeiClassicImageGeneration.sizePair,
    save:scheduleSave
});
const {
    imageHtml:canvasPreviewImgHtml, videoHtml:canvasVideoPreviewHtml, playVideo:canvasActivateVideoPreview,
    bindFallbacks:bindCanvasPreviewImageFallbacks, pendingSize:pendingPreviewSizeForRun
} = classicMedia;
const nodeScene = XiaomeiClassicNodes.create(nodesEl, {
    build: node => classicCards.mount(node),
    patch: node => node.type === 'output' && classicOutputCards.patch(node),
    hasLiveMedia: classicMedia.hasPlayer,
    moveMedia: classicMedia.carryPlayback,
    scope: () => canvas?.id
});
const minimap = document.getElementById('minimap');
const canvasArrangeBtn = document.getElementById('canvasArrangeBtn');
const linksEl = world.querySelector('#links');
const linkControlsEl = world.querySelector('#linkControls');
const dropOverlay = board.querySelector('#dropOverlay');
const createMenu = board.querySelector('#createMenu');
const linkCreateMenu = board.querySelector('#linkCreateMenu');
const nodeInputMenu = board.querySelector('#nodeInputMenu');
const nodeOutputMenu = board.querySelector('#nodeOutputMenu');
const imageNodeMenu = board.querySelector('#imageNodeMenu');
const selectionBox = board.querySelector('#selectionBox');
const backToManagerBtn = document.getElementById('backToManagerBtn');
let canvas = null;
let canvasRefreshPending = false;
let nodes = [];
let connections = [];
let viewport = {x: -1800, y: -1000, scale: 1};
let linksFrame = 0;
let layoutFrame = 0;
let isRKeyDown = false;
let internalDrag = false;
const selected = new Set();
let apiProviders = [];
let comfyBackendCount = 1;
let lastImagePasteAt = 0;
let canvasAssetLibrary = {categories:[]};
let activeCanvasAssetLibraryId = '';
let activeCanvasAssetCategoryId = '';
let lastMouseBoard = {x: 0, y: 0};
let undoStack = [];
const UNDO_MAX = 30;
const { size:defaultNodeSize, generatorTypes:CANVAS_GENERATOR_TYPES } = XiaomeiClassicCards;
const classicShell = XiaomeiClassicCanvasShell.create({
    element:shell,
    canvas:() => canvas,
    label:tr,
    english:langIsEn,
    icons:refreshIcons,
    copy:copyTextToClipboard,
    pointAt:(x, y) => screenToWorld(x, y),
    add:(type, point) => classicCards.add(type, point),
    closeLinkMenu:() => closeLinkCreateMenu(),
    node:id => nodes.find(node => node.id === id),
    mediaKind:mediaKindForNode,
    missing:url => isMissingAssetUrl(url),
    preview:openOutputLightbox,
    edit:openImageEditor,
    pick:id => classicMediaImport.pick(id),
    outputMenu:(node, x, y) => classicOutputCards.menu(node, x, y)
});
const {
    showError:showErrorModal, status:setStatus, requireCanvas:ensureCanvas,
    projectId:currentCanvasProjectId, openCreateMenu, closeMenus:closeCreateMenu,
    closeMediaMenu:closeImageNodeMenu, openImageMenu:openImageNodeMenu,
    previewImage:openImageNodePreview, openOutputMenu:openOutputNodeMenu
} = classicShell;
const classicInputs = XiaomeiClassicInputView.create({
    label:tr,
    icons:refreshIcons,
    missing:url => isMissingAssetUrl(url),
    missingView:url => missingAssetHtml(url, true),
    image:canvasPreviewImgHtml,
    video:canvasVideoPreviewHtml,
    dragging:active => { internalDrag = active; },
    reorder(node, from, to){
        if(!generationGraph.reorder(node, from, to)) return;
        render();
        scheduleSave();
    }
});
const {
    prompts:renderPromptPreview, images:renderImageInputList, workflow:renderWorkflowMediaInputs,
    thumbnail:classicVideoInputPreview, runningHub:previewClassicRunningHubMedia, bindReorder:bindClassicInputDrag
} = classicInputs;
const classicViewport = XiaomeiClassicViewport.create({
    board, world, shell, nodesLayer:nodesEl,
    mapContent:document.getElementById('minimapContent'),
    mapMarker:document.getElementById('minimapViewport'),
    zoomLabel:document.getElementById('canvasZoomLabel'),
    toolbar:document.querySelector('.canvas-zoom-pill'),
    arrangeButton:canvasArrangeBtn,
    selected,
    size:defaultNodeSize,
    nodes:() => nodes,
    canvas:() => canvas,
    camera:() => viewport,
    links:() => renderLinks(),
    closeMenus:closeCreateMenu
});
const { pointAt:screenToWorld, paint:applyViewport, scheduleMap:scheduleMinimapRender,
    save:scheduleViewportSave } = classicViewport;
const { has:isMissingAssetUrl, refresh:refreshMissingCanvasAssets } = XiaomeiClassicLocalAssets.create({
    document:() => canvas,
    nodes:() => nodes,
    url:item => outputUrlValue(item)
});
const CLIENT_ID = 'canvas_' + Math.random().toString(36).slice(2);
const classicPrompts = XiaomeiClassicPromptTemplates.create({
    node:id => nodes.find(item => item.id === id),
    apply:(node, text) => {
        node.text = text;
        scheduleSave();
        syncGeneratorInputs();
        refreshGeneratorInputViews();
        render();
    },
    label:tr,
    english:langIsEn,
    status:setStatus,
    icons:refreshIcons,
    responseError:responseErrorMessage
});
const classicGestures = XiaomeiClassicGestures.create({
    board, minimap,
    ready:() => Boolean(canvas),
    camera:() => viewport,
    editable:isEditableTarget,
    background:target => target === board || target === world || target === nodesEl || target === linksEl,
    dismiss:closeCreateMenu,
    createMenu:openCreateMenu,
    startKnife:event => classicConnections.startKnife(event),
    disarmKnife:() => setKnifeMode(false),
    pointer:event => { lastMouseBoard = screenToWorld(event.clientX, event.clientY); },
    hover:(event, busy) => classicConnections.hover(event, busy),
    clearHover:() => classicConnections.clearHover(),
    selectionModifier:event => isRKeyDown || event.ctrlKey || event.metaKey,
    marquee:event => classicLayout.startMarquee(event),
    clearSelection:() => {
        if(!selected.size) return;
        selected.clear();
        refreshSelectionVisuals();
    },
    paintCamera:applyViewport,
    saveCamera:scheduleViewportSave,
    paintZoom:classicViewport.scheduleZoom,
    moveMinimap:classicViewport.moveMinimap,
    previewing:classicViewport.previewing,
    focusPreview:classicViewport.focusPreview
});
const classicConnections = XiaomeiClassicConnections.create({
    cards:nodesEl, layer:linksEl, controls:linkControlsEl, selected, mouse:classicGestures,
    ready:() => Boolean(canvas),
    nodes:() => nodes,
    node:id => nodes.find(node => node.id === id),
    edges:() => connections,
    replaceEdges:value => { connections = value; },
    appendNode:node => nodes.push(node),
    id:uid,
    label:tr,
    world:screenToWorld,
    scale:() => viewport.scale,
    editable:isEditableTarget,
    nodeBox:node => classicLayout.rect(node),
    hasMediaOutput:node => CANVAS_GENERATOR_TYPES.includes(node.type),
    isGenerator:node => CANVAS_GENERATOR_TYPES.includes(node.type),
    dismiss:closeCreateMenu,
    menus:{background:createMenu, drop:linkCreateMenu, input:nodeInputMenu, output:nodeOutputMenu},
    catalog:() => classicCards.catalog,
    createNode:(type, point) => classicCards.add(type, point),
    icons:refreshIcons,
    snapshot:pushUndo,
    relayOutput:(from, to) => generationGraph.relayLatest(from, to),
    syncInputs:syncGeneratorInputs,
    refreshInputs:refreshGeneratorInputViews,
    paintNodes:render,
    paintMinimap:scheduleMinimapRender,
    save:scheduleSave
});
const {
    allowed:canConnect, paint:renderLinks, start:startLink, startKnife:startKnifeDrag, knifeMode:setKnifeMode,
    remove:deleteConnection, closeMenus:closeLinkCreateMenu
} = classicConnections;
const classicLayout = XiaomeiClassicLayout.create({
    board,
    layer:nodesEl,
    box:selectionBox,
    selected,
    nodes:() => nodes,
    edges:() => connections,
    setNodes:value => { nodes = value; },
    setEdges:value => { connections = value; },
    isGenerator:node => CANVAS_GENERATOR_TYPES.includes(node?.type),
    canConnect,
    id:uid,
    defaultPoint:() => defaultPoint(0, 0),
    undo:pushUndo,
    selectionChanged:refreshSelectionVisuals,
    changed:graph => {
        if(graph){
            syncGeneratorInputs();
            refreshGeneratorInputViews();
        }
        render();
        scheduleSave();
    }
});
const classicMediaImport = XiaomeiClassicMediaImport.create({
    board,
    label:tr,
    canvasId:() => canvas?.id,
    nodes:() => nodes,
    node:id => nodes.find(item => item.id === id),
    selected:() => [...selected].map(id => nodes.find(item => item.id === id)),
    id:uid,
    kind:mediaKindForRef,
    name:url => outputImageName(url),
    defaultPoint:() => defaultPoint(0, 0),
    center:() => screenToWorld(window.innerWidth / 2, window.innerHeight / 2),
    toWorld:screenToWorld,
    makeGroup:createGroupForUploadedNodes,
    replaceWithGroup:replaceClassicImageWithGroup,
    undo:pushUndo,
    changed:graph => {
        if(graph) syncGeneratorInputs();
        render();
        scheduleSave();
    },
    overlay:value => dropOverlay.classList.toggle('active', value),
    internalDrag:() => internalDrag,
    clearInternalDrag:() => { internalDrag = false; },
    pasteAt:() => { lastImagePasteAt = Date.now(); },
    workflow:(url, name, at) => classicTransfer.importAsset(url, name, at),
    error:showErrorModal,
    responseError:responseErrorMessage
});
const classicAssets = XiaomeiClassicAssets.create({
    label:tr,
    library:() => canvasAssetLibrary,
    setLibrary:value => { canvasAssetLibrary = value; },
    libraryId:() => activeCanvasAssetLibraryId,
    setLibraryId:value => { activeCanvasAssetLibraryId = value; },
    categoryId:() => activeCanvasAssetCategoryId,
    setCategoryId:value => { activeCanvasAssetCategoryId = value; },
    kind:mediaKindForRef,
    name:url => outputImageName(url),
    thumbnail:(url, video, size, attrs) => video
        ? canvasVideoPreviewHtml(url, size, attrs) : canvasPreviewImgHtml(url, size, attrs),
    fallbacks:bindCanvasPreviewImageFallbacks,
    icons:refreshIcons,
    insert:classicMediaImport.addAsset,
    upload:classicMediaImport.upload,
    beforeOpen:() => classicTransfer.close(),
    status:setStatus,
    error:showErrorModal,
    responseError:responseErrorMessage
});
const classicTransfer = XiaomeiClassicWorkflowTransfer.create({
    canvas:() => canvas,
    nodes:() => nodes,
    edges:() => connections,
    selected:() => selected,
    transferable:transferableCanvasNode,
    id:uid,
    point:() => Number.isFinite(lastMouseBoard?.x) ? lastMouseBoard : defaultPoint(0, 0),
    insert:insertClassicWorkflow,
    libraries:classicAssets.libraries,
    libraryId:() => activeCanvasAssetLibraryId,
    librarySaved:(library, libraryId, categoryId) => {
        if(library) canvasAssetLibrary = library;
        activeCanvasAssetLibraryId = libraryId;
        activeCanvasAssetCategoryId = categoryId;
        classicAssets.render();
    },
    beforeOpen:() => { if(classicAssets.isOpen()) classicAssets.toggle(false); },
    label:tr,
    status:setStatus,
    icons:refreshIcons,
    error:showErrorModal,
    responseError:responseErrorMessage
});
const {
    duration:formatRunDuration, snapshot:runSnapshot, requestMeta:requestMetaFromResult
} = XiaomeiClassicGenerationLog;
const classicOutputCards = XiaomeiClassicOutputCards.create({
    layer:nodesEl,
    menu:imageNodeMenu,
    label:tr,
    node:id => nodes.find(item => item.id === id),
    nodes:() => nodes,
    logs:() => canvas?.logs || [],
    title:() => canvas?.title,
    id:uid,
    kind:mediaKindForOutputItem,
    nodeKind:mediaKindForNode,
    missing:isMissingAssetUrl,
    missingView:url => missingAssetHtml(url, true),
    pendingSize:normalizedPendingPreviewSize,
    thumbnail:(url, size, kind) => kind === 'video'
        ? canvasVideoPreviewHtml(url, size, 'alt="video output" data-preview-controls')
        : canvasPreviewImgHtml(url, size, 'alt="generated output"'),
    play:canvasActivateVideoPreview,
    preview:openOutputLightbox,
    duration:formatRunDuration,
    recover:(id, outputId) => classicImageTasks.query(id, outputId),
    recovery:XiaomeiClassicImageTasks.describe,
    changed:id => { scheduleSave(); refreshNodes([id]); },
    download:url => downloadUrl(url, outputDownloadName(url)),
    alert:message => window.alert(message),
    responseError:responseErrorMessage,
    closeMenu:closeImageNodeMenu,
    commitGroup:commitClassicOutputGroup,
    icons:refreshIcons
});
const {
    append:appendOutputImages, comparison:outputCompareUrlFor, metadata:outputMetaFor,
    fileName:outputImageName, urlOf:outputUrlValue
} = XiaomeiClassicOutputCards;
const generationGraph = XiaomeiClassicGenerationGraph.create({
    node:id => nodes.find(node => node.id === id),
    edges:() => connections,
    id:uid,
    label:tr,
    format:trf,
    cardKind:mediaKindForNode,
    urlOf:outputUrlValue,
    kindOf:mediaKindForOutputItem,
    videoUrl:isVideoUrl,
    nameOf:outputImageName,
    isGenerator:node => CANVAS_GENERATOR_TYPES.includes(node.type),
    loopPrompt:(node, round) => classicLoop.prompt(node, round),
    loopImages:(node, round) => classicLoop.images(node, round),
    appendNode:node => nodes.push(node),
    appendMedia:appendOutputImages
});
const {
    sources:classicGenerationSources, output:outputForNode, outputNodes:outputNodesForSource,
    storeOutputs:mergeGeneratedOutputs, resultMedia:resultMediaUrls
} = generationGraph;
const classicClipboard = XiaomeiClassicClipboard.create({
    ready:() => Boolean(canvas),
    selected,
    pointer:() => lastMouseBoard,
    nodes:() => nodes,
    node:id => nodes.find(node => node.id === id),
    edges:() => connections,
    id:uid,
    snapshot:pushUndo,
    allowed:canConnect,
    transferable:transferableCanvasNode,
    mapInputOrder:generationGraph.mapInputOrder,
    pasted(){
        syncGeneratorInputs();
        render();
        scheduleSave();
    }
});
const { groupImages:groupImageItems } = classicOutputCards;
const classicOutputPreview = XiaomeiClassicOutputPreview.create({
    label:tr,
    metadata:outputMetaFor,
    comparison:outputCompareUrlFor,
    isVideo:item => mediaKindForOutputItem(item) === 'video',
    node:id => nodes.find(item => item.id === id),
    items:classicOutputCards.lightboxItems,
    viewed:classicOutputCards.viewed,
    mediaUrl:url => canvasDisplayMediaUrl(url, outputDownloadName(url)),
    duration:formatRunDuration,
    copy:copyTextToClipboard,
    rerun:meta => classicCards.restoreRun(meta),
    download:url => downloadUrl(url, outputDownloadName(url)),
    downloadGroup:classicOutputCards.downloadGroup,
    groupSize:node => node?.type === 'group' ? groupImageItems(node).length : 0,
    error:error => showErrorModal(error?.message || tr('canvas.outputDownloadFailed')),
    icons:refreshIcons
});
const classicEditor = XiaomeiClassicImageEditor.create({
    node:id => nodes.find(node => node.id === id),
    canvas:() => canvas,
    kind:mediaKindForNode,
    full:canvasDisplayMediaUrl,
    quick:canvasMediaPreviewUrl,
    id:uid,
    label:tr,
    icons:refreshIcons,
    exceedsFourK:XiaomeiClassicImageGeneration.exceedsFourK,
    upload:uploadClassicEditedMedia,
    commit:commitClassicEditedMedia,
    error:message => showErrorModal(message, tr('canvas.imageEditFailed'))
});
const classicCascade = XiaomeiClassicCascade.create({
    document:() => canvas,
    nodes:() => nodes,
    edges:() => connections,
    node:id => nodes.find(node => node.id === id),
    outputIds:id => outputNodesForSource(id).map(node => node.id),
    outputUrl:outputUrlValue,
    label:tr,
    format:trf,
    message:showErrorModal,
    refresh:refreshNodes,
    comfySlots:() => comfyBackendCount,
    run:runCascadeNodeByType
});
const { isAbort:isCascadeAbortError, targetOf:cascadeTargetIdFromOptions } = XiaomeiClassicCascade;
const {
    nodeBusy:isNodeInActiveCascade, fetch:cascadeFetch, restartMessage:cascadeBackendRestartMessage,
    normalizeError:normalizeCanvasTaskError, media:recordClassicRoundMedia
} = classicCascade;
const classicImage = XiaomeiClassicImageGeneration.create({
    label:tr,
    id:uid,
    sources:classicGenerationSources,
    images:imageRefsOnly,
    dimensions:classicMedia.dimensions,
    current:node => nodes.includes(node),
    renderPrompts:renderPromptPreview,
    renderImages:renderImageInputList,
    changed:scheduleSave,
    snapshot:runSnapshot,
    batch:(...args) => classicImageTasks.run(...args),
    message:showErrorModal,
    cascadeBusy:isNodeInActiveCascade,
    runNode:runCanvasGenerate,
    addControls:classicCascade.decorate
});
const classicImageTasks = XiaomeiClassicImageTasks.create({
    label:tr,
    id:uid,
    document:() => canvas,
    node:id => nodes.find(item => item.id === id),
    projectId:currentCanvasProjectId,
    count:XiaomeiClassicImageGeneration.count,
    output:outputForNode,
    refresh:refreshNodes,
    changed:scheduleSave,
    save:saveCanvas,
    message:showErrorModal,
    status:setStatus,
    pending:makePendingForRun,
    append:appendOutputImages,
    generated:mergeGeneratedOutputs,
    requestMeta:requestMetaFromResult,
    resultMedia:resultMediaUrls,
    record:entry => classicLog.record(entry),
    fetch:cascadeFetch,
    associate:classicCascade.associate,
    roundMedia:recordClassicRoundMedia,
    target:cascadeTargetIdFromOptions,
    owns:classicCascade.owns,
    assertActive:classicCascade.assertActive,
    isAbort:isCascadeAbortError,
    normalizeError:normalizeCanvasTaskError,
    restartMessage:cascadeBackendRestartMessage
});
const classicLoop = XiaomeiClassicLoop.create({
    label:tr,
    format:trf,
    id:uid,
    incoming:generationGraph.incoming,
    groupPrompts:generationGraph.groupPrompts,
    media:generationGraph.media,
    target:classicCascade.loopTarget,
    orderSize:target => classicCascade.order(target).length,
    active:classicCascade.active,
    stopping:classicCascade.stopping,
    run:classicCascade.start,
    stop:classicCascade.stop,
    refresh:id => refreshNodes([id]),
    refreshTarget:id => { if(id) refreshNodes([id]); },
    refreshConsumers:scheduleGeneratorInputSync,
    changed:scheduleSave,
    panelsChanged(node){
        connections = connections.filter(edge => edge.to !== node.id || canConnect(edge.from, edge.to));
        render();
        scheduleSave();
    }
});
const classicLlm = XiaomeiClassicLLM.create({
    label:tr,
    id:uid,
    canvasId:() => canvas?.id,
    getNode:id => nodes.find(node => node.id === id),
    scale:() => viewport.scale,
    input:generationGraph.llmInput,
    refresh:id => refreshNodes([id]),
    refreshConsumers:scheduleGeneratorInputSync,
    changed:scheduleSave,
    copy:copyTextToClipboard,
    message:showErrorModal,
    isAbort:isCascadeAbortError,
    isCascadeBusy:isNodeInActiveCascade,
    runNode:runCanvasGenerate,
    addControls:classicCascade.decorate,
    async submit(payload, options){
        const response = await cascadeFetch('/api/canvas-llm', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
        }, options);
        if(!response.ok) throw new Error(await responseErrorMessage(response, tr('canvas.llmFailed')));
        const data = await response.json();
        classicCascade.assertActive(options);
        return data;
    }
});
const classicComfy = XiaomeiClassicComfy.create({
    label: tr,
    id: uid,
    imageModel: () => classicImage.selection().model,
    canvasId: () => canvas?.id,
    getNode: id => nodes.find(node => node.id === id),
    sources: (node, round) => classicGenerationSources(node, round),
    images: imageRefsOnly,
    videos: videoRefsOnly,
    audios: audioRefsOnly,
    renderPrompts: renderPromptPreview,
    renderMedia: renderWorkflowMediaInputs,
    runNode: runCanvasGenerate,
    changed: scheduleSave,
    save: saveCanvas,
    refresh: node => refreshNodes([node.id]),
    addCascadeControls:(card, controls, actions, node) => classicCascade.decorate(card, actions, node, controls),
    uploadRef: comfyNameForRef,
    submit: (payload, options) => createCanvasComfyTask({...payload, client_id:CLIENT_ID}, options),
    wait: waitCanvasComfyTaskResult,
    requestMeta: requestMetaFromResult,
    outputs: resultMediaUrls,
    outputUrl: outputUrlValue,
    terminalError: message => Object.assign(new Error(message), {terminal:true}),
    start: startClassicComfyRun,
    complete: completeClassicComfyRun,
    fail: failClassicComfyRun,
    report: reportClassicComfyError
});
const CLASSIC_VIDEO_TASK_TYPE = 'classic-video-direct';
const classicVideo = XiaomeiClassicVideo.create({
    label:tr,
    id:uid,
    canvasId:() => canvas?.id,
    getNode:id => nodes.find(node => node.id === id),
    sources:(node, round) => classicGenerationSources(node, round),
    mediaKind:mediaKindForRef,
    mediaLabel:mediaKindTitle,
    images:imageRefsOnly,
    preview:classicVideoInputPreview,
    renderPrompts:renderPromptPreview,
    bindInputDrag:bindClassicInputDrag,
    icons:refreshIcons,
    runNode:runCanvasGenerate,
    changed:scheduleSave,
    refresh:refreshNodes,
    message:showErrorModal,
    copy:copyTextToClipboard,
    replaceReference:replaceClassicVideoReference,
    async upload(url){
        const response = await fetch('/api/cloud-video/upload', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url, service:'auto'})
        });
        if(!response.ok) throw new Error(await responseErrorMessage(response, tr('canvas.videoCloudFailed')));
        return response.json();
    },
    async submit(request, options){
        const response = await cascadeFetch('/api/canvas-video', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({...request, project_id:currentCanvasProjectId()})
        }, options);
        if(!response.ok) throw new Error(await responseErrorMessage(response, tr('canvas.videoFailed')));
        const data = await response.json();
        classicCascade.assertActive(options);
        return data;
    },
    outputs:result => resultMediaUrls(result).map(item => ({
        ...(typeof item === 'object' ? item : {}), url:outputUrlValue(item), kind:item?.kind || 'video'
    })).filter(item => item.url),
    addControls:classicCascade.decorate,
    begin:beginClassicVideoRun,
    complete:completeClassicVideoRun,
    fail:failClassicVideoRun
});
const classicLtx = XiaomeiClassicLTX.create({
    label:tr,
    canvasId:() => canvas?.id,
    getNode:id => nodes.find(node => node.id === id),
    sources:(node, round) => classicGenerationSources(node, round),
    images:imageRefsOnly,
    renderPrompts:renderPromptPreview,
    renderMedia:renderWorkflowMediaInputs,
    runNode:runCanvasGenerate,
    id:uid,
    changed:scheduleSave,
    save:saveCanvas,
    refresh:node => refreshNodes([node.id]),
    addControls:classicCascade.decorate,
    uploadRef:comfyNameForRef,
    uploadFile:uploadClassicLtxFile,
    mediaError:error => showErrorModal(error.message, tr('canvas.ltxMediaFailed')),
    submit:(payload, options) => createCanvasComfyTask({...payload, client_id:CLIENT_ID}, options),
    wait:waitCanvasComfyTaskResult,
    requestMeta:requestMetaFromResult,
    outputs:resultMediaUrls,
    start(node, plan, options){
        return startClassicPersistedRun(node, {
            field:'ltxRuns', prefix:'classic_ltx', taskType:'classic-ltx', offset:520,
            taskLabel:tr('canvas.ltxDirector'), ...plan
        }, options);
    },
    complete:(node, job, outputs) => finishClassicPersistedRun(node, job, outputs, 'ltxRuns'),
    fail:failClassicLtxRun,
    report:reportClassicLtxError
});
const classicRunningHub = XiaomeiClassicRunningHub.create({
    label: tr,
    id: uid,
    canvasId: () => canvas?.id,
    getNode: id => nodes.find(node => node.id === id),
    sources: (node, round) => classicGenerationSources(node, round),
    mediaKind: mediaKindForRef,
    images: imageRefsOnly,
    mediaLabel: ref => mediaKindTitle(mediaKindForRef(ref)),
    preview: previewClassicRunningHubMedia,
    renderPrompts: renderPromptPreview,
    icons: refreshIcons,
    defaultResolution: XiaomeiClassicImageGeneration.defaultResolution,
    parseSize: XiaomeiClassicImageGeneration.sizePair,
    normalizeSize: node => { node.resolution = XiaomeiClassicImageGeneration.resolutionOf(node); },
    runNode: runCanvasGenerate,
    changed: scheduleSave,
    save: saveCanvas,
    refresh: node => refreshNodes([node.id]),
    addControls:classicCascade.decorate,
    fetch:cascadeFetch,
    random: XiaomeiClassicComfy.randomValue,
    sleep,
    runModel: runClassicRunningHubModel,
    accept: startClassicRunningHubRun,
    complete: completeClassicRunningHubRun,
    fail: failClassicRunningHubRun,
    report: reportClassicRunningHubError
});
const classicCards = XiaomeiClassicCards.create({
    toolbar:document.getElementById('quickToolbar'),
    label:tr,
    ready:ensureCanvas,
    id:uid,
    point:defaultPoint,
    node:id => nodes.find(node => node.id === id),
    nodes:() => nodes,
    edges:() => connections,
    selected,
    selectionChanged:refreshSelectionVisuals,
    nodeMenu:classicConnections.openNodeMenu,
    drag:startNodeDrag,
    resize:startNodeResize,
    link:startLink,
    undo:pushUndo,
    remove:id => classicLayout.remove([id], false),
    changed(id){
        if(id) refreshNodes([id]);
        else render();
        scheduleSave();
    },
    migrate:classicImage.migrate,
    media:{
        kind:mediaKindForNode,
        title:nodeTitleForMedia,
        missing:isMissingAssetUrl,
        missingMarkup:missingAssetHtml,
        missingLabel:() => langIsEn() ? 'missing' : '文件缺失',
        image:canvasPreviewImgHtml,
        video:canvasVideoPreviewHtml,
        actions:{
            dragOver:classicMediaImport.allowNode,
            drop:classicMediaImport.dropNode,
            pick:classicMediaImport.pick,
            drag:startNodeDrag,
            menu:openImageNodeMenu,
            play:canvasActivateVideoPreview,
            geometry:renderLinks,
            loaded:refreshGeometryAfterLayout,
            preview(id, kind, crop){
                if(kind === 'image') openImageEditor(id, crop ? 'crop' : 'preview');
                else openImageNodePreview(id);
            }
        }
    },
    prompts:{
        active:classicPrompts.active,
        open:classicPrompts.open,
        edited(){
            scheduleSave();
            scheduleGeneratorInputSync();
        }
    },
    group:{hasImages:node => groupImageItems(node).length > 0, open:openGroupLightbox},
    output:{mount:classicOutputCards.mount, menu:openOutputNodeMenu, close:closeOutputLightbox},
    factories:{
        group:point => classicLayout.makeGroup([], point),
        loop:classicLoop.newNode, llm:classicLlm.newNode, generator:classicImage.newNode, video:classicVideo.newNode,
        rh:classicRunningHub.newNode, comfy:classicComfy.newNode, ltxDirector:classicLtx.newNode
    },
    renderers:{
        loop:classicLoop.render, llm:classicLlm.render, generator:classicImage.render, video:classicVideo.render,
        rh:classicRunningHub.render, comfy:classicComfy.render, ltxDirector:classicLtx.render
    }
});
const classicLog = XiaomeiClassicGenerationLog.create({
    canvas:() => canvas,
    providers:() => apiProviders,
    modal:document.getElementById('logModal'),
    list:document.getElementById('logList'),
    trigger:document.getElementById('canvasLogToggle'),
    id:uid,
    label:tr,
    format:trf,
    english:langIsEn,
    copy:copyTextToClipboard,
    icons:refreshIcons,
    outputUrl:outputUrlValue,
    missing:isMissingAssetUrl,
    bindThumbnails:bindCanvasPreviewImageFallbacks,
    thumbnail:(item, url) => mediaKindForOutputItem(item) === 'video'
        ? canvasVideoPreviewHtml(url, 256, 'alt="output"')
        : canvasPreviewImgHtml(url, 256, 'alt="output"'),
    openMedia:url => openOutputLightbox(url, null),
    comfyTitle:classicComfy.title
});
const canvasSession = XiaomeiClassicSession.create({
    clientId: CLIENT_ID,
    snapshot: buildClassicSave,
    onRemote: applyRemoteCanvasData,
    onSaved: savedCanvas => {
        canvas.updated_at = savedCanvas.updated_at;
        classicShell.updateTime(canvas.updated_at);
    },
    status: setStatus
});
backToManagerBtn?.addEventListener('click', async () => {
    if(!await canvasSession.flush()){
        showErrorModal(tr('common.canvasRefreshSaveFailed'), tr('common.canvasRefresh'));
        return;
    }
    window.location.href = classicShell.projectListUrl();
});
function uid(prefix='n'){ return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`; }
function scheduleLinksRender(){
    if(!linksFrame){
        linksFrame = requestAnimationFrame(() => {
            linksFrame = 0;
            renderLinks();
        });
    }
}
function refreshGeometryAfterLayout(){
    scheduleLinksRender();
    if(!layoutFrame){
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            scheduleLinksRender();
        });
    }
}
function scheduleSave(){
    canvasSession.changed();
}
const transientRunDefaults = {running:false, runStatus:'', runError:'', _cascadeIdx:'', _cascadeFailed:false};
function serializableCanvasNode(node){
    const copy = {...(node || {})};
    delete copy._ltxEditor;
    delete copy._naturalSizeLoading;
    for(const key of Object.keys(transientRunDefaults)) delete copy[key];
    delete copy.tempShUploading;
    if(Array.isArray(copy._pending)){
        copy._pending = copy._pending.filter(task => task?.canvasTaskType !== CLASSIC_VIDEO_TASK_TYPE).map(task => {
            if(!task || !Object.hasOwn(task, 'querying')) return task;
            const {querying, ...saved} = task;
            return saved;
        });
    }
    return copy;
}
function serializableCanvasNodes(list=nodes){
    return (list || []).map(serializableCanvasNode);
}
function transferableCanvasNode(node){
    const copy = serializableCanvasNode(node);
    delete copy.comfyRuns;
    delete copy.rhRuns;
    delete copy.ltxRuns;
    if(Array.isArray(copy._pending)) copy._pending = copy._pending.filter(task => !isClassicPersistedTask(task) && task?.canvasTaskType !== 'online-image');
    return copy;
}
function isClassicPersistedTask(task){
    return ['classic-comfy','classic-runninghub','classic-ltx'].includes(task?.canvasTaskType);
}
function buildClassicSave(){
    sanitizeConnections();
    return XiaomeiDocumentKernel.saveBody({
        title:canvas.title,
        icon:canvas.icon,
        nodes:serializableCanvasNodes(),
        connections,
        viewport:classicViewport.record(),
        logs:canvas.logs,
        settings:canvas.settings
    }, { profile:'classic', fallbackIcon:'🧩', clientId:CLIENT_ID, includeSettings:true });
}
function saveCanvas(){
    return canvasSession.save();
}

let classicCatalogRevision = 0;
async function loadClassicProviderCatalog(){
    const revision = ++classicCatalogRevision;
    try {
        const response = await fetch('/api/providers', {cache:'no-store'});
        if(!response.ok) return;
        const {providers} = await response.json();
        if(revision !== classicCatalogRevision || !Array.isArray(providers)) return;
        classicImage.setProviders(providers);
        classicVideo.setProviders(providers);
        classicLlm.setProviders(providers);
    } catch(_) {}
}

async function loadConfig(){
    const providerCatalog = loadClassicProviderCatalog();
    try {
        const cfg = await fetch('/api/config', {cache:'no-store'}).then(r=>r.json());
        comfyBackendCount = Math.max(1, (cfg.comfy_instances || []).length || 1);
        apiProviders = Array.isArray(cfg.api_providers) ? cfg.api_providers : [];
        try {
            const response = await fetch('/api/workflows');
            if(response.ok) classicComfy.setCatalog((await response.json()).workflows);
        } catch(_) {}
        classicRunningHub.setProvider(apiProviders.find(provider => provider.id === 'runninghub'));
    } catch(e) {
        apiProviders = [];
    }
    await providerCatalog;
}

try {
    const apiChannel = new BroadcastChannel('studio-api');
    apiChannel.addEventListener('message', handleConfigNotice);
} catch {
    // Settings messages from the application frame also use handleConfigNotice.
}
async function touchCanvasOpened(id){
    try {
        const response = await fetch(`/api/canvases/${encodeURIComponent(id)}/touch`, {method:'POST'});
        if(response.ok) return (await response.json()).updated_at;
    } catch(error){
        console.warn('touch canvas failed', error);
    }
    return null;
}
function openSmartCanvasPage(id){
    if(!id) return;
window.location.href = `/static/smart-canvas.html?id=${encodeURIComponent(id)}&v=2026.10.16.project-agent.2`;
}
function cancelClassicInteractions(){
    classicGestures.cancel();
    setKnifeMode(false);
    classicConnections.clearHover();
    classicLayout.cancelMarquee();
    closeCreateMenu();
}
async function openCanvas(id){
    cancelClassicInteractions();
    setStatus('Opening...');
    try {
        const res = await fetch(`/api/canvases/${id}`);
        if(!res.ok) throw new Error(tr('canvas.openFailed'));
        const data = await res.json();
        cancelClassicInteractions();
        classicViewport.reset();
        classicCascade.reset();
        canvas = data.canvas;
        classicShell.rememberProject(canvas.project);
        const touched = await touchCanvasOpened(canvas.id);
        if(touched) canvas.updated_at = Number(touched);
        if((canvas.kind || 'classic') === 'smart'){
            openSmartCanvasPage(canvas.id);
            return;
        }
        canvas = XiaomeiDocumentKernel.adopt(canvas, {profile:'classic', fallbackIcon:canvas.icon || '🧩'}).document;

        canvas.logs = canvas.logs || [];
        nodes = canvas.nodes || [];
        connections = canvas.connections || [];
        viewport = classicViewport.load(canvas.id, canvas.viewport);
        canvas.viewport = {...viewport};
        resetTransientRunState(nodes);
        sanitizeConnections();
        await refreshMissingCanvasAssets();
        selected.clear();
        canvasSession.open(canvas);
        classicShell.revealCanvas();
        render();
        classicImageTasks.resume(nodes);
        classicComfy.resume(nodes);
        resumeClassicRunningHubTasks();
        classicLtx.resume(nodes);
        setStatus('Ready');
    } catch(e) {
        setStatus(tr('canvas.openFailed'));
        console.error(e);
        // 打开失败（id 无效/已删除）：回到选画布页面，避免停在空白编辑器。
        window.location.replace(classicShell.projectListUrl());
    }
}
function applyRemoteCanvasData(remote){
    cancelClassicInteractions();
    classicViewport.reset();
    const localViewport = classicViewport.load(canvas.id, viewport);
    canvas = XiaomeiDocumentKernel.adopt(remote, { profile:'classic' }).document;
    nodes = canvas.nodes;
    connections = canvas.connections;
    viewport = localViewport;
    canvas.viewport = {...viewport};
    const retained = nodes.filter(node => selected.has(node.id)).map(node => node.id);
    selected.clear();
    retained.forEach(id => selected.add(id));
    classicCascade.reset();
    resetTransientRunState();
    sanitizeConnections();
    render();
    refreshMissingCanvasAssets().then(applied => { if(applied) render(); });
    classicImageTasks.resume(nodes);
    classicComfy.resume(nodes);
    resumeClassicRunningHubTasks();
    classicLtx.resume(nodes);
    classicShell.refreshHeader();
}
function resetTransientRunState(list=nodes){
    for(const node of list || []){
        if(!node) continue;
        for(const [key, value] of Object.entries(transientRunDefaults)){
            if(node[key]) node[key] = value;
        }
        for(const task of node._pending || []){
            if(task) delete task.querying;
        }
    }
}
function defaultPoint(dx=0, dy=0){ return screenToWorld(window.innerWidth / 2 + dx, window.innerHeight / 2 + dy); }
function commitClassicOutputGroup(source, {group, children}, copy){
    pushUndo();
    nodes.push(...children, group);
    if(!copy){
        const downstream = new Set(connections.filter(edge => edge.from === source.id).map(edge => edge.to));
        nodes = nodes.filter(node => node.id !== source.id);
        connections = connections.filter(edge => edge.from !== source.id && edge.to !== source.id);
        for(const to of downstream){
            if(canConnect(group.id, to)) connections.push({id:uid('c'), from:group.id, to});
        }
    }
    selected.clear();
    selected.add(group.id);
    syncGeneratorInputs();
    refreshGeneratorInputViews();
    render();
    scheduleSave();
}
function replaceClassicVideoReference(ref, url){
    const source = nodes.find(node => node.id === ref.nodeId);
    if(!source) return;
    const kind = mediaKindForRef(ref);
    if(source.type === 'image' && source.url === ref.url){
        source.originalLocalUrl ||= source.url;
        source.url = url;
        source.mediaKind = kind;
        return;
    }
    const items = source.type === 'output' ? source.images : source.generatedOutputs;
    if(!Array.isArray(items)) return;
    const indexed = items[ref.outputIndex];
    const index = outputUrlValue(indexed) === ref.url ? Number(ref.outputIndex)
        : items.findIndex(item => outputUrlValue(item) === ref.url);
    if(index < 0) return;
    const item = items[index];
    items[index] = {...(typeof item === 'object' ? item : {}), url, kind, originalLocalUrl:item?.originalLocalUrl || ref.url};
}
function createGroupForUploadedNodes(created){
    const targets = created.filter(node => node.type === 'image');
    if(targets.length < 2) return null;
    render();
    return classicLayout.groupUploads(targets);
}
function replaceClassicImageWithGroup(id, group){
    const incoming = connections.filter(edge => edge.to === id).map(edge => edge.from);
    const outgoing = connections.filter(edge => edge.from === id).map(edge => edge.to);
    nodes = nodes.filter(node => node.id !== id);
    connections = connections.filter(edge => edge.from !== id && edge.to !== id);
    for(const node of nodes){
        if((node.type === 'group' || node.type === 'promptGroup') && node.items?.includes(id)){
            node.items = node.items.filter(member => member !== id);
        }
    }
    selected.delete(id);
    if(!group) return;
    const pairs = [...incoming.map(from => [from, group.id]), ...outgoing.map(to => [group.id, to])];
    for(const [from, to] of pairs){
        if(canConnect(from, to) && !connections.some(edge => edge.from === from && edge.to === to)){
            connections.push({id:uid('c'), from, to});
        }
    }
}
function openImageEditor(id, mode){ classicEditor.open(id, mode); }
function closeImageEditor(){ classicEditor.close(); }
async function uploadClassicEditedMedia(blobs){
    const form = new FormData();
    for(const item of blobs) form.append('files', item.blob, item.name);
    const response = await fetch('/api/ai/upload', {method:'POST', body:form});
    if(!response.ok) throw new Error(await responseErrorMessage(response, tr('canvas.imageEditUploadFailed')));
    const data = await response.json();
    return Array.isArray(data.files) ? data.files : [];
}
function commitClassicEditedMedia(edit, output, files){
    const {node} = edit;
    const {mode, width, height, rects} = output;
    const [file] = files;
    pushUndo();
    const x = Number(node.x || 0) + Number(node.w || 260) + 36;
    const y = Number(node.y || 0);
    if(mode === 'grid'){
        const layout = {
            type:'grid-split', groupId:uid('grid'),
            rows:Math.max(...rects.map(rect => rect.row)) + 1,
            cols:Math.max(...rects.map(rect => rect.col)) + 1
        };
        const source = {url:node.url, name:node.name || 'source image'};
        const meta = rects.map(({row,col,w,h}) => ({
            runMs:0, run:{prompt:'宫格切分', refs:[source]}, grid:{...layout, row, col, w, h}
        }));
        let target = connections.filter(edge => edge.from === node.id)
            .map(edge => nodes.find(item => item.id === edge.to)).find(item => item?.type === 'output');
        if(!target){
            target = {id:uid('out'), type:'output', x, y, images:[]};
            nodes.push(target);
        }
        appendOutputImages(target, files.map(item => item.url), source, meta, layout);
    } else if(mode === 'mask' || mode === 'brush'){
        const mask = mode === 'mask';
        const created = {
            id:uid('img'), type:'image', x, y:y + (mask ? 28 : 0), url:file.url, name:file.name || (mask ? 'mask' : 'paint'),
            mediaKind:'image', natural_w:width, natural_h:height, ...(mask ? {role:'mask'} : {})
        };
        nodes.push(created);
        selected.clear();
        selected.add(created.id);
    } else {
        Object.assign(node, {url:file.url, name:file.name || node.name, mediaKind:'image', natural_w:width, natural_h:height});
    }
    closeImageEditor();
    render();
    scheduleSave();
}
function paintNodes(ids){
    applyViewport();
    nodeScene.paint(nodes, ids);
    renderLinks();
    refreshGeometryAfterLayout();
    refreshIcons();
    bindCanvasPreviewImageFallbacks(nodesEl);
    classicMedia.updateSelection();
    classicMedia.measureNodes();
    classicOutputCards.refreshTimers();
    classicTransfer.refresh();
}
function render(){
    paintNodes();
}
function refreshNodes(ids=[]){
    const changed = [...new Set((ids || []).filter(Boolean))];
    if(changed.length) paintNodes(changed);
}
function refreshRunNodes(node, out=null){
    refreshNodes([node?.id, out?.id]);
}
function syncGeneratorInputs(){
    for(const node of nodes){
        if(!CANVAS_GENERATOR_TYPES.includes(node.type)) continue;
        const sources = classicGenerationSources(node);
        if(node.type === 'ltxDirector') classicLtx.sync(node, sources);
    }
}
// Edits update the document immediately. Refresh connected previews after typing pauses.
let generatorInputSyncTimer;
function scheduleGeneratorInputSync(){
    clearTimeout(generatorInputSyncTimer);
    generatorInputSyncTimer = setTimeout(refreshAfterPromptEdit, 160);
}
function refreshAfterPromptEdit(){
    syncGeneratorInputs();
    refreshGeneratorInputViews();
}
const imageInputView = ['.classic-image-generator', classicImage.updateInputs];
const generatorInputViews = {
    rh:['.rh-body', classicRunningHub.refreshInputs],
    comfy:['.comfy-body', classicComfy.updateInputs],
    ltxDirector:['.classic-ltx', classicLtx.updateInputs],
    video:['.classic-video', classicVideo.updateInputs],
    generator:imageInputView,
    msgen:imageInputView
};
function refreshGeneratorInputViews(){
    for(const node of nodes){
        const card = nodeScene.element(node.id);
        if(!card) continue;
        if(node.type === 'llm'){
            const panel = card.querySelector('.classic-llm');
            if(panel) classicLlm.updateInput(panel, node);
            continue;
        }
        const view = Object.hasOwn(generatorInputViews, node.type) && generatorInputViews[node.type];
        if(!view) continue;
        const [selector, update] = view;
        const panel = card.querySelector(selector);
        if(panel) update(panel, node, classicGenerationSources(node));
    }
}
async function runClassicRunningHubModel(node, model, media, options){
    const refs = imageRefsOnly(media.refs);
    const prompt = media.prompt || 'Edit the reference images.';
    const payload = {
        prompt, provider_id:'runninghub', model,
        size:await classicImage.sizeFor(node, refs, model),
        reference_images:refs
    };
    const quality = XiaomeiClassicImageGeneration.quality(node.quality);
    if(quality) payload.quality = quality;
    const run = {...runSnapshot(node, prompt, refs), taskLabel:'RunningHub'};
    return classicImageTasks.run(node, payload, run, refs, options, 500);
}
async function uploadCanvasUrlToComfy(url, workflowName='', options={}){
    const blob = await cascadeFetch(url, {}, options).then(r => {
        if(!r.ok) throw new Error(langIsEn() ? 'Image read failed' : '图片读取失败');
        return r.blob();
    });
    const extension = blob.type.split('/')[1]?.split('+')[0] || 'png';
    const filename = url.startsWith('data:') ? `canvas_${Date.now()}.${extension}`
        : url.split('/').pop()?.split('?')[0] || `canvas_${Date.now()}.${extension}`;
    const form = new FormData();
    form.append('files', blob, filename);
    if(workflowName) form.append('workflow_json', workflowName);
    const data = await cascadeFetch('/api/upload', {method:'POST', body:form}, options).then(async r => {
        if(!r.ok) throw new Error(await responseErrorMessage(r, langIsEn() ? 'Image upload to ComfyUI failed' : '图片上传到 ComfyUI 失败'));
        return r.json();
    });
    return data.files?.[0]?.comfy_name || filename;
}
async function uploadClassicLtxFile(file, workflowName){
    const form = new FormData();
    form.append('files', file);
    form.append('workflow_json', workflowName);
    const response = await fetch('/api/upload', {method:'POST', body:form});
    if(!response.ok) throw new Error(await responseErrorMessage(response, tr('canvas.ltxMediaFailed')));
    const name = (await response.json()).files?.[0]?.comfy_name;
    if(!name) throw new Error(tr('canvas.ltxMediaFailed'));
    return name;
}
async function comfyNameForRef(ref, workflowName, options){
    if(ref.comfy_name) return ref.comfy_name;
    if(!ref.url) throw new Error(langIsEn() ? 'Missing input image' : '缺少输入图片');
    return uploadCanvasUrlToComfy(ref.url, workflowName, options);
}
function runCascadeNodeByType(node, options){
    const handlers = {
        generator:classicImage, msgen:classicImage, comfy:classicComfy,
        ltxDirector:classicLtx, llm:classicLlm, video:classicVideo, rh:classicRunningHub
    };
    return handlers[node.type]?.run(node, options);
}
function runCanvasGenerate(id){
    const node = nodes.find(item => item.id === id);
    if(!node || node.running || classicCascade.nodeBusy(id)) return;
    return runCascadeNodeByType(node, {cascade:false});
}

function nowMs(){ return Date.now(); }
function missingAssetHtml(url, compact=false){
    return `<div class="missing-asset ${compact ? 'compact' : ''}" title="${escapeAttr(url || '')}"><i data-lucide="image-off" class="${compact ? 'w-4 h-4' : 'w-6 h-6'}"></i><span>${langIsEn() ? 'Missing file' : '文件缺失'}</span></div>`;
}
function makePendingForRun(id, run, node, options={}, task={}){
    const pending = {id, run, startedAt:nowMs(), ...task};
    const previewSize = pendingPreviewSizeForRun(node, options);
    if(previewSize) pending.previewSize = previewSize;
    if(options?.cascadeTargetId) pending.cascadeTargetId = String(options.cascadeTargetId);
    return pending;
}
function beginClassicVideoRun(node, prompt, refs, options){
    const out = outputForNode(node, 460);
    const run = runSnapshot(node, prompt, refs);
    classicCascade.associate(run, options.round);
    const id = uid('video');
    if(out){
        out._pending = [...(out._pending || []), makePendingForRun(id, run, node, {
            refs, cascadeTargetId:cascadeTargetIdFromOptions(options)
        }, {canvasTaskType:CLASSIC_VIDEO_TASK_TYPE})];
    }
    node.runStatus = 'running';
    node.runError = '';
    refreshRunNodes(node, out);
    return {id, outputId:out?.id, run, startedAt:nowMs()};
}
function settleClassicVideoPending(entry){
    const out = nodes.find(node => node.id === entry.outputId && node.type === 'output');
    if(out) out._pending = (out._pending || []).filter(item => item.id !== entry.id);
    return out;
}
function completeClassicVideoRun(node, entry, outputs, result, options){
    const out = settleClassicVideoPending(entry);
    const runMs = Math.max(0, nowMs() - entry.startedAt);
    entry.run.request = requestMetaFromResult(result);
    appendOutputImages(out, outputs, entry.run.refs?.[0], [{run:entry.run, runMs, kind:'video'}]);
    recordClassicRoundMedia(entry.run, node, outputs);
    mergeGeneratedOutputs(node, outputs, Boolean(options.cascade));
    classicLog.record({run:entry.run, outputs, runMs});
    node.runStatus = 'done';
    node.runError = '';
    refreshRunNodes(node, out);
    scheduleSave();
}
function failClassicVideoRun(node, entry, error, options){
    if(!classicCascade.owns(options)) return;
    const out = entry ? settleClassicVideoPending(entry) : null;
    if(isCascadeAbortError(error)){
        refreshRunNodes(node, out);
        return;
    }
    const message = error?.message || tr('canvas.videoFailed');
    if(entry){
        classicLog.record({run:entry.run, runMs:Math.max(0, nowMs() - entry.startedAt), error:message});
        scheduleSave();
    }
    node.runStatus = 'failed';
    node.runError = message;
    if(!options.cascade) showErrorModal(message, tr('canvas.videoFailed'));
    refreshRunNodes(node, out);
}
function startClassicComfyRun(node, plan, options){
    return startClassicPersistedRun(node, {
        field:'comfyRuns', prefix:'classic_comfy', taskType:'classic-comfy', offset:480,
        ...plan, stage:'primary', taskId:''
    }, options);
}
function startClassicRunningHubRun(node, ref, taskId, useWallet, media, options){
    return startClassicPersistedRun(node, {
        field:'rhRuns', prefix:'classic_runninghub', taskType:'classic-runninghub', offset:500,
        taskLabel:'RunningHub', prompt:media.prompt || 'RunningHub', refs:media.refs, taskId, useWallet,
        request:{task_id:taskId, backend:'runninghub', mode:ref.kind, useWallet,
            ...(ref.kind === 'workflow' ? {workflowId:ref.id} : {webappId:ref.id})}
    }, options);
}
function startClassicPersistedRun(node, plan, options){
    const {field, prefix, taskType, offset, prompt, refs, requestSize, taskLabel, request, ...details} = plan;
    const out = outputForNode(node, offset);
    const id = uid(prefix);
    const run = {...runSnapshot(node, prompt, refs), taskLabel};
    classicCascade.associate(run, options.round);
    if(request) run.request = request;
    const job = {
        ...details, id, run, canvasId:canvas.id, startedAt:nowMs(),
        outputId:out?.id || '', append:Boolean(options.cascade)
    };
    node[field] = [...(Array.isArray(node[field]) ? node[field] : []), job];
    if(out){
        out._pending = [...(out._pending || []), makePendingForRun(id, run, node, {
            refs, requestSize, cascadeTargetId:cascadeTargetIdFromOptions(options)
        }, {canvasTaskType:taskType})];
    }
    refreshRunNodes(node, out);
    scheduleSave();
    return job;
}
function removeClassicPersistedRun(node, job, out, field){
    const remaining = (node[field] || []).filter(item => item.id !== job.id);
    if(remaining.length) node[field] = remaining;
    else delete node[field];
    if(out) out._pending = (out._pending || []).filter(item => item.id !== job.id);
}
function completeClassicComfyRun(node, job, outputs){
    finishClassicPersistedRun(node, job, outputs, 'comfyRuns');
}
function finishClassicPersistedRun(node, job, outputs, field){
    const out = nodes.find(item => item.id === job.outputId && item.type === 'output');
    const runMs = Math.max(0, nowMs() - Number(job.startedAt || nowMs()));
    removeClassicPersistedRun(node, job, out, field);
    appendOutputImages(out, outputs, job.run.refs?.[0], [{run:job.run, runMs}]);
    recordClassicRoundMedia(job.run, node, outputs);
    mergeGeneratedOutputs(node, outputs, job.append);
    classicLog.record({run:job.run, outputs, runMs});
    node.runStatus = 'done';
    node.runError = '';
    refreshRunNodes(node, out);
    scheduleSave();
}
function reportClassicComfyError(node, error, options){
    if(!classicCascade.owns(options)) return;
    if(isCascadeAbortError(error)) return;
    node.runStatus = 'failed';
    node.runError = error?.message || actionFailed('canvas.comfyGenerate');
    if(!options.cascade && !options.resume) showErrorModal(node.runError, tr('canvas.comfyGenerate'));
}
function failClassicComfyRun(node, job, error, options){
    if(!classicCascade.owns(options)) return;
    const out = nodes.find(item => item.id === job.outputId && item.type === 'output');
    const terminal = error?.terminal || isCascadeAbortError(error);
    if(terminal){
        removeClassicPersistedRun(node, job, out, 'comfyRuns');
        classicLog.record({run:job.run, runMs:Math.max(0, nowMs() - Number(job.startedAt || nowMs())), error:error.message});
        scheduleSave();
    }
    reportClassicComfyError(node, error, options);
    refreshRunNodes(node, out);
}
function reportClassicLtxError(node, error, options){
    if(!classicCascade.owns(options)) return;
    if(isCascadeAbortError(error)) return;
    node.runStatus = 'failed';
    node.runError = error?.message || tr('canvas.ltxFailed');
    if(!options.cascade && !options.resume) showErrorModal(node.runError, tr('canvas.ltxFailed'));
}
function failClassicLtxRun(node, job, error, options){
    if(!classicCascade.owns(options)) return;
    const out = nodes.find(item => item.id === job.outputId && item.type === 'output');
    if(error?.terminal || isCascadeAbortError(error)){
        removeClassicPersistedRun(node, job, out, 'ltxRuns');
        classicLog.record({run:job.run, runMs:Math.max(0, nowMs() - Number(job.startedAt || nowMs())), error:error.message});
        scheduleSave();
    }
    reportClassicLtxError(node, error, options);
    refreshRunNodes(node, out);
}
function currentClassicRunningHubRun(nodeId, job){
    const node = nodes.find(item => item.id === nodeId);
    return Array.isArray(node?.rhRuns) && node.rhRuns.some(item => item?.id === job.id) ? node : null;
}
function completeClassicRunningHubRun(nodeId, job, outputs){
    const node = currentClassicRunningHubRun(nodeId, job);
    if(node) finishClassicPersistedRun(node, job, outputs, 'rhRuns');
}
function reportClassicRunningHubError(node, error, options){
    if(!classicCascade.owns(options)) return;
    if(isCascadeAbortError(error)) return;
    node.runStatus = 'failed';
    node.runError = error?.message || tr('canvas.rhFailed');
    if(!options.cascade && !options.resume) showErrorModal(node.runError, tr('canvas.rhFailed'));
}
function failClassicRunningHubRun(nodeId, job, error, options){
    if(!classicCascade.owns(options)) return;
    const node = currentClassicRunningHubRun(nodeId, job);
    if(!node) return;
    const out = nodes.find(item => item.id === job.outputId && item.type === 'output');
    if(error?.terminal || isCascadeAbortError(error)){
        removeClassicPersistedRun(node, job, out, 'rhRuns');
        classicLog.record({run:job.run, runMs:Math.max(0, nowMs() - Number(job.startedAt || nowMs())), error:error.message});
        scheduleSave();
    }
    reportClassicRunningHubError(node, error, options);
    refreshRunNodes(node, out);
}
async function createCanvasComfyTask(payload, options={}){
    payload = {
        ...payload,
        history_source:payload?.history_source || 'canvas',
        project_id:payload?.project_id || currentCanvasProjectId(),
    };
    const res = await cascadeFetch('/api/canvas-comfy-tasks', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
    }, options);
    if(!res.ok){
        const message = await responseErrorMessage(res, actionFailed('canvas.comfyGenerate'));
        throw Object.assign(new Error(message), {terminal:res.status >= 400 && res.status < 500 && ![408,429].includes(res.status)});
    }
    const data = await res.json();
    classicCascade.assertActive(options);
    return data;
}
async function waitCanvasComfyTaskResult(taskId, options={}){
    if(!taskId) throw new Error(actionFailed('canvas.comfyGenerate'));
    while(true){
        const res = await cascadeFetch(`/api/canvas-comfy-tasks/${encodeURIComponent(taskId)}`, {}, options);
        if(!res.ok){
            if(res.status === 404) throw Object.assign(new Error(cascadeBackendRestartMessage()), {terminal:true});
            throw new Error(await responseErrorMessage(res, actionFailed('canvas.comfyGenerate')));
        }
        const data = await res.json();
        classicCascade.assertActive(options);
        if(data.status === 'succeeded') return data.result || {};
        if(data.status === 'failed' || data.status === 'cancelled'){
            throw Object.assign(new Error(data.error || data.message || actionFailed('canvas.comfyGenerate')), {terminal:true});
        }
        await sleep(1600);
    }
}
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
function resumeClassicRunningHubTasks(){
    let migrated = false;
    for(const out of nodes.filter(node => node.type === 'output')){
        for(const pending of Array.isArray(out._pending) ? out._pending : []){
            const run = pending?.run;
            const request = run?.request;
            if(pending?.canvasTaskType || run?.nodeType !== 'rh' || request?.backend !== 'runninghub' ||
                !['app','workflow'].includes(request.mode) || !request.task_id || !pending.id) continue;
            const node = nodes.find(item => item.id === run.node?.id && item.type === 'rh');
            if(!node) continue;
            const jobs = Array.isArray(node.rhRuns) ? node.rhRuns : [];
            if(!jobs.some(job => job?.id === pending.id)){
                node.rhRuns = [...jobs, {
                    id:pending.id, run, taskId:String(request.task_id), canvasId:canvas.id,
                    outputId:out.id, useWallet:request.useWallet ?? node.rhPayment === 'wallet',
                    append:Boolean(pending.cascadeTargetId), startedAt:pending.startedAt
                }];
            }
            pending.canvasTaskType = 'classic-runninghub';
            migrated = true;
        }
    }
    if(migrated) scheduleSave();
    classicRunningHub.resume(nodes);
}
function openGroupLightbox(groupId, index=0){
    const group = nodes.find(node => node.id === groupId);
    const images = groupImageItems(group);
    const position = Math.min(images.length - 1, Math.max(0, index));
    const image = images[position] || images[0];
    if(image) classicOutputPreview.open(image.url, group);
}
function openOutputLightbox(url, out){ classicOutputPreview.open(url, out); }
function closeOutputLightbox(){ classicOutputPreview.close(); }
function navigateOutputLightbox(direction){ return classicOutputPreview.navigate(direction); }
function groupSelectedImages(){
    if(ensureCanvas()) classicLayout.groupSelection();
}

function pushUndo(){
    if(!canvas) return;
    XiaomeiHistoryKernel.push(undoStack, null, {
        nodes:XiaomeiHistoryKernel.cloneData(nodes.map(transferableCanvasNode)),
        connections:XiaomeiHistoryKernel.cloneData(connections)
    }, UNDO_MAX, false);
    return;

}
function performUndo(){
    if(!canvas) return;
    const state = XiaomeiHistoryKernel.undo(undoStack, null);
    if(!state) return;
    cancelClassicInteractions();
    const previous = new Map(nodes.map(node => [node.id, node]));
    nodes = state.nodes;
    const activeTaskIds = new Set();
    for(const node of nodes){
        const field = node.type === 'comfy' ? 'comfyRuns' : node.type === 'rh' ? 'rhRuns' : node.type === 'ltxDirector' ? 'ltxRuns' : '';
        const jobs = previous.get(node.id)?.[field];
        if(!field || !Array.isArray(jobs)) continue;
        node[field] = jobs;
        jobs.forEach(job => { if(job?.id) activeTaskIds.add(job.id); });
    }
    for(const node of nodes){
        if(node.type !== 'output') continue;
        const pending = (previous.get(node.id)?._pending || []).filter(task =>
            ['online-image', CLASSIC_VIDEO_TASK_TYPE].includes(task?.canvasTaskType) || (isClassicPersistedTask(task) && activeTaskIds.has(task.id))
        );
        if(pending.length) node._pending = [...(node._pending || []), ...pending];
    }
    connections = state.connections;
    selected.clear();
    render();
    scheduleSave();
    return;

}
function insertClassicWorkflow(bundle){
    pushUndo();
    nodes.push(...bundle.nodes);
    connections.push(...bundle.connections);
    selected.clear();
    for(const node of bundle.nodes) selected.add(node.id);
    sanitizeConnections();
    syncGeneratorInputs();
    render();
    scheduleSave();
}
function startNodeDrag(event, node){
    if(event.button !== 0 || classicGestures.busy()) return;
    if(startKnifeDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    let target = node;
    if(event.altKey){
        setKnifeMode(false);
        target = classicClipboard.duplicate(node, event.shiftKey);
        selected.clear();
        selected.add(target.id);
        if(event.shiftKey){
            sanitizeConnections();
            syncGeneratorInputs();
        }
        render();
    }
    const gesture = nodeScene.beginMove(target, {x:event.clientX, y:event.clientY}, nodes, selected);
    document.body.classList.add('canvas-node-drag');
    classicGestures.track(event, {
        move(next){
            nodeScene.move(gesture, {x:next.clientX, y:next.clientY}, viewport.scale);
            scheduleLinksRender();
            classicTransfer.refresh();
            scheduleMinimapRender();
        },
        finish(released){
            document.body.classList.remove('canvas-node-drag');
            if(!released?.shiftKey) setKnifeMode(false);
            classicLayout.updateMembership(gesture.members.map(member => member.node));
            scheduleMinimapRender();
            scheduleSave();
        }
    });
}
function startNodeResize(event, node){
    if(classicGestures.busy()) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture = nodeScene.beginResize(node, {x:event.clientX, y:event.clientY}, viewport.scale, defaultNodeSize(node.type));
    document.body.classList.add('canvas-node-resize');
    classicGestures.track(event, {
        move(next){
            nodeScene.resize(gesture, {x:next.clientX, y:next.clientY}, viewport.scale);
            scheduleLinksRender();
            scheduleMinimapRender();
        },
        finish(released){
            document.body.classList.remove('canvas-node-resize');
            if(!released?.shiftKey) setKnifeMode(false);
            scheduleMinimapRender();
            scheduleSave();
        }
    });
}
function sanitizeConnections(){
    connections = (connections || []).filter(edge => canConnect(edge.from, edge.to));
}
function refreshSelectionVisuals(){
    nodesEl.querySelectorAll('.node').forEach(el => {
        el.classList.toggle('selected', selected.has(el.dataset.id));
    });
    classicMedia.updateSelection();
    renderLinks();
    classicTransfer.refresh();
    scheduleMinimapRender();
}
function isEditableTarget(target){
    const tag = target?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable || target?.closest?.('select, option');
}
shell.querySelector('[data-canvas-group-selection]')?.addEventListener('click', groupSelectedImages);
canvasArrangeBtn?.addEventListener('mousedown', e => e.stopPropagation());
canvasArrangeBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if(canvas && selected.size) classicLayout.arrange();
});
function applyClassicKeyEffect(event, effect){
    if(effect.prevent) event.preventDefault();
    if(effect.type === 'arm-rotate') isRKeyDown = true;
    else if(effect.type === 'arm-knife') setKnifeMode(true);
    else if(effect.type === 'close' && effect.target === 'image-editor') closeImageEditor();
    else if(effect.type === 'close' && effect.target === 'prompt-templates') classicPrompts.close();
    else if(effect.type === 'close' && effect.target === 'lightbox') closeOutputLightbox();
    else if(effect.type === 'lightbox-step'){
        if(navigateOutputLightbox(effect.direction)){
            event.preventDefault();
            event.stopPropagation();
        }
    } else if(effect.type === 'group') groupSelectedImages();
    else if(effect.type === 'delete-selection') deleteSelectedNodes();
}
window.addEventListener('keydown', e => {
    if(!canvas) return;
    const tag = document.activeElement?.tagName;
    const fieldFocused = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    const surfaces = {
        imageEditor: Boolean(document.getElementById('imageEditModal')?.classList.contains('open')),
        promptTemplates: classicPrompts.isOpen(),
        lightbox: classicOutputPreview.isOpen(),
        workflow: classicTransfer.isOpen(),
        log: classicLog.isOpen()
    };
    const action = XiaomeiHistoryKernel.chord({
        key:e.key, ctrl:e.ctrlKey, meta:e.metaKey, alt:e.altKey, shift:e.shiftKey, repeat:e.repeat
    }, {
        profile:'classic',
        plainEditable:isEditableTarget(e.target),
        commandEditable:fieldFocused,
        modal:Object.values(surfaces).some(Boolean),
        textSelected:Boolean(window.getSelection && window.getSelection().toString().length),
        canPaste:classicClipboard.count() > 0
    });
    if(action?.type === 'ignore' || action?.type === 'zoom-preview'){
        e.preventDefault();
        if(action.type === 'zoom-preview') classicViewport.togglePreview();
        return;
    }
    if(action?.type === 'undo'){ e.preventDefault(); performUndo(); return; }
    if(action?.type === 'copy'){ e.preventDefault(); classicClipboard.capture(); return; }
    if(action?.type === 'group'){ e.preventDefault(); groupSelectedImages(); return; }
    if(action?.type === 'paste-deferred'){
        const pasteRequestedAt = Date.now();
        setTimeout(() => {
            if(!canvas) return;
            if(!XiaomeiHistoryKernel.pasteStillFresh(pasteRequestedAt, [lastImagePasteAt])) return;
            classicClipboard.paste();
        }, action.delay);
        return;
    }
    const decision = XiaomeiCanvasKeys.classicRemainder({
        key:e.key,
        command:e.ctrlKey || e.metaKey,
        alt:e.altKey,
        shift:e.shiftKey,
        editable:isEditableTarget(e.target),
        activeEditable:isEditableTarget(document.activeElement),
        fieldFocused,
        selectionCount:selected.size,
        surfaces
    });
    decision.effects.forEach(effect => applyClassicKeyEffect(e, effect));
});
window.addEventListener('keyup', e => {
    if(String(e.key || '').toLowerCase() === 'r') isRKeyDown = false;
    if(e.key === 'Shift') setKnifeMode(false);
});
async function refreshCanvasPage(e){
    if(e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if(e.code !== 'Digit5' && e.code !== 'Numpad5' && e.key !== '5') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if(e.repeat || canvasRefreshPending) return;
    canvasRefreshPending = true;
    try {
        if(!await canvasSession.flush()){
            showErrorModal(tr('common.canvasRefreshSaveFailed'), tr('common.canvasRefresh'));
            return;
        }
        location.reload();
    } finally {
        canvasRefreshPending = false;
    }
}
window.addEventListener('keydown', refreshCanvasPage, true);
window.addEventListener('blur', () => { isRKeyDown = false; setKnifeMode(false); });
function deleteSelectedNodes(){
    if(canvas && selected.size) classicLayout.remove([...selected], true);
}
function escapeHtml(str){ return String(str == null ? '' : str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
function escapeAttr(str){ return escapeHtml(str); }

window.onload = async () => {
    classicShell.start();
    if(window.StudioI18n) StudioI18n.apply();
    document.title = tr('canvas.title');
    applyViewport();
    await loadConfig();
    // 编辑器页只负责打开单个画布：必须带 ?id；没有 id 就回到独立的选画布页面。
    const openId = new URLSearchParams(window.location.search).get('id');
    if(openId){
        await openCanvas(openId);
    } else {
        window.location.replace(classicShell.projectListUrl());
    }
};
