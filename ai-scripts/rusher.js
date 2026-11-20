// AI script preset: everything after the first line is plain JSON (docs/ai-scripts.md)
AI_SCRIPT_PRESETS["rusher"] =
{
  "name": "Rusher",
  "about": "Feudal at 16 villagers, three barracks, small early waves; Castle after minute 18.",
  "rules": [
    {
      "set": {
        "maxAge": 1,
        "maxVils": 24,
        "ageUpVils": [1, 16, 99],
        "ageUpTick": [1, 1, 1],
        "barracksVil": 4,
        "maxBarracks": 3,
        "darkAgeArmy": 5,
        "ecoRatios": { "forage": 4, "chop": 4, "mine_gold": 5 },
        "unitMix": { "militia": 2, "archer": 3, "spearman": 1 },
        "counterPick": 0.3,
        "techOrder": ["fletching", "forging", "wheelbarrow"],
        "attackSize": 5,
        "attackTick": 300,
        "waveCooldown": 90,
        "armyPerVil": 1.2,
        "walls": false,
        "maxTowers": 0
      }
    },
    {
      "when": [ { "minute": 18 } ],
      "set": {
        "maxAge": 2,
        "maxVils": 40,
        "ageUpVils": [0, 16, 26]
      },
      "once": true
    }
  ]
}
