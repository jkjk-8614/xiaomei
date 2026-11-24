(function(){
    const VERSION = '2026.11.23.api-settings.2';
    const scripts = [
        '/static/js/i18n-core.js',
        '/static/js/i18n/common.js',
        '/static/js/i18n/studio.js',
        '/static/js/i18n/api-settings.js',
        '/static/js/i18n/canvas.js',
        '/static/js/i18n/smart-canvas.js',
    ].map(src => src + '?v=' + (src.endsWith('/smart-canvas.js') ? '2026.11.23.prompt-shortcut.1' : VERSION));
    scripts.push('/static/js/i18n/comfyui-settings.js?v=2026.11.12.workflow-shell');
    const tags = scripts.map(src => '<script src="' + src + '"></script>').join('');
    if(document.readyState === 'loading' && document.currentScript){
        document.write(tags);
        return;
    }
    scripts.reduce((promise, src) => promise.then(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    })), Promise.resolve()).then(() => window.StudioI18n?.apply?.()).catch(err => console.error('Failed to load i18n modules', err));
})();
