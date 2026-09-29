import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);
const BACKEND_RUNTIME_MODULES = [
  "fastapi",
  "uvicorn",
  "pydantic",
  "platformdirs",
  "langchain",
  "langchain.mcp",
  "langchain_openai",
];

function portablePath(...parts) {
  return path.join(...parts).replaceAll(path.sep, "/");
}

export function getTauriBindingPackage(platform, arch) {
  const packages = {
    "darwin-arm64": "@tauri-apps/cli-darwin-arm64",
    "darwin-x64": "@tauri-apps/cli-darwin-x64",
    "win32-arm64": "@tauri-apps/cli-win32-arm64-msvc",
    "win32-ia32": "@tauri-apps/cli-win32-ia32-msvc",
    "win32-x64": "@tauri-apps/cli-win32-x64-msvc",
  };
  return packages[`${platform}-${arch}`];
}

export function getDevPaths(platform = process.platform, root = process.cwd()) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("MallAgent development is supported only on Windows or macOS.");
  }

  const windows = platform === "win32";
  return {
    platform,
    virtualenvDirectory: portablePath(root, ".venv"),
    pythonPath: portablePath(root, ".venv", ...(windows ? ["Scripts", "python.exe"] : ["bin", "python"])),
    resourceDirectory: portablePath(root, "src-tauri", "resources", "backend"),
    requirementsPath: portablePath(root, "backend", "requirements.txt"),
    tauriCliPath: portablePath(root, "node_modules", ".bin", windows ? "tauri.cmd" : "tauri"),
  };
}

export function ensureDevResourceDirectory(root = process.cwd(), platform = process.platform) {
  const resourceDirectory = getDevPaths(platform, root).resourceDirectory;
  fs.mkdirSync(resourceDirectory, { recursive: true });
  return resourceDirectory;
}

function systemPythonInvocation(platform) {
  return platform === "win32"
    ? { program: "py", args: ["-3.11"] }
    : { program: "python3.11", args: [] };
}

function pythonInvocationFromEnvironment(root, platform, env) {
  const override = env.MALLAGENT_PYTHON?.trim();
  if (override) return { program: override, args: [] };

  const paths = getDevPaths(platform, root);
  if (fs.existsSync(paths.pythonPath)) return { program: paths.pythonPath, args: [] };
  return systemPythonInvocation(platform);
}

function commandDescription(program, args) {
  return [program, ...args].join(" ");
}

function runCommand(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: options.shell || false,
    stdio: options.stdio || "inherit",
    windowsHide: false,
  });
  if (result.error) {
    throw new Error(`Failed to run ${commandDescription(program, args)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${commandDescription(program, args)} exited with code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function runPython(python, args, root, options = {}) {
  return runCommand(python.program, [...python.args, ...args], {
    ...options,
    cwd: root,
  });
}

function checkPythonVersion(python, root) {
  const result = spawnSync(
    python.program,
    [...python.args, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  if (result.error) {
    throw new Error(
      `Python 3.11 is required for MallAgent development. Could not run ${commandDescription(python.program, python.args)}: ${result.error.message}`,
    );
  }
  const version = String(result.stdout || "").trim();
  if (result.status !== 0 || version !== "3.11") {
    throw new Error(
      `Python 3.11 is required for MallAgent development, but ${commandDescription(python.program, python.args)} reports ${version || "an unknown version"}.`,
    );
  }
}

function backendDependenciesAreInstalled(python, root) {
  const modules = JSON.stringify(BACKEND_RUNTIME_MODULES);
  const script = [
    "import importlib.util",
    `modules = ${modules}`,
    "missing = []",
    "for name in modules:",
    "    try:",
    "        available = importlib.util.find_spec(name) is not None",
    "    except (ImportError, ModuleNotFoundError):",
    "        available = False",
    "    if not available:",
    "        missing.append(name)",
    "if missing:",
    "    print('Missing backend modules: ' + ', '.join(missing))",
    "raise SystemExit(1 if missing else 0)",
  ].join("\n");
  const result = spawnSync(python.program, [...python.args, "-c", script], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  if (result.error) {
    throw new Error(`Could not inspect MallAgent backend dependencies: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  const details = String(result.stdout || result.stderr || "").trim();
  if (details) console.warn(details);
  return false;
}

function ensurePythonEnvironment(root, platform, env) {
  const paths = getDevPaths(platform, root);
  const bootstrapPython = pythonInvocationFromEnvironment(root, platform, env);
  if (!fs.existsSync(paths.pythonPath)) {
    console.log(`Creating Python 3.11 virtualenv at ${paths.virtualenvDirectory}`);
    runPython(bootstrapPython, ["-m", "venv", paths.virtualenvDirectory], root);
  }

  const python = { program: paths.pythonPath, args: [] };
  checkPythonVersion(python, root);
  if (!backendDependenciesAreInstalled(python, root)) {
    console.log(`Installing MallAgent backend dependencies from ${paths.requirementsPath}`);
    runPython(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", paths.requirementsPath],
      root,
    );
  }
  runPython(python, ["-m", "pip", "check"], root);
  return python;
}

function resolveModuleFromRoot(moduleName, root) {
  try {
    return require.resolve(moduleName, { paths: [root] });
  } catch {
    return undefined;
  }
}

function assertTauriCliDependencies(root, platform, arch) {
  const paths = getDevPaths(platform, root);
  if (!fs.existsSync(paths.tauriCliPath) || !resolveModuleFromRoot("@tauri-apps/cli", root)) {
    throw new Error("Tauri CLI is missing. Run `npm ci` in the project root before starting MallAgent.");
  }

  const binding = getTauriBindingPackage(platform, arch);
  if (!binding || !resolveModuleFromRoot(binding, root)) {
    const platformBinding = binding || `${platform}/${arch}`;
    throw new Error(
      `Tauri platform binding ${platformBinding} is missing. Run npm ci without --omit=optional, then retry.`,
    );
  }
}

function runTauriDev(root, platform, env) {
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "tauri", "--", "dev"], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: false,
    shell: platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function main(root = process.cwd(), platform = process.platform, arch = process.arch, env = process.env) {
  ensureDevResourceDirectory(root, platform);
  assertTauriCliDependencies(root, platform, arch);
  ensurePythonEnvironment(root, platform, env);
  return runTauriDev(root, platform, env);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
