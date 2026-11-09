/* Xiaomei canvas key remainder.
   History chords (copy, paste, undo, redo, group, zoom preview) stay in
   XiaomeiHistoryKernel.chord. This table only decides what still happens
   when that call returns null, plus the smart-canvas prelude that must
   run before a chord because an open editor or a thumb drag consumes the key. */
(function (root) {
    'use strict';

    function text(value) {
        return String(value || '');
    }

    function lower(value) {
        return text(value).toLowerCase();
    }

    function push(list, effect) {
        list.push(effect);
        return list;
    }

    function classicRemainder(input) {
        var key = text(input.key);
        var name = lower(key);
        var surfaces = input.surfaces || {};
        var effects = [];
        if (name === 'r' && !input.editable) push(effects, { type: 'arm-rotate' });
        if (key === 'Shift' && !input.alt && !input.activeEditable) push(effects, { type: 'arm-knife' });
        if (key === 'Escape' && surfaces.imageEditor) {
            push(effects, { type: 'close', target: 'image-editor' });
            return { effects: effects, stop: true };
        }
        if (key === 'Escape' && surfaces.promptTemplates) {
            push(effects, { type: 'close', target: 'prompt-templates' });
            return { effects: effects, stop: true };
        }
        if (surfaces.lightbox && (key === 'ArrowLeft' || key === 'ArrowRight')) {
            push(effects, { type: 'lightbox-step', direction: key === 'ArrowRight' ? 1 : -1 });
            return { effects: effects, stop: true };
        }
        if (key === 'Escape' && surfaces.lightbox) {
            push(effects, { type: 'close', target: 'lightbox' });
            return { effects: effects, stop: true };
        }
        if (input.command && name === 'g') push(effects, { type: 'group', prevent: true });
        if ((key === 'Delete' || key === 'Backspace') && !input.fieldFocused && input.selectionCount > 0) {
            push(effects, { type: 'delete-selection', prevent: true });
        }
        return { effects: effects, stop: false };
    }

    function smartPrelude(input) {
        var key = text(input.key);
        var name = lower(key);
        var effects = [];
        if (key === 'Escape' && input.thumbDrag) {
            return { skipChord: true, effects: [{ type: 'clear-thumb', prevent: true }] };
        }
        if (key === 'Control' || key === 'Meta') push(effects, { type: 'arm-erase' });
        if (name === 'r' && !input.editable) push(effects, { type: 'arm-rotate' });
        if (input.imageEditor) {
            if (key === 'Escape') push(effects, { type: 'close-editor' });
            if (input.previewMode && !input.editable && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                push(effects, {
                    type: 'preview-step',
                    direction: key === 'ArrowLeft' ? -1 : 1,
                    prevent: true
                });
            }
            return { skipChord: true, effects: effects };
        }
        return { skipChord: false, effects: effects };
    }

    function smartRemainder(input) {
        var name = lower(input.key);
        if (!input.command && !input.alt && !input.editable && name === 'a' && !input.repeat) {
            return { effects: [{ type: 'toggle-assets', prevent: true }] };
        }
        return { effects: [] };
    }

    root.XiaomeiCanvasKeys = {
        classicRemainder: classicRemainder,
        smartPrelude: smartPrelude,
        smartRemainder: smartRemainder
    };
})(typeof window !== 'undefined' ? window : globalThis);
