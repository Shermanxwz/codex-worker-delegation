#!/usr/bin/env bash
set -euo pipefail
INSTALL_ROOT="${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-worker-delegation}"
CURRENT="$INSTALL_ROOT/current"
PREVIOUS="$INSTALL_ROOT/previous"
SWAP="$INSTALL_ROOT/.rollback-swap"
RECORD="$INSTALL_ROOT/install-record.json"
PORT="${CWD_PORT:-8788}"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash(){ if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }

if [[ ! -d "$CURRENT" || ! -d "$PREVIOUS" ]]; then
  echo "No complete previous release is available for rollback." >&2
  exit 2
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required for rollback validation." >&2
  exit 2
fi
CURRENT_ID="$(cat "$CURRENT/.release-id" 2>/dev/null || echo unknown)"
PREVIOUS_ID="$(cat "$PREVIOUS/.release-id" 2>/dev/null || echo unknown)"
AUTH_BEFORE="$(auth_hash)"

swap_releases(){
  rm -rf "$SWAP"
  mv "$CURRENT" "$SWAP"
  mv "$PREVIOUS" "$CURRENT"
  mv "$SWAP" "$PREVIOUS"
}
restore_after_failure(){
  local status=$?
  trap - ERR
  if (( status != 0 )); then
    echo "Rollback validation failed; restoring release $CURRENT_ID." >&2
    swap_releases || true
    if [[ -d "$CURRENT" ]]; then CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh" >/dev/null 2>&1 || true; fi
    if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then systemctl --user daemon-reload >/dev/null 2>&1 || true; systemctl --user restart codex-worker-delegation.service >/dev/null 2>&1 || true; fi
    if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then (cd "$CURRENT" && bash scripts/install.sh) >/dev/null 2>&1 || true; fi
  fi
  exit "$status"
}
trap restore_after_failure ERR

swap_releases
CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh"
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  systemctl --user daemon-reload
  systemctl --user restart codex-worker-delegation.service
  for _ in $(seq 1 40); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null
fi
if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
  (cd "$CURRENT" && bash scripts/install.sh)
fi
AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then
  echo "FATAL: ChatGPT/Codex auth.json changed during rollback." >&2
  exit 1
fi
"$NODE_BIN" -e 'const fs=require("fs");const [file,releaseId,authSha256]=process.argv.slice(1);let j={schemaVersion:1};try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}j.releaseId=releaseId;j.authSha256=authSha256;j.rolledBackAt=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(j,null,2)+"\n",{mode:0o600});fs.chmodSync(file,0o600)' "$RECORD" "$PREVIOUS_ID" "$AUTH_AFTER"
trap - ERR
printf 'Rolled back from %s to %s.\n' "$CURRENT_ID" "$PREVIOUS_ID"
printf 'Former current release is retained as the next rollback target.\n'
printf 'ChatGPT auth.json preservation: PASS (%s)\n' "$AUTH_AFTER"
