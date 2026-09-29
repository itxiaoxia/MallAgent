import { describe, expect, it, vi } from "vitest";
import {
  buildConfigUpdate,
  buildModelTestUpdate,
  createApiClient,
  parseSseBlock,
  resolveBackendUrl,
  sanitizeConfigForForm,
  waitForBackend,
} from "./api";
import type { AppConfig } from "./types";

const config: AppConfig = {
  model: {
    base_url: "https://api.openai.com/v1",
    api_key: "",
    api_key_configured: true,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: null,
    timeout: 60,
    retry_count: 2,
  },
  default_prompt: "Be concise",
  mcp_servers: [],
};

describe("backend URL resolution", () => {
  it("prefers the Tauri command and falls back to the local development port", async () => {
    await expect(resolveBackendUrl(async () => "http://127.0.0.1:41000")).resolves.toBe(
      "http://127.0.0.1:41000",
    );
    await expect(resolveBackendUrl(async () => { throw new Error("not in Tauri"); })).resolves.toBe(
      "http://127.0.0.1:45831",
    );
  });
});

describe("backend readiness", () => {
  it("retries health checks until the Tauri-started backend is ready", async () => {
    let attempts = 0;
    const health = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("backend is still starting");
      return { status: "ok", version: "0.1.0" };
    });

    await expect(waitForBackend(health, { attempts: 3, delayMs: 0 })).resolves.toEqual({
      status: "ok",
      version: "0.1.0",
    });
    expect(health).toHaveBeenCalledTimes(3);
  });

  it("stops after a bounded number of failed health checks", async () => {
    const health = vi.fn(async () => {
      throw new Error("backend unavailable");
    });

    await expect(waitForBackend(health, { attempts: 2, delayMs: 0 })).rejects.toThrow("backend unavailable");
    expect(health).toHaveBeenCalledTimes(2);
  });
});

describe("configuration payloads", () => {
  it("keeps a blank API key blank and only clears it with an explicit flag", () => {
    expect(buildConfigUpdate(config, "")).toMatchObject({ clear_api_key: false, model: { api_key: "" } });
    expect(buildConfigUpdate(config, "", true)).toMatchObject({ clear_api_key: true, model: { api_key: "" } });
  });

  it("never turns a redacted response into a visible API key", () => {
    const form = sanitizeConfigForForm({ ...config, model: { ...config.model, api_key: "unexpected" } });

    expect(form.model.api_key).toBe("");
    expect(form.model.api_key_configured).toBe(true);
  });

  it("keeps timeout and retry settings in the configuration payload", () => {
    expect(buildConfigUpdate(config, "").model).toMatchObject({ timeout: 60, retry_count: 2 });
  });

  it("builds a model test payload from the draft without sending the redacted flag", () => {
    expect(buildModelTestUpdate(config, "draft-key")).toEqual({
      model: {
        base_url: "https://api.openai.com/v1",
        api_key: "draft-key",
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: null,
        timeout: 60,
        retry_count: 2,
      },
      clear_api_key: false,
    });
  });
});

describe("model connection test", () => {
  it("posts a model test request without using the chat endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", model: "gpt-4o-mini" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(createApiClient("http://127.0.0.1:45831").testModel(config, "draft-key")).resolves.toEqual({
      status: "ok",
      model: "gpt-4o-mini",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:45831/api/model/test",
      expect.objectContaining({
        body: JSON.stringify({
          model: {
            base_url: "https://api.openai.com/v1",
            api_key: "draft-key",
            model: "gpt-4o-mini",
            temperature: 0.2,
            max_tokens: null,
            timeout: 60,
            retry_count: 2,
          },
          clear_api_key: false,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });
});

describe("SSE stream parsing", () => {
  it("parses typed JSON events without losing unicode text", () => {
    expect(parseSseBlock('event: content_delta\ndata: {"type":"content_delta","content":"你好"}')).toEqual({
      type: "content_delta",
      content: "你好",
    });
  });

  it("falls back to the event name for a non-JSON data frame", () => {
    expect(parseSseBlock("event: error\ndata: backend unavailable")).toEqual({
      type: "error",
      message: "backend unavailable",
    });
  });

  it("consumes events across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('event: content_delta\ndata: {"type":"content_delta","content":"你'),
      encoder.encode('好"}\n\nevent: done\ndata: {"type":"done","content":"你好"}\n\n'),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const events: string[] = [];

    await createApiClient("http://127.0.0.1:45831").streamChat(
      [{ role: "user", content: "hello" }],
      (event) => events.push(`${event.type}:${String(event.content || "")}`),
      undefined,
      "conversation-1",
    );

    expect(events).toEqual(["content_delta:你好", "done:你好"]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:45831/api/chat/stream",
      expect.objectContaining({
        body: JSON.stringify({
          conversation_id: "conversation-1",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("loads persisted conversation history by conversation id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            conversation_id: "conversation-1",
            messages: [{ role: "user", content: "之前的问题" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(createApiClient("http://127.0.0.1:45831").getConversation("conversation-1")).resolves.toEqual({
      conversation_id: "conversation-1",
      messages: [{ role: "user", content: "之前的问题" }],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:45831/api/conversations/conversation-1",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
    vi.unstubAllGlobals();
  });

  it("loads persisted conversation summaries for the sidebar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            conversations: [{
              conversation_id: "conversation-1",
              title: "之前的问题",
              updated_at: "2026-09-29 10:00:00",
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(createApiClient("http://127.0.0.1:45831").getConversations()).resolves.toEqual({
      conversations: [{
        conversation_id: "conversation-1",
        title: "之前的问题",
        updated_at: "2026-09-29 10:00:00",
      }],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:45831/api/conversations",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
    vi.unstubAllGlobals();
  });

  it("rejects a stream that ends before a done event", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: content_delta\ndata: {"type":"content_delta","content":"部分回答"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    await expect(
      createApiClient("http://127.0.0.1:45831").streamChat(
        [{ role: "user", content: "hello" }],
        () => undefined,
      ),
    ).rejects.toThrow("流式回答未完成");
    vi.unstubAllGlobals();
  });
});
