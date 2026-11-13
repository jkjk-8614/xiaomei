"""RunningHub task protocol for workflow, application, and model requests."""

import asyncio
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass

import httpx
from fastapi import HTTPException


LEGACY_OUTPUTS = "/task/openapi/outputs"
LEGACY_UPLOAD = "/task/openapi/upload"
SUCCESS_STATES = frozenset({"success", "succeeded", "completed", "complete", "finished", "finish", "done", "3"})
FAILURE_STATES = frozenset({"failed", "fail", "error", "cancel", "canceled", "cancelled", "4"})
_LEGACY_STATES = {"0": "SUCCESS", "804": "RUNNING", "813": "QUEUED", "805": "FAILED"}
_OUTPUT_FIELDS = ("fileUrl", "file_url", "url", "downloadUrl", "download_url", "imageUrl", "image_url", "videoUrl", "video_url")
_OUTPUT_LISTS = ("outputs", "results", "files", "result", "output", "images", "videos", "data")
_ALLOWED_URLS = ("https://", "http://", "/output/", "/assets/", "/api/storage-files/")


def as_mapping(value):
    return value if isinstance(value, Mapping) else {}


def _lookup(record, keys):
    for key in keys:
        value = record.get(key)
        if value is not None and value != "":
            return value
    return None


def _envelopes(raw):
    root = as_mapping(raw)
    return root, as_mapping(root.get("data"))


def task_id(raw):
    for record in _envelopes(raw):
        for key in ("taskId", "task_id", "id"):
            value = record.get(key)
            if isinstance(value, (str, int)) and not isinstance(value, bool) and value:
                return str(value).strip()
    return ""


def task_status(raw):
    for record in _envelopes(raw):
        state = _lookup(record, ("status", "state", "taskStatus", "task_status"))
        if state is not None:
            return str(state).strip().lower()
    return ""


def failure_detail(raw):
    root, data = _envelopes(raw)
    fields = (
        (data, ("failedReason", "failReason", "message", "error", "errorMessage")),
        (root, ("msg", "message", "error", "errorMessage", "failedReason", "failReason")),
    )
    for record, keys in fields:
        for key in keys:
            value = record.get(key)
            if not value:
                continue
            if isinstance(value, Mapping):
                value = _lookup(value, ("exception_message", "message")) or json.dumps(value, ensure_ascii=False)
            return str(value)
    code = root.get("errorCode")
    if code and str(code) != "0":
        return f"RunningHub errorCode={code}"
    return ""


def _output_values(value, depth=0):
    if depth > 6:
        return
    if isinstance(value, (list, tuple)):
        for entry in value:
            yield from _output_values(entry, depth + 1)
    elif isinstance(value, Mapping):
        if value.get("type") in ("url", "b64"):
            yield value
            return
        for key in _OUTPUT_LISTS:
            if key in value:
                entries = list(_output_values(value[key], depth + 1))
                if entries:
                    yield from entries
                    return
        url = _lookup(value, _OUTPUT_FIELDS)
        if url is not None:
            for address in url if isinstance(url, list) else (url,):
                yield {"type": "url", "value": address}
    elif isinstance(value, str):
        yield {"type": "url", "value": value}


def output_urls(raw, rewrite):
    ordered = []
    for item in _output_values(raw):
        address = item.get("value")
        if item.get("type") == "url" and isinstance(address, str) and address.strip().startswith(_ALLOWED_URLS):
            ordered.append(rewrite(address.strip()))
    return ordered


def image_output(raw, rewrite, fallback):
    if not isinstance(raw, Mapping):
        raise HTTPException(status_code=502, detail="RunningHub 返回格式不是 JSON 对象")
    for item in _output_values(raw):
        value = item.get("value")
        if not isinstance(value, str) or not value:
            continue
        if item.get("type") == "b64":
            return {"type": "b64", "value": value, "mime_type": item.get("mime_type") or "image/png"}
        if value.strip().startswith(_ALLOWED_URLS):
            return {"type": "url", "value": rewrite(value.strip())}
    image = fallback(raw)
    return {**image, "value": rewrite(image.get("value"))} if image.get("type") == "url" else image


@dataclass(frozen=True)
class LegacyOutput:
    raw: dict
    code: int | str | None
    status: str
    urls: list[str]


class LegacyTasks:
    def __init__(self, client, endpoint, key, headers, rewrite):
        self.client = client
        self.endpoint = endpoint
        self.key = key
        self.headers = headers
        self.rewrite = rewrite

    def _safe_detail(self, text):
        value = str(text)
        return value.replace(self.key, "[已隐藏]") if self.key else value

    async def _post(self, path, payload, action, *, files=None):
        headers = dict(self.headers)
        request = {"json": payload}
        if files is not None:
            headers.pop("Content-Type", None)
            request = {"data": payload, "files": files}
        try:
            response = await self.client.post(self.endpoint(path), headers=headers, **request)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{action}失败：{self._safe_detail(exc)}") from exc
        try:
            raw = response.json()
        except ValueError as exc:
            code = response.status_code if response.status_code >= 400 else 502
            raise HTTPException(status_code=code, detail=f"{action}返回了非 JSON 响应") from exc
        if response.status_code >= 400:
            detail = failure_detail(raw) or f"HTTP {response.status_code}"
            raise HTTPException(status_code=response.status_code, detail=f"{action}失败：{self._safe_detail(detail)}")
        if not isinstance(raw, dict):
            raise HTTPException(status_code=502, detail=f"{action}返回格式无效")
        return raw

    async def submit(self, kind, entry_id, fields, *, instance_type="", workflow="", rejection_status=400):
        app = kind == "app"
        path = "/task/openapi/ai-app/run" if app else "/task/openapi/create"
        action = "提交 RunningHub 任务" if app else "提交 RunningHub 工作流"
        body = {"apiKey": self.key, ("webappId" if app else "workflowId"): entry_id}
        if app or fields:
            body["nodeInfoList"] = fields
        if not app:
            body["addMetadata"] = True
            if workflow:
                body["workflow"] = workflow
        if instance_type:
            body["instanceType"] = instance_type
        raw = await self._post(path, body, action)
        if str(raw.get("code")) != "0":
            reason = self._safe_detail(failure_detail(raw) or f"code={raw.get('code')}")
            raise HTTPException(status_code=rejection_status, detail=f"{action}失败：{reason}")
        accepted = task_id(as_mapping(raw.get("data")))
        if not accepted:
            raise HTTPException(status_code=502, detail=f"{action}未返回 taskId")
        return accepted, raw

    async def app_info(self, app_id):
        url = self.endpoint("/api/webapp/apiCallDemo")
        headers = {name: value for name, value in self.headers.items() if name.lower() != "content-type"}
        try:
            response = await self.client.get(url, params={"apiKey": self.key, "webappId": app_id}, headers=headers)
            raw = response.json()
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            raise HTTPException(status_code=502, detail="无法读取 RunningHub 应用参数") from exc
        code = as_mapping(raw).get("code")
        if response.status_code >= 400 or code not in (0, "0", None):
            status = response.status_code if response.status_code >= 400 else 400
            reason = self._safe_detail(failure_detail(raw) or f"HTTP {response.status_code}")
            raise HTTPException(status_code=status, detail=f"RunningHub 应用参数读取失败。{reason}")
        return as_mapping(raw).get("data") or {}

    async def workflow_graph(self, workflow_id):
        action = "拉取 RunningHub 工作流参数"
        body = {"apiKey": self.key, "workflowId": workflow_id}
        raw = await self._post("/api/openapi/getJsonApiFormat", body, action)
        if str(raw.get("code")) != "0":
            detail = self._safe_detail(failure_detail(raw) or f"code={raw.get('code')}")
            raise HTTPException(status_code=400, detail=f"{action}失败：{detail}")
        graph = as_mapping(raw.get("data")).get("prompt")
        if isinstance(graph, str) and graph.strip():
            try:
                graph = json.loads(graph)
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="RunningHub 工作流 JSON 解析失败") from exc
        return graph if isinstance(graph, dict) else {}, raw

    async def query(self, identifier):
        raw = await self._post(LEGACY_OUTPUTS, {"apiKey": self.key, "taskId": identifier}, "查询 RunningHub 任务")
        code = raw.get("code")
        state = _LEGACY_STATES.get(str(code), "UNKNOWN")
        urls = output_urls(raw.get("data"), self.rewrite) if state == "SUCCESS" else []
        return LegacyOutput(raw, code, state, urls)

    async def upload(self, filename, content, content_type, *, rejection_status=400):
        raw = await self._post(
            LEGACY_UPLOAD, {"apiKey": self.key, "fileType": "input"}, "上传素材到 RunningHub",
            files={"file": (filename, content, content_type)},
        )
        data = as_mapping(raw.get("data"))
        if str(raw.get("code")) == "0" and data.get("fileName"):
            return {"fileName": data["fileName"], "fileType": data.get("fileType") or content_type}
        reason = self._safe_detail(failure_detail(raw) or f"code={raw.get('code')}")
        raise HTTPException(status_code=rejection_status, detail=f"RunningHub 上传失败：{reason}")


async def _poll(fetch, completed, identifier, *, interval, timeout):
    deadline = time.monotonic() + timeout
    while (remaining := deadline - time.monotonic()) > 0:
        await asyncio.sleep(min(interval, remaining))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            result = await asyncio.wait_for(fetch(), remaining)
        except TimeoutError:
            break
        if completed(result):
            return result
    raise HTTPException(status_code=504, detail=f"RunningHub 任务超时：{identifier}")


async def wait_legacy(tasks, identifier, *, interval=2.5, timeout=1800):
    def completed(reply):
        if reply.status == "FAILED":
            reason = failure_detail(reply.raw) or identifier
            raise HTTPException(status_code=502, detail=f"RunningHub 任务失败：{tasks._safe_detail(reason)}")
        return reply.status == "SUCCESS"

    return await _poll(lambda: tasks.query(identifier), completed, identifier, interval=interval, timeout=timeout)


async def wait_model(client, query_url, headers, identifier, has_output, *, interval=3, timeout=1800):
    async def fetch():
        response = await client.post(query_url, headers=headers, json={"taskId": identifier})
        response.raise_for_status()
        try:
            raw = response.json()
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="RunningHub 查询任务返回了非 JSON 响应") from exc
        if not isinstance(raw, dict):
            raise HTTPException(status_code=502, detail="RunningHub 查询任务返回格式无效")
        return raw

    def completed(raw):
        state = task_status(raw)
        if state in FAILURE_STATES:
            reason = failure_detail(raw) or identifier
            raise HTTPException(status_code=502, detail=f"RunningHub 任务失败：{reason}")
        return state in SUCCESS_STATES or has_output(raw)

    return await _poll(fetch, completed, identifier, interval=interval, timeout=timeout)
