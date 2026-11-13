"""Discover and resolve RunningHub model IDs and their generation endpoints."""

import json
import re
from pathlib import Path

import httpx


_RECORDS = ("models", "list", "items", "records", "data")
_LABELS = ("name_cn", "name_zh", "zh_name", "cn_name", "display_name", "displayName",
           "title", "label", "nameCn", "nameZh", "chinese_name", "chineseName")
_KINDS = {"image": "image", "video": "video", "chat": "chat", "llm": "chat", "text": "chat"}
_FAMILY_ENDPOINTS = {
    "gpt-image-2.0": ("rhart-image-g-2", "image-to-image"),
    "gpt-image-2": ("rhart-image-g-2", "image-to-image"),
    "nano-banana": ("rhart-image-v1", "edit"),
}


def model_id(row):
    return str(next((row[key] for key in ("name_en", "id", "name", "endpoint") if row.get(key)), "")).strip()


def _label(row, identity):
    for key in (*_LABELS, "name"):
        label = " ".join(str(row.get(key) or "").split())
        if not label or label == identity:
            continue
        if key != "name" or not re.fullmatch(r"[A-Za-z0-9_./:-]+", label):
            return label[:160]
    return ""


def registry_rows(raw, available):
    envelopes = [raw]
    if isinstance(raw, dict):
        envelopes += [raw.get(key) for key in ("data", *_RECORDS[:-1], "result")]
    for value in envelopes:
        if isinstance(value, dict):
            value = next((value[key] for key in _RECORDS if value.get(key)), None)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict) and available(row)]
    return []


async def _first_catalog(client, sources, decode):
    errors = []
    for source, address, headers in sources:
        try:
            if isinstance(address, Path):
                raw = json.loads(address.read_text(encoding="utf-8-sig"))
            else:
                response = await client.get(address, headers=headers)
                if response.status_code >= 400:
                    errors.append(f"{source}: HTTP {response.status_code}")
                    continue
                raw = response.json()
            rows = decode(raw)
        except (ValueError, OSError, httpx.HTTPError) as exc:
            errors.append(f"{source}: {type(exc).__name__}")
            continue
        if rows:
            return rows, source, errors[-3:]
        errors.append(f"{source}: empty")
    return [], "", errors[-3:]


async def discover(openapi_url, registry_url, local_path, llm_urls, headers, available, parse_llm, fallback):
    sources = [("openapi", openapi_url, headers), ("github", registry_url, {"Accept": "application/json"})]
    if local_path.is_file():
        sources.append(("local", local_path, {}))
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        media, source, errors = await _first_catalog(client, sources, lambda raw: registry_rows(raw, available))
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        chat, llm_source, llm_errors = await _first_catalog(client, [(url, url, headers) for url in llm_urls], parse_llm)
    rows = list(media)
    identities = {model_id(row) for row in media}
    for identity in chat:
        if identity not in identities:
            rows.append({"name_en": identity, "endpoint": identity, "output_type": "chat"})
            identities.add(identity)
    return rows or fallback, {
        "source": source or ("llm" if chat else "fallback"),
        "openapi_count": len(media), "llm_count": len(chat), "llm_source": llm_source,
        "errors": errors + llm_errors,
    }


def picker_payload(rows, available, fallback_groups=None):
    groups = {kind: set() for kind in ("image", "chat", "video")}
    labels = {}
    for row in rows:
        if not available(row):
            continue
        identity = model_id(row)
        if not identity:
            continue
        label = _label(row, identity)
        if label:
            labels[identity] = label
        kind = _KINDS.get(str(row.get("output_type") or row.get("outputType") or "").strip().lower())
        if kind:
            groups[kind].add(identity)
    for kind, defaults in (fallback_groups or {}).items():
        groups[kind].update(defaults)
    all_ids = sorted(set.union(*groups.values()))
    return {**{f"{kind}_models": sorted(ids) for kind, ids in groups.items()},
            "all": all_ids, "total": len(all_ids), "model_names": labels, "protocol": "runninghub"}


def _alias(identity, aliases):
    if identity in aliases:
        return aliases[identity]
    family, _, action = identity.lower().partition("/")
    if family not in _FAMILY_ENDPOINTS:
        return ""
    endpoint, edit = _FAMILY_ENDPOINTS[family]
    if re.search(r"(?:^|/)text-to-image(?:-|$)", action):
        return f"{endpoint}/text-to-image"
    routes = ("edit", "image-to-image") if edit == "image-to-image" else ("edit",)
    if any(re.search(rf"(?:^|/){name}(?:-|$)", action) for name in routes):
        return f"{endpoint}/{edit}"
    return ""


def model_definition(rows, requested, aliases, default_model, classify):
    identity = str(requested or "").strip().strip("/")
    route = identity.removeprefix("openapi/v2/")
    for row in rows:
        endpoint = str(row.get("endpoint") or "").strip().strip("/")
        name = model_id(row)
        if identity and (identity == name or (endpoint and endpoint in (identity, route))):
            alias = _alias(name, aliases)
            return {**row, "endpoint": alias} if not endpoint and alias else row
    return {"name_en": identity, "endpoint": _alias(identity, aliases) or route or default_model,
            "output_type": classify(identity), "params": []}


FALLBACK_MODELS = {
    "image": {
        "gpt-image-2.0/text-to-image-channel-low-price": "rhart-image-g-2/text-to-image",
        "gpt-image-2.0/edit-channel-low-price": "rhart-image-g-2/image-to-image",
        "gpt-image-2/text-to-image-official-stable": "rhart-image-g-2-official/text-to-image",
        "gpt-image-2/image-to-image-official-stable": "rhart-image-g-2-official/image-to-image",
        "nano-banana/text-to-image-official-stable": "rhart-image-v1-official/text-to-image",
        "nano-banana/edit-official-stable": "rhart-image-v1-official/edit",
    },
    "video": {
        "google/veo3.1-fast/text-to-video-channel-low-price": "rhart-video-v3.1-fast/text-to-video",
        "sora-2/text-to-video-official-stable": "rhart-video-s-official/text-to-video",
        "seedance-2.0-global/text-to-video": "bytedance/seedance-2.0-global/text-to-video",
        "seedance-2.0-global/image-to-video": "bytedance/seedance-2.0-global/image-to-video",
    },
}


def fallback_rows():
    return [{"name_en": identity, "endpoint": route, "output_type": kind}
            for kind, routes in FALLBACK_MODELS.items() for identity, route in routes.items()]
