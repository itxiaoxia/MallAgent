import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  backendOutputPath,
  buildBackendCommand,
  getPlatformConfig,
  lockedOutputError,
  resolvePythonInvocation,
} from "./build-desktop.mjs";

const root = "C:/MallAgent";

describe("desktop packaging targets", () => {
  it("describes a Windows portable executable and backend resource", () => {
    const target = getPlatformConfig("win32", root);

    expect(target.id).toBe("windows");
    expect(target.backendFilename).toBe("mallagent-backend.exe");
    expect(target.tauriArgs).toEqual(["build", "--no-bundle"]);
    expect(target.portableExecutablePath).toBe(`${root}/release/windows/MallAgent.exe`);
    expect(backendOutputPath(root, "win32")).toBe(`${root}/src-tauri/resources/backend/mallagent-backend.exe`);
  });

  it("describes a macOS app bundle and host-native backend resource", () => {
    const target = getPlatformConfig("darwin", root);

    expect(target.id).toBe("macos");
    expect(target.backendFilename).toBe("mallagent-backend");
    expect(target.tauriArgs).toEqual(["build", "--bundles", "app"]);
    expect(target.appPath).toBe(`${root}/release/macos/MallAgent.app`);
    expect(backendOutputPath(root, "darwin")).toBe(`${root}/src-tauri/resources/backend/mallagent-backend`);
  });

  it("prefers the repository virtualenv over a system fallback", () => {
    const invocation = resolvePythonInvocation(
      root,
      "win32",
      {},
      (candidate) => candidate === `${root}/.venv/Scripts/python.exe`,
    );

    expect(invocation).toEqual({ program: `${root}/.venv/Scripts/python.exe`, args: [] });
  });

  it("accepts an explicit build Python override", () => {
    const invocation = resolvePythonInvocation(root, "darwin", { MALLAGENT_PYTHON: "/opt/python3.11/bin/python3.11" }, () => false);

    expect(invocation).toEqual({ program: "/opt/python3.11/bin/python3.11", args: [] });
  });

  it("rejects unsupported packaging hosts", () => {
    expect(() => getPlatformConfig("linux", root)).toThrow(/Windows or macOS/);
  });

  it("builds a one-file PyInstaller command for the selected backend", () => {
    const target = getPlatformConfig("win32", root);
    const invocation = { program: `${root}/.venv/Scripts/python.exe`, args: [] };

    const command = buildBackendCommand(root, target, invocation);

    expect(command.program).toBe(invocation.program);
    expect(command.args).toEqual([
      ...invocation.args,
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onefile",
      "--console",
      "--name",
      "mallagent-backend",
      "--distpath",
      `${root}/src-tauri/resources/backend`,
      "--workpath",
      `${root}/backend/build`,
      "--specpath",
      `${root}/backend/build-spec`,
      "--copy-metadata",
      "fastmcp-slim",
      "--paths",
      `${root}/backend`,
      `${root}/backend/entrypoint.py`,
    ]);
  });

  it("reports a locked generated backend without suggesting process termination", () => {
    const message = lockedOutputError(`${root}/src-tauri/resources/backend/mallagent-backend.exe`);

    expect(message).toContain("locked");
    expect(message).toContain("close the MallAgent process");
    expect(message).not.toContain("kill");
  });

  it("keeps the Windows wrapper on the shared Node orchestrator", () => {
    const wrapper = readFileSync("scripts/build.bat", "utf8");

    expect(wrapper).toContain("build-desktop.mjs");
    expect(wrapper.toLowerCase()).not.toContain("python");
  });

  it("keeps the macOS wrapper on the shared Node orchestrator", () => {
    const wrapper = readFileSync("scripts/build.sh", "utf8");

    expect(wrapper).toContain("build-desktop.mjs");
    expect(wrapper.toLowerCase()).not.toContain("python");
  });

  it("uses the shared orchestrator and directory resource in package configuration", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

    expect(packageJson.scripts["tauri:build"]).toBe("node scripts/build-desktop.mjs");
    expect(packageJson.scripts["build:backend"]).toBe("node scripts/build-desktop.mjs --backend-only");
    expect(packageJson.scripts["build:windows"]).toBe("scripts\\build.bat");
    expect(packageJson.scripts["build:macos"]).toBe("sh ./scripts/build.sh");
    expect(tauriConfig.bundle.resources).toEqual({ "resources/backend/": "backend/" });
  });
});
