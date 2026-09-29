import asyncio

import pytest

from mallagent import mcp as mcp_module
from mallagent.mcp import build_mcp_config
from mallagent.models import McpServerConfig, default_java_mcp_server


def test_build_mcp_config_keeps_default_java_mcp_http_contract() -> None:
    assert build_mcp_config([default_java_mcp_server()]) == {
        "mcpServers": {
            "mall-system-java": {
                "url": "http://127.0.0.1:9991/mcp",
            },
        },
    }


def test_build_mcp_config_maps_enabled_stdio_and_http_servers() -> None:
    servers = [
        McpServerConfig(
            id="local",
            name="Local tools",
            transport="stdio",
            command="python",
            args=["server.py"],
            env={"TOKEN": "secret"},
        ),
        McpServerConfig(
            id="remote",
            name="Remote tools",
            transport="http",
            url="https://example.test/mcp",
            headers={"Authorization": "Bearer secret"},
        ),
        McpServerConfig(id="disabled", name="Disabled draft", enabled=False),
    ]

    result = build_mcp_config(servers)

    assert result == {
        "mcpServers": {
            "local": {
                "command": "python",
                "args": ["server.py"],
                "env": {"TOKEN": "secret"},
            },
            "remote": {
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer secret"},
            },
        }
    }


def test_build_mcp_config_returns_empty_fleet_when_all_servers_are_disabled() -> None:
    result = build_mcp_config([McpServerConfig(id="draft", name="Draft", enabled=False)])

    assert result == {"mcpServers": {}}


@pytest.mark.asyncio
async def test_load_mcp_tools_resilient_skips_failed_server_and_keeps_healthy_tools(monkeypatch) -> None:
    healthy = McpServerConfig(id="healthy", name="Healthy", transport="stdio", command="ok")
    broken = McpServerConfig(id="broken", name="Broken", transport="stdio", command="broken")

    async def fake_load(servers):
        server = list(servers)[0]
        if server.id == "broken":
            raise RuntimeError("secret URL should not escape")
        return [f"tool:{server.id}"]

    monkeypatch.setattr(mcp_module, "load_mcp_tools", fake_load)

    result = await mcp_module.load_mcp_tools_resilient([healthy, broken])

    assert result.tools == ["tool:healthy"]
    assert result.failed_server_ids == ["broken"]


@pytest.mark.asyncio
async def test_load_mcp_tools_resilient_times_out_stuck_server_without_blocking_healthy_server(monkeypatch) -> None:
    healthy = McpServerConfig(id="healthy", name="Healthy", transport="stdio", command="ok")
    stuck = McpServerConfig(id="stuck", name="Stuck", transport="stdio", command="stuck")

    async def fake_load(servers):
        server = list(servers)[0]
        if server.id == "stuck":
            await asyncio.sleep(1)
        return [f"tool:{server.id}"]

    monkeypatch.setattr(mcp_module, "load_mcp_tools", fake_load)

    result = await mcp_module.load_mcp_tools_resilient(
        [healthy, stuck],
        timeout_seconds=0.01,
    )

    assert result.tools == ["tool:healthy"]
    assert result.failed_server_ids == ["stuck"]


@pytest.mark.asyncio
async def test_load_mcp_tools_resilient_does_not_fail_all_tools_for_duplicate_server_ids(monkeypatch) -> None:
    first = McpServerConfig(id="duplicate", name="First", transport="stdio", command="first")
    second = McpServerConfig(id="duplicate", name="Second", transport="stdio", command="second")

    async def fake_load(servers):
        server = list(servers)[0]
        return [f"tool:{server.command}"]

    monkeypatch.setattr(mcp_module, "load_mcp_tools", fake_load)

    result = await mcp_module.load_mcp_tools_resilient([first, second])

    assert result.tools == ["tool:first"]
    assert result.failed_server_ids == ["duplicate"]


@pytest.mark.asyncio
async def test_discover_mcp_tools_retries_a_transient_connection_failure(monkeypatch) -> None:
    server = McpServerConfig(id="remote", name="Remote", transport="http", url="https://example.test/mcp")
    calls = 0

    async def fake_load(servers):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ConnectionError("server is still starting")
        return []

    monkeypatch.setattr(mcp_module, "load_mcp_tools", fake_load)

    result = await mcp_module.discover_mcp_tools(
        server,
        timeout_seconds=0.01,
        retry_count=1,
        retry_delay_seconds=0,
    )

    assert calls == 2
    assert result == []
