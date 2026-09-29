import { describe, expect, it } from "vitest";
import { autoConnectModel } from "./model";
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
  default_prompt: "",
  mcp_servers: [],
};

describe("startup model connection", () => {
  it("reports a configured model as connected after the background probe", async () => {
    let receivedKey = "not-called";
    let receivedClearFlag = true;

    const result = await autoConnectModel(config, async (_config, apiKey, clearApiKey) => {
      receivedKey = apiKey;
      receivedClearFlag = clearApiKey;
      return { status: "ok", model: "gpt-4o-mini" };
    });

    expect(result).toEqual({ status: "success", message: "连接成功 · gpt-4o-mini" });
    expect(receivedKey).toBe("");
    expect(receivedClearFlag).toBe(false);
  });

  it("reports a failed startup probe without rejecting the app startup", async () => {
    const result = await autoConnectModel(config, async () => {
      throw new Error("provider unavailable");
    });

    expect(result).toEqual({ status: "error", message: "连接失败：provider unavailable" });
  });
});
