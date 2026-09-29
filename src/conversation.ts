import type { ChatMessage } from "./types";

export const CONVERSATION_STORAGE_KEY = "mallagent.conversation_id";

export function rememberConversationId(storage: Storage, id: string): string {
  try {
    storage.setItem(CONVERSATION_STORAGE_KEY, id);
  } catch {
    // A storage failure should not prevent selecting an in-memory conversation.
  }
  return id;
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadConversationId(storage: Storage): string {
  try {
    const existing = storage.getItem(CONVERSATION_STORAGE_KEY);
    if (existing) return existing;
    const id = `conversation-${createId()}`;
    rememberConversationId(storage, id);
    return id;
  } catch {
    return `conversation-${createId()}`;
  }
}

export function newConversationId(storage: Storage): string {
  const id = `conversation-${createId()}`;
  return rememberConversationId(storage, id);
}

export function getConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim());
  return firstUserMessage?.content.trim() || "新会话";
}
