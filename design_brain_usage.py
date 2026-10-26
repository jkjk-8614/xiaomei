"""设计大脑 · Bot 团队用量记账（P4）。

按天一个文件：``data/design_brain/team/usage/<YYYY-MM-DD>.json``

    {"date":"2026-10-25","chats":{"grp_x":{"llm":12,"tool":3,"image":2,"tokens":8200,
      "bots":{"bot_director":{"llm":10,"tool":3,"image":0,"tokens":7000}}}}}

只记次数与 token，不记内容、不记成本（价格随时会变，记了反而误导）。
每次写入都是原子替换；文件很小（一个会话一天几十条），不需要追加日志。
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from copy import deepcopy
from datetime import date as date_cls, datetime
from pathlib import Path
from typing import Any, Dict, Optional

from design_brain_store import DesignBrainError, now_ms

COUNTERS = ("llm", "tool", "image", "tokens")


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _empty_day(day: str) -> Dict[str, Any]:
    return {"date": day, "updated_at": 0, "chats": {}}


class UsageStore:
    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain" / "team" / "usage"
        self.lock = threading.RLock()

    def _path(self, day: str) -> Path:
        safe = str(day or "").strip()
        if not safe or len(safe) != 10:
            safe = _today()
        return self.root / f"{safe}.json"

    def _read_unlocked(self, day: str) -> Dict[str, Any]:
        path = self._path(day)
        if not path.exists():
            return _empty_day(day)
        try:
            with path.open("r", encoding="utf-8-sig") as stream:
                data = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "用量记录暂时无法读取", 503) from exc
        if not isinstance(data, dict) or not isinstance(data.get("chats"), dict):
            raise DesignBrainError("state_unavailable", "用量记录内容无效", 503)
        data.setdefault("date", day)
        return data

    def _write_unlocked(self, data: Dict[str, Any]) -> None:
        data["updated_at"] = now_ms()
        path = self._path(data["date"])
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".usage-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def record(self, chat_id: str, bot_id: str = "", *, llm: int = 0, tool: int = 0,
               image: int = 0, tokens: int = 0, day: Optional[str] = None) -> Dict[str, Any]:
        if not chat_id:
            return {}
        day_key = day or _today()
        with self.lock:
            data = self._read_unlocked(day_key)
            chat = data["chats"].setdefault(chat_id, {"llm": 0, "tool": 0, "image": 0, "tokens": 0, "bots": {}})
            chat.setdefault("bots", {})
            for key, value in (("llm", llm), ("tool", tool), ("image", image), ("tokens", tokens)):
                if value:
                    chat[key] = int(chat.get(key) or 0) + int(value)
            if bot_id:
                entry = chat["bots"].setdefault(bot_id, {"llm": 0, "tool": 0, "image": 0, "tokens": 0})
                for key, value in (("llm", llm), ("tool", tool), ("image", image), ("tokens", tokens)):
                    if value:
                        entry[key] = int(entry.get(key) or 0) + int(value)
            self._write_unlocked(data)
        return {"chat": deepcopy(chat)}

    def chat_today(self, chat_id: str, day: Optional[str] = None) -> Dict[str, int]:
        data = self.summary(day)
        entry = next((item for item in data["chats"] if item["chat_id"] == chat_id), None)
        return entry["counts"] if entry else {key: 0 for key in COUNTERS}

    def summary(self, day: Optional[str] = None) -> Dict[str, Any]:
        day_key = day or _today()
        with self.lock:
            data = self._read_unlocked(day_key)
        totals = {key: 0 for key in COUNTERS}
        bots: Dict[str, Dict[str, int]] = {}
        chats = []
        for chat_id, entry in data["chats"].items():
            counts = {key: int(entry.get(key) or 0) for key in COUNTERS}
            chats.append({"chat_id": chat_id, "counts": counts})
            for key in COUNTERS:
                totals[key] += counts[key]
            for bot_id, bot_entry in (entry.get("bots") or {}).items():
                bucket = bots.setdefault(bot_id, {key: 0 for key in COUNTERS})
                for key in COUNTERS:
                    bucket[key] += int((bot_entry or {}).get(key) or 0)
        chats.sort(key=lambda item: item["counts"]["llm"] + item["counts"]["image"], reverse=True)
        return {
            "date": day_key,
            "totals": totals,
            "chats": chats,
            "bots": [{"bot_id": bot_id, "counts": counts} for bot_id, counts in
                     sorted(bots.items(), key=lambda item: item[1]["llm"], reverse=True)],
            "updated_at": data.get("updated_at") or 0,
        }

    def clear(self, day: Optional[str] = None) -> None:
        day_key = day or _today()
        with self.lock:
            self._write_unlocked(_empty_day(day_key))


def today_key() -> str:
    return _today()
