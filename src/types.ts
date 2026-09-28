export type McpTransport = "stdio" | "http";
export type ChatRole = "user" | "assistant";

export interface ModelConfig {
  base_url: string;
  api_key: string;
  api_key_configured?: boolean;
  model: string;
  temperature: number;
  max_tokens: number | null;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

export interface AppConfig {
  model: ModelConfig;
  default_prompt: string;
  mcp_servers: McpServerConfig[];
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatResponse {
  content: string;
  tool_calls: string[];
}

export interface McpTool {
  name: string;
  description: string;
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface McpTestResponse {
  server_id: string;
  tools: McpTool[];
}
