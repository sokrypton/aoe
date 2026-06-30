// ---- MAP GENERATION ----
function genMap(){
  map=[];
  for(let y=0;y<MAP;y++){map[y]=[];for(let x=0;x<MAP;x++){
    map[y][x]={t:TERRAIN.GRASS,res:0,occupied:null};
  }}

  let starts=STARTS.map(s=>({team:s.team,x:s.x,y:s.y,cx:s.x+1,cy:s.y+1}));
  let baseAngle=Math.atan2(starts[1].cy-starts[0].cy,starts[1].cx-starts[0].cx);
  let baseSide=Math.random()<0.5?-1:1;
  // Resource distances below were tuned for the original 60x60 map; scale them
  // so larger maps spread bases/resources out instead of leaving empty grass.
  let scale=MAP/60;

  function randFloat(min,max){return Math.random()*(max-min)+min;}
  function inBounds(x,y,margin=0){return x>=margin&&x<MAP-margin&&y>=margin&&y<MAP-margin;}
  function distXY(ax,ay,bx,by){return Math.sqrt((ax-bx)*(ax-bx)+(ay-by)*(ay-by));}
  function polar(angle,dist){return{x:Math.round(Math.cos(angle)*dist),y:Math.round(Math.sin(angle)*dist)};}
  function clearArea(cx,cy,r){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let x=cx+dx,y=cy+dy;
      if(inBounds(x,y)&&dx*dx+dy*dy<=r*r)map[y][x]={t:TERRAIN.GRASS,res:0,occupied:null};
    }
  }
  function clearForestArea(cx,cy,r){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let x=cx+dx,y=cy+dy;
      if(inBounds(x,y)&&dx*dx+dy*dy<=r*r&&map[y][x].t===TERRAIN.FOREST)map[y][x]={t:TERRAIN.GRASS,res:0,occupied:null};
    }
  }
  function protectedBase(x,y){
    return starts.some(s=>distXY(x,y,s.cx,s.cy)<4.2);
  }
  function clearForResource(cx,cy,r,minStartDist){
    if(!inBounds(cx,cy,r+1))return false;
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let x=cx+dx,y=cy+dy;
      if(dx*dx+dy*dy>r*r)continue;
      if(!inBounds(x,y,1)||map[y][x].t!==TERRAIN.GRASS)return false;
      if(minStartDist&&starts.some(s=>distXY(x,y,s.cx,s.cy)<minStartDist))return false;
    }
    return true;
  }
  function findClearSpot(cx,cy,r,minStartDist,search=5){
    cx=Math.round(cx);cy=Math.round(cy);
    for(let d=0;d<=search;d++){
      for(let dy=-d;dy<=d;dy++)for(let dx=-d;dx<=d;dx++){
        if(Math.abs(dx)!==d&&Math.abs(dy)!==d)continue;
        let x=cx+dx,y=cy+dy;
        if(clearForResource(x,y,r,minStartDist))return{x,y};
      }
    }
    return null;
  }
  function hasTerrainNear(x,y,terrains,r){
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      if(dx*dx+dy*dy>r*r)continue;
      let nx=x+dx,ny=y+dy;
      if(inBounds(nx,ny)&&terrains.includes(map[ny][nx].t))return true;
    }
    return false;
  }
  function resourceBuffer(x,y,r=2){
    return hasTerrainNear(x,y,[TERRAIN.GOLD,TERRAIN.STONE,TERRAIN.BERRIES],r);
  }
  function compactOffsets(count){
    let shapes={
      3:[[[0,0],[1,0],[0,1]],[[0,0],[-1,0],[0,1]],[[0,0],[1,0],[0,-1]],[[0,0],[-1,0],[0,-1]]],
      4:[[[0,0],[1,0],[0,1],[1,1]],[[0,0],[-1,0],[0,1],[-1,1]],[[0,0],[1,0],[0,-1],[1,-1]],[[0,0],[-1,0],[0,-1],[-1,-1]]],
      5:[[[0,0],[1,0],[-1,0],[0,1],[0,-1]],[[0,0],[1,0],[0,1],[1,1],[-1,0]],[[0,0],[-1,0],[0,1],[-1,1],[1,0]]],
      7:[[[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1]],[[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]],[[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1]]]
    };
    let shape=(shapes[count]||shapes[5])[randInt(0,(shapes[count]||shapes[5]).length-1)];
    return shape.concat([[2,0],[-2,0],[0,2],[0,-2],[2,1],[1,2],[-1,2],[-2,1],[2,-1],[1,-2],[-1,-2],[-2,-1]]);
  }
  function placePatch(terrain,cx,cy,count,resAmt,clearRadius,minStartDist,search=5){
    let spot=findClearSpot(cx,cy,clearRadius,minStartDist,search);
    if(!spot)return[];
    clearArea(spot.x,spot.y,clearRadius);
    let placed=[];
    function tryPlace(dx,dy){
      if(placed.length>=count)return;
      let x=spot.x+dx,y=spot.y+dy;
      if(inBounds(x,y,1)&&map[y][x].t===TERRAIN.GRASS&&!protectedBase(x,y)){
        map[y][x]={t:terrain,res:resAmt,occupied:null};
        placed.push({x,y});
      }
    }
    compactOffsets(count).forEach(([dx,dy])=>tryPlace(dx,dy));
    for(let r=1;placed.length<count&&r<=clearRadius+4;r++){
      for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
        if(Math.abs(dx)!==r&&Math.abs(dy)!==r)continue;
        tryPlace(dx,dy);
      }
    }
    return placed;
  }
  function placeBerries(cx,cy){
    let spot=findClearSpot(cx,cy,2,4);
    if(!spot)return[];
    clearArea(spot.x,spot.y,2);
    let offsets=[[0,0],[1,0],[-1,0],[0,1],[1,1],[-1,1]];
    return offsets.map(([dx,dy])=>{
      let x=spot.x+dx,y=spot.y+dy;
      if(inBounds(x,y,1)){map[y][x]={t:TERRAIN.BERRIES,res:200,occupied:null};return{x,y};}
      return null;
    }).filter(Boolean);
  }
  function placeForestLine(cx,cy,angle,len,wid){
    let spot=findClearSpot(cx,cy,2,5,4);
    if(!spot)return 0;
    let placed=0;
    let r = Math.ceil(Math.sqrt(len*len + wid*wid)) + 1;
    let cos = Math.cos(angle);
    let sin = Math.sin(angle);
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      let x = spot.x + dx;
      let y = spot.y + dy;
      if(!inBounds(x,y,1))continue;
      
      // Project grid offsets back to local rotated coordinates (l, w)
      let l = dx * cos + dy * sin;
      let w = -dx * sin + dy * cos;
      
      // Match rectangle boundaries (with 0.3 tile rounding buffer)
      if(Math.abs(l) <= len + 0.3 && Math.abs(w) <= wid + 0.3){
        let edge = Math.abs(l) > len - 0.7 || Math.abs(w) > wid - 0.7;
        let edgeFalloff = edge ? 0.85 : 1.0;
        
        if(!protectedBase(x,y) && !resourceBuffer(x,y,2) && map[y][x].t===TERRAIN.GRASS && Math.random()<edgeFalloff){
          map[y][x]={t:TERRAIN.FOREST,res:randInt(120,200),occupied:null};
          placed++;
        }
      }
    }
    return placed;
  }
  function placeMirrored(offset,placeFn){
    placeFn(starts[0].cx+offset.x,starts[0].cy+offset.y);
    placeFn(starts[1].cx-offset.x,starts[1].cy-offset.y);
  }
  function placeMirroredForest(angle,dist,len,wid){
    let offset=polar(angle,dist);
    placeMirrored(offset,(x,y)=>placeForestLine(x,y,angle+Math.PI/2,len,wid));
  }
  function placeNeutralPair(dx,dy,placeFn){
    let cx=MAP/2,cy=MAP/2;
    placeFn(cx+dx,cy+dy);
    placeFn(cx-dx,cy-dy);
  }

  starts.forEach(s=>clearArea(s.cx,s.cy,6));

  let berriesOffset=polar(baseAngle+baseSide*1.0+randFloat(-0.25,0.25),5*scale);
  placeMirrored(berriesOffset,placeBerries);

  let mainGoldOffset=polar(baseAngle+randFloat(-0.35,0.35),8*scale);
  placeMirrored(mainGoldOffset,(x,y)=>placePatch(TERRAIN.GOLD,x,y,7,800,3,4*scale,1));

  let mainStoneOffset=polar(baseAngle-baseSide*1.45+randFloat(-0.25,0.25),8*scale);
  placeMirrored(mainStoneOffset,(x,y)=>placePatch(TERRAIN.STONE,x,y,4,350,3,4*scale,1));

  let secondGoldOffset=polar(baseAngle+Math.PI+baseSide*0.65+randFloat(-0.25,0.25),12*scale);
  placeMirrored(secondGoldOffset,(x,y)=>placePatch(TERRAIN.GOLD,x,y,4,800,3,8*scale,3));

  let secondStoneOffset=polar(baseAngle+Math.PI-baseSide*0.8+randFloat(-0.25,0.25),11*scale);
  placeMirrored(secondStoneOffset,(x,y)=>placePatch(TERRAIN.STONE,x,y,3,350,2,8*scale,3));

  placeMirroredForest(baseAngle+Math.PI+randFloat(-0.35,0.35),8*scale,5,2);
  placeMirroredForest(baseAngle+baseSide*1.7+randFloat(-0.25,0.25),9*scale,5,2);
  placeMirroredForest(baseAngle-baseSide*1.25+randFloat(-0.25,0.25),11*scale,6,2);

  [baseAngle+Math.PI-0.7,baseAngle+Math.PI+0.5,baseAngle+baseSide*2.2].forEach(a=>{
    let offset=polar(a+randFloat(-0.15,0.15),4*scale);
    placeMirrored(offset,(x,y)=>{
      x=Math.round(x);y=Math.round(y);
      if(inBounds(x,y,1)&&!resourceBuffer(x,y,2)&&map[y][x].t===TERRAIN.GRASS)map[y][x]={t:TERRAIN.FOREST,res:100,occupied:null};
    });
  });

  placeNeutralPair(7*scale,-6*scale,(x,y)=>placePatch(TERRAIN.GOLD,x,y,5,800,3,12*scale));
  placeNeutralPair(-8*scale,5*scale,(x,y)=>placePatch(TERRAIN.STONE,x,y,4,350,3,12*scale));
  placeNeutralPair(0,12*scale,(x,y)=>placePatch(TERRAIN.GOLD,x,y,4,800,3,12*scale));

  // Extra neutral deposit pairs beyond the 3 above: scale count with map area
  // (scale^2) so bigger maps have proportionally more to contest, not just
  // more empty buffer between the same fixed set of deposits.
  let extraDepositPairs=Math.round(3*scale*scale)-3;
  for(let i=0;i<extraDepositPairs;i++){
    let angle=randFloat(0,Math.PI*2);
    let dist=randFloat(10,16)*scale;
    let offset=polar(angle,dist);
    let isGold=i%2===0;
    placeNeutralPair(offset.x,offset.y,(x,y)=>placePatch(isGold?TERRAIN.GOLD:TERRAIN.STONE,x,y,isGold?5:4,isGold?800:350,3,12*scale));
  }

  // Scattered neutral forest patches: scale count with map area (scale^2) so
  // bigger maps don't end up with proportionally more empty grass.
  let extraForestPatches=Math.round(7*scale*scale);
  for(let i=0;i<extraForestPatches;i++){
    let angle=randFloat(0,Math.PI*2);
    let dist=randInt(Math.round(9*scale),Math.round(23*scale));
    let x=MAP/2+Math.round(Math.cos(angle)*dist);
    let y=MAP/2+Math.round(Math.sin(angle)*dist);
    if(starts.some(s=>distXY(x,y,s.cx,s.cy)<13*scale))continue;
    placeForestLine(x,y,randFloat(0,Math.PI),randInt(4,7),randInt(2,3));
  }

  for(let i=0;i<=24;i++){
    let t=i/24;
    let x=Math.round(starts[0].cx+(starts[1].cx-starts[0].cx)*t);
    let y=Math.round(starts[0].cy+(starts[1].cy-starts[0].cy)*t);
    clearForestArea(x,y,2);
  }

  starts.forEach(s=>clearArea(s.cx,s.cy,3));
}
