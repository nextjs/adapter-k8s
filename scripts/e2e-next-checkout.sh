#!/usr/bin/env bash

# Fetch a branch, tag, or raw commit without passing the ref to `git clone --branch`, which
# rejects commit SHAs. The resulting checkout is detached for every ref type.
e2e_next_checkout_ref() {
  local checkout_dir="$1"
  local repository_url="$2"
  local ref="$3"
  local depth="${4:-25}"

  case "$ref" in
    -*)
      echo "Ref must not start with '-': ${ref}" >&2
      return 2
      ;;
  esac
  if ! [[ "$depth" =~ ^[1-9][0-9]*$ ]]; then
    echo "Fetch depth must be a positive integer: ${depth}" >&2
    return 2
  fi

  if [ ! -e "${checkout_dir}/.git" ]; then
    if [ -e "$checkout_dir" ] && [ ! -d "$checkout_dir" ]; then
      echo "Next.js checkout path exists and is not a directory: ${checkout_dir}" >&2
      return 2
    fi
    if [ -d "$checkout_dir" ] &&
      [ -n "$(find "$checkout_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo "Refusing to initialize a nonempty checkout directory: ${checkout_dir}" >&2
      return 2
    fi
    mkdir -p "$checkout_dir"
    git -C "$checkout_dir" init -q
    git -C "$checkout_dir" remote add origin "$repository_url"
  fi

  git -C "$checkout_dir" fetch --depth="$depth" origin "$ref"
  git -C "$checkout_dir" checkout --detach --force -q FETCH_HEAD
}
