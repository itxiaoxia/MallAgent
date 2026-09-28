from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from mallagent.config import ConfigStore, merge_config_update, public_config
from mallagent.models import AppConfig, ModelConfig, McpServerConfig


def test_default_config_has_openai_defaults() -> None:
    config = AppConfig()

    assert config.model.base_url == "https://api.openai.com/v1"
    assert config.model.model == "gpt-4o-mini"
    assert config.model.temperature == 0.2
    assert config.default_prompt == ""
    assert config.mcp_servers == []


def test_model_config_rejects_invalid_url_and_blank_model() -> None:
    with pytest.raises(ValidationError):
        ModelConfig(base_url="not-a-url")

    with pytest.raises(ValidationError):
        ModelConfig(model="  ")


def test_disabled_incomplete_mcp_server_can_be_saved_but_enabled_one_cannot() -> None:
    disabled = McpServerConfig(id="draft", name="Draft", enabled=False)
    assert disabled.enabled is False

    with pytest.raises(ValidationError):
        McpServerConfig(id="live", name="Live", enabled=True)


def test_config_store_round_trips_atomically(tmp_path) -> None:
    path = tmp_path / "config.json"
    store = ConfigStore(path)
    config = AppConfig(default_prompt="Be precise")

    store.save(config)

    assert store.load() == config
    assert json.loads(path.read_text(encoding="utf-8"))["default_prompt"] == "Be precise"
    assert not list(tmp_path.glob("config.json.*.tmp"))


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
