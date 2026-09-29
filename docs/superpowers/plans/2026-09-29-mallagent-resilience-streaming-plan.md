# MallAgent Resilience, Streaming, and SQLite Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with
> `superpowers:executing-plans`. Each task follows TDD: write a focused failing
> test, run it red, implement the smallest change, run it green, then run the
> relevant suite.

**Goal:** Add SQLite client persistence, configurable timeout/retries, bounded
self-healing, SSE streaming with provider reasoning events, and the corrected MCP
protocol UI to the existing MallAgent desktop app.

**Architecture:** Keep Tauri's process lifecycle unchanged. Store the validated
`AppConfig` JSON payload in a transactional SQLite singleton row under the user
config directory, with one-time legacy JSON migration. Make the Python agent own
attempt/retry policy and rebuild model/MCP resources per attempt. Expose a new
FastAPI SSE endpoint while preserving `/api/chat`; the React client consumes SSE
incrementally and renders a collapsible reasoning panel.

**Spec:** `docs/superpowers/specs/2026-09-29-mallagent-resilience-streaming-design.md`

## Global constraints

- Python 3.11 only; use stdlib `sqlite3` so packaged backend has no extra native
  service or dependency.
- Never return or log the model API key.
- `retry_count` counts retries, not total attempts; all waits are bounded.
- Do not retry permanent configuration/authentication errors.
- Do not claim provider reasoning exists when a provider does not return it.
- Preserve the existing JSON chat endpoint and default-prompt behavior.
- Add a validated conversation ID and persist ordered chat history in the same
  SQLite database; successful completions only are eligible for persistence.
- Use version-checked SQLite writes so stale or concurrent requests cannot
  overwrite newer conversation history.

## Task 1: Model and SQLite persistence

**Files:** `backend/mallagent/models.py`, `backend/mallagent/config.py`,
`backend/tests/test_config.py`, `README.md`

- Add `ModelConfig.timeout` and `ModelConfig.retry_count` with bounded validation.
- Change the default database path to `config.db`.
- Implement schema initialization, transactional load/save/update, and sibling
  legacy JSON migration.
- Add the `conversations` table with load/save helpers for ordered user/assistant
  messages and test SQLite conversation round trips.
- Add failing tests for defaults, bounds, SQLite round trip, migration, blank-key
  preservation, and explicit key clearing.
- Run config tests red, implement, then run the full backend suite.

## Task 2: Agent streaming, reasoning, retry, and MCP recovery

**Files:** `backend/mallagent/agent.py`, `backend/mallagent/mcp.py`,
`backend/tests/test_agent.py`, `backend/tests/test_mcp.py`

- Make `ChatOpenAI` use configured timeout and `max_retries=0`.
- Add provider-compatible reasoning extraction, including standard LangChain
  reasoning blocks and chat-completions `reasoning_content`/text details.
- Add resilient per-server MCP discovery; failed servers emit recoverable status
  while healthy tool sets remain usable.
- Add a bounded retry loop for transient timeout/transport/provider failures,
  reconstructing model and tools on each attempt.
- Add an async stream event model and stream `messages` from the LangChain agent,
  separating reasoning, answer, and tool events.
- Write failing unit tests for model settings, event extraction, MCP isolation,
  retry count/timeout behavior, and prompt propagation; then implement and run
  focused/full backend tests.

## Task 3: FastAPI SSE contract

**Files:** `backend/mallagent/api.py`, `backend/tests/test_api.py`

- Add `POST /api/chat/stream` returning `text/event-stream` frames with stable
  event names and sanitized error payloads.
- Preserve `/api/chat` and its existing error/status contract, applying the same
  model timeout/retry policy.
- Resolve each request's context from `conversation_id`, support a latest-user
  message against persisted history, persist completed answers, and expose
  `GET /api/conversations/{conversation_id}` for client restoration. Reject a
  stale full-history request with HTTP 409 and emit a sanitized stream error if
  the version changes before a streamed completion is committed.
- Add injectable stream runner support for deterministic API tests.
- Test framing, completion/error events, config validation, and no secret
  leakage.

## Task 4: Frontend streaming and settings UI

**Files:** `src/types.ts`, `src/api.ts`, `src/api.test.ts`, `src/App.tsx`,
`src/styles.css`

- Add timeout and retry-count fields to the model settings form.
- Add typed SSE parsing and `streamChat` to the API client.
- Send `conversation_id` with every chat request, restore history on startup,
  submit only the current user message on the primary path, and rotate the ID
  for “new session” isolation. Abort/ignore stale request callbacks and require
  a `done` SSE event before treating a stream as complete.
- Replace full-response chat submission with incremental answer updates.
- Render provider reasoning in an auto-collapsing panel with a right-side
  chevron; show retry/recovery status and tool activity as they arrive.
- Change MCP copy/select labels to protocol names only (`stdio`, `Streamable
  HTTP`) and keep the existing underlying config compatibility.
- Add focused API-client stream parser tests and run frontend tests/build.

## Task 5: Packaging/docs and verification

**Files:** `README.md`, design/plan docs as needed

- Document SQLite location/migration, timeout/retry semantics, SSE behavior,
  reasoning provider limitations, and the temperature range.
- Confirm PyInstaller packaging includes sqlite3 by rebuilding the backend and
  starting the packaged executable against a temporary database.
- Run backend tests, `pip check`, frontend tests/build, Rust format/tests, and
  the Tauri release build when the environment permits.
- Inspect `git diff --check`, status, generated artifacts, and requirement
  checklist before reporting completion.
