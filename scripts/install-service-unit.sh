#!/usr/bin/env bash
set -euo pipefail

RELEASE_ROOT="${CWD_RELEASE_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_ROOT="${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-worker-delegation}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SYSTEMD_DIR/codex-worker-delegation.service"
TEMPLATE="$RELEASE_ROOT/deploy/codex-worker-delegation.service"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required to install the systemd unit." >&2
  exit 2
fi
if [[ "$INSTALL_ROOT" =~ [[:space:]] ]]; then
  echo "CWD_INSTALL_ROOT must not contain whitespace because systemd executable paths are intentionally kept unambiguous." >&2
  exit 2
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "systemd unit template not found: $TEMPLATE" >&2
  exit 2
fi

mkdir -p "$SYSTEMD_DIR" "$INSTALL_ROOT/runtime"
REAL_NODE="$(readlink -f "$NODE_BIN")"
ln -sfn "$REAL_NODE" "$INSTALL_ROOT/runtime/node"

"$NODE_BIN" -e '
const fs=require("fs");
const [template,out,root]=process.argv.slice(1);
const escapedRoot=root.replaceAll("%","%%");
let text=fs.readFileSync(template,"utf8");
text=text.replaceAll("%h/.local/share/codex-worker-delegation",escapedRoot);
fs.writeFileSync(out,text,{mode:0o600});
fs.chmodSync(out,0o600);
' "$TEMPLATE" "$SERVICE_FILE" "$INSTALL_ROOT"

printf 'Installed user service unit: %s\n' "$SERVICE_FILE"
printf 'Pinned service Node runtime: %s -> %s\n' "$INSTALL_ROOT/runtime/node" "$REAL_NODE"
