#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
server="${plugin_root}/mcp/server.mjs"
if [[ ! -f "$server" ]]; then
  echo "codex-worker-delegation: MCP server not found: $server" >&2
  exit 78
fi

# Codex desktop may launch plugin MCP servers with a minimal PATH. Prefer an
# explicit override, then the deployment-pinned runtime, then ChatGPT-bundled
# runtimes, and finally ordinary PATH lookup. The pinned runtime is anchored to
# HOME so an inherited XDG_DATA_HOME from another identity cannot redirect it.
data_home="${HOME:-}/.local/share"
if [[ -n "${CWD_NODE_PATH:-}" || -n "${CODEX_NODE_PATH:-}" ]]; then
  # An explicit runtime is authoritative; do not silently fall back to an
  # unrelated desktop/system Node when the requested runtime is unavailable.
  candidates=("${CWD_NODE_PATH:-}" "${CODEX_NODE_PATH:-}")
else
  candidates=(
    "${data_home}/codex-worker-delegation/runtime/node"
    "/usr/lib/chatgpt/resources/cua_node/bin/node"
    "/usr/lib/chatgpt/resources/node/bin/node"
    "${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  )
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  if command -v nodejs >/dev/null 2>&1; then candidates+=("$(command -v nodejs)"); fi
fi

for node_bin in "${candidates[@]}"; do
  if [[ -n "$node_bin" && -x "$node_bin" ]] && "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' >/dev/null 2>&1; then
    exec "$node_bin" "$server"
  fi
done

echo "codex-worker-delegation: Node.js 20+ was not found; set CWD_NODE_PATH or CODEX_NODE_PATH" >&2
exit 127
