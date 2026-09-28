from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ModelConfig(BaseModel):
    """Settings for an OpenAI-compatible chat-completions endpoint."""

    model_config = ConfigDict(extra="forbid")

    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o-mini"
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1)

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


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: ModelConfig = Field(default_factory=ModelConfig)
    default_prompt: str = ""
    mcp_servers: list[McpServerConfig] = Field(default_factory=list)

    @field_validator("default_prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        return value.strip()
