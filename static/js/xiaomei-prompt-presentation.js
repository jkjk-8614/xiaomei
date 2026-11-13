(function (root) {
    'use strict';

    const compact = value => String(value ?? '').trim().replace(/\s+/g, ' ');

    function description(scene, body) {
        const text = String(scene ?? '').trim();
        return compact(body).startsWith(compact(text)) ? '' : text;
    }

    root.XiaomeiPromptPresentation = { description };
})(window);
