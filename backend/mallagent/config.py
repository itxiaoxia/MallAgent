from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any
from uuid import uuid4

from platformdirs import user_config_path
from pydantic import ValidationError

from .models import AppConfig


class ConfigStoreError(RuntimeError):
    """Raised when the persisted application configuration cannot be used."""


def default_config_path() -> Path:
    configured = os.environ.get("MALLAGENT_CONFIG_PATH")
    if configured:
        return Path(configured).expanduser()
    return user_config_path("MallAgent", "MallAgent") / "config.json"


class ConfigStore:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else default_config_path()

    def load(self) -> AppConfig:
        if not self.path.exists():
            return AppConfig()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return AppConfig.model_validate(raw)
        except (OSError, json.JSONDecodeError, ValidationError) as exc:
            raise ConfigStoreError(f"Unable to load configuration from {self.path}") from exc

    def save(self, config: AppConfig) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f"{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                json.dump(config.model_dump(mode="json"), temporary, ensure_ascii=False, indent=2)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, self.path)
        except OSError as exc:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            raise ConfigStoreError(f"Unable to save configuration to {self.path}") from exc

    def update(self, incoming: AppConfig, *, clear_api_key: bool = False) -> AppConfig:
        merged = merge_config_update(self.load(), incoming, clear_api_key=clear_api_key)
        self.save(merged)
        return merged


def merge_config_update(
    current: AppConfig,
    incoming: AppConfig,
    *,
    clear_api_key: bool = False,
) -> AppConfig:
    incoming_model = incoming.model
    if clear_api_key:
        api_key = ""
    elif incoming_model.api_key.strip():
        api_key = incoming_model.api_key
    else:
        api_key = current.model.api_key
    return incoming.model_copy(
        deep=True,
        update={"model": incoming_model.model_copy(update={"api_key": api_key})},
    )


def public_config(config: AppConfig) -> dict[str, Any]:
    data = config.model_dump(mode="json")
    api_key = data["model"].get("api_key", "")
    data["model"]["api_key"] = ""
    data["model"]["api_key_configured"] = bool(api_key)
    return data
