const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://accounts.fixture.test';
const fixtureKey = 'fixture-secret-for-account-tests';

function profile(id, name, key_preview) {
    return {id, name, key_preview, has_key: Boolean(key_preview)};
}

function bundle(profiles, activeId) {
    const active = profiles.find(record => record.id === activeId);
    return {
        profiles: profiles.map(record => ({...record, active: record.id === activeId})),
        active_id: activeId,
        has_key: Boolean(active?.has_key),
        key_preview: active?.key_preview || '',
    };
}

const work = profile('work', '工作账号', 'work••••1234');
const backup = profile('backup', '备用账号', 'back••••5678');
const personal = profile('personal', '个人账号', 'pers••••1111');

function provider(id, name, accounts) {
    const {profiles, active_id, has_key, key_preview} = accounts;
    return {
        id, name, has_key, key_preview, enabled: true, protocol: 'openai', base_url: 'https://' + id + '.example/v1',
        key_profiles: profiles, active_key_profile_id: active_id, key_profile_count: profiles.length,
        image_models: [], chat_models: [], video_models: [],
    };
}

async function open(t, respond) {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1220, height: 850}});
    const requests = [], dialogs = [], errors = [];
    const providers = [
        provider('alpha', '平台甲', bundle([work, backup], work.id)),
        provider('beta', '平台乙', bundle([personal], personal.id)),
        provider('empty', '空平台', bundle([], '')),
    ];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/providers' && request.method() === 'GET') {
            return route.fulfill({json: {providers}});
        }
        if (url.pathname === '/api/providers' || url.pathname.includes('/key-profiles')) {
            const entry = {path: url.pathname, method: request.method(), body: request.postDataJSON()};
            requests.push(entry);
            const result = await respond(entry, providers);
            return route.fulfill({status: result.status || 200, json: result.data});
        }
        if (url.pathname === '/api/provider-icon') return route.fulfill({status: 404});
        if (url.pathname.startsWith('/api/')) return route.fulfill({json: {}});
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        return file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()
            ? route.fulfill({path: file}) : route.fulfill({status: 404});
    });
    await page.goto(origin + '/static/api-settings.html');
    await page.waitForFunction(() => document.body.classList.contains('show-recommend-mode') && providers.length === 3);
    await page.locator('[data-provider-id="alpha"]').click();
    return {page, requests, dialogs, errors};
}

async function waitForText(locator, text) {
    await locator.getByText(text, {exact: true}).waitFor({state: 'visible'});
}

test('编辑保留原 Key，失败可重试，新增和删除更新已保存账号', {timeout: 30000}, async t => {
    const renamed = {...work, name: '<工作账号新版>'};
    const added = profile('new', '第三个账号', 'fixt••••ests');
    let failed = false;
    const {page, requests, dialogs, errors} = await open(t, async ({method, body}) => {
        if (method === 'DELETE') return {data: bundle([renamed, backup], renamed.id)};
        if (!body.create_new) return {data: bundle([renamed, backup], renamed.id)};
        if (!failed) {
            failed = true;
            return {status: 503, data: {detail: '账号暂时无法保存'}};
        }
        return {data: bundle([renamed, backup, added], added.id)};
    });
    const trigger = page.locator('#keyProfileTrigger'), editor = page.locator('#keyProfileEditPanel');
    const name = page.locator('#keyProfileNameInput'), key = page.locator('#keyInput');
    const save = page.locator('#saveKeyBtn'), state = page.locator('#providerSaveState');

    assert.match(await trigger.textContent(), /work••••1234/);
    await page.locator('#keyProfileEditBtn').click();
    await name.fill(renamed.name);
    assert.equal(await key.inputValue(), '');
    assert.equal(await state.getAttribute('data-state'), 'unsaved');
    await save.click();
    await waitForText(trigger, renamed.name);
    assert.deepEqual(requests[0].body, {key: '', name: renamed.name, profile_id: work.id, create_new: false});
    assert.match(await trigger.textContent(), /work••••1234/);

    await page.locator('#keyProfileAddBtn').click();
    await name.fill(added.name);
    await key.fill(fixtureKey);
    await save.click();
    await page.getByText('账号暂时无法保存', {exact: true}).waitFor();
    assert.equal(await name.inputValue(), added.name);
    assert.equal(await key.inputValue(), fixtureKey);
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await waitForText(trigger, added.name);
    assert.deepEqual(requests[1].body, requests[2].body);
    assert.deepEqual(requests[2].body, {key: fixtureKey, name: added.name, profile_id: '', create_new: true});
    assert.equal(await key.inputValue(), '');
    assert.equal(await editor.isHidden(), true);
    assert.equal((await page.content()).includes(fixtureKey), false);

    await page.locator('#keyProfileDeleteBtn').click();
    await waitForText(trigger, renamed.name);
    assert.deepEqual(requests[3], {method: 'DELETE', path: '/api/providers/alpha/key-profiles/new', body: null});
    assert.equal(dialogs.length, 1);
    assert.equal(await state.getAttribute('data-state'), 'saved');
    assert.deepEqual(errors, []);
});

test('键盘切换的延迟结果只更新原平台并保留当前账号草稿', {timeout: 30000}, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const {page, requests, dialogs, errors} = await open(t, async () => {
        started.resolve();
        await release.promise;
        return {data: bundle([work, backup], backup.id)};
    });
    const trigger = page.locator('#keyProfileTrigger'), menu = page.locator('#keyProfileMenu');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.getByRole('option', {name: /工作账号/}).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await started.promise;
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.confirmLeaveApiSettings()), false);

    await page.locator('[data-provider-id="beta"]').click();
    await page.locator('#keyProfileEditBtn').click();
    const name = page.locator('#keyProfileNameInput'), key = page.locator('#keyInput');
    await name.fill('乙平台草稿');
    await key.fill(fixtureKey);
    release.resolve();
    await page.waitForFunction(() => providers.find(item => item.id === 'alpha').active_key_profile_id === 'backup');
    assert.equal(await name.inputValue(), '乙平台草稿');
    assert.equal(await key.inputValue(), fixtureKey);
    assert.equal(await page.locator('#keyProfileEditPanel').isVisible(), true);

    await page.locator('[data-provider-id="alpha"]').click();
    await waitForText(trigger, backup.name);
    assert.equal(await key.inputValue(), '');
    assert.deepEqual(requests, [{method: 'POST', path: '/api/providers/alpha/key-profiles/backup/activate', body: null}]);
    assert.equal(dialogs.length, 1);
    assert.deepEqual(errors, []);
});

test('整页保存等待账号写入，空平台可打开并取消新增表单', {timeout: 30000}, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const updated = {...work, name: '更新的工作账号'};
    const {page, requests, errors} = await open(t, async entry => {
        if (entry.method === 'PUT') {
            return {data: {providers: [
                provider('alpha', '平台甲', bundle([updated, backup], updated.id)),
                provider('beta', '平台乙', bundle([personal], personal.id)),
                provider('empty', '空平台', bundle([], '')),
            ]}};
        }
        started.resolve();
        await release.promise;
        return {data: bundle([updated, backup], updated.id)};
    });
    await page.locator('#keyProfileEditBtn').click();
    await page.locator('#keyProfileNameInput').fill(updated.name);
    await page.locator('#keyInput').fill(fixtureKey);
    await page.locator('#saveKeyBtn').click();
    await started.promise;
    const startedFullSave = await page.evaluate(() => {
        window.testFullSave = saveProviders();
        return Boolean(providerSavePromise);
    });
    assert.equal(startedFullSave, false);
    assert.equal(requests.length, 1);
    release.resolve();
    assert.equal(await page.evaluate(() => window.testFullSave), true);
    assert.equal(requests[1].method, 'PUT');
    assert.equal(JSON.stringify(requests[1].body).includes(fixtureKey), false);

    await page.locator('[data-provider-id="empty"]').click();
    assert.equal(await page.locator('#keyProfileTrigger').isDisabled(), true);
    await page.locator('#keyProfileAddBtn').click();
    assert.equal(await page.locator('#keyProfileEditPanel').isVisible(), true);
    await page.locator('#keyProfileCancelBtn').click();
    assert.equal(await page.locator('#keyProfileEditPanel').isHidden(), true);
    assert.equal(await page.locator('#keyProfileAddBtn').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
});

async function checkDraftDuringProviderSave(t, failProviderSave) {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const added = profile('new', '工作号 A', 'fixt••••ests');
    const {page, requests, errors} = await open(t, async ({method, body}, providers) => {
        if (method === 'PUT') {
            started.resolve();
            await release.promise;
            if (failProviderSave) return {status: 503, data: {detail: '模型列表暂时无法保存'}};
            return {data: {providers: providers.map(item => ({
                ...item, image_models: body.find(saved => saved.id === item.id).image_models,
            }))}};
        }
        return {data: bundle([work, backup, added], added.id)};
    });
    await page.locator('button[onclick="addModel(\'image\')"]').click();
    await page.locator('#imageModelList input').fill('fixture-image-model');
    await started.promise;

    const name = page.locator('#keyProfileNameInput');
    const key = page.locator('#keyInput');
    const save = page.locator('#saveKeyBtn');
    await page.locator('#keyProfileAddBtn').click({timeout: 3000});
    assert.equal(await name.evaluate(input => document.activeElement === input), true);
    await page.keyboard.insertText('工作号');
    await page.keyboard.press('Tab');
    assert.equal(await key.evaluate(input => document.activeElement === input), true);
    await page.keyboard.insertText(fixtureKey);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await page.locator('#baseInput').evaluate(input => Boolean(input.closest('[inert]'))), true);

    await name.click();
    await page.keyboard.press('End');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {text: 'A', selectionStart: 1, selectionEnd: 1});
    release.resolve();
    await page.waitForFunction(() => providerSavePromise === null);
    assert.equal(await name.evaluate(input => document.activeElement === input), true);
    assert.equal(await name.inputValue(), '工作号A');
    await page.keyboard.insertText(' A');
    assert.equal(await name.inputValue(), added.name);
    assert.equal(await key.inputValue(), fixtureKey);
    assert.equal(await page.locator('#providerSaveState').getAttribute('data-state'), failProviderSave ? 'failed' : 'unsaved');
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await waitForText(page.locator('#keyProfileTrigger'), added.name);
    assert.deepEqual(requests.map(entry => entry.method), ['PUT', 'POST']);
    assert.equal(JSON.stringify(requests[0].body).includes(fixtureKey), false);
    assert.deepEqual(requests[1].body, {key: fixtureKey, name: added.name, profile_id: '', create_new: true});
    assert.deepEqual(errors, []);
}

test('模型自动保存期间可以打开新增账号并连续输入', {timeout: 30000}, t => checkDraftDuringProviderSave(t, false));
test('模型自动保存失败时保留账号草稿和正在输入的文字', {timeout: 30000}, t => checkDraftDuringProviderSave(t, true));
