(function (root) {
    'use strict';

    const requestTimeout = 330000;
    const switched = '画布或节点已切换，本次链路已停止';
    const changedInputs = '运行期间输入或模型已修改，请重新运行该节点';
    const changedOutput = '运行期间智能对话输出已修改，请重新运行该节点';

    function create(host) {
        const active = new Map();
        const failure = error => ({ ok: false, error });

        function current(job) {
            if (job.scope !== host.scope() || active.get(job.id) !== job) return null;
            const node = host.node(job.id);
            return node?.type === 'smart-agent' && node.running && node.runStartedAt === job.startedAt ? node : null;
        }

        function finish(node, error) {
            node.running = false;
            node.runFinishedAt = host.now();
            node.runElapsedMs = Math.max(0, node.runFinishedAt - Number(node.runStartedAt || node.runFinishedAt));
            if (error) node.runError = error;
        }

        async function run(node, signal) {
            if (signal?.aborted) return failure(host.cancelled);
            if (node.running) return;
            const message = host.message(node);
            const references = host.references(node);
            if (references.some(ref => ref.sourceMissing)) return failure('引用已失效，请移除后重新选择');
            if (!message && !references.length) return failure('请填写用户要求或连接图片 / 文件 / 文本节点');

            const scope = host.scope();
            const controller = new AbortController();
            const job = { id: node.id, scope, controller, startedAt: host.now() };
            const signature = host.signature(node);
            const previousOutput = String(node.outputText ?? '');
            active.set(job.id, job);
            Object.assign(node, {
                running: true, runStartedAt: job.startedAt, runFinishedAt: 0, runElapsedMs: 0, runTimerHidden: false,
            });
            delete node.runError;

            let timedOut = false;
            const timer = root.setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, requestTimeout);
            let error;
            try {
                host.paint();
                const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                if (!host.configReady()) throw new Error('模型列表尚未加载，请稍后重试');
                const { provider, model } = host.model(node);
                if (!host.available(provider, model)) throw new Error('智能对话节点所选平台或模型不可用，请重新选择');
                const response = await root.fetch('/api/canvas-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: requestSignal,
                    body: JSON.stringify({
                        message: message || '请分析连接的参考内容并给出结果。',
                        messages: [],
                        ...host.media(references),
                        provider, model, system_prompt: host.system(node),
                    }),
                });
                if (!response.ok) throw new Error(await host.responseError(response));
                const data = await response.json();
                requestSignal.throwIfAborted();
                const target = current(job);
                if (!target) return failure(switched);
                if (host.signature(target) !== signature) throw new Error(changedInputs);
                if (String(target.outputText ?? '') !== previousOutput) throw new Error(changedOutput);

                const text = String(data?.text || '').trim();
                if (!text) throw new Error('智能对话没有返回文本');
                Object.assign(target, { outputText: text, agentProvider: provider, agentModel: model });
                host.outputChanged();
                return { ok: true, text };
            } catch (reason) {
                if (!current(job)) return failure(switched);
                error = signal?.aborted ? host.cancelled
                    : timedOut ? '智能对话等待超过 5 分 30 秒，已停止等待；请检查 Antigravity CLI 或切换模型后重试'
                    : controller.signal.aborted ? host.cancelled
                    : String(reason?.message || '智能对话运行失败');
                return failure(error);
            } finally {
                root.clearTimeout(timer);
                const target = current(job);
                if (active.get(job.id) === job) active.delete(job.id);
                if (target) {
                    finish(target, error);
                    host.paint();
                    host.save();
                }
            }
        }

        function cancel(id) {
            const job = active.get(id);
            if (!job || !current(job)) return false;
            job.controller.abort();
            return true;
        }

        function recover(node) {
            if (node?.type !== 'smart-agent' || !node.running) return false;
            const job = active.get(node.id);
            if (job && current(job)) return false;
            finish(node, String(node.outputText || '').trim()
                ? '上一次 Agent 请求已中断，已保留此前输出；请重新运行'
                : '上一次 Agent 请求已中断，请重新运行');
            delete node.dependencyRunSignature;
            return true;
        }

        return { run, cancel, finish, recover };
    }

    root.XiaomeiSmartAgentExecution = { create };
})(window);
