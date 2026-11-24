"""小美 Bot 工作区 FastAPI 路由层（/api/bot-workspace/*）。

安全策略：
- 仅允许本机 loopback 访问，拒绝经共享画布网关转发的任何请求；
- 所有写操作要求同源 Origin/Referer；
- 所有模型列表与模型校验完全动态驱动；
- 所有业务异常统一返回结构化 ``{detail: {code, message}}``。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from bot_workspace_config import (
    MANAGER_BOT_ID,
    is_bot_workspace_enabled,
    read_feature_flags,
    write_feature_flags,
)
from bot_workspace_migration import MIGRATION_ID, migrate_legacy_design_team
from bot_workspace_runtime import BotWorkspaceRuntime
from bot_workspace_store import (
    ALL_REGISTERED_TOOLS,
    AVATAR_SHAPES,
    BOT_MANAGEMENT_TOOLS,
    BotWorkspaceError,
    BotWorkspaceStore,
    CANVAS_READ_TOOLS,
    CANVAS_WRITE_TOOLS,
    DESIGN_TOOLS,
    MANAGER_ONLY_TOOLS,
    MEMORY_TOOLS,
    SPECIALIST_DEFAULT_TOOLS,
    SPECIALIST_MAX_TOOLS,
    contains_secret_text,
)


def _local_only(request: Request) -> None:
    if request.headers.get("x-xiaomei-share-gateway"):
        raise HTTPException(status_code=403, detail="共享画布模式不可访问本机 Bot 工作区")
    host = request.client.host if request.client else ""
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == "testclient"
    if not local:
        raise HTTPException(status_code=403, detail="Bot 工作区仅限本机访问")


def _origin_of(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except ValueError:
        return ""
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        return ""
    host = (parsed.hostname or "").lower()
    port = parsed.port
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    if port and port != default_port:
        host = f"{host}:{port}"
    return f"{parsed.scheme.lower()}://{host}"


def _ensure_same_origin(request: Request) -> None:
    host = str(request.headers.get("host") or "").lower()
    if not host:
        return
    expected = f"{str(request.url.scheme).lower()}://{host}"
    actual = _origin_of(request.headers.get("origin", "")) or _origin_of(request.headers.get("referer", ""))
    if actual != expected:
        raise HTTPException(status_code=403, detail="只允许从本机页面修改 Bot 工作区")


# ---------------------------------------------------------------------------
# Pydantic 请求模型
# ---------------------------------------------------------------------------


class FeatureFlagRequest(BaseModel):
    enabled: bool


class BotCreateBody(BaseModel):
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
    tool_permissions: Optional[List[str]] = None
    permission_ceiling: Optional[List[str]] = None
    delegation_policy: Dict[str, Any] = Field(default_factory=dict)
    canvas_policy: Dict[str, Any] = Field(default_factory=dict)
    skill_ids: List[Any] = Field(default_factory=list, max_length=32)
    is_manager: bool = False


class BotUpdateBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=48)
    role: Optional[str] = Field(default=None, max_length=200)
    system_instructions: Optional[str] = Field(default=None, max_length=12000)
    personality: Optional[str] = Field(default=None, max_length=2000)
    avatar: Optional[Dict[str, Any]] = None
    chat_model: Optional[Dict[str, Any]] = None
    vision_model: Optional[Dict[str, Any]] = None
    image_model: Optional[Dict[str, Any]] = None
    model_params: Optional[Dict[str, Any]] = None
    tool_permissions: Optional[List[str]] = None
    permission_ceiling: Optional[List[str]] = None
    delegation_policy: Optional[Dict[str, Any]] = None
    canvas_policy: Optional[Dict[str, Any]] = None
    skill_ids: Optional[List[Any]] = None
    is_manager: Optional[bool] = None


class BotArchiveBody(BaseModel):
    reason: str = Field(default="", max_length=200)


class BotSkillsBody(BaseModel):
    skills: List[Any] = Field(default_factory=list, max_length=32)


class MemoryCreateBody(BaseModel):
    content: str = Field(min_length=1, max_length=400)
    scope: str = Field(default="bot", max_length=20)
    project_id: str = Field(default="", max_length=80)
    source: str = Field(default="用户", max_length=60)


class MemoryUpdateBody(BaseModel):
    content: str = Field(min_length=1, max_length=400)


class SessionCreateBody(BaseModel):
    title: str = Field(default="新会话", max_length=80)
    kind: str = Field(default="chat", max_length=20)
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)
    pinned: bool = False


class SessionUpdateBody(BaseModel):
    title: Optional[str] = Field(default=None, max_length=80)
    archived: Optional[bool] = None
    pinned: Optional[bool] = None
    project_id: Optional[str] = Field(default=None, max_length=80)
    canvas_id: Optional[str] = Field(default=None, max_length=80)


class MessageSendBody(BaseModel):
    content: str = Field(default="", max_length=16000)
    attachments: List[Any] = Field(default_factory=list, max_length=40)
    meta: Dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str = Field(default="", max_length=120)
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)
    model_override: Optional[Dict[str, Any]] = None


class TurnCancelBody(BaseModel):
    reason: str = Field(default="用户停止了任务", max_length=200)


class ApprovalResolveBody(BaseModel):
    approved: bool


class CanvasPresenceBody(BaseModel):
    project_id: str = Field(default="", max_length=80)
    canvas_id: str = Field(default="", max_length=80)
    client_id: str = Field(default="", max_length=120)


# ---------------------------------------------------------------------------
# 安装器（供 main.py 与单测注入 host）
# ---------------------------------------------------------------------------


def install_bot_workspace(
    app: Any,
    host: Any,
    *,
    data_dir: str | Path | None = None,
    multi_agent_adapter: Optional[Any] = None,
    auto_migrate: bool = True,
) -> Dict[str, Any]:
    resolved_data = Path(data_dir or getattr(host, "DATA_DIR", Path(__file__).resolve().parent / "data")).resolve()
    store = BotWorkspaceStore(data_dir=resolved_data)
    runtime = BotWorkspaceRuntime(host, store, multi_agent_adapter=multi_agent_adapter)

    # 尝试自动装配已存在的工具执行器（P2/P3/P4 逐步就绪）
    try:
        from bot_workspace_tools import BotWorkspaceToolExecutor
        runtime.set_tool_executor(BotWorkspaceToolExecutor(host=host, store=store, multi_agent_adapter=multi_agent_adapter))
    except ImportError:
        pass

    async def workspace_error_handler(request: Request, exc: BotWorkspaceError):
        return JSONResponse(
            status_code=exc.status,
            content={"detail": {"code": exc.code, "message": exc.message}},
        )

    app.add_exception_handler(BotWorkspaceError, workspace_error_handler)

    def _validate_bot_models(payload: Dict[str, Any]) -> None:
        for field, kind in (
            ("chat_model", "chat_models"),
            ("vision_model", "chat_models"),
            ("image_model", "image_models"),
        ):
            ref = payload.get(field)
            if isinstance(ref, dict) and ref.get("provider_id") and ref.get("model"):
                runtime.validate_dynamic_model(ref["provider_id"], ref["model"], kind=kind)

    def _installed_skills() -> List[Dict[str, Any]]:
        listing = getattr(host, "list_agent_skill_records", None)
        if not callable(listing):
            return []
        items = []
        for record in listing() or []:
            if not isinstance(record, dict) or not record.get("id"):
                continue
            items.append({
                "id": str(record.get("id")),
                "name": str(record.get("display_name") or record.get("name") or record.get("id")),
                "description": str(record.get("description") or "")[:200],
                "category": str(record.get("category") or "other"),
                "enabled": record.get("enabled") is not False,
                "lifecycle": str(record.get("lifecycle") or "ready"),
            })
        return items

    @app.on_event("startup")
    async def _bot_workspace_startup() -> None:
        if not is_bot_workspace_enabled(resolved_data):
            return
        try:
            store.ensure_manager_bot()
            if auto_migrate and store.get_migration(MIGRATION_ID) is None:
                await asyncio.to_thread(migrate_legacy_design_team, resolved_data, store, create_backup=True)
            await runtime.start()
        except Exception as exc:
            print(f"[BotWorkspace] 启动初始化异常（旧系统保持可用）: {exc}")

    @app.on_event("shutdown")
    async def _bot_workspace_shutdown() -> None:
        await runtime.close()

    router = APIRouter(prefix="/api/bot-workspace", dependencies=[Depends(_local_only)])

    @router.get("/config")
    async def get_config():
        store.ensure_manager_bot()
        return {
            "feature_flags": read_feature_flags(resolved_data),
            "manager_bot_id": MANAGER_BOT_ID,
            "migration": store.get_migration(MIGRATION_ID),
            "providers": runtime.available_providers(),
            "skills": _installed_skills(),
            "avatar_shapes": list(AVATAR_SHAPES),
            "tools": {
                "bot_management": list(BOT_MANAGEMENT_TOOLS),
                "manager_only": sorted(MANAGER_ONLY_TOOLS),
                "memory": list(MEMORY_TOOLS),
                "canvas_read": list(CANVAS_READ_TOOLS),
                "canvas_write": list(CANVAS_WRITE_TOOLS),
                "design": list(DESIGN_TOOLS),
                "specialist_default": list(SPECIALIST_DEFAULT_TOOLS),
                "specialist_max": sorted(SPECIALIST_MAX_TOOLS),
                "all": sorted(ALL_REGISTERED_TOOLS),
            },
            "latest_event_seq": store.latest_event_seq(),
        }

    @router.put("/feature-flag")
    async def set_feature_flag(payload: FeatureFlagRequest, request: Request):
        _ensure_same_origin(request)
        flags = write_feature_flags(resolved_data, payload.enabled)
        return {"feature_flags": flags}

    @router.post("/migrate")
    async def trigger_migration(request: Request):
        _ensure_same_origin(request)
        try:
            summary = await asyncio.to_thread(migrate_legacy_design_team, resolved_data, store, create_backup=True)
        except Exception as exc:
            raise BotWorkspaceError("migration_failed", f"迁移失败，旧数据保持完好：{exc}", 500) from exc
        return {"migration": summary}

    # -- Bots ------------------------------------------------------------

    @router.get("/bots")
    async def list_bots(include_archived: bool = False):
        store.ensure_manager_bot()
        return {"bots": store.list_bots(include_archived=include_archived)}

    @router.post("/bots")
    async def create_bot(payload: BotCreateBody, request: Request):
        _ensure_same_origin(request)
        data = payload.model_dump()
        _validate_bot_models(data)
        last_seq = store.latest_event_seq()
        bot = store.create_bot(data, created_by="user", strict_permissions=True)
        runtime.publish_since(last_seq)
        return {"bot": bot}

    @router.get("/bots/{bot_id}")
    async def get_bot(bot_id: str):
        return {"bot": store.get_bot(bot_id)}

    @router.patch("/bots/{bot_id}")
    async def update_bot(bot_id: str, payload: BotUpdateBody, request: Request):
        _ensure_same_origin(request)
        data = payload.model_dump(exclude_none=True)
        _validate_bot_models(data)
        last_seq = store.latest_event_seq()
        bot = store.update_bot(bot_id, data, actor_is_manager=True, strict_permissions=True)
        runtime.publish_since(last_seq)
        return {"bot": bot}

    @router.post("/bots/{bot_id}/archive")
    async def archive_bot(bot_id: str, payload: BotArchiveBody, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        bot = store.archive_bot(bot_id, reason=payload.reason)
        runtime.publish_since(last_seq)
        return {"bot": bot}

    @router.post("/bots/{bot_id}/restore")
    async def restore_bot(bot_id: str, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        bot = store.restore_bot(bot_id)
        runtime.publish_since(last_seq)
        return {"bot": bot}

    # -- Skills ----------------------------------------------------------

    @router.get("/bots/{bot_id}/skills")
    async def get_bot_skills(bot_id: str):
        bot = store.get_bot(bot_id)
        return {"bot_id": bot_id, "skills": bot["skills"]}

    @router.put("/bots/{bot_id}/skills")
    async def set_bot_skills(bot_id: str, payload: BotSkillsBody, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        skills = store.set_bot_skills(bot_id, payload.skills)
        runtime.publish_since(last_seq)
        return {"bot_id": bot_id, "skills": skills}

    # -- Memories --------------------------------------------------------

    @router.get("/bots/{bot_id}/memories")
    async def list_bot_memories(bot_id: str, scope: str = "", project_id: str = ""):
        store.get_bot(bot_id)
        return {"memories": store.list_memories(bot_id, scope=scope, project_id=project_id)}

    @router.post("/bots/{bot_id}/memories")
    async def add_bot_memory(bot_id: str, payload: MemoryCreateBody, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        memory, created = store.add_memory(
            bot_id, payload.content, scope=payload.scope, project_id=payload.project_id, source=payload.source
        )
        runtime.publish_since(last_seq)
        return {"memory": memory, "created": created}

    @router.patch("/bots/{bot_id}/memories/{memory_id}")
    async def update_bot_memory(bot_id: str, memory_id: str, payload: MemoryUpdateBody, request: Request):
        _ensure_same_origin(request)
        memory = store.update_memory(bot_id, memory_id, payload.content)
        return {"memory": memory}

    @router.delete("/bots/{bot_id}/memories/{memory_id}")
    async def delete_bot_memory(bot_id: str, memory_id: str, request: Request):
        _ensure_same_origin(request)
        store.delete_memory(bot_id, memory_id)
        return {"ok": True}

    # -- Sessions & Messages --------------------------------------------

    @router.get("/bots/{bot_id}/sessions")
    async def list_sessions(bot_id: str, include_archived: bool = False, project_id: str = "", canvas_id: str = ""):
        store.get_bot(bot_id)
        return {
            "sessions": store.list_sessions(
                bot_id, include_archived=include_archived, project_id=project_id, canvas_id=canvas_id
            )
        }

    @router.post("/bots/{bot_id}/sessions")
    async def create_session(bot_id: str, payload: SessionCreateBody, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        session = store.create_session(
            bot_id,
            title=payload.title,
            kind=payload.kind,
            project_id=payload.project_id,
            canvas_id=payload.canvas_id,
            pinned=payload.pinned,
        )
        runtime.publish_since(last_seq)
        return {"session": session}

    @router.patch("/sessions/{session_id}")
    async def update_session(session_id: str, payload: SessionUpdateBody, request: Request):
        _ensure_same_origin(request)
        session = store.update_session(session_id, payload.model_dump(exclude_none=True))
        return {"session": session}

    def _run_snapshots_for(links: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if multi_agent_adapter is None or not links:
            return []
        snaps: List[Dict[str, Any]] = []
        for lk in links[:8]:
            try:
                snap = multi_agent_adapter.store.snapshot(lk["multi_agent_run_id"], lk["project_id"], lk["canvas_id"])
                run = snap.get("run") or {}
                tasks = snap.get("tasks") or []
                actions = snap.get("actions") or []
                snaps.append({
                    "multi_agent_run_id": lk["multi_agent_run_id"],
                    "bot_id": lk["bot_id"],
                    "turn_id": lk["turn_id"],
                    "project_id": lk["project_id"],
                    "canvas_id": lk["canvas_id"],
                    "status": run.get("status", lk["status"]),
                    "recovery_required": bool(run.get("recovery_required")),
                    "error": run.get("error", ""),
                    "temporary_subagents": [
                        {
                            "task_id": t["task_id"],
                            "role": t["agent_role"],
                            "goal": t["goal"][:120],
                            "status": t["status"],
                            "is_temporary_subagent": True,
                        }
                        for t in tasks if t.get("parent_task_id")
                    ],
                    "actions": [
                        {
                            "action_id": a["action_id"],
                            "tool": (a.get("operation") or {}).get("tool", ""),
                            "status": a.get("status", ""),
                            "approved": bool(a.get("approved")),
                            "stage": a.get("stage", ""),
                            "error": a.get("error", ""),
                            "node_ids": (a.get("result") or {}).get("node_ids") or [],
                        }
                        for a in actions
                    ],
                })
            except Exception:
                continue
        return snaps

    @router.get("/sessions/{session_id}/messages")
    async def list_messages(session_id: str, after: int = 0, limit: int = 200):
        data = store.list_messages(session_id, after=after, limit=limit)
        turns = store.list_turns(session_id=session_id, limit=20)
        approvals = store.list_approvals(session_id=session_id, status="pending", limit=20)
        run_links = store.list_run_links(session_id=session_id, limit=20)
        return {
            **data,
            "turns": turns,
            "approvals": approvals,
            "run_links": run_links,
            "run_snapshots": _run_snapshots_for(run_links),
        }

    @router.post("/sessions/{session_id}/messages")
    async def send_message(session_id: str, payload: MessageSendBody, request: Request):
        _ensure_same_origin(request)
        if contains_secret_text(payload.content):
            raise BotWorkspaceError("secret_rejected", "消息内容包含疑似 API Key 或敏感令牌，已拒绝发送与存储", 422)
        message, turn, created = runtime.enqueue_user_message(
            session_id,
            content=payload.content,
            attachments=payload.attachments,
            meta=payload.meta,
            idempotency_key=payload.idempotency_key,
            project_id=payload.project_id,
            canvas_id=payload.canvas_id,
            model_override=payload.model_override,
        )
        return {"message": message, "turn": turn, "created": created}

    # -- Turns / Delegations / Approvals / Presence ----------------------

    @router.get("/turns")
    async def list_turns(bot_id: str = "", session_id: str = "", status: str = "", limit: int = 50):
        return {"turns": store.list_turns(bot_id=bot_id, session_id=session_id, status=status, limit=limit)}

    @router.get("/turns/{turn_id}")
    async def get_turn(turn_id: str):
        turn = store.get_turn(turn_id)
        delegations = store.list_delegations(parent_turn_id=turn_id, limit=50)
        run_links = store.list_run_links(turn_id=turn_id, limit=20)
        return {"turn": turn, "delegations": delegations, "run_links": run_links}

    @router.post("/turns/{turn_id}/cancel")
    async def cancel_turn(turn_id: str, payload: TurnCancelBody, request: Request):
        _ensure_same_origin(request)
        turn = await runtime.cancel_turn(turn_id, reason=payload.reason)
        return {"turn": turn}

    @router.post("/turns/{turn_id}/retry")
    async def retry_turn(turn_id: str, request: Request):
        _ensure_same_origin(request)
        turn = runtime.retry_turn(turn_id)
        return {"turn": turn}

    @router.post("/turns/{turn_id}/resume")
    async def resume_turn(turn_id: str, request: Request):
        _ensure_same_origin(request)
        turn = await runtime.resume_turn(turn_id)
        return {"turn": turn}

    @router.get("/delegations")
    async def list_delegations(parent_bot_id: str = "", target_bot_id: str = "", parent_turn_id: str = "", limit: int = 50):
        return {
            "delegations": store.list_delegations(
                parent_bot_id=parent_bot_id,
                target_bot_id=target_bot_id,
                parent_turn_id=parent_turn_id,
                limit=limit,
            )
        }

    @router.get("/approvals")
    async def list_approvals(bot_id: str = "", session_id: str = "", status: str = "", limit: int = 50):
        return {"approvals": store.list_approvals(bot_id=bot_id, session_id=session_id, status=status, limit=limit)}

    @router.post("/approvals/{approval_id}/resolve")
    async def resolve_approval(approval_id: str, payload: ApprovalResolveBody, request: Request):
        _ensure_same_origin(request)
        last_seq = store.latest_event_seq()
        approval = store.resolve_approval(approval_id, payload.approved)
        execution_result = None
        if runtime.tool_executor is not None and hasattr(runtime.tool_executor, "on_approval_resolved"):
            execution_result = await runtime.tool_executor.on_approval_resolved(approval, runtime=runtime)
        runtime.publish_since(last_seq)
        return {"approval": approval, "execution": execution_result}

    @router.post("/canvas-presence")
    async def canvas_presence(payload: CanvasPresenceBody, request: Request):
        _ensure_same_origin(request)
        return runtime.heartbeat_canvas(payload.project_id, payload.canvas_id, client_id=payload.client_id)

    # -- 事件流（SSE 断线恢复 + 单次增量查询） -----------------------------

    @router.get("/events/poll")
    async def poll_events(after: int = 0, limit: int = 200, bot_id: str = "", session_id: str = "", project_id: str = "", canvas_id: str = ""):
        events = store.list_events(
            after=after, limit=limit, bot_id=bot_id, session_id=session_id, project_id=project_id, canvas_id=canvas_id
        )
        cursor = events[-1]["seq"] if events else max(0, int(after or 0))
        return {"events": events, "cursor": cursor}

    @router.get("/events")
    async def stream_events(
        request: Request,
        after: int = 0,
        bot_id: str = "",
        session_id: str = "",
        project_id: str = "",
        canvas_id: str = "",
    ):
        header_id = request.headers.get("last-event-id") or ""
        try:
            start_seq = max(int(after or 0), int(header_id) if header_id.isdigit() else 0)
        except ValueError:
            start_seq = max(0, int(after or 0))

        def _matches(evt: Dict[str, Any]) -> bool:
            if bot_id and evt.get("bot_id") and evt["bot_id"] != bot_id:
                return False
            if session_id and evt.get("session_id") and evt["session_id"] != session_id:
                return False
            if project_id and evt.get("project_id") and evt["project_id"] != project_id:
                return False
            if canvas_id and evt.get("canvas_id") and evt["canvas_id"] != canvas_id:
                return False
            return True

        async def event_generator():
            queue = runtime.broker.subscribe()
            sent_seq = start_seq
            try:
                # 先补发断线期间持久化的全部增量事件
                backlog = store.list_events(
                    after=sent_seq, limit=200, bot_id=bot_id, session_id=session_id,
                    project_id=project_id, canvas_id=canvas_id,
                )
                for evt in backlog:
                    sent_seq = max(sent_seq, int(evt["seq"]))
                    yield f"id: {evt['seq']}\nevent: {evt['event_type']}\ndata: {json.dumps(evt, ensure_ascii=False)}\n\n"
                yield f"event: ready\ndata: {json.dumps({'cursor': sent_seq})}\n\n"

                while not runtime._stopping:
                    if await request.is_disconnected():
                        break
                    try:
                        evt = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
                        continue
                    if int(evt.get("seq") or 0) <= sent_seq:
                        continue
                    if not _matches(evt):
                        continue
                    sent_seq = int(evt["seq"])
                    yield f"id: {evt['seq']}\nevent: {evt['event_type']}\ndata: {json.dumps(evt, ensure_ascii=False)}\n\n"
            finally:
                runtime.broker.unsubscribe(queue)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    app.include_router(router)
    return {"store": store, "runtime": runtime, "router": router}
