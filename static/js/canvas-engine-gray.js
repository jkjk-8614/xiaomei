/* 小美画布 · X6 引擎灰度开关
 *
 * 用法：在画布页地址后面加 `?engine=x6`。
 *   /static/smart-canvas.html?id=<画布 id>&engine=x6   → 只读灰度（新引擎）
 *   /static/smart-canvas.html?id=<画布 id>             → 正式画布（旧引擎，默认）
 *   /static/canvas-engine-preview.html?id=<画布 id>    → 独立预览页（不加载 smart-canvas.js）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * smart-canvas.js 有两百万字符，任何一行改动都要重新核对整条启动链。
 * 灰度逻辑全部放在这里，正式文件里只留一句「如果灰度激活就交给它，然后 return」，
 * 回滚时删掉那一句就彻底干净——旧文件从未被删、也从未被改坏。
 *
 * ── 只读到底意味着什么 ──────────────────────────────────────────────
 * 1. 不发任何 PUT / PATCH。这个文件里没有保存调用，引擎的 save() 也不会被调。
 * 2. 不装交互层（双击改提示词、节点动作派发都不装）。
 * 3. 关掉节点拖拽与连线（engine 的 readOnly 开关）。
 * 4. 不启动协作 socket、不上报心跳、不恢复待执行任务——因为整条旧启动链被跳过。
 * 换句话说：用户在这里看到的、拖动的，都不会落盘。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────
 * 直接 GET /api/canvases/{id}，和旧画布同一个接口、同一份 JSON。
 * 类型迁移由适配层复用 XiaomeiDocumentKernel.adopt() 完成，不复制第二份规则。
 * 这也正是 tests/canvas-engine-parity.browser.cjs 量的那套输入，
 * 所以灰度页看到的尺寸和用例里 97.5% 一致率的结论是同一件事。
 */
(function (root) {
    'use strict';

    var doc = root.document;
    var params = new root.URLSearchParams(root.location.search);
    var mode = String(params.get('engine') || '').trim().toLowerCase();
    /* 独立预览页（canvas-engine-preview.html）只有新引擎，没有旧引擎可退，
       所以它不需要 engine 参数，默认就是激活状态。 */
    var standalone = doc.documentElement.hasAttribute('data-xm-standalone');
    var active = mode === 'x6' || standalone;

    var STAGE_ID = 'xmGrayStage';
    var BADGE_ID = 'xmGrayBadge';

    function canvasId() {
        return params.get('id') || params.get('canvas') || '';
    }

    /* ---------- 页面骨架 ---------- */

    function ensureStage() {
        var existing = doc.getElementById(STAGE_ID);
        if (existing) return existing;

        var stage = doc.createElement('div');
        stage.id = STAGE_ID;
        stage.className = 'xm-canvas-stage xm-gray-stage';

        /* 正式画布页有 #shell 包裹层，把舞台塞进去才能继承它的尺寸与主题变量；
           独立预览页没有这层，直接挂 body。 */
        var host = doc.getElementById('shell') || doc.body;
        host.appendChild(stage);
        return stage;
    }

    function legacyHref() {
        var id = canvasId();
        return '/static/smart-canvas.html' + (id ? '?id=' + encodeURIComponent(id) : '');
    }

    function renderBadge(engine, extra) {
        var badge = doc.getElementById(BADGE_ID);
        if (!badge) {
            badge = doc.createElement('div');
            badge.id = BADGE_ID;
            badge.className = 'xm-gray-badge';
            doc.body.appendChild(badge);
            /* 事件只绑一次。badge 的 innerHTML 每次重绘都会换掉按钮节点，
               但监听挂在 badge 自己身上，靠 closest 找到真实按钮。 */
            badge.addEventListener('click', function (event) {
                var button = event.target.closest('[data-xm-fit],[data-xm-zoom]');
                if (!button || !badge.__engine) return;
                if (button.hasAttribute('data-xm-fit')) {
                    badge.__engine.viewport.fit();
                } else {
                    badge.__engine.viewport.zoomBy(button.getAttribute('data-xm-zoom') === 'in' ? 1 : -1);
                }
                var scaleCell = badge.querySelector('[data-xm-scale]');
                if (scaleCell) {
                    scaleCell.textContent = Math.round((badge.__engine.viewport.read().scale || 1) * 100) + '%';
                }
            });
        }
        badge.__engine = engine;

        var stats = engine.stats || {};
        var meta = engine.meta || {};
        var parts = [];
        parts.push('<div class="xm-gray-badge-title">X6 引擎 · 只读灰度</div>');
        parts.push('<div class="xm-gray-badge-name">' + escapeHtml(meta.title || '(未命名画布)') + '</div>');
        parts.push('<dl class="xm-gray-badge-stats">'
            + '<dt>节点</dt><dd>' + (stats.nodes || 0) + '</dd>'
            + '<dt>连线</dt><dd>' + (stats.edges || 0) + '</dd>'
            + '<dt>建图</dt><dd>' + (stats.ms || 0) + ' ms</dd>'
            + '<dt>缩放</dt><dd data-xm-scale>' + Math.round((engine.viewport.read().scale || 1) * 100) + '%</dd>'
            + '</dl>');
        if (extra) parts.push('<div class="xm-gray-badge-note">' + escapeHtml(extra) + '</div>');
        parts.push('<div class="xm-gray-badge-actions">'
            + '<button type="button" class="xm-gray-btn" data-xm-fit>适配全部</button>'
            + '<button type="button" class="xm-gray-btn" data-xm-zoom="in">放大</button>'
            + '<button type="button" class="xm-gray-btn" data-xm-zoom="out">缩小</button>'
            + '</div>');
        parts.push('<a class="xm-gray-badge-back" href="' + legacyHref() + '">切回旧引擎</a>');
        badge.innerHTML = parts.join('');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
        });
    }

    function showError(message) {
        var badge = doc.getElementById(BADGE_ID) || doc.body.appendChild(doc.createElement('div'));
        badge.id = BADGE_ID;
        badge.className = 'xm-gray-badge xm-gray-badge-error';
        badge.innerHTML = '<div class="xm-gray-badge-title">X6 引擎没能启动</div>'
            + '<div class="xm-gray-badge-note">' + escapeHtml(message) + '</div>'
            + '<a class="xm-gray-badge-back" href="' + legacyHref() + '">回到旧引擎</a>';
    }

    /* ---------- 按需加载引擎 ----------
     *
     * X6 的 UMD 包 583KB。正式画布页每天要开几百次，绝大多数时候走的是旧引擎，
     * 没有理由让每次打开都多下一个 583KB 的包。所以这里按需注入：
     * 只有地址里带 engine=x6 时才加载，旧路径的网络开销是 0。
     *
     * 顺序不能乱：适配层要用文档内核与共享布局内核，引擎要用适配层和 X6 全局。
     * 用 await 串行插入，而不是全部 append 后等 load——并行加载时
     * canvas-engine-x6.js 可能在 x6.min.js 之前执行，拿不到 X6 全局直接报错。
     *
     * 已存在的 <script> 会被跳过，所以独立预览页（静态标签已经写了全套）
     * 再调 boot() 也不会重复加载。 */
    var ENGINE_SCRIPTS = [
        '/static/vendor/x6/x6.min.js',
        '/static/js/xiaomei-media-layout.js',
        '/static/js/canvas-engine-adapter.js',
        '/static/js/canvas-engine-interaction.js',
        '/static/js/canvas-engine-x6.js'
    ];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var existing = doc.querySelector('script[src^="' + src.split('?')[0] + '"]');
            if (existing) {
                if (existing.dataset.xmLoaded === '1' || existing.readyState === 'complete') return resolve();
                existing.addEventListener('load', function () { resolve(); }, { once: true });
                existing.addEventListener('error', function () { reject(new Error('加载失败：' + src)); }, { once: true });
                return;
            }
            var script = doc.createElement('script');
            script.src = src;
            script.async = false;
            script.onload = function () { script.dataset.xmLoaded = '1'; resolve(); };
            script.onerror = function () { reject(new Error('加载失败：' + src)); };
            doc.head.appendChild(script);
        });
    }

    async function loadEngine() {
        if (root.XmCanvasEngine) return;
        for (var index = 0; index < ENGINE_SCRIPTS.length; index += 1) {
            await loadScript(ENGINE_SCRIPTS[index]);
        }
        if (!root.XmCanvasEngine) throw new Error('引擎脚本已加载但 XmCanvasEngine 不存在');
    }

    /* ---------- 启动 ---------- */

    async function boot(options) {
        var opts = options || {};
        var id = opts.id || canvasId();
        if (!id) throw new Error('地址里没有画布 id');

        doc.body.classList.add('engine-x6');
        await loadEngine();
        var stage = ensureStage();

        var response = await fetch('/api/canvases/' + encodeURIComponent(id));
        if (!response.ok) throw new Error('读取画布失败：HTTP ' + response.status);
        var payload = await response.json();
        var record = payload && payload.canvas;
        if (!record) throw new Error('接口没有返回画布数据');

        var engine = root.XmCanvasEngine.mount({
            container: stage,
            readOnly: true,
            history: false
        });
        var stats = engine.load(record, { id: id, title: record.title, icon: record.icon });

        /* 画布没存过视口（老画布很常见）时先适配一次，否则会停在 (0,0) 缩放 1，
           用户看到的是画布角落里的一小块空白。 */
        var savedViewport = record.viewport && Number(record.viewport.scale) > 0;
        if (!savedViewport || opts.fit === true) engine.viewport.fit();

        root.xmEngine = engine;
        renderBadge(engine, stats.danglingEdges
            ? stats.danglingEdges + ' 条连线因端口缺失被跳过'
            : '');
        return engine;
    }

    root.SmartCanvasEngineGray = {
        version: '1.0.0',
        mode: active ? 'x6' : 'legacy',
        standalone: standalone,
        active: active,
        canvasId: canvasId,
        boot: boot
    };

    /* 独立预览页没有 smart-canvas.js 帮忙调 boot，自己启动。 */
    if (active && standalone) {
        var start = function () {
            boot().catch(function (error) {
                console.error('[xm-gray]', error);
                showError(error && error.message ? error.message : String(error));
            });
        };
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
        else start();
    }
})(typeof window !== 'undefined' ? window : globalThis);
