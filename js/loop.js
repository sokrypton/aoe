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
  updateAIGarrisonReaction(); // every tick, independent of the AI's slower decision cadence
  updateAI();
  refreshPopulationCounts();
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
    // Step to an adjacent free tile that isn't on the mover's onward path.
    let onward=new Set(m.path.slice(0,3).map(p=>p.x+','+p.y));
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
      setUnitPath(s,[{x:best.x,y:best.y}]); // a walked step, not a teleport/shove
    }
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
