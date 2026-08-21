#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./systemd-lib.sh
source "$SCRIPT_DIR/systemd-lib.sh"

INSTALL_ROOT="$(cwd_install_root)"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
CURRENT="$INSTALL_ROOT/current"
PREVIOUS="$INSTALL_ROOT/previous"
SWAP="$INSTALL_ROOT/.rollback-swap"
RECORD="$INSTALL_ROOT/install-record.json"
RECORD_BACKUP="$INSTALL_ROOT/.install-record.rollback-backup"
PORT="${CWD_PORT:-8788}"
NODE_BIN="${CWD_NODE_BIN:-$INSTALL_ROOT/runtime/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash(){ if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
find_codex(){ local c; for c in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do [[ -n "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }; done; command -v codex 2>/dev/null || return 1; }
CODEX="$(find_codex || true)"

if [[ ! -d "$CURRENT" || ! -d "$PREVIOUS" ]]; then
  echo "No complete previous release is available for rollback." >&2
  exit 2
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required for rollback validation." >&2
  exit 2
fi
if [[ -z "$CODEX" ]]; then
  echo "Codex runtime is required for rollback." >&2
  exit 2
fi
CURRENT_ID="$(cat "$CURRENT/.release-id" 2>/dev/null || echo unknown)"
PREVIOUS_ID="$(cat "$PREVIOUS/.release-id" 2>/dev/null || echo unknown)"
AUTH_BEFORE="$(auth_hash)"
if [[ -f "$RECORD" ]]; then cp -p "$RECORD" "$RECORD_BACKUP"; chmod 600 "$RECORD_BACKUP"; else rm -f "$RECORD_BACKUP"; fi

swap_releases(){
  rm -rf "$SWAP"
  mv "$CURRENT" "$SWAP"
  mv "$PREVIOUS" "$CURRENT"
  mv "$SWAP" "$PREVIOUS"
}
restore_after_failure(){
  local status=$?
  trap - ERR
  set +e
  echo "Rollback validation failed; restoring release $CURRENT_ID without touching auth.json." >&2
  swap_releases
  CWD_SYSTEMD_SCOPE="$SCOPE" CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh" >/dev/null 2>&1
  if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
    cwd_systemctl "$SCOPE" daemon-reload >/dev/null 2>&1
    cwd_systemctl "$SCOPE" restart codex-worker-delegation.service >/dev/null 2>&1
  fi
  if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then (cd "$CURRENT" && CODEX_BIN="$CODEX" bash scripts/install.sh) >/dev/null 2>&1; fi
  [[ -x "$INSTALL_ROOT/runtime/node" ]] && (cd "$CURRENT" && "$INSTALL_ROOT/runtime/node" src/cli.mjs install) >/dev/null 2>&1
  if [[ -f "$RECORD_BACKUP" ]]; then mv -f "$RECORD_BACKUP" "$RECORD"; else rm -f "$RECORD"; fi
  if [[ "$AUTH_BEFORE" != "$(auth_hash)" ]]; then
    echo "FATAL: auth.json changed during rollback recovery. Official credentials were not overwritten by this script." >&2
  fi
  exit "$status"
}
trap restore_after_failure ERR

swap_releases
CWD_SYSTEMD_SCOPE="$SCOPE" CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh"
NODE_BIN="$INSTALL_ROOT/runtime/node"
export CWD_NODE_BIN="$NODE_BIN"
export CWD_SYSTEMD_SCOPE="$SCOPE"
export CODEX_BIN="$CODEX"
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  cwd_systemctl "$SCOPE" daemon-reload
  cwd_systemctl "$SCOPE" restart codex-worker-delegation.service
  for _ in $(seq 1 40); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null
fi
if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
  (cd "$CURRENT" && CODEX_BIN="$CODEX" bash scripts/install.sh)
fi
(cd "$CURRENT" && "$NODE_BIN" src/cli.mjs install)
AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then
  echo "FATAL: ChatGPT/Codex auth.json changed during rollback; refusing to claim a sealed rollback." >&2
  exit 1
fi
RUNTIME_SHA="$(sha256sum "$NODE_BIN" | awk '{print $1}')"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
"$NODE_BIN" -e '
const fs=require("fs");const [file,releaseId,authSha256,runtimeNodeSha256,systemdScope,serviceFile,uid,user]=process.argv.slice(1);
let j={schemaVersion:2};try{j=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
j.schemaVersion=2;j.releaseId=releaseId;j.authSha256=authSha256;j.authContract="operation-scoped-preservation";j.runtimeNodeSha256=runtimeNodeSha256;j.systemdScope=systemdScope;j.serviceFile=serviceFile;j.uid=Number(uid);j.user=user;j.rolledBackAt=new Date().toISOString();
const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(j,null,2)+"\n",{mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);
' "$RECORD" "$PREVIOUS_ID" "$AUTH_AFTER" "$RUNTIME_SHA" "$SCOPE" "$SERVICE_FILE" "$EUID" "$(id -un)"
CWD_SYSTEMD_SCOPE="$SCOPE" bash "$CURRENT/scripts/validate-deployment.sh"
rm -f "$RECORD_BACKUP"
trap - ERR
printf 'Rolled back from %s to %s.\n' "$CURRENT_ID" "$PREVIOUS_ID"
printf 'Former current release is retained as the next rollback target.\n'
printf 'ChatGPT auth.json preservation for this rollback transaction: PASS (%s)\n' "$AUTH_AFTER"
