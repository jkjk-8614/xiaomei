"""设计大脑 · Bot 团队路由（P0）。

前缀 ``/api/design-brain``，仅限本机访问；写操作额外校验同源。所有业务
错误统一走 ``design_brain_api._error_response``，返回 ``{detail, code}``。

P0 范围：团队/成员/群/会话/消息的读写与能力注册表。回合引擎（谁说话、
@ 接力、PASS、暂停）在 P1 的 ``design_brain_turns.py`` 中，本模块的
``POST /chats/{id}/messages`` 只落消息并返回游标，不做模型调用。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from design_brain_api import (
    DATA_ROOT,
    REFERENCES as REFERENCE_STORE,
    STORE as PROFILE_STORE,
    _ensure_same_origin,
    _error_response,
    _local_only_dependency,
)
from design_brain_store import DesignBrainError
from design_brain_memory import ENTRY_MAX, MEMORY_SCOPES, MemoryReviewer, MemoryStore
from design_brain_tools import DesignToolbox
from design_brain_usage import UsageStore, today_key
from design_brain_team import (
    BOT_INSTRUCTIONS_MAX,
    BOT_PERSONALITY_MAX,
    BOT_TASK_MAX,
    GROUP_MEMBERS_MAX,
    GROUP_NOTICE_MAX,
    MESSAGE_LIMIT_DEFAULT,
    MESSAGE_LIMIT_MAX,
    MESSAGE_TEXT_MAX,
    TEAM,
)
from design_brain_turns import TurnEngine

router = APIRouter(prefix="/api/design-brain", dependencies=[Depends(_local_only_dependency)])

MEMORY = MemoryStore(DATA_ROOT)
USAGE = UsageStore(DATA_ROOT)

# 回合引擎在 main.py 里注入（需要 canvas_llm 与五阶段编排器）；单测或纯数据
# 场景下保持 None，此时发消息只落库，不触发模型调用。
ENGINE: Optional[TurnEngine] = None


def configure_engine(host, orchestrator=None) -> TurnEngine:
    global ENGINE
    toolbox = DesignToolbox(host, TEAM, orchestrator, PROFILE_STORE, REFERENCE_STORE,
                            MEMORY, usage=USAGE)
    ENGINE = TurnEngine(host, TEAM, orchestrator, memory=MEMORY,
                        reviewer=MemoryReviewer(host, MEMORY, PROFILE_STORE, usage=USAGE),
                        toolbox=toolbox, usage=USAGE)
    return ENGINE

MCP_CONFIG = TEAM.root.parent.parent / "mcp_servers.json"
SKILL_INDEX = TEAM.root.parent.parent / "agent_skills" / "package-index.json"


class BotCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    role: str = Field(default="", max_length=200)
    instructions: str = Field(default="", max_length=BOT_INSTRUCTIONS_MAX)
    personality: str = Field(default="", max_length=BOT_PERSONALITY_MAX)
    task: str = Field(default="", max_length=BOT_TASK_MAX)
    avatar: Dict[str, Any] = Field(default_factory=dict)
    model: Dict[str, Any] = Field(default_factory=dict)
    vision_model: Dict[str, Any] = Field(default_factory=dict)
    image_model: Dict[str, Any] = Field(default_factory=dict)
    capabilities: List[str] = Field(default_factory=list, max_length=16)
    permission: str = "workspace"


class BotUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=40)
    role: Optional[str] = Field(default=None, max_length=200)
    instructions: Optional[str] = Field(default=None, max_length=BOT_INSTRUCTIONS_MAX)
    personality: Optional[str] = Field(default=None, max_length=BOT_PERSONALITY_MAX)
    task: Optional[str] = Field(default=None, max_length=BOT_TASK_MAX)
    avatar: Optional[Dict[str, Any]] = None
    model: Optional[Dict[str, Any]] = None
    vision_model: Optional[Dict[str, Any]] = None
    image_model: Optional[Dict[str, Any]] = None
    capabilities: Optional[List[str]] = Field(default=None, max_length=16)
    permission: Optional[str] = None
    status: Optional[str] = None


class GroupCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    notice: str = Field(default="", max_length=GROUP_NOTICE_MAX)
    admin_bot_id: str = ""
    members: List[str] = Field(default_factory=list, max_length=GROUP_MEMBERS_MAX)
    reply_mode: str = "admin_first"
    relay_limit: int = Field(default=8, ge=2, le=40)
    project: Dict[str, Any] = Field(default_factory=dict)


class GroupUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=60)
    notice: Optional[str] = Field(default=None, max_length=GROUP_NOTICE_MAX)
    admin_bot_id: Optional[str] = None
    members: Optional[List[str]] = Field(default=None, max_length=GROUP_MEMBERS_MAX)
    reply_mode: Optional[str] = None
    relay_limit: Optional[int] = Field(default=None, ge=2, le=40)
    project: Optional[Dict[str, Any]] = None


class MessageCreateRequest(BaseModel):
    text: str = Field(default="", max_length=MESSAGE_TEXT_MAX)
    mentions: List[str] = Field(default_factory=list, max_length=12)
    reply_to: str = ""
    task_id: str = ""
    kind: str = "text"
    meta: Dict[str, Any] = Field(default_factory=dict)
    models: Dict[str, Any] = Field(default_factory=dict)


class StopWorkRequest(BaseModel):
    work_id: str = Field(min_length=1, max_length=240)


def _guarded(handler):
    """把 DesignBrainError 转成统一错误响应，避免每处 try/except 重复。"""
    try:
        return handler()
    except DesignBrainError as exc:
        return _error_response(exc)


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            data = json.load(stream)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _external_capabilities() -> Dict[str, Any]:
    """外部能力只做只读投影：MCP 服务与 Skill 包仍由各自模块管理。"""
    mcp_state = _read_json(MCP_CONFIG)
    servers = mcp_state.get("servers") if isinstance(mcp_state.get("servers"), list) else []
    mcp = [
        {"id": str(item.get("name") or ""), "enabled": bool(item.get("enabled")),
         "transport": str(item.get("transport") or "stdio")}
        for item in servers if isinstance(item, dict) and item.get("name")
    ]
    skill_state = _read_json(SKILL_INDEX)
    packages = skill_state.get("packages") if isinstance(skill_state.get("packages"), dict) else {}
    skills = [
        {"id": str(key), "name": str((value or {}).get("display_name") or (value or {}).get("name") or key),
         "enabled": bool((value or {}).get("enabled"))}
        for key, value in packages.items()
    ]
    return {"mcp": mcp, "skills": skills}


@router.get("/team")
async def team_overview(request: Request):
    _local_only_dependency(request)
    TEAM.ensure_seeded()
    snapshot = TEAM.snapshot()
    snapshot["external"] = _external_capabilities()
    return snapshot


@router.get("/capabilities")
async def capabilities(request: Request):
    _local_only_dependency(request)
    registry = TEAM.capabilities()
    return {**registry, "external": _external_capabilities()}


@router.get("/team/work")
async def team_work(request: Request):
    _local_only_dependency(request)
    return _guarded(lambda: {"work": ENGINE.work() if ENGINE else []})


@router.post("/team/work/stop")
async def stop_member_work(payload: StopWorkRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    if not ENGINE:
        raise HTTPException(status_code=409, detail="团队工作服务尚未启动，请重启小美画布后重试")
    try:
        return await ENGINE.stop_work(payload.work_id)
    except DesignBrainError as exc:
        return _error_response(exc)


@router.get("/bots")
async def list_bots(request: Request, include_archived: bool = False):
    _local_only_dependency(request)
    TEAM.ensure_seeded()
    return {"bots": TEAM.list_bots(include_archived=include_archived)}


@router.post("/bots")
async def create_bot(payload: BotCreateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.create_bot(payload.model_dump()))


@router.get("/bots/{bot_id}")
async def get_bot(bot_id: str, request: Request):
    _local_only_dependency(request)
    return _guarded(lambda: TEAM.get_bot(bot_id))


@router.patch("/bots/{bot_id}")
async def update_bot(bot_id: str, payload: BotUpdateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.update_bot(bot_id, payload.model_dump(exclude_none=True)))


@router.delete("/bots/{bot_id}")
async def archive_bot(bot_id: str, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.archive_bot(bot_id))


@router.post("/bots/{bot_id}/restore")
async def restore_bot(bot_id: str, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.restore_bot(bot_id))


@router.post("/bots/{bot_id}/chat")
async def open_bot_chat(bot_id: str, request: Request):
    """打开（或创建）与某个 Bot 的私聊会话。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.ensure_dm_chat(bot_id))


@router.get("/groups")
async def list_groups(request: Request, include_archived: bool = False):
    _local_only_dependency(request)
    TEAM.ensure_seeded()
    return {"groups": TEAM.list_groups(include_archived=include_archived)}


@router.post("/groups")
async def create_group(payload: GroupCreateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.create_group(payload.model_dump()))


@router.get("/groups/{group_id}")
async def get_group(group_id: str, request: Request):
    _local_only_dependency(request)
    return _guarded(lambda: TEAM.get_group(group_id))


@router.patch("/groups/{group_id}")
async def update_group(group_id: str, payload: GroupUpdateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.update_group(group_id, payload.model_dump(exclude_none=True)))


@router.delete("/groups/{group_id}")
async def archive_group(group_id: str, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.archive_group(group_id))


@router.get("/chats")
async def list_chats(request: Request):
    _local_only_dependency(request)
    TEAM.ensure_seeded()
    return {"chats": TEAM.list_chats()}


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    _local_only_dependency(request)
    return _guarded(lambda: TEAM.get_chat(chat_id))


@router.get("/chats/{chat_id}/messages")
async def list_messages(chat_id: str, request: Request, after: int = 0,
                        limit: int = MESSAGE_LIMIT_DEFAULT):
    _local_only_dependency(request)
    return _guarded(lambda: TEAM.list_messages(chat_id, after=after,
                                               limit=max(1, min(MESSAGE_LIMIT_MAX, limit))))


@router.post("/chats/{chat_id}/messages")
async def create_message(chat_id: str, payload: MessageCreateRequest, request: Request):
    """用户发言：落库 → 记下本次选择的模型 → 启动回合（有引擎时）。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)
    text = str(payload.text or "").strip()
    if not text and not payload.meta:
        raise HTTPException(status_code=422, detail="消息内容不能为空")

    def store():
        models = _clean_models(payload.models)
        if models:
            TEAM.update_chat(chat_id, {"defaults": {**TEAM.get_chat(chat_id).get("defaults", {}), **models}})
        TEAM.update_chat(chat_id, {"relay_count": 0, "paused": False})
        return TEAM.append_message(
            chat_id, role="user", text=text, mentions=payload.mentions,
            kind=payload.kind, reply_to=payload.reply_to, task_id=payload.task_id,
            meta=payload.meta,
        )

    message = _guarded(store)
    if isinstance(message, JSONResponse):
        return message
    queued = bool(ENGINE and ENGINE.start(chat_id))
    return {"message": message, "cursor": message["seq"],
            "turn": {"queued": queued, **((ENGINE.status(chat_id)) if ENGINE else {"running": False})}}


@router.get("/chats/{chat_id}/turn")
async def turn_status(chat_id: str, request: Request):
    _local_only_dependency(request)
    if not ENGINE:
        return {"running": False, "bot_id": "", "bot_name": "", "started_at": 0, "spoken": 0}
    return ENGINE.status(chat_id)


@router.post("/chats/{chat_id}/stop")
async def stop_turn(chat_id: str, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    if not ENGINE:
        return {"stopped": False}
    return {"stopped": await ENGINE.stop(chat_id)}


@router.post("/chats/{chat_id}/continue")
async def continue_turn(chat_id: str, request: Request):
    """接力暂停或用户想追加一轮时继续；不动历史消息，只重置计数并启动。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)
    TEAM.update_chat(chat_id, {"relay_count": 0, "paused": False})
    queued = bool(ENGINE and ENGINE.start(chat_id))
    return {"queued": queued}


def _clean_models(raw: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key in ("chat", "vision", "image"):
        item = raw.get(key) if isinstance(raw, dict) else None
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "").strip()[:80]
        model = str(item.get("model") or "").strip()[:160]
        if provider and model:
            result[key] = {"provider": provider, "model": model}
    return result


# ---------------------------------------------------------------------------
# 三层记忆（P2）
# ---------------------------------------------------------------------------

class MemoryCreateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=ENTRY_MAX)
    source: str = Field(default="用户", max_length=40)


class MemoryUpdateRequest(BaseModel):
    index: int = Field(ge=0)
    text: str = Field(default="", max_length=ENTRY_MAX)
    remove: bool = False


class MemoryReviewRequest(BaseModel):
    chat_id: str = Field(default="", max_length=60)


@router.get("/memory/{scope}/{scope_id}")
async def read_memory(scope: str, scope_id: str, request: Request):
    _local_only_dependency(request)
    if scope not in MEMORY_SCOPES:
        raise HTTPException(status_code=422, detail="记忆范围无效")
    return _guarded(lambda: MEMORY.read(scope, scope_id))


@router.post("/memory/{scope}/{scope_id}")
async def add_memory(scope: str, scope_id: str, payload: MemoryCreateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: MEMORY.add(scope, scope_id, payload.text, source=payload.source))


@router.patch("/memory/{scope}/{scope_id}")
async def update_memory(scope: str, scope_id: str, payload: MemoryUpdateRequest, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    if payload.remove:
        return _guarded(lambda: MEMORY.remove(scope, scope_id, payload.index))
    return _guarded(lambda: MEMORY.update(scope, scope_id, payload.index, payload.text))


@router.post("/memory/{scope}/{scope_id}/review")
async def review_memory(scope: str, scope_id: str, payload: MemoryReviewRequest, request: Request):
    """手动触发一次整理：读该会话最近消息，产出记忆与档案候选。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)
    if not payload.chat_id or not ENGINE:
        raise HTTPException(status_code=422, detail="请指定会话，且回合引擎需已启用")
    return await ENGINE.review_now(payload.chat_id)


@router.get("/profile-suggestions")
async def list_profile_suggestions(request: Request):
    _local_only_dependency(request)
    profile = PROFILE_STORE.read()["profile"]
    return {"suggestions": profile.get("pending_suggestions") or []}


@router.post("/profile-suggestions/{suggestion_id}/accept")
async def accept_profile_suggestion(suggestion_id: str, request: Request):
    """把记忆提出的标签候选写入审美档案；带 revision 校验，冲突时重读一次。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)

    def apply() -> Dict[str, Any]:
        for attempt in range(2):
            state = PROFILE_STORE.read()
            profile = state["profile"]
            pending = list(profile.get("pending_suggestions") or [])
            item = next((entry for entry in pending if str(entry.get("id")) == suggestion_id), None)
            if not item:
                raise DesignBrainError("suggestion_not_found", "该建议不存在或已被处理", 404)
            group_name = str(item.get("group") or "")
            tag = str(item.get("tag") or "").strip()
            if item.get("kind") == "tag" and group_name in profile["aesthetics"] and tag:
                entries = list(profile["aesthetics"][group_name])
                if not any(entry.get("tag") == tag for entry in entries):
                    entries.append({"tag": tag, "weight": item.get("weight") or 0.6, "origin": "memory"})
                profile["aesthetics"][group_name] = entries
            profile["pending_suggestions"] = [entry for entry in pending
                                              if str(entry.get("id")) != suggestion_id]
            try:
                return PROFILE_STORE.update(profile, expected_revision=state["revision"])
            except DesignBrainError as exc:
                if exc.code != "revision_conflict" or attempt == 1:
                    raise
        raise DesignBrainError("revision_conflict", "档案已被其他窗口更新，请重试", 409)

    return _guarded(apply)


@router.delete("/profile-suggestions/{suggestion_id}")
async def reject_profile_suggestion(suggestion_id: str, request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)

    def discard() -> Dict[str, Any]:
        state = PROFILE_STORE.read()
        profile = state["profile"]
        pending = [entry for entry in (profile.get("pending_suggestions") or [])
                   if str(entry.get("id")) != suggestion_id]
        profile["pending_suggestions"] = pending
        return PROFILE_STORE.update(profile, expected_revision=state["revision"])

    return _guarded(discard)


@router.get("/team/settings")
async def get_team_settings(request: Request):
    _local_only_dependency(request)
    return TEAM.settings()


@router.put("/team/settings")
async def put_team_settings(payload: Dict[str, Any], request: Request):
    _local_only_dependency(request)
    _ensure_same_origin(request)
    return _guarded(lambda: TEAM.update_settings(payload))


# ---------------------------------------------------------------------------
# 用量与审批（P4）
# ---------------------------------------------------------------------------

class ApprovalRequest(BaseModel):
    approve: bool = True


@router.get("/usage")
async def usage_summary(request: Request, date: str = ""):
    _local_only_dependency(request)
    summary = USAGE.summary(date or today_key())
    summary["settings"] = TEAM.settings()
    return summary


@router.post("/chats/{chat_id}/approvals/{approval_id}")
async def resolve_approval(chat_id: str, approval_id: str, payload: ApprovalRequest,
                           request: Request):
    """用户对需要确认的动作表态：允许则立即执行，拒绝只记录。"""
    _local_only_dependency(request)
    _ensure_same_origin(request)
    chat = _guarded(lambda: TEAM.get_chat(chat_id))
    if isinstance(chat, JSONResponse):
        return chat
    approval = (chat.get("approvals") or {}).get(approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="该审批不存在")
    if approval["status"] != "pending":
        raise HTTPException(status_code=409, detail="该审批已处理")
    if not payload.approve:
        TEAM.resolve_approval(chat_id, approval_id, "rejected")
        TEAM.append_message(chat_id, role="system", kind="activity", status="sent",
                            text=f"已拒绝：{approval.get('summary') or approval['tool']}")
        return {"approval": TEAM.get_chat(chat_id)["approvals"][approval_id], "executed": False}
    TEAM.resolve_approval(chat_id, approval_id, "approved")
    if not ENGINE or not getattr(ENGINE, "toolbox", None):
        TEAM.append_message(chat_id, role="system", kind="activity", status="sent",
                            text="已允许，但工具运行时未启用，动作没有执行。")
        return {"approval": TEAM.get_chat(chat_id)["approvals"][approval_id], "executed": False}
    try:
        bot = TEAM.get_bot(approval["bot_id"])
    except DesignBrainError as exc:
        return _error_response(exc)
    group = None
    if chat.get("kind") == "group" and chat.get("group_id"):
        try:
            group = TEAM.get_group(chat["group_id"])
        except DesignBrainError:
            group = None
    result, ok = await ENGINE.toolbox.invoke(
        approval["tool"], approval.get("args") or {}, bot=bot, chat=chat, group=group)
    images = [value for value in (result.get("outputs") or []) if isinstance(value, str)][:6]
    task_id = str(result.get("task_id") or "")
    if ok:
        text = f"已允许并执行：{approval.get('summary') or approval['tool']}"
        TEAM.append_message(chat_id, role="bot", bot_id=bot["id"], kind="result",
                            status="done", text=text, task_id=task_id,
                            meta={"tool": approval["tool"], "task_id": task_id, "images": images})
    else:
        TEAM.append_message(chat_id, role="system", kind="activity", status="sent",
                            text=f"已允许，但执行失败：{result.get('error') or '未知原因'}")
    return {"approval": TEAM.get_chat(chat_id)["approvals"][approval_id],
            "executed": ok, "result": result}
