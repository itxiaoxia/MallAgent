from mallagent.mcp import build_mcp_config
from mallagent.models import McpServerConfig


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
