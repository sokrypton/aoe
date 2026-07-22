// ---- GAME LOGIC ----
function canPlace(type,x,y,team=0,ignoreAge=false,rejectUnits=false){
  // Age gate — sim-authoritative (binds humans, relayed guests, and AI). The
  // scenario editor passes ignoreAge=true: authoring isn't age-bound, but every
  // GEOMETRIC rule below (gate-on-wall, no build on water/resources, no overlap)
  // still applies so the editor obeys the same placement restrictions as play.
  if(!ignoreAge && !isUnlocked(team,type))return false;
  let b=BLDGS[type];
  let bw=b.w, bh=b.h;
  let ox=x, oy=y;
  if(isGateBtype(type)){
    // A gate can ONLY be placed on an existing run of allied MATCHING-material
    // tiles: walls (palisade gate on palisade, stone on stone) OR a same-type
    // gate (rebuild/repair in place). gateFootprint picks the run (prefers
    // 3-tile, falls back to 2) — use it here so placement validation checks
    // EXACTLY the tiles that get built.
    let isWall = (tx, ty) => gateBaseAt(tx, ty, type, team);
    ({ ox, oy, gw: bw, gh: bh } = gateFootprint(x, y, isWall));
    if (bw === 1 && bh === 1) return false; // no matching run to build on
  }
  // rejectUnits (EDITOR only): the editor drops a COMPLETE, instantly-solid
  // building, so refuse to place it on a unit — no shove/teleport, the author
  // moves or erases the unit first. Gameplay leaves this false: a foundation is
  // walkable and the build-gate clears the footprint gently, so building over
  // your own units is fine (AoE2).
  if(rejectUnits){
    for(let i=0;i<entities.length;i++){
      let u=entities[i];
      if(u.type!=='unit'||u.garrisonedIn)continue;
      let ux=Math.round(u.x), uy=Math.round(u.y);
      if(ux>=ox&&ux<ox+bw&&uy>=oy&&uy<oy+bh)return false;
    }
  }
  for(let dy=0;dy<bh;dy++)for(let dx=0;dx<bw;dx++){
    let nx=ox+dx,ny=oy+dy;
    if(nx<0||nx>=MAP||ny<0||ny>=MAP)return false;
    // Never gate placement on the viewer `fog` grid — it's only valid for
    // the team updateFog() computed locally (a `team===myTeam` check inside
    // a swapped command context silently blocked legitimate guest builds).
    // Deterministic explored-rule, symmetric per team (teamExploredGrid is
    // sim state computed identically on every peer — js/core.js). Applies
    // to EVERY team, AI included (information parity — the AI's wall ring
    // waits for its scout's base-survey lap, js/ai.js planAIWalls).
    if(tileHiddenForTeam(team, ny*MAP+nx))return false;
    let t=map[ny][nx];
    if(t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)return false;
    if(t.occupied){
      let existing = entitiesById.get(t.occupied);
      // GATE, TOWER, and a STONE WALL upgrade may be placed on top of an
      // existing allied wall (they consume the wall tile(s) they're built on,
      // see execBuildPlacement's plan.replaced); anything else must not overlap
      // an existing building. Dropping a stone piece on its palisade counterpart
      // (WALL_STONE_MATCH: wall/gate/tower) is the upgrade: a COMPLETE piece
      // salvage-swaps in place (like the Upgrade button); an UNBUILT one is
      // cancelled (refunded) and overwritten with a fresh stone site — the exec
      // paths split on `complete`, both handled, neither stacks.
      if (existing && existing.type === 'building' && existing.team === team &&
          (WALL_STONE_MATCH[existing.btype] === type ||
           (isGateBtype(type) && (existing.btype === GATE_WALL_MATCH[type] || existing.btype === type)) ||
           (isTowerBtype(type) && isWallBtype(existing.btype)))) {
        continue; // wood→stone build-over; gate on matching wall / same-type gate; tower on wall
      }
      return false;
    }
  }
  return true;
}
function getLineTiles(p1, p2) {
  let tiles = [];
  let dx = p2.x - p1.x;
  let dy = p2.y - p1.y;
  let steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) {
    tiles.push({x: p1.x, y: p1.y});
    return tiles;
  }
  for (let i = 0; i <= steps; i++) {
    let t = i / steps;
    let tx = Math.round(p1.x + t * dx);
    let ty = Math.round(p1.y + t * dy);
    // Rounding along a straight line can only ever repeat the IMMEDIATELY
    // previous tile, so comparing against the last one suffices.
    let last = tiles[tiles.length - 1];
    if (!last || last.x !== tx || last.y !== ty) {
      tiles.push({x: tx, y: ty});
    }
  }
  return tiles;
}


const RES_KEYS={f:'food',w:'wood',g:'gold',s:'stone'};
// cooldown = ticks per 1 resource, tuned to AoE2 base gather rates (wood
// ~0.39/s, gold ~0.38/s, stone ~0.36/s, farm ~0.32/s, forage ~0.31/s).
const GATHER_TASKS={
  chop:{terrain:TERRAIN.FOREST,resource:'wood',cooldown:T30(77),clearOccupied:true},
  mine_gold:{terrain:TERRAIN.GOLD,resource:'gold',cooldown:T30(79)},
  mine_stone:{terrain:TERRAIN.STONE,resource:'stone',cooldown:T30(83)},
  farm:{terrain:TERRAIN.FARM,resource:'food',cooldown:T30(94),clearOccupied:true,removeFarm:true,requiresOwnCompleteFarm:true},
  forage:{terrain:TERRAIN.BERRIES,resource:'food',cooldown:T30(97)}
};

// Range at which a villager can slaughter a sheep / harvest a carcass. Must
// be >= the diagonal tile spacing (~1.41) so the whole RING of neighbours
// around the carcass can eat at once, not just the one on its tile.
const SHEEP_HARVEST_RANGE=1.5;

function resourceStore(team){
  return resources[team];
}

function resourceName(key){
  return RES_KEYS[key]||key;
}

// The net cost of placing `btype` when it CONSUMES existing walls (a gate
// dropped on two palisades, a stone wall upgrading a palisade, a tower built
// over a wall tile): each consumed wall refunds its OWN cost — palisades
// refund wood, stone walls stone — floored at 0 per resource. THE one
// implementation; the AI's placeAIBuilding and the player's
// execBuildPlacement must charge identically or the two paths drift.
function effectiveBuildCost(btype, replacedWalls){
  let cost = { ...BLDGS[btype].cost };
  (replacedWalls || []).forEach(w => {
    Object.entries(BLDGS[w.btype].cost).forEach(([k, amt]) => {
      cost[k] = Math.max(0, (cost[k] || 0) - amt);
    });
  });
  return cost;
}

function canAfford(team,cost){
  let store=resourceStore(team);
  return Object.entries(cost||{}).every(([key,amount])=>store[resourceName(key)]>=amount);
}

function spendCost(team,cost){
  let store=resourceStore(team);
  Object.entries(cost||{}).forEach(([key,amount])=>{store[resourceName(key)]-=amount;});
}

// Credit a cost back to a team's store (queue/research/foundation cancels).
function refundCost(team,cost){
  let store=resourceStore(team);
  Object.entries(cost||{}).forEach(([key,amount])=>{store[resourceName(key)]+=amount;});
}

function unitPop(type){
  return (type==='sheep'||type==='bear')?0:1;
}

function teamPopUsed(team){
  return entities.filter(e=>e.type==='unit'&&e.team===team&&unitPop(e.utype)>0).length;
}

function buildingPop(e,includeIncomplete){
  if(e.type!=='building')return 0;
  if(!includeIncomplete&&!e.complete)return 0;
  // House rule: 10 pop (AoE2 gives 5, less than a house — feels wrong here).
  if(e.btype==='TC')return 10;
  return BLDGS[e.btype].pop||0;
}

function teamPopCap(team,includeIncomplete=false){
  let cap = entities.reduce((total,e)=>e.team===team?total+buildingPop(e,includeIncomplete):total,0);
  return Math.min(200, cap);
}

function teamQueuedPop(team){
  return entities.reduce((total,e)=>{
    if(e.type!=='building'||e.team!==team)return total;
    return total+e.queue.reduce((sum,utype)=>sum+unitPop(utype),0);
  },0);
}

function hasPopulationRoom(team,utype,includeQueue=true){
  return teamPopUsed(team)+(includeQueue?teamQueuedPop(team):0)+unitPop(utype)<=teamPopCap(team);
}

// AoE2-lite anti-softlock: the villager that climbs you OUT of a 0-villager hole
// is FREE — the first villager queued at a building while the team has NO living
// villager (garrisoned count as living) costs nothing. Human or AI (both come
// through queueUnit). `priorQueue` is the building's queue BEFORE the entry in
// question — the whole queue at train time, queue[0..idx) at cancel time — so the
// train cost and the cancel refund agree and cancelling it can't mint resources.
function unitTrainCost(team,utype,priorQueue){
  if(utype==='villager'
     && !priorQueue.some(u=>u==='villager')
     && !entities.some(e=>e.team===team&&e.type==='unit'&&e.utype==='villager'&&e.hp>0))
    return {}; // free
  return UNITS[utype].cost;
}

function canQueueUnit(bldg,utype){
  if(!isUnlocked(bldg.team,utype))return {ok:false,reason:'age'};
  if(!hasPopulationRoom(bldg.team,utype,true))return{ok:false,reason:'pop'};
  if(!canAfford(bldg.team,unitTrainCost(bldg.team,utype,bldg.queue)))return{ok:false,reason:'resources'};
  return{ok:true};
}

function queueUnit(bldg,utype){
  let check=canQueueUnit(bldg,utype);
  if(!check.ok)return check;
  spendCost(bldg.team,unitTrainCost(bldg.team,utype,bldg.queue)); // bldg.queue is the prior queue (before the push below)
  bldg.queue.push(utype);
  return check;
}

// Viewer-local convenience cache of MY team's population for the HUD —
// any per-team read (AI planning, UI compare) goes through
// teamPopUsed/teamPopCap directly with an explicit team.
function refreshPopulationCounts(){
  if(window.__headlessSim)return; // viewer-only HUD cache; sim reads teamPop* with an explicit team
  popUsed=teamPopUsed(myTeam);
  popCap=teamPopCap(myTeam);
}

// AoE2 drop-off rule: the TC accepts every resource, other buildings only
// the kinds listed in their BLDGS drop spec (mill: food, camps: their own).
// Per-btype drop sets built once — nearestDrop calls this per candidate
// building on every villager trip.
const _dropSets={};
function dropAccepts(b,resType){
  if(b.btype==='TC')return true;
  let ds=_dropSets[b.btype];
  if(ds===undefined){
    let spec=BLDGS[b.btype].drop;
    ds=_dropSets[b.btype]=spec?new Set(spec.split(',')):null;
  }
  return !!(ds&&ds.has(resType));
}

// THE nearest own/matching building to `e`, ranked by Euclidean footprint
// distance (distToTarget — matches the approach/arrival logic; Manhattan could
// pick a longer diagonal walk). `pred(b)` selects the candidates. id-ordered
// scan, strict `<` → deterministic first-wins tiebreak.
function nearestBuildingWhere(e,pred){
  let best=null,bd=Infinity;
  for(let i=0;i<entities.length;i++){
    let b=entities[i];
    if(b.type!=='building'||b.hp<=0||!pred(b))continue;
    let d=distToTarget(e,b);
    if(d<bd){bd=d;best=b;}
  }
  return best;
}
function nearestDrop(e,resType,excludeIds=null){
  return nearestBuildingWhere(e, b=> b.team===e.team && b.complete
    && !(excludeIds && excludeIds.includes(b.id)) && dropAccepts(b,resType));
}

function dist(a,b){let dx=a.x-b.x,dy=a.y-b.y;return Math.sqrt(dx*dx+dy*dy)}

// ---- PER-TICK SPATIAL INDEX (perf) ----
// Coarse grid over targetable units (non-sheep/carcass, alive, not
// garrisoned), rebuilt at most once per tick and shared by the proximity
// scans (auto-attack acquisition, sheep conversion, bear aggro). Entries are
// live references, so positions read at query time are current; hp/garrison
// are re-checked at query time so mid-tick deaths can't be targeted.
// ---- DETERMINISTIC RETRY / THROTTLE / AVOID PRIMITIVES ----
// e.retry = { [key]: {n, next} }   n = consecutive failures, next = earliest
//                                  tick the action may run again
// e.avoid = { [key]: [v1, v2, …] } small blacklist of failed destinations
// Plain JSON data on the entity: serializes into saves, clones into lockstep
// snapshots, and is hashed as a unit in detEntityHash — every "which tick
// does pathfinding/give-up fire" decision lives here, so a divergence trips
// the desync checksum at the source. NEVER touch e.retry/e.avoid directly:
// the helpers own the empty-object→undefined invariant that keeps the hash
// identical between "never retried" and "retried then cleared".

// ---- RETRY KEY REGISTRY ----
// Every retry/back-off key in the sim, in one place. The VALUES are frozen
// history: e.retry is hashed per sorted key string (js/determinism.js), so
// renaming a value is a checksum epoch — add new keys, never repurpose old
// strings.
//   CHASE          combat approach repath throttle          T30(15)
//   CHASE_BLOCKED  2-strike give-up -> resolveStalledAttack T30(15), maxN 2
//   HARVEST_WAIT   carcass-eating ring wait                 T30(15)
//   FLEE_RAID      AI villager raid flee + danger zone      T30(90)
//   FLEE_BEAR      mauled villager bear-hunt call-in        T30(90)
//   GUARD_RETURN   guard-post return repath / back-off      T30(30) / T30(600)
//   DROP_WAIT      all drop-off routes blocked patience     T30(30)
//   DROP_TUCK      cosmetic slide-to-wall deposit bound      T30(30)
//   GARRISON       crowded garrison entrance retry          T30(10), maxN 6
//   FOLLOW         follow/escort repath cadence             T30(12)
//   MOVE           multi-leg move repath cadence            T30(10)
//   BUILD          crowded build-site retry                 maxN 6
const RETRY = Object.freeze({
  CHASE:'chase', CHASE_BLOCKED:'chaseBlocked', HARVEST_WAIT:'harvestWait',
  FLEE_RAID:'fleeRaid', FLEE_BEAR:'fleeBear', GUARD_RETURN:'guardret',
  DROP_WAIT:'dropWait', DROP_TUCK:'dropTuck', GARRISON:'garrison', FOLLOW:'follow',
  MOVE:'move', BUILD:'build',
});

function retryReady(e,key){
  let r=e.retry&&e.retry[key];
  return !r||tick>=r.next;
}
// Stamp the throttle without counting a failure (pure repath cadence).
function retryStamp(e,key,waitTicks){
  let m=e.retry||(e.retry={});
  let r=m[key]||(m[key]={n:0,next:0});
  r.next=tick+waitTicks;
}
// Count a failure; true (and clear the key) once maxN failures accumulate —
// the caller gives up. maxN of 0/undefined means count forever.
function retryFail(e,key,waitTicks,maxN){
  let m=e.retry||(e.retry={});
  let r=m[key]||(m[key]={n:0,next:0});
  r.n++;r.next=tick+waitTicks;
  if(maxN&&r.n>=maxN){retryClear(e,key);return true;}
  return false;
}
function retryClear(e,key){
  if(e.retry&&e.retry[key]){delete e.retry[key];if(Object.keys(e.retry).length===0)e.retry=undefined;}
}
function retryActive(e,key){return !!(e.retry&&e.retry[key]);}
function avoidAdd(e,key,v){let m=e.avoid||(e.avoid={});(m[key]||(m[key]=[])).push(v);}
function avoidClear(e,key){
  if(e.avoid&&e.avoid[key]){delete e.avoid[key];if(Object.keys(e.avoid).length===0)e.avoid=undefined;}
}

const UNIT_GRID_CELL=4;
// Dual-keyed on tick AND simGen (see registerSimCache, js/core.js): entries
// are live entity references, so serving a pre-rollback grid after a restore
// hands out orphaned objects from the abandoned timeline.
// Flat pooled storage (perf): a dense Array of pooled per-cell arrays; cell
// arrays are cleared (length=0) via the touched-list, never reallocated.
// Consumers index grid[gx*unitGridNY+gy] and MUST bounds-check gx/gy (a flat
// index would alias a neighboring column).
let unitGridTick=-1, unitGridGen=-1;
let unitGridNX=0, unitGridNY=0, _ugCells=null, _ugTouched=[];
registerSimCache(()=>{unitGridTick=-1;});
function targetableUnitGrid(){
  if(unitGridTick===tick&&unitGridGen===simGen)return _ugCells;
  unitGridTick=tick;unitGridGen=simGen;
  let n=((MAP/UNIT_GRID_CELL)|0)+1;
  if(!_ugCells||unitGridNX!==n){
    unitGridNX=n; unitGridNY=n;
    _ugCells=new Array(n*n);
    _ugTouched=[];
  }
  for(let i=0;i<_ugTouched.length;i++)_ugTouched[i].length=0;
  _ugTouched.length=0;
  for(let i=0;i<entities.length;i++){
    let en=entities[i];
    if(en.type!=='unit'||en.hp<=0||en.garrisonedIn)continue;
    if(en.utype==='sheep'||en.utype==='sheep_carcass')continue;
    let k=((en.x/UNIT_GRID_CELL)|0)*unitGridNY+((en.y/UNIT_GRID_CELL)|0);
    let a=_ugCells[k];
    if(!a)_ugCells[k]=a=[];
    if(a.length===0)_ugTouched.push(a);
    a.push(en);
  }
  return _ugCells;
}
// Closest grid unit to `e` strictly within `range` that passes `pred`.
function closestUnitNear(e,range,pred){
  let grid=targetableUnitGrid();
  let c=UNIT_GRID_CELL;
  let cx=(e.x/c)|0, cy=(e.y/c)|0, cr=Math.ceil(range/c)+1;
  let closest=null, closestD=range;
  for(let gy=cy-cr;gy<=cy+cr;gy++){
    if(gy<0||gy>=unitGridNY)continue;
    for(let gx=cx-cr;gx<=cx+cr;gx++){
      if(gx<0||gx>=unitGridNX)continue;
      let a=grid[gx*unitGridNY+gy];
      if(!a||a.length===0)continue;
      for(let k=0;k<a.length;k++){
        let en=a[k];
        if(en===e||en.hp<=0||en.garrisonedIn)continue;
        if(!pred(en))continue;
        let d=dist(e,en);
        if(d<closestD){closestD=d;closest=en;}
      }
    }
  }
  return closest;
}

function distToTarget(a,b){
  if(b && b.type==='building'){
    // A w-wide building occupies tile centers [x .. x+w-1], so its
    // geometric footprint spans [x-0.5, x+w-0.5] — not [x, x+w].
    let dx=Math.max(b.x-0.5-a.x, 0, a.x-(b.x+b.w-0.5));
    let dy=Math.max(b.y-0.5-a.y, 0, a.y-(b.y+b.h-0.5));
    return Math.sqrt(dx*dx+dy*dy);
  }
  return dist(a,b);
}

function buildingAtTile(x,y,filter){
  // O(1) via the derived `occupied` tile index (stampBuildingFootprint,
  // js/entities.js — every footprint tile carries its id; death clears it).
  // Footprints can't overlap, so the building at a tile is unique; a stale
  // id (already-removed entity) reads as null.
  let t=map[y]&&map[y][x];
  let b=t&&t.occupied!=null?entitiesById.get(t.occupied):null;
  return (b&&b.type==='building'&&(!filter||filter(b)))?b:null;
}

function farmAtTile(x,y,team,requireComplete=true){
  return buildingAtTile(x,y,en=>
    en.btype==='FARM'&&en.team===team&&(!requireComplete||en.complete)
  );
}

// ---- VILLAGER SAFETY (the AI's three-layer model) ----
// LEARN: a villager HIT by a bear or an enemy player stamps a danger zone
//   (stampDangerZone below; the two branches live in damageEntity) and, when
//   caught in the field, flees home. One learning site per threat kind.
// POLICY: aiVillagerSafeAt — THE predicate for "may an AI villager work at
//   tile (x,y)": no live danger zone covers it, and under the war-state it
//   sits inside the town's defensive umbrella. Consulted by canGatherTile
//   (every gather scan + the per-tick current-tile revalidation) and by
//   findAIDropSite (camps are never founded on proven-deadly ground).
// REACT: the bell ladder (updateAIGarrisonReaction, js/ai.js) — militia /
//   shelter / lurker-gated all-clear — unchanged, for raids at the town.
// Humans manage their own safety: the predicate is a no-op for them.

// THE zone writer — prune + dedup + push + cap in one place.
// bearId null = raid zone (expires by time only); set = bear zone (also
// dies with its bear). Cap 7: the array is hashed per-zone in the AI digest.
function stampDangerZone(dzAi,x,y,bearId){
  dzAi.dangerZones=dzAi.dangerZones.filter(z=>{
    if(tick>=z.until)return false;
    if(z.bearId==null)return true;
    let b=entitiesById.get(z.bearId);
    return !!(b&&b.hp>0);
  });
  // Dedup: bear zones by bear id (one zone per bear); raid zones by the
  // Chebyshev-4 consume radius (a massacre refreshes ONE zone, not eight).
  if(bearId!=null){
    if(dzAi.dangerZones.some(z=>z.bearId===bearId))return;
    dzAi.dangerZones.push({x,y,until:tick+T30(6000),bearId});
  } else {
    let near=dzAi.dangerZones.find(z=>z.bearId==null&&Math.abs(z.x-x)<=4&&Math.abs(z.y-y)<=4);
    if(near){near.until=tick+T30(6000);return;}
    dzAi.dangerZones.push({x,y,until:tick+T30(6000)});
  }
  if(dzAi.dangerZones.length>7)dzAi.dangerZones=dzAi.dangerZones.slice(-7);
}

function aiVillagerSafeAt(team,x,y){
  let ai=AI_STATES&&AI_STATES[team];
  if(!ai)return true; // humans manage their own safety
  if(ai.dangerZones&&ai.dangerZones.length){
    for(let z of ai.dangerZones){
      if(tick>=z.until)continue;
      // A bear zone dies with its bear: a hunted bear frees the resource
      // patch immediately (this is what makes dispatching the hunt
      // worthwhile). Raid zones have no bearId and expire by time only —
      // the raider may be long gone; the ground is still proven deadly.
      if(z.bearId!=null){
        let bear=entitiesById.get(z.bearId);
        if(!bear||bear.hp<=0)continue;
      }
      // Radius 4: bigger zones locked out whole resource regions and starved
      // the team; small zones stop the immediate re-tasking loop.
      if(Math.abs(x-z.x)<=4&&Math.abs(y-z.y)<=4)return false;
    }
  }
  // WAR-STATE GATHER CONTRACTION (sn-minimum-town-size spirit): while the
  // base is taking core hits (aiRecentlyRaided), work only inside the TC's
  // alarm radius — field gatherers beyond the town's umbrella are
  // indefensible (raided AIs bled villagers at far camps). TC center is
  // memoized ONCE per team per tick (derived same-tick cache — never
  // carried, so never hashed; numbers only, AI_STATES is serialized;
  // !==tick self-heals across rollback) because this predicate is hot.
  if(typeof aiRecentlyRaided==='function'&&aiRecentlyRaided(ai)){
    if(ai._tcMemoTick!==tick){
      ai._tcMemoTick=tick;
      let tc=teamTC(team);
      if(tc){let c=centerOf(tc);ai._tcMemoX=c.x;ai._tcMemoY=c.y;}
      else ai._tcMemoTick=-1; // no TC (razed = knocked out anyway): no contraction
    }
    if(ai._tcMemoTick===tick){
      let R=AI_BASE_ALARM_RADIUS*aiScale(),dx=x-ai._tcMemoX,dy=y-ai._tcMemoY;
      if(dx*dx+dy*dy>R*R)return false;
    }
  }
  return true;
}

function canGatherTile(e,terrain,x,y){
  if(terrain===TERRAIN.FARM)return !!farmAtTile(x,y,e.team,true);
  // Farms bypass the safety predicate via the early-return above —
  // deliberately: farms sit at the TC and are the protected income.
  return aiVillagerSafeAt(e.team,x,y);
}

// AoE2 formation speed-matching: units ordered as a GROUP move at the
// slowest member's pace (groupSpeed, stamped by execUnitCommand and AI wave
// launches) so scouts don't sprint ahead and arrive alone. Combat releases
// the cap: once a unit's own target is close it fights at full speed.
function unitMoveSpeed(e){
  let sp=e.speed;
  // Garrisoned rams speed up (AoE2 DE): each rider adds 8% — a full ram
  // (4 riders) moves at ~0.66 instead of 0.5. Rams IGNORE groupSpeed: the
  // ram is the group's pace-setter (slowest raw speed), so a cap could only
  // ever hold it at/below its own speed — which nullified the rider boost
  // for the whole march (group orders stamp min RAW speed before boarding).
  if(e.utype==='ram'){
    if(e.garrison&&e.garrison.length)sp*=1+0.08*e.garrison.length;
    return sp;
  }
  if(e.groupSpeed&&e.groupSpeed<sp){
    if(e.target){
      let t=entitiesById.get(e.target);
      // Release on a DEAD/GONE target too — a dangling id would pin the
      // unit at group pace for the rest of its walk.
      if(!t||distToTarget(e,t)<10){e.groupSpeed=undefined;return sp;}
    }
    if(!e.target&&e.path.length===0&&!(e.order&&e.order.kind==='move')){e.groupSpeed=undefined;return sp;} // arrived
    return e.groupSpeed;
  }
  return sp;
}

// findPath() REDIRECTS unwalkable destinations to the nearest walkable
// tile within 20 — good for click-forgiveness, but it means "path.length>0"
// does NOT mean the destination is reachable. This asks: does a path exist
// that actually ENDS within `tol` of (tx,ty)? Every AI reachability probe
// must use this, or camps get founded in forest pockets no villager can
// ever enter.
function pathReaches(sx,sy,tx,ty,ignore,tol=1.5){
  if(Math.abs(sx-tx)<=tol&&Math.abs(sy-ty)<=tol)return true;
  let p=findPath(sx,sy,tx,ty,ignore);
  if(p.length===0)return false;
  let last=p[p.length-1];
  if(Math.abs(last.x-tx)<=tol&&Math.abs(last.y-ty)<=tol)return true;
  // Iteration-capped partial path: A* ran out of BUDGET, not out of map.
  // A long path that closed most of the gap is a truncated route — treat it
  // as reachable (else distant army re-targets yo-yo home forever). Short
  // queries (build/drop sites) always complete within budget, so the strict
  // end-adjacency test above still guards forest-pocket placements.
  let dEnd=Math.max(Math.abs(last.x-tx),Math.abs(last.y-ty));
  let dStart=Math.max(Math.abs(sx-tx),Math.abs(sy-ty));
  return p.length>=25&&dEnd<dStart*0.6;
}

// Distance from point to nearest tile of a building
function distToBuilding(px,py,bldg){
  let best=999;
  for(let dy=0;dy<bldg.h;dy++)for(let dx=0;dx<bldg.w;dx++){
    let d=Math.abs(bldg.x+dx+0.5-px)+Math.abs(bldg.y+dy+0.5-py);
    if(d<best)best=d;
  }
  return best;
}

// Euclidean distance from a point to a building's footprint RECT (0 inside).
// The one clamped-rect distance helper — used by the guard leash (anchor a
// building-guard to the whole structure, not one perimeter tile) and by
// adjToBuilding below.
function edgeDistToBuilding(px,py,bldg){
  let dx=Math.max(bldg.x-0.5-px, 0, px-(bldg.x+bldg.w-0.5));
  let dy=Math.max(bldg.y-0.5-py, 0, py-(bldg.y+bldg.h-0.5));
  return Math.sqrt(dx*dx+dy*dy);
}

// In contact = within `d` of a target footprint's nearest edge (clamped-rect
// distance, same as distToTarget). THE one adjacency test — a resource tile or
// unit is passed as {x,y,w:1,h:1}. Perimeter tile centres sit 0.5–0.71 from a
// footprint, so the default 1.2 accepts every true perimeter tile and rejects
// the next ring.
function inContact(px,py,t,d){
  return edgeDistToBuilding(px,py,t) <= d;
}
function adjToBuilding(px,py,bldg){
  return inContact(px,py,bldg,1.2);
}

// A guarding unit's "zone" = the thing its ORDER protects: {b: building}
// for guardBuilding (measured to the whole footprint), the escortee's LIVE
// position for escort, else the ground post point. guardZoneDist is the
// distance from a point to that zone. Shared by the leash and the aggro
// scope so they stay in lock-step on both the zone AND the radius.
const GUARD_LEASH = 6;
// Is this unit under a guard-family standing order? (GUARD_ORDER_KINDS —
// guard/guardBuilding/escort — lives in js/commands.js, same global scope.)
function guardOrderOf(e){
  return (e.order && GUARD_ORDER_KINDS.has(e.order.kind)) ? e.order : null;
}
// Where a guard-family order RETURNS to / leashes toward: the assigned post
// tile for guard/guardBuilding, the escortee's live position for escort
// (null while the escortee is unresolvable — conversion sweeps in
// handleDeath/enterGarrison normally rewrite the order first).
function guardOrderPost(e, o){
  if (o.kind === 'escort') {
    let t = entitiesById.get(o.id);
    return (t && t.hp > 0) ? { x: t.x, y: t.y } : null;
  }
  return { x: o.x, y: o.y };
}
// THE stance table — every per-stance number lives here, not inline at the
// read sites. scan: auto-acquire radius ('range' = the unit's own attack
// reach — Stand Ground fires at what walks in, never walks out); leashed:
// whether the idle anchor (defendX/Y) reels a chase back (GUARD_LEASH
// radius); acquires/retaliates: whether the unit ever engages on its own.
// Explicit orders and flagged guard posts override per their own rules
// (see enforceChaseLeash / the acquire scan).
const STANCES = {
  aggressive:  { scan: 8,       leashed: false, acquires: true,  retaliates: true  },
  defensive:   { scan: 6,       leashed: true,  acquires: true,  retaliates: true  },
  standground: { scan: 'range', leashed: false, acquires: true,  retaliates: true  }, // retaliation still reach-gated (canStrikeInPlace)
  passive:     { scan: 0,       leashed: false, acquires: false, retaliates: false },
};
function stanceOf(e){ return STANCES[e.stance] || STANCES.aggressive; }

// THE ONE "can this unit hit that foe WITHOUT MOVING" predicate. Ranged:
// within firing range (+0.5 slack, same as every other reach test).
// Melee: within strike distance (~1.5) AND not corner-blocked — a diagonal
// foe with both orthogonal steps unwalkable can't actually be swung at, and
// re-acquiring it just thrashes give-up→re-acquire until the watchdog fires.
// Used by the acquire scan, the retaliation gate, and the stand-ground
// reach test.
function canStrikeInPlace(e, foe){
  if((e.range||0)>0) return dist(e,foe) <= e.range+0.5;
  let ex=Math.round(e.x),ey=Math.round(e.y),dx=Math.round(foe.x)-ex,dy=Math.round(foe.y)-ey;
  let cornerBlocked=dx&&dy&&!walkable(ex+dx,ey,e.id,true)&&!walkable(ex,ey+dy,e.id,true);
  return dist(e,foe)<=1.5 && !cornerBlocked;
}

// Reel a leashed unit (guard post, or defensive stance's idle anchor) back
// home when a chase drags it past GUARD_LEASH — drops the target and paths
// to the post/anchor; returns true if it did. EXPLICIT attacks are exempt
// (the command anchors the unit where it stood when ordered, so a defensive
// army told to attack a distant target would otherwise get dragged home).
// Called from BOTH the combat block AND the movement phase: a chase toward
// a STATIONARY foe is one long path leg the combat block never sees
// mid-leg, so checking only there lets the unit march arbitrarily far.
function enforceChaseLeash(e){
  if(!e.target||e.explicitAttack)return false;
  let go=guardOrderOf(e);
  if(go){
    // Guard post: measured to the whole footprint for a building (a threat
    // at any side of a 4x4 TC is still "at post"), else to the post point
    // (ground post, or escorted unit synced onto guardX/Y).
    if(guardZoneDist(guardZoneOf(e), e.x, e.y) > GUARD_LEASH){
      e.target=null;
      clearUnitPath(e);
      let post=guardOrderPost(e, go);
      if(post) pathUnitTo(e, Math.round(post.x), Math.round(post.y));
      return true;
    }
  } else if(stanceOf(e).leashed&&e.defendX!==undefined){
    let adx=e.x-e.defendX, ady=e.y-e.defendY;
    if(Math.sqrt(adx*adx+ady*ady) > GUARD_LEASH){
      e.target=null;
      clearUnitPath(e);
      pathUnitTo(e, Math.round(e.defendX), Math.round(e.defendY));
      return true;
    }
  }
  return false;
}
// How close (distance from the building's nearest edge) a hauler tucks in
// before it deposits / trades — the slide-to-contact "touch" at a drop-off or
// Market. See dropContactSettled.
const DROP_CONTACT = 0.3;
// After an explicitly-ordered attack target dies, a human unit continues the
// assault onto the nearest reachable enemy building within this radius (see
// updateUnit's dead-target branch) — enough to raze the base the army breached
// into, small enough that it never marches across the map to a distant town.
const ASSAULT_MOP_UP = 20;
// How long a unit avoids re-acquiring an enemy UNIT it just proved it can't
// reach (a melee dogpile it can't slot into). Short, because a unit crowd
// disperses quickly — long enough to break the give-up→re-acquire thrash, brief
// enough to rejoin the fight once a slot opens. Buildings use a much longer
// window (they don't move; a wall stays walled off).
const UNREACH_UNIT_TICKS = T30(150);
// Ambient-behavior cadences (game-time meaningful — T30-wrapped):
const SHEEP_EAT_EVERY = T30(180);    // sheep pause to graze ~every 6 game-s
const SHEEP_WANDER_EVERY = T30(120); // sheep wander ~every 4 game-s
const BEAR_WANDER_EVERY = T30(150);  // bear den wander ~every 5 game-s
const AUTOSCOUT_REPICK_EVERY = T30(12); // player Auto Scout waypoint cadence
// Idle auto-acquire stagger: 4 => worst reaction 3 ticks = 150ms game-time at
// TPS=20 (T30(6)=4 agrees with the pre-migration 6-tick stagger's intent of
// staying under AoE2's 250ms command turns).
const ACQUIRE_STAGGER = T30(6);
function guardZoneOf(e){
  let o = guardOrderOf(e);
  if (!o) return null;
  if (o.kind === 'guardBuilding') {
    let gb = entitiesById.get(o.id);
    if (gb && gb.type === 'building' && gb.hp > 0) return { b: gb };
    return { x: o.x, y: o.y }; // building gone mid-tick — fall back to the assigned tile
  }
  return guardOrderPost(e, o) || { x: e.x, y: e.y };
}
function guardZoneDist(z, px, py){
  return z.b ? edgeDistToBuilding(px, py, z.b) : simHypot(px - z.x, py - z.y);
}

// Find nearest walkable tile adjacent to building perimeter. Optional
// `claimed` set (keys "x,y") lets a group of callers fan OUT around the
// footprint instead of all picking the one nearest tile — a claimed tile is
// only skipped while any unclaimed perimeter tile remains.
// True if any unit other than this site's own builders is standing on the
// footprint — gates construction start (AoE2: "can't build until everyone's
// out"). This site's builders hug the OUTSIDE edge (pressToContact keeps them
// off the footprint), so they never block themselves; any other unit — idle,
// passing through the still-walkable foundation, or enemy — pauses progress
// until it clears, so the tiles never harden under a unit. Round()-based, same
// tile convention as unitBlock/clearFootprintForBuild; includes movers
// (unitBlock omits them, and a unit crossing must still hold off the hardening).
function footprintOccupiedByOther(bt){
  for(let i=0;i<entities.length;i++){
    let u=entities[i];
    if(u.type!=='unit'||u.hp<=0||u.garrisonedIn)continue;
    if(u.buildTarget===bt.id)continue; // this site's builders stand at the edge
    let ux=Math.round(u.x), uy=Math.round(u.y);
    if(ux>=bt.x&&ux<bt.x+bt.w&&uy>=bt.y&&uy<bt.y+bt.h)return true;
  }
  return false;
}
// When a builder is ready but the footprint isn't clear, walk the NON-ENEMY
// units off it (AoE2: your own units — and neutral animals — scatter when you
// commit a foundation). ENEMY units are NOT shoved — you can't move their army,
// so they block the build until they leave or die. A gentle walk order, not a
// teleport; the unit keeps its task and paths back out over the still-walkable
// foundation. Only nudges STATIONARY units (movers are already clearing), so it
// never thrashes a path.
function clearFootprintForBuild(bt){
  for(let i=0;i<entities.length;i++){
    let u=entities[i];
    if(u.type!=='unit'||u.hp<=0||u.garrisonedIn)continue;
    if(isEnemyOf(bt.team,u)||u.buildTarget===bt.id||u.path.length>0)continue;
    let ux=Math.round(u.x), uy=Math.round(u.y);
    if(ux<bt.x||ux>=bt.x+bt.w||uy<bt.y||uy>=bt.y+bt.h)continue;
    let pt=nearestBldgPerimeter(u.x,u.y,bt,u.id);
    pathUnitTo(u,pt.x,pt.y);
  }
}
function nearestBldgPerimeter(px,py,bldg,ignore,claimed){
  let best=null,bd=999,bestAny=null,bdAny=999;
  for(let dy=-1;dy<=bldg.h;dy++)for(let dx=-1;dx<=bldg.w;dx++){
    if(dx>=0&&dx<bldg.w&&dy>=0&&dy<bldg.h)continue;
    let tx=bldg.x+dx, ty=bldg.y+dy;
    if(tx>=0&&tx<MAP&&ty>=0&&ty<MAP&&walkable(tx,ty,ignore)){
      let d=Math.abs(px-tx)+Math.abs(py-ty);
      if(d<bdAny){bdAny=d;bestAny={x:tx,y:ty};}
      if(claimed && claimed.has(tx+','+ty))continue;
      if(d<bd){bd=d;best={x:tx,y:ty};}
    }
  }
  return best||bestAny||{x:Math.min(bldg.x+bldg.w,MAP-1),y:Math.min(bldg.y+bldg.h,MAP-1)};
}

// (siege surround is now goalBldg + contactClaims — a melee attacker paths to
// the cheapest UNCLAIMED contact tile, so the group fans out automatically.)

// ---- Shared attack-pathing helpers — used by BOTH the AI (js/ai.js) and
// player units in updateUnit. ----

// Ticks for `unit` to walk to `target` building's perimeter (0 = already
// adjacent), or -1 if no path exists. Iteration-capped searches return a
// partial path, so very long detours can be underestimated — fine for the
// detour-vs-breach heuristic this feeds.
function ticksToReachBuilding(unit, target){
  if (adjToBuilding(unit.x, unit.y, target)) return 0;
  // goalBldg only ever ends at a real contact tile (reachable by construction),
  // so an empty path is a genuine "walled off" — no redirect-to-nowhere check.
  let path = findPath(Math.round(unit.x), Math.round(unit.y), target.x, target.y, unit.id, 0, target);
  if (path.length === 0) return -1;
  return path.length / ((UNITS[unit.utype].speed || 1) / TPS);
}
// Can this unit actually reach (path adjacent to) the given target? Priority-
// based / explicit target selection doesn't know about walls in the way, so
// this catches a walled-off pick before committing to it.
function isTargetReachable(unit, target){
  if (target.type !== 'building') return true;
  return ticksToReachBuilding(unit, target) >= 0;
}
// Expected ticks for THIS unit to smash through a wall-like building — mirrors
// damageEntity's math (building-class bonuses, pierce vs melee armor, the
// max(1,...) floor) so the estimate matches what combat actually does. Uses
// CURRENT hp, so an already-damaged segment scores better and the army
// converges on one breach point (AoE2 clumping).
function wallBreachTicks(unit, w){
  let dmg = unit.atk || 0;
  if (unit.utype === 'villager') dmg += 3;
  if (unit.utype === 'militia') dmg += 2;
  if (unit.utype === 'ram') dmg += 110; // mirrors damageEntity's building bonus
  let armor = BLDGS[w.btype].armor || {m:0,p:0};
  dmg = Math.max(1, dmg - (((unit.range || 0) > 0) ? armor.p : armor.m));
  return Math.ceil(w.hp / dmg) * (UNITS[unit.utype].rof || 60);
}
// Cheapest-to-breach enemy wall/tower/gate that `unit` can actually path to,
// scored by breach time + march time (material-aware like AoE2: a militia eats
// a palisade but loses to a stone wall even a fair march away). Probes only the
// nearest 6 (one connected fortification — if none of those is reachable the
// rest of the ring isn't either), skipping the just-stalled segment and any
// recently-given-up wall so a crowded breach spreads to a neighbour.
function nearestReachableWallLike(unit, team, excludeId){
  let marchTicks = w => dist(unit, w) / ((UNITS[unit.utype].speed || 1) / TPS);
  return entities.filter(en => en.type === 'building' && sameSide(en.team, team) && en.hp > 0 &&
      (isWallBtype(en.btype) || en.btype === 'TOWER' || isGateBtype(en.btype)))
    .sort((a, b) => dist(unit, a) - dist(unit, b) || a.id - b.id) // deterministic tiebreak
    .slice(0, 6)
    .map(w => ({ w, score: wallBreachTicks(unit, w) + marchTicks(w) }))
    .sort((a, b) => a.score - b.score || a.w.id - b.w.id) // deterministic tiebreak
    .map(s => s.w)
    .find(w => w.id!==excludeId && !(unit.unreachId===w.id && unit.unreachUntil>tick) && isTargetReachable(unit, w)) || null;
}

// Is this unit completely boxed in by OTHER units (its own not-yet-moving
// crowd), with terrain open somewhere it can't reach? True only when every
// neighbour tile that is terrain-walkable currently holds a unit AND there is
// no unit-free step at all. This is the interior of a freshly-commanded army
// block: findPath returns [] not because the target is walled off but because
// the unit's teammates surround it — a transient jam that clears as the outer
// ranks march away. Callers use it to keep re-pathing (like a move order)
// instead of giving up (else interior units strand at the spawn). O(8),
// deterministic (walkable is pure over the sim grid).
function crowdedByUnits(u){
  let ux=Math.round(u.x), uy=Math.round(u.y), terrainOpen=false;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;
    let nx=ux+dx, ny=uy+dy;
    if(walkable(nx,ny,u.id,false)) return false;      // a real step exists — not boxed
    if(walkable(nx,ny,u.id,true)) terrainOpen=true;   // blocked only by a unit
  }
  return terrainOpen;
}

// ============================ CHASE CONTROLLER ============================
// THE single owner of "this fighting unit cannot make progress". The full
// escalation ladder, each stage tuned to fire BEFORE the stuck-watchdog's
// T30(240) so units self-correct instead of freezing until forcibly freed:
//
//   1. 'chase' retry (T30(15))      — repath throttle while a chase is live
//   2. chaseProg (CHASE_STALL_TICKS T30(90)) — "has a path but zero progress"
//      detector inside combatApproach; reset on real progress only
//   3. 'chaseBlocked' 2-strike      — two stalled/empty-path rounds hand off
//      to resolveStalledAttack (redirect to a breachable wall / disengage /
//      drop + unreach stamp)
//   4. unreachId/unreachUntil       — the memory that stops instant
//      re-acquire/retaliation thrash; readers: combatApproach human back-off,
//      the acquire scan + retaliation gate (both via canStrikeInPlace),
//      nearestReachableWallLike's exclusion
//   5. stuck-watchdog (updateStuckWatchdog) — last-resort net, unchanged
//
// State contract (lockstep): chaseProg{id,d,hp,since} — since+id hashed,
// d/hp deliberately derived-only; unreachId/Until hashed; retry entries
// hashed generically. Field names and stamp ticks are frozen — see
// detEntityHash (js/determinism.js).
// Shared approach-with-patience: pathing can fail TRANSIENTLY when the
// spot around a target is collision-crowded (full melee ring, busy drop
// site) — retry on a cooldown, hold position while near, and only give up
// when far away with genuinely no route (walled).
// Returns false if the caller should stop processing this tick.
// How long a unit may hold a target-with-a-path yet make ZERO real progress
// (no closing, no damage dealt) before we call it a deadlock. Well under the
// stuck-watchdog's 240 so the unit self-corrects (redirect/retarget/drop)
// rather than freezing until the watchdog forcibly frees it.
const CHASE_STALL_TICKS = T30(90);
function combatApproach(u,tgt,dist,pathFn,stopDist){
  // Known-unreachable back-off — HUMANS only. Humans KEEP an explicit target
  // (so target===unreachId persists), and without this a player army ordered
  // onto a sealed-off target re-runs a full-map findPath every 15 ticks — a
  // pathfinding storm that tanks the tick rate. The AI DROPS such targets
  // (resolveStalledAttack), so it never has target===unreachId here and this
  // is a no-op for it (keeps AI byte-identical); gating avoids idling the AI
  // if its planner re-assigns a remembered-unreach target. Expires so a
  // breach re-engages.
  if(isHumanTeam(u.team) && u.unreachUntil>tick && u.unreachId===tgt.id){ clearUnitPath(u); return false; }
  // The 15-tick repath cooldown throttles re-pathing while a chase is in
  // motion. Repath immediately whenever there's no path left (else the unit
  // freezes until the cooldown clears — a stutter).
  if(u.path.length>0 && !retryReady(u,RETRY.CHASE)) return false; // waiting for a slot
  retryStamp(u,RETRY.CHASE,T30(15));
  // Default approach paths to the nearest reachable tile WITHIN the unit's
  // attack range (stopDist), not onto the target's tile — see findPath. This
  // is the general anti-dogpile: every attacker (melee or ranged) stops at
  // its own range and distinct approach directions distribute them, so they
  // never converge on one tile. This branch is only entered when the unit is
  // OUT of range (callers gate on d>range), so an empty path here always
  // means "can't reach a firing tile", never "already arrived".
  if(pathFn)pathFn();
  else setUnitPath(u,findPath(Math.round(u.x),Math.round(u.y),Math.round(tgt.x),Math.round(tgt.y),u.id,stopDist||0));
  if(u.path.length>0){
    // "Has a path" is NOT "advancing": findPath ignores MOVING units, so a
    // unit can hold a valid path it can't walk (breach-point crowd), and a
    // budget-capped PARTIAL path can lead to a frontier it never passes.
    // Trust the path only while there is REAL progress: distance falling OR
    // the target losing hp (a long march still closes distance; a second-
    // rank melee still sees the front rank's damage land). A sustained
    // no-progress window is a deadlock — fall through to the empty-path
    // give-up.
    let pr=u.chaseProg;
    if(!pr || pr.id!==tgt.id || dist < pr.d-0.25 || tgt.hp < pr.hp){
      u.chaseProg={id:tgt.id, d:dist, hp:tgt.hp, since:tick};
      retryClear(u,RETRY.CHASE_BLOCKED);
      return true;
    }
    if(tick - pr.since < CHASE_STALL_TICKS){
      retryClear(u,RETRY.CHASE_BLOCKED);
      return true;
    }
    // Stalled: a path exists but neither distance nor target-hp has moved for
    // the whole window. Treat it exactly like an empty path (fall through) —
    // but DON'T reset chaseProg here, or the next call re-enters the progress
    // branch and the 2-strike give-up never accumulates.
  }
  // EMPTY path (or a stalled non-empty one): findPath returns [] only after
  // fully exploring the reachable region, and moving units don't block
  // pathing — so this is a real wall/trap/deadlock, not a one-tick jam. Give
  // up (a 2-strike tolerance absorbs a transient) and hand off to the shared
  // resolver (breach the wall in the way / back off).
  // A unit walled in by its OWN not-yet-moving crowd hasn't hit a real dead
  // end — keep re-pathing every tick like a move order until a neighbour
  // frees up. Checked before retryFail so the transient jam never counts
  // toward the 2-strike deadline.
  if(crowdedByUnits(u)) return false;
  // Only PLAYER units (AI or human) resolve a stall — gaia (wildlife) keeps
  // the no-op so bears/sheep are unaffected.
  if(retryFail(u,RETRY.CHASE_BLOCKED,T30(15),2) && isPlayerTeam(u.team)) resolveStalledAttack(u, tgt);
  return false;
}

// A melee attacker's chase to `tgt` has STALLED (it can't path adjacent). One
// shared response for AI and player units (AoE2: get as close as possible, then
// attack what's blocking you): redirect to the nearest reachable connected
// enemy wall/gate/tower to breach TOWARD the target; if there's none, back off.
// The no-wall fallback is the only AI/human split — an AI DROPS the impossible
// target (its planner re-picks) while a human KEEPS the explicit order — but
// BOTH record the target unreachable (unreachId/unreachUntil) so combatApproach
// stops re-pathing it every tick (the pathfinding storm on a sealed-off target).
// Humans only redirect for BUILDING targets (attacking the wall in the way
// fulfils "attack this building"); a unit-chase is never hijacked onto a wall.
// Scouts never breach (recon; controlAIScouts strips their building targets).
// THE one unreach stamp — every writer goes through here so the ladder's
// stage-4 memory is set uniformly (readers listed in the section header).
function stampUnreachable(e, id, ticks){
  e.unreachId = id;
  e.unreachUntil = tick + ticks;
}

function resolveStalledAttack(u, tgt){
  let stalledId = tgt.id;
  let disengage = null; // set below; walked after the shared cleanup
  let mayRedirect = isAITeam(u.team) || tgt.type === 'building';
  let w = (mayRedirect && u.utype !== 'scout') ? nearestReachableWallLike(u, tgt.team, stalledId) : null;
  if (w && w.id !== stalledId && !sameSide(w.team, u.team)) {
    u.target = w.id; u.explicitAttack = true;
  } else if (isAITeam(u.team)) {
    if (window.__dropStats) window.__dropStats.unreachable = (window.__dropStats.unreachable || 0) + 1;
    u.target = null; u.explicitAttack = false;
    // A walled-off building stays unreachable a long time; a mobile UNIT's
    // blockage (a melee dogpile) clears fast, so re-check it sooner.
    stampUnreachable(u, stalledId, tgt.type === 'building' ? T30(900) : UNREACH_UNIT_TICKS);
  } else {
    // Human-team unit that acquired this target ITSELF (retaliation /
    // auto-acquire) and can't reach it: if the unreachable foe is RANGED and
    // we're parked inside its fire, DISENGAGE — step out of its range instead
    // of soaking arrows (retaliation would otherwise re-lock the target on
    // every arrow and hold the unit in place until dead). An EXPLICIT attack
    // keeps the player's order (they can micro); an unreachable MELEE foe
    // can't hurt us from where it is, so wait-in-place stays for ordinary
    // crowded-fight stalls.
    let tr = tgt.type === 'unit' ? (UNITS[tgt.utype].range || 0) : 0;
    if (!u.explicitAttack && tr > 0 && dist(u, tgt) <= tr + 1) {
      u.target = null;
      let ux = u.x - tgt.x, uy = u.y - tgt.y, len = Math.sqrt(ux*ux + uy*uy) || 1;
      let out = tr + 2; // first tile safely beyond the shooter's reach
      disengage = { x: Math.round(tgt.x + ux/len*out), y: Math.round(tgt.y + uy/len*out) };
    }
    stampUnreachable(u, stalledId, tgt.type === 'building' ? T30(300) : UNREACH_UNIT_TICKS);
  }
  retryClear(u,RETRY.CHASE_BLOCKED); clearUnitPath(u); u.chaseProg = undefined;
  // Issued AFTER the shared cleanup — clearUnitPath above would wipe it.
  if (disengage) pathUnitTo(u, disengage.x, disengage.y);
}

// Deterministic "press to contact": once a unit has SETTLED (path empty) in
// attack/harvest range, nudge it one small step (<=0.08) toward (cx,cy) but
// never inside contactDist. Pathfinding only ever drops a unit on the adjacent
// integer TILE (~1.4 out); this closes that gap so attackers/gatherers pack
// tight against the target, and separateUnits (js/loop.js) spreads co-pressers
// into a ring. sqrt + division + arithmetic only (all IEEE-exact) — safe under
// the lockstep checksum; no trig, no PRNG. The walkable(ignoreUnits=true) guard
// means we never press into terrain/walls but DO press over other units
// (separation resolves the overlap). contactDist>=minDist(0.5, separateUnits)
// so a mobile unit target is never itself shoved out of its own surround.
function pressToContact(e, cx, cy, contactDist){
  if(e.path.length!==0)return;               // only when settled
  let dx=cx-e.x, dy=cy-e.y;
  let d=Math.sqrt(dx*dx+dy*dy);
  // Deadband LARGER than separateUnits' 0.08 nudge: a shoved unit must
  // settle where it lands, or press and separation alternate forever —
  // the whole crowd vibrates around one target (user caught it).
  if(d<=contactDist+0.2)return;              // deadband — already in the ring
  // Move at the unit's WALK rate (tiles/tick), NOT a fixed jump. The path
  // follower advances unitMoveSpeed/TPS tiles/tick — match it so the unit
  // strolls into contact instead of snapping.
  let walkStep = unitMoveSpeed(e)/TPS;
  let step=Math.min(walkStep, d-contactDist);
  let nx=e.x+dx*(step/d), ny=e.y+dy*(step/d);
  if(walkable(Math.round(nx),Math.round(ny),e.id,true)){
    e.x=nx; e.y=ny;
    e.pressWalk=tick;   // signal the renderer to show the walk cycle (js/render-units.js)
  }
}

// THE slide-to-contact against a TARGET FOOTPRINT: press toward the nearest
// point on the target's OWN edge box (clamped, NOT the centre — centre-pressing
// pulls diagonal approachers onto the orthogonal tiles). A resource tile / unit
// is passed as {x,y,w:1,h:1}. Returns true if it slid this tick (still closing),
// false once it can get no closer (deadband / blocked → settled). Fire-and-
// forget callers (build/gather) ignore the return; a hauler reads it to know the
// tuck is done and the hand-over may happen.
function slideToContact(e,t,d){
  let hx=Math.max(t.x-0.5, Math.min(e.x, t.x+t.w-0.5));
  let hy=Math.max(t.y-0.5, Math.min(e.y, t.y+t.h-0.5));
  let px=e.x, py=e.y;
  pressToContact(e,hx,hy,d);
  return e.x!==px || e.y!==py;
}
// Deposit/trade "touch": tucked in (settled) once slideToContact can get no
// closer — the caller finishes the transaction now.
function dropContactSettled(e, b){ return !slideToContact(e, b, DROP_CONTACT); }

// Contact tiles other units engaging the SAME target already hold or are heading
// to — the `claim` Set for goalBldg (pathToContact), so a crowd fans OUT around
// the target instead of converging on the single cheapest tile. THE one
// distribution mechanism (replaces siegePerimeterSpot + pickGatherStand's claim
// encodings). Derived from live state, no stored spot: a mover claims its path
// DESTINATION, a settled unit its current tile. id-ordered scan → deterministic.
function contactClaims(e, pred){
  let claim=new Set();
  for(let i=0;i<entities.length;i++){
    let p=entities[i];
    if(p===e||p.type!=='unit'||p.hp<=0||p.garrisonedIn||!pred(p))continue;
    let tx,ty;
    if(p.path&&p.path.length){let g=p.path[p.path.length-1];tx=g.x;ty=g.y;}
    else{tx=Math.round(p.x);ty=Math.round(p.y);}
    claim.add(ty*MAP+tx);
  }
  return claim;
}

// Can `e` reach `bldg` to interact — already adjacent, on a farm plot, or a
// path exists? Agrees with pathToBuilding/goalBldg on which tiles count (the
// reachability probe that gates AI build/target assignment).
function canReachBuilding(e,bldg){
  let sx=Math.round(e.x), sy=Math.round(e.y);
  if(bldg.btype==='FARM') return pathReaches(sx,sy,bldg.x,bldg.y,e.id);
  return adjToBuilding(e.x,e.y,bldg) || findPath(sx,sy,bldg.x,bldg.y,e.id,0,bldg).length>0;
}

// AoE2 DE-style group spread: when several villagers are tasked onto one
// resource tile, each claims its own tile of the same resource near the
// click instead of the whole group piling onto one tree. Rings expand from
// the clicked tile; within a ring the villager takes the tile closest to
// itself. If everything nearby is claimed, crowding the clicked tile is the
// correct fallback (AoE2 also lets villagers share a tile when it's all
// that's left).
function claimGatherTileNear(e,terrain,cx,cy){
  // How many teammates already target each resource tile (COUNT, not just a
  // set) — so once every tile has a claimant we can still balance the rest.
  let counts={};
  entities.forEach(en=>{
    if(en.type==='unit'&&en.id!==e.id&&en.team===e.team&&en.gatherX>=0)
      counts[en.gatherX+','+en.gatherY]=(counts[en.gatherX+','+en.gatherY]||0)+1;
  });
  // Pass 1: nearest UNCLAIMED tile of this resource, rings out from the click —
  // a group first fans onto distinct tiles (one villager each).
  if(!counts[cx+','+cy])return{x:cx,y:cy};
  for(let r=1;r<=5;r++){
    let best=null,bd=1e9;
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue; // ring only
      let nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=MAP||ny<0||ny>=MAP)continue;
      let t=map[ny][nx];
      if(t.t!==terrain||t.res<=0)continue;
      if(counts[nx+','+ny])continue;
      if(!canGatherTile(e,terrain,nx,ny))continue;
      let d=Math.abs(e.x-nx)+Math.abs(e.y-ny);
      if(d<bd){bd=d;best={x:nx,y:ny};}
    }
    if(best)return best;
  }
  // Pass 2: every nearby tile of this resource is already claimed — SPREAD
  // evenly rather than piling the overflow onto the clicked tile: take the
  // resource tile with the FEWEST claimants (nearest as tiebreak). So e.g. 6
  // villagers sent to two gold tiles settle 3 and 3, not 5 and 1. Integer
  // math + fixed iteration order → deterministic.
  let best=null,bestScore=Infinity;
  for(let r=0;r<=5;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      let nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=MAP||ny<0||ny>=MAP)continue;
      let t=map[ny][nx];
      if(t.t!==terrain||t.res<=0)continue;
      if(!canGatherTile(e,terrain,nx,ny))continue;
      let score=(counts[nx+','+ny]||0)*10000 + (Math.abs(e.x-nx)+Math.abs(e.y-ny));
      if(score<bestScore){bestScore=score;best={x:nx,y:ny};}
    }
  }
  return best||{x:cx,y:cy};
}

// (gatherer stand distribution is now goalBldg + contactClaims — pathToContact
// on the 1×1 node with a claim Set of co-gatherers' tiles rings the node evenly.)

function clearGatherTarget(e){
  e.gatherX=-1;
  e.gatherY=-1;
  avoidClear(e,'gather');
}

function rememberedGatherTile(e,terrain){
  if(e.gatherX<0)return null;
  let tile=map[e.gatherY]&&map[e.gatherY][e.gatherX];
  if(tile&&tile.t===terrain&&tile.res>0&&canGatherTile(e,terrain,e.gatherX,e.gatherY))return{x:e.gatherX,y:e.gatherY};
  return null;
}

// Bring an exhausted farm back to life once a reseed has been paid for, and
// put the farmer `e` straight back on it. Shared verbatim by the prepaid and
// AI-wood reseed branches in updateUnit's build handler (they differ only in
// where the payment comes from).
function reseedFarmForFarmer(bt, e){
  bt.exhausted = false;
  bt.complete = true;               // exhaustion had flagged it incomplete;
  bt.buildProgress = bt.buildTime;  // without this, canGatherTile rejects the
  bt.hp = bt.maxHp;                 // farm and the farmer silently goes idle
  let tile = map[bt.y][bt.x];
  tile.t = TERRAIN.FARM;
  tile.res = farmFoodFor(bt.team);
  markMapDirty(bt.x, bt.y);
  e.task = 'farm';
  e.gatherX = bt.x;
  e.gatherY = bt.y;
  e.buildTarget = null;
}

function depleteGatherTile(pos,config,gatherer){
  let tile=map[pos.y][pos.x];
  markMapDirty(pos.x,pos.y); // every branch below mutates this same tile
  if(config.removeFarm){
    let farm=entities.find(f=>f.type==='building'&&f.btype==='FARM'&&f.x===pos.x&&f.y===pos.y);
    if(farm){
      let store = resourceStore(farm.team);
      if (store && store.prepaidFarms > 0) {
        store.prepaidFarms--;
        tile.res = farmFoodFor(farm.team);
        farm.hp = farm.maxHp;
        feedbackFor(farm.team, () => showMsg("Farm auto-reseeded! (Prepaid remaining: " + store.prepaidFarms + ")"));
        return;
      } else {
        farm.exhausted = true;
        farm.complete = false;
        farm.buildProgress = 0;
        tile.res = 0;
        // AoE2-style audio cue: this farm ran dry and needs a reseed (or the
        // farmer will idle). feedbackFor gates it to the owning human and stays
        // silent during rollback resim; non-positional so it alerts wherever
        // the view is. Rate-limited in playSound, so a wave of exhaustions on
        // the same tick collapses to one chime.
        feedbackFor(farm.team, () => window.playSound && window.playSound('farm_exhausted'));
        // Farmer continuity: hand the CURRENT farmer straight to the
        // reseed-on-approach machinery (it's already standing on the farm)
        // instead of letting it idle — that path handles prepaid → wood →
        // idle-with-message and flips back to task='farm' on success.
        if (gatherer && gatherer.utype === 'villager') {
          gatherer.task = 'build';
          gatherer.buildTarget = farm.id;
          gatherer.target = null;
        }
        return;
      }
    }
  }
  tile.t=TERRAIN.GRASS;
  if(config.clearOccupied)tile.occupied=null;
}

function updateGatherTask(e,config){
  let gatherTile = rememberedGatherTile(e, config.terrain);
  if(!gatherTile){
    gatherTile = findNearTile(e, config.terrain);
  }

  if(!gatherTile){
    // Farmers keep the farm economy running by themselves: with no ACTIVE
    // farm left to work, head to the nearest exhausted own farm and reseed
    // it (the walk-up path pays prepaid first, then wood) — but only when
    // the reseed is actually payable, otherwise the trip ends in an idle
    // anyway. Deterministic pick: nearest, then lowest id.
    if(e.task==='farm'){
      let store=resourceStore(e.team);
      // "Payable" must match who can PAY here without a deliberate order:
      // prepaid credit works for everyone, but auto-wandering to reseed with
      // raw wood is AI-only — a human's wood is spent only on an EXPLICIT send
      // (updateVillagerBuild) or via the Mill's prepay queue, never silently.
      // Without the isAITeam gate a human farmer with wood but no prepaid
      // ping-pongs build↔farm at the exhausted plot forever.
      if(store&&((store.prepaidFarms||0)>0||(isAITeam(e.team)&&store.wood>=60))){
        let ex=null,best=Infinity;
        entities.forEach(en=>{
          if(en.type!=='building'||en.btype!=='FARM'||en.team!==e.team||!en.exhausted)return;
          let d=dist(e,en);
          if(d<best||(d===best&&ex&&en.id<ex.id)){best=d;ex=en;}
        });
        if(ex){
          e.task='build';
          e.buildTarget=ex.id;
          clearGatherTarget(e);
          return;
        }
      }
    }
    clearGatherTarget(e);
    // Deposit whatever is already carried instead of idling with a partial
    // load in hand; with nothing carried, just go idle.
    e.prevTask=null;
    e.task = e.carrying>0 ? 'return' : null;
    return;
  }

  e.gatherX=gatherTile.x;
  e.gatherY=gatherTile.y;
  let isAdj = Math.abs(Math.round(e.x) - gatherTile.x) <= 1 && Math.abs(Math.round(e.y) - gatherTile.y) <= 1;
  if(!isAdj){
    if(e.path.length === 0){
      // Farmer stands ON the plot; every other gatherer approaches the solid
      // node's cheapest UNCLAIMED contact tile (goalBldg + contactClaims), so
      // co-gatherers of the same node fan out and surround it.
      if(e.task==='farm') pathUnitTo(e, gatherTile.x, gatherTile.y);
      else pathToContact(e, {x:gatherTile.x, y:gatherTile.y, w:1, h:1}, contactClaims(e, p=>p.gatherX===gatherTile.x && p.gatherY===gatherTile.y));
      if(e.path.length===0){
        avoidAdd(e,'gather',gatherTile.x + gatherTile.y * MAP);

        let foundPath = false;
        while (true) {
          let nextTile = findNearTile(e, config.terrain, e.avoid&&e.avoid.gather);
          if (!nextTile) break;

          e.gatherX = nextTile.x;
          e.gatherY = nextTile.y;
          pathUnitTo(e, nextTile.x, nextTile.y);
          if (e.path.length > 0) {
            foundPath = true;
            break;
          }
          avoidAdd(e,'gather',nextTile.x + nextTile.y * MAP);
        }

        if (foundPath) return;

        clearGatherTarget(e);
        e.prevTask=null;
        e.task = e.carrying>0 ? 'return' : null;
        feedbackFor(e.team, () => showMsg('Resource is unreachable!'));
      }
    }
    return;
  }

  // In range. Slide-to-contact so the villager visibly HUGS the node — press
  // toward the nearest point on the node's OWN EDGE (position clamped to the
  // tile's footprint box), NOT the centre: centre-pressing pulls diagonal
  // gatherers onto the 4 orthogonal tiles and wrecks the even 8-tile surround
  // (goalBldg + contactClaims). The walkable(ignoreUnits) guard in pressToContact keeps
  // them off the solid node. Farms are walkable (the villager stands ON the
  // plot) — no press there.
  if(e.task!=='farm') slideToContact(e, {x:gatherTile.x, y:gatherTile.y, w:1, h:1}, 0.25);

  if(e.gatherCooldown>0)return;
  let tile=map[gatherTile.y][gatherTile.x];
  // Guard against two villagers depleting the same tile in the same tick
  if(tile.res<=0){
    depleteGatherTile(gatherTile,config,e);
    clearGatherTarget(e);
    return;
  }
  if(e.carryType && e.carryType !== config.resource){
    e.carrying = 0;
  }
  tile.res--;
  markMapDirty(gatherTile.x,gatherTile.y);
  e.carrying++;
  e.carryType=config.resource;
  if(config.resource==='food') e.foodSrc = e.task==='farm' ? 'wheat' : 'berries';
  // Eco cards (Double-Bit Axe / Bow Saw / Gold Mining) shorten the cycle.
  e.gatherCooldown=gatherCooldownFor(e.team,config.resource,config.cooldown);

  // Gathering audio: forage/farm only — no tool-swing animation, so
  // extraction time is the natural cadence. Chop/mine sounds fire on the
  // axe/pick's VISUAL impact in render-units.js (drawUnit).
  if (window.playSound && (e.task === 'forage' || e.task === 'farm')
      && (GAME_SPEED < 4 || e.carrying % 2 === 0)) { // every other cycle at 4x — keeps the 2x cadence
    window.playSound('forage', gatherTile.x + 0.5, gatherTile.y + 0.5);
  }
  // Spawn gathering particles
  let pColor = '#4a8c2a';
  if (e.task === 'chop') pColor = '#8b5a2b';
  else if (e.task === 'mine_gold') pColor = '#ffd700';
  else if (e.task === 'mine_stone') pColor = '#888';
  spawnParticles(gatherTile.x + 0.5, gatherTile.y + 0.5, pColor, 2, 0.02, 1.2);

  if(tile.res<=0){
    depleteGatherTile(gatherTile,config,e);
    clearGatherTarget(e);
  }
}

function checkNextBuild(e){
  e.buildQueue = e.buildQueue || [];
  // Honor buildBackoffUntil here too (as neededAIBuildingWork does): a site this
  // builder just gave up on as UNREACHABLE must not be re-picked the same tick,
  // or give-up → re-pick loops forever on a sealed foundation. The stamp
  // expires, so a transient block heals.
  let backedOff = bt => bt.buildBackoffUntil > tick;
  let unfinishedInQueue = e.buildQueue
    .map(id => entitiesById.get(id))
    .filter(bt => bt && (!bt.complete || bt.hp < bt.maxHp) && !backedOff(bt));

  if (unfinishedInQueue.length === 0) {
    // Look for any unfinished allied foundations nearby (within 25 tiles)
    let unfinished = entities.filter(en => en.type === 'building' && en.team === e.team && !en.complete && !backedOff(en));
    if (unfinished.length > 0) {
      unfinished.sort((a, b) => dist(e, a) - dist(e, b) || a.id - b.id); // deterministic tiebreak
      if (dist(e, unfinished[0]) <= 25) {
        unfinishedInQueue.push(unfinished[0]);
      }
    }
  }

  if (unfinishedInQueue.length > 0) {
    // Nearest first, but pick the nearest one this builder can ACTUALLY
    // REACH: a foundation can be near in straight-line distance yet sealed
    // off (wrong side of a closing wall ring) — assigning it anyway churns
    // walk/fail/reassign until the stuck-watchdog fires.
    unfinishedInQueue.sort((a, b) => dist(e, a) - dist(e, b) || a.id - b.id); // deterministic tiebreak
    let bt = unfinishedInQueue.find(cand => canReachBuilding(e, cand));
    if (bt) {
      e.buildQueue = unfinishedInQueue.map(b => b.id);
      e.task = 'build';
      e.buildTarget = bt.id;
      e.target = null;
      pathToBuilding(e, bt);
      return true;
    }
  }

  e.buildQueue = [];
  return false;
}

// Site blocked (footprint occupied, can't start): don't idle — rotate to another
// reachable, currently-UNBLOCKED unbuilt building and circle back later. The
// blocked site stays in the queue (added if missing), so once it clears the
// normal checkNextBuild sweep returns to it. Non-destructive: if nothing else
// is workable, leaves the builder on its current target to wait. Candidates are
// the queue plus nearby (≤25) allied foundations, same reach test as
// checkNextBuild; deterministic id tiebreak.
function tryBuildElsewhere(e, blockedId){
  let seen = new Set(), cands = [];
  for (let id of (e.buildQueue || [])) { let b = entitiesById.get(id);
    if (b && b.type === 'building' && !b.complete && !seen.has(id)) { seen.add(id); cands.push(b); } }
  for (let en of entities) { if (en.type === 'building' && en.team === e.team && !en.complete &&
    !seen.has(en.id) && dist(e, en) <= 25) { seen.add(en.id); cands.push(en); } }
  cands.sort((a, b) => dist(e, a) - dist(e, b) || a.id - b.id);
  for (let cand of cands) {
    if (cand.id === blockedId) continue;
    let b = BLDGS[cand.btype];
    if (!b.isFarm && !b.walkable && cand.buildProgress === 0 && footprintOccupiedByOther(cand)) continue; // also blocked
    if (canReachBuilding(e, cand)) {
      e.buildQueue = e.buildQueue || [];
      if (!e.buildQueue.includes(blockedId)) e.buildQueue.push(blockedId); // keep it to circle back
      e.task = 'build'; e.buildTarget = cand.id; e.target = null;
      pathToBuilding(e, cand);
      return true;
    }
  }
  return false;
}

// THE retaliation verdict — "should `target`, just hit by `attacker`, take
// it as its combat target?" One predicate for the one decision. Callers own
// the commit side-effects (stashVillagerTask / target / clearUnitPath).
// Deliberately NOT the same predicate as the two ACQUISITION sites — sieged-building
// defense and the idle auto-acquire scan key on stanceOf().acquires and
// isSoldierUnit (villagers retaliate but never acquire) and use plain
// path-or-order move tests; folding them in would change behavior.
function shouldRetaliate(target, attacker){
  // A unit actively carrying out a player move order (a path in progress, or
  // a pending multi-leg move goal — see updateUnit()) keeps obeying it
  // instead of being yanked into combat; e.g. a retreating soldier should
  // keep retreating. Note: a unit that's merely following another (but has
  // already caught up and stopped, path.length===0) isn't "mid-order" in
  // that sense and should still defend itself like any idle unit.
  // For a villager, walking is usually TASK-walking (to the tree, to the
  // drop-off) — that must not exempt it from defending itself, or gatherers
  // get stabbed mid-commute without reacting. Only an explicit player move
  // order ({kind:'move'}, set solely by issueMoveOrder) keeps a villager walking.
  let hasActiveMoveOrder = target.type==='unit' && (
    target.utype==='villager'
      ? (target.order&&target.order.kind==='move')
      : (target.path.length>0 || (target.order&&target.order.kind==='move')));
  // AoE2: villagers fight back against melee attackers — INCLUDING bears:
  // gatherers mob-retaliate as a group (a flee reflex instead let bears
  // outrun and pick off runners one at a time). They don't chase ranged
  // attackers (hopeless kiting) or buildings (tower/TC fire).
  let hopelessChase = target.utype==='villager' &&
    ((attacker.range||0)>0 || attacker.type==='building');
  // Rams never retaliate (1-2 dmg vs units): turning to poke the militia
  // hacking at it just interrupts the wall it was ordered to break. Trade
  // carts can't fight at all (atk 0) — isWoodVehicle below.
  // An AI scout is pure recon — it must NOT retaliate against GAIA wildlife
  // or it gets pinned trading blows mid-explore. It still defends against
  // enemy-TEAM raiders (controlAIScouts also drops any gaia target that
  // slips through; suppressing here stops it being acquired at all).
  let scoutIgnoresGaia = target.utype==='scout' && isAITeam(target.team) && attacker.team===GAIA_TEAM;
  // No Attack (passive) means exactly that — never retaliates, even under
  // fire (else a passive soldier shot by a tower would march in to attack
  // it, the opposite of what the stance promises).
  let passiveNoRetaliate = !stanceOf(target).retaliates;
  // Don't re-lock an attacker this victim has already PROVEN unreachable
  // (unreachId, stamped by the stall resolver) — unless it's strikable
  // RIGHT NOW (canStrikeInPlace), when pathing is moot and the stamp
  // doesn't apply. Same nuance as auto-acquire.
  let unreachAttacker = (target.unreachUntil>tick && target.unreachId===attacker.id)
    && !canStrikeInPlace(target, attacker);
  // An AI unit in tactical retreat (retreatUntil, js/ai.js) keeps running:
  // retaliating would cancel the disengage the moment the pursuer lands a
  // hit — exactly the fight-to-the-death this stamp exists to break.
  let retreating = isRetreatingUnit(target);
  // Stand Ground only retaliates against what it can hit FROM ITS SPOT —
  // same reach test as the combat block's drop (else an acquire→drop churn
  // every arrow).
  let standgroundOutOfReach = target.stance==='standground' && !canStrikeInPlace(target, attacker);
  if(!(target.type==='unit'&&!isHarmlessAnimal(target)&&!isWoodVehicle(target)&&!sameSide(attacker.team,target.team)&&!hasActiveMoveOrder&&!hopelessChase&&!scoutIgnoresGaia&&!passiveNoRetaliate&&!retreating&&!unreachAttacker&&!standgroundOutOfReach))return false;
  if(!target.target)return true;
  let curT = entitiesById.get(target.target);
  // Switch target from buildings/sheep/WILDLIFE to focus the attacking
  // soldier — a unit finishing off a bear must not ignore the enemy
  // spearman now stabbing it (gaia is never the bigger threat).
  return !curT || curT.type==='building'||curT.utype==='sheep'||curT.utype==='sheep_carcass'||curT.team===GAIA_TEAM;
}

function damageEntity(attacker, target){
  let dmg = attacker.atk || 0;
  // The max(1, ...) armor floor below would turn a 0-attack "hit" (sheep,
  // carcasses) into 1 real damage — no attack stat means no damage at all.
  if (dmg <= 0) return;
  // Landed a real hit this tick — records combat activity so the stuck-watchdog
  // doesn't flag a unit that's actively fighting (e.g. sieging a wall an enemy
  // repairs in step, so the target's SAMPLED hp reads flat though blows land).
  attacker.lastAtkTick = tick;
  // AoE2 attack bonuses from the per-unit `bonuses` table (UNITS, js/core.js;
  // openage game_mechanics/damage.md). Keys are target utypes plus the
  // pseudo-class 'building'; the other classic counters emerge from the
  // armor system. Value rationale lives with the data in core.js.
  if (attacker.utype) {
    let bonuses = UNITS[attacker.utype] && UNITS[attacker.utype].bonuses;
    if (bonuses) {
      if (target.type === 'building') { if (bonuses.building) dmg += bonuses.building; }
      else if (bonuses[target.utype]) dmg += bonuses[target.utype];
    }
  }

  // AoE2 armor: damage = max(1, attack - armor). Ranged units and building
  // arrows deal pierce damage; everything else is melee. High building pierce
  // armor is what makes arrows nearly useless against structures.
  let isPierce = (attacker.range || 0) > 0 || attacker.type === 'building';
  let armor = target.type === 'unit'
    ? (UNITS[target.utype].armor || {m:0,p:0})
    : (BLDGS[target.btype].armor || {m:0,p:0});
  // Armor cards (Scale Mail at Feudal, Chain Mail at Castle): military
  // units gain +1 melee AND pierce armor per card, read live here (the
  // matching attack cards are applied at spawn + swept on age-up since atk
  // is snapshotted onto entities). See UPGRADES, js/core.js.
  let ageArm = (target.type === 'unit' && MILITARY.has(target.utype)) ? upgradeArmorBonus(target.team) : 0;
  dmg = Math.max(1, dmg - ((isPierce ? armor.p : armor.m) + ageArm));

  target.hp -= dmg;

  // Combat sound + particles. Sheep don't get the steel clash — the bleat
  // on death (handleDeath) is the sheep's own audio.
  if (target.type === 'unit') {
    if (window.playSound && !isHarmlessAnimal(target)) {
      window.playSound('attack', target.x, target.y);
    }
    spawnParticles(target.x, target.y, '#990000', 4, 0.04, 1.5);
  } else {
    if (window.playSound) window.playSound('build', target.x + (target.w||1)/2, target.y + (target.h||1)/2);
    spawnParticles(target.x + (target.w||1)/2, target.y + (target.h||1)/2, '#8b6c43', 3, 0.03, 2);
  }

  // Minimap raid alert: attacked player objects blink white (drawMinimap
  // via teamColor()'s myTeam-relative logic), AoE2-style. Not team-gated
  // here — the sim processes both teams every tick, so record for either
  // team unconditionally; the READ side filters to "mine".
  target.lastHitTick = tick;
  // Enemy-PLAYER hits only (not wildlife): the AI's tactical retreat keys on
  // this — running from a bear is the documented losing move (bears outrun
  // infantry and pick off runners; the mob-fight wins), so a bear mauling
  // must never trigger a retreat. Hashed in detEntityHash (sim-read).
  if (target.type === 'unit' && isEnemyOf(target.team, attacker)) target.lastEnemyHitTick = tick;
  // RAID LEARNING (throttled, mirrors the wildlife branch below): an AI
  // villager hit by an enemy PLAYER stamps a danger zone at its own tile —
  // learned on the FIRST hit, not on death. Caught in the FIELD (beyond the
  // town's alarm radius, where the bell can't help), it also drops
  // everything and runs home. Militia villagers (explicitAttack) and
  // villagers already walking to shelter are exempt.
  if (target.utype === 'villager' && isAITeam(target.team) && attacker.team !== GAIA_TEAM
      && isEnemyOf(target.team, attacker) && retryReady(target,RETRY.FLEE_RAID)) {
    retryStamp(target,RETRY.FLEE_RAID, T30(90));
    let dzAi = AI_STATES && AI_STATES[target.team];
    if (dzAi && dzAi.dangerZones) stampDangerZone(dzAi, Math.round(target.x), Math.round(target.y));
    if (!target.explicitAttack && target.task !== 'garrison') {
      let tc = teamTC(target.team);
      if (tc) {
        let c = centerOf(tc);
        if (dist(target, c) > AI_BASE_ALARM_RADIUS * aiScale()) {
          target.task = null; target.target = null; target.buildTarget = null;
          clearGatherTarget(target);
          let pt = nearestBldgPerimeter(target.x, target.y, tc, target.id);
          issueMoveOrder(target, pt ? pt.x : Math.round(c.x), pt ? pt.y : Math.round(c.y));
        }
      }
    }
  }
  // MELEE hits on a ram specifically (any attacker, wildlife included): the
  // AI's rider-disembark keys on this — arrow chip damage (isPierce, 1/hit
  // through the ram's 8 pierce armor) must never eject the riders into the
  // exact arrow fire the garrison protects them from. Hashed in detEntityHash.
  if (target.utype === 'ram' && !isPierce) target.lastMeleeHitTick = tick;

  // Feed the adaptive music: actual damage is the strongest mood signal —
  // it catches open-field battles that building-proximity checks miss.
  // Viewer-relative (myTeam, not 0/1): under lockstep both peers run this —
  // danger music is "I'm taking damage", war music is "I'm dealing it".
  if (isEnemyOf(myTeam, attacker) && target.team === myTeam) window.lastDangerTick = tick;
  else if (attacker.team === myTeam && isEnemyOf(myTeam, target)) {
    window.lastWarTick = tick; // music mood only — the AI reads lastTeamHit below
  }

  // SIM-side per-team hit record (unlike the viewer-relative music signals
  // above): the last time each team took damage from another player team,
  // and where. AI garrison reactions read this on later ticks
  // (updateAIGarrisonReaction, js/ai.js), so it must be deterministic and
  // ride the lockstep snapshots (js/core.js's lastTeamHit).
  if (lastTeamHit && isEnemyOf(target.team, attacker) && isPlayerTeam(target.team)) {
    // `core` = the hit actually threatens the economy: a villager or the TC
    // itself. A peripheral WALL hit is NOT core — the AI garrison reaction
    // must not hide the whole workforce over an army poking a ring it can't
    // breach (that froze the eco forever).
    let core = target.utype === 'villager' || target.btype === 'TC';
    lastTeamHit[target.team] = { tick, x: target.x, y: target.y, core };
  }

  // Under attack alarm (player team 0): the horn announces a NEW attack, not
  // an ongoing one — the danger music carries the battle. It only re-arms
  // after ~20s without taking any hits.
  if (target.team === myTeam && isEnemyOf(myTeam, attacker)) {
    let lastHit = window.lastUnderAttackTick;
    window.lastUnderAttackTick = tick;
    if (lastHit === undefined || tick - lastHit > 600) {
      if (window.playSound) window.playSound('alert');
      showMsg('We are under attack!');
    }
  }
  
  // Wildlife bookkeeping (throttled): a mauled villager still calls in the
  // military hunt (huntAIBears, js/ai.js) and stamps a small danger zone so
  // the AI doesn't RE-TASK fresh gatherers onto the bear's patch while the
  // fight/hunt plays out. The zone dies with the bear (canGatherTile).
  // (Independent of the retaliation verdict below — a villager both mobs
  // the bear AND logs the danger.)
  if(target.utype==='villager'&&attacker.utype==='bear'&&retryReady(target,RETRY.FLEE_BEAR)){
    retryStamp(target,RETRY.FLEE_BEAR,T30(90));
    target.fledBearId=attacker.id;
    let dzAi=AI_STATES&&AI_STATES[target.team];
    if(dzAi&&dzAi.dangerZones)stampDangerZone(dzAi,Math.round(attacker.x),Math.round(attacker.y),attacker.id);
  }
  // Retaliation: attacked units fight back — the full verdict lives in
  // shouldRetaliate() (one predicate, one place); this site owns only the
  // commit side-effects.
  if(shouldRetaliate(target, attacker)){
    // Save task details so they can resume after defending themselves
    if (target.utype === 'villager') stashVillagerTask(target);
    target.target = attacker.id;
    target.task = null; // drop gathering/farming/building tasks
    clearUnitPath(target);
  }
  
  // Defend sieged buildings: when a building is hit, nearby idle military
  // (not passive, no current fight) converge on the attacker — matching how
  // units already retaliate when hit themselves.
  if(target.type==='building'&&!sameSide(attacker.team,target.team)){
    entities.forEach(en=>{
      if(en.type!=='unit'||!sameSide(en.team,target.team))return; // allies defend a sieged building too
      // non-combatants sit out: carts have atk 0, rams do 1-2 vs units
      if(!isSoldierUnit(en))return;
      if(en.target||en.task||!stanceOf(en).acquires)return;
      if(isRetreatingUnit(en))return; // tactical retreat (js/ai.js) — keeps running
      if(en.path.length>0||(en.order&&en.order.kind==='move'))return; // obeying a move order
      if(distToTarget(en,target)>8)return;
      // Same fog gate the acquire scan enforces — ONE rule for humans and
      // AI (information parity): don't lock a defender onto an attacker
      // its team can't even see (a fogged sieger revealed only by its
      // arrows). Being HIT is still knowledge (the AI's bell/militia
      // reactions key off lastTeamHit) — hide from a ghost, don't hunt it.
      if(!entityVisibleToTeam(attacker, en.team))return;
      en.target=attacker.id;
    });
  }

  if(target.hp<=0) handleDeath(target, attacker.team);
}// Auto-task at a work building — fires both when a builder FINISHES a site
// and when a villager is DISPATCHED to a complete drop-off ("send to the
// wood camp = become a lumberjack", user call). Resource searches anchor
// on the BUILDING (findNearTile anchor), not the villager: dispatch fired
// on the order tick, so self-anchored searches grabbed whatever was near
// the villager's old spot and the camp was never reached.
function autoTaskBuilder(e, bt, dispatched){
  // Anchor the resource search on the BUILDING only for a human dispatch
  // ("send to the wood camp") — the no-op branch can also fire with a
  // FAR-OFF completed buildTarget (drained build queues), and anchoring
  // there marched AI villagers across the map (sim-smoke food starvation).
  let A = dispatched ? bt : null;
  let ax = dispatched ? bt.x : e.x, ay = dispatched ? bt.y : e.y;
  if(bt.btype==='FARM'){
    e.task='farm';
    e.gatherX=bt.x;
    e.gatherY=bt.y;
  } else if(bt.btype==='LCAMP'){
    let nearWood = findNearTile(e, TERRAIN.FOREST, null, A);
    if (nearWood) {
      e.task = 'chop';
      e.gatherX = nearWood.x;
      e.gatherY = nearWood.y;
      pathUnitTo(e, nearWood.x, nearWood.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MILL'){
    // DISPATCHED to the mill = "make me a farmer" (user call): nearest
    // unstaffed farm plot by the mill first, berries as the fallback.
    // Post-CONSTRUCTION keeps forage-first: the mill founds ON a berry
    // patch, and pulling its builder to a distant farm food-starved the
    // AI (sim-smoke regression).
    let nearFarm = dispatched ? findNearTile(e, TERRAIN.FARM, null, A) : null;
    if (nearFarm) {
      e.task = 'farm';
      e.gatherX = nearFarm.x;
      e.gatherY = nearFarm.y;
      pathUnitTo(e, nearFarm.x, nearFarm.y);
      return;
    }
    let nearBerries = findNearTile(e, TERRAIN.BERRIES, null, A);
    if (nearBerries) {
      e.task = 'forage';
      e.gatherX = nearBerries.x;
      e.gatherY = nearBerries.y;
      pathUnitTo(e, nearBerries.x, nearBerries.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MCAMP'){
    let nearGold = findNearTile(e, TERRAIN.GOLD, null, A);
    let nearStone = findNearTile(e, TERRAIN.STONE, null, A);
    let targetTile = null;
    let targetTask = null;
    if (nearGold && nearStone) {
      let dGold = Math.abs(nearGold.x - ax) + Math.abs(nearGold.y - ay);
      let dStone = Math.abs(nearStone.x - ax) + Math.abs(nearStone.y - ay);
      if (dGold <= dStone) {
        targetTile = nearGold;
        targetTask = 'mine_gold';
      } else {
        targetTile = nearStone;
        targetTask = 'mine_stone';
      }
    } else if (nearGold) {
      targetTile = nearGold;
      targetTask = 'mine_gold';
    } else if (nearStone) {
      targetTile = nearStone;
      targetTask = 'mine_stone';
    }
    
    if (targetTile) {
      e.task = targetTask;
      e.gatherX = targetTile.x;
      e.gatherY = targetTile.y;
      pathUnitTo(e, targetTile.x, targetTile.y);
    } else {
      e.task = null;
    }
  } else {
    e.task = null;
  }
}

// THE one way a villager's work gets stashed before an interruption
// (retaliation, town bell, civilian militia) — restoreSavedTask below reads
// exactly these six fields back. buildQueue is CLONED: the live array keeps
// mutating while the villager is interrupted.
function stashVillagerTask(v){
  // the sheep line (herding/butchering) rides TARGET with no task — it
  // must stash too, or bell/militia interruptions dropped the job and
  // released villagers stood idle by their carcass (user caught it)
  let tgt=v.target&&entitiesById.get(v.target);
  let workTarget=tgt&&(tgt.utype==='sheep'||tgt.utype==='sheep_carcass')?v.target:null;
  if(v.savedTask||!(v.task||v.buildTarget||v.gatherX>=0||workTarget))return;
  v.savedTask={task:v.task,gatherX:v.gatherX,gatherY:v.gatherY,
    buildTarget:v.buildTarget,buildQueue:v.buildQueue?[...v.buildQueue]:[],prevTask:v.prevTask,
    target:workTarget};
}
function restoreSavedTask(e) {
  if (e.utype === 'villager' && e.savedTask) {
    e.task = e.savedTask.task;
    e.gatherX = e.savedTask.gatherX;
    e.gatherY = e.savedTask.gatherY;
    e.buildTarget = e.savedTask.buildTarget;
    e.buildQueue = e.savedTask.buildQueue;
    e.prevTask = e.savedTask.prevTask;
    // sheep-line work target: resume only if the sheep/carcass still
    // exists — updateUnit re-paths and the butcher loop handles the rest
    if (e.savedTask.target && entitiesById.get(e.savedTask.target))
      e.target = e.savedTask.target;
    e.savedTask = null;

    if (e.task === 'build' && e.buildTarget) {
      let bt = entitiesById.get(e.buildTarget);
      if (bt) pathToBuilding(e, bt);
    } else if (e.task === 'return') {
      // A loaded hauler resumes its DROP-OFF, not the resource tile: leave
      // the path empty and updateVillagerDropoff (which runs on an empty
      // path) routes to the nearest drop site. Pathing to gatherX here sent
      // an interrupted hauler on a full round-trip back to the tree first.
    } else if (e.gatherX !== undefined && e.gatherX >= 0) {
      pathUnitTo(e, e.gatherX, e.gatherY);
    }
  }
}

// ---- GARRISON (AoE2-style town bell, building garrison & ram riders) ----
// Containers are buildings with a garrisonCap (TC/towers) — or a RAM unit
// (UNITS.ram.garrisonCap): melee infantry rides inside, AoE2 garrison-rams.
function garrisonCap(b){
  return (b.btype&&BLDGS[b.btype].garrisonCap)||(b.utype&&UNITS[b.utype].garrisonCap)||0;
}
function garrisonCount(b){return b.garrison?b.garrison.length:0;}
// `u` (optional) is the unit that wants in: unit containers (rams) only admit
// eligible riders. Callers that pass no unit (town-bell shelter scan, rally
// targets) therefore never treat a ram as shelter — correct: villagers work,
// they don't ride.
// THE "this team's Town Center" lookup (first = lowest id, deterministic).
// Dead buildings leave `entities` synchronously (handleDeath), so hp>0 is
// a same-call-stack guard, not a liveness filter.
function teamTC(team){
  return entities.find(b=>b.type==='building'&&b.btype==='TC'&&b.team===team&&b.hp>0);
}

function canGarrisonIn(b,team,u){
  if(b.team!==team||b.hp<=0||garrisonCap(b)<=0)return false;
  if(b.type==='building')return !!b.complete;
  return b.utype==='ram'&&!!(u&&canRideRam(u));
}
function enterGarrison(e,b){
  b.garrison=b.garrison||[];
  if(b.garrison.length>=garrisonCap(b))return false;
  clearUnitPath(e);
  e.task=null;e.target=null;e.garrisonTarget=null;
  // Order rules at the shelter door: transient orders (move/follow/escort/
  // scout) end — the unit chose shelter over them. GUARD posts survive
  // (asserted contract: a flag outlives a bell; the unit returns to it
  // after the all-clear).
  if(e.order && !(e.order.kind==='guard'||e.order.kind==='guardBuilding')) e.order=null;
  // An ESCORTEE entering shelter freezes its escorts at the door (same
  // conversion as death — they hold the spot until it re-emerges).
  {
    let fx=Math.round(e.x), fy=Math.round(e.y);
    for(let gi=0;gi<entities.length;gi++){
      let g=entities[gi], o=g.order;
      if(o&&o.kind==='escort'&&o.id===e.id&&g.hp>0) g.order={kind:'guard',x:fx,y:fy};
    }
  }
  // AoE2: garrisoning into a drop-off deposits the carried load on entry —
  // a belled villager banks its wood the moment it enters the TC. Buildings
  // that aren't a drop-off for the carried type (towers) don't; the villager
  // keeps the load while sheltered and drops it off after the all-clear.
  if(e.carrying>0&&e.carryType&&b.type==='building'&&dropAccepts(b,e.carryType)){
    resourceStore(e.team)[e.carryType]+=e.carrying;
    e.carrying=0;
  }
  e.garrisonedIn=b.id;
  // Park the unit at the container's center so fog/minimap stay sane while
  // hidden (a ram has no w/h — riders sit ON the ram, and updateUnit keeps
  // them tracking it as it moves).
  e.x=b.x+(b.w||0)/2;e.y=b.y+(b.h||0)/2;e.fromX=e.x;e.fromY=e.y;
  b.garrison.push(e.id);
  // If the entering unit was selected, hand the selection to the building
  // (once its last selected unit steps inside) so the garrison grid shows up.
  if(selected.some(s=>s.id===e.id)){
    selected=selected.filter(s=>s.id!==e.id);
    if(selected.length===0)selected=[b];
  }
  return true;
}
// Eject garrisoned units to open tiles around the building. Optional filter
// (e.g. villagers only for "all clear"); returns how many were ejected.
function ejectGarrison(b,filter){
  if(!b.garrison||b.garrison.length===0)return 0;
  let keep=[],out=0;
  // Tiles already handed out THIS call — unitBlock only rebuilds next tick;
  // without this a full TC dumps everyone onto one tile.
  let taken=new Set();
  b.garrison.forEach(id=>{
    let u=entitiesById.get(id);
    if(!u){return;}
    if(filter&&!filter(u)){keep.push(id);return;}
    // Unit containers (rams) have no w/h footprint — spawn around the wreck.
    let bx=Math.round(b.x),by=Math.round(b.y);
    let spawn=findSpawnTile(bx+(b.w||1),by+(b.h||1),8,taken)||findSpawnTile(bx-1,by-1,8,taken);
    // No free tile in the whole radius-8 ring: if the container still
    // stands the unit stays SHELTERED (ejecting onto the solid footprint
    // parks it inside the building). A DYING container ejects at the wreck
    // and lets separation sort it out — better than deleting the unit.
    if(!spawn && b.hp>0){keep.push(id);return;}
    if(spawn)taken.add(spawn.x+','+spawn.y);
    u.garrisonedIn=undefined;
    if(spawn){u.x=spawn.x+0.5;u.y=spawn.y+0.5;}
    u.fromX=u.x;u.fromY=u.y;
    clearUnitPath(u);
    // Leaving shelter re-anchors the unit at the drop spot (defensive units
    // hold HERE, not the raided spot they fled). A FLAGGED guard post is the
    // player's explicit order and stays put — walking back to the flag is
    // exactly what that order means.
    u.defendX=Math.round(u.x); u.defendY=Math.round(u.y);
    out++;
    // Villagers with a savedTask auto-resume via restoreSavedTask in updateUnit.
  });
  b.garrison=keep;
  return out;
}
// team defaults to 0 (player) for every existing UI call site. The AI (team
// 1) reuses the exact same mechanic for its own defense — see
// updateAIGarrisonReaction() in ai.js — but never touches the player's HUD
// (messages, sound), which stays keyed to myTeam only.
function ringTownBell(team){
  team=team===undefined?0:team;
  // bellRinging is per-team world state (like resources/teamExploredGrid),
  // maintained HERE so no caller juggles its own flag — the sound+message
  // feedback below stays gated on myTeam (whichever team THIS browser tab
  // plays), so a multiplayer guest playing team 1 gets its own bell
  // feedback and the host never hears the other side's bell.
  window.bellRinging[team]=true;
  // Reserve slots so villagers spread across TC/towers instead of all
  // targeting one full building.
  let spots=entities.filter(en=>canGarrisonIn(en,team))
    .map(b=>({b,room:garrisonCap(b)-garrisonCount(b)}));
  // AoE2 bell range (openage game_mechanics/town_bell.md): only villagers
  // within 25 tiles of the TC answer — a far-camp gatherer keeps working.
  // Also softens AI shelter-paralysis (a TC raid doesn't freeze the whole
  // distributed economy). No TC (razed) → no range anchor: everyone may
  // shelter in whatever towers remain.
  const BELL_RANGE=25;
  let bellTC=entities.find(b=>b.type==='building'&&b.team===team&&b.btype==='TC'&&b.complete);
  let sent=0;
  entities.forEach(e=>{
    if(e.team!==team||e.type!=='unit'||e.utype!=='villager'||e.garrisonedIn)return;
    if(e.task==='garrison')return;
    if(bellTC&&distToBuilding(e.x,e.y,bellTC)>BELL_RANGE)return;
    let best=null,bd=Infinity;
    spots.forEach(s=>{
      if(s.room<=0)return;
      let d=distToBuilding(e.x,e.y,s.b);
      if(d<bd){bd=d;best=s;}
    });
    if(!best)return;
    best.room--;
    stashVillagerTask(e);
    e.target=null;e.buildTarget=null;
    e.task='garrison';e.garrisonTarget=best.b.id;
    pathToContact(e,best.b);
    sent++;
  });
  if(team===myTeam){
    if(window.playSound)window.playSound('bell');
    showMsg(sent>0?'Town bell! Villagers run for cover':'Town bell! No garrison space for villagers');
    if(typeof updateUI==='function')updateUI();
  }
  return sent;
}
function soundAllClear(team){
  team=team===undefined?0:team;
  window.bellRinging[team]=false;
  // Release villagers from every garrison (military stays put — use the
  // building's Ungarrison button for them) and cancel villagers still en route.
  entities.forEach(en=>{
    if(en.type==='building'&&en.team===team)ejectGarrison(en,u=>u.utype==='villager');
  });
  entities.forEach(e=>{
    if(e.team===team&&e.type==='unit'&&e.task==='garrison'){
      e.task=null;e.garrisonTarget=null;clearUnitPath(e);
    }
  });
  if(team===myTeam){
    if(window.playSound)window.playSound('bell_clear');
    showMsg('All clear! Villagers return to work');
    if(typeof updateUI==='function')updateUI();
  }
}

// Nearest completed Market for a trade cart. own=true finds the cart's own
// team's Market (its home); own=false finds ANY other player's Market (the
// trade destination — allied or enemy, per AoE2). Deterministic: scans
// `entities` in array order, ties broken by first-found.
// allowIncomplete: accept a Market still under construction — a trade route
// may be ordered before the endpoint finishes; the cart waits at the site
// (updateTradeCart trades only against COMPLETE markets).
function nearestMarket(e, own, allowIncomplete){
  return nearestBuildingWhere(e, b=> b.btype==='MARKET' && (b.complete||allowIncomplete)
    && (own ? b.team===e.team : (b.team!==e.team && isPlayerTeam(b.team))));
}

// Trade cart state machine — shuttles between its home Market (tradeHomeId,
// own team) and a foreign Market (tradeDestId, another player). Modeled on the
// villager gather→return→dropoff loop: gold is loaded (into carrying/carryType,
// both already checksummed) at the destination and deposited to the team's gold
// on arrival home, sized by the distance between the two Markets. Sets the path
// for the current leg; the shared movement step in updateUnit walks it. New
// per-cart fields (tradeHomeId/tradeDestId/tradePhase) are hashed in
// js/determinism.js. Idle carts (never ordered) fall through untouched.
function updateTradeCart(e){
  if(e.tradeDestId==null && e.tradeHomeId==null) return; // idle, not on a route
  let home = e.tradeHomeId!=null ? entitiesById.get(e.tradeHomeId) : null;
  let dest = e.tradeDestId!=null ? entitiesById.get(e.tradeDestId) : null;
  // "Ok" here means alive-and-owned-right; completeness is checked
  // separately — a route to a market still under construction is VALID, the
  // cart just waits at the site until it finishes.
  let homeOk = home&&home.type==='building'&&home.btype==='MARKET'&&home.hp>0&&home.team===e.team;
  let destOk = dest&&dest.type==='building'&&dest.btype==='MARKET'&&dest.hp>0&&dest.team!==e.team&&isPlayerTeam(dest.team);
  // A destroyed endpoint re-resolves to the nearest valid Market so an active
  // route survives losing one market, rather than the cart going idle.
  if(!homeOk){ home=nearestMarket(e,true);  e.tradeHomeId=home?home.id:null; homeOk=!!home; }
  if(!destOk){ dest=nearestMarket(e,false); e.tradeDestId=dest?dest.id:null; destOk=!!dest; }
  if(!homeOk||!destOk){
    // No valid pair of Markets left — end the route and idle.
    e.tradeHomeId=null; e.tradeDestId=null; e.tradePhase=null;
    e.carrying=0; e.carryType=null; clearUnitPath(e);
    feedbackFor(e.team, () => showMsg('Trade Cart needs your Market and another player’s Market.'));
    return;
  }
  if(e.tradePhase==null) e.tradePhase='toDest';
  let goal = e.tradePhase==='toDest' ? dest : home;
  if(adjToBuilding(e.x,e.y,goal)){
    // Pull all the way up to the Market before the exchange: finish the
    // approach leg, tuck in, trade once the cart can get no closer.
    if(e.path.length>0) return;              // still rolling in — let the walk step advance
    if(!dropContactSettled(e, goal)) return; // tuck up against the Market
    if(!goal.complete) return;               // endpoint still building — wait for it
    if(e.tradePhase==='toDest'){
      // Load gold sized by Market separation — Conquerors trade formula
      // (see TRADE_GOLD_FACTOR, js/core.js). Math.sqrt is exact-IEEE and
      // determinism-safe; the −5 per axis is AoE2's "adjacent markets earn
      // nothing" deadzone.
      let tdx=Math.max(0,Math.abs(home.x-dest.x)-5), tdy=Math.max(0,Math.abs(home.y-dest.y)-5);
      let td=Math.max(0.1,Math.sqrt(tdx*tdx+tdy*tdy));
      let g=Math.floor(2*(td/MAP+0.3)*td*TRADE_GOLD_FACTOR+0.5);
      e.carrying=Math.max(1,g); e.carryType='gold';
      e.tradePhase='toHome';
      pathToContact(e,home);   // cheapest-to-walk Market edge, not the straight-line-nearest
    } else {
      resourceStore(e.team).gold += e.carrying;
      e.carrying=0; e.carryType=null;
      e.tradePhase='toDest';
      pathToContact(e,dest);
    }
  } else if(e.path.length===0){
    // Not there and no route queued (fresh order, or a blocked leg) — (re)path.
    pathToContact(e,goal);
  }
}

// Per-building active-worker census for the AoE2 diminishing-returns build/
// repair rates. Workers register on the tick they actually work; the RATE
// reads last tick's total (bt.lastWorkers) so it is identical regardless of
// entity update order within the tick — order-independence is what makes the
// shared-rate math lockstep-safe. All three fields are sim state read on a
// later tick and are hashed in detEntityHash.
function countSiteWorker(bt){
  if(bt.workTick!==tick){ bt.lastWorkers=bt.curWorkers||0; bt.curWorkers=0; bt.workTick=tick; }
  bt.curWorkers++;
}


// Auto Scout (player toggle): keep moving to the most-unexplored frontier
// and AVOID combat (a dead scout stops scouting). Reuses the AI's frontier
// picker (pickExploreWaypoint, js/ai.js) off the deterministic per-team
// explored grid + simRandInt. Only reached with an empty path (arrived);
// re-pick on a light cadence so a blocked pick doesn't churn every tick.
// Manual orders replace the scout order (execUnitCommand).
function updateAutoScoutTick(e){
  if(e.target){ e.target=null; e.explicitAttack=false; }
  if(e.path.length===0 && (tick+e.id)%AUTOSCOUT_REPICK_EVERY===0){
    let home=teamTC(e.team)||null;
    let pt=(typeof pickExploreWaypoint==='function')?pickExploreWaypoint(e.team, home):null;
    if(pt)pathUnitTo(e,pt.x,pt.y);
  }
  return;
}

// ---- IDLE MILITARY (auto-attack acquire + guard return + anchor drift) ----
// Runs only when the unit reached the end of its tick with nothing else to do.
function updateIdleMilitary(e){
  // Auto-attack: idle military engage nearby enemies. Bears are excluded
  // (own leashed aggro logic, not this never-give-up chase). Rams never
  // auto-engage (AoE2; 1-2 dmg vs units is suicide-by-distraction). Trade
  // carts are unarmed haulers (atk 0) — never let them auto-engage.
  let isMilitary = isSoldierUnit(e);
  // followId isn't excluded: a follower that has caught up and stopped
  // still engages like any idle unit — combat takes precedence and the
  // follow resumes after (only the per-leg pathing is touched).
  if(isMilitary && !e.target && e.path.length===0 && !e.task){
    // A guard flag PINS the defend anchor to the flagged spot; an idle
    // guard away from its flag walks back (retryReady throttles the
    // re-path). Idle anchor drift is unconditional: defendX/Y means "where
    // this unit last idled" and NOTHING else — the guard leash reads
    // guardX/Y directly.
    e.defendX = e.x;
    e.defendY = e.y;
    let gRet = guardOrderOf(e);
    // Escorts are skipped: the follow leg (updateFollowOrder) does the
    // walking — don't compete with it for the path.
    if(gRet && gRet.kind !== 'escort'){
      let gdx = e.x - gRet.x, gdy = e.y - gRet.y;
      if(gdx*gdx + gdy*gdy > 2.25 && retryReady(e,RETRY.GUARD_RETURN)){
        // BACK-OFF rule: a blocked return must fail QUIETLY. Shared posts
        // only seat ~9 units within the 1.5-tile radius, and a post can be
        // built over, in forest, or inside a garrison footprint — without
        // this, every surplus/blocked unit re-runs A* every 30 ticks
        // forever. After 3 fruitless attempts (retry .n, hashed for
        // lockstep) or an outright no-path: the post is the player's
        // explicit order and NEVER moves on its own — stop trying for a
        // long beat (T30(600)) and re-probe in case the blockage (crowd,
        // construction) has cleared.
        let r = e.retry && e.retry[RETRY.GUARD_RETURN];
        let backOff = () => { retryStamp(e,RETRY.GUARD_RETURN,T30(600)); if (r) e.retry[RETRY.GUARD_RETURN].n = 0; };
        if (r && r.n >= 3) {
          backOff();
        } else {
          retryStamp(e,RETRY.GUARD_RETURN,T30(30));
          e.retry[RETRY.GUARD_RETURN].n++;
          pathUnitTo(e, Math.round(gRet.x), Math.round(gRet.y));
          if (e.path.length === 0) backOff();
        }
      }
    }
    // Stagger the acquisition scan across ticks by id (perf: grid walk +
    // fog gate per candidate, per idle military unit). Worst added reaction
    // delay ~166ms — still under AoE2's 250ms command turns. (tick+id) keys
    // it deterministically, identical on every lockstep peer.
    // AI scouts are pure recon (controlAIScouts owns them for exploration) —
    // they must NOT auto-acquire attack targets, or they wedge chasing a foe
    // near the enemy base they can't reach (partial-path jiggle → stuck-watchdog).
    // A HUMAN scout still auto-acquires (the player expects it to fight).
    if (stanceOf(e).acquires && !isRetreatingUnit(e) && (tick + e.id) % ACQUIRE_STAGGER === 0 && !(e.utype==='scout'&&isAITeam(e.team))) {
      let stanceScan = stanceOf(e).scan;
      let scanRange = stanceScan === 'range' ? (e.range > 0 ? e.range : 1.5) : stanceScan;
      let reachAtk=(e.range>0?e.range:1.6);
      // A guarding unit's aggro is scoped to what it PROTECTS, not to
      // itself: it only engages enemies inside its leash zone (GUARD_LEASH)
      // of the post/building — same zone + radius as the leash above — so
      // it never chases a foe that isn't threatening the guarded thing.
      // Matches AoE2 Guard, vs. plain defensive stance which aggros on
      // anything near the unit. An explicit attack REPLACES any guard order
      // (last order wins).
      let guardZone = guardOrderOf(e) ? guardZoneOf(e) : null;
      let closest=closestUnitNear(e,scanRange+0.1,en=>{
        if(sameSide(en.team,e.team))return false;
        if(guardZone && guardZoneDist(guardZone, en.x, en.y) > GUARD_LEASH)return false; // outside the guard zone → not our fight
        // Skip a foe we recently proved unreachable — UNLESS we can hit it
        // RIGHT NOW without moving (canStrikeInPlace: firing range for
        // ranged, strike-adjacent with a clear corner for melee). A foe
        // that's merely CLOSE but not strikable is the wedge itself —
        // re-grabbing it just thrashes give-up→re-acquire in place. Keep
        // skipping until the flag expires and the crowd may have changed.
        if(e.unreachUntil>tick && e.unreachId===en.id && !canStrikeInPlace(e,en))return false;
        let ey=Math.round(en.y),ex=Math.round(en.x);
        if(ey<0||ey>=MAP||ex<0||ex>=MAP)return false;
        // Fog gate, symmetric per team via the sim's deterministic
        // visibility (entityVisibleToTeam, js/core.js) — never the
        // viewer-local fog grid, which differs between lockstep peers.
        // ONE rule for humans and AI (information parity); gaia (bears)
        // has no vision grid and keeps its own aggro rules.
        if(e.team!==GAIA_TEAM && !entityVisibleToTeam(en, e.team))return false;
        return true;
      });
      if(closest) {
        if(dist(e,closest)<=reachAtk+0.5){
          // Already in attack range → engage directly; no pathing needed (also
          // skips the findPath below, the auto-acquire hotspot at a wall standoff).
          e.target=closest.id;
        } else {
          // Only lock on if we can actually PATH to it — an idle unit
          // grabbing a foe it can't reach (a raider outside our sealed wall
          // ring) re-acquires every few ticks and freezes chasing an
          // impossible target. The candidate is within scan range, so this
          // findPath is short and unambiguous. If unreachable, remember it
          // long enough that a stalemate doesn't re-run this search.
          let cx=Math.round(closest.x), cy=Math.round(closest.y);
          let pth=findPath(Math.round(e.x),Math.round(e.y),cx,cy,e.id);
          let end=pth.length?pth[pth.length-1]:null;
          // End-tile tolerance: ranged can fire from `range` out, so any end
          // within range works. MELEE must end strike-ADJACENT (<=1) — a
          // looser tolerance counts "beside the wall" as reaching a
          // walled-in target, one tile short of striking.
          let endTol = e.range>0 ? reachAtk : 1;
          let endD = end ? Math.max(Math.abs(end.x-cx),Math.abs(end.y-cy)) : Infinity;
          // Melee ending exactly one tile short: distinguish a CROWD from a
          // WALL. If any tile adjacent to the target is blocked only by
          // standing UNITS (walkable with units ignored, not without), the
          // ring is a dogpile that clears — lock on and let combatApproach's
          // crowd machinery queue us in. Terrain/buildings on every adjacent
          // tile = genuinely walled → unreachable stamp.
          let crowdRing=false;
          if(end && e.range<=0 && endD===2){
            for(let ady=-1;ady<=1&&!crowdRing;ady++)for(let adx=-1;adx<=1;adx++){
              if(!adx&&!ady)continue;
              if(!walkable(cx+adx,cy+ady,e.id)&&walkable(cx+adx,cy+ady,e.id,true)){crowdRing=true;break;}
            }
          }
          if(end && (endD<=endTol || crowdRing)){
            e.target=closest.id;
          } else { stampUnreachable(e, closest.id, UNREACH_UNIT_TICKS); } // a unit's blockage clears fast — re-check soon
        }
      } else if (isHumanTeam(e.team)) {
        // No enemy unit in range: engage enemy BUILDINGS (AoE2 aggressive
        // behavior — soldiers parked in an enemy town shouldn't soak
        // tower/TC fire without answering). Arrow-firing structures take
        // priority; walls/gates are excluded so armies don't spontaneously
        // whittle fortifications they're merely standing near. Same
        // visibility gate as units; ties broken by lowest id
        // (deterministic). The AI keeps its own attack planning.
        let bestB = null, bestD = Infinity, bestPri = -1;
        for (let bi = 0; bi < entities.length; bi++) {
          let b = entities[bi];
          if (b.type !== 'building' || sameSide(b.team, e.team) || b.team === GAIA_TEAM || b.hp <= 0) continue;
          if (isWallBtype(b.btype) || isGateBtype(b.btype)) continue;
          if (guardZone && guardZoneDist(guardZone, b.x + b.w/2, b.y + b.h/2) > GUARD_LEASH) continue; // outside the guard zone
          let d = distToTarget(e, b);
          if (d > scanRange + 0.1) continue;
          if (!entityVisibleToTeam(b, e.team)) continue;
          let pri = firesArrows(b.btype) ? 1 : 0;
          if (pri > bestPri || (pri === bestPri && (d < bestD || (d === bestD && bestB && b.id < bestB.id)))) {
            bestPri = pri; bestD = d; bestB = b;
          }
        }
        if (bestB) {
          // Only commit if we can actually reach it. A human unit never
          // auto-gives-up (combatApproach's drop is AI-only), so locking onto a
          // building behind a wall makes it wall-hump forever. Require a path
          // that lands adjacent to the building's footprint.
          let bx=Math.round(bestB.x+bestB.w/2), by=Math.round(bestB.y+bestB.h/2);
          let pth=findPath(Math.round(e.x),Math.round(e.y),bx,by,e.id);
          let end=pth.length?pth[pth.length-1]:null;
          if(end && Math.max(Math.abs(end.x-bx),Math.abs(end.y-by))<=Math.max(bestB.w,bestB.h)+1) e.target=bestB.id;
        }
      }
    }
  }
}


// ---- VILLAGER DROP-OFF (task==='return') ----
// Always ends the tick (the dispatcher returns after calling).
function updateVillagerDropoff(e){
  // Patience gate: when every route was blocked (usually a crowded drop
  // site, not a walled-off one), wait a beat and retry with a full load
  // instead of going idle and silently losing the carried resources.
  if(retryActive(e,RETRY.DROP_WAIT)){
    if(!retryReady(e,RETRY.DROP_WAIT))return;
    retryClear(e,RETRY.DROP_WAIT);
    avoidClear(e,'drops');
  }
  let drop=nearestDrop(e,e.carryType,e.avoid&&e.avoid.drops);
  if(!drop){
    // No drop site exists at all for this resource — genuinely nothing
    // to wait for.
    e.task=null;
    avoidClear(e,'drops');
    feedbackFor(e.team, () => showMsg('No drop site for '+e.carryType+'! Build one.'));
    return;
  }
  if(!adjToBuilding(e.x,e.y,drop)){
    // Path ONCE to the cheapest-to-WALK drop-off edge (goalBldg A*), then let
    // movement + the block-wait queue carry the hauler — same discipline as the
    // build loop and the trade cart. Recomputing every tick made returning
    // haulers oscillate and wedge at chokepoints.
    if(e.path.length===0){
      pathToContact(e,drop);
      if(e.path.length===0){
        avoidAdd(e,'drops',drop.id);

        let foundPath = false;
        while (true) {
          let nextDrop = nearestDrop(e, e.carryType, e.avoid&&e.avoid.drops);
          if (!nextDrop) break;

          pathToContact(e, nextDrop);
          if (e.path.length > 0) {
            foundPath = true;
            break;
          }
          avoidAdd(e,'drops',nextDrop.id);
        }

        if (foundPath) return;

        // Every drop site unreachable right now — hold the load and retry
        // shortly (see the dropWait gate above) rather than giving up.
        retryStamp(e,RETRY.DROP_WAIT,T30(30));
      }
    }
  } else {
    // Slide right up to the drop-off and deposit AT the wall. The tuck is
    // COSMETIC — adjacency (checked above) already earns the deposit — so it
    // must never HANG: at a crowded drop, unit separation can nudge the hauler
    // back out each tick so dropContactSettled never reports "settled", spinning
    // it forever holding its load. Bound it with DROP_TUCK — if it can't settle
    // within the budget, deposit anyway.
    if(!dropContactSettled(e, drop)){
      if(!(retryActive(e,RETRY.DROP_TUCK) && retryReady(e,RETRY.DROP_TUCK))){
        if(!retryActive(e,RETRY.DROP_TUCK)) retryStamp(e,RETRY.DROP_TUCK,T30(30));
        return; // still sliding in, within budget
      }
      // budget elapsed without settling -> stop tucking, deposit now
    }
    retryClear(e,RETRY.DROP_TUCK);
    resourceStore(e.team)[e.carryType]+=e.carrying;
    e.carrying=0;
    avoidClear(e,'drops');
    if(e.prevTask){e.task=e.prevTask;e.prevTask=null;}
    else {
      e.task=null;
      // Nothing to resume: release the remembered gather tile so it
      // stops counting as "claimed" for other villagers (findNearTile)
      // and this idle villager isn't exempt from unit separation.
      if(!e.target) clearGatherTarget(e);
    }
  }
}

// ---- VILLAGER CONSTRUCTION/REPAIR (task==='build') ----
// Always ends the tick.
function updateVillagerBuild(e){
  let bt=entitiesById.get(e.buildTarget);
  if(!bt||(bt.complete && bt.hp >= bt.maxHp && !(bt.btype==='FARM' && bt.exhausted))){
    if(!checkNextBuild(e)){
      e.task=null;
      e.buildTarget=null;
      if(bt) autoTaskBuilder(e, bt, !isAITeam(e.team)); // human dispatch ("send to camp") — the AI's own assigner owns its villagers
    }
    return;
  }
  let isFarm=bt.btype==='FARM';
  let close=isFarm?dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2:adjToBuilding(e.x,e.y,bt);
  if(!close){
    // Path ONCE toward the site, then let movement + the block-wait queue
    // (stepBlocked, js/pathfinding.js) carry the builder there. Recomputing the
    // route every tick makes a unit at a chokepoint abandon its queue slot to
    // try an equally-short alternate as the crowd shifts — it oscillates and
    // wedges, which is exactly the dance stepBlocked's wait was built to stop.
    // Only (re)plan when the held route has emptied: stepBlocked has by then
    // either delivered the builder (close, handled below) or given up on a
    // truly blocked lane, so a fresh plan is warranted.
    if(e.path.length===0){
      pathToBuilding(e,bt); // farm plot, else cheapest-to-WALK contact tile (goalBldg)
      if(e.path.length===0){
        // Still no route AND not adjacent → the site is unreachable right now.
        let checkClose = isFarm ? dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2 : adjToBuilding(e.x,e.y,bt);
        if (!checkClose) {
          // Perimeter may just be crowded — retry a few times, then back the
          // foundation off so assigners skip it until the stamp expires
          // (neededAIBuildingWork AND checkNextBuild) instead of re-feeding
          // villagers into an unreachable site forever (a pathfinding storm).
          if(!retryFail(e,RETRY.BUILD,0,6)) return;
          feedbackFor(e.team, () => showMsg('Building site is unreachable!'));
          bt.buildBackoffUntil=tick+900;
          if(!checkNextBuild(e)){
            e.task=null; // savedTask resume / AI reassignment reroutes from idle
            e.buildTarget=null;
          }
        } else {
          retryClear(e,RETRY.BUILD);
        }
      }
    }
  } else {
    retryClear(e,RETRY.BUILD);
    // Slide-to-contact so the builder visibly HUGS the foundation — press
    // to the nearest point on the building's OWN edge so co-builders each
    // tuck against their own side. Farms are walkable (the farmer stands ON
    // the plot) — no press. Builders are separation-exempt (loop.js
    // separateUnits); pressToContact's walkable(ignoreUnits) guard keeps
    // them off the footprint itself.
    if(!isFarm) slideToContact(e, bt, 0.35);
    if (bt.btype === 'FARM' && bt.exhausted) {
      let store = resourceStore(e.team);
      // Direct wood reseed applies to the AI (managing its own farms) and to a
      // human's DELIBERATE send (explicitReseed, set by clicking the farm). The
      // automatic paths — exhaustion-continuity and auto-wander — leave the flag
      // false, so a human's wood is only ever spent on prepaid credit or an
      // explicit order, never silently.
      let payWood = isAITeam(e.team) || e.explicitReseed;
      e.explicitReseed = false;
      if (store && store.prepaidFarms > 0) {
        store.prepaidFarms--;
        feedbackFor(e.team, () => showMsg("Reseed consumed from Mill! (Prepaid remaining: " + store.prepaidFarms + ")"));
        reseedFarmForFarmer(bt, e);
        return;
      } else if (payWood && store && store.wood >= 60) {
        store.wood -= 60;
        feedbackFor(e.team, () => showMsg("Farm reseeded (-60 Wood)"));
        reseedFarmForFarmer(bt, e);
        return;
      } else {
        feedbackFor(e.team, () => showMsg(payWood ? "Not enough wood to reseed farm!" : "Farm exhausted — reactivate it or prepay reseeds at the Mill"));
        // Look for another workable farm instead of idling — the
        // farm-task fallback below (updateGatherTask) finds the next
        // complete farm, or idles if none exists.
        e.task = 'farm';
        clearGatherTarget(e);
        e.buildTarget = null;
        clearGatherTarget(e);
        return;
      }
    }
    // AoE2 multi-builder rule (openage doc/reverse_engineering/
    // game_mechanics/build_speed.md): time = 3·build_time/(builders+2),
    // NOT linear — the 2nd builder is worth +33%, not +100%. Each active
    // worker contributes (v+2)/(3v) progress per work tick so the site's
    // total per-tick rate is (v+2)/3 (v=1 → exactly 1/tick).
    // v comes from a per-building counter with a ONE-TICK LAG: workers
    // register as they're updated, and the rate uses last tick's count —
    // the value is identical no matter which worker updates first, which
    // keeps the math order-independent (lockstep determinism).
    countSiteWorker(bt);
    let vWorkers=Math.max(1,bt.lastWorkers||1);
    let workShare=(vWorkers+2)/(3*vWorkers);
    if (!bt.complete) {
      // AoE2: a foundation is WALKABLE while buildProgress===0 (walkable() lets
      // units cross an un-started site so a dropped foundation can't grief-block
      // a lane), and construction can't START until the footprint is clear of
      // everyone but its own builders. So the tiles only harden (buildProgress
      // >0 → solid) once no one's standing on them, and can never seal a unit
      // in — no teleporting anyone. Once solid they stay clear, so the gate only
      // matters at 0. Farms/walkable buildings never harden, so they build
      // regardless of who's on the plot.
      if (bt.buildProgress === 0) {
        let bd = BLDGS[bt.btype];
        if (!bd.isFarm && !bd.walkable && footprintOccupiedByOther(bt)) {
          clearFootprintForBuild(bt);     // walk non-enemies off; enemies just block
          tryBuildElsewhere(e, bt.id);    // meanwhile go build the next site, circle back
          return;
        }
      }
      bt.buildProgress+=workShare;
      // HP grows with construction (AoE2): each work tick adds its share
      // of maxHp, so a half-built structure has half its HP. Damage taken
      // during construction persists (the cap only limits, never heals).
      bt.hp=Math.min(bt.maxHp,bt.hp+workShare*bt.maxHp/bt.buildTime);
      // Construction hammer audio plays at the mallet's VISUAL impact in
      // render-units.js (same treatment as chop/mine).
      if(bt.buildProgress>=bt.buildTime){
        bt.complete=true;
        bt.hp=Math.min(bt.maxHp,Math.round(bt.hp));
        e.buildTarget=null;
        if (e.team === myTeam && window.playSound) { // myTeam, not 0: on the host they're equal, and the guest completion path (js/net-sync.js) mirrors this gate
          window.playSound('train'); // play herald fanfare on building completed
        }
        if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);

        if(!checkNextBuild(e)){
          autoTaskBuilder(e, bt);
        }
      }
    } else {
      // Repair (AoE2 rates, openage .../game_mechanics/repair.md):
      // 750 hp/min = 12.5 hp/game-second for the FIRST villager, each
      // additional adds 50% of that (6.25) — NOT linear per villager.
      // Site total = 12.5·(v+1)/2 hp/s, split evenly per worker here:
      // each worker accrues total/(v·TPS) hp per tick into repairAccum,
      // and whole hp are paid+applied through the existing cost debt
      // machinery below. The ram-vs-repair contract still holds: a ram's
      // 22.4 hp/s building dps out-damages 12.5 (1 repairer) and 18.75 (2).
      bt.repairAccum = (bt.repairAccum || 0) + (12.5 * (vWorkers + 1)) / (2 * vWorkers * TPS);
      if (bt.repairAccum >= 1) {
        bt.repairAccum -= 1;

        let bData = BLDGS[bt.btype];
        let bCost = (bData && bData.cost) || {};
        let costFraction = 0.5 / bt.maxHp;
        let woodCost = (bCost.w || 0) * costFraction;
        let stoneCost = (bCost.s || 0) * costFraction;

        bt.woodDebt = (bt.woodDebt || 0) + woodCost;
        bt.stoneDebt = (bt.stoneDebt || 0) + stoneCost;

        let wD = Math.floor(bt.woodDebt);
        let sD = Math.floor(bt.stoneDebt);

        let store = resourceStore(e.team);
        let hasWood = store.wood >= wD;
        let hasStone = sD === 0 || (store.stone !== undefined && store.stone >= sD);

        if (hasWood && hasStone) {
          store.wood -= wD;
          if (sD > 0 && store.stone !== undefined) store.stone -= sD;
          bt.woodDebt -= wD;
          bt.stoneDebt -= sD;
          bt.hp = Math.min(bt.maxHp, bt.hp + 1);
        } else {
          if (e.team === myTeam) {
            showMsg('Not enough resources to repair!');
          }
          // Same general back-off as an unreachable site: stop feeding
          // villagers into a repair the bank can't pay for; the stamp
          // expires so the repair is retried once income catches up.
          bt.buildBackoffUntil = tick + T30(900);
          e.buildTarget = null;
          e.task = null;
          bt.woodDebt = 0;
          bt.stoneDebt = 0;
          return;
        }
      }
      if (bt.hp >= bt.maxHp) {
        e.buildTarget = null;
        bt.woodDebt = 0;
        bt.stoneDebt = 0;
        if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);
        if(!checkNextBuild(e)){
          e.task=null;
        }
      }
    }
  }
}

// ---- COMBAT (unit has a target; ranged fire / melee press / mop-up /
// fog drop / leash) ----
// Always ends the tick. The chase give-up ladder it drives lives in the
// CHASE CONTROLLER section above (combatApproach / resolveStalledAttack /
// stampUnreachable).
function updateUnitCombat(e){
  let t=entitiesById.get(e.target);
  if(!t||t.hp<=0){
    // Human assault: when the ordered target dies, CONTINUE the attack
    // instead of idling. Two tiers, nearest-reachable first:
    //   1) A connected enemy wall/gate within ~3 tiles — keep breaching
    //      the same run.
    //   2) Any enemy building within ASSAULT_MOP_UP tiles. Idle auto-
    //      acquire only ever targets enemy UNITS (targetableUnitGrid), so
    //      without this the whole army goes inert the instant the ordered
    //      building falls. Bounded range so it razes the base it's IN, not
    //      a distant town. Reachability probes only run the tick a target
    //      dies, not every tick.
    // The AI is gated out (isHumanTeam) — its planner reassigns targets.
    if(isHumanTeam(e.team) && e.explicitAttack){
      let wall=null, wd=Infinity, cand=[];
      for(let i=0;i<entities.length;i++){ let bx=entities[i];
        if(bx.type!=='building'||bx.hp<=0||sameSide(bx.team,e.team))continue;
        let d=distToTarget(e,bx);
        if((isWallBtype(bx.btype)||isGateBtype(bx.btype)) && d<=3 && d<wd){ wd=d; wall=bx; }
        if(d<=ASSAULT_MOP_UP) cand.push({bx,d});
      }
      let next = (wall && isTargetReachable(e,wall)) ? wall : null;
      if(!next){
        cand.sort((a,b)=>a.d-b.d||a.bx.id-b.bx.id); // deterministic tiebreak (house rule: never rely on sort stability)
        for(let i=0;i<cand.length && i<8;i++){ if(isTargetReachable(e,cand[i].bx)){ next=cand[i].bx; break; } }
      }
      if(next){ e.target=next.id; return; } // keep explicitAttack
    }
    if(window.__dropStats)window.__dropStats.killed=(window.__dropStats.killed||0)+1;
    e.target=null;
    e.explicitAttack=false;
    return;
  }

  // Fog gate for combat targets: the sim's own deterministic per-team
  // visibility (entityVisibleToTeam, js/core.js) — NEVER the viewer-local
  // `fog` grid, which differs between lockstep peers. ONE rule for humans
  // and AI (information parity). Sole asymmetry: an AI EXPLICIT march keeps
  // its target out of sight (controlAIMilitary attacks the remembered enemy
  // TC — otherwise the army's attack order is wiped the tick after it's
  // given and it never leaves home). A human's explicit attack instead
  // drops on lost vision: the player is watching the fog and re-clicks.
  // e.team !== GAIA_TEAM: gaia (bears) has no vision grid and keeps its
  // own aggro rules.
  if (!sameSide(t.team, e.team) && t.team !== GAIA_TEAM && e.team !== GAIA_TEAM
      && !(isAITeam(e.team) && e.explicitAttack)) {
    if (!entityVisibleToTeam(t, e.team)) {
      if(window.__dropStats)window.__dropStats.visionDrop=(window.__dropStats.visionDrop||0)+1;
      e.target = null;
      e.explicitAttack = false;
      clearUnitPath(e);
      return;
    }
  }

  // Anchor retreat check ("leash"): a guard post leashes AUTO-acquired
  // chases to the post itself — explicit attack orders are exempt, or a
  // commanded assault would get yanked back 6 tiles in — while defensive
  // stance leashes to its drifting idle anchor (defendX/Y). Guard code
  // never mirrors the post into defendX/Y, so each field keeps exactly one
  // meaning (escort zones read the escortee's LIVE position via guardZoneOf).
  if (enforceChaseLeash(e)) return;

  if(e.utype==='villager' && t.utype==='sheep_carcass'){
    let d=distToTarget(e,t);
    // Harvest from a ring around the carcass (not stacked on its tile) so
    // several villagers can eat one sheep at once, AoE2-style — the whole
    // starting crew on the first sheep is the classic opening.
    if(d>SHEEP_HARVEST_RANGE){
      // Full ring: wait for an eating spot instead of abandoning the sheep
      // (same patience pattern as combatApproach below). HARVEST_WAIT is
      // its own registry entry: it historically ALIASED the combat 'chase'
      // stamp — state-exclusive today, but a silent collision the moment
      // any change lets a unit chase and harvest in one life phase.
      if(retryReady(e,RETRY.HARVEST_WAIT)){
        retryStamp(e,RETRY.HARVEST_WAIT,T30(15));
        pathUnitTo(e,Math.round(t.x),Math.round(t.y));
        if(e.path.length===0){
          if(d>8)e.target=null;
          // Near but DEFINITIVELY unreachable (walled off since the kill):
          // release, or the butcher waits at 8 tiles forever (watchdog-
          // proven wedge). A full-but-reachable ring keeps its patience.
          else if(findPath(Math.round(e.x),Math.round(e.y),Math.round(t.x),Math.round(t.y)).length===0)e.target=null;
        }
      }
    } else {
      clearUnitPath(e);
      // Press tight against the carcass (pressToContact) so the herding
      // crew packs onto/around it; separateUnits rings them.
      pressToContact(e, t.x, t.y, 0.7);
      if(e.carrying>=e.carryMax){
        e.prevTask=null;
        e.task='return';
        return;
      }
      if(e.gatherCooldown<=0){
        // Switching resource types drops the old load (same rule as
        // updateGatherTask) — else one bite converts 9 wood into 10 food.
        if(e.carryType!=='food')e.carrying=0;
        t.hp--;
        e.carrying++;
        e.carryType='food';
        e.foodSrc='meat';
        e.gatherCooldown=T30(90); // ~0.33 food/game-second, AoE2 herding rate
        if(window.playSound && tick % (GAME_SPEED >= 4 ? T30(60) : T30(30)) === 0) window.playSound('forage', t.x, t.y);
        spawnParticles(t.x, t.y, '#ebdcb8', 2, 0.02, 1.2);
        if(t.hp<=0){
          // Shepherd continuity for ALL harvesters (including this one)
          // lives in handleDeath — it retargets or nulls e.target itself,
          // so no null-out here.
          handleDeath(t, e.team);
        }
      }
    }
    return;
  }

  let d=distToTarget(e,t);
  let range = UNITS[e.utype]?.range || 0;


  if (range > 0) {
    // Ranged combat: stay within range and fire. The gate carries the +0.5
    // slack (same as the acquire scan and retaliation reach tests):
    // findPath's stopDist goal test is ROUNDED-tile based, so a unit can
    // sit at float d≈range+0.4 where findPath returns [] ("already in
    // range") while a bare d>range gate refuses to fire — a dead zone that
    // stalls the chase into a spurious give-up. d is distToTarget
    // (footprint-aware), so large buildings stay hittable from their edge.
    if (d > range + 0.5) {
      if (e.stance === 'standground' && !e.explicitAttack) {
        e.target = null;
        return;
      }
      if(!combatApproach(e,t,d,null,range)) return; // approach only to firing range — not onto the target
      // Wall-detour hold (self-acquired chases only): a firing tile exists
      // but the walk to it is several times the straight-line distance —
      // fortifications separate us. Arrows fly over walls, so hold at the
      // wall and shoot what actually comes into range instead of filing out
      // of the city for a shot. Same skew test as the melee breach decision
      // (path > 2x direct + 10). Explicit orders and attack waves
      // (explicitAttack) still march the long way.
      if(!e.explicitAttack && e.path.length > d*2+10){
        e.target=null;
        stampUnreachable(e, t.id, UNREACH_UNIT_TICKS);
        clearUnitPath(e); e.chaseProg=undefined;
        return;
      }
    } else {
      clearUnitPath(e);
      if (e.atkCooldown <= 0) {
        spawnProjectile(e, t);
        e.atkCooldown = UNITS[e.utype].rof; // per-unit reload (archer 2s)
      }
    }
  } else {
    // Melee combat
    if(t.type==='building'){
      // Attack building: path to nearest perimeter tile, attack when adjacent
      if(!adjToBuilding(e.x,e.y,t)){
        if (e.stance === 'standground' && !e.explicitAttack) {
          e.target = null;
          return;
        }
        combatApproach(e,t,d,()=>pathToContact(e,t,contactClaims(e,p=>p.target===t.id)));
      } else if(e.path.length>2){
        // Adjacent but still EN ROUTE to a farther assigned ring tile:
        // finish the walk (same explicit step as the garrison leg) —
        // attacking at FIRST touch stacked the whole group on the
        // approach faces and left the far ring empty (user caught it).
        stepUnitAlongPath(e, unitMoveSpeed(e) * UNIT_PX_PER_TICK, true);
      } else {
        // In range: press up against the nearest FOOTPRINT EDGE so attackers
        // pack tight along the wall instead of standing a tile back on their
        // siege-perimeter tile. cx,cy = the unit's position clamped to the
        // footprint rect ([t.x-0.5 .. t.x+t.w-0.5]); the walkable guard in
        // pressToContact keeps them off the building itself.
        let cx=Math.max(t.x-0.5, Math.min(e.x, t.x+t.w-0.5));
        let cy=Math.max(t.y-0.5, Math.min(e.y, t.y+t.h-0.5));
        pressToContact(e, cx, cy, 0.5);
        if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      }
    } else {
      // Attack unit: path close and hit
      let maxD = (e.utype==='villager' && t.utype==='sheep') ? SHEEP_HARVEST_RANGE : 1.5; // slaughter from the ring, see maxDist above
      // A melee swing can't cross a SEALED wall corner: if the target sits
      // diagonally across a corner whose BOTH orthogonal tiles are
      // impassable, there's no line to strike through — same no-corner-cut
      // rule movement uses (ignoreUnits: terrain/walls, not units).
      let cornerBlocked=false;
      { let ex=Math.round(e.x),ey=Math.round(e.y),tx=Math.round(t.x),ty=Math.round(t.y);
        let dx=tx-ex,dy=ty-ey;
        if(dx&&dy&&!walkable(ex+dx,ey,e.id,true)&&!walkable(ex,ey+dy,e.id,true))cornerBlocked=true; }
      if(d>maxD){
        if (e.stance === 'standground' && !e.explicitAttack) {
          e.target = null;
          return;
        }
        // Approach to strike range: findPath stops at the nearest reachable
        // in-range (adjacent) tile, so a group rings the target naturally and
        // an overflow attacker (no free adjacent tile reachable) gets an empty
        // path → combatApproach disengages and retargets it.
        if(!combatApproach(e,t,d,null,maxD)) return;
      } else if(cornerBlocked){
        if (e.stance === 'standground' && !e.explicitAttack) {
          e.target = null;
          return;
        }
        // Adjacent but no clear line (sealed corner): step to a clear adjacent
        // tile — the plain to-target path redirects around the corner.
        if(!combatApproach(e,t,d,()=>pathUnitTo(e,Math.round(t.x),Math.round(t.y)))) return;
      } else {
        // In range: press tight against the target (see pressToContact) so
        // attackers pack into a ring instead of standing a tile back, then
        // strike on cooldown. contactDist 0.7 >= separateUnits' minDist so a
        // mobile target isn't shoved out of its own surround.
        pressToContact(e, t.x, t.y, 0.7);
        if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      }
    }
  }
}


  // Walking toward a building (or a ram — riders) to garrison inside it
// Returns true when the tick is fully handled (walking to / entering
// shelter); false when the shelter order dissolved and the tick continues.
function updateGarrisonWalk(e){
  let b=e.garrisonTarget?entitiesById.get(e.garrisonTarget):null;
  // canGarrisonIn re-validates eligibility per WALKER (not just container
  // state): a ram only admits melee infantry — without this, any unit
  // handed the task boarded on arrival (enterGarrison checks capacity only).
  if(!b||!canGarrisonIn(b,e.team,e)||b.garrisonedIn||garrisonCount(b)>=garrisonCap(b)){
    e.task=null;e.garrisonTarget=null; // savedTask (if any) resumes next tick
  } else if(b.type==='unit' ? dist(e,b)<=1.45 : inContact(e.x,e.y,b,1.45)){
    // Arrival: contact with the entrance — 1.45 accepts diagonal corner tiles.
    // A unit container (ram) is a point → plain distance.
    enterGarrison(e,b);
    return true;
  } else if(e.path.length===0&&retryReady(e,RETRY.GARRISON)){
    // A ram MOVES between re-paths: chase its current tile (riders are faster
    // than the ram, so the pursuit converges). A building: cheapest-to-walk
    // entrance via goalBldg (path once, queue carries it).
    if(b.type==='unit') pathUnitTo(e,Math.round(b.x),Math.round(b.y));
    else pathToContact(e,b);
    if(e.path.length===0){
      // Entrance likely crowded with other garrisoning villagers — keep
      // trying a few rounds (10t apart) before abandoning shelter.
      if(retryFail(e,RETRY.GARRISON,T30(10),6)){e.task=null;e.garrisonTarget=null;}
    } else {
      retryClear(e,RETRY.GARRISON);
    }
  }
  // Still heading for shelter: stop here — falling through would let the
  // full-carry check flip a loaded villager to 'return', sending it on a
  // drop-off run through the raid instead of into the TC. But the unit
  // must still WALK (the shared movement step lives further down), so
  // step it here.
  if(e.task==='garrison'){
    if(e.path.length>0) stepUnitAlongPath(e, unitMoveSpeed(e) * UNIT_PX_PER_TICK, true);
    return true;
  }
  return false;
}

  // Follow: keep tracking a moving friendly unit (AoE2-style "Follow" order).
  // Re-paths toward its current position periodically rather than once, since
  // the destination keeps changing. Suspended while in combat (!e.target) —
  // followId survives clearUnitPath, so the chase logic below owns pathing
  // during a fight and follow resumes once the target is gone.
function updateFollowOrder(e){
  // Drives the FOLLOW and ESCORT orders — the shared walking leg.
  let fid = (e.order && (e.order.kind==='follow' || e.order.kind==='escort')) ? e.order.id : null;
  if(!(fid && !e.target))return;
  let f=entitiesById.get(fid);
  if(!f||f.hp<=0){
    if(e.order && e.order.kind==='follow' && e.order.id===fid){
      // A CONVOY follow (gx/gy stamped by execUnitCommand) carries its own
      // destination: the leader dying must not drop the player's move order
      // for the whole group — finish the march as a plain move.
      if(e.order.gx!=null) issueMoveOrder(e, e.order.gx, e.order.gy);
      else e.order=null;
    }
    // (a dead ESCORTEE is converted to a frozen ground post by the
    // handleDeath sweep — not cleared here)
  } else {
    // Station = the followed unit PLUS this follower's formation offset
    // (order.x/y, assigned at command time from the group's arrangement —
    // 0,0 for offset-less orders, e.g. the AI's ram-surplus riders): a big
    // group holds its shape around the leader instead of every follower
    // chasing the leader's exact tile in a dogpile.
    // INTERCEPT, don't chase: project the leader ~4 tiles ahead along its
    // own path so followers cut the corner toward where it's GOING —
    // pathing to its live tile meant equal-speed followers never closed
    // and the convoy only assembled on arrival (user caught the
    // scattered march). A stopped leader projects to itself (exact).
    let lead=f.path&&f.path.length?f.path[Math.min(3,f.path.length-1)]:f;
    let sx=Math.max(0,Math.min(MAP-1,Math.round(lead.x)+(e.order.x||0)));
    let sy=Math.max(0,Math.min(MAP-1,Math.round(lead.y)+(e.order.y||0)));
    // A CONVOY follow (gx stamped) is ONE-SHOT: once the leader settles,
    // the march is over — hand the follower a plain move to its station,
    // which clears itself on arrival. A standing follow here meant moving
    // the ex-leader alone later dragged every former follower along
    // (deliberate click-to-follow orders have no gx and persist).
    if(e.order.gx!=null && !f.target && !(f.path&&f.path.length) && !(f.order&&f.order.kind==='move')){
      issueMoveOrder(e,sx,sy);
      return;
    }
    let d=dist(e,{x:sx,y:sy});
    if(d>1.5){
      // Re-path when idle OR when the station has drifted well away from
      // this walk's goal — a follower otherwise finishes its ENTIRE stale
      // muster path before ever consulting the moving station (the
      // convoy's scattered-march dominator).
      let goal=e.path.length?e.path[e.path.length-1]:null;
      let stale=goal&&Math.abs(goal.x-sx)+Math.abs(goal.y-sy)>3;
      if((e.path.length===0||stale) && retryReady(e,RETRY.FOLLOW)){
        retryStamp(e,RETRY.FOLLOW,T30(12));
        pathUnitTo(e,sx,sy);
      }
    } else if(e.path.length>0){
      // Close enough — stop walking but keep following so we resume if it moves away.
      e.path=[];e.moveT=0;e.fromX=e.x;e.fromY=e.y;
    }
  }
}

  // Multi-leg pathing: if the current task/target-free move order only got a
  // partial route last time (far-off destination, blocked by obstacles, etc.),
  // automatically continue toward the original goal once the current leg ends,
  // instead of silently stopping partway like a stuck/unresponsive order.
function resumeMultiLegMove(e){
  if(!(e.path.length===0 && e.order && e.order.kind==='move' && !e.target && !e.task))return;
  let atGoal = Math.round(e.x)===e.order.x && Math.round(e.y)===e.order.y;
  if(atGoal){
    e.order=null; // move order complete/unreachable
  } else if(retryReady(e,RETRY.MOVE)){
    retryStamp(e,RETRY.MOVE,T30(10)); // own key — never alias with the garrison stamp
    let goalX=e.order.x, goalY=e.order.y;
    pathUnitTo(e,goalX,goalY);
    if(e.path.length===0){
      // No progress possible from here; stop retrying every frame.
      e.order=null; // move order complete/unreachable
    }
  }
}

  // Melee & Ranged units: halt walking path as soon as we step within attack range of our target,
  // or periodically re-path if the moving target has shifted away from our current path's endpoint.
function adjustTargetApproach(e){
  if(!(e.target && !e.task))return;
  let t=entitiesById.get(e.target);
  if(t && t.hp>0){
    let range = UNITS[e.utype]?.range || 0;
    // Sheep (live or carcass): SHEEP_HARVEST_RANGE so the whole ring of
    // villagers around it can reach — see the constant's note.
    let maxDist = range > 0 ? range :
      (e.utype==='villager' && (t.utype==='sheep' || t.utype==='sheep_carcass')) ? SHEEP_HARVEST_RANGE : 1.5;
    
    let inRange = false;
    if (range > 0) {
      inRange = distToTarget(e, t) <= maxDist;
    } else {
      if (t.type === 'building') {
        inRange = adjToBuilding(e.x, e.y, t);
      } else {
        inRange = distToTarget(e, t) <= maxDist;
      }
    }

    if(inRange){
      clearUnitPath(e);
    } else if(t.type==='unit' && tick % 15 === 0 && e.path.length > 0){
      let endTile = e.path[e.path.length - 1];
      let ddx = endTile.x - t.x, ddy = endTile.y - t.y;
      let dToDest = Math.sqrt(ddx*ddx + ddy*ddy);
      if(dToDest > 1.5){
        pathUnitTo(e, Math.round(t.x), Math.round(t.y));
      }
    }
  }
}

  // Sheep behavior (AoE2-style)
function updateSheepBehavior(e){
  if(e.utype!=='sheep')return;
  e.eatTicks = e.eatTicks || 0;
  if(e.eatTicks > 0){
    e.eatTicks--;
    e.eatingGrass = true;
  } else {
    e.eatingGrass = false;
  }

  if(e.path.length===0 && !e.eatingGrass){
    // Periodically stop to eat grass (approx. every 4-8 seconds)
    if(tick % SHEEP_EAT_EVERY === 0 && simRandom() < 0.4){
      e.eatTicks = simRandInt(T30(60), T30(120));
    }
    // Or wander around locally in tiny steps (within 1 tile)
    else if(tick % SHEEP_WANDER_EVERY === 0 && simRandom() < 0.25){
      let wx=Math.round(e.x)+simRandInt(-1,1);
      let wy=Math.round(e.y)+simRandInt(-1,1);
      if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
        pathUnitTo(e,wx,wy);
      }
    }
  }

  // Convert/steal sheep (AoE2): an opposing unit within 5 tiles converts it
  // unless a friendly unit (other than sheep) is closer. 3-tick id-stagger
  // (perf). WRAPPED, not an early return — the sheep branch falls through
  // to the shared movement step below, which must still walk the wander path.
  if((tick+e.id)%3===0){
    let closest=closestUnitNear(e,5,en=>isPlayerTeam(en.team));
    if(closest && !sameSide(closest.team, e.team)){
      let guarded = false;
      if (isPlayerTeam(e.team)) {
        let guardDist = dist(e,closest);
        guarded = !!closestUnitNear(e,guardDist,en=>sameSide(en.team,e.team)); // allied guards protect too
      }
      if(!guarded){
        e.team=closest.team;
        clearUnitPath(e);
      }
    }
  }
}

  // Bear behavior (AoE2 wolf logic): a leashed ambush predator, NOT generic
  // military AI — it has its own aggro/give-up rules instead of the
  // isMilitary auto-attack below (which never stops chasing).
function updateBearBehavior(e){
  if(e.utype!=='bear')return;
  if(e.homeX===undefined){e.homeX=e.x;e.homeY=e.y;}
  let home={x:e.homeX,y:e.homeY};

  if(e.target){
    // Give up the chase when the prey dies/escapes or the bear has been
    // pulled too far from its den, then trot home. AoE2 wolves leash the
    // same way, which is what makes them dodgeable by design.
    let t=entitiesById.get(e.target);
    if(!t||t.hp<=0||t.garrisonedIn||dist(e,t)>10||dist(e,home)>14){
      e.target=null;
      clearUnitPath(e);
      pathUnitTo(e,Math.round(home.x),Math.round(home.y));
      // Leash hysteresis: no re-aggro until the bear is back near its den —
      // else a bear parked at the leash limit with prey in range flip-flops
      // between "charge" and "trot home" every scan.
      e.leashCooling=true;
    }
  } else {
    if(e.leashCooling && dist(e,home)<4) e.leashCooling=false;
    // Aggro: charge the closest player/AI unit that wanders into range.
    // Sheep are ignored (AoE2 wolves don't hunt herdables) and the check
    // runs on a stagger so 5 bears don't all scan every tick.
    if(!e.leashCooling && tick%10===e.id%10){
      let closest=closestUnitNear(e,5.5,en=>isPlayerTeam(en.team));
      if(closest){
        e.target=closest.id;
        clearUnitPath(e);
        if(window.playSound)window.playSound('bear',e.x,e.y);
      }
    }
    // Idle: slow wander around the den, like the sheep but ranging wider
    // and always drifting back toward home.
    if(!e.target&&e.path.length===0&&tick%BEAR_WANDER_EVERY===0&&simRandom()<0.3){
      let wx=Math.round(home.x)+simRandInt(-3,3);
      let wy=Math.round(home.y)+simRandInt(-3,3);
      if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
        pathUnitTo(e,wx,wy);
      }
    }
  }
}

function dropPathIfInPosition(e){
  if(e.path.length===0)return;
  // A combat unit can reach attack position BEFORE its path runs out (a
  // siege spot behind the wall, a chase overshooting a stopped foe) —
  // walking the leftover path then strands it in attack range yet not
  // attacking, jammed on the stale goal. If already in position, drop the
  // path now and let the combat block strike this same tick.
  if(e.target && e.task!=='return'){
    let ct=entitiesById.get(e.target);
    if(ct && ct.hp>0){
      let inPos = ct.type==='building'
        ? adjToBuilding(e.x,e.y,ct)
        : distToTarget(e,ct) <= ((UNITS[e.utype]?.range||0)>0 ? UNITS[e.utype].range : 1.5);
      if(inPos){ clearUnitPath(e); }
    }
  }
}

// The dispatcher gates on path.length>0 and ends the tick after the step.
function walkUnitPath(e){
  // Leash mid-leg too (see enforceChaseLeash): a chase path toward a
  // stationary foe never re-enters the combat block until the leg ends.
  if(enforceChaseLeash(e)){
    // fall through with the freshly-planted return path this tick
  }
  // Shared stepping math (stepUnitAlongPath, js/pathfinding.js) — the
  // guest's between-sync walker uses the same function, so host and
  // guest can never drift apart on movement. checkWalkable=true: only
  // the host's tick keeps the block grid current.
  stepUnitAlongPath(e, unitMoveSpeed(e) * UNIT_PX_PER_TICK, true);
}

// THE per-unit tick dispatcher. Each stage is either a hard early-out
// (returns end the tick) or a fall-through helper; the ORDER is load-bearing
// and mirrors the original monolith exactly:
//   guards → garrison walk → cooldowns → follow → multi-leg → target
//   approach → species (sheep/bear/cart) → in-position path drop → THE
//   movement step (returns whenever a path exists — everything after only
//   runs on an empty path) → combat → villager work → auto-scout → idle
//   military. Entry conditions live HERE so the mutual-exclusion structure
//   is visible in one screen. Cooldown decrements stay inline: they must
//   tick before combat/gather reads but NOT for garrisoned units (the
//   early-outs above skip them).
function updateUnit(e){
  if(e.hp<=0)return;
  if(e.garrisonedIn)return; // inside a building/ram: no movement, tasks, or combat
  // Riders track the ram they're inside: their parked x/y would otherwise go
  // stale as it moves, skewing fog contribution and the eject anchor.
  if(e.utype==='ram'&&e.garrison&&e.garrison.length){
    for(let gi=0;gi<e.garrison.length;gi++){
      let u=entitiesById.get(e.garrison[gi]);
      if(u){u.x=e.x;u.y=e.y;u.fromX=u.x;u.fromY=u.y;}
    }
  }
  // Targets that garrisoned mid-fight become unattackable — drop them.
  if(e.target){
    let t=entitiesById.get(e.target);
    if(t&&t.garrisonedIn)e.target=null;
  }
  if(e.utype==='villager' && !e.target && e.savedTask && e.task!=='garrison'){
    restoreSavedTask(e);
  }
  if(e.task==='garrison' && updateGarrisonWalk(e)) return;
  e.atkCooldown=Math.max(0,e.atkCooldown-1);
  e.gatherCooldown=Math.max(0,e.gatherCooldown-1);

  updateFollowOrder(e);

  resumeMultiLegMove(e);

  adjustTargetApproach(e);

  updateSheepBehavior(e);

  updateBearBehavior(e);

  // Trade cart routing: sets the path for the current leg (to a Market) and
  // delivers gold on arrival. Falls through to the shared movement step below,
  // which walks whatever path this set. Carts have no target/gather task, so
  // the combat and villager blocks below skip them.
  if(e.utype==='tradecart'){
    updateTradeCart(e);
  }

  dropPathIfInPosition(e);
  if(e.path.length>0){ walkUnitPath(e); return; }

  if(e.target && e.task !== 'return'){ updateUnitCombat(e); return; }

  if(e.utype==='villager'&&e.task){
    if(e.task==='build'&&e.buildTarget){ updateVillagerBuild(e); return; }
    if(e.task==='return'){ updateVillagerDropoff(e); return; }
    if(e.carrying>=e.carryMax){
      e.prevTask=e.task;e.task='return';return;
    }
    if(GATHER_TASKS[e.task]){
      let gcfg=GATHER_TASKS[e.task];
      // AoE2: a PARTIAL load of a DIFFERENT resource is lost at retask.
      // Drop it the moment the new task is active — not at the first
      // extraction (gatherFromTile's guard) — so the carry visual matches
      // the new assignment while the villager walks over (user caught the
      // stale carry read). A FULL mismatched load still banks first via
      // the return-then-resume above: kinder than AoE2, long established.
      if(e.carrying>0&&e.carryType&&e.carryType!==gcfg.resource){
        e.carrying=0;e.carryType=null;
      }
      updateGatherTask(e,gcfg);
    }
  }
  if(e.order && e.order.kind==='scout' && e.utype==='scout'){ updateAutoScoutTick(e); return; }
  updateIdleMilitary(e);
}

// Per-tick cache of gather-tile claims per team (tile key = x + y*MAP).
// Claims granted mid-tick are added as findNearTile hands them out, so
// several villagers reassigned in the same tick still fan out; claims
// RELEASED mid-tick linger until next tick — merely conservative. The set
// includes the asking villager's own claim — harmless: findNearTile is only
// called to pick a NEW tile, and the fallback pass ignores claims entirely.
// Dual-keyed on tick AND simGen (see registerSimCache, js/core.js) so a
// rollback resim can never be served claims from the abandoned timeline.
let gatherClaimTick=-1, gatherClaimGen=-1, gatherClaims=[null,null];
registerSimCache(()=>{gatherClaimTick=-1;gatherClaims=[null,null];});
function claimedGatherSet(team){
  if(gatherClaimTick!==tick||gatherClaimGen!==simGen){gatherClaimTick=tick;gatherClaimGen=simGen;gatherClaims=[null,null];}
  if(!gatherClaims[team]){
    let s=new Set();
    entities.forEach(en=>{
      if(en.type==='unit'&&en.team===team&&en.gatherX>=0)
        s.add(en.gatherX+en.gatherY*MAP);
    });
    gatherClaims[team]=s;
  }
  return gatherClaims[team];
}

function findNearTile(e,terrain,excludeList=null,anchor=null,noClaim=false){
  // Search origin: normally the unit itself, but callers can pass an `anchor`
  // (e.g. a drop-off) to find the resource tile nearest THAT point instead —
  // so an AI villager works beside its camp/TC (short round trips) rather than
  // whatever patch is nearest to wherever it's standing. Validity/claim checks
  // still use the real unit e.
  // noClaim=true: probe only (existence/reachability check) — do NOT
  // reserve the tile in the per-tick claim set. Assigners probe several
  // candidates per villager (assignAIGatherTask's tileFor); claiming each
  // falsely saturates the set and pushes later villagers to farther
  // patches. Only the FINAL assigned tile should claim.
  let bx=anchor?Math.round(anchor.x):Math.round(e.x),by=anchor?Math.round(anchor.y):Math.round(e.y);
  let best=null,bd=999;
  let claimed=claimedGatherSet(e.team);
  // Two-stage search: the cheap 12-radius ring first (the normal "work near
  // the drop site" case), then a wide 28-radius pass ONLY if that found
  // nothing — a hard 12 cap idled whole towns once the near forest was
  // chopped out. AoE2 villagers walk.
  let scan=(rLo,rHi)=>{
  // Ring-only scan: each radius pass visits just the new perimeter instead
  // of rescanning the whole (2r+1)² square — the first radius that yields a
  // hit returns the same nearest tile, at O(r²) total instead of O(r³).
  for(let r=rLo;r<rHi;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(excludeList && excludeList.includes(nx+ny*MAP))continue; // e.avoid array (see avoidAdd)
        // Unexplored tiles are not candidates — the map-truth scan must not
        // "discover" resources through fog (information parity, all teams).
        if(tileHiddenForTeam(e.team, ny*MAP+nx))continue;
        if(!canGatherTile(e,terrain,nx,ny))continue;
        if(claimed.has(nx+ny*MAP))continue; // skip claimed tiles
        let d=Math.abs(dx)+Math.abs(dy);
        if(d<bd){bd=d;best={x:nx,y:ny};}
      }
    }
    if(best){if(!noClaim)claimed.add(best.x+best.y*MAP);return best;}
  }
  return null;
  };
  let hit=scan(0,12);
  if(hit)return hit;
  // If all tiles are claimed, fall back to any available tile (excluding completely blocked ones)
  for(let r=0;r<12;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(excludeList && excludeList.includes(nx+ny*MAP))continue; // e.avoid array (see avoidAdd)
        if(tileHiddenForTeam(e.team, ny*MAP+nx))continue; // same explored gate as the main scan
        if(!canGatherTile(e,terrain,nx,ny))continue;
        let d=Math.abs(dx)+Math.abs(dy);
        if(d<bd){bd=d;best={x:nx,y:ny};}
      }
    }
    if(best){if(!noClaim)claimed.add(best.x+best.y*MAP);return best;}
  }
  // Nothing (free OR claimed) within 12: the near patch is exhausted —
  // widen to 28 before giving up (see the two-stage comment above).
  return scan(12,28);
}

// Delete/Backspace key (js/input.js, host/single-player path directly;
// js/commands.js's 'delete-units' case for the queued command) — a
// player deliberately killing their OWN unit/building (AoE2 has this too,
// e.g. to free population cap or cancel a mis-placed foundation).
function deleteOwnedEntity(en){
  // AoE2: deleting an UNFINISHED foundation refunds its cost (mis-click
  // recovery / quick-wall cancel). Completed buildings and units refund
  // nothing. A stone upgrade-in-progress is a normal foundation too — it
  // cancels and refunds its (new) cost like any other. (Slight over-refund if a
  // gate/tower consumed wall tiles for a stone discount — in the player's favor,
  // acceptable.)
  if(en.type==='building'&&!en.complete&&!en.exhausted){
    refundCost(en.team, BLDGS[en.btype].cost); // the OWNING team's resources, not always team 0's
    // Feedback belongs to the OWNER's screen only — under lockstep both
    // peers execute this for either team's delete commands.
    feedbackFor(en.team, () => showMsg(BLDGS[en.btype].name+' cancelled (refunded)'));
  }
  en.hp=0;
  // Self-delete has no enemy killer — attribute to GAIA (neutral), not a
  // hardcoded team 1, so any kill/score attribution reading killerTeam is correct.
  handleDeath(en,GAIA_TEAM);
}

function handleDeath(e,killerTeam){
  // Guard-order conversion sweep (same pattern as the shepherd retarget
  // below): an ESCORTEE dying freezes each escort into a ground post at the
  // spot it fell — "guard this thing" degrades to "guard where it fell",
  // never a silent release mid-battle. A guarded BUILDING dying converts
  // its watchers to ground posts at their own assigned perimeter tiles.
  if(e.type==='unit'||e.type==='building'){
    let fx=Math.round(e.x), fy=Math.round(e.y);
    for(let gi=0;gi<entities.length;gi++){
      let g=entities[gi], o=g.order;
      if(!o||g.hp<=0)continue;
      if(o.kind==='escort'&&o.id===e.id) g.order={kind:'guard',x:fx,y:fy};
      else if(o.kind==='guardBuilding'&&o.id===e.id) g.order={kind:'guard',x:o.x,y:o.y};
    }
  }
  // Riders survive a destroyed ram (AoE2: units pop out of the wreck) —
  // unlike a building's garrison, which perishes with it below.
  if(e.type==='unit'&&e.garrison&&e.garrison.length>0){
    ejectGarrison(e);
  }
  // (Raid danger zones are stamped at HIT time — the RAID LEARNING branch
  // in damageEntity — not here at death.)
  if(e.type==='unit'&&e.utype==='sheep'){
    e.utype = 'sheep_carcass';
    e.hp = 100;
    e.maxHp = 100;
    e.speed = 0;
    e.team = GAIA_TEAM; // neutral resource — a player team here would gain pop/vision/threat side effects
    clearUnitPath(e);
    if (window.playSound) window.playSound('sheep', e.x, e.y);
    selected=selected.filter(s=>s.id!==e.id);
    return;
  }
  if(e.type==='building'){
    // AoE2: queued units were prepaid (queueUnit) — refund them when the
    // building dies or is deleted. (Research dying unrefunded with its
    // host building is intentional — see execResearch, js/commands.js.)
    if(e.queue&&e.queue.length>0&&isPlayerTeam(e.team)){
      // Refund what was actually paid: a free rescue villager (unitTrainCost)
      // refunds nothing, so losing the TC with one queued can't mint resources.
      e.queue.forEach((utype,i)=>refundCost(e.team, unitTrainCost(e.team, utype, e.queue.slice(0,i))));
      e.queue=[];
    }
    // Units garrisoned inside a destroyed building perish with it (AoE2 rule)
    if(e.garrison&&e.garrison.length>0){
      let ids=e.garrison.slice();e.garrison=[];
      ids.forEach(id=>{
        let u=entitiesById.get(id);
        if(u){u.garrisonedIn=undefined;u.hp=0;handleDeath(u,killerTeam);}
      });
    }
    let b=BLDGS[e.btype];
    for(let dy=0;dy<e.h;dy++)for(let dx=0;dx<e.w;dx++){
      if(e.y+dy<MAP&&e.x+dx<MAP){map[e.y+dy][e.x+dx].occupied=null;markMapDirty(e.x+dx,e.y+dy);
        if(b.isFarm)map[e.y+dy][e.x+dx].t=TERRAIN.GRASS;}
    }
    if(e.btype==='TC'){
      // Victory condition: each team has exactly ONE Town Center and it
      // cannot be rebuilt — losing it is the knockout (AoE2-flavored
      // regicide-on-the-TC). teamEliminated() below remains a fallback for
      // no-TC-left edge cases. The match ends when the surviving teams are
      // all one alliance (checkAllianceVictory). isPlayerTeam keeps gaia
      // TCs (hypothetical) from ever ending the game.
      if(isPlayerTeam(e.team)){
        defeatedTeams[e.team]=true;
        // The human's TC falling means DEFEAT for them — but if an allied
        // team still stands, the match keeps running and they spectate the
        // ally's fight (players like to watch). checkAllianceVictory ends
        // the game the moment their whole SIDE is out (which in 1v1 is
        // immediately), so no forced gameOver here.
        if(e.team===localHumanTeam&&!window.__resim){
          let allyAlive=false;
          for(let t=0;t<NUM_TEAMS;t++)if(t!==e.team&&sameSide(t,e.team)&&!defeatedTeams[t])allyAlive=true;
          showMsg(allyAlive?'Your Town Center has fallen — you are defeated! Spectating your ally\u2026'
                           :'Your Town Center has fallen — you are defeated!');
        }
        else if(sameSide(e.team,localHumanTeam)&&e.team!==localHumanTeam&&!window.__resim)showMsg('Your ally has been knocked out!');
        checkAllianceVictory();
      }
    }
  }
  // Death blood burst — bigger than the per-hit spatter, marks the kill.
  // Bears get a heavier burst to match their bulk.
  // (wooden vehicles are excluded: they break apart in wood splinters
  // instead — see drawTradeCartCorpse / drawRamCorpse in js/render-units.js)
  if(e.type==='unit'&&!isHarmlessAnimal(e)&&!isWoodVehicle(e)){
    spawnParticles(e.x,e.y,'#990000',e.utype==='bear'?12:7,0.05,1.8);
  }
  // Death/destruction audio (host side; the guest hears the same via its
  // new-corpse sync hook in js/net-sync.js). Fog + stereo pan are handled
  // inside playSound.
  if(window.playSound){
    // Foundations are excluded: deleting an unfinished foundation is a
    // refund/cancel action, not a demolition — silence is right there.
    if(e.type==='building'&&e.complete) window.playSound('collapse', e.x+(e.w||1)/2, e.y+(e.h||1)/2);
    // Bears growl their own death; humans get the death cry.
    else if(e.type==='unit'&&e.utype==='bear') window.playSound('bear', e.x, e.y);
    else if(e.type==='unit'&&isWoodVehicle(e)) window.playSound('collapse', e.x, e.y); // timber breaking apart, not a human cry
    else if(e.type==='unit'&&!isHarmlessAnimal(e)) window.playSound('death', e.x, e.y);
  }
  // Add to corpses list for AoE2-style decay (sheep are the exception —
  // they become a harvestable carcass entity instead, handled above)
  if(e.type==='unit'&&!isHarmlessAnimal(e)){
    let corpse = {
      type: 'corpse',
      utype: e.utype,
      x: e.x,
      y: e.y,
      team: e.team,
      id: e.id,
      facing: e.facing || 1,
      dir: e.dir, // vehicles wreck in their death facing (corpseVehicleAxes)
      female: e.female, // villagers keep their hairdo in death
      carrying: e.carrying || 0, // trade cart: gold spills from the wreck on the loaded leg
      // Wall-clock is safe here ONLY because corpses are cosmetic: nothing
      // in the sim ever reads them (render/save only, see simChecksum's
      // exclusions). Sim state must use `tick`, never performance.now().
      deathTime: performance.now(),
      deathTick: tick // headless-only tick-based prune (js/loop.js); render still fades by deathTime
    };
    corpses.push(corpse);
  }
  // Shepherd continuity: when a carcass is consumed, EVERY villager that
  // was harvesting it moves on to the nearest remaining carcass or own/gaia
  // sheep within herding range — not just the one whose bite finished it.
  // Runs before the removal below so `e` is excluded naturally by the hp
  // gate. Deterministic: villagers in entities order, nearest pick, id ties.
  if(e.utype==='sheep_carcass'){
    entities.forEach(v=>{
      if(v.type!=='unit'||v.utype!=='villager'||v.target!==e.id)return;
      let next=null,best=12;
      entities.forEach(en=>{
        if(en.id===e.id||en.hp<=0)return;
        let isCarc=en.utype==='sheep_carcass';
        let isSheep=en.utype==='sheep'&&(en.team===v.team||en.team===GAIA_TEAM);
        if(!isCarc&&!isSheep)return;
        let d2=dist(v,en);
        if(d2<best||(d2===best&&next&&en.id<next.id)){best=d2;next=en;}
      });
      v.target=next?next.id:null;
      if(next)clearUnitPath(v);
    });
  }
  selected=selected.filter(s=>s.id!==e.id);
  entities=entities.filter(en=>en.id!==e.id);
  entitiesById.delete(e.id);
  // Conquest victory (AoE2): a team is defeated when it has nothing left —
  // no buildings and no units (sheep don't count, they change hands).
  if(isPlayerTeam(e.team)){
    for(let t=0;t<NUM_TEAMS;t++){
      if(!defeatedTeams[t]&&teamEliminated(t))defeatedTeams[t]=true;
    }
    checkAllianceVictory();
  }
}

// The match ends when every non-defeated player team is on ONE side.
// `won` stays binary "did team 0's side win" (didIWin inverts for the
// guest, js/core.js) — everyone-defeated is a loss for team 0 too. Pure
// function of the defeatedTeams flags, so simultaneous defeats within a
// tick resolve deterministically no matter the marking order.
function checkAllianceVictory(){
  if(gameOver)return;
  // Scenario editor: Play is a sandbox — never declare victory/defeat (no
  // banner, no See-Map), so the fight keeps going past any elimination and
  // you can watch it play all the way out. Inert in a real game (__editorMode
  // is unset there → checksum unchanged).
  if(window.__editorMode)return;
  // A defeat must have actually happened: the conquest hook calls this on
  // EVERY player-entity death, and a match where all teams share one
  // alliance (sandbox/testing) would otherwise end on the first casualty,
  // since the survivors trivially form a single side.
  if(!defeatedTeams.some(Boolean))return;
  let alive=new Set();
  for(let t=0;t<NUM_TEAMS;t++){
    if(!defeatedTeams[t])alive.add(allianceOf(t));
  }
  if(alive.size<=1){
    gameOver=true;
    won=alive.size===1&&alive.has(allianceOf(0));
  }
}

function teamEliminated(team){
  return !entities.some(en=>en.team===team&&
    (en.type==='building'||(en.type==='unit'&&!isHarmlessAnimal(en))));
}

// ---- STUCK-UNIT WATCHDOG ----
// DIAGNOSTIC TRIPWIRE over EVERY task/path state machine, host-only, and
// strictly REPORT-ONLY — it never alters gameplay. Each task loop is designed
// to either progress or clear itself (blocked steps clear the path; repath
// branches give up after bounded retries), so a unit that stays "busy"
// (path/task/target/buildTarget) with its ENTIRE observable state frozen for 8
// game-seconds is a BUG in one of those loops. The watchdog exists only to
// SURFACE it — a console.warn (counted as health.watchdogFires in the headless
// sim), never a reset. Fix the root instead: chase the warning to the wedged
// state machine and make it progress or give up on its own.
//
// Legitimate stationary-busy states never trip it because their signature
// keeps changing (gathering increments `carrying`; fighting cycles the
// path/target as combat repositions) or they're exempted (deliberate
// drop-off waits, garrisoned units, wildlife) — the exemptions keep the log
// honest so a real freeze stands out.
const STUCK_WATCHDOG_TICKS = T30(240);   // 8 game-seconds
const GARRISON_HEAL_EVERY = T30(45);  // +1 hp per 1.5 game-seconds while garrisoned
const STUCK_CHECK_EVERY = T30(30);       // sample once per game-second
// Watch state lives ON the unit (e.stuck = {sig, since}) — plain sim data,
// so it rides lockstep snapshots, resync payloads, and save files with zero
// dedicated plumbing. Recomputed deterministically each tick from hashed state;
// it steers no gameplay (report-only), but detEntityHash still covers it so
// peers' watch state stays in lockstep. Dead units take their entry with them —
// no side-table, no pruning pass.
function updateStuckWatchdog(){
  if (tick % STUCK_CHECK_EVERY !== 0) return;
  entities.forEach(e => {
    if (e.type !== 'unit' || e.hp <= 0 || e.garrisonedIn) return;
    if (e.utype === 'sheep' || e.utype === 'sheep_carcass' || e.utype === 'bear') return;
    let busy = e.path.length > 0 || e.task || e.target || e.buildTarget;
    if (!busy) { e.stuck = undefined; return; }
    if (e.task === 'return' && retryActive(e,RETRY.DROP_WAIT)) { e.stuck = undefined; return; } // deliberate wait
    // Actively fighting: a unit that landed a hit within the window is
    // making progress even if its target's SAMPLED hp looks flat (a wall an
    // enemy repairs in step). A genuinely wedged unit never gets to swing.
    if (e.lastAtkTick != null && tick - e.lastAtkTick < STUCK_WATCHDOG_TICKS) { e.stuck = undefined; return; }
    // Builder deliberately waiting for its footprint to clear (AoE2: a build
    // can't START until everyone's off the site — updateVillagerBuild gates the
    // first buildProgress on this). A legitimate wait, not a wedge: own units
    // auto-clear in a few ticks, and an enemy camping the site makes the builder
    // WAIT (AoE2), not abandon the job.
    if (e.buildTarget) {
      let wb = entitiesById.get(e.buildTarget);
      if (wb && wb.type === 'building' && !wb.complete && wb.buildProgress === 0 && footprintOccupiedByOther(wb)) {
        e.stuck = undefined; return;
      }
    }
    // The TARGET's hp / build progress is part of the signature: a
    // stationary attacker or builder is making progress exactly when its
    // target's state is changing (including damage dealt by teammates —
    // a second-rank melee unit waiting for a slot in a live fight is fine).
    let tgt = e.target ? entitiesById.get(e.target) : null;
    let bt = e.buildTarget ? entitiesById.get(e.buildTarget) : null;
    let sig = [Math.round(e.x * 20), Math.round(e.y * 20), e.task, e.target, e.buildTarget,
      e.carrying, e.path.length, e.gatherX, e.gatherY, e.garrisonTarget,
      tgt ? tgt.hp : '', bt ? (bt.buildProgress || 0) + '_' + bt.hp : ''].join('|');
    if (!e.stuck || e.stuck.sig !== sig) { e.stuck = { sig, since: tick }; return; }
    if (tick - e.stuck.since >= STUCK_WATCHDOG_TICKS) {
      // REPORT-ONLY: never touches gameplay, only logs. A freeze that reaches
      // here is a state-machine BUG — fix it at the ROOT; do NOT reset the unit
      // (that hides the cause and is itself interference). The warn, counted as
      // health.watchdogFires (tools/sim.html), makes any freeze a loud,
      // reproducible report; re-arm the timer so a persistent freeze re-warns
      // once per window, not every tick.
      console.warn('[stuck-watchdog] STUCK unit', e.id, e.utype,
        'task=' + e.task, 'target=' + e.target, 'path=' + e.path.length,
        'buildTarget=' + e.buildTarget + (bt ? ('(' + bt.btype + '@' + bt.x + ',' + bt.y + ' prog=' + (bt.buildProgress||0) + '/' + bt.buildTime + ' complete=' + bt.complete + ')') : ''),
        'gather=' + e.gatherX + ',' + e.gatherY, 'retry=' + JSON.stringify(e.retry||null),
        'at', e.x.toFixed(1) + ',' + e.y.toFixed(1));
      e.stuck.since = tick;
    }
  });
}

function findSpawnTile(x,y,maxRadius=4,taken=null){
  // Ring-only per radius so the NEAREST free tile wins (raster order over a
  // full square can pick a tile up to maxRadius-1 away first). `taken` lets
  // one call site spread a batch (e.g. ejectGarrison) across distinct tiles.
  for(let r=0;r<maxRadius;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
    if(taken&&taken.has((x+dx)+','+(y+dy)))continue;
    if(walkable(x+dx,y+dy))return{x:x+dx,y:y+dy};
  }
  return null;
}

// ---- BUILDING TICK (dispatcher) ----
// Mirrors the updateUnit split; the ORDER is load-bearing. Farm reseed is
// the only pre-complete logic; research returning true PAUSES the training
// queue for the tick (the classic AoE2 advance-vs-villagers tension). NOT
// here, by design: gate open/close (updateGates, js/loop.js), construction
// progress (villager-side, updateVillagerBuild), farm growth/depletion
// (gatherer-side, updateGatherTask).
function updateBuilding(e){
  updateBuildingFarmReseed(e);
  if(!e.complete)return;
  updateBuildingArrows(e);
  // Garrisoned units slowly heal while sheltered
  if (garrisonCount(e) > 0 && tick % GARRISON_HEAL_EVERY === 0) {
    e.garrison.forEach(id => {
      let u = entitiesById.get(id);
      if (u && u.hp > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + 1);
    });
  }
  if(updateBuildingResearch(e))return; // research pauses the queue
  updateBuildingTraining(e);
}

function updateBuildingFarmReseed(e){
  if (e.btype === 'FARM' && e.exhausted) {
    // AI auto-reseed — AI-controlled teams only. A human team (local or
    // remote) manages reseeding manually (js/ui.js's prepayFarm/
    // reactivateFarm) — auto-spending their wood behind their back would
    // be surprising and remove their control over the decision.
    if (isAITeam(e.team)) {
      let store = resourceStore(e.team);
      if (store && store.wood >= 60) {
        store.wood -= 60;
        e.exhausted = false;
        e.complete = true;
        e.hp = e.maxHp;
        let tile = map[e.y][e.x];
        tile.t = TERRAIN.FARM;
        tile.res = farmFoodFor(e.team);
        markMapDirty(e.x,e.y);
      }
    }
  }
}

function updateBuildingArrows(e){
  // Tower / TC arrow fire (defensive structures auto-fire)
  if (firesArrows(e.btype)) {
    e.atkCooldown = Math.max(0, (e.atkCooldown || 0) - 1);
    if (e.atkCooldown <= 0) {
      let range = BLDGS[e.btype].range; // AoE2: TC range 6, Watch Tower 8
      let center = centerOf(e);
      // Scan only the unit-grid cells within range (targetableUnitGrid,
      // cell=4) instead of the whole entities array (perf: peacetime
      // towers at cooldown 0 rescan every tick). Candidate set matches a
      // full scan (the grid holds exactly live, non-garrisoned, non-sheep
      // units; hp/garrison re-checks below cover units killed earlier THIS
      // tick). `entities` order is ascending-id, so the (d, id) tiebreaks
      // below reproduce a full-scan order bit-for-bit.
      let inRange = [];
      let grid = targetableUnitGrid(), c = UNIT_GRID_CELL;
      let gcx = (center.x / c) | 0, gcy = (center.y / c) | 0, gcr = Math.ceil(range / c) + 1;
      for (let gy = gcy - gcr; gy <= gcy + gcr; gy++) {
        if (gy < 0 || gy >= unitGridNY) continue;
        for (let gx = gcx - gcr; gx <= gcx + gcr; gx++) {
          if (gx < 0 || gx >= unitGridNX) continue;
          let cell = grid[gx * unitGridNY + gy];
          if (!cell || cell.length === 0) continue;
          for (let k = 0; k < cell.length; k++) {
            let en = cell[k];
            if (en.hp <= 0 || en.garrisonedIn) continue;
            if (en.team === GAIA_TEAM || sameSide(en.team, e.team)) continue;
            let d = dist(center, en);
            if (d <= range) inRange.push({en, d});
          }
        }
      }
      if (inRange.length > 0) {
        // AoE2 garrison-arrow model (openage .../game_mechanics/garrison.md):
        // extra arrows = floor(Σ garrisoned pierce-DPS / building DPS).
        // Villagers count as a fixed 2.5 dps (≈ +1 TC arrow each); ranged
        // pierce units contribute atk/reload; MELEE units add NOTHING — they
        // garrison for safety, not firepower. One deliberate deviation from
        // AoE2: the base arrow stays even ungarrisoned (AoE2's TC default is
        // 0) — an unmanned TC that can't shoot at all felt wrong here.
        // Capped by per-building maxArrows (BLDGS: TC 10, TOWER 5, PTOWER 3).
        let bDps = e.atk / (T30(60) / TPS); // this building's own arrow dps (fires every 2 game-s)
        let gDps = 0;
        if (e.garrison) for (let gi = 0; gi < e.garrison.length; gi++) {
          let g = entitiesById.get(e.garrison[gi]);
          if (!g) continue;
          if (g.utype === 'villager') gDps += 2.5;
          // rof lives on the UNITS def, not the entity (atk IS stamped, with upgrades)
          else if ((g.range || 0) > 0 && g.atk > 0) gDps += g.atk / (UNITS[g.utype].rof / TPS);
        }
        let maxArrows = BLDGS[e.btype].maxArrows || 5;
        let arrows = Math.min(maxArrows, 1 + Math.floor(gDps / bDps));
        if (arrows > 1) {
          inRange.sort((a, b) => a.d - b.d || a.en.id - b.en.id); // deterministic (d, id) tiebreak
        } else {
          // One arrow: a min-scan beats a full sort. (d, id) keeps the
          // lowest-id target on ties (deterministic).
          let best = 0;
          for (let i = 1; i < inRange.length; i++) {
            if (inRange[i].d < inRange[best].d || (inRange[i].d === inRange[best].d && inRange[i].en.id < inRange[best].en.id)) best = i;
          }
          if (best !== 0) { let t = inRange[0]; inRange[0] = inRange[best]; inRange[best] = t; }
        }
        let bCenter = {
          id: e.id,
          type: 'building',
          btype: e.btype,
          x: center.x,
          y: center.y,
          team: e.team,
          atk: e.atk // AoE2: both TC and Watch Tower deal 5 pierce (set from BLDGS in createBuilding)
        };
        for (let i = 0; i < arrows; i++) {
          spawnProjectile(bCenter, inRange[i % inRange.length].en);
        }
        e.atkCooldown = T30(60); // fire every 2 game-seconds (AoE2 TC/tower reload)
      }
    }
  }
}


  // Research: while active, the building's unit queue (if any) is
  // PAUSED. target is a numeric age index (age advancement — the one place
  // teamAge advances) OR a string tech key (applyTech runs its one-time stat
  // sweep; live-read effects key off the teamTechs bit via hasUpgrade).
// Returns true while research is active (the tick is consumed — training
// pauses), false when there is none.
function updateBuildingResearch(e){
  if(!e.research)return false;
    let target=e.research.target;
    let isAge=typeof target==='number';
    let ticks=isAge?AGES[target].researchTicks:UPGRADES[target].researchTicks;
    e.research.tick++;
    if(e.research.tick>=ticks){
      if(isAge){
        teamAge[e.team]=target;
        // TEMP (AUTO_APPLY_TECHS_AT_AGE): free auto-grant of the new age's techs,
        // in registry order — the original behavior while paid manual research
        // is tuned. Live-read effects key off the teamTechs bit via hasUpgrade.
        let cardNames=AUTO_APPLY_TECHS_AT_AGE?applyAgeUpgrades(e.team,target):[];
        // AoE2-style power-spike aggression: an AI that just advanced presses
        // its (freshly bumped) army — controlAIMilitary reads this stamp.
        if(AI_STATES&&AI_STATES[e.team])AI_STATES[e.team].lastAgeUpTick=tick;
        if(e.team===myTeam){
          showMsg('You have advanced to the '+AGES[target].name+'!'+
            (cardNames.length?' Gained: '+cardNames.join(', ')+'.':''));
          if(window.playSound)playSound('victory');
        }
      }else{
        applyTech(e.team,target); // one-time sweep + set the teamTechs bit
        if(e.team===myTeam){
          showMsg(UPGRADES[target].name+' researched!');
          if(window.playSound)playSound('build');
        }
      }
      e.research=undefined;
      if(typeof updateUI==='function')updateUI();
    }
  return true;
}

function updateBuildingTraining(e){
  if(e.queue.length>0){
    let u=UNITS[e.queue[0]];
    if(e.trainTick<u.trainTime)e.trainTick++;
    if(e.trainTick>=u.trainTime){
      if(!hasPopulationRoom(e.team,e.queue[0],false))return;
      let spawn=findSpawnTile(e.x+e.w,e.y+e.h) || findSpawnTile(e.x,e.y);
      if(!spawn){
        if(e.team===myTeam && tick % SHEEP_EAT_EVERY === 0){ // msg throttle (~6 game-s), reuses the cadence const
          showMsg("Spawn point blocked! Clear area near " + BLDGS[e.btype].name);
        }
        return;
      }
      e.trainTick=0;
      let ut=e.queue.shift();
      let unit=createUnit(ut,spawn.x,spawn.y,e.team);

      if (e.team === myTeam && window.playSound) { // myTeam, not 0: on the host they're equal, and the guest completion path (js/net-sync.js) mirrors this gate
        window.playSound('train');
      }
      rallyNewUnit(e, unit);
    }
  }
}

// Rally handling for a freshly trained unit: garrison-into-rally-building
// first (AoE2: spawn directly inside, no walking), else the rally
// auto-command (trade route / build-assign / attack / gather / plain move).
function rallyNewUnit(e, unit){
      // Rally point set on a garrisonable own building (including this one):
      // the fresh unit appears directly inside it, AoE2-style — no walking.
      // NOTE: this runs as part of the HOST's per-tick building-queue
      // processing for EVERY building regardless of team — `myTeam` is NOT
      // a per-entity perspective signal here, so the rally feature applies
      // to ALL player teams (the guest sets rally points too).
      if(unit && isPlayerTeam(e.team) && e.rallyX!==undefined && e.rallyY!==undefined){
        let rallyB=null;
        if(e.rallyTargetId){
          let t=entitiesById.get(e.rallyTargetId);
          if(t&&t.type==='building'&&canGarrisonIn(t,unit.team))rallyB=t;
        } else {
          let tx=Math.floor(e.rallyX), ty=Math.floor(e.rallyY);
          if(ty>=0&&ty<MAP&&tx>=0&&tx<MAP&&map[ty][tx].occupied){
            let t=entitiesById.get(map[ty][tx].occupied);
            if(t&&canGarrisonIn(t,unit.team))rallyB=t;
          }
        }
        if(rallyB&&garrisonCount(rallyB)<garrisonCap(rallyB)){
          enterGarrison(unit,rallyB);
          if(typeof updateUI==='function')updateUI();
          return;
        }
      }

      // Auto-command the unit based on building's rally point — same
      // "both player teams, not myTeam" reasoning as the block above.
      if(unit && isPlayerTeam(e.team) && e.rallyX!==undefined && e.rallyY!==undefined){
        // Fresh MILITARY units anchor at their rally flag (AoE2-style) —
        // meaningful only to DEFENSIVE stance (scoped acquire + leash); an
        // implicit guard POST here would leash every rally-spawned soldier
        // regardless of stance ("aggressive army walks home after
        // attacking"). HUMAN teams only: the AI drives its units via raw
        // target writes.
        if(guardEligible(unit) && !isAITeam(e.team)){
          unit.defendX=e.rallyX; unit.defendY=e.rallyY;
        }
        if(e.rallyTargetId){
          let target=entitiesById.get(e.rallyTargetId);
          if(target){
            if(unit.utype==='tradecart'&&target.type==='building'&&target.btype==='MARKET'&&target.complete&&target.hp>0&&target.team!==unit.team&&isPlayerTeam(target.team)){
              // Rallied onto a foreign Market: auto-start a trade route from
              // the spawning Market (home) to it.
              let home=nearestMarket(unit,true);
              if(home){
                unit.tradeDestId=target.id; unit.tradeHomeId=home.id; unit.tradePhase='toDest';
                pathToContact(unit,target);
              } else {
                pathUnitTo(unit,e.rallyX,e.rallyY);
              }
            } else if(unit.utype==='villager'&&target.type==='building'&&!target.complete&&target.team===e.team){
              unit.task='build';
              unit.buildTarget=target.id;
              pathUnitTo(unit,target.x,target.y);
            } else if(unit.utype!=='tradecart' && !sameSide(target.team,e.team) && target.team!==GAIA_TEAM){
              // Rally onto an ENEMY BUILDING: fresh units attack it AS IF given
              // an explicit attack order (assignAttack, js/commands.js) —
              // explicitAttack drives the mop-up continuation when it falls, and
              // the anchor moves to the target so a DEFENSIVE-stance unit leashes
              // to the battlefield, not back to the rally flag. Buildings only —
              // execRally snaps a flag dropped on a unit to the ground tile under
              // it. Trade carts never take attack targets.
              unit.target=target.id;
              unit.explicitAttack=true;
              unit.defendX=Math.round(target.x); unit.defendY=Math.round(target.y);
              pathUnitTo(unit,target.x,target.y);
            } else {
              pathUnitTo(unit,e.rallyX,e.rallyY);
            }
          } else {
            // Rallied entity is gone (destroyed/removed) — fall back to the
            // plain rally coordinates instead of silently leaving the unit idle.
            pathUnitTo(unit,e.rallyX,e.rallyY);
          }
        } else if(e.rallyResourceType!==undefined&&e.rallyResourceType!==null&&unit.utype==='villager'){
          let resNames={[TERRAIN.FOREST]:'chop',[TERRAIN.GOLD]:'mine_gold',[TERRAIN.STONE]:'mine_stone',[TERRAIN.BERRIES]:'forage',[TERRAIN.FARM]:'farm'};
          let task=resNames[e.rallyResourceType];
          if(task){
            unit.task=task;
            let cfg=GATHER_TASKS[task];
            let gx=e.rallyX, gy=e.rallyY;
            let rtile=map[gy]&&map[gy][gx];
            if(!rtile||rtile.t!==cfg.terrain||rtile.res<=0||!canGatherTile(unit,cfg.terrain,gx,gy)){
              // The flagged resource is exhausted/blocked: send the fresh
              // villager to the nearest tile of the SAME type — searched
              // around the rally point first (where the player pointed),
              // then around the spawn — instead of marching it to a dead tile.
              let alt=findNearTile({x:gx,y:gy,team:unit.team},cfg.terrain)
                   ||findNearTile(unit,cfg.terrain);
              if(alt){gx=alt.x;gy=alt.y;}
            }
            unit.gatherX=gx;
            unit.gatherY=gy;
            // Fan out onto DISTINCT contact tiles (goalBldg + contactClaims,
            // like updateGatherTask) so units rallied onto a resource surround
            // it instead of piling on the nearest tile.
            pathToContact(unit, {x:gx, y:gy, w:1, h:1}, contactClaims(unit, p=>p.gatherX===gx && p.gatherY===gy));
          }
        } else {
          pathUnitTo(unit,e.rallyX,e.rallyY);
        }
      }
}
