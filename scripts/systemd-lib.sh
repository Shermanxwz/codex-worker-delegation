#!/usr/bin/env bash

cwd_assert_safe_install_root() {
  local root="$1"
  local home="${HOME:-}"
  if [[ -z "$root" || "$root" != /* ]]; then echo "CWD install root must be an absolute path." >&2; return 2; fi
  if [[ "$root" =~ [[:cntrl:]] ]]; then echo "CWD install root contains control characters." >&2; return 2; fi
  local normalized
  normalized="$(readlink -m -- "$root" 2>/dev/null)" || { echo "Unable to normalize CWD install root: $root" >&2; return 2; }
  case "$normalized" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      echo "Refusing dangerous CWD install root: $normalized" >&2; return 2 ;;
  esac
  if [[ -n "$home" ]]; then
    local normalized_home
    normalized_home="$(readlink -m -- "$home" 2>/dev/null || printf '%s' "$home")"
    if [[ "$normalized" == "$normalized_home" ]]; then echo "Refusing to use HOME itself as the CWD install root: $normalized" >&2; return 2; fi
  fi
  printf '%s\n' "$normalized"
}

cwd_install_root() {
  local home="${HOME:-}"
  if [[ -z "$home" || "$home" != /* ]]; then echo "HOME must be an absolute path for Codex Worker Delegation deployment." >&2; return 2; fi
  # Deliberately anchor the default to HOME rather than ambient XDG variables.
  # ChatGPT/Codex authentication is identity-scoped by HOME; a stale inherited
  # XDG_DATA_HOME from another user must never redirect the production runtime.
  cwd_assert_safe_install_root "${CWD_INSTALL_ROOT:-$home/.local/share/codex-worker-delegation}"
}

cwd_scope_file() { local install_root="${1:-$(cwd_install_root)}"; printf '%s\n' "$install_root/systemd-scope"; }

cwd_systemd_scope() {
  local install_root="${1:-$(cwd_install_root)}"
  local requested="${CWD_SYSTEMD_SCOPE:-auto}" stored=''
  if [[ -f "$(cwd_scope_file "$install_root")" ]]; then stored="$(head -n 1 "$(cwd_scope_file "$install_root")" 2>/dev/null || true)"; fi
  case "$requested" in
    user|system) printf '%s\n' "$requested" ;;
    auto|'') if [[ "$stored" == 'user' || "$stored" == 'system' ]]; then printf '%s\n' "$stored"; elif (( EUID == 0 )); then printf 'system\n'; else printf 'user\n'; fi ;;
    *) echo "CWD_SYSTEMD_SCOPE must be auto, user, or system (found: $requested)." >&2; return 2 ;;
  esac
}

cwd_systemd_dir() {
  local scope="${1:-$(cwd_systemd_scope)}"
  if [[ -n "${CWD_SYSTEMD_DIR:-}" ]]; then printf '%s\n' "$CWD_SYSTEMD_DIR"; elif [[ "$scope" == 'system' ]]; then printf '/etc/systemd/system\n'; else printf '%s\n' "$HOME/.config/systemd/user"; fi
}

cwd_service_file() { local scope="${1:-$(cwd_systemd_scope)}"; printf '%s/codex-worker-delegation.service\n' "$(cwd_systemd_dir "$scope")"; }

cwd_systemctl() { local scope="$1"; shift; if [[ "$scope" == 'system' ]]; then systemctl "$@"; else systemctl --user "$@"; fi; }

cwd_service_user() {
  local scope="$1" service_file user
  if [[ "$scope" != 'system' ]]; then id -un; return 0; fi
  if [[ -n "${CWD_SYSTEMD_SERVICE_USER:-}" ]]; then printf '%s\n' "$CWD_SYSTEMD_SERVICE_USER"; return 0; fi
  service_file="$(cwd_service_file "$scope")"
  if [[ -r "$service_file" ]]; then
    user="$(sed -n 's/^[[:space:]]*User=//p' "$service_file" | head -1)"
    [[ -n "$user" ]] && { printf '%s\n' "$user"; return 0; }
  fi
  if command -v systemctl >/dev/null 2>&1; then
    user="$(cwd_systemctl "$scope" show codex-worker-delegation.service -p User --value 2>/dev/null || true)"
    [[ -n "$user" ]] && { printf '%s\n' "$user"; return 0; }
  fi
  printf 'root\n'
}

cwd_service_group() {
  local scope="$1" service_file group
  if [[ "$scope" != 'system' ]]; then id -gn; return 0; fi
  if [[ -n "${CWD_SYSTEMD_SERVICE_GROUP:-}" ]]; then printf '%s\n' "$CWD_SYSTEMD_SERVICE_GROUP"; return 0; fi
  service_file="$(cwd_service_file "$scope")"
  if [[ -r "$service_file" ]]; then
    group="$(sed -n 's/^[[:space:]]*Group=//p' "$service_file" | head -1)"
    [[ -n "$group" ]] && { printf '%s\n' "$group"; return 0; }
  fi
  if command -v systemctl >/dev/null 2>&1; then
    group="$(cwd_systemctl "$scope" show codex-worker-delegation.service -p Group --value 2>/dev/null || true)"
    [[ -n "$group" ]] && { printf '%s\n' "$group"; return 0; }
  fi
  printf 'root\n'
}

cwd_user_home() {
  local user="$1" entry home
  if command -v getent >/dev/null 2>&1; then
    entry="$(getent passwd "$user" 2>/dev/null || true)"
  else
    entry="$(awk -F: -v name="$user" '$1 == name { print; exit }' /etc/passwd 2>/dev/null || true)"
  fi
  home="$(printf '%s\n' "$entry" | awk -F: 'NF >= 6 { print $6; exit }')"
  [[ -n "$home" && "$home" == /* ]] || { echo "Unable to resolve an absolute home for service user: $user" >&2; return 2; }
  printf '%s\n' "$home"
}

cwd_run_as_service_user() {
  local scope="$1" user="$2" home="$3" codex_home="$4"
  shift 4
  if [[ "$scope" != 'system' || "$user" == 'root' ]]; then
    "$@"
    return
  fi
  [[ "$EUID" -eq 0 ]] || { echo "System-scope user switching requires root." >&2; return 2; }
  command -v runuser >/dev/null 2>&1 || { echo "runuser is required for system-scope user configuration writes." >&2; return 2; }
  [[ "$home" == /* && "$codex_home" == /* ]] || { echo "Service HOME and CODEX_HOME must be absolute paths." >&2; return 2; }
  runuser -u "$user" -- env HOME="$home" CODEX_HOME="$codex_home" USER="$user" LOGNAME="$user" "$@"
}

cwd_write_systemd_scope() {
  local install_root="$1" scope="$2" file tmp
  install_root="$(cwd_assert_safe_install_root "$install_root")" || return
  [[ "$scope" == 'user' || "$scope" == 'system' ]] || return 2
  file="$(cwd_scope_file "$install_root")"; tmp="$file.$$.tmp"; mkdir -p "$install_root"; printf '%s\n' "$scope" > "$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$file"
}
