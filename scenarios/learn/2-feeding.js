// Learn to Play lesson (js/scenario-ui.js loads it on demand; vocabulary: docs/scenarios.md)
SCENARIOS["learn-2"] =
{
  "map": "small",
  "seed": 21,
  "numTeams": 2,
  "fog": true,
  "controllers": ["human", "human"],
  "names": ["Scots", "English"],
  "victory": "custom",
  "camera": {"x": 30, "y": 31},
  "title": "Feeding the Army",
  "resources": [
    {"food": 0, "wood": 125, "gold": 0, "stone": 0},
    {"food": 0, "wood": 0, "gold": 0, "stone": 0}
  ],
  "terrain": [
    {"t": "FOREST", "x": 13, "y": 13, "w": 9, "h": 10},
    {"t": "FOREST", "x": 0, "y": 0, "w": 60, "h": 3},
    {"t": "FOREST", "x": 0, "y": 3, "w": 3, "h": 57},
    {"t": "FOREST", "x": 44, "y": 12, "w": 6, "h": 8},
    {"t": "FOREST", "x": 40, "y": 46, "w": 10, "h": 6},
    {"t": "BERRIES", "x": 35, "y": 24, "w": 3, "h": 1},
    {"t": "GOLD", "x": 38, "y": 37, "w": 2, "h": 2},
    {"t": "STONE", "x": 19, "y": 38, "w": 2, "h": 2}
  ],
  "entities": [
    {"b": "TC", "x": 28, "y": 28, "team": 0, "tag": "tc"},
    {"u": "villager", "x": 27, "y": 33, "team": 0},
    {"u": "villager", "x": 29, "y": 33, "team": 0},
    {"u": "villager", "x": 31, "y": 33, "team": 0},
    {"u": "villager", "x": 33, "y": 30, "team": 0},
    {"u": "sheep", "x": 24, "y": 25, "team": 0},
    {"u": "sheep", "x": 23, "y": 27, "team": 0},
    {"u": "sheep", "x": 25, "y": 24, "team": 0},
    {"u": "sheep", "x": 22, "y": 26, "team": 0}
  ],
  "areas": {
    "sheep": {"x": 21, "y": 23, "w": 6, "h": 6},
    "forest": {"x": 19, "y": 19, "w": 4, "h": 5},
    "gold": {"x": 37, "y": 36, "w": 4, "h": 4},
    "berries": {"x": 34, "y": 23, "w": 5, "h": 3}
  },
  "objectives": [
    {"id": "food", "text": "Gather 100 food from the sheep."},
    {"id": "vils", "text": "Train 2 more villagers at the Town Center."},
    {"id": "house", "text": "Build a House."},
    {"id": "wood", "text": "Build a Lumber Camp by the forest and gather 100 wood."},
    {"id": "gold", "text": "Build a Mining Camp by the gold mine and gather 50 gold."},
    {"id": "mill", "text": "Build a Mill beside the berry bushes."}
  ],
  "triggers": [],
  "steps": [
    {"do": [{"say": "An army marches on its stomach, and on wood and gold too. Villagers gather every resource and put up every building. {Click} one of your villagers.", "task": "{Click} one of your villagers."}]},
    {"hint": {"select": "villager"}, "when": [{"ui": "select", "what": "villager"}], "do": [{"goal": "food"}, {"marker": "sheep"}, {"say": "Sheep are walking food. With villagers selected, {order} a sheep: they butcher it and carry the meat to the Town Center. Select all your villagers ({box}) and send them to the sheep.", "task": "Send your villagers to the sheep."}]},
    {"hint": {"with": "villager", "on": "sheep"}, "when": [{"res": {"food": 100}}], "do": [{"unmark": "sheep"}, {"done": "food"}, {"goal": "vils"}, {"say": "Food trains more villagers. {Click} your Town Center, then the villager button. Each one costs 50 food. Train two.", "task": "Train two villagers at the Town Center."}]},
    {"hint": {"train": "villager"}, "when": [{"own": "villager", "n": 6}], "do": [{"done": "vils"}, {"goal": "house"}, {"say": "Every person needs a home. Your Town Center houses 10 people, and each House adds 5. Select a villager, open the economic build menu, pick the House and {order} open ground to place it.", "task": "Build a House."}]},
    {"hint": {"build": "HOUSE"}, "when": [{"own": "HOUSE"}], "do": [{"done": "house"}, {"goal": "wood"}, {"marker": "forest"}, {"say": "Wood comes from trees. Villagers carry it to the nearest drop site, so build a Lumber Camp right beside the forest, then {order} the trees to set villagers chopping.", "task": "Build a Lumber Camp by the forest, then chop wood."}]},
    {"hint": [{"build": "LCAMP"}, {"with": "villager"}], "when": [{"own": "LCAMP"}, {"res": {"wood": 100}}], "do": [{"unmark": "forest"}, {"done": "wood"}, {"goal": "gold"}, {"marker": "gold"}, {"say": "Soldiers and the later Ages need gold. Build a Mining Camp next to the gold mine in the south-east and set a villager or two mining.", "task": "Build a Mining Camp by the gold, then mine it."}]},
    {"hint": [{"build": "MCAMP"}, {"with": "villager"}], "when": [{"own": "MCAMP"}, {"res": {"gold": 50}}], "do": [{"unmark": "gold"}, {"done": "gold"}, {"goal": "mill"}, {"marker": "berries"}, {"say": "Sheep run out fast. Berry bushes are food you forage, and a Mill is their drop site. Build a Mill (100 wood) beside the berries. Later, Farms built near the Mill feed you for good.", "task": "Build a Mill beside the berries."}]},
    {"hint": {"build": "MILL"}, "when": [{"own": "MILL"}], "do": [{"unmark": "berries"}, {"done": "mill"}, {"say": "Your village is fed and working. The army will not go hungry!"}]},
    {"when": [{"after": 4}], "do": [{"win": true}]}
  ]
};
