#!/usr/bin/env bash

# Portable mkdir-based locks for the e2e harness. `flock` is absent on stock macOS,
# while mkdir is atomic on both macOS and Linux.

e2e_lock_mtime() {
  local path="$1"
  case "$(uname -s)" in
    Darwin) stat -f %m "$path" 2>/dev/null ;;
    *) stat -c %Y "$path" 2>/dev/null ;;
  esac
}

e2e_lock_acquire() {
  local lock_dir="$1"
  local timeout_seconds="$2"
  local ownerless_grace_seconds="${3:-60}"
  local lock_pid="${BASHPID:-$$}"
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local attempt=0
  local lock_owner lock_mtime lock_age stale_lock now

  while :; do
    attempt=$((attempt + 1))
    if mkdir "$lock_dir" 2>/dev/null; then
      if ! printf '%s\n' "$lock_pid" > "${lock_dir}/owner"; then
        rmdir "$lock_dir" 2>/dev/null || true
        return 1
      fi
      return 0
    fi

    lock_owner="$(cat "${lock_dir}/owner" 2>/dev/null || true)"
    stale_lock="${lock_dir}.stale.${lock_pid}.${attempt}"
    if [[ "$lock_owner" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_owner" 2>/dev/null; then
      # Rename first so only one waiter can claim an abandoned lock. It also prevents a
      # waiter from deleting a new lock acquired at the original path.
      if mv "$lock_dir" "$stale_lock" 2>/dev/null; then
        rm -rf "$stale_lock"
      fi
    elif [ -z "$lock_owner" ]; then
      # An interrupted creator can leave the directory before writing owner. Do not race
      # the normal mkdir-to-write window: reclaim it only after a cross-platform age check.
      now="$(date +%s)"
      lock_mtime="$(e2e_lock_mtime "$lock_dir" || printf '%s\n' "$now")"
      lock_age=$((now - lock_mtime))
      if [ "$lock_age" -ge "$ownerless_grace_seconds" ]; then
        if mv "$lock_dir" "$stale_lock" 2>/dev/null; then
          rm -rf "$stale_lock"
        fi
      fi
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep "${E2E_LOCK_POLL_SECONDS:-0.1}"
  done
}

e2e_lock_release() {
  local lock_dir="$1"
  local lock_pid="${BASHPID:-$$}"
  local lock_owner

  lock_owner="$(cat "${lock_dir}/owner" 2>/dev/null || true)"
  if [ "$lock_owner" != "$lock_pid" ]; then
    return 0
  fi
  rm -f "${lock_dir}/owner"
  rmdir "$lock_dir" 2>/dev/null || true
}
