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
// The block grid is rebuilt by rebuildBlockAndNudge (js/loop.js) — one fused
// walk also collects the nudge candidates. The grid semantics are unchanged:
// stationary, living, non-garrisoned, non-carcass units block their tile.

// Reused A* scratch — avoids a new Array(MAP²) + Uint8Array(MAP²) on EVERY
// findPath call (27k+ calls/match; ~20k elements each on a large map — a major
// per-tick GC source). Generation-stamped so "clearing" between calls is a
// single counter bump, never an O(MAP²) fill: a cell is closed iff
// _pfClosedGen[k]===_pfGen, and open iff _pfOpenGen[k]===_pfGen (its state in
// the per-tile arrays: findPath). Purely a storage change — the A* algorithm and
// the path it returns are byte-for-byte identical (verified by checksum equality).
let _pfGen=0, _pfClosedGen=null, _pfOpenGen=null, _pfG=null, _pfH=null, _pfP=null, _pfS=null, _pfOpen=null, _pfF=null, _pfT=null, _pfCap=0, _pfWalkGen=null, _pfWalk=null; const _pfW=new Array(9), PF_TREE_AT=128;

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
  // real obstacle — anyone (allied or enemy) can walk through it, whether it
  // was freshly placed or a wall/gate/tower upgraded in place (an upgrade is
  // just a new foundation). Once construction begins (buildProgress > 0) it
  // blocks normally.
  if(t.occupied){
    let occ = entitiesById.get(t.occupied);
    if(occ && occ.type === 'building' && !occ.complete && !occ.buildProgress) {
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
  // AoE2: a resource (tree/gold/stone/berries) is SOLID — villagers gather it
  // from an ADJACENT tile, never by standing on it. (Farms are walkable ground
  // above; sheep are units with their own harvest exception.) This is what
  // caps villagers-per-node and rings them around the tile instead of stacking.
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
// stopDist>0: don't path ONTO (ex,ey) — path to the nearest reachable tile
// WITHIN stopDist of it, and stop there. This is how an attacker approaches to
// its own attack range instead of piling onto the target's tile: melee (~1.5)
// ends up on an adjacent tile, ranged (its range) stops out in an arc. Distinct
// approach directions land on distinct in-range tiles, so a group distributes
// itself around the target with no per-unit-type logic and no forced ring.
// bestEffort: when the goal turns out to be unreachable, return the path to the
// closest tile the search DID reach instead of []. Opt-in — every other caller
// relies on the empty path to mean "no route, give up".
function findPath(sx,sy,ex,ey,ignore,stopDist,goalBldg,claim,bestEffort){
  sx=Math.round(sx);sy=Math.round(sy);ex=Math.round(ex);ey=Math.round(ey);
  if(ex<0)ex=0;if(ey<0)ey=0;if(ex>=MAP)ex=MAP-1;if(ey>=MAP)ey=MAP-1;
  let sd=stopDist||0, sd2=sd*sd;
  // Goal test: the single place the modes differ.
  //   goalBldg — any walkable tile in a target footprint's CONTACT ring (matches
  //     adjToBuilding: edgeDist<=1.2 ⟺ sq<=1.44). A* pops by path cost, so the
  //     first ring tile reached is the one genuinely cheapest to WALK to — the
  //     interior side when the worker is inside, since an outside tile costs a
  //     detour around the wall. No Manhattan/side heuristic, and the tile is
  //     reachable by construction (it's the path returned), so no wedging.
  //     An optional `claim` Set (packed y*MAP+x) excludes tiles peers engaging
  //     the same target already hold, so a crowd fans OUT instead of converging.
  //   stopDist — within a radius of (ex,ey) (ranged attacker approach).
  //   else — an exact tile.
  let inGoal;
  if(goalBldg){
    let bx=goalBldg.x, by=goalBldg.y, bw=goalBldg.w, bh=goalBldg.h;
    // goalBldg + stopDist = a RANGED approach on a footprint: stop within sd of
    // the building's EDGE. Plain stopDist measures to its origin tile, which
    // hides real firing tiles on anything bigger than 1x1.
    let reach2 = sd>0 ? sd2 : 1.44;   // 1.44 = the melee contact ring (edgeDist<=1.2)
    inGoal=(x,y)=>{let dx=Math.max(bx-0.5-x,0,x-(bx+bw-0.5)),dy=Math.max(by-0.5-y,0,y-(by+bh-0.5));return dx*dx+dy*dy<=reach2 && (!claim||!claim.has(y*MAP+x));};
    ex=Math.max(0,Math.min(MAP-1,Math.round(bx+bw/2))); ey=Math.max(0,Math.min(MAP-1,Math.round(by+bh/2))); // heuristic aims at the footprint centre
    if(inGoal(sx,sy))return []; // already adjacent — no move needed
  } else if(sd>0){
    inGoal=(x,y)=>{let dx=x-ex,dy=y-ey;return dx*dx+dy*dy<=sd2;};
    if(inGoal(sx,sy))return []; // already in range — no move needed
  } else {
    inGoal=(x,y)=>x===ex&&y===ey;
    if(!walkable(ex,ey,ignore)){
      // Only redirect for truly impassable destinations (water, buildings)
      // Resource tiles (forest, gold, stone, berries) are valid destinations
      let found=false;
      let t = map[ey] && map[ey][ex];
      let isRes = t && (t.t === TERRAIN.FOREST || t.t === TERRAIN.GOLD || t.t === TERRAIN.STONE || t.t === TERRAIN.BERRIES);
      let maxR = isRes ? 1 : 20;
      for(let r=1;r<=maxR&&!found;r++)for(let dy=-r;dy<=r&&!found;dy++)for(let dx=-r;dx<=r;dx++){
        if(walkable(ex+dx,ey+dy,ignore)){ex+=dx;ey+=dy;found=true;break;}
      }
    }
  }
  // Admissible octile heuristic to the GOAL. For goalBldg the goal is the
  // footprint EDGE, not its centre — measure to the nearest point of the
  // footprint rect. A centre heuristic overestimates by the half-diagonal
  // (inadmissible), which lets A* return a NON-shortest approach and dock on a
  // suboptimal side of the building; the rect distance keeps it shortest-to-
  // nearest-edge (any part of the building is a valid dock).
  let heur;
  if(goalBldg){
    let rx0=goalBldg.x-0.5, rx1=goalBldg.x+goalBldg.w-0.5, ry0=goalBldg.y-0.5, ry1=goalBldg.y+goalBldg.h-0.5;
    heur=(x,y)=>{let dx=Math.max(rx0-x,0,x-rx1), dy=Math.max(ry0-y,0,y-ry1); return Math.max(dx,dy)+0.41*Math.min(dx,dy);};
  } else {
    heur=(x,y)=>{let adx=Math.abs(x-ex),ady=Math.abs(y-ey); return Math.max(adx,ady)+0.41*Math.min(adx,ady);};
  }
  // Use a Map for O(1) open-list lookup instead of O(n) linear scan.
  // Extract min-f by linear scan + swap-with-last (O(n)) instead of sort (O(n log n)).
  // Search state per TILE in typed arrays (a tile holds at most one open entry, so the tile is the node): G cost so
  // far, H its heuristic, P the parent tile (-1: the start), S its open-list slot. The open list is tile keys. The same
  // doubles, the same comparisons, the same order as the object nodes they replace — only no allocation per tile.
  let N=MAP*MAP;
  if(!_pfClosedGen||_pfClosedGen.length!==N){_pfClosedGen=new Int32Array(N);_pfOpenGen=new Int32Array(N);_pfG=new Float64Array(N);_pfH=new Float64Array(N);_pfP=new Int32Array(N);_pfS=new Int32Array(N);_pfGen=0;}
  if(++_pfGen>=2147483647){_pfClosedGen.fill(0);_pfOpenGen.fill(0);if(_pfWalkGen)_pfWalkGen.fill(0);_pfGen=1;} // stamp overflow (astronomically rare) → reset
  let gen=_pfGen;
  const G=_pfG,H=_pfH,P=_pfP,S=_pfS,OG=_pfOpenGen,CG=_pfClosedGen;
  // The open list's min-f pick, as the plain scan made it — the lowest f, and of equal f's the earliest slot (the
  // pop order must not change: determinism) — kept by a tournament tree over the slots: O(log n) a change, not O(n) a
  // pop. F: each slot's f (Infinity when empty); T: each tree node's winning slot (a tie goes left).
  if(!_pfF){_pfCap=1;while(_pfCap<MAX_PATH_ITERS*8+8)_pfCap<<=1;_pfF=new Float64Array(_pfCap).fill(Infinity);_pfT=new Int32Array(2*_pfCap);_pfOpen=new Int32Array(_pfCap);
    for(let i=0;i<_pfCap;i++)_pfT[_pfCap+i]=i; for(let t=_pfCap-1;t>=1;t--)_pfT[t]=_pfT[2*t];}
  const F=_pfF,T=_pfT,cap=_pfCap,open=_pfOpen;
  // A short search (most are) just scans F — the same pick — and only a list past PF_TREE_AT builds the tree.
  let tree=false, hi=0, nOpen=0;                                                    // hi: slots used this call
  // (a level whose winner stands, and isn't slot i itself, leaves everything above as it was: stop there)
  const setF=(i,v)=>{F[i]=v;if(i>=hi)hi=i+1;if(!tree)return;for(let t=(i+cap)>>1;t>=1;t>>=1){const l=T[2*t],r=T[2*t+1],w=F[r]<F[l]?r:l;if(w===T[t]&&w!==i)break;T[t]=w;}};
  const sweep=k=>{let a=cap,b=cap+k-1;while(a>1){a>>=1;b>>=1;for(let t=a;t<=b;t++){const l=T[2*t],rr=T[2*t+1];T[t]=F[rr]<F[l]?rr:l;}}}; // each level over slots 0..k-1
  const pick=n=>{if(tree)return T[1];let m=0,mf=F[0];for(let i=1;i<n;i++)if(F[i]<mf){mf=F[i];m=i;}return m;};
  // on the way out: the slots it used back to empty (the tree, if built, swept back with them)
  const done=r=>{for(let i=0;i<hi;i++)F[i]=Infinity;if(tree)sweep(hi);return r;};
  const trace=k=>{let path=[];while(k!==sk){path.push({x:k%MAP,y:(k/MAP)|0});k=P[k];}return path.reverse();};
  // walkable() per tile, asked once a search (a tile is a neighbour of up to 8 expansions; nothing it reads changes
  // mid-search): stamped by gen. Off the map it's asked straight — never aliased onto a real tile.
  if(!_pfWalkGen||_pfWalkGen.length!==N){_pfWalkGen=new Int32Array(N);_pfWalk=new Uint8Array(N);}
  const walk=(x,y)=>{if(x<0||y<0||x>=MAP||y>=MAP)return false;const k=x+y*MAP;if(_pfWalkGen[k]!==gen){_pfWalkGen[k]=gen;_pfWalk[k]=walkable(x,y,ignore)?1:0;}return _pfWalk[k]===1;};
  // The start may sit off the map (its key then outside the arrays): its coords, g and h are kept here, never read back.
  const sk=sx+sy*MAP, sh=heur(sx,sy);
  G[sk]=0;H[sk]=sh;P[sk]=-1;S[sk]=0;open[0]=sk;nOpen=1;setF(0,sh);OG[sk]=gen;
  let iters=0;
  // Track the node that got closest to the goal so far. If the search runs out
  // of budget (large/obstructed maps can need more than the iteration cap) we
  // return a partial path toward it instead of giving up with an empty path —
  // this keeps the unit moving towards a far-off destination over multiple legs
  // rather than appearing to ignore the move command entirely.
  let bestK=sk;
  while(nOpen>0&&iters<MAX_PATH_ITERS){
    iters++;
    let n=nOpen, minIdx=pick(n);
    let ck=open[minIdx], last=open[n-1];
    open[minIdx]=last;setF(minIdx,F[n-1]);S[last]=minIdx;setF(n-1,Infinity);nOpen--;
    let cx=ck===sk?sx:ck%MAP, cy=ck===sk?sy:(ck/MAP)|0;
    if(inGoal(cx,cy))return done(trace(ck));
    OG[ck]=0; // popped from the open set
    CG[ck]=gen;
    // the 8 neighbours' walkability, each asked once (a diagonal reuses its two sides': the same answers, fewer calls)
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)_pfW[(dy+1)*3+dx+1]=(dx||dy)&&walk(cx+dx,cy+dy);
    const cg=ck===sk?0:G[ck];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0)continue;
      let nx=cx+dx,ny=cy+dy;
      if(!_pfW[(dy+1)*3+dx+1])continue;
      // Block diagonal moves that cut through the gap between two touching obstacles
      if(dx&&dy&&(!_pfW[4+dx]||!_pfW[(dy+1)*3+1]))continue;
      let k=nx+ny*MAP;
      if(CG[k]===gen)continue;
      let g=cg+(dx&&dy?1.41:1);
      if(OG[k]===gen){if(g<G[k]){G[k]=g;P[k]=ck;setF(S[k],g+H[k]);}}
      else{
        let h=heur(nx,ny);
        G[k]=g;H[k]=h;P[k]=ck;S[k]=nOpen;open[nOpen]=k;setF(nOpen,g+h);nOpen++;OG[k]=gen;
        if(!tree&&nOpen>PF_TREE_AT){tree=true;sweep(nOpen);}
        if(h<(bestK===sk?sh:H[bestK]))bestK=k;
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
  // bestEffort callers want that same partial path for the EXHAUSTED case too:
  // "walk as close to it as the terrain allows" (AoE2's answer to an order on a
  // target across water / sealed away).
  if((bestEffort || iters>=MAX_PATH_ITERS) && bestK!==sk)return done(trace(bestK));
  return done([]);
}

function clearUnitPath(e){
  e.path=[];
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
  // KIND-SCOPED order cancel: halting movement ends a MOVE order (a unit
  // pulled into combat must not later resume marching to a stale spot), but
  // every other standing order (guard/escort/follow/scout) survives a path
  // clear — combat halts only touch the per-leg pathing, and those orders
  // resume after the fight. followId likewise deliberately survives.
  if(e.order&&e.order.kind==='move')e.order=null;
}

// THE line-on-the-grid primitive: every tile a straight line from (ax,ay) to (bx,by) passes through, in order (tile t
// spans t-0.5..t+0.5; an exact DDA walk, nothing sampled). visit(tx,ty,px,py) gets each tile entered after the start
// (px,py = the tile it came from: a diagonal step means the line ran exactly through their shared corner); returning
// false stops the walk, and walkLineTiles returns false.
function walkLineTiles(ax,ay,bx,by,visit){
  const ux=ax+0.5, uy=ay+0.5, dx=bx+0.5-ux, dy=by+0.5-uy;
  let cx=Math.floor(ux), cy=Math.floor(uy);
  const ex=Math.floor(bx+0.5), ey=Math.floor(by+0.5), sx=Math.sign(dx), sy=Math.sign(dy);
  const tdx=sx?Math.abs(1/dx):Infinity, tdy=sy?Math.abs(1/dy):Infinity;
  let tmx=sx>0?(cx+1-ux)*tdx:sx<0?(ux-cx)*tdx:Infinity, tmy=sy>0?(cy+1-uy)*tdy:sy<0?(uy-cy)*tdy:Infinity;
  for(let steps=Math.abs(ex-cx)+Math.abs(ey-cy);steps>0&&(cx!==ex||cy!==ey);steps--){ // (each step closes a column or a row)
    const px=cx, py=cy;
    if(tmx<tmy){cx+=sx;tmx+=tdx;} else if(tmy<tmx){cy+=sy;tmy+=tdy;} else {cx+=sx;cy+=sy;tmx+=tdx;tmy+=tdy;}
    if(visit(cx,cy,px,py)===false)return false;
  }
  return true;
}
// Can `e` walk a straight line from (ax,ay) to (bx,by)? Its BODY must fit (UNIT_BODY_R): the centre line enters only
// tiles walkable to `e` — standing units block as they do findPath's (passUnits: the steered character's lines go
// through them, never the dragon's body) — and the two edges of the corridor it sweeps (±UNIT_BODY_R) only open ground,
// so it never grazes a wall or building corner it would clip through (a tile path keeps ≥0.7 from one). A line through a
// corner obeys findPath's diagonal rule: both orthogonal sides open, never squeezing between touching obstacles.
const UNIT_BODY_R = 0.3;
function lineWalkClear(e,ax,ay,bx,by,passUnits){
  const open=(tx,ty,units)=>{
    if(tx<0||ty<0||tx>=MAP||ty>=MAP||!walkable(tx,ty,e.id,!units))return false;
    const b=unitBlock&&entitiesById.get(unitBlock[tx+ty*MAP]); return !(b&&b.utype==='dragon');
  };
  const clear=(x0,y0,x1,y1,units)=>walkLineTiles(x0,y0,x1,y1,(tx,ty,px,py)=>
    open(tx,ty,units)&&(tx===px||ty===py||(open(tx,py,units)&&open(px,ty,units))));
  const dx=bx-ax, dy=by-ay, l=Math.sqrt(dx*dx+dy*dy);
  if(!clear(ax,ay,bx,by,!passUnits))return false;
  if(l===0)return true;
  const nx=-dy/l*UNIT_BODY_R, ny=dx/l*UNIT_BODY_R;
  return clear(ax+nx,ay+ny,bx+nx,by+ny,false)&&clear(ax-nx,ay-ny,bx-nx,by-ny,false);
}
// (character-mode steering: a straight line from where the unit stands to an off-grid point)
function straightWalkClear(e,x,y){ return lineWalkClear(e,e.x,e.y,x,y,true); }
// ANY-ANGLE walking (AoE2): findPath's tile path is an 8-direction staircase. A unit adopting one walks it as straight
// legs instead: from each leg start, the farthest of the following waypoints it can see along a clear line (at most
// SMOOTH_AHEAD on — that bounds the line checks a re-plan pays). The goal is always kept.
const SMOOTH_AHEAD = 10;
function smoothPath(e,path){
  if(path.length<2)return path;
  const out=[]; let ax=e.x, ay=e.y, i=0;
  while(i<path.length){
    let j=i;
    for(let k=i+1;k<path.length&&k<=i+SMOOTH_AHEAD&&lineWalkClear(e,ax,ay,path[k].x,path[k].y);k++)j=k;
    out.push(path[j]); ax=path[j].x; ay=path[j].y; i=j+1;
  }
  return out;
}
function setUnitPath(e,path){
  // A path is planned from the unit's ROUNDED tile; a unit pressed off its tile centre (against the tree it was
  // chopping) can find the straight line from where it really stands clipping a corner that tile-to-tile step clears —
  // the walker then refuses the first step every retry, forever (stuck-watchdog). Step back to its own centre first.
  // (Judged on the SMOOTHED first leg — the one actually walked: a raw first hop clips corners the smoothed leg clears,
  // and a re-pathing chaser was yanked back to its centre every re-plan. Terrain only: a unit in the way is the
  // walker's to wait out, not a reason to back up.)
  let sp=smoothPath(e,path);
  if(sp.length){ const cx=Math.round(e.x), cy=Math.round(e.y);
    if((e.x!==cx||e.y!==cy)&&!(sp[0].x===cx&&sp[0].y===cy)&&!lineWalkClear(e,e.x,e.y,sp[0].x,sp[0].y,true)&&lineWalkClear(e,e.x,e.y,cx,cy,true))
      sp=[{x:cx,y:cy}].concat(sp); }
  e.path=sp;
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
  return e.path;
}
// The tiles a walker will enter next along its path, in order, up to `max` — what's in its way (a leg spans several).
function pathTilesAhead(e,max){
  const out=[]; let ax=e.x, ay=e.y;
  for(const n of e.path){
    if(!walkLineTiles(ax,ay,n.x,n.y,(tx,ty)=>{out.push({x:tx,y:ty}); return out.length<max;}))break;
    ax=n.x; ay=n.y;
  }
  return out;
}

function pathUnitTo(e,x,y){
  return setUnitPath(e,findPath(Math.round(e.x),Math.round(e.y),x,y,e.id));
}
// THE "go to this spot" walk (issueMoveOrder + its multi-leg resume), on
// findPath's bestEffort: AoE2 never ignores the order — an unreachable spot
// walks the unit as close as the terrain allows, then stops. Same for the AI:
// its recall/retreat goals behind a wall would otherwise leave it standing.
function pathUnitToGoal(e,x,y){
  return setUnitPath(e,findPath(Math.round(e.x),Math.round(e.y),x,y,e.id,0,null,null,true));
}
// THE approach primitive: path to the CHEAPEST-to-reach tile in a target
// footprint's contact ring (findPath goalBldg mode). Any unit heading to a
// building/resource thus approaches from whichever side is a shorter walk —
// no straight-line-nearest side bias, reachable by construction. `target` is any
// {x,y,w,h} (a resource tile / unit is {x,y,w:1,h:1}). Optional `claim` Set
// (contactClaims, js/logic.js) makes a crowd fan out; if every contact tile is
// claimed and we're not there yet, overflow by allowing claimed tiles.
function pathToContact(e,target,claim){
  let sx=Math.round(e.x), sy=Math.round(e.y);
  let path=findPath(sx,sy,target.x,target.y,e.id,0,target,claim);
  if(claim && !path.length && edgeDistToBuilding(e.x,e.y,target)>1.2)
    path=findPath(sx,sy,target.x,target.y,e.id,0,target);
  return setUnitPath(e,path);
}
// Path a unit to INTERACT with a building: onto a FARM plot (walkable — the
// villager stands on it), else the cheapest contact tile (pathToContact). THE
// build/repair/dropoff approach, AI and player alike.
// Co-builders' claims fan a crew out: each takes the nearest contact (or plot) tile nobody else holds.
function pathToBuilding(e,bldg){
  let claim=contactClaims(e,p=>p.task==='build'&&p.buildTarget===bldg.id);
  if(bldg.btype!=='FARM'){
    // Builders ring the site from OUTSIDE (AoE2): its own footprint is walkable to them but never a stand tile.
    for(let y=bldg.y;y<bldg.y+bldg.h;y++)for(let x=bldg.x;x<bldg.x+bldg.w;x++)claim.add(y*MAP+x);
    return pathToContact(e,bldg,claim);
  }
  // Farm: the nearest unclaimed plot tile (all claimed → the nearest), row order breaking ties.
  let best=null,bd=Infinity,bestAny=null,bdAny=Infinity;
  for(let y=bldg.y;y<bldg.y+bldg.h;y++)for(let x=bldg.x;x<bldg.x+bldg.w;x++){
    let d=(x-e.x)*(x-e.x)+(y-e.y)*(y-e.y);
    if(d<bdAny){bdAny=d;bestAny={x,y};}
    if(d<bd&&!claim.has(y*MAP+x)){bd=d;best={x,y};}
  }
  let t=best||bestAny;
  return pathUnitTo(e,t.x,t.y);
}

// e.speed is tiles per game-second (AoE2 stat). One orthogonal tile step
// covers sqrt(32²+16²) ≈ 35.78 screen px and there are TPS ticks per
// game-second. The historical shipped constant was the ROUNDED 1.19 at
// 30tps (not 35.78/30 = 1.19267) — scale THAT basis, and as 1.19*(30/TPS),
// so TPS=30 reproduces the original value bit-for-bit (30/30 is exactly 1).
const UNIT_PX_PER_TICK = 1.19 * (30 / TPS);
// Arrows fly a straight tile-space line at this rate (see update() and
// advanceGuestProjectiles — both sides must agree on arrival timing).
// 7.5 tiles per game-second (0.25/tick on the original 30tps clock).
const PROJECTILE_TILES_PER_TICK = 7.5 / TPS;

// THE path-following step — the single source of truth for how a unit
// physically advances along e.path, shared by the host's authoritative
// tick (updateUnit, js/logic.js) and the guest's cosmetic between-sync
// walker + movement prediction (advanceGuestUnits, js/loop.js). These two
// used to be hand-kept duplicates; any drift between them means every
// moving unit rubber-bands on the guest, and the guest's whole prediction
// premise is that its stepping matches the host's EXACTLY.
//
// `distPx`: how many walk-px of progress to consume (legPx; host: one whole
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
  e.fromX=e.x; e.fromY=e.y; // the leg resumes from where it stands: with the progress zeroed, measured from the old
  e.moveT=0;                // leg start it snapped back there
  e.stepWait=(e.stepWait||0)+1;
  if(e.stepWait>T30(30)){e.stepWait=0;e.path=[];}
}
// A leg's length in walk "px": its WORLD length in tiles × one orthogonal tile's px (√(32²+16²)), so a unit has one
// ground speed in every direction (AoE2; the isometric view only projects it). Measured on screen, one diagonal walked
// 1.58× and the other 0.79× the straight-line speed. Orthogonal legs are exactly what they were.
const TILE_PX = Math.sqrt(HALF_TW * HALF_TW + HALF_TH * HALF_TH);
function legPx(ax,ay,bx,by){
  let dx=bx-ax, dy=by-ay;
  return Math.sqrt(dx*dx+dy*dy)*TILE_PX||1.0;
}
function stepUnitAlongPath(e, distPx, checkWalkable){
  // Where this advance takes it, finishing legs on the way…
  const P=e.path, pts=[e.x,e.y]; let moveT=e.moveT+distPx, fx=e.fromX, fy=e.fromY, x=e.x, y=e.y, done=0;
  while(done<P.length){
    const n=P[done], L=legPx(fx,fy,n.x,n.y);
    if(moveT>=L){ moveT-=L; fx=x=n.x; fy=y=n.y; done++; pts.push(x,y); }
    else { const t=moveT/L; x=fx+(n.x-fx)*t; y=fy+(n.y-fy)*t; break; }
  }
  pts.push(x,y);
  // …and every tile it would step into on the way: one taken, it waits where it stands (stepBlocked).
  if(checkWalkable){
    for(let i=0;i+3<pts.length;i+=2){
      if(!walkLineTiles(pts[i],pts[i+1],pts[i+2],pts[i+3],(tx,ty)=>walkable(tx,ty,e.id))){ stepBlocked(e); return; }
    }
  }
  if(P.length)e.stepWait=0;
  if(done)P.splice(0,done);
  e.moveT=moveT; e.fromX=fx; e.fromY=fy; e.x=x; e.y=y;
}

// Tiles/tick this unit is CURRENTLY moving (null when settled). Mirrors
// stepUnitAlongPath exactly: the walker advances distPx along the ISO segment,
// so the tile-space rate is that distance scaled by the leg's tile-length over
// its screen-length. Ballistics (spawnProjectile) leads its aim by this.
// sqrt + arithmetic only — no trig, no PRNG, safe inside the tick.
function unitVelocityPerTick(e){
  if(!e.path || e.path.length===0) return null;
  let next=e.path[0];
  let tdx=next.x-e.x, tdy=next.y-e.y;
  let tileLen=Math.sqrt(tdx*tdx+tdy*tdy);
  if(tileLen<0.000001) return null;
  let legLen=legPx(e.fromX,e.fromY,next.x,next.y);
  let ldx=next.x-e.fromX, ldy=next.y-e.fromY;
  let legTile=Math.sqrt(ldx*ldx+ldy*ldy)||1.0;
  let step=unitMoveSpeed(e)*UNIT_PX_PER_TICK*legTile/legLen;   // tiles per tick
  return {vx:tdx/tileLen*step, vy:tdy/tileLen*step};
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
  // A goal on the dragon's body (a formation slot, a click on it) can never be reached — the unit ahead would stall
  // on the ring forever: moved out past its edge, on that side (a unit ordered onto its very centre: toward the unit).
  for(let i=0;i<entities.length;i++){ let d=entities[i];
    if(d.utype!=='dragon'||d.hp<=0||!inDragonBody(d,x,y,0.35))continue;
    let dx=x-d.x, dy=y-d.y, l=Math.sqrt(dx*dx+dy*dy);
    if(l<0.5){ dx=e.x-d.x; dy=e.y-d.y; l=Math.sqrt(dx*dx+dy*dy)||1; }
    let r=dragonBodyRadius(d,d.x+dx,d.y+dy)+1;
    x=Math.round(d.x+dx/l*r); y=Math.round(d.y+dy/l*r);
  }
  // Clamped like the anchor below: edge-of-map formation offsets produce
  // off-map goals findPath silently clamps — an unclamped goal then never
  // matches the arrival tile, so the "arrived, clear order" check churned
  // repaths until the empty-path fallback cleared it. issueOrder lives in
  // js/commands.js (same global scope).
  issueOrder(e, {kind:'move', x:Math.max(0,Math.min(MAP-1,x)), y:Math.max(0,Math.min(MAP-1,y))});
  // A plain move sets the unit's ANCHOR (defendX/Y) to the destination. The
  // anchor only means something to DEFENSIVE stance (scoped acquire + 6-tile
  // leash, js/logic.js); aggressive units chase freely and stand where the
  // fight ends. Guard posts don't relocate — the move order issued above
  // REPLACED any standing order (last order wins).
  e.defendX=Math.max(0,Math.min(MAP-1,x)); e.defendY=Math.max(0,Math.min(MAP-1,y)); // clamped — formation offsets at the edge go off-map
  return pathUnitToGoal(e,x,y);
}
