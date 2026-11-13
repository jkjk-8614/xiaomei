(function (root) {
    'use strict';

    const optionLimit = 36;
    const foldersIn = library => (library?.categories || []).filter(folder => (folder.type || 'image') === 'image');
    const hasAssets = folders => folders.some(folder => (folder.items || []).some(item => item?.url));

    function assetChoices(urlItems, folder, kind) {
        const choices = new Map();
        function add(item, label, registrations) {
            if (!item?.url || choices.has(item.url)) return;
            choices.set(item.url, {
                url: item.url, kind: kind(item), name: label, alias: label, role: 'asset', asset_uris: registrations,
            });
        }
        urlItems.forEach((item, index) => add(item, item.name || 'URL ' + (index + 1), {}));
        for (const item of folder?.items || []) {
            if (!item?.url) continue;
            const activeUris = Object.entries(item.registrations || {})
                .filter(([, registration]) => registration?.status === 'Active' && registration.asset_uri)
                .map(([platform, registration]) => [platform, registration.asset_uri]);
            add(item, item.name || '资产' + (choices.size + 1), Object.fromEntries(activeUris));
        }
        return [...choices.values()];
    }

    function create(editor, panel, host) {
        const document = editor.ownerDocument;
        const content = host.content;
        let source, scope, folderId = '';
        let items = [];

        function element(tag, className, ...children) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            node.append(...children);
            return node;
        }
        function button(className, ...children) {
            const node = element('button', className, ...children);
            node.type = 'button';
            return node;
        }
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function activeLibrary(libraries) {
            const library = libraries.find(item => item.id === host.libraryId())
                || libraries.find(item => item.id === host.defaultLibraryId()) || libraries[0];
            host.selectLibrary(library?.id || '');
            return library;
        }
        function activeFolder(folders) {
            const folder = folders.find(item => item.id === folderId)
                || folders.find(item => item.items?.length) || folders[0];
            folderId = folder?.id || '';
            return folder;
        }
        function tab(id, label, glyph, enabled) {
            const control = button('mention-source-tab', icon(glyph), element('span', '', label));
            control.dataset.mentionSource = id;
            control.title = label;
            control.disabled = !enabled;
            control.classList.toggle('active', source === id);
            control.setAttribute('aria-pressed', String(source === id));
            return control;
        }
        function libraryControl(libraries, activeId) {
            const select = element('select', 'mention-library-select');
            select.dataset.mentionLibrary = '';
            for (const item of libraries) {
                const option = element('option', '', item.name || '资产库');
                option.value = item.id;
                select.append(option);
            }
            select.value = activeId;
            return element('label', 'mention-library-row', element('span', '', host.label('smart.assetLibrary')), select);
        }
        function folderControls(folders) {
            const row = element('div', folders.length ? 'mention-folder-chips' : 'mention-folder-chips hidden');
            for (const item of folders) {
                const label = item.name || host.label('smart.assetFolder');
                const control = button('mention-folder-chip', label);
                control.title = label;
                control.dataset.mentionFolder = item.id;
                control.classList.toggle('active', item.id === folderId);
                control.setAttribute('aria-pressed', String(item.id === folderId));
                row.append(control);
            }
            return row;
        }
        function choiceGrid() {
            if (!items.length) return element('div', 'mention-empty', host.label('smart.mentionEmpty'));
            const grid = element('div', 'mention-option-grid');
            items.forEach((item, index) => {
                const control = button('mention-option');
                control.dataset.mentionIndex = String(index);
                control.dataset.mentionUrl = item.url;
                if (host.kind(item) === 'audio') {
                    control.append(element('div', 'media-thumb audio-thumb mention-option-audio', icon('file-audio')));
                } else {
                    control.insertAdjacentHTML('beforeend', host.thumbnail(item));
                }
                control.append(element('span', '', item.alias || ''));
                grid.append(control);
            });
            return grid;
        }

        function position() {
            const row = editor.closest('.prompt-row');
            if (!row) return;
            const box = row.getBoundingClientRect();
            const width = row.offsetWidth || box.width;
            if (!width || !box.width) return;
            const scale = box.width / width;
            const caret = content.caretRect();
            if (!caret && panel.contains(document.activeElement)) return;
            const editorBox = editor.getBoundingClientRect();
            const limit = Math.max(4, width - (panel.offsetWidth || 340) - 4);
            const x = ((caret?.left || editorBox.left) - box.left) / scale - 6;
            const y = ((caret?.bottom || editorBox.top + 24 * scale) - box.top) / scale + 2;
            panel.style.left = Math.min(limit, Math.max(4, x)) + 'px';
            panel.style.top = Math.max(2, y) + 'px';
        }
        function close() {
            if (!panel.classList.contains('open')) return;
            panel.classList.remove('open');
            panel.replaceChildren();
            items = [];
            source = scope = undefined;
            host.closed();
        }
        function focusReplacement(previous) {
            const key = ['mentionSource', 'mentionLibrary', 'mentionFolder', 'mentionUrl']
                .find(name => previous?.dataset?.[name] !== undefined);
            if (!key) return;
            const control = [...panel.querySelectorAll('button, select')].find(node =>
                node.dataset[key] === previous.dataset[key] && !node.disabled);
            (control || panel.querySelector('.mention-source-tab.active'))?.focus({ preventScroll: true });
        }
        function render(preferredSource) {
            const subject = host.subject();
            if (!subject || (scope && scope !== subject)) return close();
            const inputs = host.inputs(subject);
            const libraries = host.libraries();
            let library = activeLibrary(libraries);
            const urlItems = host.urlItems().filter(item => item?.url);
            const libraryWithAssets = libraries.find(item => hasAssets(foldersIn(item)));
            const available = { input: inputs.length > 0, asset: Boolean(libraryWithAssets || urlItems.length) };
            if (!available.input && !available.asset) return close();
            source = available[preferredSource] ? preferredSource : available.input ? 'input' : 'asset';
            scope = subject;
            let folders = foldersIn(library);
            if (source === 'asset' && libraryWithAssets && !hasAssets(folders)) {
                library = libraryWithAssets;
                host.selectLibrary(library.id);
                folderId = '';
                folders = foldersIn(library);
            }
            const folder = activeFolder(folders);
            items = (source === 'asset' ? assetChoices(urlItems, folder, host.assetKind) : inputs).slice(0, optionLimit);
            const assetSource = source === 'asset';
            const tabs = element('div', 'mention-source-tabs',
                tab('input', host.label('smart.mentionInput'), 'image', available.input),
                tab('asset', host.label('smart.mentionAssets'), 'library', available.asset));
            const shell = element('div', 'mention-picker-shell', tabs);
            if (assetSource && libraries.length) shell.append(libraryControl(libraries, library.id));
            shell.append(folderControls(assetSource ? folders : []), element('div', 'mention-content', choiceGrid()));
            const focused = panel.contains(document.activeElement) ? document.activeElement : null;
            const scroll = panel.scrollTop;
            panel.replaceChildren(shell);
            panel.classList.add('open');
            panel.scrollTop = scroll;
            focusReplacement(focused);
            position();
            host.bindMedia(panel);
            host.icons();
        }
        function update(event) {
            if (event?.isComposing || (event?.type === 'keyup' && event.key === 'Escape')) return;
            const selection = document.getSelection();
            if (editor.dataset.promptLocked === '1' || !selection?.isCollapsed || !/[@＠]$/.test(content.beforeCaret())) {
                close();
                return;
            }
            content.remember();
            render(source);
        }
        function refreshAssets() {
            if (source === 'asset') render('asset');
        }

        editor.after(panel);
        panel.addEventListener('mousedown', event => {
            event.stopPropagation();
            if (event.target.closest('button')) event.preventDefault();
        });
        panel.addEventListener('click', event => {
            const control = event.target.closest('button');
            if (!control || control.disabled || !panel.contains(control)) return;
            event.stopPropagation();
            if (host.subject() !== scope) return close();
            const data = control.dataset;
            if (data.mentionSource) render(data.mentionSource);
            else if (data.mentionFolder !== undefined) {
                folderId = data.mentionFolder;
                render('asset');
            } else {
                const item = items[Number(data.mentionIndex)];
                if (item) content.insertReference(item);
            }
        });
        panel.addEventListener('change', event => {
            if (!event.target.matches('[data-mention-library]')) return;
            if (host.subject() !== scope) return close();
            host.selectLibrary(event.target.value);
            folderId = '';
            render('asset');
        });
        panel.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            content.restoreCaret();
            close();
        });
        const dismissOutside = event => {
            if (!editor.contains(event.target) && !panel.contains(event.target)) close();
        };
        document.addEventListener('click', dismissOutside, true);
        document.addEventListener('focusin', dismissOutside);

        return { update, close, position, refreshAssets, contains: target => panel.contains(target) };
    }

    root.XiaomeiSmartPromptMentions = { create };
})(window);
