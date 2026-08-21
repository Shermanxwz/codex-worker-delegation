#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
server="${plugin_root}/mcp/server.mjs"
if [[ ! -f "$server" ]]; then
  echo "codex-worker-delegation: MCP server not found: $server" >&2
  exit 78
fi

# Codex desktop may launch plugin MCP servers with a minimal PATH. Prefer an
# explicit override, then the bundled runtimes used by ChatGPT/Codex Linux,
# and finally ordinary PATH lookup for normal Node.js installations.
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
    exec "$node_bin" "$server"
  fi
done

echo "codex-worker-delegation: Node.js 20+ was not found; set CWD_NODE_PATH or CODEX_NODE_PATH" >&2
exit 127
