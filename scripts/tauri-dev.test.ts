import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDevResourceDirectory,
  getDevPaths,
  getTauriDevInvocation,
  getTauriBindingPackage,
} from "./tauri-dev.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Tauri development bootstrap", () => {
  it("uses the Windows virtualenv, resource directory, CLI, and binding paths", () => {
    const paths = getDevPaths("win32", "C:/MallAgent");

    expect(paths.pythonPath).toBe("C:/MallAgent/.venv/Scripts/python.exe");
    expect(paths.resourceDirectory).toBe("C:/MallAgent/src-tauri/resources/backend");
    expect(paths.tauriCliPath).toBe("C:/MallAgent/node_modules/.bin/tauri.cmd");
    expect(getTauriBindingPackage("win32", "x64")).toBe("@tauri-apps/cli-win32-x64-msvc");
  });

  it("uses the macOS virtualenv, resource directory, CLI, and binding paths", () => {
    const paths = getDevPaths("darwin", "/Users/dev/MallAgent");

    expect(paths.pythonPath).toBe("/Users/dev/MallAgent/.venv/bin/python");
    expect(paths.resourceDirectory).toBe("/Users/dev/MallAgent/src-tauri/resources/backend");
    expect(paths.tauriCliPath).toBe("/Users/dev/MallAgent/node_modules/.bin/tauri");
    expect(getTauriBindingPackage("darwin", "arm64")).toBe("@tauri-apps/cli-darwin-arm64");
  });

  it("creates the resource directory required by Tauri before dev compilation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mallagent-tauri-dev-test-"));
    temporaryDirectories.push(root);

    const resourceDirectory = ensureDevResourceDirectory(root);

    expect(resourceDirectory).toBe(path.join(root, "src-tauri", "resources", "backend"));
    expect(fs.statSync(resourceDirectory).isDirectory()).toBe(true);
  });

  it("routes the package script through the cross-platform bootstrap", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["tauri:dev"]).toBe("node scripts/tauri-dev.mjs");
  });

  it("hides the Windows Tauri dev process and avoids a second shell", () => {
    expect(getTauriDevInvocation("win32", { ComSpec: "C:/Windows/System32/cmd.exe" })).toEqual({
      program: "C:/Windows/System32/cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd run tauri -- dev"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });
});
