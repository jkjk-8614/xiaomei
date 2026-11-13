"""Start a local CLI and own its pipes and process until execution ends."""

import asyncio
import os
import signal
import subprocess
from contextlib import suppress


async def start(args, cwd, *, input_pipe=False):
    platform = (
        {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
        else {"start_new_session": True}
    )
    return await asyncio.create_subprocess_exec(
        *args, cwd=cwd, stdin=asyncio.subprocess.PIPE if input_pipe else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **platform,
    )


async def _stop(process):
    if process.returncode is not None:
        return
    if os.name == "nt":
        taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
        with suppress(OSError, subprocess.TimeoutExpired):
            await asyncio.to_thread(
                subprocess.run, [taskkill, "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW, timeout=3,
            )
    else:
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
    if process.returncode is None:
        with suppress(ProcessLookupError):
            process.kill()


async def collect(process, timeout, *, input_bytes=None):
    communication = process.communicate() if input_bytes is None else process.communicate(input_bytes)
    exchange = asyncio.create_task(communication)
    try:
        stdout, stderr = await asyncio.wait_for(asyncio.shield(exchange), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        try:
            await _stop(process)
            await asyncio.wait_for(asyncio.shield(exchange), 3)
        except Exception:
            pass
        finally:
            if not exchange.done():
                exchange.cancel()
            await asyncio.gather(exchange, return_exceptions=True)
        raise
    return process.returncode, stdout, stderr


async def run(args, cwd, timeout, *, input_bytes=None):
    process = await start(args, cwd, input_pipe=input_bytes is not None)
    return await collect(process, timeout, input_bytes=input_bytes)
