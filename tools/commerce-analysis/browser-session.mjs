import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { chromium } from 'playwright';

// This is a small, local-only browser bridge for the xiaomei canvas Agent.
// It intentionally uses a separate browser profile and never imports another
// application's sessions, cookies, tokens, extensions, or configuration.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
    const value = String(process.argv[index] || '');
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    args.set(key, process.argv[index + 1] && !String(process.argv[index + 1]).startsWith('--')
        ? String(process.argv[++index]) : 'true');
}

const port = Math.max(1, Number(args.get('port') || 0));
const token = String(args.get('token') || '').trim();
const profileDir = path.resolve(String(args.get('profile-dir') || ''));
const outputDir = path.resolve(String(args.get('output-dir') || ''));
const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const MAX_BODY_CHARS = 24000;
const MAX_MEDIA = 120;
const RISKY_CLICK = /发布|提交|付款|支付|购买|下单|删除|移除|上传|保存|发送|确认订单|立即购买|加入购物车|同意授权|授权/i;

let context = null;
let page = null;
let lastMedia = [];

function compactText(value, limit = MAX_BODY_CHARS) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, limit);
}

function safeFileName(value, fallback = 'browser-media') {
    const cleaned = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return cleaned || fallback;
}

function absoluteHttpUrl(value, base = '') {
    const parsed = new URL(String(value || '').trim(), base || undefined);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('只允许打开 http 或 https 网页');
    }
    return parsed.toString();
}

async function visible(locator) {
    return locator?.isVisible?.().catch(() => false) || false;
}

async function ensurePage() {
    if (page && !page.isClosed()) return page;
    if (!profileDir) throw new Error('没有配置小美画布浏览器用户目录');
    mkdirSync(profileDir, { recursive: true });
    const launchOptions = {
        headless: false,
        acceptDownloads: true,
        viewport: { width: 1360, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
    };
    const edgePath = edgeCandidates.find((candidate) => existsSync(candidate));
    if (edgePath) launchOptions.executablePath = edgePath;
    try {
        context = await chromium.launchPersistentContext(profileDir, launchOptions);
    } catch (firstError) {
        // A bundled Playwright browser is a useful fallback for development
        // machines that do not have Edge installed.
        if (!edgePath) throw firstError;
        delete launchOptions.executablePath;
        context = await chromium.launchPersistentContext(profileDir, launchOptions);
    }
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(6000);
    return page;
}

async function pageState(currentPage, withElements = false) {
    const state = {
        url: currentPage.url(),
        title: await currentPage.title().catch(() => ''),
        body: compactText(await currentPage.locator('body').innerText().catch(() => '')),
    };
    if (!withElements) return state;
    state.elements = await currentPage.evaluate(() => {
        const isVisible = (node) => {
            if (!node) return false;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textOf = (node) => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
        const absolute = (value) => {
            try { return new URL(value, location.href).href; } catch (_) { return ''; }
        };
        const links = [...document.querySelectorAll('a[href]')]
            .filter(isVisible)
            .map((node) => ({ text: textOf(node), href: absolute(node.getAttribute('href') || '') }))
            .filter((item) => item.text || item.href)
            .slice(0, 80);
        const buttons = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')]
            .filter(isVisible)
            .map((node) => textOf(node) || String(node.getAttribute('aria-label') || node.getAttribute('value') || '').trim())
            .filter(Boolean)
            .slice(0, 80);
        return { links, buttons };
    }).catch(() => ({ links: [], buttons: [] }));
    return state;
}

async function openPage(url) {
    const currentPage = await ensurePage();
    const target = absoluteHttpUrl(url);
    await currentPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(async (error) => {
        // Some ecommerce pages keep network requests open forever. The visible
        // page is still useful after a navigation timeout, so return its state.
        if (!currentPage.url() || currentPage.url() === 'about:blank') throw error;
    });
    await currentPage.waitForTimeout(700).catch(() => {});
    return pageState(currentPage, true);
}

async function findClickTarget(currentPage, text, selector) {
    if (selector) {
        const locator = currentPage.locator(String(selector)).first();
        if (await visible(locator)) return locator;
        return null;
    }
    const label = String(text || '').trim();
    if (!label) return null;
    const candidates = [
        currentPage.getByRole('button', { name: label, exact: true }).first(),
        currentPage.getByRole('link', { name: label, exact: true }).first(),
        currentPage.getByText(label, { exact: true }).first(),
        currentPage.getByRole('button', { name: label, exact: false }).first(),
        currentPage.getByRole('link', { name: label, exact: false }).first(),
    ];
    for (const locator of candidates) if (await visible(locator)) return locator;
    return null;
}

async function clickPage({ text = '', selector = '', confirm = false }) {
    const currentPage = await ensurePage();
    const locator = await findClickTarget(currentPage, text, selector);
    if (!locator) throw new Error('没有找到可见的精确文字或选择器目标');
    const targetText = compactText(await locator.innerText().catch(() => text), 300);
    if ((RISKY_CLICK.test(`${text} ${selector} ${targetText}`)) && !confirm) {
        return {
            ok: false,
            status: 'confirmation_required',
            message: '这是可能产生外部影响的按钮。请再次明确写出“确认点击 + 按钮文字”，再执行。',
            target: targetText || String(text || selector),
            url: currentPage.url(),
        };
    }
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 7000 });
    await currentPage.waitForTimeout(700).catch(() => {});
    return { ok: true, status: 'clicked', target: targetText || String(text || selector), ...(await pageState(currentPage, true)) };
}

async function extractPage(selector = '') {
    const currentPage = await ensurePage();
    if (!selector) return { ok: true, status: 'snapshot', ...(await pageState(currentPage, true)) };
    const locator = currentPage.locator(String(selector)).first();
    if (!await visible(locator)) throw new Error('没有找到可见的选择器目标');
    return {
        ok: true,
        status: 'extracted',
        url: currentPage.url(),
        title: await currentPage.title().catch(() => ''),
        selector: String(selector),
        text: compactText(await locator.innerText().catch(() => '')),
    };
}

async function listMedia() {
    const currentPage = await ensurePage();
    const items = await currentPage.evaluate(() => {
        const absolute = (value) => {
            try {
                const url = new URL(value, location.href);
                return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
            } catch (_) { return ''; }
        };
        const result = [];
        const add = (type, value, label = '') => {
            const url = absolute(value);
            if (!url || result.some((item) => item.url === url)) return;
            result.push({ type, url, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
        };
        for (const node of document.querySelectorAll('video')) add('video', node.currentSrc || node.src || node.getAttribute('data-src') || '', node.getAttribute('aria-label') || '视频');
        for (const node of document.querySelectorAll('audio')) add('audio', node.currentSrc || node.src || node.getAttribute('data-src') || '', node.getAttribute('aria-label') || '音频');
        for (const node of document.querySelectorAll('video source,audio source')) add(node.parentElement?.tagName?.toLowerCase() || 'media', node.src || node.getAttribute('src') || '', '媒体源');
        for (const node of document.querySelectorAll('a[href]')) {
            const href = node.getAttribute('href') || '';
            if (/\.(?:mp4|webm|mov|mp3|wav|m4a)(?:[?#]|$)/i.test(href)) add('media', href, node.innerText || '媒体下载');
        }
        return result.slice(0, 120);
    }).catch(() => []);
    lastMedia = items.map((item, index) => ({ id: String(index + 1), ...item }));
    return { ok: true, status: 'media_list', url: currentPage.url(), items: lastMedia };
}

async function downloadMedia({ mediaId = '', filename = '' }) {
    const item = lastMedia.find((candidate) => String(candidate.id) === String(mediaId || '').trim());
    if (!item) throw new Error('媒体编号不存在，请先执行“列出媒体”');
    if (!/^https?:/i.test(item.url)) throw new Error('这个媒体地址不支持直接下载');
    mkdirSync(outputDir, { recursive: true });
    const response = await (await ensurePage()).request.get(item.url, { timeout: 30000 });
    if (!response.ok()) throw new Error(`下载失败：HTTP ${response.status()}`);
    const body = await response.body();
    if (body.byteLength > 120 * 1024 * 1024) throw new Error('媒体超过 120 MB，已停止下载');
    const urlPath = new URL(item.url).pathname;
    const extension = path.extname(urlPath).replace(/[^.a-z0-9]/gi, '').slice(0, 8) || (item.type === 'video' ? '.mp4' : '.bin');
    let finalName = safeFileName(filename || `media-${item.id}`);
    if (!path.extname(finalName)) finalName += extension;
    const destination = path.resolve(outputDir, finalName);
    if (!destination.startsWith(`${outputDir}${path.sep}`)) throw new Error('非法下载文件名');
    writeFileSync(destination, body);
    return { ok: true, status: 'downloaded', media_id: item.id, filename: finalName, path: destination, bytes: body.byteLength, url: item.url };
}

async function handleAction(payload = {}) {
    const action = String(payload.action || 'status').trim().toLowerCase();
    if (action === 'status') return { ok: true, status: 'ready', running: Boolean(context && page && !page.isClosed()), url: page?.url?.() || '' };
    if (action === 'open') return { ok: true, status: 'opened', ...(await openPage(payload.url)) };
    if (action === 'snapshot') return { ok: true, status: 'snapshot', ...(await pageState(await ensurePage(), true)) };
    if (action === 'screenshot') {
        const currentPage = await ensurePage();
        mkdirSync(outputDir, { recursive: true });
        const fileName = `screenshot-${Date.now()}.png`;
        const destination = path.resolve(outputDir, fileName);
        await currentPage.screenshot({ path: destination, fullPage: false });
        return { ok: true, status: 'screenshot', path: destination, ...(await pageState(currentPage)) };
    }
    if (action === 'click') return clickPage(payload);
    if (action === 'extract') return extractPage(payload.selector || '');
    if (action === 'list-media') return listMedia();
    if (action === 'download-media') return downloadMedia(payload);
    if (action === 'close') {
        if (context) await context.close().catch(() => {});
        context = null;
        page = null;
        lastMedia = [];
        return { ok: true, status: 'closed' };
    }
    throw new Error(`不支持的浏览器动作：${action}`);
}

function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

function readRequest(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) reject(new Error('请求过大'));
        });
        request.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (_) { reject(new Error('请求不是有效 JSON')); }
        });
        request.on('error', reject);
    });
}

const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/action') {
        sendJson(response, 404, { ok: false, error: 'not_found' });
        return;
    }
    if (!token || String(request.headers['x-xiaomei-browser-token'] || '') !== token) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
    }
    try {
        const result = await handleAction(await readRequest(request));
        sendJson(response, result?.ok === false ? 409 : 200, result);
    } catch (error) {
        sendJson(response, 500, { ok: false, status: 'error', error: String(error?.message || error) });
    }
});

server.on('clientError', (_error, socket) => socket.destroy());
server.listen(port, '127.0.0.1');

async function shutdown() {
    server.close();
    if (context) await context.close().catch(() => {});
    process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
