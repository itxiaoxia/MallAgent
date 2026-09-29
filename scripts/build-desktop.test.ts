import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertFreshOutputDirectory,
  backendOutputPath,
  buildBackendCommand,
  createBuildId,
  getPlatformConfig,
  getTauriBuildEnvironment,
  lockedOutputError,
  resolvePythonInvocation,
} from "./build-desktop.mjs";

const root = "C:/MallAgent";

describe("desktop packaging targets", () => {
  it("creates a versioned build id and skips an existing package", () => {
    const existingOutput = `${root}/MallAgent-windows-v0.1.0-20260929-123456`;
    const buildId = createBuildId(root, "win32", {
      now: new Date("2026-09-29T12:34:56Z"),
      version: "0.1.0",
      exists: (candidate) => candidate === existingOutput,
    });

    expect(buildId).toBe("v0.1.0-20260929-123456-2");
  });

  it("uses an isolated Cargo target and versioned package directory", () => {
    const buildId = "v0.1.0-20260929-123456";
    const target = getPlatformConfig("win32", root, { buildId });

    expect(target.outputDirectory).toBe(`${root}/MallAgent-windows-${buildId}`);
    expect(target.cargoTargetDirectory).toBe(`${root}/src-tauri/target/build-windows-${buildId}`);
    expect(target.tauriBinaryPath).toBe(`${root}/src-tauri/target/build-windows-${buildId}/release/mallagent.exe`);
    expect(getTauriBuildEnvironment(target, { EXISTING_VALUE: "preserved" })).toEqual({
      EXISTING_VALUE: "preserved",
      CARGO_TARGET_DIR: `${root}/src-tauri/target/build-windows-${buildId}`,
    });
  });

  it("refuses to overwrite an existing package directory", () => {
    expect(() => assertFreshOutputDirectory(`${root}/MallAgent-windows-old`, () => true))
      .toThrow(/Refusing to overwrite existing package output/);
  });

  it("describes a Windows portable executable and backend resource", () => {
    const target = getPlatformConfig("win32", root);

    expect(target.id).toBe("windows");
    expect(target.backendFilename).toBe("mallagent-backend.exe");
    expect(target.tauriArgs).toEqual(["build", "--no-bundle"]);
    expect(target.outputDirectory).toBe(`${root}/MallAgent-windows`);
    expect(target.portableExecutablePath).toBe(`${root}/MallAgent-windows/MallAgent.exe`);
    expect(backendOutputPath(root, "win32")).toBe(`${root}/src-tauri/resources/backend/mallagent-backend.exe`);
    expect(target.javaJarResourcePath).toBe(`${root}/src-tauri/resources/java/mall-system.jar`);
    expect(target.javaRuntimeResourcePath).toBe(`${root}/src-tauri/resources/java-runtime`);
    expect(target.backendStagingPath).toBe(`${root}/MallAgent-windows/backend/mallagent-backend.exe`);
    expect(target.javaJarStagingPath).toBe(`${root}/MallAgent-windows/java/mall-system.jar`);
    expect(target.javaRuntimeStagingPath).toBe(`${root}/MallAgent-windows/java-runtime`);
  });

  it("describes a macOS app bundle and host-native backend resource", () => {
    const target = getPlatformConfig("darwin", root);

    expect(target.id).toBe("macos");
    expect(target.backendFilename).toBe("mallagent-backend");
    expect(target.tauriArgs).toEqual(["build", "--bundles", "app"]);
    expect(target.outputDirectory).toBe(`${root}/MallAgent-macos`);
    expect(target.appPath).toBe(`${root}/MallAgent-macos/MallAgent.app`);
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
    expect(command.args).toContain("--noconsole");
    expect(command.args).not.toContain("--console");
    expect(command.args).toEqual([
      ...invocation.args,
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onefile",
      "--noconsole",
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

  it("marks the release Windows launcher as a GUI executable", () => {
    const source = readFileSync("src-tauri/src/main.rs", "utf8");

    expect(source).toMatch(/#!\[cfg_attr\(\s*target_os = "windows",\s*windows_subsystem = "windows"\s*\)\]/);
  });

  it("reports a locked generated backend without suggesting process termination", () => {
    const message = lockedOutputError(`${root}/src-tauri/resources/backend/mallagent-backend.exe`);

    expect(message).toContain("locked");
    expect(message).toContain("close the MallAgent process");
    expect(message).not.toContain("kill");
  });

  it("keeps the Windows wrapper on the shared Node orchestrator", () => {
    const wrapper = readFileSync("build.bat", "utf8");

    expect(wrapper).toContain("build-desktop.mjs");
    expect(wrapper).toContain("Windows_NT");
    expect(wrapper).toContain("where node");
    expect(wrapper.toLowerCase()).not.toContain("python");
  });

  it("keeps the macOS wrapper on the shared Node orchestrator", () => {
    const wrapper = readFileSync("build.sh", "utf8");

    expect(wrapper).toContain("build-desktop.mjs");
    expect(wrapper).toContain("Darwin");
    expect(wrapper).toContain("command -v node");
    expect(wrapper.toLowerCase()).not.toContain("python");
  });

  it("uses the shared orchestrator and directory resource in package configuration", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

    expect(packageJson.scripts["tauri:build"]).toBe("node scripts/build-desktop.mjs");
    expect(packageJson.scripts["build:backend"]).toBe("node scripts/build-desktop.mjs --backend-only");
    expect(packageJson.scripts["build:windows"]).toBe("build.bat");
    expect(packageJson.scripts["build:macos"]).toBe("sh ./build.sh");
    expect(tauriConfig.bundle.resources).toEqual({
      "resources/backend/": "backend/",
      "resources/java/": "java/",
      "resources/java-runtime/": "java-runtime/",
    });
  });
});
