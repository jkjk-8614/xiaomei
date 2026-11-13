"""Transport and result handling for the canvas Responses image mode."""

import asyncio
import json
import re
from fractions import Fraction
from urllib.parse import quote, urlsplit

import httpx


_REJECTED = frozenset({400, 404, 405, 415, 422})
_PENDING = frozenset({"queued", "in_progress", "processing", "pending", "running"})
_FAILED = frozenset({"failed", "cancelled", "canceled", "incomplete"})
_POLL_INTERVAL = 5.0
_POLL_MAX_SECONDS = 1500.0
_MAX_POLL_FAILURES = 6
_DIMENSIONS = re.compile(r"\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*")
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
_IMAGE_LINK = re.compile(r"https?://[^\s)\"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)\"'<>]*)?", re.I)


def images_api_unsupported(response):
    text = str(getattr(response, "text", "") or "").lower()
    return any(phrase in text for phrase in ("images api is not supported", "not supported for this platform"))


def responses_image_size_instruction(size):
    match = _DIMENSIONS.fullmatch(str(size or ""))
    if not match:
        return ""
    width, height = map(int, match.groups())
    if min(width, height) <= 0:
        return ""
    if width == height:
        return "请生成正方形图片（宽高比 1:1）。Generate a SQUARE image (aspect ratio 1:1)."
    ratio = Fraction(width, height).limit_denominator(32)
    aspect = f"{ratio.numerator}:{ratio.denominator}"
    shape, english = ("横版（宽幅）", "LANDSCAPE (wide)") if width > height else ("竖版（长幅）", "PORTRAIT (tall)")
    return (
        f"请生成{shape}图片：宽高比 {aspect}，目标尺寸为宽 {width} × 高 {height} 像素，绝对不要输出正方形（1:1）。"
        f" Generate a {english} image with aspect ratio {aspect}, target size {width}x{height} pixels (width x height)."
        " Never output a square 1:1 image. Do not swap width and height."
    )


def responses_proxy_tool_size(size):
    value = str(size or "").strip()
    match = _DIMENSIONS.fullmatch(value)
    return "x".join(reversed(match.groups())) if match else value


def image_request(model, prompt, size, quality, background, references, *, edit):
    generator = {"type": "image_generation", "action": "edit" if edit else "generate"}
    if str(size or "").strip().lower() not in ("", "auto"):
        generator["size"] = responses_proxy_tool_size(size)
    if quality:
        generator["quality"] = quality
    generator.update(background)

    size_prompt = responses_image_size_instruction(size)
    text = f"{size_prompt}\n\n{prompt}" if size_prompt else prompt
    blocks = [{"type": "input_text", "text": text}]
    blocks.extend({"type": "input_image", "image_url": url} for url in references if url)
    return {
        "model": model,
        "tools": [generator],
        "tool_choice": {"type": generator["type"]},
        "input": [{"role": "user", "content": blocks}],
    }


def _error_message(value):
    if isinstance(value, dict):
        return value.get("message") or value.get("detail") or value.get("code")
    return value if isinstance(value, str) else ""


def responses_no_image_detail(data):
    if not isinstance(data, dict):
        return ""
    notes = [_error_message(data.get("error"))]
    text = data.get("output_text")
    if isinstance(text, str):
        notes.append(text.strip()[:300])
    output = data.get("output")
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict) and item.get("type") == "image_generation_call":
                if item.get("status"):
                    notes.append(f"image_generation_call.status={item['status']}")
                notes.append(_error_message(item.get("error")))
    details = "；".join(dict.fromkeys(str(note).strip() for note in notes if note and str(note).strip()))
    return "RS / Responses 没有返回图片数据" + (f"：{details}" if details else "")


def responses_output_text_image(data):
    keys = ("output", "content", "text", "output_text", "message", "response")
    pending = [(data, 0)]
    checked = 0
    while pending and checked < 41:
        value, depth = pending.pop()
        if isinstance(value, str) and value.strip():
            checked += 1
            match = _MARKDOWN_IMAGE.search(value)
            if match:
                return {"type": "url", "value": match[1]}
            match = _IMAGE_LINK.search(value)
            if match:
                return {"type": "url", "value": match[0]}
        elif depth < 6:
            if isinstance(value, dict):
                pending.extend((value[key], depth + 1) for key in reversed(keys) if key in value)
            elif isinstance(value, list):
                pending.extend((item, depth + 1) for item in reversed(value))
    return None


def _reply(url, status, payload):
    return httpx.Response(status, json=payload, request=httpx.Request("POST", url))


def _error(url, message):
    return _reply(url, 502, {"error": {"message": message}})


def _as_object(value):
    return value if isinstance(value, dict) else {}


def _json_response(response):
    try:
        return _as_object(response.json())
    except ValueError:
        return {}


def _status(payload):
    return str(payload.get("status") or "").strip().lower()


def _retrieve_url(url, response_id):
    target = urlsplit(url)
    return target._replace(path=target.path.rstrip("/") + "/" + quote(response_id, safe=""), fragment="").geturl()


async def _poll(client, url, headers, response_id):
    deadline = asyncio.get_running_loop().time() + _POLL_MAX_SECONDS
    target = _retrieve_url(url, response_id)
    loop = asyncio.get_running_loop()
    failures = 0
    while (remaining := deadline - loop.time()) > 0:
        await asyncio.sleep(min(_POLL_INTERVAL, remaining))
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            response = await asyncio.wait_for(client.get(target, headers=headers), remaining)
        except asyncio.TimeoutError:
            break
        except httpx.HTTPError as exc:
            failure = f"RS 后台任务轮询连续失败：{exc}"
        else:
            if response.is_error:
                failure = f"RS 后台任务轮询失败（{response.status_code}）：{response.text[:200]}"
            else:
                failures = 0
                payload = _json_response(response)
                state = _status(payload)
                if state == "completed":
                    return _reply(url, 200, payload)
                if state in _FAILED:
                    return _reply(url, 502, payload)
                continue
        failures += 1
        if failures >= _MAX_POLL_FAILURES:
            return _error(url, f"{failure}（任务 id={response_id}）")
    return _error(url, f"RS 后台任务超过 {int(_POLL_MAX_SECONDS)}s 仍未完成（任务 id={response_id}）")


def _decode_event(text):
    try:
        return _as_object(json.loads(text))
    except ValueError:
        return {}


async def _stream_events(response):
    fragments = []
    async for line in response.aiter_lines():
        if not line:
            fragments.clear()
        elif line.startswith("data:"):
            value = line[5:].lstrip(" ")
            if value.strip() == "[DONE]":
                return
            event = _decode_event(value)
            if not event:
                fragments.append(value)
                if len(fragments) > 1:
                    event = _decode_event("\n".join(fragments))
            if event:
                fragments.clear()
                yield event


def _output_item(image):
    if image.get("type") == "b64":
        return {"type": "image_generation_call", "status": "completed", "result": image["value"],
                "mime_type": image.get("mime_type") or "image/png"}
    return {"type": "image", "image_url": image["value"]}


class _StreamResult:
    def __init__(self, decode_images, decode_image):
        self.decode_images = decode_images
        self.decode_image = decode_image
        self.completed = None
        self.failure = None
        self.images = {}

    def _remember(self, image):
        value = image.get("value") if isinstance(image, dict) else None
        if isinstance(value, str) and value:
            self.images.setdefault((image.get("type") or "url", value), image)

    def add(self, event):
        kind = event.get("type")
        response = event.get("response")
        if kind in ("response.failed", "response.cancelled", "response.canceled"):
            self.failure = _as_object(response) or {"error": {"message": kind}}
        elif kind == "error":
            message = event.get("message") or _error_message(event.get("error")) or "上游流式请求返回错误"
            self.failure = {"error": {"message": str(message)}}
        elif kind in ("response.completed", "response.incomplete") and isinstance(response, dict):
            self.completed = response
        elif kind == "response.image_generation_call.partial_image":
            return

        item = event.get("item")
        if isinstance(item, dict) and item.get("type") not in ("input_image", "input_text"):
            if item.get("status") not in ("in_progress", "generating", "failed"):
                for image in self.decode_images(item):
                    self._remember(image)
        mime = event.get("mime_type") or "image/png"
        for key in ("image_b64", "b64_json", "result", "image", "image_url"):
            if isinstance(event.get(key), str):
                self._remember(self.decode_image(event[key], mime_type=mime, assume_b64=key.endswith("_b64") or key == "b64_json"))

    def reply(self, url):
        if self.failure is not None:
            return _reply(url, 502, self.failure)
        if self.completed is not None:
            payload = self.completed
            if self.images and not self.decode_images(payload):
                output = payload.get("output")
                items = output if isinstance(output, list) else []
                payload = {**payload, "output": [*items, *map(_output_item, self.images.values())]}
            return _reply(url, 200, payload)
        if self.images:
            final = self.images[next(reversed(self.images))]
            return _reply(url, 200, {"output": [_output_item(final)]})
        return None


async def post_stream(client, url, headers, body, *, decode_images, decode_image):
    result = _StreamResult(decode_images, decode_image)
    try:
        async with client.stream("POST", url, headers=headers, json={**body, "stream": True}) as response:
            if response.status_code not in _REJECTED:
                content_type = response.headers.get("content-type", "").lower()
                if response.is_error or "text/event-stream" not in content_type:
                    await response.aread()
                    return response
                async for event in _stream_events(response):
                    result.add(event)
                reply = result.reply(url)
                return reply if reply is not None else _error(url, "RS 流式响应结束但没有返回最终图片")
    except httpx.HTTPError:
        reply = result.reply(url)
        if reply is None:
            raise
        return reply
    return await client.post(url, headers=headers, json=body)


async def post(client, url, headers, body, *, decode_images, decode_image):
    response = await client.post(url, headers=headers, json={**body, "background": True})
    if response.status_code in _REJECTED:
        return await post_stream(client, url, headers, body, decode_images=decode_images, decode_image=decode_image)
    if response.status_code == 524:
        return _error(url, "中转的 RS 后台请求超时（524），请检查渠道的 Responses 兼容性。"
                           f"上游返回：{response.text[:300]}")
    if response.is_error:
        return response
    payload = _json_response(response)
    response_id = str(payload.get("id") or "").strip()
    if response_id and _status(payload) in _PENDING:
        return await _poll(client, url, headers, response_id)
    return response
