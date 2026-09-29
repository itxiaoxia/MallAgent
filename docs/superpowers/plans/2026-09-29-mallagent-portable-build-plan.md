# MallAgent Portable Windows and macOS Build Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for
> tracking. The user explicitly requested no automatic commits, so all changes
> remain in the working tree.

**Goal:** Add unified host-native packaging so Windows produces a directly
runnable portable `MallAgent.exe` directory and macOS produces a directly
openable `MallAgent.app`, without shipping a separate Python runtime.

**Architecture:** A shared Node orchestrator resolves a build-machine Python
3.11, builds and smoke-tests the PyInstaller backend, builds the Vite/Tauri
desktop target, and stages the requested artifact. `build.bat` and `build.sh`
only launch that orchestrator on their native host. Tauri bundles the backend
resource directory as `backend/`, while Windows portable staging copies the
same resource beside the executable.

**Tech Stack:** Node.js, Python 3.11, PyInstaller, Tauri 2, Rust, Vite,
TypeScript, Vitest, Windows batch, POSIX shell.

**Spec:** `docs/superpowers/specs/2026-09-29-mallagent-portable-build-design.md`

## Global Constraints

- Do not add or change `.gitignore` rules.
- Do not add or commit a repository-managed Python runtime.
- Packaged clients must not require a separately installed Python runtime.
- Windows packaging runs on Windows and creates `release/windows/MallAgent.exe`
  plus `release/windows/backend/mallagent-backend.exe`.
- macOS packaging runs on macOS and creates `release/macos/MallAgent.app`.
- Build scripts must not terminate unrelated MallAgent processes.
- Packaged-backend verification must request `/api/config` and verify SQLite
  created the `app_config` table.
- Preserve all existing uncommitted user changes and do not create commits.

## Review Focus

- A Windows build must not accidentally emit only an installer or leave the
  executable without its backend resource directory.
- A macOS build must select the `app` bundle target and not depend on a DMG or
  installer step.
- Python resolution must prefer the repository `.venv`, validate Python 3.11,
  and produce an actionable error instead of silently using Python 3.14.
- A locked backend output must fail safely without killing an existing process.
- The packaged backend smoke test must use temporary configuration state and
  prove the SQLite schema independently of the development virtualenv.

---

### Task 1: Define and test the portable build target contract

**Files:**
- Create: `scripts/build-desktop.test.ts`
- Modify: `vitest.config.ts`
- Create later: `scripts/build-desktop.mjs`

**Interfaces:**
- Produces `getPlatformConfig(platform)`, returning the platform id,
  backend filename, Tauri build arguments, and final artifact paths.
- Produces `resolvePythonInvocation(root, platform, env, exists)`, returning a
  `{ program, args }` invocation that prefers `.venv` and never silently
  selects an incompatible Python.
- Produces `backendOutputPath(root, platform)` for the host-native PyInstaller
  output.

- [ ] **Step 1: Write failing Vitest cases** for Windows portable paths and
  `--no-bundle`, macOS `.app` paths and `--bundles app`, `.venv` preference,
  explicit `MALLAGENT_PYTHON` override, and unsupported-platform rejection.
- [ ] **Step 2: Run `npm.cmd test -- scripts/build-desktop.test.ts` and verify
  it fails because `scripts/build-desktop.mjs` does not exist yet.**
- [ ] **Step 3: Implement only the pure target/path/runtime-resolution
  functions in `scripts/build-desktop.mjs`.**
- [ ] **Step 4: Run the focused test again and verify all target-contract cases
  pass.**

### Task 2: Implement the shared backend build and packaged smoke test

**Files:**
- Modify: `scripts/build-desktop.mjs`
- Modify: `scripts/build-backend.ps1`

**Interfaces:**
- Consumes the target/runtime functions from Task 1.
- Produces `buildBackend(root, target, pythonInvocation)` and
  `verifyPackagedBackend(root, target, pythonInvocation)` behavior behind the
  CLI entry point.

- [ ] **Step 1: Extend the failing build-script tests** with command construction
  assertions for the PyInstaller one-file output, host-native backend name, and
  non-destructive locked-output error.
- [ ] **Step 2: Run the focused script tests and verify the new cases fail for
  the missing implementation.**
- [ ] **Step 3: Implement requirement installation/checking, PyInstaller
  invocation, writable-output validation, temporary-process lifecycle, health
  and config HTTP checks, and the SQLite `app_config` schema check.**
- [ ] **Step 4: Make the existing PowerShell backend entry point delegate to the
  shared orchestrator so it cannot use a different Python or resource path.**
- [ ] **Step 5: Run the focused tests and verify they pass.**

### Task 3: Add native packaging entry points and Tauri resource layout

**Files:**
- Create: `scripts/build.bat`
- Create: `scripts/build.sh`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `scripts/build-desktop.mjs`

**Interfaces:**
- `build.bat` and `build.sh` invoke the same Node orchestrator.
- `build:backend` retains a backend-only build/smoke path.
- `tauri:build` invokes the host-native full packaging path.

- [ ] **Step 1: Add static tests** proving both wrappers call the common
  orchestrator and do not reference a separate Python runtime.
- [ ] **Step 2: Run the focused tests and verify the wrapper assertions fail
  before the wrapper/configuration changes.**
- [ ] **Step 3: Implement the wrappers, package scripts, Tauri directory
  resource mapping, Windows `--no-bundle` staging, and macOS `app` staging.**
- [ ] **Step 4: Run `sh -n scripts/build.sh` and the focused packaging tests.**

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `src-tauri/src/lib.rs` only if resource-contract tests require it

- [ ] **Step 1: Document build-host prerequisites, direct Windows portable
  output, direct macOS `.app` output, WebView2/WebKit boundaries, and the fact
  that the installed client does not need Python.**
- [ ] **Step 2: Run backend tests, frontend tests, frontend build, Rust format,
  Rust tests/check, and `git diff --check`.**
- [ ] **Step 3: Run the real Windows backend-only packaging path and inspect its
  `/api/config` plus SQLite `app_config` result.**
- [ ] **Step 4: Run the real Windows portable packaging path and verify
  `release/windows/MallAgent.exe` and its backend sibling.**
- [ ] **Step 5: Run a macOS-host syntax/contract check available on Windows and
  report that `.app` execution remains pending until `build.sh` runs on macOS.**
- [ ] **Step 6: Re-read the spec and review the complete diff without staging or
  committing any changes.**

