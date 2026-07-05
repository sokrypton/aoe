# Test suite

End-to-end multiplayer tests. Each test drives **two real browser contexts**
(host + guest) connected over actual PeerJS/WebRTC — nothing is mocked, so
these catch real sync, recovery, and input regressions.

## Setup (once)

```bash
npm install playwright        # anywhere on your PATH, or in this repo
npx playwright install chromium
```

Python 3 is used for the static file server (already on macOS).

## Run everything

```bash
./tests/run-all.sh
```

Starts a local server on port 8471, runs all four suites, and prints
`ALL SUITES PASSED` / a nonzero exit code. Override the port with
`AOE_PORT=9000 ./tests/run-all.sh`, or point at any running server with
`AOE_URL=http://localhost:9000/ node tests/mp-sync.js`.

## Run one suite

```bash
python3 -m http.server 8471 &     # serve the repo root
node tests/mp-sync.js
```

## What each suite covers

| Suite | Covers |
|---|---|
| `mp-sync.js` | The sync core: guest bootstrap, full-sync loss recovery (seq numbers + request-full-sync), 40% packet-loss burst, send backpressure, stuck-pause self-heal, marching-army convergence + bandwidth. |
| `mp-menus.js` | Menu & launch UX: settings persistence across reload, cancel-hosting, guest retry, guest minimal pause menu, pause broadcast both ways, auto game-over menus (Victory/Defeat), host Rematch restarting MP for both. |
| `mp-recovery.js` | Host crash recovery: `?host=` resume link reclaims the peer id, world recovered from the guest's mirror, commands round-trip afterward; Save button on the disconnect overlay downloads. |
| `mp-features.js` | Chat (both ways, HTML-injection safe), guest town bell garrison/release, movement prediction under 150ms simulated latency + convergence, forged `delete-units` immunity, protocol-version mismatch overlay. |

## Notes

- Tests use the dev fault-injection hooks in `js/net.js`
  (`NET_TEST_DELAY_MS`, `NET_TEST_DROP_RATE`, `NET_TEST_DROP_NEXT_FULL`) —
  browser devtools network throttling does **not** affect WebRTC, so these
  hooks are the only way to simulate a bad link locally.
- Every suite exits nonzero on failure, so they can gate a CI job or a
  pre-push hook.
- When the wire format changes, bump `NET_PROTOCOL_VERSION` in `js/net.js`
  — `mp-features.js` verifies the mismatch overlay, not the number itself.
