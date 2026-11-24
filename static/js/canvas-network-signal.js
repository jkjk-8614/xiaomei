(() => {
    'use strict';
    const button = document.getElementById('canvasNetworkSignalBtn');
    if (!button) return;

    const POLL_INTERVAL_MS = 15000;
    const ERROR_LABELS = {
        missing_key: '未配置密钥',
        proxy: '代理异常',
        timeout: '请求超时',
        tls: '安全连接失败',
        dns: '域名解析失败',
        connection: '连接失败',
        permission: '保存目录不可写',
        disk_full: '磁盘空间不足',
        invalid_image: '图片数据异常',
        invalid_response: '平台响应异常',
        http_401: '鉴权失败（401）',
        http_403: '访问受限（403）',
        http_407: '代理需认证（407）',
        http_429: '请求受限（429）',
    };

    let timer = null;
    let inFlight = false;
    let activeProvider = null;

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, {
            cache: 'no-store',
            signal: AbortSignal.timeout(9000),
            ...options,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    function describeCode(code) {
        if (!code) return '';
        if (ERROR_LABELS[code]) return ERROR_LABELS[code];
        if (code.startsWith('http_')) return `HTTP ${code.slice(5)}`;
        return '';
    }

    function applyState(level, tooltip) {
        button.dataset.signal = level;
        button.title = tooltip;
        button.setAttribute('aria-label', tooltip);
    }

    async function resolvePrimaryProvider() {
        try {
            const data = await fetchJson('/api/providers');
            const list = (data.providers || []).filter(
                p => p.enabled !== false && (p.image_models?.length || p.primary)
            );
            const chosen = list.find(p => p.primary) || list[0] || null;
            activeProvider = chosen ? { id: chosen.id, name: chosen.name || chosen.id } : null;
        } catch {
            // Keep previously resolved provider if /api/providers temporarily fails.
        }
        return activeProvider;
    }

    function evaluate(localOk, provider, report) {
        const suffix = '（点击打开网络监测）';
        if (!navigator.onLine) {
            return { level: 'bad', text: `网络已断开${suffix}` };
        }
        if (!localOk) {
            return { level: 'bad', text: `本地服务未响应${suffix}` };
        }
        if (!provider) {
            return { level: 'good', text: `本地服务正常 · 未启用生图平台${suffix}` };
        }
        const checks = report?.checks || {};
        const name = provider.name || provider.id;

        // Check for any stage error first (provider / query / download / save).
        const failedStage = ['provider', 'download', 'query', 'save'].find(
            stage => checks[stage]?.status === 'error'
        );
        if (failedStage) {
            const reason = describeCode(checks[failedStage]?.code);
            const stageNames = { provider: '平台接口异常', query: '任务查询异常', download: '结果取图异常', save: '保存异常' };
            const detail = [name, stageNames[failedStage], reason].filter(Boolean).join(' · ');
            return { level: 'bad', text: `网络异常 · ${detail}${suffix}` };
        }

        const providerRow = checks.provider || {};
        if (providerRow.status === 'warning') {
            const reason = describeCode(providerRow.code) || '连接波动';
            return { level: 'weak', text: `网络波动 · ${name} · ${reason}${suffix}` };
        }

        const elapsed = typeof providerRow.elapsed_ms === 'number' ? providerRow.elapsed_ms : null;
        if (providerRow.status === 'ok') {
            if (elapsed !== null && elapsed > 1800) {
                return { level: 'weak', text: `网络偏慢 · ${name} · ${elapsed} ms${suffix}` };
            }
            if (elapsed !== null && elapsed > 600) {
                return { level: 'good', text: `网络良好 · ${name} · ${elapsed} ms${suffix}` };
            }
            const msText = elapsed !== null ? ` · ${elapsed} ms` : '';
            return { level: 'excellent', text: `网络极佳 · ${name}${msText}${suffix}` };
        }

        // Provider does not support active probe (e.g. CLI/RunningHub), local is healthy.
        return { level: 'good', text: `服务正常 · ${name}${suffix}` };
    }

    async function probe() {
        if (inFlight) return;
        if (!navigator.onLine) {
            applyState('bad', '网络已断开（点击打开网络监测）');
            return;
        }
        inFlight = true;
        try {
            const [localRes, provider] = await Promise.all([
                fetchJson('/api/app-info').then(() => true).catch(() => false),
                resolvePrimaryProvider(),
            ]);
            let report = null;
            if (localRes && provider?.id) {
                try {
                    report = await fetchJson(`/api/image-network/${encodeURIComponent(provider.id)}/check`, {
                        method: 'POST',
                    });
                } catch {
                    report = { checks: { provider: { status: 'error', code: 'connection' } } };
                }
            }
            const result = evaluate(localRes, provider, report);
            applyState(result.level, result.text);
        } finally {
            inFlight = false;
        }
    }

    function schedule() {
        clearInterval(timer);
        timer = setInterval(() => {
            if (!document.hidden) probe();
        }, POLL_INTERVAL_MS);
    }

    button.addEventListener('click', () => {
        if (window.parent && window.parent !== window) {
            try {
                window.parent.postMessage({ type: 'xiaomei-open-image-network' }, window.location.origin);
            } catch {
                // ignore postMessage errors
            }
        }
        probe();
    });

    window.addEventListener('online', () => probe());
    window.addEventListener('offline', () => {
        applyState('bad', '网络已断开（点击打开网络监测）');
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) probe();
    });

    applyState('checking', '正在检测网络信号…');
    probe();
    schedule();
})();
