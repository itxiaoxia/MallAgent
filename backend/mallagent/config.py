from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from platformdirs import user_config_path
from pydantic import ValidationError

from .models import AppConfig


class ConfigStoreError(RuntimeError):
    """Raised when the persisted application configuration cannot be used."""


class ConversationConflictError(ConfigStoreError):
    """Raised when a conversation changed while a request was in flight."""


@dataclass(frozen=True)
class ConversationSnapshot:
    messages: list[dict[str, str]]
    version: int


def default_config_path() -> Path:
    configured = os.environ.get("MALLAGENT_CONFIG_PATH")
    if configured:
        return Path(configured).expanduser()
    return user_config_path("MallAgent", "MallAgent") / "config.db"


class ConfigStore:
    def __init__(self, path: Path | str | None = None) -> None:
        configured_path = Path(path) if path is not None else default_config_path()
        if configured_path.suffix.lower() == ".json":
            self.path = configured_path.with_suffix(".db")
            self.legacy_path = configured_path
        else:
            self.path = configured_path
            self.legacy_path = configured_path.with_name("config.json")

    @staticmethod
    def _create_schema(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(conversations)")}
        if "version" not in columns:
            connection.execute(
                "ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 0"
            )

    def _load_legacy_json(self) -> AppConfig | None:
        if not self.legacy_path.exists():
            return None
        try:
            raw = json.loads(self.legacy_path.read_text(encoding="utf-8"))
            config = AppConfig.model_validate(raw)
            self.save(config)
            return config
        except (OSError, json.JSONDecodeError, ValidationError, sqlite3.Error) as exc:
            raise ConfigStoreError(f"Unable to migrate configuration from {self.legacy_path}") from exc

    def load(self) -> AppConfig:
        migrated = self._load_legacy_json() if not self.path.exists() else None
        if migrated is not None:
            return migrated
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path) as connection:
                self._create_schema(connection)
                row = connection.execute(
                    "SELECT payload FROM app_config WHERE id = 1"
                ).fetchone()
            if row is None:
                return AppConfig()
            return AppConfig.model_validate(json.loads(row[0]))
        except (OSError, sqlite3.Error, json.JSONDecodeError, ValidationError) as exc:
            raise ConfigStoreError(f"Unable to load configuration from {self.path}") from exc

    def save(self, config: AppConfig) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            payload = json.dumps(config.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
            with sqlite3.connect(self.path) as connection:
                self._create_schema(connection)
                connection.execute(
                    """
                    INSERT INTO app_config (id, payload, updated_at)
                    VALUES (1, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        payload = excluded.payload,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (payload,),
                )
        except (OSError, sqlite3.Error) as exc:
            raise ConfigStoreError(f"Unable to save configuration to {self.path}") from exc

    def update(self, incoming: AppConfig, *, clear_api_key: bool = False) -> AppConfig:
        merged = merge_config_update(self.load(), incoming, clear_api_key=clear_api_key)
        self.save(merged)
        return merged

    @staticmethod
    def _normalize_conversation_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
        normalized: list[dict[str, str]] = []
        for message in messages:
            if not isinstance(message, dict):
                raise ConfigStoreError("Stored conversation contains an invalid message")
            role = message.get("role")
            content = message.get("content")
            if not isinstance(role, str) or role not in {"user", "assistant"}:
                raise ConfigStoreError("Stored conversation contains an invalid message")
            if not isinstance(content, str) or not content.strip():
                raise ConfigStoreError("Stored conversation contains an invalid message")
            normalized.append({"role": role, "content": content.strip()})
        return normalized

    def load_conversation(self, conversation_id: str) -> list[dict[str, str]]:
        return self.load_conversation_snapshot(conversation_id).messages

    def list_conversations(self) -> list[dict[str, str]]:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path) as connection:
                self._create_schema(connection)
                rows = connection.execute(
                    """
                    SELECT id, payload, updated_at
                    FROM conversations
                    ORDER BY updated_at DESC, id DESC
                    """
                ).fetchall()
            summaries: list[dict[str, str]] = []
            for conversation_id, payload, updated_at in rows:
                parsed = json.loads(payload)
                if not isinstance(parsed, list):
                    raise ConfigStoreError("Stored conversation payload is invalid")
                messages = self._normalize_conversation_messages(parsed)
                title = next(
                    (message["content"] for message in messages if message["role"] == "user"),
                    "新会话",
                )
                summaries.append(
                    {
                        "conversation_id": str(conversation_id),
                        "title": title,
                        "updated_at": str(updated_at),
                    }
                )
            return summaries
        except ConfigStoreError:
            raise
        except (OSError, sqlite3.Error, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ConfigStoreError(f"Unable to list conversations from {self.path}") from exc

    def load_conversation_snapshot(self, conversation_id: str) -> ConversationSnapshot:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path) as connection:
                self._create_schema(connection)
                row = connection.execute(
                    "SELECT payload, version FROM conversations WHERE id = ?",
                    (conversation_id,),
                ).fetchone()
            if row is None:
                return ConversationSnapshot(messages=[], version=0)
            payload = json.loads(row[0])
            if not isinstance(payload, list):
                raise ConfigStoreError("Stored conversation payload is invalid")
            return ConversationSnapshot(
                messages=self._normalize_conversation_messages(payload),
                version=int(row[1]),
            )
        except ConfigStoreError:
            raise
        except (OSError, sqlite3.Error, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ConfigStoreError(f"Unable to load conversation from {self.path}") from exc

    def save_conversation(
        self,
        conversation_id: str,
        messages: list[dict[str, str]],
        *,
        expected_version: int | None = None,
    ) -> int:
        normalized = self._normalize_conversation_messages(messages)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
            with sqlite3.connect(self.path) as connection:
                self._create_schema(connection)
                connection.execute("BEGIN IMMEDIATE")
                current = connection.execute(
                    "SELECT version FROM conversations WHERE id = ?",
                    (conversation_id,),
                ).fetchone()
                current_version = int(current[0]) if current is not None else 0
                if expected_version is not None and current_version != expected_version:
                    raise ConversationConflictError("Conversation version changed")
                next_version = current_version + 1
                if current is None:
                    connection.execute(
                        """
                        INSERT INTO conversations (id, payload, version, updated_at)
                        VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
                        """,
                        (conversation_id, payload, next_version),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE conversations
                        SET payload = ?, version = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
                        WHERE id = ?
                        """,
                        (payload, next_version, conversation_id),
                    )
                return next_version
        except ConversationConflictError:
            raise
        except (OSError, sqlite3.Error) as exc:
            raise ConfigStoreError(f"Unable to save conversation to {self.path}") from exc


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
