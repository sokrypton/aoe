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
      // Only GATE and TOWER may be placed on top of an existing allied
      // WALL (they consume the wall tile(s) they're built on, see
      // doPlace's wallsToRemove); anything else, including another WALL,
      // must not overlap an existing building.
      if ((type === 'GATE' || type === 'TOWER') && existing && existing.type === 'building' && existing.btype === 'WALL' && existing.team === team) {
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
// cooldown is ticks (30/game-second) per 1 resource gathered, tuned to AoE2
// base gather rates: wood ~0.39/s, gold ~0.38/s, stone ~0.36/s, farm ~0.32/s,
// forage ~0.31/s.
const GATHER_TASKS={
  chop:{terrain:TERRAIN.FOREST,resource:'wood',cooldown:77,clearOccupied:true},
  mine_gold:{terrain:TERRAIN.GOLD,resource:'gold',cooldown:79},
  mine_stone:{terrain:TERRAIN.STONE,resource:'stone',cooldown:83},
  farm:{terrain:TERRAIN.FARM,resource:'food',cooldown:94,clearOccupied:true,removeFarm:true,requiresOwnCompleteFarm:true},
  forage:{terrain:TERRAIN.BERRIES,resource:'food',cooldown:97}
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
  return (type==='sheep'||type==='bear')?0:1;
}

function teamPopUsed(team){
  return entities.filter(e=>e.type==='unit'&&e.team===team&&unitPop(e.utype)>0).length;
}

function buildingPop(e,includeIncomplete){
  if(e.type!=='building')return 0;
  if(!includeIncomplete&&!e.complete)return 0;
  // House rule: 10 pop (AoE2 gives 5, less than a house — feels wrong here).
  if(e.btype==='TC')return 10;
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

function distToTarget(a,b){
  if(b && b.type==='building'){
    // A w-wide building occupies tile centers [x .. x+w-1], so its
    // geometric footprint spans [x-0.5, x+w-0.5]. Measuring against
    // [x, x+w] (as before) overhangs the far sides by a full tile.
    let dx=Math.max(b.x-0.5-a.x, 0, a.x-(b.x+b.w-0.5));
    let dy=Math.max(b.y-0.5-a.y, 0, a.y-(b.y+b.h-0.5));
    return Math.sqrt(dx*dx+dy*dy);
  }
  return dist(a,b);
}

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

// Check if unit is adjacent to a building (within 1.5 tiles of its nearest edge).
// Uses the same nearest-edge distance as distToTarget() — a prior per-perimeter-tile
// box test (|dx|<1.2 && |dy|<1.2) let units register as "adjacent" from up to
// ~1.7 tiles past the nearest edge near corners, well beyond intended melee reach.
function adjToBuilding(px,py,bldg){
  // Tile-accurate footprint (see distToTarget). Perimeter tile centers sit
  // 0.5 (orthogonal) to ~0.71 (diagonal corner) from this rect, so 1.2
  // accepts every true perimeter tile while rejecting the next ring out —
  // previously the inflated rect + 1.5 let melee hit from ~2 tiles away.
  let dx=Math.max(bldg.x-0.5-px, 0, px-(bldg.x+bldg.w-0.5));
  let dy=Math.max(bldg.y-0.5-py, 0, py-(bldg.y+bldg.h-0.5));
  return Math.sqrt(dx*dx+dy*dy) <= 1.2;
}

// Find nearest walkable tile adjacent to building perimeter
function nearestBldgPerimeter(px,py,bldg,ignore){
  let best=null,bd=999;
  for(let dy=-1;dy<=bldg.h;dy++)for(let dx=-1;dx<=bldg.w;dx++){
    if(dx>=0&&dx<bldg.w&&dy>=0&&dy<bldg.h)continue;
    let tx=bldg.x+dx, ty=bldg.y+dy;
    if(tx>=0&&tx<MAP&&ty>=0&&ty<MAP&&walkable(tx,ty,ignore)){
      let d=Math.abs(px-tx)+Math.abs(py-ty);
      if(d<bd){bd=d;best={x:tx,y:ty};}
    }
  }
  return best||{x:Math.min(bldg.x+bldg.w,MAP-1),y:Math.min(bldg.y+bldg.h,MAP-1)};
}


// AoE2-style siege spread: each melee attacker of a building claims its own
// perimeter tile, so a group fans out and surrounds the building instead of
// stacking up behind whichever tile happens to be nearest.
function siegePerimeterSpot(e,t){
  let claimed=new Set();
  entities.forEach(en=>{
    if(en!==e&&en.type==='unit'&&en.target===t.id&&en.siegeSpot){
      claimed.add(en.siegeSpot.x+','+en.siegeSpot.y);
    }
  });
  let best=null,bd=1e9;
  for(let dy=-1;dy<=t.h;dy++)for(let dx=-1;dx<=t.w;dx++){
    if(dx>=0&&dx<t.w&&dy>=0&&dy<t.h)continue;
    let tx=t.x+dx, ty=t.y+dy;
    if(tx<0||tx>=MAP||ty<0||ty>=MAP)continue;
    if(!walkable(tx,ty,e.id))continue;
    let d=Math.abs(e.x-tx)+Math.abs(e.y-ty);
    if(claimed.has(tx+','+ty))d+=100; // strongly prefer an unclaimed spot
    if(d<bd){bd=d;best={x:tx,y:ty};}
  }
  if(best){e.siegeSpot=best;return best;}
  return nearestBldgPerimeter(e.x,e.y,t,e.id);
}

// AoE2 DE-style group spread: when several villagers are tasked onto one
// resource tile, each claims its own tile of the same resource near the
// click instead of the whole group piling onto one tree. Rings expand from
// the clicked tile; within a ring the villager takes the tile closest to
// itself. If everything nearby is claimed, crowding the clicked tile is the
// correct fallback (AoE2 also lets villagers share a tile when it's all
// that's left).
function claimGatherTileNear(e,terrain,cx,cy){
  let claimed=new Set();
  entities.forEach(en=>{
    if(en.type==='unit'&&en.id!==e.id&&en.team===e.team&&en.gatherX>=0)
      claimed.add(en.gatherX+','+en.gatherY);
  });
  if(!claimed.has(cx+','+cy))return{x:cx,y:cy};
  for(let r=1;r<=5;r++){
    let best=null,bd=1e9;
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue; // ring only
      let nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=MAP||ny<0||ny>=MAP)continue;
      let t=map[ny][nx];
      if(t.t!==terrain||t.res<=0)continue;
      if(claimed.has(nx+','+ny))continue;
      if(!canGatherTile(e,terrain,nx,ny))continue;
      let d=Math.abs(e.x-nx)+Math.abs(e.y-ny);
      if(d<bd){bd=d;best={x:nx,y:ny};}
    }
    if(best)return best;
  }
  return{x:cx,y:cy};
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
  if(config.removeFarm){
    let farm=entities.find(f=>f.type==='building'&&f.btype==='FARM'&&f.x===pos.x&&f.y===pos.y);
    if(farm){
      let store = resourceStore(farm.team);
      if (store && store.prepaidFarms > 0) {
        store.prepaidFarms--;
        tile.res = BLDGS.FARM.food;
        farm.hp = farm.maxHp;
        if (farm.team === 0) showMsg("Farm auto-reseeded! (Prepaid remaining: " + store.prepaidFarms + ")");
        return;
      } else {
        farm.exhausted = true;
        farm.complete = false;
        farm.buildProgress = 0;
        tile.res = 0;
        return;
      }
    }
  }
  tile.t=TERRAIN.GRASS;
  if(config.clearOccupied)tile.occupied=null;
}

function updateGatherTask(e,config){
  let gatherTile = rememberedGatherTile(e, config.terrain);
  if(!gatherTile){
    gatherTile = findNearTile(e, config.terrain);
  }

  if(!gatherTile){
    clearGatherTarget(e);
    // Deposit whatever is already carried instead of idling with a partial
    // load in hand; with nothing carried, just go idle.
    e.prevTask=null;
    e.task = e.carrying>0 ? 'return' : null;
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
        e.prevTask=null;
        e.task = e.carrying>0 ? 'return' : null;
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
  if(config.resource==='food') e.foodSrc = e.task==='farm' ? 'wheat' : 'berries';
  e.gatherCooldown=config.cooldown;

  // Gathering audio: positional, so it's heard when the view is near the
  // work — including enemy villagers when you scout their base.
  if (window.playSound) {
    let sType = e.task;
    if (sType === 'mine_gold' || sType === 'mine_stone') sType = 'mine';
    window.playSound(sType, gatherTile.x + 0.5, gatherTile.y + 0.5);
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
    let pt = b.isFarm ? {x: bt.x, y: bt.y} : nearestBldgPerimeter(e.x, e.y, bt, e.id);
    pathUnitTo(e, pt.x, pt.y);
    return true;
  }
  
  e.buildQueue = [];
  return false;
}

function damageEntity(attacker, target){
  let dmg = attacker.atk || 0;
  // The max(1, ...) armor floor below would turn a 0-attack "hit" (sheep,
  // carcasses) into 1 real damage — no attack stat means no damage at all.
  if (dmg <= 0) return;
  // AoE2 attack bonuses. The other classic counters need no bonus — they
  // emerge from the armor system: scouts beat archers because their 2 pierce
  // armor halves arrow damage, and militia beat spearmen on raw stats.
  if (attacker.utype === 'spearman' && target.utype === 'scout') dmg += 15; // AoE2 spearman +15 vs cavalry
  if (attacker.utype === 'archer' && target.utype === 'spearman') dmg += 3; // AoE2 archer +3 vs spearman
  // Bonuses vs buildings (AoE2 building-class bonuses): without siege units,
  // these are what let a Dark Age army crack structures at all now that
  // buildings have real armor.
  if (target.type === 'building') {
    if (attacker.utype === 'villager') dmg += 3;
    if (attacker.utype === 'militia') dmg += 2;
  }

  // AoE2 armor: damage = max(1, attack - armor). Ranged units and building
  // arrows deal pierce damage; everything else is melee. High building pierce
  // armor is what makes arrows nearly useless against structures.
  let isPierce = (attacker.range || 0) > 0 || attacker.type === 'building';
  let armor = target.type === 'unit'
    ? (UNITS[target.utype].armor || {m:0,p:0})
    : (BLDGS[target.btype].armor || {m:0,p:0});
  dmg = Math.max(1, dmg - (isPierce ? armor.p : armor.m));

  target.hp -= dmg;

  // Play combat sound and spawn particles
  if (target.type === 'unit') {
    if (window.playSound) window.playSound('attack', target.x, target.y);
    spawnParticles(target.x, target.y, '#990000', 4, 0.04, 1.5);
  } else {
    if (window.playSound) window.playSound('build', target.x + (target.w||1)/2, target.y + (target.h||1)/2);
    spawnParticles(target.x + (target.w||1)/2, target.y + (target.h||1)/2, '#8b6c43', 3, 0.03, 2);
  }

  // Minimap raid alert: attacked player objects blink white for a moment
  // (drawMinimap reads this), AoE2-style.
  if (target.team === 0) target.lastHitTick = tick;

  // Feed the adaptive music: actual damage is the strongest mood signal —
  // it catches open-field battles that building-proximity checks miss.
  if (attacker.team === 1 && target.team === 0) window.lastDangerTick = tick;
  else if (attacker.team === 0 && target.team === 1) window.lastWarTick = tick;

  // Under attack alarm (player team 0): the horn announces a NEW attack, not
  // an ongoing one — the danger music carries the battle. It only re-arms
  // after ~20s without taking any hits.
  if (target.team === 0 && attacker.team === 1) {
    let lastHit = window.lastUnderAttackTick;
    window.lastUnderAttackTick = tick;
    if (lastHit === undefined || tick - lastHit > 600) {
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
  // For a villager, walking is usually TASK-walking (to the tree, to the
  // drop-off) — that must not exempt it from defending itself, or gatherers
  // get stabbed mid-commute without reacting. Only an explicit player move
  // order (moveGoalX, set solely by issueMoveOrder) keeps a villager walking.
  let hasActiveMoveOrder = target.type==='unit' && (
    target.utype==='villager'
      ? target.moveGoalX!==undefined
      : (target.path.length>0 || target.moveGoalX!==undefined));
  // AoE2: villagers fight back against melee attackers but don't chase
  // ranged ones (hopeless kiting) or buildings (tower/TC fire).
  let hopelessChase = target.utype==='villager' &&
    ((attacker.range||0)>0 || attacker.type==='building');
  if(target.type==='unit'&&target.utype!=='sheep'&&target.utype!=='sheep_carcass'&&attacker.team!==target.team&&!hasActiveMoveOrder&&!hopelessChase){
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
      // Save task details so they can resume after defending themselves
      if (target.utype === 'villager' && target.task && !target.savedTask) {
        target.savedTask = {
          task: target.task,
          gatherX: target.gatherX,
          gatherY: target.gatherY,
          buildTarget: target.buildTarget,
          buildQueue: target.buildQueue ? [...target.buildQueue] : [],
          prevTask: target.prevTask
        };
      }
      target.target = attacker.id;
      target.task = null; // drop gathering/farming/building tasks
      clearUnitPath(target);
    }
  }
  
  // Defend sieged buildings: when a building is hit, nearby idle military
  // (not passive, no current fight) converge on the attacker — matching how
  // units already retaliate when hit themselves.
  if(target.type==='building'&&attacker.team!==target.team){
    entities.forEach(en=>{
      if(en.type!=='unit'||en.team!==target.team)return;
      if(en.utype==='villager'||en.utype==='sheep'||en.utype==='sheep_carcass')return;
      if(en.target||en.task||en.stance==='passive')return;
      if(en.path.length>0||en.moveGoalX!==undefined)return; // obeying a move order
      if(distToTarget(en,target)>8)return;
      en.target=attacker.id;
    });
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

function restoreSavedTask(e) {
  if (e.utype === 'villager' && e.savedTask) {
    e.task = e.savedTask.task;
    e.gatherX = e.savedTask.gatherX;
    e.gatherY = e.savedTask.gatherY;
    e.buildTarget = e.savedTask.buildTarget;
    e.buildQueue = e.savedTask.buildQueue;
    e.prevTask = e.savedTask.prevTask;
    e.savedTask = null;
    
    // Re-path them to their task!
    if (e.task === 'build' && e.buildTarget) {
      let bt = entities.find(en => en.id === e.buildTarget);
      if (bt) {
        let b = BLDGS[bt.btype];
        let pt = b.isFarm ? {x: bt.x, y: bt.y} : (typeof nearestBldgPerimeter === 'function' ? nearestBldgPerimeter(e.x, e.y, bt, e.id) : {x: bt.x + bt.w, y: bt.y + bt.h});
        if (pt) pathUnitTo(e, pt.x, pt.y);
      }
    } else if (e.gatherX !== undefined && e.gatherX >= 0) {
      pathUnitTo(e, e.gatherX, e.gatherY);
    }
  }
}

// ---- GARRISON (AoE2-style town bell & building garrison) ----
function garrisonCap(b){return (b.btype&&BLDGS[b.btype].garrisonCap)||0;}
function garrisonCount(b){return b.garrison?b.garrison.length:0;}
function canGarrisonIn(b,team){
  return b.type==='building'&&b.team===team&&b.complete&&b.hp>0&&garrisonCap(b)>0;
}
function enterGarrison(e,b){
  b.garrison=b.garrison||[];
  if(b.garrison.length>=garrisonCap(b))return false;
  clearUnitPath(e);
  e.task=null;e.target=null;e.followId=undefined;e.garrisonTarget=null;
  e.garrisonedIn=b.id;
  // Park the unit at the building's center so fog/minimap stay sane while hidden.
  e.x=b.x+b.w/2;e.y=b.y+b.h/2;e.fromX=e.x;e.fromY=e.y;
  b.garrison.push(e.id);
  // If the entering unit was selected, hand the selection to the building
  // (once its last selected unit steps inside) so the garrison grid shows up.
  if(selected.some(s=>s.id===e.id)){
    selected=selected.filter(s=>s.id!==e.id);
    if(selected.length===0)selected=[b];
  }
  return true;
}
// Eject garrisoned units to open tiles around the building. Optional filter
// (e.g. villagers only for "all clear"); returns how many were ejected.
function ejectGarrison(b,filter){
  if(!b.garrison||b.garrison.length===0)return 0;
  let keep=[],out=0;
  b.garrison.forEach(id=>{
    let u=entitiesById.get(id);
    if(!u){return;}
    if(filter&&!filter(u)){keep.push(id);return;}
    let spawn=findSpawnTile(b.x+b.w,b.y+b.h,8)||findSpawnTile(b.x-1,b.y-1,8);
    u.garrisonedIn=undefined;
    if(spawn){u.x=spawn.x+0.5;u.y=spawn.y+0.5;}
    u.fromX=u.x;u.fromY=u.y;
    clearUnitPath(u);
    out++;
    // Villagers with a savedTask auto-resume via restoreSavedTask in updateUnit.
  });
  b.garrison=keep;
  return out;
}
// team defaults to 0 (player) for every existing UI call site. The AI (team
// 1) reuses the exact same mechanic for its own defense — see
// updateAIGarrisonReaction() in ai.js — but never touches the player's HUD
// (bell icon state, messages, sound), which stays keyed to team 0 only.
function ringTownBell(team){
  team=team===undefined?0:team;
  if(team===0)window.bellActive=true;
  // Reserve slots so villagers spread across TC/towers instead of all
  // targeting one full building.
  let spots=entities.filter(en=>canGarrisonIn(en,team))
    .map(b=>({b,room:garrisonCap(b)-garrisonCount(b)}));
  let sent=0;
  entities.forEach(e=>{
    if(e.team!==team||e.type!=='unit'||e.utype!=='villager'||e.garrisonedIn)return;
    if(e.task==='garrison')return;
    let best=null,bd=Infinity;
    spots.forEach(s=>{
      if(s.room<=0)return;
      let d=distToBuilding(e.x,e.y,s.b);
      if(d<bd){bd=d;best=s;}
    });
    if(!best)return;
    best.room--;
    if(!e.savedTask&&(e.task||e.buildTarget||e.gatherX>=0)){
      e.savedTask={task:e.task,gatherX:e.gatherX,gatherY:e.gatherY,
        buildTarget:e.buildTarget,buildQueue:e.buildQueue,prevTask:e.prevTask};
    }
    e.target=null;e.followId=undefined;e.buildTarget=null;
    e.task='garrison';e.garrisonTarget=best.b.id;
    let pt=nearestBldgPerimeter(e.x,e.y,best.b,e.id);
    if(pt)pathUnitTo(e,pt.x,pt.y);
    sent++;
  });
  if(team===0){
    if(window.playSound)window.playSound('bell');
    showMsg(sent>0?'Town bell! Villagers run for cover':'Town bell! No garrison space for villagers');
    if(typeof updateUI==='function')updateUI();
  }
  return sent;
}
function soundAllClear(team){
  team=team===undefined?0:team;
  if(team===0)window.bellActive=false;
  // Release villagers from every garrison (military stays put — use the
  // building's Ungarrison button for them) and cancel villagers still en route.
  entities.forEach(en=>{
    if(en.type==='building'&&en.team===team)ejectGarrison(en,u=>u.utype==='villager');
  });
  entities.forEach(e=>{
    if(e.team===team&&e.type==='unit'&&e.task==='garrison'){
      e.task=null;e.garrisonTarget=null;clearUnitPath(e);
    }
  });
  if(team===0){
    if(window.playSound)window.playSound('bell_clear');
    showMsg('All clear! Villagers return to work');
    if(typeof updateUI==='function')updateUI();
  }
}

function updateUnit(e){
  if(e.hp<=0)return;
  if(e.garrisonedIn)return; // inside a building: no movement, tasks, or combat
  // Targets that garrisoned mid-fight become unattackable — drop them.
  if(e.target){
    let t=entitiesById.get(e.target);
    if(t&&t.garrisonedIn)e.target=null;
  }
  if(e.utype==='villager' && !e.target && e.savedTask && e.task!=='garrison'){
    restoreSavedTask(e);
  }
  // Walking toward a building to garrison inside it
  if(e.task==='garrison'){
    let b=e.garrisonTarget?entitiesById.get(e.garrisonTarget):null;
    if(!b||b.hp<=0||!b.complete||garrisonCount(b)>=garrisonCap(b)){
      e.task=null;e.garrisonTarget=null; // savedTask (if any) resumes next tick
    } else if((()=>{
      // Arrival check: like adjToBuilding but accepts diagonal corner
      // perimeter tiles (~1.41 from the footprint), which nearestBldgPerimeter
      // legitimately routes units to.
      let gdx=Math.max(b.x-0.5-e.x,0,e.x-(b.x+b.w-0.5));
      let gdy=Math.max(b.y-0.5-e.y,0,e.y-(b.y+b.h-0.5));
      return Math.sqrt(gdx*gdx+gdy*gdy)<=1.45;
    })()){
      enterGarrison(e,b);
      return;
    } else if(e.path.length===0&&tick-(e.lastRepathTick||0)>=10){
      e.lastRepathTick=tick;
      let pt=nearestBldgPerimeter(e.x,e.y,b,e.id);
      if(pt)pathUnitTo(e,pt.x,pt.y);
      if(e.path.length===0){
        // Entrance likely crowded with other garrisoning villagers — keep
        // trying a few rounds before abandoning shelter.
        e.garrisonRetries=(e.garrisonRetries||0)+1;
        if(e.garrisonRetries>=6){e.garrisonRetries=0;e.task=null;e.garrisonTarget=null;}
      } else {
        e.garrisonRetries=0;
      }
    }
  }
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

  // Melee & Ranged units: halt walking path as soon as we step within attack range of our target,
  // or periodically re-path if the moving target has shifted away from our current path's endpoint.
  if(e.target && !e.task){
    let t=entities.find(en=>en.id===e.target);
    if(t && t.hp>0){
      let range = UNITS[e.utype]?.range || 0;
      // Sheep (live or carcass): 0.9 so villagers ring it — requiring exact
      // contact (0.2) made every villager after the first "unreachable" once
      // the tile was collision-claimed, and they dropped the order and idled.
      let maxDist = range > 0 ? range :
        (e.utype==='villager' && (t.utype==='sheep' || t.utype==='sheep_carcass')) ? 0.9 : 1.5;
      
      let inRange = false;
      if (range > 0) {
        inRange = distToTarget(e, t) <= maxDist;
      } else {
        if (t.type === 'building') {
          inRange = adjToBuilding(e.x, e.y, t);
        } else {
          inRange = distToTarget(e, t) <= maxDist;
        }
      }

      if(inRange){
        clearUnitPath(e);
      } else if(t.type==='unit' && tick % 15 === 0 && e.path.length > 0){
        let endTile = e.path[e.path.length - 1];
        let dToDest = Math.sqrt((endTile.x - t.x)**2 + (endTile.y - t.y)**2);
        if(dToDest > 1.5){
          pathUnitTo(e, Math.round(t.x), Math.round(t.y));
        }
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

    // Convert/steal sheep (AoE2-style): if an opposing team's unit gets within 5 tiles
    // and no friendly unit (except other sheep) is closer to guard them, they convert!
    let closest=null, cd=5;
    entities.forEach(en=>{
      if(en.type==='unit'&&en.utype!=='sheep'&&(en.team===0||en.team===1)){
        let d=dist(e,en);
        if(d<cd){cd=d;closest=en;}
      }
    });
    if(closest && closest.team !== e.team){
      let guarded = false;
      if (e.team === 0 || e.team === 1) {
        let guardDist = cd;
        entities.forEach(en=>{
          if(en.type==='unit'&&en.utype!=='sheep'&&en.team===e.team){
            let d=dist(e,en);
            if(d<guardDist){guarded=true;}
          }
        });
      }
      if(!guarded){
        e.team=closest.team;
        clearUnitPath(e);
      }
    }
  }

  // Bear behavior (AoE2 wolf logic): a leashed ambush predator, NOT generic
  // military AI — it has its own aggro/give-up rules instead of the
  // isMilitary auto-attack below (which never stops chasing).
  if(e.utype==='bear'){
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
      }
    } else {
      // Aggro: charge the closest player/AI unit that wanders into range.
      // Sheep are ignored (AoE2 wolves don't hunt herdables) and the check
      // runs on a stagger so 5 bears don't all scan every tick.
      if(tick%10===e.id%10){
        let closest=null,cd=5.5;
        entities.forEach(en=>{
          if(en.type!=='unit'||en.hp<=0||en.garrisonedIn)return;
          if(en.team!==0&&en.team!==1)return;
          if(en.utype==='sheep'||en.utype==='sheep_carcass')return;
          let d=dist(e,en);
          if(d<cd){cd=d;closest=en;}
        });
        if(closest){
          e.target=closest.id;
          clearUnitPath(e);
          if(window.playSound)window.playSound('bear',e.x,e.y);
        }
      }
      // Idle: slow wander around the den, like the sheep but ranging wider
      // and always drifting back toward home.
      if(!e.target&&e.path.length===0&&tick%150===0&&Math.random()<0.3){
        let wx=Math.round(home.x)+randInt(-3,3);
        let wy=Math.round(home.y)+randInt(-3,3);
        if(wx>=0&&wx<MAP&&wy>=0&&wy<MAP&&walkable(wx,wy)){
          pathUnitTo(e,wx,wy);
        }
      }
    }
  }

  if(e.path.length>0){
    // e.speed is tiles per game-second (AoE2 stat). One orthogonal tile step
    // covers sqrt(32^2+16^2) ≈ 35.78 screen px, and there are 30 ticks per
    // game-second, so px-per-tick = speed * 35.78/30 ≈ speed * 1.19.
    let speedInPixels = e.speed * 1.19;
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

  if(e.target && e.task !== 'return'){
    let t=entities.find(en=>en.id===e.target);
    if(!t||t.hp<=0){
      e.target=null;
      e.explicitAttack=false;
      return;
    }

    // Fog of War visibility check for combat targets
    if (t.team !== e.team && t.team !== 2) {
      if (e.team === 0) {
        let visible = false;
        if (t.type === 'unit') {
          let tx = Math.round(t.x), ty = Math.round(t.y);
          visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && fog[ty][tx] === 2;
        } else if (t.type === 'building') {
          visible = buildingFogLevel(t) === 2;
        }
        if (!visible) {
          e.target = null;
          e.explicitAttack = false;
          clearUnitPath(e);
          return;
        }
      } else if (e.team === 1 && !e.explicitAttack) {
        // Ordinary AI units drop targets they can no longer see. Explicit
        // marches (controlAIMilitary attacks on the remembered player TC)
        // are exempt — the AI knows where the TC is even out of sight,
        // otherwise the army's attack order is wiped the tick after it's
        // given and it never leaves home.
        let visionRange = 15 * (typeof aiScale === 'function' ? aiScale() : 1.0);
        let visible = entities.some(aiEnt => {
          return aiEnt.team === 1 && dist(aiEnt, t) <= visionRange;
        });
        if (!visible) {
          e.target = null;
          clearUnitPath(e);
          return;
        }
      }
    }

    // Defensive Stance anchor retreat check
    if (e.stance === 'defensive' && e.defendX !== undefined) {
      let dFromAnchor = Math.sqrt((e.x - e.defendX)**2 + (e.y - e.defendY)**2);
      if (dFromAnchor > 6) {
        e.target = null;
        clearUnitPath(e);
        pathUnitTo(e, Math.round(e.defendX), Math.round(e.defendY));
        return;
      }
    }

    if(e.utype==='villager' && t.utype==='sheep_carcass'){
      let d=distToTarget(e,t);
      // Harvest from a ring around the carcass (not stacked on its tile) so
      // several villagers can eat one sheep at once, AoE2-style — the whole
      // starting crew on the first sheep is the classic opening.
      if(d>0.9){
        // Full ring: wait for an eating spot instead of abandoning the sheep
        // (same patience pattern as combatApproach below).
        if(tick-(e.chaseRepathTick||0)>=15){
          e.chaseRepathTick=tick;
          pathUnitTo(e,Math.round(t.x),Math.round(t.y));
          if(e.path.length===0 && d>8)e.target=null;
        }
      } else {
        clearUnitPath(e);
        if(e.carrying>=e.carryMax){
          e.prevTask=null;
          e.task='return';
          return;
        }
        if(e.gatherCooldown<=0){
          t.hp--;
          e.carrying++;
          e.carryType='food';
          e.foodSrc='meat';
          e.gatherCooldown=90; // ~0.33 food/game-second, AoE2 herding rate
          if(window.playSound && tick % 30 === 0) window.playSound('forage', t.x, t.y);
          spawnParticles(t.x, t.y, '#ebdcb8', 2, 0.02, 1.2);
          if(t.hp<=0){
            handleDeath(t, e.team);
            e.target=null;
          }
        }
      }
      return;
    }

    let d=distToTarget(e,t);
    let range = UNITS[e.utype]?.range || 0;

    // Shared approach-with-patience: pathing can fail TRANSIENTLY when the
    // spot around a target is collision-crowded (full melee ring, busy drop
    // site). Old behavior dropped the order on any empty path, leaving units
    // idle next to a fight. Now: retry on a cooldown, hold position while
    // near, and only give up when far away with genuinely no route (walled).
    // Returns false if the caller should stop processing this tick.
    function combatApproach(u,tgt,dist,pathFn){
      // The 15-tick repath cooldown is only meant to throttle re-pathing
      // while a chase is already in motion (avoids every unit re-pathing
      // every single tick). If the unit has actually run out of path and
      // stopped, waiting out the rest of the cooldown just freezes it in
      // place until the cooldown clears, then it snaps onto a fresh path —
      // looks like a stutter/twitch. Repath immediately whenever there's no
      // path left, regardless of cooldown.
      if(u.path.length>0 && tick-(u.chaseRepathTick||0)<15) return false; // waiting for a slot
      u.chaseRepathTick=tick;
      if(pathFn)pathFn();
      else pathUnitTo(u,Math.round(tgt.x),Math.round(tgt.y));
      if(u.path.length===0 && dist>8){u.target=null;return false;} // truly unreachable
      return true;
    }

    if (range > 0) {
      // Ranged combat: stay within range and fire projectiles
      if (d > range) {
        if (e.stance === 'standground' && !e.explicitAttack) {
          e.target = null;
          return;
        }
        if(!combatApproach(e,t,d)) return;
      } else {
        clearUnitPath(e);
        if (e.atkCooldown <= 0) {
          spawnProjectile(e, t);
          e.atkCooldown = UNITS[e.utype].rof; // per-unit reload (archer 2s)
        }
      }
    } else {
      // Melee combat
      if(t.type==='building'){
        // Attack building: path to nearest perimeter tile, attack when adjacent
        if(!adjToBuilding(e.x,e.y,t)){
          if (e.stance === 'standground' && !e.explicitAttack) {
            e.target = null;
            return;
          }
          combatApproach(e,t,d,()=>{let pt=siegePerimeterSpot(e,t);pathUnitTo(e,pt.x,pt.y);});
        } else if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      } else {
        // Attack unit: path close and hit
        let maxD = (e.utype==='villager' && t.utype==='sheep') ? 0.9 : 1.5; // adjacent slaughter, see maxDist above
        if(d>maxD){
          if (e.stance === 'standground' && !e.explicitAttack) {
            e.target = null;
            return;
          }
          if(!combatApproach(e,t,d)) return;
        } else if(e.atkCooldown<=0){
          damageEntity(e,t);
          e.atkCooldown=UNITS[e.utype].rof;
        }
      }
    }
    return;
  }

  if(e.utype==='villager'&&e.task){
    if(e.task==='build'&&e.buildTarget){
      let bt=entities.find(en=>en.id===e.buildTarget);
      if(!bt||(bt.complete && bt.hp >= bt.maxHp && !(bt.btype==='FARM' && bt.exhausted))){
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
          let pt=nearestBldgPerimeter(e.x,e.y,bt,e.id);
          pathUnitTo(e,pt.x,pt.y);
        }
        if(e.path.length===0){
          let checkClose = isFarm ? dist(e,{x:bt.x+0.5,y:bt.y+0.5})<1.2 : adjToBuilding(e.x,e.y,bt);
          if (!checkClose) {
            // Perimeter may just be crowded with other builders — retry a few
            // times before declaring the site unreachable and dropping it.
            e.buildRetries=(e.buildRetries||0)+1;
            if(e.buildRetries<6) return;
            e.buildRetries=0;
            if(e.team===0)showMsg('Building site is unreachable!');
            if(!checkNextBuild(e)){
              e.task=null;
              e.buildTarget=null;
            }
          } else {
            e.buildRetries=0;
          }
        } else {
          e.buildRetries=0;
        }
      } else {
        if (bt.btype === 'FARM' && bt.exhausted) {
          let store = resourceStore(e.team);
          if (store && store.prepaidFarms > 0) {
            store.prepaidFarms--;
            if (e.team === 0) showMsg("Reseed consumed from Mill! (Prepaid remaining: " + store.prepaidFarms + ")");
            bt.exhausted = false;
            bt.complete = true;               // exhaustion had flagged it incomplete;
            bt.buildProgress = bt.buildTime;  // without this, canGatherTile rejects the
            bt.hp = bt.maxHp;                 // farm and the farmer silently goes idle
            let tile = map[bt.y][bt.x];
            tile.t = TERRAIN.FARM;
            tile.res = BLDGS.FARM.food;
            e.task = 'farm';
            e.gatherX = bt.x;
            e.gatherY = bt.y;
            e.buildTarget = null;
            return;
          } else {
            if (store && store.wood >= 60) {
              store.wood -= 60;
              if (e.team === 0) showMsg("Farm reseeded (-60 Wood)");
              bt.exhausted = false;
              bt.complete = true;
              bt.buildProgress = bt.buildTime;
              bt.hp = bt.maxHp;
              let tile = map[bt.y][bt.x];
              tile.t = TERRAIN.FARM;
              tile.res = BLDGS.FARM.food;
              e.task = 'farm';
              e.gatherX = bt.x;
              e.gatherY = bt.y;
              e.buildTarget = null;
              return;
            } else {
              if (e.team === 0) showMsg("Not enough wood to reseed farm!");
              e.task = null;
              e.buildTarget = null;
              clearGatherTarget(e);
              return;
            }
          }
        }
        if (!bt.complete) {
          bt.buildProgress++;
          // HP grows with construction (AoE2): each work tick adds its share
          // of maxHp, so a half-built structure has half its HP. Damage taken
          // during construction persists (the cap only limits, never heals).
          bt.hp=Math.min(bt.maxHp,bt.hp+bt.maxHp/bt.buildTime);
          if (tick % 30 === 0 && window.playSound) {
            window.playSound('build', bt.x + bt.w/2, bt.y + bt.h/2);
          }
          if(bt.buildProgress>=bt.buildTime){
            bt.complete=true;
            bt.hp=Math.min(bt.maxHp,Math.round(bt.hp));
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
          if (tick % 30 === 0 && window.playSound) {
            window.playSound('build', bt.x + bt.w/2, bt.y + bt.h/2);
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
      // Patience gate: when every route was blocked (usually a crowded drop
      // site, not a walled-off one), wait a beat and retry with a full load
      // instead of going idle and silently losing the carried resources.
      if(e.dropWaitTick!==undefined){
        if(tick-e.dropWaitTick<30)return;
        e.dropWaitTick=undefined;
        e.failedDrops=null;
      }
      let failedDrops = e.failedDrops || new Set();
      let drop=nearestDrop(e,e.carryType,failedDrops);
      if(!drop){
        // No drop site exists at all for this resource — genuinely nothing
        // to wait for.
        e.task=null;
        e.failedDrops=null;
        if(e.team===0)showMsg('No drop site for '+e.carryType+'! Build one.');
        return;
      }
      if(!adjToBuilding(e.x,e.y,drop)){
        let pt=nearestBldgPerimeter(e.x,e.y,drop,e.id);
        pathUnitTo(e,pt.x,pt.y);
        if(e.path.length===0){
          failedDrops.add(drop.id);
          e.failedDrops = failedDrops;

          let foundPath = false;
          while (true) {
            let nextDrop = nearestDrop(e, e.carryType, failedDrops);
            if (!nextDrop) break;

            let nextPt = nearestBldgPerimeter(e.x, e.y, nextDrop, e.id);
            pathUnitTo(e, nextPt.x, nextPt.y);
            if (e.path.length > 0) {
              foundPath = true;
              break;
            }
            failedDrops.add(nextDrop.id);
          }

          if (foundPath) return;

          // Every drop site unreachable right now — hold the load and retry
          // shortly (see dropWaitTick gate above) rather than giving up.
          e.dropWaitTick=tick;
        }
      } else {
        if(e.team===0)res[e.carryType]+=e.carrying;
        else aiRes[e.carryType]+=e.carrying;
        e.carrying=0;
        e.failedDrops=null;
        if(e.prevTask){e.task=e.prevTask;e.prevTask=null;}
        else {
          e.task=null;
          // Nothing to resume: release the remembered gather tile so it
          // stops counting as "claimed" for other villagers (findNearTile)
          // and this idle villager isn't exempt from unit separation.
          if(!e.target) clearGatherTarget(e);
        }
      }
      return;
    }
    if(e.carrying>=e.carryMax){
      e.prevTask=e.task;e.task='return';return;
    }
    if(GATHER_TASKS[e.task])updateGatherTask(e,GATHER_TASKS[e.task]);
  }
  // Auto-attack: idle military units engage nearby enemies (always enabled for military, disabled for villagers)
  // Bears are excluded: they use their own leashed aggro logic above, not
  // the never-give-up military chase here.
  let isMilitary = e.utype !== 'villager' && e.utype !== 'sheep' && e.utype !== 'sheep_carcass' && e.utype !== 'bear';
  // Note: followId isn't excluded here — a unit that has caught up to its
  // follow target and stopped (path empty) should still engage nearby
  // enemies like any idle unit; combat naturally takes precedence and the
  // follow order resumes once the fight ends (followId itself isn't touched
  // by combat, only the per-leg pathing is).
  if(isMilitary && !e.target && e.path.length===0 && !e.task){
    e.defendX = e.x;
    e.defendY = e.y;
    if (e.stance !== 'passive') {
      let scanRange = e.stance === 'aggressive' ? 8 : (e.stance === 'standground' ? (e.range > 0 ? e.range : 1.5) : 6);
      let closest=null, closestD=scanRange+0.1;
      entities.forEach(en=>{
        if(en.team!==e.team&&en.type==='unit'&&en.hp>0&&!en.garrisonedIn&&en.utype!=='sheep'&&en.utype!=='sheep_carcass'){
          let ey=Math.round(en.y),ex=Math.round(en.x);
          if(e.team===0&&(ey<0||ey>=MAP||ex<0||ex>=MAP||fog[ey][ex]!==2))return;
          let d=dist(e,en);
          if(d<closestD){closestD=d;closest=en;}
        }
      });
      if(closest) {
        e.target=closest.id;
      }
    }
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
  if(e.type==='unit'&&e.utype==='sheep'){
    e.utype = 'sheep_carcass';
    e.hp = 100;
    e.maxHp = 100;
    e.speed = 0;
    e.team = 2; // neutral resource
    clearUnitPath(e);
    if (window.playSound) window.playSound('sheep', e.x, e.y);
    selected=selected.filter(s=>s.id!==e.id);
    return;
  }
  if(e.type==='building'){
    // Units garrisoned inside a destroyed building perish with it (AoE2 rule)
    if(e.garrison&&e.garrison.length>0){
      let ids=e.garrison.slice();e.garrison=[];
      ids.forEach(id=>{
        let u=entitiesById.get(id);
        if(u){u.garrisonedIn=undefined;u.hp=0;handleDeath(u,killerTeam);}
      });
    }
    let b=BLDGS[e.btype];
    for(let dy=0;dy<e.h;dy++)for(let dx=0;dx<e.w;dx++){
      if(e.y+dy<MAP&&e.x+dx<MAP){map[e.y+dy][e.x+dx].occupied=null;
        if(b.isFarm)map[e.y+dy][e.x+dx].t=TERRAIN.GRASS;}
    }
    if(e.btype==='TC'){
      // Victory condition: the Town Center is the heart of each side — lose
      // it, lose the game. (Full-elimination conquest rules were tried and
      // reverted; teamEliminated() below remains as a fallback for the
      // no-TC-left edge cases.)
      if(e.team===1){gameOver=true;won=true;}
      else{gameOver=true;won=false;}
    }
  }
  // Death blood burst — bigger than the per-hit spatter, marks the kill.
  // Bears get a heavier burst to match their bulk.
  if(e.type==='unit'&&e.utype!=='sheep'&&e.utype!=='sheep_carcass'){
    spawnParticles(e.x,e.y,'#990000',e.utype==='bear'?12:7,0.05,1.8);
  }
  // Add to corpses list for AoE2-style decay (sheep are the exception —
  // they become a harvestable carcass entity instead, handled above)
  if(e.type==='unit'&&e.utype!=='sheep'&&e.utype!=='sheep_carcass'){
    corpses.push({
      type: 'corpse',
      utype: e.utype,
      x: e.x,
      y: e.y,
      team: e.team,
      id: e.id,
      facing: e.facing || 1,
      female: e.female, // villagers keep their hairdo in death
      deathTime: performance.now()
    });
  }
  selected=selected.filter(s=>s.id!==e.id);
  entities=entities.filter(en=>en.id!==e.id);
  entitiesById.delete(e.id);
  // Conquest victory (AoE2): a side is defeated when it has nothing left —
  // no buildings and no units (sheep don't count, they change hands).
  if(e.team===0||e.team===1){
    if(teamEliminated(1)){gameOver=true;won=true;}
    else if(teamEliminated(0)){gameOver=true;won=false;}
  }
}

function teamEliminated(team){
  return !entities.some(en=>en.team===team&&
    (en.type==='building'||(en.type==='unit'&&en.utype!=='sheep'&&en.utype!=='sheep_carcass')));
}

function findSpawnTile(x,y,maxRadius=4){
  for(let r=0;r<maxRadius;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(walkable(x+dx,y+dy))return{x:x+dx,y:y+dy};
  }
  return null;
}

function updateBuilding(e){
  if (e.btype === 'FARM' && e.exhausted) {
    if (e.team === 1) { // AI auto-reseed
      let store = resourceStore(1);
      if (store && store.wood >= 60) {
        store.wood -= 60;
        e.exhausted = false;
        e.complete = true;
        e.hp = e.maxHp;
        let tile = map[e.y][e.x];
        tile.t = TERRAIN.FARM;
        tile.res = BLDGS.FARM.food;
      }
    }
  }

  if(!e.complete)return;

  // Tower / TC arrow fire (defensive structures auto-fire)
  if (e.btype === 'TOWER' || e.btype === 'TC') {
    e.atkCooldown = Math.max(0, (e.atkCooldown || 0) - 1);
    if (e.atkCooldown <= 0) {
      let range = e.btype === 'TC' ? 6 : BLDGS.TOWER.range; // AoE2: TC range 6, Watch Tower 8
      let center = {x: e.x + e.w/2, y: e.y + e.h/2};
      let targets = entities.filter(en => en.team !== e.team && en.type === 'unit' && en.hp > 0 && !en.garrisonedIn && en.utype !== 'sheep' && en.utype !== 'sheep_carcass')
                            .filter(en => dist(center, en) <= range)
                            .sort((a,b) => dist(center, a) - dist(center, b));
      if (targets.length > 0) {
        let bCenter = {
          id: e.id,
          type: 'building',
          btype: e.btype,
          x: center.x,
          y: center.y,
          team: e.team,
          atk: e.btype === 'TC' ? 5 : BLDGS.TOWER.atk // AoE2: both TC and Watch Tower deal 5 pierce
        };
        // AoE2-style: garrisoned units add extra arrows (capped at +5),
        // spread over the closest targets in range.
        let arrows = 1 + Math.min(garrisonCount(e), 5);
        for (let i = 0; i < arrows; i++) {
          spawnProjectile(bCenter, targets[i % targets.length]);
        }
        e.atkCooldown = 60; // fire every 2 game-seconds (AoE2 TC/tower reload)
      }
    }
  }

  // Garrisoned units slowly heal while sheltered
  if (garrisonCount(e) > 0 && tick % 45 === 0) {
    e.garrison.forEach(id => {
      let u = entitiesById.get(id);
      if (u && u.hp > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + 1);
    });
  }

  if(e.queue.length>0){
    let u=UNITS[e.queue[0]];
    if(e.trainTick<u.trainTime)e.trainTick++;
    if(e.trainTick>=u.trainTime){
      if(!hasPopulationRoom(e.team,e.queue[0],false))return;
      let spawn=findSpawnTile(e.x+e.w,e.y+e.h) || findSpawnTile(e.x,e.y);
      if(!spawn){
        if(e.team===0 && tick % 180 === 0){
          showMsg("Spawn point blocked! Clear area near " + BLDGS[e.btype].name);
        }
        return;
      }
      e.trainTick=0;
      let ut=e.queue.shift();
      let unit=createUnit(ut,spawn.x,spawn.y,e.team);
      
      // Play training complete fanfare sound (player team 0)
      if (e.team === 0 && window.playSound) {
        window.playSound('train');
      }
      
      // Rally point set on a garrisonable own building (including this one):
      // the fresh unit appears directly inside it, AoE2-style — no walking.
      if(unit && e.team===0 && e.rallyX!==undefined && e.rallyY!==undefined){
        let rallyB=null;
        if(e.rallyTargetId){
          let t=entitiesById.get(e.rallyTargetId);
          if(t&&t.type==='building'&&canGarrisonIn(t,unit.team))rallyB=t;
        } else {
          let tx=Math.floor(e.rallyX), ty=Math.floor(e.rallyY);
          if(ty>=0&&ty<MAP&&tx>=0&&tx<MAP&&map[ty][tx].occupied){
            let t=entitiesById.get(map[ty][tx].occupied);
            if(t&&canGarrisonIn(t,unit.team))rallyB=t;
          }
        }
        if(rallyB&&garrisonCount(rallyB)<garrisonCap(rallyB)){
          enterGarrison(unit,rallyB);
          if(typeof updateUI==='function')updateUI();
          return;
        }
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
          } else {
            // Rallied entity is gone (destroyed/removed) — fall back to the
            // plain rally coordinates instead of silently leaving the unit idle.
            pathUnitTo(unit,e.rallyX,e.rallyY);
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
