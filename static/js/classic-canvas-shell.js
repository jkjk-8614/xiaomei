(function (root) {
    'use strict';

    const projectKey = 'canvasListCurrentProjectId';

    function create(host) {
        const { document } = root;
        const surface = root.XiaomeiCanvasSurface;
        const createMenu = document.getElementById('createMenu');
        const mediaMenu = document.getElementById('imageNodeMenu');
        const toolbar = document.getElementById('quickToolbar');
        const toggle = toolbar?.querySelector('[data-canvas-toolbar-toggle]');
        const dialog = document.getElementById('errorModal');
        const errorTitle = document.getElementById('errorTitle');
        const errorMessage = document.getElementById('errorMessage');
        const title = document.getElementById('currentCanvasTitle');
        const time = document.getElementById('currentCanvasTime');
        const saveState = document.getElementById('saveState');
        const params = new URLSearchParams(root.location.search);
        let expanded = true;
        let createAt;

        function paintToolbar() {
            if (!toggle) return;
            const scale = parseFloat(root.getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale')) || 1;
            const label = expanded ? '折叠快捷菜单' : '展开快捷菜单';
            toolbar.classList.toggle('collapsed', !expanded);
            toolbar.classList.toggle('scale-expanded', expanded && scale < 0.995);
            toggle.title = label;
            toggle.setAttribute('aria-label', label);
            toggle.setAttribute('aria-expanded', String(expanded));
        }

        function showError(message, heading = host.label('canvas.generationFailed')) {
            if (!dialog || !errorMessage) {
                root.alert(message || heading);
                return;
            }
            errorTitle.textContent = heading || host.label('canvas.generationFailed');
            errorMessage.textContent = message || heading;
            dialog.classList.add('open');
            host.icons();
        }

        async function copyError() {
            const message = errorMessage.textContent;
            if (!message || await host.copy(message)) return;
            if (!dialog.classList.contains('open') || errorMessage.textContent !== message) return;
            const selection = root.getSelection();
            const range = document.createRange();
            range.selectNodeContents(errorMessage);
            selection?.removeAllRanges();
            selection?.addRange(range);
        }

        function updateTime(timestamp) {
            const value = Number(timestamp);
            const date = new Date(value < 1e10 ? value * 1000 : value);
            const locale = host.english() ? 'en-US' : 'zh-CN';
            time.textContent = value && !Number.isNaN(date.valueOf())
                ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '--';
        }

        function refreshTitle() {
            const canvas = host.canvas();
            if (canvas) title.textContent = canvas.title || host.label('canvas.untitled');
        }

        function refreshHeader() {
            const canvas = host.canvas();
            refreshTitle();
            updateTime(canvas?.updated_at || canvas?.created_at);
        }

        function revealCanvas() {
            host.element.classList.remove('no-canvas');
            refreshHeader();
            host.icons();
        }

        function status(message) {
            saveState.textContent = message;
        }

        function requireCanvas() {
            if (host.canvas()) return true;
            status(host.label('canvas.needCanvas'));
            return false;
        }

        function storedProject() {
            try { return root.localStorage.getItem(projectKey) || 'default'; }
            catch { return 'default'; }
        }

        function rememberProject(value = 'default') {
            const id = value || 'default';
            try { root.localStorage.setItem(projectKey, id); } catch {}
            return id;
        }

        function projectId() {
            const current = host.canvas()?.project || params.get('project');
            return String(current || '').trim() || storedProject().trim() || 'default';
        }

        function projectListUrl() {
            const requested = params.get('id') && params.get('project');
            const id = rememberProject(host.canvas()?.project || requested || storedProject());
            return '/static/canvas-list.html?' + new URLSearchParams({ project: id, v: '2026.09.09.project-trash1' });
        }

        function closeMediaMenu() {
            mediaMenu.classList.remove('open', 'output-node-menu');
            mediaMenu.replaceChildren();
        }

        function closeMenus() {
            createMenu.classList.remove('open');
            host.closeLinkMenu();
            closeMediaMenu();
        }

        function openCreateMenu(x, y) {
            host.closeLinkMenu();
            createAt = host.pointAt(x, y);
            surface.pinMenu(createMenu, x, y);
            createMenu.classList.add('open');
            host.icons();
        }

        function previewableKind(node) {
            if (!node?.url || host.missing(node.url)) return '';
            const kind = host.mediaKind(node);
            return kind === 'video' || kind === 'image' ? kind : '';
        }

        function previewImage(id) {
            const node = host.node(id);
            if (previewableKind(node)) host.preview(node.url, node);
        }

        function openImageMenu(id, x, y) {
            const node = host.node(id);
            if (node?.type !== 'image') return;
            closeMenus();
            const kind = previewableKind(node);
            const items = [];
            function option(icon, label, action) {
                items.push({ icon, label, onClick(event) {
                    event.stopPropagation();
                    closeMediaMenu();
                    action(id);
                } });
            }
            if (kind) option('eye', '预览', previewImage);
            if (kind === 'image') option('pencil', '编辑', host.edit);
            option('image-plus', '替换', host.pick);
            surface.paintMenu(mediaMenu, [{ items }]);
            surface.pinMenu(mediaMenu, x, y).classList.add('open');
            host.icons();
        }

        function openOutputMenu(id, x, y) {
            const node = host.node(id);
            if (node?.type !== 'output') return;
            closeMenus();
            host.outputMenu(node, x, y);
        }

        function start() {
            function reflectTheme() {
                host.element.classList.toggle('theme-dark', document.documentElement.classList.contains('studio-theme-dark'));
            }
            reflectTheme();
            root.addEventListener('studio-theme-change', reflectTheme);
            root.addEventListener('studio-ui-scale-change', paintToolbar);
            toggle?.addEventListener('click', () => {
                expanded = !expanded;
                paintToolbar();
            });
            paintToolbar();
            dialog?.addEventListener('click', event => {
                if (event.target === dialog || event.target.closest('[data-canvas-error-close]')) {
                    dialog.classList.remove('open');
                } else if (event.target.closest('[data-canvas-error-copy]')) {
                    copyError();
                }
            });
            surface.fillClassicCreateMenu(createMenu, host.label, type => {
                closeMenus();
                host.add(type, createAt);
            });
        }

        return { start, showError, updateTime, refreshTitle, refreshHeader, revealCanvas, status, requireCanvas,
            projectId, rememberProject, projectListUrl, openCreateMenu, closeMenus, closeMediaMenu,
            openImageMenu, previewImage, openOutputMenu };
    }

    root.XiaomeiClassicCanvasShell = { create };
})(window);
