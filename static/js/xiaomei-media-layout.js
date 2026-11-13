/* Xiaomei media layout kernel.
 *
 * 图片/视频类节点的尺寸推导。这是从 smart-canvas.js 的 imageLayout() 里
 * **只抽出图片路径**的那部分规则，供画布引擎在脱离 smart-canvas.js 时使用。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 * 引擎的适配层原本自带一套"看起来合理"的尺寸推导，实测与旧画布只有 43% 一致：
 * smart-paint 中位差 94×100px、最坏 247%。原因是旧画布的规则远比"按比例塞进
 * 一个框"复杂——手调尺寸优先、音视频/文档各有固定框、多图要按真实宽高比收紧
 * 网格、生成中要按待出图数量排格子。
 *
 * 这些规则全部属于小美自己的原创逻辑，没有第三方来源问题，所以直接抽出来复用，
 * 而不是在新引擎里另写一套近似的。阶段 5 会让 smart-canvas.js 也改为调用这里，
 * 届时重复实现只剩这一份。
 *
 * ── 为什么只抽图片路径 ─────────────────────────────────────────────
 * imageLayout() 前面还有二十来个节点专属分支（AI 渲染、复刻、画板、ComfyUI、
 * 对比、色卡、表格、时间线、提示词、智能体、循环、分组、商品保真、局部融合、
 * 详情拼接…），每个都牵动更多辅助函数。实测这些类型在真实数据里只占 10%，
 * 而且适配层现有的按类型默认值已经能对上（分组 7%、智能体 0%、ComfyUI 0%）。
 * 所以这里只覆盖真正的大头，其余由调用方按类型兜底。
 *
 * ── 漂移防线 ───────────────────────────────────────────────────────
 * tests/canvas-engine-parity.browser.cjs 会把本文件的输出与 smart-canvas.js
 * 里 imageLayout() 的输出逐节点对比。任何一边改了规则，用例立刻失败。
 * 这比在注释里写"记得同步"可靠得多。
 */
(function (root) {
    'use strict';

    /* 与 smart-canvas.js:2860-2869 的常量保持一致 */
    var MEDIA_NODE_DEFAULT_SCALE = 2;
    var MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE = 1.6;
    var MEDIA_GROUP_DEFAULT_SCALE = 0.8;
    var GENERATED_MEDIA_GROUP_DEFAULT_SCALE = 1;
    var MEDIA_GROUP_THUMB_BASE = 224;
    var MEDIA_GROUP_MAX_VISIBLE_ROWS = 3;

    var EMPTY_UPLOAD_W = 316;
    var EMPTY_UPLOAD_H = 194;
    var EMPTY_PAINT_W = 300;
    var EMPTY_PAINT_H = 300;

    var DOCUMENT_EXT = /\.(xmind|docx?|wps|xlsx?|et|pptx?|dps|pdf|txt|md|markdown|csv|json|xml|yaml|yml|log)$/i;
    var TEXT_EXT = /\.(txt|json|csv|srt|vtt|md)(\?|$)/;
    var AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/;
    var VIDEO_EXT = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/;

    /* 走「图片路径」的节点类型。其余类型在 imageLayout() 里都有更早的分支，
       本文件不覆盖，由调用方按类型给默认值。 */
    var IMAGE_PATH_TYPES = {
        'smart-upload': true,
        'smart-paint': true,
        'smart-video': true,
        'smart-image': true,
        'generator': true
    };

    function finite(value) {
        var number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function round(value) {
        return Math.round(value);
    }

    /* 与 XiaomeiCanvasEditorCore.originalMediaUrl() 等价。
     *
     * 旧实现是 `new URL(raw, origin)` 后判断 pathname 是否为 /api/media-preview，
     * 是就取 ?url= 里的真实地址。这个解包不能省：预览代理的路径没有扩展名，
     * 不解包就看不出 mp4/mp3/pdf，音视频和文档节点会全部掉进图片分支，
     * 尺寸差到 800px 以上（实测 smart-upload 有 9 个节点因此跑偏）。
     *
     * 这里不直接依赖 canvas-editor-core.js，因为引擎要能独立启动；
     * 但两者行为必须一致，所以下面几行逐句对齐。 */
    function originalUrl(item) {
        var raw = typeof item === 'string' ? item : String((item && item.url) || '');
        if (!raw) return '';
        try {
            var origin = root.location && root.location.origin;
            var parsed = new URL(raw, origin || undefined);
            if (parsed.pathname === '/api/media-preview') {
                return parsed.searchParams.get('url') || raw;
            }
        } catch (error) { /* 非标准 URL（相对路径、data:）直接返回原值 */ }
        return raw;
    }

    /* 媒体自然尺寸。字段优先级与旧画布一致（natural_w 优先，其次 width/w/layout_w/preview_w）。 */
    function mediaLayoutSize(image) {
        var width = finite(image && (image.natural_w || image.width || image.w || image.layout_w || image.preview_w)) || 0;
        var height = finite(image && (image.natural_h || image.height || image.h || image.layout_h || image.preview_h)) || 0;
        return width > 0 && height > 0 ? { width: width, height: height } : { width: 0, height: 0 };
    }

    function isTextMediaItem(image) {
        if (!image) return false;
        if (image.kind === 'text') return true;
        return TEXT_EXT.test(originalUrl(image).toLowerCase());
    }

    function isAudioMediaItem(image) {
        if (!image) return false;
        if (image.kind === 'audio') return true;
        return AUDIO_EXT.test(originalUrl(image).toLowerCase());
    }

    function isVideoMediaItem(image) {
        if (!image) return false;
        if (image.kind === 'video') return true;
        return VIDEO_EXT.test(originalUrl(image).toLowerCase());
    }

    function isFileMediaItem(image) {
        if (!image) return false;
        if (image.kind === 'file') return true;
        /* 旧实现这里用的是 item.url 原值而不是解包后的地址，逐字对齐：
           文档类上传不会走 /api/media-preview 代理，用原值反而更稳。 */
        var path = String(image.url || '').split(/[?#]/)[0];
        return DOCUMENT_EXT.test(path) && !isTextMediaItem(image);
    }

    function mediaKindOf(image) {
        if (isFileMediaItem(image)) return 'file';
        if (isTextMediaItem(image)) return 'text';
        if (isAudioMediaItem(image)) return 'audio';
        if (isVideoMediaItem(image)) return 'video';
        return 'image';
    }

    function isSmartImageNode(node) {
        var type = (node && node.type) || 'smart-image';
        return type === 'smart-upload' || type === 'smart-paint' || type === 'smart-video'
            || type === 'smart-image' || type === 'generator';
    }

    function isGeneratedMediaGroup(node) {
        var images = (node && node.images) || [];
        if (images.length <= 1) return false;
        var anyGenerated = images.some(function (image) { return Boolean(image && image.generatedResult); });
        return anyGenerated || Boolean(node && (node.runAt || node.runPrompt || node.runModelPrompt
            || node.sourceNodeId || node.generatedBatchRootId));
    }

    /* 调用点传进来的 scale（smart-canvas.js 的 nodeScale）：
       默认 1；多图节点上遗留的 1.6 迁移为 0.8。 */
    function nodeScale(node) {
        var value = finite(node && node.scale);
        if (((node && node.images) || []).length > 1 && value === MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE) {
            return MEDIA_GROUP_DEFAULT_SCALE;
        }
        return value !== null && value > 0 ? value : 1;
    }

    /* 图片节点自己再算一次：生成结果组的默认比例与普通节点不同，
       且未手动拉伸的节点才迁移，手动尺寸节点继续完全遵循 w/h。 */
    function mediaNodeDefaultScale(node) {
        var images = (node && node.images) || [];
        var value = finite(node && node.scale);
        if (isGeneratedMediaGroup(node) && node.manualSize !== true
            && (value === null || value === MEDIA_NODE_DEFAULT_SCALE
                || value === MEDIA_GROUP_DEFAULT_SCALE || value === MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE)) {
            return GENERATED_MEDIA_GROUP_DEFAULT_SCALE;
        }
        if (images.length > 1 && value === null) return MEDIA_GROUP_DEFAULT_SCALE;
        return value !== null && value > 0 ? value : MEDIA_NODE_DEFAULT_SCALE;
    }

    /* 网格的公共宽高比：优先取图片真实宽高比的中位数，其次取生成参数里的比例。 */
    var RATIO_ALIASES = {
        square: 1, portrait: 2 / 3, landscape: 3 / 2, portrait43: 3 / 4, landscape43: 4 / 3,
        story: 9 / 16, wide: 16 / 9, ultrawide: 21 / 9, ultratall: 9 / 21
    };

    function imageGridAspect(node, images) {
        var aspects = (images || []).map(mediaLayoutSize)
            .filter(function (size) { return size.width > 0 && size.height > 0; })
            .map(function (size) { return size.width / size.height; })
            .sort(function (a, b) { return a - b; });
        if (aspects.length) {
            return Math.max(0.18, Math.min(5.5, aspects[Math.floor(aspects.length / 2)]));
        }
        var settings = (node && node.runSettings) || {};
        var customW = finite(settings.customWidth) || 0;
        var customH = finite(settings.customHeight) || 0;
        if (customW > 0 && customH > 0) {
            return Math.max(0.18, Math.min(5.5, customW / customH));
        }
        var candidates = [settings.customSize, settings.size, settings.ratio,
            settings.aspectRatio, settings.aspect_ratio, settings.videoAspect];
        for (var index = 0; index < candidates.length; index += 1) {
            var text = String(candidates[index] || '').trim().toLowerCase();
            if (!text) continue;
            if (RATIO_ALIASES[text]) return RATIO_ALIASES[text];
            var match = text.replace(/：/g, ':').match(/(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)/);
            if (match) {
                var width = Number(match[1]);
                var height = Number(match[2]);
                if (width > 0 && height > 0) return Math.max(0.18, Math.min(5.5, width / height));
            }
        }
        return 0;
    }

    /* 按可用边界挑一个「格子尽量大、留白尽量小」的列数。
       评分顺序与原实现一致：先保证能放下，再比格子大小，再比是否吃到上限，最后比留白。 */
    function groupImageGridLayout(count, explicitW, explicitH, maxThumb, pad, gap, maxVisibleRows) {
        var PAD = pad == null ? 32 : pad;
        var GAP = gap == null ? 8 : gap;
        var MAX_ROWS = maxVisibleRows == null ? MEDIA_GROUP_MAX_VISIBLE_ROWS : maxVisibleRows;
        var best = null;

        for (var cols = 1; cols <= count; cols += 1) {
            var rows = Math.ceil(count / cols);
            var visibleRows = Math.min(Math.max(1, MAX_ROWS), rows);
            var availableW = explicitW - PAD - (cols - 1) * GAP;
            var availableH = explicitH - PAD - (visibleRows - 1) * GAP;
            if (availableW <= 0 || availableH <= 0) continue;

            var rawThumb = Math.floor(Math.min(availableW / cols, availableH / visibleRows));
            var fittedThumb = Math.max(28, Math.min(maxThumb, rawThumb));
            var fits = rawThumb >= 28;
            var usedW = cols * fittedThumb + (cols - 1) * GAP + PAD;
            var usedH = visibleRows * fittedThumb + (visibleRows - 1) * GAP + PAD;
            var spareW = Math.max(0, explicitW - usedW);
            var spareH = Math.max(0, explicitH - usedH);
            var atMax = fittedThumb >= maxThumb;
            var score = [fits ? 1 : 0, fittedThumb, atMax ? cols : 0, -(spareW + spareH * 0.35), -rows];

            var better = !best;
            if (best) {
                for (var i = 0; i < score.length; i += 1) {
                    if (score[i] === best.score[i]) continue;
                    better = score[i] > best.score[i];
                    break;
                }
            }
            if (better) best = { cols: cols, rows: rows, visibleRows: visibleRows, thumb: fittedThumb, score: score };
        }

        if (best) return best;
        var fallbackCols = Math.min(count, 2);
        var fallbackRows = Math.ceil(count / fallbackCols);
        return {
            cols: fallbackCols,
            rows: fallbackRows,
            visibleRows: Math.min(MEDIA_GROUP_MAX_VISIBLE_ROWS, fallbackRows),
            thumb: 28
        };
    }

    function singleImageLayout(image, node, scale) {
        var explicitW = finite(node && node.w);
        var explicitH = finite(node && node.h);

        /* w/h 也会被生成中的占位框写入，不能误当用户主动调整的尺寸。
           只有真拖过缩放手柄的节点（manualSize）才固定宽高。 */
        if (node && node.manualSize === true
            && explicitW !== null && explicitW > 24 && explicitH !== null && explicitH > 24) {
            return { width: round(explicitW), height: round(explicitH) };
        }
        if (isFileMediaItem(image) || isTextMediaItem(image)) {
            return { width: Math.max(220, round(150 * scale)), height: Math.max(170, round(100 * scale)) };
        }
        if (isAudioMediaItem(image)) {
            return { width: round(288 * scale), height: round(150 * scale) };
        }

        var natural = mediaLayoutSize(image);
        if (natural.width > 0 && natural.height > 0) {
            var maxW = 260 * scale;
            var maxH = 220 * scale;
            var fit = Math.min(maxW / natural.width, maxH / natural.height);
            /* 长图/超宽图不能把宽高分别抬到最小值，否则节点比例会变。
               保留一个最小短边，长边按同一比例增长，画布里的形状与原图一致。 */
            var minEdge = Math.min(72, maxW, maxH);
            var minFit = minEdge / Math.min(natural.width, natural.height);
            var displayFit = Math.max(fit, minFit);
            return {
                width: Math.max(1, round(natural.width * displayFit)),
                height: Math.max(1, round(natural.height * displayFit))
            };
        }
        return { width: round(260 * scale), height: round(180 * scale) };
    }

    /* 生成中的节点：按待出图数量把卡片切成格子，尺寸用已写入的 w/h。 */
    function activeGenerationLayout(node, count) {
        if (!isSmartImageNode(node)) return null;
        var pendingCount = Math.max(0, finite(node && node.pending) || 0);
        var taskCount = Array.isArray(node && node.pendingTasks) ? node.pendingTasks.length : 0;
        var active = pendingCount > 0 || taskCount > 0
            || Boolean(node && (node.queued || node.running || node.jimengPending));
        if (!active) return null;

        var width = finite(node && node.w);
        var height = finite(node && node.h);
        if (width === null || width <= 24 || height === null || height <= 24) return null;

        var completed = Math.max(0, finite(count) || 0);
        var remaining = Math.max(pendingCount, taskCount);
        var total = Math.max(1, completed, remaining + completed);
        return { width: round(width), height: round(height), total: total };
    }

    /* ---------- 折叠栈 ----------
     *
     * 折叠只改变画布的组织方式：节点缩成一张带错位层次的卡片，点开才展开。
     * 尺寸规则是「按第一张图算单图尺寸，再给后面的卡片让出错位空间」。
     *
     * 真实数据里折叠节点不少（一份 198 节点的画布里有 8 个），而且它们往往
     * 塞着几十张图。不走这条分支时会退化成「按图片数量铺网格」，一个 5 张图的
     * 折叠节点会从 544×454 算成 1392×936——相差 848px，是全部尺寸偏差里最大的
     * 一档。所以这条必须原样搬过来。 */
    var SMART_COLLAPSED_MAX_VISIBLE_LAYERS = 6;
    var SMART_COLLAPSED_STACK_GAP_X = 26;
    var SMART_COLLAPSED_STACK_GAP_Y = 18;

    /* 最后一张是正面卡片，后面的卡片左右交替，让叠层像小扇形展开。 */
    function collapsedStackOffsets(depth, gapX, gapY) {
        var count = Math.max(1, finite(depth) || 1);
        var raw = [];
        for (var layer = 0; layer < count; layer += 1) {
            var behind = count - 1 - layer;
            var magnitude = Math.ceil(behind / 2);
            var signed = behind === 0 ? 0 : (behind % 2 ? -magnitude : magnitude);
            raw.push({ x: signed * gapX, y: signed * gapY * 0.2 });
        }
        var xs = raw.map(function (item) { return item.x; });
        var ys = raw.map(function (item) { return item.y; });
        var minX = Math.min.apply(null, xs);
        var minY = Math.min.apply(null, ys);
        var maxX = Math.max.apply(null, xs);
        var maxY = Math.max.apply(null, ys);
        return {
            positions: raw.map(function (item) {
                return { left: Math.round(item.x - minX), top: Math.round(item.y - minY) };
            }),
            widthGap: Math.max(0, Math.round(maxX - minX)),
            heightGap: Math.max(0, Math.round(maxY - minY))
        };
    }

    function collapsedStackLayout(node) {
        var images = (node && node.images || []).filter(function (image) { return image && image.url; });
        var first = images[0] || {};

        /* 算基础尺寸时把「折叠/手动尺寸/w/h」全部抹掉：这几项描述的是折叠态
           本身，不参与单图推导，否则会自己引用自己。 */
        var baseNode = {};
        Object.keys(node || {}).forEach(function (key) { baseNode[key] = node[key]; });
        baseNode.collapsed = false;
        baseNode.manualSize = false;
        baseNode.w = undefined;
        baseNode.h = undefined;

        var base = singleImageLayout(first, baseNode, Math.max(1, nodeScale(node)));
        var depth = Math.max(1, Math.min(SMART_COLLAPSED_MAX_VISIBLE_LAYERS, images.length));
        var gapX = Math.max(12, Math.min(SMART_COLLAPSED_STACK_GAP_X, Math.round(base.width * 0.12)));
        var gapY = Math.max(10, Math.min(SMART_COLLAPSED_STACK_GAP_Y, Math.round(base.height * 0.06)));
        var offsets = collapsedStackOffsets(depth, gapX, gapY);

        return {
            width: Math.round(base.width + offsets.widthGap),
            height: Math.round(base.height + offsets.heightGap),
            stackDepth: depth,
            stackWidth: Math.round(base.width),
            stackHeight: Math.round(base.height),
            stackGapX: gapX,
            stackGapY: gapY,
            stackPositions: offsets.positions,
            collapsed: true
        };
    }

    /* ---------- 色卡 ----------
     *
     * 色卡的高度由「预览图比例 + 固定 chrome」推出来，不是固定 394。
     * 旧实现还会在自身没有图片时去翻已连接的输入节点——那需要整张画布的连接
     * 关系，超出本内核的职责，这里只处理「自己有图」的情形，其余返回 null
     * 让调用方按默认比例走。实测真实数据里色卡节点都有自有图片。 */
    var SMART_COLOR_DEFAULT_WIDTH = 380;
    var SMART_COLOR_DEFAULT_HEIGHT = 394;
    var SMART_COLOR_PREVIEW_CHROME = 192;
    var SMART_COLOR_PREVIEW_MIN_HEIGHT = 150;
    var SMART_COLOR_PREVIEW_MAX_HEIGHT = 460;

    function smartColorPreviewMediaSize(node) {
        var own = (node && node.images || []).find(function (image) {
            var size = mediaLayoutSize(image);
            return size.width > 0 && size.height > 0;
        });
        return own ? mediaLayoutSize(own) : null;
    }

    function smartColorPreviewMetrics(node) {
        var width = Math.max(320, round(finite(node && node.w) || SMART_COLOR_DEFAULT_WIDTH));
        var innerWidth = Math.max(160, width - 26);
        var size = smartColorPreviewMediaSize(node);
        var ratio = size ? size.width / size.height : 16 / 9;
        var preferredHeight = size
            ? Math.max(SMART_COLOR_PREVIEW_MIN_HEIGHT, Math.min(SMART_COLOR_PREVIEW_MAX_HEIGHT, round(innerWidth / ratio)))
            : 202;
        var manualHeight = Math.max(360, round(finite(node && node.h) || SMART_COLOR_DEFAULT_HEIGHT));
        var height = node && node.colorManualSize === true
            ? manualHeight
            : Math.max(SMART_COLOR_DEFAULT_HEIGHT, preferredHeight + SMART_COLOR_PREVIEW_CHROME);
        return { width: width, height: height, previewHeight: preferredHeight, ratio: ratio };
    }

    /* ---------- 统一入口 ----------
     *
     * 按旧 imageLayout() 的**分支先后顺序**逐条判定，命中就返回。
     * 顺序不能调：折叠判断必须在类型分支之前，否则折叠的图片节点会先被当成
     * 普通多图节点铺成网格。
     *
     * 尚未覆盖的分支（分组缩略图、对比、详情拼接、循环高度、智能体）都依赖
     * 跨节点关系或渲染后实测高度，统一返回 null，由调用方兜底。
     * 详见本文件顶部与 parity 用例的说明。 */
    function layoutFor(node, context) {
        if (!node) return null;

        if (node.collapsed === true && isSmartImageNode(node)
            && (node.images || []).some(function (image) { return image && (image.url || image.local_db_id); })) {
            return collapsedStackLayout(node);
        }
        if (node.type === 'smart-color') return smartColorPreviewMetrics(node);

        return imageLayout(node.images || [], 1, node);
    }

    /* 主入口。只处理图片路径；返回 null 表示「这个节点不归我管」，
       由调用方按类型给默认值（分组、提示词、智能体、对比、色卡…）。 */
    function imageLayout(images, scale, node) {
        var type = (node && node.type) || 'smart-image';
        if (!IMAGE_PATH_TYPES[type]) return null;

        var list = images || [];
        var s = isSmartImageNode(node) ? mediaNodeDefaultScale(node) : (finite(scale) > 0 ? scale : 1);
        var count = list.length;

        var active = activeGenerationLayout(node, count);
        if (active) {
            /* 生成中的卡片尺寸就是已写入的 w/h，格子只影响内部缩略图，
               对外框尺寸没有影响，所以这里直接返回外框。 */
            return { width: active.width, height: active.height };
        }

        if (count === 0) {
            var explicitW = finite(node && node.w);
            var explicitH = finite(node && node.h);
            var pending = (finite(node && node.pending) || 0) > 0 || Boolean(node && node.queued);
            var emptyGeneration = type === 'smart-paint' || type === 'smart-video';
            var fallbackW = pending ? 260 * s : (emptyGeneration ? EMPTY_PAINT_W : EMPTY_UPLOAD_W);
            var fallbackH = pending ? 180 * s : (emptyGeneration ? EMPTY_PAINT_H : EMPTY_UPLOAD_H);
            return {
                width: round(explicitW !== null && explicitW > 24 ? explicitW : fallbackW),
                height: round(explicitH !== null && explicitH > 24 ? explicitH : fallbackH)
            };
        }

        if (count === 1) return singleImageLayout(list[0], node, s);

        var thumb = round(MEDIA_GROUP_THUMB_BASE * s);
        var cell = thumb + 8;
        var PAD = 32;
        var GAP = 8;
        var explicitWidth = finite(node && node.w);
        var explicitHeight = finite(node && node.h);

        /* 分屏网格：行列由 grid 元数据写死 */
        var gridMeta = null;
        list.forEach(function (image) {
            if (!gridMeta && image && image.grid && image.grid.type === 'grid-split') gridMeta = image.grid;
        });
        if (gridMeta) {
            var gridCols = Math.max(1, finite(gridMeta.cols) || 1);
            var gridRows = Math.max(1, finite(gridMeta.rows) || 1);
            var gridVisible = Math.min(MEDIA_GROUP_MAX_VISIBLE_ROWS, gridRows);
            if (explicitWidth !== null && explicitWidth > 40 && explicitHeight !== null && explicitHeight > 40) {
                var fittedThumb = Math.max(28, Math.floor(Math.min(
                    (explicitWidth - PAD - (gridCols - 1) * GAP) / gridCols,
                    (explicitHeight - PAD - (gridVisible - 1) * GAP) / gridVisible
                )));
                return { width: round(explicitWidth), height: gridVisible * (fittedThumb + GAP) - GAP + PAD };
            }
            return {
                width: Math.max(round(226 * s), gridCols * cell + PAD),
                height: gridVisible * cell - GAP + PAD
            };
        }

        var gridAspect = imageGridAspect(node, list);
        var ratioAware = gridAspect > 0 && list.every(function (image) { return mediaKindOf(image) === 'image'; });

        var cols;
        if (type === 'smart-upload' && node.imageArrangement === 'horizontal') cols = count;
        else if (type === 'smart-upload' && node.imageArrangement === 'vertical') cols = 1;
        else if (count <= 4) cols = 2;
        else cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));

        var rows = Math.ceil(count / cols);
        var visibleRows = Math.min(MEDIA_GROUP_MAX_VISIBLE_ROWS, rows);

        if (ratioAware) {
            var aspect = gridAspect;
            var thumbW = aspect >= 1 ? thumb : Math.max(32, round(thumb * aspect));
            var thumbH = aspect >= 1 ? Math.max(32, round(thumb / aspect)) : thumb;

            if (node && node.manualSize === true
                && explicitWidth !== null && explicitWidth > 40 && explicitHeight !== null && explicitHeight > 40) {
                var maxW = Math.max(28, (explicitWidth - PAD - (cols - 1) * GAP) / cols);
                var maxH = Math.max(28, (explicitHeight - PAD - (visibleRows - 1) * GAP) / visibleRows);
                var fit = Math.min(maxW / Math.max(1, thumbW), maxH / Math.max(1, thumbH));
                thumbW = Math.max(28, Math.floor(thumbW * fit));
                thumbH = Math.max(28, Math.floor(thumbH * fit));
                /* 拖拽框只是可用边界，最终节点必须收紧到实际网格尺寸，
                   否则比例不一致时上下或左右会留大片空白。 */
                return {
                    width: round(cols * thumbW + (cols - 1) * GAP + PAD),
                    height: round(visibleRows * thumbH + (visibleRows - 1) * GAP + PAD)
                };
            }
            return {
                width: cols * thumbW + (cols - 1) * GAP + PAD,
                height: visibleRows * thumbH + (visibleRows - 1) * GAP + PAD
            };
        }

        if (node && node.manualSize === true
            && explicitWidth !== null && explicitWidth > 40 && explicitHeight !== null && explicitHeight > 40) {
            var fitted = groupImageGridLayout(count, explicitWidth, explicitHeight, thumb, PAD, GAP);
            return {
                width: round(explicitWidth),
                height: fitted.visibleRows * (fitted.thumb + GAP) - GAP + PAD
            };
        }

        return {
            width: Math.max(round(226 * s), cols * cell + PAD),
            height: visibleRows * cell - GAP + PAD
        };
    }

    root.XiaomeiMediaLayout = {
        version: '1.0.0',
        constants: {
            MEDIA_NODE_DEFAULT_SCALE: MEDIA_NODE_DEFAULT_SCALE,
            MEDIA_GROUP_DEFAULT_SCALE: MEDIA_GROUP_DEFAULT_SCALE,
            MEDIA_GROUP_THUMB_BASE: MEDIA_GROUP_THUMB_BASE,
            MEDIA_GROUP_MAX_VISIBLE_ROWS: MEDIA_GROUP_MAX_VISIBLE_ROWS
        },
        mediaLayoutSize: mediaLayoutSize,
        mediaKindOf: mediaKindOf,
        isFileMediaItem: isFileMediaItem,
        isTextMediaItem: isTextMediaItem,
        isAudioMediaItem: isAudioMediaItem,
        isVideoMediaItem: isVideoMediaItem,
        nodeScale: nodeScale,
        mediaNodeDefaultScale: mediaNodeDefaultScale,
        imageGridAspect: imageGridAspect,
        groupImageGridLayout: groupImageGridLayout,
        singleImageLayout: singleImageLayout,
        collapsedStackLayout: collapsedStackLayout,
        collapsedStackOffsets: collapsedStackOffsets,
        smartColorPreviewMetrics: smartColorPreviewMetrics,
        layoutFor: layoutFor,
        imageLayout: imageLayout,
        IMAGE_PATH_TYPES: IMAGE_PATH_TYPES
    };
})(typeof window !== 'undefined' ? window : globalThis);
