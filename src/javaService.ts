import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig } from "./types";

export const DEFAULT_JAVA_MCP_SERVER_ID = "mall-system-java";
export const DEFAULT_JAVA_MCP_NAME = "商城 Java MCP";
export const DEFAULT_JAVA_MCP_HOST = "127.0.0.1";
export const DEFAULT_JAVA_MCP_PORT = 9991;

export type JavaServiceState = "starting" | "running" | "stopped" | "error";

export interface JavaServiceStatus {
  state: JavaServiceState;
  port: number;
  url: string;
  error: string | null;
}

type NativeJavaServiceState = JavaServiceState;

interface NativeJavaServiceStatus {
  state?: unknown;
  port?: unknown;
  url?: unknown;
  error?: unknown;
}

export type JavaServiceInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function validateJavaPort(value: string | number): number {
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("端口必须是 1 到 65535 之间的整数");
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1 到 65535 之间的整数");
  }
  return port;
}

export function javaServiceUrl(port: string | number) {
  return `http://${DEFAULT_JAVA_MCP_HOST}:${validateJavaPort(port)}/mcp`;
}

export function defaultJavaMcpServer(port = DEFAULT_JAVA_MCP_PORT): McpServerConfig {
  return {
    id: DEFAULT_JAVA_MCP_SERVER_ID,
    name: DEFAULT_JAVA_MCP_NAME,
    transport: "http",
    command: "",
    args: [],
    env: {},
    url: javaServiceUrl(port),
    headers: {},
    enabled: true,
  };
}

export function javaMcpPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== DEFAULT_JAVA_MCP_HOST || !parsed.port) return null;
    return validateJavaPort(parsed.port);
  } catch {
    return null;
  }
}

export function javaServiceStatusLabel(state: JavaServiceState) {
  switch (state) {
    case "starting":
      return "启动中…";
    case "running":
      return "运行中";
    case "error":
      return "启动失败";
    case "stopped":
    default:
      return "已停止";
  }
}

export function formatJavaServiceError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Java 服务操作失败，请重试。";
}

function normalizeNativeState(value: unknown): NativeJavaServiceState {
  return value === "starting" || value === "running" || value === "error" || value === "stopped" ? value : "error";
}

export function normalizeJavaServiceStatus(value: NativeJavaServiceStatus): JavaServiceStatus {
  let port = DEFAULT_JAVA_MCP_PORT;
  if (typeof value.port === "number" && Number.isSafeInteger(value.port)) {
    try {
      port = validateJavaPort(value.port);
    } catch {
      // Keep the safe default when a native response is malformed.
    }
  }
  const error = typeof value.error === "string" && value.error.trim() ? value.error : null;
  return {
    state: normalizeNativeState(value.state),
    port,
    url: typeof value.url === "string" && value.url.trim() ? value.url : javaServiceUrl(port),
    error,
  };
}

export async function getJavaServiceStatus(invoker: JavaServiceInvoker = invoke) {
  return invoker<NativeJavaServiceStatus>("java_service_status").then(normalizeJavaServiceStatus);
}

export async function startJavaService(port: string | number, invoker: JavaServiceInvoker = invoke) {
  const validPort = validateJavaPort(port);
  return invoker<NativeJavaServiceStatus>("start_java_service", { port: validPort }).then(normalizeJavaServiceStatus);
}

export async function stopJavaService(invoker: JavaServiceInvoker = invoke) {
  return invoker<NativeJavaServiceStatus>("stop_java_service").then(normalizeJavaServiceStatus);
}

export async function restartJavaService(port: string | number, invoker: JavaServiceInvoker = invoke) {
  const validPort = validateJavaPort(port);
  return invoker<NativeJavaServiceStatus>("restart_java_service", { port: validPort }).then(normalizeJavaServiceStatus);
}
