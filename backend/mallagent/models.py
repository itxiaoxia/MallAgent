from __future__ import annotations

import os
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_JAVA_MCP_SERVER_ID = "mall-system-java"
DEFAULT_JAVA_MCP_NAME = "商城 Java MCP"
DEFAULT_JAVA_MCP_HOST = "127.0.0.1"
DEFAULT_JAVA_MCP_PORT = 9991
LEGACY_DEFAULT_JAVA_MCP_ID = "running-http"
LEGACY_DEFAULT_JAVA_MCP_NAME = "Running MCP"
DEFAULT_MODEL_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL_NAME = "qwen3.8-max"
LEGACY_MODEL_BASE_URL = "https://api.openai.com/v1"
LEGACY_MODEL_NAME = "gpt-4o-mini"
DEFAULT_MODEL_API_KEY = os.environ.get(
    "MALLAGENT_DEFAULT_MODEL_API_KEY",
    "sk-98f6a946a3b24f9183ac94a34bc95121",
)


class ModelConfig(BaseModel):
    """Settings for an OpenAI-compatible chat-completions endpoint."""

    model_config = ConfigDict(extra="forbid")

    base_url: str = DEFAULT_MODEL_BASE_URL
    api_key: str = ""
    model: str = DEFAULT_MODEL_NAME
    temperature: float = Field(default=0.2, ge=0, lt=2)
    max_tokens: int | None = Field(default=None, ge=1)
    timeout: float = Field(default=60, ge=1, le=3600)
    retry_count: int = Field(default=2, ge=0, le=10)

    @field_validator("temperature", mode="before")
    @classmethod
    def migrate_legacy_temperature(cls, value: object) -> object:
        """Keep existing configs using the old inclusive upper bound loadable."""
        try:
            if float(value) == 2:
                return 1.9
        except (TypeError, ValueError):
            pass
        return value

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute http or https URL")
        return value

    @field_validator("model")
    @classmethod
    def validate_model_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("model must not be blank")
        return value


class McpServerConfig(BaseModel):
    """A user-configured MCP server using stdio or streamable HTTP."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    transport: Literal["stdio", "http"] = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("id", "name")
    @classmethod
    def validate_identity(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("MCP server id and name must not be blank")
        return value

    @field_validator("url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        return value.strip().rstrip("/")

    @model_validator(mode="after")
    def validate_transport_settings(self) -> "McpServerConfig":
        if not self.enabled:
            return self
        if self.transport == "stdio" and not self.command.strip():
            raise ValueError("enabled stdio MCP servers require command")
        if self.transport == "http":
            parsed = urlparse(self.url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError("enabled HTTP MCP servers require an absolute http or https URL")
        return self


def default_java_mcp_server(port: int = DEFAULT_JAVA_MCP_PORT) -> McpServerConfig:
    if not 1 <= port <= 65535:
        raise ValueError("MCP port must be between 1 and 65535")
    return McpServerConfig(
        id=DEFAULT_JAVA_MCP_SERVER_ID,
        name=DEFAULT_JAVA_MCP_NAME,
        transport="http",
        url=f"http://{DEFAULT_JAVA_MCP_HOST}:{port}/mcp",
        enabled=True,
    )


def _is_legacy_default_java_mcp(server: McpServerConfig) -> bool:
    return (
        server.enabled
        and server.id == LEGACY_DEFAULT_JAVA_MCP_ID
        and server.name == LEGACY_DEFAULT_JAVA_MCP_NAME
        and server.transport == "http"
        and server.url == default_java_mcp_server().url
        and not server.headers
    )


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: ModelConfig = Field(default_factory=ModelConfig)
    default_prompt: str = ""
    mcp_servers: list[McpServerConfig] = Field(default_factory=lambda: [default_java_mcp_server()])

    @field_validator("default_prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        return value.strip()


def ensure_default_java_mcp(config: AppConfig) -> AppConfig:
    """Keep one built-in Java MCP and migrate the previous default alias."""

    user_servers: list[McpServerConfig] = []
    built_in: McpServerConfig | None = None
    for server in config.mcp_servers:
        if server.id == DEFAULT_JAVA_MCP_SERVER_ID:
            if built_in is None:
                built_in = server
            continue
        if _is_legacy_default_java_mcp(server):
            continue
        user_servers.append(server)
    if built_in is None:
        built_in = default_java_mcp_server()
    return config.model_copy(deep=True, update={"mcp_servers": [*user_servers, built_in]})


def ensure_builtin_model(config: AppConfig) -> AppConfig:
    """Migrate only the old untouched, unconfigured model defaults."""

    if config.model.api_key.strip():
        return config
    if config.model.base_url != LEGACY_MODEL_BASE_URL or config.model.model != LEGACY_MODEL_NAME:
        return config
    model = config.model.model_copy(
        update={
            "base_url": DEFAULT_MODEL_BASE_URL,
            "model": DEFAULT_MODEL_NAME,
            "api_key": DEFAULT_MODEL_API_KEY,
        }
    )
    return config.model_copy(deep=True, update={"model": model})
