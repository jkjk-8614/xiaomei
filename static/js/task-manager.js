(function () {
    'use strict';

    const API_BASE = '/api/scheduled-tasks';
    const state = {
        tasks: [],
        filter: 'all',
        scheduleKind: 'cron',
        payloadKind: 'systemEvent',
        toastTimer: 0,
        loading: false,
    };

    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => Array.from(document.querySelectorAll(selector));
    const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));

    function createIcons() {
        try { window.lucide?.createIcons?.(); } catch (error) { /* icon enhancement is optional */ }
    }

    function showToast(message, isError = false) {
        const toast = $('#taskToast');
        if (!toast) return;
        toast.textContent = String(message || '');
        toast.classList.toggle('error', Boolean(isError));
        toast.classList.add('show');
        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
    }

    async function readResponse(response, fallback) {
        let data = null;
        try { data = await response.json(); } catch (error) { /* use fallback below */ }
        if (!response.ok) {
            const detail = data && (data.detail || data.message);
            throw new Error(String(detail || fallback || `请求失败（${response.status}）`));
        }
        return data;
    }

    function setLoading(loading) {
        state.loading = Boolean(loading);
        const button = $('#refreshTaskButton');
        if (button) {
            button.disabled = state.loading;
            button.classList.toggle('is-loading', state.loading);
            button.querySelector('span').textContent = state.loading ? '刷新中' : '刷新';
        }
    }

    function formatDuration(value) {
        const duration = Number(value || 0);
        if (!duration || duration <= 0) return '';
        if (duration < 1000) return `${Math.round(duration)}ms`;
        if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
        const seconds = Math.floor(duration / 1000);
        return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
    }

    function formatRelative(timestamp) {
        const value = Number(timestamp || 0);
        if (!value) return '—';
        const difference = value - Date.now();
        const absolute = Math.abs(difference);
        let amount;
        let unit;
        if (absolute < 60000) { amount = Math.max(1, Math.round(absolute / 1000)); unit = '秒'; }
        else if (absolute < 3600000) { amount = Math.round(absolute / 60000); unit = '分钟'; }
        else if (absolute < 86400000) { amount = Math.round(absolute / 3600000); unit = '小时'; }
        else { amount = Math.round(absolute / 86400000); unit = '天'; }
        return difference >= 0 ? `${amount}${unit}后` : `${amount}${unit}前`;
    }

    function formatAt(value) {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value || '');
        return parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function formatSchedule(schedule) {
        const item = schedule || {};
        if (item.kind === 'every') {
            const value = Number(item.everyMs || 0);
            if (value < 60000) return `每 ${Math.max(1, Math.round(value / 1000))} 秒`;
            if (value < 3600000) return `每 ${Math.round(value / 60000)} 分钟`;
            if (value < 86400000) return `每 ${Math.round(value / 3600000)} 小时`;
            return `每 ${Math.round(value / 86400000)} 天`;
        }
        if (item.kind === 'at') return `一次性 · ${formatAt(item.at)}`;
        return item.tz ? `${item.expr || ''} @ ${item.tz}` : String(item.expr || '');
    }

    function taskType(task) {
        const payload = task && task.payload ? task.payload : {};
        if (payload.kind === 'agentTurn') return `对话 · ${task.agentId || payload.agentId || '独立会话'}`;
        return '系统事件';
    }

    function statusMeta(task) {
        const taskState = task && task.state ? task.state : {};
        if (taskState.runningAtMs) return { key: 'running', label: '运行中' };
        if (taskState.lastStatus === 'ok') return { key: 'ok', label: '成功' };
        if (taskState.lastStatus === 'error') return { key: 'err', label: '失败' };
        if (taskState.lastStatus === 'skipped') return { key: 'warn', label: '跳过' };
        return { key: 'idle', label: '未运行' };
    }

    function filteredTasks() {
        return state.tasks.filter((task) => {
            if (state.filter === 'enabled') return Boolean(task.enabled);
            if (state.filter === 'disabled') return !task.enabled;
            return true;
        });
    }

    function updateCounts() {
        const enabled = state.tasks.filter((task) => task.enabled).length;
        const all = $('#countAll');
        const on = $('#countEnabled');
        const off = $('#countDisabled');
        if (all) all.textContent = String(state.tasks.length);
        if (on) on.textContent = String(enabled);
        if (off) off.textContent = String(state.tasks.length - enabled);
    }

    function render() {
        updateCounts();
        const content = $('#taskContent');
        if (!content) return;
        const tasks = filteredTasks();
        if (!tasks.length) {
            const message = state.tasks.length ? '没有匹配的任务' : '从一项工作开始安排';
            content.innerHTML = `<div class="task-empty"><strong>${esc(message)}</strong><p>可以定期整理素材、发送工作提醒，或交给指定助手处理。</p><button class="task-button task-button-primary" type="button" data-create-plan>添加计划</button></div>`;
            createIcons();
            return;
        }
        content.innerHTML = tasks.map((task) => {
            const taskState = task.state || {};
            const status = statusMeta(task);
            const result = taskState.lastResult || taskState.lastError || '';
            const duration = formatDuration(taskState.lastDurationMs);
            const resultTitle = result || status.label;
            return `<article class="plan-card${task.enabled ? '' : ' is-disabled'}" data-task-id="${esc(task.id)}">
                <div class="plan-card-heading"><div><h2>${esc(task.name)}</h2><span class="plan-mode">${esc(taskType(task))}</span></div><label class="task-switch" title="${task.enabled ? '暂停计划' : '启用计划'}"><input type="checkbox" data-action="toggle" ${task.enabled ? 'checked' : ''} aria-label="${task.enabled ? '暂停计划' : '启用计划'}"><span class="task-switch-track"><span class="task-switch-thumb"></span></span></label></div>
                <p class="plan-instruction">${esc(task.payload?.message || task.payload?.text || '未填写工作内容')}</p>
                <dl class="plan-timing"><div><dt>下一次执行</dt><dd>${task.enabled ? esc(formatRelative(taskState.nextRunAtMs)) : '已暂停'}</dd></div><div><dt>触发规则</dt><dd>${esc(formatSchedule(task.schedule))}</dd></div></dl>
                <div class="plan-last-result"><span class="task-result ${status.key}">${esc(status.label)}${duration ? ` · ${esc(duration)}` : ''}</span><p title="${esc(resultTitle)}">${esc(result || '执行后将在这里显示结果')}</p></div>
                <footer class="plan-card-footer"><small title="${esc(task.id)}">编号 ${esc(task.id)}</small><button class="task-button task-button-ghost" type="button" data-action="run">执行一次</button><button class="task-icon-button danger" type="button" data-action="delete" title="删除计划" aria-label="删除计划"><i data-lucide="trash-2" aria-hidden="true"></i></button></footer>
            </article>`;
        }).join('');
        createIcons();
    }

    async function loadTasks(showLoading = false) {
        if (showLoading) setLoading(true);
        try {
            const response = await fetch(`${API_BASE}?includeDisabled=true`, { cache: 'no-store' });
            const data = await readResponse(response, '定时任务加载失败');
            state.tasks = Array.isArray(data) ? data : (Array.isArray(data?.jobs) ? data.jobs : []);
            render();
        } catch (error) {
            const content = $('#taskContent');
            if (content) {
                content.innerHTML = `<div class="task-empty task-error"><i data-lucide="circle-alert" aria-hidden="true"></i><span>${esc(error.message || '定时任务加载失败')}</span><button class="task-button task-button-ghost" type="button" data-retry-task>重新加载</button></div>`;
                createIcons();
            }
        } finally {
            setLoading(false);
        }
    }

    async function updateTask(id, patch) {
        const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        return readResponse(response, '任务更新失败');
    }

    async function runTask(id) {
        const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'force' }),
        });
        await readResponse(response, '任务触发失败');
        showToast('任务已触发');
        window.setTimeout(() => loadTasks(false), 350);
    }

    async function deleteTask(id, name) {
        if (!window.confirm(`确定删除任务「${name}」吗？\n该任务的历史运行结果也会被删除。`)) return;
        const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await readResponse(response, '任务删除失败');
        showToast(`已删除「${name}」`);
        await loadTasks(false);
    }

    function setScheduleKind(kind) {
        state.scheduleKind = kind;
        $$('[data-schedule-kind]').forEach((button) => button.classList.toggle('active', button.dataset.scheduleKind === kind));
        $('#cronFields').hidden = kind !== 'cron';
        $('#everyFields').hidden = kind !== 'every';
        $('#atFields').hidden = kind !== 'at';
    }

    function setPayloadKind(kind) {
        state.payloadKind = kind;
        $$('[data-payload-kind]').forEach((button) => button.classList.toggle('active', button.dataset.payloadKind === kind));
        const isAgent = kind === 'agentTurn';
        $('#agentField').hidden = !isAgent;
        $('#contentLabel').textContent = isAgent ? '发给 Agent 的消息' : '系统事件文本';
        $('#taskContentInput').placeholder = isAgent ? '请帮我巡检竞品价格，有异常时通知我' : '整理本周商品主图，列出待补拍的角度。';
    }

    function resetTaskForm() {
        $('#taskForm')?.reset();
        $('#taskName').value = '';
        $('#cronExpression').value = '0 8 * * *';
        $('#cronTimezone').value = '';
        $('#everyValue').value = '15m';
        $('#atValue').value = '';
        $('#agentId').value = '';
        $('#taskContentInput').value = '';
        setScheduleKind('cron');
        setPayloadKind('systemEvent');
    }

    function openTaskModal() {
        resetTaskForm();
        $('#taskModal').hidden = false;
        document.body.style.overflow = 'hidden';
        window.setTimeout(() => $('#taskName')?.focus(), 0);
    }

    function closeTaskModal() {
        $('#taskModal').hidden = true;
        document.body.style.overflow = '';
    }

    function parseEvery(value) {
        const match = String(value || '').trim().match(/^(\d+)\s*(ms|s|m|h|d)$/i);
        if (!match) return null;
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
        const result = amount * factor;
        return Number.isSafeInteger(result) && result >= 1000 ? result : null;
    }

    function buildSchedule() {
        if (state.scheduleKind === 'cron') {
            const expr = $('#cronExpression').value.trim();
            if (!expr) throw new Error('请填写 Cron 表达式');
            const schedule = { kind: 'cron', expr };
            const timezone = $('#cronTimezone').value.trim();
            if (timezone) schedule.tz = timezone;
            return schedule;
        }
        if (state.scheduleKind === 'every') {
            const everyMs = parseEvery($('#everyValue').value);
            if (!everyMs) throw new Error('请填写有效的间隔（如 15m / 1h / 30s）');
            return { kind: 'every', everyMs };
        }
        const at = $('#atValue').value.trim();
        if (!at) throw new Error('请填写一次性触发时间');
        return { kind: 'at', at };
    }

    async function submitTask(event) {
        event.preventDefault();
        const name = $('#taskName').value.trim();
        const content = $('#taskContentInput').value.trim();
        if (!name) { showToast('请填写任务名', true); $('#taskName').focus(); return; }
        if (!content) { showToast('请填写任务内容', true); $('#taskContentInput').focus(); return; }
        let schedule;
        try { schedule = buildSchedule(); } catch (error) { showToast(error.message, true); return; }
        const agentId = $('#agentId').value.trim();
        if (state.payloadKind === 'agentTurn' && !agentId) { showToast('对话模式需要填写 Agent ID', true); $('#agentId').focus(); return; }
        const payload = state.payloadKind === 'agentTurn'
            ? { kind: 'agentTurn', message: content, agentId }
            : { kind: 'systemEvent', text: content };
        const submitButton = $('#submitTaskButton');
        submitButton.disabled = true;
        submitButton.textContent = '创建中…';
        try {
            const response = await fetch(API_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, enabled: true, schedule, sessionTarget: state.payloadKind === 'agentTurn' ? 'isolated' : 'main', wakeMode: 'now', payload, agentId }),
            });
            await readResponse(response, '任务创建失败');
            closeTaskModal();
            showToast(`已创建「${name}」`);
            await loadTasks(false);
        } catch (error) {
            showToast(error.message || '任务创建失败', true);
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = '创建';
        }
    }

    function bindEvents() {
        $('#refreshTaskButton')?.addEventListener('click', () => loadTasks(true));
        $('#createTaskButton')?.addEventListener('click', openTaskModal);
        $('#closeTaskModal')?.addEventListener('click', closeTaskModal);
        $('#cancelTaskButton')?.addEventListener('click', closeTaskModal);
        $('[data-close-task-modal]')?.addEventListener('click', closeTaskModal);
        $('#taskForm')?.addEventListener('submit', submitTask);
        $$('[data-schedule-kind]').forEach((button) => button.addEventListener('click', () => setScheduleKind(button.dataset.scheduleKind)));
        $$('[data-payload-kind]').forEach((button) => button.addEventListener('click', () => setPayloadKind(button.dataset.payloadKind)));
        $('#taskFilters')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-filter]');
            if (!button) return;
            state.filter = button.dataset.filter;
            $$('.task-filter').forEach((item) => {
                const active = item === button;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            render();
        });
        $('#taskContent')?.addEventListener('click', async (event) => {
            if (event.target.closest('[data-create-plan]')) { openTaskModal(); return; }
            const retry = event.target.closest('[data-retry-task]');
            if (retry) { await loadTasks(true); return; }
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const row = actionButton.closest('[data-task-id]');
            const task = state.tasks.find((item) => item.id === row?.dataset.taskId);
            if (!task) return;
            const action = actionButton.dataset.action;
            try {
                if (action === 'run') await runTask(task.id);
                if (action === 'delete') await deleteTask(task.id, task.name);
            } catch (error) { showToast(error.message || '操作失败', true); }
        });
        $('#taskContent')?.addEventListener('change', async (event) => {
            const input = event.target.closest('[data-action="toggle"]');
            if (!input) return;
            const row = input.closest('[data-task-id]');
            const task = state.tasks.find((item) => item.id === row?.dataset.taskId);
            if (!task) return;
            input.disabled = true;
            try {
                await updateTask(task.id, { enabled: input.checked });
                showToast(`${task.name} 已${input.checked ? '启用' : '停用'}`);
                await loadTasks(false);
            } catch (error) {
                input.checked = !input.checked;
                showToast(error.message || '切换失败', true);
            } finally { input.disabled = false; }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !$('#taskModal').hidden) closeTaskModal();
        });
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'task-manager-focus') loadTasks(false);
        });
    }

    bindEvents();
    setScheduleKind('cron');
    setPayloadKind('systemEvent');
    createIcons();
    loadTasks(true);
    window.setInterval(() => {
        if (!document.hidden) loadTasks(false);
    }, 60000);
})();
