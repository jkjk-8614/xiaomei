"""Personal design brain profile store and prompt-case reference helpers.

个人设计大脑阶段 1 的本地存储。档案保存在运行数据根目录的
``data/design_brain/profile.json``，使用与 ``project_agent_store.py`` 相同的
revision 乐观并发 + 临时文件原子写约定；坏文件显式报错，绝不静默覆盖。

本模块只依赖标准库：单测环境没有 fastapi，无法导入 main.py，所以案例
引用模式的字段归一化也放在这里，由 main.py 调用。
"""
from __future__ import annotations
from design_brain_decisions import normalize_design

from design_brain_visual_rules import (SKU_RULES, VisualRuleError, apply_visual_plan,
                                       normalize_layout, normalize_values, is_sku, sku_series_mode)

import json
import os
import re
import tempfile
import threading
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

PROFILE_VERSION = 1
TAG_LIST_MAX = 40
TAG_TEXT_MAX = 40
ORIGIN_TEXT_MAX = 80
WORD_LIST_MAX = 40
WORD_TEXT_MAX = 40
ANALYSIS_FIELDS = ("style", "color", "composition", "lighting", "mood", "notes")
ANALYSIS_TEXT_MAX = 200
PROFILE_LINK_MAX = 30
PROFILE_LINK_TAG_MAX = 40
CASE_ORIGIN_TYPES = {"user_saved", "history_pick", "canvas_save", "image_space", "inspiration_import"}
CASE_ORIGIN_TEXT_MAX = 160
SUGGESTION_LIST_MAX = 100

# 与 asset_registry.ASSET_ID_RE 保持一致；这里不导入 asset_registry，避免单测
# 环境被迫安装 fastapi。若那边调整格式，需同步修改。
ASSET_REF_RE = re.compile(r"^asset_[A-Za-z0-9_-]{6,80}$")

AESTHETIC_GROUPS = ("style_tags", "color_preferences", "composition", "lighting", "mood")


class DesignBrainError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def now_ms() -> int:
    return int(time.time() * 1000)


def _replace_runtime_record(temporary, target) -> None:
    # Windows 的索引/扫描程序可能短暂持有目标文件，拒绝原子替换。
    for attempt in range(7):
        try:
            os.replace(temporary, target)
            return
        except PermissionError:
            if attempt == 6:
                raise
            time.sleep(.01 * (2 ** attempt))


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:limit]


def normalize_weight(value: Any) -> float:
    try:
        weight = float(value)
    except (TypeError, ValueError):
        weight = 0.6
    return round(min(1.0, max(0.05, weight)), 2)


def normalize_tag_entry(raw: Any) -> Optional[Dict[str, Any]]:
    if isinstance(raw, str):
        raw = {"tag": raw}
    if not isinstance(raw, dict):
        return None
    tag = _clean_text(raw.get("tag"), TAG_TEXT_MAX)
    if not tag:
        return None
    return {
        "tag": tag,
        "weight": normalize_weight(raw.get("weight")),
        "origin": _clean_text(raw.get("origin") or "user", ORIGIN_TEXT_MAX) or "user",
    }


def _normalize_tag_list(raw: Any) -> List[Dict[str, Any]]:
    values = raw if isinstance(raw, list) else []
    normalized: List[Dict[str, Any]] = []
    seen = set()
    for item in values[:TAG_LIST_MAX]:
        entry = normalize_tag_entry(item)
        if not entry or entry["tag"] in seen:
            continue
        seen.add(entry["tag"])
        normalized.append(entry)
    return normalized


def _normalize_word_list(raw: Any) -> List[str]:
    values = raw if isinstance(raw, list) else []
    normalized: List[str] = []
    seen = set()
    for item in values[:WORD_LIST_MAX]:
        text = _clean_text(item, WORD_TEXT_MAX)
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def _normalize_ratio(value: Any) -> str:
    text = _clean_text(value, 16)
    return text if re.fullmatch(r"\d{1,2}[:：]\d{1,2}|auto", text) else ""


def _clamp_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, number))


def _normalize_task_defaults(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    main_image = source.get("main_image") if isinstance(source.get("main_image"), dict) else {}
    detail_page = source.get("detail_page") if isinstance(source.get("detail_page"), dict) else {}
    return {
        "main_image": {"preferred_ratio": _normalize_ratio(main_image.get("preferred_ratio")) or "1:1",
                       "quality": _clean_text(main_image.get("quality"), 24) or "high"},
        "detail_page": {"segments": _clamp_int(detail_page.get("segments"), 1, 24, 8)},
    }


def normalize_profile(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    aesthetics_raw = source.get("aesthetics") if isinstance(source.get("aesthetics"), dict) else {}
    avoid = aesthetics_raw.get("avoid_tags")
    avoid_entries = []
    seen_avoid = set()
    for item in (avoid if isinstance(avoid, list) else [])[:TAG_LIST_MAX]:
        entry = normalize_tag_entry(item)
        if not entry or entry["tag"] in seen_avoid:
            continue
        seen_avoid.add(entry["tag"])
        # 避免项没有权重语义，保留 tag/origin 即可。
        entry.pop("weight", None)
        avoid_entries.append(entry)
    aesthetics = {group: _normalize_tag_list(aesthetics_raw.get(group)) for group in AESTHETIC_GROUPS}
    aesthetics["avoid_tags"] = avoid_entries
    tone_raw = source.get("tone") if isinstance(source.get("tone"), dict) else {}
    privacy_raw = source.get("privacy") if isinstance(source.get("privacy"), dict) else {}
    suggestions_raw = source.get("pending_suggestions") if isinstance(source.get("pending_suggestions"), list) else []
    return {
        "version": PROFILE_VERSION,
        "aesthetics": aesthetics,
        "tone": {
            "brand_words": _normalize_word_list(tone_raw.get("brand_words")),
            "banned_words": _normalize_word_list(tone_raw.get("banned_words")),
        },
        "task_defaults": _normalize_task_defaults(source.get("task_defaults")),
        "privacy": {
            # 默认关闭：只有用户明确允许后，档案摘要才可能随阶段 2 的
            # 云端分析请求离开本机。allow_reference_analysis 控制「AI 设计
            # 分析」是否允许把参考图发送给用户选择的对话模型，同样默认关闭。
            "allow_cloud_analysis": bool(privacy_raw.get("allow_cloud_analysis")),
            "allow_reference_analysis": bool(privacy_raw.get("allow_reference_analysis")),
        },
        "pending_suggestions": [item for item in suggestions_raw[:SUGGESTION_LIST_MAX] if isinstance(item, dict)],
    }


class DesignProfileStore:
    """个人审美档案的读写与并发控制。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "profile.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"revision": 0, "updated_at": "", "profile": normalize_profile({})}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "设计大脑档案暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("revision"), int) or isinstance(state.get("revision"), bool):
            raise DesignBrainError("state_unavailable", "设计大脑档案内容无效，请检查本地数据文件", 503)
        state.setdefault("updated_at", "")
        state["profile"] = normalize_profile(state.get("profile"))
        return state

    def read(self) -> Dict[str, Any]:
        with self.lock:
            return deepcopy(self._read_unlocked())

    def update(self, profile: Any, expected_revision: Optional[int] = None) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            if expected_revision is not None and state["revision"] != expected_revision:
                raise DesignBrainError("revision_conflict", "设计大脑档案已在其他窗口更新，请刷新后再试", 409)
            state["profile"] = normalize_profile(profile)
            state["revision"] = int(state["revision"]) + 1
            state["updated_at"] = now_ms()
            self._write(state)
            return deepcopy(state)

    def _write(self, state: Dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".profile-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


# ---------------------------------------------------------------------------
# 提示词案例「引用模式」的纯函数：main.py 的归一化与引用扫描调用这里，
# 保证没有 fastapi 的测试环境也能覆盖这些规则。
# ---------------------------------------------------------------------------

def normalize_media_asset_ref(value: Any) -> str:
    text = str(value or "").strip()
    return text if ASSET_REF_RE.fullmatch(text) else ""


def normalize_case_analysis(raw: Any) -> Dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    return {field: _clean_text(source.get(field), ANALYSIS_TEXT_MAX) for field in ANALYSIS_FIELDS}


def normalize_case_profile_links(raw: Any) -> List[Dict[str, Any]]:
    values = raw if isinstance(raw, list) else []
    normalized: List[Dict[str, Any]] = []
    seen = set()
    for item in values[:PROFILE_LINK_MAX]:
        if isinstance(item, str):
            item = {"tag": item}
        if not isinstance(item, dict):
            continue
        tag = _clean_text(item.get("tag"), PROFILE_LINK_TAG_MAX)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append({"tag": tag, "weight": normalize_weight(item.get("weight"))})
    return normalized


def normalize_case_origin(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    origin_type = str(source.get("type") or "").strip()
    if origin_type not in CASE_ORIGIN_TYPES:
        origin_type = ""
    try:
        history_timestamp = float(source.get("history_timestamp") or 0)
    except (TypeError, ValueError):
        history_timestamp = 0.0
    return {
        "type": origin_type or "user_saved",
        "history_timestamp": history_timestamp if history_timestamp > 0 else 0.0,
        "canvas_id": _clean_text(source.get("canvas_id"), CASE_ORIGIN_TEXT_MAX),
        "node_id": _clean_text(source.get("node_id"), CASE_ORIGIN_TEXT_MAX),
        "inspiration_case_id": _clean_text(source.get("inspiration_case_id"), CASE_ORIGIN_TEXT_MAX),
    }


def prompt_case_reference_entries(case: Any) -> List[Tuple[str, str, str]]:
    """引用型案例里指向媒体的 (字段, url, asset_ref_id) 列表，按 url 去重。

    复制型案例自带媒体副本，不引用图片空间原文件，返回空列表；引用扫描
    只把这里的 URL 当作「原文件仍在使用」的证据。
    """
    if not isinstance(case, dict) or case.get("media_mode") != "refs":
        return []
    entries: List[Tuple[str, str, str]] = []
    seen = set()
    for field in ("cover", "variants", "references"):
        raw = case.get(field)
        items = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
        for media in items:
            if not isinstance(media, dict):
                continue
            url = str(media.get("url") or media.get("source_url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            entries.append((field, url, normalize_media_asset_ref(media.get("asset_ref_id"))))
    return entries


def prompt_case_reference_urls(case: Any) -> List[str]:
    return [url for _field, url, _ref_id in prompt_case_reference_entries(case)]


# ---------------------------------------------------------------------------
# 阶段 2：项目经验（候选 / 待审核 / 已发布 / 已拒绝）与 Skill 版本关联。
# 状态机在存储层强制：只有用户显式动作才能推进状态，未审核经验永远
# 不会触碰审美档案或任何已安装 Skill。
# ---------------------------------------------------------------------------

EXPERIENCE_STATUSES = ("candidate", "pending_review", "published", "rejected")
EXPERIENCE_TRANSITIONS = {
    "submit": ("candidate", "pending_review"),
    "publish": ("pending_review", "published"),
    "reject": ("pending_review", "rejected"),
    "requeue": ("rejected", "candidate"),
}
EXPERIENCE_LIST_MAX = 500
EXPERIENCE_TITLE_MAX = 80
OBSERVATION_TEXT_MAX = 500
OBSERVATION_MAX = 20
EXPERIENCE_TEXT_FIELD_MAX = 160
PROFILE_PATCH_MAX = 20
SKILL_VERSIONS_MAX = 20
SKILL_CONTENT_MAX = 200 * 1024
SKILL_NOTE_MAX = 200
PROFILE_PATCH_GROUPS = frozenset(AESTHETIC_GROUPS) | {"avoid_tags"}


def normalize_experience_observations(raw: Any) -> List[str]:
    values = raw if isinstance(raw, list) else []
    normalized = []
    seen = set()
    for item in values[:OBSERVATION_MAX]:
        text = re.sub(r"\s+", " ", str(item or "").strip())[:OBSERVATION_TEXT_MAX]
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def normalize_profile_patch(raw: Any) -> List[Dict[str, Any]]:
    values = raw if isinstance(raw, list) else []
    normalized = []
    seen = set()
    for item in values[:PROFILE_PATCH_MAX]:
        if isinstance(item, str):
            item = {"group": "style_tags", "tag": item}
        if not isinstance(item, dict):
            continue
        group = str(item.get("group") or "style_tags").strip() or "style_tags"
        if group not in PROFILE_PATCH_GROUPS:
            group = "style_tags"
        tag = _clean_text(item.get("tag"), TAG_TEXT_MAX)
        if not tag or (group, tag) in seen:
            continue
        seen.add((group, tag))
        entry = {"group": group, "tag": tag}
        if group != "avoid_tags":
            entry["weight"] = normalize_weight(item.get("weight"))
        normalized.append(entry)
    return normalized


def _normalize_experience_evidence(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    timestamps = []
    for value in (source.get("history_timestamps") if isinstance(source.get("history_timestamps"), list) else [])[:60]:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0 and number not in timestamps:
            timestamps.append(number)
    asset_refs = []
    seen_urls = set()
    for item in (source.get("asset_refs") if isinstance(source.get("asset_refs"), list) else [])[:48]:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        entry = {"url": url}
        ref_id = normalize_media_asset_ref(item.get("asset_ref_id"))
        if ref_id:
            entry["asset_ref_id"] = ref_id
        asset_refs.append(entry)
    canvas_ids = []
    for value in (source.get("canvas_ids") if isinstance(source.get("canvas_ids"), list) else [])[:20]:
        text = _clean_text(value, EXPERIENCE_TEXT_FIELD_MAX)
        if text and text not in canvas_ids:
            canvas_ids.append(text)
    return {"history_timestamps": timestamps, "asset_refs": asset_refs, "canvas_ids": canvas_ids}


def _normalize_experience_origin(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    origin_type = str(source.get("type") or "").strip()
    if origin_type not in {"manual", "history_distill", "task_feedback", "skill_review"}:
        origin_type = "manual"
    return {
        "type": origin_type,
        "note": _clean_text(source.get("note"), EXPERIENCE_TEXT_FIELD_MAX),
    }


def _experience_int(value: Any, default: int = 0) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return default


def normalize_experience(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    status = str(item.get("status") or "candidate").strip()
    if status not in EXPERIENCE_STATUSES:
        status = "candidate"
    review = item.get("review") if isinstance(item.get("review"), dict) else {}
    publish = item.get("publish") if isinstance(item.get("publish"), dict) else {}
    proposals = item.get("proposals") if isinstance(item.get("proposals"), dict) else {}
    distill = item.get("distill_meta") if isinstance(item.get("distill_meta"), dict) else {}
    impact = item.get("impact") if isinstance(item.get("impact"), dict) else {}
    try:
        created_at = int(item.get("created_at") or now_ms())
    except (TypeError, ValueError):
        created_at = now_ms()
    try:
        updated_at = int(item.get("updated_at") or created_at)
    except (TypeError, ValueError):
        updated_at = created_at
    return {
        "id": re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or f"exp_{uuid.uuid4().hex[:12]}"))[:60],
        "title": _clean_text(item.get("title"), EXPERIENCE_TITLE_MAX) or "未命名经验",
        "status": status,
        "project_id": _clean_text(item.get("project_id"), EXPERIENCE_TEXT_FIELD_MAX),
        "origin": _normalize_experience_origin(item.get("origin")),
        "observations": normalize_experience_observations(item.get("observations")),
        "evidence": _normalize_experience_evidence(item.get("evidence")),
        "proposals": {
            "profile_patch": normalize_profile_patch(proposals.get("profile_patch")),
            "skill": proposals.get("skill") if isinstance(proposals.get("skill"), dict) else None,
        },
        "review": {
            "requested_at": int(review.get("requested_at") or 0),
            "decided_at": int(review.get("decided_at") or 0),
            "comment": _clean_text(review.get("comment"), 500),
        },
        "publish": {
            "published_at": int(publish.get("published_at") or 0),
            "applied_profile_tags": [
                {"group": tag.get("group"), "tag": tag.get("tag")}
                for tag in (publish.get("applied_profile_tags") if isinstance(publish.get("applied_profile_tags"), list) else [])[:PROFILE_PATCH_MAX]
                if isinstance(tag, dict) and tag.get("tag")
            ],
            "skill_id": _clean_text(publish.get("skill_id"), 120),
        },
        "distill_meta": {
            "provider": _clean_text(distill.get("provider"), 120),
            "model": _clean_text(distill.get("model"), 160),
            "at": int(distill.get("at") or 0),
        },
        "impact": {
            "uses": max(0, _experience_int(impact.get("uses"))),
            "positive": max(0, _experience_int(impact.get("positive"))),
            "negative": max(0, _experience_int(impact.get("negative"))),
            "last_rating": max(0, min(5, _experience_int(impact.get("last_rating")))),
            "last_used_at": _experience_int(impact.get("last_used_at")),
            "task_ids": [_clean_text(value, 60) for value in (impact.get("task_ids") if isinstance(impact.get("task_ids"), list) else [])[:20] if _clean_text(value, 60)],
        },
        "created_at": created_at,
        "updated_at": updated_at,
    }


class ExperienceStore:
    """项目经验的 JSON 存储：原子写 + 状态机强制 + 数量上限。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "experiences.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "revision": 0, "updated_at": 0, "experiences": []}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "项目经验暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("experiences"), list):
            raise DesignBrainError("state_unavailable", "项目经验内容无效，请检查本地数据文件", 503)
        state.setdefault("version", 1)
        state.setdefault("revision", 0)
        state["experiences"] = [normalize_experience(item) for item in state["experiences"][:EXPERIENCE_LIST_MAX]]
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["revision"] = int(state.get("revision") or 0) + 1
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".experiences-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list(self, status: str = "") -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_unlocked()
        items = state["experiences"]
        if status in EXPERIENCE_STATUSES:
            items = [item for item in items if item["status"] == status]
        return deepcopy(items)

    def search_published(self, query: str, limit: int = 6) -> List[Dict[str, Any]]:
        """Recall published experience by simple local terms; no model call or cloud data."""
        raw_terms = [part.casefold() for part in re.findall(r"[\w\u3400-\u9fff]{2,}", str(query or ""))]
        terms = list(raw_terms)
        for part in raw_terms:
            if re.fullmatch(r"[\u3400-\u9fff]+", part):
                terms.extend(part[index:index + 2] for index in range(max(0, len(part) - 1)))
        with self.lock:
            items = self._read_unlocked()["experiences"]
        ranked = []
        for item in items:
            if item.get("status") != "published":
                continue
            haystack = " ".join([item.get("title", ""), item.get("project_id", ""),
                                 item.get("origin", {}).get("note", ""), *item.get("observations", [])]).casefold()
            score = sum(1 for term in terms if term in haystack)
            if score:
                ranked.append((score, item))
        ranked.sort(key=lambda pair: (pair[0], pair[1].get("updated_at", 0)), reverse=True)
        return deepcopy([item for _, item in ranked[:max(1, min(20, int(limit or 6)))]])

    def record_impact(self, experience_id: str, *, task_id: str = "", rating: int = 0) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            impact = item.setdefault("impact", {"uses": 0, "positive": 0, "negative": 0, "last_rating": 0, "last_used_at": 0, "task_ids": []})
            impact["uses"] = int(impact.get("uses") or 0) + 1
            if rating >= 4:
                impact["positive"] = int(impact.get("positive") or 0) + 1
            elif rating and rating <= 2:
                impact["negative"] = int(impact.get("negative") or 0) + 1
            impact["last_rating"] = max(0, min(5, int(rating or 0)))
            impact["last_used_at"] = now_ms()
            if task_id and task_id not in impact.setdefault("task_ids", []):
                impact["task_ids"] = (impact["task_ids"] + [task_id])[-20:]
            item["updated_at"] = now_ms()
            self._write(state)
            return deepcopy(item)

    def get(self, experience_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
        if not item:
            raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
        return deepcopy(item)

    def create(self, payload: Any) -> Dict[str, Any]:
        item = normalize_experience({**(payload if isinstance(payload, dict) else {}), "status": "candidate"})
        if not item["observations"]:
            raise DesignBrainError("invalid_experience", "请至少填写一条经验观察", 400)
        with self.lock:
            state = self._read_unlocked()
            if any(entry["id"] == item["id"] for entry in state["experiences"]):
                raise DesignBrainError("invalid_experience", "经验记录编号重复，请重试", 409)
            state["experiences"] = [item] + state["experiences"]
            state["experiences"] = state["experiences"][:EXPERIENCE_LIST_MAX]
            self._write(state)
        return deepcopy(item)

    def update(self, experience_id: str, patch: Any) -> Dict[str, Any]:
        source = patch if isinstance(patch, dict) else {}
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            if item["status"] in {"published", "pending_review"}:
                raise DesignBrainError(
                    "experience_locked",
                    "已发布或待审核的经验不可编辑；拒绝后可恢复为候选再修改",
                    409,
                )
            merged = {**item, **{key: value for key, value in source.items() if key not in {"id", "status", "created_at", "publish", "review"}}}
            merged["updated_at"] = now_ms()
            item.clear()
            item.update(normalize_experience(merged))
            if not item["observations"]:
                raise DesignBrainError("invalid_experience", "请至少填写一条经验观察", 400)
            self._write(state)
        return deepcopy(item)

    def change_status(self, experience_id: str, action: str, comment: str = "") -> Dict[str, Any]:
        transition = EXPERIENCE_TRANSITIONS.get(str(action or ""))
        if not transition:
            raise DesignBrainError("invalid_transition", "未知的状态操作", 400)
        expected, target = transition
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            if item["status"] != expected:
                raise DesignBrainError(
                    "invalid_transition",
                    f"当前状态（{EXPERIENCE_STATUS_LABELS[item['status']]}）不允许该操作",
                    409,
                )
            item["status"] = target
            item["updated_at"] = now_ms()
            if action == "submit":
                item["review"]["requested_at"] = now_ms()
            elif action == "reject":
                item["review"]["decided_at"] = now_ms()
                item["review"]["comment"] = _clean_text(comment, 500)
            elif action == "publish":
                item["review"]["decided_at"] = now_ms()
                item["publish"]["published_at"] = now_ms()
            elif action == "requeue":
                item["review"]["decided_at"] = 0
            self._write(state)
        return deepcopy(item)

    def mark_published_effects(self, experience_id: str, applied_tags: List[Dict[str, Any]]) -> Dict[str, Any]:
        """发布成功后补记实际生效的档案标签，保证可追溯。"""
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            item["publish"]["applied_profile_tags"] = [
                {"group": tag.get("group"), "tag": tag.get("tag")}
                for tag in (applied_tags or [])[:PROFILE_PATCH_MAX]
                if isinstance(tag, dict) and tag.get("tag")
            ]
            item["publish"]["published_at"] = item["publish"]["published_at"] or now_ms()
            self._write(state)
        return deepcopy(item)

    def attach_skill(self, experience_id: str, skill_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            item["proposals"]["skill"] = {"skill_id": skill_id}
            item["publish"]["skill_id"] = skill_id
            item["updated_at"] = now_ms()
            self._write(state)
        return deepcopy(item)

    def delete(self, experience_id: str) -> None:
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["experiences"] if entry["id"] == experience_id), None)
            if not item:
                raise DesignBrainError("experience_not_found", "该经验记录不存在", 404)
            if item["status"] in {"published", "pending_review"}:
                raise DesignBrainError("experience_locked", "已发布或待审核的经验不可删除", 409)
            state["experiences"] = [entry for entry in state["experiences"] if entry["id"] != experience_id]
            self._write(state)

    def clear(self) -> None:
        """显式清空全部经验（仅个人数据删除入口调用）。"""
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "experiences": []})


EXPERIENCE_STATUS_LABELS = {
    "candidate": "候选",
    "pending_review": "待审核",
    "published": "已发布",
    "rejected": "已拒绝",
}


def experience_reference_entries(experience: Any) -> List[Tuple[str, str, str]]:
    """经验证据里指向本地媒体的 (字段, url, asset_ref_id) 列表，供引用扫描。"""
    if not isinstance(experience, dict):
        return []
    evidence = experience.get("evidence") if isinstance(experience.get("evidence"), dict) else {}
    entries: List[Tuple[str, str, str]] = []
    seen = set()
    for item in evidence.get("asset_refs") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        entries.append(("evidence", url, normalize_media_asset_ref(item.get("asset_ref_id"))))
    return entries


def _skill_content_digest(content: str) -> str:
    import hashlib
    return "sha256:" + hashlib.sha256(str(content or "").encode("utf-8")).hexdigest()


class SkillLinkStore:
    """设计大脑 Skill 的生命周期与版本快照（物理文件在 agent_skills 包目录）。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "skill_links.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "updated_at": 0, "skills": {}}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "Skill 版本记录暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("skills"), dict):
            raise DesignBrainError("state_unavailable", "Skill 版本记录内容无效，请检查本地数据文件", 503)
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".skill-links-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _normalize_entry(raw: Any) -> Dict[str, Any]:
        item = raw if isinstance(raw, dict) else {}
        versions = []
        for version in (item.get("versions") if isinstance(item.get("versions"), list) else [])[-SKILL_VERSIONS_MAX:]:
            if not isinstance(version, dict):
                continue
            content = str(version.get("content") or "")[:SKILL_CONTENT_MAX]
            if not content:
                continue
            versions.append({
                "version": max(1, int(version.get("version") or 1)),
                "sha256": str(version.get("sha256") or "") or _skill_content_digest(content),
                "created_at": int(version.get("created_at") or 0),
                "note": _clean_text(version.get("note"), SKILL_NOTE_MAX),
                "content": content,
            })
        current = 0
        for version in versions:
            current = max(current, version["version"])
        return {
            "experience_id": _clean_text(item.get("experience_id"), 60),
            "lifecycle": "published" if item.get("lifecycle") == "published" else "draft",
            "created_at": int(item.get("created_at") or 0),
            "current_version": current,
            "versions": versions,
        }

    def list(self) -> Dict[str, Dict[str, Any]]:
        with self.lock:
            state = self._read_unlocked()
        return {skill_id: self._normalize_entry(entry) for skill_id, entry in state["skills"].items()}

    def clear(self) -> None:
        """显式清空版本记录（仅个人数据删除入口调用；不删物理 Skill 包）。"""
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "skills": {}})

    def get(self, skill_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        entry = state["skills"].get(str(skill_id or ""))
        if not isinstance(entry, dict):
            raise DesignBrainError("skill_link_not_found", "该 Skill 不是设计大脑管理的 Skill", 404)
        return deepcopy(self._normalize_entry(entry))

    def is_draft(self, skill_id: str) -> bool:
        """草稿判定用于“未发布 Skill 不可启用”闸门。

        版本记录文件损坏时抛出 state_unavailable（fail-closed），
        由调用方决定是否放行；找不到该 Skill 则不是草稿。
        """
        with self.lock:
            state = self._read_unlocked()
        entry = self._normalize_entry(state["skills"].get(_clean_text(skill_id, 120)))
        return bool(entry["versions"]) and entry["lifecycle"] == "draft"

    def link(self, skill_id: str, experience_id: str, content: str, note: str = "从经验生成") -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            entry = {
                "experience_id": _clean_text(experience_id, 60),
                "lifecycle": "draft",
                "created_at": now_ms(),
                "versions": [{
                    "version": 1,
                    "sha256": _skill_content_digest(content),
                    "created_at": now_ms(),
                    "note": _clean_text(note, SKILL_NOTE_MAX),
                    "content": str(content or "")[:SKILL_CONTENT_MAX],
                }],
            }
            state["skills"][_clean_text(skill_id, 120)] = entry
            self._write(state)
        return deepcopy(self._normalize_entry(entry))

    def snapshot(self, skill_id: str, content: str, note: str = "") -> Dict[str, Any]:
        """追加一个版本快照并把 current_version 指向它。"""
        with self.lock:
            state = self._read_unlocked()
            key = _clean_text(skill_id, 120)
            entry = self._normalize_entry(state["skills"].get(key))
            if key not in state["skills"]:
                raise DesignBrainError("skill_link_not_found", "该 Skill 不是设计大脑管理的 Skill", 404)
            content = str(content or "")[:SKILL_CONTENT_MAX]
            if not content.strip():
                raise DesignBrainError("invalid_skill_content", "Skill 内容不能为空", 400)
            next_version = entry["current_version"] + 1
            entry["versions"].append({
                "version": next_version,
                "sha256": _skill_content_digest(content),
                "created_at": now_ms(),
                "note": _clean_text(note, SKILL_NOTE_MAX),
                "content": content,
            })
            entry["versions"] = entry["versions"][-SKILL_VERSIONS_MAX:]
            entry["current_version"] = next_version
            state["skills"][key] = entry
            self._write(state)
        return deepcopy(entry)

    def set_lifecycle(self, skill_id: str, lifecycle: str) -> Dict[str, Any]:
        if lifecycle not in ("draft", "published"):
            raise DesignBrainError("invalid_lifecycle", "未知的生命周期状态", 400)
        with self.lock:
            state = self._read_unlocked()
            key = _clean_text(skill_id, 120)
            if key not in state["skills"]:
                raise DesignBrainError("skill_link_not_found", "该 Skill 不是设计大脑管理的 Skill", 404)
            entry = self._normalize_entry(state["skills"][key])
            entry["lifecycle"] = lifecycle
            state["skills"][key] = entry
            self._write(state)
        return deepcopy(entry)


# ---------------------------------------------------------------------------
# 阶段 4：生成结果质量评价（QualityReview）与纯函数分析。
# 评价在创建时固化生成条件（模型、参考图摘要、提示词摘要、Skill 版本），
# 对照测试的可比性判定只依赖这些固化字段；系统只能基于低分评价生成
# 「候选经验」建议，永远不直接改动已发布 Skill。
# ---------------------------------------------------------------------------

REVIEW_LIST_MAX = 500
REVIEW_COMMENT_MAX = 500
REVIEW_ISSUE_TAGS = ("composition", "color", "text", "subject", "texture", "background", "other")
ISSUE_TAG_LABELS = {
    "composition": "构图", "color": "色彩", "text": "文字", "subject": "主体",
    "texture": "质感", "background": "背景", "other": "其他",
}


def _digest_text(value: Any) -> str:
    import hashlib
    return "sha256:" + hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:16]


def normalize_design_review(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    feedback = item.get("user_feedback") if isinstance(item.get("user_feedback"), dict) else {}
    target = item.get("target") if isinstance(item.get("target"), dict) else {}
    context = item.get("context") if isinstance(item.get("context"), dict) else {}
    checks = item.get("auto_checks") if isinstance(item.get("auto_checks"), dict) else {}
    issue = str(item.get("issue_tag") or "").strip()
    if issue not in REVIEW_ISSUE_TAGS:
        issue = ""
    try:
        rating = int(feedback.get("rating") or 0)
    except (TypeError, ValueError):
        rating = 0
    rating = min(5, max(1, rating)) if rating else 0
    try:
        history_timestamp = float(target.get("history_timestamp") or 0)
    except (TypeError, ValueError):
        history_timestamp = 0.0
    try:
        created_at = int(item.get("created_at") or now_ms())
    except (TypeError, ValueError):
        created_at = now_ms()
    return {
        "id": re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or f"rev_{uuid.uuid4().hex[:12]}"))[:60],
        "created_at": created_at,
        "target": {
            "url": _run_text(target.get("url"), 500),
            "asset_ref_id": normalize_media_asset_ref(target.get("asset_ref_id")),
            "history_timestamp": history_timestamp if history_timestamp > 0 else 0.0,
            "run_id": _run_text(target.get("run_id"), 60),
            "canvas_id": _run_text(target.get("canvas_id"), 80),
        },
        "context": {
            "skill_id": _run_text(context.get("skill_id"), 120),
            "skill_name": _run_text(context.get("skill_name"), 120),
            "skill_version": _run_text(context.get("skill_version"), 40),
            "model": _run_text(context.get("model"), 160),
            "provider_id": _run_text(context.get("provider_id"), 120),
            "size": _run_text(context.get("size"), 40),
            "quality": _run_text(context.get("quality"), 40),
            "reference_digest": _run_text(context.get("reference_digest"), 80),
            "reference_count": max(0, int(context.get("reference_count") or 0)) if str(context.get("reference_count") or "0").lstrip("-").isdigit() else 0,
            "prompt_digest": _run_text(context.get("prompt_digest"), 80),
        },
        "user_feedback": {
            "rating": rating,
            "comment": _run_text(feedback.get("comment"), REVIEW_COMMENT_MAX),
            "selected_as_final": bool(feedback.get("selected_as_final")),
        },
        "issue_tag": issue,
        "auto_checks": {
            "file_ok": bool(checks.get("file_ok")),
            "width": max(0, int(checks.get("width") or 0)) if str(checks.get("width") or "0").lstrip("-").isdigit() else 0,
            "height": max(0, int(checks.get("height") or 0)) if str(checks.get("height") or "0").lstrip("-").isdigit() else 0,
            "min_edge_ok": bool(checks.get("min_edge_ok")),
            "note": _run_text(checks.get("note"), 200),
        },
    }


class ReviewStore:
    """质量评价的 JSON 存储：只增、可删，评分不可篡改历史。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "reviews.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "updated_at": 0, "reviews": []}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "质量评价暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("reviews"), list):
            raise DesignBrainError("state_unavailable", "质量评价内容无效，请检查本地数据文件", 503)
        state["reviews"] = [normalize_design_review(item) for item in state["reviews"][:REVIEW_LIST_MAX]]
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".reviews-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list(self, skill_id: str = "", run_id: str = "", limit: int = 100) -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_unlocked()
        reviews = state["reviews"]
        if skill_id:
            reviews = [item for item in reviews if item["context"]["skill_id"] == skill_id]
        if run_id:
            reviews = [item for item in reviews if item["target"]["run_id"] == run_id]
        return deepcopy(reviews[:max(1, min(REVIEW_LIST_MAX, int(limit or 100)))])

    def get(self, review_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        item = next((entry for entry in state["reviews"] if entry["id"] == review_id), None)
        if not item:
            raise DesignBrainError("review_not_found", "该质量评价不存在", 404)
        return deepcopy(item)

    def create(self, payload: Any) -> Dict[str, Any]:
        item = normalize_design_review(payload)
        if not item["target"]["url"] and not item["target"]["history_timestamp"]:
            raise DesignBrainError("invalid_review", "评价必须关联一张图片或一条历史记录", 400)
        if not item["user_feedback"]["rating"]:
            raise DesignBrainError("invalid_review", "请先给出 1-5 星评分", 400)
        with self.lock:
            state = self._read_unlocked()
            # 同一张图的最新评价保留，重复评价旧记录仍留档；按创建时间倒序。
            state["reviews"] = [item] + state["reviews"]
            state["reviews"] = state["reviews"][:REVIEW_LIST_MAX]
            self._write(state)
        return deepcopy(item)

    def delete(self, review_id: str) -> None:
        with self.lock:
            state = self._read_unlocked()
            if not any(entry["id"] == review_id for entry in state["reviews"]):
                raise DesignBrainError("review_not_found", "该质量评价不存在", 404)
            state["reviews"] = [entry for entry in state["reviews"] if entry["id"] != review_id]
            self._write(state)

    def clear(self) -> None:
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "reviews": []})


def review_comparability(left: Dict[str, Any], right: Dict[str, Any]) -> Dict[str, Any]:
    """判定两条评价的结果是否具备「同条件换 Skill 版本」的可比性。

    只有模型、平台、参考图摘要、尺寸、质量等生成条件完全一致，且是
    同一个 Skill 时才可比；任何差异都会列出，防止把不可比的结果当成改进。
    """
    differences = []
    a = (left or {}).get("context") or {}
    b = (right or {}).get("context") or {}
    for field in ("skill_id", "model", "provider_id", "reference_digest", "size", "quality"):
        value_a, value_b = str(a.get(field) or ""), str(b.get(field) or "")
        if value_a != value_b:
            differences.append(field)
    same_skill = str(a.get("skill_id") or "") and str(a.get("skill_id") or "") == str(b.get("skill_id") or "")
    return {
        "comparable": not differences,
        "same_skill": bool(same_skill),
        "differences": differences,
        "left": {"id": (left or {}).get("id"), "skill_version": a.get("skill_version"), "rating": ((left or {}).get("user_feedback") or {}).get("rating")},
        "right": {"id": (right or {}).get("id"), "skill_version": b.get("skill_version"), "rating": ((right or {}).get("user_feedback") or {}).get("rating")},
    }


def compute_skill_review_stats(reviews: List[Dict[str, Any]]) -> Dict[str, Any]:
    """聚合一个 Skill 的评价：总体均分、按版本分布与最近低分 streak。"""
    ordered = sorted(
        [item for item in (reviews or []) if isinstance(item, dict)],
        key=lambda item: int(item.get("created_at") or 0),
    )
    ratings = [int((item.get("user_feedback") or {}).get("rating") or 0) for item in ordered]
    ratings = [value for value in ratings if value]
    by_version: Dict[str, Dict[str, Any]] = {}
    for item in ordered:
        version = str((item.get("context") or {}).get("skill_version") or "未知版本")
        entry = by_version.setdefault(version, {"version": version, "count": 0, "total": 0})
        rating = int((item.get("user_feedback") or {}).get("rating") or 0)
        if rating:
            entry["count"] += 1
            entry["total"] += rating
    for entry in by_version.values():
        entry["average"] = round(entry["total"] / entry["count"], 2) if entry["count"] else 0
    recent = [int((item.get("user_feedback") or {}).get("rating") or 0) for item in ordered[-3:]]
    return {
        "count": len(ratings),
        "average": round(sum(ratings) / len(ratings), 2) if ratings else 0,
        "by_version": list(by_version.values()),
        "last_three_all_low": len(recent) == 3 and all(value and value <= 2 for value in recent),
        "low_count": sum(1 for value in ratings if value <= 2),
    }


def skill_improvement_suggestion(skill: Dict[str, Any], reviews: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """连续低分时给出「经验升级建议」；只是数据建议，不改动任何 Skill。

    触发条件：至少 3 条评价且（最近 3 条全部 ≤2 星，或整体均分 ≤2.5）。
    """
    stats = compute_skill_review_stats(reviews)
    if stats["count"] < 3:
        return None
    if not stats["last_three_all_low"] and not (stats["average"] > 0 and stats["average"] <= 2.5):
        return None
    low_reviews = sorted(
        [item for item in reviews if int((item.get("user_feedback") or {}).get("rating") or 0) <= 2],
        key=lambda item: int(item.get("created_at") or 0),
    )[-5:]
    issue_counts: Dict[str, int] = {}
    for item in low_reviews:
        tag = str(item.get("issue_tag") or "other")
        issue_counts[tag] = issue_counts.get(tag, 0) + 1
    top_issues = sorted(issue_counts.items(), key=lambda pair: pair[1], reverse=True)[:3]
    issue_text = "、".join(f"{ISSUE_TAG_LABELS.get(tag, tag)}×{count}" for tag, count in top_issues) or "未标注问题类型"
    comments = [str((item.get("user_feedback") or {}).get("comment") or "").strip() for item in low_reviews]
    comments = [text for text in comments if text][:5]
    observations = [f"「{skill.get('name') or skill.get('skill_id') or '该 Skill'}」近期评分持续偏低（均分 {stats['average']}，低分 {stats['low_count']} 条），主要问题：{issue_text}。"]
    observations.extend(f"用户反馈：{text}" for text in comments)
    return {
        "reason": stats["last_three_all_low"] and "最近 3 次使用全部低分" or f"整体均分 {stats['average']} 偏低",
        "stats": stats,
        "low_review_ids": [item.get("id") for item in low_reviews],
        "observations": observations,
        "evidence": [
            {
                "url": (item.get("target") or {}).get("url") or "",
                "history_timestamp": (item.get("target") or {}).get("history_timestamp") or 0,
            }
            for item in low_reviews if (item.get("target") or {}).get("url")
        ],
        "notice": "该建议只会生成候选经验；需按阶段 2 流程人工审核发布后，才允许升级 Skill 版本。",
    }


# ---------------------------------------------------------------------------
# 阶段 3：设计任务执行记录（DesignRun）。方案生成与执行全部沿用现有
# canvas-plan / 节点工作流；这里只记录「用了什么、结果如何」，供追溯。
# ---------------------------------------------------------------------------
RUN_STATUSES = ("awaiting_confirmation", "executing", "completed", "failed", "cancelled")
RUN_LIST_MAX = 200
RUN_EVENTS_MAX = 40
RUN_TEXT_MAX = 2000
RUN_OPTION_MAX = 4


def _run_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _normalize_run_options(raw: Any) -> List[Dict[str, Any]]:
    values = raw if isinstance(raw, list) else []
    normalized = []
    for item in values[:RUN_OPTION_MAX]:
        if not isinstance(item, dict):
            continue
        steps = [_run_text(step, 200) for step in (item.get("steps") if isinstance(item.get("steps"), list) else [])[:12] if _run_text(step, 200)]
        normalized.append({
            "id": _run_text(item.get("id") or f"{len(normalized) + 1}", 16),
            "label": _run_text(item.get("label") or f"方案 {len(normalized) + 1}", 60),
            "summary": _run_text(item.get("summary"), 600),
            "reason": _run_text(item.get("reason"), 600),
            "steps": steps,
        })
    return normalized


def normalize_design_run(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    status = str(item.get("status") or "awaiting_confirmation").strip()
    if status not in RUN_STATUSES:
        status = "awaiting_confirmation"
    brief = _run_text(item.get("brief"), RUN_TEXT_MAX)
    plan = item.get("plan") if isinstance(item.get("plan"), dict) else {}
    execution = item.get("execution") if isinstance(item.get("execution"), dict) else {}
    skill = item.get("skill") if isinstance(item.get("skill"), dict) else {}
    cases = []
    for case in (item.get("case_ids") if isinstance(item.get("case_ids"), list) else [])[:10]:
        if not isinstance(case, dict):
            continue
        case_id = _run_text(case.get("id"), 60)
        if case_id:
            cases.append({"id": case_id, "title": _run_text(case.get("title"), 80), "score": round(min(1.0, max(0.0, float(case.get("score") or 0))), 3)})
    profile_summary = item.get("profile_summary") if isinstance(item.get("profile_summary"), dict) else {}
    clean_profile_summary = {
        group: [_clean_text(tag, TAG_TEXT_MAX) for tag in (profile_summary.get(group) if isinstance(profile_summary.get(group), list) else [])[:12]]
        for group in (*AESTHETIC_GROUPS, "avoid_tags")
    }
    asset_refs = []
    seen_urls = set()
    for ref in (execution.get("asset_refs") if isinstance(execution.get("asset_refs"), list) else []):
        if not isinstance(ref, dict):
            continue
        url = _run_text(ref.get("url"), 500)
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        entry = {"url": url}
        ref_id = normalize_media_asset_ref(ref.get("asset_ref_id"))
        if ref_id:
            entry["asset_ref_id"] = ref_id
        asset_refs.append(entry)
    try:
        selected_index = max(0, min(RUN_OPTION_MAX, int(plan.get("selected_index") or 0)))
    except (TypeError, ValueError):
        selected_index = 0
    try:
        profile_revision = max(0, int(item.get("profile_revision") or 0))
    except (TypeError, ValueError):
        profile_revision = 0
    try:
        created_at = int(item.get("created_at") or now_ms())
    except (TypeError, ValueError):
        created_at = now_ms()
    return {
        "id": re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or f"run_{uuid.uuid4().hex[:12]}"))[:60],
        "title": _run_text(item.get("title"), 120) or (brief[:40] or "设计任务"),
        "brief": brief,
        "status": status,
        "canvas_id": _run_text(item.get("canvas_id"), 80),
        "project_id": _run_text(item.get("project_id"), 80),
        "profile_revision": profile_revision,
        "profile_summary": clean_profile_summary,
        "case_ids": cases,
        "skill": {
            "skill_id": _run_text(skill.get("skill_id"), 120),
            "name": _run_text(skill.get("name"), 120),
            "version": _run_text(skill.get("version"), 40),
            "selection_reason": _run_text(skill.get("selection_reason"), 300),
        },
        "plan": {
            "summary": _run_text(plan.get("summary"), 1000),
            "prompt": _run_text(plan.get("prompt"), 4000),
            "options": _normalize_run_options(plan.get("options")),
            "selected_index": selected_index,
        },
        "execution": {
            "canvas_task_ids": [_run_text(value, 60) for value in (execution.get("canvas_task_ids") if isinstance(execution.get("canvas_task_ids"), list) else [])],
            "history_timestamps": [float(value) for value in (execution.get("history_timestamps") if isinstance(execution.get("history_timestamps"), list) else []) if _is_positive_float(value)],
            "asset_refs": asset_refs,
            "models": [_run_text(value, 160) for value in (execution.get("models") if isinstance(execution.get("models"), list) else [])[:8]],
            "node_ids": [_run_text(value, 80) for value in (execution.get("node_ids") if isinstance(execution.get("node_ids"), list) else [])],
        },
        "result": {
            "error": _run_text((item.get("result") or {}).get("error") if isinstance(item.get("result"), dict) else "", 600),
            "note": _run_text((item.get("result") or {}).get("note") if isinstance(item.get("result"), dict) else "", 600),
        },
        "events": [
            {"at": int(event.get("at") or 0), "type": _run_text(event.get("type"), 24) or "info", "note": _run_text(event.get("note"), 300)}
            for event in (item.get("events") if isinstance(item.get("events"), list) else [])[-RUN_EVENTS_MAX:]
            if isinstance(event, dict)
        ],
        "created_at": created_at,
        "updated_at": int(item.get("updated_at") or created_at),
    }


def _is_positive_float(value: Any) -> bool:
    try:
        return float(value) > 0
    except (TypeError, ValueError):
        return False


class DesignRunStore:
    """设计任务执行记录：方案确认 → 执行 → 终态，事件与任务结果有界累积。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "runs.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "updated_at": 0, "runs": []}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "设计执行记录暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("runs"), list):
            raise DesignBrainError("state_unavailable", "设计执行记录内容无效，请检查本地数据文件", 503)
        state["runs"] = [normalize_design_run(item) for item in state["runs"][:RUN_LIST_MAX]]
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".runs-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            _replace_runtime_record(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list(self, canvas_id: str = "", project_id: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_unlocked()
        runs = state["runs"]
        if canvas_id:
            runs = [run for run in runs if run["canvas_id"] == canvas_id]
        if project_id:
            runs = [run for run in runs if run["project_id"] == project_id]
        return deepcopy(runs[:max(1, min(200, int(limit or 50)))])

    def clear(self) -> None:
        """显式清空全部执行记录（仅个人数据删除入口调用）。"""
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "runs": []})

    def get(self, run_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        run = next((item for item in state["runs"] if item["id"] == run_id), None)
        if not run:
            raise DesignBrainError("run_not_found", "该设计执行记录不存在", 404)
        return deepcopy(run)

    def create(self, payload: Any) -> Dict[str, Any]:
        item = normalize_design_run({**(payload if isinstance(payload, dict) else {}), "status": "awaiting_confirmation"})
        with self.lock:
            state = self._read_unlocked()
            if any(run["id"] == item["id"] for run in state["runs"]):
                raise DesignBrainError("invalid_run", "执行记录编号重复，请重试", 409)
            item["events"] = [{"at": now_ms(), "type": "created", "note": "方案已生成，等待确认"}]
            state["runs"] = [item] + state["runs"][:RUN_LIST_MAX - 1]
            self._write(state)
        return deepcopy(item)

    def _mutate(self, run_id: str, change) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            run = next((item for item in state["runs"] if item["id"] == run_id), None)
            if not run:
                raise DesignBrainError("run_not_found", "该设计执行记录不存在", 404)
            change(run)
            run["updated_at"] = now_ms()
            self._write(state)
        return deepcopy(run)

    def confirm(self, run_id: str, selected_index: int = 0) -> Dict[str, Any]:
        def change(run):
            if run["status"] != "awaiting_confirmation":
                raise DesignBrainError("invalid_transition", "只有待确认的方案可以执行", 409)
            run["status"] = "executing"
            run["plan"]["selected_index"] = max(0, min(len(run["plan"]["options"]) or 1, int(selected_index or 0)))
            run["events"].append({"at": now_ms(), "type": "confirmed", "note": f"用户确认方案 {run['plan']['selected_index'] + 1}，开始执行"})
        return self._mutate(run_id, change)

    def cancel(self, run_id: str) -> Dict[str, Any]:
        def change(run):
            if run["status"] in ("completed", "failed", "cancelled"):
                raise DesignBrainError("invalid_transition", "该执行记录已结束", 409)
            run["status"] = "cancelled"
            run["events"].append({"at": now_ms(), "type": "cancelled", "note": "用户取消执行"})
        return self._mutate(run_id, change)

    def complete(self, run_id: str, success: bool, error: str = "", note: str = "", node_ids=None) -> Dict[str, Any]:
        def change(run):
            if run["status"] != "executing":
                raise DesignBrainError("invalid_transition", "只有执行中的记录可以标记完成或失败", 409)
            run["status"] = "completed" if success else "failed"
            run["result"] = {"error": _run_text(error, 600), "note": _run_text(note, 600)}
            for node_id in (node_ids or []):
                value = _run_text(node_id, 80)
                if value and value not in run["execution"]["node_ids"]:
                    run["execution"]["node_ids"].append(value)
            run["events"].append({"at": now_ms(), "type": "completed" if success else "failed",
                                  "note": _run_text(note or error or ("执行完成" if success else "执行失败"), 300)})
        return self._mutate(run_id, change)

    def note_event(self, run_id: str, event_type: str, note: str = "") -> Dict[str, Any]:
        def change(run):
            run["events"].append({"at": now_ms(), "type": _run_text(event_type, 24) or "info", "note": _run_text(note, 300)})
            run["events"] = run["events"][-RUN_EVENTS_MAX:]
        return self._mutate(run_id, change)

    def note_task(self, run_id: str, task: Dict[str, Any]) -> Dict[str, Any]:
        """任务终态回写：由生图任务钩子调用；同一任务只记一次。"""
        def change(run):
            task_id = _run_text(task.get("task_id"), 60)
            execution = run["execution"]
            if task_id and task_id in execution["canvas_task_ids"]:
                return
            if task_id:
                execution["canvas_task_ids"].append(task_id)
            status = _run_text(task.get("status"), 24)
            error = _run_text(task.get("error"), 300)
            model = _run_text(task.get("model"), 160)
            if model and model not in execution["models"]:
                execution["models"].append(model)
            for ref in (task.get("asset_refs") or []):
                if not isinstance(ref, dict):
                    continue
                url = _run_text(ref.get("url"), 500)
                if not url or any(existing.get("url") == url for existing in execution["asset_refs"]):
                    continue
                entry = {"url": url}
                ref_id = normalize_media_asset_ref(ref.get("asset_ref_id"))
                if ref_id:
                    entry["asset_ref_id"] = ref_id
                execution["asset_refs"].append(entry)
            timestamp = float(task.get("history_timestamp") or 0)
            if timestamp > 0 and timestamp not in execution["history_timestamps"]:
                execution["history_timestamps"].append(timestamp)
            run["events"].append({"at": now_ms(), "type": f"task_{status}" if status else "task",
                                  "note": _run_text(f"{model or '生图任务'} {status}{('：' + error) if error else ''}", 300)})
            run["events"] = run["events"][-RUN_EVENTS_MAX:]
        return self._mutate(run_id, change)


# ---------------------------------------------------------------------------
# 参考素材库（参考素材阶段）：本地批量导入的设计参考图索引。
# 图片字节按内容寻址保存在 references/media/<hash[:2]>/<hash><ext>，缩略图在
# references/thumbs/<hash[:2]>/<hash>.jpg；索引 JSON 只存相对路径。图片不进
# 图片空间、不进 asset_registry，删除守卫无需登记（自管文件，随条目删除）。
# 来源 source.type 预留 "huaban"（仅占位，不实现抓取）；AI 分析的建议分类
# 存 analysis.suggested，与用户填写的 classification 分离，绝不自动覆盖。
# ---------------------------------------------------------------------------

REFERENCE_ITEM_LIST_MAX = 5000
REFERENCE_TITLE_MAX = 80
REFERENCE_TAG_MAX = 12
REFERENCE_TAG_TEXT_MAX = 24
REFERENCE_NOTES_MAX = 2000
REFERENCE_FOLDER_MAX = 300
REFERENCE_NAME_MAX = 200
REFERENCE_PATH_MAX = 400
REFERENCE_ANALYSIS_TEXT_MAX = 600
REFERENCE_ERROR_MAX = 300
REFERENCE_ANALYSIS_STATUSES = ("none", "pending", "ready", "failed")
REFERENCE_SOURCE_TYPES = {"local", "huaban"}
REFERENCE_FILE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
REFERENCE_ANALYSIS_FIELDS = ("purpose", "composition", "material", "lighting", "takeaways", "restrictions")
REFERENCE_CLASS_DIMENSIONS = ("category", "purpose", "expression")

REFERENCE_CATEGORY_PRESETS = ("家居", "相框", "电子产品", "服饰", "箱包", "美妆", "食品", "饮料", "珠宝配饰", "母婴玩具", "文具礼品", "其他")
REFERENCE_PURPOSE_PRESETS = ("主图", "详情页", "Banner", "场景图", "白底图", "海报", "封面", "其他")
REFERENCE_EXPRESSION_PRESETS = ("材质表现", "创意展示", "场景氛围", "极简留白", "撞色对比", "叙事插画", "写实摄影", "其他")


def _clamp_positive_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def normalize_reference_tags(raw: Any) -> List[str]:
    values = raw if isinstance(raw, list) else []
    tags: List[str] = []
    seen = set()
    for item in values:
        text = _clean_text(item, REFERENCE_TAG_TEXT_MAX)
        if not text or text in seen:
            continue
        seen.add(text)
        tags.append(text)
        if len(tags) >= REFERENCE_TAG_MAX:
            break
    return tags


def normalize_reference_classification(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "category": _clean_text(source.get("category"), REFERENCE_TAG_TEXT_MAX),
        "purpose": _clean_text(source.get("purpose"), REFERENCE_TAG_TEXT_MAX),
        "expression": _clean_text(source.get("expression"), REFERENCE_TAG_TEXT_MAX),
        "tags": normalize_reference_tags(source.get("tags")),
    }


def normalize_reference_analysis(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    status = str(source.get("status") or "none").strip()
    if status not in REFERENCE_ANALYSIS_STATUSES:
        status = "none"
    content_raw = source.get("content") if isinstance(source.get("content"), dict) else {}
    suggested_raw = source.get("suggested") if isinstance(source.get("suggested"), dict) else {}
    return {
        "status": status,
        "provider": _clean_text(source.get("provider"), 120),
        "model": _clean_text(source.get("model"), 160),
        "analyzed_at": int(_clamp_positive_int(source.get("analyzed_at"))),
        "error": _clean_text(source.get("error"), REFERENCE_ERROR_MAX),
        "content": {field: _clean_text(content_raw.get(field), REFERENCE_ANALYSIS_TEXT_MAX) for field in REFERENCE_ANALYSIS_FIELDS},
        "suggested": {
            "category": _clean_text(suggested_raw.get("category"), REFERENCE_TAG_TEXT_MAX),
            "purpose": _clean_text(suggested_raw.get("purpose"), REFERENCE_TAG_TEXT_MAX),
            "expression": _clean_text(suggested_raw.get("expression"), REFERENCE_TAG_TEXT_MAX),
            "tags": normalize_reference_tags(suggested_raw.get("tags")),
        },
        "edited": bool(source.get("edited")),
        "edited_at": int(_clamp_positive_int(source.get("edited_at"))),
    }


def normalize_reference_source(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    source_type = str(source.get("type") or "").strip()
    if source_type not in REFERENCE_SOURCE_TYPES:
        source_type = "local"
    return {
        "type": source_type,
        "folder": _clean_text(source.get("folder"), REFERENCE_FOLDER_MAX),
        "url": _run_path(source.get("url"), 500),
        "board": _clean_text(source.get("board"), REFERENCE_TAG_TEXT_MAX),
        "imported_at": int(_clamp_positive_int(source.get("imported_at"))),
    }


def _run_path(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def normalize_reference_file(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    ext = str(source.get("ext") or "").strip().lower()
    if ext not in REFERENCE_FILE_EXTS:
        ext = ""
    return {
        "name": _clean_text(source.get("name"), REFERENCE_NAME_MAX),
        "ext": ext,
        "size": _clamp_positive_int(source.get("size")),
        "width": _clamp_positive_int(source.get("width")),
        "height": _clamp_positive_int(source.get("height")),
        "media": _run_path(source.get("media"), REFERENCE_PATH_MAX),
        "thumb": _run_path(source.get("thumb"), REFERENCE_PATH_MAX),
        "thumb_width": _clamp_positive_int(source.get("thumb_width")),
        "thumb_height": _clamp_positive_int(source.get("thumb_height")),
    }


def normalize_reference_item(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    digest = str(item.get("hash") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        digest = ""
    try:
        created_at = int(item.get("created_at") or now_ms())
    except (TypeError, ValueError):
        created_at = now_ms()
    try:
        updated_at = int(item.get("updated_at") or created_at)
    except (TypeError, ValueError):
        updated_at = created_at
    title = _clean_text(item.get("title"), REFERENCE_TITLE_MAX)
    file_info = normalize_reference_file(item.get("file"))
    if not title and file_info["name"]:
        title = _clean_text(os.path.splitext(file_info["name"])[0], REFERENCE_TITLE_MAX)
    return {
        "id": re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or f"ref_{uuid.uuid4().hex[:12]}"))[:60],
        "created_at": created_at,
        "updated_at": updated_at,
        "hash": digest,
        "file": file_info,
        "source": normalize_reference_source(item.get("source")),
        "title": title or "未命名参考",
        "classification": normalize_reference_classification(item.get("classification")),
        "analysis": normalize_reference_analysis(item.get("analysis")),
        "notes": _clean_text(item.get("notes"), REFERENCE_NOTES_MAX),
        "favorite": bool(item.get("favorite")),
    }


def reference_item_matches(item: Dict[str, Any], filters: Dict[str, Any]) -> bool:
    classification = item.get("classification") or {}
    analysis = item.get("analysis") or {}
    for dimension in REFERENCE_CLASS_DIMENSIONS:
        wanted = str(filters.get(dimension) or "").strip()
        if wanted and str(classification.get(dimension) or "") != wanted:
            return False
    tag = str(filters.get("tag") or "").strip()
    if tag and tag not in (classification.get("tags") or []):
        return False
    analysis_filter = str(filters.get("analysis") or "").strip()
    if analysis_filter in REFERENCE_ANALYSIS_STATUSES and analysis.get("status") != analysis_filter:
        return False
    if filters.get("favorite") and not item.get("favorite"):
        return False
    query = str(filters.get("q") or "").strip().lower()
    if query:
        content = analysis.get("content") or {}
        haystack = " ".join(str(part or "") for part in (
            item.get("title"), (item.get("file") or {}).get("name"), (item.get("source") or {}).get("folder"),
            item.get("notes"), " ".join(classification.get("tags") or []),
            *(content.get(field) for field in REFERENCE_ANALYSIS_FIELDS),
        )).lower()
        if not all(word in haystack for word in query.split()):
            return False
    return True


def reference_facets(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    facets: Dict[str, Dict[str, int]] = {dimension: {} for dimension in REFERENCE_CLASS_DIMENSIONS}
    facets["tags"] = {}
    facets["analysis"] = {status: 0 for status in REFERENCE_ANALYSIS_STATUSES}
    for item in items:
        classification = item.get("classification") or {}
        for dimension in REFERENCE_CLASS_DIMENSIONS:
            value = str(classification.get(dimension) or "").strip()
            if value:
                facets[dimension][value] = facets[dimension].get(value, 0) + 1
        for tag in classification.get("tags") or []:
            facets["tags"][tag] = facets["tags"].get(tag, 0) + 1
        status = str((item.get("analysis") or {}).get("status") or "none")
        facets["analysis"][status] = facets["analysis"].get(status, 0) + 1
    return facets


class ReferenceItemStore:
    """参考素材索引：原子写 + 内容哈希去重 + 数量上限。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain" / "references"
        self.file = self.root / "reference_items.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "revision": 0, "updated_at": 0, "items": []}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "参考素材暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("items"), list):
            raise DesignBrainError("state_unavailable", "参考素材内容无效，请检查本地数据文件", 503)
        state.setdefault("version", 1)
        state.setdefault("revision", 0)
        state["items"] = [normalize_reference_item(item) for item in state["items"][:REFERENCE_ITEM_LIST_MAX]]
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["revision"] = int(state.get("revision") or 0) + 1
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".reference-items-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list(self, filters: Optional[Dict[str, Any]] = None, limit: int = 200, offset: int = 0) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        items = state["items"]
        facets = reference_facets(items)
        filters = filters or {}
        if filters:
            items = [item for item in items if reference_item_matches(item, filters)]
        total = len(items)
        try:
            limit = max(1, min(REFERENCE_ITEM_LIST_MAX, int(limit or 200)))
        except (TypeError, ValueError):
            limit = 200
        try:
            offset = max(0, int(offset or 0))
        except (TypeError, ValueError):
            offset = 0
        return {"items": deepcopy(items[offset:offset + limit]), "facets": facets, "total": total}

    def get(self, item_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
        if not item:
            raise DesignBrainError("reference_not_found", "该参考素材不存在", 404)
        return deepcopy(item)

    def find_by_hash(self, digest: str) -> Optional[Dict[str, Any]]:
        digest = str(digest or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            return None
        with self.lock:
            state = self._read_unlocked()
        item = next((entry for entry in state["items"] if entry["hash"] == digest), None)
        return deepcopy(item) if item else None

    def create(self, payload: Any) -> Dict[str, Any]:
        item = normalize_reference_item(payload)
        if not item["hash"]:
            raise DesignBrainError("invalid_reference", "参考素材缺少内容指纹", 400)
        if not item["file"]["media"]:
            raise DesignBrainError("invalid_reference", "参考素材缺少原始文件", 400)
        with self.lock:
            state = self._read_unlocked()
            if any(entry["hash"] == item["hash"] for entry in state["items"]):
                raise DesignBrainError("duplicate_reference", "相同内容的图片已在参考素材库中", 409)
            if any(entry["id"] == item["id"] for entry in state["items"]):
                item["id"] = f"ref_{uuid.uuid4().hex[:12]}"
            item["created_at"] = item["updated_at"] = now_ms()
            state["items"] = [item] + state["items"]
            state["items"] = state["items"][:REFERENCE_ITEM_LIST_MAX]
            self._write(state)
        return deepcopy(item)

    def update(self, item_id: str, patch: Any) -> Dict[str, Any]:
        source = patch if isinstance(patch, dict) else {}
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
            if not item:
                raise DesignBrainError("reference_not_found", "该参考素材不存在", 404)
            if "title" in source:
                item["title"] = _clean_text(source.get("title"), REFERENCE_TITLE_MAX) or item["title"]
            if "notes" in source:
                item["notes"] = _clean_text(source.get("notes"), REFERENCE_NOTES_MAX)
            if "favorite" in source:
                item["favorite"] = bool(source.get("favorite"))
            if "classification" in source:
                item["classification"] = normalize_reference_classification(source.get("classification"))
            item["updated_at"] = now_ms()
            self._write(state)
        return deepcopy(item)

    def update_many(self, item_ids: List[str], patch: Any) -> List[Dict[str, Any]]:
        wanted = {str(value or "").strip() for value in (item_ids or []) if str(value or "").strip()}
        updated: List[Dict[str, Any]] = []
        with self.lock:
            state = self._read_unlocked()
            for entry in state["items"]:
                if entry["id"] not in wanted:
                    continue
                self._apply_patch(entry, patch)
                entry["updated_at"] = now_ms()
                updated.append(entry)
            if updated:
                self._write(state)
        return deepcopy(updated)

    @staticmethod
    def _apply_patch(item: Dict[str, Any], patch: Any) -> None:
        source = patch if isinstance(patch, dict) else {}
        if "title" in source:
            item["title"] = _clean_text(source.get("title"), REFERENCE_TITLE_MAX) or item["title"]
        if "notes" in source:
            item["notes"] = _clean_text(source.get("notes"), REFERENCE_NOTES_MAX)
        if "favorite" in source:
            item["favorite"] = bool(source.get("favorite"))
        if "classification" in source:
            # 批量分类允许只传部分维度：未提供的维度保留原值。
            merged = dict(item["classification"])
            incoming = source.get("classification") if isinstance(source.get("classification"), dict) else {}
            for dimension in REFERENCE_CLASS_DIMENSIONS:
                if dimension in incoming:
                    merged[dimension] = _clean_text(incoming.get(dimension), REFERENCE_TAG_TEXT_MAX)
            if "tags" in incoming:
                merged["tags"] = normalize_reference_tags(incoming.get("tags"))
            item["classification"] = normalize_reference_classification(merged)

    def set_analysis(self, item_id: str, status: str, content: Any = None, suggested: Any = None,
                     provider: str = "", model: str = "", error: str = "") -> Dict[str, Any]:
        if status not in REFERENCE_ANALYSIS_STATUSES:
            raise DesignBrainError("invalid_analysis_status", "未知的分析状态", 400)
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
            if not item:
                raise DesignBrainError("reference_not_found", "该参考素材不存在", 404)
            analysis = item["analysis"]
            analysis["status"] = status
            if status == "pending":
                item["updated_at"] = now_ms()
                self._write(state)
                return deepcopy(item)
            if status == "ready":
                clean = normalize_reference_analysis({
                    "status": "ready", "provider": provider, "model": model,
                    "analyzed_at": now_ms(), "content": content, "suggested": suggested,
                })
                item["analysis"] = clean
            elif status == "failed":
                analysis["status"] = "failed"
                analysis["error"] = _clean_text(error, REFERENCE_ERROR_MAX) or "分析失败"
                analysis["provider"] = _clean_text(provider, 120)
                analysis["model"] = _clean_text(model, 160)
            item["updated_at"] = now_ms()
            self._write(state)
        return deepcopy(item)

    def edit_analysis(self, item_id: str, content: Any) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
            if not item:
                raise DesignBrainError("reference_not_found", "该参考素材不存在", 404)
            merged_content = dict(item["analysis"]["content"])
            incoming = content if isinstance(content, dict) else {}
            for field in REFERENCE_ANALYSIS_FIELDS:
                if field in incoming:
                    merged_content[field] = _clean_text(incoming.get(field), REFERENCE_ANALYSIS_TEXT_MAX)
            item["analysis"]["content"] = merged_content
            item["analysis"]["edited"] = True
            item["analysis"]["edited_at"] = now_ms()
            if item["analysis"]["status"] != "pending":
                item["analysis"]["status"] = "ready"
            item["updated_at"] = now_ms()
            self._write(state)
        return deepcopy(item)

    def delete(self, item_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
            item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
            if not item:
                raise DesignBrainError("reference_not_found", "该参考素材不存在", 404)
            state["items"] = [entry for entry in state["items"] if entry["id"] != item_id]
            self._write(state)
        return deepcopy(item)

    def delete_many(self, item_ids: List[str]) -> List[Dict[str, Any]]:
        wanted = {str(value or "").strip() for value in (item_ids or []) if str(value or "").strip()}
        removed: List[Dict[str, Any]] = []
        with self.lock:
            state = self._read_unlocked()
            remaining = []
            for entry in state["items"]:
                (removed if entry["id"] in wanted else remaining).append(entry)
            if removed:
                state["items"] = remaining
                self._write(state)
        return deepcopy(removed)

    def media_paths_for(self, items: List[Dict[str, Any]]) -> List[str]:
        """条目删除后可清理的相对路径（仍被其他条目共享的哈希会保留）。"""
        remaining_hashes: set = set()
        with self.lock:
            state = self._read_unlocked()
            remaining_hashes = {entry["hash"] for entry in state["items"]}
        paths: List[str] = []
        for item in items or []:
            if item.get("hash") and item["hash"] in remaining_hashes:
                continue
            for key in ("media", "thumb"):
                relative = str(((item.get("file") or {}).get(key)) or "").strip()
                if relative:
                    paths.append(relative)
        return paths

    def clear(self) -> None:
        """显式清空索引（仅个人数据删除入口调用）；媒体文件由 API 层清理。"""
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "items": []})


# ---------------------------------------------------------------------------
# 多 BOT 协作的统一任务对象（AgentTask）：设计总监 BOT 生成任务单，参考分析/
# 设计规划/生成执行/质量检查 BOT 按阶段读写同一份记录。存储约定与
# DesignRunStore 相同（原子写、线程锁、上限裁剪、坏文件显式报错）。
# ---------------------------------------------------------------------------

AGENT_TASK_STATUSES = (
    "intake", "reference_analysis", "planning", "awaiting_confirmation",
    "executing", "quality_check", "revision", "delivered", "failed", "cancelled",
)
AGENT_TASK_TERMINAL_STATUSES = ("delivered", "failed", "cancelled")
AGENT_TASK_LIST_MAX = 100
AGENT_TASK_EVENTS_MAX = 200
AGENT_TASK_MESSAGES_MAX = 120
AGENT_TASK_REFERENCES_MAX = 6
AGENT_TASK_TEXT_MAX = 4000
DESIGN_BOT_IDS = ("director", "reference", "planner", "executor", "reviewer")
AGENT_TASK_TYPES = ("main_image", "detail_images", "creative", "other")
SHOT_KINDS = ("main_image", "detail_image", "scene", "creative", "other")
SHOT_STATUSES = ("pending", "running", "succeeded", "failed", "skipped")
REVIEW_VERDICTS = ("pass", "issues", "needs_human")
REVIEW_SEVERITIES = ("critical", "major", "minor")
_SIZE_RE = re.compile(r"^\d{2,5}x\d{2,5}$")

def is_sku_brief(brief: Dict[str, Any]) -> bool:
    return is_sku(brief)


def apply_ecommerce_plan(brief, plan, *, compose=False, offset=0):
    try:
        return apply_visual_plan(brief, plan, compose=compose, offset=offset)
    except VisualRuleError as exc:
        raise DesignBrainError("invalid_plan", str(exc), 422) from exc


def guard_append_edits(task, edits):
    for shot in task["plan"]["shots"][:(task.get("brief") or {}).get("append_from") or 0]:
        edit = edits.get(shot["id"]) or {}
        if any(key in edit and str(edit[key]) != str(shot.get(key, "")) for key in ("prompt", "size", "count", "negative")):
            raise DesignBrainError("invalid_plan", "追加详情屏时保留原页面；原页面的修改请使用继续修改所选", 422)


def apply_sku_plan(brief: Dict[str, Any], plan: Dict[str, Any], *, compose: bool = False) -> Dict[str, Any]:
    """SKU 方案的共同场景必须在确认前可见，不能在生成时临时另选场景。"""
    mode = sku_series_mode(brief)
    if not mode:
        return plan
    apply_ecommerce_plan(brief, plan)
    if mode == "sku_variants":
        scene = str(plan.get("sku_scene") or "").strip()
        if not scene or len(scene) > 1400:
            raise DesignBrainError("invalid_plan", "SKU 外观方案缺少共同场景（sku_scene），请重新规划固定构图、工艺、机位与光线", 422)
        shots = plan.get("shots") or []
        if not shots or len({shot["size"] for shot in shots}) != 1 or any(shot["count"] != 1 for shot in shots):
            raise DesignBrainError("invalid_plan", "同组 SKU 必须使用相同画幅与尺寸，每款逐张规划，请重新规划", 422)
        lock = "仅改变本款方案中用户指定的框色、照片或外观；共同场景、装裱工艺、构图、机位、光线、比例与品牌标识保持一致"
        for shot in shots:
            variant = str(shot.get("sku_variant") or "").strip()
            if not variant or len(variant) > 1800:
                raise DesignBrainError("invalid_plan", "SKU 外观方案需逐款填写 sku_variant，写清框色、照片来源与组合等实际变化，请重新规划", 422)
            if compose:
                shot["prompt"] = f"{lock}。\n共同场景：{scene}\n本款外观：{variant}\n{shot['prompt']}"
                constraints = (brief.get("product") or {}).get("constraints") or []
                if constraints:
                    shot["prompt"] += "\n商品约束：" + "；".join(str(value) for value in constraints)
            if len(shot["prompt"]) > AGENT_TASK_TEXT_MAX:
                raise DesignBrainError("invalid_plan", "SKU 提示词过长，请精简共同场景与商品描述后重新规划", 422)
            shot["acceptance"] = [lock] + [value for value in shot.get("acceptance", []) if value != lock][:5]
        plan["sku_layout"] = {}
        for key in ("constraints_locked", "acceptance"):
            plan[key] = [lock] + [value for value in plan.get(key, []) if value != lock][:9]
        return plan
    try:
        if not plan.get("sku_layout"):
            from design_brain_visual_rules import DEFAULT_LAYOUT
            layout = deepcopy(DEFAULT_LAYOUT)
            palette = plan["visual_framework"]["palette"]
            background = palette[0]
            color = next((c for c in palette[1:] if c.lower() not in ("#000000", background.lower())), "#252525" if background.lower() != "#252525" else "#F5F1E8")
            for spec in layout.values():
                spec.update(background=background, color=color)
            plan["sku_layout"] = layout
        plan["sku_layout"] = normalize_layout(plan["sku_layout"])
        colors = list(dict.fromkeys(c.upper() for c in plan["visual_framework"]["palette"] + [spec[k] for spec in plan["sku_layout"].values() for k in ("color", "background")]))
        if len(colors) > 3:
            raise VisualRuleError("三三原则：SKU文字位与底图合计不得超过3种配色，请统一颜色")
        plan["visual_framework"]["palette"] = colors
        plan["visual_framework"]["fonts"] = ["系统中文无衬线"]
    except VisualRuleError as exc:
        raise DesignBrainError("invalid_plan", str(exc), 422) from exc
    scene = str(plan.get("sku_scene") or "").strip()
    if not scene or len(scene) > 1400:
        raise DesignBrainError("invalid_plan", "SKU 方案缺少完整的共同场景（sku_scene），请重新规划固定背景、构图、机位与光线", 422)
    shots = plan.get("shots") or []
    if not shots or len({shot["size"] for shot in shots}) != 1 or any(shot["count"] != 1 for shot in shots):
        raise DesignBrainError("invalid_plan", "同组 SKU 必须使用相同画幅与尺寸，每款逐张规划，请重新规划", 422)
    lock = "仅参数、赠品、属性名称三个信息位可变；版式、背景、配色、产品造型、角度、比例、字体字号与品牌标识全部固定"
    for shot in shots:
        try:
            shot["sku_values"] = normalize_values(shot.get("sku_values"))
        except VisualRuleError as exc:
            raise DesignBrainError("invalid_plan", str(exc), 422) from exc
        if compose or shot.get("sku_values"):
            shot["sku_variant"] = json.dumps(shot["sku_values"], ensure_ascii=False)
            shot["prompt"] = f"电商 SKU 固定模板。{lock}。\n共同场景：{scene}\n本张信息位：{shot['sku_variant']}"
            constraints = (brief.get("product") or {}).get("constraints") or []
            if constraints:
                shot["prompt"] += "\n商品约束：" + "；".join(str(value) for value in constraints)
        if len(shot["prompt"]) > AGENT_TASK_TEXT_MAX:
            raise DesignBrainError("invalid_plan", "SKU 提示词过长，请精简共同场景与商品描述后重新规划", 422)
        shot["acceptance"] = [lock] + [value for value in shot["acceptance"] if value != lock][:5]
    for key in ("constraints_locked", "acceptance"):
        plan[key] = [lock] + [value for value in plan.get(key, []) if value != lock][:9]
    plan["flexible"] = ["仅替换数据参数、赠品信息、产品属性名称，不改变产品主体与视觉框架"]
    return plan


def image_requirements(text: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    mode = sku_series_mode({"goal": str(text or "")})
    if mode:
        result["series_mode"] = mode
    counts = re.findall(r"(?<![第前后每\d零一二两三四五六七八九十百千万])([0-9]+|[零一二两三四五六七八九十百千万]+)\s*(?:张|屏)", str(text or ""))
    if counts:
        value = counts[-1]
        digits = {char: index for index, char in enumerate("零一二三四五六七八九")}
        digits["两"] = 2
        if value.isdigit():
            count = int(value)
        else:
            count, section, number = 0, 0, 0
            for char in value:
                if char in digits:
                    number = digits[char]
                elif char == "万":
                    count += (section + number) * 10000
                    section, number = 0, 0
                else:
                    section += (number or 1) * {"十": 10, "百": 100, "千": 1000}[char]
                    number = 0
            count += section + number
        if count:
            result["image_count"] = count
    resolutions = re.findall(r"(?<![\d.])([124])\s*[kK](?![a-zA-Z\d])", str(text or ""))
    if resolutions:
        result["resolution"] = resolutions[-1] + "K"
    ratios = re.findall(r"(?<!\d)(1:1|2:3|3:4|9:16|16:9)(?!\d)", str(text or ""))
    if ratios:
        result["aspect_ratio"] = ratios[-1]
    return result


def brief_image_requirements(brief: Dict[str, Any]) -> Dict[str, Any]:
    deliverables = brief.get("deliverables") or []
    counts = [image_requirements(entry.get("text") or "").get("image_count", 0)
              for entry in deliverables if isinstance(entry, dict)]
    inferred = image_requirements(brief.get("goal") or "")
    try:
        count = int(brief.get("image_count") or sum(counts) or inferred.get("image_count") or 0)
    except (ValueError, TypeError):
        count = 0
    resolution = str(brief.get("resolution") or "").upper()
    if resolution not in {"1K", "2K", "4K"}:
        text = "\n".join([brief.get("goal") or "", brief.get("style_direction") or "",
                          *(str(value) for value in (brief.get("product") or {}).get("constraints", [])),
                          *(str(value) for value in brief.get("adjustments") or [])])
        resolution = image_requirements(text).get("resolution", "")
    if brief.get("visual_rules_applied") and brief.get("task_type") == "main_image" and not sku_series_mode(brief):
        count = 5
    return {"image_count": max(0, count), "resolution": resolution}


def apply_plan_requirements(brief: Dict[str, Any], shots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    requirements = brief_image_requirements(brief)
    expected = requirements["image_count"]
    normalized = [_normalize_shot(shot) for shot in shots]
    if (any(shot is None for shot in normalized)
            or len({shot["id"] for shot in normalized if shot}) != len(shots)):
        raise DesignBrainError("invalid_plan", "方案分镜无效或编号重复，请重新规划", 422)
    actual = sum(shot["count"] for shot in normalized)
    if expected and (actual != expected or len(normalized) != expected):
        raise DesignBrainError("invalid_plan", f"要求 {expected} 张，方案实际为 {actual} 张（{len(normalized)} 个分镜），请逐张重新规划后再确认", 422)
    resolution = requirements["resolution"]
    if resolution:
        edge = {"1K": 1024, "2K": 2048, "4K": 4096}[resolution]
        for shot in normalized:
            shot["resolution"] = resolution.lower()
            width, height = map(int, shot["size"].split("x"))
            if not width or not height:
                raise DesignBrainError("invalid_plan", "分镜尺寸必须大于零，请重新设置尺寸", 422)
            scale = edge / max(width, height)
            shot["size"] = f"{max(8, round(width * scale / 8) * 8)}x{max(8, round(height * scale / 8) * 8)}"
    return normalized


def _task_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _task_str_list(raw: Any, limit: Optional[int], item_limit: int) -> List[str]:
    values = raw if isinstance(raw, list) else []
    return [_task_text(value, item_limit) for value in values[:limit] if _task_text(value, item_limit)]


def _normalize_shot(raw: Any) -> Optional[Dict[str, Any]]:
    item = raw if isinstance(raw, dict) else {}
    prompt = _task_text(item.get("prompt"), AGENT_TASK_TEXT_MAX)
    if not prompt:
        return None
    size = _task_text(item.get("size"), 20)
    if not _SIZE_RE.match(size):
        size = "1024x1024"
    kind = _task_text(item.get("kind"), 40)
    if kind not in SHOT_KINDS:
        kind = "other"
    try:
        count = max(1, min(2, int(item.get("count") or 1)))
    except (TypeError, ValueError):
        count = 1
    try:
        revised = max(0, min(9, int(item.get("revised") or 0)))
    except (TypeError, ValueError):
        revised = 0
    return {
        "id": _task_text(item.get("id") or f"shot_{uuid.uuid4().hex[:6]}", 32),
        "kind": kind,
        "purpose": _task_text(item.get("purpose"), 160),
        "prompt": prompt,
        "sku_variant": _task_text(item.get("sku_variant"), 1800),
        "sku_values": deepcopy(item.get("sku_values")) if isinstance(item.get("sku_values"), dict) else {},
        "role": _task_text(item.get("role"), 30),
        "copy": deepcopy(item.get("copy")) if isinstance(item.get("copy"), dict) else {},
        "negative": _task_text(item.get("negative"), 1000),
        "size": size,
        "resolution": str(item.get("resolution") or "").strip().lower() if str(item.get("resolution") or "").strip().lower() in {"1k", "2k", "4k"} else "",
        "aspect_ratio": _task_text(item.get("aspect_ratio"), 20),
        "count": count,
        "acceptance": _task_str_list(item.get("acceptance"), 6, 160),
        "revised": revised,
    }


def _normalize_execution_shot(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    status = _task_text(item.get("status"), 20)
    if status not in SHOT_STATUSES:
        status = "pending"
    outputs = []
    for output in (item.get("outputs") if isinstance(item.get("outputs"), list) else [])[:6]:
        if not isinstance(output, dict):
            continue
        url = _task_text(output.get("url"), 500)
        if not url:
            continue
        entry = {"url": url, "asset_ref_id": normalize_media_asset_ref(output.get("asset_ref_id"))}
        for key in ("product_fidelity", "fidelity_report", "width", "height", "mime_type"):
            if key in output:
                entry[key] = deepcopy(output[key])
        outputs.append(entry)
    return {
        "id": _task_text(item.get("id") or f"shot_{uuid.uuid4().hex[:6]}", 32),
        "status": status,
        "canvas_task_ids": _task_str_list(item.get("canvas_task_ids"), 8, 60),
        "outputs": outputs,
        "error": _task_text(item.get("error"), 400),
        "prompt_used": _task_text(item.get("prompt_used"), AGENT_TASK_TEXT_MAX),
        "attempt": max(0, min(9, int(item.get("attempt") or 0))) if str(item.get("attempt") or "0").isdigit() else 0,
        "edit_source_urls": _task_str_list(item.get("edit_source_urls"), 4, 500),
    }


def _normalize_bot_message(raw: Any) -> Optional[Dict[str, Any]]:
    item = raw if isinstance(raw, dict) else {}
    text = _task_text(item.get("text"), AGENT_TASK_TEXT_MAX)
    if not text:
        return None
    role = _task_text(item.get("role"), 12)
    bot = _task_text(item.get("bot"), 20)
    return {
        "role": role if role in ("user", "bot") else "bot",
        "bot": bot if bot in DESIGN_BOT_IDS else "director",
        "at": int(item.get("at") or now_ms()),
        "text": text,
        "phase": _task_text(item.get("phase"), 40),
    }


def _normalize_task_review(raw: Any) -> Optional[Dict[str, Any]]:
    item = raw if isinstance(raw, dict) else {}
    verdict = _task_text(item.get("verdict"), 20)
    if verdict not in REVIEW_VERDICTS:
        verdict = "needs_human"
    issues = []
    for issue in (item.get("issues") if isinstance(item.get("issues"), list) else [])[:8]:
        if not isinstance(issue, dict):
            continue
        severity = _task_text(issue.get("severity"), 20)
        if severity not in REVIEW_SEVERITIES:
            severity = "minor"
        description = _task_text(issue.get("description"), 400)
        if not description:
            continue
        issues.append({
            "severity": severity,
            "area": _task_text(issue.get("area"), 40),
            "description": description,
            "evidence": _task_text(issue.get("evidence"), 400),
            "suggestion": _task_text(issue.get("suggestion"), 400),
            "cause": _task_text(issue.get("cause"), 40),
            "preserve": _task_text(issue.get("preserve"), 400),
            "verification": _task_text(issue.get("verification"), 400),
        })
    try:
        review_round = max(1, min(99, int(item.get("round") or 1)))
    except (TypeError, ValueError):
        review_round = 1
    return {
        "round": review_round,
        "shot_id": _task_text(item.get("shot_id"), 32),
        "verdict": verdict,
        "checked_at": int(item.get("checked_at") or now_ms()),
        "model": _task_text(item.get("model"), 160),
        "input_manifest": deepcopy(item.get("input_manifest")) if isinstance(item.get("input_manifest"), list) else [],
        "plan_revision": max(0, int(item.get("plan_revision") or 0)),
        "local_checks": deepcopy(item.get("local_checks")) if isinstance(item.get("local_checks"), dict) else {},
        "issues": issues,
    }


def _task_adjustment_options(raw: Any) -> List[Dict[str, str]]:
    options = []
    seen = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        label = _task_text(item.get("label"), 40)
        feedback = _task_text(item.get("feedback"), 200)
        if label and feedback and label not in seen:
            options.append({"label": label, "feedback": feedback})
            seen.add(label)
        if len(options) == 6:
            break
    return options


def normalize_agent_task(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    status = _task_text(item.get("status"), 40)
    if status not in AGENT_TASK_STATUSES:
        status = "intake"
    brief = item.get("brief") if isinstance(item.get("brief"), dict) else {}
    task_type = _task_text(brief.get("task_type"), 40)
    product = brief.get("product") if isinstance(brief.get("product"), dict) else {}
    models_raw = item.get("models") if isinstance(item.get("models"), dict) else {}
    models = {}
    for role in ("chat", "vision", "image"):
        entry = models_raw.get(role) if isinstance(models_raw.get(role), dict) else {}
        models[role] = {"provider": _task_text(entry.get("provider"), 100), "model": _task_text(entry.get("model"), 200)}
    references = []
    for reference in (item.get("references") if isinstance(item.get("references"), list) else [])[:AGENT_TASK_REFERENCES_MAX]:
        if not isinstance(reference, dict):
            continue
        reference_id = _task_text(reference.get("id"), 60)
        if not reference_id:
            continue
        try:
            score = round(min(1.0, max(0.0, float(reference.get("score") or 0))), 3)
        except (TypeError, ValueError):
            score = 0.0
        references.append({
            "id": reference_id, "title": _task_text(reference.get("title"), 120),
            "score": score, "reason": _task_text(reference.get("reason"), 300),
            "takeaways": _task_text(reference.get("takeaways"), 400),
            "thumb_url": _task_text(reference.get("thumb_url"), 500),
        })
    plan_raw = item.get("plan") if isinstance(item.get("plan"), dict) else {}
    shots = []
    for shot in (plan_raw.get("shots") if isinstance(plan_raw.get("shots"), list) else []):
        normalized = _normalize_shot(shot)
        if normalized and normalized["id"] not in {entry["id"] for entry in shots}:
            shots.append(normalized)
    execution = item.get("execution") if isinstance(item.get("execution"), dict) else {}
    execution_shots = []
    for shot in (execution.get("shots") if isinstance(execution.get("shots"), list) else []):
        normalized = _normalize_execution_shot(shot)
        if normalized["id"] not in {entry["id"] for entry in execution_shots}:
            execution_shots.append(normalized)
    reviews = []
    for review in (item.get("reviews") if isinstance(item.get("reviews"), list) else []):
        normalized = _normalize_task_review(review)
        if normalized:
            reviews.append(normalized)
    messages = []
    for message in (item.get("messages") if isinstance(item.get("messages"), list) else [])[-AGENT_TASK_MESSAGES_MAX:]:
        normalized = _normalize_bot_message(message)
        if normalized:
            messages.append(normalized)
    feedback_raw = item.get("feedback") if isinstance(item.get("feedback"), dict) else {}
    try:
        rating = max(0, min(5, int(feedback_raw.get("rating") or 0)))
    except (TypeError, ValueError):
        rating = 0
    usage_raw = item.get("usage") if isinstance(item.get("usage"), dict) else {}
    usage = {}
    for key in ("llm_calls", "image_calls", "auto_revisions", "user_revisions", "replans"):
        try:
            usage[key] = max(0, int(usage_raw.get(key) or 0))
        except (TypeError, ValueError):
            usage[key] = 0
    resume_phase = _task_text(item.get("resume_phase"), 40)
    if resume_phase not in AGENT_TASK_STATUSES or resume_phase in AGENT_TASK_TERMINAL_STATUSES:
        resume_phase = ""
    try:
        created_at = int(item.get("created_at") or now_ms())
    except (TypeError, ValueError):
        created_at = now_ms()
    try:
        append_from = max(0, int(brief.get("append_from") or 0))
    except (TypeError, ValueError):
        append_from = 0
    return {
        "design": normalize_design(item.get("design")),
        "id": re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or f"job_{uuid.uuid4().hex[:12]}"))[:60],
        "title": _task_text(item.get("title"), 120) or "设计任务",
        "skill": {key: _task_text((item.get("skill") or {}).get(key), limit)
                  for key, limit in (("skill_id", 120), ("name", 120), ("version", 80), ("selection_reason", 300))}
                 if isinstance(item.get("skill"), dict) and _task_text(item["skill"].get("skill_id"), 120) else {},
        "status": status,
        "created_at": created_at,
        "updated_at": int(item.get("updated_at") or created_at),
        "models": models,
        "auto_confirm": bool(item.get("auto_confirm")),
        "source_chat_id": _task_text(item.get("source_chat_id"), 60),
        "brief": {
            **brief_image_requirements(brief),
            "series_mode": sku_series_mode(brief),
            "source_text": _task_text(brief.get("source_text"), 8000),
            "visual_rules_applied": bool(brief.get("visual_rules_applied")),
            "aspect_ratio": _task_text(brief.get("aspect_ratio"), 20),
            "append_from": append_from,
            "task_type": task_type if task_type in AGENT_TASK_TYPES else "other",
            "goal": _task_text(brief.get("goal"), 2000),
            "product": {
                "name": _task_text(product.get("name"), 120),
                "category": _task_text(product.get("category"), 60),
                "features": _task_str_list(product.get("features"), 12, 80),
                "constraints": _task_str_list(product.get("constraints"), 12, 160),
            },
            "deliverables": [
                {"text": _task_text(entry.get("text"), 300)}
                for entry in (brief.get("deliverables") if isinstance(brief.get("deliverables"), list) else [])
                if isinstance(entry, dict) and _task_text(entry.get("text"), 300)
            ],
            "style_direction": _task_text(brief.get("style_direction"), 600),
            "direction_mode": brief.get("direction_mode") if brief.get("direction_mode") in ("fixed", "explore") else "auto",
            "adjustments": _task_str_list(brief.get("adjustments"), 12, 2000),
            "need_confirmation": bool(brief.get("need_confirmation", True)),
        },
        "product_images": _task_str_list(item.get("product_images"), None, 500),
        "references": references,
        "plan": {
            "sku_scene": _task_text(plan_raw.get("sku_scene"), 1400),
            "sku_layout": deepcopy(plan_raw.get("sku_layout")) if isinstance(plan_raw.get("sku_layout"), dict) else {},
            "visual_framework": deepcopy(plan_raw.get("visual_framework")) if isinstance(plan_raw.get("visual_framework"), dict) else {},
            "test_schedule": deepcopy(plan_raw.get("test_schedule")) if isinstance(plan_raw.get("test_schedule"), list) else [],
            "direction": _task_text(plan_raw.get("direction"), 600),
            "rationale": _task_text(plan_raw.get("rationale"), 800),
            "constraints_locked": _task_str_list(plan_raw.get("constraints_locked"), 10, 200),
            "flexible": _task_str_list(plan_raw.get("flexible"), 10, 200),
            "acceptance": _task_str_list(plan_raw.get("acceptance"), 10, 200),
            "adjustment_options": _task_adjustment_options(plan_raw.get("adjustment_options")),
            "planning_warnings": _task_str_list(plan_raw.get("planning_warnings"), 6, 300),
            "visual_framework_source": _task_text(plan_raw.get("visual_framework_source"), 40),
            "shots": shots,
        },
        "execution": {
            "design_run_id": _task_text(execution.get("design_run_id"), 60),
            "sku_anchor_url": _task_text(execution.get("sku_anchor_url"), 500),
            "visual_anchor_url": _task_text(execution.get("visual_anchor_url"), 500),
            "canvas_task_ids": _task_str_list(execution.get("canvas_task_ids"), None, 60),
            "shots": execution_shots,
        },
        "reviews": reviews,
        "messages": messages,
        "events": [
            {"at": int(event.get("at") or 0), "phase": _task_text(event.get("phase"), 40),
             "type": _task_text(event.get("type"), 40) or "info", "note": _task_text(event.get("note"), 400)}
            for event in (item.get("events") if isinstance(item.get("events"), list) else [])[-AGENT_TASK_EVENTS_MAX:]
            if isinstance(event, dict)
        ],
        "usage": usage,
        "error": _task_text(item.get("error"), 600),
        "resume_phase": resume_phase,
        "feedback": {
            "rating": rating,
            "comment": _task_text(feedback_raw.get("comment"), 400),
            "experience_id": _task_text(feedback_raw.get("experience_id"), 60),
        },
    }


class AgentTaskStore:
    """多 BOT 统一任务存储：一次 mutate 一个事务，事件与消息有界累积。"""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).resolve() / "design_brain"
        self.file = self.root / "agent_tasks.json"
        self.lock = threading.RLock()

    def _read_unlocked(self) -> Dict[str, Any]:
        if not self.file.exists():
            return {"version": 1, "updated_at": 0, "tasks": []}
        try:
            with self.file.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, ValueError) as exc:
            raise DesignBrainError("state_unavailable", "设计任务记录暂时无法读取，请检查本地数据文件", 503) from exc
        if not isinstance(state, dict) or not isinstance(state.get("tasks"), list):
            raise DesignBrainError("state_unavailable", "设计任务记录内容无效，请检查本地数据文件", 503) from exc
        state["tasks"] = [normalize_agent_task(item) for item in state["tasks"][:AGENT_TASK_LIST_MAX]]
        return state

    def _write(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = now_ms()
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".agent-tasks-", suffix=".json", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            _replace_runtime_record(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list(self, limit: int = 50, status: str = "") -> List[Dict[str, Any]]:
        with self.lock:
            state = self._read_unlocked()
        tasks = state["tasks"]
        if status:
            tasks = [task for task in tasks if task["status"] == status]
        return deepcopy(tasks[:max(1, min(AGENT_TASK_LIST_MAX, int(limit or 50)))])

    def get(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self._read_unlocked()
        task = next((item for item in state["tasks"] if item["id"] == task_id), None)
        if not task:
            raise DesignBrainError("agent_task_not_found", "该设计任务不存在", 404)
        return deepcopy(task)

    def create(self, payload: Any) -> Dict[str, Any]:
        item = normalize_agent_task(payload if isinstance(payload, dict) else {})
        with self.lock:
            state = self._read_unlocked()
            if any(task["id"] == item["id"] for task in state["tasks"]):
                raise DesignBrainError("invalid_agent_task", "设计任务编号重复，请重试", 409)
            item["updated_at"] = now_ms()
            state["tasks"] = [item] + state["tasks"][:AGENT_TASK_LIST_MAX - 1]
            self._write(state)
        return deepcopy(item)

    def patch(self, task_id: str, change: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        """单事务修改：change 直接修改任务字典，返回前整体重新归一化。"""
        with self.lock:
            state = self._read_unlocked()
            index = next((i for i, entry in enumerate(state["tasks"]) if entry["id"] == task_id), None)
            if index is None:
                raise DesignBrainError("agent_task_not_found", "该设计任务不存在", 404)
            task = state["tasks"][index]
            change(task)
            task["updated_at"] = now_ms()
            state["tasks"][index] = normalize_agent_task(task)
            self._write(state)
        return deepcopy(state["tasks"][index])

    def delete(self, task_id: str) -> None:
        with self.lock:
            state = self._read_unlocked()
            remaining = [task for task in state["tasks"] if task["id"] != task_id]
            if len(remaining) == len(state["tasks"]):
                raise DesignBrainError("agent_task_not_found", "该设计任务不存在", 404)
            state["tasks"] = remaining
            self._write(state)

    def add_event(self, task_id: str, phase: str, event_type: str, note: str) -> Dict[str, Any]:
        def change(task: Dict[str, Any]) -> None:
            task["events"].append({"at": now_ms(), "phase": phase, "type": event_type, "note": note})
        return self.patch(task_id, change)

    def add_message(self, task_id: str, role: str, bot: str, text: str, phase: str = "") -> Dict[str, Any]:
        def change(task: Dict[str, Any]) -> None:
            task["messages"].append({"role": role, "bot": bot, "at": now_ms(),
                                     "text": str(text or "").strip()[:AGENT_TASK_TEXT_MAX], "phase": phase})
        return self.patch(task_id, change)

    def clear(self) -> None:
        """显式清空全部设计任务（仅个人数据删除入口调用）。"""
        with self.lock:
            self._write({"version": 1, "updated_at": now_ms(), "tasks": []})
