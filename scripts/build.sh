#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != "Darwin" ]; then
  echo "scripts/build.sh must run on macOS (Darwin)." >&2
  exit 1
fi

exec node "$ROOT/scripts/build-desktop.mjs" "$@"
