"""小美 Bot 工作区 SQLite 持久化层（纯标准库）。

数据库位置：``data/bot_workspace/workspace.sqlite3``

设计原则：
1. 新安装只创建唯一默认总管理 Bot，稳定 ID 为 ``bot_manager``（数据库部分唯一索引强制全局至多一个总管理）。
2. 所有消息先落库再入队；使用 ``idempotency_key`` 防止重复提交。
3. 严格禁止将 API Key、Bearer Token 或敏感凭据写入 Bot 配置、记忆或聊天参数中。
4. 区分永久 Bot（``bots`` 表）与临时子 Agent（留存于 ``data/multi_agent/runs.sqlite3``，不自动入 ``bots`` 表）。
5. 跨库联动通过 ``run_links`` 与幂等键打通 ``workspace.sqlite3`` 与 ``data/multi_agent/runs.sqlite3``。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from bot_workspace_config import MANAGER_BOT_ID, bot_workspace_db_path

SCHEMA_VERSION = 1

BOT_LIST_MAX = 80
BOT_NAME_MAX = 48
BOT_ROLE_MAX = 200
BOT_INSTRUCTIONS_MAX = 12000
BOT_PERSONALITY_MAX = 2000
SESSION_TITLE_MAX = 80
MESSAGE_TEXT_MAX = 16000
MEMORY_TEXT_MAX = 400
MEMORY_PER_BOT_MAX = 200
AVATAR_IMAGE_MAX_BYTES = 256 * 1024

AVATAR_SHAPES = (
    "star", "bunny", "moon", "gumdrop", "kitty", "acorn", "peanut",
    "whale", "wave", "squircle", "zed", "hex", "saucer", "beacon",
    "plus", "magnet", "pebbles", "cushion", "ring", "gem",
)

BOT_STATUSES = ("active", "archived")
SESSION_KINDS = ("chat", "task_thread", "legacy_group")
MESSAGE_ROLES = ("user", "bot", "system", "tool", "delegation")
MESSAGE_KINDS = ("text", "task_card", "approval", "result", "activity", "error", "design_plan")
TURN_STATUSES = (
    "queued",
    "running",
    "waiting_delegation",
    "waiting_approval",
    "waiting_canvas_connection",
    "waiting_result",
    "completed",
    "failed",
    "cancelled",
    "recovery_required",
)
TURN_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
DELEGATION_STATUSES = ("queued", "running", "completed", "failed", "cancelled")
APPROVAL_STATUSES = ("pending", "approved", "rejected", "cancelled", "expired")
MEMORY_SCOPES = ("bot", "project", "shared")

BOT_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{2,63}$")
SAFE_SCOPE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{0,80}$")

# ---------------------------------------------------------------------------
# 工具权限与安全边界
# ---------------------------------------------------------------------------

BOT_MANAGEMENT_TOOLS = (
    "bot.list",
    "bot.create",
    "bot.read",
    "bot.update",
    "bot.archive",
    "bot.restore",
    "bot.delegate",
    "bot.get_result",
    "bot.cancel_task",
)
MANAGER_ONLY_TOOLS = frozenset({"bot.create", "bot.update", "bot.archive", "bot.restore"})
MEMORY_TOOLS = ("memory.read", "memory.remember", "memory.forget", "memory.recall")
CANVAS_READ_TOOLS = (
    "canvas.read",
    "canvas.list_assets",
    "canvas.query_generation",
    "canvas.inspect_result",
    "canvas.check_product",
    "canvas.check_geometry",
)
CANVAS_WRITE_TOOLS = (
    "canvas.dispatch_run",
    "canvas.command",
    "canvas.use_project_asset",
)
DESIGN_TOOLS = (
    "design.profile.read",
    "design.references.search",
    "design.references.analyze",
    "design.plan.compose",
    "design.review.check",
    "design.batch.canvas_plan",
)
FORBIDDEN_TOOLS = frozenset({
    "shell", "shell.exec", "system.shell", "os.system", "subprocess",
    "bash", "powershell", "cmd", "exec", "eval",
})

ALL_REGISTERED_TOOLS = frozenset(
    (*BOT_MANAGEMENT_TOOLS, *MEMORY_TOOLS, *CANVAS_READ_TOOLS, *CANVAS_WRITE_TOOLS, *DESIGN_TOOLS)
)
SPECIALIST_MAX_TOOLS = frozenset(ALL_REGISTERED_TOOLS - MANAGER_ONLY_TOOLS)

MANAGER_DEFAULT_TOOLS = sorted(ALL_REGISTERED_TOOLS)
SPECIALIST_DEFAULT_TOOLS = [
    "bot.list",
    "bot.read",
    "memory.read",
    "memory.remember",
    "memory.recall",
    "canvas.read",
    "canvas.list_assets",
]

MANAGER_DEFAULT_INSTRUCTIONS = (
    "你是小美画布的唯一默认「总管理 Bot」（bot_manager）。\n"
    "你的核心职责：\n"
    "1. 作为用户的主入口，直接响应日常咨询、画布分析与任务统筹。\n"
    "2. 当用户用自然语言要求新建、修改、归档或恢复专业 Bot 时，通过 bot.create / bot.update / bot.archive / bot.restore 工具管理持久 Bot 档案。\n"
    "3. 当任务适合交给某个已有持久专业 Bot 时，通过 bot.delegate 委派并在权限边界内跟进结果；临时一次性的画布子任务由画布多 Agent 执行引擎派生临时子 Agent，不自动创建永久 Bot。\n"
    "4. 任何涉及画布修改或付费生图的操作必须经过现有画布协议与审批/预算规则，绝不跳过确认或伪造执行结果。\n"
    "5. 严禁存储、索取或输出 API Key 与敏感凭据，也严禁尝试执行任意系统 Shell 命令。"
)

# ---------------------------------------------------------------------------
# 敏感信息检测（禁止 API Key / Token 进入 SQLite 配置、记忆或日志）
# ---------------------------------------------------------------------------

_SECRET_VALUE_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bsk-proj-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z\-_]{25,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{16,}", re.IGNORECASE),
    re.compile(r"(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|authorization)\s*[:=]\s*['\"]?[A-Za-z0-9._\-/+=]{8,}", re.IGNORECASE),
    re.compile(r"-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----", re.IGNORECASE),
)
_SECRET_KEY_NAMES = frozenset({
    "api_key", "apikey", "secret", "secret_key", "access_token",
    "refresh_token", "auth_token", "authorization", "password", "passwd", "private_key",
})


class BotWorkspaceError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def load_json(raw: Any, fallback: Any) -> Any:
    if not raw:
        return deepcopy(fallback)
    try:
        parsed = json.loads(raw)
        return parsed if parsed is not None else deepcopy(fallback)
    except (ValueError, TypeError):
        return deepcopy(fallback)


def sha256_json(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def contains_secret_text(text: Any) -> bool:
    sample = str(text or "")
    if not sample:
        return False
    return any(pattern.search(sample) for pattern in _SECRET_VALUE_PATTERNS)


def assert_no_secrets(value: Any, *, field_label: str = "内容") -> None:
    if isinstance(value, str):
        if contains_secret_text(value):
            raise BotWorkspaceError("secret_rejected", f"{field_label}包含疑似 API Key 或敏感令牌，已拒绝保存", 422)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            lowered = str(key or "").strip().lower()
            if lowered in _SECRET_KEY_NAMES and str(item or "").strip():
                raise BotWorkspaceError("secret_rejected", f"禁止在 Bot 配置或记录中保存敏感字段「{key}」", 422)
            assert_no_secrets(item, field_label=field_label)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            assert_no_secrets(item, field_label=field_label)


def _clean_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _clean_scope_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if not SAFE_SCOPE_ID_RE.fullmatch(text):
        raise BotWorkspaceError("invalid_scope", "项目或画布编号格式无效", 422)
    return text


def normalize_model_ref(raw: Any) -> Dict[str, str]:
    item = raw if isinstance(raw, dict) else {}
    assert_no_secrets(item, field_label="模型配置")
    provider = _clean_text(item.get("provider_id") or item.get("provider"), 100)
    model = _clean_text(item.get("model"), 200)
    return {"provider_id": provider, "model": model}


def normalize_avatar(raw: Any, *, fallback_text: str = "小", fallback_color: str = "#2F6F5E", fallback_shape: str = "star") -> Dict[str, str]:
    item = raw if isinstance(raw, dict) else {}
    text = _clean_text(item.get("text"), 2) or fallback_text
    color = _clean_text(item.get("color"), 20)
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
        color = fallback_color
    shape = _clean_text(item.get("shape"), 24).lower()
    if shape not in AVATAR_SHAPES:
        shape = fallback_shape if fallback_shape in AVATAR_SHAPES else "star"
    avatar: Dict[str, str] = {"text": text, "color": color, "shape": shape}
    image = item.get("image") or ""
    if image:
        message = "头像需为 PNG、JPEG 或 WebP 图片，大小不超过 256 KB，尺寸不超过 1024×1024"
        if not isinstance(image, str) or len(image) > AVATAR_IMAGE_MAX_BYTES * 4 // 3 + 64:
            raise BotWorkspaceError("invalid_avatar", message, 422)
        match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", image)
        if not match:
            raise BotWorkspaceError("invalid_avatar", message, 422)
        from PIL import Image
        try:
            content = base64.b64decode(match.group(2), validate=True)
            if len(content) > AVATAR_IMAGE_MAX_BYTES:
                raise ValueError("too large")
            with Image.open(io.BytesIO(content)) as picture:
                expected_fmt = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[match.group(1)]
                if picture.format != expected_fmt:
                    raise ValueError("format mismatch")
                if max(picture.size) > 1024:
                    raise ValueError("dimensions too large")
                picture.verify()
        except (ValueError, OSError, SyntaxError, binascii.Error, Image.DecompressionBombError) as exc:
            raise BotWorkspaceError("invalid_avatar", message, 422) from exc
        avatar["image"] = image
    return avatar


def sanitize_tool_permissions(
    tools: Iterable[Any],
    *,
    is_manager: bool = False,
    allowed_ceiling: Optional[Iterable[str]] = None,
    strict: bool = False,
) -> List[str]:
    ceiling = set(ALL_REGISTERED_TOOLS if is_manager else SPECIALIST_MAX_TOOLS)
    if allowed_ceiling is not None:
        ceiling &= set(allowed_ceiling)
    cleaned: List[str] = []
    for raw in tools or []:
        name = str(raw or "").strip()
        if not name:
            continue
        if name in FORBIDDEN_TOOLS or name.startswith(("shell.", "system.", "exec.")):
            if strict:
                raise BotWorkspaceError("forbidden_tool", f"禁止授予系统命令工具权限：{name}", 403)
            continue
        if name not in ALL_REGISTERED_TOOLS:
            if strict:
                raise BotWorkspaceError("unknown_tool", f"工具未登记：{name}", 422)
            continue
        if not is_manager and name in MANAGER_ONLY_TOOLS:
            if strict:
                raise BotWorkspaceError("permission_escalation", f"普通 Bot 不允许拥有总管理权限：{name}", 403)
            continue
        if name not in ceiling:
            if strict:
                raise BotWorkspaceError("permission_escalation", f"工具权限超出授权上限：{name}", 403)
            continue
        if name not in cleaned:
            cleaned.append(name)
    return cleaned


def normalize_delegation_policy(raw: Any, *, is_manager: bool = False) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    allow_delegate = bool(item.get("allow_delegate", is_manager))
    allow_subagents = bool(item.get("allow_temp_subagents", is_manager))
    raw_targets = item.get("allowed_target_bot_ids")
    targets = [str(v).strip() for v in (raw_targets if isinstance(raw_targets, list) else []) if str(v).strip()][:50]
    try:
        max_depth = max(0, min(3, int(item.get("max_delegation_depth", 2 if is_manager else 1))))
    except (TypeError, ValueError):
        max_depth = 2 if is_manager else 1
    return {
        "allow_delegate": allow_delegate,
        "allow_temp_subagents": allow_subagents,
        "allowed_target_bot_ids": targets,
        "max_delegation_depth": max_depth,
    }


def normalize_canvas_policy(raw: Any, *, is_manager: bool = False) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    try:
        max_auto_gen = max(0, min(40, int(item.get("authorized_generations", 0))))
    except (TypeError, ValueError):
        max_auto_gen = 0
    return {
        "allow_canvas_read": bool(item.get("allow_canvas_read", True)),
        "allow_canvas_writes": bool(item.get("allow_canvas_writes", is_manager)),
        "require_approval_for_paid": bool(item.get("require_approval_for_paid", True)),
        "allow_local_gpu": bool(item.get("allow_local_gpu", False)),
        "authorized_generations": max_auto_gen,
    }


def normalize_model_params(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    assert_no_secrets(item, field_label="模型参数")
    result: Dict[str, Any] = {}
    if "temperature" in item and item["temperature"] is not None:
        try:
            temp = float(item["temperature"])
            result["temperature"] = round(max(0.0, min(2.0, temp)), 3)
        except (TypeError, ValueError):
            pass
    if "max_output_tokens" in item and item["max_output_tokens"] is not None:
        try:
            result["max_output_tokens"] = max(256, min(16384, int(item["max_output_tokens"])))
        except (TypeError, ValueError):
            pass
    if "auto_match_skills" in item:
        result["auto_match_skills"] = bool(item["auto_match_skills"])
    return result


# ---------------------------------------------------------------------------
# SQLite Schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    backup_path TEXT NOT NULL DEFAULT '',
    summary_json TEXT NOT NULL DEFAULT '{}',
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
    bot_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar_json TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    system_instructions TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    is_manager INTEGER NOT NULL DEFAULT 0 CHECK (is_manager IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    chat_provider_id TEXT NOT NULL DEFAULT '',
    chat_model TEXT NOT NULL DEFAULT '',
    vision_provider_id TEXT NOT NULL DEFAULT '',
    vision_model TEXT NOT NULL DEFAULT '',
    image_provider_id TEXT NOT NULL DEFAULT '',
    image_model TEXT NOT NULL DEFAULT '',
    model_params_json TEXT NOT NULL DEFAULT '{}',
    tool_permissions_json TEXT NOT NULL DEFAULT '[]',
    permission_ceiling_json TEXT NOT NULL DEFAULT '[]',
    delegation_policy_json TEXT NOT NULL DEFAULT '{}',
    canvas_policy_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT 'system',
    legacy_source_id TEXT UNIQUE,
    legacy_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_single_manager
    ON bots(is_manager) WHERE is_manager = 1;
CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status, is_manager DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS bot_skills (
    bot_id TEXT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'pinned' CHECK (mode IN ('pinned', 'auto')),
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, skill_id)
);

CREATE TABLE IF NOT EXISTS bot_memories (
    memory_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'bot' CHECK (scope IN ('bot', 'project', 'shared')),
    project_id TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '用户',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_memories_dedup
    ON bot_memories(bot_id, scope, project_id, content_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bot_memories_lookup
    ON bot_memories(bot_id, scope, project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    title TEXT NOT NULL DEFAULT '新会话',
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'task_thread', 'legacy_group')),
    project_id TEXT NOT NULL DEFAULT '',
    canvas_id TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    seq INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    legacy_chat_id TEXT UNIQUE,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_bot_recent
    ON sessions(bot_id, archived, pinned DESC, last_message_at DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_scope
    ON sessions(project_id, canvas_id);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'bot', 'system', 'tool', 'delegation')),
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    meta_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
    ON messages(session_id, idempotency_key) WHERE idempotency_key != '';
CREATE INDEX IF NOT EXISTS idx_messages_session_seq
    ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    trigger_message_id TEXT NOT NULL DEFAULT '',
    parent_turn_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    canvas_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    request_signature TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    model_snapshot_json TEXT NOT NULL DEFAULT '{}',
    permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
    skill_snapshot_json TEXT NOT NULL DEFAULT '[]',
    steps INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT NOT NULL DEFAULT '',
    result_refs_json TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
    created_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_queue ON turns(status, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_bot_status ON turns(bot_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delegations (
    delegation_id TEXT PRIMARY KEY,
    parent_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    parent_session_id TEXT NOT NULL DEFAULT '',
    parent_turn_id TEXT NOT NULL DEFAULT '',
    target_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    target_session_id TEXT NOT NULL DEFAULT '',
    target_turn_id TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    context_refs_json TEXT NOT NULL DEFAULT '[]',
    granted_permissions_json TEXT NOT NULL DEFAULT '[]',
    idempotency_key TEXT NOT NULL UNIQUE,
    request_signature TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    result_summary TEXT NOT NULL DEFAULT '',
    result_refs_json TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_turn_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_bot_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS run_links (
    link_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',
    multi_agent_run_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL DEFAULT '',
    canvas_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_links_turn ON run_links(turn_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_links_bot ON run_links(bot_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    multi_agent_run_id TEXT NOT NULL DEFAULT '',
    multi_agent_action_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_turn ON approvals(turn_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_action ON approvals(multi_agent_action_id);

CREATE TABLE IF NOT EXISTS workspace_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    bot_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    canvas_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_events_scope ON workspace_events(project_id, canvas_id, seq);
CREATE INDEX IF NOT EXISTS idx_workspace_events_bot ON workspace_events(bot_id, seq);

CREATE TABLE IF NOT EXISTS delivery_outbox (
    outbox_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_bot_id TEXT NOT NULL DEFAULT '',
    target_session_id TEXT NOT NULL DEFAULT '',
    target_turn_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON delivery_outbox(status, next_retry_at, created_at);
"""


# ---------------------------------------------------------------------------
# Store 主体
# ---------------------------------------------------------------------------


class BotWorkspaceStore:
    """线程安全、事务一致的 Bot 工作区 SQLite 存储。"""

    def __init__(self, db_path: str | Path | None = None, *, data_dir: str | Path | None = None):
        if db_path is not None:
            self.path = Path(db_path).resolve()
        else:
            self.path = bot_workspace_db_path(data_dir)
        self.lock = threading.RLock()
        self.local = threading.local()
        self.initialized = False

    @contextmanager
    def transaction(self):
        with self.lock:
            active = getattr(self.local, "db", None)
            if active is not None:
                yield active
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(str(self.path), timeout=15)
            db.row_factory = sqlite3.Row
            try:
                db.execute("PRAGMA foreign_keys=ON")
                if not self.initialized:
                    db.execute("PRAGMA journal_mode=WAL")
                    version = db.execute("PRAGMA user_version").fetchone()[0]
                    if version > SCHEMA_VERSION:
                        raise BotWorkspaceError(
                            "store_version",
                            "Bot 工作区数据库来自更新版本，请升级小美画布后再打开",
                            503,
                        )
                    db.executescript(SCHEMA_SQL)
                    if version < SCHEMA_VERSION:
                        db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                    self.initialized = True
                db.execute("BEGIN IMMEDIATE")
                self.local.db = db
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                self.local.db = None
                db.close()

    # -- 序列化辅助 -------------------------------------------------------

    def _bot_from_row(self, db: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Any]:
        skills = [
            {
                "skill_id": s["skill_id"],
                "mode": s["mode"],
                "priority": s["priority"],
                "enabled": bool(s["enabled"]),
                "created_at": s["created_at"],
            }
            for s in db.execute(
                "SELECT skill_id, mode, priority, enabled, created_at FROM bot_skills "
                "WHERE bot_id=? ORDER BY priority DESC, created_at ASC",
                (row["bot_id"],),
            )
        ]
        active_turn_count = db.execute(
            "SELECT COUNT(*) FROM turns WHERE bot_id=? AND status NOT IN ('completed','failed','cancelled')",
            (row["bot_id"],),
        ).fetchone()[0]
        return {
            "bot_id": row["bot_id"],
            "name": row["name"],
            "avatar": load_json(row["avatar_json"], {"text": "小", "color": "#2F6F5E", "shape": "star"}),
            "role": row["role"],
            "system_instructions": row["system_instructions"],
            "personality": row["personality"],
            "is_manager": bool(row["is_manager"]),
            "status": row["status"],
            "chat_model": {"provider_id": row["chat_provider_id"], "model": row["chat_model"]},
            "vision_model": {"provider_id": row["vision_provider_id"], "model": row["vision_model"]},
            "image_model": {"provider_id": row["image_provider_id"], "model": row["image_model"]},
            "model_params": load_json(row["model_params_json"], {}),
            "tool_permissions": load_json(row["tool_permissions_json"], []),
            "permission_ceiling": load_json(row["permission_ceiling_json"], []),
            "delegation_policy": load_json(row["delegation_policy_json"], {}),
            "canvas_policy": load_json(row["canvas_policy_json"], {}),
            "skills": skills,
            "active_turn_count": int(active_turn_count),
            "created_by": row["created_by"],
            "legacy_source_id": row["legacy_source_id"] or "",
            "legacy_default": bool(row["legacy_default"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "session_id": row["session_id"],
            "bot_id": row["bot_id"],
            "title": row["title"],
            "kind": row["kind"],
            "project_id": row["project_id"],
            "canvas_id": row["canvas_id"],
            "archived": bool(row["archived"]),
            "pinned": bool(row["pinned"]),
            "seq": row["seq"],
            "last_message_at": row["last_message_at"],
            "legacy_chat_id": row["legacy_chat_id"] or "",
            "meta": load_json(row["meta_json"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _message_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "message_id": row["message_id"],
            "session_id": row["session_id"],
            "bot_id": row["bot_id"],
            "seq": row["seq"],
            "role": row["role"],
            "kind": row["kind"],
            "content": row["content"],
            "attachments": load_json(row["attachments_json"], []),
            "meta": load_json(row["meta_json"], {}),
            "idempotency_key": row["idempotency_key"],
            "turn_id": row["turn_id"],
            "delegation_id": row["delegation_id"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _turn_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "turn_id": row["turn_id"],
            "session_id": row["session_id"],
            "bot_id": row["bot_id"],
            "trigger_message_id": row["trigger_message_id"],
            "parent_turn_id": row["parent_turn_id"],
            "delegation_id": row["delegation_id"],
            "project_id": row["project_id"],
            "canvas_id": row["canvas_id"],
            "idempotency_key": row["idempotency_key"],
            "status": row["status"],
            "model_snapshot": load_json(row["model_snapshot_json"], {}),
            "permission_snapshot": load_json(row["permission_snapshot_json"], {}),
            "skill_snapshot": load_json(row["skill_snapshot_json"], []),
            "steps": row["steps"],
            "result_summary": row["result_summary"],
            "result_refs": load_json(row["result_refs_json"], []),
            "error": row["error"],
            "recovery_required": bool(row["recovery_required"]),
            "created_at": row["created_at"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _delegation_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "delegation_id": row["delegation_id"],
            "parent_bot_id": row["parent_bot_id"],
            "parent_session_id": row["parent_session_id"],
            "parent_turn_id": row["parent_turn_id"],
            "target_bot_id": row["target_bot_id"],
            "target_session_id": row["target_session_id"],
            "target_turn_id": row["target_turn_id"],
            "goal": row["goal"],
            "instructions": row["instructions"],
            "context_refs": load_json(row["context_refs_json"], []),
            "granted_permissions": load_json(row["granted_permissions_json"], []),
            "idempotency_key": row["idempotency_key"],
            "status": row["status"],
            "result_summary": row["result_summary"],
            "result_refs": load_json(row["result_refs_json"], []),
            "error": row["error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _approval_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "approval_id": row["approval_id"],
            "bot_id": row["bot_id"],
            "session_id": row["session_id"],
            "turn_id": row["turn_id"],
            "multi_agent_run_id": row["multi_agent_run_id"],
            "multi_agent_action_id": row["multi_agent_action_id"],
            "tool_name": row["tool_name"],
            "args": load_json(row["args_json"], {}),
            "summary": row["summary"],
            "risk_level": row["risk_level"],
            "status": row["status"],
            "created_at": row["created_at"],
            "resolved_at": row["resolved_at"],
        }

    @staticmethod
    def _run_link_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "link_id": row["link_id"],
            "bot_id": row["bot_id"],
            "session_id": row["session_id"],
            "turn_id": row["turn_id"],
            "delegation_id": row["delegation_id"],
            "multi_agent_run_id": row["multi_agent_run_id"],
            "project_id": row["project_id"],
            "canvas_id": row["canvas_id"],
            "idempotency_key": row["idempotency_key"],
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # -- 事件 ------------------------------------------------------------

    def emit_event_tx(
        self,
        db: sqlite3.Connection,
        event_type: str,
        *,
        bot_id: str = "",
        session_id: str = "",
        turn_id: str = "",
        project_id: str = "",
        canvas_id: str = "",
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        ts = now_ms()
        body = payload if isinstance(payload, dict) else {}
        cur = db.execute(
            "INSERT INTO workspace_events(event_type, bot_id, session_id, turn_id, project_id, canvas_id, payload_json, created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (event_type, bot_id, session_id, turn_id, project_id, canvas_id, dump_json(body), ts),
        )
        return {
            "seq": int(cur.lastrowid),
            "event_type": event_type,
            "bot_id": bot_id,
            "session_id": session_id,
            "turn_id": turn_id,
            "project_id": project_id,
            "canvas_id": canvas_id,
            "payload": body,
            "created_at": ts,
        }

    def emit_event(self, event_type: str, **kwargs: Any) -> Dict[str, Any]:
        with self.transaction() as db:
            return self.emit_event_tx(db, event_type, **kwargs)

    def list_events(
        self,
        *,
        after: int = 0,
        limit: int = 200,
        bot_id: str = "",
        session_id: str = "",
        project_id: str = "",
        canvas_id: str = "",
    ) -> List[Dict[str, Any]]:
        safe_limit = max(1, min(500, int(limit or 200)))
        clauses = ["seq > ?"]
        params: List[Any] = [max(0, int(after or 0))]
        if bot_id:
            clauses.append("(bot_id = '' OR bot_id = ?)")
            params.append(bot_id)
        if session_id:
            clauses.append("(session_id = '' OR session_id = ?)")
            params.append(session_id)
        if project_id:
            clauses.append("(project_id = '' OR project_id = ?)")
            params.append(project_id)
        if canvas_id:
            clauses.append("(canvas_id = '' OR canvas_id = ?)")
            params.append(canvas_id)
        params.append(safe_limit)
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM workspace_events WHERE {' AND '.join(clauses)} ORDER BY seq ASC LIMIT ?",
                params,
            ).fetchall()
        return [
            {
                "seq": r["seq"],
                "event_type": r["event_type"],
                "bot_id": r["bot_id"],
                "session_id": r["session_id"],
                "turn_id": r["turn_id"],
                "project_id": r["project_id"],
                "canvas_id": r["canvas_id"],
                "payload": load_json(r["payload_json"], {}),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def latest_event_seq(self) -> int:
        with self.transaction() as db:
            row = db.execute("SELECT COALESCE(MAX(seq), 0) FROM workspace_events").fetchone()
            return int(row[0] if row else 0)

    # -- 初始化唯一总管理 Bot ---------------------------------------------

    def ensure_manager_bot(self) -> Tuple[Dict[str, Any], bool]:
        """幂等初始化唯一默认总管理 Bot（bot_manager）；绝不创建其他专业 Bot。"""
        with self.transaction() as db:
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (MANAGER_BOT_ID,)).fetchone()
            if row is not None:
                return self._bot_from_row(db, row), False
            ts = now_ms()
            avatar = normalize_avatar({"text": "总", "color": "#2F6F5E", "shape": "star"})
            delegation = normalize_delegation_policy(
                {"allow_delegate": True, "allow_temp_subagents": True, "max_delegation_depth": 2},
                is_manager=True,
            )
            canvas_policy = normalize_canvas_policy(
                {"allow_canvas_read": True, "allow_canvas_writes": True, "require_approval_for_paid": True},
                is_manager=True,
            )
            db.execute(
                "INSERT INTO bots("
                "bot_id, name, avatar_json, role, system_instructions, personality, is_manager, status, "
                "chat_provider_id, chat_model, vision_provider_id, vision_model, image_provider_id, image_model, "
                "model_params_json, tool_permissions_json, permission_ceiling_json, delegation_policy_json, "
                "canvas_policy_json, created_by, legacy_source_id, legacy_default, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    MANAGER_BOT_ID,
                    "小美总管理",
                    dump_json(avatar),
                    "总管理 Bot：自然语言创建与管理永久 Bot、协调任务委派与画布执行",
                    MANAGER_DEFAULT_INSTRUCTIONS,
                    "沉稳、清晰、务实，先明确边界与步骤再推进任务。",
                    1,
                    "active",
                    "", "", "", "", "", "",
                    dump_json({"auto_match_skills": True}),
                    dump_json(MANAGER_DEFAULT_TOOLS),
                    dump_json(MANAGER_DEFAULT_TOOLS),
                    dump_json(delegation),
                    dump_json(canvas_policy),
                    "system",
                    None,
                    0,
                    ts,
                    ts,
                ),
            )
            self._create_session_tx(
                db,
                MANAGER_BOT_ID,
                title="默认工作会话",
                kind="chat",
                pinned=True,
            )
            self.emit_event_tx(db, "bot_initialized", bot_id=MANAGER_BOT_ID, payload={"bot_id": MANAGER_BOT_ID})
            created = db.execute("SELECT * FROM bots WHERE bot_id=?", (MANAGER_BOT_ID,)).fetchone()
            return self._bot_from_row(db, created), True

    # -- Bot CRUD ---------------------------------------------------------

    def list_bots(self, *, include_archived: bool = False) -> List[Dict[str, Any]]:
        with self.transaction() as db:
            if include_archived:
                rows = db.execute(
                    "SELECT * FROM bots ORDER BY is_manager DESC, CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC"
                ).fetchall()
            else:
                rows = db.execute(
                    "SELECT * FROM bots WHERE status='active' ORDER BY is_manager DESC, created_at ASC"
                ).fetchall()
            return [self._bot_from_row(db, row) for row in rows]

    def get_bot(self, bot_id: str) -> Dict[str, Any]:
        wanted = str(bot_id or "").strip()
        with self.transaction() as db:
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            if row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{wanted}", 404)
            return self._bot_from_row(db, row)

    def create_bot(
        self,
        payload: Dict[str, Any],
        *,
        created_by: str = "user",
        creator_permissions: Optional[Iterable[str]] = None,
        user_ceiling: Optional[Iterable[str]] = None,
        strict_permissions: bool = True,
    ) -> Dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        if data.get("is_manager"):
            raise BotWorkspaceError("manager_unique", "不允许创建第二个总管理 Bot", 403)
        assert_no_secrets(data, field_label="Bot 配置")

        name = _clean_text(data.get("name"), BOT_NAME_MAX)
        if not name:
            raise BotWorkspaceError("invalid_bot", "Bot 名称不能为空", 422)

        requested_id = _clean_text(data.get("bot_id"), 64).lower()
        if requested_id == MANAGER_BOT_ID:
            raise BotWorkspaceError("manager_unique", "bot_manager 为唯一总管理保留编号", 403)
        if requested_id and not BOT_ID_RE.fullmatch(requested_id):
            raise BotWorkspaceError("invalid_bot", "Bot 编号只允许小写字母开头及数字、下划线、短横线（3-64位）", 422)
        bot_id = requested_id or new_id("bot")

        role = _clean_text(data.get("role"), BOT_ROLE_MAX)
        instructions = _clean_text(data.get("system_instructions") or data.get("instructions"), BOT_INSTRUCTIONS_MAX)
        personality = _clean_text(data.get("personality"), BOT_PERSONALITY_MAX)
        chat_model = normalize_model_ref(data.get("chat_model") or data.get("model"))
        vision_model = normalize_model_ref(data.get("vision_model"))
        image_model = normalize_model_ref(data.get("image_model"))
        model_params = normalize_model_params(data.get("model_params"))
        avatar = normalize_avatar(
            data.get("avatar"),
            fallback_text=name[:1] or "助",
            fallback_color="#3C6E9F",
            fallback_shape="bunny",
        )

        # 计算合法权限上限：绝对不超过 SPECIALIST_MAX_TOOLS ∩ creator_permissions ∩ user_ceiling
        ceiling = set(SPECIALIST_MAX_TOOLS)
        if creator_permissions is not None:
            ceiling &= set(creator_permissions)
        if user_ceiling is not None:
            ceiling &= set(user_ceiling)
        if data.get("permission_ceiling") is not None:
            explicit_ceiling = set(
                sanitize_tool_permissions(
                    data["permission_ceiling"],
                    is_manager=False,
                    allowed_ceiling=ceiling,
                    strict=strict_permissions,
                )
            )
            ceiling &= explicit_ceiling

        raw_tools = data.get("tool_permissions")
        if raw_tools is None:
            tools = [t for t in SPECIALIST_DEFAULT_TOOLS if t in ceiling]
        else:
            tools = sanitize_tool_permissions(
                raw_tools,
                is_manager=False,
                allowed_ceiling=ceiling,
                strict=strict_permissions,
            )

        delegation_policy = normalize_delegation_policy(data.get("delegation_policy"), is_manager=False)
        if "bot.delegate" not in tools:
            delegation_policy["allow_delegate"] = False
        canvas_policy = normalize_canvas_policy(data.get("canvas_policy"), is_manager=False)
        if not (set(tools) & set(CANVAS_WRITE_TOOLS)):
            canvas_policy["allow_canvas_writes"] = False

        status = str(data.get("status") or "active").strip().lower()
        if status not in BOT_STATUSES:
            status = "active"

        with self.transaction() as db:
            total = db.execute("SELECT COUNT(*) FROM bots").fetchone()[0]
            if total >= BOT_LIST_MAX:
                raise BotWorkspaceError("bot_limit", f"永久 Bot 数量已达上限（{BOT_LIST_MAX}）", 409)
            if db.execute("SELECT 1 FROM bots WHERE bot_id=?", (bot_id,)).fetchone():
                raise BotWorkspaceError("bot_exists", "Bot 编号已存在，请重试", 409)
            if status == "active" and db.execute(
                "SELECT 1 FROM bots WHERE name=? AND status='active'", (name,)
            ).fetchone():
                raise BotWorkspaceError("bot_name_duplicate", f"已存在同名活跃 Bot「{name}」", 409)
            legacy_source_id = _clean_text(data.get("legacy_source_id"), 80) or None
            ts = now_ms()
            db.execute(
                "INSERT INTO bots("
                "bot_id, name, avatar_json, role, system_instructions, personality, is_manager, status, "
                "chat_provider_id, chat_model, vision_provider_id, vision_model, image_provider_id, image_model, "
                "model_params_json, tool_permissions_json, permission_ceiling_json, delegation_policy_json, "
                "canvas_policy_json, created_by, legacy_source_id, legacy_default, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    bot_id, name, dump_json(avatar), role, instructions, personality, 0, status,
                    chat_model["provider_id"], chat_model["model"],
                    vision_model["provider_id"], vision_model["model"],
                    image_model["provider_id"], image_model["model"],
                    dump_json(model_params), dump_json(tools), dump_json(sorted(ceiling)),
                    dump_json(delegation_policy), dump_json(canvas_policy),
                    _clean_text(created_by, 64) or "user",
                    legacy_source_id,
                    1 if data.get("legacy_default") else 0,
                    ts, ts,
                ),
            )
            skill_ids = data.get("skill_ids") or data.get("skills") or []
            if isinstance(skill_ids, list) and skill_ids:
                self._set_bot_skills_tx(db, bot_id, skill_ids)
            if status == "active":
                self._create_session_tx(db, bot_id, title="默认会话", kind="chat", pinned=True)
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
            bot = self._bot_from_row(db, row)
            self.emit_event_tx(db, "bot_created", bot_id=bot_id, payload={"bot": bot})
            return bot

    def update_bot(
        self,
        bot_id: str,
        patch: Dict[str, Any],
        *,
        actor_is_manager: bool = True,
        actor_bot_id: str = "",
        strict_permissions: bool = True,
    ) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        if "is_manager" in data:
            raise BotWorkspaceError("permission_escalation", "不允许修改 Bot 的总管理身份", 403)
        assert_no_secrets(data, field_label="Bot 配置")

        wanted = str(bot_id or "").strip()
        if not actor_is_manager:
            raise BotWorkspaceError("forbidden", "只有用户或总管理 Bot 可以修改永久 Bot 档案", 403)

        with self.transaction() as db:
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            if row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{wanted}", 404)
            current = self._bot_from_row(db, row)
            is_manager = current["is_manager"]

            name = current["name"]
            if "name" in data:
                name = _clean_text(data.get("name"), BOT_NAME_MAX)
                if not name:
                    raise BotWorkspaceError("invalid_bot", "Bot 名称不能为空", 422)
                if db.execute(
                    "SELECT 1 FROM bots WHERE bot_id != ? AND name = ? AND status = 'active'",
                    (wanted, name),
                ).fetchone():
                    raise BotWorkspaceError("bot_name_duplicate", f"已存在同名活跃 Bot「{name}」", 409)

            role = _clean_text(data["role"], BOT_ROLE_MAX) if "role" in data else current["role"]
            instructions = (
                _clean_text(data.get("system_instructions", data.get("instructions")), BOT_INSTRUCTIONS_MAX)
                if ("system_instructions" in data or "instructions" in data)
                else current["system_instructions"]
            )
            personality = _clean_text(data["personality"], BOT_PERSONALITY_MAX) if "personality" in data else current["personality"]
            avatar = (
                normalize_avatar(
                    data["avatar"],
                    fallback_text=name[:1] or "助",
                    fallback_color=current["avatar"].get("color", "#2F6F5E"),
                    fallback_shape=current["avatar"].get("shape", "star"),
                )
                if "avatar" in data
                else current["avatar"]
            )
            chat_model = normalize_model_ref(data["chat_model"]) if "chat_model" in data else current["chat_model"]
            vision_model = normalize_model_ref(data["vision_model"]) if "vision_model" in data else current["vision_model"]
            image_model = normalize_model_ref(data["image_model"]) if "image_model" in data else current["image_model"]
            model_params = normalize_model_params(data["model_params"]) if "model_params" in data else current["model_params"]

            ceiling = set(current["permission_ceiling"] or (MANAGER_DEFAULT_TOOLS if is_manager else SPECIALIST_MAX_TOOLS))
            if "permission_ceiling" in data and not is_manager:
                ceiling = set(
                    sanitize_tool_permissions(
                        data["permission_ceiling"],
                        is_manager=False,
                        allowed_ceiling=SPECIALIST_MAX_TOOLS,
                        strict=strict_permissions,
                    )
                )
            if "tool_permissions" in data:
                tools = sanitize_tool_permissions(
                    data["tool_permissions"],
                    is_manager=is_manager,
                    allowed_ceiling=ALL_REGISTERED_TOOLS if is_manager else ceiling,
                    strict=strict_permissions,
                )
            else:
                tools = [t for t in current["tool_permissions"] if is_manager or t in ceiling]

            delegation_policy = (
                normalize_delegation_policy(data["delegation_policy"], is_manager=is_manager)
                if "delegation_policy" in data
                else current["delegation_policy"]
            )
            if not is_manager and "bot.delegate" not in tools:
                delegation_policy["allow_delegate"] = False

            canvas_policy = (
                normalize_canvas_policy(data["canvas_policy"], is_manager=is_manager)
                if "canvas_policy" in data
                else current["canvas_policy"]
            )
            if not is_manager and not (set(tools) & set(CANVAS_WRITE_TOOLS)):
                canvas_policy["allow_canvas_writes"] = False

            status = current["status"]
            if "status" in data:
                next_status = str(data["status"] or "").strip().lower()
                if next_status not in BOT_STATUSES:
                    raise BotWorkspaceError("invalid_status", "Bot 状态无效", 422)
                if is_manager and next_status == "archived":
                    raise BotWorkspaceError("manager_protected", "总管理 Bot 不能归档", 409)
                status = next_status

            ts = now_ms()
            db.execute(
                "UPDATE bots SET name=?, avatar_json=?, role=?, system_instructions=?, personality=?, status=?, "
                "chat_provider_id=?, chat_model=?, vision_provider_id=?, vision_model=?, image_provider_id=?, image_model=?, "
                "model_params_json=?, tool_permissions_json=?, permission_ceiling_json=?, delegation_policy_json=?, "
                "canvas_policy_json=?, updated_at=? WHERE bot_id=?",
                (
                    name, dump_json(avatar), role, instructions, personality, status,
                    chat_model["provider_id"], chat_model["model"],
                    vision_model["provider_id"], vision_model["model"],
                    image_model["provider_id"], image_model["model"],
                    dump_json(model_params), dump_json(tools), dump_json(sorted(ceiling)),
                    dump_json(delegation_policy), dump_json(canvas_policy),
                    ts, wanted,
                ),
            )
            if "skill_ids" in data or "skills" in data:
                self._set_bot_skills_tx(db, wanted, data.get("skill_ids", data.get("skills")) or [])
            fresh = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            updated = self._bot_from_row(db, fresh)
            self.emit_event_tx(db, "bot_updated", bot_id=wanted, payload={"bot": updated})
            return updated

    def archive_bot(self, bot_id: str, *, reason: str = "") -> Dict[str, Any]:
        wanted = str(bot_id or "").strip()
        if wanted == MANAGER_BOT_ID:
            raise BotWorkspaceError("manager_protected", "总管理 Bot 不能归档", 409)
        with self.transaction() as db:
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            if row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{wanted}", 404)
            if row["is_manager"]:
                raise BotWorkspaceError("manager_protected", "总管理 Bot 不能归档", 409)
            ts = now_ms()
            db.execute("UPDATE bots SET status='archived', updated_at=? WHERE bot_id=?", (ts, wanted))
            # 取消该 Bot 尚未启动的排队回合
            db.execute(
                "UPDATE turns SET status='cancelled', error=?, finished_at=?, updated_at=? "
                "WHERE bot_id=? AND status='queued'",
                (_clean_text(reason, 200) or "Bot 已归档，排队任务取消", ts, ts, wanted),
            )
            fresh = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            bot = self._bot_from_row(db, fresh)
            self.emit_event_tx(db, "bot_archived", bot_id=wanted, payload={"bot_id": wanted, "reason": reason})
            return bot

    def restore_bot(self, bot_id: str) -> Dict[str, Any]:
        wanted = str(bot_id or "").strip()
        with self.transaction() as db:
            row = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            if row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{wanted}", 404)
            name = row["name"]
            if db.execute(
                "SELECT 1 FROM bots WHERE bot_id != ? AND name = ? AND status = 'active'",
                (wanted, name),
            ).fetchone():
                raise BotWorkspaceError("bot_name_duplicate", f"已存在同名活跃 Bot「{name}」，请先重命名后再恢复", 409)
            ts = now_ms()
            db.execute("UPDATE bots SET status='active', updated_at=? WHERE bot_id=?", (ts, wanted))
            has_session = db.execute(
                "SELECT 1 FROM sessions WHERE bot_id=? AND archived=0 LIMIT 1", (wanted,)
            ).fetchone()
            if not has_session:
                self._create_session_tx(db, wanted, title="默认会话", kind="chat")
            fresh = db.execute("SELECT * FROM bots WHERE bot_id=?", (wanted,)).fetchone()
            bot = self._bot_from_row(db, fresh)
            self.emit_event_tx(db, "bot_restored", bot_id=wanted, payload={"bot": bot})
            return bot

    # -- Bot Skills 绑定 --------------------------------------------------

    def _set_bot_skills_tx(self, db: sqlite3.Connection, bot_id: str, items: Iterable[Any]) -> List[Dict[str, Any]]:
        db.execute("DELETE FROM bot_skills WHERE bot_id=?", (bot_id,))
        ts = now_ms()
        seen = set()
        result: List[Dict[str, Any]] = []
        for idx, entry in enumerate(items or []):
            if isinstance(entry, str):
                skill_id = _clean_text(entry, 120)
                mode, priority, enabled = "pinned", max(0, 100 - idx), True
            elif isinstance(entry, dict):
                skill_id = _clean_text(entry.get("skill_id") or entry.get("id"), 120)
                mode = str(entry.get("mode") or "pinned").strip().lower()
                if mode not in ("pinned", "auto"):
                    mode = "pinned"
                try:
                    priority = int(entry.get("priority", max(0, 100 - idx)))
                except (TypeError, ValueError):
                    priority = 0
                enabled = bool(entry.get("enabled", True))
            else:
                continue
            if not skill_id or skill_id in seen:
                continue
            seen.add(skill_id)
            db.execute(
                "INSERT INTO bot_skills(bot_id, skill_id, mode, priority, enabled, created_at) VALUES(?,?,?,?,?,?)",
                (bot_id, skill_id, mode, priority, 1 if enabled else 0, ts),
            )
            result.append({
                "skill_id": skill_id,
                "mode": mode,
                "priority": priority,
                "enabled": enabled,
                "created_at": ts,
            })
            if len(result) >= 32:
                break
        return result

    def set_bot_skills(self, bot_id: str, skills: List[Any]) -> List[Dict[str, Any]]:
        with self.transaction() as db:
            if not db.execute("SELECT 1 FROM bots WHERE bot_id=?", (bot_id,)).fetchone():
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{bot_id}", 404)
            bound = self._set_bot_skills_tx(db, bot_id, skills)
            db.execute("UPDATE bots SET updated_at=? WHERE bot_id=?", (now_ms(), bot_id))
            self.emit_event_tx(db, "bot_skills_updated", bot_id=bot_id, payload={"skills": bound})
            return bound

    # -- Bot 独立长期记忆 --------------------------------------------------

    def list_memories(
        self,
        bot_id: str,
        *,
        scope: str = "",
        project_id: str = "",
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        clauses = ["bot_id = ?", "status = 'active'"]
        params: List[Any] = [str(bot_id or "").strip()]
        if scope:
            if scope not in MEMORY_SCOPES:
                raise BotWorkspaceError("invalid_scope", "记忆范围无效", 422)
            clauses.append("scope = ?")
            params.append(scope)
        if project_id:
            clauses.append("(project_id = '' OR project_id = ?)")
            params.append(_clean_scope_id(project_id))
        params.append(max(1, min(200, int(limit or 100))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM bot_memories WHERE {' AND '.join(clauses)} ORDER BY updated_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def add_memory(
        self,
        bot_id: str,
        content: str,
        *,
        scope: str = "bot",
        project_id: str = "",
        source: str = "用户",
    ) -> Tuple[Dict[str, Any], bool]:
        if scope not in MEMORY_SCOPES:
            raise BotWorkspaceError("invalid_scope", "记忆范围无效", 422)
        text = " ".join(str(content or "").split())
        if not text:
            raise BotWorkspaceError("invalid_memory", "记忆内容不能为空", 422)
        if len(text) > MEMORY_TEXT_MAX:
            raise BotWorkspaceError("memory_too_long", f"单条记忆不能超过 {MEMORY_TEXT_MAX} 字", 422)
        if contains_secret_text(text):
            raise BotWorkspaceError("secret_rejected", "记忆内容包含疑似密钥或令牌，已拒绝写入", 422)
        clean_project = _clean_scope_id(project_id) if scope == "project" else ""
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        with self.transaction() as db:
            bot_row = db.execute("SELECT is_manager FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
            if bot_row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{bot_id}", 404)
            if scope == "shared" and not bot_row["is_manager"]:
                raise BotWorkspaceError("forbidden", "只有总管理 Bot 可以写入共享记忆", 403)
            existing = db.execute(
                "SELECT * FROM bot_memories WHERE bot_id=? AND scope=? AND project_id=? AND content_hash=? AND status='active'",
                (bot_id, scope, clean_project, content_hash),
            ).fetchone()
            if existing is not None:
                return dict(existing), False
            count = db.execute(
                "SELECT COUNT(*) FROM bot_memories WHERE bot_id=? AND status='active'", (bot_id,)
            ).fetchone()[0]
            if count >= MEMORY_PER_BOT_MAX:
                raise BotWorkspaceError("memory_full", f"该 Bot 记忆条目已达上限（{MEMORY_PER_BOT_MAX}）", 409)
            ts = now_ms()
            memory_id = new_id("mem")
            db.execute(
                "INSERT INTO bot_memories(memory_id, bot_id, scope, project_id, content, source, status, content_hash, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (memory_id, bot_id, scope, clean_project, text, _clean_text(source, 60) or "用户", "active", content_hash, ts, ts),
            )
            created = db.execute("SELECT * FROM bot_memories WHERE memory_id=?", (memory_id,)).fetchone()
            record = dict(created)
            self.emit_event_tx(db, "memory_added", bot_id=bot_id, project_id=clean_project, payload={"memory": record})
            return record, True

    def update_memory(self, bot_id: str, memory_id: str, content: str) -> Dict[str, Any]:
        text = " ".join(str(content or "").split())
        if not text:
            raise BotWorkspaceError("invalid_memory", "记忆内容不能为空", 422)
        if len(text) > MEMORY_TEXT_MAX:
            raise BotWorkspaceError("memory_too_long", f"单条记忆不能超过 {MEMORY_TEXT_MAX} 字", 422)
        if contains_secret_text(text):
            raise BotWorkspaceError("secret_rejected", "记忆内容包含疑似密钥或令牌，已拒绝写入", 422)
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM bot_memories WHERE memory_id=? AND bot_id=? AND status='active'",
                (memory_id, bot_id),
            ).fetchone()
            if row is None:
                raise BotWorkspaceError("memory_not_found", "该条记忆不存在", 404)
            ts = now_ms()
            try:
                db.execute(
                    "UPDATE bot_memories SET content=?, content_hash=?, source='用户编辑', updated_at=? WHERE memory_id=?",
                    (text, content_hash, ts, memory_id),
                )
            except sqlite3.IntegrityError as exc:
                raise BotWorkspaceError("memory_duplicate", "已存在相同内容的记忆", 409) from exc
            fresh = db.execute("SELECT * FROM bot_memories WHERE memory_id=?", (memory_id,)).fetchone()
            return dict(fresh)

    def delete_memory(self, bot_id: str, memory_id: str) -> bool:
        with self.transaction() as db:
            cur = db.execute(
                "UPDATE bot_memories SET status='deleted', updated_at=? WHERE memory_id=? AND bot_id=? AND status='active'",
                (now_ms(), memory_id, bot_id),
            )
            if cur.rowcount == 0:
                raise BotWorkspaceError("memory_not_found", "该条记忆不存在", 404)
            return True

    def forget_memory_by_text(self, bot_id: str, target: str) -> bool:
        needle = _clean_text(target, 120)
        if not needle:
            return False
        with self.transaction() as db:
            rows = db.execute(
                "SELECT memory_id, content FROM bot_memories WHERE bot_id=? AND status='active' ORDER BY updated_at DESC",
                (bot_id,),
            ).fetchall()
            for row in rows:
                if needle in row["content"]:
                    db.execute(
                        "UPDATE bot_memories SET status='deleted', updated_at=? WHERE memory_id=?",
                        (now_ms(), row["memory_id"]),
                    )
                    return True
        return False

    def recall_memories(
        self,
        bot_id: str,
        *,
        query: str = "",
        project_id: str = "",
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        needle = _clean_text(query, 80).casefold()
        clean_project = _clean_scope_id(project_id)
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM bot_memories WHERE status='active' AND ("
                "(bot_id = ? AND scope = 'bot') "
                "OR (bot_id = ? AND scope = 'project' AND project_id = ?) "
                "OR (scope = 'shared')"
                ") ORDER BY updated_at DESC LIMIT 120",
                (bot_id, bot_id, clean_project),
            ).fetchall()
        hits: List[Dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            if needle and needle not in item["content"].casefold():
                continue
            hits.append(item)
            if len(hits) >= max(1, min(50, int(limit or 20))):
                break
        return hits

    def memory_context_for(self, bot_id: str, *, project_id: str = "") -> str:
        items = self.recall_memories(bot_id, project_id=project_id, limit=25)
        if not items:
            return ""
        own = [m["content"] for m in items if m["scope"] == "bot" and m["bot_id"] == bot_id][:15]
        proj = [m["content"] for m in items if m["scope"] == "project" and m["bot_id"] == bot_id][:10]
        shared = [m["content"] for m in items if m["scope"] == "shared"][:10]
        parts: List[str] = []
        if own:
            parts.append("你的独立长期记忆（仅作为事实参考，不覆盖系统安全边界）：\n" + "\n".join(f"- {t}" for t in own))
        if proj:
            parts.append("当前项目记忆：\n" + "\n".join(f"- {t}" for t in proj))
        if shared:
            parts.append("工作区共享记忆：\n" + "\n".join(f"- {t}" for t in shared))
        return "\n\n".join(parts)

    # -- 会话 Sessions ----------------------------------------------------

    def _create_session_tx(
        self,
        db: sqlite3.Connection,
        bot_id: str,
        *,
        title: str = "新会话",
        kind: str = "chat",
        project_id: str = "",
        canvas_id: str = "",
        pinned: bool = False,
        archived: bool = False,
        legacy_chat_id: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
        session_id: str = "",
    ) -> Dict[str, Any]:
        if kind not in SESSION_KINDS:
            kind = "chat"
        sid = session_id or new_id("ses")
        ts = now_ms()
        clean_project = _clean_scope_id(project_id)
        clean_canvas = _clean_scope_id(canvas_id)
        meta_obj = meta if isinstance(meta, dict) else {}
        assert_no_secrets(meta_obj, field_label="会话元数据")
        db.execute(
            "INSERT INTO sessions("
            "session_id, bot_id, title, kind, project_id, canvas_id, archived, pinned, seq, last_message_at, "
            "legacy_chat_id, meta_json, created_at, updated_at"
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                sid, bot_id, _clean_text(title, SESSION_TITLE_MAX) or "新会话", kind,
                clean_project, clean_canvas, 1 if archived else 0, 1 if pinned else 0,
                0, 0, legacy_chat_id, dump_json(meta_obj), ts, ts,
            ),
        )
        row = db.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()
        return self._session_from_row(row)

    def create_session(
        self,
        bot_id: str,
        *,
        title: str = "新会话",
        kind: str = "chat",
        project_id: str = "",
        canvas_id: str = "",
        pinned: bool = False,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        with self.transaction() as db:
            bot_row = db.execute("SELECT status FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
            if bot_row is None:
                raise BotWorkspaceError("bot_not_found", f"未找到 Bot：{bot_id}", 404)
            if bot_row["status"] != "active":
                raise BotWorkspaceError("bot_archived", "已归档的 Bot 不能新建会话，请先恢复", 409)
            session = self._create_session_tx(
                db, bot_id, title=title, kind=kind,
                project_id=project_id, canvas_id=canvas_id, pinned=pinned, meta=meta,
            )
            self.emit_event_tx(
                db, "session_created", bot_id=bot_id, session_id=session["session_id"],
                project_id=session["project_id"], canvas_id=session["canvas_id"],
                payload={"session": session},
            )
            return session

    def get_session(self, session_id: str) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM sessions WHERE session_id=?", (str(session_id or "").strip(),)).fetchone()
            if row is None:
                raise BotWorkspaceError("session_not_found", "会话不存在", 404)
            return self._session_from_row(row)

    def list_sessions(
        self,
        bot_id: str,
        *,
        include_archived: bool = False,
        project_id: str = "",
        canvas_id: str = "",
        limit: int = 80,
    ) -> List[Dict[str, Any]]:
        clauses = ["bot_id = ?"]
        params: List[Any] = [str(bot_id or "").strip()]
        if not include_archived:
            clauses.append("archived = 0")
        if project_id:
            clean_p = _clean_scope_id(project_id)
            clauses.append("(project_id = '' OR project_id = ?)")
            params.append(clean_p)
        if canvas_id:
            clean_c = _clean_scope_id(canvas_id)
            clauses.append("(canvas_id = '' OR canvas_id = ?)")
            params.append(clean_c)
        params.append(max(1, min(200, int(limit or 80))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM sessions WHERE {' AND '.join(clauses)} "
                "ORDER BY pinned DESC, last_message_at DESC, updated_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._session_from_row(r) for r in rows]

    def update_session(self, session_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        data = patch if isinstance(patch, dict) else {}
        with self.transaction() as db:
            row = db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("session_not_found", "会话不存在", 404)
            title = _clean_text(data["title"], SESSION_TITLE_MAX) if "title" in data and _clean_text(data["title"], SESSION_TITLE_MAX) else row["title"]
            archived = 1 if data["archived"] else 0 if "archived" in data else row["archived"]
            pinned = 1 if data["pinned"] else 0 if "pinned" in data else row["pinned"]
            project_id = _clean_scope_id(data["project_id"]) if "project_id" in data else row["project_id"]
            canvas_id = _clean_scope_id(data["canvas_id"]) if "canvas_id" in data else row["canvas_id"]
            # 已绑定其他项目的会话禁止悄悄跨项目改绑
            if row["project_id"] and "project_id" in data and project_id and project_id != row["project_id"]:
                raise BotWorkspaceError("project_mismatch", "该会话已绑定其他项目，请在新项目中新建会话", 403)
            db.execute(
                "UPDATE sessions SET title=?, archived=?, pinned=?, project_id=?, canvas_id=?, updated_at=? WHERE session_id=?",
                (title, archived, pinned, project_id, canvas_id, now_ms(), session_id),
            )
            fresh = db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            return self._session_from_row(fresh)

    def ensure_default_session(self, bot_id: str, *, project_id: str = "", canvas_id: str = "") -> Dict[str, Any]:
        sessions = self.list_sessions(bot_id, include_archived=False, project_id=project_id, canvas_id=canvas_id, limit=1)
        if sessions:
            return sessions[0]
        return self.create_session(bot_id, title="默认会话", kind="chat", project_id=project_id, canvas_id=canvas_id)

    # -- 消息与回合持久化（先落库后入队） -----------------------------------

    def _append_message_tx(
        self,
        db: sqlite3.Connection,
        session_id: str,
        *,
        bot_id: str,
        role: str,
        content: str = "",
        kind: str = "text",
        attachments: Optional[List[Any]] = None,
        meta: Optional[Dict[str, Any]] = None,
        idempotency_key: str = "",
        turn_id: str = "",
        delegation_id: str = "",
        created_at: Optional[int] = None,
    ) -> Dict[str, Any]:
        if role not in MESSAGE_ROLES:
            role = "system"
        if kind not in MESSAGE_KINDS:
            kind = "text"
        sess = db.execute("SELECT seq, title, project_id, canvas_id FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if sess is None:
            raise BotWorkspaceError("session_not_found", "会话不存在", 404)
        clean_content = str(content or "")[:MESSAGE_TEXT_MAX]
        assert_no_secrets(clean_content, field_label="消息内容")
        att_list = attachments if isinstance(attachments, list) else []
        meta_obj = meta if isinstance(meta, dict) else {}
        assert_no_secrets(meta_obj, field_label="消息元数据")

        next_seq = int(sess["seq"]) + 1
        ts = int(created_at or now_ms())
        msg_id = new_id("msg")
        db.execute(
            "INSERT INTO messages("
            "message_id, session_id, bot_id, seq, role, kind, content, attachments_json, meta_json, "
            "idempotency_key, turn_id, delegation_id, created_at"
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                msg_id, session_id, bot_id, next_seq, role, kind, clean_content,
                dump_json(att_list), dump_json(meta_obj), _clean_text(idempotency_key, 120),
                turn_id, delegation_id, ts,
            ),
        )
        new_title = sess["title"]
        if role == "user" and next_seq == 1 and new_title in ("新会话", "默认会话", "默认工作会话") and clean_content.strip():
            new_title = clean_content.strip().splitlines()[0][:28]
        db.execute(
            "UPDATE sessions SET seq=?, last_message_at=?, title=?, updated_at=? WHERE session_id=?",
            (next_seq, ts, new_title, ts, session_id),
        )
        row = db.execute("SELECT * FROM messages WHERE message_id=?", (msg_id,)).fetchone()
        msg = self._message_from_row(row)
        self.emit_event_tx(
            db, "message_created", bot_id=bot_id, session_id=session_id, turn_id=turn_id,
            project_id=sess["project_id"], canvas_id=sess["canvas_id"],
            payload={"message": msg},
        )
        return msg

    def append_message(self, session_id: str, **kwargs: Any) -> Dict[str, Any]:
        with self.transaction() as db:
            return self._append_message_tx(db, session_id, **kwargs)

    def list_messages(self, session_id: str, *, after: int = 0, limit: int = 200) -> Dict[str, Any]:
        safe_limit = max(1, min(500, int(limit or 200)))
        cursor = max(0, int(after or 0))
        with self.transaction() as db:
            sess_row = db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if sess_row is None:
                raise BotWorkspaceError("session_not_found", "会话不存在", 404)
            rows = db.execute(
                "SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
                (session_id, cursor, safe_limit + 1),
            ).fetchall()
            has_more = len(rows) > safe_limit
            selected = [self._message_from_row(r) for r in rows[:safe_limit]]
            return {
                "session": self._session_from_row(sess_row),
                "messages": selected,
                "cursor": selected[-1]["seq"] if selected else cursor,
                "has_more": has_more,
            }

    def enqueue_message_and_turn(
        self,
        session_id: str,
        *,
        content: str,
        role: str = "user",
        attachments: Optional[List[Any]] = None,
        meta: Optional[Dict[str, Any]] = None,
        idempotency_key: str = "",
        project_id: str = "",
        canvas_id: str = "",
        parent_turn_id: str = "",
        delegation_id: str = "",
        model_snapshot: Optional[Dict[str, Any]] = None,
        permission_snapshot: Optional[Dict[str, Any]] = None,
        skill_snapshot: Optional[List[str]] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], bool]:
        """原子操作：先持久化消息，再入队回合与 outbox；支持按 idempotency_key 去重。"""
        text = str(content or "").strip()
        att_list = attachments if isinstance(attachments, list) else []
        if not text and not att_list:
            raise BotWorkspaceError("empty_message", "消息内容不能为空", 422)
        clean_key = _clean_text(idempotency_key, 120) or new_id("idem")
        clean_project = _clean_scope_id(project_id)
        clean_canvas = _clean_scope_id(canvas_id)
        sig = sha256_json({
            "session_id": session_id,
            "role": role,
            "content": text,
            "attachments": att_list,
            "project_id": clean_project,
            "canvas_id": clean_canvas,
        })

        with self.transaction() as db:
            sess_row = db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if sess_row is None:
                raise BotWorkspaceError("session_not_found", "会话不存在", 404)
            bot_id = sess_row["bot_id"]
            bot_row = db.execute("SELECT * FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
            if bot_row is None:
                raise BotWorkspaceError("bot_not_found", "目标 Bot 不存在", 404)
            if bot_row["status"] != "active":
                raise BotWorkspaceError("bot_archived", "该 Bot 已归档，请先恢复后再发送消息", 409)
            # 防止切换项目后跨项目写入已绑定到其他项目的会话
            if sess_row["project_id"] and clean_project and sess_row["project_id"] != clean_project:
                raise BotWorkspaceError("project_mismatch", "当前会话绑定在其他项目，请切换项目或新建会话", 403)

            existing_turn = db.execute(
                "SELECT * FROM turns WHERE idempotency_key=?", (clean_key,)
            ).fetchone()
            if existing_turn is not None:
                if existing_turn["request_signature"] and existing_turn["request_signature"] != sig:
                    raise BotWorkspaceError("idempotency_conflict", "同一请求编号不能提交不同内容", 409)
                msg_row = db.execute(
                    "SELECT * FROM messages WHERE message_id=?", (existing_turn["trigger_message_id"],)
                ).fetchone()
                return (
                    self._message_from_row(msg_row) if msg_row else {},
                    self._turn_from_row(existing_turn),
                    False,
                )

            bound_project = sess_row["project_id"] or clean_project
            bound_canvas = sess_row["canvas_id"] or clean_canvas
            if (bound_project != sess_row["project_id"] or bound_canvas != sess_row["canvas_id"]) and (bound_project or bound_canvas):
                db.execute(
                    "UPDATE sessions SET project_id=?, canvas_id=?, updated_at=? WHERE session_id=?",
                    (bound_project, bound_canvas, now_ms(), session_id),
                )

            bot = self._bot_from_row(db, bot_row)
            turn_id = new_id("trn")
            msg = self._append_message_tx(
                db,
                session_id,
                bot_id=bot_id,
                role=role,
                content=text,
                kind="text",
                attachments=att_list,
                meta=meta or {},
                idempotency_key=clean_key,
                turn_id=turn_id,
                delegation_id=delegation_id,
            )
            effective_model_snap = model_snapshot if isinstance(model_snapshot, dict) else {
                "chat": bot["chat_model"],
                "vision": bot["vision_model"],
                "image": bot["image_model"],
                "params": bot["model_params"],
            }
            effective_perm_snap = permission_snapshot if isinstance(permission_snapshot, dict) else {
                "is_manager": bot["is_manager"],
                "tool_permissions": bot["tool_permissions"],
                "delegation_policy": bot["delegation_policy"],
                "canvas_policy": bot["canvas_policy"],
            }
            effective_skills = list(skill_snapshot) if skill_snapshot is not None else [
                s["skill_id"] for s in bot["skills"] if s.get("enabled")
            ]
            ts = now_ms()
            db.execute(
                "INSERT INTO turns("
                "turn_id, session_id, bot_id, trigger_message_id, parent_turn_id, delegation_id, "
                "project_id, canvas_id, idempotency_key, request_signature, status, "
                "model_snapshot_json, permission_snapshot_json, skill_snapshot_json, "
                "steps, result_summary, result_refs_json, error, recovery_required, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    turn_id, session_id, bot_id, msg["message_id"], parent_turn_id, delegation_id,
                    bound_project, bound_canvas, clean_key, sig, "queued",
                    dump_json(effective_model_snap), dump_json(effective_perm_snap), dump_json(effective_skills),
                    0, "", "[]", "", 0, ts, ts,
                ),
            )
            self._enqueue_outbox_tx(
                db,
                kind="turn_dispatch",
                target_bot_id=bot_id,
                target_session_id=session_id,
                target_turn_id=turn_id,
                payload={"turn_id": turn_id, "bot_id": bot_id, "session_id": session_id},
                idempotency_key=f"outbox_turn_{turn_id}",
            )
            turn_row = db.execute("SELECT * FROM turns WHERE turn_id=?", (turn_id,)).fetchone()
            turn = self._turn_from_row(turn_row)
            self.emit_event_tx(
                db, "turn_queued", bot_id=bot_id, session_id=session_id, turn_id=turn_id,
                project_id=bound_project, canvas_id=bound_canvas,
                payload={"turn": turn},
            )
            return msg, turn, True

    # -- Turns 状态管理 ---------------------------------------------------

    def get_turn(self, turn_id: str) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM turns WHERE turn_id=?", (turn_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("turn_not_found", "任务回合不存在", 404)
            return self._turn_from_row(row)

    def list_turns(
        self,
        *,
        bot_id: str = "",
        session_id: str = "",
        status: str = "",
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        params: List[Any] = []
        if bot_id:
            clauses.append("bot_id = ?")
            params.append(bot_id)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        params.append(max(1, min(200, int(limit or 50))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM turns WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._turn_from_row(r) for r in rows]

    def update_turn(
        self,
        turn_id: str,
        *,
        status: Optional[str] = None,
        steps: Optional[int] = None,
        result_summary: Optional[str] = None,
        result_refs: Optional[List[Dict[str, Any]]] = None,
        error: Optional[str] = None,
        recovery_required: Optional[bool] = None,
        started_at: Optional[int] = None,
        finished_at: Optional[int] = None,
        emit: bool = True,
    ) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM turns WHERE turn_id=?", (turn_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("turn_not_found", "任务回合不存在", 404)
            next_status = status if status is not None else row["status"]
            if next_status not in TURN_STATUSES:
                raise BotWorkspaceError("invalid_status", f"无效的回合状态：{next_status}", 422)
            ts = now_ms()
            db.execute(
                "UPDATE turns SET status=?, steps=?, result_summary=?, result_refs_json=?, error=?, "
                "recovery_required=?, started_at=?, finished_at=?, updated_at=? WHERE turn_id=?",
                (
                    next_status,
                    steps if steps is not None else row["steps"],
                    result_summary if result_summary is not None else row["result_summary"],
                    dump_json(result_refs) if result_refs is not None else row["result_refs_json"],
                    error if error is not None else row["error"],
                    (1 if recovery_required else 0) if recovery_required is not None else row["recovery_required"],
                    started_at if started_at is not None else row["started_at"],
                    finished_at if finished_at is not None else row["finished_at"],
                    ts,
                    turn_id,
                ),
            )
            fresh = db.execute("SELECT * FROM turns WHERE turn_id=?", (turn_id,)).fetchone()
            turn = self._turn_from_row(fresh)
            if emit:
                self.emit_event_tx(
                    db, "turn_updated", bot_id=turn["bot_id"], session_id=turn["session_id"],
                    turn_id=turn_id, project_id=turn["project_id"], canvas_id=turn["canvas_id"],
                    payload={"turn": turn},
                )
            return turn

    def list_queued_turns(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM turns WHERE status='queued' AND recovery_required=0 ORDER BY created_at ASC LIMIT ?",
                (max(1, min(100, int(limit or 20))),),
            ).fetchall()
        return [self._turn_from_row(r) for r in rows]

    # -- Delegations 委派 ------------------------------------------------

    def create_delegation(
        self,
        *,
        parent_bot_id: str,
        parent_session_id: str,
        parent_turn_id: str,
        target_bot_id: str,
        goal: str,
        instructions: str = "",
        context_refs: Optional[List[Any]] = None,
        granted_permissions: Optional[List[str]] = None,
        idempotency_key: str = "",
        project_id: str = "",
        canvas_id: str = "",
        session_mode: str = "new_thread",
    ) -> Tuple[Dict[str, Any], Dict[str, Any], bool]:
        if parent_bot_id == target_bot_id:
            raise BotWorkspaceError("self_delegation", "不能向自己委派任务", 422)
        clean_goal = _clean_text(goal, 8000)
        if not clean_goal:
            raise BotWorkspaceError("invalid_delegation", "委派目标不能为空", 422)
        clean_key = _clean_text(idempotency_key, 120) or new_id("delk")
        sig = sha256_json({
            "parent_bot_id": parent_bot_id,
            "parent_turn_id": parent_turn_id,
            "target_bot_id": target_bot_id,
            "goal": clean_goal,
            "instructions": _clean_text(instructions, 8000),
        })
        with self.transaction() as db:
            existing = db.execute(
                "SELECT * FROM delegations WHERE idempotency_key=?", (clean_key,)
            ).fetchone()
            if existing is not None:
                if existing["request_signature"] and existing["request_signature"] != sig:
                    raise BotWorkspaceError("idempotency_conflict", "同一委派编号不能提交不同任务", 409)
                t_row = db.execute("SELECT * FROM turns WHERE turn_id=?", (existing["target_turn_id"],)).fetchone()
                return self._delegation_from_row(existing), (self._turn_from_row(t_row) if t_row else {}), False

            parent_row = db.execute("SELECT * FROM bots WHERE bot_id=?", (parent_bot_id,)).fetchone()
            target_row = db.execute("SELECT * FROM bots WHERE bot_id=?", (target_bot_id,)).fetchone()
            if parent_row is None or target_row is None:
                raise BotWorkspaceError("bot_not_found", "委派源或目标 Bot 不存在", 404)
            if target_row["status"] != "active":
                raise BotWorkspaceError("bot_archived", "目标 Bot 已归档，无法委派任务", 409)
            parent_bot = self._bot_from_row(db, parent_row)
            target_bot = self._bot_from_row(db, target_row)

            # 权限交集：目标执行权限不得超过父 Bot、目标 Bot 自身权限与显式授权三者交集
            parent_tools = set(parent_bot["tool_permissions"])
            target_tools = set(target_bot["tool_permissions"])
            effective_tools = parent_tools & target_tools & SPECIALIST_MAX_TOOLS
            if granted_permissions is not None:
                requested = set(sanitize_tool_permissions(granted_permissions, is_manager=False, allowed_ceiling=parent_tools, strict=True))
                effective_tools &= requested

            # 循环委派检测：沿 parent_turn_id 向上回溯祖先 Bot
            visited_bots = {parent_bot_id}
            cursor_turn_id = parent_turn_id
            depth = 0
            while cursor_turn_id and depth < 10:
                t_row = db.execute("SELECT bot_id, parent_turn_id FROM turns WHERE turn_id=?", (cursor_turn_id,)).fetchone()
                if not t_row:
                    break
                visited_bots.add(t_row["bot_id"])
                cursor_turn_id = t_row["parent_turn_id"]
                depth += 1
            if target_bot_id in visited_bots:
                raise BotWorkspaceError("delegation_cycle", "检测到循环委派，已阻止执行", 409)
            max_depth = int((parent_bot.get("delegation_policy") or {}).get("max_delegation_depth", 2))
            if depth > max_depth:
                raise BotWorkspaceError("delegation_depth_limit", f"委派层级超过上限（{max_depth}）", 409)

            clean_project = _clean_scope_id(project_id)
            clean_canvas = _clean_scope_id(canvas_id)
            if session_mode == "reuse_active":
                found_sess = db.execute(
                    "SELECT * FROM sessions WHERE bot_id=? AND archived=0 AND (project_id='' OR project_id=?) "
                    "ORDER BY last_message_at DESC LIMIT 1",
                    (target_bot_id, clean_project),
                ).fetchone()
                target_session = (
                    self._session_from_row(found_sess)
                    if found_sess is not None
                    else self._create_session_tx(
                        db, target_bot_id, title=f"委派：{clean_goal[:24]}", kind="task_thread",
                        project_id=clean_project, canvas_id=clean_canvas,
                    )
                )
            else:
                target_session = self._create_session_tx(
                    db, target_bot_id, title=f"委派：{clean_goal[:24]}", kind="task_thread",
                    project_id=clean_project, canvas_id=clean_canvas,
                )

            delegation_id = new_id("del")
            target_turn_id = new_id("trn")
            delegation_msg = self._append_message_tx(
                db,
                target_session["session_id"],
                bot_id=target_bot_id,
                role="delegation",
                kind="task_card",
                content=clean_goal + (f"\n\n补充要求：{_clean_text(instructions, 4000)}" if instructions else ""),
                meta={
                    "parent_bot_id": parent_bot_id,
                    "parent_bot_name": parent_bot["name"],
                    "parent_turn_id": parent_turn_id,
                    "context_refs": context_refs or [],
                },
                idempotency_key=f"delmsg_{delegation_id}",
                turn_id=target_turn_id,
                delegation_id=delegation_id,
            )
            ts = now_ms()
            model_snap = {
                "chat": target_bot["chat_model"],
                "vision": target_bot["vision_model"],
                "image": target_bot["image_model"],
                "params": target_bot["model_params"],
            }
            perm_snap = {
                "is_manager": False,
                "tool_permissions": sorted(effective_tools),
                "delegation_policy": target_bot["delegation_policy"],
                "canvas_policy": target_bot["canvas_policy"],
            }
            skill_snap = [s["skill_id"] for s in target_bot["skills"] if s.get("enabled")]
            db.execute(
                "INSERT INTO turns("
                "turn_id, session_id, bot_id, trigger_message_id, parent_turn_id, delegation_id, "
                "project_id, canvas_id, idempotency_key, request_signature, status, "
                "model_snapshot_json, permission_snapshot_json, skill_snapshot_json, "
                "steps, result_summary, result_refs_json, error, recovery_required, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    target_turn_id, target_session["session_id"], target_bot_id, delegation_msg["message_id"],
                    parent_turn_id, delegation_id, clean_project, clean_canvas,
                    f"delturn_{delegation_id}", sig, "queued",
                    dump_json(model_snap), dump_json(perm_snap), dump_json(skill_snap),
                    0, "", "[]", "", 0, ts, ts,
                ),
            )
            db.execute(
                "INSERT INTO delegations("
                "delegation_id, parent_bot_id, parent_session_id, parent_turn_id, "
                "target_bot_id, target_session_id, target_turn_id, goal, instructions, "
                "context_refs_json, granted_permissions_json, idempotency_key, request_signature, "
                "status, result_summary, result_refs_json, error, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    delegation_id, parent_bot_id, parent_session_id, parent_turn_id,
                    target_bot_id, target_session["session_id"], target_turn_id,
                    clean_goal, _clean_text(instructions, 8000),
                    dump_json(context_refs or []), dump_json(sorted(effective_tools)),
                    clean_key, sig, "queued", "", "[]", "", ts, ts,
                ),
            )
            self._enqueue_outbox_tx(
                db,
                kind="turn_dispatch",
                target_bot_id=target_bot_id,
                target_session_id=target_session["session_id"],
                target_turn_id=target_turn_id,
                payload={"turn_id": target_turn_id, "delegation_id": delegation_id},
                idempotency_key=f"outbox_del_{delegation_id}",
            )
            del_row = db.execute("SELECT * FROM delegations WHERE delegation_id=?", (delegation_id,)).fetchone()
            trn_row = db.execute("SELECT * FROM turns WHERE turn_id=?", (target_turn_id,)).fetchone()
            delegation = self._delegation_from_row(del_row)
            turn = self._turn_from_row(trn_row)
            self.emit_event_tx(
                db, "delegation_created", bot_id=parent_bot_id, session_id=parent_session_id,
                turn_id=parent_turn_id, project_id=clean_project, canvas_id=clean_canvas,
                payload={"delegation": delegation},
            )
            return delegation, turn, True

    def get_delegation(self, delegation_id: str) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM delegations WHERE delegation_id=?", (delegation_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("delegation_not_found", "未找到委派记录", 404)
            return self._delegation_from_row(row)

    def list_delegations(self, *, parent_bot_id: str = "", target_bot_id: str = "", parent_turn_id: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        params: List[Any] = []
        if parent_bot_id:
            clauses.append("parent_bot_id = ?")
            params.append(parent_bot_id)
        if target_bot_id:
            clauses.append("target_bot_id = ?")
            params.append(target_bot_id)
        if parent_turn_id:
            clauses.append("parent_turn_id = ?")
            params.append(parent_turn_id)
        params.append(max(1, min(200, int(limit or 50))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM delegations WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._delegation_from_row(r) for r in rows]

    def update_delegation(
        self,
        delegation_id: str,
        *,
        status: str,
        result_summary: str = "",
        result_refs: Optional[List[Dict[str, Any]]] = None,
        error: str = "",
    ) -> Dict[str, Any]:
        if status not in DELEGATION_STATUSES:
            raise BotWorkspaceError("invalid_status", "委派状态无效", 422)
        with self.transaction() as db:
            row = db.execute("SELECT * FROM delegations WHERE delegation_id=?", (delegation_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("delegation_not_found", "未找到委派记录", 404)
            ts = now_ms()
            db.execute(
                "UPDATE delegations SET status=?, result_summary=?, result_refs_json=?, error=?, updated_at=? "
                "WHERE delegation_id=?",
                (status, result_summary, dump_json(result_refs or []), error, ts, delegation_id),
            )
            fresh = db.execute("SELECT * FROM delegations WHERE delegation_id=?", (delegation_id,)).fetchone()
            delegation = self._delegation_from_row(fresh)
            if status in ("completed", "failed", "cancelled") and delegation["parent_turn_id"]:
                self._enqueue_outbox_tx(
                    db,
                    kind="delegation_result",
                    target_bot_id=delegation["parent_bot_id"],
                    target_session_id=delegation["parent_session_id"],
                    target_turn_id=delegation["parent_turn_id"],
                    payload={
                        "delegation_id": delegation_id,
                        "status": status,
                        "result_summary": result_summary,
                        "result_refs": result_refs or [],
                        "error": error,
                    },
                    idempotency_key=f"outbox_delres_{delegation_id}_{status}",
                )
            self.emit_event_tx(
                db, "delegation_updated", bot_id=delegation["parent_bot_id"],
                session_id=delegation["parent_session_id"], turn_id=delegation["parent_turn_id"],
                payload={"delegation": delegation},
            )
            return delegation

    # -- Run Links（打通 workspace.sqlite3 与 multi_agent runs.sqlite3）---

    def create_run_link(
        self,
        *,
        bot_id: str,
        session_id: str,
        turn_id: str,
        multi_agent_run_id: str,
        project_id: str,
        canvas_id: str,
        idempotency_key: str,
        delegation_id: str = "",
        status: str = "queued",
    ) -> Tuple[Dict[str, Any], bool]:
        with self.transaction() as db:
            existing = db.execute(
                "SELECT * FROM run_links WHERE idempotency_key=? OR multi_agent_run_id=?",
                (idempotency_key, multi_agent_run_id),
            ).fetchone()
            if existing is not None:
                return self._run_link_from_row(existing), False
            ts = now_ms()
            link_id = new_id("rlk")
            db.execute(
                "INSERT INTO run_links("
                "link_id, bot_id, session_id, turn_id, delegation_id, multi_agent_run_id, "
                "project_id, canvas_id, idempotency_key, status, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    link_id, bot_id, session_id, turn_id, delegation_id, multi_agent_run_id,
                    _clean_scope_id(project_id), _clean_scope_id(canvas_id),
                    _clean_text(idempotency_key, 120), status, ts, ts,
                ),
            )
            row = db.execute("SELECT * FROM run_links WHERE link_id=?", (link_id,)).fetchone()
            link = self._run_link_from_row(row)
            self.emit_event_tx(
                db, "run_linked", bot_id=bot_id, session_id=session_id, turn_id=turn_id,
                project_id=link["project_id"], canvas_id=link["canvas_id"],
                payload={"run_link": link},
            )
            return link, True

    def list_run_links(
        self,
        *,
        bot_id: str = "",
        session_id: str = "",
        turn_id: str = "",
        project_id: str = "",
        canvas_id: str = "",
        active_only: bool = False,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        params: List[Any] = []
        if bot_id:
            clauses.append("bot_id = ?")
            params.append(bot_id)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if turn_id:
            clauses.append("turn_id = ?")
            params.append(turn_id)
        if project_id:
            clauses.append("project_id = ?")
            params.append(_clean_scope_id(project_id))
        if canvas_id:
            clauses.append("canvas_id = ?")
            params.append(_clean_scope_id(canvas_id))
        if active_only:
            clauses.append("status NOT IN ('completed','failed','cancelled')")
        params.append(max(1, min(200, int(limit or 50))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM run_links WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._run_link_from_row(r) for r in rows]

    def update_run_link_status(self, multi_agent_run_id: str, status: str) -> Optional[Dict[str, Any]]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM run_links WHERE multi_agent_run_id=?", (multi_agent_run_id,)).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE run_links SET status=?, updated_at=? WHERE multi_agent_run_id=?",
                (status, now_ms(), multi_agent_run_id),
            )
            fresh = db.execute("SELECT * FROM run_links WHERE multi_agent_run_id=?", (multi_agent_run_id,)).fetchone()
            return self._run_link_from_row(fresh)

    # -- Approvals 审批 ---------------------------------------------------

    def create_approval(
        self,
        *,
        bot_id: str,
        session_id: str,
        turn_id: str,
        tool_name: str,
        args: Dict[str, Any],
        summary: str,
        risk_level: str = "medium",
        multi_agent_run_id: str = "",
        multi_agent_action_id: str = "",
    ) -> Dict[str, Any]:
        assert_no_secrets(args, field_label="审批参数")
        with self.transaction() as db:
            if multi_agent_action_id:
                existing = db.execute(
                    "SELECT * FROM approvals WHERE multi_agent_action_id=?", (multi_agent_action_id,)
                ).fetchone()
                if existing is not None:
                    return self._approval_from_row(existing)
            approval_id = new_id("apr")
            ts = now_ms()
            db.execute(
                "INSERT INTO approvals("
                "approval_id, bot_id, session_id, turn_id, multi_agent_run_id, multi_agent_action_id, "
                "tool_name, args_json, summary, risk_level, status, created_at, resolved_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)",
                (
                    approval_id, bot_id, session_id, turn_id, multi_agent_run_id, multi_agent_action_id,
                    _clean_text(tool_name, 80), dump_json(args or {}), _clean_text(summary, 500),
                    _clean_text(risk_level, 20) or "medium", "pending", ts,
                ),
            )
            row = db.execute("SELECT * FROM approvals WHERE approval_id=?", (approval_id,)).fetchone()
            approval = self._approval_from_row(row)
            self.emit_event_tx(
                db, "approval_requested", bot_id=bot_id, session_id=session_id, turn_id=turn_id,
                payload={"approval": approval},
            )
            return approval

    def get_approval(self, approval_id: str) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM approvals WHERE approval_id=?", (approval_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("approval_not_found", "该审批记录不存在", 404)
            return self._approval_from_row(row)

    def list_approvals(self, *, bot_id: str = "", session_id: str = "", status: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        params: List[Any] = []
        if bot_id:
            clauses.append("bot_id = ?")
            params.append(bot_id)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        params.append(max(1, min(200, int(limit or 50))))
        with self.transaction() as db:
            rows = db.execute(
                f"SELECT * FROM approvals WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._approval_from_row(r) for r in rows]

    def resolve_approval(self, approval_id: str, approved: bool) -> Dict[str, Any]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM approvals WHERE approval_id=?", (approval_id,)).fetchone()
            if row is None:
                raise BotWorkspaceError("approval_not_found", "该审批记录不存在", 404)
            if row["status"] != "pending":
                raise BotWorkspaceError("approval_resolved", "该审批已处理", 409)
            next_status = "approved" if approved else "rejected"
            ts = now_ms()
            db.execute(
                "UPDATE approvals SET status=?, resolved_at=? WHERE approval_id=?",
                (next_status, ts, approval_id),
            )
            fresh = db.execute("SELECT * FROM approvals WHERE approval_id=?", (approval_id,)).fetchone()
            approval = self._approval_from_row(fresh)
            self.emit_event_tx(
                db, "approval_resolved", bot_id=approval["bot_id"], session_id=approval["session_id"],
                turn_id=approval["turn_id"], payload={"approval": approval},
            )
            return approval

    # -- Delivery Outbox --------------------------------------------------

    def _enqueue_outbox_tx(
        self,
        db: sqlite3.Connection,
        *,
        kind: str,
        target_bot_id: str,
        target_session_id: str,
        target_turn_id: str,
        payload: Dict[str, Any],
        idempotency_key: str,
    ) -> str:
        existing = db.execute(
            "SELECT outbox_id FROM delivery_outbox WHERE idempotency_key=?", (idempotency_key,)
        ).fetchone()
        if existing is not None:
            return existing["outbox_id"]
        outbox_id = new_id("obx")
        ts = now_ms()
        db.execute(
            "INSERT INTO delivery_outbox("
            "outbox_id, kind, target_bot_id, target_session_id, target_turn_id, "
            "payload_json, idempotency_key, status, attempts, next_retry_at, last_error, created_at, updated_at"
            ") VALUES(?,?,?,?,?,?,?,?,0,0,'',?,?)",
            (outbox_id, kind, target_bot_id, target_session_id, target_turn_id, dump_json(payload), idempotency_key, "pending", ts, ts),
        )
        return outbox_id

    def list_pending_outbox(self, limit: int = 30) -> List[Dict[str, Any]]:
        now = now_ms()
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM delivery_outbox WHERE status='pending' AND next_retry_at <= ? "
                "ORDER BY created_at ASC LIMIT ?",
                (now, max(1, min(100, int(limit or 30)))),
            ).fetchall()
        return [
            {
                **dict(r),
                "payload": load_json(r["payload_json"], {}),
            }
            for r in rows
        ]

    def mark_outbox(self, outbox_id: str, status: str, *, error: str = "", next_retry_at: int = 0) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE delivery_outbox SET status=?, attempts=attempts+1, last_error=?, next_retry_at=?, updated_at=? "
                "WHERE outbox_id=?",
                (status, _clean_text(error, 500), int(next_retry_at or 0), now_ms(), outbox_id),
            )

    # -- 崩溃恢复 ---------------------------------------------------------

    def recover_after_restart(self) -> Dict[str, int]:
        """重启后把中断在 running 的回合标记为 recovery_required，避免自动重提付费生成。"""
        with self.transaction() as db:
            ts = now_ms()
            interrupted = db.execute(
                "SELECT turn_id, bot_id, session_id, project_id, canvas_id FROM turns WHERE status='running'"
            ).fetchall()
            for row in interrupted:
                db.execute(
                    "UPDATE turns SET status='recovery_required', recovery_required=1, "
                    "error='应用已重启，请核对已提交任务后手动继续（不会自动重新提交付费生成）', updated_at=? "
                    "WHERE turn_id=?",
                    (ts, row["turn_id"]),
                )
                self.emit_event_tx(
                    db, "turn_recovery_required",
                    bot_id=row["bot_id"], session_id=row["session_id"], turn_id=row["turn_id"],
                    project_id=row["project_id"], canvas_id=row["canvas_id"],
                    payload={"turn_id": row["turn_id"], "reason": "server_restart"},
                )
            processing_outbox = db.execute(
                "UPDATE delivery_outbox SET status='pending', updated_at=? WHERE status='processing'",
                (ts,),
            ).rowcount
            pruned_events = self._prune_events_tx(db, keep_last=5000)
            return {
                "interrupted_turns": len(interrupted),
                "reset_outbox": int(processing_outbox),
                "pruned_events": pruned_events,
            }

    @staticmethod
    def _prune_events_tx(db: sqlite3.Connection, *, keep_last: int = 5000) -> int:
        keep = max(200, int(keep_last or 5000))
        row = db.execute("SELECT MAX(seq) FROM workspace_events").fetchone()
        max_seq = int(row[0] or 0) if row else 0
        if max_seq <= keep:
            return 0
        cur = db.execute("DELETE FROM workspace_events WHERE seq <= ?", (max_seq - keep,))
        return int(cur.rowcount or 0)

    def prune_events(self, *, keep_last: int = 5000) -> int:
        with self.transaction() as db:
            return self._prune_events_tx(db, keep_last=keep_last)

    # -- 迁移登记 ---------------------------------------------------------

    def get_migration(self, migration_id: str) -> Optional[Dict[str, Any]]:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM schema_migrations WHERE migration_id=?", (migration_id,)).fetchone()
            if row is None:
                return None
            return {
                "migration_id": row["migration_id"],
                "version": row["version"],
                "status": row["status"],
                "backup_path": row["backup_path"],
                "summary": load_json(row["summary_json"], {}),
                "applied_at": row["applied_at"],
            }

    def record_migration_tx(
        self,
        db: sqlite3.Connection,
        migration_id: str,
        *,
        version: int = 1,
        status: str = "completed",
        backup_path: str = "",
        summary: Optional[Dict[str, Any]] = None,
    ) -> None:
        db.execute(
            "INSERT OR REPLACE INTO schema_migrations(migration_id, version, status, backup_path, summary_json, applied_at) "
            "VALUES(?,?,?,?,?,?)",
            (migration_id, version, status, backup_path, dump_json(summary or {}), now_ms()),
        )
