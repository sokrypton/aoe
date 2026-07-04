// ---- MAIN LOOP ----
function update(){
  if(gameOver||!gameStarted)return;
  tick++;

  // Update particles
  particles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    
    // Apply horizontal drag
    if (p.drag) {
      p.vx *= p.drag;
      p.vy *= p.drag;
    }
    
    // Apply vertical physics
    if (p.z !== undefined) {
      p.z += p.vz;
      p.vz -= p.gravity;
      
      // Ground collision
      if (p.z <= 0) {
        p.z = 0;
        if (p.type === 'blood') {
          p.vx = 0;
          p.vy = 0;
          p.vz = 0;
        } else if ((p.type === 'dust' || p.type === 'grass') && p.vz < -0.005) {
          p.vz = -p.vz * 0.45;
          p.vx *= 0.6;
          p.vy *= 0.6;
        } else {
          p.vz = 0;
        }
      }
    }
    
    p.life--;
  });
  particles = particles.filter(p => p.life > 0);

  // Update smoking/burning buildings & gate open/close states
  entities.forEach(e => {
    if (e.type === 'building') {
      // Smoke/fire = battle damage on FINISHED buildings only. Foundations
      // legitimately sit below these hp thresholds while under construction
      // (hp grows with build progress) — a half-built house isn't burning.
      if (e.complete && e.hp < e.maxHp * 0.7 && tick % 5 === 0) {
        spawnParticles(e.x + e.w/2 + (Math.random() - 0.5)*0.5, e.y + e.h/2 + (Math.random() - 0.5)*0.5, 'rgba(100,100,100,0.5)', 1, 0.015, 3);
      }
      if (e.complete && e.hp < e.maxHp * 0.3 && tick % 3 === 0) {
        spawnParticles(e.x + e.w/2 + (Math.random() - 0.5)*0.5, e.y + e.h/2 + (Math.random() - 0.5)*0.5, Math.random() < 0.4 ? '#ff4500' : '#ffd700', 1, 0.02, 2.5);
      }
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
    let speed = 0.25; // tiles per tick
    if (dist <= speed) {
      if (p.targetBuildingId) {
        let b = entities.find(en => en.id === p.targetBuildingId);
        if (b && b.hp > 0) damageEntity(p.attacker, b);
      } else {
        let victim = null, vd = 0.45;
        entities.forEach(en => {
          if (en.type !== 'unit' || en.team === p.attacker.team || en.hp <= 0 || en.garrisonedIn) return;
          let d = Math.hypot(en.x - p.tx, en.y - p.ty);
          if (d < vd) { vd = d; victim = en; }
        });
        if (victim) damageEntity(p.attacker, victim);
      }
    } else {
      p.x += (dx / dist) * speed;
      p.y += (dy / dist) * speed;
      remainingProjectiles.push(p);
    }
  });
  projectiles = remainingProjectiles;

  updateFog(); // Update Fog of War visibility grid

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
    if(entities.includes(e)){
      if(e.type==='unit')updateUnit(e);
      else updateBuilding(e);
    }
  });
  separateUnits();
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
}

// Guest-only, called from gameLoop() (js/init.js) once per rendered frame
// instead of the tick-locked block above — cosmetic position-only flight,
// no damage/removal-on-impact (the host already resolved that the instant
// a shot landed; the guest's `projectiles` list gets wholesale-replaced by
// the next sync's authoritative version — js/net-sync.js — regardless of
// wherever this left them). Keeps arrows flying smoothly between syncs
// instead of only moving in visible ~6x/sec jumps like everything else the
// guest doesn't locally simulate.
function advanceGuestProjectiles(elapsedMs){
  let speed = 0.25 * (elapsedMs / timeStep); // same 0.25 tiles/tick as the authoritative update above
  projectiles.forEach(p => {
    let dx = p.tx - p.x, dy = p.ty - p.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    if (dist <= speed || dist === 0) { p.x = p.tx; p.y = p.ty; }
    else { p.x += (dx / dist) * speed; p.y += (dy / dist) * speed; }
  });
}

// Guest-only, same pattern as advanceGuestProjectiles above but for unit
// walking — the far more visually obvious "teleports every sync" case.
// This is a deliberate near-verbatim DUPLICATE of the position-stepping
// subset of updateUnit()'s path-following block (js/logic.js, the
// `if(e.path.length>0){...}` block), not a shared function called by both
// host and guest — same reasoning as the projectile function: a shared
// helper would add indirection into the host's authoritative tick for no
// benefit, and risks a future updateUnit change silently altering
// guest-only behavior or vice versa. Only ever touches
// x/y/fromX/fromY/moveT/path — never target/hp/cooldowns/task fields, and
// deliberately skips the walkable() rechecks the host's version does
// (worst case: renders up to one extra half-step into a tile the host has
// since blocked, corrected by the very next sync — purely cosmetic, same
// risk class as a projectile flying toward an already-dead target).
function advanceGuestUnits(elapsedMs){
  entities.forEach(e => {
    if(e.type!=='unit'||e.garrisonedIn||e.hp<=0||e.path.length===0)return;
    let speedInPixels = e.speed * 1.19 * (elapsedMs / timeStep);
    e.moveT += speedInPixels;
    while(e.path.length>0){
      let nextTile = e.path[0];
      let p1=toIso(e.fromX,e.fromY), p2=toIso(nextTile.x,nextTile.y);
      let screenDist = Math.hypot(p2.ix-p1.ix, p2.iy-p1.iy) || 1.0;
      if(e.moveT>=screenDist){
        e.moveT-=screenDist;
        let next=e.path.shift();
        e.fromX=next.x;e.fromY=next.y;e.x=next.x;e.y=next.y;
      } else break;
    }
    if(e.path.length>0){
      let next=e.path[0];
      let p1=toIso(e.fromX,e.fromY), p2=toIso(next.x,next.y);
      let screenDist = Math.hypot(p2.ix-p1.ix, p2.iy-p1.iy) || 1.0;
      let t = e.moveT/screenDist;
      e.x=e.fromX+(next.x-e.fromX)*t;
      e.y=e.fromY+(next.y-e.fromY)*t;
    }
  });
}

// Guest-only, called from gameLoop() (js/init.js) once per rendered frame.
// update()'s particle-physics block above (position/drag/gravity/ground-
// bounce/life countdown) is HOST-ONLY — the guest never calls update() at
// all, it only ever renders. Now that the guest independently spawns its
// own particles (hit/death/gather/building-fx below), something has to
// age and move them the same way, at frame cadence rather than per whole
// tick — same `elapsedMs/timeStep` fractional-step scaling as
// advanceGuestUnits/Projectiles use for the same reason.
function advanceGuestParticles(elapsedMs){
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

// Guest-only, called from gameLoop() (js/init.js) once per rendered frame,
// same reasoning as advanceGuestProjectiles/advanceGuestUnits above but for
// damaged-building smoke/fire (js/loop.js's own update() has the
// authoritative version of this exact block, host-only). This one isn't
// smoothing anything already-networked — smoke/fire particles are never
// sent at all — it's independently re-deriving a periodic visual effect
// from hp/maxHp, which the guest already has via the normal sync, using
// its own locally-advancing `tick` (js/init.js's per-frame nudge) as the
// timing source instead of needing the host to send anything new.
function advanceGuestBuildingEffects(){
  // `tick % N === 0` (the host's version) fires exactly once per N whole
  // ticks because the host's `tick` is a plain integer incremented once
  // per simulation step. The guest's `tick` instead advances fractionally
  // every rendered frame (js/init.js's per-frame nudge, purely for smooth
  // animation) — Math.floor(tick) can sit on the same multiple-of-N value
  // across many consecutive frames, so a bare modulo check here would fire
  // repeatedly instead of once. guestBuildingFxTick (per-entity, per-effect
  // last-fired tick) throttles it back down to "once per interval" instead.
  let t = Math.floor(tick);
  entities.forEach(e => {
    if (e.type !== 'building' || !e.complete) return;
    let rec = guestBuildingFxTick.get(e.id);
    if (!rec) { rec = {smoke: -999, fire: -999}; guestBuildingFxTick.set(e.id, rec); }
    if (e.hp < e.maxHp * 0.7 && t - rec.smoke >= 5) {
      rec.smoke = t;
      spawnParticles(e.x + e.w/2 + (Math.random() - 0.5)*0.5, e.y + e.h/2 + (Math.random() - 0.5)*0.5, 'rgba(100,100,100,0.5)', 1, 0.015, 3);
    }
    if (e.hp < e.maxHp * 0.3 && t - rec.fire >= 3) {
      rec.fire = t;
      spawnParticles(e.x + e.w/2 + (Math.random() - 0.5)*0.5, e.y + e.h/2 + (Math.random() - 0.5)*0.5, Math.random() < 0.4 ? '#ff4500' : '#ffd700', 1, 0.02, 2.5);
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
  for(let i=0;i<units.length;i++){
    for(let j=i+1;j<units.length;j++){
      let a=units[i], b=units[j];
      // Skip units actively gathering on a resource tile, building, or harvesting a sheep carcass
      let aGathering = (a.gatherX >= 0 && a.path.length === 0) ||
                       (a.buildTarget !== null && a.path.length === 0) ||
                       (a.target !== null && a.path.length === 0 && entitiesById.get(a.target)?.utype === 'sheep_carcass');
      let bGathering = (b.gatherX >= 0 && b.path.length === 0) ||
                       (b.buildTarget !== null && b.path.length === 0) ||
                       (b.target !== null && b.path.length === 0 && entitiesById.get(b.target)?.utype === 'sheep_carcass');
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
          let nax=a.x+Math.random()*0.3-0.15;
          let nay=a.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nax),Math.round(nay),a.id,true)){a.x=nax;a.y=nay;}
        }
        if(b.path.length===0&&!bGathering){
          let nbx=b.x+Math.random()*0.3-0.15;
          let nby=b.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nbx),Math.round(nby),b.id,true)){b.x=nbx;b.y=nby;}
        }
      }
    }
  }
}
