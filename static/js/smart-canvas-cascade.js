(function (root) {
    'use strict';

    const edgeKey = (source, target) => source.id + '->' + target.id;
    const isLoop = node => node.type === 'smart-loop';

    function rounds(count, start, stride = 1) {
        const length = Math.max(1, Math.trunc(count) || 1);
        const total = start + (length - 1) * stride;
        return Array.from({ length }, (_, offset) => ({ index: start + offset * stride, offset, total }));
    }

    async function dispatch(queue, concurrency, { check, run, onFailure }) {
        const failures = [];
        let next = 0;
        let fatal;
        async function worker() {
            while (!fatal && next < queue.length) {
                let round;
                try {
                    check();
                    round = queue[next++];
                    await run(round);
                } catch (error) {
                    if (round && !error?.smartCascadeStopped && queue.length > 1) {
                        failures.push({ round, error });
                        try {
                            onFailure(round, error);
                        } catch (failure) {
                            fatal ??= failure;
                        }
                    } else {
                        fatal ??= error;
                    }
                }
            }
        }
        const workers = Math.min(queue.length, Math.max(1, Math.trunc(concurrency) || 1));
        await Promise.all(Array.from({ length: workers }, worker));
        if (fatal) throw fatal;
        check();
        return failures;
    }

    function context(round, config) {
        const { runState, loop, batchConcurrency, forceWorkflow } = config;
        const shared = { runState, roundOutputs: new Map() };
        if (!loop) return shared;
        return { ...shared, index: round.index, total: round.total, nodeId: loop.id, batchConcurrency, forceWorkflow };
    }

    async function runPath(graph, ctx, host) {
        const { root: source, children } = graph;
        function branch(node, refs) {
            host.check(node);
            let targets = children.get(node.id) || [];
            const prompt = host.prompts(node);
            for (const loop of prompt.direct) host.edge(edgeKey(loop, node), 'done');
            if (prompt.rotating && targets.length > 1) {
                const loop = prompt.rotating;
                const index = Math.max(1, Math.trunc(Number(ctx.index || loop.loopStart)) || 1);
                targets = [targets[(index - 1) % targets.length]];
                host.edge(edgeKey(loop, node), 'done');
            }
            return { source: node, targets, refs, shared: refs, next: 0 };
        }

        host.check(source);
        const stack = [branch(source, host.rootRefs(source, ctx))];
        while (stack.length) {
            const parent = stack.at(-1);
            if (parent.next >= parent.targets.length) {
                stack.pop();
                continue;
            }
            const first = parent.next === 0;
            const target = parent.targets[parent.next++];
            host.check(parent.source, target);
            const key = edgeKey(parent.source, target);
            const relay = host.relay(parent.source, target);
            const appendLoopOutputs = Boolean(ctx.nodeId && !isLoop(target)
                && !(children.get(target.id) || []).some(child => !isLoop(child)));
            const step = { ...ctx, appendLoopOutputs };
            if (relay.length) {
                step.relayPromptNodeIds = [...new Set([...(ctx.relayPromptNodeIds || []), ...relay.map(loop => loop.id)])];
                for (const loop of relay) host.edge(edgeKey(loop, parent.source), 'done');
            }
            host.edge(key, 'active');
            let nextRefs;
            if (isLoop(target)) {
                nextRefs = host.loopRefs(parent.source, ctx);
                parent.shared = nextRefs;
            } else {
                let outputs;
                try {
                    outputs = first ? await host.generate(parent.source, target, parent.refs, step)
                        : host.receive(target, parent.shared, step);
                } catch (error) {
                    if (!parent.refs.length || !host.canReceive(error)) throw error;
                    host.check(parent.source, target);
                    outputs = host.receive(target, parent.refs, step);
                }
                nextRefs = host.references(outputs, target);
                if (first) parent.shared = nextRefs;
            }
            host.edge(key, 'done');
            stack.push(branch(target, nextRefs));
        }
    }

    root.XiaomeiSmartCascade = { rounds, dispatch, context, runPath };
})(window);
