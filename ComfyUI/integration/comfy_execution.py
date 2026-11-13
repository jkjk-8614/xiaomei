"""Submit and follow workflows over the ComfyUI HTTP protocol."""

import json
import re
import time
from copy import deepcopy
from pathlib import Path
from urllib.parse import quote

import requests

from .comfy_outputs import view_query


LEGACY_SEED_NODES = {
    "22": "seed", "158": "noise_seed", "146": "seed", "181": "seed",
    "184": "seed", "172": "seed", "14": "seed",
}
SIZE_LIMIT_ERROR = re.compile(
    r"A\s+(\d+)\s*[x×]\s*(\d+)\s+output exceeds the supported\s+"
    r"(\d+)\s*[x×]\s*(\d+)\s+boundary\.\s*Use 1x or lower for this source\.",
    re.IGNORECASE,
)


def prepare_workflow(path, *, snapshot, preserve, prompt, width, height, seed):
    if snapshot is not None:
        return deepcopy(snapshot)
    with Path(path).open(encoding="utf-8") as stream:
        graph = json.load(stream)
    if preserve:
        return graph
    for node_id, node in graph.items():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        if node_id == "23" and prompt:
            inputs["text"] = prompt
        if node_id == "144":
            inputs.update(width=width, height=height)
        key = LEGACY_SEED_NODES.get(node_id)
        if key is not None and (key in inputs or node_id in ("22", "158")):
            inputs[key] = seed
        if node.get("class_type") == "SeedVR2" and "seed" in inputs:
            inputs["seed"] = seed
    return graph


def apply_workflow_inputs(graph, params):
    for node_id, changes in params.items():
        node = graph.get(node_id)
        if isinstance(node, dict) and isinstance(changes, dict):
            node.setdefault("inputs", {}).update(changes)


def _input_url(address, filename):
    query = view_query({"filename": filename, "type": "input"})
    return f"http://{address}/view?{query}"


def _input_present(address, filename):
    try:
        with requests.get(_input_url(address, filename), stream=True, timeout=0.5) as response:
            return response.status_code == 200
    except requests.RequestException:
        return False


def _read_queue(address, timeout):
    response = requests.get(f"http://{address}/queue", timeout=timeout)
    response.raise_for_status()
    return response.json()


def backend_capacity(address, filenames):
    running, pending = _queue_lists(_read_queue(address, timeout=1))
    if running is None:
        raise ValueError("ComfyUI 队列响应缺少任务列表")
    return len(running) + len(pending), all(_input_present(address, name) for name in filenames)


def sync_inputs(address, sources, filenames, *, check_cancel):
    for filename in filenames:
        check_cancel()
        if _input_present(address, filename):
            continue
        for source in sources:
            if source == address:
                continue
            check_cancel()
            try:
                response = requests.get(_input_url(source, filename), timeout=5)
            except requests.RequestException:
                continue
            if response.status_code != 200:
                continue
            if response.content:
                upload = {"image": (filename, response.content, response.headers.get("Content-Type", "image/png"))}
                try:
                    requests.post(f"http://{address}/upload/image", files=upload, timeout=10).raise_for_status()
                except requests.RequestException as error:
                    print(f"Sync upload failed: {error}")
            break


def submit_workflow(address, graph, client_id):
    response = requests.post(
        f"http://{address}/prompt", json={"prompt": graph, "client_id": client_id}, timeout=10,
    )
    if not response.ok:
        raise RuntimeError(f"HTTP Error {response.status_code}: {response.text}")
    receipt = response.json()
    prompt_id = receipt.get("prompt_id") if isinstance(receipt, dict) else None
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise RuntimeError("ComfyUI 未返回任务编号")
    return prompt_id


def fetch_history(address, prompt_id):
    try:
        response = requests.get(f"http://{address}/history/{quote(prompt_id, safe='')}", timeout=3)
        response.raise_for_status()
        history = response.json()
    except (requests.RequestException, ValueError):
        return None
    return history if isinstance(history, dict) else None


def _queue_lists(queue):
    if not isinstance(queue, dict):
        return None, None
    running = queue.get("queue_running")
    pending = queue.get("queue_pending")
    if not isinstance(running, list) or not isinstance(pending, list):
        return None, None
    return running, pending


def _execution_error(entry):
    status = entry.get("status") or {}
    if status.get("status_str") != "error":
        return
    events = status.get("messages") or []
    details = []
    for event in events:
        if not isinstance(event, list) or len(event) < 2 or event[0] != "execution_error":
            continue
        payload = event[1]
        if not isinstance(payload, dict):
            continue
        message = str(payload.get("exception_message", payload))
        limit = SIZE_LIMIT_ERROR.fullmatch(message.strip())
        if limit:
            width, height, max_width, max_height = limit.groups()
            message = (f"输出尺寸 {width}×{height} 超出支持范围（{max_width}×{max_height}）。"
                       "请将此图片的放大倍数调为 1× 或更低后重试。")
        details.append(message)
    raise RuntimeError("ComfyUI 执行失败：" + ("；".join(details) if details else str(events)))


def wait_for_result(address, prompt_id, timeout, *, managed, process, on_wait, check_cancel, pause):
    expires = time.monotonic() + timeout
    next_queue_check = time.monotonic() + 4
    connection_errors = 0
    while time.monotonic() < expires:
        check_cancel()
        history = fetch_history(address, prompt_id)
        entry = history.get(prompt_id) if history is not None else None
        if isinstance(entry, dict):
            _execution_error(entry)
            return entry
        if process is not None and process.poll() is not None:
            raise RuntimeError("本地 ComfyUI 已退出，本次生成中断。请重新运行工作流。")
        if managed and time.monotonic() >= next_queue_check:
            next_queue_check = time.monotonic() + 5
            queue = None
            try:
                queue = _read_queue(address, timeout=3)
            except requests.ConnectionError:
                connection_errors += 1
                if connection_errors >= 3:
                    raise RuntimeError("无法连接本地 ComfyUI，本次生成中断。请检查服务后重新运行工作流。") from None
            except (requests.RequestException, ValueError):
                connection_errors = 0
            else:
                connection_errors = 0
            running, pending = _queue_lists(queue)
            if running is not None and not any(
                isinstance(item, list) and item[1:2] == [prompt_id] for item in running + pending
            ):
                # The prompt may have finished between the history and queue reads.
                history = fetch_history(address, prompt_id)
                if history is not None:
                    entry = history.get(prompt_id)
                    if not isinstance(entry, dict):
                        raise RuntimeError("本地 ComfyUI 队列中已找不到本次任务。请重新运行工作流。")
                    _execution_error(entry)
                    return entry
        on_wait()
        pause(min(1, max(0, expires - time.monotonic())))
    check_cancel()
    raise RuntimeError(f"ComfyUI 渲染超时（已等待 {timeout} 秒）")
