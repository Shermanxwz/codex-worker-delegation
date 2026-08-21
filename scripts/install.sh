#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_codex() {
  local candidate
  for candidate in \
    "${CODEX_CLI_PATH:-}" \
    "${CODEX_BIN:-}" \
    "/usr/lib/chatgpt/resources/codex" \
    "${HOME}/.local/bin/codex" \
    "${HOME}/.codex/bin/codex" \
    "${HOME}/.codex/packages/standalone/current/bin/codex" \
    "${HOME}/.codex/packages/standalone/current/codex"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v codex 2>/dev/null || return 1
}

CODEX="$(find_codex || true)"
if [[ -z "$CODEX" ]]; then
  echo "Codex binary not found. Install the official ChatGPT Linux app or current Codex, or set CODEX_CLI_PATH." >&2
  exit 2
fi

echo "Using Codex: $CODEX"
"$CODEX" --version
"$CODEX" plugin marketplace add "$ROOT"
MARKETPLACE="codex-worker-delegation-local"
"$CODEX" plugin add "codex-worker-delegation@${MARKETPLACE}"
"$CODEX" plugin list --json

echo "Installed codex-worker-delegation through the official Codex plugin manager."
echo "Review/trust the bundled PreToolUse hook when Codex prompts you."
echo "Start a new Codex chat/task after installation so its MCP tools and hooks are loaded."
echo "The active Codex approval policy must permit the delegate_worker MCP call."
echo "Start the Web control plane with: npm start"
