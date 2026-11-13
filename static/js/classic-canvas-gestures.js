(function (root) {
    'use strict';

    const menus = '#createMenu, #linkCreateMenu, #nodeInputMenu, #nodeOutputMenu, #imageNodeMenu';
    const boardControls = menus + ', .minimap';
    const previewControls = boardControls + ', #canvasAssetPanel, #workflowTransferModal, #logModal, #promptTemplateModal, #imageEditModal, #outputLightbox';

    function create(host) {
        const { board, minimap } = host;
        const document = board.ownerDocument;
        const viewport = root.XiaomeiViewportKernel;
        let held;

        function move(event) {
            held?.move(event);
        }

        function finish(event) {
            const session = held;
            if (!session) return;
            held = null;
            root.removeEventListener('mousemove', move);
            root.removeEventListener('mouseup', release);
            session.finish(event);
        }

        function release(event) {
            if (held?.button === event.button) finish(event);
        }

        function cancel() { finish(null); }

        function track(event, callbacks) {
            if (held) return false;
            held = { ...callbacks, button: event.button };
            root.addEventListener('mousemove', move);
            root.addEventListener('mouseup', release);
            return true;
        }

        function consume(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        function blurField() {
            const focused = document.activeElement;
            if (focused !== document.body) focused?.blur();
        }

        function startPan(event) {
            if (host.editable(event.target) || event.target.closest(boardControls)) return;
            const camera = host.camera();
            const origin = { x: camera.x, y: camera.y };
            const { clientX, clientY } = event;
            let moved = false;
            if (!track(event, {
                move(next) {
                    const dx = next.clientX - clientX;
                    const dy = next.clientY - clientY;
                    moved ||= Math.hypot(dx, dy) > 4;
                    viewport.dragCamera(camera, origin.x, origin.y, dx, dy);
                    host.paintCamera();
                },
                finish(released) {
                    document.body.classList.remove('canvas-board-pan');
                    if (released?.button === 0 && !moved) host.clearSelection();
                    host.saveCamera();
                },
            })) return;
            consume(event);
            host.dismiss();
            blurField();
            document.body.classList.add('canvas-board-pan');
        }

        board.addEventListener('mousedown', event => {
            if (!host.ready() || held) return;
            if (event.button === 1) {
                startPan(event);
                return;
            }
            if (event.button !== 0 || host.startKnife(event)) return;
            blurField();
            if (!host.background(event.target)) return;
            host.dismiss();
            if (host.selectionModifier(event)) host.marquee(event);
            else startPan(event);
        });

        board.addEventListener('mousedown', event => {
            if (!event.target.closest(menus)) host.dismiss();
        });

        board.addEventListener('mousemove', event => {
            host.pointer(event);
            host.hover(event, Boolean(held));
            if (!event.shiftKey) host.disarmKnife();
        });
        board.addEventListener('mouseleave', host.clearHover);

        board.addEventListener('contextmenu', event => {
            if (!host.ready()) return;
            if (host.selectionModifier(event)) {
                consume(event);
            } else if (host.background(event.target)) {
                consume(event);
                host.createMenu(event.clientX, event.clientY);
            }
        });

        board.addEventListener('wheel', event => {
            if (!host.ready() || host.editable(event.target)) return;
            event.preventDefault();
            viewport.classicWheel(host.camera(), viewport.frameFromElement(board), event.clientX, event.clientY, event.deltaY);
            host.paintZoom();
        }, { passive: false });

        const inZoomPreview = event => host.previewing() && event.button === 0 && !event.target.closest(previewControls);
        board.addEventListener('mousedown', event => {
            if (inZoomPreview(event)) consume(event);
        }, true);
        board.addEventListener('click', event => {
            if (!inZoomPreview(event)) return;
            consume(event);
            host.focusPreview(event);
        }, true);

        minimap.addEventListener('mousedown', event => {
            if (!host.ready() || event.button !== 0 || event.target.closest('#canvasArrangeBtn')) return;
            if (!track(event, { move: host.moveMinimap, finish: host.saveCamera })) return;
            consume(event);
            host.moveMinimap(event);
        });

        root.addEventListener('blur', cancel);
        return { track, cancel, busy: () => Boolean(held) };
    }

    root.XiaomeiClassicGestures = { create };
})(window);
