import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  ConversationListResponse,
  ConversationResponse,
  HealthResponse,
  McpServerConfig,
  McpTestResponse,
  ModelTestResponse,
} from "./types";

const DEV_BACKEND_URL = "http://127.0.0.1:45831";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MCP_REQUEST_TIMEOUT_MS = 15_000;

export interface ApiClientOptions {
  requestTimeoutMs?: number;
}

type BackendInvoker = () => Promise<string>;

export interface BackendWaitOptions {
  attempts?: number;
  delayMs?: number;
}

export async function resolveBackendUrl(invoker: BackendInvoker = () => invoke<string>("backend_url")) {
  try {
    const url = (await invoker()).trim();
    return url || DEV_BACKEND_URL;
  } catch {
    return DEV_BACKEND_URL;
  }
}

export async function waitForBackend(
  health: () => Promise<HealthResponse>,
  { attempts = 30, delayMs = 200 }: BackendWaitOptions = {},
): Promise<HealthResponse> {
  const maxAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await health();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Backend did not become ready");
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

export function buildModelTestUpdate(config: AppConfig, apiKey: string, clearApiKey = false) {
  const { api_key_configured: _configured, ...model } = config.model;
  return {
    model: { ...model, api_key: apiKey.trim() },
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

export function parseSseBlock(block: string): ChatStreamEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join("\n");
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    return { ...payload, type: (payload.type || eventType) as ChatStreamEvent["type"] };
  } catch {
    return { type: eventType as ChatStreamEvent["type"], message: data };
  }
}

export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));

  async function request<T>(path: string, init?: RequestInit, timeoutMs = requestTimeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    const callerSignal = init?.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      const response = await fetch(`${root}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
      return await parseResponse<T>(response);
    } catch (error) {
      if (timedOut) {
        throw new ApiError("本地服务请求超时，请检查 Java/MCP 服务是否已启动。", 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  return {
    health: () => request<HealthResponse>("/api/health"),
    getConfig: async () => sanitizeConfigForForm(await request<AppConfig>("/api/config")),
    getConversations: () => request<ConversationListResponse>("/api/conversations"),
    getConversation: (conversationId: string) =>
      request<ConversationResponse>(`/api/conversations/${encodeURIComponent(conversationId)}`),
    deleteConversation: (conversationId: string) =>
      request<{ conversation_id: string; deleted: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
      }),
    saveConfig: async (config: AppConfig, apiKey: string, clearApiKey = false) => {
      const payload = await request<AppConfig>("/api/config", {
        method: "PUT",
        body: JSON.stringify(buildConfigUpdate(config, apiKey, clearApiKey)),
      });
      return sanitizeConfigForForm(payload);
    },
    testModel: (config: AppConfig, apiKey: string, clearApiKey = false) =>
      request<ModelTestResponse>("/api/model/test", {
        method: "POST",
        body: JSON.stringify(buildModelTestUpdate(config, apiKey, clearApiKey)),
      }),
    chat: (messages: ChatMessage[], conversationId = "default") =>
      request<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          messages: messages.map(({ role, content }) => ({ role, content })),
        }),
      }),
    streamChat: async (
      messages: ChatMessage[],
      onEvent: (event: ChatStreamEvent) => void,
      signal?: AbortSignal,
      conversationId = "default",
    ) => {
      const response = await fetch(`${root}/api/chat/stream`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          conversation_id: conversationId,
          messages: messages.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!response.ok) return parseResponse<never>(response);
      if (!response.body) throw new ApiError("后端没有返回流式响应", response.status);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let sawError = false;

      const consumeBlock = (block: string) => {
        const event = parseSseBlock(block);
        if (!event) return;
        if (event.type === "done") sawDone = true;
        if (event.type === "error") sawError = true;
        onEvent(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) consumeBlock(block);
      }
      buffer += decoder.decode();
      consumeBlock(buffer);
      if (!sawDone && !sawError) throw new ApiError("流式回答未完成", response.status);
    },
    testMcp: (server: McpServerConfig) =>
      request<McpTestResponse>("/api/mcp/test", {
        method: "POST",
        body: JSON.stringify(server),
      }, Math.min(requestTimeoutMs, MCP_REQUEST_TIMEOUT_MS)),
  };
}
