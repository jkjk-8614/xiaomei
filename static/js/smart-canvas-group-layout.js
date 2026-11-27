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

    function minCell(aspect) {
        const safeAspect = aspect > 0 ? aspect : 1;
        const wide = safeAspect >= 1;
        const ratio = wide ? safeAspect : 1 / safeAspect;
        const longSide = Math.max(minThumb, Math.round(minThumb * ratio));
        return wide ? { thumbW: longSide, thumbH: minThumb, fits: 0 } : { thumbW: minThumb, thumbH: longSide, fits: 0 };
    }

    function fitCell(maxW, maxH, aspect) {
        const safeAspect = aspect > 0 ? aspect : 1;
        const capW = Math.floor(maxW);
        const capH = Math.floor(maxH);
        if (capW <= 0 || capH <= 0) return minCell(safeAspect);
        const wide = safeAspect >= 1;
        const ratio = wide ? safeAspect : 1 / safeAspect;
        const capShort = wide ? capH : capW;
        const capLong = wide ? capW : capH;
        // 以短边整数为基准推导长边，保证输出尺寸再回算时严格幂等，不出现松手后缩 1px。
        let shortSide = Math.min(capShort, Math.floor((capLong + 0.5) / ratio));
        while (shortSide > 0 && Math.round(shortSide * ratio) > capLong) shortSide--;
        while (shortSide + 1 <= capShort && Math.round((shortSide + 1) * ratio) <= capLong) shortSide++;
        const longSide = Math.round(shortSide * ratio);
        const fits = shortSide >= minThumb && longSide >= minThumb ? 1 : 0;
        const finalShort = Math.max(minThumb, shortSide);
        const finalLong = Math.max(minThumb, Math.round(finalShort * ratio));
        return wide
            ? { thumbW: finalLong, thumbH: finalShort, fits }
            : { thumbW: finalShort, thumbH: finalLong, fits };
    }

    function fitByWidth(maxW, aspect) {
        const safeAspect = aspect > 0 ? aspect : 1;
        const capW = Math.floor(maxW);
        if (capW <= 0) return minCell(safeAspect);
        const wide = safeAspect >= 1;
        const ratio = wide ? safeAspect : 1 / safeAspect;
        if (!wide) {
            const shortSide = capW;
            const longSide = Math.round(shortSide * ratio);
            const fits = shortSide >= minThumb && longSide >= minThumb ? 1 : 0;
            const finalShort = Math.max(minThumb, shortSide);
            return { thumbW: finalShort, thumbH: Math.max(minThumb, Math.round(finalShort * ratio)), fits };
        }
        let shortSide = Math.floor((capW + 0.5) / ratio);
        while (shortSide > 0 && Math.round(shortSide * ratio) > capW) shortSide--;
        while (Math.round((shortSide + 1) * ratio) <= capW) shortSide++;
        const longSide = Math.round(shortSide * ratio);
        const fits = shortSide >= minThumb && longSide >= minThumb ? 1 : 0;
        const finalShort = Math.max(minThumb, shortSide);
        return { thumbW: Math.max(minThumb, Math.round(finalShort * ratio)), thumbH: finalShort, fits };
    }

    function revealScrollLayout(count, aspect, innerW, innerH, baseCols, maxDefaultRows) {
        const baseRows = Math.ceil(count / baseCols);
        if (baseRows <= maxDefaultRows) return null;
        const maxW = (innerW - (baseCols - 1) * thumbnailGap) / baseCols;
        if (maxW <= 0) return null;
        const cell = fitByWidth(maxW, aspect);
        if (!cell.fits) return null;
        const totalH = baseRows * cell.thumbH + (baseRows - 1) * thumbnailGap;
        const minDefaultH = maxDefaultRows * cell.thumbH + (maxDefaultRows - 1) * thumbnailGap;
        if (innerH < totalH && innerH >= minDefaultH - 2) {
            const usedW = baseCols * cell.thumbW + (baseCols - 1) * thumbnailGap;
            const clampedInnerH = Math.max(minThumb, Math.round(innerH));
            return {
                cols: baseCols,
                rows: baseRows,
                visibleRows: Math.max(1, Math.min(baseRows, Math.ceil((clampedInnerH + thumbnailGap) / (cell.thumbH + thumbnailGap)))),
                thumbW: cell.thumbW,
                thumbH: cell.thumbH,
                thumb: cell.thumbH,
                usedW,
                gridMaxHeight: clampedInnerH,
                scrollable: true
            };
        }
        return null;
    }

    function adaptiveGrid(count, width, height, {
        aspect = 1,
        maxDefaultRows = 3,
        fixedCols = 0,
        padX = thumbnailInsets,
        padY = thumbnailInsets
    } = {}) {
        const safeCount = Math.max(1, Math.round(Number(count) || 1));
        const safeAspect = Number.isFinite(Number(aspect)) && Number(aspect) > 0 ? Number(aspect) : 1;
        const safeMaxRows = Math.max(1, Math.round(Number(maxDefaultRows) || 3));
        const safeFixedCols = fixedCols > 0 ? Math.max(1, Math.min(safeCount, Math.round(fixedCols))) : 0;
        const innerW = Math.max(minThumb, Math.round(width) - padX);
        const innerH = Math.max(minThumb, Math.round(height) - padY);
        const baseCols = safeFixedCols > 0
            ? safeFixedCols
            : (safeCount <= 4 ? 2 : Math.min(4, Math.max(2, Math.ceil(Math.sqrt(safeCount)))));

        const reveal = revealScrollLayout(safeCount, safeAspect, innerW, innerH, baseCols, safeMaxRows);
        if (reveal) {
            return {
                cols: reveal.cols,
                rows: reveal.rows,
                visibleRows: reveal.visibleRows,
                thumbW: reveal.thumbW,
                thumbH: reveal.thumbH,
                thumb: reveal.thumb,
                width: Math.round(reveal.usedW + padX),
                height: Math.round(reveal.gridMaxHeight + padY),
                gridMaxHeight: reveal.gridMaxHeight,
                scrollable: true
            };
        }

        const startCol = safeFixedCols > 0 ? safeFixedCols : 1;
        const endCol = safeFixedCols > 0 ? safeFixedCols : safeCount;
        const isBetter = (a, b) => {
            if (!b) return true;
            let diff = a.fits - b.fits;
            if (!diff) {
                if (a.fits) {
                    diff = a.area - b.area
                        || b.emptySlots - a.emptySlots
                        || b.waste - a.waste
                        || b.rows - a.rows;
                } else {
                    diff = b.maxOverflow - a.maxOverflow
                        || b.overflow - a.overflow
                        || b.emptySlots - a.emptySlots
                        || b.rows - a.rows;
                }
            }
            return diff > 0;
        };

        let full = null;
        let fullNonConflict = null;
        for (let cols = startCol; cols <= endCol; cols++) {
            const rows = Math.ceil(safeCount / cols);
            const maxW = (innerW - (cols - 1) * thumbnailGap) / cols;
            const maxH = (innerH - (rows - 1) * thumbnailGap) / rows;
            const cell = fitCell(maxW, maxH, safeAspect);
            const usedW = cols * cell.thumbW + (cols - 1) * thumbnailGap;
            const usedH = rows * cell.thumbH + (rows - 1) * thumbnailGap;
            const cand = {
                cols,
                rows,
                visibleRows: rows,
                thumbW: cell.thumbW,
                thumbH: cell.thumbH,
                thumb: cell.thumbH,
                width: Math.round(usedW + padX),
                height: Math.round(usedH + padY),
                gridMaxHeight: usedH,
                fits: cell.fits,
                area: cell.thumbW * cell.thumbH,
                emptySlots: cols * rows - safeCount,
                overflow: Math.max(0, usedW - innerW) + Math.max(0, usedH - innerH),
                maxOverflow: Math.max(Math.max(0, usedW - innerW), Math.max(0, usedH - innerH)),
                waste: Math.max(0, innerW - usedW) + Math.max(0, innerH - usedH),
                scrollable: false
            };
            if (isBetter(cand, full)) full = cand;
            if (!revealScrollLayout(safeCount, safeAspect, usedW, usedH, baseCols, safeMaxRows) && isBetter(cand, fullNonConflict)) {
                fullNonConflict = cand;
            }
        }

        if (full && !full.fits) {
            const baseRows = Math.ceil(safeCount / baseCols);
            if (baseRows > safeMaxRows) {
                const maxW = (innerW - (baseCols - 1) * thumbnailGap) / baseCols;
                const cell = fitByWidth(maxW, safeAspect);
                const totalH = baseRows * cell.thumbH + (baseRows - 1) * thumbnailGap;
                if (innerH < totalH) {
                    const usedW = baseCols * cell.thumbW + (baseCols - 1) * thumbnailGap;
                    const clampedInnerH = Math.max(minThumb, Math.round(innerH));
                    return {
                        cols: baseCols,
                        rows: baseRows,
                        visibleRows: Math.max(1, Math.min(baseRows, Math.ceil((clampedInnerH + thumbnailGap) / (cell.thumbH + thumbnailGap)))),
                        thumbW: cell.thumbW,
                        thumbH: cell.thumbH,
                        thumb: cell.thumbH,
                        width: Math.round(usedW + padX),
                        height: Math.round(clampedInnerH + padY),
                        gridMaxHeight: clampedInnerH,
                        scrollable: true
                    };
                }
            }
        }

        const chosen = (fullNonConflict && fullNonConflict.fits) ? fullNonConflict : full;
        if (chosen && !chosen.scrollable) {
            const reReveal = revealScrollLayout(safeCount, safeAspect, chosen.width - padX, chosen.height - padY, baseCols, safeMaxRows);
            if (reReveal) {
                return {
                    cols: reReveal.cols,
                    rows: reReveal.rows,
                    visibleRows: reReveal.visibleRows,
                    thumbW: reReveal.thumbW,
                    thumbH: reReveal.thumbH,
                    thumb: reReveal.thumb,
                    width: Math.round(reReveal.usedW + padX),
                    height: Math.round(reReveal.gridMaxHeight + padY),
                    gridMaxHeight: reReveal.gridMaxHeight,
                    scrollable: true
                };
            }
        }
        return {
            cols: chosen.cols,
            rows: chosen.rows,
            visibleRows: chosen.visibleRows,
            thumbW: chosen.thumbW,
            thumbH: chosen.thumbH,
            thumb: chosen.thumb,
            width: chosen.width,
            height: chosen.height,
            gridMaxHeight: chosen.gridMaxHeight,
            scrollable: chosen.scrollable
        };
    }

    function thumbnails({ count, width, height, minWidth, minHeight, aspect, scale, baseThumb, maxRows, single, adaptive = false }) {
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
            if (fixed && adaptive) {
                const fitted = adaptiveGrid(count, width, height, {
                    aspect,
                    maxDefaultRows: maxRows,
                    padX: insets,
                    padY: chrome
                });
                return {
                    ...fitted,
                    width: Math.max(minWidth, fitted.width),
                    height: Math.max(minHeight, fitted.height)
                };
            }
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
            if (adaptive && maxRows < count) {
                const fitted = adaptiveGrid(count, width, height, {
                    aspect: 1,
                    maxDefaultRows: maxRows,
                    padX: insets,
                    padY: chrome
                });
                return {
                    ...fitted,
                    width: Math.max(minWidth, fitted.width),
                    height: Math.max(minHeight, fitted.height)
                };
            }
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

    root.XiaomeiSmartGroupLayout = { readingOrder, squareGrid, adaptiveGrid, thumbnails, compactPositions, tileMembers };
})(window);
