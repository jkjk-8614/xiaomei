/* Shared task presentation for the discussion, task list and workspace. */
(() => {
    'use strict';
    const phases = {
        intake: ['理解需求', 'bot_director', 'thinking'],
        reference_analysis: ['参考分析', 'bot_reference', 'searching'],
        planning: ['制定方案', 'bot_planner', 'thinking'],
        awaiting_confirmation: ['等待确认方案', 'bot_director', 'waiting'],
        executing: ['生成图片', 'bot_executor', 'working'],
        quality_check: ['质量检查', 'bot_reviewer', 'searching'],
        revision: ['修正图片', 'bot_executor', 'working'],
        delivered: ['已完成', 'bot_director', 'done'],
        failed: ['任务失败', 'bot_director', 'alert'],
        cancelled: ['已取消', 'bot_director', 'idle'],
    };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
    function activity(task) {
        const [label, botId, motion] = phases[task.status] || ['处理任务', 'bot_director', 'working'];
        const shots = task.execution?.shots || [];
        const total = Math.max(Number(task.brief?.image_count) || 0, task.plan?.shots?.length || 0, shots.length);
        const succeeded = shots.filter(shot => shot.status === 'succeeded').length;
        const failed = shots.filter(shot => shot.status === 'failed').length;
        const resolved = shots.filter(shot => ['succeeded', 'failed', 'skipped'].includes(shot.status)).length;
        const active = !['awaiting_confirmation', 'delivered', 'failed', 'cancelled'].includes(task.status);
        const generating = ['executing', 'revision'].includes(task.status);
        const started = [...(task.events || [])].reverse().find(event => event.phase === task.status && event.type === 'phase_started');
        return {label, botId, motion, active, total, succeeded, failed, resolved,
            since: started?.at || task.created_at || 0,
            detail: generating && total ? `已生成 ${succeeded}/${total} 张${failed ? ` · ${failed} 张失败` : ''}`
                : task.status === 'planning' && total ? (task.plan?.shots?.length
                    ? `已规划 ${task.plan.shots.length}/${total} 张`
                    : `正在制定 ${total} 张方案${task.usage?.llm_calls ? ` · 已调用模型 ${task.usage.llm_calls} 次` : ''}`)
                : task.status === 'awaiting_confirmation' ? '确认方案后开始生图'
                : task.status === 'failed' ? (task.error || '打开任务查看原因并重试')
                : task.status === 'delivered' && total ? `已生成 ${succeeded}/${total} 张${task.design?.acceptance?.status === 'passed' ? ' · 已审核通过' : task.design?.acceptance?.status === 'needs_human' ? ' · 需要人工复核' : task.design?.acceptance?.status === 'needs_fix' ? ' · 有待修改项' : ''}` : '',
            measured: generating && total > 0};
    }
    function markup(task) {
        const view = activity(task);
        const meter = view.measured
            ? `<progress class="design-progress-meter" max="${view.total}" value="${view.resolved}" aria-label="图片处理进度"></progress>`
            : view.active ? '<span class="design-progress-indeterminate" aria-label="正在处理"></span>' : '';
        return `<div class="design-task-progress" data-phase="${escape(task.status)}"><span class="design-progress-line"><span>${escape(view.label)}</span>${view.detail ? `<small title="${escape(view.detail)}">${escape(view.detail)}</small>` : ''}</span>${meter}</div>`;
    }
    function elapsed(since) {
        const stamp = Number(since);
        if (!stamp) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - (stamp < 1e12 ? stamp * 1000 : stamp)) / 1000));
        return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    }
    window.DesignBrainProgress = {activity, markup, elapsed};
})();
