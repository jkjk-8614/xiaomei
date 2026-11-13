(function (view) {
    'use strict';

    const noPan = '[data-no-pan], button, a, input, textarea, select, [contenteditable]';

    function attach(frame, options = {}) {
        if (!frame) return null;
        const image = options.img || frame.querySelector('.studio-preview-img, img');
        if (!image) return null;

        const initial = { zoom: 1, panX: 0, panY: 0 };
        let position = initial;
        let active;
        image.style.transformOrigin = 'top left';

        function apply() {
            const { panX, panY, zoom } = position;
            image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        }

        function finish(pointerId) {
            if (active?.id !== pointerId) return;
            active = undefined;
            frame.removeAttribute('data-preview-panning');
            if (frame.hasPointerCapture(pointerId)) frame.releasePointerCapture(pointerId);
        }

        function reset() {
            if (active) finish(active.id);
            position = initial;
            apply();
        }

        frame.addEventListener('wheel', event => {
            event.preventDefault();
            event.stopPropagation();
            const box = frame.getBoundingClientRect();
            const cursor = { x: event.clientX - box.left, y: event.clientY - box.top };
            position = view.XiaomeiShellKernel.previewWheel(position, cursor, event.deltaY, {
                min: options.minZoom, max: options.maxZoom,
            });
            apply();
        }, { passive: false });

        frame.addEventListener('pointerdown', event => {
            if (active || event.button !== 0 || position.zoom <= 1.001 || event.target.closest(noPan)) return;
            event.preventDefault();
            event.stopPropagation();
            active = { id: event.pointerId, x: event.clientX, y: event.clientY };
            frame.setPointerCapture(event.pointerId);
            frame.setAttribute('data-preview-panning', '');
        });

        frame.addEventListener('pointermove', event => {
            if (active?.id !== event.pointerId) return;
            position = {
                zoom: position.zoom,
                panX: position.panX + event.clientX - active.x,
                panY: position.panY + event.clientY - active.y,
            };
            active.x = event.clientX;
            active.y = event.clientY;
            apply();
        });

        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            frame.addEventListener(type, event => finish(event.pointerId));
        }
        frame.addEventListener('dblclick', event => {
            if (position.zoom <= 1.001 || event.target.closest(noPan)) return;
            event.preventDefault();
            event.stopPropagation();
            reset();
        });

        return { apply, reset, getZoom: () => position.zoom };
    }

    view.StudioImagePreview = { attach };
})(window);
