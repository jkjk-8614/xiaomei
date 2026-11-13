(function (root) {
    'use strict';

    const format = 'xiaomei-canvas-workflow';
    const idOf = value => value == null ? '' : String(value);
    const coordinates = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const isGroup = node => ['group', 'promptGroup'].includes(node.type);
    const isWorkflow = file => /\.(json|zip)$/i.test(file?.name || '');
    const validNode = node => node && typeof node.type === 'string' && node.type;
    const cleanFilename = value => String(value || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
    const safeName = (value, limit) => cleanFilename(value).slice(0, limit) || 'canvas-workflow';

    function rewriteTimeline(node, identify) {
        const clips = segments => {
            for (const clip of Array.isArray(segments) ? segments : []) {
                if (!clip?.canvasSourceId) continue;
                const mapped = identify(idOf(clip.canvasSourceId));
                if (mapped) clip.canvasSourceId = mapped;
                else delete clip.canvasSourceId;
            }
        };
        clips(node.ltxSegments);
        if (!node.ltxTimelineData) return;
        let timeline;
        try { timeline = JSON.parse(node.ltxTimelineData); } catch (_) { return; }
        if (!timeline || typeof timeline !== 'object') return;
        clips(timeline.segments);
        clips(timeline.audioSegments);
        node.ltxTimelineData = JSON.stringify(timeline);
    }

    function rewriteReferences(node, identify) {
        if (isGroup(node) && Array.isArray(node.items)) {
            node.items = [...new Set(node.items.map(id => identify(idOf(id))).filter(Boolean))].filter(id => id !== idOf(node.id));
        }
        if (node.type === 'ltxDirector') rewriteTimeline(node, identify);
    }

    function selectedGraph(nodes, edges, selection) {
        const indexed = new Map(nodes.map(node => [idOf(node.id), node]));
        const ids = new Set([...selection].map(idOf).filter(id => indexed.has(id)));
        for (const id of ids) {
            const node = indexed.get(id);
            if (!isGroup(node) || !Array.isArray(node.items)) continue;
            for (const key of node.items.map(idOf)) {
                if (indexed.has(key)) ids.add(key);
            }
        }
        return {
            ids, nodes: [...ids].map(id => indexed.get(id)),
            connections: edges.filter(edge => ids.has(idOf(edge.from)) && ids.has(idOf(edge.to))),
        };
    }

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const panel = get('workflowTransferModal');
        const toggle = get('workflowTransferToggle');
        const subtitle = get('workflowTransferSub');
        const meta = get('workflowExportMeta');
        const input = get('workflowImportInput');
        const drop = get('workflowImportDropZone');
        const save = get('workflowExportLibraryBtn');
        const caption = save.querySelector('span');
        let phase = 'idle';
        let settleTimer;
        const label = key => host.label('canvas.' + key);
        const text = (key, values) => label(key).replace(/\{(\w+)\}/g, (token, name) => String(values[name] ?? token));
        const isOpen = () => panel.classList.contains('open');

        function graph() {
            return selectedGraph(host.nodes(), host.edges(), host.selected());
        }

        function portable(node) {
            const copy = JSON.parse(JSON.stringify(host.transferable(node)));
            if (Array.isArray(copy._pending)) copy._pending = [];
            delete copy._naturalSizeLoading;
            return copy;
        }

        function payload() {
            const { nodes, connections, ids } = graph();
            const identify = id => ids.has(id) ? id : '';
            const copies = nodes.map(portable);
            for (const node of copies) rewriteReferences(node, identify);
            return { format, version: 1, exported_at: Date.now(), nodes: copies, connections: connections.map(edge => ({ ...edge })) };
        }

        function refresh() {
            if (!isOpen() || phase !== 'idle') return;
            const { nodes, connections } = graph();
            meta.textContent = nodes.length
                ? text('workflowSelection', { nodes: nodes.length, edges: connections.length }) : label('workflowNoSelection');
            subtitle.textContent = label(nodes.length ? 'workflowSelectedHint' : 'workflowSelectHint');
        }

        function open() {
            if (!host.canvas()) {
                host.status(label('needCanvas'));
                return;
            }
            host.beforeOpen();
            panel.classList.add('open');
            toggle.classList.add('active');
            refresh();
            host.icons();
        }

        function close() {
            panel.classList.remove('open');
            toggle.classList.remove('active');
            drop.classList.remove('drag-over');
        }

        function setPhase(next, name = '') {
            phase = next;
            save.disabled = next === 'choosing' || next === 'busy';
            save.classList.toggle('busy', next === 'busy');
            save.classList.toggle('success', next === 'success');
            meta.classList.toggle('busy', next === 'busy');
            meta.classList.toggle('success', next === 'success');
            const status = doc.createElement('i');
            status.className = 'w-4 h-4';
            status.dataset.lucide = next === 'busy' ? 'loader-2' : next === 'success' ? 'check' : 'library-big';
            save.replaceChildren(status, caption);
            caption.textContent = label(next === 'busy' ? 'workflowSaving' : next === 'success' ? 'workflowSavedButton' : 'workflowSaveLibrary');
            if (next === 'busy') {
                meta.textContent = label('workflowSavingHint');
                subtitle.textContent = label('workflowSavingSub');
            } else if (next === 'success') {
                meta.textContent = text('workflowSavedLibrary', { name });
                subtitle.textContent = label('workflowSavedHint');
            } else if (next === 'idle') refresh();
            host.icons();
        }

        function requireSelection() {
            const data = payload();
            if (data.nodes.length) return data;
            refresh();
            host.status(label('workflowNoSelection'));
            return null;
        }

        function exportName(canvas, ext) {
            const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
            return safeName(canvas.title, 48) + '-' + stamp + '.' + ext;
        }

        function download(blob, filename) {
            const url = root.URL.createObjectURL(blob);
            const link = doc.createElement('a');
            link.href = url;
            link.download = filename;
            doc.body.append(link);
            link.click();
            link.remove();
            root.setTimeout(() => root.URL.revokeObjectURL(url), 1200);
        }

        async function post(path, body, errorKey) {
            const json = !(body instanceof FormData);
            const response = await root.fetch(path, json ? {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            } : { method: 'POST', body });
            if (!response.ok) throw new Error(await host.responseError(response, label(errorKey)));
            return response;
        }

        async function exportFile(ext) {
            const canvas = host.canvas();
            if (!canvas) return;
            const data = requireSelection();
            if (!data) return;
            const filename = exportName(canvas, ext);
            try {
                const include = ext === 'zip';
                const blob = include
                    ? await (await post('/api/canvas-workflows/export', { ...data, filename, include_resources: true }, 'workflowExportFailed')).blob()
                    : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                download(blob, filename);
                host.status(label(include ? 'workflowExportedZip' : 'workflowExportedJson'));
            } catch (error) {
                host.error(error.message || label('workflowExportFailed'), label('workflowExport'));
            }
        }

        function defaultLibrary() {
            const libraries = host.libraries();
            const active = libraries.find(library => library.id === host.libraryId());
            const preferred = [active, ...libraries].filter(Boolean);
            for (const library of preferred) {
                const category = (library.categories || []).find(item => String(item.type).toLowerCase() === 'workflow');
                if (category) return { libraryId: library.id, categoryId: category.id };
            }
            return { libraryId: preferred[0]?.id || '', categoryId: '' };
        }

        async function exportLibrary() {
            const canvas = host.canvas();
            if (!canvas || save.disabled) return;
            const data = requireSelection();
            if (!data) return;
            root.clearTimeout(settleTimer);
            setPhase('choosing');
            try {
                const choice = await root.XiaomeiWorkflowSaveDialog.open({
                    ...defaultLibrary(), name: exportName(canvas, 'zip').slice(0, -4),
                    workflow: data, nodeCount: data.nodes.length, connectionCount: data.connections.length, includeResources: true,
                });
                if (host.canvas() !== canvas) {
                    setPhase('idle');
                    return;
                }
                setPhase('busy');
                host.status(label('workflowSavingHint'));
                const response = await post('/api/canvas-workflows/export-to-library', {
                    ...data, name: choice.name, description: choice.description || '', filename: safeName(choice.name, 80) + '.zip',
                    include_resources: choice.includeResources, library_id: choice.libraryId, category_id: choice.categoryId,
                }, 'workflowLibraryFailed');
                const saved = await response.json();
                host.librarySaved(saved.library, choice.libraryId, choice.categoryId);
                const name = saved.item?.name || choice.name;
                setPhase('success', name);
                host.status(text('workflowSavedLibrary', { name }));
                settleTimer = root.setTimeout(() => setPhase('idle'), 1800);
            } catch (error) {
                setPhase('idle');
                if (error.message !== '已取消收藏') host.error(error.message || label('workflowLibraryFailed'), label('workflowSaveLibrary'));
            }
        }

        function prepare(result, at) {
            const data = Array.isArray(result?.nodes) ? result : result?.workflow;
            const original = Array.isArray(data?.nodes) ? data.nodes.filter(validNode) : [];
            if (!original.length) throw new Error(label('workflowNoNodes'));
            const min = original.reduce((point, node) => ({
                x: Math.min(point.x, coordinates(node.x)), y: Math.min(point.y, coordinates(node.y)),
            }), { x: Infinity, y: Infinity });
            const ids = new Map();
            const nodes = original.map(node => {
                const oldId = idOf(node.id);
                if (oldId && ids.has(oldId)) throw new Error(label('workflowDuplicateNodes'));
                const copy = portable(node);
                copy.id = host.id(copy.type);
                if (oldId) ids.set(oldId, copy.id);
                copy.x = at.x + coordinates(node.x) - min.x;
                copy.y = at.y + coordinates(node.y) - min.y;
                return copy;
            });
            for (const node of nodes) rewriteReferences(node, id => ids.get(id));
            const edges = Array.isArray(data.connections) ? data.connections.filter(edge => edge && typeof edge === 'object') : [];
            return {
                nodes,
                connections: root.XiaomeiHistoryKernel.remapEdges(edges, Object.fromEntries(ids), { newId: () => host.id('c') }),
            };
        }

        async function loadFile(file, canvas, at) {
            const form = new FormData();
            form.append('file', file);
            const response = await post('/api/canvas-workflows/import', form, 'workflowImportFailed');
            const data = await response.json();
            if (host.canvas() !== canvas) return;
            const bundle = prepare(data, at);
            host.insert(bundle);
            close();
            host.status(text('workflowImported', { nodes: bundle.nodes.length }));
        }

        async function importFile(file, at = host.point()) {
            const canvas = host.canvas();
            if (!canvas || !file) return;
            try { await loadFile(file, canvas, at); }
            catch (error) { host.error(error.message || label('workflowImportFailed'), label('workflowImport')); }
        }

        async function importAsset(url, name, at = host.point()) {
            const canvas = host.canvas();
            if (!canvas || !url) return;
            try {
                const response = await root.fetch(url, { cache: 'no-store' });
                if (!response.ok) throw new Error(await host.responseError(response, label('workflowReadFailed')));
                const blob = await response.blob();
                if (host.canvas() !== canvas) return;
                const fallback = String(url).split(/[?#]/, 1)[0].split('/').at(-1);
                const filename = isWorkflow({ name }) ? name : fallback || safeName(name, 80) + '.zip';
                await loadFile(new File([blob], filename, { type: blob.type || 'application/octet-stream' }), canvas, at);
            } catch (error) { host.error(error.message || label('workflowImportFailed'), label('workflowImport')); }
        }

        toggle.addEventListener('click', () => isOpen() ? close() : open());
        get('workflowTransferClose').addEventListener('click', close);
        panel.querySelector('[data-workflow-export="json"]').addEventListener('click', () => exportFile('json'));
        panel.querySelector('[data-workflow-export="zip"]').addEventListener('click', () => exportFile('zip'));
        save.addEventListener('click', exportLibrary);
        input.addEventListener('change', () => {
            importFile(input.files?.[0]);
            input.value = '';
        });
        drop.addEventListener('click', () => input.click());
        panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true, capture: true });
        panel.addEventListener('dragover', event => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            drop.classList.add('drag-over');
        });
        panel.addEventListener('dragleave', event => {
            if (!panel.contains(event.relatedTarget)) drop.classList.remove('drag-over');
        });
        panel.addEventListener('drop', event => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.remove('drag-over');
            const file = Array.from(event.dataTransfer.files || []).find(isWorkflow);
            if (file) importFile(file);
            else host.status(label('workflowChooseFile'));
        });

        return { close, refresh, isOpen, importAsset };
    }

    root.XiaomeiClassicWorkflowTransfer = { create, selectedGraph, rewriteReferences };
})(window);
