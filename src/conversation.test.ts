import { describe, expect, it } from "vitest";
import { getConversationTitle, loadConversationId, newConversationId, rememberConversationId } from "./conversation";

describe("conversation identity", () => {
  it("creates and persists an id when the client has no current conversation", () => {
    window.localStorage.clear();

    const id = loadConversationId(window.localStorage);

    expect(id).toMatch(/^conversation-/);
    expect(window.localStorage.getItem("mallagent.conversation_id")).toBe(id);
  });

  it("reuses the stored id and can isolate a new conversation", () => {
    window.localStorage.setItem("mallagent.conversation_id", "conversation-existing");

    expect(loadConversationId(window.localStorage)).toBe("conversation-existing");
    const nextId = newConversationId(window.localStorage);
    expect(nextId).not.toBe("conversation-existing");
    expect(window.localStorage.getItem("mallagent.conversation_id")).toBe(nextId);
  });

  it("persists a selected conversation id", () => {
    window.localStorage.clear();

    expect(rememberConversationId(window.localStorage, "conversation-selected")).toBe("conversation-selected");
    expect(window.localStorage.getItem("mallagent.conversation_id")).toBe("conversation-selected");
  });
});

describe("conversation titles", () => {
  it("uses the first user message as the session title", () => {
    expect(getConversationTitle([
      { role: "assistant", content: "欢迎回来" },
      { role: "user", content: "  查询商品  " },
      { role: "assistant", content: "好的" },
      { role: "user", content: "查看订单" },
    ])).toBe("查询商品");
  });

  it("falls back to a new-session title when there is no user message", () => {
    expect(getConversationTitle([])).toBe("新会话");
  });
});
