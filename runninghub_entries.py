"""User-configured RunningHub entries and bindings for recovered legacy nodes."""

import re

import runninghub_workflows


_ID_KEY = {"app": "appId", "workflow": "workflowId"}
_LIST_KEY = {"app": "rh_apps", "workflow": "rh_workflows"}
_LABEL = {"app": "AI 应用", "workflow": "工作流"}
_PATH = {
    "app": re.compile(r"/run/ai-app/([\w-]+)", re.I | re.ASCII),
    "workflow": re.compile(r"/(?:run/workflow|call-api/api-detail)/([\w-]+)", re.I | re.ASCII),
}
_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
_PROMPT_INPUT = re.compile(r"prompt|positive|caption|description|^text$|提示词|正向", re.I)
_NEGATIVE_INPUT = re.compile(r"negative|负向", re.I)
_SIZE_INPUTS = {"width", "height", "resolution", "ratio", "aspectratio"}


def reference_id(value, kind="workflow"):
    value = str(value or "").strip()
    match = _PATH[kind].search(value)
    return match[1] if match else value


def is_reference_id(value):
    return bool(_ID.fullmatch(value))


def entry_id(row, kind):
    if not isinstance(row, dict):
        return ""
    value = row.get(_ID_KEY[kind]) or row.get("id") or (row.get("webappId") if kind == "app" else "")
    return reference_id(value, kind)


def normalize_entry(raw, kind):
    identifier = entry_id(raw, kind)
    if not identifier:
        return None
    clipped = identifier[:80]
    name = " ".join(str(raw.get("title") or raw.get("name") or "").split())
    thumbnail = str(raw.get("thumbnail") or "").strip()
    row = dict(id=clipped, title=name[:80] or f"{_LABEL[kind]} {identifier[-6:]}",
               note=str(raw.get("note") or raw.get("description") or "").strip()[:500],
               thumbnail=thumbnail if len(thumbnail) <= 1_500_000 else "", enabled=bool(raw.get("enabled", True)))
    row[_ID_KEY[kind]] = clipped
    if raw.get("hidden") is True:
        row["hidden"] = True
    if isinstance(raw.get("fields"), list):
        row["fields"] = [runninghub_workflows.normalize_field(field) for field in raw["fields"] if isinstance(field, dict)]
    if isinstance(raw.get("raw"), dict):
        row["raw"] = raw["raw"]
    if kind == "workflow":
        mode = str(raw.get("optionalImageMode") or raw.get("optional_image_mode") or "").strip()
        row["optionalImageMode"] = mode or runninghub_workflows.DEFAULT_MODE
        graph = raw.get("workflowJson")
        if not isinstance(graph, dict):
            graph = raw.get("workflow_json")
        if isinstance(graph, dict):
            row["workflowJson"] = graph
    try:
        updated = int(raw.get("updatedAt") or raw.get("updated_at") or 0)
    except (TypeError, ValueError, OverflowError):
        updated = 0
    if updated > 0:
        row["updatedAt"] = updated
    return row


def normalize_entries(values, kind):
    entries = {}
    for raw in values or ():
        row = normalize_entry(raw, kind)
        if row is not None:
            entries.setdefault(row["id"], row)
    return list(entries.values())


def preserve_hidden(provider, previous):
    merged = dict(provider)
    for kind, key in _LIST_KEY.items():
        rows = normalize_entries(provider.get(key), kind)
        known = {row["id"] for row in rows}
        for row in normalize_entries(previous.get(key), kind):
            if row["id"] not in known and row.get("hidden") is True:
                rows.append(row)
        merged[key] = rows
    return merged


def app_fields(data):
    if not isinstance(data, dict):
        return []
    keys = ("nodeInfoList", "fields", "inputs", "inputList", "formItems", "forms", "params", "parameters", "apiParams")
    sources = [data, data.get("config"), data.get("webapp")]
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            rows = source.get(key)
            if isinstance(rows, list) and rows:
                fields = [field for raw in rows if (field := _app_field(raw))]
                if fields:
                    return fields
    return []


def _app_field(raw):
    if not isinstance(raw, dict):
        return None
    node = next((raw[key] for key in ("nodeId", "node_id", "groupId") if raw.get(key) not in (None, "")), None)
    name = next((raw[key] for key in ("fieldName", "inputName", "name", "key", "paramName", "id") if raw.get(key)), "")
    if node is None or not name:
        return None
    options = next((raw[key] for key in ("options", "optionList", "values", "choices", "fieldData") if raw.get(key)), [])
    if isinstance(options, list):
        options = [item.get("value", item.get("label", "")) if isinstance(item, dict) else item for item in options]
    row = {**raw, "id": raw.get("id") or f"{node}::{name}", "nodeId": str(node), "fieldName": name,
           "fieldType": raw.get("fieldType") or raw.get("type") or raw.get("valueType"),
           "enabled": True, "options": options}
    if all(row.get(key) is None for key in ("fieldValue", "defaultValue", "value")):
        row["fieldValue"] = row.get("default")
    return runninghub_workflows.normalize_field(row)


def recovered_workflow_fields(graph):
    selected = []
    for row in runninghub_workflows.editable_fields(graph):
        name = row["fieldName"]
        label = f"{name} {row['group']}"
        kind = row["fieldType"]
        if _NEGATIVE_INPUT.search(label):
            continue
        prompt = bool(_PROMPT_INPUT.search(name))
        media = kind in {"IMAGE", "VIDEO", "AUDIO"}
        dimension = name.replace("_", "").lower() in _SIZE_INPUTS
        if media or prompt or dimension:
            selected.append({**row, "enabled": True, "fieldType": "TEXT" if prompt else kind,
                             "required": row["required"] and not prompt})
    return selected
