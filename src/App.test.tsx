/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const server = {
    id: "saved-mcp",
    name: "Saved MCP",
    transport: "http" as const,
    command: "",
    args: [] as string[],
    env: {},
    url: "https://example.test/mcp",
    headers: {},
    enabled: true,
  };
  const config = {
    model: {
      base_url: "https://api.openai.com/v1",
      api_key: "",
      api_key_configured: false,
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: null,
      timeout: 60,
      retry_count: 2,
    },
    default_prompt: "",
    mcp_servers: [server],
  };
  const apiClient = {
    health: vi.fn(async () => ({ status: "ok" as const, version: "0.1.0" })),
    getConfig: vi.fn(async () => config),
    getConversation: vi.fn(async () => ({ conversation_id: "default", messages: [] })),
    getConversations: vi.fn(async () => ({ conversations: [] })),
    saveConfig: vi.fn(async (nextConfig: typeof config) => nextConfig),
    testModel: vi.fn(async () => ({ status: "ok" as const, model: "gpt-4o-mini" })),
    testMcp: vi.fn(async (nextServer: typeof server) => ({ server_id: nextServer.id, tools: [] })),
    streamChat: vi.fn(),
  };
  return { apiClient, config, server };
});

vi.mock("./api", () => ({
  ApiError: class MockApiError extends Error {
    status = 500;
  },
  createApiClient: vi.fn(() => mocks.apiClient),
  resolveBackendUrl: vi.fn(async () => "http://127.0.0.1:45831"),
  waitForBackend: vi.fn(async () => ({ status: "ok" as const, version: "0.1.0" })),
}));
vi.mock("./model", () => ({
  autoConnectModel: vi.fn(async () => ({ status: "success" as const, message: "连接成功" })),
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

function renderApp() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return container;
}

describe("MCP connection lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.apiClient.testMcp.mockImplementation(async (nextServer: typeof mocks.server) => ({
      server_id: nextServer.id,
      tools: [],
    }));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it("auto-connects enabled saved MCP servers when the app loads and after saving MCP settings", async () => {
    const container = renderApp();
    await act(async () => root?.render(<App />));
    await settleApp();

    expect(mocks.apiClient.testMcp).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("MCP 已连接 (1)");

    await act(async () => buttonByText(container, "MCP")?.click());
    await act(async () => buttonByText(container, "保存 MCP 设置")?.click());
    await settleApp();

    expect(mocks.apiClient.testMcp).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("MCP 已连接 (1)");
  });

  it("keeps an automatically failed MCP in the pending state", async () => {
    mocks.apiClient.testMcp.mockRejectedValue(new Error("server unavailable"));
    const container = renderApp();
    await act(async () => root?.render(<App />));
    await settleApp();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await settleApp();

    expect(container.textContent).toContain("MCP 待连接 (1)");
    expect(container.textContent).not.toContain("MCP 暂不可用");
  });

  it("does not apply a manual result after the MCP configuration changes", async () => {
    let releaseManualTest: ((response: { server_id: string; tools: never[] }) => void) | undefined;
    const container = renderApp();
    await act(async () => root?.render(<App />));
    await settleApp();
    await act(async () => buttonByText(container, "MCP")?.click());
    mocks.apiClient.testMcp.mockImplementationOnce(() => new Promise((resolve) => {
      releaseManualTest = resolve;
    }));

    await act(async () => buttonByText(container, "测试连接")?.click());
    expect(mocks.apiClient.testMcp).toHaveBeenCalledTimes(2);
    expect(releaseManualTest).toBeDefined();
    const toggle = container.querySelector(".toggle input") as HTMLInputElement;
    await act(async () => toggle.click());
    expect(container.querySelector(".mcp-footer")?.textContent).toContain("未测试");
    await act(async () => releaseManualTest?.({ server_id: mocks.server.id, tools: [] }));
    await settleApp();

    expect(container.querySelector(".mcp-footer")?.textContent).toContain("未测试");
  });
});
