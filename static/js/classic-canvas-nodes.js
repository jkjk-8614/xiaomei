(function (root) {
    'use strict';

    const inputTypes = new Set(['generator', 'comfy', 'ltxDirector', 'output', 'llm', 'video', 'rh']);
    const promptLimit = 20000;
    const outputOnlyTypes = new Set(['image', 'prompt', 'group', 'promptGroup']);
    const isGroup = node => node.type === 'group' || node.type === 'promptGroup';

    function create(layer, { build, patch, hasLiveMedia, moveMedia, scope }) {
        const restoring = new WeakMap();
        let documentId;

        function scrollArea(card) {
            if (card?.classList.contains('output-node')) return card.querySelector('.node-body');
            return card?.querySelector('.llm-chat-log');
        }

        function readScroll(card) {
            const area = scrollArea(card);
            if (!area) return null;
            return restoring.get(area) || {
                top: area.scrollTop,
                left: area.scrollLeft,
                chat: area.classList.contains('llm-chat-log'),
                follow: area.scrollHeight - area.scrollTop - area.clientHeight < 12,
            };
        }

        function restoreScroll(card, position) {
            const area = scrollArea(card);
            if (!area || !position || area.classList.contains('llm-chat-log') !== position.chat) return;
            restoring.set(area, position);
            root.requestAnimationFrame(() => {
                if (restoring.get(area) !== position) return;
                restoring.delete(area);
                if (!layer.contains(area)) return;
                area.scrollTop = position.chat && position.follow ? area.scrollHeight : position.top;
                area.scrollLeft = position.left;
            });
        }
        function element(id) {
            return layer.querySelector(`.node[data-id="${root.CSS.escape(id)}"]`);
        }

        function paint(nodes, ids) {
            const current = new Map(Array.from(layer.children, card => [card.dataset.id, card]));
            const nextId = scope();
            const sameDocument = documentId === nextId;
            const requested = sameDocument && ids && new Set(ids);
            const changed = requested && nodes.filter(node => requested.has(node.id));
            const limited = changed && changed.every(node => current.has(node.id));
            const visible = limited ? changed : nodes;
            const positions = new Map();
            if (sameDocument) {
                for (const { id } of visible) {
                    const position = readScroll(current.get(id));
                    if (position) positions.set(id, position);
                }
            }
            documentId = nextId;
            if (!limited) {
                const active = new Set(nodes.map(node => node.id));
                for (const [id, card] of current) {
                    if (sameDocument && active.has(id) && hasLiveMedia(card)) continue;
                    card.remove();
                    current.delete(id);
                }
            }

            for (const node of visible) {
                const previous = current.get(node.id);
                const position = positions.get(node.id);
                if (limited && patch(node)) {
                    restoreScroll(previous, position);
                    continue;
                }
                try {
                    const card = build(node);
                    if (limited) previous.after(card);
                    else layer.append(card);
                    if (previous) {
                        if (hasLiveMedia(previous)) moveMedia(previous, card);
                        previous.remove();
                    }
                    restoreScroll(card, position);
                } catch (error) {
                    console.error('[canvas] Node rendering failed', node.id, node.type, error);
                }
            }
        }

        function beginMove(node, pointer, nodes, selection) {
            const records = Object.create(null);
            const byId = new Map();
            for (const item of nodes) {
                records[item.id] = { id: item.id, x: item.x, y: item.y, items: item.items, group: isGroup(item) };
                byId.set(item.id, item);
            }
            const companions = root.XiaomeiNodeKernel.dragCompanions(records, records[node.id], [...selection]);
            const members = [{ node, x: node.x, y: node.y }];
            for (const item of companions) {
                members.push({ node: byId.get(item.id), x: item.originX, y: item.originY });
            }
            return { pointer, members };
        }

        function move(gesture, pointer, scale) {
            const delta = root.XiaomeiNodeKernel.worldDelta(pointer, gesture.pointer, scale);
            for (const member of gesture.members) {
                Object.assign(member.node, root.XiaomeiNodeKernel.shiftPoint(member.x, member.y, delta.x, delta.y));
                const card = element(member.node.id);
                if (card) root.XiaomeiViewportKernel.writeRawOrigin(card, member.node.x, member.node.y);
            }
        }

        function beginResize(node, pointer, scale, size) {
            const rect = element(node.id)?.getBoundingClientRect();
            return {
                node,
                pointer,
                width: rect?.width ? rect.width / scale : node.w || size.w,
                height: rect?.height ? rect.height / scale : node.h || size.h || 160,
                minWidth: Math.min(size.w, 220),
            };
        }

        function resize(gesture, pointer, scale) {
            const { node } = gesture;
            const delta = root.XiaomeiNodeKernel.worldDelta(pointer, gesture.pointer, scale);
            node.w = Math.round(Math.max(gesture.minWidth, gesture.width + delta.x));
            node.h = Math.round(Math.max(96, gesture.height + delta.y));
            const card = element(node.id);
            if (!card) return;
            card.classList.add('sized');
            card.style.width = `${node.w}px`;
            card.style.height = `${node.h}px`;
        }

        return { element, paint, beginMove, move, beginResize, resize };
    }

    function attach(card, node, { label, control, drag, resize, link, previewGroup }) {
        const hasInput = inputTypes.has(node.type) || (node.type === 'loop' && (node.imageInput || node.showPrompt));
        root.XiaomeiCanvasSurface.attachClassicPorts(card, {
            input: hasInput,
            output: inputTypes.has(node.type) || outputOnlyTypes.has(node.type) || node.type === 'loop',
            inputTitle: label('canvas.connectHere'),
            outputTitle: label('canvas.dragConnect'),
            resizeTitle: label('canvas.resize'),
        });
        const stop = event => event.stopPropagation();
        for (const field of card.querySelectorAll('button, select, textarea, input')) {
            field.addEventListener('mousedown', stop, true);
            field.addEventListener('click', stop);
        }
        card.addEventListener('mousedown', event => {
            if (event.button !== 0 || control(event.target)) return;
            const port = event.target.closest('.port');
            const handle = event.target.closest('.resize-handle');
            if (port || handle) {
                if (event.shiftKey) return;
                if (port) link(event, node.id, port.classList.contains('in') ? 'in' : 'out');
                else resize(event, node);
                return;
            }
            if (event.target.closest('.output-img-wrap')) return;
            if (event.detail >= 2 && node.type === 'group' && event.target.closest('.node-head') && previewGroup(event, node)) return;
            drag(event, node);
        });
        card.addEventListener('dragstart', event => {
            event.preventDefault();
            stop(event);
        });
    }

    function paintPrompt(body, node, { label, active, openLibrary, onInput }) {
        const document = body.ownerDocument;
        const editor = document.createElement('div');
        editor.className = 'prompt-editor';
        const toolbar = document.createElement('div');
        toolbar.className = 'prompt-toolbar';
        const library = document.createElement('button');
        library.type = 'button';
        library.className = 'prompt-template-btn';
        library.classList.toggle('active', active);
        library.dataset.promptTemplateOpen = '';
        library.dataset.promptTemplateNodeId = node.id;
        library.setAttribute('aria-pressed', String(active));
        library.title = label('canvas.promptTemplateLibrary');
        const icon = document.createElement('i');
        icon.dataset.lucide = 'library';
        const caption = document.createElement('span');
        caption.textContent = label('canvas.promptTemplateShort');
        library.append(icon, caption);
        library.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openLibrary(node.id);
        });
        const counter = document.createElement('div');
        counter.className = 'prompt-counter';
        const length = document.createElement('span');
        const maximum = document.createElement('span');
        maximum.textContent = '/ ' + promptLimit.toLocaleString();
        counter.append(length, maximum);
        toolbar.append(library, counter);
        const text = document.createElement('textarea');
        text.placeholder = label('canvas.promptPlaceholder');
        text.value = node.text || '';
        function updateCounter() {
            const count = Array.from(text.value).length;
            length.textContent = count.toLocaleString();
            counter.classList.toggle('over', count > promptLimit);
        }
        updateCounter();
        text.addEventListener('input', () => {
            updateCounter();
            onInput(text.value);
        });
        text.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        editor.append(toolbar, text);
        body.replaceChildren(editor);
    }

    function paintMedia(body, node, media, actions) {
        const document = body.ownerDocument;
        const dropTarget = document.createElement('div');
        dropTarget.addEventListener('dragover', event => actions.dragOver(event, dropTarget));
        dropTarget.addEventListener('dragleave', event => {
            event.stopPropagation();
            dropTarget.classList.remove('drag-over');
        });
        dropTarget.addEventListener('drop', event => actions.drop(event, node.id, dropTarget));
        if (!node.url) {
            dropTarget.className = 'blank-image';
            const icon = document.createElement('i');
            icon.dataset.lucide = 'image-plus';
            icon.className = 'w-7 h-7';
            const label = document.createElement('div');
            label.className = 'text-[11px] font-bold';
            label.textContent = media.emptyLabel;
            dropTarget.append(icon, label);
            dropTarget.addEventListener('click', () => actions.pick(node.id));
            body.replaceChildren(dropTarget);
            return;
        }

        dropTarget.className = 'image-preview-wrap';
        dropTarget.append(media.preview);
        const caption = document.createElement('div');
        caption.className = 'image-caption text-[11px] text-gray-400 truncate';
        caption.textContent = media.caption;
        body.replaceChildren(dropTarget, caption);
        const image = dropTarget.querySelector('img');
        const play = dropTarget.querySelector('.canvas-video-play');
        function stop(event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        function open(event) {
            if (media.missing) return;
            stop(event);
            actions.preview(node.id, media.kind, event.shiftKey || event.altKey);
        }
        body.addEventListener('mousedown', event => {
            if (event.detail >= 2) open(event);
            else actions.drag(event, node);
        });
        body.addEventListener('dblclick', open, true);
        body.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            actions.menu(node.id, event.clientX, event.clientY);
        });
        if (image && media.kind === 'image') {
            image.addEventListener('mousedown', event => {
                if (event.detail >= 2) open(event);
            }, true);
        }
        if (image && media.kind === 'video') {
            image.addEventListener('mousedown', event => {
                if (event.button === 0) stop(event);
            }, true);
            image.addEventListener('click', event => {
                stop(event);
                actions.play(image);
            }, true);
            play?.addEventListener('mousedown', stop, true);
            play?.addEventListener('click', event => {
                stop(event);
                actions.play(play.closest('.media-card,.image-preview-wrap') || image);
            }, true);
        }
        if (image?.complete && image.naturalHeight > 0) root.requestAnimationFrame(actions.geometry);
        else image?.addEventListener('load', actions.loaded);
    }

    root.XiaomeiClassicNodes = { create, attach, paintPrompt, paintMedia };
}(window));
