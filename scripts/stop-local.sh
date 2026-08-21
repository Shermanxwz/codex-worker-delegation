#!/usr/bin/env bash
set -euo pipefail

RUN_DIR="${CWD_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/tmp}/codex-worker-delegation}"
PID_FILE="$RUN_DIR/server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Codex Worker Delegation is not running"
  exit 0
fi

server_pid="$(<"$PID_FILE")"
if kill -0 "$server_pid" 2>/dev/null; then
  kill "$server_pid"
  for _ in $(seq 1 30); do
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.1
  done
fi
rm -f "$PID_FILE"
echo "Codex Worker Delegation stopped"
