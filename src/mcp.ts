import type { McpServerConfig, McpTestResponse, McpTool } from "./types";

export type McpTestStatus = "testing" | "success" | "error";

export interface McpTestState {
  status: McpTestStatus;
  message: string;
  tools: McpTool[];
}

type McpTestRunner = (server: McpServerConfig) => Promise<McpTestResponse>;

export interface AutoConnectOptions {
  attempts?: number;
  delayMs?: number;
}

export function mcpTestStateFromResponse(response: McpTestResponse): McpTestState {
  return {
    status: "success",
    message: `已连接 · ${response.tools.length} 个 API`,
    tools: response.tools,
  };
}

export function mcpTestStateFromError(error: unknown): McpTestState {
  return {
    status: "error",
    message: error instanceof Error ? error.message : "MCP 连接失败，请重试。",
    tools: [],
  };
}

async function testWithRetry(
  server: McpServerConfig,
  testServer: McpTestRunner,
  { attempts = 1, delayMs = 0 }: AutoConnectOptions,
) {
  const maxAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await testServer(server);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("MCP 连接失败，请重试。");
}

export async function autoConnectMcpServers(
  servers: McpServerConfig[],
  testServer: McpTestRunner,
  options: AutoConnectOptions = {},
): Promise<Record<string, McpTestState>> {
  const enabledServers = servers.filter((server) => server.enabled);
  const entries = await Promise.all(
    enabledServers.map(async (server) => {
      try {
        return [server.id, mcpTestStateFromResponse(await testWithRetry(server, testServer, options))] as const;
      } catch (error) {
        return [server.id, mcpTestStateFromError(error)] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function countConnectedMcpServers(
  servers: Pick<McpServerConfig, "id" | "enabled">[],
  results: Record<string, Pick<McpTestState, "status"> | undefined>,
) {
  return servers.filter((server) => server.enabled && results[server.id]?.status === "success").length;
}

export function mcpConnectionLabel(
  servers: Pick<McpServerConfig, "id" | "enabled">[],
  results: Record<string, Pick<McpTestState, "status"> | undefined>,
) {
  const enabledServers = servers.filter((server) => server.enabled);
  if (!enabledServers.length) return "MCP 未配置";

  const connected = countConnectedMcpServers(servers, results);
  const pending = enabledServers.filter((server) => {
    const status = results[server.id]?.status;
    return status !== "success" && status !== "error";
  }).length;
  if (pending > 0) {
    return enabledServers.some((server) => results[server.id]?.status === "testing")
      ? "MCP 连接中…"
      : `MCP 待连接 (${pending})`;
  }
  if (connected === enabledServers.length) return `MCP 已连接 (${connected})`;
  if (connected > 0) return `MCP 部分可用 (${connected}/${enabledServers.length})`;
  return "MCP 暂不可用（对话仍可用）";
}

export function modelConnectionLabel(connected: boolean) {
  return connected ? "模型已连接" : "模型未连接";
}
