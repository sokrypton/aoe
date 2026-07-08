# Headless self-play simulator

`tools/simulate.sh` runs an **all-AI match with no browser UI**, as fast as the
CPU allows, and prints a structured JSON report. It's the debugging and
balance-tuning workflow for this repo: reproduce a behavior with a fixed seed,
change the code, re-run the same seed, and compare.

## Quick start

```sh
tools/simulate.sh                               # 1v1 standard, 60k ticks
tools/simulate.sh mode=2v2 diff=hard ticks=120000 seed=42
tools/simulate.sh runs=6 diff=hard              # 6 seeds, aggregate summary
tools/simulate.sh rollback=1 | jq '.health.rollbackDeterministic'
tools/simulate.sh diff=hard seed=2001 | jq '.findings'
```

First run does a one-time `cd tools && npm install` (small — it drives the
**system Chrome** via `playwright-core`, no browser download). `simulate.sh` is
a thin wrapper around `node tools/simulate.js` (callable directly).

## Arguments (all `key=value`, order-independent)

| arg | default | meaning |
|-----|---------|---------|
| `mode` | `1v1` | `1v1` (2 teams) or `2v2` (4 teams, allied) |
| `diff` | `standard` | `easy`\|`standard`\|`hard`, or a comma list per team: `easy,hard` |
| `map` | medium (1v1) / large (2v2) | `small`\|`medium`\|`large` |
| `ticks` | `60000` | tick budget (30 ticks = 1 game-second) |
| `seed` | random | fixed seed → reproducible match |
| `rollback` | off | also run a snapshot→resim determinism check (`rollback=1`) |
| `runs` | `1` | run N seeds (`seed`+1000·i) and print an aggregate summary |
| `timeout` | scales w/ ticks | per-match evaluate cap (ms) |
| `headed` | off | `headed=1` shows the browser window (debugging) |

Exit code: `0` clean · `1` findings or JS errors observed · `2` harness failure.

## Report shape (single run)

- `config` — the resolved cfg.
- `timeline[]` — ~60 per-team samples: `age, vils, mil, rams, idleVils, food/wood/gold/stone, farms, exhaustedFarms, racks, swalls/pwalls, mills, houses, tcs, waves, defeated`.
- `events[]` — `age-up`, `attack-wave`, `vil-died` (with killer: `gaia`=wildlife or `teamN`), `tc-destroyed`, `knocked-out`, `lost-tc`, `rebuilt-tc`.
- `health` — `watchdogFires` (+verbatim `watchdogSamples`), `dancers`, `rollbackDeterministic`, `ticksPerSec`, `jsErrors`.
- `end` — `checksum`, `tick`, `gameOver`, `won`, `ages`, `defeated`, `milSnapshot` (every army unit's position/target/path).
- `findings[]` — auto-analysis of anomalies (see below).

`runs=N` instead prints `{batch, winners, findingsAcrossRuns (grouped by shape), avgTicksPerSec, anyErrors, runs:[brief per seed]}`.

## The workflow

1. **Reproduce** a bad behavior with a fixed `seed` and read `findings` + `watchdogSamples` + the team `timeline`.
2. **Fix** the code.
3. **Re-run the same seed** and diff the numbers.
4. **`end.checksum` proves behavior-neutral refactors**: same seed → identical checksum means you changed nothing the sim can observe. A changed checksum means real behavior change (expected when fixing/tuning, a red flag when refactoring).
5. Attribute combat target-drops by setting `window.__dropStats={}` before a run (killed / unreachable / visionDrop).

## Findings glossary (what the auto-analysis flags)

- `high watchdog rate: N fires` — units repeatedly wedging (stuck-watchdog freeing them). A **storm** (100s of fires) is a real pathing/placement bug; a low count (<~80) is normal friction.
- `teamN never left Dark Age` — economic stall or the losing side of a one-sided game.
- `teamN food-starved for the entire second half` — broken food economy (unworked/unreachable farms, or berries gone + no farms).
- `teamN has N chronically idle villagers` — gather/build assignment gap (often: resource unreachable, villager can't path to it).
- `teamN launched no attack waves … despite N military` — army stuck / can't path to the enemy.
- `slow sim: N ticks/sec` — pathfinding storm.
- `match did not resolve` — stalemate (both turtled).

## Gotchas — read before trusting results

- **Determinism is load-bearing (lockstep MP replays the sim).** After touching `sim.html`'s loop or anything in the sim path, ALWAYS check: same seed twice → identical `end.checksum`; and `rollback=1` → `health.rollbackDeterministic: true`. Only use sim-side randomness (`simRandom`/`simRandInt`) and sim state — never `Math.random`, `Date`, or wall-clock in the sim path.
- **The `gamePaused=true` trap (bit once).** `runSimulation` sets `gamePaused=true` and drives `update()` manually. The game's own `requestAnimationFrame` `gameLoop` (js/init.js) ALSO calls `update()` when `!gamePaused`, on a wall-clock accumulator — and because the batched loop yields between batches, leaving it unpaused lets the RAF loop interleave and double-step ticks nondeterministically (same seed → different checksum). If you change the loop, re-verify checksum reproducibility.
- **Single seeds mislead.** Map luck swings outcomes hard (an early bear cluster can wipe a team's villagers and doom its whole game). Use `runs=3+` before concluding anything; use larger batches for balance/pacing claims. A "regression" on one seed is often just variance — check the aggregate.
- **Headless must stay behavior-identical to live.** Only strip *non-sim* work behind `window.__headlessSim` (fog, particles, sounds, per-tick determinism hashing). Never gate actual game logic on it.
- **`startGame()` alone does NOT build the world / init `teamAge`.** The real match path is `onStartClicked → restartGame(diff) → startGame()`; `restartGame` is what calls `resetTeamAge()` etc. `runSimulation` uses the real path — if you script the game by hand, call `restartGame`.
- **Stray Chrome processes.** Many concurrent runs can leave zombie `headless_shell`/Chrome processes that contend for CPU and make a run look "hung" (a 120k hard match is ~30s; if it's minutes, suspect strays). Clean up with `pkill -f "[s]imulate.js"; pkill -f "[h]eadless_shell"`.
- **Resource 404s (favicon) are filtered** out of `jsErrors` by the driver — don't re-add them as sim errors.
- **Shell pattern gotcha:** `pgrep -f`/`pkill -f` patterns match the *calling* script's own command line — use `[b]racketed` patterns or explicit PIDs; never chain waiters on `pgrep` polling.

## Manual browser view

Open `tools/sim.html?run=1&mode=2v2&ticks=40000` in a normal browser; the report
renders into a `<pre id="result">`. The Playwright driver never sets `?run` — it
calls `window.runSimulation(cfg)` directly and reads the returned object.

## AI-tuning notes (context for future balance work)

- The AI reaches Castle and builds **rams** only if its **gold** keeps pace — `aiEcoPlan` biases gatherers toward the next age's cost resources while `savingForAge` (Castle needs 200 gold; a turtled AI used to starve gold and stall at Feudal forever).
- The wall ring reserves **two gates** (eco-facing + enemy-facing) built **gate-first**, so villagers are never sealed from their economy and the army never detours. A single gate → either eco-seal collapse or an army-detour pathfinding storm.
- **Known-wash lever (don't re-add naively):** pausing wall construction while `savingForAge` helps over-wallers but removes defense from teams that need it — net-neutral across difficulties, regressed a clean hard seed. Finer wall-vs-eco balance (partial Dark-Age walls, smaller rings) is the open recalibration lever, and needs many-seed statistical batches.
