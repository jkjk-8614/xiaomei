/* 小美 Bot 工作区前端 API 客户端与 SSE 断线恢复事件订阅。 */
(function (root) {
    'use strict';

    const PREFIX = '/api/bot-workspace';
    const UI_MODE_KEY = 'xiaomei_bot_workspace_ui_mode_v1';
    const WIDTH_KEY = 'xiaomei_bot_workspace_width_v1';
    const SIDEBAR_COLLAPSED_KEY = 'xiaomei_bot_workspace_sidebar_collapsed_v1';
    const ACTIVE_BOT_KEY = 'xiaomei_bot_workspace_active_bot_v1';
    const ACTIVE_SESSION_PREFIX = 'xiaomei_bot_workspace_session_v1:';

    function makeId(prefix = 'req') {
        const raw = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return `${prefix}_${raw}`;
    }

    async function request(path, options = {}) {
        const method = options.method || (options.body ? 'POST' : 'GET');
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const init = {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            headers,
            signal: options.signal,
        };
        if (options.body !== undefined) {
            init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        }
        const response = await fetch(PREFIX + path, init);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = data?.detail;
            const message = (typeof detail === 'object' ? detail?.message : detail) || data?.message || `请求失败（${response.status}）`;
            const err = new Error(message);
            err.status = response.status;
            err.code = (typeof detail === 'object' ? detail?.code : data?.code) || '';
            throw err;
        }
        return data;
    }

    class BotWorkspaceEventStream {
        constructor({ onEvent, onConnectionChange } = {}) {
            this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
            this.onConnectionChange = typeof onConnectionChange === 'function' ? onConnectionChange : () => {};
            this.cursor = 0;
            this.source = null;
            this.closed = true;
            this.reconnectTimer = 0;
            this.backoffMs = 1000;
            this.filters = {};
        }

        start(afterSeq = 0, filters = {}) {
            this.stop();
            this.closed = false;
            this.cursor = Math.max(0, Number(afterSeq) || 0);
            this.filters = { ...(filters || {}) };
            this.backoffMs = 1000;
            this._connect();
        }

        stop() {
            this.closed = true;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = 0;
            }
            if (this.source) {
                try { this.source.close(); } catch (_) { /* ignore */ }
                this.source = null;
            }
        }

        _buildUrl() {
            const params = new URLSearchParams();
            params.set('after', String(this.cursor));
            for (const [k, v] of Object.entries(this.filters)) {
                if (v) params.set(k, String(v));
            }
            return `${PREFIX}/events?${params.toString()}`;
        }

        _connect() {
            if (this.closed || typeof EventSource === 'undefined') return;
            const url = this._buildUrl();
            try {
                const es = new EventSource(url);
                this.source = es;
                es.addEventListener('ready', (event) => {
                    this.backoffMs = 1000;
                    try {
                        const info = JSON.parse(event.data || '{}');
                        if (Number(info.cursor) > this.cursor) this.cursor = Number(info.cursor);
                    } catch (_) { /* ignore */ }
                    this.onConnectionChange('connected');
                });
                const handleMessage = (event) => {
                    try {
                        const data = JSON.parse(event.data || '{}');
                        const seq = Number(data.seq || event.lastEventId || 0);
                        if (seq > this.cursor) this.cursor = seq;
                        this.onEvent(data);
                    } catch (_) { /* ignore */ }
                };
                const eventTypes = [
                    'bot_initialized', 'bot_created', 'bot_updated', 'bot_archived', 'bot_restored',
                    'bot_skills_updated', 'memory_added', 'session_created', 'message_created',
                    'turn_queued', 'turn_updated', 'turn_recovery_required', 'delegation_created',
                    'delegation_updated', 'run_linked', 'approval_requested', 'approval_resolved',
                    'canvas_action_waiting', 'canvas_action_completed',
                ];
                eventTypes.forEach((type) => es.addEventListener(type, handleMessage));
                es.onmessage = handleMessage;
                es.onerror = () => {
                    if (this.closed) return;
                    this.onConnectionChange('reconnecting');
                    try { es.close(); } catch (_) { /* ignore */ }
                    if (this.source === es) this.source = null;
                    const delay = this.backoffMs;
                    this.backoffMs = Math.min(12000, Math.round(this.backoffMs * 1.6));
                    this.reconnectTimer = setTimeout(() => this._connect(), delay);
                };
            } catch (_) {
                this.onConnectionChange('disconnected');
            }
        }
    }

    const client = {
        PREFIX,
        UI_MODE_KEY,
        WIDTH_KEY,
        SIDEBAR_COLLAPSED_KEY,
        ACTIVE_BOT_KEY,
        ACTIVE_SESSION_PREFIX,
        makeId,
        request,
        BotWorkspaceEventStream,
        getConfig: () => request('/config'),
        setFeatureFlag: (enabled) => request('/feature-flag', { method: 'PUT', body: { enabled: Boolean(enabled) } }),
        triggerMigration: () => request('/migrate', { method: 'POST', body: {} }),
        listBots: (includeArchived = false) => request(`/bots?include_archived=${includeArchived ? 'true' : 'false'}`),
        createBot: (payload) => request('/bots', { method: 'POST', body: payload }),
        getBot: (botId) => request(`/bots/${encodeURIComponent(botId)}`),
        updateBot: (botId, patch) => request(`/bots/${encodeURIComponent(botId)}`, { method: 'PATCH', body: patch }),
        archiveBot: (botId, reason = '') => request(`/bots/${encodeURIComponent(botId)}/archive`, { method: 'POST', body: { reason } }),
        restoreBot: (botId) => request(`/bots/${encodeURIComponent(botId)}/restore`, { method: 'POST', body: {} }),
        setBotSkills: (botId, skills) => request(`/bots/${encodeURIComponent(botId)}/skills`, { method: 'PUT', body: { skills } }),
        listMemories: (botId, projectId = '') => request(`/bots/${encodeURIComponent(botId)}/memories${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
        addMemory: (botId, payload) => request(`/bots/${encodeURIComponent(botId)}/memories`, { method: 'POST', body: payload }),
        updateMemory: (botId, memoryId, content) => request(`/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(memoryId)}`, { method: 'PATCH', body: { content } }),
        deleteMemory: (botId, memoryId) => request(`/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
        listSessions: (botId, { includeArchived = false, projectId = '', canvasId = '' } = {}) => {
            const p = new URLSearchParams();
            if (includeArchived) p.set('include_archived', 'true');
            if (projectId) p.set('project_id', projectId);
            if (canvasId) p.set('canvas_id', canvasId);
            const qs = p.toString();
            return request(`/bots/${encodeURIComponent(botId)}/sessions${qs ? `?${qs}` : ''}`);
        },
        createSession: (botId, payload = {}) => request(`/bots/${encodeURIComponent(botId)}/sessions`, { method: 'POST', body: payload }),
        updateSession: (sessionId, patch) => request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: patch }),
        listMessages: (sessionId, after = 0, limit = 200) => request(`/sessions/${encodeURIComponent(sessionId)}/messages?after=${after}&limit=${limit}`),
        sendMessage: (sessionId, payload) => request(`/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: payload }),
        listTurns: (params = {}) => {
            const qs = new URLSearchParams(params).toString();
            return request(`/turns${qs ? `?${qs}` : ''}`);
        },
        cancelTurn: (turnId, reason = '用户停止了任务') => request(`/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', body: { reason } }),
        retryTurn: (turnId) => request(`/turns/${encodeURIComponent(turnId)}/retry`, { method: 'POST', body: {} }),
        resumeTurn: (turnId) => request(`/turns/${encodeURIComponent(turnId)}/resume`, { method: 'POST', body: {} }),
        listDelegations: (params = {}) => {
            const qs = new URLSearchParams(params).toString();
            return request(`/delegations${qs ? `?${qs}` : ''}`);
        },
        listApprovals: (params = {}) => {
            const qs = new URLSearchParams(params).toString();
            return request(`/approvals${qs ? `?${qs}` : ''}`);
        },
        resolveApproval: (approvalId, approved) => request(`/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: 'POST', body: { approved: Boolean(approved) } }),
        heartbeatCanvas: (projectId, canvasId, clientId) => request('/canvas-presence', { method: 'POST', body: { project_id: projectId, canvas_id: canvasId, client_id: clientId } }),
        pollEvents: (after = 0) => request(`/events/poll?after=${after}`),
    };

    root.BotWorkspaceClient = client;
})(window);
