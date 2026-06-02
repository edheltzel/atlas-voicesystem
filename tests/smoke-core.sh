#!/bin/bash
set -euo pipefail
PORT="${PORT:-8889}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${ROOT}/.smoke-core.log"

PORT="$PORT" bun run "$ROOT/core/server.ts" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..20}; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://localhost:${PORT}/health" >/dev/null
curl -fsS -X POST "http://localhost:${PORT}/notify" \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false,"source":"smoke-test","session_id":"smoke"}' >/dev/null

echo "OK core smoke passed on :${PORT}"
