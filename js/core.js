const C=document.getElementById('game');
// X is reassignable (not const): drawSelectedUnitOutlines() briefly redirects
// it to an offscreen buffer so it can reuse drawUnit() itself to capture a
// unit's exact silhouette, instead of maintaining a separate outline shape.
let X=C.getContext('2d');
const MC=document.getElementById('minimap'),MX=MC.getContext('2d');
const isMobile='ontouchstart' in window||navigator.maxTouchPoints>0;
// Command markers (visual feedback when you issue a command)
let cmdMarkers=[]; // {x,y,time,color}
let bottomH=isMobile?(window.innerWidth<=380?175:window.innerWidth<=600?200:200):200;
let topH=isMobile?(window.innerWidth<=600?46:36):36;
// Game-canvas backing resolution. Capped at 2x on mobile: modern phones
// report devicePixelRatio 3+, which makes every canvas fill/stroke touch
// 2.25x more pixels than a 2x cap for no visible gain on this art style —
// measured as the single biggest render cost at scale (fill-rate bound).
// The minimap (render-fx.js) keeps the native ratio; it's tiny.
const dpr = isMobile ? Math.min(2, Math.max(1, window.devicePixelRatio || 1))
                     : Math.max(1, window.devicePixelRatio || 1);
const ZOOM_MIN = 0.6, ZOOM_MAX = 2.5;
let ZOOM = isMobile ? 1.5 : 1.0;
let W=window.innerWidth,H=window.innerHeight-bottomH;
C.width=W*dpr;C.height=window.innerHeight*dpr;
C.style.width=W+'px';C.style.height=window.innerHeight+'px';
X.scale(dpr,dpr);

// ---- CONSTANTS ----
const MAP_SIZES={small:60,medium:90,large:120};
let MAP=MAP_SIZES.small;
const TW=64, TH=32, HALF_TW=32, HALF_TH=16;
let STARTS=[
  {team:0,x:10,y:10},
  {team:1,x:MAP-13,y:MAP-13}
];
// Switches the active map dimensions/start positions; must run before genMap()/init().
// The player spawns in a random corner each match (so openings aren't
// memorizable), with the enemy always in the diagonally opposite corner —
// genMap()'s mirrored resource placement works for any diagonal.
// `alliances` (optional): the per-team alliance array for THIS match, used
// only for the 4-team layout so allied teams spawn in adjacent corners. Both
// lockstep peers pass the identical agreed array (js/lockstep.js) so their
// STARTS match. Defaults to [0,0,1,1] — the classic 2v2 — so single-player and
// any caller that omits it keep the exact previous layout (and RNG draws).
function setMapSize(sizeKey, alliances){
  // First consumer of sim randomness in a fresh match: (re)seed here.
  // A guest/replay stages the agreed seed in __pendingMatchSeed; the
  // host/single-player draws a fresh one.
  newMatchSeed(window.__pendingMatchSeed);
  window.__pendingMatchSeed = null;
  // 2v2 forces at least medium: four corner resource kits (reach ~12*scale
  // tiles each) plus the contested-center deposits collide on a 60-tile map.
  if(NUM_TEAMS>2&&sizeKey==='small')sizeKey='medium';
  MAP=MAP_SIZES[sizeKey]||MAP_SIZES.medium;
  let lo=10, hi=MAP-13;
  let corners=[[lo,lo],[hi,lo],[lo,hi],[hi,hi]];
  let c=corners[simRandInt(0,3)];
  if(NUM_TEAMS<=2){
    STARTS=[
      {team:0,x:c[0],y:c[1]},
      {team:1,x:c[0]===lo?hi:lo,y:c[1]===lo?hi:lo}
    ];
  } else {
    // 3-4 players in ANY alliance shape (2v2, 3v1, uneven splits, FFA,
    // mixed). Lay the four corners out as a PERIMETER RING — [c, a,
    // opp(c), opp(a)], where consecutive entries are edge-adjacent corners
    // — then hand out corners alliance-GROUP by group, so each group gets
    // a contiguous arc of the ring and allies sit together no matter the
    // split (a 3-player side takes 3 corners in an L, its lone opponent
    // the 4th; FFA groups are singletons so any order works). Team 0's
    // group goes first, then groups in first-appearance order. RNG draw
    // count (one for c, one for a) is fixed, so seeds stay comparable and
    // the default [0,0,1,1] → order [0,1,2,3] is byte-identical to the
    // old two-side version of this code.
    let al = alliances || Array.from({length:NUM_TEAMS},(_,t)=>t<2?0:1);
    let a=[[c[0]===lo?hi:lo,c[1]],[c[0],c[1]===lo?hi:lo]][simRandInt(0,1)];
    let opp=xy=>[xy[0]===lo?hi:lo,xy[1]===lo?hi:lo];
    let ring=[c, a, opp(c), opp(a)];
    let ordered=[], seen=new Set();
    for(let t=0;t<NUM_TEAMS;t++){
      if(seen.has(t))continue;
      for(let u=t;u<NUM_TEAMS;u++){
        if(!seen.has(u)&&al[u]===al[t]){ordered.push(u);seen.add(u);}
      }
    }
    STARTS=ordered.map((team,i)=>({team,x:ring[i][0],y:ring[i][1]}));
  }
}
// How many PLAYER teams exist in a match. Every per-team structure
// (resources, vision grids, explored memory, bell state) must size itself
// from this — never a literal 2 — so adding players is a data change here,
// not a codebase hunt. Set per match by onStartClicked (SP Players picker:
// 2 or 4) or by the MP lobby's seat count (1 host + up to 3 guests/AI over
// the js/net.js host-relay star).
let NUM_TEAMS = 2;
// "A real player team" (excludes gaia and garbage ids) — use this instead
// of enumerating `team === 0 || team === 1`.
function isPlayerTeam(t){ return t >= 0 && t < NUM_TEAMS; }
// ---- ALLIANCES ----
// teamAlliance[t] = alliance id; same id => allied. Default is identity
// (every team its own side — all mutually hostile), and nothing in the UI
// sets anything else yet, so today this is pure wiring. SIM state: rides
// snapshots/resync/save and feeds simChecksum like the other per-team
// arrays below.
let teamAlliance = null;
function resetTeamAlliance(){
  teamAlliance = Array.from({length: NUM_TEAMS}, (_, t) => t);
}
function allianceOf(t){
  return (teamAlliance && isPlayerTeam(t)) ? teamAlliance[t] : t;
}
// "On the same side": identical team, or two allied player teams. Gaia is
// never on anyone's side (except its own literal team id). This is THE
// don't-attack predicate — combat/aggro/retaliation sites test !sameSide.
function sameSide(t1, t2){
  return t1 === t2 || (isPlayerTeam(t1) && isPlayerTeam(t2) && allianceOf(t1) === allianceOf(t2));
}
// "An enemy of `team`" — any player team NOT on `team`'s side (gaia is
// never an enemy in this sense; bears/sheep have utype-based handling).
function isEnemyOf(team, e){ return isPlayerTeam(e.team) && !sameSide(team, e.team); }

// ---- AGES ----
// AoE2-lite age progression. teamAge[t] = 0 (Dark) / 1 (Feudal) / 2
// (Castle). SIM state with the full teamAlliance treatment: snapshots,
// resync, save, checksum. Advancing is TC research (see execResearchAge,
// js/commands.js, and the TC tick in js/logic.js).
const AGES = [
  {key:'dark',   name:'Dark Age'},
  // Research times match AoE2 (DE): Feudal 130s, Castle 160s (30 ticks/game-s).
  {key:'feudal', name:'Feudal Age', cost:{f:500},         researchTicks:3900},
  {key:'castle', name:'Castle Age', cost:{f:800, g:200},  researchTicks:4800}
];
// Minimum age index per unit/building type; absent => available from Dark.
const AGE_REQ = {
  spearman:1, archer:1, scout:1, knight:2, ram:2,
  TOWER:1, SWALL:1, SGATE:1,
  MARKET:1, tradecart:1
};
function ageReq(type){ return AGE_REQ[type] || 0; }
function isUnlocked(team, type){ return teamAge && isPlayerTeam(team) ? teamAge[team] >= ageReq(type) : true; }
let teamAge = null;
function resetTeamAge(){
  teamAge = Array.from({length: NUM_TEAMS}, () => 0);
}
// Military units get +1 attack and +1 melee/pierce armor per age past
// Dark via the forging/iron_casting and scale_armor/chain_mail cards (see
// UPGRADES below): attack applied at spawn + swept on age-up (attack is
// snapshotted onto entities), armor added live in damageEntity.
const MILITARY = new Set(['militia','spearman','archer','scout','knight']);
// "Fights in the army" — MILITARY plus siege. The ram is deliberately NOT
// in MILITARY (no blacksmith cards, no soft-push yielding: a parked ram is
// a wall), but the AI's army control, wave sizing and the idle-military
// hotkey must still treat it as a soldier.
function isArmyUnit(t){ return MILITARY.has(t) || t === 'ram'; }
// Wall/gate material families: palisade (Dark) and stone (Feudal).
function isWallBtype(bt){ return bt === 'WALL' || bt === 'SWALL'; }
function isGateBtype(bt){ return bt === 'GATE' || bt === 'SGATE'; }
// Tower family (wooden Palisade Watch Tower + stone Watch Tower): connects to
// walls of either material and can be built over a wall tile.
function isTowerBtype(bt){ return bt === 'TOWER' || bt === 'PTOWER'; }
// Buildings that auto-fire arrows at nearby enemies (TC + every tower).
function firesArrows(bt){ return bt === 'TC' || isTowerBtype(bt); }
const GATE_WALL_MATCH = { GATE: 'WALL', SGATE: 'SWALL' };
// Given a clicked tile and an isWall(x,y) predicate (matching-material wall,
// same team), pick the gate footprint: prefer a 3-tile run through the click
// (centred, then shifted), then a 2-tile run, else a lone 1x1. Horizontal
// (E-W) is preferred over vertical when both fit, matching the old order.
// Returns {ox, oy, gw, gh}. Shared by player (commands.js) and AI (ai.js) so
// both stay in lockstep on gate sizing.
function gateFootprint(x, y, isWall){
  // 3-wide E-W: centred, then extend right, then extend left
  if (isWall(x-1, y) && isWall(x, y) && isWall(x+1, y)) return { ox:x-1, oy:y, gw:3, gh:1 };
  if (isWall(x, y) && isWall(x+1, y) && isWall(x+2, y)) return { ox:x,   oy:y, gw:3, gh:1 };
  if (isWall(x-2, y) && isWall(x-1, y) && isWall(x, y)) return { ox:x-2, oy:y, gw:3, gh:1 };
  // 3-tall N-S: centred, then extend down, then extend up
  if (isWall(x, y-1) && isWall(x, y) && isWall(x, y+1)) return { ox:x, oy:y-1, gw:1, gh:3 };
  if (isWall(x, y) && isWall(x, y+1) && isWall(x, y+2)) return { ox:x, oy:y,   gw:1, gh:3 };
  if (isWall(x, y-2) && isWall(x, y-1) && isWall(x, y)) return { ox:x, oy:y-2, gw:1, gh:3 };
  // 2-wide / 2-tall fallbacks (e.g. a wall gap only two tiles long)
  if (isWall(x, y) && isWall(x+1, y)) return { ox:x,   oy:y, gw:2, gh:1 };
  if (isWall(x-1, y) && isWall(x, y)) return { ox:x-1, oy:y, gw:2, gh:1 };
  if (isWall(x, y) && isWall(x, y+1)) return { ox:x, oy:y,   gw:1, gh:2 };
  if (isWall(x, y-1) && isWall(x, y)) return { ox:x, oy:y-1, gw:1, gh:2 };
  return { ox:x, oy:y, gw:1, gh:1 };
}
// Tiles a gate of `btype` can span (the isWall predicate for gateFootprint):
// an allied WALL of the gate's material, OR an allied gate of the SAME type.
// The gate case lets a gate snap onto / rebuild over an existing gate — so
// the placement ghost still reads as a gate when you hover an existing one
// (its walls are gone), and it enables build-over-gate repair. The WALL check
// is the original origin scan (unchanged → wall-based placement is byte-for-
// byte identical); the gate check uses the occupancy grid so a multi-tile gate
// is detected on ANY of its tiles, not just its origin. Shared by canPlace,
// resolveBuildingPlacement, and drawGhost so snapping/validity/ghost agree.
function gateBaseAt(x, y, btype, team){
  if (entities.find(en => en.type === 'building' && en.x === x && en.y === y && en.btype === GATE_WALL_MATCH[btype] && en.team === team)) return true;
  if (x < 0 || y < 0 || x >= MAP || y >= MAP) return false;
  let id = map[y][x] && map[y][x].occupied;
  let e = id && entitiesById.get(id);
  return !!(e && e.type === 'building' && e.btype === btype && e.team === team);
}
function ageBonus(team){ return teamAge && isPlayerTeam(team) ? teamAge[team] : 0; }

// ---- AGE UPGRADES ("cards") ----
// AoE2-style blacksmith/eco techs, one card per real AoE2 research line.
// Each card is self-contained: an optional one-time apply(team) that sweeps
// stats onto EXISTING entities, plus live hooks (damageEntity armor,
// createUnit/createBuilding spawn stats, gather cooldowns, farm food) that
// read hasUpgrade(team, key) at the moment the stat matters.
//
// Today every card is baked into age-up: applyAgeUpgrades() runs from the
// TC research completion (js/logic.js) and hasUpgrade derives from teamAge —
// deliberately NO new sim state, since teamAge already rides snapshots,
// saves and simChecksum. When cards become draftable later, replace
// hasUpgrade/applyAgeUpgrades with a real per-team card set (with the full
// teamAge sim-state treatment); every hook and apply() stays unchanged.
const UPGRADES = {
  // -- Feudal --
  forging: {age:1, name:'Forging', desc:'Military units +1 attack', apply(team){
    entities.forEach(u => { if (u.type==='unit' && u.team===team && u.hp>0 && MILITARY.has(u.utype)) u.atk += 1; });
  }},
  scale_armor: {age:1, name:'Scale Mail Armor', desc:'Military units +1/+1 armor'}, // live: damageEntity
  fletching: {age:1, name:'Fletching', desc:'Archers +1 range', apply(team){
    entities.forEach(u => { if (u.type==='unit' && u.team===team && u.hp>0 && u.utype==='archer') u.range += 1; });
  }},
  wheelbarrow: {age:1, name:'Wheelbarrow', desc:'Villagers move 10% faster, carry +3', apply(team){
    entities.forEach(u => { if (u.type==='unit' && u.team===team && u.hp>0 && u.utype==='villager') {
      u.speed = UNITS.villager.speed * 1.1; u.carryMax += 3;
    }});
  }},
  horse_collar: {age:1, name:'Horse Collar', desc:'Farms hold +75 food', apply(team){
    topUpTeamFarms(team, 75); // future harvests: live via farmFoodFor
  }},
  double_bit_axe: {age:1, name:'Double-Bit Axe', desc:'Villagers chop wood 20% faster'}, // live: gatherCooldownFor
  gold_mining: {age:1, name:'Gold Mining', desc:'Villagers mine gold 15% faster'}, // live: gatherCooldownFor
  // -- Castle --
  iron_casting: {age:2, name:'Iron Casting', desc:'Military units +1 attack', apply(team){
    entities.forEach(u => { if (u.type==='unit' && u.team===team && u.hp>0 && MILITARY.has(u.utype)) u.atk += 1; });
  }},
  chain_mail: {age:2, name:'Chain Mail Armor', desc:'Military units +1/+1 armor'}, // live: damageEntity
  bow_saw: {age:2, name:'Bow Saw', desc:'Villagers chop wood another 20% faster'}, // live: gatherCooldownFor
  heavy_plow: {age:2, name:'Heavy Plow', desc:'Farms hold +125 food', apply(team){
    topUpTeamFarms(team, 125);
  }},
  masonry: {age:2, name:'Masonry', desc:'Buildings +10% hit points', apply(team){
    entities.forEach(b => { if (b.type==='building' && b.team===team && b.hp>0) {
      b.hp = Math.round(b.hp * 1.1); b.maxHp = Math.round(b.maxHp * 1.1);
    }});
  }},
  // Fortifies the whole stone wall LINE — segments, gates, AND the towers that
  // bastion it (our tower-in-wall deviation, see BLDGS.TOWER). Keep the btype
  // set in sync with buildingMaxHpFor so a tower built after the tech founds at
  // the boosted HP too.
  fortified_wall: {age:2, name:'Fortified Wall', desc:'Stone walls, gates, and towers +50% hit points', apply(team){
    entities.forEach(b => { if (b.type==='building' && b.team===team && b.hp>0 && (b.btype==='SWALL' || b.btype==='SGATE' || b.btype==='TOWER')) {
      b.hp = Math.round(b.hp * 1.5); b.maxHp = Math.round(b.maxHp * 1.5);
    }});
  }},
};
function hasUpgrade(team, key){
  let c = UPGRADES[key];
  return !!c && teamAge && isPlayerTeam(team) && teamAge[team] >= c.age;
}
// One-time application of every card unlocked by reaching `age`; returns
// the display names for the age-up message. Registry (insertion) order is
// the application order — masonry before fortified_wall, so a stone wall
// gets both multipliers the same way a wall built afterwards does.
function applyAgeUpgrades(team, age){
  let names = [];
  Object.keys(UPGRADES).forEach(k => {
    let c = UPGRADES[k];
    if (c.age !== age) return;
    if (c.apply) c.apply(team);
    names.push(c.name);
  });
  return names;
}
// Directly SET a team's age (editor / scenario / loader — the game itself only
// advances age via TC research over time, there's no instant setter). Applies
// each not-yet-reached age's one-time upgrade sweep over EXISTING units
// (applyAgeUpgrades touches live entities) so they gain that age's
// atk/range/speed bonuses, matching a normally-aged team. Only sweeps ages
// ABOVE the team's current age: c.apply isn't idempotent (e.g. fortified_wall
// ×1.5 hp), so re-applying would double it. Lowering age just sets the number —
// bonuses already snapshotted on existing units aren't reverted, but units
// built afterward read the lower age via hasUpgrade. Clamped to 0..2
// (Dark/Feudal/Castle).
function setTeamAge(team, age){
  if(!teamAge)resetTeamAge();
  age=Math.max(0,Math.min(2,age|0));
  let cur=teamAge[team]||0;
  for(let a=cur+1;a<=age;a++)applyAgeUpgrades(team,a);
  teamAge[team]=age;
}
// +1 attack per Forging/Iron Casting held — spawn-time counterpart of the
// apply() sweeps above (attack is snapshotted onto entities).
function upgradeAtkBonus(team){
  return (hasUpgrade(team,'forging') ? 1 : 0) + (hasUpgrade(team,'iron_casting') ? 1 : 0);
}
// +1 melee AND pierce armor per armor card — read live in damageEntity.
function upgradeArmorBonus(team){
  return (hasUpgrade(team,'scale_armor') ? 1 : 0) + (hasUpgrade(team,'chain_mail') ? 1 : 0);
}
// Food a farm of this team seeds/reseeds with.
function farmFoodFor(team){
  return BLDGS.FARM.food +
    (hasUpgrade(team,'horse_collar') ? 75 : 0) +
    (hasUpgrade(team,'heavy_plow') ? 125 : 0);
}
// Per-gather-cycle cooldown in ticks after this team's eco cards. Rate
// upgrades DIVIDE the cooldown (a 20% faster rate is cooldown/1.2), rounded
// to whole ticks so every lockstep peer lands on the same integer.
function gatherCooldownFor(team, resource, baseCooldown){
  let rate = 1;
  if (resource === 'wood') {
    if (hasUpgrade(team,'double_bit_axe')) rate *= 1.2;
    if (hasUpgrade(team,'bow_saw')) rate *= 1.2;
  } else if (resource === 'gold') {
    if (hasUpgrade(team,'gold_mining')) rate *= 1.15;
  }
  return rate === 1 ? baseCooldown : Math.round(baseCooldown / rate);
}
// Max HP a building of this team founds at (or converts to — see
// execUpgradeWalls): base stat plus the HP card multipliers, masonry first
// then fortified_wall, matching applyAgeUpgrades' registry order.
function buildingMaxHpFor(team, btype){
  let hp = BLDGS[btype].hp;
  if (hasUpgrade(team, 'masonry')) hp = Math.round(hp * 1.1);
  if ((btype === 'SWALL' || btype === 'SGATE' || btype === 'TOWER') && hasUpgrade(team, 'fortified_wall')) hp = Math.round(hp * 1.5);
  return hp;
}
// Top off the standing (unexhausted) farms a food card finds on arrival,
// so the upgrade isn't dead weight until the next reseed cycle.
function topUpTeamFarms(team, bonus){
  entities.forEach(f => {
    if (f.type !== 'building' || f.btype !== 'FARM' || f.team !== team || f.hp <= 0) return;
    let tile = map[f.y] && map[f.y][f.x];
    if (tile && tile.t === TERRAIN.FARM && tile.res > 0) {
      tile.res += bonus;
      markMapDirty(f.x, f.y);
    }
  });
}

// ---- PER-TEAM CONTROLLERS ----
// Who drives each team: {type:'human'} (this tab or a remote peer — the
// wire mapping decides which) or {type:'ai', difficulty}. This is SIM
// state: lockstep peers must agree on it (carried in snapshots/resync and
// mixed into simChecksum), and it replaces every old "team 1 is the AI
// when netRole===null" special case with data. Today's two shapes are
// [human, ai] (single-player) and [human, human] (1v1 lockstep), but
// nothing below assumes that — any slot may be either type.
let teamControllers = [{type:'human'}, {type:'ai', difficulty:'standard'}];
function isAITeam(t){ return isPlayerTeam(t) && teamControllers[t] && teamControllers[t].type === 'ai'; }
function isHumanTeam(t){ return isPlayerTeam(t) && !isAITeam(t); }
function aiProfileFor(t){
  let c = teamControllers[t];
  return AI_LEVELS[c && c.difficulty] || AI_LEVELS[aiDifficulty] || AI_LEVELS.standard;
}

// ---- PER-TEAM AI STATE ----
// One plan-state object per AI-controlled team (null for human slots) —
// replaces the old single set of globals (aiTick, window.aiIntel/aiWallPlan/
// aiGateBuilt/aiGateTile/aiWaveCount/aiLastWaveTick/aiSeenWarTick/
// lastAIBaseHitTick), which could only ever drive ONE AI. Plain data:
// structuredClone/JSON-safe so it rides the lockstep snapshot ring and the
// save file unchanged — required for a deterministic AI under rollback.
let AI_STATES = null;
// One restore path for the per-team sim state above, shared by every
// deserializer (lockstep rollback restore, resync apply, save load) so the
// "non-null after restore" guarantee lives in exactly one place.
function restoreTeamState(src){
  if (src.teamControllers) teamControllers = src.teamControllers;
  AI_STATES = src.aiStates || null;
  lastTeamHit = src.lastTeamHit || null;
  teamAlliance = src.teamAlliance || null;
  defeatedTeams = src.defeatedTeams || null;
  teamAge = src.teamAge || null;
  if (!AI_STATES) resetAIStates();
  if (!lastTeamHit) resetLastTeamHit();
  if (!teamAlliance) resetTeamAlliance();
  if (!defeatedTeams) resetDefeatedTeams();
  if (!teamAge) resetTeamAge();
  // Cosmetic seat labels/colors are NOT part of the lockstep snapshot (never
  // hashed/captured) — rollback/resync src won't carry them, so those keep the
  // current values. A SAVE file DOES carry them (js/save.js) so a loaded MP
  // game shows the agreed names/colors; restore when present, else default so
  // teamColor()/teamName() never fault.
  if (src.teamColorMap) teamColorMap = src.teamColorMap; else if (!teamColorMap) resetTeamColorMap();
  if (src.teamNames) teamNames = src.teamNames; else if (!teamNames) resetTeamNames();
}
// The controller layout for the two match shapes that exist today. The
// single derivation point — restart, hosting transitions, and save-load
// fallbacks all route through here rather than hand-flipping slots.
function defaultControllers(mp){
  // MP humans occupy the low team slots (host=0, guest=1); any AI slots in a
  // >2-team MP match are a lobby data change (applyLobbyConfigToTeams,
  // js/lobby.js) applied right after — this default just sizes the array.
  if (mp) return Array.from({length: NUM_TEAMS}, () => ({type:'human'}));
  return Array.from({length: NUM_TEAMS}, (_, t) =>
    t === 0 ? {type:'human'} : {type:'ai', difficulty: aiDifficulty});
}
// SP 4-team = 2v2 (teams 0+1 vs 2+3 — the only >2 shape offered today);
// everything else is every-team-for-itself (identity).
function defaultAlliances(mp){
  if (!mp && NUM_TEAMS === 4) return [0, 0, 1, 1];
  return Array.from({length: NUM_TEAMS}, (_, t) => t);
}
function freshAIState(team){
  return { team, tick: 0,
    intel: null, wallPlan: null, gateBuilt: false, gateTile: null,
    waveCount: 0, lastWaveTick: null, lastWaveGlobalTick: null,
    seenWarTick: null, lastBaseHitTick: null, savingForAge: false, lastAgeUpTick: null,
    // Wildlife danger memory: gather tiles near a bear that mauled one of
    // our villagers are off-limits until the stamp expires or the bear is
    // hunted (canGatherTile, js/logic.js). AoE2 players route around
    // wolves the same way; a 1.2-speed bear outruns 0.8-speed villagers,
    // so avoidance — not fleeing — is what actually saves them.
    dangerZones: [],
    // Consecutive "this is hopeless" decision ticks (maybeResignAI,
    // js/ai.js) — AoE2 AIs concede rather than make the winner grind
    // down every last wall segment.
    resignScore: 0 };
}
function resetAIStates(){
  AI_STATES = Array.from({length: NUM_TEAMS}, (_, t) => isAITeam(t) ? freshAIState(t) : null);
}

// Last hit each team TOOK: lastTeamHit[team] = {tick,x,y} | null. Sim
// state (AI garrison reactions read it on later ticks — snapshot/save it);
// the viewer-local music mood keeps using window.lastWarTick separately.
let lastTeamHit = null;
function resetLastTeamHit(){
  lastTeamHit = Array.from({length: NUM_TEAMS}, () => null);
}

// Which teams are out of the match (lost their TC / eliminated). Sim state
// like lastTeamHit; victory is decided over the alliances of the teams NOT
// in here (checkAllianceVictory, js/logic.js).
let defeatedTeams = null;
function resetDefeatedTeams(){
  defeatedTeams = Array.from({length: NUM_TEAMS}, () => false);
}
// Gaia (neutral sheep/bears), not a player team. Parked far above any
// plausible player id so team 2, 3, ... stay free for actual players —
// gaia at 2 was exactly where the 3rd player's id would have landed.
const GAIA_TEAM = 255;
// Real player teams only, indexed by team id; gaia has its own color below.
// Entries 2+ are pre-picked for future players.
const PLAYER_TEAM_COLORS = ['#2266bb', '#dd3b3b', '#2e9e46', '#d8a800'];
const GAIA_COLOR = '#cccc88';
// Seat -> palette-index indirection. teamColorMap[team] is an index into
// PLAYER_TEAM_COLORS, letting the pre-match lobby (js/lobby.js) give a player
// a color other than their team's default. COSMETIC ONLY: color is never read
// by the sim and never hashed in simChecksum (js/determinism.js), so the two
// lockstep peers may legitimately hold different maps with zero desync risk —
// but in practice both apply the SAME agreed map (carried in lockstep-start)
// so outlines/minimap read consistently on both screens. The default identity
// map [0,1,2,3] reproduces the old fixed behavior exactly (team 0 blue, team 1
// red). Never add this (or teamNames below) to lockstepCaptureState.
let teamColorMap = null;
function resetTeamColorMap(){ teamColorMap = Array.from({length: NUM_TEAMS}, (_, t) => t); }
function teamColorIdx(team){
  return (teamColorMap && teamColorMap[team] != null) ? teamColorMap[team] : team;
}
// Absolute lookup (team 0 default blue, team 1 default red) regardless of
// viewer, remapped through teamColorMap for lobby-chosen colors.
function teamColor(team){
  return team === GAIA_TEAM ? GAIA_COLOR : PLAYER_TEAM_COLORS[teamColorIdx(team)];
}
// Darker variant per team, for building art's shaded/shadow side — kept as
// its own hand-picked pair (not a generic darkenColor() pass) since
// building art wants a specific darker tone, not a percentage darken.
const PLAYER_TEAM_COLORS_DARK = ['#1a4488', '#993333', '#1f6e30', '#9a7800'];
const GAIA_COLOR_DARK = '#999966';
function teamColorDark(team){
  return team === GAIA_TEAM ? GAIA_COLOR_DARK : PLAYER_TEAM_COLORS_DARK[teamColorIdx(team)];
}
// Per-seat display names chosen in the lobby (js/lobby.js). teamNames[team] =
// string | null (null = no name yet / AI / empty seat). Cosmetic and viewer-
// independent — same rules as teamColorMap: never hashed, never snapshotted.
let teamNames = null;
function resetTeamNames(){ teamNames = Array.from({length: NUM_TEAMS}, () => null); }
// A seat's display label: the lobby name if set, else a stable fallback.
function teamName(team){
  return (teamNames && teamNames[team]) ? teamNames[team] : ('Player ' + (team + 1));
}
// Seed both at load so the very first render (single-player, before any
// restartGame) has valid maps. restartGame()/the lobby re-derive them later.
resetTeamColorMap();
resetTeamNames();

// Host-authoritative pre-match lobby state (js/lobby.js). The host writes it
// and rebroadcasts the whole thing on every change; the guest holds a mirror.
// Full-snapshot (not deltas), like lockstep-resync — payload is tiny for two
// seats and it sidesteps out-of-order partial-update bugs. null when no lobby
// is active. Shape: { seats:[{type,name,colorIdx,ready,present}], mapSize,
// speed, numTeams }.
let lobbyState = null;
// This tab's own chosen player name, restored from / persisted to
// localStorage('aoePlayerName') by the lobby. Empty string = not set yet.
let localPlayerName = '';
// Game-seconds per real second (AoE2 "1.7x speed" = 1.7 game-seconds/sec);
// all rates below are authored in real AoE2 game-seconds at 30 ticks each.
// Mutable: the main menu's Speed option sets it via setGameSpeed() (init.js).
let GAME_SPEED = 2;
// Approximate on-screen structure height (px, pre-zoom) per building type —
// footprint diamonds alone don't capture how tall a building actually
// paints, which matters for anything doing screen-space hit-testing against
// a building's visual silhouette (click-to-select in input.js, and the
// behind-a-building outline check in render.js).
const BLDG_HEIGHTS = {
  TC: 80, BARRACKS: 32, HOUSE: 26, LCAMP: 26, MCAMP: 26,
  MILL: 32, FARM: 6, TOWER: 58, PTOWER: 48, WALL: 26, GATE: 32
};
const TERRAIN={GRASS:0,FOREST:1,GOLD:2,STONE:3,WATER:4,FARM:5,BERRIES:6};
const TCOL={
  [TERRAIN.GRASS]:['#4a8c2a','#52942e','#468828','#4e9030'],
  [TERRAIN.FOREST]:['#2a5c1a','#306020','#28581a'],
  [TERRAIN.GOLD]:['#8a7a30','#928234','#7e7028'],
  [TERRAIN.STONE]:['#6a6a6a','#727272','#626262'],
  [TERRAIN.WATER]:['#4499dd','#3b90d0','#3585c5'],
  [TERRAIN.FARM]:['#8a7a50','#7e7048','#927e54'],
  [TERRAIN.BERRIES]:['#4a8c2a','#52942e']
};

const BLDGS={
  // buildTime is villager-work ticks (1 builder = 1 tick of progress per game
  // tick, 30 ticks/game-second), matching AoE2 1-villager build times.
  // armor is {m: melee, p: pierce} — see damageEntity() in logic.js.
  TC:{name:'Town Center',w:4,h:4,hp:2400,cost:{w:275,s:100},builds:['villager'],buildTime:4500,range:6,atk:5,garrisonCap:15,armor:{m:3,p:5},desc:'Town Center. Trains villagers and accepts resource dropoffs. Garrison up to 15 units for protection and extra arrows.',icon:'🏰'},
  HOUSE:{name:'House',w:1,h:1,hp:550,cost:{w:25},pop:5,buildTime:750,armor:{m:0,p:7},desc:'Increases population capacity by 5.',icon:'🏠'},
  LCAMP:{name:'Lumber Camp',w:1,h:1,hp:600,cost:{w:100},drop:'wood',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Wood.',icon:'🪓'},
  MCAMP:{name:'Mining Camp',w:1,h:1,hp:600,cost:{w:100},drop:'gold,stone',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Gold and Stone.',icon:'⛏️'},
  MILL:{name:'Mill',w:2,h:2,hp:600,cost:{w:100},drop:'food',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Food. Food drop-off point. Lets you prepay Farm reseeds.',icon:'🛞'},
  // isFarm buildings only turn their ORIGIN tile (x,y) into actual farmland
  // (see createBuilding in entities.js) — the extra footprint is just a
  // bigger plot of tilled ground for the crop art to fill, not extra food.
  FARM:{name:'Farm',w:2,h:2,hp:480,cost:{w:60},isFarm:true,food:175,buildTime:450,armor:{m:0,p:0},desc:'Constant source of Food. Placed on flat land.',icon:'🌱'},
  BARRACKS:{name:'Barracks',w:3,h:3,hp:1200,cost:{w:175},builds:['militia','spearman','archer','scout','knight','ram'],buildTime:1500,armor:{m:0,p:7},desc:'Trains infantry, archers, and light cavalry.',icon:'⚔️'},
  // Watch Tower doubles as a WALL BASTION here — a deliberate deviation from
  // AoE2, which never lets a tower sit inside a wall line. Because ours anchors
  // the wall, it's the strongest link: hp 2000 (above the 1800 stone wall) and
  // it also rides the fortified_wall upgrade (see UPGRADES / buildingMaxHpFor),
  // so a fully-fortified ring keeps its towers tougher than its segments.
  TOWER:{name:'Watch Tower',w:1,h:1,hp:2000,cost:{w:25,s:125},range:8,atk:5,buildTime:2400,garrisonCap:5,armor:{m:1,p:7},desc:'Defensive tower and wall bastion. Automatically shoots arrows at nearby enemies. Garrison up to 5 units for extra arrows.',icon:'🗼'},
  // Dark-age wooden bastion in the same deliberate deviation: cheap all-wood
  // lookout that anchors an early palisade ring, then upgrades IN PLACE to a
  // Watch Tower once Feudal unlocks it (see WALL_STONE_MATCH / execUpgradeWalls
  // in commands.js). No fortified_wall bonus — that tech is stone-only.
  PTOWER:{name:'Palisade Watch Tower',w:1,h:1,hp:850,cost:{w:110},range:6,atk:4,buildTime:1500,garrisonCap:3,armor:{m:0,p:5},desc:'Wooden lookout and palisade bastion. Shoots arrows at nearby enemies; garrison up to 3 units for extra arrows. Upgrades in place to a Watch Tower.',icon:'🗼'},
  WALL:{name:'Palisade Wall',w:1,h:1,hp:250,cost:{w:2},buildTime:150,armor:{m:2,p:5},desc:'Wooden barrier to slow attackers and block chokepoints. Cheap, but burns fast under melee.',icon:'🪵'},
  GATE:{name:'Palisade Gate',w:1,h:1,hp:400,cost:{w:30},buildTime:900,armor:{m:2,p:2},desc:'Wall opening. Automatically opens for allied units.',icon:'🚪'},
  // Feudal-age stone fortifications — the pre-palisade stats. A stone gate
  // only replaces stone wall segments (and palisade gate only palisades):
  // matching material keeps the consume/refund math and the art coherent.
  SWALL:{name:'Stone Wall',w:1,h:1,hp:1800,cost:{s:5},buildTime:240,armor:{m:8,p:10},desc:'Heavy stone defensive barrier. Requires the Feudal Age.',icon:'🧱'},
  SGATE:{name:'Stone Gate',w:1,h:1,hp:2750,cost:{s:30},buildTime:2100,armor:{m:6,p:6},desc:'Stone wall opening. Automatically opens for allied units.',icon:'🚪'},
  // Feudal-age Market. Trains Trade Carts (which shuttle to any OTHER player's
  // Market for gold, allied or enemy — see updateTradeCart in logic.js) and
  // hosts the global commodity buy/sell exchange (see marketPrices / execMarketTrade
  // in commands.js). The builds:['tradecart'] array is also what lets a Market
  // accept a rally point (execRally bails when builds is empty).
  // walkable: the market is an open-air plaza — once complete its whole
  // footprint passes units (see walkable() in pathfinding.js and the
  // pushUnitsOut skip in entities.js); tiles stay `occupied` so nothing can
  // be built on it.
  MARKET:{name:'Market',w:3,h:3,hp:1200,cost:{w:175},builds:['tradecart'],buildTime:1500,armor:{m:0,p:7},walkable:true,desc:'Trains Trade Carts and lets you buy and sell resources for gold. Trade Carts earn gold by travelling to another player’s Market. Requires the Feudal Age.',icon:'⚖️'}
};
// speed is tiles per game-second; trainTime/rof are ticks (30/game-second).
// rof = reload between attacks; armor = {m: melee, p: pierce}. All values
// track AoE2 Dark/Feudal-age stats.
const UNITS={
  villager:{name:'Villager',hp:25,atk:3,range:0,speed:0.8,rof:60,armor:{m:0,p:0},cost:{f:50},trainTime:750,desc:'Gathers resources and constructs structures.',icon:'🧑‍🌾'},
  militia:{name:'Militia',hp:40,atk:4,range:0,speed:0.9,rof:60,armor:{m:0,p:1},cost:{f:60,g:20},trainTime:630,desc:'Basic infantry soldier. Affordable defense.',icon:'🛡️'},
  spearman:{name:'Spearman',hp:45,atk:3,range:0,speed:1.0,rof:90,armor:{m:0,p:0},cost:{f:35,w:25},trainTime:660,desc:'Anti-cavalry infantry. Strong counter to scouts.',icon:'🔱'},
  archer:{name:'Archer',hp:30,atk:4,range:4,speed:0.96,rof:60,armor:{m:0,p:0},cost:{w:25,g:45},trainTime:1050,desc:'Ranged archer. Effective against infantry, weak to scouts.',icon:'🏹'},
  // 1.55 is the Feudal+ scout speed (free +0.35 at Feudal in AoE2) — and
  // the scout IS Feudal-gated here now (AGE_REQ), so the speed fits.
  scout:{name:'Scout Cavalry',hp:45,atk:3,range:0,speed:1.55,rof:60,armor:{m:0,p:2},cost:{f:80},trainTime:900,desc:'Fast light cavalry. Effective against archers and for scouting.',icon:'🏇'},
  // Castle-age heavy cavalry (AoE2-ish knight).
  knight:{name:'Knight',hp:100,atk:10,range:0,speed:1.35,rof:60,armor:{m:2,p:2},cost:{f:60,g:75},trainTime:900,desc:'Heavy cavalry. Devastating charges, strong armor; counter with spearmen.',icon:'🐴'},
  // Battering ram — Castle-age siege (AGE_REQ), trained at the Barracks
  // (no siege workshop building exists). NOT in MILITARY on purpose (AoE2
  // rams get no blacksmith melee/armor techs — see isArmyUnit). The tiny
  // base attack is vs UNITS; the real damage is the +40 building-class
  // bonus in damageEntity (js/logic.js) — mirrored in the AI's
  // wallBreachTicks (js/ai.js). High pierce armor makes arrow fire (4-5
  // pierce) tick for 1; melee hits it at full damage, the AoE2 counter.
  ram:{name:'Battering Ram',hp:175,atk:2,range:0,speed:0.5,rof:150,armor:{m:-3,p:8},cost:{w:160,g:75},trainTime:1080,desc:'Siege engine. Devastates buildings and walls; nearly immune to arrows but helpless against melee.',icon:'🐏'},
  // Wild predator (AoE2 wolf logic, bear body): gaia team, lurks in the
  // wild, charges any player unit that wanders into its territory, then
  // returns to its den area when the prey escapes. Stronger than an AoE2
  // wolf (45hp/7atk vs 25/3) so a lone villager should run, but a couple
  // of militia put it down without drama.
  bear:{name:'Bear',hp:45,atk:7,range:0,speed:1.2,rof:60,armor:{m:1,p:0},cost:{f:0},trainTime:0,desc:'Wild animal. Attacks anyone who wanders too close.',icon:'🐻'},
  sheep:{name:'Sheep',hp:7,atk:0,range:0,speed:0.7,rof:60,armor:{m:0,p:0},cost:{f:0},trainTime:0,food:100,desc:'Provides Food when harvested.',icon:'🐑'},
  sheep_carcass:{name:'Sheep Carcass',hp:100,atk:0,range:0,speed:0.0,rof:60,armor:{m:0,p:0},cost:{f:0},trainTime:0,desc:'Provides Food when harvested.',icon:'🍖'},
  // Trade Cart — Feudal (AGE_REQ), trained at the Market. Unarmed and
  // defenceless: it shuttles between its home Market and another player's
  // Market, delivering gold scaled by the distance between them (see
  // updateTradeCart in logic.js). Costs 1 pop like any unit.
  tradecart:{name:'Trade Cart',hp:70,atk:0,range:0,speed:1.0,rof:60,armor:{m:0,p:0},cost:{w:100},trainTime:750,desc:'Trades between your Market and another player’s Market to earn gold. The farther apart the Markets, the more gold per trip.',icon:'🛒'}
};

// ---- Unit classification: THE one place a new unit type gets sorted.
// The sim used to spell these groups out as inline utype name-lists at
// half a dozen sites (auto-engage, retaliation, defense responses, blood
// vs timber death FX, guard eligibility) — adding the trade cart meant
// finding and editing every list. Each predicate below names ONE semantic;
// the sites read them.
const HARMLESS_ANIMALS = new Set(['sheep', 'sheep_carcass']); // never fight back, no death cry
const WOOD_VEHICLES = new Set(['ram', 'tradecart']);          // timber rigs: collapse sound, wreck corpse, no blood, never retaliate
function isHarmlessAnimal(u){ return HARMLESS_ANIMALS.has(u.utype); }
function isWoodVehicle(u){ return WOOD_VEHICLES.has(u.utype); }
// A SOLDIER fights on its own initiative — auto-engages, answers a sieged
// ally's call. Not a villager (works), not an animal (bears run their own
// leashed aggro), not a vehicle (carts are unarmed; rams strike only what
// they're ordered onto).
function isSoldierUnit(u){
  return u.type === 'unit' && u.utype !== 'villager' && u.utype !== 'bear'
    && !isHarmlessAnimal(u) && !isWoodVehicle(u);
}
// AI pacing, authored against the AoE2-rate economy (30 ticks per
// game-second; villager trains in 25 game-s, militia in 21 game-s).
// AoE2-style attack plan: the first strike comes no earlier than attackTick,
// then waves repeat with at least waveCooldown between launches. Wave SIZE is
// economy-driven (aiWaveSize, js/ai.js), NOT a per-wave counter: it's a
// fraction (armyPerVil) of the villagers past a small base (armyEcoFloor),
// floored at attackSize and capped at waveCap. Waves still escalate over a
// match — but only because the eco grows toward maxVils, then plateaus —
// mirroring how AoE2 throttles difficulty through the economy (a stunted eco
// fields small attacks) rather than a scripted attack timeline.
// attackTick reference points: hard rushes ~8 game-minutes (a classic drush
// window), easy waits ~18. trickle is free resources per decisionInterval —
// the original AoE2's harder AIs cheated a modest resource trickle; easy
// gets none.
const AI_LEVELS={
  // Easy is handicapped the AoE2 way — NOT by nerfing unit stats or capping the
  // age, but by a weak economy and timid aggression. It CAN still reach Castle
  // (maxAge:2) and build rams/knights, but so slowly (Castle age-up ~35min,
  // needs 13 vils) and attacks so late/small/cautiously (first push ~18min,
  // eco-capped waves of ~3, only commits at a 2x army advantage) that a beginner has ample
  // time to stabilise and siege almost never lands. Mirrors how AoE2's easiest
  // AI feels easy: it's played worse, not given weaker units. Harder levels tech
  // faster and push harder for the real threat.
  easy:{name:'Easy',decisionInterval:240,maxVils:14,queueLimit:1,houseBuffer:1,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:3,armyEcoFloor:8,armyPerVil:0.35,waveCooldown:3600,attackTick:32400,armyReserve:2,militaryFoodReserve:0,dropSites:true,walls:false,wallVils:0,wallRadius:0,attackAdvantage:2.0,trickle:{food:0,wood:0,gold:0,stone:0},maxTowers:0,maxTradeCarts:3,marketVil:12,ecoRatios:{forage:3,chop:3,mine_gold:2},farmShare:3,targetFarms:4,wallCheckInterval:600,wallMaintInterval:600,waveCap:6,allyJoinWindow:0,allyJoinFactor:1.0,maxAge:2,ageUpVils:[0,10,13],ageUpTick:[0,21600,63000],ageSurgeWindow:0,ageSurgeFactor:1.0},
  // Standard plays FAIR — no resource cheat (trickle all 0), like AoE2's
  // Moderate AI. It's still a real challenge (reaches Castle ~15min, fields
  // rams/knights, walls + a tower, pushes from ~10min) but wins on competent
  // play, not free resources. Only hard cheats — AoE2 reserves resource
  // handicaps for its hardest tiers.
  standard:{name:'Medium',decisionInterval:180,maxVils:18,queueLimit:2,houseBuffer:2,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:4,armyEcoFloor:8,armyPerVil:0.6,waveCooldown:2100,attackTick:18000,armyReserve:4,militaryFoodReserve:70,dropSites:true,walls:true,wallVils:10,wallRadius:6,attackAdvantage:1.15,trickle:{food:0,wood:0,gold:0,stone:0},maxTowers:1,maxTradeCarts:5,marketVil:12,ecoRatios:{forage:4,chop:3,mine_gold:3,mine_stone:1},farmShare:3,targetFarms:3,wallCheckInterval:600,wallMaintInterval:300,waveCap:12,allyJoinWindow:600,allyJoinFactor:0.75,maxAge:2,ageUpVils:[0,12,16],ageUpTick:[0,12600,27000],ageSurgeWindow:3600,ageSurgeFactor:0.75},
  hard:{name:'Hard',decisionInterval:120,maxVils:24,queueLimit:3,houseBuffer:3,buildersPerBuilding:2,maxBarracks:2,barracksVil:7,attackSize:5,armyEcoFloor:8,armyPerVil:0.9,waveCooldown:1500,attackTick:14400,armyReserve:6,militaryFoodReserve:120,dropSites:true,walls:true,wallVils:8,wallRadius:7,attackAdvantage:0.9,trickle:{food:2,wood:2,gold:1,stone:1},maxTowers:2,maxTradeCarts:8,marketVil:10,ecoRatios:{forage:4,chop:4,mine_gold:4,mine_stone:1},farmShare:4,targetFarms:4,wallCheckInterval:450,wallMaintInterval:240,waveCap:24,allyJoinWindow:900,allyJoinFactor:0.6,maxAge:2,ageUpVils:[0,10,14],ageUpTick:[0,9000,19800],ageSurgeWindow:3600,ageSurgeFactor:0.6}
};

// Cosmetic-only RNG (particles, audio variation). Anything the SIM reads on
// a later tick must use simRandom/simRandInt below instead — the lockstep
// peers must agree on all sim randomness. DET.strict (js/determinism.js)
// traps Math.random inside the sim tick to enforce this; cosmetic helpers
// that legitimately run DURING the tick (particle/sound spawns from combat)
// use this load-time captured reference to stay exempt from the trap.
const cosmeticRandom = Math.random.bind(Math);
function randInt(min,max){
  return Math.floor(cosmeticRandom()*(max-min+1))+min;
}

// ---- Seeded sim PRNG (mulberry32) ----
// simRngState is SIM STATE: checksummed (simChecksum) and, once lockstep
// lands, saved/restored with snapshots. Both peers seed from the shared
// matchSeed before any sim randomness (incl. map gen) runs.
let simRngState = 1;
let matchSeed = 1;
function seedSimRng(seed){ simRngState = seed >>> 0; }
function simRandom(){
  simRngState = (simRngState + 0x6D2B79F5) | 0;
  let t = Math.imul(simRngState ^ (simRngState >>> 15), 1 | simRngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function simRandInt(min,max){
  return Math.floor(simRandom()*(max-min+1))+min;
}
// ---- Deterministic trig for SIM code ----
// Math.sin/cos/atan2 are implementation-defined per JS engine (each browser
// ships its own libm), so two lockstep peers on different browsers can
// disagree in the last bits and desync. Sim code uses these polynomial
// approximations instead — built only from +,-,*,/ and % (IEEE-exact, so
// identical on every engine). Accuracy ~1e-7 rad (sin/cos) / ~1e-5 (atan2):
// far more than the placement/scatter math needs. Render code should keep
// using Math.sin/cos — it's faster and cosmetic.
const SIM_PI = Math.PI, SIM_2PI = Math.PI * 2, SIM_HALF_PI = Math.PI / 2;
function simSin(x){
  x = x % SIM_2PI;
  if (x > SIM_PI) x -= SIM_2PI; else if (x < -SIM_PI) x += SIM_2PI;
  if (x > SIM_HALF_PI) x = SIM_PI - x; else if (x < -SIM_HALF_PI) x = -SIM_PI - x;
  const x2 = x * x;
  // Taylor degree-9 on [-PI/2, PI/2]
  return x * (1 + x2 * (-1/6 + x2 * (1/120 + x2 * (-1/5040 + x2 / 362880))));
}
function simCos(x){ return simSin(x + SIM_HALF_PI); }
// Math.hypot is spec'd as an "implementation-dependent approximation" (NOT
// correctly-rounded like Math.sqrt), so it differs in the last bits between
// JS engines — same desync class as sin/cos/atan2. Sim code uses this instead:
// Math.sqrt IS IEEE-754 correctly-rounded, so identical on every engine.
function simHypot(dx, dy){ return Math.sqrt(dx * dx + dy * dy); }
function simAtan2(y, x){
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  // atan on [0,1] via minimax polynomial, then octant unfolding
  const z = ay > ax ? ax / ay : ay / ax;
  const z2 = z * z;
  let a = z * (0.9998660 + z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))));
  if (ay > ax) a = SIM_HALF_PI - a;
  if (x < 0) a = SIM_PI - a;
  return y < 0 ? -a : a;
}

// Establish the seed for a fresh match. Host/single-player draws a random
// one; a guest (or a replay) passes the agreed seed in. Must run before
// setMapSize()/genMap() — they consume sim randomness.
function newMatchSeed(seed){
  matchSeed = (seed == null ? Math.random()*0x100000000 : seed) >>> 0;
  seedSimRng(matchSeed);
  if (typeof detStartLog === 'function' && DET.log) detStartLog(matchSeed, { mapSize: MAP, speed: GAME_SPEED });
  return matchSeed;
}

// Corpse decay timeline (wall-clock ms, AoE2-style): fresh body until
// CORPSE_SKEL, then a bone/skeleton stage, fading out over the last 3s
// before CORPSE_LIFE. See drawCorpse() in render-units.js and the corpse
// cull in render.js.
const CORPSE_SKEL=12000, CORPSE_LIFE=25000;
// Tick-based corpse lifetime for the headless simulator only: render.js prunes
// corpses by wall-clock (CORPSE_LIFE ms), but headless never runs render(), so
// it prunes by tick age instead to bound memory (~CORPSE_LIFE at 30 tps).
const CORPSE_LIFE_TICKS=750;

// ---- GAME STATE ----
let map=[], entities=[], entitiesById=new Map(), corpses=[], selected=[], camX=0, camY=0, tick=0;

// Zoom in/out while keeping the world point under screen point (sx,sy) fixed
// in place — used by both wheel zoom (desktop) and pinch zoom (mobile).
function setZoomAroundPoint(newZoom, sx, sy){
  newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if(newZoom === ZOOM) return;
  let isoX = (sx - W/2)/ZOOM + camX;
  let isoY = (sy - (H/2 + topH))/ZOOM + camY;
  ZOOM = newZoom;
  camX = isoX - (sx - W/2)/ZOOM;
  camY = isoY - (sy - (H/2 + topH))/ZOOM;
  window.cameraFollowId = null;
}

// Indexed by team (0 = host/single-player, 1 = guest/AI) rather than two
// separate named globals — see resourceStore() (js/logic.js), the one place
// that should ever be used to read/write these. Array-indexed so a future
// 3rd+ team is a new array entry, not a new named global.
function freshTeamResources(){
  return Array.from({length: NUM_TEAMS}, () => ({food:200,wood:200,gold:100,stone:200,prepaidFarms:0}));
}
let resources = freshTeamResources();
// Global commodity exchange — ONE market shared by every player (AoE2 works
// this way: buying/selling shifts the price for everyone). Gold is the
// currency so it has no price. Buying a resource nudges its price up; selling
// nudges it down; a buy/sell spread means round-tripping loses gold. Prices
// are integer gold-per-100-units and are sim state: checksummed
// (js/determinism.js) and saved (js/save.js), only mutated in execMarketTrade
// (js/commands.js). See MARKET_* tuning constants below.
function freshMarketPrices(){
  return {food:100, wood:100, stone:130};
}
let marketPrices = freshMarketPrices();
// Commodity exchange tuning (integer math for determinism). Trades move 100
// units. SPREAD is applied so buying costs the full price and selling only
// returns SELL_RATIO of it. STEP shifts the price after each 100-unit trade;
// prices clamp to [MIN, MAX]. Mirrors AoE2's drifting commodity market.
const MARKET_LOT = 100;
const MARKET_PRICE_MIN = 25, MARKET_PRICE_MAX = 9999;
const MARKET_PRICE_STEP = 3;   // price change per 100-unit trade
const MARKET_SELL_RATIO = 70;  // sell returns 70% of price (÷100), a 30% spread
// Trade Cart gold per round trip = round(distance-between-markets * this).
// Farther-apart Markets pay more, rewarding spread-out trade (AoE2 behavior).
const TRADE_GOLD_PER_TILE = 1.2;
// Viewer-local convenience caches of MY team's population (see
// refreshPopulationCounts, js/logic.js); per-team reads go through
// teamPopUsed/teamPopCap directly. The old aiPop/aiPopCap/aiTick globals
// are gone — AI bookkeeping lives in AI_STATES (above) per team.
let popUsed=0, popCap=0;
let placing=null, mouseX=0, mouseY=0, dragStart=null, dragEnd=null;
let gameOver=false, won=false;
// `won` is always computed as "did TEAM 0's side win" (js/logic.js's
// checkAllianceVictory; identical on both lockstep peers) — correct as-is
// for the host (myTeam is always 0), but wrong for a guest on the other
// side without adjustment: a guest who actually won would have
// `won === false` and see a "DEFEAT" screen for winning. Every UI-facing
// read of game outcome should go through this instead of raw `won`.
function didIWin(){
  // Alliance-based, not "team 1 is team 0's enemy": a guest seated as
  // team 0's ALLY (4-team save hosted mid-match) shares team 0's outcome.
  return sameSide(myTeam, 0) ? won : !won;
}
let lastSelKey='';
let gameStarted=false, gamePaused=false, aiDifficulty='standard';

// ---- MULTIPLAYER (see js/net.js) ----
// myTeam: which team THIS browser tab plays as. Always 0 in single-player
// and for the host (host keeps its existing team-0 identity); becomes 1 on
// a guest right after joining, since the guest replaces the AI on team 1.
// netRole: null (single-player) | 'host' | 'guest'. netConn/netConnected
// track the PeerJS DataConnection itself.
let myTeam=0, netRole=null;
// The team of the human at THIS keyboard. Set exactly alongside myTeam
// (js/init.js: host stays 0, guest becomes 1) and — unlike myTeam, which
// withCommandContext temporarily swaps to the ISSUING team during command
// execution — NEVER reassigned by replay. That makes it the one reliable
// reference point for issuer-only feedback.
let localHumanTeam = 0;
// The only legal gate for issuer-side feedback (showMsg/playSound/markers/
// updateUI pokes) from sim or command code. Correct by construction for:
// the other peer's command replay (team !== localHumanTeam), the AI calling
// exec* directly (ditto), rollback resim (__resim; the sinks also suppress
// it themselves), and sim events on own units.
function feedbackFor(team, fn){
  if (window.__resim) return;
  if (team !== localHumanTeam) return;
  fn();
}
let netConn=null, netConnected=false;
// Legacy snapshot-sync is gone (lockstep everywhere — js/lockstep.js), but
// markMapDirty stays as a no-op seam: every sim-side map mutation already
// calls it, which is exactly the hook a future map-mutation journal (e.g.
// cheaper rollback snapshots) would need.
function markMapDirty(x,y){}

// Which tile the falling-tree animation started on, and when — LOCAL-ONLY,
// keyed by "x,y" rather than stored as a `fellTick` field directly on the
// map tile object (js/render-terrain.js used to do this). Same bug shape
// as scoutedByMe above: every wood-chop decrements a tile's `res`, which
// calls markMapDirty() and sends that tile as a dirty-cell delta — on the
// GUEST, applying that delta means `map[y][x] = cell` (a brand-new object
// from the wire), wiping out whatever `fellTick` had been set on the OLD
// object. Since the tree-falling trigger is `if (res<=60 && fellTick===
// undefined)`, every single subsequent chop below that threshold saw a
// fresh `undefined` and restarted the fall animation from scratch —
// reported as "the tree falling sequence keeps repeating over and over".
let treeFellTicks = new Map();

// Same shape of bug, two more instances found in the same audit:
// - corpseImpactFxDone: which corpse ids have already played their one-time
//   ground-impact dust puff (js/render-units.js's drawCorpse). Used to live
//   as `c.impactFx` directly on the corpse object — corpses get wholesale-
//   replaced by every sync (`corpses = data.corpses`, js/net-sync.js), so
//   the guest kept re-triggering the puff on every sync instead of once.
// - workSwingCycles: per-unit last work-swing cycle that already fired its
//   impact particle (js/render-units.js) — was `e._swingCyc` directly on
//   the entity, wiped by sync's wholesale entity replacement.
let corpseImpactFxDone = new Set();
let workSwingCycles = new Map();

// Per-building last-fired tick for the guest's damage smoke/fire loop
// (updateBuildingDamageFx, js/loop.js) — a bare tick%N check doesn't
// work since the guest's tick advances fractionally, not per whole tick.
let buildingFxTick = new Map();

// ---- NEW SPEC GAME STATE & HELPERS ----
let fog=[], projectiles=[], particles=[];
let nextProjectileId = 1;

// ids of enemy buildings THIS client has ever seen at active vision (2) —
// lives outside the synced entity data so it survives the wholesale
// entity replace on each sync (host tracks team 0's scouting, guest
// independently tracks team 1's).
let scoutedByMe = new Set();
function markScoutedBuildings(){
  entities.forEach(e => {
    if (e.type === 'building' && e.team !== myTeam && !scoutedByMe.has(e.id) && buildingFogLevel(e) === 2) {
      scoutedByMe.add(e.id);
    }
  });
}

function darkenColor(hex, percent) {
  if (!hex || hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  let num = parseInt(hex.slice(1), 16),
      amt = Math.round(2.55 * percent * 100),
      R = (num >> 16) - amt,
      G = (num >> 8 & 0x00FF) - amt,
      B = (num & 0x0000FF) - amt;
  return "#" + (0x1000000 + (R<0?0:R>255?255:R)*0x10000 + (G<0?0:G>255?255:G)*0x100 + (B<0?0:B>255?255:B)).toString(16).slice(1);
}

function initFog() {
  fog = [];
  let startVal = window.fogDisabled ? 2 : 0;
  for (let y = 0; y < MAP; y++) {
    fog[y] = [];
    for (let x = 0; x < MAP; x++) {
      fog[y][x] = startVal; // Unexplored unless fog is disabled
    }
  }
}

// Shared vision math used by updateFog() (each client's own live fog, for
// whichever team is "me" locally) — the sight-radius table lives in one
// place. Calls cb(x,y) for every currently-visible tile around every
// entity on `team`.
function forEachVisibleTile(team, cb){
  entities.forEach(e => {
    if (e.team !== team) return;

    let sight = 5;
    if (e.type === 'building') {
      if (!e.complete) sight = 1;
      else if (e.btype === 'TC') sight = 8;
      else if (e.btype === 'TOWER') sight = 9;
      else if (e.btype === 'PTOWER') sight = 8;
      else if (e.btype === 'HOUSE') sight = 4;
      else sight = 5;
    } else {
      if (e.utype === 'sheep') sight = 3;
      else if (e.utype === 'scout') sight = 7;
      else sight = 5;
    }

    let cx = Math.round(e.x);
    let cy = Math.round(e.y);
    if (e.type === 'building') {
      let b = BLDGS[e.btype];
      // Footprint spans [e.x, e.x+w) — center tile is Math.floor, not round
      // (round pushes odd-sized buildings, incl. the 3x3 TC, one tile off).
      cx = Math.floor(e.x + (e.w || b.w)/2);
      cy = Math.floor(e.y + (e.h || b.h)/2);
    }

    let offs = sightOffsets(sight);
    for (let i = 0; i < offs.length; i += 2) {
      let tx = cx + offs[i];
      let ty = cy + offs[i + 1];
      if (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) cb(tx, ty);
    }
  });
}

// Precomputed in-circle tile offsets per sight radius: the naive loop
// tested (2s+1)^2 boxes per entity per tick (361 iterations at sight 9,
// ~28% of them misses) — this walks exactly the in-range tiles. sight=1
// keeps its historic square (a fresh foundation sees its 8 neighbors).
let _sightOffsets = new Map();
function sightOffsets(sight){
  let offs = _sightOffsets.get(sight);
  if (offs) return offs;
  let list = [];
  for (let dy = -sight; dy <= sight; dy++) {
    for (let dx = -sight; dx <= sight; dx++) {
      let inRange = sight === 1 ? (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) : (dx*dx + dy*dy <= sight*sight);
      if (inRange) list.push(dx, dy);
    }
  }
  offs = new Int16Array(list);
  _sightOffsets.set(sight, offs);
  return offs;
}

function updateFog() {
  if (!gameStarted) return;
  // Fog is about to change — drop the per-building fog-level memo
  // (buildingFogLevel, js/render-terrain.js) so the next frame recomputes.
  if (typeof invalidateBuildingFogMemo === 'function') invalidateBuildingFogMemo();
  if (window.fogDisabled) {
    // Map revealed: every tile reads as actively-visible (2) so render/build
    // logic (which already branches on fog level) just sees a lit map.
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) fog[y][x] = 2;
    return;
  }
  // Single combined pass when the sim's per-team visibility is fresh
  // (updateTeamVision runs just before this in update()): downgrade stale
  // active vision and set the new visible tiles in one sweep. A legacy
  // (non-lockstep) guest never runs update(), so its grids are stale —
  // fall back to the downgrade loop + its own vision walk.
  if (visionFreshTick >= tick - 1 && visionFreshTick >= 0 && teamVisGrid) {
    const vg = teamVisGrid[myTeam];
    for (let y = 0; y < MAP; y++) {
      const row = fog[y], base = y * MAP;
      for (let x = 0; x < MAP; x++) {
        if (vg[base + x] > 0) row[x] = 2;
        else if (row[x] === 2) row[x] = 1;
      }
    }
    return;
  }
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (fog[y][x] === 2) fog[y][x] = 1;
    }
  }
  forEachVisibleTile(myTeam, (tx, ty) => { fog[ty][tx] = 2; });
}

// ---- Deterministic per-team visibility (SIM state) ----
// The sim must never read `fog` (viewer-local — each client computes it for
// its OWN team, so two lockstep peers reading it would diverge). Sim
// decisions (auto-acquire fog gates, placement explored-rules, combat
// target visibility) read these instead: recomputed every tick inside
// update() from entities alone, so every peer agrees exactly.
// INCREMENTAL count grids: teamVisGrid[team][k] is the number of friendly
// (ally-shared) entities whose sight disk currently covers tile k — visible
// iff > 0. On each refresh tick we DIFF each entity against the disk it last
// contributed (visStamps) and only add/remove the deltas for entities that
// moved / were created / vanished, instead of re-stamping every entity's whole
// disk every time (that full re-stamp was the single biggest sim cost, ~38% of
// the headless tick). Reconciliation happens ONLY on refresh ticks, so a dead
// or moved entity's vision persists exactly until the next refresh — bit-for-
// bit identical to the old full re-stamp (verified by checksum equality).
// teamExploredGrid[team][k] === 1  ->  team has EVER seen tile k (monotonic;
// set on add, never cleared — deterministic history, same on every peer).
let visionFreshTick = -1; // which sim tick the grids were computed for
// How often the deterministic per-team vision grids are rebuilt (see
// updateTeamVision). 2 is the shipped default; higher = faster/laggier vision.
const VISION_REFRESH_TICKS = 2;
let teamVisGrid = null, teamExploredGrid = null;
let visStamps = new Map();  // entity id -> {t,cx,cy,s,gen} last-applied vision disk
let visScanGen = 0;         // bumped each refresh; entities not re-marked this gen have vanished
let visionRebuild = true;   // force a from-scratch recount (first run / rollback / load / alliance change)
let visAllianceSig = '';    // detects an alliance change (removeDisk relies on stable ally groups)

// ---- SIM-CACHE GENERATION COUNTER ----
// Rollback/resync/save-load rewinds `tick`, so a cache keyed by
// `cacheTick === tick` alone can collide with the abandoned timeline and
// serve stale data into the resim (a real desync source — this bit both
// gatherClaims and unitGrid). RULE: any memo that persists across ticks
// must ALSO key on simGen, and register a reset callback here. bumpSimGen()
// is called from every path that replaces/rewinds sim state: lockstepRestore,
// lockstepApplyResync, applySavedGame, restartGame.
// simGen itself is NOT sim state (peers may roll back different numbers of
// times) — never hash or snapshot it.
let simGen = 0;
const SIM_CACHES = []; // reset callbacks, one per registered cache
function registerSimCache(fn){ SIM_CACHES.push(fn); }
function bumpSimGen(){ simGen++; SIM_CACHES.forEach(fn => fn()); }
// Rollback/resync/load rewinds the world but the count grid isn't snapshotted
// (it's a pure derived cache), so force a from-scratch recount next refresh.
registerSimCache(() => { visionFreshTick = -1; visionRebuild = true; });
function resetTeamVision(){
  teamVisGrid = Array.from({length: NUM_TEAMS}, () => new Int32Array(MAP * MAP));
  teamExploredGrid = Array.from({length: NUM_TEAMS}, () => new Uint8Array(MAP * MAP));
  visStamps = new Map();
  visionRebuild = true;
  visionFreshTick = -1;
}
function updateTeamVision(){
  if (!teamVisGrid || teamVisGrid[0].length !== MAP * MAP) resetTeamVision();
  // Rebuilt every VISION_REFRESH_TICKS (the per-team vision update is the
  // biggest sim cost at scale; sim reads tolerating a tick or two of stale
  // visibility are imperceptible). Deterministic — cadence is tick-derived.
  if (visionFreshTick >= 0 && tick - visionFreshTick < VISION_REFRESH_TICKS) return;
  visionFreshTick = tick;

  // Ally-shared groups: an entity's disk is applied to its team AND every
  // team allied with it (teamCanSeeTile/teamHasExplored become ally-shared).
  const allied = [];
  for (let t = 0; t < NUM_TEAMS; t++) { const g = []; for (let u = 0; u < NUM_TEAMS; u++) if (sameSide(t, u)) g.push(u); allied.push(g); }
  // removeDisk() below uses the CURRENT ally group of the removed disk's team,
  // so a changed alliance would mis-account stale counts — force a clean
  // recount when the alliance layout changes (rare; usually never mid-match).
  const sig = allied.map(g => g.join('.')).join('|');
  if (sig !== visAllianceSig) { visionRebuild = true; visAllianceSig = sig; }

  // Apply an entity's sight disk to the count grids. delta +1 adds vision (and
  // marks explored), -1 removes it. Center/sight math is identical to
  // forEachVisibleTile (kept for updateFog), so the visible SET this produces
  // equals the old full re-stamp exactly.
  const applyDisk = (t, cx, cy, s, delta) => {
    const offs = sightOffsets(s), group = allied[t];
    for (let i = 0; i < offs.length; i += 2) {
      const tx = cx + offs[i], ty = cy + offs[i + 1];
      if (tx < 0 || tx >= MAP || ty < 0 || ty >= MAP) continue;
      const k = ty * MAP + tx;
      for (let g = 0; g < group.length; g++) {
        const u = group[g];
        teamVisGrid[u][k] += delta;
        if (delta > 0) teamExploredGrid[u][k] = 1; // monotonic; never cleared on removal
      }
    }
  };

  if (visionRebuild) { for (let t = 0; t < NUM_TEAMS; t++) teamVisGrid[t].fill(0); visStamps.clear(); visionRebuild = false; }

  visScanGen++;
  const gsig = visScanGen;
  for (let ei = 0; ei < entities.length; ei++) {
    const e = entities[ei];
    const team = e.team;
    const old = visStamps.get(e.id);
    if (team < 0 || team >= NUM_TEAMS) { // gaia (255) never contributed vision
      if (old) { applyDisk(old.t, old.cx, old.cy, old.s, -1); visStamps.delete(e.id); }
      continue;
    }
    let sight, cx, cy;
    if (e.type === 'building') {
      const b = BLDGS[e.btype];
      if (!e.complete) sight = 1;
      else if (e.btype === 'TC') sight = 8;
      else if (e.btype === 'TOWER') sight = 9;
      else if (e.btype === 'PTOWER') sight = 8;
      else if (e.btype === 'HOUSE') sight = 4;
      else sight = 5;
      cx = Math.floor(e.x + (e.w || b.w) / 2);
      cy = Math.floor(e.y + (e.h || b.h) / 2);
    } else {
      if (e.utype === 'sheep') sight = 3;
      else if (e.utype === 'scout') sight = 7;
      else sight = 5;
      cx = Math.round(e.x);
      cy = Math.round(e.y);
    }
    if (old && old.t === team && old.cx === cx && old.cy === cy && old.s === sight) { old.gen = gsig; continue; } // unchanged: keep its disk
    if (old) applyDisk(old.t, old.cx, old.cy, old.s, -1); // moved / grew: drop the stale disk
    applyDisk(team, cx, cy, sight, +1);
    visStamps.set(e.id, { t: team, cx, cy, s: sight, gen: gsig });
  }
  // Entities that vanished (died / removed) since the last refresh: their disk
  // was left in place until now (matching the old grid's persist-until-refresh
  // behavior) — remove it.
  visStamps.forEach((st, id) => { if (st.gen !== gsig) { applyDisk(st.t, st.cx, st.cy, st.s, -1); visStamps.delete(id); } });
}
function teamCanSeeTile(team, k){
  return teamVisGrid != null && teamVisGrid[team][k] > 0;
}
function teamHasExplored(team, k){
  return teamExploredGrid != null && teamExploredGrid[team][k] === 1;
}
// Deterministic "this human team can't act on tile k yet because it hasn't
// been explored" gate — shared by canPlace (js/logic.js) and the villager
// gather resolve (js/commands.js). AI teams are exempt (proximity vision,
// not fog-based); fog-off (dev/sim) reveals everything.
function tileHiddenForTeam(team, k){
  return !window.fogDisabled && !isAITeam(team) && !teamHasExplored(team, k);
}
// Building visibility for sim decisions: any footprint tile visible to `team`.
function buildingVisibleToTeam(b, team){
  if (window.fogDisabled) return true;
  let bw = b.w || (BLDGS[b.btype] && BLDGS[b.btype].w) || 1;
  let bh = b.h || (BLDGS[b.btype] && BLDGS[b.btype].h) || 1;
  for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) {
    if (teamCanSeeTile(team, (b.y + dy) * MAP + (b.x + dx))) return true;
  }
  return false;
}

// One-shot / session-lifecycle flags for the MP connection, consolidated
// from scattered ad hoc `window.__flag` properties into one place:
//   cameraCentered      — has this guest tab centered its camera yet
//   hostJustLoadedSave  — host just loaded a save mid-match; next full
//                          sync should force the guest to re-center
//   loadedHostPeerId    — peer id to request when re-hosting from a save
//   hostPeerId          — the host's peer id this client knows
//   bottomHeightSet     — has the guest's bottom-bar height been computed
//   guestInitialMenuHidden — has the guest's pre-match panel been dismissed
//   awaitingStateFromGuest — this is a rehosted page (?host= resume link)
//                          waiting to recover the world from the guest's
//                          live mirror (see enterHostResumeMode, js/init.js)
//   stateRequestTimer   — the 5s re-request interval for the above
//   inLobby             — a connection is open and both peers are in the
//                          pre-match lobby (js/lobby.js), before Start. This
//                          is deliberately NOT mpMatchStarted (js/init.js) —
//                          the match hasn't begun, so reconnect/resume paths
//                          (which gate on mpMatchStarted) must stay dormant.
window.__mpSession = {
  cameraCentered: false,
  hostJustLoadedSave: false,
  loadedHostPeerId: null,
  hostPeerId: null,
  bottomHeightSet: false,
  guestInitialMenuHidden: false,
  awaitingStateFromGuest: false,
  stateRequestTimer: null,
  inLobby: false,
};

function spawnParticles(x, y, color, count, speed=0.03, size=2) {
  if (window.__resim) return; // rollback resim replays past ticks silently (js/lockstep.js)
  if (window.__headlessSim) return; // nothing renders them; they'd only pile up
  let type = 'dust';
  if (color === '#9c382a') type = 'blood';
  else if (color.includes('rgba(100,100,100') || color === '#888' || color === '#666') type = 'smoke';
  else if (color === '#ff4500' || color === '#ff8c00' || color === '#ffd700') type = 'fire';
  else if (color === '#4e8c2d') type = 'grass';

  for (let i = 0; i < count; i++) {
    let angle = cosmeticRandom() * Math.PI * 2;
    let sp = cosmeticRandom() * speed;
    let maxLife = type === 'blood' ? randInt(40, 60) : randInt(20, 35);
    
    let z = 0;
    let vz = 0;
    let gravity = 0;
    let drag = 1.0;
    
    if (type === 'blood') {
      z = 0.35 + cosmeticRandom() * 0.2; // Torso level
      vz = 0.02 + cosmeticRandom() * 0.03;
      gravity = 0.003;
      drag = 0.96;
    } else if (type === 'fire') {
      z = 0.1;
      vz = 0.01 + cosmeticRandom() * 0.015;
      gravity = -0.0003;
      drag = 0.98;
    } else if (type === 'smoke') {
      z = 0.2;
      vz = 0.008 + cosmeticRandom() * 0.012;
      gravity = -0.0002;
      drag = 0.95;
    } else if (type === 'dust' || type === 'grass') {
      z = 0.05;
      vz = 0.02 + cosmeticRandom() * 0.03;
      gravity = 0.004;
      drag = 0.94;
    }

    particles.push({
      x: x + (cosmeticRandom() - 0.5) * 0.3,
      y: y + (cosmeticRandom() - 0.5) * 0.3,
      z: z,
      vx: Math.cos(angle) * sp,
      vy: Math.sin(angle) * sp,
      vz: vz,
      gravity: gravity,
      drag: drag,
      life: maxLife,
      maxLife: maxLife,
      color: color,
      type: type,
      size: size + cosmeticRandom() * 1.5
    });
  }
}

// AoE2-style ballistics: arrows fly to a fixed ground POSITION (where the
// target was at fire time), not to the target entity — so fast units can
// dodge by moving, and a shot lands on whoever is standing at the impact
// point. Archers have 80% accuracy (a miss scatters the aim point);
// tower/TC fire is 100% accurate, as in AoE2.
function spawnProjectile(attacker, target) {
  attacker.lastAtkTick = tick; // combat activity — see stuck-watchdog exemption (js/logic.js)
  let targetX = target.type === 'building' ? target.x + (target.w || BLDGS[target.btype].w)/2 : target.x;
  let targetY = target.type === 'building' ? target.y + (target.h || BLDGS[target.btype].h)/2 : target.y;
  let accuracy = attacker.type === 'building' ? 1.0 : 0.8;
  if (target.type !== 'building' && simRandom() > accuracy) {
    let ang = simRandom() * Math.PI * 2;
    let off = 0.6 + simRandom() * 0.8;
    targetX += simCos(ang) * off;
    targetY += simSin(ang) * off;
  }
  let dxp = attacker.x - targetX, dyp = attacker.y - targetY;
  let d = Math.sqrt(dxp*dxp + dyp*dyp);
  let proj = {
    id: nextProjectileId++,
    x: attacker.x,
    y: attacker.y,
    startX: attacker.x,
    startY: attacker.y,
    // Launch height: towers/TC fire from their battlements, units from
    // chest height — drawProjectiles blends this down to impact height.
    startH: attacker.type === 'building' ? (attacker.btype === 'TC' ? 55 : 36) : 12,
    totalDist: d,
    tx: targetX,
    ty: targetY,
    // Buildings can't sidestep — a shot at a building always connects.
    targetBuildingId: target.type === 'building' ? target.id : null,
    // Id + a plain-data snapshot instead of a live object reference: the
    // impact (js/loop.js) prefers the live entity by id, but the snapshot
    // means an arrow still lands with the right team/damage after its
    // shooter dies mid-flight — and keeps projectiles JSON-safe, so saves
    // can carry in-flight volleys instead of silently dropping their
    // pending damage. Fields = exactly what damageEntity reads.
    attackerId: attacker.id,
    attackerSnap: {
      id: attacker.id, team: attacker.team, type: attacker.type,
      btype: attacker.btype, utype: attacker.utype,
      atk: attacker.atk, range: attacker.range
    }
  };
  projectiles.push(proj);
  if (window.playSound) window.playSound('arrow', attacker.x, attacker.y);
}

function isUnitOnScreen(en) {
  let iso = toIso(en.x, en.y);
  let sx = (iso.ix - camX) * ZOOM + W/2;
  let sy = (iso.iy - camY + HALF_TH) * ZOOM + H/2 + topH;
  return sx >= -50 * ZOOM && sx <= W + 50 * ZOOM && sy >= -50 * ZOOM && sy <= H + 50 * ZOOM;
}

// Returns a SHARED scratch object (every call site destructures the two
// numbers immediately — never hold a reference to the returned object).
// Called several times per unit per frame; allocating a fresh {ox,oy} each
// time was measurable GC churn on mobile.
const _unitGroupOffset = { ox: 0, oy: 0 };
function getUnitGroupOffset(entityId) {
  let idOff = entityId % 7;
  _unitGroupOffset.ox = (idOff % 3 - 1) * 6;
  _unitGroupOffset.oy = (Math.floor(idOff / 3) - 1) * 4;
  return _unitGroupOffset;
}
