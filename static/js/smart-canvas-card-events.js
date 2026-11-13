(function (root) {
    'use strict';

    const editable = 'input, textarea, select, [contenteditable="true"]';

    function stop(event) {
        event.stopPropagation();
    }

    function consume(event) {
        event.preventDefault();
        stop(event);
    }

    function create(host) {
        const cards = new WeakSet();
        const controls = new WeakSet();
        const actions = [
            ['.node-drop', 'upload'],
            ['.node-delete', 'remove'],
            ['[data-smart-text-node-expand]', 'expandPrompt'],
            ['[data-smart-text-stack-card]', 'expandStack'],
            ['[data-document-preview-url]', 'openDocument'],
            ['[data-node-input-remove]', 'removeReference'],
            ['[data-smart-node-action]', 'toolbar'],
            ['[data-smart-group-action]', 'groupToolbar'],
            ['[data-jimeng-query]', 'queryJimeng'],
            ['[data-image-task-query]', 'queryImage'],
            ['[data-cancel-image-task]', 'cancelImage'],
            ['[data-cancel-image-batch]', 'cancelBatch'],
            ['[data-cancel-video-run]', 'cancelVideo'],
            ['[data-image-result-recovery]', 'recoverImage'],
            ['[data-image-rerun]', 'retryImage'],
            ['[data-image-quota-retry]', 'retryResolution'],
        ];

        function bindShell(card, id) {
            if (cards.has(card)) return;
            cards.add(card);

            card.addEventListener('focusin', event => {
                const field = event.target;
                if (field.matches(editable) && !host.edit.acquire(id)) field.blur();
            });
            card.addEventListener('focusout', event => {
                if (!event.target.matches(editable)) return;
                root.setTimeout(() => {
                    if (card.contains(card.ownerDocument.activeElement)) return;
                    host.edit.release(id);
                    if (card.isConnected && card.dataset.promptRenderDeferred === '1') {
                        delete card.dataset.promptRenderDeferred;
                        host.edit.refresh(id);
                    }
                }, 0);
            });
            card.addEventListener('click', event => {
                stop(event);
                if (!event.target.closest('.run-time-pill')) host.select(id, event);
            });
            card.addEventListener('dblclick', event => {
                stop(event);
                if (!event.target.closest('.run-time-pill') && host.node(id)?.type === 'smart-group') {
                    event.preventDefault();
                    host.openGroup(id, event);
                }
            });
            card.addEventListener('mousedown', event => {
                if (event.target.closest('.run-time-pill')) stop(event);
                else host.drag(id, event);
            });
            card.addEventListener('dragover', event => {
                if (host.files.blocks(host.node(id))) {
                    event.dataTransfer.dropEffect = 'none';
                    host.files.clear();
                    return;
                }
                host.files.indicate(event, card);
            });
            card.addEventListener('dragleave', event => {
                if (!card.contains(event.relatedTarget)) host.files.clear();
            });
            card.addEventListener('drop', event => {
                consume(event);
                return host.files.drop(event.dataTransfer, id);
            });
        }

        function bindActions(card, node) {
            for (const [selector, name] of actions) {
                if (name === 'removeReference' && node.type === 'smart-loop') continue;
                for (const control of card.querySelectorAll(selector)) {
                    if (controls.has(control)) continue;
                    controls.add(control);
                    if (name !== 'remove') {
                        control.addEventListener('mousedown', event => {
                            if (name !== 'upload' || event.button === 0) consume(event);
                        }, true);
                    }
                    control.addEventListener('click', event => {
                        if (name === 'openDocument' && event.target.closest('[data-node-input-remove]')) return;
                        consume(event);
                        host.actions[name](control, card.dataset.id);
                    }, name === 'openDocument');
                }
            }
        }

        function bindSettings(card) {
            for (const button of card.querySelectorAll('[data-smart-node-settings]')) {
                const panel = button.nextElementSibling;
                if (!panel || controls.has(button)) continue;
                controls.add(button);
                button.popoverTargetElement = panel;
                button.addEventListener('mousedown', consume);
                button.addEventListener('click', event => {
                    consume(event);
                    if (panel.matches(':popover-open')) host.settings.close();
                    else host.settings.open(panel, button);
                });
                panel.addEventListener('toggle', () => {
                    const open = panel.matches(':popover-open');
                    button.setAttribute('aria-expanded', String(open));
                    if (!open) host.settings.hidden(panel);
                });
                panel.addEventListener('pointerdown', stop);
                panel.addEventListener('mousedown', stop);
                panel.addEventListener('wheel', stop, {passive:true});
            }
        }

        function bind(card, node) {
            const id = card.dataset.id;
            bindShell(card, id);
            bindActions(card, node);
            bindSettings(card);

            const handle = card.querySelector('.node-resize-handle');
            if (handle && !controls.has(handle)) {
                controls.add(handle);
                handle.addEventListener('mousedown', event => host.resize(id, card, event));
            }
            for (const port of card.querySelectorAll('.node-port')) {
                if (controls.has(port)) continue;
                controls.add(port);
                port.addEventListener('mousedown', event => host.port(port, id, event));
                port.addEventListener('click', stop);
                port.addEventListener('dblclick', stop);
            }
        }

        return {bind};
    }

    root.XiaomeiSmartCardEvents = {create};
})(window);
