"""设计大脑 · Bot 团队数据层（P0）。

把原来写死在 ``design_brain_bots.py`` 里的 5 个 BOT，升级成可配置的持久团队。
新增数据域全部落在 ``data/design_brain/team/``：

    team/
      bots.json                 Bot 定义（≤ BOT_LIST_MAX）
      groups.json               群定义（≤ GROUP_LIST_MAX）
      capabilities.json         能力包注册表（内置 pack + 外部挂载引用）
      chats/<chat_id>/
        chat.json               会话元信息（成员、游标、暂停状态）
        messages.jsonl          追加写，一行一条
        archive/                超出上限后滚存的历史消息
      memory/                   三层记忆（P2 落地，本阶段只建目录）

存储约定与 ``design_brain_store`` 完全一致：``threading.RLock`` 串行化写、
临时文件 + ``os.replace`` 原子落盘、读时规范化并裁剪上限、坏文件显式报错
（fail-closed），绝不静默丢用户数据。

本模块不依赖 FastAPI，可单独被单测与脚本引用；路由在
``design_brain_team_api.py``。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from design_brain_store import DesignBrainError, now_ms
from runtime_paths import resolve_roots

# ---------------------------------------------------------------------------
# 上限与枚举
# ---------------------------------------------------------------------------

BOT_LIST_MAX = 50
GROUP_LIST_MAX = 30
CHAT_LIST_MAX = 60
MESSAGE_LIMIT_DEFAULT = 100
MESSAGE_LIMIT_MAX = 500
MESSAGE_FILE_MAX = 5000
MESSAGE_TEXT_MAX = 8000
MENTIONS_MAX = 12

BOT_NAME_MAX = 40
BOT_ROLE_MAX = 200
BOT_INSTRUCTIONS_MAX = 4000
BOT_CAPABILITIES_MAX = 16
GROUP_NAME_MAX = 60
GROUP_NOTICE_MAX = 2000
GROUP_MEMBERS_MAX = 12

BOT_STATUSES = ("active", "archived")
BOT_PERMISSIONS = ("full", "workspace", "read")
REPLY_MODES = ("admin_first", "round_robin")
CHAT_KINDS = ("dm", "group")
MESSAGE_ROLES = ("user", "bot", "system")
MESSAGE_KINDS = ("text", "card", "activity", "approval", "result")
MESSAGE_STATUSES = ("sent", "working", "done", "failed", "skipped")
APPROVAL_STATUSES = ("pending", "approved", "rejected")
APPROVALS_MAX = 20

ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,47}$")

# ---------------------------------------------------------------------------
# 内置能力包：与交付文档 14 §4.3 一一对应
# ---------------------------------------------------------------------------

CAPABILITY_PACKS: List[Dict[str, Any]] = [
    {
        "id": "pack.read",
        "name": "资料读取",
        "description": "读审美档案摘要、按品类/用途/关键词检索个人参考库",
        "tools": ["brain.profile.read", "brain.references.search"],
    },
    {
        "id": "pack.plan",
        "name": "方案规划",
        "description": "分析参考图、产出结构化设计方案",
        "tools": ["brain.references.analyze", "brain.plan.compose"],
    },
    {
        "id": "pack.execute",
        "name": "生成执行",
        "description": "提交与查询画布生图任务（幂等、可取消）",
        "tools": ["brain.generate.submit", "brain.generate.status"],
    },
    {
        "id": "pack.review",
        "name": "质量检查",
        "description": "视觉质检并输出问题、证据与修正建议",
        "tools": ["brain.review.check"],
    },
    {
        "id": "pack.workflow",
        "name": "标准流水线",
        "description": "跑完整的参考分析→规划→确认→生成→质检管线",
        "tools": ["brain.workflow.run", "brain.task.create", "brain.task.confirm", "brain.task.cancel"],
    },
    {
        "id": "pack.team",
        "name": "团队管理",
        "description": "创建与调整 Bot、群（仅主 Bot）",
        "tools": ["brain.team.create_bot", "brain.team.update_bot",
                  "brain.team.create_group", "brain.team.update_group"],
    },
    {
        "id": "pack.memory",
        "name": "记忆",
        "description": "读写 Bot / 群 / 团队三层记忆",
        "tools": ["brain.memory.remember", "brain.memory.forget", "brain.memory.recall"],
    },
]

CAPABILITY_IDS = tuple(pack["id"] for pack in CAPABILITY_PACKS)

# ---------------------------------------------------------------------------
# 默认团队：由现有 BOT_CATALOG 平移，id 保持可读
# ---------------------------------------------------------------------------

DEFAULT_BOT_SEEDS: List[Dict[str, Any]] = [
    {
        "id": "bot_director", "name": "设计总监",
        "role": "理解需求、拆任务、调度团队、汇总交付",
        "avatar": {"text": "总", "color": "#2F6F5E"},
        "capabilities": ["pack.read", "pack.plan", "pack.workflow", "pack.team", "pack.memory"],
        "is_main": True,
    },
    {
        "id": "bot_reference", "name": "参考分析",
        "role": "检索个人参考库，挑选高相关案例与可借鉴点",
        "avatar": {"text": "参", "color": "#3C6E9F"},
        "capabilities": ["pack.read", "pack.plan", "pack.memory"],
    },
    {
        "id": "bot_planner", "name": "设计规划",
        "role": "制定方案：每张图的提示词、尺寸、用途与验收标准",
        "avatar": {"text": "规", "color": "#7A5AA8"},
        "capabilities": ["pack.read", "pack.plan", "pack.memory"],
    },
    {
        "id": "bot_executor", "name": "生成执行",
        "role": "按已确认方案提交生图任务、轮询结果、记录模型与参数",
        "avatar": {"text": "生", "color": "#B07A2E"},
        "capabilities": ["pack.execute", "pack.memory"],
    },
    {
        "id": "bot_reviewer", "name": "质量检查",
        "role": "按验收标准检查结构、材质、构图与文案，输出问题与证据",
        "avatar": {"text": "检", "color": "#A8463F"},
        "capabilities": ["pack.review", "pack.memory"],
    },
]

DEFAULT_GROUP_SEED = {
    "id": "grp_default",
    "name": "设计项目群",
    "notice": "",
    "admin_bot_id": "bot_director",
    "members": [seed["id"] for seed in DEFAULT_BOT_SEEDS],
    "reply_mode": "admin_first",
    "relay_limit": 8,
}

# 团队成员只保存职责；回合输出协议由 TurnEngine 提供。
FALLBACK_INSTRUCTIONS = {
    "bot_director": "你是小美画布的设计总监。理解用户的电商设计需求，判断是直接回答还是创建设计任务；需要时调度其他 Bot 并汇总交付。",
    "bot_reference": "你是参考分析 Bot。从个人参考库中挑选与当前任务最相关的案例，说明可借鉴点。",
    "bot_planner": "你是设计规划 Bot。基于任务单、参考分析与审美档案制定可执行方案，给出每张图的提示词、尺寸与验收标准。",
    "bot_executor": "你是生成执行 Bot。严格按已确认方案提交生图任务，记录模型与参数，不擅自更改设计方向。",
    "bot_reviewer": "你是质量检查 Bot。按验收标准检查生成图片的结构、材质、构图与文案，输出问题、证据与修正建议。",
}

# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _clean_id(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if ID_RE.match(candidate) else ""


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def _clean_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _clean_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _clean_str_list(value: Any, limit: int, text_limit: int) -> List[str]:
    if not isinstance(value, (list, tuple)):
        return []
    result: List[str] = []
    for item in value:
        text = _text(item, text_limit)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def normalize_model_choice(raw: Any) -> Dict[str, str]:
    item = raw if isinstance(raw, dict) else {}
    return {
        "provider": _text(item.get("provider"), 80),
        "model": _text(item.get("model"), 160),
    }


def normalize_avatar(raw: Any) -> Dict[str, str]:
    item = raw if isinstance(raw, dict) else {}
    text = _text(item.get("text"), 2)
    color = _text(item.get("color"), 20)
    if not re.match(r"^#[0-9A-Fa-f]{6}$", color):
        color = "#2F6F5E"
    return {"text": text or "?", "color": color}


def normalize_bot(raw: Any, *, fallback_id: str = "") -> Dict[str, Any]:
    """读时规范化：结构性错误才抛，其余字段一律收敛到合法值。"""
    item = raw if isinstance(raw, dict) else {}
    bot_id = _clean_id(item.get("id")) or _clean_id(fallback_id) or _new_id("bot")
    status = str(item.get("status") or "active").strip().lower()
    if status not in BOT_STATUSES:
        status = "active"
    permission = str(item.get("permission") or "workspace").strip().lower()
    if permission not in BOT_PERMISSIONS:
        permission = "workspace"
    capabilities = [value for value in _clean_str_list(item.get("capabilities"), BOT_CAPABILITIES_MAX, 40)
                    if value in CAPABILITY_IDS]
    return {
        "id": bot_id,
        "name": _text(item.get("name"), BOT_NAME_MAX) or "未命名 Bot",
        "role": _text(item.get("role"), BOT_ROLE_MAX),
        "instructions": _text(item.get("instructions"), BOT_INSTRUCTIONS_MAX),
        "avatar": normalize_avatar(item.get("avatar")),
        "model": normalize_model_choice(item.get("model")),
        "vision_model": normalize_model_choice(item.get("vision_model")),
        "image_model": normalize_model_choice(item.get("image_model")),
        "capabilities": capabilities,
        "permission": permission,
        "is_main": _clean_bool(item.get("is_main")),
        "status": status,
        "created_at": _clean_int(item.get("created_at"), 0, 10 ** 15, now_ms()),
        "updated_at": _clean_int(item.get("updated_at"), 0, 10 ** 15, now_ms()),
    }


def normalize_group(raw: Any, *, fallback_id: str = "") -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    group_id = _clean_id(item.get("id")) or _clean_id(fallback_id) or _new_id("grp")
    reply_mode = str(item.get("reply_mode") or "admin_first").strip().lower()
    if reply_mode not in REPLY_MODES:
        reply_mode = "admin_first"
    members = [value for value in _clean_str_list(item.get("members"), GROUP_MEMBERS_MAX, 48)
               if value.startswith("bot_")]
    admin = _clean_id(item.get("admin_bot_id"))
    if admin and admin not in members:
        members.insert(0, admin)
        members = members[:GROUP_MEMBERS_MAX]
    project = item.get("project") if isinstance(item.get("project"), dict) else {}
    return {
        "id": group_id,
        "name": _text(item.get("name"), GROUP_NAME_MAX) or "未命名群",
        "notice": _text(item.get("notice"), GROUP_NOTICE_MAX),
        "admin_bot_id": admin,
        "members": members,
        "reply_mode": reply_mode,
        "relay_limit": _clean_int(item.get("relay_limit"), 2, 40, 8),
        "project": {
            "client": _text(project.get("client"), 80),
            "deadline": _text(project.get("deadline"), 40),
            "task_ids": _clean_str_list(project.get("task_ids"), 50, 60),
        },
        "archived": _clean_bool(item.get("archived")),
        "created_at": _clean_int(item.get("created_at"), 0, 10 ** 15, now_ms()),
        "updated_at": _clean_int(item.get("updated_at"), 0, 10 ** 15, now_ms()),
    }


def normalize_chat(raw: Any, *, fallback_id: str = "") -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    chat_id = _clean_id(item.get("id")) or _clean_id(fallback_id) or _new_id("chat")
    kind = str(item.get("kind") or "dm").strip().lower()
    if kind not in CHAT_KINDS:
        kind = "dm"
    defaults = item.get("defaults") if isinstance(item.get("defaults"), dict) else {}
    approvals_raw = item.get("approvals") if isinstance(item.get("approvals"), dict) else {}
    approvals: Dict[str, Any] = {}
    for key, value in list(approvals_raw.items())[:APPROVALS_MAX]:
        if not isinstance(value, dict):
            continue
        status = str(value.get("status") or "pending").strip().lower()
        if status not in APPROVAL_STATUSES:
            status = "pending"
        approval_id = _clean_id(value.get("id")) or _clean_id(key)
        if not approval_id:
            continue
        approvals[approval_id] = {
            "id": approval_id,
            "tool": _text(value.get("tool"), 60),
            "bot_id": _clean_id(value.get("bot_id")),
            "args": value.get("args") if isinstance(value.get("args"), dict) else {},
            "summary": _text(value.get("summary"), 300),
            "status": status,
            "created_at": _clean_int(value.get("created_at"), 0, 10 ** 15, now_ms()),
            "resolved_at": _clean_int(value.get("resolved_at"), 0, 10 ** 15, 0),
        }
    return {
        "id": chat_id,
        "kind": kind,
        "title": _text(item.get("title"), GROUP_NAME_MAX) or "会话",
        "bot_id": _clean_id(item.get("bot_id")),
        "group_id": _clean_id(item.get("group_id")),
        "members": [value for value in _clean_str_list(item.get("members"), GROUP_MEMBERS_MAX, 48)
                    if value.startswith("bot_")],
        "defaults": {
            "chat": normalize_model_choice(defaults.get("chat")),
            "vision": normalize_model_choice(defaults.get("vision")),
            "image": normalize_model_choice(defaults.get("image")),
        },
        "created_at": _clean_int(item.get("created_at"), 0, 10 ** 15, now_ms()),
        "updated_at": _clean_int(item.get("updated_at"), 0, 10 ** 15, now_ms()),
        "last_message_at": _clean_int(item.get("last_message_at"), 0, 10 ** 15, 0),
        "seq": _clean_int(item.get("seq"), 0, 10 ** 9, 0),
        "paused": _clean_bool(item.get("paused")),
        "relay_count": _clean_int(item.get("relay_count"), 0, 999, 0),
        "approvals": approvals,
    }


def normalize_message(raw: Any, *, chat_id: str = "", fallback_seq: int = 0) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    role = str(item.get("role") or "user").strip().lower()
    if role not in MESSAGE_ROLES:
        role = "user"
    kind = str(item.get("kind") or "text").strip().lower()
    if kind not in MESSAGE_KINDS:
        kind = "text"
    status = str(item.get("status") or "sent").strip().lower()
    if status not in MESSAGE_STATUSES:
        status = "sent"
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    return {
        "id": _clean_id(item.get("id")) or _new_id("msg"),
        "seq": _clean_int(item.get("seq"), 0, 10 ** 9, fallback_seq),
        "chat_id": _clean_id(item.get("chat_id")) or chat_id,
        "role": role,
        "bot_id": _clean_id(item.get("bot_id")),
        "text": _text(item.get("text"), MESSAGE_TEXT_MAX),
        "at": _clean_int(item.get("at"), 0, 10 ** 15, now_ms()),
        "mentions": [value for value in _clean_str_list(item.get("mentions"), MENTIONS_MAX, 48)
                     if value.startswith("bot_")],
        "reply_to": _clean_id(item.get("reply_to")),
        "kind": kind,
        "status": status,
        "task_id": _text(item.get("task_id"), 60),
        "meta": {str(key)[:40]: value for key, value in list(meta.items())[:20]},
    }


def normalize_capability_registry(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    external = item.get("external") if isinstance(item.get("external"), dict) else {}
    return {
        "version": 1,
        "packs": deepcopy(CAPABILITY_PACKS),
        "external": {
            "mcp": _clean_str_list(external.get("mcp"), 60, 80),
            "skills": _clean_str_list(external.get("skills"), 200, 80),
        },
        "updated_at": _clean_int(item.get("updated_at"), 0, 10 ** 15, now_ms()),
    }


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


class TeamStore:
    """Bot / 群 / 会话 / 能力注册表的统一存储。

    一个 ``RLock`` 覆盖全部写路径：团队规模很小（Bot ≤50、群 ≤30），
    用单锁换取"读-改-写"绝不会交错，比按域分锁更不容易出错。
    """

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain" / "team"
        self.bots_file = self.root / "bots.json"
        self.groups_file = self.root / "groups.json"
        self.capabilities_file = self.root / "capabilities.json"
        self.settings_file = self.root / "settings.json"
        self.chats_root = self.root / "chats"
        self.memory_root = self.root / "memory"
        self.lock = threading.RLock()

    # -- 基础设施 ---------------------------------------------------------

    def _atomic_write(self, path: Path, payload: Dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _read_state(self, path: Path, key: str, label: str, normalizer) -> Dict[str, Any]:
        if not path.exists():
            return {"version": 1, "updated_at": 0, key: []}
        try:
            with path.open("r", encoding="utf-8-sig") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", f"{label}暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get(key), list):
            raise DesignBrainError("state_unavailable", f"{label}内容无效，请检查本地数据文件", 503)
        state[key] = [normalizer(item) for item in state[key]]
        return state

    # -- Bot -------------------------------------------------------------

    def _read_bots_unlocked(self) -> Dict[str, Any]:
        state = self._read_state(self.bots_file, "bots", "Bot 团队", normalize_bot)
        state["bots"] = state["bots"][:BOT_LIST_MAX]
        return state

    def list_bots(self, include_archived: bool = False) -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_bots_unlocked()
        bots = state["bots"]
        if not include_archived:
            bots = [bot for bot in bots if bot["status"] == "active"]
        return deepcopy(bots)

    def get_bot(self, bot_id: str) -> Dict[str, Any]:
        wanted = _clean_id(bot_id)
        with self.lock:
            state = self._read_bots_unlocked()
        bot = next((item for item in state["bots"] if item["id"] == wanted), None)
        if not bot:
            raise DesignBrainError("bot_not_found", "该 Bot 不存在", 404)
        return deepcopy(bot)

    def main_bot(self) -> Optional[Dict[str, Any]]:
        for bot in self.list_bots():
            if bot["is_main"]:
                return bot
        return None

    def create_bot(self, payload: Any) -> Dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        with self.lock:
            state = self._read_bots_unlocked()
            if len(state["bots"]) >= BOT_LIST_MAX:
                raise DesignBrainError("bot_limit", f"Bot 数量已达上限（{BOT_LIST_MAX}）", 409)
            name = _text(data.get("name"), BOT_NAME_MAX)
            if not name:
                raise DesignBrainError("invalid_bot", "Bot 名称不能为空", 422)
            if any(bot["name"] == name and bot["status"] == "active" for bot in state["bots"]):
                raise DesignBrainError("bot_name_duplicate", "已有同名 Bot", 409)
            capabilities = [value for value in _clean_str_list(data.get("capabilities"), BOT_CAPABILITIES_MAX, 40)
                            if value in CAPABILITY_IDS]
            bot = normalize_bot({
                **data,
                "id": _clean_id(data.get("id")) or _new_id("bot"),
                "name": name,
                "capabilities": capabilities or ["pack.read", "pack.memory"],
                "is_main": False,
                "status": "active",
                "created_at": now_ms(),
                "updated_at": now_ms(),
            })
            if any(item["id"] == bot["id"] for item in state["bots"]):
                raise DesignBrainError("invalid_bot", "Bot 编号重复，请重试", 409)
            state["bots"] = state["bots"] + [bot]
            self._atomic_write(self.bots_file, state)
        return deepcopy(bot)

    def update_bot(self, bot_id: str, patch: Any) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        editable = {"name", "role", "instructions", "avatar", "model", "vision_model",
                    "image_model", "capabilities", "permission", "status"}
        with self.lock:
            state = self._read_bots_unlocked()
            bot = next((item for item in state["bots"] if item["id"] == _clean_id(bot_id)), None)
            if not bot:
                raise DesignBrainError("bot_not_found", "该 Bot 不存在", 404)
            merged = {**bot}
            for key in editable:
                if key in data:
                    merged[key] = data[key]
            if "name" in data:
                name = _text(data.get("name"), BOT_NAME_MAX)
                if not name:
                    raise DesignBrainError("invalid_bot", "Bot 名称不能为空", 422)
                if any(item["id"] != bot["id"] and item["name"] == name and item["status"] == "active"
                       for item in state["bots"]):
                    raise DesignBrainError("bot_name_duplicate", "已有同名 Bot", 409)
                merged["name"] = name
            if "capabilities" in data:
                merged["capabilities"] = [value for value in _clean_str_list(data.get("capabilities"),
                                                                           BOT_CAPABILITIES_MAX, 40)
                                          if value in CAPABILITY_IDS]
            if merged.get("status") == "archived" and bot["is_main"]:
                raise DesignBrainError("invalid_bot", "主 Bot 不能归档", 409)
            if merged.get("status") == "archived" and bot["status"] != "archived":
                groups = self._read_groups_unlocked()["groups"]
                used = [group["name"] for group in groups
                        if not group["archived"]
                        and (group["admin_bot_id"] == bot["id"] or bot["id"] in group["members"])]
                if used:
                    raise DesignBrainError("bot_in_use", f"该 Bot 仍在群「{used[0]}」中，请先移出", 409)
            merged["id"] = bot["id"]
            merged["is_main"] = bot["is_main"]
            merged["created_at"] = bot["created_at"]
            merged["updated_at"] = now_ms()
            updated = normalize_bot(merged)
            state["bots"] = [updated if item["id"] == bot["id"] else item for item in state["bots"]]
            self._atomic_write(self.bots_file, state)
        return deepcopy(updated)

    def archive_bot(self, bot_id: str) -> Dict[str, Any]:
        wanted = _clean_id(bot_id)
        with self.lock:
            state = self._read_bots_unlocked()
            bot = next((item for item in state["bots"] if item["id"] == wanted), None)
            if not bot:
                raise DesignBrainError("bot_not_found", "该 Bot 不存在", 404)
            if bot["is_main"]:
                raise DesignBrainError("invalid_bot", "主 Bot 不能归档", 409)
            groups = self._read_groups_unlocked()["groups"]
            used = [group["name"] for group in groups
                    if not group["archived"] and (group["admin_bot_id"] == wanted or wanted in group["members"])]
            if used:
                raise DesignBrainError("bot_in_use", f"该 Bot 仍在群「{used[0]}」中，请先移出", 409)
            bot["status"] = "archived"
            bot["updated_at"] = now_ms()
            state["bots"] = [bot if item["id"] == wanted else item for item in state["bots"]]
            self._atomic_write(self.bots_file, state)
        return deepcopy(bot)

    def restore_bot(self, bot_id: str) -> Dict[str, Any]:
        return self.update_bot(bot_id, {"status": "active"})

    # -- 群 --------------------------------------------------------------

    def _read_groups_unlocked(self) -> Dict[str, Any]:
        state = self._read_state(self.groups_file, "groups", "Bot 群", normalize_group)
        state["groups"] = state["groups"][:GROUP_LIST_MAX]
        return state

    def list_groups(self, include_archived: bool = False) -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_groups_unlocked()
        groups = state["groups"]
        if not include_archived:
            groups = [group for group in groups if not group["archived"]]
        return deepcopy(groups)

    def get_group(self, group_id: str) -> Dict[str, Any]:
        wanted = _clean_id(group_id)
        with self.lock:
            state = self._read_groups_unlocked()
        group = next((item for item in state["groups"] if item["id"] == wanted), None)
        if not group:
            raise DesignBrainError("group_not_found", "该群不存在", 404)
        return deepcopy(group)

    def create_group(self, payload: Any) -> Dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        with self.lock:
            state = self._read_groups_unlocked()
            bots = {bot["id"]: bot for bot in self._read_bots_unlocked()["bots"] if bot["status"] == "active"}
            if len(state["groups"]) >= GROUP_LIST_MAX:
                raise DesignBrainError("group_limit", f"群数量已达上限（{GROUP_LIST_MAX}）", 409)
            name = _text(data.get("name"), GROUP_NAME_MAX)
            if not name:
                raise DesignBrainError("invalid_group", "群名称不能为空", 422)
            if any(group["name"] == name and not group["archived"] for group in state["groups"]):
                raise DesignBrainError("group_name_duplicate", "已有同名群", 409)
            main = next((bot for bot in bots.values() if bot["is_main"]), None)
            admin = _clean_id(data.get("admin_bot_id")) or (main["id"] if main else "")
            if admin and admin not in bots:
                raise DesignBrainError("invalid_group", "群管理员必须是启用中的 Bot", 422)
            members = [value for value in _clean_str_list(data.get("members"), GROUP_MEMBERS_MAX, 48)
                       if value in bots]
            if admin and admin not in members:
                members.insert(0, admin)
            if not members:
                members = [admin] if admin else []
            group = normalize_group({
                **data,
                "id": _clean_id(data.get("id")) or _new_id("grp"),
                "name": name,
                "admin_bot_id": admin,
                "members": members,
                "archived": False,
                "created_at": now_ms(),
                "updated_at": now_ms(),
            })
            if any(item["id"] == group["id"] for item in state["groups"]):
                raise DesignBrainError("invalid_group", "群编号重复，请重试", 409)
            state["groups"] = state["groups"] + [group]
            self._atomic_write(self.groups_file, state)
            chat = self._ensure_group_chat_unlocked(group, bots)
        return {"group": deepcopy(group), "chat": chat}

    def update_group(self, group_id: str, patch: Any) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        editable = {"name", "notice", "admin_bot_id", "members", "reply_mode", "relay_limit", "project"}
        with self.lock:
            state = self._read_groups_unlocked()
            group = next((item for item in state["groups"] if item["id"] == _clean_id(group_id)), None)
            if not group:
                raise DesignBrainError("group_not_found", "该群不存在", 404)
            bots = {bot["id"]: bot for bot in self._read_bots_unlocked()["bots"] if bot["status"] == "active"}
            merged = {**group}
            for key in editable:
                if key in data:
                    merged[key] = data[key]
            if "name" in data:
                name = _text(data.get("name"), GROUP_NAME_MAX)
                if not name:
                    raise DesignBrainError("invalid_group", "群名称不能为空", 422)
                if any(item["id"] != group["id"] and item["name"] == name and not item["archived"]
                       for item in state["groups"]):
                    raise DesignBrainError("group_name_duplicate", "已有同名群", 409)
                merged["name"] = name
            if "members" in data:
                merged["members"] = [value for value in _clean_str_list(data.get("members"), GROUP_MEMBERS_MAX, 48)
                                     if value in bots]
            if "admin_bot_id" in data:
                admin = _clean_id(data.get("admin_bot_id"))
                if admin and admin not in bots:
                    raise DesignBrainError("invalid_group", "群管理员必须是启用中的 Bot", 422)
                merged["admin_bot_id"] = admin
                if admin and admin not in (merged.get("members") or []):
                    merged["members"] = [admin] + list(merged.get("members") or [])
            if not (merged.get("members") or []):
                raise DesignBrainError("invalid_group", "群至少需要一个成员", 422)
            merged["id"] = group["id"]
            merged["archived"] = group["archived"]
            merged["created_at"] = group["created_at"]
            merged["updated_at"] = now_ms()
            updated = normalize_group(merged)
            state["groups"] = [updated if item["id"] == group["id"] else item for item in state["groups"]]
            self._atomic_write(self.groups_file, state)
            chat = self._ensure_group_chat_unlocked(updated, bots)
        return {"group": deepcopy(updated), "chat": chat}

    def archive_group(self, group_id: str) -> Dict[str, Any]:
        wanted = _clean_id(group_id)
        with self.lock:
            state = self._read_groups_unlocked()
            group = next((item for item in state["groups"] if item["id"] == wanted), None)
            if not group:
                raise DesignBrainError("group_not_found", "该群不存在", 404)
            group["archived"] = True
            group["updated_at"] = now_ms()
            state["groups"] = [group if item["id"] == wanted else item for item in state["groups"]]
            self._atomic_write(self.groups_file, state)
        return deepcopy(group)

    # -- 会话 ------------------------------------------------------------

    def _chat_dir(self, chat_id: str) -> Path:
        safe = _clean_id(chat_id)
        if not safe:
            raise DesignBrainError("chat_not_found", "会话编号无效", 404)
        return self.chats_root / safe

    def _read_chat_unlocked(self, chat_id: str) -> Dict[str, Any]:
        path = self._chat_dir(chat_id) / "chat.json"
        if not path.exists():
            raise DesignBrainError("chat_not_found", "该会话不存在", 404)
        try:
            with path.open("r", encoding="utf-8-sig") as stream:
                raw = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "会话记录暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(raw, dict):
            raise DesignBrainError("state_unavailable", "会话记录内容无效，请检查本地数据文件", 503)
        return normalize_chat(raw, fallback_id=chat_id)

    def _write_chat_unlocked(self, chat: Dict[str, Any]) -> None:
        chat["updated_at"] = now_ms()
        self._atomic_write(self._chat_dir(chat["id"]) / "chat.json", chat)

    def _ensure_group_chat_unlocked(self, group: Dict[str, Any], bots: Dict[str, Any]) -> Dict[str, Any]:
        chat_id = group["id"]
        try:
            chat = self._read_chat_unlocked(chat_id)
        except DesignBrainError:
            chat = normalize_chat({
                "id": chat_id, "kind": "group", "title": group["name"],
                "group_id": chat_id, "members": group["members"],
                "created_at": now_ms(), "updated_at": now_ms(),
            })
        chat["title"] = group["name"]
        chat["members"] = list(group["members"])
        chat["group_id"] = chat_id
        self._write_chat_unlocked(chat)
        return deepcopy(chat)

    def ensure_dm_chat(self, bot_id: str) -> Dict[str, Any]:
        bot = self.get_bot(bot_id)
        chat_id = f"dm_{bot['id']}"
        with self.lock:
            try:
                chat = self._read_chat_unlocked(chat_id)
            except DesignBrainError:
                chat = normalize_chat({
                    "id": chat_id, "kind": "dm", "title": bot["name"],
                    "bot_id": bot["id"], "members": [bot["id"]],
                    "created_at": now_ms(), "updated_at": now_ms(),
                })
            chat["title"] = bot["name"]
            self._write_chat_unlocked(chat)
        return deepcopy(chat)

    def list_chats(self) -> List[Dict[str, Any]]:
        if not self.chats_root.exists():
            return []
        chats: List[Dict[str, Any]] = []
        for entry in sorted(self.chats_root.iterdir()):
            if not entry.is_dir():
                continue
            try:
                chats.append(self._read_chat_unlocked(entry.name))
            except DesignBrainError:
                continue
        chats.sort(key=lambda item: (item["last_message_at"], item["updated_at"]), reverse=True)
        return chats[:CHAT_LIST_MAX]

    def get_chat(self, chat_id: str) -> Dict[str, Any]:
        with self.lock:
            return deepcopy(self._read_chat_unlocked(chat_id))

    # -- 消息 ------------------------------------------------------------

    def _messages_file(self, chat_id: str) -> Path:
        return self._chat_dir(chat_id) / "messages.jsonl"

    def _read_messages_unlocked(self, chat_id: str) -> List[Dict[str, Any]]:
        path = self._messages_file(chat_id)
        if not path.exists():
            return []
        messages: List[Dict[str, Any]] = []
        try:
            with path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(raw, dict):
                        messages.append(normalize_message(raw, chat_id=chat_id,
                                                          fallback_seq=len(messages) + 1))
        except OSError as exc:
            raise DesignBrainError("state_unavailable", "会话消息暂时无法读取，请检查本地数据文件", 503) from exc
        return messages

    def list_messages(self, chat_id: str, after: int = 0, limit: int = MESSAGE_LIMIT_DEFAULT) -> Dict[str, Any]:
        safe_limit = max(1, min(MESSAGE_LIMIT_MAX, int(limit or MESSAGE_LIMIT_DEFAULT)))
        with self.lock:
            chat = self._read_chat_unlocked(chat_id)
            messages = self._read_messages_unlocked(chat_id)
        cursor = max(0, int(after or 0))
        pending = [item for item in messages if item["seq"] > cursor]
        selected = pending[:safe_limit]
        return {
            "chat": deepcopy(chat),
            "messages": deepcopy(selected),
            "cursor": selected[-1]["seq"] if selected else cursor,
            "has_more": len(pending) > len(selected),
        }

    def linked_task_ids(self, chat_id: str) -> set:
        with self.lock:
            return {message["task_id"] for message in self._read_messages_unlocked(chat_id)
                    if message.get("task_id")}

    def append_message(self, chat_id: str, *, role: str, text: str = "", bot_id: str = "",
                       mentions: Optional[Iterable[str]] = None, kind: str = "text",
                       status: str = "sent", reply_to: str = "", task_id: str = "",
                       meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        with self.lock:
            chat = self._read_chat_unlocked(chat_id)
            if chat["seq"] >= MESSAGE_FILE_MAX:
                self._rotate_messages_unlocked(chat)
            chat["seq"] += 1
            message = normalize_message({
                "id": _new_id("msg"),
                "seq": chat["seq"],
                "chat_id": chat_id,
                "role": role,
                "bot_id": bot_id,
                "text": text,
                "at": now_ms(),
                "mentions": list(mentions or []),
                "reply_to": reply_to,
                "kind": kind,
                "status": status,
                "task_id": task_id,
                "meta": meta or {},
            }, chat_id=chat_id, fallback_seq=chat["seq"])
            path = self._messages_file(chat_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(message, ensure_ascii=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            chat["last_message_at"] = message["at"]
            self._write_chat_unlocked(chat)
        return deepcopy(message)

    def _rotate_messages_unlocked(self, chat: Dict[str, Any]) -> None:
        """把已满的消息文件滚存到 archive/，序号继续递增，不丢历史。"""
        path = self._messages_file(chat["id"])
        if not path.exists():
            return
        archive_dir = self._chat_dir(chat["id"]) / "archive"
        archive_dir.mkdir(parents=True, exist_ok=True)
        target = archive_dir / f"messages-{now_ms()}.jsonl"
        try:
            os.replace(path, target)
        except OSError as exc:
            raise DesignBrainError("state_unavailable", "会话消息归档失败，请检查磁盘空间", 503) from exc

    def update_chat(self, chat_id: str, patch: Any) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        editable = {"paused", "relay_count", "title", "defaults"}
        with self.lock:
            chat = self._read_chat_unlocked(chat_id)
            for key in editable:
                if key in data:
                    chat[key] = data[key]
            chat = normalize_chat(chat, fallback_id=chat_id)
            self._write_chat_unlocked(chat)
        return deepcopy(chat)

    def clear_messages(self, chat_id: str) -> None:
        with self.lock:
            path = self._messages_file(chat_id)
            if path.exists():
                path.unlink()
            chat = self._read_chat_unlocked(chat_id)
            chat["seq"] = 0
            chat["last_message_at"] = 0
            self._write_chat_unlocked(chat)

    # -- 审批 ------------------------------------------------------------

    def add_approval(self, chat_id: str, *, tool: str, args: Dict[str, Any],
                     bot_id: str, summary: str = "") -> Dict[str, Any]:
        with self.lock:
            chat = self._read_chat_unlocked(chat_id)
            approvals = dict(chat.get("approvals") or {})
            pending = [item for item in approvals.values() if item["status"] == "pending"]
            if len(pending) >= 5:
                raise DesignBrainError("approval_limit", "待审批的动作太多，请先处理已有的", 409)
            approval = {
                "id": _new_id("ap"),
                "tool": _text(tool, 60),
                "bot_id": _clean_id(bot_id),
                "args": args if isinstance(args, dict) else {},
                "summary": _text(summary, 300),
                "status": "pending",
                "created_at": now_ms(),
                "resolved_at": 0,
            }
            approvals[approval["id"]] = approval
            chat["approvals"] = approvals
            self._write_chat_unlocked(chat)
        return deepcopy(approval)

    def resolve_approval(self, chat_id: str, approval_id: str, status: str) -> Dict[str, Any]:
        if status not in ("approved", "rejected"):
            raise DesignBrainError("invalid_approval", "审批状态无效", 422)
        wanted = _clean_id(approval_id)
        with self.lock:
            chat = self._read_chat_unlocked(chat_id)
            approvals = dict(chat.get("approvals") or {})
            approval = approvals.get(wanted)
            if not approval:
                raise DesignBrainError("approval_not_found", "该审批不存在", 404)
            if approval["status"] != "pending":
                raise DesignBrainError("approval_resolved", "该审批已处理", 409)
            approval["status"] = status
            approval["resolved_at"] = now_ms()
            approvals[wanted] = approval
            chat["approvals"] = approvals
            self._write_chat_unlocked(chat)
        return deepcopy(approval)

    def pending_approvals(self, chat_id: str) -> List[Dict[str, Any]]:
        chat = self.get_chat(chat_id)
        return [item for item in (chat.get("approvals") or {}).values()
                if item["status"] == "pending"]

    # -- 能力 ------------------------------------------------------------

    def capabilities(self) -> Dict[str, Any]:
        with self.lock:
            if self.capabilities_file.exists():
                try:
                    with self.capabilities_file.open("r", encoding="utf-8-sig") as stream:
                        raw = json.load(stream)
                except (OSError, ValueError) as exc:
                    raise DesignBrainError("state_unavailable", "能力注册表暂时无法读取，请检查本地数据文件", 503) from exc
                return normalize_capability_registry(raw)
            registry = normalize_capability_registry({})
            self._atomic_write(self.capabilities_file, registry)
        return registry

    # -- 团队设置 --------------------------------------------------------

    def settings(self) -> Dict[str, Any]:
        with self.lock:
            if not self.settings_file.exists():
                state = {"version": 1, "memory_review": True, "daily_llm_limit": 300,
                         "approval_image_threshold": 4, "updated_at": now_ms()}
                self._atomic_write(self.settings_file, state)
                return deepcopy(state)
            try:
                with self.settings_file.open("r", encoding="utf-8-sig") as stream:
                    raw = json.load(stream)
            except (OSError, ValueError) as exc:
                raise DesignBrainError("state_unavailable", "团队设置暂时无法读取", 503) from exc
            if not isinstance(raw, dict):
                raise DesignBrainError("state_unavailable", "团队设置内容无效", 503)
        return {
            "version": 1,
            "memory_review": _clean_bool(raw.get("memory_review"), True),
            "daily_llm_limit": _clean_int(raw.get("daily_llm_limit"), 0, 100000, 300),
            "approval_image_threshold": _clean_int(raw.get("approval_image_threshold"), 0, 1000, 4),
            "updated_at": _clean_int(raw.get("updated_at"), 0, 10 ** 15, now_ms()),
        }

    def update_settings(self, patch: Any) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        state = self.settings()
        if "memory_review" in data:
            state["memory_review"] = _clean_bool(data.get("memory_review"), True)
        if "daily_llm_limit" in data:
            state["daily_llm_limit"] = _clean_int(data.get("daily_llm_limit"), 0, 100000, 300)
        if "approval_image_threshold" in data:
            state["approval_image_threshold"] = _clean_int(data.get("approval_image_threshold"), 0, 1000, 4)
        state["updated_at"] = now_ms()
        with self.lock:
            self._atomic_write(self.settings_file, state)
        return deepcopy(state)

    # -- 首次 seed -------------------------------------------------------

    def ensure_seeded(self, instructions: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """首次启动写入默认团队；已存在则完全不动（幂等）。

        返回 ``{"seeded": bool, "bots": n, "groups": n}``，方便启动日志与测试断言。

        instructions 显式传入时覆盖默认职责说明。流水线的阶段 prompt
        使用另一套输出协议，不写入团队成员说明。
        """
        with self.lock:
            existing = self._read_state(self.bots_file, "bots", "Bot 团队", normalize_bot)
            if existing["bots"]:
                return {"seeded": False, "bots": len(existing["bots"]), "groups": 0}
            prompts = dict(FALLBACK_INSTRUCTIONS)
            if instructions:
                prompts.update({key: value for key, value in instructions.items() if value})
            bots: List[Dict[str, Any]] = []
            for seed in DEFAULT_BOT_SEEDS:
                bots.append(normalize_bot({
                    **seed,
                    "instructions": prompts.get(seed["id"], ""),
                    "model": {},
                    "vision_model": {},
                    "image_model": {},
                    "permission": "full" if seed.get("is_main") else "workspace",
                    "status": "active",
                    "created_at": now_ms(),
                    "updated_at": now_ms(),
                }))
            self._atomic_write(self.bots_file, {"version": 1, "updated_at": now_ms(), "bots": bots})

            groups = self._read_state(self.groups_file, "groups", "Bot 群", normalize_group)
            if not groups["groups"]:
                group = normalize_group({**DEFAULT_GROUP_SEED, "archived": False,
                                         "created_at": now_ms(), "updated_at": now_ms()})
                self._atomic_write(self.groups_file, {"version": 1, "updated_at": now_ms(), "groups": [group]})
                bot_index = {bot["id"]: bot for bot in bots}
                self._ensure_group_chat_unlocked(group, bot_index)
            for bot in bots:
                self.ensure_dm_chat(bot["id"])
            self.memory_root.mkdir(parents=True, exist_ok=True)
        return {"seeded": True, "bots": len(bots), "groups": 1}

    # -- 汇总 ------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        bots = self.list_bots()
        groups = self.list_groups()
        return {
            "bots": bots,
            "groups": groups,
            "chats": self.list_chats(),
            "capabilities": self.capabilities(),
            "limits": {
                "bots": BOT_LIST_MAX,
                "groups": GROUP_LIST_MAX,
                "group_members": GROUP_MEMBERS_MAX,
                "message_text": MESSAGE_TEXT_MAX,
                "instructions": BOT_INSTRUCTIONS_MAX,
                "notice": GROUP_NOTICE_MAX,
            },
        }


_, _ROOT = resolve_roots(Path(__file__).resolve().parent)
DATA_ROOT = _ROOT / "data"
TEAM = TeamStore(DATA_ROOT)
