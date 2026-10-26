"""Resolve design-team Skills through the application's installed Skill store."""
from __future__ import annotations

import re
from typing import Any, Dict


def _terms(text: str) -> set[str]:
    text = str(text or "").casefold()
    words = set(re.findall(r"[a-z0-9][a-z0-9_-]{2,}", text))
    for phrase in re.findall(r"[\u4e00-\u9fff]+", text):
        words.update(phrase[i:i + 2] for i in range(len(phrase) - 1))
    return words - {"设计", "技能", "用户", "使用", "生成", "需要", "一个", "图片", "可以", "输出", "任务", "要求"}


def select_skill(host: Any, text: str, explicit_id: str = "") -> Dict[str, Any]:
    """Select one enabled Skill; validate explicit choices with the canonical store."""
    if explicit_id:
        record, _ = host.resolve_canvas_skill_request(explicit_id)
        return _summary(record, "手动选择")
    listing = getattr(host, "list_agent_skill_records", None)
    if not callable(listing):
        return {}
    terms = _terms(text)
    if not terms:
        return {}
    candidates = []
    for record in listing():
        if record.get("enabled") is False or record.get("lifecycle") == "draft":
            continue
        names = _terms(f"{record.get('display_name', '')} {record.get('name', '')}")
        hits = terms & _terms(str(record.get("description") or ""))
        name_hits = terms & names
        if name_hits or len(hits) >= 2:
            candidates.append((len(name_hits) * 4 + len(hits), str(record.get("id") or ""), record))
    if not candidates:
        return {}
    _, _, record = max(candidates, key=lambda item: (item[0], item[1]))
    return _summary(record, "名称或说明与当前需求匹配")


def _summary(record: Dict[str, Any], reason: str) -> Dict[str, Any]:
    if not record:
        return {}
    return {"skill_id": str(record.get("id") or ""),
            "name": str(record.get("display_name") or record.get("name") or record.get("id") or ""),
            "version": str(record.get("version") or ""), "selection_reason": reason}
