# AoE2 (DE / The Conquerors) research costs — reference

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
