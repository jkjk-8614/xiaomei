"""Read and write the canvas workflow format shared by both editors."""

import json
import re
import shutil
import time
import uuid
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import quote
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile
from zlib import error as DeflateError

from canvas_media import LOCAL_PREFIXES, decode_timeline


_MANIFEST = "workflow.json"
_PREVIEW_JSON_BYTES = 20 * 1024 * 1024
_INVALID_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


class WorkflowArchiveError(ValueError):
    pass


def _document(nodes, connections, resources):
    return {
        "format": "xiaomei-canvas-workflow",
        "version": 1,
        "exported_at": time.time_ns() // 1_000_000,
        "nodes": nodes,
        "connections": connections,
        "resources": resources,
    }


def _media_urls(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            for key, child in reversed(item.items()):
                timeline = decode_timeline(key, child)
                pending.append(child if timeline is None else timeline)
        elif isinstance(item, list):
            pending.extend(reversed(item))
        elif isinstance(item, str):
            url = item.strip()
            if url.startswith(LOCAL_PREFIXES):
                yield url


def _remap_urls(value, mapping):
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_remap_urls(item, mapping) for item in value]
    if not isinstance(value, dict):
        return value

    updated = {}
    for key, item in value.items():
        timeline = decode_timeline(key, item)
        if timeline is None:
            updated[key] = _remap_urls(item, mapping)
            continue
        remapped = _remap_urls(timeline, mapping)
        updated[key] = json.dumps(remapped, ensure_ascii=False) if remapped != timeline else item
    return updated


def _safe_member_name(name):
    base = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    return _INVALID_FILENAME.sub("_", base).strip().rstrip(". ") or "resource.bin"


def _export_members(nodes, resolve_local_file):
    used_names = set()
    for url in dict.fromkeys(_media_urls(nodes)):
        resolved = resolve_local_file(url)
        if not resolved:
            continue
        source = Path(resolved)
        if not source.is_file():
            continue
        base = Path(_safe_member_name(source.name))
        filename = base.name
        counter = 2
        while filename in used_names:
            filename = f"{base.stem}-{counter}{base.suffix}"
            counter += 1
        used_names.add(filename)
        yield source, {
            "url": url,
            "archive": f"resources/{filename}",
            "name": source.name,
            "size": source.stat().st_size,
        }


def export_workflow(nodes, connections, *, include_resources, resolve_local_file):
    if not nodes:
        raise WorkflowArchiveError("没有可导出的节点")
    buffer = BytesIO()
    resources = []
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        if include_resources:
            for source, member in _export_members(nodes, resolve_local_file):
                archive.write(source, member["archive"])
                resources.append(member)
        document = _document(nodes, connections, resources)
        archive.writestr(_MANIFEST, json.dumps(document, ensure_ascii=False, indent=2))
    return buffer.getvalue(), resources


def _uses_zip(signature, filename):
    return signature == b"PK" or str(filename or "").lower().endswith(".zip")


class _SeekableArchive:
    # Python 3.10's SpooledTemporaryFile supports seeking but has no seekable().
    def __init__(self, stream):
        self.read = stream.read
        self.seek = stream.seek
        self.tell = stream.tell

    def seekable(self):
        return True


def _open_manifest(archive, *, preview):
    # The canonical root entry takes precedence over older packages with a nested manifest.
    try:
        root = archive.getinfo(_MANIFEST)
    except KeyError:
        root = None
    if root is not None:
        return archive.open(root)

    entries = [entry for entry in archive.infolist() if not entry.is_dir()]
    manifest = next((entry for entry in entries if entry.filename.lower().endswith(_MANIFEST)), None)
    if manifest is None and preview:
        manifest = next((entry for entry in entries if entry.filename.lower().endswith(".json")), None)
    if manifest is None:
        message = "压缩包中没有工作流 JSON" if preview else "压缩包中没有 workflow.json"
        raise WorkflowArchiveError(message)
    return archive.open(manifest)


def _read_json(stream, *, preview=False):
    if preview:
        content = stream.read(_PREVIEW_JSON_BYTES + 1)
        if len(content) > _PREVIEW_JSON_BYTES:
            raise WorkflowArchiveError("工作流 JSON 超过 20MB")
    else:
        content = stream.read()
    return json.loads(content.decode("utf-8-sig"))


def _graph_from_manifest(manifest):
    if isinstance(manifest, list):
        return manifest, [], []
    if not isinstance(manifest, dict):
        raise WorkflowArchiveError("工作流格式不正确")
    nested = manifest.get("workflow")
    graph = nested if manifest.get("nodes") is None and isinstance(nested, dict) else manifest
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        raise WorkflowArchiveError("工作流 JSON 缺少 nodes")
    connections = graph.get("connections")
    resources = manifest.get("resources") or []
    return nodes, connections if isinstance(connections, list) else [], resources


def _resource_plan(archive, resources):
    if not isinstance(resources, list):
        raise WorkflowArchiveError("工作流资源清单格式不正确")
    for resource in resources:
        if not isinstance(resource, dict):
            raise WorkflowArchiveError("工作流资源清单格式不正确")
        path = str(resource.get("archive") or "").replace("\\", "/").lstrip("/")
        try:
            entry = archive.getinfo(path)
        except KeyError:
            continue
        if not entry.is_dir():
            yield entry, resource


def _imported_document(nodes, connections, resources, mapping):
    if mapping:
        nodes = _remap_urls(nodes, mapping)
        connections = _remap_urls(connections, mapping)
    return {
        "workflow": _document(nodes, connections, resources),
        "nodes": nodes,
        "connections": connections,
        "resource_map": mapping,
    }


def _restore_workflow(archive, manifest, upload_root):
    nodes, connections, resources = _graph_from_manifest(manifest)
    plan = list(_resource_plan(archive, resources))
    if not plan:
        return _imported_document(nodes, connections, resources, {})

    root = Path(upload_root)
    root.mkdir(parents=True, exist_ok=True)
    batch = "workflow_import_" + time.strftime("%Y%m%d-%H%M%S") + "_" + uuid.uuid4().hex
    mapping = {}
    restored = {}
    with TemporaryDirectory(prefix=".workflow-import-", dir=root) as temporary:
        staged = Path(temporary) / "files"
        staged.mkdir()
        for entry, resource in plan:
            archive_path = entry.filename
            basename = archive_path.rsplit("/", 1)[-1]
            url = restored.get(archive_path)
            if url is None:
                name = _safe_member_name(resource.get("name") or basename)
                filename = f"{len(restored) + 1}_{name}"
                with archive.open(entry) as source, (staged / filename).open("wb") as target:
                    shutil.copyfileobj(source, target)
                url = "/api/storage-files/upload/" + quote(f"{batch}/{filename}", safe="/")
                restored[archive_path] = url
            for alias in (archive_path, "./" + archive_path, basename, str(resource.get("url") or "").strip()):
                if alias:
                    mapping[alias] = url
        result = _imported_document(nodes, connections, resources, mapping)
        staged.rename(root / batch)
    return result


def import_workflow(stream, filename, upload_root):
    try:
        signature = stream.read(2)
        if not signature:
            raise WorkflowArchiveError("文件为空")
        stream.seek(0)
        if _uses_zip(signature, filename):
            with ZipFile(_SeekableArchive(stream)) as archive:
                with _open_manifest(archive, preview=False) as manifest:
                    document = _read_json(manifest)
                return _restore_workflow(archive, document, upload_root)
        nodes, connections, resources = _graph_from_manifest(_read_json(stream))
        return _imported_document(nodes, connections, resources, {})
    except WorkflowArchiveError:
        raise
    except (BadZipFile, DeflateError, EOFError) as exc:
        raise WorkflowArchiveError("无法读取压缩包") from exc
    except (ValueError, RuntimeError, OSError) as exc:
        raise WorkflowArchiveError("无法解析工作流文件") from exc


def _comfy_api_graph(document):
    nodes = []
    connections = []
    for node_id, node in document.items():
        if not isinstance(node, dict) or not node.get("class_type"):
            continue
        node_type = node["class_type"]
        meta = node.get("_meta") or {}
        nodes.append({"id": node_id, "type": node_type, "title": meta.get("title", node_type)})
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in document:
                connections.append({"from": str(value[0]), "to": node_id})
    return nodes, connections


def _preview_node(node, index, resolve_local_file):
    position = node.get("pos")
    size = node.get("size")
    position = position if isinstance(position, list) else []
    size = size if isinstance(size, list) else []
    media = []
    for url in dict.fromkeys(_media_urls(node)):
        if resolve_local_file(url):
            media.append(url)
            if len(media) == 2:
                break
    return {
        "id": str(node.get("id", index)),
        "title": str(node.get("title") or node.get("name") or node.get("type") or "节点")[:120],
        "type": str(node.get("type") or node.get("class_type") or "")[:120],
        "x": node.get("x", position[0] if position else None),
        "y": node.get("y", position[1] if len(position) > 1 else None),
        "w": size[0] if size else node.get("w") or node.get("width"),
        "h": size[1] if len(size) > 1 else node.get("h") or node.get("height"),
        "media": media,
        "input_count": len(node["inputs"]) if isinstance(node.get("inputs"), list) else 0,
        "output_count": len(node["outputs"]) if isinstance(node.get("outputs"), list) else 0,
    }


def _preview_edges(connections):
    if not isinstance(connections, list):
        return
    for link in connections:
        if isinstance(link, dict):
            endpoints = (link.get("from"), link.get("to"))
        elif isinstance(link, list) and len(link) >= 4:
            endpoints = (link[1], link[3])
        else:
            continue
        source, target = endpoints
        if source is not None and target is not None:
            yield {"from": str(source), "to": str(target)}


def inspect_workflow(raw, extension, resolve_local_file):
    try:
        with BytesIO(raw) as stream:
            if _uses_zip(raw[:2], extension):
                with ZipFile(stream) as archive, _open_manifest(archive, preview=True) as manifest:
                    document = _read_json(manifest, preview=True)
            else:
                document = _read_json(stream, preview=True)
        if not isinstance(document, dict):
            raise WorkflowArchiveError("工作流内容不是有效的对象")
        if isinstance(document.get("workflow"), dict):
            document = document["workflow"]
        nodes = document.get("nodes")
        connections = document.get("connections", document.get("links", []))
        if not isinstance(nodes, list):
            kind = "comfyui"
            nodes, connections = _comfy_api_graph(document)
        else:
            kind = "comfyui" if any(isinstance(node, dict) and node.get("pos") for node in nodes) else "canvas"
        nodes = [node for node in nodes if isinstance(node, dict)]
        if not nodes:
            raise WorkflowArchiveError("工作流中没有可预览的节点")
        graph = {
            "nodes": [_preview_node(node, index, resolve_local_file) for index, node in enumerate(nodes)],
            "connections": list(_preview_edges(connections)),
        }
        resources = document.get("resources")
        resource_count = len(resources) if isinstance(resources, list) else sum(
            bool(resolve_local_file(url)) for url in _media_urls(nodes)
        )
        return {
            "preview_status": "ready",
            "workflow_kind": kind,
            "node_count": len(graph["nodes"]),
            "connection_count": len(graph["connections"]),
            "resource_count": resource_count,
            "preview_graph": graph,
        }
    except (ValueError, BadZipFile, DeflateError, EOFError, RuntimeError, OSError, AttributeError, TypeError) as exc:
        return {"preview_status": "unavailable", "preview_error": str(exc)[:240]}
