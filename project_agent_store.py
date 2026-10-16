"""Project-scoped Agent notes and bounded suggestion state."""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

MEMORY_TYPES = {"goal", "product_fact", "constraint", "style_preference", "decision", "todo"}
FREQUENCIES = {"quiet", "standard", "active"}
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
DEFAULT_SETTINGS = {
    "proactive_enabled": True, "paused": False, "frequency": "standard",
    "allow_model_analysis": False, "allow_image_analysis": False,
    "daily_limit": 20, "provider": "", "model": "",
}

class AgentStateError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

class ProjectAgentStore:
    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "project_agent"
        self.lock = threading.RLock()

    def _global_unlocked(self) -> dict:
        file = self.root / "global.json"
        if not file.exists():
            return {"revision": 0, "enabled": True}
        try:
            with file.open("r", encoding="utf-8") as stream:
                value = json.load(stream)
        except (OSError, ValueError) as exc:
            raise AgentStateError("state_unavailable", "主动建议设置暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool) or not isinstance(value.get("revision"), int):
            raise AgentStateError("state_unavailable", "主动建议设置内容无效，请检查本地数据文件", 503)
        return value

    def read_global(self) -> dict:
        with self.lock:
            return deepcopy(self._global_unlocked())

    def set_global(self, enabled: bool, expected_revision: int) -> dict:
        with self.lock:
            value = self._global_unlocked()
            if value["revision"] != expected_revision:
                raise AgentStateError("revision_conflict", "主动建议设置已更新，请刷新后再试", 409)
            value = {"revision": value["revision"] + 1, "enabled": bool(enabled)}
            self._write(self.root / "global.json", value)
            return value

    def _path(self, project_id: str) -> Path:
        if not PROJECT_ID_RE.fullmatch(str(project_id or "")):
            raise AgentStateError("invalid_project_id", "项目编号无效")
        return self.root / project_id / "state.json"

    @staticmethod
    def _empty(project_id: str) -> dict:
        return {
            "version": 1, "project_id": project_id, "revision": 0, "updated_at": "",
            "memories": [], "settings": deepcopy(DEFAULT_SETTINGS), "suggestions": [],
            "activity": [], "analysis": {"date": "", "count": 0, "last_by_canvas": {}, "cache": {}, "event_ids": []},
            "feedback_keys": [],
        }

    def _read_unlocked(self, project_id: str) -> dict:
        file = self._path(project_id)
        if not file.exists():
            return self._empty(project_id)
        try:
            with file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise AgentStateError("state_unavailable", "项目记忆暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or state.get("project_id") != project_id:
            raise AgentStateError("state_unavailable", "项目记忆内容无效，请检查本地数据文件", 503)
        expected = {"revision": int, "memories": list, "settings": dict, "suggestions": list,
                    "activity": list, "analysis": dict, "feedback_keys": list}
        if any(key in state and (not isinstance(state[key], kind) or (key == "revision" and isinstance(state[key], bool)))
               for key, kind in expected.items()):
            raise AgentStateError("state_unavailable", "项目记忆内容无效，请检查本地数据文件", 503)
        for key, value in self._empty(project_id).items():
            state.setdefault(key, value)
        state["settings"] = {**DEFAULT_SETTINGS, **(state.get("settings") or {})}
        return state

    @staticmethod
    def _write(file: Path, state: dict) -> None:
        file.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=file.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def read(self, project_id: str) -> dict:
        with self.lock:
            return deepcopy(self._read_unlocked(project_id))

    def update(self, project_id: str, change, expected_revision: int | None = None) -> dict:
        with self.lock:
            state = self._read_unlocked(project_id)
            if expected_revision is not None and state["revision"] != expected_revision:
                raise AgentStateError("revision_conflict", "项目内容已更新，请刷新后再试", 409)
            change(state)
            state["revision"] += 1
            state["updated_at"] = utc_now()
            state["activity"] = state["activity"][-500:]
            state["suggestions"] = state["suggestions"][-100:]
            state["feedback_keys"] = state["feedback_keys"][-300:]
            self._write(self._path(project_id), state)
            return deepcopy(state)

    def add_memory(self, project_id: str, kind: str, text: str, canvas_id: str = "") -> dict:
        if kind not in MEMORY_TYPES:
            raise AgentStateError("invalid_memory_type", "请选择记忆类型")
        clean = str(text or "").strip()
        if not clean or len(clean) > 500:
            raise AgentStateError("invalid_memory_text", "请填写 1 到 500 字的内容")
        created = {}
        def change(state):
            nonlocal created
            created = {
                "id": uuid.uuid4().hex, "project_id": project_id, "type": kind,
                "text": clean, "status": "confirmed",
                "source": {"type": "user_confirmation", "canvas_id": canvas_id or None},
                "confidence": "high", "created_at": utc_now(), "updated_at": utc_now(), "revision": 1,
            }
            state["memories"].append(created)
            state["suggestions"] = [s for s in state["suggestions"] if s.get("status") != "ready"]
        self.update(project_id, change)
        return created

    def edit_memory(self, project_id: str, memory_id: str, revision: int, text: str | None = None, kind: str | None = None) -> dict:
        if kind is not None and kind not in MEMORY_TYPES:
            raise AgentStateError("invalid_memory_type", "请选择记忆类型")
        if text is not None and (not str(text).strip() or len(str(text).strip()) > 500):
            raise AgentStateError("invalid_memory_text", "请填写 1 到 500 字的内容")
        edited = {}
        def change(state):
            nonlocal edited
            item = next((m for m in state["memories"] if m.get("id") == memory_id), None)
            if not item:
                raise AgentStateError("memory_not_found", "这条项目记忆已不存在", 404)
            if item.get("revision") != revision:
                raise AgentStateError("revision_conflict", "这条记忆已更新，请刷新后再试", 409)
            if text is not None: item["text"] = str(text).strip()
            if kind is not None: item["type"] = kind
            item["revision"] += 1
            item["updated_at"] = utc_now()
            item["source"] = {"type": "user_confirmation", "canvas_id": item.get("source", {}).get("canvas_id")}
            state["suggestions"] = [s for s in state["suggestions"] if s.get("status") != "ready"]
            edited = deepcopy(item)
        self.update(project_id, change)
        return edited

    def delete_memory(self, project_id: str, memory_id: str, revision: int) -> None:
        def change(state):
            item = next((m for m in state["memories"] if m.get("id") == memory_id), None)
            if not item:
                raise AgentStateError("memory_not_found", "这条项目记忆已不存在", 404)
            if item.get("revision") != revision:
                raise AgentStateError("revision_conflict", "这条记忆已更新，请刷新后再试", 409)
            state["memories"] = [m for m in state["memories"] if m.get("id") != memory_id]
            state["suggestions"] = [s for s in state["suggestions"] if s.get("status") != "ready"]
        self.update(project_id, change)

    def reset(self, project_id: str) -> None:
        def change(state):
            state["memories"] = []
            state["suggestions"] = []
            state["activity"] = []
            state["feedback_keys"] = []
            state["analysis"] = {"date": "", "count": 0, "last_by_canvas": {}, "cache": {}}
        self.update(project_id, change)

    def purge(self, project_id: str) -> None:
        with self.lock:
            file = self._path(project_id)
            if file.exists():
                file.unlink()
                try: file.parent.rmdir()
                except OSError: pass
