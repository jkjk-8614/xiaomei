(function (root) {
    'use strict';

    const dragDistance = 6;
    const ownTile = (tile, id) => !tile.dataset.refNodeId || tile.dataset.refNodeId === id;
    const tileIndex = tile => Number(tile.dataset.refImageIndex ?? tile.dataset.imageIndex);
    const movePoint = event => ({ x: event.clientX, y: event.clientY });

    function closestTile(grid, id, point, imageCount) {
        let best;
        let distance = Infinity;
        for (const tile of grid.querySelectorAll('.thumb-item')) {
            if (!ownTile(tile, id)) continue;
            const index = tileIndex(tile);
            if (!Number.isInteger(index) || index < 0 || index >= imageCount) continue;
            const rect = tile.getBoundingClientRect();
            const squared = (point.x - rect.left - rect.width / 2) ** 2 + (point.y - rect.top - rect.height / 2) ** 2;
            if (squared < distance) {
                best = { tile, index };
                distance = squared;
            }
        }
        return best;
    }

    function create(host) {
        let gesture;

        function clearPreview(state) {
            state.target?.classList.remove('drop-before', 'drop-after');
            state.source?.classList.remove('paint-ref-drag-source');
            state.ghost?.remove();
            state.source?.ownerDocument.body.classList.remove('smart-input-thumb-drag');
            state.target = state.source = state.ghost = null;
        }

        function cancel() {
            if (!gesture) return;
            clearPreview(gesture);
            gesture = null;
        }

        function begin(cardId, tile, media, event) {
            const owner = media.owner;
            if (gesture || media.nodeId !== cardId || !media.image || !owner || !host.canEdit(owner)) return false;
            const group = host.isGroup(owner);
            const modified = event.altKey || event.ctrlKey || event.metaKey;
            if (group ? !modified : owner.images.length < 2) return false;
            gesture = {
                document: host.current(), owner, image: media.image,
                start: movePoint(event), copy: event.altKey,
                tile, grid: tile.closest('.thumb-grid'),
            };
            return true;
        }

        function currentIndex(state) {
            if (state.document !== host.current() || host.node(state.owner.id) !== state.owner
                || !host.canEdit(state.owner)) return -1;
            return state.owner.images?.indexOf(state.image) ?? -1;
        }

        function dropTarget(state, point, scroll) {
            if (state.copy) return null;
            const grid = state.grid?.isConnected ? state.grid
                : host.card(state.owner.id)?.querySelector('.thumb-grid');
            if (!grid) return null;
            const { left, top, right, bottom } = grid.getBoundingClientRect();
            if (point.x < left || point.x > right || point.y < top || point.y > bottom) return null;
            state.grid = grid;
            if (scroll) {
                if (point.y < top + 28) grid.scrollTop -= 12;
                else if (point.y > bottom - 28) grid.scrollTop += 12;
            }
            return closestTile(grid, state.owner.id, point, state.owner.images.length);
        }

        function showPreview(state, index, target, point) {
            const currentTile = state.tile.isConnected && tileIndex(state.tile) === index ? state.tile
                : [...state.grid.querySelectorAll('.thumb-item')].find(tile => ownTile(tile, state.owner.id) && tileIndex(tile) === index);
            if (!currentTile) return;
            if (state.source !== currentTile) {
                clearPreview(state);
                host.cancelSelectionPaint();
                const { left, top, width, height } = currentTile.getBoundingClientRect();
                const ghost = currentTile.cloneNode(true);
                for (const control of ghost.querySelectorAll('button')) control.remove();
                ghost.setAttribute('aria-hidden', 'true');
                ghost.classList.add('paint-ref-drag-ghost');
                Object.assign(ghost.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
                const body = currentTile.ownerDocument.body;
                body.append(ghost);
                body.classList.add('smart-input-thumb-drag');
                currentTile.classList.add('paint-ref-drag-source');
                state.source = currentTile;
                state.ghost = ghost;
            }
            const dx = point.x - state.start.x;
            const dy = point.y - state.start.y;
            state.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
            state.target?.classList.remove('drop-before', 'drop-after');
            state.target = target.index === index ? null : target.tile;
            state.target?.classList.add(target.index < index ? 'drop-before' : 'drop-after');
        }

        function crossedThreshold(state, point) {
            return Math.abs(point.x - state.start.x) + Math.abs(point.y - state.start.y) > dragDistance;
        }

        function transfer(state, index, event) {
            if (!host.isGroup(state.owner) && state.owner.images.length < 2) return false;
            cancel();
            return host.detach(state.owner, state.image, index, state.copy, event);
        }

        function move(event) {
            if (!gesture) return false;
            const state = gesture;
            const index = currentIndex(state);
            if (index < 0) {
                cancel();
                return true;
            }
            const point = movePoint(event);
            if (!crossedThreshold(state, point)) return true;
            const target = dropTarget(state, point, true);
            if (target) showPreview(state, index, target, point);
            else if (transfer(state, index, event)) return false;
            return true;
        }

        function release(event) {
            if (!gesture || event.button !== 0) return;
            const state = gesture;
            const index = currentIndex(state);
            const point = movePoint(event);
            if (index >= 0 && crossedThreshold(state, point)) {
                const target = dropTarget(state, point, false);
                if (!target) transfer(state, index, event);
                else if (target.index !== index) host.reorder(state.owner, index, target.index);
            }
            cancel();
        }

        return { begin, move, release, cancel, active: () => Boolean(gesture) };
    }

    root.XiaomeiSmartThumbnailDrag = { create };
})(window);
