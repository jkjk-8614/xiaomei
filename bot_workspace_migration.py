"""旧版设计大脑团队数据（data/design_brain/team/）的非破坏性幂等迁移器。

规则：
1. 迁移前先对旧数据目录创建完整备份（data/backups/）。
2. 严禁修改或删除 data/design_brain/team/、审美档案、参考素材或 Skill 原文件。
3. 首次安装（无旧 bots.json）只初始化唯一默认总管理 Bot（bot_manager），绝不创建旧版五个专业 Bot。
4. 旧版默认五个 Bot（bot_director/bot_reference/bot_planner/bot_executor/bot_reviewer）：
   - bot_director 的历史私聊与记忆安全关联到 bot_manager（并在 bot_manager 尚未配置模型时继承其自定义模型）；
   - 其余 4 个旧默认 Bot 以 archived（legacy_default=1）导入，不在新用户默认活跃列表强制展示，但保留其配置、历史会话、消息和记忆，用户随时可恢复。
5. 用户自建的专业 Bot 完整迁移为永久 Bot（保持其原活跃/归档状态，强制 is_manager=False 并收敛工具权限）。
6. 旧群聊历史完整保留为 bot_manager 下的 legacy_group 历史会话。
7. 全程在单事务内执行，基于 legacy_source_id / legacy_chat_id / idempotency_key 严格幂等；任意失败回滚事务且旧系统完全不受影响。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from bot_workspace_config import MANAGER_BOT_ID, normalize_data_dir
from bot_workspace_store import (
    BotWorkspaceStore,
    SPECIALIST_DEFAULT_TOOLS,
    SPECIALIST_MAX_TOOLS,
    contains_secret_text,
    dump_json,
    new_id,
    normalize_avatar,
    normalize_canvas_policy,
    normalize_delegation_policy,
    normalize_model_ref,
    now_ms,
    sanitize_tool_permissions,
)
from scripts.backup_bot_workspace_data import backup_user_data

MIGRATION_ID = "legacy_design_brain_team_v1"
LEGACY_DEFAULT_BOT_IDS = frozenset({
    "bot_director",
    "bot_reference",
    "bot_planner",
    "bot_executor",
    "bot_reviewer",
})

# 旧能力包 → 新工具权限映射（普通 Bot 永远不映射总管理写权限）
LEGACY_PACK_TO_TOOLS: Dict[str, List[str]] = {
    "pack.read": ["design.profile.read", "design.references.search", "canvas.read", "canvas.list_assets"],
    "pack.plan": ["design.references.analyze", "design.plan.compose"],
    "pack.execute": ["canvas.dispatch_run", "canvas.command", "canvas.query_generation"],
    "pack.review": ["design.review.check", "canvas.inspect_result", "canvas.check_product", "canvas.check_geometry"],
    "pack.workflow": ["design.batch.canvas_plan"],
    "pack.memory": ["memory.read", "memory.remember", "memory.recall"],
}

_MEMORY_LINE_RE = re.compile(
    r"^-\s+(?P<text>.*?)(?:\s*\[source:\s*(?P<source>[^\];]*);\s*added:\s*(?P<added>[^\]]*)\])?\s*$"
)


def _read_json_file(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    return data if isinstance(data, dict) else None


def _read_memory_lines(path: Path) -> List[Dict[str, str]]:
    if not path.is_file():
        return []
    entries: List[Dict[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw_line.strip()
        match = _MEMORY_LINE_RE.match(line)
        if not match:
            continue
        text = " ".join(match.group("text").split()).strip()
        if not text or contains_secret_text(text):
            continue
        source = (match.group("source") or "旧版迁移").strip()[:40]
        entries.append({"text": text[:400], "source": source or "旧版迁移"})
    return entries


def _read_jsonl_messages(chat_dir: Path) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    archive_dir = chat_dir / "archive"
    files: List[Path] = []
    if archive_dir.is_dir():
        files.extend(sorted(archive_dir.glob("messages-*.jsonl")))
    live = chat_dir / "messages.jsonl"
    if live.is_file():
        files.append(live)
    for file_path in files:
        for line in file_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                item = json.loads(stripped)
            except ValueError:
                continue
            if isinstance(item, dict):
                messages.append(item)
    return messages


def _legacy_capabilities_to_tools(capabilities: Any) -> List[str]:
    tools = list(SPECIALIST_DEFAULT_TOOLS)
    for pack in (capabilities if isinstance(capabilities, list) else []):
        for tool in LEGACY_PACK_TO_TOOLS.get(str(pack), ()):
            if tool not in tools:
                tools.append(tool)
    return sanitize_tool_permissions(tools, is_manager=False, allowed_ceiling=SPECIALIST_MAX_TOOLS, strict=False)


def migrate_legacy_design_team(
    data_dir: str | Path | None,
    store: BotWorkspaceStore,
    *,
    create_backup: bool = True,
) -> Dict[str, Any]:
    """幂等执行旧版设计大脑团队迁移，始终先确保唯一 bot_manager 存在。"""
    root = normalize_data_dir(data_dir)
    store.ensure_manager_bot()

    legacy_team_dir = root / "design_brain" / "team"
    bots_file = legacy_team_dir / "bots.json"
    if not bots_file.is_file():
        return {
            "status": "fresh_install",
            "migrated": False,
            "backup_path": "",
            "bots_imported": 0,
            "sessions_imported": 0,
            "messages_imported": 0,
            "memories_imported": 0,
        }

    backup_path = ""
    if create_backup:
        existing_record = store.get_migration(MIGRATION_ID)
        if not existing_record or not existing_record.get("backup_path"):
            manifest = backup_user_data(root, label="pre_migration")
            backup_path = str(manifest.get("backup_dir") or "")
        else:
            backup_path = str(existing_record.get("backup_path") or "")

    bots_payload = _read_json_file(bots_file)
    if bots_payload is None or not isinstance(bots_payload.get("bots"), list):
        raise ValueError("旧版 bots.json 结构无效，已中止迁移并保持旧系统可用")

    legacy_bots = [item for item in bots_payload["bots"] if isinstance(item, dict) and item.get("id")]
    groups_payload = _read_json_file(legacy_team_dir / "groups.json") or {"groups": []}
    legacy_groups = {
        str(g.get("id")): g
        for g in (groups_payload.get("groups") if isinstance(groups_payload.get("groups"), list) else [])
        if isinstance(g, dict) and g.get("id")
    }
    bot_names = {str(b.get("id")): str(b.get("name") or b.get("id")) for b in legacy_bots}

    stats = {
        "bots_imported": 0,
        "custom_bots_active": 0,
        "legacy_defaults_archived": 0,
        "sessions_imported": 0,
        "messages_imported": 0,
        "memories_imported": 0,
    }

    with store.transaction() as db:
        id_map: Dict[str, str] = {"bot_director": MANAGER_BOT_ID}

        # 1. 迁移 Bot 档案
        for raw in legacy_bots:
            legacy_id = str(raw.get("id") or "").strip()
            if not legacy_id:
                continue
            if legacy_id == "bot_director":
                # 若 bot_manager 尚未设置模型且旧总监设置了自定义模型，则无损继承
                mgr = db.execute("SELECT * FROM bots WHERE bot_id=?", (MANAGER_BOT_ID,)).fetchone()
                chat_m = normalize_model_ref(raw.get("model"))
                vision_m = normalize_model_ref(raw.get("vision_model"))
                image_m = normalize_model_ref(raw.get("image_model"))
                if mgr and not mgr["chat_provider_id"] and chat_m["provider_id"] and chat_m["model"]:
                    db.execute(
                        "UPDATE bots SET chat_provider_id=?, chat_model=?, updated_at=? WHERE bot_id=?",
                        (chat_m["provider_id"], chat_m["model"], now_ms(), MANAGER_BOT_ID),
                    )
                if mgr and not mgr["vision_provider_id"] and vision_m["provider_id"] and vision_m["model"]:
                    db.execute(
                        "UPDATE bots SET vision_provider_id=?, vision_model=?, updated_at=? WHERE bot_id=?",
                        (vision_m["provider_id"], vision_m["model"], now_ms(), MANAGER_BOT_ID),
                    )
                if mgr and not mgr["image_provider_id"] and image_m["provider_id"] and image_m["model"]:
                    db.execute(
                        "UPDATE bots SET image_provider_id=?, image_model=?, updated_at=? WHERE bot_id=?",
                        (image_m["provider_id"], image_m["model"], now_ms(), MANAGER_BOT_ID),
                    )
                continue

            existing_bot = db.execute(
                "SELECT bot_id FROM bots WHERE legacy_source_id=?", (legacy_id,)
            ).fetchone()
            if existing_bot is not None:
                id_map[legacy_id] = existing_bot["bot_id"]
                continue

            is_legacy_default = legacy_id in LEGACY_DEFAULT_BOT_IDS
            target_status = "archived" if is_legacy_default else (
                "archived" if str(raw.get("status") or "").lower() == "archived" else "active"
            )
            name = str(raw.get("name") or legacy_id).strip()[:48] or legacy_id
            # 若目标活跃且重名，追加温和后缀避免冲突
            if target_status == "active" and db.execute(
                "SELECT 1 FROM bots WHERE name=? AND status='active'", (name,)
            ).fetchone():
                name = f"{name[:40]}（迁移）"

            instructions = str(raw.get("instructions") or "").strip()[:12000]
            task_note = str(raw.get("task") or "").strip()[:4000]
            if task_note and task_note not in instructions:
                instructions = (instructions + "\n\n任务要求：" + task_note).strip()[:12000]
            if contains_secret_text(instructions):
                instructions = "[已过滤疑似敏感内容的旧指令]"

            personality = str(raw.get("personality") or "").strip()[:2000]
            if contains_secret_text(personality):
                personality = ""

            chat_m = normalize_model_ref(raw.get("model"))
            vision_m = normalize_model_ref(raw.get("vision_model"))
            image_m = normalize_model_ref(raw.get("image_model"))
            tools = _legacy_capabilities_to_tools(raw.get("capabilities"))
            delegation_policy = normalize_delegation_policy({"allow_delegate": False}, is_manager=False)
            canvas_policy = normalize_canvas_policy(
                {"allow_canvas_read": True, "allow_canvas_writes": "canvas.dispatch_run" in tools},
                is_manager=False,
            )
            try:
                avatar = normalize_avatar(raw.get("avatar"), fallback_text=name[:1] or "助")
            except Exception:
                avatar = normalize_avatar({}, fallback_text=name[:1] or "助")

            new_bot_id = legacy_id if not db.execute("SELECT 1 FROM bots WHERE bot_id=?", (legacy_id,)).fetchone() else new_id("bot")
            ts = int(raw.get("created_at") or now_ms())
            updated = int(raw.get("updated_at") or ts)
            db.execute(
                "INSERT INTO bots("
                "bot_id, name, avatar_json, role, system_instructions, personality, is_manager, status, "
                "chat_provider_id, chat_model, vision_provider_id, vision_model, image_provider_id, image_model, "
                "model_params_json, tool_permissions_json, permission_ceiling_json, delegation_policy_json, "
                "canvas_policy_json, created_by, legacy_source_id, legacy_default, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    new_bot_id, name, dump_json(avatar), str(raw.get("role") or "")[:200],
                    instructions, personality, 0, target_status,
                    chat_m["provider_id"], chat_m["model"],
                    vision_m["provider_id"], vision_m["model"],
                    image_m["provider_id"], image_m["model"],
                    dump_json({"auto_match_skills": True}),
                    dump_json(tools), dump_json(sorted(SPECIALIST_MAX_TOOLS)),
                    dump_json(delegation_policy), dump_json(canvas_policy),
                    "legacy_migration", legacy_id, 1 if is_legacy_default else 0, ts, updated,
                ),
            )
            id_map[legacy_id] = new_bot_id
            stats["bots_imported"] += 1
            if is_legacy_default:
                stats["legacy_defaults_archived"] += 1
            elif target_status == "active":
                stats["custom_bots_active"] += 1

        # 2. 迁移会话与消息（仅迁移真实有消息的会话或自定义 Bot 的会话）
        chats_root = legacy_team_dir / "chats"
        if chats_root.is_dir():
            for chat_dir in sorted(chats_root.iterdir()):
                if not chat_dir.is_dir():
                    continue
                chat_meta = _read_json_file(chat_dir / "chat.json") or {}
                legacy_chat_id = str(chat_meta.get("id") or chat_dir.name).strip()
                if not legacy_chat_id:
                    continue
                messages = _read_jsonl_messages(chat_dir)
                kind = str(chat_meta.get("kind") or ("group" if legacy_chat_id.startswith("grp_") else "dm")).lower()
                if kind == "dm":
                    legacy_bot_id = str(chat_meta.get("bot_id") or legacy_chat_id.removeprefix("dm_")).strip()
                    owner_bot_id = id_map.get(legacy_bot_id, MANAGER_BOT_ID)
                    # 旧默认 4 Bot 的空私聊无需导入噪音会话
                    if legacy_bot_id in (LEGACY_DEFAULT_BOT_IDS - {"bot_director"}) and not messages:
                        continue
                    title = str(chat_meta.get("title") or bot_names.get(legacy_bot_id) or "历史私聊")
                    if legacy_bot_id == "bot_director":
                        title = f"历史私聊 · {title}"
                    sess_kind = "chat"
                    archived_flag = False
                else:
                    if not messages and legacy_chat_id not in legacy_groups:
                        continue
                    owner_bot_id = MANAGER_BOT_ID
                    group_info = legacy_groups.get(legacy_chat_id) or {}
                    title = f"历史群聊 · {group_info.get('name') or chat_meta.get('title') or legacy_chat_id}"
                    sess_kind = "legacy_group"
                    archived_flag = bool(group_info.get("archived", False))

                existing_sess = db.execute(
                    "SELECT session_id FROM sessions WHERE legacy_chat_id=?", (legacy_chat_id,)
                ).fetchone()
                if existing_sess is not None:
                    target_session_id = existing_sess["session_id"]
                else:
                    created_sess = store._create_session_tx(
                        db,
                        owner_bot_id,
                        title=title[:80],
                        kind=sess_kind,
                        archived=archived_flag,
                        legacy_chat_id=legacy_chat_id,
                        meta={"migrated_from": "design_brain_team", "legacy_chat_id": legacy_chat_id},
                    )
                    target_session_id = created_sess["session_id"]
                    stats["sessions_imported"] += 1

                for idx, raw_msg in enumerate(messages):
                    msg_legacy_id = str(raw_msg.get("id") or f"seq_{raw_msg.get('seq') or idx + 1}")
                    idem_key = f"legacy:{legacy_chat_id}:{msg_legacy_id}"
                    if db.execute(
                        "SELECT 1 FROM messages WHERE session_id=? AND idempotency_key=?",
                        (target_session_id, idem_key),
                    ).fetchone():
                        continue
                    text = str(raw_msg.get("text") or "")
                    if contains_secret_text(text):
                        text = "[已过滤包含疑似敏感凭据的旧消息]"
                    raw_role = str(raw_msg.get("role") or "user").lower()
                    role = raw_role if raw_role in ("user", "bot", "system") else "system"
                    raw_kind = str(raw_msg.get("kind") or "text").lower()
                    msg_kind = raw_kind if raw_kind in ("text", "approval", "result", "activity") else "text"
                    sender_legacy_bot = str(raw_msg.get("bot_id") or "")
                    sender_meta = dict(raw_msg.get("meta") if isinstance(raw_msg.get("meta"), dict) else {})
                    if sender_legacy_bot:
                        sender_meta["legacy_bot_id"] = sender_legacy_bot
                        sender_meta["legacy_bot_name"] = bot_names.get(sender_legacy_bot, sender_legacy_bot)
                    if raw_msg.get("task_id"):
                        sender_meta["legacy_task_id"] = str(raw_msg.get("task_id"))
                    # 清理任何潜在敏感键
                    for bad_key in list(sender_meta.keys()):
                        if str(bad_key).lower() in {"api_key", "secret", "password", "authorization", "token"}:
                            sender_meta.pop(bad_key, None)
                    store._append_message_tx(
                        db,
                        target_session_id,
                        bot_id=owner_bot_id,
                        role=role,
                        kind=msg_kind,
                        content=text,
                        meta=sender_meta,
                        idempotency_key=idem_key,
                        created_at=int(raw_msg.get("at") or now_ms()),
                    )
                    stats["messages_imported"] += 1

        # 3. 迁移记忆（bots/*/MEMORY.md、groups/*/MEMORY.md、team/MEMORY.md）
        memory_root = legacy_team_dir / "memory"
        if memory_root.is_dir():
            bots_mem_dir = memory_root / "bots"
            if bots_mem_dir.is_dir():
                for bot_dir in sorted(bots_mem_dir.iterdir()):
                    if not bot_dir.is_dir():
                        continue
                    target_bot_id = id_map.get(bot_dir.name, MANAGER_BOT_ID)
                    for entry in _read_memory_lines(bot_dir / "MEMORY.md"):
                        _, added = _insert_memory_tx(db, target_bot_id, "bot", entry["text"], entry["source"])
                        if added:
                            stats["memories_imported"] += 1
            team_mem = memory_root / "team" / "MEMORY.md"
            for entry in _read_memory_lines(team_mem):
                _, added = _insert_memory_tx(db, MANAGER_BOT_ID, "shared", entry["text"], entry["source"])
                if added:
                    stats["memories_imported"] += 1
            groups_mem_dir = memory_root / "groups"
            if groups_mem_dir.is_dir():
                for grp_dir in sorted(groups_mem_dir.iterdir()):
                    if not grp_dir.is_dir():
                        continue
                    for entry in _read_memory_lines(grp_dir / "MEMORY.md"):
                        _, added = _insert_memory_tx(
                            db, MANAGER_BOT_ID, "shared", f"[历史群记忆] {entry['text']}"[:400], entry["source"]
                        )
                        if added:
                            stats["memories_imported"] += 1

        store.record_migration_tx(
            db,
            MIGRATION_ID,
            version=1,
            status="completed",
            backup_path=backup_path,
            summary=stats,
        )

    return {
        "status": "completed",
        "migrated": True,
        "backup_path": backup_path,
        **stats,
    }


def _insert_memory_tx(db, bot_id: str, scope: str, text: str, source: str):
    import hashlib
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    existing = db.execute(
        "SELECT memory_id FROM bot_memories WHERE bot_id=? AND scope=? AND project_id='' AND content_hash=? AND status='active'",
        (bot_id, scope, content_hash),
    ).fetchone()
    if existing is not None:
        return existing["memory_id"], False
    mem_id = new_id("mem")
    ts = now_ms()
    db.execute(
        "INSERT INTO bot_memories(memory_id, bot_id, scope, project_id, content, source, status, content_hash, created_at, updated_at) "
        "VALUES(?,?,?,'',?,?,'active',?,?,?)",
        (mem_id, bot_id, scope, text, source[:60], content_hash, ts, ts),
    )
    return mem_id, True
