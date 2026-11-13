(function (view) {
    'use strict';

    const page = view.document;
    const nonPassive = { passive: false };
    const nativeTargets = 'input, textarea, select, audio, video, [contenteditable]:not([contenteditable="false"]), [data-native-touch]';
    const dragSlop = 8;
    const tapLimit = 600;
    const doubleTapLimit = 350;
    const pinchIncrement = 0.06;
    let gesture;
    let previousTap;

    function usesNativeTouch(target) {
        if (!(target instanceof view.Element) || target.closest(nativeTargets)) return true;
        for (let ancestor = target; ancestor && ancestor !== page.body; ancestor = ancestor.parentElement) {
            const style = view.getComputedStyle(ancestor);
            const scrolls = value => value === 'auto' || value === 'scroll';
            if (scrolls(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1) return true;
            if (scrolls(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1) return true;
        }
        return false;
    }

    function point(touch) {
        return { x: touch.clientX, y: touch.clientY };
    }

    function between(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function matching(touches, identifier) {
        return Array.from(touches).find(touch => touch.identifier === identifier);
    }

    function targetAt(at, origin) {
        return page.elementFromPoint(at.x, at.y) || (origin?.isConnected ? origin : page.body);
    }

    function mouse(type, at, origin, buttons, detail = 1) {
        targetAt(at, origin).dispatchEvent(new view.MouseEvent(type, {
            view, bubbles: true, cancelable: true, composed: true,
            clientX: at.x, clientY: at.y, button: 0, buttons, detail,
        }));
    }

    function pinchGeometry(touches) {
        const a = point(touches[0]);
        const b = point(touches[1]);
        return {
            center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            distance: Math.max(1, between(a, b)),
        };
    }

    function releaseDrag(at, tapped) {
        const drag = gesture;
        gesture = undefined;
        mouse('mouseup', at, drag.origin, 0);
        if (!tapped) return;
        mouse('click', at, drag.origin, 0);
        const now = view.performance.now();
        if (previousTap && now - previousTap.time < doubleTapLimit && between(at, previousTap.at) < 32) {
            mouse('dblclick', at, drag.origin, 0, 2);
            previousTap = undefined;
        } else {
            previousTap = { at, time: now };
        }
    }

    function start(event) {
        if (event.defaultPrevented || usesNativeTouch(event.target)) return;
        const count = event.touches.length;
        if (count === 1 && !gesture) {
            const touch = event.touches[0];
            const at = point(touch);
            event.preventDefault();
            gesture = {
                type: 'drag', identifier: touch.identifier, at, first: at, origin: event.target,
                started: view.performance.now(), moved: false,
            };
            mouse('mousedown', at, gesture.origin, 1);
        } else if (count >= 2) {
            event.preventDefault();
            if (gesture?.type === 'drag') releaseDrag(gesture.at, false);
            previousTap = undefined;
            gesture = count === 2
                ? { type: 'pinch', distance: pinchGeometry(event.touches).distance }
                : { type: 'multi' };
        }
    }

    function move(event) {
        if (!gesture) return;
        event.preventDefault();
        if (gesture.type === 'drag') {
            const touch = matching(event.touches, gesture.identifier);
            if (!touch) return;
            gesture.at = point(touch);
            gesture.moved ||= between(gesture.at, gesture.first) > dragSlop;
            mouse('mousemove', gesture.at, gesture.origin, 1);
        } else if (gesture.type === 'pinch' && event.touches.length === 2) {
            const { center, distance } = pinchGeometry(event.touches);
            const steps = Math.trunc(Math.log(distance / gesture.distance) / pinchIncrement);
            if (!steps) return;
            gesture.distance *= Math.exp(steps * pinchIncrement);
            const target = targetAt(center);
            for (let index = 0; index < Math.abs(steps); index++) {
                target.dispatchEvent(new view.WheelEvent('wheel', {
                    view, bubbles: true, cancelable: true, composed: true,
                    clientX: center.x, clientY: center.y, deltaY: steps > 0 ? -100 : 100,
                }));
            }
        }
    }

    function finish(event) {
        if (!gesture) return;
        if (gesture.type === 'drag') {
            const touch = matching(event.changedTouches, gesture.identifier);
            if (!touch) return;
            event.preventDefault();
            const at = point(touch);
            const tapped = event.type === 'touchend' && !gesture.moved && between(at, gesture.first) <= dragSlop
                && view.performance.now() - gesture.started < tapLimit;
            releaseDrag(at, tapped);
        } else {
            event.preventDefault();
            if (!event.touches.length) gesture = undefined;
            else if (event.touches.length !== 2) gesture = { type: 'multi' };
        }
    }

    page.addEventListener('touchstart', start, nonPassive);
    page.addEventListener('touchmove', move, nonPassive);
    page.addEventListener('touchend', finish, nonPassive);
    page.addEventListener('touchcancel', finish, nonPassive);
})(window);
