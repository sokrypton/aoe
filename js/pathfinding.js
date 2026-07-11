// ---- PATHFINDING (A*) ----
// Raised from the original 800 so long-distance/obstructed routes on bigger
// maps (90/120 tiles) can still find a full path instead of capping out early.
const MAX_PATH_ITERS=2200;

// ---- UNIT COLLISION (AoE2-style) ----
// Stationary units occupy their tile and are hard obstacles: A* routes around
// them, and a walking unit stops when it bumps into one (its normal repath
// logic then finds a way around). Units that are themselves walking don't
// block — matching AoE2, where moving traffic flows through/past itself and
// only parked units force a detour. This is also what caps how many melee
// attackers can engage one target: the victim's tile is blocked, so attackers
// ring the surrounding tiles and latecomers mill around outside.
// Rebuilt once per tick in update(); Int32Array of unit ids (0 = free).
let unitBlock=null;
function rebuildUnitBlock(){
  if(!unitBlock||unitBlock.length!==MAP*MAP)unitBlock=new Int32Array(MAP*MAP);
  else unitBlock.fill(0);
  entities.forEach(e=>{
    if(e.type!=='unit'||e.garrisonedIn||e.hp<=0)return;
    if(e.utype==='sheep_carcass')return; // a corpse on the ground blocks nobody
    if(e.path.length>0)return; // moving units don't block
    let x=Math.round(e.x),y=Math.round(e.y);
    if(x>=0&&x<MAP&&y>=0&&y<MAP)unitBlock[x+y*MAP]=e.id;
  });
}

function walkable(x,y,ignore,ignoreUnits){
  if(x<0||x>=MAP||y<0||y>=MAP)return false;
  // Stationary-unit collision (see rebuildUnitBlock above). ignoreUnits is
  // for separateUnits(), which resolves residual overlap and must not treat
  // the very units it's separating as immovable walls.
  if(!ignoreUnits&&unitBlock){
    let uid=unitBlock[x+y*MAP];
    if(uid&&uid!==ignore){
      let walker=entitiesById.get(ignore);
      let blocker=entitiesById.get(uid);
      if(blocker){
        // Harvest exception: a villager may step onto the sheep/carcass it
        // is working on.
        let harvesting=walker&&walker.target===uid&&(blocker.utype==='sheep'||blocker.utype==='sheep_carcass');
        // Pushables (AoE2 soft-push): sheep yield to anyone; villagers and
        // IDLE soldiers yield to same-team traffic — the walker paths
        // straight through and nudgeAside/separateUnits (js/loop.js) shove
        // the blocker on contact. Fighting/moving/stand-ground soldiers
        // hold ground (melee surround cap stays intact; a commanded army
        // is a wall) — but a PARKED idle soldier must not: an idle army
        // rallied at its own gate used to plug the single exit tile and
        // trap the whole town, itself included, forever. A "stubborn" unit
        // (repeatedly displaced recently — see isStubborn in loop.js)
        // stops yielding: paths route around it, breaking displacement
        // cycles.
        let idleSoldier=MILITARY.has(blocker.utype)&&!blocker.target&&!blocker.task&&
          blocker.path.length===0&&blocker.stance!=='standground';
        // A villager WORKING in place (farming/gathering/building) is pure
        // pass-through for same-side traffic, AoE2-style — never displaced,
        // never blocking, stubbornness irrelevant (it can't dance because
        // nothing moves it; nudgeAside also leaves it alone).
        let workingVillager=blocker.utype==='villager'&&blocker.path.length===0&&
          (blocker.gatherX>=0||blocker.buildTarget);
        let pushable=blocker.utype==='sheep'||
          (walker&&sameSide(walker.team,blocker.team)&&(workingVillager||
            ((blocker.utype==='villager'||idleSoldier)&&!isStubborn(blocker))));
        if(!harvesting&&!pushable)return false;
      }
    }
  }
  let t=map[y][x];
  if(t.t===TERRAIN.FARM)return true;

  let isResource=t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES;
  let blockedByOccupant=t.occupied&&t.occupied!==ignore;
  if(!isResource&&!blockedByOccupant)return true;

  // A building foundation that no builder has started work on yet isn't a
  // real obstacle — anyone (allied or enemy) can walk through it. Once
  // construction has actually begun (buildProgress > 0) it blocks normally.
  if(t.occupied){
    let occ = entitiesById.get(t.occupied);
    if(occ && occ.type === 'building' && !occ.complete && !occ.buildProgress) {
      if (occ.wasWall) return false;
      return true;
    }
    // TC open courtyard: on the 4x4 footprint only the BACK 2x2 stone keep
    // is solid — that is exactly what the art draws (the foundation diamond
    // sits in the back/top quadrant, origin-corner tiles rdx<2 && rdy<2; the
    // open-sided shelter roofs and the front yard fill the other 12 tiles).
    // Everything outside that keep is walkable, so units cross the courtyard
    // and around just the 2x2 keep instead of detouring the whole 4x4, and
    // farmers dock two-deep on the open sides. Tiles stay `occupied` so
    // nothing can be BUILT there; construction sites still block fully.
    if(occ && occ.type === 'building' && occ.btype === 'TC' && occ.complete) {
      let rdx = x - occ.x, rdy = y - occ.y;
      if (rdx >= 2 || rdy >= 2) return true;
    }
    // Farms are flat fields (AoE2): the entire 2x2 plot is walkable ground
    // for anyone — farmers stand on it, armies trample across it. Only the
    // origin tile carries the food; `occupied` still blocks construction.
    if(occ && occ.type === 'building' && occ.btype === 'FARM') return true;
    // Walkable buildings (the Market's open-air plaza): the whole footprint
    // passes units once complete — the stalls are props, not walls. Tiles
    // stay `occupied` so nothing can be BUILT there; construction sites
    // still block fully (same rule as the TC courtyard above).
    if(occ && occ.type === 'building' && occ.complete && BLDGS[occ.btype].walkable) return true;
  }

  // Only resolve the walker entity (a Map lookup) when an exception could
  // actually apply — i.e. the tile would otherwise be blocked. findPath()
  // calls walkable() for every neighbor of every expanded node (up to tens of
  // thousands of times per search), and most of those checks are against
  // plain open/already-passable tiles where this lookup would be wasted.
  let walker=entitiesById.get(ignore);
  // Allow villagers to walk onto the specific resource tile they are working on
  if(walker && walker.gatherX === x && walker.gatherY === y) return true;
  // Allow builders to stand on the building foundation they are constructing
  if(t.occupied && walker && walker.buildTarget === t.occupied) return true;
  if(isResource)return false;

  // Let same-side units (own team or allies) or anyone (if open) pass
  // through gates — UNLESS the gate is locked, which seals the doorway to
  // everyone including the owner (AoE2 gate lock; owner unlocks to pass).
  let bldg = entitiesById.get(t.occupied);
  if (bldg && isGateBtype(bldg.btype)) {
    if (walker && !bldg.locked && (sameSide(walker.team, bldg.team) || bldg.isOpen)) {
      // Only the CENTRE tile of the gate is a doorway. The end tiles sit
      // under the bastion posts and stay solid, so units (and stray sheep
      // that slip through while the gate is open) funnel through the middle
      // instead of standing under a post.
      let horiz = bldg.w >= bldg.h;
      let idx = horiz ? (x - bldg.x) : (y - bldg.y);
      if (idx === Math.floor(Math.max(bldg.w, bldg.h) / 2)) return true;
    }
  }
  return false;
}
function findPath(sx,sy,ex,ey,ignore){
  sx=Math.round(sx);sy=Math.round(sy);ex=Math.round(ex);ey=Math.round(ey);
  if(ex<0)ex=0;if(ey<0)ey=0;if(ex>=MAP)ex=MAP-1;if(ey>=MAP)ey=MAP-1;
  // Only redirect for truly impassable destinations (water, buildings)
  // Resource tiles (forest, gold, stone, berries) are valid destinations
  if(!walkable(ex,ey,ignore)){
    let found=false;
    let t = map[ey] && map[ey][ex];
    let isRes = t && (t.t === TERRAIN.FOREST || t.t === TERRAIN.GOLD || t.t === TERRAIN.STONE || t.t === TERRAIN.BERRIES);
    let maxR = isRes ? 1 : 20;
    for(let r=1;r<=maxR&&!found;r++)for(let dy=-r;dy<=r&&!found;dy++)for(let dx=-r;dx<=r;dx++){
      if(walkable(ex+dx,ey+dy,ignore)){ex+=dx;ey+=dy;found=true;break;}
    }
  }
  // Use a Map for O(1) open-list lookup instead of O(n) linear scan.
  // Extract min-f by linear scan + swap-with-last (O(n)) instead of sort (O(n log n)).
  let startAdx=Math.abs(sx-ex), startAdy=Math.abs(sy-ey);
  let startH=Math.max(startAdx,startAdy)+0.41*Math.min(startAdx,startAdy);
  let startNode={x:sx,y:sy,g:0,h:startH,f:startH,p:null};
  let open=[startNode];
  let openMap=new Array(MAP*MAP);
  openMap[sx+sy*MAP]=startNode;
  let closed=new Uint8Array(MAP*MAP);
  let iters=0;
  // Track the node that got closest to the goal so far. If the search runs out
  // of budget (large/obstructed maps can need more than the iteration cap) we
  // return a partial path toward it instead of giving up with an empty path —
  // this keeps the unit moving towards a far-off destination over multiple legs
  // rather than appearing to ignore the move command entirely.
  let bestNode=startNode;
  while(open.length>0&&iters<MAX_PATH_ITERS){
    iters++;
    let minIdx=0;
    for(let i=1;i<open.length;i++){if(open[i].f<open[minIdx].f)minIdx=i;}
    let cur=open[minIdx];
    open[minIdx]=open[open.length-1];open.pop();
    if(cur.x===ex&&cur.y===ey){
      let path=[];while(cur.p){path.unshift({x:cur.x,y:cur.y});cur=cur.p;}
      return path;
    }
    let ck=cur.x+cur.y*MAP;
    openMap[ck]=undefined;
    closed[ck]=1;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0)continue;
      let nx=cur.x+dx,ny=cur.y+dy;
      if(!walkable(nx,ny,ignore))continue;
      // Block diagonal moves that cut through the gap between two touching obstacles
      if(dx&&dy&&(!walkable(cur.x+dx,cur.y,ignore)||!walkable(cur.x,cur.y+dy,ignore)))continue;
      let k=nx+ny*MAP;
      if(closed[k])continue;
      let g=cur.g+(dx&&dy?1.41:1);
      let existing=openMap[k];
      if(existing){if(g<existing.g){existing.g=g;existing.f=g+existing.h;existing.p=cur;}}
      else{
        let adx=Math.abs(nx-ex),ady=Math.abs(ny-ey);
        let h=Math.max(adx,ady)+0.41*Math.min(adx,ady);
        let node={x:nx,y:ny,g,h,f:g+h,p:cur};
        open.push(node);openMap[k]=node;
        if(h<bestNode.h)bestNode=node;
      }
    }
  }
  // Only fall back to a partial path when the search ran out of iteration
  // budget on a still-growing frontier (the "destination is far away" case
  // multi-leg resume is for). If the open list emptied out on its own, the
  // entire reachable region was fully explored without finding the goal —
  // that's a genuine "no path exists" (walled off / isolated), and callers
  // rely on an empty path here to detect that and give up instead of
  // retrying against the same dead end forever.
  if(iters>=MAX_PATH_ITERS && bestNode!==startNode){
    let path=[];let cur=bestNode;while(cur.p){path.unshift({x:cur.x,y:cur.y});cur=cur.p;}
    return path;
  }
  return[];
}

function clearUnitPath(e){
  e.path=[];
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
  // Explicitly halting movement also cancels any pending long-distance goal,
  // so a unit pulled into combat doesn't later resume walking to a stale spot.
  // followId deliberately survives: combat halts (in-range stop, retaliation)
  // only touch the per-leg pathing, and the follow order resumes after the
  // fight — see the auto-attack note in updateUnit. Explicit new orders clear
  // followId themselves (doCommand in js/input.js).
  e.moveGoalX=undefined;
  e.moveGoalY=undefined;
}

function setUnitPath(e,path){
  e.path=path;
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
  return e.path;
}

function pathUnitTo(e,x,y){
  return setUnitPath(e,findPath(Math.round(e.x),Math.round(e.y),x,y,e.id));
}

// e.speed is tiles per game-second (AoE2 stat). One orthogonal tile step
// covers sqrt(32²+16²) ≈ 35.78 screen px, and there are 30 ticks per
// game-second, so px-per-tick = speed * 35.78/30 ≈ speed * 1.19.
const UNIT_PX_PER_TICK = 1.19;
// Arrows fly a straight tile-space line at this rate (see update() and
// advanceGuestProjectiles — both sides must agree on arrival timing).
const PROJECTILE_TILES_PER_TICK = 0.25;

// THE path-following step — the single source of truth for how a unit
// physically advances along e.path, shared by the host's authoritative
// tick (updateUnit, js/logic.js) and the guest's cosmetic between-sync
// walker + movement prediction (advanceGuestUnits, js/loop.js). These two
// used to be hand-kept duplicates; any drift between them means every
// moving unit rubber-bands on the guest, and the guest's whole prediction
// premise is that its stepping matches the host's EXACTLY.
//
// `distPx`: how many screen-pixels of progress to consume (host: one whole
// tick's worth; guest: fractional, per rendered frame).
// `checkWalkable`: host-only — it re-validates each tile against the live
// block grid, which only the host's update() keeps current; the guest
// passes false and accepts up to one cosmetic half-step into a tile the
// host has since blocked (corrected by the next sync).
// Blocked next step: WAIT for the lane to clear (~1s) instead of dumping
// the path. Clear-and-repath every tick was the wedge/dance generator: in
// a 1-wide lane (forest chokepoints, wall gates) two units repathing into
// each other never move, rack up dodge counts until both turn stubborn
// (hard walls), and freeze until the watchdog breaks them up. Waiting is
// what a real queue does — the blocker almost always moves on within a
// few ticks. moveT is reset so unblocking can't teleport banked progress.
function stepBlocked(e){
  e.moveT=0;
  e.stepWait=(e.stepWait||0)+1;
  if(e.stepWait>30){e.stepWait=0;e.path=[];}
}
function stepUnitAlongPath(e, distPx, checkWalkable){
  e.moveT += distPx;
  while(e.path.length>0){
    let nextTile=e.path[0];
    let p1=toIso(e.fromX,e.fromY), p2=toIso(nextTile.x,nextTile.y);
    let sddx=p2.ix-p1.ix, sddy=p2.iy-p1.iy;
    let screenDist=Math.sqrt(sddx*sddx+sddy*sddy)||1.0;
    if(e.moveT>=screenDist){
      if(checkWalkable && !walkable(nextTile.x,nextTile.y,e.id)){
        stepBlocked(e); return;
      }
      e.moveT-=screenDist;
      let next=e.path.shift();
      e.fromX=next.x;e.fromY=next.y;e.x=next.x;e.y=next.y;
    } else break;
  }
  if(e.path.length>0){
    let next=e.path[0];
    if(checkWalkable && !walkable(next.x,next.y,e.id)){
      stepBlocked(e); return;
    }
    e.stepWait=0;
    let p1=toIso(e.fromX,e.fromY), p2=toIso(next.x,next.y);
    let sddx=p2.ix-p1.ix, sddy=p2.iy-p1.iy;
    let screenDist=Math.sqrt(sddx*sddx+sddy*sddy)||1.0;
    let t=e.moveT/screenDist;
    e.x=e.fromX+(next.x-e.fromX)*t;
    e.y=e.fromY+(next.y-e.fromY)*t;
  }
}

// Use for genuine player "go to this spot" move orders only — NOT for
// gather/build/combat-approach pathing, which already have their own
// per-tick retry logic (see updateGatherTask, the combat-chase code in
// updateUnit) and would otherwise leave moveGoalX stuck on a stale
// resource/attacker position long after that task ends, since nothing
// clears it once e.task/e.target is set (clearUnitPath() is the only thing
// that resets it, and most task-completion paths never call it). A stale
// moveGoalX previously caused two bugs: damageEntity() treating a unit that
// had merely *once* pathed somewhere (e.g. to chop wood) as permanently
// "busy" and skipping retaliation forever, and updateUnit()'s multi-leg
// resume walking an idle unit back toward an old, no-longer-relevant tile.
function issueMoveOrder(e,x,y){
  e.moveGoalX=x;
  e.moveGoalY=y;
  // A plain move RELOCATES a military unit's guard post to the destination
  // ("this is your temp spot") — done here, in the one function every
  // player move order funnels through, so no call site can forget the
  // re-pin. guardFlagged=false: an implicit post, behaviorally identical
  // to a flagged one but drawn without flag visuals (js/render.js).
  // setGuardPost/guardEligible live in js/commands.js (same global scope).
  if (typeof guardEligible === 'function' && guardEligible(e)) setGuardPost(e, x, y, false);
  return pathUnitTo(e,x,y);
}
