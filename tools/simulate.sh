#!/bin/bash
# Headless self-play simulator runner. Examples:
#   tools/simulate.sh                          # 1v1 standard, 60k ticks
#   tools/simulate.sh mode=2v2 diff=hard ticks=120000 seed=42
#   tools/simulate.sh mode=1v1 rollback=1 | jq '.findings'
# Prints the sim report JSON on stdout.
set -euo pipefail
cd "$(dirname "$0")/.."

# PID-derived port: parallel sims can never collide (RANDOM could — and a
# collision made one sim load its JS from a SIBLING's server, then hang
# forever when that sibling finished and tore the server down).
PORT=$((9000 + $$ % 20000))
QUERY=$(IFS='&'; echo "$*")
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

python3 -m http.server $PORT >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 0.5

"$CHROME" --headless=new --disable-gpu --virtual-time-budget=1800000 \
  --dump-dom "http://localhost:$PORT/tools/sim.html?$QUERY" 2>/dev/null \
  | python3 -c '
import sys, html
dom = sys.stdin.read()
marker = "<pre id=\"result\">"
i = dom.rfind(marker)
if i < 0:
    sys.exit("sim.html produced no result block")
body = dom[i + len(marker):]
body = body[:body.index("</pre>")]
print(html.unescape(body))'
