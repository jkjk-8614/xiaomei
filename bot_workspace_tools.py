"""小美 Bot 工作区统一工具协议与服务端权限执行器。

实现 9 个统一 Bot 管理工具与 4 个长期记忆工具，并预留可扩展注册点供画布与设计能力挂载：
- Bot 管理：bot.list / bot.create / bot.read / bot.update / bot.archive / bot.restore /
            bot.delegate / bot.get_result / bot.cancel_task
- 长期记忆：memory.read / memory.remember / memory.forget / memory.recall

安全边界：
1. 所有参数经过严格 Pydantic 模型校验，拒绝敏感密钥与非法参数。
2. 每次调用都按「数据库当前 Bot 权限 ∩ 回合权限快照」实时复核，绝不信任模型声明。
3. 只有唯一默认总管理 Bot（bot_manager）可通过模型工具创建、修改、归档或恢复永久 Bot。
4. 专业 Bot 不能自我提权、不能创建总管理、不能跨权限边界委派，也不允许执行任意系统 Shell。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Set, Tuple, Type

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from bot_workspace_config import MANAGER_BOT_ID
from bot_workspace_store import (
    ALL_REGISTERED_TOOLS,
    BotWorkspaceError,
    BotWorkspaceStore,
    FORBIDDEN_TOOLS,
    MANAGER_ONLY_TOOLS,
    SPECIALIST_MAX_TOOLS,
    assert_no_secrets,
    sanitize_tool_permissions,
)


# ---------------------------------------------------------------------------
# 严格 Pydantic 参数定义
# ---------------------------------------------------------------------------


class _StrictArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BotListArgs(_StrictArgs):
    include_archived: bool = False
    query: str = Field(default="", max_length=80)


class BotReadArgs(_StrictArgs):
    bot_id: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=48)


class BotCreateArgs(_StrictArgs):
    bot_id: str = Field(default="", max_length=64)
    name: str = Field(min_length=1, max_length=48)
    role: str = Field(default="", max_length=200)
    system_instructions: str = Field(default="", max_length=12000)
    personality: str = Field(default="", max_length=2000)
    avatar: Dict[str, Any] = Field(default_factory=dict)
    chat_model: Dict[str, Any] = Field(default_factory=dict)
    vision_model: Dict[str, Any] = Field(default_factory=dict)
    image_model: Dict[str, Any] = Field(default_factory=dict)
    model_params: Dict[str, Any] = Field(default_factory=dict)
    skill_ids: List[str] = Field(default_factory=list, max_length=32)
    tool_permissions: Optional[List[str]] = None
    permission_ceiling: Optional[List[str]] = None
    delegation_policy: Dict[str, Any] = Field(default_factory=dict)
    canvas_policy: Dict[str, Any] = Field(default_factory=dict)
    is_manager: bool = False


class BotUpdateArgs(_StrictArgs):
    bot_id: str = Field(default="", max_length=64)
    target_name: str = Field(default="", max_length=48)
    name: Optional[str] = Field(default=None, max_length=48)
    role: Optional[str] = Field(default=None, max_length=200)
    system_instructions: Optional[str] = Field(default=None, max_length=12000)
    personality: Optional[str] = Field(default=None, max_length=2000)
    avatar: Optional[Dict[str, Any]] = None
    chat_model: Optional[Dict[str, Any]] = None
    vision_model: Optional[Dict[str, Any]] = None
    image_model: Optional[Dict[str, Any]] = None
    model_params: Optional[Dict[str, Any]] = None
    skill_ids: Optional[List[str]] = None
    tool_permissions: Optional[List[str]] = None
    permission_ceiling: Optional[List[str]] = None
    delegation_policy: Optional[Dict[str, Any]] = None
    canvas_policy: Optional[Dict[str, Any]] = None
    is_manager: Optional[bool] = None


class BotArchiveArgs(_StrictArgs):
    bot_id: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=48)
    reason: str = Field(default="", max_length=200)


class BotRestoreArgs(_StrictArgs):
    bot_id: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=48)


class BotDelegateArgs(_StrictArgs):
    target_bot_id: str = Field(default="", max_length=64)
    target_bot_name: str = Field(default="", max_length=48)
    goal: str = Field(min_length=1, max_length=8000)
    instructions: str = Field(default="", max_length=8000)
    context_refs: List[Any] = Field(default_factory=list, max_length=32)
    granted_permissions: Optional[List[str]] = None
    session_mode: str = Field(default="new_thread", max_length=24)
    idempotency_key: str = Field(default="", max_length=120)
    wait_for_result: bool = True


class BotGetResultArgs(_StrictArgs):
    delegation_id: str = Field(default="", max_length=64)
    turn_id: str = Field(default="", max_length=64)
    wait_if_running: bool = False


class BotCancelTaskArgs(_StrictArgs):
    delegation_id: str = Field(default="", max_length=64)
    turn_id: str = Field(default="", max_length=64)
    reason: str = Field(default="任务已由 Bot 工具请求停止", max_length=200)


class MemoryReadArgs(_StrictArgs):
    scope: str = Field(default="", max_length=20)
    limit: int = Field(default=30, ge=1, le=100)


class MemoryRememberArgs(_StrictArgs):
    content: str = Field(min_length=1, max_length=400)
    scope: str = Field(default="bot", max_length=20)
    source: str = Field(default="Bot总结", max_length=60)


class MemoryForgetArgs(_StrictArgs):
    memory_id: str = Field(default="", max_length=64)
    target: str = Field(default="", max_length=120)


class MemoryRecallArgs(_StrictArgs):
    query: str = Field(default="", max_length=80)
    limit: int = Field(default=15, ge=1, le=50)


class CanvasReadArgs(_StrictArgs):
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)


class CanvasListAssetsArgs(_StrictArgs):
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)


class CanvasDispatchRunArgs(_StrictArgs):
    goal: str = Field(min_length=1, max_length=12000)
    instructions: str = Field(default="", max_length=8000)
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)
    source_node_ids: List[str] = Field(default_factory=list, max_length=40)
    source_images: List[str] = Field(default_factory=list, max_length=40)
    generation_preferences: Dict[str, Any] = Field(default_factory=dict)
    allow_canvas_writes: bool = True
    allow_local_gpu: bool = False
    authorized_generations: int = Field(default=0, ge=0, le=40)
    max_children: int = Field(default=6, ge=0, le=6)
    idempotency_key: str = Field(default="", max_length=120)
    require_canvas_connection: bool = True


class CanvasQueryGenerationArgs(_StrictArgs):
    multi_agent_run_id: str = Field(default="", max_length=80)


@dataclass
class ToolSpec:
    name: str
    description: str
    args_model: Type[BaseModel]
    handler: Callable[..., Awaitable[Dict[str, Any]] | Dict[str, Any]]
    manager_only: bool = False
    usage_hint: str = ""


def _bot_summary(bot: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "bot_id": bot["bot_id"],
        "name": bot["name"],
        "role": bot["role"],
        "is_manager": bot["is_manager"],
        "status": bot["status"],
        "chat_model": bot["chat_model"],
        "image_model": bot["image_model"],
        "skills": [s["skill_id"] for s in bot.get("skills") or [] if s.get("enabled")],
        "tool_permissions": bot["tool_permissions"],
        "active_turn_count": bot["active_turn_count"],
    }


class BotWorkspaceToolExecutor:
    """统一工具调度器与服务端权限守卫。"""

    def __init__(
        self,
        *,
        host: Any,
        store: BotWorkspaceStore,
        multi_agent_adapter: Optional[Any] = None,
    ):
        self.host = host
        self.store = store
        self.multi_agent_adapter = multi_agent_adapter
        self._registry: Dict[str, ToolSpec] = {}
        self._approval_handlers: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self._register_builtin_tools()
        try:
            from bot_workspace_design_tools import register_design_tools
            register_design_tools(self)
        except ImportError:
            pass

    def register_tool(self, spec: ToolSpec) -> None:
        if spec.name in FORBIDDEN_TOOLS:
            raise ValueError(f"禁止注册系统危险工具：{spec.name}")
        self._registry[spec.name] = spec

    def register_approval_handler(self, tool_prefix: str, handler: Callable[..., Awaitable[Any]]) -> None:
        self._approval_handlers[tool_prefix] = handler

    def _register_builtin_tools(self) -> None:
        self.register_tool(ToolSpec(
            name="bot.list",
            description="列出当前工作区的永久 Bot 及其角色、模型、状态和权限",
            args_model=BotListArgs,
            handler=self._tool_bot_list,
            usage_hint='{"include_archived": false, "query": ""}',
        ))
        self.register_tool(ToolSpec(
            name="bot.create",
            description="（仅总管理）创建一个新的永久专业 Bot，支持配置角色、系统指令、独立动态模型、Skills 与受限权限",
            args_model=BotCreateArgs,
            handler=self._tool_bot_create,
            manager_only=True,
            usage_hint='{"name":"主图文案师","role":"电商主图卖点提炼","system_instructions":"...","skill_ids":[],"tool_permissions":["bot.list","bot.read","memory.read","memory.remember","canvas.read"]}',
        ))
        self.register_tool(ToolSpec(
            name="bot.read",
            description="读取指定永久 Bot 的完整档案、Skills、工具权限与近期任务状态",
            args_model=BotReadArgs,
            handler=self._tool_bot_read,
            usage_hint='{"bot_id": "bot_xxx"} 或 {"name": "主图文案师"}',
        ))
        self.register_tool(ToolSpec(
            name="bot.update",
            description="（仅总管理）修改已有永久 Bot 的名称、角色、指令、动态模型、Skills 或权限（不可修改总管理身份）",
            args_model=BotUpdateArgs,
            handler=self._tool_bot_update,
            manager_only=True,
            usage_hint='{"bot_id":"bot_xxx","role":"...","chat_model":{"provider_id":"...","model":"..."}}',
        ))
        self.register_tool(ToolSpec(
            name="bot.archive",
            description="（仅总管理）归档一个不再使用的永久专业 Bot（不可归档总管理）",
            args_model=BotArchiveArgs,
            handler=self._tool_bot_archive,
            manager_only=True,
            usage_hint='{"bot_id":"bot_xxx","reason":"项目已结束"}',
        ))
        self.register_tool(ToolSpec(
            name="bot.restore",
            description="（仅总管理）恢复已归档的永久 Bot",
            args_model=BotRestoreArgs,
            handler=self._tool_bot_restore,
            manager_only=True,
            usage_hint='{"bot_id":"bot_xxx"}',
        ))
        self.register_tool(ToolSpec(
            name="bot.delegate",
            description="向另一个活跃的永久专业 Bot 委派任务，在权限交集内使用目标 Bot 的独立模型与会话执行并回传结果",
            args_model=BotDelegateArgs,
            handler=self._tool_bot_delegate,
            usage_hint='{"target_bot_id":"bot_xxx","goal":"提炼三个主图核心卖点","instructions":"控制在200字内","wait_for_result":true}',
        ))
        self.register_tool(ToolSpec(
            name="bot.get_result",
            description="查询某个跨 Bot 委派或任务回合的执行状态、结果摘要与产物引用",
            args_model=BotGetResultArgs,
            handler=self._tool_bot_get_result,
            usage_hint='{"delegation_id":"del_xxx","wait_if_running":false}',
        ))
        self.register_tool(ToolSpec(
            name="bot.cancel_task",
            description="停止正在排队或执行中的委派任务或回合（级联停止子任务）",
            args_model=BotCancelTaskArgs,
            handler=self._tool_bot_cancel_task,
            usage_hint='{"delegation_id":"del_xxx","reason":"需求变更"}',
        ))
        self.register_tool(ToolSpec(
            name="memory.read",
            description="读取当前 Bot 的长期记忆列表",
            args_model=MemoryReadArgs,
            handler=self._tool_memory_read,
            usage_hint='{"scope":"bot","limit":20}',
        ))
        self.register_tool(ToolSpec(
            name="memory.remember",
            description="写入一条长期记忆（禁止保存 API Key 等凭据；普通 Bot 只能写 bot/project 记忆）",
            args_model=MemoryRememberArgs,
            handler=self._tool_memory_remember,
            usage_hint='{"content":"品牌主色调偏好暖米白与墨绿","scope":"bot"}',
        ))
        self.register_tool(ToolSpec(
            name="memory.forget",
            description="按记忆 ID 或关键词删除当前 Bot 的一条过时记忆",
            args_model=MemoryForgetArgs,
            handler=self._tool_memory_forget,
            usage_hint='{"target":"旧配色规则"}',
        ))
        self.register_tool(ToolSpec(
            name="memory.recall",
            description="按关键词检索当前 Bot 的独立记忆、当前项目记忆与工作区共享记忆",
            args_model=MemoryRecallArgs,
            handler=self._tool_memory_recall,
            usage_hint='{"query":"主图配色","limit":10}',
        ))
        self.register_tool(ToolSpec(
            name="canvas.read",
            description="读取当前会话绑定项目与画布的节点、连线、提示词与媒体资源（严格受项目隔离限制）",
            args_model=CanvasReadArgs,
            handler=self._tool_canvas_read,
            usage_hint='{}',
        ))
        self.register_tool(ToolSpec(
            name="canvas.list_assets",
            description="列出当前项目下的画布图片与上传素材（禁止跨项目读取）",
            args_model=CanvasListAssetsArgs,
            handler=self._tool_canvas_list_assets,
            usage_hint='{}',
        ))
        self.register_tool(ToolSpec(
            name="canvas.dispatch_run",
            description="委托现有画布多代理执行引擎在当前画布创建/连线/运行节点（可派生一次性临时子 Agent，严格走审批、预算与幂等防重提）",
            args_model=CanvasDispatchRunArgs,
            handler=self._tool_canvas_dispatch_run,
            usage_hint='{"goal":"基于选中商品图创建两张主图绘画节点并连线","allow_canvas_writes":true,"authorized_generations":0}',
        ))
        self.register_tool(ToolSpec(
            name="canvas.query_generation",
            description="查询当前任务关联的画布执行运行、临时子 Agent 与节点生成状态",
            args_model=CanvasQueryGenerationArgs,
            handler=self._tool_canvas_query_generation,
            usage_hint='{"multi_agent_run_id":"mar_xxx"}',
        ))
        self.register_approval_handler("canvas.", self._on_canvas_approval_resolved)
        self.register_approval_handler("image.", self._on_canvas_approval_resolved)

    # -- 工具提示词描述（只暴露当前 Bot 被授权的工具） ----------------------

    def describe_for_bot(self, bot: Dict[str, Any], allowed_tools: Iterable[str]) -> str:
        allowed_set = set(allowed_tools or [])
        if not bot.get("is_manager"):
            allowed_set -= MANAGER_ONLY_TOOLS
        lines = ["当前允许你调用的工具列表（未列出的工具一律禁止调用）："]
        count = 0
        for name in sorted(self._registry.keys()):
            if name not in allowed_set:
                continue
            spec = self._registry[name]
            if spec.manager_only and not bot.get("is_manager"):
                continue
            hint = f" 参数示例：{spec.usage_hint}" if spec.usage_hint else ""
            lines.append(f"- `{name}`：{spec.description}。{hint}")
            count += 1
        return "\n".join(lines) if count else ""

    # -- 服务端强制权限与参数校验入口 --------------------------------------

    def effective_tools_for(self, fresh_bot: Dict[str, Any], turn: Dict[str, Any]) -> Tuple[Set[str], bool]:
        """计算当前回合实际生效工具集合：数据库实时权限 ∩ 回合权限快照，绝不提权。"""
        db_tools = set(fresh_bot.get("tool_permissions") or [])
        snap = turn.get("permission_snapshot") or {}
        snap_tools = set(snap.get("tool_permissions") or db_tools)
        effective = db_tools & snap_tools & set(ALL_REGISTERED_TOOLS)
        is_mgr = bool(fresh_bot.get("is_manager")) and bool(snap.get("is_manager", fresh_bot.get("is_manager")))
        if not is_mgr:
            effective &= set(SPECIALIST_MAX_TOOLS)
        return effective, is_mgr

    async def execute(
        self,
        *,
        tool_name: str,
        args: Dict[str, Any],
        bot: Dict[str, Any],
        turn: Dict[str, Any],
        runtime: Any,
    ) -> Dict[str, Any]:
        name = str(tool_name or "").strip()
        if not name or name in FORBIDDEN_TOOLS or name.startswith(("shell.", "system.", "exec.")):
            return {
                "ok": False,
                "code": "forbidden_tool",
                "error": f"安全策略拒绝调用禁止工具：{name or '(空)'}",
                "display_text": f"已拦截危险工具调用：{name or '(空)'}",
            }
        spec = self._registry.get(name)
        if spec is None:
            return {
                "ok": False,
                "code": "unknown_tool",
                "error": f"未登记的工具：{name}",
                "display_text": f"工具未登记：{name}",
            }

        try:
            fresh_bot = self.store.get_bot(bot["bot_id"])
            if fresh_bot["status"] != "active":
                return {"ok": False, "code": "bot_archived", "error": "当前 Bot 已归档，停止执行工具"}
            effective_tools, is_manager = self.effective_tools_for(fresh_bot, turn)
            if (spec.manager_only or name in MANAGER_ONLY_TOOLS) and not is_manager:
                return {
                    "ok": False,
                    "code": "permission_denied",
                    "error": f"权限不足：只有总管理 Bot（{MANAGER_BOT_ID}）允许调用 {name}",
                    "display_text": f"权限拒绝：「{fresh_bot['name']}」无权调用总管理工具 {name}",
                }
            if name not in effective_tools:
                return {
                    "ok": False,
                    "code": "permission_denied",
                    "error": f"权限不足：「{fresh_bot['name']}」未被授权调用 {name}",
                    "display_text": f"权限拒绝：「{fresh_bot['name']}」未被授权调用 {name}",
                }

            raw_args = args if isinstance(args, dict) else {}
            assert_no_secrets(raw_args, field_label=f"工具 {name} 参数")
            try:
                parsed = spec.args_model.model_validate(raw_args)
            except ValidationError as exc:
                first_err = exc.errors()[0] if exc.errors() else {"msg": str(exc)}
                loc = ".".join(str(x) for x in first_err.get("loc") or ())
                return {
                    "ok": False,
                    "code": "invalid_args",
                    "error": f"参数校验失败（{loc or 'args'}）：{first_err.get('msg')}",
                    "display_text": f"工具 {name} 参数格式不正确，请修正后重试",
                }

            res = spec.handler(parsed, fresh_bot, turn, runtime, effective_tools)
            if asyncio.iscoroutine(res):
                res = await res
            return res
        except BotWorkspaceError as exc:
            return {
                "ok": False,
                "code": exc.code,
                "error": exc.message,
                "display_text": f"工具 {name} 未完成：{exc.message}",
            }
        except Exception as exc:
            err_code = getattr(exc, "code", None)
            if isinstance(err_code, str) and hasattr(exc, "message"):
                return {
                    "ok": False,
                    "code": err_code,
                    "error": str(getattr(exc, "message")),
                    "display_text": f"工具 {name} 未完成：{getattr(exc, 'message')}",
                }
            safe_msg = runtime._safe_error(exc) if hasattr(runtime, "_safe_error") else str(exc)[:300]
            return {
                "ok": False,
                "code": "tool_error",
                "error": safe_msg,
                "display_text": f"工具 {name} 执行异常：{safe_msg}",
            }

    async def on_approval_resolved(self, approval: Dict[str, Any], *, runtime: Any) -> Any:
        tool_name = str(approval.get("tool_name") or "")
        for prefix, handler in self._approval_handlers.items():
            if tool_name == prefix or tool_name.startswith(prefix):
                return await handler(approval, runtime=runtime)
        return None

    # -- 内部辅助：按 ID 或名称查找 Bot ------------------------------------

    def _resolve_target_bot(self, bot_id: str = "", name: str = "", *, include_archived: bool = True) -> Dict[str, Any]:
        if bot_id:
            return self.store.get_bot(bot_id)
        wanted_name = str(name or "").strip()
        if not wanted_name:
            raise BotWorkspaceError("invalid_args", "请提供目标 bot_id 或 name", 422)
        candidates = self.store.list_bots(include_archived=include_archived)
        exact = [b for b in candidates if b["name"] == wanted_name]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            raise BotWorkspaceError("ambiguous_bot", f"存在多个名为「{wanted_name}」的 Bot，请改用 bot_id 指定", 409)
        raise BotWorkspaceError("bot_not_found", f"未找到名为「{wanted_name}」的 Bot", 404)

    def _validate_models_for_payload(self, data: Dict[str, Any], runtime: Any) -> None:
        if runtime is None or not hasattr(runtime, "validate_dynamic_model"):
            return
        for field, kind in (
            ("chat_model", "chat_models"),
            ("vision_model", "chat_models"),
            ("image_model", "image_models"),
        ):
            ref = data.get(field)
            if isinstance(ref, dict) and ref.get("provider_id") and ref.get("model"):
                runtime.validate_dynamic_model(ref["provider_id"], ref["model"], kind=kind)

    # -- 9 个 Bot 管理工具实现 --------------------------------------------

    def _tool_bot_list(self, args: BotListArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        items = self.store.list_bots(include_archived=args.include_archived)
        q = args.query.strip().casefold()
        if q:
            items = [
                b for b in items
                if q in b["name"].casefold() or q in b["role"].casefold() or q in b["bot_id"].casefold()
            ]
        summaries = [_bot_summary(b) for b in items]
        names = "、".join(b["name"] for b in summaries) or "无"
        return {
            "ok": True,
            "result": {"count": len(summaries), "bots": summaries},
            "display_text": f"查询到 {len(summaries)} 个持久 Bot：{names}",
        }

    def _tool_bot_read(self, args: BotReadArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        target = self._resolve_target_bot(args.bot_id, args.name, include_archived=True)
        recent_turns = self.store.list_turns(bot_id=target["bot_id"], limit=5)
        return {
            "ok": True,
            "result": {
                "bot": target,
                "recent_turns": [
                    {"turn_id": t["turn_id"], "status": t["status"], "result_summary": t["result_summary"][:200]}
                    for t in recent_turns
                ],
            },
            "display_text": f"已读取 Bot「{target['name']}」（{target['bot_id']}）的档案配置",
        }

    def _tool_bot_create(self, args: BotCreateArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        if args.is_manager:
            raise BotWorkspaceError("manager_unique", "不允许创建第二个总管理 Bot", 403)
        payload = args.model_dump()
        self._validate_models_for_payload(payload, runtime)
        # 子 Bot 权限严格不得超过创建者当前权限与 SPECIALIST_MAX_TOOLS
        created = self.store.create_bot(
            payload,
            created_by=bot["bot_id"],
            creator_permissions=effective,
            user_ceiling=SPECIALIST_MAX_TOOLS,
            strict_permissions=True,
        )
        return {
            "ok": True,
            "result": {"bot": _bot_summary(created)},
            "message_kind": "task_card",
            "message_meta": {"created_bot_id": created["bot_id"], "created_bot_name": created["name"]},
            "display_text": f"已创建永久 Bot「{created['name']}」（{created['bot_id']}）：{created['role'] or '专业助手'}",
        }

    def _tool_bot_update(self, args: BotUpdateArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        if args.is_manager is not None:
            raise BotWorkspaceError("permission_escalation", "不允许修改任何 Bot 的总管理身份", 403)
        target = self._resolve_target_bot(args.bot_id, args.target_name, include_archived=True)
        patch = args.model_dump(exclude_none=True)
        patch.pop("bot_id", None)
        patch.pop("target_name", None)
        if not patch:
            raise BotWorkspaceError("invalid_args", "请至少指定一个要修改的配置字段", 422)
        self._validate_models_for_payload(patch, runtime)
        updated = self.store.update_bot(
            target["bot_id"],
            patch,
            actor_is_manager=True,
            actor_bot_id=bot["bot_id"],
            strict_permissions=True,
        )
        return {
            "ok": True,
            "result": {"bot": _bot_summary(updated)},
            "display_text": f"已更新永久 Bot「{updated['name']}」的配置",
        }

    def _tool_bot_archive(self, args: BotArchiveArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        target = self._resolve_target_bot(args.bot_id, args.name, include_archived=False)
        archived = self.store.archive_bot(target["bot_id"], reason=args.reason)
        return {
            "ok": True,
            "result": {"bot": _bot_summary(archived)},
            "display_text": f"已归档永久 Bot「{archived['name']}」（历史聊天与记忆均已保留，可随时恢复）",
        }

    def _tool_bot_restore(self, args: BotRestoreArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        target = self._resolve_target_bot(args.bot_id, args.name, include_archived=True)
        restored = self.store.restore_bot(target["bot_id"])
        return {
            "ok": True,
            "result": {"bot": _bot_summary(restored)},
            "display_text": f"已恢复永久 Bot「{restored['name']}」",
        }

    def _tool_bot_delegate(self, args: BotDelegateArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        policy = (turn.get("permission_snapshot") or {}).get("delegation_policy") or bot.get("delegation_policy") or {}
        if not bot.get("is_manager") and not policy.get("allow_delegate", False):
            raise BotWorkspaceError("delegation_denied", f"「{bot['name']}」未被允许向其他 Bot 委派任务", 403)
        target = self._resolve_target_bot(args.target_bot_id, args.target_bot_name, include_archived=False)
        if target["bot_id"] == bot["bot_id"]:
            raise BotWorkspaceError("self_delegation", "不能向自己委派任务", 422)
        allowed_targets = policy.get("allowed_target_bot_ids") or []
        if allowed_targets and target["bot_id"] not in allowed_targets:
            raise BotWorkspaceError("delegation_target_denied", f"不允许向「{target['name']}」委派任务", 403)

        # 严格校验显式授予的权限不超过发起方当前回合有效权限
        granted = args.granted_permissions
        if granted is not None:
            granted = sanitize_tool_permissions(
                granted,
                is_manager=False,
                allowed_ceiling=effective & set(SPECIALIST_MAX_TOOLS),
                strict=True,
            )

        session_mode = args.session_mode if args.session_mode in ("new_thread", "reuse_active") else "new_thread"
        delegation, child_turn, created = self.store.create_delegation(
            parent_bot_id=bot["bot_id"],
            parent_session_id=turn["session_id"],
            parent_turn_id=turn["turn_id"],
            target_bot_id=target["bot_id"],
            goal=args.goal,
            instructions=args.instructions,
            context_refs=args.context_refs,
            granted_permissions=granted,
            idempotency_key=args.idempotency_key or f"del_{turn['turn_id']}_{target['bot_id']}_{turn['steps']}",
            project_id=turn.get("project_id", ""),
            canvas_id=turn.get("canvas_id", ""),
            session_mode=session_mode,
        )
        if runtime is not None:
            runtime.ensure_started()
            runtime.notify()

        outcome: Dict[str, Any] = {
            "ok": True,
            "result": {
                "delegation_id": delegation["delegation_id"],
                "target_bot_id": target["bot_id"],
                "target_bot_name": target["name"],
                "target_session_id": delegation["target_session_id"],
                "target_turn_id": delegation["target_turn_id"],
                "granted_permissions": delegation["granted_permissions"],
                "status": delegation["status"],
                "created": created,
            },
            "delegation_id": delegation["delegation_id"],
            "message_kind": "task_card",
            "message_meta": {
                "delegation_id": delegation["delegation_id"],
                "target_bot_id": target["bot_id"],
                "target_bot_name": target["name"],
                "target_session_id": delegation["target_session_id"],
            },
            "display_text": f"已将任务委派给「{target['name']}」：{args.goal[:120]}",
        }
        if args.wait_for_result and delegation["status"] in ("queued", "running"):
            outcome["suspend_status"] = "waiting_delegation"
            outcome["suspend_note"] = f"等待「{target['name']}」完成委派任务"
        return outcome

    def _tool_bot_get_result(self, args: BotGetResultArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        if args.delegation_id:
            delegation = self.store.get_delegation(args.delegation_id)
            if not bot.get("is_manager") and delegation["parent_bot_id"] != bot["bot_id"] and delegation["target_bot_id"] != bot["bot_id"]:
                raise BotWorkspaceError("forbidden", "无权读取其他 Bot 的委派结果", 403)
            outcome: Dict[str, Any] = {
                "ok": True,
                "result": {
                    "delegation_id": delegation["delegation_id"],
                    "target_bot_id": delegation["target_bot_id"],
                    "status": delegation["status"],
                    "result_summary": delegation["result_summary"],
                    "result_refs": delegation["result_refs"],
                    "error": delegation["error"],
                },
                "result_refs": delegation["result_refs"],
                "delegation_id": delegation["delegation_id"],
                "display_text": f"委派 {delegation['delegation_id']} 当前状态：{delegation['status']}",
            }
            if args.wait_if_running and delegation["status"] in ("queued", "running"):
                outcome["suspend_status"] = "waiting_delegation"
                outcome["suspend_note"] = "继续等待专业 Bot 返回委派结果"
            return outcome
        if args.turn_id:
            target_turn = self.store.get_turn(args.turn_id)
            if not bot.get("is_manager") and target_turn["bot_id"] != bot["bot_id"] and target_turn["parent_turn_id"] != turn["turn_id"]:
                raise BotWorkspaceError("forbidden", "无权读取其他 Bot 的任务回合", 403)
            return {
                "ok": True,
                "result": {
                    "turn_id": target_turn["turn_id"],
                    "bot_id": target_turn["bot_id"],
                    "status": target_turn["status"],
                    "result_summary": target_turn["result_summary"],
                    "result_refs": target_turn["result_refs"],
                    "error": target_turn["error"],
                },
                "result_refs": target_turn["result_refs"],
                "display_text": f"回合 {target_turn['turn_id']} 当前状态：{target_turn['status']}",
            }
        raise BotWorkspaceError("invalid_args", "请提供 delegation_id 或 turn_id", 422)

    async def _tool_bot_cancel_task(self, args: BotCancelTaskArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        target_turn_id = args.turn_id
        delegation = None
        if args.delegation_id:
            delegation = self.store.get_delegation(args.delegation_id)
            if not bot.get("is_manager") and delegation["parent_bot_id"] != bot["bot_id"]:
                raise BotWorkspaceError("forbidden", "无权停止非本人发起的委派任务", 403)
            target_turn_id = delegation["target_turn_id"]
        if not target_turn_id:
            raise BotWorkspaceError("invalid_args", "请提供要停止的 delegation_id 或 turn_id", 422)
        target_turn = self.store.get_turn(target_turn_id)
        if not bot.get("is_manager") and target_turn["bot_id"] != bot["bot_id"] and target_turn["parent_turn_id"] != turn["turn_id"]:
            raise BotWorkspaceError("forbidden", "无权停止其他 Bot 的任务回合", 403)

        cancelled = await runtime.cancel_turn(target_turn_id, reason=args.reason)
        if delegation is not None and delegation["status"] not in ("completed", "failed", "cancelled"):
            self.store.update_delegation(delegation["delegation_id"], status="cancelled", error=args.reason)
        return {
            "ok": True,
            "result": {"turn_id": cancelled["turn_id"], "status": cancelled["status"]},
            "display_text": f"已停止任务 {cancelled['turn_id']}：{args.reason}",
        }

    # -- 4 个记忆工具实现 --------------------------------------------------

    def _tool_memory_read(self, args: MemoryReadArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        items = self.store.list_memories(
            bot["bot_id"],
            scope=args.scope,
            project_id=turn.get("project_id", ""),
            limit=args.limit,
        )
        return {
            "ok": True,
            "result": {"count": len(items), "memories": [{"memory_id": m["memory_id"], "scope": m["scope"], "content": m["content"]} for m in items]},
            "display_text": f"已读取 {len(items)} 条长期记忆",
        }

    def _tool_memory_remember(self, args: MemoryRememberArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        scope = args.scope if args.scope in ("bot", "project", "shared") else "bot"
        if scope == "shared" and not bot.get("is_manager"):
            raise BotWorkspaceError("forbidden", "只有总管理 Bot 可以写入共享记忆", 403)
        record, created = self.store.add_memory(
            bot["bot_id"],
            args.content,
            scope=scope,
            project_id=turn.get("project_id", "") if scope == "project" else "",
            source=args.source,
        )
        return {
            "ok": True,
            "result": {"memory": record, "created": created},
            "display_text": f"{'已写入' if created else '已存在'}长期记忆：{record['content'][:60]}",
        }

    def _tool_memory_forget(self, args: MemoryForgetArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        if args.memory_id:
            self.store.delete_memory(bot["bot_id"], args.memory_id)
            return {"ok": True, "result": {"deleted": True, "memory_id": args.memory_id}, "display_text": "已删除指定长期记忆"}
        if args.target:
            removed = self.store.forget_memory_by_text(bot["bot_id"], args.target)
            return {
                "ok": True,
                "result": {"deleted": removed, "target": args.target},
                "display_text": "已忘却匹配记忆" if removed else "未找到匹配的记忆条目",
            }
        raise BotWorkspaceError("invalid_args", "请提供 memory_id 或 target 关键词", 422)

    def _tool_memory_recall(self, args: MemoryRecallArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        hits = self.store.recall_memories(
            bot["bot_id"],
            query=args.query,
            project_id=turn.get("project_id", ""),
            limit=args.limit,
        )
        return {
            "ok": True,
            "result": {"count": len(hits), "memories": [{"memory_id": m["memory_id"], "scope": m["scope"], "content": m["content"]} for m in hits]},
            "display_text": f"检索到 {len(hits)} 条相关长期记忆",
        }

    # -- P3 画布受控工具（复用现有 multi_agent 执行体系） -------------------

    def _resolve_canvas_scope(self, args_project: str, args_canvas: str, turn: Dict[str, Any]) -> Tuple[str, str]:
        turn_proj = str(turn.get("project_id") or "").strip()
        turn_canvas = str(turn.get("canvas_id") or "").strip()
        req_proj = str(args_project or "").strip()
        req_canvas = str(args_canvas or "").strip()
        if turn_proj and req_proj and req_proj != turn_proj:
            raise BotWorkspaceError("project_mismatch", "禁止跨项目访问或写入其他项目的画布", 403)
        if turn_canvas and req_canvas and req_canvas != turn_canvas:
            raise BotWorkspaceError("canvas_mismatch", "禁止跨画布写入其他画布，请先切换到目标画布会话", 403)
        project_id = turn_proj or req_proj
        canvas_id = turn_canvas or req_canvas
        if not project_id or not canvas_id:
            raise BotWorkspaceError("canvas_scope_missing", "当前会话尚未绑定具体项目与画布，请先打开对应画布再操作", 422)
        return project_id, canvas_id

    def _require_multi_agent(self, runtime: Any) -> Any:
        adapter = self.multi_agent_adapter or getattr(runtime, "multi_agent_adapter", None)
        if adapter is None:
            raise BotWorkspaceError("multi_agent_unavailable", "画布多代理执行引擎尚未就绪", 503)
        return adapter

    def _tool_canvas_read(self, args: CanvasReadArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        project_id, canvas_id = self._resolve_canvas_scope(args.project_id, args.canvas_id, turn)
        adapter = self._require_multi_agent(runtime)
        canvas = adapter.canvas({"project_id": project_id, "canvas_id": canvas_id})
        public = adapter.public_canvas(canvas)
        return {
            "ok": True,
            "result": {"project_id": project_id, "canvas_id": canvas_id, **public},
            "display_text": f"已读取当前画布（{len(public.get('nodes') or [])} 个节点，{len(public.get('connections') or [])} 条连线）",
        }

    def _tool_canvas_list_assets(self, args: CanvasListAssetsArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        project_id, canvas_id = self._resolve_canvas_scope(args.project_id, args.canvas_id, turn)
        adapter = self._require_multi_agent(runtime)
        adapter.canvas({"project_id": project_id, "canvas_id": canvas_id})
        assets = adapter.project_assets({"project_id": project_id, "canvas_id": canvas_id})
        return {
            "ok": True,
            "result": {"project_id": project_id, "count": len(assets), "assets": assets},
            "display_text": f"当前项目共有 {len(assets)} 组可用素材",
        }

    def _tool_canvas_dispatch_run(self, args: CanvasDispatchRunArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        from multi_agent_runtime import ALL_TOOLS, RunLimits, RunPolicy, RunRequest
        from bot_workspace_store import sha256_json

        project_id, canvas_id = self._resolve_canvas_scope(args.project_id, args.canvas_id, turn)
        adapter = self._require_multi_agent(runtime)
        canvas_policy = (turn.get("permission_snapshot") or {}).get("canvas_policy") or bot.get("canvas_policy") or {}
        delegation_policy = (turn.get("permission_snapshot") or {}).get("delegation_policy") or bot.get("delegation_policy") or {}

        allow_writes = bool(args.allow_canvas_writes) and bool(canvas_policy.get("allow_canvas_writes", False))
        if args.allow_canvas_writes and not canvas_policy.get("allow_canvas_writes", False):
            raise BotWorkspaceError("canvas_write_denied", f"「{bot['name']}」未被授予画布写入权限", 403)

        # 明确校验前端画布连接：需要写画布但前端未打开该画布时，明确标记 waiting_canvas_connection
        if allow_writes and args.require_canvas_connection and not runtime.is_canvas_connected(project_id, canvas_id):
            return {
                "ok": True,
                "result": {"waiting_canvas_connection": True, "project_id": project_id, "canvas_id": canvas_id},
                "suspend_status": "waiting_canvas_connection",
                "suspend_note": "需要打开当前项目对应的画布连接后才能继续执行画布写入操作（关闭画布后不会无条件继续执行）",
                "message_kind": "task_card",
                "display_text": f"等待画布连接：请保持项目「{project_id}」的当前画布打开，系统将在连接恢复后继续执行",
            }

        # 解析目标 Bot 自己的动态对话模型（绝不写死模型名）
        model = runtime.resolve_chat_model(bot, turn)

        # 计算画布引擎工具白名单（严格遵守 Bot 权限与是否允许临时子 Agent）
        allowed_tools = set(ALL_TOOLS)
        if not allow_writes:
            allowed_tools -= {"canvas.command", "canvas.use_project_asset"}
        if not bot.get("is_manager") and not delegation_policy.get("allow_temp_subagents", False):
            allowed_tools.discard("agent.spawn_subagent")

        require_paid_approval = bool(canvas_policy.get("require_approval_for_paid", True))
        bot_gen_ceiling = int(canvas_policy.get("authorized_generations", 0))
        authorized_generations = 0 if require_paid_approval else min(args.authorized_generations, bot_gen_ceiling)
        allow_local_gpu = bool(args.allow_local_gpu) and bool(canvas_policy.get("allow_local_gpu", False))

        idem = args.idempotency_key.strip() or f"bwrun_{turn['turn_id']}_{sha256_json({'goal': args.goal, 'instructions': args.instructions, 'writes': allow_writes})[:12]}"
        skill_ids = [s["skill_id"] for s in bot.get("skills") or [] if s.get("enabled")]

        run_req = RunRequest(
            project_id=project_id,
            canvas_id=canvas_id,
            idempotency_key=idem,
            goal=args.goal,
            instructions=args.instructions,
            provider_id=model["provider_id"],
            model=model["model"],
            allowed_tools=sorted(allowed_tools),
            source_node_ids=list(args.source_node_ids),
            source_images=list(args.source_images),
            generation_preferences=dict(args.generation_preferences),
            limits=RunLimits(max_children=args.max_children if "agent.spawn_subagent" in allowed_tools else 0),
            policy=RunPolicy(
                authorized_generations=authorized_generations,
                allow_canvas_writes=allow_writes,
                allow_local_gpu=allow_local_gpu,
            ),
            bot_id=bot["bot_id"],
            session_id=turn["session_id"],
            turn_id=turn["turn_id"],
            delegation_id=turn.get("delegation_id", ""),
            skill_ids=skill_ids[:16],
            permission_snapshot=dict(turn.get("permission_snapshot") or {}),
        )
        run, created = adapter.create_run_internal(run_req)
        link, _ = self.store.create_run_link(
            bot_id=bot["bot_id"],
            session_id=turn["session_id"],
            turn_id=turn["turn_id"],
            delegation_id=turn.get("delegation_id", ""),
            multi_agent_run_id=run["run_id"],
            project_id=project_id,
            canvas_id=canvas_id,
            idempotency_key=idem,
            status=run["status"],
        )
        runtime.notify()
        return {
            "ok": True,
            "result": {
                "multi_agent_run_id": run["run_id"],
                "link_id": link["link_id"],
                "created": created,
                "status": run["status"],
                "bot_id": bot["bot_id"],
                "model": model,
            },
            "suspend_status": "waiting_result",
            "suspend_note": f"已提交画布执行引擎（{run['run_id']}），正在等待结果与必要确认",
            "message_kind": "task_card",
            "message_meta": {"multi_agent_run_id": run["run_id"], "link_id": link["link_id"]},
            "display_text": f"已启动画布受控执行（{run['run_id']}，{'新任务' if created else '复用已有任务'}）：{args.goal[:100]}",
        }

    def _tool_canvas_query_generation(self, args: CanvasQueryGenerationArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]) -> Dict[str, Any]:
        adapter = self._require_multi_agent(runtime)
        links = self.store.list_run_links(turn_id=turn["turn_id"], limit=10)
        if not links and args.multi_agent_run_id:
            links = [l for l in self.store.list_run_links(bot_id=bot["bot_id"], limit=30) if l["multi_agent_run_id"] == args.multi_agent_run_id]
        if not links:
            return {"ok": True, "result": {"runs": []}, "display_text": "当前任务尚无关联的画布执行记录"}
        chosen = next((l for l in links if l["multi_agent_run_id"] == args.multi_agent_run_id), links[0])
        snap = adapter.store.snapshot(chosen["multi_agent_run_id"], chosen["project_id"], chosen["canvas_id"])
        temp_subagents = [
            {"task_id": t["task_id"], "role": t["agent_role"], "status": t["status"], "goal": t["goal"][:100]}
            for t in snap.get("tasks") or [] if t.get("parent_task_id")
        ]
        return {
            "ok": True,
            "result": {
                "run": snap["run"],
                "temporary_subagents": temp_subagents,
                "actions": [
                    {"action_id": a["action_id"], "tool": a["operation"]["tool"], "status": a["status"], "error": a.get("error", "")}
                    for a in snap.get("actions") or []
                ],
            },
            "display_text": f"画布执行 {chosen['multi_agent_run_id']} 当前状态：{snap['run']['status']}（临时子 Agent {len(temp_subagents)} 个）",
        }

    async def _on_canvas_approval_resolved(self, approval: Dict[str, Any], *, runtime: Any) -> Any:
        run_id = str(approval.get("multi_agent_run_id") or "").strip()
        action_id = str(approval.get("multi_agent_action_id") or "").strip()
        if not run_id or not action_id:
            return None
        adapter = self.multi_agent_adapter or getattr(runtime, "multi_agent_adapter", None)
        if adapter is None:
            return None
        links = self.store.list_run_links(turn_id=approval.get("turn_id") or "", limit=20)
        link = next((l for l in links if l["multi_agent_run_id"] == run_id), None)
        if link is None:
            return None
        approved = approval.get("status") == "approved"
        action = adapter.approve_action_internal(run_id, action_id, link["project_id"], link["canvas_id"], approved)
        if approved:
            self.store.emit_event(
                "canvas_action_waiting",
                bot_id=approval["bot_id"],
                session_id=approval["session_id"],
                turn_id=approval["turn_id"],
                project_id=link["project_id"],
                canvas_id=link["canvas_id"],
                payload={"multi_agent_run_id": run_id, "action_id": action_id},
            )
        if approval.get("turn_id"):
            turn = self.store.get_turn(approval["turn_id"])
            if turn["status"] == "waiting_approval":
                self.store.update_turn(turn["turn_id"], status="waiting_result", error="")
        runtime.notify()
        return {"multi_agent_run_id": run_id, "action_id": action_id, "status": action.get("status")}
