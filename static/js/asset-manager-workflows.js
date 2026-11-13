(function (global) {
    'use strict';

    const inboxKey = 'smart_canvas_workflow_inbox_v1';
    const accepted = new Set(['application/json', 'application/zip', 'application/x-zip-compressed']);
    const format = item => String(item.format || '').toLowerCase() === 'json' || /\.json(?:[?#]|$)/i.test(item.url) ? 'json' : 'zip';
    const label = item => format(item) === 'json' ? 'JSON 工作流' : 'ZIP 工作流包';
    const keyOf = (scope, item) => JSON.stringify([scope.libraryId, scope.categoryId, item.id, item.url]);
    const sourceOf = (scope, item) => ({category_id:scope.categoryId, id:item.id, url:item.url});
    const locationOf = (scope, item) => ({library_id:scope.libraryId, category_id:scope.categoryId, source_url:item.url});
    const json = (method, body) => ({method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});

    function groups(libraries) {
        return libraries.flatMap(library => (library.categories || [])
            .filter(category => category.type === 'workflow')
            .map(category => ({...category, __libraryId:library.id, __libraryName:library.name || '资产库'})));
    }
    function groupFor(categories, {libraryId, categoryId}) {
        return categories.find(group => group.__libraryId === libraryId && group.id === categoryId)
            || categories.find(group => group.__libraryId === libraryId) || categories[0];
    }
    function matching(category, query) {
        const needle = query.trim().toLowerCase();
        return (category?.items || []).filter(item => [item.name, item.url, label(item)].join(' ').toLowerCase().includes(needle));
    }
    function desktopBridge() {
        for (const frame of [global, global.parent, global.top]) {
            try {
                if (frame?.electronAPI) return frame.electronAPI;
            } catch (_) { /* A parent frame may use a different origin. */ }
        }
        return null;
    }
    function create({request, media, download, notice, redraw, scope, visible, categories, apply, select, remove, date}) {
        const document = global.document.createElement('template').content.ownerDocument;
        const svgNamespace = 'http://www.w3.org/2000/svg';
        const previews = new WeakSet();
        const inspected = new Map();
        const renames = new Map();
        let confirmation = '';

        function element(tag, classes, text) {
            const node = document.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        }
        function icon(glyph) {
            const node = element('i');
            node.dataset.lucide = glyph;
            return node;
        }
        function button(hook, id, classes, glyph, {title, caption, aria, disabled = false} = {}) {
            const node = element('button', classes);
            node.type = 'button';
            node.setAttribute('data-workflow-' + hook, id);
            node.disabled = disabled;
            if (title) node.title = title;
            if (aria) node.setAttribute('aria-label', aria);
            node.append(icon(glyph));
            if (caption) node.append(element('span', '', caption));
            return node;
        }
        function preview(item, large) {
            const content = element('template');
            if (item.preview_graph && global.XiaomeiWorkflowPreview?.markup) {
                content.innerHTML = global.XiaomeiWorkflowPreview.markup(item, {name:item.name || '工作流', large});
                return content.content;
            }
            const pane = element('div', 'workflow-preview');
            const diagram = document.createElementNS(svgNamespace, 'svg');
            diagram.setAttribute('viewBox', '0 0 140 82');
            diagram.setAttribute('aria-hidden', 'true');
            const count = Math.max(0, Number(item.node_count || item.nodes_count || 0));
            const positions = Array.from({length:Math.min(count || 3, 6)}, (_, i) => [12 + i % 3 * 42, i < 3 ? 18 : 56]);
            function shape(tag, fields) {
                const node = document.createElementNS(svgNamespace, tag);
                for (const [key, value] of Object.entries(fields)) node.setAttribute(key, value);
                diagram.append(node);
            }
            for (let i = 1; i < positions.length; i++) {
                const [x, y] = positions[i - 1];
                const nextX = positions[i][0] + 42;
                const nextY = positions[i][1];
                shape('path', {class:'workflow-preview-link',
                    d:'M' + (x + 28) + ' ' + (y + 9) + ' C' + (x + 38) + ' ' + (y + 9) + ', '
                        + (nextX - 10) + ' ' + (nextY + 9) + ', ' + nextX + ' ' + (nextY + 9)});
            }
            for (const [x, y] of positions) shape('rect', {x, y, width:28, height:18, rx:4, class:'workflow-preview-node'});
            pane.append(diagram, element('span', '', count ? count + ' 个节点' : label(item)));
            return pane;
        }
        function card(item, current, selected) {
            const node = element('article', 'asset-card workflow-card' + (item.id === current ? ' active' : ''));
            node.draggable = true;
            node.dataset.workflowCard = node.dataset.workflowDrag = item.id;
            const checkbox = element('input', 'asset-card-check');
            checkbox.type = 'checkbox';
            checkbox.dataset.workflowCheck = item.id;
            checkbox.defaultChecked = selected.has(item.id);
            const thumb = element('div', 'asset-thumb');
            thumb.append(preview(item, false));
            const favorite = item.favorite ? '取消收藏' : '收藏';
            const body = element('div', 'asset-card-body');
            const name = element('div', 'asset-card-name', item.name || 'workflow');
            name.title = item.name || '';
            const badges = [label(item)];
            if (item.node_count) badges.push(Number(item.node_count) + ' 节点');
            if (item.connection_count) badges.push(Number(item.connection_count) + ' 连线');
            body.append(name, element('div', 'asset-card-meta', badges.join(' · ')),
                element('div', 'asset-card-meta', date(item.created_at)));
            node.append(checkbox, thumb, button('favorite', item.id, 'asset-card-quick asset-card-fav' + (item.favorite ? ' is-fav' : ''),
                'star', {title:favorite, aria:favorite}), body);
            return node.outerHTML;
        }
        function uploadCard(enabled) {
            const node = button('upload', '', 'upload-grid-card', 'upload-cloud', {disabled:!enabled});
            node.id = 'workflowDrop';
            const iconBox = element('span', 'upload-thumb');
            iconBox.append(node.firstChild);
            const body = element('span', 'upload-body');
            body.append(element('strong', '', '上传工作流'), element('small', '', '支持 JSON / ZIP'));
            node.append(iconBox, body);
            return node.outerHTML;
        }
        function detail(item, groupName) {
            const head = element('div', 'panel-head');
            const title = element('div', 'panel-title');
            title.append(element('strong', '', '工作流详情'), element('span', '', item ? label(item) : '选择一个工作流查看详情'));
            head.append(title);
            const scroll = element('div', 'detail-scroll');
            if (!item) {
                const empty = element('div', 'detail-empty');
                empty.append(icon('workflow'), element('span', '', '暂无工作流'));
                scroll.append(empty);
                return head.outerHTML + scroll.outerHTML;
            }
            const key = keyOf(scope(), item);
            const confirm = confirmation === key;
            const controls = element('div', 'panel-actions');
            controls.append(button('insert', item.id, 'asset-btn primary', 'corner-down-left', {title:'插入小美画布', caption:'插入画布'}),
                button('export-desktop', item.id, 'asset-btn', 'folder-down', {title:'保存到系统桌面', caption:'导出桌面'}),
                button('delete', item.id, 'asset-icon-btn danger' + (confirm ? ' detail-confirm' : ''), 'trash-2', {
                    title:confirm ? '再次点击确认移入回收站' : '移入回收站',
                }));
            head.append(controls);
            const frame = element('div', 'detail-media-frame');
            frame.append(preview(item, true));
            const cover = element('div', 'detail-media');
            cover.append(frame);
            const body = element('div', 'detail-body');
            const name = element('input', 'detail-name-input');
            name.type = 'text';
            name.dataset.workflowInlineName = item.id;
            name.dataset.workflowNameKey = key;
            name.defaultValue = renames.get(key)?.draft ?? (item.name || 'workflow');
            name.title = '直接修改名称';
            const grid = element('div', 'detail-meta-grid');
            const structure = item.node_count
                ? Number(item.node_count) + ' 节点 · ' + Number(item.connection_count || 0) + ' 连线' : '打开后读取结构';
            for (const [field, value] of [['类型', label(item)], ['结构', structure], ['创建时间', date(item.created_at)],
                ['位置', '工作流库'], ['分组', groupName || '工作流']]) {
                const cell = element('div', 'detail-meta');
                cell.append(element('span', '', field), element('strong', '', value));
                grid.append(cell);
            }
            body.append(name, grid, element('div', 'detail-url', item.url || ''));
            scroll.append(cover, body);
            return head.outerHTML + scroll.outerHTML;
        }
        function resolve(owner, id, url) {
            const group = categories().find(group => group.__libraryId === owner.libraryId && group.id === owner.categoryId);
            return group?.items?.find(item => item.id === id && (url === undefined || item.url === url));
        }
        const pick = id => resolve(scope(), id);

        async function hydrate() {
            const jobs = [];
            for (const group of categories()) {
                const owner = {libraryId:group.__libraryId, categoryId:group.id};
                for (const item of group.items || []) {
                    if (!item.id || item.preview_graph || previews.has(item)) continue;
                    const cached = inspected.get(keyOf(owner, item));
                    if (cached) {
                        Object.assign(item, cached);
                        continue;
                    }
                    previews.add(item);
                    jobs.push({owner, item});
                }
            }
            let index = 0;
            let changed = false;
            async function read() {
                while (index < jobs.length) {
                    const {owner, item} = jobs[index++];
                    try {
                        const query = new URLSearchParams(locationOf(owner, item));
                        const data = await request('/api/asset-library/workflows/' + encodeURIComponent(item.id) + '/preview?' + query, {cache:'no-store'});
                        const stored = resolve(owner, item.id, item.url);
                        if (stored && !stored.preview_graph && data.preview_graph) {
                            const fields = {};
                            for (const key of ['preview_graph', 'preview_status', 'preview_error', 'node_count', 'connection_count']) {
                                if (key in data) fields[key] = data[key];
                            }
                            inspected.set(keyOf(owner, item), fields);
                            Object.assign(stored, fields);
                            changed ||= visible(owner);
                        }
                    } catch (_) { /* Keep the default thumbnail for unreadable workflow files. */ }
                }
            }
            await Promise.all(Array.from({length:Math.min(jobs.length, 4)}, read));
            if (changed) redraw();
        }
        function update(reply) {
            apply(reply);
            void hydrate();
        }
        async function upload(files) {
            const owner = scope();
            if (!owner.categoryId) throw new Error('请先创建工作流分组');
            const list = Array.from(files).filter(file => /\.(json|zip)$/i.test(file.name) || accepted.has(file.type.toLowerCase()));
            if (!list.length) throw new Error('没有可上传的工作流文件');
            const data = new FormData();
            data.append('library_id', owner.libraryId);
            data.append('category_id', owner.categoryId);
            for (const file of list) data.append('files', file);
            const reply = await request('/api/asset-library/workflows/upload', {method:'POST', body:data});
            update(reply);
            if (visible(owner) && reply.items?.length) select(owner, reply.items[0].id);
            redraw();
            notice('已上传 ' + (reply.items?.length || 0) + ' 个工作流');
        }
        async function exportFiles(ids, desktop = false) {
            const items = ids.map(pick).filter(item => item?.url);
            if (!items.length) return;
            const [first] = items;
            const single = items.length === 1;
            const filename = single ? (first.name || 'workflow').replace(/\.(json|zip)$/i, '') + '.' + format(first) : 'workflows.zip';
            const bridge = desktop && desktopBridge();
            if (desktop && !bridge?.saveWorkflowToDesktop) {
                notice('请重启小美画布桌面端后导出到桌面；浏览器中可通过批量管理的“导出所选”下载');
                return;
            }
            if (single && !desktop) {
                await download(first.url, filename);
                notice('已开始下载工作流');
                return;
            }
            notice(single ? '正在读取工作流文件…' : '正在打包 ' + items.length + ' 个工作流…');
            const error = '导出工作流失败';
            const blob = single ? await media.readBlob(global.fetch(first.url), error)
                : await media.archive(items.map(item => ({url:item.url, name:item.name || 'workflow'})), filename, error);
            if (!desktop) {
                media.saveBlob(blob, filename);
                notice('已开始下载 ' + items.length + ' 个工作流');
                return;
            }
            notice('请选择工作流保存位置');
            const result = await bridge.saveWorkflowToDesktop({filename, bytes:await blob.arrayBuffer()});
            if (result?.canceled) notice('已取消导出');
            else if (result?.ok) notice('已保存到 ' + result.path);
            else throw new Error(result?.message || '保存工作流失败，请重新导出');
        }
        function insert(id) {
            const item = pick(id);
            if (!item?.url) return;
            const payload = {url:item.url, name:item.name || '工作流', ts:Date.now()};
            try { global.localStorage.setItem(inboxKey, JSON.stringify(payload)); } catch (_) { /* The message still reaches the parent. */ }
            global.parent?.postMessage({type:'smart-workflow-to-canvas', payload}, '*');
            notice('已发送到小美画布');
        }
        async function favorite(id) {
            const owner = scope();
            const item = resolve(owner, id);
            if (!item) return;
            const reply = await request('/api/asset-library/items/' + encodeURIComponent(id) + '/favorite', json('PATCH',
                {...locationOf(owner, item), favorite:!item.favorite}));
            update(reply);
            redraw();
            if (visible(owner)) notice(reply.item?.favorite ? '已收藏工作流「' + (item.name || '') + '」，可在「我的收藏」中查看' : '已取消收藏工作流');
        }
        function input(control) {
            const key = control.dataset.workflowNameKey;
            if (key) {
                const state = renames.get(key) || {saving:false};
                state.draft = control.value;
                renames.set(key, state);
            }
        }
        async function rename(id, key) {
            const owner = scope();
            const item = resolve(owner, id);
            const state = renames.get(key);
            if (!item || key !== keyOf(owner, item) || !state) return;
            const name = state.draft.trim();
            if (state.saving) {
                state.next = true;
                return;
            }
            if (!name) {
                notice('工作流名称不能为空');
                return;
            }
            if (name === item.name) {
                renames.delete(key);
                return;
            }
            state.saving = true;
            const submitted = state.draft;
            try {
                const reply = await request('/api/asset-library/items/' + encodeURIComponent(id), json('PATCH', {...locationOf(owner, item), name}));
                update(reply);
                if (state.draft === submitted) renames.delete(key);
                if (visible(owner)) notice('已保存工作流名称');
            } catch (error) {
                if (visible(owner)) notice(error.message || '保存失败');
            } finally {
                state.saving = false;
                if (state.next && renames.has(key) && visible(owner)) {
                    state.next = false;
                    await rename(id, key);
                } else if (visible(owner)) redraw();
            }
        }
        async function trash(ids, single = false) {
            const owner = scope();
            const items = ids.map(id => resolve(owner, id)).filter(Boolean);
            if (!items.length) return;
            if (single && confirmation !== keyOf(owner, items[0])) {
                confirmation = keyOf(owner, items[0]);
                redraw();
                notice('再次点击确认将工作流移入回收站');
                return;
            }
            confirmation = '';
            notice('正在将工作流移入回收站…');
            const reply = await request('/api/asset-library/items/delete', json('POST', {
                library_id:owner.libraryId, ids:items.map(item => item.id), sources:items.map(item => sourceOf(owner, item)),
            }));
            update(reply);
            if (visible(owner)) remove(items.map(item => item.id));
            redraw();
            notice(single ? '工作流已移入回收站' : '已将 ' + (reply.removed || 0) + ' 个工作流移入回收站');
        }
        function dragRecord(id) {
            const owner = scope();
            const item = resolve(owner, id);
            return item && {...owner, id, url:item.url};
        }
        async function move(record, target) {
            const item = resolve(record, record.id, record.url);
            if (!item || !target.categoryId) return;
            if (target.libraryId === record.libraryId && target.categoryId === record.categoryId) {
                notice('工作流已经在这个文件夹中');
                return;
            }
            notice('正在移动工作流...');
            const reply = await request('/api/asset-library/items/move', json('POST', {
                ids:[item.id], library_id:record.libraryId, sources:[sourceOf(record, item)],
                target_library_id:target.libraryId, target_category_id:target.categoryId,
            }));
            update(reply);
            if (visible(record)) select(target, item.id);
            redraw();
            notice('已将「' + (item.name || '工作流') + '」移动到目标文件夹');
        }
        return {card, detail, uploadCard, hydrate, upload, exportFiles, insert, favorite, input, rename, trash, dragRecord, move,
            clearConfirmation() { confirmation = ''; }};
    }
    global.XiaomeiAssetManagerWorkflows = {create, groups, groupFor, matching};
}(window));
