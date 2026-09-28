import { describe, expect, it } from "vitest";
import { buildConfigUpdate, resolveBackendUrl, sanitizeConfigForForm } from "./api";
import type { AppConfig } from "./types";

const config: AppConfig = {
  model: {
    base_url: "https://api.openai.com/v1",
    api_key: "",
    api_key_configured: true,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: null,
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
});
