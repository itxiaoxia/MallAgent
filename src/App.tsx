import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApiClient, resolveBackendUrl, waitForBackend } from "./api";
import { getConversationTitle, loadConversationId, newConversationId, rememberConversationId } from "./conversation";
import { autoConnectModel } from "./model";
import {
  autoConnectMcpServers,
  countConnectedMcpServers,
  mcpConnectionLabel,
  modelConnectionLabel,
  mcpTestStateFromResponse,
} from "./mcp";
import type { AppConfig, ChatMessage, ChatStreamEvent, ConversationSummary, McpServerConfig } from "./types";
import type { McpTestState } from "./mcp";

type View = "chat" | "model" | "mcp";
type ApiClient = ReturnType<typeof createApiClient>;
type ModelTestStatus = "idle" | "testing" | "success" | "error";

interface ModelTestState {
  status: ModelTestStatus;
  message: string;
}

const initialConfig: AppConfig = {
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
  mcp_servers: [],
};

const MCP_AUTO_CONNECT_OPTIONS = { attempts: 3, delayMs: 200 };

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

function App() {
  const [view, setView] = useState<View>("chat");
  const [backendUrl, setBackendUrl] = useState("");
  const [client, setClient] = useState<ApiClient | null>(null);
  const apiClientRef = useRef<ApiClient | null>(null);
  const [config, setConfig] = useState<AppConfig>(initialConfig);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [conversationId, setConversationId] = useState(() => loadConversationId(window.localStorage));
  const conversationIdRef = useRef(conversationId);
  const activeRequestRef = useRef<{ conversationId: string; controller: AbortController } | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const modelConnectionRunRef = useRef(0);
  const mcpConnectionRunRef = useRef(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [modelConnected, setModelConnected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activityStatus, setActivityStatus] = useState("");
  const [expandedReasoning, setExpandedReasoning] = useState<Record<number, boolean>>({});
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, McpTestState>>({});
  const [apiModalServerId, setApiModalServerId] = useState<string | null>(null);
  const [modelTest, setModelTest] = useState<ModelTestState>({ status: "idle", message: "未测试" });

  async function autoConnectMcp(servers: McpServerConfig[], api: ApiClient) {
    const connectionRun = ++mcpConnectionRunRef.current;
    const enabledServers = servers.filter((server) => server.enabled);
    setMcpTestResults(Object.fromEntries(
      enabledServers.map((server) => [server.id, {
        status: "testing",
        message: "连接中…",
        tools: [],
      }]),
    ));
    const results = await autoConnectMcpServers(servers, api.testMcp, MCP_AUTO_CONNECT_OPTIONS);
    if (mcpConnectionRunRef.current === connectionRun) setMcpTestResults(results);
  }

  useEffect(() => {
    let cancelled = false;
    setConversationLoading(true);
    void (async () => {
      try {
        const url = await resolveBackendUrl();
        if (cancelled) return;
        setBackendUrl(url);
        const api = apiClientRef.current || createApiClient(url);
        apiClientRef.current = api;
        await waitForBackend(api.health);
        const loaded = await api.getConfig();
        const history = await api.getConversation(conversationId);
        let conversationList: ConversationSummary[] | undefined;
        try {
          conversationList = (await api.getConversations()).conversations;
        } catch {
          // Conversation history is optional to the main chat startup path.
        }
        if (cancelled) return;
        setBackendUrl(url);
        setClient(api);
        setConfig(loaded);
        setMessages(history.messages);
        if (conversationList) setConversations(conversationList);
        if (history.messages.length) setNotice("已恢复上次会话上下文。");
        setConnected(true);
      } catch (loadError) {
        if (!cancelled) setError(`后端未就绪：${formatApiError(loadError)}`);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setConversationLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const modelConnectionRun = modelConnectionRunRef.current;
    const modelConfigured = Boolean(config.model.api_key_configured || config.model.api_key);
    if (modelConfigured) {
      setModelTest({ status: "testing", message: "启动时连接中…" });
      void autoConnectModel(config, client.testModel).then((result) => {
        if (cancelled || modelConnectionRunRef.current !== modelConnectionRun) return;
        setModelConnected(result.status === "success");
        setModelTest(result);
      });
    } else {
      setModelConnected(false);
      setModelTest({ status: "idle", message: "未配置" });
    }

    void autoConnectMcp(config.mcp_servers, client);
    return () => {
      cancelled = true;
      mcpConnectionRunRef.current += 1;
    };
  }, [client]);

  const enabledMcpCount = useMemo(
    () => config.mcp_servers.filter((server) => server.enabled).length,
    [config.mcp_servers],
  );
  const connectedMcpCount = useMemo(
    () => countConnectedMcpServers(config.mcp_servers, mcpTestResults),
    [config.mcp_servers, mcpTestResults],
  );
  const mcpStatusLabel = useMemo(
    () => mcpConnectionLabel(config.mcp_servers, mcpTestResults),
    [config.mcp_servers, mcpTestResults],
  );
  const conversationTitle = useMemo(() => getConversationTitle(messages), [messages]);
  const apiModalServer = apiModalServerId
    ? config.mcp_servers.find((server) => server.id === apiModalServerId)
    : undefined;
  const apiModalResult = apiModalServer ? mcpTestResults[apiModalServer.id] : undefined;

  function updateModel(field: keyof AppConfig["model"], value: string | number | null) {
    setConfig((current) => ({ ...current, model: { ...current.model, [field]: value } }));
    invalidateModelConnection();
  }

  function invalidateModelConnection(message = "配置已修改，请重新测试") {
    modelConnectionRunRef.current += 1;
    setModelConnected(false);
    setModelTest({ status: "idle", message });
  }

  function updateServer(id: string, patch: Partial<McpServerConfig>) {
    mcpConnectionRunRef.current += 1;
    setConfig((current) => ({
      ...current,
      mcp_servers: current.mcp_servers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
    }));
    setMcpTestResults((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function testModelConnection(
    testConfig = config,
    draftApiKey = apiKeyDraft,
    shouldClearApiKey = clearApiKey,
  ) {
    if (!client || !connected) {
      setModelConnected(false);
      setModelTest({ status: "error", message: "本地 Agent 服务尚未就绪，请稍后重试。" });
      return false;
    }
    const connectionRun = ++modelConnectionRunRef.current;
    setError("");
    setModelConnected(false);
    setModelTest({ status: "testing", message: "正在测试模型连接…" });
    try {
      const result = await client.testModel(testConfig, draftApiKey, shouldClearApiKey);
      if (modelConnectionRunRef.current !== connectionRun) return false;
      setModelConnected(true);
      setModelTest({ status: "success", message: `连接成功 · ${result.model}` });
      return true;
    } catch (testError) {
      if (modelConnectionRunRef.current !== connectionRun) return false;
      setModelConnected(false);
      setModelTest({ status: "error", message: `连接失败：${formatApiError(testError)}` });
      return false;
    }
  }

  async function saveSettings() {
    if (!client) return;
    const shouldTestModel = view === "model";
    const shouldTestMcp = view === "mcp";
    if (shouldTestModel) modelConnectionRunRef.current += 1;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await client.saveConfig(config, apiKeyDraft, clearApiKey);
      setConfig(saved);
      setApiKeyDraft("");
      setClearApiKey(false);
      if (shouldTestModel) {
        const connectedAfterSave = await testModelConnection(saved, "", false);
        if (connectedAfterSave) {
          setNotice("设置已保存，模型连接测试成功。\n");
        } else {
          setError("设置已保存，但模型连接测试未通过，请检查模型配置。\n");
        }
      } else if (shouldTestMcp) {
        await autoConnectMcp(saved.mcp_servers, client);
        setNotice("设置已保存，MCP 已自动尝试连接。\n");
      } else {
        setNotice("设置已保存，新会话会立即使用当前默认提示词。\n");
      }
    } catch (saveError) {
      if (shouldTestModel) {
        setModelConnected(false);
        setModelTest({ status: "error", message: "保存失败，未执行模型连接测试" });
      }
      setError(formatApiError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function refreshConversations(api = apiClientRef.current) {
    if (!api) return;
    try {
      setConversations((await api.getConversations()).conversations);
    } catch {
      // A sidebar refresh failure must not hide a completed chat response.
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || !client || sending) return;
    const requestConversationId = conversationIdRef.current;
    const controller = new AbortController();
    activeRequestRef.current = { conversationId: requestConversationId, controller };
    const nextMessages = [...messages, { role: "user" as const, content }];
    const assistantIndex = nextMessages.length;
    setMessages([...nextMessages, { role: "assistant", content: "", reasoning: "" }]);
    setInput("");
    setSending(true);
    setError("");
    setActivityStatus("准备连接模型…");
    let streamError = "";
    const isActiveRequest = () => {
      const active = activeRequestRef.current;
      return active?.conversationId === requestConversationId && active.controller === controller;
    };
    try {
      await client.streamChat([{ role: "user", content }], (event: ChatStreamEvent) => {
        if (!isActiveRequest()) return;
        const contentDelta = typeof event.content === "string" ? event.content : "";
        switch (event.type) {
          case "start":
            setActivityStatus(event.attempt && event.max_attempts ? `第 ${event.attempt} 次尝试中…` : "思考中…");
            break;
          case "reasoning_delta":
            setMessages((current) => current.map((message, index) => index === assistantIndex ? { ...message, reasoning: `${message.reasoning || ""}${contentDelta}` } : message));
            setExpandedReasoning((current) => ({ ...current, [assistantIndex]: true }));
            setActivityStatus("思考中…");
            break;
          case "content_delta":
            setMessages((current) => current.map((message, index) => index === assistantIndex ? { ...message, content: `${message.content}${contentDelta}` } : message));
            setExpandedReasoning((current) => ({ ...current, [assistantIndex]: false }));
            setActivityStatus("生成回答中…");
            break;
          case "tool_call": {
            const toolName = typeof event.name === "string" ? event.name : "MCP 工具";
            setActivityStatus(`正在调用 ${toolName}…`);
            break;
          }
          case "self_heal":
            setActivityStatus(typeof event.message === "string" ? event.message : "正在隔离故障 MCP 服务…");
            break;
          case "retry":
            setMessages((current) => current.map((message, index) => index === assistantIndex ? { ...message, content: "", reasoning: "" } : message));
            setExpandedReasoning((current) => ({ ...current, [assistantIndex]: true }));
            setActivityStatus(typeof event.message === "string" ? event.message : "正在重试…");
            break;
          case "done": {
            const finalContent = typeof event.content === "string" ? event.content : "";
            const finalReasoning = typeof event.reasoning === "string" ? event.reasoning : "";
            setMessages((current) => current.map((message, index) => index === assistantIndex ? {
              ...message,
              content: finalContent || message.content || "（模型没有返回文本）",
              reasoning: finalReasoning || message.reasoning,
            } : message));
            setModelConnected(true);
            setExpandedReasoning((current) => ({ ...current, [assistantIndex]: false }));
            setActivityStatus("已完成");
            break;
          }
          case "error":
            streamError = typeof event.message === "string" ? event.message : "Agent 请求失败。";
            break;
        }
      }, controller.signal, requestConversationId);
      if (streamError) throw new Error(streamError);
      await refreshConversations(client);
    } catch (sendError) {
      if (isActiveRequest()) {
        setMessages(messages);
        setInput(content);
        setModelConnected(false);
        setActivityStatus("");
        setError(formatApiError(sendError));
      }
    } finally {
      if (isActiveRequest()) {
        activeRequestRef.current = null;
        setSending(false);
      }
    }
  }

  async function testMcp(server: McpServerConfig) {
    const connectionRun = ++mcpConnectionRunRef.current;
    if (!client || !connected) {
      setMcpTestResults((current) => ({
        ...current,
        [server.id]: { status: "error", message: "本地 Agent 服务尚未就绪，请稍后重试。", tools: [] },
      }));
      return;
    }
    setMcpTestResults((current) => ({
      ...current,
      [server.id]: { status: "testing", message: "连接中…", tools: [] },
    }));
    try {
      const response = await client.testMcp(server);
      if (mcpConnectionRunRef.current !== connectionRun) return;
      setMcpTestResults((current) => ({
        ...current,
        [server.id]: mcpTestStateFromResponse(response),
      }));
    } catch (testError) {
      if (mcpConnectionRunRef.current !== connectionRun) return;
      setMcpTestResults((current) => ({
        ...current,
        [server.id]: { status: "error", message: formatApiError(testError), tools: [] },
      }));
    }
  }

  function resetSession() {
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    const nextConversationId = newConversationId(window.localStorage);
    conversationIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
    setMessages([]);
    setActivityStatus("");
    setExpandedReasoning({});
    setSending(false);
    setError("");
    setNotice("已开启新会话，历史上下文已隔离；默认提示词将在下一次请求中自动发送。\n");
  }

  function selectConversation(nextConversationId: string) {
    if (nextConversationId === conversationIdRef.current) {
      setView("chat");
      return;
    }
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    const selectedId = rememberConversationId(window.localStorage, nextConversationId);
    conversationIdRef.current = selectedId;
    setConversationId(selectedId);
    setView("chat");
    setApiModalServerId(null);
    setMessages([]);
    setInput("");
    setActivityStatus("");
    setExpandedReasoning({});
    setSending(false);
    setError("");
    setNotice("");
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
          <button className={view === "chat" ? "nav-item active" : "nav-item"} onClick={() => { setView("chat"); setApiModalServerId(null); }}>
            <span className="nav-icon">✦</span>
            Agent 对话
          </button>
          <button className={view === "model" ? "nav-item active" : "nav-item"} onClick={() => { setView("model"); setApiModalServerId(null); }}>
            <span className="nav-icon">◈</span>
            模型
          </button>
          <button className={view === "mcp" ? "nav-item active" : "nav-item"} onClick={() => { setView("mcp"); setApiModalServerId(null); }}>
            <span className="nav-icon">⌘</span>
            MCP
          </button>
        </nav>

        <section className="conversation-history" aria-labelledby="conversation-history-title">
          <div className="conversation-history-heading">
            <span id="conversation-history-title" className="card-kicker">CONVERSATIONS</span>
            <span className="conversation-history-count">{conversations.length}</span>
          </div>
          <div className="conversation-history-list">
            {conversations.length ? conversations.map((conversation) => (
              <button
                className={view === "chat" && conversationId === conversation.conversation_id ? "conversation-history-item active" : "conversation-history-item"}
                key={conversation.conversation_id}
                type="button"
                title={conversation.title}
                aria-current={view === "chat" && conversationId === conversation.conversation_id ? "page" : undefined}
                onClick={() => selectConversation(conversation.conversation_id)}
              >
                <span className="conversation-history-marker">◦</span>
                <span className="conversation-history-title">{conversation.title}</span>
              </button>
            )) : <span className="conversation-history-empty">暂无对话记录</span>}
          </div>
        </section>

        <div className="sidebar-bottom">
          <div className={modelConnected ? "connection-status online" : "connection-status"}>
            <span className="status-dot" />
            {modelConnectionLabel(modelConnected)}
          </div>
          <div className={connectedMcpCount > 0 ? "connection-status online" : "connection-status"}>
            <span className="status-dot" />
            {mcpStatusLabel}
          </div>
          <span className="version-label">Python 3.11 · LangChain</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">MALLAGENT / {view === "chat" ? "WORKSPACE" : view === "model" ? "MODEL" : "MCP"}</span>
            <h1>{view === "chat" ? "和你的 Agent 开始工作" : view === "model" ? "模型配置" : "MCP 服务"}</h1>
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
                <div className="session-heading">
                  <span className="card-kicker">CURRENT SESSION</span>
                  <div className="session-title-row">
                    <strong className="conversation-title" title={conversationTitle}>{conversationTitle}</strong>
                  </div>
                </div>
                <div className="toolbar-meta">
                  {activityStatus && <span className={`activity-status-inline ${sending ? "active" : "complete"}`} role="status" aria-live="polite">{activityStatus}</span>}
                  <span>{enabledMcpCount} 个 MCP 服务</span>
                  {config.default_prompt && <span className="prompt-badge">默认提示词已启用</span>}
                </div>
              </div>

              <div className="message-list">
                {conversationLoading ? (
                  <div className="empty-chat">
                    <div className="empty-orbit">◌</div>
                    <h2>正在加载会话…</h2>
                  </div>
                ) : !messages.length && (
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
                      {message.role === "assistant" && message.reasoning && (
                        <div className="reasoning-panel">
                          <button
                            className="reasoning-toggle"
                            type="button"
                            aria-expanded={Boolean(expandedReasoning[index])}
                            onClick={() => setExpandedReasoning((current) => ({ ...current, [index]: !current[index] }))}
                          >
                            <span>思考过程</span>
                            <span className="reasoning-chevron">{expandedReasoning[index] ? "⌃" : "⌄"}</span>
                          </button>
                          {expandedReasoning[index] && <div className="reasoning-content">{message.reasoning}</div>}
                        </div>
                      )}
                      {message.content ? <p>{message.content}</p> : sending && index === messages.length - 1 ? <div className="typing-indicator"><i /><i /><i /></div> : null}
                    </div>
                  </article>
                ))}
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
          </section>
        ) : view === "model" ? (
          <section className="settings-layout model-layout">
            <div className="settings-main model-settings-main">
              <section className="settings-card">
                <div className="section-heading"><div><span className="card-kicker">MODEL PROVIDER</span><h2>OpenAI-compatible 模型</h2></div><span className="section-number">01</span></div>
                <div className="form-grid">
                  <label className="field full"><span>Base URL</span><input value={config.model.base_url} onChange={(event) => updateModel("base_url", event.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" /></label>
                  <label className="field"><span>模型名称</span><input value={config.model.model} onChange={(event) => updateModel("model", event.target.value)} placeholder="qwen3.8-max" /></label>
                  <label className="field"><span>Temperature <em>{config.model.temperature}</em></span><input type="range" min="0" max="1.9" step="0.1" value={config.model.temperature} onChange={(event) => updateModel("temperature", Number(event.target.value))} /><small>模型温度，范围 0–1.9</small></label>
                  <label className="field"><span>超时（秒）</span><input type="number" min="1" max="3600" step="1" value={config.model.timeout} onChange={(event) => updateModel("timeout", Number(event.target.value))} /></label>
                  <label className="field"><span>重试次数</span><input type="number" min="0" max="10" step="1" value={config.model.retry_count} onChange={(event) => updateModel("retry_count", Number(event.target.value))} /></label>
                  <label className="field full"><span>API Key {config.model.api_key_configured && <small>已保存 · 输入新值可替换</small>}</span><input type="password" value={apiKeyDraft} onChange={(event) => { setApiKeyDraft(event.target.value); setClearApiKey(false); invalidateModelConnection(); }} placeholder={config.model.api_key_configured ? "已保存（不会回显）" : "sk-…"} autoComplete="new-password" /></label>
                </div>
                <div className="key-actions"><button className="text-button danger" onClick={() => { setApiKeyDraft(""); setClearApiKey(true); invalidateModelConnection(); }}>清除已保存 Key</button><span>Key 只在本机配置中使用，不会通过读取接口返回。</span></div>
              </section>

              <section className="settings-card prompt-card">
                <div className="section-heading"><div><span className="card-kicker">AGENT BEHAVIOR</span><h2>默认提示词</h2></div><span className="section-number">02</span></div>
                <p className="section-description">写入后，每次 Agent 请求都会作为 system prompt 自动发送。</p>
                <textarea className="prompt-editor" value={config.default_prompt} onChange={(event) => { setConfig((current) => ({ ...current, default_prompt: event.target.value })); invalidateModelConnection(); }} placeholder="例如：你是一名严谨的中文工作助手，回答时先给结论，再给出必要步骤。" rows={7} />
              </section>
              <div className="model-actions">
                <span className={`model-test-status ${modelTest.status}`} role="status" aria-live="polite">{modelTest.message}</span>
                <div className="model-action-buttons">
                  <button className="secondary-button" onClick={() => void testModelConnection()} disabled={saving || !client || !connected || modelTest.status === "testing"}>{modelTest.status === "testing" ? "测试中…" : "测试连接"}</button>
                  <button className="primary-button save-button" onClick={() => void saveSettings()} disabled={saving}>{saving ? "保存中…" : "保存模型设置"}<span>→</span></button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="settings-layout mcp-layout">
            <div className="settings-main mcp-settings-main">
              <section className="settings-card mcp-settings-card">
                <div className="section-heading"><div><span className="card-kicker">MODEL CONTEXT PROTOCOL</span><h2>MCP 服务</h2></div><span className="section-number">01</span></div>
                <p className="section-description">支持 stdio 与 Streamable HTTP 两种 MCP 协议。</p>
                <div className="mcp-list">
                  {config.mcp_servers.map((server) => {
                    const result = mcpTestResults[server.id];
                    const resultClass = result?.status === "success" ? "test-result success" : result?.status === "error" ? "test-result error" : "test-result";
                    return (
                      <div className="mcp-editor" key={server.id}>
                        <div className="mcp-editor-head"><input className="mcp-name" value={server.name} onChange={(event) => updateServer(server.id, { name: event.target.value })} /><label className="toggle"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(server.id, { enabled: event.target.checked })} /><span /></label><button className="icon-button" onClick={() => { mcpConnectionRunRef.current += 1; setConfig((current) => ({ ...current, mcp_servers: current.mcp_servers.filter((item) => item.id !== server.id) })); setMcpTestResults((current) => { const next = { ...current }; delete next[server.id]; return next; }); setApiModalServerId((current) => current === server.id ? null : current); }} title="删除">×</button></div>
                        <div className="mcp-fields"><label className="field"><span>协议</span><select value={server.transport} onChange={(event) => updateServer(server.id, { transport: event.target.value as McpServerConfig["transport"] })}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></select></label>{server.transport === "stdio" ? <><label className="field"><span>启动命令</span><input value={server.command} onChange={(event) => updateServer(server.id, { command: event.target.value })} placeholder="python" /></label><label className="field full"><span>参数（每行一个）</span><textarea value={server.args.join("\n")} onChange={(event) => updateServer(server.id, { args: event.target.value.split("\n").filter(Boolean) })} rows={2} placeholder="path/to/server.py" /></label><label className="field full"><span>环境变量 JSON</span><textarea value={JSON.stringify(server.env, null, 2)} onChange={(event) => { const parsed = parseStringMap(event.target.value); if (parsed) updateServer(server.id, { env: parsed }); }} rows={2} /></label></> : <><label className="field full"><span>服务 URL</span><input value={server.url} onChange={(event) => updateServer(server.id, { url: event.target.value })} placeholder="https://example.com/mcp" /></label><label className="field full"><span>请求头 JSON</span><textarea value={JSON.stringify(server.headers, null, 2)} onChange={(event) => { const parsed = parseStringMap(event.target.value); if (parsed) updateServer(server.id, { headers: parsed }); }} rows={2} /></label></>}</div>
                        <div className="mcp-footer"><button className="small-button" onClick={() => void testMcp(server)} disabled={!server.enabled || !client || !connected || result?.status === "testing"}>{result?.status === "testing" ? "连接中…" : "测试连接"}</button><span className={resultClass}>{result?.message || (!connected ? "服务未就绪" : "未测试")}</span>{result?.status === "success" && <button type="button" className="api-info-button" onClick={() => setApiModalServerId(server.id)} title="查看 API 列表" aria-label={`查看 ${server.name} 的 API 列表`}><span className="api-info-icon">i</span><span>{result.tools.length}</span></button>}</div>
                      </div>
                    );
                  })}
                </div>
                <button className="add-server" onClick={() => { mcpConnectionRunRef.current += 1; setConfig((current) => ({ ...current, mcp_servers: [...current.mcp_servers, newServer()] })); }}>＋ 添加 MCP 服务</button>
              </section>
              <button className="primary-button save-button" onClick={() => void saveSettings()} disabled={saving}>{saving ? "保存中…" : "保存 MCP 设置"}<span>→</span></button>
            </div>
            <aside className="settings-aside mcp-aside"><div className="aside-glow" /><span className="card-kicker">MCP STATUS</span><h3>你的工具连接</h3><p>只有最近一次测试成功的启用服务会计入已连接数量。API 详情通过信息按钮查看。</p><div className="aside-stat"><strong>{connectedMcpCount}</strong><span>已连接 MCP 服务</span></div><div className="aside-stat"><strong>{enabledMcpCount}</strong><span>已启用 MCP 服务</span></div></aside>
          </section>
        )}
        {apiModalServer && apiModalResult?.status === "success" && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setApiModalServerId(null); }}>
            <section className="api-modal" role="dialog" aria-modal="true" aria-labelledby="api-modal-title">
              <header className="api-modal-header"><div><span className="card-kicker">MCP API LIST</span><h2 id="api-modal-title">{apiModalServer.name}</h2><p>{apiModalResult.tools.length} 个可用 API</p></div><button type="button" className="icon-button modal-close" onClick={() => setApiModalServerId(null)} aria-label="关闭 API 列表">×</button></header>
              <div className="api-modal-body">{apiModalResult.tools.length ? <ul>{apiModalResult.tools.map((tool) => <li className="mcp-api-item" key={`${apiModalServer.id}-${tool.name}`}><code>{tool.name}</code><span>{tool.description || "未提供描述"}</span></li>)}</ul> : <p className="mcp-api-empty">连接成功，但服务未返回 API。</p>}</div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
