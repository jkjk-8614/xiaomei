(function (root) {
    'use strict';

    const directoryNames = { upload: '上传素材', generated: '生成素材', local: '本地素材' };
    const defaultCaption = '描述图片';
    const imagePrefsPath = '/api/image-storage-preferences';
    const classificationPath = '/api/asset-classification-prompt';
    const storagePath = '/api/storage-settings';
    const fileListPath = '/api/storage-files';
    const cloudFields = [
        ['bucket', 'Bucket', '例如：xiaomei-assets'],
        ['region', 'Region', '例如：z2'],
        ['domain', '存储桶域名', '例如：https://media.example.com'],
    ];

    function imagePreferences(value) {
        const source = value?.providers?.qiniu || {};
        return {
            mode: value?.mode === 'cloud' ? 'cloud' : 'local',
            provider: 'qiniu',
            providers: { qiniu: Object.fromEntries(cloudFields.map(([key]) => [key, String(source[key] || '').trim()])) },
        };
    }

    function create(host) {
        const document = root.document;
        const inert = document.createElement('template').content.ownerDocument;
        const { request, notice } = host;
        const writes = new Map();
        let current;
        let picker;
        let lastKind = 'generated';

        function element(tag, classes, text) {
            const node = inert.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        }
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function button(hook, { text, glyph, classes, value = '', title, disabled } = {}) {
            const node = element('button', classes);
            node.type = 'button';
            node.setAttribute('data-' + hook, value);
            if (text) node.append(element('span', '', text));
            if (glyph) node.prepend(icon(glyph));
            if (title) node.title = title;
            if (disabled) node.disabled = true;
            return node;
        }
        function field(id, value, placeholder) {
            const input = element('input');
            input.id = id;
            input.defaultValue = value || '';
            input.placeholder = placeholder || '';
            return input;
        }
        function textarea(id, value, placeholder, classes) {
            const input = element('textarea', classes, value || '');
            input.id = id;
            input.placeholder = placeholder;
            return input;
        }
        function fieldRow(label, control, classes = 'storage-dir-row') {
            const row = element('label', classes);
            row.append(typeof label === 'string' ? element('span', '', label) : label, control);
            return row;
        }
        function section(name, glyph, classes = 'asset-pref-section') {
            const node = element('div', classes);
            const title = element('div', 'asset-pref-title');
            title.append(icon(glyph), element('span', '', name));
            node.append(title);
            return node;
        }
        function actions(hook, text, disabled, inline, value) {
            const area = element('div', inline ? 'storage-settings-actions inline' : 'asset-pref-editor-actions');
            area.append(button(hook, { text, glyph: 'save', classes: 'asset-btn primary', disabled, value }));
            return area;
        }
        function storageMode(value, text, detail, active) {
            const label = element('label', active ? 'image-storage-mode-card active' : 'image-storage-mode-card');
            const input = element('input');
            input.type = 'radio';
            input.name = 'imageStorageMode';
            input.value = value;
            input.defaultChecked = active;
            input.dataset.imageStorageMode = value;
            const caption = element('span');
            caption.append(element('b', '', text), element('em', '', detail));
            label.append(input, caption);
            return label;
        }
        function cloudEditor(preferences) {
            const body = element('div', 'asset-pref-editor image-storage-cloud-editor');
            const fields = element('div', 'asset-pref-grid');
            const provider = element('select');
            provider.id = 'imageStorageProvider';
            provider.dataset.imageStorageInput = 'provider';
            const qiniu = element('option', '', '七牛云 Kodo');
            qiniu.value = 'qiniu';
            qiniu.defaultSelected = true;
            provider.append(qiniu);
            fields.append(fieldRow('存储服务商', provider));
            for (const [name, label, placeholder] of cloudFields) {
                const id = 'imageStorageQiniu' + name[0].toUpperCase() + name.slice(1);
                const input = field(id, preferences.providers.qiniu[name], placeholder);
                input.dataset.imageStorageInput = name;
                fields.append(fieldRow(label, input));
            }
            body.append(fields, element('div', 'image-space-hint', '切换存储位置不会迁移历史图片，也不会改变现有本地图片空间。'));
            return body;
        }
        function imageSection(view) {
            const block = section('图片存储位置', 'cloud-cog', 'asset-pref-section image-storage-preference-section');
            const modes = element('div', 'asset-pref-grid image-storage-mode-grid');
            const cloud = view.image.mode === 'cloud';
            modes.append(
                storageMode('local', '本地存储', '沿用现有图片空间和三个素材目录。', !cloud),
                storageMode('cloud', '云端存储', '当前仅保存七牛云 Kodo 偏好，上传流程尚未接入。', cloud),
            );
            block.append(modes);
            if (cloud) block.append(cloudEditor(view.image));
            block.append(actions('image-storage-save', '保存存储设置', !view.ready.image || writes.has('image'), true));
            return block;
        }
        function fold(kind, label, glyph, summary, open) {
            const node = button('pref-editor', { value: kind, classes: open ? 'asset-pref-fold open' : 'asset-pref-fold' });
            const title = element('span');
            title.append(icon(glyph), element('b', '', label));
            node.append(title, element('em', '', summary), icon(open ? 'chevron-up' : 'chevron-down'));
            return node;
        }
        function textPreferences(view) {
            const block = element('div', 'asset-pref-section');
            const captionOpen = view.editor === 'caption';
            const classifyOpen = view.editor === 'classify';
            block.append(fold('caption', '反推提示词', 'message-square-text', view.caption || defaultCaption, captionOpen));
            if (captionOpen) {
                const editor = element('div', 'asset-pref-editor');
                editor.append(fieldRow('反推提示词', textarea('prefCaptionPrompt', view.caption || defaultCaption, defaultCaption)),
                    actions('pref-editor-save', '保存', false, false, 'caption'));
                block.append(editor);
            }
            block.append(fold('classify', '智能分类提示词', 'tags', '编辑分类规则和追加要求', classifyOpen));
            if (classifyOpen) {
                const editor = element('div', 'asset-pref-editor');
                const label = element('span');
                const reset = button('class-rule-reset', { classes: 'asset-inline-link', disabled: !view.ready.rule });
                reset.textContent = '恢复内置规则';
                label.append('智能分类规则 ', reset);
                editor.append(
                    fieldRow('智能分类追加要求', textarea('prefClassifyPrompt', view.classHint,
                        '可追加分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。')),
                    fieldRow(label, textarea('prefClassificationRulePrompt', view.rule,
                        '这里显示内置分类提示词，可按你的素材体系编辑后保存。', 'asset-pref-rule-textarea')),
                    actions('pref-editor-save', '保存', !view.ready.rule || writes.has('rule'), false, 'classify'),
                );
                block.append(editor);
            }
            return block;
        }
        function directorySection(view) {
            const block = section('资产管理', 'folder-cog');
            const input = field('storageImageSpaceRoot', view.path, '例如：F:\\图片空间');
            input.className = 'storage-root-input';
            input.readOnly = true;
            input.setAttribute('role', 'button');
            input.tabIndex = 0;
            input.dataset.storageBrowse = 'root';
            input.title = '点击选择资产管理根目录';
            input.setAttribute('aria-label', '选择资产管理根目录');
            const choose = button('storage-browse', { value: 'root', glyph: 'folder-open', text: '选择', title: '选择资产管理根目录' });
            if (picker || writes.has('files')) {
                for (const control of [input, choose]) {
                    control.disabled = true;
                    if (picker) control.setAttribute('aria-busy', 'true');
                }
            }
            const pickerRow = element('div', 'storage-dir-control');
            pickerRow.append(input, choose);
            const rows = element('div', 'storage-dir-grid');
            for (const [kind, label] of Object.entries(directoryNames)) {
                const path = view.path ? view.path.replace(/[\\/]+$/, '') + '\\' + label : view.dirs[kind];
                const directory = field('storageDir_' + kind, path, view.defaults[kind]);
                directory.readOnly = true;
                const control = element('div', 'storage-dir-control');
                control.append(directory);
                rows.append(fieldRow(label, control));
            }
            block.append(fieldRow('资产管理根目录', pickerRow, 'storage-dir-row image-space-root-row'),
                element('div', 'image-space-hint', '资产管理包含以下三个文件夹：上传素材、生成素材、本地素材。点击上方路径或“选择”即可更换根目录；已有旧目录会保留为兼容来源，切换后不会自动删除。'),
                rows, actions('storage-save', '保存资产管理设置',
                    !(view.ready.path || view.pathChosen) || picker || writes.has('files'), true));
            return block;
        }
        function fileCard(item, selected) {
            const card = element('label', selected ? 'storage-file-card selected' : 'storage-file-card');
            const check = element('input');
            check.type = 'checkbox';
            check.defaultChecked = selected;
            check.dataset.storageFile = item.id;
            check.dataset.storageRel = item.rel;
            const thumb = element('div', 'storage-file-thumb');
            const template = element('template');
            template.innerHTML = host.thumbnail(item);
            thumb.append(template.content);
            const name = element('span', '', item.name);
            name.title = item.name;
            const size = item.width ? ' · ' + item.width + '×' + item.height : '';
            card.append(check, thumb, name, element('em', '', host.kindLabel(item) + ' · ' + host.fileSize(item.size) + size));
            return card;
        }
        function directoryFiles(view) {
            const { files } = view;
            const head = element('div', 'storage-file-head');
            const kinds = element('div', 'storage-tabs');
            for (const kind of ['generated', 'upload', 'local']) {
                kinds.append(button('storage-kind', { value: kind, text: directoryNames[kind], classes: files.kind === kind ? 'active' : '' }));
            }
            const commands = element('div', 'storage-file-actions');
            commands.append(
                button('storage-select-all', { text: '全选', glyph: 'check-square', classes: 'asset-btn', disabled: !files.items.length }),
                button('storage-delete', { text: '移入回收站 ' + (files.selected.size || ''), glyph: 'trash-2',
                    classes: 'asset-btn danger', disabled: !files.selected.size || writes.has('files') }),
            );
            head.append(kinds, commands);
            const grid = element('div', 'storage-file-grid');
            grid.dataset.storageFileGrid = '';
            if (files.loading && !files.items.length) grid.append(element('div', 'storage-empty', '正在读取目录...'));
            else if (!files.items.length) grid.append(element('div', 'storage-empty', '这个目录里暂时没有素材'));
            else {
                for (const item of files.items) grid.append(fileCard(item, files.selected.has(item.id)));
                const paging = files.hasMore || files.loading;
                const text = files.loading ? '继续加载中...' : files.hasMore
                    ? `已加载 ${files.items.length} / ${files.total}，向下滚动继续` : `已加载全部 ${files.items.length} 个`;
                grid.append(element('div', paging ? 'storage-load-more' : 'storage-load-more done', text));
            }
            grid.addEventListener('scroll', () => {
                if (view.files === files && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 260) {
                    void readFiles(view, files, true);
                }
            }, { passive: true });
            return [head, grid];
        }
        function render(view) {
            if (current !== view) return;
            const oldGrid = view.overlay.querySelector('[data-storage-file-grid]');
            const modal = element('div', 'storage-settings-modal');
            const head = element('div', 'storage-settings-head');
            const title = element('div');
            title.append(element('strong', '', '资产管理'), element('span', '', '统一管理上传素材、生成素材和本地素材。'));
            head.append(title, button('storage-close', { glyph: 'x' }));
            const tabs = element('div', 'asset-pref-tabs');
            for (const [tab, name, glyph] of [['prefs', '偏好设置', 'sliders-horizontal'], ['manage', '素材管理', 'images']]) {
                tabs.append(button('pref-tab', { value: tab, text: name, glyph, classes: view.tab === tab ? 'active' : '' }));
            }
            const body = element('div', 'asset-pref-body');
            if (view.tab === 'manage') body.append(directorySection(view), ...directoryFiles(view));
            else body.append(imageSection(view), textPreferences(view));
            modal.append(head, tabs, body);
            const focused = document.activeElement;
            const focusedControl = view.overlay.contains(focused) ? focused : null;
            const selection = focusedControl?.selectionStart == null
                ? null : [focusedControl.selectionStart, focusedControl.selectionEnd];
            view.overlay.replaceChildren(modal);
            if (oldGrid) {
                const next = view.overlay.querySelector('[data-storage-file-grid]');
                if (next && oldGrid.dataset.kind === view.files.kind) next.scrollTop = oldGrid.scrollTop;
            }
            const grid = view.overlay.querySelector('[data-storage-file-grid]');
            if (grid) grid.dataset.kind = view.files.kind;
            const nextFocus = focusedControl?.id ? document.getElementById(focusedControl.id)
                : focusedControl?.dataset.storageFile != null && grid?.dataset.kind === oldGrid?.dataset.kind
                    ? grid.querySelector('[data-storage-file="' + CSS.escape(focusedControl.dataset.storageFile) + '"]') : null;
            if (nextFocus) {
                nextFocus.focus({ preventScroll: true });
                if (selection) nextFocus.setSelectionRange(...selection);
            }
            host.icons();
            host.videoThumbs(view.overlay);
        }

        function newFiles(kind) {
            return { kind, items: [], selected: new Set(), loading: false, loaded: false, hasMore: false, total: 0 };
        }
        async function readFiles(view, files, more = false) {
            if (view !== current || files !== view.files || files.loading || (more && !files.hasMore)) return;
            files.loading = true;
            if (view.tab === 'manage') render(view);
            try {
                const previousWrite = writes.get('files');
                if (previousWrite) await previousWrite.catch(() => {});
                if (view !== current || files !== view.files) return;
                const query = new URLSearchParams({ kind: files.kind, offset: more ? files.items.length : 0, limit: 80 });
                const data = await request(fileListPath + '?' + query);
                if (view !== current || files !== view.files) return;
                const items = Array.isArray(data.items) ? data.items : [];
                files.items = more ? files.items.concat(items) : items;
                if (!more && files.selected.size) {
                    files.selected = new Set(items.filter(item => files.selected.has(item.id)).map(item => item.id));
                }
                files.total = Number(data.total) || files.items.length;
                files.hasMore = Boolean(data.has_more && items.length);
                files.loaded = true;
            } catch (error) {
                if (view === current && files === view.files) notice(error.message || '加载素材目录失败');
            } finally {
                files.loading = false;
                if (files === view.files && view.tab === 'manage') render(view);
            }
        }
        function showFiles(view, kind) {
            lastKind = kind;
            view.files = newFiles(kind);
            void readFiles(view, view.files);
        }
        function json(path, method, payload, signal) {
            return request(path, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal,
            });
        }
        async function loadSetting(view, key, path, apply) {
            try {
                const previousWrite = writes.get(key === 'path' ? 'files' : key);
                if (previousWrite) await previousWrite.catch(() => {});
                if (view !== current) return;
                const data = await request(path).catch(error => {
                    if (key === 'image' && [404, 405].includes(error.status)) return {};
                    throw error;
                });
                if (view !== current) return;
                apply(data);
                view.ready[key] = true;
                if (view.tab === (key === 'path' ? 'manage' : 'prefs')) render(view);
            } catch (error) {
                if (view === current) notice(error.message || '加载存储设置失败');
            }
        }
        async function write(view, key, perform) {
            if (view !== current || writes.has(key)) return;
            const pending = Promise.resolve().then(perform);
            writes.set(key, pending);
            render(view);
            try {
                await pending;
            } finally {
                writes.delete(key);
                if (current) render(current);
            }
        }
        function updateDirectories(view, data, keepPath = false) {
            if (!keepPath) view.path = data.image_space || data.root || view.path;
            view.dirs = data.dirs || view.dirs;
            view.defaults = data.defaults || view.defaults;
        }
        async function chooseDirectory(view) {
            if (picker || writes.has('files')) return;
            picker = view;
            render(view);
            notice('请选择资产管理根目录...');
            const controller = new AbortController();
            const timeout = root.setTimeout(() => controller.abort(), 190000);
            try {
                const data = await json('/api/select-folder', 'POST', {
                    kind: '', initial_path: view.path, title: '选择资产管理根目录',
                }, controller.signal);
                if (view !== current) return;
                if (data.selected && data.path) {
                    view.path = data.path;
                    view.pathChosen = true;
                    notice('已选择资产管理根目录，请点击“保存资产管理设置”');
                } else {
                    notice('已取消选择文件夹');
                }
            } catch (error) {
                if (view === current) notice(error.name === 'AbortError'
                    ? '文件夹选择超时，请重新点击“选择”' : error.message || '选择资产管理根目录失败');
            } finally {
                root.clearTimeout(timeout);
                picker = null;
                if (current) render(current);
            }
        }
        function saveDirectories(view) {
            if (!(view.ready.path || view.pathChosen) || picker) return;
            return write(view, 'files', async () => {
                const data = await json(storagePath, 'PATCH', { image_space: view.path, migrate_legacy: true });
                if (view !== current) return;
                updateDirectories(view, data);
                const count = data.migration?.moved;
                notice(count ? '资产管理已保存，已整理 ' + count + ' 个旧素材' : '偏好设置已保存');
                showFiles(view, view.files.kind);
            });
        }
        function deleteFiles(view) {
            const { files } = view;
            const items = files.items.filter(item => files.selected.has(item.id)).map(item => item.rel);
            if (!items.length || !root.confirm('确认将 ' + items.length + ' 个素材移入回收站？之后可从统一素材回收站恢复。')) return;
            return write(view, 'files', async () => {
                const data = await json(fileListPath + '/delete', 'POST', { kind: files.kind, items });
                if (view !== current) return;
                if (view.files === files) showFiles(view, files.kind);
                else if (view.files.kind === files.kind) {
                    const latest = view.files;
                    for (const item of latest.items) {
                        if (items.includes(item.rel)) latest.selected.delete(item.id);
                    }
                    void readFiles(view, latest);
                }
                notice('已将 ' + (data.removed || 0) + ' 个文件移入回收站');
            });
        }
        function saveImage(view) {
            if (!view.ready.image) return;
            const draft = imagePreferences(view.image);
            const revision = view.imageRevision;
            return write(view, 'image', async () => {
                const data = await json(imagePrefsPath, 'PATCH', draft);
                if (view !== current) return;
                if (view.imageRevision === revision) view.image = imagePreferences(data);
                notice('图片存储设置已保存');
            });
        }
        function saveText(view, editor) {
            if (editor === 'caption') {
                view.caption = view.caption || defaultCaption;
                host.saveCaptionSettings({ caption: view.caption });
                view.editor = '';
                render(view);
                notice('偏好设置已保存');
                return;
            }
            if (!view.ready.rule) return;
            const { rule, classHint } = view;
            return write(view, 'rule', async () => {
                const data = await json(classificationPath, 'PATCH', { prompt: rule });
                host.saveCaptionSettings({ classHint });
                if (view !== current) return;
                if (view.rule === rule && view.classHint === classHint) {
                    view.rule = data.prompt ?? rule;
                    if (view.editor === editor) view.editor = '';
                }
                notice('偏好设置已保存');
            });
        }
        function close(view) {
            view.overlay.remove();
            current = null;
        }
        const dialogActions = root.XiaomeiAssetManagerInteractions.create([{
            'storage-close': (_value, _control, _event, view) => close(view),
            'storage-browse'(_value, _control, event, view) {
                event.preventDefault();
                event.stopPropagation();
                return chooseDirectory(view);
            },
            'pref-tab'(tab, _control, _event, view) {
                view.tab = tab;
                view.editor = '';
                if (tab === 'manage' && !view.files.loaded && !view.files.loading) void readFiles(view, view.files);
                else render(view);
            },
            'pref-editor'(editor, _control, _event, view) {
                view.editor = view.editor === editor ? '' : editor;
                render(view);
            },
            'class-rule-reset'(_value, _control, event, view) {
                event.preventDefault();
                view.rule = view.defaultRule;
                view.ruleEdited = true;
                view.overlay.querySelector('#prefClassificationRulePrompt').value = view.rule;
            },
            'storage-kind'(kind, _control, _event, view) {
                if (view.files.kind !== kind || !view.files.loading) showFiles(view, kind);
            },
            'storage-select-all'(_value, _control, _event, view) {
                view.files.selected = new Set(view.files.items.map(item => item.id));
                render(view);
            },
            'storage-delete': (_value, _control, _event, view) => deleteFiles(view),
            'storage-save': (_value, _control, _event, view) => saveDirectories(view),
            'image-storage-save': (_value, _control, _event, view) => saveImage(view),
            'pref-editor-save': (editor, _control, _event, view) => saveText(view, editor),
        }]);
        function open({ tab = 'manage' } = {}) {
            if (current) close(current);
            const overlay = document.createElement('div');
            overlay.id = 'storageSettingsOverlay';
            overlay.className = 'storage-settings-overlay';
            const view = {
                overlay, tab: tab === 'prefs' ? 'prefs' : 'manage', editor: '',
                path: '', dirs: {}, defaults: {}, files: newFiles(lastKind),
                ...host.captionSettings(), rule: '', defaultRule: '',
                image: imagePreferences(), imageEdits: new Set(), imageRevision: 0, ready: {},
            };
            current = view;
            overlay.addEventListener('click', event => {
                dialogActions.dispatch(event, overlay, view).catch(error => {
                    if (view === current) notice(error.message || '操作失败');
                });
            });
            overlay.addEventListener('keydown', event => {
                if (event.target.id === 'storageImageSpaceRoot' && ['Enter', ' ', 'Spacebar'].includes(event.key)) {
                    event.preventDefault();
                    void chooseDirectory(view);
                }
            });
            overlay.addEventListener('input', ({ target }) => {
                if (target.id === 'prefCaptionPrompt') view.caption = target.value;
                if (target.id === 'prefClassifyPrompt') {
                    view.classHint = target.value;
                    view.classHintEdited = true;
                }
                if (target.id === 'prefClassificationRulePrompt') {
                    view.rule = target.value;
                    view.ruleEdited = true;
                }
                const field = target.dataset.imageStorageInput;
                if (field && field !== 'provider') {
                    view.image.providers.qiniu[field] = target.value;
                    view.imageEdits.add(field);
                    view.imageRevision++;
                }
            });
            overlay.addEventListener('change', ({ target }) => {
                if (target.dataset.imageStorageMode && target.checked) {
                    view.image.mode = target.value;
                    view.imageEdits.add('mode');
                    view.imageRevision++;
                    render(view);
                }
                const id = target.dataset.storageFile;
                if (id != null) {
                    if (target.checked) view.files.selected.add(id);
                    else view.files.selected.delete(id);
                    render(view);
                }
            });
            document.body.append(overlay);
            if (view.tab === 'manage') void readFiles(view, view.files);
            else render(view);
            void loadSetting(view, 'path', storagePath, data => updateDirectories(view, data, view.pathChosen));
            void loadSetting(view, 'rule', classificationPath, data => {
                view.defaultRule = data.default_prompt || '';
                if (!view.ruleEdited) view.rule = data.prompt || view.defaultRule;
                if (!view.classHintEdited) view.classHint = host.captionSettings().classHint;
            });
            void loadSetting(view, 'image', imagePrefsPath, data => {
                const saved = imagePreferences(data);
                if (!view.imageEdits.has('mode')) view.image.mode = saved.mode;
                for (const [field] of cloudFields) {
                    if (!view.imageEdits.has(field)) view.image.providers.qiniu[field] = saved.providers.qiniu[field];
                }
            });
        }

        return { open };
    }

    root.XiaomeiAssetManagerStorage = { create };
}(window));
