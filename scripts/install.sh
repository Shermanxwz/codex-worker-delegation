#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./systemd-lib.sh
source "$ROOT/scripts/systemd-lib.sh"
PLUGIN_ROOT="$ROOT/plugins/codex-worker-delegation"
MARKETPLACE="codex-worker-delegation-local"

CODEX_HOME_DIR="${CODEX_HOME:-${HOME:-}/.codex}"
if [[ "$EUID" -eq 0 && "$CODEX_HOME_DIR" == /home/* ]] && cwd_path_is_nonroot_owned "$CODEX_HOME_DIR"; then
  echo "Refusing to install a Codex plugin as root into a non-root CODEX_HOME: $CODEX_HOME_DIR" >&2
  exit 2
fi

find_codex() {
  local candidate
  for candidate in "${CODEX_CLI_PATH:-}" "${CODEX_BIN:-}" "/usr/lib/chatgpt/resources/codex" "${HOME}/.local/bin/codex" "${HOME}/.codex/bin/codex" "${HOME}/.codex/packages/standalone/current/bin/codex" "${HOME}/.codex/packages/standalone/current/codex"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  command -v codex 2>/dev/null || return 1
}

CODEX="$(find_codex || true)"
if [[ -z "$CODEX" ]]; then echo "Codex binary not found. Install the official ChatGPT Linux app or current Codex, or set CODEX_CLI_PATH." >&2; exit 2; fi
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then echo "Node.js 20+ is required for deterministic Codex plugin installation." >&2; exit 2; fi
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then echo "Node.js 20+ is required" >&2; exit 2; fi

echo "Using Codex: $CODEX"
"$CODEX" --version
CACHE_JSON="$("$NODE_BIN" "$ROOT/scripts/plugin-cachebuster.mjs" "$PLUGIN_ROOT" --json)"
PLUGIN_VERSION="$("$NODE_BIN" -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.version)' "$CACHE_JSON")"
SOURCE_SHA="$("$NODE_BIN" "$ROOT/scripts/tree-digest.mjs" "$PLUGIN_ROOT")"
"$CODEX" plugin marketplace add "$ROOT"
"$CODEX" plugin add "codex-worker-delegation@${MARKETPLACE}"
PLUGIN_LIST="$($CODEX plugin list --json)"
printf '%s\n' "$PLUGIN_LIST"
if ! grep -Fq "codex-worker-delegation@${MARKETPLACE}" <<<"$PLUGIN_LIST"; then echo "Codex plugin manager did not report the installed plugin." >&2; exit 1; fi

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CACHE_ROOT="$CODEX_HOME_DIR/plugins/cache/$MARKETPLACE/codex-worker-delegation/$PLUGIN_VERSION"
if [[ ! -d "$CACHE_ROOT" ]]; then echo "Codex plugin cache is missing the expected cachebuster version: $CACHE_ROOT" >&2; exit 1; fi
CACHE_SHA="$("$NODE_BIN" "$ROOT/scripts/tree-digest.mjs" "$CACHE_ROOT")"
if [[ "$SOURCE_SHA" != "$CACHE_SHA" ]]; then echo "Codex plugin cache payload mismatch: source=$SOURCE_SHA cache=$CACHE_SHA" >&2; exit 1; fi

printf 'Installed plugin version: %s\n' "$PLUGIN_VERSION"
printf 'Verified plugin payload SHA-256: %s\n' "$SOURCE_SHA"
echo "Installed codex-worker-delegation through the official Codex plugin manager."
echo "Review/trust the bundled PreToolUse hook when Codex prompts you."
echo "Start a new Codex chat/task after installation so its MCP tools and hooks are loaded."
echo "The active Codex approval policy must permit the delegate_worker MCP call."
echo "Start the Web control plane with: npm start"
