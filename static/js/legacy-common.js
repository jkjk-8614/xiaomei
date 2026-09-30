/* Shared low-risk helpers for the direct-link/legacy pages. */
(function (global) {
    function generateUUID() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            try { return global.crypto.randomUUID(); } catch (error) { /* fallback below */ }
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
            const random = Math.random() * 16 | 0;
            const value = char === 'x' ? random : (random & 0x3 | 0x8);
            return value.toString(16);
        });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
            return ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[char];
        });
    }

    function bindDropZone(zone, onFile, options) {
        if (!zone || typeof onFile !== 'function') return () => {};
        const config = options || {};
        const activeClasses = Array.isArray(config.activeClass)
            ? config.activeClass
            : [config.activeClass || 'drag-over'];
        const setActive = (active) => activeClasses.filter(Boolean).forEach((className) => {
            zone.classList.toggle(className, active);
        });
        const dragOver = (event) => {
            event.preventDefault();
            setActive(true);
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        };
        const dragLeave = (event) => {
            if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
            setActive(false);
        };
        const drop = (event) => {
            event.preventDefault();
            setActive(false);
            const file = Array.from(event.dataTransfer?.files || [])[0];
            if (file) onFile(file, event);
        };
        zone.addEventListener('dragover', dragOver);
        zone.addEventListener('dragleave', dragLeave);
        zone.addEventListener('drop', drop);
        return () => {
            zone.removeEventListener('dragover', dragOver);
            zone.removeEventListener('dragleave', dragLeave);
            zone.removeEventListener('drop', drop);
        };
    }

    const api = Object.freeze({ generateUUID, escapeHtml, bindDropZone });
    global.XiaomeiLegacy = api;
    // Existing direct-link pages call these names from inline scripts.
    global.generateUUID = generateUUID;
    global.escapeHtml = escapeHtml;
}(window));
