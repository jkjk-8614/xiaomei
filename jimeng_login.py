"""Manage the Dreamina device login and its background code exchange."""

import asyncio
from dataclasses import dataclass, field
import datetime
import re
import time
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from fastapi import HTTPException

from jimeng_cli import decode_output, stop_process


_AUTH_URL = re.compile(r"https?://[^\s\"'<>]+", re.I)
_QR_URL = re.compile(r"(?:qrcode|qr-code|/qr(?:[/?#]|$)|\.(?:png|jpe?g|gif|webp)(?:[?#]|$))", re.I)
_UNSUPPORTED = re.compile(r"unknown (?:option|flag|argument)|no such option|flag provided but not defined", re.I)
_LOG_LIMIT = 64 * 1024
_SECRET_FIELDS = ("device_code", "access_token", "refresh_token")


def _field(text, key):
    name = re.escape(key)
    line = re.search(rf"(?im)^[ \t]*{name}[ \t]*:[ \t]*(\S+)[ \t\r]*$", text)
    if line:
        return line[1].strip("\"'")
    item = re.search(rf"(?i)[\"']{name}[\"']\s*:\s*[\"']([^\"']+)[\"']", text)
    return item[1].strip() if item else ""


def _url(value):
    address = value.strip("\"' ")
    for _ in range(3):
        if _AUTH_URL.match(address):
            break
        decoded = unquote(address)
        if decoded == address:
            break
        address = decoded
    match = _AUTH_URL.search(address)
    if not match:
        return ""
    result = match[0]
    try:
        url = urlsplit(result)
        return result if url.hostname and not url.username and not url.password else ""
    except ValueError:
        return ""


def _complete_url(base, code):
    if not base or not code:
        return base
    url = urlsplit(base)
    query = parse_qsl(url.query, keep_blank_values=True)
    if any(name.casefold() in {"user_code", "scan_user_code"} for name, _ in query):
        return base
    return url._replace(query=urlencode([*query, ("user_code", code)])).geturl()


def login_metadata(text):
    text = str(text or "")
    base = _url(_field(text, "verification_uri"))
    complete = _url(_field(text, "verification_uri_complete") or _field(text, "verification_url"))
    code = _field(text, "user_code")
    inline = re.search(r"data:image/[^\s\"'<>]+", text, re.I)
    qr = inline[0] if inline else next((url[0] for url in _AUTH_URL.finditer(text) if _QR_URL.search(url[0])), "")
    return {
        "qr_url": qr,
        "verification_uri": base,
        "verification_uri_complete": complete or _complete_url(base, code),
        "user_code": code,
    }


def poll_seconds(text, default=300):
    try:
        fallback = min(900, max(1, int(default)))
    except (ValueError, TypeError, OverflowError):
        fallback = 300
    expires = _field(text, "expires_at") or _field(text, "login_expires_at")
    if not expires:
        return fallback
    try:
        seconds = int(datetime.datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp() - time.time())
    except (ValueError, OSError, OverflowError):
        return fallback
    return min(900, max(1, seconds))


def check_args(code, text=""):
    return ["login", "checklogin", f"--device_code={str(code or '').strip()}", f"--poll={poll_seconds(text)}"]


def _public_text(text):
    secrets = {_field(text, field) for field in _SECRET_FIELDS}
    for secret in sorted(secrets - {""}, key=len, reverse=True):
        text = text.replace(secret, "[已隐藏]")
    return text


@dataclass
class _Attempt:
    started_at: float = field(default_factory=time.time)
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    authorization: str = ""
    output: str = ""
    error: HTTPException | None = None

    @property
    def running(self):
        return self.task is not None and not self.task.done()

    @property
    def text(self):
        return "\n".join(filter(None, (self.authorization, self.output)))


class DeviceLogin:
    def __init__(self, cli, *, initial_wait=10):
        self.cli = cli
        self.initial_wait = initial_wait
        self._current = None
        self._lock = asyncio.Lock()

    def _snapshot(self, attempt):
        text = attempt.text if attempt else ""
        return {
            "success": True,
            "running": bool(attempt and attempt.running),
            "text": _public_text(text),
            **login_metadata(text),
        }

    async def _phase(self, attempt, args, wsl, timeout):
        process = await self.cli.spawn(args, wsl=wsl)
        output = [bytearray(), bytearray()]

        async def read(stream, index):
            while chunk := await stream.read(4096):
                buffer = output[index]
                buffer.extend(chunk)
                if len(buffer) > _LOG_LIMIT:
                    del buffer[:-_LOG_LIMIT]
                streams = decode_output(bytes(output[0]), bytes(output[1]), wsl=wsl)
                attempt.output = "\n".join(filter(None, streams))
                fields = login_metadata(attempt.text)
                if fields["qr_url"] or fields["user_code"] and fields["verification_uri_complete"]:
                    attempt.ready.set()

        streams = asyncio.gather(read(process.stdout, 0), read(process.stderr, 1), process.wait())
        try:
            await asyncio.wait_for(asyncio.shield(streams), timeout)
            return process.returncode
        finally:
            try:
                await stop_process(process)
            finally:
                if not streams.done():
                    streams.cancel()
                await asyncio.gather(streams, return_exceptions=True)

    async def _drive(self, attempt):
        wsl = self.cli.use_wsl()
        try:
            code = await self._phase(attempt, ["login", "--headless"], wsl, 920)
            if code and _UNSUPPORTED.search(attempt.output):
                attempt.output = ""
                code = await self._phase(attempt, ["login", "--debug"], wsl, 920)
            device = _field(attempt.output, "device_code")
            if code == 0 and device:
                attempt.authorization, attempt.output = attempt.output, ""
                command = check_args(device, attempt.authorization)
                await self._phase(attempt, command, wsl, poll_seconds(attempt.authorization) + 20)
        except asyncio.TimeoutError:
            attempt.output = "即梦登录已超时。请重新扫码。"
        except HTTPException as exc:
            attempt.error = exc
            attempt.output = str(exc.detail)
        except OSError as exc:
            attempt.error = HTTPException(502, f"无法读取即梦登录结果。{exc}")
            attempt.output = str(attempt.error.detail)
        finally:
            attempt.ready.set()

    async def _stop_current(self):
        attempt = self._current
        self._current = None
        if attempt and attempt.task:
            attempt.ready.set()
            if attempt.running:
                attempt.task.cancel()
            await asyncio.gather(attempt.task, return_exceptions=True)

    async def close(self):
        async with self._lock:
            await self._stop_current()

    async def start(self):
        async with self._lock:
            await self._stop_current()
            attempt = _Attempt()
            self._current = attempt
            attempt.task = asyncio.create_task(self._drive(attempt))
        try:
            await asyncio.wait_for(attempt.ready.wait(), timeout=self.initial_wait)
        except asyncio.TimeoutError:
            pass
        if attempt is not self._current:
            raise HTTPException(409, "已有更新的登录请求。请使用最新二维码。")
        if attempt.error and not attempt.authorization:
            raise attempt.error
        return {**self._snapshot(attempt), "started_at": attempt.started_at}

    async def status(self):
        attempt = self._current
        snapshot = self._snapshot(attempt)
        if snapshot["running"]:
            return {**snapshot, "logged_in": False, "raw": None}
        try:
            credit = await self.cli.run(["user_credit"], timeout=20)
        except HTTPException:
            return {**self._snapshot(self._current), "logged_in": False, "raw": None}
        if attempt is not self._current:
            return {**self._snapshot(self._current), "logged_in": False, "raw": None}
        return {**snapshot, "logged_in": True, "raw": credit}
