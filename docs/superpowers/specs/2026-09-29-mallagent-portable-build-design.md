# MallAgent Portable Windows and macOS Build Design

## Goal

Provide one host-native packaging entry point for each requested desktop
platform:

- `scripts/build.bat` produces a Windows portable output containing a directly
  runnable `MallAgent.exe` and its packaged backend.
- `scripts/build.sh` runs on macOS and produces a directly openable
  `MallAgent.app`.

Neither packaged client requires a separately installed Python runtime. The
Python interpreter, FastAPI service, LangChain dependencies, and SQLite
standard-library support are included in the PyInstaller backend executable.
Python 3.11 remains a build-machine prerequisite only.

## Scope and constraints

- Windows packaging runs on Windows and macOS packaging runs on macOS. The
  scripts do not claim cross-compilation.
- Windows output is a portable directory, not an installer. Its top-level
  executable is directly double-clickable when kept with its `backend` resource
  directory.
- macOS output is an `.app` bundle and is directly openable from Finder.
- The existing frontend, backend API, SQLite configuration location, SSE chat
  path, and conversation work are outside this packaging change.
- Do not add or change `.gitignore` rules. Do not add a repository-managed
  Python runtime.
- Build scripts may use an existing `.venv` or a system Python 3.11 on the
  build host. They must fail clearly when Python 3.11, Node, Rust, or required
  Python packages are unavailable.
- A build script must never terminate an unrelated MallAgent process. If a
  generated file is locked, it reports the owning build/runtime boundary and
  exits with a useful error.

## Architecture

```text
build.bat / build.sh
        |
        v
common Node build orchestrator
        |
        +-- selected host Python 3.11
        |     +-- install/check backend requirements
        |     +-- PyInstaller onefile backend
        |     +-- packaged backend smoke test
        |
        +-- Vite frontend build
        |
        +-- Tauri host-native build
        |
        +-- portable staging
              +-- Windows: MallAgent.exe + backend/mallagent-backend.exe
              +-- macOS:   MallAgent.app with backend resource inside bundle
```

The common orchestrator owns the command order, path resolution, platform
validation, backend output naming, smoke-test lifecycle, and final staging.
The batch and shell files are thin host-specific launchers so that the two
entry points cannot silently drift.

## Backend and resource layout

PyInstaller writes the host-native one-file backend to:

```text
src-tauri/resources/backend/mallagent-backend.exe   # Windows
src-tauri/resources/backend/mallagent-backend       # macOS
```

Tauri maps that directory to the packaged resource directory `backend/`.
Release Rust code continues to resolve the executable as
`resource_dir/backend/mallagent-backend(.exe)`, while debug mode continues to
launch the developer's Python module from the local project environment.

The Windows portable staging directory is:

```text
release/windows/
├── MallAgent.exe
└── backend/
    └── mallagent-backend.exe
```

The macOS artifact is:

```text
release/macos/MallAgent.app
```

No installer, NSIS package, DMG, or separately shipped Python runtime is part
of these two script outputs.

## Build and verification flow

1. Resolve and validate host Python 3.11. Prefer the repository `.venv`; fall
   back to the platform's Python 3.11 command only when it is available.
2. Install/verify `backend/requirements.txt` with that interpreter and run
   PyInstaller using the same interpreter.
3. Start the newly generated backend in a temporary process with a temporary
   `MALLAGENT_CONFIG_PATH` and an ephemeral loopback port.
4. Request `/api/health` and `/api/config`, then inspect the temporary database
   with Python `sqlite3` to prove that `app_config` was created. Always stop
   only the process started by the smoke test and remove its temporary data.
5. Build the frontend with Vite.
6. On Windows run Tauri with `--no-bundle`, then stage the release executable
   and backend beside each other under `release/windows/`.
7. On macOS run Tauri with the `app` bundle target, then expose the resulting
   `.app` under `release/macos/`.
8. Validate output existence, platform-specific backend naming, and absence of
   accidental installer-only output from the requested script.

The scripts also support a backend-only path for the existing
`build:backend` workflow; it performs the same packaged-backend smoke test.

## Error handling

- Missing or non-3.11 Python produces an actionable prerequisite error.
- Missing Python modules cause the build to stop before PyInstaller rather than
  generating a partial client.
- A stale locked backend output produces a specific cleanup/close-process
  message; the build does not kill it automatically.
- A backend that fails to start, returns a non-200 `/api/config`, or fails the
  SQLite schema check fails the build.
- macOS signing, notarization, quarantine behavior, and Windows WebView2
  availability remain host/distribution prerequisites. The build proves the
  local `.app`/portable executable artifact, not App Store or signed-release
  acceptance.

## Verification requirements

Automated coverage will include:

- host/runtime path and platform output-name selection in the common build
  orchestrator;
- Rust command-spec tests for the unchanged debug/release backend contract;
- `sh -n scripts/build.sh` and batch-script static checks where available;
- backend tests, frontend tests, frontend build, Rust format/tests/check;
- a real Windows PyInstaller build followed by the packaged backend
  `/api/config` and SQLite `app_config` smoke test;
- a macOS-host `scripts/build.sh` run producing `MallAgent.app`, reported
  separately from Windows evidence.

