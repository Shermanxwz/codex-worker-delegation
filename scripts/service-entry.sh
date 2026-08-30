#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "codex-worker-delegation: Node.js 20+ is required; set CWD_NODE_BIN when node is not on PATH" >&2
  exit 127
fi
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  echo "codex-worker-delegation: Node.js 20+ is required (found $($NODE_BIN --version))" >&2
  exit 2
fi
export CWD_HOST="${CWD_HOST:-127.0.0.1}"
export CWD_PORT="${CWD_PORT:-8788}"
exec "$NODE_BIN" "$ROOT/src/server.mjs"
