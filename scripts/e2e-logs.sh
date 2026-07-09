#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Logs Script
# Contract: output BUILD_ID, DEPLOYMENT_ID, NEXT_SUPPORTS_IMMUTABLE_ASSETS markers,
# then any additional logs for debugging.

# Output canonical markers first (required by test harness)
if [ -f ".adapter-build.log" ]; then
  grep -E "^(BUILD_ID|DEPLOYMENT_ID|NEXT_SUPPORTS_IMMUTABLE_ASSETS):" .adapter-build.log
fi

# Deploy log (captures all deploy script stderr)
if [ -f ".adapter-deploy.log" ]; then
  echo ""
  echo "=== Deploy Log ==="
  cat .adapter-deploy.log
fi

# Build log
if [ -f ".adapter-build.log" ]; then
  echo ""
  echo "=== Build Log ==="
  cat .adapter-build.log
fi

# Server log
if [ -f ".adapter-server.log" ]; then
  echo ""
  echo "=== Server Log ==="
  cat .adapter-server.log
fi

# Next.js trace
if [ -f ".next/trace" ]; then
  echo ""
  echo "=== Next.js Trace ==="
  cat .next/trace
fi
