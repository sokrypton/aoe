# AI + simulation redesign

Status: phases 0–5 built, 6 under way (2026-10-13, uncommitted). The plan below is kept as written; *As built* notes say where
the build differs.

## Why

Watching two late-game saves (4 hard AIs, ~57 and ~83 game-minutes) showed the same failure shape again and again:
each system is reasonable alone, and the bugs are in how they interact.

| What the player saw | What was happening |
|---|---|
| Frames skipping every ~1 s | All four AIs re-planned camp sites on the same tick; each candidate ran an exhaustive A* that a crowd round the TC made fail. ~170 ms ticks. |
| Armies bashing walls for minutes | A crowd-stall (units in the way) was treated as "walled off" and redirected soldiers to the nearest stone wall: 1 damage a hit, outpaced by repair. 28 % of all soldier time. |
| Armies standing idle at a walled town | Infantry picked a wall → a cap dropped it → the stray pass picked the next wall → … Rams stamped "unreachable" on the wall they touched. |
| Whole economies frozen | The bell sheltered everyone within 25 tiles; with an enemy camp parked nearby the all-clear never came. 55 of 59 villagers hidden or waiting at full doors for the rest of the game. |
| Rich AI with a shrinking army | Team 2 banked 5 000 food / 2 500 gold with 27 free pop while its army fell from 27 to 10. |
| Trade carts stuck | 12 of 28 carts gridlocked by units at the map edge, re-pathing every tick. |

Each was patched in place first (phase 0), but the patches added to the problem below.

## What existed (before the redesign)

`ai.js` (3 170 lines) and `logic.js` (4 300 lines) — now ~2 850 and ~4 070. Full inventories were taken; the headline numbers:

- **`ai.js` has ~20 systems** run in a fixed order each decision tick (`updateAI` → planners → `controlAIMilitary`).
  Two of them can consume the tick (`aiThreatResponse`, `aiSiegePostureHold`).
- **~45 patch mechanisms** across the two files: retry keys (`RETRY.*`, 13), unreachable stamps (one slot per unit,
  6 writers), back-off fields (`buildBackoffUntil` ×2, `rescueOpenUntil`, `leashCooling`, `retreatUntil`), latches
  (`campAssault`), vetoes (`aiCampVeto`, eco-fund all-keys check), windows (`militiaUntil`, `AI_GARRISON_HOLD_TICKS`),
  hysteresis radii, throttles. Each comment names the symptom it fixed; few name the cause.
- **15 known conflicts** where two systems order the same unit on the same or alternating ticks — e.g. hopeless-chase
  clears a target that the stray pass re-assigns the same tick; camp hold clears targets three other passes set;
  egress breach vs wall self-heal can loop; shelter pass ejects a villager that the bell re-shelters.
- **Concepts spelled several ways**: "is it reachable" ×8 (`pathReaches`, `isTargetReachable`, `canReachBuilding`,
  `ticksToReachBuilding`, `findPath().length===0`, `aiBaseSealed`, `armyCanReachEnemy`, inline A* in acquire);
  approach/chase ×6; in-range ×5; leash ×4; "who holds this farm" ×4; target-drop written inline ~8 times; recall home ×3.
- **`updateUnit` is a 74-line dispatcher into ~15 concerns** (garrison, save/restore, follow, multi-leg move, re-aim,
  three wildlife AIs, trade, path stepping, combat, economy, scouting, idle acquire). The per-unit code spans ~2 100 lines.
- **AI logic inside the shared sim**: `aiDrives`/`isAITeam` branches in `logic.js` decide danger zones, wall
  breaching, retaliation, farm reseeding and fog exemptions — places where "the rules" quietly differ by controller.

The common cause: there is no shared model of *the situation* (where it's dangerous, what's reachable, what the army
is trying to do), so each system re-derives a partial view, acts on it, and the next system corrects it.

## Principles

1. **One answer per question.** A world query (reachable? dangerous? in range?) has exactly one function. Systems ask;
   they don't re-derive.
2. **Intent is state, behaviour follows from it.** A squad *is sieging*; its units' targets follow from that each tick.
   No pass assigns a target that another pass then clears.
3. **One owner per unit per tick.** Every unit has exactly one controller (squad, villager job, retreat) that issues
   its orders. Conflicts become impossible rather than patched.
4. **Shared rules are controller-blind.** `logic.js` holds the game's rules, identical for human and AI. AI judgement
   lives in `ai.js` and acts only through the same commands a player has.
5. **Fail by giving up cleanly, not by retrying.** When something can't be done, the owner picks something else (a
   different target, a different job) — not a stamp that expires and retries the same thing.
6. **Determinism unchanged.** Stable iteration (ascending id), `simRandom`, `simHypot`, hashed state — all existing
   rules (CLAUDE.md) hold. New AI state lives in `AI_STATES[t]` and goes in `freshAIState` + the checksum digest.

## Target architecture

### 1. World queries — `pathfinding.js` + a new `world.js` (shared, sim-side)

The single source for situational questions, cached per tick or per passability change.

| Query | Answers | Replaces |
|---|---|---|
| `regionsFor(walker)` / `pathReaches` / `regionReachesBuilding` | Reachable at all (ground, buildings, gates; units ignored). **Done.** | `isTargetReachable`, `canReachBuilding` (done); the idle-acquire probes (`regionReaches` / `regionReachesWithin` — the crowd-ring special case is gone); kept: `aiBaseSealed` / `armyCanReachEnemy` (they ask "what if this tile were walled", which regions can't) |
| `threatAt(team, x, y, r, kind)` | Fighting power near a point: seen enemies / seen enemy soldiers / allied soldiers. **Done.** | `aiThreatNear`, `estimateLocalEnemyPower`, `nearbyAlliedPower` (deleted); `findEnemyThreatNear` stays (a different question: nearest seen enemy to our buildings) |
| `dangerAt(team, x, y)` | Known-deadly ground (raid/bear zones). **Done.** | `aiVillagerSafeAt`'s zone half (its war-state half moves to the economy) |
| `wallBreachTicks` + `canBreach(unit, w)` | Ticks for this unit to break it; may it take it on at all. **Done.** | the four inline `WALL_BREACH_MAX` filters |
| `strikeDist` / `inStrikePosition` / `inWeaponRange` / `meleeCornerBlocked` | Approach goal (no slack), strike gate (+0.5 ranged slack), sealed corner. **Done.** | the inline melee/sheep range and corner checks in combat, approach and path-drop |

Regions are the base of everything else: they turn "can I get there" from a search into a lookup, which is what makes
the rest affordable.

### 2. Army — squads with explicit states (`ai.js`)

The army is a small set of squads, each owning its units. A squad has a goal and a state; each decision tick a squad
updates its state from the world queries, then issues orders to its units. No other pass touches squad units.

```
          ┌──────── retreat (power lost / HP) ───────┐
          ▼                                          │
 home ─► gather ─► march ─► engage ─► siege ─► raze ─┘
   ▲                 │         ▲        │
   └──── defend ◄────┴─────────┴────────┘   (base threatened: the defence squad pulls units)
```

- **gather** at a rally point until the launch bar (power vs intel) clears. Replaces wave cooldowns, `minGroup`
  clamps, hold checks, `waveJoin`.
- **march** to the objective (remembered TC / raid point). Replaces stray retask, `aiMarchPoint`, raider leash.
- **engage** units in the way: each unit takes the best target it can *reach* and *hurt*. Replaces
  `chooseAIAttackTarget`'s top-4 loop, hopeless-chase clear, camp veto.
- **siege** when the objective is walled (`regionReaches` false): rams take the cheapest breachable segment
  (`breachCost`), the rest escort the rams and hold outside fire; through the gap → **raze**. Replaces the camp
  posture, stall-to-wall redirect, ram banking special cases, `resolveReachableAttackTarget`'s breach maths.
- **retreat** on squad power loss (not per-unit stamps); regroup at the gather point.
- **defend**: one squad answers base threats sized by `threatAt`; it borrows from other squads explicitly.
  Replaces `aiThreatResponse`, `aiSiegePostureHold`, the outmatched pull-back and their exemption lists.

Units leave a squad only by dying, retreating, or being reassigned by the army planner — so the 15 conflicts can't arise.

*As built:* two squads, not a set. HOME is everyone not in the field: it holds the rally picket and answers enemies at
our town or an ally's (`aiDefendBase`). The FIELD squad (`ai.squad`) has two states — **march** (fight what's within
reach on the way) and **attack** (everything it can reach and hurt; with nothing, escort the rams to the breach) — and
comes home together on power loss, an outmatched home, or a stall. `chooseAIAttackTarget`, `resolveReachableAttackTarget`
and `aiMarchPoint` were kept as the squad's target and objective choice.

### 3. Villagers by danger (`ai.js` + shared garrison rules)

Each villager's job is its owner. Shelter is a per-villager state driven by `threatAt` near the villager and near its
job site: in danger → shelter (nearest room, else move away from the threat — never wait at a full door); clear →
back to the job. The bell, all-clear, militia break-out and recall become this one rule plus a "mob a small raider"
option. **Started**: `aiShelterPass` already shelters/releases per villager.

### 4. One economy budget (`ai.js`)

One allocator per decision tick: income estimate + priorities (age-up, villagers, army to target size, buildings,
techs, walls) → a budget per category, spent in priority order. Replaces `aiEcoFund` + `aiEcoFundClear`, `savingForAge`
gates scattered over six planners, `MARKET_FLOOR`/`MARKET_SURPLUS`, `militaryFoodReserve`, the farm/mill/bastion
wood yields, and `aiEcoPlan`'s stacked threshold modifiers (gatherer split follows the budget's shortfalls). Fixes the
banking: unspent resources are a signal to raise the army target or build production.

### 5. Unit logic as per-task controllers (`logic.js`)

`updateUnit` keeps its order (load-bearing) but each concern becomes one controller with one way to do each thing:

- **one approach primitive** (path to contact / to range, with crowd claims) instead of six;
- **one stall rule**: stalled → ask `regionReaches`; walled → the owner decides (human: approach; AI: squad), crowd →
  wait briefly. Retires `CHASE_BLOCKED` + `resolveStalledAttack`'s branches + the unreachable stamp's combat uses;
- **one target-drop helper** (`dropTarget(e)`) instead of ~8 inline copies;
- **one leash** (guard zone) for soldiers and animals;
- wildlife (sheep, bear, dragon) moves to `wildlife.js`;
- AI branches leave the shared rules: danger learning, farm reseeding and wall-breach choice move to `ai.js`.

## Migration

Incremental, one concept at a time, each step shippable and validated. No step deletes a patch until its replacement
is proven.

| Phase | Content | Validation |
|---|---|---|
| 0 **done** | Regions; `pathReaches` on regions; exact unreachable shortcut in `findPath`; trade carts pick reachable markets (and wait at a walled-off one); stall → wall only when truly walled; AI won't take on masonry it can't dent; shelter by danger; escort rams at a walled town | Battery green; 40-run hard A/B within noise; both saves fixed |
| 1 **done** | World queries: `threatAt`, `dangerAt`, `canBreach`, strike range; building reachability (`canReachBuilding`, `isTargetReachable`, `ticksToReachBuilding`) on regions — a crowd is no longer "walled off"; `tools/watch-save.js` | Queries checksum-identical (seeds 2001/7100/7200 + both saves); the reachability change: 40-run hard A/B within noise, saves no worse, battery green |
| 2 **done** | `dropTarget` (one target drop), one leash body, wildlife → `js/wildlife.js`. The approach primitive (`pathToContact`) and the stall controller (`combatApproach` → `resolveStalledAttack`, walled-vs-crowd by regions) were already single owners — left as they are | All checksum-identical |
| 3 **done** | The AI alarm is a state, not a ring/all-clear: `aiShelterPass` shelters and releases each villager every second (no job spot → judged where it hides); the alarm ends when the base isn't hit and nobody is left inside. Militia + break-out kept as the mob option | Battery green; 40-run A/B neutral; save 1: the raided team's villagers sheltered 52 % → 43 % of the time |
| 4 **done** | `controlAIMilitary` is the squad army: HOME (rally picket, every free soldier takes the nearest seen enemy in the town, else a creeping building) and one FIELD squad (`ai.squad`, hashed: march → attack → home together; Feudal raids are a small field squad; reinforcements beyond the reserve join it; the ram train deepens while it's at the enemy town) | Built behind a flag, then made the default: squads-hard beat wave-hard **33–6** over 40 games (both seats); ladder on squads hard>medium 16–4 (waves, same seeds: 14–4–2), medium>easy 20–0; battery green |
| 5 **done** | Bank-driven spending: `aiArmyTarget` (wave + reserve, raised by the bank beyond a 400 float, to the 200 pop limit); a deep bank (>1 500) keeps one gatherer and trades at the market for wood; one more barracks per deep resource; the ram quota stays on the base army. The eco fund (claims + all-keys brake) stays: it is already one function and one check, and banking was the failure | Long 2v2 hard games (seeds 501/502): banks peaked at 9–12 k food / 7–12 k gold with armies capped at 31 → stay under ~1.6 k with armies 40–46; 40-run A/B unchanged (no bank gets deep by 40 k ticks) |
| 6 **started** | Deleted the wave army: `launchAIWave` (stray retask, holds, wave-join), `dispatchAIWave`, the siege camp (`aiAttackCampControl`/veto/holding + 5 state fields), `aiThreatResponse`, `aiSiegePostureHold`, `aiForwardBuildingResponse`, the wave-casualty retreat, `aiDispatchQuota`, `isAIRaider`/`raidWave`, `sightedResponsePercent` (~500 lines). §11 rows updated | Battery green; ladder + A/B re-run |

**Save-file watch** (**built**: `node tools/watch-save.js save=… [ticks=] [root=<baseline checkout>]`). A reusable tool that loads a save, runs N ticks and reports per team:
villager idle/garrison/working %, soldier idle/moving/fighting/wall-bash %, stuck units, worst tick time. The two
saves from this investigation become fixtures; every phase reports against them.

## Also done alongside (uncommitted, 2026-10-13)

- **Regions mended in place**: every passability change calls `passabilityChangedAt(x,y,w,h)` after the mutation (open:
  join/merge through the tile; close: a local detour check, else relabel that one region). `passabilityChanged()` is for
  whole-map changes only (editor, scenario load). Full relabels 3 305 → 9 per 40k-tick 2v2; ~15 % faster sims.
- **Save v10 / NET 21**: saves carry the visible-tile grids and `nextProjectileId`, so a save taken between vision
  refreshes reloads checksum-exact (`save-v4` test plays the reloaded game on).
- **Shared rules**: `villagerEvade` (no shelter room → run from a soldier within 8, else work); a parked ram / stopped
  trade cart yields at gates; carts wait at a walled-off Market with their load; the first mining camp skips the eco
  fund; a butcher steps onto its tile centre for an off-centre carcass.

## Open questions

1. **Seats handed to the AI** — resolved: the seat's soldiers join HOME; a brain kept from before the seat went human
   has its field squad cleared (`set-controller`).
2. **Player-facing bell**: keep the AoE2 whole-town bell for players, or offer the danger-based behaviour as the
   default for players too?
3. **Difficulty**: today difficulty is mostly rates and thresholds spread through the planners. With a budget and
   squads it can be a small profile (launch bar, army share, reaction delay). Worth redefining the profiles then.
4. **Unit gridlock** — resolved: gates (a parked ram/trade cart yields to its own side — `gate-parked-yields`) and carts
   (reachable markets; a walled-off one waited out — `cart-gate-wait`). In all three investigation saves every living
   trade cart completed its trips (save 1: 29 of 33 trading, the other 4 killed; 0 gridlocked).
5. **Known risks left** (pre-existing): with fog off an attacking squad chases villagers map-wide; a team with no TC
   keeps an anchor that drifts with its first unit and stops updating intel.
