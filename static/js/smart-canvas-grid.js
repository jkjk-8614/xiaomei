(function (root) {
    'use strict';

    function create(host) {
        const { modal, frame, image, draw } = host;
        const get = id => modal.querySelector('#' + id);
        const stage = get('gridJoinCanvas');
        const count = get('gridSplitCount');
        const gap = get('gridGapSize');
        const cache = new Map();
        let join = false;
        let preset = null;
        let order = [];
        let drag = null;
        let targetSize = 2048;
        const joining = () => host.active() && join;

        const split = root.XiaomeiClassicGrid.create({
            modal, frame, draw, joining, label: host.label,
            active: () => host.active() && !join,
            changed: host.changed,
            updated: () => { if (joining()) paintJoin(); },
        });

        function entryKey(entry) {
            return JSON.stringify([entry.index, host.url(entry.item)]);
        }

        function signature() {
            return JSON.stringify(host.items().map(entryKey));
        }

        function tileFor(entry) {
            const key = entryKey(entry);
            if (cache.has(key)) return cache.get(key);
            const tile = new Image();
            tile.crossOrigin = 'anonymous';
            tile.className = 'grid-join-item';
            tile.draggable = false;
            tile.dataset.gridJoinIndex = entry.index;
            tile.alt = entry.item.name || 'image-' + (entry.index + 1);
            const record = { tile };
            cache.set(key, record);
            record.loaded = new Promise((resolve, reject) => {
                const source = host.url(entry.item);
                const fallback = host.proxy(entry.item);
                tile.onload = () => resolve(tile);
                tile.onerror = () => {
                    if (fallback && fallback !== source && tile.getAttribute('src') === source) tile.src = fallback;
                    else reject(new Error('图片加载失败'));
                };
                tile.src = source;
            });
            record.loaded.then(() => {
                if (cache.get(key) === record && joining() && !drag) paintJoin();
            }, () => { if (cache.get(key) === record) cache.delete(key); });
            return record;
        }

        function layout(entries) {
            const remaining = new Map(entries.map(entry => [entryKey(entry), entry]));
            const items = [];
            for (const key of order) {
                const entry = remaining.get(key);
                if (!entry) continue;
                items.push(entry);
                remaining.delete(key);
            }
            items.push(...remaining.values());
            const autoCols = Math.max(1, Math.ceil(Math.sqrt(items.length)));
            const { cols, rows } = preset || { cols: autoCols, rows: Math.ceil(items.length / autoCols) };
            const actualRows = Math.max(rows, Math.ceil(items.length / cols));
            const sizes = items.map(entry => {
                const { item } = entry;
                const { tile } = tileFor(entry);
                return {
                    width: Number(item.natural_w || tile.naturalWidth || item.width) || 512,
                    height: Number(item.natural_h || tile.naturalHeight || item.height) || 512,
                };
            });
            const width = Math.max(1, ...sizes.map(size => size.width));
            const height = Math.max(1, ...sizes.map(size => size.height));
            const scale = Math.min(1, 420 / Math.max(width, height));
            const w = Math.max(1, Math.round(width * scale));
            const h = Math.max(1, Math.round(height * scale));
            const spacing = Number(gap.value) || 0;
            const cells = items.map((entry, index) => ({
                entry, w, h,
                x: (index % cols) * (w + spacing), y: Math.floor(index / cols) * (h + spacing),
            }));
            return { cells, width: cols * w + (cols - 1) * spacing, height: actualRows * h + (actualRows - 1) * spacing };
        }

        function paintJoin() {
            const entries = host.items();
            if (entries.length < 2) {
                stage.replaceChildren();
                count.textContent = '分组需要至少 2 张图片';
                return;
            }
            const { cells, width, height } = layout(entries);
            const zoom = host.zoom();
            Object.assign(stage.style, { display: 'block', width: width + 'px', height: height + 'px',
                transform: 'scale(' + zoom + ')', transformOrigin: '0 0' });
            frame.style.width = Math.max(1, Math.round(width * zoom)) + 'px';
            frame.style.height = Math.max(1, Math.round(height * zoom)) + 'px';
            if (!drag) {
                const tiles = cells.map(({ entry, x, y, w, h }) => {
                    const { tile } = tileFor(entry);
                    Object.assign(tile.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
                    return tile;
                });
                if (tiles.some((tile, index) => stage.children[index] !== tile) || stage.children.length !== tiles.length) {
                    stage.replaceChildren(...tiles);
                }
            }
            count.textContent = '将拼接 ' + entries.length + ' 张图片 · 输出长边 ' + Math.round(targetSize / 1024) + 'K';
        }

        function paint() {
            split.paint();
            if (joining()) paintJoin();
        }

        function sync() {
            const available = host.items().length > 1;
            if (join && !available) join = false;
            const active = joining();
            const splitButton = get('gridSplitModeBtn');
            const joinButton = get('gridJoinModeBtn');
            splitButton.classList.toggle('primary', !active);
            splitButton.classList.toggle('secondary', active);
            joinButton.disabled = !available;
            joinButton.classList.toggle('primary', active);
            joinButton.classList.toggle('secondary', !active);
            for (const control of modal.querySelectorAll('.grid-join-control')) control.style.display = active ? 'flex' : 'none';
            frame.classList.toggle('grid-join-mode', active);
            image.classList.toggle('grid-join-hidden', active);
            if (!active) {
                endDrag();
                stage.replaceChildren();
                stage.style.cssText = '';
                frame.style.width = frame.style.height = '';
            } else draw.getContext('2d').clearRect(0, 0, draw.width, draw.height);
            paint();
        }

        function setMode(mode) {
            split.end();
            endDrag();
            join = mode === 'join';
            sync();
            if (join !== (mode === 'join')) host.error('请从包含多张图片的分组打开宫格拼接');
            host.changed();
            host.modeChanged(joining());
        }

        function reset() {
            join = false;
            preset = null;
            order = [];
            cache.clear();
            split.reset();
            sync();
        }

        function endDrag(event) {
            if (!drag || (event && drag.pointerId !== event.pointerId)) return;
            const { tile, pointerId, cells, index, dx, dy } = drag;
            drag = null;
            tile.classList.remove('dragging');
            tile.style.transform = '';
            if (tile.hasPointerCapture(pointerId)) tile.releasePointerCapture(pointerId);
            if (event?.type !== 'pointerup') return;
            const cell = cells[index];
            const centerX = cell.x + cell.w / 2 + dx;
            const centerY = cell.y + cell.h / 2 + dy;
            const candidates = cells.map((other, position) => ({
                position, inside: centerX >= other.x && centerX <= other.x + other.w && centerY >= other.y && centerY <= other.y + other.h,
                distance: Math.hypot(centerX - other.x - other.w / 2, centerY - other.y - other.h / 2),
            })).filter(target => target.position !== index && (target.inside || target.distance < Math.max(cell.w, cell.h) * 0.55));
            const target = candidates.sort((a, b) => Number(b.inside) - Number(a.inside) || a.distance - b.distance)[0];
            if (target) {
                order = cells.map(item => entryKey(item.entry));
                [order[index], order[target.position]] = [order[target.position], order[index]];
                host.changed();
            }
            paintJoin();
        }

        stage.addEventListener('pointerdown', event => {
            const tile = event.target.closest('.grid-join-item');
            if (!tile || drag || !joining() || event.button !== 0) return;
            const { cells } = layout(host.items());
            const index = cells.findIndex(cell => String(cell.entry.index) === tile.dataset.gridJoinIndex);
            if (index < 0) return;
            event.preventDefault();
            event.stopPropagation();
            tile.setPointerCapture(event.pointerId);
            tile.classList.add('dragging');
            drag = { tile, cells, index, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
        });
        stage.addEventListener('pointermove', event => {
            if (drag?.pointerId !== event.pointerId) return;
            event.stopPropagation();
            const zoom = host.zoom();
            drag.dx = (event.clientX - drag.x) / zoom;
            drag.dy = (event.clientY - drag.y) / zoom;
            drag.tile.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, endDrag);
        get('gridSplitModeBtn').addEventListener('click', () => setMode('split'));
        get('gridJoinModeBtn').addEventListener('click', () => setMode('join'));
        for (const button of modal.querySelectorAll('[data-grid-join-preset]')) button.addEventListener('click', () => {
            endDrag();
            const [rows, cols] = button.dataset.gridJoinPreset.split(',').map(Number);
            preset = rows ? { rows, cols } : null;
            if (!preset) order = [];
            host.changed();
            paintJoin();
        });
        const sizes = modal.querySelectorAll('[data-grid-join-size]');
        for (const button of sizes) button.addEventListener('click', () => {
            targetSize = Number(button.dataset.gridJoinSize);
            for (const choice of sizes) choice.classList.toggle('active', choice === button);
            host.changed();
            paintJoin();
        });

        async function combine(current) {
            const entries = host.items();
            if (entries.length < 2) return;
            const sources = new Map(await Promise.all(entries.map(async entry => [entryKey(entry), await tileFor(entry).loaded])));
            if (!current()) return;
            const { cells, width, height } = layout(entries);
            const scale = Math.max(1, targetSize / Math.max(width, height));
            const result = root.XiaomeiImageEditGeometry.surface(Math.round(width * scale), Math.round(height * scale));
            const ctx = result.context;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, result.width, result.height);
            for (const { entry, x, y, w, h } of cells) {
                const source = sources.get(entryKey(entry));
                const cover = Math.max(w / source.naturalWidth, h / source.naturalHeight);
                const cropW = w / cover, cropH = h / cover;
                const left = Math.round(x * scale), top = Math.round(y * scale);
                ctx.drawImage(source, (source.naturalWidth - cropW) / 2, (source.naturalHeight - cropH) / 2, cropW, cropH,
                    left, top, Math.round((x + w) * scale) - left, Math.round((y + h) * scale) - top);
            }
            return result;
        }

        return { split, paint, sync, reset, joining, setMode, endDrag, signature, combine };
    }

    root.XiaomeiSmartGrid = { create };
})(window);
