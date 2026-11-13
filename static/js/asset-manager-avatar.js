(function (global) {
    'use strict';

    const labels = { apimart: 'APIMart', volcengine: '火山引擎' };
    function platformOf(provider) {
        const protocol = String(provider?.protocol || '').trim().toLowerCase();
        if (protocol === 'apimart' || String(provider?.base_url || '').toLowerCase().includes('apimart.ai')) return 'apimart';
        return protocol === 'volcengine' ? protocol : '';
    }
    const platformName = platform => labels[platform] || platform || '平台';
    function canSubmit(provider, platform) {
        if (platform === 'volcengine' && 'has_volcengine_access_key' in provider) {
            return provider.has_volcengine_access_key && provider.has_volcengine_secret_key;
        }
        return provider.has_key !== false;
    }

    function create({ request, providers, find, visible, redraw, notice, copyText }) {
        const document = global.document.createElement('template').content.ownerDocument;
        const pending = new Set();
        const timers = new Map();
        let chosen = '';

        function element(tag, classes, text) {
            const node = document.createElement(tag);
            if (classes) node.className = classes;
            if (text) node.textContent = text;
            return node;
        }
        function icon(name) {
            const glyph = element('i');
            glyph.dataset.lucide = name;
            return glyph;
        }
        function heading(symbol, title, platform) {
            const node = element('div', 'avatar-head');
            node.append(icon(symbol), element('span', '', title));
            if (platform) node.append(element('span', 'avatar-platform-tag', platformName(platform)));
            return node;
        }
        function hint(text, warning = false) {
            return element('div', warning ? 'avatar-hint warn' : 'avatar-hint', text);
        }
        function action(name, label, symbol, scope, provider, { primary = false, disabled = false } = {}) {
            const button = element('button', primary ? 'asset-btn primary' : 'asset-btn');
            button.type = 'button';
            button.setAttribute('data-avatar-' + name, scope.id);
            if (scope.libraryId) button.dataset.avatarLibrary = scope.libraryId;
            if (scope.categoryId) button.dataset.avatarCategory = scope.categoryId;
            if (scope.url) button.dataset.avatarSource = scope.url;
            if (provider) button.dataset.avatarProv = provider;
            button.disabled = disabled;
            button.append(icon(symbol), element('span', '', label));
            return button;
        }
        const choices = () => providers().filter(provider => provider?.id && provider.enabled !== false);
        const keyFor = (scope, platform) => JSON.stringify([scope.libraryId, scope.categoryId, scope.id, scope.url, platform]);
        const reviewFor = (item, platform) => item?.registrations?.[platform];

        function reviewCard(scope, platform, review, list) {
            const ready = review.status === 'Active' && review.asset_uri;
            const processing = review.status === 'Processing';
            const phase = ready ? 'registered' : processing ? 'processing' : 'failed';
            const card = element('div', 'avatar-card ' + phase);
            const commands = element('div', 'asset-tools');
            const samePlatform = list.filter(provider => platformOf(provider) === platform);
            const provider = samePlatform.find(provider => provider.id === review.provider_id) || samePlatform[0];
            const busy = pending.has(keyFor(scope, platform));
            const disabled = busy || !provider || !canSubmit(provider, platform);
            if (ready) {
                card.append(heading('badge-check', '已认证可用', platform));
                const address = element('div', 'avatar-uri', review.asset_uri);
                address.title = '只能在 ' + platformName(platform) + ' 平台的视频生成中通过 @ 调用';
                card.append(address);
                commands.append(action('copy', '复制 asset:// 地址', 'copy', { id: review.asset_uri }),
                    action('register', busy ? '处理中…' : '重新注册', 'refresh-cw', scope, provider?.id, { disabled }));
            } else if (processing) {
                card.append(heading('loader', '审核中', platform), hint('已提交到 ' + platformName(platform)
                    + ' 审核（任务 ' + review.task_id + '），通过后会自动生成 asset:// 地址。审核通常需要几十秒到几分钟。'));
                commands.append(action('check', busy ? '查询中…' : '刷新审核状态', 'refresh-cw', scope, provider?.id,
                    { primary: true, disabled }));
            } else {
                card.append(heading('x-circle', '审核未通过', platform),
                    hint(review.detail || '审核未通过，请更换素材后重试。', true));
                commands.append(action('register', busy ? '处理中…' : '重新提交', 'refresh-cw', scope, provider?.id, { disabled }));
            }
            card.append(commands);
            return card;
        }
        function section(libraryId, categoryId, item) {
            const scope = { libraryId, categoryId, id: item.id, url: item.url };
            const list = choices();
            const panel = element('div', 'avatar-section');
            for (const [platform, review] of Object.entries(item.registrations || {})) {
                if (review?.task_id) panel.append(reviewCard(scope, platform, review, list));
            }
            if (!list.length) {
                panel.append(heading('user-round-cog', '注册为真人/数字人'),
                    hint('未检测到可用平台。请先在「API 平台管理」中添加并启用 API 平台（如 APIMart）并填写 Key。'));
                return panel.outerHTML;
            }
            const selected = list.find(provider => provider.id === chosen) || list.find(platformOf) || list[0];
            const platform = platformOf(selected);
            const select = element('select', 'avatar-provider-select');
            select.dataset.avatarProvider = '';
            for (const provider of list) {
                const supported = platformOf(provider);
                const suffix = supported ? '（' + platformName(supported) + '）' : '（暂不支持，待接入）';
                const option = element('option', '', (provider.name || provider.id) + suffix);
                option.value = provider.id;
                option.defaultSelected = provider === selected;
                select.append(option);
            }
            panel.append(heading('user-round-cog', '注册到平台'));
            if (!platform) {
                panel.append(hint('认证是跨平台功能，但「' + (selected.name || selected.id)
                    + '」的资产认证 API 尚未接入（待接入）。请选择已支持的平台，或继续使用官方控制台认证。'), select);
                return panel.outerHTML;
            }
            panel.append(hint('提交到 ' + platformName(platform)
                + ' 私域素材审核，通过后生成 asset:// 地址，可在该平台的视频生成中通过 @ 直接调用（一个素材可注册到多个平台，平台间互相隔离）。'), select);
            const noKey = !canSubmit(selected, platform);
            const registered = Boolean(reviewFor(item, platform)?.task_id);
            if (noKey) panel.append(hint('该平台尚未配置 API Key。', true));
            if (registered) panel.append(hint('该平台已注册，再次提交会覆盖该平台的认证。'));
            const busy = pending.has(keyFor(scope, platform));
            const caption = busy ? '注册中，请稍候…' : registered ? '重新注册到该平台' : '注册并等待审核';
            panel.append(action('register', caption, 'user-round-plus', scope, selected.id, { primary: true, disabled: busy || noKey }));
            return panel.outerHTML;
        }

        function schedule(scope, providerId, platform, taskId) {
            const key = keyFor(scope, platform);
            global.clearTimeout(timers.get(key));
            timers.set(key, global.setTimeout(() => {
                timers.delete(key);
                const item = find(scope);
                const review = reviewFor(item, platform);
                if (item?.url === scope.url && review?.task_id === taskId && review.status === 'Processing') {
                    void run(scope, providerId, false, true);
                }
            }, 6000));
        }
        async function run(scope, providerId, submit, silent = false) {
            const provider = choices().find(entry => entry.id === providerId);
            const platform = platformOf(provider);
            const initial = find(scope);
            if (!initial || !platform || !canSubmit(provider, platform)) return;
            const current = { ...scope, url: initial.url, kind: initial.kind };
            const key = keyFor(current, platform);
            const originalTask = reviewFor(initial, platform)?.task_id;
            if (pending.has(key) || (!submit && !originalTask)) return;
            global.clearTimeout(timers.get(key));
            timers.delete(key);
            pending.add(key);
            if (visible(current)) {
                if (!silent) notice(submit ? '正在上传素材并提交 ' + platformName(platform) + ' 审核…' : '正在查询审核状态…');
                if (!silent) redraw();
            }
            try {
                const path = '/api/asset-library/items/' + encodeURIComponent(current.id);
                const data = await request(path + (submit ? '/register-avatar' : '/avatar-status'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ library_id: current.libraryId, category_id: current.categoryId,
                        source_url: current.url, provider_id: provider.id }),
                });
                const item = find(current);
                const storedTask = reviewFor(item, platform)?.task_id;
                const review = reviewFor(data.item, platform);
                if (!item || item.url !== current.url || item.kind !== current.kind || !review?.task_id
                    || (storedTask !== originalTask && storedTask !== review.task_id)) return;
                item.registrations = { ...item.registrations, [platform]: review };
                if (review.status === 'Processing') schedule(current, providerId, platform, review.task_id);
                if (!visible(current)) return;
                if (review.status === 'Active') notice('审核通过，已生成 asset:// 地址，可在视频生成中通过 @ 调用');
                else if (review.status === 'Failed') notice(review.detail || '审核未通过');
                else notice(submit ? '已提交审核，正在等待 ' + platformName(platform) + ' 通过…' : '仍在审核中，稍后会自动刷新…');
            } catch (error) {
                if (!silent && visible(current)) notice(error.message || (submit ? '数字人提交失败' : '查询审核状态失败'));
            } finally {
                pending.delete(key);
                if (visible(current)) redraw();
            }
        }
        async function copy(uri) {
            notice(await copyText(uri) ? '已复制 asset:// 地址' : '复制失败，请手动复制：' + uri);
        }
        return {
            section, copy,
            handle(control, id, submit) {
                const {avatarLibrary:libraryId, avatarCategory:categoryId, avatarSource:url, avatarProv:providerId} = control.dataset;
                return run({libraryId, categoryId, id, url}, providerId, submit);
            },
            choose(value) { chosen = value; redraw(); },
        };
    }

    global.XiaomeiAssetManagerAvatar = { create };
}(window));
