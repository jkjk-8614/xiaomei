export function scanFrame(autoLoad) {
    const found = new Map();
    const mediaPath = /\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|flv|m3u8|mpd)$/i;
    const mediaKind = path => /\.(m3u8|mpd)$/i.test(path) ? 'stream'
        : /\.(mp4|webm|mov|m4v|flv)$/i.test(path) ? 'video' : 'image';
    let inlineCount = 0;

    function add(value, kind, width = 0, height = 0, name = '') {
        if (!value || found.size >= 1200) return;
        let url;
        try { url = new URL(value, document.baseURI); } catch { return; }
        if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) return;
        const key = url.href;
        const previous = found.get(key);
        if (previous && previous.width >= width && previous.height >= height) return;
        if (!previous && url.protocol === 'data:' && inlineCount++ >= 80) return;
        const format = mediaPath.test(url.pathname) ? mediaKind(url.pathname) : kind;
        found.set(key, {url: key, kind: format, width, height, name});
    }

    function embeddedUrls(text) {
        const normalized = text.replace(/\\u002[fF]|\\\//g, '/');
        for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
            try {
                const url = new URL(match[0]);
                if (mediaPath.test(url.pathname)) add(url.href, mediaKind(url.pathname));
            } catch {}
        }
    }

    function addVariants(element) {
        for (const attribute of element.attributes) {
            const {name, value} = attribute;
            if (name === 'srcset' || name === 'data-srcset') {
                if (value.startsWith('data:')) continue;
                for (const choice of value.split(',')) add(choice.trim().split(/\s+/)[0], 'image');
            } else if (/^data-(?:src|original|lazy|full|hires|zoom|url|image|thumbnail|bg|background|video|preview|hover)(?:-|$)/i.test(name)) {
                add(value, name.includes('video') ? 'video' : 'image');
            } else if (!['src', 'href', 'xlink:href', 'style'].includes(name) && value.length <= 2000 && value.includes('http')) {
                embeddedUrls(value);
            }
        }
    }

    function visit(root) {
        for (const element of root.querySelectorAll('*')) {
            switch (element.localName) {
            case 'img':
                add(element.currentSrc || element.getAttribute('data-src') || element.src,
                    'image', element.naturalWidth, element.naturalHeight, element.alt);
                break;
            case 'image':
                add(element.getAttribute('href') || element.getAttribute('xlink:href'), 'image');
                break;
            case 'video':
                add(element.currentSrc || element.src, 'video', element.videoWidth, element.videoHeight);
                add(element.poster, 'image');
                for (const source of element.querySelectorAll('source[src]')) {
                    add(source.src, 'video', element.videoWidth, element.videoHeight);
                }
                break;
            case 'source':
                if (element.src && element.parentElement?.localName === 'picture') add(element.src, 'image');
                break;
            case 'canvas':
                if (element.width && element.height) {
                    try { add(element.toDataURL(), 'image', element.width, element.height, '画布'); } catch {}
                }
                break;
            case 'a':
                try {
                    const address = new URL(element.href, document.baseURI);
                    if (mediaPath.test(address.pathname)) add(address.href, mediaKind(address.pathname));
                } catch {}
                break;
            case 'meta':
            case 'link': {
                const metadata = ['property', 'name', 'rel'].map(name => element.getAttribute(name)).join(' ');
                if (/image|thumbnail|icon/.test(metadata) || (element.as === 'image' && /preload/.test(metadata))) {
                    add(element.getAttribute('content') || element.getAttribute('href'), 'image');
                }
                break;
            }
            case 'script':
                if (!element.src && element.textContent.length <= 2_000_000) embeddedUrls(element.textContent);
                break;
            }
            addVariants(element);
            if (element.getClientRects().length) {
                const background = getComputedStyle(element).backgroundImage;
                for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(match[1], 'image');
            }
            if (element.shadowRoot) visit(element.shadowRoot);
        }
    }

    return (async () => {
        visit(document);
        if (autoLoad) {
            const containers = [document.scrollingElement, ...[...document.querySelectorAll('main,article,section,div')]
                .filter(element => element.clientHeight > 180 && element.scrollHeight > element.clientHeight + 80
                    && /auto|scroll/.test(getComputedStyle(element).overflowY))].filter(Boolean).slice(0, 5);
            const positions = containers.map(element => element.scrollTop);
            try {
                for (let step = 0; step < 10; step++) {
                    let moved = false;
                    for (const element of containers) {
                        const old = element.scrollTop;
                        element.scrollTop = old + Math.max(160, element.clientHeight * .85);
                        moved ||= element.scrollTop > old;
                    }
                    if (!moved) break;
                    await new Promise(resolve => setTimeout(resolve, 160));
                    visit(document);
                }
            } finally {
                containers.forEach((element, index) => { element.scrollTop = positions[index]; });
            }
        }
        return [...found.values()];
    })();
}

export async function readFrameMedia(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('原网页无法读取此素材');
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({data: reader.result, type: blob.type});
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export function lowResolution(item) {
    if (item.kind !== 'image' || item.url.startsWith('data:')) return false;
    let width = item.width, height = item.height;
    if (!width || !height) {
        const guess = item.url.match(/(?:^|[^\d])(\d{2,5})x(\d{2,5})(?:[^\d]|$)/i);
        if (guess) {
            width ||= Number(guess[1]);
            height ||= Number(guess[2]);
        }
    }
    return (width > 0 && width < 500) || (height > 0 && height < 500);
}
