(function (global) {
    'use strict';

    const endpoint = '/api/asset-library/items/';
    const sameGroup = (left, right) => left.libraryId === right.libraryId && left.categoryId === right.categoryId;

    function create(host) {
        const document = global.document.createElement('template').content.ownerDocument;
        let clipboard;
        let busy = false;

        function capture(ids, owner) {
            const items = host.records(owner);
            const result = [];
            for (const id of ids) {
                const matches = items.filter(record => record.item.id === id);
                if (matches.length > 1) {
                    host.notice('多个分组存在同 ID 素材，请从对应分组操作');
                    return [];
                }
                if (matches.length) {
                    const { categoryId, item } = matches[0];
                    result.push({ category_id: categoryId, id, url: item.url || '', name: item.name || 'asset' });
                }
            }
            return result;
        }
        function set(mode) {
            const origin = host.scope();
            const entries = capture(host.selection(), origin);
            if (!entries.length) return;
            clipboard = { mode, origin, entries };
            host.clearSelection();
            host.redraw();
            host.notice((mode === 'cut' ? '剪切' : '复制') + '了 ' + entries.length + ' 个素材，切换分组后粘贴');
        }
        function view() {
            if (!clipboard) return '';
            const target = host.scope();
            const same = clipboard.origin.libraryId === target.libraryId
                && clipboard.entries.every(entry => entry.category_id === target.categoryId);
            const blocked = clipboard.mode === 'cut' && same;
            const bar = document.createElement('div');
            bar.className = 'asset-clipboard-bar';
            bar.innerHTML = '<div class="asset-clipboard-info"><i data-lucide="clipboard"></i><span></span></div>'
                + '<div class="asset-tools"><button class="asset-btn primary" type="button" data-asset-paste-clipboard>'
                + '<i data-lucide="clipboard-paste"></i><span></span></button>'
                + '<button class="asset-icon-btn" type="button" data-asset-clear-clipboard title="清空剪贴板"><i data-lucide="x"></i></button></div>';
            bar.querySelector('.asset-clipboard-info span').textContent =
                (clipboard.mode === 'cut' ? '剪切' : '复制') + '了 ' + clipboard.entries.length + ' 个素材';
            const paste = bar.querySelector('[data-asset-paste-clipboard]');
            paste.disabled = busy || blocked || !target.categoryId;
            paste.querySelector('span').textContent = blocked ? '选择其他分组后粘贴' : '粘贴到当前分组';
            return bar.outerHTML;
        }
        const post = (action, body) => host.request(endpoint + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const selection = entries => ({
            ids: entries.map(entry => entry.id),
            sources: entries.map(({ category_id, id, url }) => ({ category_id, id, url })),
        });
        async function run(work, failure) {
            if (busy) return;
            busy = true;
            host.redraw();
            try {
                await work();
            } catch (error) {
                host.notice(error.message || failure);
            } finally {
                busy = false;
                host.redraw();
            }
        }
        async function copy(current, target) {
            let count = 0;
            const remaining = new Set(current.entries);
            try {
                for (let index = 0; index < current.entries.length; index += 200) {
                    const batch = current.entries.slice(index, index + 200);
                    const reply = await post('batch', {
                        library_id: target.libraryId, category_id: target.categoryId,
                        items: batch.map(({ url, name }) => ({ url, name })),
                    });
                    host.apply(reply);
                    const copied = reply.copied_indices || (reply.items?.length === batch.length ? batch.map((_, i) => i) : []);
                    for (const offset of copied) if (remaining.delete(batch[offset])) count++;
                }
                host.notice('已复制 ' + count + ' 个素材' + (remaining.size ? '，' + remaining.size + ' 个未复制' : ''));
            } finally {
                if (clipboard === current) clipboard = remaining.size ? { ...current, entries: [...remaining] } : null;
            }
        }
        function paste() {
            const current = clipboard;
            const target = host.scope();
            if (!current || !target.categoryId) return;
            if (current.mode === 'copy') return run(() => copy(current, target), '复制素材失败');
            const entries = current.entries.filter(entry => !sameGroup(target, {
                libraryId: current.origin.libraryId, categoryId: entry.category_id,
            }));
            if (!entries.length) return;
            return run(async () => {
                const reply = await post('move', {
                    library_id: current.origin.libraryId, target_library_id: target.libraryId, target_category_id: target.categoryId,
                    ...selection(entries),
                });
                host.apply(reply);
                if (clipboard === current) clipboard = null;
                host.notice('已移动 ' + (reply.moved ?? entries.length) + ' 个素材');
            }, '移动素材失败');
        }
        function remove(ids) {
            const origin = host.scope();
            const entries = capture(ids, origin);
            if (!entries.length) return;
            return run(async () => {
                const reply = await post('delete', { library_id: origin.libraryId, ...selection(entries) });
                host.apply(reply);
                if (host.isCurrent(origin)) host.removeSelection(entries.map(entry => entry.id));
                host.notice('已将 ' + (reply.removed ?? entries.length) + ' 个素材移入回收站');
            }, '移入回收站失败');
        }
        return { set, view, paste, remove, clear() { clipboard = null; host.redraw(); } };
    }

    global.XiaomeiAssetManagerTransfers = { create };
}(window));
