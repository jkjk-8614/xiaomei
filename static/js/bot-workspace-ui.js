/* 小美 Bot 工作区统一右侧界面（挂载于原有 #canvasAgentPanel，不新建第二工作台页）。
 *
 * 兼容性原则：
 * - 仅在服务端 /api/bot-workspace/config 明确返回 feature_flags.enabled === true
 *   且用户未选择经典模式时激活；
 * - 共享画布（shared=1）自动禁用，保持原有权限隔离；
 * - 保留「切换经典 Agent」一键回退按钮，随时无损恢复原有 canvas-agent.js + canvas-multi-agent.js。
 */
(function (root) {
    'use strict';

    if (new URLSearchParams(location.search).get('shared') === '1') return;

    const api = root.BotWorkspaceClient;
    const panel = document.getElementById('canvasAgentPanel');
    if (!api || !panel) return;

    const TURN_LABELS = {
        queued: '排队中',
        running: '处理中',
        waiting_delegation: '等待专业 Bot 返回',
        waiting_approval: '等待用户确认',
        waiting_canvas_connection: '等待打开当前画布',
        waiting_result: '等待画布执行结果',
        completed: '已完成',
        failed: '未完成',
        cancelled: '已停止',
        recovery_required: '重启待恢复',
    };

    const TOOL_LABELS = {
        'bot.list': '查看 Bot 列表',
        'bot.create': '创建永久 Bot（仅总管理）',
        'bot.read': '读取 Bot 档案',
        'bot.update': '修改 Bot 配置（仅总管理）',
        'bot.archive': '归档 Bot（仅总管理）',
        'bot.restore': '恢复 Bot（仅总管理）',
        'bot.delegate': '委派任务给其他 Bot',
        'bot.get_result': '读取委派结果',
        'bot.cancel_task': '停止子任务',
        'memory.read': '读取记忆',
        'memory.remember': '写入长期记忆',
        'memory.forget': '遗忘记忆',
        'memory.recall': '检索记忆',
        'canvas.read': '读取当前画布',
        'canvas.list_assets': '读取当前项目素材',
        'canvas.dispatch_run': '发起画布受控多代理执行',
        'canvas.command': '操作画布节点与连线',
        'canvas.use_project_asset': '引用项目素材到画布',
        'canvas.query_generation': '查询生图结果',
        'canvas.inspect_result': '查看生成结果图',
        'canvas.check_product': '检查商品一致性',
        'canvas.check_geometry': '检查几何比例',
        'design.profile.read': '读取审美档案',
        'design.references.search': '检索参考库',
        'design.references.analyze': '分析参考图',
        'design.plan.compose': '电商分批方案规划',
        'design.review.check': '视觉质量检查',
        'design.batch.canvas_plan': '批量方案落画布',
    };

    const state = {
        serverEnabled: false,
        active: false,
        config: null,
        bots: [],
        showArchivedBots: false,
        activeBotId: '',
        sessions: [],
        activeSessionId: '',
        messages: [],
        turns: [],
        approvals: [],
        runLinks: [],
        runSnapshots: [],
        delegations: [],
        memories: [],
        drawerOpen: false,
        drawerMode: 'settings', // 'settings' | 'create'
        drawerTab: 'profile', // 'profile' | 'skills' | 'memory' | 'permissions'
        sidebarCollapsed: false,
        sending: false,
        connection: 'idle',
        clientId: api.makeId('bwclient'),
        presenceTimer: 0,
        stream: null,
        composing: false,
        attachedImages: [],
        executingActionIds: new Set(),
        notice: '',
    };

    function esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function currentScope() {
        const bridge = root.CanvasMultiAgentBridge;
        if (bridge?.current) {
            const cur = bridge.current();
            return { project_id: String(cur.project_id || ''), canvas_id: String(cur.canvas_id || '') };
        }
        if (typeof canvas !== 'undefined' && canvas?.id) {
            return { project_id: String(canvas.project || 'default'), canvas_id: String(canvas.id || '') };
        }
        return { project_id: '', canvas_id: '' };
    }

    function getUiMode() {
        try {
            return localStorage.getItem(api.UI_MODE_KEY) || 'workspace';
        } catch (_) {
            return 'workspace';
        }
    }

    function setUiMode(mode) {
        try {
            localStorage.setItem(api.UI_MODE_KEY, mode);
        } catch (_) { /* ignore */ }
    }

    function applySavedWidth() {
        try {
            const saved = Number(localStorage.getItem(api.WIDTH_KEY) || 560);
            if (Number.isFinite(saved) && saved >= 360 && saved <= 960) {
                panel.style.setProperty('--bot-workspace-width', `${Math.round(saved)}px`);
            }
        } catch (_) { /* ignore */ }
    }

    function saveWidth(width) {
        const clamped = Math.max(360, Math.min(Math.min(920, window.innerWidth - 32), Math.round(width)));
        panel.style.setProperty('--bot-workspace-width', `${clamped}px`);
        try { localStorage.setItem(api.WIDTH_KEY, String(clamped)); } catch (_) { /* ignore */ }
    }

    function renderAvatar(bot) {
        const av = bot?.avatar || {};
        const color = /^#[0-9a-f]{6}$/i.test(av.color || '') ? av.color : '#2F6F5E';
        const busy = Number(bot?.active_turn_count || 0) > 0;
        const dotState = bot?.status === 'archived' ? 'archived' : busy ? 'busy' : 'idle';
        if (av.image && /^data:image\/(png|jpeg|webp);base64,/.test(av.image)) {
            return `<span class="bw-avatar" style="--bw-avatar-bg:${esc(color)}"><img src="${esc(av.image)}" alt=""><i class="bw-status-dot" data-state="${dotState}"></i></span>`;
        }
        const chars = root.DesignBrainCharacters;
        const shapeKey = chars && Object.hasOwn(chars, av.shape || '') ? av.shape : (bot?.is_manager ? 'star' : 'bunny');
        if (chars && chars[shapeKey]) {
            const c = chars[shapeKey];
            const maskId = `bwm_${esc(bot?.bot_id || 'x')}_${Math.random().toString(36).slice(2, 7)}`;
            const eyes = (c.eyes || []).map(([x, y, w, h, tilt]) => `<g transform="translate(${x} ${y}) rotate(${tilt})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('');
            const paints = (c.paints || []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" opacity="${opacity}"/>`).join('');
            return `<span class="bw-avatar" style="--bw-avatar-bg:transparent"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${eyes}</mask></defs><g mask="url(#${maskId})" fill-rule="evenodd"><path d="${c.body}" fill="${esc(color)}"/>${paints}<path d="${c.shade}" fill="#000" opacity=".14"/><path d="${c.light}" fill="#fff" opacity=".16"/></g></svg><i class="bw-status-dot" data-state="${dotState}"></i></span>`;
        }
        return `<span class="bw-avatar" style="--bw-avatar-bg:${esc(color)}">${esc((av.text || bot?.name || '小').slice(0, 1))}<i class="bw-status-dot" data-state="${dotState}"></i></span>`;
    }

    function activeBot() {
        return state.bots.find((b) => b.bot_id === state.activeBotId) || state.bots.find((b) => b.is_manager) || state.bots[0] || null;
    }

    function activeSession() {
        return state.sessions.find((s) => s.session_id === state.activeSessionId) || state.sessions[0] || null;
    }

    // ---- 创建 DOM 骨架 ----
    const shell = document.createElement('div');
    shell.id = 'botWorkspaceShell';
    shell.className = 'bot-workspace-shell';
    shell.setAttribute('aria-label', '小美 Bot 工作区');
    shell.innerHTML = `
        <div id="botWorkspaceResizer" class="bw-resizer" role="separator" aria-orientation="vertical" aria-label="拖动调整 Bot 工作区宽度" tabindex="0"></div>
        <aside id="botWorkspaceSidebar" class="bw-sidebar" aria-label="Bot 列表">
            <div class="bw-sidebar-head">
                <strong>Bot 团队</strong>
                <button id="bwNewBotBtn" type="button" class="bw-icon-btn" title="新建永久 Bot" aria-label="新建永久 Bot">+</button>
            </div>
            <div id="bwBotList" class="bw-bot-list" role="listbox" aria-label="永久 Bot 列表"></div>
            <div class="bw-sidebar-foot">
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted,#616161);cursor:pointer;">
                    <input id="bwShowArchived" type="checkbox">显示已归档 Bot
                </label>
            </div>
        </aside>
        <div id="botWorkspaceMain" class="bw-main">
            <header class="bw-topbar">
                <div class="bw-topbar-left">
                    <button id="bwSidebarToggle" type="button" class="bw-icon-btn" title="折叠/展开 Bot 列表" aria-label="折叠或展开 Bot 列表" aria-expanded="true">☰</button>
                    <div class="bw-topbar-title">
                        <strong id="bwCurrentBotName">小美总管理</strong>
                        <small id="bwCurrentBotStatus">在线 · 准备就绪</small>
                    </div>
                </div>
                <div class="bw-topbar-actions">
                    <button id="bwSettingsBtn" type="button" class="bw-icon-btn" title="Bot 设置 / 模型 / Skills / 记忆" aria-label="Bot 设置">⚙</button>
                    <button id="bwClassicBtn" type="button" class="bw-icon-btn" title="切换到经典画布 Agent" aria-label="切换到经典画布 Agent">↩</button>
                    <button id="bwCollapsePanelBtn" type="button" class="bw-icon-btn" title="收起工作区" aria-label="收起工作区">×</button>
                </div>
            </header>
            <div class="bw-session-bar">
                <select id="bwSessionSelect" class="bw-select" aria-label="切换当前 Bot 的会话"></select>
                <button id="bwNewSessionBtn" type="button" class="bw-btn" title="为当前 Bot 新建独立会话">+ 新会话</button>
            </div>
            <div id="bwBannerStack" class="bw-banner-stack" aria-live="polite"></div>
            <div id="bwMessages" class="bw-messages" role="log" aria-live="polite"></div>
            <div class="bw-composer">
                <div class="bw-composer-status">
                    <span id="bwNoticeText" role="status"></span>
                    <span id="bwConnState"></span>
                </div>
                <div id="bwComposerAttachments" class="bw-attachments" hidden></div>
                <textarea id="bwInput" class="bw-textarea" rows="2" placeholder="向当前 Bot 发消息…（如让总管理创建专业 Bot 或协作操作画布）"></textarea>
                <div class="bw-composer-foot">
                    <div class="bw-composer-left">
                        <button id="bwAttachCanvasBtn" type="button" class="bw-btn" title="引用当前画布选中节点图片">引用画布图</button>
                        <button id="bwModelPill" type="button" class="bw-model-pill" title="点击修改当前 Bot 独立模型">默认动态模型</button>
                    </div>
                    <div class="bw-composer-right">
                        <button id="bwStopBtn" type="button" class="bw-btn bw-btn-danger" hidden>停止</button>
                        <button id="bwSendBtn" type="button" class="bw-btn bw-btn-primary">发送</button>
                    </div>
                </div>
            </div>
            <section id="bwDrawer" class="bw-drawer" hidden aria-label="Bot 配置与记忆">
                <header class="bw-drawer-head">
                    <strong id="bwDrawerTitle">Bot 设置</strong>
                    <button id="bwDrawerClose" type="button" class="bw-icon-btn" aria-label="关闭设置">×</button>
                </header>
                <nav id="bwDrawerTabs" class="bw-drawer-tabs" role="tablist">
                    <button type="button" class="bw-tab is-active" data-bw-tab="profile">档案与模型</button>
                    <button type="button" class="bw-tab" data-bw-tab="skills">Skills</button>
                    <button type="button" class="bw-tab" data-bw-tab="memory">长期记忆</button>
                    <button type="button" class="bw-tab" data-bw-tab="permissions">权限与任务</button>
                </nav>
                <div id="bwDrawerBody" class="bw-drawer-body"></div>
            </section>
        </div>
    `;
    panel.appendChild(shell);

    // 经典模式顶栏增加一个回切新版 Bot 工作区的轻量按钮（只在服务端启用开关时显示）
    const classicSwitchBtn = document.createElement('button');
    classicSwitchBtn.type = 'button';
    classicSwitchBtn.id = 'canvasAgentSwitchBotWorkspace';
    classicSwitchBtn.className = 'bw-switch-new-btn';
    classicSwitchBtn.textContent = 'Bot工作区';
    classicSwitchBtn.title = '切换到新版 Bot 工作区';
    classicSwitchBtn.hidden = true;
    classicSwitchBtn.addEventListener('click', () => {
        setUiMode('workspace');
        activateWorkspace();
    });
    panel.querySelector(':scope > header nav')?.prepend(classicSwitchBtn);

    const el = (id) => shell.querySelector(`#${id}`);

    // ---- 拖拽改宽与折叠 ----
    (function setupResizeAndCollapse() {
        const resizer = el('botWorkspaceResizer');
        let dragging = false;
        let startX = 0;
        let startW = 560;

        resizer.addEventListener('pointerdown', (event) => {
            dragging = true;
            startX = event.clientX;
            startW = panel.getBoundingClientRect().width;
            resizer.classList.add('is-dragging');
            resizer.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        resizer.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const delta = startX - event.clientX;
            saveWidth(startW + delta);
        });
        const stopDrag = () => {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('is-dragging');
        };
        resizer.addEventListener('pointerup', stopDrag);
        resizer.addEventListener('pointercancel', stopDrag);
        resizer.addEventListener('keydown', (event) => {
            const current = panel.getBoundingClientRect().width;
            if (event.key === 'ArrowLeft') { saveWidth(current + 24); event.preventDefault(); }
            if (event.key === 'ArrowRight') { saveWidth(current - 24); event.preventDefault(); }
        });

        try {
            state.sidebarCollapsed = localStorage.getItem(api.SIDEBAR_COLLAPSED_KEY) === '1';
        } catch (_) {
            state.sidebarCollapsed = false;
        }
        const applySidebar = () => {
            shell.classList.toggle('is-sidebar-collapsed', state.sidebarCollapsed);
            el('bwSidebarToggle').setAttribute('aria-expanded', String(!state.sidebarCollapsed));
        };
        applySidebar();
        el('bwSidebarToggle').addEventListener('click', () => {
            state.sidebarCollapsed = !state.sidebarCollapsed;
            try { localStorage.setItem(api.SIDEBAR_COLLAPSED_KEY, state.sidebarCollapsed ? '1' : '0'); } catch (_) { /* ignore */ }
            applySidebar();
        });

        el('bwCollapsePanelBtn').addEventListener('click', () => {
            if (typeof root.closeCanvasAgentPanel === 'function') {
                root.closeCanvasAgentPanel();
            } else {
                document.getElementById('canvasAgentClose')?.click();
            }
        });

        el('bwClassicBtn').addEventListener('click', () => {
            setUiMode('classic');
            deactivateWorkspace();
        });
    })();

    // ---- 渲染 ----
    function setNotice(text) {
        state.notice = text || '';
        el('bwNoticeText').textContent = state.notice;
    }

    function renderBotList() {
        const listEl = el('bwBotList');
        const visible = state.bots.filter((b) => state.showArchivedBots || b.status === 'active');
        if (!visible.length) {
            listEl.innerHTML = '<div style="padding:12px;color:var(--muted,#616161);font-size:12px;">暂无可用 Bot</div>';
            return;
        }
        listEl.innerHTML = visible.map((bot) => {
            const selected = bot.bot_id === state.activeBotId;
            const roleBadge = bot.is_manager ? '<span class="bw-badge">总管理</span>'
                : bot.status === 'archived' ? '<span class="bw-badge">已归档</span>' : '';
            const modelText = bot.chat_model?.model || bot.role || '未指定模型';
            return `<button type="button" class="bw-bot-item${selected ? ' is-active' : ''}" role="option" aria-selected="${selected}" data-bw-bot="${esc(bot.bot_id)}">
                ${renderAvatar(bot)}
                <span class="bw-bot-meta">
                    <span class="bw-bot-name"><span>${esc(bot.name)}</span>${roleBadge}</span>
                    <span class="bw-bot-sub">${esc(modelText)}</span>
                </span>
            </button>`;
        }).join('');
    }

    function renderHeaderAndSessionBar() {
        const bot = activeBot();
        if (!bot) return;
        el('bwCurrentBotName').textContent = bot.name;
        const activeTurn = state.turns.find((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
        const statusText = bot.status === 'archived'
            ? '已归档（只读历史）'
            : activeTurn
                ? `${TURN_LABELS[activeTurn.status] || activeTurn.status}`
                : (bot.is_manager ? '总管理 · 就绪' : '专业 Bot · 就绪');
        el('bwCurrentBotStatus').textContent = statusText;
        el('bwModelPill').textContent = bot.chat_model?.model
            ? `${bot.chat_model.model}`
            : '自动动态模型（点此配置）';
        el('bwStopBtn').hidden = !activeTurn;
        el('bwSendBtn').disabled = state.sending || bot.status === 'archived';
        el('bwInput').disabled = bot.status === 'archived';
        el('bwNewSessionBtn').disabled = bot.status === 'archived';

        const select = el('bwSessionSelect');
        select.replaceChildren();
        if (!state.sessions.length) {
            select.add(new Option('暂无会话', ''));
        } else {
            for (const sess of state.sessions) {
                const prefix = sess.kind === 'task_thread' ? '[任务] ' : sess.kind === 'legacy_group' ? '[历史群] ' : '';
                select.add(new Option(`${prefix}${sess.title}`, sess.session_id));
            }
            if (state.activeSessionId) select.value = state.activeSessionId;
        }
    }

    function renderBanners() {
        const stack = el('bwBannerStack');
        const parts = [];
        const bot = activeBot();

        if (bot?.status === 'archived') {
            parts.push(`<div class="bw-banner" data-tone="warning">
                <span>当前 Bot 已归档，历史消息只读。</span>
                <div class="bw-banner-actions"><button type="button" class="bw-btn" data-bw-restore-bot="${esc(bot.bot_id)}">恢复 Bot</button></div>
            </div>`);
        }

        // 重启恢复或等待画布连接横幅
        for (const turn of state.turns) {
            if (turn.status === 'recovery_required') {
                parts.push(`<div class="bw-banner" data-tone="warning">
                    <span>${esc(turn.error || '任务因重启暂停，核对已有结果后再继续（不会重复提交付费生成）。')}</span>
                    <div class="bw-banner-actions">
                        <button type="button" class="bw-btn bw-btn-primary" data-bw-resume-turn="${esc(turn.turn_id)}">核对后继续</button>
                        <button type="button" class="bw-btn" data-bw-cancel-turn="${esc(turn.turn_id)}">停止</button>
                    </div>
                </div>`);
            } else if (turn.status === 'waiting_canvas_connection') {
                parts.push(`<div class="bw-banner" data-tone="info">
                    <span>等待画布连接：此操作需要当前项目对应的无限画布处于打开状态，关闭画布后不会无条件继续执行。</span>
                    <div class="bw-banner-actions">
                        <button type="button" class="bw-btn" data-bw-resume-turn="${esc(turn.turn_id)}">立即重试</button>
                    </div>
                </div>`);
            }
        }

        // 关联的画布多 Agent 运行与临时子 Agent 实时进度（明确与永久 Bot 区分）
        for (const snap of (state.runSnapshots || [])) {
            if (['completed', 'failed', 'cancelled'].includes(snap.status)) continue;
            const subs = snap.temporary_subagents || [];
            const subSummary = subs.length
                ? ` · 临时子 Agent（${subs.length}）：` + subs.map((s) => `${s.role}(${TURN_LABELS[s.status] || s.status})`).join('、')
                : '';
            const nodeBtns = (snap.actions || []).flatMap((a) => a.node_ids || []).slice(0, 4).map((nid) =>
                `<button type="button" class="bw-btn" data-bw-focus-node="${esc(nid)}">定位节点</button>`
            ).join('');
            parts.push(`<div class="bw-banner" data-tone="info" data-bw-run-id="${esc(snap.multi_agent_run_id)}">
                <span><strong>画布受控执行</strong>（${esc(TURN_LABELS[snap.status] || snap.status)}）${esc(subSummary)}</span>
                ${nodeBtns ? `<div class="bw-banner-actions">${nodeBtns}</div>` : ''}
            </div>`);
        }

        // 待审批动作卡片
        for (const apr of state.approvals.filter((a) => a.status === 'pending')) {
            parts.push(`<div class="bw-banner" data-tone="warning" data-bw-approval="${esc(apr.approval_id)}">
                <span><strong>需要确认</strong> · ${esc(apr.summary || apr.tool_name)}</span>
                <div class="bw-banner-actions">
                    <button type="button" class="bw-btn bw-btn-primary" data-bw-approve="${esc(apr.approval_id)}">允许</button>
                    <button type="button" class="bw-btn bw-btn-danger" data-bw-reject="${esc(apr.approval_id)}">拒绝</button>
                </div>
            </div>`);
        }

        stack.innerHTML = parts.join('');
    }

    function renderSingleMessageHtml(msg, bot) {
        const roleClass = msg.role === 'user' ? 'is-user'
            : msg.role === 'bot' ? 'is-bot'
                : msg.role === 'delegation' ? 'is-delegation'
                    : msg.role === 'tool' ? 'is-tool' : 'is-system';
        const errClass = msg.kind === 'error' ? ' bw-msg-error' : '';
        const who = msg.role === 'user' ? '你'
            : msg.role === 'bot' ? (msg.meta?.legacy_bot_name || bot?.name || 'Bot')
                : msg.role === 'delegation' ? `委派 · ${msg.meta?.target_bot_name || msg.meta?.parent_bot_name || '协作'}`
                    : msg.role === 'tool' ? `工具 · ${msg.meta?.tool || ''}` : '系统';
        const refs = Array.isArray(msg.meta?.result_refs) ? msg.meta.result_refs : [];
        const refButtons = refs.map((ref) => {
            if (ref.kind === 'node') {
                return `<button type="button" class="bw-btn" data-bw-focus-node="${esc(ref.id)}">定位画布节点</button>`;
            }
            if ((ref.kind === 'image' || ref.kind === 'video') && /^\/(assets\/|output\/|api\/storage-file)/.test(String(ref.id || ''))) {
                return `<a class="bw-btn" href="${esc(ref.id)}" target="_blank" rel="noopener">查看产物</a>`;
            }
            return '';
        }).join('');
        const navButtons = [
            msg.meta?.created_bot_id
                ? `<button type="button" class="bw-btn" data-bw-jump-bot="${esc(msg.meta.created_bot_id)}">打开「${esc(msg.meta.created_bot_name || '新 Bot')}」</button>`
                : '',
            msg.meta?.target_bot_id
                ? `<button type="button" class="bw-btn" data-bw-jump-bot="${esc(msg.meta.target_bot_id)}" data-bw-jump-session="${esc(msg.meta.target_session_id || '')}">查看「${esc(msg.meta.target_bot_name || '目标 Bot')}」进度</button>`
                : '',
        ].join('');
        const retryBtn = (msg.meta?.retryable && msg.meta?.turn_id)
            ? `<button type="button" class="bw-btn" data-bw-retry-turn="${esc(msg.meta.turn_id)}">重试</button>`
            : '';
        const planObj = msg.meta?.design_plan;
        const planHtml = (planObj && Array.isArray(planObj.shots) && planObj.shots.length)
            ? `<div class="bw-plan-card">
                ${planObj.direction ? `<div class="bw-plan-dir"><strong>方向：</strong>${esc(planObj.direction)}</div>` : ''}
                <ol class="bw-plan-shots">${planObj.shots.map((s) => `<li><strong>${esc(s.purpose || s.kind || s.id || '分镜')}</strong> <code>${esc(s.size || '')}</code><div class="bw-plan-prompt">${esc(String(s.prompt || '').slice(0, 180))}</div></li>`).join('')}</ol>
            </div>`
            : '';
        const attHtml = (msg.attachments || []).length
            ? `<div class="bw-attachments">${msg.attachments.map((a) => {
                const url = typeof a === 'string' ? a : (a?.url || '');
                return url ? `<img src="${esc(url)}" alt="附件">` : '';
            }).join('')}</div>`
            : '';
        return `<article class="bw-msg ${roleClass}${errClass}" data-msg-id="${esc(msg.message_id)}">
            <div class="bw-msg-head"><span>${esc(who)}</span></div>
            <div class="bw-bubble">${esc(msg.content)}${planHtml}${attHtml}${(refButtons || navButtons || retryBtn) ? `<div class="bw-card-refs">${refButtons}${navButtons}${retryBtn}</div>` : ''}</div>
        </article>`;
    }

    function renderMessages() {
        const box = el('bwMessages');
        const bot = activeBot();
        if (!state.messages.length) {
            const isMgr = Boolean(bot?.is_manager);
            box.innerHTML = `<div class="bw-empty">
                ${renderAvatar(bot)}
                <h4>${esc(bot?.name || '小美总管理')}</h4>
                <p>${esc(bot?.role || '开始独立对话，所有记录与长期记忆持久保存在本地 SQLite。')}</p>
                ${isMgr ? `<div class="bw-quick-prompts">
                    <button type="button" class="bw-btn" data-bw-quick="帮我创建一个专门负责电商主图文案和视觉拆解的永久 Bot">创建专业 Bot</button>
                    <button type="button" class="bw-btn" data-bw-quick="列出当前工作区的所有 Bot 和权限状态">查看团队状态</button>
                    <button type="button" class="bw-btn" data-bw-quick="分析当前画布的节点和素材，不要修改画布">分析当前画布</button>
                </div>` : ''}
            </div>`;
            return;
        }
        box.innerHTML = state.messages.map((msg) => renderSingleMessageHtml(msg, bot)).join('');
        box.scrollTop = box.scrollHeight;
    }

    function appendSingleMessage(msg) {
        const box = el('bwMessages');
        const bot = activeBot();
        if (!box.querySelector('.bw-msg')) {
            renderMessages();
            return;
        }
        box.insertAdjacentHTML('beforeend', renderSingleMessageHtml(msg, bot));
        box.scrollTop = box.scrollHeight;
    }

    function clearCanvasNodeBadges() {
        document.querySelectorAll('.bw-node-badge').forEach((badge) => badge.remove());
    }

    function syncCanvasNodeBadges() {
        clearCanvasNodeBadges();
        if (!state.active || !state.runSnapshots?.length) return;
        const scope = currentScope();
        for (const snap of state.runSnapshots) {
            if (['completed', 'failed', 'cancelled'].includes(snap.status)) continue;
            if (scope.canvas_id && snap.canvas_id && snap.canvas_id !== scope.canvas_id) continue;
            const ownerBot = state.bots.find((b) => b.bot_id === snap.bot_id) || activeBot();
            const label = `${ownerBot?.name || 'Bot'} · ${TURN_LABELS[snap.status] || '协作中'}`;
            const nodeIds = new Set((snap.actions || []).flatMap((a) => a.node_ids || []).filter(Boolean));
            for (const nid of nodeIds) {
                const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nid)}"], [data-id="${CSS.escape(nid)}"]`);
                if (!nodeEl || nodeEl.querySelector('.bw-node-badge')) continue;
                const badge = document.createElement('span');
                badge.className = 'bw-node-badge';
                badge.textContent = label;
                nodeEl.appendChild(badge);
            }
        }
    }

    function renderComposerAttachments() {
        const box = el('bwComposerAttachments');
        if (!state.attachedImages.length) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        box.innerHTML = state.attachedImages.map((url, idx) => `
            <span style="position:relative;display:inline-flex;">
                <img src="${esc(url)}" alt="引用图 ${idx + 1}">
                <button type="button" data-bw-remove-att="${idx}" aria-label="移除引用图" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;border:none;background:#111;color:#fff;font-size:11px;cursor:pointer;">×</button>
            </span>
        `).join('');
    }

    function renderAll() {
        renderBotList();
        renderHeaderAndSessionBar();
        renderBanners();
        renderMessages();
        renderComposerAttachments();
        syncCanvasNodeBadges();
        if (state.drawerOpen) renderDrawer();
    }

    // ---- Bot 配置 / 新建 / Skills / 长期记忆 / 权限抽屉 ----
    function providerOptionsHtml(kind, selectedProvider) {
        const providers = (state.config?.providers || []).filter((p) => (p[kind] || []).length > 0);
        return ['<option value="">自动选择动态模型</option>']
            .concat(providers.map((p) => `<option value="${esc(p.id)}"${p.id === selectedProvider ? ' selected' : ''}>${esc(p.name || p.id)}</option>`))
            .join('');
    }

    function modelOptionsHtml(kind, providerId, selectedModel) {
        const provider = (state.config?.providers || []).find((p) => p.id === providerId);
        const list = (provider?.[kind] || []).map((item) => (typeof item === 'object' ? (item.id || item.name) : String(item))).filter(Boolean);
        return ['<option value="">默认</option>']
            .concat(list.map((m) => `<option value="${esc(m)}"${m === selectedModel ? ' selected' : ''}>${esc(m)}</option>`))
            .join('');
    }

    function openDrawer(mode = 'settings', tab = 'profile') {
        state.drawerOpen = true;
        state.drawerMode = mode;
        state.drawerTab = tab;
        el('bwDrawer').hidden = false;
        el('bwDrawerTitle').textContent = mode === 'create' ? '新建永久 Bot' : `Bot 设置 · ${activeBot()?.name || ''}`;
        el('bwDrawerTabs').hidden = mode === 'create';
        el('bwDrawerTabs').querySelectorAll('[data-bw-tab]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.bwTab === tab);
        });
        renderDrawer();
    }

    function closeDrawer() {
        state.drawerOpen = false;
        el('bwDrawer').hidden = true;
    }

    function renderDrawer() {
        const body = el('bwDrawerBody');
        const bot = state.drawerMode === 'create' ? null : activeBot();

        if (state.drawerMode === 'create' || state.drawerTab === 'profile') {
            const isCreate = state.drawerMode === 'create';
            const chatP = bot?.chat_model?.provider_id || '';
            const chatM = bot?.chat_model?.model || '';
            const imgP = bot?.image_model?.provider_id || '';
            const imgM = bot?.image_model?.model || '';
            const shapes = state.config?.avatar_shapes || ['star', 'bunny', 'moon', 'gumdrop', 'kitty', 'acorn', 'peanut'];
            const curShape = bot?.avatar?.shape || (isCreate ? 'bunny' : 'star');
            const curColor = bot?.avatar?.color || (isCreate ? '#3C6E9F' : '#2F6F5E');

            body.innerHTML = `
                <form id="bwProfileForm" style="display:flex;flex-direction:column;gap:10px;">
                    <label class="bw-field"><span>名称</span>
                        <input class="bw-input" name="name" required maxlength="48" value="${esc(bot?.name || '')}" placeholder="例如：主图策划专家">
                    </label>
                    <label class="bw-field"><span>角色职责</span>
                        <input class="bw-input" name="role" maxlength="200" value="${esc(bot?.role || '')}" placeholder="例如：负责分析产品卖点与电商主图视觉策划">
                    </label>
                    <div class="bw-grid-2">
                        <label class="bw-field"><span>形象</span>
                            <select class="bw-select" name="avatar_shape">${shapes.map((s) => `<option value="${esc(s)}"${s === curShape ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
                        </label>
                        <label class="bw-field"><span>颜色</span>
                            <input class="bw-input" name="avatar_color" type="color" value="${esc(curColor)}" style="height:32px;padding:2px;">
                        </label>
                    </div>
                    <label class="bw-field"><span>系统指令</span>
                        <textarea class="bw-textarea" name="system_instructions" rows="4" maxlength="12000" placeholder="描述该 Bot 的工作方法、输出规范与安全边界…">${esc(bot?.system_instructions || '')}</textarea>
                    </label>
                    <label class="bw-field"><span>风格与人格</span>
                        <input class="bw-input" name="personality" maxlength="2000" value="${esc(bot?.personality || '')}" placeholder="例如：简洁直接、注重数据依据">
                    </label>
                    <div class="bw-grid-2">
                        <label class="bw-field"><span>独立对话平台</span>
                            <select class="bw-select" name="chat_provider_id">${providerOptionsHtml('chat_models', chatP)}</select>
                        </label>
                        <label class="bw-field"><span>独立对话模型</span>
                            <select class="bw-select" name="chat_model">${modelOptionsHtml('chat_models', chatP, chatM)}</select>
                        </label>
                    </div>
                    <div class="bw-grid-2">
                        <label class="bw-field"><span>独立生图平台</span>
                            <select class="bw-select" name="image_provider_id">${providerOptionsHtml('image_models', imgP)}</select>
                        </label>
                        <label class="bw-field"><span>独立生图模型</span>
                            <select class="bw-select" name="image_model">${modelOptionsHtml('image_models', imgP, imgM)}</select>
                        </label>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:6px;">
                        <button type="button" class="bw-btn" id="bwFormCancel">取消</button>
                        <button type="submit" class="bw-btn bw-btn-primary">${isCreate ? '创建永久 Bot' : '保存配置'}</button>
                    </div>
                </form>
            `;
            const form = body.querySelector('#bwProfileForm');
            form.querySelector('[name=chat_provider_id]').addEventListener('change', (e) => {
                form.querySelector('[name=chat_model]').innerHTML = modelOptionsHtml('chat_models', e.target.value, '');
            });
            form.querySelector('[name=image_provider_id]').addEventListener('change', (e) => {
                form.querySelector('[name=image_model]').innerHTML = modelOptionsHtml('image_models', e.target.value, '');
            });
            body.querySelector('#bwFormCancel').addEventListener('click', closeDrawer);
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const fd = new FormData(form);
                const payload = {
                    name: String(fd.get('name') || '').trim(),
                    role: String(fd.get('role') || '').trim(),
                    system_instructions: String(fd.get('system_instructions') || '').trim(),
                    personality: String(fd.get('personality') || '').trim(),
                    avatar: {
                        shape: String(fd.get('avatar_shape') || 'bunny'),
                        color: String(fd.get('avatar_color') || '#3C6E9F'),
                        text: String(fd.get('name') || '助').trim().slice(0, 1),
                    },
                    chat_model: { provider_id: String(fd.get('chat_provider_id') || ''), model: String(fd.get('chat_model') || '') },
                    image_model: { provider_id: String(fd.get('image_provider_id') || ''), model: String(fd.get('image_model') || '') },
                };
                try {
                    if (isCreate) {
                        const res = await api.createBot(payload);
                        await refreshBots();
                        await selectBot(res.bot.bot_id);
                        setNotice(`已创建永久 Bot「${res.bot.name}」`);
                    } else {
                        const res = await api.updateBot(bot.bot_id, payload);
                        await refreshBots();
                        setNotice(`已保存「${res.bot.name}」配置`);
                    }
                    closeDrawer();
                } catch (err) {
                    setNotice(err.message);
                }
            });
            return;
        }

        if (state.drawerTab === 'skills' && bot) {
            const installed = state.config?.skills || [];
            const boundIds = new Set((bot.skills || []).filter((s) => s.enabled).map((s) => s.skill_id));
            body.innerHTML = `
                <p style="margin:0;color:var(--muted,#616161);font-size:12px;">勾选要绑定到「${esc(bot.name)}」的已安装 Skill（只读取规范文本，不自动运行脚本）。</p>
                <div class="bw-check-list" id="bwSkillChecks">
                    ${installed.length ? installed.map((s) => `
                        <label class="bw-check-item">
                            <input type="checkbox" value="${esc(s.id)}" ${boundIds.has(s.id) ? 'checked' : ''}>
                            <span><strong>${esc(s.name)}</strong><br><small style="color:var(--muted,#616161);">${esc(s.description || s.id)}</small></span>
                        </label>
                    `).join('') : '<p style="color:var(--muted,#616161);">尚未安装 Skill，请通过 Skill 管理安装后再绑定。</p>'}
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px;">
                    <button type="button" class="bw-btn bw-btn-primary" id="bwSaveSkillsBtn">保存绑定</button>
                </div>
            `;
            body.querySelector('#bwSaveSkillsBtn').addEventListener('click', async () => {
                const chosen = [...body.querySelectorAll('#bwSkillChecks input:checked')].map((input) => input.value);
                try {
                    await api.setBotSkills(bot.bot_id, chosen);
                    await refreshBots();
                    setNotice(`已更新「${bot.name}」的 Skill 绑定（${chosen.length} 个）`);
                    closeDrawer();
                } catch (err) {
                    setNotice(err.message);
                }
            });
            return;
        }

        if (state.drawerTab === 'memory' && bot) {
            body.innerHTML = `
                <form id="bwMemoryAddForm" style="display:flex;gap:6px;">
                    <input class="bw-input" id="bwMemoryInput" maxlength="400" style="flex:1;" placeholder="添加该 Bot 的独立长期记忆（禁止填写密钥）">
                    <button type="submit" class="bw-btn bw-btn-primary">记住</button>
                </form>
                <div id="bwMemoryList" style="display:flex;flex-direction:column;gap:6px;">
                    ${state.memories.length ? state.memories.map((m) => `
                        <div class="bw-memory-row">
                            <div><p>${esc(m.content)}</p><small>${esc(m.scope)} · ${esc(m.source)}</small></div>
                            <button type="button" class="bw-btn bw-btn-danger" data-bw-del-mem="${esc(m.memory_id)}">删除</button>
                        </div>
                    `).join('') : '<p style="color:var(--muted,#616161);font-size:12px;">暂无长期记忆。</p>'}
                </div>
            `;
            body.querySelector('#bwMemoryAddForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const input = body.querySelector('#bwMemoryInput');
                const content = input.value.trim();
                if (!content) return;
                try {
                    await api.addMemory(bot.bot_id, { content, scope: 'bot', project_id: currentScope().project_id });
                    input.value = '';
                    await refreshMemories(bot.bot_id);
                    renderDrawer();
                    setNotice('已写入 Bot 独立长期记忆');
                } catch (err) {
                    setNotice(err.message);
                }
            });
            body.querySelectorAll('[data-bw-del-mem]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    try {
                        await api.deleteMemory(bot.bot_id, btn.dataset.bwDelMem);
                        await refreshMemories(bot.bot_id);
                        renderDrawer();
                    } catch (err) {
                        setNotice(err.message);
                    }
                });
            });
            return;
        }

        if (state.drawerTab === 'permissions' && bot) {
            const allowedPool = bot.is_manager
                ? (state.config?.tools?.all || [])
                : (state.config?.tools?.specialist_max || []);
            const currentTools = new Set(bot.tool_permissions || []);
            body.innerHTML = `
                <p style="margin:0;color:var(--muted,#616161);font-size:12px;">
                    ${bot.is_manager ? '总管理 Bot 默认拥有团队与画布编排权限，不允许归档。' : '专业 Bot 权限受服务端严格校验：不能提权、不能创建总管理、不能执行系统 Shell。'}
                </p>
                <div class="bw-check-list" id="bwPermChecks">
                    ${allowedPool.map((tool) => `
                        <label class="bw-check-item">
                            <input type="checkbox" value="${esc(tool)}" ${currentTools.has(tool) ? 'checked' : ''} ${bot.is_manager ? 'disabled' : ''}>
                            <span><strong>${esc(TOOL_LABELS[tool] || tool)}</strong><br><small style="color:var(--muted,#616161);">${esc(tool)}</small></span>
                        </label>
                    `).join('')}
                </div>
                <div style="display:flex;justify-content:space-between;gap:8px;padding-top:6px;">
                    ${!bot.is_manager ? (bot.status === 'active'
                        ? `<button type="button" class="bw-btn bw-btn-danger" id="bwArchiveBotBtn">归档此 Bot</button>`
                        : `<button type="button" class="bw-btn" id="bwRestoreBotBtn">恢复此 Bot</button>`) : '<span></span>'}
                    ${!bot.is_manager ? '<button type="button" class="bw-btn bw-btn-primary" id="bwSavePermBtn">保存权限</button>' : ''}
                </div>
            `;
            body.querySelector('#bwSavePermBtn')?.addEventListener('click', async () => {
                const chosen = [...body.querySelectorAll('#bwPermChecks input:checked')].map((i) => i.value);
                try {
                    await api.updateBot(bot.bot_id, {
                        tool_permissions: chosen,
                        delegation_policy: { ...bot.delegation_policy, allow_delegate: chosen.includes('bot.delegate') },
                        canvas_policy: { ...bot.canvas_policy, allow_canvas_writes: chosen.includes('canvas.dispatch_run') || chosen.includes('canvas.command') },
                    });
                    await refreshBots();
                    setNotice('已更新工具权限');
                    closeDrawer();
                } catch (err) {
                    setNotice(err.message);
                }
            });
            body.querySelector('#bwArchiveBotBtn')?.addEventListener('click', async () => {
                try {
                    await api.archiveBot(bot.bot_id, '用户归档');
                    await refreshBots();
                    await selectBot(state.config?.manager_bot_id || 'bot_manager');
                    setNotice(`已归档「${bot.name}」`);
                    closeDrawer();
                } catch (err) {
                    setNotice(err.message);
                }
            });
            body.querySelector('#bwRestoreBotBtn')?.addEventListener('click', async () => {
                try {
                    await api.restoreBot(bot.bot_id);
                    await refreshBots();
                    setNotice(`已恢复「${bot.name}」`);
                    closeDrawer();
                } catch (err) {
                    setNotice(err.message);
                }
            });
        }
    }

    // ---- 数据刷新 ----
    async function refreshBots() {
        const res = await api.listBots(true);
        state.bots = res.bots || [];
        renderBotList();
        renderHeaderAndSessionBar();
    }

    async function refreshMemories(botId) {
        if (!botId) return;
        const res = await api.listMemories(botId, currentScope().project_id);
        state.memories = res.memories || [];
    }

    async function selectBot(botId) {
        if (!botId) return;
        state.activeBotId = botId;
        try { localStorage.setItem(api.ACTIVE_BOT_KEY, botId); } catch (_) { /* ignore */ }
        const sessRes = await api.listSessions(botId, { includeArchived: true });
        state.sessions = sessRes.sessions || [];
        let targetSessionId = '';
        try {
            const remembered = localStorage.getItem(api.ACTIVE_SESSION_PREFIX + botId) || '';
            if (state.sessions.some((s) => s.session_id === remembered)) targetSessionId = remembered;
        } catch (_) { /* ignore */ }
        if (!targetSessionId) {
            const firstActive = state.sessions.find((s) => !s.archived) || state.sessions[0];
            if (firstActive) {
                targetSessionId = firstActive.session_id;
            } else {
                const bot = activeBot();
                if (bot && bot.status === 'active') {
                    const scope = currentScope();
                    const created = await api.createSession(botId, {
                        title: '默认会话',
                        project_id: scope.project_id,
                        canvas_id: scope.canvas_id,
                    });
                    state.sessions = [created.session];
                    targetSessionId = created.session.session_id;
                }
            }
        }
        await selectSession(targetSessionId);
        await refreshMemories(botId);
        renderAll();
    }

    async function selectSession(sessionId) {
        state.activeSessionId = sessionId || '';
        if (state.activeBotId && state.activeSessionId) {
            try { localStorage.setItem(api.ACTIVE_SESSION_PREFIX + state.activeBotId, state.activeSessionId); } catch (_) { /* ignore */ }
        }
        if (!state.activeSessionId) {
            state.messages = [];
            state.turns = [];
            state.approvals = [];
            state.runLinks = [];
            state.runSnapshots = [];
            renderAll();
            return;
        }
        const data = await api.listMessages(state.activeSessionId, 0, 200);
        state.messages = data.messages || [];
        state.turns = data.turns || [];
        state.approvals = data.approvals || [];
        state.runLinks = data.run_links || [];
        state.runSnapshots = data.run_snapshots || [];
        renderAll();
        void pumpLinkedCanvasRuns();
    }

    // ---- 复用 CanvasMultiAgentBridge 执行已批准画布动作（P3 融合入口） ----
    async function pumpLinkedCanvasRuns() {
        const bridge = root.CanvasMultiAgentBridge;
        if (!bridge || !state.runLinks.length) return;
        const scope = currentScope();
        if (!scope.project_id || !scope.canvas_id) return;
        for (const link of state.runLinks) {
            if (['completed', 'failed', 'cancelled'].includes(link.status)) continue;
            if (link.project_id !== scope.project_id || link.canvas_id !== scope.canvas_id) continue;
            try {
                const qs = new URLSearchParams({ project_id: scope.project_id, canvas_id: scope.canvas_id }).toString();
                const resp = await fetch(`/api/canvas-agent/multi/runs/${encodeURIComponent(link.multi_agent_run_id)}?${qs}`, { cache: 'no-store' });
                if (!resp.ok) continue;
                const snap = await resp.json();
                if (snap.run?.recovery_required) continue;
                for (const action of (snap.actions || [])) {
                    if (action.operation?.tool === 'canvas.run_node' && (['executing', 'waiting_result'].includes(action.status) || (action.status === 'registered' && action.resume_unsubmitted))) {
                        await bridge.restore(action);
                    }
                    if (action.status !== 'registered' || !action.approved) continue;
                    if (state.executingActionIds.has(action.action_id)) continue;
                    state.executingActionIds.add(action.action_id);
                    let claimed = null;
                    try {
                        await bridge.flush(scope.canvas_id);
                        const claimResp = await fetch(`/api/canvas-agent/multi/runs/${encodeURIComponent(link.multi_agent_run_id)}/actions/${encodeURIComponent(action.action_id)}/claim`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project_id: scope.project_id, canvas_id: scope.canvas_id, client_id: state.clientId }),
                        });
                        if (!claimResp.ok) continue;
                        claimed = (await claimResp.json()).action;
                        const receipt = await bridge.execute(claimed);
                        await fetch(`/api/canvas-agent/multi/runs/${encodeURIComponent(link.multi_agent_run_id)}/actions/${encodeURIComponent(action.action_id)}/receipt`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project_id: scope.project_id, canvas_id: scope.canvas_id, ...receipt, lease_token: claimed.lease_token, status: 'applied' }),
                        });
                    } catch (err) {
                        if (claimed) {
                            await fetch(`/api/canvas-agent/multi/runs/${encodeURIComponent(link.multi_agent_run_id)}/actions/${encodeURIComponent(action.action_id)}/receipt`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ project_id: scope.project_id, canvas_id: scope.canvas_id, lease_token: claimed.lease_token, status: 'failed', error: String(err?.message || err).slice(0, 1000), node_ids: [] }),
                            }).catch(() => {});
                        }
                    } finally {
                        state.executingActionIds.delete(action.action_id);
                    }
                }
            } catch (_) { /* ignore */ }
        }
    }

    // ---- 发送消息 ----
    async function sendCurrentMessage() {
        const bot = activeBot();
        const session = activeSession();
        if (!bot || bot.status !== 'active' || state.sending) return;
        const inputEl = el('bwInput');
        const content = inputEl.value.trim();
        if (!content && !state.attachedImages.length) return;
        state.sending = true;
        renderHeaderAndSessionBar();
        setNotice('正在保存并加入执行队列…');
        try {
            let sid = session?.session_id;
            const scope = currentScope();
            if (!sid) {
                const created = await api.createSession(bot.bot_id, { title: '新会话', project_id: scope.project_id, canvas_id: scope.canvas_id });
                state.sessions.unshift(created.session);
                sid = created.session.session_id;
                state.activeSessionId = sid;
            }
            const res = await api.sendMessage(sid, {
                content,
                attachments: state.attachedImages.map((url) => ({ url })),
                idempotency_key: api.makeId('msg'),
                project_id: scope.project_id,
                canvas_id: scope.canvas_id,
            });
            inputEl.value = '';
            state.attachedImages = [];
            renderComposerAttachments();
            if (res.message && !state.messages.some((m) => m.message_id === res.message.message_id)) {
                state.messages.push(res.message);
            }
            if (res.turn) {
                state.turns = [res.turn, ...state.turns.filter((t) => t.turn_id !== res.turn.turn_id)];
            }
            setNotice('');
            renderAll();
        } catch (err) {
            setNotice(err.message || '发送失败，请重试');
        } finally {
            state.sending = false;
            renderHeaderAndSessionBar();
        }
    }

    // ---- SSE 事件处理 ----
    function handleStreamEvent(evt) {
        if (!evt || !evt.event_type) return;
        const type = evt.event_type;
        if (['bot_created', 'bot_updated', 'bot_archived', 'bot_restored', 'bot_skills_updated'].includes(type)) {
            void refreshBots();
        }
        if (type === 'session_created' && evt.bot_id === state.activeBotId) {
            void api.listSessions(state.activeBotId, { includeArchived: true }).then((r) => {
                state.sessions = r.sessions || [];
                renderHeaderAndSessionBar();
            }).catch(() => {});
        }
        if (type === 'message_created' && evt.session_id === state.activeSessionId && evt.payload?.message) {
            const msg = evt.payload.message;
            if (!state.messages.some((m) => m.message_id === msg.message_id)) {
                state.messages.push(msg);
                appendSingleMessage(msg);
            }
        }
        if (['turn_queued', 'turn_updated', 'turn_recovery_required'].includes(type)) {
            void refreshBots();
            if (evt.session_id === state.activeSessionId && evt.payload?.turn) {
                const t = evt.payload.turn;
                state.turns = [t, ...state.turns.filter((x) => x.turn_id !== t.turn_id)];
                renderHeaderAndSessionBar();
                renderBanners();
            }
        }
        if (['approval_requested', 'approval_resolved'].includes(type) && evt.session_id === state.activeSessionId) {
            void selectSession(state.activeSessionId);
        }
        if (['run_linked', 'canvas_action_waiting', 'canvas_action_completed'].includes(type)) {
            if (evt.session_id === state.activeSessionId) {
                void selectSession(state.activeSessionId);
            } else {
                void pumpLinkedCanvasRuns();
            }
        }
    }

    function sendPresence() {
        if (!state.active) return;
        const scope = currentScope();
        if (!scope.project_id || !scope.canvas_id) return;
        void api.heartbeatCanvas(scope.project_id, scope.canvas_id, state.clientId).catch(() => {});
    }

    // ---- DOM 事件绑定 ----
    shell.addEventListener('click', async (event) => {
        const botBtn = event.target.closest('[data-bw-bot]');
        if (botBtn) {
            closeDrawer();
            await selectBot(botBtn.dataset.bwBot);
            return;
        }
        const jumpBotBtn = event.target.closest('[data-bw-jump-bot]');
        if (jumpBotBtn) {
            closeDrawer();
            await refreshBots();
            await selectBot(jumpBotBtn.dataset.bwJumpBot);
            if (jumpBotBtn.dataset.bwJumpSession) {
                await selectSession(jumpBotBtn.dataset.bwJumpSession);
            }
            return;
        }
        const quickBtn = event.target.closest('[data-bw-quick]');
        if (quickBtn) {
            el('bwInput').value = quickBtn.dataset.bwQuick;
            el('bwInput').focus();
            return;
        }
        const focusBtn = event.target.closest('[data-bw-focus-node]');
        if (focusBtn) {
            root.CanvasMultiAgentBridge?.focus?.(focusBtn.dataset.bwFocusNode);
            return;
        }
        const removeAtt = event.target.closest('[data-bw-remove-att]');
        if (removeAtt) {
            state.attachedImages.splice(Number(removeAtt.dataset.bwRemoveAtt), 1);
            renderComposerAttachments();
            return;
        }
        const approveBtn = event.target.closest('[data-bw-approve]');
        if (approveBtn) {
            try {
                await api.resolveApproval(approveBtn.dataset.bwApprove, true);
                await selectSession(state.activeSessionId);
                setNotice('已允许执行');
            } catch (err) { setNotice(err.message); }
            return;
        }
        const rejectBtn = event.target.closest('[data-bw-reject]');
        if (rejectBtn) {
            try {
                await api.resolveApproval(rejectBtn.dataset.bwReject, false);
                await selectSession(state.activeSessionId);
                setNotice('已拒绝此操作');
            } catch (err) { setNotice(err.message); }
            return;
        }
        const retryBtn = event.target.closest('[data-bw-retry-turn]');
        if (retryBtn) {
            try {
                await api.retryTurn(retryBtn.dataset.bwRetryTurn);
                setNotice('已重新加入执行队列');
            } catch (err) { setNotice(err.message); }
            return;
        }
        const resumeBtn = event.target.closest('[data-bw-resume-turn]');
        if (resumeBtn) {
            try {
                await api.resumeTurn(resumeBtn.dataset.bwResumeTurn);
                setNotice('已恢复任务');
            } catch (err) { setNotice(err.message); }
            return;
        }
        const cancelBtn = event.target.closest('[data-bw-cancel-turn]');
        if (cancelBtn) {
            try {
                await api.cancelTurn(cancelBtn.dataset.bwCancelTurn);
                setNotice('已停止任务');
            } catch (err) { setNotice(err.message); }
            return;
        }
        const restoreBtn = event.target.closest('[data-bw-restore-bot]');
        if (restoreBtn) {
            try {
                await api.restoreBot(restoreBtn.dataset.bwRestoreBot);
                await refreshBots();
                await selectBot(restoreBtn.dataset.bwRestoreBot);
            } catch (err) { setNotice(err.message); }
            return;
        }
        const tabBtn = event.target.closest('[data-bw-tab]');
        if (tabBtn) {
            state.drawerTab = tabBtn.dataset.bwTab;
            el('bwDrawerTabs').querySelectorAll('[data-bw-tab]').forEach((b) => b.classList.toggle('is-active', b === tabBtn));
            if (state.drawerTab === 'memory') await refreshMemories(state.activeBotId);
            renderDrawer();
        }
    });

    el('bwShowArchived').addEventListener('change', (e) => {
        state.showArchivedBots = Boolean(e.target.checked);
        renderBotList();
    });
    el('bwNewBotBtn').addEventListener('click', () => openDrawer('create', 'profile'));
    el('bwSettingsBtn').addEventListener('click', async () => {
        if (state.drawerOpen && state.drawerMode === 'settings') {
            closeDrawer();
        } else {
            await refreshMemories(state.activeBotId);
            openDrawer('settings', 'profile');
        }
    });
    el('bwModelPill').addEventListener('click', () => openDrawer('settings', 'profile'));
    el('bwDrawerClose').addEventListener('click', closeDrawer);
    el('bwSessionSelect').addEventListener('change', (e) => void selectSession(e.target.value));
    el('bwNewSessionBtn').addEventListener('click', async () => {
        const bot = activeBot();
        if (!bot || bot.status !== 'active') return;
        try {
            const scope = currentScope();
            const res = await api.createSession(bot.bot_id, {
                title: '新会话',
                project_id: scope.project_id,
                canvas_id: scope.canvas_id,
            });
            state.sessions.unshift(res.session);
            await selectSession(res.session.session_id);
        } catch (err) {
            setNotice(err.message);
        }
    });
    el('bwAttachCanvasBtn').addEventListener('click', async () => {
        try {
            const bridge = root.CanvasMultiAgentBridge;
            if (!bridge?.prepare) {
                setNotice('当前画布未就绪');
                return;
            }
            const ctx = await bridge.prepare();
            const urls = (ctx.source_images || []).filter(Boolean);
            if (!urls.length) {
                setNotice('请先在画布上选中包含图片的节点');
                return;
            }
            for (const url of urls) {
                if (!state.attachedImages.includes(url)) state.attachedImages.push(url);
            }
            renderComposerAttachments();
            setNotice(`已引用 ${urls.length} 张画布素材图`);
        } catch (err) {
            setNotice(err.message || '读取画布参考图失败');
        }
    });
    el('bwSendBtn').addEventListener('click', () => void sendCurrentMessage());
    el('bwStopBtn').addEventListener('click', async () => {
        const activeTurn = state.turns.find((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
        if (!activeTurn) return;
        try {
            await api.cancelTurn(activeTurn.turn_id);
            setNotice('已停止当前任务');
        } catch (err) {
            setNotice(err.message);
        }
    });

    const inputEl = el('bwInput');
    inputEl.addEventListener('compositionstart', () => { state.composing = true; });
    inputEl.addEventListener('compositionend', () => { state.composing = false; });
    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !state.composing) {
            event.preventDefault();
            void sendCurrentMessage();
        }
    });

    // ---- 启用与回退切换 ----
    async function activateWorkspace() {
        if (!state.serverEnabled) return;
        state.active = true;
        applySavedWidth();
        panel.classList.add('bot-workspace-active');
        classicSwitchBtn.hidden = true;

        await refreshBots();
        const managerId = state.config?.manager_bot_id || 'bot_manager';
        let initialBot = '';
        try {
            const remembered = localStorage.getItem(api.ACTIVE_BOT_KEY) || '';
            if (state.bots.some((b) => b.bot_id === remembered && b.status === 'active')) initialBot = remembered;
        } catch (_) { /* ignore */ }
        await selectBot(initialBot || managerId);

        if (!state.stream) {
            state.stream = new api.BotWorkspaceEventStream({
                onEvent: handleStreamEvent,
                onConnectionChange: (conn) => {
                    state.connection = conn;
                    el('bwConnState').textContent = conn === 'connected' ? '实时连接' : conn === 'reconnecting' ? '重连中…' : '';
                },
            });
        }
        state.stream.start(state.config?.latest_event_seq || 0);
        sendPresence();
        clearInterval(state.presenceTimer);
        state.presenceTimer = setInterval(sendPresence, 15000);
    }

    function deactivateWorkspace() {
        state.active = false;
        panel.classList.remove('bot-workspace-active');
        clearCanvasNodeBadges();
        if (state.serverEnabled) classicSwitchBtn.hidden = false;
        state.stream?.stop();
        clearInterval(state.presenceTimer);
        state.presenceTimer = 0;
    }

    async function bootstrap() {
        try {
            const config = await api.getConfig();
            if (!config || config.feature_flags?.enabled !== true) {
                state.serverEnabled = false;
                deactivateWorkspace();
                return;
            }
            state.config = config;
            state.serverEnabled = true;
            if (getUiMode() === 'classic') {
                deactivateWorkspace();
                classicSwitchBtn.hidden = false;
            } else {
                await activateWorkspace();
            }
        } catch (_) {
            // 服务端未启用或旧回归测试未 mock /api/bot-workspace/config 时静默保持经典 Agent
            state.serverEnabled = false;
            deactivateWorkspace();
        }
    }

    window.addEventListener('pagehide', () => {
        state.stream?.stop();
        clearInterval(state.presenceTimer);
    });

    root.BotWorkspaceUI = {
        isActive: () => state.active,
        activate: activateWorkspace,
        deactivate: deactivateWorkspace,
        refreshBots,
        selectBot,
        selectSession,
        openDrawer,
        closeDrawer,
        getState: () => ({
            active: state.active,
            activeBotId: state.activeBotId,
            activeSessionId: state.activeSessionId,
            botCount: state.bots.length,
        }),
    };

    void bootstrap();
})(window);
