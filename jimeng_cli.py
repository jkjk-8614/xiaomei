"""Launch the installed Dreamina CLI on the host or through WSL."""

import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from fastapi import HTTPException


MIN_VERSION = (1, 4, 2)
_WSL_ENABLED = {"1", "true", "yes", "on", "wsl"}
_RESULT_KEYS = {"submit_id", "gen_status", "result_json", "images", "videos", "data", "total_credit"}
_FIND_BINARY = """
. ~/.profile >/dev/null 2>&1 || true
. ~/.bashrc >/dev/null 2>&1 || true
dreamina_bin=$(command -v dreamina || find "$HOME" -maxdepth 4 -type f -name dreamina 2>/dev/null | head -n 1)
if [ -z "$dreamina_bin" ]; then
    printf '%s\n' 'dreamina CLI not found in WSL' >&2
    exit 127
fi
"""


def _line_encoding(data, offset):
    marker = data[offset:offset + 2]
    if marker == b"\xff\xfe":
        return "utf-16-le", 2
    if marker == b"\xfe\xff":
        return "utf-16-be", 2
    sample = data[offset:offset + 200].partition(b"\n")[0]
    even, odd = sample[::2].count(0), sample[1::2].count(0)
    if not (even or odd):
        return "utf-8-sig", 0
    return ("utf-16-be" if even > odd else "utf-16-le"), 0


def decode_wsl(data):
    lines = []
    offset = 0
    while offset < len(data):
        encoding, bom_size = _line_encoding(data, offset)
        offset += bom_size
        newline = "\n".encode(encoding) if encoding.startswith("utf-16") else b"\n"
        boundary = data.find(newline, offset)
        if len(newline) == 2:
            while boundary >= 0 and (boundary - offset) % 2:
                boundary = data.find(newline, boundary + 1)
        end = boundary if boundary >= 0 else len(data)
        line = data[offset:end].decode(encoding, errors="replace").rstrip("\r")
        lines.append(line.replace("\x00", ""))
        offset = end + len(newline)
    return "\n".join(lines)


def _clean_diagnostic(text):
    kept = []
    dependency_warning = False
    for line in text.splitlines():
        normalized = line.strip()
        lower = normalized.lower()
        if "localhost" in lower and "wsl" in lower and any(term in lower for term in ("nat", "proxy", "代理")):
            continue
        if dependency_warning and normalized.startswith("warnings.warn("):
            dependency_warning = False
            continue
        dependency_warning = "requestsdependencywarning" in lower
        if normalized and not dependency_warning:
            kept.append(normalized)
    return "\n".join(kept)


def decode_output(stdout, stderr, *, wsl):
    if wsl:
        return decode_wsl(stdout).strip(), _clean_diagnostic(decode_wsl(stderr))
    return tuple(value.decode("utf-8-sig", errors="replace").strip() for value in (stdout, stderr))


def windows_path_to_wsl(path):
    text = str(path or "").replace("\\", "/")
    if len(text) >= 3 and text[0].isascii() and text[0].isalpha() and text[1:3] == ":/":
        return f"/mnt/{text[0].lower()}/{text[3:]}"
    return text


def wsl_path_to_windows(path):
    text = str(path or "").strip()
    parts = text.split("/", 3)
    if len(parts) == 4 and parts[:2] == ["", "mnt"] and re.fullmatch(r"[A-Za-z]", parts[2]):
        return parts[2].upper() + ":\\" + parts[3].replace("/", "\\")
    return text


def parse_reply(value):
    text = str(value or "").strip()
    if not text:
        return {}
    decoder = json.JSONDecoder()
    position = 0
    candidates = []
    for start in re.finditer(r"[\[{]", text):
        if start.start() < position:
            continue
        try:
            record, position = decoder.raw_decode(text, start.start())
        except ValueError:
            continue
        if start.start() == 0:
            return record
        rank = len(_RESULT_KEYS.intersection(key.lower() for key in record)) if isinstance(record, dict) else 0
        candidates.append((rank, record))
    if candidates:
        return max(candidates, key=lambda candidate: candidate[0])[1]
    return {"text": text}


def parse_version(text):
    match = re.search(r"(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)", str(text or ""))
    return tuple(map(int, match.groups())) if match else None


async def stop_process(process):
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


class DreaminaCLI:
    def __init__(self, cwd, get_setting):
        self.cwd = cwd
        self.get_setting = get_setting

    def use_wsl(self):
        return str(self.get_setting("JIMENG_USE_WSL") or "").strip().lower() in _WSL_ENABLED

    def executable(self, *, wsl=None):
        wsl = self.use_wsl() if wsl is None else wsl
        if wsl:
            return shutil.which("wsl.exe") or shutil.which("wsl") or "wsl.exe"
        configured = self.get_setting("JIMENG_BIN") or self.get_setting("DREAMINA_BIN")
        if configured and str(configured).strip():
            return str(configured).strip()
        return next((path for name in ("dreamina", "dreamina.exe", "dreamina.cmd") if (path := shutil.which(name))), "")

    async def _spawn(self, command):
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        return await asyncio.create_subprocess_exec(
            *command, cwd=self.cwd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options,
        )

    async def _capture(self, command, timeout):
        process = await self._spawn(command)
        communicate = asyncio.create_task(process.communicate())
        try:
            stdout, stderr = await asyncio.wait_for(asyncio.shield(communicate), timeout)
            return process.returncode, stdout, stderr
        finally:
            try:
                await stop_process(process)
            finally:
                if not communicate.done():
                    communicate.cancel()
                await asyncio.gather(communicate, return_exceptions=True)

    async def _wsl(self, launcher):
        preferred = str(self.get_setting("JIMENG_WSL_DISTRO") or "").strip()
        try:
            code, raw, _ = await self._capture([launcher, "-l", "-q"], 5)
            names = [entry.strip().removeprefix("*").strip() for entry in decode_wsl(raw).splitlines() if entry.strip()] if code == 0 else []
        except (OSError, asyncio.TimeoutError):
            names = []
        selected = preferred if preferred and (not names or preferred in names) else next(
            (name for name in names if name == "Ubuntu" or name.startswith("Ubuntu-")), "",
        )
        return [launcher, *(["-d", selected] if selected else []), "-e", "sh", "-lc"]

    async def command(self, args, launcher, *, wsl):
        clean = [str(arg) for arg in args if str(arg)]
        if not wsl:
            return [launcher, *clean]
        prefix = await self._wsl(launcher)
        return [*prefix, _FIND_BINARY + '\nexec "$dreamina_bin" "$@"', "dreamina", *clean]

    async def spawn(self, args, *, wsl=None):
        wsl = self.use_wsl() if wsl is None else wsl
        launcher = self.executable(wsl=wsl)
        if not launcher:
            raise HTTPException(400, "未找到 dreamina CLI。请先在 API 设置中安装即梦 CLI。")
        try:
            return await self._spawn(await self.command(args, launcher, wsl=wsl))
        except OSError as exc:
            raise HTTPException(400, f"无法启动即梦 CLI（{launcher}）。请检查安装路径。") from exc

    async def binary_available(self, launcher=None):
        wsl = self.use_wsl()
        launcher = launcher or self.executable(wsl=wsl)
        if not launcher:
            return False
        if not wsl:
            return Path(launcher).is_file() or bool(shutil.which(launcher))
        try:
            command = [*await self._wsl(launcher), _FIND_BINARY + '\nprintf "%s" "$dreamina_bin"']
            code, output, _ = await self._capture(command, 10)
            return code == 0 and bool(decode_wsl(output).strip())
        except (OSError, asyncio.TimeoutError):
            return False

    async def run(self, args, timeout=120, raw_text=False):
        wsl = self.use_wsl()
        launcher = self.executable(wsl=wsl)
        if not launcher:
            raise HTTPException(400, "未找到 dreamina CLI。请先在 API 设置中安装即梦 CLI。")
        try:
            command = await self.command(args, launcher, wsl=wsl)
            code, stdout, stderr = await self._capture(command, timeout)
        except asyncio.TimeoutError as exc:
            command_name = str(args[0]) if args else "dreamina"
            raise HTTPException(504, f"即梦 CLI 执行超时（{command_name}）。") from exc
        except OSError as exc:
            raise HTTPException(400, f"无法启动即梦 CLI（{launcher}）。请检查安装路径。") from exc
        out, err = decode_output(stdout, stderr, wsl=wsl)
        if code:
            reason = err or out or f"exit={code}"
            raise HTTPException(502, f"即梦 CLI 调用失败。{reason[:1000]}")
        if raw_text:
            return {"_stdout": out, "_stderr": err}
        reply = parse_reply("\n".join(filter(None, (out, err))))
        if isinstance(reply, dict):
            reply.setdefault("_stdout", out)
            if err:
                reply.setdefault("_stderr", err)
        return reply

    async def version_file_text(self, launcher):
        if self.use_wsl():
            try:
                command = [*await self._wsl(launcher), 'cat "$HOME/.dreamina_cli/version.json"']
                code, output, _ = await self._capture(command, 10)
                return decode_wsl(output).strip() if code == 0 else ""
            except (OSError, asyncio.TimeoutError):
                return ""
        for directory in (Path.home(), Path(launcher).expanduser().absolute().parent):
            try:
                return (directory / ".dreamina_cli/version.json").read_text(encoding="utf-8-sig").strip()
            except (OSError, UnicodeError):
                continue
        return ""

    async def version(self, *, confirmed=False):
        launcher = self.executable()
        if not launcher or (not confirmed and not await self.binary_available(launcher)):
            return None, ""
        last = ""
        for flag in ("--version", "-V", "version"):
            try:
                output = await self.run([flag], timeout=15, raw_text=True)
            except HTTPException:
                continue
            last = output.get("_stdout") or output.get("_stderr") or ""
            version = parse_version(last)
            if version:
                return version, last
        metadata = await self.version_file_text(launcher)
        version = parse_version(metadata)
        return (version, metadata) if version else (None, last)
