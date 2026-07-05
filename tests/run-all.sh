#!/bin/bash
# Runs the whole multiplayer test suite against a local static server.
# Usage: ./tests/run-all.sh   (from the repo root)
set -u
cd "$(dirname "$0")/.."

PORT="${AOE_PORT:-8471}"
export AOE_URL="http://127.0.0.1:${PORT}/"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
sleep 1

FAILED=0
for t in tests/mp-sync.js tests/mp-menus.js tests/mp-recovery.js tests/mp-features.js; do
  echo "=== $t ==="
  node "$t" || FAILED=1
  echo
done

if [ "$FAILED" -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $FAILED
