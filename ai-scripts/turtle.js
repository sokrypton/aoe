// AI script preset: everything after the first line is plain JSON (docs/ai-scripts.md)
AI_SCRIPT_PRESETS["turtle"] =
{
  "name": "Turtle",
  "about": "Walls from the Dark Age, 5 towers, defensive techs; one big Castle-age push.",
  "rules": [
    {
      "set": {
        "walls": true,
        "wallAge": 0,
        "wallRadius": 8,
        "maxTowers": 5,
        "attackTick": 2400,
        "armyReserve": 12,
        "unitMix": { "archer": 2, "spearman": 2, "militia": 1 },
        "techOrder": ["masonry", "fortified_wall", "fletching", "bodkin_arrow", "ballistics", "scale_armor", "chain_mail", "wheelbarrow", "horse_collar", "double_bit_axe", "gold_mining", "forging", "iron_casting", "bow_saw", "heavy_plow", "guilds"]
      }
    },
    {
      "when": [
        { "age": 2 },
        { "army": 25 }
      ],
      "set": { "attackSize": 12, "waveCap": 30, "commitPercent": 70 }
    }
  ]
}
