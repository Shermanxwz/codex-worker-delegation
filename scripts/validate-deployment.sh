#!/usr/bin/env bash
set -euo pipefail
INSTALL_ROOT="${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-worker-delegation}"
CURRENT="$INSTALL_ROOT/current"
SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-worker-delegation.service"
PORT="${CWD_PORT:-8788}"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
FAIL=0
pass(){ printf 'PASS  %s\n' "$1"; }
fail(){ printf 'FAIL  %s\n' "$1" >&2; FAIL=1; }

if [[ "${EUID}" -eq 0 && "${CWD_ALLOW_ROOT_INSTALL:-0}" != "1" ]]; then fail 'service owner is not root'; else pass 'service owner is not root (or explicit CI override)'; fi
[[ -n "$NODE_BIN" ]] && pass "Node runtime present ($($NODE_BIN --version))" || fail 'Node runtime present'
[[ -d "$CURRENT" ]] && pass 'installed current tree exists' || fail 'installed current tree exists'
[[ -f "$SERVICE_FILE" ]] && pass 'systemd user unit installed' || fail 'systemd user unit installed'
if [[ -f "$SERVICE_FILE" ]]; then
  grep -q '^NoNewPrivileges=true$' "$SERVICE_FILE" && pass 'systemd NoNewPrivileges enabled' || fail 'systemd NoNewPrivileges enabled'
  grep -q '^ProtectSystem=strict$' "$SERVICE_FILE" && pass 'systemd ProtectSystem=strict enabled' || fail 'systemd ProtectSystem=strict enabled'
  grep -q '^CapabilityBoundingSet=$' "$SERVICE_FILE" && pass 'systemd capabilities dropped' || fail 'systemd capabilities dropped'
  if grep -Eq 'User=root|/root/Documents|codex-primary-runtime' "$SERVICE_FILE"; then fail 'unit contains no root/development-machine path'; else pass 'unit contains no root/development-machine path'; fi
fi

if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  systemctl --user is-enabled codex-worker-delegation.service >/dev/null 2>&1 && pass 'user service enabled' || fail 'user service enabled'
  systemctl --user is-active codex-worker-delegation.service >/dev/null 2>&1 && pass 'user service active' || fail 'user service active'
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);if(j.ok!==true)process.exit(1)})'; then pass 'loopback health endpoint'; else fail 'loopback health endpoint'; fi
fi

find_codex(){ local c; for c in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do [[ -n "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }; done; command -v codex 2>/dev/null || return 1; }
CODEX="$(find_codex || true)"
if [[ -n "$CODEX" ]]; then
  pass "Codex runtime present ($($CODEX --version 2>&1 | head -1))"
  if "$CODEX" plugin list --json 2>/dev/null | grep -q 'codex-worker-delegation'; then pass 'Codex plugin installed'; else fail 'Codex plugin installed'; fi
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
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [[ -f "$RECORD" && -n "$NODE_BIN" ]]; then
  EXPECTED="$($NODE_BIN -e "const j=require(process.argv[1]);process.stdout.write(String(j.authSha256))" "$RECORD")"
  if [[ -f "$AUTH_FILE" ]]; then ACTUAL="$(sha256sum "$AUTH_FILE"|awk '{print $1}')"; else ACTUAL='absent'; fi
  [[ "$EXPECTED" == "$ACTUAL" ]] && pass 'ChatGPT auth.json still matches install snapshot' || fail 'ChatGPT auth.json still matches install snapshot'
else fail 'install record exists'; fi

if [[ -d "$CURRENT" && -n "$NODE_BIN" ]]; then
  (cd "$CURRENT" && "$NODE_BIN" scripts/check.mjs >/dev/null) && pass 'installed tree static contract' || fail 'installed tree static contract'
fi

if (( FAIL != 0 )); then
  echo 'CWD_DEPLOYMENT_VALIDATION_FAILED' >&2
  exit 1
fi
echo 'CWD_DEPLOYMENT_VALIDATION_OK'
