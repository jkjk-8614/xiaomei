(() => {
    'use strict';
    const trigger = document.getElementById('image-network-open');
    const labels = {
        local:'本地服务', provider:'平台接口', query:'任务查询', download:'结果取图', save:'保存和显示',
        ok:'通过', error:'失败', warning:'待复测', unknown:'待验证', skipped:'不适用',
    };
    const stages = ['local', 'provider', 'query', 'download', 'save'];
    const codes = {
        models_ok:'已验证模型列表', generation_ok:'已收到平台结果', sync_result:'同步出图无需查询',
        awaiting_task:'将在实际生图时自动记录', models_unavailable:'平台未提供模型列表，将在实际生图时自动记录',
        unknown_task:'平台未返回可识别的任务状态',
        missing_key:'API 设置中还没有此平台的密钥', proxy:'无法连接代理', timeout:'请求超时',
        tls:'安全连接失败', dns:'域名解析失败', connection:'连接失败',
        permission:'保存目录不可写', disk_full:'磁盘空间不足', local_file_missing:'本地文件已丢失',
        invalid_image:'平台返回的内容无法打开为图片', invalid_response:'平台返回了无效的模型列表',
        preview_unavailable:'图片已保存，页面无法加载', verifying_preview:'正在验证页面能否打开图片',
        http_401:'平台鉴权失败（401）', http_403:'访问被拒绝（403）', http_407:'代理需要认证（407）',
        http_410:'地址已失效（410）', http_429:'平台限制请求频率（429）',
    };
    const panel = document.createElement('dialog');
    panel.className = 'image-network';
    panel.setAttribute('aria-labelledby', 'image-network-title');
    panel.innerHTML = `
        <header>
            <h2 id="image-network-title">网络监测</h2>
            <button type="button" class="image-network-close" data-close aria-label="关闭">×</button>
        </header>
        <label class="image-network-picker"><span>生图平台</span><select aria-label="生图平台"></select></label>
        <p class="image-network-summary" data-summary role="status"></p>
        <ul></ul>
        <p class="image-network-hint" data-hint hidden></p>
        <footer>
            <button type="button" class="image-network-primary" data-check>立即检测</button>
            <button type="button" data-compare>代理对照</button>
            <button type="button" data-copy>复制诊断</button>
        </footer>
        <p class="image-network-details" data-details role="status" hidden></p>
        <p class="image-network-copy-status" data-copy-status role="status" hidden></p>`;
    document.body.append(panel);
    const select = panel.querySelector('select');
    const summary = panel.querySelector('[data-summary]');
    const hint = panel.querySelector('[data-hint]');
    const details = panel.querySelector('[data-details]');
    const copyStatus = panel.querySelector('[data-copy-status]');
    const check = panel.querySelector('[data-check]');
    const compare = panel.querySelector('[data-compare]');
    const copy = panel.querySelector('[data-copy]');
    const list = panel.querySelector('ul');
    let rows = {};
    let revision = 0;
    let busy = false;
    let busyAction = '';
    let timer;
    let retest;
    let copyTimer;
    let lastPreview = null;
    let comparisonText = '';

    async function json(url, options = {}) {
        const response = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(10000), ...options});
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return response.json();
    }

    function description(stage, row) {
        if (stage === 'download' && row.code === 'http_403') return '图片链接失效或访问受限（403）';
        return codes[row.code] || (row.code?.startsWith('http_') ? `HTTP ${row.code.slice(5)}` : '');
    }

    function describeTime(timestamp) {
        return timestamp ? new Date(timestamp * 1000).toLocaleTimeString() : '';
    }

    function proxyDescription(row) {
        return row.proxy_route === 'proxy' ? '使用应用代理' : row.proxy_route === 'direct' ? '未使用应用代理' : '';
    }

    function render() {
        list.replaceChildren();
        const states = [];
        for (const stage of stages) {
            const row = rows[stage] || {};
            const state = row.status || 'unknown';
            states.push(state);
            const li = document.createElement('li');
            li.className = 'image-network-row';
            const info = document.createElement('div');
            info.textContent = labels[stage];
            const extra = document.createElement('small');
            extra.textContent = [
                description(stage, row), row.origin, proxyDescription(row), describeTime(row.checked_at),
                row.elapsed_ms != null ? `${row.elapsed_ms} ms` : '',
                row.recovery_id ? `恢复编号 ${row.recovery_id}` : '',
            ].filter(Boolean).join(' · ');
            if (extra.textContent) info.append(extra);
            const badge = document.createElement('span');
            badge.className = 'image-network-state';
            badge.dataset.state = state;
            badge.textContent = labels[state];
            li.append(info, badge);
            list.append(li);
        }
        const hasError = states.includes('error');
        const allPassed = states.every(state => state === 'ok' || state === 'skipped');
        const hasWarning = states.includes('warning');
        summary.dataset.state = hasError ? 'error' : allPassed ? 'ok' : hasWarning ? 'warning' : 'idle';
        summary.textContent = hasError ? '检测到故障。请查看失败的步骤。'
            : allPassed ? '最近收图检查全部通过'
            : select.value ? '等待检测或实际收图结果' : '请先在 API 设置中启用生图平台';
        const passivePending = ['query', 'download', 'save'].some(stage => (rows[stage]?.status || 'unknown') === 'unknown');
        if (select.value && !hasError && passivePending) {
            hint.hidden = false;
            hint.textContent = '任务查询、结果取图、保存和显示会在下次实际生图时自动记录，主动检测不消耗额度。';
        } else {
            hint.hidden = true;
            hint.textContent = '';
        }
        check.disabled = busy || !select.value;
        compare.disabled = busy || !select.value;
        check.textContent = busy && busyAction === 'check' ? '检测中…' : '立即检测';
        compare.textContent = busy && busyAction === 'compare' ? '对照中…' : '代理对照';
    }

    function preview(path) {
        if (!/^\/(assets|output|api\/storage-files)\//.test(path)) return Promise.resolve(null);
        if (lastPreview?.path === path) return lastPreview.promise;
        const promise = new Promise(resolve => {
            const image = new Image();
            const timeout = setTimeout(() => finish(false), 3000);
            function finish(ok) {
                clearTimeout(timeout);
                image.onload = image.onerror = null;
                if (!ok) image.removeAttribute('src');
                resolve(ok);
            }
            image.onload = () => finish(true);
            image.onerror = () => finish(false);
            const address = new URL(path, location.origin);
            address.searchParams.set('_network_check', Date.now());
            image.src = address.href;
        });
        lastPreview = {path, promise};
        return promise;
    }

    async function refresh(runCheck = false, allowRetest = true) {
        const token = ++revision;
        const current = select.value;
        if (runCheck) { clearTimeout(retest); busy = true; busyAction = 'check'; lastPreview = null; render(); }
        const [local, report] = await Promise.allSettled([
            json('/api/app-info'),
            current ? json(`/api/image-network/${encodeURIComponent(current)}${runCheck ? '/check' : ''}`, {method:runCheck ? 'POST' : 'GET'}) : null,
        ]);
        if (token !== revision || !panel.open) return;
        rows = {
            ...(report.value?.checks || {}),
            local:{status:local.status === 'fulfilled' ? 'ok' : 'error', checked_at:Date.now()/1000},
        };
        busy = false;
        busyAction = '';
        if (rows.save?.status === 'ok') {
            rows.save = {...rows.save, status:'unknown', code:'verifying_preview'};
            render();
            const displayed = await preview(report.value?.sample_url || '');
            if (token !== revision || !panel.open) return;
            if (displayed !== null) rows.save = {...rows.save, status:displayed ? 'ok' : 'error', code:displayed ? 'ok' : 'preview_unavailable'};
            else rows.save = {...rows.save, code:'local_file_missing'};
        }
        render();
        if (runCheck && allowRetest && rows.provider?.status === 'warning') {
            retest = setTimeout(() => {
                if (panel.open && !busy && select.value === current) refresh(true, false);
            }, 2000);
        }
    }

    async function open() {
        if (panel.open) return;
        panel.show();
        const previous = select.value;
        const opening = ++revision;
        comparisonText = '';
        details.hidden = true;
        clearTimeout(copyTimer);
        copyStatus.hidden = true;
        copyStatus.textContent = '';
        rows = {};
        busy = true;
        busyAction = 'check';
        render();
        try {
            const data = await json('/api/providers');
            if (!panel.open || opening !== revision) return;
            const platforms = (data.providers || []).filter(p => p.enabled !== false && (p.image_models?.length || p.primary));
            select.replaceChildren(...platforms.map(p => new Option(p.name || p.id, p.id)));
            if (platforms.some(p => p.id === previous)) select.value = previous;
            else if (platforms.some(p => p.primary)) select.value = platforms.find(p => p.primary).id;
        } catch {
            if (!panel.open || opening !== revision) return;
            select.replaceChildren();
        }
        refresh(true);
        timer = setInterval(() => { if (!busy) refresh(); }, 6000);
    }

    function close() {
        revision++;
        clearInterval(timer);
        clearTimeout(retest);
        clearTimeout(copyTimer);
        panel.close();
        if (trigger) trigger.focus();
    }
    if (trigger) trigger.addEventListener('click', open);
    window.addEventListener('message', event => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'xiaomei-open-image-network') {
            if (panel.open) refresh(true);
            else open();
        }
    });
    panel.querySelector('[data-close]').addEventListener('click', close);
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
    });
    select.addEventListener('change', () => {
        rows = {};
        comparisonText = '';
        details.hidden = true;
        clearTimeout(copyTimer);
        copyStatus.hidden = true;
        copyStatus.textContent = '';
        refresh(true);
    });
    check.addEventListener('click', () => refresh(true));
    compare.addEventListener('click', async () => {
        const token = ++revision;
        busy = true;
        busyAction = 'compare';
        details.hidden = false;
        details.textContent = '正在对照两种连接方式…';
        render();
        const target = rows.download?.status === 'error' && rows.download?.origin ? 'download' : 'provider';
        try {
            const result = await json(`/api/image-network/${encodeURIComponent(select.value)}/compare?target=${target}`, {method:'POST'});
            if (token !== revision || !panel.open) return;
            const configured = result.configured.status === 'ok';
            const direct = result.no_proxy.status === 'ok';
            const compareHint = configured && !direct ? '此域名目前需要应用代理。'
                : !configured && direct ? '请优先检查代理节点、认证或分流。'
                : !configured ? '请保持代理设置一致，换手机热点复测，帮助判断公司网络的影响。'
                : '两种方式均收到响应。请查看原任务的取图错误。';
            comparisonText = `${result.configured.origin} · 当前设置 ${configured ? '可达' : '失败'}（${description(target, result.configured)}） · 不使用应用代理 ${direct ? '可达' : '失败'}（${description(target, result.no_proxy)}）。${compareHint} 对照检查域名；TUN 和公司透明代理仍可能生效。`;
        } catch {
            if (token !== revision || !panel.open) return;
            comparisonText = '当前平台没有可对照的地址，或检测未完成。';
        }
        details.textContent = comparisonText;
        busy = false;
        busyAction = '';
        render();
    });
    copy.addEventListener('click', async () => {
        const report = Object.entries(rows).map(([stage, row]) => [
            labels[stage], labels[row.status], row.code, row.origin, proxyDescription(row),
            row.checked_at ? new Date(row.checked_at * 1000).toISOString() : '', row.recovery_id,
        ].filter(Boolean).join(' · '));
        const text = ['小美画布网络监测', select.selectedOptions[0]?.text, ...report, comparisonText].filter(Boolean).join('\n');
        clearTimeout(copyTimer);
        copyStatus.hidden = false;
        try {
            await navigator.clipboard.writeText(text);
            copyStatus.textContent = '已复制诊断。';
            copyTimer = setTimeout(() => {
                copyStatus.hidden = true;
                copyStatus.textContent = '';
            }, 3000);
        } catch {
            copyStatus.textContent = text;
        }
    });
})();
