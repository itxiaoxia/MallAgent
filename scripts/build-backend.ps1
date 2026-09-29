$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root "scripts\build-desktop.mjs") "--backend-only"
if ($LASTEXITCODE -ne 0) {
    throw "Desktop backend build failed (exit code $LASTEXITCODE)."
}
