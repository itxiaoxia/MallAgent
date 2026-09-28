from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

from .mcp import load_mcp_tools
from .models import AppConfig, ModelConfig


class AgentConfigurationError(ValueError):
    """Raised when the model cannot be constructed from user settings."""


@dataclass(frozen=True)
class AgentResult:
    content: str
    tool_calls: list[str] = field(default_factory=list)


def build_chat_model(config: ModelConfig) -> ChatOpenAI:
    if not config.api_key.strip():
        raise AgentConfigurationError("OpenAI API key is not configured")
    kwargs: dict[str, Any] = {
        "model": config.model,
        "api_key": config.api_key,
        "base_url": config.base_url,
        "temperature": config.temperature,
        "max_retries": 1,
        "timeout": 60,
        "stream_usage": False,
    }
    if config.max_tokens is not None:
        kwargs["max_tokens"] = config.max_tokens
    return ChatOpenAI(**kwargs)


def extract_final_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
        return "\n".join(parts)
    return "" if content is None else str(content)


def _message_tool_name(message: Any) -> str | None:
    message_type = getattr(message, "type", None)
    if message_type is None and isinstance(message, dict):
        message_type = message.get("type") or message.get("role")
    if message_type not in {"tool", "tool_call"}:
        return None
    name = getattr(message, "name", None)
    if name is None and isinstance(message, dict):
        name = message.get("name")
    return str(name) if name else None


async def run_agent(config: AppConfig, messages: list[dict[str, str]]) -> AgentResult:
    model = build_chat_model(config.model)
    tools = await load_mcp_tools(config.mcp_servers)
    agent_kwargs: dict[str, Any] = {"model": model, "tools": tools}
    if config.default_prompt:
        agent_kwargs["system_prompt"] = config.default_prompt
    agent = create_agent(**agent_kwargs)
    result = await agent.ainvoke({"messages": messages})
    result_messages = result.get("messages", []) if isinstance(result, dict) else []
    if not result_messages:
        return AgentResult(content="")
    tool_calls = [
        name
        for name in (_message_tool_name(message) for message in result_messages)
        if name is not None
    ]
    return AgentResult(content=extract_final_text(result_messages[-1]), tool_calls=tool_calls)
