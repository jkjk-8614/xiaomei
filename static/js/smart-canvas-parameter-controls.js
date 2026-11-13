(function (root) {
    'use strict';

    const triggerSelector = '.generation-settings-trigger, .video-generation-settings-trigger, .video-options-trigger, .image-model-trigger';
    const controlKey = element => [...element.classList].find(name => name !== 'smart-control' && name.endsWith('-control')) || '';

    function create(host) {
        const container = host.container;
        let refreshHandle;
        let idleRefresh = false;
        let refreshGeneration = 0;

        function dismissControl(control) {
            control.classList.remove('pinned', 'interacting');
            control.classList.add('popover-dismissed');
            control.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'false');
        }

        function dismiss() {
            host.closeBatchMenu();
            for (const control of container.ownerDocument.querySelectorAll('.smart-control')) dismissControl(control);
        }

        function interacting(button) {
            const control = button.closest('.smart-control');
            control?.classList.remove('popover-dismissed');
            if (control && !control.classList.contains('pinned')) control.classList.add('interacting');
        }

        function snapshot() {
            return {
                top: container.scrollTop, left: container.scrollLeft,
                controls: [...container.querySelectorAll('.smart-control')].map(control => ({
                    key: controlKey(control),
                    pinned: control.classList.contains('pinned'),
                    interacting: control.classList.contains('interacting'),
                    lists: [...control.querySelectorAll('.size-picker-list')].map(list => ({ top: list.scrollTop, left: list.scrollLeft }))
                }))
            };
        }

        function restore(saved) {
            const firstChild = container.firstElementChild;
            const controls = [...container.querySelectorAll('.smart-control')];
            const unmatched = new Set(controls);
            const pairs = [];
            for (const state of saved.controls) {
                const control = [...unmatched].find(candidate => controlKey(candidate) === state.key);
                if (!control) continue;
                unmatched.delete(control);
                control.classList.toggle('pinned', state.pinned);
                control.classList.toggle('interacting', state.interacting);
                control.querySelector(triggerSelector)?.setAttribute('aria-expanded', String(state.pinned || state.interacting));
                pairs.push({ state, control });
            }
            const applyScroll = () => {
                if (container.firstElementChild !== firstChild) return;
                container.scrollTop = saved.top;
                container.scrollLeft = saved.left;
                for (const { state, control } of pairs) {
                    const lists = control.querySelectorAll('.size-picker-list');
                    state.lists.forEach((position, index) => {
                        const list = lists[index];
                        if (list) Object.assign(list, { scrollTop: position.top, scrollLeft: position.left });
                    });
                }
            };
            applyScroll();
            root.requestAnimationFrame(applyScroll);
        }

        function scheduleRefresh(delay = 120) {
            if (idleRefresh) root.cancelIdleCallback?.(refreshHandle);
            else root.clearTimeout(refreshHandle);
            const generation = ++refreshGeneration;
            const refresh = () => {
                if (generation !== refreshGeneration) return;
                refreshHandle = undefined;
                host.render();
            };
            idleRefresh = Boolean(root.requestIdleCallback);
            refreshHandle = idleRefresh
                ? root.requestIdleCallback(refresh, { timeout: Math.max(180, Number(delay) + 260) })
                : root.setTimeout(refresh, Math.max(0, Number(delay) || 0));
        }

        function writeRhParameter(key, value) {
            const settings = host.settings();
            const values = settings.rhParams || {};
            settings.rhParams = { ...values, [key]: { ...values[key], value } };
        }

        function pickRhOption(button) {
            const { rhPick: key, rhValue: value } = button.dataset;
            writeRhParameter(key, value);
            const control = button.closest('.smart-control');
            const label = control?.querySelector('.smart-pill .sub');
            if (label) label.textContent = value;
            for (const option of control?.querySelectorAll('[data-rh-pick]') || []) {
                if (option.dataset.rhPick === key) option.classList.toggle('active', option.dataset.rhValue === value);
            }
            dismiss();
            host.commit();
        }

        const actions = {
            smartParam(button) {
                interacting(button);
                host.set(button.dataset.smartParam, button.dataset.smartValue);
                if (button.dataset.smartParam === 'videoDuration') host.render();
            },
            sizeScope(button) {
                interacting(button);
                host.sizeScope(button.dataset.sizePrefix || '', button.dataset.sizeScope);
            },
            videoBool(button) {
                interacting(button);
                host.set(button.dataset.videoBool, button.dataset.videoBoolValue === '1');
                host.render();
            },
            videoMode(button) {
                interacting(button);
                host.set('videoMode', button.dataset.videoMode);
            },
            toggleParam(button) {
                interacting(button);
                const key = button.dataset.toggleParam;
                host.set(key, !host.settings()[key]);
                host.render();
            },
            async trustedSource(button) {
                const source = button.dataset.trustedSource;
                host.set('videoTrustedSource', ['library', 'cloud', 'manual'].includes(source) ? source : 'library');
                host.render();
                await host.trustedSource(source);
            },
            rhBool(button) {
                const key = button.dataset.rhBool;
                writeRhParameter(key, String(String(host.rhValue(key)).toLowerCase() !== 'true'));
                host.commit({ render: true });
            },
            rhPick: pickRhOption,
            rhRandom: button => host.rhRandom(button.dataset.rhRandom)
        };

        container.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) {
                if (event.target.closest('input, select, textarea')) event.stopPropagation();
                return;
            }
            if (button.disabled) return;
            if (button.matches('.smart-control > .smart-pill')) {
                event.preventDefault();
                event.stopPropagation();
                const control = button.parentElement;
                const pin = !control.classList.contains('pinned');
                dismiss();
                control.classList.toggle('pinned', pin);
                control.classList.toggle('popover-dismissed', !pin);
                control.querySelector(triggerSelector)?.setAttribute('aria-expanded', String(pin));
                return;
            }
            if (button.matches('.generation-settings-close')) {
                event.preventDefault();
                event.stopPropagation();
                const control = button.closest('.smart-control');
                if (control) dismissControl(control);
                return;
            }
            const key = Object.keys(actions).find(name => Object.hasOwn(button.dataset, name));
            if (!key) return;
            event.preventDefault();
            event.stopPropagation();
            try {
                Promise.resolve(actions[key](button)).catch(error => host.error((error.message || '操作失败').slice(0, 180)));
            } catch (error) {
                host.error((error.message || '操作失败').slice(0, 180));
            }
        });

        function fieldChanged(event) {
            const input = event.target;
            const data = input.dataset;
            if (!data) return;
            if (Object.hasOwn(data, 'param')) {
                event.stopPropagation();
                if (Object.hasOwn(data, 'videoDurationRange') && event.type === 'input') {
                    const section = input.closest('.video-generation-section');
                    const output = section?.querySelector('[data-video-duration-value]');
                    if (output) output.textContent = input.value;
                    for (const button of section?.querySelectorAll('[data-video-duration-step]') || []) {
                        const direction = Number(button.dataset.videoDurationStep);
                        button.dataset.smartValue = String(Number(input.value) + direction * Number(input.step));
                        button.disabled = direction < 0 ? Number(input.value) <= Number(input.min) : Number(input.value) >= Number(input.max);
                    }
                }
                host.set(data.param, input.value);
                if (data.param === 'videoDuration' && event.type === 'change') host.render();
            } else if (Object.hasOwn(data, 'rhParam')) {
                event.stopPropagation();
                writeRhParameter(data.rhParam, input.value);
                const control = input.closest('.smart-control');
                for (const label of control?.querySelectorAll('.rh-slider-value, .rh-slider-pill-value') || []) label.textContent = input.value;
                host.commit();
            }
        }
        container.addEventListener('input', fieldChanged);
        container.addEventListener('change', fieldChanged);
        container.addEventListener('pointerup', event => {
            if (event.target.dataset?.rhType === 'slider') event.target.blur();
        });
        container.addEventListener('mouseenter', event => {
            const control = event.target;
            if (!control.classList?.contains('smart-control')) return;
            control.classList.remove('popover-dismissed');
            if (control.classList.contains('image-model-control')) control.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'true');
        }, true);
        container.addEventListener('mouseleave', event => {
            const control = event.target;
            if (control.dataset?.rhType === 'slider' && !control.closest('.smart-control')?.matches(':hover')) control.blur();
            if (!control.classList?.contains('smart-control')) return;
            control.classList.remove('interacting');
            if (!control.classList.contains('pinned')) control.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'false');
        }, true);
        container.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const control = event.target.closest('.smart-control') || container.querySelector('.smart-control.pinned');
            const trigger = control?.querySelector(triggerSelector);
            if (!trigger) return;
            event.preventDefault();
            event.stopPropagation();
            dismissControl(control);
            trigger.focus({ preventScroll: true });
        });

        return { snapshot, restore, dismiss, scheduleRefresh };
    }

    root.XiaomeiSmartParameterControls = { create };
})(window);
