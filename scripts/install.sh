#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node src/cli.mjs install
echo "Installed through the native Codex app-server plugin API."
echo "Review/trust the bundled PreToolUse hook when Codex prompts you."
echo "Start the Web control plane with: npm start"
