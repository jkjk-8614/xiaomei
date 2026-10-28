/**
 * 设计大脑 · Bot 团队浏览器回归（P5）
 *
 * 运行：node --test tests/design-brain-team.browser.cjs
 * 依赖：tools/commerce-analysis/node_modules/playwright（与其它 browser 测试一致）
 *
 * 全部接口在 route 层 mock，不启动后端、不读真实数据：
 * 覆盖首屏渲染、@ 菜单、发送、审批卡、记忆面板、用量浮层、空状态引导、
 * 标签切换与零 pageerror。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

// 9 个模块收成 4 组后，子标签要先点组标签才可见；按用户路径先组后子。
const TAB_GROUP_OF = {cases: 'asset', references: 'asset', experiences: 'asset', profile: 'asset', team: 'team', skills: 'team', runs: 'log', reviews: 'log'};
async function gotoTab(page, tab) {
    await page.click(`.db-group-tab[data-db-group="${TAB_GROUP_OF[tab]}"]`);
    const sub = page.locator(`#tab${tab[0].toUpperCase()}${tab.slice(1)}`);
    if (await sub.isVisible()) await sub.click();
}

const BOTS = [
    {id: 'bot_director', name: '设计总监', role: '理解需求、拆任务、调度团队、汇总交付',
     avatar: {text: '总', color: '#2F6F5E'}, is_main: true, permission: 'full', status: 'active',
     capabilities: ['pack.read', 'pack.plan', 'pack.workflow', 'pack.team', 'pack.memory'],
     model: {provider: 'demo', model: 'demo-chat'}, instructions: '你是设计总监，先判断需求再决定是否建任务。'},
    {id: 'bot_reference', name: '参考分析', role: '检索个人参考库，挑选高相关案例',
     avatar: {text: '参', color: '#3C6E9F'}, is_main: false, permission: 'workspace', status: 'active',
     capabilities: ['pack.read', 'pack.plan', 'pack.memory'], model: {provider: '', model: ''}, instructions: ''},
    {id: 'bot_planner', name: '设计规划', role: '制定方案：提示词、尺寸、验收标准',
     avatar: {text: '规', color: '#7A5AA8'}, is_main: false, permission: 'workspace', status: 'active',
     capabilities: ['pack.read', 'pack.plan', 'pack.memory'], model: {provider: '', model: ''}, instructions: ''},
    {id: 'bot_executor', name: '生成执行', role: '按方案提交生图任务并记录参数',
     avatar: {text: '生', color: '#B07A2E'}, is_main: false, permission: 'workspace', status: 'active',
     capabilities: ['pack.execute', 'pack.memory'], model: {provider: '', model: ''}, instructions: ''},
    {id: 'bot_reviewer', name: '质量检查', role: '按验收标准检查结构、材质与构图',
     avatar: {text: '检', color: '#A8463F'}, is_main: false, permission: 'workspace', status: 'active',
     capabilities: ['pack.review', 'pack.memory'], model: {provider: '', model: ''}, instructions: ''},
];
const MEMBERS = BOTS.map((bot) => bot.id);

function group(overrides = {}) {
    return {
        id: 'grp_default', name: '设计项目群', notice: '', admin_bot_id: 'bot_director',
        members: MEMBERS, reply_mode: 'admin_first', relay_limit: 8, archived: false,
        project: {client: '', deadline: '', task_ids: []}, ...overrides,
    };
}

function chat(overrides = {}) {
    return {
        id: 'grp_default', kind: 'group', title: '设计项目群', group_id: 'grp_default', bot_id: '',
        members: MEMBERS, defaults: {chat: {provider: 'demo', model: 'demo-chat'},
                                     vision: {provider: 'demo', model: 'demo-chat'},
                                     image: {provider: 'demo', model: 'demo-image'}},
        seq: 0, last_message_at: 0, paused: false, relay_count: 0, approvals: {}, ...overrides,
    };
}

function message(seq, role, text, extra = {}) {
    return {id: `msg_${seq}`, seq, chat_id: 'grp_default', role, bot_id: '', text,
            at: 1792887000000 + seq * 1000, mentions: [], reply_to: '', kind: 'text',
            status: 'sent', task_id: '', meta: {}, ...extra};
}

function fixture(options = {}) {
    const state = {
        bots: structuredClone(options.bots || BOTS),
        tasks: options.tasks || [],
        work: options.work,
        workStops: [],
        stopFailure: '',
        stopDelay: 0,
        groups: [group(options.group)],
        chats: [chat(options.chat)],
        messages: (options.messages || []).map((item) => ({...item})),
        turn: {running: false, bot_id: '', bot_name: '', started_at: 0, spoken: 0},
        approvals: Object.fromEntries(Object.entries(options.approvals || {})
            .map(([key, value]) => [key, {...value}])),
        settings: {version: 1, memory_review: true, daily_llm_limit: 300,
                   approval_image_threshold: 4, updated_at: 0},
        memory: options.memory || {
            'bot:bot_director': [{index: 0, text: '主图一律用 3:4 竖版', source: '用户', added: '2026-10-25'}],
            'group:grp_default': [{index: 0, text: '客户不接受金色边框', source: '用户', added: '2026-10-25'}],
            'team:team': [{index: 0, text: '详情页默认白底', source: '用户', added: '2026-10-25'}],
        },
        captured: {messages: [], approvals: [], memory: [], settings: []},
    };
    state.chats[0].approvals = state.approvals;
    return state;
}

async function openTeam(t, state) {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1440, height: 980}});
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname !== '127.0.0.1') return route.abort();

        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path: file}) : route.fulfill({status: 404, body: ''});
        }
        if (url.pathname === '/favicon.ico') return route.fulfill({status: 204});

        if (url.pathname === '/api/app-info') return route.fulfill({json: {version: 'test'}});
        if (url.pathname === '/api/providers') return route.fulfill({json: {providers: state.providers || [{
            id: 'demo', name: 'Demo 平台', enabled: true,
            chat_models: ['demo-chat'], image_models: ['demo-image'],
        }]}});
        if (url.pathname === '/api/design-brain/profile') return route.fulfill({json: {
            revision: 1, profile: {aesthetics: {}, tone: {}, task_defaults: {}, privacy: {}, pending_suggestions: []},
        }});
        if (url.pathname === '/api/prompt-cases') return route.fulfill({json: {cases: []}});
        if (url.pathname === '/api/design-brain/references') return route.fulfill({json: {items: [], total: 0, facets: {}}});
        if (url.pathname === '/api/design-brain/experiences') return route.fulfill({json: {experiences: []}});
        if (url.pathname === '/api/design-brain/skills') return route.fulfill({json: {skills: []}});
        if (url.pathname === '/api/design-brain/runs') return route.fulfill({json: {runs: []}});
        if (url.pathname === '/api/design-brain/reviews') return route.fulfill({json: {reviews: []}});
        if (url.pathname === '/api/design-brain/bot/config') return route.fulfill({json: {bots: [], limits: {}}});
        if (url.pathname === '/api/design-brain/bot/tasks') return route.fulfill({json: {tasks: state.tasks}});

        if (url.pathname === '/api/design-brain/team') return route.fulfill({json: {
            bots: state.bots, groups: state.groups, chats: state.chats,
            capabilities: {packs: [], external: {mcp: [], skills: []}},
            limits: {bots: 50, groups: 30, group_members: 12},
        }});
        if (url.pathname === '/api/design-brain/team/work' && state.work !== undefined) {
            return route.fulfill({json: {work: state.work}});
        }
        if (url.pathname === '/api/design-brain/team/work/stop') {
            const body = request.postDataJSON();
            state.workStops.push(body.work_id);
            if (state.stopDelay) await new Promise(resolve => setTimeout(resolve, state.stopDelay));
            if (state.stopFailure) return route.fulfill({status: 502, json: {detail: state.stopFailure}});
            state.work = state.work.filter(item => item.id !== body.work_id);
            return route.fulfill({json: {stopped: true, work_id: body.work_id}});
        }
        if (url.pathname === '/api/design-brain/team/settings') {
            if (request.method() === 'PUT') {
                const body = request.postDataJSON() || {};
                state.captured.settings.push(body);
                Object.assign(state.settings, body);
            }
            return route.fulfill({json: state.settings});
        }
        if (url.pathname === '/api/design-brain/usage') return route.fulfill({json: {
            date: '2026-10-25',
            totals: {llm: 17, tool: 4, image: 2, tokens: 10300},
            chats: [{chat_id: 'grp_default', counts: {llm: 17, tool: 4, image: 2, tokens: 10300}}],
            bots: [{bot_id: 'bot_director', counts: {llm: 12, tool: 3, image: 2, tokens: 8200}}],
            settings: state.settings,
        }});
        if (url.pathname === '/api/design-brain/profile-suggestions') return route.fulfill({json: {
            suggestions: [{id: 'sug_1', kind: 'tag', group: 'composition', tag: '竖构图', weight: 0.8}],
        }});

        const memoryMatch = url.pathname.match(/^\/api\/design-brain\/memory\/(bot|group|team)\/([^/]+)$/);
        if (memoryMatch) {
            const key = `${memoryMatch[1]}:${memoryMatch[2]}`;
            if (request.method() === 'POST') {
                const body = request.postDataJSON() || {};
                state.captured.memory.push({key, ...body});
                state.memory[key] = state.memory[key] || [];
                state.memory[key].push({index: state.memory[key].length, text: body.text,
                                        source: '用户', added: '2026-10-25'});
            }
            const entries = state.memory[key] || [];
            return route.fulfill({json: {
                scope: memoryMatch[1], id: memoryMatch[2], label: '记忆', entries,
                size: 0, limits: {entry: 300, file: 4000, entries: 60},
            }});
        }

        if (url.pathname === '/api/design-brain/chats/grp_default/turn') {
            return route.fulfill({json: state.turn});
        }
        if (url.pathname === '/api/design-brain/chats/grp_default/messages') {
            if (request.method() === 'POST') {
                const body = request.postDataJSON() || {};
                state.captured.messages.push(body);
                const seq = state.messages.length + 1;
                const created = message(seq, 'user', body.text || '', {mentions: body.mentions || [], meta: body.meta || {}});
                state.messages.push(created);
                state.chats[0].seq = seq;
                return route.fulfill({json: {message: created, cursor: seq, turn: {queued: true}}});
            }
            const after = Number(url.searchParams.get('after') || 0);
            const pending = state.messages.filter((item) => item.seq > after);
            return route.fulfill({json: {
                chat: state.chats[0], messages: pending,
                cursor: pending.length ? pending[pending.length - 1].seq : after,
                has_more: false,
            }});
        }
        const approvalMatch = url.pathname.match(/^\/api\/design-brain\/chats\/grp_default\/approvals\/([^/]+)$/);
        if (approvalMatch) {
            const body = request.postDataJSON() || {};
            state.captured.approvals.push({id: approvalMatch[1], ...body});
            const approval = state.approvals[approvalMatch[1]];
            if (approval) approval.status = body.approve ? 'approved' : 'rejected';
            return route.fulfill({json: {approval, executed: Boolean(body.approve)}});
        }

        return route.fulfill({status: 404, body: ''});
    });

    await page.goto('http://127.0.0.1:3000/static/design-brain.html', {waitUntil: 'networkidle'});
    await gotoTab(page, 'team');
    await page.waitForTimeout(400);
    return {page, errors, state};
}

const BASIC_MESSAGES = [
    message(1, 'user', '给这个胡桃木相框做一套主图'),
    message(2, 'bot', '收到。@参考分析 先找两个浅底木作案例。', {bot_id: 'bot_director'}),
    message(3, 'bot', '找到 3 个高相关案例：浅灰渐变底、侧逆光木纹特写、留白构图。', {bot_id: 'bot_reference'}),
];

async function mockBotProfileWrites(page, state) {
    state.botWrites = [];
    await page.route('**/api/design-brain/bots**', async route => {
        const request = route.request();
        const payload = request.postDataJSON();
        state.botWrites.push(payload);
        if (state.botSaveFailure) return route.fulfill({status: 503, json: {detail: state.botSaveFailure}});
        const id = new URL(request.url()).pathname.split('/')[4];
        let bot = state.bots.find(item => item.id === id);
        if (!bot) {
            bot = {...BOTS[1], id: 'bot_custom', name: payload.name};
            state.bots.push(bot);
        }
        Object.assign(bot, payload);
        return route.fulfill({json: bot});
    });
}

async function editGroupBot(page, id = 'bot_director') {
    if (!await page.locator('#teamInspector').isVisible()) await page.click('#teamInspectorToggle');
    await page.click(`[data-team-edit-bot="${id}"]`);
    await page.waitForSelector('#teamBotPersonality');
}

test('BOT 自定义造型、颜色、人格和任务，保存后刷新读回，旧说明保留', async t => {
    const state = fixture();
    const {page, errors} = await openTeam(t, state);
    await mockBotProfileWrites(page, state);
    await editGroupBot(page);
    await page.click('[data-avatar-shape="bunny"]');
    await page.locator('#teamBotAvatarColor').evaluate(input => { input.value = '#b56347'; input.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.fill('#teamBotPersonality', '挑剔但热心，敢于追问');
    await page.fill('#teamBotTask', '先找出一个方案问题，再给出具体改法');
    const originalInstructions = await page.inputValue('#teamBotInstructions');
    assert.equal(await page.locator('#teamBotAvatarPreview [data-character]').getAttribute('data-character'), 'bunny');
    assert.equal(await page.locator('.team-avatar-choice[aria-pressed="true"]').count(), 1);
    if (process.env.XIAOMEI_BOT_PROFILE_SHOTS) {
        fs.mkdirSync(process.env.XIAOMEI_BOT_PROFILE_SHOTS, {recursive: true});
        await page.screenshot({path: path.join(process.env.XIAOMEI_BOT_PROFILE_SHOTS, 'bot-editor.png')});
    }
    await page.locator('#teamBotSave').evaluate(button => { button.click(); button.click(); });
    await page.waitForSelector('#teamBotSave', {state: 'detached'});
    assert.equal(state.botWrites.length, 1);
    assert.equal(state.botWrites[0].instructions, originalInstructions);
    assert.equal(state.botWrites[0].personality, '挑剔但热心，敢于追问');
    assert.equal(state.botWrites[0].task, '先找出一个方案问题，再给出具体改法');
    assert.equal(state.botWrites[0].avatar.color, '#b56347');
    assert.match(await page.textContent('#teamSideBody'), /先找出一个方案问题/);
    await page.reload({waitUntil: 'networkidle'});
    await editGroupBot(page);
    assert.equal(await page.inputValue('#teamBotPersonality'), '挑剔但热心，敢于追问');
    assert.equal(await page.inputValue('#teamBotInstructions'), originalInstructions);
    assert.equal(await page.locator('[data-avatar-shape="bunny"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
});

test('BOT 上传头像显示在群头像与聊天中，刷新保留，使用小人可清除图片', async t => {
    const state = fixture({messages: BASIC_MESSAGES});
    const {page, errors} = await openTeam(t, state);
    await mockBotProfileWrites(page, state);
    await editGroupBot(page);
    const source = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
        const context = canvas.getContext('2d'); context.fillStyle = '#C88158'; context.fillRect(0, 0, 400, 200);
        context.fillStyle = '#275C4C'; context.fillRect(125, 25, 150, 150);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#teamBotAvatarFile', {name: '头像.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64')});
    await page.waitForFunction(() => document.querySelector('#teamBotAvatarPreview img')?.naturalWidth === 256);
    const image = await page.locator('#teamBotAvatarPreview img').getAttribute('src');
    assert.match(image, /^data:image\/webp;base64,/);
    await page.click('#teamBotSave');
    await page.waitForSelector('#teamBotSave', {state: 'detached'});
    assert.equal(await page.locator('#teamGroupList .team-photo img').count(), 1);
    assert.equal(await page.locator('#teamMessages .team-photo img').getAttribute('src'), image);
    const groupPhoto = await page.locator('#teamGroupList .team-photo').boundingBox();
    assert.ok(groupPhoto.width <= 17 && groupPhoto.height <= 17);
    state.turn = {running: true, bot_id: 'bot_director', bot_name: '设计总监', started_at: Date.now(), activity: 'thinking', activity_label: '正在思考'};
    await page.waitForFunction(() => document.querySelector('#teamSideBody .team-photo')?.dataset.state === 'thinking');
    assert.equal(await page.locator('#teamMessages .team-photo').getAttribute('data-state'), 'idle');
    state.turn = {running: false};
    await page.waitForFunction(() => document.querySelector('#teamSideBody .team-photo')?.dataset.state === 'idle');
    await page.reload({waitUntil: 'networkidle'});
    assert.equal(await page.locator('#teamMessages .team-photo img').getAttribute('src'), image);
    await editGroupBot(page);
    await page.click('#teamBotAvatarReset');
    assert.equal(await page.locator('#teamBotAvatarPreview img').count(), 0);
    await page.click('[data-avatar-shape="kitty"]');
    await page.click('#teamBotSave');
    await page.waitForSelector('#teamBotSave', {state: 'detached'});
    assert.equal(await page.locator('#teamGroupList .team-photo img').count(), 0);
    assert.equal(state.bots[0].avatar.shape, 'kitty');
    assert.ok(!state.bots[0].avatar.image);
    assert.deepEqual(errors, []);
});

test('BOT 保存与头像读取失败保留输入，可重试，窄屏和深色下能完成编辑', async t => {
    const state = fixture();
    const {page, errors} = await openTeam(t, state);
    await mockBotProfileWrites(page, state);
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.postMessage({type: 'studio-theme', theme: 'dark'}, location.origin));
    await editGroupBot(page);
    await page.fill('#teamBotPersonality', '安静，喜欢用事实说话');
    await page.fill('#teamBotTask', '检查产品结构');
    await page.click('[data-avatar-shape="moon"]');
    await page.setInputFiles('#teamBotAvatarFile', {name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken image')});
    await page.waitForFunction(() => document.querySelector('#teamBotStatus').textContent.includes('无法读取'));
    assert.equal(await page.locator('#teamBotAvatarPreview [data-character]').getAttribute('data-character'), 'moon');
    state.botSaveFailure = '保存失败，请稍后重试';
    await page.click('#teamBotSave');
    await page.waitForFunction(() => document.querySelector('#teamBotStatus').textContent.includes('保存失败'));
    assert.equal(await page.inputValue('#teamBotPersonality'), '安静，喜欢用事实说话');
    assert.equal(await page.inputValue('#teamBotTask'), '检查产品结构');
    assert.equal(await page.locator('#teamBotSave').isEnabled(), true);
    if (process.env.XIAOMEI_BOT_PROFILE_SHOTS) {
        await page.screenshot({path: path.join(process.env.XIAOMEI_BOT_PROFILE_SHOTS, 'bot-editor-mobile-failure.png')});
    }
    state.botSaveFailure = '';
    await page.click('#teamBotSave');
    await page.waitForSelector('#teamBotSave', {state: 'detached'});
    assert.equal(state.bots[0].personality, '安静，喜欢用事实说话');
    assert.equal(state.botWrites.length, 2);
    assert.deepEqual(errors, []);
});

test('新建自定义 BOT 后可在建群设置选择，并启用全员轮流', async t => {
    const state = fixture();
    const {page, errors} = await openTeam(t, state);
    await mockBotProfileWrites(page, state);
    await page.click('#teamRoster > summary');
    await page.click('#teamNewBot');
    await page.fill('#teamBotName', '挑剔的小猫');
    await page.fill('#teamBotRole', '方案质疑者');
    await page.fill('#teamBotPersonality', '直率，要求证据');
    await page.fill('#teamBotTask', '指出每个方案的一个缺点');
    await page.click('[data-avatar-shape="kitty"]');
    await page.click('#teamBotSave');
    await page.waitForSelector('#teamBotSave', {state: 'detached'});
    assert.equal(state.bots.at(-1).personality, '直率，要求证据');
    await page.click('#teamNewGroup');
    await page.fill('#teamGroupName', '小人讨论组');
    await page.click('.team-project-options > summary');
    await page.selectOption('#teamGroupMode', 'round_robin');
    for (const checkbox of await page.locator('#teamSideBody .team-checks input').all()) await checkbox.uncheck();
    await page.check('#teamSideBody .team-checks input[value="bot_custom"]');
    await page.check('#teamSideBody .team-checks input[value="bot_director"]');
    let groupPayload;
    await page.route('**/api/design-brain/groups', async route => {
        groupPayload = route.request().postDataJSON();
        const createdGroup = group({id: 'grp_custom', ...groupPayload});
        const createdChat = chat({id: 'grp_custom', title: groupPayload.name, group_id: 'grp_custom', members: groupPayload.members});
        state.groups.push(createdGroup); state.chats.push(createdChat);
        await route.fulfill({json: {group: createdGroup, chat: createdChat}});
    });
    await page.route('**/api/design-brain/chats/grp_custom/**', route => route.fulfill({json: route.request().url().includes('/messages') ? {chat: state.chats.at(-1), messages: [], cursor: 0} : {running: false}}));
    await page.click('#teamGroupSave');
    await page.waitForFunction(() => document.querySelector('#teamTitle').textContent === '小人讨论组');
    assert.equal(groupPayload.reply_mode, 'round_robin');
    assert.deepEqual(groupPayload.members, ['bot_director', 'bot_custom']);
    await page.click('#teamInspectorToggle');
    assert.match(await page.textContent('#teamSideBody'), /指出每个方案的一个缺点/);
    assert.deepEqual(errors, []);
});

test('首屏渲染：成员、消息与 @ 高亮', async (t) => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    assert.equal(await page.locator('#teamBotList .team-side-item').count(), 5);
    assert.equal(await page.locator('#teamGroupList .team-side-item').count(), 1);
    assert.equal(await page.locator('#teamTitle').textContent(), '设计项目群');
    assert.equal(await page.locator('#teamMessages .team-row').count(), 3);
    assert.ok(await page.locator('#teamMessages .team-at').count() >= 1, '@ 名字应高亮');
    assert.deepEqual(errors, []);
});

test('讨论与输入区随可用宽度伸展且窄屏不溢出', async t => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    for (const [width, height, theme] of [[1920, 1000, 'light'], [1366, 768, 'dark'], [640, 640, 'light']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(theme => window.postMessage({type: 'studio-theme', theme}, location.origin), theme);
        await page.waitForTimeout(120);
        // 自动缩放会在 resize 后更新；在同一帧读取布局，避免混用两次缩放的坐标。
        const snapshot = await page.waitForFunction(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            const main = rect('.team-main'), composer = rect('.team-composer'), toolbar = rect('.db-toolbar');
            const buttons = Object.fromEntries(['tabTeam', 'tabSkills', 'teamWorkToggle', 'teamUsage', 'teamInspectorToggle', 'studioWorkspaceToggle']
                .map(id => [id, rect(`#${id}`)]));
            const within = box => box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width + 1
                && box.y >= toolbar.y && box.y + box.height <= toolbar.y + toolbar.height + 1;
            return composer.width >= Math.min(850, main.width - 60) && Object.values(buttons).every(within)
                ? {main, composer, toolbar, buttons} : false;
        });
        const {main, composer, toolbar, buttons} = await snapshot.jsonValue();
        assert.ok(composer.width >= Math.min(850, main.width - 60), `${width}: 输入框应保留足够的书写空间`);
        assert.ok(main.width - composer.width <= 64, `${width}: 输入区两侧不应留下大块空白`);
        const botRow = await page.locator('#teamMessages .team-row.bot').first().boundingBox();
        assert.ok(botRow.x - main.x <= 32, `${width}: 消息应靠近工作区左侧，不能居中留出大块空白`);
        assert.ok(main.width - botRow.width <= 80, `${width}: 消息应使用工作区可用宽度`);
        assert.equal(await page.locator('.team-composer-meta').isVisible(), false, '没有状态时不保留底部空行');
        assert.equal(await page.locator('.team-composer .team-key-hint, .team-composer .studio-attach-hint').count(), 0);
        if (width >= 1366) assert.ok(composer.height <= 150, '默认输入区应保持紧凑');
        for (const id of ['tabTeam', 'tabSkills', 'teamWorkToggle', 'teamUsage', 'teamInspectorToggle', 'studioWorkspaceToggle']) {
            const box = buttons[id];
            assert.ok(box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width + 1 && box.y >= toolbar.y && box.y + box.height <= toolbar.y + toolbar.height + 1, `${width}: ${id} 应位于顶部工具栏内`);
        }
        assert.ok(toolbar.height <= (width > 760 ? 76 : 120), '顶部工具栏应保持紧凑');
        assert.ok(await page.locator('#teamMessages').evaluate(el => el.clientHeight > 200), '对话需保留足够的阅读高度');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.DESIGN_BRAIN_SCREENSHOT_DIR) await page.screenshot({path: path.join(process.env.DESIGN_BRAIN_SCREENSHOT_DIR, `design-brain-layout-${width}.png`)});
    }
    await page.setViewportSize({width: 1440, height: 980});
    await page.click('#studioWorkspaceToggle');
    assert.equal(await page.locator('#studioPanel').isVisible(), true);
    await page.click('#studioWorkspaceClose');
    await gotoTab(page, 'skills');
    assert.equal(await page.locator('#teamHeaderActions').isVisible(), false);
    await gotoTab(page, 'cases');
    assert.equal(await page.locator('#dbPageTitle').isVisible(), true);
    await gotoTab(page, 'team');
    assert.equal(await page.locator('#teamHeaderActions').isVisible(), true);
    assert.deepEqual(errors, []);
});

test('结果卡与审批卡随消息区展开，打开侧栏及窄屏时不溢出', async t => {
    const {page, errors} = await openTeam(t, fixture({messages: [
        message(1, 'bot', '需要确认相框卡纸与照片组合。', {bot_id: 'bot_director', kind: 'result'}),
        message(2, 'bot', '确认后开始制作十五张商品图。', {bot_id: 'bot_director', kind: 'approval', meta: {approval_id: 'layout_approval'}}),
    ]}));
    for (const [width, height, scale] of [[1920, 1000, '100'], [1366, 768, '100'], [1024, 640, '125'], [390, 844, '100']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(scale => window.StudioScale.set(scale), scale);
        const visualScale = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).zoom) || 1);
        for (const sidebar of ['closed', 'open']) {
            if (sidebar === 'open') await page.click('#teamInspectorToggle');
            const main = await page.locator('.team-main').boundingBox();
            for (const card of await page.locator('#teamMessages .team-card').all()) {
                const box = await card.boundingBox();
                assert.ok(main.width - box.width <= 130 * visualScale, `${width}/${sidebar}: 卡片不应固定在 520px 窄列`);
                assert.ok(box.x >= main.x && box.x + box.width <= main.x + main.width, '卡片不能溢出消息区');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
        await page.click('#teamInspectorClose');
    }
    assert.deepEqual(errors, []);
});

test('@ 菜单：列出成员并回车插入', async (t) => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.locator('#teamInput').click();
    await page.keyboard.type('@');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#teamMentionMenu .team-mention-item').count(), 5);
    assert.match(await page.locator('.team-mention-foot').textContent(), /回车插入/);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#teamInput').inputValue(), '@设计总监 ');
    assert.deepEqual(errors, []);
});

test('发送：带上被 @ 的成员 id', async (t) => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.locator('#teamInput').fill('@设计总监 再出一版竖构图');
    await page.locator('#teamSend').click();
    await page.waitForTimeout(300);
    assert.equal(state.captured.messages.length, 1);
    assert.equal(state.captured.messages[0].text, '@设计总监 再出一版竖构图');
    assert.deepEqual(state.captured.messages[0].mentions, ['bot_director']);
    assert.ok(await page.locator('#teamMessages .team-row').count() >= 4);
});

test('设计团队发送共享 Skill 选择，清除后恢复自动匹配', async t => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.evaluate(() => StudioSharedSkill.setSelected('main-image'));
    await page.locator('#teamInput').fill('给商品策划一张主图');
    await page.locator('#teamSend').click();
    await page.waitForFunction(() => document.getElementById('teamSendStatus').textContent === '');
    assert.equal(state.captured.messages[0].meta.skill_id, 'main-image');
    await page.evaluate(() => StudioSharedSkill.setSelected(''));
    await page.locator('#teamInput').fill('再讨论一下构图');
    await page.locator('#teamSend').click();
    await page.waitForFunction(() => document.getElementById('teamSendStatus').textContent === '');
    assert.equal(state.captured.messages[1].meta.skill_id, '');
});

test('@所有人：一次点名全部成员', async (t) => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.locator('#teamInput').fill('@所有人 各给一个方向');
    await page.locator('#teamSend').click();
    await page.waitForTimeout(300);
    assert.equal(state.captured.messages.length, 1);
    assert.equal(state.captured.messages[0].mentions.length, 5);
});

test('发送请求延迟时仍能输入下一条，回执不清空新草稿', async (t) => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let posts = 0;
    await page.route('**/api/design-brain/chats/grp_default/messages', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        posts++;
        await pending;
        return route.fulfill({json: {turn: {queued: true}}});
    });
    await page.locator('#teamInput').fill('制作15张相框SKU展示图');
    await page.locator('#teamSend').click();
    await page.waitForFunction(() => document.querySelector('#teamSend').disabled);
    assert.ok(await page.locator('#teamInput').isEditable());
    await page.locator('#teamInput').fill('而且图片要4K');
    await page.locator('#teamInput').press('Control+Enter');
    release();
    await page.waitForFunction(() => !document.querySelector('#teamSend').disabled);
    assert.equal(await page.locator('#teamInput').inputValue(), '而且图片要4K');
    assert.equal(posts, 1);
    assert.deepEqual(errors, []);
});

test('发送失败保留已发送文字与等待时新输入的草稿', async (t) => {
    const {page} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route('**/api/design-brain/chats/grp_default/messages', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        await pending;
        return route.fulfill({status: 502, json: {detail: '暂时无法发送'}});
    });
    await page.locator('#teamInput').fill('制作15张相框图');
    await page.locator('#teamSend').click();
    await page.locator('#teamInput').fill('全部4K');
    release();
    await page.waitForFunction(() => !document.querySelector('#teamSend').disabled);
    assert.equal(await page.locator('#teamInput').inputValue(), '制作15张相框图\n全部4K');
    assert.ok(await page.locator('#teamInput').isEditable());
});

test('中文输入法确认候选词时不触发发送或选择成员', async (t) => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.locator('#teamInput').fill('@');
    await page.waitForFunction(() => !document.querySelector('#teamMentionMenu').hidden);
    await page.locator('#teamInput').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 229, isComposing: true, ctrlKey: true, bubbles: true, cancelable: true,
    })));
    assert.equal(await page.locator('#teamInput').inputValue(), '@');
    assert.equal(state.captured.messages.length, 0);
});

test('历史工具失败可重发原文字、全部图片与点名，使用当前模型并保留草稿', async t => {
    const images = Array.from({length: 25}, (_, index) => `/product-${index}.png`);
    const source = message(1, 'user', '@设计总监 给相框做十五张 SKU 图', {
        mentions: ['bot_director'], meta: {product_images: images},
    });
    const state = fixture({messages: [source,
        message(2, 'bot', '正在生成规划方案', {bot_id: 'bot_director'}),
        message(3, 'system', '「设计总监」调用工具失败：422: 请选择普通 API 对话模型', {kind: 'activity'}),
        message(4, 'user', '继续'),
    ]});
    state.providers = [{id: 'demo', name: 'Demo', enabled: true,
        chat_models: ['demo-chat', 'new-chat'], image_models: ['demo-image']}];
    const {page, errors} = await openTeam(t, state);
    await page.locator('#teamInput').fill('还没写完的下一条需求');
    await page.route('**/api/ai/upload', route => route.fulfill({json: {files: [{url: '/draft.png'}]}}));
    await pasteProductFiles(page, 1);
    await page.waitForFunction(() => document.querySelectorAll('#teamProductImages .studio-thumb').length === 1);
    await page.locator('#teamModelToggle').click();
    await page.locator('#teamChatModel').selectOption('new-chat');
    await page.keyboard.press('Escape');
    const retry = page.getByRole('button', {name: '重新发送', exact: true});
    await retry.click();
    await page.waitForFunction(() => document.querySelectorAll('#teamMessages .team-row.user').length === 3);
    assert.equal(state.captured.messages.length, 1);
    assert.equal(state.captured.messages[0].text, source.text);
    assert.deepEqual(state.captured.messages[0].mentions, source.mentions);
    assert.deepEqual(state.captured.messages[0].meta.product_images, images);
    assert.equal(state.captured.messages[0].models.chat.model, 'new-chat');
    assert.equal(await page.locator('#teamInput').inputValue(), '还没写完的下一条需求');
    assert.equal(await page.locator('#teamProductImages .studio-thumb').count(), 1);
    assert.deepEqual(errors, []);
});

test('增量失败提示支持重发，回合运行时禁用，刷新后仍保留入口', async t => {
    const {page, errors, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    state.turn.running = true;
    state.messages.push(message(4, 'system', '模型调用失败：连接已断开', {
        kind: 'activity', meta: {retryable: true, retry_message_id: 'msg_1'},
    }), message(5, 'system', '本回合已停止。', {kind: 'activity'}));
    const retry = page.getByRole('button', {name: '重新发送', exact: true});
    await retry.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-team-retry]')?.disabled === true);
    assert.equal(await retry.count(), 1);
    state.turn.running = false;
    await page.waitForFunction(() => document.querySelector('[data-team-retry]')?.disabled === false);
    await page.reload({waitUntil: 'networkidle'});
    await retry.waitFor();
    await page.screenshot({path: path.join(require('node:os').tmpdir(), 'xiaomei-team-retry.png')});
    await page.evaluate(() => document.body.classList.add('theme-dark'));
    await page.setViewportSize({width: 900, height: 760});
    await retry.scrollIntoViewIfNeeded();
    assert.equal(await retry.isVisible(), true);
    const bounds = await retry.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 900);
    await page.screenshot({path: path.join(require('node:os').tmpdir(), 'xiaomei-team-retry-dark.png')});
    assert.deepEqual(errors, []);
});

test('重发请求失败后保留入口与草稿，重复点击只发一次，下一次可成功', async t => {
    const source = message(1, 'user', '原来的需求', {meta: {product_images: ['/original.png']}});
    const {page, errors, state} = await openTeam(t, fixture({messages: [source,
        message(2, 'system', '回合执行失败：服务不可用', {
            meta: {retryable: true, retry_message_id: source.id},
        }),
    ]}));
    await page.locator('#teamInput').fill('保留草稿');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let attempts = 0;
    await page.route('**/api/design-brain/chats/grp_default/messages', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        attempts += 1;
        if (attempts > 1) return route.fallback();
        await gate;
        return route.fulfill({status: 503, json: {detail: '网络暂不可用'}});
    });
    const retry = page.getByRole('button', {name: '重新发送', exact: true});
    await retry.click();
    assert.equal(await retry.isDisabled(), true);
    await retry.evaluate(button => { button.click(); button.click(); });
    release();
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent.includes('重新发送失败'));
    assert.equal(attempts, 1);
    assert.equal(await retry.isEnabled(), true);
    assert.equal(await page.locator('#teamInput').inputValue(), '保留草稿');
    await retry.click();
    await page.waitForFunction(() => document.querySelectorAll('#teamMessages .team-row.user').length === 2);
    assert.equal(attempts, 2);
    assert.equal(state.captured.messages[0].text, source.text);
    assert.deepEqual(state.captured.messages[0].meta, source.meta);
    assert.equal(await page.locator('#teamInput').inputValue(), '保留草稿');
    assert.deepEqual(errors, []);
});

test('审批卡：允许后回写状态', async (t) => {
    const approvals = {ap_1: {id: 'ap_1', tool: 'brain.team.create_bot', bot_id: 'bot_director',
        args: {name: '文案 BOT'}, summary: '新建 Bot「文案 BOT」：写主图文案', status: 'pending',
        created_at: 1, resolved_at: 0}};
    const messages = [
        message(1, 'user', '再招一个文案 BOT'),
        message(2, 'bot', '新建 Bot「文案 BOT」：写主图文案', {
            bot_id: 'bot_director', kind: 'approval', status: 'pending',
            meta: {approval_id: 'ap_1', tool: 'brain.team.create_bot', summary: '新建 Bot「文案 BOT」：写主图文案'},
        }),
    ];
    const {page, state} = await openTeam(t, fixture({messages, approvals}));
    assert.equal(await page.locator('.team-card.approval').count(), 1);
    await page.locator('[data-team-approve="ap_1"]').click();
    await page.waitForTimeout(300);
    assert.deepEqual(state.captured.approvals, [{id: 'ap_1', approve: true}]);
    assert.equal((await page.locator('.team-approval-status').textContent()).trim(), '已允许');
});

test('记忆面板：三层切换与新增', async (t) => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.click('#teamInspectorToggle');
    await page.locator('[data-team-memory="group"]').click();
    await page.waitForTimeout(200);
    assert.deepEqual(await page.locator('.memory-tabs button').allTextContents(),
        ['成员 · 设计总监', '项目 · 设计项目群', '团队']);
    assert.match(await page.locator('.memory-entry p').first().textContent(), /金色边框/);
    await page.locator('#memoryInput').fill('详情页统一左文右图');
    await page.locator('#memoryAdd').click();
    await page.waitForTimeout(250);
    assert.equal(state.captured.memory[0].text, '详情页统一左文右图');
    assert.equal(await page.locator('.memory-entry').count(), 2);
});

test('用量浮层：总量与闸门', async (t) => {
    const {page, state} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await page.locator('#teamUsage').click();
    await page.waitForTimeout(200);
    assert.deepEqual(await page.locator('.usage-totals strong').allTextContents(),
        ['17', '4', '2', '10300']);
    await page.locator('#usageLimit').fill('500');
    await page.locator('#usageSave').click();
    await page.waitForTimeout(200);
    assert.equal(state.captured.settings[0].daily_llm_limit, 500);
    assert.equal((await page.locator('#usageStatus').textContent()).trim(), '已保存');
});

test('空状态：引导卡与示例填充', async (t) => {
    const {page, errors} = await openTeam(t, fixture({messages: []}));
    assert.equal(await page.locator('.team-guide').count(), 1);
    await page.locator('[data-team-example]').first().click();
    assert.match(await page.locator('#teamInput').inputValue(), /梳理卖点和视觉方向/);
    assert.deepEqual(errors, []);
});

test('设计首页聚焦想法，项目在前且团队按需展开', async t => {
    const {page, errors} = await openTeam(t, fixture({work: []}));
    assert.equal(await page.locator('.team-main').evaluate(el => el.classList.contains('is-welcome')), true);
    assert.equal(await page.locator('#teamRoster').evaluate(el => el.open), false);
    const projects = await page.locator('#teamGroupList').boundingBox();
    const roster = await page.locator('#teamRoster > summary').boundingBox();
    assert.ok(projects.y < roster.y);
    assert.equal(await page.locator('#teamSend').isDisabled(), true);
    await page.click('[data-team-example]');
    assert.equal(await page.locator('#teamSend').isEnabled(), true);
    await page.click('#teamNewDiscussion');
    await page.waitForSelector('#teamGroupName', {state: 'visible'});
    assert.equal(await page.locator('#teamGroupName').isVisible(), true);
    assert.equal(await page.locator('#teamGroupMode').isVisible(), false);
    assert.equal(await page.locator('#teamGlobalWork').isVisible(), false);
    await page.click('.team-project-options > summary');
    assert.equal(await page.locator('#teamGroupMode').isVisible(), true);
    assert.deepEqual(errors, []);
});

test('Enter 发送、Shift+Enter 换行，中文候选确认不发送', async t => {
    const {page, state, errors} = await openTeam(t, fixture({work: []}));
    await page.fill('#teamInput', '为相框设计主图');
    await page.locator('#teamInput').press('Shift+Enter');
    await page.locator('#teamInput').pressSequentially('保留木纹');
    assert.equal(state.captured.messages.length, 0);
    await page.locator('#teamInput').dispatchEvent('keydown', {key: 'Enter', isComposing: true, keyCode: 229});
    assert.equal(state.captured.messages.length, 0);
    await page.locator('#teamInput').press('Enter');
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent === '');
    assert.equal(state.captured.messages.length, 1);
    assert.equal(state.captured.messages[0].text, '为相框设计主图\n保留木纹');
    assert.equal(await page.locator('#teamSend').isDisabled(), true);
    await page.waitForSelector('.team-row.user');
    assert.equal(await page.locator('.team-main').evaluate(el => el.classList.contains('is-welcome')), false);
    assert.deepEqual(errors, []);
});

test('拖入参考图显示落点，上传失败保留需求并可重新添加', async t => {
    const {page, errors} = await openTeam(t, fixture({work: []}));
    await page.fill('#teamInput', '参考这张图的构图');
    let fail = true;
    await page.route('**/api/ai/upload', route => fail
        ? route.fulfill({status: 503, json: {detail: '图片暂时无法保存'}})
        : route.fulfill({json: {files: [{url: '/reference.png'}]}}));
    const drag = await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['image'], 'reference.png', {type: 'image/png'}));
        return transfer;
    });
    await page.locator('.team-composer').dispatchEvent('dragenter', {dataTransfer: drag});
    assert.equal(await page.locator('.team-drop-hint').isVisible(), true);
    await page.locator('.team-composer').dispatchEvent('drop', {dataTransfer: drag});
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent.includes('上传未完成'));
    assert.equal(await page.inputValue('#teamInput'), '参考这张图的构图');
    assert.equal(await page.locator('.team-drop-hint').isVisible(), false);
    assert.equal(await page.locator('#teamSend').isEnabled(), true);
    fail = false;
    await page.locator('.team-composer').dispatchEvent('drop', {dataTransfer: drag});
    await page.waitForFunction(() => document.querySelectorAll('#teamProductImages img').length === 1 && !document.querySelector('#teamSend').disabled);
    assert.equal(await page.inputValue('#teamInput'), '参考这张图的构图');
    await page.click('[data-team-remove-product]');
    assert.equal(await page.locator('#teamProductImages img').count(), 0);
    assert.deepEqual(errors, []);
});

test('手机导航可收起，项目切换后释放输入空间', async t => {
    const {page, errors} = await openTeam(t, fixture({work: []}));
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#dbSidebar')).visibility === 'hidden');
    assert.equal(await page.locator('#dbSidebar').isVisible(), false);
    await page.click('#dbNavToggle');
    await page.waitForSelector('#dbSidebar', {state: 'visible'});
    assert.equal(await page.locator('#dbSidebar').isVisible(), true);
    await page.click('[data-team-group="grp_default"]');
    await page.waitForFunction(() => document.querySelector('#dbNavToggle').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('#teamInput').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.click('#dbNavToggle');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dbNavToggle').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
});

test('标签切换：团队页可来回切换且无报错', async (t) => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    await gotoTab(page, 'cases');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#teamPanel').isVisible(), false);
    await gotoTab(page, 'team');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#teamPanel').isVisible(), true);
    assert.equal(await page.locator('#teamMessages .team-row').count(), 3);
    assert.deepEqual(errors, []);
});

test('成员设置按需展开，新建成员会自动打开设置面板', async t => {
    const {page,errors}=await openTeam(t,fixture());
    assert.equal(await page.locator('#teamInspector').isVisible(),false);
    await page.click('#teamInspectorToggle');
    assert.equal(await page.locator('#teamInspector').isVisible(),true);
    assert.equal(await page.locator('#teamInspectorToggle').getAttribute('aria-expanded'),'true');
    await page.click('#teamInspectorClose');
    assert.equal(await page.locator('#teamInspector').isVisible(),false);
    await page.click('#teamRoster > summary');
    await page.click('#teamNewBot');
    assert.equal(await page.locator('#teamBotName').isVisible(),true);
    await page.click('#teamBotCancel');
    await page.click('#teamInspectorClose');
    await page.click('#teamNewGroup');
    assert.equal(await page.locator('#teamGroupName').isVisible(),true);
    assert.deepEqual(errors,[]);
});

test('团队输入区 Ctrl+V 粘贴图片、文字并随消息提交商品图', async t => {
    const {page, errors, state} = await openTeam(t, fixture());
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/api/ai/upload', route => {
        assert.match(route.request().headers()['content-type'], /multipart\/form-data/);
        return route.fulfill({json: {files: [{url: '/api/storage-files/upload/pasted.png'}]}});
    });
    await page.fill('#teamInput', '保留商品的真实木纹');
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
    });
    await page.locator('#teamInput').press('Control+v');
    await page.waitForFunction(() => document.querySelector('#teamProductImages img') && !document.querySelector('#teamSend').disabled);
    assert.equal(await page.inputValue('#teamInput'), '保留商品的真实木纹');
    await page.evaluate(() => navigator.clipboard.writeText('，浅灰背景'));
    await page.locator('#teamInput').press('Control+End');
    await page.locator('#teamInput').press('Control+v');
    assert.equal(await page.inputValue('#teamInput'), '保留商品的真实木纹，浅灰背景');
    await page.click('#teamSend');
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent === '');
    assert.deepEqual(state.captured.messages[0].meta.product_images, ['/api/storage-files/upload/pasted.png']);
    assert.equal(await page.locator('#teamProductImages img').count(), 0);
    assert.deepEqual(errors, []);
});

async function pasteProductFiles(page, count, filesOnly = false) {
    return page.evaluate(({count, filesOnly}) => {
        const data = new DataTransfer();
        for (let index = 0; index < count; index++) data.items.add(new File(['image'], `商品-${index}.png`, {type: 'image/png'}));
        const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data});
        if (filesOnly) Object.defineProperty(event, 'clipboardData', {value: {items: [], files: data.files}});
        document.querySelector('#teamInput').dispatchEvent(event);
        return event.defaultPrevented;
    }, {count, filesOnly});
}

test('团队图片粘贴兼容 files 剪贴板，超过八张后仍可继续添加', async t => {
    const {page, errors} = await openTeam(t, fixture());
    let uploads = 0;
    await page.route('**/api/ai/upload', route => route.fulfill({json: {files: [{url: `/api/storage-files/upload/paste-${++uploads}.png`}]}}));
    assert.equal(await pasteProductFiles(page, 10, true), true);
    await page.waitForFunction(() => document.querySelectorAll('#teamProductImages img').length === 10 && !document.querySelector('#teamSend').disabled);
    assert.equal(uploads, 10);
    await pasteProductFiles(page, 1);
    await page.waitForFunction(() => document.querySelectorAll('#teamProductImages img').length === 11 && !document.querySelector('#teamSend').disabled);
    assert.equal(uploads, 11);
    assert.deepEqual(errors, []);
});

test('批量上传全部照片，操作集中在底栏且多图与缩放不遮挡发送', async t => {
    const {page, errors, state} = await openTeam(t, fixture());
    let uploads = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await page.route('**/api/ai/upload', route => route.fulfill({json: {files: [{url: `/product-${++uploads}.png`}]}}));
    await page.route('**/product-*.png', route => route.fulfill({body: png, contentType: 'image/png'}));
    await page.setInputFiles('#teamProductFile', Array.from({length: 25}, (_, i) => ({name: `商品-${i}.png`, mimeType: 'image/png', buffer: png})));
    await page.waitForFunction(() => document.querySelectorAll('#teamProductImages img').length === 25 && !document.querySelector('#teamSend').disabled);
    assert.equal(uploads, 25);
    await page.fill('#teamInput', '图1到图3是商品，其余是参考场景，请先讨论设计方向。');
    for (const [width, height, theme, scale] of [[1920, 1000, 'light', '100'], [1366, 768, 'dark', '100'], [1024, 640, 'light', '125'], [640, 560, 'dark', '100']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(({theme, scale}) => {
            window.postMessage({type: 'studio-theme', theme}, location.origin);
            window.postMessage({type: 'studio-ui-scale', mode: scale}, location.origin);
        }, {theme, scale});
        await page.waitForTimeout(180);
        const controls = await page.locator('.team-composer-controls').boundingBox();
        const composer = await page.locator('.team-composer').boundingBox();
        for (const id of ['teamUploadProduct', 'teamAddProductImage', 'teamModelToggle', 'teamImageModelToggle', 'teamSend']) {
            const box = await page.locator(`#${id}`).boundingBox();
            assert.ok(box.x >= controls.x - 1 && box.y >= controls.y - 1 && box.x + box.width <= controls.x + controls.width + 1 && box.y + box.height <= controls.y + controls.height + 1, `${id} 应在同一工具栏内`);
            assert.ok(box.x >= composer.x && box.x + box.width <= composer.x + composer.width && box.y + box.height <= Math.min(height, composer.y + composer.height) + 1, `${width}/${scale}: ${id} 不应溢出输入框或屏幕 ${JSON.stringify({box, composer})}`);
        }
        if (process.env.DESIGN_BRAIN_SCREENSHOT_DIR && width >= 1366) await page.screenshot({path: path.join(process.env.DESIGN_BRAIN_SCREENSHOT_DIR, `design-brain-${theme}.png`)});
    }
    await page.click('#teamSend');
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent === '');
    assert.equal(state.captured.messages[0].meta.product_images.length, 25);
    assert.deepEqual(errors, []);
});

test('团队图片粘贴失败保留已上传图片和需求并恢复发送', async t => {
    const {page, errors} = await openTeam(t, fixture());
    let uploads = 0;
    await page.route('**/api/ai/upload', route => ++uploads === 1
        ? route.fulfill({json: {files: [{url: '/api/storage-files/upload/retained.png'}]}})
        : route.fulfill({status: 503, json: {detail: '本地存储暂时不可用，请重试'}}));
    await page.fill('#teamInput', '保留这段设计需求');
    await pasteProductFiles(page, 2);
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent.includes('上传未完成'));
    assert.equal(await page.locator('#teamProductImages img').count(), 1);
    assert.equal(await page.inputValue('#teamInput'), '保留这段设计需求');
    assert.equal(await page.locator('#teamSend').isEnabled(), true);
    assert.deepEqual(errors, []);
});

test('团队模型选择保存并提交所选模型，支持 Esc 和点击外部关闭', async t => {
    const state = fixture({chat: {defaults: {}}});
    state.providers = [{id: 'demo', name: 'Demo 平台', enabled: true, chat_models: ['demo-chat', 'chat-two'], image_models: ['demo-image', 'image-two']}];
    const {page, errors} = await openTeam(t, state);
    const before = await page.locator('.team-composer').boundingBox();
    await page.click('#teamImageModelToggle');
    await page.waitForFunction(() => document.activeElement?.id === 'teamImageProvider');
    assert.equal(await page.locator('#teamImageProvider').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#teamChatModel').isVisible(), false);
    assert.equal(await page.locator('#teamModelToggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#teamImageModelToggle').getAttribute('aria-expanded'), 'true');
    await page.selectOption('#teamImageModel', 'image-two');
    await page.click('#teamModelToggle');
    await page.waitForFunction(() => document.activeElement?.id === 'teamChatProvider');
    assert.equal(await page.locator('#teamImageModel').isVisible(), false);
    assert.equal(await page.locator('#teamModelToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#teamImageModelToggle').getAttribute('aria-expanded'), 'false');
    await page.selectOption('#teamChatModel', 'chat-two');
    assert.equal(await page.textContent('#teamModelSummary'), 'chat-two');
    assert.equal(await page.textContent('#teamImageModelSummary'), 'image-two');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xiaomei_team_models_v1')));
    assert.equal(saved.chat.model, 'chat-two');
    assert.equal(saved.image.model, 'image-two');
    assert.deepEqual(await page.locator('.team-composer').boundingBox(), before);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#teamModelsAdv').isVisible(), false);
    await page.click('#teamModelToggle');
    await page.click('#teamInput');
    assert.equal(await page.locator('#teamModelsAdv').isVisible(), false);
    await page.reload({waitUntil: 'networkidle'});
    await page.waitForFunction(() => document.querySelector('#teamChatModel').value === 'chat-two');
    assert.equal(await page.locator('#teamImageModel').inputValue(), 'image-two');
    await page.fill('#teamInput', '使用刚选好的模型');
    await page.click('#teamSend');
    await page.waitForFunction(() => document.querySelector('#teamSendStatus').textContent === '');
    assert.equal(state.captured.messages[0].models.chat.model, 'chat-two');
    assert.equal(state.captured.messages[0].models.image.model, 'image-two');
    assert.deepEqual(errors, []);
});

test('团队模型浮层兼容长模型名、深色、小窗口和缩放', async t => {
    const state = fixture();
    state.providers = [{id: 'demo', name: '商品设计 API 平台', enabled: true,
        chat_models: ['gemini-3.8-flash-high-preview-with-a-long-name'], image_models: ['nano-banana-2.1-high-quality-preview']}];
    const {page, errors} = await openTeam(t, state);
    for (const [width, height, theme, scale] of [[1440, 980, 'light', '100'], [1366, 768, 'dark', '100'], [1024, 640, 'light', '125'], [640, 560, 'dark', '100'], [390, 844, 'light', '100']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(({theme, scale}) => {
            window.postMessage({type: 'studio-theme', theme}, location.origin);
            window.postMessage({type: 'studio-ui-scale', mode: scale}, location.origin);
        }, {theme, scale});
        await page.waitForTimeout(180);
        for (const [trigger, provider] of [['teamModelToggle', 'teamChatProvider'], ['teamImageModelToggle', 'teamImageProvider']]) {
            await page.click(`#${trigger}`);
            await page.waitForFunction(id => document.activeElement?.id === id, provider);
            const box = await page.locator('#teamModelsAdv').boundingBox();
            assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, JSON.stringify({width, height, box}));
            const composer = await page.locator('.team-composer').boundingBox();
            assert.ok(box.y + box.height <= composer.y, '选择模型时不应遮住正在编辑的需求');
            await page.click('#teamModelsClose');
        }
    }
    assert.deepEqual(errors, []);
});

test('团队模型浮层每次只展示当前用途，重复点击、关闭和键盘操作正确', async t => {
    const {page,errors}=await openTeam(t,fixture());
    assert.equal(await page.locator('#teamModelsAdv').isVisible(),false);
    assert.equal(await page.locator('#teamModelSummary').textContent(),'demo-chat');
    assert.equal(await page.locator('#teamImageModelSummary').textContent(),'demo-image');
    await page.click('#teamModelToggle');
    assert.equal(await page.locator('#teamModelsTitle').textContent(), '对话模型');
    assert.deepEqual(await page.locator('#teamModelsAdv select:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),['对话平台','对话模型']);
    await page.click('#teamModelToggle');
    assert.equal(await page.locator('#teamModelsAdv').isVisible(), false);
    await page.locator('#teamImageModelToggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#teamModelsTitle').textContent(), '生图模型');
    assert.deepEqual(await page.locator('#teamModelsAdv select:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['生图平台','生图模型']);
    await page.click('#teamModelsClose');
    assert.equal(await page.locator('#teamModelsAdv').isVisible(), false);
    assert.equal(await page.locator('#teamImageModelToggle').getAttribute('aria-expanded'), 'false');
    await page.setViewportSize({width:1024,height:640});
    const box=await page.locator('#teamSend').boundingBox();
    assert.ok(box.y + box.height <= 640);
    assert.deepEqual(errors,[]);
});

test('结果卡携带具体任务 ID，在团队讨论旁展开方案与成图', async t => {
    const {page,errors}=await openTeam(t,fixture({messages:[message(1,'bot','方案已准备好',{kind:'result',bot_id:'bot_director',task_id:'job_team_card'})]}));
    await page.evaluate(()=>document.addEventListener('design-brain-open-task',event=>{window.openedDesignTask=event.detail.taskId;}));
    await page.click('[data-team-open-studio]');
    assert.equal(await page.evaluate(()=>window.openedDesignTask),'job_team_card');
    assert.equal(await page.locator('#studioPanel').isVisible(),true);
    assert.equal(await page.locator('#teamPanel').isVisible(),true);
    assert.equal(await page.locator('#teamInput').isVisible(),true);
    assert.deepEqual(errors,[]);
});


test('从灵感库新建项目讨论，保存后自动进入新群，原讨论草稿保留',async t=>{
 const state=fixture();const {page,errors}=await openTeam(t,state);
 await page.fill('#teamInput','原项目还没发出的讨论');
 await page.route('**/api/design-brain/groups',async route=>{
  const payload=route.request().postDataJSON();
  const createdGroup=group({id:'grp_new',name:payload.name,members:payload.members});
  const createdChat=chat({id:'grp_new',group_id:'grp_new',title:payload.name});
  state.groups.push(createdGroup);state.chats.push(createdChat);
  await route.fulfill({json:{group:createdGroup,chat:createdChat}});
 });
 await page.route('**/api/design-brain/chats/grp_new/**',route=>route.fulfill({json:route.request().url().includes('/messages')?{chat:state.chats[1],messages:[],cursor:0}:{running:false}}));
 await gotoTab(page,'cases');await page.click('#teamNewDiscussion');
 assert.equal(await page.locator('#teamPanel').isVisible(),true);
 await page.click('#teamGroupSave');assert.match(await page.textContent('#teamGroupStatus'),/起个名字/);
 await page.fill('#teamGroupName','新系列讨论');await page.click('#teamGroupSave');
 await page.waitForFunction(()=>document.querySelector('#teamTitle').textContent==='新系列讨论');
 await page.waitForSelector('#teamInspector[hidden]',{state:'attached'});
 assert.equal(await page.locator('#teamInspector').isVisible(),false);
 assert.equal(await page.inputValue('#teamInput'),'');
 assert.equal(await page.locator('#teamGroupList .team-side-item').count(),2);
 await page.click('[data-team-group="grp_default"]');
 assert.equal(await page.inputValue('#teamInput'),'原项目还没发出的讨论');
 await page.click('[data-team-group="grp_new"]');
 await page.reload({waitUntil:'networkidle'});
 await page.waitForFunction(()=>document.querySelector('#teamTitle').textContent==='新系列讨论');
 assert.equal(await page.locator('#teamGroupList .team-side-item').count(),2);
 assert.deepEqual(errors,[]);
});

test('新建项目讨论失败时保留群名并显示重试原因',async t=>{
 const {page,errors}=await openTeam(t,fixture());
 await page.route('**/api/design-brain/groups',route=>route.fulfill({status:503,json:{detail:'保存失败，请重试'}}));
 await page.click('#teamNewDiscussion');await page.fill('#teamGroupName','保留这个项目名');await page.click('#teamGroupSave');
 await page.waitForFunction(()=>document.querySelector('#teamGroupStatus')?.textContent.includes('保存失败'));
 assert.equal(await page.inputValue('#teamGroupName'),'保留这个项目名');
 assert.equal(await page.locator('#teamInspector').isVisible(),true);assert.deepEqual(errors,[]);
});

test('成员使用不同角色头像，群头像组合成员，历史头像保持静止', async t => {
    const {page, errors} = await openTeam(t, fixture({messages: BASIC_MESSAGES}));
    const shapes = await page.locator('#teamBotList .team-character').evaluateAll(nodes => nodes.map(node => node.dataset.character));
    assert.equal(new Set(shapes).size, 5);
    assert.equal(await page.locator('#teamGroupList .team-group-avatar .team-character').count(), 4);
    assert.equal(await page.locator('#teamMessages [data-live="true"]').count(), 0);
    const masks = await page.locator('.team-character mask').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(new Set(masks).size, masks.length);
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal(await page.locator('#teamBotList .team-eye').first().evaluate(node => getComputedStyle(node).animationName), 'none');
    assert.deepEqual(errors, []);
});

test('思考和工具执行显示当前成员、耗时，回合结束停止动画', async t => {
    const state = fixture({messages: BASIC_MESSAGES});
    state.turn = {running: true, bot_id: 'bot_reference', bot_name: '参考分析', started_at: Date.now() - 65000, activity: 'thinking', activity_label: '正在思考'};
    const {page, errors} = await openTeam(t, state);
    assert.match(await page.textContent('#teamWorkStatus'), /参考分析.*正在思考/);
    assert.match(await page.textContent('#teamWorkStatus'), /1 分/);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_reference"] .team-character').getAttribute('data-state'), 'thinking');
    state.turn.activity = 'searching';
    state.turn.activity_label = '正在查找资料';
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').textContent.includes('正在查找资料'));
    assert.match(await page.locator('#teamBotList [data-team-bot="bot_reference"] small').textContent(), /查找资料/);
    state.turn.running = false;
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').hidden);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_reference"] .team-character').getAttribute('data-state'), 'idle');
    assert.equal(await page.textContent('#teamTurnStatus'), '');
    assert.deepEqual(errors, []);
});

test('后台任务无需展开成果即可显示规划、确认和真实生图进度，失败停止动画', async t => {
    const task = {
        id: 'job_progress', title: '15 张相框 SKU 展示图', status: 'planning', created_at: Date.now() - 15000,
        updated_at: Date.now(), plan: {shots: Array.from({length: 15}, (_, i) => ({id: `shot_${i}`}))},
        execution: {shots: []}, events: [],
    };
    const state = fixture({tasks: [task], messages: [message(1, 'bot', '已创建任务', {kind: 'result', bot_id: 'bot_director', task_id: task.id})]});
    const {page, errors} = await openTeam(t, state);
    assert.equal(await page.locator('#studioPanel').isVisible(), false);
    assert.match(await page.textContent('#teamWorkStatus'), /制定方案/);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_planner"] .team-character').getAttribute('data-state'), 'thinking');
    task.status = 'awaiting_confirmation';
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').textContent.includes('等待确认方案'));
    assert.equal(await page.locator('#teamWorkStatus .design-progress-indeterminate').count(), 0);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_planner"] .team-character').getAttribute('data-state'), 'idle');
    task.status = 'executing';
    task.execution.shots = task.plan.shots.map((shot, index) => ({id: shot.id, status: index < 3 ? 'succeeded' : index === 3 ? 'failed' : 'running'}));
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').textContent.includes('已生成 3/15 张'));
    assert.equal(await page.locator('#teamWorkStatus progress').getAttribute('value'), '4');
    assert.equal(await page.locator('#teamWorkStatus progress').getAttribute('max'), '15');
    assert.match(await page.textContent('[data-team-task-progress="job_progress"]'), /1 张失败/);
    assert.match(await page.textContent('#studioTaskList'), /已生成 3\/15 张/);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_executor"] .team-character').getAttribute('data-state'), 'working');
    for (const [width, height, theme] of [[1440, 980, 'light'], [640, 640, 'dark']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(theme => window.postMessage({type: 'studio-theme', theme}, location.origin), theme);
        await page.waitForTimeout(100);
        const send = await page.locator('#teamSend').boundingBox();
        assert.ok(send.y + send.height <= height, '进度不能把发送按钮挤出窗口');
        assert.ok(await page.locator('#teamWorkStatus').isVisible());
        if (process.env.XIAOMEI_DESIGN_PROGRESS_SHOTS) {
            fs.mkdirSync(process.env.XIAOMEI_DESIGN_PROGRESS_SHOTS, {recursive: true});
            await page.screenshot({path: path.join(process.env.XIAOMEI_DESIGN_PROGRESS_SHOTS, `design-progress-${width}.png`)});
        }
    }
    task.status = 'failed';
    task.error = '图片平台暂时不可用';
    await page.waitForFunction(() => document.querySelector('[data-team-task-progress]').textContent.includes('图片平台暂时不可用'));
    assert.equal(await page.locator('#teamWorkStatus').isVisible(), false);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_executor"] .team-character').getAttribute('data-state'), 'idle');
    assert.equal(await page.locator('[data-team-task-progress] progress').count(), 0);
    assert.deepEqual(errors, []);
});

test('进度断线保留状态并重试恢复，切换会话不串任务', async t => {
    const task = {id: 'job_live', title: '当前群任务', status: 'planning', created_at: Date.now(), plan: {}, execution: {}, events: []};
    const state = fixture({tasks: [task], messages: [message(1, 'bot', '任务开始', {kind: 'result', bot_id: 'bot_director', task_id: task.id})]});
    const dm = chat({id: 'dm_bot_director', kind: 'dm', bot_id: 'bot_director', group_id: '', members: ['bot_director']});
    state.chats.push(dm);
    const {page, errors} = await openTeam(t, state);
    const broken = route => route.fulfill({status: 503, json: {detail: '连接中断'}});
    await page.route('**/api/design-brain/bot/tasks?*', broken);
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').textContent.includes('进度连接中断'));
    assert.match(await page.textContent('#studioTaskList'), /当前群任务/);
    await page.unroute('**/api/design-brain/bot/tasks?*', broken);
    task.status = 'awaiting_confirmation';
    await page.waitForFunction(() => document.querySelector('#teamWorkStatus').textContent.includes('等待确认方案') && !document.querySelector('#teamWorkStatus').textContent.includes('连接中断'));
    await page.route('**/api/design-brain/chats/dm_bot_director/**', route => route.fulfill({json: route.request().url().includes('/messages') ? {chat: dm, messages: [], cursor: 0} : {running: false}}));
    await page.click('#teamRoster > summary');
    await page.click('[data-team-bot="bot_director"]');
    await page.waitForFunction(() => document.querySelector('#teamTitle').textContent === '设计总监');
    assert.equal(await page.locator('#teamWorkStatus').isVisible(), false);
    await page.click('[data-team-group="grp_default"]');
    await page.waitForFunction(() => !document.querySelector('#teamWorkStatus').hidden);
    assert.match(await page.textContent('#teamWorkStatus'), /等待确认方案/);
    assert.deepEqual(errors, []);
});

function runningWork(id, botId, chatId, title, extra = {}) {
    return {id, bot_id: botId, bot_name: BOTS.find(bot => bot.id === botId).name,
        chat_id: chatId, chat_title: title, chat_kind: 'group', kind: 'turn',
        activity: 'searching', activity_label: '查找参考', started_at: Date.now() - 45000,
        cancellable: true, ...extra};
}

test('跨群状态显示来源群，私聊仍能查看同一成员的多项工作并跳回来源', async t => {
    const state = fixture({work: [
        runningWork('work_a', 'bot_reference', 'grp_a', 'A 商品项目'),
        runningWork('work_b', 'bot_reference', 'grp_b', 'B 商品项目'),
    ]});
    state.groups.push(group({id: 'grp_a', name: 'A 商品项目'}), group({id: 'grp_b', name: 'B 商品项目'}));
    state.chats.push(chat({id: 'grp_a', group_id: 'grp_a', title: 'A 商品项目'}),
        chat({id: 'grp_b', group_id: 'grp_b', title: 'B 商品项目'}),
        chat({id: 'dm_bot_reference', kind: 'dm', group_id: '', bot_id: 'bot_reference', members: ['bot_reference']}));
    const {page, errors} = await openTeam(t, state);
    await page.route('**/api/design-brain/chats/dm_bot_reference/**', route => route.fulfill({json: route.request().url().includes('/messages') ? {chat: state.chats.find(chat => chat.id === 'dm_bot_reference'), messages: [], cursor: 0} : {running: false}}));
    await page.route('**/api/design-brain/chats/grp_a/**', route => route.fulfill({json: route.request().url().includes('/messages') ? {chat: state.chats.find(chat => chat.id === 'grp_a'), messages: [], cursor: 0} : {running: false}}));
    assert.match(await page.textContent('#teamBotList [data-team-bot="bot_reference"] small'), /A 商品项目.*共 2 项/);
    assert.equal(await page.locator('#teamGroupList [data-team-group="grp_a"] .team-group-work-count').textContent(), '1');
    assert.match(await page.textContent('#teamWorkStatus'), /A 商品项目/);
    await page.click('#teamRoster > summary');
    await page.click('[data-team-bot="bot_reference"]');
    await page.waitForFunction(() => document.querySelector('#teamTitle').textContent === '参考分析');
    assert.match(await page.textContent('#teamWorkStatus'), /A 商品项目/);
    await page.click('#teamWorkToggle');
    assert.equal(await page.locator('#teamInspector').isVisible(), true);
    assert.equal(await page.locator('#teamGlobalWork .team-global-work-row').count(), 2);
    assert.equal(await page.locator('[data-member-work="bot_reference"] [data-team-stop-work]').count(), 2);
    await page.locator('#teamGlobalWork [data-team-go-work="work_a"]').click();
    await page.waitForFunction(() => document.querySelector('#teamTitle').textContent === 'A 商品项目');
    assert.match(await page.textContent('#teamBotList [data-team-bot="bot_reference"] small'), /查找参考/);
    assert.deepEqual(errors, []);
});

test('单独停止精确工作且防止重复提交，其余成员和群继续显示', async t => {
    const state = fixture({work: [
        runningWork('work_a', 'bot_reference', 'grp_default', '设计项目群'),
        runningWork('work_b', 'bot_reference', 'grp_b', '另一个项目'),
        runningWork('work_image', 'bot_executor', 'grp_default', '设计项目群', {kind: 'workflow', task_id: 'job_x', activity: 'working', activity_label: '生成图片', stop_note: '停止会结束此设计任务'}),
    ]});
    state.stopDelay = 300;
    const {page, errors} = await openTeam(t, state);
    await page.click('#teamWorkToggle');
    assert.match(await page.textContent('#teamGlobalWork'), /停止会结束此设计任务/);
    const stop = page.locator('#teamGlobalWork [data-team-stop-work="work_a"]');
    await stop.click();
    assert.equal(await stop.isDisabled(), true);
    await page.waitForFunction(() => document.querySelectorAll('#teamGlobalWork .team-global-work-row').length === 2);
    assert.deepEqual(state.workStops, ['work_a']);
    assert.equal(await page.locator('#teamGlobalWork [data-team-stop-work="work_b"]').count(), 1);
    assert.equal(await page.locator('#teamGlobalWork [data-team-stop-work="work_image"]').count(), 1);
    assert.match(await page.textContent('#teamBotList [data-team-bot="bot_reference"] small'), /另一个项目/);
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_executor"] .team-character').getAttribute('data-state'), 'working');
    assert.deepEqual(errors, []);
});

test('停止失败保留工作并允许重试；跨群状态断线保留上次信息', async t => {
    const state = fixture({work: [runningWork('work_a', 'bot_reference', 'grp_a', 'A 项目')]});
    state.stopFailure = '停止失败，请重试';
    const {page, errors} = await openTeam(t, state);
    await page.click('#teamWorkToggle');
    await page.click('#teamGlobalWork [data-team-stop-work="work_a"]');
    await page.waitForFunction(() => document.querySelector('.team-toast')?.textContent.includes('停止失败'));
    assert.equal(await page.locator('#teamGlobalWork [data-team-stop-work="work_a"]').isEnabled(), true);
    const broken = route => route.fulfill({status: 503, json: {detail: '连接中断'}});
    await page.route('**/api/design-brain/team/work', broken);
    await page.waitForFunction(() => document.querySelector('#teamGlobalWork').textContent.includes('连接中断'));
    assert.match(await page.textContent('#teamGlobalWork'), /A 项目/);
    await page.unroute('**/api/design-brain/team/work', broken);
    state.stopFailure = '';
    await page.click('#teamGlobalWork [data-team-stop-work="work_a"]');
    await page.waitForFunction(() => document.querySelector('#teamGlobalWork').textContent.includes('当前没有进行中的工作'));
    assert.equal(await page.locator('#teamBotList [data-team-bot="bot_reference"] .team-character').getAttribute('data-state'), 'idle');
    assert.deepEqual(errors, []);
});

test('团队动态与成员停止在深色、小窗口和缩放界面可操作', async t => {
    const {page, errors} = await openTeam(t, fixture({work: [
        runningWork('work_a', 'bot_reference', 'grp_a', '相框系列 A 项目'),
        runningWork('work_image', 'bot_executor', 'grp_default', '设计项目群', {kind: 'workflow', activity: 'working', activity_label: '生成图片', stop_note: '停止会结束此设计任务'}),
    ]}));
    for (const [width, height, theme, scale] of [[1440, 980, 'light', '100'], [1024, 640, 'light', '125'], [640, 640, 'dark', '100']]) {
        await page.setViewportSize({width, height});
        await page.evaluate(({theme, scale}) => {
            window.postMessage({type: 'studio-theme', theme}, location.origin);
            window.postMessage({type: 'studio-ui-scale', mode: scale}, location.origin);
        }, {theme, scale});
        await page.waitForTimeout(120);
        await page.click('#teamWorkToggle');
        const stop = page.locator('#teamGlobalWork [data-team-stop-work="work_a"]');
        const box = await stop.boundingBox();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
        if (process.env.XIAOMEI_TEAM_WORK_SHOTS) {
            fs.mkdirSync(process.env.XIAOMEI_TEAM_WORK_SHOTS, {recursive: true});
            await page.screenshot({path: path.join(process.env.XIAOMEI_TEAM_WORK_SHOTS, `team-work-${width}.png`)});
        }
        await page.click('#teamInspectorClose');
        const send = await page.locator('#teamSend').boundingBox();
        assert.ok(send.y + send.height <= height);
    }
    assert.deepEqual(errors, []);
});
