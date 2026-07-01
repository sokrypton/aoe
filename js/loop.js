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
      if (e.hp < e.maxHp * 0.7 && tick % 5 === 0) {
        spawnParticles(e.x + e.w/2 + (Math.random() - 0.5)*0.5, e.y + e.h/2 + (Math.random() - 0.5)*0.5, 'rgba(100,100,100,0.5)', 1, 0.015, 3);
      }
      if (e.hp < e.maxHp * 0.3 && tick % 3 === 0) {
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

  // Update projectiles
  let remainingProjectiles = [];
  projectiles.forEach(p => {
    let target = entities.find(en => en.id === p.targetId);
    if (!target || target.hp <= 0) return;
    let targetX = target.type === 'building' ? target.x + (target.w || BLDGS[target.btype].w)/2 : target.x;
    let targetY = target.type === 'building' ? target.y + (target.h || BLDGS[target.btype].h)/2 : target.y;
    let dx = targetX - p.x;
    let dy = targetY - p.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    let speed = 0.25; // tiles per tick
    if (dist <= speed) {
      damageEntity(p.attacker, target);
    } else {
      p.x += (dx / dist) * speed;
      p.y += (dy / dist) * speed;
      remainingProjectiles.push(p);
    }
  });
  projectiles = remainingProjectiles;

  updateFog(); // Update Fog of War visibility grid

  let current=[...entities];
  current.forEach(e=>{
    if(entities.includes(e)){
      if(e.type==='unit')updateUnit(e);
      else updateBuilding(e);
    }
  });
  separateUnits();
  refreshPopulationCounts();
  updateAI();
  refreshPopulationCounts();
}

// Soft unit separation: push overlapping units apart (AoE2 collision)
function separateUnits(){
  let units=entities.filter(e=>e.type==='unit'&&e.utype!=='sheep'&&e.utype!=='sheep_carcass');
  let sep=0.08;
  let minDist=0.5;
  for(let i=0;i<units.length;i++){
    for(let j=i+1;j<units.length;j++){
      let a=units[i], b=units[j];
      // Skip units actively gathering on a resource tile
      let aGathering=a.gatherX>=0&&a.path.length===0;
      let bGathering=b.gatherX>=0&&b.path.length===0;
      let dx=a.x-b.x, dy=a.y-b.y;
      let d=Math.sqrt(dx*dx+dy*dy);
      if(d<minDist&&d>0.01){
        let push=sep*(minDist-d)/d;
        let px=dx*push, py=dy*push;
        if(a.path.length===0&&!aGathering){
          let nax=a.x+px, nay=a.y+py;
          if(walkable(Math.round(nax),Math.round(nay),a.id)){a.x=nax;a.y=nay;}
        }
        if(b.path.length===0&&!bGathering){
          let nbx=b.x-px, nby=b.y-py;
          if(walkable(Math.round(nbx),Math.round(nby),b.id)){b.x=nbx;b.y=nby;}
        }
      } else if(d<=0.01){
        if(a.path.length===0&&!aGathering){
          let nax=a.x+Math.random()*0.3-0.15;
          let nay=a.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nax),Math.round(nay),a.id)){a.x=nax;a.y=nay;}
        }
        if(b.path.length===0&&!bGathering){
          let nbx=b.x+Math.random()*0.3-0.15;
          let nby=b.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nbx),Math.round(nby),b.id)){b.x=nbx;b.y=nby;}
        }
      }
    }
  }
}
