(function(){
    'use strict';

    var NODE_TYPE = 'smart-drawing-board';
    var DEFAULT_LOGICAL_WIDTH = 1024;
    var DEFAULT_LOGICAL_HEIGHT = 768;
    var DEFAULT_NODE_WIDTH = 500;
    var DEFAULT_NODE_HEIGHT = 430;
    var MIN_NODE_WIDTH = 340;
    var MIN_NODE_HEIGHT = 320;
    var MAX_NODE_HEIGHT = 3200;
    var RATIO_SIZES = [
        {ratio:'1:1', width:1024, height:1024},
        {ratio:'4:3', width:1024, height:768},
        {ratio:'3:4', width:768, height:1024},
        {ratio:'3:2', width:1023, height:682},
        {ratio:'2:3', width:682, height:1023},
        {ratio:'16:9', width:1024, height:576},
        {ratio:'9:16', width:576, height:1024}
    ];
    var sessions = new Map();

    function text(key, fallback){
        return window.StudioI18n && typeof window.StudioI18n.t === 'function'
            ? (window.StudioI18n.t(key) || fallback)
            : fallback;
    }

    function escapeAttribute(value){
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function clamp(value, min, max){
        var number = Number(value);
        if(!Number.isFinite(number)) return min;
        return Math.max(min, Math.min(max, number));
    }

    function integer(value, fallback, min, max){
        var number = Number(value);
        if(!Number.isFinite(number)) number = fallback;
        number = Math.round(number);
        return Math.max(min, Math.min(max, number));
    }

    function clone(value){
        try { return JSON.parse(JSON.stringify(value)); } catch(_) { return value; }
    }

    function validColor(value, fallback){
        var color = String(value || '').trim();
        return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
    }

    function defaultState(){
        return {
            version:1,
            width:DEFAULT_LOGICAL_WIDTH,
            height:DEFAULT_LOGICAL_HEIGHT,
            background:'white',
            tool:'brush',
            color:'#111827',
            size:18,
            opacity:1,
            dirty:false,
            strokes:[]
        };
    }

    function normalizePoint(point, width, height){
        var x = Array.isArray(point) ? point[0] : point && point.x;
        var y = Array.isArray(point) ? point[1] : point && point.y;
        var pressure = Array.isArray(point) ? point[2] : point && point.pressure;
        return [
            clamp(x, 0, width),
            clamp(y, 0, height),
            clamp(Number.isFinite(Number(pressure)) ? pressure : 0.5, 0, 1)
        ];
    }

    function normalizeStroke(stroke, width, height){
        if(!stroke || typeof stroke !== 'object') return null;
        var rawPoints = Array.isArray(stroke.points) ? stroke.points : [];
        var points = rawPoints.map(function(point){ return normalizePoint(point, width, height); });
        if(!points.length) return null;
        return {
            points:points,
            color:validColor(stroke.color, '#111827'),
            size:clamp(stroke.size, 1, 240),
            opacity:clamp(stroke.opacity, 0.02, 1),
            tool:stroke.tool === 'eraser' ? 'eraser' : 'brush'
        };
    }

    function normalizeNode(node){
        if(!node || node.type !== NODE_TYPE) return node;
        var raw = node.drawingBoard && typeof node.drawingBoard === 'object' ? node.drawingBoard : {};
        var state = defaultState();
        state.width = integer(raw.width, DEFAULT_LOGICAL_WIDTH, 256, 4096);
        state.height = integer(raw.height, DEFAULT_LOGICAL_HEIGHT, 256, 4096);
        state.background = raw.background === 'transparent' ? 'transparent' : 'white';
        state.tool = raw.tool === 'eraser' ? 'eraser' : 'brush';
        state.color = validColor(raw.color, state.color);
        state.size = integer(raw.size, state.size, 1, 240);
        state.opacity = clamp(raw.opacity, 0.02, 1);
        state.dirty = raw.dirty === true;
        if(Number(raw.outputAt) > 0) state.outputAt = Number(raw.outputAt);
        state.strokes = (Array.isArray(raw.strokes) ? raw.strokes : [])
            .map(function(stroke){ return normalizeStroke(stroke, state.width, state.height); })
            .filter(Boolean);
        node.drawingBoard = state;
        node.images = Array.isArray(node.images) ? node.images : [];
        node.w = integer(node.w, DEFAULT_NODE_WIDTH, MIN_NODE_WIDTH, 1600);
        node.h = integer(node.h, DEFAULT_NODE_HEIGHT, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
        if(!String(node.title || '').trim() || node.title === 'Image' || node.title === 'Group'){
            node.title = text('smart.createDrawingBoardNode', '手绘板');
        }
        return node;
    }

    function stateSnapshot(state){
        return clone(state);
    }

    function ratioForSize(state){
        var ratio = state.width / state.height;
        var match = RATIO_SIZES.find(function(item){
            return Math.abs(item.width / item.height - ratio) < 0.004;
        });
        return match ? match.ratio : 'custom';
    }

    function measureLayout(element){
        var stage = element && element.querySelector('[data-drawing-stage]');
        if(!stage || !stage.clientWidth || !stage.offsetHeight) return null;
        return {
            widthInset:element.offsetWidth - stage.clientWidth,
            extraHeight:element.offsetHeight - stage.offsetHeight,
            stageBorder:stage.offsetHeight - stage.clientHeight
        };
    }

    function resizeNode(element, node, width, metrics){
        var layout = metrics || measureLayout(element);
        if(!layout) return false;
        var state = normalizeNode(node).drawingBoard;
        node.w = integer(width, node.w, MIN_NODE_WIDTH, 1600);
        var stageWidth = Math.max(1, node.w - layout.widthInset);
        node.h = integer(layout.extraHeight + layout.stageBorder + stageWidth * state.height / state.width,
            node.h, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
        element.style.width = node.w + 'px';
        element.style.height = node.h + 'px';
        return true;
    }

    function fitCanvas(card, canvas, state){
        var stage = card.querySelector('[data-drawing-stage]');
        if(!stage || !stage.clientWidth || !stage.clientHeight) return;
        var scale = Math.min(stage.clientWidth / state.width, stage.clientHeight / state.height);
        canvas.style.width = Math.max(1, state.width * scale) + 'px';
        canvas.style.height = Math.max(1, state.height * scale) + 'px';
    }

    function hasStrokes(node){
        var state = normalizeNode(node).drawingBoard;
        return Boolean(state.strokes && state.strokes.some(function(stroke){ return stroke.points.length > 0; }));
    }

    function strokeOutline(points, stroke, isLast){
        var api = window.PerfectFreehand;
        if(!api || typeof api.getStroke !== 'function') return [];
        return api.getStroke(points, {
            size:Math.max(1, Number(stroke.size) || 1),
            thinning:stroke.tool === 'eraser' ? 0 : 0.62,
            smoothing:0.58,
            streamline:0.38,
            simulatePressure:false,
            easing:function(value){ return value; },
            last:isLast !== false
        }) || [];
    }

    function drawOutline(context, outline){
        if(!outline || !outline.length) return false;
        context.beginPath();
        context.moveTo(outline[0][0], outline[0][1]);
        for(var index = 1; index < outline.length; index += 1){
            context.lineTo(outline[index][0], outline[index][1]);
        }
        context.closePath();
        context.fill();
        return true;
    }

    function drawFallbackStroke(context, stroke){
        var points = stroke.points || [];
        if(!points.length) return;
        var last = points[points.length - 1];
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.lineWidth = Math.max(1, Number(stroke.size) || 1) * (0.55 + clamp(last[2], 0, 1) * 0.8);
        context.beginPath();
        context.moveTo(points[0][0], points[0][1]);
        for(var index = 1; index < points.length; index += 1){
            context.lineTo(points[index][0], points[index][1]);
        }
        if(points.length === 1){
            context.arc(points[0][0], points[0][1], context.lineWidth / 2, 0, Math.PI * 2);
        }
        context.stroke();
    }

    function drawStroke(context, stroke, state, isLast){
        if(!stroke || !stroke.points || !stroke.points.length) return;
        context.save();
        var eraser = stroke.tool === 'eraser';
        context.globalCompositeOperation = eraser && state.background === 'transparent'
            ? 'destination-out'
            : 'source-over';
        context.globalAlpha = clamp(stroke.opacity, 0.02, 1);
        context.fillStyle = eraser
            ? (state.background === 'transparent' ? '#000000' : '#ffffff')
            : validColor(stroke.color, '#111827');
        context.strokeStyle = context.fillStyle;
        var outline = strokeOutline(stroke.points, stroke, isLast);
        if(!drawOutline(context, outline)) drawFallbackStroke(context, stroke);
        context.restore();
    }

    function paintCanvas(node, target, pixelRatio, activeStroke){
        var state = normalizeNode(node).drawingBoard;
        var canvas = target || document.createElement('canvas');
        var scale = clamp(pixelRatio || 1, 1, 3);
        var width = state.width;
        var height = state.height;
        var pixelWidth = Math.max(1, Math.round(width * scale));
        var pixelHeight = Math.max(1, Math.round(height * scale));
        if(canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if(canvas.height !== pixelHeight) canvas.height = pixelHeight;
        var context = canvas.getContext('2d');
        if(!context) return canvas;
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, width, height);
        if(state.background === 'white'){
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
        }
        state.strokes.forEach(function(stroke){ drawStroke(context, stroke, state, true); });
        if(activeStroke) drawStroke(context, activeStroke, state, true);
        return canvas;
    }

    function pointFromEvent(event, canvas, state){
        var rect = canvas.getBoundingClientRect();
        var width = Math.max(1, rect.width);
        var height = Math.max(1, rect.height);
        var pressure = event.pointerType === 'mouse'
            ? 0.5
            : (Number(event.pressure) > 0 ? clamp(event.pressure, 0, 1) : 0.5);
        return [
            clamp((event.clientX - rect.left) / width * state.width, 0, state.width),
            clamp((event.clientY - rect.top) / height * state.height, 0, state.height),
            pressure
        ];
    }

    function appendPoint(points, point, force){
        if(!points.length || force){
            points.push(point);
            return;
        }
        var previous = points[points.length - 1];
        if(Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 0.25 || Math.abs(point[2] - previous[2]) >= 0.02){
            points.push(point);
        }
    }

    function canEdit(node, options){
        return !options.canEdit || options.canEdit(node) !== false;
    }

    function prepareChange(node, options){
        if(!canEdit(node, options)) return false;
        if(typeof options.onBeforeChange === 'function' && options.onBeforeChange(node) === false) return false;
        return true;
    }

    function changed(node, options, detail){
        if(typeof options.onChanged === 'function') options.onChanged(node, detail || {});
    }

    function syncCard(card, node, session){
        if(!card || !node) return;
        var state = normalizeNode(node).drawingBoard;
        var outputReady = (node.images || []).some(function(image){ return image && image.url; });
        var status = session.exporting
            ? text('smart.drawingBoardExporting', '正在输出…')
            : state.dirty && outputReady
            ? text('smart.drawingBoardOutputStale', '有未输出修改')
            : outputReady
            ? text('smart.drawingBoardOutputReady', '已输出')
            : hasStrokes(node)
            ? text('smart.drawingBoardOutputWaiting', '待输出')
            : text('smart.drawingBoardOutputEmpty', '尚未输出');
        var statusEl = card.querySelector('[data-drawing-status]');
        if(statusEl) statusEl.textContent = status;
        var emptyEl = card.querySelector('[data-drawing-empty]');
        if(emptyEl) emptyEl.hidden = hasStrokes(node);
        var exportButton = card.querySelector('[data-drawing-action="export"]');
        if(exportButton){
            exportButton.disabled = session.exporting || !hasStrokes(node);
            exportButton.classList.toggle('is-busy', session.exporting);
        }
        card.querySelectorAll('[data-drawing-tool]').forEach(function(button){
            var active = button.dataset.drawingTool === state.tool;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        var color = card.querySelector('[data-drawing-color]');
        if(color && color.value !== state.color) color.value = state.color;
        var size = card.querySelector('[data-drawing-size]');
        if(size) size.value = String(state.size);
        var sizeValue = card.querySelector('[data-drawing-size-value]');
        if(sizeValue) sizeValue.textContent = String(state.size);
        var opacity = card.querySelector('[data-drawing-opacity]');
        if(opacity) opacity.value = String(Math.round(state.opacity * 100));
        var opacityValue = card.querySelector('[data-drawing-opacity-value]');
        if(opacityValue) opacityValue.textContent = String(Math.round(state.opacity * 100)) + '%';
        var ratioSelect = card.querySelector('[data-drawing-ratio]');
        if(ratioSelect){
            var currentRatio = ratioForSize(state);
            var customOption = ratioSelect.querySelector('option[value="custom"]');
            if(currentRatio === 'custom' && !customOption){
                customOption = document.createElement('option');
                customOption.value = 'custom';
                customOption.textContent = text('smart.drawingBoardCustomRatio', '当前尺寸');
                ratioSelect.appendChild(customOption);
            } else if(currentRatio !== 'custom' && customOption){
                customOption.remove();
            }
            ratioSelect.value = currentRatio;
            ratioSelect.title = state.width + ' × ' + state.height;
        }
        var backgroundButton = card.querySelector('[data-drawing-action="background"]');
        if(backgroundButton){
            var transparent = state.background === 'transparent';
            backgroundButton.classList.toggle('active', transparent);
            backgroundButton.setAttribute('aria-pressed', transparent ? 'true' : 'false');
            backgroundButton.querySelector('[data-drawing-background-label]').textContent = transparent
                ? text('smart.drawingBoardBackgroundTransparent', '透明')
                : text('smart.drawingBoardBackgroundWhite', '白底');
            backgroundButton.title = transparent
                ? text('smart.drawingBoardBackgroundWhite', '切换为白底')
                : text('smart.drawingBoardBackgroundTransparent', '切换为透明背景');
        }
    }

    function bodyHtml(node){
        normalizeNode(node);
        var state = node.drawingBoard;
        var outputReady = (node.images || []).some(function(image){ return image && image.url; });
        var activeBrush = state.tool === 'brush' ? ' active' : '';
        var activeEraser = state.tool === 'eraser' ? ' active' : '';
        var backgroundLabel = state.background === 'transparent'
            ? text('smart.drawingBoardBackgroundTransparent', '透明')
            : text('smart.drawingBoardBackgroundWhite', '白底');
        var outputStatus = outputReady
            ? text('smart.drawingBoardOutputReady', '已输出')
            : hasStrokes(node)
            ? text('smart.drawingBoardOutputWaiting', '待输出')
            : text('smart.drawingBoardOutputEmpty', '尚未输出');
        var brushTitle = text('smart.drawingBoardBrush', '画笔');
        var eraserTitle = text('smart.drawingBoardEraser', '橡皮');
        var colorTitle = text('smart.drawingBoardColor', '颜色');
        var sizeTitle = text('smart.drawingBoardSize', '笔刷大小');
        var opacityTitle = text('smart.drawingBoardOpacity', '不透明度');
        var undoTitle = text('smart.drawingBoardUndo', '撤销');
        var redoTitle = text('smart.drawingBoardRedo', '恢复');
        var clearTitle = text('smart.drawingBoardClear', '清空');
        var exportTitle = text('smart.drawingBoardExport', '输出图片');
        var ratioTitle = text('smart.drawingBoardRatio', '比例');
        var currentRatio = ratioForSize(state);
        var ratioOptions = RATIO_SIZES.map(function(item){
            return '<option value="' + item.ratio + '"' + (currentRatio === item.ratio ? ' selected' : '') + '>' + item.ratio + '</option>';
        }).join('');
        if(currentRatio === 'custom') ratioOptions += '<option value="custom" selected>' + escapeAttribute(text('smart.drawingBoardCustomRatio', '当前尺寸')) + '</option>';
        return [
            '<div class="drawing-board-card" data-drawing-board-card>',
                '<div class="drawing-board-toolbar" role="toolbar" aria-label="' + escapeAttribute(text('smart.drawingBoardToolbar', '手绘板工具')) + '">',
                    '<div class="drawing-board-tool-group">',
                        '<button type="button" class="drawing-board-tool' + activeBrush + '" data-drawing-tool="brush" aria-pressed="' + (state.tool === 'brush' ? 'true' : 'false') + '" title="' + escapeAttribute(brushTitle) + '" aria-label="' + escapeAttribute(brushTitle) + '"><i data-lucide="paintbrush"></i></button>',
                        '<button type="button" class="drawing-board-tool' + activeEraser + '" data-drawing-tool="eraser" aria-pressed="' + (state.tool === 'eraser' ? 'true' : 'false') + '" title="' + escapeAttribute(eraserTitle) + '" aria-label="' + escapeAttribute(eraserTitle) + '"><i data-lucide="eraser"></i></button>',
                    '</div>',
                    '<label class="drawing-board-color" title="' + escapeAttribute(colorTitle) + '" aria-label="' + escapeAttribute(colorTitle) + '"><span class="drawing-board-sr-only">' + escapeAttribute(colorTitle) + '</span><input type="color" data-drawing-color value="' + escapeAttribute(state.color) + '"></label>',
                    '<label class="drawing-board-range" title="' + escapeAttribute(sizeTitle) + '"><i data-lucide="circle-dot"></i><input type="range" data-drawing-size min="1" max="120" step="1" value="' + escapeAttribute(state.size) + '" aria-label="' + escapeAttribute(sizeTitle) + '"><output data-drawing-size-value>' + escapeAttribute(state.size) + '</output></label>',
                    '<label class="drawing-board-range drawing-board-opacity" title="' + escapeAttribute(opacityTitle) + '"><i data-lucide="circle-half"></i><input type="range" data-drawing-opacity min="2" max="100" step="1" value="' + escapeAttribute(Math.round(state.opacity * 100)) + '" aria-label="' + escapeAttribute(opacityTitle) + '"><output data-drawing-opacity-value>' + escapeAttribute(Math.round(state.opacity * 100)) + '%</output></label>',
                    '<div class="drawing-board-tool-group drawing-board-history">',
                        '<button type="button" data-drawing-action="undo" title="' + escapeAttribute(undoTitle) + '" aria-label="' + escapeAttribute(undoTitle) + '"><i data-lucide="undo-2"></i></button>',
                        '<button type="button" data-drawing-action="redo" title="' + escapeAttribute(redoTitle) + '" aria-label="' + escapeAttribute(redoTitle) + '"><i data-lucide="redo-2"></i></button>',
                        '<button type="button" data-drawing-action="clear" title="' + escapeAttribute(clearTitle) + '" aria-label="' + escapeAttribute(clearTitle) + '"><i data-lucide="trash-2"></i></button>',
                    '</div>',
                '</div>',
                '<div class="drawing-board-stage" data-drawing-stage>',
                    '<canvas data-drawing-canvas tabindex="0" aria-label="' + escapeAttribute(text('smart.drawingBoardCanvas', '手绘画布')) + '"></canvas>',
                    '<div class="drawing-board-empty" data-drawing-empty' + (hasStrokes(node) ? ' hidden' : '') + '><i data-lucide="pen-line"></i><span>' + escapeAttribute(text('smart.drawingBoardEmpty', '在画布中绘制')) + '</span></div>',
                '</div>',
                '<div class="drawing-board-footer">',
                    '<button type="button" class="drawing-board-background" data-drawing-action="background" aria-pressed="' + (state.background === 'transparent' ? 'true' : 'false') + '" title="' + escapeAttribute(state.background === 'transparent' ? text('smart.drawingBoardBackgroundWhite', '切换为白底') : text('smart.drawingBoardBackgroundTransparent', '切换为透明背景')) + '"><i data-lucide="square-dashed"></i><span data-drawing-background-label>' + escapeAttribute(backgroundLabel) + '</span></button>',
                    '<label class="drawing-board-ratio"><span>' + escapeAttribute(ratioTitle) + '</span><select data-drawing-ratio aria-label="' + escapeAttribute(ratioTitle) + '" title="' + state.width + ' × ' + state.height + '">' + ratioOptions + '</select></label>',
                    '<span class="drawing-board-status" data-drawing-status aria-live="polite">' + escapeAttribute(outputStatus) + '</span>',
                    '<button type="button" class="drawing-board-export" data-drawing-action="export" title="' + escapeAttribute(exportTitle) + '"><i data-lucide="send"></i><span>' + escapeAttribute(exportTitle) + '</span></button>',
                '</div>',
            '</div>'
        ].join('');
    }

    function bindNode(element, node, options){
        options = options || {};
        if(!element || !node) return;
        normalizeNode(node);
        var card = element.querySelector('[data-drawing-board-card]');
        var canvas = card && card.querySelector('[data-drawing-canvas]');
        var stage = card && card.querySelector('[data-drawing-stage]');
        if(!card || !canvas) return;
        resizeNode(element, node, node.w);
        var session = sessions.get(node.id);
        if(!session){
            session = {undo:[], redo:[], active:null, exporting:false};
            sessions.set(node.id, session);
        }
        if(session.resizeObserver && session.stage !== stage) session.resizeObserver.disconnect();
        session.card = card;
        session.canvas = canvas;
        session.stage = stage;
        paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
        fitCanvas(card, canvas, node.drawingBoard);
        if(window.ResizeObserver && (!session.resizeObserver || session.observedStage !== stage)){
            session.resizeObserver = new ResizeObserver(function(){
                if(session.stage === stage) fitCanvas(card, canvas, normalizeNode(node).drawingBoard);
            });
            session.resizeObserver.observe(stage);
            session.observedStage = stage;
        }
        syncCard(card, node, session);
        if(canvas.dataset.drawingBoardBound === '1') return;
        canvas.dataset.drawingBoardBound = '1';

        function focusNode(){
            if(typeof options.onFocus === 'function') options.onFocus(node);
        }

        function stop(event){
            event.stopPropagation();
        }

        ['mousedown','mouseup','click','dblclick','wheel'].forEach(function(type){
            canvas.addEventListener(type, stop, true);
        });
        card.querySelectorAll('button,input,label,select').forEach(function(control){
            ['pointerdown','mousedown','dblclick','wheel'].forEach(function(type){
                control.addEventListener(type, stop, true);
            });
            // 不在捕获阶段截断同一按钮的业务 click，否则输出、撤销等处理器不会执行。
            control.addEventListener('click', stop, false);
        });

        function addEventPoints(event, active, force){
            var state = normalizeNode(node).drawingBoard;
            // Chromium/Electron 的合并采样可能来自事件派发前的旧布局矩阵。
            // 这些点在画布缩放、平移或外层 iframe 缩放后会整体落到旧位置，
            // 即使把当前事件补在末尾，旧点仍会把笔迹“拖”向错误方向。
            // 画布只记录当前事件，并由 perfect-freehand 负责平滑，保证每个采样
            // 都使用当前可见画布的 client rect。
            appendPoint(active.points, pointFromEvent(event, canvas, state), force);
        }

        function beginStroke(event, inputSource, inputId){
            if(session.active) return;
            if(event.button != null && event.button !== 0) return;
            if(!canEdit(node, options)) return;
            event.preventDefault();
            event.stopPropagation();
            focusNode();
            var state = normalizeNode(node).drawingBoard;
            var active = {
                inputSource:inputSource,
                pointerId:inputId,
                before:stateSnapshot(state),
                stroke:{
                    points:[],
                    color:state.color,
                    size:state.size,
                    opacity:state.opacity,
                    tool:state.tool
                }
            };
            session.active = active;
            addEventPoints(event, active.stroke, true);
            if(inputSource === 'pointer' && canvas.setPointerCapture && event.pointerId != null){
                try { canvas.setPointerCapture(event.pointerId); } catch(_) {}
            }
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), active.stroke);
        }

        function moveStroke(event, inputSource, inputId){
            var active = session.active;
            if(!active || active.inputSource !== inputSource || active.pointerId !== inputId) return;
            event.preventDefault();
            event.stopPropagation();
            addEventPoints(event, active.stroke, false);
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), active.stroke);
        }

        function releasePointer(event){
            if(event.pointerId == null || !canvas.releasePointerCapture || !canvas.hasPointerCapture) return;
            try {
                if(canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            } catch(_) {}
        }

        function cancelStroke(event, inputSource, inputId){
            var active = session.active;
            if(!active || active.inputSource !== inputSource || active.pointerId !== inputId) return;
            event.preventDefault();
            event.stopPropagation();
            session.active = null;
            if(inputSource === 'pointer') releasePointer(event);
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            syncCard(card, node, session);
        }

        function finishStroke(event, inputSource, inputId){
            var active = session.active;
            if(!active || active.inputSource !== inputSource || active.pointerId !== inputId) return;
            event.preventDefault();
            event.stopPropagation();
            addEventPoints(event, active.stroke, false);
            session.active = null;
            if(inputSource === 'pointer') releasePointer(event);
            if(!canEdit(node, options) || !prepareChange(node, options)){
                paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
                syncCard(card, node, session);
                return;
            }
            var state = normalizeNode(node).drawingBoard;
            session.undo.push(active.before);
            state.strokes = state.strokes.concat([active.stroke]);
            state.dirty = true;
            session.redo = [];
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            syncCard(card, node, session);
            changed(node, options, {type:'stroke'});
        }

        function beginPointer(event){ beginStroke(event, 'pointer', event.pointerId); }
        function movePointer(event){ moveStroke(event, 'pointer', event.pointerId); }
        function finishPointer(event){ finishStroke(event, 'pointer', event.pointerId); }
        function cancelPointer(event){ cancelStroke(event, 'pointer', event.pointerId); }
        // 某些 Windows 触摸桥接、旧 WebView 或数位板驱动只派发鼠标事件。
        // Pointer Events 可用时它们会先触发，session.active 会阻止兼容事件重复落笔。
        function beginMouse(event){ beginStroke(event, 'mouse', 'mouse'); }
        function moveMouse(event){ moveStroke(event, 'mouse', 'mouse'); }
        function finishMouse(event){ finishStroke(event, 'mouse', 'mouse'); }

        canvas.addEventListener('pointerdown', beginPointer, false);
        canvas.addEventListener('pointermove', movePointer, false);
        canvas.addEventListener('pointerup', finishPointer, false);
        canvas.addEventListener('pointercancel', cancelPointer, false);
        canvas.addEventListener('lostpointercapture', cancelPointer, false);
        // 上面的画布事件隔离器会在捕获阶段阻止节点拖动；兼容鼠标事件也要
        // 在同一目标的捕获阶段接住，否则旧 WebView 的 mouse 事件到不了这里。
        canvas.addEventListener('mousedown', beginMouse, true);
        canvas.addEventListener('mousemove', moveMouse, false);
        canvas.addEventListener('mouseup', finishMouse, true);

        card.querySelectorAll('[data-drawing-tool]').forEach(function(button){
            button.addEventListener('click', function(event){
                event.preventDefault();
                event.stopPropagation();
                if(!canEdit(node, options)) return;
                focusNode();
                var state = normalizeNode(node).drawingBoard;
                state.tool = button.dataset.drawingTool === 'eraser' ? 'eraser' : 'brush';
                syncCard(card, node, session);
                changed(node, options, {type:'tool'});
            });
        });

        card.querySelector('[data-drawing-color]') && card.querySelector('[data-drawing-color]').addEventListener('input', function(event){
            event.stopPropagation();
            if(!canEdit(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            state.color = validColor(event.target.value, state.color);
            state.tool = 'brush';
            syncCard(card, node, session);
            changed(node, options, {type:'color'});
        });
        card.querySelector('[data-drawing-size]') && card.querySelector('[data-drawing-size]').addEventListener('input', function(event){
            event.stopPropagation();
            if(!canEdit(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            state.size = integer(event.target.value, state.size, 1, 240);
            syncCard(card, node, session);
            changed(node, options, {type:'size'});
        });
        card.querySelector('[data-drawing-opacity]') && card.querySelector('[data-drawing-opacity]').addEventListener('input', function(event){
            event.stopPropagation();
            if(!canEdit(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            state.opacity = clamp(Number(event.target.value) / 100, 0.02, 1);
            syncCard(card, node, session);
            changed(node, options, {type:'opacity'});
        });
        card.querySelector('[data-drawing-ratio]') && card.querySelector('[data-drawing-ratio]').addEventListener('change', function(event){
            event.stopPropagation();
            var preset = RATIO_SIZES.find(function(item){ return item.ratio === event.target.value; });
            var state = normalizeNode(node).drawingBoard;
            if(!preset || ratioForSize(state) === preset.ratio || !prepareChange(node, options)){
                syncCard(card, node, session);
                return;
            }
            focusNode();
            session.undo.push(stateSnapshot(state));
            var scale = Math.min(preset.width / state.width, preset.height / state.height);
            var offsetX = (preset.width - state.width * scale) / 2;
            var offsetY = (preset.height - state.height * scale) / 2;
            state.strokes = state.strokes.map(function(stroke){
                return {
                    points:stroke.points.map(function(point){
                        return [point[0] * scale + offsetX, point[1] * scale + offsetY, point[2]];
                    }),
                    color:stroke.color,
                    size:stroke.size * scale,
                    opacity:stroke.opacity,
                    tool:stroke.tool
                };
            });
            state.width = preset.width;
            state.height = preset.height;
            state.dirty = true;
            session.redo = [];
            resizeNode(element, node, node.w);
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            fitCanvas(card, canvas, state);
            syncCard(card, node, session);
            changed(node, options, {type:'ratio', layoutChanged:true});
        });

        function undo(){
            if(!session.undo.length || !prepareChange(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            session.redo.push(stateSnapshot(state));
            node.drawingBoard = session.undo.pop();
            var layoutChanged = state.width !== node.drawingBoard.width || state.height !== node.drawingBoard.height;
            if(layoutChanged) resizeNode(element, node, node.w);
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            fitCanvas(card, canvas, node.drawingBoard);
            syncCard(card, node, session);
            changed(node, options, {type:'undo', layoutChanged:layoutChanged});
        }

        function redo(){
            if(!session.redo.length || !prepareChange(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            session.undo.push(stateSnapshot(state));
            node.drawingBoard = session.redo.pop();
            var layoutChanged = state.width !== node.drawingBoard.width || state.height !== node.drawingBoard.height;
            if(layoutChanged) resizeNode(element, node, node.w);
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            fitCanvas(card, canvas, node.drawingBoard);
            syncCard(card, node, session);
            changed(node, options, {type:'redo', layoutChanged:layoutChanged});
        }

        function clear(){
            var state = normalizeNode(node).drawingBoard;
            if(!state.strokes.length || !prepareChange(node, options)) return;
            session.undo.push(stateSnapshot(state));
            state.strokes = [];
            state.dirty = true;
            session.redo = [];
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            syncCard(card, node, session);
            changed(node, options, {type:'clear'});
        }

        function toggleBackground(){
            if(!prepareChange(node, options)) return;
            var state = normalizeNode(node).drawingBoard;
            session.undo.push(stateSnapshot(state));
            state.background = state.background === 'transparent' ? 'white' : 'transparent';
            state.dirty = true;
            session.redo = [];
            paintCanvas(node, canvas, Math.min(2, window.devicePixelRatio || 1), null);
            syncCard(card, node, session);
            changed(node, options, {type:'background'});
        }

        card.querySelectorAll('[data-drawing-action]').forEach(function(button){
            button.addEventListener('click', function(event){
                event.preventDefault();
                event.stopPropagation();
                focusNode();
                var action = button.dataset.drawingAction;
                if(action === 'undo') undo();
                else if(action === 'redo') redo();
                else if(action === 'clear') clear();
                else if(action === 'background') toggleBackground();
                else if(action === 'export'){
                    if(session.exporting || !hasStrokes(node) || typeof options.onExport !== 'function') return;
                    if(!canEdit(node, options)) return;
                    session.exporting = true;
                    syncCard(card, node, session);
                    Promise.resolve(options.onExport(node)).catch(function(error){
                        if(typeof options.onExportError === 'function') options.onExportError(error, node);
                    }).finally(function(){
                        session.exporting = false;
                        var currentCard = session.card && session.card.isConnected ? session.card : card;
                        if(currentCard && currentCard.isConnected) syncCard(currentCard, node, session);
                    });
                }
            });
        });
    }

    window.SmartDrawingBoard = {
        nodeType:NODE_TYPE,
        defaultNodeSize:function(){ return {width:DEFAULT_NODE_WIDTH, height:DEFAULT_NODE_HEIGHT}; },
        defaultState:defaultState,
        normalizeNode:normalizeNode,
        bodyHtml:bodyHtml,
        bindNode:bindNode,
        hasStrokes:hasStrokes,
        toBlob:function(node){
            var canvas = paintCanvas(node, document.createElement('canvas'), 1, null);
            return new Promise(function(resolve){ canvas.toBlob(resolve, 'image/png'); });
        },
        logicalSize:function(node){
            var state = normalizeNode(node).drawingBoard;
            return {width:state.width, height:state.height};
        },
        measureLayout:measureLayout,
        resizeNode:resizeNode
    };
})();
