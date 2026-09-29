import { describe, expect, it } from "vitest";
import {
  autoConnectMcpServers,
  countConnectedMcpServers,
  mcpConnectionLabel,
  modelConnectionLabel,
  mcpTestStateFromResponse,
} from "./mcp";
import type { McpServerConfig } from "./types";

describe("MCP test result state", () => {
  it("keeps discovered API metadata for the settings view", () => {
    const tools = [
      { name: "list_products", description: "分页查询在售商品" },
      { name: "get_inventory", description: "查询商品当前库存" },
    ];

    expect(mcpTestStateFromResponse({ server_id: "mall", tools })).toEqual({
      status: "success",
      message: "已连接 · 2 个 API",
      tools,
    });
  });
});

describe("connection summary", () => {
  it("counts only MCP servers whose latest test succeeded", () => {
    const servers = [
      { id: "one", enabled: true },
      { id: "two", enabled: true },
      { id: "three", enabled: false },
    ] as McpServerConfig[];

    expect(countConnectedMcpServers(servers, {
      one: { status: "success" },
      two: { status: "error" },
      three: { status: "success" },
    })).toBe(1);
  });

  it("labels the model as connected only after a successful model response", () => {
    expect(modelConnectionLabel(false)).toBe("模型未连接");
    expect(modelConnectionLabel(true)).toBe("模型已连接");
  });

  it("does not present an untested MCP as a hard disconnected state", () => {
    const servers = [{ id: "one", enabled: true }] as McpServerConfig[];

    expect(mcpConnectionLabel(servers, {})).toBe("MCP 待连接 (1)");
    expect(mcpConnectionLabel(servers, { one: { status: "error" } })).toBe("MCP 暂不可用（对话仍可用）");
  });

  it("summarizes partial MCP availability without blocking the chat", () => {
    const servers = [
      { id: "one", enabled: true },
      { id: "two", enabled: true },
    ] as McpServerConfig[];

    expect(mcpConnectionLabel(servers, {
      one: { status: "success" },
      two: { status: "error" },
    })).toBe("MCP 部分可用 (1/2)");
  });
});

describe("startup MCP connection", () => {
  it("tests every enabled server and isolates a failed server", async () => {
    const servers = [
      { id: "healthy", name: "Healthy", enabled: true },
      { id: "broken", name: "Broken", enabled: true },
      { id: "disabled", name: "Disabled", enabled: false },
    ] as McpServerConfig[];
    const tested: string[] = [];

    const results = await autoConnectMcpServers(servers, async (server) => {
      tested.push(server.id);
      if (server.id === "broken") throw new Error("server unavailable");
      return { server_id: server.id, tools: [{ name: "tool", description: "Tool" }] };
    });

    expect(tested).toEqual(["healthy", "broken"]);
    expect(results.healthy).toEqual({
      status: "success",
      message: "已连接 · 1 个 API",
      tools: [{ name: "tool", description: "Tool" }],
    });
    expect(results.broken).toEqual({
      status: "error",
      message: "server unavailable",
      tools: [],
    });
    expect(results.disabled).toBeUndefined();
  });
});
