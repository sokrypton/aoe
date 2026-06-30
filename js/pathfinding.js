// ---- PATHFINDING (A*) ----
function walkable(x,y,ignore){
  if(x<0||x>=MAP||y<0||y>=MAP)return false;
  let t=map[y][x];
  if(t.t===TERRAIN.FARM)return true;
  if(t.t===TERRAIN.WATER||t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)return false;
  if(t.occupied&&t.occupied!==ignore) {
    // Let friendly units or anyone (if open) pass through gates
    let bldg = entitiesById.get(t.occupied);
    if (bldg && bldg.btype === 'GATE') {
      let walker = entitiesById.get(ignore);
      if (walker && (walker.team === bldg.team || bldg.isOpen)) {
        return true;
      }
    }
    return false;
  }
  return true;
}
function findPath(sx,sy,ex,ey,ignore){
  sx=Math.round(sx);sy=Math.round(sy);ex=Math.round(ex);ey=Math.round(ey);
  if(ex<0)ex=0;if(ey<0)ey=0;if(ex>=MAP)ex=MAP-1;if(ey>=MAP)ey=MAP-1;
  // Only redirect for truly impassable destinations (water, buildings)
  // Resource tiles (forest, gold, stone, berries) are valid destinations
  if(!walkable(ex,ey,ignore)){
    let found=false;
    for(let r=1;r<20&&!found;r++)for(let dy=-r;dy<=r&&!found;dy++)for(let dx=-r;dx<=r;dx++){
      if(walkable(ex+dx,ey+dy,ignore)){ex+=dx;ey+=dy;found=true;break;}
    }
  }
  // Use a Map for O(1) open-list lookup instead of O(n) linear scan.
  // Extract min-f by linear scan + swap-with-last (O(n)) instead of sort (O(n log n)).
  let startNode={x:sx,y:sy,g:0,h:0,f:0,p:null};
  let open=[startNode];
  let openMap=new Map([[sx+sy*MAP,startNode]]);
  let closed=new Set();
  let iters=0;
  while(open.length>0&&iters<800){
    iters++;
    let minIdx=0;
    for(let i=1;i<open.length;i++){if(open[i].f<open[minIdx].f)minIdx=i;}
    let cur=open[minIdx];
    open[minIdx]=open[open.length-1];open.pop();
    if(cur.x===ex&&cur.y===ey){
      let path=[];while(cur.p){path.unshift({x:cur.x,y:cur.y});cur=cur.p;}
      return path;
    }
    let ck=cur.x+cur.y*MAP;
    openMap.delete(ck);
    closed.add(ck);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0)continue;
      let nx=cur.x+dx,ny=cur.y+dy;
      if(!walkable(nx,ny,ignore)&&!(nx===ex&&ny===ey))continue;
      // Block diagonal moves that cut through the gap between two touching obstacles
      if(dx&&dy&&(!walkable(cur.x+dx,cur.y,ignore)||!walkable(cur.x,cur.y+dy,ignore)))continue;
      let k=nx+ny*MAP;
      if(closed.has(k))continue;
      let g=cur.g+(dx&&dy?1.41:1);
      let existing=openMap.get(k);
      if(existing){if(g<existing.g){existing.g=g;existing.f=g+existing.h;existing.p=cur;}}
      else{
        let adx=Math.abs(nx-ex),ady=Math.abs(ny-ey);
        let h=Math.max(adx,ady)+0.41*Math.min(adx,ady);
        let node={x:nx,y:ny,g,h,f:g+h,p:cur};
        open.push(node);openMap.set(k,node);
      }
    }
  }
  return[];
}

function clearUnitPath(e){
  e.path=[];
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
}

function setUnitPath(e,path){
  e.path=path;
  e.moveT=0;
  e.fromX=e.x;
  e.fromY=e.y;
  return e.path;
}

function pathUnitTo(e,x,y){
  return setUnitPath(e,findPath(Math.round(e.x),Math.round(e.y),x,y,e.id));
}
