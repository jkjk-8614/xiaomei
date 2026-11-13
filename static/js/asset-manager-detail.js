(function (global) {
    'use strict';

    function create({ request, resolve, visible, redraw, notice, thumbnail, kind, label, date, classification, avatar }) {
        const dom = global.document.createElement('template').content.ownerDocument;
        const pending = new Map();
        let draft = null;

        function element(tag, classes, text) {
            const node = dom.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        }
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function action(hook, id, glyph, { text, title, classes = 'asset-icon-btn', disabled = false } = {}) {
            const button = element('button', classes);
            button.type = 'button';
            button.setAttribute('data-asset-' + hook, id);
            button.disabled = disabled;
            if (title) button.title = title;
            if (glyph) button.append(icon(glyph));
            if (text) button.append(element('span', '', text));
            return button;
        }
        function appendMarkup(parent, html) {
            const fragment = dom.createElement('template');
            fragment.innerHTML = html;
            parent.append(fragment.content);
        }
        function header(title, subtitle, controls) {
            const section = element('div', 'panel-head');
            const heading = element('div', 'panel-title');
            heading.append(element('strong', '', title), element('span', '', subtitle));
            section.append(heading);
            if (controls.length) {
                const actions = element('div', 'panel-actions');
                actions.append(...controls);
                section.append(actions);
            }
            return section;
        }
        function metadata(fields) {
            const grid = element('div', 'detail-meta-grid');
            for (const [name, value] of fields) {
                const field = element('div', 'detail-meta');
                field.append(element('span', '', name), element('strong', '', value));
                grid.append(field);
            }
            return grid;
        }
        function processingNote(info) {
            const device = info.device || 'CPU';
            const gpu = info.device_is_gpu || /nvidia|geforce|rtx|gtx|radeon|amd|arc|graphics|cuda/i.test(device);
            const note = element('div', 'detail-processing-note');
            const text = [info.model_name || '本地抠图', device, ...(gpu ? ['GPU'] : []), '主体已自动居中', '原图保留'];
            note.append(icon('eraser'), element('span', '', text.join(' · ')));
            return note;
        }
        const keyFor = ({libraryId, categoryId, item}) => JSON.stringify([libraryId, categoryId, item.id, item.url]);

        function view(record, {confirmDelete, removingBackground}) {
            const scroll = element('div', 'detail-scroll');
            if (!record) {
                draft = null;
                const empty = element('div', 'detail-empty');
                empty.append(icon('image'), element('span', '', '暂无可预览素材'));
                scroll.append(empty);
                return header('素材预览', '选择一个素材查看详情', []).outerHTML + scroll.outerHTML;
            }
            const {item, libraryId, libraryName, categoryName} = record;
            const key = keyFor(record);
            if (draft?.key !== key) draft = null;
            const editing = draft?.explicit === true;
            const isImage = kind(item) === 'image';
            const type = label(item);
            const controls = [];
            if (editing) {
                controls.push(action('edit-save', item.id, 'check', { text: '保存', classes: 'asset-btn primary', disabled: pending.has(key) }),
                    action('edit-cancel', '', 'x', { title: '取消' }));
            } else {
                controls.push(action('download', item.id, 'download', { title: '下载素材' }));
                if (isImage) controls.push(action('background-remove', item.id, 'eraser', {
                    title: '去背景，生成透明底', disabled: removingBackground,
                }));
                controls.push(action('edit-start', item.id, 'pencil', { title: '编辑' }),
                    action('delete', item.id, 'trash-2', {
                        title: confirmDelete ? '再次点击确认移入回收站' : '移入回收站',
                        classes: confirmDelete ? 'asset-icon-btn danger detail-confirm' : 'asset-icon-btn danger',
                    }));
            }
            const media = element('div', 'detail-media');
            const preview = action('preview', item.id, '', { classes: 'detail-media-frame detail-media-zoomable', title: '点击放大预览' });
            appendMarkup(preview, thumbnail(item));
            media.append(preview);
            const body = element('div', editing ? 'inline-edit-form' : 'detail-body');
            const input = element('input', editing ? '' : 'detail-name-input');
            input.type = 'text';
            input.dataset.assetNameDraft = key;
            input.defaultValue = draft?.text ?? (item.name || (editing ? '' : 'asset'));
            if (editing) {
                input.id = 'assetEditName';
                input.placeholder = '素材名称';
                const field = element('label', 'inline-edit-field');
                field.append(element('span', '', '素材名称'), input);
                body.append(field);
            } else {
                input.dataset.assetInlineName = item.id;
                input.title = '直接修改名称';
                body.append(input);
            }
            const fields = [['类型', type], ['创建时间', date(item.created_at)]];
            if (!editing) fields.push(['资产库', libraryName], ['分组', categoryName]);
            body.append(metadata(fields), element('div', 'detail-url', item.url || ''));
            if (!editing) {
                if (item.background_removal) body.append(processingNote(item.background_removal));
                if (isImage) appendMarkup(body, classification(item));
                appendMarkup(body, avatar(libraryId, record.categoryId, item));
            }
            scroll.append(media, body);
            const head = editing ? header('编辑素材', '当前分组内直接保存', controls) : header('素材预览', type, controls);
            return head.outerHTML + scroll.outerHTML;
        }
        function start(record) {
            if (!record) return;
            const key = keyFor(record);
            draft = {key, explicit: true, text: draft?.key === key ? draft.text : record.item.name || ''};
            redraw();
        }
        function clear() { draft = null; }
        function input(control) {
            const key = control?.dataset.assetNameDraft;
            if (key) draft = {key, explicit: control.id === 'assetEditName', text: control.value};
        }
        async function save(record, explicit) {
            if (!record || !draft || draft.key !== keyFor(record) || draft.explicit !== explicit) return;
            const edit = draft;
            const {item, libraryId, categoryId} = record;
            const name = edit.text.trim();
            if (!name) {
                notice('素材名称不能为空');
                return;
            }
            const active = pending.get(edit.key);
            if (active) {
                if (!explicit) active.next = edit;
                return;
            }
            if (!explicit && name === item.name) {
                clear();
                return;
            }
            const owner = {libraryId, categoryId, id: item.id, url: item.url};
            const operation = {next: null};
            const oldName = item.name;
            pending.set(edit.key, operation);
            if (explicit) redraw();
            try {
                const reply = await request('/api/asset-library/items/' + encodeURIComponent(owner.id), {
                    method: 'PATCH', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name, library_id: libraryId, category_id: categoryId, source_url: owner.url}),
                });
                const stored = resolve(owner);
                if (stored && stored.name === oldName && reply.item?.url === owner.url) stored.name = reply.item.name;
                if (draft === edit) clear();
                if (visible(owner)) notice(explicit ? '素材已保存' : '素材名称已保存');
            } catch (error) {
                if (visible(owner)) notice(error.message || '保存失败');
            } finally {
                pending.delete(edit.key);
                if (visible(owner)) {
                    if (operation.next && operation.next === draft) await save(record, false);
                    else redraw();
                }
            }
        }
        return {view, start, clear, input, save};
    }

    global.XiaomeiAssetManagerDetail = {create};
}(window));
