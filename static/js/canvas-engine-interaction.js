/* foreignObject 内表单控件与 X6 手势的隔离层
 *
 * 这是整个 HTML shape 方案里唯一可能推翻方案的地方，规则必须写死。
 *
 * ── 冲突从哪来 ──────────────────────────────────────────────────────
 * X6 的拖动、框选都在「节点的 <g> 元素」上监听 mousedown（冒泡阶段）。
 * 节点内容是 <foreignObject> 里的真 HTML，<textarea>/<button> 是 <g> 的后代，
 * 所以 mousedown 一定会冒泡到 <g>。结果是：点一下输入框，整张卡片被拖走。
 *
 * ── 为什么只能在捕获阶段拦 ──────────────────────────────────────────
 * 容器是 <g> 的祖先。冒泡阶段容器比 <g> 更晚收到事件，拦不住；
 * 只有捕获阶段才比 <g> 更早。而捕获阶段 stopPropagation() 之后，
 * 事件到不了 <textarea> 自己的监听器——但这不影响使用，因为
 * stopPropagation() 只阻断「事件传播」，不阻断「浏览器对目标元素的默认行为」：
 * 聚焦、光标定位、文本选区、输入法 composition 都不依赖事件冒泡。
 * 实测：捕获阶段拦截后，输入框仍能聚焦、能选中文字、能打中文。
 *
 * ── 规则表 ──────────────────────────────────────────────────────────
 * 目标元素带 data-xm-interactive 时：
 *   mousedown / touchstart → 拦。不启动节点拖动，不启动框选。
 *   dblclick               → 拦。避免双击触发画布居中。
 *   keydown / keyup        → 拦。Delete 删字符而不是删节点；Ctrl+Z 撤销文本而不是画布历史。
 *   contextmenu            → 拦。出浏览器原生菜单，而不是画布右键菜单。
 *   wheel                  → 有条件拦。可滚动且该方向还有余量时拦（滚内容）；
 *                            滚到边界后放行，让滚轮变回画布缩放。这是最符合直觉的行为。
 *   click                  → 不拦。按 data-xm-action 派发 xm:node-action。
 * 其他区域（卡片空白、图片、连线）一律放行，交给 X6。
 *
 * ── 为什么打字不能直接写 cell data ──────────────────────────────────
 * HTML shape 配了 effect:['data']，写 data 会触发重渲染 → <textarea> 被销毁重建
 * → 焦点和光标位置全丢，表现为「打一个字就跳出输入框」。
 * 所以 input 事件只进草稿表，blur 或导出前才落回 data。
 */
(function (root) {
    'use strict';

    var INTERACTIVE = '[data-xm-interactive]';
    var SCROLLABLE = '[data-xm-scrollable]';
    var ACTION = '[data-xm-action]';
    var FIELD = '[data-xm-field]';

    /* 草稿表。key 是 "cellId\u0000field"，value 是字符串。
       用复合 key 而不是只用 cellId：一个节点可能有多个可编辑字段（提示词、标题），
       只用 cellId 会让后写的字段覆盖前一个。 */
    var drafts = new Map();

    /* 字段 → 写回函数。
     * 每个字段必须同时写 data 上的展示字段和 legacy 上的持久字段：
     * 导出时适配层是从 legacy 展开的，只写 data.prompt 的话，
     * 导出的画布还是旧文本，编辑内容会静默丢失。
     */
    var FIELD_WRITERS = {
        prompt: function (data, legacy, value) {
            if (legacy.promptDraftText !== undefined) legacy.promptDraftText = value;
            data.prompt = value;
        },
        title: function (data, legacy, value) {
            if (legacy.title !== undefined) legacy.title = value;
            data.title = value;
        }
    };

    function keyOf(cellId, field) {
        return String(cellId) + '\u0000' + String(field || '');
    }

    function draftOf(cellId, field) {
        var key = keyOf(cellId, field || 'prompt');
        return drafts.has(key) ? drafts.get(key) : undefined;
    }

    function setDraft(cellId, field, value) {
        drafts.set(keyOf(cellId, field), value);
    }

    function dropDraftsFor(cellId) {
        var prefix = String(cellId) + '\u0000';
        var removed = 0;
        drafts.forEach(function (value, key) {
            if (key.indexOf(prefix) === 0) { drafts.delete(key); removed += 1; }
        });
        return removed;
    }

    /* 把一次编辑写回 cell。
     * silent:true 很关键——带 ui 的 setData 会进历史栈，
     * 每敲一个字就多一条撤销记录，画布历史会被打字记录冲垮。 */
    function applyEdit(cell, field, value) {
        if (!cell) return false;
        var name = field || 'prompt';
        var writer = FIELD_WRITERS[name];
        if (!writer) return false;
        var data = cell.getData() || {};
        var legacy = data.legacy ? Object.assign({}, data.legacy) : {};
        var next = Object.assign({}, data, { legacy: legacy });
        writer(next, legacy, value);
        cell.setData(next, { silent: true });
        return true;
    }

    /* 把草稿落回 data。blur、导出前、切换画布前各调一次。
       返回真正写入的条数，方便测试断言。 */
    function flushDrafts(graph) {
        if (!drafts.size) return 0;
        var flushed = 0;
        var stale = [];
        drafts.forEach(function (value, key) {
            var split = key.split('\u0000');
            var cellId = split[0];
            var field = split[1] || 'prompt';
            var cell = graph.getCellById(cellId);
            if (!cell) { stale.push(key); return; }
            var data = cell.getData() || {};
            var current = field === 'title' ? data.title : data.prompt;
            if (current === value) { stale.push(key); return; }
            if (applyEdit(cell, field, value)) flushed += 1;
            stale.push(key);
        });
        stale.forEach(function (key) { drafts.delete(key); });
        return flushed;
    }

    function closestFrom(event, selector) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return null;
        return target.closest(selector);
    }

    /* 元素在该方向上还能不能继续滚 */
    function canScroll(element, deltaY) {
        if (!element || element.scrollHeight <= element.clientHeight + 1) return false;
        if (deltaY < 0) return element.scrollTop > 0;
        if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
        return false;
    }

    function cellIdOf(element) {
        var host = element && typeof element.closest === 'function'
            ? element.closest('[data-cell-id]')
            : null;
        return host ? host.getAttribute('data-cell-id') : '';
    }

    function install(graph, options) {
        var opts = options || {};
        var container = graph.container;
        var disposers = [];

        function on(target, type, handler, capture) {
            target.addEventListener(type, handler, capture);
            disposers.push(function () { target.removeEventListener(type, handler, capture); });
        }

        /* 捕获阶段：比节点 <g> 更早拿到事件 */
        var guard = function (event) {
            if (!closestFrom(event, INTERACTIVE)) return;
            event.stopPropagation();
        };
        ['mousedown', 'touchstart', 'dblclick', 'keydown', 'keyup', 'contextmenu'].forEach(function (type) {
            on(container, type, guard, true);
        });

        /* wheel 单独处理：可滚就滚内容，滚到头放行给画布缩放 */
        on(container, 'wheel', function (event) {
            var hit = closestFrom(event, SCROLLABLE) || closestFrom(event, INTERACTIVE);
            if (!hit) return;
            if (canScroll(hit, event.deltaY)) event.stopPropagation();
        }, true);

        /* 按钮：click 不拦，按 action 派发出去，由应用层决定做什么 */
        on(container, 'click', function (event) {
            var button = closestFrom(event, ACTION);
            if (!button) return;
            var detail = {
                cellId: cellIdOf(button),
                action: button.getAttribute('data-xm-action'),
                element: button
            };
            container.dispatchEvent(new CustomEvent('xm:node-action', { detail: detail, bubbles: true }));
            if (typeof opts.onAction === 'function') opts.onAction(detail);
        }, true);

        /* 输入：只写草稿，不碰 cell data（碰了就会重渲染、丢焦点） */
        on(container, 'input', function (event) {
            var field = closestFrom(event, FIELD);
            if (!field) return;
            var cellId = cellIdOf(field);
            if (!cellId) return;
            setDraft(cellId, field.getAttribute('data-xm-field'), field.value);
        }, true);

        /* 失焦：草稿落回 data（此时重渲染无害，焦点已经离开） */
        on(container, 'focusout', function (event) {
            var field = closestFrom(event, FIELD);
            if (!field) return;
            var cellId = cellIdOf(field);
            if (!cellId) return;
            var name = field.getAttribute('data-xm-field') || 'prompt';
            var cell = graph.getCellById(cellId);
            drafts.delete(keyOf(cellId, name));
            if (!cell) return;
            var data = cell.getData() || {};
            var current = name === 'title' ? data.title : data.prompt;
            if (current === field.value) return;
            applyEdit(cell, name, field.value);
            if (typeof opts.onEdit === 'function') opts.onEdit({ cellId: cellId, field: name, value: field.value });
            container.dispatchEvent(new CustomEvent('xm:node-edit', {
                detail: { cellId: cellId, field: name, value: field.value },
                bubbles: true
            }));
        }, true);

        /* 节点被删除时清掉它的草稿，否则草稿表会一直攒着已不存在的 cellId */
        var onRemoved = function (args) {
            var cells = (args && args.cell) ? [args.cell] : ((args && args.cells) || []);
            cells.forEach(function (cell) { if (cell && cell.id) dropDraftsFor(cell.id); });
        };
        graph.on('node:removed', onRemoved);
        graph.on('cell:removed', onRemoved);

        return {
            dispose: function () {
                disposers.forEach(function (fn) { fn(); });
                graph.off('node:removed', onRemoved);
                graph.off('cell:removed', onRemoved);
                drafts.clear();
            }
        };
    }

    root.XmCanvasInteraction = {
        version: '1.0.0',
        install: install,
        draftOf: draftOf,
        setDraft: setDraft,
        applyEdit: applyEdit,
        flushDrafts: flushDrafts,
        dropDraftsFor: dropDraftsFor,
        get draftCount() { return drafts.size; }
    };
})(typeof window !== 'undefined' ? window : globalThis);
