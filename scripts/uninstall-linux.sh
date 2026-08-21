#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./systemd-lib.sh
source "$SCRIPT_DIR/systemd-lib.sh"

INSTALL_ROOT="$(cwd_install_root)"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
CURRENT="$INSTALL_ROOT/current"

find_codex() {
  local candidate
  for candidate in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  command -v codex 2>/dev/null || return 1
}

NODE_BIN="${CWD_NODE_BIN:-$INSTALL_ROOT/runtime/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
CODEX="$(find_codex || true)"
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash() { if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
AUTH_BEFORE="$(auth_hash)"

if [[ -d "$CURRENT" && -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then
  (cd "$CURRENT" && "$NODE_BIN" src/cli.mjs uninstall)
fi
if [[ -n "$CODEX" ]]; then
  "$CODEX" plugin remove codex-worker-delegation@codex-worker-delegation-local --json >/dev/null 2>&1 || true
  "$CODEX" plugin marketplace remove codex-worker-delegation-local --json >/dev/null 2>&1 || true
fi
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]] && command -v systemctl >/dev/null 2>&1; then
  cwd_systemctl "$SCOPE" disable --now codex-worker-delegation.service >/dev/null 2>&1 || true
fi
rm -f "$SERVICE_FILE"
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]] && command -v systemctl >/dev/null 2>&1; then
  cwd_systemctl "$SCOPE" daemon-reload >/dev/null 2>&1 || true
fi

AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then
  echo "FATAL: auth.json changed during uninstall. Official credentials were not overwritten by this script." >&2
  exit 1
fi

if [[ "${CWD_PURGE_DATA:-0}" == "1" ]]; then
  rm -rf "$INSTALL_ROOT"
  echo "Removed integration, service, plugin, installed code, and project data."
else
  rm -rf "$CURRENT" "$INSTALL_ROOT/previous" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/runtime"
  rm -f "$INSTALL_ROOT/systemd-scope" "$INSTALL_ROOT/install-record.json" "$INSTALL_ROOT/.install-record.rollback-backup"
  echo "Removed integration, service, plugin, runtime, and installed code; encrypted provider/audit data under $INSTALL_ROOT is retained."
fi
printf 'ChatGPT auth.json preservation for this uninstall transaction: PASS (%s)\n' "$AUTH_AFTER"
