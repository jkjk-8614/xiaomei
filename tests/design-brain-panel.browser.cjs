const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

// 9 个模块收成 4 组后，子标签要先点组标签才可见；按用户路径先组后子。
const TAB_GROUP_OF = {studio: 'work', cases: 'asset', references: 'asset', experiences: 'asset', profile: 'asset', team: 'team', skills: 'team', runs: 'log', reviews: 'log'};
async function gotoTab(page, tab) {
    await page.click(`.db-group-tab[data-db-group="${TAB_GROUP_OF[tab]}"]`);
    const sub = page.locator(`#tab${tab[0].toUpperCase()}${tab.slice(1)}`);
    if (await sub.isVisible()) await sub.click();
}
const PAGE_URL = 'http://127.0.0.1:3000/static/design-brain.html?v=test';
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

test('设计技能共用已安装库，支持搜索、导入且不改变当前选择', async t => {
    const {page, state} = await openPanel(t);
    const library = [{id: 'main-image', name: '电商主图策划', description: '主图构图与材质', enabled: true, kind: 'package'}];
    let refreshes = 0;
    await page.route('**/api/agent-skills', route => {
        refreshes++;
        return route.fulfill({json: {skills: library}});
    });
    await page.route('**/api/agent-skills/inspect-package', route => route.fulfill({json: {
        source_dir: 'D:/技能包/海报', valid_count: 1,
        skills: [{id: 'poster', name: '极简海报', valid: true}],
    }}));
    await page.route('**/api/agent-skills/import-package', route => {
        assert.equal(route.request().postDataJSON().replace, false);
        library.push({id: 'poster', name: '极简海报', enabled: true, kind: 'package'});
        return route.fulfill({json: {imported: [{id: 'poster'}], skipped: [], conflicts: []}});
    });
    await gotoTab(page, 'skills');
    await page.locator('[data-skill-market-card="main-image"]').waitFor();
    await page.locator('[data-skill-market-select="main-image"]').first().click();
    assert.equal(await page.evaluate(() => StudioSharedSkill.getSelected()), 'main-image');
    await page.locator('[data-skill-market-search]').fill('材质');
    assert.equal(await page.locator('[data-skill-market-card]').count(), 1);
    await page.locator('[data-skill-market-tab="install"]').click();
    await page.locator('[data-skill-market-source]').fill('D:/技能包/海报');
    await page.locator('[data-skill-market-inspect]').click();
    await page.locator('[data-skill-market-import]:enabled').waitFor();
    await page.locator('[data-skill-market-import]').click();
    await page.locator('.skill-market-message').filter({hasText: '已导入 1 个 Skill'}).waitFor();
    assert.equal(await page.evaluate(() => StudioSharedSkill.getSelected()), 'main-image');
    assert.ok(refreshes >= 2);
    await page.locator('[data-skill-market-search]').fill('海报');
    await page.locator('[data-skill-market-card="poster"]').waitFor();
    if (process.env.DESIGN_BRAIN_SCREENSHOT_DIR) {
        await page.locator('[data-skill-market-search]').fill('');
        await page.screenshot({path: path.join(process.env.DESIGN_BRAIN_SCREENSHOT_DIR, 'design-brain-skills.png')});
        await page.evaluate(() => document.body.classList.add('theme-dark'));
        await page.waitForTimeout(250);
        await page.screenshot({path: path.join(process.env.DESIGN_BRAIN_SCREENSHOT_DIR, 'design-brain-skills-dark.png')});
        await page.setViewportSize({width: 640, height: 640});
        await page.screenshot({path: path.join(process.env.DESIGN_BRAIN_SCREENSHOT_DIR, 'design-brain-skills-small.png')});
        const width = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, viewport: innerWidth}));
        assert.ok(width.scroll <= width.viewport + 1);
    }
    assert.deepEqual(state.pageErrors, []);
});

test('设计技能刷新失败保留已加载库并可恢复', async t => {
    const {page, state} = await openPanel(t);
    let failed = false;
    await page.route('**/api/agent-skills', route => route.fulfill(failed
        ? {status: 503, json: {detail: '技能库暂时无法读取'}}
        : {json: {skills: [{id: 'main-image', name: '电商主图策划', enabled: true}]}}));
    await gotoTab(page, 'skills');
    await page.locator('[data-skill-market-card="main-image"]').waitFor();
    failed = true;
    await gotoTab(page, 'team');
    await gotoTab(page, 'skills');
    await page.locator('.skill-market-empty.is-error').waitFor();
    assert.equal(await page.locator('[data-skill-market-card="main-image"]').count(), 1);
    failed = false;
    await page.locator('[data-skill-market-reload]').click();
    await page.locator('.skill-market-empty.is-error').waitFor({state: 'detached'});
    assert.deepEqual(state.pageErrors, []);
});

function defaultProfile() {
    return {
        version: 1,
        aesthetics: {
            style_tags: [{tag: '极简', weight: 0.9, origin: 'user'}],
            color_preferences: [], composition: [], lighting: [], mood: [],
            avoid_tags: [],
        },
        tone: {brand_words: [], banned_words: []},
        task_defaults: {
            main_image: {preferred_ratio: '1:1', quality: 'high'},
            detail_page: {segments: 8},
        },
        privacy: {allow_cloud_analysis: false},
        pending_suggestions: [],
    };
}

function defaultCases() {
    return [
        {
            id: 'case_r1', title: '浅底玻璃杯主图', category: 'product', tags: ['浅底', '玻璃'],
            favorite: false, media_mode: 'refs', use_count: 2,
            prompt: {display: '浅灰渐变底，玻璃杯居中，柔光', request: '浅灰渐变底，玻璃杯居中，柔光'},
            settings: {model: 'gpt-image-2'},
            cover: {url: '/api/storage-files/generated/a.png', kind: 'image'},
            variants: [{url: '/api/storage-files/generated/a.png', name: '生成图', kind: 'image'}],
            references: [], analysis: {style: '', color: '', composition: '', lighting: '', mood: '', notes: ''},
            profile_links: [], origin: {type: 'history_pick', history_timestamp: 1, canvas_id: '', node_id: '', inspiration_case_id: ''},
        },
        {
            id: 'case_r2', title: '国风礼盒详情', category: 'scene', tags: ['国风'],
            favorite: true, media_mode: 'refs', use_count: 0,
            prompt: {display: '国风礼盒', request: '国风礼盒'},
            settings: {model: 'gemini-3-pro-image'},
            cover: {url: '/api/storage-files/generated/b.png', kind: 'image'},
            variants: [{url: '/api/storage-files/generated/b.png', name: '生成图', kind: 'image'}],
            references: [], analysis: {style: '', color: '', composition: '', lighting: '', mood: '', notes: ''},
            profile_links: [], origin: {type: 'image_space', history_timestamp: 0, canvas_id: '', node_id: '', inspiration_case_id: ''},
        },
        {
            id: 'case_copy1', title: '复制模式旧案例', category: 'product', tags: [],
            favorite: false, media_mode: 'copy', use_count: 5,
            prompt: {display: '旧案例', request: '旧案例'},
            settings: {}, cover: {url: '/assets/prompt_cases/case_copy1/variant-01.png', kind: 'image'},
            variants: [{url: '/assets/prompt_cases/case_copy1/variant-01.png', kind: 'image'}],
            references: [], analysis: {style: '', color: '', composition: '', lighting: '', mood: '', notes: ''},
            profile_links: [], origin: {type: 'user_saved', history_timestamp: 0, canvas_id: '', node_id: '', inspiration_case_id: ''},
        },
    ];
}

function defaultSkills() {
    return [{
        skill_id: 'light-box-style', experience_id: 'exp_skill_src', lifecycle: 'draft',
        created_at: 2, current_version: 2, installed: true, enabled: false,
        display_name: '浅底玻璃质感 Skill', registry_version: '1.0.2',
        versions: [
            {version: 1, sha256: 'a', created_at: 1, note: '从经验生成'},
            {version: 2, sha256: 'b', created_at: 2, note: '编辑内容'},
        ],
        content: '---\nname: "浅底玻璃质感 Skill"\ndescription: "来自设计大脑经验"\nversion: "1.0.2"\n---\n\n# 使用场景\n\n# 经验规则\n- 浅灰渐变底更保玻璃质感\n',
    }];
}

function defaultHistoryRows() {
    return [
        {prompt: '浅灰渐变底玻璃杯居中柔光', timestamp: 100.5, model: 'gpt-image-2', params: {model: 'gpt-image-2', size: '1024x1024'},
         media_items: [{url: '/api/storage-files/generated/h1.png', kind: 'image', name: 'h1.png'}]},
        {prompt: '国风礼盒详情页首屏', timestamp: 101.5, model: 'gemini-3-pro-image', params: {model: 'gemini-3-pro-image'},
         media_items: [{url: '/api/storage-files/generated/h2.png', kind: 'image', name: 'h2.png'}]},
        {prompt: '失败的重试记录', timestamp: 102.5, model: '', params: {}, media_items: [{url: '/api/storage-files/generated/h3.png', kind: 'image'}]},
    ];
}

function referenceAnalysisEmpty() {
    return {status: 'none', provider: '', model: '', analyzed_at: 0, error: '',
            content: {purpose: '', composition: '', material: '', lighting: '', takeaways: '', restrictions: ''},
            suggested: {category: '', purpose: '', expression: '', tags: []}, edited: false, edited_at: 0};
}

function defaultReferences() {
    const base = (id, hash, overrides = {}) => ({
        id, created_at: 1, updated_at: 1, hash,
        file: {name: `${id}.jpg`, ext: '.jpg', size: 204800, width: 1200, height: 900,
               media: `media/${hash.slice(0, 2)}/${hash}.jpg`, thumb: `thumbs/${hash.slice(0, 2)}/${hash}.jpg`,
               thumb_width: 512, thumb_height: 384},
        source: {type: 'local', folder: `参考图/${id === 'ref_a' ? '家居/相框' : '美妆'}`, url: '', board: '', imported_at: 1},
        title: id === 'ref_a' ? '相框主图' : (id === 'ref_b' ? '创意展示样片' : '失败样例'),
        classification: id === 'ref_a'
            ? {category: '家居', purpose: '主图', expression: '', tags: ['相框']}
            : {category: '美妆', purpose: '', expression: '', tags: []},
        analysis: referenceAnalysisEmpty(),
        notes: '', favorite: false,
        ...overrides,
    });
    const ready = base('ref_b', 'b'.repeat(64), {favorite: true, source: {type: 'local', folder: '参考图/美妆', url: '', board: '', imported_at: 1}});
    ready.classification = {category: '美妆', purpose: '详情页', expression: '创意展示', tags: []};
    ready.analysis = {...referenceAnalysisEmpty(), status: 'ready', provider: 'prov-a', model: 'chat-x', analyzed_at: 5,
                      content: {...referenceAnalysisEmpty().content, purpose: '详情页首屏', composition: '居中对称'},
                      suggested: {category: '家居', purpose: '主图', expression: '材质表现', tags: ['相框']}};
    const failed = base('ref_c', 'c'.repeat(64), {title: '失败样例', source: {type: 'local', folder: '参考图/美妆', url: '', board: '', imported_at: 1}});
    failed.analysis = {...referenceAnalysisEmpty(), status: 'failed', error: '模型返回无法解析'};
    return [base('ref_a', 'a'.repeat(64)), ready, failed];
}

async function autoDialogs(page, supply = {}) {
    await page.on('dialog', async dialog => {
        if (dialog.type() === 'prompt') {
            await dialog.accept(supply.prompt === undefined ? '' : supply.prompt);
        } else {
            await dialog.accept();
        }
    });
}

async function openPanel(t, options = {}) {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1640, height: 1000}});
    const state = {
        requests: [], errors: [], pageErrors: [],
        revision: 3,
        profile: defaultProfile(),
        cases: defaultCases(),
        experiences: options.experiences || [],
        skills: defaultSkills(),
        historyRows: defaultHistoryRows(),
        references: options.references || defaultReferences(),
        conflictNext: false,
        messages: [],
    };
    if (options.allowCloudAnalysis) state.profile.privacy.allow_cloud_analysis = true;
    if (options.allowReferenceAnalysis) state.profile.privacy.allow_reference_analysis = true;
    const distillReply = options.distillReply || JSON.stringify({
        title: '浅底更保玻璃质感',
        observations: ['玻璃制品主图用浅灰渐变底比纯白底更保质感', '柔光侧打光能保留杯壁透光'],
        profile_patch: [{group: 'style_tags', tag: '浅底渐变', weight: 0.6}],
    });
    page.on('pageerror', error => state.pageErrors.push(error.message));
    await page.addInitScript(() => {
        window.__dbMessages = [];
        window.addEventListener('message', event => window.__dbMessages.push(event.data));
    });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path: file}) : route.fulfill({status: 404, body: ''});
        }
        const json = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
        if (url.pathname === '/api/design-brain/profile' && request.method() === 'GET') {
            return json({revision: state.revision, updated_at: 1, profile: state.profile});
        }
        if (url.pathname === '/api/design-brain/profile' && request.method() === 'PUT') {
            state.requests.push({method: 'PUT', path: url.pathname, body: request.postDataJSON()});
            if (state.conflictNext) {
                state.conflictNext = false;
                return json({detail: '设计大脑档案已在其他窗口更新，请刷新后再试', code: 'revision_conflict',
                             current: {revision: state.revision, updated_at: 2, profile: state.profile}}, 409);
            }
            state.profile = request.postDataJSON().profile;
            state.revision += 1;
            return json({revision: state.revision, updated_at: 3, profile: state.profile});
        }
        if (url.pathname === '/api/prompt-cases' && request.method() === 'GET') {
            state.requests.push({method: 'GET', path: url.pathname, query: url.searchParams.get('q') || '', mode: url.searchParams.get('media_mode') || ''});
            let cases = state.cases;
            const mode = url.searchParams.get('media_mode');
            if (mode) cases = cases.filter(item => (item.media_mode || 'copy') === mode);
            const query = (url.searchParams.get('q') || '').trim();
            if (query) cases = cases.filter(item => item.title.includes(query) || (item.prompt && item.prompt.display.includes(query)));
            return json({cases, categories: [{id: 'product', name: '商品'}, {id: 'scene', name: '场景'}],
                         total: cases.length, offset: 0, limit: 200, updated_at: 1});
        }
        if (url.pathname === '/api/prompt-cases' && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const created = {...body, id: 'case_new', media_mode: body.media_mode || 'copy',
                             cover: {url: (body.variants || [])[0].url}, use_count: 0,
                             analysis: body.analysis || {}, profile_links: body.profile_links || [],
                             origin: body.origin || {type: 'user_saved'}};
            state.cases = [created, ...state.cases];
            return json({case: created, existing: false, categories: []});
        }
        const patchMatch = url.pathname.match(/^\/api\/prompt-cases\/([^/]+)$/);
        if (patchMatch && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: url.pathname, body});
            const target = state.cases.find(item => item.id === patchMatch[1]);
            if (target) Object.assign(target, body);
            return json({case: target || {}, categories: []});
        }
        const deleteMatch = url.pathname.match(/^\/api\/prompt-cases\/([^/]+)$/);
        if (deleteMatch && request.method() === 'DELETE') {
            state.requests.push({method: 'DELETE', path: url.pathname});
            state.cases = state.cases.filter(item => item.id !== deleteMatch[1]);
            return json({ok: true});
        }
        if (url.pathname.match(/^\/api\/prompt-cases\/.+\/use$/) && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname});
            return json({ok: true});
        }
        if (url.pathname === '/api/storage-files' && request.method() === 'GET') {
            state.requests.push({method: 'GET', path: url.pathname, kind: url.searchParams.get('kind')});
            return json({kind: 'generated', items: [
                {url: '/api/storage-files/generated/p1.png', name: 'p1.png', created_at: 2},
                {url: '/api/storage-files/generated/p2.png', name: 'p2.png', created_at: 1},
            ], total: 2, all_total: 2, has_more: false, folders: []});
        }
        // ---- 阶段 2：经验状态机与 Skill 生命周期 ----
        if (url.pathname === '/api/providers' && request.method() === 'GET') {
            return json({providers: [{id: 'prov-a', name: '平台 A', enabled: true, chat_models: ['chat-x', 'chat-y']}]});
        }
        if (url.pathname === '/api/history' && request.method() === 'GET') {
            return json(state.historyRows);
        }
        if (url.pathname === '/api/canvas-llm' && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname, body: request.postDataJSON()});
            return json({text: distillReply, model: 'chat-x'});
        }
        if (url.pathname === '/api/design-brain/experiences' && request.method() === 'GET') {
            return json({experiences: state.experiences});
        }
        if (url.pathname === '/api/design-brain/experiences' && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const created = {
                id: 'exp_created', status: 'candidate', title: body.title || '', project_id: body.project_id || '',
                origin: body.origin || {}, observations: body.observations || [],
                evidence: body.evidence || {history_timestamps: [], asset_refs: [], canvas_ids: []},
                proposals: body.proposals || {profile_patch: []},
                review: {requested_at: 0, decided_at: 0, comment: ''},
                publish: {published_at: 0, applied_profile_tags: [], skill_id: ''},
                distill_meta: body.distill_meta || {provider: '', model: '', at: 0},
                created_at: 9, updated_at: 9,
            };
            state.experiences = [created, ...state.experiences];
            return json({experience: created});
        }
        const experiencePatch = url.pathname.match(/^\/api\/design-brain\/experiences\/([^/]+)$/);
        if (experiencePatch && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: url.pathname, body});
            const target = state.experiences.find(item => item.id === experiencePatch[1]);
            if (target) Object.assign(target, body);
            return json({experience: target});
        }
        const experienceSkill = url.pathname.match(/^\/api\/design-brain\/experiences\/([^/]+)\/skill$/);
        if (experienceSkill && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const skill = {
                skill_id: 'skill_new', experience_id: experienceSkill[1], lifecycle: 'draft',
                created_at: 9, current_version: 1, installed: true, enabled: false,
                display_name: body.name || '新 Skill', registry_version: '1.0.1',
                versions: [{version: 1, sha256: 'n', created_at: 9, note: '从经验生成'}],
            };
            state.skills = [skill, ...state.skills];
            const target = state.experiences.find(item => item.id === experienceSkill[1]);
            if (target) target.publish = {...(target.publish || {}), skill_id: 'skill_new'};
            return json({skill: {id: 'skill_new', name: skill.display_name, display_name: skill.display_name, enabled: false}, link: {}});
        }
        const experienceAction = url.pathname.match(/^\/api\/design-brain\/experiences\/([^/]+)\/(submit|publish|reject|requeue)$/);
        if (experienceAction && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname});
            const target = state.experiences.find(item => item.id === experienceAction[1]);
            const action = experienceAction[2];
            if (target) {
                if (action === 'submit') target.status = 'pending_review';
                if (action === 'publish') {
                    target.status = 'published';
                    target.publish = {published_at: 9, applied_profile_tags: [{group: 'style_tags', tag: '浅底渐变'}], skill_id: ''};
                }
                if (action === 'reject') target.status = 'rejected';
                if (action === 'requeue') target.status = 'candidate';
            }
            return json({experience: target, applied_profile_tags: action === 'publish' ? [{group: 'style_tags', tag: '浅底渐变'}] : undefined});
        }
        if (experiencePatch && request.method() === 'DELETE') {
            state.requests.push({method: 'DELETE', path: url.pathname});
            state.experiences = state.experiences.filter(item => item.id !== experiencePatch[1]);
            return json({ok: true});
        }
        if (url.pathname === '/api/design-brain/skills' && request.method() === 'GET') {
            return json({skills: state.skills.map(item => ({...item, content: undefined}))});
        }
        if (url.pathname === '/api/design-brain/runs' && request.method() === 'GET') {
            return json({runs: [{
                id: 'run_1', title: '玻璃杯主图', status: 'completed', brief: '玻璃杯新品主图',
                canvas_id: 'c1', project_id: 'p1', profile_revision: 7,
                profile_summary: {style_tags: ['极简']},
                case_ids: [{id: 'case_a', title: '玻璃杯浅底主图', score: 0.8}],
                skill: {skill_id: 'glass-style', name: '玻璃质感 Skill', version: 'v2', selection_reason: '重合 2 处'},
                plan: {summary: '浅底方案', prompt: '浅灰渐变底，玻璃杯居中', options: [], selected_index: 0},
                execution: {canvas_task_ids: ['canvas_img_1'], history_timestamps: [123.5],
                            asset_refs: [{url: '/api/storage-files/generated/a.png', asset_ref_id: 'asset_abc12345'}],
                            models: ['gpt-image-2'], node_ids: ['n1']},
                result: {error: '', note: '创建 2 个节点，执行 1 个阶段'},
                events: [{at: 1, type: 'created', note: '方案已生成，等待确认'}, {at: 2, type: 'task_succeeded', note: 'gpt-image-2 succeeded'}],
                created_at: 1729900000000, updated_at: 1729900001000,
            }]});
        }
        // ---- 阶段 4：质量反馈、统计建议、对照与数据管理 ----
        if (url.pathname === '/api/design-brain/reviews' && request.method() === 'GET') {
            const skillFilter = url.searchParams.get('skill_id') || '';
            const all = [
                {id: 'rev_v1', created_at: 3, issue_tag: 'color',
                 target: {url: '/api/storage-files/generated/r1.png', asset_ref_id: 'asset_abc12345', history_timestamp: 11, run_id: 'run_1', canvas_id: 'c1'},
                 context: {skill_id: 'glass-style', skill_name: '玻璃质感 Skill', skill_version: 'v1', model: 'gpt-image-2', provider_id: 'prov-a', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc', reference_count: 2, prompt_digest: 'sha256:d1'},
                 user_feedback: {rating: 2, comment: '颜色发灰', selected_as_final: false},
                 auto_checks: {file_ok: true, width: 1024, height: 1024, min_edge_ok: true, note: ''}},
                {id: 'rev_v2', created_at: 4, issue_tag: '',
                 target: {url: '/api/storage-files/generated/r2.png', asset_ref_id: 'asset_abc12346', history_timestamp: 12, run_id: 'run_1', canvas_id: 'c1'},
                 context: {skill_id: 'glass-style', skill_name: '玻璃质感 Skill', skill_version: 'v2', model: 'gpt-image-2', provider_id: 'prov-a', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc', reference_count: 2, prompt_digest: 'sha256:d1'},
                 user_feedback: {rating: 5, comment: '升级后质感明显更好', selected_as_final: true},
                 auto_checks: {file_ok: true, width: 1024, height: 1024, min_edge_ok: true, note: ''}},
                {id: 'rev_other', created_at: 5, issue_tag: 'texture',
                 target: {url: '/api/storage-files/generated/r3.png', asset_ref_id: '', history_timestamp: 13, run_id: '', canvas_id: ''},
                 context: {skill_id: 'glass-style', skill_name: '玻璃质感 Skill', skill_version: 'v2', model: 'gemini-3-pro-image', provider_id: 'prov-b', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc', reference_count: 2, prompt_digest: 'sha256:d1'},
                 user_feedback: {rating: 3, comment: '不同模型的结果', selected_as_final: false},
                 auto_checks: {file_ok: false, width: 0, height: 0, min_edge_ok: false, note: '原图不在本机，跳过本地检查'}},
            ];
            const reviews = skillFilter ? all.filter(item => item.context.skill_id === skillFilter) : all;
            return json({reviews});
        }
        const reviewDelete = url.pathname.match(/^\/api\/design-brain\/reviews\/([^/]+)$/);
        if (reviewDelete && request.method() === 'DELETE') {
            state.requests.push({method: 'DELETE', path: url.pathname});
            return json({ok: true});
        }
        if (url.pathname === '/api/design-brain/reviews/compare' && request.method() === 'GET') {
            const a = url.searchParams.get('a'), b = url.searchParams.get('b');
            state.requests.push({method: 'GET', path: '/api/design-brain/reviews/compare', a, b});
            const table = {
                'rev_v1': {context: {skill_id: 'glass-style', model: 'gpt-image-2', provider_id: 'prov-a', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc'}, id: 'rev_v1', user_feedback: {rating: 2}},
                'rev_v2': {context: {skill_id: 'glass-style', model: 'gpt-image-2', provider_id: 'prov-a', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc'}, id: 'rev_v2', user_feedback: {rating: 5}},
                'rev_other': {context: {skill_id: 'glass-style', model: 'gemini-3-pro-image', provider_id: 'prov-b', size: '1024x1024', quality: 'high', reference_digest: 'sha256:abc'}, id: 'rev_other', user_feedback: {rating: 3}},
            };
            const left = table[a], right = table[b];
            const differences = [];
            for (const field of ['skill_id', 'model', 'provider_id', 'reference_digest', 'size', 'quality']) {
                if (String((left.context || {})[field] || '') !== String((right.context || {})[field] || '')) differences.push(field);
            }
            return json({comparison: {comparable: !differences.length, same_skill: true, differences,
                                       left: {id: a, skill_version: a === 'rev_v1' ? 'v1' : 'v2', rating: left.user_feedback.rating},
                                       right: {id: b, skill_version: b === 'rev_v1' ? 'v1' : 'v2', rating: right.user_feedback.rating}}});
        }
        const skillStats = url.pathname.match(/^\/api\/design-brain\/skills\/([^/]+)\/stats$/);
        if (skillStats && request.method() === 'GET') {
            return json({skill_id: skillStats[1],
                stats: {count: 3, average: 3.33, by_version: [{version: 'v1', count: 1, average: 2}, {version: 'v2', count: 2, average: 4}], last_three_all_low: false, low_count: 1},
                suggestion: null,
                reviews: []});
        }
        const suggestExperience = url.pathname.match(/^\/api\/design-brain\/skills\/([^/]+)\/suggest-experience$/);
        if (suggestExperience && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname});
            const created = {id: 'exp_suggest', status: 'candidate', title: `优化建议：${suggestExperience[1]}`,
                             observations: ['该 Skill 近期评分持续偏低'], evidence: {history_timestamps: [11], asset_refs: [{url: '/api/storage-files/generated/r1.png'}]},
                             proposals: {profile_patch: []}, origin: {type: 'manual', note: '低分评价'}, review: {requested_at: 0, decided_at: 0, comment: ''},
                             publish: {published_at: 0, applied_profile_tags: [], skill_id: ''}, distill_meta: {provider: '', model: '', at: 0}, created_at: 9, updated_at: 9};
            state.experiences = [created, ...state.experiences];
            return json({experience: created, suggestion: {reason: '整体均分 2.0 偏低', low_review_ids: ['rev_v1'], observations: [], evidence: [], notice: '候选经验需人工审核'}});
        }
        if (url.pathname === '/api/design-brain/export' && request.method() === 'GET') {
            state.requests.push({method: 'GET', path: '/api/design-brain/export'});
            return route.fulfill({status: 200, contentType: 'application/json',
                                  headers: {'Content-Disposition': 'attachment; filename="design-brain-export-1.json"'},
                                  body: JSON.stringify({format: 'xiaomei-design-brain-export', version: 1, profile: {}, experiences: [], skill_links: {}, runs: [], reviews: []})});
        }
        if (url.pathname === '/api/design-brain/data/delete' && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: '/api/design-brain/data/delete', body});
            if (body.confirm !== '删除') return json({detail: '请在确认框中输入「删除」两个字'}, 400);
            return json({ok: true, scope: body.scope, cleared: [body.scope], note: '物理 Skill 包仍在技能市场管理'});
        }
        const skillPatch = url.pathname.match(/^\/api\/design-brain\/skills\/([^/]+)$/);
        if (skillPatch && request.method() === 'GET') {
            const target = state.skills.find(item => item.skill_id === skillPatch[1]);
            return target ? json({skill: target}) : json({detail: 'not found'}, 404);
        }
        if (skillPatch && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: url.pathname, body});
            const target = state.skills.find(item => item.skill_id === skillPatch[1]);
            if (target) {
                target.current_version += 1;
                target.versions.push({version: target.current_version, sha256: 'x', created_at: 9, note: '编辑内容'});
                target.display_name = body.name || target.display_name;
            }
            return json({skill: {}, link: {}});
        }
        const skillPublish = url.pathname.match(/^\/api\/design-brain\/skills\/([^/]+)\/publish$/);
        if (skillPublish && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname});
            const target = state.skills.find(item => item.skill_id === skillPublish[1]);
            if (target) target.lifecycle = 'published';
            return json({skill: {}, link: {lifecycle: 'published'}});
        }
        const skillRollback = url.pathname.match(/^\/api\/design-brain\/skills\/([^/]+)\/rollback$/);
        if (skillRollback && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const target = state.skills.find(item => item.skill_id === skillRollback[1]);
            if (target) {
                target.current_version += 1;
                target.versions.push({version: target.current_version, sha256: 'r', created_at: 9, note: `回退自 v${body.version}`});
            }
            return json({skill: {}, link: {}});
        }
        const agentSkillPatch = url.pathname.match(/^\/api\/agent-skills\/([^/]+)$/);
        if (agentSkillPatch && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: '/api/agent-skills', id: agentSkillPatch[1], body});
            const target = state.skills.find(item => item.skill_id === agentSkillPatch[1]);
            if (body.enabled === true && target && target.lifecycle === 'draft') {
                return json({detail: '该 Skill 是设计大脑草稿，请先在设计大脑中发布后再启用'}, 409);
            }
            if (target && body.enabled !== undefined) target.enabled = Boolean(body.enabled);
            return json({skill: {id: agentSkillPatch[1]}});
        }
        // ---- 参考素材库 ----
        if (url.pathname === '/api/design-brain/references' && request.method() === 'GET') {
            state.requests.push({method: 'GET', path: url.pathname,
                                 category: url.searchParams.get('category') || '',
                                 purpose: url.searchParams.get('purpose') || '',
                                 analysis: url.searchParams.get('analysis') || '',
                                 q: url.searchParams.get('q') || ''});
            let items = state.references;
            for (const key of ['category', 'purpose', 'expression']) {
                const wanted = url.searchParams.get(key);
                if (wanted) items = items.filter(item => ((item.classification || {})[key] || '') === wanted);
            }
            const analysisFilter = url.searchParams.get('analysis');
            if (analysisFilter) items = items.filter(item => ((item.analysis || {}).status || 'none') === analysisFilter);
            const query = (url.searchParams.get('q') || '').trim();
            if (query) {
                items = items.filter(item => {
                    const content = (item.analysis || {}).content || {};
                    const haystack = [item.title, (item.file || {}).name, (item.source || {}).folder, item.notes,
                                      ...((item.classification || {}).tags || []),
                                      ...Object.values(content)].join(' ');
                    return query.split(/\s+/).every(word => haystack.includes(word));
                });
            }
            if (url.searchParams.get('favorite') === 'true') items = items.filter(item => item.favorite);
            const facets = {category: {}, purpose: {}, expression: {}, tags: {}, analysis: {none: 0, pending: 0, ready: 0, failed: 0}};
            for (const item of state.references) {
                const cls = item.classification || {};
                for (const key of ['category', 'purpose', 'expression']) {
                    if (cls[key]) facets[key][cls[key]] = (facets[key][cls[key]] || 0) + 1;
                }
                for (const tag of cls.tags || []) facets.tags[tag] = (facets.tags[tag] || 0) + 1;
                facets.analysis[(item.analysis || {}).status || 'none'] += 1;
            }
            return json({items, facets, total: items.length, limit: 200, offset: 0,
                         presets: {category: ['家居', '相框', '美妆', '其他'], purpose: ['主图', '详情页', '其他'],
                                   expression: ['材质表现', '创意展示', '其他']}});
        }
        if (url.pathname === '/api/design-brain/references/import' && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname});
            return json({ok: true, count: 4, results: [
                {status: 'imported', name: 'a.jpg', id: 'ref_n1', title: 'a'},
                {status: 'imported', name: 'b.jpg', id: 'ref_n2', title: 'b'},
                {status: 'duplicate', name: 'c.jpg', id: 'ref_a', duplicate_of: 'ref_a', title: '相框主图'},
                {status: 'failed', name: 'd.jpg', error: '不支持的图片类型（支持 jpg/png/webp/gif/bmp）：d.jpg'},
            ]});
        }
        if (url.pathname === '/api/design-brain/references/import-remote' && request.method() === 'POST') {
            state.requests.push({method: 'POST', path: url.pathname, body: request.postDataJSON()});
            return json({code: 'remote_import_not_supported', detail: '花瓣没有公开可用的 API，本版本不实现自动抓取。'}, 501);
        }
        if (url.pathname === '/api/design-brain/references/batch-update' && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const updated = [];
            for (const id of body.ids || []) {
                const target = state.references.find(item => item.id === id);
                if (!target) continue;
                const incoming = (body.patch || {}).classification || {};
                for (const key of ['category', 'purpose', 'expression']) {
                    if (incoming[key] !== undefined) target.classification[key] = incoming[key];
                }
                if (incoming.tags) target.classification.tags = incoming.tags;
                if ((body.patch || {}).favorite !== undefined) target.favorite = body.patch.favorite;
                updated.push(target);
            }
            return json({ok: true, updated: updated.length, references: updated});
        }
        if (url.pathname === '/api/design-brain/references/batch-delete' && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            state.references = state.references.filter(item => !(body.ids || []).includes(item.id));
            return json({ok: true, deleted: (body.ids || []).length});
        }
        const refImage = url.pathname.match(/^\/api\/design-brain\/references\/([^/]+)\/image$/);
        if (refImage && request.method() === 'GET') {
            return route.fulfill({status: 200, contentType: 'image/png', body: PNG_1PX});
        }
        const refPatch = url.pathname.match(/^\/api\/design-brain\/references\/([^/]+)$/);
        if (refPatch && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: url.pathname, body});
            const target = state.references.find(item => item.id === refPatch[1]);
            if (target) {
                if (body.classification) target.classification = body.classification;
                if (body.favorite !== undefined) target.favorite = body.favorite;
                if (body.notes !== undefined) target.notes = body.notes;
            }
            return json({reference: target || {}});
        }
        if (refPatch && request.method() === 'DELETE') {
            state.requests.push({method: 'DELETE', path: url.pathname});
            state.references = state.references.filter(item => item.id !== refPatch[1]);
            return json({ok: true});
        }
        const refAnalysis = url.pathname.match(/^\/api\/design-brain\/references\/([^/]+)\/analysis$/);
        if (refAnalysis && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.requests.push({method: 'POST', path: url.pathname, body});
            const target = state.references.find(item => item.id === refAnalysis[1]);
            if (target) {
                if (body.status === 'ready') {
                    target.analysis = {status: 'ready', provider: body.provider || '', model: body.model || '',
                                       analyzed_at: 9, error: '', content: body.content || {},
                                       suggested: body.suggested || {}, edited: false, edited_at: 0};
                } else if (body.status === 'failed') {
                    target.analysis.status = 'failed';
                    target.analysis.error = body.error || '';
                } else {
                    target.analysis.status = body.status;
                }
            }
            return json({reference: target});
        }
        if (refAnalysis && request.method() === 'PATCH') {
            const body = request.postDataJSON();
            state.requests.push({method: 'PATCH', path: url.pathname, body});
            const target = state.references.find(item => item.id === refAnalysis[1]);
            if (target) {
                Object.assign(target.analysis.content, body.content || {});
                target.analysis.edited = true;
            }
            return json({reference: target});
        }
        if (request.resourceType() === 'image') {
            return route.fulfill({status: 200, contentType: 'image/png', body: PNG_1PX});
        }
        return route.fulfill({status: 404, contentType: 'application/json', body: '{"detail":"not found"}'});
    });
    await page.goto(PAGE_URL);
    // 设计工作台是页面默认标签；本文件测试资料库各标签，先切到灵感库。
    await gotoTab(page, 'cases');
    await page.waitForSelector('.case-card');
    return {page, state};
}

test('design brain panel renders refs cases only and filters by tag and search', async t => {
    const {page, state} = await openPanel(t);
    const cards = page.locator('.case-card');
    assert.equal(await cards.count(), 2);
    assert.match(await page.locator('.case-card').first().innerText(), /浅底玻璃杯主图/);

    await page.click('[data-filter-tag="国风"]');
    assert.equal(await page.locator('.case-card').count(), 1);
    await page.click('[data-filter-tag="国风"]');

    await page.fill('#caseSearch', '玻璃');
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.case-card').count(), 1);
    const searchRequest = state.requests.find(item => item.method === 'GET' && item.path === '/api/prompt-cases' && item.query === '玻璃');
    assert.ok(searchRequest, 'search should hit the server with q');
    assert.equal(searchRequest.mode, 'refs');

    await page.fill('#caseSearch', '');
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.case-card').count(), 2);
    await page.check('#favoriteFilter');
    assert.equal(await page.locator('.case-card').count(), 1);
    assert.deepEqual(state.pageErrors, []);
});

test('profile tab edits tags, saves with revision, and surfaces conflicts', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'profile');
    await page.waitForSelector('#profilePanel:not([hidden])');

    await page.fill('[data-add-tag-input="style_tags"]', '轻奢');
    await page.click('[data-add-tag="style_tags"]');
    assert.match(await page.locator('[data-group="style_tags"]').innerText(), /轻奢/);

    const chipSelect = page.locator('[data-group="style_tags"] .pf-chip', {hasText: '轻奢'}).locator('select');
    await chipSelect.selectOption('0.9');
    await page.click('#saveProfileButton');
    await page.waitForFunction(() => document.getElementById('profileStatus').textContent === '已保存');
    const put = [...state.requests].reverse().find(item => item.method === 'PUT');
    assert.ok(put);
    assert.equal(put.body.expected_revision, 3);
    const savedTag = put.body.profile.aesthetics.style_tags.find(item => item.tag === '轻奢');
    assert.ok(savedTag, 'new tag persisted in PUT body');
    assert.equal(savedTag.weight, 0.9);

    state.conflictNext = true;
    await page.fill('[data-add-tag-input="color_preferences"]', '低饱和');
    await page.click('[data-add-tag="color_preferences"]');
    await page.click('#saveProfileButton');
    await page.waitForFunction(() => document.getElementById('profileStatus').textContent.includes('其他窗口更新'));
    assert.match(await page.locator('#profileStatus').innerText(), /其他窗口更新/);
    assert.deepEqual(state.pageErrors, []);
});

test('case detail edits analysis and applies to canvas through the existing bridge', async t => {
    const {page, state} = await openPanel(t);
    await page.click('[data-open-case="case_r1"]');
    await page.waitForSelector('#caseOverlay:not([hidden])');
    assert.match(await page.locator('#detailBody').innerText(), /浅灰渐变底/);

    await page.fill('[data-analysis="style"]', '极简留白');
    const savedResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('case_r1'));
    await page.click('[data-save-case="case_r1"]');
    await savedResponse;
    const patch = [...state.requests].reverse().find(item => item.method === 'PATCH' && /case_r1/.test(item.path));
    assert.ok(patch);
    assert.equal(patch.body.analysis.style, '极简留白');

    // 等保存提示出现（保存会重渲染详情区），再点应用，避免点到重渲染前的旧按钮坐标。
    await page.waitForFunction(() => ((document.querySelector('.db-toast') || {}).textContent || '').includes('已保存'));
    await page.click('[data-apply-case="case_r1"]');
    await page.waitForFunction(() => window.__dbMessages.some(item => item?.type === 'prompt-case-apply-request'));
    const messages = await page.evaluate(() => window.__dbMessages);
    const applyMessage = messages.find(item => item && item.type === 'prompt-case-apply-request');
    assert.ok(applyMessage, 'apply posts the studio bridge message');
    assert.equal(applyMessage.case.prompt.display, '浅灰渐变底，玻璃杯居中，柔光');
    assert.deepEqual(state.pageErrors, []);
});

test('favorite toggle round-trips and picker creates a refs case from image space', async t => {
    const {page, state} = await openPanel(t);
    await page.click('[data-favorite-case="case_r2"]');
    await page.waitForTimeout(200);
    const patch = [...state.requests].reverse().find(item => item.method === 'PATCH' && /case_r2/.test(item.path));
    assert.ok(patch);
    assert.equal(patch.body.favorite, false);

    await page.click('#addReferenceButton');
    await page.waitForSelector('#pickerOverlay:not([hidden])');
    await page.waitForSelector('.picker-item');
    assert.equal(await page.locator('.picker-item').count(), 2);
    await page.click('.picker-item >> nth=0');
    assert.equal(await page.locator('.picker-item.selected').count(), 1);
    assert.ok(await page.isDisabled('#pickerCreate'));
    await page.fill('#pickerTitleInput', '质感参考');
    assert.ok(await page.isEnabled('#pickerCreate'));
    await page.fill('#pickerTagsInput', '质感, 玻璃');
    await page.click('#pickerCreate');
    await page.waitForFunction(() => document.getElementById('pickerOverlay').hidden === true);
    const post = [...state.requests].reverse().find(item => item.method === 'POST' && item.path === '/api/prompt-cases');
    assert.ok(post);
    assert.equal(post.body.media_mode, 'refs');
    assert.equal(post.body.variants[0].url, '/api/storage-files/generated/p1.png');
    assert.equal(post.body.origin.type, 'image_space');
    assert.deepEqual(post.body.tags, ['质感', '玻璃']);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.case-card').count(), 3);
    assert.deepEqual(state.pageErrors, []);
});

test('experience lifecycle flows from history pick to published', async t => {
    const {page, state} = await openPanel(t);
    await autoDialogs(page);
    await gotoTab(page, 'experiences');
    await page.click('#pickHistoryButton');
    await page.waitForSelector('#historyOverlay:not([hidden])');
    await page.waitForSelector('[data-history-ts]');
    assert.equal(await page.locator('[data-history-ts]').count(), 3);
    await page.click('[data-history-ts="100.5"]');
    await page.click('[data-history-ts="101.5"]');
    assert.match(await page.locator('#historyPickCount').innerText(), /已选 2 条/);
    await page.click('#historyConfirm');
    await page.waitForSelector('#experienceOverlay:not([hidden])');
    assert.match(await page.locator('#expTitle').inputValue(), /浅灰渐变底玻璃杯/);

    await page.fill('#expObservations', '玻璃制品主图用浅灰渐变底更保质感\n国风礼盒适合搭配留白构图');
    await page.click('#expSave');
    await page.waitForFunction(() => document.getElementById('experienceOverlay').hidden === true);
    const post = state.requests.find(item => item.method === 'POST' && item.path === '/api/design-brain/experiences');
    assert.ok(post, 'experience create captured');
    assert.deepEqual(post.body.evidence.history_timestamps, [100.5, 101.5]);
    assert.equal(post.body.evidence.asset_refs.length, 2);
    assert.match(await page.locator('.exp-card').first().innerText(), /候选/);

    await page.click('.exp-card >> nth=0');
    await page.waitForSelector('#experienceOverlay:not([hidden])');
    await page.click('[data-exp-action="submit"]');
    await page.waitForSelector('[data-exp-action="publish"]');
    await page.click('[data-exp-action="publish"]');
    await page.waitForSelector('.exp-card .status-published');
    const publishRequest = state.requests.find(item => item.method === 'POST' && /\/publish$/.test(item.path));
    assert.ok(publishRequest, 'publish captured');
    assert.match(await page.locator('.exp-card').first().innerText(), /已发布/);
    assert.match(await page.locator('.publish-effects').innerText(), /浅底渐变/);
    assert.deepEqual(state.pageErrors, []);
});

test('ai distill is privacy gated and fills observations when allowed', async t => {
    const gated = await openPanel(t);
    await gated.page.click('#pickHistoryButton');
    await gated.page.waitForSelector('#historyConfirm');
    await gated.page.click('[data-history-ts="100.5"]');
    await gated.page.click('#historyConfirm');
    await gated.page.waitForSelector('#distillButton');
    assert.ok(await gated.page.isDisabled('#distillButton'));
    assert.match(await gated.page.locator('#distillNote').innerText(), /隐私开关/);

    const allowed = await openPanel(t, {allowCloudAnalysis: true});
    const {page, state} = allowed;
    await autoDialogs(page);
    await page.click('#pickHistoryButton');
    await page.waitForSelector('#historyConfirm');
    await page.click('[data-history-ts="100.5"]');
    await page.click('#historyConfirm');
    await page.waitForSelector('#distillButton');
    await page.selectOption('#distillProvider', 'prov-a');
    await page.selectOption('#distillModel', 'chat-x');
    await page.click('#distillButton');
    await page.waitForFunction(() => (document.getElementById('expObservations').value || '').includes('浅灰渐变底'));
    const llm = state.requests.find(item => item.method === 'POST' && item.path === '/api/canvas-llm');
    assert.ok(llm, 'canvas-llm distill captured');
    assert.equal(llm.body.provider, 'prov-a');
    assert.equal(llm.body.model, 'chat-x');
    assert.match(llm.body.message, /浅灰渐变底玻璃杯居中柔光/);
    await page.waitForFunction(() => document.querySelectorAll('#patchRows .patch-row').length >= 1);
    assert.equal(await page.locator('#patchRows .patch-tag').inputValue(), '浅底渐变');
    assert.equal(await page.locator('#patchRows .patch-group').inputValue(), 'style_tags');
    assert.deepEqual(state.pageErrors, []);
});

test('draft skill cannot be enabled until published; edit and rollback versions', async t => {
    const {page, state} = await openPanel(t);
    await autoDialogs(page);
    await gotoTab(page, 'skills');
    await page.waitForSelector('[data-skill-id="light-box-style"]');
    assert.match(await page.locator('[data-skill-id="light-box-style"]').innerText(), /草稿/);

    await page.click('[data-skill-id="light-box-style"]');
    await page.waitForSelector('#skillOverlay:not([hidden])');
    await page.click('[data-skill-action="enable"]');
    await page.waitForSelector('.db-toast.error');
    assert.match(await page.locator('.db-toast.error').innerText(), /草稿/);
    const blockedPatch = state.requests.find(item => item.path === '/api/agent-skills' && item.body && item.body.enabled === true && item.id === 'light-box-style');
    assert.ok(blockedPatch, 'enable attempt captured');

    await page.click('[data-skill-action="publish"]');
    await page.waitForFunction(() => {
        const badge = document.querySelector('#skillBody .lifecycle-badge');
        return badge && badge.classList.contains('lifecycle-published');
    });
    assert.match(await page.locator('#skillBody > p.muted').innerText(), /已发布/);
    await page.click('[data-skill-action="enable"]');
    await page.waitForFunction(() => (document.querySelector('#skillBody > p.muted') || {innerText: ''}).innerText.includes('已启用'));

    await page.fill('#skillInstructions', '# 使用场景\n\n- 更新后的规则：浅灰渐变底 + 柔光侧打光\n');
    await page.click('[data-skill-action="save"]');
    await page.waitForFunction(() => {
        const list = document.getElementById('versionList');
        return list && list.innerText.includes('v3');
    });
    const editPatch = state.requests.find(item => item.method === 'PATCH' && /\/api\/design-brain\/skills\/light-box-style$/.test(item.path));
    assert.ok(editPatch, 'skill edit captured');
    assert.match(editPatch.body.instructions, /更新后的规则/);

    await page.click('[data-rollback="1"]');
    await page.waitForFunction(() => {
        const list = document.getElementById('versionList');
        return list && list.innerText.includes('回退自 v1');
    });
    const rollbackRequest = state.requests.find(item => item.method === 'POST' && /\/rollback$/.test(item.path));
    assert.deepEqual(rollbackRequest.body, {version: 1});
    assert.deepEqual(state.pageErrors, []);
});

test('published experience generates a draft skill linked back to its source', async t => {
    const seedExperience = {
        id: 'exp_src', status: 'published', title: '浅底更保质感', project_id: '',
        origin: {type: 'manual'}, observations: ['浅灰渐变底更保质感'],
        evidence: {history_timestamps: [], asset_refs: [], canvas_ids: []},
        proposals: {profile_patch: []},
        review: {requested_at: 1, decided_at: 2, comment: ''},
        publish: {published_at: 2, applied_profile_tags: [], skill_id: ''},
        distill_meta: {provider: '', model: '', at: 0}, created_at: 1, updated_at: 2,
    };
    const {page, state} = await openPanel(t, {experiences: [seedExperience]});
    await autoDialogs(page, {prompt: '玻璃质感 Skill'});
    await gotoTab(page, 'experiences');
    await page.click('.exp-card >> nth=0');
    await page.waitForSelector('[data-exp-action="skill"]');
    await page.click('[data-exp-action="skill"]');
    await page.waitForSelector('[data-skill-id="skill_new"]');
    const generateRequest = state.requests.find(item => item.method === 'POST' && /\/experiences\/exp_src\/skill$/.test(item.path));
    assert.ok(generateRequest, 'skill generation captured');
    assert.equal(generateRequest.body.name, '玻璃质感 Skill');
    assert.match(await page.locator('[data-skill-id="skill_new"]').innerText(), /草稿/);
    assert.match(await page.locator('[data-skill-id="skill_new"]').innerText(), /来自经验「浅底更保质感」/);
    assert.deepEqual(state.pageErrors, []);
});

test('runs tab traces profile revision, skill, tasks and media references', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'runs');
    await page.waitForSelector('[data-run-id="run_1"]');
    assert.match(await page.locator('#runCount').innerText(), /1 条执行记录/);
    const card = page.locator('[data-run-id="run_1"]');
    const summary = await card.innerText();
    assert.match(summary, /已完成/);
    assert.match(summary, /档案 v7/);
    assert.match(summary, /Skill 玻璃质感 Skill v2/);
    assert.match(summary, /案例 ×1/);
    assert.match(summary, /任务 ×1/);
    assert.match(summary, /图片 ×1/);
    assert.equal(await card.locator('.run-detail').isHidden(), true);
    await card.click();
    await page.waitForFunction(() => {
        const detail = document.querySelector('[data-run-id="run_1"] .run-detail');
        return detail && !detail.hidden && detail.innerText.includes('gpt-image-2');
    });
    assert.deepEqual(state.pageErrors, []);
});

test('quality reviews tab renders ratings, comparable comparison, and data management gates', async t => {
    const {page, state} = await openPanel(t);
    await autoDialogs(page);
    await gotoTab(page, 'reviews');
    await page.waitForSelector('[data-review-id="rev_v1"]');
    assert.match(await page.locator('#reviewCount').innerText(), /3 条评价/);
    const first = page.locator('[data-review-id="rev_v1"]');
    assert.match(await first.innerText(), /玻璃质感 Skill v1/);
    assert.match(await first.innerText(), /构图|色彩/);
    assert.match(await first.innerText(), /颜色发灰/);
    assert.match(await page.locator('[data-review-id="rev_other"]').innerText(), /原图不在本机/);

    // 对照测试：同条件（v1 vs v2）可比；跨模型不可比并列出差异字段。
    await page.click('#compareToggleButton');
    await page.waitForSelector('#compareBar:not([hidden])');
    await page.selectOption('#compareA', 'rev_v1');
    await page.selectOption('#compareB', 'rev_v2');
    await page.click('#compareRunButton');
    await page.waitForFunction(() => (document.getElementById('compareVerdict').innerText || '').includes('可比'));
    assert.match(await page.locator('#compareVerdict').innerText(), /v1/);
    assert.match(await page.locator('#compareVerdict').innerText(), /v2/);
    await page.selectOption('#compareA', 'rev_v1');
    await page.selectOption('#compareB', 'rev_other');
    await page.click('#compareRunButton');
    await page.waitForFunction(() => (document.getElementById('compareVerdict').innerText || '').includes('不可比'));
    assert.match(await page.locator('#compareVerdict').innerText(), /模型/);

    // Skill 统计 + 建议：筛选后出现统计框。
    await page.selectOption('#reviewSkillFilter', 'glass-style');
    await page.waitForFunction(() => (document.getElementById('skillStatsBox').innerText || '').includes('均分'));
    assert.match(await page.locator('#skillStatsBox').innerText(), /v1：.*分|版本分布/);

    // 数据管理：确认文字不对 → 拒绝；正确 → POST 成功。
    await gotoTab(page, 'profile');
    await page.click('#dataManagement summary');
    await page.waitForSelector('#deleteConfirmInput:visible');
    await page.fill('#deleteConfirmInput', '删除一下');
    await page.click('#deleteDataButton');
    await page.waitForFunction(() => (document.getElementById('dataStatus').innerText || '').includes('输入'));
    assert.equal(state.requests.filter(item => item.path === '/api/design-brain/data/delete').length, 0, 'wrong confirm must not submit');
    await page.fill('#deleteConfirmInput', '删除');
    await page.click('#deleteDataButton');
    await page.waitForFunction(() => (document.getElementById('dataStatus').innerText || '').includes('已删除'));
    const deleteRequest = state.requests.find(item => item.path === '/api/design-brain/data/delete');
    assert.deepEqual(deleteRequest.body, {scope: 'all', confirm: '删除'});
    assert.deepEqual(state.pageErrors, []);
});

test('low-rating stats surface improvement suggestion that only creates a candidate experience', async t => {
    const {page, state} = await openPanel(t);
    await autoDialogs(page);
    await page.route('**/api/design-brain/skills/*/stats', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({
        skill_id: 'glass-style',
        stats: {count: 4, average: 2.0, by_version: [{version: 'v2', count: 4, average: 2.0}], last_three_all_low: true, low_count: 4},
        suggestion: {reason: '最近 3 次使用全部低分', low_review_ids: ['rev_v1'],
                     observations: ['「玻璃质感 Skill」近期评分持续偏低（均分 2.0，低分 4 条）'],
                     evidence: [{url: '/api/storage-files/generated/r1.png', history_timestamp: 11}],
                     notice: '该建议只会生成候选经验；需人工审核发布后才允许升级 Skill 版本。'},
        reviews: [],
    })}));
    await gotoTab(page, 'reviews');
    await page.selectOption('#reviewSkillFilter', 'glass-style');
    await page.waitForSelector('#suggestExperienceButton');
    assert.match(await page.locator('#skillStatsBox').innerText(), /经验优化建议/);
    assert.match(await page.locator('#skillStatsBox').innerText(), /人工审核/);
    await page.click('#suggestExperienceButton');
    await page.waitForSelector('#tabExperiences.active');
    const suggestRequest = state.requests.find(item => item.method === 'POST' && /\/suggest-experience$/.test(item.path));
    assert.ok(suggestRequest, 'suggest-experience captured');
    assert.match(await page.locator('#experienceGrid').innerText(), /优化建议/);
    // 建议产物是候选经验：没有任何 Skill 写入端点被调用。
    assert.equal(state.requests.filter(item => /\/api\/design-brain\/skills\/.+\/(publish|rollback)$/.test(item.path) && item.method === 'POST').length, 0);
    assert.deepEqual(state.pageErrors, []);
});

test('references tab renders grid with analysis badges and filters by category', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'references');
    await page.waitForSelector('#referencesPanel:not([hidden])');
    await page.waitForSelector('.ref-card');
    assert.equal(await page.locator('.ref-card').count(), 3);
    assert.equal(await page.locator('.analysis-badge.analysis-ready').count(), 1);
    assert.equal(await page.locator('.analysis-badge.analysis-failed').count(), 1);
    assert.match(await page.locator('#refCount').innerText(), /3 张参考图 · 已分析 1 · 未分析 1 · 失败 1/);
    assert.match(await page.locator('#refAnalyzeButton').innerText(), /AI 分析未分析（2）/);
    // 卡片展示分类维度与来源目录。
    assert.match(await page.locator('.ref-card').first().innerText(), /相框主图/);
    assert.match(await page.locator('.ref-card').first().innerText(), /参考图\/家居\/相框/);

    // 品类筛选走服务端参数。
    await page.selectOption('#refCategoryFilter', '家居');
    await page.waitForFunction(() => document.querySelectorAll('.ref-card').length === 1);
    const filterRequest = [...state.requests].reverse().find(item => item.method === 'GET' && item.path === '/api/design-brain/references');
    assert.equal(filterRequest.category, '家居');

    // 收藏走单张 PATCH。
    await page.click('[data-ref-favorite="ref_a"]');
    await page.waitForTimeout(200);
    const favoritePatch = state.requests.find(item => item.method === 'PATCH' && /\/references\/ref_a$/.test(item.path) && item.body && item.body.favorite === true);
    assert.ok(favoritePatch, 'favorite patch captured');
    assert.deepEqual(state.pageErrors, []);
});

test('local import shows progress, duplicates and failures with retry entry', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'references');
    await page.setInputFiles('#refFileInput', [
        {name: 'a.jpg', mimeType: 'image/jpeg', buffer: PNG_1PX},
        {name: 'b.jpg', mimeType: 'image/jpeg', buffer: PNG_1PX},
        {name: 'c.jpg', mimeType: 'image/jpeg', buffer: PNG_1PX},
        {name: 'd.jpg', mimeType: 'image/jpeg', buffer: PNG_1PX},
    ]);
    await page.waitForFunction(() => (document.getElementById('refImportSummary').innerText || '').includes('完成'));
    assert.match(await page.locator('#refImportSummary').innerText(), /已导入 2/);
    assert.match(await page.locator('#refImportSummary').innerText(), /重复跳过 1/);
    assert.match(await page.locator('#refImportSummary').innerText(), /失败 1/);
    assert.equal(await page.locator('#refImportCount').innerText(), '4/4');
    const importRequest = state.requests.find(item => item.method === 'POST' && item.path === '/api/design-brain/references/import');
    assert.ok(importRequest, 'import request captured');
    // 失败列表展示原因，并提供重试入口。
    assert.match(await page.locator('#refImportFailures').innerText(), /不支持的图片类型/);
    await page.waitForSelector('#refRetryImports');
    assert.deepEqual(state.pageErrors, []);
});

test('reference AI analysis is privacy gated, then records ready results per image', async t => {
    // 默认关闭：点击分析提示去档案开开关，不发起任何云端请求。
    const gated = await openPanel(t);
    await gotoTab(gated.page, 'references');
    await gated.page.click('#refAnalyzeButton');
    await gated.page.waitForSelector('.db-toast.error');
    assert.match(await gated.page.locator('.db-toast.error').innerText(), /隐私开关/);
    assert.ok(await gated.page.locator('#profilePanel:not([hidden])').count() > 0 || !(await gated.page.locator('#referencesPanel').isHidden()) === false);
    assert.equal(gated.state.requests.filter(item => item.path === '/api/canvas-llm').length, 0);

    const allowed = await openPanel(t, {
        allowReferenceAnalysis: true,
        distillReply: JSON.stringify({
            purpose: '电商主图参考', composition: '居中对称留白', material: '木纹相框哑光',
            lighting: '柔光侧打', takeaways: '浅底渐变保质感', restrictions: '主体占比大，不适合文字多的版面',
            suggested: {category: '家居', purpose: '主图', expression: '材质表现', tags: ['相框', '浅底']},
        }),
    });
    const {page, state} = allowed;
    await autoDialogs(page);
    await gotoTab(page, 'references');
    await page.click('#refAnalyzeButton');
    await page.waitForFunction(() => (document.getElementById('refAnalysisSummary').innerText || '').includes('完成：成功 2'));
    const llmRequests = state.requests.filter(item => item.method === 'POST' && item.path === '/api/canvas-llm');
    assert.equal(llmRequests.length, 2, 'one vision call per image');
    assert.equal(llmRequests[0].body.images.length, 1);
    assert.match(llmRequests[0].body.images[0], /^data:image\/png;base64,/);
    assert.match(llmRequests[0].body.system_prompt, /参考图/);
    assert.equal(llmRequests[0].body.provider, 'prov-a');
    const analysisPosts = state.requests.filter(item => item.method === 'POST' && /\/references\/.+\/analysis$/.test(item.path));
    assert.equal(analysisPosts.filter(item => item.body.status === 'pending').length, 2);
    const readyPosts = analysisPosts.filter(item => item.body.status === 'ready');
    assert.equal(readyPosts.length, 2);
    assert.equal(readyPosts[0].body.content.purpose, '电商主图参考');
    assert.equal(readyPosts[0].body.suggested.category, '家居');
    assert.deepEqual(readyPosts[0].body.suggested.tags, ['相框', '浅底']);
    // 刷新后徽标为已分析（含原有 ref_b 共 3 个）。
    await page.waitForFunction(() => document.querySelectorAll('.analysis-badge.analysis-ready').length === 3);
    assert.equal(await page.locator('#refAnalyzeButton').innerText(), 'AI 分析未分析');
    assert.deepEqual(state.pageErrors, []);
});

test('batch classify and batch delete operate on the selected references', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'references');
    await page.check('[data-ref-check="ref_a"]');
    await page.check('[data-ref-check="ref_b"]');
    await page.waitForSelector('#refBatchBar:not([hidden])');
    assert.match(await page.locator('#refBatchCount').innerText(), /已选 2 张/);
    await page.click('#refBatchClassify');
    await page.waitForSelector('#refClassifyOverlay:not([hidden])');
    await page.fill('#refBatchCategory', '家居');
    await page.click('#refClassifyApply');
    await page.waitForFunction(() => document.getElementById('refClassifyOverlay').hidden === true);
    const batchUpdate = state.requests.find(item => item.method === 'POST' && item.path === '/api/design-brain/references/batch-update');
    assert.ok(batchUpdate, 'batch-update captured');
    assert.deepEqual(batchUpdate.body.ids, ['ref_a', 'ref_b']);
    assert.equal(batchUpdate.body.patch.classification.category, '家居');

    await autoDialogs(page);
    await page.click('#refBatchDelete');
    await page.waitForFunction(() => document.querySelectorAll('.ref-card').length === 1);
    const batchDelete = state.requests.find(item => item.method === 'POST' && item.path === '/api/design-brain/references/batch-delete');
    assert.deepEqual(batchDelete.body.ids, ['ref_a', 'ref_b']);
    assert.deepEqual(state.pageErrors, []);
});

test('reference detail edits classification, adopts AI suggestion and saves analysis notes', async t => {
    const {page, state} = await openPanel(t);
    await gotoTab(page, 'references');
    await page.click('[data-open-ref="ref_b"]');
    await page.waitForSelector('#referenceOverlay:not([hidden])');
    assert.equal(await page.locator('[data-ref-analysis="purpose"]').inputValue(), '详情页首屏');
    assert.match(await page.locator('#referenceBody').innerText(), /AI 建议分类/);
    // 采用建议只填表单，保存后才提交。
    await page.click('[data-ref-action="apply-suggested"]');
    assert.equal(await page.locator('#refDetail_category').inputValue(), '家居');
    assert.equal(await page.locator('#refDetailTags').inputValue(), '相框');
    await page.click('[data-ref-action="save"]');
    await page.waitForTimeout(250);
    const patch = [...state.requests].reverse().find(item => item.method === 'PATCH' && /\/references\/ref_b$/.test(item.path));
    assert.ok(patch, 'detail patch captured');
    assert.equal(patch.body.classification.category, '家居');
    assert.equal(patch.body.classification.purpose, '主图');
    assert.deepEqual(patch.body.classification.tags, ['相框']);

    // 用户修改分析内容走 analysis PATCH，由服务端打人工修改标记。
    await page.fill('[data-ref-analysis="material"]', '哑光胡桃木框');
    await page.click('[data-ref-action="save-analysis"]');
    await page.waitForTimeout(250);
    const analysisPatch = [...state.requests].reverse().find(item => item.method === 'PATCH' && /\/references\/ref_b\/analysis$/.test(item.path));
    assert.ok(analysisPatch, 'analysis edit captured');
    assert.equal(analysisPatch.body.content.material, '哑光胡桃木框');
    assert.deepEqual(state.pageErrors, []);
});
