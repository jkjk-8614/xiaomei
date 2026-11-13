"""Combine provider defaults with saved catalog records and local protocol rules."""

import re


MODEL_FIELDS = ("image_models", "chat_models", "video_models")
ARK_FIELDS = ("volcengine_project_name", "volcengine_region")


def _runninghub(record, default, model_list):
    record["base_url"] = record.get("base_url") or default["base_url"]
    if record.get("protocol") in (None, "", "openai"):
        record["protocol"] = "runninghub"
    record.update({field: model_list(record.get(field)) for field in MODEL_FIELDS})


def _ark(record, default):
    record.update(protocol="volcengine", base_url=record.get("base_url") or default["base_url"])
    for field in ARK_FIELDS:
        record[field] = str(record.get(field) or "").strip() or default[field]


def _ark_from_legacy(records, default, model_list):
    for record in records:
        if str(record.get("protocol") or "").lower() == "volcengine":
            models = {field: model_list(record.get(field)) for field in MODEL_FIELDS}
            if not models["image_models"]:
                models["image_models"] = model_list(default.get("image_models"))
            return {**default, **models, "base_url": record.get("base_url") or default["base_url"]}
    return None


def _local_models(record, model_list, cli_defaults, jimeng_models):
    protocol = str(record.get("protocol") or "").strip().lower()
    provider_id = str(record.get("id") or "").strip().lower()
    if protocol == "jimeng" or provider_id == "jimeng":
        record.update(protocol="jimeng", base_url="")
        for field, (retired, defaults) in jimeng_models.items():
            saved = [name for name in record.get(field) or () if str(name or "").strip() not in retired]
            record[field] = model_list([*saved, *defaults])
        return
    if protocol not in cli_defaults:
        return

    managed = bool(record.get("model_selection_managed")) or any(record.get(field) for field in MODEL_FIELDS)
    record.update(protocol=protocol, base_url="", video_models=[], model_selection_managed=managed)
    defaults = cli_defaults[protocol]
    for field, default_models in zip(("image_models", "chat_models"), defaults):
        saved = record.get(field) or []
        if protocol == "codex" and field == "image_models":
            saved = [name for name in saved if str(name or "").strip().lower() != "$imagegen"]
        record[field] = model_list(saved if managed else [*default_models, *saved])


def merge(records, defaults, *, inject_missing, is_retired, model_list, cli_defaults, jimeng_models):
    merged = []
    by_id = {}
    for record in records:
        if not is_retired(record):
            copy = dict(record)
            merged.append(copy)
            by_id.setdefault(copy.get("id"), copy)

    for default in defaults:
        provider_id = default["id"]
        record = by_id.get(provider_id)
        if record is not None:
            if provider_id == "runninghub":
                _runninghub(record, default, model_list)
            elif provider_id == "volcengine":
                _ark(record, default)
            continue
        if provider_id == "volcengine":
            legacy = _ark_from_legacy(merged, default, model_list)
            if legacy is not None:
                merged.append(legacy)
                continue
        if inject_missing:
            merged.append(dict(default))

    for record in merged:
        _local_models(record, model_list, cli_defaults, jimeng_models)
    return merged


def connection(identity, record, *, runninghub_url, ark_defaults):
    provider_id = identity["id"]
    protocol, address = identity["protocol"], identity["base_url"]
    ark = {
        field: " ".join(str(record.get(field) or "").split())[:limit]
        for field, limit in zip(ARK_FIELDS, (80, 40))
    }
    if provider_id == "volcengine":
        protocol = provider_id
        address = address or ark_defaults["base_url"]
        ark = {field: ark[field] or ark_defaults[field] for field in ARK_FIELDS}
    if provider_id == "jimeng":
        protocol = provider_id
    if protocol in ("jimeng", "codex", "gemini-cli"):
        address = ""
    if provider_id == "runninghub":
        protocol = provider_id
        address = address or runninghub_url
    return dict(protocol=protocol, base_url=address, **ark)
