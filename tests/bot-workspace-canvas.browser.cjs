const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('P3 右侧工作区展示临时子 Agent 进度、审批联动、复用 CanvasMultiAgentBridge 执行与节点定位', { timeout: 30000 }, async (t) => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());

    let approved = false;
    let claimed = false;
    let receiptPayload = null;
    let resolveReceipt;
    const receiptReceived = new Promise((resolve) => { resolveReceipt = resolve; });
    let approvalCalled = false;

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.hostname !== 'bot-workspace-p3.test') return route.abort();

        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: pixel });
        if (url.pathname === '/api/config') {
            return route.fulfill({
                json: {
                    api_providers: [{ id: 'prov_a', name: '平台A', enabled: true, protocol: 'openai', chat_models: ['alpha-1'], image_models: ['img-1'] }],
                    comfy_instances: [],
                },
            });
        }
        if (url.pathname === '/api/canvases/bw-p3') {
            return route.fulfill({
                json: {
                    canvas: {
                        id: 'bw-p3',
                        title: 'P3画布融合测试',
                        project: 'default',
                        nodes: [],
                        connections: [],
                        logs: [],
                        settings: { engine: 'api', provider_id: 'prov_a', model: 'img-1', count: 1 },
                    },
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/config') {
            return route.fulfill({
                json: {
                    feature_flags: { enabled: true },
                    manager_bot_id: 'bot_manager',
                    providers: [{ id: 'prov_a', name: '平台A', protocol: 'openai', chat_models: ['alpha-1'], image_models: ['img-1'], video_models: [] }],
                    skills: [],
                    avatar_shapes: ['star', 'bunny'],
                    tools: { all: ['bot.list', 'canvas.dispatch_run'], specialist_max: ['bot.list', 'canvas.read'] },
                    latest_event_seq: 1,
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/events') {
            return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: ready\ndata: {"cursor":1}\n\n' });
        }
        if (url.pathname === '/api/bot-workspace/canvas-presence') return route.fulfill({ json: { ok: true } });
        if (url.pathname === '/api/bot-workspace/bots') {
            return route.fulfill({
                json: {
                    bots: [{
                        bot_id: 'bot_manager', name: '小美总管理', avatar: { text: '总', color: '#2F6F5E', shape: 'star' },
                        role: '总管理 Bot', is_manager: true, status: 'active',
                        chat_model: { provider_id: 'prov_a', model: 'alpha-1' }, vision_model: {}, image_model: {},
                        model_params: {}, tool_permissions: ['canvas.dispatch_run'], delegation_policy: { allow_delegate: true },
                        canvas_policy: { allow_canvas_read: true, allow_canvas_writes: true }, skills: [], active_turn_count: 1,
                    }],
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/bots/bot_manager/sessions') {
            return route.fulfill({ json: { sessions: [{ session_id: 'ses_p3', bot_id: 'bot_manager', title: '画布融合会话', kind: 'chat', archived: false, pinned: true }] } });
        }
        if (url.pathname === '/api/bot-workspace/bots/bot_manager/memories') return route.fulfill({ json: { memories: [] } });
        if (url.pathname === '/api/bot-workspace/sessions/ses_p3/messages') {
            return route.fulfill({
                json: {
                    session: { session_id: 'ses_p3', bot_id: 'bot_manager', title: '画布融合会话', kind: 'chat' },
                    messages: [
                        {
                            message_id: 'm1', session_id: 'ses_p3', bot_id: 'bot_manager', seq: 1,
                            role: 'bot', kind: 'result', content: '已在画布上规划好新绘画节点。',
                            attachments: [], meta: { result_refs: [{ kind: 'node', id: 'node_p3_focus' }] },
                        },
                    ],
                    turns: [{ turn_id: 'trn_p3', status: approved ? 'waiting_result' : 'waiting_approval' }],
                    approvals: approved ? [] : [{
                        approval_id: 'apr_p3_1', bot_id: 'bot_manager', session_id: 'ses_p3', turn_id: 'trn_p3',
                        multi_agent_run_id: 'mar_p3_1', multi_agent_action_id: 'maa_p3_1',
                        tool_name: 'canvas.create_node', summary: '在画布创建主图绘画节点', status: 'pending',
                    }],
                    run_links: [{
                        link_id: 'rlk_1', bot_id: 'bot_manager', session_id: 'ses_p3', turn_id: 'trn_p3',
                        multi_agent_run_id: 'mar_p3_1', project_id: 'default', canvas_id: 'bw-p3', status: 'running',
                    }],
                    run_snapshots: [{
                        multi_agent_run_id: 'mar_p3_1', bot_id: 'bot_manager', turn_id: 'trn_p3',
                        project_id: 'default', canvas_id: 'bw-p3', status: 'running', recovery_required: false,
                        temporary_subagents: [{ task_id: 'mat_sub_1', role: '构图临时助手', goal: '分析构图', status: 'running', is_temporary_subagent: true }],
                        actions: [{ action_id: 'maa_p3_1', tool: 'canvas.create_node', status: approved ? 'registered' : 'awaiting_approval', approved, node_ids: [] }],
                    }],
                },
            });
        }
        if (url.pathname === '/api/bot-workspace/approvals/apr_p3_1/resolve' && req.method() === 'POST') {
            approvalCalled = true;
            approved = true;
            return route.fulfill({ json: { approval: { approval_id: 'apr_p3_1', status: 'approved' } } });
        }
        if (url.pathname === '/api/canvas-agent/multi/runs/mar_p3_1' && req.method() === 'GET') {
            return route.fulfill({
                json: {
                    run: { run_id: 'mar_p3_1', status: 'running', recovery_required: false },
                    actions: [{
                        action_id: 'maa_p3_1',
                        status: receiptPayload ? 'completed' : 'registered',
                        approved,
                        operation: { tool: 'canvas.create_node', target: { node_id: '' }, args: { type: 'smart-paint', title: 'P3融合节点' } },
                    }],
                },
            });
        }
        if (url.pathname === '/api/canvas-agent/multi/runs/mar_p3_1/actions/maa_p3_1/claim' && req.method() === 'POST') {
            claimed = true;
            return route.fulfill({
                json: {
                    action: {
                        action_id: 'maa_p3_1',
                        run_id: 'mar_p3_1',
                        project_id: 'default',
                        canvas_id: 'bw-p3',
                        approved: true,
                        lease_token: 'lease_xyz',
                        operation: { tool: 'canvas.create_node', target: { node_id: '' }, args: { type: 'smart-paint', title: 'P3融合节点' } },
                    },
                },
            });
        }
        if (url.pathname === '/api/canvas-agent/multi/runs/mar_p3_1/actions/maa_p3_1/receipt' && req.method() === 'POST') {
            receiptPayload = req.postDataJSON();
            resolveReceipt(receiptPayload);
            return route.fulfill({ json: { ok: true } });
        }

        return route.fulfill({ json: { skills: [], categories: [], items: [], workflows: [], batches: [], runs: [] } });
    });

    await page.goto('http://bot-workspace-p3.test/static/smart-canvas.html?id=bw-p3');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'P3画布融合测试');
    await page.evaluate(() => {
        window.__p3FocusCalls = [];
        const origFocus = window.CanvasMultiAgentBridge?.focus;
        if (window.CanvasMultiAgentBridge) {
            window.CanvasMultiAgentBridge.focus = (id) => {
                window.__p3FocusCalls.push(id);
                return origFocus?.(id);
            };
        }
    });
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentPanel')?.classList.contains('bot-workspace-active'));

    // 1. 临时子 Agent 状态横幅清晰展示，且左侧 Bot 列表依然只有唯一持久 Bot
    await page.waitForSelector('[data-bw-run-id="mar_p3_1"]');
    assert.match(await page.locator('[data-bw-run-id="mar_p3_1"]').textContent(), /临时子 Agent.*构图临时助手/);
    assert.equal(await page.locator('#bwBotList [data-bw-bot]').count(), 1);

    // 2. 点击「定位画布节点」验证调用 CanvasMultiAgentBridge.focus
    await page.locator('[data-bw-focus-node="node_p3_focus"]').click();
    const focused = await page.evaluate(() => window.__p3FocusCalls);
    assert.deepEqual(focused, ['node_p3_focus']);

    // 3. 点击审批「允许」→ 自动触发 CanvasMultiAgentBridge claim -> execute -> receipt 并在画布真实创建节点
    await page.locator('[data-bw-approve="apr_p3_1"]').click();
    await page.waitForFunction(() => (typeof nodes !== 'undefined') && nodes.some((n) => n.title === 'P3融合节点'));
    await receiptReceived;
    assert.equal(approvalCalled, true);
    assert.equal(claimed, true);
    assert.ok(receiptPayload && receiptPayload.status === 'applied' && receiptPayload.node_ids.length === 1);

    assert.deepEqual(errors, []);
});
