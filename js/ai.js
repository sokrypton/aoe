// ---- AI ----
// All AI spatial radii (build search, drop sites, threat/vision range) were
// tuned for the 60-tile 'small' map. Scale them by MAP size so the AI's
// effective reach (and how far out it expands) grows on medium/large maps
// instead of staying clustered around its starting TC.
function aiScale(){return MAP/60;}

function updateAI(){
  aiTick++;
  let profile=AI_LEVELS[aiDifficulty]||AI_LEVELS.standard;
  if(aiTick%profile.decisionInterval!==0)return;

  let aiBuildings=entities.filter(e=>e.type==='building'&&e.team===1);
  let aiUnits=entities.filter(e=>e.type==='unit'&&e.team===1);
  let aiTC=aiBuildings.find(b=>b.btype==='TC');
  if(!aiTC)return;

  updateAIIntel(profile); // what has scouting/combat actually revealed about the player this tick

  let vils=aiUnits.filter(u=>u.utype==='villager');
  let mils=aiUnits.filter(u=>['militia','spearman','archer','scout'].includes(u.utype));
  let barracks=aiBuildings.filter(b=>b.btype==='BARRACKS');
  let readyBarracks=barracks.filter(b=>b.complete);

  addAITrickle(profile);
  queueAIVillagers(aiTC,vils,profile);
  ensureAIHousing(aiTC,profile);
  planAIDropSites(aiTC,vils,profile);
  planAIFarming(aiTC,vils,profile);
  planAIWalls(aiTC,vils,profile); // AI defensive wall ring + gate
  planAITowers(aiTC,vils,profile); // AI Watch Tower planning
  planAIMilitaryBuildings(aiTC,vils,barracks,profile);
  queueAIMilitary(readyBarracks,profile);
  assignAIVillagers(vils,profile);
  controlAIMilitary(mils,aiTC,profile);
  controlAIScouts(mils,aiTC);
}

// ---- AI INTEL ----
// What the AI actually "knows" about the player, built from units/buildings
// that have come within sight of an AI unit or building — not omniscient
// lookups into the global entities list. Scouts wandering the map (see
// controlAIScouts) are what feeds this: every tile they wander through
// extends AI vision, so exploring is what lets the AI react to what the
// player is building rather than playing blind. TC sighting is sticky (once
// scouted, the AI remembers where it is, like a human player would).
function getSpottedPlayerEntities(){
  let visionRange=15*aiScale();
  return entities.filter(e=>e.team===0&&e.hp>0&&e.utype!=='sheep'&&
    entities.some(ai=>ai.team===1&&dist(ai,e)<=visionRange));
}

function unitPower(utype){
  let u=UNITS[utype];
  if(!u)return 1;
  return u.hp+u.atk*5;
}

function updateAIIntel(profile){
  let intel=window.aiIntel||{unitCounts:{},strength:0,tcSeen:false,tcX:0,tcY:0};
  let unitCounts={},strength=0;
  getSpottedPlayerEntities().forEach(e=>{
    if(e.type==='unit'){
      unitCounts[e.utype]=(unitCounts[e.utype]||0)+1;
      strength+=unitPower(e.utype);
    } else if(e.type==='building'&&e.btype==='TC'){
      intel.tcSeen=true;
      intel.tcX=e.x;intel.tcY=e.y;
    }
  });
  // Safety net: if scouting genuinely never finds the player (bad luck on a
  // large map, player tucked in a corner, etc.), don't leave the AI passive
  // forever once its army is ready — a real opponent eventually locates you
  // through patrols/skirmishes even without perfect scouting.
  if(!intel.tcSeen&&aiTick>profile.attackTick*2){
    let playerTC=entities.find(e=>e.team===0&&e.btype==='TC');
    if(playerTC){intel.tcSeen=true;intel.tcX=playerTC.x;intel.tcY=playerTC.y;}
  }
  intel.unitCounts=unitCounts;
  intel.strength=strength;
  window.aiIntel=intel;
}

function estimateLocalPlayerPower(center,radius){
  return entities.filter(e=>e.team===0&&e.type==='unit'&&e.hp>0&&e.utype!=='sheep'&&dist(e,center)<=radius)
    .reduce((s,e)=>s+unitPower(e.utype),0);
}

function addAITrickle(profile){
  Object.entries(profile.trickle).forEach(([resName,amount])=>{aiRes[resName]+=amount;});
}

function queueAIVillagers(aiTC,vils,profile){
  if(vils.length>=profile.maxVils)return;
  let hasReadyBarracks=entities.some(e=>e.team===1&&e.type==='building'&&e.btype==='BARRACKS'&&e.complete);
  // Only hold back villager training for military food reserve once a minimum workforce exists,
  // otherwise the AI can deadlock with too few villagers to ever recover food income.
  if(hasReadyBarracks&&vils.length>=6&&aiRes.food<profile.militaryFoodReserve)return;
  while(aiTC.queue.length<profile.queueLimit&&vils.length+aiTC.queue.filter(u=>u==='villager').length<profile.maxVils){
    let result=queueUnit(aiTC,'villager');
    if(!result.ok)break;
  }
}

function ensureAIHousing(aiTC,profile){
  let requested=teamPopUsed(1)+teamQueuedPop(1);
  let plannedCap=teamPopCap(1,true);
  let pendingHouses=entities.filter(e=>e.type==='building'&&e.team===1&&e.btype==='HOUSE'&&!e.complete).length;
  if(requested<plannedCap-profile.houseBuffer||pendingHouses>1||!canAfford(1,BLDGS.HOUSE.cost))return;
  let pos=findAIBuildSpot(aiTC,'HOUSE');
  if(pos)placeAIBuilding('HOUSE',pos.x,pos.y);
}

function planAIDropSites(aiTC,vils,profile){
  if(!profile.dropSites||vils.length<5)return;
  let hasBarracks=hasAIBuilding('BARRACKS');
  if(!hasAIBuilding('LCAMP')&&canAfford(1,BLDGS.LCAMP.cost)){
    let pos=findAIDropSite(TERRAIN.FOREST,'LCAMP',aiTC);
    if(pos)placeAIBuilding('LCAMP',pos.x,pos.y);
  }
  if(!hasBarracks&&vils.length>=profile.barracksVil-1)return;
  if(vils.length>=6&&hasBarracks&&!hasAIBuilding('MILL')&&canAfford(1,BLDGS.MILL.cost)){
    let pos=findAIDropSite(TERRAIN.BERRIES,'MILL',aiTC);
    if(pos)placeAIBuilding('MILL',pos.x,pos.y);
  }
  if(vils.length>=7&&hasBarracks&&!hasAIBuilding('MCAMP')&&canAfford(1,BLDGS.MCAMP.cost)){
    let pos=findAIDropSite(TERRAIN.GOLD,'MCAMP',aiTC);
    if(pos)placeAIBuilding('MCAMP',pos.x,pos.y);
  }
}

function planAITowers(aiTC,vils,profile){
  if(vils.length<8||!canAfford(1,BLDGS.TOWER.cost))return;
  let currentTowers=entities.filter(e=>e.type==='building'&&e.team===1&&e.btype==='TOWER').length;
  let maxTowers=profile===AI_LEVELS.hard?2:(profile===AI_LEVELS.standard?1:0);
  if(currentTowers>=maxTowers)return;
  // Prefer building the tower directly into the wall ring (gate flank, then
  // corners) once it's up, over a generic freestanding spot.
  let pos=findAIWallDefenseSpot()||findAIBuildSpot(aiTC,'TOWER');
  if(pos)placeAIBuilding('TOWER',pos.x,pos.y);
}

// ---- AI DEFENSIVE WALLS ----
// Builds a square wall ring around the AI town center once the economy is
// developed enough to afford it (profile.wallVils villagers), then closes it
// with a single gate so the AI's own villagers/army can still path out.
// The ring plan is computed once and cached so repeated calls just resume
// building the next unfinished tile instead of re-scanning every tick.
function planAIWalls(aiTC,vils,profile){
  if(!profile.walls||vils.length<profile.wallVils)return;
  if(!window.aiWallPlan)window.aiWallPlan=computeAIWallRing(aiTC,profile.wallRadius*aiScale());
  let plan=window.aiWallPlan;

  // The gate tile is built as a normal wall like the rest of the ring first —
  // placing a GATE only succeeds by consuming 2 existing adjacent wall tiles,
  // so it has to replace real walls rather than fill an intentional gap.
  let ringDone=plan.every(t=>t.done);
  if(ringDone){
    if(!window.aiGateBuilt){
      let result=resolveAIGate(plan,aiTC);
      if(result==='satisfied'){
        window.aiGateBuilt=true; // a blocked tile already left a natural opening on the best side
      } else if(result){
        let b=placeAIBuilding('GATE',result.x,result.y);
        if(b)window.aiGateBuilt=true;
      }
    }
    return;
  }

  // Place as many wall tiles as the current stone stockpile allows in one
  // go (capped) instead of one tile per decisionInterval — at one-per-tick
  // pacing a ~50-tile ring effectively never finished before a match ended.
  let placedThisCall=0;
  while(placedThisCall<8&&canAfford(1,BLDGS.WALL.cost)){
    let next=plan.find(t=>!t.done);
    if(!next)return;
    placeAIBuilding('WALL',next.x,next.y); // success or not (blocked tile), mark resolved so the plan keeps progressing
    next.done=true;
    placedThisCall++;
  }
}

function computeAIWallRing(tc,radius){
  let r=Math.max(4,Math.round(radius));
  let cx=tc.x+Math.floor(tc.w/2),cy=tc.y+Math.floor(tc.h/2); // build the ring around its center
  let tiles=[];
  let seen=new Set();
  // Each tile remembers which side of the ring it's on, so the gate can be
  // chosen by side later (after we know where resources/the enemy actually
  // are) instead of being baked in as a fixed compass direction up front.
  let addTile=(x,y,side)=>{
    if(x<1||y<1||x>=MAP-1||y>=MAP-1)return;
    let key=x+','+y;
    if(seen.has(key))return;
    seen.add(key);
    tiles.push({x,y,done:false,side});
  };
  for(let dx=-r;dx<=r;dx++){
    addTile(cx+dx,cy-r,'N');
    addTile(cx+dx,cy+r,'S');
  }
  for(let dy=-r+1;dy<=r-1;dy++){
    addTile(cx-r,cy+dy,'W');
    addTile(cx+r,cy+dy,'E');
  }
  return tiles;
}

const WALL_SIDE_DIR={N:{dx:0,dy:-1},S:{dx:0,dy:1},E:{dx:1,dy:0},W:{dx:-1,dy:0}};

// Direction the AI should care about for an exit: toward the known (or, if
// never scouted, assumed-from-start-position) enemy base — that's the route
// soldiers need to march out on to attack, and also the route a threat would
// approach from, so it doubles as the side worth guarding most.
function getEnemyDirection(tc){
  let intel=window.aiIntel;
  let ex,ey;
  if(intel&&intel.tcSeen){
    ex=intel.tcX;ey=intel.tcY;
  } else {
    let plStart=STARTS.find(s=>s.team===0);
    ex=plStart?plStart.x:0;ey=plStart?plStart.y:0;
  }
  let vx=ex-(tc.x+Math.floor(tc.w/2)),vy=ey-(tc.y+Math.floor(tc.h/2));
  let len=Math.hypot(vx,vy)||1;
  return {dx:vx/len,dy:vy/len};
}

// Scores a ring side by how well it faces (a) the AI's own resource drop
// sites — so villagers have a short, direct walk out to gather/return — and
// (b) the enemy direction, weighted higher since the attack/defense route
// matters more than gathering convenience.
function scoreWallSide(side,tc){
  let dir=WALL_SIDE_DIR[side];
  let score=0;
  entities.filter(e=>e.type==='building'&&e.team===1&&['LCAMP','MCAMP','MILL'].includes(e.btype)).forEach(d=>{
    let vx=(d.x+0.5)-(tc.x+Math.floor(tc.w/2)),vy=(d.y+0.5)-(tc.y+Math.floor(tc.h/2));
    let len=Math.hypot(vx,vy)||1;
    score+=(vx/len)*dir.dx+(vy/len)*dir.dy;
  });
  let enemyDir=getEnemyDirection(tc);
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
function resolveAIGate(plan,aiTC){
  let wallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===1&&en.btype==='WALL'&&en.x===x&&en.y===y);
  let hasWallNeighbor=(x,y)=>wallAt(x+1,y)||wallAt(x-1,y)||wallAt(x,y+1)||wallAt(x,y-1);

  let ranked=['N','S','E','W'].sort((a,b)=>scoreWallSide(b,aiTC)-scoreWallSide(a,aiTC));
  for(let side of ranked){
    let sideTiles=plan.filter(t=>t.side===side);
    let hole=sideTiles.find(t=>!wallAt(t.x,t.y));
    if(hole){
      window.aiGateTile=hole;
      return 'satisfied';
    }
    let mid=sideTiles[Math.floor(sideTiles.length/2)];
    let candidates=[mid,...sideTiles];
    let pick=candidates.find(c=>wallAt(c.x,c.y)&&hasWallNeighbor(c.x,c.y));
    if(pick){
      window.aiGateTile=pick;
      return pick;
    }
  }
  return null;
}

// Picks the next-highest-priority spot to build a Watch Tower directly into
// the finished wall ring: the gate's flank first (it's the one breach point
// in an otherwise solid wall), then the four corners (the other natural
// ambush/sightline points along the perimeter).
function findAIWallDefenseSpot(){
  let plan=window.aiWallPlan;
  if(!plan)return null;
  let ringDone=plan.every(t=>t.done);
  if(!ringDone)return null;
  let hasTowerAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===1&&en.btype==='TOWER'&&en.x===x&&en.y===y);
  let isWallAt=(x,y)=>entities.some(en=>en.type==='building'&&en.team===1&&en.btype==='WALL'&&en.x===x&&en.y===y);

  let gateTile=window.aiGateTile;
  if(gateTile){
    let flanks=[{x:gateTile.x+1,y:gateTile.y},{x:gateTile.x-1,y:gateTile.y},{x:gateTile.x,y:gateTile.y+1},{x:gateTile.x,y:gateTile.y-1}];
    let flank=flanks.find(f=>isWallAt(f.x,f.y)&&!hasTowerAt(f.x,f.y));
    if(flank)return flank;
  }

  let xs=plan.map(t=>t.x),ys=plan.map(t=>t.y);
  let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  let corners=[{x:minX,y:minY},{x:maxX,y:minY},{x:minX,y:maxY},{x:maxX,y:maxY}];
  return corners.find(c=>!hasTowerAt(c.x,c.y))||null;
}

function planAIMilitaryBuildings(aiTC,vils,barracks,profile){
  if(vils.length<profile.barracksVil||barracks.length>=profile.maxBarracks||!canAfford(1,BLDGS.BARRACKS.cost))return;
  let pos=findAIBuildSpot(aiTC,'BARRACKS');
  if(pos)placeAIBuilding('BARRACKS',pos.x,pos.y);
}

function queueAIMilitary(readyBarracks,profile){
  let currentArmy=entities.filter(e=>e.team===1&&e.type==='unit'&&['militia','spearman','archer','scout'].includes(e.utype)).length;
  let maxArmy=profile.attackSize+profile.armyReserve+5;
  if(currentArmy>=maxArmy)return;
  
  let types = ['militia', 'spearman', 'archer', 'scout'];
  // Rock-paper-scissors counters, per the unit descriptions in core.js:
  // spearman is anti-cavalry (counters scout), scout runs down archers,
  // archers shred standing infantry. Picked from real scouted intel, not
  // omniscient knowledge of the player's army.
  let counterMap={scout:'spearman',archer:'scout',militia:'archer',spearman:'archer'};
  let pickUnitType=()=>{
    let counts=window.aiIntel&&window.aiIntel.unitCounts;
    if(counts){
      let dominant=Object.keys(counts).filter(t=>counterMap[t]).sort((a,b)=>counts[b]-counts[a])[0];
      // Counter-pick most of the time once there's real intel on what the
      // player is fielding — not always, so the matchup isn't perfectly
      // predictable/exploitable by the player switching unit types.
      if(dominant&&Math.random()<0.7)return counterMap[dominant];
    }
    return types[randInt(0, types.length - 1)];
  };

  readyBarracks.forEach(barracks=>{
    while(barracks.queue.length<profile.queueLimit&&teamPopUsed(1)+teamQueuedPop(1)<teamPopCap(1)&&currentArmy+barracks.queue.length<maxArmy){
      let utype = pickUnitType();
      if(!queueUnit(barracks,utype).ok){
        if(!queueUnit(barracks,'spearman').ok){
          if(!queueUnit(barracks,'militia').ok){
            break;
          }
        }
      }
    }
  });
}

function assignAIVillagers(vils,profile){
  let incompleteBuilds=entities.filter(en=>en.type==='building'&&en.team===1&&(!en.complete || en.hp < en.maxHp));
  vils.forEach(v=>{
    if(v.path.length>0||v.target)return;
    if(v.task==='build'){
      // isAIGatherTaskStale() doesn't know 'build' as a task type, so it was
      // reporting an actively-building villager "stale" every single decision
      // tick and yanking it off to gather mid-construction — the building
      // would then get re-flagged as needing work and pull someone back,
      // looking like the AI bumping off and returning. Only leave the build
      // if its target is actually gone/finished.
      let target=v.buildTarget&&entitiesById.get(v.buildTarget);
      if(target&&target.team===1&&(!target.complete||target.hp<target.maxHp))return;
    }
    let build=neededAIBuildingWork(incompleteBuilds,vils,profile);
    if(build&&v.task!=='build'){
      assignAIBuilder(v,build);
      return;
    }
    if(v.task&&v.task!=='build'&&!isAIGatherTaskStale(v))return;
    assignAIGatherTask(v,vils,profile);
  });
}

function neededAIBuildingWork(incompleteBuilds,vils,profile){
  return incompleteBuilds.find(build=>{
    let assigned=vils.filter(v=>v.task==='build'&&v.buildTarget===build.id).length;
    return assigned<profile.buildersPerBuilding;
  });
}

function assignAIBuilder(v,build){
  v.task='build';
  v.buildTarget=build.id;
  v.target=null;
  clearGatherTarget(v);
  let b=BLDGS[build.btype];
  let pt=b.isFarm?{x:build.x,y:build.y}:(typeof nearestBldgPerimeter==='function'?nearestBldgPerimeter(v.x,v.y,build):{x:build.x+build.w,y:build.y+build.h});
  pathUnitTo(v,pt.x,pt.y);
}

function isAIGatherTaskStale(v){
  if(!GATHER_TASKS[v.task])return true;
  if(v.gatherX<0)return false;
  let cfg=GATHER_TASKS[v.task];
  let tile=map[v.gatherY]&&map[v.gatherY][v.gatherX];
  return !tile||tile.t!==cfg.terrain||tile.res<=0||!canGatherTile(v,cfg.terrain,v.gatherX,v.gatherY);
}

function assignAIGatherTask(v,vils,profile){
  let desired=aiEcoPlan(vils.length,profile);
  let counts=countAIGatherers(vils);
  let task=Object.keys(desired).sort((a,b)=>(counts[a]||0)/desired[a]-(counts[b]||0)/desired[b])[0];
  if(task==='mine_gold'&&!hasReachableResource(v,TERRAIN.GOLD))task='chop';
  if(task==='forage'&&!hasReachableResource(v,TERRAIN.BERRIES))task='chop';
  // Only assign farm task if a complete AI farm actually exists to work
  if(task==='farm'&&!hasReachableResource(v,TERRAIN.FARM))task='forage';
  v.task=task;
  v.target=null;
  v.buildTarget=null;
  clearGatherTarget(v);
}

function aiEcoPlan(vilCount,profile){
  let militaryStarted=entities.some(e=>e.team===1&&e.type==='building'&&e.btype==='BARRACKS');
  let hasMill=hasAIBuilding('MILL');
  if(vilCount<=5)return{forage:3,chop:2,mine_gold:1,mine_stone:1};
  if(!militaryStarted)return{forage:3,chop:4,mine_gold:1,mine_stone:1};
  // Only include 'farm' key when value > 0 — a zero denominator in the gatherer sort produces NaN
  let base;
  if(profile===AI_LEVELS.easy) base={forage:2,chop:3,mine_gold:2,mine_stone:1};
  else if(profile===AI_LEVELS.hard) base={forage:3,chop:4,mine_gold:4,mine_stone:1};
  else base={forage:3,chop:3,mine_gold:3,mine_stone:1};
  if(hasMill) base.farm=profile===AI_LEVELS.hard?4:profile===AI_LEVELS.easy?2:3;
  // Walls/gate/towers are pure stone sinks (~5/tile, dozens of tiles) — without
  // this the default 1-share stone ratio never keeps up and the ring stalls
  // forever half-built. Pull more gatherers onto stone until it's finished.
  let wallPlan=window.aiWallPlan;
  if(wallPlan&&!wallPlan.every(t=>t.done))base.mine_stone=(base.mine_stone||1)+3;
  return base;
}

function countAIGatherers(vils){
  return vils.reduce((counts,v)=>{
    if(GATHER_TASKS[v.task])counts[v.task]=(counts[v.task]||0)+1;
    return counts;
  },{forage:0,farm:0,chop:0,mine_gold:0,mine_stone:0});
}

function planAIFarming(aiTC,vils,profile){
  // Farms need a Mill for food drop-off; only worthwhile once military is underway
  if(!hasAIBuilding('MILL')||!hasAIBuilding('BARRACKS'))return;
  if(vils.length<6||!canAfford(1,BLDGS.FARM.cost))return;
  let totalFarms=entities.filter(e=>e.type==='building'&&e.team===1&&e.btype==='FARM').length;
  let targetFarms=profile===AI_LEVELS.hard?4:profile===AI_LEVELS.easy?2:3;
  if(totalFarms>=targetFarms)return;
  let pos=findAIFarmSpot(aiTC);
  if(pos)placeAIBuilding('FARM',pos.x,pos.y);
}

function findAIFarmSpot(tc){
  let maxR=Math.round(10*aiScale());
  for(let r=2;r<maxR;r++){
    for(let a=0;a<16;a++){
      let ang=a*Math.PI*2/16;
      let tx=tc.x+Math.round(Math.cos(ang)*r);
      let ty=tc.y+Math.round(Math.sin(ang)*r);
      if(canPlace('FARM',tx,ty))return{x:tx,y:ty};
    }
  }
  return null;
}

function hasReachableResource(v,terrain){
  return !!findNearTile(v,terrain);
}

function controlAIMilitary(mils,aiTC,profile){
  let threat=findPlayerThreatNear(aiTC,12*aiScale());
  if(threat){
    let localEnemyPower=estimateLocalPlayerPower(threat,10);
    let localAllyPower=mils.reduce((s,m)=>s+unitPower(m.utype),0);
    // Badly outmatched defending at home: pull back to the TC instead of
    // feeding units one at a time into a fight that's already lost — a real
    // opponent disengages rather than dying in place for no gain.
    if(localAllyPower>0&&localEnemyPower>localAllyPower*1.6){
      mils.forEach(m=>{
        m.target=null;
        pathUnitTo(m,aiTC.x+Math.floor(aiTC.w/2),aiTC.y+Math.floor(aiTC.h/2));
      });
      return;
    }
    mils.forEach(m=>{
      if(!m.target||dist(m,threat)<10){
        m.target=threat.id;
        clearUnitPath(m); // stop current movement so they engage immediately
      }
    });
    return;
  }
  if(mils.length<profile.attackSize||aiTick<profile.attackTick)return;

  let available=mils.filter(m=>!m.target);
  let intel=window.aiIntel;
  if(intel&&intel.strength>0){
    // Don't commit to a march we already have scouting intel says we'd lose —
    // hold and keep growing the army instead of throwing it away piecemeal.
    let availablePower=available.reduce((s,m)=>s+unitPower(m.utype),0);
    if(availablePower<intel.strength*profile.attackAdvantage)return;
  }

  let attackers=available.slice(0,Math.max(profile.attackSize,mils.length-profile.armyReserve));
  attackers.forEach(m=>{
    let target=chooseAIAttackTarget(m);
    if(target){m.target=target.id;clearUnitPath(m);}
  });
}

// Scouts were previously just folded into the attack mob in controlAIMilitary
// and otherwise sat idle near the TC. Send any scout that isn't currently
// fighting/attacking or already travelling off to a fresh random point on the
// map, so they actually explore (and the player sees them roaming) instead of
// clumping at home until the army is big enough to march out together.
function controlAIScouts(mils,aiTC){
  let scouts=mils.filter(m=>m.utype==='scout');
  scouts.forEach(s=>{
    if(s.target)return; // controlAIMilitary already has this scout fighting/attacking
    if(s.path&&s.path.length>0)return; // still travelling to its last waypoint
    let pt=randomScoutWaypoint();
    if(pt)pathUnitTo(s,pt.x,pt.y);
  });
}

function randomScoutWaypoint(){
  let margin=3;
  for(let attempt=0;attempt<8;attempt++){
    let x=randInt(margin,MAP-1-margin);
    let y=randInt(margin,MAP-1-margin);
    if(map[y]&&map[y][x]&&map[y][x].t!==TERRAIN.WATER)return{x,y};
  }
  return null;
}

function findPlayerThreatNear(aiTC,range){
  let aiBuildings = entities.filter(e=>e.team===1&&e.type==='building'&&e.complete);
  let playerUnits = entities.filter(e=>e.team===0&&e.type==='unit'&&e.utype!=='sheep');
  
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

function chooseAIAttackTarget(militia){
  let enemies=entities.filter(e=>{
    if (e.team !== 0 || e.hp <= 0 || e.utype === 'sheep') return false;
    // AI can only target enemy units/buildings if they reside in coordinates the AI team has explored
    let tx = Math.floor(e.x), ty = Math.floor(e.y);
    // Since AI's vision matches team 1, verify if the AI team has explored this tile.
    // For simplicity, team 1 (AI) explored areas are tracked. Let's use the fog check.
    // The player's fog maps team 0. If there isn't a dedicated AI fog array, let's limit 
    // attack targets to entities within range of AI buildings/units, OR verify target visibility.
    // Let's implement an explicit range search or fog check:
    return true; // Fog check will be updated by adding a team 1 fog tracker if needed, or by distance search.
  });
  
  // To avoid global vision, let's only target player entities that have been spotted.
  // A player entity is "spotted" if it is within a reasonable distance (15 tiles) of ANY AI unit/building.
  let visionRange=15*aiScale();
  let spottedEnemies = enemies.filter(enemy => {
    return entities.some(aiEnt => {
      return aiEnt.team === 1 && dist(aiEnt, enemy) <= visionRange;
    });
  });

  // Fallback to searching nearby player town centers if no units are spotted,
  // but only head to their coordinate range (simulating exploration).
  let priority=e=>e.type==='building'?(e.btype==='TC'?0:1):(e.utype==='militia'?2:3);
  if (spottedEnemies.length > 0) {
    return spottedEnemies.sort((a,b)=>priority(a)-priority(b)||dist(militia,a)-dist(militia,b))[0];
  } else if (window.aiIntel && window.aiIntel.tcSeen) {
    // Only head for the player's TC if a scout/unit has actually seen it at
    // some point this game — otherwise the AI would be marching on knowledge
    // it has no in-fiction way of having.
    let playerTC = entities.find(e => e.team === 0 && e.btype === 'TC');
    if (playerTC && dist(militia, playerTC) > visionRange) {
      return playerTC; // Patrol/march towards the known player TC
    }
  }
  return null;
}

function hasAIBuilding(type){
  return entities.some(e=>e.type==='building'&&e.team===1&&e.btype===type);
}

function placeAIBuilding(type,x,y){
  let b=BLDGS[type];
  let gw = b.w, gh = b.h;
  let ox = x, oy = y;
  if (type === 'GATE') {
    let isWall = (tx, ty) => {
      let w = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === 1);
      return !!w;
    };
    if (isWall(x, y) && isWall(x + 1, y)) {
      ox = x; oy = y; gw = 2; gh = 1;
    } else if (isWall(x - 1, y) && isWall(x, y)) {
      ox = x - 1; oy = y; gw = 2; gh = 1;
    } else if (isWall(x, y) && isWall(x, y + 1)) {
      ox = x; oy = y; gw = 1; gh = 2;
    } else if (isWall(x, y - 1) && isWall(x, y)) {
      ox = x; oy = y - 1; gw = 1; gh = 2;
    }
  }
  let wallsToRemove = [];
  for (let dy = 0; dy < gh; dy++) {
    for (let dx = 0; dx < gw; dx++) {
      let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && en.btype === 'WALL' && en.team === 1);
      if (w) wallsToRemove.push(w);
    }
  }
  let actualCost = {...b.cost};
  if (type === 'GATE') {
    actualCost.s = Math.max(0, (actualCost.s || 0) - wallsToRemove.length * 5);
  } else if (type === 'TOWER') {
    let existing = entities.find(en => en.type === 'building' && en.x === x && en.y === y && en.btype === 'WALL' && en.team === 1);
    if (existing) {
      actualCost.s = Math.max(0, (actualCost.s || 0) - 5);
      wallsToRemove.push(existing);
    }
  }
  if(!canPlace(type,x,y,1)||!canAfford(1,actualCost))return null;
  spendCost(1,actualCost);
  if (wallsToRemove.length > 0) {
    let ids = new Set(wallsToRemove.map(w => w.id));
    entities = entities.filter(en => !ids.has(en.id));
    ids.forEach(id => entitiesById.delete(id));
  }
  let building=createBuilding(type,ox,oy,1,gw,gh);
  building.complete=false;
  building.buildProgress=0;
  return building;
}

function findAIBuildSpot(tc,type){
  let b=BLDGS[type];
  let maxR=Math.round(12*aiScale());
  for(let r=3;r<maxR;r++){
    for(let a=0;a<16;a++){
      let ang=a*Math.PI*2/16;
      let tx=tc.x+Math.round(Math.cos(ang)*r);
      let ty=tc.y+Math.round(Math.sin(ang)*r);
      if(canPlace(type,tx,ty))return{x:tx,y:ty};
    }
  }
  return null;
}

function findAIDropSite(terrain,type,tc){
  let maxDist=22*aiScale();
  let candidates=[];
  for(let y=1;y<MAP-1;y++)for(let x=1;x<MAP-1;x++){
    if(map[y][x].t!==terrain||map[y][x].res<=0)continue;
    if(dist({x,y},{x:tc.x+Math.floor(tc.w/2),y:tc.y+Math.floor(tc.h/2)})>maxDist)continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      let bx=x+dx,by=y+dy;
      if(!canPlace(type,bx,by))continue;
      let nearby=countResourceTilesNear(terrain,bx,by,4);
      let s=dist({x:bx,y:by},{x:tc.x,y:tc.y})-nearby*1.5;
      candidates.push({x:bx,y:by,s});
    }
  }
  // canPlace only checks the footprint terrain itself, not whether a villager
  // can actually walk to it — the score above favors spots deep inside a
  // resource patch (more "nearby" tiles = better score), which easily picks
  // a grass pocket fully boxed in by forest/water on every side. Rank by
  // score first, then accept the best-ranked candidate that's actually
  // reachable from the TC (pathfinding is too costly to run on every one).
  candidates.sort((a,b)=>a.s-b.s);
  for(let i=0;i<candidates.length;i++){
    let c=candidates[i];
    if(findPath(tc.x+Math.floor(tc.w/2),tc.y+Math.floor(tc.h/2),c.x,c.y,-1).length>0)return{x:c.x,y:c.y};
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
