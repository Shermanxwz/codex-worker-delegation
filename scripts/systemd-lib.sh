#!/usr/bin/env bash

cwd_install_root() {
  local home="${HOME:-}"
  if [[ -z "$home" || "$home" != /* ]]; then
    echo "HOME must be an absolute path for Codex Worker Delegation deployment." >&2
    return 2
  fi
  printf '%s\n' "${CWD_INSTALL_ROOT:-${XDG_DATA_HOME:-$home/.local/share}/codex-worker-delegation}"
}

cwd_scope_file() {
  local install_root="${1:-$(cwd_install_root)}"
  printf '%s\n' "$install_root/systemd-scope"
}

cwd_systemd_scope() {
  local install_root="${1:-$(cwd_install_root)}"
  local requested="${CWD_SYSTEMD_SCOPE:-auto}"
  local stored=''
  if [[ -f "$(cwd_scope_file "$install_root")" ]]; then
    stored="$(head -n 1 "$(cwd_scope_file "$install_root")" 2>/dev/null || true)"
  fi
  case "$requested" in
    user|system) printf '%s\n' "$requested" ;;
    auto|'')
      if [[ "$stored" == 'user' || "$stored" == 'system' ]]; then
        printf '%s\n' "$stored"
      elif (( EUID == 0 )); then
        printf 'system\n'
      else
        printf 'user\n'
      fi
      ;;
    *)
      echo "CWD_SYSTEMD_SCOPE must be auto, user, or system (found: $requested)." >&2
      return 2
      ;;
  esac
}

cwd_systemd_dir() {
  local scope="${1:-$(cwd_systemd_scope)}"
  if [[ -n "${CWD_SYSTEMD_DIR:-}" ]]; then
    printf '%s\n' "$CWD_SYSTEMD_DIR"
  elif [[ "$scope" == 'system' ]]; then
    printf '/etc/systemd/system\n'
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  fi
}

cwd_service_file() {
  local scope="${1:-$(cwd_systemd_scope)}"
  printf '%s/codex-worker-delegation.service\n' "$(cwd_systemd_dir "$scope")"
}

cwd_systemctl() {
  local scope="$1"
  shift
  if [[ "$scope" == 'system' ]]; then
    systemctl "$@"
  else
    systemctl --user "$@"
  fi
}

cwd_write_systemd_scope() {
  local install_root="$1"
  local scope="$2"
  local file tmp
  [[ "$scope" == 'user' || "$scope" == 'system' ]] || return 2
  file="$(cwd_scope_file "$install_root")"
  tmp="$file.$$.tmp"
  mkdir -p "$install_root"
  printf '%s\n' "$scope" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}
