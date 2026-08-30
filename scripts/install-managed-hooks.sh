#!/usr/bin/env bash
set -euo pipefail

MARKER='codex-worker-delegation-managed-hooks-v1'
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() { echo "managed hook installation failed: $*" >&2; exit 2; }
require_absolute() {
  local value="$1" label="$2"
  [[ "$value" = /* && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *[[:space:]]* ]] || fail "$label must be an absolute path without whitespace or control characters"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail 'system-managed hooks require root; use sudo for this explicit step'

if [[ -n "${CWD_INSTALL_ROOT:-}" ]]; then
  INSTALL_ROOT="$(readlink -m -- "$CWD_INSTALL_ROOT")"
else
  [[ "$(basename -- "$ROOT_DIR")" == current ]] || fail 'set CWD_INSTALL_ROOT to the deployment root when running from a source checkout'
  INSTALL_ROOT="$(dirname -- "$ROOT_DIR")"
fi
require_absolute "$INSTALL_ROOT" 'install root'
[[ "$INSTALL_ROOT" != '/' && "$INSTALL_ROOT" != '/etc' && "$INSTALL_ROOT" != '/usr' && "$INSTALL_ROOT" != '/var' && "$INSTALL_ROOT" != '/root' ]] || fail 'refusing a system directory as install root'

HOME_DIR="${HOME:-}"
[[ -n "$HOME_DIR" && "$HOME_DIR" = /* ]] || fail 'HOME must be an absolute path'
DATA_DIR_RAW="${CWD_DATA_DIR:-$HOME_DIR/.local/share/codex-worker-delegation}"
MANAGED_DIR_RAW="${CWD_MANAGED_HOOKS_DIR:-/etc/codex}"
require_absolute "$DATA_DIR_RAW" 'data directory'
require_absolute "$MANAGED_DIR_RAW" 'managed hook directory'
[[ ! -L "$DATA_DIR_RAW" ]] || fail 'data directory must not be a symlink'
[[ ! -L "$MANAGED_DIR_RAW" ]] || fail 'managed hook directory must not be a symlink'
DATA_DIR="$(readlink -m -- "$DATA_DIR_RAW")"
MANAGED_DIR="$(readlink -m -- "$MANAGED_DIR_RAW")"
PORT="${CWD_PORT:-8788}"
require_absolute "$DATA_DIR" 'data directory'
require_absolute "$MANAGED_DIR" 'managed hook directory'
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || fail 'CWD_PORT must be between 1 and 65535'

TEMPLATE_DIR="$ROOT_DIR/deploy/managed-hooks"
RENDERER="$ROOT_DIR/scripts/render-managed-hooks.mjs"
[[ -f "$TEMPLATE_DIR/requirements.toml.in" && -f "$TEMPLATE_DIR/worker-delegation-policy.sh.in" && -f "$TEMPLATE_DIR/worker-delegation-policy.mjs.in" && -f "$RENDERER" ]] || fail 'managed hook deployment assets are incomplete'

NODE_BIN="${CWD_MANAGED_NODE_BIN:-${CWD_NODE_BIN:-$INSTALL_ROOT/runtime/node}}"
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail 'Node.js 20 or newer is required'
NODE_BIN="$(readlink -f -- "$NODE_BIN")"
"$NODE_BIN" -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(Number.isInteger(major) && major >= 20 ? 0 : 1)' || fail 'Node.js 20 or newer is required'
POLICY_RUNNER="$INSTALL_ROOT/current/plugins/codex-worker-delegation/hooks/run-policy.sh"
[[ -x "$POLICY_RUNNER" ]] || fail 'active release policy runner is missing or not executable'

mkdir -p -- "$MANAGED_DIR"
[[ ! -L "$MANAGED_DIR" ]] || fail 'managed hook directory must not be a symlink'
[[ -d "$DATA_DIR" ]] || fail 'data directory must already exist and be initialized by the control-plane service identity'

BACKUP_DIR="$MANAGED_DIR/.codex-worker-delegation-backup"
OWNERSHIP_FILE="$MANAGED_DIR/.codex-worker-delegation-managed"
TARGETS=(requirements.toml worker-delegation-policy.sh worker-delegation-policy.mjs)
is_project_file() { [[ -f "$1" ]] && grep -Fq "$MARKER" "$1"; }

for name in "${TARGETS[@]}"; do
  target="$MANAGED_DIR/$name"
  [[ ! -L "$target" ]] || fail "$target must not be a symlink"
  if [[ -e "$target" ]] && ! is_project_file "$target"; then
    [[ "${CWD_MANAGED_HOOKS_ADOPT:-0}" == 1 ]] || fail "$target already exists and is not owned by this project; set CWD_MANAGED_HOOKS_ADOPT=1 to back it up explicitly"
    mkdir -p -- "$BACKUP_DIR"
    if [[ ! -e "$BACKUP_DIR/$name" ]]; then cp -p -- "$target" "$BACKUP_DIR/$name"; fi
  fi
done

STAGE="$(mktemp -d "$MANAGED_DIR/.codex-worker-delegation.XXXXXX")"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT

export CWD_MANAGED_NODE_BIN="$NODE_BIN"
"$NODE_BIN" "$RENDERER" "$TEMPLATE_DIR" "$INSTALL_ROOT" "$DATA_DIR" "$MANAGED_DIR" "$PORT" "$STAGE"
bash -n "$STAGE/worker-delegation-policy.sh"
"$NODE_BIN" --check "$STAGE/worker-delegation-policy.mjs"

for name in "${TARGETS[@]}"; do
  install -m 0644 -- "$STAGE/$name" "$MANAGED_DIR/$name"
done
chmod 0755 -- "$MANAGED_DIR/worker-delegation-policy.sh"

MARKER_TMP="$MANAGED_DIR/.codex-worker-delegation-managed.$$.tmp"
{
  echo "$MARKER"
  echo 'version=1'
  echo "managed_dir=$MANAGED_DIR"
  echo "install_root=$INSTALL_ROOT"
  echo "data_dir=$DATA_DIR"
  echo "node_bin=$NODE_BIN"
  echo "port=$PORT"
} > "$MARKER_TMP"
chmod 0600 -- "$MARKER_TMP"
mv -f -- "$MARKER_TMP" "$OWNERSHIP_FILE"

echo "managed Worker Delegation hooks installed in $MANAGED_DIR"
echo 'next: npm run validate:managed-hooks'
