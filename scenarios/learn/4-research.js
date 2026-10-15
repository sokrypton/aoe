// Learn to Play lesson (js/scenario-ui.js loads it on demand; vocabulary: docs/scenarios.md)
SCENARIOS["learn-4"] =
{
  "map": "small",
  "seed": 21,
  "numTeams": 2,
  "fog": true,
  "controllers": ["human", "human"],
  "names": ["Scots", "English"],
  "victory": "custom",
  "camera": {"x": 30, "y": 31},
  "title": "Research and Technology",
  "resources": [
    {"food": 800, "wood": 200, "gold": 100, "stone": 0},
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
    {"b": "BARRACKS", "x": 31, "y": 35, "team": 0},
    {"u": "villager", "x": 27, "y": 33, "team": 0},
    {"u": "villager", "x": 29, "y": 33, "team": 0},
    {"u": "villager", "x": 31, "y": 33, "team": 0},
    {"u": "villager", "x": 33, "y": 30, "team": 0},
    {"u": "villager", "x": 33, "y": 32, "team": 0},
    {"u": "villager", "x": 26, "y": 33, "team": 0},
    {"u": "villager", "x": 33, "y": 28, "team": 0},
    {"u": "villager", "x": 25, "y": 32, "team": 0},
    {"u": "militia", "x": 36, "y": 33, "team": 0},
    {"u": "militia", "x": 37, "y": 34, "team": 0}
  ],
  "areas": {},
  "objectives": [
    {"id": "feudal", "text": "Advance to the Feudal Age."},
    {"id": "axe", "text": "Research Double-Bit Axe at the Lumber Camp."},
    {"id": "forging", "text": "Research Forging at the Barracks."},
    {"id": "archers", "text": "Train 2 Archers."}
  ],
  "triggers": [],
  "steps": [
    {"do": [{"goal": "feudal"}, {"say": "Your people can learn. The Town Center leads them into a new Age, which opens new buildings, units and technologies. {Click} the Town Center and advance to the Feudal Age (500 food). It takes a while, so keep your villagers working.", "task": "Advance to the Feudal Age at the Town Center."}]},
    {"hint": {"research": "age"}, "when": [{"age": 1}], "do": [{"done": "feudal"}, {"goal": "axe"}, {"say": "Welcome to the Feudal Age! Technologies are researched at the building they belong to. {Click} the Lumber Camp and research Double-Bit Axe: your villagers chop faster.", "task": "Research Double-Bit Axe at the Lumber Camp."}]},
    {"hint": {"research": "double_bit_axe"}, "when": [{"tech": "double_bit_axe"}], "do": [{"done": "axe"}, {"goal": "forging"}, {"say": "Weapons and armor are improved at the Barracks. Research Forging there: +1 attack for your infantry and cavalry.", "task": "Research Forging at the Barracks."}]},
    {"hint": {"research": "forging"}, "when": [{"tech": "forging"}], "do": [{"done": "forging"}, {"goal": "archers"}, {"say": "The Feudal Age also unlocks new soldiers: archers, spearmen and scouts. Train two Archers at the Barracks. They shoot from range and beat spearmen; scouts beat archers.", "task": "Train two Archers at the Barracks."}]},
    {"hint": {"train": "archer"}, "when": [{"own": "archer", "n": 2}], "do": [{"done": "archers"}, {"say": "You have mastered the basics. Now take on a real opponent: start a game from the main menu!"}]},
    {"when": [{"after": 4}], "do": [{"win": true}]}
  ]
};
