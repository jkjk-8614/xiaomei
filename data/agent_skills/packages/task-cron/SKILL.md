---
name: "定时任务管理"
description: "用自然语言创建提醒与定时任务，支持一次性提醒和循环提醒。用户说“提醒我”“X 后提醒”“每天 / 每周 / 每小时做某事”时触发。"
version: "0.2.0"
---

# 定时任务管理


## 功能

把用户的自然语言描述转换成定时任务，支持两类：

- **一次性任务**：到点触发一次后自动删除，例如“5 分钟后提醒我开会”。
- **循环任务**：按固定周期重复触发，例如“每天早上 9 点提醒我喝水”。
- **尽量简短推理过程** 但是不要忽略严格的流程，尤其是系统时间的处理和字段的取值要严格遵守约束

## 工作流程

### 1. 读取锚点（必须先做）

务必从上下文取当前时间和时区，作为后续计算的锚点：

规则：

- 用户没指定时区：用当前会话时区。
- 用户指定时区：用用户指定时区。
- 上下文里拿不到当前时间或时区：先询问用户，**不创建任务**。

### 2. 提取内容

从用户原话中删除时间表达，剩余部分作为提醒内容。

- 保留用户原话语气。
- 不改写、不润色、不扩写。
- 内容为空时使用 `"提醒事项"`。

### 3. 创建任务

调用 `cron` 工具 `add`。

取值约束：
- payload.kind 必须是 `agentTurn`
- delivery.mode 必须是 `none`

一次性任务：

```json
{
  "schedule": {
    "kind": "at",
    "at": "yyyy-MM-DDThh:mm:ss.000Z"
  },
  "deleteAfterRun": true,
  "payload": { "kind": "agentTurn", "message": "提醒内容" },
  "sessionTarget": "current",
  "delivery": { "mode": "none" }
}
```

循环任务：

```json
{
  "schedule": {
    "kind": "cron",
    "cron": "cron 表达式",
    "timezone": "当前时区"
  },
  "deleteAfterRun": false,
  "payload": { "kind": "agentTurn", "message": "提醒内容" },
  "sessionTarget": "current",
  "delivery": { "mode": "none" }
}
```

### 7. 回复用户

简短确认即可：

```text
设置好了，会在今天 15:51 本地时间提醒你：吃饭去吗。
```
