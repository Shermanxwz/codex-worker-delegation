#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${EUID}" -eq 0 && "${CWD_ALLOW_ROOT_INSTALL:-0}" != "1" ]]; then
  echo "Refusing a root install. Run this as the same desktop user that owns the ChatGPT/Codex login. Set CWD_ALLOW_ROOT_INSTALL=1 only for disposable CI." >&2
  exit 2
fi

find_codex() {
  local candidate
  for candidate in \
    "${CODEX_CLI_PATH:-}" \
    "${CODEX_BIN:-}" \
    "/usr/lib/chatgpt/resources/codex" \
    "${HOME}/.local/bin/codex" \
    "${HOME}/.codex/bin/codex" \
    "${HOME}/.codex/packages/standalone/current/bin/codex" \
    "${HOME}/.codex/packages/standalone/current/codex"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  command -v codex 2>/dev/null || return 1
}

NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then echo "Node.js 20+ is required" >&2; exit 2; fi
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then echo "Node.js 20+ is required (found $($NODE_BIN --version))" >&2; exit 2; fi
CODEX="$(find_codex || true)"
if [[ -z "$CODEX" ]]; then echo "Official ChatGPT Linux bundled Codex/current Codex was not found" >&2; exit 2; fi
CODEX_VERSION="$($CODEX --version 2>&1 | head -1)"

printf 'Preflight: %s / %s\n' "$($NODE_BIN --version)" "$CODEX_VERSION"
(cd "$ROOT" && "$NODE_BIN" scripts/check.mjs)
(cd "$ROOT" && "$NODE_BIN" --test test/*.test.mjs)

INSTALL_ROOT="${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-worker-delegation}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SYSTEMD_DIR/codex-worker-delegation.service"
VERSION="$($NODE_BIN -p "JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf8')).version")"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_ID="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
else
  SOURCE_ID="manual"
fi
RELEASE_ID="${CWD_RELEASE_ID:-v${VERSION}-${SOURCE_ID}}"
RELEASES="$INSTALL_ROOT/releases"
RELEASE_DIR="$RELEASES/$RELEASE_ID"
CURRENT="$INSTALL_ROOT/current"
PREVIOUS="$INSTALL_ROOT/previous"
NEXT="$INSTALL_ROOT/.next"

mkdir -p "$RELEASES" "$SYSTEMD_DIR"
chmod 700 "$INSTALL_ROOT" "$RELEASES" 2>/dev/null || true
if [[ ! -d "$RELEASE_DIR" ]]; then
  rm -rf "$RELEASE_DIR.tmp"
  mkdir -p "$RELEASE_DIR.tmp"
  (
    cd "$ROOT"
    tar --exclude='./.git' --exclude='./node_modules' --exclude='./.DS_Store' -cf - .
  ) | tar -C "$RELEASE_DIR.tmp" -xf -
  printf '%s\n' "$RELEASE_ID" >"$RELEASE_DIR.tmp/.release-id"
  find "$RELEASE_DIR.tmp/scripts" "$RELEASE_DIR.tmp/plugins/codex-worker-delegation" -type f -name '*.sh' -exec chmod 755 {} +
  mv "$RELEASE_DIR.tmp" "$RELEASE_DIR"
fi

rm -rf "$NEXT"
cp -a "$RELEASE_DIR" "$NEXT"
HAD_CURRENT=0
if [[ -d "$CURRENT" ]]; then
  HAD_CURRENT=1
  rm -rf "$PREVIOUS"
  mv "$CURRENT" "$PREVIOUS"
fi
mv "$NEXT" "$CURRENT"

rollback_on_error() {
  local status=$?
  trap - ERR
  if (( status != 0 )); then
    echo "Installation failed; restoring previous release." >&2
    rm -rf "$CURRENT.failed"
    [[ -d "$CURRENT" ]] && mv "$CURRENT" "$CURRENT.failed" || true
    if (( HAD_CURRENT == 1 )) && [[ -d "$PREVIOUS" ]]; then mv "$PREVIOUS" "$CURRENT" || true; fi
    if [[ -d "$CURRENT" ]]; then CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh" >/dev/null 2>&1 || true; fi
    if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      systemctl --user restart codex-worker-delegation.service >/dev/null 2>&1 || true
    fi
    if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" && -d "$CURRENT" ]]; then
      (cd "$CURRENT" && CODEX_BIN="$CODEX" bash scripts/install.sh) >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap rollback_on_error ERR

CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh"

AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash() { if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
AUTH_BEFORE="$(auth_hash)"

export CODEX_BIN="$CODEX"
export CWD_NODE_BIN="$NODE_BIN"
export CWD_HOST="${CWD_HOST:-127.0.0.1}"
export CWD_PORT="${CWD_PORT:-8788}"

if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then echo "systemctl is required for the production user-service install" >&2; exit 2; fi
  systemctl --user daemon-reload
  systemctl --user enable --now codex-worker-delegation.service
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${CWD_PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl --silent --fail --max-time 2 "http://127.0.0.1:${CWD_PORT}/api/health" >/dev/null
fi

if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
  (cd "$CURRENT" && bash scripts/install.sh)
fi
(cd "$CURRENT" && "$NODE_BIN" src/cli.mjs install)

AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then
  echo "FATAL: ChatGPT/Codex auth.json changed during installation; refusing seal." >&2
  exit 1
fi
INSTALL_RECORD="$INSTALL_ROOT/install-record.json"
"$NODE_BIN" -e 'const fs=require("fs");const [file,releaseId,authSha256,codexVersion,nodeVersion]=process.argv.slice(1);fs.writeFileSync(file,JSON.stringify({schemaVersion:1,releaseId,installedAt:new Date().toISOString(),authSha256,codexVersion,nodeVersion},null,2)+"\n",{mode:0o600});fs.chmodSync(file,0o600)' "$INSTALL_RECORD" "$RELEASE_ID" "$AUTH_AFTER" "$CODEX_VERSION" "$($NODE_BIN --version)"
trap - ERR

printf 'Installed release: %s\n' "$RELEASE_ID"
printf 'Current tree: %s\n' "$CURRENT"
[[ -f "$PREVIOUS/.release-id" ]] && printf 'Rollback target: %s\n' "$(cat "$PREVIOUS/.release-id")"
printf 'ChatGPT auth.json preservation: PASS (%s)\n' "$AUTH_AFTER"
printf 'Install record: %s\n' "$INSTALL_RECORD"
printf 'Run the Web control plane to configure New API, then execute: npm run seal:release\n'
