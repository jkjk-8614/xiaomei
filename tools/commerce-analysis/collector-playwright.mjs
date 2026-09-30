import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import dabiProtocol from './dabi-taobao.cjs';
import skuPageState from './sku-page-state.cjs';
import productPageState from './product-page-state.cjs';

const { classifyDabiEndpoint, parseDabiResponseBody, parseDabiNetworkRecords: parseSharedDabiNetworkRecords } = dabiProtocol;
const { collectDabiSkuState } = skuPageState;
const { collectDabiProductState, enrichDabiProductCategory, filterDabiMainImages } = productPageState;

const targetUrl = String(process.argv[2] || '').trim();
const requestedModule = String(process.env.COMMERCE_ANALYSIS_MODULE || '').trim().toLowerCase();
const combinedReviewsAndQuestions = requestedModule === 'reviews_questions';
const targetedModule = requestedModule === 'reviews' || requestedModule === 'questions' || combinedReviewsAndQuestions;
const baseOnly = requestedModule === 'base' || Boolean(requestedModule && !targetedModule);
const modulesToCollect = combinedReviewsAndQuestions ? ['reviews', 'questions'] : targetedModule ? [requestedModule] : baseOnly ? [] : ['reviews', 'questions'];
const configuredReviewSamples = Number(
    process.env.XIAOMEI_DABI_MAX_REVIEW_SAMPLES
    || process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES,
);
const maxReviewSamples = Math.max(20, Math.min(5000, configuredReviewSamples || 200));
const port = Number(process.env.COMMERCE_ANALYSIS_BROWSER_PORT || 9227);
const profileDir = process.env.COMMERCE_ANALYSIS_BROWSER_PROFILE || '';
const fastBrowser = String(process.env.COMMERCE_ANALYSIS_FAST_BROWSER || '1') !== '0';
const configuredWaitSeconds = Number(process.env.COMMERCE_ANALYSIS_BROWSER_WAIT_SECONDS || 300);
const waitSeconds = fastBrowser
    ? Math.max(15, Math.min(90, configuredWaitSeconds))
    : Math.max(60, configuredWaitSeconds);
const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function output(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function text(value, limit = 4000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function visible(locator) {
    return locator.isVisible().catch(() => false);
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function canonicalizeProductUrl(value) {
    try {
        const parsed = new URL(value);
        const keepKeys = new Set(['id', 'item_id', 'itemId', 'skuId', 'sku_id']);
        const kept = [...parsed.searchParams.entries()].filter(([key]) => keepKeys.has(key));
        parsed.search = '';
        for (const [key, item] of kept) parsed.searchParams.set(key, item);
        return parsed.toString();
    } catch (error) {
        return value;
    }
}

async function getPlaywright() {
    try {
        return await import('playwright');
    } catch (error) {
        output({
            ok: false,
            status: 'playwright_unavailable',
            error: '未安装 Node Playwright；已由服务端回退到兼容 CDP 采集器',
            detail: String(error?.message || error),
        });
        return null;
    }
}

async function connectOrLaunch(playwright) {
    const connect = () => playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    const attach = (browser) => {
        const pages = browser.contexts().flatMap((context) => context.pages())
            .filter((page) => !/(?:127\.0\.0\.1|localhost)(?::\d+)?\/static\/|(?:127\.0\.0\.1|localhost):3000/i.test(page.url()));
        if (pages.length) return { page: pages[0], browser };
        const context = browser.contexts()[0];
        if (!context) return null;
        return { page: context.newPage(), browser };
    };
    const session = (browser, page) => ({
        page,
        // Edge is intentionally left visible for the user to inspect or finish
        // a login/verification flow. Only the local Playwright connection is
        // disconnected in finally; the browser process remains available for
        // the next retry.
        close: async () => {},
        disconnect: () => {
            try { browser?._connection?.close?.(); } catch (error) {}
        },
    });
    try {
        const browser = await connect();
        const attached = attach(browser);
        if (attached) return session(browser, await attached.page);
        browser?._connection?.close?.();
    } catch (error) {}

    const edgePath = edgeCandidates.find((candidate) => candidate && existsSync(candidate));
    if (!edgePath) throw new Error('未找到 Microsoft Edge');
    if (!profileDir) throw new Error('没有配置浏览器用户目录');
    const child = spawn(edgePath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(500);
        try {
            const browser = await connect();
            const attached = attach(browser);
            if (attached) return session(browser, await attached.page);
            browser?._connection?.close?.();
        } catch (error) {}
    }
    throw new Error('Edge 调试端口没有返回页面');
}

async function pageState(page) {
    const body = await page.locator('body').innerText().catch(() => '');
    const currentUrl = page.url();
    const challenge = /验证码|滑块验证|访问验证|安全验证|异常流量|人机验证|captcha|verify/i.test(body);
    const login = /login\.taobao\.com|login\.tmall\.com/i.test(currentUrl) || /请先登录|请登录|登录淘宝/.test(body);
    const productReady = /商品详情|加入购物车|立即购买|用户评价|问大家|已售/.test(body) && body.length > 100;
    return { url: currentUrl, title: await page.title().catch(() => ''), challenge, login, productReady, body: text(body, 16000) };
}

async function waitForProduct(page) {
    let state = await pageState(page);
    const deadline = Date.now() + waitSeconds * 1000;
    let authWallDetected = false;
    while (Date.now() < deadline) {
        state = await pageState(page);
        if (state.challenge || state.login) authWallDetected = true;
        if (state.productReady && !state.challenge && !state.login) return state;
        await delay(1000);
    }
    return { ...state, wait_timeout: true, auth_wall_detected: authWallDetected || state.challenge || state.login };
}

async function navigateTab(page, labels) {
    for (const label of labels) {
        const locators = [
            page.getByRole('tab', { name: label, exact: false }).first(),
            page.locator('button, a, [role="tab"], [class*="tab"], [class*="Tab"]').filter({ hasText: label }).first(),
            page.getByText(label, { exact: false }).first(),
        ];
        for (const locator of locators) {
            if (await visible(locator)) {
                await locator.scrollIntoViewIfNeeded().catch(() => {});
                await locator.click({ timeout: 4000 }).catch(() => {});
                await delay(1000);
                return true;
            }
        }
    }
    return false;
}

async function clickVisibleControl(page, labels) {
    for (const label of labels) {
        const locators = [
            page.getByRole('button', { name: label, exact: false }).first(),
            page.getByRole('link', { name: label, exact: false }).first(),
            page.locator('[role="button"],[class*="tab"],[class*="Tab"],button,a').filter({ hasText: label }).first(),
            page.getByText(label, { exact: false }).first(),
        ];
        for (const locator of locators) {
            if (!await visible(locator)) continue;
            await locator.scrollIntoViewIfNeeded().catch(() => {});
            const clicked = await locator.click({ timeout: 3500 }).then(() => true).catch(() => false);
            if (clicked) { await delay(750); return { clicked: true, label }; }
        }
    }
    return { clicked: false, label: labels[0] || '' };
}

async function expandVisibleContent(page, labels = ['更多', '展开', '查看全部', '查看全部评价', '查看全部问答']) {
    let count = 0;
    const trace = [];
    for (const label of labels) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await clickVisibleControl(page, [label]);
            if (!result.clicked) break;
            count += 1;
            trace.push({ action: 'expand', target: result.label, status: 'clicked' });
        }
    }
    return { count, trace };
}

async function paginateVisible(page, maxPages = 3) {
    let pageCount = 1;
    const trace = [];
    for (let index = 0; index < Math.max(0, maxPages - 1); index += 1) {
        const result = await clickVisibleControl(page, ['下一页', '后一页', '下页', '下一组', '加载更多', '查看更多']);
        if (!result.clicked) break;
        pageCount += 1;
        trace.push({ action: 'paginate', target: result.label, status: 'clicked', page: pageCount });
        await settleLazyContent(page, 8);
    }
    return { pageCount, trace };
}

async function settleLazyContent(page, passes = 18) {
    for (let index = 0; index < passes; index += 1) {
        await page.evaluate(() => {
            const scrollables = [...document.querySelectorAll('*')].filter((node) => {
                const style = getComputedStyle(node);
                return node.scrollHeight > node.clientHeight + 80 &&
                    /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`);
            }).slice(0, 80);
            window.scrollBy(0, Math.max(320, Math.floor(window.innerHeight * 0.85)));
            for (const node of scrollables) node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + Math.max(240, node.clientHeight * 0.85));
            for (const image of document.images) {
                const lazy = image.dataset?.src || image.dataset?.original || image.getAttribute('data-imgurl');
                if (lazy && (!image.src || /data:image|loading|placeholder/i.test(image.src))) image.src = lazy;
            }
        }).catch(() => {});
        await delay(180);
    }
}

async function collectBase(page) {
    return page.evaluate(() => {
        const normalize = (value, limit = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const absolute = (value) => { try { return new URL(value, location.href).href; } catch (error) { return ''; } };
        const isVisible = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
        const imageUrl = (node) => absolute(node?.dataset?.src || node?.dataset?.original || node?.getAttribute?.('data-imgurl') || node?.currentSrc || node?.src || '');
        const optionHost = (node) => node?.closest?.('[data-value], [data-pv], [data-sku-value], [data-sku-id], [role="option"], a, button, li') || node;
        const imageOk = (url, node) => {
            if (!/^https?:/i.test(url) || /(?:avatar|headimg|favicon|loading|placeholder|qrcode|logo|icon|detail|desc)/i.test(url)) return false;
            const width = Number(node?.naturalWidth || node?.width || 0);
            const height = Number(node?.naturalHeight || node?.height || 0);
            return !(width && height && (width < 120 || height < 120));
        };
        const videoUrl = (node) => absolute(node?.name || node?.currentSrc || node?.src || node?.getAttribute?.('data-src') || node?.getAttribute?.('data-video') || node?.getAttribute?.('data-video-url') || node?.getAttribute?.('data-url') || '');
        const textOf = (selector) => normalize(document.querySelector(selector)?.innerText || '', 500);
        const rawBody = String(document.body?.innerText || '');
        const body = normalize(rawBody, 24000);
        const badTitle = (value) => !value || value.length < 8 || /淘宝|天猫|登录|平台加补|店铺评分|宝贝评分|商品评分|描述相符|收藏|分享|加入购物车|立即购买|促销|优惠券/i.test(value);
        const candidateValues = [
            ...[...document.querySelectorAll('h1, [class*="item-title"], [class*="itemTitle"], [class*="product-title"], [class*="productTitle"]')].map((node) => ({ value: node.innerText, boost: 180 })),
            { value: document.querySelector('meta[property="og:title"]')?.content, boost: 100 },
            { value: document.title, boost: 60 },
            ...rawBody.split(/\n+/).map((line) => ({ value: line.trim(), boost: 0 })),
        ].map((item) => ({ value: normalize(item.value, 260), boost: item.boost })).filter((item) => !badTitle(item.value));
        const titleCandidates = [...new Map(candidateValues.map((item) => [item.value, item])).values()].map((item) => ({
            value: item.value,
            score: item.boost + item.value.length,
        }));
        const title = titleCandidates.sort((a, b) => b.score - a.score)[0]?.value || '';
        const gallerySelectors = ['#J_UlThumb img', '#J_ThumbView img', '[class*="gallery"] img', '[class*="Gallery"] img', '[class*="carousel"] img', '[class*="thumb"] img', '[class*="mainPic"] img'];
        const gallery = [];
        for (const selector of gallerySelectors) {
            for (const node of document.querySelectorAll(selector)) if (isVisible(node) && !gallery.includes(node)) gallery.push(node);
            if (gallery.length >= 20) break;
        }
        if (!gallery.length) gallery.push(...[...document.images].filter((node) => isVisible(node)).slice(0, 40));
        const mainImages = [];
        for (const url of gallery.map((node) => imageUrl(node)).filter((value, index, list) => imageOk(value, gallery[index]) && list.indexOf(value) === index)) {
            if (/(?:^|\/)tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\//i.test(url)) continue;
            const small = url.match(/(?:tps[-_](\d+)[x-](\d+)|[-_](\d{2,4})[-x](\d{2,4})(?:\.(?:png|jpe?g|webp))(?:[_?]|$))/i);
            if (small && ((Number(small[1] || small[3]) || 0) < 160 || (Number(small[2] || small[4]) || 0) < 160)) continue;
            if (/(?:^|[_-])\d{2,4}x\d{2,4}q30(?:[._?-]|$)/i.test(url)) continue;
            mainImages.push(url);
            if (mainImages.length >= 5) break;
        }
        const videoCandidates = [
            ...[...document.querySelectorAll('video, video source, [data-video], [data-video-url], [class*="video"] source')],
            ...[...performance.getEntriesByType('resource')].filter((entry) => /\.(?:mp4|m3u8|webm|mov|m4v|ts)(?:[?#]|$)|(?:\/video\/|\/playback|\/vod\/|\/play\/|\/stream\/|video(?:[-_/?]|$)|cloud\.video)/i.test(entry.name)),
        ];
        const videos = [];
        for (const node of videoCandidates) {
            const url = typeof node === 'string' ? absolute(node) : videoUrl(node);
            if (!/^https?:/i.test(url) || videos.some((item) => item.url === url)) continue;
            videos.push({ url, type: /\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'video', source: 'visible-page' });
            if (videos.length >= 20) break;
        }
        const price = body.match(/(?:￥|¥)\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] || '';
        const reviewCount = body.match(/(?:累计评价|评价总数|评论数|用户评价)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1] || '';
        const sales = body.match(/(?:已售|销量|成交|付款人数)\s*[·:]?\s*([0-9.万千kK+]+)/)?.[1] || '';
        const rating = body.match(/(?:评分|描述相符)\s*[·:]?\s*([0-5](?:\.[0-9]+)?)/)?.[1] || '';
        const skuNodes = [...document.querySelectorAll('[class*="sku"], [class*="SKU"], [class*="spec"], [class*="prop"]')].filter(isVisible).slice(0, 80);
        const skuText = normalize(skuNodes.map((node) => node.innerText || '').join(' '), 12000);
        const specs = [];
        const skuSeen = new Set();
        const optionNoise = /已售|加购|加入购物车|领券购买|购买|库存|优惠|平台加补|价格|数量|收藏|分享/i;
        for (const node of skuNodes) {
            const candidates = [...node.querySelectorAll('button, li, [role="radio"], [class*="item"], [class*="value"], [class*="option"]')].filter(isVisible);
            const values = [];
            for (const option of candidates) {
                const host = optionHost(option);
                let value = normalize(option.innerText || option.getAttribute('aria-label') || host?.innerText || host?.getAttribute?.('title') || '', 180);
                value = value.replace(/\s*(?:千人加购|加购|已售[^\s]*|加入购物车|领券购买).*$/i, '').trim();
                if (!value || value.length > 180 || skuSeen.has(value) || optionNoise.test(value) || /颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|库存/i.test(value)) continue;
                skuSeen.add(value);
                values.push({
                    name: value,
                    image: imageUrl(option.querySelector?.('img') || host?.querySelector?.('img')),
                    selected: option.getAttribute('aria-checked') === 'true' || host?.getAttribute?.('aria-checked') === 'true' || /selected|checked|active/i.test(`${option.className || ''} ${host?.className || ''}`),
                    disabled: option.hasAttribute('disabled') || host?.hasAttribute?.('disabled') || /disabled|soldout|outofstock/i.test(`${option.className || ''} ${host?.className || ''}`),
                });
            }
            if (!values.length) continue;
            let heading = normalize((node.querySelector('dt, th, label, [class*="name"], [class*="title"]')?.innerText || '').split(/[:：]/)[0], 100);
            if (!heading || optionNoise.test(heading) || /已售|加购|加入购物车/i.test(heading)) heading = '商品规格';
            const key = `${heading}:${values.map((item) => item.name).join('|')}`;
            if (!specs.some((item) => item.name === heading) && !skuSeen.has(key)) specs.push({ name: heading, values: values.slice(0, 100) });
            if (specs.length >= 30) break;
        }
        if (!specs.some((group) => /颜色/i.test(group.name))) {
            const lines = rawBody.split(/\n+/).map((line) => normalize(line, 240)).filter(Boolean);
            const colorLabel = /^(颜色分类|颜色)\s*[:：]?$/i;
            const nextLabel = /^(颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合|数量|库存|有货|领券购买|收藏|加入购物车|立即购买)/i;
            for (let index = 0; index < lines.length; index += 1) {
                if (!colorLabel.test(lines[index])) continue;
                const values = [];
                for (let cursor = index + 1; cursor < lines.length && values.length < 100; cursor += 1) {
                    const line = lines[cursor];
                    if (nextLabel.test(line)) break;
                    if (line.length <= 180 && !optionNoise.test(line)) values.push({ name: line });
                }
                if (values.length) {
                    const group = specs.find((item) => item.name === '颜色分类' || item.name === '颜色');
                    if (group) group.values.push(...values.filter((value) => !group.values.some((item) => item.name === value.name)));
                    else specs.unshift({ name: '颜色分类', values: values.slice(0, 100) });
                }
                break;
            }
        }
        if (!specs.length) {
            const inferred = [...new Set((skuText.match(/\b\d{2,3}\s*[-至]\s*\d{2,3}\s*CM\b/gi) || []).map((value) => value.replace(/\s+/g, ' ').trim()))];
            if (inferred.length) specs.push({ name: '商品规格', values: inferred.slice(0, 100).map((name) => ({ name, selected: false, disabled: false })) });
        }
        for (const group of specs) {
            for (const value of group.values || []) {
                if (value.image || !value.name) continue;
                const match = [...document.querySelectorAll('button, li, [role="radio"], [class*="item"], [class*="value"], [class*="option"]')].find((node) => {
                    if (!isVisible(node)) return false;
                    const host = optionHost(node);
                    const text = normalize(node.innerText || node.textContent || host?.innerText || host?.textContent || host?.getAttribute?.('title') || '', 240);
                    return text === value.name || text.includes(value.name) || value.name.includes(text);
                });
                if (match) value.image = imageUrl(match.querySelector?.('img') || optionHost(match)?.querySelector?.('img'));
            }
        }
        const stock = (skuText.match(/(?:库存|数量|状态)?\s*(有货|现货|无货|缺货|售罄)/i) || [])[1] || '';
        // 可见 DOM 只能说明页面上有规格选择器，不能证明存在完整 SKU 组合。
        // 没有真实 SKU ID/规格路径时保持空列表，避免把当前选中项导出成伪 SKU。
        const skuItems = [];
        return {
            final_url: location.href,
            rawText: body,
            product: { title, store: textOf('[class*="shop-name"], [class*="shopName"], [class*="seller-name"], [class*="sellerName"]'), price, reviewCount, sales, rating },
            mainImages,
            images: mainImages,
            videos,
            sku: { available: Boolean(specs.length || /颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|组合|库存/.test(skuText)), text: skuText, specs, items: skuItems },
        };
    });
}

async function collectCards(page, selectors, limit = 200) {
    return page.evaluate(({ selectors, limit }) => {
        const normalize = (value, max = 1800) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const visible = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
        const result = []; const seen = new Set();
        for (const selector of selectors) for (const node of document.querySelectorAll(selector)) {
            if (!visible(node)) continue;
            // 评价/问大家常把整组列表和单条记录同时挂同一 class；只保留叶子卡片，
            // 避免把父容器再次当成一条“样本”。
            if ([...node.querySelectorAll(selector)].length) continue;
            const value = normalize(node.innerText || '');
            if (value.length < 8 || value.length > 2200 || seen.has(value)) continue;
            seen.add(value); result.push(value); if (result.length >= limit) return result;
        }
        return result;
    }, { selectors, limit });
}

async function collectDetail(page) {
    return page.evaluate(() => {
        const normalize = (value, limit = 30000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const selectors = [
            '#imageTextInfo-content', '#imageTextInfo-container', '#J_Detail', '#J_DivItemDesc', '#detail',
            '#description', '#desc', '[id*="imageTextInfo"]', '[id*="detail"]', '[id*="Detail"]',
            '[class*="detail-content"]', '[class*="DetailContent"]', '[class*="desc-content"]',
            '[class*="DescContent"]', '[class*="image-text"]', '[class*="ImageText"]',
        ];
        const nodes = [...document.querySelectorAll(selectors.join(','))].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !/(review|comment|rate|sku|ask|question)/i.test(`${node.id || ''} ${node.className || ''}`);
        });
        const node = nodes.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
        const root = node || document.body;
        const images = [...root.querySelectorAll('img')].map((img) => { try { return new URL(img.dataset?.src || img.dataset?.original || img.getAttribute('data-imgurl') || img.currentSrc || img.src, location.href).href; } catch (error) { return ''; } }).filter((url) => /^https?:/i.test(url) && !/(avatar|logo|icon|loading|placeholder|qrcode)/i.test(url));
        const uniqueImages = [...new Set(images)].slice(0, 240);
        const raw = normalize(root.innerText || '', 30000);
        return { text: raw, sections: raw ? [{ title: '图文详情可见内容', text: raw, score: null }] : [], images: uniqueImages, imageCount: uniqueImages.length, scoped: Boolean(node), selector: node ? `${node.id || ''} ${node.className || ''}`.trim().slice(0, 240) : '' };
    });
}

// 达比的淘系采集不是先让模型规划一轮网页动作，而是先挂住页面已经会发出的
// mtop 接口，再直接读取淘宝新版页面的初始化状态。这里保留 Playwright 作为
// 可见浏览器连接层，把这条“单次直读 + 少量懒加载触发”的路径放在慢速通用
// 扫描之前；商品标题、价格、主图和 SKU 不再等待评价/详情的长轮询。
function createDabiNetworkCapture(page) {
    const records = { reviews: [], questions: [], detail: [] };
    const pending = new Set();
    const responseListener = (response) => {
        const url = String(response.url() || '');
        const kind = classifyDabiEndpoint(url);
        if (!kind) return;
        const task = (async () => {
            try {
                const raw = await response.text();
                if (!raw || raw.length > 16 * 1024 * 1024) return;
                const data = parseDabiResponseBody(raw);
                if (data && typeof data === 'object') records[kind].push({ url, data });
            } catch {}
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
    };
    page.on('response', responseListener);
    return {
        records,
        async settle(waitMs = 350) {
            await delay(waitMs);
            const tasks = [...pending];
            if (tasks.length) await Promise.allSettled(tasks);
        },
        dispose() {
            page.off('response', responseListener);
        },
    };
}

function unwrapDabiPayload(value, kind = '') {
    // 淘宝 mtop 的 data 在不同页面版本里可能是对象、JSON 字符串，
    // 或再套一层 result/model。只沿着已知包裹字段寻找目标模块，
    // 不把整页文本或其它接口响应误当成评价/问大家数据。
    const expected = kind === 'reviews'
        ? (node) => Array.isArray(node?.rateList)
        : kind === 'questions'
            ? (node) => Array.isArray(node?.questionList)
            : kind === 'detail'
                ? (node) => Boolean(node?.components && typeof node.components === 'object')
                : (node) => Boolean(node?.rateList || node?.questionList || node?.components);
    const queue = [value];
    const seen = new Set();
    const wrapperKeys = ['data', 'result', 'response', 'model', 'payload', 'content'];
    while (queue.length) {
        let current = queue.shift();
        if (typeof current === 'string') {
            try { current = JSON.parse(current); } catch { continue; }
        }
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        if (expected(current)) return current;
        if (Array.isArray(current)) {
            for (const item of current.slice(0, 8)) queue.push(item);
            continue;
        }
        for (const key of wrapperKeys) {
            if (current[key] !== undefined && current[key] !== null) queue.push(current[key]);
        }
    }
    return {};
}

function parseDabiNetworkRecords(records) {
    const reviews = [];
    const questions = [];
    const maxQuestionSamples = 2000;
    const detailImages = [];
    const detailTexts = [];
    let reviewTotal = '';
    let questionTotal = '';
    const seenReview = new Set();
    const seenQuestion = new Map();
    const seenDetail = new Set();
    const absolute = (value) => {
        try {
            const raw = String(value || '').trim();
            if (!raw) return '';
            return new URL(raw.startsWith('//') ? `https:${raw}` : raw).href;
        } catch { return ''; }
    };
    const text = (value, limit = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
    const addDetail = (value) => {
        const url = absolute(value);
        if (!url || !/^https?:/i.test(url) || seenDetail.has(url)) return;
        seenDetail.add(url);
        detailImages.push(url);
    };
    const mediaFromHtml = (html) => {
        const source = String(html || '');
        const tagRe = /<(?:img|video|source)\b[^>]*>/gi;
        const attrRe = /(?:src|data-src|data-original|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
        for (const tag of source.match(tagRe) || []) {
            const match = tag.match(attrRe);
            if (match) addDetail(match[1] || match[2] || match[3] || '');
        }
    };
    for (const record of records?.reviews || []) {
        const payload = unwrapDabiPayload(record.data, 'reviews');
        const list = Array.isArray(payload.rateList) ? payload.rateList : [];
        reviewTotal = reviewTotal || payload.totalCount || payload.rateCount || payload.total || '';
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const content = text(item.feedback || item.content || item.rateContent || item.text, 1800);
            const id = text(item.id || item.rateId || `${content}:${item.feedbackDate || ''}`, 160);
            if (!content || seenReview.has(id)) continue;
            seenReview.add(id);
            const imageValues = Array.isArray(item.feedPicPathList) ? item.feedPicPathList : [];
            const cloudVideoUrl = item.video?.cloudVideoUrl;
            const videoValues = Array.isArray(cloudVideoUrl) ? cloudVideoUrl : [cloudVideoUrl];
            reviews.push({
                id,
                content,
                text: content,
                author: text(item.userNick || item.user || '', 120),
                date: text(item.feedbackDate || item.date || '', 80),
                rating: text(item.score || item.rate || '', 40),
                images: imageValues.map(absolute).filter(Boolean).slice(0, 12),
                videos: videoValues.map(absolute).filter(Boolean).slice(0, 4),
            });
            if (reviews.length >= maxReviewSamples) break;
        }
        if (reviews.length >= maxReviewSamples) break;
    }
    for (const record of records?.questions || []) {
        if (questions.length >= maxQuestionSamples) break;
        const payload = unwrapDabiPayload(record.data, 'questions');
        const list = Array.isArray(payload.questionList) ? payload.questionList : [];
        questionTotal = questionTotal || payload.totalCount || payload.questionCount || payload.total || '';
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const question = text(item.questionTitle || item.question || item.title || item.text, 1200);
            const answers = Array.isArray(item.topAnswerList) ? item.topAnswerList : [];
            const answerValues = [
                item.answer,
                item.answerTitle,
                item.reply,
                item.sellerAnswer,
                ...answers.map((answer) => answer?.answerTitle || answer?.answer || answer?.content || answer?.text || ''),
            ].map((value) => text(value, 1800)).filter((value, index, values) => value && values.indexOf(value) === index);
            const id = text(item.questionId || item.id || `${question}:${item.gmtCreate || ''}`, 160);
            if (!question || !id) continue;
            const existing = seenQuestion.get(id);
            if (existing) {
                existing.answers = [...new Set([...(existing.answers || []), ...answerValues])];
                existing.answer = existing.answers.join('\n');
                continue;
            }
            const itemResult = { id, question, text: question, answers: answerValues, answer: answerValues.join('\n'), date: text(item.gmtCreate || item.date || '', 80) };
            seenQuestion.set(id, itemResult);
            questions.push(itemResult);
            if (questions.length >= maxQuestionSamples) break;
        }
    }
    for (const record of records?.detail || []) {
        const payload = unwrapDabiPayload(record.data, 'detail');
        const components = payload.components;
        if (!components || typeof components !== 'object') continue;
        const layout = Array.isArray(components.layout) ? components.layout : [];
        const componentData = components.componentData && typeof components.componentData === 'object' ? components.componentData : {};
        for (const entry of layout) {
            const model = componentData[entry?.ID]?.model;
            if (!model || typeof model !== 'object') continue;
            addDetail(model.picUrl);
            if (typeof model.text === 'string') {
                detailTexts.push(text(model.text.replace(/<[^>]+>/g, ' '), 3000));
                mediaFromHtml(model.text);
            }
        }
    }
    return {
        reviews: reviews.slice(0, maxReviewSamples),
        questions: questions.slice(0, maxQuestionSamples),
        detail: {
            text: text(detailTexts.filter(Boolean).join(' '), 30000),
            sections: detailTexts.filter(Boolean).slice(0, 40).map((value) => ({ title: '图文详情可见内容', text: value, score: null })),
            images: detailImages.slice(0, 240),
        },
        reviewStats: { sampleCount: reviews.length, totalCount: reviewTotal },
        questionStats: { sampleCount: questions.length, totalCount: questionTotal },
    };
}

// 商品基础信息统一走共享的达笔式页面状态解析器；商品标题、类目、价格区间、
// 参数组、媒体和 SKU 使用同一份状态快照，避免不同采集器互相覆盖。
async function collectDabiPageState(page) {
    return page.evaluate(collectDabiProductState);
}

async function dabiScrollToEntry(page, selector) {
    const locator = page.locator(selector).first();
    if (!(await visible(locator))) return false;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    return true;
}

async function dabiScrollUntilEntry(page, selector, maxRounds = 24) {
    for (let round = 0; round < maxRounds; round += 1) {
        if (await dabiScrollToEntry(page, selector)) return true;
        await page.evaluate(() => window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.85)))).catch(() => {});
        await delay(260);
    }
    return false;
}

async function dabiClick(page, selector) {
    const locator = page.locator(selector).first();
    if (!(await visible(locator))) return false;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    try {
        await locator.click({ timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function dabiScrollSession(page, selector, capture, kind, limit = maxReviewSamples, onVisible = null) {
    const maxRounds = Math.max(40, Math.min(500, Number(limit) || maxReviewSamples));
    let endStalls = 0;
    let lastSampleCount = 0;
    for (let round = 0; round < maxRounds; round += 1) {
        const state = await page.evaluate(({ selector }) => {
            const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const root = document.querySelector(selector);
            if (!root) {
                // 达笔的 scrollForSession 只滚动已经打开的抽屉；
                // 抽屉不存在时不能回退滚动商品整页，避免把入口/推荐区
                // 当成评价或问大家采集进度。
                return { found: false, done: true, count: 0 };
            }
            const text = tidy(root.innerText || '');
            const before = root.scrollTop;
            root.scrollTop = Math.min(root.scrollHeight, root.scrollTop + 600);
            const done = root.scrollTop + root.clientHeight >= root.scrollHeight - 8 || root.scrollTop === before;
            return { found: true, done, textLength: text.length };
        }, { selector }).catch(() => ({ found: false, done: true, textLength: 0 }));
        await capture?.settle?.(120);
        if (typeof onVisible === 'function') await onVisible().catch(() => {});
        const parsed = parseSharedDabiNetworkRecords(capture?.records || {}, { baseUrl: page.url() || '' });
        const sampleCount = Array.isArray(parsed?.[kind]) ? parsed[kind].length : 0;
        const stats = kind === 'reviews' ? (parsed?.reviewStats || {}) : (parsed?.questionStats || {});
        const hasNext = stats.hasNext === true || stats.hasMore === true || stats.hasNextPage === true;
        const progressed = sampleCount > lastSampleCount;
        if (state.done && !progressed) endStalls += 1;
        else if (progressed) endStalls = 0;
        lastSampleCount = sampleCount;
        if (sampleCount >= limit) break;
        if (state.done && hasNext && endStalls < 8) continue;
        if (state.done || (!progressed && endStalls >= 2)) break;
    }
}

async function collectVisibleQuestionCards(page) {
    return page.evaluate(() => {
        const tidy = (value, limit = 1800) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const visible = (node) => {
            if (!node) return false;
            try {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            } catch { return false; }
        };
        const roots = [...document.querySelectorAll('[class*="AskAnswersWrap--"] [class*="ContentArea--"], [class*="AskAnswersWrap--"], [class*="leftDrawer"]')]
            .filter(visible)
            .sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
        const root = roots[0];
        if (!root) return { ok: false, samples: [], totalCount: '' };
        const drawer = root.closest('[class*="AskAnswersWrap--"],[class*="leftDrawer"]') || root;
        const drawerText = tidy(drawer.innerText || '', 12000);
        const totalCount = drawerText.match(/(?:问大家|买家问答|常见问题|全部)\s*[·:：]?\s*([0-9.万千kK+]+)/i)?.[1] || '';
        const parsePair = (value) => {
            let compact = tidy(value, 2400)
                .replace(/^.*?(?:问大家|买家问答|常见问题)\s*[·:：]?\s*\d+(?:\.\d+)?[万千kK+]?\s*/i, '')
                .replace(/\s*(?:查看全部问答|查看全部回答|查看更多问答|更多问答).*$/i, '');
            const parts = compact.split(/\s+(?=问\s*[:：]?)/).filter((part) => /^问\s*[:：]?/.test(part));
            return parts.map((part) => {
                const clean = part.replace(/^问\s*[:：]?\s*/i, '').replace(/\s*更多回答(?:\s+\d+)?\s*$/i, '').trim();
                const match = clean.match(/^(.+?(?:[?？]|吗|呢|啊|呀|怎样|怎么样|如何|怎么|多少|哪里|多久|什么|能不能|可不可以|好不好|是否)[。！？!?]?)(?:\s+(.+))?$/);
                if (!match || match[1].length < 4) return null;
                const answer = tidy(match[2] || '', 1200);
                return { question: match[1].trim(), answer };
            }).filter(Boolean);
        };
        const selected = new Map();
        for (const node of [root, ...root.querySelectorAll('*')].filter(visible)) {
            const text = tidy(node.innerText || node.textContent || '', 2400);
            const pairs = parsePair(text);
            if (pairs.length !== 1) continue;
            const pair = pairs[0];
            const key = pair.question.replace(/\s+/g, ' ').trim().toLowerCase();
            const score = pair.answer.length * 10 + Math.min(text.length, 1800);
            const current = selected.get(key);
            if (!current || score > current.score) {
                selected.set(key, {
                    id: String(node.getAttribute?.('data-question-id') || node.getAttribute?.('data-id') || key).slice(0, 160),
                    question: pair.question,
                    text: pair.question,
                    answers: pair.answer ? [pair.answer] : [],
                    answer: pair.answer,
                    source: 'dabi-visible-question',
                    score,
                });
            }
        }
        return {
            ok: true,
            samples: [...selected.values()].map(({ score, ...item }) => item).slice(0, 2000),
            totalCount,
        };
    }).catch(() => ({ ok: false, samples: [], totalCount: '' }));
}

function mergeVisibleQuestionSamples(left = [], right = [], limit = 2000) {
    const output = [];
    for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        const question = String(item?.question || item?.text || '').replace(/\s+/g, ' ').trim();
        if (question.length < 4) continue;
        const index = output.findIndex((current) => {
            const value = String(current?.question || current?.text || '').replace(/\s+/g, ' ').trim();
            return value === question || value.includes(question) || question.includes(value);
        });
        if (index < 0) {
            output.push(item);
        } else {
            const current = output[index];
            const answers = [...new Set([...(current?.answers || []), ...(item?.answers || []), current?.answer || '', item?.answer || ''].filter(Boolean))];
            output[index] = { ...current, ...item, answers, answer: answers.join('\n') };
        }
        if (output.length >= limit) break;
    }
    return output;
}

async function dabiNudgePage(page) {
    await page.evaluate(() => {
        const delta = Math.max(600, Math.floor(window.innerHeight * 0.9));
        window.scrollBy(0, delta);
    }).catch(() => {});
}

// 详情图片在商品链接打开期间已经由 Network 监听器接收，或已经挂在当前
// 页面 DOM/初始化状态中。这里仅读取这些现成数据，不用旧版的固定滚动触发。
async function dabiReadDetailForNetwork(page, capture, trace) {
    const beforeResponses = capture.records.detail.length;
    await capture.settle(450);
    const state = await collectDabiPageState(page).catch(() => ({}));
    const domDetail = await collectDetail(page).catch(() => ({}));
    const detailImages = [...new Set([
        ...(state?.detail?.images || []),
        ...(domDetail?.images || []),
    ].filter((url) => /^https?:/i.test(String(url || ''))))].slice(0, 240);
    const detail = {
        text: String(state?.detail?.text || domDetail?.text || '').trim().slice(0, 30000),
        sections: Array.isArray(state?.detail?.sections) && state.detail.sections.length
            ? state.detail.sections
            : (domDetail?.text ? [{ title: '图文详情可见内容', text: domDetail.text, score: null }] : []),
        images: detailImages,
    };
    const detailState = {
        passes: 0,
        changedPasses: 0,
        rootFound: Boolean(domDetail?.scoped || detailImages.length),
        imageCount: detailImages.length,
        scrolled: false,
        detail,
    };
    trace.push({
        action: 'inspect',
        module: 'detail',
        target: '已挂载的详情页图文',
        status: detailImages.length || detail.text ? 'completed' : 'missing',
        clicked: false,
        scrolled: false,
        imageCount: detailImages.length,
        networkResponses: capture.records.detail.length - beforeResponses,
        input: 'page-state-network',
    });
    return detailState;
}

async function collectDabiFast(page, capture, targetUrl) {
    const trace = [{ action: 'inspect', module: 'product', target: '商品页初始化状态', status: 'completed' }];
    await delay(350);
    let state = await collectDabiPageState(page).catch(() => ({}));
    let structuredSku = await page.evaluate(collectDabiSkuState).catch(() => ({}));
    let fallback = {};
    const stateSkuValues = (state?.sku?.specs || []).flatMap((group) => group?.values || []).length;
    const stateSkuImages = (state?.sku?.specs || []).flatMap((group) => group?.values || []).filter((item) => item?.image || item?.imageUrl || item?.pic).length;
    const stateSkuItems = Array.isArray(state?.sku?.items) ? state.sku.items.length : 0;
    const structuredSkuItems = Array.isArray(structuredSku?.items) ? structuredSku.items.length : 0;
    if (!state?.product?.title || !(state.mainImages || []).length || (!structuredSkuItems && !stateSkuImages && stateSkuItems <= 1)) {
        fallback = await collectBase(page).catch(() => ({}));
    }
    const mergeSku = (left = {}, right = {}) => {
        const result = { ...(right || {}), ...(left || {}) };
        const specs = [];
        const byName = new Map();
        for (const source of [right, left]) {
            for (const rawGroup of (source?.specs || [])) {
                if (!rawGroup || typeof rawGroup !== 'object') continue;
                const name = String(rawGroup.name || rawGroup.title || '').trim();
                if (!name) continue;
                let group = byName.get(name);
                if (!group) { group = { name, values: [] }; byName.set(name, group); specs.push(group); }
                for (const rawValue of (rawGroup.values || [])) {
                    if (rawValue === null || rawValue === undefined) continue;
                    const value = typeof rawValue === 'object' ? { ...rawValue } : { name: rawValue };
                    const valueName = String(value.name || value.value || value.title || value.text || '').replace(/\s+/g, ' ').trim();
                    if (!valueName || valueName === '…' || valueName === '...') continue;
                    const existing = group.values.find((item) => item.name === valueName);
                    if (existing) {
                        if (!existing.image && (value.image || value.imageUrl || value.pic)) existing.image = value.image || value.imageUrl || value.pic;
                        if (!existing.id && value.id) existing.id = value.id;
                        existing.selected = existing.selected || Boolean(value.selected);
                        existing.disabled = existing.disabled && Boolean(value.disabled);
                    } else if (group.values.length < 100) {
                        group.values.push({ ...value, name: valueName });
                    }
                }
            }
        }
        const items = [];
        const itemKeys = new Set();
        const isRealSkuItem = (rawItem) => {
            if (!rawItem || typeof rawItem !== 'object') return false;
            const id = String(rawItem.id || rawItem.skuId || rawItem.sku_id || rawItem.skuID || '').trim();
            const path = String(rawItem.propPath || rawItem.prop_path || rawItem.propertyPath || '').trim();
            const specs = Array.isArray(rawItem.specs)
                ? rawItem.specs.filter((item) => item && (item.value || item.name)).length
                : String(rawItem.specs || rawItem.specText || '').trim().length;
            return Boolean(id && (path || specs));
        };
        for (const source of [right, left]) {
            for (const rawItem of (source?.items || [])) {
                if (!isRealSkuItem(rawItem)) continue;
                const item = { ...rawItem };
                const key = String(item.id || item.sku_id || item.propPath || item.prop_path || JSON.stringify(item.specs || [])).trim();
                if (itemKeys.has(key)) continue;
                itemKeys.add(key); items.push(item);
            }
        }
        result.specs = specs.slice(0, 50);
        result.items = items.slice(0, 500);
        const numeric = (value) => {
            const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/\+$/, ''));
            return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
        };
        const explicitTotal = Math.max(numeric(left?.totalCount || left?.skuCount), numeric(right?.totalCount || right?.skuCount));
        result.itemCount = result.items.length;
        result.totalCount = Math.max(explicitTotal, result.itemCount);
        const imageUrls = new Set();
        for (const item of [...result.items, ...result.specs.flatMap((group) => group.values || [])]) {
            const image = String(item?.image || item?.imageUrl || item?.pic || '').trim();
            if (image) imageUrls.add(image);
        }
        result.specImageCount = Math.max(numeric(left?.specImageCount), numeric(right?.specImageCount), imageUrls.size);
        result.matrixComplete = Boolean(result.itemCount && (!result.totalCount || result.itemCount >= result.totalCount));
        result.available = Boolean(result.available || result.totalCount || specs.length || items.length);
        return result;
    };
    const mergeProduct = { ...(fallback.product || {}), ...(state.product || {}) };
    const mainImages = filterDabiMainImages([...(state.mainImages || []), ...(fallback.mainImages || fallback.images || [])], 5);
    let visibleQuestions = [];
    let visibleQuestionTotal = '';
    const readVisibleQuestions = async () => {
        if (!modulesToCollect.includes('questions')) return;
        const result = await collectVisibleQuestionCards(page);
        if (result?.totalCount) visibleQuestionTotal = String(result.totalCount).trim();
        if (Array.isArray(result?.samples)) visibleQuestions = mergeVisibleQuestionSamples(visibleQuestions, result.samples, 2000);
    };
    const fastTrigger = true;
    if (fastTrigger) {
      // 直接复刻 D:\达笔\dabi\resources\automation-scripts\taobao-detail.json
      // 的固定选择器和抽屉滚动路径。基础采集不打开评价/问大家；用户点击
      // 对应资源卡后，才按评价 → 问大家的目标 mtop 接口读取正文样本。
      if (modulesToCollect.length) {
        await dabiNudgePage(page);
        trace.push({ action: 'scroll', module: 'page', target: '触发懒加载', status: 'completed' });
        await capture.settle(300);
      }
      const reviewEntry = '[class*="ShowButton"], [class*="footer"] [class*="ShowButton"]';
      if (modulesToCollect.includes('reviews') && await dabiScrollUntilEntry(page, reviewEntry)) {
            const clicked = await dabiClick(page, reviewEntry);
            if (clicked) {
                trace.push({ action: 'click', module: 'reviews', target: '淘宝评价入口', status: 'clicked' });
                await delay(450);
                await dabiScrollSession(page, '[class*="detailContentClassName"] [class*="Comment"] [class*="comments"]', capture, 'reviews', maxReviewSamples);
                await capture.settle(300);
                await dabiClick(page, '[class*="detailContentClassName"] [class*="closeWrap"]');
      } else if (modulesToCollect.includes('reviews')) {
                trace.push({ action: 'click', module: 'reviews', target: '淘宝评价入口', status: 'failed' });
            }
        } else {
            trace.push({ action: 'click', module: 'reviews', target: '淘宝评价入口', status: 'missing' });
      }
      const askEntry = '[class*="bottomBtnWrap"] > [class*="bottomBtn"], [class*="bottomBtn--"]';
      if (modulesToCollect.includes('questions') && await dabiScrollUntilEntry(page, askEntry)) {
            const clicked = await dabiClick(page, askEntry);
            if (clicked) {
                trace.push({ action: 'click', module: 'questions', target: '淘宝问大家入口', status: 'clicked' });
                await delay(450);
                await readVisibleQuestions();
                await dabiScrollSession(page, '[class*="AskAnswersWrap--"] [class*="ContentArea--"]', capture, 'questions', 2000, readVisibleQuestions);
                await capture.settle(300);
                await readVisibleQuestions();
                await dabiClick(page, '[class*="leftDrawer"] [class*="closeWrap"], [class*="AskAnswersWrap"] [class*="closeWrap"]');
      } else if (modulesToCollect.includes('questions')) {
                trace.push({ action: 'click', module: 'questions', target: '淘宝问大家入口', status: 'failed' });
            }
        } else {
            trace.push({ action: 'click', module: 'questions', target: '淘宝问大家入口', status: 'missing' });
        }
        const passiveDetailState = await dabiReadDetailForNetwork(page, capture, trace);
        if (!fallback.detail && passiveDetailState?.detail) fallback.detail = passiveDetailState.detail;
    }
    const network = parseSharedDabiNetworkRecords(capture.records, { baseUrl: page.url() || targetUrl });
    const detail = network.detail?.images?.length || network.detail?.text ? network.detail : (fallback.detail || {});
    const reviews = modulesToCollect.includes('reviews') ? (network.reviews || []) : [];
    const visibleQuestionFallback = modulesToCollect.includes('questions') && !(network.questions || []).length && visibleQuestions.length > 0;
    const questions = modulesToCollect.includes('questions')
        ? (visibleQuestionFallback ? visibleQuestions : (network.questions || []))
        : [];
    const mergeStats = (base, next) => {
        const baseTotal = String(base?.totalCount ?? '').trim();
        const nextTotal = String(next?.totalCount ?? '').trim();
        const merged = {
            ...(base || {}),
            ...Object.fromEntries(Object.entries(next || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined)),
        };
        // 商品页初始化状态是用户实际看到的“累计评价/问大家”口径；
        // mtop 响应的 totalCount 可能只是当前分页/筛选口径，单独保留但不覆盖页面数量。
        if (baseTotal) {
            merged.totalCount = baseTotal;
            merged.pageTotalCount = baseTotal;
            merged.totalCountSource = 'page-state-count';
            if (nextTotal && nextTotal !== baseTotal) merged.responseTotalCount = nextTotal;
        } else if (nextTotal) {
            merged.totalCount = nextTotal;
            merged.responseTotalCount = nextTotal;
        }
        return merged;
    };
    const reviewStats = mergeStats(state.reviewStats, network.reviewStats);
    const questionStats = mergeStats(state.questionStats, network.questionStats);
    if (!questionStats.totalCount && visibleQuestionTotal) questionStats.totalCount = visibleQuestionTotal;
    if (visibleQuestionFallback) questionStats.sampleCount = questions.length;
    if (visibleQuestionFallback) {
        trace.push({
            action: 'extract',
            module: 'questions',
            target: '问大家可见问答卡',
            status: 'completed',
            source: 'dabi-visible-question',
            sampleCount: visibleQuestions.length,
            realResponseSampleCount: visibleQuestions.length,
            responseCount: 0,
        });
    }
    const finalState = await collectDabiPageState(page).catch(() => ({}));
    const finalStructuredSku = await page.evaluate(collectDabiSkuState).catch(() => ({}));
    structuredSku = finalStructuredSku?.items?.length ? finalStructuredSku : structuredSku;
    const enrichedState = await enrichDabiProductCategory(finalState).catch(() => finalState);
    state = {
        ...state,
        ...enrichedState,
        product: { ...mergeProduct, ...(enrichedState.product || {}) },
        mainImages: filterDabiMainImages([...mainImages, ...(enrichedState.mainImages || [])], 5),
        images: filterDabiMainImages([...mainImages, ...(enrichedState.mainImages || [])], 5),
        videos: [...new Map([...(state.videos || []), ...(enrichedState.videos || [])].map((item) => [item.url || item, item])).values()].slice(0, 20),
        sku: mergeSku(structuredSku || {}, mergeSku(enrichedState.sku || {}, mergeSku(state.sku || {}, fallback.sku || {}))),
    };
    const hasBase = Boolean(state.product?.title || state.product?.price || state.mainImages?.length);
    const missingModules = [];
    if (!reviews.length && !baseOnly) missingModules.push('reviews');
    if (!questions.length && !baseOnly) missingModules.push('questions');
    if (!detail.text && !detail.images?.length) missingModules.push('detail');
    const complete = hasBase && !missingModules.length;
    const sourceSteps = trace.map((entry, index) => ({
        id: entry.id || `step-${String(index + 1).padStart(2, '0')}`,
        module: entry.module || 'product',
        action: entry.action || 'inspect',
        target: entry.target || '商品页可见状态',
        status: entry.status || 'completed',
        source: entry.source || 'browser-playwright-dabi-network',
        responseCount: Number(entry.responseCount || entry.networkResponses || 0) || 0,
        realResponseSampleCount: Number(entry.realResponseSampleCount || entry.sampleCount || 0) || 0,
    }));
    const moduleAudit = {};
    for (const module of ['reviews', 'questions']) {
        const selected = modulesToCollect.includes(module);
        const samples = module === 'reviews' ? reviews : questions;
        const stats = module === 'reviews' ? reviewStats : questionStats;
        const responseCount = Array.isArray(capture.records?.[module]) ? capture.records[module].length : 0;
        const endpoint = module === 'reviews' ? 'mtop-rateList' : 'mtop-questionList';
        const visibleFallback = module === 'questions' && visibleQuestionFallback;
        const pageStateStep = sourceSteps.find((step) => step.module === 'product')?.id || 'step-01';
        const moduleSteps = sourceSteps.filter((step) => step.module === module).map((step) => step.id);
        if (selected && (!moduleSteps.length || responseCount)) {
            const id = `step-${module}-response`;
            sourceSteps.push({
                id,
                module,
                action: 'read_mtop_response',
                target: module === 'reviews' ? '评价 rateList 响应' : '问大家 questionList 响应',
                status: responseCount ? 'completed' : 'missing',
                source: endpoint,
                responseCount,
                realResponseSampleCount: samples.length,
            });
            moduleSteps.push(id);
        }
        const explicitTotal = stats?.totalCount ?? '';
        const status = !selected
            ? (baseOnly ? 'deferred' : 'not_requested')
            : samples.length ? 'ready' : responseCount ? 'partial' : 'missing';
        moduleAudit[module] = {
            status,
            sampleCount: samples.length,
            realResponseSampleCount: samples.length,
            responseCount,
            totalCount: explicitTotal,
            pageTotalCount: stats?.pageTotalCount || (!responseCount && explicitTotal !== '' ? explicitTotal : ''),
            responseTotalCount: stats?.responseTotalCount || '',
            totalCountSource: stats?.totalCountSource || (explicitTotal !== '' ? (visibleFallback || stats?.pageTotalCount || !responseCount ? 'page-state-count' : endpoint) : '未返回'),
            source: selected ? (visibleFallback ? 'dabi-visible-question' : endpoint) : 'page-state-count',
            sourceStepIds: selected ? moduleSteps : [pageStateStep],
            reason: status === 'deferred'
                ? '本次采集仅读取商品页计数，未请求正文；未使用演示数据'
                : status === 'not_requested'
                    ? '本次任务未请求该模块；未使用演示数据'
                    : status === 'missing'
                        ? '未捕获对应 mtop 真实响应样本；未使用演示数据'
                        : visibleFallback
                            ? '已从问大家抽屉的可见问答卡精确提取真实样本'
                            : '已从对应 mtop 真实响应归一化样本',
        };
    }
    const skuTotalCount = Number(state.sku?.totalCount || state.sku?.skuCount || 0) || 0;
    const skuItemCount = Number(state.sku?.itemCount || state.sku?.items?.length || 0) || 0;
    const productStateStep = sourceSteps.find((step) => step.module === 'product')?.id || 'step-01';
    moduleAudit.sku = {
        status: skuTotalCount && skuItemCount < skuTotalCount ? 'partial' : skuItemCount ? 'ready' : skuTotalCount ? 'partial' : 'missing',
        sampleCount: skuItemCount,
        realResponseSampleCount: 0,
        responseCount: 0,
        totalCount: skuTotalCount || skuItemCount || '',
        totalCountSource: skuTotalCount ? 'product-page-sku-count' : skuItemCount ? 'sku-page-state-rows' : '未返回',
        source: 'product-page-state',
        sourceStepIds: [productStateStep],
        reason: skuTotalCount && skuItemCount < skuTotalCount
            ? `页面返回 SKU 总量 ${skuTotalCount}，当前已解析 ${skuItemCount} 条真实明细`
            : skuItemCount
                ? '已读取商品页真实 SKU 规格与组合'
                : '当前页面未返回真实 SKU 组合；未使用当前选中项或尺寸表生成伪数据',
    };
    const productId = String(state.product?.id || '').trim();
    const normalizedUrl = canonicalizeProductUrl(page.url() || targetUrl);
    return {
        ok: hasBase,
        status: complete ? 'ready' : hasBase ? 'partial' : 'timeout',
        source: 'browser-playwright-dabi-network',
        original_url: targetUrl,
        final_url: page.url() || targetUrl,
        product: {
            ...(state.product || {}),
            ...(skuTotalCount ? { skuCount: skuTotalCount } : {}),
        },
        productId,
        normalized_url: normalizedUrl,
        mainImages: state.mainImages || [],
        images: state.mainImages || [],
        videos: state.videos || [],
        sku: state.sku || { available: false, specs: [], items: [] },
        reviews,
        questions,
        detail,
        detailImages: detail.images || [],
        rawText: state.rawText || fallback.rawText || '',
        reviewStats,
        questionStats,
         collection: {
             mode: 'dabi-network',
             source: 'browser-playwright-dabi-network',
             interactionMode: modulesToCollect.length ? 'visible' : 'passive',
             trigger: modulesToCollect.length ? 'resource_click' : 'auto_open',
             fastMode: true,
            visiblePageOnly: true,
            actionTrace: trace,
            sourceSteps,
            modules: moduleAudit,
            productId,
            normalizedUrl,
            collectedAt: new Date().toISOString(),
            rawResponsesPersisted: false,
            sensitiveDataStored: false,
            networkModules: { reviews: capture.records.reviews.length, questions: capture.records.questions.length, detail: capture.records.detail.length },
            samples: { reviews: reviews.length, questions: questions.length, detailImages: detail.images?.length || 0, videos: state.videos?.length || 0 },
             deferredModules: baseOnly ? ['reviews', 'questions'] : [],
             strategy: baseOnly
                 ? '先读取商品页初始化状态、主图、详情、SKU、视频和评价/问大家数量；正文仅在点击资源卡后读取。'
                 : '可见页面执行评价→问大家动作，详情只读取已挂载状态；评价优先取 mtop rateList，问大家无可回读响应时从已打开抽屉的可见问答卡精确提取',
        },
        quality: { collectionMode: 'dabi-network', missingModules },
    };
}

async function main() {
    if (!/^https?:\/\//i.test(targetUrl)) throw new Error('商品链接不是有效的 http(s) 地址');
    const playwright = await getPlaywright();
    if (!playwright) return;
    const session = await connectOrLaunch(playwright);
    const page = session.page;
    const networkCapture = createDabiNetworkCapture(page);
    const finalTargetUrl = canonicalizeProductUrl(targetUrl);
    let keepBrowserOpen = false;
    try {
        await page.bringToFront().catch(() => {});
        await page.goto(finalTargetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        const first = await waitForProduct(page);
        if (first.challenge || first.login || first.auth_wall_detected) {
            keepBrowserOpen = true;
            const challenge = Boolean(first.challenge);
            output({ ok: false, status: first.wait_timeout ? 'login_required' : challenge ? 'challenge' : 'login_required', challenge_detected: challenge, requires_login: !challenge, original_url: targetUrl, final_url: first.url || finalTargetUrl, message: first.wait_timeout ? '等待扫码/登录超时；可见 Edge 窗口已保留，请完成后点击重试' : challenge ? '页面触发安全验证，请在可见 Edge 中完成验证后自动继续' : '请在可见 Edge 中扫码/登录，完成后会自动继续读取' });
            return;
        }
        if (!first.productReady) {
            keepBrowserOpen = Boolean(first.wait_timeout);
            output({ ok: false, status: 'timeout', requires_login: Boolean(first.auth_wall_detected), original_url: targetUrl, final_url: first.url || finalTargetUrl, message: first.wait_timeout ? '等待商品页加载/验证超时；可见 Edge 窗口已保留，请完成操作后点击重试' : '商品页没有返回可采集内容，请在可见 Edge 中检查后重试' });
            return;
        }
        // 淘系详情采集统一走达笔式可见动作 + 目标接口监听；旧的宽泛 DOM
        // 评价/问大家扫描会把页面标题、入口和问题卡片混在一起，已移除为
        // 默认路径，避免再次生成错误样本。
        const fastResult = await collectDabiFast(page, networkCapture, targetUrl);
        output(fastResult);
        return;
    } finally {
        networkCapture.dispose();
        if (!keepBrowserOpen) await session.close().catch(() => {});
        session.disconnect?.();
    }
}

main()
    .catch((error) => output({ ok: false, status: 'playwright_failed', error: String(error?.message || error) }))
    // The browser is deliberately detached from this short-lived collector.
    // Give stdout a moment to flush, then do not keep the Node process alive
    // merely because Playwright still has internal handles.
    .finally(() => setTimeout(() => process.exit(0), 50));
