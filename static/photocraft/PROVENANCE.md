# PhotoCraft 内置版本来源

本目录基于 [PhotoCraft](https://github.com/storytold/photocraft) 官方 WASM 静态站构建，包含下述本地兼容修复，由小美画布「PS 修图」页面通过同源 iframe 嵌入使用。

- 上游项目：https://github.com/storytold/photocraft
- 来源 Release：https://github.com/storytold/photocraft/releases/tag/v0.17.0
- 资产文件：`photocraft-web-0.17.0.zip`
- SHA-256：`9dbc979e138e83136d5958acd0cf7d1832aeae5095409eb4691dca577db5fc99`（与上游 `SHA256SUMS.txt` 一致）
- 许可证：MIT / Apache-2.0 双许可（见本目录 `LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE`、`ATTRIBUTION.md`）
- 品牌素材受上游单独许可约束；未移除也未复用其品牌素材做二次创作
- 解压时间：2026-10-31；解压后约 12.6 MB（19 个条目）

## 与上游 zip 的差异（本地修复）

- **新增 `app/snippets/eframe-d31a8450ea12dfc1/inline0.js`**：v0.17.0 的 zip 只在根目录带 `snippets/`，但 `app/photocraft-web.js`（wasm-bindgen glue）以 `./snippets/...` 静态导入该文件，相对 `app/` 解析为 `app/snippets/...`，按原样部署会 404 并导致应用永远停在加载页。修复为把根目录 `snippets/` 原样镜像一份到 `app/snippets/`（逐字节相同，280 字节）。上游若在新版修复布局，升级时可删除这份镜像。
- `app/photocraft-web.js` 的 `__wbg_info_971d8b9db3dae69f` 在 `GPUAdapter.info` 缺失时返回字符串字段齐全的描述对象，避免 WASM 随后读取 `description` 时中断；原生信息存在时原样返回。这不会改变渲染后端或补充 GPU 能力。
- 入口页在加载阶段显示脚本错误与未处理的 Promise 异常，并提供重新加载入口；启动模块和应用模块的导入 URL 带缓存版本，启动模块的 preload URL 与实际导入一致，SRI 按修改后的实际字节重算。
- 根目录 `.gitattributes` 对本目录禁用文本转换，防止 Windows Git 检出改写换行后使 SRI 失效。
- `fonts/manifest.txt` 在无 craft-fonts 的官方 zip 中本就不存在，应用会优雅回退（上游 Docker 构建同样 404），无需处理。

## 部署要求（来自上游 HOSTING.md / _headers）

- `.wasm` 必须以 `Content-Type: application/wasm` 返回（`main.py` 已显式注册 MIME）。
- 缓存：`index.html`、`app/photocraft-web.js`、`app/parts.txt` 为 `no-cache`；其余 hashed 文件（`*.wasm`、`*.js`、`app/*.part-*`）为 `public, max-age=31536000, immutable`（`main.py` 的 `ProjectStaticFiles` 已按路径前缀实现）。
- `app/*.part-*` 是已 gzip 的 wasm 分块，必须原样返回，**不得**再加 `Content-Encoding`。
- 缺失文件返回 404（StaticFiles 默认行为，不做 SPA 回退）。
- iframe 嵌入需 `allow="fullscreen; clipboard-read; clipboard-write"` 与 `allowfullscreen`（见 `static/index.html` 的 `frame-photocraft`）。
- 渲染选择与手动诊断参数见 `HOSTING.md` 的“Renderer selection and fallback flags”。桌面端 GPU 探测与 SwiftShader 回退由 `desktop/main.cjs` 管理；启动故障按[验收与故障排查](../../交付文档/06-验收与故障排查.md#ps-修图内置-photocraft卡在-loading-界面)中的顺序检查。
- 界面默认语言：壳层在首次使用前预置 `localStorage['photocraft.preferences']` 为 `{"interface":{"language":"zh-hans"}}`（`static/index.html` 顶部脚本），用户在应用内改语言后以其选择为准。

## 升级方法

1. 到上游 Releases 下载新版 `photocraft-web-<ver>.zip` 与 `SHA256SUMS.txt`，校验 sha256。
2. 清空本目录后解压（去掉压缩包内层目录），更新本文件的版本、SHA-256 与日期。
3. 如上游 `_headers`/`HOSTING.md` 的缓存或 MIME 要求变化，同步调整 `main.py` 中 `ProjectStaticFiles` 的 photocraft 缓存分支。
4. 回归验证：打开「PS 修图」页能加载出编辑器；`GET /static/photocraft/index.html` 为 200 且 no-cache；`app/*.part-*` 无 `Content-Encoding`。
5. 升级时检查上述本地修复是否仍需保留。修改脚本后同步更新版本参数和入口 SRI，运行 `node --test tests/photocraft-startup.test.cjs`，再用项目 Electron 执行 `tests/photocraft-startup.electron.cjs`。从发布安装包解出的资源还需重复执行；可通过 `PHOTOCRAFT_TEST_ROOT` 指向解包后的 PhotoCraft 目录。
