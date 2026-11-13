(function (global) {
    'use strict';

    const endpoint = '/api/prompt-libraries/items';
    const description = global.XiaomeiPromptPresentation.description;
    const fields = [
        ['name', 'promptEditName', '名称', '提示词名称'],
        ['positive', 'promptEditPositive', '正向提示词', '输入或粘贴提示词正文'],
        ['scene', 'promptEditScene', '用途说明（选填）', '说明适用场景或使用方法'],
        ['negative', 'promptEditNegative', '负向提示词（选填）', '填写希望避免的内容'],
    ];

    function create(host) {
        const document = host.root.ownerDocument;
        const markup = document.createElement('template').content.ownerDocument;
        let editor;
        let saving = false;
        let writing = false;
        let confirmation;

        function node(tag, classes, label, owner = markup) {
            const element = owner.createElement(tag);
            if (classes) element.className = classes;
            if (label != null) element.textContent = label;
            return element;
        }
        function button(action, label, { classes, icon, title, ariaLabel, value = '', disabled, libraryId, owner, plain = false } = {}) {
            const control = node('button', classes, null, owner);
            control.type = 'button';
            control.setAttribute('data-' + action, value);
            control.disabled = Boolean(disabled);
            if (libraryId) control.dataset.promptOwner = libraryId;
            if (title) control.title = title;
            if (ariaLabel) control.setAttribute('aria-label', ariaLabel);
            if (icon) {
                const glyph = node('i', '', null, owner);
                glyph.dataset.lucide = icon;
                control.append(glyph);
            }
            if (label) control.append(plain ? label : node('span', '', label, owner));
            return control;
        }
        function favoriteButton(item, libraryId, classes) {
            const title = item.favorite ? '取消收藏' : '收藏';
            return button('prompt-favorite', '', {
                value: item.id, libraryId, title, ariaLabel: title, icon: 'star',
                classes: item.favorite ? classes + ' is-fav' : classes,
            });
        }
        function row(item, { libraryId, category, active, selected, readonly }) {
            const element = node('article', active ? 'prompt-row active' : 'prompt-row');
            element.dataset.promptRow = item.id;
            element.dataset.promptOwner = libraryId;
            const check = node('input', 'prompt-row-check');
            check.type = 'checkbox';
            check.dataset.promptCheck = item.id;
            check.defaultChecked = selected;
            check.disabled = readonly;
            const main = node('div', 'prompt-row-main');
            const title = node('div', 'prompt-row-title');
            title.append(node('strong', '', item.name || '提示词'), node('span', 'prompt-tag', category),
                favoriteButton(item, libraryId, 'prompt-row-fav'));
            main.append(title);
            const scene = description(item.scene, item.positive);
            if (scene) main.append(node('div', 'prompt-row-scene', scene));
            main.append(node('div', 'prompt-row-text', item.positive || ''));
            element.append(check, main);
            return element.outerHTML;
        }
        function textBlock(label, text, negative = false) {
            const section = node('section', 'prompt-block');
            const heading = node('div', 'prompt-block-head');
            heading.append(node('span', '', label), node('span', '', String(text || '').length + ' 字符'));
            const area = node('textarea', negative ? 'prompt-block-body negative' : 'prompt-block-body', text || '未填写');
            area.readOnly = true;
            area.spellcheck = false;
            if (String(text || '').startsWith('\n')) area.prepend(markup.createTextNode('\n'));
            section.append(heading, area);
            return section;
        }
        function detail(item, { libraryId, category, readonly } = {}) {
            const header = node('div', 'panel-head');
            const title = node('div', 'panel-title');
            title.append(node('strong', '', '提示词预览'), node('span', '', item ? category : '选择一条提示词查看全文'));
            header.append(title);
            const body = node('div', 'detail-scroll');
            if (!item) {
                const empty = node('div', 'detail-empty');
                const glyph = node('i');
                glyph.dataset.lucide = 'text-cursor-input';
                empty.append(glyph, node('span', '', '暂无可预览提示词'));
                body.append(empty);
                return header.outerHTML + body.outerHTML;
            }
            const commands = node('div', 'panel-actions');
            commands.append(favoriteButton(item, libraryId, 'asset-icon-btn prompt-detail-fav'),
                button('prompt-edit-start', '编辑', { classes: 'asset-btn', icon: 'pencil', title: '展开编辑',
                    value: item.id, libraryId, disabled: readonly }),
                button('prompt-delete', '', { classes: 'asset-icon-btn danger', icon: 'trash-2', title: '删除',
                    value: item.id, libraryId, disabled: readonly }));
            header.append(commands);
            const heading = node('div', 'prompt-detail-head');
            heading.append(node('div', 'prompt-detail-title', item.name || '提示词'));
            const scene = description(item.scene, item.positive);
            if (scene) heading.append(node('div', 'prompt-detail-scene', scene));
            body.append(heading, textBlock('正向提示词', item.positive), textBlock('负向提示词', item.negative, true));
            if (item.params && typeof item.params === 'object' && Object.keys(item.params).length) {
                const list = node('div', 'params-list');
                for (const [key, value] of Object.entries(item.params)) {
                    const field = node('div', 'param-row');
                    field.append(node('strong', '', key), node('span', '', String(value ?? '')));
                    list.append(field);
                }
                body.append(list);
            }
            return header.outerHTML + body.outerHTML;
        }

        function close(focus = true) {
            if (!editor || saving) return;
            const { dialog, returnFocus, creating } = editor;
            editor = null;
            dialog.close();
            dialog.remove();
            if (focus) {
                if (creating) host.redraw();
                const opener = returnFocus?.isConnected ? returnFocus : host.root.querySelector(creating
                    ? '[data-prompt-new],[data-hub-prompt-new]' : '[data-prompt-edit-start]');
                opener?.focus({ preventScroll: true });
            }
        }
        function showEditor(library, item, category) {
            if (!library || library.readonly || saving) return;
            close(false);
            const creating = !item;
            const dialog = node('dialog', 'asset-modal prompt-editor-dialog', null, document);
            dialog.id = 'promptEditorDialog';
            dialog.setAttribute('aria-labelledby', 'promptEditorTitle');
            const header = node('header', 'panel-head', null, document);
            const title = node('div', 'panel-title', null, document);
            const heading = node('strong', '', creating ? '新增提示词' : '编辑提示词', document);
            heading.id = 'promptEditorTitle';
            title.append(heading, node('span', '', library.name || '提示词模板库', document));
            header.append(title, button('prompt-edit-cancel', '', { classes: 'asset-icon-btn', icon: 'x',
                title: '关闭', ariaLabel: '关闭编辑', owner: document }));
            const body = node('div', 'inline-edit-form prompt-editor-body', null, document);
            const grid = node('div', 'prompt-editor-fields', null, document);
            const options = node('div', 'prompt-editor-options', null, document);
            const count = node('span', '', String(item?.positive || '').length + ' 字符', document);
            count.id = 'promptEditorCount';
            const inputs = {};
            for (const [key, id, caption, placeholder] of fields) {
                const label = node('label', key === 'positive' ? 'inline-edit-field prompt-editor-main' : 'inline-edit-field', null, document);
                const text = node('span', '', caption, document);
                const control = node(key === 'name' ? 'input' : 'textarea', '', null, document);
                control.id = id;
                control.placeholder = placeholder;
                if (key === 'name') control.type = 'text';
                if (key === 'positive' || key === 'negative') control.spellcheck = false;
                control.value = key === 'scene' ? description(item?.scene, item?.positive) : item?.[key] || '';
                if (key === 'positive') {
                    const captionRow = node('span', 'prompt-editor-label', null, document);
                    captionRow.append(text, count);
                    label.append(captionRow);
                } else label.append(text);
                label.append(control);
                inputs[key] = control;
                (key === 'name' ? body : key === 'positive' ? grid : options).append(label);
            }
            grid.append(options);
            body.append(grid);
            const footer = node('footer', 'prompt-editor-footer', null, document);
            const status = node('span', 'prompt-editor-status', 'Ctrl+Enter 保存', document);
            status.id = 'promptEditorStatus';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const actions = node('div', 'panel-actions', null, document);
            actions.append(button('prompt-edit-cancel', '取消', { classes: 'asset-btn', owner: document, plain: true }),
                button(creating ? 'prompt-create-save' : 'prompt-edit-save', '保存', {
                    value: item?.id, classes: 'asset-btn primary', icon: 'check', owner: document,
                }));
            footer.append(status, actions);
            dialog.append(header, body, footer);
            editor = {
                dialog, status, inputs, returnFocus: document.activeElement, creating, libraryId: library.id,
                itemId: item?.id, category: item?.category || category || 'custom', origin: host.origin(),
                originalScene: item?.scene ?? '', initialScene: inputs.scene.value,
            };
            if (creating) host.redraw();
            dialog.addEventListener('click', event => {
                if (event.target.closest('[data-prompt-edit-cancel]')) close();
                if (event.target.closest('[data-prompt-create-save],[data-prompt-edit-save]')) void save();
            });
            dialog.addEventListener('cancel', event => {
                event.preventDefault();
                close();
            });
            dialog.addEventListener('keydown', event => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    if (!event.repeat) void save();
                }
                if (event.key === 'Tab' && !saving) {
                    const controls = dialog.querySelectorAll('input,textarea,button');
                    const first = controls[0], last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            });
            inputs.positive.addEventListener('input', () => { count.textContent = inputs.positive.value.length + ' 字符'; });
            document.body.append(dialog);
            dialog.showModal();
            host.icons();
            (creating ? inputs.name : inputs.positive).focus();
        }
        function send(path, method, value) {
            const options = { method };
            if (value) {
                options.headers = { 'Content-Type': 'application/json' };
                options.body = JSON.stringify(value);
            }
            return host.request(endpoint + path, options);
        }
        async function save() {
            const current = editor;
            if (!current || saving || writing) return;
            const { creating, inputs, libraryId, itemId, category, originalScene, initialScene } = current;
            const values = Object.fromEntries(fields.map(([key]) => [key, inputs[key].value]));
            if (creating) values.positive = values.positive.trim() || values.scene.trim();
            if (!values.name.trim() || !values.positive.trim()) {
                report(creating ? '请输入名称和提示词内容' : '名称和正向提示词不能为空');
                return;
            }
            if (!creating && !values.scene && !initialScene) values.scene = originalScene;
            const controls = current.dialog.querySelectorAll('button,textarea,input');
            saving = true;
            controls.forEach(control => { control.disabled = true; });
            report('正在保存提示词...');
            try {
                const path = creating ? '' : '/' + encodeURIComponent(itemId);
                const result = await send(path, creating ? 'POST' : 'PATCH', { library_id: libraryId, ...values, category });
                host.saved(current, result);
                saving = false;
                close(host.origin() === current.origin);
                host.notice(creating ? '提示词已新增' : '提示词已保存');
            } catch (error) {
                report(error.message || '保存失败');
            } finally {
                saving = false;
                controls.forEach(control => { control.disabled = false; });
            }
        }
        async function toggleFavorite(library, item) {
            if (!library || !item || writing || saving) return;
            writing = true;
            try {
                const result = await send('/' + encodeURIComponent(item.id) + '/favorite', 'PATCH',
                    { library_id: library.id, favorite: !item.favorite });
                const favorite = result.item?.favorite ?? !item.favorite;
                host.favored(library.id, item.id, { ...result, item: result.item || { favorite } });
                host.notice(favorite ? '已收藏「' + (item.name || '提示词') + '」，可在「我的收藏」中查看' : '已取消收藏提示词');
            } catch (error) {
                host.notice(error.message || '收藏状态更新失败');
            } finally {
                writing = false;
            }
        }
        function canConfirm(libraryId, ids) {
            return confirmation === JSON.stringify([libraryId, [...ids].sort()]);
        }
        function clearConfirmation() { confirmation = null; }
        async function remove(library, ids, { batch = false } = {}) {
            if (!library || library.readonly || !ids.length || writing || saving) return;
            if (batch && !canConfirm(library.id, ids)) {
                confirmation = JSON.stringify([library.id, [...ids].sort()]);
                host.redraw();
                host.notice('再次点击确认删除所选提示词');
                return;
            }
            writing = true;
            try {
                const result = batch
                    ? await send('/delete', 'POST', { library_id: library.id, ids })
                    : await send('/' + encodeURIComponent(ids[0]) + '?' + new URLSearchParams({ library_id: library.id }), 'DELETE');
                clearConfirmation();
                host.removed(library.id, ids, result);
                host.notice(batch ? '已删除 ' + (result.removed ?? ids.length) + ' 条提示词' : '提示词已删除');
            } catch (error) {
                host.notice(error.message || '删除提示词失败');
            } finally {
                writing = false;
            }
        }
        function report(text) {
            if (editor) editor.status.textContent = text;
            host.notice(text);
        }

        return { row, detail, showEditor, close, toggleFavorite, canConfirm, clearConfirmation, remove,
            creating: () => Boolean(editor?.creating && editor.origin === host.origin()) };
    }

    global.XiaomeiAssetManagerPrompts = { create };
}(window));
