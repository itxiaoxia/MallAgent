#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "build.sh must run on macOS (Darwin)." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH. Install Node.js before building MallAgent." >&2
  exit 1
fi

echo "[MallAgent] Building macOS desktop package..."
exec node "$ROOT/scripts/build-desktop.mjs" "$@"
