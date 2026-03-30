#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Cleanup Script
# Contract: stop the server, persist logs.

if [ -f ".adapter-server.pid" ]; then
  PID=$(cat .adapter-server.pid)

  if kill -0 "$PID" 2>/dev/null; then
    echo "[adapter-k8s] Stopping server (PID: ${PID})..."

    # Graceful shutdown
    kill -TERM "$PID" 2>/dev/null || true

    # Wait up to 5 seconds
    ATTEMPTS=0
    while [ $ATTEMPTS -lt 50 ] && kill -0 "$PID" 2>/dev/null; do
      sleep 0.1
      ATTEMPTS=$((ATTEMPTS + 1))
    done

    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
      echo "[adapter-k8s] Force killing server..."
      kill -KILL "$PID" 2>/dev/null || true
    fi

    echo "[adapter-k8s] Server stopped."
  else
    echo "[adapter-k8s] Server already stopped."
  fi

  rm -f .adapter-server.pid
fi

# Persist server log for debugging
if [ -f ".adapter-server.log" ]; then
  PERSIST_PATH="${ADAPTER_K8S_PERSIST_SERVER_LOG:-/tmp/adapter-k8s-last-server.log}"
  cp .adapter-server.log "$PERSIST_PATH" 2>/dev/null || true
fi

# Output any final server log lines
if [ -f ".adapter-server.log" ]; then
  echo "=== Final Server Log ==="
  tail -20 .adapter-server.log
fi
