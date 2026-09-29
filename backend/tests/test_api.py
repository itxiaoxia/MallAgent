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


def test_tauri_origin_is_allowed_for_local_api(tmp_path) -> None:
    client = TestClient(create_app(store=_store(tmp_path)))

    response = client.get("/api/health", headers={"Origin": "http://tauri.localhost"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://tauri.localhost"


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


def test_model_test_uses_saved_key_without_persisting_the_draft(tmp_path) -> None:
    store = _store(tmp_path, api_key="saved-secret")
    captured: dict[str, object] = {}

    async def fake_model_tester(config):
        captured["config"] = config

    client = TestClient(create_app(store=store, model_tester=fake_model_tester))

    response = client.post(
        "/api/model/test",
        json={
            "model": {
                "base_url": "https://provider.example/v1",
                "api_key": "",
                "model": "provider-model",
                "temperature": 0.7,
                "max_tokens": 512,
                "timeout": 30,
                "retry_count": 0,
            },
            "clear_api_key": False,
        },
    )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "model": "provider-model"}
    assert captured["config"].api_key == "saved-secret"
    assert captured["config"].base_url == "https://provider.example/v1"
    assert store.load().model.api_key == "saved-secret"


def test_model_test_maps_provider_failure_without_exposing_raw_error(tmp_path) -> None:
    async def failing_model_tester(config):
        raise RuntimeError("provider secret should not be returned")

    client = TestClient(create_app(store=_store(tmp_path, api_key="secret"), model_tester=failing_model_tester))

    response = client.post(
        "/api/model/test",
        json={"model": {"api_key": "", "model": "gpt-4o-mini"}, "clear_api_key": False},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Model connection failed. Check model settings."
    assert "provider secret" not in response.text


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


def test_chat_reuses_persisted_context_when_next_request_only_has_new_user_message(tmp_path) -> None:
    captured: list[list[dict[str, str]]] = []

    async def fake_runner(config, messages):
        captured.append(messages)
        return AgentResult(content=f"回答第 {len(captured)} 轮", tool_calls=[])

    client = TestClient(create_app(store=_store(tmp_path, api_key="secret"), agent_runner=fake_runner))

    first = client.post(
        "/api/chat",
        json={
            "conversation_id": "conversation-1",
            "messages": [{"role": "user", "content": "我叫小明"}],
        },
    )
    second = client.post(
        "/api/chat",
        json={
            "conversation_id": "conversation-1",
            "messages": [{"role": "user", "content": "我叫什么？"}],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert captured == [
        [{"role": "user", "content": "我叫小明"}],
        [
            {"role": "user", "content": "我叫小明"},
            {"role": "assistant", "content": "回答第 1 轮"},
            {"role": "user", "content": "我叫什么？"},
        ],
    ]


def test_get_conversation_returns_persisted_history(tmp_path) -> None:
    store = _store(tmp_path, api_key="secret")
    store.save_conversation(
        "conversation-1",
        [{"role": "user", "content": "之前的问题"}, {"role": "assistant", "content": "之前的回答"}],
    )
    client = TestClient(create_app(store=store))

    response = client.get("/api/conversations/conversation-1")

    assert response.status_code == 200
    assert response.json() == {
        "conversation_id": "conversation-1",
        "messages": [
            {"role": "user", "content": "之前的问题"},
            {"role": "assistant", "content": "之前的回答"},
        ],
    }


def test_list_conversations_returns_titles_and_ids(tmp_path) -> None:
    store = _store(tmp_path, api_key="secret")
    store.save_conversation(
        "conversation-1",
        [{"role": "user", "content": "查询商品"}, {"role": "assistant", "content": "好的"}],
    )
    client = TestClient(create_app(store=store))

    response = client.get("/api/conversations")

    assert response.status_code == 200
    assert response.json()["conversations"][0]["conversation_id"] == "conversation-1"
    assert response.json()["conversations"][0]["title"] == "查询商品"
    assert response.json()["conversations"][0]["updated_at"]


def test_delete_conversation_removes_only_the_requested_history(tmp_path) -> None:
    store = _store(tmp_path, api_key="secret")
    store.save_conversation(
        "conversation-1",
        [{"role": "user", "content": "要删除的问题"}, {"role": "assistant", "content": "回答"}],
    )
    store.save_conversation(
        "conversation-2",
        [{"role": "user", "content": "要保留的问题"}, {"role": "assistant", "content": "回答"}],
    )
    client = TestClient(create_app(store=store))

    response = client.delete("/api/conversations/conversation-1")

    assert response.status_code == 200
    assert response.json() == {"conversation_id": "conversation-1", "deleted": True}
    assert client.get("/api/conversations/conversation-1").json()["messages"] == []
    assert [item["conversation_id"] for item in client.get("/api/conversations").json()["conversations"]] == [
        "conversation-2"
    ]
    assert store.load().model.api_key == "secret"


def test_chat_rejects_stale_full_history_instead_of_overwriting_newer_context(tmp_path) -> None:
    store = _store(tmp_path, api_key="secret")
    store.save_conversation(
        "conversation-1",
        [
            {"role": "user", "content": "第一轮"},
            {"role": "assistant", "content": "第一轮回答"},
            {"role": "user", "content": "第二轮"},
            {"role": "assistant", "content": "第二轮回答"},
        ],
    )
    called = False

    async def fake_runner(config, messages):
        nonlocal called
        called = True
        return AgentResult(content="不应被调用", tool_calls=[])

    client = TestClient(create_app(store=store, agent_runner=fake_runner))

    response = client.post(
        "/api/chat",
        json={
            "conversation_id": "conversation-1",
            "messages": [
                {"role": "user", "content": "第一轮"},
                {"role": "assistant", "content": "第一轮回答"},
                {"role": "user", "content": "旧窗口的问题"},
            ],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "会话已更新，请刷新后重试。"
    assert called is False


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


def test_stream_chat_returns_incremental_sse_events(tmp_path) -> None:
    async def fake_stream(config, messages):
        assert config.model.api_key == "secret"
        assert messages == [{"role": "user", "content": "hello"}]
        yield {"type": "start", "attempt": 1, "max_attempts": 1}
        yield {"type": "content_delta", "content": "你好"}
        yield {"type": "done", "content": "你好", "tool_calls": [], "attempts": 1}

    client = TestClient(
        create_app(store=_store(tmp_path, api_key="secret"), agent_streamer=fake_stream)
    )

    response = client.post(
        "/api/chat/stream",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: content_delta" in response.text
    assert '"content": "你好"' in response.text
    assert response.text.endswith("\n\n")
    assert client.get("/api/conversations/default").json()["messages"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "你好"},
    ]


def test_stream_chat_reuses_persisted_context_for_the_next_turn(tmp_path) -> None:
    captured: list[list[dict[str, str]]] = []

    async def fake_stream(config, messages):
        captured.append(messages)
        answer = f"回答第 {len(captured)} 轮"
        yield {"type": "content_delta", "content": answer}
        yield {"type": "done", "content": answer, "tool_calls": [], "attempts": 1}

    client = TestClient(
        create_app(store=_store(tmp_path, api_key="secret"), agent_streamer=fake_stream)
    )

    first = client.post(
        "/api/chat/stream",
        json={"conversation_id": "conversation-1", "messages": [{"role": "user", "content": "我叫小明"}]},
    )
    second = client.post(
        "/api/chat/stream",
        json={"conversation_id": "conversation-1", "messages": [{"role": "user", "content": "我叫什么？"}]},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert captured == [
        [{"role": "user", "content": "我叫小明"}],
        [
            {"role": "user", "content": "我叫小明"},
            {"role": "assistant", "content": "回答第 1 轮"},
            {"role": "user", "content": "我叫什么？"},
        ],
    ]


def test_stream_chat_reports_missing_key_before_opening_stream(tmp_path) -> None:
    client = TestClient(create_app(store=_store(tmp_path)))

    response = client.post(
        "/api/chat/stream",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "OpenAI API key is not configured"


def test_stream_chat_sanitizes_generator_failure(tmp_path) -> None:
    async def failing_stream(config, messages):
        yield {"type": "start", "attempt": 1, "max_attempts": 1}
        raise RuntimeError("provider secret should not be returned")

    client = TestClient(
        create_app(store=_store(tmp_path, api_key="secret"), agent_streamer=failing_stream)
    )

    response = client.post(
        "/api/chat/stream",
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 200
    assert "event: error" in response.text
    assert "provider secret" not in response.text
    assert "Agent request failed. Check model and MCP settings." in response.text
    assert client.get("/api/conversations/default").json()["messages"] == []
