(function (root) {
    'use strict';

    const rootFolder = '__root__';
    const uploadPath = '/api/local-assets';
    const canvasImageType = 'application/x-smart-canvas-image';
    const { assetBatch, folderRows } = root.XiaomeiShellKernel;
    const dropData = root.XiaomeiCanvasDropData;

    function nameDialog(doc, label) {
        const backdrop = doc.getElementById('assetDialogBackdrop');
        const title = doc.getElementById('assetDialogTitle');
        const input = doc.getElementById('assetDialogInput');
        const confirm = doc.getElementById('assetDialogOk');
        const cancel = doc.getElementById('assetDialogCancel');
        if (!backdrop || !title || !input || !confirm || !cancel) {
            return ({ cancelValue = '' } = {}) => Promise.resolve(cancelValue);
        }
        let current;

        function finish(accepted) {
            const dialog = current;
            if (!dialog) return;
            current = undefined;
            const focusWasInside = backdrop.contains(doc.activeElement);
            const value = accepted ? input.value.trim() : dialog.cancelValue;
            backdrop.hidden = true;
            backdrop.classList.remove('open');
            input.rows = 1;
            input.classList.remove('is-multiline');
            if (focusWasInside && dialog.opener?.isConnected) dialog.opener.focus({ preventScroll: true });
            dialog.resolve(value);
        }

        backdrop.addEventListener('pointerdown', event => event.stopPropagation());
        backdrop.addEventListener('mousedown', event => {
            event.stopPropagation();
            if (event.target === backdrop) finish(false);
        });
        backdrop.addEventListener('click', event => event.stopPropagation());
        backdrop.addEventListener('keydown', event => {
            if (!current || event.isComposing || event.keyCode === 229) return;
            const submit = event.key === 'Enter' && event.target === input
                && (!current.multiline || event.ctrlKey || event.metaKey);
            if (!submit && event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finish(submit);
        });
        confirm.addEventListener('click', () => finish(true));
        cancel.addEventListener('click', () => finish(false));

        return ({ title: caption, value = '', placeholder = '', cancelValue = '', multiline = false } = {}) => {
            finish(false);
            const opener = doc.activeElement;
            title.textContent = caption || label('smart.assetRename');
            input.value = value || '';
            input.placeholder = placeholder || '';
            input.rows = multiline ? 5 : 1;
            input.classList.toggle('is-multiline', Boolean(multiline));
            const result = new Promise(resolve => { current = { resolve, cancelValue, multiline, opener }; });
            backdrop.hidden = false;
            backdrop.classList.add('open');
            input.focus();
            input.select();
            return result;
        };
    }

    function create(host) {
        const doc = root.document;
        const panel = doc.getElementById('assetPanel');
        const dropZone = doc.getElementById('assetDropZone');
        const grid = doc.getElementById('assetGrid');
        const picker = doc.getElementById('assetCategorySelect');
        const addFolder = doc.getElementById('assetAddCategoryBtn');
        const renameFolder = doc.getElementById('assetRenameCategoryBtn');
        const hover = doc.getElementById('assetHoverPreview');
        const hoverImage = hover.querySelector('img');
        const hoverName = hover.querySelector('.asset-hover-name');
        let folderId = rootFolder;
        const listing = { items: [], tree: null };
        let version = 0;
        let latestApplied = 0;
        let pendingWrite = Promise.resolve();
        const deleting = new Set();
        const askName = nameDialog(doc, host.label);
        const sortButton = doc.getElementById('assetSortBtn');
        const sortLabel = doc.getElementById('assetSortLabel');
        const sortMenu = doc.getElementById('assetSortMenu');
        const SORT_STORAGE = 'xiaomei.smart.assetSort';
        const USAGE_STORAGE = 'xiaomei.smart.assetUsage';
        const sortFields = new Set(['name', 'modified', 'created', 'used', 'size']);
        const sortFieldKeys = {
            name: 'smart.assetSortName', modified: 'smart.assetSortModified',
            created: 'smart.assetSortCreated', used: 'smart.assetSortUsed', size: 'smart.assetSortSize',
        };
        let sort = readSort();
        let usage = readUsage();
        let hovered;
        let timer = 0;

        function folder(folders = folderRows(listing.tree, listing.items)) {
            return folders.find(item => item.id === folderId) || folders[0];
        }

        function readSort() {
            try {
                const saved = JSON.parse(root.localStorage.getItem(SORT_STORAGE) || 'null');
                if (saved && sortFields.has(saved.key) && (saved.order === 'asc' || saved.order === 'desc')) {
                    return { key: saved.key, order: saved.order };
                }
            } catch (_) {}
            return { key: 'modified', order: 'desc' };
        }

        function saveSort() {
            try { root.localStorage.setItem(SORT_STORAGE, JSON.stringify(sort)); } catch (_) {}
        }

        function usageKey(item) {
            return String(item?.file || item?.url || item?.id || '');
        }

        function readUsage() {
            try {
                const saved = JSON.parse(root.localStorage.getItem(USAGE_STORAGE) || 'null');
                return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
            } catch (_) { return {}; }
        }

        function markUsed(item) {
            const key = usageKey(item);
            if (!key) return;
            usage[key] = Date.now();
            // Keep the map small: usage only matters for recent sorting.
            usage = Object.fromEntries(Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 2000));
            try { root.localStorage.setItem(USAGE_STORAGE, JSON.stringify(usage)); } catch (_) {}
        }

        function sortValue(key, item) {
            if (key === 'name') return String(item?.name || '');
            if (key === 'created') return Number(item?.birth_at ?? item?.modified_at ?? item?.created_at ?? 0);
            if (key === 'used') return Number(usage[usageKey(item)] || 0);
            if (key === 'size') return Number(item?.size || 0);
            return Number(item?.modified_at ?? item?.created_at ?? 0);
        }

        function sortItems(items) {
            const direction = sort.order === 'asc' ? 1 : -1;
            return items.slice().sort((a, b) => {
                const left = sortValue(sort.key, a);
                const right = sortValue(sort.key, b);
                let result = sort.key === 'name'
                    ? String(left).localeCompare(String(right), 'zh-Hans-CN', {numeric:true, sensitivity:'base'})
                    : Number(left) - Number(right);
                if (!result) result = String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hans-CN', {numeric:true, sensitivity:'base'});
                return result * direction;
            });
        }

        function updateSortUi() {
            if (!sortButton || !sortMenu) return;
            const field = host.label(sortFieldKeys[sort.key] || sortFieldKeys.modified);
            const order = host.label(sort.order === 'asc' ? 'smart.assetSortAsc' : 'smart.assetSortDesc');
            if (sortLabel) sortLabel.textContent = field + (sort.order === 'asc' ? ' ↑' : ' ↓');
            sortButton.title = host.label('smart.assetSort') + '：' + field + ' · ' + order;
            sortMenu.querySelectorAll('[data-asset-sort]').forEach(button => {
                button.setAttribute('aria-checked', String(button.dataset.assetSort === sort.key));
            });
            sortMenu.querySelectorAll('[data-asset-sort-order]').forEach(button => {
                button.setAttribute('aria-checked', String(button.dataset.assetSortOrder === sort.order));
            });
        }

        function setSortMenu(open) {
            if (!sortButton || !sortMenu) return;
            sortMenu.hidden = !open;
            sortButton.setAttribute('aria-expanded', String(open));
            if (!open) return;
            const buttonBox = sortButton.getBoundingClientRect();
            const panelBox = panel.getBoundingClientRect();
            const top = Math.max(8, buttonBox.bottom - panelBox.top + 6);
            sortMenu.style.top = top + 'px';
            sortMenu.style.right = Math.max(8, panelBox.right - buttonBox.right) + 'px';
            // Keep the menu inside a short sidebar instead of letting overflow:hidden clip it.
            const overflow = sortMenu.getBoundingClientRect().bottom - (panelBox.bottom - 8);
            if (overflow > 0) sortMenu.style.top = Math.max(8, top - overflow) + 'px';
        }

        function closeSortMenu() {
            if (sortMenu && !sortMenu.hidden) setSortMenu(false);
        }

        function folderPath() {
            return folderId === rootFolder ? '' : folderId;
        }

        function applyListing(response, ticket = ++version) {
            if (ticket < latestApplied) return false;
            latestApplied = ticket;
            if (Array.isArray(response.items)) listing.items = response.items;
            if (response.tree) listing.tree = response.tree;
            return true;
        }

        async function request(path, fallback, method = 'GET', body) {
            const init = { method };
            if (body instanceof FormData) init.body = body;
            else if (body !== undefined) {
                init.headers = { 'Content-Type': 'application/json' };
                init.body = JSON.stringify(body);
            }
            const reply = await fetch(uploadPath + path, init);
            if (!reply.ok) throw new Error(await host.responseError(reply, fallback));
            return reply.json();
        }

        async function reload() {
            const ticket = ++version;
            const response = await request('', host.label('smart.assetLoadFail'));
            if (applyListing(response, ticket)) render();
        }

        function enqueue(write) {
            const result = pendingWrite.then(write);
            pendingWrite = result.catch(() => {});
            return result;
        }

        function rename(item, name) {
            const directory = folderPath();
            return enqueue(async () => {
                const path = item.file || item.id;
                const reply = await request('/items', '重命名失败', 'PATCH', { path, name });
                applyListing(reply);
                if (reply.old_path && reply.item?.url) host.relocated(item, reply.item, reply.old_path);
                render(folderPath() === directory ? reply.item?.folder || undefined : undefined);
                host.notify('已重命名本地素材，反推提示词和分类索引已同步');
            });
        }

        async function editFolder(renaming) {
            const path = folderPath();
            if (renaming && !path) return;
            const fallback = host.label('smart.assetFolder');
            const name = await askName({
                title: host.label(renaming ? 'smart.assetRenameFolder' : 'smart.assetNewFolder'),
                value: renaming ? folder()?.name || '' : fallback,
                placeholder: fallback,
            });
            if (!name) return;
            const body = renaming ? { path, name } : { parent: path, name };
            const failure = renaming ? '重命名文件夹失败' : '新建文件夹失败';
            try {
                await enqueue(async () => {
                    const reply = await request('/folders', failure, renaming ? 'PATCH' : 'POST', body);
                    applyListing(reply);
                    render(folderPath() === path ? reply.folder?.path : undefined);
                });
            } catch (error) {
                host.notify(error.message || failure);
            }
        }

        async function updateAfterImport(count) {
            // The write is already committed even if the sidebar refresh fails.
            try { await reload(); }
            catch (_) { host.notify(host.label('smart.assetLoadFail')); return; }
            host.notify(`已保存 ${count} 个本地素材`);
        }

        function upload(files, directory) {
            const supported = Array.from(files).filter(host.acceptFile);
            if (!supported.length) return Promise.resolve();
            const body = new FormData();
            body.append('folder', directory);
            for (const file of supported) body.append('files', file, file.name || 'media');
            return enqueue(async () => {
                const reply = await request('/upload', host.label('smart.assetAddFail'), 'POST', body);
                await updateAfterImport(reply.files?.length || 0);
            });
        }

        function importUrls(items, directory = folderPath()) {
            const sources = [];
            for (const item of items) {
                if (typeof item?.url === 'string' && item.url) {
                    sources.push({ url: item.url, name: item.name || host.nameFromUrl(item.url) });
                }
            }
            if (!sources.length) return Promise.resolve();
            return enqueue(async () => {
                const body = assetBatch('import', { folder: directory, items: sources });
                const reply = await request('/import-urls', host.label('smart.assetAddFail'), 'POST', body);
                const count = reply.count || 0;
                if (count === sources.length) {
                    await updateAfterImport(count);
                    return;
                }
                // Keep successfully imported items visible even when a sibling import failed.
                await reload().catch(() => {});
                const firstFailure = reply.items?.find(result => !result.ok)?.error;
                throw new Error(firstFailure || `仅保存了 ${count}/${sources.length} 个本地素材`);
            });
        }

        function discard(item) {
            latestApplied = ++version;
            const path = item.file || item.id;
            const retained = record => record.id !== item.id && record.file !== path;
            listing.items = listing.items.filter(retained);
            function prune(branch) {
                if (!branch) return 0;
                const before = branch.items || [];
                branch.items = before.filter(retained);
                const removed = (branch.children || []).reduce((total, child) => total + prune(child), before.length - branch.items.length);
                if (removed) branch.count = Math.max(0, (branch.count || 0) - removed);
                return removed;
            }
            prune(listing.tree);
        }

        async function remove(item, card) {
            if (deleting.has(item.id)) return;
            deleting.add(item.id);
            hideHover();
            card.remove();
            if (!grid.querySelector('.asset-item')) render();
            const path = item.file || item.id;
            try {
                await enqueue(async () => {
                    const reply = await request('/delete', '删除失败', 'POST', { names: [path] });
                    if (!reply.deleted?.includes(path)) throw new Error('未找到要移入回收站的本地素材');
                    discard(item);
                });
                host.notify('本地素材已移入回收站');
            } catch (error) {
                host.notify(error.message || '删除失败');
            } finally {
                deleting.delete(item.id);
                render();
            }
        }

        function setDropActive(active) {
            panel.classList.toggle('drag-over', active);
            dropZone.classList.toggle('drag-over', active);
            if (active) host.clearCanvasDrop();
        }

        function acceptsDrop(transfer) {
            return dropData.types(transfer).includes(canvasImageType) || host.hasDropData(transfer);
        }

        async function saveDrop(transfer, directory) {
            const image = dropData.read(transfer, canvasImageType);
            if (image) return importUrls([JSON.parse(image)], directory);
            const payload = await host.resolveDrop(transfer);
            if (payload.type === 'files') return upload(payload.files, directory);
            if (payload.type === 'localPaths') {
                return importUrls(await host.importPaths(payload.localPaths), directory);
            }
            if (payload.type === 'url') return importUrls([{ url: payload.url }], directory);
        }

        function hideHover() {
            clearTimeout(timer);
            hovered = undefined;
            hover.hidden = true;
            hover.style.display = 'none';
            hoverImage.removeAttribute('src');
        }

        function placeHover(x, y) {
            const width = hover.offsetWidth || 260;
            const height = hover.offsetHeight || 300;
            const preferred = x - width - 16;
            hover.style.left = Math.max(14, Math.min(root.innerWidth - width - 14, preferred < 14 ? x + 16 : preferred)) + 'px';
            hover.style.top = Math.max(14, Math.min(root.innerHeight - height - 14, y + 12)) + 'px';
        }

        function element(tag, className, text) {
            const el = doc.createElement(tag);
            el.className = className;
            if (text != null) el.textContent = text;
            return el;
        }

        function editName(card, item, label) {
            if (card.querySelector('.asset-rename-input')) return;
            hideHover();
            const input = element('input', 'asset-rename-input');
            input.type = 'text';
            input.value = label.textContent;
            input.setAttribute('aria-label', host.label('smart.assetRename'));
            const startingName = input.value;
            label.replaceWith(input);
            card.draggable = false;
            input.focus();
            input.select();
            let settled = false;

            async function finish(save) {
                if (settled) return;
                settled = true;
                const name = input.value.trim();
                try {
                    if (save && name && name !== startingName) {
                        input.disabled = true;
                        await rename(item, name);
                    }
                } catch (error) {
                    host.notify(error.message);
                } finally {
                    if (input.isConnected) input.replaceWith(label);
                    card.draggable = true;
                }
            }

            for (const event of ['click', 'mousedown', 'pointerdown']) {
                input.addEventListener(event, e => e.stopPropagation());
            }
            input.addEventListener('keydown', event => {
                event.stopPropagation();
                if (event.key !== 'Enter' && event.key !== 'Escape') return;
                event.preventDefault();
                finish(event.key === 'Enter');
            });
            input.addEventListener('blur', () => finish(true));
        }

        function action(attribute, name, title, item, invoke) {
            const button = element('button', 'asset-mini-btn');
            button.type = 'button';
            button.setAttribute(attribute, item.id || '');
            button.title = title;
            const icon = doc.createElement('i');
            icon.dataset.lucide = name;
            button.append(icon);
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                invoke();
            });
            return button;
        }

        function cardFor(item) {
            const card = element('div', 'asset-item');
            const name = item.name || 'asset';
            card.draggable = true;
            Object.assign(card.dataset, {
                assetId: item.id || '', url: item.url || '', name, kind: host.kind(item),
            });

            const template = doc.createElement('template');
            template.innerHTML = host.thumbnail(item);
            const thumb = template.content.querySelector('.asset-thumb');
            const label = element('span', 'asset-name', name);
            label.title = item.name || '';
            label.dataset.renameLocalAsset = item.id || '';
            const rename = () => editName(card, item, label);
            label.addEventListener('click', event => {
                event.stopPropagation();
                rename();
            });
            const meta = element('div', 'asset-meta');
            meta.append(label,
                action('data-rename-local-asset', 'pencil', host.label('smart.assetRename'), item, rename),
                action('data-delete-local-asset', 'trash-2', host.label('common.delete'), item, () => remove(item, card)));
            card.append(template.content, meta);

            thumb?.addEventListener('mouseenter', event => {
                if (!item.url) return;
                hideHover();
                hovered = { x: event.clientX, y: event.clientY };
                timer = setTimeout(() => {
                    if (!hovered || !card.isConnected) return;
                    hoverImage.src = host.preview(item);
                    hoverName.textContent = name;
                    hover.hidden = false;
                    hover.style.display = 'block';
                    placeHover(hovered.x, hovered.y);
                }, 160);
            });
            thumb?.addEventListener('mousemove', event => {
                if (!hovered) return;
                hovered.x = event.clientX;
                hovered.y = event.clientY;
                if (!hover.hidden) placeHover(hovered.x, hovered.y);
            });
            thumb?.addEventListener('mouseleave', hideHover);
            card.addEventListener('dragstart', event => {
                if (!item.url || !event.dataTransfer) return;
                markUsed(item);
                hideHover();
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('application/x-smart-asset', JSON.stringify(host.toReference(item)));
                event.dataTransfer.setData('text/plain', item.url);
            });
            return card;
        }

        function render(preferredFolder) {
            hideHover();
            closeSortMenu();
            if (preferredFolder !== undefined) folderId = preferredFolder || rootFolder;
            const folders = folderRows(listing.tree, listing.items);
            const active = folder(folders);
            folderId = active?.id || rootFolder;
            picker.replaceChildren(...folders.map(item => new Option(item.name || host.label('smart.assetFolder'), item.id)));
            picker.value = folderId;
            renameFolder.disabled = !active || folderId === rootFolder;
            const cards = sortItems(active?.items || []).filter(item => !deleting.has(item.id)).map(cardFor);
            grid.replaceChildren(...(cards.length ? cards : [element('div', 'asset-empty', '暂无本地素材，拖入图片即可保存')]));
            host.fallbacks(grid);
            host.icons();
            updateSortUi();
        }

        picker.addEventListener('change', () => render(picker.value));
        addFolder.addEventListener('click', () => editFolder(false));
        renameFolder.addEventListener('click', () => editFolder(true));
        sortButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (sortMenu) setSortMenu(sortMenu.hidden);
        });
        sortMenu?.addEventListener('click', event => {
            const fieldButton = event.target.closest('[data-asset-sort]');
            const orderButton = event.target.closest('[data-asset-sort-order]');
            if (!fieldButton && !orderButton) return;
            event.preventDefault();
            event.stopPropagation();
            if (fieldButton) sort = { ...sort, key: fieldButton.dataset.assetSort };
            if (orderButton) sort = { ...sort, order: orderButton.dataset.assetSortOrder };
            saveSort();
            render();
        });
        for (const name of ['pointerdown', 'mousedown', 'click']) {
            panel.addEventListener(name, event => event.stopPropagation());
        }
        panel.addEventListener('click', event => {
            if (!sortMenu || sortMenu.hidden) return;
            if (sortMenu.contains(event.target) || sortButton?.contains(event.target)) return;
            setSortMenu(false);
        });
        doc.addEventListener('click', event => {
            if (!sortMenu || sortMenu.hidden || panel.contains(event.target)) return;
            setSortMenu(false);
        });
        doc.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !sortMenu || sortMenu.hidden) return;
            setSortMenu(false);
            sortButton?.focus();
        });
        root.addEventListener('studio-lang-change', () => updateSortUi());
        panel.addEventListener('wheel', event => {
            event.stopPropagation();
            hideHover();
            closeSortMenu();
            if (root.getComputedStyle(grid).display === 'none') return;
            if (grid.scrollHeight <= grid.clientHeight && grid.scrollWidth <= grid.clientWidth) return;
            event.preventDefault();
            grid.scrollTop += event.deltaY;
            grid.scrollLeft += event.deltaX;
        }, { passive: false, capture: true });
        panel.addEventListener('dragover', event => {
            if (!acceptsDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            setDropActive(true);
        });
        panel.addEventListener('dragleave', event => {
            if (!panel.contains(event.relatedTarget)) setDropActive(false);
        });
        panel.addEventListener('drop', event => {
            if (!acceptsDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            setDropActive(false);
            saveDrop(event.dataTransfer, folderPath()).catch(error => host.notify(error.message));
        });
        return { render, reload, hideHover, askName, importUrls, setDropActive };
    }

    root.XiaomeiSmartLocalAssets = { create };
}(window));
