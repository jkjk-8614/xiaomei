# 小美画布 ComfyUI 桥接插件

此插件让小美画布把工作流载入 ComfyUI 高级编辑器，并提供操作表单转换和模型下载消息桥接。

## 安装

1. 找到当前正在运行的 ComfyUI 的 `custom_nodes` 目录。Windows 便携版通常在 `ComfyUI_windows_portable\ComfyUI\custom_nodes`；使用自定义节点目录时，以该服务的实际目录为准。
2. 退出该 ComfyUI 服务。解压安装包，将整个 `xiaomei_app_bridge` 文件夹放入 `custom_nodes`。
3. 确认目录为 `custom_nodes\xiaomei_app_bridge\__init__.py` 和 `custom_nodes\xiaomei_app_bridge\web\bridge.js`，不要多套一层压缩包文件夹。
4. 重新启动 ComfyUI 服务，再回到小美画布重新打开高级编辑。只刷新页面不会让后台加载新插件。

插件使用 ComfyUI 自带的依赖，无需另外安装模型或 Python 包。不要覆盖或删除其他插件、模型及工作流。

## 仍然无法连接

- 查看 ComfyUI 启动日志，确认 `xiaomei_app_bridge` 没有导入错误。
- 确认没有通过 `--disable-all-custom-nodes` 禁用此插件；使用白名单时加入 `xiaomei_app_bridge`。
- 在 ComfyUI 前端的扩展设置中确认 `Xiaomei.NativeAppBridge` 已启用，再刷新编辑器。
- 确认小美画布连接的是安装插件后重新启动的那一个 ComfyUI 地址。

插件只接收来自本机小美画布父页面的消息。它不会自动下载模型、执行工作流或上传图片。
