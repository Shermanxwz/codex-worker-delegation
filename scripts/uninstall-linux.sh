#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./systemd-lib.sh
source "$SCRIPT_DIR/systemd-lib.sh"

INSTALL_ROOT="$(cwd_install_root)"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
CURRENT="$INSTALL_ROOT/current"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG_FILE="$CODEX_HOME_DIR/config.toml"
OWNERSHIP_FILE="$INSTALL_ROOT/codex-config-ownership.json"
HAD_PROJECT_MARKER=0
[[ -f "$INSTALL_ROOT/install-record.json" || -f "$CURRENT/.release-id" ]] && HAD_PROJECT_MARKER=1

find_codex() { local candidate; for candidate in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi; done; command -v codex 2>/dev/null || return 1; }
NODE_BIN="${CWD_NODE_BIN:-$INSTALL_ROOT/runtime/node}"; [[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
CODEX="$(find_codex || true)"
AUTH_FILE="$CODEX_HOME_DIR/auth.json"
auth_hash() { if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
AUTH_BEFORE="$(auth_hash)"

if [[ -d "$CURRENT" ]]; then
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then echo "Node.js is required to reverse the managed Codex configuration safely." >&2; exit 2; fi
  (cd "$CURRENT" && "$NODE_BIN" src/cli.mjs uninstall)
fi

if [[ -n "$CODEX" ]]; then
  if "$CODEX" plugin list --json 2>/dev/null | grep -Fq 'codex-worker-delegation@codex-worker-delegation-local'; then
    "$CODEX" plugin remove codex-worker-delegation@codex-worker-delegation-local --json >/dev/null
  fi
  if "$CODEX" plugin list --json 2>/dev/null | grep -Fq 'codex-worker-delegation@codex-worker-delegation-local'; then
    echo "FATAL: Codex still reports codex-worker-delegation installed after removal." >&2; exit 1
  fi
  "$CODEX" plugin marketplace remove codex-worker-delegation-local --json >/dev/null 2>&1 || true
  if MARKETPLACES="$($CODEX plugin marketplace list --json 2>/dev/null)"; then
    if grep -Fq 'codex-worker-delegation-local' <<<"$MARKETPLACES"; then echo "FATAL: Codex marketplace entry still exists after removal." >&2; exit 1; fi
  fi
fi

if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]] && command -v systemctl >/dev/null 2>&1; then
  cwd_systemctl "$SCOPE" disable --now codex-worker-delegation.service >/dev/null 2>&1 || true
  if cwd_systemctl "$SCOPE" is-active codex-worker-delegation.service >/dev/null 2>&1; then echo "FATAL: codex-worker-delegation.service is still active." >&2; exit 1; fi
  if cwd_systemctl "$SCOPE" is-enabled codex-worker-delegation.service >/dev/null 2>&1; then echo "FATAL: codex-worker-delegation.service is still enabled." >&2; exit 1; fi
fi
rm -f "$SERVICE_FILE"
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]] && command -v systemctl >/dev/null 2>&1; then cwd_systemctl "$SCOPE" daemon-reload >/dev/null 2>&1 || true; fi
if [[ -e "$SERVICE_FILE" ]]; then echo "FATAL: systemd unit file still exists after uninstall." >&2; exit 1; fi

if [[ -f "$CONFIG_FILE" ]] && grep -Eq '^\[model_providers\.codex_worker_gateway(\.auth)?\]$' "$CONFIG_FILE"; then echo "FATAL: managed Codex provider remains in config.toml after uninstall." >&2; exit 1; fi
if [[ -e "$OWNERSHIP_FILE" ]]; then echo "FATAL: Codex configuration ownership manifest remains after uninstall." >&2; exit 1; fi
AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then echo "FATAL: auth.json changed during uninstall. Official credentials were not overwritten by this script." >&2; exit 1; fi

if [[ "${CWD_PURGE_DATA:-0}" == "1" ]]; then
  if (( HAD_PROJECT_MARKER != 1 )); then echo "Refusing CWD_PURGE_DATA=1 because $INSTALL_ROOT has no project install marker." >&2; exit 2; fi
  SAFE_ROOT="$(cwd_assert_safe_install_root "$INSTALL_ROOT")"
  [[ "$SAFE_ROOT" == "$INSTALL_ROOT" ]] || { echo "Refusing purge because normalized install root changed unexpectedly." >&2; exit 2; }
  rm -rf --one-file-system "$INSTALL_ROOT"
  echo "Removed integration, service, plugin, installed code, and project data."
else
  rm -rf -- "$CURRENT" "$INSTALL_ROOT/previous" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/runtime"
  rm -f -- "$INSTALL_ROOT/systemd-scope" "$INSTALL_ROOT/install-record.json" "$INSTALL_ROOT/.install-record.rollback-backup"
  echo "Removed integration, service, plugin, runtime, and installed code; encrypted provider/audit data under $INSTALL_ROOT is retained."
fi
printf 'ChatGPT auth.json preservation for this uninstall transaction: PASS (%s)\n' "$AUTH_AFTER"
