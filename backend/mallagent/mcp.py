from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from langchain.mcp import MCPAdapter

from .models import McpServerConfig


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


async def discover_mcp_tools(server: McpServerConfig) -> list[dict[str, str]]:
    tools = await load_mcp_tools([server])
    return [
        {
            "name": str(getattr(tool, "name", "unnamed")),
            "description": str(getattr(tool, "description", "") or ""),
        }
        for tool in tools
    ]
