// ---- ENTITY HELPERS ----
let nextId=1;
function createUnit(type,x,y,team){
  let u=UNITS[type];
  let e={id:nextId++,type:'unit',utype:type,x,y,fromX:x,fromY:y,tx:x,ty:y,team,hp:u.hp,maxHp:u.hp,
    atk:u.atk,range:u.range,speed:u.speed,path:[],task:null,target:null,
    carrying:0,carryType:null,carryMax:10,atkCooldown:0,moveT:0,
    gatherCooldown:0,buildTarget:null,gatherX:-1,gatherY:-1,autoAttack:globalAutoAttack};
  entities.push(e);
  return e;
}
function pushUnitsOut(bx,by,bw,bh){
  entities.forEach(e=>{
    if(e.type==='unit'){
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
function createBuilding(type,x,y,team){
  let b=BLDGS[type];
  let e={id:nextId++,type:'building',btype:type,x,y,team,hp:b.hp,maxHp:b.hp,
    w:b.w,h:b.h,queue:[],trainTick:0,rallyX:x+b.w,rallyY:y+b.h,
    complete:true,buildProgress:0,buildTime:200,
    food:b.food||0,maxFood:b.food||0};
  for(let dy=0;dy<b.h;dy++)for(let dx=0;dx<b.w;dx++){
    if(y+dy<MAP&&x+dx<MAP)map[y+dy][x+dx].occupied=e.id;
    if(b.isFarm){map[y+dy][x+dx].t=TERRAIN.FARM;map[y+dy][x+dx].res=b.food||300;}
  }
  entities.push(e);
  if(!b.isFarm)pushUnitsOut(x,y,b.w,b.h);
  return e;
}
