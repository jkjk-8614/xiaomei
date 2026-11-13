(function (global) {
    'use strict';

    const endpoint = '/api/local-assets';
    const parentOf = path => path.split('/').slice(0, -1).join('/');
    const fileOf = item => item.file || item.id;

    function folderAt(tree, path) {
        const remaining = tree ? [tree] : [];
        while (remaining.length) {
            const folder = remaining.pop();
            if ((folder.path || '') === path) return folder;
            remaining.push(...(folder.children || []));
        }
        return null;
    }

    function create(host) {
        const { root, request, notice, redraw, find, scope, tree } = host;
        const doc = root.ownerDocument;
        const modal = doc.getElementById('localUploadMoveModal');
        const targets = doc.getElementById('localUploadMoveFolders');
        const inert = doc.createElement('template').content.ownerDocument;
        let clipboard;
        let moving;
        let draft;
        let active;
        let revision = 0;

        function send(path, method, body) {
            const multipart = body instanceof FormData;
            const options = multipart ? { method, body } : {
                method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
            };
            return request(endpoint + path, options);
        }
        async function load() {
            const version = ++revision;
            try {
                const data = await host.read(() => request(endpoint));
                if (version === revision) host.snapshot(data);
                return true;
            } catch (error) {
                if (version === revision) host.readFailed(error);
                return false;
            }
        }
        function snapshot(data) {
            revision++;
            host.snapshot(data);
        }
        async function write({ path, method = 'POST', body, start, failure }, apply) {
            if (active) {
                notice('正在处理本地素材，请稍候');
                return false;
            }
            active = true;
            if (start) notice(start);
            try {
                const data = await send(path, method, body);
                await apply(data);
                return true;
            } catch (error) {
                notice(error.message || failure);
                return false;
            } finally {
                active = false;
            }
        }
        async function update(data, favorites = false) {
            if (data.items || data.tree) snapshot(data);
            else await load();
            if (favorites) await host.favorites().catch(() => {});
        }
        async function upload(files) {
            const images = [...files].filter(host.isMedia);
            if (!images.length) {
                notice('没有可上传的图片/视频/音频文件');
                return;
            }
            const origin = scope();
            const body = new FormData();
            body.set('folder', origin.folder);
            for (const file of images) body.append('files', file);
            return write({ path: '/upload', body, start: '正在上传...', failure: '上传失败' }, async data => {
                await update({});
                const added = Array.isArray(data.files) ? data.files : [];
                if (host.isCurrent(origin) && added[0]) host.select(added[0].id || added[0].file);
                redraw();
                notice('已上传 ' + added.length + ' 个素材');
            });
        }
        function records(ids) {
            return [...new Set(ids)].map(find).filter(item => item && fileOf(item))
                .map(item => ({ id: item.id, file: fileOf(item), url: item.url, folder: item.folder || '' }));
        }
        function remaining(items) {
            return items.filter(item => {
                const current = find(item.id);
                return current && fileOf(current) === item.file && current.url === item.url;
            });
        }
        function remove(ids) {
            const items = records(ids);
            if (!items.length) return;
            return write({ path: '/delete', body: { names: items.map(fileOf) }, start: '正在移入回收站...', failure: '删除失败' },
                async data => {
                    await update(data);
                    const count = Array.isArray(data.deleted) ? data.deleted.length : items.length;
                    redraw();
                    notice('已将 ' + count + ' 个素材移入回收站');
                });
        }
        function rename(id, value) {
            const item = find(id);
            const name = String(value || '').trim();
            if (!item || !name || name === item.name) return Promise.resolve(true);
            const origin = scope();
            return write({ path: '/items', method: 'PATCH', body: { path: fileOf(item), name }, failure: '重命名失败' },
                async data => {
                    const selected = host.isCurrent(origin) && host.selection().has(id);
                    const focused = host.isCurrent(origin) && host.selected() === id;
                    snapshot(data);
                    const next = data.item?.id || data.item?.file;
                    if (next && host.isCurrent(origin)) {
                        if (selected) host.selection().add(next);
                        if (focused && !host.selected()) host.select(next);
                    }
                    await host.favorites().catch(() => {});
                    redraw();
                    notice('已重命名素材，反推提示词和分类索引已同步');
                });
        }
        function startRename(id) {
            const item = find(id);
            const card = [...root.querySelectorAll('[data-localup-card]')].find(node => node.dataset.localupCard === id);
            const label = card?.querySelector('.asset-card-name');
            if (!item || !label) return;
            const input = doc.createElement('input');
            input.type = 'text';
            input.className = 'asset-card-name-input';
            input.setAttribute('aria-label', '素材名称');
            input.value = item.name || '本地素材';
            const original = input.value;
            let saving = false;
            let closed = false;
            let composing = false;
            const close = () => {
                closed = true;
                if (input.isConnected) input.replaceWith(label);
            };
            const commit = async () => {
                if (closed || saving) return;
                const value = input.value.trim();
                if (!value || value === original) {
                    close();
                    return;
                }
                saving = true;
                input.disabled = true;
                if (await rename(id, value)) close();
                else if (input.isConnected) {
                    input.disabled = false;
                    input.focus();
                    input.select();
                }
                saving = false;
            };
            for (const type of ['pointerdown', 'mousedown', 'click']) input.addEventListener(type, event => event.stopPropagation());
            input.addEventListener('compositionstart', () => { composing = true; });
            input.addEventListener('compositionend', () => { composing = false; });
            input.addEventListener('keydown', event => {
                event.stopPropagation();
                if (composing || event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
                if (event.key === 'Enter') void commit();
                if (event.key === 'Escape' && !saving) close();
            });
            input.addEventListener('blur', () => { if (!composing) void commit(); });
            label.replaceWith(input);
            input.focus();
            input.select();
        }

        function closeMove() {
            moving = null;
            modal.hidden = true;
        }
        function openMove(ids) {
            const items = records(ids);
            if (!items.length) {
                notice('没有可移动的素材');
                return;
            }
            moving = items;
            doc.getElementById('localUploadMoveCount').textContent = '选择 ' + items.length + ' 个素材的目标文件夹';
            const fragment = doc.createDocumentFragment();
            function addFolder(path, name, level) {
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'local-upload-move-folder';
                button.dataset.localupMoveTarget = path;
                button.style.setProperty('--folder-depth', level);
                button.disabled = items.every(item => item.folder === path);
                const icon = doc.createElement('i');
                icon.dataset.lucide = 'folder';
                const label = doc.createElement('span');
                label.textContent = name;
                button.append(icon, label);
                if (button.disabled) {
                    const current = doc.createElement('small');
                    current.textContent = '当前位置';
                    button.append(current);
                }
                fragment.append(button);
            }
            function addChildren(folder, depth) {
                for (const child of folder?.children || []) {
                    addFolder(child.path || '', child.name || '文件夹', depth);
                    addChildren(child, depth + 1);
                }
            }
            addFolder('', '全部上传（根目录）', 0);
            addChildren(tree(), 1);
            targets.replaceChildren(fragment);
            modal.hidden = false;
            host.icons();
            targets.querySelector('button:not(:disabled)')?.focus();
        }
        async function moveItems(items, folder, after) {
            const current = remaining(items);
            if (!current.length) { notice('没有可移动的素材'); return; }
            if (folder && !folderAt(tree(), folder)) { notice('目标文件夹不存在'); return; }
            if (current.every(item => item.folder === folder)) { notice('素材已在这个文件夹'); return; }
            const names = current.map(fileOf);
            return write({ path: '/move', body: { names, folder }, start: '正在移动素材...', failure: '移动素材失败' },
                async data => {
                    await update(data, true);
                    after?.();
                    redraw();
                    const moved = Number(data.moved ?? names.length);
                    const missed = Math.max(0, names.length - moved);
                    notice('已移动 ' + moved + ' 个素材' + (missed ? '，' + missed + ' 个未移动' : ''));
                });
        }
        modal.addEventListener('click', event => {
            if (event.target.closest('[data-localup-move-close]')) closeMove();
            const button = event.target.closest('[data-localup-move-target]');
            if (button && !button.disabled && moving) {
                const original = moving;
                void moveItems(original, button.dataset.localupMoveTarget, () => { if (moving === original) closeMove(); });
            }
        });
        modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeMove(); });

        function cut() {
            const items = records(host.selection());
            if (!items.length) { notice('没有选中的素材'); return; }
            clipboard = { items, folder: scope().folder };
            host.selection().clear();
            redraw();
            notice('已剪切 ' + items.length + ' 个素材，切换到目标文件夹后点"移动到此文件夹"');
        }
        function paste() {
            if (!clipboard || clipboard.folder === scope().folder) return;
            const original = clipboard;
            return moveItems(original.items, scope().folder, () => { if (clipboard === original) clipboard = null; });
        }
        function clipboardMarkup(folderName) {
            if (!clipboard) return '';
            const sameFolder = clipboard.folder === scope().folder;
            const bar = inert.createElement('div');
            bar.className = 'asset-clipboard-bar';
            bar.innerHTML = '<div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span></span></div>'
                + '<div class="asset-tools"><button class="asset-btn primary" type="button" data-localup-paste-clipboard><i data-lucide="clipboard-paste"></i><span></span></button>'
                + '<button class="asset-icon-btn" type="button" data-localup-clear-clipboard title="取消剪切"><i data-lucide="x"></i></button></div>';
            bar.querySelector('.asset-clipboard-info span').textContent = '已剪切 ' + clipboard.items.length + ' 个素材';
            const paste = bar.querySelector('[data-localup-paste-clipboard]');
            paste.disabled = sameFolder;
            paste.querySelector('span').textContent = sameFolder ? '切到其他文件夹后移动' : '移动到「' + folderName + '」';
            return bar.outerHTML;
        }
        function startFolder() {
            draft = { origin: scope(), name: '新文件夹' };
            redraw();
            host.focusFolder();
        }
        function cancelFolder(render = true) {
            if (!draft) return;
            draft = null;
            if (render) redraw();
        }
        function folderDraft() { return draft && host.isCurrent(draft.origin) ? draft : null; }
        async function folderAction(operation) {
            const editor = operation === 'create' ? folderDraft() : null;
            const origin = editor?.origin || scope();
            const path = origin.folder;
            if (!path && operation !== 'create') {
                notice(operation === 'rename' ? '根目录不能重命名' : '根目录不能删除');
                return;
            }
            const folderName = folderAt(tree(), path)?.name || path.split('/').at(-1) || '文件夹';
            let name;
            if (operation === 'create') {
                if (!editor || editor.saving) return;
                name = editor.name.trim();
            } else if (operation === 'rename') {
                name = String(global.prompt('重命名文件夹', folderName) || '').trim();
                if (!name || name === folderName) return;
            }
            if (operation === 'create' && !name) { host.focusFolder(); return; }
            const removing = operation === 'delete';
            const creating = operation === 'create';
            if (editor) { editor.saving = true; redraw(); }
            const result = await write({
                path: '/folders',
                method: creating ? 'POST' : removing ? 'DELETE' : 'PATCH',
                body: creating ? { parent: path, name } : removing ? { path } : { path, name },
                start: removing ? '正在将「' + folderName + '」移入回收站...' : '',
                failure: creating ? '新建文件夹失败' : removing ? '删除文件夹失败' : '重命名文件夹失败',
            }, async data => {
                if (host.isCurrent(origin)) host.selectFolder(removing ? parentOf(path) : data.folder?.path || path);
                if (draft === editor) draft = null;
                await update(data, !creating);
                redraw();
                if (removing) notice(data.already_missing ? '文件夹「' + folderName + '」已不存在，已刷新本地素材'
                    : '文件夹「' + folderName + '」及其中的素材已移入回收站');
                else notice(creating ? '已新建本地素材文件夹' : '已重命名本地素材文件夹');
            });
            if (!result && editor && draft === editor) {
                editor.saving = false;
                redraw();
                if (host.isCurrent(origin)) host.focusFolder();
            }
        }
        function reorder(source, target, after) {
            if (!source || !target || source === target || parentOf(source) !== parentOf(target)) return;
            const parent = parentOf(source);
            const paths = (folderAt(tree(), parent)?.children || []).map(folder => folder.path);
            if (!paths.includes(source) || !paths.includes(target)) return;
            paths.splice(paths.indexOf(source), 1);
            paths.splice(paths.indexOf(target) + Number(after), 0, source);
            return write({ path: '/folders/reorder', body: { parent, paths }, failure: '调整文件夹顺序失败' },
                async data => { await update(data); redraw(); notice('文件夹顺序已保存'); });
        }

        return {
            load, upload, remove, rename, startRename, openMove, closeMove, cut, paste, clipboardMarkup,
            startFolder, cancelFolder, folderDraft, folderAction, reorder,
            move: (ids, folder) => moveItems(records(ids), folder),
            clearClipboard() { clipboard = null; redraw(); },
            invalidate() { revision++; },
        };
    }

    global.XiaomeiAssetManagerLocalFiles = { create, folderAt, parentOf };
}(window));
