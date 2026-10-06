# Gameplay script — how a match should play (AoE2, on our roster)

A reference for "does a match feel like Age of Empires II?". Part 1 is the script: how a typical 1v1 should unfold,
what each unit, building and tech is FOR, and the decisions a good player (human or AI) makes. Part 2 checks it
against what the game does today. Scope stays ours: three ages (Dark → Feudal → Castle), one Town Center per player,
one Barracks that trains every military unit, no Castle building, monks, relics or Imperial Age. Times are game-time.

---

## Part 1 — The script

### The pieces

| Piece | What it's for | Counters / is countered by |
|---|---|---|
| **Villager** (50f) | The economy: gathers, builds, repairs. The TC should never stop making them. | Raided by everything; shelters in the TC/towers (town bell). |
| **Scout Cavalry** (80f, Feudal; one free at start) | Finding sheep, resources and the enemy; raiding villagers early. | Spearmen. |
| **Militia** (60f 20g) | Cheap early infantry; Dark-Age harassment ("drush"), building damage. | Archers, knights. |
| **Spearman** (35f 25w, Feudal) | The cheap answer to cavalry (+15 vs scout/knight). | Archers, militia. |
| **Archer** (25w 45g, Feudal) | Ranged damage, kills infantry and villagers from behind a wall of spears. | Scouts/knights (fast, armored), spearman bonus works the other way. |
| **Knight** (60f 75g, Castle) | The power unit: fast, armored, hits hard. | Spearmen in numbers. |
| **Battering Ram** (160w 75g, Castle) | Breaks walls, gates, towers and the TC. Immune to arrows, helpless in melee. Foot units ride inside. | Melee units. |
| **Trade Cart** (100w 50g, Feudal) | Gold from a route between your Market and another player's (an ally's in team games), when mines run dry. | Raids along the route. |

| Building | Role |
|---|---|
| **Town Center** | Villagers, age-ups, Wheelbarrow; arrows; shelters villagers; drop site for everything. Losing it loses the game. |
| **House** (25w, +5 pop) | Keep ahead of population — being "housed" stalls the TC. |
| **Lumber Camp / Mill / Mining Camp** | Drop sites next to the resource; eco techs. Short walks = fast economy. |
| **Farm** (60w) | Endless-but-slow food once sheep and berries are gone; reseed when exhausted (Mill pre-pay queue). |
| **Barracks** | All military units; military techs. |
| **Market** (Feudal) | Buy/sell resources; trade carts; Guilds. |
| **Palisade wall / gate / Palisade Watch Tower** | Cheap early safety from raids. |
| **Stone wall / gate / Watch Tower** (Feudal) | Real fortification; towers shoot raiders (+ garrisoned villagers add arrows). |

| Tech line | Where | Payoff |
|---|---|---|
| Wheelbarrow | TC | Faster, bigger villager trips — the first eco tech of Feudal. |
| Double-Bit Axe → Bow Saw | Lumber Camp | Wood is the constant shortage (farms, houses, archers, rams). |
| Horse Collar → Heavy Plow | Mill | Farms last longer — fewer reseeds. |
| Gold Mining | Mining Camp | Feeds archers/knights/Castle age-up. |
| Forging → Iron Casting | Barracks | Infantry and cavalry attack. |
| Fletching → Bodkin Arrow | Barracks | Archer attack and range. |
| Scale → Chain Mail | Barracks | Military armor. |
| Ballistics | Barracks | Archers and towers lead moving targets. |
| Masonry, Fortified Wall | Barracks | Building and stone-defense HP. |
| Guilds | Market | Better exchange rates. |

### Dark Age (0 → ~10–12 min)

1. **Start**: TC, 3 villagers, 1 scout, 200 food / 200 wood / 100 gold / 200 stone, sheep nearby.
2. **Second 0**: queue villagers continuously. Two villagers build a House; one goes to the sheep.
3. **Scout**: circles the base, finds the remaining sheep (they convert to whoever finds them) and berry bushes;
   then looks for the enemy base and its resources.
4. **Food**: sheep are eaten at the TC first (the whole crew on one sheep, no walking). Then berries with a Mill.
5. **Wood**: the 5th–10th villagers go to a woodline with a Lumber Camp right beside it.
6. **Houses** keep pace: one roughly every 5 villagers. A housed TC is the commonest dumb mistake.
7. **Farms** start once sheep run low (~12–16 villagers), around the TC and Mill.
8. **Barracks** around 15–20 villagers (needed for the Feudal military anyway). Optional: a few militia to
   pressure the enemy's woodline.
9. **Click Feudal** at ~20–22 villagers with 500 food banked; the TC keeps its villager queue paused while it
   researches. Villagers keep working and building (a second Lumber Camp, more farms).
10. **Threats**: a scout or militia raid → the town bell sends villagers into the TC; the defender's own
    scout/militia chase the raider away.

### Feudal Age (~11 → ~22 min)

1. **Economy first**: Wheelbarrow, Double-Bit Axe, Horse Collar as resources allow; more farms; a Mining Camp on
   gold (and stone if towers/walls are planned). Keep making villagers.
2. **Military**: a small army of the right counters — spearmen if the enemy has scouts, archers to pressure
   villagers, scouts to raid. Forging / Fletching / Scale armor when an army exists.
3. **Defense**: a Watch Tower near a contested resource; palisade or stone walls around exposed woodlines or
   the whole base if the opponent is aggressive. Walls leave gates.
4. **Market** if it's a team game (trade later) or resources are lopsided (sell the surplus).
5. **Aggression**: raid the enemy's villagers with archers/scouts; retreat when outnumbered; never fight under
   their TC/towers without siege.
6. **Click Castle** (800f 200g) around 25–30 villagers; gold mining must have started earlier.

### Castle Age (~22 min → end)

1. **Economy**: Bow Saw, Heavy Plow, Gold Mining. Farms everywhere; reseed via the Mill queue. Trade carts in
   team games once mines thin out.
2. **Military**: knights become the main force (spearmen counter them — mix in spears/archers by what the enemy
   makes). Iron Casting, Bodkin, Chain Mail.
3. **Siege**: 2–3 rams with the army; infantry rides inside for protection and speed; the army keeps enemy
   melee off the rams while they break walls, gates, towers and finally the TC.
4. **Defense**: stone walls with gates, towers on the gates, Masonry/Fortified Wall if the enemy has rams.
5. **Win**: destroy the TC (knockout) or everything. A beaten AI resigns rather than playing on hopelessly.

### Dumb things that must not happen

- The TC sits idle with food in the bank, or the player is housed for long.
- Villagers walk across the map to drop resources (no camp), or stand idle.
- Villagers re-tasked mid-trip so they throw away what they carry.
- Units overlap into one blob, jitter in place, or walk in circles; a unit stuck forever.
- Armies dribble in one unit at a time; or never attack at all; or chase a target they can't catch.
- The wrong counter: cavalry into spearmen, spearmen chasing archers, rams sent to fight units.
- Walls that seal the owner's own villagers in, gates nobody can use, towers built where nothing happens.
- Resources hoarded in the thousands while another resource is starving the economy.
- Fighting under enemy towers/TC with no siege; leaving rams alone with enemy melee.
- An age-up that never happens because the AI keeps spending the food/gold.

---

## Part 2 — Review against the game today

**Legend:** ✅ in place · ⚠️ partial / differs · ✖ missing

### Rules and pieces

| Script point | Status | Notes |
|---|---|---|
| Start: TC + 3 villagers + scout + sheep, 200/200/100/200 | ✅ | `init.js`, `defaultResources()`. |
| Continuous villager production, houses (+5 pop, 200 cap) | ✅ | Pop cap shown; AI keeps houses ahead (`ensureAIHousing`). |
| Sheep at the TC, conversion by finder, ally donation | ✅ | Butcher ring; herding; donation (2026-10). |
| Berries + Mill, woodline + Lumber Camp, gold/stone + Mining Camp | ✅ | Drop sites claim distinct stands; AI places camps by the resource. |
| Farms (175 food), reseed queue at the Mill, Horse Collar / Heavy Plow | ✅ | `FARM_RESEED_COST`; human prepay queue; AI auto-reseeds. |
| **Hunting (boar, deer)** | ✖ | Only sheep + berries as wild food. Bears are a hazard, not food. Fine to leave out. |
| **Loom** (Dark Age TC: villagers +15 HP, +1/+1 armor) | ✖ | The one Dark-Age tech every player clicks; it's what lets villagers survive a scout/militia raid. |
| Age-up at the TC, Feudal 500f / Castle 800f+200g, AoE2 research times | ✅ | One age-up per team (2026-10 fix). |
| **Age-up building requirement** (AoE2: 2 buildings of the current age) | ✖ | You can click Feudal with only a house. AoE2 forces the eco/military groundwork first. |
| All 16 techs at their owning buildings, prereq chains | ✅ | Archers' own line at spawn fixed 2026-10. |
| Unit roster and counters (spear +15 vs cav, archers vs infantry, rams vs buildings) | ✅ | No skirmisher, so archers' only counter is cavalry/armor (acceptable for our roster). |
| Town bell → villagers into TC/towers; all-clear | ✅ | Buildings shelter villagers only (2026-10 house rule). |
| Walls (palisade + stone), gates, towers, upgrades wood → stone | ✅ | Salvage-swap; gates lock. |
| Market buy/sell, trade carts, Guilds | ✅ | Distance-scaled gold; a route to any other player's Market (an ally's in practice — an enemy's gets raided). |
| Rams: ride inside (soldiers on foot, not villagers), break buildings, helpless in melee | ✅ | AI loads its wave's foot soldiers. |
| Victory: TC knockout; AI resigns when hopeless | ✅ | `maybeResignAI`. |
| **Attack-move** (walk there, fight on the way) | ✖ | Players can only move or attack. The AI's recon march is a plain move. |
| Second TC / Castle / monks / Imperial Age | ✖ by design | Out of scope (one TC = the knockout rule). |

### AI following the script (self-play, 1v1 hard, 40 games — round r28)

| Beat | Status | Notes |
|---|---|---|
| Continuous villagers, houses, camps by resources | ✅ | Housed-stall and idle-villager fixes (2026-09/10). |
| Sheep → berries → farms, Barracks before walls | ✅ | |
| Feudal timing | ⚠️ | ~15 game-min (was ~17) vs AoE2's ~10–12; Castle ~26 min. Dark Age is now a boom (≤3 militia). |
| Villager count | ✅ | Caps hard 60 / medium 40 / easy 25; the TC keeps producing through Feudal and Castle. |
| Eco techs in order, military techs once an army exists | ✅ | ~11 techs by game end. |
| Counter-picking by scouted army composition | ✅ | `counterMap`, 70% of picks. |
| Raiding villagers, retreating when outnumbered | ✅ | Raid targeting, wave retreat, hopeless-chase rule. |
| Waves as groups, not trickles; siege camp with rams | ✅ | `minGroup`, wave-join; camp posture. |
| Towers near contested resources, walls with gates | ✅ | Walls deferred to Castle (medium/hard). |
| Market selling surplus, trade carts in team games | ✅ | |
| No dumb things (listed above) | ✅ mostly | The overlap, jitter, stuck-unit, hoarding, wrong-counter and housed classes were each fixed and are guarded by tests or self-play findings. Many games still go 50 minutes unresolved (accepted: long games are fine). |

### How a match actually plays (measured, 2026-10-05: 4 hard 1v1 self-play games, both sides)

The pieces are right — unit, building, age and tech costs and timings match AoE2 — but the **shape** of the match
isn't. Numbers per player:

| Measure | Ours | AoE2 |
|---|---|---|
| Town Center idle | **~70% of the match** | ~0% until 80–100 villagers |
| Villagers | all 24 trained in the **Dark Age**, then none | ~25–30 at Feudal, growing through Castle |
| Dark-Age military | **8–13 militia** | 0–3 (only a deliberate drush) |
| Feudal / Castle | ~17 / ~25 min | ~10–12 / ~20 min |
| First hit on a base | ~18–27 min (mostly Castle) | Feudal, ~12–15 min |
| Villagers lost to raids | 0–9 per match | the main currency of Feudal fights |
| Castle army | ~30 spearmen + militia, 0–4 knights, 1–4 archers | knights + archers, spears as the counter |
| Peak army | 10–20 | 40–80 |
| Housed | 0% ✅ | — |

What that means for the feel:

1. **The economy stops growing ~10 minutes in.** The villager cap (hard 24, medium 18) is hit in the Dark Age; the
   TC then idles for the rest of the match. Everything downstream is thin: little gold, small armies, slow techs.
   AoE2's arc — boom, then spend the boom — never happens.
2. **The Dark Age is spent on militia instead of advancing.** 8+ militia (~500 food) is a whole Feudal age-up;
   that alone pushes Feudal from ~11 to ~17 minutes.
3. **Feudal is quiet.** First real contact comes in Castle. AoE2's Feudal is where archers/scouts raid woodlines
   and the defender's towers, walls and spearmen matter; here those systems exist but rarely get exercised.
4. **Castle armies are cheap trash.** With a thin gold income the AI's composition rules fall back to gold-free
   spearmen (and militia); knights — the Castle power unit — barely appear. Fights are big blobs of spears.
5. **Games run long because nothing snowballs.** Both sides plateau at the same small economy, so neither can
   out-produce the other; sieges grind. (Long games are accepted — but this is *why* they're long.)
6. **A human out-scales the hard AI by just making villagers.** Players have no cap but the 200 pop; the AI stops
   at 24, so "hard" has a low ceiling against anyone who keeps the TC busy.

### After items 1–3 (2026-10-05, round r29 vs r28: 40 hard 1v1 + 16 medium 2v2)

| Measure | r28 | r29 |
|---|---|---|
| Villagers (median, 1v1 / 2v2) | 24 / 18 | 60 / 40 |
| Feudal (median, 1v1 / 2v2) | 17.5 / 20 min | 15 / 16 min |
| Castle (median, 1v1 / 2v2) | 24 / 30 min | 26 / 27.5 min |
| Techs researched (median) | 12 / 9 | 16 / 16 |
| Decisive games (1v1) | 4 / 40 | 8 / 40 |
| Town Center idle | ~70% | ~30–50% |
| Dark-Age militia | 8–13 | 3–5 |
| First hit on a base | ~18–27 min | ~13–26 min |
| Feudal villagers lost | ~0 | 0–7 |

Feudal raids: every ~90 s a 3–5 unit party walks to the explored woodline/mine on the near side of the enemy TC,
hits villagers, carts and whoever fights it (never the TC), and goes home when there's nothing to hit; the home
army's recalls don't pull it back. Still short of AoE2: Feudal ~3 min late, raids kill fewer villagers than a
human's would.

### What would make it feel more like AoE2 (simple, in order)

1. **Let the economy grow** — raise the AI villager caps toward AoE2 (e.g. hard ~60, medium ~40, easy ~25), keep
   the TC producing through Feudal and Castle, and grow farms/camps with it. The single biggest change to how a
   match feels; judge it on self-play (TC idle %, Castle army mix, game length) and watch map resources and perf.
2. **Dark Age = boom, not army** — the AI trains 0–3 militia in the Dark Age (more only when actually raided) and
   clicks Feudal at ~22 villagers; target Feudal ~11–13 min (hard).
3. **Feudal raids** — once in Feudal, the AI sends small archer/scout raids at enemy villagers (the raid targeting
   exists; it needs a Feudal trigger), so towers, walls, the bell and spearmen get used.
4. **Castle power units** — with real gold income, the composition rules field knights/archers as the core and
   spearmen as the counter.
5. **Loom** — Dark-Age TC tech (villagers +15 HP, +1/+1 armor): the answer to item 3's raids.
6. **Age-up requires 2 buildings of the current age** (houses don't count) — AoE2 pacing.
7. **Attack-move** — "walk there, fight on the way"; the AI's recon march uses it.

Deliberately not recommended: hunting animals, more units (skirmishers, crossbows), a Castle building, a second TC
— each adds systems without changing how the game feels at our scale.
