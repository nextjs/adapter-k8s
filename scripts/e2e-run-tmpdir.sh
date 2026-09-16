#!/usr/bin/env bash

# Shared by the smoke and full-lane drivers. The caller owns the parent; each run owns one child.
create_e2e_run_tmpdir() {
  local root="$1"
  mkdir -p -- "$root"
  root="$(cd "$root" && pwd -P)"
  mktemp -d "${root}/adapter-k8s-run.XXXXXX"
}

cleanup_e2e_run_tmpdir() {
  local root="$1"
  local target="$2"
  local workspace="$3"
  [ -z "$target" ] && return 0

  root="$(cd "$root" 2>/dev/null && pwd -P)" || return 1
  if [ ! -d "$target" ]; then
    return 0
  fi
  target="$(cd "$target" 2>/dev/null && pwd -P)" || return 1

  local target_parent target_name
  target_parent="$(dirname "$target")"
  target_name="$(basename "$target")"
  if [ "$target" = "/" ] || [ "$target" = "$HOME" ] || [ "$target" = "$workspace" ] ||
    [ "$target_parent" != "$root" ] || [[ "$target_name" != adapter-k8s-run.* ]]; then
    echo "[adapter-k8s] refusing unsafe E2E temp cleanup target: ${target}" >&2
    return 1
  fi
  rm -rf -- "$target"
}

# Stop lane drivers before their scoped TMPDIR is removed. An EXIT-only cleanup trap can otherwise
# race descendants after TERM/HUP: the parent deletes files while Next, Playwright, or Docker still
# writes into them. Callers pass only PIDs they spawned for the current run.
list_e2e_process_tree() {
  local parent="$1"
  local child
  printf '%s\n' "$parent"
  while IFS= read -r child; do
    [ -n "$child" ] && list_e2e_process_tree "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

stop_e2e_children() {
  local pid member
  local members=()
  for pid in "$@"; do
    while IFS= read -r member; do
      [ -n "$member" ] && members+=("$member")
    done < <(list_e2e_process_tree "$pid")
  done
  for member in "${members[@]}"; do
    kill -TERM "$member" 2>/dev/null || true
  done

  local grace_ticks="${E2E_STOP_GRACE_TICKS:-50}"
  case "$grace_ticks" in
    "" | *[!0-9]*) grace_ticks=50 ;;
  esac
  local tick running
  for ((tick = 0; tick < grace_ticks; tick++)); do
    running=0
    for member in "${members[@]}"; do
      if kill -0 "$member" 2>/dev/null; then
        running=1
        break
      fi
    done
    [ "$running" -eq 0 ] && break
    sleep 0.1
  done

  # A TERM-ignoring shell can replace a killed child during the grace period. Re-list trees whose
  # roots still exist, then force the full surviving set down so cleanup always has a bound.
  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then
      while IFS= read -r member; do
        [ -n "$member" ] && members+=("$member")
      done < <(list_e2e_process_tree "$pid")
    fi
  done
  for member in "${members[@]}"; do
    kill -KILL "$member" 2>/dev/null || true
  done
  for pid in "$@"; do
    wait "$pid" 2>/dev/null || true
  done
}
