(function (root) {
    'use strict';

    const counter = '《计数》';
    const quickNumbers = [1, 2, 3, 4, 5, 6, 8, 10];
    const numberFields = new Set(['count', 'loopStart', 'imageBatchSize']);
    const blockElements = new Set(['DIV', 'P', 'LI']);
    const cleanText = value => String(value || '').trim();
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function readEditor(editor) {
        let text = '';
        function visit(element) {
            if (element.nodeType === root.Node.TEXT_NODE) {
                text += element.data;
                return;
            }
            if (element.nodeType !== root.Node.ELEMENT_NODE) return;
            if (element.classList.contains('loop-smart-token-chip')) {
                text += element.dataset.token || '';
                return;
            }
            if (element.tagName === 'BR') {
                text += '\n';
                return;
            }
            const block = blockElements.has(element.tagName);
            if (block && text && !text.endsWith('\n')) text += '\n';
            const start = text.length;
            for (const child of element.childNodes) visit(child);
            if (block && (text.length === start || !text.endsWith('\n'))) text += '\n';
        }
        for (const child of editor.childNodes) visit(child);
        return text.replaceAll('\u00a0', ' ');
    }

    function insert(editor, content) {
        const doc = editor.ownerDocument;
        const selection = doc.getSelection();
        let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !editor.contains(range.commonAncestorContainer)) {
            range = doc.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
        }
        const last = content.nodeType === root.Node.DOCUMENT_FRAGMENT_NODE ? content.lastChild : content;
        editor.focus({ preventScroll: true });
        range.deleteContents();
        range.insertNode(content);
        range.setStartAfter(last);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    function create(host) {
        const escape = host.escape;

        function numberMarkup({ label, value, key, max = 100, suffix = '' }) {
            const current = clamp(Number(value) || 1, 1, max);
            const openLabel = escape(host.label('smart.loopNumberOpen'));
            const customLabel = escape(host.label('common.custom'));
            const buttons = quickNumbers.map(n =>
                `<button type="button" class="loop-smart-control loop-number-cell ${n === current ? 'active' : ''}" data-loop-number="${escape(key)}" data-loop-value="${n}">${n}</button>`).join('');
            const unit = suffix ? `<em>${escape(suffix)}</em>` : '';
            return `<div class="loop-number-control">
                <button class="loop-smart-control loop-number-trigger" type="button" aria-expanded="false" title="${openLabel}"><span class="loop-number-label">${escape(label)}</span><strong>${current}</strong>${unit}<span class="loop-number-chevron" aria-hidden="true">⌄</span></button>
                <div class="loop-number-popover">
                    <div class="loop-number-grid">${buttons}</div>
                    <label class="loop-number-custom"><span>${customLabel}</span><input class="loop-smart-control loop-number-input" type="number" min="1" max="${max}" step="1" data-loop-number-input="${escape(key)}" value="${current}"></label>
                </div>
            </div>`;
        }

        function chipMarkup(token) {
            const label = token === counter ? host.label('smart.loopImageIndexShort') : token;
            const remove = escape(host.label('common.delete'));
            return `<span class="loop-smart-token-chip" contenteditable="false" data-token="${escape(token)}"><span>${escape(label)}</span><button type="button" aria-label="${remove}" title="${remove}">×</button></span>`;
        }

        function markup(text) {
            const parts = String(text ?? '').split(/(《计数》|\[计数\])/g);
            return parts.map((part, index) => index % 2 ? chipMarkup(counter) : escape(part)).join('');
        }

        function fields(node) {
            if (Array.isArray(node?.variablePrompts) && node.variablePrompts.length) return node.variablePrompts.map(cleanText);
            const legacy = cleanText(node?.variablePrompt);
            if (!legacy) return [];
            return host.paired(node) ? [legacy] : host.splitLegacy(legacy);
        }

        function writeFields(node, values) {
            if (node?.type !== 'smart-loop') return;
            const prompts = (values || []).map(cleanText);
            node.variablePrompts = prompts.length ? prompts : [''];
            node.variablePrompt = prompts.filter(Boolean).join('\n');
        }

        function expandTokens(text, index, total) {
            const tokens = new Map([
                [counter, index], ['[计数]', index], ['[' + host.label('canvas.counterToken') + ']', index],
                ['《总数》', total], ['[总数]', total],
                ['《进度》', index + '/' + total], ['[进度]', index + '/' + total]
            ]);
            return text.replace(/《(?:计数|总数|进度)》|\[[^\[\]\r\n]*\]/g, token => tokens.get(token) ?? token).trim();
        }

        function bindNumber(card, node, control) {
            const input = control.querySelector('[data-loop-number-input]');
            const trigger = control.querySelector('.loop-number-trigger');
            const display = trigger.querySelector('strong');
            const buttons = [...control.querySelectorAll('[data-loop-value]')];
            const key = input.dataset.loopNumberInput;
            if (!numberFields.has(key)) return;
            const update = (raw, commit) => {
                if (!host.canEdit(node)) {
                    input.value = String(node[key]);
                    return;
                }
                if (!Number.isFinite(raw) && !commit) return;
                const next = Number.isFinite(raw) ? clamp(Math.trunc(raw), Number(input.min), Number(input.max)) : node[key];
                const changed = node[key] !== next;
                node[key] = next;
                display.textContent = next;
                for (const button of buttons) button.classList.toggle('active', Number(button.dataset.loopValue) === next);
                if (commit) input.value = String(next);
                if (changed || commit) host.changed(node, { render: commit });
            };
            trigger.onclick = event => {
                event.preventDefault();
                const open = !control.classList.contains('is-open');
                for (const other of card.ownerDocument.querySelectorAll('.loop-number-control.is-open')) {
                    other.classList.remove('is-open');
                    other.querySelector('.loop-number-trigger')?.setAttribute('aria-expanded', 'false');
                }
                control.classList.toggle('is-open', open);
                trigger.setAttribute('aria-expanded', String(open));
            };
            for (const button of buttons) {
                button.onclick = event => {
                    event.preventDefault();
                    update(Number(button.dataset.loopValue), true);
                };
            }
            input.oninput = event => {
                event.stopPropagation();
                update(input.valueAsNumber, false);
            };
            input.onchange = event => {
                event.stopPropagation();
                update(input.valueAsNumber, true);
            };
        }

        function bind(card, node) {
            for (const control of card.querySelectorAll('.loop-number-control')) bindNumber(card, node, control);
            const editors = [...card.querySelectorAll('[data-loop-prompt-index]')]
                .sort((a, b) => Number(a.dataset.loopPromptIndex) - Number(b.dataset.loopPromptIndex));
            let activeEditor = editors[0];
            function syncEditors() {
                if (!editors.length) return fields(node);
                const values = editors.map(readEditor);
                if (Array.isArray(node.aiSplitPrompts)) {
                    const existing = node.aiSplitPrompts;
                    node.aiSplitPrompts = values.map((prompt, i) => ({
                        ...(typeof existing[i] === 'object' ? existing[i] : {}), prompt
                    }));
                }
                writeFields(node, values);
                return fields(node);
            }

            function bindActions(selector, action) {
                for (const button of card.querySelectorAll(selector)) {
                    button.onclick = event => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (host.canEdit(node)) action(button);
                    };
                }
            }

            bindActions('[data-loop-mode]', button => {
                node.mode = button.dataset.loopMode === 'parallel' ? 'parallel' : 'serial';
                host.changed(node);
            });
            bindActions('[data-loop-toggle]', button => {
                if (button.dataset.loopToggle === 'image') {
                    node.imageInput = !node.imageInput;
                } else {
                    node.showPrompt = !node.showPrompt;
                    if (node.showPrompt && !host.hasUpstreamPrompt(node) && !fields(node).some(Boolean)) {
                        writeFields(node, [host.defaultPrompt()]);
                    }
                }
                host.changed(node, { fit: true });
            });

            for (const editor of editors) {
                host.scroll(editor);
                editor.onfocus = () => { activeEditor = editor; };
                editor.addEventListener('beforeinput', event => {
                    if (!host.canEdit(node)) event.preventDefault();
                });
                editor.oninput = () => {
                    if (!host.canEdit(node)) return;
                    syncEditors();
                    host.changed(node, { render: false });
                };
                editor.addEventListener('paste', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    const value = event.clipboardData?.getData('text/plain');
                    if (!value || !host.canEdit(node)) return;
                    insert(editor, editor.ownerDocument.createTextNode(value.replace(/\r\n?/g, '\n')));
                    syncEditors();
                    host.changed(node, { render: false });
                });
                editor.addEventListener('click', event => {
                    const remove = event.target.closest('.loop-smart-token-chip button');
                    if (!remove) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!host.canEdit(node)) return;
                    remove.closest('.loop-smart-token-chip').remove();
                    syncEditors();
                    host.changed(node, { render: false });
                });
            }
            bindActions('[data-loop-prompt-add]', () => {
                const values = syncEditors();
                writeFields(node, [...values, '']);
                if (Array.isArray(node.aiSplitPrompts)) {
                    node.aiSplitPrompts.push({ title: '第 ' + (node.aiSplitPrompts.length + 1) + ' 屏', source: '', prompt: '' });
                }
                host.changed(node, { fit: true });
            });
            bindActions('[data-loop-prompt-delete]', button => {
                const values = syncEditors();
                const index = Number(button.dataset.loopPromptDelete);
                if (values.length <= 1 || !Number.isInteger(index) || index < 0 || index >= values.length) return;
                writeFields(node, values.filter((_, i) => i !== index));
                if (Array.isArray(node.aiSplitPrompts)) node.aiSplitPrompts.splice(index, 1);
                host.changed(node, { fit: true });
            });
            for (const button of card.querySelectorAll('[data-loop-token]')) {
                button.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
            }
            bindActions('[data-loop-token]', button => {
                if (!activeEditor || !card.contains(activeEditor)) return;
                const doc = card.ownerDocument;
                const template = doc.createElement('template');
                template.innerHTML = chipMarkup(button.dataset.loopToken || counter);
                template.content.append(doc.createTextNode(' '));
                insert(activeEditor, template.content);
                syncEditors();
                host.changed(node, { render: false });
            });
            bindActions('[data-loop-switch-advanced]', () => {
                node.batchUiMode = 'advanced';
                node.batchAdvancedReturnMode = 'paired';
                host.changed(node, { fit: true });
            });
            bindActions('[data-loop-switch-paired]', () => {
                syncEditors();
                node.batchUiMode = 'paired';
                delete node.batchAdvancedReturnMode;
                host.syncPaired(node);
                host.changed(node, { fit: true });
            });
        }

        return { bind, fields, writeFields, markup, numberMarkup, expandTokens };
    }

    root.XiaomeiSmartLoopEditor = { create };
})(window);
