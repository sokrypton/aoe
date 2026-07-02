// ---- ENTITY HELPERS ----
let nextId=1;
function createUnit(type,x,y,team){
  let u=UNITS[type];
  let e={id:nextId++,type:'unit',utype:type,x,y,fromX:x,fromY:y,tx:x,ty:y,team,hp:u.hp,maxHp:u.hp,
    atk:u.atk,range:u.range,speed:u.speed,path:[],task:null,target:null,
    carrying:0,carryType:null,carryMax:10,atkCooldown:0,moveT:0,
    gatherCooldown:0,buildTarget:null,gatherX:-1,gatherY:-1,
    stance: (type !== 'villager' && type !== 'sheep') ? 'aggressive' : undefined};
  entities.push(e);
  entitiesById.set(e.id, e);
  return e;
}
function pushUnitsOut(bx,by,bw,bh){
  entities.forEach(e=>{
    if(e.type==='unit'&&!e.garrisonedIn){
      let ux=Math.round(e.x), uy=Math.round(e.y);
      if(ux>=bx&&ux<bx+bw&&uy>=by&&uy<by+bh){
        if(typeof findSpawnTile==='function'){
          let spawn=findSpawnTile(bx+bw,by+bh,8);
          if(spawn){
            e.x=spawn.x+0.5;e.y=spawn.y+0.5;
            e.fromX=e.x;e.fromY=e.y;
            if(typeof clearUnitPath==='function')clearUnitPath(e);
            else e.path=[];
          }
        }
      }
    }
  });
}
function createBuilding(type,x,y,team,customW=null,customH=null){
  let b=BLDGS[type];
  let bw = customW !== null ? customW : b.w;
  let bh = customH !== null ? customH : b.h;
  let e={id:nextId++,type:'building',btype:type,x,y,team,hp:b.hp,maxHp:b.hp,
    w:bw,h:bh,queue:[],trainTick:0,rallyX:x+bw,rallyY:y+bh,
    complete:true,buildProgress:0,buildTime:b.buildTime||200,
    food:b.food||0,maxFood:b.food||0,garrison:[]};
  for(let dy=0;dy<bh;dy++)for(let dx=0;dx<bw;dx++){
    if(y+dy<MAP&&x+dx<MAP)map[y+dy][x+dx].occupied=e.id;
    // Only the origin tile becomes actual harvestable farmland — the rest of
    // a >1x1 footprint (see FARM in core.js) is just occupied ground under
    // the tilled-plot art, matching AoE2 where a farm is one resource node
    // regardless of how large its visual plot is.
    if(b.isFarm&&dx===0&&dy===0){map[y+dy][x+dx].t=TERRAIN.FARM;map[y+dy][x+dx].res=b.food||300;}
  }
  entities.push(e);
  entitiesById.set(e.id, e);
  if(!b.isFarm)pushUnitsOut(x,y,e.w,e.h);
  return e;
}
