(function () {
    'use strict';

    const MAX_LINKS = 3;
    const TERMINAL_OK = new Set(['ready', 'partial']);
    const TERMINAL_ERROR = new Set(['failed', 'needs_login', 'login_required', 'paused', 'challenge', 'timeout']);

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function trimUrl(value) {
        let text = String(value || '').trim();
        const punctuation = text.search(/[，。；！？、]/);
        if (punctuation >= 0) text = text.slice(0, punctuation);
        return text
            .trim()
            .replace(/[\s\u3000]+$/g, '')
            .replace(/[，。；！？、）》】」』〉》〉\]\)\}>'"`]+$/g, '');
    }

    function parseUrl(value) {
        try {
            const parsed = new URL(value);
            if (!/^https?:$/i.test(parsed.protocol) || !parsed.hostname) return null;
            return parsed;
        } catch (error) {
            return null;
        }
    }

    function isMarketplaceUrl(value) {
        const parsed = parseUrl(value);
        if (!parsed) return false;
        const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
        return ['taobao.com', 'tmall.com', 'tb.cn'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    }

    function extractMarketplaceLinks(message) {
        const matches = String(message || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
        const urls = [];
        for (const raw of matches) {
            const url = trimUrl(raw);
            if (!isMarketplaceUrl(url) || urls.includes(url)) continue;
            urls.push(url);
            if (urls.length >= MAX_LINKS) break;
        }
        return urls;
    }

    function normalizeJobIds(values) {
        return [...new Set((Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter((value) => /^[A-Za-z0-9_-]{1,120}$/.test(value)))].slice(0, MAX_LINKS);
    }

    function stageLabel(job) {
        const status = String(job?.status || '').toLowerCase();
        const stage = String(job?.stage || '').toLowerCase();
        if (status === 'needs_login' || status === 'login_required') return job?.message || '请在可见 Edge 中扫码/登录或完成页面验证，完成后会自动继续';
        if (status === 'failed' || status === 'paused' || status === 'timeout') return job?.message || '商品链接采集失败';
        if (stage === 'public_fetch') return '正在读取商品公开页面';
        if (stage === 'browser_collect') return job?.message || '请在可见 Edge 中扫码/完成页面验证，完成后会自动继续读取';
        if (stage === 'normalize') return '正在整理商品快照、模块状态和证据';
        if (stage === 'completed') return status === 'partial' ? '商品快照已完成，部分模块未返回' : '商品快照已完成';
        return job?.message || '正在读取商品链接';
    }

    async function readJson(response) {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`);
        return data;
    }

    function makeTaskError(job, jobIds, results) {
        const status = String(job?.status || '').toLowerCase();
        const base = status === 'needs_login' || status === 'login_required'
            ? '商品页需要登录或完成验证，请在可见 Edge 中处理后点击重试'
            : (job?.message || '商品链接采集失败');
        const error = new Error(base);
        error.linkAnalysis = { jobIds: jobIds.slice(), results: results.slice(), failedJob: job || null };
        return error;
    }

    async function createJob(url) {
        const response = await fetch('/api/commerce-analysis/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, browser: true }),
        });
        return readJson(response);
    }

    async function retryJob(jobId) {
        const response = await fetch(`/api/commerce-analysis/jobs/${encodeURIComponent(jobId)}/retry`, {
            method: 'POST',
        });
        return readJson(response);
    }

    async function pollJob(jobId, index, total, onProgress, options) {
        const opts = options || {};
        let retried = false;
        for (let attempt = 0; attempt < 600; attempt += 1) {
            const response = await fetch(`/api/commerce-analysis/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            const job = await readJson(response);
            if (typeof onProgress === 'function') onProgress({ job, jobId, index, total, label: stageLabel(job) });
            const status = String(job?.status || '').toLowerCase();
            if (TERMINAL_OK.has(status)) return job;
            if (TERMINAL_ERROR.has(status)) {
                if (opts.retryExisting && !retried) {
                    retried = true;
                    const queued = await retryJob(jobId);
                    if (typeof onProgress === 'function') onProgress({ job: queued, jobId, index, total, label: '已复用原任务，重新读取商品页面' });
                    continue;
                }
                throw makeTaskError(job, [jobId], [job]);
            }
            await sleep(attempt < 4 ? 500 : 900);
        }
        const error = new Error('商品链接采集等待超时，请确认可见 Edge 已完成登录或验证后重试');
        error.linkAnalysis = { jobIds: [jobId], results: [] };
        throw error;
    }

    async function prepare(message, options) {
        const opts = options || {};
        const urls = extractMarketplaceLinks(message);
        let existingJobIds = normalizeJobIds(opts.existingJobIds || opts.jobIds);
        // 同一批 URL 才能复用已有任务；没有 URL 时用于“继续分析”复用最近快照。
        if (urls.length && existingJobIds.length !== urls.length) existingJobIds = [];
        if (!urls.length && !existingJobIds.length) return { urls: [], jobIds: [], results: [], success: true, imageCount: 0 };

        const jobIds = [];
        const results = [];
        const total = urls.length || existingJobIds.length;
        const notify = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
        try {
            if (existingJobIds.length) {
                for (let index = 0; index < existingJobIds.length; index += 1) {
                    const jobId = existingJobIds[index];
                    jobIds.push(jobId);
                    results.push(await pollJob(jobId, index, total, notify, opts));
                }
            } else {
                for (let index = 0; index < urls.length; index += 1) {
                    const created = await createJob(urls[index]);
                    const jobId = String(created?.id || created?.jobId || '').trim();
                    if (!jobId) throw new Error('商品分析任务创建失败：服务端没有返回任务 ID');
                    jobIds.push(jobId);
                    notify({ job: created, jobId, index, total, label: '任务已创建，等待读取商品页' });
                    results.push(await pollJob(jobId, index, total, notify));
                }
            }
        } catch (error) {
            if (!error.linkAnalysis) error.linkAnalysis = { jobIds: [], results: [] };
            error.linkAnalysis.jobIds = [...new Set([...jobIds, ...(error.linkAnalysis.jobIds || [])])].slice(0, MAX_LINKS);
            error.linkAnalysis.results = [...results, ...(error.linkAnalysis.results || [])].slice(0, MAX_LINKS);
            throw error;
        }
        const imageCount = results.reduce((count, job) => {
            const result = job?.result || {};
            return count + Math.min(8, (result.mainImages || result.images || []).length + (result.detailImages || []).slice(0, 3).length);
        }, 0);
        return {
            urls,
            jobIds,
            results,
            success: true,
            partial: results.some((job) => String(job?.status || '').toLowerCase() === 'partial'),
            imageCount,
        };
    }

    window.XiaomeiLinkAnalysis = {
        MAX_LINKS,
        extractMarketplaceLinks,
        isMarketplaceUrl,
        normalizeJobIds,
        stageLabel,
        prepare,
    };
}());
