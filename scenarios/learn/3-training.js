// Learn to Play lesson (js/scenario-ui.js loads it on demand; vocabulary: docs/scenarios.md)
SCENARIOS["learn-3"] =
{
  "map": "small",
  "seed": 21,
  "numTeams": 2,
  "fog": true,
  "controllers": ["human", "human"],
  "names": ["Scots", "English"],
  "victory": "custom",
  "camera": {"x": 30, "y": 31},
  "title": "Training the Troops",
  "resources": [
    {"food": 300, "wood": 200, "gold": 100, "stone": 0},
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
    {"b": "HOUSE", "x": 26, "y": 24, "team": 0},
    {"b": "HOUSE", "x": 33, "y": 26, "team": 0},
    {"b": "LCAMP", "x": 22, "y": 22, "team": 0},
    {"b": "MILL", "x": 35, "y": 21, "team": 0},
    {"u": "villager", "x": 27, "y": 33, "team": 0},
    {"u": "villager", "x": 29, "y": 33, "team": 0},
    {"u": "villager", "x": 31, "y": 33, "team": 0},
    {"u": "villager", "x": 33, "y": 30, "team": 0},
    {"u": "villager", "x": 33, "y": 32, "team": 0},
    {"u": "villager", "x": 26, "y": 33, "team": 0},
    {"u": "villager", "x": 33, "y": 28, "team": 0},
    {"u": "villager", "x": 25, "y": 32, "team": 0},
    {"u": "sheep", "x": 24, "y": 25, "team": 0},
    {"u": "sheep", "x": 23, "y": 27, "team": 0},
    {"u": "sheep", "x": 25, "y": 24, "team": 0},
    {"u": "sheep", "x": 22, "y": 26, "team": 0}
  ],
  "areas": {"raid": {"x": 52, "y": 26, "w": 3, "h": 2}, "field": {"x": 34, "y": 32, "w": 4, "h": 4}},
  "objectives": [
    {"id": "barracks", "text": "Build a Barracks."},
    {"id": "army", "text": "Train 4 Militia."},
    {"id": "defend", "text": "Defeat the English raiders."}
  ],
  "triggers": [
    {"id": "lost", "when": [{"atMost": "TC", "team": 0, "n": 0}], "do": [{"lose": true}]}
  ],
  "steps": [
    {"do": [{"goal": "barracks"}, {"say": "Word has come: English soldiers are raiding nearby villages. You need an army. Soldiers train at a Barracks. Select a villager, open the military build menu and place a Barracks (175 wood).", "task": "Build a Barracks."}]},
    {"hint": {"build": "BARRACKS"}, "when": [{"own": "BARRACKS"}], "do": [{"done": "barracks"}, {"goal": "army"}, {"say": "{Click} the Barracks and train Militia: 60 food and 20 gold each. You can queue several at once. Train four.", "task": "Train 4 Militia at the Barracks."}]},
    {"hint": {"train": "militia"}, "when": [{"own": "militia", "n": 4}], "do": [{"done": "army"}, {"goal": "defend"}, {"spawn": "militia", "team": 1, "at": "raid", "n": 4, "tag": "raiders"}, {"attack": "#raiders", "team": 1, "target": "#tc"}, {"say": "English raiders approach from the east! Select your militia and {order} the enemy to attack. If your villagers are threatened, ring the Town Bell: they run into the Town Center, which shoots arrows at the raiders.", "task": "Attack the English raiders."}]},
    {"hint": {"with": "military", "on": "#raiders"}, "when": [{"destroyed": "raiders"}], "do": [{"done": "defend"}, {"say": "The raiders are routed. Your army stands ready."}]},
    {"when": [{"after": 4}], "do": [{"win": true}]}
  ]
};
