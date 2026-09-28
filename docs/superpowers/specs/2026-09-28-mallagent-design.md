# MallAgent Desktop Agent Design

## Goal

Build a Windows-first Tauri desktop application that launches as a normal GUI window, runs a Python 3.11 LangChain agent locally, connects that agent to user-configured MCP servers, and lets the user configure one OpenAI-compatible chat endpoint plus a default system prompt.

## Requirements

- Python 3.11 is the supported backend runtime. Development uses a local virtual environment; release builds can package the backend with PyInstaller.
- The only model integration is the OpenAI chat protocol through `langchain-openai`/`ChatOpenAI`. `base_url`, API key, model name, temperature, and max tokens are configurable.
- A non-empty default prompt is passed to LangChain's agent as `system_prompt` for every chat request. An empty value means no custom system prompt.
- MCP configuration supports enabled stdio servers and streamable HTTP servers. Each server can define a name, command/arguments or URL, environment variables/headers, and enabled state.
- The desktop window starts through Tauri; the backend is started by the Tauri process and is stopped when the application exits.
- Configuration is persisted in the per-user application configuration directory. API keys are never returned by the read endpoint and are never written to logs.
- The first release is a single-user local application. It does not expose the backend beyond `127.0.0.1` and does not implement accounts, remote deployment, or model-provider-specific extensions.

## Architecture

```text
Tauri window (React + Vite)
        │ invoke backend_url + localhost HTTP
        ▼
Python 3.11 FastAPI service
        │
        ├── ConfigStore → per-user config.json
        ├── ChatOpenAI(base_url, api_key, model, ...)
        ├── LangChain create_agent(system_prompt=...)
        └── MCPAdapter({"mcpServers": ...}) → stdio / streamable HTTP tools
```

Tauri owns process lifecycle and exposes only a small `backend_url` command. The browser UI talks to the local FastAPI service for configuration, MCP discovery, and chat. Keeping LangChain and MCP in Python avoids duplicating protocol logic in Rust and makes the agent directly reusable from a command line or tests.

## Backend contracts

### Configuration

```json
{
  "model": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "",
    "model": "gpt-4o-mini",
    "temperature": 0.2,
    "max_tokens": null
  },
  "default_prompt": "",
  "mcp_servers": [
    {
      "id": "server-id",
      "name": "Local tools",
      "transport": "stdio",
      "command": "python",
      "args": [],
      "env": {},
      "url": "",
      "headers": {},
      "enabled": true
    }
  ]
}
```

The public configuration response replaces `model.api_key` with an empty string and adds `model.api_key_configured`. An update with an empty API key preserves the stored key; an explicit `clear_api_key` flag removes it.

### HTTP API

- `GET /api/health` → service status.
- `GET /api/config` → safe configuration (no secret value).
- `PUT /api/config` → validate and persist configuration.
- `POST /api/chat` → run one agent turn with the supplied conversation history and return the final assistant text plus tool activity.
- `POST /api/mcp/test` → connect to one configured server and return discovered tool names/descriptions.

## Frontend

The window has two modes: Chat and Settings. Chat maintains a local conversation and sends its full history on each turn. Settings edits the OpenAI endpoint, default prompt, and MCP server list; saving immediately updates the backend config. The UI provides explicit loading, error, empty-key, and MCP test states and does not display the stored API key.

## Error handling

- Invalid model/MCP configuration is rejected with HTTP 400 and a human-readable message.
- Model and MCP connection failures are returned as HTTP 502 and shown in the chat/settings UI without logging secrets.
- The Tauri UI waits for `/api/health` before enabling chat actions.
- Backend startup failures keep the Tauri window open with an actionable status instead of silently failing.

## Verification boundary

Automated checks cover configuration validation/persistence, prompt propagation, MCP mapping, API error/status contracts, TypeScript type-check/build, and Rust compilation. A live model call or live third-party MCP server is not part of offline verification; those require user credentials and services at runtime.
