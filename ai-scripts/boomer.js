// AI script preset: everything after the first line is plain JSON (docs/ai-scripts.md)
AI_SCRIPT_PRESETS["boomer"] =
{
  "name": "Boomer",
  "about": "70 villagers and eco techs first; a knight-heavy Castle army at 50 villagers.",
  "rules": [
    {
      "set": {
        "maxVils": 70,
        "armyPerVil": 0.3,
        "armyReserve": 4,
        "attackTick": 1200,
        "targetFarms": 10,
        "maxTowers": 1,
        "techOrder": ["wheelbarrow", "horse_collar", "double_bit_axe", "gold_mining", "bow_saw", "heavy_plow", "forging", "scale_armor", "fletching", "iron_casting", "chain_mail", "bodkin_arrow", "ballistics", "masonry", "fortified_wall", "guilds"]
      }
    },
    {
      "when": [
        { "age": 2 },
        { "villagers": 50 }
      ],
      "set": {
        "armyPerVil": 1,
        "armyCap": 60,
        "maxBarracks": 4,
        "attackSize": 10,
        "unitMix": { "knight": 3, "archer": 2, "spearman": 1 }
      }
    }
  ]
}
