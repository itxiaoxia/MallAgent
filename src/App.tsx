import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, resolveBackendUrl } from "./api";
import type { AppConfig, ChatMessage, McpServerConfig } from "./types";

type View = "chat" | "settings";
type ApiClient = ReturnType<typeof createApiClient>;

const initialConfig: AppConfig = {
  model: {
    base_url: "https://api.openai.com/v1",
    api_key: "",
    api_key_configured: false,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: null,
  },
  default_prompt: "",
  mcp_servers: [],
};

function newServer(): McpServerConfig {
  return {
    id: `server-${Date.now()}`,
    name: "新 MCP 服务",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    url: "",
    headers: {},
    enabled: true,
  };
}

function parseStringMap(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (Object.values(parsed).some((item) => typeof item !== "string")) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

function formatApiError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知错误，请重试。";
}

function formatEndpointHost(value: string) {
  try {
    return new URL(value).host || value;
  } catch {
    return value || "未配置";
  }
}

function App() {
  const [view, setView] = useState<View>("chat");
  const [backendUrl, setBackendUrl] = useState("");
  const [client, setClient] = useState<ApiClient | null>(null);
  const [config, setConfig] = useState<AppConfig>(initialConfig);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [mcpTestState, setMcpTestState] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const url = await resolveBackendUrl();
        const api = createApiClient(url);
        await api.health();
        const loaded = await api.getConfig();
        if (cancelled) return;
        setBackendUrl(url);
        setClient(api);
        setConfig(loaded);
        setConnected(true);
      } catch (loadError) {
        if (!cancelled) setError(`后端未就绪：${formatApiError(loadError)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledMcpCount = useMemo(
    () => config.mcp_servers.filter((server) => server.enabled).length,
    [config.mcp_servers],
  );

  function updateModel(field: keyof AppConfig["model"], value: string | number | null) {
    setConfig((current) => ({ ...current, model: { ...current.model, [field]: value } }));
  }

  function updateServer(id: string, patch: Partial<McpServerConfig>) {
    setConfig((current) => ({
      ...current,
      mcp_servers: current.mcp_servers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
    }));
  }

  async function saveSettings() {
    if (!client) return;
    setSaving(true);
    setError("");
    try {
      const saved = await client.saveConfig(config, apiKeyDraft, clearApiKey);
      setConfig(saved);
      setApiKeyDraft("");
      setClearApiKey(false);
      setNotice("设置已保存，新会话会立即使用当前默认提示词。\n");
    } catch (saveError) {
      setError(formatApiError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || !client || sending) return;
    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    setError("");
    try {
      const response = await client.chat(nextMessages);
      setMessages([...nextMessages, { role: "assistant", content: response.content || "（模型没有返回文本）" }]);
      setToolActivity(response.tool_calls);
    } catch (sendError) {
      setError(formatApiError(sendError));
    } finally {
      setSending(false);
    }
  }

  async function testMcp(server: McpServerConfig) {
    if (!client) return;
    setMcpTestState((current) => ({ ...current, [server.id]: "测试中…" }));
    try {
      const response = await client.testMcp(server);
      setMcpTestState((current) => ({
        ...current,
        [server.id]: `发现 ${response.tools.length} 个工具`,
      }));
    } catch (testError) {
      setMcpTestState((current) => ({ ...current, [server.id]: formatApiError(testError) }));
    }
  }

  function resetSession() {
    setMessages([]);
    setToolActivity([]);
    setError("");
    setNotice("已开启新会话，默认提示词将在下一次请求中自动发送。\n");
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="boot-mark">M</div>
        <p>正在启动 MallAgent…</p>
        <span>等待本地 Agent 服务响应</span>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">M</div>
          <div>
            <strong>MallAgent</strong>
            <span>Local agent studio</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <button className={view === "chat" ? "nav-item active" : "nav-item"} onClick={() => setView("chat")}>
            <span className="nav-icon">✦</span>
            Agent 对话
          </button>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => setView("settings")}>
            <span className="nav-icon">⚙</span>
            连接与设置
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className={connected ? "connection-status online" : "connection-status"}>
            <span className="status-dot" />
            {connected ? "本地服务已连接" : "本地服务未连接"}
          </div>
          <span className="version-label">Python 3.11 · LangChain</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">MALLAGENT / {view === "chat" ? "WORKSPACE" : "SETTINGS"}</span>
            <h1>{view === "chat" ? "和你的 Agent 开始工作" : "连接与行为"}</h1>
          </div>
          <div className="topbar-actions">
            <span className="backend-address" title={backendUrl}>{backendUrl || "localhost"}</span>
            {view === "chat" && <button className="secondary-button" onClick={resetSession}>新会话</button>}
          </div>
        </header>

        {error && <div className="alert error-alert">{error}</div>}
        {notice && <div className="alert notice-alert">{notice}</div>}

        {view === "chat" ? (
          <section className="chat-layout">
            <div className="chat-card">
              <div className="chat-toolbar">
                <div>
                  <span className="card-kicker">CURRENT SESSION</span>
                  <strong>{messages.length ? `${Math.ceil(messages.length / 2)} 轮对话` : "准备就绪"}</strong>
                </div>
                <div className="toolbar-meta">
                  <span>{enabledMcpCount} 个 MCP 服务</span>
                  {config.default_prompt && <span className="prompt-badge">默认提示词已启用</span>}
                </div>
              </div>

              <div className="message-list">
                {!messages.length && (
                  <div className="empty-chat">
                    <div className="empty-orbit">✦</div>
                    <h2>今天想让 Agent 做什么？</h2>
                    <p>它会使用你配置的 OpenAI-compatible 模型，并在需要时调用 MCP 工具。</p>
                    <div className="suggestion-row">
                      <button onClick={() => setInput("帮我梳理一下今天的工作计划")}>梳理工作计划</button>
                      <button onClick={() => setInput("介绍一下当前可用的 MCP 工具")}>查看可用工具</button>
                    </div>
                  </div>
                )}
                {messages.map((message, index) => (
                  <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                    <div className="message-avatar">{message.role === "user" ? "你" : "M"}</div>
                    <div className="message-content">
                      <span className="message-role">{message.role === "user" ? "YOU" : "MALLAGENT"}</span>
                      <p>{message.content}</p>
                    </div>
                  </article>
                ))}
                {sending && (
                  <article className="message assistant">
                    <div className="message-avatar">M</div>
                    <div className="message-content">
                      <span className="message-role">MALLAGENT</span>
                      <div className="typing-indicator"><i /><i /><i /></div>
                    </div>
                  </article>
                )}
              </div>

              <div className="composer-wrap">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder="输入消息，按 Enter 发送 · Shift + Enter 换行"
                  rows={3}
                  disabled={!connected || sending}
                />
                <div className="composer-footer">
                  <span>{config.model.model || "未配置模型"}</span>
                  <button className="send-button" onClick={() => void sendMessage()} disabled={!input.trim() || sending || !connected}>
                    {sending ? "处理中" : "发送"}<span>↗</span>
                  </button>
                </div>
              </div>
            </div>
            <aside className="context-card">
              <div className="card-kicker">AGENT CONTEXT</div>
              <h3>运行上下文</h3>
              <div className="context-row"><span>模型</span><strong>{config.model.model}</strong></div>
              <div className="context-row"><span>端点</span><strong>{formatEndpointHost(config.model.base_url)}</strong></div>
              <div className="context-row"><span>MCP 工具</span><strong>{enabledMcpCount} 个服务</strong></div>
              {toolActivity.length > 0 && (
                <div className="tool-log">
                  <span className="card-kicker">LAST TOOL CALLS</span>
                  {toolActivity.map((tool) => <code key={tool}>{tool}</code>)}
                </div>
              )}
              <div className="context-note">默认提示词会在每次 Agent 请求中作为系统指令发送。</div>
            </aside>
          </section>
        ) : (
          <section className="settings-layout">
            <div className="settings-main">
              <section className="settings-card">
                <div className="section-heading"><div><span className="card-kicker">MODEL PROVIDER</span><h2>OpenAI-compatible 模型</h2></div><span className="section-number">01</span></div>
                <div className="form-grid">
                  <label className="field full"><span>Base URL</span><input value={config.model.base_url} onChange={(event) => updateModel("base_url", event.target.value)} placeholder="https://api.openai.com/v1" /></label>
                  <label className="field"><span>模型名称</span><input value={config.model.model} onChange={(event) => updateModel("model", event.target.value)} placeholder="gpt-4o-mini" /></label>
                  <label className="field"><span>Temperature <em>{config.model.temperature}</em></span><input type="range" min="0" max="2" step="0.1" value={config.model.temperature} onChange={(event) => updateModel("temperature", Number(event.target.value))} /></label>
                  <label className="field full"><span>API Key {config.model.api_key_configured && <small>已保存 · 输入新值可替换</small>}</span><input type="password" value={apiKeyDraft} onChange={(event) => { setApiKeyDraft(event.target.value); setClearApiKey(false); }} placeholder={config.model.api_key_configured ? "已保存（不会回显）" : "sk-…"} autoComplete="new-password" /></label>
                </div>
                <div className="key-actions"><button className="text-button danger" onClick={() => { setApiKeyDraft(""); setClearApiKey(true); }}>清除已保存 Key</button><span>Key 只在本机配置中使用，不会通过读取接口返回。</span></div>
              </section>

              <section className="settings-card">
                <div className="section-heading"><div><span className="card-kicker">AGENT BEHAVIOR</span><h2>默认提示词</h2></div><span className="section-number">02</span></div>
                <p className="section-description">写入后，每次 Agent 请求都会作为 system prompt 自动发送。</p>
                <textarea className="prompt-editor" value={config.default_prompt} onChange={(event) => setConfig((current) => ({ ...current, default_prompt: event.target.value }))} placeholder="例如：你是一名严谨的中文工作助手，回答时先给结论，再给出必要步骤。" rows={7} />
              </section>

              <section className="settings-card">
                <div className="section-heading"><div><span className="card-kicker">MODEL CONTEXT PROTOCOL</span><h2>MCP 服务</h2></div><span className="section-number">03</span></div>
                <p className="section-description">将本地 stdio 工具或远程 streamable HTTP 服务挂载到 Agent。</p>
                <div className="mcp-list">
                  {config.mcp_servers.map((server) => (
                    <div className="mcp-editor" key={server.id}>
                      <div className="mcp-editor-head"><input className="mcp-name" value={server.name} onChange={(event) => updateServer(server.id, { name: event.target.value })} /><label className="toggle"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(server.id, { enabled: event.target.checked })} /><span /></label><button className="icon-button" onClick={() => setConfig((current) => ({ ...current, mcp_servers: current.mcp_servers.filter((item) => item.id !== server.id) }))} title="删除">×</button></div>
                      <div className="mcp-fields"><label className="field"><span>传输</span><select value={server.transport} onChange={(event) => updateServer(server.id, { transport: event.target.value as McpServerConfig["transport"] })}><option value="stdio">stdio · 本地进程</option><option value="http">HTTP · 远程服务</option></select></label>{server.transport === "stdio" ? <><label className="field"><span>启动命令</span><input value={server.command} onChange={(event) => updateServer(server.id, { command: event.target.value })} placeholder="python" /></label><label className="field full"><span>参数（每行一个）</span><textarea value={server.args.join("\n")} onChange={(event) => updateServer(server.id, { args: event.target.value.split("\n").filter(Boolean) })} rows={2} placeholder="path/to/server.py" /></label><label className="field full"><span>环境变量 JSON</span><textarea value={JSON.stringify(server.env, null, 2)} onChange={(event) => { const parsed = parseStringMap(event.target.value); if (parsed) updateServer(server.id, { env: parsed }); }} rows={2} /></label></> : <><label className="field full"><span>服务 URL</span><input value={server.url} onChange={(event) => updateServer(server.id, { url: event.target.value })} placeholder="https://example.com/mcp" /></label><label className="field full"><span>请求头 JSON</span><textarea value={JSON.stringify(server.headers, null, 2)} onChange={(event) => { const parsed = parseStringMap(event.target.value); if (parsed) updateServer(server.id, { headers: parsed }); }} rows={2} /></label></>}</div>
                      <div className="mcp-footer"><button className="small-button" onClick={() => void testMcp(server)} disabled={!server.enabled}>测试连接</button><span className={mcpTestState[server.id]?.startsWith("发现") ? "test-result success" : "test-result"}>{mcpTestState[server.id] || "未测试"}</span></div>
                    </div>
                  ))}
                </div>
                <button className="add-server" onClick={() => setConfig((current) => ({ ...current, mcp_servers: [...current.mcp_servers, newServer()] }))}>＋ 添加 MCP 服务</button>
              </section>
              <button className="primary-button save-button" onClick={() => void saveSettings()} disabled={saving}>{saving ? "保存中…" : "保存全部设置"}<span>→</span></button>
            </div>
            <aside className="settings-aside"><div className="aside-glow" /><span className="card-kicker">LOCAL FIRST</span><h3>你的连接，你的上下文</h3><p>MallAgent 在本机运行 Agent 和 MCP 客户端。只有模型请求与 MCP 服务请求会离开设备。</p><div className="aside-stat"><strong>{enabledMcpCount}</strong><span>启用中的 MCP 服务</span></div><div className="aside-stat"><strong>{config.default_prompt ? "ON" : "OFF"}</strong><span>默认提示词</span></div></aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
