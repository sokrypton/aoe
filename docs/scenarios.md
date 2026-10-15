# Scenarios: triggers, objectives, lessons

Authored scenarios use AoE2's trigger model. A trigger is a list of
**conditions** followed by a list of **effects**. Scenarios also carry an
**objectives** checklist and **instructions** for the player. The
Learn to Play lessons (`scenarios/learn/*.js`: each registers its spec in `SCENARIOS`, since a `<script>` loads from file:// and inside the app, where fetching local JSON is blocked) are the first scenarios built on it.
Campaigns can use the same pieces later.

| file | role |
|---|---|
| `js/scenario.js` | `loadScenario(spec)` builds the world: map, terrain, entities, teams |
| `js/triggers.js` | the sim side: compiles `steps` to triggers, evaluates them, owns `scenarioState` |
| `js/scenario-ui.js` | the viewer side: instruction card, objectives, ui signals, Learn to Play menu, lesson end screen |
| `js/render.js` / `render-fx.js` | gold objective flags on the map and minimap (`drawScenarioMarkers`) |

## Determinism

- `scenarioScript` is the static half: triggers, areas and objectives. It is
  identical on every peer.
- `scenarioState` is the sim half: which triggers are on or fired, timers,
  objective states, the message log, tags, markers and signals. It rides
  snapshots, resync and saves (save v11), and folds into `simChecksum`.
- Conditions read only sim state. A fact only the viewer knows, such as a
  selection or a camera pan, reaches the sim as a `scenario-signal` command.
  That command is the same channel every other player action uses.
- Without a script, every hook is a no-op, so plain matches keep their exact
  checksums.

## Spec

The `loadScenario` fields come first: map, seed, numTeams, controllers,
alliances, names, resources, ages, techs, fog, camera, terrain and entities.
Terrain entries take `w`/`h` to fill a rectangle. Entities can also take:
- `tag`: a name that triggers refer to as `#name`;
- `hp`: an override for a building's hit points.

The scripted fields follow:

```jsonc
{
  "title": "Marching and Fighting",
  "victory": "custom",            // ends only by trigger (or the player wiped out); default "conquest"
  "areas": { "ford": {"x":24,"y":24,"w":5,"h":5} },
  "objectives": [ {"id":"camp","text":"Destroy the English camp."} ],
  "triggers": [ {"id":"lost","when":[...],"do":[...],"on":true,"repeat":false} ],
  "steps": [ {"when":[...],"do":[...]} ]   // a linear lesson: each step arms the next
}
```

Triggers fire in array order. A trigger armed by another fires on the next
sweep at the earliest. Sweeps run every `SCENARIO_EVERY` ticks.

`what` picks objects. It can be:
- a unit or building key (`militia`, `TC`);
- a `#tag`;
- `unit`, `building`, `military` or `any`.

Buildings count once complete.

### Conditions

| key | AoE2 name | meaning |
|---|---|---|
| `after: s` | Timer | `s` game-seconds since this trigger was armed |
| `inArea: area, what, team, n` | Objects in Area | at least `n` matching objects in the area |
| `own: what, team, n, area?` | Own Objects | at least `n` |
| `atMost: what, team?, n` | Own Fewer Objects | at most `n` (team omitted = any team) |
| `destroyed: tag` | Destroy Object | every tagged object is gone |
| `res: {food:100}, team` | Accumulate Attribute | stockpile at least these amounts |
| `age: n, team` | (Researching age) | team age reached `n` |
| `tech: key, team` | Research Technology | tech researched |
| `goal: id` | (Objective) | objective completed |
| `ui: 'select', what, n` | Object Selected | viewer signal: the player has selected at least `n` |
| `ui: 'pan', tiles` | (camera) | viewer signal: the view moved `tiles` since the trigger armed |

### Effects

| key | AoE2 name | meaning |
|---|---|---|
| `say: text, who?, task?` | Display Instructions | appends to the message log. The card opens on it, then folds after a reading time to a one-line bar showing `task` (default: the message's last sentence) |
| `goal / done / fail: id` | Change Objective | show it, check it off, or mark it failed |
| `marker / unmark: area` | (flag object) | gold flag plus outline on the map and minimap |
| `camera: area` | Change View | the viewer jumps there |
| `spawn: utype, team, at, n, tag?, stance?` | Create Object | units fill the area row by row |
| `convert: what, from?, to (team), area?` | Change Ownership | e.g. clansmen joining you |
| `attack / move: what, team, target? \| to?` | Task Object | the same `command` a player issues |
| `give: {food:..}, team` | Tribute | add to the stockpile |
| `on / off: triggerId` | Activate / Deactivate Trigger | |
| `win / lose` | Declare Victory | ends the match for team 0's side |

### Guide hints

A trigger or step can carry a `hint`. It is viewer-only: the sim never reads
it. The hint names the action the step waits for. While the step is armed, the
guide (`updateScenarioGuide` in `js/scenario-ui.js`) works out the next thing
to press from the current HUD state:
- a unit or building on the map gets a pulsing gold ring;
- a HUD button gets a flashing gold border.

A list of hints is tried in order, and the first one with a target wins.

| hint | the chain it walks |
|---|---|
| `{select: what, n?}` | pulse those objects until `n` are selected |
| `{with: what, on: what?}` | select `with`, then pulse the `on` target to order onto (an area target uses its `marker`) |
| `{build: BTYPE}` | villagers, then the build menu (or Back, from the wrong one), then the building's button |
| `{train: utype}` | the building that trains it, then its train button |
| `{research: tech \| 'age'}` | the owning building, then its research button (stops once under way) |
| `{button: id}` | a fixed HUD element, e.g. `bell-btn` |

### Instruction text

Control words adapt to the input in use:
- `{click}` / `{Click}`: tap, click or left-click;
- `{order}` / `{Order}`: tap, click or right-click;
- `{pan}`, `{box}` and `{zoom}`.

The phrase table is `SCN_PHRASES` in `js/scenario-ui.js`.

## Learn to Play

The lessons follow AoE2's William Wallace learning campaign:

1. **Marching and Fighting.** Select, move, pan, fog of war, group select,
   fighting, attacking a building, then defend the village.
2. **Feeding the Army.** Sheep, training villagers, houses, the Lumber Camp
   and wood, the Mining Camp and gold, the Mill and berries.
3. **Training the Troops.** Barracks, training militia, fighting off a raid.
4. **Research and Technology.** The Feudal Age, techs at their buildings,
   new units.

`tools/behavior-tests.js` runs a `learn-lessons` section. It plays every
lesson to victory with a naive bot that reads the armed conditions and acts
through real commands. A lesson the bot can't finish is broken. Completion is
remembered per browser (`localStorage.aoeLearnDone`).

Next: the Battle of Falkirk as a capstone vs an AI, and campaigns. The
building blocks are already here: scripted AI teams via `controllers`, plus
lesson chaining.
