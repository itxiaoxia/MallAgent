# MallAgent Resilience, Streaming, and SQLite Design

## Goal

Extend the existing MallAgent desktop application with bounded self-healing and
retry behavior, configurable model timeouts/retry counts, true incremental chat
streaming, provider-supplied reasoning display, protocol-accurate MCP labels, and
SQLite-backed client configuration persistence that also works in a PyInstaller
bundle.

## Scope and constraints

- Python 3.11, FastAPI, LangChain 1.x, and `ChatOpenAI` remain the backend stack.
- The model integration remains OpenAI Chat Completions/OpenAI-compatible only.
- `timeout` is a per-attempt model/agent timeout in seconds. `retry_count` is the
  number of retries after the first attempt; `0` means one attempt total.
- LangChain's internal model retries are disabled so the application owns the
  retry budget and can report it to the UI.
- Recovery reconstructs the model and MCP tool connections for each attempt.
  MCP discovery is isolated per enabled server: a failed server is quarantined
  for the current request while healthy servers remain available.
- Only timeout, connection, rate-limit, and server-transient failures are
  retried. Authentication, validation, malformed-request, and other permanent
  failures are surfaced immediately. A retry may repeat an external tool call;
  the UI and documentation must not claim exactly-once side effects.
- Chat uses an SSE endpoint. Events carry status, reasoning deltas, answer
  deltas, tool activity, recovery/retry notices, completion, and sanitized
  errors. The existing JSON endpoint remains for compatibility.
- The UI displays reasoning only when the provider returns a reasoning summary or
  reasoning content. It never fabricates or requests hidden chain-of-thought.
  Reasoning collapses automatically once answer content begins or the run ends;
  a chevron toggles it manually.
- MCP settings use protocol labels (`stdio` and `Streamable HTTP`) without
  implying that either protocol is inherently local or remote.
- `ConfigStore` uses SQLite at the per-user `config.db` path. A sibling legacy
  `config.json` is imported once when no database exists. Secrets remain out of
  API responses and logs; the database is local application data, not encryption.
- Each chat has a validated `conversation_id`. The same SQLite database stores
  the ordered user/assistant history for that ID. The API accepts the existing
  `messages` list for compatibility, and also merges a request containing only
  the latest user message with persisted history. A completed assistant answer
  is saved only after the non-streaming call returns or the streaming call
  emits `done`; failed attempts never become conversation context.
- The Tauri client persists the current conversation ID in local storage only
  as a pointer. Message content remains in the backend SQLite database. Startup
  loads that pointer's history, and “new session” creates a new ID so old
  context cannot leak into a new conversation.
- Conversation saves use a SQLite version CAS under `BEGIN IMMEDIATE`. A stale
  full-history request or a concurrent completion receives a conflict instead of
  overwriting newer messages. The primary UI path sends only the new user
  message, so failed or interrupted turns are never replayed from UI state.

## Runtime flow

```text
Tauri window
  -> GET /api/conversations/{conversation_id}
  -> POST /api/chat/stream (conversation_id + messages)
  <- SSE: start/status/reasoning_delta/content_delta/tool/retry/done/error
FastAPI
  -> load SQLite config
  -> for each bounded attempt:
       build ChatOpenAI(timeout, max_retries=0)
       rebuild MCP tools, skip failed servers with recovery event
       create_agent(system_prompt=default_prompt)
       stream LangChain messages
  -> persist the completed user/assistant history by conversation_id
  -> retry transient timeout/transport failures when budget remains
```

## Configuration additions

```json
{
  "model": {
    "timeout": 60,
    "retry_count": 2
  }
}
```

`temperature` remains the model sampling temperature and is validated by the
application in the range 0 through 2, inclusive. OpenAI-compatible providers
may impose a narrower or different range and can still reject an unsupported
value.

## Verification boundary

Offline tests cover SQLite round trips/migration, validation, retry
classification and bounded attempts, MCP isolation, reasoning extraction, SSE
event framing, API contracts, TypeScript streaming parsing, and frontend build.
A real model's reasoning field and live MCP behavior remain provider-dependent
and require runtime credentials/services.
