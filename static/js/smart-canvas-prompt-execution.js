(function (root) {
    'use strict';

    const switched = '画布或节点已切换，本次链路已停止';
    const changedInputs = '运行期间输入或模型已修改，请重新运行该节点';
    const changedOutput = '运行期间输出提示词已修改，请重新运行该节点';

    function create(host) {
        const running = new Map();
        const prompt = id => {
            const node = host.node(id);
            return node?.type === 'smart-prompt' ? node : null;
        };

        function owner(job) {
            if (host.scope() !== job.scope || running.get(job.id) !== job) return null;
            const node = prompt(job.id);
            return node?.running && node.promptRunStartedAt === job.startedAt ? node : null;
        }

        function fail(error, notify = true) {
            if (notify) host.error(error);
            return { ok: false, error };
        }

        async function execute(job, node, signal) {
            if (signal?.aborted) return fail(host.cancelled, false);
            host.prepare(node);
            const message = host.message(node);
            if (!message) return fail(host.label('smart.promptLlmNeedText'));
            const previousOutput = String(node.text ?? '');
            job.startedAt = host.now();
            Object.assign(node, {
                llmEnabled: true, running: true, promptRunStartedAt: job.startedAt, promptRunFinishedAt: 0,
            });
            delete node.promptRunError;
            host.paint();

            try {
                if (!host.configReady()) throw new Error('模型列表尚未加载，请稍后重试');
                const { provider, model } = host.model(node);
                if (!host.isAvailable(provider, model)) throw new Error('提示词节点所选平台或模型不可用，请重新选择');
                const refs = host.references(node);
                if (refs.some(ref => ref.sourceMissing)) throw new Error('引用已失效，请移除后重新选择');
                const signature = host.signature(node);
                const body = {
                    message, messages: [], provider, model,
                    system_prompt: host.system(node),
                    ...host.media(refs),
                };
                const response = await root.fetch('/api/canvas-llm', {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!response.ok) throw new Error(await host.responseError(response));
                const data = await response.json();
                if (signal?.aborted) throw new Error(host.cancelled);
                const target = owner(job);
                if (!target) return fail(switched, false);
                if (host.signature(target) !== signature) throw new Error(changedInputs);
                if (String(target.text ?? '') !== previousOutput) throw new Error(changedOutput);

                const text = String(data?.text || '').trim();
                if (!text) throw new Error('提示词节点没有返回文本');
                Object.assign(target, { text, llmProvider: provider, llmModel: model, promptRunAt: host.now() });
                host.outputChanged(target);
                return { ok: true, text };
            } catch (reason) {
                const target = owner(job);
                if (!target) return fail(switched, false);
                const error = String(signal?.aborted ? host.cancelled : reason?.message || host.label('smart.promptLlmFailed')).slice(0, 160);
                target.promptRunError = error;
                return fail(error, !signal?.aborted);
            } finally {
                const target = owner(job);
                if (target) {
                    target.running = false;
                    target.promptRunFinishedAt = host.now();
                    host.paint();
                    host.save();
                }
            }
        }

        function run(id, signal) {
            const node = prompt(id);
            if (!node) return Promise.resolve(undefined);
            const scope = host.scope();
            const existing = running.get(id);
            if (existing && existing.scope === scope) return existing.promise;
            const job = { id, scope };
            job.promise = Promise.resolve().then(() => {
                const current = prompt(id);
                if (host.scope() !== scope || current !== node) return fail(switched, false);
                return execute(job, current, signal);
            }).finally(() => {
                if (running.get(id) === job) running.delete(id);
            });
            running.set(id, job);
            return job.promise;
        }

        function recover(node) {
            if (node?.type !== 'smart-prompt' || !node.running) return false;
            const active = running.get(node.id);
            if (active && active.scope === host.scope()) return false;
            Object.assign(node, {
                running: false, promptRunFinishedAt: host.now(),
                promptRunError: host.label('smart.errRunInterrupted'),
            });
            delete node.dependencyRunSignature;
            return true;
        }

        return { run, recover };
    }

    root.XiaomeiSmartPromptExecution = { create };
})(window);
