// canvas-list.js — Project Workspace.
// Two-pane: LEFT project list, RIGHT pannable/zoomable board of canvas cards.
// Self-contained; relies only on global fetch / StudioI18n / lucide.

/* ===== Small helpers (copied from the previous gate file) ===== */
function refreshIcons(){ if(window.lucide) lucide.createIcons(); }
function tr(key){ return window.StudioI18n ? StudioI18n.t(key) : key; }
function langIsEn(){ return window.StudioI18n?.lang?.() === 'en'; }
function escapeHtml(str){ return String(str == null ? '' : str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
function escapeAttr(str){ return escapeHtml(str); }
function L(zh, en){ return langIsEn() ? en : zh; }
function compactLabel(fullZh, compactZh, en){ return window.innerWidth <= 760 ? L(compactZh, en) : L(fullZh, en); }
const CANVAS_LIST_PROJECT_KEY = 'canvasListCurrentProjectId';
const SOFT_FURNISHING_INBOX_KEY = 'soft_furnishing_canvas_inbox_v1';
const SOFT_FURNISHING_INBOX_TTL = 10 * 60 * 1000;
const COMFY_WORKFLOW_INBOX_KEY = 'comfy_canvas_workflow_inbox_v1';
const COMFY_WORKFLOW_INBOX_TTL = 10 * 60 * 1000;

function rememberedProjectId(){
    try {
        return new URLSearchParams(window.location.search).get('project') || localStorage.getItem(CANVAS_LIST_PROJECT_KEY) || 'default';
    } catch(e){
        return 'default';
    }
}

function rememberProjectId(pid){
    if(!pid) return;
    try { localStorage.setItem(CANVAS_LIST_PROJECT_KEY, pid); } catch(e){}
}

function formatCanvasTime(value){
    if(!value) return '--';
    const raw = Number(value);
    const time = raw < 10000000000 ? raw * 1000 : raw;
    const date = new Date(time);
    if(Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString(langIsEn() ? 'en-US' : 'zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function renderCanvasIcon(icon, size = 16){
    if(!icon || icon === '🧩') return `<i data-lucide="layers" style="width:${size}px;height:${size}px"></i>`;
    if(/[^\x00-\x7F]/.test(icon)) return escapeHtml(icon);
    return `<i data-lucide="${escapeHtml(icon)}" style="width:${size}px;height:${size}px"></i>`;
}

/* ===== DOM refs ===== */
const board = document.getElementById('board');
const boardWorld = document.getElementById('boardWorld');
const boardEmptyHint = document.getElementById('boardEmptyHint');
const boardProjectName = document.getElementById('boardProjectName');
const boardCanvasCount = document.getElementById('boardCanvasCount');
const projectListEl = document.getElementById('projectList');
const trashEntryBtn = document.getElementById('trashEntry');
const trashBadge = document.getElementById('trashBadge');
const trashPanel = document.getElementById('trashPanel');
const trashListEl = document.getElementById('trashList');
const trashCloseBtn = document.getElementById('trashClose');
const newProjectBtn = document.getElementById('newProjectBtn');
const newProjectRow = document.getElementById('newProjectRow');
const newProjectInput = document.getElementById('newProjectInput');
const newProjectConfirm = document.getElementById('newProjectConfirm');
const newProjectCancel = document.getElementById('newProjectCancel');
const newCanvasBtn = document.getElementById('newCanvasBtn');
const boardRefreshBtn = document.getElementById('boardRefresh');
const boardResetViewBtn = document.getElementById('boardResetView');
const joinCanvasBtn = document.getElementById('joinCanvasBtn');
const toolbarShareCanvasBtn = document.getElementById('toolbarShareCanvasBtn');
const pasteCanvasBtn = document.getElementById('pasteCanvasBtn');
const emptyCreateCanvasBtn = document.getElementById('emptyCreateCanvasBtn');
const statusEl = document.getElementById('boardStatus');

/* ===== State ===== */
let projects = [];
let canvases = [];          // all canvases across projects
let deletedCanvases = [];
let deletedProjects = [];
let currentProjectId = rememberedProjectId();
let pendingDeleteProjectId = null;
let statusTimer = null;
let clipboardCanvasId = null;   // 剪切的画布（切到别的项目后粘贴）
let shareDialogEl = null;
let joinCanvasDialogEl = null;
let workspaceHasLoaded = false;
let workspaceLoadState = 'loading';
let workspaceLoadController = null;
let workspaceLoadSequence = 0;
let softFurnishingInboxOpening = false;
let comfyWorkflowInboxOpening = false;
const WORKSPACE_LOAD_TIMEOUT_MS = 8000;

// board viewport (mirrors smart-canvas math)
const viewport = { x: 0, y: 0, scale: 1 };
const MIN_SCALE = 0.3, MAX_SCALE = 2;

/* ===== Status toast ===== */
function setStatus(text){
    if(!statusEl) return;
    if(!text){ statusEl.classList.remove('show'); return; }
    statusEl.textContent = text;
    statusEl.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.remove('show'), 2200);
}

/* ===== Viewport math (mirrors smart-canvas.js) ===== */
function applyViewport(){
    boardWorld.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
    board.style.backgroundSize = `${120 * viewport.scale}px ${120 * viewport.scale}px, ${120 * viewport.scale}px ${120 * viewport.scale}px, ${24 * viewport.scale}px ${24 * viewport.scale}px`;
    board.style.backgroundPosition = `${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px`;
}
function screenToWorld(clientX, clientY){
    const rect = board.getBoundingClientRect();
    return XiaomeiCanvasEditorCore.screenToWorld(clientX, clientY, rect, viewport);
}
function boardCenterWorld(){
    return XiaomeiCanvasEditorCore.boardCenterWorld(board.clientWidth, board.clientHeight, viewport);
}
function resetView(){
    const cards = Array.from(boardWorld.querySelectorAll('.ws-card'));
    if(!cards.length){
        viewport.x = 0; viewport.y = 0; viewport.scale = 1; applyViewport();
        return;
    }
    const bounds = cards.reduce((acc, el) => {
        const x = parseFloat(el.style.left) || 0;
        const y = parseFloat(el.style.top) || 0;
        const w = el.offsetWidth || 248;
        const h = el.offsetHeight || 150;
        acc.minX = Math.min(acc.minX, x);
        acc.minY = Math.min(acc.minY, y);
        acc.maxX = Math.max(acc.maxX, x + w);
        acc.maxY = Math.max(acc.maxY, y + h);
        return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const padding = board.clientWidth < 640 ? 20 : 40;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const fitScale = Math.min(1, (board.clientWidth - padding * 2) / width, (board.clientHeight - padding * 2) / height);
    viewport.scale = board.clientWidth < 640 ? 1 : Math.min(MAX_SCALE, Math.max(0.9, fitScale));
    const fitsX = width * viewport.scale <= board.clientWidth - padding * 2;
    const fitsY = height * viewport.scale <= board.clientHeight - padding * 2;
    viewport.x = Math.round((fitsX ? (board.clientWidth - width * viewport.scale) / 2 : padding) - bounds.minX * viewport.scale);
    viewport.y = Math.round((fitsY ? Math.max(padding, (board.clientHeight - height * viewport.scale) / 2) : padding) - bounds.minY * viewport.scale);
    applyViewport();
}

/* ===== Board pan & zoom ===== */
let panState = null;
function onBoardPanStart(e){
    if(e.button !== 0) return;
    if(e.target.closest('.ws-card') || e.target.closest('.ws-create-card') || e.target.closest('.ws-card-pop') || e.target.closest('button,input,textarea,select')) return;
    closeCardMenu();
    panState = { startX: e.clientX, startY: e.clientY, ox: viewport.x, oy: viewport.y, moved: false };
    board.classList.add('panning');
}
function onBoardPanMove(e){
    if(!panState) return;
    viewport.x = panState.ox + (e.clientX - panState.startX);
    viewport.y = panState.oy + (e.clientY - panState.startY);
    if(Math.abs(e.clientX - panState.startX) > 3 || Math.abs(e.clientY - panState.startY) > 3) panState.moved = true;
    applyViewport();
}
function onBoardPanEnd(){
    if(!panState) return;
    panState = null;
    board.classList.remove('panning');
}
function onBoardWheel(e){
    e.preventDefault();
    const rect = board.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // world point under cursor before zoom
    const wx = (px - viewport.x) / viewport.scale;
    const wy = (py - viewport.y) / viewport.scale;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale * factor));
    viewport.scale = next;
    // keep the same world point under the cursor
    viewport.x = px - wx * next;
    viewport.y = py - wy * next;
    applyViewport();
}

/* ===== Data loading ===== */
function currentProject(){ return projects.find(p => p.id === currentProjectId) || projects[0] || null; }
function canvasesInProject(pid){
    return canvases.filter(c => (c.project || 'default') === pid && c.kind === 'smart');
}

function setBoardEmptyState(state){
    const title = boardEmptyHint?.querySelector('.ws-board-empty-text');
    const subtitle = boardEmptyHint?.querySelector('.ws-board-empty-sub');
    const actions = boardEmptyHint?.querySelector('.ws-board-empty-actions');
    if(!title || !subtitle) return;
    boardEmptyHint.dataset.state = state;
    if(state === 'loading'){
        title.textContent = L('正在读取画布','Loading canvases');
        subtitle.textContent = L('正在从本地服务读取项目与画布','Reading projects and canvases from the local service');
        if(actions) actions.hidden = true;
        return;
    }
    if(state === 'error'){
        title.textContent = L('暂时无法读取画布','Can’t load canvases right now');
        subtitle.textContent = L('画布未被删除，请点击右上角刷新后重试','Your canvases were not deleted. Click Refresh and try again.');
        if(actions) actions.hidden = true;
        return;
    }
    title.textContent = L('暂无画布','No canvases yet');
    subtitle.textContent = L('为当前项目创建第一块画布','Create the first canvas for this project');
    if(actions) actions.hidden = false;
}

async function fetchWorkspaceJson(path, signal){
    const response = await fetch(path, {cache:'no-store', signal});
    if(!response.ok) throw new Error(`${path} failed with ${response.status}`);
    return response.json();
}

async function loadAll(){
    const sequence = ++workspaceLoadSequence;
    workspaceLoadController?.abort();
    const controller = new AbortController();
    workspaceLoadController = controller;
    workspaceLoadState = 'loading';
    if(!workspaceHasLoaded){
        renderProjects();
        renderBoard();
    }
    const timeout = setTimeout(() => controller.abort(), WORKSPACE_LOAD_TIMEOUT_MS);
    try {
        const [pData, cData] = await Promise.all([
            fetchWorkspaceJson('/api/projects', controller.signal),
            fetchWorkspaceJson('/api/canvases', controller.signal)
        ]);
        if(sequence !== workspaceLoadSequence) return;
        if(!Array.isArray(pData?.projects) || !Array.isArray(cData?.canvases)){
            throw new Error('workspace response has an invalid shape');
        }
        projects = (pData.projects || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        if(!projects.length) projects = [{ id: 'default', name: L('默认项目','Default'), order: 0, canvas_count: 0 }];
        canvases = cData.canvases || [];
        workspaceHasLoaded = true;
        workspaceLoadState = 'ready';
        // pick first project (prefer default / order 0)
        if(!projects.find(p => p.id === currentProjectId)){
            const def = projects.find(p => p.id === 'default') || projects.slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
            currentProjectId = def ? def.id : 'default';
        }
        rememberProjectId(currentProjectId);
        renderProjects();
        renderBoard();
        resetView();
        await refreshTrashCount();
    } catch(e){
        if(sequence !== workspaceLoadSequence) return;
        console.error(e);
        workspaceLoadState = 'error';
        // A failed or timed-out request is never evidence that data is empty.
        // Keep the last successful state; on first load render an explicit
        // error instead of the destructive-looking "no canvases" empty state.
        if(!workspaceHasLoaded && !projects.length){
            projects = [{ id: 'default', name: L('默认项目','Default'), order: 0, canvas_count: 0 }];
            currentProjectId = 'default';
        }
        renderProjects();
        renderBoard();
        setStatus(L('画布列表读取失败，请点击刷新重试','Could not load canvases. Click Refresh to retry.'));
    } finally {
        clearTimeout(timeout);
        if(sequence === workspaceLoadSequence) workspaceLoadController = null;
    }
}

function projectCanvasCount(pid){
    const p = projects.find(x => x.id === pid);
    // prefer live count from canvases array; fall back to server count
    const live = canvasesInProject(pid).length;
    return canvases.length ? live : (p?.canvas_count || 0);
}

/* ===== Project sidebar rendering ===== */
function renderProjects(){
    projectListEl.innerHTML = '';
    projects.forEach(p => {
        if(pendingDeleteProjectId === p.id){
            const box = document.createElement('div');
            box.className = 'ws-project-confirm';
            box.innerHTML = `
                <div class="ws-project-confirm-title">${L('将项目移入回收站','Move project to Trash')}「${escapeHtml(p.name)}」？${L('项目和其中画布都可以恢复。','The project and its canvases can be restored.')}</div>
                <div class="ws-project-confirm-actions">
                    <button class="ws-confirm-btn" type="button">${L('删除','Delete')}</button>
                    <button class="ws-cancel-btn" type="button">${L('取消','Cancel')}</button>
                </div>`;
            box.querySelector('.ws-confirm-btn').onclick = () => deleteProject(p.id);
            box.querySelector('.ws-cancel-btn').onclick = () => { pendingDeleteProjectId = null; renderProjects(); };
            projectListEl.appendChild(box);
            return;
        }
        const row = document.createElement('div');
        row.className = 'ws-project-row' + (p.id === currentProjectId ? ' active' : '');
        row.dataset.projectId = p.id;
        const count = projectCanvasCount(p.id);
        const isDefault = p.id === 'default';
        row.innerHTML = `
            <span class="ws-project-icon"><i data-lucide="${isDefault ? 'folder' : 'folder-open'}" class="w-4 h-4"></i></span>
            <span class="ws-project-name">${escapeHtml(p.name)}</span>
            <span class="ws-project-count">${count}</span>
            <span class="ws-project-actions">
                <button class="ws-proj-act rename" type="button" title="${L('重命名','Rename')}" aria-label="${L('重命名','Rename')}"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                ${isDefault ? '' : `<button class="ws-proj-act del" type="button" title="${L('删除','Delete')}" aria-label="${L('删除','Delete')}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`}
            </span>`;
        row.onclick = e => {
            if(e.target.closest('.ws-proj-act')) return;
            selectProject(p.id);
        };
        const renameBtn = row.querySelector('.ws-proj-act.rename');
        if(renameBtn) renameBtn.onclick = e => { e.stopPropagation(); startProjectRename(p.id, row); };
        const delBtn = row.querySelector('.ws-proj-act.del');
        if(delBtn) delBtn.onclick = e => { e.stopPropagation(); pendingDeleteProjectId = p.id; renderProjects(); };
        projectListEl.appendChild(row);
    });
    refreshIcons();
}

function selectProject(pid){
    if(pid === currentProjectId && !trashPanel.classList.contains('active')) return;
    currentProjectId = pid;
    rememberProjectId(pid);
    closeTrashView();
    renderProjects();
    renderBoard();
    resetView();
}

function startProjectRename(pid, row){
    const p = projects.find(x => x.id === pid);
    if(!p) return;
    const nameEl = row.querySelector('.ws-project-name');
    if(!nameEl || nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 60; input.value = p.name;
    input.className = 'ws-project-name-input';
    nameEl.replaceWith(input);
    input.focus(); input.select();
    input.onclick = e => e.stopPropagation();
    let done = false;
    const finish = commit => {
        if(done) return; done = true;
        const v = input.value.trim();
        if(commit && v && v !== p.name) renameProject(pid, v);
        else renderProjects();
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => {
        e.stopPropagation();
        if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
        if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    };
}

/* ===== Project CRUD ===== */
function openNewProject(){
    newProjectRow.classList.add('active');
    newProjectInput.value = '';
    newProjectInput.focus();
}
function closeNewProject(){
    newProjectRow.classList.remove('active');
    newProjectInput.value = '';
}
async function createProject(){
    const name = newProjectInput.value.trim() || L('新项目','New project');
    closeNewProject();
    try {
        const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if(!res.ok) throw new Error('create project failed');
        const data = await res.json();
        const proj = data.project;
        if(proj){
            projects.push(proj);
            projects.sort((a, b) => (a.order || 0) - (b.order || 0));
            selectProject(proj.id);
            renderProjects();
        }
    } catch(e){
        console.error(e); setStatus(L('创建项目失败','Create project failed'));
    }
}
async function renameProject(pid, name){
    const p = projects.find(x => x.id === pid);
    if(p) p.name = name;
    renderProjects();
    if(pid === currentProjectId) updateBoardHeader();
    try {
        const res = await fetch(`/api/projects/${encodeURIComponent(pid)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if(!res.ok) throw new Error('rename project failed');
    } catch(e){ console.error(e); setStatus(L('重命名失败','Rename failed')); loadAll(); }
}
async function deleteProject(pid){
    pendingDeleteProjectId = null;
    try {
        const res = await fetch(`/api/projects/${encodeURIComponent(pid)}`, { method: 'DELETE' });
        if(!res.ok) throw new Error('delete project failed');
        projects = projects.filter(p => p.id !== pid);
        if(currentProjectId === pid) currentProjectId = 'default';
        rememberProjectId(currentProjectId);
        renderProjects();
        renderBoard();
        await refreshTrashCount();
        setStatus(L('项目已移入回收站','Project moved to trash'));
    } catch(e){ console.error(e); setStatus(L('删除项目失败','Delete project failed')); loadAll(); }
}

/* ===== Board rendering ===== */
function updateBoardHeader(){
    const p = currentProject();
    boardProjectName.textContent = p ? p.name : L('默认项目','Default');
    boardCanvasCount.textContent = (!workspaceHasLoaded && workspaceLoadState !== 'ready')
        ? '—'
        : String(canvasesInProject(currentProjectId).length);
}

function autoLayoutNulls(items){
    // grid layout for cards with null board position; persist each once.
    const X0 = 40, Y0 = 40, XSTRIDE = 276, YSTRIDE = 176, COLS = 4;
    const positioned = items.filter(c => c.board_x != null && c.board_y != null);
    const nulls = items.filter(c => c.board_x == null || c.board_y == null);
    // start index after existing positioned grid slots to reduce overlap
    let i = positioned.length;
    nulls.forEach(c => {
        const col = i % COLS, rowIdx = Math.floor(i / COLS);
        c.board_x = X0 + col * XSTRIDE;
        c.board_y = Y0 + rowIdx * YSTRIDE;
        i++;
        persistMeta(c.id, { board_x: c.board_x, board_y: c.board_y });
    });
}

function renderBoard(){
    updateBoardHeader();
    const items = canvasesInProject(currentProjectId);
    autoLayoutNulls(items);
    boardWorld.innerHTML = '';
    items.forEach(c => boardWorld.appendChild(buildCard(c)));
    boardEmptyHint.classList.toggle('hidden', items.length > 0);
    if(!items.length) setBoardEmptyState(!workspaceHasLoaded ? workspaceLoadState : 'empty');
    updatePasteBtn();
    refreshIcons();
}

function buildCard(c){
    const isSmart = (c.kind || 'classic') === 'smart';
    const card = document.createElement('div');
    card.className = 'ws-card'
        + (String(c.color || '').trim() ? ' cc-marked' : '')
        + (clipboardCanvasId === c.id ? ' cut' : '');
    card.dataset.canvasId = c.id;
    card.style.left = (c.board_x || 0) + 'px';
    card.style.top = (c.board_y || 0) + 'px';
    // 卡片布局：顶部=类型标签+更多按钮；中部=标题；底部=节点数·时间。已移除图标。
    card.innerHTML = `
        <div class="ws-card-top">
            <span class="ws-card-kind ${isSmart ? 'smart' : 'classic'}">${isSmart ? compactLabel('智能画布','智能','Smart') : compactLabel('普通画布','普通','Classic')}</span>
            <button class="ws-card-menu" type="button" title="${L('更多','More')}" aria-label="${L('更多','More')}"><i data-lucide="more-horizontal" class="w-4 h-4"></i></button>
        </div>
        <div class="ws-card-title">${escapeHtml(c.title)}</div>
        <div class="ws-card-meta">
            <span class="ws-card-nodes">${(c.node_count != null ? c.node_count : 0)} ${L('节点','nodes')}</span>
            <span class="ws-card-meta-dot"></span>
            <span class="ws-card-time">${formatCanvasTime(c.updated_at || c.created_at)}</span>
        </div>
        <div class="ws-card-delete-confirm">
            <div class="ws-card-delete-title">${L('移入回收站？','Move to trash?')}</div>
            <div class="ws-card-delete-actions">
                <button class="ws-card-delete-yes" type="button">${L('删除','Delete')}</button>
                <button class="ws-card-delete-no" type="button">${L('取消','Cancel')}</button>
            </div>
        </div>`;
    attachCardDrag(card, c);
    const menuBtn = card.querySelector('.ws-card-menu');
    menuBtn.onmousedown = e => e.stopPropagation();
    menuBtn.onclick = e => { e.stopPropagation(); openCardMenu(c.id, menuBtn); };
    card.querySelector('.ws-card-delete-confirm').onmousedown = e => e.stopPropagation();
    card.querySelector('.ws-card-delete-yes').onclick = e => { e.stopPropagation(); deleteCanvas(c.id); };
    card.querySelector('.ws-card-delete-no').onclick = e => { e.stopPropagation(); card.classList.remove('confirming-delete'); };
    return card;
}

/* ===== Card drag vs click ===== */
function attachCardDrag(card, c){
    card.addEventListener('mousedown', e => {
        if(e.button !== 0) return;
        if(e.target.closest('.ws-card-menu')) return;
        if(e.target.closest('.ws-card-delete-confirm')) return;
        if(card.querySelector('.ws-card-title-input')) return; // editing title
        e.stopPropagation();
        closeCardMenu();
        const startWorld = screenToWorld(e.clientX, e.clientY);
        const origX = c.board_x || 0, origY = c.board_y || 0;
        let moved = false;
        const onMove = ev => {
            const w = screenToWorld(ev.clientX, ev.clientY);
            const dx = w.x - startWorld.x, dy = w.y - startWorld.y;
            if(!moved && (Math.abs(dx * viewport.scale) > 5 || Math.abs(dy * viewport.scale) > 5)){
                moved = true; card.classList.add('dragging');
            }
            if(moved){
                c.board_x = origX + dx; c.board_y = origY + dy;
                card.style.left = c.board_x + 'px';
                card.style.top = c.board_y + 'px';
            }
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            card.classList.remove('dragging');
            if(moved){
                persistMeta(c.id, { board_x: Math.round(c.board_x), board_y: Math.round(c.board_y) });
            } else {
                openCanvas(c);
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function openCanvas(c){
    const enc = encodeURIComponent(c.id);
    const project = encodeURIComponent(c.project || currentProjectId || 'default');
    rememberProjectId(c.project || currentProjectId || 'default');
    window.location.href = (c.kind === 'smart')
        ? `/static/smart-canvas.html?id=${enc}&project=${project}&v=2026.09.27.image-model-picker3`
        : `/static/canvas.html?id=${enc}&project=${project}&v=2026.09.10.1`;
}

function readSoftFurnishingInbox(){
    try {
        const payload = JSON.parse(localStorage.getItem(SOFT_FURNISHING_INBOX_KEY) || 'null');
        const url = String(payload?.image?.url || '').trim();
        const queuedAt = Number(payload?.queued_at || 0);
        const isLocalAsset = /^\/(?:assets|output|api\/storage-files)\//.test(url);
        if(!url || !isLocalAsset || !queuedAt || Date.now() - queuedAt > SOFT_FURNISHING_INBOX_TTL){
            localStorage.removeItem(SOFT_FURNISHING_INBOX_KEY);
            return null;
        }
        return payload;
    } catch(e){
        try { localStorage.removeItem(SOFT_FURNISHING_INBOX_KEY); } catch(_) {}
        return null;
    }
}

function readComfyWorkflowInbox(){
    try {
        const payload = JSON.parse(localStorage.getItem(COMFY_WORKFLOW_INBOX_KEY) || 'null');
        const workflowRef = String(payload?.workflow_ref || '').trim();
        const queuedAt = Number(payload?.queued_at || 0);
        if(!workflowRef || !queuedAt || Date.now() - queuedAt > COMFY_WORKFLOW_INBOX_TTL){
            localStorage.removeItem(COMFY_WORKFLOW_INBOX_KEY);
            return null;
        }
        return payload;
    } catch(e){
        try { localStorage.removeItem(COMFY_WORKFLOW_INBOX_KEY); } catch(_) {}
        return null;
    }
}

async function openSoftFurnishingInbox(){
    const payload = readSoftFurnishingInbox();
    if(!payload || softFurnishingInboxOpening) return false;
    softFurnishingInboxOpening = true;
    let created = false;
    try {
        const sceneName = String(payload.scene_name || '软装场景').trim() || '软装场景';
        setStatus(L('正在创建软装智能画布…', 'Creating furnishing canvas…'));
        const res = await fetch('/api/canvases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `${sceneName} · 软装编排`,
                icon: 'box',
                kind: 'smart',
                project: currentProjectId || 'default'
            })
        });
        const data = await res.json().catch(() => ({}));
        if(!res.ok || !data?.canvas?.id) throw new Error(data?.detail || 'create canvas failed');
        const projectId = data.canvas.project || currentProjectId || 'default';
        rememberProjectId(projectId);
        created = true;
        window.location.href = `/static/smart-canvas.html?id=${encodeURIComponent(data.canvas.id)}&project=${encodeURIComponent(projectId)}&v=2026.09.27.image-model-picker3`;
        return true;
    } catch(e){
        console.error('open soft furnishing inbox failed', e);
        setStatus(L('无法创建软装画布，请重试', 'Unable to create furnishing canvas. Please try again.'));
        return false;
    } finally {
        if(!created) softFurnishingInboxOpening = false;
    }
}

async function openComfyWorkflowInbox(){
    const payload = readComfyWorkflowInbox();
    if(!payload || comfyWorkflowInboxOpening) return false;
    if(!workspaceHasLoaded && workspaceLoadState === 'loading'){
        window.setTimeout(() => { openComfyWorkflowInbox(); }, 160);
        return false;
    }
    comfyWorkflowInboxOpening = true;
    let created = false;
    try {
        const title = String(payload.workflow_title || payload.workflow_ref || 'ComfyUI 工作流').trim() || 'ComfyUI 工作流';
        setStatus(L('正在创建 ComfyUI 工作流画布…', 'Creating a ComfyUI workflow canvas…'));
        const res = await fetch('/api/canvases', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                title:`${title} · ComfyUI`,
                icon:'workflow',
                kind:'smart',
                project:currentProjectId || 'default'
            })
        });
        const data = await res.json().catch(() => ({}));
        if(!res.ok || !data?.canvas?.id) throw new Error(data?.detail || 'create canvas failed');
        const projectId = data.canvas.project || currentProjectId || 'default';
        rememberProjectId(projectId);
        created = true;
        window.location.href = `/static/smart-canvas.html?id=${encodeURIComponent(data.canvas.id)}&project=${encodeURIComponent(projectId)}&v=2026.09.27.image-model-picker3`;
        return true;
    } catch(e){
        console.error('open ComfyUI workflow inbox failed', e);
        setStatus(L('无法创建 ComfyUI 工作流画布，请重试', 'Unable to create a ComfyUI workflow canvas. Please try again.'));
        return false;
    } finally {
        if(!created) comfyWorkflowInboxOpening = false;
    }
}

/* ===== Card create flow ===== */
let createCardEl = null;
let createKind = 'smart';
function closeCreateCard(){ createCardEl?.remove(); createCardEl = null; }
function openCreateCard(worldPt){
    closeCreateCard();
    closeCardMenu();
    createKind = 'smart';
    const el = document.createElement('div');
    el.className = 'ws-create-card';
    el.style.left = worldPt.x + 'px';
    el.style.top = worldPt.y + 'px';
    el.innerHTML = `
        <div class="ws-create-title">${L('新建画布','New canvas')}</div>
        <input class="ws-create-input" type="text" maxlength="80" placeholder="${L('画布名称（可留空）','Canvas name (optional)')}">
        <div class="ws-create-actions">
            <button class="ws-create-confirm" type="button">${L('创建','Create')}</button>
            <button class="ws-create-cancel" type="button">${L('取消','Cancel')}</button>
        </div>`;
    boardWorld.appendChild(el);
    createCardEl = el;
    el.addEventListener('mousedown', e => e.stopPropagation());
    const input = el.querySelector('.ws-create-input');
    input.focus();
    const confirm = () => createCanvasOnBoard(input.value.trim(), createKind, worldPt);
    el.querySelector('.ws-create-confirm').onclick = confirm;
    el.querySelector('.ws-create-cancel').onclick = closeCreateCard;
    input.onkeydown = e => {
        e.stopPropagation();
        if(e.key === 'Enter'){ e.preventDefault(); confirm(); }
        if(e.key === 'Escape'){ e.preventDefault(); closeCreateCard(); }
    };
}

async function createCanvasOnBoard(title, kind, worldPt){
    kind = 'smart';
    const isSmart = true;
    const base = L('智能画布','Smart canvas');
    const name = title || `${base} ${new Date().toLocaleTimeString(langIsEn() ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    closeCreateCard();
    try {
        const res = await fetch('/api/canvases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: name,
                icon: isSmart ? 'sparkles' : '🧩',
                kind: isSmart ? 'smart' : 'classic',
                project: currentProjectId,
                board_x: Math.round(worldPt.x),
                board_y: Math.round(worldPt.y)
            })
        });
        if(!res.ok) throw new Error('create canvas failed');
        const data = await res.json();
        const nc = data.canvas;
        if(nc){
            if(nc.project == null) nc.project = currentProjectId;
            if(nc.board_x == null) nc.board_x = Math.round(worldPt.x);
            if(nc.board_y == null) nc.board_y = Math.round(worldPt.y);
            canvases.push(nc);
            renderBoard();
            renderProjects();
        }
    } catch(e){ console.error(e); setStatus(L('创建失败','Create failed')); }
}

/* ===== Card context menu (rename / delete / move) ===== */
function closeCardMenu(){ document.querySelector('.ws-card-pop')?.remove(); }
function openCardMenu(canvasId, anchorBtn){
    closeCardMenu();
    const c = canvases.find(x => x.id === canvasId);
    if(!c) return;
    const pop = document.createElement('div');
    pop.className = 'ws-card-pop';
    pop.innerHTML = `
        <button class="ws-pop-item" data-act="rename"><i data-lucide="pencil" class="w-4 h-4"></i><span>${L('重命名','Rename')}</span></button>
        <button class="ws-pop-item" data-act="export"><i data-lucide="download" class="w-4 h-4"></i><span>${L('导出画布','Export canvas')}</span></button>
        <button class="ws-pop-item" data-act="export-assets"><i data-lucide="archive" class="w-4 h-4"></i><span>${L('导出画布 + 资源','Export with assets')}</span></button>
        <button class="ws-pop-item" data-act="cut"><i data-lucide="scissors" class="w-4 h-4"></i><span>${L('剪切到其他项目','Cut to project')}</span></button>
        <div class="ws-pop-sep"></div>
        <button class="ws-pop-item danger" data-act="delete"><i data-lucide="trash-2" class="w-4 h-4"></i><span>${L('删除','Delete')}</span></button>`;
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    const w = pop.offsetWidth || 188, h = pop.offsetHeight || 120;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if(top + h > window.innerHeight - 12) top = r.top - h - 6;
    pop.style.left = Math.round(Math.max(12, left)) + 'px';
    pop.style.top = Math.round(Math.max(12, top)) + 'px';
    pop.querySelector('[data-act="rename"]').onclick = () => { closeCardMenu(); startCardRename(canvasId); };
    pop.querySelector('[data-act="export"]').onclick = () => { closeCardMenu(); exportCanvas(canvasId); };
    pop.querySelector('[data-act="export-assets"]').onclick = () => { closeCardMenu(); exportCanvasWithResources(canvasId); };
    pop.querySelector('[data-act="cut"]').onclick = () => { closeCardMenu(); cutCanvas(canvasId); };
    pop.querySelector('[data-act="delete"]').onclick = () => { closeCardMenu(); showCardDeleteConfirm(canvasId); };
    refreshIcons();
}

/* ===== Canvas sharing dialog ===== */
function closeShareDialog(){
    shareDialogEl?.remove();
    shareDialogEl = null;
}

function openShareCanvasPicker(items){
    closeCardMenu();
    closeShareDialog();
    const project = currentProject();
    const dialog = document.createElement('div');
    dialog.className = 'ws-share-backdrop';
    dialog.innerHTML = `
        <section class="ws-share-dialog ws-share-picker" role="dialog" aria-modal="true" aria-labelledby="wsSharePickerTitle">
            <header class="ws-share-head">
                <div><span class="ws-share-kicker">${L('画布协作','Canvas collaboration')}</span><h2 id="wsSharePickerTitle">${L('选择要分享的画布','Choose a canvas to share')}</h2><p>${escapeHtml(project?.name || L('当前项目','Current project'))}</p></div>
                <button type="button" class="ws-share-close" data-close-share aria-label="${L('关闭','Close')}"><i data-lucide="x"></i></button>
            </header>
            <div class="ws-share-picker-list">
                ${items.map(item => `
                    <button type="button" class="ws-share-picker-item" data-share-picker-id="${escapeAttr(item.id)}">
                        <span class="ws-share-picker-icon">${renderCanvasIcon(item.icon, 17)}</span>
                        <span class="ws-share-picker-copy"><strong>${escapeHtml(item.title || L('未命名画布','Untitled canvas'))}</strong><small>${escapeHtml(formatCanvasTime(item.updated_at || item.updatedAt || item.created_at))}</small></span>
                        <i data-lucide="chevron-right" class="ws-share-picker-arrow"></i>
                    </button>`).join('')}
            </div>
            <footer class="ws-share-foot"><button type="button" class="ws-share-cancel" data-close-share>${L('关闭','Close')}</button></footer>
        </section>`;
    document.body.appendChild(dialog);
    shareDialogEl = dialog;
    dialog.querySelectorAll('[data-close-share]').forEach(button => button.onclick = closeShareDialog);
    dialog.addEventListener('mousedown', event => { if(event.target === dialog) closeShareDialog(); });
    dialog.querySelectorAll('[data-share-picker-id]').forEach(button => {
        button.onclick = () => {
            const canvasId = button.dataset.sharePickerId || '';
            closeShareDialog();
            if(canvasId) openShareDialog(canvasId);
        };
    });
    refreshIcons();
}

function openToolbarShareDialog(){
    const items = canvasesInProject(currentProjectId);
    if(!items.length){
        setStatus(L('当前项目暂无可分享的智能画布','No smart canvas to share in this project'));
        return;
    }
    if(items.length === 1){
        openShareDialog(items[0].id);
        return;
    }
    openShareCanvasPicker(items);
}

/* ===== Join a shared canvas ===== */
function closeJoinCanvasDialog(){
    joinCanvasDialogEl?.remove();
    joinCanvasDialogEl = null;
}

function normalizeCanvasShareUrl(raw){
    const value = String(raw || '').trim().replace(/^[<\"'“]+|[>\"'”]+$/g, '');
    if(!value) throw new Error(L('请粘贴完整的分享链接','Paste the complete share link'));
    let parsed;
    try { parsed = new URL(value); } catch(_){
        throw new Error(L('链接格式不正确，请粘贴以 http:// 或 https:// 开头的完整链接','Invalid link. Paste a complete http:// or https:// link'));
    }
    if(!['http:','https:'].includes(parsed.protocol)){
        throw new Error(L('只支持 http:// 或 https:// 分享链接','Only http:// or https:// share links are supported'));
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const invitePath = /^\/share\/[^/]+$/i.test(path);
    const sharedPage = /^\/static\/(?:smart-canvas|canvas)\.html$/i.test(path)
        && parsed.searchParams.get('shared') === '1'
        && Boolean(parsed.searchParams.get('share_id') || parsed.searchParams.get('share'));
    const token = parsed.searchParams.get('token') || parsed.searchParams.get('share_token');
    if(!token || (!invitePath && !sharedPage)){
        throw new Error(L('这不是有效的画布分享链接，请使用“分享画布”生成的完整链接','This is not a valid canvas share link. Use the complete link from “Share canvas”'));
    }
    return parsed.toString();
}

function openSharedCanvasFromDesktop(url){
    const api = window.electronAPI;
    if(typeof api?.openSharedCanvas === 'function'){
        return Promise.resolve(api.openSharedCanvas(url));
    }
    // canvas-list normally runs inside index.html. Ask the outer desktop shell
    // to create a top-level window so the host cookie remains first-party.
    if(window.parent && window.parent !== window){
        const requestId = `canvas_share_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if(settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                fn(value);
            };
            const onMessage = event => {
                if(event.origin !== location.origin || event.source !== window.parent) return;
                if(event.data?.type !== 'canvas-share-open-result' || event.data.requestId !== requestId) return;
                const result = event.data.result || {};
                if(result.ok) finish(resolve, result);
                else finish(reject, new Error(result.message || L('无法打开协同画布','Could not open shared canvas')));
            };
            const timer = window.setTimeout(() => finish(reject, new Error(L('桌面端没有响应，请重启小美画布后重试','The desktop app did not respond. Restart Xiaomei Canvas and try again'))), 8000);
            window.addEventListener('message', onMessage);
            try {
                window.parent.postMessage({type:'canvas-share-open', url, requestId}, location.origin);
            } catch(error){
                finish(reject, error);
            }
        });
    }
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if(!popup) throw new Error(L('浏览器阻止了新窗口，请允许弹出窗口后重试','The browser blocked the new window. Allow pop-ups and try again'));
    return Promise.resolve({ok:true, mode:'browser'});
}

async function submitJoinCanvasDialog(dialog){
    const input = dialog?.querySelector('[data-join-share-url]');
    const button = dialog?.querySelector('[data-open-shared-canvas]');
    const status = dialog?.querySelector('[data-join-status]');
    if(!input || !button) return;
    const show = (text, tone='') => {
        if(!status) return;
        status.textContent = text || '';
        status.className = `ws-join-status${tone ? ` ${tone}` : ''}`;
    };
    let url;
    try { url = normalizeCanvasShareUrl(input.value); }
    catch(error){ show(error.message || L('链接格式不正确','Invalid share link'), 'error'); input.focus(); return; }
    button.disabled = true;
    show(L('正在打开协同画布…','Opening shared canvas…'));
    try {
        const result = await openSharedCanvasFromDesktop(url);
        if(!result?.ok) throw new Error(result?.message || L('无法打开协同画布','Could not open shared canvas'));
        closeJoinCanvasDialog();
        setStatus(result.mode === 'browser' ? L('已在新窗口打开协同画布','Shared canvas opened in a new window') : L('协同画布已打开；分享者需保持软件运行','Shared canvas opened. The host app must stay running'));
    } catch(error){
        show(error.message || L('无法打开协同画布','Could not open shared canvas'), 'error');
    } finally {
        button.disabled = false;
    }
}

function openJoinCanvasDialog(){
    closeCardMenu();
    closeShareDialog();
    closeJoinCanvasDialog();
    const dialog = document.createElement('div');
    dialog.className = 'ws-share-backdrop';
    dialog.innerHTML = `
        <section class="ws-share-dialog ws-join-dialog" role="dialog" aria-modal="true" aria-labelledby="wsJoinTitle">
            <header class="ws-share-head">
                <div><span class="ws-share-kicker">${L('画布协作','Canvas collaboration')}</span><h2 id="wsJoinTitle">${L('加入协同画布','Join shared canvas')}</h2><p>${L('在小美画布软件内打开他人发来的协同链接','Open an invitation inside Xiaomei Canvas')}</p></div>
                <button type="button" class="ws-share-close" data-close-join aria-label="${L('关闭','Close')}"><i data-lucide="x"></i></button>
            </header>
            <p class="ws-join-copy">${L('粘贴分享者复制的完整链接。软件会打开一个独立的协同窗口，画布数据仍保存在分享者电脑上。','Paste the complete link copied by the host. A separate collaboration window will open; the canvas data remains on the host computer.')}</p>
            <label class="ws-join-field"><span>${L('分享链接','Share link')}</span><input data-join-share-url type="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.x.x:3000/share/...?...token=..."></label>
            <div class="ws-join-note"><i data-lucide="server"></i><span>${L('在线协作不是导入副本：分享者的小美画布必须保持运行；“可编辑”链接会修改对方的原画布。','Online collaboration is not a local copy: the host must keep Xiaomei Canvas running. An editable link changes the host canvas.')}</span></div>
            <div class="ws-join-status" data-join-status aria-live="polite"></div>
            <footer class="ws-share-foot"><button type="button" class="ws-share-cancel" data-close-join>${L('取消','Cancel')}</button><button type="button" class="ws-share-create" data-open-shared-canvas>${L('打开协同画布','Open shared canvas')}</button></footer>
        </section>`;
    document.body.appendChild(dialog);
    joinCanvasDialogEl = dialog;
    dialog.querySelectorAll('[data-close-join]').forEach(button => button.onclick = closeJoinCanvasDialog);
    dialog.addEventListener('mousedown', event => { if(event.target === dialog) closeJoinCanvasDialog(); });
    const input = dialog.querySelector('[data-join-share-url]');
    input?.addEventListener('keydown', event => {
        if(event.key === 'Enter'){ event.preventDefault(); submitJoinCanvasDialog(dialog); }
    });
    dialog.querySelector('[data-open-shared-canvas]')?.addEventListener('click', () => submitJoinCanvasDialog(dialog));
    refreshIcons();
    window.setTimeout(() => input?.focus(), 0);
}

function shareExpiryLabel(timestamp){
    const value = Number(timestamp || 0);
    if(!value) return L('未知有效期','Unknown expiry');
    const date = new Date(value < 10000000000 ? value * 1000 : value);
    if(Number.isNaN(date.getTime())) return L('未知有效期','Unknown expiry');
    return `${L('有效期至','Expires')} ${date.toLocaleString(langIsEn() ? 'en-US' : 'zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'})}`;
}

function shareModeLabel(mode){
    return mode === 'internet' ? L('互联网临时分享','Temporary internet share') : L('局域网分享','LAN share');
}

function shareRoleLabel(role){
    return role === 'viewer' ? L('仅查看','View only') : L('可编辑','Can edit');
}

function shareScopeLabel(scope){
    return scope === 'project' ? L('当前项目','Current project') : L('此画布','This canvas');
}

function shareDialogStatus(text, tone=''){
    if(!shareDialogEl) return;
    const el = shareDialogEl.querySelector('[data-share-status]');
    if(!el) return;
    el.textContent = text || '';
    el.className = `ws-share-status${tone ? ` ${tone}` : ''}`;
}

async function copyShareUrl(input){
    const value = String(input?.value || '').trim();
    if(!value) return;
    let copied = false;
    try {
        if(navigator.clipboard?.writeText){
            await navigator.clipboard.writeText(value);
            copied = true;
        }
    } catch(_) {}
    if(!copied){
        input.focus(); input.select();
        try { copied = document.execCommand('copy'); } catch(_) {}
    }
    shareDialogStatus(copied ? L('链接已复制到剪贴板','Link copied to clipboard') : L('复制失败，请手动选中链接','Copy failed; select the link manually'), copied ? 'ok' : 'error');
}

function renderActiveCanvasShares(dialog, shares){
    const list = dialog.querySelector('[data-share-active-list]');
    if(!list) return;
    if(!Array.isArray(shares) || !shares.length){
        list.innerHTML = `<div class="ws-share-empty">${L('暂无正在使用的分享链接','No active share links')}</div>`;
        return;
    }
    list.innerHTML = shares.map(item => `
        <div class="ws-share-active-row" data-share-id="${escapeAttr(item.share_id || '')}">
            <div class="ws-share-active-main">
                <strong>${escapeHtml(shareModeLabel(item.mode))}</strong>
                <span>${escapeHtml(shareScopeLabel(item.scope))} · ${escapeHtml(shareRoleLabel(item.role))} · ${escapeHtml(shareExpiryLabel(item.expires_at))}</span>
            </div>
            <button type="button" class="ws-share-stop" data-stop-share="${escapeAttr(item.share_id || '')}">${L('停止','Stop')}</button>
        </div>`).join('');
    list.querySelectorAll('[data-stop-share]').forEach(button => {
        button.onclick = async () => {
            const shareId = button.dataset.stopShare || '';
            if(!shareId || !window.confirm(L('停止后，已发出的链接将立即失效。继续吗？','Stop this link? Anyone using it will lose access.'))) return;
            button.disabled = true;
            try {
                const res = await fetch(`/api/canvas-shares/${encodeURIComponent(shareId)}/revoke`, {method:'POST'});
                const data = await res.json().catch(() => ({}));
                if(!res.ok) throw new Error(data.detail || L('停止分享失败','Could not stop sharing'));
                shareDialogStatus(L('分享链接已停止','Share link stopped'), 'ok');
                await loadActiveCanvasShares(dialog, dialog.dataset.canvasId || '');
            } catch(error){
                button.disabled = false;
                shareDialogStatus(error.message || L('停止分享失败','Could not stop sharing'), 'error');
            }
        };
    });
}

async function loadActiveCanvasShares(dialog, canvasId){
    if(!dialog || !canvasId) return;
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/shares`, {cache:'no-store'});
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.detail || L('读取分享状态失败','Could not load share status'));
        renderActiveCanvasShares(dialog, data.shares || []);
    } catch(error){
        const list = dialog.querySelector('[data-share-active-list]');
        if(list) list.innerHTML = `<div class="ws-share-empty error">${escapeHtml(error.message || L('读取分享状态失败','Could not load share status'))}</div>`;
    }
}

async function createCanvasShareFromDialog(dialog, canvasId){
    const mode = dialog.querySelector('input[name="ws-share-mode"]:checked')?.value || 'lan';
    const role = dialog.querySelector('[data-share-role]')?.value || 'editor';
    const scope = dialog.querySelector('[data-share-scope]')?.value || 'canvas';
    const canvas = canvases.find(item => item.id === canvasId);
    const projectId = scope === 'project' ? String(canvas?.project || currentProjectId || 'default') : '';
    const allowAssets = dialog.querySelector('[data-share-assets]')?.checked !== false;
    const expiresMinutes = Number(dialog.querySelector('[data-share-expiry]')?.value || 1440);
    const submit = dialog.querySelector('[data-create-share]');
    if(submit) submit.disabled = true;
    shareDialogStatus(mode === 'internet' ? L('正在启动临时隧道…','Starting temporary tunnel…') : L('正在创建局域网链接…','Creating LAN link…'));
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/shares`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({mode, role, scope, project_id:projectId, allow_assets:allowAssets, expires_minutes:expiresMinutes})
        });
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.detail || L('创建分享链接失败','Could not create share link'));
        const share = data.share || {};
        const result = dialog.querySelector('[data-share-result]');
        const input = dialog.querySelector('[data-share-url]');
        const meta = dialog.querySelector('[data-share-result-meta]');
        if(input) input.value = share.url || '';
        if(meta) meta.textContent = `${shareModeLabel(share.mode)} · ${shareScopeLabel(share.scope)} · ${shareRoleLabel(share.role)} · ${shareExpiryLabel(share.expires_at)}`;
        if(result) result.hidden = false;
        shareDialogStatus(L('分享链接已创建；接收方可在桌面端“加入协同”打开，分享者软件保持运行即可协作。','Share link created. The recipient can open it with “Join shared canvas”; keep the host app running.'), 'ok');
        await loadActiveCanvasShares(dialog, canvasId);
    } catch(error){
        shareDialogStatus(error.message || L('创建分享链接失败','Could not create share link'), 'error');
    } finally {
        if(submit) submit.disabled = false;
    }
}

async function openShareDialog(canvasId){
    closeCardMenu();
    closeShareDialog();
    const canvas = canvases.find(item => item.id === canvasId);
    if(!canvas) return;
    const dialog = document.createElement('div');
    dialog.className = 'ws-share-backdrop';
    dialog.dataset.canvasId = canvasId;
    dialog.innerHTML = `
        <section class="ws-share-dialog" role="dialog" aria-modal="true" aria-labelledby="wsShareTitle">
            <header class="ws-share-head">
                <div><span class="ws-share-kicker">${L('画布协作','Canvas collaboration')}</span><h2 id="wsShareTitle">${L('分享画布','Share canvas')}</h2><p>${escapeHtml(canvas.title || L('未命名画布','Untitled canvas'))}</p></div>
                <button type="button" class="ws-share-close" data-close-share aria-label="${L('关闭','Close')}"><i data-lucide="x"></i></button>
            </header>
            <div class="ws-share-host-note"><i data-lucide="server"></i><span>${L('服务器在分享者电脑上；电脑和小美画布保持运行即可。','The host computer keeps the canvas server running.')}</span></div>
            <div class="ws-share-mode-grid" role="radiogroup" aria-label="${L('分享方式','Share mode')}">
                <label class="ws-share-mode-card active"><input type="radio" name="ws-share-mode" value="lan" checked><span class="ws-share-mode-icon"><i data-lucide="wifi"></i></span><span><strong>${L('局域网分享','LAN share')}</strong><small>${L('同一 Wi‑Fi / 局域网；无需外部服务。','Same Wi‑Fi / LAN; no external service.')}</small></span></label>
                <label class="ws-share-mode-card"><input type="radio" name="ws-share-mode" value="internet"><span class="ws-share-mode-icon"><i data-lucide="globe-2"></i></span><span><strong>${L('互联网临时分享','Temporary internet share')}</strong><small>${L('自动使用 Cloudflare 临时隧道；链接可随时停止。','Uses a temporary Cloudflare tunnel; stop anytime.')}</small></span></label>
            </div>
            <div class="ws-share-field-grid">
                <label><span>${L('协作权限','Permission')}</span><select data-share-role><option value="editor">${L('可编辑画布','Can edit canvas')}</option><option value="viewer">${L('仅查看','View only')}</option></select></label>
                <label><span>${L('分享范围','Share scope')}</span><select data-share-scope><option value="canvas">${L('此画布','This canvas')}</option><option value="project">${L('当前项目内的画布','Canvases in current project')}</option></select></label>
                <label><span>${L('有效期','Expires')}</span><select data-share-expiry><option value="30">${L('30 分钟','30 minutes')}</option><option value="120">${L('2 小时','2 hours')}</option><option value="1440" selected>${L('24 小时','24 hours')}</option><option value="10080">${L('7 天','7 days')}</option></select></label>
            </div>
            <label class="ws-share-assets"><input type="checkbox" data-share-assets checked><span>${L('允许引用画布素材','Allow referenced canvas assets')}</span><small>${L('关闭后，访客仍可协作节点，但不能读取图片、视频或音频。','When off, guests can edit nodes but cannot read image, video, or audio assets.')}</small></label>
            <p class="ws-share-hint">${L('首次使用互联网分享时会从 Cloudflare 官方发布地址准备 cloudflared；下载或启动失败会明确提示，不会改动现有画布。','The first internet share prepares cloudflared from Cloudflare’s official release. Download or startup errors are shown without changing the canvas.')}</p>
            <div class="ws-share-status" data-share-status aria-live="polite"></div>
            <div class="ws-share-result" data-share-result hidden><div class="ws-share-result-meta" data-share-result-meta></div><div class="ws-share-url-row"><input data-share-url type="text" readonly spellcheck="false"><button type="button" data-copy-share>${L('复制链接','Copy link')}</button></div></div>
            <section class="ws-share-active"><div class="ws-share-section-title">${L('正在使用的链接','Active links')}</div><div data-share-active-list><div class="ws-share-empty">${L('正在读取…','Loading…')}</div></div></section>
            <footer class="ws-share-foot"><button type="button" class="ws-share-cancel" data-close-share>${L('关闭','Close')}</button><button type="button" class="ws-share-create" data-create-share>${L('创建分享链接','Create share link')}</button></footer>
        </section>`;
    document.body.appendChild(dialog);
    shareDialogEl = dialog;
    dialog.querySelectorAll('[data-close-share]').forEach(button => button.onclick = closeShareDialog);
    dialog.addEventListener('mousedown', event => { if(event.target === dialog) closeShareDialog(); });
    dialog.querySelectorAll('input[name="ws-share-mode"]').forEach(input => input.onchange = () => {
        dialog.querySelectorAll('.ws-share-mode-card').forEach(card => card.classList.toggle('active', card.querySelector('input')?.checked));
    });
    dialog.querySelector('[data-create-share]').onclick = () => createCanvasShareFromDialog(dialog, canvasId);
    dialog.querySelector('[data-copy-share]').onclick = () => copyShareUrl(dialog.querySelector('[data-share-url]'));
    refreshIcons();
    await loadActiveCanvasShares(dialog, canvasId);
}

function showCardDeleteConfirm(canvasId){
    const card = boardWorld.querySelector(`.ws-card[data-canvas-id="${CSS.escape(canvasId)}"]`);
    if(!card) return;
    boardWorld.querySelectorAll('.ws-card.confirming-delete').forEach(el => {
        if(el !== card) el.classList.remove('confirming-delete');
    });
    card.classList.add('confirming-delete');
}

/* ===== Export canvas (download the full canvas JSON) ===== */
async function exportCanvas(id){
    const c = canvases.find(x => x.id === id);
    setStatus(L('正在导出...','Exporting...'));
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}`);
        if(!res.ok) throw new Error('export failed');
        const data = await res.json();
        const cv = data.canvas || data;
        const base = String((c?.title) || cv.title || 'canvas').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'canvas';
        const blob = new Blob([JSON.stringify(cv, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = base + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        setStatus(L('已导出','Exported'));
    } catch(e){ console.error(e); setStatus(L('导出失败','Export failed')); }
}

/* ===== Export canvas with referenced resources ===== */
const ZIP_ENCODER = new TextEncoder();
let ZIP_CRC_TABLE = null;

function safeExportBase(name, fallback = 'canvas'){
    return String(name || fallback).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || fallback;
}

function collectCanvasResourceUrls(value, out = [], seen = new Set()){
    if(value == null) return out;
    if(typeof value === 'string'){
        const text = value.trim();
        if(isCanvasResourceUrl(text) && !seen.has(text)){
            seen.add(text);
            out.push(text);
        }
        return out;
    }
    if(Array.isArray(value)){
        value.forEach(item => collectCanvasResourceUrls(item, out, seen));
        return out;
    }
    if(typeof value === 'object'){
        Object.values(value).forEach(item => collectCanvasResourceUrls(item, out, seen));
    }
    return out;
}

function isCanvasResourceUrl(url){
    return url.startsWith('/assets/') || url.startsWith('/output/') || /^https?:\/\//i.test(url);
}

function exportResourceName(url, index, used){
    let name = '';
    try {
        const parsed = new URL(url, location.origin);
        name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    } catch(e) {
        name = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
    }
    name = safeExportBase(name || `resource-${String(index + 1).padStart(3, '0')}`, `resource-${index + 1}`);
    if(!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.bin';
    let finalName = `resources/${name}`;
    const dot = finalName.lastIndexOf('.');
    const stem = dot > 0 ? finalName.slice(0, dot) : finalName;
    const ext = dot > 0 ? finalName.slice(dot) : '';
    let suffix = 2;
    while(used.has(finalName)){
        finalName = `${stem}-${suffix}${ext}`;
        suffix++;
    }
    used.add(finalName);
    return finalName;
}

async function fetchResourceBytes(url){
    const res = await fetch(url);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

function zipCrc32(bytes){
    if(!ZIP_CRC_TABLE){
        ZIP_CRC_TABLE = new Uint32Array(256);
        for(let i = 0; i < 256; i++){
            let c = i;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            ZIP_CRC_TABLE[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for(let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function zipDosTime(date = new Date()){
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const year = Math.max(1980, date.getFullYear());
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

function zipHeader(signature, size){
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, signature, true);
    return { bytes, view };
}

function createZipBlob(entries){
    const now = zipDosTime();
    const files = [];
    const central = [];
    let offset = 0;
    entries.forEach(entry => {
        const nameBytes = ZIP_ENCODER.encode(entry.name);
        const data = entry.bytes instanceof Uint8Array ? entry.bytes : ZIP_ENCODER.encode(String(entry.bytes || ''));
        const crc = zipCrc32(data);
        const local = zipHeader(0x04034b50, 30 + nameBytes.length);
        local.view.setUint16(4, 20, true);
        local.view.setUint16(6, 0x0800, true);
        local.view.setUint16(8, 0, true);
        local.view.setUint16(10, now.time, true);
        local.view.setUint16(12, now.day, true);
        local.view.setUint32(14, crc, true);
        local.view.setUint32(18, data.length, true);
        local.view.setUint32(22, data.length, true);
        local.view.setUint16(26, nameBytes.length, true);
        local.bytes.set(nameBytes, 30);
        files.push(local.bytes, data);

        const cd = zipHeader(0x02014b50, 46 + nameBytes.length);
        cd.view.setUint16(4, 20, true);
        cd.view.setUint16(6, 20, true);
        cd.view.setUint16(8, 0x0800, true);
        cd.view.setUint16(10, 0, true);
        cd.view.setUint16(12, now.time, true);
        cd.view.setUint16(14, now.day, true);
        cd.view.setUint32(16, crc, true);
        cd.view.setUint32(20, data.length, true);
        cd.view.setUint32(24, data.length, true);
        cd.view.setUint16(28, nameBytes.length, true);
        cd.view.setUint32(42, offset, true);
        cd.bytes.set(nameBytes, 46);
        central.push(cd.bytes);
        offset += local.bytes.length + data.length;
    });
    const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);
    const end = zipHeader(0x06054b50, 22);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, centralSize, true);
    end.view.setUint32(16, offset, true);
    return new Blob([...files, ...central, end.bytes], { type:'application/zip' });
}

async function exportCanvasWithResources(id){
    const c = canvases.find(x => x.id === id);
    setStatus(L('正在收集资源...','Collecting assets...'));
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}`);
        if(!res.ok) throw new Error('export failed');
        const data = await res.json();
        const cv = data.canvas || data;
        const base = safeExportBase((c?.title) || cv.title || 'canvas');
        const urls = collectCanvasResourceUrls(cv).slice(0, 1000);
        const usedNames = new Set(['canvas.json', 'resources-manifest.json']);
        const entries = [{ name:'canvas.json', bytes:ZIP_ENCODER.encode(JSON.stringify(cv, null, 2)) }];
        const manifest = [];
        let skipped = 0;
        for(let i = 0; i < urls.length; i++){
            const url = urls[i];
            try {
                const bytes = await fetchResourceBytes(url);
                const name = exportResourceName(url, i, usedNames);
                entries.push({ name, bytes });
                manifest.push({ url, file:name, size:bytes.length });
            } catch(e) {
                skipped++;
                manifest.push({ url, skipped:true, reason:String(e?.message || e || 'fetch failed').slice(0, 120) });
            }
        }
        entries.push({ name:'resources-manifest.json', bytes:ZIP_ENCODER.encode(JSON.stringify({ canvas_id:id, resources:manifest }, null, 2)) });
        const blob = createZipBlob(entries);
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${base}.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1500);
        const included = Math.max(0, entries.length - 2);
        setStatus(skipped
            ? L(`已导出，跳过 ${skipped} 个资源`, `Exported, skipped ${skipped} assets`)
            : L(`已导出 ${included} 个资源`, `Exported ${included} assets`));
    } catch(e){ console.error(e); setStatus(L('导出失败','Export failed')); }
}

/* ===== Cut / paste a canvas across projects ===== */
function cutCanvas(id){
    clipboardCanvasId = id;
    setStatus(L('已剪切，切换到目标项目后点“粘贴到此项目”','Cut — open another project, then Paste'));
    renderBoard();
}
function updatePasteBtn(){
    if(!pasteCanvasBtn) return;
    const show = !!clipboardCanvasId && canvases.some(x => x.id === clipboardCanvasId);
    pasteCanvasBtn.style.display = show ? 'inline-flex' : 'none';
}
async function pasteCanvas(){
    if(!clipboardCanvasId) return;
    const c = canvases.find(x => x.id === clipboardCanvasId);
    const targetPid = currentProjectId;
    clipboardCanvasId = null;
    if(!c){ updatePasteBtn(); renderBoard(); return; }
    if((c.project || 'default') === targetPid){ renderBoard(); setStatus(L('已在当前项目','Already in this project')); return; }
    await moveCanvasToProject(c.id, targetPid);
}

function startCardRename(canvasId){
    const card = boardWorld.querySelector(`.ws-card[data-canvas-id="${CSS.escape(canvasId)}"]`);
    const c = canvases.find(x => x.id === canvasId);
    if(!card || !c) return;
    const titleEl = card.querySelector('.ws-card-title');
    if(!titleEl || titleEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 80; input.value = c.title || '';
    input.className = 'ws-card-title-input';
    titleEl.innerHTML = ''; titleEl.appendChild(input);
    input.onmousedown = e => e.stopPropagation();
    input.onclick = e => e.stopPropagation();
    input.focus(); input.select();
    let done = false;
    const finish = commit => {
        if(done) return; done = true;
        const v = input.value.trim();
        if(commit && v && v !== c.title) setCanvasTitle(canvasId, v);
        else renderBoard();
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => {
        e.stopPropagation();
        if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
        if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    };
}

async function setCanvasTitle(id, title){
    const c = canvases.find(x => x.id === id);
    if(c) c.title = title;
    renderBoard();
    await persistMeta(id, { title });
}

async function moveCanvasToProject(id, projectId){
    const c = canvases.find(x => x.id === id);
    if(c) c.project = projectId;
    renderBoard();
    renderProjects();
    setStatus(L('已移动','Moved'));
    await persistMeta(id, { project: projectId });
}

/* ===== Card meta persist (POST /meta) ===== */
async function persistMeta(id, patch){
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}/meta`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        if(!res.ok) throw new Error('meta save failed');
        const data = await res.json();
        if(data.canvas){
            const idx = canvases.findIndex(x => x.id === id);
            if(idx >= 0) canvases[idx] = { ...canvases[idx], ...data.canvas };
        }
    } catch(e){ console.error(e); setStatus(L('保存失败','Save failed')); }
}

/* ===== Delete canvas (soft -> trash, with confirm) ===== */
async function deleteCanvas(id){
    const c = canvases.find(x => x.id === id);
    if(!c) return;
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if(!res.ok) throw new Error('delete failed');
        canvases = canvases.filter(x => x.id !== id);
        renderBoard();
        renderProjects();
        refreshTrashCount();
        setStatus(L('已移入回收站','Moved to trash'));
    } catch(e){ console.error(e); setStatus(L('删除失败','Delete failed')); }
}

/* ===== Trash / recycle bin ===== */
function updateTrashBadge(){
    const n = deletedCanvases.length + deletedProjects.length;
    trashBadge.textContent = String(n);
    trashBadge.classList.toggle('visible', n > 0);
}
async function refreshTrashCount(){
    try {
        const [canvasRes, projectRes] = await Promise.all([
            fetch('/api/canvases/trash', { cache:'no-store' }),
            fetch('/api/projects/trash', { cache:'no-store' }),
        ]);
        if(!canvasRes.ok || !projectRes.ok) return;
        const [canvasData, projectData] = await Promise.all([canvasRes.json(), projectRes.json()]);
        deletedCanvases = canvasData.canvases || [];
        deletedProjects = projectData.projects || [];
        updateTrashBadge();
    } catch(e){}
}
async function openTrashView(){
    trashEntryBtn.classList.add('active');
    trashPanel.classList.add('active');
    closeCardMenu(); closeCreateCard();
    await loadTrash();
}
function closeTrashView(){
    trashEntryBtn.classList.remove('active');
    trashPanel.classList.remove('active');
}
async function loadTrash(){
    try {
        const [canvasRes, projectRes] = await Promise.all([
            fetch('/api/canvases/trash', { cache:'no-store' }),
            fetch('/api/projects/trash', { cache:'no-store' }),
        ]);
        if(!canvasRes.ok || !projectRes.ok) throw new Error('trash load failed');
        const [canvasData, projectData] = await Promise.all([canvasRes.json(), projectRes.json()]);
        deletedCanvases = canvasData.canvases || [];
        deletedProjects = projectData.projects || [];
        renderTrash();
        updateTrashBadge();
    } catch(e){ console.error(e); setStatus(L('加载回收站失败','Load trash failed')); }
}
function renderTrash(){
    trashListEl.innerHTML = '';
    const items = [
        ...deletedProjects.map(project => ({ ...project, _trashType:'project' })),
        ...deletedCanvases.map(canvas => ({ ...canvas, _trashType:'canvas' })),
    ].sort((a, b) => Number(b.deleted_at || 0) - Number(a.deleted_at || 0));
    if(!items.length){
        const empty = document.createElement('div');
        empty.className = 'ws-trash-empty';
        empty.textContent = L('回收站为空','Trash is empty');
        trashListEl.appendChild(empty);
        return;
    }
    items.forEach(item => {
        const isProject = item._trashType === 'project';
        const isSmart = !isProject && (item.kind || 'classic') === 'smart';
        const owner = projects.find(p => p.id === (item.project || 'default'))
            || deletedProjects.find(p => p.id === (item.project || ''));
        const projName = owner?.name || L('默认项目','Default');
        const kindClass = isProject ? 'project' : (isSmart ? 'smart' : 'classic');
        const kindLabel = isProject ? L('项目','Project') : (isSmart ? L('智能','Smart') : L('普通','Classic'));
        const title = isProject ? item.name : item.title;
        const metaLabel = isProject
            ? `${Number(item.canvas_count || 0)} ${L('个画布','canvases')}`
            : projName;
        const card = document.createElement('div');
        card.className = 'ws-trash-card';
        card.dataset[isProject ? 'projectId' : 'canvasId'] = item.id;
        card.innerHTML = `
            <div class="ws-card-top">
                <span class="ws-card-icon">${isProject ? '<i data-lucide="folder" style="width:17px;height:17px"></i>' : renderCanvasIcon(isSmart && /[^\x00-\x7F]/.test(item.icon || '') ? 'sparkles' : item.icon, 17)}</span>
                <span class="ws-card-kind ${kindClass}">${kindLabel}</span>
            </div>
            <div class="ws-card-title">${escapeHtml(title)}</div>
            <div class="ws-card-meta"><span class="ws-card-nodes">${escapeHtml(metaLabel)}</span><span class="ws-card-meta-dot"></span><span class="ws-card-time">${formatCanvasTime(item.deleted_at)}</span></div>
            <div class="ws-card-actions">
                <button class="ws-trash-act restore" type="button"><i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i><span>${L('恢复','Restore')}</span></button>
                <button class="ws-trash-act purge" type="button"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i><span>${L('彻底删除','Delete')}</span></button>
            </div>
            <div class="ws-trash-confirm">
                <div class="ws-trash-confirm-title">${isProject ? L('彻底删除项目？其中画布将移回默认项目','Delete project permanently? Its canvases will move to Default.') : L('彻底删除？不可恢复','Delete permanently?')}</div>
                <div class="ws-trash-confirm-actions">
                    <button class="ws-trash-confirm-yes" type="button">${L('删除','Delete')}</button>
                    <button class="ws-trash-confirm-no" type="button">${L('取消','Cancel')}</button>
                </div>
            </div>`;
        card.querySelector('.ws-trash-act.restore').onclick = () => isProject ? restoreProject(item.id) : restoreCanvas(item.id);
        card.querySelector('.ws-trash-act.purge').onclick = () => card.classList.add('confirming');
        card.querySelector('.ws-trash-confirm-yes').onclick = () => isProject ? purgeProject(item.id) : purgeCanvas(item.id);
        card.querySelector('.ws-trash-confirm-no').onclick = () => card.classList.remove('confirming');
        trashListEl.appendChild(card);
    });
    refreshIcons();
}
async function restoreCanvas(id){
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}/restore`, { method: 'POST' });
        if(!res.ok) throw new Error('restore failed');
        deletedCanvases = deletedCanvases.filter(c => c.id !== id);
        await loadAll();           // restored canvas returns to its stored project
        renderTrash();
        updateTrashBadge();
        setStatus(L('已恢复','Restored'));
    } catch(e){ console.error(e); setStatus(L('恢复失败','Restore failed')); }
}
async function purgeCanvas(id){
    try {
        const res = await fetch(`/api/canvases/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
        if(!res.ok) throw new Error('purge failed');
        deletedCanvases = deletedCanvases.filter(c => c.id !== id);
        renderTrash();
        updateTrashBadge();
        setStatus(L('已彻底删除','Deleted'));
    } catch(e){ console.error(e); setStatus(L('删除失败','Delete failed')); }
}
async function restoreProject(id){
    try {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}/restore`, { method:'POST' });
        if(!res.ok) throw new Error('restore project failed');
        deletedProjects = deletedProjects.filter(p => p.id !== id);
        await loadAll();
        renderTrash();
        updateTrashBadge();
        setStatus(L('项目已恢复','Project restored'));
    } catch(e){ console.error(e); setStatus(L('项目恢复失败','Project restore failed')); }
}
async function purgeProject(id){
    try {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}/purge`, { method:'DELETE' });
        if(!res.ok) throw new Error('purge project failed');
        deletedProjects = deletedProjects.filter(p => p.id !== id);
        await loadAll();
        renderTrash();
        updateTrashBadge();
        setStatus(L('项目已彻底删除，画布已移回默认项目','Project deleted; canvases moved to Default'));
    } catch(e){ console.error(e); setStatus(L('项目删除失败','Project deletion failed')); }
}

/* ===== Event bindings ===== */
board.addEventListener('mousedown', onBoardPanStart);
document.addEventListener('mousemove', onBoardPanMove);
document.addEventListener('mouseup', onBoardPanEnd);
board.addEventListener('wheel', onBoardWheel, { passive: false });
board.addEventListener('dblclick', e => {
    if(e.target.closest('.ws-card') || e.target.closest('.ws-create-card')) return;
    openCreateCard(screenToWorld(e.clientX, e.clientY));
});

newCanvasBtn.addEventListener('click', () => openCreateCard(boardCenterWorld()));
emptyCreateCanvasBtn?.addEventListener('mousedown', e => e.stopPropagation());
emptyCreateCanvasBtn?.addEventListener('click', e => {
    e.stopPropagation();
    openCreateCard(boardCenterWorld());
});
boardRefreshBtn.addEventListener('click', loadAll);
boardResetViewBtn.addEventListener('click', resetView);
toolbarShareCanvasBtn?.addEventListener('click', openToolbarShareDialog);
joinCanvasBtn?.addEventListener('click', openJoinCanvasDialog);
pasteCanvasBtn?.addEventListener('click', pasteCanvas);

newProjectBtn.addEventListener('click', openNewProject);
newProjectConfirm.addEventListener('click', createProject);
newProjectCancel.addEventListener('click', closeNewProject);
newProjectInput.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); createProject(); }
    if(e.key === 'Escape'){ e.preventDefault(); closeNewProject(); }
});


trashEntryBtn.addEventListener('click', () => {
    if(trashPanel.classList.contains('active')) closeTrashView();
    else openTrashView();
});
trashCloseBtn.addEventListener('click', closeTrashView);

// close card menu when clicking outside
document.addEventListener('mousedown', e => {
    if(document.querySelector('.ws-card-pop') && !e.target.closest('.ws-card-pop') && !e.target.closest('.ws-card-menu')){
        closeCardMenu();
    }
    if(document.querySelector('.ws-card.confirming-delete') && !e.target.closest('.ws-card.confirming-delete')){
        boardWorld.querySelectorAll('.ws-card.confirming-delete').forEach(el => el.classList.remove('confirming-delete'));
    }
});

document.addEventListener('keydown', e => {
    if(e.key !== 'Escape') return;
    closeCardMenu();
    closeShareDialog();
    closeJoinCanvasDialog();
    closeCreateCard();
    boardWorld.querySelectorAll('.ws-card.confirming-delete').forEach(el => el.classList.remove('confirming-delete'));
    if(trashPanel.classList.contains('active')) closeTrashView();
});

// language switch from parent (index.html) via postMessage
// canvas-focus: parent switches to canvas tab => reload data to stay fresh
window.addEventListener('message', event => {
    if(event.origin && event.origin !== location.origin) return;
    if(event.data?.type === 'soft-furnishing-inbox'){
        openSoftFurnishingInbox();
        return;
    }
    if(event.data?.type === 'comfy-workflow-inbox'){
        openComfyWorkflowInbox();
        return;
    }
    if(event.data?.type === 'canvas-focus'){
        loadAll();
        return;
    }
    if(event.data?.type === 'studio-lang'){
        if(event.data.lang && window.StudioI18n) StudioI18n.set(event.data.lang);
        window.StudioI18n?.apply?.();
        renderProjects();
        renderBoard();
        if(trashPanel.classList.contains('active')) renderTrash();
        refreshIcons();
    }
});

/* ===== Boot ===== */
window.StudioI18n?.apply?.();
applyViewport();
loadAll();
window.setTimeout(() => { openSoftFurnishingInbox(); }, 80);
window.setTimeout(() => { openComfyWorkflowInbox(); }, 100);
refreshIcons();
