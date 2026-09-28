from __future__ import annotations

import pytest

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
        )
    )

    model = build_chat_model(config.model)

    assert model.model_name == "test-model"
    assert model.openai_api_base == "https://proxy.example.test/v1"
    assert model.temperature == 0.7
    assert model.max_tokens == 512


def test_build_chat_model_rejects_missing_key() -> None:
    with pytest.raises(AgentConfigurationError, match="API key"):
        build_chat_model(ModelConfig())


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
    message = {"content": [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}]}

    assert extract_final_text(message) == "first\nsecond"
