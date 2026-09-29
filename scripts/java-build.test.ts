import { describe, expect, it } from "vitest";
import {
  getJavaBuildConfig,
  getMavenWrapperCommand,
  javaExecutablePath,
  jlinkExecutablePath,
  resolveJavaHome,
} from "./java-build.mjs";

const root = "C:/MallAgent";

describe("Java build configuration", () => {
  it("uses the sibling MallSystem project and current Tauri resource layout by default", () => {
    const config = getJavaBuildConfig(root, "win32", {});

    expect(config.mallSystemRoot).toBe("C:/MallSystem");
    expect(config.mavenWrapperPath).toBe("C:/MallSystem/mvnw.cmd");
    expect(config.jarResourcePath).toBe("C:/MallAgent/src-tauri/resources/java/mall-system.jar");
    expect(config.runtimeResourcePath).toBe("C:/MallAgent/src-tauri/resources/java-runtime");
    expect(config.runtimeJavaPath).toBe("C:/MallAgent/src-tauri/resources/java-runtime/bin/javaw.exe");
  });

  it("honors the MallSystem root override", () => {
    const config = getJavaBuildConfig(root, "darwin", {
      MALLAGENT_MALL_SYSTEM_ROOT: "D:/work/MallSystem",
    });

    expect(config.mallSystemRoot).toBe("D:/work/MallSystem");
    expect(config.mavenWrapperPath).toBe("D:/work/MallSystem/mvnw");
    expect(config.runtimeJavaPath).toBe("C:/MallAgent/src-tauri/resources/java-runtime/bin/java");
  });

  it("selects the platform Maven wrapper command", () => {
    expect(getMavenWrapperCommand("C:/MallSystem", "win32")).toEqual({
      program: "C:/MallSystem/mvnw.cmd",
      args: ["-DskipTests", "package"],
    });
    expect(getMavenWrapperCommand("/work/MallSystem", "darwin")).toEqual({
      program: "/work/MallSystem/mvnw",
      args: ["-DskipTests", "package"],
    });
  });

  it("prefers MALLAGENT_JAVA_HOME and resolves Java and jlink inside the JDK", () => {
    const exists = (candidate: string) => candidate.endsWith("/bin/java.exe") || candidate.endsWith("/bin/jlink.exe");

    const javaHome = resolveJavaHome(
      "win32",
      { MALLAGENT_JAVA_HOME: "C:/Jdk17", JAVA_HOME: "C:/OtherJdk" },
      exists,
      () => undefined,
    );

    expect(javaHome).toBe("C:/Jdk17");
    expect(javaExecutablePath(javaHome, "win32")).toBe("C:/Jdk17/bin/java.exe");
    expect(jlinkExecutablePath(javaHome, "win32")).toBe("C:/Jdk17/bin/jlink.exe");
  });
});
