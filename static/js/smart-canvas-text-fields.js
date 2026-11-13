(function (root) {
    'use strict';

    function create(document, isResizing) {
        const bound = new WeakSet();
        let selectionDrag;

        function selectField(event, field) {
            if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
            event.preventDefault();
            event.stopPropagation();
            if (field.matches('input, textarea')) {
                field.focus({ preventScroll: true });
                field.select();
            } else if (field.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(field);
                const selection = document.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }

        function recordScroll(drag) {
            drag.top = drag.field.scrollTop;
            drag.left = drag.field.scrollLeft;
        }
        function restoreScroll(drag) {
            drag.field.scrollTop = drag.top;
            drag.field.scrollLeft = drag.left;
        }
        function followScroll(field) {
            const drag = selectionDrag;
            if (drag?.field !== field) return;
            if (root.performance.now() < drag.wheelUntil) {
                recordScroll(drag);
                return;
            }
            const top = field.scrollTop;
            const height = field.clientHeight;
            const bounds = field.getBoundingClientRect();
            const nearTop = drag.pointerY < bounds.top + 10;
            const nearBottom = drag.pointerY > bounds.bottom - 10;
            const jumpToTop = !nearTop && top < 4 && drag.top > Math.max(80, height * .45);
            const backwardJump = nearBottom && drag.top - top > Math.max(40, height * .25);
            if (jumpToTop || backwardJump) {
                root.requestAnimationFrame(() => {
                    if (selectionDrag === drag) restoreScroll(drag);
                });
            } else {
                recordScroll(drag);
            }
        }

        function bind(field) {
            if (!field || bound.has(field)) return;
            bound.add(field);
            field.addEventListener('keydown', event => selectField(event, field), true);
            field.addEventListener('mousedown', event => {
                event.stopPropagation();
                if (event.button !== 0 || isResizing()) return;
                selectionDrag = { field, pointerY: event.clientY, wheelUntil: 0 };
                recordScroll(selectionDrag);
            });
            field.addEventListener('mousemove', event => {
                if (isResizing()) return;
                event.stopPropagation();
                if (selectionDrag?.field === field) selectionDrag.pointerY = event.clientY;
            });
            field.addEventListener('mouseup', event => {
                if (!isResizing()) event.stopPropagation();
            });
            field.addEventListener('mouseleave', event => {
                event.stopPropagation();
                if (selectionDrag?.field === field) restoreScroll(selectionDrag);
            });
            field.addEventListener('wheel', event => {
                event.stopPropagation();
                if (selectionDrag?.field === field) selectionDrag.wheelUntil = root.performance.now() + 180;
            }, { passive: true });
            field.addEventListener('scroll', () => followScroll(field), { passive: true });
            for (const type of ['click', 'dblclick']) {
                field.addEventListener(type, event => event.stopPropagation());
            }
        }

        function release() {
            selectionDrag = undefined;
        }
        for (const type of ['mouseup', 'pointercancel', 'dragstart']) {
            document.addEventListener(type, release, true);
        }
        root.addEventListener('blur', release);
        return { bind };
    }

    root.XiaomeiSmartTextFields = { create };
})(window);
