(function (global) {
    'use strict';

    const downloadNames = {
        asset: 'assets.zip', local: 'local-assets.zip', storage: '素材.zip', canvas: 'canvas-assets.zip',
    };

    function create({ notice, icons }) {
        const document = global.document;
        const editor = global.XiaomeiCanvasEditorCore;
        let active;

        function node(name, classes, text) {
            const element = document.createElement(name);
            if (classes) element.className = classes;
            if (text) element.textContent = text;
            return element;
        }
        function copyButton(classes) {
            const button = node('button', classes);
            button.type = 'button';
            const glyph = node('i');
            glyph.dataset.lucide = 'copy';
            button.append(glyph, node('span', '', '复制图片'));
            return button;
        }
        function close() {
            if (!active) return;
            const { overlay, opener, listeners } = active;
            active = null;
            listeners.abort();
            overlay.remove();
            document.body.classList.remove('asset-lightbox-open');
            opener?.focus({ preventScroll: true });
        }
        function show(item, kind) {
            if (!item) return;
            if (kind !== 'image' && kind !== 'video') {
                notice('仅图片和视频支持预览');
                return;
            }
            if (!item.url) return;
            close();
            const overlay = node('div', 'asset-lightbox');
            const dialog = node('div', 'asset-lightbox-inner');
            dialog.tabIndex = -1;
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-label', kind === 'image' ? '图片预览' : '视频预览');
            const media = node(kind === 'image' ? 'img' : 'video', 'asset-lightbox-' + kind);
            if (kind === 'image') {
                media.alt = item.name || 'preview';
                media.draggable = false;
            } else {
                media.controls = true;
                media.autoplay = true;
                media.playsInline = true;
                media.preload = 'metadata';
            }
            media.src = item.url;
            dialog.append(media);
            overlay.append(dialog);
            const view = { overlay, dialog, media, opener: document.activeElement, listeners: new AbortController() };
            active = view;
            overlay.addEventListener('click', event => {
                if (active === view && !event.target.closest('.asset-lightbox-image,.asset-lightbox-video,.asset-lightbox-actions,.asset-context-menu')) close();
            });
            if (kind === 'image') bindImage(view, item.url);
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !event.isComposing) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (view.menu?.hidden === false) {
                        view.menu.hidden = true;
                        view.copy.focus({ preventScroll: true });
                    } else close();
                } else if (view.copy && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
                    && !event.isComposing && event.key.toLowerCase() === 'c') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (!event.repeat) view.copy.click();
                }
            }, { capture: true, signal: view.listeners.signal });
            document.body.append(overlay);
            document.body.classList.add('asset-lightbox-open');
            if (kind === 'image') icons();
            dialog.focus({ preventScroll: true });
        }
        function bindImage(view, url) {
            const { overlay, dialog, media } = view;
            const toolbar = node('div', 'asset-lightbox-actions');
            const copy = copyButton('asset-btn');
            copy.dataset.lightboxCopy = '';
            copy.title = '复制图片 (Ctrl+C / ⌘C)';
            const status = node('span', 'asset-status asset-lightbox-status');
            status.setAttribute('role', 'status');
            const menu = node('div', 'asset-context-menu');
            menu.setAttribute('role', 'group');
            menu.setAttribute('aria-label', '图片操作');
            menu.hidden = true;
            const menuAction = copyButton('');
            toolbar.append(copy, status);
            menu.append(menuAction);
            dialog.append(toolbar, menu);
            Object.assign(view, { copy, menu });
            let copying = false;
            copy.addEventListener('click', async () => {
                if (copying) return;
                copying = true;
                status.textContent = '正在复制图片…';
                try {
                    const source = new URL(url, global.location.href);
                    const crossOrigin = /^https?:$/.test(source.protocol) && source.origin !== global.location.origin;
                    const address = crossOrigin ? editor.proxyMediaUrl(source.href, '', { inline: true }) : url;
                    await global.StudioImageClipboard.writeImage(address);
                    if (active === view) status.textContent = '图片已复制，可直接粘贴';
                } catch (error) {
                    if (active === view) {
                        console.warn('[asset-preview] copy image failed', error);
                        status.textContent = '复制失败，请重试或关闭预览后下载图片';
                    }
                } finally {
                    copying = false;
                }
            });
            menuAction.addEventListener('click', () => {
                menu.hidden = true;
                copy.focus({ preventScroll: true });
                copy.click();
            });
            media.addEventListener('contextmenu', event => {
                event.preventDefault();
                menu.hidden = false;
                const menuRect = menu.getBoundingClientRect();
                const bounds = overlay.getBoundingClientRect();
                const scale = bounds.width / overlay.offsetWidth || 1;
                const margin = 8;
                menu.style.left = Math.max(margin, Math.min(event.clientX, global.innerWidth - menuRect.width - margin)) / scale + 'px';
                menu.style.top = Math.max(margin, Math.min(event.clientY, global.innerHeight - menuRect.height - margin)) / scale + 'px';
                menuAction.focus({ preventScroll: true });
            });
            overlay.addEventListener('pointerdown', event => {
                if (!menu.contains(event.target)) menu.hidden = true;
            });
            dialog.addEventListener('keydown', event => {
                if (event.key !== 'Tab') return;
                event.preventDefault();
                (menu.hidden ? copy : menuAction).focus({ preventScroll: true });
            });
            bindImageTransform(overlay, media);
        }
        function bindImageTransform(overlay, image) {
            let zoom = 1;
            let panX = 0;
            let panY = 0;
            let drag;
            const update = () => {
                image.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
                overlay.classList.toggle('zoomed', zoom > 1.01);
            };
            image.addEventListener('wheel', event => {
                event.preventDefault();
                const bounds = overlay.getBoundingClientRect();
                const scale = bounds.width / overlay.offsetWidth || 1;
                const x = (event.clientX - bounds.left - bounds.width / 2) / scale;
                const y = (event.clientY - bounds.top - bounds.height / 2) / scale;
                const next = Math.min(8, Math.max(.25, zoom * (event.deltaY < 0 ? 1.15 : .87)));
                const ratio = next / zoom;
                panX = next > 1.01 ? x * (1 - ratio) + panX * ratio : 0;
                panY = next > 1.01 ? y * (1 - ratio) + panY * ratio : 0;
                zoom = next;
                update();
            }, { passive: false });
            image.addEventListener('pointerdown', event => {
                if (event.button !== 0 || zoom <= 1.01 || drag) return;
                event.preventDefault();
                const scale = overlay.getBoundingClientRect().width / overlay.offsetWidth || 1;
                image.setPointerCapture(event.pointerId);
                drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, scale };
                overlay.classList.add('dragging');
            });
            image.addEventListener('pointermove', event => {
                if (event.pointerId !== drag?.id) return;
                panX = drag.panX + (event.clientX - drag.x) / drag.scale;
                panY = drag.panY + (event.clientY - drag.y) / drag.scale;
                update();
            });
            const finish = event => {
                if (event.pointerId !== drag?.id) return;
                drag = null;
                overlay.classList.remove('dragging');
            };
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) image.addEventListener(name, finish);
        }

        function downloadName(item) {
            const label = String(item.name || 'asset');
            try {
                const url = editor.originalMediaUrl(item.url);
                if (/^(blob|data):/i.test(url)) return label;
                const base = editor.fileNameFromUrl(url);
                const match = base.match(/\.[^.]+$/);
                const extension = match?.[0] || '';
                return extension && !label.toLowerCase().endsWith(extension.toLowerCase()) ? label + extension : label;
            } catch (_) {
                return label;
            }
        }
        async function readBlob(pending, fallback) {
            const response = await pending;
            if (response.ok) return response.blob();
            const error = await response.json().catch(() => ({}));
            throw new Error(typeof error?.detail === 'string' && error.detail ? error.detail : fallback);
        }
        function archive(items, filename, fallback) {
            return readBlob(global.fetch('/api/canvas-assets/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, items }),
            }), fallback);
        }
        function saveBlob(blob, filename) {
            const address = global.URL.createObjectURL(blob);
            const link = node('a');
            link.href = address;
            link.download = filename;
            document.body.append(link);
            try {
                link.click();
            } finally {
                link.remove();
                global.setTimeout(() => global.URL.revokeObjectURL(address), 1200);
            }
        }
        async function download(items, kind) {
            const canvas = kind === 'canvas';
            const label = canvas ? '画布资产' : '素材';
            const files = items.filter(item => item?.url).map(item => ({
                url: item.url, name: canvas ? item.name || 'canvas-asset' : downloadName(item),
            }));
            if (!files.length) {
                if (kind !== 'storage') notice('没有可下载的' + label);
                return;
            }
            try {
                if (files.length === 1) {
                    const started = await editor.downloadUrl(files[0].url, files[0].name);
                    if (started) notice(canvas ? '已下载画布资产' : '已开始下载');
                    return;
                }
                notice('正在打包 ' + files.length + ' 个' + label + '...');
                const filename = downloadNames[kind];
                const fallback = canvas ? '下载画布资产失败' : kind === 'storage' ? '打包下载失败' : '下载失败';
                saveBlob(await archive(files, filename, fallback), filename);
                notice('已下载 ' + files.length + ' 个' + label);
            } catch (error) {
                notice(error.message || '下载失败');
            }
        }
        async function copyText(value) {
            const text = String(value ?? '');
            if (!text) return false;
            try {
                if (global.navigator.clipboard?.writeText) {
                    await global.navigator.clipboard.writeText(text);
                    return true;
                }
            } catch (_) {}
            const previous = document.activeElement;
            const field = node('textarea');
            field.value = text;
            field.readOnly = true;
            Object.assign(field.style, { position: 'fixed', insetInlineStart: '-9999px', insetBlockStart: '0' });
            document.body.append(field);
            try {
                field.select();
                return document.execCommand('copy');
            } catch (_) {
                return false;
            } finally {
                field.remove();
                previous?.focus({ preventScroll: true });
            }
        }

        return { show, download, readBlob, archive, saveBlob, copyText };
    }

    global.XiaomeiAssetManagerMedia = { create };
}(window));
