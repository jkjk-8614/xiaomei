# 第二阶段第三步：撤销、重做、复制、粘贴和快捷键

日期：2026-11-09

这一步只替换历史栈、复制粘贴的摆放和相关快捷键判断。保存读取、模型调度和素材管理仍在旧函数里。CainFlow、商品分析、SKU、批量生成、电商工作台、`LICENSE` 和版权声明都没有改。

交付当时默认走旧实现。下面的开关表是当时的记录，不是现在的操作方法。查询参数、`localStorage` 和 `setActive(false)` 已经去掉，运行时只走新内核，见 `docs/audits/kernel-defaults-next.md`。旧文件没有删除。

## 来源与做法

规格来自当前画布已经在用的操作：

- 经典画布只保留撤销，上限 30 帧，不提供重做。智能画布上限 40 帧；新的一步会清空重做栈，撤销把当前画面放进重做栈。
- 智能画布可以先记下一步待定快照，手势完成后再入栈，取消则丢掉。撤销恢复时如果节点仍在生成，保留当前任务结果，这个合并仍由原来的恢复函数做。
- 复制选中节点和它们之间的连线。粘贴时把这组节点的中心移到当前指针的世界坐标。分组里的成员 id、连线两端都改成新 id。智能画布在按住来源拖出时，可以保留画布上已有节点的入边。
- 快捷键：Ctrl/Cmd+Z 撤销；智能画布再加 Shift+Z 或 Ctrl/Cmd+Y 重做；Ctrl/Cmd+C 复制，Ctrl/Cmd+V 延迟 90 毫秒粘贴，好让图片粘贴先占用这次按键。输入框和已选中的文字不拦截。单独按 Z 仍是缩放预览。Ctrl/Cmd+G 成组，智能画布 Shift+G 解组。

新文件是 `static/js/xiaomei-history-kernel.js`。对照上游两份画布脚本，没有连续 8 行相同代码，最长相同行是 2 行和 3 行。

`node --test tests/xiaomei-history-kernel.test.cjs` 覆盖开关、有界撤销和重做、粘贴偏移、连线改 id，以及上述快捷键。

## 开关与回滚

| 操作 | 结果 |
| --- | --- |
| 什么都不做 | `data-xm-history="legacy"` |
| `?xmHistory=1` 或 `next` | 写入 `localStorage['xiaomei.historyKernel']='next'` |
| `?xmHistory=0` 或 `legacy` | 回到旧实现 |
| `XiaomeiHistoryKernel.setActive(false)` 后刷新 | 同上 |

视口仍用 `?xmViewport=1`，拖拽连线仍用 `?xmNodes=1`。三个开关互不影响。

## 最小适配层

旧的撤销恢复、提示、渲染和保存调用留在原文件。开关打开时，入栈、出栈、粘贴偏移、id 改写和快捷键判断走内核：

- `static/js/canvas.js`：撤销栈、复制数据、粘贴位置和连线、Ctrl/Cmd+Z/C/V/G 与单独的 Z。
- `static/js/smart-canvas.js`：撤销、重做、待定快照、粘贴位置和连线、Ctrl/Cmd+Z/Y/C/V/G。
- `static/canvas.html`、`static/smart-canvas.html`：加载内核并更新缓存参数。

## 手工验收

1. 不带参数打开两套画布。`document.documentElement.dataset.xmHistory` 为 `legacy`。撤销、复制、粘贴与现在一致。
2. 加上 `?xmHistory=1` 刷新。
3. 移动一个节点后 Ctrl/Cmd+Z。经典画布只撤销。智能画布再用 Shift+Z 或 Ctrl/Cmd+Y 重做。
4. 选中节点 Ctrl/Cmd+C，再 Ctrl/Cmd+V。副本出现在指针附近，组内成员和连线仍然接在一起。输入框里的复制粘贴仍交给浏览器。
5. 打开旧项目，已有节点和连线还在。单独按 Z 仍切换缩放预览。
6. `?xmHistory=0` 刷新后回到旧实现。

本环境完成了单测和语法检查，没有在桌面壳里用真实项目按快捷键。请在本机再走一遍。

## 还没做的事

保存读取、API 调度和素材管理留到后面的步骤。验收通过之前不要删除旧的撤销和复制代码。
