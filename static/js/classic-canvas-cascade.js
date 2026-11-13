(function (root) {
    'use strict';

    const targetOf = options => String(options?.cascadeTargetId || options?.targetId || '');
    const isAbort = error => Boolean(error?.isCascadeAbort || ['CascadeAbortError', 'AbortError'].includes(error?.name));
    const running = context => context?.state === 'running' || context?.state === 'stopping';

    function create(host) {
        const graph = root.XiaomeiClassicWorkflow;
        const loopEngine = root.XiaomeiClassicLoop;
        const live = new Map();
        const retryByNode = new Map();
        let owner = new WeakMap();
        const roundsByRun = new WeakMap();
        const label = name => host.label('canvas.' + name);
        const order = target => graph.order(host.nodes(), host.edges(), target);
        const active = target => running(live.get(target));
        const stopping = target => live.get(target)?.state === 'stopping';
        const nodeBusy = id => Array.from(live.values()).some(context => running(context) && context.plan.order.includes(id));
        const busy = id => nodeBusy(id) || host.node(id)?.running;
        const restartMessage = () => label('cascadeRestart');
        const owns = options => !options?.cascadeRun || (live.get(targetOf(options)) === options.cascadeRun
            && host.document() === options.cascadeRun.document);

        function abort(reason) {
            return Object.assign(new Error(reason || label('cascadeStopped')), { name: 'CascadeAbortError', isCascadeAbort: true });
        }

        function assertActive(options) {
            const target = targetOf(options);
            const context = live.get(target);
            if (options?.cascadeRun && (!owns(options) || context.state !== 'running')) {
                throw abort(options.cascadeRun.reason);
            }
            if (context?.state === 'stopping') throw abort(context.reason);
            return context?.state === 'running' ? context : null;
        }

        async function fetch(input, init = {}, options) {
            const context = assertActive(options);
            if (!context) return root.fetch(input, init);
            const own = context.controller.signal;
            const signal = init.signal ? root.AbortSignal.any([init.signal, own]) : own;
            try {
                const result = await root.fetch(input, { ...init, signal });
                assertActive(options);
                return result;
            } catch (error) {
                if (own.aborted || error?.name === 'AbortError') throw abort(context.reason);
                throw error;
            }
        }

        function loopFor(target) {
            const upstream = graph.upstream(host.nodes(), host.edges(), target);
            return host.nodes().findLast(node => node.type === 'loop' && upstream.has(node.id));
        }

        function wiring(target) {
            const ids = graph.upstream(host.nodes(), host.edges(), target);
            ids.add(target);
            return JSON.stringify(host.edges().filter(edge => ids.has(edge.to) && ids.has(edge.from))
                .map(edge => [edge.from, edge.to]));
        }

        function makePlan(target) {
            const ids = order(target);
            const loop = loopFor(target);
            return {
                target, order: ids, loop, document: host.document(),
                graph: wiring(target),
                nodes: new Map(ids.map(id => [id, host.node(id)])),
                ui: [...new Set([target, ...ids, loop?.id].filter(Boolean))],
                concurrency: loopEngine.mode(loop) === 'parallel'
                    ? (ids.some(id => host.node(id)?.type === 'comfy') ? Math.max(1, host.comfySlots() || 1) : 6) : 1,
            };
        }

        function clear(node) {
            if (!node) return;
            node.runStatus = '';
            node.runError = '';
            node._cascadeIdx = '';
            node._cascadeFailed = false;
        }

        function reset() {
            for (const context of live.values()) {
                root.clearTimeout(context.cleanup);
                context.controller.abort();
            }
            live.clear();
            retryByNode.clear();
            owner = new WeakMap();
        }

        function stop(target, reason = '') {
            const context = live.get(target);
            if (!running(context)) return;
            context.state = 'stopping';
            context.reason = reason;
            context.controller.abort();
            host.refresh(context.plan.ui);
        }

        function ownNodes(context, visit) {
            for (const [id, node] of context.plan.nodes) {
                if (owner.get(node) === context && host.node(id) === node) visit(node);
            }
        }

        function finish(context, state) {
            const { target, ui } = context.plan;
            context.state = state;
            if (state === 'done') {
                context.cleanup = root.setTimeout(() => {
                    if (live.get(target) !== context || host.document() !== context.document) return;
                    ownNodes(context, node => {
                        if (node.runStatus === 'done') clear(node);
                        owner.delete(node);
                    });
                    live.delete(target);
                    host.refresh(ui);
                }, 3000);
            } else {
                ownNodes(context, node => {
                    if (state === 'stopped' && !node._cascadeFailed) clear(node);
                    owner.delete(node);
                });
                live.delete(target);
            }
            host.refresh(ui);
        }

        async function execute(plan, jobs) {
            const { target, order, nodes, document, ui, concurrency } = plan;
            const previous = live.get(target);
            if (previous) {
                root.clearTimeout(previous.cleanup);
                ownNodes(previous, node => {
                    if (node.runStatus === 'done') clear(node);
                    owner.delete(node);
                });
                host.refresh(previous.plan.ui);
            }
            const context = { plan, document, state: 'running', controller: new root.AbortController(), counts: new Map() };
            live.set(target, context);
            for (const node of nodes.values()) {
                owner.set(node, context);
                clear(node);
                node.runStatus = 'queued';
            }
            host.refresh(ui);
            const options = { cascade: true, cascadeTargetId: target, cascadeRun: context };
            const result = await loopEngine.dispatch(jobs, concurrency, async ({ round, from }) => {
                for (let step = from; step < order.length; step++) {
                    const id = order[step];
                    const node = nodes.get(id);
                    let entered = false;
                    let success = false;
                    try {
                        assertActive(options);
                        if (host.node(id) !== node) throw new Error(label('cascadeGraphChanged'));
                        context.counts.set(id, (context.counts.get(id) || 0) + 1);
                        entered = true;
                        node.runStatus = 'running';
                        node._cascadeIdx = (step + 1) + '/' + order.length + (round ? ' · ' + round.index + '/' + round.total : '');
                        host.refresh([id]);
                        if (round) {
                            if (node.type === 'llm' && !round.text.has(id)) round.text.set(id, '');
                            for (const source of [id, ...host.outputIds(id)]) {
                                if (!round.media.has(source)) round.media.set(source, []);
                            }
                        }
                        await host.run(node, { ...options, round });
                        assertActive(options);
                        if (host.node(id) !== node) throw new Error(label('cascadeGraphChanged'));
                        success = true;
                    } catch (error) {
                        throw { error, id, round, from: step };
                    } finally {
                        if (entered) {
                            const remaining = context.counts.get(id) - 1;
                            context.counts.set(id, remaining);
                            if (live.get(target) === context && owner.get(node) === context && host.node(id) === node && (success || remaining)) {
                                node.runStatus = remaining ? 'running' : 'done';
                                host.refresh([id]);
                            }
                        }
                    }
                }
            });

            if (live.get(target) !== context || host.document() !== document) return;
            if (context.state === 'stopping' || result.failures.some(failure => isAbort(failure.error))) {
                finish(context, 'stopped');
                return;
            }
            if (!result.failures.length) {
                finish(context, 'done');
                return;
            }
            ownNodes(context, node => { if (['queued', 'running', 'failed'].includes(node.runStatus)) clear(node); });
            const failures = result.failures.sort((left, right) => (left.round?.ordinal || 0) - (right.round?.ordinal || 0));
            const first = failures[0];
            const failed = host.node(first.id) || host.node(target);
            if (failed) {
                const total = plan.loop ? loopEngine.count(plan.loop) : 1;
                const prefix = first.round && total > 1 ? label('loopRound') + ' ' + first.round.ordinal + '/' + total + ': ' : '';
                failed.runStatus = 'failed';
                failed.runError = prefix + (first.error?.message || String(first.error));
                failed._cascadeFailed = true;
                retryByNode.set(failed.id, { plan, queue: failures.map(({ round, from }) => ({ round, from })).concat(result.remaining) });
            }
            finish(context, 'failed');
        }

        async function start(target) {
            const plan = makePlan(target);
            if (!plan.order.length) { host.message(label('cascadeEmpty'), label('generationFailed')); return; }
            if (plan.order.some(busy)) { host.message(label('cascadeBusy'), label('generationFailed')); return; }
            for (const [id, node] of plan.nodes) {
                retryByNode.delete(id);
                node.generatedOutputs = [];
            }
            await execute(plan, loopEngine.rounds(plan.loop).map(round => ({ round, from: 0 })));
        }

        async function retry(id) {
            const record = retryByNode.get(id);
            if (!record || record.plan.order.some(busy)) return;
            retryByNode.delete(id);
            const { plan, queue } = record;
            if (host.document() !== plan.document || plan.graph !== wiring(plan.target)
                || Array.from(plan.nodes).some(([key, node]) => host.node(key) !== node)) {
                clear(host.node(id));
                host.refresh([id]);
                host.message(label('cascadeGraphChanged'), label('generationFailed'));
                return;
            }
            await execute(plan, queue);
        }

        function cancelRetry(id) {
            if (!retryByNode.delete(id)) return;
            clear(host.node(id));
            host.refresh([id]);
        }

        function button(classes, iconName, data, id, caption, handler, disabled) {
            const button = root.document.createElement('button');
            button.className = classes;
            button.type = 'button';
            button.dataset[data] = id;
            button.disabled = Boolean(disabled);
            if (iconName) {
                const icon = root.document.createElement('i');
                icon.className = 'w-4 h-4';
                icon.dataset.lucide = iconName;
                const span = root.document.createElement('span');
                span.textContent = caption;
                button.append(icon, span);
            } else button.textContent = caption;
            button.onmousedown = event => event.stopPropagation();
            button.onclick = event => { event.stopPropagation(); handler(id); };
            return button;
        }

        function decorate(card, actions, node, errors = card) {
            const { id } = node;
            if (graph.terminal(host.nodes(), host.edges(), id)) {
                const steps = order(id).length;
                const loop = loopFor(id);
                if (steps > 1 || loop) {
                    if (active(id)) {
                        actions.append(button('gen-cascade-btn gen-cascade-stop', 'square', 'cascadeStop', id,
                            label(stopping(id) ? 'cascadeStopping' : 'cascadeStop'), stop, stopping(id)));
                    } else {
                        const caption = host.format('canvas.cascadeRunNodes', { count: steps })
                            + (loop ? ' × ' + loopEngine.count(loop) + ' ' + label('loopRounds') : '');
                        const startButton = button('gen-cascade-btn', 'play-circle', 'cascade', id, caption, start);
                        startButton.title = label('cascadeRunHint');
                        actions.append(startButton);
                    }
                }
            }
            if (node.runStatus !== 'failed' || !node._cascadeFailed) return;
            const bar = root.document.createElement('div');
            bar.className = 'node-retry-bar';
            bar.dataset.retryBar = '';
            const description = root.document.createElement('span');
            description.className = 'node-retry-msg';
            description.title = node.runError || '';
            description.textContent = (node.runError || label('generationFailed')).slice(0, 60);
            bar.append(description, button('node-retry-btn', '', 'retry', id, label('cascadeRetry'), retry),
                button('node-stop-btn', '', 'stop', id, label('cascadeCancelRetry'), cancelRetry));
            errors.append(bar);
        }

        function associate(run, round) {
            if (round) roundsByRun.set(run, round);
        }

        function media(run, node, outputs) {
            const round = roundsByRun.get(run);
            if (!round) return;
            for (const id of new Set([node.id, ...host.outputIds(node.id)])) {
                const list = round.media.get(id) || [];
                const known = new Set(list.map(host.outputUrl));
                for (const item of outputs) {
                    const url = host.outputUrl(item);
                    if (!url || known.has(url)) continue;
                    known.add(url);
                    list.push(item);
                }
                round.media.set(id, list);
            }
        }

        function normalizeError(error, fallback) {
            const text = String(error?.message || error || '').trim();
            if (!text) return fallback || label('generationFailed');
            if (/backend restarted and task status was lost|Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i.test(text)
                || (/(404|not found|missing)/i.test(text) && /canvas-image-task/i.test(text))) return restartMessage();
            return text;
        }

        return { reset, active, stopping, nodeBusy, fetch, assertActive, owns, stop, order, start, decorate,
            loopTarget: id => graph.loopTarget(host.nodes(), host.edges(), id), associate, media, restartMessage, normalizeError };
    }

    root.XiaomeiClassicCascade = { create, isAbort, targetOf };
})(window);
