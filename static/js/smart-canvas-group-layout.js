(function (root) {
    'use strict';

    const thumbnailGap = 8;
    const thumbnailInsets = 32;
    const summaryHeight = 28;
    const minThumb = 28;

    function readingOrder(members) {
        const positions = members.map((member, index) => ({
            member, index, x: Number(member.x) || 0, y: Number(member.y) || 0
        })).sort((a, b) => a.y - b.y);
        const ordered = [];
        for (let start = 0; start < positions.length;) {
            let end = start + 1;
            // Measure each row from its top card so staggered rows have a stable order.
            while (end < positions.length && positions[end].y - positions[start].y <= 24) end++;
            const row = positions.slice(start, end).sort((a, b) => a.x - b.x || a.index - b.index);
            for (const { member } of row) ordered.push(member);
            start = end;
        }
        return ordered;
    }

    function squareGrid(count, width, height, { maxThumb, maxRows, padding = thumbnailInsets }) {
        const gap = thumbnailGap;
        let winner;
        for (let cols = 1; cols <= count; cols++) {
            const rows = Math.ceil(count / cols);
            const visibleRows = Math.min(Math.max(1, maxRows), rows);
            const horizontal = width - padding - (cols - 1) * gap;
            const vertical = height - padding - (visibleRows - 1) * gap;
            if (horizontal <= 0 || vertical <= 0) continue;
            const room = Math.floor(Math.min(horizontal / cols, vertical / visibleRows));
            const thumb = Math.max(minThumb, Math.min(room, maxThumb));
            const spare = Math.max(0, horizontal - cols * thumb) + 0.35 * Math.max(0, vertical - visibleRows * thumb);
            const fits = Number(room >= minThumb);
            const candidate = { cols, rows, visibleRows, thumb, spare, fits };
            if (!winner) {
                winner = candidate;
                continue;
            }
            const difference = fits - winner.fits || thumb - winner.thumb
                || (thumb >= maxThumb ? cols - winner.cols : 0)
                || winner.spare - spare || winner.rows - rows;
            if (difference > 0) winner = candidate;
        }
        if (winner) {
            const { cols, rows, visibleRows, thumb } = winner;
            return { cols, rows, visibleRows, thumb };
        }
        const cols = Math.min(2, count);
        const rows = Math.ceil(count / cols);
        return { cols, rows, visibleRows: Math.min(maxRows, rows), thumb: minThumb };
    }

    function thumbnails({ count, width, height, minWidth, minHeight, aspect, scale, baseThumb, maxRows, single }) {
        const insets = thumbnailInsets;
        const chrome = insets + summaryHeight;
        const gap = thumbnailGap;
        const fixed = Number.isFinite(width) && width >= minWidth && Number.isFinite(height) && height >= minHeight;
        if (count === 1) {
            if (fixed) return {
                cols: 1, rows: 1, visibleRows: 1, single: true, thumb: Math.round(96 * scale),
                width: Math.round(width), height: Math.round(height),
                innerW: Math.max(24, Math.round(width - insets)), innerH: Math.max(24, Math.round(height - chrome))
            };
            const media = single();
            return {
                ...media, innerW: media.width, innerH: media.height,
                width: Math.max(minWidth, Math.round(media.width + insets)),
                height: Math.max(minHeight, Math.round(media.height + chrome))
            };
        }

        const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(count))));
        const rows = Math.ceil(count / cols);
        const visibleRows = Math.min(rows, maxRows);
        const gapW = (cols - 1) * gap;
        const gapH = (visibleRows - 1) * gap;
        const edge = baseThumb * scale;
        if (aspect > 0) {
            let thumbW = aspect >= 1 ? Math.round(edge) : Math.max(minThumb, Math.round(edge * aspect));
            let thumbH = aspect >= 1 ? Math.max(minThumb, Math.round(edge / aspect)) : Math.round(edge);
            if (fixed) {
                const cellW = Math.max(minThumb, (Math.max(56, width - insets) - gapW) / cols);
                const cellH = Math.max(minThumb, (Math.max(56, height - chrome) - gapH) / visibleRows);
                const fit = Math.min(cellW / Math.max(1, thumbW), cellH / Math.max(1, thumbH));
                thumbW = Math.max(minThumb, Math.floor(thumbW * fit));
                thumbH = Math.max(minThumb, Math.floor(thumbH * fit));
            }
            return {
                cols, rows, visibleRows, thumbW, thumbH, thumb: thumbH,
                width: Math.round(cols * thumbW + gapW + insets),
                height: Math.round(visibleRows * thumbH + gapH + chrome)
            };
        }
        if (fixed) {
            const fitted = squareGrid(count, Math.max(72, width - insets), Math.max(56, height - chrome),
                { maxThumb: 100000, maxRows, padding: 0 });
            return { ...fitted, width: Math.round(width), height: Math.round(height) };
        }
        const thumb = Math.round(edge);
        return {
            cols, rows, visibleRows, thumb,
            width: Math.max(minWidth, cols * thumb + gapW + insets),
            height: Math.max(minHeight, visibleRows * thumb + gapH + chrome)
        };
    }

    function compactPositions(group, layout, offset, count) {
        const gap = thumbnailGap;
        const thumb = Math.max(minThumb, Math.round(layout.thumb || 96));
        const cols = Math.max(1, layout.cols || 1);
        const gridWidth = cols * thumb + (cols - 1) * gap;
        const inset = thumbnailInsets / 2;
        const originX = (Number(group.x) || 0) + inset
            + Math.max(0, Math.round((layout.width - thumbnailInsets - gridWidth) / 2));
        const originY = (Number(group.y) || 0) + inset + summaryHeight;
        const pitch = thumb + gap;
        return Array.from({ length: count }, (_, i) => ({
            x: Math.round(originX + ((offset + i) % cols) * pitch),
            y: Math.round(originY + Math.floor((offset + i) / cols) * pitch),
            w: thumb, h: thumb, scale: 1
        }));
    }

    function tracks(sizes, gap) {
        let length = 0;
        const offsets = sizes.map(size => {
            const offset = length;
            length += size + gap;
            return offset;
        });
        return { offsets, length: length - gap };
    }

    function tileMembers(group, sizes) {
        const padding = 18;
        const gap = 16;
        const header = 44;
        const columns = Math.round(Math.sqrt(sizes.length));
        const widths = Array(columns).fill(0);
        const heights = Array(Math.ceil(sizes.length / columns)).fill(0);
        for (const [i, { width, height }] of sizes.entries()) {
            const column = i % columns;
            const row = Math.floor(i / columns);
            widths[column] = Math.max(widths[column], width);
            heights[row] = Math.max(heights[row], height);
        }
        const horizontal = tracks(widths, gap);
        const vertical = tracks(heights, gap);
        const x = (Number(group.x) || 0) + padding;
        const y = (Number(group.y) || 0) + padding + header;
        const positions = sizes.map(({ width, height }, i) => {
            const column = i % columns;
            const row = Math.floor(i / columns);
            return {
                x: Math.round(x + horizontal.offsets[column] + (widths[column] - width) / 2),
                y: Math.round(y + vertical.offsets[row] + (heights[row] - height) / 2)
            };
        });
        return { positions, width: horizontal.length + 2 * padding, height: vertical.length + 2 * padding + header };
    }

    root.XiaomeiSmartGroupLayout = { readingOrder, squareGrid, thumbnails, compactPositions, tileMembers };
})(window);
