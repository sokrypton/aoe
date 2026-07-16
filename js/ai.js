// ---- AI ----
// All AI spatial radii were tuned for the 60-tile 'small' map; scale by MAP
// size so the AI's effective reach grows on medium/large maps.
function aiScale(){return MAP/60;}

// Diagnostics counter — UNHASHED and never read by the sim (checksum-safe;
// same contract as window.__dropStats). tools/sim.html reports the totals
// as health.aiProbe so headless runs can show which AI doctrine paths fired.
function aiProbe(k){let p=window.__aiProbe||(window.__aiProbe={});p[k]=(p[k]||0)+1;}

// ---- AI GARRISON REACTION (town bell equivalent) ----
// Mirrors the player's town bell: villagers shelter in the nearest TC/tower,
// then come out when things quiet down. Runs every tick (not the slow
// decisionInterval) so a short raid can't slip past the decision cadence.
// lastTeamHit[team] (js/core.js, recorded by damageEntity in logic.js) covers
// hits ANYWHERE — including this AI's own offense trading hits — so it can't
// gate the bell directly; only hits near the AI's own TC count as "base under attack".
const AI_GARRISON_HOLD_TICKS = T30(360); // ~12s at 30 ticks/sec: stay hidden briefly after the last hit
const AI_BASE_ALARM_RADIUS = 18; // tiles from TC center (scaled by aiScale) that count as "home"
function updateAIGarrisonReaction(ai){
  if(!gameStarted||gameOver)return;
  // New hit since we last looked: classify it as base-hit or field-hit.
  let hit = lastTeamHit && lastTeamHit[ai.team];
  // Only a CORE hit (villager or TC actually damaged) triggers the bell —
  // reacting to perimeter-wall pokes garrisoned the economy for entire sieges
  // the walls were holding (the eco-stall bug).
  if(hit && hit.core && hit.tick!==ai.seenWarTick){
    ai.seenWarTick=hit.tick;
    let tc=teamTC(ai.team);
    if(tc){
      let wdx=hit.x-(tc.x+tc.w/2), wdy=hit.y-(tc.y+tc.h/2);
      let d=Math.sqrt(wdx*wdx+wdy*wdy);
      if(d<=AI_BASE_ALARM_RADIUS*aiScale()) ai.lastBaseHitTick=hit.tick;
    }
  }
  // ?? not || : the tick can legitimately be 0 (a hit landed on tick 0),
  // and 0 is falsy — || would wrongly discard it and treat that as "never".
  let underAttack = tick - (ai.lastBaseHitTick ?? -1e9) < AI_GARRISON_HOLD_TICKS;
  // A live civilian-militia response suppresses the bell: ringing now would
  // yank the fighters into shelter mid-swing and oscillate fight/hide.
  if(underAttack && ai.militiaUntil>tick){
    // ESCALATION re-check (~1s cadence, tick-derived so lockstep-safe): if a
    // real army arrived since the window was sized, cancel it and fall
    // through to the bell.
    if(tick%AI_ESCALATE_EVERY===0){
      let tc=teamTC(ai.team);
      let threat=tc&&findEnemyThreatNear(ai,tc,AI_BASE_ALARM_RADIUS*aiScale());
      if(threat&&estimateLocalEnemyPower(ai,threat,10*aiScale())>AI_MILITIA_MAX_THREAT)ai.militiaUntil=0;
    }
    if(ai.militiaUntil>tick) return;
  }
  // ringTownBell/soundAllClear maintain bellRinging[ai.team] themselves.
  if(underAttack && !window.bellRinging[ai.team]){
    // Fight-or-hide, decided at the exact moment the bell would ring (so the
    // two responses can never race). A raid that OUTLIVED its militia window
    // escalates to the bell — a perpetual militia re-arm suppressed the bell
    // for the rest of the game.
    if(tick-(ai.militiaUntil??-1e9)>AI_GARRISON_HOLD_TICKS && tryAIMilitiaResponse(ai)){aiProbe('militia:t'+ai.team);return;}
    aiProbe('bell:t'+ai.team);
    ringTownBell(ai.team);
  } else if(!underAttack && window.bellRinging[ai.team]){
    // All-clear needs the raiders GONE, not merely a pause in hits — campers
    // waited out the hold window and villagers walked out to die (self-play
    // finding). Same visible-threat test as the soldier shelter recall, with
    // the same reachability null-out (a poker sealed OUTSIDE intact walls
    // must not hold the economy in shelter forever).
    let tc=teamTC(ai.team);
    let lurking=tc&&findEnemyThreatNear(ai,tc,12*aiScale());
    if(lurking){
      let {x:tcx,y:tcy}=centerTile(tc);
      if(findPath(tcx,tcy,Math.round(lurking.x),Math.round(lurking.y),tc.id).length===0)lurking=null;
    }
    if(!lurking){
      aiProbe('allClear:t'+ai.team);
      soundAllClear(ai.team);
    }
  }
}

// ---- CIVILIAN MILITIA (AoE2 sn-number-civilian-militia [10]) ----
// When core damage is landing but the raid is SMALL and the army can't
// answer, up to profile.civilianMilitia villagers mob the raider instead of
// the whole workforce hiding from one scout. Returns true if dispatched (the
// caller then skips the bell); the militia-recall pass in updateAI releases
// the mob once the raider dies or flees the town radius.
function tryAIMilitiaResponse(ai){
  let profile=aiProfileFor(ai.team);
  let cap=profile.civilianMilitia||0;
  if(cap<=0)return false;
  let aiTC=teamTC(ai.team);
  if(!aiTC)return false;
  let threat=findEnemyThreatNear(ai,aiTC,AI_BASE_ALARM_RADIUS*aiScale());
  if(!threat)return false;
  let raidPower=estimateLocalEnemyPower(ai,threat,10*aiScale());
  if(raidPower>AI_MILITIA_MAX_THREAT)return false; // a real attack — hide, don't mob
  // The army handles it if it has comparable local strength — then the bell
  // still rings to tuck the villagers away while the soldiers fight.
  let armyPower=0;
  for(let e of entities){
    if(e.team!==ai.team||e.type!=='unit'||e.utype==='scout'||!isArmyUnit(e.utype))continue;
    if(dist(e,threat)<=12*aiScale())armyPower+=unitPower(e.utype);
  }
  if(armyPower>=raidPower*0.5)return false;
  let fighters=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='villager'
    &&!e.garrisonedIn&&e.task!=='garrison');
  let committed=fighters.filter(v=>v.target===threat.id).length;
  let vcands=fighters.filter(v=>v.target!==threat.id);
  vcands.sort((a,b)=>dist(a,threat)-dist(b,threat)||a.id-b.id);
  let sent=0;
  for(let v of vcands.slice(0,Math.max(0,cap-committed))){
    // Same save/restore contract as retaliation (stashVillagerTask,
    // js/logic.js): the villager resumes its task once the raider is dead.
    stashVillagerTask(v);
    clearGatherTarget(v);
    assignAttack(v,threat); // shared attack semantics; savedTask still resumes after
    sent++;
  }
  if(committed+sent===0)return false;
  ai.militiaUntil=tick+AI_MILITIA_WINDOW;
  return true;
}

function updateAI(ai){
  ai.tick++;
  let profile=aiProfileFor(ai.team);
  if(ai.tick%profile.decisionInterval!==0)return;

  let aiBuildings=entities.filter(e=>e.type==='building'&&e.team===ai.team);
  let aiUnits=entities.filter(e=>e.type==='unit'&&e.team===ai.team);
  let aiTC=aiBuildings.find(b=>b.btype==='TC');
  if(!aiTC){
    // TC destroyed = the knockout (handleDeath flags it; no rebuilding).
    // Remaining units keep gathering/fighting only until checkAllianceVictory
    // ends the match.
    let vils=aiUnits.filter(u=>u.utype==='villager');
    let mils=aiUnits.filter(u=>isArmyUnit(u.utype)&&!u.garrisonedIn);
    let anchor=aiBuildings[0]||(aiUnits[0]?{x:Math.round(aiUnits[0].x),y:Math.round(aiUnits[0].y),w:1,h:1}:null);
    assignAIVillagers(ai,vils,profile);
    if(anchor)controlAIMilitary(ai,mils,anchor,profile);
    controlAIScouts(ai,mils,null);
    return;
  }

  updateAIIntel(ai,aiTC,profile); // what has scouting/combat actually revealed about the player this tick
  if(maybeResignAI(ai,aiUnits))return; // AoE2-style concession — nothing left to plan

  let vils=aiUnits.filter(u=>u.utype==='villager');
  // !garrisonedIn: a rider sealed inside a ram cannot act — enterGarrison
  // clears its task/target, so it would otherwise pass every dispatch filter
  // and absorb defense quotas / wave slots while physically unable to fight.
  let mils=aiUnits.filter(u=>isArmyUnit(u.utype)&&!u.garrisonedIn);
  let barracks=aiBuildings.filter(b=>b.btype==='BARRACKS');

  // Field flee is event-driven: damageEntity (js/logic.js) stamps a danger
  // zone and runs a field-hit villager home at the moment of the hit.
  let alarmR=AI_BASE_ALARM_RADIUS*aiScale();
  let tcCenter=centerOf(aiTC);
  // Militia recall: a raider beyond the town radius isn't worth chasing —
  // release the fighters back to work (savedTask restores in updateUnit).
  // Villagers only ever carry explicitAttack from tryAIMilitiaResponse, so
  // this pass can't cancel anything else.
  vils.forEach(v=>{
    if(!v.explicitAttack||!v.target)return;
    let t=entitiesById.get(v.target);
    if(!t||t.hp<=0||dist(t,tcCenter)>alarmR){
      v.target=null;v.explicitAttack=false;clearUnitPath(v);
    }
  });
  let readyBarracks=barracks.filter(b=>b.complete);

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
// A hopeless team (collapsed workforce, no army, under fire, can't recover)
// concedes after three consecutive hopeless decision ticks instead of forcing
// the winner to raze a ghost town. Deterministic sim state (resignScore rides
// AI_STATES); the message broadcasts to every viewer.
function maybeResignAI(ai,aiUnits){
  if(defeatedTeams[ai.team])return true;
  let vils=0,mils=0;
  for(let u of aiUnits){if(u.utype==='villager')vils++;else if(isArmyUnit(u.utype))mils++;}
  let hit=lastTeamHit&&lastTeamHit[ai.team];
  let hopeless=vils<4&&mils===0&&hit&&tick-hit.tick<T30(1800)&&
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
// replacement gatherers forever. Up to 3 idle non-scout military engage;
// bears are gaia so auto-attack never acquires them — this explicit order is
// the only military-vs-wildlife path.
function huntAIBears(ai,mils){
  let vil=entities.find(e=>e.team===ai.team&&e.utype==='villager'&&e.fledBearId!=null);
  if(!vil)return;
  let bear=entitiesById.get(vil.fledBearId);
  if(!bear||bear.hp<=0||bear.utype!=='bear'){vil.fledBearId=undefined;return;}
  let sent=entities.filter(m=>m.team===ai.team&&m.type==='unit'&&m.target===bear.id).length;
  // Prefer non-scout military (the scout is fragile recon), but in the Dark
  // Age the scout is often the ONLY military and eco outranks vision — two
  // passes: fighters first, scouts only if nothing else answered.
  // Retreating units sit the hunt out: re-sending a mauled hunter is the
  // fight-to-the-death ping-pong the retreat exists to break.
  let candidates=mils.filter(m=>!m.target&&!isRetreatingUnit(m)&&m.task!=='garrison');
  let ordered=[...candidates.filter(m=>m.utype!=='scout'),...candidates.filter(m=>m.utype==='scout')];
  for(let m of ordered){
    if(sent>=3)break;
    if(m.utype==='scout'&&sent>0)break; // a fighter already went — spare the scout
    assignAttack(m,bear);
    sent++;
  }
  if(sent>0)vil.fledBearId=undefined; // hunt dispatched — don't re-trigger every decision
}

// ---- TRAPPED-VILLAGER RESCUE ----
// A wall segment can seal a worker into a pocket; a real player deletes the
// wall, so does the AI. findPath is too dear to sweep every villager, so test
// ONE per decision tick, rotating deterministically. Trapped = can't path to
// its own TC; the rescue breaches the nearest OWN wall reachable from inside
// the pocket (nothing reachable → no-op, so a villager off raiding enemy
// lands can't trigger deletions).
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
    // Hold this tile OPEN for a while — instant wall-maintenance rebuild
    // re-seals the worker and oscillates (delete → rebuild → re-trap).
    let pt=ai.wallPlan&&ai.wallPlan.find(t=>t.x===w.x&&t.y===w.y);
    if(pt){pt.done=true;pt.rescueOpenUntil=tick+T30(3000);}
  }
}

// ---- AI INTEL ----
// What the AI actually "knows" about the player, built from the team's REAL
// vision — the same deterministic per-team sight grid a human's screen is
// drawn from (teamCanSeeTile / entityVisibleToTeam, js/core.js); never
// omniscient reads of the entities list. Scouting (controlAIScouts) is what
// feeds this. TC sighting is sticky, like a human's memory of it.
function aiVisibleEnemies(ai,pred){
  // THE intel choke point (counter-picking, wave targeting, strength
  // estimates). entityVisibleToTeam short-circuits on fogDisabled itself; the
  // grids are UNMAINTAINED under All-Visible, so a bare grid read here would
  // be blind — the inverse bug.
  // !garrisonedIn: a unit inside a building is not on the map — the bell must
  // WORK as the raid counter (sheltered villagers vanish from the spotted
  // set; the wave falls through to the TC siege), and it's parity-correct:
  // you can't count what's inside a building. estimateLocalEnemyPower
  // deliberately does NOT flow through here — a garrisoned archer's arrows
  // still count toward defense sizing.
  return entities.filter(e=>isEnemyOf(ai.team,e)&&e.hp>0&&!e.garrisonedIn&&pred(e)&&entityVisibleToTeam(e,ai.team));
}
function getSpottedEnemies(ai){
  return aiVisibleEnemies(ai,e=>e.utype!=='sheep');
}

function unitPower(utype){
  let u=UNITS[utype];
  if(!u)return 1;
  return u.hp+u.atk*5;
}

function updateAIIntel(ai,aiTC,profile){
  let intel=ai.intel||(ai.intel=freshAIIntel()); // shape lives in js/core.js (hashed sim state)
  // GHOST-CLEARING (re-sight validation): TC memory is sticky, but when the
  // remembered footprint is currently VISIBLE and no enemy TC stands there,
  // the memory is a ghost — drop it, exactly what a human concludes looking
  // at empty ground. Under All-Visible teamCanSeeTile is always true, so this
  // degenerates to live truth — correct for that mode.
  if(intel.tcSeen){
    let tcW=BLDGS.TC.w, tcH=BLDGS.TC.h, seen=false;
    for(let dy=0;dy<tcH&&!seen;dy++)for(let dx=0;dx<tcW;dx++){
      let tx=intel.tcX+dx, ty=intel.tcY+dy;
      if(tx>=0&&tx<MAP&&ty>=0&&ty<MAP&&teamCanSeeTile(ai.team,ty*MAP+tx)){seen=true;break;}
    }
    if(seen&&!entities.some(e=>e.type==='building'&&e.btype==='TC'&&e.hp>0
        &&e.team===intel.tcTeam&&e.x===intel.tcX&&e.y===intel.tcY)){
      intel.tcSeen=false;intel.tcTeam=null;
    }
  }
  let unitCounts={};
  let observed=new Array(NUM_TEAMS).fill(0);
  let spotted=getSpottedEnemies(ai);
  spotted.forEach(e=>{
    if(e.type==='unit'){
      unitCounts[e.utype]=(unitCounts[e.utype]||0)+1;
      observed[e.team]+=unitPower(e.utype);
    } else if(e.type==='building'&&e.btype==='TC'){
      // Sticky TC memory (last-seen-wins; single remembered TC is a v1 limitation).
      intel.tcSeen=true;
      intel.tcX=e.x;intel.tcY=e.y;intel.tcTeam=e.team;
    }
  });
  // CONTACT MEMORY: remember the nearest spotted enemy to home (sticky).
  // Walls/rally/wave direction point at where the enemy was actually
  // ENCOUNTERED until a TC is found. Deterministic pick: min distance, id tiebreak.
  if(aiTC&&spotted.length){
    let tcC=centerOf(aiTC),best=null,bd=Infinity;
    spotted.forEach(e=>{let d=dist(e,tcC);if(d<bd||(d===bd&&(!best||e.id<best.id))){bd=d;best=e;}});
    intel.contactX=Math.round(best.x);intel.contactY=Math.round(best.y);intel.contactTick=tick;
  }
  // DECAYING STRENGTH MEMORY: dense per-team ints in fixed slot order
  // (never key-iterate — determinism). Snaps UP to what is observed on
  // contact and fades ~6% per decision tick, so a scouted army must be
  // re-scouted after a few game-minutes. Pure integer math (engine-portable);
  // hashed in the AI digest (js/determinism.js). Glimpsing PART of an army
  // does not erase memory of the whole — Math.max, not assignment. A team
  // never contacted stays at 0 ("no known defenses"), so the wave-commit bar
  // doesn't hold the army home against an unknown (the AoE2 default).
  let mem=intel.strengthByTeam,strength=0;
  for(let u=0;u<NUM_TEAMS;u++){
    mem[u]=Math.max(observed[u]|0,Math.floor((mem[u]|0)*15/16));
    if(isEnemyOf(ai.team,{team:u}))strength+=mem[u];
  }
  intel.strength=strength; // Σ remembered enemy power — the wave-commit bar reads this
  // DERIVED (counter-picking): rebuilt here before any consumer runs each
  // decision tick, never carried across ticks — deliberately unhashed; if
  // it ever becomes carried state it must join the AI digest.
  intel.unitCounts=unitCounts;
}

function estimateLocalEnemyPower(ai,center,radius){
  // entityVisibleToTeam: only enemies the team can actually SEE count
  // (information parity). A fogged half of a raid is genuinely
  // underestimated, exactly like a human eyeballing the visible attackers.
  return entities.filter(e=>isEnemyOf(ai.team,e)&&e.type==='unit'&&e.hp>0&&e.utype!=='sheep'
      &&dist(e,center)<=radius&&entityVisibleToTeam(e,ai.team))
    .reduce((s,e)=>s+unitPower(e.utype),0);
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
  // NEXT AGE's villager benchmark is met (eco-first, AoE2) — the matching
  // military-side gate (queueAIMilitary) pauses militia spending over the
  // same window, so the reserve can't starve villager growth.
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

const AI_DROP_COVER=10;  // a drop-off "covers" resource within this radius:
                         // only build a camp for resources FARTHER than this
const AI_MAX_LCAMP=3, AI_MAX_MCAMP=2;
function planAIDropSites(ai,aiTC,vils,profile){
  if(!profile.dropSites||vils.length<5)return;
  let hasBarracks=hasAIBuilding(ai,'BARRACKS');
  // Wood camps: one at the nearest forest NOT already covered by the TC or an
  // existing camp, up to a cap — short walks to a wood drop. Camps stay OUT
  // of any food drop-off's farm belt.
  let lcamps=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='LCAMP');
  if(lcamps.length<AI_MAX_LCAMP&&canAfford(ai.team,BLDGS.LCAMP.cost)){
    let woodDrops=[aiTC,...lcamps];
    let pos=findAIDropSite(ai,TERRAIN.FOREST,'LCAMP',aiTC,true,woodDrops,AI_DROP_COVER);
    if(pos)placeAIBuilding(ai,'LCAMP',pos.x,pos.y);
  }
  // Bank resources for the upcoming barracks — but only while we can't yet
  // afford it. Holding once the cost is covered (placement failing on a
  // cramped map) would deadlock the whole eco chain: no mill, no mining camp,
  // and planAIFarming also gates on the barracks.
  if(!hasBarracks&&vils.length>=profile.barracksVil-1&&!canAfford(ai.team,BLDGS.BARRACKS.cost))return;
  if(vils.length>=6&&hasBarracks&&!hasAIBuilding(ai,'MILL')&&canAfford(ai.team,BLDGS.MILL.cost)){
    let pos=findAIDropSite(ai,TERRAIN.BERRIES,'MILL',aiTC);
    if(pos)placeAIBuilding(ai,'MILL',pos.x,pos.y);
  }
  // Mining camps serve BOTH gold and stone: one at a far gold deposit AND one
  // at a far stone deposit (each only if beyond AI_DROP_COVER of the TC / an
  // existing camp).
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
  let maxTowers=profile.maxTowers||0;
  if(vils.length<8||maxTowers<=0)return;
  // Combined bastion cap: stone Watch Towers AND wooden PTOWERs both count, so
  // a PTOWER that later upgrades to a Tower still occupies its one slot.
  let bastions=entities.filter(e=>e.type==='building'&&e.team===ai.team&&isTowerBtype(e.btype)).length;
  if(bastions>=maxTowers)return;
  // Prefer a stone Watch Tower once Feudal + stone allow it; otherwise the
  // wooden PTOWER (dark-age bastion, wood-only), which the wall stone-upgrade
  // pass later promotes (WALL_STONE_MATCH: PTOWER→TOWER).
  // Barracks fund outranks bastions (aiBarracksFundClear).
  let type=null;
  if(isUnlocked(ai.team,'TOWER')&&canAfford(ai.team,BLDGS.TOWER.cost)&&aiBarracksFundClear(ai,BLDGS.TOWER.cost.w||0))type='TOWER';
  else if(canAfford(ai.team,BLDGS.PTOWER.cost)&&aiBarracksFundClear(ai,BLDGS.PTOWER.cost.w||0))type='PTOWER';
  if(!type)return;
  // A waller's bastion MUST go on the wall (gate flank → corners → resource
  // side); wait for a wall segment rather than eating the cap on a
  // freestanding tower. Only a non-walling AI falls back to a freestanding spot.
  let pos=findAIWallDefenseSpot(ai);
  if(!pos&&!profile.walls)pos=findAIBuildSpot(ai,aiTC,type);
  if(pos)placeAIBuilding(ai,type,pos.x,pos.y);
}

// ---- AI DEFENSIVE WALLS ----
// Builds a square wall ring around the AI town center, closed with gates so
// the AI's own villagers/army can still path out. The ring plan is computed
// once and cached; repeated calls resume the next unfinished tile.
function planAIWalls(ai,aiTC,vils,profile){
  if(!profile.walls||vils.length<profile.wallVils)return;
  // Barracks before walls (AoE2 build order): the ring's wood sink kept the
  // bank permanently under the barracks price — defense that can't train a
  // single spearman defends nothing.
  if(!hasAIBuilding(ai,'BARRACKS'))return;
  // Economy before fortifications: walling in Dark/Feudal drained the wood
  // farms needed and stalled the age climb (self-play finding). Hold the ring
  // until maxAge is reached; reactive defenses (planAITowers /
  // findAIWallDefenseSpot) still run independently.
  if((teamAge[ai.team]||0) < (profile.maxAge||2))return;
  // Survey before fortifying: the ring is planned on tiles the team has
  // actually SEEN. The scout's base-survey lap (controlAIScouts) walks the
  // ring band — without this gate, canPlace's explored check
  // (tileHiddenForTeam) would reject unexplored ring segments forever.
  if(!ai.baseSurveyed)return;
  if(!ai.wallPlan)ai.wallPlan=computeAIWallRing(ai,aiTC,profile.wallRadius*aiScale());
  let plan=ai.wallPlan;

  // GATE-FIRST construction: the reserved gate-pair tiles (computeAIWallRing)
  // are built before anything else and the GATE dropped as soon as both are
  // walls — a gate can only be placed by consuming adjacent walls, and from
  // that moment the base is NEVER sealed off from its resource camps while
  // the ring closes.
  // UNDER-ATTACK DOCTRINE: walls are PREPARATION, not reaction. In a
  // war-state (aiRecentlyRaided) every wall SPEND path below pauses — wall
  // wood mid-raid buys nothing while the barracks/farms starve. Bookkeeping,
  // egress carving and the self-heal done-flag scan KEEP running.
  let pressured=aiRecentlyRaided(ai);
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
    if(pressured)return;               // spend path — paused under attack
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
  // `sealed` = an enemy genuinely CANNOT flood-reach the TC; egress = our own
  // army genuinely CAN flood-reach outside. Computed once per call, reused below.
  let wr=ai.wallRadiusUsed||Math.round(profile.wallRadius*aiScale());
  let sealed=aiBaseSealed(aiTC,ai.team,wr);
  let rescueActive=plan.some(pt=>pt.rescueOpenUntil&&tick<pt.rescueOpenUntil);

  // Stone upgrade (AoE2: palisade → stone from Feudal on): only once actually
  // sealed and gated. GATES first (the funnel point), paced ≤4/decision, priced
  // exactly with a small stone float so it never outbids towers.
  if(sealed&&ai.gateBuilt&&!pressured&&isUnlocked(ai.team,'SWALL')){
    let pals=entities.filter(en=>en.type==='building'&&en.team===ai.team&&
      (en.btype==='WALL'||en.btype==='GATE'||en.btype==='PTOWER')&&en.complete&&en.hp>0);
    // GATES first (the funnel), then walls, then PTOWER bastions (PTOWER→TOWER
    // via WALL_STONE_MATCH); id tiebreak keeps it deterministic.
    let upOrder=b=>b.btype==='GATE'?0:(b.btype==='PTOWER'?2:1);
    pals.sort((a,b)=>upOrder(a)-upOrder(b)||a.id-b.id);
    let pick=[],stoneCost=0,bank=resourceStore(ai.team).stone;
    for(let en of pals){
      if(pick.length>=4)break;
      let c=BLDGS[WALL_STONE_MATCH[en.btype]].cost.s||0;
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

  // Self-heal: re-queue every plan tile that is a GENUINE open gap, judged
  // from ACTUAL tile state (wallTileSealed) — catches chopped-forest seams
  // and destroyed segments. Keeps the sole-egress opening and rescue holes
  // open, and won't rebuild into a siege.
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

  // Place wall tiles (capped per call). `done` means SEALED — set only when a
  // wall was actually placed, terrain permanently seals the tile, or an
  // unreachable case is proven harmless; never on a silent failure. Failed
  // placements back off and retry.
  let placedThisCall=0, iters=0;
  let {x:wtcx, y:wtcy} = centerTile(aiTC);
  let BACKOFF=Math.max(T30(120),profile.decisionInterval*2);
  while(!pressured&&placedThisCall<8&&iters<40&&canAfford(ai.team,BLDGS.WALL.cost)){
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
        // Through the normal deletion path (the player's Delete key), not
        // direct entities/map surgery — surgery skips death FX and leaves
        // ghost references if the player had the wall selected.
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
// units actually path with — so the check can never disagree with reality.

// Impassable natural terrain (a free wall). NOT the same as "a wall is here".
function terrainBarrier(x,y){
  if(x<0||y<0||x>=MAP||y>=MAP)return true;
  let t=map[y]&&map[y][x]; if(!t)return true;
  return t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES;
}

// A plan tile counts as SEALED only if something impassable-to-an-enemy is
// actually on it NOW: an allied building or barrier terrain — so a
// chopped-forest seam reads as a genuine open gap and gets re-queued.
function wallTileSealed(pt,team){
  if(buildingAtTile(pt.x,pt.y,en=>en.team===team))return true;
  if(terrainBarrier(pt.x,pt.y))return true;
  return false;
}

// Ground truth: can an ENEMY reach the TC from outside RIGHT NOW? Bounded
// flood inward from the box boundary through enemy-passable ground.
// ignoreUnits=true → transient units don't count as walls; 8-connected but NO
// diagonal corner-cutting, matching findPath. A CLOSED gate blocks, but an
// OPEN gate is passable to anyone, so it counts as a hole (walkable(-1) reads
// every gate as closed, so isOpen is tested explicitly). `extraBlock`
// optionally treats one tile as walled. Returns true = SEALED.
function aiBaseSealed(aiTC,team,radius,extraBlock){
  let {x:cx, y:cy} = centerTile(aiTC);
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
// courtyard through OWN-passable ground (walker=aiTC → our gates OPEN, our
// walls block). A ring is healthy when aiBaseSealed && armyCanReachEnemy.
function armyCanReachEnemy(ai,aiTC){
  let {x:cx, y:cy} = centerTile(aiTC);
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
  let {x:cx, y:cy} = centerTile(tc); // build the ring around its center
  let baseR=Math.max(4,Math.round(radius));
  // Economy-radius growth (AoE2 "wall along the treeline"): grow the radius
  // just enough to run the wall OUTSIDE the close resource camps instead of
  // slicing between the TC and them. BOUNDED by GROW_CAP: a farther camp
  // stays outside (gated per-side + towered, see planAITowers) so the wall
  // never balloons into an indefensible perimeter. The grown radius is stored
  // in ai.wallRadiusUsed, and aiBaseSealed floods radius+6 — its seal check
  // widens in lock-step automatically.
  const GROW_CAP=4;
  let r=baseR;
  entities.forEach(c=>{
    if(c.type!=='building'||c.team!==ai.team)return;
    // Only COMPACT resources (gold/stone via MCAMP, berries via MILL) drive
    // growth. NOT lumber camps: a forest always STRADDLES the wall, so
    // enclosing an LCAMP has villagers crossing the wall every trip — the
    // rescue wall-break + self-heal rebuild oscillation. AoE2 walls the base,
    // not forests.
    if(c.btype!=='MCAMP'&&c.btype!=='MILL')return;
    let cheb=Math.max(Math.abs((c.x+0.5)-cx),Math.abs((c.y+0.5)-cy));
    if(cheb>r&&cheb<=baseR+GROW_CAP)r=Math.ceil(cheb+1); // wall runs just beyond this camp
  });
  r=Math.min(r,baseR+GROW_CAP);
  // Remember the geometry so the honest seal-check (aiBaseSealed) bounds its
  // flood to this base (it reads ai.wallRadiusUsed via planAIWalls).
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
  // GEOMETRIC SQUARE ring at Chebyshev radius r — a CONTINUOUS wall outline
  // on grass. Unlike a terrain-following ring it never depends on forest the
  // AI itself chops, so clearing trees can't spring a seam in it. It crosses
  // the resource band cosmetically, but gold/stone are impassable and seal
  // those segments; canPlace skips building ON them.
  // A corner TC: the map edge is already a wall, so a side that would land
  // on/past the border is OMITTED; the perpendicular sides extend to the edge
  // to close the corridor.
  let hasN=cy-r>=1, hasS=cy+r<=MAP-2, hasW=cx-r>=1, hasE=cx+r<=MAP-2;
  let xLo=hasW?cx-r:0, xHi=hasE?cx+r:MAP-1;
  let yLo=hasN?cy-r:0, yHi=hasS?cy+r:MAP-1;
  if(hasN)for(let x=xLo;x<=xHi;x++)addTile(x,cy-r,'N');
  if(hasS)for(let x=xLo;x<=xHi;x++)addTile(x,cy+r,'S');
  if(hasW)for(let y=hasN?yLo+1:yLo;y<=(hasS?yHi-1:yHi);y++)addTile(cx-r,y,'W');
  if(hasE)for(let y=hasN?yLo+1:yLo;y<=(hasS?yHi-1:yHi);y++)addTile(cx+r,y,'E');
  // ---- Reserve TWO gates: one toward the ECONOMY, one toward the ENEMY ----
  // A single gate either seals villagers from their camps (Dark-Age collapse)
  // or forces the army to detour around the ring (pathfinding storm) — so
  // reserve BOTH and split the traffic. planAIWalls builds each pair's tiles
  // FIRST and gates them immediately, so both openings exist from early
  // construction.
  let camps=entities.filter(e=>e.type==='building'&&e.team===ai.team&&(e.btype==='LCAMP'||e.btype==='MCAMP'||e.btype==='MILL'));
  let sideFor=(dx,dy)=>Math.abs(dx)>=Math.abs(dy)?(dx>=0?'E':'W'):(dy>=0?'S':'N');
  let ed=getEnemyDirection(ai,tc);
  let enemySide=sideFor(ed.dx,ed.dy);
  // Eco gates, AoE2-style: a gate on EVERY side that has an active drop camp
  // AT/BEYOND the ring — averaging sides walled one resource's villagers out.
  // Nearest-camp-first so the gate cap keeps the most useful doors; camps
  // already inside the ring need no gate.
  let ecoSideDist={};
  camps.forEach(c=>{
    let dcx=(c.x+0.5)-cx, dcy=(c.y+0.5)-cy;
    if(Math.max(Math.abs(dcx),Math.abs(dcy))<r-0.5)return; // inside the ring already
    let s=sideFor(dcx,dcy), d=Math.abs(dcx)+Math.abs(dcy);
    if(ecoSideDist[s]===undefined||d<ecoSideDist[s])ecoSideDist[s]=d;
  });
  // Deterministic order: nearest camp first, then a fixed side order as tiebreak.
  let ecoSides=Object.keys(ecoSideDist).sort((a,b)=>ecoSideDist[a]-ecoSideDist[b]||(a<b?-1:1));
  // No camps beyond the ring yet (early wall) → put the eco gate away from the
  // enemy, where the base/eco will grow, so egress and commute don't share one door.
  if(!ecoSides.length)ecoSides=[sideFor(-ed.dx,-ed.dy)];
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
    st.sort((a,b)=>axis(a)-axis(b)||a.x-b.x||a.y-b.y); // deterministic tiebreak (never lean on sort stability)
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
  // Enemy gate (army egress) first, then one per eco side — distinct, capped so
  // the wall doesn't become Swiss cheese (each gate is a 3-tile breach point).
  const MAX_GATES=3;
  let wantSides=[];
  for(let s of [enemySide,...ecoSides])if(!wantSides.includes(s))wantSides.push(s);
  wantSides=wantSides.slice(0,MAX_GATES);
  for(let s of wantSides){ let g=reserveGate(s); if(g)ai.gatePairs.push(g); }
  // If none of the wanted sides had a walkable run, fall back to any side.
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
  } else if(intel&&intel.contactTick>=0){
    // No TC found yet but the enemy HAS been met: point at the remembered
    // nearest-contact spot (updateAIIntel) — where trouble actually came from.
    ex=intel.contactX;ey=intel.contactY;
  } else {
    // No contact at all: neutral prior — the map center (reading start
    // positions would be an information cheat). Pre-contact walls/gates may
    // face the wrong way; that corrects itself on first contact.
    ex=MAP>>1;ey=MAP>>1;
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

// Decides where (if anywhere) to place the gate. Ranks the four sides by
// usefulness (resource access + attack/defense route); an existing walkable
// opening on the best side satisfies the need, otherwise pick a buildable
// pair of real walls there (midpoint preferred), else the next-best side.
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
  // NO ring-complete gate: place a bastion on each priority wall tile the
  // moment it EXISTS as a finished wall — a 100%-sealed-ring precondition
  // often never holds in a real game. hasTowerAt counts BOTH stone Towers and
  // wooden PTOWER bastions so we never double-stack a spot.
  let hasTowerAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&isTowerBtype(en.btype)&&en.x===x&&en.y===y);
  let isWallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===ai.team&&isWallBtype(en.btype)&&en.x===x&&en.y===y);

  // Priority 1: the gate flank — the one soft breach point in a solid wall.
  let gateTile=ai.gateTile;
  if(gateTile){
    let flanks=[{x:gateTile.x+1,y:gateTile.y},{x:gateTile.x-1,y:gateTile.y},{x:gateTile.x,y:gateTile.y+1},{x:gateTile.x,y:gateTile.y-1}];
    let flank=flanks.find(f=>isWallAt(f.x,f.y)&&!hasTowerAt(f.x,f.y));
    if(flank)return flank;
  }

  // Priority 2: the four ring corners (natural sightline/ambush points).
  let xs=plan.map(t=>t.x),ys=plan.map(t=>t.y);
  let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  let corners=[{x:minX,y:minY},{x:maxX,y:minY},{x:minX,y:maxY},{x:maxX,y:maxY}];
  let corner=corners.find(c=>isWallAt(c.x,c.y)&&!hasTowerAt(c.x,c.y));
  if(corner)return corner;

  // Priority 3 (AoE2 "tower the resource"): a wall tile on a side that has an
  // exposed eco camp — cover the gathering line the enemy would raid. Reuse the
  // ring's per-tile `side` tag and the cached ring geometry.
  let cx=ai.wallCx, cy=ai.wallCy, r=ai.wallRadiusUsed;
  if(cx!=null&&r){
    let sideFor=(dx,dy)=>Math.abs(dx)>=Math.abs(dy)?(dx>=0?'E':'W'):(dy>=0?'S':'N');
    let ecoSides=new Set();
    entities.forEach(c=>{
      if(c.type!=='building'||c.team!==ai.team)return;
      if(c.btype!=='LCAMP'&&c.btype!=='MCAMP'&&c.btype!=='MILL')return;
      let dcx=(c.x+0.5)-cx, dcy=(c.y+0.5)-cy;
      if(Math.max(Math.abs(dcx),Math.abs(dcy))>=r-0.5)ecoSides.add(sideFor(dcx,dcy));
    });
    if(ecoSides.size){
      let ecoTiles=plan.filter(t=>ecoSides.has(t.side)&&isWallAt(t.x,t.y)&&!hasTowerAt(t.x,t.y));
      ecoTiles.sort((a,b)=>a.x-b.x||a.y-b.y); // deterministic pick
      if(ecoTiles.length)return{x:ecoTiles[0].x,y:ecoTiles[0].y};
    }
  }
  return null;
}

// "Real" pressure = a CORE hit (a villager or the TC actually taking damage)
// in the last 900 ticks — NOT an enemy merely poking the wall ring. Decides
// whether survival outranks advancement. Gating on any hit let a besieger
// outside intact walls keep the AI permanently in "emergency" mode and stall
// the age-up. Same core-hit basis as the bell.
function aiUnderRealPressure(ai){
  let h=lastTeamHit&&lastTeamHit[ai.team];
  return !!(h&&h.core&&tick-h.tick<T30(900));
}

// WAR-STATE (persistent): a base core hit within the last ~2 game-minutes.
// aiUnderRealPressure's short window answers "survival RIGHT NOW"; raids
// PULSE though, and gating wall spends on it let construction restart in
// every quiet gap between pulses, draining the exact wood the under-attack
// doctrine protects (seed-1001 death spiral). Fortification and the +3 chop
// diversion wait for real peace.
function aiRecentlyRaided(ai){
  return aiUnderRealPressure(ai)||tick-(ai.lastBaseHitTick??-1e9)<T30(3600);
}

// Army faucet first: while the team has NO barracks (never built, or razed),
// discretionary wood spends (towers, market, NEW farm plots) yield until the
// rebuild fund is intact ON TOP of the spend — a razed sole barracks
// otherwise stops ALL military production forever. This is a GATE on each
// spender, not a reservation (reservation webs starve other systems). Bank
// reseeds of STANDING farms stay ungated — standing farms are the food
// income the doctrine protects.
function aiBarracksFundClear(ai,woodCost){
  return hasAIBuilding(ai,'BARRACKS')||
    resourceStore(ai.team).wood>=(woodCost||0)+BLDGS.BARRACKS.cost.w;
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
// Nearest COMPLETED ally Market — the AI's trade-cart destination.
// Deterministic: entities in array order, first-found tie-break (like
// nearestMarket, js/logic.js).
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

// Build ONE Market, OPPORTUNISTICALLY: only when fully developed (max age),
// defended (standing army), and the spare wood simply exists. Deliberately NO
// wood "reservation" pausing other systems to force the purchase — that
// crippled tight-economy AIs into never attacking.
// ONE exception (need-based): a starved economy must be able to convert
// banked wealth (self-play finding — the market is the one building that
// turns dead gold back into food income). Fires only when the wood exists
// ANYWAY, so it starves nothing.
function planAIMarket(ai,aiTC,vils,profile){
  if(!isUnlocked(ai.team,'MARKET'))return;               // Feudal-gated
  if(aiOwnMarket(ai.team))return;                         // one is enough
  let r=resourceStore(ai.team);
  // Need-based build fires on EITHER a floor breach with gold to convert
  // (MARKET_FLOOR — the same table the exchange trades toward) OR simply
  // being at war (aiRecentlyRaided): a raided AI wants the exchange as
  // economic insurance BEFORE it is starving. Every safety gate stays.
  let starving=(r.food<MARKET_FLOOR.food||r.wood<MARKET_FLOOR.wood)&&r.gold>=300;
  let emergency=(starving||aiRecentlyRaided(ai))
    &&canAfford(ai.team,BLDGS.MARKET.cost)&&aiBarracksFundClear(ai,BLDGS.MARKET.cost.w);
  if(!emergency){
    if(teamAge[ai.team] < (profile.maxAge||2))return;    // finished teching first
    if(vils.length<profile.marketVil)return;
    let army=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&isArmyUnit(e.utype)).length;
    if(army<(profile.armyReserve||4))return;             // defense before trade
    if(!canAfford(ai.team,BLDGS.MARKET.cost))return;     // only when the surplus is genuinely there
    if(!aiBarracksFundClear(ai,BLDGS.MARKET.cost.w))return; // army faucet first
  }
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

// THE market model — two tables and one rule.
// FLOORS (the minimal sn-minimum-<res> analog, AoE2 §9): below these the
// economy is STARVING — fix the worst breach every decision tick. Fixed
// priority food > wood > gold: food starves both the army and villager
// production first.
// SURPLUS: above these a resource is safe to SELL — stone first (no other
// sink for a non-waller). Static config — no hash.
const MARKET_FLOOR={food:100,wood:80,gold:150};
const MARKET_SURPLUS={stone:200,wood:500,food:400};
const AI_EMERGENCY_GOLD_CUSHION=100; // floor buys spend down to here (vs the 300 comfort cushion)

// Commodity exchange (all difficulties, 1v1 + team). ONE deficit-driven
// rule, at most one 100-lot per decision tick (the shared global price table
// self-limits repeated conversion): worst floor breach → BUY it with gold;
// can't afford (or gold IS the breach) → SELL the first surplus in
// stone→wood→food order; no breach → comfort top-up of wood when rich.
// No oscillation by construction: a floor can never overlap its own surplus,
// stone is never bought, a resource is never sold to fix its own breach, and
// each trade moves its resource away from the trigger. Wealth locked in the
// wrong commodity converts toward whatever is starving in at most two hops.
function planAIMarketExchange(ai,profile){
  let mkt=aiOwnMarket(ai.team);
  if(!mkt||!mkt.complete)return;
  let r=resourceStore(ai.team);
  let prices=marketPricesFor(ai.team);
  let need=['food','wood','gold'].find(k=>r[k]<MARKET_FLOOR[k])||null;
  if(need&&need!=='gold'&&r.gold-prices[need]>=AI_EMERGENCY_GOLD_CUSHION){
    execMarketTrade({dir:'buy',resType:need},ai.team);   // fix the breach directly
  } else if(need){
    // Gold-poor (or gold IS the breach): liquidate the first surplus.
    let sell=['stone','wood','food'].find(k=>k!==need&&r[k]>MARKET_SURPLUS[k]);
    if(sell)execMarketTrade({dir:'sell',resType:sell},ai.team);
  } else if(r.gold>300){
    // Comfort top-up: keep the build economy liquid when genuinely rich.
    // (Food needs no comfort branch — its floor buy above always fires
    // first at these gold levels.)
    if(r.wood<120&&r.gold-prices.wood>=300)execMarketTrade({dir:'buy',resType:'wood'},ai.team);
  }
}

function queueAIMilitary(ai,readyBarracks,profile){
  // Exclude the recon scout: isArmyUnit counts it, but every attacker path
  // (available/controlAIMilitary/rallyIdleMilitary) excludes it — counting it
  // toward maxArmy here persistently under-trains real fighters by one.
  let currentArmy=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype!=='scout'&&isArmyUnit(e.utype)).length;
  // Train toward the NEXT wave's size (plus home defense reserve) so the
  // army goal escalates with each wave launched, AoE2-style.
  let maxArmy=aiWaveSize(ai,profile)+profile.armyReserve;
  if(currentArmy>=maxArmy)return;
  
  // Under pressure, survival outranks advancement — an AI that keeps
  // hoarding while its army isn't reinforcing dies rich.
  let underPressure=aiUnderRealPressure(ai);
  // Saving for an age: military spending yields — but never below a small
  // standing defense (half the army reserve); a blanket pause left AIs
  // sitting on banked wood with a barracks and ZERO soldiers.
  if(ai.savingForAge&&!underPressure&&currentArmy>=Math.ceil(profile.armyReserve/2))return;
  // Eco-first (AoE2): below the next age's villager benchmark, food belongs
  // to the TC — militia spend otherwise drains food faster than it
  // regenerates and every AI sits in the Dark Age forever. A small standing
  // defense is still allowed, and pressure overrides.
  let next=teamAge[ai.team]+1;
  let ecoTarget=next<AGES.length&&profile.ageUpVils&&profile.ageUpVils[next];
  if(ecoTarget&&!underPressure){
    let vilCount=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.utype==='villager').length;
    if(vilCount<ecoTarget&&currentArmy>=Math.ceil(profile.armyReserve/2))return;
  }
  // Only currently-unlocked rosters — Dark-age barracks train militia only.
  let types = AI_MIL_TYPES.filter(t=>isUnlocked(ai.team,t));
  if(types.length===0)return;
  // Rock-paper-scissors counters, per the unit descriptions in core.js. The
  // scout line is reserved SOLELY for recon (controlAIScouts owns every
  // utype==='scout'), so it is never a military pick. Picked from real
  // scouted intel, not omniscient knowledge of the player's army.
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
    // Saving for a ram and only wood is missing: train the wood-free militia
    // so wood banks toward the ram — self-play showed wood is the chronic
    // constraint, so AIs reached Castle rich in gold yet never fielded a ram.
    // ramWoodReserve (AI_LEVELS) scopes how long the banking lasts: hard for
    // its whole siege train, medium/easy only for the FIRST door-opener ram —
    // an open-ended reserve kept medium mono-militia for all of Castle age.
    {let store=resourceStore(ai.team);
    if(wantRam&&ramCount<(profile.ramWoodReserve||0)&&store.gold>=ramGold&&store.wood<(UNITS.ram.cost.w||0)&&isUnlocked(ai.team,'militia'))return 'militia';}
    // Saving for a ram but gold-short: train the gold-free spearman so gold
    // banks toward the ram instead of dribbling into militia/knights —
    // otherwise attacks bounce off walls forever (the finishing stalemate).
    if(wantRam&&resourceStore(ai.team).gold<ramGold&&isUnlocked(ai.team,'spearman'))return 'spearman';
    let counts=ai.intel&&ai.intel.unitCounts;
    if(counts){
      let dominant=Object.keys(counts).filter(t=>counterMap[t]).sort((a,b)=>counts[b]-counts[a]||(a<b?-1:a>b?1:0))[0]; // lexical tiebreak (Object.keys order isn't a sim contract)
      // Counter-pick most of the time once there's real intel on what the
      // player is fielding — not always, so the matchup isn't perfectly
      // predictable/exploitable by the player switching unit types.
      if(dominant&&simRandom()<0.7&&isUnlocked(ai.team,counterMap[dominant]))return counterMap[dominant];
    }
    return types[simRandInt(0, types.length - 1)];
  };

  // Count queued military across ALL barracks against the cap — a
  // per-barracks check lets multiple barracks overshoot maxArmy by a full
  // queue, double-spending food the villager planner may have reserved.
  let queuedArmy=readyBarracks.reduce((s,b)=>s+b.queue.filter(q=>q!=='scout').length,0); // scout isn't army (see currentArmy)
  // Hoist the population read out of the while-condition: used/cap don't
  // change while we queue, so track queued pop incrementally instead of
  // re-scanning all entities per iteration.
  let popUsedT=teamPopUsed(ai.team), popCapT=teamPopCap(ai.team), popQueuedT=teamQueuedPop(ai.team);
  readyBarracks.forEach(barracks=>{
    while(barracks.queue.length<profile.queueLimit&&popUsedT+popQueuedT<popCapT&&currentArmy+queuedArmy<maxArmy){
      let utype = pickUnitType();
      // Counter-pick first, then cheaper fallbacks if it's unaffordable.
      let placed = queueUnit(barracks,utype).ok ? utype
                 : queueUnit(barracks,'spearman').ok ? 'spearman'
                 : queueUnit(barracks,'militia').ok ? 'militia' : null;
      if(placed){
        queuedArmy++;
        popQueuedT+=unitPop(placed); // keep the hoisted pop count in step with the queue
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
  // Active re-tasking by need: the balancer below only re-picks for an IDLE
  // or STALE villager, so workers locked on a still-productive resource were
  // never moved when priorities flipped (choppers piling wood while food
  // starved). Pull a few workers off any task with clearly MORE hands than
  // aiEcoPlan wants and let assignAIGatherTask re-pick the neediest resource.
  let desired=aiEcoPlan(ai,vils.length,profile);
  let counts=countAIGatherers(vils);
  let rebalanced=0;
  // Construction-labor governor: the wall ring is dozens of segments and with
  // buildersPerBuilding=1 every spare villager grabs a different one — the
  // whole town downs tools to wall while gathering freezes. Cap WALL/GATE
  // work to a third of the workforce; a healthy economy that walls slower
  // beats a frozen one that walls fast then starves. Houses/farms/barracks/TC
  // are uncapped — few, and economically essential.
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
      // isAIGatherTaskStale() doesn't know 'build' as a task type — treating
      // a builder as stale yanks it off mid-construction and oscillates.
      // Only leave the build if its target is actually gone/finished.
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
    // Exhausted farms are NOT building work: auto-reseed pays from the bank
    // (updateBuilding, js/logic.js). Offering them here put every idle
    // villager on a walk-to-farm treadmill that starved the gather assigner.
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
    build.buildBackoffUntil=tick+T30(900);
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

// Nearest huntable herdable (live sheep or standing carcass) this villager
// can actually reach — AoE2's free, finite opening food. Only gaia strays or
// our own flock (never poach an enemy's), within a short leash; a live sheep
// converts to us as the villager closes (js/logic.js). Several villagers can
// ring one carcass, so no per-sheep cap is needed.
const AI_SHEEP_HUNT_RANGE=24;
function nearestAISheep(ai,v){
  let cands=[];
  for(let e of entities){
    if(e.hp<=0)continue;
    if(e.utype!=='sheep'&&e.utype!=='sheep_carcass')continue;
    if(e.team!==GAIA_TEAM&&e.team!==ai.team)continue; // gaia strays or our own flock; never poach an enemy's
    // A stray must be SEEN before it can be claimed (information parity).
    // Own-flock sheep light their own sight disk, so this only gates unseen
    // gaia strays at the leash edge.
    if(!entityVisibleToTeam(e,ai.team))continue;
    let d=Math.abs(e.x-v.x)+Math.abs(e.y-v.y);
    if(d<=AI_SHEEP_HUNT_RANGE)cands.push({e,d});
  }
  cands.sort((a,b)=>a.d-b.d||a.e.id-b.e.id); // deterministic tiebreak
  for(let c of cands)if(pathReaches(v.x,v.y,c.e.x,c.e.y,v.id))return c.e;
  return null;
}

function assignAIGatherTask(ai,v,vils,profile){
  let desired=aiEcoPlan(ai,vils.length,profile);
  let counts=countAIGatherers(vils);
  // What can this villager work for task T right now? Returns a resource TILE
  // {x,y}, or a {sheep} sentinel for forage. findNearTile is a proximity
  // probe only (a tile can be "near" yet walled off), so pathReaches is the
  // real gate. null = unfulfillable; stone with a full stockpile is
  // unfulfillable so a lone miner doesn't mine a useless hoard.
  let targetFor=(task)=>{
    if(task==='mine_stone'&&resourceStore(ai.team).stone>800)return null;
    if(task==='forage'){
      // Wild food, AoE2 order: eat the free, finite SHEEP first, before berry
      // bushes — ignoring starting herdables Dark-Age-locked food-poor starts.
      let sheep=nearestAISheep(ai,v);
      if(sheep)return{sheep};
    }
    let cfg=GATHER_TASKS[task]; if(!cfg)return null;
    let t=findNearTile(v,cfg.terrain,null,null,true); // proximity probe, no claim
    return (t&&pathReaches(v.x,v.y,t.x,t.y,v.id))?t:null;
  };
  // Assign the highest-DEFICIT task (most under-staffed vs the plan) that
  // this villager can actually fulfil. Skipping unfulfillable tasks is the
  // point: dumping every unmeetable demand onto wood banked mountains of wood
  // while gold/food starved — the next REAL need takes the hand instead.
  let ranked=Object.keys(desired)
    .filter(t=>GATHER_TASKS[t])
    .sort((a,b)=>(counts[a]||0)/desired[a]-(counts[b]||0)/desired[b]||(a<b?-1:a>b?1:0)); // lexical tiebreak on task name
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
  // Herdable food: hunt it directly, target-based with NO task, exactly like
  // the player's sheep command (js/commands.js) — the harvest path only runs
  // on `target && !task` (js/logic.js); setting task alongside wedges the
  // villager. countAIGatherers credits a sheep-targeting villager as forage.
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
    if(target&&target.x!=null){
      // PARITY: claim + approach through THE shared helpers the human
      // gather-click uses (claimGatherTileNear fans co-gatherers onto
      // distinct tiles; pickGatherStand rings distinct adjacent stands).
      // The AI's drop-anchored CHOICE above is decision-making; the
      // claiming/standing MECHANICS are now identical to a player's.
      let g=claimGatherTileNear(v, gc.terrain, target.x, target.y);
      v.gatherX=g.x; v.gatherY=g.y;
      let stand=(typeof pickGatherStand==='function')?pickGatherStand(v,g.x,g.y):null;
      if(stand)pathUnitTo(v,stand.x,stand.y);
    }
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
  // below the profile floor. Keyed on the FARMS existing, NOT on owning a
  // Mill: farms drop at the TC too — mill-gated staffing built plots and
  // assigned zero farmers (Dark-Age lock, sim finding).
  let activeFarms=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='FARM'&&e.complete&&!e.exhausted).length;
  if(activeFarms>0){
    base.farm=Math.max(profile.farmShare,activeFarms);
  }
  // A palisade ring is a WOOD sink — pull extra gatherers onto wood until
  // it's finished. NOT while under real attack: wall placement pauses then
  // (planAIWalls under-attack doctrine), so the +3 chop would divert hands
  // from food for wood nothing will spend.
  let wallPlan=ai.wallPlan;
  if(wallPlan&&!wallPlan.every(t=>t.done)&&!aiRecentlyRaided(ai))base.chop=(base.chop||1)+3;
  // Demand rebalancing (AoE2 AIs re-task gatherers by need): a fat stockpile
  // stops attracting hands — fixed ratios chopped forever while the age cost
  // stayed out of reach.
  let store=resourceStore(ai.team);
  if(store.wood>600&&base.chop)base.chop=Math.max(1,Math.floor(base.chop/2));
  if(store.gold>500&&base.mine_gold)base.mine_gold=Math.max(1,Math.floor(base.mine_gold/2));
  if(store.stone>400&&base.mine_stone)delete base.mine_stone;
  // FOOD hoard sheds too: farm share is sticky (one farmer per active farm),
  // so a food-unit army composition banked thousands of food while wood
  // pinned near zero. Halve farm/forage above 600 banked and push the freed
  // hands to wood, the universal constructive sink.
  if(store.food>600){
    if(base.farm)base.farm=Math.max(1,Math.floor(base.farm/2));
    if(base.forage)base.forage=Math.max(1,Math.floor(base.forage/2));
    base.chop=(base.chop||1)+2;
  }
  if(store.food<250){
    if(base.farm)base.farm*=2;
    if(base.forage)base.forage*=2;
  }
  // Saving for the next age: bias gatherers toward the resources that age
  // actually COSTS. Gold always drops at the TC, so pointing more hands at
  // gold accrues the age price even with the gold camp unreachable — this is
  // what unlocks Castle-age units for the AI at all.
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
    // Sheep-hunters carry no gather task (target-based) — credit them as
    // forage so the plan doesn't pile still more hands onto food.
    else if(v.target){ let t=entitiesById.get(v.target); if(t&&(t.utype==='sheep'||t.utype==='sheep_carcass'))counts.forage++; }
    return counts;
  },{forage:0,farm:0,chop:0,mine_gold:0,mine_stone:0});
}

function planAIFarming(ai,aiTC,vils,profile){
  // Do NOT gate on having a Mill: the Mill only ever gets built on a BERRIES
  // patch (planAIDropSites), so a berry-less start would never farm — farms
  // drop at the TC just fine.
  // Start farming once the eco has legs (barracks up), BUT also at 8+
  // villagers without one: Dark-age forage DEPLETES, and waiting stalled
  // villager production (AoE2 lays farms in late Dark age).
  if(!hasAIBuilding(ai,'BARRACKS') && vils.length<8)return;
  if(vils.length<6||!canAfford(ai.team,BLDGS.FARM.cost))return;
  // Don't let NEW farm plots starve the BARRACKS of wood — the shared
  // army-faucet gate (aiBarracksFundClear) covers both pre-barracks and a
  // RAZED barracks. Reseeds of standing farms are untouched (logic.js bank
  // reseed).
  if(!aiBarracksFundClear(ai,BLDGS.FARM.cost.w))return;
  // ACTIVE farms only (exhausted ones auto-reseed and shouldn't block new
  // plots), against a target that grows with the workforce — a fixed 2-4
  // farm cap starved the AI's food economy once the berries ran out.
  let activeFarms=entities.filter(e=>e.type==='building'&&e.team===ai.team&&e.btype==='FARM'&&!e.exhausted).length;
  let targetFarms=aiFarmTarget(ai,vils,profile);
  // Deadlock breaker: farm target scales with villagers, villagers are gated
  // by food, food by farms — a town that lost its forage locked at N farms
  // forever. Idle hands + spare wood = plant more farms.
  let idleV=vils.filter(v=>!v.task&&!v.target&&!v.buildTarget&&v.path.length===0&&!v.garrisonedIn).length;
  if(idleV>1&&resourceStore(ai.team).wood>=200)targetFarms=Math.max(targetFarms,activeFarms+Math.min(idleV,4));
  // Hard ceiling: never more farms than ~3/4 of the workforce can staff —
  // unbounded, the idle-hands rule ratcheted wood into unworked plots; farms
  // only feed you if someone farms them.
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
// (TC or Mill), so lay 2x2 plots in grid-aligned rows flush against those
// buildings, closest slot first, growing outward in aligned rings.
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
  // Keep plots out of the gate corridor (a farmer in the gateway looks
  // wrong), and require the plot be reachable from the TC: an unreachable
  // farm parks as unbuildable work and wedges the assigned villager
  // (stuck-watchdog).
  let {x:tcx, y:tcy} = centerTile(tc);
  for(let c of cands){
    if(!canPlace('FARM',c.x,c.y,ai.team))continue;
    if(aiWouldBlockGate(c.x,c.y,F,F,ai.team))continue;
    if(!pathReaches(tcx,tcy,c.x,c.y,tc.id))continue;
    return {x:c.x,y:c.y};
  }
  return null;
}

// TRAINING target: how big an army this economy should field. Used ONLY as
// the production ceiling (maxArmy in queueAIMilitary). DECOUPLED from the
// LAUNCH threshold — launches are AoE2 army-size-driven (the scaled minGroup
// in launchAIWave); using this eco-scaled number as the launch bar was the
// defensive-death-spiral lock (an army dying at home could never reach it).
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

// ---- TACTICAL RETREAT (AoE2 sn-percent-health-retreat) ----
// A soldier low on HP that is ACTIVELY taking hits breaks off and runs home.
// The "actively being hit" window is the crux: with no field healing, a pure
// HP gate would permanently bench every wounded survivor — gating on recent
// damage means only a unit LOSING a fight right now disengages.
const AI_RETREAT_HP=0.30;        // retreat below 30% HP...
const AI_RETREAT_HIT_WINDOW=T30(90);  // ...while hit within the last ~3s
const AI_RETREAT_TICKS=T30(600);      // ~20s: run home, ignore re-acquire/retaliation
// percent-death-retreat approximation: a wave that has lost ~2/3 of what it
// launched pulls its survivors home to regroup with the next (bigger) wave
// instead of trickling into the meat grinder one by one.
const AI_WAVE_RETREAT_FRACTION=0.35;
// AoE2 sn-scaling-frequency [10 game-minutes]: the minimum attack-group size
// grows +1 (sn-scale-minimum-attack-group-size) each interval past attackTick
// — see the launch hold in launchAIWave. NOT difficulty-scaled (AoE2 doesn't).
const AI_ATTACK_SCALE_EVERY=T30(18000);
// AoE2 sn-maximum-attack-group-size [10]: the ceiling the SCALED minimum
// clamps to — without it the minimum outgrows what a pop-capped army keeps
// AVAILABLE and late-game waves stop. waveCap still bounds the SENT group
// size separately (sendN).
const AI_ATTACK_MIN_GROUP_CAP=10;
// Civilian-militia bounds: only a raid the workforce can genuinely beat is
// worth fighting (~3 militia-equivalents of power — unitPower('militia')=60);
// the response window is how long the bell stays suppressed while they fight.
const AI_MILITIA_MAX_THREAT=180;
const AI_MILITIA_WINDOW=T30(900);
const AI_ESCALATE_EVERY=T30(30); // militia-window escalation re-check (~1 game-second)
function aiRetreatUnit(m,aiTC){
  m.target=null;m.explicitAttack=false;m.groupSpeed=undefined;
  if(m.task==='garrison'){m.task=null;m.garrisonTarget=null;} // abandon boarding a ram
  m.retreatUntil=tick+AI_RETREAT_TICKS;
  let pt=nearestBldgPerimeter(m.x,m.y,aiTC,m.id);
  // The retreat is a shared MOVE order: resumeMultiLegMove re-paths a blocked
  // leg home, and any later AI assignment clears it for free (clearUnitPath
  // kind-cancels move orders).
  issueOrder(m,{kind:'move', x:pt?pt.x:Math.round(aiTC.x), y:pt?pt.y:Math.round(aiTC.y)});
  pathUnitTo(m,pt?pt.x:aiTC.x,pt?pt.y:aiTC.y);
}

// AoE2 sn-percent-enemy-sighted-response [50]: dispatch the NEAREST
// `sightedResponsePercent`% of `pool` (min 2) at target `tgt`, counting units
// already on it toward the quota — the rest hold their posture as home
// defense. Deterministic: dist sort, id tiebreak (lockstep peers identical).
// `candFilter` trims which idle units may be pulled; `assign` issues the order.
function aiDispatchQuota(pool,tgt,profile,candFilter,assign){
  let pct=profile.sightedResponsePercent!=null?profile.sightedResponsePercent:50;
  let want=Math.max(2,Math.ceil(pool.length*pct/100));
  let engaged=pool.filter(m=>m.target===tgt.id).length;
  if(engaged>=want)return;
  let cands=pool.filter(m=>m.target!==tgt.id&&(!candFilter||candFilter(m)));
  cands.sort((a,b)=>dist(a,tgt)-dist(b,tgt)||a.id-b.id);
  cands.slice(0,want-engaged).forEach(assign);
}

// ---- AI MILITARY CONTROL (dispatcher) ----
// One pass per concept, in load-bearing order. Two passes can CONSUME the
// decision tick (bool contract): a badly outmatched home defense (shelter)
// and the base-under-siege posture — everything after them must not run that
// tick. Defense and offense are otherwise PARALLEL systems: a sighted-threat
// dispatch does NOT stop the wave machinery.
function controlAIMilitary(ai,mils,aiTC,profile){
  aiRetreatControl(ai,mils,aiTC,profile);        // HP + wave-casualty retreats
  aiRamRiderControl(ai,mils,aiTC);               // rider disembark + shelter abandon-ship
  if(aiThreatResponse(ai,mils,aiTC,profile))return; // threat scan + sheltered recall + outmatched-shelter/dispatch
  if(aiSiegePostureHold(ai,mils,aiTC,profile))return; // hits landing at home: defend, don't launch
  aiForwardBuildingResponse(ai,mils,aiTC,profile);   // raze the creeping tower (deliberately fall-through)
  launchAIWave(ai,mils,aiTC,profile);            // stray retask + holds + commit + riders + pace
}

function aiRetreatControl(ai,mils,aiTC,profile){
  let tcHome=centerOf(aiTC);
  // Per-unit health retreat. Runs first so fresh retreaters are excluded from
  // every dispatch below on this same decision tick. Directed sieges persist
  // (a ram/committed sieger holds under fire — the escort handles defenders);
  // scouts are recon and already avoid combat via controlAIScouts.
  mils.forEach(m=>{
    if(m.utype==='scout'||holdsSiegeOrder(m))return;
    if(isRetreatingUnit(m)){
      // ARRIVAL ends the retreat: once home the unit must fight again —
      // leaving the stamp running kept survivors pacifist at their own TC
      // while pursuers cut them down. The at-home exemption below stops an
      // instant re-stamp.
      if(dist(m,tcHome)<=6*aiScale())m.retreatUntil=0;
      return;
    }
    // Already home: nowhere to run — stand and fight (retreating here would
    // just stand the unit down under fire while raiders cut the town apart).
    if(dist(m,tcHome)<=6*aiScale())return;
    // lastEnemyHitTick, NOT lastHitTick: only damage from an enemy PLAYER
    // counts — retreating from wildlife is suicide (a bear outruns militia)
    // and abandons the hunt the mob-fight must press.
    if(m.hp<m.maxHp*AI_RETREAT_HP&&m.lastEnemyHitTick!=null&&tick-m.lastEnemyHitTick<AI_RETREAT_HIT_WINDOW){
      aiRetreatUnit(m,aiTC);
    }
  });
  // Wave-casualty retreat, by MEMBERSHIP not geography: every launched
  // attacker carries the wave's number (m.waveId, stamped at launch, hashed)
  // — counting "anyone far from home" recalled the vanguard of a healthy
  // DEPARTING wave. When living members drop below the fraction launched,
  // recall the far-out survivors and close the wave (waveId cleared, so the
  // collapse fires exactly once).
  if(ai.lastWaveSize>0&&ai.lastWaveTick!=null&&ai.tick-ai.lastWaveTick<profile.waveCooldown*3){
    // Count from entities, not `mils`: riders sealed inside a ram are alive
    // wave members but are excluded from mils (garrisonedIn) — counting only
    // the visible ones would read a healthy ram-borne wave as gutted.
    let members=entities.filter(e=>e.team===ai.team&&e.type==='unit'&&e.hp>0&&e.waveId===ai.waveCount);
    if(members.length>0&&members.length<Math.ceil(ai.lastWaveSize*AI_WAVE_RETREAT_FRACTION)){
      members.forEach(m=>{
        m.waveId=undefined;
        if(!holdsSiegeOrder(m)&&!m.garrisonedIn&&dist(m,tcHome)>22)aiRetreatUnit(m,aiTC);
      });
    }
  }
}

function aiRamRiderControl(ai,mils,aiTC){
  // Ram riders disembark (AoE2 garrison-rams) when the siege ARRIVES or the
  // ram takes MELEE hits; a ram whose objective died also unloads.
  // lastMeleeHitTick, NOT lastHitTick: tower chip damage would refresh the
  // stamp forever and eject riders into the exact arrow fire the garrison
  // protects them from. Ejected riders are targetless soldiers far from home:
  // the stray-retask pass points them at the next objective the same tick.
  mils.forEach(m=>{
    if(m.utype!=='ram'||!m.garrison||!m.garrison.length)return;
    let t=m.target?entitiesById.get(m.target):null;
    let arrived=t&&distToTarget(m,t)<=6;
    let underMelee=m.lastMeleeHitTick!=null&&tick-m.lastMeleeHitTick<T30(60);
    if(!t||arrived||underMelee)ejectGarrison(m);
  });
  // ABANDON SHIP (shelter buildings): a garrison dies with its building
  // (handleDeath, AoE2 rule), so soldiers in a TC/tower being MELEED down
  // past half hp bail out and fight at the wreck. "Being meleed" is a live
  // adjacency scan, not a stored timestamp — buildings carry no
  // lastMeleeHitTick and this pass must not add carried state. Villagers
  // stay: the bell owns them, and a TC loss is the knockout anyway.
  entities.forEach(b=>{
    if(b.type!=='building'||b.team!==ai.team||!b.garrison||!b.garrison.length)return;
    if(b.hp>=b.maxHp*0.5)return;
    if(!b.garrison.some(id=>{let u=entitiesById.get(id);return u&&isArmyUnit(u.utype);}))return;
    let meleed=entities.some(u=>u.type==='unit'&&u.hp>0&&isEnemyOf(ai.team,u)
      &&u.range<=0&&u.atk>0&&distToBuilding(u.x,u.y,b)<=1.6);
    if(meleed)ejectGarrison(b,u=>isArmyUnit(u.utype)&&u.utype!=='scout');
  });
}

// Returns true when the outmatched-shelter branch consumed the tick; the
// sighted-response DISPATCH deliberately falls through (parallel systems).
function aiThreatResponse(ai,mils,aiTC,profile){
  let threat=findEnemyThreatNear(ai,aiTC,12*aiScale());
  // Ignore a threat our base is sealed against — chasing an unreachable poker
  // freezes the garrison at the wall (stuck-watchdog spam). Reject ONLY on a
  // DEFINITIVE no-route: findPath returns [] only after fully exploring the
  // reachable region. A partial path (iteration-capped) means
  // far-but-reachable — e.g. a raid on the ALLY's town — and MUST still draw
  // a response.
  if(threat){
    let {x:tcx, y:tcy} = centerTile(aiTC);
    if(findPath(tcx,tcy,Math.round(threat.x),Math.round(threat.y),aiTC.id).length===0) threat=null;
  }
  // SHELTERED-SOLDIER RECALL: soldiers who garrisoned when outmatched come
  // back out when EITHER the coast is clear (same all-clear the villager
  // bell uses) OR the power math flipped (production continued while they
  // sheltered). Hysteresis is structural — enter at >1.6x enemy advantage
  // measured WITHOUT the sheltered, exit at combined parity — so no
  // flapping. Eject via ejectGarrison, the human Ungarrison path (parity).
  {
    let sheltered=[];
    entities.forEach(b=>{
      if(b.type!=='building'||b.team!==ai.team||!b.garrison||!b.garrison.length)return;
      b.garrison.forEach(id=>{
        let u=entitiesById.get(id);
        if(u&&isArmyUnit(u.utype)&&u.utype!=='scout')sheltered.push({b,u});
      });
    });
    if(sheltered.length){
      let release=false;
      if(!threat){
        release=tick-(ai.lastBaseHitTick??-1e9)>=AI_GARRISON_HOLD_TICKS;
      } else {
        let enemyP=estimateLocalEnemyPower(ai,threat,10*aiScale());
        let outsideP=mils.reduce((s,m)=>s+unitPower(m.utype),0)
          +nearbyAlliedPower(ai,threat,10*aiScale());
        let shelteredP=sheltered.reduce((s,x)=>s+unitPower(x.u.utype),0);
        release=outsideP+shelteredP>=enemyP;
      }
      if(release){
        aiProbe('shelterRecall:t'+ai.team);
        let ids=new Set(sheltered.map(x=>x.u.id));
        new Set(sheltered.map(x=>x.b)).forEach(b=>ejectGarrison(b,u=>ids.has(u.id)));
        // Ejected units rejoin `mils` next decision tick (pre-eject snapshot)
        // — deliberate one-interval lag: they regroup before being committed.
      }
    }
  }
  if(threat){
    let localEnemyPower=estimateLocalEnemyPower(ai,threat,10*aiScale());
    let localAllyPower=mils.reduce((s,m)=>s+unitPower(m.utype),0)
      +nearbyAlliedPower(ai,threat,10*aiScale());
    // Badly outmatched defending at home: SHELTER FIRST (AoE2
    // sn-number-garrison-units), TC-perimeter pull-back only when no seat is
    // free — standing to fight fed the army into the raid piecemeal as each
    // unit trained, so no counter-attack ever launched. Inside a garrison the
    // squad is preserved while production raises the release bar (recall pass
    // above). Boarding uses the SHARED flow (task='garrison' →
    // updateGarrisonWalk → enterGarrison); seats via ramSeatsFree (the
    // walker-aware helper, js/commands.js) so this pass can never
    // double-book against belled villagers already walking in.
    if(localAllyPower>0&&localEnemyPower>localAllyPower*1.6){
      let {x:tcx, y:tcy} = centerTile(aiTC);
      let spots=entities.filter(en=>en.type==='building'&&canGarrisonIn(en,ai.team))
        .map(b=>({b,room:ramSeatsFree(b)})).filter(s=>s.room>0);
      mils.forEach(m=>{
        if(holdsSiegeOrder(m))return; // a directed siege persists — don't retreat it
        if(m.task==='garrison')return; // already boarding
        // Scouts stay out (recon — controlAIScouts owns them; a sealed-in
        // scout stops exploring): they use the move-retreat fallback only.
        if(m.utype!=='scout'){
          let best=null,bd=Infinity;
          spots.forEach(s=>{
            if(s.room<=0)return;
            let d=distToBuilding(m.x,m.y,s.b);
            if(d<bd||(d===bd&&(!best||s.b.id<best.b.id))){bd=d;best=s;}
          });
          if(best){
            best.room--;
            aiProbe('shelterSeat:t'+ai.team);
            m.target=null;
            m.task='garrison';m.garrisonTarget=best.b.id;
            let pt=nearestBldgPerimeter(m.x,m.y,best.b,m.id);
            if(pt)pathUnitTo(m,pt.x,pt.y);
            return;
          }
          aiProbe('shelterNoSeat:t'+ai.team);
        }
        // No seat (or scout). Already home: stand and fight (auto-attack
        // acquires targets for idle units) — re-clearing targets every
        // decision tick pins the army in a shot-at-never-shooting-back loop.
        if(dist(m,{x:tcx,y:tcy})<=6*aiScale())return;
        if(!m.target&&m.path.length>0)return; // already retreating — don't re-path
        m.target=null;
        // Perimeter, not the TC's own occupied footprint tile. Shared MOVE
        // order (issueMoveOrder) = a human recall-click.
        let pt=nearestBldgPerimeter(m.x,m.y,aiTC,m.id);
        issueMoveOrder(m,pt?pt.x:tcx,pt?pt.y:tcy);
      });
      return true; // outmatched-shelter consumed the tick
    }
    // AoE2 sn-percent-enemy-sighted-response [50]: only ~half of the eligible
    // troops rush a sighted threat — the rest hold posture as home defense,
    // so a single raider can't drag the whole army across town. Nearest
    // responders first (id tiebreak keeps lockstep peers identical).
    let eligible=mils.filter(m=>{
      if(m.utype==='scout')return false; // scouts are recon — controlAIScouts owns them
      if(holdsSiegeOrder(m))return false; // rams / directed sieges don't chase raiders
      if(isRetreatingUnit(m))return false;    // a fleeing unit keeps fleeing
      if(m.task==='garrison')return false; // boarding a ram — committed to the siege
      // Don't re-send a unit to chase a raider it just proved it can't reach
      // (e.g. one poking the wall from outside our sealed ring) — that's the
      // wedge loop where the whole garrison freezes on an unreachable foe.
      if(m.unreachUntil>tick&&m.unreachId===threat.id)return false;
      return true;
    });
    aiDispatchQuota(eligible,threat,profile,
      m=>!m.target||dist(m,threat)<10*aiScale(),
      m=>assignAttack(m,threat)); // THE shared attack assignment (parity with a human attack-click)
    aiProbe('dispatchThreat:t'+ai.team);
    // NO return: defense and offense are PARALLEL systems — returning here
    // froze BOTH AIs' offense whenever border pickets stayed in mutual sight.
    // Dispatched defenders drop out of `available` by having targets; a real
    // base assault still hard-holds via the siege-posture block and the
    // outmatched shelter branch (both return).
  }
  return false;
}

// Returns true while recent hits near home hold the army in a defensive
// posture (recall + rally instead of launching).
function aiSiegePostureHold(ai,mils,aiTC,profile){
  // Base perimeter UNDER SIEGE — defend instead of marching off to attack.
  // The threat scan ignores a sealed-out besieger and a wall hit isn't
  // "core", so without this the army leaves on an OFFENSIVE while the wall is
  // battered down (the "AI abandons the city" bug). lastTeamHit records every
  // hit with a location, wall/tower hits included: a recent hit near home →
  // recall the far-off army and rally the idle reserve at the gate. We still
  // don't CHASE the sealed-out foe; waves resume once hits stop for
  // AI_GARRISON_HOLD_TICKS.
  {
    let sg=lastTeamHit&&lastTeamHit[ai.team];
    let {x:tcx, y:tcy} = centerTile(aiTC);
    let baseR=(ai.wallRadiusUsed||Math.round(profile.wallRadius*aiScale()))+3;
    if(sg && tick-sg.tick<AI_GARRISON_HOLD_TICKS && Math.max(Math.abs(sg.x-tcx),Math.abs(sg.y-tcy))<=baseR){
      mils.forEach(m=>{
        if(m.utype==='scout')return;          // controlAIScouts owns scouts
        if(holdsSiegeOrder(m))return;          // a committed ram/directed siege persists
        if(dist(m,{x:tcx,y:tcy})<=22)return;   // already near home — leave it (rally handles it)
        m.target=null; m.explicitAttack=false; // recall the far-off attacker to defend
        let pt=nearestBldgPerimeter(m.x,m.y,aiTC,m.id);
        issueMoveOrder(m,pt?pt.x:tcx,pt?pt.y:tcy); // shared move order, human-recall semantics
      });
      rallyIdleMilitary(ai,mils,aiTC);         // hold the idle reserve at the gate
      aiProbe('holdSiege:t'+ai.team);
      return true; // siege posture consumed the tick
    }
  }
  return false;
}

function aiForwardBuildingResponse(ai,mils,aiTC,profile){
  // Anti-forward-building (AoE2 sn-safe-town-size): raze an enemy structure
  // creeping on the town. Runs BELOW unit threats and does NOT return.
  // Top-up quota like the sighted response, so the whole army never dogpiles
  // one foundation.
  {
    let fb=findEnemyForwardBuilding(ai,aiTC,profile);
    if(fb){
      let defenders=mils.filter(m=>m.utype!=='scout'&&!holdsSiegeOrder(m)&&!isRetreatingUnit(m)&&m.task!=='garrison');
      aiDispatchQuota(defenders,fb,profile,m=>!m.target,m=>{
        // resolveReachableAttackTarget handles a walled-off structure by
        // routing through the cheapest breach instead of wedging the unit.
        let t=resolveReachableAttackTarget(m,fb);
        if(t)assignAttack(m,t);
      });
    }
  }
}

// THE wave machinery: holds, commit, riders, formation pace.
function launchAIWave(ai,mils,aiTC,profile){
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
  // Mid-march re-tasking: a kill clears the unit's target AND explicitAttack
  // (updateUnit), so wave survivors would idle at the first corpse mid-map.
  // Every decision tick, any target-less soldier far from home is pointed at
  // the next objective, independent of the wave cooldown.
  {
    let tcC0=centerOf(aiTC);
    // FIXED 22-tile radius, not scaled: a scaled "near home" exemption let
    // mid-map camps of targetless survivors sit inside it un-re-pointed. The
    // forward rally posture parks ~16 tiles out at most, so 22 keeps home
    // defenders exempt while catching every stalled march.
    let strays=mils.filter(m=>!m.target&&m.utype!=='scout'&&!isRetreatingUnit(m)&&m.task!=='garrison'&&dist(m,tcC0)>22);
    if(strays.length){
      let spotted=aiVisibleEnemies(ai,e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');
      // Nothing spotted → march on memory (aiMarchPoint: remembered TC /
      // frontier), mirroring the wave launch. Only for strays NOT already
      // walking an order — re-issuing every decision tick would repath the
      // whole camp each time.
      let marchPt=null, marchPtComputed=false;
      strays.forEach(m=>{
        let t=chooseAIAttackTarget(ai,m,spotted);
        if(t){assignAttack(m,t);return;}
        if(m.order&&m.order.kind==='move')return; // already marching
        if(!marchPtComputed){marchPt=aiMarchPoint(ai,aiTC);marchPtComputed=true;}
        if(marchPt){
          issueOrder(m,{kind:'move', x:marchPt.x, y:marchPt.y});
          pathUnitTo(m,marchPt.x,marchPt.y);
        }
      });
    }
  }
  let holding=false;
  // Scouts are recon, not wave fodder — controlAIScouts owns them (same
  // exemption the stray-retask and rally paths already apply). Committing the
  // lone explorer to the attack mob was the exact thing the scout rework fixed.
  let available=mils.filter(m=>!m.target&&m.utype!=='scout'&&!isRetreatingUnit(m)&&m.task!=='garrison');
  // AoE2 launch model: attacks are ARMY-SIZE driven — a group launches at
  // sn-minimum-attack-group-size (profile.attackSize), growing +1 every
  // sn-scaling-frequency past attackTick, capped (AoE2's own scripts cap the
  // scaled minimum or it outgrows the max group — the documented freeze
  // trap). An eco-scaled launch bar was the defensive death spiral: an army
  // dying at home could never reach it and never counter-attacked. Small
  // persistent sorties ARE the resolution mechanism.
  let minGroup=Math.min(profile.waveCap||60, AI_ATTACK_MIN_GROUP_CAP,
    profile.attackSize+Math.floor(Math.max(0,ai.tick-profile.attackTick)/AI_ATTACK_SCALE_EVERY));
  // Group trigger counts the ARMY (mils), not the momentarily-idle: in a hot
  // border war the sighted dispatch keeps ~half the army cycling through
  // skirmish targets, so "available >= minGroup" was unreachable. The send
  // list below still draws only from `available`.
  if(ai.tick<profile.attackTick||mils.length<minGroup){holding=true;if(ai.tick>=profile.attackTick)aiProbe('holdGroup:t'+ai.team);}
  // Minimum spacing between waves: after committing an attack, regroup and
  // rebuild before the next (larger) one instead of dribbling units out.
  else if(ai.tick-(ai.lastWaveTick??-1e9)<cooldown){holding=true;aiProbe('holdCooldown:t'+ai.team);}
  else {
    let intel=ai.intel;
    if(intel&&intel.strength>0){
      // Don't commit to a march intel says we'd lose — but compare against
      // the CHOSEN TARGET's team, not the sum of every enemy army (which in
      // a team game meant no single AI ever cleared the bar), and credit
      // half of any allied army massed near our own base.
      let availablePower=available.reduce((s,m)=>s+unitPower(m.utype),0);
      let sbt=intel.strengthByTeam; // dense per-team DECAYED memory (0 = no memory of that team)
      let targetTeam=(intel.tcSeen&&intel.tcTeam!=null)?intel.tcTeam:null;
      if(targetTeam==null){
        // No known TC: compare against the weakest-REMEMBERED enemy. A team
        // never contacted sits at 0 — "no known defenses" — so unknowns
        // don't hold the army home (attacking into the unknown is the AoE2
        // default; the march doubles as armed reconnaissance).
        for(let u=0;u<NUM_TEAMS;u++){
          if(!isEnemyOf(ai.team,{team:u}))continue;
          if(targetTeam==null||sbt[u]<sbt[targetTeam])targetTeam=u;
        }
      }
      let targetStrength=targetTeam!=null?sbt[targetTeam]:intel.strength;
      let tcC=centerOf(aiTC);
      let allyPower=nearbyAlliedPower(ai,tcC,20*aiScale());
      if(availablePower+allyPower*0.5<targetStrength*requiredFactor){holding=true;aiProbe('holdIntel:t'+ai.team);}
    }
  }
  if(holding){
    rallyIdleMilitary(ai,mils,aiTC); // forward defensive posture between waves
    return;
  }

  // AoE2 sn-percent-attack-soldiers: commit this % of the whole army, keep
  // the rest home as defense (the difficulty lever). Clamp to a valid group:
  // at least the SCALED min group, never more than waveCap — a bigger army
  // sends proportionally more (AoE2).
  let commit=profile.commitPercent!=null?profile.commitPercent:75;
  let sendN=Math.min(profile.waveCap||60, Math.max(minGroup, Math.round(mils.length*commit/100)));
  let attackers=available.slice(0,sendN);
  let launched=0;
  let waveSpotted=aiVisibleEnemies(ai,e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');
  // Targets first, pace after: formation speed depends on who marches and
  // who RIDES (a loaded ram is faster than an empty one), so riders are
  // planned before the group pace is computed.
  // March on MEMORY, engage what's SEEN: with nothing spotted the wave
  // marches at aiMarchPoint (remembered TC / explore frontier — armed
  // reconnaissance) as a fighting patrol; contact en route enters the
  // spotted set and the stray-retask pass engages it. No live map-truth
  // reads anywhere in the march path.
  let reconPt = aiMarchPoint(ai,aiTC);
  attackers.forEach(m=>{
    let target=chooseAIAttackTarget(ai,m,waveSpotted);
    if(target){
      assignAttack(m,target); // shared semantics incl. order clear + battlefield anchor
      launched++;
    } else if(reconPt){
      issueOrder(m,{kind:'move', x:reconPt.x, y:reconPt.y}); // fighting patrol toward remembered TC / frontier
      pathUnitTo(m,reconPt.x,reconPt.y);
      launched++;
    }
  });
  // AoE2 sn-garrison-rams [1]: the wave's melee infantry rides its rams to
  // the front — arrow-proof en route, and each rider speeds the ram up
  // (unitMoveSpeed, js/logic.js). Riders pop out at the siege / under melee
  // (disembark pass), or unharmed from the wreck (handleDeath). Nearest
  // riders board each ram; id tiebreak keeps lockstep peers identical.
  let plannedRiders=new Map(); // ram id -> boarding count (for the pace below)
  let waveRams=attackers.filter(m=>m.utype==='ram'&&m.target);
  if(waveRams.length){
    let riders=attackers.filter(m=>canRideRam(m)&&m.target);
    waveRams.forEach(ram=>{
      let room=ramSeatsFree(ram); // shared seat accounting (walkers-in-transit count) with the player's ram-click path
      if(room<=0||!riders.length)return;
      riders.sort((a,b)=>dist(a,ram)-dist(b,ram)||a.id-b.id);
      let take=riders.splice(0,room);
      plannedRiders.set(ram.id,take.length);
      take.forEach(r=>{
        r.target=null;r.explicitAttack=false;r.groupSpeed=undefined;
        r.task='garrison';r.garrisonTarget=ram.id;
        clearUnitPath(r);
        pathUnitTo(r,Math.round(ram.x),Math.round(ram.y));
      });
    });
  }
  // March in formation pace: MARCHERS move at the slowest member's EFFECTIVE
  // speed — a ram counts at its loaded speed (+8%/rider), or the wave would
  // crawl at the empty-ram pace the boarding just bought it out of. Rams
  // never receive groupSpeed (unitMoveSpeed exempts them — the ram IS the
  // pace-setter; capping it at its own raw speed nullifies the boost).
  {
    let marchers=attackers.filter(m=>m.target);
    let eff=m=>m.utype==='ram'?(m.speed||1)*(1+0.08*(plannedRiders.get(m.id)||0)):(m.speed||1);
    let waveSpeed=marchers.length>1?Math.min(...marchers.map(eff)):undefined;
    marchers.forEach(m=>{
      // Wave membership stamp: the casualty-retreat pass counts living
      // members of THIS wave (hashed in detEntityHash). Riders are stamped
      // too — sealed in the ram they still count as alive members.
      m.waveId=(ai.waveCount||0)+1;
      if(m.utype!=='ram')m.groupSpeed=waveSpeed;
    });
    attackers.forEach(m=>{ if(m.task==='garrison'&&m.garrisonTarget!=null)m.waveId=(ai.waveCount||0)+1; });
  }
  if(launched>0){
    aiProbe('waveGo:t'+ai.team);
    ai.waveCount=(ai.waveCount||0)+1;
    ai.lastWaveTick=ai.tick;
    ai.lastWaveGlobalTick=tick; // global-tick stamp for allied coordination
    ai.lastWaveSize=launched; // sim state: the wave-casualty retreat reads it (hashed in simChecksum)
  }}

// Idle army posture between waves: hold a forward point (the gate, stepped
// toward the enemy; else a spot ahead of the TC) instead of loitering on the
// TC where a raid reaches the eco before the army reacts. Defenders hold
// GUARD orders in a formation picket — zone-scoped acquisition, the 6-tile
// leash (unkiteable), guard-return after each skirmish. Wave launches clear
// the posts.
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
  // Deterministic picket: mils comes from the entities scan (ascending id),
  // so the shared formation offsets (formationOffsets, js/commands.js —
  // the army's own arrangement compacted onto the rally point) resolve
  // identically on every lockstep peer.
  let pOff=formationOffsets(mils,false);
  mils.forEach(m=>{
    if(m.utype==='scout')return; // controlAIScouts owns scouts
    if(isRetreatingUnit(m))return; // a fleeing unit rests at home until the stamp expires
    if(m.target||m.path.length>0)return;
    if(m.order&&m.order.kind==='guard'&&Math.abs(m.order.x-rx)<=4&&Math.abs(m.order.y-ry)<=4)return;
    if(dist(m,{x:rx,y:ry})<=4&&!m.order)return;
    let [ox,oy]=pOff.get(m.id)||[0,0];
    let px=Math.max(1,Math.min(MAP-2,rx+ox)), py=Math.max(1,Math.min(MAP-2,ry+oy));
    issueOrder(m,{kind:'guard',x:px,y:py});
    pathUnitTo(m,px,py);
  });
}

// Keep an explorer alive: the free starting scout dies early, and without a
// replacement the AI runs blind for the rest of the game. Once the scout is
// unlocked (Feudal — no Dark-Age cavalry, AoE2-accurate) and a barracks is
// up, keep exactly one scout roaming, retraining a lost one just as a human
// keeps re-scouting. A retrain cooldown stops a scout that keeps dying at
// the enemy's doorstep from churning food on a still-fragile economy.
const AI_SCOUT_RETRAIN_COOLDOWN=T30(2400);
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
    // Once the home survey lap is done, the scout runs on the same
    // {kind:'scout'} order a player's Auto Scout uses — frontier exploration
    // (pickExploreWaypoint) with per-tick combat avoidance, driven by
    // updateAutoScoutTick in js/logic.js. Recon, not a hunter.
    if(ai.baseSurveyed){
      if(!(s.order&&s.order.kind==='scout')){
        issueOrder(s,{kind:'scout'});
        s.target=null;s.explicitAttack=false;clearUnitPath(s);
      }
      return;
    }
    if(s.target){
      // Drop a BUILDING target (the classic death trading blows with the
      // enemy TC) AND any GAIA wildlife target — back to surveying. A real
      // ENEMY-team unit (a raider at home during the lap) is left alone.
      let tgt=entitiesById.get(s.target);
      if(tgt&&(tgt.type==='building'||tgt.team===GAIA_TEAM)){ s.target=null; s.explicitAttack=false; clearUnitPath(s); }
      else return; // legitimately engaging an enemy unit — leave it
    }
    if(s.path&&s.path.length>0)return; // still travelling to its last waypoint
    // A lap around home first: survey the base perimeter (the resource band /
    // where the wall ring will go) before ranging out, like a human checking
    // what's around the TC.
    let pt = baseSurveyWaypoint(ai,aiTC) || pickExploreWaypoint(ai.team, aiTC);
    if(pt)pathUnitTo(s,pt.x,pt.y);
  });
}

// Perimeter-survey waypoints: 8 compass points at ~the wall-ring radius around
// the TC, walked in sequence at game start so the scout reveals the immediate
// resources and the ground the wall will enclose before wandering off. Returns
// null (and flips ai.baseSurveyed) once the lap is complete. Deterministic:
// sequential index on AI_STATES, no RNG.
function baseSurveyWaypoint(ai,aiTC){
  // No TC to survey around (controlAIScouts is still called in the no-TC
  // knockout branch): without this guard the aiTC.x deref throws and aborts
  // the sim tick on this peer only — a hard lockstep desync.
  if(!aiTC)return null;
  const dirs=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  let i=ai.surveyIdx||0;
  if(i>=dirs.length){ ai.baseSurveyed=true; return null; }
  ai.surveyIdx=i+1;
  let prof=aiProfileFor(ai.team);
  let R=Math.round(Math.max(6,(prof.wallRadius||6))*aiScale())+2; // just outside the ring band
  let {x:cx, y:cy} = centerTile(aiTC);
  let [dx,dy]=dirs[i];
  return { x:Math.max(1,Math.min(MAP-2,cx+dx*R)), y:Math.max(1,Math.min(MAP-2,cy+dy*R)) };
}

// Exploration-biased waypoints: of 8 random candidates, prefer the one with
// the most UNexplored tiles around it plus a small far-from-home bonus.
// Deterministic: sim RNG + sim state only. Team-parameterized so the HUMAN
// player's Auto Scout (js/logic.js) reuses the exact same frontier logic.
function pickExploreWaypoint(team, homePt){
  let margin=3;
  // All-Visible match: the explored grid is unmaintained (all zeros), so the
  // frontier scoring degrades to distance-biased random wandering — fine:
  // there's nothing to discover, the scout is kept only for flavor.
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

// ---- ANTI-FORWARD-BUILDING (AoE2 sn-safe-town-size) ----
// An enemy BUILDING inside the AI's town radius is a threat even with no
// enemy unit beside it — findEnemyThreatNear is units-only, so the AI let
// itself be towered/walled in. Arrow-firing structures first, then other
// buildings, then walls/gates; foundations count (killing the tower BEFORE
// it stands is the point). Honest knowledge only (teamHasExplored).
function findEnemyForwardBuilding(ai,aiTC,profile){
  let {x:cx, y:cy} = centerTile(aiTC);
  let wr=ai.wallRadiusUsed||Math.round((profile.wallRadius||0)*aiScale());
  let R=(wr||Math.round(AI_BASE_ALARM_RADIUS*aiScale()))+6;
  let best=null,bestPri=99,bestD=Infinity;
  for(let i=0;i<entities.length;i++){
    let b=entities[i];
    if(b.type!=='building'||b.hp<=0||!isEnemyOf(ai.team,b))continue;
    let bx=b.x+(b.w||1)/2, by=b.y+(b.h||1)/2;
    if(Math.max(Math.abs(bx-cx),Math.abs(by-cy))>R)continue;
    if(!teamHasExplored(ai.team,Math.round(b.x)+Math.round(b.y)*MAP))continue;
    let pri=firesArrows(b.btype)?0:(isWallBtype(b.btype)||isGateBtype(b.btype))?2:1;
    let d=dist({x:bx,y:by},{x:cx,y:cy});
    if(pri<bestPri||(pri===bestPri&&(d<bestD||(d===bestD&&best&&b.id<best.id)))){
      bestPri=pri;bestD=d;best=b;
    }
  }
  return best;
}

function findEnemyThreatNear(ai,aiTC,range){
  // Allied buildings count too: in 2v2 the army answers a raid on its ally's
  // town (villager garrison panic stays own-team). The threat must be SEEN
  // (entityVisibleToTeam — information parity; ally vision folds into the
  // team grid). An unseen sieger landing hits still rings the bell via
  // lastTeamHit — hide from a ghost, don't hunt it.
  let aiBuildings = entities.filter(e=>sameSide(e.team,ai.team)&&e.type==='building'&&e.complete);
  let playerUnits = entities.filter(e=>isEnemyOf(ai.team,e)&&e.type==='unit'&&e.utype!=='sheep'
    &&entityVisibleToTeam(e,ai.team));
  
  let closestThreat = null;
  let minDist = 9999;
  
  playerUnits.forEach(pu => {
    aiBuildings.forEach(ab => {
      let d = dist(centerOf(ab), pu);
      if (d <= range && d < minDist) {
        minDist = d;
        closestThreat = pu;
      }
    });
  });
  
  return closestThreat;
}

// ticksToReachBuilding / isTargetReachable / wallBreachTicks /
// nearestReachableWallLike live in js/logic.js (shared attack-pathing
// helpers, used by both the AI and updateUnit's resolveStalledAttack).

// If the chosen target is walled off and unreachable, attack the cheapest
// reachable wall/tower/gate instead — target selection is priority-based and
// doesn't account for reachability, so the unit would otherwise re-pick the
// same unreachable building forever.
// AoE2 detour-vs-breach: even when a path EXISTS, a badly skewed detour is
// compared against smashing the cheapest breach point — militia cut through
// a palisade rather than circle the map, but nobody chews stone when an open
// gate is merely on the far side.
function resolveReachableAttackTarget(militia, candidate){
  if (!candidate) return null;
  if (candidate.type !== 'building') return candidate; // units move — don't probe
  let detour = ticksToReachBuilding(militia, candidate);
  if (detour === 0) return candidate; // already adjacent
  // Straight-line ticks at this unit's speed, for judging how skewed the
  // walk is. Only consider breaching on a big skew (detour > 2x direct +
  // 10 tiles) — nearestReachableWallLike probes up to 6 findPaths, too
  // expensive to run for every ordinarily-reachable target.
  let directTicks = dist(militia, candidate) / ((UNITS[militia.utype].speed || 1) / TPS);
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
  // No global vision: only enemies inside the team's real sight grid are
  // targetable (aiVisibleEnemies — information parity). `spotted` may be
  // passed in prebuilt: the set is attacker-independent and rebuilding it
  // per attacker was an O(n^2) hotspot.
  let spottedEnemies=spotted||aiVisibleEnemies(ai,
    e=>e.utype!=='sheep'&&e.utype!=='sheep_carcass');

  // Fight the army in your face first (marching past a defender invites
  // getting surrounded), then RAID: spotted enemy villagers/trade carts at
  // ANY distance outrank the TC — killing the economy is what makes attacks
  // hurt (AoE2 up-set-offense-priority). The bell is the counter: garrisoned
  // villagers vanish from the spotted set and the wave falls through to the
  // TC siege. Then TC, military infrastructure, the rest. Chasing a fleeing
  // villager into TC fire is authentic raiding — the <30% HP retreat and the
  // wave-casualty recall are the counterweights.
  let engage=12*aiScale();
  let priority=e=>{
    // Rams ignore units entirely (1-2 dmg) — they exist to crack
    // structures; the escorting soldiers handle the defenders.
    if(e.type==='unit'){
      if(dist(militia,e)<=engage)return 0; // rams never see units here (cands is buildings-only for rams)
      return (e.utype==='villager'||e.utype==='tradecart')?1:5; // hunt eco
    }
    if(e.btype==='TC')return 2;
    if(e.btype==='TOWER'||e.btype==='BARRACKS')return 3;
    return 4;
  };
  // Rams attack STRUCTURES only — 2 damage vs a unit is a wasted swing; with
  // no building in sight a ram falls through to marching on the enemy TC.
  // The escorting soldiers handle the defenders (AoE2 siege doctrine).
  let cands = militia.utype==='ram' ? spottedEnemies.filter(e=>e.type==='building') : spottedEnemies;
  if (cands.length > 0) {
    let best = cands.sort((a,b)=>priority(a)-priority(b)||dist(militia,a)-dist(militia,b)||a.id-b.id)[0];
    return resolveReachableAttackTarget(militia, best);
  }
  // Nothing spotted → no target. NO fallback into the fog here (reading live
  // TC coords leaks unscouted positions and death knowledge): the callers
  // march targetless attackers on REMEMBERED intel (aiMarchPoint); arrival
  // vision feeds the next decision tick's spotted set, and ghost memories
  // clear on re-sight (updateAIIntel).
  return null;
}

// Where a wave/stray with NO visible target marches: the remembered enemy
// TC's center if one was ever seen, else the team's own explore frontier —
// ARMED RECONNAISSANCE. Either way a fighting patrol on a plain move order:
// enemies met en route are engaged by the next decision tick.
function aiMarchPoint(ai,aiTC){
  let intel=ai.intel;
  if(intel&&intel.tcSeen){
    return {x:intel.tcX+Math.floor(BLDGS.TC.w/2), y:intel.tcY+Math.floor(BLDGS.TC.h/2)};
  }
  return (typeof pickExploreWaypoint==='function') ? pickExploreWaypoint(ai.team, aiTC||null) : null;
}

function hasAIBuilding(ai,type){
  return entities.some(e=>e.type==='building'&&e.team===ai.team&&e.btype===type);
}

function placeAIBuilding(ai,type,x,y){
  // PARITY: delegate to THE shared placement pipeline the player's
  // execBuildPlacement uses — resolveBuildingPlacement + effectiveBuildCost
  // (consumed walls refund their own cost) + commitBuildingPlacement — so AI
  // wall/gate/tower geometry can never drift from the human rules.
  let plan = resolveBuildingPlacement(type, x, y, ai.team);
  let actualCost = effectiveBuildCost(type, (isGateBtype(type) || isTowerBtype(type)) ? plan.replaced : null);
  if(!canPlace(type,x,y,ai.team)||!canAfford(ai.team,actualCost))return null;
  spendCost(ai.team,actualCost);
  return commitBuildingPlacement(type, plan, ai.team, false);
}

// Food drop-offs (the TC and every Mill) each reserve a farm belt around
// them; other buildings must stay out. Overlapping belts simply union into
// one shared farm block.
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
  for(let d of drops){ if(simHypot(ccx-d.cx,ccy-d.cy)<d.r)return true; }
  return false;
}

// A building must not sit in a gate's passage corridor — the centre doorway
// tile plus a couple of tiles straight out each side along the travel axis —
// or it seals the choke the gate exists to open. Flanking wall tiles are NOT
// in the corridor, so towers can still guard the gate.
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
  // Measure from the TC CENTRE, not its origin corner — an origin-based
  // radius makes the reserved belt lopsided. tcHalf is the TC's half-extent.
  let tcHalf=Math.ceil(tc.w/2);
  let {x:cx, y:cy} = centerOf(tc);
  // The MARKET is placed late, when the walled core is usually full — give it
  // a much larger radius so it can sit at the base edge/outside instead of
  // failing to place and never trading.
  let maxR=Math.round((type==='MARKET'?28:14)*aiScale());
  let minEdge=tcHalf+1;              // scan starts just outside the TC
  // AoE2-style placement: houses/barracks stay out of the FARM BELT around
  // every food drop-off. Barracks additionally prefers the enemy-facing side
  // (the army rallies toward the front, not inside the eco).
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
  // A patch already within coverR of an existing drop-off is served — so the
  // FIRST camp only goes up when the resource is genuinely far from the TC,
  // and LATER camps go to fresh far patches as near ones deplete (AoE2: a
  // new lumber camp at each new forest).
  let coveredBy=(x,y)=>existingDrops&&existingDrops.some(d=>{
    let ex=Math.max(d.x-x,0,x-(d.x+d.w-1)), ey=Math.max(d.y-y,0,y-(d.y+d.h-1));
    return simHypot(ex,ey)<coverR;
  });
  let candidates=[];
  for(let y=1;y<MAP-1;y++)for(let x=1;x<MAP-1;x++){
    if(map[y][x].t!==terrain||map[y][x].res<=0)continue;
    // No omniscience: the AI may only found a camp at a resource patch it has
    // actually SCOUTED (teamHasExplored — the deterministic per-team ever-seen
    // grid). The area around its own TC is revealed from game start, so the
    // opening eco is unaffected; farther patches require a scout first.
    if(!teamHasExplored(ai.team, x+y*MAP))continue;
    if(dist({x,y},centerTile(tc))>maxDist)continue;
    // Safety: never found a camp on proven-deadly ground (a live danger
    // zone — bear or raid) or outside the war-state umbrella. The shared
    // villager-safety predicate (js/logic.js); commuters die otherwise.
    if(!aiVillagerSafeAt(ai.team,x,y))continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      let bx=x+dx,by=y+dy;
      if(!canPlace(type,bx,by,ai.team))continue;
      if(coveredBy(bx,by))continue; // an existing drop already serves this patch
      let nearby=countResourceTilesNear(terrain,bx,by,4);
      // NEAREST ADEQUATE patch, AoE2-style: density only has to clear a
      // workability floor (>=8 tiles), then DISTANCE decides — an open-ended
      // density bonus founded camps 20+ tiles out with commuters dying en
      // route. Sub-floor patches keep the density-weighted score as a
      // fallback, but any adequate patch outranks them (-1000 bias).
      let d=dist({x:bx,y:by},centerTile(tc));
      let s=nearby>=8?d-1000:d-nearby*1.5;
      candidates.push({x:bx,y:by,s});
    }
  }
  // canPlace only checks the footprint terrain, not walkability — the score
  // favors spots deep inside a patch, which easily picks a boxed-in grass
  // pocket. Rank by score, then accept the best-ranked candidate actually
  // reachable from the TC (pathfinding is too costly to run on every one).
  candidates.sort((a,b)=>a.s-b.s || a.x-b.x || a.y-b.y); // positional tie-break: don't depend on Array.sort stability for a sim decision
  let {x:tcx, y:tcy} = centerTile(tc);
  for(let i=0;i<candidates.length;i++){
    let c=candidates[i];
    // Keep camps OUT of the reserved farm belt — but still build the camp at
    // the resource itself (dropping the whole wood line at the TC congests
    // it). Also never seal a gate's passage.
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
