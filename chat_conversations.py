"""Read and update local chat transcripts in the existing per-user JSON format."""

from contextlib import contextmanager
import json
from pathlib import Path
import re
from threading import Lock
from time import time_ns
from uuid import uuid4

from fastapi import HTTPException


_OWNER = re.compile(r"[A-Za-z0-9_.-]{1,80}")
_CONVERSATION = re.compile(r"[A-Za-z0-9_-]+")
_NEW_TITLE = "新对话"


def user_key(header, client_host):
    hint = (header or "").strip() or (f"ip-{client_host}" if client_host is not None else "")
    key = "".join(char if char.isascii() and (char.isalnum() or char in "_.-") else "-" for char in hint)
    return key[:80].strip(".-") or "anonymous"


def _clock():
    return time_ns() // 1_000_000


def _number(value):
    try:
        return int(value or 0)
    except (ValueError, TypeError, OverflowError):
        return 0


def _matches_retry(previous, message, mode):
    if not isinstance(previous, dict) or previous.get("role") != "user":
        return False
    previous_mode = str(previous.get("mode") or "").strip()
    return (
        (not previous_mode or not mode or previous_mode == mode)
        and str(previous.get("content") or "").strip() == message["content"].strip()
    )


def prompt_message(text, mode, references, context, created_at, *, link_image_limit, skill, merchant=False):
    message = dict(
        id=uuid4().hex, role="user", content=text, created_at=created_at,
        attachments=references, mode=mode,
    )
    jobs = context.get("job_ids") or []
    resources = context.get("resource_ids") or []
    if merchant:
        message.update(link_job_ids=jobs, link_resource_ids=resources, merchant_agent=True)
    elif context.get("context_text") or jobs:
        links = (
            str(item.get("original_url") or item.get("final_url") or "").strip()
            for item in context.get("links") or ()
        )
        source = (context.get("page_context") or {}).get("source")
        message.update(
            link_job_ids=jobs, link_resource_ids=resources, link_urls=[url for url in links if url],
            link_context=context.get("context_text") or "", link_images=(context.get("images") or [])[:link_image_limit],
            link_page_context_source=str(source or "").strip(),
        )
    if skill:
        message.update(skill_id=skill["id"], skill_name=skill["name"])
    return message


class ConversationStore:
    def __init__(self, root, write_json):
        self._root = root
        self._write_json = write_json
        self._lock = Lock()
        self._active_drafts = set()

    def _directory(self, user):
        if not _OWNER.fullmatch(user) or user in {".", ".."} or Path(user).is_reserved():
            raise HTTPException(status_code=400, detail="无效的用户标识")
        folder = Path(self._root()).resolve() / user
        if folder.resolve() != folder:
            raise HTTPException(status_code=400, detail="无效的对话目录")
        return folder

    def _path(self, user, conversation_id):
        key = str(conversation_id or "")
        if not _CONVERSATION.fullmatch(key) or Path(key).is_reserved():
            raise HTTPException(status_code=400, detail="无效的对话 ID")
        path = self._directory(user) / f"{key}.json"
        if path.resolve() != path:
            raise HTTPException(status_code=400, detail="无效的对话文件")
        return path

    def _read(self, path):
        try:
            with path.open(encoding="utf-8-sig") as handle:
                record = json.load(handle)
            if not isinstance(record, dict):
                raise ValueError("Expected a conversation object")
            if record.get("messages") is None:
                record["messages"] = []
            if not isinstance(record["messages"], list):
                raise ValueError("Expected a list of messages")
            return record
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="对话不存在") from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=500, detail="无法读取对话记录") from exc

    def _write(self, path, record):
        try:
            self._write_json(path, record)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="无法保存对话，请重试") from exc

    def create(self, user, title):
        stamp = _clock()
        record = {
            "id": uuid4().hex, "title": (title or _NEW_TITLE)[:80],
            "created_at": stamp, "updated_at": stamp, "messages": [],
        }
        with self._lock:
            self._write(self._path(user, record["id"]), record)
        return record

    def load(self, user, conversation_id):
        return self._read(self._path(user, conversation_id))

    def delete(self, user, conversation_id):
        with self._lock:
            self._path(user, conversation_id).unlink(missing_ok=True)

    def list(self, user):
        summaries = []
        for file in self._directory(user).glob("*.json"):
            try:
                record = self.load(user, file.stem)
            except HTTPException:
                continue
            last = next(
                (item for item in reversed(record["messages"]) if isinstance(item, dict) and item.get("role") != "system"),
                {},
            )
            summaries.append({
                "id": record.get("id"),
                "title": record.get("title", _NEW_TITLE),
                "created_at": record.get("created_at", 0),
                "updated_at": record.get("updated_at", 0),
                "last_message": last.get("content", ""),
            })
        return sorted(summaries, key=lambda entry: _number(entry["updated_at"]), reverse=True)

    def append_prompt(self, user, conversation_id, message, title, *, retry_mode=None):
        with self._lock:
            path = self._path(user, conversation_id)
            record = self._read(path)
            messages = record["messages"]
            if retry_mode is not None and messages and _matches_retry(messages[-1], message, retry_mode.strip()):
                messages.pop()
            if not messages:
                record["title"] = title
            messages.append(message)
            record["updated_at"] = max(_number(record.get("updated_at")), _clock())
            self._write(path, record)
        return record

    def append_reply(self, user, conversation_id, prompt_id, message):
        with self._lock:
            path = self._path(user, conversation_id)
            record = self._read(path)
            messages = record["messages"]
            prompt_index = next(
                (index for index, item in enumerate(messages)
                 if isinstance(item, dict) and item.get("role") == "user" and item.get("id") == prompt_id),
                None,
            )
            if prompt_index is None:
                raise HTTPException(status_code=409, detail="原消息已变更，请重新发送")
            draft_id = message.get("generation_draft_id")
            if draft_id:
                draft = next(
                    (item for item in messages if isinstance(item, dict) and item.get("type") == "image_draft"
                     and item.get("id") == draft_id),
                    None,
                )
                if draft is None:
                    raise HTTPException(status_code=404, detail="待确认的生图文案不存在或已被清理，请重新整理")
                draft.update(draft_status="generated", confirmed_prompt=message["content"], confirmed_at=_clock())
            messages.insert(prompt_index + 1, message)
            record["updated_at"] = max(_number(record.get("updated_at")), _clock())
            self._write(path, record)
        return record

    @contextmanager
    def confirm_draft(self, user, conversation_id, draft_id):
        if not draft_id:
            yield
            return
        claim = (self._path(user, conversation_id), draft_id)
        with self._lock:
            if claim in self._active_drafts:
                raise HTTPException(status_code=409, detail="这份文案正在生图，请等待生成完成")
            self._active_drafts.add(claim)
        try:
            yield
        finally:
            with self._lock:
                self._active_drafts.remove(claim)
