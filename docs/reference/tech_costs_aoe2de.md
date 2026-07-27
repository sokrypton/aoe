# AoE2 (DE / The Conquerors) research costs — reference

Sourced from [Liquipedia's Age of Empires wiki](https://liquipedia.net/ageofempires)
(per-technology infoboxes), one page per row, July 2026. Same role as
`unit_stats_aoc.csv`: a citable target so balance decisions aren't made from
recollection. Our values live in `UPGRADES` (js/core.js).

`ours` is this clone. `ratio` is ours ÷ DE per resource, in the order listed.

| technology | DE cost | ours | ratio |
|---|---|---|---|
| Forging | 150F | 80F | 0.53 |
| Scale Mail Armor | 100F | 50F | 0.50 |
| Fletching | 100F 50G | 50F 30G | 0.50 / 0.60 |
| Wheelbarrow | 175F 50W | 90F 30W | 0.51 / 0.60 |
| Horse Collar | 75F 75W | 40F 40W | 0.53 / 0.53 |
| Gold Mining | 100F 75W | 50F 40W | 0.50 / 0.53 |
| Iron Casting | 220F 120G | 110F 60G | 0.50 / 0.50 |
| Chain Mail Armor | 200F 100G | 100F 50G | 0.50 / 0.50 |
| Heavy Plow | 125F 125W | 70F 70W | 0.56 / 0.56 |
| Masonry | 150F 175W | 80F 90W | 0.53 / 0.51 |
| Fortified Wall | 200F 100S | 100F 50S | 0.50 / 0.50 |
| **Double-Bit Axe** | 100F 50W | **50W** | food dropped; wood at **1.00** |
| **Bow Saw** | 150F 100W | **80W 50G** | food dropped, **gold added** (DE costs no gold) |
| **Guilds** | 300F 200G | 100F 50G | **0.33 / 0.25** |

## Reading

Eleven of fourteen sit at **0.50–0.56 of DE** — a deliberate uniform halving,
consistent enough to be a policy rather than drift. The three bold rows are the
exceptions: two changed *which resources* they cost (Double-Bit Axe and Bow Saw
both drop food; Bow Saw adds gold DE never charges), and Guilds is cheaper than
the halving at a third/quarter.

Restoring full DE prices is a real balance change, not a cosmetic one: `aiEcoFund`
(js/ai.js) reserves the **next tech's cost**, so every price here feeds the fund
that gates walls and buildings, and per-difficulty `maxTech` is 2/7/14. Measure
with the 40-runs/arm protocol on `map=medium` before and after.

## Caveats

- Fortified Wall: Liquipedia lists 200F **100 stone**; some sources give 100 wood
  after patch 1.0b. Ours uses stone, which matches the Liquipedia figure.
- Masonry was 175W/150 stone in The Age of Kings, changed to 150F/175W in The
  Conquerors. The Conquerors value is the one tabulated.
- Research *times* are not tabulated here — only costs were checked.
