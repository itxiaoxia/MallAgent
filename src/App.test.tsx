/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const javaServer = {
    id: "mall-system-java",
    name: "商城 Java MCP",
    transport: "http" as const,
    command: "",
    args: [] as string[],
    env: {},
    url: "http://127.0.0.1:9991/mcp",
    headers: {},
    enabled: true,
  };
  const config = {
    model: {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api_key: "",
      api_key_configured: false,
      model: "qwen3.8-max",
      temperature: 0.2,
      max_tokens: null,
      timeout: 60,
      retry_count: 2,
    },
    default_prompt: "",
    mcp_servers: [javaServer, {
      id: "custom-tools",
      name: "Custom MCP",
      transport: "http" as const,
      command: "",
      args: [] as string[],
      env: {},
      url: "https://example.test/mcp",
      headers: {},
      enabled: true,
    }],
  };
  const javaStatus = {
    state: "running" as const,
    port: 9991,
    url: "http://127.0.0.1:9991/mcp",
    error: null,
  };
  const apiClient = {
    health: vi.fn(async () => ({ status: "ok" as const, version: "0.1.0" })),
    getConfig: vi.fn(async () => config),
    getConversation: vi.fn(async () => ({ conversation_id: "conversation-1", messages: [] })),
    getConversations: vi.fn(async () => ({
      conversations: [] as Array<{ conversation_id: string; title: string; updated_at: string }>,
    })),
    deleteConversation: vi.fn(async (conversationId: string) => ({ conversation_id: conversationId, deleted: true })),
    saveConfig: vi.fn(async (nextConfig: typeof config) => nextConfig),
    testModel: vi.fn(async () => ({ status: "ok" as const, model: "qwen3.8-max" })),
    testMcp: vi.fn(async (server: { id: string }) => ({ server_id: server.id, tools: [] })),
    streamChat: vi.fn(),
  };
  return {
    apiClient,
    config,
    javaServer,
    javaStatus,
    ApiError: class MockApiError extends Error {
      status = 500;
    },
    createApiClient: vi.fn(() => apiClient),
    resolveBackendUrl: vi.fn(async () => "http://127.0.0.1:45831"),
    waitForBackend: vi.fn(async () => ({ status: "ok" as const, version: "0.1.0" })),
    autoConnectModel: vi.fn(async () => ({ status: "success" as const, message: "连接成功" })),
    autoConnectMcpServers: vi.fn(async () => ({})),
    countConnectedMcpServers: vi.fn(() => 1),
    mcpConnectionLabel: vi.fn(() => "MCP 已连接 (1)"),
    modelConnectionLabel: vi.fn(() => "模型已连接"),
    mcpTestStateFromResponse: vi.fn(() => ({ status: "success" as const, message: "已连接", tools: [] })),
    DEFAULT_JAVA_MCP_SERVER_ID: "mall-system-java",
    DEFAULT_JAVA_MCP_PORT: 9991,
    defaultJavaMcpServer: vi.fn((port = 9991) => ({ ...javaServer, url: `http://127.0.0.1:${port}/mcp` })),
    formatJavaServiceError: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
    getJavaServiceStatus: vi.fn(async () => javaStatus),
    javaMcpPortFromUrl: vi.fn(() => 9991),
    javaServiceStatusLabel: vi.fn(() => "运行中"),
    javaServiceUrl: vi.fn((port: string | number) => `http://127.0.0.1:${port}/mcp`),
    restartJavaService: vi.fn(async () => javaStatus),
    startJavaService: vi.fn(async () => javaStatus),
    stopJavaService: vi.fn(async () => ({ ...javaStatus, state: "stopped" as const })),
    validateJavaPort: vi.fn((value: string | number) => Number(value)),
  };
});

vi.mock("./api", () => ({
  ApiError: mocks.ApiError,
  createApiClient: mocks.createApiClient,
  resolveBackendUrl: mocks.resolveBackendUrl,
  waitForBackend: mocks.waitForBackend,
}));
vi.mock("./model", () => ({ autoConnectModel: mocks.autoConnectModel }));
vi.mock("./mcp", () => ({
  autoConnectMcpServers: mocks.autoConnectMcpServers,
  countConnectedMcpServers: mocks.countConnectedMcpServers,
  mcpConnectionLabel: mocks.mcpConnectionLabel,
  modelConnectionLabel: mocks.modelConnectionLabel,
  mcpTestStateFromResponse: mocks.mcpTestStateFromResponse,
}));
vi.mock("./javaService", () => ({
  DEFAULT_JAVA_MCP_SERVER_ID: mocks.DEFAULT_JAVA_MCP_SERVER_ID,
  DEFAULT_JAVA_MCP_PORT: mocks.DEFAULT_JAVA_MCP_PORT,
  defaultJavaMcpServer: mocks.defaultJavaMcpServer,
  formatJavaServiceError: mocks.formatJavaServiceError,
  getJavaServiceStatus: mocks.getJavaServiceStatus,
  javaMcpPortFromUrl: mocks.javaMcpPortFromUrl,
  javaServiceStatusLabel: mocks.javaServiceStatusLabel,
  javaServiceUrl: mocks.javaServiceUrl,
  restartJavaService: mocks.restartJavaService,
  startJavaService: mocks.startJavaService,
  stopJavaService: mocks.stopJavaService,
  validateJavaPort: mocks.validateJavaPort,
}));

import App from "./App";

let root: ReturnType<typeof createRoot> | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settleApp() {
  await act(async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("MCP settings navigation and layout", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it("renders the app shell while the local backend is still starting", async () => {
    let releaseBackend: (() => void) | undefined;
    const backendReady = new Promise<{ status: "ok"; version: string }>((resolve) => {
      releaseBackend = () => resolve({ status: "ok", version: "0.1.0" });
    });
    mocks.waitForBackend.mockImplementationOnce(() => backendReady);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<App />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container.querySelector(".boot-screen")).toBeNull();
    expect(container.querySelector(".app-shell")).not.toBeNull();
    expect(container.textContent).toContain("正在连接本地 Agent");

    releaseBackend?.();
    await settleApp();
  });

  it("places Java service as a sibling page and removes the MCP right aside", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    const mcpButton = buttonByText(container, "MCP");
    expect(mcpButton?.classList.contains("nav-item")).toBe(true);
    await act(async () => mcpButton?.click());
    expect(container.querySelector(".mcp-aside")).toBeNull();
    expect(container.querySelector(".mcp-list-scroll")).not.toBeNull();

    const javaButton = buttonByText(container, "Java 服务");
    expect(javaButton).toBeTruthy();
    expect(javaButton?.classList.contains("nav-item")).toBe(true);
    expect(javaButton?.classList.contains("nav-subitem")).toBe(false);
    await act(async () => javaButton?.click());
    expect(container.querySelector("h1")?.textContent).toBe("Java 服务");
    expect(container.querySelector(".java-service-page")).not.toBeNull();
  });

  it("keeps the MCP list in a visible scrolling container", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.mcp-list-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.mcp-list-scroll::-webkit-scrollbar/);
  });

  it("defers the built-in Java MCP probe until its service is ready", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    const calls = mocks.autoConnectMcpServers.mock.calls as unknown as Array<[Array<{ id: string }>]>;
    const servers = calls[0]?.[0] || [];
    expect(servers.map((server) => server.id)).toEqual(["custom-tools"]);
    expect(mocks.apiClient.testMcp).toHaveBeenCalledWith(mocks.javaServer);
  });

  it("shows the built-in Java endpoint in the global MCP center", async () => {
    mocks.apiClient.getConfig.mockResolvedValueOnce({
      ...mocks.config,
      mcp_servers: [mocks.javaServer],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    await act(async () => buttonByText(container, "MCP")?.click());

    expect(container.querySelector(".mcp-empty-state")).toBeNull();
    expect(container.querySelector('input.mcp-name[value="商城 Java MCP"]')).not.toBeNull();
    expect(container.querySelector('input[value="http://127.0.0.1:9991/mcp"]')).not.toBeNull();
  });

  it("keeps Java service controls separate from MCP connection configuration", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    await act(async () => buttonByText(container, "Java 服务")?.click());

    expect(container.textContent).toContain("Java 服务端口");
    expect(container.textContent).not.toContain("MCP 地址");
    expect(container.querySelector('input[aria-label="启用商城 Java MCP"]')).toBeNull();
    expect(buttonByText(container, "保存 Java 服务设置")).toBeUndefined();
  });

  it("does not claim that a hidden default prompt is sent when starting a session", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    await act(async () => buttonByText(container, "新会话")?.click());

    expect(container.textContent).toContain("已开启新会话，历史上下文已隔离。");
    expect(container.textContent).not.toContain("默认提示词将在下一次请求中自动发送");
  });

  it("deletes the active conversation and starts an empty session", async () => {
    window.localStorage.setItem("mallagent.conversation_id", "conversation-1");
    mocks.apiClient.getConversations.mockResolvedValueOnce({
      conversations: [{
        conversation_id: "conversation-1",
        title: "要删除的问题",
        updated_at: "2026-09-29 10:00:00",
      }],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settleApp();

    const deleteButton = container.querySelector('button[aria-label="删除对话 要删除的问题"]');
    expect(deleteButton).not.toBeNull();
    await act(async () => (deleteButton as HTMLButtonElement).click());
    await settleApp();

    expect(mocks.apiClient.deleteConversation).toHaveBeenCalledWith("conversation-1");
    expect(container.querySelector('button[aria-label="删除对话 要删除的问题"]')).toBeNull();
    expect(container.textContent).toContain("已删除对话，已开启新会话。");
  });
});
