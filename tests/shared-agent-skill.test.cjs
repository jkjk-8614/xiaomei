const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'static/js/shared-agent-skill.js'), 'utf8');
const key = 'xiaomei_agent_skill_selection_v1';

function setup(initial = null, failWrite = false) {
    const values = new Map(initial === null ? [] : [[key, initial]]);
    const listeners = new Map();
    const requests = [];
    const window = {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    };
    const context = vm.createContext({
        window,
        localStorage: {
            getItem: name => values.get(name) ?? null,
            setItem(name, value) {
                if (failWrite) throw new Error('Storage quota exceeded');
                values.set(name, String(value));
            },
        },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        fetch: async url => {
            requests.push(url);
            return { ok: true, json: async () => ({ instructions: 'Current browser instructions' }) };
        },
    });
    vm.runInContext(source, context);
    return { api: window.StudioSharedSkill, values, window, context, requests };
}

test('restores and persists the renamed browser selection', () => {
    const { api, values } = setup('dabi-browser');
    assert.equal(api.getSelected(), 'browser-agent');
    assert.equal(values.get(key), 'browser-agent');
    assert.equal(api.getSelected(), 'browser-agent');
});

test('cleared shared selection wins over older panel settings', () => {
    const { api, values } = setup('');
    assert.equal(api.getSelected('dabi-browser'), '');
    assert.equal(values.get(key), '');
});

test('missing shared selection can restore older panel settings', () => {
    const { api } = setup();
    assert.equal(api.getSelected('dabi-browser'), 'browser-agent');
});

test('quota failure does not discard a readable selection', () => {
    const { api } = setup('dabi-browser', true);
    assert.equal(api.getSelected(), 'browser-agent');
});

test('unrelated Skill IDs remain strings and unchanged', () => {
    const { api } = setup();
    for (const id of ['buyer-show-generation', 'constructor', '__proto__', 'toString']) {
        assert.equal(api.canonicalId(id), id);
    }
});

test('each cross-page subscriber receives one canonical event and can unsubscribe', () => {
    const { api, window, values } = setup();
    const first = [], second = [];
    const unsubscribe = api.subscribe(id => first.push(id));
    api.subscribe(id => second.push(id));
    window.dispatchEvent({ type: 'storage', key, newValue: 'dabi-browser' });
    assert.deepEqual(first, ['browser-agent']);
    assert.deepEqual(second, ['browser-agent']);
    assert.equal(values.get(key), 'browser-agent');
    unsubscribe();
    api.setSelected('');
    assert.deepEqual(first, ['browser-agent']);
    assert.deepEqual(second, ['browser-agent', '']);
});

test('instruction requests for historical IDs use the current package', async () => {
    const { api, requests } = setup();
    assert.equal(await api.instructions('dabi-browser'), 'Current browser instructions');
    assert.deepEqual(requests, ['/api/agent-skills/browser-agent']);
});

test('canvas restores its older per-panel choice when no shared preference exists', () => {
    const { api, context } = setup();
    Object.assign(context, {
        sharedSkillApi: api, skillSelectionKey: key,
        skillEl: { value: '' }, preferences: () => ({ skill: 'dabi-browser' }),
    });
    const canvas = readFileSync(path.join(root, 'static/js/canvas-agent.js'), 'utf8');
    vm.runInContext(canvas.slice(canvas.indexOf('    function canonicalSkillId('), canvas.indexOf('    function savePreferences(')), context);
    assert.equal(vm.runInContext('rememberedSkill()', context), 'browser-agent');
    api.setSelected('');
    assert.equal(vm.runInContext('rememberedSkill()', context), '');
});

test('GPT startup respects cleared shared state and restores missing state', () => {
    const html = readFileSync(path.join(root, 'static/gpt-chat.html'), 'utf8');
    const init = html.slice(html.indexOf('        const savedSkillId='), html.indexOf('        let skills = []'));
    for (const [initial, expected] of [[null, 'browser-agent'], ['', ''], ['buyer-show-generation', 'buyer-show-generation']]) {
        const { context, api } = setup(initial);
        Object.assign(context, { savedChatSettings: { skillId: 'dabi-browser' }, SKILL_SELECTION_KEY: key, canonicalSharedSkillId: api.canonicalId });
        assert.equal(vm.runInContext(init + '\nactiveSkillId;', context), expected);
    }
});
