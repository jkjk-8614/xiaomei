"""RunningHub graph parameters and the local workflow catalog."""

import json
import re
from pathlib import Path

from fastapi import HTTPException


DEFAULT_MODE = "prune-workflow"
_MEDIA_FIELDS = {
    "IMAGE": ("image img mask photo picture", "png jpe?g webp gif bmp"),
    "VIDEO": ("video movie mp4", "mp4 webm mov m4v mkv"),
    "AUDIO": ("audio sound music voice", "mp3 wav ogg m4a flac aac"),
}


def _object(value):
    return value if isinstance(value, dict) else {}


def _integer(value):
    try:
        return int(value)
    except (ValueError, TypeError, OverflowError):
        return 0


def _text(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return "" if value is None else str(value)


def _is_link(value):
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and isinstance(value[1], int))


def _field_type(name, value):
    descriptor = f"{name} {value}".lower()
    for kind, (words, extensions) in _MEDIA_FIELDS.items():
        if re.search(r"\b(" + words.replace(" ", "|") + r")\b", descriptor):
            return kind
        if re.search(r"\.(" + extensions.replace(" ", "|") + r")(\?|$)", descriptor):
            return kind
    if value.strip().lower() in ("true", "false"):
        return "BOOLEAN"
    try:
        float(value)
    except ValueError:
        return "TEXT"
    return "NUMBER"


def editable_fields(graph, *, compact=False):
    fields = []
    for node_id, node in _object(graph).items():
        node = _object(node)
        group = _object(node.get("_meta")).get("title") or node.get("class_type") or node.get("_class") or node.get("type")
        for name, value in _object(node.get("inputs")).items():
            if _is_link(value):
                continue
            node_key, name, value = str(node_id), str(name), _text(value)
            kind = _field_type(name, value)
            field = {"nodeId": node_key, "fieldName": name, "fieldValue": value, "fieldType": kind}
            if compact:
                field["source"] = "workflow"
            else:
                field.update(id=f"{node_key}::{name}", label=name, enabled=False,
                             sourceFromUpstream=True, group=str(group or ""), note="",
                             imageOrder=0, required=kind == "IMAGE")
            fields.append(field)
    return fields


def normalize_field(raw):
    row = _object(raw.model_dump() if hasattr(raw, "model_dump") else raw)
    node_id = str(row.get("nodeId") or row.get("node_id") or "").strip()
    name = str(row.get("fieldName") or row.get("inputName") or row.get("name") or "").strip()
    identity = str(row.get("id") or row.get("fieldId") or row.get("key") or row.get("nodeId") or "").strip()
    value = next((row[key] for key in ("fieldValue", "defaultValue", "value") if row.get(key) is not None), None)
    options = row.get("options")
    if isinstance(options, str):
        options = re.split(r"[,\r\n]+", options)
    return dict(
        id=identity or f"{node_id}::{name}", nodeId=node_id, fieldName=name,
        fieldValue=_text(value), fieldType=str(row.get("fieldType") or "TEXT"),
        label=str(row.get("label") or row.get("title") or name),
        enabled=bool(row.get("enabled", True)), sourceFromUpstream=bool(row.get("sourceFromUpstream", True)),
        group=str(row.get("group") or ""), note=str(row.get("note") or ""),
        options=[str(option).strip() for option in options if str(option).strip()] if isinstance(options, list) else [],
        random_enabled=bool(row.get("random_enabled")), min=row.get("min", ""),
        max=row.get("max", ""), step=row.get("step", ""),
        imageOrder=_integer(row.get("imageOrder") or row.get("image_order")), required=bool(row.get("required")),
    )


def _saved_fields(values):
    for raw in values if isinstance(values, list) else ():
        field = normalize_field(raw)
        value = field["fieldValue"].strip()
        if value.startswith("["):
            try:
                if _is_link(json.loads(value)):
                    continue
            except ValueError:
                pass
        yield field


def _config(key, row):
    return {
        "workflowId": key,
        "title": row.get("title") or key,
        "description": row.get("note") or row.get("description") or "",
        "fields": list(_saved_fields(row.get("fields"))),
        "workflowJson": _object(row.get("workflowJson")),
        "optionalImageMode": row.get("optionalImageMode") or DEFAULT_MODE,
        "raw": _object(row.get("raw")),
        "updatedAt": row.get("updatedAt") or 0,
    }


def _has_payload(config):
    return any(config[key] for key in ("fields", "workflowJson", "raw"))


class WorkflowCatalog:
    def __init__(self, path, key, write, entries, *, strict=False):
        self.path = Path(path)
        self.write = write
        self.entries = self._by_id(entries, key)
        self.local = {}
        self.rows = {}
        self.aliases = {}
        try:
            with self.path.open(encoding="utf-8-sig") as handle:
                rows = json.load(handle)
            if not isinstance(rows, dict):
                raise ValueError("Expected a workflow ID map")
        except FileNotFoundError:
            return
        except (ValueError, OSError) as exc:
            if strict:
                raise HTTPException(status_code=500, detail="无法读取 RunningHub 工作流配置文件") from exc
            return
        self.rows = rows
        for raw_id, row in rows.items():
            if not isinstance(row, dict):
                continue
            identity = key(raw_id) or key(row.get("workflowId"))
            if not identity:
                continue
            self.aliases.setdefault(identity, []).append(raw_id)
            previous = self.local.get(identity)
            if previous is None or _integer(row.get("updatedAt")) >= _integer(previous.get("updatedAt")):
                self.local[identity] = row

    @staticmethod
    def _by_id(rows, key):
        return {identity: row for row in rows if isinstance(row, dict)
                and (identity := key(row.get("workflowId") or row.get("id")))}

    def is_hidden(self, key):
        entry = self.entries.get(key, {})
        local = self.local.get(key, {})
        if local.get("hidden") is True:
            return True
        if entry.get("hidden") is not True:
            return False
        return local.get("_saved") is not True or _integer(entry.get("updatedAt")) >= _integer(local.get("updatedAt"))

    def resolve(self, key, *, allow_empty=False):
        if self.is_hidden(key):
            return None
        entry = self.entries.get(key, {})
        local = self.local.get(key)
        if entry.get("hidden") is True:
            entry = {}
        saved = _config(key, local) if local is not None else None
        if entry:
            provider = _config(key, entry)
            if _has_payload(provider) and (saved is None or _integer(provider["updatedAt"]) > _integer(saved["updatedAt"])):
                return {**provider, "source": "api_providers"}
        if saved is not None:
            return {**saved, "source": local["source"]} if local.get("source") else saved
        if entry and allow_empty:
            return _config(key, entry)
        return None

    def cards(self):
        for key in dict.fromkeys((*self.entries, *self.local)):
            entry = self.entries.get(key, {})
            config = self.resolve(key, allow_empty=True)
            if config is None:
                if entry.get("hidden") is True or self.local.get(key, {}).get("hidden") is True:
                    yield {**entry, "id": key, "workflowId": key,
                           "enabled": False, "hidden": True}
                continue
            if key not in self.local:
                yield entry
                continue
            card = dict(entry)
            if card.pop("hidden", False):
                card["enabled"] = True
            card.update(config, id=key, note=config["description"])
            if entry.get("hidden") is not True and _integer(entry.get("updatedAt")) >= _integer(config["updatedAt"]):
                card.update({name: entry[name] for name in ("title", "note") if name in entry})
            yield card

    def summaries(self):
        items = []
        for key in self.entries.keys() | self.local.keys():
            config = self.resolve(key)
            if config is not None:
                items.append({"workflowId": key, "title": config["title"],
                              "fieldCount": len(config["fields"]), "updatedAt": config["updatedAt"],
                              "description": config["description"]})
        return sorted(items, key=lambda item: (item["title"], item["workflowId"]))

    def save(self, key, row, now):
        latest = max(_integer(item.get("updatedAt")) for item in (self.local.get(key, {}), self.entries.get(key, {})))
        config = _config(key, {**row, "title": row["title"].strip(), "updatedAt": max(now, latest + 1)})
        self._replace(key, {**config, "_saved": True})
        return config

    def delete(self, key, now):
        if self.resolve(key, allow_empty=True) is None:
            return False
        self._replace(key, {"workflowId": key, "hidden": True, "updatedAt": now})
        return True

    def _replace(self, key, row):
        rows = self.rows.copy()
        for alias in self.aliases.get(key, ()):
            rows.pop(alias, None)
        rows[key] = row
        self.write(self.path, rows)
