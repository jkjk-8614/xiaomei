# 小美画布工具 · Photoshop 面板

在 Photoshop 中浏览小美画布的资产库、画布资产和本地素材。可把图片置入当前文档，也可以将整张文档或选中图层导出为 PNG，存到可写的资产库分组或本地文件夹。生成和 Agent 标签页使用小美画布已配置的平台与工作流。

## 安装与连接

1. 启动小美画布和 Photoshop。在 Adobe UXP Developer Tool 中选择本目录的 `manifest.json` 并加载。面板清单要求 Photoshop 24.0 或以上。
2. 在 Photoshop 的「增效工具」中打开「小美画布工具」，进入设置。
3. 填写本机服务地址并点击「连接」。默认地址为 `127.0.0.1:3000`。如果小美画布使用了其他端口，按实际端口填写。
4. 开启「实时同步」后，资产库和画布收到更新时会自动刷新。画布资产可浏览和置入。上传目标可选资产库的图片分组及本地素材文件夹。

面板沿用已安装插件的标识及地址、素材来源、图层导出设置。Adobe 对 HTTP 的支持随操作系统和 UXP 版本而异。 [Photoshop UXP 网络文档](https://developer.adobe.com/photoshop/uxp/guides/uxp_guide/uxp-misc/network-io)

## 接口

| 用途 | 接口 |
| --- | --- |
| 浏览资产库、画布资产、本地素材 | `GET /api/asset-library`、`GET /api/canvas-assets`、`GET /api/local-assets` |
| 上传 PNG 到图片分组 | `POST /api/ai/upload-base64` 暂存字节，再由 `POST /api/asset-library/items` 保存到选中分组 |
| 上传 PNG 到本地素材 | `POST /api/local-assets/import-urls` 接收 Base64 和文件夹路径 |
| 同步资产库和画布 | `WS /ws/stats` 接收 `asset_library_updated` 和 `canvas_updated` |

面板的文件沿革见 [Infinite Canvas 原连接器](https://github.com/hero8152/Infinite-Canvas/tree/67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e/tools/photoshop-asset-connector)。
