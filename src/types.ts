export type McpTransport = "stdio" | "http";
export type ChatRole = "user" | "assistant";

export interface ModelConfig {
  base_url: string;
  api_key: string;
  api_key_configured?: boolean;
  model: string;
  temperature: number;
  max_tokens: number | null;
  timeout: number;
  retry_count: number;
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
  reasoning?: string;
}

export interface ChatResponse {
  content: string;
  tool_calls: string[];
}

export interface ConversationResponse {
  conversation_id: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  conversation_id: string;
  title: string;
  updated_at: string;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
}

export type ChatStreamEventType =
  | "start"
  | "reasoning_delta"
  | "content_delta"
  | "tool_call"
  | "self_heal"
  | "retry"
  | "done"
  | "error";

export interface ChatStreamEvent {
  type: ChatStreamEventType;
  [key: string]: unknown;
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

export interface ModelTestResponse {
  status: "ok";
  model: string;
}
