# Age of Epochs II
<img width="800" height="580" alt="image" src="https://github.com/user-attachments/assets/ee2c16da-ad8d-47b8-982b-8a84cc9c8758" />

To play the game go to: [ageofepochs.com](https://ageofepochs.com)

## Development

- **Codebase guide** (architecture, determinism rules, conventions): [`CLAUDE.md`](CLAUDE.md)
- **Tooling & tests** (test battery, headless self-play simulator, MP tests): [`tools/README.md`](tools/README.md)
- **AI behavior reference** (AoE2-DE comparison, fidelity decisions): [`docs/aoe2-ai-behavior.md`](docs/aoe2-ai-behavior.md)

```sh
tools/run-tests.sh                        # pre-commit test battery
tools/simulate.sh runs=6 diff=hard        # 6 seeded self-play matches, aggregate report
```
