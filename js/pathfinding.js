// ---- PATHFINDING (A*) ----
// Raised from the original 800 so long-distance/obstructed routes on bigger
// maps (90/120 tiles) can still find a full path instead of capping out early.
const MAX_PATH_ITERS=2200;
function walkable(x,y,ignore){
  if(x<0||x>=MAP||y<0||y>=MAP)return false;
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

  // Let friendly units or anyone (if open) pass through gates
  let bldg = entitiesById.get(t.occupied);
  if (bldg && bldg.btype === 'GATE') {
    if (walker && (walker.team === bldg.team || bldg.isOpen)) {
      return true;
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
  e.moveGoalX=undefined;
  e.moveGoalY=undefined;
  e.followId=undefined;
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
  return pathUnitTo(e,x,y);
}
