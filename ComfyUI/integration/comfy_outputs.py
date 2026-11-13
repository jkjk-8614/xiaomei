"""Turn ComfyUI history descriptors into the application's result fields."""

from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import urlencode


SUFFIXES = {
    "image": (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"),
    "video": (".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".mpeg", ".mpg"),
    "audio": (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"),
    "text": (".txt", ".json", ".csv", ".srt", ".vtt", ".md"),
}
RESULT_KEYS = {"image": "images", "video": "videos", "audio": "audios", "text": "texts", "file": "files"}
FORMAT_SUFFIXES = (
    (("video/mpeg",), ".mpeg"),
    (("mpeg", "mp3"), ".mp3"),
    (("wav", "wave"), ".wav"),
    (("ogg",), ".ogg"),
    (("flac",), ".flac"),
    (("text", "plain"), ".txt"),
    (("json",), ".json"),
    (("webm",), ".webm"),
    (("quicktime", "mov"), ".mov"),
    (("mp4", "h264", "video"), ".mp4"),
)
FORMAT_KINDS = {
    "image": ("image",), "video": ("video",), "audio": ("audio", "sound"), "text": ("text", "json"),
}
TEXT_FIELDS = ("text", "texts", "prompt", "prompts", "string", "strings", "caption", "captions")
COMPARER_NAMES = ("comparer", "imagecompare", "image compare")
COMPARER_RESULT_FIELDS = {"b_images", "b", "image_b", "result", "results", "output", "outputs"}
DEBUG_TEXT_NAMES = (
    "showtext", "show text", "showanything", "show any", "preview any", "previewany",
    "displaytext", "display text", "display any", "anything everywhere", "convertanything",
    "easy show", "note", "mathexpression", "cr text", "text multiline", "string function", "debug",
)


def filename_part(path):
    return PurePosixPath(str(path).replace("\\", "/")).name


def output_format(descriptor):
    suffix = PurePosixPath(filename_part(descriptor.get("filename") or "")).suffix.lower()
    media_type = str(descriptor.get("format") or "").lower()
    if not any(suffix in extensions for extensions in SUFFIXES.values()):
        suffix = next(
            (extension for markers, extension in FORMAT_SUFFIXES if any(marker in media_type for marker in markers)),
            suffix or ".bin",
        )
    for kind, extensions in SUFFIXES.items():
        if suffix in extensions or any(marker in media_type for marker in FORMAT_KINDS[kind]):
            return kind, suffix
    return "file", suffix


def view_query(descriptor):
    return urlencode({
        "filename": str(descriptor["filename"]),
        "subfolder": str(descriptor.get("subfolder") or ""),
        "type": str(descriptor.get("type") or "output"),
    })


def _as_items(value):
    return value if isinstance(value, list) else (value,)


@dataclass(frozen=True, eq=False)
class FileOutput:
    node_id: str
    class_type: str
    key: str
    descriptor: dict
    kind: str
    image_role: str


def _image_role(class_name):
    if any(marker in class_name for marker in COMPARER_NAMES):
        return "compare"
    if "previewimage" in class_name:
        return "preview"
    return "result"


def _file_outputs(node_id, class_type, role, outputs):
    for key, value in outputs.items():
        if key in TEXT_FIELDS:
            continue
        for descriptor in _as_items(value):
            if isinstance(descriptor, dict) and descriptor.get("filename"):
                kind, _ = output_format(descriptor)
                yield FileOutput(node_id, class_type, key, descriptor, kind, role)


def _text_outputs(outputs):
    for key in TEXT_FIELDS:
        for value in _as_items(outputs.get(key)):
            name = f"{key}.txt"
            if isinstance(value, dict):
                name = value.get("filename") or value.get("name") or name
                value = value.get("text") or value.get("prompt") or value.get("caption") or value.get("value")
            if value is not None and str(value).strip():
                yield str(value), name


def collect_result(history, workflow, *, download, save_text, check_cancel):
    result = {key: [] for key in RESULT_KEYS.values()}
    result.update(items=[], outputs=[])
    files = []
    inline = []
    has_comparer = False
    for node_id, outputs in (history.get("outputs") or {}).items():
        node = workflow.get(str(node_id)) or {}
        class_type = str(node.get("class_type") or "") if isinstance(node, dict) else ""
        class_name = class_type.lower()
        role = _image_role(class_name)
        has_comparer |= role == "compare"
        if isinstance(outputs, dict):
            files.extend(_file_outputs(str(node_id), class_type, role, outputs))
            if not any(marker in class_name for marker in DEBUG_TEXT_NAMES):
                inline.extend((str(node_id), class_type, value, name) for value, name in _text_outputs(outputs))

    images = [output for output in files if output.kind == "image"]
    selected_images = [output for output in images if output.image_role == "result"]
    if not selected_images:
        selected_images = [output for output in images if output.image_role == "preview"]
    if images and not selected_images:
        selected_images = [next(
            (output for output in images if output.key.lower() in COMPARER_RESULT_FIELDS), images[-1],
        )]
    selected_images = set(selected_images)

    def add(url, kind, name, node_id, key, class_type):
        result[RESULT_KEYS[kind]].append(url)
        result["outputs"].append(url)
        result["items"].append({
            "url": url, "kind": kind, "name": name, "node_id": node_id, "output_key": key, "class_type": class_type,
        })

    seen_images = set()
    for output in files:
        check_cancel()
        if output.kind == "image" and output not in selected_images:
            continue
        url = download(output.descriptor)
        if output.kind == "image":
            if url in seen_images:
                continue
            seen_images.add(url)
        name = filename_part(output.descriptor["filename"]) or filename_part(url.partition("?")[0])
        add(url, output.kind, name, output.node_id, output.key, output.class_type)

    for node_id, class_type, value, name in inline:
        check_cancel()
        url = save_text(value, name=name)
        add(url, "text", filename_part(url.partition("?")[0]), node_id, "text", class_type)

    if has_comparer and result["images"]:
        result["canvas_compare"] = {"enabled": True, "source": "workflow_input", "result": "workflow_output"}
    return result
