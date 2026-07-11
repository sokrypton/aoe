// ---- GAME LOGIC ----
function canPlace(type,x,y,team=0){
  // Age gate — sim-authoritative (binds humans, relayed guests, and AI).
  if(!isUnlocked(team,type))return false;
  let b=BLDGS[type];
  let bw=b.w, bh=b.h;
  let ox=x, oy=y;
  if(isGateBtype(type)){
    // A gate can ONLY be placed on an existing run of allied wall tiles of
    // the MATCHING material (palisade gate on palisade, stone on stone).
    // gateFootprint picks the run (prefers 3-tile, falls back to 2) — use it
    // here so placement validation checks EXACTLY the tiles that get built.
    let wallB = GATE_WALL_MATCH[type];
    let isWall = (tx, ty) => !!entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === wallB && en.team === team);
    ({ ox, oy, gw: bw, gh: bh } = gateFootprint(x, y, isWall));
    if (bw === 1 && bh === 1) return false; // no matching wall run to build on
  }
  for(let dy=0;dy<bh;dy++)for(let dx=0;dx<bw;dx++){
    let nx=ox+dx,ny=oy+dy;
    if(nx<0||nx>=MAP||ny<0||ny>=MAP)return false;
    // Can't build on unexplored tiles — but ONLY ever checked for team 0,
    // not `team===myTeam` (tried that, reverted — see comment). `fog` is
    // only ever valid for whichever team updateFog() actually computed on
    // the machine currently running this code. The host's own machine
    // ALWAYS computes team 0's fog every tick (myTeam is 0 there); when
    // executing the other player's command via withCommandContext, myTeam
    // gets temporarily swapped to 1 for the callback, but the underlying
    // `fog` data itself is NOT recomputed for team 1 at that moment — it's
    // still team 0's snapshot. `team===myTeam` inside that swapped
    // callback would compare team 1's placement against team 0's fog,
    // incorrectly blocking legitimate guest builds in areas team 0 hasn't
    // scouted (caught by an actual two-browser-context build test, not
    // code review — the host would silently refuse a placement the guest
    // could clearly see and had every right to build on).
    // Deterministic explored-rule, symmetric per team (teamExploredGrid is
    // sim state computed identically on every peer — js/core.js). AI teams
    // keep their historic exemption (their "vision" is proximity-based,
    // not fog-based — js/ai.js); humans must have explored the tile.
    if(tileHiddenForTeam(team, ny*MAP+nx))return false;
    let t=map[ny][nx];
    if(t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)return false;
    if(t.occupied){
      let existing = entitiesById.get(t.occupied);
      // GATE, TOWER, and a STONE WALL upgrade may be placed on top of an
      // existing allied wall (they consume the wall tile(s) they're built on,
      // see execBuildPlacement's wallsToRemove); anything else, including
      // another palisade, must not overlap an existing building. Stone-on-
      // palisade lets you reinforce a wooden wall in place (an upgrade you
      // build, mirroring how a gate is built over walls).
      if (existing && existing.type === 'building' && existing.team === team &&
          ((isGateBtype(type) && existing.btype === GATE_WALL_MATCH[type]) ||
           (isTowerBtype(type) && isWallBtype(existing.btype)) ||
           (type === 'SWALL' && existing.btype === 'WALL'))) {
        continue;
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
    // previous tile, so comparing against the last one suffices (the old
    // tiles.some() scan was O(n²) per wall drag).
    let last = tiles[tiles.length - 1];
    if (!last || last.x !== tx || last.y !== ty) {
      tiles.push({x: tx, y: ty});
    }
  }
  return tiles;
}


const RES_KEYS={f:'food',w:'wood',g:'gold',s:'stone'};
// cooldown is ticks (30/game-second) per 1 resource gathered, tuned to AoE2
// base gather rates: wood ~0.39/s, gold ~0.38/s, stone ~0.36/s, farm ~0.32/s,
// forage ~0.31/s.
const GATHER_TASKS={
  chop:{terrain:TERRAIN.FOREST,resource:'wood',cooldown:77,clearOccupied:true},
  mine_gold:{terrain:TERRAIN.GOLD,resource:'gold',cooldown:79},
  mine_stone:{terrain:TERRAIN.STONE,resource:'stone',cooldown:83},
  farm:{terrain:TERRAIN.FARM,resource:'food',cooldown:94,clearOccupied:true,removeFarm:true,requiresOwnCompleteFarm:true},
  forage:{terrain:TERRAIN.BERRIES,resource:'food',cooldown:97}
};

// Range at which a villager can slaughter a sheep / harvest a carcass. Must be
// >= the diagonal tile spacing (~1.41) so the whole RING of neighbours around
// the carcass can eat at once, not just the one villager standing on its tile:
// distToTarget is centre-to-centre, so an orthogonally-adjacent villager is 1.0
// away and a diagonal one 1.41 — both beyond the old 0.9, which left every
// villager after the first stuck out of range, "chasing" forever, jamming the
// approach and tripping the stuck-watchdog (the classic whole-crew-on-one-sheep
// opening was quietly broken for AI and human alike).
const SHEEP_HARVEST_RANGE=1.5;

function resourceStore(team){
  return resources[team];
}

function resourceName(key){
  return RES_KEYS[key]||key;
}

function canAfford(team,cost){
  let store=resourceStore(team);
  return Object.entries(cost||{}).every(([key,amount])=>store[resourceName(key)]>=amount);
}

function spendCost(team,cost){
  let store=resourceStore(team);
  Object.entries(cost||{}).forEach(([key,amount])=>{store[resourceName(key)]-=amount;});
}

function formatCost(cost){
  return Object.entries(cost||{}).map(([key,amount])=>key.toUpperCase()+':'+amount).join(' ');
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

function canQueueUnit(bldg,utype){
  if(!isUnlocked(bldg.team,utype))return {ok:false,reason:'age'};
  if(!hasPopulationRoom(bldg.team,utype,true))return{ok:false,reason:'pop'};
  if(!canAfford(bldg.team,UNITS[utype].cost))return{ok:false,reason:'resources'};
  return{ok:true};
}

function queueUnit(bldg,utype){
  let check=canQueueUnit(bldg,utype);
  if(!check.ok)return check;
  spendCost(bldg.team,UNITS[utype].cost);
  bldg.queue.push(utype);
  return check;
}

// Viewer-local convenience cache of MY team's population for the HUD —
// any per-team read (AI planning, UI compare) goes through
// teamPopUsed/teamPopCap directly with an explicit team.
function refreshPopulationCounts(){
  popUsed=teamPopUsed(myTeam);
  popCap=teamPopCap(myTeam);
}

// AoE2 drop-off rule: the TC accepts every resource, other buildings only
// the kinds listed in their BLDGS drop spec (mill: food, camps: their own).
function dropAccepts(b,resType){
  return b.btype==='TC'||(BLDGS[b.btype].drop&&BLDGS[b.btype].drop.split(',').includes(resType));
}

function nearestDrop(e,resType,excludeIds=null){
  let best=null,bd=999;
  entities.forEach(b=>{
    if(b.type!=='building'||b.team!==e.team||!b.complete)return;
    if(excludeIds && excludeIds.includes(b.id))return; // e.avoid array (see avoidAdd)
    if(dropAccepts(b,resType)){
      // Euclidean footprint distance (distToTarget), matching the approach/
      // arrival logic — ranking by Manhattan distToBuilding could pick a
      // drop site that's actually a longer diagonal walk away.
      let d=distToTarget(e,b);
      if(d<bd){bd=d;best=b;}
    }
  });
  return best;
}

function dist(a,b){let dx=a.x-b.x,dy=a.y-b.y;return Math.sqrt(dx*dx+dy*dy)}

// ---- PER-TICK SPATIAL INDEX (perf) ----
// Coarse grid over targetable units (non-sheep/carcass, alive, not
// garrisoned), rebuilt at most once per tick and shared by every proximity
// scan that used to walk the whole entities array per scanning unit —
// auto-attack acquisition, sheep conversion, bear aggro. Late-game that was
// O(units × entities) per tick. Entries are live references, so positions
// read at query time are current even if a unit moved after the grid was
// built (units move far less than a cell per tick); hp/garrison are
// re-checked at query time so mid-tick deaths can't be targeted.
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
function retryReady(e,key){
  let r=e.retry&&e.retry[key];
  return !r||tick>=r.next;
}
// Guard-on-unit/building (execGuard, js/commands.js): keeps a MOVING post
// synced to the guarded target's live position — an escort's post rides on
// the unit it guards. If the target dies (or garrisons away), the post
// FREEZES at its last synced spot and becomes a plain ground post.
function syncGuardPost(e){
  if (e.guardTargetId == null) return;
  let t = entitiesById.get(e.guardTargetId);
  if (t && t.hp > 0 && !t.garrisonedIn && sameSide(t.team, e.team)) {
    if (t.type === 'unit') { e.guardX = t.x; e.guardY = t.y; }
  } else {
    e.guardTargetId = null;
  }
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
function avoidHas(e,key,v){return !!(e.avoid&&e.avoid[key]&&e.avoid[key].includes(v));}
function avoidClear(e,key){
  if(e.avoid&&e.avoid[key]){delete e.avoid[key];if(Object.keys(e.avoid).length===0)e.avoid=undefined;}
}

const UNIT_GRID_CELL=4;
// Dual-keyed on tick AND simGen (see registerSimCache, js/core.js): entries
// are live entity references, so serving a pre-rollback grid after a restore
// hands out orphaned objects from the abandoned timeline.
let unitGridTick=-1, unitGridGen=-1, unitGrid=new Map();
registerSimCache(()=>{unitGridTick=-1;});
function targetableUnitGrid(){
  if(unitGridTick===tick&&unitGridGen===simGen)return unitGrid;
  unitGridTick=tick;unitGridGen=simGen;
  unitGrid.clear();
  entities.forEach(en=>{
    if(en.type!=='unit'||en.hp<=0||en.garrisonedIn)return;
    if(en.utype==='sheep'||en.utype==='sheep_carcass')return;
    let key=((en.x/UNIT_GRID_CELL)|0)*4096+((en.y/UNIT_GRID_CELL)|0);
    let a=unitGrid.get(key);
    if(!a)unitGrid.set(key,a=[]);
    a.push(en);
  });
  return unitGrid;
}
// Closest grid unit to `e` strictly within `range` that passes `pred`.
function closestUnitNear(e,range,pred){
  let grid=targetableUnitGrid();
  let c=UNIT_GRID_CELL;
  let cx=(e.x/c)|0, cy=(e.y/c)|0, cr=Math.ceil(range/c)+1;
  let closest=null, closestD=range;
  for(let gy=cy-cr;gy<=cy+cr;gy++){
    if(gy<0)continue;
    for(let gx=cx-cr;gx<=cx+cr;gx++){
      if(gx<0)continue;
      let a=grid.get(gx*4096+gy);
      if(!a)continue;
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
    // geometric footprint spans [x-0.5, x+w-0.5]. Measuring against
    // [x, x+w] (as before) overhangs the far sides by a full tile.
    let dx=Math.max(b.x-0.5-a.x, 0, a.x-(b.x+b.w-0.5));
    let dy=Math.max(b.y-0.5-a.y, 0, a.y-(b.y+b.h-0.5));
    return Math.sqrt(dx*dx+dy*dy);
  }
  return dist(a,b);
}

function buildingAtTile(x,y,filter){
  return entities.find(en=>{
    if(en.type!=='building')return false;
    return x>=en.x&&x<en.x+en.w&&y>=en.y&&y<en.y+en.h&&(!filter||filter(en));
  })||null;
}

function farmAtTile(x,y,team,requireComplete=true){
  return buildingAtTile(x,y,en=>
    en.btype==='FARM'&&en.team===team&&(!requireComplete||en.complete)
  );
}

function canGatherTile(e,terrain,x,y){
  if(terrain===TERRAIN.FARM)return !!farmAtTile(x,y,e.team,true);
  // AI wildlife avoidance: tiles inside a live danger zone (a bear mauled a
  // villager there — see the fleeBear reflex below) are ungatherable for
  // that team until the zone expires. Humans manage their own safety.
  let ai=AI_STATES&&AI_STATES[e.team];
  if(ai&&ai.dangerZones&&ai.dangerZones.length){
    for(let z of ai.dangerZones){
      if(tick>=z.until)continue;
      // Zone dies with its bear: a hunted bear frees the resource patch
      // immediately (this is what makes dispatching the hunt worthwhile).
      let bear=entitiesById.get(z.bearId);
      if(!bear||bear.hp<=0)continue;
      // Radius 4 around the mauling spot: big den-radius zones (tried at 8)
      // locked out whole resource regions and STARVED the team — worse than
      // the bear. Small zones stop the immediate re-tasking loop; the hunt
      // (js/ai.js huntAIBears) is what actually reclaims the area.
      if(Math.abs(x-z.x)<=4&&Math.abs(y-z.y)<=4)return false;
    }
  }
  return true;
}

// AoE2 formation speed-matching: units ordered as a GROUP move at the
// slowest member's pace (groupSpeed, stamped by execUnitCommand and AI wave
// launches) so scouts don't sprint ahead and arrive alone. Combat releases
// the cap: once a unit's own target is close it fights at full speed.
function unitMoveSpeed(e){
  if(e.groupSpeed&&e.groupSpeed<e.speed){
    if(e.target){
      let t=entitiesById.get(e.target);
      if(t&&distToTarget(e,t)<10){e.groupSpeed=undefined;return e.speed;}
    }
    if(!e.target&&e.path.length===0&&e.moveGoalX===undefined){e.groupSpeed=undefined;return e.speed;} // arrived
    return e.groupSpeed;
  }
  return e.speed;
}

// findPath() REDIRECTS unwalkable destinations to the nearest walkable
// tile within 20 — good for click-forgiveness, but it means "path.length>0"
// does NOT mean the destination is reachable. This asks the honest
// question: does a path exist that actually ENDS within `tol` of (tx,ty)?
// Every AI reachability probe must use this, or camps get founded in
// forest pockets no villager can ever enter (the walk 'succeeds' to a
// redirect point, the builder wedges, the watchdog frees it, the assigner
// re-offers the site — forever).
function pathReaches(sx,sy,tx,ty,ignore,tol=1.5){
  if(Math.abs(sx-tx)<=tol&&Math.abs(sy-ty)<=tol)return true;
  let p=findPath(sx,sy,tx,ty,ignore);
  if(p.length===0)return false;
  let last=p[p.length-1];
  if(Math.abs(last.x-tx)<=tol&&Math.abs(last.y-ty)<=tol)return true;
  // Iteration-capped partial path: A* ran out of BUDGET, not out of map.
  // A long path that closed most of the gap is a truncated route — treat
  // it as reachable (armies re-targeting the enemy TC from 60+ tiles away
  // were getting 'unreachable' and yo-yoing home forever). Short queries
  // (build/drop sites) always complete within budget, so the strict
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

// Check if unit is adjacent to a building (within 1.5 tiles of its nearest edge).
// Uses the same nearest-edge distance as distToTarget() — a prior per-perimeter-tile
// box test (|dx|<1.2 && |dy|<1.2) let units register as "adjacent" from up to
// ~1.7 tiles past the nearest edge near corners, well beyond intended melee reach.
// Perimeter tile centers sit 0.5 (orthogonal) to ~0.71 (diagonal corner) from
// the rect, so 1.2 accepts every true perimeter tile while rejecting the next
// ring out.
function adjToBuilding(px,py,bldg){
  return edgeDistToBuilding(px,py,bldg) <= 1.2;
}

// A guarding unit's "zone" = the thing it protects: {b: building} when
// escorting/guarding a building (measured to the whole footprint), else the
// {x,y} post point (ground post, or an escorted unit synced onto guardX/Y).
// guardZoneDist is the distance from a point to that zone. Shared by the
// leash (js/logic.js) and the aggro scope so they stay in lock-step on both
// the zone AND the GUARD_LEASH radius.
const GUARD_LEASH = 6;
function guardZoneOf(e){
  let gb = e.guardTargetId != null ? entitiesById.get(e.guardTargetId) : null;
  return (gb && gb.type === 'building') ? { b: gb } : { x: e.guardX, y: e.guardY };
}
function guardZoneDist(z, px, py){
  return z.b ? edgeDistToBuilding(px, py, z.b) : Math.hypot(px - z.x, py - z.y);
}

// Find nearest walkable tile adjacent to building perimeter. Optional
// `claimed` set (keys "x,y") lets a group of callers fan OUT around the
// footprint instead of all picking the one nearest tile — a claimed tile is
// only skipped while any unclaimed perimeter tile remains.
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


// AoE2-style siege spread: each melee attacker of a building claims its own
// perimeter tile, so a group fans out and surrounds the building instead of
// stacking up behind whichever tile happens to be nearest.
function siegePerimeterSpot(e,t){
  let claimed=new Set();
  entities.forEach(en=>{
    if(en!==e&&en.type==='unit'&&en.target===t.id&&en.siegeSpot){
      claimed.add(en.siegeSpot.x+','+en.siegeSpot.y);
    }
  });
  let best=null,bd=1e9;
  for(let dy=-1;dy<=t.h;dy++)for(let dx=-1;dx<=t.w;dx++){
    if(dx>=0&&dx<t.w&&dy>=0&&dy<t.h)continue;
    let tx=t.x+dx, ty=t.y+dy;
    if(tx<0||tx>=MAP||ty<0||ty>=MAP)continue;
    if(!walkable(tx,ty,e.id))continue;
    let d=Math.abs(e.x-tx)+Math.abs(e.y-ty);
    if(claimed.has(tx+','+ty))d+=100; // strongly prefer an unclaimed spot
    if(d<bd){bd=d;best={x:tx,y:ty};}
  }
  if(best){e.siegeSpot=best;return best;}
  return nearestBldgPerimeter(e.x,e.y,t,e.id);
}

// AoE2 DE-style group spread: when several villagers are tasked onto one
// resource tile, each claims its own tile of the same resource near the
// click instead of the whole group piling onto one tree. Rings expand from
// the clicked tile; within a ring the villager takes the tile closest to
// itself. If everything nearby is claimed, crowding the clicked tile is the
// correct fallback (AoE2 also lets villagers share a tile when it's all
// that's left).
function claimGatherTileNear(e,terrain,cx,cy){
  let claimed=new Set();
  entities.forEach(en=>{
    if(en.type==='unit'&&en.id!==e.id&&en.team===e.team&&en.gatherX>=0)
      claimed.add(en.gatherX+','+en.gatherY);
  });
  if(!claimed.has(cx+','+cy))return{x:cx,y:cy};
  for(let r=1;r<=5;r++){
    let best=null,bd=1e9;
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue; // ring only
      let nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=MAP||ny<0||ny>=MAP)continue;
      let t=map[ny][nx];
      if(t.t!==terrain||t.res<=0)continue;
      if(claimed.has(nx+','+ny))continue;
      if(!canGatherTile(e,terrain,nx,ny))continue;
      let d=Math.abs(e.x-nx)+Math.abs(e.y-ny);
      if(d<bd){bd=d;best={x:nx,y:ny};}
    }
    if(best)return best;
  }
  return{x:cx,y:cy};
}

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
      if(store&&((store.prepaidFarms||0)>0||store.wood>=60)){
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
      pathUnitTo(e,gatherTile.x,gatherTile.y);
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

  // Gathering audio: forage/farm only — they have no tool-swing animation,
  // so extraction time is the natural cadence. Chop/mine sounds moved to
  // the axe/pick's VISUAL impact in render-units.js (drawUnit), because the
  // first extraction lags the first visible swing by up to a full gather
  // cycle, which read as the sound starting late.
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
  // Find all actual unfinished building entities in the queue
  let unfinishedInQueue = e.buildQueue
    .map(id => entitiesById.get(id))
    .filter(bt => bt && (!bt.complete || bt.hp < bt.maxHp));

  if (unfinishedInQueue.length === 0) {
    // Look for any unfinished allied foundations nearby (within 25 tiles)
    let unfinished = entities.filter(en => en.type === 'building' && en.team === e.team && !en.complete);
    if (unfinished.length > 0) {
      unfinished.sort((a, b) => dist(e, a) - dist(e, b));
      if (dist(e, unfinished[0]) <= 25) {
        unfinishedInQueue.push(unfinished[0]);
      }
    }
  }

  if (unfinishedInQueue.length > 0) {
    // Nearest first, but pick the nearest one this builder can ACTUALLY REACH.
    // A foundation can be near in straight-line distance yet sealed off (wrong
    // side of a closing wall ring, boxed by other foundations) — assigning it
    // anyway makes the builder walk, fail, give up, get handed the same
    // nearest one again, and churn until the stuck-watchdog frees it. Skipping
    // unreachable ones breaks that loop and lets the builder fall through to a
    // reachable job / gathering.
    unfinishedInQueue.sort((a, b) => dist(e, a) - dist(e, b));
    let bt = null, pt = null;
    for (let cand of unfinishedInQueue) {
      let b = BLDGS[cand.btype];
      let cpt = b.isFarm ? {x: cand.x, y: cand.y} : nearestBldgPerimeter(e.x, e.y, cand, e.id);
      let close = b.isFarm ? dist(e,{x:cand.x+0.5,y:cand.y+0.5})<1.2 : adjToBuilding(e.x,e.y,cand);
      if (close || pathReaches(Math.round(e.x), Math.round(e.y), cpt.x, cpt.y, e.id)) { bt = cand; pt = cpt; break; }
    }
    if (bt) {
      e.buildQueue = unfinishedInQueue.map(b => b.id);
      e.task = 'build';
      e.buildTarget = bt.id;
      e.target = null;
      pathUnitTo(e, pt.x, pt.y);
      return true;
    }
  }

  e.buildQueue = [];
  return false;
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
  // AoE2 attack bonuses. The other classic counters need no bonus — they
  // emerge from the armor system: scouts beat archers because their 2 pierce
  // armor halves arrow damage, and militia beat spearmen on raw stats.
  if (attacker.utype === 'spearman' && (target.utype === 'scout' || target.utype === 'knight')) dmg += 15; // AoE2 spearman +15 vs cavalry
  if (attacker.utype === 'archer' && target.utype === 'spearman') dmg += 3; // AoE2 archer +3 vs spearman
  // Bonuses vs buildings (AoE2 building-class bonuses): there are no siege
  // units (even in Castle), so these are what let an army crack structures
  // at all now that buildings have real armor.
  if (target.type === 'building') {
    if (attacker.utype === 'villager') dmg += 3;
    if (attacker.utype === 'militia') dmg += 2;
    // The ram IS its building bonus: base atk 2 barely scratches a unit,
    // +110 vs structures tears through walls. Tuned so one ram's net DPS
    // (~20.8 hp/s after the wall's 8 melee armor, rof 150) clearly EXCEEDS a
    // villager's repair (~10 hp/s) — matching AoE2, where a ram out-damages a
    // repairer so a small siege force actually breaches instead of bouncing.
    // (At +70 a ram did only ~12.8 hp/s: two repairing villagers stalled it
    // forever, so no walled AI base ever fell — the finishing stalemate.)
    // Keep in sync with wallBreachTicks (ai.js).
    if (attacker.utype === 'ram') dmg += 110;
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

  // Play combat sound and spawn particles. Sheep (live or carcass) don't
  // get the steel clash — slaughtering livestock isn't a sword fight; the
  // bleat on death (handleDeath) is the sheep's own audio.
  if (target.type === 'unit') {
    if (window.playSound && !isHarmlessAnimal(target)) {
      window.playSound('attack', target.x, target.y);
    }
    spawnParticles(target.x, target.y, '#990000', 4, 0.04, 1.5);
  } else {
    if (window.playSound) window.playSound('build', target.x + (target.w||1)/2, target.y + (target.h||1)/2);
    spawnParticles(target.x + (target.w||1)/2, target.y + (target.h||1)/2, '#8b6c43', 3, 0.03, 2);
  }

  // Minimap raid alert: attacked player objects blink white for a moment
  // (drawMinimap reads this via teamColor()'s myTeam-relative logic), AoE2-
  // style. Not team-restricted here — this runs during the HOST's normal
  // per-tick processing of both teams every tick, so `myTeam` would be
  // constant (always 0) regardless of which team is actually being hit,
  // same trap as the rally-point bug — record it for either team
  // unconditionally, the READ side already filters to "mine" correctly.
  target.lastHitTick = tick;

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
    // `core` = the hit actually threatens the economy: a villager or the Town
    // Center itself. A hit on a peripheral WALL/other building is NOT core —
    // the AI garrison reaction (updateAIGarrisonReaction) must not hide the
    // whole workforce just because an army is poking the wall from outside a
    // ring it can't breach (that froze the eco forever = the Dark-Age stall).
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
  
  // Retaliation: attacked units fight back (not sheep, only opposing teams).
  // A unit actively carrying out a player move order (a path in progress, or
  // a pending multi-leg move goal — see updateUnit()) keeps obeying it
  // instead of being yanked into combat; e.g. a retreating soldier should
  // keep retreating. Note: a unit that's merely following another (but has
  // already caught up and stopped, path.length===0) isn't "mid-order" in
  // that sense and should still defend itself like any idle unit.
  // For a villager, walking is usually TASK-walking (to the tree, to the
  // drop-off) — that must not exempt it from defending itself, or gatherers
  // get stabbed mid-commute without reacting. Only an explicit player move
  // order (moveGoalX, set solely by issueMoveOrder) keeps a villager walking.
  let hasActiveMoveOrder = target.type==='unit' && (
    target.utype==='villager'
      ? target.moveGoalX!==undefined
      : (target.path.length>0 || target.moveGoalX!==undefined));
  // AoE2: villagers fight back against melee attackers — INCLUDING bears:
  // gatherers mob-retaliate as a group (five villagers beat a bear), which
  // sim testing showed is what actually keeps wildlife losses low. An
  // earlier flee-instead-of-fight reflex removed the group defense and
  // bears picked off the runners one at a time (bear speed 1.2 outruns
  // villager 0.8) — economies collapsed. They don't chase ranged attackers
  // (hopeless kiting) or buildings (tower/TC fire).
  let hopelessChase = target.utype==='villager' &&
    ((attacker.range||0)>0 || attacker.type==='building');
  // Wildlife bookkeeping (throttled): a mauled villager still calls in the
  // military hunt (huntAIBears, js/ai.js) and stamps a small danger zone so
  // the AI doesn't RE-TASK fresh gatherers onto the bear's patch while the
  // fight/hunt plays out. The zone dies with the bear (canGatherTile).
  if(target.utype==='villager'&&attacker.utype==='bear'&&retryReady(target,'fleeBear')){
    retryStamp(target,'fleeBear',90);
    target.fledBearId=attacker.id;
    let dzAi=AI_STATES&&AI_STATES[target.team];
    if(dzAi&&dzAi.dangerZones){
      dzAi.dangerZones=dzAi.dangerZones.filter(z=>{
        let b=entitiesById.get(z.bearId);
        return tick<z.until&&b&&b.hp>0;
      }).slice(-7);
      if(!dzAi.dangerZones.some(z=>z.bearId===attacker.id))
        dzAi.dangerZones.push({x:Math.round(attacker.x),y:Math.round(attacker.y),until:tick+6000,bearId:attacker.id});
    }
  }
  // Rams never retaliate (1-2 dmg vs units): turning to poke the militia
  // hacking at it just interrupts the wall it was ordered to break. Trade
  // carts can't fight at all (atk 0) — retaliating just made them chase
  // their attacker and bump into it uselessly.
  if(target.type==='unit'&&!isHarmlessAnimal(target)&&!isWoodVehicle(target)&&!sameSide(attacker.team,target.team)&&!hasActiveMoveOrder&&!hopelessChase){
    let shouldRetaliate = false;
    if(!target.target){
      shouldRetaliate = true;
    } else {
      let curT = entitiesById.get(target.target);
      // Switch target from buildings/sheep to focus the attacking soldier
      if(!curT || curT.type==='building'||curT.utype==='sheep'||curT.utype==='sheep_carcass'){
        shouldRetaliate = true;
      }
    }
    if(shouldRetaliate){
      // Save task details so they can resume after defending themselves
      if (target.utype === 'villager' && target.task && !target.savedTask) {
        target.savedTask = {
          task: target.task,
          gatherX: target.gatherX,
          gatherY: target.gatherY,
          buildTarget: target.buildTarget,
          buildQueue: target.buildQueue ? [...target.buildQueue] : [],
          prevTask: target.prevTask
        };
      }
      target.target = attacker.id;
      target.task = null; // drop gathering/farming/building tasks
      clearUnitPath(target);
    }
  }
  
  // Defend sieged buildings: when a building is hit, nearby idle military
  // (not passive, no current fight) converge on the attacker — matching how
  // units already retaliate when hit themselves.
  if(target.type==='building'&&!sameSide(attacker.team,target.team)){
    entities.forEach(en=>{
      if(en.type!=='unit'||!sameSide(en.team,target.team))return; // allies defend a sieged building too
      // non-combatants sit out: carts have atk 0, rams do 1-2 vs units
      if(!isSoldierUnit(en))return;
      if(en.target||en.task||en.stance==='passive')return;
      if(en.path.length>0||en.moveGoalX!==undefined)return; // obeying a move order
      if(distToTarget(en,target)>8)return;
      en.target=attacker.id;
    });
  }

  if(target.hp<=0) handleDeath(target, attacker.team);
}function autoTaskBuilder(e, bt){
  if(bt.btype==='FARM'){
    e.task='farm';
    e.gatherX=bt.x;
    e.gatherY=bt.y;
  } else if(bt.btype==='LCAMP'){
    let nearWood = findNearTile(e, TERRAIN.FOREST);
    if (nearWood) {
      e.task = 'chop';
      e.gatherX = nearWood.x;
      e.gatherY = nearWood.y;
      pathUnitTo(e, nearWood.x, nearWood.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MILL'){
    let nearBerries = findNearTile(e, TERRAIN.BERRIES);
    if (nearBerries) {
      e.task = 'forage';
      e.gatherX = nearBerries.x;
      e.gatherY = nearBerries.y;
      pathUnitTo(e, nearBerries.x, nearBerries.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MCAMP'){
    let nearGold = findNearTile(e, TERRAIN.GOLD);
    let nearStone = findNearTile(e, TERRAIN.STONE);
    let targetTile = null;
    let targetTask = null;
    if (nearGold && nearStone) {
      let dGold = Math.abs(nearGold.x - e.x) + Math.abs(nearGold.y - e.y);
      let dStone = Math.abs(nearStone.x - e.x) + Math.abs(nearStone.y - e.y);
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

function restoreSavedTask(e) {
  if (e.utype === 'villager' && e.savedTask) {
    e.task = e.savedTask.task;
    e.gatherX = e.savedTask.gatherX;
    e.gatherY = e.savedTask.gatherY;
    e.buildTarget = e.savedTask.buildTarget;
    e.buildQueue = e.savedTask.buildQueue;
    e.prevTask = e.savedTask.prevTask;
    e.savedTask = null;
    
    // Re-path them to their task!
    if (e.task === 'build' && e.buildTarget) {
      let bt = entitiesById.get(e.buildTarget);
      if (bt) {
        let b = BLDGS[bt.btype];
        let pt = b.isFarm ? {x: bt.x, y: bt.y} : (typeof nearestBldgPerimeter === 'function' ? nearestBldgPerimeter(e.x, e.y, bt, e.id) : {x: bt.x + bt.w, y: bt.y + bt.h});
        if (pt) pathUnitTo(e, pt.x, pt.y);
      }
    } else if (e.gatherX !== undefined && e.gatherX >= 0) {
      pathUnitTo(e, e.gatherX, e.gatherY);
    }
  }
}

// ---- GARRISON (AoE2-style town bell & building garrison) ----
function garrisonCap(b){return (b.btype&&BLDGS[b.btype].garrisonCap)||0;}
function garrisonCount(b){return b.garrison?b.garrison.length:0;}
function canGarrisonIn(b,team){
  return b.type==='building'&&b.team===team&&b.complete&&b.hp>0&&garrisonCap(b)>0;
}
function enterGarrison(e,b){
  b.garrison=b.garrison||[];
  if(b.garrison.length>=garrisonCap(b))return false;
  clearUnitPath(e);
  e.task=null;e.target=null;e.followId=undefined;e.garrisonTarget=null;
  // AoE2: garrisoning into a drop-off deposits the carried load on entry —
  // a belled villager banks its wood the moment it enters the TC. Buildings
  // that aren't a drop-off for the carried type (towers) don't; the villager
  // keeps the load while sheltered and drops it off after the all-clear.
  if(e.carrying>0&&e.carryType&&dropAccepts(b,e.carryType)){
    resourceStore(e.team)[e.carryType]+=e.carrying;
    e.carrying=0;
  }
  e.garrisonedIn=b.id;
  // Park the unit at the building's center so fog/minimap stay sane while hidden.
  e.x=b.x+b.w/2;e.y=b.y+b.h/2;e.fromX=e.x;e.fromY=e.y;
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
  // Tiles already handed out THIS call — unitBlock only rebuilds next tick,
  // so without this a full TC dumped all 15 units onto one tile and left
  // them to random separation shoving.
  let taken=new Set();
  b.garrison.forEach(id=>{
    let u=entitiesById.get(id);
    if(!u){return;}
    if(filter&&!filter(u)){keep.push(id);return;}
    let spawn=findSpawnTile(b.x+b.w,b.y+b.h,8,taken)||findSpawnTile(b.x-1,b.y-1,8,taken);
    if(spawn)taken.add(spawn.x+','+spawn.y);
    u.garrisonedIn=undefined;
    if(spawn){u.x=spawn.x+0.5;u.y=spawn.y+0.5;}
    u.fromX=u.x;u.fromY=u.y;
    clearUnitPath(u);
    // Leaving shelter re-pins the guard post to the drop spot: the pre-
    // garrison post is usually WHY the unit fled (a raid there), and the
    // idle return would otherwise auto-march it back through the attackers
    // with retaliation suppressed mid-path.
    if(u.guardX!=null) setGuardPost(u, Math.round(u.x), Math.round(u.y), false);
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
  let sent=0;
  entities.forEach(e=>{
    if(e.team!==team||e.type!=='unit'||e.utype!=='villager'||e.garrisonedIn)return;
    if(e.task==='garrison')return;
    let best=null,bd=Infinity;
    spots.forEach(s=>{
      if(s.room<=0)return;
      let d=distToBuilding(e.x,e.y,s.b);
      if(d<bd){bd=d;best=s;}
    });
    if(!best)return;
    best.room--;
    if(!e.savedTask&&(e.task||e.buildTarget||e.gatherX>=0)){
      e.savedTask={task:e.task,gatherX:e.gatherX,gatherY:e.gatherY,
        buildTarget:e.buildTarget,buildQueue:e.buildQueue,prevTask:e.prevTask};
    }
    e.target=null;e.followId=undefined;e.buildTarget=null;
    e.task='garrison';e.garrisonTarget=best.b.id;
    let pt=nearestBldgPerimeter(e.x,e.y,best.b,e.id);
    if(pt)pathUnitTo(e,pt.x,pt.y);
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
function nearestMarket(e, own){
  let best=null,bd=Infinity;
  entities.forEach(b=>{
    if(b.type!=='building'||b.btype!=='MARKET'||!b.complete||b.hp<=0)return;
    let match = own ? (b.team===e.team) : (b.team!==e.team && isPlayerTeam(b.team));
    if(!match)return;
    let d=distToTarget(e,b);
    if(d<bd){bd=d;best=b;}
  });
  return best;
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
  let homeOk = home&&home.type==='building'&&home.btype==='MARKET'&&home.complete&&home.hp>0&&home.team===e.team;
  let destOk = dest&&dest.type==='building'&&dest.btype==='MARKET'&&dest.complete&&dest.hp>0&&dest.team!==e.team&&isPlayerTeam(dest.team);
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
    if(e.tradePhase==='toDest'){
      // Load gold sized by the separation between the two Markets, head home.
      let g=Math.round(dist(home,dest)*TRADE_GOLD_PER_TILE);
      e.carrying=Math.max(1,g); e.carryType='gold';
      e.tradePhase='toHome';
      let pt=nearestBldgPerimeter(e.x,e.y,home,e.id);
      pathUnitTo(e,pt.x,pt.y);
    } else {
      resourceStore(e.team).gold += e.carrying;
      e.carrying=0; e.carryType=null;
      e.tradePhase='toDest';
      let pt=nearestBldgPerimeter(e.x,e.y,dest,e.id);
      pathUnitTo(e,pt.x,pt.y);
    }
  } else if(e.path.length===0){
    // Not there and no route queued (fresh order, or a blocked leg) — (re)path.
    let pt=nearestBldgPerimeter(e.x,e.y,goal,e.id);
    pathUnitTo(e,pt.x,pt.y);
  }
}

function updateUnit(e){
  if(e.hp<=0)return;
  if(e.garrisonedIn)return; // inside a building: no movement, tasks, or combat
  // Targets that garrisoned mid-fight become unattackable — drop them.
  if(e.target){
    let t=entitiesById.get(e.target);
    if(t&&t.garrisonedIn)e.target=null;
  }
  if(e.utype==='villager' && !e.target && e.savedTask && e.task!=='garrison'){
    restoreSavedTask(e);
  }
  // Walking toward a building to garrison inside it
  if(e.task==='garrison'){
    let b=e.garrisonTarget?entitiesById.get(e.garrisonTarget):null;
    if(!b||b.hp<=0||!b.complete||garrisonCount(b)>=garrisonCap(b)){
      e.task=null;e.garrisonTarget=null; // savedTask (if any) resumes next tick
    } else if((()=>{
      // Arrival check: like adjToBuilding but accepts diagonal corner
      // perimeter tiles (~1.41 from the footprint), which nearestBldgPerimeter
      // legitimately routes units to.
      let gdx=Math.max(b.x-0.5-e.x,0,e.x-(b.x+b.w-0.5));
      let gdy=Math.max(b.y-0.5-e.y,0,e.y-(b.y+b.h-0.5));
      return Math.sqrt(gdx*gdx+gdy*gdy)<=1.45;
    })()){
      enterGarrison(e,b);
      return;
    } else if(e.path.length===0&&retryReady(e,'garrison')){
      let pt=nearestBldgPerimeter(e.x,e.y,b,e.id);
      if(pt)pathUnitTo(e,pt.x,pt.y);
      if(e.path.length===0){
        // Entrance likely crowded with other garrisoning villagers — keep
        // trying a few rounds (10t apart) before abandoning shelter.
        if(retryFail(e,'garrison',10,6)){e.task=null;e.garrisonTarget=null;}
      } else {
        retryClear(e,'garrison');
      }
    }
    // Still heading for shelter: stop here. Falling through would let the
    // full-carry check below flip a loaded villager to 'return', sending it
    // on a drop-off run through the raid instead of into the TC — but the
    // unit must still WALK: the shared movement step lives further down
    // this function, so returning without stepping froze every belled
    // villager that wasn't already within arrival radius ("only one goes
    // in, the rest stand outside").
    if(e.task==='garrison'){
      if(e.path.length>0) stepUnitAlongPath(e, unitMoveSpeed(e) * UNIT_PX_PER_TICK, true);
      return;
    }
  }
  e.atkCooldown=Math.max(0,e.atkCooldown-1);
  e.gatherCooldown=Math.max(0,e.gatherCooldown-1);

  // Follow: keep tracking a moving friendly unit (AoE2-style "Follow" order).
  // Re-paths toward its current position periodically rather than once, since
  // the destination keeps changing. Suspended while in combat (!e.target) —
  // followId survives clearUnitPath, so the chase logic below owns pathing
  // during a fight and follow resumes once the target is gone.
  if(e.followId && !e.target){
    let f=entitiesById.get(e.followId);
    if(!f||f.hp<=0){
      e.followId=undefined;
    } else {
      let d=dist(e,f);
      if(d>1.5){
        if(e.path.length===0 && retryReady(e,'follow')){
          retryStamp(e,'follow',12);
          pathUnitTo(e,Math.round(f.x),Math.round(f.y));
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
  if(e.path.length===0 && e.moveGoalX!==undefined && !e.target && !e.task && !e.followId){
    let atGoal = Math.round(e.x)===e.moveGoalX && Math.round(e.y)===e.moveGoalY;
    if(atGoal){
      e.moveGoalX=undefined;e.moveGoalY=undefined;
    } else if(retryReady(e,'move')){
      retryStamp(e,'move',10); // own key: garrison and move used to alias one stamp
      let goalX=e.moveGoalX, goalY=e.moveGoalY;
      pathUnitTo(e,goalX,goalY);
      if(e.path.length===0){
        // No progress possible from here; stop retrying every frame.
        e.moveGoalX=undefined;e.moveGoalY=undefined;
      }
    }
  }

  // Melee & Ranged units: halt walking path as soon as we step within attack range of our target,
  // or periodically re-path if the moving target has shifted away from our current path's endpoint.
  if(e.target && !e.task){
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
  if(e.utype==='sheep'){
    e.eatTicks = e.eatTicks || 0;
    if(e.eatTicks > 0){
      e.eatTicks--;
      e.eatingGrass = true;
    } else {
      e.eatingGrass = false;
    }

    if(e.path.length===0 && !e.eatingGrass){
      // Periodically stop to eat grass (approx. every 4-8 seconds)
      if(tick % 180 === 0 && simRandom() < 0.4){
        e.eatTicks = simRandInt(60, 120);
      }
      // Or wander around locally in tiny steps (within 1 tile)
      else if(tick % 120 === 0 && simRandom() < 0.25){
        let wx=Math.round(e.x)+simRandInt(-1,1);
        let wy=Math.round(e.y)+simRandInt(-1,1);
        if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
          pathUnitTo(e,wx,wy);
        }
      }
    }

    // Convert/steal sheep (AoE2-style): if an opposing team's unit gets within 5 tiles
    // and no friendly unit (except other sheep) is closer to guard them, they convert!
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

  // Bear behavior (AoE2 wolf logic): a leashed ambush predator, NOT generic
  // military AI — it has its own aggro/give-up rules instead of the
  // isMilitary auto-attack below (which never stops chasing).
  if(e.utype==='bear'){
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
        // Leash hysteresis: no re-aggro until the bear is actually back
        // near its den. Without this, a bear parked exactly at the leash
        // limit with prey in aggro range flip-flopped between "charge" and
        // "trot home" every scan — twitching in place forever (and jittering
        // out from under every tower arrow aimed at it).
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
      if(!e.target&&e.path.length===0&&tick%150===0&&simRandom()<0.3){
        let wx=Math.round(home.x)+simRandInt(-3,3);
        let wy=Math.round(home.y)+simRandInt(-3,3);
        if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
          pathUnitTo(e,wx,wy);
        }
      }
    }
  }

  // Trade cart routing: sets the path for the current leg (to a Market) and
  // delivers gold on arrival. Falls through to the shared movement step below,
  // which walks whatever path this set. Carts have no target/gather task, so
  // the combat and villager blocks below skip them.
  if(e.utype==='tradecart'){
    updateTradeCart(e);
  }

  if(e.path.length>0){
    // A combat unit can reach attack position for its target BEFORE its path
    // runs out — e.g. a siege spot behind the wall keeps the path pointing past
    // a segment the unit is already adjacent to, or a chase path overshoots a
    // foe that stopped. Blindly walking the leftover path then strands the unit
    // in attack range yet not attacking (it tries to walk "through" to the stale
    // goal, jams in the crowd, and freezes until the stuck-watchdog frees it).
    // If we're already in position to hit the target, drop the path now and let
    // the combat block below strike this same tick.
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
  if(e.path.length>0){
    // Shared stepping math (stepUnitAlongPath, js/pathfinding.js) — the
    // guest's between-sync walker uses the same function, so host and
    // guest can never drift apart on movement. checkWalkable=true: only
    // the host's tick keeps the block grid current.
    stepUnitAlongPath(e, unitMoveSpeed(e) * UNIT_PX_PER_TICK, true);
    return;
  }

  if(e.target && e.task !== 'return'){
    let t=entitiesById.get(e.target);
    if(!t||t.hp<=0){
      if(window.__dropStats)window.__dropStats.killed=(window.__dropStats.killed||0)+1;
      e.target=null;
      e.explicitAttack=false;
      return;
    }

    // Fog of War visibility check for combat targets. Uses the sim's own
    // deterministic per-team visibility (teamCanSeeTile, js/core.js) —
    // NEVER the viewer-local `fog` grid, which differs between lockstep
    // peers. Applies to human teams; AI teams keep their distance-heuristic
    // branch below (their "vision" is proximity, not fog — js/ai.js).
    if (!sameSide(t.team, e.team) && t.team !== GAIA_TEAM) {
      if (isHumanTeam(e.team)) {
        let visible = false;
        if (window.fogDisabled) {
          visible = true;
        } else if (t.type === 'unit') {
          let tx = Math.round(t.x), ty = Math.round(t.y);
          visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && teamCanSeeTile(e.team, ty*MAP+tx);
        } else if (t.type === 'building') {
          visible = buildingVisibleToTeam(t, e.team);
        }
        if (!visible) {
          e.target = null;
          e.explicitAttack = false;
          clearUnitPath(e);
          return;
        }
      } else if (isAITeam(e.team) && !e.explicitAttack) {
        // Ordinary AI units drop targets they can no longer see. Explicit
        // marches (controlAIMilitary attacks on the remembered enemy TC)
        // are exempt — the AI knows where the TC is even out of sight,
        // otherwise the army's attack order is wiped the tick after it's
        // given and it never leaves home.
        let visionRange = 15 * (typeof aiScale === 'function' ? aiScale() : 1.0);
        let visible = entities.some(aiEnt => {
          return aiEnt.team === e.team && dist(aiEnt, t) <= visionRange;
        });
        if (!visible) {
          if(window.__dropStats)window.__dropStats.visionDrop=(window.__dropStats.visionDrop||0)+1;
          e.target = null;
          clearUnitPath(e);
          return;
        }
      }
    }

    // Anchor retreat check ("leash"): a guard post leashes AUTO-acquired
    // chases to the post itself — explicit attack orders are exempt, or a
    // commanded assault would get yanked back 6 tiles in — while defensive
    // stance leashes to its drifting idle anchor (defendX/Y). The anchor is
    // COMPUTED here; guard code never mirrors the post into defendX/Y, so
    // each field keeps exactly one meaning.
    syncGuardPost(e); // escort posts track the guarded unit before the leash reads the post
    {
      let guardLeash = e.guardX != null && !e.explicitAttack;
      if (guardLeash) {
        // Guard post: measured to the whole footprint for a building (a threat
        // at any side of a 4x4 TC is still "at post"), else to the post point
        // (ground post, or escorted unit synced onto guardX/Y). Return to the
        // post if dragged past the leash.
        if (guardZoneDist(guardZoneOf(e), e.x, e.y) > GUARD_LEASH) {
          e.target = null;
          clearUnitPath(e);
          pathUnitTo(e, Math.round(e.guardX), Math.round(e.guardY));
          return;
        }
      } else if (e.stance === 'defensive' && e.defendX !== undefined) {
        // Defensive stance drifts to its idle anchor (defendX/Y), not a post.
        let adx = e.x - e.defendX, ady = e.y - e.defendY;
        if (Math.sqrt(adx*adx + ady*ady) > GUARD_LEASH) {
          e.target = null;
          clearUnitPath(e);
          pathUnitTo(e, Math.round(e.defendX), Math.round(e.defendY));
          return;
        }
      }
    }

    if(e.utype==='villager' && t.utype==='sheep_carcass'){
      let d=distToTarget(e,t);
      // Harvest from a ring around the carcass (not stacked on its tile) so
      // several villagers can eat one sheep at once, AoE2-style — the whole
      // starting crew on the first sheep is the classic opening.
      if(d>SHEEP_HARVEST_RANGE){
        // Full ring: wait for an eating spot instead of abandoning the sheep
        // (same patience pattern as combatApproach below).
        if(retryReady(e,'chase')){
          retryStamp(e,'chase',15);
          pathUnitTo(e,Math.round(t.x),Math.round(t.y));
          if(e.path.length===0 && d>8)e.target=null;
        }
      } else {
        clearUnitPath(e);
        if(e.carrying>=e.carryMax){
          e.prevTask=null;
          e.task='return';
          return;
        }
        if(e.gatherCooldown<=0){
          // Switching resource types drops the old load (same rule as
          // updateGatherTask) — without this, a villager carrying 9 wood
          // took one bite and deposited 10 FOOD, a free conversion exploit.
          if(e.carryType!=='food')e.carrying=0;
          t.hp--;
          e.carrying++;
          e.carryType='food';
          e.foodSrc='meat';
          e.gatherCooldown=90; // ~0.33 food/game-second, AoE2 herding rate
          if(window.playSound && tick % (GAME_SPEED >= 4 ? 60 : 30) === 0) window.playSound('forage', t.x, t.y);
          spawnParticles(t.x, t.y, '#ebdcb8', 2, 0.02, 1.2);
          if(t.hp<=0){
            // Shepherd continuity for ALL harvesters (including this one)
            // lives in handleDeath — it retargets or nulls e.target itself,
            // so no null-out here (that used to wipe the killer's retarget).
            handleDeath(t, e.team);
          }
        }
      }
      return;
    }

    let d=distToTarget(e,t);
    let range = UNITS[e.utype]?.range || 0;

    // Shared approach-with-patience: pathing can fail TRANSIENTLY when the
    // spot around a target is collision-crowded (full melee ring, busy drop
    // site). Old behavior dropped the order on any empty path, leaving units
    // idle next to a fight. Now: retry on a cooldown, hold position while
    // near, and only give up when far away with genuinely no route (walled).
    // Returns false if the caller should stop processing this tick.
    // How long a unit may hold a target-with-a-path yet make ZERO real progress
    // (no closing, no damage dealt) before we call it a deadlock. Well under the
    // stuck-watchdog's 240 so the unit self-corrects (redirect/retarget/drop)
    // rather than freezing until the watchdog forcibly frees it.
    const CHASE_STALL_TICKS = 90;
    function combatApproach(u,tgt,dist,pathFn){
      // The 15-tick repath cooldown throttles re-pathing while a chase is in
      // motion. Repath immediately whenever there's no path left (else the unit
      // freezes until the cooldown clears — a stutter).
      if(u.path.length>0 && !retryReady(u,'chase')) return false; // waiting for a slot
      retryStamp(u,'chase',15);
      if(pathFn)pathFn();
      else pathUnitTo(u,Math.round(tgt.x),Math.round(tgt.y));
      if(u.path.length>0){
        // A route exists — but "has a path" is NOT the same as "advancing".
        // findPath ignores MOVING units, so a unit can hold a perfectly valid
        // path it physically can't walk because the tiles ahead are jammed with
        // fellow attackers (the breach-point crowd: several units redirected onto
        // one wall segment that has only a tile or two of walkable perimeter).
        // A budget-capped PARTIAL path can likewise lead to a frontier the unit
        // never gets past. Trust the path only while there is REAL progress:
        // distance to the target falling, OR the target losing hp (we or a
        // teammate are landing hits). A sustained no-progress window is a
        // deadlock — fall through to the same give-up an empty path takes. This
        // exempts the states that merely LOOK stationary: a long march still
        // closes distance, and a second-rank melee waiting for a slot still sees
        // its target's hp drop from the front rank's blows.
        let pr=u.chaseProg;
        if(!pr || pr.id!==tgt.id || dist < pr.d-0.25 || tgt.hp < pr.hp){
          u.chaseProg={id:tgt.id, d:dist, hp:tgt.hp, since:tick};
          retryClear(u,'chaseBlocked');
          return true;
        }
        if(tick - pr.since < CHASE_STALL_TICKS){
          retryClear(u,'chaseBlocked');
          return true;
        }
        // Stalled: a path exists but neither distance nor target-hp has moved for
        // the whole window. Treat it exactly like an empty path (fall through) —
        // but DON'T reset chaseProg here, or the next call re-enters the progress
        // branch and the 2-strike give-up never accumulates.
      }
      // EMPTY path (or a stalled non-empty one): the honest "can't actually get
      // there". findPath returns [] only after fully exploring the reachable
      // region without touching the target, and moving units don't block pathing
      // — so this is a real wall/trap/deadlock, not a one-tick jam. Give up (a
      // 2-strike tolerance absorbs a transient) instead of freezing (stuck-
      // watchdog spam). An AI unit redirects to a DIFFERENT reachable enemy wall
      // to breach (spreading a breach crowd along the ring instead of piling all
      // onto one un-slottable segment); else it drops the impossible target and
      // remembers it, so auto-acquire / threat-response won't instantly re-send
      // it. Human units keep their explicit order (never hijack a player command).
      if(retryFail(u,'chaseBlocked',15,2)&&isAITeam(u.team)){
        // Scouts are recon (atk 3) — never redirect them to breach a wall:
        // controlAIScouts strips building targets each decision, so a scout
        // handed a wall just loses it, re-acquires the impossible foe, and
        // oscillates in place (stuck-watchdog spam). Scouts always drop+remember.
        let stalledId=tgt.id;
        let w=(u.utype!=='scout'&&typeof nearestReachableWallLike==='function')?nearestReachableWallLike(u,tgt.team,stalledId):null;
        if(w&&w.id!==stalledId&&!sameSide(w.team,u.team)){ u.target=w.id;u.explicitAttack=true;u.siegeSpot=null; }
        else { if(window.__dropStats)window.__dropStats.unreachable=(window.__dropStats.unreachable||0)+1;
          u.target=null;u.explicitAttack=false;u.siegeSpot=null;
          u.unreachId=stalledId; u.unreachUntil=tick+900; }
        retryClear(u,'chaseBlocked'); clearUnitPath(u); u.chaseProg=undefined;
      }
      return false;
    }

    if (range > 0) {
      // Ranged combat: stay within range and fire projectiles
      if (d > range) {
        if (e.stance === 'standground' && !e.explicitAttack) {
          e.target = null;
          return;
        }
        if(!combatApproach(e,t,d)) return;
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
          combatApproach(e,t,d,()=>{let pt=siegePerimeterSpot(e,t);pathUnitTo(e,pt.x,pt.y);});
        } else if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      } else {
        // Attack unit: path close and hit
        let maxD = (e.utype==='villager' && t.utype==='sheep') ? SHEEP_HARVEST_RANGE : 1.5; // slaughter from the ring, see maxDist above
        // A melee swing can't cross a SEALED wall corner: if the target sits
        // diagonally across a corner whose BOTH orthogonal tiles are impassable,
        // there's no line to strike through — same no-corner-cut rule movement
        // uses. Without this, a unit hit a foe diagonally through two walls it
        // couldn't walk between (ignoreUnits: we mean terrain/walls, not units).
        let cornerBlocked=false;
        { let ex=Math.round(e.x),ey=Math.round(e.y),tx=Math.round(t.x),ty=Math.round(t.y);
          let dx=tx-ex,dy=ty-ey;
          if(dx&&dy&&!walkable(ex+dx,ey,e.id,true)&&!walkable(ex,ey+dy,e.id,true))cornerBlocked=true; }
        if(d>maxD||cornerBlocked){
          if (e.stance === 'standground' && !e.explicitAttack) {
            e.target = null;
            return;
          }
          if(!combatApproach(e,t,d)) return;
        } else if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      }
    }
    return;
  }

  if(e.utype==='villager'&&e.task){
    if(e.task==='build'&&e.buildTarget){
      let bt=entitiesById.get(e.buildTarget);
      if(!bt||(bt.complete && bt.hp >= bt.maxHp && !(bt.btype==='FARM' && bt.exhausted))){
        if(!checkNextBuild(e)){
          e.task=null;
          e.buildTarget=null;
          if(bt) autoTaskBuilder(e, bt);
        }
        return;
      }
      let isFarm=bt.btype==='FARM';
      let close=isFarm?dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2:adjToBuilding(e.x,e.y,bt);
      if(!close){
        if(isFarm){
          pathUnitTo(e,bt.x,bt.y);
        } else {
          let pt=nearestBldgPerimeter(e.x,e.y,bt,e.id);
          pathUnitTo(e,pt.x,pt.y);
        }
        if(e.path.length===0){
          let checkClose = isFarm ? dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2 : adjToBuilding(e.x,e.y,bt);
          if (!checkClose) {
            // Perimeter may just be crowded with other builders — retry a few
            // times before declaring the site unreachable and dropping it.
            if(!retryFail(e,'build',0,6)) return;
            feedbackFor(e.team, () => showMsg('Building site is unreachable!'));
            // Back the foundation off (any team): assigners skip it until
            // the stamp expires (AI: neededAIBuildingWork) — without this,
            // villagers get re-fed into the same unreachable site forever,
            // a pathfinding storm that can freeze the game. Time-limited,
            // not permanent: a site blocked by a passing crowd heals.
            bt.buildBackoffUntil=tick+900;
            if(!checkNextBuild(e)){
              e.task=null; // savedTask resume / AI reassignment reroutes from idle
              e.buildTarget=null;
            }
          } else {
            retryClear(e,'build');
          }
        }
        // NOTE: a successful pathUnitTo (path.length>0) deliberately does
        // NOT clear the fail counter — "got a path" isn't progress. A path
        // whose first step is permanently blocked (stubborn unit in a
        // 1-wide lane) is rebuilt every tick and used to reset the counter
        // forever: the give-up below never fired and the villager froze
        // until the watchdog broke it up. Only ARRIVAL clears (below).
      } else {
        retryClear(e,'build');
        if (bt.btype === 'FARM' && bt.exhausted) {
          let store = resourceStore(e.team);
          if (store && store.prepaidFarms > 0) {
            store.prepaidFarms--;
            feedbackFor(e.team, () => showMsg("Reseed consumed from Mill! (Prepaid remaining: " + store.prepaidFarms + ")"));
            bt.exhausted = false;
            bt.complete = true;               // exhaustion had flagged it incomplete;
            bt.buildProgress = bt.buildTime;  // without this, canGatherTile rejects the
            bt.hp = bt.maxHp;                 // farm and the farmer silently goes idle
            let tile = map[bt.y][bt.x];
            tile.t = TERRAIN.FARM;
            tile.res = farmFoodFor(bt.team);
            markMapDirty(bt.x,bt.y);
            e.task = 'farm';
            e.gatherX = bt.x;
            e.gatherY = bt.y;
            e.buildTarget = null;
            return;
          } else {
            // Direct-from-bank reseed is AI-ONLY (it's how the AI manages
            // its farms). A HUMAN's farmer must not silently spend 60 wood
            // — that made the Mill's prepaid queue pointless: the whole
            // point of prepay (AoE2 DE) is choosing WHEN wood goes to
            // farms. No prepaid credit → the farm stays exhausted until
            // the player reactivates it or queues reseeds at the Mill.
            if (store && store.wood >= 60 && isAITeam(e.team)) {
              store.wood -= 60;
              feedbackFor(e.team, () => showMsg("Farm reseeded (-60 Wood)"));
              bt.exhausted = false;
              bt.complete = true;
              bt.buildProgress = bt.buildTime;
              bt.hp = bt.maxHp;
              let tile = map[bt.y][bt.x];
              tile.t = TERRAIN.FARM;
              tile.res = farmFoodFor(bt.team);
              markMapDirty(bt.x,bt.y);
              e.task = 'farm';
              e.gatherX = bt.x;
              e.gatherY = bt.y;
              e.buildTarget = null;
              return;
            } else {
              feedbackFor(e.team, () => showMsg(isAITeam(e.team) ? "Not enough wood to reseed farm!" : "Farm exhausted — reactivate it or prepay reseeds at the Mill"));
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
        }
        if (!bt.complete) {
          bt.buildProgress++;
          // HP grows with construction (AoE2): each work tick adds its share
          // of maxHp, so a half-built structure has half its HP. Damage taken
          // during construction persists (the cap only limits, never heals).
          bt.hp=Math.min(bt.maxHp,bt.hp+bt.maxHp/bt.buildTime);
          // Construction hammer audio plays at the mallet's VISUAL impact in
          // render-units.js (same treatment as chop/mine) — a sim-side
          // tick%30 cadence here fought both the swing animation and the
          // per-type rate limiter at 4x, which read as skipping.
          if(bt.buildProgress>=bt.buildTime){
            bt.complete=true;
            bt.hp=Math.min(bt.maxHp,Math.round(bt.hp));
            delete bt.upgrading; // committed-upgrade marker (execUpgradeWalls) — done its job
            e.buildTarget=null;
            if (e.team === myTeam && window.playSound) { // myTeam, not 0: on the host they're equal, and the guest completion path (js/net-sync.js) mirrors this gate
              window.playSound('train'); // play herald fanfare on building completed
            }
            if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);
            
            // Auto-task villager after construction is finished (if no other buildings in queue)
            if(!checkNextBuild(e)){
              autoTaskBuilder(e, bt);
            }
          }
        } else {
          // Repair completed but damaged building
          bt.repairCounter = (bt.repairCounter || 0) + 1;
          if (bt.repairCounter >= 3) {
            bt.repairCounter = 0;

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
              bt.buildBackoffUntil = tick + 900;
              e.buildTarget = null;
              e.task = null;
              bt.woodDebt = 0;
              bt.stoneDebt = 0;
              return;
            }
          }
          // Construction hammer audio plays at the mallet's VISUAL impact in
          // render-units.js (same treatment as chop/mine) — a sim-side
          // tick%30 cadence here fought both the swing animation and the
          // per-type rate limiter at 4x, which read as skipping.
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
      return;
    }
    if(e.task==='return'){
      // Patience gate: when every route was blocked (usually a crowded drop
      // site, not a walled-off one), wait a beat and retry with a full load
      // instead of going idle and silently losing the carried resources.
      if(retryActive(e,'dropWait')){
        if(!retryReady(e,'dropWait'))return;
        retryClear(e,'dropWait');
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
        let pt=nearestBldgPerimeter(e.x,e.y,drop,e.id);
        pathUnitTo(e,pt.x,pt.y);
        if(e.path.length===0){
          avoidAdd(e,'drops',drop.id);

          let foundPath = false;
          while (true) {
            let nextDrop = nearestDrop(e, e.carryType, e.avoid&&e.avoid.drops);
            if (!nextDrop) break;

            let nextPt = nearestBldgPerimeter(e.x, e.y, nextDrop, e.id);
            pathUnitTo(e, nextPt.x, nextPt.y);
            if (e.path.length > 0) {
              foundPath = true;
              break;
            }
            avoidAdd(e,'drops',nextDrop.id);
          }

          if (foundPath) return;

          // Every drop site unreachable right now — hold the load and retry
          // shortly (see the dropWait gate above) rather than giving up.
          retryStamp(e,'dropWait',30);
        }
      } else {
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
      return;
    }
    if(e.carrying>=e.carryMax){
      e.prevTask=e.task;e.task='return';return;
    }
    if(GATHER_TASKS[e.task])updateGatherTask(e,GATHER_TASKS[e.task]);
  }
  // Auto Scout (player toggle): a scout on auto-explore keeps moving to the
  // most-unexplored frontier and AVOIDS combat (a dead scout stops scouting).
  // Reuses the AI's frontier picker (pickExploreWaypoint, js/ai.js) off the
  // deterministic per-team explored grid + simRandInt. The shared movement step
  // above already walked/returned when a path existed, so we only reach here
  // with an empty path (arrived); re-pick on a light cadence so a blocked pick
  // doesn't churn every tick. Returns so it never falls into the auto-attack
  // block below. Manual orders clear autoScout (execUnitCommand).
  if(e.autoScout && e.utype==='scout'){
    if(e.target){ e.target=null; e.explicitAttack=false; }
    if(e.path.length===0 && (tick+e.id)%12===0){
      let home=entities.find(b=>b.type==='building'&&b.btype==='TC'&&b.team===e.team)||null;
      let pt=(typeof pickExploreWaypoint==='function')?pickExploreWaypoint(e.team, home):null;
      if(pt)pathUnitTo(e,pt.x,pt.y);
    }
    return;
  }
  // Auto-attack: idle military units engage nearby enemies (always enabled for military, disabled for villagers)
  // Bears are excluded: they use their own leashed aggro logic above, not
  // the never-give-up military chase here.
  // Rams are excluded too: AoE2 rams never auto-engage — with 1-2 dmg vs
  // units, chasing a passing scout is pure suicide-by-distraction. They
  // attack only what they're explicitly ordered onto (or what the AI's
  // target planner assigns).
  // Trade carts are unarmed haulers (atk 0) — never let them auto-engage, or an
  // idle cart chases enemies it can't hurt instead of trading.
  let isMilitary = isSoldierUnit(e);
  // Note: followId isn't excluded here — a unit that has caught up to its
  // follow target and stopped (path empty) should still engage nearby
  // enemies like any idle unit; combat naturally takes precedence and the
  // follow order resumes once the fight ends (followId itself isn't touched
  // by combat, only the per-leg pathing is).
  if(isMilitary && !e.target && e.path.length===0 && !e.task){
    // A guard flag PINS the defend anchor to the flagged spot (a plain idle
    // unit's anchor drifts to wherever it stands); an idle guard away from
    // its flag walks back. retryReady throttles the re-path so a blocked
    // return doesn't hammer the pathfinder every tick.
    // Idle anchor drift (defensive-stance leash) — unconditional, exactly
    // the pre-guard behavior: defendX/Y means "where this unit last idled"
    // and NOTHING else. The guard leash reads guardX/Y directly.
    e.defendX = e.x;
    e.defendY = e.y;
    syncGuardPost(e);
    if(e.guardX != null){
      let gdx = e.x - e.guardX, gdy = e.y - e.guardY;
      // While ESCORTING (followId set), the follow leg does the walking —
      // don't compete with it for the path.
      if(e.followId == null && gdx*gdx + gdy*gdy > 2.25 && retryReady(e,'guardret')){
        // SETTLE rule: a return must be able to fail permanently. Shared
        // posts only seat ~9 units within the 1.5-tile radius, and a post
        // can be built over, in forest, or inside a garrison footprint —
        // without this, every surplus/blocked unit re-runs A* every 30
        // ticks forever. After 3 fruitless attempts (retry .n, hashed for
        // lockstep) or an outright no-path, the spot the unit actually
        // stands becomes the post.
        let r = e.retry && e.retry['guardret'];
        if (r && r.n >= 3) {
          e.guardX = Math.round(e.x); e.guardY = Math.round(e.y);
          r.n = 0;
        } else {
          retryStamp(e,'guardret',30);
          e.retry['guardret'].n++;
          pathUnitTo(e, Math.round(e.guardX), Math.round(e.guardY));
          if (e.path.length === 0) { e.guardX = Math.round(e.x); e.guardY = Math.round(e.y); e.retry['guardret'].n = 0; }
        }
      }
    }
    // Stagger the acquisition scan across 3 ticks by id: this scan (grid
    // walk + fog gate per candidate) ran for EVERY idle military unit EVERY
    // tick and dominated late-game tick cost. Worst added reaction delay is
    // 2 ticks (~33ms) — imperceptible. (tick+id) keys it deterministically,
    // identical on every lockstep peer.
    // AI scouts are pure recon (controlAIScouts owns them for exploration) —
    // they must NOT auto-acquire attack targets, or they wedge chasing a foe
    // near the enemy base they can't reach (partial-path jiggle → stuck-watchdog).
    // A HUMAN scout still auto-acquires (the player expects it to fight).
    if (e.stance !== 'passive' && (tick + e.id) % 3 === 0 && !(e.utype==='scout'&&isAITeam(e.team))) {
      let scanRange = e.stance === 'aggressive' ? 8 : (e.stance === 'standground' ? (e.range > 0 ? e.range : 1.5) : 6);
      let reachAtk=(e.range>0?e.range:1.6);
      // A guarding unit's aggro is scoped to what it PROTECTS, not to itself:
      // it only engages enemies inside its leash zone (GUARD_LEASH) of the
      // post/building — same zone + radius as the leash above — so it never
      // chases a foe that isn't threatening the guarded thing, and never
      // oscillates re-grabbing one it was just leashed off of. Matches AoE2
      // Guard (defend the target's vicinity), vs. plain defensive stance which
      // aggros on anything near the unit. Explicit attacks are exempt.
      let guardZone = (e.guardX != null && !e.explicitAttack) ? guardZoneOf(e) : null;
      let closest=closestUnitNear(e,scanRange+0.1,en=>{
        if(sameSide(en.team,e.team))return false;
        if(guardZone && guardZoneDist(guardZone, en.x, en.y) > GUARD_LEASH)return false; // outside the guard zone → not our fight
        // Skip a foe we recently proved unreachable — UNLESS it is now within
        // attack range AND actually hittable (pathing is then moot; we hit it
        // where it stands). Without the range exception an idle unit ignored an
        // enemy that walked right up to it (a soldier "refusing" a fight). But a
        // foe that's in range only DIAGONALLY across a sealed wall corner is NOT
        // hittable (melee corner rule) and can't be pathed to either, so keep
        // skipping it — otherwise the unit re-acquires and oscillates in place.
        if(e.unreachUntil>tick && e.unreachId===en.id){
          if(dist(e,en)>reachAtk+0.5)return false; // out of range → keep skipping
          if(e.range<=0){ // melee: reject the sealed-corner diagonal (matches the attack corner rule)
            let ex=Math.round(e.x),ey=Math.round(e.y),dx=Math.round(en.x)-ex,dy=Math.round(en.y)-ey;
            if(dx&&dy&&!walkable(ex+dx,ey,e.id,true)&&!walkable(ex,ey+dy,e.id,true))return false;
          }
        }
        let ey=Math.round(en.y),ex=Math.round(en.x);
        if(ey<0||ey>=MAP||ex<0||ex>=MAP)return false;
        // Fog gate, symmetric per team via the sim's deterministic
        // visibility (teamCanSeeTile, js/core.js) — never the viewer-local
        // fog grid, which differs between lockstep peers. AI teams keep
        // their own proximity-based aggro rules unchanged.
        if(!window.fogDisabled && isHumanTeam(e.team)
           && !teamCanSeeTile(e.team, ey*MAP+ex))return false;
        return true;
      });
      if(closest) {
        if(dist(e,closest)<=reachAtk+0.5){
          // Already in attack range → engage directly; no pathing needed (also
          // skips the findPath below, the auto-acquire hotspot at a wall standoff).
          e.target=closest.id;
        } else {
          // Only lock on if we can actually PATH to it. An idle unit grabbing a
          // foe it can't reach — the classic case is a raider poking our wall from
          // outside our sealed ring — is the wedge source: it re-acquires every
          // few ticks and freezes chasing an impossible target (stuck-watchdog
          // spam). The candidate is within scan range (<=8 tiles), so this findPath
          // is short and unambiguous (a real block gives [] or a path that stops
          // short). If unreachable, remember it long enough that a stalemate
          // doesn't re-run this search every few ticks.
          let cx=Math.round(closest.x), cy=Math.round(closest.y);
          let pth=findPath(Math.round(e.x),Math.round(e.y),cx,cy,e.id);
          let end=pth.length?pth[pth.length-1]:null;
          if(end && Math.max(Math.abs(end.x-cx),Math.abs(end.y-cy))<=Math.max(2,reachAtk)){
            e.target=closest.id;
          } else { e.unreachId=closest.id; e.unreachUntil=tick+900; }
        }
      } else if (isHumanTeam(e.team)) {
        // No enemy unit in range: engage enemy BUILDINGS (AoE2 aggressive
        // behavior — soldiers parked in an enemy town shouldn't stand and
        // soak tower/TC fire without answering). Attacking-capable
        // structures (TOWER/TC) take priority over the rest; walls/gates
        // are excluded so armies don't spontaneously whittle fortifications
        // they're merely standing near. Same visibility gate as units;
        // ties broken by lowest id (deterministic). The single-player AI
        // (netRole null, team 1) keeps its own attack planning.
        let bestB = null, bestD = Infinity, bestPri = -1;
        for (let bi = 0; bi < entities.length; bi++) {
          let b = entities[bi];
          if (b.type !== 'building' || sameSide(b.team, e.team) || b.team === GAIA_TEAM || b.hp <= 0) continue;
          if (isWallBtype(b.btype) || isGateBtype(b.btype)) continue;
          if (guardZone && guardZoneDist(guardZone, b.x + b.w/2, b.y + b.h/2) > GUARD_LEASH) continue; // outside the guard zone
          let d = distToTarget(e, b);
          if (d > scanRange + 0.1) continue;
          if (!window.fogDisabled && !buildingVisibleToTeam(b, e.team)) continue;
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

// Per-tick cache of gather-tile claims per team (tile key = x + y*MAP).
// findNearTile used to rebuild this set from the whole entities array for
// EVERY caller — per depleted-resource villager per tick. Claims granted
// mid-tick are added to the cached set as findNearTile hands them out, so
// several villagers reassigned in the same tick still fan out; claims
// RELEASED mid-tick linger until next tick, which is merely conservative.
// (The cache can't exclude the asking villager's own claim the way the old
// per-caller build did — harmless: findNearTile is only called to pick a
// NEW tile, and the fallback pass ignores claims entirely.)
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
  // noClaim=true: probe only (existence/reachability check) — do NOT reserve the
  // tile in the per-tick claim set. The assigner calls this several times per
  // villager for fulfillability/reachability checks (assignAIGatherTask's
  // tileFor probes one candidate task after another); claiming on
  // each one reserved 2-3 tiles per villager, falsely saturating the claim set
  // and pushing later villagers to farther patches. Only the FINAL assigned tile
  // should claim.
  let bx=anchor?Math.round(anchor.x):Math.round(e.x),by=anchor?Math.round(anchor.y):Math.round(e.y);
  let best=null,bd=999;
  let claimed=claimedGatherSet(e.team);
  // Two-stage search: the cheap 12-radius ring first (covers the normal
  // "work near the drop site" case), then a wide 28-radius pass ONLY if
  // that found nothing. Capping at 12 idled entire towns late-game: once
  // the nearby forest was chopped out, villagers at the TC couldn't "see"
  // the treeline 13 tiles away and a food-starved town sat on 1800 banked
  // wood with 10 idle villagers (sim seed 7). AoE2 villagers walk.
  let scan=(rLo,rHi)=>{
  // Ring-only scan: each radius pass visits just the new perimeter instead
  // of rescanning the whole (2r+1)² square (the union of rings 0..r is that
  // square, so the first radius that yields a hit returns the same tile the
  // old full-square rescan did — at O(r²) total instead of O(r³)).
  for(let r=rLo;r<rHi;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(excludeList && excludeList.includes(nx+ny*MAP))continue; // e.avoid array (see avoidAdd)
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
  // nothing. (Slight over-refund if a gate/tower consumed wall tiles for
  // a stone discount — rare and in the player's favor, acceptable.)
  // A committed upgrade-in-progress (execUpgradeWalls, js/commands.js) is
  // NOT cancellable — it already paid out its salvage, so refunding the new
  // type's cost too would mint free resources; force-deleting one just
  // destroys it for nothing.
  if(en.type==='building'&&!en.complete&&!en.exhausted&&!en.upgrading){
    let store=resourceStore(en.team); // the OWNING team's resources, not always team 0's
    Object.entries(BLDGS[en.btype].cost||{}).forEach(([key,amount])=>{store[resourceName(key)]+=amount;});
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
    // building dies or is deleted. (Age research dying unrefunded with the
    // TC is intentional — see execResearchAge, js/commands.js.)
    if(e.queue&&e.queue.length>0&&isPlayerTeam(e.team)){
      let store=resourceStore(e.team);
      e.queue.forEach(utype=>{
        Object.entries(UNITS[utype].cost||{}).forEach(([key,amount])=>{store[resourceName(key)]+=amount;});
      });
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
      // Victory condition: the Town Center is the heart of each side — lose
      // it, lose the game. (Full-elimination conquest rules were tried and
      // reverted; teamEliminated() below remains as a fallback for the
      // no-TC-left edge cases.)
      // Losing your (only) TC knocks YOUR TEAM out; the match ends when
      // the surviving teams are all one alliance (checkAllianceVictory).
      // Identity alliances + 2 teams reduce exactly to the old instant
      // game-over. isPlayerTeam keeps gaia TCs (hypothetical) from ever
      // ending the game.
      // Each team has exactly ONE Town Center and it cannot be rebuilt —
      // losing it is the knockout (AoE2-flavored regicide-on-the-TC).
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
      deathTime: performance.now()
    };
    corpses.push(corpse);
  }
  // Shepherd continuity: when a carcass is consumed, EVERY villager that
  // was harvesting it moves on to the nearest remaining carcass or own/
  // gaia sheep within herding range — not just the one whose bite finished
  // it (the others used to be left with a dead target, idling). Runs
  // before the removal below so `e` is excluded naturally by the hp gate.
  // Deterministic: villagers in entities order, nearest pick with id ties.
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
// General safety net over EVERY task/path state machine, host-only. Each
// task loop is designed to either progress or clear itself (blocked steps
// clear the path; repath branches give up after bounded retries) — the
// watchdog exists for whatever escapes that design: a unit that stays
// "busy" (path/task/target/buildTarget) while its ENTIRE observable state
// is frozen for 8 game-seconds gets reset to idle. Idle is the honest
// failure mode — visible via the "?" marker and idle button, military
// re-acquires via auto-attack, villagers with a savedTask resume — and the
// console.warn turns any silent freeze into a diagnosable report.
//
// Legitimate stationary-busy states never trip it because their signature
// keeps changing (gathering increments `carrying`; fighting cycles the
// path/target as combat repositions) or they're exempted (deliberate
// drop-off waits, garrisoned units, wildlife).
const STUCK_WATCHDOG_TICKS = 240;   // 8 game-seconds
const STUCK_CHECK_EVERY = 30;       // sample once per game-second
// Watch state lives ON the unit (e.stuck = {sig, since}) — plain sim data,
// so it rides lockstep snapshots, resync payloads, and save files with zero
// dedicated plumbing, and detEntityHash covers it (the watchdog force-clears
// tasks, so WHEN it will fire is sim state). Dead units take their entry
// with them — no side-table, no pruning pass.
function updateStuckWatchdog(){
  if (tick % STUCK_CHECK_EVERY !== 0) return;
  entities.forEach(e => {
    if (e.type !== 'unit' || e.hp <= 0 || e.garrisonedIn) return;
    if (e.utype === 'sheep' || e.utype === 'sheep_carcass' || e.utype === 'bear') return;
    let busy = e.path.length > 0 || e.task || e.target || e.buildTarget;
    if (!busy) { e.stuck = undefined; return; }
    if (e.task === 'return' && retryActive(e,'dropWait')) { e.stuck = undefined; return; } // deliberate wait
    // Actively fighting: a unit that landed a hit within the watchdog window is
    // making progress by definition, even if its target's SAMPLED hp looks flat
    // (a wall an enemy repairs in step, a second target soaking between its own
    // regen ticks). Freezing such a unit is a false-positive that yanks it off a
    // live attack. A genuinely wedged unit never reaches its target to swing.
    if (e.lastAtkTick != null && tick - e.lastAtkTick < STUCK_WATCHDOG_TICKS) { e.stuck = undefined; return; }
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
      // A wedged BUILDER means its site is effectively unreachable right
      // now (blocked lane, sealed pocket): back the site off too, or the
      // AI re-assigns the freed villager straight back into the same wedge.
      let wbt = e.buildTarget ? entitiesById.get(e.buildTarget) : null;
      if (wbt && wbt.type === 'building') wbt.buildBackoffUntil = tick + 900;
      console.warn('[stuck-watchdog] freeing unit', e.id, e.utype,
        'task=' + e.task, 'target=' + e.target, 'path=' + e.path.length,
        'buildTarget=' + e.buildTarget + (bt ? ('(' + bt.btype + '@' + bt.x + ',' + bt.y + ' prog=' + (bt.buildProgress||0) + '/' + bt.buildTime + ' complete=' + bt.complete + ')') : ''),
        'gather=' + e.gatherX + ',' + e.gatherY, 'retry=' + JSON.stringify(e.retry||null),
        'at', e.x.toFixed(1) + ',' + e.y.toFixed(1));
      clearUnitPath(e);
      e.task = null; e.target = null; e.buildTarget = null; e.garrisonTarget = null;
      clearGatherTarget(e);
      e.stuck = undefined;
    }
  });
}

function findSpawnTile(x,y,maxRadius=4,taken=null){
  // Ring-only per radius (the old full-square rescan returned the first
  // walkable tile in raster order — up to maxRadius-1 tiles up-left even
  // when an adjacent tile was free). `taken` lets one call site spread a
  // batch (e.g. ejectGarrison) across distinct tiles.
  for(let r=0;r<maxRadius;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
    if(taken&&taken.has((x+dx)+','+(y+dy)))continue;
    if(walkable(x+dx,y+dy))return{x:x+dx,y:y+dy};
  }
  return null;
}

function updateBuilding(e){
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

  if(!e.complete)return;

  // Tower / TC arrow fire (defensive structures auto-fire)
  if (firesArrows(e.btype)) {
    e.atkCooldown = Math.max(0, (e.atkCooldown || 0) - 1);
    if (e.atkCooldown <= 0) {
      let range = BLDGS[e.btype].range; // AoE2: TC range 6, Watch Tower 8
      let center = {x: e.x + e.w/2, y: e.y + e.h/2};
      let targets = entities.filter(en => !sameSide(en.team, e.team) && en.type === 'unit' && en.hp > 0 && !en.garrisonedIn && en.utype !== 'sheep' && en.utype !== 'sheep_carcass')
                            .filter(en => dist(center, en) <= range)
                            .sort((a,b) => dist(center, a) - dist(center, b));
      if (targets.length > 0) {
        let bCenter = {
          id: e.id,
          type: 'building',
          btype: e.btype,
          x: center.x,
          y: center.y,
          team: e.team,
          atk: e.atk // AoE2: both TC and Watch Tower deal 5 pierce (set from BLDGS in createBuilding)
        };
        // AoE2-style: garrisoned units add extra arrows (capped at +5),
        // spread over the closest targets in range.
        let arrows = 1 + Math.min(garrisonCount(e), 5);
        for (let i = 0; i < arrows; i++) {
          spawnProjectile(bCenter, targets[i % targets.length]);
        }
        e.atkCooldown = 60; // fire every 2 game-seconds (AoE2 TC/tower reload)
      }
    }
  }

  // Garrisoned units slowly heal while sheltered
  if (garrisonCount(e) > 0 && tick % 45 === 0) {
    e.garrison.forEach(id => {
      let u = entitiesById.get(id);
      if (u && u.hp > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + 1);
    });
  }

  // Age research (TC only): while active, the unit queue is PAUSED — the
  // classic AoE2 tension of advancing vs more villagers. Completion is the
  // one place teamAge advances, plus the military attack sweep (attack is
  // snapshotted on entities; armor is added live in damageEntity).
  if(e.research){
    e.research.tick++;
    if(e.research.tick>=AGES[e.research.target].researchTicks){
      teamAge[e.team]=e.research.target;
      // Baked-in tech: every card unlocked by the new age applies now (one-
      // time stat sweeps; live-read effects key off teamAge via hasUpgrade).
      // This replaced the old inline "+1 atk per age" sweep — that exact
      // sweep is now the forging/iron_casting cards. See UPGRADES, core.js.
      let cardNames=applyAgeUpgrades(e.team,e.research.target);
      // AoE2-style power-spike aggression: an AI that just advanced presses
      // its (freshly bumped) army — controlAIMilitary reads this stamp.
      if(AI_STATES&&AI_STATES[e.team])AI_STATES[e.team].lastAgeUpTick=tick;
      if(e.team===myTeam){
        showMsg('You have advanced to the '+AGES[e.research.target].name+'!'+
          (cardNames.length?' Gained: '+cardNames.join(', ')+'.':''));
        if(window.playSound)playSound('victory');
      }
      e.research=undefined;
      if(typeof updateUI==='function')updateUI();
    }
    return;
  }
  if(e.queue.length>0){
    let u=UNITS[e.queue[0]];
    if(e.trainTick<u.trainTime)e.trainTick++;
    if(e.trainTick>=u.trainTime){
      if(!hasPopulationRoom(e.team,e.queue[0],false))return;
      let spawn=findSpawnTile(e.x+e.w,e.y+e.h) || findSpawnTile(e.x,e.y);
      if(!spawn){
        if(e.team===myTeam && tick % 180 === 0){
          showMsg("Spawn point blocked! Clear area near " + BLDGS[e.btype].name);
        }
        return;
      }
      e.trainTick=0;
      let ut=e.queue.shift();
      let unit=createUnit(ut,spawn.x,spawn.y,e.team);
      
      // Play training complete fanfare sound (player team 0)
      if (e.team === myTeam && window.playSound) { // myTeam, not 0: on the host they're equal, and the guest completion path (js/net-sync.js) mirrors this gate
        window.playSound('train');
      }
      
      // Rally point set on a garrisonable own building (including this one):
      // the fresh unit appears directly inside it, AoE2-style — no walking.
      // NOTE: this whole block runs as part of the HOST's normal per-tick
      // building-queue processing (js/loop.js's update()), for EVERY
      // building regardless of team, every tick — `myTeam` is constant
      // (always 0 on whichever machine is hosting) throughout this code,
      // not a per-entity "whose perspective" signal the way it is in
      // rendering/UI/input code. The old `e.team===0` restriction wasn't
      // "my team" logic at all, just an unconditional rally point feature
      // arbitrarily limited to team 0 — team 1 is a real player in
      // multiplayer (the guest) who sets rally points too, so this now
      // applies to all player teams (gaia/neutral has no buildings).
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
        // Fresh MILITARY units guard their rally flag (AoE2-style): where
        // they're flagged to becomes their default guard anchor, so after
        // any fight they return to the flag instead of drifting off.
        // HUMAN teams only: the AI's military controller (js/ai.js) issues
        // raw target/pathUnitTo assignments that never manage guard fields,
        // so a post would leash its defenders 6 tiles from the barracks and
        // the idle return would fight its forward posture — AI units keep
        // the pre-guard behavior (drifting defend anchor, no post).
        if(guardEligible(unit) && !isAITeam(e.team)){
          setGuardPost(unit, e.rallyX, e.rallyY, false);
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
                let pt=nearestBldgPerimeter(unit.x,unit.y,target,unit.id);
                pathUnitTo(unit,pt.x,pt.y);
              } else {
                pathUnitTo(unit,e.rallyX,e.rallyY);
              }
            } else if(unit.utype==='villager'&&target.type==='building'&&!target.complete&&target.team===e.team){
              unit.task='build';
              unit.buildTarget=target.id;
              pathUnitTo(unit,target.x,target.y);
            } else if(unit.utype!=='tradecart' && !sameSide(target.team,e.team) && target.team!==GAIA_TEAM){
              // Rally onto an ENEMY BUILDING: fresh units attack it. (Unit
              // rally targets no longer exist — execRally snaps a flag
              // dropped on a unit to the ground tile under it — so this is
              // buildings only. Trade carts never take attack targets.)
              unit.target=target.id;
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
              // then around the spawn — instead of marching it to a dead
              // tile and hoping the 12-tile gather fallback can see past it.
              let alt=findNearTile({x:gx,y:gy,team:unit.team},cfg.terrain)
                   ||findNearTile(unit,cfg.terrain);
              if(alt){gx=alt.x;gy=alt.y;}
            }
            unit.gatherX=gx;
            unit.gatherY=gy;
            pathUnitTo(unit,gx,gy);
          }
        } else {
          pathUnitTo(unit,e.rallyX,e.rallyY);
        }
      }
    }
  }
}
