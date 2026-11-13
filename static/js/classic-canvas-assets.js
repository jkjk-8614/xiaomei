(function (root) {
    'use strict';

    const localId = '__local_assets__';
    const allowed = new Set(['image', 'media', 'workflow']);
    const categoryType = category => String(category?.type || 'image').toLowerCase();
    const kinds = new Set(['image', 'video', 'audio', 'text', 'file', 'workflow']);

    function create(host) {
        const doc = root.document;
        const get = name => doc.getElementById('canvasAsset' + name);
        const panel = get('Panel');
        const grid = get('Grid');
        const librarySelect = get('LibrarySelect');
        const categorySelect = get('CategorySelect');
        const add = get('AddCategoryBtn');
        const drop = get('DropZone');
        const toggleButton = get('Toggle');
        const hover = get('HoverPreview');
        const transfer = root.XiaomeiClassicMediaImport;
        const label = key => host.label('canvas.' + key);
        const isOpen = () => panel.classList.contains('open');
        let local = {};
        let loadSequence = 0;
        let writes = Promise.resolve();

        function kind(item) {
            const explicit = String(item?.kind || item?.mediaKind || '').toLowerCase();
            if (kinds.has(explicit)) return explicit;
            if (String(item?.type || '').toLowerCase() === 'workflow' || /\.(json|zip)(?:[?#]|$)/i.test(item?.url || item)) return 'workflow';
            const inferred = host.kind(item?.url || item);
            return inferred === 'audio' || inferred === 'video' ? inferred : 'image';
        }

        function libraries() {
            const source = host.library();
            return source.libraries?.length ? source.libraries
                : [{ id: 'default', name: label('assetDefaultLibrary'), categories: source.categories || [] }];
        }

        function localLibrary() {
            const rootFolder = local.tree || { id: '__root__', name: label('assetAllUploads') };
            const categories = [];
            const stack = [rootFolder];
            while (stack.length) {
                const folder = stack.pop();
                const id = folder.id || folder.path || '__root__';
                const items = (id === '__root__' ? local.items : folder.items) || [];
                categories.push({
                    id, type: 'image', name: folder.name || folder.path?.split('/').at(-1) || label('assetAllUploads'),
                    items: items.filter(item => kind(item) === 'image'), readonly: true, source: 'local',
                });
                stack.push(...(folder.children || []).slice().reverse());
            }
            return { id: localId, name: label('assetLocalLibrary'), categories, readonly: true, source: 'local' };
        }

        function activeLibrary() {
            if (host.libraryId() === localId) return localLibrary();
            const choices = libraries();
            return choices.find(lib => lib.id === host.libraryId()) || choices[0];
        }

        function categories() {
            return (activeLibrary().categories || []).filter(category => allowed.has(categoryType(category)));
        }

        function activeCategory() {
            const choices = categories();
            return choices.find(category => category.id === host.categoryId()) || choices[0];
        }

        function reconcile() {
            const choices = libraries();
            const wanted = host.libraryId();
            if (wanted !== localId && !choices.some(lib => lib.id === wanted)) {
                const suggested = host.library().active_library_id;
                host.setLibraryId(choices.find(lib => lib.id === suggested)?.id || choices[0].id);
            }
            host.setCategoryId(activeCategory()?.id || '');
        }

        function element(tag, cls, text) {
            const el = doc.createElement(tag);
            if (cls) el.className = cls;
            if (text != null) el.textContent = text;
            return el;
        }

        function icon(name, cls) {
            const el = element('i', cls);
            el.dataset.lucide = name;
            return el;
        }

        function preview(url, video, size, attrs) {
            const template = doc.createElement('template');
            template.innerHTML = host.thumbnail(url, video, size, attrs);
            return template.content;
        }

        function hideHover() {
            hover.hidden = true;
            hover.style.display = 'none';
            hover.replaceChildren();
        }

        function position(event) {
            if (hover.hidden) return;
            const w = hover.offsetWidth || 280;
            const h = hover.offsetHeight || 330;
            const left = event.clientX - w - 16;
            hover.style.left = Math.max(14, Math.min(root.innerWidth - w - 14, left >= 14 ? left : event.clientX + 16)) + 'px';
            hover.style.top = Math.max(14, Math.min(root.innerHeight - h - 14, event.clientY + 12)) + 'px';
        }

        function showHover(event, item, type) {
            if (!item.url || !['image', 'video'].includes(type)) return;
            const video = type === 'video';
            const media = preview(video ? item.url : item.thumbnail || item.url, video, 768, 'alt=""');
            hover.replaceChildren(media, element('div', 'canvas-asset-hover-name', item.name || 'asset'));
            host.fallbacks(hover);
            hover.hidden = false;
            hover.style.display = 'block';
            position(event);
        }

        function thumbnail(item, type) {
            const frame = element('div', 'canvas-asset-thumb-wrap');
            if (type === 'audio' || type === 'workflow') {
                frame.classList.add('canvas-asset-file-thumb');
                if (type === 'workflow') frame.classList.add('workflow-thumb');
                frame.append(icon(type === 'audio' ? 'file-audio' : 'workflow', 'w-6 h-6'), element('span', '', item.name || type));
                return frame;
            }
            const video = type === 'video';
            frame.append(preview(video ? item.url : item.thumbnail || item.url, video, 512, 'class="canvas-asset-thumb" alt=""'));
            if (video) {
                const badge = element('div', 'canvas-asset-video-badge');
                badge.append(icon('play'), element('span', '', 'VIDEO'));
                frame.append(badge);
            }
            return frame;
        }

        function button(name, title, remove, invoke) {
            const el = element('button', remove ? 'canvas-asset-action danger' : 'canvas-asset-action');
            el.type = 'button';
            el.title = title;
            el.setAttribute('aria-label', title);
            el.append(icon(name, 'w-4 h-4'));
            for (const event of ['pointerdown', 'dblclick']) el.addEventListener(event, e => e.stopPropagation());
            el.addEventListener('click', event => {
                event.stopPropagation();
                invoke();
            });
            return el;
        }

        function card(item, readOnly) {
            const type = kind(item);
            const el = element('div', 'canvas-asset-item');
            el.draggable = true;
            const value = { url: item.url, name: item.name || 'asset', kind: type };
            el.dataset.assetId = item.id || '';
            el.dataset.url = value.url || '';
            el.dataset.name = value.name;
            el.dataset.kind = type;
            const meta = element('div', 'canvas-asset-meta');
            const name = element('span', 'canvas-asset-name', value.name);
            name.title = item.name || '';
            meta.append(name);
            if (readOnly) meta.append(element('span', 'canvas-asset-local-tag', label('assetLocalTag')));
            else meta.append(
                button('pencil', label('rename'), false, () => rename(item)),
                button('trash-2', host.label('common.delete'), true, () => remove(item)),
            );
            el.append(thumbnail(item, type), meta);
            el.addEventListener('dragstart', event => {
                if (!event.dataTransfer || !value.url) return;
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData(transfer.assetType, JSON.stringify(value));
                event.dataTransfer.setData('text/plain', value.url);
            });
            el.addEventListener('dblclick', () => host.insert(value));
            el.addEventListener('mouseenter', event => showHover(event, item, type));
            el.addEventListener('mousemove', position);
            el.addEventListener('mouseleave', hideHover);
            return el;
        }

        function render() {
            reconcile();
            hideHover();
            librarySelect.replaceChildren(...libraries().concat(localLibrary()).map(lib => new Option(lib.name || label('assetLibraryName'), lib.id)));
            librarySelect.value = host.libraryId();
            const choices = categories();
            categorySelect.replaceChildren(...choices.map(category => new Option(
                (categoryType(category) === 'workflow' ? label('assetWorkflowPrefix') : '') + (category.name || label('assetDefaultCategory')),
                category.id,
            )));
            categorySelect.value = host.categoryId();
            const category = activeCategory();
            const readOnly = host.libraryId() === localId;
            add.disabled = readOnly;
            drop.style.display = readOnly ? 'none' : 'flex';
            drop.textContent = label(categoryType(category) === 'workflow' ? 'assetWorkflowDropHint' : 'assetMediaDropHint');
            const items = category?.items || [];
            grid.replaceChildren(...(items.length ? items.map(item => card(item, readOnly)) : [
                element('div', 'canvas-asset-empty', label(readOnly ? 'assetLocalEmpty' : 'assetCategoryEmpty')),
            ]));
            host.fallbacks(grid);
            host.icons();
        }

        async function api(url, method = 'GET', payload) {
            const request = { method };
            if (payload) {
                request.headers = { 'Content-Type': 'application/json' };
                request.body = JSON.stringify(payload);
            }
            const response = await root.fetch(url, request);
            if (!response.ok) throw new Error(await host.responseError(response, label('assetRequestFailed')));
            return response.json();
        }

        async function load() {
            const started = ++loadSequence;
            const baseline = host.library();
            try {
                const [data, localData] = await Promise.all([api('/api/asset-library'), api('/api/local-assets').catch(() => ({}))]);
                if (started !== loadSequence) return data;
                local = localData;
                if (baseline === host.library() && data.library) host.setLibrary(data.library);
                reconcile();
                render();
                return data;
            } catch (error) {
                if (started === loadSequence) host.status(error.message || label('assetRequestFailed'));
                return null;
            }
        }

        function write(work, done) {
            const operation = writes.then(work).then(result => {
                if (result?.library) host.setLibrary(result.library);
                if (done) done(result);
                render();
            });
            writes = operation.catch(error => host.error(error.message || label('assetRequestFailed'), label('assetRequestFailed')));
            return writes;
        }

        function rename(item) {
            const library_id = activeLibrary().id;
            const category_id = activeCategory()?.id;
            const name = root.prompt(label('assetItemName'), item.name || '')?.trim();
            if (name) write(() => api('/api/asset-library/items/' + encodeURIComponent(item.id), 'PATCH', {
                name, library_id, category_id, source_url: item.url,
            }));
        }

        function remove(item) {
            if (!root.confirm(label('assetConfirmDelete').replace('{name}', () => item.name || 'asset'))) return;
            write(() => api('/api/asset-library/items/' + encodeURIComponent(item.id), 'DELETE'));
        }

        async function uploadFiles(files, libraryId, categoryId) {
            const uploaded = await host.upload(files, Number.POSITIVE_INFINITY);
            const items = uploaded.map(file => ({ library_id: libraryId, category_id: categoryId, url: file.url, name: file.name || 'asset' }));
            if (!items.length) return null;
            return api('/api/asset-library/items/batch', 'POST', { library_id: libraryId, category_id: categoryId, items });
        }

        function toggle(open = !isOpen()) {
            if (open) host.beforeOpen();
            panel.classList.toggle('open', open);
            toggleButton.classList.toggle('active', open);
            if (open) load();
            else hideHover();
        }

        toggleButton.addEventListener('click', () => toggle());
        get('CloseBtn').addEventListener('click', () => toggle(false));
        librarySelect.addEventListener('change', () => {
            host.setLibraryId(librarySelect.value);
            host.setCategoryId('');
            render();
        });
        categorySelect.addEventListener('change', () => {
            host.setCategoryId(categorySelect.value);
            render();
        });
        add.addEventListener('click', () => {
            const libraryId = host.libraryId();
            if (libraryId === localId) return;
            const name = root.prompt(label('assetNewCategory'), label('assetNewCategoryName'))?.trim();
            if (!name) return;
            write(() => api('/api/asset-library/categories', 'POST', { library_id: libraryId, name, type: 'image' }), data => {
                if (data?.category?.id && host.libraryId() === libraryId) host.setCategoryId(data.category.id);
            });
        });
        panel.addEventListener('wheel', event => {
            event.stopPropagation();
            if (grid.scrollHeight <= grid.clientHeight && grid.scrollWidth <= grid.clientWidth) return;
            event.preventDefault();
            grid.scrollBy(event.deltaX, event.deltaY);
        }, { passive: false, capture: true });

        const supportsDrop = event => transfer.hasMedia(event.dataTransfer) || Boolean(transfer.data(event.dataTransfer, transfer.outputType))
            || Array.from(event.dataTransfer?.types || []).includes(transfer.outputType);
        drop.addEventListener('dragover', event => {
            if (!supportsDrop(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            drop.classList.add('drag-over');
        });
        drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
        drop.addEventListener('drop', event => {
            if (!supportsDrop(event)) return;
            event.preventDefault();
            event.stopPropagation();
            drop.classList.remove('drag-over');
            const category = activeCategory();
            const libraryId = host.libraryId();
            if (libraryId === localId) return;
            if (!category || categoryType(category) === 'workflow') {
                host.status(label(category ? 'assetWrongCategory' : 'assetNeedCategory'));
                return;
            }
            const output = transfer.data(event.dataTransfer, transfer.outputType);
            const pending = output ? Promise.resolve({ type: 'url', url: output, name: 'output' })
                : transfer.resolve(event.dataTransfer, Number.POSITIVE_INFINITY).catch(error => ({ error }));
            write(async () => {
                const payload = await pending;
                if (payload.error) throw payload.error;
                if (payload.type === 'files') return uploadFiles(payload.files, libraryId, category.id);
                if (payload.type === 'url') return api('/api/asset-library/items', 'POST',
                    root.XiaomeiShellKernel.assetBatch('save', { libraryId, categoryId: category.id, url: payload.url, name: payload.name || host.name(payload.url) }));
                return null;
            }, result => { if (result?.library) host.status(label('assetSaved')); });
        });

        return { libraries, render, toggle, isOpen };
    }

    root.XiaomeiClassicAssets = { create };
})(window);
