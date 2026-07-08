#!/bin/bash
# Headless self-play simulator — thin wrapper around the Playwright driver
# (tools/simulate.js). Same CLI as before. Examples:
#   tools/simulate.sh                          # 1v1 standard, 60k ticks
#   tools/simulate.sh mode=2v2 diff=hard ticks=120000 seed=42
#   tools/simulate.sh runs=5 mode=1v1          # 5 seeds, aggregated summary
#   tools/simulate.sh rollback=1 | jq '.findings'
# Prints the sim report JSON on stdout. Uses the system Chrome via
# playwright-core (no browser download); installs the driver on first run.
set -euo pipefail
cd "$(dirname "$0")"

# One-time driver install (system Chrome is reused, so this is small/fast).
if [ ! -d node_modules/playwright-core ]; then
  echo "installing the Playwright driver (one-time)…" >&2
  npm install --silent
fi

exec node simulate.js "$@"
