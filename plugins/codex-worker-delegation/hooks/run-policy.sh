#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
policy="${plugin_root}/hooks/policy-hook.mjs"
deny() {
  local reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}
if [[ ! -f "$policy" ]]; then
  deny 'Codex Worker Delegation policy hook is missing; failing closed.'
fi

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
candidates=(
  "${CWD_NODE_PATH:-}"
  "${CODEX_NODE_PATH:-}"
  "${data_home}/codex-worker-delegation/runtime/node"
  "/usr/lib/chatgpt/resources/cua_node/bin/node"
  "/usr/lib/chatgpt/resources/node/bin/node"
  "${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
)

if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
if command -v nodejs >/dev/null 2>&1; then candidates+=("$(command -v nodejs)"); fi

for node_bin in "${candidates[@]}"; do
  if [[ -n "$node_bin" && -x "$node_bin" ]] && "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' >/dev/null 2>&1; then
    exec "$node_bin" "$policy"
  fi
done

deny 'Codex Worker Delegation requires Node.js 20+ for policy enforcement; no compliant runtime was found, so tool execution is blocked.'
