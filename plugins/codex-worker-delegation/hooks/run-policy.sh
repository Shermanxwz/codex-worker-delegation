#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
policy="${plugin_root}/hooks/policy-hook.mjs"
if [[ ! -f "$policy" ]]; then
  echo "codex-worker-delegation: policy hook not found: $policy" >&2
  exit 78
fi

candidates=(
  "${CWD_NODE_PATH:-}"
  "${CODEX_NODE_PATH:-}"
  "/usr/lib/chatgpt/resources/cua_node/bin/node"
  "/usr/lib/chatgpt/resources/node/bin/node"
  "${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
)

if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
if command -v nodejs >/dev/null 2>&1; then candidates+=("$(command -v nodejs)"); fi

for node_bin in "${candidates[@]}"; do
  if [[ -n "$node_bin" && -x "$node_bin" ]]; then
    exec "$node_bin" "$policy"
  fi
done

echo "codex-worker-delegation: Node.js 20+ was not found for the policy hook; set CWD_NODE_PATH or CODEX_NODE_PATH" >&2
exit 127
