from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import AIMessageChunk

from mallagent import agent as agent_module
from mallagent.agent import AgentConfigurationError, build_chat_model, extract_final_text, run_agent
from mallagent.models import AppConfig, ModelConfig


def test_build_chat_model_uses_configured_openai_compatible_values() -> None:
    config = AppConfig(
        model=ModelConfig(
            base_url="https://proxy.example.test/v1/",
            api_key="test-key",
            model="test-model",
            temperature=0.7,
            max_tokens=512,
            timeout=17,
            retry_count=4,
        )
    )

    model = build_chat_model(config.model)

    assert model.model_name == "test-model"
    assert model.openai_api_base == "https://proxy.example.test/v1"
    assert model.temperature == 0.7
    assert model.max_tokens == 512
    assert model.request_timeout == 17
    assert model.max_retries == 0


def test_build_chat_model_rejects_missing_key() -> None:
    with pytest.raises(AgentConfigurationError, match="API key"):
        build_chat_model(ModelConfig())


@pytest.mark.asyncio
async def test_probe_model_sends_a_minimal_request_without_building_an_agent(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeModel:
        async def ainvoke(self, payload):
            captured["payload"] = payload

    def fake_build_chat_model(config):
        captured["config"] = config
        return FakeModel()

    monkeypatch.setattr(agent_module, "build_chat_model", fake_build_chat_model)

    await agent_module.probe_model(ModelConfig(api_key="test-key", model="test-model"))

    assert captured["config"].model == "test-model"
    assert captured["payload"] == "连接测试：请仅返回 OK。"


def test_openai_compatible_stream_chunk_preserves_reasoning_content() -> None:
    model = build_chat_model(ModelConfig(api_key="test-key"))

    generation = model._convert_chunk_to_generation_chunk(
        {
            "choices": [
                {
                    "delta": {"role": "assistant", "reasoning_content": "先分析"},
                    "finish_reason": None,
                }
            ]
        },
        AIMessageChunk,
        {},
    )

    assert generation is not None
    assert agent_module.extract_reasoning_text(generation.message) == "先分析"


@pytest.mark.asyncio
async def test_run_agent_passes_default_prompt_on_every_request(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeAgent:
        async def ainvoke(self, payload):
            captured["payload"] = payload
            return {"messages": [{"role": "assistant", "content": "ready"}]}

    def fake_create_agent(*, model, tools, system_prompt=None):
        captured["model"] = model
        captured["tools"] = tools
        captured["system_prompt"] = system_prompt
        return FakeAgent()

    monkeypatch.setattr(agent_module, "create_agent", fake_create_agent)
    config = AppConfig(
        model=ModelConfig(api_key="test-key"),
        default_prompt="Always answer in Chinese.",
    )

    result = await run_agent(config, [{"role": "user", "content": "hello"}])

    assert result.content == "ready"
    assert captured["system_prompt"] == "Always answer in Chinese."
    assert captured["payload"] == {"messages": [{"role": "user", "content": "hello"}]}


def test_extract_final_text_supports_text_blocks() -> None:
    message = {
        "content": [
            {"type": "reasoning", "reasoning": "hidden summary"},
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ]
    }

    assert extract_final_text(message) == "first\nsecond"


@pytest.mark.asyncio
async def test_stream_agent_emits_reasoning_and_answer_deltas(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeAgent:
        async def astream(self, payload, **kwargs):
            captured["payload"] = payload
            captured["kwargs"] = kwargs
            yield AIMessageChunk(content=[{"type": "reasoning", "reasoning": "先检查约束"}]), {}
            yield AIMessageChunk(content="这是答案"), {}

    def fake_create_agent(*, model, tools, system_prompt=None):
        captured["system_prompt"] = system_prompt
        return FakeAgent()

    monkeypatch.setattr(agent_module, "create_agent", fake_create_agent)
    config = AppConfig(
        model=ModelConfig(api_key="test-key"),
        default_prompt="Answer in Chinese.",
    )

    events = [event async for event in agent_module.stream_agent(config, [{"role": "user", "content": "hello"}])]

    assert [event["type"] for event in events] == ["start", "reasoning_delta", "content_delta", "done"]
    assert events[1]["content"] == "先检查约束"
    assert events[2]["content"] == "这是答案"
    assert events[-1]["content"] == "这是答案"
    assert captured["system_prompt"] == "Answer in Chinese."
    assert captured["payload"] == {"messages": [{"role": "user", "content": "hello"}]}
    assert captured["kwargs"] == {"stream_mode": "messages", "version": "v1"}


@pytest.mark.asyncio
async def test_stream_agent_retries_timeout_with_a_fresh_agent(monkeypatch) -> None:
    calls = 0

    class FakeAgent:
        async def astream(self, payload, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise asyncio.TimeoutError("timed out")
            yield AIMessageChunk(content="recovered"), {}

    monkeypatch.setattr(agent_module, "create_agent", lambda **kwargs: FakeAgent())
    monkeypatch.setattr(agent_module, "_retry_delay", lambda attempt: 0)
    config = AppConfig(model=ModelConfig(api_key="test-key", retry_count=1))

    events = [event async for event in agent_module.stream_agent(config, [{"role": "user", "content": "hello"}])]

    assert calls == 2
    assert [event["type"] for event in events] == ["start", "retry", "start", "content_delta", "done"]
    assert events[1]["reset_output"] is True
    assert events[-1]["content"] == "recovered"


@pytest.mark.asyncio
async def test_run_agent_enforces_configured_timeout_and_retry_budget(monkeypatch) -> None:
    calls = 0

    class FakeAgent:
        async def ainvoke(self, payload):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(1.05)
            return {"messages": [{"role": "assistant", "content": "recovered"}]}

    monkeypatch.setattr(agent_module, "create_agent", lambda **kwargs: FakeAgent())
    monkeypatch.setattr(agent_module, "_retry_delay", lambda attempt: 0)
    config = AppConfig(model=ModelConfig(api_key="test-key", timeout=1, retry_count=1))

    result = await run_agent(config, [{"role": "user", "content": "hello"}])

    assert calls == 2
    assert result.content == "recovered"
    assert result.attempts == 2
