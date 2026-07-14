# How Age of Empires II (Definitive Edition) AI Actually Works

A detailed reference for how the real AoE2 **Definitive Edition** computer player behaves, synthesized from the AI-scripting reference at https://github.com/airef/airef.github.io (consulted online; see the References section of the repo README for all sources). Values in `[brackets]` are the engine **default** for that Strategic Number (SN). "AoE1 only" flags SNs that don't affect AoE2.

This documents *AoE2*, not our clone. A detailed side-by-side comparison with our AI (`js/ai.js`, `AI_LEVELS` in `js/core.js`) is a separate follow-up — see the scaffold at the end.

---

## 1. Architecture

AoE2's computer player is a **rule-based script**, not hardcoded logic. The engine runs a "tactical AI" that reads three kinds of state the script sets:

- **Strategic Numbers (SNs)** — ~240 named integer knobs (`set-strategic-number sn-… N`) that tune every behavior: economy split, attack group sizes, defense, exploration, etc. The engine has a default for each; the *default AI* (community-maintained, "scripter64" lineage) overrides many.
- **Goals / timers / rules** — `(defrule (conditions) => (actions))` fire when conditions hold; goals and timers are the script's memory.
- **up-commands** (UserPatch/DE extensions) — richer targeting/tasking (`up-target-objects`, `up-set-offense-priority`, direct unit control "DUC").

Key consequence: **most "AI behavior" is script-defined, not a fixed engine constant.** E.g. gatherer distribution and age-up timing come from the AI script's build order, not from an engine default (the gatherer-% SNs default `[0]` = "script must set it"). So "what AoE2 does" = what the *default AI script* does, on top of these engine mechanics.

---

## 2. Difficulty scaling (the definitive model)

In a **non-scenario game** (normal skirmish), `sn-do-not-scale-for-difficulty-level [0]` means the engine auto-scales the AI by difficulty — and it scales **only attack aggression**:

| Difficulty | Multiplier applied to the SNs below |
|---|---|
| Hard / Hardest | ×1.0 (no change) |
| **Moderate (Medium)** | **×0.75** |
| Easy | ×0.5 |
| Easiest | ×0.25 |

SNs scaled: `sn-minimum-attack-group-size`, `sn-maximum-attack-group-size`, `sn-percent-attack-soldiers` (+ boat equivalents).

**Everything else is identical across difficulties** — economy, aging, build order, town size. Easier AIs aren't economically dumber; they **commit smaller attack groups and a smaller fraction of their army**, and they **react slower** (see §3). (Scenario games scale a different, larger set — not relevant to skirmish.)

The DE AI does **not** get resource/production cheats by default — difficulty is skill-shaped, not bonus-shaped.

---

## 3. Reaction & vision

- `sn-easier-reaction-percentage [100]` / `sn-easiest-reaction-percentage [100]` — on the easier single-player levels, a unit's effective reaction is a percentage of its normal line-of-sight, i.e. easier AIs notice threats/opportunities later. This is the other half of how easy AIs are made weaker (alongside §2).
- The AI uses real line-of-sight/fog — it responds to what its units can see (sighted-response system, §6), not omniscient map vision.
- *Ours (2026-07, information-parity milestone):* the AI is **fully fog-honest** — every knowledge read flows through the same deterministic per-team vision grids a human's screen is drawn from. `aiVisibleEnemies`/target retention/auto-acquire use `entityVisibleToTeam` (js/core.js); placement and gather-tasking use `tileHiddenForTeam` with **no AI exemption**; the old 15-tile proximity model, the `STARTS` start-position fallback and the live enemy-TC coordinate reads are all deleted. What the AI acts on beyond current sight is deterministic **intel memory** (`ai.intel`, hashed): a sticky remembered TC (ghost-cleared when the spot is re-sighted empty), a nearest-contact direction memory, and a per-team decaying army-strength table (`Math.max(observed, floor(mem·15/16))` per decision tick). Being damaged stays legitimate knowledge (`lastTeamHit` — the bell can ring against an unseen attacker, but defenders won't hunt what they can't see). Accepted honest regressions: later tcSeen/first waves, bell-only response to unseen kiting raiders, pre-contact walls face map center, and a scout dead before Feudal leaves the AI temporarily blind. The **All Visible** match option (SP options / MP lobby, `window.fogDisabled`) makes knowledge global for everyone — the AI included — and the whole fog machinery (vision grids, snapshot clones, checksum fold) is skipped for the match.

---

## 4. Economy

**Gatherer distribution** is a percentage split the script sets each update:
`xGatherers = (sn-x-gatherer-percentage + sn-x-modifier-percentage) * gathererTotal * 0.01 + 0.5` for x ∈ {food, wood, gold, stone}. All default `[0]` (script-controlled). The default AI continuously rebalances these toward what it needs (age costs, build queue).

**Villager allocation caps** (of total villagers):
- `sn-percent-civilian-explorers [34]`, capped by `sn-cap-civilian-explorers [2]` — a small % explore, hard-capped at 2.
- `sn-cap-civilian-builders [2]` — only ~2 builders at once by default (community advice: raise to ~200; the AI only uses as many as needed).
- `sn-cap-civilian-gatherers [-1]` — no cap.

**Town / building placement:**
- `sn-minimum-town-size [12]` / `sn-maximum-town-size [20]` — the radius band the town spreads within.
- `sn-camp-max-distance [25]` — lumber/mining camps within 25 tiles of the TC (overridable per-camp via `sn-lumber-camp-max-distance`/`sn-mining-camp-max-distance`).
- `sn-mill-max-distance [100]`.
- `sn-dropsite-separation-distance [10]` — min distance between dropsites (community advice: lower to 3–4; 10 is a legacy backwards-compat value).
- `sn-food/wood/stone/gold-dropsite-distance [3]` — villagers *prefer* to walk ≤3 tiles to a dropsite.
- `sn-maximum-<res>-drop-distance [-1]` — hard cap on gather distance; `-1` = ignored (villagers may walk far). Community advice: set ~20–30 early, raise per age, back to −1 in Imperial.

**Food sources & hunting:**
- `sn-enable-boar-hunting [0]` — 0: deer only; 1: deer + boar; 2: boar only. (The default is a common gotcha; scripts set 1.)
- `sn-minimum-number-hunters [0]` — force hunting when set.
- Order in practice (default AI): sheep → boar/deer → berries → **farms** (laid in late Dark / Feudal), transitioning off depleting forage.

`sn-auto-build-farms` / `sn-auto-build-dropsites` / `sn-auto-build-houses` / `sn-auto-build-towers` — let the engine auto-place these when set.

---

## 5. Aging

There is **no AoE2 engine SN for age-up timing** (the `sn-upgrade-to-*-age-asap` SNs are AoE1 only). The DE AI ages up on its **script's build-order timeline** — it researches the next age when its build list / villager count / resources reach the scripted benchmark. So age timing is entirely a property of the specific AI script's build order, not a tunable engine default.

---

## 6. Defense

The AI defends via a **sighted-response** system:
- `sn-percent-enemy-sighted-response [50]` — % of idle troops that rush to a unit being attacked.
- `sn-enemy-sighted-response-distance [25]` — radius within which idle troops are eligible to respond (cap of 50 unless `sn-disable-sighted-response-cap`).
- `sn-sentry-distance [12]` (± `sn-sentry-distance-variation [2]`) — distance out to which the town is actively defended.
- `sn-defense-distance [3]` — distance at which non-town objects are defended.
- `sn-town-defend-priority [7]` — TCs are high-priority defense targets; other resources (`gold/stone/forage/relic/dock/livestock-defend-priority`) default `[0]` (not defended unless enabled).
- `sn-number-defend-groups [0]` / `sn-minimum/maximum-defend-group-size` — formal defend groups (off by default; sighted-response handles most defense).
- `sn-gather-idle-soldiers-at-center [-1]` / `-at-spawn-point [-1]` — where idle military loiters/rallies.
- `sn-object-repair-level [16387]` (bit flags) — which buildings villagers auto-repair (defaults include TC/castle/etc.).
- `sn-number-garrison-units [0]` (0 → max 40) / `sn-maximum-garrison-fill [0]` — garrisoning under attack.
- `sn-safe-town-size [255]` — enemy buildings inside this + town size get attacked by defenders (anti-forward-building).

**Retreat** (the tactical AI pulls units out of losing fights):
- `sn-percent-health-retreat`, `sn-percent-death-retreat`, `sn-percent-unit-health-retreat` — health/casualty thresholds that trigger a group/unit to retreat. (Their `sn-scale-*` counterparts are AoE1 only.)

---

## 7. Attacking

**When:** attacks are **army-size driven**, not on a clock. A land attack group launches once it meets its minimum size (a "tasking prerequisite").
- `sn-minimum-attack-group-size [4]` — soldiers needed to form/launch an attack group. **This is the core trigger: ~4 soldiers.**
- `sn-maximum-attack-group-size [10]` — biggest group.
- `sn-percent-attack-soldiers [75]` — when attacking, send **75%** of "defense" soldiers, keep 25% home. (All new soldiers start as defense soldiers until an attack is ordered.) *This and the two group-size SNs are the difficulty-scaled knobs, §2.*
- `sn-number-attack-groups [0]` — desired # of simultaneous groups (percent-attack-soldiers is preferred over this).
- `sn-number-tasked-units [0]` — units per group for `up-target-*` tasking.

**Escalation over time** (the "tactical AI scaling"):
- `sn-scaling-frequency [10]` — every **10 minutes**…
- `sn-scale-minimum-attack-group-size [1]` — …add **+1** to `sn-minimum-attack-group-size`.
- `sn-scale-maximum-attack-group-size [0]` — max group is NOT auto-scaled by default (a known trap: min can eventually exceed max; scripters set min directly instead).
- Net: attack groups **start at 4 and grow by ~1 every 10 min**.

**How they attack:**
- `sn-attack-intelligence [0]` — off by default; when on, the group avoids enemy units en route and attacks from varied sides.
- `sn-enable-patrol-attack [0]` — off by default; when on, units en route retarget nearby sighted enemies instead of marching straight to the objective. (Scripters usually enable for 1-soldier groups.)
- `sn-initial-attack-delay [0]` / `-type [0]` — optional forced delay before the *first* attack (0 = none by default).
- `sn-garrison-rams [1]` — infantry garrison into rams before an attack departs.
- `sn-task-ungrouped-soldiers [1]` (AoC/UP default; **0 in HD/DE**) — when 1, idle soldiers spread out to guard the town area (looks like wandering); DE turns this off.
- `sn-number-civilian-militia [10]` — up to 10 villagers may be pulled to attack (emergency offense).

**Targeting** (which enemy object to hit): mostly the `sn-target-evaluation-*` family — but **those are AoE1 only**. In AoE2/DE, offensive target priority is set by the script via `up-set-offense-priority` (gated by `sn-enable-offensive-priority [0]`); `sn-building-targeting-mode [0]` (0 = all buildings, 1 = ignore walls/gates, 2 = also ignore dropsites) and `sn-local-targeting-mode [0]` (unit-vs-unit priority) tune it. Siege free-targeting via `sn-free-siege-targeting [0]`.

---

## 8. Exploration

- `sn-total-number-explorers [4]` — cap on land explorers.
- `sn-number-explore-groups [0]`, `sn-minimum/maximum-explore-group-size [1]` — soldier scouting groups (1-unit by default).
- `sn-percent-civilian-explorers [34]` / `sn-cap-civilian-explorers [2]` — villager scouts (rare, early).
- `sn-initial-exploration-required [2]` — **2% of the map must be explored before ANY building is placed** (a notorious early-game staller on big maps; scripts set 0).
- `sn-home-exploration-time [300]` — up to 300 s exploring near the home TC first.
- `sn-blot-exploration-map [1]` / `sn-blot-size [15]` — re-explores previously seen regions (spreads out over time).
- `sn-percent-exploration-required [100]` — how much map must be explored before civilian explorers can be retasked.

---

## 9. Walls, towers, resource ceilings

- `sn-town-wall-pattern` / `sn-number-wall-gates` / `sn-size-wall-gates` — wall-ring shape and gates (script-driven; the default AI walls situationally, not always a full early ring).
- `sn-auto-build-towers` / `sn-max-towers` — tower automation/cap.
- `sn-minimum-<res>` / `sn-maximum-<res>` — floor/ceiling resource targets the economy steers toward.

---

## 10. Fairness summary

By default the DE AI is **fair**: no free resources, no production/stat bonuses, no map-wide vision. Difficulty comes from (a) **attack-aggression scaling** (§2: group size + commit %) and (b) **reaction speed** (§3). A harder AI plays the *same* economy faster/tighter and commits bigger, better-timed attacks — it doesn't cheat.

---

## 11. Detailed comparison (filled in 2026-07-13, vs `js/ai.js` @ marketplace branch)

Legend: ✅ match (same behavior, possibly different mechanism) · 🟡 approximate (same intent, simplified) · 🔶 intentional divergence (documented reason) · ❌ **gap** (AoE2 behavior we don't have).

### Difficulty & fairness (§2, §10)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Aggression scaling | ×1.0/0.75/0.5 on min/max group + commit% | `attackSize` 3/4/5 (0.6/0.8/1.0), `commitPercent` 38/56/75 (0.5/0.75/1.0) | ✅ ratios match |
| Max group size | 10, difficulty-scaled | `waveCap` 6/12/24 — Hard is 2.4× the AoE2 max | 🟡 ours steeper; but AoE2 also runs multiple simultaneous groups, we run one wave |
| Economy per difficulty | identical across levels | `maxVils` 14/18/24, age pacing, walls/towers differ | 🔶 documented: commit-only scaling flattened our gradient |
| Resource cheats | none | `trickle` all-zero on every level | ✅ |
| Reaction speed | `easier-reaction-percentage` (LOS %) | `decisionInterval` 240/180/120 | 🟡 analogous lever, different axis |
| Max age | Imperial | Castle (`maxAge:2`) for all levels | 🔶 engine roster scope, not an AI knob |

### Economy (§4, §5)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Gatherer split | script rebalances % each update | `ecoRatios` + hoard-shedding + `savingForAge` bias (`aiEcoPlan`) | ✅ same intent, works |
| Food order | sheep → **boar/deer** → berries → farms | sheep → berries → farms (`nearestAISheep`, `targetFor`) | ❌ **no boar/deer** — engine has no huntable wildlife beyond sheep (bear = wolf analog, hazard not food) |
| Farms | auto-build, laid late Dark | `planAIFarming`: barracks-or-8-vils trigger, target scales with workforce | ✅ |
| Camp distance | `camp-max-distance [25]` | `findAIDropSite` maxDist 22·aiScale | ✅ |
| Dropsite separation | `[10]` (advice: 3–4) | `AI_DROP_COVER = 10` coverage radius | ✅ |
| Camp placement knowledge | real LOS | `teamHasExplored` gate — no omniscient camps | ✅ |
| Builder cap | `cap-civilian-builders [2]` | `buildersPerBuilding` 1–2 + wall-crew cap (⅓ workforce) | ✅ |
| Civilian explorers | ~2 villagers scout early | none — villagers never explore | 🟡 minor; our scout survey covers it |
| Age-up trigger | script build-order benchmark (vils/resources) | `ageUpVils` benchmark + `savingForAge` reserve | ✅ same mechanism |
| Age-up clock | none (no engine SN) | `ageUpTick` floor per difficulty | 🔶 pacing floor is our difficulty lever |

### Defense (§6)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Sighted response | **50%** of idle troops within 25 tiles respond | `sightedResponsePercent [50]`: nearest ~half of eligible defenders dispatch, rest hold posture (`controlAIMilitary`) | ✅ closed 2026-07 |
| Retreat | `percent-health-retreat` / `percent-death-retreat` per unit/group | per-unit: <30% HP under active enemy fire → runs home (`retreatUntil`, retaliation/auto-acquire suppressed); group: wave recalled when survivors <35% of launch (`lastWaveSize`); enemy-player hits only — never wildlife | ✅ closed 2026-07 |
| Garrison under attack | `sn-number-garrison-units` | villagers: town-bell reaction (`updateAIGarrisonReaction`), core-hit gated. SOLDIERS too (2026-07 under-attack doctrine): outmatched home defenders (>1.6x local enemy power) shelter in the TC/towers via the shared garrison flow, eject on all-clear or when trained-up combined power reaches parity; abandon-ship at melee+<50% hp (garrison dies with the building). Melee garrison adds no arrows (pierce-DPS model) — the win is army preservation. | ✅ closed 2026-07 |
| Auto-repair | `object-repair-level` bit flags (TC/castle…) | any own building with hp<maxHp is builder work (`assignAIVillagers`) | ✅ broader than AoE2 default, fine |
| Villagers fight back | up to 10 `civilian-militia` | `civilianMilitia [10]`: at the bell moment, a small raid the army can't answer gets mobbed instead of hiding the eco (`tryAIMilitiaResponse`); recall when the raider dies/flees the town radius | ✅ closed 2026-07 |
| Anti-forward-building | `safe-town-size [255]` — enemy buildings near town get attacked | `findEnemyForwardBuilding`: enemy structures (incl. foundations) in the town radius draw the sighted-response fraction of defenders; arrow-firers first | ✅ closed 2026-07 |
| Defend priorities | TC [7], others [0] | TC-centric alarm radius; camps/gold not separately defended | ✅ matches defaults |

### Attacking (§7)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Attack trigger | army-size (`min-attack-group-size [4]`), no clock | army-size: launch when the ARMY (`mils`, garrisoned excluded) reaches the scaled min group past `attackTick` + intel strength bar (`attackAdvantage`); the wave itself is drawn from currently-`available` units. Defense (sighted response) and offense run in PARALLEL — a sighted threat dispatches defenders but no longer freezes the wave machinery | ✅ closed 2026-07 (under-attack doctrine) — the old eco-scaled `aiWaveSize` launch bar locked raided AIs out of ever counter-attacking; `aiWaveSize` survives as the TRAINING ceiling only |
| Escalation | min group +1 per 10 min (`sn-scaling-frequency`), max group 10 | min group +1 per 10 game-min past attackTick (`AI_ATTACK_SCALE_EVERY`), clamped to `min(waveCap, AI_ATTACK_MIN_GROUP_CAP=10)` — AoE2's own scaled-min>max freeze trap, hit and fixed in ladder runs | ✅ closed 2026-07 |
| Commit % | 75%, keep 25% home | `commitPercent` + `armyReserve` | ✅ |
| Stalemate valve | attacks eventually even outmatched | DELETED 2026-07 — it existed to unstick the eco-scaled launch bar, and its 8-unit floor was itself unreachable for a raided AI; the small scaled min group is always reachable | ✅ (by removal) |
| March cohesion | group moves together | `groupSpeed` = slowest member | ✅ |
| Target priority | script `up-set-offense-priority` (raiding emerges from eco-priority scripts) | units-in-face → **spotted villagers/trade carts at any distance (raid tier)** → TC → tower/barracks → rest → distant other units; rams = buildings only; garrisoned units excluded from the spotted set (the bell is the counter — sheltered villagers vanish, the wave falls to the TC siege) | ✅ closed 2026-07 (raid economics) |
| Wall handling | `building-targeting-mode` | detour-vs-breach cost compare (`resolveReachableAttackTarget`) | ✅ arguably better |
| Garrison rams | infantry ride rams to the front (`garrison-rams [1]`) | melee infantry boards wave rams (cap 4, +8% speed each), disembarks at the objective/under melee fire, survives the wreck; player-usable via right-click + Ungarrison grid | ✅ closed 2026-07 |
| Attack-intelligence (route around enemies) | **off by default** | not modeled | ✅ matches default |
| Allied coordination | n/a (per-script) | `allyJoinWindow` wave clustering | ✅ bonus |
| Wave retreat on casualties | `percent-death-retreat` | gutted waves (<35% of launch still out) recall survivors home | ✅ closed 2026-07 |

### Exploration (§8)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Explorer count | up to 4 land explorers | exactly 1 scout, retrained on death (`ensureAIScout`) | 🟡 fewer, but persistent |
| Home-first exploration | `home-exploration-time [300]` | `baseSurveyWaypoint` 8-point perimeter lap first | ✅ |
| Frontier bias | `blot-exploration-map` re-explores | unexplored-tile-count scoring (`pickExploreWaypoint`) | ✅ |
| Intel decay / re-scout | blot re-explores seen ground → stale intel refreshes | army-strength memory DECAYS (~6%/decision tick, `updateAIIntel`) and TC memory ghost-clears on re-sight — stale intel genuinely expires and re-scouting refreshes it | ✅ (2026-07 information parity) |
| initial-exploration-required (2% before building) | notorious staller | building placement now requires the footprint EXPLORED (`tileHiddenForTeam`, all teams); walls additionally wait for the base-survey lap (`planAIWalls`) | ✅ (parity form of the same idea, no % staller) |

### Walls & towers (§9)

| Behavior | AoE2 DE | Ours | Verdict |
|---|---|---|---|
| Walling | situational, script-driven | full ring + eco/enemy gates, deferred until maxAge AND paused during a war-state (`aiRecentlyRaided` — core hit within 2 game-min; walls are preparation, not reaction; egress carving keeps running) | ✅ |
| Stone upgrade | script | palisade→stone from Feudal, gates first | ✅ |
| Towers | `auto-build-towers` / `max-towers` | `maxTowers` 0/1/2, wall-mounted (gate flank → corners → eco side) | ✅ |
| Resource ceilings | `sn-maximum-<res>` | hoard thresholds, ALL four resources (wood>600 shed, stone>400 stop, gold>500 shed, **food>600 shed → +2 chop** — food was asymmetric: sticky farm shares banked 5000+ food while wood pinned at 25, so no rams/market/buildings and med-easy games stalled unresolvable) | ✅ closed 2026-07 (raid economics) |
| Resource floors | `sn-minimum-<res>` | emergency market floors (2026-07): food<100 / wood<80 with gold banked → buy at a 100-gold cushion (vs 300 normally); below a floor with thin gold and stone>200 → SELL STONE to fund the buy (the bootstrap the double-starved seed-2001 collapse lacked); a food-starved gold-rich OR war-state AI may build the market NEED-based; barracks rebuild fund (175w) outranks towers/market/new farms (`aiBarracksFundClear`) | ✅ minimal analog |
| Town contraction under attack / villager safety | `sn-minimum-town-size [12]` spirit (no direct SN) | Three-layer model (2026-07 consolidation): **LEARN** — a villager HIT by a bear or enemy player stamps a `dangerZones` entry via the shared `stampDangerZone` writer and, if caught beyond the alarm radius, flees home at the moment of the hit (event-driven, in `damageEntity`); **POLICY** — `aiVillagerSafeAt(team,x,y)` (zones + war-state contraction to `AI_BASE_ALARM_RADIUS(18)·aiScale` of the TC), consulted by every gather scan (`canGatherTile`) and by camp founding (`findAIDropSite`); **REACT** — the bell ladder (militia / shelter / lurker-gated all-clear) for raids at the town. Farms exempt from the predicate (at-TC income) | ✅ new ground (2026-07) |

### Remaining gaps, in priority order

Gaps 1, 2, 4, 5, 6 of the original list (health/wave retreat, sighted-response %, anti-forward-building, civilian militia, garrison rams) were closed 2026-07 — see the ✅ rows above. Still open:

1. **Boar/deer hunting** — needs engine work first (no huntable wildlife besides sheep); AoE2's early food curve (and its fast Feudal) leans on hunt food. Sheep + early farms currently stand in.
2. Second explorer / stale-intel re-scouting — cheap, low impact (deliberately skipped: any scout can already explore).

## 12. Mechanics adopted from openage reverse-engineering (2026-07-13)

Source: `docs/reference/openage-study.md` (+ `docs/reference/unit_stats_aoc.csv`,
audited every test run by `tools/stats-audit.js`). Each row names the openage
doc the value came from.

| Mechanic | AoE2 value (source) | Adopted as | Deviation? |
|---|---|---|---|
| Multi-builder speed | `3·build_time/(builders+2)` (build_speed.md) | `countSiteWorker` census + per-worker share, js/logic.js | none |
| Repair rate | 750 hp/min, +50% per extra villager (repair.md) | 12.5 hp/s first + 6.25 each, fractional accrual | none |
| Market prices | GLOBAL table, clamp [20,9999], ±3/lot (market.md) | one shared `marketPrices` (save v6) | none |
| Trade-cart gold | Conquerors `2·(d/size+0.3)·d·K` (market.md) | K=0.84 calibrated to old income on 120-map half routes | K is ours |
| Attack bonuses | attack-vs-armor-class pairs (damage.md) | data-driven `UNITS.*.bonuses` (values unchanged; checksum-stable refactor) | ram +110 is our tuning (repair contract) |
| Garrison arrows | `floor(Σ pierce_dps / bldg_dps)`, villager=2.5, TC 0/10 (garrison.md) | DPS model, melee adds nothing, **base arrow kept even ungarrisoned** (TC 1..10, tower 1..5, ptower 1..3) | default-arrow kept by design (user call: unmanned TC still shoots) |
| Town bell range | 25 tiles from TC (town_bell.md) | `BELL_RANGE=25` in ringTownBell; no TC → no range limit | none |
| Knight reload | 1.8s (unit_stats_aoc.csv) | rof T30(54) | none |
| Ram pierce armor | 180 (csv) | 180 (behavior-identical under min-1 floor) | none |
| Trade cart | 100W+50G, 51s train (csv) | adopted | none |
| Scout speed | 1.2 Dark Age (csv) | kept 1.55 | deliberate: scout is Feudal-gated here, Feudal +0.35 baked in |

Measured (6-seed medians, same seeds, vs pre-adoption): hard-vs-easy 52→57
game-min, hard-vs-medium 52→57 (loaded-TC defense is genuinely stronger —
the designed effect), medium-vs-easy 68→58 (25-tile bell keeps distributed
economies working). Ladder stayed strictly monotonic; rollback determinism
verified.
