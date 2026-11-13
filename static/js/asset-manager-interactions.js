(function (root) {
    'use strict';

    function create(groups) {
        const attributes = new Map();
        const ids = new Map();
        for (const group of groups) {
            for (const [name, run] of Object.entries(group)) {
                if (name.startsWith('#')) ids.set(name.slice(1), run);
                else attributes.set('data-' + name, run);
            }
        }

        function match(target, boundary) {
            for (let element = target?.closest?.('*'); element; element = element.parentElement) {
                if (ids.has(element.id)) return { element, value: '', run: ids.get(element.id) };
                for (const attribute of element.attributes) {
                    const run = attributes.get(attribute.name);
                    if (run) return { element, value: attribute.value, run };
                }
                if (element === boundary) break;
            }
            return null;
        }

        async function dispatch(event, boundary, context) {
            const action = match(event.target, boundary);
            if (!action) return false;
            await action.run(action.value, action.element, event, context);
            return true;
        }

        return { dispatch };
    }

    function bindMarquee(container, currentScope, onCommit) {
        const document = container.ownerDocument;
        let gesture;

        function checkItems({ area, scope }, selection) {
            for (const input of area.querySelectorAll('[' + scope.check + ']')) {
                input.checked = selection.has(input.getAttribute(scope.check));
            }
        }
        function finish(commit) {
            if (!gesture) return;
            const ended = gesture;
            gesture = null;
            const { area, box, scope, pointerId, selection, initial } = ended;
            box.remove();
            if (area.hasPointerCapture(pointerId)) area.releasePointerCapture(pointerId);
            if (commit && area.isConnected && currentScope()?.selection === scope.selection) {
                scope.selection.clear();
                for (const id of selection) scope.selection.add(id);
                onCommit();
            } else checkItems(ended, initial);
        }
        function update(x, y) {
            if (!gesture) return;
            const { area, box, startX, startY, initial, scope } = gesture;
            if (!area.isConnected) {
                finish(false);
                return;
            }
            const areaRect = area.getBoundingClientRect();
            const scale = areaRect.width / area.offsetWidth || 1;
            const minX = Math.min(startX, x), maxX = Math.max(startX, x);
            const minY = Math.min(startY, y), maxY = Math.max(startY, y);
            const left = Math.max(minX, areaRect.left), right = Math.min(maxX, areaRect.left + area.clientWidth * scale);
            const top = Math.max(minY, areaRect.top), bottom = Math.min(maxY, areaRect.top + area.clientHeight * scale);
            box.style.left = (minX - areaRect.left) / scale + area.scrollLeft + 'px';
            box.style.top = (minY - areaRect.top) / scale + area.scrollTop + 'px';
            box.style.width = Math.max(1, (maxX - minX) / scale) + 'px';
            box.style.height = Math.max(1, (maxY - minY) / scale) + 'px';
            const selection = new Set(initial);
            if (left < right && top < bottom) {
                for (const card of area.querySelectorAll('[' + scope.card + ']')) {
                    const bounds = card.getBoundingClientRect();
                    if (left < bounds.right && right > bounds.left && top < bounds.bottom && bottom > bounds.top) {
                        selection.add(card.getAttribute(scope.card));
                    }
                }
            }
            Object.assign(gesture, { x, y, selection });
            checkItems(gesture, selection);
        }
        container.addEventListener('pointerdown', event => {
            if (event.button !== 0 || gesture) return;
            const area = event.target.closest('.content-scroll');
            const scope = currentScope();
            if (!area || !scope || event.target.closest(
                '[' + scope.card + '],button,input,textarea,select,.side-upload-card,.upload-grid-card,.asset-search-wrap'
            )) return;
            event.preventDefault();
            const box = document.createElement('div');
            box.className = 'selection-marquee';
            area.append(box);
            const initial = new Set(scope.selection);
            gesture = { area, box, scope, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial };
            area.setPointerCapture(event.pointerId);
            update(event.clientX, event.clientY);
        });
        container.addEventListener('scroll', event => {
            if (event.target === gesture?.area) update(gesture.x, gesture.y);
        }, true);
        document.addEventListener('pointermove', event => {
            if (event.pointerId === gesture?.pointerId) update(event.clientX, event.clientY);
        });
        document.addEventListener('pointerup', event => {
            if (event.pointerId !== gesture?.pointerId) return;
            update(event.clientX, event.clientY);
            finish(true);
        });
        for (const type of ['pointercancel', 'lostpointercapture']) {
            document.addEventListener(type, event => {
                if (event.pointerId === gesture?.pointerId) finish(false);
            });
        }
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && gesture) {
                event.preventDefault();
                finish(false);
            }
        });
        document.defaultView.addEventListener('blur', () => finish(false));
        return { cancel: () => finish(false) };
    }

    root.XiaomeiAssetManagerInteractions = { create, bindMarquee };
}(window));
