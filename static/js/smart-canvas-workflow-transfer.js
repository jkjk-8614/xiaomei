(function (root) {
    'use strict';

    const format = 'xiaomei-canvas-workflow';
    const idOf = value => value == null ? '' : String(value);
    const coordinate = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const validNode = node => typeof node?.type === 'string' && node.type.trim();
    const workflowFile = file => /\.(json|zip)$/i.test(file?.name || '');
    const group = node => node.type === 'smart-group' || node.type === 'group' || node.type === 'promptGroup';
    const clone = value => JSON.parse(JSON.stringify(value));

    function withSnapshots(nodes) {
        const all = [...nodes];
        for (const node of all) {
            if (Array.isArray(node.collapsedNodes)) all.push(...node.collapsedNodes.filter(validNode));
        }
        return all;
    }

    function groupOrigins(node) {
        return group(node) && Array.isArray(node.images)
            ? node.images.map(image => idOf(image?._smartGroupOriginNodeId)).filter(Boolean) : [];
    }

    function matchingEdges(edges, ids) {
        return edges.filter(edge => ids.has(idOf(edge?.from)) && ids.has(idOf(edge?.to)));
    }

    function selectedGraph({ nodes, connections, selected }) {
        const indexed = new Map(nodes.map(node => [idOf(node.id), node]));
        const ids = new Set(selected.map(idOf).filter(id => indexed.has(id)));
        for (const id of ids) {
            for (const node of withSnapshots([indexed.get(id)])) {
                if (!group(node) || !Array.isArray(node.items)) continue;
                for (const member of node.items.map(idOf)) if (indexed.has(member)) ids.add(member);
            }
        }
        return {
            nodes: nodes.filter(node => ids.has(idOf(node.id))),
            connections: matchingEdges(connections, ids)
        };
    }

    function rewriteReferences(node, identify, rewriteEdges, resources = {}) {
        const list = values => [...new Set(values.map(identify).filter(Boolean))];
        const keys = ['inputNodeIds', 'batchPaintNodeIds', 'detailStitchSourceNodeIds', 'retouchOutputIds'];
        if (group(node)) keys.push('items');
        for (const field of keys) {
            if (Array.isArray(node[field])) node[field] = list(node[field]).filter(id => id !== node.id);
        }
        for (const field of ['sourceNodeId', 'detachedFromNodeId', 'batchGuideNodeId', 'batchResultOwnerId',
            'batchDetailOwnerId', 'detailStitchOwnerId', 'retouchOwnerId']) {
            if (node[field]) node[field] = identify(node[field]) || '';
        }
        if (node.batchSourceNodeId && node.batchSourceNodeId !== 'local') {
            node.batchSourceNodeId = identify(node.batchSourceNodeId) || 'local';
        }
        for (const field of ['inputRefOrder', 'blockedInputRefs']) {
            if (!Array.isArray(node[field])) continue;
            node[field] = node[field].flatMap(key => {
                const text = String(key || '');
                const separator = text.indexOf('|');
                if (text.startsWith('url|')) {
                    const url = text.slice(4);
                    return ['url|' + (Object.hasOwn(resources, url) ? resources[url] : url)];
                }
                if (separator < 0 || text.startsWith('ref|')) return text ? [text] : [];
                const id = identify(text.slice(0, separator));
                return id ? [id + text.slice(separator)] : [];
            });
        }
        for (const field of ['runInputRefs', 'runPromptRefs', 'manualInputRefs']) {
            if (!Array.isArray(node[field])) continue;
            for (const reference of node[field]) {
                if (reference?.nodeId) reference.nodeId = identify(reference.nodeId) || '';
            }
        }
        if (group(node) && Array.isArray(node.images)) {
            for (const image of node.images) {
                if (image?._smartGroupOriginNodeId) image._smartGroupOriginNodeId = identify(image._smartGroupOriginNodeId);
            }
        }
        for (const field of ['collapsedConnections', '_smartGroupOriginConnections']) {
            if (Array.isArray(node[field])) node[field] = rewriteEdges(node[field].filter(Boolean));
        }
    }

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const panel = get('smartWorkflowTransferModal');
        const toggle = get('smartWorkflowToggle');
        const subtitle = get('smartWorkflowTransferSub');
        const meta = get('smartWorkflowExportMeta');
        const saveButton = get('smartWorkflowSaveTemplateBtn');
        const input = get('smartWorkflowImportInput');
        const drop = get('smartWorkflowImportDropZone');
        const caption = saveButton.querySelector('span');
        const selectionHint = '未选择节点，请先选中要导出的组件';
        const importError = '导入工作流失败';
        let phase = 'idle';
        let importing = false;
        let settleTimer;

        const isOpen = () => panel.classList.contains('open');
        const canvasTitle = () => String(host.canvas()?.title || get('smartTitle')?.textContent || '').trim();

        function payload(graph, template) {
            const nodes = graph.nodes.map(node => host.serialize(node, template));
            const snapshots = withSnapshots(nodes);
            const ids = new Set(snapshots.flatMap(node => [idOf(node.id), ...groupOrigins(node)]).filter(Boolean));
            for (const node of snapshots) rewriteReferences(node, id => ids.has(idOf(id)) ? idOf(id) : '', edges => matchingEdges(edges, ids));
            return { format, version: 1, canvas_type: 'smart', exported_at: Date.now(), nodes, connections: clone(graph.connections) };
        }

        function prepare(imported, point) {
            const source = Array.isArray(imported) ? { nodes: imported }
                : Array.isArray(imported?.nodes) ? imported : imported?.workflow;
            const original = Array.isArray(source?.nodes) ? source.nodes.filter(validNode) : [];
            if (!original.length) throw new Error('工作流中没有可导入的节点');
            const nodes = original.map(node => host.serialize(node, false));
            const snapshots = withSnapshots(nodes);
            const rootIds = new Map();
            const ids = new Map();
            const minimum = original.reduce((result, node) => ({
                x: Math.min(result.x, coordinate(node.x)),
                y: Math.min(result.y, coordinate(node.y))
            }), { x: Infinity, y: Infinity });
            const dx = point.x - minimum.x;
            const dy = point.y - minimum.y;
            for (const [index, node] of snapshots.entries()) {
                const previous = idOf(node.id);
                if (previous && ids.has(previous)) throw new Error('工作流包含重复节点 ID');
                node.id = host.id(node.type);
                if (previous) {
                    ids.set(previous, node.id);
                    if (index < nodes.length) rootIds.set(previous, node.id);
                }
                node.x = coordinate(node.x) + dx;
                node.y = coordinate(node.y) + dy;
                node.created_at ||= Date.now();
            }
            for (const node of snapshots) {
                for (const id of groupOrigins(node)) if (!ids.has(id)) ids.set(id, host.id('origin'));
            }
            const table = Object.fromEntries(ids);
            const options = { newId: () => host.id('c') };
            const remapEdges = (edges, lookup) => root.XiaomeiHistoryKernel.remapEdges(edges, lookup, options);
            const resources = imported?.resource_map || {};
            for (const node of snapshots) rewriteReferences(node, id => ids.get(idOf(id)), edges => remapEdges(edges, table), resources);
            const edges = Array.isArray(source.connections) ? source.connections.filter(edge => edge?.from && edge?.to) : [];
            return { nodes, connections: remapEdges(edges, Object.fromEntries(rootIds)) };
        }

        function refresh() {
            if (!isOpen()) return;
            saveButton.hidden = !host.editable();
            subtitle.textContent = importing ? '正在导入工作流...' : '从收藏模板快速添加，或导入 JSON / ZIP';
            if (phase !== 'idle') return;
            const graph = selectedGraph(host.graph());
            const count = graph.nodes.length;
            meta.textContent = count ? `已选择 ${count} 个节点，${graph.connections.length} 条连线` : selectionHint;
        }

        function open() {
            if (!host.canvas()) return host.status('请先打开画布');
            host.beforeOpen();
            panel.classList.add('open');
            toggle.classList.add('active');
            refresh();
            host.onOpen();
        }

        function close() {
            panel.classList.remove('open');
            toggle.classList.remove('active');
            drop.classList.remove('drag-over');
        }

        function setPhase(next, message = '') {
            root.clearTimeout(settleTimer);
            phase = next;
            const saving = next === 'saving';
            const saved = next === 'saved';
            const busy = saving || next === 'packing';
            const success = saved || next === 'packed';
            saveButton.disabled = busy || next === 'choosing';
            saveButton.classList.toggle('busy', saving);
            saveButton.classList.toggle('success', saved);
            meta.classList.toggle('busy', busy);
            meta.classList.toggle('success', success);
            const icon = doc.createElement('i');
            icon.dataset.lucide = saving ? 'loader-2' : saved ? 'check' : 'bookmark-plus';
            caption.textContent = saving ? '收藏中...' : saved ? '已收藏' : '收藏模板';
            saveButton.replaceChildren(icon, caption);
            if (message) meta.textContent = message;
            refresh();
            host.icons();
        }

        function succeeded(next, message, delay) {
            setPhase(next, message);
            settleTimer = root.setTimeout(() => setPhase('idle'), delay);
        }

        function canExport() {
            return Boolean(host.canvas()) && ['idle', 'saved', 'packed'].includes(phase);
        }

        function requireSelection(template = false) {
            const graph = selectedGraph(host.graph());
            if (graph.nodes.length) return payload(graph, template);
            refresh();
            host.status(template ? '未选择节点，请先选中要收藏的组件' : selectionHint);
            return null;
        }

        async function post(action, body, fallback) {
            const form = body instanceof FormData;
            const response = await root.fetch('/api/canvas-workflows/' + action, {
                method: 'POST', body: form ? body : JSON.stringify(body),
                ...(form ? {} : { headers: { 'Content-Type': 'application/json' } })
            });
            if (!response.ok) throw new Error(await host.responseError(response, fallback));
            return response;
        }

        function download(blob, filename) {
            const link = doc.createElement('a');
            const url = root.URL.createObjectURL(blob);
            link.href = url;
            link.download = filename;
            doc.body.append(link);
            link.click();
            link.remove();
            root.setTimeout(() => root.URL.revokeObjectURL(url), 800);
        }

        async function exportFile(includeResources) {
            if (!canExport()) return;
            const fallback = '导出工作流失败';
            try {
                const data = requireSelection();
                if (!data) return;
                const name = canvasTitle().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-').slice(0, 48) || 'smart-canvas';
                const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
                const base = name + '-workflow-' + stamp;
                if (!includeResources) {
                    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), base + '.json');
                    host.status('已导出智能画布工作流 JSON');
                    return;
                }
                setPhase('packing', '正在打包资源...');
                const filename = base + '.zip';
                const response = await post('export', { ...data, include_resources: true, filename }, fallback);
                download(await response.blob(), filename);
                succeeded('packed', `已导出 ${data.nodes.length} 个节点，包含可找到的本地资源`, 1600);
                host.status('已导出包含资源的智能画布工作流包');
            } catch (error) {
                setPhase('idle');
                host.status(error.message || fallback);
            }
        }

        async function saveTemplate() {
            if (!canExport()) return;
            if (!host.editable()) return host.status('当前画布为只读，无法收藏模板');
            const owner = host.canvas().id;
            let fallback = '无法打开收藏设置';
            try {
                const data = requireSelection(true);
                if (!data) return;
                const target = host.libraryTarget();
                if (!target.libraryId) return host.status('暂无可用的收藏库');
                const name = canvasTitle().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '小美画布';
                setPhase('choosing');
                const choice = await root.XiaomeiWorkflowSaveDialog.open({
                    ...target, name: name + '模板', workflow: data, nodeCount: data.nodes.length,
                    connectionCount: data.connections.length, includeResources: true,
                    resourceCount: root.XiaomeiWorkflowPreview?.resourceCount?.(data) || 0
                });
                if (!choice || host.canvas()?.id !== owner || !host.editable()) {
                    setPhase('idle');
                    return;
                }
                fallback = '收藏工作流模板失败';
                setPhase('saving', '正在保存模板...');
                const filename = (choice.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'xiaomei-template') + '.zip';
                const response = await post('export-to-library', {
                    ...data, include_resources: choice.includeResources, filename, name: choice.name,
                    description: choice.description || '', library_id: choice.libraryId, category_id: choice.categoryId
                }, fallback);
                const result = await response.json();
                host.librarySaved(result);
                const saved = result.item?.name || choice.name;
                succeeded('saved', '已收藏模板：' + saved, 1800);
                host.status('已收藏工作流模板：' + saved);
            } catch (error) {
                setPhase('idle');
                if (error.message !== '已取消收藏') host.status(error.message || fallback);
            }
        }

        async function importSource(file, asset) {
            const owner = host.canvas()?.id;
            if (!owner || importing || (!file && !asset?.url) || !host.allowImport()) return false;
            const point = host.point();
            importing = true;
            refresh();
            try {
                if (asset) {
                    const response = await root.fetch(asset.url);
                    if (!response.ok) throw new Error('工作流文件读取失败');
                    const blob = await response.blob();
                    const original = String(asset.name || 'workflow');
                    const json = asset.format === 'json' || /\.json(?:[?#]|$)/i.test(asset.url) || /\.json$/i.test(original);
                    const suffix = json ? '.json' : '.zip';
                    file = new File([blob], original.replace(/\.(json|zip)$/i, '') + suffix, {
                        type: blob.type || (json ? 'application/json' : 'application/zip')
                    });
                }
                if (host.canvas()?.id !== owner || !host.allowImport()) return false;
                const form = new FormData();
                form.append('file', file);
                const response = await post('import', form, importError);
                const result = await response.json();
                if (host.canvas()?.id !== owner || !host.allowImport()) return false;
                const bundle = prepare(result, point);
                host.insert(bundle);
                close();
                host.status(`已添加到画布：${bundle.nodes.length} 个节点`);
                return true;
            } catch (error) {
                if (host.canvas()?.id === owner) host.status(error.message || importError);
                return false;
            } finally {
                importing = false;
                refresh();
            }
        }

        toggle.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (isOpen()) close();
            else open();
        });
        panel.addEventListener('click', event => {
            event.stopPropagation();
            const target = event.target.closest('button');
            if (!target) return;
            if (target.matches('[data-smart-workflow-close]')) close();
            else if (target === saveButton) void saveTemplate();
            else if (target.dataset.smartWorkflowExport) void exportFile(target.dataset.smartWorkflowExport === 'zip');
        });
        for (const type of ['pointerdown', 'mousedown', 'wheel']) panel.addEventListener(type, event => event.stopPropagation());
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.value = '';
            if (file) void importSource(file);
        });
        drop.addEventListener('click', () => input.click());
        for (const type of ['dragenter', 'dragover']) panel.addEventListener(type, event => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            drop.classList.add('drag-over');
        });
        panel.addEventListener('dragleave', event => {
            if (!panel.contains(event.relatedTarget)) drop.classList.remove('drag-over');
        });
        panel.addEventListener('drop', event => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.remove('drag-over');
            const file = Array.from(event.dataTransfer?.files || []).find(workflowFile);
            if (file) void importSource(file);
            else host.status('请拖入 JSON 或 ZIP 工作流文件');
        });

        return { isOpen, close, refresh, importAsset: asset => importSource(null, asset) };
    }

    root.XiaomeiSmartWorkflowTransfer = { create };
})(window);
