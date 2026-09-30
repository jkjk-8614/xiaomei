import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import skuPageState from './sku-page-state.cjs';
import productPageState from './product-page-state.cjs';

const { collectDabiSkuState } = skuPageState;
const { filterDabiMainImages } = productPageState;

const targetUrl = String(process.argv[2] || '').trim();
const port = Number(process.env.COMMERCE_ANALYSIS_BROWSER_PORT || 9227);
const profileDir = process.env.COMMERCE_ANALYSIS_BROWSER_PROFILE || '';
const waitSeconds = Math.max(60, Number(process.env.COMMERCE_ANALYSIS_BROWSER_WAIT_SECONDS || 300));
const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
let activeSocket = null;

function output(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function visible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

async function debugJson(path) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return response.json();
}

async function listPages() {
    try {
        const pages = await debugJson('/json/list');
        return Array.isArray(pages) ? pages.filter((page) => page.type === 'page' && page.webSocketDebuggerUrl) : [];
    } catch (error) {
        return [];
    }
}

function isWorkstationPage(page) {
    const url = String(page?.url || '');
    return /(?:127\.0\.0\.1|localhost)(?::\d+)?\/static\/|(?:127\.0\.0\.1|localhost):3000/i.test(url);
}

async function ensureBrowser() {
    let pages = (await listPages()).filter((page) => !isWorkstationPage(page));
    if (!pages.length) {
        const edgePath = edgeCandidates.find((candidate) => candidate && existsSync(candidate));
        if (!edgePath) throw new Error('未找到 Microsoft Edge');
        if (profileDir) mkdirSync(profileDir, { recursive: true });
        const child = spawn(edgePath, [
            `--remote-debugging-port=${port}`,
            ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
            '--no-first-run',
            '--no-default-browser-check',
            '--new-window',
            targetUrl,
        ], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await delay(500);
            pages = (await listPages()).filter((page) => !isWorkstationPage(page));
            if (pages.length) break;
        }
    }
    if (!pages.length) throw new Error('Edge 调试端口没有返回页面');
    return pages[0];
}

class CdpClient {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', (event) => {
            try {
                const packet = JSON.parse(String(event.data || ''));
                if (packet.id && this.pending.has(packet.id)) {
                    const pending = this.pending.get(packet.id);
                    this.pending.delete(packet.id);
                    if (packet.error) pending.reject(new Error(packet.error.message || 'CDP error'));
                    else pending.resolve(packet.result || {});
                }
            } catch (error) {}
        });
        socket.addEventListener('close', () => {
            for (const pending of this.pending.values()) pending.reject(new Error('浏览器连接已关闭'));
            this.pending.clear();
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
}

async function connectPage(page) {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接浏览器页面超时')), 10000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
        socket.addEventListener('error', (event) => { clearTimeout(timer); reject(event.error || new Error('连接浏览器页面失败')); });
    });
    return new CdpClient(socket);
}

async function evaluate(client, source, ...args) {
    const result = await client.send('Runtime.evaluate', {
        expression: `(${source})(${args.map((value) => JSON.stringify(value)).join(',')})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    return result?.result?.value;
}

async function navigate(client, url) {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url });
    await delay(2500);
}

async function snapshot(client) {
    return evaluate(client, () => {
        const text = document.body?.innerText || '';
        return {
            url: location.href,
            title: document.title || '',
            text: text.slice(0, 16000),
            challenge: /验证码|滑块验证|访问验证|安全验证|异常流量|人机验证|captcha|verify/i.test(text),
            productReady: /加入购物车|立即购买|商品详情|用户评价|问大家|已售|￥|¥/.test(text),
        };
    });
}

async function waitForProduct(client) {
    let last = await snapshot(client);
    const deadline = Date.now() + waitSeconds * 1000;
    let authWallDetected = false;
    while (Date.now() < deadline) {
        last = await snapshot(client);
        const login = /login\.taobao\.com|login\.tmall\.com/i.test(last.url) || /请先登录|请登录|登录淘宝/.test(last.text || '');
        if (last.challenge || login) authWallDetected = true;
        if (last.productReady && !last.challenge && !login) return { ...last, login: false };
        await delay(1000);
    }
    return { ...last, waitTimeout: true, authWallDetected: authWallDetected || last.challenge };
}

async function waitForUsefulTitle(client) {
    let last = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
        last = String(await evaluate(client, () => document.title || '') || '').replace(/\s+/g, ' ').trim();
        if (last.length >= 8 && !/^(?:淘宝网|天猫|88VIP|登录)$/i.test(last)) return last;
        await delay(500);
    }
    return last;
}

async function collectBase(client) {
    return evaluate(client, () => {
        const normalize = (value, limit = 5000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const bodyText = normalize(document.body?.innerText || '', 20000);
        const bodyLines = (document.body?.innerText || '').split(/\n+/).map((line) => normalize(line, 240)).filter(Boolean);
        const textOf = (selector) => normalize(document.querySelector(selector)?.innerText || '', 700);
        const documentTitle = normalize(document.title || '').replace(/\s*[-|｜]\s*(淘宝网|天猫)\s*$/i, '');
        const bodyTitle = bodyLines
            .filter((value) => value.length >= 10 && value.length <= 180)
            .filter((value) => !/^(首页|登录|注册|收藏|购物车|商品分类|用户评价|问大家|图文详情|参数信息|本店推荐|看了又看)$/i.test(value))
            .filter((value) => !/(?:好评率|客服满意度|平均\s*\d+\s*天内发货|88VIP|已售|回头客|加购|卖家优惠|平台加补|首单礼金|立减|发货|免运费)/i.test(value))
            .sort((a, b) => b.length - a.length)[0] || '';
        const titleCandidates = [
            documentTitle,
            textOf('h1'),
            textOf('[class*="title"]'),
            document.querySelector('meta[property="og:title"]')?.content || '',
            document.querySelector('meta[name="title"]')?.content || '',
            bodyTitle,
        ].map((value) => normalize(value)).filter((value) => value && !/^登录|淘宝网$/i.test(value));
        const usableTitleCandidates = titleCandidates.filter((value) => !/(?:好评率|客服满意度|平均\s*\d+\s*天内发货|88VIP|累计评价|用户评价|近\s*3\s*个月|已售|回头客|加购)/i.test(value));
        const absolute = (value) => {
            try { return new URL(value, location.href).href; } catch (error) { return ''; }
        };
        const skuImageUrl = (image) => {
            if (!image) return '';
            const dataValue = image.dataset?.src || image.dataset?.original || image.dataset?.lazySrc || image.dataset?.ksLazyload || image.getAttribute?.('data-imgurl') || '';
            const srcset = image.getAttribute?.('srcset') || image.getAttribute?.('data-srcset') || '';
            const srcsetValue = srcset.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
            return dataValue || srcsetValue || image.currentSrc || image.src || '';
        };
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const insideDetail = (image) => Boolean(image?.closest?.('#detail, #J_Detail, #J_DivItemDesc, #description, #desc, [id*="imageTextInfo"], [class*="detail"], [class*="desc"]'));
        const usefulImage = (image, value, allowUnknownSize = false) => {
            const width = Number(image.naturalWidth || image.width || 0);
            const height = Number(image.naturalHeight || image.height || 0);
            if (!allowUnknownSize && width && height && (width < 120 || height < 120)) return false;
            if (/(?:^|\/)tfs(?:\/|$)|gtms\d*\.alicdn\.com\/tps\//i.test(value)) return false;
            if (/(?:^|[_-])\d{2,4}x\d{2,4}q30(?:[._?-]|$)/i.test(value)) return false;
            return !/(?:avatar|headimg|favicon|s\.gif|loading|placeholder|icon[^a-z]|tb-icon|qrcode|qr-code|logo)/i.test(value);
        };
        const addImage = (list, image, allowUnknownSize = false) => {
            const value = absolute(imageUrl(image));
            if (!value || !/^https?:/i.test(value) || !usefulImage(image, value, allowUnknownSize) || list.includes(value)) return;
            list.push(value);
        };

        // 商品页的 document.images 会混入店铺 logo、评价头像、推荐商品和详情长图。
        // 主图只从商品画廊/缩略图容器取，最多保留 5 张，详情图另行采集。
        const gallerySelectors = [
            '#J_UlThumb img', '#J_ThumbView img', '#J_PicGallery img', '#J_ImgBooth img',
            '[class*="PicGallery"] img', '[class*="pic-gallery"] img', '[class*="mainPic"] img',
            '[class*="MainPic"] img', '[class*="gallery"] img', '[class*="Gallery"] img',
            '[class*="carousel"] img', '[class*="Carousel"] img', '[class*="slider"] img',
            '[class*="Slider"] img', '[class*="thumb"] img', '[class*="Thumb"] img',
        ];
        const galleryImages = [];
        for (const selector of gallerySelectors) {
            for (const image of [...document.querySelectorAll(selector)]) {
                if (visible(image) && !insideDetail(image) && !galleryImages.includes(image)) galleryImages.push(image);
            }
            if (galleryImages.length >= 20) break;
        }
        if (!galleryImages.length) {
            const titleNode = document.querySelector('h1, [class*="itemTitle"], [class*="product-title"], [class*="goods-title"]');
            const titleRect = titleNode?.getBoundingClientRect?.();
            galleryImages.push(...[...document.images]
                .filter((image) => visible(image) && !insideDetail(image))
                .sort((left, right) => {
                    const a = left.getBoundingClientRect();
                    const b = right.getBoundingClientRect();
                    const targetTop = Number(titleRect?.top || 180);
                    const targetLeft = Number(titleRect?.left || 0);
                    const score = (rect) => Math.abs(rect.top - targetTop) + Math.abs(rect.left - targetLeft) * 0.18 + (rect.top > 1200 ? 1800 : 0);
                    return score(a) - score(b);
                })
                .slice(0, 12));
        }
        const mainImages = [];
        for (const image of galleryImages) {
            addImage(mainImages, image, false);
            if (mainImages.length >= 5) break;
        }
        const videoUrl = (node) => {
            if (typeof node === 'string') return absolute(node);
            return absolute(node?.name || node?.currentSrc || node?.src || node?.dataset?.src || node?.dataset?.video || node?.dataset?.videoUrl || node?.getAttribute?.('data-video-url') || node?.getAttribute?.('data-url') || '');
        };
        const videoCandidates = [
            ...document.querySelectorAll('video, video source, [data-video], [data-video-url], [class*="video"] source'),
            ...performance.getEntriesByType('resource').filter((entry) => /\.(?:mp4|m3u8|webm|mov|m4v|ts)(?:[?#]|$)|(?:\/video\/|\/playback|\/vod\/|\/play\/|\/stream\/|video(?:[-_/?]|$)|cloud\.video)/i.test(entry.name)),
        ];
        const videos = [];
        for (const node of videoCandidates) {
            const url = videoUrl(node);
            if (!/^https?:/i.test(url) || videos.some((item) => item.url === url)) continue;
            videos.push({ url, type: /\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'video', source: 'visible-page' });
            if (videos.length >= 20) break;
        }

        const find = (patterns, source = bodyText) => {
            for (const pattern of patterns) {
                const match = source.match(pattern);
                if (match?.[1]) return normalize(match[1], 100);
            }
            return '';
        };
        const store = textOf('[class*="shop-name"], [class*="shopName"], [class*="seller-name"], [class*="sellerName"]');
        const storeRating = store.match(/(?<![0-9])([0-5](?:\.[0-9]))(?![0-9])/i)?.[1] || '';

        const skuNamePattern = /(?:颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合|数量|包装)/i;
        const skuExcludedPattern = /(?:用户评价|评价|评论|问大家|问答|图文详情|详情描述|售后|客服|推荐|看了又看|优惠|发货|运费)/i;
        const optionSelector = '[data-value], [data-pv], [data-sku-value], [data-sku-id], [role="option"], a, button, li, span';
        const rootScore = (element) => {
            const text = normalize(element.innerText || '', 14000);
            const marker = `${element.id || ''} ${element.className || ''}`;
            const labelCount = (text.match(/颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合/gi) || []).length;
            const optionCount = element.querySelectorAll(optionSelector).length;
            const classHint = /(?:sku|sale-prop|prop|spec)/i.test(marker) ? 120 : 0;
            const dataHint = element.querySelector('[data-value], [data-pv], [data-sku-id], [role="option"]') ? 70 : 0;
            return classHint + dataHint + labelCount * 34 + Math.min(optionCount, 80) * 3 - text.length / 3500;
        };
        const skuRootCandidates = [...document.querySelectorAll('section, main, div, ul, dl, table, [role="group"], [role="list"]')]
            .filter((element) => visible(element))
            .filter((element) => {
                const marker = `${element.id || ''} ${element.className || ''}`;
                const text = normalize(element.innerText || '', 14000);
                return text.length >= 2 && text.length <= 16000 && skuNamePattern.test(text) && !/(?:review|comment|rate|ask|question|detail|desc|recommend)/i.test(marker) && !skuExcludedPattern.test(marker);
            })
            .sort((a, b) => rootScore(b) - rootScore(a) || normalize(a.innerText || '').length - normalize(b.innerText || '').length);
        const skuRoots = skuRootCandidates.filter((element) => element.querySelector(optionSelector)).slice(0, 24);
        const skuRoot = skuRoots[0] || skuRootCandidates[0] || null;
        const genericSkuRows = [...document.querySelectorAll('li, dl, tr, div')]
            .filter((element) => visible(element) && !element.closest('[class*="detail"], [id*="detail"], [class*="review"], [id*="review"]'))
            .filter((element) => /^(?:颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合)\s*[:：]?/i.test(normalize(element.innerText, 360)));
        const rowSet = new Set();
        const skuRows = [];
        for (const root of skuRoots) {
            for (const row of root.querySelectorAll('li, dl, dt, dd, tr, [role="group"], [role="list"], [class*="prop"], [class*="Prop"], [class*="row"], [class*="Row"]')) {
                if (!rowSet.has(row)) { rowSet.add(row); skuRows.push(row); }
            }
        }
        for (const row of genericSkuRows) {
            if (!rowSet.has(row)) { rowSet.add(row); skuRows.push(row); }
        }
        const specs = [];
        const addSpec = (name, values) => {
            const cleanName = normalize(name, 100).replace(/[：:]+$/, '');
            const cleanValues = [];
            const seen = new Set();
            for (const value of values || []) {
                const item = typeof value === 'object' ? value : { name: value };
                const cleanValue = normalize(item.name || item.value || item.title || item.text || '', 160);
                if (!cleanValue || seen.has(cleanValue) || /^(选择|请选择|有货|无货|缺货|库存)$/i.test(cleanValue) || cleanValue === cleanName) continue;
                seen.add(cleanValue);
                cleanValues.push({
                    name: cleanValue,
                    image: item.image || '',
                    selected: Boolean(item.selected),
                    disabled: Boolean(item.disabled),
                    id: normalize(item.id || item.valueId || '', 120),
                });
            }
            if (!cleanName || !cleanValues.length || /^(sku|商品编码|加入购物车|立即购买)$/i.test(cleanName)) return;
            const existing = specs.find((item) => item.name === cleanName);
            if (existing) {
                const names = new Set(existing.values.map((item) => item.name));
                for (const value of cleanValues) {
                    const current = existing.values.find((item) => item.name === value.name);
                    if (current) {
                        if (!current.image && value.image) current.image = value.image;
                        if (!current.id && value.id) current.id = value.id;
                        current.selected = current.selected || value.selected;
                        current.disabled = current.disabled && value.disabled;
                    } else if (existing.values.length < 100 && !names.has(value.name)) {
                        existing.values.push(value);
                        names.add(value.name);
                    }
                }
            } else {
                specs.push({ name: cleanName, values: cleanValues.slice(0, 100) });
            }
        };
        const imageUrl = (image) => {
            if (!image) return '';
            const dataValue = image.dataset?.src || image.dataset?.original || image.dataset?.lazySrc || image.dataset?.ksLazyload || image.getAttribute?.('data-imgurl') || '';
            return dataValue || image.currentSrc || image.src || '';
        };
        const optionHost = (node) => node?.closest?.('[data-value], [data-pv], [data-sku-value], [data-sku-id], [role="option"], a, button, li') || node;
        const optionInfo = (node) => {
            const host = optionHost(node);
            const image = node.querySelector?.('img') || host?.querySelector?.('img');
            return {
                name: normalize(node.innerText || node.textContent || host?.innerText || host?.textContent || node.getAttribute?.('title') || host?.getAttribute?.('title') || node.getAttribute?.('data-value') || host?.getAttribute?.('data-value') || node.getAttribute?.('data-pv') || host?.getAttribute?.('data-pv') || node.getAttribute?.('data-sku-value') || host?.getAttribute?.('data-sku-value') || '', 160),
                image: skuImageUrl(image) || '',
                selected: Boolean(node.classList?.contains('selected') || node.classList?.contains('tb-selected') || host?.classList?.contains('selected') || host?.classList?.contains('tb-selected') || node.getAttribute?.('aria-selected') === 'true' || host?.getAttribute?.('aria-selected') === 'true' || node.getAttribute?.('data-selected') === 'true' || host?.getAttribute?.('data-selected') === 'true' || node.getAttribute?.('aria-checked') === 'true' || host?.getAttribute?.('aria-checked') === 'true'),
                disabled: Boolean(node.disabled || host?.disabled || node.getAttribute?.('aria-disabled') === 'true' || host?.getAttribute?.('aria-disabled') === 'true' || /(?:disabled|disable|out-stock|soldout|缺货|无货)/i.test(String(node.className || '') + ' ' + String(host?.className || ''))),
                id: node.getAttribute?.('data-value') || host?.getAttribute?.('data-value') || node.getAttribute?.('data-pv') || host?.getAttribute?.('data-pv') || node.getAttribute?.('data-sku-value') || host?.getAttribute?.('data-sku-value') || node.getAttribute?.('data-value-id') || host?.getAttribute?.('data-value-id') || '',
            };
        };
        for (const row of skuRows) {
            if (!visible(row)) continue;
            const rowText = normalize(row.innerText || row.textContent || '', 800);
            if (!rowText || !skuNamePattern.test(rowText)) continue;
            const labelNode = row.querySelector('dt, th, [class*="name"], [class*="Name"], [class*="label"], [class*="Label"], [class*="propname"], [class*="PropName"], [data-property-name]');
            let label = normalize(labelNode?.getAttribute?.('data-property-name') || labelNode?.innerText || row.firstElementChild?.innerText || '', 100);
            if (!label) label = normalize(rowText.match(/^(颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合)\s*[:：]?/i)?.[1] || '', 100);
            const nodes = [...row.querySelectorAll(optionSelector)].filter((node) => node !== labelNode && !labelNode?.contains?.(node) && visible(node));
            const leafNodes = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
            let values = leafNodes.map(optionInfo);
            if (!values.length) {
                const tail = rowText.replace(/^(?:颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合)\s*[:：]?/i, '').trim();
                values = tail.split(/\s{2,}|[|｜/、,，]+/).map((value) => ({ name: value }));
            }
            addSpec(label, values);
        }
        if (!specs.length && skuRoot) {
            const lines = normalize(skuRoot.innerText, 10000).split(/\n+|\s{2,}/).map((line) => normalize(line, 180)).filter(Boolean);
            for (const line of lines) {
                const match = line.match(/^(颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合)\s*[:：]?\s*(.+)$/i);
                if (match) addSpec(match[1], match[2].split(/[|｜/、,，\s]+/).map((value) => ({ name: value })));
            }
        }
        // 新版淘宝有时先渲染尺码表，颜色选项只存在于可见文字和缩略图按钮中。
        // 已经解析出一组规格时也要补齐缺失的颜色分类，不能让当前组合冒充整组 SKU。
        if (!specs.some((spec) => /颜色/i.test(spec.name))) {
            const lines = String(document.body?.innerText || '').split(/\n+/).map((line) => normalize(line, 240)).filter(Boolean);
            const colorLabel = /^(颜色分类|颜色)\s*[:：]?$/i;
            const nextLabel = /^(颜色分类|颜色|尺码|尺寸|款式|套餐|版本|规格|容量|型号|风格|组合|数量|库存|有货|领券购买|收藏|加入购物车|立即购买)/i;
            for (let index = 0; index < lines.length; index += 1) {
                if (!colorLabel.test(lines[index])) continue;
                const values = [];
                for (let cursor = index + 1; cursor < lines.length && values.length < 100; cursor += 1) {
                    const line = lines[cursor];
                    if (nextLabel.test(line)) break;
                    if (line.length <= 180 && !/^(?:选择|请选择|有货|现货|无货|缺货|库存|数量|收藏|分享|加入购物车|立即购买|领券购买)$/i.test(line) && !/(?:平台加补|优惠前|价格|发货|运费|好评|评价|详情)/i.test(line)) values.push({ name: line });
                }
                addSpec('颜色分类', values);
                if (values.length) break;
            }
        }
        // 文本补齐后，为同名规格值回填它在可见选项按钮中的真实图片。
        for (const spec of specs) {
            for (const value of spec.values || []) {
                if (value.image || !value.name) continue;
                const match = [...document.querySelectorAll(optionSelector)].find((node) => {
                    if (!visible(node)) return false;
                    const host = optionHost(node);
                    const text = normalize(node.innerText || node.textContent || host?.innerText || host?.textContent || host?.getAttribute?.('title') || '', 240);
                    return text.length >= 2 && (text === value.name || text.includes(value.name) || value.name.includes(text));
                });
                if (match) value.image = skuImageUrl(match.querySelector?.('img') || optionHost(match)?.querySelector?.('img'));
            }
        }
        const skuText = normalize(skuRoot?.innerText || genericSkuRows.map((row) => row.innerText || '').join(' '), 12000);
        const skuId = find([/(?:商品编码|货号|款号|SKU)\s*[:：]?\s*([A-Za-z0-9_-]+)/i], skuText || bodyText);
        // data-sku-id 也可能只是颜色/尺码按钮的值，并不代表一条完整 SKU。
        // 旧 CDP 采集器不再从可见按钮拼出当前组合；完整列表只能来自页面状态。
        const items = [];

        // 现代淘宝会把 SKU 表放进 application/json 或全局初始化状态，DOM 只保留当前选中项。
        // 把带有 SKU 关键字段的紧凑子树交给后端继续规范化，避免把整份页面状态塞进结果。
        const compactSku = (value, depth = 0) => {
            if (depth > 5 || value === null || value === undefined) return value;
            if (Array.isArray(value)) return value.slice(0, 300).map((item) => compactSku(item, depth + 1));
            if (typeof value !== 'object') return value;
            const output = {};
            for (const [key, child] of Object.entries(value).slice(0, 80)) {
                if (depth > 0 && !/(?:sku|prop|spec|variant|stock|price|image|pic|id|value|name|list|map|item|path|quantity|inventory|available|text|summary|data)/i.test(key)) continue;
                output[key] = compactSku(child, depth + 1);
            }
            return output;
        };
        const embeddedCandidates = [];
        const visitedSkuStates = new WeakSet();
        let visitedSkuStateCount = 0;
        const visitSkuState = (value, depth = 0) => {
            if (!value || typeof value !== 'object' || depth > 5 || embeddedCandidates.length >= 24 || visitedSkuStateCount >= 5000) return;
            if (visitedSkuStates.has(value)) return;
            visitedSkuStates.add(value);
            visitedSkuStateCount += 1;
            const keys = Object.keys(value);
            if (keys.some((key) => /^(?:sku|skuMap|skuList|skus|skuBase|skuProps|skuInfo|sku2info|variants|properties)$/i.test(key))) {
                const candidate = compactSku(value);
                const size = (() => { try { return JSON.stringify(candidate).length; } catch (error) { return 999999; } })();
                if (size <= 240000) embeddedCandidates.push(candidate);
            }
            for (const child of Object.values(value).slice(0, 100)) visitSkuState(child, depth + 1);
        };
        for (const script of [...document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script#__INITIAL_STATE__')]) {
            try { visitSkuState(JSON.parse(script.textContent || ''), 0); } catch (error) {}
        }
        for (const key of ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'g_config', 'TShop', 'iDetail']) {
            try { visitSkuState(window[key], 0); } catch (error) {}
        }
        const embedded = embeddedCandidates.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0] || null;
        const sku = {
            available: Boolean((skuRoot || genericSkuRows.length || embedded) && (specs.length || items.length || skuText || skuId || embedded)),
            id: skuId,
            text: skuText,
            specs,
            items,
            itemCount: items.length || specs.reduce((count, item) => count + item.values.length, 0),
            embedded,
            source: embedded ? 'page-state-and-dom' : 'page-dom',
        };
        return {
            product: {
                title: usableTitleCandidates.find((value) => value.length >= 8) || '',
                store,
                price: find([/(?:售价|价格|券后价|到手价)\s*[:：]?\s*[¥￥]?\s*([0-9]+(?:\.[0-9]+)?)/i, /[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/i]),
                rating: find([/(?:店铺评分|宝贝评分|商品评分|描述相符)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/i]) || storeRating,
                reviewCount: find([/(?:累计评价|评价总数|评论数|用户评价)\s*[·.]?\s*([0-9.万千kK+]+)/i]),
                positiveRate: find([/近\s*3\s*个月好评率(?:高达)?\s*([0-9.]+%?)/i, /(?:好评率|正向评价)\s*[:：]?\s*([0-9.]+%?)/i]),
                sales: find([/(?:已售|销量|成交|付款人数)\s*[:：]?\s*([0-9.万千kK+]+)/i]),
                sku: sku.id || '',
            },
            mainImages,
            // `images` remains as a compatibility alias for older imported results.
            images: mainImages,
            sku,
            rawText: bodyText,
        };
    });
}

async function clickTab(client, labels) {
    return evaluate(client, (wanted) => {
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('a,button,[role="tab"],[class*="tabTitle"],[class*="TabItem"],[class*="askAnswerTitle"],[data-tab],[data-role="tab"],div,span')]
            .map((element) => ({ element, text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() }))
            .filter((item) => item.text && item.text.length <= 32 && wanted.some((label) => item.text === label || item.text.includes(label)))
            .sort((a, b) => {
                const exactA = wanted.includes(a.text) ? 0 : 1;
                const exactB = wanted.includes(b.text) ? 0 : 1;
                return exactA - exactB || a.text.length - b.text.length;
            });
        const target = candidates[0]?.element;
        if (!target) return false;
        if (!visible(target)) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
    }, labels);
}

async function revealBottomContent(client) {
    await evaluate(client, async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const scrollables = () => [...document.querySelectorAll('*')]
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return visible(element) && /(auto|scroll)/i.test(style.overflowY || '') && element.scrollHeight > element.clientHeight + 40;
            })
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        for (let step = 0; step < 18; step += 1) {
            window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.82)));
            for (const element of scrollables().slice(0, 6)) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(500, element.clientHeight * 0.82));
            await wait(180);
        }
        window.scrollTo(0, Math.max(0, document.body?.scrollHeight || 0));
        await wait(500);
        return true;
    });
    await delay(700);
}

async function collectReviews(client) {
    return evaluate(client, async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const normalize = (value, limit = 1800) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const datePattern = /20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}/;
        const reviewMarkerPattern = /用户评价|累计评价|评价|评论|晒图|买家秀|质量|清晰|质感|包装|发货|客服/i;
        const getImageUrl = (image) => {
            if (!image) return '';
            const lazy = image.dataset?.src || image.dataset?.original || image.dataset?.lazySrc || image.dataset?.ksLazyload || image.getAttribute?.('data-imgurl') || '';
            return lazy || image.currentSrc || image.src || '';
        };
        const reviewRoot = () => {
            const candidates = [...document.querySelectorAll('[role="dialog"], [role="region"], [class*="dialog"], [class*="Dialog"], [class*="drawer"], [class*="Drawer"], [class*="modal"], [class*="Modal"], [class*="review"], [class*="Review"], [class*="rate"], [class*="Rate"], [id*="review"], [id*="rate"]')]
                .filter(visible)
                .filter((element) => {
                    const text = normalize(element.innerText || '', 14000);
                    return datePattern.test(text) && reviewMarkerPattern.test(text);
                });
            const score = (element) => {
                const text = normalize(element.innerText || '', 14000);
                const dates = (text.match(/20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}/g) || []).length;
                const marker = `${element.id || ''} ${element.className || ''}`;
                const classHint = /(?:review|rate|comment)/i.test(marker) ? 1400 : 0;
                const dialogHint = element.getAttribute('role') === 'dialog' ? 900 : 0;
                return dates * 1200 + classHint + dialogHint + Math.min(text.length, 12000) / 20;
            };
            return candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
        };
        let root = reviewRoot();
        const toReview = (element) => {
            const rawText = normalize(element?.innerText || element?.textContent || '', 3000);
            if (rawText.length < 10 || /近\s*3\s*个月好评率|用户评价[·.]|查看全部评价|暂无评价/.test(rawText)) return null;
            const rawLines = String(element?.innerText || '').split(/\n+/).map((line) => normalize(line, 500)).filter(Boolean);
            const authorNode = element.querySelector?.('[class*="user"], [class*="User"], [class*="nick"], [class*="Nick"], [class*="name"], [class*="Name"]');
            const dateNode = element.querySelector?.('time, [class*="date"], [class*="Date"], [class*="time"], [class*="Time"]');
            const ratingNode = element.querySelector?.('[class*="star"], [class*="Star"], [class*="rate"], [class*="Rate"]');
            const ratingText = normalize(ratingNode?.getAttribute?.('aria-label') || ratingNode?.title || ratingNode?.innerText || '', 60);
            const bodyNodes = [...(element.querySelectorAll?.('[class*="content"], [class*="Content"], [class*="body"], [class*="Body"], [class*="text"], [class*="Text"], [class*="comment"], [class*="Comment"], [data-role*="content"], [data-testid*="content"]') || [])]
                .map((node) => ({ node, text: normalize(node.innerText || node.textContent || '', 1800), marker: `${node.className || ''} ${node.getAttribute?.('data-role') || ''} ${node.getAttribute?.('data-testid') || ''}` }))
                .filter((item) => item.text.length >= 10 && item.text.length <= 1800 && !/用户评价|查看全部评价|暂无评价/.test(item.text))
                .sort((left, right) => {
                    const score = (item) => (/content|body|comment|text/i.test(item.marker) ? 1000 : 0) - item.text.length / 8;
                    return score(right) - score(left);
                });
            const date = normalize(dateNode?.innerText || rawText.match(datePattern)?.[0] || '', 50);
            const author = normalize(authorNode?.innerText || rawLines.find((line) => line.length <= 30 && !datePattern.test(line) && !/已购|购买|评价|评论|用户|回复|点赞|有用/.test(line)) || '', 100);
            const ignoredLine = (line) => datePattern.test(line) || /^(?:用户评价|累计评价|查看全部评价|更多评价|追评|回复|有用|点赞|已购|购买|默认|匿名用户|全部)$/i.test(line) || /^(?:\[[^\]]+\]|规格|颜色|尺寸|款式)/.test(line) || /(?:影楼专供|(?:\d+\s*(?:寸|cm)).*(?:黑色|白色|晶瓷|哑光)|(?:黑色|白色|晶瓷|哑光).*(?:\d+\s*(?:寸|cm)))/i.test(line);
            const fallbackContent = rawLines.filter((line) => !ignoredLine(line) && line !== author && line.length >= 8).slice(-3).join(' ');
            const content = normalize(bodyNodes[0]?.text || fallbackContent || rawText, 1800);
            if (content.length < 10 || /近\s*3\s*个月好评率|用户评价[·.]|查看全部评价|暂无评价/.test(content)) return null;
            const images = [...(element.querySelectorAll?.('img') || [])].map(getImageUrl).filter((url, index, list) => /^https?:/i.test(url) && list.indexOf(url) === index).slice(0, 20);
            const hasReviewSignal = Boolean(date || bodyNodes.length || images.length || reviewMarkerPattern.test(content));
            if (!hasReviewSignal) return null;
            const rating = ratingText.match(/([1-5])(?:\.0)?\s*(?:星|分)/)?.[1] || rawText.match(/([1-5])(?:\.0)?\s*星/)?.[1] || '';
            return {
                content,
                text: content,
                author,
                date,
                rating,
                images,
                id: element.getAttribute?.('data-review-id') || element.getAttribute?.('data-rate-id') || element.getAttribute?.('data-comment-id') || element.getAttribute?.('data-id') || '',
            };
        };
        const collectVisible = () => {
            const selectors = [
                '[class*="Comment--"]', '[class*="commentItem"]', '[class*="CommentItem"]',
                '[class*="review-item"]', '[class*="ReviewItem"]', '[class*="rate-item"]',
                '[class*="RateItem"]', '[id*="review"] li', '[id*="rate"] li', '[class*="review"] li',
                '[class*="comment"] li', '[class*="Comment"] li',
                '[data-review-id]', '[data-rate-id]', '[data-comment-id]', '[role="listitem"]',
                'article', 'li',
            ];
            const elements = selectors.flatMap((selector) => [...root.querySelectorAll(selector)]).filter(visible);
            const source = [...new Set(elements)].filter((element) => {
                const text = normalize(element.innerText || '', 2600);
                return text.length >= 10 && (datePattern.test(text) || /评价|评论|晒图|质量|清晰|质感|包装|发货/.test(text));
            });
            const seen = new Set();
            const rows = [];
            for (const element of source.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)) {
                const row = toReview(element);
                if (!row) continue;
                const key = row.id || `${row.author}|${row.date}|${row.content}`;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
            }
            return rows;
        };
        const scrollables = () => [root, ...root.querySelectorAll('*')]
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return visible(element) && /(auto|scroll)/i.test(style.overflowY || '') && element.scrollHeight > element.clientHeight + 40;
            })
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const clickMore = () => {
            const candidates = [...root.querySelectorAll('button,a,[role="button"]')]
                .filter(visible)
                .filter((element) => /查看全部评价|更多评价|展开评价|查看更多评价|展开全部|加载更多评价|加载更多/.test(normalize(element.innerText || element.textContent || '', 100)))
                .filter((element) => element.dataset.xiaomeiCollectorClicked !== '1')
                .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
            if (!candidates.length) return false;
            candidates[0].dataset.xiaomeiCollectorClicked = '1';
            candidates[0].click();
            return true;
        };
        const clickNext = () => {
            const candidates = [...root.querySelectorAll('button,a,[role="button"]')]
                .filter(visible)
                .filter((element) => /^(?:下一页|下页|下一组|更多|next|›|>)$/i.test(normalize(element.innerText || element.textContent || '', 30)))
                .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !/disabled|disable/i.test(element.className || ''));
            if (!candidates.length) return false;
            candidates[0].click();
            return true;
        };
        const map = new Map();
        let pageCount = 1;
        let noChangeRounds = 0;
        clickMore();
        await wait(500);
        root = reviewRoot();
        let bottomRounds = 0;
        for (let round = 0; round < 80 && map.size < 200; round += 1) {
            const before = map.size;
            for (const row of collectVisible()) {
                const key = row.id || `${row.author}|${row.date}|${row.content}`;
                if (!map.has(key)) map.set(key, row);
            }
            noChangeRounds = map.size === before ? noChangeRounds + 1 : 0;
            const step = Math.max(420, Math.floor(window.innerHeight * 0.74));
            window.scrollBy(0, step);
            const targets = scrollables().slice(0, 8);
            for (const element of targets) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(420, element.clientHeight * 0.74));
            await wait(320);
            const atBottom = targets.some((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 24) || window.scrollY + window.innerHeight >= document.body.scrollHeight - 24;
            if (atBottom && noChangeRounds >= 2) {
                if (clickMore()) { noChangeRounds = 0; await wait(650); continue; }
                if (clickNext()) { pageCount += 1; noChangeRounds = 0; bottomRounds = 0; await wait(800); continue; }
                bottomRounds += 1;
            }
            if (bottomRounds >= 2) break;
        }
        const rows = [...map.values()].slice(0, 200);
        return {
            items: rows,
            sampleCount: rows.length,
            pageCount,
            hasMore: Boolean(map.size >= 200 || pageCount > 1),
            rootTextLength: normalize(root.innerText || '', 14000).length,
        };
    });
}

async function collectQuestions(client) {
    return evaluate(client, async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const normalize = (value, limit = 1600) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const questionPattern = /[？?]/;
        const questionMarker = /问大家|问答|买家提问|提问|回答|问题/i;
        const questionRoot = () => {
            const candidates = [...document.querySelectorAll('[role="dialog"], [role="region"], [class*="dialog"], [class*="Dialog"], [class*="drawer"], [class*="Drawer"], [class*="modal"], [class*="Modal"], [class*="question"], [class*="Question"], [class*="ask"], [class*="Ask"], [class*="qa"], [class*="Qa"], [id*="question"], [id*="ask"]')]
                .filter(visible)
                .filter((element) => {
                    const text = normalize(element.innerText || '', 14000);
                    return questionMarker.test(text) && (questionPattern.test(text) || /暂无问答|暂无问题/.test(text));
                });
            const score = (element) => {
                const text = normalize(element.innerText || '', 14000);
                const questionCount = (text.match(/[？?]/g) || []).length;
                const marker = `${element.id || ''} ${element.className || ''}`;
                return questionCount * 900 + (/question|ask|qa/i.test(marker) ? 1500 : 0) + (element.getAttribute('role') === 'dialog' ? 800 : 0) + Math.min(text.length, 12000) / 20;
            };
            return candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
        };
        let root = questionRoot();
        const questionFromLines = (lines) => {
            const cleanLines = lines.map((line) => normalize(line, 1400)).filter((line) => line && !/^(问大家|问答|更多回答|查看全部问答|查看更多问答|下一页|上一页|提问)$/i.test(line));
            for (let index = 0; index < cleanLines.length; index += 1) {
                const line = cleanLines[index].replace(/^(?:问题|问|买家提问)\s*[:：]\s*/i, '').trim();
                if (!questionPattern.test(line) || line.length < 4) continue;
                const answer = cleanLines.slice(index + 1, index + 3).find((candidate) => !questionPattern.test(candidate) && !/^(?:回答|商家回复|查看更多|有用|点赞)/i.test(candidate)) || '';
                return { question: line, answer, text: [line, answer].filter(Boolean).join(' ') };
            }
            return null;
        };
        const toQuestion = (element) => {
            const raw = String(element.innerText || element.textContent || '');
            const rawText = normalize(raw, 2600);
            if (rawText.length < 4 || /^(问大家|问答|更多回答|查看全部问答)$/.test(rawText)) return null;
            const questionNode = element.querySelector?.('[class*="question"][title], [class*="Question"][title], [class*="question"], [class*="Question"], [data-role*="question"], [data-testid*="question"]');
            const answerNode = element.querySelector?.('[class*="answer"][title], [class*="Answer"][title], [class*="answer"], [class*="Answer"], [data-role*="answer"], [data-testid*="answer"]');
            const parsed = questionFromLines(raw.split(/\n+/));
            const question = normalize(questionNode?.getAttribute('title') || questionNode?.getAttribute('aria-label') || questionNode?.innerText || parsed?.question || '', 1200);
            const answer = normalize(answerNode?.getAttribute('title') || answerNode?.getAttribute('aria-label') || answerNode?.innerText || parsed?.answer || '', 1200);
            if (!question || question.length < 4 || !questionPattern.test(question) || /^(问大家|问答|更多回答|查看全部问答)$/.test(question)) return null;
            return {
                question,
                answer,
                text: [question, answer].filter(Boolean).join(' '),
                id: element.getAttribute?.('data-question-id') || element.getAttribute?.('data-ask-id') || element.getAttribute?.('data-qa-id') || element.getAttribute?.('data-id') || '',
            };
        };
        const collectVisible = () => {
            const selectors = [
                '[class*="askAnswerItem"]', '[class*="AskAnswerItem"]', '[class*="question-item"]',
                '[class*="QuestionItem"]', '[class*="qa-item"]', '[class*="QaItem"]',
                '[class*="ask"] li', '[class*="Ask"] li', '[id*="question"] li', '[id*="ask"] li',
                '[data-question-id]', '[data-ask-id]', '[data-qa-id]', '[role="listitem"]', 'article', 'li',
            ];
            const elements = selectors.flatMap((selector) => [...root.querySelectorAll(selector)]).filter(visible);
            const source = [...new Set(elements)].filter((element) => {
                const text = normalize(element.innerText || '', 2600);
                const marker = `${element.id || ''} ${element.className || ''}`;
                return text.length >= 4 && (questionPattern.test(text) || questionMarker.test(marker));
            });
            const rows = [];
            const seen = new Set();
            for (const element of source.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)) {
                const row = toQuestion(element);
                if (!row) continue;
                const key = row.id || row.question;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
            }
            const pageText = String(root.innerText || document.body?.innerText || '');
            const marker = pageText.match(/(?:问大家|问答|买家提问)[^\n]*\n([\s\S]*?)(?=\n(?:参数信息|图文详情|本店推荐|看了又看|商品详情|评价))/i);
            const markerLines = marker?.[1] ? marker[1].split(/\n+/) : [];
            for (let index = 0; index < markerLines.length; index += 1) {
                const parsed = questionFromLines(markerLines.slice(index, index + 4));
                if (!parsed) continue;
                const key = parsed.question;
                if (!seen.has(key)) { rows.push(parsed); seen.add(key); }
            }
            return rows;
        };
        const scrollables = () => [root, ...root.querySelectorAll('*')]
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return visible(element) && /(auto|scroll)/i.test(style.overflowY || '') && element.scrollHeight > element.clientHeight + 40;
            })
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const clickMore = () => {
            const candidates = [...root.querySelectorAll('button,a,[role="button"]')]
                .filter(visible)
                .filter((element) => /查看全部问答|更多回答|查看更多问答|展开全部问答|加载更多问答|加载更多|下一页/.test(normalize(element.innerText || element.textContent || '', 100)))
                .filter((element) => element.dataset.xiaomeiCollectorClicked !== '1')
                .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
            if (!candidates.length) return false;
            candidates[0].dataset.xiaomeiCollectorClicked = '1';
            candidates[0].click();
            return true;
        };
        const clickNext = () => {
            const candidates = [...root.querySelectorAll('button,a,[role="button"]')]
                .filter(visible)
                .filter((element) => /^(?:下一页|下页|下一组|next|›|>)$/i.test(normalize(element.innerText || element.textContent || '', 30)))
                .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !/disabled|disable/i.test(element.className || ''));
            if (!candidates.length) return false;
            candidates[0].click();
            return true;
        };
        const map = new Map();
        let pageCount = 1;
        let noChangeRounds = 0;
        clickMore();
        await wait(500);
        root = questionRoot();
        let bottomRounds = 0;
        for (let round = 0; round < 200 && map.size < 2000; round += 1) {
            const before = map.size;
            for (const row of collectVisible()) {
                const key = row.id || row.question;
                if (!map.has(key)) map.set(key, row);
            }
            noChangeRounds = map.size === before ? noChangeRounds + 1 : 0;
            const step = Math.max(420, Math.floor(window.innerHeight * 0.74));
            window.scrollBy(0, step);
            const targets = scrollables().slice(0, 8);
            for (const element of targets) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(420, element.clientHeight * 0.74));
            await wait(320);
            const atBottom = targets.some((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 24) || window.scrollY + window.innerHeight >= document.body.scrollHeight - 24;
            if (atBottom && noChangeRounds >= 2) {
                if (clickMore()) { noChangeRounds = 0; await wait(650); continue; }
                if (clickNext()) { pageCount += 1; noChangeRounds = 0; bottomRounds = 0; await wait(800); continue; }
                bottomRounds += 1;
            }
            if (bottomRounds >= 2) break;
        }
        const items = [...map.values()].slice(0, 2000);
        return { items, sampleCount: items.length, pageCount, hasMore: Boolean(map.size >= 2000 || pageCount > 1) };
    });
}

async function collectDetail(client) {
    return evaluate(client, async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const normalize = (value, limit = 30000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        const detailSelectors = [
            '#imageTextInfo-content', '#imageTextInfo-container', '#J_Detail', '#J_DivItemDesc', '#detail',
            '#description', '#desc', '[id*="imageTextInfo"]', '[id*="detail"]', '[id*="Detail"]',
            '[class*="detail-content"]', '[class*="DetailContent"]', '[class*="desc-content"]',
            '[class*="DescContent"]', '[class*="image-text"]', '[class*="ImageText"]',
        ];
        const candidateRoots = detailSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
            .filter(visible)
            .filter((element) => !/(review|comment|rate|sku|ask|question)/i.test(`${element.id || ''} ${element.className || ''}`));
        const detailRoot = candidateRoots.sort((left, right) => {
            const leftScore = left.querySelectorAll('img').length * 200 + normalize(left.innerText, 30000).length;
            const rightScore = right.querySelectorAll('img').length * 200 + normalize(right.innerText, 30000).length;
            return rightScore - leftScore;
        })[0] || null;
        const waitForImages = async () => {
            const roots = detailRoot ? [detailRoot] : [];
            const hydrate = () => {
                for (const root of roots) {
                    for (const image of [...root.querySelectorAll('img')]) {
                        const lazy = image.dataset?.src || image.dataset?.original || image.dataset?.lazySrc || image.dataset?.ksLazyload || image.getAttribute('data-imgurl') || '';
                        if (lazy && (!image.src || /(?:loading|placeholder|blank|transparent)/i.test(image.src))) image.src = lazy;
                    }
                }
            };
            if (!detailRoot) return;
            detailRoot.scrollIntoView({ block: 'start' });
            await wait(300);
            const scrollables = [...document.querySelectorAll('*')]
                .filter((element) => {
                    const style = window.getComputedStyle(element);
                    return detailRoot.contains(element) && visible(element) && /(auto|scroll)/i.test(style.overflowY || '') && element.scrollHeight > element.clientHeight + 40;
                })
                .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
            const totalHeight = Math.max(document.body?.scrollHeight || 0, detailRoot.scrollHeight || 0);
            const steps = Math.min(80, Math.max(10, Math.ceil(totalHeight / Math.max(450, window.innerHeight * 0.72))));
            for (let step = 0; step < steps; step += 1) {
                hydrate();
                window.scrollBy(0, Math.max(430, Math.floor(window.innerHeight * 0.72)));
                for (const element of scrollables.slice(0, 4)) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(430, element.clientHeight * 0.72));
                await wait(180);
            }
            hydrate();
            await wait(500);
        };
        await waitForImages();
        const imageUrl = (image) => {
            if (!image) return '';
            const dataValue = image.dataset?.src || image.dataset?.original || image.dataset?.lazySrc || image.dataset?.ksLazyload || image.getAttribute?.('data-imgurl') || '';
            const srcset = image.getAttribute?.('srcset') || image.getAttribute?.('data-srcset') || '';
            return dataValue || srcset.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop() || image.currentSrc || image.src || '';
        };
        const usefulImage = (image, value) => {
            const width = Number(image.naturalWidth || image.width || 0);
            const height = Number(image.naturalHeight || image.height || 0);
            if (width && height && (width < 120 || height < 120)) return false;
            return !/(?:avatar|headimg|favicon|s\.gif|loading|placeholder|icon[^a-z]|tb-icon|qrcode|qr-code|logo)/i.test(value);
        };
        const roots = detailRoot ? [detailRoot] : [];
        const images = [];
        const add = (value) => {
            try {
                const absolute = new URL(value, location.href).href;
                if (/^https?:/i.test(absolute) && !images.includes(absolute)) images.push(absolute);
            } catch (error) {}
        };
        for (const root of roots) {
            for (const image of [...root.querySelectorAll('img')]) {
                const value = imageUrl(image);
                if (value && usefulImage(image, value)) add(value);
            }
            for (const element of [...root.querySelectorAll('[style*="background-image"], [data-background]')]) {
                const styleValue = element.getAttribute('data-background') || element.style.backgroundImage || '';
                const match = styleValue.match(/url\(["']?([^"')]+)["']?\)/i);
                if (match?.[1]) add(match[1]);
            }
        }
        const candidates = roots.map((root) => normalize(root.innerText || root.textContent || '', 30000)).filter((value) => value.length >= 20);
        const fallbackText = [...document.querySelectorAll('[class*="detail"], [class*="desc"], [id*="detail"], [id*="desc"]')]
            .filter(visible)
            .map((element) => normalize(element.innerText, 30000))
            .filter((value) => value.length >= 20)
            .sort((a, b) => b.length - a.length)[0] || '';
        const text = candidates[0] || (images.length ? `图文详情以图片内容为主，已读取 ${images.length} 张详情图片。` : fallbackText);
        const sections = text ? [{ title: '图文详情可见内容', text, score: null }] : [];
        return { text, sections, images: images.slice(0, 240), imageCount: images.length };
    });
}

async function main() {
    if (!/^https?:\/\//i.test(targetUrl)) throw new Error('商品链接不是有效的 http(s) 地址');
    const page = await ensureBrowser();
    const client = await connectPage(page);
    activeSocket = client.socket;
    await navigate(client, targetUrl);
    const first = await waitForProduct(client);
    if (first?.challenge || first?.authWallDetected) {
        output({ ok: false, status: first.waitTimeout ? 'login_required' : 'challenge', message: first.waitTimeout ? '等待扫码/登录超时；可见 Edge 窗口已保留，请完成后点击重试' : '页面触发安全验证，请在可见 Edge 中完成验证后自动继续' });
        activeSocket.close();
        return;
    }
    if (!first?.productReady) {
        output({ ok: false, status: first.waitTimeout && first.authWallDetected ? 'login_required' : 'timeout', message: first.waitTimeout && first.authWallDetected ? '等待扫码/登录超时；可见 Edge 窗口已保留，请完成后点击重试' : '商品页没有返回可采集内容，请在可见 Edge 中检查后重试' });
        activeSocket.close();
        return;
    }
    await delay(500);
    await waitForUsefulTitle(client);
    const actionTrace = [];
    const base = await collectBase(client);
    const initialQuestions = await collectQuestions(client);
    actionTrace.push({ action: 'inspect', module: 'product', target: '商品页', status: 'completed' });
    actionTrace.push({ action: 'scroll', module: 'page', target: '商品页', status: 'completed' });
    const videosReady = await clickTab(client, ['视频', '主图视频', '商品视频']);
    actionTrace.push({ action: 'click_tab', module: 'videos', target: '视频', status: videosReady ? 'clicked' : 'missing' });
    if (videosReady) await delay(1200);
    const videoBase = await collectBase(client);
    if (videoBase?.videos?.length) base.videos = videoBase.videos;
    const reviewsReady = await clickTab(client, ['用户评价', '累计评价', '评价']);
    actionTrace.push({ action: 'click_tab', module: 'reviews', target: '用户评价', status: reviewsReady ? 'clicked' : 'missing' });
    if (reviewsReady) await delay(1200);
    const reviewResult = await collectReviews(client);
    const reviews = Array.isArray(reviewResult) ? reviewResult : (reviewResult?.items || []);
    const detailReady = await clickTab(client, ['图文详情', '详情']);
    actionTrace.push({ action: 'click_tab', module: 'detail', target: '图文详情', status: detailReady ? 'clicked' : 'missing' });
    if (detailReady) await delay(1200);
    const detail = await collectDetail(client);
    await waitForUsefulTitle(client);
    const refreshedBase = await collectBase(client);
    if (refreshedBase?.product) {
        for (const [key, value] of Object.entries(refreshedBase.product)) {
            if (!base.product?.[key] && value) base.product[key] = value;
        }
    }
    const mergeSku = (left, right) => {
        const first = left && typeof left === 'object' ? left : {};
        const second = right && typeof right === 'object' ? right : {};
        const merged = { ...first, ...second };
        if ((first.specs?.length || 0) > (second.specs?.length || 0)) merged.specs = first.specs;
        if ((first.items?.length || 0) > (second.items?.length || 0)) merged.items = first.items;
        merged.items = (Array.isArray(merged.items) ? merged.items : []).filter((item) => {
            if (!item || typeof item !== 'object') return false;
            const id = String(item.id || item.skuId || item.sku_id || '').trim();
            const path = String(item.propPath || item.prop_path || item.propertyPath || '').trim();
            const specs = Array.isArray(item.specs) ? item.specs.some((spec) => spec && (spec.value || spec.name)) : String(item.specs || item.specText || '').trim();
            return Boolean(id && (path || specs));
        });
        if (String(first.text || '').length > String(second.text || '').length) merged.text = first.text;
        if (!second.embedded && first.embedded) merged.embedded = first.embedded;
        merged.available = Boolean(merged.available || merged.specs?.length || merged.items?.length || merged.text || merged.id || merged.embedded);
        merged.itemCount = merged.items?.length || merged.itemCount || merged.specs?.reduce((count, item) => count + (item.values?.length || 0), 0) || 0;
        return merged;
    };
    const structuredSku = await evaluate(client, collectDabiSkuState.toString()).catch(() => ({}));
    base.sku = mergeSku(structuredSku, base.sku);
    base.sku = mergeSku(base.sku, refreshedBase?.sku);
    const questionsReady = await clickTab(client, ['问大家', '问答']);
    actionTrace.push({ action: 'click_tab', module: 'questions', target: '问大家', status: questionsReady ? 'clicked' : 'missing' });
    if (questionsReady) await delay(1200);
    if (!questionsReady) await revealBottomContent(client);
    const questionResult = await collectQuestions(client);
    const questionItems = Array.isArray(questionResult) ? questionResult : (questionResult?.items || []);
    const questionMap = new Map();
    for (const item of [...(Array.isArray(initialQuestions) ? initialQuestions : (initialQuestions?.items || [])), ...questionItems]) {
        if (item?.question && !questionMap.has(item.question)) questionMap.set(item.question, item);
    }
    const questions = [...questionMap.values()].slice(0, 2000);
    const finalBase = await collectBase(client);
    if (finalBase?.product) {
        for (const [key, value] of Object.entries(finalBase.product)) {
            if (!base.product?.[key] && value) base.product[key] = value;
        }
    }
    base.sku = mergeSku(base.sku, finalBase?.sku);
    const skuReady = await clickTab(client, ['参数信息', '规格', 'SKU']);
    actionTrace.push({ action: 'click_tab', module: 'sku', target: '参数信息', status: skuReady ? 'clicked' : 'missing' });
    const liveStructuredSku = await evaluate(client, collectDabiSkuState.toString()).catch(() => ({}));
    const lastBase = await collectBase(client);
    base.sku = mergeSku(liveStructuredSku, mergeSku(base.sku, lastBase?.sku));
    if (lastBase?.videos?.length) base.videos = [...new Map([...(base.videos || []), ...lastBase.videos].map((item) => [typeof item === 'string' ? item : item.url, item])).values()].slice(0, 20);
    const mainImages = filterDabiMainImages(base.mainImages || base.images || [], 5);
    const reviewCount = reviews.length;
    const totalReviewCount = base.product?.reviewCount || refreshedBase?.product?.reviewCount || finalBase?.product?.reviewCount || '';
    output({
        ok: true,
        status: 'ready',
        source: 'browser',
        product: base.product || {},
        mainImages,
        // Keep the old field for manually imported results and older frontends.
        images: mainImages,
        videos: base.videos || [],
        sku: base.sku || { available: false, specs: [], items: [] },
        reviews,
        questions,
        detail,
        rawText: String(base.rawText || '').slice(0, 16000),
        reviewStats: {
            sampleCount: reviewCount,
            totalCount: totalReviewCount,
            pageCount: reviewResult?.pageCount || 1,
            questionPageCount: questionResult?.pageCount || 1,
            hasMoreReviews: Boolean(reviewResult?.hasMore),
            hasMoreQuestions: Boolean(questionResult?.hasMore),
        },
        questionStats: {
            sampleCount: questions.length,
            pageCount: questionResult?.pageCount || 1,
            hasMore: Boolean(questionResult?.hasMore),
        },
        collection: {
            mode: 'visible-page-cdp',
            actionTrace,
            pageCounts: { reviews: reviewResult?.pageCount || 1, questions: questionResult?.pageCount || 1 },
            samples: { reviews: reviews.length, questions: questions.length, detailImages: detail?.images?.length || 0, videos: base.videos?.length || 0 },
        },
    });
    activeSocket.close();
}

main().catch((error) => {
    output({ ok: false, status: 'unavailable', error: String(error?.message || error) });
    try { activeSocket?.close(); } catch (closeError) {}
});
