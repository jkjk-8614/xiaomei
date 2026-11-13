(function (root) {
    'use strict';

    function promptFor({ w, h, x, y, sourceW, sourceH }, custom) {
        const boundary = '这是一张已排好位置的扩图底图，完整画布为 ' + w + '×' + h
            + '。原图区域位于左上角 (' + x + ', ' + y + ')，大小 ' + sourceW + '×' + sourceH
            + '；坐标均以完整画布为准。请生成一张自然连续的完整扩图，补全原图外的透明区域。'
            + '尽量保持原图主体的位置、大小以及人物、商品、文字和相框的特征；为了让新画面自然衔接，可以调整原图区域的光线和纹理。'
            + '不要把原图缩小后重新放进画面，不要生成画中画、矩形接缝或重复的主体。'
            + '保持完整画布的宽高比与整体构图，扩展区域沿原图边缘连续延伸背景和透视，不要添加边框或留白。';
        return custom ? custom + '\n\n' + boundary : boundary;
    }

    function afterPaint() {
        return new Promise(resolve => root.requestAnimationFrame(() => root.setTimeout(resolve, 0)));
    }

    function create(host) {
        async function apply({ autoRun = false } = {}) {
            if (!host.state()) {
                host.error('扩图区域尚未准备好，请稍后再试');
                return false;
            }
            const source = host.current();
            if (!source.node || !source.image || !host.ready()) {
                host.error('当前图片尚未加载完成，请稍后再试');
                return false;
            }
            const settings = host.settings(source.node);
            if (autoRun && !settings) {
                host.chooseModel();
                return false;
            }
            const pixels = host.pixels();
            if (!pixels) return false;
            const plan = {
                source,
                placement: pixels.placement,
                filename: String(source.image.name || 'image').replace(/\.[^.]+$/, '') + '_outpaint.png',
                prompt: promptFor(pixels.placement, host.prompt()),
                settings
            };
            const job = host.reserve(plan);
            if (!job) return false;

            let file;
            host.working(1);
            try {
                host.showCanvas();
                await afterPaint();
                if (!host.active(job)) return false;
                const blob = await root.XiaomeiImageEditGeometry.png(pixels.canvas);
                if (!host.active(job)) return false;
                file = await host.upload(blob, plan.filename);
                if (!file?.url) throw new Error('扩图底图生成失败');
                if (!host.active(job)) return false;
                host.attach(job, file, plan.placement);
            } catch (error) {
                if (!host.active(job)) return false;
                host.failed(job, error);
                throw error;
            } finally {
                host.working(-1);
                host.save();
            }
            if (autoRun && host.active(job)) await host.run(job, plan, file);
            return true;
        }

        return { apply };
    }

    root.XiaomeiSmartOutpaint = { create };
})(window);
