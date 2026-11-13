"""Volcengine Ark private asset requests and status decoding."""

import asyncio
import datetime
import hashlib
import hmac
import json
from urllib.parse import quote
from weakref import WeakValueDictionary

from fastapi import HTTPException


HOST = "ark.cn-beijing.volcengineapi.com"
REGION = "cn-beijing"
SERVICE = "ark"
VERSION = "2024-01-01"
_GROUP_LOCKS = WeakValueDictionary()


def _query(action, version):
    params = {"Action": action, "Version": version}
    return "&".join(f"{key}={quote(params[key], safe='')}" for key in sorted(params))


def signed_headers(access_key, secret_key, action, body, *, timestamp=None,
                   host=HOST, region=REGION, service=SERVICE, version=VERSION):
    timestamp = timestamp or datetime.datetime.now(datetime.timezone.utc)
    date = timestamp.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    digest = hashlib.sha256(body).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "Host": host,
        "X-Date": date,
        "X-Content-Sha256": digest,
    }
    canonical = sorted((name.lower(), value) for name, value in headers.items())
    names = ";".join(name for name, _ in canonical)
    fields = "".join(f"{name}:{value}\n" for name, value in canonical)
    request = "\n".join(("POST", "/", _query(action, version), fields, names, digest))
    components = (date[:8], region, service, "request")
    scope = "/".join(components)
    key = secret_key.encode("utf-8")
    for value in components:
        key = hmac.digest(key, value.encode("utf-8"), "sha256")
    algorithm = "HMAC-SHA256"
    request_digest = hashlib.sha256(request.encode("utf-8")).hexdigest()
    message = "\n".join((algorithm, date, scope, request_digest)).encode("utf-8")
    signature = hmac.digest(key, message, "sha256").hex()
    headers["Authorization"] = (
        f"{algorithm} Credential={access_key}/{scope}, SignedHeaders={names}, Signature={signature}"
    )
    return headers


def _asset_id(result, action):
    identifier = str(result.get("Id") or "").strip()
    if not identifier:
        raise HTTPException(status_code=502, detail=f"火山 {action} 响应缺少素材 ID")
    return identifier


class ArkAssets:
    def __init__(self, client, access_key, secret_key):
        if not (access_key and secret_key):
            raise HTTPException(status_code=400, detail="未配置火山引擎 AK/SK，请在 API 设置中填写 Access Key ID / Secret Access Key。")
        self._client = client
        self._access_key = access_key
        self._secret_key = secret_key

    async def _call(self, action, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = signed_headers(self._access_key, self._secret_key, action, body)
        response = await self._client.post(f"https://{HOST}/?{_query(action, VERSION)}",
                                           headers=headers, content=body, timeout=120)
        try:
            data = response.json()
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"火山 {action} 返回非 JSON（HTTP {response.status_code}）") from exc
        if not isinstance(data, dict):
            raise HTTPException(status_code=502, detail=f"火山 {action} 返回无效响应")
        metadata = data.get("ResponseMetadata")
        error = metadata.get("Error") if isinstance(metadata, dict) else None
        if isinstance(error, dict):
            reason = " ".join(str(value) for value in (error.get("Code") or error.get("CodeN"), error.get("Message")) if value)
            raise HTTPException(status_code=502, detail=f"火山 {action} 失败：{reason[:300]}")
        if response.is_error:
            raise HTTPException(status_code=502, detail=f"火山 {action} 失败（HTTP {response.status_code}）")
        result = data.get("Result")
        if isinstance(result, dict):
            return result
        if "Result" not in data and "ResponseMetadata" not in data:
            return data
        raise HTTPException(status_code=502, detail=f"火山 {action} 响应缺少 Result")

    async def _group(self, project, name):
        filters = {"Name": name, "GroupType": "AIGC"}
        page = {"Filter": filters, "ProjectName": project, "MaxResults": 50}
        seen_tokens = set()
        while True:
            result = await self._call("ListAssetGroups", page)
            items = result.get("Items")
            if not isinstance(items, list):
                raise HTTPException(status_code=502, detail="火山 ListAssetGroups 响应缺少素材组列表")
            for group in items:
                if (isinstance(group, dict) and str(group.get("Name") or "").strip() == name
                        and str(group.get("ProjectName") or "default").strip() == project):
                    return _asset_id(group, "ListAssetGroups")
            token = result.get("NextToken")
            if not token:
                break
            if not isinstance(token, str) or token in seen_tokens:
                raise HTTPException(status_code=502, detail="火山素材组列表返回了无效的翻页凭证")
            seen_tokens.add(token)
            page["NextToken"] = token
        created = await self._call("CreateAssetGroup", {"Name": name, "Description": name, "ProjectName": project})
        return _asset_id(created, "CreateAssetGroup")

    async def submit(self, url, name, kind, project, group_name):
        group = (str(group_name or "").strip() or "可信素材")[:60]
        key = (asyncio.get_running_loop(), self._access_key, project, group)
        async with _GROUP_LOCKS.setdefault(key, asyncio.Lock()):
            group_id = await self._group(project, group)
        created = await self._call("CreateAsset", {
            "ProjectName": project, "GroupId": group_id, "URL": url,
            "Name": (name or "asset")[:60], "AssetType": {"video": "Video", "audio": "Audio"}.get(kind, "Image"),
        })
        return _asset_id(created, "CreateAsset")

    async def status(self, task_id, project):
        asset = await self._call("GetAsset", {"ProjectName": project, "Id": task_id})
        state = str(asset.get("Status") or "").strip().lower()
        if state == "active":
            return {"status": "Active", "asset_uri": f"asset://{task_id}", "detail": ""}
        if state == "failed":
            return {"status": "Failed", "asset_uri": "", "detail": "火山素材处理失败，无法用于推理。"}
        return {"status": "Processing", "asset_uri": "", "detail": "火山素材处理中"}
