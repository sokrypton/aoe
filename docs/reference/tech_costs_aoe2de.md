# AoE2 (DE / The Conquerors) research + building reference

Sourced from [Liquipedia's Age of Empires wiki](https://liquipedia.net/ageofempires)
(per-technology infoboxes), one page per row, July 2026. Same role as
`unit_stats_aoc.csv`: a citable target so balance decisions aren't made from
recollection. Our values live in `UPGRADES` (js/core.js).

`ours` is this clone. `ratio` is ours ÷ DE per resource, in the order listed.

| technology | DE cost | ours | research time DE / ours |
|---|---|---|---|
| Forging | 150F | **matches** | 50s / 16.7s |
| Scale Mail Armor | 100F | **matches** | — / 16.7s |
| Fletching | 100F 50G | **matches** | 30s / 16.7s |
| Wheelbarrow | 175F 50W | **matches** | 75s / 20s |
| Horse Collar | 75F 75W | **matches** | — / 16.7s |
| Double-Bit Axe | 100F 50W | **matches** | 25s / 16.7s |
| Gold Mining | 100F 75W | **matches** | — / 16.7s |
| Iron Casting | 220F 120G | **matches** | 75s / 25s |
| Chain Mail Armor | 200F 100G | **matches** | — / 25s |
| Bow Saw | 150F 100W | **matches** | 50s / 25s |
| Heavy Plow | 125F 125W | **matches** | 40s / 25s |
| Masonry | 150F 175W | **matches** | — / 25s |
| Fortified Wall | 200F 100S | **matches** | — / 25s |
| Guilds | 300F 200G | **matches** | 50s / 25s |
| Bodkin Arrow | 200F 100G | **matches** | — / 25s |

Costs were restored to DE on 2026-07-27 (they had been uniformly ~halved).
Measured at 80k ticks, 2v2 medium, 20 runs/arm: aging is UNAFFECTED (feudal
timing ns at every difficulty), so full prices cost no economic tempo. What
they do is compress the tech ladder — techs kept vs halved prices: easy 95%
(it is capped at maxTech 2 anyway), medium 82%, hard 77% (11.0 -> 8.5). The
slowdown is regressive, not uniform. Ladder re-checked 1v1 x20: hard beat
medium 11-0 of decided, so the ordering is intact.

**Research times are still NOT faithful.** Ours collapse to two values —
16.7s Feudal, 25s Castle — while DE varies per technology from 25s
(Double-Bit Axe) to 75s (Iron Casting, Wheelbarrow). Every per-tech
distinction is lost, and the ratio to DE is inconsistent (0.27-0.67).
Restoring them is untouched work.

## Reading

Before restoration, eleven of fourteen sat at 0.50–0.56 of DE (a uniform
halving) with three exceptions that had drifted further: Double-Bit Axe and Bow
Saw had dropped DE's food cost entirely (Bow Saw also charged gold DE never
does), and Guilds sat at 0.33/0.25.

**Effects** were also unfaithful and are now fixed: DE's Forging/Iron Casting are
infantry+cavalry ONLY — ours applied them to archers too, so archers took the
melee line *and* their own. Fletching gave only +1 range where DE gives +1
attack AND +1 range. Bodkin Arrow was added (appended last, so UPGRADE_BITS
indices stay stable) to give archers the same two-step line melee has.

Still unfaithful, deliberately left: our single armor line (Scale/Chain Mail)
upgrades every unit class, where DE splits Mail (infantry) / Barding (cavalry) /
Archer Armor. Masonry gives only +10% building HP, missing DE's +1/+1 and +3
building armor. Wheelbarrow gives +3 flat carry where DE gives +25%.

## Caveats

- Fortified Wall: Liquipedia lists 200F **100 stone**; some sources give 100 wood
  after patch 1.0b. Ours uses stone, which matches the Liquipedia figure.
- Masonry was 175W/150 stone in The Age of Kings, changed to 150F/175W in The
  Conquerors. The Conquerors value is the one tabulated.
- Research *times* are not tabulated here — only costs were checked.


---

# Building stats

Same sourcing (Liquipedia infoboxes, July 2026). Ours live in `BLDGS` (js/core.js).

| building | DE cost | DE build | DE HP Dark/Feudal/Castle | ours |
|---|---|---|---|---|
| Town Center | 275W 100S | 2:30 | 2400 **flat** | matches |
| House | 25W | 0:25 | 550 / 750 / 900 | matches (age-scaled 2026-07-27) |
| Mill | 100W | 0:35 | 600 / 800 / 1000 | matches |
| Lumber Camp | 100W | 0:35 | 600 / 800 / 1000 | matches |
| Mining Camp | 100W | 0:35 | 600 / 800 / 1000 | matches (assumed same family as Lumber Camp — not separately sourced) |
| Barracks | 175W | 0:50 | 1200 / 1500 / 1800 | matches |
| Market | 175W | **1:00** | — / 1800 / 2100 | HP matches; **build time is 0:50, should be 1:00** |
| Farm | 60W | 0:15 | flat | matches |
| Palisade Wall | 2W | **0:07** | 250 **flat** | HP matches; **build time is 0:05, should be 0:07** |
| Stone Wall | 5S | — | 1800 flat | matches |

**Age-scaled HP was missing entirely until 2026-07-27**: every building sat at
its Dark-Age figure forever, so buildings grew relatively weaker as a match ran
on, and Masonry's +10% was covering for an ageing bonus DE grants free.
Economic and military buildings scale; the Town Centre, walls, gates, towers and
farms are flat in DE and carry no `hpAge`.

## Known-unverified

- **Watch Tower cost.** Ours is 25W 125S; DE may be 50W 125S. Both Liquipedia
  URLs tried returned 404, so this is UNCONFIRMED — do not "fix" it from memory.
- Mining Camp per-age HP is assumed identical to Lumber Camp, not separately
  sourced.
- Gates (palisade/stone) and our invented PTOWER were not checked.
