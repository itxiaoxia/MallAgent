import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JAVA_MCP_HOST,
  DEFAULT_JAVA_MCP_PORT,
  DEFAULT_JAVA_MCP_SERVER_ID,
  defaultJavaMcpServer,
  formatJavaServiceError,
  javaMcpPortFromUrl,
  normalizeJavaServiceStatus,
  javaServiceStatusLabel,
  startJavaService,
  stopJavaService,
} from "./javaService";

describe("default Java MCP configuration", () => {
  it("creates the built-in HTTP MCP server on the loopback default port", () => {
    expect(defaultJavaMcpServer()).toEqual({
      id: DEFAULT_JAVA_MCP_SERVER_ID,
      name: "商城 Java MCP",
      transport: "http",
      command: "",
      args: [],
      env: {},
      url: `http://${DEFAULT_JAVA_MCP_HOST}:${DEFAULT_JAVA_MCP_PORT}/mcp`,
      headers: {},
      enabled: true,
    });
  });

  it("keeps a user-selected valid port in the MCP URL", () => {
    expect(javaMcpPortFromUrl("http://127.0.0.1:43123/mcp")).toBe(43123);
    expect(javaMcpPortFromUrl("http://127.0.0.1/mcp")).toBeNull();
    expect(javaMcpPortFromUrl("not-a-url")).toBeNull();
  });
});

describe("native Java service status", () => {
  it("preserves the starting state while the background JVM is warming up", () => {
    expect(normalizeJavaServiceStatus({
      state: "starting",
      port: DEFAULT_JAVA_MCP_PORT,
      url: `http://${DEFAULT_JAVA_MCP_HOST}:${DEFAULT_JAVA_MCP_PORT}/mcp`,
      error: null,
    })).toEqual({
      state: "starting",
      port: DEFAULT_JAVA_MCP_PORT,
      url: `http://${DEFAULT_JAVA_MCP_HOST}:${DEFAULT_JAVA_MCP_PORT}/mcp`,
      error: null,
    });
  });
});

describe("Java service command wrappers", () => {
  it("rejects an invalid port before invoking Tauri", async () => {
    const invoker = vi.fn();

    await expect(startJavaService(0, invoker)).rejects.toThrow("端口必须是 1 到 65535 之间的整数");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("passes the validated port and normalizes the native status", async () => {
    const invoker = vi.fn().mockResolvedValue({
      state: "running",
      port: 43123,
      url: "http://127.0.0.1:43123/mcp",
      error: null,
    });

    await expect(startJavaService("43123", invoker)).resolves.toEqual({
      state: "running",
      port: 43123,
      url: "http://127.0.0.1:43123/mcp",
      error: null,
    });
    expect(invoker).toHaveBeenCalledWith("start_java_service", { port: 43123 });
  });

  it("uses the stop command without inventing a port", async () => {
    const invoker = vi.fn().mockResolvedValue({
      state: "stopped",
      port: DEFAULT_JAVA_MCP_PORT,
      url: `http://127.0.0.1:${DEFAULT_JAVA_MCP_PORT}/mcp`,
      error: null,
    });

    await stopJavaService(invoker);
    expect(invoker).toHaveBeenCalledWith("stop_java_service");
  });
});

describe("Java service presentation", () => {
  it("uses explicit labels for every lifecycle state", () => {
    expect(javaServiceStatusLabel("starting")).toBe("启动中…");
    expect(javaServiceStatusLabel("running")).toBe("运行中");
    expect(javaServiceStatusLabel("stopped")).toBe("已停止");
    expect(javaServiceStatusLabel("error")).toBe("启动失败");
  });

  it("formats unknown native errors without exposing an object dump", () => {
    expect(formatJavaServiceError(new Error("端口已被占用"))).toBe("端口已被占用");
    expect(formatJavaServiceError({ message: "secret stack" })).toBe("Java 服务操作失败，请重试。");
  });
});
