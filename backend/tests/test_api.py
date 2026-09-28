from __future__ import annotations

from fastapi.testclient import TestClient

from mallagent.agent import AgentConfigurationError, AgentResult
from mallagent.api import create_app
from mallagent.config import ConfigStore
from mallagent.models import AppConfig, ModelConfig


def _store(tmp_path, *, api_key: str = "") -> ConfigStore:
    store = ConfigStore(tmp_path / "config.json")
    store.save(AppConfig(model=ModelConfig(api_key=api_key)))
    return store


def test_health_reports_ready_service(tmp_path) -> None:
    client = TestClient(create_app(store=_store(tmp_path)))

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.1.0"}


def test_get_config_redacts_api_key(tmp_path) -> None:
    client = TestClient(create_app(store=_store(tmp_path, api_key="secret")))

    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json()["model"]["api_key"] == ""
    assert response.json()["model"]["api_key_configured"] is True


def test_put_config_preserves_key_when_form_is_blank(tmp_path) -> None:
    store = _store(tmp_path, api_key="secret")
    client = TestClient(create_app(store=store))

    response = client.put(
        "/api/config",
        json={
            "model": {
                "base_url": "https://api.openai.com/v1",
                "api_key": "",
                "model": "gpt-4o-mini",
                "temperature": 0.2,
                "max_tokens": None,
            },
            "default_prompt": "Updated prompt",
            "mcp_servers": [],
            "clear_api_key": False,
        },
    )

    assert response.status_code == 200
    assert store.load().model.api_key == "secret"
    assert response.json()["model"]["api_key"] == ""


def test_chat_returns_agent_result_without_exposing_config_secret(tmp_path) -> None:
    captured: dict[str, object] = {}

    async def fake_runner(config, messages):
        captured["config"] = config
        captured["messages"] = messages
        return AgentResult(content="你好", tool_calls=["local_add"])

    client = TestClient(create_app(store=_store(tmp_path, api_key="secret"), agent_runner=fake_runner))

    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"content": "你好", "tool_calls": ["local_add"]}
    assert captured["messages"] == [{"role": "user", "content": "hello"}]


def test_chat_reports_missing_key_as_client_error(tmp_path) -> None:
    async def failing_runner(config, messages):
        raise AgentConfigurationError("OpenAI API key is not configured")

    client = TestClient(create_app(store=_store(tmp_path), agent_runner=failing_runner))

    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "OpenAI API key is not configured"


def test_chat_maps_external_failure_to_502_without_raw_error(tmp_path) -> None:
    async def failing_runner(config, messages):
        raise RuntimeError("provider secret should not be returned")

    client = TestClient(create_app(store=_store(tmp_path, api_key="secret"), agent_runner=failing_runner))

    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Agent request failed. Check model and MCP settings."
    assert "provider secret" not in response.text
