"""Arguments and last-message handling for the workspace's Codex adapter."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import cli_process


_SANDBOXES = ("read-only", "workspace-write", "danger-full-access")
_REASONING = ("minimal", "low", "medium", "high", "xhigh")
_HTTPS_PROVIDER = "xiaomei_openai_https"


def _arguments(executable, directory, *, sandbox, model, images, ephemeral, reasoning, https_url, output):
    mode = str(sandbox or "").strip().lower()
    command = [
        executable, "exec", "--cd", str(directory),
        "--sandbox", mode if mode in _SANDBOXES else "workspace-write",
        "--skip-git-repo-check", "--ignore-user-config",
    ]
    if ephemeral:
        command.append("--ephemeral")
    if https_url:
        config = {
            "model_provider": _HTTPS_PROVIDER,
            f"model_providers.{_HTTPS_PROVIDER}.name": "Xiaomei HTTPS",
            f"model_providers.{_HTTPS_PROVIDER}.base_url": https_url,
            f"model_providers.{_HTTPS_PROVIDER}.wire_api": "responses",
            f"model_providers.{_HTTPS_PROVIDER}.requires_openai_auth": True,
            f"model_providers.{_HTTPS_PROVIDER}.supports_websockets": False,
            f"model_providers.{_HTTPS_PROVIDER}.stream_max_retries": 0,
        }
        for key, value in config.items():
            command.extend(("-c", f"{key}={json.dumps(value, ensure_ascii=False)}"))
    effort = str(reasoning or "").strip().lower()
    if effort in _REASONING:
        command.extend(("-c", f"model_reasoning_effort={effort}"))
    name = str(model or "").strip()
    if name and not name.lower().startswith(("$imagegen", "gpt-image")):
        command.extend(("--model", name))
    for path in images or ():
        if path and Path(path).is_file():
            command.extend(("--image", str(path)))
    if output is not None:
        command.extend(("--output-last-message", str(output)))
    return [*command, "-"]


async def execute(executable, directory, prompt, *, timeout, output_last_message, **options):
    with TemporaryDirectory(prefix="xiaomei-codex-") as temporary:
        output = Path(temporary) / "last.txt" if output_last_message else None
        command = _arguments(executable, directory, output=output, **options)
        code, stdout, stderr = await cli_process.run(
            command, directory, timeout, input_bytes=str(prompt or "").encode("utf-8"),
        )
        last = ""
        if output is not None:
            try:
                last = output.read_text(encoding="utf-8-sig").strip()
            except (OSError, UnicodeError):
                pass
        return code, stdout, stderr, last
