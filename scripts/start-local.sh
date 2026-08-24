#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${CWD_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/tmp}/codex-worker-delegation}"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
HOST="${CWD_HOST:-127.0.0.1}"
PORT="${CWD_PORT:-8788}"
REQUIRE_AUTH="${CWD_REQUIRE_AUTH:-1}"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(find /root/.cache/codex-runtimes -type f -path '*/dependencies/node/bin/node' -perm -u+x 2>/dev/null | sort | head -1 || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "node 20+ is required" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(<"$PID_FILE")"
  if kill -0 "$existing_pid" 2>/dev/null; then
    if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      echo "Codex Worker Delegation is already running at http://127.0.0.1:${PORT}/"
      exit 0
    fi
    echo "another local process is using pid $existing_pid; inspect $PID_FILE" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

nohup env CWD_HOST="$HOST" CWD_PORT="$PORT" CWD_REQUIRE_AUTH="$REQUIRE_AUTH" "$NODE_BIN" "$ROOT/src/server.mjs" >>"$LOG_FILE" 2>&1 < /dev/null &
server_pid=$!
printf '%s\n' "$server_pid" >"$PID_FILE"

for _ in $(seq 1 50); do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Codex Worker Delegation is running at http://127.0.0.1:${PORT}/"
    echo "log: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "the local service exited; log: $LOG_FILE" >&2
    tail -40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.1
done

kill "$server_pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "the local service did not become ready; log: $LOG_FILE" >&2
tail -40 "$LOG_FILE" >&2 || true
exit 1
