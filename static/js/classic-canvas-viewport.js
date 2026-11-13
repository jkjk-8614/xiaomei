(function (root) {
    'use strict';

    const sessionKey = 'canvas_session_viewports_v1';
    const kernel = root.XiaomeiViewportKernel;

    function sessionRecords() {
        let cache = Object.create(null);
        let memoryOnly = false;

        function entries() {
            if (!memoryOnly) {
                try {
                    const stored = JSON.parse(root.sessionStorage.getItem(sessionKey) || '{}');
                    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
                        cache = Object.assign(Object.create(null), stored);
                    }
                } catch (_) {}
            }
            return cache;
        }

        function load(id, fallback = { x: 0, y: 0, scale: 1 }) {
            const saved = entries()[id];
            if (!saved || typeof saved !== 'object') return { ...fallback };
            const coordinate = key => {
                const value = Number(saved[key]);
                return Number.isFinite(value) ? value : Number(fallback[key] || 0);
            };
            const scale = Number(saved.scale);
            return {
                x: coordinate('x'), y: coordinate('y'),
                scale: Number.isFinite(scale) ? Math.min(8, Math.max(0.12, scale)) : Number(fallback.scale || 1),
            };
        }

        function save(id, camera) {
            if (!id) return;
            const records = entries();
            records[id] = {
                x: Number(camera.x || 0),
                y: Number(camera.y || 0),
                scale: Number(camera.scale || 1),
                updatedAt: Date.now(),
            };
            if (memoryOnly) return;
            try { root.sessionStorage.setItem(sessionKey, JSON.stringify(records)); }
            catch (_) { memoryOnly = true; }
        }

        return { load, save };
    }

    function create(host) {
        const { board, world, shell, nodesLayer, mapContent, arrangeButton, zoomLabel, toolbar } = host;
        const document = board.ownerDocument;
        const stored = sessionRecords();
        let mapMarker = host.mapMarker;
        let mapState;
        let mapFrame = 0;
        let markerFrame = 0;
        let cameraFrame = 0;
        let saveQueued = false;
        let preview;

        function frame() {
            const { width, height } = board.getBoundingClientRect();
            return { width, height };
        }

        function boxFor(node) {
            const card = nodesLayer.querySelector('.node[data-id="' + root.CSS.escape(node.id) + '"]');
            const defaults = host.size(node.type);
            return {
                x: node.x || 0, y: node.y || 0,
                w: card?.offsetWidth || node.w || defaults.w || 260,
                h: card?.offsetHeight || node.h || defaults.h || 160,
            };
        }

        function drawMap() {
            const painted = kernel.paintClassicMinimap({
                content: mapContent, viewportEl: mapMarker, arrangeButton, selectedCount: host.selected.size,
                frame: frame(), camera: host.camera(),
                boxes: host.nodes().map(node => ({ ...boxFor(node), selected: host.selected.has(node.id) })),
            });
            if (!painted) return;
            mapState = painted.state;
            mapMarker = painted.viewportEl;
        }

        function scheduleMap() {
            if (mapFrame) return;
            mapFrame = root.requestAnimationFrame(() => {
                mapFrame = 0;
                drawMap();
            });
        }

        function scheduleMarker() {
            if (markerFrame) return;
            markerFrame = root.requestAnimationFrame(() => {
                markerFrame = 0;
                if (mapMarker && mapState) kernel.positionClassicMinimapViewport(mapMarker, mapState, host.camera(), frame());
            });
        }

        function paint({ scheduleMinimap = true } = {}) {
            const camera = host.camera();
            kernel.paintWorldLayer(world, camera, 'translate3d');
            if (zoomLabel) zoomLabel.textContent = Math.round(kernel.positiveScale(camera.scale, 1) * 100) + '%';
            if (scheduleMinimap) scheduleMap();
        }

        const record = () => preview || host.camera();

        function save() {
            stored.save(host.canvas()?.id, record());
        }

        function scheduleZoom() {
            saveQueued = true;
            if (cameraFrame) return;
            cameraFrame = root.requestAnimationFrame(() => {
                cameraFrame = 0;
                paint({ scheduleMinimap: false });
                host.links();
                scheduleMarker();
                if (saveQueued) {
                    saveQueued = false;
                    save();
                }
            });
        }

        function pointAt(x, y) {
            return kernel.pointerToWorld(host.camera(), kernel.frameFromElement(board), x, y);
        }

        function moveMinimap(event) {
            if (!mapState) drawMap();
            if (!mapState) return;
            const point = kernel.minimapPointerToWorld({
                scale: mapState.scale, offsetX: mapState.ox, offsetY: mapState.oy, bounds: mapState.bounds,
            }, mapContent.getBoundingClientRect(), event.clientX, event.clientY, 0);
            kernel.centerOn(host.camera(), frame(), point);
            paint();
            host.links();
        }

        function commitCamera() {
            paint();
            host.links();
            save();
        }

        function stepZoom(delta) {
            const camera = host.camera();
            const scale = kernel.positiveScale(camera.scale, 1);
            const next = Math.min(2.4, Math.max(0.12, scale + Number(delta || 0)));
            kernel.zoomAboutCenter(camera, frame(), next);
            commitCamera();
        }

        function fit() {
            kernel.fitBoxes(host.camera(), frame(), host.nodes().map(boxFor), {
                pad: 180, inset: 80, minZoom: 0.06, maxZoom: 0.82, emptyZoom: 0.45, allowEmpty: true,
            });
            commitCamera();
        }

        function previewStyle(enabled) {
            shell.classList.toggle('zoom-preview', enabled);
            document.body.classList.toggle('canvas-zoom-preview', enabled);
        }

        function endPreview(node, point) {
            if (!preview) return;
            const camera = host.camera();
            const previous = preview;
            preview = null;
            previewStyle(false);
            if (node) {
                kernel.frameOnNode(camera, frame(), boxFor(node), previous.scale, {
                    margin: 160, maxScale: 1.15, defaultScale: 1,
                });
            } else {
                Object.assign(camera, previous);
                if (point) kernel.centerOn(camera, frame(), point);
            }
            commitCamera();
        }

        function togglePreview() {
            if (preview) {
                endPreview();
            } else if (host.canvas()) {
                preview = { ...host.camera() };
                previewStyle(true);
                host.closeMenus();
                fit();
            }
        }

        function focusPreview(event) {
            const id = event.target.closest('.node')?.dataset.id;
            if (id) endPreview(host.nodes().find(node => node.id === id));
            else endPreview(null, pointAt(event.clientX, event.clientY));
        }

        function reset() {
            if (saveQueued) save();
            for (const id of [cameraFrame, mapFrame, markerFrame]) if (id) root.cancelAnimationFrame(id);
            cameraFrame = mapFrame = markerFrame = 0;
            saveQueued = false;
            if (preview) Object.assign(host.camera(), preview);
            preview = null;
            previewStyle(false);
            mapState = null;
        }

        toolbar?.querySelectorAll('[data-canvas-zoom-step]').forEach(button => {
            button.addEventListener('click', () => stepZoom(button.dataset.canvasZoomStep));
        });
        toolbar?.querySelector('[data-fit-canvas]')?.addEventListener('click', fit);

        return {
            load: stored.load, record, save, reset, paint, scheduleMap, scheduleZoom, pointAt, moveMinimap,
            previewing: () => Boolean(preview), togglePreview, focusPreview,
        };
    }

    root.XiaomeiClassicViewport = { create };
})(window);
