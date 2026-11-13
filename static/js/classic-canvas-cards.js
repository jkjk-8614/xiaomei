(function (root) {
    'use strict';

    const defaults = {
        image: { w: 260, h: 336, offset: -120 },
        prompt: { w: 310, h: 0, offset: 0 },
        loop: { w: 336, h: 0, offset: 40 },
        group: { w: 260, h: 0, offset: 40 },
        llm: { w: 420, h: 590, offset: 80 },
        generator: { w: 380, h: 0, offset: 120 },
        video: { w: 400, h: 0, offset: 160 },
        rh: { w: 430, h: 0, offset: 180 },
        comfy: { w: 420, h: 460, offset: 160 },
        ltxDirector: { w: 1000, h: 800, offset: 200 },
        output: { w: 460, h: 0, offset: 260 },
    };
    const generatorTypes = ['generator', 'msgen', 'comfy', 'ltxDirector', 'video', 'rh'];
    const imageOutputTypes = generatorTypes.filter(type => type !== 'video');
    const statusTypes = new Set([...generatorTypes, 'llm']);
    const controls = [
        'textarea, input, select, option, button, audio, video, [contenteditable="true"]',
        '.seg, .gen-btn, .comfy-run, .input-item, .blank-image, .mode-tabs, .ms-model-tabs',
        '.llm-provider, .llm-output, .llm-chat-log, .llm-bubble, .llm-pane-resizer, .loop-preview, .ltx-director-timeline-host',
    ].join(', ');
    const currentType = type => type === 'msgen' ? 'generator' : type;
    function size(type) {
        const key = currentType(type);
        return Object.hasOwn(defaults, key) ? defaults[key] : defaults.group;
    }
    const control = element => Boolean(element.closest(controls));

    function create(host) {
        const surface = root.XiaomeiCanvasSurface;
        const nodes = root.XiaomeiClassicNodes;
        const document = root.document;
        const catalog = {
            label: host.label,
            generatorTypes,
            imageOutputTypes,
            titleFor: node => node.type === 'image' && node.url ? host.media.title(node) : '',
        };

        function element(tag, className, text) {
            const item = document.createElement(tag);
            if (className) item.className = className;
            if (text != null) item.textContent = text;
            return item;
        }

        function markup(html) {
            const template = element('template');
            template.innerHTML = html;
            return template.content;
        }

        function mediaView(node) {
            if (!node.url) return { emptyLabel: host.label('canvas.clickDragPasteImage') };
            const { kind, title, missing, missingMarkup, video, image } = host.media;
            const type = kind(node);
            const unavailable = missing(node.url);
            const name = node.name || 'image';
            const caption = unavailable ? name + ' · ' + host.media.missingLabel() : name;
            let preview;

            if (unavailable) {
                preview = markup(missingMarkup(node.url));
            } else if (type === 'video') {
                preview = element('div', 'media-card video-card');
                const play = element('button', 'canvas-video-play');
                play.type = 'button';
                play.title = '播放';
                const icon = element('i');
                icon.dataset.lucide = 'play';
                play.append(icon);
                preview.append(markup(video(node.url, 768, 'draggable="false" data-preview-controls')), play);
            } else if (type === 'audio') {
                preview = element('div', 'media-card audio-card');
                const icon = element('i', 'w-8 h-8');
                icon.dataset.lucide = 'file-audio';
                const player = element('audio');
                player.src = node.url;
                player.dataset.url = node.url;
                player.controls = true;
                player.preload = 'metadata';
                preview.append(icon, element('div', 'audio-title', node.name || title(node)), element('div', 'audio-sub', 'AUDIO'), player);
            } else {
                preview = markup(image(node.url, 768, 'draggable="false"'));
            }
            return { kind: type, missing: unavailable, caption, preview };
        }

        function openGroup(event, node) {
            if (!host.group.hasImages(node)) return false;
            event.preventDefault();
            event.stopImmediatePropagation();
            host.group.open(node.id);
            return true;
        }

        function groupBody(body, node) {
            const members = (node.items || []).map(host.node).filter(Boolean);
            const label = host.label;
            const groups = [];
            if (node.type === 'promptGroup') {
                groups.push(members.length + ' ' + label('canvas.promptCount'));
            } else {
                for (const [type, key] of [['image', 'imageCount'], ['prompt', 'promptCount']]) {
                    const count = members.filter(member => member.type === type).length;
                    if (count) groups.push(count + ' ' + label('canvas.' + key));
                }
            }
            const text = groups.length ? groups.join(' · ') + ' ' + label('canvas.grouped') : label('canvas.groupEmpty');
            body.append(element('div', 'text-[11px] text-gray-400', text));
            if (node.type !== 'group' || !host.group.hasImages(node)) return;
            body.style.cursor = 'zoom-in';
            body.onmousedown = event => {
                if (event.button !== 0) return;
                if (event.detail >= 2 && openGroup(event, node)) return;
                host.drag(event, node);
            };
            body.ondblclick = event => openGroup(event, node);
        }

        function toggleSelection(event, node) {
            event.stopPropagation();
            if (control(event.target)) return;
            const { selected } = host;
            if (event.ctrlKey || event.metaKey) {
                if (!selected.delete(node.id)) selected.add(node.id);
            } else if (!selected.has(node.id)) {
                selected.clear();
                selected.add(node.id);
            }
            host.selectionChanged();
        }

        function contextMenu(event, node) {
            if (node.type !== 'output' && !generatorTypes.includes(node.type)) return;
            event.preventDefault();
            event.stopPropagation();
            if (node.type === 'output') host.output.menu(node.id, event.clientX, event.clientY);
            else host.nodeMenu(node.id, event);
        }

        function remove(event, node) {
            event.preventDefault();
            event.stopPropagation();
            if (node.type === 'image' && node.url) {
                host.undo();
                Object.assign(node, { url: '', mediaKind: 'image', name: host.label('canvas.imageCard') });
                for (const key of ['natural_w', 'natural_h', 'originalLocalUrl']) delete node[key];
                host.changed();
                return;
            }
            if (node.type === 'output' && (node.images?.length || node._pending?.length)) {
                host.undo();
                Object.assign(node, { images: [], _pending: [], imageComparisons: {} });
                host.changed(node.id);
                return;
            }
            host.remove(node.id);
        }

        const bodies = {
            image: (body, node) => nodes.paintMedia(body, node, mediaView(node), host.media.actions),
            prompt: (body, node) => nodes.paintPrompt(body, node, {
                label: host.label,
                active: host.prompts.active(node.id),
                openLibrary: host.prompts.open,
                onInput(value) {
                    node.text = value;
                    host.prompts.edited();
                },
            }),
            group: groupBody,
            promptGroup: groupBody,
            output: (body, node) => host.output.mount(node, body),
        };

        function mount(node) {
            host.migrate(node);
            if (node.type === 'rh' && Number(node.h) === 560) delete node.h;
            const status = node.runStatus && statusTypes.has(node.type) && (node.runStatus !== 'failed' || node._cascadeFailed)
                ? { state: node.runStatus, index: node._cascadeIdx || '' } : null;
            const frame = surface.mountClassicFrame(node, {
                catalog,
                size: size(node.type),
                selected: host.selected.has(node.id),
                status,
                onSelect: event => toggleSelection(event, node),
                onContext: event => contextMenu(event, node),
                onDelete: event => remove(event, node),
            });
            const { body, root: card } = frame;
            if (Object.hasOwn(bodies, node.type)) bodies[node.type](body, node);
            else if (Object.hasOwn(host.renderers, node.type)) body.append(host.renderers[node.type](node));
            card.append(body);
            nodes.attach(card, node, { label: host.label, control, drag: host.drag, resize: host.resize, link: host.link, previewGroup: openGroup });
            return card;
        }

        const factories = {
            ...host.factories,
            image: point => ({ ...point, id: host.id('img'), type: 'image', url: '', name: '空白图片' }),
            prompt: point => ({ ...point, id: host.id('prompt'), type: 'prompt', text: '' }),
            output: point => ({ ...point, id: host.id('out'), type: 'output', images: [] }),
        };

        function add(type, point) {
            const key = currentType(type);
            if (!Object.hasOwn(factories, key) || !host.ready()) return null;
            const node = factories[key](point || host.point(size(key).offset, 0));
            host.nodes().push(node);
            host.changed();
            return node;
        }

        function restoreRun(meta) {
            const run = meta?.run;
            if (!run?.nodeType || !host.ready()) return;
            const { x, y } = host.point(180, 40);
            const saved = root.XiaomeiHistoryKernel.cloneData(run.node || {});
            const generator = { ...saved, id: host.id(saved.type || run.nodeType), type: run.nodeType, x, y, inputs: [], running: false };
            const inputs = [];
            if (run.prompt) inputs.push({ id: host.id('pr'), type: 'prompt', x: x - 340, y, text: run.prompt });
            for (const [index, ref] of (run.refs || []).slice(0, 8).entries()) {
                inputs.push({ id: host.id('img'), type: 'image', x: x - 340, y: y + 110 + index * 86, url: ref.url, name: ref.name || 'image' });
            }
            host.nodes().push(generator, ...inputs);
            for (const input of inputs) host.edges().push({ id: host.id('c'), from: input.id, to: generator.id });
            host.output.close();
            host.changed();
        }

        host.toolbar?.querySelectorAll('[data-canvas-card]').forEach(button => {
            button.addEventListener('click', () => add(button.dataset.canvasCard));
        });

        return { add, mount, restoreRun, catalog };
    }

    root.XiaomeiClassicCards = { create, size, generatorTypes };
})(window);
