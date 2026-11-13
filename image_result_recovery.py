"""Keep provider result snapshots available for local recovery."""

from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4


def append(path, lock, *, provider, model, payload, task_id=""):
    now = datetime.now().astimezone()
    identifier = f"img-{now:%Y%m%d-%H%M%S}-{uuid4().hex[:8]}"
    entry = {
        "id": identifier,
        "created_at": now.astimezone(timezone.utc).isoformat(),
        "provider_id": str(provider or ""),
        "model": str(model or ""),
        "task_id": str(task_id or ""),
        "raw": payload,
    }
    journal = Path(path)
    line = json.dumps(entry, ensure_ascii=False, default=str)
    with lock:
        journal.parent.mkdir(parents=True, exist_ok=True)
        with journal.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(line + "\n")
    return identifier


def find(path, lock, identifier):
    key = str(identifier or "").strip()
    if not key:
        return None
    match = None
    with lock:
        try:
            stream = Path(path).open("rb")
        except FileNotFoundError:
            return None
        with stream:
            for line in stream:
                try:
                    entry = json.loads(line)
                except (ValueError, RecursionError):
                    continue
                if isinstance(entry, dict) and str(entry.get("id") or "") == key:
                    match = entry
    return match


def result_payload(entry):
    raw = entry.get("raw")
    if isinstance(raw, dict) and "submission" in raw and "task_result" in raw:
        return raw["task_result"], True
    return raw, False
