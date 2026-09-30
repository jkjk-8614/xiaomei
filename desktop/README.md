# 小美画布桌面版商品分析台

这是一个自建 Electron 壳，不依赖、也不打包 `D:\达笔\dabi` 的安装包、asar、扩展或编译资源。

## 开发启动（Windows）

1. 在项目根目录运行 `npm install --prefix desktop`（只安装 Electron 开发依赖；需要可用的 Node.js/npm）。
2. 双击项目根目录 `run.bat`；它会在后台启动服务并进入完整的小美画布，商品分析是画布内的工作区。开发时也可运行 `desktop\start.bat`，两者都会优先调用带中文名称和图标的 `desktop\node_modules\electron\dist\小美画布.exe`，不会留下控制台窗口。
3. Electron 会尝试启动本地 FastAPI（默认 `http://127.0.0.1:3000`）。若该端口已有服务，会直接复用。

启动后进入完整的小美画布，默认聚焦商品分析工作区；左侧导航仍可切换在线生图、GPT 对话、小美画布、电商工作台等原有入口。

### 在桌面端加入协同画布

接收方进入“小美画布”页面，点击画布列表顶栏的“加入协同”，粘贴分享者复制的完整邀请链接（包含 `token`）。桌面端会打开独立的协同窗口，实时连接分享者电脑上的画布服务器；分享者需要保持小美画布运行。该入口不会把共享画布复制到接收方的本地项目，协同窗口内的“返回画布列表”会关闭窗口。

生图成功或失败时，桌面版通过 Electron 原生 Windows 通知发送结果；普通浏览器使用网页通知回退。修改桌面通知相关代码（`desktop/main.cjs`、`desktop/preload.cjs`）后，需要完全退出并重新打开“小美画布”，仅刷新页面不会重新加载桌面桥接。

桌面版中间区域使用按站点隔离的持久会话显示淘宝、天猫、1688、千牛、生意参谋、达摩盘、小红书和抖音页面：淘宝/天猫使用 `persist:xiaomei-commerce`，1688 使用 `persist:xiaomei-1688`，千牛/生意参谋使用独立的 `persist:xiaomei-qianniu`，三组会话的 Cookie、LocalStorage 和登录态互不影响。工作应用还可打开亚马逊、TikTok Shop、Temu、虾皮 Shopee、Ozon、eBay、速卖通和 SHEIN 的官方页面作跨境选品浏览；亚马逊会在内嵌会话中自动协商简体中文并保留亚马逊语言偏好，其中 Ozon 使用 `persist:xiaomei-ozon-direct` 独立直连会话，不继承 Windows 系统代理，其他平台仍遵从系统网络设置；这些页面不启用商品采集或网页智能体。淘宝商品卡片打开的详情页会被拦截为小美画布内部的新标签，保留淘宝首页标签；详情标签默认隐藏右侧“问问小美”面板，右上角按钮可以恢复。用户必须在可见官方页面手动登录；壳不读取密码、Cookie、Authorization，不绕过验证码。

点击“自动分析商品”后，Electron 的商品采集 Agent 先用 CDP 截图识别当前可见页面，再用固定白名单目标执行鼠标点击、滚轮和必要的键盘事件；评价/问大家样本只从当前动作触发的 `rateList`/`questionList` 网络响应解析。通用网页智能体仍只执行固定的 `inspect`、`scroll`、`click_tab`、`expand`、`paginate`、`extract`、`wait`、`finish` 动作，不能提交脚本、CSS 选择器、URL、账号输入或购买/店铺修改操作。会话、动作和证据摘要写入商品分析 SQLite；“清除会话”只在用户主动确认后清理淘宝/天猫和 1688 会话，不会清除千牛公司的 `persist:xiaomei-qianniu`。

商品分析报告可导出 JSON、Markdown 与带 UTF-8 BOM 的 CSV；CSV 由实际评价、问大家、SKU 和已捕获运营数据组成。视频只展示页面真实返回的资源；未发现资源时报告明确标为未返回，未配置 FFmpeg 时不伪造抽帧结果。

## 安全边界

- 远程页面 `contextIsolation`、`sandbox` 开启，关闭 Node 权限。
- 只允许工作应用中的国内平台、八个跨境平台及本地服务白名单导航；跨境平台只允许页面浏览，商品采集和网页智能体仍限于原有商品分析白名单。
- 运营数据与人群结构捕获只读取当前白名单页面可见 DOM，或读取用户通过官方导出后主动选择的 CSV；进入 FastAPI 前再次清理敏感字段，随后转换为达笔兼容的两种报表结构。壳不读取或持久化商品站点的 Cookie、Authorization；用户粘贴的画布分享 token 仅用于打开对应的协同窗口，也不调用达笔私有接口。

根目录 `run.bat` 始终进入 Electron 桌面端，不会回退到系统浏览器。没有 Electron 依赖时会弹出安装提示，请先执行 `npm install --prefix desktop`；普通浏览器不再作为项目启动入口。商品分析所需的淘宝/天猫页面仍由桌面端内部的 `WebContentsView` 承载。

若 npm 只安装了 Electron 包但没有下载二进制，可在 Windows PowerShell 执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd rebuild electron` 后再运行桌面版。

应用显示名固定为“小美画布”，Windows 应用图标使用 `static\images\app-icon-source.jpg` 生成的 `static\images\app-icon.ico`。如果重新安装 Electron 运行时，需要重新生成/写入 `node_modules\electron\dist\小美画布.exe` 后，启动器才会继续显示中文进程名；找不到该文件时会安全回退到 Electron 开发运行时。
