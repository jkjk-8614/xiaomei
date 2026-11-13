/* 小美画布 X6 引擎
 *
 * 这是新画布引擎的装配层：形状注册、端口布局、视口委托、装载/导出。
 * 它不读全局业务状态，也不碰 smart-canvas.js 的任何变量——所有数据都从
 * load() 进来、从 export() 出去，中间只依赖 X6 实例和适配层。
 *
 * ── 为什么是 HTML shape ─────────────────────────────────────────────
 * X6 的 HTML shape 用 <foreignObject> 承载真实 DOM，所以卡片内部的排版可以
 * 直接交给 CSS，不需要把界面翻译成 SVG 绘图指令。代价是 foreignObject 里的
 * 表单控件会和 X6 手势打架，那一部分由 canvas-engine-interaction.js 处理。
 *
 * ── 视口为什么委托给 X6 ─────────────────────────────────────────────
 * 旧画布自己维护 {x, y, scale}，每帧手写 #world 的 transform。
 * X6 内部也维护一份完全等价的仿射变换（translate + scale），并且把它应用在
 * 一个 <g> 上——浏览器只需要合成一次，不需要重排 1849 个节点的布局。
 * 所以引擎不自己算矩阵，只做两件事：
 *   1. 把内核的纯数学（smartWheelStep / steppedZoom / positiveScale）当参数源；
 *   2. 把结果通过 graph.zoomTo / graph.translate 写进 X6 的变换。
 * 对外的 applyViewport/readViewport 保持与旧视口内核同构的 {x, y, scale} 记录，
 * 这样上层代码在阶段 4 可以两边共用同一份视口读写逻辑。
 *
 * ── 撤销为什么不由引擎负责 ──────────────────────────────────────────
 * X6 自带 History 插件，但小美画布已经有一份历史内核
 * （xiaomei-history-kernel.js），它的粒度是「一次业务操作」而不是「一次 cell 变更」。
 * 两份历史同时存在会出现「按一次 Ctrl+Z 只回退半个动作」的错乱。
 * 所以引擎默认不启用 History，撤销统一交给应用层。需要时用 history:true 打开。
 */
(function (root) {
    'use strict';

    var X6Lib = root.X6;
    var adapter = root.XmCanvasAdapter;
    var interaction = root.XmCanvasInteraction;

    /* 视觉网格 16px；拖动吸附步长 1px。两者必须解耦，理由见 createGraph 里的注释。 */
    var GRID_SIZE = 16;
    var GRID_SNAP = 1;

    /* 与正式画布一致：canvasZoomRange 默认 0.06–2，步长 0.05 */
    var MIN_SCALE = 0.06;
    var MAX_SCALE = 2;
    var ZOOM_STEP = 0.05;

    var SLOT_LAYOUT = 'xm-slot';
    var registered = false;

    /* ---------- 小工具 ---------- */

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function finite(value, fallback) {
        var number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clampScale(value) {
        var number = finite(value, 1);
        if (!(number > 0)) return 1;
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, number));
    }

    function cssVar(name, fallback) {
        if (typeof getComputedStyle !== 'function') return fallback;
        var value = getComputedStyle(root.document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    }

    function kernel() {
        return root.XiaomeiViewportKernel || null;
    }

    /* ---------- 形状 ---------- */

    function headHtml(title) {
        return '<div class="xm-node-head"><div class="xm-node-title">' + esc(title || '') + '</div></div>';
    }

    function placeholderHtml(icon, label) {
        return '<div class="xm-node-body"><div class="xm-drop">'
            + '<div class="xm-drop-icon">' + esc(icon) + '</div>'
            + '<div>' + esc(label) + '</div></div></div>';
    }

    function imageBodyHtml(data) {
        var list = (data.images || []).filter(function (image) { return image && image.url; });
        var title = data.title || '';
        if (!list.length) {
            return headHtml(title) + placeholderHtml('＋', data.type === 'smart-upload' ? '拖入图片' : '空节点');
        }
        var grid = adapter.gridFor(list.length);
        var cols = grid.cols;
        var style = 'grid-template-columns:repeat(' + cols + ',1fr)';
        var cells = list.map(function (image) {
            return '<img src="' + esc(image.url) + '" alt="' + esc(image.name || '') + '"'
                + ' loading="lazy" decoding="async" draggable="false">';
        }).join('');
        var single = list.length === 1 ? ' single' : '';
        var tools = data.tools ? '<div class="xm-node-tools">'
            + '<button type="button" class="xm-tool" data-xm-interactive data-xm-action="copy" title="复制">复制</button>'
            + '<button type="button" class="xm-tool" data-xm-interactive data-xm-action="download" title="下载">下载</button>'
            + '<button type="button" class="xm-tool" data-xm-interactive data-xm-action="run" title="运行">运行</button>'
            + '</div>' : '';
        return '<div class="xm-node-body is-media"><div class="xm-image-grid' + single + '" style="' + style + '">'
            + cells + '</div>' + tools + '</div>';
    }

    function videoBodyHtml(data) {
        var first = (data.images || []).filter(function (image) { return image && image.url; })[0];
        if (!first) return headHtml(data.title) + placeholderHtml('▶', data.prompt || '视频节点');
        return '<div class="xm-node-body"><div class="xm-video-wrap">'
            + '<video src="' + esc(first.url) + '" preload="metadata" muted loop playsinline controls></video>'
            + '</div></div>';
    }

    /* 提示词节点直接渲染成 textarea。
       正式画布的 .prompt-node-text 本来就是可编辑的，渲染成只读 div 会让
       新引擎在阶段 4 一上线就退化成「只能看不能改」。 */
    function promptBodyHtml(node) {
        var data = node.getData() || {};
        var draft = interaction ? interaction.draftOf(node.id, 'prompt') : undefined;
        var text = draft != null ? draft : (data.prompt || '');
        return '<div class="xm-node-body is-prompt">'
            + '<textarea class="xm-prompt-input" data-xm-interactive data-xm-scrollable'
            + ' data-xm-field="prompt" spellcheck="false" placeholder="输入提示词…">'
            + esc(text) + '</textarea></div>';
    }

    /* 分组节点。
     * 真实数据里 69 个 smart-group 有 64 个自带 images —— 它们是「图片分组」，
     * 正式画布用 smartGroupImageGridLayout 在组内排图片网格（列数 min(4, max(2, √n))，
     * 可见排数上限 4）。如果只画一个虚线空框，这 64 个分组在新引擎里会变成空白，
     * 属于肉眼可见的退化，所以这里必须把图片网格画出来。 */
    function groupBodyHtml(data) {
        var list = (data.images || []).filter(function (image) { return image && image.url; });
        var memberCount = finite(data.memberCount, 0);
        var badge = memberCount > 0 ? '<span class="xm-group-count">' + memberCount + '</span>' : '';

        var grid = '';
        if (list.length) {
            var cols = list.length === 1
                ? 1
                : Math.min(4, Math.max(2, Math.ceil(Math.sqrt(list.length))));
            grid = '<div class="xm-image-grid xm-group-grid" style="grid-template-columns:repeat('
                + cols + ',1fr)">'
                + list.map(function (image) {
                    return '<img src="' + esc(image.url) + '" alt="' + esc(image.name || '') + '"'
                        + ' loading="lazy" decoding="async" draggable="false">';
                }).join('')
                + '</div>';
        }

        return '<div class="xm-group">'
            + '<div class="xm-group-head">' + esc(data.title || '分组') + badge + '</div>'
            + '<div class="xm-group-body">' + grid + '</div></div>';
    }

    /* 结构化节点（智能体 / 工作流 / 对比 / 色卡 / 表格 / 相机）在阶段 3 只画骨架：
       它们的完整交互依赖应用层的表单与任务队列，属于阶段 5 的渲染分支清理范围。
       这里保证标题、类型、内容摘要可见，便于在真实画布上核对节点没画错位置。 */
    function structuredBodyHtml(data, label) {
        var lines = [];
        if (data.prompt) lines.push('<div class="xm-plain-line">' + esc(String(data.prompt).slice(0, 160)) + '</div>');
        var count = (data.images || []).filter(function (image) { return image && image.url; }).length;
        if (count) lines.push('<div class="xm-plain-meta">' + count + ' 张图</div>');
        if (!lines.length) lines.push('<div class="xm-plain-meta">' + esc(label) + '</div>');
        return headHtml(data.title) + '<div class="xm-node-body is-stack"><div class="xm-plain">'
            + lines.join('') + '</div></div>';
    }

    /* 端口布局：注册一个按比例计算的 layout。
     *
     * 坑（原型阶段记录）：X6 的 `ports.position` 写成顶层函数是不生效的。
     * 端口布局函数是从「分组」的 position.name 去注册表取的：
     *     getPortsLayoutByGroup(group, bbox) {
     *         const pos = group.position; const fn = registry.get(pos.name);
     *         return fn(ports.map(p => p.position?.args || {}), bbox, pos.args)
     *     }
     * 而内置的 'absolute' 布局只读每个端口写死的像素 args.x/y，节点一改尺寸端口就错位。
     * 所以必须注册自己的布局：纵向 = bbox.height * args.ratio，横向由 args.side 决定。 */
    function registerSlotLayout() {
        X6Lib.Graph.registerPortLayout(SLOT_LAYOUT, function (portArgs, bbox) {
            return portArgs.map(function (args) {
                var ratio = finite(args.ratio, 0.5);
                return {
                    position: { x: args.side === 'right' ? bbox.width : 0, y: bbox.height * ratio },
                    angle: 0
                };
            });
        });
    }

    function registerShapes() {
        if (registered) return;
        registerSlotLayout();

        /* 端口配色必须显式写进 attrs。X6 给端口 circle 自带一套默认外观
           （白底 + 灰/青描边），CSS 里的 fill/stroke 压不过它写下的内联样式，
           结果就是端口颜色和正式画布的 --card/--strong 对不上。 */
        var portCircle = {
            r: 7,
            magnet: true,
            strokeWidth: 1.8,
            fill: cssVar('--card', '#fffaf3'),
            stroke: cssVar('--strong', '#1f6a4a')
        };

        var portGroups = {
            in: {
                position: { name: SLOT_LAYOUT },
                attrs: { circle: portCircle },
                zIndex: 3
            },
            out: {
                position: { name: SLOT_LAYOUT },
                attrs: { circle: portCircle },
                zIndex: 3
            }
        };

        /* effect:['data'] 很关键——不写的话 X6 会在任何 cell 属性变化时重渲染 HTML，
           拖动过程中反复销毁重建 <video>，视频会不断回到 0 秒。
           只声明分组、不写顶层 position 函数，理由见 registerSlotLayout。 */
        var common = {
            inherit: 'html',
            effect: ['data'],
            ports: { groups: portGroups }
        };

        function define(shape, render) {
            X6Lib.Shape.HTML.register(Object.assign({}, common, {
                shape: shape,
                html: function (node) {
                    return '<div class="xm-node xm-node-' + shape.slice(3) + '">' + render(node) + '</div>';
                }
            }));
        }

        define('xm-image', function (node) { return imageBodyHtml(node.getData() || {}); });
        define('xm-upload', function (node) { return imageBodyHtml(node.getData() || {}); });
        define('xm-video', function (node) { return videoBodyHtml(node.getData() || {}); });
        define('xm-prompt', function (node) { return promptBodyHtml(node); });
        define('xm-group', function (node) { return groupBodyHtml(node.getData() || {}); });
        define('xm-agent', function (node) { return structuredBodyHtml(node.getData() || {}, '智能体'); });
        define('xm-comfy', function (node) { return structuredBodyHtml(node.getData() || {}, 'ComfyUI 工作流'); });
        define('xm-compare', function (node) { return structuredBodyHtml(node.getData() || {}, '对比'); });
        define('xm-color', function (node) { return structuredBodyHtml(node.getData() || {}, '色卡'); });
        define('xm-table', function (node) { return structuredBodyHtml(node.getData() || {}, '表格'); });
        define('xm-camera', function (node) { return structuredBodyHtml(node.getData() || {}, '相机'); });

        registered = true;
    }

    /* ---------- 建图 ---------- */

    function createGraph(container, options) {
        var opts = options || {};
        /* 只读灰度模式：能平移、能缩放、能看，但拖不动节点、连不出新线。
           做法不是禁用整张图（那会连平移一起关掉），而是分别关掉三处入口：
           ① X6 的 interacting —— 节点/边/顶点的拖拽都归它管；
           ② connecting —— 端口磁吸拖线；
           ③ Selection 的 movable —— 选中后整体拖移。 */
        var readOnly = opts.readOnly === true;

        var graph = new X6Lib.Graph({
            container: container,
            autoResize: true,
            background: { color: 'transparent' },
            grid: {
                visible: opts.grid !== false,
                type: 'dot',
                size: GRID_SIZE,
                args: { color: cssVar('--grid', '#d9cbb6'), thickness: 1 }
            },
            /* 正式画布：左键或中键拖空白处 = 平移（smart-canvas.js:34975）。
               滚轮不参与平移，它是缩放。 */
            panning: { enabled: true, eventTypes: ['leftMouseDown', 'middleMouseDown'] },
            /* 关掉内置滚轮：缩放改由下面的 wheel 处理器走视口内核的
               smartWheelStep，才能和旧画布的手感（gain = -deltaY*0.002，±0.15）一致。 */
            mousewheel: { enabled: false },
            translating: { restrict: false },
            interacting: readOnly ? false : {
                nodeMovable: true,
                edgeMovable: true,
                vertexMovable: true,
                arrowheadMovable: true
            },
            /* 只读时不能直接把 connecting 写成 false：边的渲染要靠
               connecting.anchor / connectionPoint 定位端点，置成 false 之后
               X6 找不到锚点，建边时会抛 "Anchor should be specified."。
               正确做法是保留整套配置，只把「从端口拉线」这个入口关掉。 */
            connecting: {
                snap: { radius: 28 },
                allowBlank: false,
                allowLoop: false,
                allowNode: false,
                allowEdge: false,
                /* 同一个来源节点可以同时接「参考 / 风格 / 商品」三路输入槽，
                   所以不能写 allowMulti:false —— 那会把整对节点锁成只能有一条边。
                   'withPort' 的语义是：只有源端口和目标端口都相同才判重。 */
                allowMulti: 'withPort',
                highlight: true,
                anchor: 'center',
                connectionPoint: 'anchor',
                router: { name: 'normal' },
                connector: { name: 'rounded', args: { radius: 12 } },
                validateMagnet: readOnly ? function () { return false; } : undefined,
                createEdge: function () {
                    return this.createEdge({
                        shape: 'edge',
                        attrs: {
                            line: {
                                stroke: cssVar('--strong', '#1f6a4a'),
                                strokeWidth: 1.6,
                                targetMarker: null
                            }
                        },
                        zIndex: 0,
                        data: { kind: 'input', slot: '' }
                    });
                }
            },
            highlighting: {
                magnetAvailable: {
                    name: 'stroke',
                    args: { padding: 3, attrs: { stroke: cssVar('--strong', '#1f6a4a') } }
                }
            }
        });

        /* 关掉拖动吸附——X6 3.x 一个没写进文档的行为。
         *
         * NodeView.dragNode 里是这样算位置的：
         *     const r = s.getGridSize();
         *     const h = go(e + a.x, r), c = go(n + a.y, r);
         *     i.setPosition(h, c, { restrict: l, deep: !0, ui: !0 });
         * 也就是**无条件**按网格尺寸取整，grid.snap 这个开关在拖动路径上根本没被读，
         * 覆盖 graph.snapToGrid 也无效。视觉网格 16px 点阵，如果吸附步长也是 16，
         * 拖动就会呈 16px 跳格，而正式画布的坐标可以是 -940.7944 这种浮点。
         * 处理方式：只覆盖 Graph 实例的 getGridSize，点阵网格照旧 16px，吸附步长 1px。 */
        graph.getGridSize = function () { return GRID_SNAP; };

        graph.use(new X6Lib.Selection({
            enabled: true,
            multiple: true,
            /* 空白左键拖拽已经是平移，框选会让两者抢同一个手势 */
            rubberband: false,
            movable: !readOnly,
            showNodeSelectionBox: false,
            modifiers: null
        }));
        graph.use(new X6Lib.Snapline({ enabled: !readOnly && opts.snapline !== false, tolerance: 8 }));
        if (opts.history === true) {
            graph.use(new X6Lib.History({ enabled: true, beforeAddCommand: function () { return true; } }));
        }

        /* 拖动期间关掉阴影，和正式画布 body.smart-node-drag 的做法一致 */
        graph.on('node:move', function () { root.document.body.classList.add('is-node-drag'); });
        graph.on('node:moved', function () { root.document.body.classList.remove('is-node-drag'); });

        return graph;
    }

    /* ---------- 实例 ---------- */

    function mount(options) {
        if (!X6Lib) throw new Error('X6 未加载：请先引入 static/vendor/x6/x6.min.js');
        if (!adapter) throw new Error('适配层未加载：请先引入 static/js/canvas-engine-adapter.js');

        registerShapes();

        var opts = options || {};
        var container = typeof opts.container === 'string'
            ? root.document.getElementById(opts.container)
            : opts.container;
        if (!container) throw new Error('画布容器不存在');

        var graph = createGraph(container, opts);
        var listeners = Object.create(null);
        var meta = { id: '', title: '', icon: '', logs: [], settings: {}, updated_at: 0 };
        var loadStats = { nodes: 0, edges: 0, ms: 0 };
        var dirty = false;
        var destroyed = false;

        /* 只读灰度下不装交互层：它负责双击改提示词、点击派发节点动作，
           这些都是「会改数据」或「依赖应用层响应」的行为。平移/缩放/悬停
           高亮由 X6 自己负责，不装这一层也不影响只读浏览。 */
        var guard = (interaction && opts.readOnly !== true) ? interaction.install(graph, {
            onAction: opts.onAction,
            onEdit: opts.onEdit
        }) : null;

        function emit(name, payload) {
            var list = listeners[name];
            if (!list) return;
            list.slice().forEach(function (fn) {
                try { fn(payload); } catch (error) { console.error('[xm-engine]', name, error); }
            });
        }

        function markDirty() {
            if (dirty) return;
            dirty = true;
            emit('dirty', true);
        }

        graph.on('node:added', function () { markDirty(); emit('change', { type: 'node:added' }); });
        graph.on('node:removed', function () { markDirty(); emit('change', { type: 'node:removed' }); });
        graph.on('node:moved', function (args) { markDirty(); emit('change', { type: 'node:moved', cell: args.cell }); });
        graph.on('edge:added', function () { markDirty(); emit('change', { type: 'edge:added' }); });
        graph.on('edge:removed', function () { markDirty(); emit('change', { type: 'edge:removed' }); });
        graph.on('edge:connected', function () { markDirty(); emit('change', { type: 'edge:connected' }); });

        /* ---------- 视口 ---------- */

        function frameSize() {
            return { width: container.clientWidth || 1, height: container.clientHeight || 1 };
        }

        function readViewport() {
            var translation = graph.transform.getTranslation();
            return {
                x: finite(translation.tx, 0),
                y: finite(translation.ty, 0),
                scale: clampScale(graph.zoom())
            };
        }

        /* 先 zoom 再 translate：X6 的 zoomTo 默认锚在容器中心，会改 translate，
           所以必须最后写 translate，否则视口会跳。 */
        function applyViewport(record) {
            var source = record || {};
            var scale = clampScale(source.scale);
            graph.zoomTo(scale);
            graph.translate(finite(source.x, 0), finite(source.y, 0));
            return readViewport();
        }

        function clientToLocal(clientX, clientY) {
            var rect = container.getBoundingClientRect();
            return { x: finite(clientX, 0) - rect.left, y: finite(clientY, 0) - rect.top };
        }

        function clientToWorld(clientX, clientY) {
            return graph.clientToLocal(finite(clientX, 0), finite(clientY, 0));
        }

        function worldToClient(x, y) {
            return graph.localToClient(finite(x, 0), finite(y, 0));
        }

        /* 以某个屏幕点为锚点缩放。
           与视口内核 zoomAboutClient 同一个语义：该点下的世界坐标缩放前后不变。
           X6 的 transform.zoom 里 `e.center` 用的是容器局部坐标，所以这里先换算。 */
        function zoomAboutClient(clientX, clientY, nextScale) {
            var scale = clampScale(nextScale);
            if (Math.abs(scale - graph.zoom()) < 0.0001) return readViewport();
            var local = clientToLocal(clientX, clientY);
            graph.zoomTo(scale, { center: { x: local.x, y: local.y } });
            return readViewport();
        }

        function zoomBy(factor, clientX, clientY) {
            var current = graph.zoom();
            var next = clampScale(current * finite(factor, 1));
            var frame = frameSize();
            var anchorX = clientX == null ? container.getBoundingClientRect().left + frame.width / 2 : clientX;
            var anchorY = clientY == null ? container.getBoundingClientRect().top + frame.height / 2 : clientY;
            return zoomAboutClient(anchorX, anchorY, next);
        }

        function centerOn(worldPoint) {
            var frame = frameSize();
            var scale = graph.zoom();
            var x = finite(worldPoint && worldPoint.x, 0);
            var y = finite(worldPoint && worldPoint.y, 0);
            graph.translate(frame.width / 2 - x * scale, frame.height / 2 - y * scale);
            return readViewport();
        }

        /* 适配全部节点。
         *
         * 这里不能直接 zoomToFit：小美画布对「铺得又长又散」的画布有一条明确设计
         * （smart-canvas.js:5552 的注释）——节点跨度过大时适配会把缩放压到 6%，
         * 屏幕上还是一片空白，等于没适配。所以正式行为是
         * 「先尝试适配全部；缩放低于 floor(0.18) 就改为聚焦离内容中心最近的节点」。
         *
         * 直接复用视口内核的 focusContent 而不是自己写一遍，有两个好处：
         *   1. 两套引擎的「适配」结果逐像素一致，阶段 4 灰度对比不会出现视口差异；
         *   2. 顺带避开一个性能悬崖——在 8% 缩放下，198 张卡里 288 张图片同时被
         *      栅格化，实测帧率从 58fps 掉到 47fps、最差帧 150ms。
         *      落到 0.45 之后这个场景根本不会出现。 */
        function fit(padding, maxScale) {
            var nodes = graph.getNodes();
            if (!nodes.length) return applyViewport({ x: 0, y: 0, scale: 1 });

            var lib = kernel();
            if (lib && typeof lib.focusContent === 'function') {
                var boxes = nodes.map(function (node) {
                    var box = node.getBBox();
                    return { x: box.x, y: box.y, w: box.width, h: box.height };
                });
                var record = readViewport();
                var placed = lib.focusContent(record, frameSize(), boxes, {
                    pad: padding == null ? 160 : padding,
                    inset: 80,
                    minZoom: MIN_SCALE,
                    maxZoom: maxScale == null ? 0.82 : maxScale,
                    emptyZoom: 0.45,
                    floor: 0.18,
                    focusZoom: 0.45
                });
                if (placed) return applyViewport(record);
            }

            graph.zoomToFit({
                padding: padding == null ? 80 : padding,
                maxScale: maxScale == null ? 1 : maxScale
            });
            return readViewport();
        }

        function focusNode(cellId, nextScale) {
            var cell = graph.getCellById(String(cellId));
            if (!cell || !cell.isNode()) return null;
            var box = cell.getBBox();
            var frame = frameSize();
            var scale = clampScale(nextScale == null ? graph.zoom() : nextScale);
            graph.zoomTo(scale);
            graph.translate(
                frame.width / 2 - (box.x + box.width / 2) * scale,
                frame.height / 2 - (box.y + box.height / 2) * scale
            );
            return readViewport();
        }

        /* 滚轮缩放：走视口内核的 smartWheelStep，保证与旧画布同一套手感。
           内核不可用时退化成 classicWheel 的固定倍率。 */
        function onWheel(event) {
            if (opts.wheel === false) return;
            if (event.ctrlKey && event.metaKey) return;
            event.preventDefault();

            var current = readViewport();
            var frame = {
                left: container.getBoundingClientRect().left,
                top: container.getBoundingClientRect().top,
                width: container.clientWidth,
                height: container.clientHeight
            };

            var lib = kernel();
            var next = null;
            if (lib && typeof lib.smartWheelStep === 'function') {
                next = lib.smartWheelStep(
                    current, frame, event.clientX, event.clientY,
                    event.deltaY, event.deltaMode, root.innerHeight || 0
                );
            }
            if (!next) {
                var factor = event.deltaY > 0 ? 0.92 : 1.08;
                next = { scale: clampScale(current.scale * factor), x: current.x, y: current.y };
            }

            var scale = clampScale(next.scale);
            if (Math.abs(scale - current.scale) < 0.0001) return;
            /* 内核给出的 x/y 是「以该锚点缩放后」的平移量，直接写回比让 X6
               自己算锚点更精确（也避免了两次取整）。 */
            graph.zoomTo(scale);
            if (Number.isFinite(next.x) && Number.isFinite(next.y)) {
                graph.translate(next.x, next.y);
            }
            emit('viewport', readViewport());
        }

        container.addEventListener('wheel', onWheel, { passive: false });

        /* ---------- 装载 ---------- */

        function load(doc, info) {
            var converted = adapter.toCells(doc, opts);
            meta = {
                id: converted.meta.id,
                title: converted.meta.title,
                icon: converted.meta.icon,
                logs: converted.meta.logs,
                settings: converted.meta.settings,
                updated_at: converted.meta.updated_at
            };
            if (info && info.id) meta.id = info.id;

            var started = (root.performance || Date).now();
            graph.fromJSON({ cells: converted.cells });

            /* 分组父子关系：fromJSON 里的 parent 字段不保证生效（子节点可能先于父节点
               进入模型），这里显式补一次挂载。必须用 addChild 而不是 setParent：
               setParent 只写 cell.parent 字段，不会把子节点登记进 parent.children，
               而 translate() 是靠 eachChild 传播位移的，childCount 为 0 就会出现
               「拖分组、子节点不动」。 */
            converted.nodeCells.forEach(function (cell) {
                if (!cell.parent) return;
                var child = graph.getCellById(cell.id);
                var parent = graph.getCellById(cell.parent);
                if (!child || !parent) return;
                /* 判「是否已登记在 parent.children 里」，而不是判 getParent()：
                   fromJSON 有可能只写 cell.parent 而不登记 children，
                   那样 getParent() 为真、children 却为空，位移照样不传播。
                   注意 getChildren() 在没有子节点时返回 null，不是空数组。 */
                var kids = parent.getChildren() || [];
                var registered = kids.some(function (item) { return item.id === child.id; });
                if (!registered) parent.addChild(child);
            });

            applyViewport(converted.viewport);

            loadStats = {
                nodes: converted.stats.nodes,
                edges: converted.stats.edges,
                groups: converted.stats.groups,
                coercedPorts: converted.stats.coercedPorts,
                danglingEdges: converted.stats.danglingEdges,
                ms: Math.round((root.performance || Date).now() - started)
            };
            dirty = false;
            emit('loaded', loadStats);
            return loadStats;
        }

        function exportDoc() {
            if (interaction) interaction.flushDrafts(graph);
            return adapter.fromGraph(graph, meta, { cleanConnections: opts.cleanConnections === true });
        }

        /* PUT /api/canvases/{id} 全量保存。增量保存（PATCH /nodes）需要节点级差异
           与协作锁，属于应用层职责，引擎只提供 exportDoc() 供其自行计算差异。 */
        function save(saveOptions) {
            var config = saveOptions || {};
            if (!meta.id) return Promise.reject(new Error('画布 id 为空'));
            var doc = exportDoc();
            var body = adapter.saveBody(doc, {
                baseUpdatedAt: config.baseUpdatedAt || meta.updated_at || 0,
                clientId: config.clientId || '',
                includeSettings: true,
                fallbackTitle: meta.title,
                fallbackIcon: meta.icon
            });
            var url = config.url || ('/api/canvases/' + encodeURIComponent(meta.id));
            return fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function (response) {
                if (!response.ok) {
                    return response.text().then(function (text) {
                        throw new Error('保存失败 ' + response.status + ' ' + text.slice(0, 200));
                    });
                }
                return response.json().catch(function () { return {}; });
            }).then(function (payload) {
                dirty = false;
                if (payload && payload.canvas && payload.canvas.updated_at) {
                    meta.updated_at = payload.canvas.updated_at;
                }
                emit('saved', { at: meta.updated_at });
                return payload;
            });
        }

        /* ---------- 节点/边操作 ---------- */

        function addNode(spec) {
            var converted = adapter.toCells({ nodes: [spec], connections: [] }, opts);
            var cell = converted.nodeCells[0];
            if (!cell) return null;
            var added = graph.addNode(cell);
            markDirty();
            return added;
        }

        function updateNode(cellId, patch) {
            var cell = graph.getCellById(String(cellId));
            if (!cell || !cell.isNode()) return null;
            var data = Object.assign({}, cell.getData() || {}, patch || {});
            cell.setData(data, { silent: true });
            return cell;
        }

        function removeCells(ids) {
            var list = (Array.isArray(ids) ? ids : [ids]).map(function (id) {
                return graph.getCellById(String(id));
            }).filter(Boolean);
            if (!list.length) return 0;
            graph.removeCells(list);
            markDirty();
            return list.length;
        }

        function connect(sourceId, targetId, slot) {
            var source = graph.getCellById(String(sourceId));
            var target = graph.getCellById(String(targetId));
            if (!source || !target) return null;
            var port = slot ? 'in-' + slot : 'in';
            var has = (target.getPorts() || []).some(function (item) { return item.id === port; });
            var edge = graph.addEdge({
                shape: 'edge',
                source: { cell: source.id, port: 'out' },
                target: { cell: target.id, port: has ? port : 'in' },
                zIndex: 0,
                data: { kind: 'input', slot: has && slot ? slot : '' },
                router: { name: 'normal' },
                connector: { name: 'rounded', args: { radius: 12 } },
                attrs: { line: { stroke: cssVar('--strong', '#1f6a4a'), strokeWidth: 1.6, targetMarker: null } }
            });
            markDirty();
            return edge;
        }

        function selection() {
            var plugin = graph.getPlugin ? graph.getPlugin('selection') : null;
            var cells = plugin && typeof plugin.getSelectedCells === 'function'
                ? plugin.getSelectedCells()
                : [];
            return cells;
        }

        function destroy() {
            if (destroyed) return;
            destroyed = true;
            container.removeEventListener('wheel', onWheel);
            if (guard) guard.dispose();
            graph.dispose();
            listeners = Object.create(null);
        }

        var api = {
            version: '1.0.0',
            graph: graph,
            container: container,

            load: load,
            export: exportDoc,
            save: save,

            get meta() { return meta; },
            get dirty() { return dirty; },
            get stats() { return loadStats; },

            viewport: {
                apply: applyViewport,
                read: readViewport,
                clientToWorld: clientToWorld,
                worldToClient: worldToClient,
                zoomAboutClient: zoomAboutClient,
                zoomBy: zoomBy,
                centerOn: centerOn,
                fit: fit,
                focusNode: focusNode
            },

            node: { add: addNode, update: updateNode, remove: removeCells },
            edge: { connect: connect },
            selection: {
                cells: selection,
                ids: function () { return selection().map(function (cell) { return cell.id; }); },
                clear: function () {
                    var plugin = graph.getPlugin ? graph.getPlugin('selection') : null;
                    if (plugin && typeof plugin.cleanSelection === 'function') plugin.cleanSelection();
                }
            },

            on: function (name, fn) {
                if (!listeners[name]) listeners[name] = [];
                listeners[name].push(fn);
                return function () { api.off(name, fn); };
            },
            off: function (name, fn) {
                var list = listeners[name];
                if (!list) return;
                var index = list.indexOf(fn);
                if (index >= 0) list.splice(index, 1);
            },

            markClean: function () { dirty = false; },
            destroy: destroy
        };

        if (opts.doc) load(opts.doc, opts.meta);
        else if (opts.viewport) applyViewport(opts.viewport);

        return api;
    }

    root.XmCanvasEngine = {
        version: '1.0.0',
        GRID_SIZE: GRID_SIZE,
        MIN_SCALE: MIN_SCALE,
        MAX_SCALE: MAX_SCALE,
        ZOOM_STEP: ZOOM_STEP,
        register: registerShapes,
        mount: mount,
        isSupported: function () { return Boolean(X6Lib); }
    };
})(typeof window !== 'undefined' ? window : globalThis);
