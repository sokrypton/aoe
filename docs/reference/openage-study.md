# openage study — what they have, what they don't, how we differ

Studied 2026-07-13 from a shallow clone of [SFTtech/openage](https://github.com/SFTtech/openage)
(commit 9a5a7cc). openage is the long-running open-source Genie-engine
(AoE1/AoE2/SWGB) reimplementation: C++20 core (`libopenage/`), Python/Cython
tooling (`openage/`), assets converted from an original game install via the
`nyan` data language. Their README is blunt: *"At the moment, 'gameplay' is
basically non-functional."* It is an engine tech-demo with excellent research
docs — not a playable game.

## Maturity map (theirs)

| subsystem | status | where |
|---|---|---|
| Asset converter (.dat/DRS → nyan + PNG/OPUS) | **works** | `openage/convert/` |
| Renderer (OpenGL/Qt6), curve library, event system, time system, RNG | **works** | `libopenage/{renderer,curve,event,time,rng}/` |
| Pathfinding (flow-field + portal A*) | **works, integrated into move** | `libopenage/pathfinding/` |
| Gamestate (ECS + activity graphs) | scaffolding — idle/move/turn/select only; **no combat, economy, training, research** | `libopenage/gamestate/` |
| Map generation / RMS | **absent** — hardcoded 20×20 demo terrain, no RMS parser | `libopenage/gamestate/game.cpp` |
| Multiplayer / networking | **absent** — design doc only (authoritative server, not lockstep) | `doc/code/architecture.md` |
| Save/load of gamestate | **absent** (only RNG serializes) | — |
| Game AI | **absent** — aspirational draft (`doc/ideas/ai.md`); nothing on .per/strategic numbers | — |

## Architecture: their bet vs ours

openage deliberately has **no simulation ticks**. Time is a fixed-point
seconds value advanced from wall-clock; the sim is a discrete-event system
(`EventLoop.reach_time(t)`), and *all* sim state (HP, position, progress) is
stored as **curves** — keyframe timelines queried by interpolation (idea
borrowed from Planetary Annihilation's Chrono Cam, `doc/code/curves.md`).
Rollback = insert a keyframe in the past and re-interpolate; resync = copy
keyframes (`curve.sync(t)`). They trade guaranteed determinism for time-travel
flexibility — they still compute angles with `std::atan2` on doubles
(`libopenage/coord/phys.cpp`, TODO in-tree) so cross-platform bit-exactness is
explicitly unsolved.

We bet the opposite way: fixed 20 tps lockstep, seeded PRNG + det-trig,
checksummed state, snapshot/rollback, PeerJS host-relay star. Our model is
proven end-to-end (playable MP with rejoin/kick-to-AI/saves); theirs is
unproven for networking (zero netcode exists). **Neither side should convert
to the other** — but see the borrow list.

## What we have that they don't

- Working lockstep multiplayer (host-relay star, rejoin, kick-to-AI, MP saves).
- Deterministic trig/geometry and checksummed sim state (their determinism is open).
- A playable game: combat, economy, training, tech, walls/garrison, win conditions.
- A save format (v5, RLE map). They can't save a gamestate.
- Game AI with difficulty profiles (they have none, and no .per docs either).
- Procedural map generation (they have only a hardcoded demo grid).

## What they have that we don't

- **`doc/reverse_engineering/game_mechanics/`** — the single most valuable
  asset in the repo for us; see the extraction below.
- **Exact unit stat tables**: `doc/reverse_engineering/unit_stats/unit_stats_{aok,aoc,fe,afr}.csv`
  — full HP/attack/reload/armor/LOS/range/accuracy/speed/train-time/cost/bonus
  tables (pre-DE). Directly usable as a regression fixture against `js/core.js`.
- Flow-field + portal hierarchical pathfinding (GameAIPro "Crowd Pathfinding
  and Steering Using Flow Field Tiles"); a legacy tile A* sits in
  `libopenage/pathfinding/legacy/` like ours.
- The nyan **patch model** for techs/civ bonuses: every upgrade is a
  `{target, member, operator, value}` patch over base data, with
  multiplier/stacking semantics made explicit.
- A .dat schema: `openage/convert/value_object/read/media/datfile/unit.py`
  et al. document every field of the original unit/tech/civ records.

## Extracted AoE2 mechanics (from doc/reverse_engineering/) worth auditing against

Numbers our sim should be checked against, with their source file:

- **Damage** (`damage.md`):
  `damage = max(1, (max(0,M−mArmor) + max(0,P−pArmor) + Σ max(0,bonus−resist)) × elevation × stray)`
  — armor classes with **1000 default resist** when a class is absent; uphill
  ×1.25 / downhill ×0.75; stray hit ×0.5; damage computed **on impact**, not on fire.
- **Accuracy/ballistics** (`accuracy.md`): distance-based accuracy (100% ≤2
  tiles → asymptote at the unit's minimum); pre-Ballistics shoots at current
  position (dodgeable), post-Ballistics leads; stray/pass-through arrows do
  half damage; trebs hard-coded 80% vs buildings.
- **Garrison arrows** (`garrison.md`): `extra = floor(Σ pierce_dps / building_dps)`,
  villagers count as fixed 2.5 dps. TC 0 default/5 atk/10 max; Castle 5/11/20;
  Tower 1/5/5. (Ours: flat +1 arrow per garrisoned unit — compare.)
- **Market** (`market.md`): global base 100/100/130; ±3 per 100-lot;
  buy = base×1.3, sell = base×0.7; clamp [20, 9999]. Trade-cart gold formulas
  (AoK + Conquerors variants) included verbatim.
- **Build speed** (`build_speed.md`): `time = 3·build_time/(villagers+2)`.
- **Repair** (`repair.md`): 750 hp/min buildings, 25% for siege/ships,
  +50% per extra villager; cost = ½ build cost spread over max HP (TC pays 2× wood).
- **Economy rates** (`rates.md`): sheep/deer rot 1 food/2s; shepherd 10 food/12s;
  relic gold 1 per (2/relics)s capped 5/s.
- **Formations** (`formations.md`): 4 subformations (cavalry/infantry/ranged/siege),
  spacing set by the widest unit, marching mode auto beyond 10 tiles,
  staggered = 2× spacing, flanked counters onagers; O(n) ordering pseudocode.
- **Town bell** (`town_bell.md`): 25-tile bell range, nearest eligible
  container, TC cap 15 — (ours matches the cap; check the 25-tile radius).
- **Battle alerts** (`attacking_alarm.md`): a "battle" is a 20×20-tile zone
  around the first hit, one alarm per battle, ends after 10s of quiet — a
  clean model for AI threat grouping.
- **Wolves** (`wolves.md`): aggro LOS 4/6/12 tiles by difficulty; ignore-list
  (kings, trade carts, monks, siege, scouts...).
- **Ram speed** (`ram_speed.md`): +0.05 tiles/s per garrisoned *infantry*
  (archers don't count); capacity 4 (6 for siege ram).
- **Villager task switching** (`switching_villager_tasks.md`): what carried
  resources survive role switches (version-dependent), auto-switch after
  finishing a drop-site + auto-deposit.
- Gaps: monk conversion **probabilities/timings are NOT documented** (only
  what carries over); civ-bonus/scoring docs are AoE1; `research.md` is
  mislabeled sprite lore. SWGB subfolder is a different game.

## Borrow list (ranked, for this repo)

1. **Audit combat against the exact damage formula** — especially the min-1
   floor, per-class bonus resist defaulting to 1000, and (if we ever add
   elevation) the 1.25/0.75 factors. Our `armor:{m,p}` model is close but
   bonus-vs-class is implicit in unit types rather than data.
2. **Regression-fixture our `UNITS`/`BLDGS` against `unit_stats_aoc.csv`**
   (license-clean, no game install needed). Reconcile deliberate deviations in
   docs/aoe2-ai-behavior.md §11 instead of silently drifting.
3. **Garrison-arrow DPS formula** — ours is flat per-unit; theirs explains why
   loaded TCs melt small waves. If we ever rebalance shelter-fortress
   stalemates, this is the authentic knob.
4. **Patch-based upgrade system** (nyan-style `{target, member, op, value}`)
   if/when our tech tree grows past the current instant-swap upgrades.
5. **Event-scheduled long actions** (their `predict_invoke_time()`): schedule
   a single future event for a 10s build instead of polling every tick — a
   perf idea compatible with our tick loop (fire on the right tick).
6. **Flow-field pathfinding** only if large-army moves ever dominate profiles
   again — portal+flow-field is the scalable answer, but it's a big lift and
   our A* + group-move currently holds.
7. **Battle-zone alert grouping** (10-tile radius, 10s cooldown) as the model
   for AI threat bookkeeping — cleaner than per-hit reactions.

## Non-findings (checked, absent)

- No RMS/map-gen code or docs (the original game's RMS scripts + community
  RMS guides are the only sources for map-generation parameters).
- No AI implementation or .per/strategic-number documentation.
- No netcode; their planned model (authoritative server over curves) is
  incompatible with our lockstep anyway.
- Their networking RE docs (`doc/reverse_engineering/networking/`) describe the
  original game's wire protocol — interesting as a command-taxonomy checklist
  (`14-ai.md`, `technology_ids.md`), not something to adopt.
