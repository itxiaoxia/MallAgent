$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Python 3.11 virtual environment not found at $python. Create .venv with py -3.11 first."
}

$output = Join-Path $root "src-tauri\resources"
$work = Join-Path $root "backend\build"
$spec = Join-Path $root "backend\build-spec"
New-Item -ItemType Directory -Force -Path $output | Out-Null

& $python -m pip install --disable-pip-version-check --no-input "pyinstaller>=6.10,<7"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to install or verify PyInstaller (exit code $LASTEXITCODE)."
}
# The Tauri parent starts this child with CREATE_NO_WINDOW and null stdio. Keep
# the console subsystem here because uvicorn relies on standard streams during
# initialization; the packaged desktop app remains window-only.
& $python -m PyInstaller --noconfirm --clean --onefile --console `
    --name "mallagent-backend" `
    --distpath $output `
    --workpath $work `
    --specpath $spec `
    --copy-metadata "fastmcp-slim" `
    --paths (Join-Path $root "backend") `
    (Join-Path $root "backend\entrypoint.py")
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed (exit code $LASTEXITCODE)."
}

if (-not (Test-Path -LiteralPath (Join-Path $output "mallagent-backend.exe"))) {
    throw "PyInstaller did not produce src-tauri/resources/mallagent-backend.exe"
}
