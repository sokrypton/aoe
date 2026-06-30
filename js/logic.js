// ---- GAME LOGIC ----
function canPlace(type,x,y,team=0){
  let b=BLDGS[type];
  let bw=b.w, bh=b.h;
  let ox=x, oy=y;
  if(type==='GATE'){
    // A gate can ONLY be placed on an existing 2-tile allied wall segment.
    let isWall = (tx, ty) => {
      let w = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === team);
      return !!w;
    };
    if (isWall(x, y) && isWall(x + 1, y)) {
      ox = x; oy = y; bw = 2; bh = 1;
    } else if (isWall(x - 1, y) && isWall(x, y)) {
      ox = x - 1; oy = y; bw = 2; bh = 1;
    } else if (isWall(x, y) && isWall(x, y + 1)) {
      ox = x; oy = y; bw = 1; bh = 2;
    } else if (isWall(x, y - 1) && isWall(x, y)) {
      ox = x; oy = y - 1; bw = 1; bh = 2;
    } else {
      return false; // Must be built on exactly 2 wall tiles
    }
  }
  for(let dy=0;dy<bh;dy++)for(let dx=0;dx<bw;dx++){
    let nx=ox+dx,ny=oy+dy;
    if(nx<0||nx>=MAP||ny<0||ny>=MAP)return false;
    if(team===0&&fog[ny][nx]===0)return false; // can't build on unexplored tiles
    let t=map[ny][nx];
    if(t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)return false;
    if(t.occupied){
      let existing = entities.find(en => en.id === t.occupied);
      if (existing && existing.type === 'building' && existing.btype === 'WALL' && existing.team === team) {
        continue;
      }
      return false;
    }
  }
  return true;
}
function getLineTiles(p1, p2) {
  let tiles = [];
  let dx = p2.x - p1.x;
  let dy = p2.y - p1.y;
  let steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) {
    tiles.push({x: p1.x, y: p1.y});
    return tiles;
  }
  for (let i = 0; i <= steps; i++) {
    let t = i / steps;
    let tx = Math.round(p1.x + t * dx);
    let ty = Math.round(p1.y + t * dy);
    // Avoid duplicate coordinates
    if (!tiles.some(tile => tile.x === tx && tile.y === ty)) {
      tiles.push({x: tx, y: ty});
    }
  }
  return tiles;
}


const RES_KEYS={f:'food',w:'wood',g:'gold',s:'stone'};
const GATHER_TASKS={
  chop:{terrain:TERRAIN.FOREST,resource:'wood',cooldown:15,clearOccupied:true},
  mine_gold:{terrain:TERRAIN.GOLD,resource:'gold',cooldown:15},
  mine_stone:{terrain:TERRAIN.STONE,resource:'stone',cooldown:16},
  farm:{terrain:TERRAIN.FARM,resource:'food',cooldown:18,clearOccupied:true,removeFarm:true,requiresOwnCompleteFarm:true},
  forage:{terrain:TERRAIN.BERRIES,resource:'food',cooldown:19}
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
  let cap = entities.reduce((total,e)=>e.team===team?total+buildingPop(e,includeIncomplete):total,0);
  return Math.min(200, cap);
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

function nearestDrop(e,resType,excludeIds=null){
  let best=null,bd=999;
  entities.forEach(b=>{
    if(b.type!=='building'||b.team!==e.team||!b.complete)return;
    if(excludeIds && excludeIds.has(b.id))return;
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
    return x>=en.x&&x<en.x+en.w&&y>=en.y&&y<en.y+en.h&&(!filter||filter(en));
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
  let best=999;
  for(let dy=0;dy<bldg.h;dy++)for(let dx=0;dx<bldg.w;dx++){
    let d=Math.abs(bldg.x+dx+0.5-px)+Math.abs(bldg.y+dy+0.5-py);
    if(d<best)best=d;
  }
  return best;
}

// Check if unit is adjacent to any tile of a building (within 1.5 tiles)
function adjToBuilding(px,py,bldg){
  for(let dy=-1;dy<=bldg.h;dy++)for(let dx=-1;dx<=bldg.w;dx++){
    if(dx>=0&&dx<bldg.w&&dy>=0&&dy<bldg.h)continue; // skip building tiles themselves
    let tx=bldg.x+dx+0.5, ty=bldg.y+dy+0.5;
    if(Math.abs(px-tx)<1.2&&Math.abs(py-ty)<1.2)return true;
  }
  return false;
}

// Find nearest walkable tile adjacent to building perimeter
function nearestBldgPerimeter(px,py,bldg){
  let best=null,bd=999;
  for(let dy=-1;dy<=bldg.h;dy++)for(let dx=-1;dx<=bldg.w;dx++){
    if(dx>=0&&dx<bldg.w&&dy>=0&&dy<bldg.h)continue;
    let tx=bldg.x+dx, ty=bldg.y+dy;
    if(tx>=0&&tx<MAP&&ty>=0&&ty<MAP&&walkable(tx,ty)){
      let d=Math.abs(px-tx)+Math.abs(py-ty);
      if(d<bd){bd=d;best={x:tx,y:ty};}
    }
  }
  return best||{x:Math.min(bldg.x+bldg.w,MAP-1),y:Math.min(bldg.y+bldg.h,MAP-1)};
}

function clearGatherTarget(e){
  e.gatherX=-1;
  e.gatherY=-1;
  e.failedGatherTiles=null;
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
  let gatherTile = rememberedGatherTile(e, config.terrain);
  if(!gatherTile){
    gatherTile = findNearTile(e, config.terrain);
  }

  if(!gatherTile){
    e.task=null;
    clearGatherTarget(e);
    return;
  }

  e.gatherX=gatherTile.x;
  e.gatherY=gatherTile.y;
  let isAdj = Math.abs(Math.round(e.x) - gatherTile.x) <= 1 && Math.abs(Math.round(e.y) - gatherTile.y) <= 1;
  if(!isAdj){
    if(e.path.length === 0){
      pathUnitTo(e,gatherTile.x,gatherTile.y);
      if(e.path.length===0){
        e.failedGatherTiles = e.failedGatherTiles || new Set();
        e.failedGatherTiles.add(gatherTile.x + gatherTile.y * MAP);

        let foundPath = false;
        while (true) {
          let nextTile = findNearTile(e, config.terrain, e.failedGatherTiles);
          if (!nextTile) break;

          e.gatherX = nextTile.x;
          e.gatherY = nextTile.y;
          pathUnitTo(e, nextTile.x, nextTile.y);
          if (e.path.length > 0) {
            foundPath = true;
            break;
          }
          e.failedGatherTiles.add(nextTile.x + nextTile.y * MAP);
        }

        if (foundPath) return;

        clearGatherTarget(e);
        e.task=null;
        if(e.team===0)showMsg('Resource is unreachable!');
      }
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

  // Play gathering audio effects (player team 0)
  if (e.team === 0 && window.playSound) {
    let sType = e.task;
    if (sType === 'mine_gold' || sType === 'mine_stone') sType = 'mine';
    window.playSound(sType);
  }
  // Spawn gathering particles
  let pColor = '#4a8c2a';
  if (e.task === 'chop') pColor = '#8b5a2b';
  else if (e.task === 'mine_gold') pColor = '#ffd700';
  else if (e.task === 'mine_stone') pColor = '#888';
  spawnParticles(gatherTile.x + 0.5, gatherTile.y + 0.5, pColor, 2, 0.02, 1.2);

  if(tile.res<=0){
    depleteGatherTile(gatherTile,config);
    clearGatherTarget(e);
  }
}

function checkNextBuild(e){
  e.buildQueue = e.buildQueue || [];
  // Find all actual unfinished building entities in the queue
  let unfinishedInQueue = e.buildQueue
    .map(id => entities.find(en => en.id === id))
    .filter(bt => bt && (!bt.complete || bt.hp < bt.maxHp));

  if (unfinishedInQueue.length === 0) {
    // Look for any unfinished allied foundations nearby (within 25 tiles)
    let unfinished = entities.filter(en => en.type === 'building' && en.team === e.team && !en.complete);
    if (unfinished.length > 0) {
      unfinished.sort((a, b) => dist(e, a) - dist(e, b));
      if (dist(e, unfinished[0]) <= 25) {
        unfinishedInQueue.push(unfinished[0]);
      }
    }
  }

  if (unfinishedInQueue.length > 0) {
    // Sort unfinished targets by distance to the villager so they build the closest next!
    unfinishedInQueue.sort((a, b) => dist(e, a) - dist(e, b));
    
    // Sync the queue list with sorted order
    e.buildQueue = unfinishedInQueue.map(bt => bt.id);
    
    let bt = unfinishedInQueue[0];
    e.task = 'build';
    e.buildTarget = bt.id;
    e.target = null;
    let b = BLDGS[bt.btype];
    let pt = b.isFarm ? {x: bt.x, y: bt.y} : nearestBldgPerimeter(e.x, e.y, bt);
    pathUnitTo(e, pt.x, pt.y);
    return true;
  }
  
  e.buildQueue = [];
  return false;
}

function damageEntity(attacker, target){
  let dmg = attacker.atk || 0;
  if (attacker.utype === 'spearman' && target.utype === 'scout') dmg += 8; // Spearman counters Scout Cavalry
  if (attacker.utype === 'militia' && target.utype === 'spearman') dmg += 2; // Militia counters Spearman
  if (attacker.utype === 'scout' && target.utype === 'archer') dmg += 3; // Scout counters Archer
  if (attacker.utype === 'archer' && target.utype === 'spearman') dmg += 3; // Archer counters Spearman

  target.hp -= dmg;

  // Play combat sound and spawn particles
  if (target.type === 'unit') {
    if (window.playSound) window.playSound('attack');
    spawnParticles(target.x, target.y, '#990000', 4, 0.04, 1.5);
  } else {
    if (window.playSound) window.playSound('build');
    spawnParticles(target.x + (target.w||1)/2, target.y + (target.h||1)/2, '#8b6c43', 3, 0.03, 2);
  }

  // Under attack alarm trigger (player team 0)
  if (target.team === 0 && attacker.team === 1) {
    let lastAlert = window.lastAlertTick || 0;
    if (tick - lastAlert > 180) {
      window.lastAlertTick = tick;
      if (window.playSound) window.playSound('alert');
      showMsg('We are under attack!');
    }
  }
  
  // Retaliation: attacked units fight back (not sheep, only opposing teams).
  // A unit actively carrying out a player move order (a path in progress, or
  // a pending multi-leg move goal — see updateUnit()) keeps obeying it
  // instead of being yanked into combat; e.g. a retreating soldier should
  // keep retreating. Note: a unit that's merely following another (but has
  // already caught up and stopped, path.length===0) isn't "mid-order" in
  // that sense and should still defend itself like any idle unit.
  let hasActiveMoveOrder = target.type==='unit' && (target.path.length>0 || target.moveGoalX!==undefined);
  if(target.type==='unit'&&target.utype!=='sheep'&&attacker.team!==target.team&&!hasActiveMoveOrder){
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
}function autoTaskBuilder(e, bt){
  if(bt.btype==='FARM'){
    e.task='farm';
    e.gatherX=bt.x;
    e.gatherY=bt.y;
  } else if(bt.btype==='LCAMP'){
    let nearWood = findNearTile(e, TERRAIN.FOREST);
    if (nearWood) {
      e.task = 'chop';
      e.gatherX = nearWood.x;
      e.gatherY = nearWood.y;
      pathUnitTo(e, nearWood.x, nearWood.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MILL'){
    let nearBerries = findNearTile(e, TERRAIN.BERRIES);
    if (nearBerries) {
      e.task = 'forage';
      e.gatherX = nearBerries.x;
      e.gatherY = nearBerries.y;
      pathUnitTo(e, nearBerries.x, nearBerries.y);
    } else {
      e.task = null;
    }
  } else if(bt.btype==='MCAMP'){
    let nearGold = findNearTile(e, TERRAIN.GOLD);
    let nearStone = findNearTile(e, TERRAIN.STONE);
    let targetTile = null;
    let targetTask = null;
    if (nearGold && nearStone) {
      let dGold = Math.abs(nearGold.x - e.x) + Math.abs(nearGold.y - e.y);
      let dStone = Math.abs(nearStone.x - e.x) + Math.abs(nearStone.y - e.y);
      if (dGold <= dStone) {
        targetTile = nearGold;
        targetTask = 'mine_gold';
      } else {
        targetTile = nearStone;
        targetTask = 'mine_stone';
      }
    } else if (nearGold) {
      targetTile = nearGold;
      targetTask = 'mine_gold';
    } else if (nearStone) {
      targetTile = nearStone;
      targetTask = 'mine_stone';
    }
    
    if (targetTile) {
      e.task = targetTask;
      e.gatherX = targetTile.x;
      e.gatherY = targetTile.y;
      pathUnitTo(e, targetTile.x, targetTile.y);
    } else {
      e.task = null;
    }
  } else {
    e.task = null;
  }
}

function updateUnit(e){
  if(e.hp<=0)return;
  e.atkCooldown=Math.max(0,e.atkCooldown-1);
  e.gatherCooldown=Math.max(0,e.gatherCooldown-1);

  // Follow: keep tracking a moving friendly unit (AoE2-style "Follow" order).
  // Re-paths toward its current position periodically rather than once, since
  // the destination keeps changing.
  if(e.followId){
    let f=entitiesById.get(e.followId);
    if(!f||f.hp<=0){
      e.followId=undefined;
    } else {
      let d=dist(e,f);
      if(d>1.5){
        if(e.path.length===0 && tick-(e.lastFollowRepathTick||0)>=12){
          e.lastFollowRepathTick=tick;
          pathUnitTo(e,Math.round(f.x),Math.round(f.y));
        }
      } else if(e.path.length>0){
        // Close enough — stop walking but keep following so we resume if it moves away.
        e.path=[];e.moveT=0;e.fromX=e.x;e.fromY=e.y;
      }
    }
  }

  // Multi-leg pathing: if the current task/target-free move order only got a
  // partial route last time (far-off destination, blocked by obstacles, etc.),
  // automatically continue toward the original goal once the current leg ends,
  // instead of silently stopping partway like a stuck/unresponsive order.
  if(e.path.length===0 && e.moveGoalX!==undefined && !e.target && !e.task && !e.followId){
    let atGoal = Math.round(e.x)===e.moveGoalX && Math.round(e.y)===e.moveGoalY;
    if(atGoal){
      e.moveGoalX=undefined;e.moveGoalY=undefined;
    } else if(tick-(e.lastRepathTick||0)>=10){
      e.lastRepathTick=tick;
      let goalX=e.moveGoalX, goalY=e.moveGoalY;
      pathUnitTo(e,goalX,goalY);
      if(e.path.length===0){
        // No progress possible from here; stop retrying every frame.
        e.moveGoalX=undefined;e.moveGoalY=undefined;
      }
    }
  }

  // Ranged units: halt walking path as soon as we step within firing range of our combat target
  if(e.target && !e.task){
    let t=entities.find(en=>en.id===e.target);
    if(t && t.hp>0){
      let range = UNITS[e.utype]?.range || 0;
      if(range > 0 && dist(e,t) <= range){
        clearUnitPath(e);
      }
    }
  }

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
    // e.speed * 1.43 screen pixels per frame is the baseline movement speed
    let speedInPixels = e.speed * 1.43;
    e.moveT += speedInPixels;

    while(e.path.length>0){
      let nextTile = e.path[0];
      let p1 = toIso(e.fromX, e.fromY);
      let p2 = toIso(nextTile.x, nextTile.y);
      let dx = p2.ix - p1.ix;
      let dy = p2.iy - p1.iy;
      let screenDist = Math.sqrt(dx*dx + dy*dy) || 1.0;

      if(e.moveT>=screenDist){
        if (typeof walkable === 'function' && !walkable(nextTile.x, nextTile.y, e.id)) {
          e.path = [];
          e.moveT = 0;
          break;
        }
        e.moveT-=screenDist;
        let next=e.path.shift();
        e.fromX=next.x;e.fromY=next.y;
        e.x=next.x;e.y=next.y;
      } else {
        break;
      }
    }
    if(e.path.length>0){
      let next=e.path[0];
      if (typeof walkable === 'function' && !walkable(next.x, next.y, e.id)) {
        e.path = [];
        e.moveT = 0;
      } else {
        let p1 = toIso(e.fromX, e.fromY);
        let p2 = toIso(next.x, next.y);
        let dx = p2.ix - p1.ix;
        let dy = p2.iy - p1.iy;
        let screenDist = Math.sqrt(dx*dx + dy*dy) || 1.0;
        let t = e.moveT / screenDist;
        e.x=e.fromX+(next.x-e.fromX)*t;
        e.y=e.fromY+(next.y-e.fromY)*t;
      }
    }
    return;
  }

  if(e.target){
    let t=entities.find(en=>en.id===e.target);
    if(!t||t.hp<=0){e.target=null;return;}
    let d=dist(e,t);
    let range = UNITS[e.utype]?.range || 0;

    if (range > 0) {
      // Ranged combat: stay within range and fire projectiles
      if (d > range) {
        pathUnitTo(e, Math.round(t.x), Math.round(t.y));
        if (e.path.length === 0) e.target = null;
      } else {
        clearUnitPath(e);
        if (e.atkCooldown <= 0) {
          spawnProjectile(e, t);
          e.atkCooldown = 45; // Archer fires every 1.5s
        }
      }
    } else {
      // Melee combat
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
        if(d>1.5){
          pathUnitTo(e,Math.round(t.x),Math.round(t.y));
          if(e.path.length===0)e.target=null;
        } else if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=30;
        }
      }
    }
    return;
  }

  if(e.utype==='villager'&&e.task){
    if(e.task==='build'&&e.buildTarget){
      let bt=entities.find(en=>en.id===e.buildTarget);
      if(!bt||(bt.complete && bt.hp >= bt.maxHp)){
        if(!checkNextBuild(e)){
          e.task=null;
          e.buildTarget=null;
          if(bt) autoTaskBuilder(e, bt);
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
        if (!bt.complete) {
          bt.buildProgress++;
          if (tick % 30 === 0 && e.team === 0 && window.playSound) {
            window.playSound('build');
          }
          if(bt.buildProgress>=bt.buildTime){
            bt.complete=true;
            e.buildTarget=null;
            if (e.team === 0 && window.playSound) {
              window.playSound('train'); // play herald fanfare on building completed
            }
            if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);
            
            // Auto-task villager after construction is finished (if no other buildings in queue)
            if(!checkNextBuild(e)){
              autoTaskBuilder(e, bt);
            }
          }
        } else {
          // Repair completed but damaged building
          bt.repairCounter = (bt.repairCounter || 0) + 1;
          if (bt.repairCounter >= 3) {
            bt.repairCounter = 0;

            let bData = BLDGS[bt.btype];
            let bCost = (bData && bData.cost) || {};
            let costFraction = 0.5 / bt.maxHp;
            let woodCost = (bCost.w || 0) * costFraction;
            let stoneCost = (bCost.s || 0) * costFraction;

            bt.woodDebt = (bt.woodDebt || 0) + woodCost;
            bt.stoneDebt = (bt.stoneDebt || 0) + stoneCost;

            let wD = Math.floor(bt.woodDebt);
            let sD = Math.floor(bt.stoneDebt);

            let store = resourceStore(e.team);
            let hasWood = store.wood >= wD;
            let hasStone = sD === 0 || (store.stone !== undefined && store.stone >= sD);

            if (hasWood && hasStone) {
              store.wood -= wD;
              if (sD > 0 && store.stone !== undefined) store.stone -= sD;
              bt.woodDebt -= wD;
              bt.stoneDebt -= sD;
              bt.hp = Math.min(bt.maxHp, bt.hp + 1);
            } else {
              if (e.team === 0) {
                showMsg('Not enough resources to repair!');
              }
              e.buildTarget = null;
              e.task = null;
              bt.woodDebt = 0;
              bt.stoneDebt = 0;
              return;
            }
          }
          if (tick % 30 === 0 && e.team === 0 && window.playSound) {
            window.playSound('build');
          }
          if (bt.hp >= bt.maxHp) {
            e.buildTarget = null;
            bt.woodDebt = 0;
            bt.stoneDebt = 0;
            if(e.buildQueue) e.buildQueue = e.buildQueue.filter(id => id !== bt.id);
            if(!checkNextBuild(e)){
              e.task=null;
            }
          }
        }
      }
      return;
    }
    if(e.task==='return'){
      let failedDrops = e.failedDrops || new Set();
      let drop=nearestDrop(e,e.carryType,failedDrops);
      if(!drop){
        e.task=null;
        e.failedDrops=null;
        if(e.team===0)showMsg('Cannot reach drop site!');
        return;
      }
      if(!adjToBuilding(e.x,e.y,drop)){
        let pt=nearestBldgPerimeter(e.x,e.y,drop);
        pathUnitTo(e,pt.x,pt.y);
        if(e.path.length===0){
          failedDrops.add(drop.id);
          e.failedDrops = failedDrops;

          let foundPath = false;
          while (true) {
            let nextDrop = nearestDrop(e, e.carryType, failedDrops);
            if (!nextDrop) break;

            let nextPt = nearestBldgPerimeter(e.x, e.y, nextDrop);
            pathUnitTo(e, nextPt.x, nextPt.y);
            if (e.path.length > 0) {
              foundPath = true;
              break;
            }
            failedDrops.add(nextDrop.id);
          }

          if (foundPath) return;

          e.task=null;
          e.failedDrops=null;
          if(e.team===0)showMsg('Cannot reach drop site!');
        }
      } else {
        if(e.team===0)res[e.carryType]+=e.carrying;
        else aiRes[e.carryType]+=e.carrying;
        e.carrying=0;
        e.failedDrops=null;
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
  // Auto-attack: idle military units engage nearby enemies (always enabled for military, disabled for villagers)
  let isMilitary = e.utype !== 'villager' && e.utype !== 'sheep';
  // Note: followId isn't excluded here — a unit that has caught up to its
  // follow target and stopped (path empty) should still engage nearby
  // enemies like any idle unit; combat naturally takes precedence and the
  // follow order resumes once the fight ends (followId itself isn't touched
  // by combat, only the per-leg pathing is).
  if(isMilitary && !e.target && e.path.length===0 && !e.task){
    let scanRange=6;
    let closest=null, closestD=scanRange+1;
    entities.forEach(en=>{
      if(en.team!==e.team&&en.type==='unit'&&en.hp>0&&en.utype!=='sheep'){
        let ey=Math.round(en.y),ex=Math.round(en.x);
        if(e.team===0&&(ey<0||ey>=MAP||ex<0||ex>=MAP||fog[ey][ex]!==2))return;
        let d=dist(e,en);
        if(d<closestD){closestD=d;closest=en;}
      }
    });
    if(closest) e.target=closest.id;
  }
}

function findNearTile(e,terrain,excludeSet=null){
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
        if(excludeSet && excludeSet.has(nx+ny*MAP))continue;
        if(!canGatherTile(e,terrain,nx,ny))continue;
        if(claimed.has(nx+ny*MAP))continue; // skip claimed tiles
        let d=Math.abs(dx)+Math.abs(dy);
        if(d<bd){bd=d;best={x:nx,y:ny};}
      }
    }
    if(best)return best;
  }
  // If all tiles are claimed, fall back to any available tile (excluding completely blocked ones)
  for(let r=0;r<12;r++){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let nx=bx+dx,ny=by+dy;
      if(nx>=0&&nx<MAP&&ny>=0&&ny<MAP&&map[ny][nx].t===terrain&&map[ny][nx].res>0){
        if(excludeSet && excludeSet.has(nx+ny*MAP))continue;
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
    for(let dy=0;dy<e.h;dy++)for(let dx=0;dx<e.w;dx++){
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
  entitiesById.delete(e.id);
}

function findSpawnTile(x,y,maxRadius=4){
  for(let r=0;r<maxRadius;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(walkable(x+dx,y+dy))return{x:x+dx,y:y+dy};
  }
  return null;
}

function updateBuilding(e){
  if(!e.complete)return;

  // Tower / TC arrow fire (defensive structures auto-fire)
  if (e.btype === 'TOWER' || e.btype === 'TC') {
    e.atkCooldown = Math.max(0, (e.atkCooldown || 0) - 1);
    if (e.atkCooldown <= 0) {
      let range = e.btype === 'TC' ? 6 : 5;
      let target = entities.filter(en => en.team !== e.team && en.type === 'unit' && en.hp > 0 && en.utype !== 'sheep')
                           .filter(en => dist({x: e.x + e.w/2, y: e.y + e.h/2}, en) <= range)
                           .sort((a,b) => dist({x: e.x + e.w/2, y: e.y + e.h/2}, a) - dist({x: e.x + e.w/2, y: e.y + e.h/2}, b))[0];
      if (target) {
        let bCenter = {
          id: e.id,
          type: 'building',
          btype: e.btype,
          x: e.x + e.w/2,
          y: e.y + e.h/2,
          team: e.team,
          atk: e.btype === 'TC' ? 5 : 6 // TC deals 5, Tower deals 6
        };
        spawnProjectile(bCenter, target);
        e.atkCooldown = 40; // fire every 1.3s
      }
    }
  }

  if(e.queue.length>0){
    let u=UNITS[e.queue[0]];
    if(e.trainTick<u.trainTime)e.trainTick++;
    if(e.trainTick>=u.trainTime){
      if(!hasPopulationRoom(e.team,e.queue[0],false))return;
      let b=BLDGS[e.btype];
      let spawn=findSpawnTile(e.x+e.w,e.y+e.h) || findSpawnTile(e.x,e.y);
      if(!spawn)return;
      e.trainTick=0;
      let ut=e.queue.shift();
      let unit=createUnit(ut,spawn.x,spawn.y,e.team);
      
      // Play training complete fanfare sound (player team 0)
      if (e.team === 0 && window.playSound) {
        window.playSound('train');
      }
      
      // Auto-command the unit based on building's rally point
      if(unit && e.team===0 && e.rallyX!==undefined && e.rallyY!==undefined){
        if(e.rallyTargetId){
          let target=entities.find(en=>en.id===e.rallyTargetId);
          if(target){
            if(unit.utype==='villager'&&target.type==='building'&&!target.complete&&target.team===0){
              unit.task='build';
              unit.buildTarget=target.id;
              pathUnitTo(unit,target.x,target.y);
            } else if(target.team===1 || (target.team===0 && target.utype==='sheep' && unit.utype==='villager')){
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
