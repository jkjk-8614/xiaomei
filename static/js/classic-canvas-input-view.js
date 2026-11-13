(function (root) {
    'use strict';

    const transferType = 'application/x-canvas-input';
    const numberClass = 'input-index';
    const emptyClass = 'text-[11px] text-gray-300 py-2';

    function create(host) {
        const media = root.XiaomeiClassicMediaPreview;

        function line(container, className, text, tag = 'div') {
            const element = container.ownerDocument.createElement(tag);
            element.className = className;
            element.textContent = text ?? '';
            container.append(element);
        }

        function icon(name) {
            return '<i data-lucide="' + name + '" class="w-6 h-6 text-slate-400"></i>';
        }

        function thumbnail(url, kind = 'image') {
            if (url && host.missing(url)) return host.missingView(url);
            if (kind === 'video') return host.video(url, 256);
            return url ? host.image(url, 256) : icon('image');
        }

        function prompts(container, sources) {
            if (!container) return;
            container.replaceChildren();
            if (!sources.length) return;
            line(container, 'text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1', 'Prompts');
            for (const source of sources) {
                line(container, 'text-[11px] text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 line-clamp-2', source.label);
            }
        }

        function bindReorder(item, node, id) {
            item.draggable = true;
            item.dataset.sourceId = id;
            item.addEventListener('dragstart', event => {
                event.stopPropagation();
                host.dragging(true);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(transferType, id);
            });
            item.addEventListener('dragend', () => host.dragging(false));
            function accept(event) {
                event.preventDefault();
                event.stopPropagation();
            }
            item.addEventListener('dragover', accept);
            item.addEventListener('drop', event => {
                accept(event);
                host.dragging(false);
                host.reorder(node, event.dataTransfer.getData(transferType), id);
            });
        }

        function list(container, node, sources, empty, describe) {
            container.replaceChildren();
            if (!sources.length) line(container, emptyClass, empty);
            for (const [index, source] of sources.entries()) {
                const number = index + 1;
                const row = container.ownerDocument.createElement('div');
                row.className = 'input-item';
                const { preview, label } = describe(source, number);
                line(row, numberClass, number, 'span');
                row.insertAdjacentHTML('beforeend', preview);
                line(row, 'input-label', label, 'span');
                bindReorder(row, node, source.id);
                container.append(row);
            }
        }

        function images(container, node, sources, empty) {
            if (!container) return;
            list(container, node, sources, empty || host.label('canvas.inputImagesEmpty'), source => ({
                preview: thumbnail(source.preview), label: source.label,
            }));
            host.icons();
        }

        function workflow(container, node, sources) {
            list(container, node, sources, host.label('canvas.groupEmpty'), (source, number) => {
                const kind = media.referenceKind(source.refs?.[0] || source.preview);
                const title = kind === 'image' ? host.label('canvas.image') : media.kindTitle(kind);
                const preview = kind === 'audio' ? icon('file-audio')
                    : kind === 'video' && !source.preview ? icon('file-video')
                    : thumbnail(source.preview, kind);
                return { preview, label: title + ' ' + number };
            });
        }

        function runningHub(ref) {
            const kind = media.referenceKind(ref);
            if (kind === 'video') return host.video(ref.url, 256);
            if (kind === 'image' && !host.missing(ref.url)) return host.image(ref.url, 256);
            return icon(kind === 'audio' ? 'file-audio' : 'image');
        }

        return { prompts, images, workflow, runningHub, thumbnail, bindReorder };
    }

    root.XiaomeiClassicInputView = { create };
})(window);
