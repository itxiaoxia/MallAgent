from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from langchain.mcp import MCPAdapter

from .models import McpServerConfig

MCP_DISCOVERY_TIMEOUT_SECONDS = 10.0
MCP_TEST_RETRY_COUNT = 1
MCP_TEST_RETRY_DELAY_SECONDS = 0.2


@dataclass
class McpToolLoadResult:
    tools: list[Any] = field(default_factory=list)
    failed_server_ids: list[str] = field(default_factory=list)


def _server_connection(server: McpServerConfig) -> dict[str, Any]:
    if server.transport == "stdio":
        connection: dict[str, Any] = {
            "command": server.command,
            "args": list(server.args),
        }
        if server.env:
            connection["env"] = dict(server.env)
        return connection

    connection = {"url": server.url}
    if server.headers:
        connection["headers"] = dict(server.headers)
    return connection


def build_mcp_config(servers: Iterable[McpServerConfig]) -> dict[str, Any]:
    """Translate application settings to FastMCP's multi-server config shape."""

    configured: dict[str, Any] = {}
    for server in servers:
        if not server.enabled:
            continue
        if server.id in configured:
            raise ValueError(f"MCP server id must be unique: {server.id}")
        configured[server.id] = _server_connection(server)
    return {"mcpServers": configured}


async def load_mcp_tools(servers: Iterable[McpServerConfig]) -> list[Any]:
    config = build_mcp_config(servers)
    if not config["mcpServers"]:
        return []
    async with MCPAdapter(config) as adapter:
        return await adapter.list_tools()


async def _load_server_tools(
    server: McpServerConfig,
    timeout_seconds: float,
) -> tuple[str, list[Any], bool]:
    try:
        async with asyncio.timeout(max(0.0, timeout_seconds)):
            return server.id, await load_mcp_tools([server]), False
    except Exception:
        # The caller reports only the configured server id. The exception may
        # contain an authorization header or URL and must not escape here.
        return server.id, [], True


async def load_mcp_tools_resilient(
    servers: Iterable[McpServerConfig],
    *,
    timeout_seconds: float = MCP_DISCOVERY_TIMEOUT_SECONDS,
) -> McpToolLoadResult:
    """Load each enabled MCP server independently so one outage is recoverable."""

    server_list = list(servers)
    result = McpToolLoadResult()
    enabled_servers: list[McpServerConfig] = []
    seen_ids: set[str] = set()
    for server in server_list:
        if not server.enabled:
            continue
        if server.id in seen_ids:
            result.failed_server_ids.append(server.id)
            continue
        seen_ids.add(server.id)
        enabled_servers.append(server)
    loaded = await asyncio.gather(
        *(_load_server_tools(server, timeout_seconds) for server in enabled_servers)
    )
    for server_id, tools, failed in loaded:
        if failed:
            result.failed_server_ids.append(server_id)
        else:
            result.tools.extend(tools)
    return result


async def discover_mcp_tools(
    server: McpServerConfig,
    *,
    timeout_seconds: float = MCP_DISCOVERY_TIMEOUT_SECONDS,
    retry_count: int = MCP_TEST_RETRY_COUNT,
    retry_delay_seconds: float = MCP_TEST_RETRY_DELAY_SECONDS,
) -> list[dict[str, str]]:
    """Probe one MCP server with a bounded retry for startup races."""

    attempts = max(1, retry_count + 1)
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            async with asyncio.timeout(max(0.0, timeout_seconds)):
                tools = await load_mcp_tools([server])
            break
        except Exception as error:
            last_error = error
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(max(0.0, retry_delay_seconds))
    else:
        raise last_error or RuntimeError("MCP discovery failed")

    return [
        {
            "name": str(getattr(tool, "name", "unnamed")),
            "description": str(getattr(tool, "description", "") or ""),
        }
        for tool in tools
    ]
