(function(){
    const KEY = 'studio_theme';
    const LEGACY_KEY = 'canvas_theme';
    const SCALE_KEY = 'studio_ui_scale_mode';
    const APPEARANCE_KEY = 'studio_appearance';
    const SCALE_OPTIONS = ['auto', '60', '65', '70', '75', '80', '85', '90', '95', '100', '115', '125', '140'];
    const APPEARANCE_DEFAULTS = { font:'system', fontSize:'normal', accent:'#3b82f6', eyeCare:false, skin:'minimal' };
    const SKIN_NAMES = new Set(['dark','soft','warm','minimal']);
    const FONT_FAMILIES = {
        system: 'Inter, "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
        sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
        rounded: '"Arial Rounded MT Bold", "Microsoft YaHei UI", "PingFang SC", sans-serif',
        serif: '"Noto Serif SC", "Songti SC", SimSun, serif'
    };
    const FONT_SIZES = { small:'14px', normal:'16px', large:'18px', xlarge:'20px' };

    function currentAppearance(){
        try {
            const stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') || {};
            if(!SKIN_NAMES.has(stored.skin)) stored.skin = currentTheme() === 'dark' ? 'dark' : (stored.eyeCare ? 'soft' : 'minimal');
            return { ...APPEARANCE_DEFAULTS, ...stored };
        } catch(e) {
            return { ...APPEARANCE_DEFAULTS };
        }
    }

    function applyAppearance(value){
        const next = { ...APPEARANCE_DEFAULTS, ...(value || {}) };
        next.skin = SKIN_NAMES.has(next.skin) ? next.skin : 'minimal';
        next.font = Object.hasOwn(FONT_FAMILIES, next.font) ? next.font : APPEARANCE_DEFAULTS.font;
        next.fontSize = Object.hasOwn(FONT_SIZES, next.fontSize) ? next.fontSize : APPEARANCE_DEFAULTS.fontSize;
        next.eyeCare = next.skin === 'soft';
        const root = document.documentElement;
        root.dataset.studioSkin = next.skin;
        root.style.setProperty('--studio-font-family', FONT_FAMILIES[next.font] || FONT_FAMILIES.system);
        root.style.setProperty('--studio-font-base', FONT_SIZES[next.fontSize] || FONT_SIZES.normal);
        root.style.setProperty('--studio-accent-color', next.accent || APPEARANCE_DEFAULTS.accent);
        root.style.setProperty('--accent', next.accent || APPEARANCE_DEFAULTS.accent);
        root.classList.toggle('studio-eye-care', !!next.eyeCare);
        if(document.body) document.body.classList.toggle('studio-eye-care', !!next.eyeCare);
        applyTheme(next.skin === 'dark' ? 'dark' : 'light');
        window.dispatchEvent(new CustomEvent('studio-appearance-change', { detail: next }));
        return next;
    }

    function broadcastAppearance(value){
        document.querySelectorAll('iframe').forEach(frame => {
            try { frame.contentWindow?.postMessage({ type:'studio-appearance', appearance:value }, '*'); } catch(e) {}
        });
    }

    function currentTheme(){
        try {
            return localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || 'light';
        } catch(e) {
            return 'light';
        }
    }

    function applyTheme(theme){
        const next = theme === 'dark' ? 'dark' : 'light';
        const dark = next === 'dark';
        document.documentElement.classList.toggle('studio-theme-dark', dark);
        document.documentElement.classList.toggle('theme-dark', dark);
        if(document.body){
            document.body.classList.toggle('studio-theme-dark', dark);
            document.body.classList.toggle('theme-dark', dark);
        }
        window.dispatchEvent(new CustomEvent('studio-theme-change', { detail: { theme: next } }));
    }

    function ensureScaleStyle(){
        if(document.getElementById('studio-scale-style')) return;
        const style = document.createElement('style');
        style.id = 'studio-scale-style';
        style.textContent = `
            html.studio-scale-managed {
                --studio-ui-scale: 1;
            }
            html.studio-ui-scaled,
            html.studio-ui-scaled body {
                overscroll-behavior-x: none;
            }
            html.studio-ui-scaled {
                overflow-x: hidden !important;
            }
            html.studio-ui-scaled::-webkit-scrollbar:horizontal,
            html.studio-ui-scaled body::-webkit-scrollbar:horizontal {
                height: 0 !important;
            }
            html.studio-ui-scaled body:not(.studio-scale-host) {
                width: 100% !important;
                min-height: calc(100vh / var(--studio-ui-scale)) !important;
                /*
                 * transform 会先把 iframe 页面栅格化再缩放，Windows 下的小号中文会发虚。
                 * zoom 参与布局计算，让 Chromium 按正常文字路径绘制，并保留自动适配能力。
                 */
                zoom: var(--studio-ui-scale);
            }
            html.studio-ui-scaled body.studio-scale-viewport:not(.studio-scale-host) {
                height: calc(100vh / var(--studio-ui-scale)) !important;
            }
            html.studio-ui-scaled body:not(.studio-scale-host) > .app-shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .asset-page,
            html.studio-ui-scaled body:not(.studio-scale-host) > .commerce-shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .commerce-page {
                width: 100% !important;
            }
            html.studio-ui-scaled body:not(.studio-scale-host) > .app-shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .commerce-shell,
            html.studio-ui-scaled body:not(.studio-scale-host) > .commerce-page {
                height: calc(100vh / var(--studio-ui-scale)) !important;
            }
            html.studio-ui-scaled body:not(.studio-scale-host) > .asset-page {
                min-height: calc(100vh / var(--studio-ui-scale)) !important;
            }
        `;
        document.head.appendChild(style);
    }

    function isFramed(){
        try {
            return window.self !== window.top;
        } catch(e) {
            return true;
        }
    }

    function normalizeScaleMode(mode){
        return SCALE_OPTIONS.includes(mode) ? mode : 'auto';
    }

    function currentScaleMode(){
        try {
            return normalizeScaleMode(localStorage.getItem(SCALE_KEY) || 'auto');
        } catch(e) {
            return 'auto';
        }
    }

    function autoScale(){
        const dpr = Math.max(1, Number(window.devicePixelRatio || 1));
        const viewportWidth = Math.max(320, Number(window.innerWidth || 0));
        const viewportHeight = Math.max(320, Number(window.innerHeight || 0));
        const compactRatio = Math.min(viewportWidth / 1500, viewportHeight / 940);
        if(compactRatio < 1) {
            return Math.max(0.68, Math.min(1, compactRatio));
        }
        const screenLong = Math.max(window.screen?.width || 0, window.screen?.height || 0);
        const viewportLong = Math.max(viewportWidth, viewportHeight);
        const longEdge = Math.max(screenLong, viewportLong);
        if(dpr >= 1.35) return 1;
        if(longEdge >= 3600) return 1.22;
        if(longEdge >= 3000) return 1.16;
        if(longEdge >= 2500 && dpr <= 1.15) return 1.1;
        return 1;
    }

    function scaleForMode(mode){
        const next = normalizeScaleMode(mode);
        if(next === 'auto' && Number.isFinite(externalScaleValue)) return externalScaleValue;
        if(next === 'auto') return autoScale();
        return Math.max(0.58, Math.min(1.4, Number(next) / 100));
    }

    let externalScaleValue = null;
    function normalizeExternalScale(value){
        const next = Number(value);
        return Number.isFinite(next) ? Math.max(0.58, Math.min(1.4, next)) : null;
    }

    function appliedScale(){
        const cssValue = Number(getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale'));
        return Number.isFinite(cssValue) && cssValue > 0 ? cssValue : scaleForMode(currentScaleMode());
    }

    function updateScaleBodyClasses(){
        if(!document.body) return;
        const hasFrameHost = !!document.querySelector('.app-shell iframe, iframe.active');
        document.body.classList.toggle('studio-scale-host', hasFrameHost && !isFramed());
        const computed = window.getComputedStyle(document.body);
        const viewportLocked = computed.overflow === 'hidden' || computed.overflowY === 'hidden' || !!document.querySelector('.app-shell, .shell');
        document.body.classList.toggle('studio-scale-viewport', viewportLocked);
    }

    function scaleOptedOut(){
        return document.documentElement.dataset.studioScale === 'off';
    }

    function contentFitOptedOut(){
        return document.documentElement.dataset.studioFitScale === 'off';
    }

    let horizontalScrollLockPending = false;
    function lockScaledHorizontalScroll(){
        if(horizontalScrollLockPending || !document.documentElement.classList.contains('studio-ui-scaled')) return;
        if(Math.abs(window.scrollX || 0) < 1) return;
        horizontalScrollLockPending = true;
        requestAnimationFrame(() => {
            horizontalScrollLockPending = false;
            if(document.documentElement.classList.contains('studio-ui-scaled') && Math.abs(window.scrollX || 0) >= 1) {
                window.scrollTo(0, window.scrollY || 0);
            }
        });
    }

    let contentFitTimer = null;
    function scheduleContentFit(mode){
        clearTimeout(contentFitTimer);
        if(mode !== 'auto' || scaleOptedOut() || contentFitOptedOut() || Number.isFinite(externalScaleValue)) return;
        contentFitTimer = setTimeout(() => {
            const root = document.documentElement;
            if(!root.classList.contains('studio-ui-scaled')) return;
            const current = Number(getComputedStyle(root).getPropertyValue('--studio-ui-scale')) || 1;
            const viewportWidth = Math.max(320, Number(window.innerWidth || 0));
            const contentWidth = Math.max(
                viewportWidth,
                root.scrollWidth || 0,
                document.body?.scrollWidth || 0,
                document.body?.offsetWidth || 0
            );
            const fitted = Math.max(0.58, Math.min(current, viewportWidth / contentWidth));
            if(fitted < current - 0.006) {
                root.style.setProperty('--studio-ui-scale', fitted.toFixed(3));
                lockScaledHorizontalScroll();
            }
        }, 80);
    }

    function applyScale(mode){
        ensureScaleStyle();
        const next = normalizeScaleMode(mode);
        const optedOut = scaleOptedOut();
        const value = scaleForMode(next);
        const scaled = !optedOut && Math.abs(value - 1) > 0.01;
        document.documentElement.classList.add('studio-scale-managed');
        document.documentElement.classList.toggle('studio-ui-scaled', scaled);
        document.documentElement.style.setProperty('--studio-ui-scale', value.toFixed(3));
        updateScaleBodyClasses();
        lockScaledHorizontalScroll();
        scheduleContentFit(next);
        window.dispatchEvent(new CustomEvent('studio-ui-scale-change', { detail: { mode: next, scale: value } }));
    }

    function broadcastScale(mode){
        const scale = appliedScale();
        document.querySelectorAll('iframe').forEach(frame => {
            try {
                frame.contentWindow?.postMessage({ type: 'studio-ui-scale', mode, scale }, '*');
            } catch(e) {}
        });
    }

    function setScaleMode(mode, shouldBroadcast = true){
        const next = normalizeScaleMode(mode);
        try {
            localStorage.setItem(SCALE_KEY, next);
        } catch(e) {}
        applyScale(next);
        if(shouldBroadcast) broadcastScale(next);
    }

    let resizeTimer = null;
    let autoScalePausedUntil = 0;
    function pauseAutoScale(duration = 650){
        autoScalePausedUntil = Math.max(autoScalePausedUntil, Date.now() + Math.max(0, Number(duration) || 0));
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scheduleAutoScaleRefresh, Math.max(0, autoScalePausedUntil - Date.now()) + 40);
    }

    function scheduleAutoScaleRefresh(){
        clearTimeout(resizeTimer);
        const wait = autoScalePausedUntil - Date.now();
        if(wait > 0) {
            resizeTimer = setTimeout(scheduleAutoScaleRefresh, wait + 40);
            return;
        }
        resizeTimer = setTimeout(() => {
            if(currentScaleMode() === 'auto') {
                applyScale('auto');
                broadcastScale('auto');
            }
        }, 160);
    }

    window.StudioTheme = {
        key: KEY,
        get: currentTheme,
        apply: applyTheme,
        set(theme){
            const next = theme === 'dark' ? 'dark' : 'light';
            localStorage.setItem(KEY, next);
            localStorage.setItem(LEGACY_KEY, next);
            applyTheme(next);
        }
    };

    window.StudioScale = {
        key: SCALE_KEY,
        options: SCALE_OPTIONS.slice(),
        getMode: currentScaleMode,
        getScale: () => scaleForMode(currentScaleMode()),
        apply: applyScale,
        set: setScaleMode
    };

    window.StudioAppearance = {
        key: APPEARANCE_KEY,
        defaults: { ...APPEARANCE_DEFAULTS },
        get: currentAppearance,
        apply: applyAppearance,
        set(value){
            const next = applyAppearance({ ...currentAppearance(), ...(value || {}) });
            try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)); } catch(e) {}
            try {
                const theme = next.skin === 'dark' ? 'dark' : 'light';
                localStorage.setItem(KEY, theme);
                localStorage.setItem(LEGACY_KEY, theme);
            } catch(e) {}
            broadcastAppearance(next);
            return next;
        }
    };

    applyTheme(currentTheme());
    applyScale(currentScaleMode());
    applyAppearance(currentAppearance());

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(currentTheme());
        applyScale(currentScaleMode());
        applyAppearance(currentAppearance());
    });
    window.addEventListener('message', event => {
        if(event.data?.type === 'studio-theme') applyTheme(event.data.theme);
        if(event.data?.type === 'studio-appearance') applyAppearance(event.data.appearance);
        if(event.data?.type === 'studio-ui-scale') {
            const incomingScale = normalizeExternalScale(event.data.scale);
            if(incomingScale !== null) externalScaleValue = incomingScale;
            setScaleMode(event.data.mode, false);
        }
        if(event.data?.type === 'studio-ui-scale-pause') pauseAutoScale(event.data.duration);
    });
    window.addEventListener('storage', event => {
        if(event.key === KEY || event.key === LEGACY_KEY) applyTheme(currentTheme());
        if(event.key === SCALE_KEY) applyScale(currentScaleMode());
        if(event.key === APPEARANCE_KEY) applyAppearance(currentAppearance());
    });
    window.addEventListener('resize', scheduleAutoScaleRefresh);
    window.addEventListener('scroll', lockScaledHorizontalScroll, { passive: true });
})();
