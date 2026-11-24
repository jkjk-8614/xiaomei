"""小美 Bot 工作区配置、功能开关与安全路径解析（仅依赖标准库）。

统一管理：
- 功能开关（环境变量 `XIAOMEI_BOT_WORKSPACE_ENABLED` > `data/bot_workspace/feature_flags.json` > 默认开启）
- 旧版设计大脑 5-Bot 自动 seed 守卫（新模式下禁止自动种出五个默认专业 Bot）
- 工作区 SQLite、备份目录与回退状态文件路径
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional

from runtime_paths import resolve_roots

FEATURE_FLAG_ENV = "XIAOMEI_BOT_WORKSPACE_ENABLED"
DEFAULT_BOT_WORKSPACE_ENABLED = True
MANAGER_BOT_ID = "bot_manager"

_TRUTHY = {"1", "true", "yes", "on", "enabled"}
_FALSY = {"0", "false", "no", "off", "disabled"}


def default_data_dir() -> Path:
    base = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
    _, runtime_root = resolve_roots(base)
    return (runtime_root / "data").resolve()


def normalize_data_dir(data_dir: str | Path | None = None) -> Path:
    if data_dir is None or str(data_dir).strip() == "":
        return default_data_dir()
    return Path(data_dir).resolve()


def bot_workspace_dir(data_dir: str | Path | None = None) -> Path:
    return normalize_data_dir(data_dir) / "bot_workspace"


def bot_workspace_db_path(data_dir: str | Path | None = None) -> Path:
    return bot_workspace_dir(data_dir) / "workspace.sqlite3"


def feature_flags_path(data_dir: str | Path | None = None) -> Path:
    return bot_workspace_dir(data_dir) / "feature_flags.json"


def backup_root_dir(data_dir: str | Path | None = None) -> Path:
    return normalize_data_dir(data_dir) / "backups"


def _parse_bool_env(raw: Optional[str]) -> Optional[bool]:
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if text in _TRUTHY:
        return True
    if text in _FALSY:
        return False
    return None


def read_feature_flags(data_dir: str | Path | None = None) -> Dict[str, Any]:
    path = feature_flags_path(data_dir)
    file_enabled: Optional[bool] = None
    updated_at = 0
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
            if isinstance(payload, dict):
                if isinstance(payload.get("enabled"), bool):
                    file_enabled = payload["enabled"]
                updated_at = int(payload.get("updated_at") or 0)
        except (OSError, ValueError, TypeError):
            file_enabled = None

    env_override = _parse_bool_env(os.environ.get(FEATURE_FLAG_ENV))
    if env_override is not None:
        effective = env_override
        source = "env"
    elif file_enabled is not None:
        effective = file_enabled
        source = "file"
    else:
        effective = DEFAULT_BOT_WORKSPACE_ENABLED
        source = "default"

    return {
        "enabled": effective,
        "source": source,
        "env_locked": env_override is not None,
        "file_enabled": file_enabled,
        "updated_at": updated_at,
        "manager_bot_id": MANAGER_BOT_ID,
    }


def is_bot_workspace_enabled(data_dir: str | Path | None = None) -> bool:
    return bool(read_feature_flags(data_dir).get("enabled", DEFAULT_BOT_WORKSPACE_ENABLED))


def write_feature_flags(data_dir: str | Path | None, enabled: bool) -> Dict[str, Any]:
    path = feature_flags_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "version": 1,
        "enabled": bool(enabled),
        "updated_at": int(time.time() * 1000),
    }
    fd, tmp_path = tempfile.mkstemp(prefix=".feature-flags-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return read_feature_flags(data_dir)


def should_seed_legacy_design_team(data_dir: str | Path | None = None) -> bool:
    """新 Bot 工作区启用时，禁止自动初始化旧版 5 个默认设计大脑 Bot。"""
    return not is_bot_workspace_enabled(data_dir)
