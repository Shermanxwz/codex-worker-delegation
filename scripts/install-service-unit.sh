#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./systemd-lib.sh
source "$SCRIPT_DIR/systemd-lib.sh"

RELEASE_ROOT="${CWD_RELEASE_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
INSTALL_ROOT="$(cwd_install_root)"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
HOME_DIR="${HOME:-}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME_DIR/.codex}"
SYSTEMD_DIR="$(cwd_systemd_dir "$SCOPE")"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"

if [[ "$SCOPE" == 'system' && "$EUID" -ne 0 ]]; then
  echo "System-service deployment requires root. Run as root or set CWD_SYSTEMD_SCOPE=user." >&2
  exit 2
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required to install the systemd unit." >&2
  exit 2
fi
for item in "$INSTALL_ROOT" "$HOME_DIR" "$CODEX_HOME_DIR" "$SYSTEMD_DIR"; do
  if [[ -z "$item" || "$item" != /* || "$item" =~ [[:space:]] ]]; then
    echo "Deployment paths must be absolute and contain no whitespace: $item" >&2
    exit 2
  fi
done

if [[ "$SCOPE" == 'system' ]]; then
  TEMPLATE="$RELEASE_ROOT/deploy/codex-worker-delegation.root.service"
else
  TEMPLATE="$RELEASE_ROOT/deploy/codex-worker-delegation.service"
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "systemd unit template not found: $TEMPLATE" >&2
  exit 2
fi

mkdir -p "$INSTALL_ROOT/runtime" "$SYSTEMD_DIR"
chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/runtime" 2>/dev/null || true
REAL_NODE="$(readlink -f "$NODE_BIN")"
RUNTIME_NODE="$INSTALL_ROOT/runtime/node"
if [[ "$REAL_NODE" != "$RUNTIME_NODE" ]]; then
  tmp_node="$RUNTIME_NODE.$$.tmp"
  rm -f "$tmp_node"
  cp --reflink=auto "$REAL_NODE" "$tmp_node" 2>/dev/null || cp "$REAL_NODE" "$tmp_node"
  chmod 755 "$tmp_node"
  mv -f "$tmp_node" "$RUNTIME_NODE"
fi
if [[ ! -x "$RUNTIME_NODE" ]]; then
  echo "Failed to install the pinned Node runtime: $RUNTIME_NODE" >&2
  exit 2
fi
NODE_MAJOR="$($RUNTIME_NODE -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  echo "Pinned Node.js runtime must be version 20+ (found $($RUNTIME_NODE --version 2>&1 || true))." >&2
  exit 2
fi

SERVICE_TMP="$SERVICE_FILE.$$.tmp"
"$RUNTIME_NODE" -e '
const fs=require("fs");
const [template,out,installRoot,home,codexHome]=process.argv.slice(1);
const escapeSystemd=(value)=>String(value).replaceAll("%","%%");
let text=fs.readFileSync(template,"utf8");
for (const [marker,value] of [["@@INSTALL_ROOT@@",installRoot],["@@HOME@@",home],["@@CODEX_HOME@@",codexHome]]) {
  text=text.replaceAll(marker,escapeSystemd(value));
}
if (text.includes("@@")) throw new Error("unresolved systemd template marker");
fs.writeFileSync(out,text,{mode:0o644});
fs.chmodSync(out,0o644);
' "$TEMPLATE" "$SERVICE_TMP" "$INSTALL_ROOT" "$HOME_DIR" "$CODEX_HOME_DIR"
mv -f "$SERVICE_TMP" "$SERVICE_FILE"
chmod 644 "$SERVICE_FILE"
cwd_write_systemd_scope "$INSTALL_ROOT" "$SCOPE"

printf 'Installed %s service unit: %s\n' "$SCOPE" "$SERVICE_FILE"
printf 'Pinned service Node runtime: %s (%s, sha256=%s)\n' "$RUNTIME_NODE" "$($RUNTIME_NODE --version)" "$(sha256sum "$RUNTIME_NODE" | awk '{print $1}')"
