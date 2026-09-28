from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agent import AgentConfigurationError, AgentResult, run_agent
from .config import ConfigStore, ConfigStoreError, public_config
from .mcp import discover_mcp_tools
from .models import AppConfig, McpServerConfig


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message content must not be blank")
        return value


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1)


class ConfigUpdate(AppConfig):
    clear_api_key: bool = False


AgentRunner = Callable[[AppConfig, list[dict[str, str]]], Awaitable[AgentResult]]
McpTester = Callable[[McpServerConfig], Awaitable[list[dict[str, str]]]]


def _validation_message(exc: RequestValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "Invalid request"
    first = errors[0]
    location = ".".join(str(item) for item in first.get("loc", []))
    message = str(first.get("msg", "invalid value"))
    return f"Invalid request at {location}: {message}" if location else f"Invalid request: {message}"


def create_app(
    *,
    store: ConfigStore | None = None,
    agent_runner: AgentRunner | None = None,
    mcp_tester: McpTester | None = None,
) -> FastAPI:
    config_store = store or ConfigStore()
    run = agent_runner or run_agent
    test_mcp = mcp_tester or discover_mcp_tools
    app = FastAPI(title="MallAgent Backend", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "http://tauri.localhost"],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": _validation_message(exc)})

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/api/config")
    async def get_config() -> dict:
        try:
            return public_config(config_store.load())
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored configuration could not be loaded") from exc

    @app.put("/api/config")
    async def put_config(update: ConfigUpdate) -> dict:
        try:
            incoming = AppConfig.model_validate(update.model_dump(exclude={"clear_api_key"}))
            updated = config_store.update(incoming, clear_api_key=update.clear_api_key)
            return public_config(updated)
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Configuration could not be saved") from exc

    @app.post("/api/chat")
    async def chat(request: ChatRequest) -> dict:
        try:
            config = config_store.load()
            result = await run(config, [message.model_dump() for message in request.messages])
            return {"content": result.content, "tool_calls": result.tool_calls}
        except AgentConfigurationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored configuration could not be loaded") from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Agent request failed. Check model and MCP settings.",
            ) from exc

    @app.post("/api/mcp/test")
    async def test_mcp_endpoint(server: McpServerConfig) -> dict:
        if not server.enabled:
            raise HTTPException(status_code=400, detail="Enable the MCP server before testing it")
        try:
            return {"server_id": server.id, "tools": await test_mcp(server)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="MCP connection failed. Check the server settings.",
            ) from exc

    return app


app = create_app()
