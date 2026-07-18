// ---- ENTITY HELPERS ----
let nextId=1;
function createUnit(type,x,y,team){
  let u=UNITS[type];
  let e={id:nextId++,type:'unit',utype:type,x,y,fromX:x,fromY:y,tx:x,ty:y,team,hp:u.hp,maxHp:u.hp,
    atk:u.atk,range:u.range,speed:u.speed,path:[],task:null,target:null,
    carrying:0,carryType:null,carryMax:10,atkCooldown:0,moveT:0,
    order:null, // THE exclusive standing order (issueOrder, js/commands.js) — any new order replaces it
    gatherCooldown:0,buildTarget:null,gatherX:-1,gatherY:-1,
    stance: (type !== 'villager' && type !== 'sheep' && type !== 'bear' && type !== 'tradecart') ? 'aggressive' : undefined,
    // Initial facing before first movement. Without this e.dir is undefined
    // and the face renderer draws NO eyes (its dir branches all miss), so
    // fresh units stared blankly. 1 = south, facing the viewer; the scout
    // starts in horse profile (7 = east) — a horse head-on reads poorly.
    dir: (type === 'scout' || type === 'knight') ? 7 : 1, facing: 1, facingNorth: false,
    // Villagers are randomly male or female (cosmetic only, like AoE2)
    female: type === 'villager' ? simRandom() < 0.5 : undefined};
  // Upgrade cards (see UPGRADES, js/core.js) — spawn-time counterpart of
  // the one-time sweeps applyTech runs over existing units. Attack/
  // range/speed are snapshotted here; armor is looked up live in
  // damageEntity, so no armor stamp is needed.
  if (MILITARY.has(type)) e.atk += upgradeAtkBonus(team);
  if (type === 'archer' && hasUpgrade(team, 'fletching')) e.range += 1;
  if (type === 'villager' && hasUpgrade(team, 'wheelbarrow')) {
    e.speed = UNITS.villager.speed * 1.1;
    e.carryMax += 3;
  }
  entities.push(e);
  entitiesById.set(e.id, e);
  return e;
}
// THE one way tile occupancy is derived from a building's footprint:
// creation stamps it here, and the save loader re-derives it from the saved
// entities (occupied is never serialized — js/save.js v4). Keep any change
// to the guard or the stamped rect in this one place.
function stampBuildingFootprint(e){
  for(let dy=0;dy<(e.h||1);dy++)for(let dx=0;dx<(e.w||1);dx++){
    if(e.y+dy<MAP&&e.x+dx<MAP){map[e.y+dy][e.x+dx].occupied=e.id;markMapDirty(e.x+dx,e.y+dy);}
  }
}
function createBuilding(type,x,y,team,customW=null,customH=null){
  let b=BLDGS[type];
  let bw = customW !== null ? customW : b.w;
  let bh = customH !== null ? customH : b.h;
  let e={id:nextId++,type:'building',btype:type,x,y,team,hp:b.hp,maxHp:b.hp,
    w:bw,h:bh,queue:[],trainTick:0,rallyX:x+bw,rallyY:y+bh,
    complete:true,buildProgress:0,buildTime:b.buildTime||T30(200),atk:b.atk||0,
    food:b.food||0,maxFood:b.food||0,garrison:[]};
  // Upgrade cards (see UPGRADES, js/core.js): buildings founded after the
  // cards arrive get the same HP multipliers the apply() sweeps gave
  // existing ones.
  e.hp = e.maxHp = buildingMaxHpFor(team, type);
  stampBuildingFootprint(e);
  // Only the origin tile becomes actual harvestable farmland — the rest of
  // a >1x1 footprint (see FARM in core.js) is just occupied ground under
  // the tilled-plot art, matching AoE2 where a farm is one resource node
  // regardless of how large its visual plot is.
  if(b.isFarm&&y<MAP&&x<MAP){map[y][x].t=TERRAIN.FARM;map[y][x].res=farmFoodFor(team);markMapDirty(x,y);}
  entities.push(e);
  entitiesById.set(e.id, e);
  // No displacement here: this stamps a COMPLETE building by default, but the
  // gameplay foundation path flips it to complete=false right after, and a
  // foundation stays walkable until work starts (the build-gate clears the
  // footprint gently). Instant-solid placement is editor-only, and the editor's
  // canPlace(rejectUnits) refuses an occupied tile up front — so no unit is
  // ever standing where a solid building lands, and nothing needs shoving.
  return e;
}
