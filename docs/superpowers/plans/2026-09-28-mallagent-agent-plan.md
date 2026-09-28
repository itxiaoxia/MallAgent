# MallAgent Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri desktop agent with a Python 3.11 LangChain/OpenAI backend, configurable default prompt, and configurable MCP services.

**Architecture:** A Tauri 2 Rust process starts and owns a local FastAPI backend. The React/Vite window calls the backend over loopback HTTP; the backend constructs `ChatOpenAI`, loads MCP tools through `langchain.mcp.MCPAdapter`, and creates a LangChain agent for each request.

**Tech Stack:** Python 3.11, FastAPI, Pydantic, LangChain 1.x, `langchain[mcp]`, `langchain-openai`, Tauri 2, Rust, React, TypeScript, Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-mallagent-design.md`

## Global Constraints

- Python 3.11 is the supported backend runtime.
- Only the OpenAI chat protocol is supported; `base_url` remains configurable for OpenAI-compatible endpoints.
- Non-empty `default_prompt` must be passed as the LangChain agent `system_prompt` for every request.
- MCP transports in scope are `stdio` and streamable `http`.
- The backend binds only to `127.0.0.1`; Tauri starts it without a console window and reaps it on exit.
- API keys are never returned from `GET /api/config` and never logged.

## Review Focus

- A blank API key update must preserve an already saved secret, while an explicit clear operation must remove it.
- A disabled or malformed MCP server must not prevent unrelated enabled servers from being mapped or produce a tool with missing transport data.
- A custom default prompt must be applied on every request, including a new session with no previous messages.
- Backend startup must work both with the Python virtual environment in development and the packaged PyInstaller resource in release mode.
- A model/MCP failure must produce a bounded HTTP error and leave the Tauri window usable for correction.

### Task 1: Python project foundation and configuration store

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/requirements.txt`
- Create: `backend/mallagent/__init__.py`
- Create: `backend/mallagent/models.py`
- Create: `backend/mallagent/config.py`
- Test: `backend/tests/test_config.py`
- Create: `.gitignore`

**Interfaces:**
- Produces `AppConfig`, `ModelConfig`, `McpServerConfig`, `ConfigStore.load()`, `ConfigStore.save()`, and `public_config()` for later backend tasks.

- [ ] **Step 1: Write failing configuration tests** covering default values, URL/model validation, atomic persistence, public API-key redaction, blank-key preservation, and explicit key clearing.
- [ ] **Step 2: Run `pytest backend/tests/test_config.py -q` and verify it fails because the package is absent.**
- [ ] **Step 3: Implement Pydantic models and `ConfigStore` with an atomic temporary-file replace under the per-user config directory.**
- [ ] **Step 4: Run the focused configuration tests and verify they pass.**
- [ ] **Step 5: Run the complete backend test command and record the result.**

### Task 2: LangChain agent and MCP adapter

**Files:**
- Create: `backend/mallagent/mcp.py`
- Create: `backend/mallagent/agent.py`
- Test: `backend/tests/test_mcp.py`
- Test: `backend/tests/test_agent.py`

**Interfaces:**
- Consumes `AppConfig` and `McpServerConfig` from Task 1.
- Produces `build_mcp_config()`, `build_chat_model()`, and `run_agent()` for the HTTP API.

- [ ] **Step 1: Write failing tests** for stdio/HTTP MCP mapping, disabled-server filtering, model construction with `base_url`/key/model values, prompt propagation to `create_agent`, and final-message extraction.
- [ ] **Step 2: Run the focused MCP/agent tests and verify the expected missing-module or missing-function failures.**
- [ ] **Step 3: Implement MCP mapping, `ChatOpenAI` construction, agent creation with optional `system_prompt`, MCP tool discovery, and safe final-response extraction.**
- [ ] **Step 4: Run the focused tests and verify they pass without network calls.**
- [ ] **Step 5: Run all backend tests and record the result.**

### Task 3: FastAPI service

**Files:**
- Create: `backend/mallagent/api.py`
- Create: `backend/mallagent/__main__.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes `ConfigStore`, `AppConfig`, `run_agent()`, and MCP discovery from Tasks 1–2.
- Produces `/api/health`, `/api/config`, `/api/chat`, and `/api/mcp/test`.

- [ ] **Step 1: Write failing API tests** for health, redacted config, config updates, chat validation, successful agent response, and bounded model/MCP errors.
- [ ] **Step 2: Run `pytest backend/tests/test_api.py -q` and verify it fails before the API exists.**
- [ ] **Step 3: Implement the FastAPI app factory, request/response schemas, error mapping, loopback uvicorn entry point, and secret-safe diagnostics.**
- [ ] **Step 4: Run the focused API tests and verify they pass.**
- [ ] **Step 5: Run the complete backend suite.**

### Task 4: Tauri/Vite/React window and settings/chat UI

**Files:**
- Create: `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`
- Create: `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/types.ts`, `src/styles.css`
- Test: `src/api.test.ts`

**Interfaces:**
- Consumes the HTTP API contracts from Task 3 and the `backend_url` Tauri command from Task 5 (with a development URL fallback).
- Produces a desktop-ready chat/settings experience with clear loading, save, MCP-test, and error states.

- [ ] **Step 1: Write failing frontend tests** for backend URL selection, request payload shaping, and safe config masking.
- [ ] **Step 2: Run `npm.cmd test -- --run src/api.test.ts` and verify the expected missing-module failure.**
- [ ] **Step 3: Implement the API client, typed config/chat models, chat state, settings forms, MCP server editor, and responsive visual shell.**
- [ ] **Step 4: Run the focused frontend tests and verify they pass.**
- [ ] **Step 5: Run `npm.cmd run build` and `npm.cmd run test`.**

### Task 5: Tauri launcher, window configuration, and backend packaging

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Create: `scripts/build-backend.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes `backend/mallagent/__main__.py` and exposes Tauri command `backend_url` to Task 4.

- [ ] **Step 1: Write a failing Rust unit test** for development/release backend command selection and loopback URL formatting.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml` and verify the missing crate/source failure.**
- [ ] **Step 3: Implement Tauri startup, hidden backend child process, cleanup, fixed GUI window metadata, capabilities, and PyInstaller packaging script.**
- [ ] **Step 4: Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `cargo test --manifest-path src-tauri/Cargo.toml`.**
- [ ] **Step 5: Run `npm.cmd run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `git diff --check`.**

### Task 6: Documentation and final verification

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-09-28-mallagent-design.md` and `docs/superpowers/plans/2026-09-28-mallagent-agent-plan.md` only if verification exposes a documented deviation.

- [ ] **Step 1: Document Python 3.11 setup, model/MCP configuration, development startup, release sidecar build, and runtime limitations.**
- [ ] **Step 2: Run the full backend suite, frontend suite/build, Rust tests/check, and relevant Tauri build command.**
- [ ] **Step 3: Inspect `git diff --check`, the final file tree, and the requirement checklist before reporting status.**
