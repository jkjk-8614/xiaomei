# DeepSeek Harness 适配补丁

`vendor/deepseek-harness` 是上游仓库的克隆。小美画布对它的改动（模型路由、桌面 Host 适配、
两级模型菜单……）**都以「未提交的工作树改动」形式存在**，`xiaomei-adapter.patch` 是它的快照。

## 先说结论

上游更新**不会**让这些改动消失，`desktop/deepseek-updater.cjs` 已经处理了：

1. 更新前 `git diff --binary HEAD` 存一份补丁；
2. 在一个临时克隆里先 `git apply --3way` **预检**，冲突就在动真格之前中止，工作树一点不动；
3. 真更新时 `reset --hard` → `merge --ff-only` → 重新 `apply --3way`；
4. 失败则回滚到原提交并把补丁打回去。

所以真正需要人工介入的只有一种情况：**上游改到了同一段代码，3-way 合不上**。
这时更新会报「适配补丁与上游冲突：<文件列表>」，工作树保持更新前的样子。

## 两条铁律

- **不要在 `vendor/deepseek-harness` 里 commit。** 一旦 HEAD 领先上游，`merge --ff-only` 直接失败，
  更新会报「本地版本与上游分叉」；而且 `git diff HEAD` 会变空，补丁也就存不下来了。
  改动请保持未提交（staged 无所谓，`diff HEAD` 都看得见）。
- **不要 `git checkout .` / `reset --hard` 清工作树。** 那等于把适配删了。真删了用下面的 `apply` 恢复。

## 工具

```bash
node desktop/harness-patch.cjs status    # 补丁是否与工作树一致、能否干净重放
node desktop/harness-patch.cjs save      # 把当前改动存成补丁（含新增文件）
node desktop/harness-patch.cjs verify    # 在临时克隆里试重放，不动工作树
node desktop/harness-patch.cjs apply     # 把补丁 3-way 重放到工作树（已打过则跳过）
node desktop/harness-patch.cjs rebuild   # 重建产物，--host / --web 可选
```

补丁同时写两份：`desktop/harness-patches/xiaomei-adapter.patch`（随应用仓库走，可评审）
和 `.xiaomei-data/deepseek-harness-adapter.patch`（运行时稳定副本，更新器也会刷新它）。

## 上游冲突了怎么办

```bash
# 1. 先确认现状
node desktop/harness-patch.cjs status

# 2. 重放，留下冲突标记
node desktop/harness-patch.cjs apply
#    → 报「补丁与上游冲突：packages/client/ui-model-selection/src/client/ModelSelect.tsx」

# 3. 手工合并冲突文件（搜索 <<<<<<< / >>>>>>>），保留上游的新逻辑 + 我们的定制
#    改完删掉冲突标记

# 4. 重建 + 验证
node desktop/harness-patch.cjs rebuild
cd vendor/deepseek-harness
node node_modules/vitest/vitest.mjs run packages/client/ui-model-selection/tests

# 5. 把新状态固化回补丁
cd ../../ && node desktop/harness-patch.cjs save
```

## 升级时哪些文件最容易冲突

按冲突概率从高到低：

| 文件 | 改动性质 | 说明 |
| --- | --- | --- |
| `packages/client/ui-model-selection/src/client/ModelSelect.tsx` | 结构性 | 两级菜单（平台列表 → 模型列表），上游重构这个组件时几乎必冲突 |
| `.../ModelSelect.module.css` | 纯追加 | `.cell*` / `.back*`，冲突概率低 |
| `.../locales.ts` | 纯追加 | `menu.back` / `provider.count`，冲突概率低 |
| `.../tests/model-select.client.spec.tsx` | 跟随 | 测试跟着组件走；上游改测试时以新的为准，重跑再改 |
| `packages/llm/llm-pi-ai/**` | 适配 | 上游 provider 协议变更时会碰 |
| `apps/desktop-host/src/index.ts` | 单行 | 端口/入口适配 |

`ModelSelect.tsx` 的冲突不需要从零重写：把上游的新版本拿过来，照 `xiaomei-adapter.patch` 里
这一段 hunk 重新套一遍即可，具体是四件事——

1. `Pane` 的 `root` 语义改成平台列表，新增 `providerId` state；
2. 根面板渲染 `groups.map(...)` 的平台行（平台名 + 当前模型或「N 个模型」+ `›`），末尾保留推理等级行；
3. 模型面板加返回头（`‹ 平台名 / 返回平台`），列表从按 provider 分组改成单平台平铺；
4. `openProvider` / `drillEffort` / `back` 三个跳转函数，以及 `rootFocusIndex` 的焦点归位。

## 更彻底的办法（还没做）

如果以后上游频繁重构 `ModelSelect`，可以考虑把这套定制从「改上游文件」改成
「独立客户端插件 + 在 `cordis.patch.yml` 里禁用上游 `ui-model-selection`」。
那样升级永远不冲突，代价是要自己复刻整个 seat（目录 store、select verb、label slot），
并跟着上游的内部 API 走——长期看未必更省心，目前先用补丁方案。
