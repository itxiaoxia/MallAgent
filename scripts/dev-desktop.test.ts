import { describe, expect, it } from "vitest";
import { getViteDevInvocation } from "./dev-desktop.mjs";

describe("desktop dev server invocation", () => {
  it("uses cmd.exe for npm.cmd on Windows Node runtimes", () => {
    expect(getViteDevInvocation("win32", { ComSpec: "C:/Windows/System32/cmd.exe" })).toEqual({
      program: "C:/Windows/System32/cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd run dev"],
      windowsVerbatimArguments: true,
    });
  });

  it("uses npm directly on POSIX hosts", () => {
    expect(getViteDevInvocation("darwin", {})).toEqual({
      program: "npm",
      args: ["run", "dev"],
      windowsVerbatimArguments: false,
    });
  });
});
