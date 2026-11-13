/* 小美画布 ⇄ X6 适配层
 *
 * 这一层只做一件事：在「旧画布 JSON」和「X6 cell」之间做无损翻译。
 * 它不认识 DOM，不创建 Graph，不碰任何 X6 实例状态——只接收一个普通对象、
 * 返回一个普通对象。这样它既能被引擎调用，也能在测试里脱离浏览器直接跑。
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────────
 * 1. 无损往返。旧节点有 40+ 个字段（runSettings / promptDraftHtml /
 *    batchDetailOwnerId / retouchOwnerId …），适配层不认识的字段一律原样存进
 *    data.legacy，导出时展开回顶层。字段白名单是反模式：新加字段会被静默丢弃。
 * 2. 坐标不取整。旧数据里存在 -940.7944 这种浮点坐标，取整会让每次
 *    「保存→重载」累积漂移。X6 接受浮点，没有理由在这里损失精度。
 * 3. 端口必须存在。X6 在 fromJSON 时会把目标端口不存在的边整条丢掉，
 *    所以端口集不能只按节点类型猜，必须并入「实际入边用到的槽位」。
 *
 * ── 节点迁移复用文档内核 ────────────────────────────────────────────
 * 旧数据里的类型不是最终类型：空 smart-image 会退化成 smart-upload，
 * runSettings.apiKind==='video' 的 smart-paint 会变成 smart-video，
 * smart-container 会拆成 smart-image。这套规则已经写在
 * xiaomei-document-kernel.js 的 adopt() 里，这里直接复用，不复制第二份，
 * 否则两条渲染路径迟早对同一份数据给出不同结论。
 */
(function (root) {
    'use strict';

    var docKernel = root.XiaomeiDocumentKernel;

    /* ---------- 尺寸常量 ----------
     * 取自 smart-canvas.js 的真实空节点尺寸（:2872-2882），
     * 目的只是让「没有 w/h 的节点」画出来大小合理，不追求与正式布局逐像素相等。
     * 正式布局 imageLayout() 里混着十几种节点专属分支（分组缩略图、颜色预览、
     * 生成中布局…），把它整体复制过来只会得到一份会漂移的影子实现。
     * 需要逐像素一致时，由调用方通过 options.sizeOf 注入页面自己的布局函数，
     * 见 sizeFor() 的注释。 */
    var EMPTY_UPLOAD_W = 316;
    var EMPTY_UPLOAD_H = 194;
    var EMPTY_PAINT_W = 300;
    var EMPTY_PAINT_H = 300;
    var MEDIA_PAD = 32;          /* 多图节点 CSS 每边 16px 内边距 */
    var MEDIA_GAP = 8;
    var THUMB_BASE = 224;        /* MEDIA_GROUP_THUMB_BASE */
    var MAX_VISIBLE_ROWS = 3;    /* MEDIA_GROUP_MAX_VISIBLE_ROWS */

    /* 分组：默认 340×286，最小 150×130，历史遗留高度 220 视为「没设过」
       （旧实现 smartGroupLayoutSize() 就是这么判的）。
       这三个数不是随手取的——分组卡片里还有标题栏和成员摘要，
       比图片本身高出一截，用图片尺寸套会让分组看起来被压扁。 */
    var GROUP_DEFAULT_W = 340;
    var GROUP_DEFAULT_H = 286;
    var GROUP_LEGACY_H = 220;
    var GROUP_MIN_W = 150;
    var GROUP_MIN_H = 130;

    var PROMPT_DEFAULT_W = 316;
    var PROMPT_DEFAULT_H = 292;
    var AGENT_DEFAULT_W = 430;
    var AGENT_DEFAULT_H = 640;
    /* 循环节点：配对模式（batchUiMode='paired'）宽 500，简洁模式 340。
       高度由内容实测得出，这里只是「节点上没有 h 时」的兜底。 */
    var LOOP_DEFAULT_W = 340;
    var LOOP_PAIRED_W = 500;
    var LOOP_DEFAULT_H = 1323;
    var COMPARE_W = 460;
    var COMPARE_H = 560;
    var CAMERA_W = 360;
    var CAMERA_H = 328;
    var COLOR_W = 380;
    var COLOR_H = 394;
    var COMFY_W = 430;
    var COMFY_H = 828;
    var FIDELITY_W = 980;
    var FIDELITY_H = 720;

    /* 旧节点类型 → X6 形状。
     * 只映射「画布渲染需要区分的形态」。业务语义（smart-loop 的循环、
     * smart-agent 的会话）由应用层负责，引擎不实现。 */
    var SHAPE_BY_TYPE = {
        'smart-upload': 'xm-upload',
        'smart-paint': 'xm-image',
        'smart-image': 'xm-image',
        'smart-video': 'xm-video',
        'smart-prompt': 'xm-prompt',
        'smart-group': 'xm-group',
        'smart-loop': 'xm-group',
        'smart-agent': 'xm-agent',
        'smart-comfy-workflow': 'xm-comfy',
        'smart-compare': 'xm-compare',
        'smart-product-fidelity': 'xm-image',
        'smart-color': 'xm-color',
        'smart-table': 'xm-table',
        'smart-timeline': 'xm-table',
        'smart-camera': 'xm-camera',
        'generator': 'xm-image'
    };

    /* 输入端口槽位 → 纵向比例。
     *
     * 正式画布里端口位置有两套互斥规则：`.node-port` 主输入固定 top:50%，
     * 而 `.ai-render-input-port[data-input-slot]` 的 white/style/product 三路
     * 是 24%/50%/76%。同一个节点不会同时显示主输入和三路槽位。
     *
     * 引擎这边端口是 X6 的 SVG 圆点，位置由自定义端口布局按 bbox 比例算，
     * 所以这里给的是「该槽位在节点左边的高度比例」。同一节点上出现多个槽位时
     * 必须纵向错开，否则三个端口叠在 0.5 处、指针无法区分（原型阶段踩过）。
     * 单槽位节点仍落在 0.5，与正式画布的主输入一致。 */
    var SLOT_RATIO = {
        '': 0.5,
        'target': 0.28,
        'reference': 0.5,
        'white': 0.24,
        'style': 0.5,
        'product': 0.76,
        'text': 0.62,
        'template': 0.36,
        'gift': 0.68
    };

    var SLOT_ORDER = ['', 'target', 'reference', 'white', 'style', 'product', 'text', 'template', 'gift'];

    /* ---------- 小工具 ---------- */

    function finite(value) {
        var number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function positive(value) {
        var number = finite(value);
        return number !== null && number > 0 ? number : null;
    }

    function round(value) {
        return Math.round(value);
    }

    function clone(value) {
        if (value == null || typeof value !== 'object') return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
    }

    function mediaList(node) {
        var images = node && Array.isArray(node.images) ? node.images : [];
        return images.filter(function (item) { return item && item.url; });
    }

    /* 视频判定：真实数据里没有 smart-video 类型，
       视频是 smart-paint/smart-image 带 runSettings.apiKind==='video'。
       文档内核的 adopt() 已经会把它们改成 smart-video，
       这里再兜一层，防止调用方跳过 adopt 直接喂原始数据。 */
    function isVideoNode(node) {
        if (!node) return false;
        if (node.type === 'smart-video') return true;
        if (node.productFidelityNode === true) return false;
        var kind = node.runSettings && node.runSettings.apiKind;
        return kind === 'video' && (node.type === 'smart-paint' || node.type === 'smart-image');
    }

    function shapeFor(node) {
        if (!node) return 'xm-image';
        if (isVideoNode(node)) return 'xm-video';
        return SHAPE_BY_TYPE[node.type] || 'xm-image';
    }

    function gridFor(count) {
        if (count <= 1) return { cols: 1, rows: 1 };
        if (count <= 4) return { cols: 2, rows: Math.ceil(count / 2) };
        return { cols: Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count)))), rows: 0 };
    }

    /* 共享布局内核（xiaomei-media-layout.js）里的尺寸推导。
     *
     * 懒查 root 上的全局而不是在 IIFE 顶部捕获：脚本加载顺序由页面决定，
     * 单元测试环境里也可能根本没有这个脚本。查不到就返回 null，
     * 由 sizeFor() 继续走按类型兜底——降级只是「尺寸略有出入」，不会崩。
     *
     * 传 `node.images` 原数组（不过滤空 url），因为旧画布的 nodeRect() 与
     * updateNodeElementDuringResize() 都是这么传的：一个只有自然尺寸、
     * 还没拿到 url 的占位项也会参与格子计算。过滤掉会让节点数变成 0，
     * 尺寸反而跳到空节点分支。 */
    function mediaLayoutFor(node) {
        var lib = root.XiaomeiMediaLayout;
        if (!lib || typeof lib.layoutFor !== 'function') return null;

        var layout;
        try {
            layout = lib.layoutFor(node, null);
        } catch (error) {
            return null;
        }
        if (!layout || !positive(layout.width) || !positive(layout.height)) return null;
        return { width: round(layout.width), height: round(layout.height) };
    }

    /* ---------- 尺寸推导 ----------
     * 优先级：调用方注入 > 共享布局内核 > 显式 w/h > 类型默认 > 图片内容推导。
     *
     * options.sizeOf(node, shape) 是给正式页面留的缝：smart-canvas.js 里的
     * imageLayout() 是模块内私有函数，没有导出，等引擎被挂进那个作用域时
     * （阶段 4），页面可以把自己的布局函数从这道缝里传进来，尺寸立刻与
     * 正式画布逐像素一致，而适配层不需要改一行。
     *
     * ── 为什么第二顺位是共享内核，而不是显式 w/h ──────────────────────
     * 旧画布的 imageLayout() 对「非 manualSize 的图片节点」会**忽略** w/h 重新
     * 推导——w/h 在生成中的占位框、历史版本迁移里都会被写入，所以它不能当成
     * 用户意图。如果这里先认 w/h，两条渲染路径就会在这些节点上分叉。
     * 共享内核（xiaomei-media-layout.js）原样保留了这条语义：只有
     * manualSize === true 才吃显式宽高。所以顺序必须是「内核在前」。
     *
     * 实测（tests/canvas-engine-parity.browser.cjs，1136 个真实节点）：
     *   仅按类型兜底        一致 491（43.2%），smart-paint 中位差 94×100px
     *   接入共享内核之后    见用例输出
     */
    function sizeFor(node, shape, options) {
        var opts = options || {};
        if (typeof opts.sizeOf === 'function') {
            var injected = opts.sizeOf(node, shape);
            if (injected && positive(injected.width) && positive(injected.height)) {
                return { width: round(injected.width), height: round(injected.height) };
            }
        }

        /* 图片路径（smart-upload / smart-paint / smart-video / smart-image /
           generator）交给共享内核。它只认这五类，其余返回 null 继续往下走。 */
        var media = mediaLayoutFor(node);
        if (media) return media;

        var explicitW = positive(node && node.w);
        var explicitH = positive(node && node.h);

        /* 分组与循环都画成 xm-group，但尺寸规则不同：
           分组有「最小尺寸」下限、且 220 这个历史默认高度要当成没设过；
           循环的宽度由 UI 模式决定（配对 500 / 简洁 340），高度靠内容实测。 */
        if (node && node.type === 'smart-loop') {
            var loopW = explicitW !== null && explicitW > 24
                ? round(explicitW)
                : (node.batchUiMode === 'paired' ? LOOP_PAIRED_W : LOOP_DEFAULT_W);
            return {
                width: loopW,
                height: explicitH !== null && explicitH > 24 ? round(explicitH) : LOOP_DEFAULT_H
            };
        }
        if (shape === 'xm-group') {
            return {
                width: explicitW !== null && explicitW >= GROUP_MIN_W ? round(explicitW) : GROUP_DEFAULT_W,
                height: explicitH === null || explicitH === GROUP_LEGACY_H
                    ? GROUP_DEFAULT_H
                    : round(Math.max(explicitH, GROUP_MIN_H))
            };
        }
        if (explicitW !== null && explicitH !== null) {
            return { width: round(explicitW), height: round(explicitH) };
        }

        if (shape === 'xm-prompt') {
            return { width: explicitW !== null ? round(explicitW) : PROMPT_DEFAULT_W,
                     height: explicitH !== null ? round(explicitH) : PROMPT_DEFAULT_H };
        }
        if (shape === 'xm-agent') {
            return { width: explicitW !== null ? round(explicitW) : AGENT_DEFAULT_W,
                     height: explicitH !== null ? round(explicitH) : AGENT_DEFAULT_H };
        }
        if (shape === 'xm-compare') {
            return { width: explicitW !== null ? round(explicitW) : COMPARE_W,
                     height: explicitH !== null ? round(explicitH) : COMPARE_H };
        }
        if (shape === 'xm-color') {
            return { width: explicitW !== null ? round(explicitW) : COLOR_W,
                     height: explicitH !== null ? round(explicitH) : COLOR_H };
        }
        if (shape === 'xm-camera') {
            return { width: explicitW !== null ? round(explicitW) : CAMERA_W,
                     height: explicitH !== null ? round(explicitH) : CAMERA_H };
        }
        if (shape === 'xm-comfy') {
            return { width: explicitW !== null ? round(explicitW) : COMFY_W,
                     height: explicitH !== null ? round(explicitH) : COMFY_H };
        }
        if (node && node.type === 'smart-product-fidelity') {
            return { width: explicitW !== null ? round(explicitW) : FIDELITY_W,
                     height: explicitH !== null ? round(explicitH) : FIDELITY_H };
        }
        if (node && node.type === 'smart-loop') {
            return { width: explicitW !== null ? round(explicitW) : LOOP_DEFAULT_W,
                     height: explicitH !== null ? round(explicitH) : LOOP_DEFAULT_H };
        }

        /* 图片类：按内容推导 */
        var list = mediaList(node);
        if (!list.length) {
            var isPaint = node && (node.type === 'smart-paint' || node.type === 'smart-video');
            return {
                width: explicitW !== null ? round(explicitW) : (isPaint ? EMPTY_PAINT_W : EMPTY_UPLOAD_W),
                height: explicitH !== null ? round(explicitH) : (isPaint ? EMPTY_PAINT_H : EMPTY_UPLOAD_H)
            };
        }

        if (list.length === 1) {
            var first = list[0];
            var naturalW = positive(first.natural_w) || positive(first.width);
            var naturalH = positive(first.natural_h) || positive(first.height);
            var boxW = explicitW !== null ? round(explicitW) : 340;
            if (!naturalW || !naturalH) {
                return { width: boxW, height: explicitH !== null ? round(explicitH) : round(boxW * 0.75) + MEDIA_PAD };
            }
            var innerH = round((boxW - MEDIA_PAD) * (naturalH / naturalW));
            return {
                width: boxW,
                height: explicitH !== null ? round(explicitH) : Math.max(160, innerH + MEDIA_PAD)
            };
        }

        var grid = gridFor(list.length);
        var cols = grid.cols;
        var rows = Math.ceil(list.length / cols);
        var visibleRows = Math.min(MAX_VISIBLE_ROWS, rows);
        var thumb = THUMB_BASE;
        var cell = thumb + MEDIA_GAP;
        var width = explicitW !== null ? round(explicitW) : cols * cell - MEDIA_GAP + MEDIA_PAD;
        var height = explicitH !== null ? round(explicitH) : visibleRows * cell - MEDIA_GAP + MEDIA_PAD;
        return { width: Math.max(200, width), height: Math.max(140, height) };
    }

    /* ---------- 端口 ---------- */

    function portIdForSlot(slot) {
        return slot ? 'in-' + slot : 'in';
    }

    /* 单槽位节点落在 0.5；多槽位节点按 SLOT_ORDER 的顺序在 0.2–0.8 之间铺开。
       这样既不会让两个端口叠在一起，也不会因为槽位名变化而整体跳动。 */
    function ratioForSlot(slot, slotCount) {
        if (slotCount <= 1) return 0.5;
        var base = SLOT_RATIO[slot];
        if (base === undefined) return 0.5;
        return base;
    }

    function portsFor(node, shape, extraSlots) {
        var items = [{ id: 'out', group: 'out', args: { side: 'right', ratio: 0.5 } }];

        /* 分组形状（smart-group / smart-loop）也必须有输入端口：
           真实数据里 loop 节点既被别的节点连入，也向外连出——
           loopPaired 在正式画布上本来就是「产品/参考/文本」三路输入 + 一个输出。
           只给 out 会让所有指向 loop 的边在装载时被 X6 丢掉。 */
        var slots = [''];
        (extraSlots || []).forEach(function (slot) {
            if (slots.indexOf(slot) === -1) slots.push(slot);
        });

        slots.sort(function (a, b) {
            var ia = SLOT_ORDER.indexOf(a);
            var ib = SLOT_ORDER.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });

        var count = slots.length;
        slots.forEach(function (slot) {
            items.push({
                id: portIdForSlot(slot),
                group: 'in',
                args: { side: 'left', ratio: ratioForSlot(slot, count), slot: slot }
            });
        });
        return items;
    }

    /* ---------- 旧画布 → X6 cells ---------- */

    function edgeKey(from, to, kind, slot) {
        return String(from) + '\u0000' + String(to) + '\u0000' + kind + '\u0000' + slot;
    }

    function toCells(doc, options) {
        var opts = options || {};
        var source = doc || {};

        /* 先过一遍文档内核的迁移，保证两条渲染路径对同一份数据给出同一个类型。
           没有内核时（单元测试环境）退化为原样使用。 */
        var adopted = source;
        if (docKernel && typeof docKernel.adopt === 'function' && opts.adopt !== false) {
            try {
                adopted = docKernel.adopt(source, {
                    profile: 'smart',
                    labels: opts.labels || {}
                }).document;
            } catch (error) {
                adopted = source;
            }
        }

        var nodes = Array.isArray(adopted.nodes) ? adopted.nodes : [];
        var connections = Array.isArray(adopted.connections) ? adopted.connections : [];

        var byId = Object.create(null);
        nodes.forEach(function (node) {
            if (node && node.id != null) byId[String(node.id)] = node;
        });

        /* 第一遍：收集每个目标节点实际被连到哪些槽位。
           X6 在装载时会把目标端口不存在的边整条丢弃，所以这一步不能省。 */
        var incoming = Object.create(null);
        var danglingEdges = 0;
        connections.forEach(function (conn) {
            if (!conn || conn.from == null || conn.to == null) { danglingEdges += 1; return; }
            var from = String(conn.from);
            var to = String(conn.to);
            if (!byId[from] || !byId[to]) { danglingEdges += 1; return; }
            if (!incoming[to]) incoming[to] = [];
            var slot = conn.input_slot || conn.inputSlot || '';
            if (incoming[to].indexOf(slot) === -1) incoming[to].push(slot);
        });

        /* 第二遍：分组父子关系。旧数据里组节点用 items 存成员 id，X6 用 parent。 */
        var parentOf = Object.create(null);
        nodes.forEach(function (node) {
            if (!node || !Array.isArray(node.items)) return;
            var parentId = String(node.id);
            node.items.forEach(function (childId) {
                var id = String(childId);
                if (id !== parentId && byId[id] && !parentOf[id]) parentOf[id] = parentId;
            });
        });

        var cells = [];
        var portCoerced = 0;

        /* 分组真实成员数：items 里能对上节点的才算。
           真实数据里 4 条 items 引用全部指向不存在的节点，
           所以这个值几乎总是 0——不要用它判断"分组是否为空"。 */
        var memberCountOf = Object.create(null);
        Object.keys(parentOf).forEach(function (childId) {
            var parentId = parentOf[childId];
            memberCountOf[parentId] = (memberCountOf[parentId] || 0) + 1;
        });

        nodes.forEach(function (node) {
            if (!node || node.id == null) return;
            var id = String(node.id);
            var shape = shapeFor(node);
            var size = sizeFor(node, shape, opts);
            var parent = parentOf[id] || null;
            var ports = portsFor(node, shape, incoming[id] || []);

            var data = {
                type: node.type || 'smart-image',
                shape: shape,
                title: node.title || '',
                images: Array.isArray(node.images) ? node.images : [],
                prompt: node.promptDraftText || node.runPrompt || '',
                running: Boolean(node.running),
                pending: Boolean(node.pending) || Number(node.pending) > 0,
                failed: Boolean(node.runError) || node.runStatus === 'failed',
                collapsed: Boolean(node.collapsed),
                memberCount: memberCountOf[id] || 0,
                /* 悬停工具栏默认关闭：每张卡 3 个按钮，500 节点就是 1500 个额外 DOM，
                   打开会让性能对照变成在测工具栏开销。 */
                tools: Boolean(node.tools),
                slotCount: ports.length - 1,
                /* 其余字段原样保留，导出时展开回顶层 */
                legacy: node
            };

            var cell = {
                id: id,
                shape: shape,
                x: finite(node.x) || 0,
                y: finite(node.y) || 0,
                width: size.width,
                height: size.height,
                zIndex: shape === 'xm-group' ? 1 : 2,
                data: data,
                ports: { items: ports }
            };
            if (parent) cell.parent = parent;
            cells.push(cell);
        });

        /* 第三遍：连线。边 id 用内容派生，保证「保存→重载」id 稳定，
           否则每次重载 id 全变，增量保存会退化成全量。 */
        var portIndex = Object.create(null);
        cells.forEach(function (cell) {
            var set = Object.create(null);
            cell.ports.items.forEach(function (port) { set[port.id] = true; });
            portIndex[cell.id] = set;
        });

        var seen = Object.create(null);
        var edges = [];
        connections.forEach(function (conn) {
            if (!conn || conn.from == null || conn.to == null) return;
            var from = String(conn.from);
            var to = String(conn.to);
            if (!byId[from] || !byId[to]) return;
            if (from === to) return;

            var slot = conn.input_slot || conn.inputSlot || '';
            var kind = conn.kind === 'flow' ? 'flow' : 'input';
            var targetPort = portIdForSlot(slot);

            /* 槽位端口不存在时降级到主输入，并记账——这是唯一会改变边的落点的地方 */
            var portsOfTarget = portIndex[to];
            if (!portsOfTarget || !portsOfTarget[targetPort]) {
                targetPort = 'in';
                if (slot) portCoerced += 1;
            }

            var key = edgeKey(from, to, kind, slot);
            var dup = seen[key] ? seen[key] + 1 : 0;
            seen[key] = dup;
            var edgeId = 'e:' + from + '>' + to + ':' + kind + ':' + (slot || '-') + (dup ? '#' + dup : '');

            edges.push({
                id: edgeId,
                shape: 'edge',
                source: { cell: from, port: 'out' },
                target: { cell: to, port: targetPort },
                zIndex: 0,
                data: { kind: kind, slot: slot, legacy: conn },
                router: { name: 'normal' },
                connector: { name: 'rounded', args: { radius: 12 } },
                attrs: {
                    line: {
                        stroke: kind === 'flow' ? 'var(--muted)' : 'var(--strong)',
                        strokeWidth: 1.6,
                        strokeDasharray: kind === 'flow' ? '5 4' : null,
                        targetMarker: null
                    }
                }
            });
        });

        var viewport = adopted.viewport && typeof adopted.viewport === 'object'
            ? adopted.viewport
            : { x: 0, y: 0, scale: 1 };

        return {
            cells: cells.concat(edges),
            nodeCells: cells,
            edgeCells: edges,
            viewport: {
                x: finite(viewport.x) || 0,
                y: finite(viewport.y) || 0,
                scale: positive(viewport.scale) || 1
            },
            meta: {
                id: adopted.id || '',
                title: adopted.title || '',
                icon: adopted.icon || '',
                updated_at: adopted.updated_at || 0,
                logs: Array.isArray(adopted.logs) ? adopted.logs : [],
                settings: adopted.settings && typeof adopted.settings === 'object' ? adopted.settings : {}
            },
            stats: {
                nodes: cells.length,
                edges: edges.length,
                groups: cells.filter(function (cell) { return cell.shape === 'xm-group'; }).length,
                danglingEdges: danglingEdges,
                coercedPorts: portCoerced
            }
        };
    }

    /* ---------- X6 → 旧画布 ---------- */

    function fromGraph(graph, meta, options) {
        var info = meta || {};
        var opts = options || {};
        var nodes = [];
        var connections = [];

        graph.getNodes().forEach(function (cell) {
            var data = cell.getData() || {};
            var legacy = data.legacy && typeof data.legacy === 'object' ? data.legacy : {};
            var position = cell.getPosition();
            var size = cell.getSize();

            var node = {};
            Object.keys(legacy).forEach(function (key) { node[key] = legacy[key]; });

            node.id = cell.id;
            node.type = data.type || legacy.type || 'smart-image';
            /* 坐标原样写回：浮点是旧数据的真实形态，取整会让多次往返累积漂移 */
            node.x = position.x;
            node.y = position.y;
            node.title = data.title != null ? data.title : (legacy.title || '');
            node.images = Array.isArray(data.images) ? data.images : (legacy.images || []);

            /* 只回写本来就有 w/h 的节点。旧数据里没有 w/h 的节点由页面的布局算法推导，
               强行写一个引擎算出来的尺寸会改变它的布局语义。 */
            if (legacy.w != null || legacy.h != null) {
                node.w = round(size.width);
                node.h = round(size.height);
            }

            /* 分组成员。
               旧数据里存在指向已删除节点的悬空 id（4 条引用指向不存在的节点），
               单纯「按实际子节点重写 items」会在用户只是打开看一眼时就把这些
               悬空引用清掉——那是静默改数据。所以规则是：
                 · 仍是子节点的 id          → 保留
                 · 对应 cell 根本不存在的 id → 保留（悬空引用是历史数据，不动它）
                 · 曾经是子节点、现在 cell 还在但关系已解除 → 视为真实移除，丢掉
                 · 新出现的子节点            → 追加
               注意 getChildren() 在没有子节点时返回 null，不是空数组。 */
            var kids = cell.getChildren ? (cell.getChildren() || []) : [];
            var childIds = kids.map(function (child) { return child.id; });
            var legacyItems = Array.isArray(legacy.items) ? legacy.items.slice() : null;

            if (legacyItems) {
                var childSet = Object.create(null);
                childIds.forEach(function (id) { childSet[id] = true; });
                var merged = legacyItems.filter(function (item) {
                    var key = String(item);
                    if (childSet[key]) return true;
                    return !graph.getCellById(key);
                });
                childIds.forEach(function (id) {
                    if (merged.indexOf(id) === -1) merged.push(id);
                });
                node.items = merged;
            } else if (childIds.length) {
                node.items = childIds;
            }

            nodes.push(node);
        });

        graph.getEdges().forEach(function (cell) {
            var data = cell.getData() || {};
            var legacy = data.legacy && typeof data.legacy === 'object' ? data.legacy : {};
            var source = cell.getSourceCellId();
            var target = cell.getTargetCellId();
            if (!source || !target) return;

            var conn = {};
            Object.keys(legacy).forEach(function (key) { conn[key] = legacy[key]; });
            conn.from = source;
            conn.to = target;
            conn.kind = data.kind || legacy.kind || 'input';
            var slot = data.slot || '';
            if (slot) conn.input_slot = slot;
            else if (conn.input_slot) delete conn.input_slot;
            connections.push(conn);
        });

        var translation = graph.transform.getTranslation();
        var scale = graph.zoom();

        var out = {
            id: info.id || '',
            title: info.title || '',
            icon: info.icon || '',
            nodes: nodes,
            connections: connections,
            viewport: {
                x: finite(translation.tx) || 0,
                y: finite(translation.ty) || 0,
                scale: positive(scale) || 1
            }
        };

        /* 原样带回去的文档级字段。缺了它们，保存会把日志和设置清空。 */
        if (info.logs !== undefined) out.logs = clone(info.logs);
        if (info.settings !== undefined) out.settings = clone(info.settings);
        if (info.updated_at) out.updated_at = info.updated_at;

        if (opts.cleanConnections && docKernel && typeof docKernel.cleanConnections === 'function') {
            out.connections = docKernel.cleanConnections(out.connections);
        }

        return out;
    }

    /* 把画布文档整理成 PUT /api/canvases/{id} 的请求体。
       有文档内核就用它（它是唯一保存契约实现），没有就按同样的字段手写。 */
    function saveBody(doc, meta) {
        var info = meta || {};
        if (docKernel && typeof docKernel.saveBody === 'function') {
            return docKernel.saveBody(doc, {
                profile: 'smart',
                labels: info.labels || {},
                baseUpdatedAt: info.baseUpdatedAt || 0,
                clientId: info.clientId || '',
                includeSettings: info.includeSettings !== false,
                fallbackTitle: info.fallbackTitle || '',
                fallbackIcon: info.fallbackIcon || ''
            });
        }
        return {
            title: doc.title || '',
            icon: doc.icon || '',
            nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
            connections: Array.isArray(doc.connections) ? doc.connections : [],
            viewport: doc.viewport || { x: 0, y: 0, scale: 1 },
            logs: Array.isArray(doc.logs) ? doc.logs : [],
            settings: doc.settings && typeof doc.settings === 'object' ? doc.settings : {},
            base_updated_at: Number(info.baseUpdatedAt || 0),
            client_id: info.clientId || ''
        };
    }

    root.XmCanvasAdapter = {
        version: '1.0.0',
        SHAPE_BY_TYPE: SHAPE_BY_TYPE,
        SLOT_ORDER: SLOT_ORDER,
        shapeFor: shapeFor,
        sizeFor: sizeFor,
        portsFor: portsFor,
        gridFor: gridFor,
        isVideoNode: isVideoNode,
        toCells: toCells,
        fromGraph: fromGraph,
        saveBody: saveBody
    };
})(typeof window !== 'undefined' ? window : globalThis);
