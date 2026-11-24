const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('P2 自然语言创建 Bot 实时显示、Skill 绑定、独立长期记忆管理与权限边界展示', { timeout: 30000 }, async (t) => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());

    const bots = [
        {
            bot_id: 'bot_manager',
            name: '小美总管理',
            avatar: { text: '总', color: '#2F6F5E', shape: 'star' },
            role: '唯一默认总管理 Bot',
            system_instructions: '',
            personality: '',
            is_manager: true,
            status: 'active',
            chat_model: { provider_id: 'prov_a', model: 'alpha-1' },
            vision_model: { provider_id: '', model: '' },
            image_model: { provider_id: '', model: '' },
            model_params: {},
            tool_permissions: ['bot.list', 'bot.create', 'bot.read', 'bot.update', 'bot.archive', 'bot.restore', 'bot.delegate', 'memory.read', 'memory.remember', 'canvas.read'],
            delegation_policy: { allow_delegate: true },
            canvas_policy: { allow_canvas_read: true, allow_canvas_writes: true },
            skills: [],
            active_turn_count: 0,
        },
    ];
    const sessions = {
        bot_manager: [{ session_id: 'ses_mgr', bot_id: 'bot_manager', title: '默认工作会话', kind: 'chat', archived: false, pinned: true }],
    };
    const messages = { ses_mgr: [] };
    const memories = { bot_manager: [] };

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.hostname !== 'bot-workspace-p2.test') return route.abort();

        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: pixel });
        if (url.pathname === '/api/config') {
            return route.fulfill({ json: { api_providers: [{ id: 'prov_a', name: '平台A', enabled: true, protocol: 'openai', chat_models: ['alpha-1'], image_models: [] }], comfy_instances: [] } });
        }
        if (url.pathname === '/api/canvases/bw-p2') {
            return route.fulfill({ json: { canvas: { id: 'bw-p2', title: 'P2测试画布', project: 'proj_p2', nodes: [], connections: [], logs: [], settings: {} } } });
        }
        if (url.pathname === '/api/bot-workspace/config') {
            return route.fulfill({
                json: {
                    feature_flags: { enabled: true },
                    manager_bot_id: 'bot_manager',
                    providers: [{ id: 'prov_a', name: '平台A', protocol: 'openai', chat_models: ['alpha-1'], image_models: [], video_models: [] }],
                    skills: [
                        { id: 'sk_main_copy', name: '主图卖点拆解', description: '提炼三句电商核心卖点', enabled: true },
                        { id: 'sk_detail_layout', name: '详情页分段规划', description: '规划转化节奏', enabled: true },
                    ],
                    avatar_shapes: ['star', 'bunny', 'moon'],
                    tools: {
                        all: ['bot.list', 'bot.create', 'bot.read', 'bot.update', 'bot.archive', 'bot.restore', 'bot.delegate', 'memory.read', 'memory.remember', 'canvas.read'],
                        specialist_max: ['bot.list', 'bot.read', 'bot.delegate', 'memory.read', 'memory.remember', 'canvas.read'],
                    },
                    latest_event_seq: 1,
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/events') {
            return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: ready\ndata: {"cursor":1}\n\n' });
        }
        if (url.pathname === '/api/bot-workspace/canvas-presence') return route.fulfill({ json: { ok: true } });
        if (url.pathname === '/api/bot-workspace/bots' && req.method() === 'GET') return route.fulfill({ json: { bots } });

        const skillsMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/skills$/);
        if (skillsMatch && req.method() === 'PUT') {
            const target = bots.find((b) => b.bot_id === skillsMatch[1]);
            const body = req.postDataJSON();
            target.skills = (body.skills || []).map((id) => ({ skill_id: id, mode: 'pinned', priority: 100, enabled: true }));
            return route.fulfill({ json: { bot_id: target.bot_id, skills: target.skills } });
        }

        const memMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/memories$/);
        if (memMatch && req.method() === 'GET') return route.fulfill({ json: { memories: memories[memMatch[1]] || [] } });
        if (memMatch && req.method() === 'POST') {
            const body = req.postDataJSON();
            const rec = { memory_id: `mem_${Date.now()}`, bot_id: memMatch[1], scope: body.scope || 'bot', source: '用户', content: body.content };
            memories[memMatch[1]] = [rec, ...(memories[memMatch[1]] || [])];
            return route.fulfill({ json: { memory: rec, created: true } });
        }
        const memDelMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/memories\/([^/]+)$/);
        if (memDelMatch && req.method() === 'DELETE') {
            memories[memDelMatch[1]] = (memories[memDelMatch[1]] || []).filter((m) => m.memory_id !== memDelMatch[2]);
            return route.fulfill({ json: { ok: true } });
        }

        const sessMatch = url.pathname.match(/^\/api\/bot-workspace\/bots\/([^/]+)\/sessions$/);
        if (sessMatch && req.method() === 'GET') return route.fulfill({ json: { sessions: sessions[sessMatch[1]] || [] } });

        const msgMatch = url.pathname.match(/^\/api\/bot-workspace\/sessions\/([^/]+)\/messages$/);
        if (msgMatch && req.method() === 'GET') {
            const sid = msgMatch[1];
            const sess = Object.values(sessions).flat().find((s) => s.session_id === sid);
            return route.fulfill({ json: { session: sess, messages: messages[sid] || [], turns: [], approvals: [], run_links: [] } });
        }
        if (msgMatch && req.method() === 'POST') {
            const sid = msgMatch[1];
            const body = req.postDataJSON();
            const uMsg = { message_id: 'm_u1', session_id: sid, bot_id: 'bot_manager', seq: 1, role: 'user', kind: 'text', content: body.content, attachments: [], meta: {} };
            // 模拟总管理通过 bot.create 自然语言创建了新的永久 Bot
            const newBot = {
                bot_id: 'bot_nl_copywriter',
                name: '电商卖点文案师',
                avatar: { text: '文', color: '#3C6E9F', shape: 'bunny' },
                role: '负责电商主图卖点提炼',
                system_instructions: '先提炼三句高转化卖点',
                personality: '直接干练',
                is_manager: false,
                status: 'active',
                chat_model: { provider_id: 'prov_a', model: 'alpha-1' },
                vision_model: { provider_id: '', model: '' },
                image_model: { provider_id: '', model: '' },
                model_params: {},
                tool_permissions: ['bot.list', 'bot.read', 'memory.read', 'memory.remember', 'canvas.read'],
                delegation_policy: { allow_delegate: false },
                canvas_policy: { allow_canvas_read: true, allow_canvas_writes: false },
                skills: [],
                active_turn_count: 0,
            };
            bots.push(newBot);
            sessions[newBot.bot_id] = [{ session_id: 'ses_cw', bot_id: newBot.bot_id, title: '默认会话', kind: 'chat', archived: false, pinned: true }];
            messages.ses_cw = [];
            memories[newBot.bot_id] = [];

            const toolMsg = {
                message_id: 'm_t1', session_id: sid, bot_id: 'bot_manager', seq: 2, role: 'tool', kind: 'task_card',
                content: '已创建永久 Bot「电商卖点文案师」（bot_nl_copywriter）',
                attachments: [],
                meta: { tool: 'bot.create', ok: true, created_bot_id: 'bot_nl_copywriter', created_bot_name: '电商卖点文案师' },
            };
            messages[sid] = [uMsg, toolMsg];
            return route.fulfill({ json: { message: uMsg, turn: { turn_id: 'trn_1', status: 'completed' }, created: true } });
        }

        return route.fulfill({ json: { skills: [], categories: [], items: [], workflows: [], batches: [], runs: [] } });
    });

    await page.goto('http://bot-workspace-p2.test/static/smart-canvas.html?id=bw-p2');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'P2测试画布');
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentPanel')?.classList.contains('bot-workspace-active'));

    // 1. 自然语言向总管理发送创建 Bot 请求，然后拉回消息与 Bot 列表并点击「打开新 Bot」跳转
    await page.locator('#bwInput').fill('帮我创建一个专门写电商卖点的永久 Bot');
    await page.locator('#bwSendBtn').click();
    await page.evaluate(() => window.BotWorkspaceUI.selectSession('ses_mgr'));
    await page.waitForSelector('[data-bw-jump-bot="bot_nl_copywriter"]');
    await page.locator('[data-bw-jump-bot="bot_nl_copywriter"]').click();
    await page.waitForFunction(() => document.getElementById('bwCurrentBotName').textContent === '电商卖点文案师');

    // 2. 绑定 Skill
    await page.locator('#bwSettingsBtn').click();
    await page.locator('[data-bw-tab="skills"]').click();
    await page.locator('#bwSkillChecks input[value="sk_main_copy"]').check();
    await page.locator('#bwSaveSkillsBtn').click();
    await page.waitForFunction(() => document.getElementById('bwDrawer').hidden === true);

    // 3. 写入并删除独立长期记忆
    await page.locator('#bwSettingsBtn').click();
    await page.locator('[data-bw-tab="memory"]').click();
    await page.locator('#bwMemoryInput').fill('所有卖点文案控制在12字以内');
    await page.locator('#bwMemoryAddForm button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('bwMemoryList').textContent.includes('控制在12字以内'));
    await page.locator('#bwMemoryList [data-bw-del-mem]').first().click();
    await page.waitForFunction(() => !document.getElementById('bwMemoryList').textContent.includes('控制在12字以内'));

    // 4. 权限页：专业 Bot 不显示总管理独占工具 bot.create
    await page.locator('[data-bw-tab="permissions"]').click();
    assert.equal(await page.locator('#bwPermChecks input[value="bot.create"]').count(), 0);
    assert.equal(await page.locator('#bwPermChecks input[value="canvas.read"]').count(), 1);

    assert.deepEqual(errors, []);
});
