# 小美画布 Photoshop 直连桥接（CEP）

这是不依赖 UXP Developer Tool 的本机直连版。面板轮询小美画布的 Photoshop 队列，并通过 Photoshop ExtendScript 将图片置入当前文档；没有打开文档时会在 Photoshop 中打开为新文档。

## 本机安装

把整个 `com.infinite.canvas.photoshop.bridge.cep` 文件夹复制到：

```text
%APPDATA%\Adobe\CEP\extensions\com.infinite.canvas.photoshop.bridge.cep
```

然后为当前用户开启 CEP 开发扩展加载（`CSXS.10`、`CSXS.11`、`CSXS.12` 的 `PlayerDebugMode=1`），重启 Photoshop，在“增效工具”菜单打开“小美画布 PS 直连桥接”。

服务地址默认是 `http://127.0.0.1:3000`。

AI 分层的“在 Photoshop 打开”会以新文档打开 PSD，保留独立图层和智能对象。更新时需要同时替换本目录的 `main.js` 与 `host.jsx`，再重新打开插件面板；只更新画布后端不能让旧插件获得此能力。普通图片仍按原来的方式置入当前文档。
