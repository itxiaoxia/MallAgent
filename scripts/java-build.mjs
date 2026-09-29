import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);
const JAVA_RUNTIME_MODULES = "ALL-MODULE-PATH";

function portablePath(...parts) {
  return path.join(...parts).replaceAll(path.sep, "/");
}

function normalizePortablePath(value) {
  return path.normalize(value).replaceAll(path.sep, "/");
}

function assertSupportedPlatform(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("Java desktop packaging is supported only on Windows or macOS.");
  }
}

export function javaExecutablePath(javaHome, platform = process.platform) {
  return portablePath(javaHome, "bin", platform === "win32" ? "java.exe" : "java");
}

export function jlinkExecutablePath(javaHome, platform = process.platform) {
  return portablePath(javaHome, "bin", platform === "win32" ? "jlink.exe" : "jlink");
}

function findExecutableOnPath(name, platform, env = process.env, exists = fs.existsSync) {
  const pathValue = platform === "win32" ? env.Path || env.PATH : env.PATH;
  if (!pathValue) return undefined;
  const executableName = platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const separator = platform === "win32" ? ";" : ":";
  return pathValue
    .split(separator)
    .filter(Boolean)
    .map((directory) => portablePath(directory, executableName))
    .find((candidate) => exists(candidate));
}

export function resolveJavaHome(
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  findJava = () => findExecutableOnPath("java", platform, env, exists),
) {
  assertSupportedPlatform(platform);
  const overrides = [env.MALLAGENT_JAVA_HOME, env.JAVA_HOME]
    .map((value) => value?.trim())
    .filter(Boolean);
  for (const candidate of overrides) {
    const normalized = normalizePortablePath(candidate);
    if (exists(javaExecutablePath(normalized, platform)) && exists(jlinkExecutablePath(normalized, platform))) {
      return normalized;
    }
    if (candidate === env.MALLAGENT_JAVA_HOME) {
      throw new Error(`MALLAGENT_JAVA_HOME does not contain a Java 17 JDK: ${candidate}`);
    }
    throw new Error(`JAVA_HOME does not contain a Java 17 JDK: ${candidate}`);
  }

  const javaPath = findJava();
  if (javaPath) {
    const javaHome = normalizePortablePath(path.dirname(path.dirname(javaPath)));
    if (exists(jlinkExecutablePath(javaHome, platform))) return javaHome;
  }
  throw new Error("Java 17 JDK with java and jlink is required. Set MALLAGENT_JAVA_HOME or JAVA_HOME.");
}

export function getMavenWrapperCommand(mallSystemRoot, platform = process.platform) {
  assertSupportedPlatform(platform);
  return {
    program: portablePath(mallSystemRoot, platform === "win32" ? "mvnw.cmd" : "mvnw"),
    args: ["-DskipTests", "package"],
  };
}

export function getJavaBuildConfig(root = process.cwd(), platform = process.platform, env = process.env) {
  assertSupportedPlatform(platform);
  const mallSystemRoot = normalizePortablePath(
    env.MALLAGENT_MALL_SYSTEM_ROOT?.trim() || portablePath(root, "..", "MallSystem"),
  );
  const resourceRoot = portablePath(root, "src-tauri", "resources");
  const maven = getMavenWrapperCommand(mallSystemRoot, platform);
  return {
    root: normalizePortablePath(root),
    platform,
    mallSystemRoot,
    mavenWrapperPath: maven.program,
    mavenArgs: maven.args,
    resourceRootPath: resourceRoot,
    jarResourcePath: portablePath(resourceRoot, "java", "mall-system.jar"),
    runtimeResourcePath: portablePath(root, "src-tauri", "resources", "java-runtime"),
    runtimeJavaPath: portablePath(
      root,
      "src-tauri",
      "resources",
      "java-runtime",
      "bin",
      platform === "win32" ? "javaw.exe" : "java",
    ),
  };
}

function runCommand(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
    shell: options.shell || false,
    windowsVerbatimArguments: Boolean(options.windowsVerbatimArguments),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function javaMajorVersion(output) {
  const match = String(output).match(/version\s+["'](\d+)/i) || String(output).match(/^(\d+)/m);
  return match ? Number(match[1]) : undefined;
}

export function validateJavaToolchain(javaHome, platform = process.platform, runner = runCommand) {
  const java = javaExecutablePath(javaHome, platform);
  const javaResult = runner(java, ["-version"], { stdio: "pipe" });
  const javaOutput = `${javaResult.stdout || ""}\n${javaResult.stderr || ""}`;
  if (javaMajorVersion(javaOutput) !== 17) {
    throw new Error(`Java 17 is required, but ${java} reported ${javaOutput.trim() || "an unknown version"}.`);
  }

  const jlink = jlinkExecutablePath(javaHome, platform);
  const jlinkResult = runner(jlink, ["--version"], { stdio: "pipe" });
  const jlinkOutput = `${jlinkResult.stdout || ""}\n${jlinkResult.stderr || ""}`;
  if (javaMajorVersion(jlinkOutput) !== 17) {
    throw new Error(`jlink 17 is required, but ${jlink} reported ${jlinkOutput.trim() || "an unknown version"}.`);
  }
  return { java, jlink };
}

function runMavenWrapper(config, platform, env, runner = runCommand) {
  const wrapper = getMavenWrapperCommand(config.mallSystemRoot, platform);
  if (platform === "win32") {
    const command = `""${wrapper.program.replaceAll('"', '""')}" ${wrapper.args.join(" ")}"`;
    runner(env.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: config.mallSystemRoot,
      env,
      windowsVerbatimArguments: true,
    });
    return;
  }
  runner(wrapper.program, wrapper.args, {
    cwd: config.mallSystemRoot,
    env,
  });
}

function selectMallSystemJar(mallSystemRoot) {
  const targetDirectory = path.join(mallSystemRoot, "target");
  if (!fs.existsSync(targetDirectory)) {
    throw new Error(`MallSystem Maven target directory was not produced: ${targetDirectory}`);
  }
  const jars = fs.readdirSync(targetDirectory)
    .filter((name) => name.startsWith("mall-system-") && name.endsWith(".jar"))
    .filter((name) => !name.endsWith(".original") && !name.endsWith("-plain.jar"))
    .sort();
  if (jars.length === 0) {
    throw new Error(`MallSystem executable JAR was not produced in ${targetDirectory}.`);
  }
  return path.join(targetDirectory, jars[0]);
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

export function prepareJavaRuntime(config, javaHome, runner = runCommand) {
  const { jlink } = validateJavaToolchain(javaHome, config.platform, runner);
  const runtimePath = path.normalize(config.runtimeResourcePath);
  fs.rmSync(runtimePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  runner(
    jlink,
    [
      "--module-path",
      path.normalize(path.join(javaHome, "jmods")),
      "--add-modules",
      JAVA_RUNTIME_MODULES,
      "--strip-debug",
      "--no-man-pages",
      "--no-header-files",
      "--compress=2",
      "--output",
      runtimePath,
    ],
    { cwd: config.root },
  );
  const runtimeJava = path.normalize(config.runtimeJavaPath);
  if (!fs.existsSync(runtimeJava)) {
    throw new Error(`jlink did not produce the Java runtime executable: ${config.runtimeJavaPath}`);
  }
  return config.runtimeResourcePath;
}

export function buildJavaArtifacts({
  root = process.cwd(),
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  runner = runCommand,
} = {}) {
  const config = getJavaBuildConfig(root, platform, env);
  const javaHome = resolveJavaHome(platform, env, exists);
  validateJavaToolchain(javaHome, platform, runner);
  runMavenWrapper(config, platform, env, runner);
  const jarSourcePath = selectMallSystemJar(config.mallSystemRoot);
  copyFile(jarSourcePath, path.normalize(config.jarResourcePath));
  prepareJavaRuntime(config, javaHome, runner);
  return { ...config, javaHome, jarSourcePath: normalizePortablePath(jarSourcePath) };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopExactChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (await waitForChildExit(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child);
}

async function waitForJavaHealth(child, port, output) {
  const deadline = Date.now() + 45_000;
  let lastError = "Java MCP did not become ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Java MCP exited before health check with code ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/actuator/health`);
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Java MCP health check timed out: ${lastError}. ${output()}`);
}

async function waitForSeedData(child, port, output) {
  const expected = ["CHIPS-ORIGINAL", "CHOCO-CLASSIC", "COCA-330ML", "ORANGE-500ML", "WATER-550ML"];
  const deadline = Date.now() + 45_000;
  let lastCodes = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Java MCP exited before seed verification with code ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/products?page=0&size=100`);
      if (response.ok) {
        const payload = await response.json();
        lastCodes = payload?.data?.items?.map((product) => product.productCode).sort() || [];
        if (JSON.stringify(lastCodes) === JSON.stringify(expected)) return lastCodes;
      }
    } catch {
      // The web server may be ready while the ApplicationRunner is still seeding.
    }
    await delay(250);
  }
  throw new Error(`Java MCP seed data is invalid: ${JSON.stringify(lastCodes)}. ${output()}`);
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      if (!fs.existsSync(directory)) return;
      lastError = new Error(`Temporary Java smoke directory still exists: ${directory}`);
    } catch (error) {
      lastError = error;
      if (!error || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
    }
    await delay(250 * (attempt + 1));
  }
  throw lastError;
}

export async function verifyPackagedJavaServer(config) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mallagent-java-smoke-"));
  const databasePath = path.join(temporaryDirectory, "config.db");
  const port = await availablePort();
  let stdout = "";
  let stderr = "";
  const child = spawn(
    path.normalize(config.runtimeJavaPath),
    ["-jar", "java/mall-system.jar", "--server.address=127.0.0.1", `--server.port=${port}`],
    {
      cwd: path.normalize(config.resourceRootPath),
      env: {
        ...process.env,
        MALLAGENT_CONFIG_PATH: databasePath,
        MALLSYSTEM_DB_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    const output = () => `${stdout}\n${stderr}`.trim().slice(-4000);
    await waitForJavaHealth(child, port, output);
    const codes = await waitForSeedData(child, port, output);
    return { port, productCodes: codes };
  } finally {
    await stopExactChild(child);
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const artifacts = buildJavaArtifacts();
    console.log(`Java MCP artifacts ready: ${artifacts.jarResourcePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
