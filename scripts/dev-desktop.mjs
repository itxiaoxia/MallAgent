import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildJavaArtifacts, verifyPackagedJavaServer } from "./java-build.mjs";

export async function prepareJavaForDev(root = process.cwd(), platform = process.platform) {
  const artifacts = buildJavaArtifacts({ root, platform });
  await verifyPackagedJavaServer(artifacts);
  return artifacts;
}

export function getViteDevInvocation(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return {
      program: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd run dev"],
      windowsVerbatimArguments: true,
    };
  }

  return {
    program: "npm",
    args: ["run", "dev"],
    windowsVerbatimArguments: false,
  };
}

export function runViteDev(root = process.cwd(), platform = process.platform) {
  const invocation = getViteDevInvocation(platform);
  const child = spawn(invocation.program, invocation.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

export async function main(root = process.cwd(), platform = process.platform) {
  await prepareJavaForDev(root, platform);
  const exitCode = await runViteDev(root, platform);
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
