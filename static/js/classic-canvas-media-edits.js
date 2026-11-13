(function (root) {
    'use strict';

    const { frameFor, surface, subimage, crop, resize, gridRects, mask, flatten, png } = root.XiaomeiImageEditGeometry;

    function outpaint(image, box) {
        const frame = frameFor(image, box);
        const layer = surface(Math.max(image.naturalWidth, frame.w), Math.max(image.naturalHeight, frame.h));
        layer.context.fillStyle = '#fff';
        layer.context.fillRect(0, 0, layer.width, layer.height);
        layer.context.drawImage(image, frame.x, frame.y);
        return layer;
    }

    function create(host) {
        const running = new WeakSet();

        async function apply() {
            const edit = host.snapshot();
            if (!edit || running.has(edit.identity)) return;
            const { identity, mode, image, node } = edit;
            if (!(image.naturalWidth && image.naturalHeight)) return;
            running.add(identity);
            host.busy(edit, true);
            const base = String(node.name || 'image').replace(/\.[^.]+$/, '');
            try {
                const blobs = [];
                let output;
                if (mode === 'grid') {
                    if (!edit.rects.length) return;
                    for (const rect of edit.rects) {
                        const piece = subimage(image, rect);
                        blobs.push({ blob: await png(piece.canvas), name: base + '_r' + (rect.row + 1) + '_c' + (rect.col + 1) + '.png' });
                        if (!host.current(edit)) return;
                    }
                    output = { mode, rects: edit.rects };
                } else {
                    const renderers = {
                        crop: () => crop(image, edit.box),
                        outpaint: () => outpaint(image, edit.box),
                        mask: () => mask(edit.layers[0]),
                        brush: () => flatten(image, edit.layers),
                        resize: () => resize(image, edit.size),
                    };
                    const layer = renderers[mode]();
                    const suffix = mode === 'brush' ? 'paint' : mode === 'resize' ? 'resize_' + Math.round(edit.size.scale * 100) + 'pct' : mode;
                    blobs.push({ blob: await png(layer.canvas), name: base + '_' + suffix + '.png' });
                    output = { mode, width: layer.width, height: layer.height };
                }
                if (!host.current(edit)) return;
                const files = await host.upload(blobs);
                if (!host.current(edit)) return;
                if (files.length !== blobs.length || files.some(file => !file?.url)) throw new Error(host.label('canvas.imageEditUploadFailed'));
                host.commit(edit, output, files);
            } catch (error) {
                if (host.current(edit)) host.error(error);
            } finally {
                running.delete(identity);
                host.busy(edit, false);
            }
        }

        return { apply };
    }

    root.XiaomeiClassicMediaEdits = { create, gridRects };
})(window);
