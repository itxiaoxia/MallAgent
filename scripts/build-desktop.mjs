import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);

function portablePath(...parts) {
  return path.join(...parts).replaceAll(path.sep, "/");
}

export function getPlatformConfig(platform = process.platform, root = process.cwd()) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("Desktop packaging is supported only on Windows or macOS.");
  }

  const windows = platform === "win32";
  const backendFilename = windows ? "mallagent-backend.exe" : "mallagent-backend";
  return {
    id: windows ? "windows" : "macos",
    platform,
    backendFilename,
    tauriArgs: windows ? ["build", "--no-bundle"] : ["build", "--bundles", "app"],
    backendResourcePath: portablePath(root, "src-tauri", "resources", "backend", backendFilename),
    backendResourceDirectoryPath: portablePath(root, "src-tauri", "resources", "backend"),
    tauriBinaryPath: portablePath(root, "src-tauri", "target", "release", windows ? "mallagent.exe" : "mallagent"),
    portableExecutablePath: windows ? portablePath(root, "release", "windows", "MallAgent.exe") : undefined,
    appPath: windows ? undefined : portablePath(root, "release", "macos", "MallAgent.app"),
  };
}

export function backendOutputPath(root, platform = process.platform) {
  return getPlatformConfig(platform, root).backendResourcePath;
}

export function resolvePythonInvocation(root, platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("Desktop packaging is supported only on Windows or macOS.");
  }
  const override = env.MALLAGENT_PYTHON?.trim();
  if (override) {
    return { program: override, args: [] };
  }

  const candidates = platform === "win32"
    ? [portablePath(root, ".venv", "Scripts", "python.exe")]
    : [portablePath(root, ".venv", "bin", "python3.11"), portablePath(root, ".venv", "bin", "python")];
  const selected = candidates.find((candidate) => exists(candidate));
  if (selected) {
    return { program: selected, args: [] };
  }

  if (platform === "win32") return { program: "py", args: ["-3.11"] };
  if (platform === "darwin") return { program: "python3.11", args: [] };
  throw new Error("Desktop packaging is supported only on Windows or macOS.");
}

export function buildBackendCommand(root, target, python) {
  return {
    program: python.program,
    args: [
      ...python.args,
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onefile",
      "--console",
      "--name",
      "mallagent-backend",
      "--distpath",
      target.backendResourceDirectoryPath,
      "--workpath",
      portablePath(root, "backend", "build"),
      "--specpath",
      portablePath(root, "backend", "build-spec"),
      "--copy-metadata",
      "fastmcp-slim",
      "--paths",
      portablePath(root, "backend"),
      portablePath(root, "backend", "entrypoint.py"),
    ],
    cwd: root,
  };
}

export function lockedOutputError(outputPath) {
  return `Generated backend output is locked: ${outputPath}. Please close the MallAgent process or any process using this file before rebuilding.`;
}

function nativePath(value) {
  return path.normalize(value);
}

function runCommand(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function runPython(python, args, root, options = {}) {
  return runCommand(python.program, [...python.args, ...args], {
    ...options,
    cwd: root,
  });
}

function validatePython311(python, root) {
  const result = runPython(
    python,
    ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    root,
    { stdio: "pipe" },
  );
  const version = String(result.stdout || "").trim();
  if (version !== "3.11") {
    throw new Error(`Python 3.11 is required for packaging, but the selected interpreter reports ${version || "an unknown version"}.`);
  }
}

function assertWritableOutput(outputPath) {
  const actualPath = nativePath(outputPath);
  if (!fs.existsSync(actualPath)) return;
  let descriptor;
  try {
    descriptor = fs.openSync(actualPath, "r+");
  } catch (error) {
    if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
      throw new Error(lockedOutputError(outputPath));
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function buildBackend(root, target, python) {
  const outputPath = nativePath(target.backendResourcePath);
  fs.mkdirSync(nativePath(target.backendResourceDirectoryPath), { recursive: true });
  assertWritableOutput(outputPath);
  runPython(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", nativePath(path.join(root, "backend", "requirements.txt"))], root);
  runPython(python, ["-m", "pip", "check"], root);
  const command = buildBackendCommand(root, target, python);
  runCommand(command.program, command.args.map(nativePathIfPathArgument), { cwd: root });
  if (!fs.existsSync(outputPath)) {
    throw new Error(`PyInstaller did not produce ${target.backendResourcePath}.`);
  }
  return outputPath;
}

function nativePathIfPathArgument(value, index, values) {
  if (index === values.indexOf("--distpath") + 1 || index === values.indexOf("--workpath") + 1 || index === values.indexOf("--specpath") + 1 || index === values.indexOf("--paths") + 1 || index === values.length - 1) {
    return nativePath(value);
  }
  return value;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function listeningProcessId(port) {
  if (process.platform === "win32") {
    const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return undefined;
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns[0] !== "TCP" || columns[3] !== "LISTENING") continue;
      if (!columns[1].endsWith(`:${port}`)) continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return undefined;
  }

  if (process.platform === "darwin") {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    const pid = Number(String(result.stdout || "").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  return undefined;
}

function terminateExactProcess(pid) {
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
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

async function stopChild(child, port) {
  const processIds = new Set([child.pid, listeningProcessId(port)]);
  for (const pid of processIds) {
    if (!pid) continue;
    try {
      // These are the exact PID(s) started or discovered for this smoke test;
      // there is no name-based process termination.
      terminateExactProcess(pid);
    } catch {
      if (pid === child.pid) child.kill();
    }
  }

  if (await waitForChildExit(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child);
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      if (!fs.existsSync(directory)) return;
      lastError = new Error(`Temporary packaging directory still exists: ${directory}`);
      await delay(250 * (attempt + 1));
    } catch (error) {
      lastError = error;
      if (!error || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function waitForHealth(child, port) {
  const deadline = Date.now() + 30_000;
  let lastError = "backend did not become ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged backend exited before health check with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Packaged backend health check timed out: ${lastError}.`);
}

export async function verifyPackagedBackend(root, target, python) {
  const executable = nativePath(target.backendResourcePath);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mallagent-packaged-"));
  const databasePath = path.join(temporaryDirectory, "config.db");
  const port = await availablePort();
  const child = spawn(executable, ["--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, MALLAGENT_CONFIG_PATH: databasePath, PYTHONUNBUFFERED: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForHealth(child, port);
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    if (!response.ok) throw new Error(`Packaged backend /api/config returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (!payload?.model || payload.model.api_key !== "") {
      throw new Error("Packaged backend returned an invalid redacted configuration.");
    }
    runPython(
      python,
      [
        "-c",
        "import sqlite3, sys; connection = sqlite3.connect(sys.argv[1]); row = connection.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='app_config'\").fetchone(); connection.close(); assert row is not None, \"app_config table missing\"; print(\"app_config table verified\")",
        databasePath,
      ],
      root,
    );
    return payload;
  } finally {
    await stopChild(child, port);
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

function runNpmCommand(root, platform, args) {
  if (platform === "win32") {
    const command = ["npm.cmd", ...args].join(" ");
    runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { cwd: root });
    return;
  }
  runCommand("npm", args, { cwd: root });
}

function runTauriBuild(root, target) {
  runNpmCommand(root, target.platform, ["run", "build"]);
  runNpmCommand(root, target.platform, ["run", "tauri", "--", ...target.tauriArgs]);
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(source, destination);
  } catch (error) {
    if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
      throw new Error(lockedOutputError(destination));
    }
    throw error;
  }
}

function stageWindows(root, target) {
  const sourceBinary = nativePath(target.tauriBinaryPath);
  const stagedBinary = nativePath(target.portableExecutablePath);
  if (!fs.existsSync(sourceBinary)) throw new Error(`Tauri did not produce ${target.tauriBinaryPath}.`);
  copyFile(sourceBinary, stagedBinary);
  copyFile(nativePath(target.backendResourcePath), nativePath(path.join(root, "release", "windows", "backend", target.backendFilename)));
}

function stageMacos(root, target) {
  const sourceApp = nativePath(path.join(root, "src-tauri", "target", "release", "bundle", "macos", "MallAgent.app"));
  if (!fs.existsSync(sourceApp)) throw new Error(`Tauri did not produce ${portablePath(root, "src-tauri", "target", "release", "bundle", "macos", "MallAgent.app")}.`);
  fs.mkdirSync(path.dirname(nativePath(target.appPath)), { recursive: true });
  fs.cpSync(sourceApp, nativePath(target.appPath), { recursive: true, force: true });
}

export async function main(argv = process.argv.slice(2), platform = process.platform, root = process.cwd()) {
  const target = getPlatformConfig(platform, root);
  const python = resolvePythonInvocation(root, platform);
  validatePython311(python, root);
  const backendOnly = argv.includes("--backend-only");
  buildBackend(root, target, python);
  await verifyPackagedBackend(root, target, python);
  if (backendOnly) return;
  runTauriBuild(root, target);
  if (target.id === "windows") stageWindows(root, target);
  else stageMacos(root, target);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
