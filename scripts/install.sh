#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v codex >/dev/null 2>&1; then
  echo "codex binary not found. Open this repository in ChatGPT/Codex and install the repo-local marketplace, or install current @openai/codex first." >&2
  exit 2
fi
codex plugin marketplace add "$ROOT"
MARKETPLACE="codex-worker-delegation-local"
codex plugin add "codex-worker-delegation@${MARKETPLACE}"
echo "Installed codex-worker-delegation through the official Codex plugin manager."
echo "Review/trust the bundled PreToolUse hook when Codex prompts you."
echo "Start the Web control plane with: npm start"
