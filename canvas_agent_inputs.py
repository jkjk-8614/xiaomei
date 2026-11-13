"""Prepare canvas chat messages from linked files and visual references."""

import asyncio
from pathlib import Path

from fastapi import HTTPException


def extend_prompt(prompt, instruction):
    return "\n\n".join(value for value in (prompt.strip(), instruction) if value)


async def attachment_text(references, *, locate, read, limit):
    blocks = []
    seen = set()
    total = 0
    for reference in references:
        path = locate(str(reference.get("url") or ""))
        name = Path(str(reference.get("name") or path or "附件")).name
        if not path:
            raise HTTPException(422, f"{name} 无法读取，请重新上传本地文件")
        if path in seen:
            continue
        seen.add(path)
        record = await asyncio.to_thread(read, path)
        if record["status"] != "ready":
            raise HTTPException(422, f"{name}：{record['message']}")
        text = record["text"]
        total += len(text)
        if total > limit:
            raise HTTPException(422, "本次连接的文件文字总量过大，请分批连接文件后运行 Agent")
        blocks.append(f"附件：{name}\n读取状态：{record['message']}\n{text}")
    return "\n\n".join(blocks)


async def _visual_content(text, images, videos, locate, sample_video):
    if images:
        labels = "、".join(f"图{index}" for index in range(1, len(images) + 1))
        text += (
            f"\n\n本次视觉参考图共 {len(images)} 张，按插入顺序依次对应 {labels}。"
            "请使用对应编号引用每张参考图。"
        )
    parts = [{"type": "text", "text": text}]
    for number, image in enumerate(images, 1):
        address = locate(image, max_image_size=1024)
        if address:
            parts.extend((
                {"type": "text", "text": f"图{number}（第 {number} 张参考图）："},
                {"type": "image_url", "image_url": {"url": address}},
            ))
    video_count = 0
    for video in videos[:3]:
        frames = await sample_video(video, max_frames=6, max_size=768)
        if frames:
            video_count += 1
            parts.append({"type": "text", "text": f"以下是视频 {video_count} 按时间顺序抽取的关键帧，请结合画面理解视频内容。"})
            parts.extend({"type": "image_url", "image_url": {"url": frame}} for frame in frames)
        elif (address := locate(video)):
            video_count += 1
            parts.append({"type": "video_url", "video_url": {"url": address}})
    return parts


async def messages(system, history, text, images, videos, *, locate, sample_video):
    records = [{"role": "system", "content": system.strip()}] if system.strip() else []
    records.extend(
        {"role": message["role"], "content": message["content"]}
        for message in history
        if message.get("role") in {"user", "assistant"} and message.get("content")
    )
    content = await _visual_content(text, images, videos, locate, sample_video) if images or videos else text
    return [*records, {"role": "user", "content": content}]
