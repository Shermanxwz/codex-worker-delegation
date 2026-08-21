#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./systemd-lib.sh
source "$SCRIPT_DIR/systemd-lib.sh"

INSTALL_ROOT="$(cwd_install_root)"
CURRENT="$INSTALL_ROOT/current"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
PORT="${CWD_PORT:-8788}"
NODE_BIN="${CWD_NODE_BIN:-$INSTALL_ROOT/runtime/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash(){ if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
AUTH_START="$(auth_hash)"
FAIL=0
pass(){ printf 'PASS  %s\n' "$1"; }
fail(){ printf 'FAIL  %s\n' "$1" >&2; FAIL=1; }
info(){ printf 'INFO  %s\n' "$1"; }
unit_has(){ grep -Fxq "$1" "$SERVICE_FILE" 2>/dev/null; }

if [[ "$SCOPE" == 'system' ]]; then
  (( EUID == 0 )) && pass 'root deployment uses system service scope' || fail 'system service scope requires root'
else
  pass "user service scope selected for uid $EUID"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] && pass "Node runtime present ($($NODE_BIN --version))" || fail 'Node runtime present'
[[ -d "$CURRENT" ]] && pass 'installed current tree exists' || fail 'installed current tree exists'
[[ -f "$SERVICE_FILE" ]] && pass "$SCOPE systemd unit installed" || fail "$SCOPE systemd unit installed"

ESCAPED_INSTALL_ROOT="${INSTALL_ROOT//%/%%}"
ESCAPED_HOME="${HOME//%/%%}"
ESCAPED_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
ESCAPED_CODEX_HOME="${ESCAPED_CODEX_HOME//%/%%}"
if [[ -f "$SERVICE_FILE" ]]; then
  unit_has 'NoNewPrivileges=true' && pass 'systemd NoNewPrivileges enabled' || fail 'systemd NoNewPrivileges enabled'
  unit_has 'ProtectSystem=full' && pass 'systemd ProtectSystem=full enabled without freezing workspaces' || fail 'systemd ProtectSystem=full enabled without freezing workspaces'
  unit_has 'CapabilityBoundingSet=' && pass 'systemd capabilities dropped' || fail 'systemd capabilities dropped'
  unit_has 'AmbientCapabilities=' && pass 'systemd ambient capabilities dropped' || fail 'systemd ambient capabilities dropped'
  unit_has "WorkingDirectory=$ESCAPED_INSTALL_ROOT/current" && pass 'systemd unit targets actual install root' || fail 'systemd unit targets actual install root'
  unit_has "Environment=CWD_NODE_BIN=$ESCAPED_INSTALL_ROOT/runtime/node" && pass 'systemd unit uses pinned Node runtime' || fail 'systemd unit uses pinned Node runtime'
  unit_has "Environment=HOME=$ESCAPED_HOME" && pass 'systemd HOME matches ChatGPT/Codex identity' || fail 'systemd HOME matches ChatGPT/Codex identity'
  unit_has "Environment=CODEX_HOME=$ESCAPED_CODEX_HOME" && pass 'systemd CODEX_HOME matches target identity' || fail 'systemd CODEX_HOME matches target identity'
  if unit_has 'ProtectSystem=strict'; then fail 'systemd must not make delegated workspaces read-only with ProtectSystem=strict'; else pass 'systemd avoids workspace-breaking ProtectSystem=strict'; fi
  if grep -Eq '/root/Documents|codex-primary-runtime' "$SERVICE_FILE"; then fail 'unit contains no development-machine path'; else pass 'unit contains no development-machine path'; fi
  if [[ "$SCOPE" == 'system' ]]; then
    unit_has 'User=root' && pass 'root system service explicitly runs as root' || fail 'root system service explicitly runs as root'
    unit_has 'Group=root' && pass 'root system service explicitly runs as group root' || fail 'root system service explicitly runs as group root'
  else
    if grep -Eq '^User=' "$SERVICE_FILE"; then fail 'user service must inherit the desktop Unix identity'; else pass 'user service inherits the desktop Unix identity'; fi
  fi
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$SERVICE_FILE" >/dev/null 2>&1 && pass 'systemd unit syntax verifies' || fail 'systemd unit syntax verifies'
  fi
fi

if [[ -f "$INSTALL_ROOT/runtime/node" && -x "$INSTALL_ROOT/runtime/node" && ! -L "$INSTALL_ROOT/runtime/node" ]]; then
  pass "pinned service Node is an executable regular file ($($INSTALL_ROOT/runtime/node --version))"
else
  fail 'pinned service Node is an executable regular file, not a symlink'
fi

if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  cwd_systemctl "$SCOPE" is-enabled codex-worker-delegation.service >/dev/null 2>&1 && pass "$SCOPE service enabled" || fail "$SCOPE service enabled"
  cwd_systemctl "$SCOPE" is-active codex-worker-delegation.service >/dev/null 2>&1 && pass "$SCOPE service active" || fail "$SCOPE service active"
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);if(j.ok!==true)process.exit(1)})'; then pass 'loopback health endpoint'; else fail 'loopback health endpoint'; fi
fi

find_codex(){ local c; for c in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do [[ -n "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }; done; command -v codex 2>/dev/null || return 1; }
CODEX="$(find_codex || true)"
if [[ -n "$CODEX" ]]; then
  pass "Codex runtime present ($($CODEX --version 2>&1 | head -1))"
  if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" == "1" ]]; then
    info 'Codex plugin validation skipped by CWD_INSTALL_NO_PLUGIN=1'
  elif "$CODEX" plugin list --json 2>/dev/null | grep -q 'codex-worker-delegation'; then pass 'Codex plugin installed'; else fail 'Codex plugin installed'; fi
else fail 'Codex runtime present'; fi

CONFIG_FILE="${CODEX_HOME:-$HOME/.codex}/config.toml"
if [[ -f "$CONFIG_FILE" ]] && grep -q '^\[model_providers\.codex_worker_gateway\]$' "$CONFIG_FILE"; then pass 'namespaced Codex provider installed'; else fail 'namespaced Codex provider installed'; fi
if [[ -f "$CONFIG_FILE" ]] && grep -q '^\[model_providers\.codex_worker_gateway\.auth\]$' "$CONFIG_FILE"; then pass 'command-backed gateway auth installed'; else fail 'command-backed gateway auth installed'; fi

for secret in "$INSTALL_ROOT/master.key" "$INSTALL_ROOT/gateway.token"; do
  if [[ -e "$secret" ]]; then
    mode="$(stat -c '%a' "$secret")"
    [[ "$mode" == '600' ]] && pass "$(basename "$secret") mode 0600" || fail "$(basename "$secret") mode 0600 (found $mode)"
  fi
done

RECORD="$INSTALL_ROOT/install-record.json"
if [[ -f "$RECORD" && -n "$NODE_BIN" ]]; then
  RECORD_MODE="$(stat -c '%a' "$RECORD")"
  [[ "$RECORD_MODE" == '600' ]] && pass 'install record mode 0600' || fail "install record mode 0600 (found $RECORD_MODE)"
  field(){ "$NODE_BIN" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v===undefined?"":String(v))' "$RECORD" "$1"; }
  EXPECTED_RELEASE="$(field releaseId)"
  EXPECTED_SCOPE="$(field systemdScope)"
  EXPECTED_SERVICE="$(field serviceFile)"
  EXPECTED_ROOT="$(field installRoot)"
  EXPECTED_UID="$(field uid)"
  EXPECTED_NODE_SHA="$(field runtimeNodeSha256)"
  EXPECTED_AUTH="$(field authSha256)"
  ACTUAL_RELEASE="$(cat "$CURRENT/.release-id" 2>/dev/null || printf 'missing')"
  ACTUAL_NODE_SHA="$(sha256sum "$INSTALL_ROOT/runtime/node" 2>/dev/null | awk '{print $1}')"
  [[ "$EXPECTED_RELEASE" == "$ACTUAL_RELEASE" ]] && pass 'install record matches active release' || fail "install record matches active release ($EXPECTED_RELEASE != $ACTUAL_RELEASE)"
  [[ "$EXPECTED_SCOPE" == "$SCOPE" ]] && pass 'install record matches systemd scope' || fail "install record matches systemd scope ($EXPECTED_SCOPE != $SCOPE)"
  [[ "$EXPECTED_SERVICE" == "$SERVICE_FILE" ]] && pass 'install record matches service file' || fail 'install record matches service file'
  [[ "$EXPECTED_ROOT" == "$INSTALL_ROOT" ]] && pass 'install record matches install root' || fail 'install record matches install root'
  [[ "$EXPECTED_UID" == "$EUID" ]] && pass 'install record matches deployment uid' || fail "install record matches deployment uid ($EXPECTED_UID != $EUID)"
  [[ "$EXPECTED_NODE_SHA" == "$ACTUAL_NODE_SHA" ]] && pass 'pinned Node SHA-256 matches install record' || fail 'pinned Node SHA-256 matches install record'
  if [[ "$EXPECTED_AUTH" == "$AUTH_START" ]]; then
    pass 'current auth.json matches the install evidence snapshot'
  else
    info 'auth.json differs from the historical install snapshot; this is allowed because the official ChatGPT/Codex client may refresh credentials. Lifecycle operations verify before/after preservation separately.'
  fi
else fail 'install record exists'; fi

if [[ -d "$CURRENT" && -n "$NODE_BIN" ]]; then
  (cd "$CURRENT" && "$NODE_BIN" scripts/check.mjs >/dev/null) && pass 'installed tree static contract' || fail 'installed tree static contract'
fi

AUTH_END="$(auth_hash)"
[[ "$AUTH_START" == "$AUTH_END" ]] && pass 'deployment validation did not modify auth.json' || fail 'deployment validation modified auth.json'

if (( FAIL != 0 )); then
  echo 'CWD_DEPLOYMENT_VALIDATION_FAILED' >&2
  exit 1
fi
echo 'CWD_DEPLOYMENT_VALIDATION_OK'
