#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./systemd-lib.sh
source "$ROOT/scripts/systemd-lib.sh"

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

if [[ -z "${HOME:-}" || "$HOME" != /* ]]; then
  echo "HOME must be an absolute path belonging to the same Unix identity that runs ChatGPT Linux/Codex." >&2
  exit 2
fi
NODE_BIN="${CWD_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then echo "Node.js 20+ is required" >&2; exit 2; fi
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then echo "Node.js 20+ is required (found $($NODE_BIN --version))" >&2; exit 2; fi
CODEX="$(find_codex || true)"
if [[ -z "$CODEX" ]]; then echo "Official ChatGPT Linux bundled Codex/current Codex was not found" >&2; exit 2; fi
CODEX_VERSION="$($CODEX --version 2>&1 | head -1)"

printf 'Preflight: uid=%s home=%s node=%s codex=%s\n' "$EUID" "$HOME" "$($NODE_BIN --version)" "$CODEX_VERSION"
(cd "$ROOT" && "$NODE_BIN" scripts/check.mjs)
(cd "$ROOT" && "$NODE_BIN" --test test/*.test.mjs)

INSTALL_ROOT="$(cwd_install_root)"
SCOPE="$(cwd_systemd_scope "$INSTALL_ROOT")"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
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
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
auth_hash() { if [[ -f "$AUTH_FILE" ]]; then sha256sum "$AUTH_FILE" | awk '{print $1}'; else printf 'absent\n'; fi; }
AUTH_BEFORE="$(auth_hash)"

mkdir -p "$RELEASES"
chmod 700 "$INSTALL_ROOT" "$RELEASES" 2>/dev/null || true
if [[ ! -d "$RELEASE_DIR" ]]; then
  rm -rf "$RELEASE_DIR.tmp"
  mkdir -p "$RELEASE_DIR.tmp"
  (
    cd "$ROOT"
    tar --exclude='./.git' --exclude='./node_modules' --exclude='./.DS_Store' -cf - .
  ) | tar -C "$RELEASE_DIR.tmp" -xf -
  printf '%s\n' "$RELEASE_ID" > "$RELEASE_DIR.tmp/.release-id"
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
  set +e
  echo "Installation failed; restoring the pre-install deployment without modifying auth.json." >&2
  if (( HAD_CURRENT == 1 )) && [[ -d "$PREVIOUS" ]]; then
    rm -rf "$CURRENT.failed"
    [[ -d "$CURRENT" ]] && mv "$CURRENT" "$CURRENT.failed"
    mv "$PREVIOUS" "$CURRENT"
    rm -rf "$CURRENT.failed"
    CWD_SYSTEMD_SCOPE="$SCOPE" CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh" >/dev/null 2>&1
    if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
      cwd_systemctl "$SCOPE" daemon-reload >/dev/null 2>&1
      cwd_systemctl "$SCOPE" restart codex-worker-delegation.service >/dev/null 2>&1
    fi
    if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
      (cd "$CURRENT" && CODEX_BIN="$CODEX" bash scripts/install.sh) >/dev/null 2>&1
    fi
    if [[ -x "$INSTALL_ROOT/runtime/node" ]]; then
      (cd "$CURRENT" && CODEX_BIN="$CODEX" "$INSTALL_ROOT/runtime/node" src/cli.mjs install) >/dev/null 2>&1
    fi
  else
    if [[ -d "$CURRENT" ]]; then
      (cd "$CURRENT" && "$NODE_BIN" src/cli.mjs uninstall) >/dev/null 2>&1
    fi
    if [[ -n "$CODEX" ]]; then
      "$CODEX" plugin remove codex-worker-delegation@codex-worker-delegation-local --json >/dev/null 2>&1
      "$CODEX" plugin marketplace remove codex-worker-delegation-local --json >/dev/null 2>&1
    fi
    if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
      cwd_systemctl "$SCOPE" disable --now codex-worker-delegation.service >/dev/null 2>&1
    fi
    rm -f "$SERVICE_FILE"
    if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then cwd_systemctl "$SCOPE" daemon-reload >/dev/null 2>&1; fi
    rm -rf "$CURRENT"
  fi
  local auth_recovered
  auth_recovered="$(auth_hash)"
  if [[ "$AUTH_BEFORE" != "$auth_recovered" ]]; then
    echo "FATAL: auth.json changed during the failed install transaction. The installer will not overwrite official credentials; inspect the official ChatGPT/Codex login state manually." >&2
  fi
  exit "$status"
}
trap rollback_on_error ERR

CWD_SYSTEMD_SCOPE="$SCOPE" CWD_RELEASE_ROOT="$CURRENT" CWD_NODE_BIN="$NODE_BIN" bash "$CURRENT/scripts/install-service-unit.sh"
RUNTIME_NODE="$INSTALL_ROOT/runtime/node"
RUNTIME_NODE_SHA="$(sha256sum "$RUNTIME_NODE" | awk '{print $1}')"
export CODEX_BIN="$CODEX"
export CWD_NODE_BIN="$RUNTIME_NODE"
export CWD_SYSTEMD_SCOPE="$SCOPE"
export CWD_HOST="${CWD_HOST:-127.0.0.1}"
export CWD_PORT="${CWD_PORT:-8788}"

if [[ "${CWD_INSTALL_NO_SYSTEMD:-0}" != "1" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then echo "systemctl is required for the production service install" >&2; exit 2; fi
  cwd_systemctl "$SCOPE" daemon-reload
  cwd_systemctl "$SCOPE" enable --now codex-worker-delegation.service
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${CWD_PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl --silent --fail --max-time 2 "http://127.0.0.1:${CWD_PORT}/api/health" >/dev/null
fi

if [[ "${CWD_INSTALL_NO_PLUGIN:-0}" != "1" ]]; then
  (cd "$CURRENT" && CODEX_BIN="$CODEX" bash scripts/install.sh)
fi
(cd "$CURRENT" && "$RUNTIME_NODE" src/cli.mjs install)

AUTH_AFTER="$(auth_hash)"
if [[ "$AUTH_BEFORE" != "$AUTH_AFTER" ]]; then
  echo "FATAL: ChatGPT/Codex auth.json changed during installation; refusing seal and leaving official credentials untouched." >&2
  exit 1
fi
INSTALL_RECORD="$INSTALL_ROOT/install-record.json"
SERVICE_FILE="$(cwd_service_file "$SCOPE")"
"$RUNTIME_NODE" -e '
const fs=require("fs");
const [file,releaseId,authSha256,codexVersion,nodeVersion,runtimeNodeSha256,systemdScope,serviceFile,installRoot,home,codexHome,uid,user]=process.argv.slice(1);
const payload={schemaVersion:2,releaseId,installedAt:new Date().toISOString(),authSha256,authContract:"operation-scoped-preservation",codexVersion,nodeVersion,runtimeNodeSha256,systemdScope,serviceFile,installRoot,home,codexHome,uid:Number(uid),user};
const tmp=`${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp,JSON.stringify(payload,null,2)+"\n",{mode:0o600});
fs.renameSync(tmp,file);fs.chmodSync(file,0o600);
' "$INSTALL_RECORD" "$RELEASE_ID" "$AUTH_AFTER" "$CODEX_VERSION" "$($RUNTIME_NODE --version)" "$RUNTIME_NODE_SHA" "$SCOPE" "$SERVICE_FILE" "$INSTALL_ROOT" "$HOME" "${CODEX_HOME:-$HOME/.codex}" "$EUID" "$(id -un)"

CWD_SYSTEMD_SCOPE="$SCOPE" bash "$CURRENT/scripts/validate-deployment.sh"
trap - ERR

printf 'Installed release: %s\n' "$RELEASE_ID"
printf 'Current tree: %s\n' "$CURRENT"
printf 'Service scope: %s (%s)\n' "$SCOPE" "$SERVICE_FILE"
[[ -f "$PREVIOUS/.release-id" ]] && printf 'Rollback target: %s\n' "$(cat "$PREVIOUS/.release-id")"
printf 'ChatGPT auth.json preservation for this install transaction: PASS (%s)\n' "$AUTH_AFTER"
printf 'Pinned Node runtime: %s (%s)\n' "$RUNTIME_NODE" "$RUNTIME_NODE_SHA"
printf 'Install record: %s\n' "$INSTALL_RECORD"
printf 'Configure New API in the control plane, then execute: npm run seal:release\n'
