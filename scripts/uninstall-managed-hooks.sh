#!/usr/bin/env bash
set -euo pipefail

MARKER='codex-worker-delegation-managed-hooks-v1'
MANAGED_DIR_RAW="${CWD_MANAGED_HOOKS_DIR:-/etc/codex}"
[[ "$MANAGED_DIR_RAW" = /* && "$MANAGED_DIR_RAW" != *$'\n'* && "$MANAGED_DIR_RAW" != *$'\r'* && "$MANAGED_DIR_RAW" != *[[:space:]]* ]] || { echo 'managed hook uninstall failed: managed hook directory must be an absolute path without whitespace' >&2; exit 2; }
[[ ! -L "$MANAGED_DIR_RAW" ]] || { echo 'managed hook uninstall failed: managed hook directory must not be a symlink' >&2; exit 2; }
MANAGED_DIR="$(readlink -m -- "$MANAGED_DIR_RAW")"
OWNERSHIP_FILE="$MANAGED_DIR/.codex-worker-delegation-managed"
BACKUP_DIR="$MANAGED_DIR/.codex-worker-delegation-backup"
TARGETS=(requirements.toml worker-delegation-policy.sh worker-delegation-policy.mjs)

fail() { echo "managed hook uninstall failed: $*" >&2; exit 2; }
[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail 'system-managed hooks require root'
[[ -f "$OWNERSHIP_FILE" ]] || fail "$MANAGED_DIR is not owned by this project"
[[ ! -L "$OWNERSHIP_FILE" ]] || fail 'ownership marker must not be a symlink'
grep -Fqx "$MARKER" "$OWNERSHIP_FILE" || fail "$OWNERSHIP_FILE has an unknown owner marker"

for name in "${TARGETS[@]}"; do
  target="$MANAGED_DIR/$name"
  [[ ! -L "$target" ]] || fail "$target is a symlink; refusing to remove it"
  if [[ -e "$target" ]] && ! grep -Fq "$MARKER" "$target"; then fail "$target is not a generated project file; refusing to remove it"; fi
done

for name in "${TARGETS[@]}"; do
  target="$MANAGED_DIR/$name"
  backup="$BACKUP_DIR/$name"
  if [[ -e "$backup" ]]; then
    mv -f -- "$backup" "$target"
  else
    rm -f -- "$target"
  fi
done
rm -f -- "$OWNERSHIP_FILE"
rmdir -- "$BACKUP_DIR" 2>/dev/null || true
echo "managed Worker Delegation hooks removed from $MANAGED_DIR"
