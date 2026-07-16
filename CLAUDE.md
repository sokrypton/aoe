# Age of Epochs II — codebase guide

A JavaScript reimplementation of Age of Empires II with deterministic lockstep
multiplayer. Two frontends share one engine: `index.html` (mobile + desktop,
streamlined HUD) and `classic.html` (AoE2-authentic look/controls). `editor.html`
is the map/scenario builder. All game logic is **simulation-compatible**: it
runs headless (tools/sim.html) so AI-vs-AI matches can be scripted, seeded, and
diffed — the long-term goal is agents improving `js/ai.js` through self-play.

## File map (js/)

| file | owns |
|---|---|
| `core.js` | constants (UNITS/BLDGS/AGES/AI_LEVELS), team model, sim PRNG + det-trig, per-team vision grids, market prices |
| `logic.js` | the sim: updateUnit/updateBuilding, combat, gathering, garrison, trade carts, guard posts, stuck-watchdog |
| `ai.js` | per-team AI (economy plan, walls, waves, retreat, militia) — see `docs/aoe2-ai-behavior.md` |
| `entities.js` | createUnit/createBuilding, footprint stamping |
| `pathfinding.js` | A* (`findPath`, stopDist mode), movement stepping |
| `commands.js` | THE command executors — every player action goes through `submitCommand` → exec\* on all peers |
| `input.js` | mouse/touch → command construction (viewer-side) |
| `lockstep.js` | lockstep netcode: command scheduling, snapshot ring, rollback, resync/rejoin |
| `net.js` / `net-sync.js` / `lobby.js` | PeerJS host-relay star, seat/token identity, lobby config |
| `determinism.js` | `simChecksum` / `detEntityHash` — the desync tripwire |
| `save.js` | save format **v4** (RLE map, derived `occupied`, RLE explored grids) |
| `loop.js` | the per-tick `update()` orchestrator |
| `init.js` | boot, menus, match start paths |
| `render*.js`, `ui.js`, `audio.js` | viewer-only (never read by the sim) |

## Timebase

`TPS` (js/core.js) = simulation ticks per game-second — a single BUILD
constant (20; classic-AoE2-like). Every tick duration is authored at its
canonical 30tps value and wrapped in `T30(x)`; never hardcode a tick-rate
literal in a formula (use `TPS`) or a raw tick duration (wrap in `T30`).
`TPS = 30` reproduces the pre-migration behavior bit-for-bit. Saves are
TPS-stamped (v5) and refuse to load across timebases.

## Determinism rules (the ones that bite)

The sim runs in lockstep on every peer; identical inputs must produce
bit-identical state. When touching anything the sim reads:

- **Randomness**: `simRandom()`/`simRandInt()` only. `Math.random` throws inside
  the tick under DET.strict. Cosmetic code (particles/audio) uses `randInt`.
- **Trig/float**: `simSin/simCos/simAtan2/simHypot` — `Math.sin` etc. differ
  between JS engines. `Math.sqrt` is exact and fine.
- **No wall clock**: never `Date.now`/`performance.now` in sim decisions.
- **Stable order**: every sort that feeds a sim decision needs a deterministic
  tiebreak (usually `|| a.id - b.id`); don't rely on `Array.sort` stability.
- **Hash new state**: any new entity field the sim reads on a later tick goes
  in `detEntityHash` (js/determinism.js); any new `AI_STATES` field goes in
  `freshAIState` (core.js) **and** the AI digest in `simChecksum`. Unhashed
  divergence surfaces as a mystery desync far from its cause.
- **Sim vs viewer**: anything `myTeam`-relative (fog grid, `scoutedByMe`,
  selection, popUsed cache) is viewer-local and must never steer sim logic.
- **`window.fogDisabled`** is a match-start-immutable, peer-synced SIM setting
  (SP options / MP lobby → `lockstep-start`). It is hashed when set. The
  game-over reveal uses `seeMapMode` — never flip fogDisabled mid-match.

## Team / control model

- Seat == team. `teamControllers[t]` is `{type:'human'|'ai', difficulty}` —
  the sim never checks `netRole`; an AI seat is just data, so host-vs-AI over
  a connection and kick-to-AI need no protocol changes.
- Per-team AI brains live in `AI_STATES[t]` (plain data: snapshot/save/hash it).
- Versioned formats (save v4, NET_PROTOCOL_VERSION) fail loudly and do NOT
  keep back-compat shims — bump the version and reject old data.

## Testing

`tools/run-tests.sh` is the pre-commit battery (syntax → behavior-tests →
hud-tests → sim smoke with determinism check). See `tools/README.md` for the
full tooling guide. Working rules:

- **Targeted while iterating**: run the suite closest to the blast radius;
  the full battery before committing. `tools/mp-tests.js` (needs network)
  only when netcode or command shapes change.
- **Sim workflow**: reproduce with a fixed seed (`tools/simulate.sh seed=N`),
  fix, re-run the same seed. `end.checksum` is the cross-version equivalence
  signal: a behavior-neutral change reproduces it exactly.
- **Combat features need wars**: peaceful 14–20k-tick sims never exercise
  combat code. Use 50k+ runs, temporary `window.__aiProbe` counters (unhashed,
  checksum-safe), or a staged scenario in behavior-tests.
- **Test entry points, not just mechanisms**: drive the real command/input
  shape (see the ram-boarding regression — the engine worked, the click path
  was dead).
- **Baseline trap**: if the tree has uncommitted work, `git stash`-comparing
  against HEAD compares against the wrong baseline. Prefer neutralizing new
  features via their knobs and diffing enabled-vs-neutral checksums.
- **Perf work**: profile first (`tools/profile-sim.js`), optimize only what
  shows, and hold every optimization to bit-identical seed checksums — a
  behavior-neutral change reproduces them exactly. Compare MEDIANS of 3+ runs
  (single-run tps swings ±10%). Exact-order float math and deterministic
  tiebreaks (entities order ≡ ascending id) must survive the rewrite.

## Conventions

- Comments state constraints and *why*, TERSELY — one to two lines. Sacred
  and never cut: determinism/lockstep contracts (hashing, iteration order,
  sim-vs-viewer, T30), AoE2 sn-* references. Never write: change-narration
  ("replaced the old X", "used to", "no longer"), milestone datelines,
  seed-by-seed war stories (keep the one-clause lesson), or line-number
  references to other files (file/function pointers only).
- One predicate/helper per concept (`isSoldierUnit`, `isRetreatingUnit`,
  `stashVillagerTask`, `stampBuildingFootprint`, `effectiveBuildCost`,
  `centerOf`/`centerTile` (fractional vs floored building centers — the split
  is load-bearing), `mapToScreen` (render-side world→screen), `byId`/`show`
  (DOM)) — never re-spell the raw check or math at call sites.
- AoE2 fidelity decisions and their AoE2-DE reference values live in
  `docs/aoe2-ai-behavior.md`; update its §11 table when closing a gap.
