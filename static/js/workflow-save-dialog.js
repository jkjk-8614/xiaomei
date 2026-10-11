(function (global) {
    'use strict';

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));

    function normalizeLibraries(payload) {
        const library = payload?.library || payload || {};
        return Array.isArray(library.libraries) ? library.libraries : [];
    }

    function workflowCategories(library) {
        return (library?.categories || []).filter(category => String(category.type || '').toLowerCase() === 'workflow');
    }

    function resourceCount(workflow, fallback = 0) {
        if (global.XiaomeiWorkflowPreview?.resourceCount) {
            return global.XiaomeiWorkflowPreview.resourceCount(workflow);
        }
        return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
    }

    function previewMarkup(workflow, name) {
        if (global.XiaomeiWorkflowPreview?.markup) {
            return global.XiaomeiWorkflowPreview.markup(workflow || {}, { name });
        }
        return '<div class="workflow-preview-empty">暂无预览</div>';
    }

    function removeDialog(root) {
        root?.remove();
        document.body.classList.remove('workflow-save-dialog-open');
    }

    async function open(options = {}) {
        const initialName = String(options.name || '工作流').trim() || '工作流';
        const workflow = options.workflow || { nodes: [], connections: [] };
        let libraries = [];
        try {
            const response = await fetch('/api/asset-library');
            if (!response.ok) throw new Error('资产库加载失败');
            libraries = normalizeLibraries(await response.json());
        } catch (error) {
            throw new Error(error.message || '资产库加载失败');
        }

        const workflowLibraries = libraries.filter(library => workflowCategories(library).length);
        const availableLibraries = workflowLibraries.length ? workflowLibraries : libraries;
        if (!availableLibraries.length) throw new Error('暂无可用的资产库');

        const preferredLibrary = String(options.libraryId || '');
        const library = availableLibraries.find(item => item.id === preferredLibrary) || availableLibraries[0];
        const categories = workflowCategories(library);
        if (!categories.length) throw new Error('暂无工作流分类，请先在资产管理中创建工作流分组');
        const preferredCategory = String(options.categoryId || '');
        const category = categories.find(item => item.id === preferredCategory) || categories[0];
        const nodeCount = Number(options.nodeCount ?? workflow.nodes?.length ?? 0) || 0;
        const connectionCount = Number(options.connectionCount ?? workflow.connections?.length ?? 0) || 0;
        const detectedResources = resourceCount(workflow, options.resourceCount);
        const includeResources = options.includeResources !== false;

        const root = document.createElement('div');
        root.className = 'xiaomei-workflow-dialog-backdrop';
        root.innerHTML = `
            <section class="xiaomei-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="xiaomeiWorkflowDialogTitle">
                <header class="xiaomei-workflow-dialog-head">
                    <div><strong id="xiaomeiWorkflowDialogTitle">收藏工作流</strong><span>填写名称、资产库和分类后再保存</span></div>
                    <button class="xiaomei-workflow-dialog-close" type="button" aria-label="关闭">×</button>
                </header>
                <div class="xiaomei-workflow-dialog-body">
                    <div class="xiaomei-workflow-dialog-preview-canvas">${previewMarkup(workflow, initialName)}<span>保存前预览</span></div>
                    <div class="xiaomei-workflow-dialog-preview">
                        <div class="xiaomei-workflow-dialog-stat"><small>节点</small><strong>${nodeCount}</strong></div>
                        <div class="xiaomei-workflow-dialog-stat"><small>连线</small><strong>${connectionCount}</strong></div>
                        <div class="xiaomei-workflow-dialog-stat"><small>资源</small><strong>${detectedResources}</strong></div>
                    </div>
                    <label class="xiaomei-workflow-dialog-field"><span>工作流名称</span><input name="workflow-name" maxlength="120" required value="${esc(initialName)}" placeholder="例如：商品主图生成流程"></label>
                    <div class="xiaomei-workflow-dialog-row">
                        <label class="xiaomei-workflow-dialog-field"><span>资产库</span><select name="workflow-library">${availableLibraries.map(item => `<option value="${esc(item.id)}" ${item.id === library.id ? 'selected' : ''}>${esc(item.name || '资产库')}</option>`).join('')}</select></label>
                        <label class="xiaomei-workflow-dialog-field"><span>工作流分类</span><select name="workflow-category">${categories.map(item => `<option value="${esc(item.id)}" ${item.id === category.id ? 'selected' : ''}>${esc(item.name || '工作流')}</option>`).join('')}</select></label>
                    </div>
                    <label class="xiaomei-workflow-dialog-field"><span>描述（可选）</span><input name="workflow-description" maxlength="2000" placeholder="说明适用场景、输入和输出"></label>
                    <label class="xiaomei-workflow-dialog-check"><input name="workflow-resources" type="checkbox" ${includeResources ? 'checked' : ''}><span>保存工作流引用的资源文件（${detectedResources} 个）</span></label>
                    <div class="xiaomei-workflow-dialog-error" hidden></div>
                </div>
                <footer class="xiaomei-workflow-dialog-foot"><button type="button" data-cancel>取消</button><button class="primary" type="button" data-confirm>保存到资产库</button></footer>
            </section>`;
        document.body.appendChild(root);
        document.body.classList.add('workflow-save-dialog-open');

        const panel = root.querySelector('.xiaomei-workflow-dialog');
        const nameInput = root.querySelector('[name="workflow-name"]');
        const librarySelect = root.querySelector('[name="workflow-library"]');
        const categorySelect = root.querySelector('[name="workflow-category"]');
        const errorNode = root.querySelector('.xiaomei-workflow-dialog-error');
        const close = (error) => {
            removeDialog(root);
            if (error) return Promise.reject(new Error(error));
            return Promise.reject(new Error('已取消收藏'));
        };
        const result = new Promise((resolve, reject) => {
            const finish = value => { removeDialog(root); resolve(value); };
            const cancel = () => { removeDialog(root); reject(new Error('已取消收藏')); };
            root.querySelector('.xiaomei-workflow-dialog-close').addEventListener('click', cancel);
            root.querySelector('[data-cancel]').addEventListener('click', cancel);
            root.addEventListener('click', event => { if (event.target === root) cancel(); });
            root.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
            librarySelect.addEventListener('change', () => {
                const selectedLibrary = availableLibraries.find(item => item.id === librarySelect.value) || availableLibraries[0];
                const nextCategories = workflowCategories(selectedLibrary);
                categorySelect.innerHTML = nextCategories.map(item => `<option value="${esc(item.id)}">${esc(item.name || '工作流')}</option>`).join('');
            });
            root.querySelector('[data-confirm]').addEventListener('click', () => {
                const name = String(nameInput.value || '').trim();
                if (!name) {
                    errorNode.textContent = '请填写工作流名称';
                    errorNode.hidden = false;
                    nameInput.focus();
                    return;
                }
                const selectedLibrary = availableLibraries.find(item => item.id === librarySelect.value) || availableLibraries[0];
                const selectedCategory = workflowCategories(selectedLibrary).find(item => item.id === categorySelect.value) || workflowCategories(selectedLibrary)[0];
                if (!selectedCategory) {
                    errorNode.textContent = '请选择工作流分类';
                    errorNode.hidden = false;
                    return;
                }
                finish({
                    name,
                    description: String(root.querySelector('[name="workflow-description"]')?.value || '').trim(),
                    libraryId: selectedLibrary.id,
                    categoryId: selectedCategory.id,
                    includeResources: !!root.querySelector('[name="workflow-resources"]')?.checked,
                });
            });
            nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') root.querySelector('[data-confirm]').click(); });
        });
        nameInput.focus();
        nameInput.select();
        return result;
    }

    global.XiaomeiWorkflowSaveDialog = { open };
})(window);
