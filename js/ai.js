// ---- AI ----
// All AI spatial radii (build search, drop sites, threat/vision range) were
// tuned for the 60-tile 'small' map. Scale them by MAP size so the AI's
// effective reach (and how far out it expands) grows on medium/large maps
// instead of staying clustered around its starting TC.
function aiScale(){return MAP/60;}

// ---- AI GARRISON REACTION (town bell equivalent) ----
// Mirrors the player's town-bell mechanic: when the AI's own base is taking
// damage, its idle-able villagers run for cover in the nearest TC/tower with
// room, then come back out once things quiet down. Runs every tick (not
// gated by updateAI's slow decisionInterval) so the reaction is prompt —
// a raid that's over in a few seconds shouldn't be able to slip past the
// AI's decision cadence entirely. lastTeamHit[team] (js/core.js, recorded
// by damageEntity in logic.js) timestamps and locates the last time an
// enemy damaged one of THIS team's entities ANYWHERE — that includes this
// AI's own attack wave trading hits at the enemy's base, so it can't gate
// the bell directly (it would garrison the whole economy during every
// offensive). Only hits near the AI's own TC count as "base under attack".
const AI_GARRISON_HOLD_TICKS = 360; // ~12s at 30 ticks/sec: stay hidden briefly after the last hit
const AI_BASE_ALARM_RADIUS = 18; // tiles from TC center (scaled by aiScale) that count as "home"
function updateAIGarrisonReaction(ai){
  if(!gameStarted||gameOver)return;
  // New hit since we last looked: classify it as base-hit or field-hit.
  // (Runs every tick, so at most one hit per tick can be missed — a real
  // base raid lands hits continuously, so the classification holds.)
  let hit = lastTeamHit && lastTeamHit[ai.team];
  // Only a CORE hit (a villager or the TC actually taking damage) triggers the
  // garrison bell. A besieger merely hitting the wall ring from outside is not
  // a reason to hide the whole economy — if it can't breach, the villagers are
  // safe and must keep working. (Reacting to any perimeter-wall hit kept the
  // bell ringing for the entire siege → villagers garrisoned forever → the
  // economy died in Dark Age while the walls held: the eco-stall bug.)
  if(hit && hit.core && hit.tick!==ai.seenWarTick){
    ai.seenWarTick=hit.tick;
    let tc=entities.find(b=>b.type==='building'&&b.team===ai.team&&b.btype==='TC');
    if(tc){
      let wdx=hit.x-(tc.x+tc.w/2), wdy=hit.y-(tc.y+tc.h/2);
      let d=Math.sqrt(wdx*wdx+wdy*wdy);
      if(d<=AI_BASE_ALARM_RADIUS*aiScale()) ai.lastBaseHitTick=hit.tick;
    }
  }
  // ?? not || : the tick can legitimately be 0 (a hit landed on tick 0),
  // and 0 is falsy — || would wrongly discard it and treat that as "never".
  let underAttack = tick - (ai.lastBaseHitTick ?? -1e9) < AI_GARRISON_HOLD_TICKS;
  // ringTownBell/soundAllClear maintain bellRinging[ai.team] themselves.
  if(underAttack && !window.bellRinging[ai.team]){
    ringTownBell(ai.team);
  } else if(!underAttack && window.bellRinging[ai.team]){
    soundAllClear(ai.team);
  }
}

function updateAI(ai){
  ai.tick++;
  let profile=aiProfileFor(ai.team);
  if(ai.tick%profile.decisionInterval!==0)return;

  let aiBuildings=entities.filter(e=>e.type==='building'&&e.team===ai.team);
  let aiUnits=entities.filter(e=>e.type==='unit'&&e.team===ai.team);
  let aiTC=aiBuildings.find(b=>b.btype==='TC');
  if(!aiTC){
    // TC destroyed: under this game's victory rule that IS the knockout
    // (handleDeath flags it; no rebuilding — AoE2-style, the town falls
    // with its center). Remaining units keep gathering/fighting only for
    // the brief window until checkAllianceVictory ends the match.
    addAITrickle(ai,profile);
    let vils=aiUnits.filter(u=>u.utype==='villager');
    let mils=aiUnits.filter(u=>isArmyUnit(u.utype));
    let anchor=aiBuildings[0]||(aiUnits[0]?{x:Math.round(aiUnits[0].x),y:Math.round(aiUnits[0].y),w:1,h:1}:null);
    assignAIVillagers(ai,vils,profile);
    if(anchor)controlAIMilitary(ai,mils,anchor,profile);
    controlAIScouts(ai,mils,null);
    return;
  }

  updateAIIntel(ai,aiTC,profile); // what has scouting/combat actually revealed about the player this tick
  if(maybeResignAI(ai,aiUnits))return; // AoE2-style concession — nothing left to plan

  let vils=aiUnits.filter(u=>u.utype==='villager');
  let mils=aiUnits.filter(u=>isArmyUnit(u.utype));
  let barracks=aiBuildings.filter(b=>b.btype==='BARRACKS');

  // Field flee: a villager taking hits AWAY from the base bubble runs home
  // (raids near the TC already ring the garrison bell). No new state — the
  // path home makes assignAIVillagers leave it alone until it arrives, by
  // which time the recent-hit window has expired and it re-tasks normally.
  let alarmR=AI_BASE_ALARM_RADIUS*aiScale();
  let tcCenter={x:aiTC.x+aiTC.w/2,y:aiTC.y+aiTC.h/2};
  // Window must exceed the decision interval or this (decision-tick-only) check
  // steps right over the hit: easy=240 / standard=180 / hard=120, so a fixed 120
  // meant the flee almost never fired for easy/standard.
  let fleeWindow=profile.decisionInterval+60;
  vils.forEach(v=>{
    if(v.lastHitTick==null||tick-v.lastHitTick>=fleeWindow)return;
    if(dist(v,tcCenter)<=alarmR)return;
    v.task=null;v.target=null;v.buildTarget=null;
    clearGatherTarget(v);
    let pt=nearestBldgPerimeter(v.x,v.y,aiTC,v.id);
    pathUnitTo(v,pt?pt.x:aiTC.x,pt?pt.y:aiTC.y);
  });
  let readyBarracks=barracks.filter(b=>b.complete);

  addAITrickle(ai,profile);
  planAIAgeUp(ai,aiTC,vils,profile); // claims food/gold for the age before military spends it
  queueAIVillagers(ai,aiTC,vils,profile);
  ensureAIHousing(ai,aiTC,profile);
  planAIDropSites(ai,aiTC,vils,profile);
  planAIMarket(ai,aiTC,vils,profile);          // Feudal Market — reserve wood BEFORE walls/towers/military drain it
  planAIFarming(ai,aiTC,vils,profile);
  planAIWalls(ai,aiTC,vils,profile); // AI defensive wall ring + gate
  planAITowers(ai,aiTC,vils,profile); // AI Watch Tower planning
  planAIMilitaryBuildings(ai,aiTC,vils,barracks,profile);
  queueAITradeCarts(ai,profile);               // team games only: train carts up to the cap
  planAIMarketExchange(ai,profile);            // buy/sell commodities for gold
  queueAIMilitary(ai,readyBarracks,profile);
  ensureAIScout(ai,readyBarracks); // keep an explorer alive so the enemy actually gets found
  assignAIVillagers(ai,vils,profile);
  rescueTrappedAIVillagers(ai,aiTC,vils,profile);
  huntAIBears(ai,mils);
  controlAIMilitary(ai,mils,aiTC,profile);
  controlAIScouts(ai,mils,aiTC);
  controlAITradeCarts(ai,aiUnits);             // route idle carts to an ally Market
}

// ---- RESIGNATION (AoE2-style) ----
// A team with a collapsed workforce, no army, enemies actively hitting it
// and no means to recover concedes after three consecutive hopeless
// decision ticks — instead of forcing the winner to raze 48 wall segments
// around a ghost town. Deterministic sim state (resignScore rides
// AI_STATES); the message broadcasts to every viewer like AoE2's
// "player has resigned".
function maybeResignAI(ai,aiUnits){
  if(defeatedTeams[ai.team])return true;
  let vils=0,mils=0;
  for(let u of aiUnits){if(u.utype==='villager')vils++;else if(isArmyUnit(u.utype))mils++;}
  let hit=lastTeamHit&&lastTeamHit[ai.team];
  let hopeless=vils<4&&mils===0&&hit&&tick-hit.tick<1800&&
    !canAfford(ai.team,UNITS.villager.cost);
  ai.resignScore=hopeless?(ai.resignScore||0)+1:0;
  if(ai.resignScore>=3){
    defeatedTeams[ai.team]=true;
    if(!window.__resim&&typeof showMsg==='function')showMsg('Team '+(ai.team+1)+' has resigned!');
    checkAllianceVictory();
    return true;
  }
  return false;
}

// ---- BEAR HUNT ----
// A villager fleeing a bear (the fleeBear stamp, js/logic.js damageEntity)
// calls in the army: wildlife camped on a resource otherwise farms the
// replacement gatherers one at a time forever — sim runs lost 7-12
// villagers per match to a single bear. A human clears it with soldiers;
// so does the AI now. Up to 3 idle non-scout military engage; bears are
// gaia so auto-attack never acquires them — this explicit order is the
// only military-vs-wildlife path, matching deliberate AoE2 boar hunts.
function huntAIBears(ai,mils){
  let vil=entities.find(e=>e.team===ai.team&&e.utype==='villager'&&e.fledBearId!=null);
  if(!vil)return;
  let bear=entitiesById.get(vil.fledBearId);
  if(!bear||bear.hp<=0||bear.utype!=='bear'){vil.fledBearId=undefined;return;}
  let sent=entities.filter(m=>m.team===ai.team&&m.type==='unit'&&m.target===bear.id).length;
  // Prefer non-scout military: the scout is fragile recon (atk 3) and throwing
  // it at a bear just kills the map explorer. But in the DARK AGE the scout is
  // often the ONLY military — and a mauled villager (eco) matters more than
  // vision, so fall back to the scout rather than let the bear farm villagers
  // (exempting scouts outright starved the Dark-Age eco: villagers died to
  // bears unchecked → stuck in Dark Age). Two passes: fighters first, scouts
  // only if nothing else answered.
  let candidates=mils.filter(m=>!m.target);
  let ordered=[...candidates.filter(m=>m.utype!=='scout'),...candidates.filter(m=>m.utype==='scout')];
  for(let m of ordered){
    if(sent>=3)break;
    if(m.utype==='scout'&&sent>0)break; // a fighter already went — spare the scout
    m.target=bear.id;m.explicitAttack=true;clearUnitPath(m);
    sent++;
  }
  if(sent>0)vil.fledBearId=undefined; // hunt dispatched — don't re-trigger every decision
}

// ---- TRAPPED-VILLAGER RESCUE ----
// A wall segment can seal a worker into a pocket (the ring meeting forest
// around a lumber crew, maintenance re-closing a hole someone was inside).
// A real player deletes the wall; the AI does the same. findPath is too
// dear to sweep every villager, so test ONE per decision tick, rotating
// deterministically — a trapped worker is found within a couple of game
// minutes. Trapped = can't path to its own TC; the rescue breaches the
// nearest OWN wall reachable from inside the pocket (nothing reachable →
// no-op, so a villager off raiding enemy lands can't trigger deletions).
function rescueTrappedAIVillagers(ai,aiTC,vils,profile){
  if(vils.length===0)return;
  let v=vils[Math.floor(ai.tick/profile.decisionInterval)%vils.length];
  if(v.garrisonedIn||v.task==='garrison')return;
  if(adjToBuilding(v.x,v.y,aiTC))return;
  let pt=nearestBldgPerimeter(v.x,v.y,aiTC,v.id);
  if(!pt||pathReaches(v.x,v.y,pt.x,pt.y,v.id))return;
  let w=nearestReachableWallLike(v,ai.team);
  if(w&&w.team===ai.team&&isWallBtype(w.btype)){
    deleteOwnedEntity(w);
    // Hold this tile OPEN for a while instead of letting wall-maintenance
    // instantly rebuild it — otherwise the worker is re-sealed next tick and
    // we oscillate (delete → rebuild → re-trap), the "keeps deleting and
    // recreating the wall" behavior. The gap is the worker's eco access; the
    // ring still has its gate(s) for defense.
    let pt=ai.wallPlan&&ai.wallPlan.find(t=>t.x===w.x&&t.y===w.y);
    if(pt){pt.done=true;pt.rescueOpenUntil=tick+3000;}
  }
}

// ---- AI INTEL ----
// What the AI actually "knows" about the player, built from units/buildings
// that have come within sight of an AI unit or building — not omniscient
// lookups into the global entities list. Scouts wandering the map (see
// controlAIScouts) are what feeds this: every tile they wander through
// extends AI vision, so exploring is what lets the AI react to what the
// player is building rather than playing blind. TC sighting is sticky (once
// scouted, the AI remembers where it is, like a human player would).
// Cell-hash proximity visibility: which enemy entities have any of MY
// entities within `visionRange`? Replaces the O(entities^2)
// filter(...entities.some(...)) scans that dominated late-game decision
// ticks (~160k dist() calls per AI with 400 entities): bucket my entities
// into visionRange-sized cells once, then each candidate checks only its
// 3x3 cell neighborhood. Identical results, same entity order.
function aiVisibleEnemies(ai,visionRange,pred){
  let cell=Math.max(1,visionRange);
  let mine=new Map();
  for(let i=0;i<entities.length;i++){
    let en=entities[i];
    if(en.team!==ai.team)continue;
    let k=Math.floor(en.x/cell)*4096+Math.floor(en.y/cell);
    let a=mine.get(k);if(!a)mine.set(k,a=[]);
    a.push(en);
  }
  let r2=visionRange*visionRange;
  let near=e=>{
    let cx=Math.floor(e.x/cell),cy=Math.floor(e.y/cell);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      let a=mine.get((cx+dx)*4096+(cy+dy));
      if(!a)continue;
      for(let j=0;j<a.length;j++){let m=a[j],ddx=m.x-e.x,ddy=m.y-e.y;if(ddx*ddx+ddy*ddy<=r2)return true;}
    }
    return false;
  };
  return entities.filter(e=>isEnemyOf(ai.team,e)&&e.hp>0&&pred(e)&&near(e));
}
function getSpottedPlayerEntities(ai){
  return aiVisibleEnemies(ai,15*aiScale(),e=>e.utype!=='sheep');
}

function unitPower(utype){
  let u=UNITS[utype];
  if(!u)return 1;
  return u.hp+u.atk*5;
}

function updateAIIntel(ai,aiTC,profile){
  let intel=ai.intel||{unitCounts:{},strength:0,tcSeen:false,tcX:0,tcY:0,tcTeam:null};
  let unitCounts={},strength=0,strengthByTeam={};
  getSpottedPlayerEntities(ai).forEach(e=>{
    if(e.type==='unit'){
      unitCounts[e.utype]=(unitCounts[e.utype]||0)+1;
      let p=unitPower(e.utype);
      strength+=p;
      strengthByTeam[e.team]=(strengthByTeam[e.team]||0)+p;
    } else if(e.type==='building'&&e.btype==='TC'){
      intel.tcSeen=true;
      intel.tcX=e.x;intel.tcY=e.y;intel.tcTeam=e.team;
    }
  });
  // Safety net: if scouting genuinely never finds the player (bad luck on a
  // large map, player tucked in a corner, etc.), don't leave the AI passive
  // forever once its army is ready — a real opponent eventually locates you
  // through patrols/skirmishes even without perfect scouting.
  if(!intel.tcSeen&&ai.tick>profile.attackTick*2){
    let enemyTC=entities.filter(e=>isEnemyOf(ai.team,e)&&e.btype==='TC')
      .sort((a,b)=>dist(a,aiTC)-dist(b,aiTC))[0];
    if(enemyTC){intel.tcSeen=true;intel.tcX=enemyTC.x;intel.tcY=enemyTC.y;intel.tcTeam=enemyTC.team;}
  }
  intel.unitCounts=unitCounts;
  intel.strength=strength;
  intel.strengthByTeam=strengthByTeam; // per-enemy-team split — wave commits compare vs ONE target, not the sum
  ai.intel=intel;
}

function estimateLocalPlayerPower(ai,center,radius){
  return entities.filter(e=>isEnemyOf(ai.team,e)&&e.type==='unit'&&e.hp>0&&e.utype!=='sheep'&&dist(e,center)<=radius)
    .reduce((s,e)=>s+unitPower(e.utype),0);
}

function addAITrickle(ai,profile){
  Object.entries(profile.trickle).forEach(([resName,amount])=>{resourceStore(ai.team)[resName]+=amount;});
}

// Advance ages, difficulty-paced. Once thresholds pass, either start the
// research immediately or flag savingForAge so military spending yields
// (villager production continues — eco first, AoE2-style).
function planAIAgeUp(ai,aiTC,vils,profile){
  let next=teamAge[ai.team]+1;
  if(next>=AGES.length||next>(profile.maxAge||0)){ai.savingForAge=false;return;}
  if(aiTC.research){ai.savingForAge=false;return;}
  if(vils.length<(profile.ageUpVils&&profile.ageUpVils[next]||Infinity))return;
  if(ai.tick<(profile.ageUpTick&&profile.ageUpTick[next]||Infinity))return;
  if(canAfford(ai.team,AGES[next].cost)){
    execResearchAge(aiTC); // same exec path as the player's command
    ai.savingForAge=false;
  } else {
    ai.savingForAge=true;
  }
}

function queueAIVillagers(ai,aiTC,vils,profile){
  if(vils.length>=profile.maxVils)return;
  let hasReadyBarracks=entities.some(e=>e.team===ai.team&&e.type==='building'&&e.btype==='BARRACKS'&&e.complete);
  // Only hold back villager training for the military food reserve once the
  // NEXT AGE's villager benchmark is met (eco-first, AoE2): below it, food
  // goes to villagers — the matching military-side gate (queueAIMilitary)
  // pauses militia spending over the same window, so the reserve would
  // otherwise just starve villager growth and stall the age-up forever.
  let nextA=teamAge[ai.team]+1;
  let ecoT=(nextA<AGES.length&&profile.ageUpVils&&profile.ageUpVils[nextA])||0;
  if(hasReadyBarracks&&vils.length>=Math.max(6,ecoT)&&resourceStore(ai.team).food<profile.militaryFoodReserve)return;
  while(aiTC.queue.length<profile.queueLimit&&vils.length+aiTC.queue.filter(u=>u==='villager').length<profile.maxVils){
    let result=queueUnit(aiTC,'villager');
    if(!result.ok)break;
  }
}

function ensureAIHousing(ai,aiTC,profile){
  let requested=teamPopUsed(ai.team)+teamQueuedPop(ai.team);
  let plannedCap=teamPopCap(ai.team,true);
  let pendingHouses=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='HOUSE'&&!e.complete).length;
  if(requested<plannedCap-profile.houseBuffer||pendingHouses>1||!canAfford(ai.team,BLDGS.HOUSE.cost))return;
  let pos=findAIBuildSpot(ai,aiTC,'HOUSE');
  if(pos)placeAIBuilding(ai,'HOUSE',pos.x,pos.y);
}

const AI_DROP_COVER=10;  // a drop-off "covers" resource within this radius: only
                         // build a camp for resources FARTHER than this (else
                         // the TC/existing camp already serves it — no redundant
                         // camp next to a drop that's right there)
const AI_MAX_LCAMP=3, AI_MAX_MCAMP=2;
function planAIDropSites(ai,aiTC,vils,profile){
  if(!profile.dropSites||vils.length<5)return;
  let hasBarracks=hasAIBuilding(ai,'BARRACKS');
  // Wood camps: build one at the nearest forest NOT already covered by the TC
  // or an existing camp, up to a cap — so villagers always have a short walk
  // to a wood drop instead of trekking to a far treeline with none. Camps stay
  // OUT of any food drop-off's farm belt.
  let lcamps=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='LCAMP');
  if(lcamps.length<AI_MAX_LCAMP&&canAfford(ai.team,BLDGS.LCAMP.cost)){
    let woodDrops=[aiTC,...lcamps];
    let pos=findAIDropSite(ai,TERRAIN.FOREST,'LCAMP',aiTC,true,woodDrops,AI_DROP_COVER);
    if(pos)placeAIBuilding(ai,'LCAMP',pos.x,pos.y);
  }
  // Bank resources for the upcoming barracks — but only while we can't yet
  // afford it. Once the barracks cost is covered and it STILL isn't up
  // (placement kept failing on a cramped map), holding here would deadlock
  // the whole eco chain forever: no mill, no mining camp, and planAIFarming
  // also gates on the barracks existing.
  if(!hasBarracks&&vils.length>=profile.barracksVil-1&&!canAfford(ai.team,BLDGS.BARRACKS.cost))return;
  if(vils.length>=6&&hasBarracks&&!hasAIBuilding(ai,'MILL')&&canAfford(ai.team,BLDGS.MILL.cost)){
    let pos=findAIDropSite(ai,TERRAIN.BERRIES,'MILL',aiTC);
    if(pos)placeAIBuilding(ai,'MILL',pos.x,pos.y);
  }
  // Mining camps serve BOTH gold and stone. Build one at a far gold deposit AND
  // one at a far stone deposit (each only if it's beyond AI_DROP_COVER of the
  // TC / an existing camp) — the old code placed camps at GOLD only, so a
  // distant stone deposit had no drop and villagers hauled stone all the way
  // back to the TC.
  let mcamps=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='MCAMP');
  if(vils.length>=7&&hasBarracks&&mcamps.length<AI_MAX_MCAMP){
    let drops=[aiTC,...mcamps];
    for(let ore of [TERRAIN.GOLD,TERRAIN.STONE]){
      if(mcamps.length>=AI_MAX_MCAMP||!canAfford(ai.team,BLDGS.MCAMP.cost))break;
      let pos=findAIDropSite(ai,ore,'MCAMP',aiTC,true,drops,AI_DROP_COVER);
      if(pos){ let b=placeAIBuilding(ai,'MCAMP',pos.x,pos.y); if(b){mcamps.push(b);drops.push(b);} }
    }
  }
}

function planAITowers(ai,aiTC,vils,profile){
  if(vils.length<8||!canAfford(ai.team,BLDGS.TOWER.cost))return;
  let currentTowers=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='TOWER').length;
  let maxTowers=profile.maxTowers||0;
  if(currentTowers>=maxTowers)return;
  // Prefer building the tower directly into the wall ring (gate flank, then
  // corners) once it's up, over a generic freestanding spot.
  let pos=findAIWallDefenseSpot(ai)||findAIBuildSpot(ai,aiTC,'TOWER');
  if(pos)placeAIBuilding(ai,'TOWER',pos.x,pos.y);
}

// ---- AI DEFENSIVE WALLS ----
// Builds a square wall ring around the AI town center once the economy is
// developed enough to afford it (profile.wallVils villagers), then closes it
// with a single gate so the AI's own villagers/army can still path out.
// The ring plan is computed once and cached so repeated calls just resume
// building the next unfinished tile instead of re-scanning every tick.
function planAIWalls(ai,aiTC,vils,profile){
  if(!profile.walls||vils.length<profile.wallVils)return;
  // Barracks before walls (AoE2 build order): the ring is a big wood sink
  // (2/tile × dozens + a 30-wood gate) that kept the bank permanently under
  // the 175-wood barracks price — sim runs showed BOTH 1v1 AIs fielding
  // zero military for 40k ticks because of it. Defense that can't train a
  // single spearman defends nothing.
  if(!hasAIBuilding(ai,'BARRACKS'))return;
  if(!ai.wallPlan)ai.wallPlan=computeAIWallRing(ai,aiTC,profile.wallRadius*aiScale());
  let plan=ai.wallPlan;

  // GATE-FIRST construction: the two reserved gate-pair tiles (on the eco
  // side, see computeAIWallRing) are built before anything else, and the
  // GATE is dropped on them as soon as both are walls. A gate is passable to
  // own units, so from that moment the base has a working eco-side opening —
  // it is NEVER sealed off from its resource camps while the rest of the
  // ring closes (the collapse this fixes). A GATE can only be placed by
  // consuming two adjacent walls, which is exactly why they must be built
  // first rather than left as an open gap.
  let gatePairs=ai.gatePairs||[];
  ai.gatesDone=ai.gatesDone||{};
  let isWallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&en.btype==='WALL'&&en.x===x&&en.y===y);
  let isGateAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&isGateBtype(en.btype)&&en.x>=x-1&&en.x<=x&&en.y>=y-1&&en.y<=y);
  gatePairs.forEach((pair,gi)=>{
    let gc=pair[Math.floor(pair.length/2)]; // centre tile — the gate anchor
    if(ai.gatesDone[gi]){
      if(isGateAt(gc.x,gc.y))return;   // gate still standing → nothing to do
      ai.gatesDone[gi]=false;          // gate was destroyed → rebuild it
    }
    if(isGateAt(gc.x,gc.y)){ai.gatesDone[gi]=true;return;}
    let allWalls=pair.every(p=>isWallAt(p.x,p.y));
    if(!allWalls){
      pair.forEach(p=>{
        if(!isWallAt(p.x,p.y)&&canAfford(ai.team,BLDGS.WALL.cost)){
          let b=placeAIBuilding(ai,'WALL',p.x,p.y);
          if(b){let pt=plan.find(t=>t.x===p.x&&t.y===p.y); if(pt)pt.done=true;}
        }
      });
    } else {
      // Drop the gate on the CENTRE tile: gateFootprint's centred branch then
      // consumes all three reserved walls → a full 3-tile gate.
      let b=placeAIBuilding(ai,'GATE',gc.x,gc.y);
      if(b){
        ai.gatesDone[gi]=true;
        ai.gateBuilt=true;               // at least one gate up → satisfies the ring-close/egress logic
        ai.gateTile=ai.gateTile||{x:gc.x,y:gc.y};
        pair.forEach(p=>plan.forEach(t=>{if(t.x===p.x&&t.y===p.y)t.done=true;}));
      }
    }
  });

  // ---- Honest enclosure state (the single source of truth) ----
  // `sealed` = an enemy genuinely CANNOT flood-reach the TC. `canExit` = our own
  // army genuinely CAN flood-reach outside. These replace `plan.every(done)`
  // (which only meant "attempted") and the pathReaches egress probe (which
  // false-positives). Computed once per call and reused below.
  let wr=ai.wallRadiusUsed||Math.round(profile.wallRadius*aiScale());
  let sealed=aiBaseSealed(aiTC,ai.team,wr);
  let rescueActive=plan.some(pt=>pt.rescueOpenUntil&&tick<pt.rescueOpenUntil);

  // Stone upgrade (AoE2: palisade → stone from Feudal on): only once actually
  // sealed and gated. GATES first (the funnel point), paced ≤4/decision, priced
  // exactly with a small stone float so it never outbids towers.
  if(sealed&&ai.gateBuilt&&isUnlocked(ai.team,'SWALL')){
    let pals=entities.filter(en=>en.type==='building'&&en.team===ai.team&&
      (en.btype==='WALL'||en.btype==='GATE')&&en.complete&&en.hp>0);
    pals.sort((a,b)=>(a.btype==='GATE'?0:1)-(b.btype==='GATE'?0:1)||a.id-b.id);
    let pick=[],stoneCost=0,bank=resourceStore(ai.team).stone;
    for(let en of pals){
      if(pick.length>=4)break;
      let c=BLDGS[en.btype==='GATE'?'SGATE':'SWALL'].cost.s||0;
      if(stoneCost+c+50>bank)continue; // skip what we can't afford (a pricey gate must not block cheap walls)
      stoneCost+=c;
      pick.push(en);
    }
    if(pick.length)execUpgradeWalls({unitIds:pick.map(w=>w.id)},ai.team);
  }

  // Egress: the base is sealed to enemies but our army can't get out (no gate,
  // or the gate/opening was destroyed or walled off). Carve one. A rescue hole
  // held open for a trapped worker already IS an opening — don't double-breach.
  if(sealed&&!rescueActive&&!armyCanReachEnemy(ai,aiTC)){
    if(!ai.gateBuilt){
      let result=resolveAIGate(ai,plan,aiTC);
      if(result==='satisfied'){ ai.gateBuilt=true; }
      else if(result){ let b=placeAIBuilding(ai,'GATE',result.x,result.y); if(b)ai.gateBuilt=true; }
      else { breachAIWallRing(ai,plan,aiTC); ai.gateBuilt=true; }
    } else {
      breachAIWallRing(ai,plan,aiTC); // gate existed but egress is blocked → reopen
    }
  }

  // Self-heal: re-queue every plan tile that is a GENUINE open gap, judged from
  // ACTUAL tile state (wallTileSealed) — not the `done` flag and not pathReaches.
  // This is what catches a chopped-forest seam (terrain no longer seals it, no
  // wall built) or a destroyed wall segment. Runs every decision. Keeps the
  // sole-egress opening and rescue holes open, and won't rebuild into a siege.
  if(!sealed||!plan.every(pt=>pt.done)){
    let gt=ai.gateTile;
    let foes=entities.filter(en=>en.type==='unit'&&en.hp>0&&isEnemyOf(ai.team,en));
    let hasRealGate=entities.some(e=>e.type==='building'&&e.team===ai.team&&isGateBtype(e.btype)&&e.hp>0);
    plan.forEach(pt=>{
      if(pt.rescueOpenUntil&&tick<pt.rescueOpenUntil)return; // held open to free a trapped worker
      if(gt&&pt.x===gt.x&&pt.y===gt.y&&!hasRealGate)return; // sole egress — keep it open
      if(wallTileSealed(pt,ai.team)){pt.done=true;return;}  // truly sealed (own bldg / terrain) → done
      if(foes.some(u=>Math.abs(u.x-pt.x)+Math.abs(u.y-pt.y)<=4))return; // active breach — don't rebuild into the assault
      pt.done=false; // genuine open gap → re-queue
    });
  }
  if(plan.every(pt=>pt.done))return; // ring physically complete — nothing to build

  // Place wall tiles (capped per call). `done` now means SEALED, set only when a
  // wall was actually placed, terrain permanently seals the tile, or a build
  // failure/unreachable case is proven harmless — never on a silent failure
  // (the old code's bug: it marked `done` regardless, recording never-built
  // tiles as sealed → the 6/8 leak). Failed placements back off and retry.
  let placedThisCall=0, iters=0;
  let wtcx=aiTC.x+Math.floor(aiTC.w/2), wtcy=aiTC.y+Math.floor(aiTC.h/2);
  let BACKOFF=Math.max(120,profile.decisionInterval*2);
  while(placedThisCall<8&&iters<40&&canAfford(ai.team,BLDGS.WALL.cost)){
    iters++;
    let next=plan.find(t=>!t.done&&!(t.buildBackoffUntil>tick));
    if(!next)break;
    if(terrainBarrier(next.x,next.y)){ next.done=true; continue; } // terrain permanently seals it
    if(buildingAtTile(next.x,next.y,en=>en.team===ai.team)){ next.done=true; continue; } // already our building
    // Can't reach to build? Only abandon (mark done) if the base is sealed WITHOUT
    // this tile — otherwise it's a real hole we just can't reach yet, so back off
    // and retry rather than lying that it's sealed.
    if(!pathReaches(wtcx,wtcy,next.x,next.y,aiTC.id)){
      if(aiBaseSealed(aiTC,ai.team,wr,next)){ next.done=true; }
      else next.buildBackoffUntil=tick+BACKOFF;
      continue;
    }
    let b=placeAIBuilding(ai,'WALL',next.x,next.y);
    if(b){ next.done=true; placedThisCall++; }
    else next.buildBackoffUntil=tick+BACKOFF; // transient block (unit on tile, etc.) → retry, don't lie
  }
}


// Tears down one of the AI's own wall tiles on the most useful side so the
// army can leave a ring that ended up fully sealed (no walkable opening and
// no placeable gate). A real player would delete a wall segment here too.
function breachAIWallRing(ai,plan,aiTC){
  let ranked=['N','S','E','W'].sort((a,b)=>scoreWallSide(ai,b,aiTC)-scoreWallSide(ai,a,aiTC));
  for(let side of ranked){
    let sideTiles=plan.filter(t=>t.side===side);
    let mid=Math.floor(sideTiles.length/2);
    let ordered=[sideTiles[mid],...sideTiles];
    for(let t of ordered){
      if(!t)continue;
      let w=entities.find(en=>en.type==='building'&&en.team===ai.team&&isWallBtype(en.btype)&&en.x===t.x&&en.y===t.y);
      if(w){
        // Through the normal deletion path (same as the player's Delete
        // key), not direct entities/map surgery — that bypassed death FX
        // and left ghost references if the player had the wall selected.
        deleteOwnedEntity(w);
        ai.gateTile={x:t.x,y:t.y};
        return true;
      }
    }
  }
  return false;
}

// ---- HONEST ENCLOSURE PRIMITIVES ----
// One ground-truth answer to "is my base sealed?" built on the SAME walkable()
// units actually path with — so the check can never disagree with reality (the
// old code used `plan.every(done)` [=attempted, not built] and pathReaches
// [returns false-positives on partial paths], and a frozen one-shot plan that
// never re-checked live terrain).

// Impassable natural terrain (a free wall). NOT the same as "a wall is here".
function terrainBarrier(x,y){
  if(x<0||y<0||x>=MAP||y>=MAP)return true;
  let t=map[y]&&map[y][x]; if(!t)return true;
  return t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES;
}

// A plan tile counts as SEALED only if something impassable-to-an-enemy is
// actually on it now: an allied building (wall/gate/house/camp) OR barrier
// terrain. This replaces the `done` flag as the truth for one tile, so a
// chopped-forest seam (terrain no longer a barrier, no wall built) reads as a
// genuine open gap and gets re-queued.
function wallTileSealed(pt,team){
  if(buildingAtTile(pt.x,pt.y,en=>en.team===team))return true;
  if(terrainBarrier(pt.x,pt.y))return true;
  return false;
}

// Ground truth: can an ENEMY reach the TC from outside RIGHT NOW? Bounded
// multi-source flood inward from the box boundary through enemy-passable ground.
// ignoreUnits=true → transient units don't count as walls; 8-connected but NO
// diagonal corner-cutting, matching unit movement (findPath). Gates: a CLOSED
// gate blocks, but an OPEN gate (it swung open for a nearby friendly — e.g. the
// rallied army parked at it) is passable to anyone, so the honest check must
// count it as a hole (walkable(-1) reads every gate as closed, so isOpen is
// tested explicitly). `extraBlock` optionally treats one tile as if walled.
// Returns true = SEALED.
function aiBaseSealed(aiTC,team,radius,extraBlock){
  let cx=aiTC.x+Math.floor(aiTC.w/2), cy=aiTC.y+Math.floor(aiTC.h/2);
  let R=Math.round(radius)+6, slack=2;
  let loX=Math.max(0,cx-R),hiX=Math.min(MAP-1,cx+R),loY=Math.max(0,cy-R),hiY=Math.min(MAP-1,cy+R);
  let pass=(x,y)=>{
    if(extraBlock&&x===extraBlock.x&&y===extraBlock.y)return false;
    if(walkable(x,y,-1,true))return true;
    let t=map[y]&&map[y][x];
    if(t&&t.occupied){ let o=entitiesById.get(t.occupied);
      if(o&&isGateBtype(o.btype)&&o.isOpen){ let horiz=o.w>=o.h, idx=horiz?(x-o.x):(y-o.y);
        if(idx===Math.floor(Math.max(o.w,o.h)/2))return true; } } // open gate = doorway hole
    return false;
  };
  let seen=new Set(), q=[], head=0;
  let seed=(x,y)=>{ let k=x+','+y; if(!seen.has(k)&&pass(x,y)){seen.add(k);q.push([x,y]);} };
  for(let x=loX;x<=hiX;x++){ seed(x,loY); seed(x,hiY); }
  for(let y=loY;y<=hiY;y++){ seed(loX,y); seed(hiX,y); }
  while(head<q.length){ let e=q[head++], x=e[0], y=e[1];
    if(Math.abs(x-cx)<=slack&&Math.abs(y-cy)<=slack)return false; // outside reached the TC → leak
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ if(!dx&&!dy)continue;
      let nx=x+dx,ny=y+dy; if(nx<loX||ny<loY||nx>hiX||ny>hiY)continue; let k=nx+','+ny;
      if(seen.has(k)||!pass(nx,ny))continue;
      if(dx&&dy&&(!pass(x+dx,y)||!pass(x,y+dy)))continue; // no corner-cut through a wall seam
      seen.add(k); q.push([nx,ny]); } }
  return true;
}

// Symmetric honest egress check: can OUR army get out? Flood from the TC
// courtyard through OWN-passable ground (walker=aiTC → our gates OPEN, our walls
// block) and see if it escapes the ring box. Replaces the pathReaches egress
// probe. A ring is healthy when aiBaseSealed && armyCanReachEnemy.
function armyCanReachEnemy(ai,aiTC){
  let cx=aiTC.x+Math.floor(aiTC.w/2), cy=aiTC.y+Math.floor(aiTC.h/2);
  let R=(ai.wallRadiusUsed||8)+6;
  let loX=Math.max(0,cx-R),hiX=Math.min(MAP-1,cx+R),loY=Math.max(0,cy-R),hiY=Math.min(MAP-1,cy+R);
  let pass=(x,y)=>walkable(x,y,aiTC.id,true);
  let sx=cx,sy=cy,seed=false;
  for(let r2=1;r2<=3&&!seed;r2++)for(let dy=-r2;dy<=r2&&!seed;dy++)for(let dx=-r2;dx<=r2&&!seed;dx++){
    if(pass(cx+dx,cy+dy)){sx=cx+dx;sy=cy+dy;seed=true;} }
  if(!seed)return true; // no courtyard to escape from → don't force a self-breach
  let seen=new Set([sx+','+sy]), q=[[sx,sy]], head=0;
  while(head<q.length){ let e=q[head++], x=e[0], y=e[1];
    if(x<=loX||y<=loY||x>=hiX||y>=hiY)return true; // reached the box edge → army can leave
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ if(!dx&&!dy)continue;
      let nx=x+dx,ny=y+dy; if(nx<loX||ny<loY||nx>hiX||ny>hiY)continue; let k=nx+','+ny;
      if(seen.has(k)||!pass(nx,ny))continue;
      if(dx&&dy&&(!pass(x+dx,y)||!pass(x,y+dy)))continue;
      seen.add(k); q.push([nx,ny]); } }
  return false;
}

function computeAIWallRing(ai,tc,radius){
  let r=Math.max(4,Math.round(radius));
  let cx=tc.x+Math.floor(tc.w/2),cy=tc.y+Math.floor(tc.h/2); // build the ring around its center
  // Remember the geometry so the honest seal-check (aiBaseSealed) can bound its
  // flood to this base. (Economy-radius growth — enclosing far gold/stone — is a
  // separate follow-up, gated on the seal metric; it must also widen the flood
  // margin, so it is intentionally NOT enabled here.)
  ai.wallRadiusUsed=r; ai.wallCx=cx; ai.wallCy=cy;
  let tiles=[];
  let seen=new Set();
  // Each tile remembers which side of the ring it's on, so the gate can be
  // chosen by side later (after we know where resources/the enemy actually
  // are) instead of being baked in as a fixed compass direction up front.
  let addTile=(x,y,side)=>{
    if(x<0||y<0||x>=MAP||y>=MAP)return;
    let key=x+','+y;
    if(seen.has(key))return;
    seen.add(key);
    tiles.push({x,y,done:false,side});
  };
  // GEOMETRIC SQUARE ring at Chebyshev radius r — a CONTINUOUS wall outline on
  // grass. Unlike a terrain-following ring it never depends on forest (which the
  // AI chops for wood — its lumber camps sit on the treeline), so clearing trees
  // can't spring a seam in it. Verified to seal 0/8 (no edge->TC path) where the
  // connectivity ring leaked 6/8. It crosses the resource band cosmetically, but
  // gold/stone are impassable and seal those segments; canPlace skips building
  // ON them, so no wood is wasted and no hole is left.
  // A corner TC sits closer to the edge than the ring radius. The map edge is
  // already a wall (out of bounds), so a side that would land on/past the border
  // is OMITTED entirely; the perpendicular sides extend to the edge to close the
  // corridor between the ring and the border.
  let hasN=cy-r>=1, hasS=cy+r<=MAP-2, hasW=cx-r>=1, hasE=cx+r<=MAP-2;
  let xLo=hasW?cx-r:0, xHi=hasE?cx+r:MAP-1;
  let yLo=hasN?cy-r:0, yHi=hasS?cy+r:MAP-1;
  if(hasN)for(let x=xLo;x<=xHi;x++)addTile(x,cy-r,'N');
  if(hasS)for(let x=xLo;x<=xHi;x++)addTile(x,cy+r,'S');
  if(hasW)for(let y=hasN?yLo+1:yLo;y<=(hasS?yHi-1:yHi);y++)addTile(cx-r,y,'W');
  if(hasE)for(let y=hasN?yLo+1:yLo;y<=(hasS?yHi-1:yHi);y++)addTile(cx+r,y,'E');
  // ---- Reserve TWO gates: one toward the ECONOMY, one toward the ENEMY ----
  // The old ring closed with a single gate carved AFTER the whole ring was
  // built, toward the ENEMY. When the eco's resource camps sat on the far
  // side, villagers were sealed from their own gold/wood/berries → idle →
  // Dark-Age collapse (sim seed 2001). A single eco-side gate instead fixed
  // that but forced the whole army to detour around the ring to reach the
  // enemy → a pathfinding storm and gate-bottleneck wedging. So reserve BOTH:
  // an eco-facing gate (short villager commute to camps) and an enemy-facing
  // gate (short army egress). Both are own-passable, cheap (30 wood), and
  // split the traffic. planAIWalls builds each pair's two tiles FIRST and
  // gates them immediately, so both openings exist from early construction —
  // the base is never sealed and the army never has to go the long way.
  let camps=entities.filter(e=>e.type==='building'&&e.team===ai.team&&(e.btype==='LCAMP'||e.btype==='MCAMP'||e.btype==='MILL'));
  let sideFor=(dx,dy)=>Math.abs(dx)>=Math.abs(dy)?(dx>=0?'E':'W'):(dy>=0?'S':'N');
  let ecx=0,ecy=0;
  if(camps.length){ camps.forEach(c=>{ecx+=(c.x+0.5)-cx;ecy+=(c.y+0.5)-cy;}); }
  let ed=getEnemyDirection(ai,tc);
  let ecoSide=camps.length?sideFor(ecx,ecy):sideFor(ed.dx,ed.dy);
  let enemySide=sideFor(ed.dx,ed.dy);
  // Reserve a 3-wide gate run on `side`; returns [left, centre, right] (or
  // top/mid/bottom) as close to the side's midpoint as possible, or null if 3
  // consecutive walkable ring tiles aren't available. Gates are a 3-tile
  // structure (see gateFootprint) — the gate is later dropped on the CENTRE
  // tile so its centred footprint lands on exactly these three walls.
  let reserveGate=(side)=>{
    let horiz=(side==='N'||side==='S');
    let axis=t=>horiz?t.x:t.y;
    let st=tiles.filter(t=>t.side===side&&walkable(t.x,t.y)&&!t.isGatePair);
    if(st.length<3)return null;
    st.sort((a,b)=>axis(a)-axis(b));
    let byAxis=new Map(st.map(t=>[axis(t),t]));
    let mid=st[Math.floor(st.length/2)];
    let run=c=>{ let l=byAxis.get(c-1),m=byAxis.get(c),r=byAxis.get(c+1); return (l&&m&&r)?[l,m,r]:null; };
    // Prefer the run centred on the side midpoint; otherwise the first window
    // of 3 consecutive walkable tiles found scanning outward.
    let picked=run(axis(mid));
    if(!picked){ for(let t of st){ let rr=run(axis(t)); if(rr){picked=rr;break;} } }
    if(!picked)return null;
    picked.forEach(t=>t.isGatePair=true);
    return picked.map(t=>({x:t.x,y:t.y}));
  };
  ai.gatePairs=[];
  let sides=ecoSide===enemySide?[ecoSide]:[ecoSide,enemySide];
  for(let s of sides){ let g=reserveGate(s); if(g)ai.gatePairs.push(g); }
  // If neither preferred side had a walkable run, fall back to any side.
  if(!ai.gatePairs.length){ for(let s of ['E','W','S','N']){ let g=reserveGate(s); if(g){ai.gatePairs.push(g);break;} } }
  return tiles;
}

const WALL_SIDE_DIR={N:{dx:0,dy:-1},S:{dx:0,dy:1},E:{dx:1,dy:0},W:{dx:-1,dy:0}};

// Direction the AI should care about for an exit: toward the known (or, if
// never scouted, assumed-from-start-position) enemy base — that's the route
// soldiers need to march out on to attack, and also the route a threat would
// approach from, so it doubles as the side worth guarding most.
function getEnemyDirection(ai,tc){
  let intel=ai.intel;
  let ex,ey;
  if(intel&&intel.tcSeen){
    ex=intel.tcX;ey=intel.tcY;
  } else {
    // Never scouted anyone: assume the nearest OTHER start position.
    let plStart=STARTS.filter(s=>!sameSide(ai.team,s.team))
      .sort((a,b)=>dist(a,tc)-dist(b,tc))[0];
    ex=plStart?plStart.x:0;ey=plStart?plStart.y:0;
  }
  let vx=ex-(tc.x+Math.floor(tc.w/2)),vy=ey-(tc.y+Math.floor(tc.h/2));
  let len=Math.sqrt(vx*vx+vy*vy)||1;
  return {dx:vx/len,dy:vy/len};
}

// Scores a ring side by how well it faces (a) the AI's own resource drop
// sites — so villagers have a short, direct walk out to gather/return — and
// (b) the enemy direction, weighted higher since the attack/defense route
// matters more than gathering convenience.
function scoreWallSide(ai,side,tc){
  let dir=WALL_SIDE_DIR[side];
  let score=0;
  entities.filter(e=>e.type==='building'&&e.team===ai.team&&['LCAMP','MCAMP','MILL'].includes(e.btype)).forEach(d=>{
    let vx=(d.x+0.5)-(tc.x+Math.floor(tc.w/2)),vy=(d.y+0.5)-(tc.y+Math.floor(tc.h/2));
    let len=Math.sqrt(vx*vx+vy*vy)||1;
    score+=(vx/len)*dir.dx+(vy/len)*dir.dy;
  });
  let enemyDir=getEnemyDirection(ai,tc);
  score+=(enemyDir.dx*dir.dx+enemyDir.dy*dir.dy)*2;
  return score;
}

// Decides where (if anywhere) to place the gate. Ranks the four sides by how
// useful they are (resource access + attack/defense route), then for the
// best side first checks whether a tile there already failed to get a wall
// (blocked by some other building before the ring was planned) — that's
// already a walkable opening, so nothing more to build. Otherwise it looks
// for a buildable pair of real walls on that side, preferring the midpoint.
// Falls through to the next-best side if the top side has neither.
function resolveAIGate(ai,plan,aiTC){
  let wallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&isWallBtype(en.btype)&&en.x===x&&en.y===y);
  let hasWallNeighbor=(x,y)=>wallAt(x+1,y)||wallAt(x-1,y)||wallAt(x,y+1)||wallAt(x,y-1);

  let ranked=['N','S','E','W'].sort((a,b)=>scoreWallSide(ai,b,aiTC)-scoreWallSide(ai,a,aiTC));
  for(let side of ranked){
    let sideTiles=plan.filter(t=>t.side===side);
    if(sideTiles.length===0)continue; // fully clamped-away side: nothing to gate
    // Only a *walkable* wall-less tile counts as a natural opening — the
    // usual reason a ring tile has no wall is that impassable terrain
    // (forest/gold/stone) blocked it, which seals the ring rather than
    // opening it. Treating those as openings walled the AI's army in.
    let hole=sideTiles.find(t=>!wallAt(t.x,t.y)&&walkable(t.x,t.y));
    if(hole){
      ai.gateTile=hole;
      return 'satisfied';
    }
    let mid=sideTiles[Math.floor(sideTiles.length/2)];
    let candidates=[mid,...sideTiles];
    let pick=candidates.find(c=>wallAt(c.x,c.y)&&hasWallNeighbor(c.x,c.y));
    if(pick){
      ai.gateTile=pick;
      return pick;
    }
  }
  return null;
}

// Picks the next-highest-priority spot to build a Watch Tower directly into
// the finished wall ring: the gate's flank first (it's the one breach point
// in an otherwise solid wall), then the four corners (the other natural
// ambush/sightline points along the perimeter).
function findAIWallDefenseSpot(ai){
  let plan=ai.wallPlan;
  if(!plan)return null;
  let ringDone=plan.every(t=>t.done);
  if(!ringDone)return null;
  let hasTowerAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&en.btype==='TOWER'&&en.x===x&&en.y===y);
  let isWallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&isWallBtype(en.btype)&&en.x===x&&en.y===y);

  let gateTile=ai.gateTile;
  if(gateTile){
    let flanks=[{x:gateTile.x+1,y:gateTile.y},{x:gateTile.x-1,y:gateTile.y},{x:gateTile.x,y:gateTile.y+1},{x:gateTile.x,y:gateTile.y-1}];
    let flank=flanks.find(f=>isWallAt(f.x,f.y)&&!hasTowerAt(f.x,f.y));
    if(flank)return flank;
  }

  let xs=plan.map(t=>t.x),ys=plan.map(t=>t.y);
  let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  let corners=[{x:minX,y:minY},{x:maxX,y:minY},{x:minX,y:maxY},{x:maxX,y:maxY}];
  return corners.find(c=>isWallAt(c.x,c.y)&&!hasTowerAt(c.x,c.y))||null;
}

// "Real" pressure = a CORE hit (a villager or the TC actually taking damage)
// in the last 900 ticks — NOT an enemy merely poking the wall ring. Used to
// decide whether survival outranks advancement (age-up / eco). Gating on any
// hit let a besieger stuck outside intact walls keep the AI permanently in
// "emergency" mode: it kept pumping military instead of banking the age cost,
// so a healthy walled economy (e.g. 443/500 food) never crossed into Feudal —
// the second half of the Dark-Age stall. Same core-hit basis as the bell.
function aiUnderRealPressure(ai){
  let h=lastTeamHit&&lastTeamHit[ai.team];
  return !!(h&&h.core&&tick-h.tick<900);
}

function planAIMilitaryBuildings(ai,aiTC,vils,barracks,profile){
  let pressured=aiUnderRealPressure(ai);
  if(ai.savingForAge&&!pressured&&barracks.length>0)return; // first barracks still allowed — needed for defense
  if(vils.length<profile.barracksVil||barracks.length>=profile.maxBarracks||!canAfford(ai.team,BLDGS.BARRACKS.cost))return;
  let pos=findAIBuildSpot(ai,aiTC,'BARRACKS');
  if(pos)placeAIBuilding(ai,'BARRACKS',pos.x,pos.y);
}

// ---- TRADE ECONOMY (Market, Trade Carts, commodity exchange) ----
// AoE2-style: the AI runs a Market for the commodity buy/sell exchange in
// EVERY game, and — ONLY when it has an ally to trade with — builds Trade
// Carts that shuttle to the ally's Market for gold. Carts are unarmed, so the
// AI never trades into an enemy base (no 1v1 land trade). All difficulties
// participate, so an easy ally still trades with its human partner in a 2v2.

// Does this team have an ally (another player team on the same side)?
function aiHasAlly(team){
  for(let u=0;u<NUM_TEAMS;u++) if(u!==team && sameSide(team,u)) return true;
  return false;
}
// The team's own Market (complete or a foundation), if any.
function aiOwnMarket(team){
  return entities.find(b=>b.type==='building'&&b.btype==='MARKET'&&b.team===team);
}
// Nearest COMPLETED Market owned by an ALLY (different player team, same side)
// — the AI's trade-cart destination. Deterministic: entities in array order,
// first-found tie-break (like nearestMarket, js/logic.js).
function nearestAllyMarket(e){
  let best=null,bd=Infinity;
  for(let i=0;i<entities.length;i++){
    let b=entities[i];
    if(b.type!=='building'||b.btype!=='MARKET'||!b.complete||b.hp<=0)continue;
    if(b.team===e.team||!sameSide(e.team,b.team))continue;
    let d=distToTarget(e,b);
    if(d<bd){bd=d;best=b;}
  }
  return best;
}

// Build ONE Market, OPPORTUNISTICALLY. The Market is a thriving-AI economic
// add-on, never something to starve other systems for: it is placed only when
// the AI is fully developed (max age reached — done teching), has a standing
// army (defense first), and simply HAS the 175 spare wood right now. A rich
// economy naturally banks that surplus (aiEcoPlan even halves chop above 600
// wood); a struggling economy just never builds one — which is correct. There
// is deliberately NO wood "reservation" that pauses walls/towers/farms/military
// to force the purchase (that crippled tight-economy 2v2 AIs into never
// attacking) — the market waits on genuine surplus instead.
function planAIMarket(ai,aiTC,vils,profile){
  if(!isUnlocked(ai.team,'MARKET'))return;               // Feudal-gated
  if(aiOwnMarket(ai.team))return;                         // one is enough
  if(teamAge[ai.team] < (profile.maxAge||2))return;      // finished teching first
  if(vils.length<profile.marketVil)return;
  let army=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&isArmyUnit(e.utype)).length;
  if(army<(profile.armyReserve||4))return;               // defense before trade
  if(!canAfford(ai.team,BLDGS.MARKET.cost))return;       // only when the surplus is genuinely there
  let pos=findAIBuildSpot(ai,aiTC,'MARKET');
  if(pos)placeAIBuilding(ai,'MARKET',pos.x,pos.y);
}

// Team games only: train Trade Carts up to the difficulty cap once a Market
// exists and there's an ally Market to trade with.
function queueAITradeCarts(ai,profile){
  if((profile.maxTradeCarts|0)<=0)return;
  if(!aiHasAlly(ai.team))return;                          // carts are a team-game tool
  let mkt=aiOwnMarket(ai.team);
  if(!mkt||!mkt.complete)return;
  if(!nearestAllyMarket(mkt))return;                     // nowhere to trade yet
  if(ai.savingForAge&&!aiUnderRealPressure(ai)){
    // don't distract from the age-up unless a cart line is already running
    if(!entities.some(e=>e.team===ai.team&&e.utype==='tradecart'))return;
  }
  let carts=0;
  for(let i=0;i<entities.length;i++){let e=entities[i];if(e.team===ai.team&&e.type==='unit'&&e.utype==='tradecart')carts++;}
  carts+=mkt.queue.filter(u=>u==='tradecart').length;
  if(carts>=profile.maxTradeCarts)return;
  if(!canAfford(ai.team,UNITS.tradecart.cost))return;
  queueUnit(mkt,'tradecart');
}

// Route idle carts (no active route) to the nearest ally Market. Once the
// trade fields are set, updateTradeCart (js/logic.js) drives and self-heals
// the shuttle; the AI only touches carts that are currently idle. Assign only
// when BOTH a home and an ally market exist (else updateTradeCart would fire
// its "needs a market" feedback and the cart would sit idle anyway).
function controlAITradeCarts(ai,aiUnits){
  for(let i=0;i<aiUnits.length;i++){
    let c=aiUnits[i];
    if(c.utype!=='tradecart')continue;
    if(c.tradeDestId!=null||c.tradeHomeId!=null)continue;
    let home=nearestMarket(c,true);
    let dest=nearestAllyMarket(c);
    if(!home||!dest)continue;                             // no enemy trade — leave idle
    c.tradeHomeId=home.id; c.tradeDestId=dest.id; c.tradePhase='toDest';
    c.target=null; c.task=null; clearUnitPath(c);
    let pt=nearestBldgPerimeter(c.x,c.y,dest,c.id);
    if(pt)pathUnitTo(c,pt.x,pt.y);
  }
}

// Commodity exchange (all difficulties, 1v1 + team). At most one 100-lot per
// decision tick so the shared marketPrices don't crater/spike; the buy and
// sell conditions are mutually exclusive (gold-low vs gold-high) so no
// oscillation. Selling prefers stone (classic AoE2); buying relieves the worst
// non-gold bottleneck and never spends below the gold-rich threshold.
function planAIMarketExchange(ai,profile){
  let mkt=aiOwnMarket(ai.team);
  if(!mkt||!mkt.complete)return;
  let r=resourceStore(ai.team);
  if(r.gold<80){
    let res=r.stone>250?'stone':r.wood>500?'wood':r.food>400?'food':null;
    if(res)execMarketTrade({dir:'sell',resType:res},ai.team);
  } else if(r.gold>300){
    let res=r.wood<120?'wood':r.food<100?'food':null;
    if(res&&r.gold-marketPrices[res]>=300)execMarketTrade({dir:'buy',resType:res},ai.team);
  }
}

function queueAIMilitary(ai,readyBarracks,profile){
  let currentArmy=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&isArmyUnit(e.utype)).length;
  // Train toward the NEXT wave's size (plus home defense reserve) so the
  // army goal escalates with each wave launched, AoE2-style.
  let maxArmy=aiWaveSize(ai,profile)+profile.armyReserve;
  if(currentArmy>=maxArmy)return;
  
  // Saving for an age-up: military spending yields the food/gold (the age
  // research is the bigger power spike; villagers keep training) — UNLESS
  // we've taken a hit recently. Survival outranks advancement, AoE2-style:
  // an AI that keeps hoarding while its army isn't reinforcing dies rich.
  let underPressure=aiUnderRealPressure(ai);
  // Saving for an age: military spending yields — but never below a small
  // standing defense (half the army reserve). The saving window can span
  // many minutes on a slow food economy, and a blanket pause left AIs
  // sitting on 1000+ banked wood with a barracks and ZERO soldiers.
  if(ai.savingForAge&&!underPressure&&currentArmy>=Math.ceil(profile.armyReserve/2))return;
  // Eco-first (AoE2): below the next age's villager benchmark, food belongs
  // to the TC. Without this, militia (60f each) drained food back under the
  // villager planner's militaryFoodReserve faster than it regenerated —
  // villager growth plateaued below ageUpVils and EVERY AI sat in the Dark
  // Age forever. A small standing defense is still allowed, and pressure
  // overrides (survival outranks advancement, same as savingForAge above).
  let next=teamAge[ai.team]+1;
  let ecoTarget=next<AGES.length&&profile.ageUpVils&&profile.ageUpVils[next];
  if(ecoTarget&&!underPressure){
    let vilCount=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='villager').length;
    if(vilCount<ecoTarget&&currentArmy>=Math.ceil(profile.armyReserve/2))return;
  }
  // Only currently-unlocked rosters — Dark-age barracks train militia only.
  let types = AI_MIL_TYPES.filter(t=>isUnlocked(ai.team,t));
  if(types.length===0)return;
  // Rock-paper-scissors counters, per the unit descriptions in core.js:
  // spearman is anti-cavalry (counters scout AND knight), archers shred
  // standing infantry. The scout line is reserved SOLELY for recon (exactly
  // one explorer — see ensureAIScout; controlAIScouts owns every utype==='scout'
  // and won't let it fight), so it is never a military pick: anti-archer is the
  // knight once unlocked, else militia (the melee closer in this roster).
  // Picked from real scouted intel, not omniscient knowledge of the player's army.
  let counterMap={scout:'spearman',knight:'spearman',archer:isUnlocked(ai.team,'knight')?'knight':'militia',militia:'archer',spearman:'archer'};
  // Castle-age siege contingent: keep ~1 ram per 6 army slots so attack
  // waves can crack walls/towers instead of bouncing off them (the wave
  // targeting already points rams at structures — see chooseAIAttackTarget).
  let ramCount=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='ram').length
    +readyBarracks.reduce((s2,b)=>s2+b.queue.filter(q=>q==='ram').length,0);
  let ramGold=UNITS.ram.cost.g||0;
  let wantRam=isUnlocked(ai.team,'ram')&&ramCount<Math.ceil(maxArmy/6);
  let pickUnitType=()=>{
    // NOTE: don't mutate ramCount/wantRam here — the actual queueUnit can still
    // fail (pop cap) and fall back to spearman/militia, which would leave ram
    // accounting overstated and under-produce rams. The caller updates the count
    // only on a confirmed ram queue.
    if(wantRam&&canAfford(ai.team,UNITS.ram.cost)) return 'ram';
    // Saving for a ram but gold-short: RESERVE gold for the siege — train the
    // gold-free spearman meanwhile so gold banks toward the 75 a ram needs,
    // instead of dribbling it into militia/knights. Gold-starved Castle AIs
    // used to pour every scrap of gold into gold-hungry units and never afford
    // a single ram, so their attacks bounced off walls forever (the finishing
    // stalemate's other half). Spearman is decent filler and needs no gold.
    if(wantRam&&resourceStore(ai.team).gold<ramGold&&isUnlocked(ai.team,'spearman'))return 'spearman';
    let counts=ai.intel&&ai.intel.unitCounts;
    if(counts){
      let dominant=Object.keys(counts).filter(t=>counterMap[t]).sort((a,b)=>counts[b]-counts[a])[0];
      // Counter-pick most of the time once there's real intel on what the
      // player is fielding — not always, so the matchup isn't perfectly
      // predictable/exploitable by the player switching unit types.
      if(dominant&&simRandom()<0.7&&isUnlocked(ai.team,counterMap[dominant]))return counterMap[dominant];
    }
    return types[simRandInt(0, types.length - 1)];
  };

  // Count queued military across ALL barracks against the cap — the old
  // per-barracks `currentArmy + barracks.queue.length` check let 2 barracks
  // overshoot maxArmy by a full queue, double-spending food the villager
  // planner may have reserved.
  let queuedArmy=readyBarracks.reduce((s,b)=>s+b.queue.length,0);
  readyBarracks.forEach(barracks=>{
    while(barracks.queue.length<profile.queueLimit&&teamPopUsed(ai.team)+teamQueuedPop(ai.team)<teamPopCap(ai.team)&&currentArmy+queuedArmy<maxArmy){
      let utype = pickUnitType();
      // Counter-pick first, then cheaper fallbacks if it's unaffordable.
      let placed = queueUnit(barracks,utype).ok ? utype
                 : queueUnit(barracks,'spearman').ok ? 'spearman'
                 : queueUnit(barracks,'militia').ok ? 'militia' : null;
      if(placed){
        queuedArmy++;
        if(placed==='ram'){ ramCount++; if(ramCount>=Math.ceil(maxArmy/6))wantRam=false; } // count only a CONFIRMED ram
      } else {
        break;
      }
    }
  });
}

const AI_REBALANCE_MAX=2; // gatherers re-tasked per decision — gradual, avoids thrash
function assignAIVillagers(ai,vils,profile){
  let incompleteBuilds=entities.filter(en=>en.type==='building'&&en.team===ai.team&&(!en.complete || en.hp < en.maxHp));
  // Active re-tasking by need. The balancer below only re-picks a task for an
  // IDLE or STALE villager, so a worker locked on a still-productive resource
  // was never moved when priorities flipped — e.g. once the wall ring was done
  // the wood demand collapsed, but the 8 villagers already chopping kept at it,
  // piling 1000+ wood while food starved and the age-up never banked its 500
  // (sim seed 2001: 10 farms, 1 farmer, 8 choppers, stuck in Dark Age). Pull a
  // few workers off any task that now has clearly MORE hands than aiEcoPlan
  // wants (which already sheds chop when wood floods / boosts farm when saving
  // for age) and let assignAIGatherTask re-pick the neediest resource for them.
  let desired=aiEcoPlan(ai,vils.length,profile);
  let counts=countAIGatherers(vils);
  let rebalanced=0;
  // Construction-labor governor. The defensive wall RING is dozens of segments,
  // and with buildersPerBuilding=1 every spare villager grabs a different one —
  // so the whole town downs tools to wall, freezing food+wood gathering for
  // minutes right when the economy needs to grow (seed 7: 9 of 10 villagers
  // building at tick 25k, food & wood both 0, never reached the 500-food Feudal
  // age-up). Cap villagers on WALL/GATE work to a third of the workforce so the
  // ring goes up GRADUALLY while the rest keep gathering — a healthy economy
  // that walls a bit slower beats a frozen one that walls fast then starves. The
  // ring still completes (just past the ~55k seal-oracle checkpoint on the
  // slowest seeds); the economy never stalls, which is what actually loses games.
  // Houses/farms/barracks/TC are uncapped — few, and economically essential.
  let wallBuilderCap=Math.max(2,Math.floor(vils.length/3));
  let isWallWork=b=>b&&(isWallBtype(b.btype)||isGateBtype(b.btype));
  let wallBuilders=vils.filter(u=>u.task==='build'&&isWallWork(entitiesById.get(u.buildTarget))).length;
  let overSubscribed=(task)=>{
    if(!GATHER_TASKS[task])return false;
    if(!((counts[task]||0) > Math.max(1,desired[task]||0)+1))return false; // clear surplus only
    return Object.keys(desired).some(k=>k!==task && (counts[k]||0) < (desired[k]||0)); // somewhere needs hands
  };
  vils.forEach(v=>{
    // Sheltering villagers (inside a building or running to one after the
    // town bell) are off-limits: re-tasking them while immobile can claim
    // them as the sole builder of something they can't reach.
    if(v.garrisonedIn||v.task==='garrison')return;
    if(v.path.length>0||v.target)return;
    if(v.task==='build'){
      // isAIGatherTaskStale() doesn't know 'build' as a task type, so it was
      // reporting an actively-building villager "stale" every single decision
      // tick and yanking it off to gather mid-construction — the building
      // would then get re-flagged as needing work and pull someone back,
      // looking like the AI bumping off and returning. Only leave the build
      // if its target is actually gone/finished.
      let target=v.buildTarget&&entitiesById.get(v.buildTarget);
      if(target&&target.team===ai.team&&(!target.complete||target.hp<target.maxHp))return;
    }
    let build=neededAIBuildingWork(ai,incompleteBuilds,vils,profile,v);
    if(build&&v.task!=='build'){
      // Throttle wall/gate construction to the governor above; let the villager
      // fall through to gathering when the wall crew is already at capacity.
      if(isWallWork(build)&&wallBuilders>=wallBuilderCap){
        // fall through to gather
      } else {
        assignAIBuilder(v,build);
        if(isWallWork(build))wallBuilders++;
        return;
      }
    }
    if(v.task&&v.task!=='build'&&!isAIGatherTaskStale(v)){
      // Still productive on its current resource — leave it unless the mix is
      // badly skewed from what the economy needs now (capped per decision), OR
      // it's a lone stone miner sitting on a stone hoard (the >800→chop cutoff
      // only applies at assignment, so a single miner otherwise mines forever).
      let hoardStone = v.task==='mine_stone' && resourceStore(ai.team).stone>800;
      if(rebalanced<AI_REBALANCE_MAX && (overSubscribed(v.task)||hoardStone)){
        rebalanced++;
        counts[v.task]=(counts[v.task]||0)-1;              // source loses a hand
        assignAIGatherTask(ai,v,vils,profile);
        if(GATHER_TASKS[v.task])counts[v.task]=(counts[v.task]||0)+1; // ...and credit the destination, so a 2nd pull this tick judges against the updated mix
      }
      return;
    }
    assignAIGatherTask(ai,v,vils,profile);
  });
}

function neededAIBuildingWork(ai,incompleteBuilds,vils,profile,v){
  return incompleteBuilds.find(build=>{
    // Exhausted farms are NOT building work for an AI: auto-reseed pays
    // from the bank the moment 60 wood exists (updateBuilding, js/logic.js).
    // Offering them here put every idle villager on a treadmill — walk to
    // farm → can't pay reseed → back off → idle → next farm — that starved
    // the gather assigner: a town with 41 spent farms had ZERO choppers
    // earning the wood the reseeds were waiting for.
    if (build.btype === 'FARM' && build.exhausted) return false;
    // A builder recently failed at this site — unreachable, or a repair
    // the bank couldn't pay (js/logic.js stamps the back-off; expires).
    if ((build.buildBackoffUntil||0) > tick) return false;
    let assigned=vils.filter(u=>u.task==='build'&&u.buildTarget===build.id).length;
    if (assigned >= profile.buildersPerBuilding) return false;

    // Reachability is checked from the ACTUAL builder v, not the TC: a villager
    // sealed off from the ring (caught outside when the wall closed, boxed in a
    // pocket) must not be handed a foundation only the TC can reach — that's
    // the churn-until-watchdog loop. Falls back to the TC when no v is given.
    let src = v || entities.find(e => e.team === ai.team && e.btype === 'TC');
    if (src) {
      let b = BLDGS[build.btype];
      let pt = b.isFarm ? {x: build.x, y: build.y} : (typeof nearestBldgPerimeter === 'function' ? nearestBldgPerimeter(src.x, src.y, build, src.id) : {x: build.x, y: build.y});
      if (!pathReaches(Math.round(src.x), Math.round(src.y), pt.x, pt.y, src.id)) {
        return false;
      }
    }
    return true;
  });
}

function assignAIBuilder(v,build){
  v.task='build';
  v.buildTarget=build.id;
  v.target=null;
  clearGatherTarget(v);
  let b=BLDGS[build.btype];
  let pt=b.isFarm?{x:build.x,y:build.y}:(typeof nearestBldgPerimeter==='function'?nearestBldgPerimeter(v.x,v.y,build,v.id):{x:build.x+build.w,y:build.y+build.h});
  pathUnitTo(v,pt.x,pt.y);
  // No path and not already at the site (forest-locked pocket, sealed-in
  // ring tile): back the foundation off and stand down NOW — parking the
  // villager on an unreachable job feeds the retry/reassign loop that the
  // stuck-watchdog then has to break up.
  let close=b.isFarm?dist(v,{x:build.x+0.5,y:build.y+0.5})<1.2:adjToBuilding(v.x,v.y,build);
  if(v.path.length===0&&!close){
    build.buildBackoffUntil=tick+900;
    v.task=null;
    v.buildTarget=null;
  }
}

function isAIGatherTaskStale(v){
  if(!GATHER_TASKS[v.task])return true;
  if(v.gatherX<0)return false;
  let cfg=GATHER_TASKS[v.task];
  let tile=map[v.gatherY]&&map[v.gatherY][v.gatherX];
  return !tile||tile.t!==cfg.terrain||tile.res<=0||!canGatherTile(v,cfg.terrain,v.gatherX,v.gatherY);
}

// Nearest huntable herdable (live sheep or standing carcass) this villager can
// actually reach — AoE2's free, high-value, FINITE opening food. Only gaia
// strays or our own already-converted flock (never poach an enemy's), and only
// within a short leash so nobody wanders the map chasing a lone sheep; a live
// sheep converts to us automatically as the villager closes (js/logic.js).
// Nearest huntable herdable this villager can reach. Several villagers can ring
// and eat one carcass (js/logic.js), so no per-sheep cap is needed — the
// starting-crew-on-one-sheep opening is exactly how it's meant to work.
const AI_SHEEP_HUNT_RANGE=24;
function nearestAISheep(ai,v){
  let cands=[];
  for(let e of entities){
    if(e.hp<=0)continue;
    if(e.utype!=='sheep'&&e.utype!=='sheep_carcass')continue;
    if(e.team!==GAIA_TEAM&&e.team!==ai.team)continue; // gaia strays or our own flock; never poach an enemy's
    let d=Math.abs(e.x-v.x)+Math.abs(e.y-v.y);
    if(d<=AI_SHEEP_HUNT_RANGE)cands.push({e,d});
  }
  cands.sort((a,b)=>a.d-b.d);
  for(let c of cands)if(pathReaches(v.x,v.y,c.e.x,c.e.y,v.id))return c.e;
  return null;
}

function assignAIGatherTask(ai,v,vils,profile){
  let desired=aiEcoPlan(ai,vils.length,profile);
  let counts=countAIGatherers(vils);
  // What can this villager work for task T right now? Returns a resource TILE
  // {x,y} for terrain tasks, or a {sheep} sentinel for forage when a nearby
  // herdable is the food source. Requires the resource to both exist nearby AND
  // be path-reachable — findNearTile is a proximity probe only (a tile can be
  // "near" yet walled off), so pathReaches is the real gate. null =
  // unfulfillable. Stone with a full stockpile has no sink → unfulfillable, so
  // a lone miner doesn't mine a useless hoard.
  let targetFor=(task)=>{
    if(task==='mine_stone'&&resourceStore(ai.team).stone>800)return null;
    if(task==='forage'){
      // Wild food, AoE2 order: eat the free, high-value, finite SHEEP first
      // (they convert to us as the villager closes) before berry bushes. This
      // is the AI's main early-food source — farms need a Barracks + wood
      // first, and berries are often scarce — so ignoring the ~600 food of
      // starting herdables was Dark-Age-locking food-poor starts.
      let sheep=nearestAISheep(ai,v);
      if(sheep)return{sheep};
    }
    let cfg=GATHER_TASKS[task]; if(!cfg)return null;
    let t=findNearTile(v,cfg.terrain,null,null,true); // proximity probe, no claim
    return (t&&pathReaches(v.x,v.y,t.x,t.y,v.id))?t:null;
  };
  // Assign the highest-DEFICIT task (most under-staffed vs the plan) that this
  // villager can actually fulfil. This replaces the old "pick the single
  // neediest, and if its resource isn't proximate hard-redirect to chop"
  // scheme, whose root flaw was dumping every unmeetable demand onto WOOD:
  // a dead 'forage' (berries foraged out, fill ratio pinned at 0) perpetually
  // won the slot then collapsed to chop, and a walled-off gold/farm did the
  // same — so towns banked 9000 wood while gold pinned at ~10 or food starved,
  // Dark/Feudal-locking for whole matches. Skipping unfulfillable tasks lets
  // the next REAL need (gold for Castle/rams, farms for food) take the hand.
  let ranked=Object.keys(desired)
    .filter(t=>GATHER_TASKS[t])
    .sort((a,b)=>(counts[a]||0)/desired[a]-(counts[b]||0)/desired[b]);
  let task=null, target=null;
  for(let t of ranked){ let tg=targetFor(t); if(tg){task=t;target=tg;break;} }
  if(!task){
    // Every resource the plan wants is walled off from where this villager
    // stands. Walk to/through the nearest own GATE (own units pass the centre
    // tile) so the rest of the map opens up, then re-evaluate next decision.
    let gates=(ai.gatePairs||[]).map(p=>p[Math.floor(p.length/2)]).filter(g=>(Math.abs(v.x-g.x)+Math.abs(v.y-g.y))>1.5&&pathReaches(v.x,v.y,g.x,g.y,v.id));
    if(gates.length){
      gates.sort((a,b)=>(Math.abs(v.x-a.x)+Math.abs(v.y-a.y))-(Math.abs(v.x-b.x)+Math.abs(v.y-b.y)));
      v.task=null;v.target=null;v.buildTarget=null;clearGatherTarget(v);
      pathUnitTo(v,gates[0].x,gates[0].y);
      return;
    }
    task='chop'; // last resort — wood is virtually always somewhere reachable
  }
  v.buildTarget=null;
  clearGatherTarget(v);
  // Herdable food: hunt it directly, target-based — and with NO task, exactly
  // like the player's own sheep command (js/commands.js). The harvest path only
  // runs on `target && !task` (js/logic.js); setting task='forage' alongside
  // the target silently disabled it and wedged the villager. countAIGatherers
  // credits a sheep-targeting villager as forage, so it still counts as a food
  // gatherer against the plan. When the carcass is gone the villager goes idle
  // and the balancer re-picks its next food source (another sheep, then
  // berries/farms).
  if(target&&target.sheep){ v.task=null; v.target=target.sheep.id; return; }
  v.task=task;
  v.target=null;
  // Drop-anchor the gather tile: prefer the resource patch nearest this task's
  // own drop-off (its camp/TC) — short round trips, and a freshly-placed camp
  // gets used instead of hauling across the map. Falls back to the reachable
  // tile the selection loop already found.
  let gc=GATHER_TASKS[v.task];
  if(gc){
    let drop=nearestDrop(v,gc.resource);
    if(drop){
      let anchor={x:drop.x+(drop.w||1)/2,y:drop.y+(drop.h||1)/2};
      let at=findNearTile(v,gc.terrain,null,anchor);
      if(at&&pathReaches(v.x,v.y,at.x,at.y,v.id))target=at;
    }
    if(target&&target.x!=null){v.gatherX=target.x;v.gatherY=target.y;}
  }
}

function aiEcoPlan(ai,vilCount,profile){
  let militaryStarted=entities.some(e=>e.team===ai.team&&e.type==='building'&&e.btype==='BARRACKS');
  // AoE2 Dark Age economy: food + wood first (villager production and
  // buildings), gold only once military production begins, stone only for
  // walls/towers (the wall-plan boost below handles that).
  if(vilCount<=5)return{forage:4,chop:2};
  if(!militaryStarted)return{forage:4,chop:4,mine_gold:1};
  // Only include 'farm' key when value > 0 — a zero denominator in the gatherer sort produces NaN
  // SPREAD the profile's ratios: this function mutates `base` below (farm
  // key, wall stone boost) and must never write into the shared AI_LEVELS.
  let base={...profile.ecoRatios};
  // Staff the farms we actually have: ~one farmer per active farm, never
  // below the profile floor (fixed 2-4 shares idled the extra plots the
  // dynamic farm target above builds). Keyed on the FARMS existing, NOT on
  // owning a Mill: farms drop at the TC too, so a berry-less start now builds
  // farms (planAIFarming) — but if staffing stayed mill-gated it built plots
  // and assigned zero farmers, chopping wood while food starved to ~0 and it
  // never left the Dark Age (sim seeds 3001/8001: 12 farms, food 2, wood 2000+).
  let activeFarms=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='FARM'&&e.complete&&!e.exhausted).length;
  if(activeFarms>0){
    base.farm=Math.max(profile.farmShare,activeFarms);
  }
  // A palisade ring is a WOOD sink (2/tile, dozens of tiles, plus the 30-
  // wood gate) — pull extra gatherers onto wood until it's finished.
  let wallPlan=ai.wallPlan;
  if(wallPlan&&!wallPlan.every(t=>t.done))base.chop=(base.chop||1)+3;
  // Demand rebalancing (AoE2 AIs re-task gatherers by need): a fat
  // stockpile stops attracting hands and the binding resource pulls extra
  // shares. Without this a town sat on 3459 banked wood while food never
  // topped 60 — chopping on a fixed ratio forever while the 800-food
  // Castle age stayed out of reach for the whole match.
  let store=resourceStore(ai.team);
  if(store.wood>600&&base.chop)base.chop=Math.max(1,Math.floor(base.chop/2));
  if(store.gold>500&&base.mine_gold)base.mine_gold=Math.max(1,Math.floor(base.mine_gold/2));
  if(store.stone>400&&base.mine_stone)delete base.mine_stone;
  if(store.food<250){
    if(base.farm)base.farm*=2;
    if(base.forage)base.forage*=2;
  }
  // Saving for the next age: bias gatherers toward the resources that age
  // actually COSTS so a turtled economy still accrues the age price. Hard
  // AIs stalled at Feudal for entire matches sitting on ~60 gold (Castle
  // needs 200) while stone piled to 750 and the gold camp sat unreachable
  // behind the wall ring — but gold always drops at the TC, so pointing
  // more hands at gold accrues the age price regardless of the camp. This
  // is what unlocks Castle-age units (knights, rams) for the AI at all.
  if(ai.savingForAge){
    let next=teamAge[ai.team]+1;
    let cost=(AGES[next]&&AGES[next].cost)||{};
    if(cost.g&&store.gold<cost.g)   base.mine_gold=(base.mine_gold||1)+4;
    if(cost.f&&store.food<cost.f){ if(base.farm)base.farm+=2; base.forage=(base.forage||1)+2; }
    // don't keep pouring hands into wood/stone the age-up doesn't need
    if(base.chop)base.chop=Math.max(1,Math.floor(base.chop/2));
    if(base.mine_stone)delete base.mine_stone;
  }
  return base;
}

function countAIGatherers(vils){
  return vils.reduce((counts,v)=>{
    if(GATHER_TASKS[v.task])counts[v.task]=(counts[v.task]||0)+1;
    // Sheep-hunters carry no gather task (target-based, like the player's sheep
    // command) — credit them as forage so the plan sees food being gathered and
    // doesn't pile still more hands onto food.
    else if(v.target){ let t=entitiesById.get(v.target); if(t&&(t.utype==='sheep'||t.utype==='sheep_carcass'))counts.forage++; }
    return counts;
  },{forage:0,farm:0,chop:0,mine_gold:0,mine_stone:0});
}

function planAIFarming(ai,aiTC,vils,profile){
  // Farms drop food at the nearest food drop-off — the TC (always present,
  // dropAccepts it universally) or a Mill. Do NOT gate on having a Mill: the
  // Mill only ever gets built on a BERRIES patch (planAIDropSites), so a
  // berry-less start never built one → never farmed → starved in the Dark Age
  // forever while wood piled up (sim seeds 4001/8001: age 0 at 90k, food ~10,
  // wood 3800, zero farms/mills). Farms tile around the TC just fine.
  // Only worthwhile once military is underway (barracks up).
  if(!hasAIBuilding(ai,'BARRACKS'))return;
  if(vils.length<6||!canAfford(ai.team,BLDGS.FARM.cost))return;
  // ACTIVE farms only (exhausted ones auto-reseed and shouldn't block new
  // plots), against a target that grows with the workforce — a fixed 2-4
  // farm cap starved the AI's food economy once the berries ran out.
  let activeFarms=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='FARM'&&!e.exhausted).length;
  let targetFarms=aiFarmTarget(ai,vils,profile);
  // Deadlock breaker: farm target scales with villager count, villager
  // count is gated by food, food is gated by farms — a town that lost its
  // forage (or its forest walk got long) locked at N farms forever while
  // wood piled up and villagers idled (sim seed 7: 10 idle, 1800 wood,
  // food ~40). Idle hands + spare wood = plant more farms.
  let idleV=vils.filter(v=>!v.task&&!v.target&&!v.buildTarget&&v.path.length===0&&!v.garrisonedIn).length;
  if(idleV>1&&resourceStore(ai.team).wood>=200)targetFarms=Math.max(targetFarms,activeFarms+Math.min(idleV,4));
  // Hard ceiling: never more farms than ~3/4 of the workforce can staff.
  // Unbounded, the idle-hands rule above ratcheted one town to 34 farms
  // (2000+ wood buried in unworked plots) and DELAYED its age-up past an
  // easy opponent's — farms only feed you if someone farms them.
  targetFarms=Math.min(targetFarms,Math.max(profile.targetFarms,Math.floor(vils.length*0.75)));
  if(activeFarms>=targetFarms)return;
  let pos=findAIFarmSpot(ai,aiTC);
  if(pos)placeAIBuilding(ai,'FARM',pos.x,pos.y);
}

// Farms wanted right now: the profile floor plus one per two villagers
// beyond a starting workforce of 8, capped at 3x the floor.
function aiFarmTarget(ai,vils,profile){
  return Math.min(profile.targetFarms*3,
    profile.targetFarms+Math.max(0,Math.floor((vils.length-8)/2)));
}

// AoE2-style farm packing: farmers drop food at the nearest food drop-off
// (the TC or a Mill), so lay 2x2 plots in grid-aligned rows flush against
// those buildings, closest slot first. Around the 4x4 TC that's a tidy 2
// farms per side; a 2x2 Mill gets one per side — then the block grows
// outward in aligned rings. This replaces the old radial spiral, which
// scattered plots at rounded angles and ignored the Mill entirely.
function findAIFarmSpot(ai,tc){
  const F=BLDGS.FARM.w; // 2-tile farm footprint (square)
  let maxR=Math.round(10*aiScale());
  let drops=[tc, ...entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='MILL'&&e.complete)];
  let cands=[];
  for(let d of drops){
    // Candidate origins are aligned to this drop's own grid (multiples of F
    // from its origin) so the plots tile edge-to-edge with it and each other.
    let x0=d.x-F*Math.ceil(maxR/F), y0=d.y-F*Math.ceil(maxR/F);
    for(let fx=x0; fx<=d.x+d.w+maxR; fx+=F){
      for(let fy=y0; fy<=d.y+d.h+maxR; fy+=F){
        if(fx+F>d.x && fx<d.x+d.w && fy+F>d.y && fy<d.y+d.h) continue; // overlaps the drop
        // squared nearest-edge distance from the plot centre to the drop rect
        let cx=fx+F/2, cy=fy+F/2;
        let ex=Math.max(d.x-cx,0,cx-(d.x+d.w));
        let ey=Math.max(d.y-cy,0,cy-(d.y+d.h));
        let dd=ex*ex+ey*ey;
        if(dd>maxR*maxR) continue;
        cands.push({x:fx,y:fy,dd});
      }
    }
  }
  // Nearest drop-edge first; deterministic tie-break keeps the sim in lockstep.
  cands.sort((a,b)=>a.dd-b.dd || a.x-b.x || a.y-b.y);
  // Farms are walkable so they don't truly block a gate, but a farmer working
  // in the gateway looks wrong — keep plots out of the gate corridor too. Also
  // require the plot be reachable from the TC: placing a farm a builder can't
  // path to just parks it as unbuildable work and wedges the assigned
  // villager (stuck-watchdog). (The TC centre tile is on the walkable
  // courtyard edge, so it's a valid path source.)
  let tcx=tc.x+Math.floor(tc.w/2), tcy=tc.y+Math.floor(tc.h/2);
  for(let c of cands){
    if(!canPlace('FARM',c.x,c.y,ai.team))continue;
    if(aiWouldBlockGate(c.x,c.y,F,F,ai.team))continue;
    if(!pathReaches(tcx,tcy,c.x,c.y,tc.id))continue;
    return {x:c.x,y:c.y};
  }
  return null;
}

// Current attack-wave size: tracks the ECONOMY, not a launch counter. AoE2
// difficulty doesn't script an attack timeline — it throttles the eco, and an
// attack is simply whatever army that eco can mass. So wave size is a fraction
// of the villager count past a small base (armyPerVil beyond armyEcoFloor),
// floored at attackSize and capped by waveCap. Waves still escalate over a
// match — but only because villagers grow toward maxVils, then plateau — and
// Easy stays gentle because its eco is capped low, NOT because a timer holds
// back. (Previously: attackSize + waveCount*waveGrowth, a synthetic per-wave
// ramp that overwhelmed Easy regardless of how stunted its economy was.)
function aiWaveSize(ai,profile){
  let vils=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='villager').length;
  let ecoArmy=Math.floor(Math.max(0,vils-(profile.armyEcoFloor||0))*(profile.armyPerVil||0.5));
  return Math.max(profile.attackSize, Math.min(profile.waveCap||60, ecoArmy));
}

const AI_MIL_TYPES=['militia','spearman','archer','scout','knight'];
// Sum of allied (not own) military power within `range` of `center` — a
// teammate's army standing right there counts toward "can we hold/win".
function nearbyAlliedPower(ai,center,range){
  let p=0;
  entities.forEach(en=>{
    if(en.type!=='unit'||en.team===ai.team||!sameSide(ai.team,en.team))return;
    if(!AI_MIL_TYPES.includes(en.utype))return;
    if(dist(en,center)<=range)p+=unitPower(en.utype);
  });
  return p;
}

// A directed siege holds under fire (AoE2): a ram (which can only usefully hit
// structures) or any unit given an explicit order to attack an enemy BUILDING
// keeps that order — the base-threat response below must not yank it off to
// chase a raider or retreat it. The escorting army handles defenders instead.
function holdsSiegeOrder(m){
  if(m.utype==='ram')return true;
  if(m.explicitAttack&&m.target){
    let t=entitiesById.get(m.target);
    if(t&&t.type==='building'&&!sameSide(t.team,m.team))return true;
  }
  return false;
}

function controlAIMilitary(ai,mils,aiTC,profile){
  let threat=findPlayerThreatNear(ai,aiTC,12*aiScale());
  // Ignore a threat our base is sealed against. A raider poking our ring from
  // OUTSIDE can't be reached, so chasing it freezes the garrison at the wall (the
  // stuck-watchdog spam). Reject ONLY on a DEFINITIVE no-route: findPath returns
  // [] only after fully exploring the reachable region without a path — a truly
  // sealed-out foe. A partial path (iteration-capped) means far-but-reachable —
  // e.g. a raid on the ALLY's town across the map (findPlayerThreatNear includes
  // ally buildings) — and MUST still draw a response, so we don't reject it. The
  // earlier "endpoint must land on the threat" test wrongly dropped those.
  if(threat){
    let tcx=aiTC.x+Math.floor(aiTC.w/2), tcy=aiTC.y+Math.floor(aiTC.h/2);
    if(findPath(tcx,tcy,Math.round(threat.x),Math.round(threat.y),aiTC.id).length===0) threat=null;
  }
  if(threat){
    let localEnemyPower=estimateLocalPlayerPower(ai,threat,10*aiScale());
    let localAllyPower=mils.reduce((s,m)=>s+unitPower(m.utype),0)
      +nearbyAlliedPower(ai,threat,10*aiScale());
    // Badly outmatched defending at home: pull back to the TC instead of
    // feeding units one at a time into a fight that's already lost — a real
    // opponent disengages rather than dying in place for no gain.
    if(localAllyPower>0&&localEnemyPower>localAllyPower*1.6){
      let tcx=aiTC.x+Math.floor(aiTC.w/2), tcy=aiTC.y+Math.floor(aiTC.h/2);
      mils.forEach(m=>{
        if(holdsSiegeOrder(m))return; // a directed siege persists — don't retreat it
        // Already home: stand and fight (auto-attack acquires targets for
        // idle units). Re-clearing targets here every decision tick used to
        // pin the whole army in a retreat loop — shot at, never shooting
        // back — whenever the enemy camped above the power threshold.
        if(dist(m,{x:tcx,y:tcy})<=6*aiScale())return;
        if(!m.target&&m.path.length>0)return; // already retreating — don't re-path
        m.target=null;
        // Perimeter, not the TC's own occupied footprint tile.
        let pt=nearestBldgPerimeter(m.x,m.y,aiTC,m.id);
        pathUnitTo(m,pt?pt.x:tcx,pt?pt.y:tcy);
      });
      return;
    }
    mils.forEach(m=>{
      if(m.utype==='scout')return; // scouts are recon — controlAIScouts owns them, don't pull into defense
      if(holdsSiegeOrder(m))return; // rams / directed sieges don't chase raiders
      // Don't re-send a unit to chase a raider it just proved it can't reach
      // (e.g. one poking the wall from outside our sealed ring) — that's the
      // wedge loop where the whole garrison freezes on an unreachable foe.
      if(m.unreachUntil>tick&&m.unreachId===threat.id)return;
      if(!m.target||dist(m,threat)<10*aiScale()){
        m.target=threat.id;
        clearUnitPath(m); // stop current movement so they engage immediately
      }
    });
    return;
  }
  // Coordinated pushes: an allied AI that just launched (lastWaveGlobalTick,
  // global tick — per-AI decision ticks aren't comparable) lowers our commit
  // bar and halves the cooldown so waves cluster into joint attacks.
  let requiredFactor=profile.attackAdvantage;
  let cooldown=profile.waveCooldown;
  if((profile.allyJoinWindow||0)>0&&AI_STATES){
    for(let u=0;u<NUM_TEAMS;u++){
      if(u===ai.team||!sameSide(ai.team,u))continue;
      let st=AI_STATES[u];
      if(st&&st.lastWaveGlobalTick!=null&&tick-st.lastWaveGlobalTick<profile.allyJoinWindow){
        requiredFactor*=profile.allyJoinFactor;
        cooldown=Math.floor(cooldown/2);
        break;
      }
    }
  }
  // Post-age power surge (AoE2-style): right after advancing, the army just
  // gained +1 atk/+1 armor — press the spike with a lower commit bar and a
  // shortened cooldown for profile.ageSurgeWindow ticks.
  if((profile.ageSurgeWindow||0)>0&&ai.lastAgeUpTick!=null&&tick-ai.lastAgeUpTick<profile.ageSurgeWindow){
    requiredFactor*=profile.ageSurgeFactor;
    cooldown=Math.floor(cooldown/2);
  }
  // Mid-march re-tasking: a kill clears the unit's target AND its
  // explicitAttack flag (updateUnit), so wave survivors used to idle at
  // the first corpse mid-map while the town they were sent to raze stood
  // untouched — the TC out-repaired the trickle of waves that DID land.
  // Every decision tick, any target-less soldier far from home is pointed
  // at the next objective, independent of the wave cooldown.
  {
    let tcC0={x:aiTC.x+aiTC.w/2,y:aiTC.y+aiTC.h/2};
    // FIXED 22-tile radius, not scaled: hard's aiScale(2) stretched the
    // "near home" exemption to 36 tiles — mid-map camps of targetless wave
    // survivors sat just inside it and never got re-pointed at the enemy.
    // The forward rally posture parks ~16 tiles out at most, so 22 keeps
    // home defenders exempt while catching every stalled march.
    let strays=mils.filter(m=>!m.target&&m.utype!=='scout'&&dist(m,tcC0)>22);
    if(strays.length){
      let spotted=aiVisibleEnemies(ai,15*aiScale(),e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');
      strays.forEach(m=>{
        let t=chooseAIAttackTarget(ai,m,spotted);
        if(t){m.target=t.id;m.explicitAttack=true;clearUnitPath(m);}
      });
    }
  }
  let holding=false;
  let waveSize=aiWaveSize(ai,profile);
  // Scouts are recon, not wave fodder — controlAIScouts owns them (same
  // exemption the stray-retask and rally paths already apply). Committing the
  // lone explorer to the attack mob was the exact thing the scout rework fixed.
  let available=mils.filter(m=>!m.target&&m.utype!=='scout');
  if(mils.length<waveSize||ai.tick<profile.attackTick)holding=true;
  // Minimum spacing between waves: after committing an attack, regroup and
  // rebuild before the next (larger) one instead of dribbling units out.
  else if(ai.tick-(ai.lastWaveTick??-1e9)<cooldown)holding=true;
  else {
    let intel=ai.intel;
    if(intel&&intel.strength>0){
      // Don't commit to a march intel says we'd lose — but compare against
      // the CHOSEN TARGET's team, not the sum of every enemy army (which in
      // a team game meant no single AI ever cleared the bar), and credit
      // half of any allied army massed near our own base.
      let availablePower=available.reduce((s,m)=>s+unitPower(m.utype),0);
      let sbt=intel.strengthByTeam||{};
      let targetTeam=(intel.tcSeen&&intel.tcTeam!=null)?intel.tcTeam:null;
      if(targetTeam==null||sbt[targetTeam]==null){
        for(let u=0;u<NUM_TEAMS;u++){
          if(!isEnemyOf(ai.team,{team:u})||sbt[u]==null)continue;
          if(targetTeam==null||sbt[u]<(sbt[targetTeam]??Infinity))targetTeam=u;
        }
      }
      let targetStrength=targetTeam!=null&&sbt[targetTeam]!=null?sbt[targetTeam]:intel.strength;
      let tcC={x:aiTC.x+aiTC.w/2,y:aiTC.y+aiTC.h/2};
      let allyPower=nearbyAlliedPower(ai,tcC,20*aiScale());
      if(availablePower+allyPower*0.5<targetStrength*requiredFactor)holding=true;
    }
  }
  // Stalemate valve: the holds above (grow to escalated wave size, clear
  // the intel strength bar) exist to shape attacks, NOT to freeze the
  // match. The escalated waveSize can exceed what a pop-capped economy can
  // ever field (6+4×17 waves = 74 troops vs a ~50-army ceiling), which
  // used to deadlock EVERY AI into rallying at its own gate forever. If no
  // wave has launched for 3 full cooldowns and there's a minimally viable
  // force, push with what we have — a real AoE2 AI eventually attacks even
  // outmatched.
  if(holding && ai.tick>profile.attackTick &&
     mils.length>=Math.max(profile.attackSize,8) &&
     ai.tick-(ai.lastWaveTick??0)>cooldown*3){
    holding=false;
  }
  if(holding){
    rallyIdleMilitary(ai,mils,aiTC); // forward defensive posture between waves
    return;
  }

  let attackers=available.slice(0,Math.max(waveSize,mils.length-profile.armyReserve));
  let launched=0;
  // March in formation pace: the wave moves at its slowest member's speed
  // (unitMoveSpeed, js/logic.js) — scouts arriving 20s before the spearmen
  // just fed the enemy TC free kills.
  let waveSpeed=attackers.length>1?Math.min(...attackers.map(m=>m.speed||1)):undefined;
  let waveSpotted=aiVisibleEnemies(ai,15*aiScale(),e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');
  attackers.forEach(m=>{
    let target=chooseAIAttackTarget(ai,m,waveSpotted);
    // explicitAttack: this is a deliberate march on remembered intel — the
    // per-tick vision check in updateUnit() must not wipe the order just
    // because the destination is beyond current AI sight range.
    if(target){m.target=target.id;m.explicitAttack=true;m.groupSpeed=waveSpeed;clearUnitPath(m);launched++;}
  });
  if(launched>0){
    ai.waveCount=(ai.waveCount||0)+1;
    ai.lastWaveTick=ai.tick;
    ai.lastWaveGlobalTick=tick; // global-tick stamp for allied coordination
    ai.lastWaveSize=launched; // telemetry only (sim samples it) — NOT in the determinism hash
  }
}

// Idle army posture between waves: hold a forward point (the gate, stepped
// toward the enemy; else a spot ahead of the TC) instead of loitering on
// the TC where a raid reaches the eco before the army reacts.
function rallyIdleMilitary(ai,mils,aiTC){
  let dir=getEnemyDirection(ai,aiTC);
  let rx,ry;
  if(ai.gateBuilt&&ai.gateTile){
    rx=Math.round(ai.gateTile.x+dir.dx*2);
    ry=Math.round(ai.gateTile.y+dir.dy*2);
  } else {
    rx=Math.round(aiTC.x+Math.floor(aiTC.w/2)+dir.dx*4*aiScale());
    ry=Math.round(aiTC.y+Math.floor(aiTC.h/2)+dir.dy*4*aiScale());
  }
  rx=Math.max(1,Math.min(MAP-2,rx));ry=Math.max(1,Math.min(MAP-2,ry));
  for(let back=0;back<3&&!walkable(rx,ry);back++){rx=Math.round(rx-dir.dx);ry=Math.round(ry-dir.dy);}
  if(!walkable(rx,ry))return;
  mils.forEach(m=>{
    if(m.utype==='scout')return; // controlAIScouts owns scouts
    if(m.target||m.path.length>0)return;
    if(dist(m,{x:rx,y:ry})<=4)return;
    pathUnitTo(m,rx,ry);
  });
}

// Scouts were previously just folded into the attack mob in controlAIMilitary
// and otherwise sat idle near the TC. Send any scout that isn't currently
// fighting/attacking or already travelling off to a fresh random point on the
// map, so they actually explore (and the player sees them roaming) instead of
// clumping at home until the army is big enough to march out together.
// Keep an explorer alive. Every team starts with one free scout, but it dies
// early (wildlife, a stray enemy) and was NEVER replaced — so the AI ran blind
// for the rest of the game: the enemy TC was only "found" via the late safety
// net in updateAIIntel (attackTick*2), map control was ceded, and incoming
// attacks arrived unseen. Once the scout is unlocked (Feudal — no Dark-Age
// cavalry, AoE2-accurate) and a barracks is up, keep exactly one scout roaming
// for exploration AND ongoing vision, retraining a lost one just as a human
// keeps re-scouting. A retrain cooldown stops a scout that keeps dying at the
// enemy's doorstep from churning food on a still-fragile economy.
const AI_SCOUT_RETRAIN_COOLDOWN=2400;
function ensureAIScout(ai,readyBarracks){
  if(!isUnlocked(ai.team,'scout'))return;      // Dark Age: no replacement possible, AoE2-accurate
  if(!readyBarracks.length)return;
  let scouts=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='scout'&&e.hp>0).length;
  let queued=readyBarracks.reduce((s,b)=>s+b.queue.filter(q=>q==='scout').length,0);
  if(scouts+queued>=1)return;                   // one explorer is enough
  if(tick-(ai.lastScoutTrainTick??-1e9)<AI_SCOUT_RETRAIN_COOLDOWN)return; // don't churn food re-feeding scouts to a raider
  if(!canAfford(ai.team,UNITS.scout.cost))return;
  queueUnit(readyBarracks[0],'scout');
  ai.lastScoutTrainTick=tick;
}

function controlAIScouts(ai,mils,aiTC){
  let scouts=mils.filter(m=>m.utype==='scout');
  scouts.forEach(s=>{
    if(s.target){
      // A scout is recon, not siege. If it auto-acquired a BUILDING — the
      // classic death is wandering next to the enemy TC while exploring and
      // trading blows with it until the defenders finish it off — drop that
      // target and get back to exploring. A real unit target (home defense,
      // a raider) is left alone.
      let tgt=entitiesById.get(s.target);
      if(tgt&&tgt.type==='building'){ s.target=null; s.explicitAttack=false; clearUnitPath(s); }
      else return; // legitimately engaging a unit — leave it
    }
    if(s.path&&s.path.length>0)return; // still travelling to its last waypoint
    // First, a lap around home: survey the base perimeter (the resource band /
    // where the wall ring will go) before ranging out, like a human checking
    // what's around the TC. Once the lap is done, switch to far exploration.
    let pt = ai.baseSurveyed ? randomScoutWaypoint(ai,aiTC)
                             : (baseSurveyWaypoint(ai,aiTC) || randomScoutWaypoint(ai,aiTC));
    if(pt)pathUnitTo(s,pt.x,pt.y);
  });
}

// Perimeter-survey waypoints: 8 compass points at ~the wall-ring radius around
// the TC, walked in sequence at game start so the scout reveals the immediate
// resources and the ground the wall will enclose before wandering off. Returns
// null (and flips ai.baseSurveyed) once the lap is complete. Deterministic:
// sequential index on AI_STATES, no RNG.
function baseSurveyWaypoint(ai,aiTC){
  const dirs=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  let i=ai.surveyIdx||0;
  if(i>=dirs.length){ ai.baseSurveyed=true; return null; }
  ai.surveyIdx=i+1;
  let prof=aiProfileFor(ai.team);
  let R=Math.round(Math.max(6,(prof.wallRadius||6))*aiScale())+2; // just outside the ring band
  let cx=aiTC.x+Math.floor(aiTC.w/2), cy=aiTC.y+Math.floor(aiTC.h/2);
  let [dx,dy]=dirs[i];
  return { x:Math.max(1,Math.min(MAP-2,cx+dx*R)), y:Math.max(1,Math.min(MAP-2,cy+dy*R)) };
}

// Exploration-biased waypoints: of 8 random candidates, prefer the one with
// the most UNexplored tiles around it (sampled on a stride from the sim's
// deterministic explored grid) plus a small far-from-home bonus — random
// wandering re-visited known ground and could take ages to find a cornered
// enemy on larger maps. Deterministic: sim RNG + sim state only.
//
// Team-parameterized so the HUMAN player's Auto Scout (js/logic.js) reuses the
// exact same frontier logic: `team` selects the explored grid, `homePt` is the
// optional far-from-home anchor (a TC, or null).
function pickExploreWaypoint(team, homePt){
  let margin=3;
  let eg=teamExploredGrid&&teamExploredGrid[team];
  let best=null,bestScore=-1;
  for(let attempt=0;attempt<8;attempt++){
    let x=simRandInt(margin,MAP-1-margin);
    let y=simRandInt(margin,MAP-1-margin);
    if(!map[y]||!map[y][x]||map[y][x].t===TERRAIN.WATER)continue;
    let score=0;
    if(eg){
      for(let dy=-3;dy<=3;dy+=3)for(let dx=-3;dx<=3;dx+=3){
        let nx=x+dx,ny=y+dy;
        if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&eg[ny*MAP+nx]===0)score++;
      }
    }
    if(homePt)score+=dist({x,y},homePt)/MAP; // <1: only breaks near-ties toward far ground
    if(score>bestScore){bestScore=score;best={x,y};}
  }
  return best;
}
function randomScoutWaypoint(ai,aiTC){ return pickExploreWaypoint(ai.team, aiTC); }

function findPlayerThreatNear(ai,aiTC,range){
  // Allied buildings count too: in 2v2 the AI's army answers a raid on its
  // ally's town, not just its own (villager garrison panic stays own-team).
  let aiBuildings = entities.filter(e=>sameSide(e.team,ai.team)&&e.type==='building'&&e.complete);
  let playerUnits = entities.filter(e=>isEnemyOf(ai.team,e)&&e.type==='unit'&&e.utype!=='sheep');
  
  let closestThreat = null;
  let minDist = 9999;
  
  playerUnits.forEach(pu => {
    aiBuildings.forEach(ab => {
      let d = dist({x: ab.x + ab.w/2, y: ab.y + ab.h/2}, pu);
      if (d <= range && d < minDist) {
        minDist = d;
        closestThreat = pu;
      }
    });
  });
  
  return closestThreat;
}

// Can this militia actually reach (i.e. path adjacent to) the given target?
// Priority-based target selection doesn't know about walls in the way, so
// this is used to catch a walled-off pick before committing to it.
// Ticks for `unit` to walk to `target` building's perimeter (0 = already
// adjacent), or -1 if no path exists. Iteration-capped searches return a
// partial path, so very long detours can be underestimated — fine for the
// detour-vs-breach heuristic this feeds.
function ticksToReachBuilding(unit, target){
  if (adjToBuilding(unit.x, unit.y, target)) return 0;
  let pt = nearestBldgPerimeter(unit.x, unit.y, target, unit.id);
  let path = findPath(unit.x, unit.y, pt.x, pt.y, unit.id);
  if (path.length === 0) return -1;
  // findPath REDIRECTS unwalkable destinations up to 20 tiles — a path
  // that doesn't actually END at the perimeter is a path to nowhere
  // (see pathReaches, js/logic.js).
  let last = path[path.length - 1];
  if (Math.abs(last.x - pt.x) > 1.5 || Math.abs(last.y - pt.y) > 1.5) return -1;
  return path.length / ((UNITS[unit.utype].speed || 1) / 30);
}

function isTargetReachable(unit, target){
  if (target.type !== 'building') return true;
  return ticksToReachBuilding(unit, target) >= 0;
}

// Expected ticks for THIS unit to smash through a wall-like building —
// mirrors damageEntity's math exactly (building-class bonuses, pierce vs
// melee armor, the max(1,...) damage floor) so the estimate matches what
// combat will actually do. Uses CURRENT hp, so an already-damaged segment
// scores better than a fresh one and the army converges on one breach
// point instead of spreading damage along the ring (AoE2 clumping).
function wallBreachTicks(unit, w){
  let dmg = unit.atk || 0;
  if (unit.utype === 'villager') dmg += 3;
  if (unit.utype === 'militia') dmg += 2;
  if (unit.utype === 'ram') dmg += 110; // mirrors damageEntity's building bonus
  let armor = BLDGS[w.btype].armor || {m:0,p:0};
  dmg = Math.max(1, dmg - (((unit.range || 0) > 0) ? armor.p : armor.m));
  return Math.ceil(w.hp / dmg) * (UNITS[unit.utype].rof || 60);
}

// Cheapest-to-breach enemy wall/tower/gate that this militia can actually
// path to. Candidates are scored by breach time + march time, which is
// what makes the AI material-aware like AoE2's: a militia (6 dmg/hit vs
// palisade) happily eats a 250hp palisade but a stone wall (1 dmg/hit,
// ~900 hits) loses to a soft segment even a fair march away.
function nearestReachableWallLike(unit, team, excludeId){
  // sameSide, not ===: in 2v2 the blocking wall is often the ALLY's (human
  // and ally AI share a base area) — matching only the target's own team
  // left the attacking army stuck outside an allied wall with no target.
  // Probe only the NEAREST few candidates: isTargetReachable runs a full
  // findPath, and trying every wall on the map for every blocked unit in a
  // marching army was a pathfinding storm that froze war-time ticks. If
  // none of the closest 6 is reachable, the rest of the ring won't be
  // either (it's one connected fortification).
  // March time in ticks: speed is tiles per game-second, 30 ticks/sec.
  let marchTicks = w => dist(unit, w) / ((UNITS[unit.utype].speed || 1) / 30);
  return entities.filter(en => en.type === 'building' && sameSide(en.team, team) && en.hp > 0 &&
      (isWallBtype(en.btype) || en.btype === 'TOWER' || isGateBtype(en.btype)))
    .sort((a, b) => dist(unit, a) - dist(unit, b))
    .slice(0, 6)
    .map(w => ({ w, score: wallBreachTicks(unit, w) + marchTicks(w) }))
    .sort((a, b) => a.score - b.score)
    .map(s => s.w)
    // Skip the segment we just stalled on (excludeId) and any wall we recently
    // gave up on (unreach memory) so a crowded breach point spreads the overflow
    // to a neighbouring segment instead of re-picking the same un-slottable one.
    .find(w => w.id!==excludeId && !(unit.unreachId===w.id && unit.unreachUntil>tick) && isTargetReachable(unit, w)) || null;
}

// If the chosen target is walled off and unreachable, attack the cheapest
// reachable wall/tower/gate instead of marching toward something the unit
// can never actually get adjacent to (which would otherwise leave it stuck
// re-picking the same unreachable building forever, since target selection
// is priority-based and doesn't account for reachability).
//
// AoE2 detour-vs-breach: even when a path EXISTS, a wall ring with one far
// gate can force a march several times the straight-line distance. If the
// detour is that skewed, compare walking it against smashing the cheapest
// breach point and take whichever is faster — militia cut through a
// palisade rather than circle the map, but nobody starts chewing stone
// when an open gate is merely on the far side.
function resolveReachableAttackTarget(militia, candidate){
  if (!candidate) return null;
  if (candidate.type !== 'building') return candidate; // units move — don't probe
  let detour = ticksToReachBuilding(militia, candidate);
  if (detour === 0) return candidate; // already adjacent
  // Straight-line ticks at this unit's speed, for judging how skewed the
  // walk is. Only consider breaching on a big skew (detour > 2x direct +
  // 10 tiles) — nearestReachableWallLike probes up to 6 findPaths, too
  // expensive to run for every ordinarily-reachable target.
  let directTicks = dist(militia, candidate) / ((UNITS[militia.utype].speed || 1) / 30);
  let tileTicks = 30 / (UNITS[militia.utype].speed || 1);
  if (detour >= 0 && detour <= detourBreachThreshold(directTicks, tileTicks)) return candidate;
  let breach = nearestReachableWallLike(militia, candidate.team);
  if (detour < 0) return breach || null; // fully walled off — must breach
  if (breach && wallBreachTicks(militia, breach) + ticksToReachBuilding(militia, breach) < detour) return breach;
  return candidate;
}

function detourBreachThreshold(directTicks, tileTicks){
  return directTicks * 2 + tileTicks * 10;
}

function chooseAIAttackTarget(ai,militia,spotted){
  // No global vision: only player entities "spotted" within sight range of
  // ANY AI unit/building are targetable (there is no dedicated team-1 fog
  // grid — proximity to AI entities stands in for it, same as aiIntel).
  // `spotted` may be passed in prebuilt: a wave launch calls this for
  // EVERY attacker, and the spotted set is attacker-independent — building
  // it 40x per wave was the other O(n^2) hotspot.
  let visionRange=15*aiScale();
  let spottedEnemies=spotted||aiVisibleEnemies(ai,visionRange,
    e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');

  // Fallback to searching nearby player town centers if no units are spotted,
  // but only head to their coordinate range (simulating exploration).
  // Fight the army in your face before sieging buildings (marching past a
  // defending force into the TC invites getting surrounded), then the TC,
  // then military infrastructure, then the rest; distant units last.
  let engage=12*aiScale();
  let priority=e=>{
    // Rams ignore units entirely (1-2 dmg) — they exist to crack
    // structures; the escorting soldiers handle the defenders.
    if(e.type==='unit')return militia.utype==='ram'?6:(dist(militia,e)<=engage?0:4);
    if(e.btype==='TC')return 1;
    if(e.btype==='TOWER'||e.btype==='BARRACKS')return 2;
    return 3;
  };
  // Rams attack STRUCTURES only — 2 damage vs a unit is a wasted swing. Filter
  // the candidate set so a ram never picks a soldier/villager just because no
  // building happens to be in sight; instead it falls through to marching on
  // the enemy TC to find a wall. The escorting soldiers handle the defenders
  // (AoE2 siege doctrine: rams on the wall, army protecting them).
  let cands = militia.utype==='ram' ? spottedEnemies.filter(e=>e.type==='building') : spottedEnemies;
  if (cands.length > 0) {
    let best = cands.sort((a,b)=>priority(a)-priority(b)||dist(militia,a)-dist(militia,b))[0];
    return resolveReachableAttackTarget(militia, best);
  }
  if (ai.intel && ai.intel.tcSeen) {
    // Only head for an enemy TC if a scout/unit has actually seen one at
    // some point this game — otherwise the AI would be marching on knowledge
    // it has no in-fiction way of having.
    let enemyTC = entities.filter(e => isEnemyOf(ai.team, e) && e.btype === 'TC')
      .sort((a, b) => dist(militia, a) - dist(militia, b))[0];
    if (enemyTC && dist(militia, enemyTC) > visionRange) {
      return resolveReachableAttackTarget(militia, enemyTC); // Patrol/march towards the known enemy TC
    }
  }
  return null;
}

function hasAIBuilding(ai,type){
  return entities.some(e=>e.type==='building'&&e.team===ai.team&&e.btype===type);
}

function placeAIBuilding(ai,type,x,y){
  let b=BLDGS[type];
  let gw = b.w, gh = b.h;
  let ox = x, oy = y;
  if (type === 'GATE') {
    let isWall = (tx, ty) => !!entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === ai.team);
    ({ ox, oy, gw, gh } = gateFootprint(x, y, isWall));
  }
  let wallsToRemove = [];
  for (let dy = 0; dy < gh; dy++) {
    for (let dx = 0; dx < gw; dx++) {
      let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && en.btype === 'WALL' && en.team === ai.team);
      if (w) wallsToRemove.push(w);
    }
  }
  let actualCost = {...b.cost};
  if (type === 'GATE') {
    actualCost.w = Math.max(0, (actualCost.w || 0) - wallsToRemove.length * (BLDGS.WALL.cost.w || 0));
  } else if (type === 'TOWER') {
    let existing = entities.find(en => en.type === 'building' && en.x === x && en.y === y && en.btype === 'WALL' && en.team === ai.team);
    if (existing) {
      actualCost.w = Math.max(0, (actualCost.w || 0) - (BLDGS.WALL.cost.w || 0));
      wallsToRemove.push(existing);
    }
  }
  if(!canPlace(type,x,y,ai.team)||!canAfford(ai.team,actualCost))return null;
  spendCost(ai.team,actualCost);
  if (wallsToRemove.length > 0) {
    let ids = new Set(wallsToRemove.map(w => w.id));
    entities = entities.filter(en => !ids.has(en.id));
    ids.forEach(id => entitiesById.delete(id));
  }
  let building=createBuilding(type,ox,oy,ai.team,gw,gh);
  building.complete=false;
  building.buildProgress=0;
  building.hp=1; // AoE2: foundations start at ~no HP and gain it as construction progresses
  if (wallsToRemove.length > 0) {
    building.wasWall = true;
  }
  return building;
}

// Food drop-offs (the TC and every Mill) each reserve a farm belt around them
// so plots can ring the drop point and farmers have the shortest walk. Other
// buildings must stay out of these belts. Overlapping belts (a Mill near the
// TC) simply union into one shared farm block — exactly what we want.
function aiFarmBeltDrops(team){
  let drops=[];
  for(let i=0;i<entities.length;i++){
    let e=entities[i];
    if(e.type!=='building'||e.team!==team)continue;
    if(e.btype==='TC'||e.btype==='MILL')
      drops.push({cx:e.x+e.w/2, cy:e.y+e.h/2, r:Math.ceil(e.w/2)+2*BLDGS.FARM.w});
  }
  return drops;
}
function aiInFarmBelt(bx,by,bw,bh,team,drops){
  drops=drops||aiFarmBeltDrops(team);
  let ccx=bx+bw/2, ccy=by+bh/2;
  for(let d of drops){ if(Math.hypot(ccx-d.cx,ccy-d.cy)<d.r)return true; }
  return false;
}

// A building must not sit in a gate's passage corridor — the centre doorway
// tile plus a couple of tiles straight out each side along the travel axis.
// Dropping a house/barracks there seals the choke the gate exists to open
// (the reported "building in front of the gate blocks the path"). Flanking
// wall tiles are NOT in the corridor, so towers can still guard the gate.
function aiWouldBlockGate(bx,by,bw,bh,team){
  for(let i=0;i<entities.length;i++){
    let g=entities[i];
    if(g.type!=='building'||!isGateBtype(g.btype)||!sameSide(team,g.team))continue;
    let n=Math.max(g.w,g.h), horiz=g.w>=g.h;      // horiz gate (Nx1): travel is N-S
    let ccx=horiz?g.x+Math.floor(n/2):g.x;         // gate centre (doorway) tile
    let ccy=horiz?g.y:g.y+Math.floor(n/2);
    for(let s=-2;s<=2;s++){
      let px=ccx+(horiz?0:s), py=ccy+(horiz?s:0);
      if(px>=bx&&px<bx+bw&&py>=by&&py<by+bh)return true;
    }
  }
  return false;
}

function findAIBuildSpot(ai,tc,type){
  let b=BLDGS[type];
  // Measure everything from the TC CENTRE, not its origin corner — with a 4x4
  // TC an origin-based radius made the reserved belt lopsided (deep on two
  // sides, ~nothing on the +x/+y sides), so houses crowded the TC and ate
  // farm slots. tcHalf is the TC's own half-extent.
  let tcHalf=Math.ceil(tc.w/2);
  let cx=tc.x+tc.w/2, cy=tc.y+tc.h/2;
  // Roomier core for the larger TC/Barracks. The MARKET is placed late (post-
  // Feudal), by when the walled core is usually full — give it a much larger
  // radius so it can sit at the base edge/outside (fine: it's an economy
  // building and trade carts leave the base anyway), instead of failing to
  // place and never trading.
  let maxR=Math.round((type==='MARKET'?28:14)*aiScale());
  let minEdge=tcHalf+1;              // scan starts just outside the TC
  // AoE2-style placement: houses/barracks must stay out of the FARM BELT
  // around every food drop-off (TC AND each Mill) — that ring is reserved for
  // farms so farmers have the shortest walk. Belts around a Mill near the TC
  // merge into one shared block. Barracks additionally prefers the
  // enemy-facing side (the army rallies toward the front, not inside the eco).
  let reserve=(type==='HOUSE'||type==='BARRACKS');
  let drops=reserve?aiFarmBeltDrops(ai.team):null;
  let angles=[...Array(16).keys()];
  if(type==='BARRACKS'){
    let ed=getEnemyDirection(ai,tc);
    let dot=a=>simCos(a*Math.PI*2/16)*ed.dx+simSin(a*Math.PI*2/16)*ed.dy;
    angles.sort((a1,a2)=>dot(a2)-dot(a1));
  }
  let scan=(respectBelt)=>{
    for(let r=minEdge;r<maxR;r++){
      for(let a of angles){
        let ang=a*Math.PI*2/16;
        let tx=Math.round(cx+simCos(ang)*r);
        let ty=Math.round(cy+simSin(ang)*r);
        if(!canPlace(type,tx,ty,ai.team))continue;
        if(aiWouldBlockGate(tx,ty,b.w,b.h,ai.team))continue;
        if(respectBelt&&reserve&&aiInFarmBelt(tx,ty,b.w,b.h,ai.team,drops))continue;
        if(pathReaches(Math.floor(cx),Math.floor(cy),tx,ty,tc.id))return{x:tx,y:ty};
      }
    }
    return null;
  };
  // Respect the farm belts first; if the base is too cramped to place anything
  // outside them, squeeze in rather than build NOTHING — a barracks that never
  // lands means zero military forever, and farming itself gates on it.
  return scan(true) || (reserve?scan(false):null);
}

function findAIDropSite(ai,terrain,type,tc,avoidFarmBelt=false,existingDrops=null,coverR=0){
  let maxDist=22*aiScale();
  let b=BLDGS[type];
  let beltDrops=avoidFarmBelt?aiFarmBeltDrops(ai.team):null;
  // A patch already within coverR of an existing drop-off (the TC or a prior
  // camp of this resource) is served — building another camp there is wasted.
  // Skipping covered patches means the FIRST camp only goes up when the wood/
  // gold is genuinely far from the TC, and LATER camps go to fresh far patches
  // as near ones deplete (AoE2: a new lumber camp at each new forest, instead
  // of one camp forever and villagers trekking 20 tiles to the next treeline).
  let coveredBy=(x,y)=>existingDrops&&existingDrops.some(d=>{
    let ex=Math.max(d.x-x,0,x-(d.x+d.w-1)), ey=Math.max(d.y-y,0,y-(d.y+d.h-1));
    return Math.hypot(ex,ey)<coverR;
  });
  let candidates=[];
  for(let y=1;y<MAP-1;y++)for(let x=1;x<MAP-1;x++){
    if(map[y][x].t!==terrain||map[y][x].res<=0)continue;
    if(dist({x,y},{x:tc.x+Math.floor(tc.w/2),y:tc.y+Math.floor(tc.h/2)})>maxDist)continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      let bx=x+dx,by=y+dy;
      if(!canPlace(type,bx,by,ai.team))continue;
      if(coveredBy(bx,by))continue; // an existing drop already serves this patch
      let nearby=countResourceTilesNear(terrain,bx,by,4);
      // NEAREST ADEQUATE patch, AoE2-style: density only has to clear a
      // workability floor (>=8 tiles feeds several gatherers through the
      // camp's payback), then DISTANCE decides. The old open-ended
      // `dist - nearby*1.5` bonus let a dense forest at max range (~80
      // tiles in the 9x9 count) crush every near patch — camps were
      // founded 20+ tiles from town with commuters dying en route.
      // Sub-floor patches keep the density-weighted score as a fallback
      // ranking, but any adequate patch always outranks them (-1000 bias).
      let d=dist({x:bx,y:by},{x:tc.x+Math.floor(tc.w/2),y:tc.y+Math.floor(tc.h/2)});
      let s=nearby>=8?d-1000:d-nearby*1.5;
      candidates.push({x:bx,y:by,s});
    }
  }
  // canPlace only checks the footprint terrain itself, not whether a villager
  // can actually walk to it — the score above favors spots deep inside a
  // resource patch (more "nearby" tiles = better score), which easily picks
  // a grass pocket fully boxed in by forest/water on every side. Rank by
  // score first, then accept the best-ranked candidate that's actually
  // reachable from the TC (pathfinding is too costly to run on every one).
  candidates.sort((a,b)=>a.s-b.s || a.x-b.x || a.y-b.y); // positional tie-break: don't depend on Array.sort stability for a sim decision
  let tcx=tc.x+Math.floor(tc.w/2), tcy=tc.y+Math.floor(tc.h/2);
  for(let i=0;i<candidates.length;i++){
    let c=candidates[i];
    // Keep camps OUT of the reserved farm belt (around the TC AND any Mill) so
    // they don't squat where farms should ring the drop-off — but still build
    // the camp at the resource itself. (Skipping the camp entirely and letting
    // the whole wood line drop at the TC just congests it: units wedge at the
    // one drop point. AoE2 builds the camp at the trees; it just isn't parked
    // next to a food drop-off.) Also never seal a gate's passage.
    if(avoidFarmBelt && aiInFarmBelt(c.x,c.y,b.w,b.h,ai.team,beltDrops))continue;
    if(aiWouldBlockGate(c.x,c.y,b.w,b.h,ai.team))continue;
    if(pathReaches(tcx,tcy,c.x,c.y,tc.id))return{x:c.x,y:c.y};
  }
  return null;
}

function countResourceTilesNear(terrain,cx,cy,r){
  let count=0;
  for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    let x=cx+dx,y=cy+dy;
    if(x>=0&&x<MAP&&y>=0&&y<MAP&&map[y][x].t===terrain&&map[y][x].res>0)count++;
  }
  return count;
}
