# 小美画布视觉设计规范

## 方向

小美画布采用 Fluent 2 工作台视觉语言：中性表面、清晰边界、紧凑控件与可见的键盘焦点。设计依据为微软官方 [Fluent 2 Figma UI Kit](https://fluent2.microsoft.design/get-started/design)，运行界面使用 Fluent UI Web Components 与官方设计令牌。

## 设计变量

- 颜色、圆角、字体和阴影使用 `static/vendor/fluent/tokens.css` 中的官方令牌，不在各页面另建色板。
- `tools/fluent-ui/entry.js` 的 `syncTheme` 将现有外观偏好同步到组件主题；护眼与暖色使用对应的中性底色，自定义强调色自动选择明暗文字。
- `static/css/fluent-ui.css` 统一原生控件与 Fluent 组件的外观；保留内部 `--apple-*` 别名供现有页面引用，值映射到 Fluent 令牌。

## 应用到小美画布的规则

1. 保持 FastAPI 路由、请求参数、任务轮询、数据目录、iframe 通信、`postMessage` 消息和现有 DOM 功能不变。
2. 公共视觉规则放在 `static/css/fluent-ui.css`。业务操作保留原生 `button`、原有 ID、事件和可访问名称，避免主题资源加载状态影响键盘、禁用及事件代理行为。
3. 画布保留网格、节点、连线、缩放、平移、多选、拖线和撤销等工作能力，只调整材质、间距、边界和状态反馈。
4. 侧栏、工具栏、弹窗和 Agent 面板使用不透明中性表面、细边框和低层级阴影；选中项使用浅品牌底色与高对比文字。
5. 所有按钮、输入框、节点和任务卡保留 hover、active、focus、disabled、loading、empty 和 error 状态。
6. 同时支持浅色和深色主题，尊重用户已经保存的主题与缩放偏好。
7. 保持原生页面与 iframe 架构。Fluent 资源随源码本地分发，正常运行不需要 Node.js 或 CDN。重建方式见 [依赖与资源清单](交付文档/依赖与资源清单.md#2-浏览器端资源)。

## 交互基准

- 控件交互使用短时颜色、边框和透明度反馈；全局样式不得清除用于定位、拖拽或缩放的 `transform`。
- 只有层级、状态变化和用户操作需要动效时才使用动效。
- `prefers-reduced-motion: reduce` 下关闭非必要动画。
- 所有键盘焦点保持可见，正文和控件对比度满足可读性要求。
