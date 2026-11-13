"""Arguments, output records and local artifacts for the GPT Image CLI helper."""

import json
import logging
import math
import os
import re
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

import cli_process
import media_storage
from gpt_image_dimensions import CHAT_RATIO_SIZE_OPTIONS, normalize_gpt_image_2_size, parse_size_pair


_LOG = logging.getLogger(__name__)
_INLINE_PIXELS = re.compile(r"(\d{3,5})\s*[x×*]\s*(\d{3,5})", re.I)
_RATIO = re.compile(r"\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*")
_TEXT_PATH = re.compile(r"([A-Za-z]:[\\/][^\r\n\"'<>]+?\.(?:png|jpe?g|webp|gif)|/[^\r\n\"'<>]+?\.(?:png|jpe?g|webp|gif))", re.I)
_TIERS = {
    "1K": re.compile(r"1(?:\.0)?\s*k|1024", re.I),
    "2K": re.compile(r"2(?:\.0)?\s*k|2048", re.I),
    "4K": re.compile(r"4(?:\.0)?\s*k|3840", re.I),
}
_AUTH_FAILURE = re.compile(
    r"\b401\b|unauthori[sz]ed|authentication[_ -]?(?:failed|required|error)"
    r"|(?:invalid|incorrect|expired|revoked|missing)[^\r\n]{0,80}(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)"
    r"|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)[^\r\n]{0,40}(?:invalid|expired|revoked|missing|reused)",
    re.I,
)


def image_command(executable, provider_args, references, *, prompt, destination, model, size):
    fields = {"prompt": prompt, "out": destination, "model": model, "format": "png", "size": size, "quality": "high"}
    command = [executable, "--json", *provider_args, "images", "edit" if references else "generate"]
    for name, value in fields.items():
        command.extend((f"--{name}", value))
    for path in references:
        command.extend(("--ref-image", path))
    return command


def authentication_error(message):
    return bool(_AUTH_FAILURE.search(message))


def redact_provider_arguments(message, args):
    for index, value in enumerate(args[:-1]):
        if value in ("--api-key", "--access-token", "--refresh-token") and args[index + 1]:
            message = message.replace(args[index + 1], "[已隐藏]")
    return message


def _is_codex(provider):
    return str(provider or "").strip().lower() == "codex"


def _ratio(value):
    match = _RATIO.fullmatch(value)
    return tuple(map(int, match.groups())) if match else (0, 0)


def _mentioned_tier(text, order, default):
    return next((tier for tier in order if _TIERS[tier].search(text)), default)


def gpt_image_2_skill_size_arg(size="", model="", prompt="", provider="openai"):
    value = str(size or "").strip()
    text = " ".join((value, str(model or ""), str(prompt or "")))
    if _is_codex(provider):
        explicit = value.lower().replace(" ", "")
        if explicit in {"auto", "1k", "1.0k"}:
            return "auto"
        if explicit in {"2k", "2.0k", "4k", "4.0k"}:
            return explicit[0] + "K"
        width, height = parse_size_pair(value.replace("×", "x"))
        if width and height:
            return f"{width}x{height}"
        tier = _mentioned_tier(text, ("1K", "2K", "4K"), "auto")
        return "auto" if tier == "1K" else tier

    match = _INLINE_PIXELS.search(value)
    if match and min(map(int, match.groups())) > 0:
        return normalize_gpt_image_2_size("x".join(match.groups()))
    tier = _mentioned_tier(text, ("4K", "1K"), "2K")
    choices = CHAT_RATIO_SIZE_OPTIONS.get(_ratio(value))
    return choices[{"1K": 0, "2K": 1, "4K": 2}[tier]] if choices else tier


def gpt_image_2_skill_prompt_arg(prompt="", size="", provider="openai"):
    text = str(prompt or "").strip()
    if not _is_codex(provider):
        return text
    target = gpt_image_2_skill_size_arg(size, prompt=prompt, provider=provider)
    chinese = f"画质要求：目标输出 {target} 高分辨率图片。"
    english = f"Image quality requirement: output a {target} high-resolution image."
    width, height = parse_size_pair(str(size or "").replace("×", "x"))
    if width and height:
        divisor = math.gcd(width, height)
        width, height = width // divisor, height // divisor
    else:
        width, height = _ratio(str(size or ""))
    if not (width and height):
        return f"{text} {chinese} {english}"
    if width == height:
        shape, orientation = "正方形", "square"
    elif width > height:
        shape, orientation = "横版/宽幅", "landscape/wide"
    else:
        shape, orientation = "竖版/长幅", "portrait/tall"
    aspect = f"{width}:{height}"
    return (f"{text} {chinese}画幅要求：必须生成 {shape} 图片，宽高比 {aspect}。"
            "请不要交换宽高，不要输出反向比例。"
            f" {english} Canvas requirement: generate a {orientation} image with aspect ratio {aspect}; "
            "do not swap width and height.")


def _read_records(text):
    value = str(text or "").strip()
    if not value:
        return [], []
    try:
        decoded = json.loads(value)
    except ValueError:
        records, messages = [], []
        for line in value.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                messages.append(line)
            else:
                records.extend(record if isinstance(record, list) else [record])
        return records, messages
    return decoded if isinstance(decoded, list) else [decoded], []


def _reported_paths(record, depth=0):
    if not isinstance(record, dict) or depth > 5:
        return
    for key in ("path", "file", "output", "out", "url"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            yield value.strip()
    for key in ("output", "data", "result"):
        yield from _reported_paths(record.get(key), depth + 1)
    images = record.get("images")
    if isinstance(images, list):
        for image in images:
            if isinstance(image, str) and image.strip():
                yield image.strip()
            else:
                yield from _reported_paths(image, depth + 1)


def parse_gpt_image_2_skill_output(stdout_text="", stderr_text=""):
    records, messages = _read_records(stdout_text)
    found = [path for record in records for path in _reported_paths(record)]
    text = "\n".join(messages) if stdout_text else str(stderr_text or "")
    found.extend(match[0] for match in _TEXT_PATH.finditer(text))
    return records, list(dict.fromkeys(found))


def _detail(value):
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except ValueError:
            return value.strip()
        if not isinstance(decoded, dict):
            return value.strip()
        value = decoded
    if isinstance(value, dict):
        error = value.get("error")
        if isinstance(error, str):
            return error.strip()
        fields = error if isinstance(error, dict) else value
        detail = fields.get("message") or fields.get("detail") or fields.get("code")
        if isinstance(detail, str):
            return detail.strip()
    return ""


def gpt_image_2_skill_failure_message(stdout_text="", stderr_text="", returncode=0):
    records, lines, progress, errors = [], [], [], []
    for stream in (stdout_text, stderr_text):
        parsed, unparsed = _read_records(stream)
        records.extend(parsed)
        lines.extend(unparsed)
    for record in records:
        if not isinstance(record, dict):
            continue
        error = record.get("error")
        if isinstance(error, dict):
            summary = str(error.get("message") or "").strip()
            detail = _detail(error.get("detail"))
            if detail and detail not in summary:
                summary = f"{summary}：{detail}" if summary else detail
            errors.append(summary or str(error.get("code") or ""))
        elif isinstance(error, str):
            errors.append(error.strip())
        if record.get("ok") is False:
            errors.append(_detail(record.get("message") or record.get("detail")))
        data = record.get("data")
        if isinstance(data, dict):
            phase = str(record.get("type") or data.get("phase") or "").strip()
            note = data.get("error") or data.get("message") or data.get("status")
            if note and phase not in {"request.started", "request_started"}:
                progress.append(f"{phase}: {note}" if phase else str(note))

    error_text = "；".join(dict.fromkeys(filter(None, errors)))
    if error_text:
        return error_text[:1600]
    if lines:
        return "\n".join(lines)[:1600]
    if progress:
        return ("只收到了进度事件，没有收到最终错误详情：" + "；".join(dict.fromkeys(progress)))[:1600]
    return "\n".join(filter(None, (str(stdout_text or "").strip(), str(stderr_text or "").strip())))[:1600] or f"exit={returncode}"


def output_files(expected, reported, output_root, *, working_dir=None):
    root = Path(output_root).resolve()
    cwd = Path(working_dir) if working_dir is not None else root
    files = {}
    for raw in (expected, *reported):
        if not raw or str(raw).lower().startswith(("http://", "https://", "data:")):
            continue
        candidate = Path(raw)
        candidates = [candidate] if candidate.is_absolute() else [root / candidate, cwd / candidate]
        for item in candidates:
            try:
                path = item.resolve(strict=True)
            except (OSError, RuntimeError, ValueError):
                continue
            if root in path.parents and path.is_file():
                files.setdefault(os.path.normcase(str(path)), str(path))
                break
    return list(files.values())


def codex_postprocess_image_to_requested_size(path="", requested_size="", provider=""):
    width, height = parse_size_pair(requested_size)
    if not (_is_codex(provider) and width and height and path and Path(path).is_file()):
        return ""
    source = Path(path)
    try:
        with Image.open(source) as image:
            oriented = ImageOps.exif_transpose(image)
            if oriented.size == (width, height):
                return ""
            pixels = oriented.convert("RGBA" if oriented.mode in {"RGBA", "LA", "P"} else "RGB")
            fitted = ImageOps.fit(pixels, (width, height), Image.Resampling.LANCZOS)
            buffer = BytesIO()
            fitted.save(buffer, format="PNG")
        target = source.with_name(f"{source.stem}_upscaled_{width}x{height}.png")
        return str(media_storage.write_media_snapshot(target, buffer.getvalue(), deduplicate=False))
    except (OSError, ValueError, OverflowError, SyntaxError, MemoryError, Image.DecompressionBombError) as exc:
        _LOG.warning("Codex GPT Image 图片尺寸后处理失败：%s", exc)
        return ""


async def run_helper(args, cwd, timeout):
    try:
        return await cli_process.run(args, cwd, timeout)
    except FileNotFoundError:
        return None
