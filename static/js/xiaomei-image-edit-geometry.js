(function (root) {
    'use strict';

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    function boundCrop(box, bounds) {
        const w = clamp(box.w, Math.min(24, bounds.w), bounds.w);
        const h = clamp(box.h, Math.min(24, bounds.h), bounds.h);
        return { x: clamp(box.x, 0, bounds.w - w), y: clamp(box.y, 0, bounds.h - h), w, h };
    }

    function boundExpansion(box, bounds) {
        const w = Math.max(bounds.w, box.w), h = Math.max(bounds.h, box.h);
        return { x: clamp(box.x, 0, w - bounds.w), y: clamp(box.y, 0, h - bounds.h), w, h };
    }

    function fittedCrop(box, bounds, ratio) {
        const width = Math.round(Math.min(box.w, box.h * ratio, bounds.w, bounds.h * ratio));
        const height = Math.round(width / ratio);
        return boundCrop({
            x: Math.round(box.x + (box.w - width) / 2),
            y: Math.round(box.y + (box.h - height) / 2),
            w: width, h: height,
        }, bounds);
    }

    function dragBox(box, bounds, drag, dx, dy, ratio, expansion) {
        if (drag === 'move' || drag === 'image') {
            const moved = { ...box, x: box.x + dx, y: box.y + dy };
            return expansion ? boundExpansion(moved, bounds) : boundCrop(moved, bounds);
        }
        if (expansion) {
            const [x, y] = {
                'outpaint-left': [-dx, 0], 'outpaint-right': [dx, 0],
                'outpaint-top': [0, -dy], 'outpaint-bottom': [0, dy], 'outpaint-corner': [dx, dy],
            }[drag] || [0, 0];
            const w = Math.max(bounds.w, box.w + 2 * x), h = Math.max(bounds.h, box.h + 2 * y);
            return boundExpansion({ x: box.x + Math.round((w - box.w) / 2), y: box.y + Math.round((h - box.h) / 2), w, h }, bounds);
        }
        const handle = drag === 'resize' ? 'se' : drag.replace(/^crop-/, '');
        const horizontal = handle.includes('w') ? -1 : Number(handle.includes('e'));
        const vertical = handle.includes('n') ? -1 : Number(handle.includes('s'));
        const pivotX = box.x + (horizontal < 0 ? box.w : horizontal > 0 ? 0 : box.w / 2);
        const pivotY = box.y + (vertical < 0 ? box.h : vertical > 0 ? 0 : box.h / 2);
        const extent = (pivot, limit, direction) => direction < 0 ? pivot : direction > 0 ? limit - pivot : 2 * Math.min(pivot, limit - pivot);
        const maxW = extent(pivotX, bounds.w, horizontal);
        const maxH = extent(pivotY, bounds.h, vertical);
        const nextW = horizontal ? clamp(box.w + horizontal * dx, Math.min(24, maxW), maxW) : box.w;
        const nextH = vertical ? clamp(box.h + vertical * dy, Math.min(24, maxH), maxH) : box.h;
        let w = nextW, h = nextH;
        if (ratio) {
            w = Math.min(horizontal ? nextW : Infinity, vertical ? nextH * ratio : Infinity, maxW, maxH * ratio);
            h = w / ratio;
        }
        return boundCrop({
            x: Math.round(pivotX - (horizontal < 0 ? w : horizontal === 0 ? w / 2 : 0)),
            y: Math.round(pivotY - (vertical < 0 ? h : vertical === 0 ? h / 2 : 0)),
            w: Math.round(w), h: Math.round(h),
        }, bounds);
    }

    function frameFor(image, box) {
        const xScale = image.naturalWidth / Math.max(1, image.clientWidth);
        const yScale = image.naturalHeight / Math.max(1, image.clientHeight);
        return {
            x: Math.round(box.x * xScale), y: Math.round(box.y * yScale),
            w: Math.max(1, Math.round(box.w * xScale)), h: Math.max(1, Math.round(box.h * yScale)),
        };
    }

    function surface(width, height) {
        const canvas = root.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        return { canvas, context, width, height };
    }

    function subimage(image, rect) {
        const layer = surface(rect.w, rect.h);
        layer.context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, layer.width, layer.height);
        return layer;
    }

    function crop(image, box) {
        const frame = frameFor(image, box);
        const x = Math.max(0, Math.min(image.naturalWidth - 1, frame.x));
        const y = Math.max(0, Math.min(image.naturalHeight - 1, frame.y));
        const rect = { x, y, w: Math.min(frame.w, image.naturalWidth - x), h: Math.min(frame.h, image.naturalHeight - y) };
        return { ...subimage(image, rect), rect };
    }

    function resize(image, size) {
        const layer = surface(size.targetW, size.targetH);
        layer.context.imageSmoothingQuality = 'high';
        layer.context.drawImage(image, 0, 0, layer.width, layer.height);
        return layer;
    }

    function gridRects(width, height, { rows, cols, gap, lines }) {
        function cuts(length, sections, direction) {
            if (!lines) return Array.from({ length: sections + 1 }, (_, index) => index * length / sections);
            const positions = lines.filter(item => item.type === direction)
                .map(item => Number(item.pos) * length).filter(pos => pos > 0 && pos < length);
            return [0, ...new Set(positions), length].sort((a, b) => a - b);
        }
        function intervals(points) {
            return points.slice(0, -1).map((point, index) => {
                const first = Math.round(point + (index ? gap / 2 : 0));
                const last = Math.round(points[index + 1] - (index < points.length - 2 ? gap / 2 : 0));
                return { first, size: last - first };
            });
        }
        const horizontal = intervals(cuts(width, cols, 'v'));
        const vertical = intervals(cuts(height, rows, 'h'));
        return vertical.flatMap(({ first: y, size: h }, row) =>
            horizontal.flatMap(({ first: x, size: w }, col) => w > 0 && h > 0 ? [{ row, col, x, y, w, h }] : []));
    }

    function mask(draw) {
        const layer = surface(draw.width, draw.height);
        const alpha = draw.getContext('2d').getImageData(0, 0, draw.width, draw.height).data;
        const pixels = layer.context.createImageData(draw.width, draw.height);
        for (let index = 0; index < alpha.length; index += 4) {
            const intensity = alpha[index + 3] > 8 ? 255 : 0;
            pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = intensity;
            pixels.data[index + 3] = 255;
        }
        layer.context.putImageData(pixels, 0, 0);
        return layer;
    }

    function flatten(image, layers) {
        const result = surface(image.naturalWidth, image.naturalHeight);
        for (const source of [image, ...layers]) result.context.drawImage(source, 0, 0);
        return result;
    }

    function png(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png');
        });
    }

    root.XiaomeiImageEditGeometry = {
        boundCrop, boundExpansion, fittedCrop, dragBox, frameFor, surface, subimage, crop, resize, gridRects, mask, flatten, png
    };
})(window);
