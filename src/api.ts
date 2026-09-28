import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatMessage,
  ChatResponse,
  HealthResponse,
  McpServerConfig,
  McpTestResponse,
} from "./types";

const DEV_BACKEND_URL = "http://127.0.0.1:45831";

type BackendInvoker = () => Promise<string>;

export async function resolveBackendUrl(invoker: BackendInvoker = () => invoke<string>("backend_url")) {
  try {
    const url = (await invoker()).trim();
    return url || DEV_BACKEND_URL;
  } catch {
    return DEV_BACKEND_URL;
  }
}
export function sanitizeConfigForForm(config: AppConfig): AppConfig {
  return {
    ...config,
    model: {
      ...config.model,
      api_key: "",
      api_key_configured: Boolean(config.model.api_key_configured || config.model.api_key),
    },
    mcp_servers: config.mcp_servers.map((server) => ({
      ...server,
      args: [...server.args],
      env: { ...server.env },
      headers: { ...server.headers },
    })),
  };
}
export function buildConfigUpdate(config: AppConfig, apiKey: string, clearApiKey = false) {
  const { api_key_configured: _configured, ...model } = config.model;
  return {
    model: { ...model, api_key: apiKey.trim() },
    default_prompt: config.default_prompt,
    mcp_servers: config.mcp_servers,
    clear_api_key: clearApiKey,
  };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string };
  if (!response.ok) {
    throw new ApiError(payload.detail || `Backend request failed (${response.status})`, response.status);
  }
  return payload as T;
}

export function createApiClient(baseUrl: string) {
  const root = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    return parseResponse<T>(response);
  }

  return {
    health: () => request<HealthResponse>("/api/health"),
    getConfig: async () => sanitizeConfigForForm(await request<AppConfig>("/api/config")),
    saveConfig: async (config: AppConfig, apiKey: string, clearApiKey = false) => {
      const payload = await request<AppConfig>("/api/config", {
        method: "PUT",
        body: JSON.stringify(buildConfigUpdate(config, apiKey, clearApiKey)),
      });
      return sanitizeConfigForForm(payload);
    },
    chat: (messages: ChatMessage[]) =>
      request<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages }),
      }),
    testMcp: (server: McpServerConfig) =>
      request<McpTestResponse>("/api/mcp/test", {
        method: "POST",
        body: JSON.stringify(server),
      }),
  };
}
