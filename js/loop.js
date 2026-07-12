// ---- MAIN LOOP ----
function update(){
  if(gameOver||!gameStarted)return;
  detEnterSim(); // no-op unless DET.strict — traps un-migrated Math.random in sim code
  tick++;
  // Execute every command stamped for this tick, in canonical (team, seq)
  // order — the ONLY entry point for player mutations (js/commands.js).
  runScheduledCommands();

  // Update gate open/close states (smoke/fire moved to updateCosmetics —
  // purely visual, so it runs at frame cadence outside the deterministic
  // sim tick and needs no lockstep agreement or rollback treatment).
  // Was O(gates × entities) — a full entities.some() per gate per tick.
  // Now: skip outright with no gates (the common case), otherwise index
  // units into 1-tile cells once and run the EXACT same rect predicate on
  // just the cells overlapping each gate's sensing rect. Boolean any-match
  // is order-independent, so behavior (and lockstep determinism) is
  // unchanged.
  updateGates();

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
          if (en.type !== 'unit' || sameSide(en.team, shooter.team) || en.hp <= 0 || en.garrisonedIn) return; // no ally friendly fire
          if (en.utype === 'sheep' || en.utype === 'sheep_carcass') return; // arrows don't burn food (matches tower target acquisition)
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

  updateTeamVision(); // deterministic per-team visibility for SIM reads (js/core.js)
  // Viewer-local work — skipped by the headless self-play simulator
  // (tools/sim.html): fog and explored-ever memory are render/save-side
  // only, never read by the sim, and cost real per-tick time at scale.
  if (!window.__headlessSim) {
    updateFog(); // Update Fog of War visibility grid (viewer-local, render/UI only)
  }

  // Remember enemy buildings the moment any of their tiles is actively
  // visible. This must live in the game loop, NOT the render pass: the
  // renderer viewport-culls, so buildings scouted while the camera was
  // elsewhere never got marked scouted and stayed invisible on the main
  // map even though the minimap (which ignores culling) showed them.
  // Viewer-local memory of scouted enemy buildings — skip in headless self-play
  // (no viewer, no minimap), like updateFog above. Also called guest-side in net-sync.js.
  if (!window.__headlessSim) markScoutedBuildings(); // js/core.js

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
  // Run every AI-controlled team's brain. Which teams those are is DATA
  // (teamControllers, js/core.js): clicking "Host Game" flips slot 1 to
  // human before any guest connects (see onHostClicked), so the AI can't
  // make irreversible decisions during the waiting-for-opponent window.
  // Deterministic: AI state is per-team plain data (AI_STATES) that rides
  // the lockstep snapshots, so an AI team would simulate identically on
  // every peer — a controllers change away, no netRole check needed here.
  if (AI_STATES) {
    for (let t = 0; t < NUM_TEAMS; t++) {
      if (!isAITeam(t)) continue;
      if (!AI_STATES[t]) AI_STATES[t] = freshAIState(t);
      updateAIGarrisonReaction(AI_STATES[t]); // every tick, independent of the AI's slower decision cadence
      updateAI(AI_STATES[t]);
    }
  }
  refreshPopulationCounts();

  // Headless self-play never runs render() (js/render.js), the only place
  // corpses (cosmetic, wall-clock lifetimed) get pruned — so trim them here by
  // tick age to bound memory over long simulated matches. No-op with UI.
  if (window.__headlessSim && corpses.length) {
    corpses = corpses.filter(c => tick - (c.deathTick || 0) < CORPSE_LIFE_TICKS);
  }

  detExitSim();
  if (DET.enabled) detAfterTick();
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
  // Periodic sweep of per-entity cosmetic bookkeeping keyed by id — these
  // Maps/Sets otherwise keep entries for every unit/building that ever
  // died over a whole match (slow leak on long games).
  if ((Math.floor(tick) % 600) === 0 && !window.__cosmeticSweepDone) {
    window.__cosmeticSweepDone = true;
    buildingFxTick.forEach((_, id) => { if (!entitiesById.has(id)) buildingFxTick.delete(id); });
    workSwingCycles.forEach((_, id) => { if (!entitiesById.has(id)) workSwingCycles.delete(id); });
    // Per-entity render caches keyed by entity id (render-units.js / render.js):
    // these previously only cleared on a MAP-size change, so every dead
    // vehicle/gate/market/farm leaked an entry for the whole session.
    if (typeof ramCreakCycles !== 'undefined') ramCreakCycles.forEach((_, id) => { if (!entitiesById.has(id)) ramCreakCycles.delete(id); });
    if (typeof _gateProxyPool !== 'undefined') _gateProxyPool.forEach((_, id) => { if (!entitiesById.has(id)) _gateProxyPool.delete(id); });
    if (typeof _marketProxyPool !== 'undefined') _marketProxyPool.forEach((_, id) => { if (!entitiesById.has(id)) _marketProxyPool.delete(id); });
    if (typeof _farmProxyPool !== 'undefined') _farmProxyPool.forEach((_, id) => { if (!entitiesById.has(id)) _farmProxyPool.delete(id); });
    let liveCorpses = new Set(corpses.map(c => c.id));
    corpseImpactFxDone.forEach(id => { if (!liveCorpses.has(id)) corpseImpactFxDone.delete(id); });
  } else if ((Math.floor(tick) % 600) !== 0) {
    window.__cosmeticSweepDone = false;
  }
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
    // Sheep and villagers actively DODGE (step aside). Idle soldiers are
    // deliberately NOT in this set even though walkable() lets friendly
    // traffic path through them: giving 50 clustered soldiers dodge steps
    // turned the town square into a dodge/repath storm (each dodge briefly
    // makes the soldier a blocking mover, forcing everyone else to repath —
    // an infinite dance that also ate the tick budget). Movers walk through
    // them; separateUnits resolves the momentary overlap softly.
    let pushable=s.utype==='sheep'||(s.utype==='villager'&&sameSide(s.team,m.team));
    if(!pushable||s.target)return;
    // Never dodge a villager that's WORKING in place (farming/gathering/
    // building): walkable() lets traffic pass straight through it instead
    // (AoE2 farmers don't obstruct). Dodging it off its tile broke the work
    // loop — it walked back, got dodged again, an infinite dance that never
    // resumed farm duty.
    if(s.utype==='villager'&&s.path.length===0&&(s.gatherX>=0||s.buildTarget))return;
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

// Gate open/close sensing — see the call site at the top of update().
function updateGates(){
  let gates = null;
  for (let i = 0; i < entities.length; i++) {
    let e = entities[i];
    if (e.type === 'building' && isGateBtype(e.btype) && e.complete) (gates || (gates = [])).push(e);
  }
  if (!gates) return;
  // 1-tile cell index of units, built once per tick only when gates exist.
  let cells = new Map();
  for (let i = 0; i < entities.length; i++) {
    let en = entities[i];
    if (en.type !== 'unit') continue;
    let key = (en.x | 0) * 4096 + (en.y | 0);
    let arr = cells.get(key);
    if (!arr) cells.set(key, arr = []);
    arr.push(en);
  }
  gates.forEach(e => {
    // Sensing rect: [x-1.2, x+w+0.2] × [y-1.2, y+h+0.2] — any cell whose
    // units could satisfy it lies within floor(rect) bounds.
    let x0 = Math.floor(e.x - 1.2), x1 = Math.floor(e.x + e.w + 0.2);
    let y0 = Math.floor(e.y - 1.2), y1 = Math.floor(e.y + e.h + 0.2);
    let friendlyNear = false;
    outer: for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      let arr = cells.get(cx * 4096 + cy);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        let en = arr[k];
        if (sameSide(en.team, e.team) && // allies open our gates too
            en.x >= e.x - 1.2 && en.x <= e.x + e.w + 0.2 &&
            en.y >= e.y - 1.2 && en.y <= e.y + e.h + 0.2) { friendlyNear = true; break outer; }
      }
    }
    e.gateProgress = e.gateProgress || 0;
    // A locked gate never swings open — it slides shut and stays sealed even
    // with allies standing on it (they route around until it's unlocked).
    if (friendlyNear && !e.locked) {
      e.gateProgress = Math.min(1.0, e.gateProgress + 0.08);
    } else {
      e.gateProgress = Math.max(0.0, e.gateProgress - 0.08);
    }
    e.isOpen = e.gateProgress > 0.5;
  });
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
  // Skip units working IN PLACE on a fixed tile (resource gather, construction)
  // — they must not be slid off their claimed tile. Carcass harvesters are NOT
  // skipped: they press onto the carcass (js/logic.js pressToContact) and need
  // separation to spread them into a ring around it rather than stack.
  // Gatherers and builders work IN PLACE (exempt from separation). Each
  // gatherer stands on the DISTINCT adjacent tile pickGatherStand assigned it
  // (js/logic.js) — an even surround around the solid node — so they never
  // overlap and must not be shoved off their tile.
  let gathering=units.map(a=>
    (a.gatherX >= 0 && a.path.length === 0) ||
    (a.buildTarget !== null && a.path.length === 0));
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
    // Squared-distance early-out: the branches below only fire for d<minDist,
    // so skip the sqrt entirely for the (vast majority of) neighborhood pairs
    // that don't overlap. Math.sqrt is correctly-rounded and minDist²(0.25)/
    // minDist(0.5) are exact, so d2>=minDist² ⟺ sqrt(d2)>=minDist bit-for-bit —
    // behavior-neutral (verified by checksum equality).
    let d2=dx*dx+dy*dy;
    if(d2>=minDist*minDist)return;
    let d=Math.sqrt(d2);
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
