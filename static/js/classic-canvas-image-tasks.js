(function (root) {
    'use strict';

    const online = 'online-image';
    const upstreamId = message => String(message || '')
        .match(/(?:task_id|taskId|task id)\s*[=:：]\s*([A-Za-z0-9_.:-]+)/i)?.[1] || '';
    const provider = pending => pending.providerId || pending.run?.request?.provider_id
        || pending.run?.node?.apiProvider || pending.run?.node?.provider_id || 'comfly';

    function describe(pending) {
        if (pending.clientRequestId && !pending.canvasTaskId) {
            return { type: 'receipt', id: pending.clientRequestId };
        }
        if (pending.canvasTaskId && pending.waitStopped) {
            return { type: 'local', id: pending.canvasTaskId };
        }
        const id = pending.recoverTaskId || upstreamId(pending.error);
        return id ? { type: 'upstream', id } : { type: '', id: '' };
    }

    function create(host) {
        const active = new WeakMap();
        const client = root.XiaomeiImageTaskClient;
        const errors = root.XiaomeiApiErrors;
        const label = key => host.label('canvas.' + key);
        const elapsed = pending => Math.max(0, Date.now() - Number(pending.startedAt || Date.now()));

        function outputFor(ticket) {
            if (host.document() !== ticket.document) return null;
            const out = host.node(ticket.outputId);
            return out?.type === 'output' && out._pending?.includes(ticket.pending) ? out : null;
        }

        function follow(ticket, work) {
            const { pending } = ticket;
            if (!active.has(pending)) {
                const job = Promise.resolve().then(() => work(ticket)).finally(() => active.delete(pending));
                active.set(pending, job);
            }
            return active.get(pending);
        }

        function imageItems(result) {
            if (Array.isArray(result?.images) && result.images.length) return result.images;
            return host.resultMedia(result?.image_items?.length ? { items: result.image_items } : result);
        }

        function writeResults(node, run, images, append) {
            if (!node) return;
            host.roundMedia(run, node, images);
            host.generated(node, images, append);
            node.runStatus = 'done';
            node.runError = '';
        }

        function remove(out, pending) {
            out._pending = out._pending.filter(item => item !== pending);
        }

        function complete(out, pending, result, images) {
            const run = pending.run || {};
            const runMs = elapsed(pending);
            run.request = host.requestMeta(result);
            remove(out, pending);
            host.append(out, images, run.refs?.[0], [{ run, runMs }]);
            const node = host.node(run.node?.id);
            writeResults(node, run, images, Boolean(pending.appendGenerated));
            host.record({ run, outputs: images, runMs });
            host.refresh([node?.id, out.id]);
            host.changed();
        }

        function markMissing(out, pending, message) {
            Object.assign(pending, { failed: true, error: message, querying: false });
            host.refresh([out.id]);
            host.changed();
        }

        function errorText(error, fallback) {
            const detail = error?.body ? errors.describe(error.body, error.message) : error;
            return host.normalizeError(detail, fallback);
        }

        function fail(out, pending, error) {
            if (host.isAbort(error)) {
                pending.waitStopped = Boolean(pending.canvasTaskId);
                markMissing(out, pending, error.message);
                return;
            }
            const message = errorText(error, label('generationFailed'));
            const task = error.task;
            const recoverTaskId = task?.upstream_task_id || upstreamId(message);
            if (recoverTaskId) {
                Object.assign(pending, { failed: true, error: message, recoverTaskId, querying: false });
                pending.providerId = task?.provider_id || provider(pending);
            } else if (pending.canvasTaskId && !task) {
                Object.assign(pending, { failed: true, error: message, waitStopped: true, querying: false });
            } else {
                remove(out, pending);
            }
            const run = pending.run || {};
            const node = host.node(run.node?.id);
            if (node) {
                node.runStatus = 'failed';
                node.runError = message;
            }
            host.record({ run, runMs: elapsed(pending), error: message });
            host.refresh([node?.id, out.id]);
            host.changed();
        }

        function poll(taskId, options, exists) {
            if (!taskId) throw new Error(label('imageReceiptMissing'));
            return client.pollImageTask(taskId, {
                intervalMs: 1800,
                initialDelayMs: 0,
                maxAttempts: Infinity,
                fetchImpl: (input, init) => host.fetch(input, init, options),
                beforePoll() {
                    if (!exists()) return { action: 'resolve', value: null };
                    host.assertActive(options);
                },
                fallbackMessage: label('generationFailed'),
                onHttpError: error => error.status === 404 ? new Error(host.restartMessage()) : error,
                classifyTask(task) {
                    const decision = root.XiaomeiDispatchKernel.pollDecision(task);
                    switch (decision.state) {
                        case 'succeeded': return { action: 'resolve', value: task.result || {} };
                        case 'empty':
                        case 'failed':
                        case 'cancelled':
                            return { action: 'reject', error: Object.assign(new Error(decision.message || label('generationFailed')), { task }) };
                        default: return null;
                    }
                },
            });
        }

        async function collect(ticket, options) {
            if (!outputFor(ticket)) return;
            const { pending } = ticket;
            try {
                const result = await poll(pending.canvasTaskId, options, () => Boolean(outputFor(ticket)));
                const out = outputFor(ticket);
                if (out && result) complete(out, pending, result, imageItems(result));
            } catch (error) {
                const out = outputFor(ticket);
                if (out) fail(out, pending, error);
                throw error;
            }
        }

        async function accept(ticket, taskId, options) {
            if (!taskId) throw new Error(label('imageReceiptMissing'));
            const out = outputFor(ticket);
            if (!out) return;
            Object.assign(ticket.pending, { canvasTaskId: taskId, failed: false, waitStopped: false, error: '' });
            host.refresh([out.id]);
            await host.save();
            return collect(ticket, options);
        }

        function reportQuery(message) {
            host.message(message, label('apiFailed'));
        }

        async function queryUpstream(ticket, id) {
            const { pending } = ticket;
            pending.recoverTaskId = id;
            const response = await host.fetch('/api/image-task-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider_id: provider(pending), task_id: id, history_source: 'canvas', project_id: host.projectId() }),
            });
            if (!response.ok) throw new Error(await errors.read(response, label('outputQueryFailed')));
            const result = await response.json();
            const out = outputFor(ticket);
            if (!out) return;
            if (result.status === 'succeeded') {
                const images = result.image_items?.length ? host.resultMedia({ items: result.image_items }) : imageItems(result);
                if (images.length) complete(out, pending, result, images);
                else {
                    pending.error = label('outputQueryEmpty');
                    reportQuery(pending.error);
                }
            } else if (result.status === 'failed') {
                pending.error = result.error || label('generationFailed');
                reportQuery(pending.error);
            } else {
                pending.error = result.message || label('outputQueryRunning');
                host.status(pending.error);
            }
        }

        async function recover(ticket) {
            const out = outputFor(ticket);
            if (!out) return;
            const { pending } = ticket;
            const task = describe(pending);
            if (!task.type) {
                reportQuery(label('outputNoTaskId'));
                return;
            }
            pending.querying = true;
            host.refresh([out.id]);
            try {
                if (task.type === 'upstream') await queryUpstream(ticket, task.id);
                else if (task.type === 'local') await accept(ticket, task.id, {});
                else {
                    const receipt = await client.recoverCanvasImageTask(task.id);
                    const current = outputFor(ticket);
                    if (receipt?.task_id) await accept(ticket, receipt.task_id, {});
                    else if (current) markMissing(current, pending, label('imageReceiptMissing'));
                }
            } catch (error) {
                const current = outputFor(ticket);
                if (current && task.type === 'upstream') {
                    pending.error = error.message || label('outputQueryFailed');
                    reportQuery(pending.error);
                } else if (current && !pending.canvasTaskId) {
                    markMissing(current, pending, error.message || label('imageReceiptMissing'));
                }
            } finally {
                const current = outputFor(ticket);
                if (current) {
                    pending.querying = false;
                    host.refresh([current.id]);
                    host.changed();
                }
            }
        }

        function query(id, outputId) {
            const out = host.node(outputId);
            const pending = out?.type === 'output' && out._pending?.find(item => item.id === id);
            if (!pending) return;
            return follow({ document: host.document(), outputId, pending }, recover);
        }

        function resume(nodes) {
            const document = host.document();
            for (const out of nodes) {
                if (out.type !== 'output') continue;
                for (const pending of out._pending || []) {
                    if (pending.canvasTaskType !== online || pending.failed) continue;
                    if (pending.canvasTaskId) {
                        follow({ document, outputId: out.id, pending }, ticket => collect(ticket, {})).catch(() => {});
                    } else if (pending.clientRequestId) query(pending.id, out.id);
                }
            }
        }

        function submitRequest(id, payload, options) {
            return client.createImageTask({
                ...payload,
                client_request_id: id,
                history_source: payload.history_source || 'canvas',
                project_id: payload.project_id || host.projectId(),
            }, {
                fetchImpl: (input, init) => host.fetch(input, init, options),
                fallbackMessage: label('generationFailed'),
            });
        }

        async function submit(ticket, payload, options, saved) {
            const ready = await saved;
            const out = outputFor(ticket);
            if (!out) return;
            if (!ready) {
                const error = new Error(label('imageSaveBeforeSubmit'));
                fail(out, ticket.pending, error);
                throw error;
            }
            let receipt;
            try {
                receipt = await submitRequest(ticket.pending.id, payload, options);
                if (!receipt?.task_id) throw new Error(label('imageReceiptMissing'));
            } catch (error) {
                const current = outputFor(ticket);
                if (current) {
                    if (!error.status && !host.isAbort(error)) markMissing(current, ticket.pending, label('imageReceiptMissing'));
                    else fail(current, ticket.pending, error);
                }
                throw error;
            }
            return accept(ticket, receipt.task_id, options);
        }

        function finishWithoutOutput(node, run, results, options, error, runMs) {
            const images = results.flatMap(imageItems);
            if (images.length) {
                host.associate(run, options.round);
                run.request = host.requestMeta(results.at(-1));
                writeResults(node, run, images, Boolean(options.cascade));
                host.record({ run, outputs: images, runMs });
            } else if (error && !host.isAbort(error)) {
                host.record({ run, runMs, error: errorText(error, label('generationFailed')) });
            }
            host.refresh([node.id]);
            host.changed();
        }

        function reserve(node, id, run, payload, refs, options) {
            host.associate(run, options.round);
            return host.pending(id, run, node, { refs, requestSize: payload.size, cascadeTargetId: host.target(options) }, {
                canvasTaskType: online, clientRequestId: id, canvasTaskId: '', providerId: payload.provider_id,
                model: payload.model, appendGenerated: Boolean(options.cascade),
            });
        }

        async function run(node, payload, runInfo, refs, options, offset) {
            const document = host.document();
            const current = () => host.document() === document && host.node(node.id) === node;
            const out = host.output(node, offset);
            const started = Date.now();
            const ids = Array.from({ length: host.count(node.count) }, () => host.id('classic_image'));
            if (!options.cascade) {
                node.running = true;
                root.setTimeout(() => {
                    if (!current()) return;
                    node.running = false;
                    host.refresh([node.id]);
                }, 2000);
            }
            host.refresh([node.id, out?.id]);
            let jobs;
            if (out) {
                const pending = ids.map(id => reserve(node, id, { ...runInfo }, payload, refs, options));
                out._pending = [...(out._pending || []), ...pending];
                host.refresh([out.id]);
                const saved = host.save();
                jobs = pending.map(item => follow({ document, outputId: out.id, pending: item },
                    ticket => submit(ticket, payload, options, saved)));
            } else {
                jobs = ids.map(async id => {
                    const task = await submitRequest(id, payload, options);
                    return poll(task?.task_id, options, current);
                });
            }
            const outcomes = await Promise.allSettled(jobs);
            if (!current() || !host.owns(options)) return;
            const error = outcomes.find(result => result.status === 'rejected')?.reason;
            if (!out) {
                const results = outcomes.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
                finishWithoutOutput(node, runInfo, results, options, error, Date.now() - started);
            }
            if (error && !host.isAbort(error)) {
                node.runStatus = 'failed';
                node.runError = errorText(error, label('generationFailed'));
                if (!options.cascade) reportQuery(node.runError);
                host.refresh([node.id]);
                host.changed();
            }
            if (error && options.cascade) throw error;
        }

        return { run, query, resume };
    }

    root.XiaomeiClassicImageTasks = { create, describe };
})(window);
