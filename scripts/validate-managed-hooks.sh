#!/usr/bin/env bash
set -euo pipefail

MARKER='codex-worker-delegation-managed-hooks-v1'
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fail() { echo "managed hook validation failed: $*" >&2; exit 2; }

if [[ -n "${CWD_INSTALL_ROOT:-}" ]]; then INSTALL_ROOT="$(readlink -m -- "$CWD_INSTALL_ROOT")"; elif [[ "$(basename -- "$ROOT_DIR")" == current ]]; then INSTALL_ROOT="$(dirname -- "$ROOT_DIR")"; else INSTALL_ROOT="$ROOT_DIR"; fi
MANAGED_DIR_RAW="${CWD_MANAGED_HOOKS_DIR:-/etc/codex}"
[[ "$MANAGED_DIR_RAW" = /* && "$MANAGED_DIR_RAW" != *$'\n'* && "$MANAGED_DIR_RAW" != *$'\r'* && "$MANAGED_DIR_RAW" != *[[:space:]]* ]] || fail 'managed hook directory must be an absolute path without whitespace'
[[ ! -L "$MANAGED_DIR_RAW" ]] || fail 'managed hook directory must not be a symlink'
MANAGED_DIR="$(readlink -m -- "$MANAGED_DIR_RAW")"
NODE_BIN="${CWD_MANAGED_NODE_BIN:-${CWD_NODE_BIN:-}}"

OWNERSHIP_FILE="$MANAGED_DIR/.codex-worker-delegation-managed"
REQUIREMENTS="$MANAGED_DIR/requirements.toml"
WRAPPER="$MANAGED_DIR/worker-delegation-policy.sh"
POLICY="$MANAGED_DIR/worker-delegation-policy.mjs"
for file in "$OWNERSHIP_FILE" "$REQUIREMENTS" "$WRAPPER" "$POLICY"; do [[ -f "$file" ]] || fail "$file is missing"; done
[[ ! -L "$OWNERSHIP_FILE" && ! -L "$REQUIREMENTS" && ! -L "$WRAPPER" && ! -L "$POLICY" ]] || fail 'managed hook files must not be symlinks'
grep -Fqx "$MARKER" "$OWNERSHIP_FILE" || fail 'ownership marker is missing or unknown'
DATA_DIR="$(sed -n 's/^data_dir=//p' "$OWNERSHIP_FILE")"
RECORDED_NODE="$(sed -n 's/^node_bin=//p' "$OWNERSHIP_FILE")"
if [[ -z "${CWD_MANAGED_NODE_BIN:-}" && -z "${CWD_NODE_BIN:-}" && -n "$RECORDED_NODE" ]]; then NODE_BIN="$RECORDED_NODE"; fi
if [[ -z "$NODE_BIN" ]]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
[[ "$NODE_BIN" = /* && -x "$NODE_BIN" ]] || fail 'recorded Node.js executable is missing'
NODE_BIN="$(readlink -f -- "$NODE_BIN")"
"$NODE_BIN" -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(Number.isInteger(major) && major >= 20 ? 0 : 1)' || fail 'Node.js 20 or newer is required'
[[ "$DATA_DIR" = /* && -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail 'recorded data directory is missing or a symlink'
POLICY_RUNNER="$INSTALL_ROOT/current/plugins/codex-worker-delegation/hooks/run-policy.sh"
[[ -x "$POLICY_RUNNER" ]] || fail 'active release policy runner is missing or not executable'
grep -Fq 'allow_managed_hooks_only = true' "$REQUIREMENTS" || fail 'managed hook enforcement is not enabled'
grep -Fq "managed_dir = \"$MANAGED_DIR\"" "$REQUIREMENTS" || fail 'requirements.toml points at the wrong managed directory'
grep -Fq "command = \"$WRAPPER\"" "$REQUIREMENTS" || fail 'requirements.toml points at the wrong hook command'
grep -Fq 'CWD_HOOK_REQUIRE_CONTROL_PLANE=1' "$WRAPPER" || fail 'wrapper does not require control-plane health'
grep -Fq 'CWD_HOOK_CONTROL_PLANE_URL' "$WRAPPER" || fail 'wrapper does not pin the loopback health endpoint'
grep -Fq 'CWD_DATA_DIR' "$WRAPPER" || fail 'wrapper does not pin the data directory'
grep -Fq "$MARKER" "$WRAPPER" || fail 'wrapper marker is missing'
grep -Fq "$MARKER" "$POLICY" || fail 'bridge marker is missing'
grep -Fq 'CWD_MANAGED_POLICY_RUNNER' "$POLICY" || fail 'bridge does not use the installed policy runner'
grep -Fq 'findActiveWorkerIdentity' "$POLICY" || fail 'bridge does not map active Worker tasks'
[[ "$(stat -c '%a' "$REQUIREMENTS")" == 644 ]] || fail 'requirements.toml must be mode 0644'
[[ "$(stat -c '%a' "$WRAPPER")" == 755 ]] || fail 'worker-delegation-policy.sh must be mode 0755'
[[ "$(stat -c '%a' "$POLICY")" == 644 ]] || fail 'worker-delegation-policy.mjs must be mode 0644'
bash -n "$WRAPPER" || fail 'worker-delegation-policy.sh has invalid shell syntax'
"$NODE_BIN" --check "$POLICY" || fail 'worker-delegation-policy.mjs has invalid JavaScript syntax'
if grep -Fq 'CWD_HOOK_REQUIRE_CONTROL_PLANE=0' "$WRAPPER"; then fail 'wrapper contains a passwordless hook-health override'; fi

echo 'CWD_MANAGED_HOOKS_VALID'
