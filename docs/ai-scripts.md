# AI scripts

A seat's strategy as data: AoE2's `.per` idea (`defrule`s that set strategic numbers) in JSON that a player can
hand-edit or an agent can write. Engine: `js/aiscript.js`. Menus and editor: `js/aiscript-ui.js`.

A script **steers decisions**. It never adds abilities or resources, and the tactical layer (gathering, pathing,
squads, retreat) stays the AI's own. The difficulty still sets the timing and handicap (`aiTimeMult`,
`decisionInterval`). The script's levers are laid over that difficulty's profile.

## Shape

```json
{
  "name": "Archer Rush",
  "rules": [
    { "set": { "maxAge": 1, "maxVils": 22, "unitMix": { "archer": 3, "spearman": 1 } } },
    { "when": [ { "age": 1 } ], "set": { "maxBarracks": 3, "attackSize": 6 } },
    { "when": [ { "minute": 14 } ], "set": { "maxAge": 2, "maxVils": 45 }, "once": true }
  ]
}
```

On every AI decision tick, rules are checked in order:

- **When a rule's conditions all hold**, its `set` levers take effect and **stay set**, just as AoE2's strategic numbers do.
- **When two rules set the same lever**, the later rule in the list wins.
- **`"once": true`** makes a rule fire a single time.
- **A rule with no `when`** is the setup rule. It is once by default; add `"once": false` to re-assert it on every pass.
- **Limits:** at most 100 rules. Errors are collected and worded for the author (the editor shows them live).

## Levers

These are the AI profile's own keys (`AI_LEVELS` in `js/core.js`) plus three strategic ones.

**Economy**

| lever | type | meaning |
|---|---|---|
| `maxVils` | int 0–200 | villager target |
| `ecoRatios` | weights | gatherer split: `forage`, `chop`, `mine_gold`, `mine_stone` |
| `farmShare` | int 0–40 | minimum farmers |
| `targetFarms` | int 0–60 | number of farms to keep |
| `houseBuffer` | int 0–20 | spare population room |
| `maxTradeCarts` | int 0–40 | trade carts |
| `civilianMilitia` | int 0–100 | most villagers that mob a raider |

**Ages**

| lever | type | meaning |
|---|---|---|
| `maxAge` | int 0–2 | highest age it will research (0 Dark, 1 Feudal, 2 Castle) |
| `ageUpVils` | [dark, feudal, castle] | villagers needed before aging into each age |
| `ageUpTick` | [dark, feudal, castle] in seconds | earliest game time to age into each age |

**Buildings**

| lever | type | meaning |
|---|---|---|
| `maxBarracks` | int 0–8 | barracks cap |
| `barracksVil` | int | villagers before the first barracks |
| `walls` | bool | wall the town |
| `wallAge` | int 0–2 | age walls start |
| `wallRadius` | int 3–12 | wall ring radius (tiles) |
| `maxTowers` | int 0–12 | tower cap |

**Army and attacks**

| lever | type | meaning |
|---|---|---|
| `armyCap` | int | army ceiling |
| `darkAgeArmy` | int | Dark Age army cap |
| `armyPerVil` | 0–3 | soldiers per villager |
| `armyReserve` | int | soldiers kept beyond the wave (home defense) |
| `attackSize` | int 1–60 | minimum wave |
| `waveCap` | int | largest wave |
| `commitPercent` | int 0–100 | share of the army sent |
| `attackTick` | seconds | no attacks before this game time |
| `waveCooldown` | seconds | rest between waves |
| `attacksVillagers` | bool | raid villagers |
| `queueLimit` | int 1–10 | training queue depth |

**Strategic**

| lever | type | meaning |
|---|---|---|
| `unitMix` | weights | `militia`, `spearman`, `archer`, `knight`; trains the unlocked type furthest below its share |
| `counterPick` | 0–1 | chance per pick to counter the enemy's army instead of following `unitMix` |
| `techOrder` | tech keys | research order (the `UPGRADES` keys in `js/core.js`) |

`ageUpVils` and `ageUpTick` entries are clamped to at least 1, because the AI reads a 0 as "never".

## Conditions

A rule's `when` is a list of conditions, and **all** of them must hold. Each condition is an object with one key:

| condition | holds when |
|---|---|
| `{ "minute": 12 }` | game time ≥ 12 min |
| `{ "age": 1 }` | age ≥ Feudal |
| `{ "villagers": 30 }` | ≥ 30 villagers |
| `{ "army": 10 }` | ≥ 10 soldiers (scouts excluded) |
| `{ "res": { "food": 500, "gold": 200 } }` | stockpile ≥ each amount |
| `{ "own": "BARRACKS", "n": 2 }` | ≥ n complete buildings or units of the type (n defaults to 1) |
| `{ "atMost": "archer", "n": 5 }` | ≤ n of the type (n defaults to 0) |
| `{ "tech": "fletching" }` | the tech is researched |
| `{ "underAttack": true }` | the AI's own under-attack doctrine trigger |
| `{ "not": { ... } }` | the inner condition fails |

## Where scripts live

The `ai-scripts/` folder holds one file per script.

- **Presets** are `ai-scripts/<name>.js`: one line (`AI_SCRIPT_PRESETS["<name>"] =`) followed by plain JSON. The wrapper
  lets a `<script>` tag load it from file://, as the Learn to Play lessons do. To add a preset, drop in a file and add
  its `<script>` tag to `index.html` and `classic.html` after `js/aiscript.js`. The menus and lobby list whatever is
  registered, in load order.
- **Plain scripts** are `ai-scripts/<name>.json`. This is the agent's working format: the simulator reads them by name,
  and the editor opens and saves them.
- An optional `"about"` line shows as the preset's tooltip.

| preset | plan |
|---|---|
| **Rusher** | Feudal at 16 villagers. Three barracks, a mixed militia, archer and spear army, small early waves. Castle after minute 18. |
| **Boomer** | 70 villagers, eco techs first and a light army. Turns into a knight-heavy army in Castle Age at 50 villagers. |
| **Turtle** | Walls from the Dark Age and 5 towers. A defensive tech order. Its first big attack comes in Castle Age at 25 army. |

## Using scripts

- **Single player:** the setup screen's **AI Plan** row lists the presets, then Custom…, which opens the editor. The
  editor offers:
  - presets to start from;
  - your saved scripts (each "Use this plan" saves it under its `name`; × deletes it);
  - **Open file…** for a `.json` script or a preset `.js` file;
  - **Save file**, which downloads `<name>.json`;
  - live validation.

  The choice, the active custom script and the saved scripts are kept in localStorage.
- **Multiplayer:** the host picks a plan per AI seat in the lobby. Guests see it read-only. The compiled script travels
  in the lobby config and `lockstep-start`, so every peer runs the same data, including presets or custom scripts the
  guest doesn't have.
- **Headless:** `node tools/simulate.js script0=rusher script1=my-plan`. Each argument is a name in `ai-scripts/`
  (`.json` or `.js`) or a file path. The report names the scripts in `config.scriptNames`. This is the agent loop:
  write `ai-scripts/my-plan.json`, sim it against a preset, compare `end.*`, and keep the winners in the folder.

## Determinism

- **The script** is plain data on `teamControllers[t].script`. It is saved, snapshotted and hashed once per object.
- **What it has set** lives in `AI_STATES[t].scriptSet` and `.scriptDone`. Both are hashed in `simChecksum` via
  `aiScriptChecksum`.
- **`scriptSet` is replaced, never mutated**, whenever it changes. `aiScriptedProfile` caches the merged profile by
  that object, so a rollback's restored object maps back to its own profile.
- **Conditions read only sim state.** No code runs from a script.
- **Unscripted seats** are bit-identical to the plain difficulty AI.
