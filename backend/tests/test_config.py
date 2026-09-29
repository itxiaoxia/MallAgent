from __future__ import annotations

import json
import sqlite3

import pytest
from pydantic import ValidationError

from mallagent.config import ConversationConflictError, ConfigStore, merge_config_update, public_config
from mallagent.models import AppConfig, ModelConfig, McpServerConfig


def test_default_config_has_openai_defaults() -> None:
    config = AppConfig()

    assert config.model.base_url == "https://api.openai.com/v1"
    assert config.model.model == "gpt-4o-mini"
    assert config.model.temperature == 0.2
    assert config.model.timeout == 60
    assert config.model.retry_count == 2
    assert config.default_prompt == ""
    assert config.mcp_servers == []


def test_model_config_rejects_invalid_url_and_blank_model() -> None:
    with pytest.raises(ValidationError):
        ModelConfig(base_url="not-a-url")

    with pytest.raises(ValidationError):
        ModelConfig(model="  ")

    with pytest.raises(ValidationError):
        ModelConfig(timeout=0)


def test_model_config_migrates_legacy_temperature_two_below_provider_limit() -> None:
    migrated = ModelConfig(temperature=2)

    assert migrated.temperature == 1.9
    assert ModelConfig(temperature=1.9).temperature == 1.9

    with pytest.raises(ValidationError):
        ModelConfig(temperature=2.01)

    with pytest.raises(ValidationError):
        ModelConfig(retry_count=-1)

    with pytest.raises(ValidationError):
        ModelConfig(retry_count=11)


def test_disabled_incomplete_mcp_server_can_be_saved_but_enabled_one_cannot() -> None:
    disabled = McpServerConfig(id="draft", name="Draft", enabled=False)
    assert disabled.enabled is False

    with pytest.raises(ValidationError):
        McpServerConfig(id="live", name="Live", enabled=True)


def test_config_store_round_trips_in_sqlite(tmp_path) -> None:
    path = tmp_path / "config.db"
    store = ConfigStore(path)
    config = AppConfig(default_prompt="Be precise")

    store.save(config)

    assert store.load() == config
    with sqlite3.connect(path) as connection:
        payload = connection.execute("SELECT payload FROM app_config WHERE id = 1").fetchone()[0]
    assert json.loads(payload)["default_prompt"] == "Be precise"


def test_config_store_migrates_legacy_json_once(tmp_path) -> None:
    legacy_path = tmp_path / "config.json"
    database_path = tmp_path / "config.db"
    legacy_path.write_text(
        json.dumps(AppConfig(default_prompt="Migrated", model=ModelConfig(api_key="secret")).model_dump(mode="json")),
        encoding="utf-8",
    )

    store = ConfigStore(database_path)

    loaded = store.load()

    assert loaded.default_prompt == "Migrated"
    assert loaded.model.api_key == "secret"
    assert database_path.exists()


def test_public_config_redacts_api_key() -> None:
    config = AppConfig(model=ModelConfig(api_key="secret-key"))

    result = public_config(config)

    assert result["model"]["api_key"] == ""
    assert result["model"]["api_key_configured"] is True
    assert "secret-key" not in json.dumps(result)


def test_blank_api_key_preserves_existing_key_and_clear_removes_it() -> None:
    existing = AppConfig(model=ModelConfig(api_key="old-key"))
    incoming = AppConfig(default_prompt="updated")

    preserved = merge_config_update(existing, incoming)
    cleared = merge_config_update(existing, incoming, clear_api_key=True)

    assert preserved.model.api_key == "old-key"
    assert preserved.default_prompt == "updated"
    assert cleared.model.api_key == ""


def test_config_store_round_trips_conversation_history(tmp_path) -> None:
    store = ConfigStore(tmp_path / "config.db")
    history = [
        {"role": "user", "content": "我叫小明"},
        {"role": "assistant", "content": "你好，小明"},
    ]

    store.save_conversation("conversation-1", history)

    assert store.load_conversation("conversation-1") == history
    assert store.load_conversation("conversation-2") == []


def test_config_store_rejects_stale_conversation_version(tmp_path) -> None:
    store = ConfigStore(tmp_path / "config.db")
    initial = store.load_conversation_snapshot("conversation-1")

    store.save_conversation(
        "conversation-1",
        [{"role": "user", "content": "第一轮"}, {"role": "assistant", "content": "回答"}],
        expected_version=initial.version,
    )

    with pytest.raises(ConversationConflictError):
        store.save_conversation(
            "conversation-1",
            [{"role": "user", "content": "旧窗口的问题"}, {"role": "assistant", "content": "旧窗口的回答"}],
            expected_version=initial.version,
        )


def test_config_store_migrates_conversation_table_without_version_column(tmp_path) -> None:
    path = tmp_path / "config.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO conversations (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            ("conversation-1", json.dumps([{"role": "user", "content": "旧历史"}])),
        )

    store = ConfigStore(path)
    snapshot = store.load_conversation_snapshot("conversation-1")

    assert snapshot.version == 0
    assert snapshot.messages == [{"role": "user", "content": "旧历史"}]


def test_config_store_lists_conversation_summaries_newest_first(tmp_path) -> None:
    path = tmp_path / "config.db"
    store = ConfigStore(path)
    store.save_conversation(
        "conversation-old",
        [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}],
    )
    store.save_conversation(
        "conversation-new",
        [{"role": "user", "content": "最新问题"}, {"role": "assistant", "content": "最新回答"}],
    )
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            ("2026-09-28 10:00:00", "conversation-old"),
        )
        connection.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            ("2026-09-29 10:00:00", "conversation-new"),
        )

    assert store.list_conversations() == [
        {
            "conversation_id": "conversation-new",
            "title": "最新问题",
            "updated_at": "2026-09-29 10:00:00",
        },
        {
            "conversation_id": "conversation-old",
            "title": "旧问题",
            "updated_at": "2026-09-28 10:00:00",
        },
    ]
