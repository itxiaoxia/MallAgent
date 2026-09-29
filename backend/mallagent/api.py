from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agent import (
    AgentConfigurationError,
    AgentResult,
    AgentStreamEvent,
    probe_model,
    run_agent,
    stream_agent,
)
from .config import ConversationConflictError, ConfigStore, ConfigStoreError, merge_config_update, public_config
from .mcp import discover_mcp_tools
from .models import AppConfig, McpServerConfig, ModelConfig


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

    conversation_id: str = Field(default="default", min_length=1, max_length=128)
    messages: list[ChatMessage] = Field(min_length=1)

    @field_validator("conversation_id")
    @classmethod
    def validate_conversation_id(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
            raise ValueError("conversation_id must contain only letters, numbers, '-' or '_'")
        return value


class ConfigUpdate(AppConfig):
    clear_api_key: bool = False


class ModelTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: ModelConfig
    clear_api_key: bool = False


AgentRunner = Callable[[AppConfig, list[dict[str, str]]], Awaitable[AgentResult]]
AgentStreamer = Callable[[AppConfig, list[dict[str, str]]], AsyncIterator[AgentStreamEvent]]
McpTester = Callable[[McpServerConfig], Awaitable[list[dict[str, str]]]]
ModelTester = Callable[[ModelConfig], Awaitable[None]]


def _sse_frame(event: AgentStreamEvent) -> str:
    event_type = str(event.get("type", "message"))
    payload = json.dumps(event, ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"


def _validation_message(exc: RequestValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "Invalid request"
    first = errors[0]
    location = ".".join(str(item) for item in first.get("loc", []))
    message = str(first.get("msg", "invalid value"))
    return f"Invalid request at {location}: {message}" if location else f"Invalid request: {message}"


def _resolve_messages(config_store: ConfigStore, request: ChatRequest) -> tuple[list[dict[str, str]], int]:
    requested = [message.model_dump() for message in request.messages]
    snapshot = config_store.load_conversation_snapshot(request.conversation_id)
    stored = snapshot.messages
    if not stored:
        return requested, snapshot.version
    if len(requested) >= len(stored) and requested[: len(stored)] == stored:
        return requested, snapshot.version
    if len(requested) == 1 and requested[0]["role"] == "user":
        if stored[-1] == requested[0]:
            return stored, snapshot.version
        return [*stored, requested[0]], snapshot.version
    raise ConversationConflictError("Conversation history is stale")


def _with_assistant_message(messages: list[dict[str, str]], content: str) -> list[dict[str, str]]:
    return [
        *messages,
        {"role": "assistant", "content": content.strip() or "（模型没有返回文本）"},
    ]


def create_app(
    *,
    store: ConfigStore | None = None,
    agent_runner: AgentRunner | None = None,
    agent_streamer: AgentStreamer | None = None,
    mcp_tester: McpTester | None = None,
    model_tester: ModelTester | None = None,
) -> FastAPI:
    config_store = store or ConfigStore()
    run = agent_runner or run_agent
    stream = agent_streamer or stream_agent
    test_mcp = mcp_tester or discover_mcp_tools
    test_model = model_tester or probe_model
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

    @app.post("/api/model/test")
    async def test_model_endpoint(request: ModelTestRequest) -> dict[str, str]:
        try:
            current = config_store.load()
            effective = merge_config_update(
                current,
                AppConfig(model=request.model),
                clear_api_key=request.clear_api_key,
            )
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored configuration could not be loaded") from exc
        try:
            await test_model(effective.model)
        except AgentConfigurationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Model connection failed. Check model settings.",
            ) from exc
        return {"status": "ok", "model": effective.model.model}

    @app.get("/api/conversations")
    async def list_conversations() -> dict:
        try:
            return {"conversations": config_store.list_conversations()}
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored conversations could not be loaded") from exc

    @app.get("/api/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", conversation_id):
            raise HTTPException(status_code=400, detail="Invalid conversation id")
        try:
            return {
                "conversation_id": conversation_id,
                "messages": config_store.load_conversation(conversation_id),
            }
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored conversation could not be loaded") from exc

    @app.post("/api/chat")
    async def chat(request: ChatRequest) -> dict:
        try:
            config = config_store.load()
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored configuration could not be loaded") from exc
        try:
            messages, version = _resolve_messages(config_store, request)
        except ConversationConflictError as exc:
            raise HTTPException(status_code=409, detail="会话已更新，请刷新后重试。") from exc
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored conversation could not be loaded") from exc
        try:
            result = await run(config, messages)
        except AgentConfigurationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Agent request failed. Check model and MCP settings.",
            ) from exc
        try:
            config_store.save_conversation(
                request.conversation_id,
                _with_assistant_message(messages, result.content),
                expected_version=version,
            )
        except ConversationConflictError as exc:
            raise HTTPException(status_code=409, detail="会话已更新，请刷新后重试。") from exc
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored conversation could not be saved") from exc
        return {"content": result.content, "tool_calls": result.tool_calls}

    @app.post("/api/chat/stream")
    async def chat_stream(request: ChatRequest) -> StreamingResponse:
        try:
            config = config_store.load()
            if not config.model.api_key.strip():
                raise AgentConfigurationError("OpenAI API key is not configured")
        except AgentConfigurationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored configuration could not be loaded") from exc

        try:
            messages, version = _resolve_messages(config_store, request)
        except ConversationConflictError as exc:
            raise HTTPException(status_code=409, detail="会话已更新，请刷新后重试。") from exc
        except ConfigStoreError as exc:
            raise HTTPException(status_code=500, detail="Stored conversation could not be loaded") from exc

        async def event_stream() -> AsyncIterator[str]:
            try:
                async for event in stream(config, messages):
                    if event.get("type") == "done":
                        try:
                            config_store.save_conversation(
                                request.conversation_id,
                                _with_assistant_message(messages, str(event.get("content", ""))),
                                expected_version=version,
                            )
                        except ConversationConflictError:
                            yield _sse_frame(
                                {
                                    "type": "error",
                                    "message": "会话已被其他请求更新，本次回答未写入历史，请重新发送。",
                                }
                            )
                            return
                        except ConfigStoreError:
                            yield _sse_frame(
                                {"type": "error", "message": "回答已生成，但会话历史保存失败。"}
                            )
                            return
                    yield _sse_frame(event)
            except AgentConfigurationError as exc:
                yield _sse_frame({"type": "error", "message": str(exc)})
            except Exception as exc:
                yield _sse_frame(
                    {
                        "type": "error",
                        "message": "Agent request failed. Check model and MCP settings.",
                    }
                )

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

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
