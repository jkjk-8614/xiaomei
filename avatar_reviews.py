"""Commit avatar review receipts to the current asset library."""

from fastapi import HTTPException


def _registrations(item):
    registrations = item.get("registrations")
    return registrations if isinstance(registrations, dict) else {}


def _registration(item, platform):
    row = _registrations(item).get(platform)
    return row if isinstance(row, dict) else {}


def _task_identity(row):
    return tuple(row.get(key) for key in ("task_id", "provider_id", "project_name", "registered_at"))


def _media_identity(item):
    return item.get("url"), item.get("kind")


class AvatarReviews:
    def __init__(self, load, save, find, lock, now):
        self._load = load
        self._save = save
        self._find = find
        self._lock = lock
        self._now = now
        self._submitting = set()
        self._polling = {}

    def _read(self, library_id, item_id, category_id, source_url):
        library = self._load()
        owner, category, item = self._find(library, item_id, library_id, category_id, source_url)
        if item is None:
            raise HTTPException(status_code=404, detail="资产不存在")
        return library, owner["id"], category.get("id") or "", item

    def _save_review(self, library, item, platform, review):
        item["registrations"] = {**_registrations(item), platform: review}
        self._save(library)

    async def submit(self, library_id, item_id, platform, provider_id, project, upload, *, category_id="", source_url=None):
        with self._lock:
            _, owner, group, item = self._read(library_id, item_id, category_id, source_url)
            key = (owner, group, item_id, item.get("url"), platform)
            if key in self._submitting:
                raise HTTPException(status_code=409, detail="该素材正在提交审核，请稍后查询")
            self._submitting.add(key)
            source = _media_identity(item)
            media = {field: item.get(field) for field in ("url", "name", "kind")}
        try:
            task_id = await upload(media)
            with self._lock:
                library, _, _, item = self._read(owner, item_id, group, source_url)
                if _media_identity(item) != source:
                    raise HTTPException(status_code=409, detail="审核提交期间素材已更换，请刷新素材库")
                self._save_review(library, item, platform, {
                    "provider_id": provider_id, "project_name": project, "task_id": task_id,
                    "status": "Processing", "detail": "已提交，审核中", "asset_uri": "",
                    "asset_id": "", "registered_at": self._now(),
                })
            return {"library": library, "item": item}
        finally:
            with self._lock:
                self._submitting.discard(key)

    async def status(self, library_id, item_id, platform, query, *, category_id="", source_url=None):
        poll = object()
        with self._lock:
            _, owner, group, item = self._read(library_id, item_id, category_id, source_url)
            key = (owner, group, item_id, item.get("url"), platform)
            review = _registration(item, platform)
            task_id = str(review.get("task_id") or "").strip()
            if not task_id:
                raise HTTPException(status_code=400, detail="该素材还没有提交到这个平台的认证审核。")
            identity = _task_identity(review)
            source = _media_identity(item)
            self._polling[key] = poll
            provider_id = str(review.get("provider_id") or "").strip()
            project = str(review.get("project_name") or "default").strip() or "default"
        try:
            result = await query(task_id, provider_id, project)
            with self._lock:
                library, _, _, item = self._read(owner, item_id, group, source_url)
                review = _registration(item, platform)
                current = self._polling.get(key) is poll and _task_identity(review) == identity
                if current and _media_identity(item) == source:
                    state = result["status"]
                    if state != "Processing" or review.get("status") not in ("Active", "Failed"):
                        uri = (result.get("asset_uri") or "") if state == "Active" else ""
                        updated = {**review, "status": state, "detail": result.get("detail") or "",
                                   "asset_uri": uri, "asset_id": uri.removeprefix("asset://")}
                        self._save_review(library, item, platform, updated)
                return {"library": library, "item": item}
        finally:
            with self._lock:
                if self._polling.get(key) is poll:
                    self._polling.pop(key)
