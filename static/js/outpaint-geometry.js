(function (root) {
    'use strict';
    function resize(start, source, handle, dx, dy, symmetric, ratio) {
        handle = ({left:'w', right:'e', top:'n', bottom:'s', corner:'se'})[handle] || handle;
        const left = handle.includes('w'), right = handle.includes('e');
        const top = handle.includes('n'), bottom = handle.includes('s');
        const horizontal = left || right, vertical = top || bottom;
        let w = start.w + (left ? -dx : right ? dx : 0) * (symmetric ? 2 : 1);
        let h = start.h + (top ? -dy : bottom ? dy : 0) * (symmetric ? 2 : 1);
        const minW = symmetric || (!horizontal && ratio > 0) ? Math.max(2 * start.x + source.w * 2 - start.w, start.w - 2 * start.x, source.w) : left ? start.w - start.x : start.x + source.w;
        const minH = symmetric || (!vertical && ratio > 0) ? Math.max(2 * start.y + source.h * 2 - start.h, start.h - 2 * start.y, source.h) : top ? start.h - start.y : start.y + source.h;
        if (ratio > 0) {
            if (horizontal && !vertical) h = w / ratio;
            else if (vertical && !horizontal) w = h * ratio;
            else if (Math.abs(w-start.w) >= Math.abs(h-start.h)*ratio) h = w / ratio;
            else w = h * ratio;
            w = Math.max(w, minW, minH * ratio); h = w/ratio;
        } else { w = Math.max(minW,w); h = Math.max(minH,h); }
        const x = start.x + (symmetric || (!horizontal && ratio > 0) ? (w-start.w)/2 : left ? w-start.w : 0);
        const y = start.y + (symmetric || (!vertical && ratio > 0) ? (h-start.h)/2 : top ? h-start.h : 0);
        return {w, h, x:Math.max(0,Math.min(w-source.w,x)), y:Math.max(0,Math.min(h-source.h,y))};
    }
    function output(frame, source, natural, resolution) {
        const rawW = frame.w * natural.w/source.w, rawH = frame.h * natural.h/source.h;
        const target = {'1k':1024,'2k':2048,'4k':3840}[resolution] || Math.max(rawW,rawH);
        const scale = target/Math.max(rawW,rawH);
        const result = {w:Math.max(1,Math.round(rawW*scale)),h:Math.max(1,Math.round(rawH*scale)),
            x:Math.round(frame.x*natural.w/source.w*scale),y:Math.round(frame.y*natural.h/source.h*scale),
            sourceW:Math.max(1,Math.round(natural.w*scale)),sourceH:Math.max(1,Math.round(natural.h*scale))};
        if(result.w*result.h>24000000 || Math.max(result.w,result.h)>16384) throw new Error('扩图尺寸过大，请选择 1K、2K 或 4K');
        return result;
    }
    root.XiaomeiOutpaintGeometry = {resize, output};
    if (typeof module !== 'undefined') module.exports = {resize, output};
})(typeof window === 'undefined' ? globalThis : window);
