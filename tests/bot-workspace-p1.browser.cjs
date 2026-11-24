const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

function createBackendState() {
    const bots = new Map();
    const sessions = new Map();
    const messages = new Map();
    const memories = new Map();
    let seq = 1;

    const manager = {
        bot_id: 'bot_manager',
        name: '小美总管理',
        avatar: { text: '总', color: '#2F6F5E', shape: 'star' },
        role: '唯一默认总管理 Bot',
        system_instructions: '总管理默认指令',
        personality: '沉稳清晰',
        is_manager: true,
        status: 'active',
        chat_model: { provider_id: 'prov_a', model: 'alpha-1' },
        vision_model: { provider_id: '', model: '' },
        image_model: { provider_id: '', model: '' },
        model_params: { auto_match_skills: true },
        tool_permissions: ['bot.list', 'bot.create', 'bot.read', 'bot.update', 'bot.archive', 'bot.restore', 'bot.delegate', 'canvas.read'],
        permission_ceiling: ['bot.list', 'bot.create', 'bot.read', 'bot.update', 'bot.archive', 'bot.restore', 'bot.delegate', 'canvas.read'],
        delegation_policy: { allow_delegate: true, allow_temp_subagents: true, allowed_target_bot_ids: [], max_delegation_depth: 2 },
        canvas_policy: { allow_canvas_read: true, allow_canvas_writes: true, require_approval_for_paid: true },
        skills: [],
        active_turn_count: 0,
    };
    bots.set(manager.bot_id, manager);
    sessions.set('ses_mgr_1', {
        session_id: 'ses_mgr_1',
        bot_id: 'bot_manager',
        title: '默认工作会话',
        kind: 'chat',
        project_id: 'default',
        canvas_id: 'bw-p1',
        archived: false,
        pinned: true,
        seq: 0,
        last_message_at: 1,
    });
    messages.set('ses_mgr_1', []);
    memories.set('bot_manager', []);

    return {
        bots,
        sessions,
        messages,
        memories,
        nextId(prefix) {
            seq += 1;
            return `${prefix}_${seq}`;
        },
    };
}

async function setupPage(t, backend) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.hostname !== 'bot-workspace-p1.test') return route.abort();

        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.png')) {
            return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (url.pathname === '/api/config') {
            return route.fulfill({
                json: {
                    api_providers: [
                        { id: 'prov_a', name: '平台A', enabled: true, protocol: 'openai', chat_models: ['alpha-1', 'alpha-2'], image_models: ['img-a'] },
                        { id: 'prov_b', name: '平台B', enabled: true, protocol: 'anthropic', chat_models: ['beta-1'], image_models: [] },
                    ],
                    comfy_instances: [],
                },
            });
        }
        if (url.pathname === '/api/canvases/bw-p1') {
            return route.fulfill({
                json: {
                    canvas: {
                        id: 'bw-p1',
                        title: 'Bot工作区测试画布',
                        project: 'default',
                        nodes: [],
                        connections: [],
                        logs: [],
                        settings: { engine: 'api', provider_id: 'prov_a', model: 'img-a', count: 1 },
                    },
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/config') {
            return route.fulfill({
                json: {
                    feature_flags: { enabled: true },
                    manager_bot_id: 'bot_manager',
                    providers: [
                        { id: 'prov_a', name: '平台A', protocol: 'openai', chat_models: ['alpha-1', 'alpha-2'], image_models: ['img-a'], video_models: [] },
                        { id: 'prov_b', name: '平台B', protocol: 'anthropic', chat_models: ['beta-1'], image_models: [], video_models: [] },
                    ],
                    skills: [
                        { id: 'sk_poster', name: '电商海报拆解', description: '拆解构图与主标题', enabled: true },
                    ],
                    avatar_shapes: ['star', 'bunny', 'moon', 'kitty'],
                    tools: {
                        all: ['bot.list', 'bot.create', 'bot.read', 'bot.update', 'bot.archive', 'bot.restore', 'bot.delegate', 'canvas.read', 'memory.read', 'memory.remember'],
                        specialist_max: ['bot.list', 'bot.read', 'bot.delegate', 'canvas.read', 'memory.read', 'memory.remember'],
                    },
                    latest_event_seq: 1,
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/events') {
            return route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
                body: 'event: ready\ndata: {"cursor":1}\n\n',
            });
        }
        if (url.pathname === '/api/bot-workspace/canvas-presence') {
            return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname === '/api/bot-workspace/bots' && req.method() === 'GET') {
            const includeArchived = url.searchParams.get('include_archived') === 'true';
            const list = [...backend.bots.values()].filter((b) => includeArchived || b.status === 'active');
            return route.fulfill({ json: { bots: list } });
        }
        if (url.pathname === '/api/bot-workspace/bots' && req.method() === 'POST') {
            const body = req.postDataJSON();
            const botId = backend.nextId('bot');
            const bot = {
                bot_id: botId,
                name: body.name,
                role: body.role || '',
                system_instructions: body.system_instructions || '',
                personality: body.personality || '',
                avatar: body.avatar || { text: body.name.slice(0, 1), color: '#3C6E9F', shape: 'bunny' },
                is_manager: false,
                status: 'active',
                chat_model: body.chat_model || { provider_id: '', model: '' },
                vision_model: { provider_id: '', model: '' },
                image_model: body.image_model || { provider_id: '', model: '' },
                model_params: {},
                tool_permissions: ['bot.list', 'bot.read', 'canvas.read', 'memory.read', 'memory.remember'],
                permission_ceiling: ['bot.list', 'bot.read', 'canvas.read', 'memory.read', 'memory.remember'],
                delegation_policy: { allow_delegate: false },
                canvas_policy: { allow_canvas_read: true, allow_canvas_writes: false },
                skills: [],
                active_turn_count: 0,
            };
            backend.bots.set(botId, bot);
            const sid = backend.nextId('ses');
            backend.sessions.set(sid, {
                session_id: sid, bot_id: botId, title: '默认会话', kind: 'chat',
                project_id: 'default', canvas_id: 'bw-p1', archived: false, pinned: true, seq: 0, last_message_at: Date.now(),
            });
            backend.messages.set(sid, []);
            backend.memories.set(botId, []);
            return route.fulfill({ json: { bot } });
        }
        const archiveMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/archive$/);
        if (archiveMatch && req.method() === 'POST') {
            const bot = backend.bots.get(archiveMatch[1]);
            bot.status = 'archived';
            return route.fulfill({ json: { bot } });
        }
        const restoreMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/restore$/);
        if (restoreMatch && req.method() === 'POST') {
            const bot = backend.bots.get(restoreMatch[1]);
            bot.status = 'active';
            return route.fulfill({ json: { bot } });
        }
        const sessMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/sessions$/);
        if (sessMatch && req.method() === 'GET') {
            const list = [...backend.sessions.values()].filter((s) => s.bot_id === sessMatch[1]);
            return route.fulfill({ json: { sessions: list } });
        }
        if (sessMatch && req.method() === 'POST') {
            const body = req.postDataJSON();
            const sid = backend.nextId('ses');
            const sess = {
                session_id: sid, bot_id: sessMatch[1], title: body.title || '新会话', kind: 'chat',
                project_id: body.project_id || '', canvas_id: body.canvas_id || '', archived: false, pinned: false, seq: 0, last_message_at: Date.now(),
            };
            backend.sessions.set(sid, sess);
            backend.messages.set(sid, []);
            return route.fulfill({ json: { session: sess } });
        }
        const memMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/memories$/);
        if (memMatch && req.method() === 'GET') {
            return route.fulfill({ json: { memories: backend.memories.get(memMatch[1]) || [] } });
        }
        const msgMatch = url.pathname.match(/^\/api\/bot-workspace\/sessions\/([^/]+)\/messages$/);
        if (msgMatch && req.method() === 'GET') {
            const sess = backend.sessions.get(msgMatch[1]);
            return route.fulfill({
                json: { session: sess, messages: backend.messages.get(msgMatch[1]) || [], turns: [], approvals: [], run_links: [] },
            });
        }
        if (msgMatch && req.method() === 'POST') {
            const sid = msgMatch[1];
            const sess = backend.sessions.get(sid);
            const bot = backend.bots.get(sess.bot_id);
            const body = req.postDataJSON();
            const list = backend.messages.get(sid);
            const uMsg = {
                message_id: backend.nextId('msg'), session_id: sid, bot_id: bot.bot_id,
                seq: list.length + 1, role: 'user', kind: 'text', content: body.content, attachments: [], meta: {},
            };
            const bMsg = {
                message_id: backend.nextId('msg'), session_id: sid, bot_id: bot.bot_id,
                seq: list.length + 2, role: 'bot', kind: 'text',
                content: `来自 ${bot.name}（${bot.chat_model.model || '默认'}）：已收到 ${body.content}`,
                attachments: [], meta: {},
            };
            list.push(uMsg, bMsg);
            return route.fulfill({
                json: { message: uMsg, turn: { turn_id: backend.nextId('trn'), status: 'completed' }, created: true },
            });
        }

        return route.fulfill({ json: { skills: [], categories: [], items: [], workflows: [], batches: [], runs: [] } });
    });

    await page.goto('http://bot-workspace-p1.test/static/smart-canvas.html?id=bw-p1');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Bot工作区测试画布');
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentPanel')?.classList.contains('bot-workspace-active'));
    return { page, errors };
}

test('右侧工作区默认只有唯一总管理 Bot，支持改宽、折叠列表、独立聊天、归档恢复与经典模式回退', { timeout: 30000 }, async (t) => {
    const backend = createBackendState();
    const { page, errors } = await setupPage(t, backend);

    // 1. 默认只有 1 个总管理 Bot
    const botItems = page.locator('#bwBotList [data-bw-bot]');
    assert.equal(await botItems.count(), 1);
    assert.equal(await page.locator('#bwCurrentBotName').textContent(), '小美总管理');

    // 2. 拖动/键盘改变宽度 & 折叠 Bot 列表
    const beforeWidth = await page.locator('#canvasAgentPanel').evaluate((el) => el.getBoundingClientRect().width);
    await page.locator('#botWorkspaceResizer').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const afterWidth = await page.locator('#canvasAgentPanel').evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(afterWidth > beforeWidth, `expected panel width to grow: ${beforeWidth} -> ${afterWidth}`);

    await page.locator('#bwSidebarToggle').click();
    assert.equal(await page.locator('#botWorkspaceShell').evaluate((el) => el.classList.contains('is-sidebar-collapsed')), true);
    await page.locator('#bwSidebarToggle').click();
    assert.equal(await page.locator('#botWorkspaceShell').evaluate((el) => el.classList.contains('is-sidebar-collapsed')), false);

    // 3. 新建永久专业 Bot 并选择独立模型
    await page.locator('#bwNewBotBtn').click();
    await page.locator('#bwProfileForm input[name="name"]').fill('主图视觉专家');
    await page.locator('#bwProfileForm input[name="role"]').fill('负责电商主图构图与配色');
    await page.locator('#bwProfileForm select[name="chat_provider_id"]').selectOption('prov_b');
    await page.locator('#bwProfileForm select[name="chat_model"]').selectOption('beta-1');
    await page.locator('#bwProfileForm button[type="submit"]').click();

    await page.waitForFunction(() => document.querySelectorAll('#bwBotList [data-bw-bot]').length === 2);
    await page.waitForFunction(() => document.getElementById('bwCurrentBotName').textContent === '主图视觉专家');
    assert.equal(await page.locator('#bwCurrentBotName').textContent(), '主图视觉专家');
    assert.match(await page.locator('#bwModelPill').textContent(), /beta-1/);

    // 4. 在新 Bot 发送消息，再切回总管理确认聊天互相隔离
    await page.locator('#bwInput').fill('帮我评估这张主图构图');
    await page.locator('#bwSendBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#bwMessages .bw-msg').length >= 1);
    await page.locator('#bwBotList [data-bw-bot="bot_manager"]').click();
    await page.waitForFunction(() => document.getElementById('bwCurrentBotName').textContent === '小美总管理');
    assert.equal(await page.locator('#bwMessages .bw-msg').count(), 0, 'manager chat must stay isolated from specialist bot');

    // 5. 归档并恢复专业 Bot
    const specId = await page.locator('#bwBotList [data-bw-bot]:not([data-bw-bot="bot_manager"])').getAttribute('data-bw-bot');
    await page.locator(`#bwBotList [data-bw-bot="${specId}"]`).click();
    await page.locator('#bwSettingsBtn').click();
    await page.locator('[data-bw-tab="permissions"]').click();
    await page.locator('#bwArchiveBotBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#bwBotList [data-bw-bot]').length === 1);

    await page.locator('#bwShowArchived').check();
    await page.waitForFunction(() => document.querySelectorAll('#bwBotList [data-bw-bot]').length === 2);
    await page.locator(`#bwBotList [data-bw-bot="${specId}"]`).click();
    await page.locator(`[data-bw-restore-bot="${specId}"]`).click();
    await page.locator('#bwShowArchived').uncheck();
    await page.waitForFunction(() => document.querySelectorAll('#bwBotList [data-bw-bot]').length === 2);

    // 6. 切换经典 Agent 并切回新版工作区
    await page.locator('#bwClassicBtn').click();
    assert.equal(await page.locator('#canvasAgentPanel').evaluate((el) => el.classList.contains('bot-workspace-active')), false);
    assert.equal(await page.locator('#canvasAgentSwitchBotWorkspace').isVisible(), true);
    await page.locator('#canvasAgentSwitchBotWorkspace').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentPanel')?.classList.contains('bot-workspace-active'));

    // 7. 折叠整个面板
    await page.locator('#bwCollapsePanelBtn').click();
    assert.equal(await page.locator('#canvasAgentPanel').evaluate((el) => el.hidden || el.classList.contains('is-collapsed') || getComputedStyle(el).display === 'none'), true);

    assert.deepEqual(errors, []);
});
