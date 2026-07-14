# Age of Epochs II
<img width="800" height="580" alt="image" src="https://github.com/user-attachments/assets/ee2c16da-ad8d-47b8-982b-8a84cc9c8758" />

To play the game go to: [ageofepochs.com](https://ageofepochs.com)

## Development

- **Codebase guide** (architecture, determinism rules, conventions): [`CLAUDE.md`](CLAUDE.md)
- **Tooling & tests** (test battery, headless self-play simulator, MP tests): [`tools/README.md`](tools/README.md)
- **AI behavior reference** (AoE2-DE comparison, fidelity decisions): [`docs/aoe2-ai-behavior.md`](docs/aoe2-ai-behavior.md)
- **External-reference notes** (openage study, unit-stat fixture): [`docs/reference/`](docs/reference/)

```sh
tools/run-tests.sh                        # pre-commit test battery
tools/simulate.sh runs=6 diff=hard        # 6 seeded self-play matches, aggregate report
```

## References & credits

Sources consulted for game-mechanics fidelity. None of their code or game
assets is included in this repo; what we adopted is documented value-by-value
in [`docs/aoe2-ai-behavior.md`](docs/aoe2-ai-behavior.md) (§11–12).

| reference | what we used it for | where it lives here |
|---|---|---|
| [airef.github.io](https://github.com/airef/airef.github.io) — AoE2 AI-scripting reference | Strategic Number defaults and AI behavior semantics behind our difficulty profiles | synthesized into `docs/aoe2-ai-behavior.md` |
| [SFTtech/openage](https://github.com/SFTtech/openage) — open Genie-engine project (GPLv3 docs) | Their `doc/reverse_engineering/` notes: damage formula, build/repair rates, market pricing, trade-cart gold, garrison arrows, town-bell range | study notes in `docs/reference/openage-study.md`; adopted values in `docs/aoe2-ai-behavior.md` §12 |
| Leif Ericson's unit stat tables ([AoK Heaven](https://aok.heavengames.com/university/game-info/stat-tables/units-table/), via openage) | Exact AoC unit stats, used as a regression fixture (`tools/stats-audit.js`, runs in the test battery) | `docs/reference/unit_stats_aoc.csv` |

*Age of Empires II* is a Microsoft / Ensemble Studios title; this project is an
independent fan reimplementation and includes no original game assets or data.
