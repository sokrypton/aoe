// Wildlife: sheep, bears and the dragon — the map's own animals (gaia), stepped by updateUnit (js/logic.js).
// Sim code: the determinism rules hold (simRandom, simSin/simCos, T30 cadences).

const SHEEP_EAT_EVERY = T30(180);    // sheep pause to graze ~every 6 game-s
const SHEEP_WANDER_EVERY = T30(120); // sheep wander ~every 4 game-s
const BEAR_WANDER_EVERY = T30(150);  // bear den wander ~every 5 game-s

// Sheep behavior (AoE2-style)
function updateSheepBehavior(e){
  if(e.utype!=='sheep')return;
  // Offered to the dragon (dragonTakeOffering): it stands where it is, whatever it is told, till it is eaten.
  if(e.offered){ if(e.order)issueOrder(e,null); e.target=null; clearUnitPath(e); e.eatTicks=0; e.eatingGrass=false; return; }
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
    let closest=closestUnitNear(e,5,en=>isPlayerTeam(en.team)&&en.utype!=='dragon');
    if(closest && closest.team!==e.team){
      let guarded = false;
      if (isPlayerTeam(e.team)) {
        let guardDist = dist(e,closest), ally = sameSide(closest.team, e.team);
        guarded = !!closestUnitNear(e,guardDist+1e-9,en=>ally ? en.team===e.team : sameSide(en.team,e.team)); // (a guard exactly as close counts: closestUnitNear is strict)
      }
      if(!guarded){
        // (captured: its old owner's orders go with it — an offering to the dragon too; the new owner may send it again)
        e.team=closest.team; e.offerTo=undefined; if(e.order)issueOrder(e,null);
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
      // (a ridden dragon is no prey: it is out of reach overhead)
      let closest=closestUnitNear(e,5.5,en=>isPlayerTeam(en.team)&&en.utype!=='dragon');
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
    let d=entities[i]; if(d.utype!=='dragon'||d.hp<=0||d.garrisonedIn||dragonAloft(d))continue;
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
// The dragon ridden. A player's own sheep sent at the dragon (ordered onto it, as an attack) is eaten when it comes
// within DRAGON_FEED_R of it on the ground, and
// the dragon is that player's for DRAGON_RIDE (game time): one of their units (e.team), ordered like any other — and aloft: it
// flies straight over everything (no path, no blocked tiles), turns fast, and burns whatever comes under its nose.
// Aloft only missiles reach it — archers and buildings' arrows (outOfReach, js/logic.js). When its time is up — or it is brought down — it is gaia's again and
// flies home (homing) to land and sleep; it won't take another offering for DRAGON_REST after landing.
// The ride is two minutes of GAME time (rideLeft, in ticks): a minute at the default 2x, 30 s at 4x, two minutes at
// 1x. (Its meal is real time: eatLeft runs down by 1/GAME_SPEED a tick — GAME_SPEED is peer-synced and rewinds with
// the lockstep snapshot.)
// rideLeft / homing / flyX / flyY / flyTarget / tameReadyAt are sim state: hashed (js/determinism.js).
const DRAGON_FEED_R=4, DRAGON_RIDE=T30(3600), DRAGON_REST=T30(5400), DRAGON_FLY=3/TPS, DRAGON_FLY_TURN=(Math.PI*0.9)/TPS, DRAGON_GLIDE=1.5;
// Real seconds of its ride left (the HUD countdown).
function dragonRideSeconds(e){ return Math.max(0, Math.ceil(e.rideLeft / TPS / GAME_SPEED)); }
// Flying home after a ride it is shown to every viewer through the fog (viewer-side only: the sim's sight is
// unchanged). Otherwise it is hidden by fog like any unit.
function dragonSeenByAll(e){ return e.utype==='dragon'&&!!e.homing; }
function dragonAloft(e){ return e.utype==='dragon'&&(e.rideLeft!==undefined||!!e.homing); }
// The sheep offered to it, if any: the lowest-id live sheep a player has SENT at it (offerTo: execUnitCommand) that has
// come within DRAGON_FEED_R of it (entities are in id order) — one merely grazing by is left alone. Asleep or awake, so long as it is on the ground and whole; resting after a ride, it says so and waits.
function dragonOffering(e){
  for(let i=0;i<entities.length;i++){ let s=entities[i];
    if(s.utype!=='sheep'||s.offerTo!==e.id||s.hp<=0||s.offered||!isPlayerTeam(s.team)||dist(e,s)>DRAGON_FEED_R)continue;
    if(tick>=(e.tameReadyAt||0))return s;
    if(!window.__resim&&s.team===myTeam&&(((tick-e.id)%T30(150))+T30(150))%T30(150)<5&&typeof showMsg==='function')   // (once in T30(150): checked only every 5th tick)
      showMsg('The dragon is resting: it will take an offering in '+Math.ceil((e.tameReadyAt-tick)/TPS/GAME_SPEED)+'s');
    return null; }
  return null;
}
// The offering taken: the dragon is that player's at once, but first it EATS — DRAGON_EAT of real time (eatLeft, run
// down like rideLeft) in which it turns on the sheep (held where it stands: offered), pounces to within DRAGON_BITE_R
// and bites it away (DRAGON_BITE_AT of the way through). The ride's clock starts when it has eaten. The renderers
// stage the rest off eatLeft (dragonAnim). eatLeft / eatId / offered are sim state: hashed (js/determinism.js).
const DRAGON_EAT=T30(90), DRAGON_LEAP_FROM=0.3, DRAGON_LEAP_TO=0.46, DRAGON_BITE_AT=0.5, DRAGON_BITE_R=2.1;
function dragonTakeOffering(e,s){
  e.team=s.team; e.rideLeft=DRAGON_RIDE; e.eatLeft=DRAGON_EAT; e.eatId=s.id; e.awake=true; e.target=null; e.flyTarget=undefined; e.flyX=undefined; clearUnitPath(e);
  s.offered=true; s.target=null; clearUnitPath(s);
  if(window.playSound)window.playSound('dragon',e.x,e.y);
  if(!window.__resim){
    if(typeof showMsg==='function')showMsg(e.team===myTeam?'The dragon takes your offering: it is yours to fly!':teamName(e.team)+' rides the dragon!');
    // (in the rider's hand at once: nothing else, or only the sheep, was selected)
    if(e.team===myTeam&&selected.every(u=>u.id===s.id)){ selected=[e]; if(typeof updateUI==='function')updateUI(); }
  }
}
function dragonEat(e){
  let s=entitiesById.get(e.eatId), u=1-e.eatLeft/DRAGON_EAT, step=1/GAME_SPEED;
  e.eatLeft-=step;
  if(s&&s.hp>0){
    let dx=s.x-e.x, dy=s.y-e.y, d=Math.sqrt(dx*dx+dy*dy);
    if(d>1e-6){ let off=simAtan2(dy,dx)-(e.faceAng||0); off=simAtan2(simSin(off),simCos(off));
      e.faceAng=(e.faceAng||0)+Math.max(-DRAGON_FLY_TURN,Math.min(DRAGON_FLY_TURN,off)); e.faceAng=simAtan2(simSin(e.faceAng),simCos(e.faceAng)); }
    // the pounce: the rest of the way, shared over what is left of the leap
    if(u>=DRAGON_LEAP_FROM&&d>DRAGON_BITE_R){ let left=Math.max(1,Math.round((DRAGON_LEAP_TO-u)*DRAGON_EAT/step)), st=(d-DRAGON_BITE_R)/left;
      e.x=Math.max(0,Math.min(MAP-1,e.x+dx/d*st)); e.y=Math.max(0,Math.min(MAP-1,e.y+dy/d*st)); e.fromX=e.x; e.fromY=e.y; e.moveT=0; }
    if(u>=DRAGON_BITE_AT){                                                        // eaten whole: no carcass
      if(!window.__resim){ if(typeof spawnParticles==='function'){ spawnParticles(s.x,s.y,'#990000',14,0.05,1.6); spawnParticles(s.x,s.y,'#f4f1e6',10,0.05,1.4); } if(window.playSound)window.playSound('dragon_slam',s.x,s.y); }
      s.hp=0; selected=selected.filter(v=>v.id!==s.id); entities=entities.filter(v=>v.id!==s.id); entitiesById.delete(s.id); }
  }
  if(e.eatLeft<=0){ e.eatLeft=undefined; e.eatId=undefined; if(e.flyX===undefined){ e.flyX=e.x; e.flyY=e.y; } }
}
// Its ride over (time up, or brought down): gaia's again, and home to its lair.
function dragonEndRide(e){
  if(!window.__resim&&typeof showMsg==='function'&&e.rideLeft!==undefined)showMsg('The dragon returns to its lair');
  e.possessed=false;   // (character mode lets go of it)
  // (brought down mid-meal: the meal is off, and the sheep is free again — else it stood frozen, offered, for good)
  if(e.eatLeft!==undefined){ let s=entitiesById.get(e.eatId); if(s){ s.offered=false; s.offerTo=undefined; } e.eatLeft=undefined; e.eatId=undefined; }
  e.team=GAIA_TEAM; e.rideLeft=undefined; e.homing=true; e.target=null; e.flyTarget=undefined; e.explicitAttack=false; clearUnitPath(e);
}
// One tick aloft: toward (x, y) — turning, and flying forward once roughly headed there; `hold`: hover this far short.
function dragonFly(e,x,y,hold){
  let dx=x-e.x, dy=y-e.y, d=Math.sqrt(dx*dx+dy*dy);
  if(d>hold+0.02||(hold>0&&d>1e-6)){ let a=simAtan2(dy,dx), off=a-(e.faceAng||0); off=simAtan2(simSin(off),simCos(off));
    e.faceAng=(e.faceAng||0)+Math.max(-DRAGON_FLY_TURN,Math.min(DRAGON_FLY_TURN,off)); e.faceAng=simAtan2(simSin(e.faceAng),simCos(e.faceAng));
    let st=Math.max(-DRAGON_FLY*0.5,Math.min(DRAGON_FLY,d-hold));
    // (inside its turning circle it slides straight to the spot: flying along its nose it would orbit it)
    if(st<-0.01&&d>1e-6){ if(d-hold<-0.3){ e.x+=dx/d*st; e.y+=dy/d*st; } }   // too close (its target came in under it): it backs off
    else if(st>0&&d-hold<DRAGON_GLIDE){ e.x+=dx/d*st; e.y+=dy/d*st; }
    else if(st>0&&simCos(off)>0.3){ e.x+=simCos(e.faceAng)*st; e.y+=simSin(e.faceAng)*st; }
    e.x=Math.max(0,Math.min(MAP-1,e.x)); e.y=Math.max(0,Math.min(MAP-1,e.y)); }
  else if(!hold){ e.x=x; e.y=y; }
  else { e.x=Math.max(0,Math.min(MAP-1,e.x-simCos(e.faceAng||0)*DRAGON_FLY*0.5)); e.y=Math.max(0,Math.min(MAP-1,e.y-simSin(e.faceAng||0)*DRAGON_FLY*0.5)); }   // (dead on it: off it, tail first)
  e.fromX=e.x; e.fromY=e.y; e.moveT=0;
  return d;
}
// It burns whatever its fire would reach, as soon as it has the breath for it.
function dragonAutoBreath(e){ if(e.atkCooldown<=0&&dragonBreath(e,true)){ dragonBreath(e); e.atkCooldown=UNITS.dragon.rof; } }
function updateDragonAloft(e){
  if(e.homing){                                                                   // home, to land and sleep
    if(dragonFly(e,e.homeX,e.homeY,0)<=0.02){ e.x=e.homeX; e.y=e.homeY; e.fromX=e.x; e.fromY=e.y; e.homing=false; e.awake=false; e.calmSince=tick; e.leashCooling=false; e.tameReadyAt=tick+DRAGON_REST; }
    return;
  }
  if(e.eatLeft!==undefined){ dragonEat(e); return; }
  let was=e.rideLeft, warn=10*TPS*GAME_SPEED; e.rideLeft--;
  if(e.rideLeft<=0){ dragonEndRide(e); return; }
  if(!window.__resim&&e.team===myTeam&&typeof showMsg==='function'&&was>warn&&e.rideLeft<=warn)showMsg('The dragon is yours for 10 more seconds');
  // Its orders come straight from the player's command (execUnitCommand: flyTarget, or flyX / flyY). Whatever the unit
  // machinery hands it meanwhile is dropped — a target (hit by a tower, it would turn on the tower) — or, a ground move
  // (Eye View steering), taken as where to fly.
  if(e.target)dropTarget(e);
  if(e.path.length||(e.order&&e.order.kind==='move')){ let o=e.order&&e.order.kind==='move'?e.order:e.path[e.path.length-1];
    e.flyX=o.x; e.flyY=o.y; e.flyTarget=undefined; clearUnitPath(e); if(e.order)issueOrder(e,null); }
  let t=e.flyTarget!==undefined?entitiesById.get(e.flyTarget):null;
  if(t&&(t.hp<=0||t.garrisonedIn||sameSide(t.team,e.team))){ t=null; }
  if(!t&&e.flyTarget!==undefined){ e.flyTarget=undefined; e.flyX=e.x; e.flyY=e.y; }
  // It hangs DRAGON_STRAFE short of its target, facing it: its fire lands on it. A building: short of its nearest
  // EDGE — beside it, not over its roof (from over it, it backs off its centre first).
  if(t){ let c=t;
    if(t.type==='building'){ let b=BLDGS[t.btype], w=t.w||b.w, h=t.h||b.h;
      c={x:Math.max(t.x-0.5,Math.min(e.x,t.x+w-0.5)), y:Math.max(t.y-0.5,Math.min(e.y,t.y+h-0.5))};
      if(c.x===e.x&&c.y===e.y){ c=footprintCenter(t); dragonFly(e,c.x,c.y,DRAGON_STRAFE+Math.max(w,h)/2); return dragonAutoBreath(e); } }
    dragonFly(e,c.x,c.y,DRAGON_STRAFE); }
  else dragonFly(e,e.flyX,e.flyY,0);
  dragonAutoBreath(e);
}
function updateDragonBehavior(e){
  if(e.utype!=='dragon')return;
  if(e.homeX===undefined){e.homeX=e.x;e.homeY=e.y;}
  if(dragonAloft(e)){ updateDragonAloft(e); return; }
  // Asleep it heals, 1 hp every DRAGON_REGEN ticks; knocked out (spent) it stays down, deaf to everything, till whole.
  if(!e.awake&&e.hp<e.maxHp&&tick%DRAGON_REGEN===0)e.hp++;
  if(e.spent){ if(e.hp>=e.maxHp)e.spent=false; else { e.target=null; clearUnitPath(e); return; } }
  // A sheep brought near is an offering — asleep or awake (a sheep alone never wakes it).
  if(tick%5===e.id%5){ let s=dragonOffering(e); if(s){ dragonTakeOffering(e,s); return; } }
  let home={x:e.homeX,y:e.homeY}, hit=e.lastEnemyHitTick!==undefined&&tick-e.lastEnemyHitTick<3; // (hashed; lastHitTick is the minimap's)
  if(!e.awake){
    if(!e.target&&!hit&&!(tick%T30(10)===e.id%T30(10)&&closestUnitNear(e,DRAGON_WAKE_R,en=>isPlayerTeam(en.team)&&!isHarmlessAnimal(en)))){ clearUnitPath(e); return; } // still asleep
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
// (buildings its bonus). Entities in id order — the order damage lands in is part of the sim. dry: only whether
// anything is in the fire (nothing burnt, nothing shown).
// Aloft its fire comes DOWN at a slant: onto the ground DRAGON_STRAFE ahead of it (3.4: its jaws are ~1.4 ahead and ~2
// up — about 45°), where the renderers pour the flame (both read it). It burns EVERYTHING along the jet's last
// stretch and its splash: within DRAGON_STRAFE_R of the line from DRAGON_STRAFE_FROM to DRAGON_STRAFE_TO ahead (three
// circles along it; a building: its nearest edge) — not what is under its belly or beside it. Entities in id order.
const DRAGON_STRAFE=3.4, DRAGON_STRAFE_FROM=2.2, DRAGON_STRAFE_TO=4.2, DRAGON_STRAFE_R=1.3;
// Where the renderers aim the jet (viewer-side): {s: how far ahead, h: how high}. The ground DRAGON_STRAFE ahead —
// or, sent at a building, into its walls: a flatter jet AT it, not down in front of it.
const DRAGON_AIM_WALL={s:DRAGON_STRAFE+0.9, h:1.2}, DRAGON_AIM_GROUND={s:DRAGON_STRAFE, h:0};
function dragonFireAim(e){ let t=e.flyTarget!==undefined?entitiesById.get(e.flyTarget):null; return t&&t.type==='building'&&t.hp>0?DRAGON_AIM_WALL:DRAGON_AIM_GROUND; }
function dragonStrafe(e,fx,fy,dry){
  for(let i=0;i<entities.length;i++){
    let o=entities[i];
    if(o===e||o.hp<=0||o.garrisonedIn||!isPlayerTeam(o.team)||sameSide(o.team,e.team))continue;
    if(o.type==='unit'&&isHarmlessAnimal(o))continue;
    if(o.type!=='building'&&o.type!=='unit')continue;
    let b=o.type==='building'?BLDGS[o.btype]:null, w=b?(o.w||b.w):0, h=b?(o.h||b.h):0, hit=false;
    for(let k=0;k<3&&!hit;k++){ let r=DRAGON_STRAFE_FROM+(DRAGON_STRAFE_TO-DRAGON_STRAFE_FROM)*k/2, cx=e.x+fx*r, cy=e.y+fy*r;
      let ox=b?Math.max(o.x-0.5,Math.min(cx,o.x+w-0.5)):o.x, oy=b?Math.max(o.y-0.5,Math.min(cy,o.y+h-0.5)):o.y, dx=ox-cx, dy=oy-cy;
      hit=dx*dx+dy*dy<=DRAGON_STRAFE_R*DRAGON_STRAFE_R; }
    if(!hit)continue;
    if(dry)return true;
    damageEntity(e,o);
  }
  return false;
}
function dragonBreath(e,dry){
  let fx=simCos(e.faceAng), fy=simSin(e.faceAng);
  if(!dry){ e.breathTick=tick; e.breathX=fx; e.breathY=fy; } // (the renderers' flame; the sim never reads them)
  if(dragonAloft(e)){ let hit=dragonStrafe(e,fx,fy,dry); if(dry)return hit; if(window.playSound)window.playSound('fire',e.x,e.y); return false; }
  for(let i=0;i<entities.length;i++){
    let o=entities[i];
    if(o===e||o.hp<=0||o.garrisonedIn||!isPlayerTeam(o.team)||sameSide(o.team,e.team))continue;   // (ridden: not its rider's side)
    if(o.type==='unit'&&isHarmlessAnimal(o))continue;
    let ox, oy, d;
    if(o.type==='building'){ let b=BLDGS[o.btype], w=o.w||b.w, h=o.h||b.h;
      ox=Math.max(o.x-0.5,Math.min(e.x,o.x+w-0.5)); oy=Math.max(o.y-0.5,Math.min(e.y,o.y+h-0.5)); }
    else if(o.type==='unit'){ ox=o.x; oy=o.y; } else continue;
    let dx=ox-e.x, dy=oy-e.y; d=Math.sqrt(dx*dx+dy*dy);
    if(d>DRAGON_BREATH_R)continue;
    if(d>0.6&&(dx*fx+dy*fy)/d<DRAGON_BREATH_COS)continue;
    if(dry)return true;
    damageEntity(e,o);
  }
  if(dry)return false;
  if(window.playSound)window.playSound('fire',e.x,e.y);
}
