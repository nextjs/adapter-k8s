#!/usr/bin/env bash
set -euo pipefail

# Cleanup for integration test stack — stops all three services.

for PID_FILE in .adapter-pool.pid .adapter-routing.pid .adapter-envoy.pid; do
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    SVC=$(basename "$PID_FILE" .pid | sed 's/\.adapter-//')
    if kill -0 "$PID" 2>/dev/null; then
      echo "[adapter-k8s] Stopping ${SVC} (PID: ${PID})..."
      kill -TERM "$PID" 2>/dev/null || true
      # Wait up to 3 seconds
      for i in $(seq 1 30); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.1
      done
      # Force kill
      if kill -0 "$PID" 2>/dev/null; then
        kill -KILL "$PID" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
done

# Stop Docker Envoy container if used
if [ -f ".adapter-envoy-container" ]; then
  CONTAINER=$(cat .adapter-envoy-container)
  if [ -n "$CONTAINER" ]; then
    docker stop "$CONTAINER" 2>/dev/null || true
  fi
  rm -f .adapter-envoy-container
fi

# Persist logs
PERSIST_DIR="${ADAPTER_K8S_PERSIST_LOGS:-/tmp/adapter-k8s-integration}"
mkdir -p "$PERSIST_DIR"
for LOG in .adapter-server.log .adapter-routing.log .adapter-envoy.log; do
  if [ -f "$LOG" ]; then
    cp "$LOG" "${PERSIST_DIR}/$(basename "$LOG")" 2>/dev/null || true
  fi
done

# Final log dump
echo "=== Pool Server ==="
tail -10 .adapter-server.log 2>/dev/null || echo "(no log)"
echo "=== Routing Service ==="
tail -10 .adapter-routing.log 2>/dev/null || echo "(no log)"
echo "=== Envoy ==="
tail -10 .adapter-envoy.log 2>/dev/null || echo "(no log)"
