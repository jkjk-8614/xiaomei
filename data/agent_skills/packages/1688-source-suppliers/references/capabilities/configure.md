# AK 配置指南

## AK 未配置时自动获取

**当 CLI 返回 AK 未配置（needAuth: true）时，Agent 必须自动执行 `python3 cli.py get_ak`，不要询问用户选择哪种方式。**

```
AK 未配置 → 自动执行 python3 cli.py get_ak → 浏览器授权完成 → AK 即时生效 → 继续原查询
```

**不要**：询问用户"请提供 AK"或"选择哪种方式获取 AK"
**直接**：执行 `python3 cli.py get_ak`

## 浏览器获取 AK 详细流程

### 执行命令

```bash
python3 cli.py get_ak
```

### 授权页面地址

```
https://air.1688.com/app/tai/oauth_page/index.html
```

### 完整流程

```
1. 脚本启动本地回调服务器（监听 127.0.0.1，端口8080）
2. 构造授权 URL：
   https://air.1688.com/app/tai/oauth_page/index.html?mode=AK&state=<随机state>&redirect_uri=http://localhost:<port>/callback
3. 自动打开浏览器跳转到 1688 授权页面
4. 用户在浏览器中登录 1688 账号并确认授权
5. 1688 授权成功后，回调 redirect_uri，携带 AK 值
6. 本地回调服务器接收 AK，校验合法性后写入 ak_store.json
7. 浏览器页面显示"AK 设置成功"
8. CLI 输出 JSON：{"success": true, "markdown": "AK 设置成功", "data": {"ak": "<AK>"}}
```

### 授权 URL 参数说明

| 参数 | 值 | 说明 |
|------|-----|------|
| `mode` | `AK` | 固定值，表示 AK 获取模式（非 OAuth 授权模式） |
| `state` | 随机 URL-safe 字符串 | 安全校验（防 CSRF），回调时需原样回传 |
| `redirect_uri` | `http://localhost:<port>/callback` | 本地回调地址，`<port>` 为脚本自动检测的可用端口 |

### 关键说明

- **`redirect_uri` 中的 `localhost` 和端口号由脚本动态分配，不要硬编码**。平台只需执行 `python3 cli.py get_ak`，脚本会自动完成全部流程
- 回调服务器监听地址为 `127.0.0.1`，授权页面跳转地址为 `localhost`，两者指向同一本机
- 超时默认 300 秒，可通过 `python3 cli.py get_ak --timeout 600` 调整
- 浏览器鉴权完成后，AK 即时生效，无需再执行 `configure`
- 如果浏览器无法自动打开，脚本会输出授权 URL，用户可手动复制到浏览器打开

## AK 存储

AK 存储在本地 `{workspace}/.1688-AK/.ak_store.json` 文件中（与 1688-auth-skill-for-wukong 共享同一存储路径）。两个 skill 配置的 AK 相互可见，无需重复配置。

## Agent 配置流程（核心）

### 场景 1：AK 未配置（自动处理）

当查询返回 `needAuth: true` 时，**自动执行**：

```
1. 执行 python3 cli.py get_ak（自动打开浏览器获取 AK）
2. 等待浏览器授权完成
3. get_ak 返回 success=true → AK 已自动写入，继续原查询
4. get_ak 返回 success=false → 告知用户获取失败，请手动提供 AK 字符串
```

### 场景 2：用户主动提供 AK

用户直接告知 AK 字符串时：

```
1. 从用户消息中提取 AK 字符串
2. 执行 cli.py configure <AK>
3. 检查输出：success=true → 继续；success=false → 原样输出 markdown 错误信息
4. 配置成功后，AK 即时生效
5. 继续用户的原始请求
```

## CLI 调用

```bash
# 设置 AK
python3 cli.py configure YOUR_AK_HERE

# 查看 AK 状态
python3 cli.py configure --status

# 重置 AK（清除旧 Token + 配置新 AK）
python3 cli.py configure --reset YOUR_NEW_AK

# 清除 AK
python3 cli.py configure --clear

# 通过浏览器获取 AK
python3 cli.py get_ak
```

## 异常处理

| 场景 | Agent 应对 |
|------|-----------|
| configure 输出 success=false | 原样输出 markdown 错误信息（如 AK 长度不足、包含非法字符等） |
| 配置成功但后续命令仍报 AK 未配置 | 检查 AK 格式是否有效，必要时重新配置 |
| 用户问"我的 AK 在哪" | 自动执行 `cli.py get_ak` 通过浏览器获取 |
