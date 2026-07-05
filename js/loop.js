// ---- MAIN LOOP ----
function update(){
  if(gameOver||!gameStarted)return;
  detEnterSim(); // no-op unless DET.strict — traps un-migrated Math.random in sim code
  tick++;

  // Update gate open/close states (smoke/fire moved to updateCosmetics —
  // purely visual, so it runs at frame cadence outside the deterministic
  // sim tick and needs no lockstep agreement or rollback treatment)
  entities.forEach(e => {
    if (e.type === 'building') {
      if (e.btype === 'GATE' && e.complete) {
        let friendlyNear = entities.some(en => en.type === 'unit' && en.team === e.team && 
          en.x >= e.x - 1.2 && en.x <= e.x + e.w + 0.2 && 
          en.y >= e.y - 1.2 && en.y <= e.y + e.h + 0.2);
        e.gateProgress = e.gateProgress || 0;
        if (friendlyNear) {
          e.gateProgress = Math.min(1.0, e.gateProgress + 0.08);
        } else {
          e.gateProgress = Math.max(0.0, e.gateProgress - 0.08);
        }
        e.isOpen = e.gateProgress > 0.5;
      }
    }
  });

  // Update projectiles: each arrow flies to its fixed aim point (see
  // spawnProjectile). On impact it damages the building it was shot at, or
  // whatever enemy unit is standing at the landing spot — a target that
  // moved away (or garrisoned) is simply missed, AoE2-style.
  let remainingProjectiles = [];
  projectiles.forEach(p => {
    let dx = p.tx - p.x;
    let dy = p.ty - p.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    let speed = PROJECTILE_TILES_PER_TICK; // shared with the guest's cosmetic flight (js/pathfinding.js)
    if (dist <= speed) {
      // Prefer the live shooter (current stats); fall back to the spawn-time
      // snapshot if it died mid-flight — the arrow still lands (AoE2-style).
      let shooter = entitiesById.get(p.attackerId) || p.attackerSnap;
      if (p.targetBuildingId) {
        let b = entitiesById.get(p.targetBuildingId);
        if (b && b.hp > 0) damageEntity(shooter, b);
      } else {
        let victim = null, vd = 0.45;
        entities.forEach(en => {
          if (en.type !== 'unit' || en.team === shooter.team || en.hp <= 0 || en.garrisonedIn) return;
          let idx = en.x - p.tx, idy = en.y - p.ty;
          let d = Math.sqrt(idx*idx + idy*idy);
          if (d < vd) { vd = d; victim = en; }
        });
        if (victim) damageEntity(shooter, victim);
      }
    } else {
      p.x += (dx / dist) * speed;
      p.y += (dy / dist) * speed;
      remainingProjectiles.push(p);
    }
  });
  projectiles = remainingProjectiles;

  updateFog(); // Update Fog of War visibility grid
  updateTeamExploredEver(1); // js/core.js — host-only: remembers team 1's (the guest's) explored history

  // Remember enemy buildings the moment any of their tiles is actively
  // visible. This must live in the game loop, NOT the render pass: the
  // renderer viewport-culls, so buildings scouted while the camera was
  // elsewhere never got marked scouted and stayed invisible on the main
  // map even though the minimap (which ignores culling) showed them.
  markScoutedBuildings(); // js/core.js — also called guest-side in js/net-sync.js

  rebuildUnitBlock(); // stationary-unit collision grid (see pathfinding.js)
  nudgeAside(); // villagers/sheep STEP OUT of approaching traffic's way

  let current=[...entities];
  current.forEach(e=>{
    if(entitiesById.has(e.id)){
      if(e.type==='unit')updateUnit(e);
      else updateBuilding(e);
    }
  });
  separateUnits();
  updateStuckWatchdog(); // js/logic.js — general safety net over every task/path state machine
  refreshPopulationCounts();
  // Team 1 is AI-controlled only in single-player. The moment "Host Game"
  // is clicked (netRole set), a human guest replaces the AI on team 1 —
  // gated on netRole itself (not just "no guest connected yet") so the AI
  // doesn't get to make irreversible decisions (spend resources, queue
  // units) on team 1 during the waiting-for-opponent window either.
  if (netRole == null) {
    updateAIGarrisonReaction(); // every tick, independent of the AI's slower decision cadence
    updateAI();
  }
  refreshPopulationCounts();

  // Multiplayer: broadcast a world snapshot to a connected guest at
  // roughly NET_SYNC_TARGET_PER_SEC real syncs/sec, whatever GAME_SPEED is
  // set to (see js/net-sync.js) — no-op (netRole stays null) in
  // single-player. Recomputed each tick rather than cached since
  // GAME_SPEED can change mid-match (the in-game menu allows it).
  if (netRole === 'host' && netConnected) {
    let netSyncIntervalTicks = Math.max(1, Math.round(30 * GAME_SPEED / NET_SYNC_TARGET_PER_SEC));
    if (tick % netSyncIntervalTicks === 0) hostSyncTick();
  }
  detExitSim();
  if (DET.enabled) detAfterTick();
}

// Guest-only, called from gameLoop() (js/init.js) once per rendered frame
// instead of the tick-locked block above — cosmetic position-only flight,
// no damage resolution (the host already resolved that the instant a shot
// landed). Keeps arrows flying smoothly between syncs instead of only
// moving in visible ~6x/sec jumps like everything else the guest doesn't
// locally simulate.
//
// Also owns REMOVAL on arrival now: since js/net-sync.js only ever sends a
// NEW projectile once (never a wholesale replace on every delta sync — see
// buildSyncPayload's comment), nothing else ever prunes an arrived one from
// this list. Uses the exact same distance/speed arrival test as the host's
// own authoritative removal (js/loop.js's update()), so both sides agree on
// when a shot has landed even though only the guest is the one dropping its
// own local copy here.
function advanceGuestProjectiles(elapsedMs){
  if (!guestSyncIsFresh()) return; // see guestSyncIsFresh below
  let speed = PROJECTILE_TILES_PER_TICK * (elapsedMs / timeStep); // same rate as the authoritative update above
  let remaining = [];
  projectiles.forEach(p => {
    let dx = p.tx - p.x, dy = p.ty - p.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    if (dist <= speed || dist === 0) return; // arrived — drop it, matching the host's own removal
    p.x += (dx / dist) * speed; p.y += (dy / dist) * speed;
    remaining.push(p);
  });
  projectiles = remaining;
}

// Extrapolation is only trustworthy for a sync interval or two past the
// last applied sync (~65ms apart when healthy). If syncs stop arriving
// (network hiccup, wedged stream awaiting the resync watchdog in
// js/net-sync.js), the guest's cosmetic walkers freeze the world at its
// last known-good state rather than confidently walking units through
// walls / flying arrows past targets into ever-larger corrections.
function guestSyncIsFresh(){
  return !(lastSyncAppliedAt && performance.now() - lastSyncAppliedAt > 500);
}

// Guest-only, same pattern as advanceGuestProjectiles above but for unit
// walking — the far more visually obvious "teleports every sync" case.
// The actual stepping math is stepUnitAlongPath (js/pathfinding.js), the
// SAME function the host's authoritative updateUnit runs — guaranteed
// identical movement on both sides, which the guest's command prediction
// (js/input.js) depends on. Only ever touches x/y/fromX/fromY/moveT/path —
// never target/hp/cooldowns/task fields. checkWalkable=false: the block
// grid is only current on the host; worst case the guest renders up to one
// extra half-step into a tile the host has since blocked, corrected by the
// very next sync.
function advanceGuestUnits(elapsedMs){
  if (!guestSyncIsFresh()) return;
  // Correction smoothing: applyNetSync (js/net-sync.js) records the visual
  // displacement between where this client was RENDERING a unit and the
  // host's authoritative position as smoothX/smoothY, instead of moving the
  // unit instantly. Each frame the offset is applied on top of the stepped
  // position and exponentially decayed (~180ms time constant), so under
  // network jitter corrections glide instead of jumping. Invariants:
  //  - path units: stepUnitAlongPath recomputes x/y from fromX/moveT every
  //    frame, so the offset is re-added after stepping (never accumulates).
  //  - stationary units: x/y already include the offset (applyNetSync sets
  //    x = auth + smooth), so decaying subtracts the removed portion.
  let k = Math.min(1, elapsedMs / 180);
  entities.forEach(e => {
    if(e.type!=='unit'||e.garrisonedIn||e.hp<=0)return;
    let hasSmooth = (e.smoothX || e.smoothY);
    if (e.path.length > 0) {
      stepUnitAlongPath(e, e.speed * UNIT_PX_PER_TICK * (elapsedMs / timeStep), false);
      if (hasSmooth) {
        e.smoothX = (e.smoothX || 0) * (1 - k);
        e.smoothY = (e.smoothY || 0) * (1 - k);
        e.x += e.smoothX;
        e.y += e.smoothY;
      }
    } else if (hasSmooth) {
      let dx = (e.smoothX || 0) * k, dy = (e.smoothY || 0) * k;
      e.x -= dx; e.y -= dy;
      e.smoothX = (e.smoothX || 0) - dx;
      e.smoothY = (e.smoothY || 0) - dy;
    }
    if (hasSmooth && Math.abs(e.smoothX) < 0.005 && Math.abs(e.smoothY) < 0.005) {
      e.smoothX = 0; e.smoothY = 0;
    }
  });
}

// ---- COSMETIC FRAME UPDATE (both roles) ----
// Everything here is visual-only state the sim never reads: it runs at
// frame cadence from gameLoop() on host AND guest, OUTSIDE the
// deterministic sim tick — so it needs no lockstep agreement, no checksum
// coverage, and no rollback treatment (see js/determinism.js). Frame-scaled
// via elapsedMs/timeStep so it's frame-rate independent.
function updateCosmetics(elapsedMs){
  advanceParticles(elapsedMs);
  updateBuildingDamageFx();
}

// Particle physics: position/drag/gravity/ground-bounce/life countdown.
function advanceParticles(elapsedMs){
  let steps = elapsedMs / timeStep;
  particles.forEach(p => {
    p.x += p.vx * steps;
    p.y += p.vy * steps;
    if (p.drag) {
      let dragStep = Math.pow(p.drag, steps);
      p.vx *= dragStep;
      p.vy *= dragStep;
    }
    if (p.z !== undefined) {
      p.z += p.vz * steps;
      p.vz -= p.gravity * steps;
      if (p.z <= 0) {
        p.z = 0;
        if (p.type === 'blood') {
          p.vx = 0; p.vy = 0; p.vz = 0;
        } else if ((p.type === 'dust' || p.type === 'grass') && p.vz < -0.005) {
          p.vz = -p.vz * 0.45;
          p.vx *= 0.6;
          p.vy *= 0.6;
        } else {
          p.vz = 0;
        }
      }
    }
    p.life -= steps;
  });
  particles = particles.filter(p => p.life > 0);
}

// Damaged-building smoke/fire, re-derived each frame from hp/maxHp —
// these particles are never networked. buildingFxTick (per-entity,
// per-effect last-fired tick) throttles to once per interval: the host's
// tick is an integer, but a guest's advances fractionally per frame
// (js/init.js), where a bare `tick % N` check would re-fire across many
// consecutive frames.
function updateBuildingDamageFx(){
  let t = Math.floor(tick);
  entities.forEach(e => {
    if (e.type !== 'building' || !e.complete) return;
    let rec = buildingFxTick.get(e.id);
    if (!rec) { rec = {smoke: -999, fire: -999}; buildingFxTick.set(e.id, rec); }
    if (e.hp < e.maxHp * 0.7 && t - rec.smoke >= 5) {
      rec.smoke = t;
      spawnParticles(e.x + e.w/2 + (cosmeticRandom() - 0.5)*0.5, e.y + e.h/2 + (cosmeticRandom() - 0.5)*0.5, 'rgba(100,100,100,0.5)', 1, 0.015, 3);
    }
    if (e.hp < e.maxHp * 0.3 && t - rec.fire >= 3) {
      rec.fire = t;
      spawnParticles(e.x + e.w/2 + (cosmeticRandom() - 0.5)*0.5, e.y + e.h/2 + (cosmeticRandom() - 0.5)*0.5, cosmeticRandom() < 0.4 ? '#ff4500' : '#ffd700', 1, 0.02, 2.5);
    }
  });
}

// AoE2-style "excuse me": a stationary villager/sheep standing on a moving
// unit's NEXT tile takes a polite sidestep of its own accord — it is not
// shoved. Task fields survive the step (gather/build logic re-paths back
// once traffic has passed). Soldiers never step aside, and units locked on
// a target (fighting, harvesting a carcass) hold their spot — the mover
// simply passes through them transiently instead.
function nudgeAside(){
  entities.forEach(m=>{
    if(m.type!=='unit'||m.garrisonedIn||m.hp<=0||m.path.length===0)return;
    let next=m.path[0];
    if(next.x<0||next.x>=MAP||next.y<0||next.y>=MAP)return;
    let uid=unitBlock?unitBlock[next.x+next.y*MAP]:0;
    if(!uid||uid===m.id)return;
    let s=entitiesById.get(uid);
    if(!s||s.hp<=0)return;
    let pushable=s.utype==='sheep'||(s.utype==='villager'&&s.team===m.team);
    if(!pushable||s.target)return;
    if(tick-(s.lastDodgeTick||0)<30)return; // don't jitter between two movers
    // Anti-dance: a unit that keeps getting displaced (3+ dodges in ~10s)
    // digs its heels in and stops yielding — isStubborn() below also makes
    // it non-pushable, so the traffic re-routes around it instead. This
    // breaks the endless "polite waltz" where two villagers displace each
    // other forever (dodge → task re-path → counter-dodge → …), while
    // one-off step-asides and the anti-trapping behavior stay intact.
    if(isStubborn(s))return;
    if(tick-(s.lastDodgeTick||0)>=300)s.dodgeCount=0; // peace resets the tally
    // Step to an adjacent free tile that isn't on the mover's onward path,
    // and never onto the mover's OWN tile — movers don't register in the
    // block grid, so that tile looks free but is a guaranteed swap-collision
    // (the classic trigger for the dance above).
    let onward=new Set(m.path.slice(0,3).map(p=>p.x+','+p.y));
    onward.add(Math.round(m.x)+','+Math.round(m.y));
    let best=null;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy)continue;
      let nx=next.x+dx,ny=next.y+dy;
      if(onward.has(nx+','+ny))continue;
      if(!walkable(nx,ny,s.id,true))continue;
      if(unitBlock[nx+ny*MAP]&&unitBlock[nx+ny*MAP]!==s.id)continue;
      let d=Math.abs(dx)+Math.abs(dy);
      if(!best||d<best.d)best={x:nx,y:ny,d};
    }
    if(best){
      s.lastDodgeTick=tick;
      s.dodgeCount=(s.dodgeCount||0)+1;
      setUnitPath(s,[{x:best.x,y:best.y}]); // a walked step, not a teleport/shove
    }
  });
}

// True while a much-displaced unit is holding its ground (see nudgeAside):
// it won't step aside and walkable() treats it as a hard obstacle so paths
// route around it. Wears off after ~10s without being harassed.
function isStubborn(u){
  return (u.dodgeCount||0)>=3 && tick-(u.lastDodgeTick||0)<300;
}

// Soft unit separation: push overlapping units apart (AoE2 collision).
// Sheep are included so flocks keep natural spacing; carcasses are terrain.
// This is now only the OVERLAP resolver of last resort — the polite
// step-aside above handles normal traffic, so gatherers are never slid.
function separateUnits(){
  let units=entities.filter(e=>e.type==='unit'&&!e.garrisonedIn&&e.utype!=='sheep_carcass');
  let sep=0.08;
  let minDist=0.5;
  // Per-unit flag computed once — the old all-pairs loop recomputed it,
  // including an entitiesById lookup, for every PAIR (n²/2 times per tick).
  // Skip units actively gathering on a resource tile, building, or harvesting a sheep carcass
  let gathering=units.map(a=>
    (a.gatherX >= 0 && a.path.length === 0) ||
    (a.buildTarget !== null && a.path.length === 0) ||
    (a.target !== null && a.path.length === 0 && entitiesById.get(a.target)?.utype === 'sheep_carcass'));
  // Spatial hash on 1-tile cells: only same-or-adjacent-cell units can be
  // within minDist (0.5), so each unit compares against its 3×3 cell
  // neighborhood instead of every other unit on the map. The j>i guard keeps
  // each pair processed exactly once, like the old triangular loop.
  let cells=new Map();
  for(let i=0;i<units.length;i++){
    let u=units[i];
    let key=(u.x|0)*4096+(u.y|0);
    let arr=cells.get(key);
    if(!arr)cells.set(key,arr=[]);
    arr.push(i);
  }
  let processPair=(i,j)=>{
    let a=units[i], b=units[j];
    let aGathering=gathering[i], bGathering=gathering[j];
    let dx=a.x-b.x, dy=a.y-b.y;
    let d=Math.sqrt(dx*dx+dy*dy);
    if(d<minDist&&d>0.01){
      let push=sep*(minDist-d)/d;
      let px=dx*push, py=dy*push;
      // ignoreUnits=true: the overlapping units being separated must not
      // count each other's block-grid entries as walls.
      if(a.path.length===0&&!aGathering){
        let nax=a.x+px, nay=a.y+py;
        if(walkable(Math.round(nax),Math.round(nay),a.id,true)){a.x=nax;a.y=nay;}
      }
      if(b.path.length===0&&!bGathering){
        let nbx=b.x-px, nby=b.y-py;
        if(walkable(Math.round(nbx),Math.round(nby),b.id,true)){b.x=nbx;b.y=nby;}
      }
    } else if(d<=0.01){
      if(a.path.length===0&&!aGathering){
        let nax=a.x+simRandom()*0.3-0.15;
        let nay=a.y+simRandom()*0.3-0.15;
        if(walkable(Math.round(nax),Math.round(nay),a.id,true)){a.x=nax;a.y=nay;}
      }
      if(b.path.length===0&&!bGathering){
        let nbx=b.x+simRandom()*0.3-0.15;
        let nby=b.y+simRandom()*0.3-0.15;
        if(walkable(Math.round(nbx),Math.round(nby),b.id,true)){b.x=nbx;b.y=nby;}
      }
    }
  };
  for(let i=0;i<units.length;i++){
    let cx=units[i].x|0, cy=units[i].y|0;
    for(let ndy=-1;ndy<=1;ndy++)for(let ndx=-1;ndx<=1;ndx++){
      let gx=cx+ndx, gy=cy+ndy;
      if(gx<0||gy<0)continue;
      let arr=cells.get(gx*4096+gy);
      if(!arr)continue;
      for(let k=0;k<arr.length;k++){
        if(arr[k]>i)processPair(i,arr[k]);
      }
    }
  }
}
