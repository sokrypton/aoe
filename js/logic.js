// ---- GAME LOGIC ----
function canPlace(type,x,y){
  let b=BLDGS[type];
  for(let dy=0;dy<b.h;dy++)for(let dx=0;dx<b.w;dx++){
    let nx=x+dx,ny=y+dy;
    if(nx<0||nx>=MAP||ny<0||ny>=MAP)return false;
    let t=map[ny][nx];
    if(t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)return false;
    if(t.occupied)return false;
  }
  return true;
}

const RES_KEYS={f:'food',w:'wood',g:'gold',s:'stone'};
const GATHER_TASKS={
  chop:{terrain:TERRAIN.FOREST,resource:'wood',cooldown:15,clearOccupied:true},
  mine_gold:{terrain:TERRAIN.GOLD,resource:'gold',cooldown:20},
  mine_stone:{terrain:TERRAIN.STONE,resource:'stone',cooldown:20},
  forage:{terrain:TERRAIN.BERRIES,resource:'food',cooldown:15},
  farm:{terrain:TERRAIN.FARM,resource:'food',cooldown:18,clearOccupied:true,removeFarm:true,requiresOwnCompleteFarm:true}
};

function resourceStore(team){
  return team===0?res:aiRes;
}

function resourceName(key){
  return RES_KEYS[key]||key;
}

function canAfford(team,cost){
  let store=resourceStore(team);
  return Object.entries(cost||{}).every(([key,amount])=>store[resourceName(key)]>=amount);
}

function spendCost(team,cost){
  let store=resourceStore(team);
  Object.entries(cost||{}).forEach(([key,amount])=>{store[resourceName(key)]-=amount;});
}

function formatCost(cost){
  return Object.entries(cost||{}).map(([key,amount])=>key.toUpperCase()+':'+amount).join(' ');
}

function unitPop(type){
  return type==='sheep'?0:1;
}

function teamPopUsed(team){
  return entities.filter(e=>e.type==='unit'&&e.team===team&&unitPop(e.utype)>0).length;
}

function buildingPop(e,includeIncomplete){
  if(e.type!=='building')return 0;
  if(!includeIncomplete&&!e.complete)return 0;
  if(e.btype==='TC')return 5;
  return BLDGS[e.btype].pop||0;
}

function teamPopCap(team,includeIncomplete=false){
  return entities.reduce((total,e)=>e.team===team?total+buildingPop(e,includeIncomplete):total,0);
}

function teamQueuedPop(team){
  return entities.reduce((total,e)=>{
    if(e.type!=='building'||e.team!==team)return total;
    return total+e.queue.reduce((sum,utype)=>sum+unitPop(utype),0);
  },0);
}

function hasPopulationRoom(team,utype,includeQueue=true){
  return teamPopUsed(team)+(includeQueue?teamQueuedPop(team):0)+unitPop(utype)<=teamPopCap(team);
}

function canQueueUnit(bldg,utype){
  if(!hasPopulationRoom(bldg.team,utype,true))return{ok:false,reason:'pop'};
  if(!canAfford(bldg.team,UNITS[utype].cost))return{ok:false,reason:'resources'};
  return{ok:true};
}

function queueUnit(bldg,utype){
  let check=canQueueUnit(bldg,utype);
  if(!check.ok)return check;
  spendCost(bldg.team,UNITS[utype].cost);
  bldg.queue.push(utype);
  return check;
}

function refreshPopulationCounts(){
  popUsed=teamPopUsed(0);
  popCap=teamPopCap(0);
  aiPop=teamPopUsed(1);
  aiPopCap=teamPopCap(1);
}

function nearestDrop(e,resType){
  let best=null,bd=999;
  entities.forEach(b=>{
    if(b.type!=='building'||b.team!==e.team||!b.complete)return;
    if(b.btype==='TC'||(BLDGS[b.btype].drop&&BLDGS[b.btype].drop.split(',').includes(resType))){
      let d=distToBuilding(e.x,e.y,b);
      if(d<bd){bd=d;best=b;}
    }
  });
  return best;
}

function dist(a,b){return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2)}

function buildingAtTile(x,y,filter){
  return entities.find(en=>{
    if(en.type!=='building')return false;
    let b=BLDGS[en.btype];
    return x>=en.x&&x<en.x+b.w&&y>=en.y&&y<en.y+b.h&&(!filter||filter(en));
  })||null;
}

function farmAtTile(x,y,team,requireComplete=true){
  return buildingAtTile(x,y,en=>
    en.btype==='FARM'&&en.team===team&&(!requireComplete||en.complete)
  );
}

function canGatherTile(e,terrain,x,y){
  if(terrain===TERRAIN.FARM)return !!farmAtTile(x,y,e.team,true);
  return true;
}

// Distance from point to nearest tile of a building
function distToBuilding(px,py,bldg){
  let b=BLDGS[bldg.btype];
  let best=999;
  for(let dy=0;dy<b.h;dy++)for(let dx=0;dx<b.w;dx++){
    let d=Math.abs(bldg.x+dx+0.5-px)+Math.abs(bldg.y+dy+0.5-py);
    if(d<best)best=d;
  }
  return best;
}

// Check if unit is adjacent to any tile of a building (within 1.5 tiles)
function adjToBuilding(px,py,bldg){
  let b=BLDGS[bldg.btype];
  for(let dy=-1;dy<=b.h;dy++)for(let dx=-1;dx<=b.w;dx++){
    if(dx>=0&&dx<b.w&&dy>=0&&dy<b.h)continue; // skip building tiles themselves
    let tx=bldg.x+dx+0.5, ty=bldg.y+dy+0.5;
    if(Math.abs(px-tx)<1.2&&Math.abs(py-ty)<1.2)return true;
  }
  return false;
}

// Find nearest walkable tile adjacent to building perimeter
function nearestBldgPerimeter(px,py,bldg){
  let b=BLDGS[bldg.btype];
  let best=null,bd=999;
  for(let dy=-1;dy<=b.h;dy++)for(let dx=-1;dx<=b.w;dx++){
    if(dx>=0&&dx<b.w&&dy>=0&&dy<b.h)continue;
    let tx=bldg.x+dx, ty=bldg.y+dy;
    if(tx>=0&&tx<MAP&&ty>=0&&ty<MAP&&walkable(tx,ty)){
      let d=Math.abs(px-tx)+Math.abs(py-ty);
      if(d<bd){bd=d;best={x:tx,y:ty};}
    }
  }
  return best||{x:Math.min(bldg.x+b.w,MAP-1),y:Math.min(bldg.y+b.h,MAP-1)};
}

function clearGatherTarget(e){
  e.gatherX=-1;
  e.gatherY=-1;
}

function rememberedGatherTile(e,terrain){
  if(e.gatherX<0)return null;
  let tile=map[e.gatherY]&&map[e.gatherY][e.gatherX];
  if(tile&&tile.t===terrain&&tile.res>0&&canGatherTile(e,terrain,e.gatherX,e.gatherY))return{x:e.gatherX,y:e.gatherY};
  return null;
}

function depleteGatherTile(pos,config){
  let tile=map[pos.y][pos.x];
  tile.t=TERRAIN.GRASS;
  if(config.clearOccupied)tile.occupied=null;
  if(config.removeFarm){
    let farm=entities.find(f=>f.type==='building'&&f.btype==='FARM'&&f.x===pos.x&&f.y===pos.y);
    if(farm){
      entities=entities.filter(en=>en.id!==farm.id);
      selected=selected.filter(s=>s.id!==farm.id);
    }
  }
}

function updateGatherTask(e,config){
  let gatherTile=rememberedGatherTile(e,config.terrain)||findNearTile(e,config.terrain);
  if(!gatherTile){
    e.task=null;
    clearGatherTarget(e);
    return;
  }

  e.gatherX=gatherTile.x;
  e.gatherY=gatherTile.y;
  // requiresOwnCompleteFarm guard removed: both rememberedGatherTile and findNearTile
  // already call canGatherTile which validates the farm, so this check is unreachable.
  let d=dist(e,{x:gatherTile.x+0.5,y:gatherTile.y+0.5});
  if(d>1.0){
    pathUnitTo(e,gatherTile.x,gatherTile.y);
    if(e.path.length===0){
      clearGatherTarget(e);
      e.task=null;
      if(e.team===0)showMsg('Resource is unreachable!');
    }
    return;
  }

  if(e.gatherCooldown>0)return;
  let tile=map[gatherTile.y][gatherTile.x];
  // Guard against two villagers depleting the same tile in the same tick
  if(tile.res<=0){
    depleteGatherTile(gatherTile,config);
    clearGatherTarget(e);
    return;
  }
  if(e.carryType && e.carryType !== config.resource){
    e.carrying = 0;
  }
  tile.res--;
  e.carrying++;
  e.carryType=config.resource;
  e.gatherCooldown=config.cooldown;
  if(tile.res<=0){
    depleteGatherTile(gatherTile,config);
    clearGatherTarget(e);
  }
}

function checkNextBuild(e){
  e.buildQueue = e.buildQueue || [];
  // Filter out any completed or invalid targets
  e.buildQueue = e.buildQueue.filter(id => {
    let bt = entities.find(en => en.id === id);
    return bt && !bt.complete;
  });
  if (e.buildQueue.length > 0) {
    let nextId = e.buildQueue[0];
    let bt = entities.find(en => en.id === nextId);
    if (bt) {
      e.task = 'build';
      e.buildTarget = nextId;
      e.target = null;
      let b = BLDGS[bt.btype];
      let px = b.isFarm ? bt.x : bt.x + b.w;
      let py = b.isFarm ? bt.y : bt.y + b.h;
      pathUnitTo(e, px, py);
      return true;
    }
  }
  return false;
}

function damageEntity(attacker, target){
  target.hp -= attacker.atk;
  
  // Retaliation: attacked units fight back (not sheep, only opposing teams, and only if autoAttack is enabled)
  if(target.type==='unit'&&target.utype!=='sheep'&&attacker.team!==target.team&&(target.autoAttack!==false)){
    let shouldRetaliate = false;
    if(!target.target){
      shouldRetaliate = true;
    } else {
      let curT = entities.find(en=>en.id===target.target);
      // Switch target from buildings/sheep to focus the attacking soldier
      if(!curT || curT.type==='building'||curT.utype==='sheep'){
        shouldRetaliate = true;
      }
    }
    if(shouldRetaliate){
      target.target = attacker.id;
      target.task = null; // drop gathering/farming/building tasks
      clearUnitPath(target);
    }
  }
  
  if(target.hp<=0) handleDeath(target, attacker.team);
}

function updateUnit(e){
  if(e.hp<=0)return;
  e.atkCooldown=Math.max(0,e.atkCooldown-1);
  e.gatherCooldown=Math.max(0,e.gatherCooldown-1);

  // Sheep behavior (AoE2-style)
  if(e.utype==='sheep'){
    e.eatTicks = e.eatTicks || 0;
    if(e.eatTicks > 0){
      e.eatTicks--;
      e.eatingGrass = true;
    } else {
      e.eatingGrass = false;
    }

    if(e.path.length===0 && !e.eatingGrass){
      // Periodically stop to eat grass (approx. every 4-8 seconds)
      if(tick % 180 === 0 && Math.random() < 0.4){
        e.eatTicks = randInt(60, 120);
      }
      // Or wander around locally in tiny steps (within 1 tile)
      else if(tick % 120 === 0 && Math.random() < 0.25){
        let wx=Math.round(e.x)+randInt(-1,1);
        let wy=Math.round(e.y)+randInt(-1,1);
        if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
          pathUnitTo(e,wx,wy);
        }
      }
    }

    // Convert to first player/AI unit that gets within 5 tiles
    if(e.team===2){
      let closest=null, cd=6;
      entities.forEach(en=>{
        if(en.type==='unit'&&en.utype!=='sheep'&&(en.team===0||en.team===1)){
          let d=dist(e,en);
          if(d<cd){cd=d;closest=en;}
        }
      });
      if(closest){e.team=closest.team;clearUnitPath(e);} // convert and stop
    }
  }

  if(e.path.length>0){
    e.moveT+=e.speed*0.04;
    while(e.moveT>=1&&e.path.length>0){
      e.moveT-=1;
      let next=e.path.shift();
      e.fromX=next.x;e.fromY=next.y;
      e.x=next.x;e.y=next.y;
    }
    if(e.path.length>0){
      let next=e.path[0];
      e.x=e.fromX+(next.x-e.fromX)*e.moveT;
      e.y=e.fromY+(next.y-e.fromY)*e.moveT;
    }
    return;
  }

  if(e.target){
    let t=entities.find(en=>en.id===e.target);
    if(!t||t.hp<=0){e.target=null;return;}
    if(t.type==='building'){
      // Attack building: path to nearest perimeter tile, attack when adjacent
      if(!adjToBuilding(e.x,e.y,t)){
        let pt=nearestBldgPerimeter(e.x,e.y,t);
        pathUnitTo(e,pt.x,pt.y);
        if(e.path.length===0)e.target=null; // can't reach, give up
      } else if(e.atkCooldown<=0){
        damageEntity(e,t);
        e.atkCooldown=30;
      }
    } else {
      // Attack unit: path close and hit
      let d=dist(e,t);
      if(d>1.5){
        pathUnitTo(e,Math.round(t.x),Math.round(t.y));
        if(e.path.length===0)e.target=null;
      } else if(e.atkCooldown<=0){
        damageEntity(e,t);
        e.atkCooldown=30;
      }
    }
    return;
  }

  if(e.utype==='villager'&&e.task){
    if(e.task==='build'&&e.buildTarget){
      let bt=entities.find(en=>en.id===e.buildTarget);
      if(!bt||bt.complete){
        if(!checkNextBuild(e)){
          e.task=null;
          e.buildTarget=null;
        }
        return;
      }
      let isFarm=bt.btype==='FARM';
      let close=isFarm?dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2:adjToBuilding(e.x,e.y,bt);
      if(!close){
        if(isFarm){
          pathUnitTo(e,bt.x,bt.y);
        } else {
          let pt=nearestBldgPerimeter(e.x,e.y,bt);
          pathUnitTo(e,pt.x,pt.y);
        }
        if(e.path.length===0){
          if(e.team===0)showMsg('Building site is unreachable!');
          if(!checkNextBuild(e)){
            e.task=null;
            e.buildTarget=null;
          }
        }
      } else {
        bt.buildProgress++;
        if(bt.buildProgress>=bt.buildTime){
          bt.complete=true;
          e.buildTarget=null;
          // Clean completed target from queue
          if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);
          // Auto-farm only if there are no more buildings left in queue
          if(!checkNextBuild(e)){
            if(bt.btype==='FARM'){e.task='farm';}
            else{e.task=null;}
          }
        }
      }
      return;
    }
    if(e.task==='return'){
      let drop=nearestDrop(e,e.carryType);
      if(!drop){e.task=null;return;}
      if(!adjToBuilding(e.x,e.y,drop)){
        let pt=nearestBldgPerimeter(e.x,e.y,drop);
        pathUnitTo(e,pt.x,pt.y);
        if(e.path.length===0){
          e.task=null;
          if(e.team===0)showMsg('Cannot reach drop site!');
        }
      } else {
        if(e.team===0)res[e.carryType]+=e.carrying;
        else aiRes[e.carryType]+=e.carrying;
        e.carrying=0;
        if(e.prevTask){e.task=e.prevTask;e.prevTask=null;}
        else e.task=null;
      }
      return;
    }
    if(e.carrying>=e.carryMax){
      e.prevTask=e.task;e.task='return';return;
    }
    if(GATHER_TASKS[e.task])updateGatherTask(e,GATHER_TASKS[e.task]);
  }
  // Auto-attack: idle units engage nearby enemies (AoE2 defensive stance, not sheep, and only if autoAttack is enabled)
  if(e.utype!=='sheep'&&!e.target&&e.path.length===0&&!e.task&&(e.autoAttack!==false)){
    let scanRange=6;
    let closest=null, closestD=scanRange+1;
    entities.forEach(en=>{
      if(en.team!==e.team&&en.type==='unit'&&en.hp>0&&en.utype!=='sheep'){
        let d=dist(e,en);
        if(d<closestD){closestD=d;closest=en;}
      }
    });
    if(closest) e.target=closest.id;
  }
}

function findNearTile(e,terrain){
  let bx=Math.round(e.x),by=Math.round(e.y);
  let best=null,bd=999;
  // Collect tiles already claimed by other villagers on same team
  let claimed=new Set();
  entities.forEach(en=>{
    if(en.type==='unit'&&en.id!==e.id&&en.team===e.team&&en.gatherX>=0)
      claimed.add(en.gatherX+en.gatherY*MAP);
  });
  for(let r=0;r<12;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(!canGatherTile(e,terrain,nx,ny))continue;
        if(claimed.has(nx+ny*MAP))continue; // skip claimed tiles
        let d=Math.abs(dx)+Math.abs(dy);
        if(d<bd){bd=d;best={x:nx,y:ny};}
      }
    }
    if(best)return best;
  }
  // If all tiles are claimed, fall back to any available tile
  for(let r=0;r<12;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(!canGatherTile(e,terrain,nx,ny))continue;
        let d=Math.abs(dx)+Math.abs(dy);
        if(d<bd){bd=d;best={x:nx,y:ny};}
      }
    }
    if(best)return best;
  }
  return null;
}

function handleDeath(e,killerTeam){
  // Sheep drop food to killer's team
  if(e.type==='unit'&&e.utype==='sheep'&&UNITS.sheep.food){
    let food=UNITS.sheep.food;
    if(killerTeam===0)res.food+=food;
    else if(killerTeam===1)aiRes.food+=food;
  }
  if(e.type==='building'){
    let b=BLDGS[e.btype];
    for(let dy=0;dy<b.h;dy++)for(let dx=0;dx<b.w;dx++){
      if(e.y+dy<MAP&&e.x+dx<MAP){map[e.y+dy][e.x+dx].occupied=null;
        if(b.isFarm)map[e.y+dy][e.x+dx].t=TERRAIN.GRASS;}
    }
    if(e.btype==='TC'){
      if(e.team===1){gameOver=true;won=true;}
      else{gameOver=true;won=false;}
    }
  }
  // Add to corpses list for AoE2-style decay (skip for sheep)
  if(e.type==='unit'&&e.utype!=='sheep'){
    corpses.push({
      type: 'corpse',
      utype: e.utype,
      x: e.x,
      y: e.y,
      team: e.team,
      id: e.id,
      facing: e.facing || 1,
      deathTime: performance.now()
    });
  }
  selected=selected.filter(s=>s.id!==e.id);
  entities=entities.filter(en=>en.id!==e.id);
}

function findSpawnTile(x,y,maxRadius=4){
  for(let r=0;r<maxRadius;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(walkable(x+dx,y+dy))return{x:x+dx,y:y+dy};
  }
  return null;
}

function updateBuilding(e){
  if(!e.complete)return;
  if(e.queue.length>0){
    let u=UNITS[e.queue[0]];
    if(e.trainTick<u.trainTime)e.trainTick++;
    if(e.trainTick>=u.trainTime){
      if(!hasPopulationRoom(e.team,e.queue[0],false))return;
      let b=BLDGS[e.btype];
      let spawn=findSpawnTile(e.x+b.w,e.y+b.h) || findSpawnTile(e.x,e.y);
      if(!spawn)return;
      e.trainTick=0;
      let ut=e.queue.shift();
      let unit=createUnit(ut,spawn.x,spawn.y,e.team);
      
      // Auto-command the unit based on building's rally point
      if(unit && e.team===0 && e.rallyX!==undefined && e.rallyY!==undefined){
        if(e.rallyTargetId){
          let target=entities.find(en=>en.id===e.rallyTargetId);
          if(target){
            if(unit.utype==='villager'&&target.type==='building'&&!target.complete&&target.team===0){
              unit.task='build';
              unit.buildTarget=target.id;
              pathUnitTo(unit,target.x,target.y);
            } else if(target.team===1){
              unit.target=target.id;
              pathUnitTo(unit,target.x,target.y);
            } else {
              pathUnitTo(unit,e.rallyX,e.rallyY);
            }
          }
        } else if(e.rallyResourceType!==undefined&&e.rallyResourceType!==null&&unit.utype==='villager'){
          let resNames={[TERRAIN.FOREST]:'chop',[TERRAIN.GOLD]:'mine_gold',[TERRAIN.STONE]:'mine_stone',[TERRAIN.BERRIES]:'forage',[TERRAIN.FARM]:'farm'};
          let task=resNames[e.rallyResourceType];
          if(task){
            unit.task=task;
            unit.gatherX=e.rallyX;
            unit.gatherY=e.rallyY;
            pathUnitTo(unit,e.rallyX,e.rallyY);
          }
        } else {
          pathUnitTo(unit,e.rallyX,e.rallyY);
        }
      }
    }
  }
}
