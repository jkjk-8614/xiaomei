(function (root) {
    'use strict';

    const tokenSelector = '.mention-image-token';
    const blocks = new Set(['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE']);
    const labels = { audio: '音频', video: '视频' };
    const mentionName = (item, kind) => item.alias || item.name || labels[kind] || '图片';

    function savedUris(value) {
        try {
            return JSON.parse(value || '{}') || {};
        } catch {
            return {};
        }
    }

    function parts(editor) {
        const result = [];
        const addText = text => { if (text) result.push({ type: 'text', text }); };
        function visit(node) {
            if (node.nodeType === root.Node.TEXT_NODE) {
                addText(node.data);
                return;
            }
            if (node.nodeType !== root.Node.ELEMENT_NODE) return;
            if (node.matches(tokenSelector)) {
                const { url, name, nodeId, imageIndex, assetUris } = node.dataset;
                const kind = node.dataset.kind || 'image';
                result.push({
                    type: 'image', kind, url: url || '', name: name || (kind === 'audio' ? '音频' : '图片'),
                    nodeId: nodeId || '', imageIndex: Number(imageIndex || 0), asset_uris: savedUris(assetUris),
                });
                return;
            }
            if (node.tagName === 'BR') {
                addText('\n');
                return;
            }
            const block = blocks.has(node.tagName);
            const previous = result.at(-1)?.text;
            if (block && previous && !previous.endsWith('\n')) addText('\n');
            for (const child of node.childNodes) visit(child);
            if (block) addText('\n');
        }
        for (const child of editor.childNodes) visit(child);
        return result;
    }

    function originalText(parts) {
        return (parts || []).map(part => {
            if (part.type === 'text') return part.text || '';
            return part.type === 'image' ? '@' + (part.name || '图片') : '';
        }).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function create(editor, host) {
        const document = editor.ownerDocument;
        const selection = () => document.getSelection();
        let saved;

        const within = range => range && editor.contains(range.startContainer) && editor.contains(range.endContainer);
        function liveRange() {
            const current = selection();
            const range = current?.rangeCount ? current.getRangeAt(0) : null;
            return within(range) ? range : null;
        }
        function endRange() {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            return range;
        }
        function select(range) {
            const current = selection();
            if (!current) return;
            current.removeAllRanges();
            current.addRange(range);
        }
        function remember() {
            const range = liveRange();
            if (range) saved = { range: range.cloneRange(), scope: host.scope() };
        }
        function rememberedRange() {
            return saved?.scope === host.scope() && within(saved?.range) ? saved.range.cloneRange() : null;
        }
        function restoreCaret() {
            const range = rememberedRange() || endRange();
            editor.focus({ preventScroll: true });
            select(range);
        }
        function caretToEnd() {
            editor.focus();
            select(endRange());
            remember();
        }
        function beforeCaret() {
            const current = selection();
            if (!current?.anchorNode || !editor.contains(current.anchorNode)) return '';
            const prefix = document.createRange();
            prefix.selectNodeContents(editor);
            prefix.setEnd(current.anchorNode, current.anchorOffset);
            return prefix.toString();
        }
        function caretRect() {
            const range = liveRange();
            return range?.getClientRects()[0] || range?.getBoundingClientRect() || null;
        }

        const notify = () => editor.dispatchEvent(new root.Event('input', { bubbles: true }));
        function insertText(value) {
            const text = String(value ?? '').replace(/\r\n?/g, '\n');
            if (!text) return;
            editor.focus();
            const range = liveRange() || endRange();
            const node = document.createTextNode(text);
            range.deleteContents();
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            select(range);
            notify();
        }

        function createToken(item) {
            const kind = host.kind(item);
            const name = mentionName(item, kind);
            const token = document.createElement('span');
            token.className = 'mention-image-token';
            token.contentEditable = 'false';
            Object.assign(token.dataset, {
                url: item.url, kind, name, nodeId: item.nodeId || '',
                imageIndex: String(item.imageIndex ?? ''), assetUris: JSON.stringify(item.asset_uris || {}),
            });
            token.innerHTML = host.media(item, kind);
            const label = document.createElement('span');
            label.textContent = name;
            token.append(label);
            return token;
        }

        function includeTrigger(range) {
            let node = range.startContainer;
            let offset = range.startOffset;
            if (node.nodeType === root.Node.ELEMENT_NODE && offset > 0) {
                node = node.childNodes[offset - 1];
                while (node?.nodeType === root.Node.ELEMENT_NODE && !node.matches(tokenSelector)) node = node.lastChild;
                offset = node?.length || 0;
            }
            if (node?.nodeType === root.Node.TEXT_NODE && /[@＠]/.test(node.data.charAt(offset - 1))) {
                range.setStart(node, offset - 1);
            }
        }

        function insertReference(item) {
            if (!item?.url) return;
            const remembered = rememberedRange();
            editor.focus();
            const range = remembered || liveRange() || endRange();
            includeTrigger(range);
            const token = createToken(item);
            const space = document.createTextNode(' ');
            const fragment = document.createDocumentFragment();
            fragment.append(token, space);
            range.deleteContents();
            range.insertNode(fragment);
            range.setStartAfter(space);
            range.collapse(true);
            select(range);
            host.bindMedia(token);
            notify();
        }

        function tokenAt(node) {
            const element = node?.nodeType === root.Node.ELEMENT_NODE ? node : node?.parentElement;
            const token = element?.closest(tokenSelector);
            return token && editor.contains(token) ? token : null;
        }
        function beside(token, before) {
            const range = document.createRange();
            const next = token.nextSibling;
            if (before) range.setStartBefore(token);
            else if (next?.nodeType === root.Node.TEXT_NODE && next.length) range.setStart(next, 0);
            else range.setStartAfter(token);
            range.collapse(true);
            select(range);
        }
        function handleKey(event) {
            if (editor.dataset.promptLocked === '1') return false;
            const caret = liveRange();
            const token = caret?.collapsed ? tokenAt(caret.startContainer) : null;
            if (!token) return false;
            if (event.key === 'Backspace' || event.key === 'Delete') {
                event.preventDefault();
                const range = document.createRange();
                range.setStartBefore(token);
                range.setEndAfter(token);
                range.deleteContents();
                select(range);
                notify();
                return true;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                beside(token, event.key === 'ArrowLeft');
                return true;
            }
            return false;
        }
        editor.addEventListener('mousedown', event => {
            const token = tokenAt(event.target);
            if (!token || editor.dataset.promptLocked === '1') return;
            event.preventDefault();
            editor.focus();
            const { left, width } = token.getBoundingClientRect();
            beside(token, event.clientX < left + width / 2);
        });

        return {
            parts: () => parts(editor), beforeCaret, caretToEnd, caretRect, remember, restoreCaret,
            insertText, insertReference, handleKey,
            referenceHtml: item => item?.url ? createToken(item).outerHTML : '',
        };
    }

    root.XiaomeiSmartPromptContent = { create, originalText };
})(window);
