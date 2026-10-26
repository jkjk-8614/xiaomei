"""Local-only design brain API: profile, references, experiences, and skills.

路由挂在 ``/api/design-brain`` 前缀下，由 main.py 以 ``include_router``
方式安装。档案与经验数据保存在运行数据根目录 ``data/design_brain/``，
参考素材保存在 ``data/design_brain/references/``（索引 JSON + 内容寻址的
原图与缩略图），Skill 物理文件复用 ``data/agent_skills/packages/``；
不提供任何上传或共享入口。Skill 的写入端点（生成/编辑/发布/回退）在
main.py 中，因为它们需要复用 agent-skills 的锁与安装内部函数。
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import shutil
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from runtime_paths import resolve_roots

from design_brain_store import (
    AgentTaskStore,
    DesignBrainError,
    DesignProfileStore,
    DesignRunStore,
    ExperienceStore,
    ReferenceItemStore,
    ReviewStore,
    SkillLinkStore,
    compute_skill_review_stats,
    now_ms,
    normalize_profile,
    review_comparability,
    skill_improvement_suggestion,
    EXPERIENCE_STATUSES,
    REFERENCE_CATEGORY_PRESETS,
    REFERENCE_EXPRESSION_PRESETS,
    REFERENCE_FILE_EXTS,
    REFERENCE_FOLDER_MAX,
    REFERENCE_ERROR_MAX,
    REFERENCE_ITEM_LIST_MAX,
    REFERENCE_PURPOSE_PRESETS,
    REVIEW_LIST_MAX,
)

_, ROOT = resolve_roots(Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent)
DATA_ROOT = ROOT / "data"
STORE = DesignProfileStore(DATA_ROOT)
EXPERIENCES = ExperienceStore(DATA_ROOT)
REFERENCES = ReferenceItemStore(DATA_ROOT)
SKILL_LINKS = SkillLinkStore(DATA_ROOT)
RUNS = DesignRunStore(DATA_ROOT)
REVIEWS = ReviewStore(DATA_ROOT)
AGENT_TASKS = AgentTaskStore(DATA_ROOT)
AGENT_SKILLS_DIR = DATA_ROOT / "agent_skills"
AGENT_SKILL_PACKAGE_INDEX = AGENT_SKILLS_DIR / "package-index.json"


def _local_only(request: Request) -> None:
    host = request.client.host if request.client else ""
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == "testclient"
    if not local:
        raise HTTPException(status_code=403, detail="设计大脑仅限本机访问")


def _local_only_dependency(request: Request) -> None:
    # 不能用 ``Depends(lambda request: ...)``：未注解的 lambda 参数会被
    # FastAPI 当成必填 query 参数，导致所有 /api/design-brain/* 请求 422
    # （阶段 0 交付时的实际故障，具名函数 + ``request: Request`` 注解才对）。
    _local_only(request)


router = APIRouter(prefix="/api/design-brain", dependencies=[Depends(_local_only_dependency)])


class ProfileUpdateRequest(BaseModel):
    profile: Dict[str, Any]
    expected_revision: Optional[int] = None


class ExperiencePayload(BaseModel):
    title: str = ""
    project_id: str = ""
    origin: Dict[str, Any] = Field(default_factory=dict)
    observations: list = Field(default_factory=list)
    evidence: Dict[str, Any] = Field(default_factory=dict)
    proposals: Dict[str, Any] = Field(default_factory=dict)
    distill_meta: Dict[str, Any] = Field(default_factory=dict)


class ExperienceRejectRequest(BaseModel):
    comment: str = ""


def _error_response(error: DesignBrainError) -> JSONResponse:
    payload: Dict[str, Any] = {"detail": error.message, "code": error.code}
    if error.code == "revision_conflict":
        # 把最新档案一并带回，前端可以直接展示并让用户选择覆盖或合并。
        current = STORE.read()
        payload["current"] = current
    return JSONResponse(status_code=error.status, content=payload)


def _read_package_registry() -> Dict[str, Any]:
    try:
        with AGENT_SKILL_PACKAGE_INDEX.open("r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("packages"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "packages": {}}


def _skill_listing_entry(skill_id: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    package = _read_package_registry().get("packages", {}).get(skill_id, {})
    installed = (AGENT_SKILLS_DIR / "packages" / skill_id / "SKILL.md").is_file()
    return {
        "skill_id": skill_id,
        "experience_id": entry.get("experience_id") or "",
        "lifecycle": entry.get("lifecycle") or "draft",
        "created_at": entry.get("created_at") or 0,
        "current_version": entry.get("current_version") or 0,
        "versions": [
            {"version": item.get("version"), "sha256": item.get("sha256"),
             "created_at": item.get("created_at"), "note": item.get("note")}
            for item in (entry.get("versions") or [])
        ],
        "installed": installed,
        "enabled": bool(package.get("enabled")) if package else False,
        "display_name": str(package.get("display_name") or package.get("name") or skill_id),
        "registry_version": str(package.get("version") or ""),
    }


@router.get("/profile")
async def get_profile():
    return STORE.read()


@router.put("/profile")
async def put_profile(payload: ProfileUpdateRequest):
    try:
        return STORE.update(payload.profile, payload.expected_revision)
    except DesignBrainError as error:
        return _error_response(error)


# ---------------------------------------------------------------------------
# 项目经验：候选 → 待审核 → 已发布 / 已拒绝
# ---------------------------------------------------------------------------

@router.get("/experiences")
async def list_experiences(status: str = ""):
    if status and status not in EXPERIENCE_STATUSES:
        raise HTTPException(status_code=400, detail="未知的经验状态")
    return {"experiences": EXPERIENCES.list(status)}


@router.get("/experiences/{experience_id}")
async def get_experience(experience_id: str):
    try:
        return {"experience": EXPERIENCES.get(experience_id)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/experiences")
async def create_experience(payload: ExperiencePayload):
    try:
        item = EXPERIENCES.create(payload.model_dump())
        return {"experience": item}
    except DesignBrainError as error:
        return _error_response(error)


@router.patch("/experiences/{experience_id}")
async def update_experience(experience_id: str, payload: ExperiencePayload):
    try:
        item = EXPERIENCES.update(experience_id, payload.model_dump(exclude_unset=True))
        return {"experience": item}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/experiences/{experience_id}/submit")
async def submit_experience(experience_id: str):
    try:
        return {"experience": EXPERIENCES.change_status(experience_id, "submit")}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/experiences/{experience_id}/reject")
async def reject_experience(experience_id: str, payload: ExperienceRejectRequest):
    try:
        return {"experience": EXPERIENCES.change_status(experience_id, "reject", payload.comment)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/experiences/{experience_id}/requeue")
async def requeue_experience(experience_id: str):
    try:
        return {"experience": EXPERIENCES.change_status(experience_id, "requeue")}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/experiences/{experience_id}/publish")
async def publish_experience(experience_id: str):
    """发布经验：唯一允许把经验写进审美档案的路径（显式用户动作）。"""
    try:
        current = EXPERIENCES.get(experience_id)
    except DesignBrainError as error:
        return _error_response(error)
    if current["status"] != "pending_review":
        return JSONResponse(status_code=409, content={
            "detail": "只有待审核经验可以发布", "code": "invalid_transition"})
    patch = (current.get("proposals") or {}).get("profile_patch") or []
    applied = []
    if patch:
        profile_state = STORE.read()
        profile = json.loads(json.dumps(profile_state.get("profile") or {}))
        aesthetics = profile.setdefault("aesthetics", {})
        for entry in patch:
            group = str(entry.get("group") or "style_tags")
            tag = str(entry.get("tag") or "").strip()
            if not tag:
                continue
            items = aesthetics.setdefault(group, [])
            if any(str(item.get("tag") or "") == tag for item in items):
                continue
            new_tag = {"tag": tag, "origin": f"experience:{experience_id}"}
            if group != "avoid_tags":
                new_tag["weight"] = float(entry.get("weight") or 0.6)
            items.append(new_tag)
            applied.append({"group": group, "tag": tag})
        if applied:
            try:
                STORE.update(profile, profile_state.get("revision"))
            except DesignBrainError as error:
                return _error_response(error)
    try:
        item = EXPERIENCES.change_status(experience_id, "publish")
        item = EXPERIENCES.mark_published_effects(experience_id, applied)
    except DesignBrainError as error:
        return _error_response(error)
    return {"experience": item, "applied_profile_tags": applied}


@router.delete("/experiences/{experience_id}")
async def delete_experience(experience_id: str):
    try:
        EXPERIENCES.delete(experience_id)
        return {"ok": True}
    except DesignBrainError as error:
        return _error_response(error)


# ---------------------------------------------------------------------------
# 参考素材库：本地批量导入 → 分类整理 → AI 设计分析（前端经 /api/canvas-llm
# 调用用户自选的视觉模型，结果回写这里）。AI 建议的分类存在 suggested 字段，
# 与用户填写的 classification 分离，只有用户显式保存才会覆盖。
# ---------------------------------------------------------------------------

REFERENCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024
REFERENCE_IMPORT_BATCH_MAX = 20
REFERENCE_THUMB_MAX_EDGE = 512
REFERENCE_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
}


def _origin_of(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except ValueError:
        return ""
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        return ""
    host = (parsed.hostname or "").lower()
    port = parsed.port
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    if port and port != default_port:
        host = f"{host}:{port}"
    return f"{parsed.scheme.lower()}://{host}"


def _ensure_same_origin(request: Request) -> None:
    """与 main.py 的 ensure_same_origin_request 同语义：改写类接口要求
    Origin/Referer 与当前服务一致，防止其它网站向本机接口伪造 multipart
    表单 POST（JSON 跨域已被 CORS 拦住，multipart 属于 simple request）。"""
    host = str(request.headers.get("host") or "").lower()
    if not host:
        return
    expected = f"{str(request.url.scheme).lower()}://{host}"
    actual = _origin_of(request.headers.get("origin", "")) or _origin_of(request.headers.get("referer", ""))
    if actual != expected:
        raise HTTPException(status_code=403, detail="只允许从本机页面操作参考素材")


def _reference_safe_path(relative: str) -> Optional[Path]:
    text = str(relative or "").strip().replace("\\", "/")
    if not text or text.startswith("/") or ".." in text.split("/"):
        return None
    path = (REFERENCES.root / text).resolve()
    root = REFERENCES.root.resolve()
    try:
        if os.path.commonpath([str(root), str(path)]) != str(root):
            return None
    except ValueError:
        return None
    return path


def _reference_atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".ref-upload-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _reference_prepare_thumb(source):
    from PIL import Image, ImageOps
    image = ImageOps.exif_transpose(source)
    image.thumbnail((REFERENCE_THUMB_MAX_EDGE, REFERENCE_THUMB_MAX_EDGE), Image.LANCZOS)
    if image.mode == "RGBA":
        base = Image.new("RGB", image.size, (255, 255, 255))
        base.paste(image, mask=image.split()[-1])
        return base
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def _reference_remove_files(relatives: List[str]) -> None:
    for relative in relatives:
        path = _reference_safe_path(relative)
        if not path:
            continue
        try:
            if path.is_file():
                os.remove(path)
            parent = path.parent
            if parent.is_dir() and not any(parent.iterdir()):
                os.rmdir(parent)
        except OSError:
            pass


def _reference_remove_media_tree() -> None:
    for name in ("media", "thumbs"):
        shutil.rmtree(REFERENCES.root / name, ignore_errors=True)


class ReferencePatchRequest(BaseModel):
    title: str = ""
    notes: str = ""
    favorite: Optional[bool] = None
    classification: Dict[str, Any] = Field(default_factory=dict)


class ReferenceBatchUpdateRequest(BaseModel):
    ids: List[str] = Field(default_factory=list, max_length=200)
    patch: Dict[str, Any] = Field(default_factory=dict)


class ReferenceBatchDeleteRequest(BaseModel):
    ids: List[str] = Field(default_factory=list, max_length=200)


class ReferenceAnalysisRequest(BaseModel):
    status: str
    content: Dict[str, str] = Field(default_factory=dict)
    suggested: Dict[str, Any] = Field(default_factory=dict)
    provider: str = ""
    model: str = ""
    error: str = ""


class ReferenceAnalysisEditRequest(BaseModel):
    content: Dict[str, str] = Field(default_factory=dict)


class ReferenceRemoteImportRequest(BaseModel):
    url: str = ""
    board: str = ""


@router.get("/references")
async def list_references(
    q: str = "", category: str = "", purpose: str = "", expression: str = "",
    tag: str = "", analysis: str = "", favorite: bool = False,
    limit: int = 200, offset: int = 0,
):
    filters = {key: value for key, value in {
        "q": q, "category": category, "purpose": purpose, "expression": expression,
        "tag": tag, "analysis": analysis, "favorite": favorite,
    }.items() if value not in ("", False)}
    try:
        data = REFERENCES.list(filters, limit, offset)
    except DesignBrainError as error:
        return _error_response(error)
    return {
        **data,
        "limit": limit, "offset": offset,
        "presets": {
            "category": list(REFERENCE_CATEGORY_PRESETS),
            "purpose": list(REFERENCE_PURPOSE_PRESETS),
            "expression": list(REFERENCE_EXPRESSION_PRESETS),
        },
    }


@router.post("/references/import")
async def import_references(
    request: Request,
    files: List[UploadFile] = File(...),
    meta: str = Form(""),
):
    """本地批量导入。前端按 20 张以内分批上传；单张失败不影响其余图片，
    结果逐张返回（imported/duplicate/failed），由前端汇总进度与失败列表。"""
    _ensure_same_origin(request)
    if not files:
        raise HTTPException(status_code=400, detail="请选择要导入的图片")
    if len(files) > REFERENCE_IMPORT_BATCH_MAX:
        raise HTTPException(status_code=400, detail=f"单次最多导入 {REFERENCE_IMPORT_BATCH_MAX} 张，请分批上传")
    metas: List[Dict[str, Any]] = []
    if str(meta or "").strip():
        try:
            parsed = json.loads(meta)
            if isinstance(parsed, list):
                metas = [item if isinstance(item, dict) else {} for item in parsed]
        except ValueError:
            metas = []
    results = []
    for index, upload in enumerate(files):
        raw_name = os.path.basename(str(upload.filename or "").replace("\\", "/"))
        info = metas[index] if index < len(metas) else {}
        rel_path = str(info.get("path") or "").replace("\\", "/").strip("/")
        folder = str(info.get("folder") or "").strip()
        if not folder and "/" in rel_path:
            folder = "/".join(rel_path.split("/")[:-1])
        folder = folder.strip()[:REFERENCE_FOLDER_MAX]
        try:
            ext = os.path.splitext(raw_name)[1].lower()
            if ext not in REFERENCE_FILE_EXTS:
                raise ValueError(f"不支持的图片类型（支持 jpg/png/webp/gif/bmp）：{raw_name or '未命名文件'}")
            payload = bytearray()
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > REFERENCE_UPLOAD_MAX_BYTES:
                    raise ValueError(f"图片超过 100 MB：{raw_name}")
            if not payload:
                raise ValueError(f"文件内容为空：{raw_name}")
            digest = hashlib.sha256(bytes(payload)).hexdigest()
            existing = REFERENCES.find_by_hash(digest)
            if existing:
                results.append({"status": "duplicate", "name": raw_name, "id": existing["id"],
                                "duplicate_of": existing["id"], "title": existing["title"]})
                continue
            media_rel = f"media/{digest[:2]}/{digest}{ext}"
            _reference_atomic_write(_reference_safe_path(media_rel), bytes(payload))
            width = height = thumb_width = thumb_height = 0
            thumb_rel = ""
            try:
                from PIL import Image
                with Image.open(_reference_safe_path(media_rel)) as source:
                    width, height = int(source.width or 0), int(source.height or 0)
                    thumb = _reference_prepare_thumb(source)
                    thumb_width, thumb_height = int(thumb.width or 0), int(thumb.height or 0)
                    thumb_path = _reference_safe_path(f"thumbs/{digest[:2]}/{digest}.jpg")
                    if thumb_path:
                        thumb_path.parent.mkdir(parents=True, exist_ok=True)
                        thumb.save(thumb_path, format="JPEG", quality=85)
                        thumb_rel = f"thumbs/{digest[:2]}/{digest}.jpg"
            except Exception:
                # 原图已保存；尺寸/缩略图失败不阻塞导入，展示时回退原图。
                thumb_rel, thumb_width, thumb_height = "", 0, 0
            item = REFERENCES.create({
                "hash": digest,
                "file": {
                    "name": raw_name, "ext": ext, "size": len(payload),
                    "width": width, "height": height,
                    "media": media_rel, "thumb": thumb_rel,
                    "thumb_width": thumb_width, "thumb_height": thumb_height,
                },
                "source": {"type": "local", "folder": folder},
            })
            results.append({"status": "imported", "name": raw_name, "id": item["id"], "title": item["title"]})
        except DesignBrainError as error:
            if error.code == "duplicate_reference":
                # create 前已查过哈希；到这里说明并发导入同图，按重复处理。
                results.append({"status": "duplicate", "name": raw_name, "error": error.message})
                continue
            results.append({"status": "failed", "name": raw_name, "error": error.message})
        except ValueError as exc:
            results.append({"status": "failed", "name": raw_name, "error": str(exc)[:REFERENCE_ERROR_MAX]})
        except Exception as exc:  # 读取/写盘异常按单张失败处理，不中断批次
            results.append({"status": "failed", "name": raw_name, "error": f"读取失败：{exc}"[:REFERENCE_ERROR_MAX]})
    return {"ok": True, "count": len(files), "results": results}


@router.post("/references/import-remote")
async def import_references_remote(payload: ReferenceRemoteImportRequest, request: Request):
    """预留的花瓣等远程链接导入入口。花瓣没有公开可用的开放 API，本阶段
    不做任何自动抓取；接口保留给未来经核实的导入方式（source.url/board）。"""
    _ensure_same_origin(request)
    return JSONResponse(status_code=501, content={
        "code": "remote_import_not_supported",
        "detail": "花瓣没有公开可用的 API，本版本不实现自动抓取。请手动下载图片后使用「导入图片」；原始链接可粘贴到图片详情的备注中保存（source.url 字段已预留）。",
    })


@router.post("/references/batch-update")
async def batch_update_references(payload: ReferenceBatchUpdateRequest, request: Request):
    _ensure_same_origin(request)
    if not payload.ids:
        raise HTTPException(status_code=400, detail="请先选择参考素材")
    try:
        updated = REFERENCES.update_many(payload.ids, payload.patch)
    except DesignBrainError as error:
        return _error_response(error)
    return {"ok": True, "updated": len(updated), "references": updated}


@router.post("/references/batch-delete")
async def batch_delete_references(payload: ReferenceBatchDeleteRequest, request: Request):
    _ensure_same_origin(request)
    if not payload.ids:
        raise HTTPException(status_code=400, detail="请先选择参考素材")
    try:
        removed = REFERENCES.delete_many(payload.ids)
    except DesignBrainError as error:
        return _error_response(error)
    _reference_remove_files(REFERENCES.media_paths_for(removed))
    return {"ok": True, "deleted": len(removed)}


@router.get("/references/{item_id}/image")
async def reference_image(item_id: str, variant: str = "thumb"):
    try:
        item = REFERENCES.get(item_id)
    except DesignBrainError as error:
        return _error_response(error)
    file_info = item.get("file") or {}
    relative = str(file_info.get("thumb") if variant == "thumb" else "").strip() or str(file_info.get("media") or "")
    path = _reference_safe_path(relative)
    if not path or not path.is_file():
        path = _reference_safe_path(str(file_info.get("media") or ""))
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="参考图片文件缺失，可能已被移动或删除")
    return FileResponse(
        str(path),
        media_type=REFERENCE_CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.patch("/references/{item_id}")
async def update_reference(item_id: str, payload: ReferencePatchRequest, request: Request):
    _ensure_same_origin(request)
    try:
        return {"reference": REFERENCES.update(item_id, payload.model_dump(exclude_unset=True))}
    except DesignBrainError as error:
        return _error_response(error)


@router.delete("/references/{item_id}")
async def delete_reference(item_id: str, request: Request):
    _ensure_same_origin(request)
    try:
        removed = REFERENCES.delete(item_id)
    except DesignBrainError as error:
        return _error_response(error)
    _reference_remove_files(REFERENCES.media_paths_for([removed]))
    return {"ok": True}


@router.post("/references/{item_id}/analysis")
async def set_reference_analysis(item_id: str, payload: ReferenceAnalysisRequest, request: Request):
    """AI 分析结果回写：ready 保存分析内容与建议分类；failed 记录失败原因；
    pending 仅标记状态。分析调用本身由前端经 /api/canvas-llm 完成。"""
    _ensure_same_origin(request)
    if payload.status == "ready" and not any(str(value or "").strip() for value in payload.content.values()):
        raise HTTPException(status_code=422, detail="分析结果内容不能为空")
    if payload.status == "failed" and not payload.error.strip():
        raise HTTPException(status_code=422, detail="请填写分析失败原因")
    try:
        item = REFERENCES.set_analysis(
            item_id, payload.status, content=payload.content, suggested=payload.suggested,
            provider=payload.provider, model=payload.model, error=payload.error,
        )
    except DesignBrainError as error:
        return _error_response(error)
    return {"reference": item}


@router.patch("/references/{item_id}/analysis")
async def edit_reference_analysis(item_id: str, payload: ReferenceAnalysisEditRequest, request: Request):
    """用户修改分析内容：只更新 content 字段并打 edited 标记，AI 原始建议
    可通过重新分析恢复；修改不会被下一次 ready 结果覆盖 edited 标记的语义
    由前端展示（edited=True 表示用户改过）。"""
    _ensure_same_origin(request)
    try:
        return {"reference": REFERENCES.edit_analysis(item_id, payload.content)}
    except DesignBrainError as error:
        return _error_response(error)


# ---------------------------------------------------------------------------
# 设计大脑 Skill：读取走这里；生成/编辑/发布/回退在 main.py（复用 agent-skills 锁）
# ---------------------------------------------------------------------------

@router.get("/skills")
async def list_design_brain_skills():
    return {"skills": [_skill_listing_entry(skill_id, entry) for skill_id, entry in SKILL_LINKS.list().items()]}


@router.get("/skills/{skill_id}")
async def get_design_brain_skill(skill_id: str):
    try:
        entry = SKILL_LINKS.get(skill_id)
    except DesignBrainError as error:
        return _error_response(error)
    listing = _skill_listing_entry(skill_id, entry)
    content = ""
    skill_path = AGENT_SKILLS_DIR / "packages" / skill_id / "SKILL.md"
    try:
        content = skill_path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        content = ""
    return {"skill": {**listing, "content": content}}


# ---------------------------------------------------------------------------
# 设计任务执行记录：方案确认 → 执行（沿用 canvas 节点工作流）→ 终态。
# 生图任务的 design_run_id 由 main.py 在任务终态时回写 note_task。
# ---------------------------------------------------------------------------

class RunCreateRequest(BaseModel):
    title: str = ""
    brief: str = ""
    canvas_id: str = ""
    project_id: str = ""
    profile_revision: int = 0
    profile_summary: Dict[str, Any] = Field(default_factory=dict)
    case_ids: list = Field(default_factory=list)
    skill: Dict[str, Any] = Field(default_factory=dict)
    plan: Dict[str, Any] = Field(default_factory=dict)


class RunConfirmRequest(BaseModel):
    selected_index: int = 0


class RunCompleteRequest(BaseModel):
    success: bool = False
    error: str = ""
    note: str = ""
    node_ids: list = Field(default_factory=list)


class RunEventRequest(BaseModel):
    type: str = "info"
    note: str = ""


@router.get("/runs")
async def list_runs(canvas_id: str = "", project_id: str = "", limit: int = 50):
    return {"runs": RUNS.list(canvas_id, project_id, limit)}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    try:
        return {"run": RUNS.get(run_id)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/runs")
async def create_run(payload: RunCreateRequest):
    try:
        return {"run": RUNS.create(payload.model_dump())}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/runs/{run_id}/confirm")
async def confirm_run(run_id: str, payload: RunConfirmRequest):
    try:
        return {"run": RUNS.confirm(run_id, payload.selected_index)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    try:
        return {"run": RUNS.cancel(run_id)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/runs/{run_id}/complete")
async def complete_run(run_id: str, payload: RunCompleteRequest):
    try:
        return {"run": RUNS.complete(run_id, payload.success, payload.error, payload.note, payload.node_ids)}
    except DesignBrainError as error:
        return _error_response(error)


@router.post("/runs/{run_id}/events")
async def add_run_event(run_id: str, payload: RunEventRequest):
    try:
        return {"run": RUNS.note_event(run_id, payload.type, payload.note)}
    except DesignBrainError as error:
        return _error_response(error)


# ---------------------------------------------------------------------------
# 阶段 4：质量评价、Skill 效果统计、对照比较与个人数据导出/删除。
# 评价创建在 main.py（需要读历史记录与本地图片检查）；这里是无副作用的
# 读取、删除、聚合与建议。
# ---------------------------------------------------------------------------

@router.get("/reviews")
async def list_reviews(skill_id: str = "", run_id: str = "", limit: int = 100):
    return {"reviews": REVIEWS.list(skill_id, run_id, limit)}


@router.get("/reviews/compare")
async def compare_reviews(a: str, b: str):
    try:
        left = REVIEWS.get(a)
        right = REVIEWS.get(b)
    except DesignBrainError as error:
        return _error_response(error)
    return {"comparison": review_comparability(left, right), "left": left, "right": right}


@router.delete("/reviews/{review_id}")
async def delete_review(review_id: str):
    try:
        REVIEWS.delete(review_id)
        return {"ok": True}
    except DesignBrainError as error:
        return _error_response(error)


@router.get("/skills/{skill_id}/stats")
async def get_skill_stats(skill_id: str):
    reviews = REVIEWS.list(skill_id=skill_id, limit=REVIEW_LIST_MAX)
    stats = compute_skill_review_stats(reviews)
    try:
        link = SKILL_LINKS.get(skill_id)
    except DesignBrainError:
        link = None
    suggestion = skill_improvement_suggestion(
        {"skill_id": skill_id, "name": (link or {}).get("display_name") or skill_id},
        reviews,
    )
    return {"skill_id": skill_id, "stats": stats, "suggestion": suggestion, "reviews": reviews[:20]}


@router.post("/skills/{skill_id}/suggest-experience")
async def suggest_experience_from_reviews(skill_id: str):
    """把低分评价转化为候选经验建议；只创建 candidate，绝不改 Skill。"""
    reviews = REVIEWS.list(skill_id=skill_id, limit=REVIEW_LIST_MAX)
    try:
        link = SKILL_LINKS.get(skill_id)
        display_name = (link or {}).get("display_name") or skill_id
    except DesignBrainError:
        display_name = skill_id
    suggestion = skill_improvement_suggestion({"skill_id": skill_id, "name": display_name}, reviews)
    if not suggestion:
        raise HTTPException(status_code=409, detail="该 Skill 暂不满足生成优化建议的条件（至少 3 条评价且持续低分）")
    try:
        experience = EXPERIENCES.create({
            "title": f"优化建议：{display_name}",
            "origin": {"type": "manual", "note": f"来自 Skill「{display_name}」的低分评价（{suggestion['reason']}）"},
            "observations": suggestion["observations"],
            "evidence": {
                "history_timestamps": [entry.get("history_timestamp") for entry in suggestion["evidence"] if entry.get("history_timestamp")],
                "asset_refs": [{"url": entry.get("url")} for entry in suggestion["evidence"] if entry.get("url")],
            },
            "proposals": {"profile_patch": []},
        })
    except DesignBrainError as error:
        return _error_response(error)
    return {"experience": experience, "suggestion": suggestion}


@router.get("/export")
async def export_design_brain_data():
    """个人数据导出：仅本机下载的 JSON 快照，不包含任何密钥或图片字节。"""
    profile_state = STORE.read()
    skill_links_export = {}
    for skill_id, entry in SKILL_LINKS.list().items():
        skill_links_export[skill_id] = {
            **entry,
            "versions": [
                {key: value for key, value in version.items() if key != "content"}
                for version in (entry.get("versions") or [])
            ],
        }
    bundle = {
        "format": "xiaomei-design-brain-export",
        "version": 1,
        "exported_at": now_ms(),
        "profile": {"revision": profile_state.get("revision"), "profile": profile_state.get("profile")},
        "references": REFERENCES.list(limit=REFERENCE_ITEM_LIST_MAX).get("items", []),
        "experiences": EXPERIENCES.list(),
        "skill_links": skill_links_export,
        "runs": RUNS.list(limit=200),
        "reviews": REVIEWS.list(limit=REVIEW_LIST_MAX),
        "agent_tasks": AGENT_TASKS.list(limit=100),
    }
    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="design-brain-export-{bundle["exported_at"]}.json"'},
    )


DATA_DELETE_SCOPES = ("profile", "references", "experiences", "runs", "reviews", "skill_links", "agent_tasks", "all")


class DataDeleteRequest(BaseModel):
    scope: str = "all"
    confirm: str = ""


@router.post("/data/delete")
async def delete_design_brain_data(payload: DataDeleteRequest):
    """删除个人设计大脑数据；必须显式输入确认文字。物理 Skill 包不在此列。"""
    if payload.confirm != "删除":
        raise HTTPException(status_code=400, detail="请在确认框中输入「删除」两个字")
    scope = str(payload.scope or "all").strip()
    if scope not in DATA_DELETE_SCOPES:
        raise HTTPException(status_code=400, detail="未知的删除范围")
    cleared = []
    if scope in ("profile", "all"):
        STORE.update(normalize_profile({}), expected_revision=None)
        cleared.append("profile")
    if scope in ("references", "all"):
        REFERENCES.clear()
        _reference_remove_media_tree()
        cleared.append("references")
    if scope in ("experiences", "all"):
        EXPERIENCES.clear()
        cleared.append("experiences")
    if scope in ("runs", "all"):
        RUNS.clear()
        cleared.append("runs")
    if scope in ("reviews", "all"):
        REVIEWS.clear()
        cleared.append("reviews")
    if scope in ("skill_links", "all"):
        SKILL_LINKS.clear()
        cleared.append("skill_links")
    if scope in ("agent_tasks", "all"):
        AGENT_TASKS.clear()
        cleared.append("agent_tasks")
    return {"ok": True, "scope": scope, "cleared": cleared,
            "note": "物理 Skill 包仍在技能市场管理；删除「参考素材」会连同其媒体文件一起清理，不影响图片空间与历史记录。删除「设计任务」只清空任务记录，不影响历史记录。"}
