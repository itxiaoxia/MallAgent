import type { AppConfig, ModelTestResponse } from "./types";

export type ModelConnectionStatus = "idle" | "testing" | "success" | "error";

export interface ModelConnectionState {
  status: ModelConnectionStatus;
  message: string;
}

type ModelTestRunner = (
  config: AppConfig,
  apiKey: string,
  clearApiKey: boolean,
) => Promise<ModelTestResponse>;

export async function autoConnectModel(
  config: AppConfig,
  testModel: ModelTestRunner,
): Promise<ModelConnectionState> {
  try {
    const response = await testModel(config, "", false);
    return { status: "success", message: `连接成功 · ${response.model}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型连接失败，请检查配置。";
    return { status: "error", message: `连接失败：${message}` };
  }
}
