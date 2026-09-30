"""Local MCP configuration and short-lived connection diagnostics."""
import asyncio
import ipaddress
import json
import os
import re
import sys
import tempfile
import threading
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, Field, model_validator

ROOT = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
CONFIG_PATH = ROOT / "data" / "mcp_servers.json"
LOCK = threading.RLock()


def local_only(request: Request):
    host = request.client.host if request.client else ""
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == "testclient"
    origin = request.headers.get("origin")
    if not local or (origin and origin != str(request.base_url).rstrip("/")):
        raise HTTPException(403, "MCP 设置仅允许从本机小美画布访问")


router = APIRouter(prefix="/api/mcp", dependencies=[Depends(local_only)])

REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers"


def market_item(entry):
    server = entry["server"]
    name = server["name"]
    config_name = re.sub(r"[^\w .-]", "-", name)[:80].strip() or "MCP 服务"
    options = []
    for remote in server.get("remotes", []):
        if remote.get("type") != "streamable-http":
            continue
        url = remote.get("url", "")
        headers = {h["name"]: h.get("value", h.get("default", "")) for h in remote.get("headers", [])}
        options.append({"label": "Streamable HTTP · " + url,
                        "config": {"name": config_name, "transport": "http", "url": url,
                                   "headers": headers, "enabled": False}})
    for package in server.get("packages", []):
        # Complex launch contracts remain visible in the original metadata.
        if (package.get("registryType") != "npm" or
                package.get("transport", {}).get("type") != "stdio" or
                package.get("runtimeArguments") or package.get("packageArguments") or
                package.get("registryBaseUrl") not in (None, "https://registry.npmjs.org")):
            continue
        identifier, version = package.get("identifier", ""), package.get("version", "")
        if not re.fullmatch(r"(?:@[\w.-]+/)?[\w.-]+", identifier) or not re.fullmatch(r"[\w.+-]+", version):
            continue
        env = {e["name"]: e.get("value", e.get("default", "")) for e in package.get("environmentVariables", [])}
        options.append({"label": "npm · " + identifier + "@" + version,
                        "config": {"name": config_name, "transport": "stdio", "command": "npx",
                                   "args": ["-y", identifier + "@" + version], "env": env, "enabled": False}})
    valid_options = []
    for option in options:
        try:
            option["config"] = ServerConfig.model_validate(option["config"]).model_dump()
            valid_options.append(option)
        except ValueError:
            continue
    return {"name": name, "title": server.get("title") or name,
            "description": server.get("description", ""), "version": server.get("version", ""),
            "website": server.get("websiteUrl") or server.get("repository", {}).get("url", ""),
            "options": valid_options, "metadata": server}


async def fetch_market(params):
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        async with client.stream("GET", REGISTRY_URL, params=params) as response:
            response.raise_for_status()
            payload = bytearray()
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > 2_000_000:
                    raise ValueError("registry response too large")
            return json.loads(payload)


@router.get("/market")
async def search_market(q: str = Query(default="", max_length=160),
                        cursor: str = Query(default="", max_length=2048)):
    params = {"limit": 12, "version": "latest"}
    if q.strip():
        params["search"] = q.strip()
    if cursor:
        params["cursor"] = cursor
    try:
        data = await asyncio.wait_for(fetch_market(params), timeout=20)
        items = [market_item(e) for e in data["servers"]
                 if e.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {}).get("status", "active") == "active"]
        return {"items": items, "nextCursor": data.get("metadata", {}).get("nextCursor") or ""}
    except (httpx.TimeoutException, asyncio.TimeoutError, TimeoutError):
        raise HTTPException(504, "MCP 官方目录连接超时，请检查网络后重试。")
    except httpx.HTTPStatusError as exc:
        message = "MCP 官方目录请求过于频繁，请稍后重试。" if exc.response.status_code == 429 else "MCP 官方目录暂时不可用，请稍后重试。"
        raise HTTPException(502, message)
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(502, "无法读取 MCP 官方目录，请检查网络后重试。")


class ServerConfig(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[\w .-]+$")
    transport: Literal["stdio", "http"] = "stdio"
    enabled: bool = True
    command: str = Field(default="", max_length=4096)
    args: list[str] = Field(default_factory=list, max_length=100)
    cwd: str = Field(default="", max_length=4096)
    env: dict[str, str] = Field(default_factory=dict, max_length=100)
    url: str = Field(default="", max_length=4096)
    headers: dict[str, str] = Field(default_factory=dict, max_length=100)

    @model_validator(mode="after")
    def validate_connection(self):
        self.name = self.name.strip()
        self.command = self.command.strip()
        self.url = self.url.strip()
        if not self.name:
            raise ValueError("请填写服务名称")
        if self.transport == "stdio" and not self.command:
            raise ValueError("请填写启动命令")
        if self.transport == "http":
            u = urlsplit(self.url)
            if u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password:
                raise ValueError("请填写有效的 HTTP/HTTPS MCP 地址")
        if any("\x00" in s for s in [self.command, self.cwd, *self.args, *self.env.values()]):
            raise ValueError("配置中不能包含空字符")
        return self


class Settings(BaseModel):
    servers: list[ServerConfig] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def unique_names(self):
        names = [s.name.casefold() for s in self.servers]
        if len(names) != len(set(names)):
            raise ValueError("服务名称不能重复")
        return self


@router.get("/settings")
def read_settings():
    with LOCK:
        if not CONFIG_PATH.exists():
            return {"servers": []}
        try:
            return Settings.model_validate_json(CONFIG_PATH.read_text(encoding="utf-8")).model_dump()
        except (ValueError, OSError):
            raise HTTPException(500, "MCP 配置读取失败，请检查 data/mcp_servers.json；原配置已保留")


@router.put("/settings")
def save_settings(settings: Settings):
    with LOCK:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".mcp-", dir=CONFIG_PATH.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(settings.model_dump(), f, ensure_ascii=False, indent=2)
            os.replace(name, CONFIG_PATH)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    return {"saved": True}


async def probe(config: ServerConfig):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamablehttp_client

    async with AsyncExitStack() as stack:
        if config.transport == "stdio":
            # The SDK inherits a minimal OS environment; user additions stay local.
            errlog = stack.enter_context(open(os.devnull, "w"))
            streams = await stack.enter_async_context(stdio_client(
                StdioServerParameters(command=config.command, args=config.args,
                                      env=config.env, cwd=config.cwd or None), errlog=errlog))
        else:
            streams = await stack.enter_async_context(streamablehttp_client(
                config.url, headers=config.headers, timeout=timedelta(seconds=20)))
        session = await stack.enter_async_context(ClientSession(streams[0], streams[1],
                                                                read_timeout_seconds=timedelta(seconds=20)))
        initialized = await session.initialize()
        tools, cursor = [], None
        if initialized.capabilities.tools is not None:
            for _ in range(20):
                page = await session.list_tools(cursor=cursor)
                tools.extend({"name": t.name, "description": (t.description or "")[:1000]} for t in page.tools)
                cursor = page.nextCursor
                if not cursor:
                    break
        return {"ok": True, "server": initialized.serverInfo.name, "tools": tools,
                "truncated": bool(cursor)}


@router.post("/test")
async def test_connection(config: ServerConfig):
    if not config.enabled:
        raise HTTPException(400, "请先启用此服务再测试连接")
    try:
        return await asyncio.wait_for(probe(config), timeout=30)
    except ImportError:
        raise HTTPException(503, "缺少 MCP 组件，请安装 requirements.txt 中的依赖后重启小美画布")
    except (asyncio.TimeoutError, TimeoutError):
        return {"ok": False, "error": "连接超时，请检查服务是否启动、命令路径和网络。"}
    except Exception:
        # Server errors can echo authorization headers or environment values.
        return {"ok": False, "error": "连接失败，请检查启动命令、参数、工作目录或服务地址及鉴权配置。"}
