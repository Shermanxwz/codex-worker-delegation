#!/usr/bin/env bash
set -euo pipefail
INSTALL_ROOT="${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-worker-delegation}"
CURRENT="$INSTALL_ROOT/current"
PREVIOUS="$INSTALL_ROOT/previous"
SWAP="$INSTALL_ROOT/.rollback-swap"
PORT="${CWD_PORT:-8788}"
if [[ ! -d "$CURRENT" || ! -d "$PREVIOUS" ]]; then
  echo "No complete previous release is available for rollback." >&2
  exit 2
fi
CURRENT_ID="$(cat "$CURRENT/.release-id" 2>/dev/null || echo unknown)"
PREVIOUS_ID="$(cat "$PREVIOUS/.release-id" 2>/dev/null || echo unknown)"
rm -rf "$SWAP"
mv "$CURRENT" "$SWAP"
mv "$PREVIOUS" "$CURRENT"
mv "$SWAP" "$PREVIOUS"
if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  systemctl --user daemon-reload
  systemctl --user restart codex-worker-delegation.service
  for _ in $(seq 1 40); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null
fi
if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
  (cd "$CURRENT" && bash scripts/install.sh)
fi
printf 'Rolled back from %s to %s.\n' "$CURRENT_ID" "$PREVIOUS_ID"
printf 'Former current release is retained as the next rollback target.\n'
