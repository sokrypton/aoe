// ---- SCENARIO LOADER ----
// Build a reproducible world from a compact JSON spec, for automated testing
// (the headless sim, tools/simulate.js) and manual inspection (the game). It
// reuses restartGame()'s full reset; genMap() (js/map.js) and init() (js/init.js)
// skip their procedural map + default TC/villager/scout/sheep/bear placement
// when window.__scenarioMode is set, leaving a clean grass base onto which the
// spec's terrain/resource overrides and entities are placed.
//
// Spec (all fields optional):
//   {
//     map: 'small'|'medium'|'large'|N,   // map size (default 'medium')
//     seed: 7,                            // PRNG seed → reproducible (default 1)
//     numTeams: 2,                        // default 2
//     difficulty: 'hard',                 // AI difficulty for ai slots
//     controllers: ['human','ai:hard'],   // per team; default P0 human, rest AI
//     ages: [0, 2],                        // per-team age 0/1/2 (Dark/Feudal/Castle); default all 0
//     resources: [ {food,wood,gold,stone,prepaidFarms?}, ... ], // per-team start stockpiles;
//                                          //   default 200/200/100/200. Missing team/field → default.
//     terrain: [ {t:'FOREST'|'GOLD'|'STONE'|'BERRIES'|'WATER'|'FARM', x, y, amount?} ],
//     entities:[ {u:'knight', x, y, team, stance?}  // a unit
//              | {b:'TC',     x, y, team, w?, h?} ]  // a (complete) building
//                                                    // w/h: non-default footprint (e.g. a sized gate)
//   }
// `ages`/`resources` are the compact format's way to carry the per-team state a
// full save (js/save.js) holds — so a minimal file round-trips team state too.
// Coordinates are integer tiles (a settled unit rests on an integer — the tile
// center; see js/pathfinding.js stepUnitAlongPath).
const SCENARIO_RES_DEFAULT = { FOREST:100, GOLD:800, STONE:350, BERRIES:125, WATER:0, FARM:0, GRASS:0 };

function parseScenarioController(c){
  if(typeof c==='string' && c.indexOf('ai')===0){
    let d=c.split(':')[1];
    return {type:'ai', difficulty:(typeof AI_LEVELS!=='undefined' && AI_LEVELS[d]) ? d : 'standard'};
  }
  return {type:'human'};
}

function loadScenario(spec){
  spec = spec || {};
  if(spec.numTeams) NUM_TEAMS = spec.numTeams;
  // setMapSize consumes __pendingMatchSeed via newMatchSeed → deterministic map
  // + PRNG. Must run BEFORE restartGame (its init()/genMap use the seeded PRNG).
  window.__pendingMatchSeed = (spec.seed != null ? spec.seed : 1) >>> 0;
  setMapSize(spec.map || 'medium');
  window.__scenarioMode = true;
  restartGame(spec.difficulty || 'standard'); // full reset; skips default world
  window.__scenarioMode = false;
  // Fog OFF by default in scenarios: the whole authored map should be visible,
  // and (crucially) the human-team auto-acquire is fog-gated — with fog on,
  // units can't "see"/engage a target beyond their sight radius, which defeats
  // most combat test setups. Set spec.fog:true to keep fog for a fog test.
  window.fogDisabled = spec.fog !== true;

  // Terrain / resource overrides on the blank grass base.
  (spec.terrain || []).forEach(o=>{
    if(o.x<0 || o.y<0 || o.x>=MAP || o.y>=MAP) return;
    let ty = TERRAIN[o.t];
    if(ty === undefined) return;
    let res = o.amount != null ? o.amount : (SCENARIO_RES_DEFAULT[o.t] || 0);
    map[o.y][o.x] = { t: ty, res, occupied: null };
    if(typeof markMapDirty==='function') markMapDirty(o.x, o.y);
  });

  // Per-team controllers (after restartGame's defaults).
  if(spec.controllers && spec.controllers.length){
    teamControllers = Array.from({length: NUM_TEAMS}, (_, t) => parseScenarioController(spec.controllers[t]));
    if(typeof resetAIStates==='function') resetAIStates();
  }

  // Per-team AGE and RESOURCES (optional — the compact format's way to carry
  // the team state a full save holds). Applied AFTER restartGame's defaults and
  // BEFORE entities are created, so scenario-built units/walls snapshot the
  // age's bonuses at creation (createUnit atk/range/speed, createBuilding
  // fortified-wall hp — all read hasUpgrade/teamAge). setTeamAge also sweeps any
  // existing units, so order-independence holds either way.
  if(spec.ages){
    for(let t=0;t<NUM_TEAMS;t++) if(spec.ages[t]!=null && typeof setTeamAge==='function') setTeamAge(t, spec.ages[t]);
  }
  if(spec.resources){
    // Merge onto the existing per-team default object (restartGame already set
    // resources = freshTeamResources()) — overwrite only the provided fields.
    for(let t=0;t<NUM_TEAMS;t++) if(spec.resources[t] && resources[t]) Object.assign(resources[t], spec.resources[t]);
  }

  // Entities: buildings first (so unit spawn-out doesn't fight foundations),
  // then units. Buildings are created complete (createBuilding default).
  (spec.entities || []).filter(o=>o.b).forEach(o=>{
    // o.w/o.h carry a non-default footprint (e.g. a multi-tile gate sized by
    // gateFootprint in the editor); absent → createBuilding uses the BLDGS default.
    let b = createBuilding(o.b, o.x, o.y, o.team||0, o.w != null ? o.w : null, o.h != null ? o.h : null);
    if(b) b.complete = true;
  });
  (spec.entities || []).filter(o=>o.u).forEach(o=>{
    let u = createUnit(o.u, o.x, o.y, o.team||0);
    if(u && o.stance) u.stance = o.stance;
  });

  if(typeof refreshPopulationCounts==='function') refreshPopulationCounts();
  gameStarted = true;

  // Center the camera on the authored content (its default is STARTS[0], which
  // a scenario usually doesn't use). Harmless headless — render never reads it.
  let ents = spec.entities || [];
  if(ents.length && typeof toIso==='function'){
    let cx = ents.reduce((s,e)=>s+e.x,0)/ents.length;
    let cy = ents.reduce((s,e)=>s+e.y,0)/ents.length;
    let iso = toIso(cx, cy);
    camX = iso.ix; camY = iso.iy;
    window.targetCamX = camX; window.targetCamY = camY; window.cameraFollowId = null;
  }
  return spec;
}

// Game launch: index.html / classic.html with ?scenario=<url> fetches and loads
// the spec after the normal startup. Headless (tools/sim.html) calls
// loadScenario() directly with the parsed object instead.
async function maybeLoadScenarioFromURL(){
  let src;
  try { src = new URLSearchParams(location.search).get('scenario'); } catch(e){ return false; }
  if(!src) return false;
  try {
    let spec = await (await fetch(src)).json();
    loadScenario(spec); // centers the camera itself
    if(typeof updateUI==='function') updateUI();
    return true;
  } catch(e){ console.error('[scenario] load failed:', e); return false; }
}
