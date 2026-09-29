from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx
import openai
from langchain.agents import create_agent
from langchain_core.messages import AIMessageChunk
from langchain_openai import ChatOpenAI

from .mcp import load_mcp_tools_resilient
from .models import AppConfig, ModelConfig


class AgentConfigurationError(ValueError):
    """Raised when the model cannot be constructed from user settings."""


AgentStreamEvent = dict[str, Any]


@dataclass(frozen=True)
class AgentResult:
    content: str
    tool_calls: list[str] = field(default_factory=list)
    reasoning: str = ""
    attempts: int = 1


@dataclass
class _AttemptOutput:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[str] = field(default_factory=list)


def _raw_delta(chunk: Any) -> Mapping[str, Any]:
    if not isinstance(chunk, Mapping):
        return {}
    choices = chunk.get("choices") or []
    if not choices and isinstance(chunk.get("chunk"), Mapping):
        choices = chunk["chunk"].get("choices") or []
    if not choices or not isinstance(choices[0], Mapping):
        return {}
    delta = choices[0].get("delta")
    if isinstance(delta, Mapping):
        return delta
    if hasattr(delta, "model_dump"):
        dumped = delta.model_dump()
        return dumped if isinstance(dumped, Mapping) else {}
    return {}


def _reasoning_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        for key in ("reasoning", "reasoning_content", "text", "summary"):
            if key in value:
                text = _reasoning_text(value[key])
                if text:
                    return text
        return ""
    if isinstance(value, list):
        return "".join(_reasoning_text(item) for item in value)
    return ""


def _reasoning_from_mapping(value: Mapping[str, Any]) -> str:
    for key in ("reasoning_content", "reasoning", "reasoning_details"):
        if key in value:
            text = _reasoning_text(value[key])
            if text:
                return text
    return ""


class OpenAICompatibleChatOpenAI(ChatOpenAI):
    """ChatOpenAI that keeps common OpenAI-compatible reasoning deltas.

    The official Chat Completions schema does not define `reasoning_content`, so
    the base LangChain adapter intentionally drops it. Several compatible
    providers use that field for a streamed reasoning summary; preserve only its
    textual portion so the UI can render it without changing the request format.
    """

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
        generation = super()._convert_chunk_to_generation_chunk(
            chunk,
            default_chunk_class,
            base_generation_info,
        )
        reasoning = _reasoning_from_mapping(_raw_delta(chunk))
        if generation is not None and reasoning:
            generation.message.additional_kwargs["reasoning_content"] = reasoning
        return generation


def build_chat_model(config: ModelConfig) -> ChatOpenAI:
    if not config.api_key.strip():
        raise AgentConfigurationError("OpenAI API key is not configured")
    kwargs: dict[str, Any] = {
        "model": config.model,
        "api_key": config.api_key,
        "base_url": config.base_url,
        "temperature": config.temperature,
        "max_retries": 0,
        "timeout": config.timeout,
        "stream_usage": False,
    }
    if config.max_tokens is not None:
        kwargs["max_tokens"] = config.max_tokens
    return OpenAICompatibleChatOpenAI(**kwargs)


async def probe_model(config: ModelConfig) -> None:
    """Make one direct model request without creating an agent or touching history."""

    model = build_chat_model(config)
    await model.ainvoke("连接测试：请仅返回 OK。")


def _message_type(message: Any) -> str:
    message_type = getattr(message, "type", None)
    if message_type is None and isinstance(message, Mapping):
        message_type = message.get("type") or message.get("role")
    return str(message_type or "").lower()


def _iter_content_blocks(message: Any) -> list[Any]:
    blocks = getattr(message, "content_blocks", None)
    if isinstance(blocks, list):
        return blocks
    content = getattr(message, "content", None)
    if content is None and isinstance(message, Mapping):
        content = message.get("content")
    return content if isinstance(content, list) else []


def extract_reasoning_text(message: Any) -> str:
    blocks = _iter_content_blocks(message)
    for block in blocks:
        if isinstance(block, Mapping) and block.get("type") in {"reasoning", "thinking", "reasoning_content"}:
            text = _reasoning_text(block)
            if text:
                return text

    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, Mapping):
        text = _reasoning_from_mapping(additional_kwargs)
        if text:
            return text
    if isinstance(message, Mapping):
        text = _reasoning_from_mapping(message)
        if text:
            return text
    return ""


def extract_text_delta(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, Mapping):
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                if block.get("type") in {"reasoning", "thinking", "reasoning_content"}:
                    continue
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
        return "".join(parts)
    return ""


def extract_final_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, Mapping):
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                if block.get("type") in {"reasoning", "thinking", "reasoning_content"}:
                    continue
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
        return "\n".join(parts)
    return "" if content is None else str(content)


def _message_tool_name(message: Any) -> str | None:
    message_type = _message_type(message)
    if message_type not in {"tool", "tool_call"}:
        return None
    name = getattr(message, "name", None)
    if name is None and isinstance(message, Mapping):
        name = message.get("name")
    return str(name) if name else None


def _stream_tool_names(message: Any) -> list[str]:
    raw_calls = getattr(message, "tool_call_chunks", None)
    if raw_calls is None:
        raw_calls = getattr(message, "tool_calls", None)
    if raw_calls is None and isinstance(message, Mapping):
        raw_calls = message.get("tool_call_chunks") or message.get("tool_calls")
    if not isinstance(raw_calls, list):
        return []
    names: list[str] = []
    for call in raw_calls:
        name = call.get("name") if isinstance(call, Mapping) else getattr(call, "name", None)
        if name and str(name) not in names:
            names.append(str(name))
    return names


def _unpack_stream_item(item: Any) -> Any:
    if isinstance(item, tuple) and len(item) == 2:
        first = item[0]
        if isinstance(first, Mapping) and first.get("type") == "messages":
            data = first.get("data")
            if isinstance(data, tuple) and data:
                return data[0]
        return first
    if isinstance(item, Mapping) and item.get("type") == "messages":
        data = item.get("data")
        if isinstance(data, tuple) and data:
            return data[0]
    return item


async def _build_agent(config: AppConfig) -> tuple[Any, list[str]]:
    model = build_chat_model(config.model)
    loaded = await load_mcp_tools_resilient(config.mcp_servers)
    agent_kwargs: dict[str, Any] = {"model": model, "tools": loaded.tools}
    if config.default_prompt:
        agent_kwargs["system_prompt"] = config.default_prompt
    return create_agent(**agent_kwargs), loaded.failed_server_ids


def is_retryable_error(error: BaseException) -> bool:
    if isinstance(error, (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(error, (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)):
        return True
    if isinstance(error, openai.APIStatusError):
        return error.status_code in {408, 409, 425, 429} or error.status_code >= 500
    return False


def _retry_delay(attempt: int) -> float:
    return min(0.5 * (2 ** max(0, attempt - 1)), 8.0)


def _retry_message(error: BaseException) -> str:
    if isinstance(error, (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException)):
        return "请求超时，正在重建模型连接后重试"
    return "连接暂时不可用，正在重建模型与 MCP 连接后重试"


async def run_agent(config: AppConfig, messages: list[dict[str, str]]) -> AgentResult:
    total_attempts = config.model.retry_count + 1
    for attempt in range(1, total_attempts + 1):
        try:
            async with asyncio.timeout(config.model.timeout):
                agent, _ = await _build_agent(config)
                result = await agent.ainvoke({"messages": messages})
            result_messages = result.get("messages", []) if isinstance(result, Mapping) else []
            if not result_messages:
                return AgentResult(content="", attempts=attempt)
            tool_calls = [
                name
                for name in (_message_tool_name(message) for message in result_messages)
                if name is not None
            ]
            return AgentResult(
                content=extract_final_text(result_messages[-1]),
                tool_calls=tool_calls,
                reasoning=extract_reasoning_text(result_messages[-1]),
                attempts=attempt,
            )
        except Exception as error:
            if not is_retryable_error(error) or attempt >= total_attempts:
                raise
            await asyncio.sleep(_retry_delay(attempt))
    raise RuntimeError("Agent retry loop exited unexpectedly")


async def _stream_agent_attempt(
    config: AppConfig,
    messages: list[dict[str, str]],
    output: _AttemptOutput,
) -> AsyncIterator[AgentStreamEvent]:
    agent, failed_server_ids = await _build_agent(config)
    for server_id in failed_server_ids:
        yield {
            "type": "self_heal",
            "server_id": server_id,
            "message": "MCP 服务暂不可用，已跳过并继续使用其他工具",
        }

    async for item in agent.astream(
        {"messages": messages},
        stream_mode="messages",
        version="v1",
    ):
        message = _unpack_stream_item(item)
        if _message_type(message) not in {"ai", "assistant"} and not isinstance(message, AIMessageChunk):
            continue

        reasoning = extract_reasoning_text(message)
        if reasoning:
            output.reasoning += reasoning
            yield {"type": "reasoning_delta", "content": reasoning}

        text = extract_text_delta(message)
        if text:
            output.content += text
            yield {"type": "content_delta", "content": text}

        for tool_name in _stream_tool_names(message):
            if tool_name not in output.tool_calls:
                output.tool_calls.append(tool_name)
                yield {"type": "tool_call", "name": tool_name}


async def stream_agent(
    config: AppConfig,
    messages: list[dict[str, str]],
) -> AsyncIterator[AgentStreamEvent]:
    total_attempts = config.model.retry_count + 1
    for attempt in range(1, total_attempts + 1):
        yield {"type": "start", "attempt": attempt, "max_attempts": total_attempts}
        output = _AttemptOutput()
        try:
            async with asyncio.timeout(config.model.timeout):
                async for event in _stream_agent_attempt(config, messages, output):
                    yield event
            yield {
                "type": "done",
                "content": output.content,
                "reasoning": output.reasoning,
                "tool_calls": output.tool_calls,
                "attempts": attempt,
            }
            return
        except Exception as error:
            if not is_retryable_error(error) or attempt >= total_attempts:
                raise
            yield {
                "type": "retry",
                "attempt": attempt,
                "next_attempt": attempt + 1,
                "max_attempts": total_attempts,
                "message": _retry_message(error),
                "reset_output": True,
            }
            await asyncio.sleep(_retry_delay(attempt))
