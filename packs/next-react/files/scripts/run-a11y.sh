#!/usr/bin/env bash
# run-a11y.sh — start dev server, axe-scan changed components, stop server.
# Args: space-separated component names (e.g. "Button Card")
# Exit 0 = clean, 1 = axe violations or scan error, 2 = setup failure.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "run-a11y: no components to scan, skipping." >&2
  exit 0
fi

PORT="${DEV_PORT:-3000}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-30}"

# Find package manager
if [ -f "yarn.lock" ]; then PM="yarn"; elif [ -f "pnpm-lock.yaml" ]; then PM="pnpm"; else PM="npm"; fi

# Start dev server in background
echo "run-a11y: starting dev server on port ${PORT}..." >&2
$PM run dev -- --port "$PORT" &>/tmp/run-a11y-devserver.log &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for port to be reachable
echo "run-a11y: waiting for port ${PORT}..." >&2
elapsed=0
until curl -sf "http://localhost:${PORT}" >/dev/null 2>&1; do
  if [ $elapsed -ge "$WAIT_TIMEOUT" ]; then
    echo "run-a11y: dev server did not start within ${WAIT_TIMEOUT}s" >&2
    cat /tmp/run-a11y-devserver.log >&2
    exit 2
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
echo "run-a11y: server ready." >&2

# Run a11y-scan.ts with the component list and port
node --experimental-strip-types scripts/a11y-scan.ts "$PORT" "$@"
