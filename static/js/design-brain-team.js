/* 设计大脑 · Bot 团队（P1）
 *
 * 三栏会话界面：左侧 Bot / 群列表，中间消息流，右侧成员与设置。
 * 数据全部走 /api/design-brain/team|bots|groups|chats；回合由服务端
 * design_brain_turns.py 驱动，这里只负责发消息、拉增量和显示状态。
 *
 * 与 design-brain.js 的分工：标签切换仍由主文件负责，切换时通过
 * `design-brain-tab` 事件通知本模块停/启轮询。
 */
(() => {
    'use strict';

    const STORAGE_CHAT = 'xiaomei_team_chat_v1';
    const STORAGE_MODELS = 'xiaomei_team_models_v1';
    const CAPABILITY_LABELS = {
        'pack.read': '资料读取', 'pack.plan': '方案规划', 'pack.execute': '生成执行',
        'pack.review': '质量检查', 'pack.workflow': '标准流水线', 'pack.team': '团队管理',
        'pack.memory': '记忆',
    };

    const state = {
        team: null,
        currentChat: '',
        messages: [],
        cursor: 0,
        pollTimer: null,
        statusTimer: null,
        running: false,
        turn: {},
        tasks: [],
        progressStale: false,
        turnStale: false,
        statusBusy: false,
        work: [],
        workReady: false,
        workBusy: false,
        workStale: false,
        stoppingWork: new Set(),
        providers: null,
        mentionItems: [],
        mentionIndex: 0,
        sideMode: '',
        productImages: [],
        drafts: new Map(),
        sending: false,
        uploadController: null,
    };

    const $ = (id) => document.getElementById(id);

    function syncComposer() {
        const input = $('teamInput');
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
        $('teamSend').disabled = state.sending || Boolean(state.uploadController) || (!input.value.trim() && !state.productImages.length);
    }

    function setWelcome(visible) {
        const main = document.querySelector('.team-main');
        main.classList.toggle('is-welcome', visible);
        if (visible && !main.dataset.welcomed) {
            main.dataset.welcomed = 'true';
            main.classList.add('welcome-enter');
            main.addEventListener('animationend', () => main.classList.remove('welcome-enter'), {once: true});
        }
    }

    function toggleInspector(open) {
        const visible = open === undefined ? $('teamInspector').hidden : open;
        if (visible) document.dispatchEvent(new CustomEvent('design-brain-workspace-close'));
        $('teamInspector').hidden = !visible;
        document.querySelector('.team-split').classList.toggle('team-inspector-open', visible);
        $('teamInspectorToggle').setAttribute('aria-expanded', String(visible));
    }

    function toggleModels(open, kind = 'Chat') {
        const panel = $('teamModelsAdv');
        const visible = open ?? !panel.matches(':popover-open');
        if (visible) {
            state.modelFocusKind = kind;
            $('teamModelsTitle').textContent = kind === 'Image' ? '生图模型' : '对话模型';
            panel.querySelectorAll('[data-model-kind]').forEach(group => {
                group.hidden = group.dataset.modelKind !== kind;
            });
            $('teamModelToggle').setAttribute('aria-expanded', String(kind === 'Chat'));
            $('teamImageModelToggle').setAttribute('aria-expanded', String(kind === 'Image'));
            panel.showPopover();
            positionModels();
            $(`team${kind}Provider`).focus({preventScroll: true});
        } else panel.hidePopover();
    }

    function positionModels() {
        const panel = $('teamModelsAdv');
        if (!panel.matches(':popover-open')) return;
        // 固定定位的浮层继承 body 的 CSS zoom，坐标需换算为布局像素。
        const scale = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
        const main = document.querySelector('.team-main').getBoundingClientRect();
        const composer = document.querySelector('.team-composer').getBoundingClientRect();
        const anchor = $(state.modelFocusKind === 'Image' ? 'teamImageModelToggle' : 'teamModelToggle').getBoundingClientRect();
        const width = Math.min(420, innerWidth - 24, main.width - 24);
        panel.style.width = `${width / scale}px`;
        panel.style.maxHeight = `${Math.max(120, composer.top - 20) / scale}px`;
        const height = panel.getBoundingClientRect().height;
        panel.style.left = `${Math.max(12, main.left + 12, Math.min(anchor.left, main.right - width - 12, innerWidth - width - 12)) / scale}px`;
        panel.style.top = `${Math.max(12, composer.top - height - 10) / scale}px`;
    }

    function updateModelSummary() {
        for (const [kind, summaryId, toggleId, label] of [
            ['Chat', 'teamModelSummary', 'teamModelToggle', '对话'],
            ['Image', 'teamImageModelSummary', 'teamImageModelToggle', '生图'],
        ]) {
            const model = $(`team${kind}Model`);
            const provider = $(`team${kind}Provider`);
            const name = model.value || '未配置';
            $(summaryId).textContent = name;
            $(toggleId).title = `${label}：${name}\n平台：${provider.selectedOptions[0]?.textContent || '未配置'}`;
            model.title = name;
        }
    }

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
    }

    async function api(path, options = {}) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json', ...(options.headers || {})},
            ...options,
        });
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok) {
            const detail = (data && (data.detail || data.code)) || `请求失败（${response.status}）`;
            throw new Error(detail);
        }
        return data;
    }

    function teamVisible() {
        const panel = $('teamPanel');
        return panel && !panel.hidden;
    }

    function botById(botId) {
        return (state.team?.bots || []).find((bot) => bot.id === botId) || null;
    }

    function chatById(chatId) {
        return (state.team?.chats || []).find((chat) => chat.id === chatId) || null;
    }

    function groupForChat(chat) {
        if (!chat || chat.kind !== 'group') return null;
        return (state.team?.groups || []).find((group) => group.id === chat.group_id) || null;
    }

    function messageTime(value) {
        const stamp = Number(value || 0);
        if (!stamp) return '';
        try { return new Date(stamp).toLocaleString('zh-CN', {hour12: false}); }
        catch (error) { return ''; }
    }

    let teamToastTimer = null;
    function teamToast(message, isError) {
        let node = document.querySelector('.team-toast');
        if (!node) {
            node = document.createElement('div');
            node.className = 'team-toast';
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.classList.toggle('error', Boolean(isError));
        node.classList.add('show');
        clearTimeout(teamToastTimer);
        teamToastTimer = setTimeout(() => node.classList.remove('show'), 3200);
    }

    function initials(name) {
        const text = String(name || '').trim();
        return text ? text.slice(0, 1) : '·';
    }

    function renderText(text) {
        let html = esc(text);
        const members = (chatById(state.currentChat)?.members) || [];
        for (const botId of members) {
            const bot = botById(botId);
            if (!bot || !bot.name) continue;
            html = html.split(`@${esc(bot.name)}`).join(`<span class="team-at">@${esc(bot.name)}</span>`);
        }
        return html;
    }

    let avatarSerial = 0;
    function avatar(bot, size = '', live = false) {
        const image = bot?.avatar?.image || '';
        if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
            return `<span class="team-avatar team-photo ${esc(size)}" data-avatar-bot="${esc(bot?.id || '')}" data-live="${live}" data-state="idle" aria-hidden="true"><img src="${esc(image)}" alt=""><i class="team-avatar-state"></i></span>`;
        }
        const shapes = window.DesignBrainCharacters;
        const defaults = {bot_director: 'star', bot_reference: 'bunny', bot_planner: 'moon', bot_executor: 'gumdrop', bot_reviewer: 'kitty'};
        const hash = Array.from(bot?.id || 'bot').reduce((value, ch) => (Math.imul(value, 31) + ch.charCodeAt(0)) >>> 0, 0);
        const options = ['star', 'bunny', 'moon', 'gumdrop', 'kitty', 'acorn', 'peanut'];
        const requested = bot?.avatar?.shape;
        const shape = Object.hasOwn(shapes, requested || '') ? requested : defaults[bot?.id] || options[hash % options.length];
        const character = shapes[shape];
        const color = /^#[0-9a-f]{6}$/i.test(bot?.avatar?.color || '') ? bot.avatar.color : '#2F6F5E';
        const mask = `team-face-${++avatarSerial}`;
        const eyes = character.eyes.map(([x, y, w, h, tilt]) => `<g transform="translate(${x} ${y}) rotate(${tilt})"><rect class="team-eye" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('');
        const paints = (character.paints || []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" opacity="${opacity}"/>`).join('');
        return `<span class="team-avatar team-character ${esc(size)}" data-character="${esc(shape)}" data-avatar-bot="${esc(bot?.id || '')}" data-live="${live}" data-state="idle" aria-hidden="true"><svg viewBox="0 0 100 100" focusable="false"><defs><mask id="${mask}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${eyes}</mask></defs><g class="team-character-body" mask="url(#${mask})" fill-rule="evenodd"><path d="${character.body}" fill="${color}"/>${paints}<path d="${character.shade}" fill="#000" opacity=".14"/><path d="${character.light}" fill="#fff" opacity=".16"/></g></svg><i class="team-avatar-state"></i></span>`;
    }

    function groupAvatar(group) {
        return `<span class="team-avatar team-group-avatar" aria-hidden="true">${(group.members || []).slice(0, 4).map(id => avatar(botById(id))).join('')}</span>`;
    }

    function chatTasks() {
        const ids = new Set(state.messages.map(message => message.task_id).filter(Boolean));
        for (const id of groupForChat(chatById(state.currentChat))?.project?.task_ids || []) ids.add(id);
        return state.tasks.filter(task => ids.has(task.id));
    }

    function renderWorkStatus() {
        const progress = window.DesignBrainProgress;
        const tasks = chatTasks();
        const work = new Map();
        for (const task of tasks) {
            const view = progress.activity(task);
            if (view.active || view.motion === 'waiting') {
                work.set(view.botId, {...view, label: view.detail ? `${view.label} · ${view.detail}` : view.label});
            }
        }
        if (state.turn.running) {
            const botId = state.turn.bot_id || chatById(state.currentChat)?.bot_id || groupForChat(chatById(state.currentChat))?.admin_bot_id;
            work.set(botId, {motion: state.turn.activity || 'thinking', label: state.turn.activity_label || '正在思考', since: state.turn.started_at});
        }
        if (state.workReady) {
            work.clear();
            const entries = [...state.work].sort((a, b) =>
                Number(b.chat_id === state.currentChat) - Number(a.chat_id === state.currentChat)
                || Number(a.activity === 'waiting') - Number(b.activity === 'waiting'));
            for (const entry of entries) {
                if (work.has(entry.bot_id)) continue;
                const count = entries.filter(item => item.bot_id === entry.bot_id).length;
                const where = entry.chat_id === state.currentChat ? '' : `在「${entry.chat_title}」· `;
                work.set(entry.bot_id, {motion: entry.activity, label: `${where}${entry.activity_label}${count > 1 ? ` · 共 ${count} 项` : ''}`});
            }
        }
        document.querySelectorAll('[data-avatar-bot][data-live="true"]').forEach(node => {
            node.dataset.state = work.get(node.dataset.avatarBot)?.motion || 'idle';
        });
        document.querySelectorAll('#teamBotList [data-team-bot]').forEach(node => {
            const bot = botById(node.dataset.teamBot);
            const doing = work.get(bot?.id);
            const line = node.querySelector('small');
            line.textContent = doing?.label || bot?.role || '';
            line.title = line.textContent;
            node.classList.toggle('is-working', Boolean(doing && doing.motion !== 'waiting'));
        });
        document.querySelectorAll('#teamGroupList [data-team-group]').forEach(node => {
            const entries = state.work.filter(item => item.chat_id === node.dataset.teamGroup);
            const active = entries.filter(item => item.activity !== 'waiting');
            node.querySelectorAll('[data-avatar-bot]').forEach(face => {
                face.dataset.state = entries.find(item => item.bot_id === face.dataset.avatarBot)?.activity || 'idle';
            });
            let badge = node.querySelector('.team-group-work-count');
            if (active.length && !badge) {
                badge = document.createElement('span');
                badge.className = 'team-group-work-count';
                node.appendChild(badge);
            }
            if (badge) { badge.textContent = active.length ? String(active.length) : ''; badge.hidden = !active.length; badge.title = `${active.length} 项工作进行中`; }
        });
        renderGlobalWork();
        const box = $('teamWorkStatus');
        const ongoing = tasks.filter(task => !['delivered', 'failed', 'cancelled'].includes(task.status));
        const rows = [];
        if (state.turn.running) {
            const bot = botById(state.turn.bot_id);
            rows.push(`<div class="team-work-row">${avatar(bot)}<div class="team-work-copy" role="status"><strong>${esc(state.turn.bot_name || bot?.name || '团队')} · ${esc(state.turn.activity_label || '正在思考')}</strong><small>已用时 <span data-work-since="${Number(state.turn.started_at) || 0}">${progress.elapsed(state.turn.started_at)}</span>${state.turnStale ? ' · 连接中断，正在重试' : ''}</small></div></div>`);
        }
        for (const task of ongoing) {
            const view = progress.activity(task);
            rows.push(`<button type="button" class="team-work-row" data-team-open-studio="${esc(task.id)}" aria-label="${esc(task.title)} · ${esc(view.label)}">${avatar(botById(view.botId))}<span class="team-work-copy"><strong>${esc(task.title || '设计任务')}</strong>${progress.markup(task)}${view.active ? `<small>已用时 <span data-work-since="${Number(view.since) || 0}">${progress.elapsed(view.since)}</span></small>` : ''}</span><span class="team-work-open" aria-hidden="true">›</span></button>`);
        }
        const members = chatById(state.currentChat)?.members || [];
        const elsewhere = state.work.filter(entry => entry.chat_id !== state.currentChat && members.includes(entry.bot_id));
        for (const entry of elsewhere) {
            rows.push(`<div class="team-work-row team-cross-work"><button type="button" class="team-work-link" data-team-go-work="${esc(entry.id)}">${avatar(botById(entry.bot_id))}<span class="team-work-copy"><strong>${esc(entry.bot_name)} · ${esc(entry.activity_label)}</strong><small>在${esc(workLocation(entry))} · <span data-work-since="${Number(entry.started_at) || 0}">${progress.elapsed(entry.started_at)}</span></small></span></button>${stopWorkButton(entry)}</div>`);
        }
        if (elsewhere.length && state.workStale) rows.push('<small class="team-progress-stale" role="status">跨群工作状态连接中断，正在重试 · 显示上次状态</small>');
        if (ongoing.length && state.progressStale) rows.push('<small class="team-progress-stale" role="status">进度连接中断，正在重试 · 上次状态已保留</small>');
        const signature = JSON.stringify([state.currentChat, state.turn, state.turnStale, state.progressStale, state.workStale, elsewhere, [...state.stoppingWork],
            ongoing.map(task => [task.id, task.title, task.status, progress.activity(task)])]);
        if (box.dataset.signature !== signature) {
            box.innerHTML = rows.join('');
            box.dataset.signature = signature;
        }
        box.hidden = !rows.length;
        box.querySelectorAll('[data-avatar-bot]').forEach(node => { node.dataset.state = work.get(node.dataset.avatarBot)?.motion || 'idle'; });
        document.querySelectorAll('[data-team-task-progress]').forEach(node => {
            const task = state.tasks.find(task => task.id === node.dataset.teamTaskProgress);
            if (task) {
                const html = progress.markup(task);
                if (node.dataset.markup !== html) { node.innerHTML = html; node.dataset.markup = html; }
            }
        });
    }

    function workLocation(entry) {
        return `${entry.chat_kind === 'dm' ? '私聊' : '项目群'}「${entry.chat_title}」`;
    }

    function stopWorkButton(entry) {
        if (!entry.cancellable) return '';
        const stopping = state.stoppingWork.has(entry.id);
        return `<button type="button" class="team-member-stop subtle-button" data-team-stop-work="${esc(entry.id)}" title="${esc(entry.stop_note || '仅停止此项工作')}" aria-label="停止${esc(entry.bot_name)}在${esc(entry.chat_title)}的${esc(entry.activity_label)}" ${stopping ? 'disabled' : ''}>${stopping ? '停止中…' : '停止'}</button>`;
    }

    function renderGlobalWork() {
        const box = $('teamGlobalWork');
        const count = state.work.length;
        $('teamWorkCount').textContent = count ? ` ${count}` : '';
        $('teamWorkToggle').title = state.workStale ? '工作状态连接中断，正在重试' : '查看所有项目群与私聊中的工作';
        const rows = state.work.map(entry => `<div class="team-global-work-row"><button type="button" class="team-work-link" data-team-go-work="${esc(entry.id)}">${avatar(botById(entry.bot_id))}<span><strong>${esc(entry.bot_name)} · ${esc(entry.activity_label)}</strong><small>${esc(workLocation(entry))}</small><small data-work-since="${Number(entry.started_at) || 0}">${window.DesignBrainProgress.elapsed(entry.started_at)}</small></span></button>${stopWorkButton(entry)}${entry.stop_note ? `<small class="team-stop-note">${esc(entry.stop_note)}</small>` : ''}</div>`).join('');
        const notice = state.workStale ? '<p class="team-progress-stale" role="status">工作状态连接中断，正在重试；显示上次状态。</p>'
            : !state.workReady ? '<p class="muted">正在读取工作状态…</p>' : !count ? '<p class="muted">当前没有进行中的工作。</p>' : '';
        const html = `<h4>团队工作 · ${count} 项</h4>${notice}${rows}`;
        const signature = JSON.stringify([state.work, state.workStale, state.workReady, [...state.stoppingWork]]);
        if (box.dataset.signature !== signature) { box.innerHTML = html; box.dataset.signature = signature; }
        document.querySelectorAll('[data-member-work]').forEach(node => {
            const entries = state.work.filter(item => item.bot_id === node.dataset.memberWork);
            const key = JSON.stringify([entries, [...state.stoppingWork]]);
            if (node.dataset.signature === key) return;
            node.innerHTML = entries.map(entry => `<div class="team-member-work-row"><button type="button" class="team-work-link" data-team-go-work="${esc(entry.id)}" title="${esc(workLocation(entry))}">${esc(entry.chat_id === state.currentChat ? '本会话' : workLocation(entry))} · ${esc(entry.activity_label)}</button>${stopWorkButton(entry)}</div>`).join('') || '<small class="muted">空闲</small>';
            node.dataset.signature = key;
        });
    }

    async function pollWork() {
        if (state.workBusy || !teamVisible()) return;
        state.workBusy = true;
        try {
            const data = await api('/api/design-brain/team/work', {signal: AbortSignal.timeout(10000)});
            state.work = data.work || [];
            state.workReady = true;
            state.workStale = false;
        } catch (error) {
            state.workStale = true;
        } finally {
            state.workBusy = false;
            renderWorkStatus();
        }
    }

    async function stopMemberWork(workId) {
        if (state.stoppingWork.has(workId)) return;
        state.stoppingWork.add(workId);
        renderWorkStatus();
        try {
            const result = await api('/api/design-brain/team/work/stop', {method: 'POST', body: JSON.stringify({work_id: workId}), signal: AbortSignal.timeout(30000)});
            if (!result.stopped) throw new Error('工作尚未停止，请刷新状态后重试');
            state.work = state.work.filter(item => item.id !== workId);
            document.dispatchEvent(new CustomEvent('design-brain-tasks-changed'));
            await Promise.all([pollWork(), pollTurn(), pollMessages()]);
        } catch (error) {
            teamToast(error.name === 'TimeoutError' ? '停止请求超时，请查看最新工作状态后重试' : error.message || '停止失败，请重试', true);
        } finally {
            state.stoppingWork.delete(workId);
            renderWorkStatus();
        }
    }

    /* ---------------- 侧栏 ---------------- */

    function renderSidebar() {
        const bots = state.team?.bots || [];
        $('teamBotList').innerHTML = bots.map((bot) => {
            const chatId = `dm_${bot.id}`;
            const active = state.currentChat === chatId;
            return `<button class="team-side-item${active ? ' active' : ''}" type="button" data-team-chat="${esc(chatId)}" data-team-bot="${esc(bot.id)}">
                ${avatar(bot, '', true)}
                <span class="team-side-text">
                    <strong>${esc(bot.name)}${bot.is_main ? '<em>总监</em>' : ''}</strong>
                    <small>${esc(bot.role || '')}</small>
                </span>
            </button>`;
        }).join('') || '<p class="muted team-empty">还没有设计成员</p>';

        const groups = [...(state.team?.groups || [])].sort((a, b) =>
            Number(chatById(b.id)?.last_message_at || b.updated_at || 0) - Number(chatById(a.id)?.last_message_at || a.updated_at || 0));
        $('teamGroupList').innerHTML = groups.map((group) => {
            const active = state.currentChat === group.id;
            return `<button class="team-side-item${active ? ' active' : ''}" type="button" data-team-chat="${esc(group.id)}" data-team-group="${esc(group.id)}" title="${esc(group.name)}" ${active ? 'aria-current="true"' : ''}>
                ${groupAvatar(group)}
                <span class="team-side-text">
                    <strong>${esc(group.name)}</strong>
                    <small>${group.members.length} 位成员协作</small>
                </span>
            </button>`;
        }).join('') || '<p class="muted team-empty">开始一次设计，讨论会留在这里。</p>';
        renderWorkStatus();
    }

    /* ---------------- 会话 ---------------- */

    async function openChat(chatId) {
        if (!chatId) return;
        if (chatId !== state.currentChat) document.dispatchEvent(new CustomEvent('design-brain-workspace-close'));
        if (state.currentChat) state.drafts.set(state.currentChat, {text: $('teamInput').value, images: [...state.productImages]});
        state.uploadController?.abort();
        const draft = state.drafts.get(chatId);
        $('teamInput').value = draft?.text || '';
        state.productImages = [...(draft?.images || [])];
        renderProductImages();
        hideMentionMenu();
        state.currentChat = chatId;
        state.running = false;
        state.turn = {};
        state.turnStale = false;
        $('teamTurnStatus').textContent = '';
        $('teamStop').hidden = true;
        state.messages = [];
        state.cursor = 0;
        localStorage.setItem(STORAGE_CHAT, chatId);
        renderSidebar();
        const chat = chatById(chatId);
        renderHeader(chat);
        renderSide(chat);
        applyChatModels(chat);
        refreshMemoryCount(chat);
        $('teamMessages').innerHTML = '<p class="muted team-empty">正在读取消息…</p>';
        setWelcome(false);
        syncComposer();
        try {
            const data = await api(`/api/design-brain/chats/${encodeURIComponent(chatId)}/messages?after=0&limit=200`);
            if (state.currentChat !== chatId) return;
            state.messages = data.messages || [];
            state.cursor = data.cursor || 0;
            renderMessages();
            renderWorkStatus();
        } catch (error) {
            if (state.currentChat !== chatId) return;
            document.querySelector('.team-main').classList.remove('is-loading');
            $('teamMessages').innerHTML = `<p class="muted team-empty">读取失败：${esc(error.message)}</p>`;
        }
        startPolling();
    }

    function renderHeader(chat) {
        if (!chat) {
            $('teamTitle').textContent = '设计讨论';
            $('teamSubtitle').textContent = '从一个想法开始，和团队一起完成设计。';
            return;
        }
        const group = groupForChat(chat);
        $('teamTitle').textContent = group ? group.name : (botById(chat.bot_id)?.name || chat.title);
        const names = (chat.members || []).map((id) => botById(id)?.name || id).join(' · ');
        $('teamSubtitle').textContent = group
            ? (group.notice || `${(chat.members || []).length} 位成员协作 · 总监帮你推进设计`)
            : (botById(chat.bot_id)?.role || '');
        $('teamSubtitle').title = group?.notice || names;
    }

    function resultCard(message, bot) {
        const images = (message.meta && Array.isArray(message.meta.images)) ? message.meta.images : [];
        const thumbs = images.map((url, index) => `
            <button class="team-card-image" type="button" data-team-preview="${esc(url)}" title="查看大图">
                <img src="${esc(url)}" alt="生成结果 ${index + 1}" loading="lazy">
            </button>`).join('');
        const taskButton = message.task_id
            ? `<button class="subtle-button" type="button" data-team-open-studio="${esc(message.task_id)}">查看方案与成图</button>`
            : '';
        return `<div class="team-row bot">
            ${avatar(bot)}
            <div class="team-card">
                <strong>${esc(bot?.name || 'Bot')} · ${message.task_id ? '设计任务' : '生成结果'}</strong>
                <p>${renderText(message.text)}</p>
                ${thumbs ? `<div class="team-card-images">${thumbs}</div>` : ''}
                ${message.task_id ? `<div data-team-task-progress="${esc(message.task_id)}"></div>` : ''}
                ${taskButton}
            </div>
        </div>`;
    }

    function renderMessages() {
        document.querySelector('.team-main').classList.remove('is-loading');
        const box = $('teamMessages');
        setWelcome(!state.messages.length);
        if (!state.messages.length) {
            const chat = chatById(state.currentChat);
            const group = groupForChat(chat);
            const name = group ? '设计团队' : (botById(chat?.bot_id)?.name || '设计总监');
            box.innerHTML = `<div class="team-guide">
                <div class="team-welcome-faces" aria-hidden="true">${(group ? group.members.slice(0, 3).map(id => botById(id)) : [botById(chat?.bot_id)]).map(bot => avatar(bot)).join('')}</div>
                <h3>${group ? '今天，想做点什么？' : `和${esc(name)}聊聊你的想法`}</h3>
                <p class="muted">${group ? '放一张参考图，或说一个想法。一起把方向变成作品。' : esc(botById(chat?.bot_id)?.role || '说说你正在做的设计，一起把想法推进一步。')}</p>
                <div class="team-guide-actions">
                    <button class="subtle-button" type="button" data-team-example="我想给商品做一套主图，先帮我梳理卖点和视觉方向，暂时不要生成图片。"><i data-lucide="scan-line"></i>推敲主图方向</button>
                    <button class="subtle-button" type="button" data-team-example="帮我从参考库里找适合当前商品的设计案例，说说可以借鉴什么。"><i data-lucide="images"></i>找设计参考</button>
                    <button class="subtle-button" type="button" data-team-example="我想调整现有设计，先和我确认需要保留的元素，以及希望改变的风格，暂时不要生成图片。"><i data-lucide="pencil-ruler"></i>试试新风格</button>
                </div>
            </div>`;
            window.lucide?.createIcons({attrs: {'stroke-width': 1.6}});
            return;
        }
        box.innerHTML = state.messages.map((message) => {
            if (message.role === 'system' || message.kind === 'activity') {
                return activityMessage(message);
            }
            if (message.role === 'user') {
                return `<div class="team-row user">
                    <div class="team-bubble" title="${esc(messageTime(message.at))}">${renderText(message.text)}${messageImages(message)}</div>
                    <span class="team-avatar me">你</span>
                </div>`;
            }
            const bot = botById(message.bot_id);
            if (message.kind === 'approval') return approvalCard(message, bot);
            if (message.kind === 'result') return resultCard(message, bot);
            return `<div class="team-row bot">
                ${avatar(bot)}
                <div class="team-bubble-wrap">
                    <span class="team-name">${esc(bot?.name || message.bot_id)}</span>
                    <div class="team-bubble" title="${esc(messageTime(message.at))}">${renderText(message.text)}</div>
                </div>
            </div>`;
        }).join('');
        updateRetryButtons();
        renderWorkStatus();
        box.scrollTop = box.scrollHeight;
    }

    function isRetryable(message) {
        if (message.meta?.retryable !== undefined) return message.meta.retryable === true;
        // 已保存的失败消息没有结构化标记，仍提供重发入口。
        return /^(?:「[^」]+」(?:调用工具失败：|还没有选择模型)|回合执行失败：|模型调用失败：|模型响应超时)/.test(message.text || '');
    }

    function retrySource(message) {
        if (message.meta?.retry_message_id) {
            return state.messages.find(item => item.role === 'user' && item.id === message.meta.retry_message_id);
        }
        const index = state.messages.indexOf(message);
        return state.messages.slice(0, index).reverse().find(item => item.role === 'user');
    }

    function activityMessage(message) {
        const failed = isRetryable(message);
        const retry = failed && retrySource(message);
        return `<div class="team-activity${failed ? ' team-activity-error' : ''}"><span>${esc(message.text)}</span>${retry ? `<button class="subtle-button team-retry" type="button" data-team-retry="${esc(message.id)}" title="使用原消息的文字、图片和当前模型重新发送">重新发送</button>` : ''}</div>`;
    }

    function updateRetryButtons() {
        $('teamMessages').querySelectorAll('[data-team-retry]').forEach(button => {
            button.disabled = state.sending || state.running || Boolean(state.uploadController);
        });
    }

    function appendMessages(items) {
        if (!items.length) return;
        if (items.some((item) => item.task_id)) document.dispatchEvent(new CustomEvent('design-brain-tasks-changed'));
        const box = $('teamMessages');
        setWelcome(false);
        if (!state.messages.length) box.innerHTML = '';
        state.messages.push(...items);
        state.cursor = items[items.length - 1].seq;
        const html = items.map((message) => {
            if (message.role === 'system' || message.kind === 'activity') {
                return activityMessage(message);
            }
            if (message.role === 'user') {
                return `<div class="team-row user"><div class="team-bubble" title="${esc(messageTime(message.at))}">${renderText(message.text)}${messageImages(message)}</div><span class="team-avatar me">你</span></div>`;
            }
            const bot = botById(message.bot_id);
            if (message.kind === 'approval') return approvalCard(message, bot);
            if (message.kind === 'result') return resultCard(message, bot);
            return `<div class="team-row bot">${avatar(bot)}<div class="team-bubble-wrap"><span class="team-name">${esc(bot?.name || message.bot_id)}</span><div class="team-bubble" title="${esc(messageTime(message.at))}">${renderText(message.text)}</div></div></div>`;
        }).join('');
        box.insertAdjacentHTML('beforeend', html);
        updateRetryButtons();
        renderWorkStatus();
        box.scrollTop = box.scrollHeight;
    }

    function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(pollMessages, 1500);
        state.statusTimer = setInterval(() => { pollTurn(); pollWork(); }, 1200);
        pollTurn();
        pollWork();
    }

    function stopPolling() {
        if (state.pollTimer) clearInterval(state.pollTimer);
        if (state.statusTimer) clearInterval(state.statusTimer);
        state.pollTimer = null;
        state.statusTimer = null;
    }

    async function pollMessages() {
        if (!state.currentChat || !teamVisible()) return;
        const chatId = state.currentChat;
        try {
            const data = await api(`/api/design-brain/chats/${encodeURIComponent(chatId)}/messages?after=${state.cursor}&limit=100`);
            if (state.currentChat !== chatId) return;
            appendMessages((data.messages || []).filter((item) => item.seq > state.cursor));
            const chat = data.chat;
            const known = chatById(chat.id);
            if (known) Object.assign(known, chat);
            $('teamPausedBar').hidden = !chat.paused;
        } catch (error) {
            /* 轮询失败不打断输入，下一次继续 */
        }
    }

    async function pollTurn() {
        if (!state.currentChat || state.statusBusy) return;
        const chatId = state.currentChat;
        state.statusBusy = true;
        try {
            const data = await api(`/api/design-brain/chats/${encodeURIComponent(chatId)}/turn`);
            if (state.currentChat !== chatId) return;
            state.running = Boolean(data.running);
            state.turn = data;
            state.turnStale = false;
            updateRetryButtons();
            $('teamStop').hidden = !data.running;
            $('teamTurnStatus').textContent = data.running
                ? `${data.bot_name || '团队'} · ${data.activity_label || '正在思考'}`
                : '';
            $('teamMessages').classList.toggle('working', Boolean(data.running));
            renderWorkStatus();
        } catch (error) {
            if (state.currentChat === chatId) { state.turnStale = true; renderWorkStatus(); }
        } finally {
            state.statusBusy = false;
        }
    }

    /* ---------------- 发送 ---------------- */

    function messageImages(message) {
        const images = (message.meta?.product_images || []).filter((url) => typeof url === 'string');
        return images.length ? `<div class="team-card-images">${images.map((url) => `<button class="team-card-image" type="button" data-team-preview="${esc(url)}" aria-label="查看商品图"><img src="${esc(url)}" alt="商品图" loading="lazy"></button>`).join('')}</div>` : '';
    }

    function renderProductImages() {
        $('teamProductImages').innerHTML = state.productImages.map((url, index) => `<span class="studio-thumb"><img src="${esc(url)}" alt="商品图"><button type="button" data-team-remove-product="${index}" aria-label="移除商品图">×</button></span>`).join('');
    }

    async function uploadProducts(files) {
        if (state.sending || state.uploadController || !files.length) return;
        const selected = Array.from(files).filter((file) => file.type.startsWith('image/'));
        if (!selected.length) return;
        const controller = new AbortController();
        const chatId = state.currentChat;
        state.uploadController = controller;
        updateRetryButtons();
        $('teamUploadProduct').disabled = true;
        $('teamSend').disabled = true;
        let added = 0;
        try {
            for (const [index, file] of selected.entries()) {
                $('teamSendStatus').textContent = `正在上传商品图 ${index + 1}/${selected.length}…`;
                const form = new FormData();
                form.append('files', file);
                const response = await fetch('/api/ai/upload', {method: 'POST', credentials: 'same-origin', body: form, signal: controller.signal});
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.files?.[0]?.url) throw new Error(data.detail || `${file.name} 上传失败，请重试`);
                if (controller.signal.aborted || chatId !== state.currentChat) return;
                const url = data.files[0].url;
                if (!state.productImages.includes(url)) { state.productImages.push(url); added += 1; }
                renderProductImages();
            }
            document.dispatchEvent(new CustomEvent('design-brain-images-uploaded'));
            $('teamSendStatus').textContent = `已添加 ${added} 张商品图`;
        } catch (error) {
            if (!controller.signal.aborted) {
                $('teamSendStatus').textContent = `上传未完成：${error.message}；已添加的图片会保留`;
                teamToast(error.message, true);
            }
        } finally {
            if (state.uploadController === controller) {
                state.uploadController = null;
                updateRetryButtons();
                $('teamUploadProduct').disabled = false;
                syncComposer();
                if (controller.signal.aborted) $('teamSendStatus').textContent = '';
            }
        }
    }

    function resolveMentions(text) {
        const members = (chatById(state.currentChat)?.members) || [];
        if (/@(所有人|全体|all|everyone)/i.test(text)) return members.slice();
        const picked = [];
        for (const botId of members) {
            const bot = botById(botId);
            if (bot && text.includes(`@${bot.name}`)) picked.push(botId);
        }
        return picked;
    }

    async function sendMessage(retryMessage = null) {
        if (state.sending || state.uploadController) return;
        if (retryMessage && state.running) return;
        const input = $('teamInput');
        const text = retryMessage ? retryMessage.text : input.value.trim();
        const meta = retryMessage ? {...retryMessage.meta} : {product_images: [...state.productImages], skill_id: window.StudioSharedSkill?.getSelected() || ''};
        if (!text && !(meta.product_images || []).length) return;
        if (!state.currentChat) { $('teamSendStatus').textContent = '先选择会话'; return; }
        const models = collectModels();
        if (!models) { toggleModels(true); teamToast('请先选择对话平台和模型', true); return; }
        if (models) localStorage.setItem(STORAGE_MODELS, JSON.stringify(models));
        const chatId = state.currentChat;
        state.sending = true;
        updateRetryButtons();
        $('teamSend').disabled = true;
        $('teamUploadProduct').disabled = true;
        $('teamAddProductImage').disabled = true;
        if (!retryMessage) {
            input.value = '';
            syncComposer();
            state.productImages = [];
            renderProductImages();
            hideMentionMenu();
        }
        $('teamSendStatus').textContent = retryMessage ? '重新发送中…' : '发送中…';
        try {
            const result = await api(`/api/design-brain/chats/${encodeURIComponent(chatId)}/messages`, {
                method: 'POST',
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({text, mentions: retryMessage ? retryMessage.mentions : resolveMentions(text), models, meta}),
            });
            if (state.currentChat !== chatId) return;
            state.running = Boolean(result.turn?.queued || result.turn?.running);
            $('teamSendStatus').textContent = '';
            $('teamPausedBar').hidden = true;
            pollMessages();
            pollTurn();
        } catch (error) {
            if (!retryMessage) {
                if (state.currentChat === chatId) {
                    input.value = [text, input.value].filter(Boolean).join('\n');
                    state.productImages = [...new Set([...(meta.product_images || []), ...state.productImages])];
                    renderProductImages();
                }
                else {
                    const draft = state.drafts.get(chatId) || {text: '', images: meta.product_images || []};
                    state.drafts.set(chatId, {text: [text, draft.text].filter(Boolean).join('\n'),
                        images: [...new Set([...(meta.product_images || []), ...(draft.images || [])])]});
                }
            }
            if (state.currentChat === chatId) $('teamSendStatus').textContent = `${retryMessage ? '重新发送失败' : '发送失败'}：${error.message}；${retryMessage ? '可再次点击“重新发送”' : '内容已保留，请再次点击“发送”'}`;
            teamToast(error.message, true);
        } finally {
            state.sending = false;
            updateRetryButtons();
            syncComposer();
            $('teamUploadProduct').disabled = false;
            $('teamAddProductImage').disabled = false;
        }
    }

    /* ---------------- @ 菜单 ---------------- */

    function mentionContext() {
        const input = $('teamInput');
        const before = input.value.slice(0, input.selectionStart);
        const match = before.match(/@([^\s@]*)$/);
        return match ? {query: match[1], start: before.length - match[0].length} : null;
    }

    function updateMentionMenu() {
        const context = mentionContext();
        const menu = $('teamMentionMenu');
        if (!context) { hideMentionMenu(); return; }
        const members = (chatById(state.currentChat)?.members) || [];
        const query = context.query.toLowerCase();
        state.mentionItems = members
            .map((id) => botById(id))
            .filter((bot) => bot && (!query || bot.name.toLowerCase().includes(query)));
        state.mentionIndex = 0;
        if (!state.mentionItems.length) { hideMentionMenu(); return; }
        menu.innerHTML = state.mentionItems.map((bot, index) => `
            <button class="team-mention-item${index === 0 ? ' active' : ''}" type="button" data-mention="${esc(bot.id)}">
                ${avatar(bot)}<span>${esc(bot.name)}</span><small>${esc(bot.role || '')}</small>
            </button>`).join('') + '<div class="team-mention-foot">↑↓ 选择 · 回车插入 · Esc 关闭</div>';
        menu.hidden = false;
    }

    function hideMentionMenu() {
        const menu = $('teamMentionMenu');
        if (menu) menu.hidden = true;
        state.mentionItems = [];
    }

    function pickMention(botId) {
        const bot = botById(botId);
        const input = $('teamInput');
        const context = mentionContext();
        if (!bot || !context) return;
        const after = input.value.slice(input.selectionStart);
        input.value = `${input.value.slice(0, context.start)}@${bot.name} ${after}`;
        const caret = context.start + bot.name.length + 2;
        input.setSelectionRange(caret, caret);
        input.focus();
        hideMentionMenu();
    }

    /* ---------------- 模型 ---------------- */

    function providerList(field) {
        return (state.providers || []).filter((provider) => (provider[field] || []).length && provider.enabled !== false);
    }

    function fillProvider(providerSelect, modelSelect, providers, preferred) {
        providerSelect.innerHTML = providers.map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name || provider.id)}</option>`).join('') || '<option value="">（未配置）</option>';
        if (preferred && providers.some((provider) => provider.id === preferred.provider)) providerSelect.value = preferred.provider;
        const current = providers.find((provider) => provider.id === providerSelect.value);
        const models = current ? (current[providerSelect === $('teamChatProvider') ? 'chat_models' : 'image_models'] || []) : [];
        modelSelect.innerHTML = models.map((model) => `<option value="${esc(model)}">${esc(model)}</option>`).join('') || '<option value="">（无模型）</option>';
        if (preferred && models.includes(preferred.model)) modelSelect.value = preferred.model;
    }

    async function setupModels() {
        try {
            const data = await api('/api/providers');
            state.providers = data.providers || [];
        } catch (error) {
            state.providers = [];
        }
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(STORAGE_MODELS) || '{}'); } catch (error) { saved = {}; }
        if (!saved.chat) {
            try {
                const previous = JSON.parse(localStorage.getItem('xiaomei_design_studio_v1') || '{}');
                saved = {chat: {provider: previous.chatProvider, model: previous.chatModel}, image: {provider: previous.imageProvider, model: previous.imageModel}};
            } catch (error) { /* 使用平台返回的可选模型 */ }
        }
        fillProvider($('teamChatProvider'), $('teamChatModel'), providerList('chat_models'), saved.chat);
        fillProvider($('teamImageProvider'), $('teamImageModel'), providerList('image_models'), saved.image);
        $('teamChatProvider').onchange = () => { fillProvider($('teamChatProvider'), $('teamChatModel'), providerList('chat_models'), {provider: $('teamChatProvider').value}); persistModels(); };
        $('teamImageProvider').onchange = () => { fillProvider($('teamImageProvider'), $('teamImageModel'), providerList('image_models'), {provider: $('teamImageProvider').value}); persistModels(); };
        $('teamChatModel').onchange = persistModels;
        $('teamImageModel').onchange = persistModels;
        updateModelSummary();
        if (!$('teamChatModel').value) toggleModels(true);
    }

    function collectModels() {
        const chatProvider = $('teamChatProvider').value;
        const chatModel = $('teamChatModel').value;
        const imageProvider = $('teamImageProvider').value;
        const imageModel = $('teamImageModel').value;
        if (!chatProvider || !chatModel) return null;
        return {
            chat: {provider: chatProvider, model: chatModel},
            vision: {provider: chatProvider, model: chatModel},
            image: imageProvider && imageModel ? {provider: imageProvider, model: imageModel} : {},
        };
    }

    function persistModels() {
        const models = collectModels();
        if (models) localStorage.setItem(STORAGE_MODELS, JSON.stringify(models));
        updateModelSummary();
    }

    function applyChatModels(chat) {
        if (!chat || !chat.defaults) return;
        if (chat.defaults.chat && chat.defaults.chat.provider) {
            fillProvider($('teamChatProvider'), $('teamChatModel'), providerList('chat_models'), chat.defaults.chat);
        }
        if (chat.defaults.image && chat.defaults.image.provider) {
            fillProvider($('teamImageProvider'), $('teamImageModel'), providerList('image_models'), chat.defaults.image);
        }
        updateModelSummary();
    }

    /* ---------------- 右侧信息与编辑 ---------------- */

    function renderSide(chat) {
        $('teamInspectorTitle').textContent = '项目与团队';
        $('teamGlobalWork').hidden = false;
        const body = $('teamSideBody');
        if (!chat) { body.innerHTML = '<h3>会话信息</h3><p class="muted">选择会话后显示成员与设置。</p>'; return; }
        const group = groupForChat(chat);
        if (group) {
            body.innerHTML = `
                <h3>${esc(group.name)}</h3>
                <p class="muted">${esc(group.notice || '可以在项目设置中补充设计要求，让团队记住你的偏好。')}</p>
                <div class="team-side-block"><span>协作方式</span><strong>${group.reply_mode === 'round_robin' ? '全员轮流' : '负责人先梳理'}</strong></div>
                <div class="team-side-block"><span>最多讨论</span><strong>${group.relay_limit} 轮</strong></div>
                <h4>成员</h4>
                <div class="team-members">${group.members.map((id) => {
                    const bot = botById(id);
                    return `<div class="team-member">${avatar(bot, '', true)}<div class="team-member-info"><div class="team-member-name">${esc(bot?.name || id)}${group.admin_bot_id === id ? '<em>负责人</em>' : ''}</div>${bot?.task ? `<small class="team-member-task">${esc(bot.task)}</small>` : ''}<div data-member-work="${esc(id)}"></div></div><button type="button" class="subtle-button team-member-edit" data-team-edit-bot="${esc(id)}" aria-label="编辑${esc(bot?.name || id)}">编辑</button></div>`;
                }).join('')}</div>
                <h4>记忆</h4>
                <div class="team-side-block"><span>项目记忆</span><strong id="teamMemCount">…</strong></div>
                <button class="subtle-button wide" type="button" data-team-memory="group">管理记忆</button>
                <label class="team-toggle"><input id="teamMemoryReview" type="checkbox"> 每轮自动整理记忆</label>
                <button class="subtle-button wide" type="button" data-team-edit-group="${esc(group.id)}">编辑项目设置</button>`;
            renderWorkStatus();
            return;
        }
        const bot = botById(chat.bot_id);
        if (!bot) { body.innerHTML = '<h3>会话信息</h3>'; return; }
        body.innerHTML = `
            <h3>${esc(bot.name)}${bot.is_main ? ' · 负责人' : ''}</h3>
            <p class="muted">${esc(bot.role || '')}</p>
            <h4>工作状态</h4><div data-member-work="${esc(bot.id)}"></div>
            <div class="team-side-block"><span>模型</span><strong>${esc(bot.model?.model || '跟随会话选择')}</strong></div>
            <div class="team-side-block"><span>权限</span><strong>${esc(({full: '完整权限', workspace: '设计工作区', read: '只读'})[bot.permission] || bot.permission)}</strong></div>
            <h4>能力</h4>
            <div class="team-chips">${(bot.capabilities || []).map((id) => `<span>${esc(CAPABILITY_LABELS[id] || id)}</span>`).join('') || '<span>无</span>'}</div>
            ${bot.personality ? `<details class="team-details" open><summary>人格</summary><pre>${esc(bot.personality)}</pre></details>` : ''}
            ${bot.task ? `<details class="team-details" open><summary>任务</summary><pre>${esc(bot.task)}</pre></details>` : ''}
            ${bot.instructions ? `<details class="team-details"><summary>工作说明</summary><pre>${esc(bot.instructions)}</pre></details>` : ''}
            <h4>记忆</h4>
            <div class="team-side-block"><span>成员记忆</span><strong id="teamMemCount">…</strong></div>
            <button class="subtle-button wide" type="button" data-team-memory="bot">管理记忆</button>
            <label class="team-toggle"><input id="teamMemoryReview" type="checkbox"> 每轮自动整理记忆</label>
            <button class="subtle-button wide" type="button" data-team-edit-bot="${esc(bot.id)}">编辑成员</button>`;
        renderWorkStatus();
    }

    async function prepareAvatar(file) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 头像');
        if (file.size > 10 * 1024 * 1024) throw new Error('头像图片超过 10 MB，请选择较小的图片');
        const url = URL.createObjectURL(file);
        try {
            const picture = new Image();
            picture.src = url;
            await picture.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const edge = Math.min(picture.naturalWidth, picture.naturalHeight);
            if (!edge) throw new Error('empty image');
            canvas.getContext('2d').drawImage(picture, (picture.naturalWidth - edge) / 2, (picture.naturalHeight - edge) / 2, edge, edge, 0, 0, 256, 256);
            return canvas.toDataURL('image/webp', 0.9);
        } catch (_) {
            throw new Error('无法读取这张头像，请重新选择 PNG、JPEG 或 WebP 图片');
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function openBotForm(bot) {
        toggleInspector(true);
        $('teamGlobalWork').hidden = true;
        const editing = Boolean(bot);
        $('teamInspectorTitle').textContent = editing ? '编辑设计成员' : '添加设计成员';
        const model = bot?.model || {};
        const body = $('teamSideBody');
        const botAvatar = {...(bot?.avatar || {})};
        const shapeLabels = {star: '星星', bunny: '兔子', moon: '月亮', gumdrop: '软糖', kitty: '小猫', acorn: '橡果', peanut: '花生'};
        let saving = false;
        let readingAvatar = false;
        body.innerHTML = `
            <div class="team-field"><span>头像</span>
                <div class="team-avatar-editor"><span id="teamBotAvatarPreview">${avatar(bot)}</span><div><button class="subtle-button" type="button" id="teamBotAvatarUpload">上传图片</button><button class="subtle-button" type="button" id="teamBotAvatarReset" ${botAvatar.image ? '' : 'hidden'}>使用小人</button><small>图片居中裁成正方形</small></div></div>
                <input type="file" id="teamBotAvatarFile" accept="image/png,image/jpeg,image/webp" hidden>
                <div class="team-avatar-choices" role="group" aria-label="小人造型">${Object.entries(shapeLabels).map(([shape, label]) => `<button type="button" class="team-avatar-choice" data-avatar-shape="${shape}" aria-label="${label}">${avatar({id: bot?.id || '', avatar: {...botAvatar, shape, image: ''}})}</button>`).join('')}</div>
                <label class="team-avatar-color">小人颜色<input type="color" id="teamBotAvatarColor" value="${/^#[0-9a-f]{6}$/i.test(botAvatar.color || '') ? botAvatar.color : '#2F6F5E'}"></label>
            </div>
            <label class="team-field"><span>名字</span><input id="teamBotName" maxlength="40" value="${esc(bot?.name || '')}" placeholder="例如：品牌文案"></label>
            <label class="team-field"><span>角色</span><input id="teamBotRole" maxlength="200" value="${esc(bot?.role || '')}" placeholder="一句话说明它负责什么"></label>
            <label class="team-field"><span>人格</span><textarea id="teamBotPersonality" rows="3" maxlength="2000" placeholder="例如：嘴上挑剔但很热心，喜欢用短句，敢于提出不同意见">${esc(bot?.personality || '')}</textarea></label>
            <label class="team-field"><span>任务</span><textarea id="teamBotTask" rows="3" maxlength="4000" placeholder="例如：为每个方案找出一个问题，再给出可执行的改法">${esc(bot?.task || '')}</textarea></label>
            <details class="team-details" ${bot?.instructions ? 'open' : ''}><summary>工作说明</summary><label class="team-field"><textarea id="teamBotInstructions" aria-label="工作说明" rows="4" maxlength="4000" placeholder="补充工作方法、交付要求和约束">${esc(bot?.instructions || '')}</textarea></label></details>
            <label class="team-field"><span>对话模型</span>
                <select id="teamBotProvider"></select>
                <select id="teamBotModel"></select>
            </label>
            <div class="team-field"><span>能力</span><div class="team-checks">${Object.entries(CAPABILITY_LABELS).map(([id, label]) => `
                <label><input type="checkbox" value="${esc(id)}" ${bot?.capabilities?.includes(id) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div></div>
            <div class="team-form-actions">
                <button class="primary-button" type="button" id="teamBotSave">保存</button>
                <button class="subtle-button" type="button" id="teamBotCancel">取消</button>
                <span id="teamBotStatus" class="profile-status" role="status" aria-live="polite"></span>
            </div>`;
        const saveButton = $('teamBotSave');
        const status = $('teamBotStatus');
        const refreshAvatar = () => {
            if (!$('teamBotAvatarPreview')) return;
            $('teamBotAvatarPreview').innerHTML = avatar({id: bot?.id || '', avatar: botAvatar});
            const shape = $('teamBotAvatarPreview').querySelector('[data-character]')?.dataset.character;
            if (shape && !botAvatar.shape) botAvatar.shape = shape;
            body.querySelectorAll('[data-avatar-shape]').forEach(node => node.setAttribute('aria-pressed', String(!botAvatar.image && node.dataset.avatarShape === shape)));
            $('teamBotAvatarReset').hidden = !botAvatar.image;
        };
        refreshAvatar();
        body.querySelectorAll('[data-avatar-shape]').forEach(node => {
            node.onclick = () => { botAvatar.shape = node.dataset.avatarShape; delete botAvatar.image; refreshAvatar(); };
        });
        $('teamBotAvatarColor').oninput = event => { botAvatar.color = event.target.value; refreshAvatar(); };
        $('teamBotAvatarReset').onclick = () => { delete botAvatar.image; refreshAvatar(); };
        $('teamBotAvatarUpload').onclick = () => $('teamBotAvatarFile').click();
        $('teamBotAvatarFile').onchange = async event => {
            const file = event.target.files[0];
            if (!file || readingAvatar || saving) return;
            readingAvatar = true;
            saveButton.disabled = true;
            status.textContent = '正在读取头像…';
            body.querySelectorAll('.team-avatar-choices button, #teamBotAvatarReset, #teamBotAvatarUpload').forEach(node => { node.disabled = true; });
            try {
                const image = await prepareAvatar(file);
                if (!status.isConnected) return;
                botAvatar.image = image;
                refreshAvatar();
                status.textContent = '';
            } catch (error) {
                status.textContent = error.message;
            } finally {
                readingAvatar = false;
                saveButton.disabled = false;
                body.querySelectorAll('.team-avatar-choices button, #teamBotAvatarReset, #teamBotAvatarUpload').forEach(node => { node.disabled = false; });
                event.target.value = '';
            }
        };
        const providers = providerList('chat_models');
        $('teamBotProvider').innerHTML = '<option value="">跟随会话</option>' + providers.map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name || provider.id)}</option>`).join('');
        const fillBotModels = () => {
            const provider = providers.find((item) => item.id === $('teamBotProvider').value);
            const models = provider ? (provider.chat_models || []) : [];
            $('teamBotModel').innerHTML = '<option value="">跟随会话</option>' + models.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
            if (provider && provider.id === model.provider && models.includes(model.model)) $('teamBotModel').value = model.model;
        };
        if (model.provider) $('teamBotProvider').value = model.provider;
        fillBotModels();
        $('teamBotProvider').onchange = fillBotModels;
        $('teamBotCancel').onclick = () => renderSide(chatById(state.currentChat));
        $('teamBotSave').onclick = async () => {
            if (saving || readingAvatar) return;
            const payload = {
                name: $('teamBotName').value.trim(),
                role: $('teamBotRole').value.trim(),
                instructions: $('teamBotInstructions').value,
                personality: $('teamBotPersonality').value.trim(),
                task: $('teamBotTask').value.trim(),
                avatar: botAvatar,
                capabilities: [...body.querySelectorAll('.team-checks input:checked')].map((node) => node.value),
                model: $('teamBotProvider').value && $('teamBotModel').value
                    ? {provider: $('teamBotProvider').value, model: $('teamBotModel').value}
                    : {provider: '', model: ''},
            };
            if (!payload.name) { status.textContent = '名字不能为空'; $('teamBotName').focus(); return; }
            saving = true;
            saveButton.disabled = true;
            status.textContent = '正在保存…';
            try {
                if (editing) await api(`/api/design-brain/bots/${encodeURIComponent(bot.id)}`, {method: 'PATCH', body: JSON.stringify(payload)});
                else await api('/api/design-brain/bots', {method: 'POST', body: JSON.stringify(payload)});
                await loadTeam(true);
                teamToast('成员已保存');
            } catch (error) {
                status.textContent = error.message;
            } finally {
                saving = false;
                saveButton.disabled = false;
            }
        };
    }

    function openGroupForm(group) {
        toggleInspector(true);
        $('teamGlobalWork').hidden = true;
        const editing = Boolean(group);
        $('teamInspectorTitle').textContent = editing ? '编辑设计项目' : '开始新设计';
        const body = $('teamSideBody');
        const bots = state.team?.bots || [];
        const selected = new Set(group?.members || bots.map((bot) => bot.id));
        body.innerHTML = `
            <label class="team-field"><span>项目名称</span><input id="teamGroupName" maxlength="60" value="${esc(group?.name || '')}" placeholder="例如：胡桃木相框 · 秋季上新"></label>
            <label class="team-field"><span>设计要求 <small>选填</small></span><textarea id="teamGroupNotice" rows="3" placeholder="想做什么、喜欢的风格、需要保留什么…">${esc(group?.notice || '')}</textarea></label>
            <details class="team-project-options" ${editing ? 'open' : ''}><summary>调整团队协作</summary>
            <label class="team-field"><span>回答方式</span>
                <select id="teamGroupMode">
                    <option value="admin_first"${group?.reply_mode !== 'round_robin' ? ' selected' : ''}>总监先梳理，按需协作</option>
                    <option value="round_robin"${group?.reply_mode === 'round_robin' ? ' selected' : ''}>全员轮流</option>
                </select>
            </label>
            <label class="team-field"><span>最多讨论轮数</span><input id="teamGroupRelay" type="number" min="2" max="40" value="${group?.relay_limit || 8}"></label>
            <div class="team-field"><span>成员</span><div class="team-checks">${bots.map((bot) => `
                <label><input type="checkbox" value="${esc(bot.id)}" ${selected.has(bot.id) ? 'checked' : ''}> ${esc(bot.name)}</label>`).join('')}</div></div>
            <label class="team-field"><span>项目负责人</span><select id="teamGroupAdmin">${bots.map((bot) => `<option value="${esc(bot.id)}"${(group?.admin_bot_id || bots.find((item) => item.is_main)?.id) === bot.id ? ' selected' : ''}>${esc(bot.name)}</option>`).join('')}</select></label>
            </details>
            <div class="team-form-actions">
                <button class="primary-button" type="button" id="teamGroupSave">${editing ? '保存' : '开始讨论'}</button>
                <button class="subtle-button" type="button" id="teamGroupCancel">取消</button>
                <span id="teamGroupStatus" class="profile-status"></span>
            </div>`;
        $('teamGroupCancel').onclick = () => renderSide(chatById(state.currentChat));
        let saving = false;
        $('teamGroupSave').onclick = async () => {
            if (saving) return;
            const payload = {
                name: $('teamGroupName').value.trim(),
                notice: $('teamGroupNotice').value,
                reply_mode: $('teamGroupMode').value,
                relay_limit: Number($('teamGroupRelay').value) || 8,
                members: [...body.querySelectorAll('.team-checks input:checked')].map((node) => node.value),
                admin_bot_id: $('teamGroupAdmin').value,
            };
            if (!payload.name) { $('teamGroupStatus').textContent = '请先给这个设计起个名字'; $('teamGroupName').focus(); return; }
            saving = true;
            const saveButton = $('teamGroupSave');
            saveButton.disabled = true;
            $('teamGroupStatus').textContent = '正在保存…';
            try {
                const result = editing
                    ? await api(`/api/design-brain/groups/${encodeURIComponent(group.id)}`, {method: 'PATCH', body: JSON.stringify(payload)})
                    : await api('/api/design-brain/groups', {method: 'POST', body: JSON.stringify(payload)});
                const chatId = result.chat?.id;
                if (chatId) localStorage.setItem(STORAGE_CHAT, chatId);
                await loadTeam(true);
                if (chatId && chatId !== state.currentChat) await openChat(chatId);
                toggleInspector(false);
                teamToast('项目讨论已保存');
                $('teamInput').focus();
            } catch (error) {
                if ($('teamGroupStatus')) $('teamGroupStatus').textContent = error.message;
                else teamToast(error.message, true);
            } finally {
                saving = false;
                saveButton.disabled = false;
            }
        };
    }

    /* ---------------- 载入 ---------------- */

    async function loadTeam(reselect) {
        try {
            state.team = await api('/api/design-brain/team');
        } catch (error) {
            document.querySelector('.team-main').classList.remove('is-loading');
            $('teamBotList').innerHTML = `<p class="muted team-empty">读取团队失败：${esc(error.message)}</p>`;
            return;
        }
        renderSidebar();
        const chats = state.team.chats || [];
        const preferred = reselect && state.currentChat && chats.some((chat) => chat.id === state.currentChat)
            ? state.currentChat
            : (localStorage.getItem(STORAGE_CHAT) || '');
        const target = chats.find((chat) => chat.id === preferred)
            || chats.find((chat) => chat.kind === 'group')
            || chats[0];
        if (target && (!state.currentChat || reselect)) await openChat(target.id);
        else if (!target) {
            document.querySelector('.team-main').classList.remove('is-loading');
            $('teamMessages').innerHTML = '<p class="muted team-empty">点击左侧“开始新设计”，开启第一次讨论。</p>';
        } else {
            renderHeader(chatById(state.currentChat));
            renderSide(chatById(state.currentChat));
            refreshMemoryCount(chatById(state.currentChat));
        }
    }


    /* ---------------- 记忆面板 ---------------- */

    const MEMORY_LABELS = {bot: '成员记忆', group: '项目记忆', team: '团队记忆'};

    function memoryTargets(chat) {
        const group = groupForChat(chat);
        const botId = group ? (group.admin_bot_id || chat.members?.[0] || '') : chat.bot_id;
        const targets = [];
        if (botId) targets.push({scope: 'bot', id: botId, label: `成员 · ${botById(botId)?.name || botId}`});
        if (group) targets.push({scope: 'group', id: group.id, label: `项目 · ${group.name}`});
        targets.push({scope: 'team', id: 'team', label: '团队'});
        return targets;
    }

    async function refreshMemoryCount(chat) {
        const span = $('teamMemCount');
        if (!span || !chat) return;
        const targets = memoryTargets(chat);
        const target = targets.find((item) => item.scope === (chat.kind === 'group' ? 'group' : 'bot')) || targets[0];
        try {
            const data = await api(`/api/design-brain/memory/${target.scope}/${encodeURIComponent(target.id)}`);
            span.textContent = `${data.entries.length} 条`;
        } catch (error) {
            span.textContent = '—';
        }
        const box = $('teamMemoryReview');
        if (box) {
            try {
                const settings = await api('/api/design-brain/team/settings');
                box.checked = settings.memory_review !== false;
            } catch (error) { /* 忽略 */ }
        }
    }

    function openMemoryPanel(scopeHint) {
        const chat = chatById(state.currentChat);
        if (!chat) return;
        state.memory = {targets: memoryTargets(chat), target: null, entries: []};
        const target = state.memory.targets.find((item) => item.scope === scopeHint) || state.memory.targets[0];
        state.memory.target = target;
        $('memoryOverlay').hidden = false;
        renderMemoryPanel();
    }

    function renderMemoryPanel() {
        const memory = state.memory;
        if (!memory) return;
        const target = memory.target;
        $('memoryBody').innerHTML = `
            <p class="eyebrow">三层记忆</p>
            <h2 id="memoryTitle">记忆</h2>
            <p class="muted">每条最多 300 字。成员记忆会跟随该成员，项目记忆只用于当前项目，团队记忆由全员共用。</p>
            <div class="memory-tabs">${memory.targets.map((item) => `
                <button class="${item.scope === target.scope ? 'active' : ''}" type="button" data-mem-scope="${item.scope}" data-mem-id="${esc(item.id)}">${esc(item.label)}</button>`).join('')}</div>
            <div class="memory-list" id="memoryList"><p class="muted">正在读取…</p></div>
            <div class="memory-add">
                <input id="memoryInput" maxlength="300" placeholder="例如：主图一律用 3:4 竖版，背景留白">
                <button class="primary-button" type="button" id="memoryAdd">添加</button>
                <span id="memoryStatus" class="profile-status"></span>
            </div>
            <div class="memory-foot">
                <button class="subtle-button" type="button" id="memoryReview">从最近对话提炼</button>
                <span class="muted" id="memorySize"></span>
            </div>
            <h3 class="memory-sub">审美档案候选</h3>
            <p class="muted">记忆整理只能提出建议，点「采纳」才会写入审美档案。</p>
            <div id="memorySuggestions" class="memory-suggestions"><p class="muted">正在读取…</p></div>`;
        loadMemoryEntries();
        loadMemorySuggestions();
    }

    async function loadMemoryEntries() {
        const memory = state.memory;
        if (!memory) return;
        const target = memory.target;
        try {
            const data = await api(`/api/design-brain/memory/${target.scope}/${encodeURIComponent(target.id)}`);
            memory.entries = data.entries || [];
            $('memorySize').textContent = `${data.size} / ${data.limits.file} 字`;
            $('memoryList').innerHTML = memory.entries.length ? memory.entries.map((entry) => `
                <div class="memory-entry" data-entry-index="${entry.index}">
                    <p>${esc(entry.text)}</p>
                    <div class="memory-entry-foot">
                        <small>${esc(entry.source)} · ${esc(entry.added)}</small>
                        <span class="spacer"></span>
                        <button class="subtle-button" type="button" data-mem-edit="${entry.index}">编辑</button>
                        <button class="subtle-button danger" type="button" data-mem-del="${entry.index}">删除</button>
                    </div>
                </div>`).join('') : '<p class="muted">这一层还没有记忆。说过的长期偏好会自动整理进来，也可以手动添加。</p>';
        } catch (error) {
            $('memoryList').innerHTML = `<p class="muted">读取失败：${esc(error.message)}</p>`;
        }
    }

    async function loadMemorySuggestions() {
        try {
            const data = await api('/api/design-brain/profile-suggestions');
            const items = data.suggestions || [];
            $('memorySuggestions').innerHTML = items.length ? items.map((item) => `
                <div class="memory-suggestion">
                    <div><strong>${esc(item.tag || item.text || '')}</strong><small>${esc(item.group || '')} · 权重 ${esc(String(item.weight ?? ''))}</small></div>
                    <span class="spacer"></span>
                    <button class="subtle-button" type="button" data-sug-accept="${esc(item.id)}">采纳</button>
                    <button class="subtle-button danger" type="button" data-sug-reject="${esc(item.id)}">忽略</button>
                </div>`).join('') : '<p class="muted">暂无候选。</p>';
        } catch (error) {
            $('memorySuggestions').innerHTML = `<p class="muted">读取失败：${esc(error.message)}</p>`;
        }
    }

    async function addMemoryEntry() {
        const memory = state.memory;
        const input = $('memoryInput');
        if (!memory || !input) return;
        const text = input.value.trim();
        if (!text) return;
        try {
            await api(`/api/design-brain/memory/${memory.target.scope}/${encodeURIComponent(memory.target.id)}`,
                {method: 'POST', body: JSON.stringify({text})});
            input.value = '';
            $('memoryStatus').textContent = '已添加';
            await loadMemoryEntries();
        } catch (error) {
            $('memoryStatus').textContent = error.message;
        }
    }

    async function editMemoryEntry(index) {
        const memory = state.memory;
        if (!memory) return;
        const entry = memory.entries.find((item) => item.index === Number(index));
        const row = $('memoryList').querySelector(`[data-entry-index="${index}"]`);
        if (!entry || !row) return;
        row.innerHTML = `<input class="memory-edit-input" maxlength="300" value="${esc(entry.text)}">
            <div class="memory-entry-foot"><span class="spacer"></span>
                <button class="primary-button" type="button" data-mem-save="${index}">保存</button>
                <button class="subtle-button" type="button" data-mem-cancel>取消</button>
                <span class="profile-status" data-mem-status></span></div>`;
        row.querySelector('input').focus();
    }

    async function saveMemoryEntry(index) {
        const memory = state.memory;
        const row = $('memoryList').querySelector(`[data-entry-index="${index}"]`);
        const input = row?.querySelector('input');
        if (!memory || !input) return;
        try {
            await api(`/api/design-brain/memory/${memory.target.scope}/${encodeURIComponent(memory.target.id)}`,
                {method: 'PATCH', body: JSON.stringify({index: Number(index), text: input.value.trim()})});
            await loadMemoryEntries();
        } catch (error) {
            const status = row.querySelector('[data-mem-status]');
            if (status) status.textContent = error.message;
        }
    }

    async function removeMemoryEntry(index) {
        const memory = state.memory;
        if (!memory) return;
        try {
            await api(`/api/design-brain/memory/${memory.target.scope}/${encodeURIComponent(memory.target.id)}`,
                {method: 'PATCH', body: JSON.stringify({index: Number(index), remove: true})});
            await loadMemoryEntries();
        } catch (error) {
            $('memoryStatus').textContent = error.message;
        }
    }

    async function reviewMemoryNow() {
        const memory = state.memory;
        if (!memory || !state.currentChat) return;
        $('memoryStatus').textContent = '正在整理…';
        try {
            const result = await api(`/api/design-brain/memory/${memory.target.scope}/${encodeURIComponent(memory.target.id)}/review`,
                {method: 'POST', body: JSON.stringify({chat_id: state.currentChat})});
            const applied = Number(result.applied || 0);
            const suggestions = Number(result.profile_suggestions || 0);
            $('memoryStatus').textContent = applied || suggestions
                ? `整理完成：${applied} 条记忆，${suggestions} 个档案候选`
                : '这轮没有需要记住的新内容';
            await loadMemoryEntries();
            await loadMemorySuggestions();
        } catch (error) {
            $('memoryStatus').textContent = error.message;
        }
    }

    async function handleSuggestion(action, id) {
        try {
            if (action === 'accept') await api(`/api/design-brain/profile-suggestions/${encodeURIComponent(id)}/accept`, {method: 'POST'});
            else await api(`/api/design-brain/profile-suggestions/${encodeURIComponent(id)}`, {method: 'DELETE'});
            await loadMemorySuggestions();
        } catch (error) {
            $('memoryStatus').textContent = error.message;
        }
    }


    /* ---------------- 审批与用量 ---------------- */

    function approvalCard(message, bot) {
        const approvalId = (message.meta && message.meta.approval_id) || '';
        const approval = ((chatById(state.currentChat) || {}).approvals || {})[approvalId];
        const status = (approval && approval.status) || 'pending';
        const label = status === 'approved' ? '已允许' : status === 'rejected' ? '已拒绝' : '等待你确认';
        const actions = status === 'pending'
            ? `<button class="primary-button" type="button" data-team-approve="${esc(approvalId)}">允许</button>
               <button class="subtle-button" type="button" data-team-reject="${esc(approvalId)}">拒绝</button>`
            : `<span class="team-approval-status ${status}">${label}</span>`;
        return `<div class="team-row bot">
            ${avatar(bot)}
            <div class="team-card approval">
                <strong>${esc(bot?.name || 'Bot')} · 需要你确认</strong>
                <p>${esc((message.meta && message.meta.summary) || message.text)}</p>
                <div class="team-approval-actions">${actions}</div>
            </div>
        </div>`;
    }

    async function resolveApproval(approvalId, approve) {
        if (!state.currentChat || !approvalId) return;
        try {
            await api(`/api/design-brain/chats/${encodeURIComponent(state.currentChat)}/approvals/${encodeURIComponent(approvalId)}`,
                {method: 'POST', body: JSON.stringify({approve})});
            await reloadMessages();
            try {
                state.team = await api('/api/design-brain/team');
                renderSidebar();
                renderSide(chatById(state.currentChat));
            } catch (error) { /* 忽略 */ }
        } catch (error) {
            $('teamSendStatus').textContent = error.message;
        }
    }

    async function reloadMessages() {
        if (!state.currentChat) return;
        try {
            const data = await api(`/api/design-brain/chats/${encodeURIComponent(state.currentChat)}/messages?after=0&limit=200`);
            state.messages = data.messages || [];
            state.cursor = data.cursor || 0;
            const known = chatById(data.chat.id);
            if (known) Object.assign(known, data.chat);
            renderMessages();
        } catch (error) {
            /* 忽略 */
        }
    }

    async function openUsage() {
        $('usageOverlay').hidden = false;
        $('usageBody').innerHTML = '<p class="muted">正在读取…</p>';
        let data = null;
        try {
            data = await api('/api/design-brain/usage');
        } catch (error) {
            $('usageBody').innerHTML = `<p class="muted">读取失败：${esc(error.message)}</p>`;
            return;
        }
        const totals = data.totals || {};
        const settings = data.settings || {};
        const botRows = (data.bots || []).map((item) => `
            <tr><td>${esc(botById(item.bot_id)?.name || item.bot_id)}</td>
            <td>${item.counts.llm}</td><td>${item.counts.tool}</td><td>${item.counts.image}</td><td>${item.counts.tokens}</td></tr>`).join('');
        const chatRows = (data.chats || []).map((item) => `
            <tr><td>${esc(chatById(item.chat_id)?.title || item.chat_id)}</td>
            <td>${item.counts.llm}</td><td>${item.counts.tool}</td><td>${item.counts.image}</td><td>${item.counts.tokens}</td></tr>`).join('');
        $('usageBody').innerHTML = `
            <p class="eyebrow">用量</p>
            <h2 id="usageTitle">今日用量 · ${esc(data.date || '')}</h2>
            <div class="usage-totals">
                <div><strong>${totals.llm || 0}</strong><span>模型调用</span></div>
                <div><strong>${totals.tool || 0}</strong><span>工具调用</span></div>
                <div><strong>${totals.image || 0}</strong><span>生图张数</span></div>
                <div><strong>${totals.tokens || 0}</strong><span>Token</span></div>
            </div>
            <h3 class="memory-sub">按成员</h3>
            <table class="usage-table"><thead><tr><th>成员</th><th>模型</th><th>工具</th><th>生图</th><th>Token</th></tr></thead>
                <tbody>${botRows || '<tr><td colspan="5" class="muted">今天还没有调用</td></tr>'}</tbody></table>
            <h3 class="memory-sub">按会话</h3>
            <table class="usage-table"><thead><tr><th>会话</th><th>模型</th><th>工具</th><th>生图</th><th>Token</th></tr></thead>
                <tbody>${chatRows || '<tr><td colspan="5" class="muted">今天还没有调用</td></tr>'}</tbody></table>
            <h3 class="memory-sub">闸门</h3>
            <label class="team-field"><span>每会话每日模型调用上限（0 = 不限制）</span>
                <input id="usageLimit" type="number" min="0" max="100000" value="${Number(settings.daily_llm_limit ?? 300)}"></label>
            <label class="team-field"><span>本会话累计生图达到多少张后需要审批（0 = 不审批）</span>
                <input id="usageThreshold" type="number" min="0" max="1000" value="${Number(settings.approval_image_threshold ?? 4)}"></label>
            <div class="team-form-actions">
                <button class="primary-button" type="button" id="usageSave">保存</button>
                <span id="usageStatus" class="profile-status"></span>
            </div>`;
        $('usageSave').onclick = async () => {
            try {
                await api('/api/design-brain/team/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        daily_llm_limit: Number($('usageLimit').value) || 0,
                        approval_image_threshold: Number($('usageThreshold').value) || 0,
                    }),
                });
                $('usageStatus').textContent = '已保存';
            } catch (error) {
                $('usageStatus').textContent = error.message;
            }
        };
    }

    function bind() {
        document.addEventListener('design-brain-workspace-open', () => toggleInspector(false));
        let loading = null;
        async function ensureTeam() {
            if (!loading) loading = (state.team ? loadTeam() : setupModels().then(() => loadTeam())).finally(() => { loading = null; });
            await loading;
        }
        document.addEventListener('design-brain-new-discussion', async () => {
            await ensureTeam();
            if (!state.team) { teamToast('团队尚未载入，请重试', true); return; }
            openGroupForm(null);
            $('teamGroupName').focus();
        });
        $('teamUploadProduct').addEventListener('click', () => $('teamProductFile').click());
        $('teamProductFile').addEventListener('change', (event) => { uploadProducts(event.target.files); event.target.value = ''; });
        $('teamAddProductImage').addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('design-brain-pick-images', {detail: {images: [...state.productImages]}}));
        });
        document.addEventListener('design-brain-images-selected', (event) => {
            state.productImages = [...(event.detail?.images || [])];
            renderProductImages();
        });
        $('teamProductImages').addEventListener('click', (event) => {
            const node = event.target.closest('[data-team-remove-product]');
            if (node && !state.sending && !state.uploadController) { state.productImages.splice(Number(node.dataset.teamRemoveProduct), 1); renderProductImages(); }
        });
        new MutationObserver(syncComposer).observe($('teamProductImages'), {childList: true});
        const composer = document.querySelector('.team-composer');
        let dragDepth = 0;
        const clearDrop = () => { dragDepth = 0; composer.classList.remove('is-dragging'); };
        composer.addEventListener('dragenter', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            dragDepth += 1;
            composer.classList.add('is-dragging');
        });
        composer.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = state.uploadController || state.sending ? 'none' : 'copy';
        });
        composer.addEventListener('dragleave', () => { if (--dragDepth <= 0) clearDrop(); });
        composer.addEventListener('drop', event => {
            const files = Array.from(event.dataTransfer?.files || []);
            if (!files.length) return;
            event.preventDefault();
            clearDrop();
            const images = files.filter(file => file.type.startsWith('image/'));
            if (!images.length) { teamToast('请添加 JPG、PNG、WebP 等图片文件', true); return; }
            if (state.sending || state.uploadController) { teamToast('图片正在处理，请稍后再添加'); return; }
            uploadProducts(images);
        });
        composer.addEventListener('dragend', clearDrop);
        document.querySelector('.team-composer').addEventListener('paste', (event) => {
            if (event.defaultPrevented || !event.clipboardData) return;
            const clipboard = event.clipboardData;
            let images = Array.from(clipboard.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
            if (!images.length) images = Array.from(clipboard.files || []).filter((file) => file.type.startsWith('image/'));
            if (!images.length) return;
            event.preventDefault();
            if (state.uploadController) { teamToast('商品图正在上传，请稍候再粘贴'); return; }
            uploadProducts(images);
        });
        $('teamInspectorToggle').addEventListener('click', () => toggleInspector());
        $('teamWorkToggle').addEventListener('click', () => {
            toggleInspector(true);
            $('teamGlobalWork').hidden = false;
            $('teamGlobalWork').scrollIntoView({block: 'nearest'});
        });
        $('teamInspectorClose').addEventListener('click', () => { toggleInspector(false); $('teamInspectorToggle').focus(); });
        for (const [id, kind] of [['teamModelToggle', 'Chat'], ['teamImageModelToggle', 'Image']]) {
            $(id).addEventListener('click', event => {
                event.preventDefault();
                const same = $('teamModelsAdv').matches(':popover-open') && state.modelFocusKind === kind;
                toggleModels(!same, kind);
            });
        }
        $('teamModelsClose').addEventListener('click', () => toggleModels(false));
        $('teamModelsAdv').addEventListener('beforetoggle', (event) => {
            const open = event.newState === 'open';
            $('teamModelToggle').setAttribute('aria-expanded', String(open && state.modelFocusKind === 'Chat'));
            $('teamImageModelToggle').setAttribute('aria-expanded', String(open && state.modelFocusKind === 'Image'));
            if (open) requestAnimationFrame(() => {
                if (!$('teamModelsAdv').matches(':popover-open')) return;
                positionModels();
                $(`team${state.modelFocusKind || 'Chat'}Provider`).focus({preventScroll: true});
            });
        });
        window.addEventListener('resize', positionModels);
        window.addEventListener('studio-ui-scale-change', positionModels);
        new ResizeObserver(positionModels).observe(document.querySelector('.team-composer'));
        $('teamSend').addEventListener('click', () => sendMessage());
        $('teamInput').addEventListener('input', () => { updateMentionMenu(); syncComposer(); });
        $('teamInput').addEventListener('blur', () => setTimeout(hideMentionMenu, 120));
        $('teamInput').addEventListener('keydown', (event) => {
            if (event.isComposing || event.keyCode === 229) return;
            if (!state.mentionItems.length) {
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey) { event.preventDefault(); sendMessage(); }
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                state.mentionIndex = (state.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + state.mentionItems.length) % state.mentionItems.length;
                $('teamMentionMenu').querySelectorAll('.team-mention-item').forEach((node, index) => node.classList.toggle('active', index === state.mentionIndex));
            } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pickMention(state.mentionItems[state.mentionIndex].id);
            } else if (event.key === 'Escape') {
                hideMentionMenu();
            }
        });
        $('teamStop').addEventListener('click', async () => {
            if (!state.currentChat) return;
            try { await api(`/api/design-brain/chats/${encodeURIComponent(state.currentChat)}/stop`, {method: 'POST'}); } catch (error) { /* 忽略 */ }
            pollTurn();
        });
        $('teamContinue').addEventListener('click', async () => {
            if (!state.currentChat) return;
            try {
                await api(`/api/design-brain/chats/${encodeURIComponent(state.currentChat)}/continue`, {method: 'POST'});
                $('teamPausedBar').hidden = true;
                pollTurn();
            } catch (error) {
                $('teamSendStatus').textContent = error.message;
            }
        });
        $('teamUsage').addEventListener('click', openUsage);
        document.querySelectorAll('[data-close-usage]').forEach((node) => node.addEventListener('click', () => {
            $('usageOverlay').hidden = true;
        }));
        $('teamNewBot').addEventListener('click', () => openBotForm(null));
        $('teamNewGroup').addEventListener('click', () => { openGroupForm(null); $('teamGroupName').focus(); });

        $('teamBotList').addEventListener('click', async (event) => {
            const node = event.target.closest('[data-team-chat]');
            if (!node) return;
            const botId = node.dataset.teamBot;
            const chatId = node.dataset.teamChat;
            if (botId && !chatById(chatId)) {
                try { await api(`/api/design-brain/bots/${encodeURIComponent(botId)}/chat`, {method: 'POST'}); await loadTeam(); } catch (error) { /* 忽略 */ }
            }
            openChat(chatId);
        });
        $('teamGroupList').addEventListener('click', (event) => {
            const node = event.target.closest('[data-team-chat]');
            if (node) openChat(node.dataset.teamChat);
        });
        $('teamSideBody').addEventListener('click', (event) => {
            const memoryNode = event.target.closest('[data-team-memory]');
            if (memoryNode) { openMemoryPanel(memoryNode.dataset.teamMemory); return; }
            const botNode = event.target.closest('[data-team-edit-bot]');
            if (botNode) { openBotForm(botById(botNode.dataset.teamEditBot)); return; }
            const groupNode = event.target.closest('[data-team-edit-group]');
            if (groupNode) { openGroupForm((state.team?.groups || []).find((group) => group.id === groupNode.dataset.teamEditGroup)); }
        });
        $('teamSideBody').addEventListener('change', async (event) => {
            if (event.target.id !== 'teamMemoryReview') return;
            try {
                await api('/api/design-brain/team/settings', {
                    method: 'PUT',
                    body: JSON.stringify({memory_review: event.target.checked}),
                });
            } catch (error) {
                event.target.checked = !event.target.checked;
            }
        });
        document.querySelectorAll('[data-close-memory]').forEach((node) => node.addEventListener('click', () => {
            $('memoryOverlay').hidden = true;
            refreshMemoryCount(chatById(state.currentChat));
        }));
        $('memoryBody').addEventListener('click', (event) => {
            const scopeNode = event.target.closest('[data-mem-scope]');
            if (scopeNode) {
                state.memory.target = state.memory.targets.find((item) => item.scope === scopeNode.dataset.memScope);
                renderMemoryPanel();
                return;
            }
            if (event.target.closest('#memoryAdd')) { addMemoryEntry(); return; }
            if (event.target.closest('#memoryReview')) { reviewMemoryNow(); return; }
            const editNode = event.target.closest('[data-mem-edit]');
            if (editNode) { editMemoryEntry(editNode.dataset.memEdit); return; }
            const saveNode = event.target.closest('[data-mem-save]');
            if (saveNode) { saveMemoryEntry(saveNode.dataset.memSave); return; }
            const cancelNode = event.target.closest('[data-mem-cancel]');
            if (cancelNode) { loadMemoryEntries(); return; }
            const delNode = event.target.closest('[data-mem-del]');
            if (delNode) { removeMemoryEntry(delNode.dataset.memDel); return; }
            const acceptNode = event.target.closest('[data-sug-accept]');
            if (acceptNode) { handleSuggestion('accept', acceptNode.dataset.sugAccept); return; }
            const rejectNode = event.target.closest('[data-sug-reject]');
            if (rejectNode) { handleSuggestion('reject', rejectNode.dataset.sugReject); }
        });
        $('memoryBody').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.id === 'memoryInput') { event.preventDefault(); addMemoryEntry(); }
        });
        $('teamMentionMenu').addEventListener('mousedown', (event) => {
            const node = event.target.closest('[data-mention]');
            if (node) { event.preventDefault(); pickMention(node.dataset.mention); }
        });
        $('teamMessages').addEventListener('click', (event) => {
            const retryNode = event.target.closest('[data-team-retry]');
            if (retryNode) {
                const failure = state.messages.find(item => item.id === retryNode.dataset.teamRetry);
                const source = failure && isRetryable(failure) && retrySource(failure);
                if (source) sendMessage(source);
                return;
            }
            const taskNode = event.target.closest('[data-team-open-studio]');
            if (taskNode) {
                document.dispatchEvent(new CustomEvent('design-brain-open-task', {detail: {taskId: taskNode.dataset.teamOpenStudio}}));
                return;
            }
            const exampleNode = event.target.closest('[data-team-example]');
            if (exampleNode) {
                $('teamInput').value = exampleNode.dataset.teamExample;
                syncComposer();
                $('teamInput').focus();
                return;
            }
            const approveNode = event.target.closest('[data-team-approve]');
            if (approveNode) { resolveApproval(approveNode.dataset.teamApprove, true); return; }
            const rejectNode = event.target.closest('[data-team-reject]');
            if (rejectNode) { resolveApproval(rejectNode.dataset.teamReject, false); return; }
            const preview = event.target.closest('[data-team-preview]');
            if (preview) {
                const url = preview.dataset.teamPreview;
                window.parent.postMessage({type: 'history-preview-open', items: [{url, kind: 'image'}], index: 0}, '*');
            }
        });
        document.addEventListener('design-brain-tab', (event) => {
            if (event.detail?.tab === 'team') {
                ensureTeam().then(() => { if (teamVisible()) startPolling(); });
            } else {
                toggleModels(false);
                stopPolling();
            }
        });
        document.addEventListener('design-brain-task-snapshots', event => {
            state.tasks = event.detail.tasks;
            state.progressStale = Boolean(event.detail.stale);
            renderWorkStatus();
        });
        $('teamWorkStatus').addEventListener('click', event => {
            const row = event.target.closest('[data-team-open-studio]');
            if (row) document.dispatchEvent(new CustomEvent('design-brain-open-task', {detail: {taskId: row.dataset.teamOpenStudio}}));
        });
        document.addEventListener('click', async event => {
            const stop = event.target.closest('[data-team-stop-work]');
            if (stop) { await stopMemberWork(stop.dataset.teamStopWork); return; }
            const link = event.target.closest('[data-team-go-work]');
            if (!link) return;
            const entry = state.work.find(item => item.id === link.dataset.teamGoWork);
            if (!entry) return;
            try {
                if (!chatById(entry.chat_id)) await loadTeam();
                await openChat(entry.chat_id);
                if (entry.kind === 'workflow') document.dispatchEvent(new CustomEvent('design-brain-open-task', {detail: {taskId: entry.task_id}}));
            } catch (error) {
                teamToast(error.message || '打开工作会话失败，请重试', true);
            }
        });
        setInterval(() => {
            if (!teamVisible()) return;
            document.querySelectorAll('[data-work-since]').forEach(node => {
                node.textContent = window.DesignBrainProgress.elapsed(node.dataset.workSince);
            });
        }, 1000);
        syncComposer();
    }

    window.addEventListener('message', event => {
        if (event.origin && event.origin !== location.origin) return;
        if (event.data?.type === 'providers-changed') setupModels();
    });
    bind();
    if (document.readyState !== 'loading' && teamVisible()) {
        document.dispatchEvent(new CustomEvent('design-brain-tab', {detail: {tab: 'team'}}));
    }
})();
