// ---- AI ----
function updateAI(){
  aiTick++;
  let profile=AI_LEVELS[aiDifficulty]||AI_LEVELS.standard;
  if(aiTick%profile.decisionInterval!==0)return;

  let aiBuildings=entities.filter(e=>e.type==='building'&&e.team===1);
  let aiUnits=entities.filter(e=>e.type==='unit'&&e.team===1);
  let aiTC=aiBuildings.find(b=>b.btype==='TC');
  if(!aiTC)return;

  let vils=aiUnits.filter(u=>u.utype==='villager');
  let mils=aiUnits.filter(u=>u.utype==='militia');
  let barracks=aiBuildings.filter(b=>b.btype==='BARRACKS');
  let readyBarracks=barracks.filter(b=>b.complete);

  addAITrickle(profile);
  queueAIVillagers(aiTC,vils,profile);
  ensureAIHousing(aiTC,profile);
  planAIDropSites(aiTC,vils,profile);
  planAIFarming(aiTC,vils,profile);
  planAIMilitaryBuildings(aiTC,vils,barracks,profile);
  queueAIMilitary(readyBarracks,profile);
  assignAIVillagers(vils,profile);
  controlAIMilitary(mils,aiTC,profile);
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

function planAIMilitaryBuildings(aiTC,vils,barracks,profile){
  if(vils.length<profile.barracksVil||barracks.length>=profile.maxBarracks||!canAfford(1,BLDGS.BARRACKS.cost))return;
  let pos=findAIBuildSpot(aiTC,'BARRACKS');
  if(pos)placeAIBuilding('BARRACKS',pos.x,pos.y);
}

function queueAIMilitary(readyBarracks,profile){
  let currentArmy=entities.filter(e=>e.team===1&&e.type==='unit'&&e.utype==='militia').length;
  let maxArmy=profile.attackSize+profile.armyReserve+5;
  if(currentArmy>=maxArmy)return;
  readyBarracks.forEach(barracks=>{
    while(barracks.queue.length<profile.queueLimit&&teamPopUsed(1)+teamQueuedPop(1)<teamPopCap(1)&&currentArmy+barracks.queue.length<maxArmy){
      if(!queueUnit(barracks,'militia').ok)break;
    }
  });
}

function assignAIVillagers(vils,profile){
  let incompleteBuilds=entities.filter(en=>en.type==='building'&&en.team===1&&!en.complete);
  vils.forEach(v=>{
    if(v.path.length>0||v.target)return;
    let build=neededAIBuildingWork(incompleteBuilds,vils,profile);
    if(build&&v.task!=='build'){
      assignAIBuilder(v,build);
      return;
    }
    if(v.task&&!isAIGatherTaskStale(v))return;
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
  let px=b.isFarm?build.x:build.x+b.w, py=b.isFarm?build.y:build.y+b.h;
  pathUnitTo(v,px,py);
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
  for(let r=2;r<10;r++){
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
  let threat=findPlayerThreatNear(aiTC,12);
  if(threat){
    mils.forEach(m=>{
      if(!m.target||dist(m,threat)<10){
        m.target=threat.id;
        clearUnitPath(m); // stop current movement so they engage immediately
      }
    });
    return;
  }
  if(mils.length<profile.attackSize||aiTick<profile.attackTick)return;
  let attackers=mils.filter(m=>!m.target).slice(0,Math.max(profile.attackSize,mils.length-profile.armyReserve));
  attackers.forEach(m=>{
    let target=chooseAIAttackTarget(m);
    if(target){m.target=target.id;clearUnitPath(m);}
  });
}

function findPlayerThreatNear(aiTC,range){
  let cx=aiTC.x+aiTC.w/2,cy=aiTC.y+aiTC.h/2;
  return entities.filter(e=>e.team===0&&e.type==='unit'&&e.utype!=='sheep')
    .filter(e=>dist({x:cx,y:cy},e)<=range)
    .sort((a,b)=>dist({x:cx,y:cy},a)-dist({x:cx,y:cy},b))[0]||null;
}

function chooseAIAttackTarget(militia){
  let enemies=entities.filter(e=>e.team===0&&e.hp>0&&e.utype!=='sheep');
  // TC=0 (win condition, highest priority), other buildings=1, militia=2, villager=3
  let priority=e=>e.type==='building'?(e.btype==='TC'?0:1):(e.utype==='militia'?2:3);
  return enemies.sort((a,b)=>priority(a)-priority(b)||dist(militia,a)-dist(militia,b))[0]||null;
}

function hasAIBuilding(type){
  return entities.some(e=>e.type==='building'&&e.team===1&&e.btype===type);
}

function placeAIBuilding(type,x,y){
  if(!canPlace(type,x,y)||!canAfford(1,BLDGS[type].cost))return null;
  spendCost(1,BLDGS[type].cost);
  let building=createBuilding(type,x,y,1);
  building.complete=false;
  building.buildProgress=0;
  return building;
}

function findAIBuildSpot(tc,type){
  let b=BLDGS[type];
  for(let r=3;r<12;r++){
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
  let best=null,score=9999;
  for(let y=1;y<MAP-1;y++)for(let x=1;x<MAP-1;x++){
    if(map[y][x].t!==terrain||map[y][x].res<=0)continue;
    if(dist({x,y},{x:tc.x+1,y:tc.y+1})>22)continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      let bx=x+dx,by=y+dy;
      if(!canPlace(type,bx,by))continue;
      let nearby=countResourceTilesNear(terrain,bx,by,4);
      let s=dist({x:bx,y:by},{x:tc.x,y:tc.y})-nearby*1.5;
      if(s<score){score=s;best={x:bx,y:by};}
    }
  }
  return best;
}

function countResourceTilesNear(terrain,cx,cy,r){
  let count=0;
  for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    let x=cx+dx,y=cy+dy;
    if(x>=0&&x<MAP&&y>=0&&y<MAP&&map[y][x].t===terrain&&map[y][x].res>0)count++;
  }
  return count;
}
