#!/bin/bash
# ---- The pre-commit test battery ----
# Runs everything that needs no network, in cheap-fail-first order:
#   1. syntax check every js/ file
#   2. behavior-tests  — game-mechanics assertions (headless sim)
#   3. hud-tests       — command + DOM assertions (real index.html)
#   4. sim smoke       — one seeded 20k-tick self-play match twice:
#                        findings must be empty and the two checksums equal
#                        (whole-match health + run-to-run determinism)
# tools/mp-tests.js (live PeerJS lockstep) is NOT included — it needs
# network; run it separately when the netcode or command shapes change.
#
#   tools/run-tests.sh            # everything
#   tools/run-tests.sh fast       # skip the sim smoke (~1 min faster)
set -e
cd "$(dirname "$0")/.."

echo "== syntax =="
for f in js/*.js; do node --check "$f"; done
echo "ok"

echo "== behavior-tests =="
node tools/behavior-tests.js

echo "== hud-tests =="
node tools/hud-tests.js

if [ "$1" != "fast" ]; then
  echo "== sim smoke (seed 2001, 20k ticks, x2 for determinism) =="
  A=$(tools/simulate.sh seed=2001 diff=hard ticks=20000 2>/dev/null)
  B=$(tools/simulate.sh seed=2001 diff=hard ticks=20000 2>/dev/null)
  node -e '
    const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]);
    const bad = [];
    if (a.findings.length) bad.push("findings: " + JSON.stringify(a.findings));
    if (a.health.jsErrors.length) bad.push("jsErrors: " + JSON.stringify(a.health.jsErrors));
    if (a.end.checksum !== b.end.checksum) bad.push("NONDETERMINISTIC: " + a.end.checksum + " vs " + b.end.checksum);
    if (bad.length) { console.error("FAIL  [sim-smoke] " + bad.join("; ")); process.exit(1); }
    console.log("PASS  [sim-smoke] clean + deterministic (checksum " + a.end.checksum + ")");
  ' "$A" "$B"
fi

echo
echo "All test suites passed."
