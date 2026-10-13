// Wildlife: sheep, bears and the dragon — the map's own animals (gaia), stepped by updateUnit (js/logic.js).
// Sim code: the determinism rules hold (simRandom, simSin/simCos, T30 cadences).

const SHEEP_EAT_EVERY = T30(180);    // sheep pause to graze ~every 6 game-s
const SHEEP_WANDER_EVERY = T30(120); // sheep wander ~every 4 game-s
const BEAR_WANDER_EVERY = T30(150);  // bear den wander ~every 5 game-s

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

  // A sheep the player steers (character mode) is theirs to move: no grazing stops or wander steps of its own (they
  // jittered it under the controls).
  if(e.possessed){ e.eatTicks=0; e.eatingGrass=false; }
  else if(e.path.length===0 && !e.eatingGrass){
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

  // Convert/steal sheep (AoE2): another player's unit within 5 tiles takes it
  // unless a guard is at least as close — an ally's too (a sheep can be
  // donated to an ally by walking it over). Guards: the owner's units against
  // an ally; the owner's or its allies' against an enemy. 3-tick id-stagger
  // (perf). WRAPPED, not an early return — the sheep branch falls through
  // to the shared movement step below, which must still walk the wander path.
  if((tick+e.id)%3===0){
    let closest=closestUnitNear(e,5,en=>isPlayerTeam(en.team));
    if(closest && closest.team!==e.team){
      let guarded = false;
      if (isPlayerTeam(e.team)) {
        let guardDist = dist(e,closest), ally = sameSide(closest.team, e.team);
        guarded = !!closestUnitNear(e,guardDist+1e-9,en=>ally ? en.team===e.team : sameSide(en.team,e.team)); // (a guard exactly as close counts: closestUnitNear is strict)
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
    if(!e.leashCooling && tick%T30(10)===e.id%T30(10)){
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

// The lair dragon: asleep on its hoard until someone walks right up or hits it; awake, it takes on whoever comes
// within reach, burning a cone in front of it on its reload (the breath lands before the generic strike, which the
// cooldown then keeps off), leashes back to the lair, and settles to sleep after a quiet spell there.
// The dragon's body on the ground: an oval DRAGON_BODY[0] (half-length, along its heading) by [1] (half-width).
// Every tile whose centre lies in it is blocked, walking or asleep (rebuildBlockGrid, js/loop.js); units caught in
// it are pushed out to its edge (dragonShove); others measure to its edge (distToTarget). simCos/simSin: in the tick.
const DRAGON_BODY=[1.3,0.85], DRAGON_SHOVE=0.12;
function dragonAxes(d){ let a=d.faceAng||0; return [simCos(a), simSin(a)]; }
function inDragonBody(d,x,y,grow){
  let [c,s]=dragonAxes(d), dx=x-d.x, dy=y-d.y, u=(dx*c+dy*s)/(DRAGON_BODY[0]+grow), v=(-dx*s+dy*c)/(DRAGON_BODY[1]+grow);
  return u*u+v*v<1;
}
// Its oval's radius toward (x, y), from its centre.
function dragonBodyRadius(d,x,y){
  let [c,s]=dragonAxes(d), dx=x-d.x, dy=y-d.y, l=Math.sqrt(dx*dx+dy*dy);
  if(l<1e-6) return DRAGON_BODY[1];
  let u=(dx*c+dy*s)/l/DRAGON_BODY[0], v=(-dx*s+dy*c)/l/DRAGON_BODY[1];
  return 1/Math.sqrt(u*u+v*v);
}
// Standing units the dragon has come down on (it walked, turned or woke over them) step out of its body, a little
// each tick, straight away from it — onto open ground only. Movers aren't pushed: its blocked tiles stop and re-route them.
function dragonShove(){
  for(let i=0;i<entities.length;i++){
    let d=entities[i]; if(d.utype!=='dragon'||d.hp<=0||d.garrisonedIn)continue;
    for(let j=0;j<entities.length;j++){
      let u=entities[j];
      if(u===d||u.type!=='unit'||u.hp<=0||u.garrisonedIn||u.utype==='sheep_carcass'||u.utype==='dragon'||u.path.length)continue;
      if(Math.abs(u.x-d.x)>2.5||Math.abs(u.y-d.y)>2.5||!inDragonBody(d,u.x,u.y,0.35))continue;
      let dx=u.x-d.x, dy=u.y-d.y, l=Math.sqrt(dx*dx+dy*dy);
      if(l<1e-6){ let [c,s]=dragonAxes(d); dx=-s; dy=c; l=1; }                  // dead centre: out to its left side
      let nx=u.x+dx/l*DRAGON_SHOVE, ny=u.y+dy/l*DRAGON_SHOVE;
      if(walkable(Math.round(nx),Math.round(ny),u.id,true)){ u.x=nx; u.y=ny; }
    }
  }
}
const DRAGON_TURN=(Math.PI/6)/TPS, DRAGON_REGEN=T30(3),                                       // (turns 30° a game-second)
      DRAGON_WAKE_R=3, DRAGON_AGGRO_R=7, DRAGON_LEASH=12, DRAGON_BREATH_R=2.6, DRAGON_BREATH_COS=0.77, DRAGON_SLEEP_AFTER=T30(600), DRAGON_STEP_COS=0.82;
function updateDragonBehavior(e){
  if(e.utype!=='dragon')return;
  if(e.homeX===undefined){e.homeX=e.x;e.homeY=e.y;}
  // Asleep it heals, 1 hp every DRAGON_REGEN ticks; knocked out (spent) it stays down, deaf to everything, till whole.
  if(!e.awake&&e.hp<e.maxHp&&tick%DRAGON_REGEN===0)e.hp++;
  if(e.spent){ if(e.hp>=e.maxHp)e.spent=false; else { e.target=null; clearUnitPath(e); return; } }
  let home={x:e.homeX,y:e.homeY}, hit=e.lastEnemyHitTick!==undefined&&tick-e.lastEnemyHitTick<3; // (hashed; lastHitTick is the minimap's)
  if(!e.awake){
    if(!e.target&&!hit&&!(tick%T30(10)===e.id%T30(10)&&closestUnitNear(e,DRAGON_WAKE_R,en=>isPlayerTeam(en.team)))){ clearUnitPath(e); return; } // still asleep
    e.awake=true; e.calmSince=tick; e.leashCooling=false;
    if(window.playSound)window.playSound('dragon',e.x,e.y);
  }
  if(e.target){
    let t=entitiesById.get(e.target);
    if(!t||t.hp<=0||t.garrisonedIn||dist(e,t)>10||dist(e,home)>DRAGON_LEASH){
      e.target=null; clearUnitPath(e); pathUnitTo(e,Math.round(home.x),Math.round(home.y)); e.leashCooling=true;
    } else {
      // It fights only with its fire, where it FACES: it turns slowly toward its prey (dragonTurn) and breathes once the
      // prey is in the cone before it. Out of reach it lumbers closer; in reach it stands and turns — a runner quick
      // enough round its flank stays out of the fire.
      let d=distToTarget(e,t), a=simAtan2(t.y-e.y,t.x-e.x);
      if(d>DRAGON_BREATH_R-0.4){ if(e.path.length===0&&tick%T30(10)===e.id%T30(10))pathUnitTo(e,Math.round(t.x),Math.round(t.y)); }
      else clearUnitPath(e);
      dragonTurn(e, e.path.length?simAtan2(e.path[0].y-e.y,e.path[0].x-e.x):a);
      let off=e.faceAng-a; off=simAtan2(simSin(off),simCos(off));
      if(e.atkCooldown<=0&&d<=DRAGON_BREATH_R&&simCos(off)>=DRAGON_BREATH_COS){ dragonBreath(e); e.atkCooldown=UNITS.dragon.rof; }
    }
    e.calmSince=tick;
    return;
  }
  if(e.leashCooling&&dist(e,home)<3)e.leashCooling=false;
  if(!e.leashCooling&&(hit||tick%T30(10)===e.id%T30(10))){
    let prey=closestUnitNear(e,hit?9:DRAGON_AGGRO_R,en=>isPlayerTeam(en.team));
    if(prey){ e.target=prey.id; clearUnitPath(e); e.calmSince=tick; if(window.playSound)window.playSound('dragon',e.x,e.y); return; }
  }
  if(e.path.length===0&&dist(e,home)>1.5)pathUnitTo(e,Math.round(home.x),Math.round(home.y));
  if(e.path.length)dragonTurn(e,simAtan2(e.path[0].y-e.y,e.path[0].x-e.x));
  if(e.path.length===0&&tick-e.calmSince>DRAGON_SLEEP_AFTER)e.awake=false;             // back on the hoard, quiet: sleeps
}
function dragonScatter(u,d){
  let dx=u.x-d.x, dy=u.y-d.y, l=Math.sqrt(dx*dx+dy*dy)||1;
  let sp=findSpawnTile(Math.round(u.x+dx/l*7),Math.round(u.y+dy/l*7),4); if(!sp)return;
  if(u.utype==='villager'){ u.task=null; u.buildTarget=null; clearGatherTarget(u); }
  dropTarget(u); pathUnitTo(u,sp.x,sp.y);
  u.retreatUntil=tick+T30(120);
}
// Its heading (faceAng, hashed) turns toward `a` at DRAGON_TURN a tick at most: huge, and slow to come round.
function dragonTurn(e,a){
  if(e.faceAng===undefined){ e.faceAng=a; return; }
  let off=a-e.faceAng; off=simAtan2(simSin(off),simCos(off));
  e.faceAng+=Math.max(-DRAGON_TURN,Math.min(DRAGON_TURN,off)); e.faceAng=simAtan2(simSin(e.faceAng),simCos(e.faceAng));
}
// Fire in a cone along its heading: every player unit and building within reach and angle takes the dragon's hit
// (buildings its bonus). Entities in id order — the order damage lands in is part of the sim.
function dragonBreath(e){
  let fx=simCos(e.faceAng), fy=simSin(e.faceAng);
  e.breathTick=tick; e.breathX=fx; e.breathY=fy; // (the renderers' flame; the sim never reads them)
  for(let i=0;i<entities.length;i++){
    let o=entities[i];
    if(o===e||o.hp<=0||o.garrisonedIn||!isPlayerTeam(o.team))continue;
    if(o.type==='unit'&&isHarmlessAnimal(o))continue;
    let ox, oy, d;
    if(o.type==='building'){ let b=BLDGS[o.btype], w=o.w||b.w, h=o.h||b.h;
      ox=Math.max(o.x-0.5,Math.min(e.x,o.x+w-0.5)); oy=Math.max(o.y-0.5,Math.min(e.y,o.y+h-0.5)); }
    else if(o.type==='unit'){ ox=o.x; oy=o.y; } else continue;
    let dx=ox-e.x, dy=oy-e.y; d=Math.sqrt(dx*dx+dy*dy);
    if(d>DRAGON_BREATH_R)continue;
    if(d>0.6&&(dx*fx+dy*fy)/d<DRAGON_BREATH_COS)continue;
    damageEntity(e,o);
  }
  if(window.playSound)window.playSound('fire',e.x,e.y);
}
