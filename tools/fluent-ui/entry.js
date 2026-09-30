import '@fluentui/web-components/button.js';
import { setTheme } from '@fluentui/web-components/theme/set-theme.js';
import { webLightTheme, webDarkTheme } from '@fluentui/tokens';

function accentLuminance(accent) {
    const rgb = accent.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!rgb) return 0;
    const linear = rgb.slice(1).map(channel => {
        const value = parseInt(channel, 16) / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function foregroundOnAccent(accent) {
    return accentLuminance(accent) > .179 ? '#000000' : '#ffffff';
}

function warmButtonAccent(accent) {
    const rgb = accent.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!rgb) return accent;
    const ink = [81, 59, 39];
    const channels = rgb.slice(1).map((value, index) => Math.round(parseInt(value, 16) * .72 + ink[index] * .28));
    const hex = () => '#' + channels.map(value => value.toString(16).padStart(2, '0')).join('');
    // Cream labels retain at least 4.5:1 contrast, including custom accent colors.
    while ((accentLuminance('#fffaf0') + .05) / (accentLuminance(hex()) + .05) < 4.5) {
        channels.forEach((value, index) => { channels[index] = Math.floor(value * .96); });
    }
    return hex();
}

function syncTheme() {
    const dark = document.documentElement.classList.contains('studio-theme-dark');
    const theme = dark ? webDarkTheme : webLightTheme;
    const skin = document.documentElement.dataset.studioSkin;
    const styles = getComputedStyle(document.documentElement);
    const font = styles.getPropertyValue('--studio-font-family').trim();
    const accent = styles.getPropertyValue('--studio-accent-color').trim();
    const warm = !dark && skin === 'warm';
    const buttonAccent = warm ? warmButtonAccent(accent) : accent;
    setTheme({
        ...theme,
        fontWeightRegular: '500',
        fontWeightSemibold: '600',
        colorNeutralForeground3: dark ? '#bdbdbd' : '#555555',
        fontFamilyBase: font || '"Segoe UI", "Microsoft YaHei UI", sans-serif',
        ...(!dark && skin === 'warm' ? {
            colorNeutralBackground1: '#fffaf0', colorNeutralBackground2: '#fff9ed', colorNeutralBackground3: '#f4ecd9',
            colorNeutralForeground1: '#3d2b1c', colorNeutralForeground2: '#604a35', colorNeutralForeground3: '#70583f',
            colorNeutralStroke1: '#dfcfb5', colorNeutralStroke2: '#d9c9ac',
        } : {}),
        ...(!dark && skin === 'soft' ? {
            colorNeutralBackground1: '#fafcf9', colorNeutralBackground2: '#f1f5ef', colorNeutralBackground3: '#eaf0e7',
        } : {}),
        ...(accent && CSS.supports('color', accent) ? {
            colorBrandBackground: buttonAccent,
            colorNeutralForegroundOnBrand: warm ? '#fffaf0' : foregroundOnAccent(accent),
            colorBrandBackgroundHover: `color-mix(in srgb, ${buttonAccent} 88%, black)`,
            colorBrandBackgroundPressed: `color-mix(in srgb, ${buttonAccent} 76%, black)`,
            colorBrandForeground1: dark ? `color-mix(in srgb, ${accent} 65%, white)` : `color-mix(in srgb, ${accent} 75%, black)`,
            colorBrandBackground2: `color-mix(in srgb, ${accent} 12%, ${warm ? '#fffaf0' : theme.colorNeutralBackground1})`,
            colorBrandStroke1: accent,
        } : {}),
    });
    document.documentElement.dataset.fluentReady = 'true';
}

window.addEventListener('studio-theme-change', syncTheme);
window.addEventListener('studio-appearance-change', syncTheme);
// Custom-element disabled state does not suppress existing host click listeners like a native button.
document.addEventListener('click', event => {
    const button = event.composedPath().find(node => node instanceof Element && node.matches('fluent-button'));
    if (button && (button.disabled || button.hasAttribute('disabled') || button.disabledFocusable)) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);
syncTheme();
