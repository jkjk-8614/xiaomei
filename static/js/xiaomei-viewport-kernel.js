/* Xiaomei viewport kernel, phase 2 step 1.
   Independent camera math for pan, zoom, fit, minimap projection, and node origin.
   The legacy canvas scripts remain the default path. This file does not read
   their function bodies; callers opt in through XiaomeiViewportKernel.isActive(). */
(function (root) {
    'use strict';

    var STORAGE_KEY = 'xiaomei.viewportKernel';
    var QUERY_KEY = 'xmViewport';
    var WORLD_LAYOUT_FALLBACK = { width: 6000, height: 4000 };

    function storage() {
        try { return root.localStorage || null; } catch (error) { return null; }
    }

    function readQuery() {
        try {
            var search = root.location && root.location.search || '';
            return new URLSearchParams(search).get(QUERY_KEY);
        } catch (error) {
            return null;
        }
    }

    function persist(mode) {
        var store = storage();
        if (!store) return;
        try { store.setItem(STORAGE_KEY, mode); } catch (error) {}
    }

    function initialActive() {
        var query = readQuery();
        if (query === '1' || query === 'next') {
            persist('next');
            return true;
        }
        if (query === '0' || query === 'legacy') {
            persist('legacy');
            return false;
        }
        var store = storage();
        var saved = '';
        try { saved = store ? store.getItem(STORAGE_KEY) || '' : ''; } catch (error) { saved = ''; }
        return saved === 'next';
    }

    var active = initialActive();
    var mapperCache = null;

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-viewport', active ? 'next' : 'legacy');
    }

    function isActive() { return active; }

    function setActive(next) {
        active = Boolean(next);
        persist(active ? 'next' : 'legacy');
        markDocument();
        invalidateMapper();
        return active;
    }

    function finite(value) {
        var number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function positiveScale(value, fallback) {
        var number = finite(value);
        if (number !== null && number > 0) return number;
        var spare = finite(fallback);
        return spare !== null && spare > 0 ? spare : 1;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function rawZoom(record) {
        return finite(record && record.scale);
    }

    function frameFromElement(element) {
        var rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight
        };
    }

    function pointerToWorld(record, frame, clientX, clientY) {
        var zoom = rawZoom(record);
        var panX = finite(record && record.x);
        var panY = finite(record && record.y);
        var localX = finite(clientX) - finite(frame && frame.left);
        var localY = finite(clientY) - finite(frame && frame.top);
        return {
            x: (localX - (panX === null ? 0 : panX)) / zoom,
            y: (localY - (panY === null ? 0 : panY)) / zoom
        };
    }

    function visibleWorldRect(record, frame) {
        var zoom = rawZoom(record);
        var panX = finite(record && record.x);
        var panY = finite(record && record.y);
        var width = finite(frame && frame.width) || 0;
        var height = finite(frame && frame.height) || 0;
        return {
            x: -(panX === null ? 0 : panX) / zoom,
            y: -(panY === null ? 0 : panY) / zoom,
            w: width / zoom,
            h: height / zoom
        };
    }

    function dragCamera(record, originX, originY, deltaX, deltaY) {
        record.x = originX + deltaX;
        record.y = originY + deltaY;
        return record;
    }

    function zoomAboutLocal(record, localX, localY, nextZoom) {
        var zoom = rawZoom(record);
        var panX = finite(record.x);
        var panY = finite(record.y);
        var worldX = (localX - (panX === null ? 0 : panX)) / zoom;
        var worldY = (localY - (panY === null ? 0 : panY)) / zoom;
        record.scale = nextZoom;
        record.x = localX - worldX * nextZoom;
        record.y = localY - worldY * nextZoom;
        return record;
    }

    function zoomAboutClient(record, frame, clientX, clientY, nextZoom) {
        return zoomAboutLocal(record, clientX - frame.left, clientY - frame.top, nextZoom);
    }

    function zoomAboutCenter(record, frame, nextZoom) {
        return zoomAboutLocal(record, frame.width / 2, frame.height / 2, nextZoom);
    }

    function centerOn(record, frame, worldPoint) {
        var zoom = rawZoom(record);
        var x = finite(worldPoint && worldPoint.x);
        var y = finite(worldPoint && worldPoint.y);
        record.x = frame.width / 2 - (x === null ? 0 : x) * zoom;
        record.y = frame.height / 2 - (y === null ? 0 : y) * zoom;
        return record;
    }

    function classicWheel(record, frame, clientX, clientY, deltaY) {
        var factor = deltaY > 0 ? 0.92 : 1.08;
        var zoom = rawZoom(record);
        return zoomAboutClient(record, frame, clientX, clientY, zoom * factor);
    }

    function steppedZoom(value, min, max, step) {
        var safeStep = finite(step);
        if (safeStep === null || safeStep <= 0) safeStep = 0.05;
        var numeric = finite(value);
        if (numeric === null) return null;
        var snapped = Math.round(numeric / safeStep) * safeStep;
        var fixed = Number(snapped.toFixed(2));
        if (!Number.isFinite(fixed)) return null;
        return clamp(fixed, finite(min) === null ? 0.06 : Number(min), finite(max) === null ? 2 : Number(max));
    }

    function smartWheelStep(base, frame, clientX, clientY, deltaY, deltaMode, pageHeight) {
        var mode = finite(deltaMode) || 0;
        var pixels = (finite(deltaY) || 0) * (mode === 1 ? 16 : mode === 2 ? (finite(pageHeight) || 0) : 1);
        if (!pixels) return null;
        var localX = finite(clientX) - finite(frame.left);
        var localY = finite(clientY) - finite(frame.top);
        if (localX === null || localY === null || !Number.isFinite(localX) || !Number.isFinite(localY)) return null;
        var zoom = rawZoom(base);
        var panX = finite(base.x);
        var panY = finite(base.y);
        var anchorX = (localX - (panX === null ? 0 : panX)) / zoom;
        var anchorY = (localY - (panY === null ? 0 : panY)) / zoom;
        var gain = clamp(-pixels * 0.002, -0.15, 0.15);
        var nextZoom = positiveScale(zoom * (1 + gain), zoom);
        return {
            scale: nextZoom,
            x: localX - anchorX * nextZoom,
            y: localY - anchorY * nextZoom
        };
    }

    function fitBoxes(record, frame, boxes, options) {
        var allowEmpty = options.allowEmpty !== false;
        var width = finite(frame.width) || 0;
        var height = finite(frame.height) || 0;
        if (!boxes || !boxes.length) {
            if (!allowEmpty) return false;
            record.scale = options.emptyZoom;
            record.x = width / 2;
            record.y = height / 2;
            return true;
        }
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        boxes.forEach(function (box) {
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
        });
        var spanW = Math.max(1, maxX - minX + options.pad * 2);
        var spanH = Math.max(1, maxY - minY + options.pad * 2);
        var fitted = Math.min((width - options.inset) / spanW, (height - options.inset) / spanH);
        var zoom = clamp(fitted, options.minZoom, options.maxZoom);
        var centerX = (minX + maxX) / 2;
        var centerY = (minY + maxY) / 2;
        record.scale = zoom;
        record.x = width / 2 - centerX * zoom;
        record.y = height / 2 - centerY * zoom;
        return true;
    }

    function focusContent(record, frame, boxes, options) {
        if (!boxes || !boxes.length) return false;
        fitBoxes(record, frame, boxes, {
            pad: options.pad,
            inset: options.inset,
            minZoom: options.minZoom,
            maxZoom: options.maxZoom,
            emptyZoom: options.emptyZoom,
            allowEmpty: true
        });
        if (positiveScale(record.scale, 1) >= options.floor) return true;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        boxes.forEach(function (box) {
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
        });
        var cx = (minX + maxX) / 2;
        var cy = (minY + maxY) / 2;
        var best = null;
        boxes.forEach(function (box) {
            var px = box.x + box.w / 2;
            var py = box.y + box.h / 2;
            var distance = Math.hypot(px - cx, py - cy);
            if (!best || distance < best.distance) best = { distance: distance, x: px, y: py };
        });
        if (!best) return false;
        record.scale = options.focusZoom;
        record.x = frame.width / 2 - best.x * options.focusZoom;
        record.y = frame.height / 2 - best.y * options.focusZoom;
        return true;
    }

    function frameOnNode(record, frame, box, previousScale, limits) {
        var fitW = Math.max(1, frame.width - limits.margin);
        var fitH = Math.max(1, frame.height - limits.margin);
        var fitScale = Math.min(limits.maxScale, fitW / Math.max(1, box.w), fitH / Math.max(1, box.h));
        var readable = Math.min(limits.maxScale, Math.max(limits.defaultScale, fitScale));
        var zoom = Math.max(positiveScale(previousScale, 1), readable);
        var cx = box.x + box.w / 2;
        var cy = box.y + box.h / 2;
        record.scale = zoom;
        record.x = frame.width / 2 - cx * zoom;
        record.y = frame.height / 2 - cy * zoom;
        return record;
    }

    function paintWorldLayer(element, record, mode) {
        var panX = finite(record.x);
        var panY = finite(record.y);
        var stored = finite(record.scale);
        var zoom = mode === 'translate3d' ? stored : positiveScale(stored, 1);
        var shift = mode === 'translate3d'
            ? 'translate3d(' + panX + 'px, ' + panY + 'px, 0)'
            : 'translate(' + panX + 'px, ' + panY + 'px)';
        element.style.transform = shift + ' scale(' + zoom + ')';
        invalidateMapper();
        return element.style.transform;
    }

    function nodeOriginStyle(node) {
        var x = node && node.x || 0;
        var y = node && node.y || 0;
        return 'left:' + x + 'px;top:' + y + 'px';
    }

    function writeRawOrigin(element, x, y) {
        element.style.left = x + 'px';
        element.style.top = y + 'px';
    }

    function writeMeasuredOrigin(element, x, y) {
        element.style.left = (Number(x) || 0) + 'px';
        element.style.top = (Number(y) || 0) + 'px';
    }

    function enclose(boxes, policy) {
        if (!boxes.length) return { x: policy.emptyX, y: policy.emptyY, w: policy.emptyW, h: policy.emptyH };
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        boxes.forEach(function (box) {
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
        });
        var spanW = maxX - minX;
        var spanH = maxY - minY;
        var pad = Math.max(policy.minPad, Math.max(spanW, spanH) * policy.ratio);
        return {
            x: minX - pad,
            y: minY - pad,
            w: Math.max(1, spanW + pad * 2),
            h: Math.max(1, spanH + pad * 2)
        };
    }

    function containMap(bounds, mapWidth, mapHeight) {
        var scale = Math.min(mapWidth / Math.max(1, bounds.w), mapHeight / Math.max(1, bounds.h));
        var drawnW = bounds.w * scale;
        var drawnH = bounds.h * scale;
        return {
            scale: scale,
            offsetX: (mapWidth - drawnW) / 2,
            offsetY: (mapHeight - drawnH) / 2
        };
    }

    function projectBox(layout, originX, originY, box) {
        var minSize = box.minSize || 0;
        return {
            left: layout.offsetX + (box.x - originX) * layout.scale,
            top: layout.offsetY + (box.y - originY) * layout.scale,
            width: Math.max(minSize, box.w * layout.scale),
            height: Math.max(minSize, box.h * layout.scale)
        };
    }

    function minimapPointerToWorld(layout, mapRect, clientX, clientY, epsilon) {
        var floor = epsilon || 0;
        var scale = layout.scale;
        if (floor) scale = Math.max(floor, scale);
        var localX = clientX - mapRect.left;
        var localY = clientY - mapRect.top;
        return {
            x: layout.bounds.x + (localX - layout.offsetX) / scale,
            y: layout.bounds.y + (localY - layout.offsetY) / scale
        };
    }

    function assignBox(element, box) {
        element.style.left = box.left + 'px';
        element.style.top = box.top + 'px';
        element.style.width = box.width + 'px';
        element.style.height = box.height + 'px';
    }

    function paintClassicMinimap(input) {
        var content = input.content;
        if (!content || !input.viewportEl) return null;
        if (input.arrangeButton) input.arrangeButton.classList.toggle('visible', input.selectedCount > 0);
        var view = visibleWorldRect(input.camera, input.frame);
        var bounds = enclose(input.boxes.concat([{ x: view.x, y: view.y, w: view.w, h: view.h }]), {
            minPad: 240,
            ratio: 0.08,
            emptyX: 0,
            emptyY: 0,
            emptyW: 1000,
            emptyH: 700
        });
        var mapWidth = content.clientWidth || 172;
        var mapHeight = content.clientHeight || 110;
        var layout = containMap(bounds, mapWidth, mapHeight);
        content.replaceChildren();
        input.boxes.forEach(function (box) {
            var el = content.ownerDocument.createElement('div');
            el.className = 'minimap-node' + (box.selected ? ' selected' : '');
            assignBox(el, projectBox(layout, bounds.x, bounds.y, {
                x: box.x, y: box.y, w: box.w, h: box.h, minSize: 3
            }));
            content.appendChild(el);
        });
        if (!input.boxes.length) {
            var empty = content.ownerDocument.createElement('div');
            empty.className = 'minimap-empty';
            empty.textContent = 'EMPTY';
            content.appendChild(empty);
        }
        var viewportEl = input.viewportEl;
        if (!viewportEl.isConnected || viewportEl.parentElement !== content) {
            viewportEl.id = 'minimapViewport';
            viewportEl.className = 'minimap-viewport';
            content.appendChild(viewportEl);
        } else if (content.lastElementChild !== viewportEl) {
            content.appendChild(viewportEl);
        }
        assignBox(viewportEl, projectBox(layout, bounds.x, bounds.y, {
            x: view.x, y: view.y, w: view.w, h: view.h, minSize: 8
        }));
        return {
            viewportEl: viewportEl,
            state: { bounds: bounds, scale: layout.scale, ox: layout.offsetX, oy: layout.offsetY, cw: mapWidth, ch: mapHeight }
        };
    }

    function positionClassicMinimapViewport(viewportEl, state, camera, frame) {
        if (!viewportEl || !state) return;
        var view = visibleWorldRect(camera, frame);
        assignBox(viewportEl, projectBox(
            { scale: state.scale, offsetX: state.ox, offsetY: state.oy },
            state.bounds.x,
            state.bounds.y,
            { x: view.x, y: view.y, w: view.w, h: view.h, minSize: 8 }
        ));
    }

    function smartMapExtents(boxes, view) {
        var samples = boxes.concat([view]);
        var minX = -200, minY = -200;
        var maxX = view.x + view.w + 200;
        var maxY = view.y + view.h + 200;
        samples.forEach(function (box) {
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    function paintSmartMinimap(input) {
        var content = input.content;
        var viewportEl = input.viewportEl;
        var view = {
            x: -Number(input.camera.x) / Number(input.camera.scale),
            y: -Number(input.camera.y) / Number(input.camera.scale),
            w: input.shellWidth / Number(input.camera.scale),
            h: input.shellHeight / Number(input.camera.scale)
        };
        var extent = smartMapExtents(input.boxes, view);
        var spanW = Math.max(1, extent.maxX - extent.minX);
        var spanH = Math.max(1, extent.maxY - extent.minY);
        var scale = Math.min(input.mapWidth / spanW, input.mapHeight / spanH);
        var layout = {
            scale: scale,
            offsetX: (input.mapWidth - spanW * scale) / 2,
            offsetY: (input.mapHeight - spanH * scale) / 2
        };
        var existing = Array.prototype.slice.call(content.querySelectorAll('.minimap-node'));
        input.boxes.forEach(function (box, index) {
            var el = existing[index] || content.ownerDocument.createElement('div');
            el.className = 'minimap-node';
            assignBox(el, projectBox(layout, extent.minX, extent.minY, {
                x: box.x, y: box.y, w: box.w, h: box.h, minSize: 4
            }));
            if (!el.parentElement) content.appendChild(el);
        });
        existing.slice(input.boxes.length).forEach(function (el) { el.remove(); });
        assignBox(viewportEl, projectBox(layout, extent.minX, extent.minY, {
            x: view.x, y: view.y, w: view.w, h: view.h, minSize: 4
        }));
        if (viewportEl.parentElement === content && content.lastElementChild !== viewportEl) content.appendChild(viewportEl);
        return {
            state: {
                minX: extent.minX,
                minY: extent.minY,
                scale: scale,
                offsetX: layout.offsetX,
                offsetY: layout.offsetY,
                width: input.mapWidth,
                height: input.mapHeight,
                shellWidth: input.shellWidth,
                shellHeight: input.shellHeight,
                nodeRects: input.boxes.slice()
            }
        };
    }

    function syncSmartMinimapFrame(state, camera, metrics) {
        var width = metrics.cached ? state.width : metrics.width;
        var height = metrics.cached ? state.height : metrics.height;
        var shellWidth = metrics.cached ? (state.shellWidth || 0) : metrics.shellWidth;
        var shellHeight = metrics.cached ? (state.shellHeight || 0) : metrics.shellHeight;
        if (!metrics.cached && (state.width !== width || state.height !== height || state.shellWidth !== shellWidth || state.shellHeight !== shellHeight)) {
            return { relayout: true };
        }
        var zoom = Number(camera.scale);
        var box = projectBox(
            { scale: state.scale, offsetX: state.offsetX, offsetY: state.offsetY },
            state.minX,
            state.minY,
            {
                x: -Number(camera.x) / zoom,
                y: -Number(camera.y) / zoom,
                w: shellWidth / zoom,
                h: shellHeight / zoom,
                minSize: 4
            }
        );
        return { relayout: false, box: box };
    }

    function invertAffine(matrix, clientX, clientY) {
        var determinant = matrix.a * matrix.d - matrix.b * matrix.c;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
        var dx = clientX - matrix.e;
        var dy = clientY - matrix.f;
        var x = (matrix.d * dx - matrix.c * dy) / determinant;
        var y = (-matrix.b * dx + matrix.a * dy) / determinant;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x: x, y: y };
    }

    function invalidateMapper() {
        mapperCache = null;
    }

    function buildMapper(input) {
        var svg = input.svg;
        var matrix = null;
        try { matrix = svg && svg.getScreenCTM && svg.getScreenCTM(); } catch (error) { matrix = null; }
        if (matrix && Number.isFinite(matrix.a) && Number.isFinite(matrix.d)) {
            var mapped = invertAffine(matrix, 0, 0);
            if (mapped || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) >= 1e-12) {
                return {
                    screenScaleX: Math.max(1e-6, Math.hypot(matrix.a || 0, matrix.b || 0)),
                    screenScaleY: Math.max(1e-6, Math.hypot(matrix.c || 0, matrix.d || 0)),
                    toWorld: function (clientX, clientY) { return invertAffine(matrix, clientX, clientY); }
                };
            }
        }
        var world = input.world;
        var rect = world.getBoundingClientRect();
        var width = Number(world.offsetWidth) || WORLD_LAYOUT_FALLBACK.width;
        var height = Number(world.offsetHeight) || WORLD_LAYOUT_FALLBACK.height;
        var scaleX = rect.width / width;
        var scaleY = rect.height / height;
        if (Number.isFinite(scaleX) && Math.abs(scaleX) > 1e-6 && Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-6) {
            return {
                screenScaleX: Math.abs(scaleX),
                screenScaleY: Math.abs(scaleY),
                toWorld: function (clientX, clientY) {
                    return {
                        x: (clientX - rect.left) / scaleX,
                        y: (clientY - rect.top) / scaleY
                    };
                }
            };
        }
        var shellRect = input.shell.getBoundingClientRect();
        var zoom = Math.max(0.0001, positiveScale(input.camera && input.camera.scale, 1));
        return {
            screenScaleX: zoom,
            screenScaleY: zoom,
            toWorld: function (clientX, clientY) {
                return pointerToWorld(input.camera, shellRect, clientX, clientY);
            }
        };
    }

    function smartPointerToWorld(input) {
        if (!mapperCache) mapperCache = buildMapper(input);
        return mapperCache.toWorld(input.clientX, input.clientY);
    }

    markDocument();

    root.XiaomeiViewportKernel = {
        STORAGE_KEY: STORAGE_KEY,
        QUERY_KEY: QUERY_KEY,
        isActive: isActive,
        setActive: setActive,
        positiveScale: positiveScale,
        frameFromElement: frameFromElement,
        pointerToWorld: pointerToWorld,
        visibleWorldRect: visibleWorldRect,
        dragCamera: dragCamera,
        zoomAboutCenter: zoomAboutCenter,
        centerOn: centerOn,
        zoomAboutClient: zoomAboutClient,
        classicWheel: classicWheel,
        steppedZoom: steppedZoom,
        smartWheelStep: smartWheelStep,
        fitBoxes: fitBoxes,
        focusContent: focusContent,
        frameOnNode: frameOnNode,
        paintWorldLayer: paintWorldLayer,
        nodeOriginStyle: nodeOriginStyle,
        writeRawOrigin: writeRawOrigin,
        writeMeasuredOrigin: writeMeasuredOrigin,
        enclose: enclose,
        containMap: containMap,
        minimapPointerToWorld: minimapPointerToWorld,
        paintClassicMinimap: paintClassicMinimap,
        positionClassicMinimapViewport: positionClassicMinimapViewport,
        paintSmartMinimap: paintSmartMinimap,
        syncSmartMinimapFrame: syncSmartMinimapFrame,
        invertAffine: invertAffine,
        invalidateMapper: invalidateMapper,
        smartPointerToWorld: smartPointerToWorld
    };
})(typeof window !== 'undefined' ? window : globalThis);
