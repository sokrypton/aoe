// ==============================
// ---- INPUT: MOUSE (Desktop) ----
// ==============================
let keys={};
let isDragging=false;
let hasTouch=false; // set true on first touch, suppresses mouse
let justPlaced=false; // flag to prevent mouseup selection clearing when placing buildings

document.addEventListener('keydown',e=>{
  if(gameOver)return;
  keys[e.key]=true;
  if(e.key==='Escape'){placing=null;selected=[];}
  if((e.key==='h'||e.key==='H')&&selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0))placing='HOUSE';
});
document.addEventListener('keyup',e=>{keys[e.key]=false;});

C.addEventListener('mousedown',e=>{
  if(gameOver||hasTouch)return; // ignore synthetic mouse events
  if(e.button===0){
    if(placing){
      doPlace(e.clientX,e.clientY);
      justPlaced=true;
      return;
    }
    dragStart={x:e.clientX,y:e.clientY};dragEnd=null;isDragging=false;
    justPlaced=false;
  }
});
C.addEventListener('mousemove',e=>{
  if(gameOver||hasTouch)return;
  mouseX=e.clientX;mouseY=e.clientY;
  if(dragStart&&(e.buttons&1)){
    dragEnd={x:e.clientX,y:e.clientY};
    if(Math.abs(dragEnd.x-dragStart.x)+Math.abs(dragEnd.y-dragStart.y)>8)isDragging=true;
  }
});
// Track mouse position globally so edge scroll works correctly when cursor is over UI panels
document.addEventListener('mousemove',e=>{if(!gameOver){mouseX=e.clientX;mouseY=e.clientY;}});
C.addEventListener('mouseup',e=>{
  if(gameOver||hasTouch)return;
  if(e.button===0){
    if(placing)return;
    if(justPlaced){
      justPlaced=false;
      return;
    }
    if(isDragging&&dragStart&&dragEnd){
      doBoxSelect(dragStart.x,dragStart.y,dragEnd.x,dragEnd.y);
    } else {
      doSelect(e.clientX,e.clientY,e.shiftKey);
    }
    dragStart=null;dragEnd=null;isDragging=false;
  }
});
C.addEventListener('contextmenu',e=>{
  e.preventDefault();
  if(gameOver||hasTouch)return;
  doCommand(e.clientX,e.clientY);
});

// ==============================
// ---- INPUT: TOUCH (Mobile) ----
// ==============================
// Simple scheme:
//   Drag = pan camera (always)
//   Quick tap = context-aware:
//     - placing mode → place building
//     - nothing selected → select entity under finger
//     - units selected + tap own entity → switch selection
//     - units selected + tap map → move/gather/attack (command)
//     - building selected + tap elsewhere → try select, or deselect

let touchAnchor=null;  // where the touch started (for tap detection)
let touchLast=null;    // last touch position (for pan delta)
let touchMoved=false;  // did finger travel > threshold?
let touchId=null;      // track which finger is primary

C.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(gameOver)return;
  hasTouch=true;
  let touches=e.touches;
  if(touches.length===1){
    let t=touches[0];
    touchId=t.identifier;
    touchAnchor={x:t.clientX,y:t.clientY};
    touchLast={x:t.clientX,y:t.clientY};
    touchMoved=false;
    mouseX=t.clientX;mouseY=t.clientY; // for ghost preview
  }
  if(touches.length>=2){
    // Multi-touch: always pan, cancel any tap
    touchMoved=true;
    touchAnchor=null;
    let mx=(touches[0].clientX+touches[1].clientX)/2;
    let my=(touches[0].clientY+touches[1].clientY)/2;
    touchLast={x:mx,y:my};
  }
},{passive:false});

C.addEventListener('touchmove',e=>{
  e.preventDefault();
  let touches=e.touches;
  if(touches.length>=2){
    // Two-finger pan
    let mx=(touches[0].clientX+touches[1].clientX)/2;
    let my=(touches[0].clientY+touches[1].clientY)/2;
    if(touchLast){
      camX-=(mx-touchLast.x);
      camY-=(my-touchLast.y);
    }
    touchLast={x:mx,y:my};
    touchMoved=true;
    touchAnchor=null;
    mouseX=mx;mouseY=my;
    return;
  }
  if(touches.length===1){
    let t=touches[0];
    mouseX=t.clientX;mouseY=t.clientY; // update ghost preview
    // Check if we've moved past the tap threshold
    if(touchAnchor){
      let dx=t.clientX-touchAnchor.x;
      let dy=t.clientY-touchAnchor.y;
      if(Math.abs(dx)+Math.abs(dy)>10){
        touchMoved=true;
      }
    }
    // Pan the camera once we know it's a drag
    if(touchMoved&&touchLast){
      let dx=t.clientX-touchLast.x;
      let dy=t.clientY-touchLast.y;
      camX-=dx;
      camY-=dy;
    }
    touchLast={x:t.clientX,y:t.clientY};
  }
},{passive:false});

C.addEventListener('touchend',e=>{
  e.preventDefault();
  // Only process tap when all fingers are lifted
  if(e.touches.length===0){
    if(!touchMoved&&touchAnchor){
      // It's a tap! Process context-aware action
      handleTap(touchAnchor.x,touchAnchor.y);
    }
    touchAnchor=null;
    touchLast=null;
    touchMoved=false;
    touchId=null;
  } else if(e.touches.length===1){
    // Went from 2 fingers to 1: update last position, stay in pan mode
    let t=e.touches[0];
    touchLast={x:t.clientX,y:t.clientY};
    touchMoved=true; // don't allow tap after multi-touch
  }
},{passive:false});

// Context-aware tap handler for mobile
function handleTap(sx,sy){
  // 1. If placing a building, place it
  if(placing){
    doPlace(sx,sy);
    return;
  }

  let tile=screenToTile(sx,sy);
  let hitR=20; // generous hit area for fingers

  // Find what's under the tap
  let tappedOwn=null;    // own unit or building
  let tappedEnemy=null;  // enemy unit or building

  // Check units first (higher priority)
  entities.forEach(en=>{
    let iso=toIso(en.x,en.y);
    let idOff=en.id%7;
    let ox=(idOff%3-1)*6, oy=(Math.floor(idOff/3)-1)*4;
    let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
    let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+topH+H/2;
    let dx=sx-scrx,dy=sy-scry;
    if(en.type==='unit'&&Math.sqrt(dx*dx+dy*dy)<hitR*ZOOM){
      if(en.team===0)tappedOwn=en;
      else tappedEnemy=en; // team 1 enemies AND team 2 neutrals
    }
  });
  // Then buildings
  if(!tappedOwn&&!tappedEnemy){
    entities.forEach(en=>{
      if(en.type==='building'){
        let b=BLDGS[en.btype];
        if(tile.x>=en.x&&tile.x<en.x+b.w&&tile.y>=en.y&&tile.y<en.y+b.h){
          if(en.team===0)tappedOwn=en;
          else tappedEnemy=en;
        }
      }
    });
  }

  // 2. Nothing selected → just select
  if(selected.length===0){
    if(tappedOwn||tappedEnemy) selected=[tappedOwn||tappedEnemy];
    return;
  }

  // 3. Have units selected
  let haveUnits=selected.some(s=>s.type==='unit'&&s.team===0);
  let haveVillagers=selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
  if(haveUnits){
    // Tapped on own sheep with villagers → harvest command
    if(tappedOwn&&tappedOwn.utype==='sheep'&&haveVillagers){
      doCommand(sx,sy);
      return;
    }
    // Tapped on own entity → switch selection
    if(tappedOwn){
      selected=[tappedOwn];
      return;
    }
    // Tapped on enemy → attack
    if(tappedEnemy){
      doCommand(sx,sy);
      return;
    }
    // Tapped on map → move or gather
    doCommand(sx,sy);
    return;
  }

  // 4. Have a building selected (not units)
  if(tappedOwn){
    selected=[tappedOwn];
  } else if(tappedEnemy){
    selected=[tappedEnemy];
  } else {
    selected=[];
  }
}

// Minimap: works with both mouse and touch dragging
let minimapDragging = false;
function minimapJump(sx,sy){
  let rect=MC.getBoundingClientRect();
  let mx=(sx-rect.left)/rect.width*(MC.clientWidth||rect.width);
  let my=(sy-rect.top)/rect.height*(MC.clientHeight||rect.height);
  let p=miniToMap(mx,my,MC.clientWidth||rect.width,MC.clientHeight||rect.height);
  // Clamping coordinates so dragging slightly outside map boundaries feels smooth
  p.x = Math.max(0, Math.min(MAP, p.x));
  p.y = Math.max(0, Math.min(MAP, p.y));
  let iso=toIso(p.x,p.y);
  camX=iso.ix;camY=iso.iy;
}
MC.addEventListener('mousedown',e=>{
  if(gameOver)return;
  hasTouch=false;
  minimapDragging=true;
  minimapJump(e.clientX,e.clientY);
});
window.addEventListener('mousemove',e=>{
  if(minimapDragging){
    minimapJump(e.clientX,e.clientY);
  }
});
window.addEventListener('mouseup',()=>{
  minimapDragging=false;
});

MC.addEventListener('touchstart',e=>{
  e.preventDefault();e.stopPropagation();
  if(gameOver)return;
  hasTouch=true;
  minimapDragging=true;
  minimapJump(e.touches[0].clientX,e.touches[0].clientY);
},{passive:false});
MC.addEventListener('touchmove',e=>{
  if(minimapDragging){
    e.preventDefault();e.stopPropagation();
    minimapJump(e.touches[0].clientX,e.touches[0].clientY);
  }
},{passive:false});
MC.addEventListener('touchend',()=>{
  minimapDragging=false;
});

// ==============================
// ---- SHARED INPUT ACTIONS ----
// ==============================
function doSelect(sx,sy,shift){
  let tile=screenToTile(sx,sy);
  let clicked=null;
  // Try units first (bigger hit area on mobile)
  let hitR=isMobile?18:12;
  entities.forEach(en=>{
    if(en.type==='unit'){
      let iso=toIso(en.x,en.y);
      let idOff=en.id%7;
      let ox=(idOff%3-1)*6;
      let oy=(Math.floor(idOff/3)-1)*4;
      let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
      let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;
      let dx=sx-scrx,dy=sy-(scry-10*ZOOM);
      if(Math.sqrt(dx*dx+dy*dy)<hitR*ZOOM)clicked=en;
    }
  });
  if(!clicked){
    entities.forEach(en=>{
      if(en.type==='building'){
        let b=BLDGS[en.btype];
        if(tile.x>=en.x&&tile.x<en.x+b.w&&tile.y>=en.y&&tile.y<en.y+b.h)clicked=en;
      }
    });
  }
  if(clicked){
    if(shift){
      if(!selected.some(s=>s.id===clicked.id))selected.push(clicked);
    }
    else selected=[clicked];
  } else selected=[];
}

function doBoxSelect(x1,y1,x2,y2){
  let sx1=Math.min(x1,x2),sy1=Math.min(y1,y2);
  let sx2=Math.max(x1,x2),sy2=Math.max(y1,y2);
  selected=entities.filter(en=>{
    if(en.team!==0)return false;
    let iso=toIso(en.x,en.y);
    let idOff=en.id%7;
    let ox=(idOff%3-1)*6;
    let oy=(Math.floor(idOff/3)-1)*4;
    let sx=(iso.ix-camX+ox)*ZOOM+W/2;
    let sy=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;
    return sx>=sx1&&sx<=sx2&&sy>=sy1&&sy<=sy2;
  });
  let units=selected.filter(s=>s.type==='unit');
  if(units.length>0)selected=units;
}

function doCommand(sx,sy){
  placing=null; // cancel building placement preview when commanding units
  if(selected.length===0)return;
  let tile=screenToTile(sx,sy);

  // If a friendly building is selected, right-clicking sets its Rally Point
  if(selected[0].type==='building'&&selected[0].team===0){
    let bldg=selected[0];
    if(!inMapBounds(tile.x,tile.y))return;
    bldg.rallyX=tile.x;
    bldg.rallyY=tile.y;
    
    // Find target entity under the click
    let rTarget=null;
    let hitR=isMobile?18:12;
    entities.forEach(en=>{
      if(en.type==='unit'||en.type==='building'){
        let iso=toIso(en.x,en.y);
        let idOff=en.id%7;
        let ox=(idOff%3-1)*6;
        let oy=(Math.floor(idOff/3)-1)*4;
        let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
        let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;
        let dx=sx-scrx,dy=sy-(scry-10*ZOOM);
        if(Math.sqrt(dx*dx+dy*dy)<hitR*ZOOM)rTarget=en;
      }
    });
    
    if(rTarget){
      bldg.rallyTargetId=rTarget.id;
      bldg.rallyResourceType=null;
      showMsg('Rally point set to '+ (rTarget.type==='unit' ? UNITS[rTarget.utype].name : BLDGS[rTarget.btype].name));
    } else {
      let t0=map[tile.y]&&map[tile.y][tile.x];
      if(t0&&(t0.t===TERRAIN.FOREST||t0.t===TERRAIN.GOLD||t0.t===TERRAIN.STONE||t0.t===TERRAIN.BERRIES||t0.t===TERRAIN.FARM)){
        bldg.rallyResourceType=t0.t;
        bldg.rallyTargetId=null;
        let resNames={[TERRAIN.FOREST]:'wood',[TERRAIN.GOLD]:'gold',[TERRAIN.STONE]:'stone',[TERRAIN.BERRIES]:'food',[TERRAIN.FARM]:'food (farm)'};
        showMsg('Rally point set to gather '+resNames[t0.t]);
      } else {
        bldg.rallyResourceType=null;
        bldg.rallyTargetId=null;
        showMsg('Rally point set to location');
      }
    }
    cmdMarkers.push({x:tile.x,y:tile.y,time:tick,color:'#0af'});
    return;
  }
  // Visual command marker
  let t0=map[tile.y]&&map[tile.y][tile.x];
  let markerColor='#0f0';
  if(t0&&(t0.t===TERRAIN.FOREST||t0.t===TERRAIN.GOLD||t0.t===TERRAIN.STONE||t0.t===TERRAIN.BERRIES||t0.t===TERRAIN.FARM))markerColor='#ff0';
  // Check if targeting enemy OR own sheep for harvesting
  let target=null;
  let buildTarget=null;
  let hitR=isMobile?18:12;
  entities.forEach(en=>{
    // Target enemies
    if(en.team===1){
      if(en.type==='unit'){
        let iso=toIso(en.x,en.y);
        let idOff=en.id%7;
        let ox=(idOff%3-1)*6;
        let oy=(Math.floor(idOff/3)-1)*4;
        let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
        let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;
        if(Math.abs(sx-scrx)<hitR*ZOOM&&Math.abs(sy-(scry-10*ZOOM))<(hitR+3)*ZOOM)target=en;
      }
      if(en.type==='building'){
        let b=BLDGS[en.btype];
        if(tile.x>=en.x&&tile.x<en.x+b.w&&tile.y>=en.y&&tile.y<en.y+b.h)target=en;
      }
    }
    // Target own sheep (villagers harvest them)
    if(en.team===0&&en.utype==='sheep'){
      let iso=toIso(en.x,en.y);
      let idOff=en.id%7;
      let ox=(idOff%3-1)*6;
      let oy=(Math.floor(idOff/3)-1)*4;
      let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
      let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;
      if(Math.abs(sx-scrx)<hitR*ZOOM&&Math.abs(sy-(scry-10*ZOOM))<(hitR+3)*ZOOM)target=en;
    }
  });
  if(!target){
    buildTarget=buildingAtTile(tile.x,tile.y,en=>en.team===0&&!en.complete);
  }
  if(target)markerColor='#f44';
  else if(buildTarget)markerColor='#0af';
  cmdMarkers.push({x:tile.x,y:tile.y,time:tick,color:markerColor});
  // Generate formation offsets for group movement (AoE2-style spread)
  let movers=selected.filter(s=>s.team===0&&s.type==='unit');
  let offsets=getFormation(movers.length);
  let idx=0;
  movers.forEach(s=>{
    s.gatherX=-1;s.gatherY=-1;s.prevTask=null; // fully clear old state
    s.buildTarget=null;
    s.buildQueue=[];
    if(buildTarget&&s.utype==='villager'){
      s.target=null;s.task='build';s.buildTarget=buildTarget.id;
      let b=BLDGS[buildTarget.btype];
      let px=b.isFarm?buildTarget.x:buildTarget.x+b.w, py=b.isFarm?buildTarget.y:buildTarget.y+b.h;
      pathUnitTo(s,px,py);
    } else if(target){
      if(s.utype==='sheep'){return;} // sheep don't attack
      if(target.team===0&&target.utype==='sheep'&&s.utype!=='villager'){
        // Friendly sheep targeted by military unit: treat as move command!
        s.target=null;
        let ox=offsets[idx]?offsets[idx][0]:0, oy=offsets[idx]?offsets[idx][1]:0;
        s.task=null;pathUnitTo(s,tile.x+ox,tile.y+oy);
        idx++;
      } else {
        s.target=target.id;s.task=null;clearUnitPath(s);s.buildTarget=null;
      }
    } else {
      s.target=null;
      let t=map[tile.y]&&map[tile.y][tile.x];
      if(s.utype==='villager'&&t){
        if(t.t===TERRAIN.FOREST){s.task='chop';s.gatherX=tile.x;s.gatherY=tile.y;pathUnitTo(s,tile.x,tile.y);}
        else if(t.t===TERRAIN.GOLD){s.task='mine_gold';s.gatherX=tile.x;s.gatherY=tile.y;pathUnitTo(s,tile.x,tile.y);}
        else if(t.t===TERRAIN.STONE){s.task='mine_stone';s.gatherX=tile.x;s.gatherY=tile.y;pathUnitTo(s,tile.x,tile.y);}
        else if(t.t===TERRAIN.BERRIES){s.task='forage';s.gatherX=tile.x;s.gatherY=tile.y;pathUnitTo(s,tile.x,tile.y);}
        else if(t.t===TERRAIN.FARM){s.task='farm';s.gatherX=tile.x;s.gatherY=tile.y;pathUnitTo(s,tile.x,tile.y);}
        else {
          // Move command: use formation offset
          let ox=offsets[idx]?offsets[idx][0]:0, oy=offsets[idx]?offsets[idx][1]:0;
          s.task=null;pathUnitTo(s,tile.x+ox,tile.y+oy);
          idx++;
        }
      } else {
        // Military move: use formation offset
        let ox=offsets[idx]?offsets[idx][0]:0, oy=offsets[idx]?offsets[idx][1]:0;
        s.task=null;pathUnitTo(s,tile.x+ox,tile.y+oy);
        idx++;
      }
    }
  });
}

// AoE2-style formation: diamond spread around center tile
function getFormation(n){
  let offsets=[[0,0]];
  if(n<=1)return offsets;
  // Spiral outward in rings
  for(let r=1;offsets.length<n;r++){
    for(let dx=-r;dx<=r&&offsets.length<n;dx++){
      for(let dy=-r;dy<=r&&offsets.length<n;dy++){
        if(Math.abs(dx)+Math.abs(dy)===r) offsets.push([dx,dy]);
      }
    }
  }
  return offsets;
}

function doPlace(sx,sy){
  let tile=screenToTile(sx,sy);
  let vils = selected.filter(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
  if(vils.length===0){
    showMsg('Select a villager to build!');
    placing=null;
    return;
  }
  if(canPlace(placing,tile.x,tile.y)){
    let b=BLDGS[placing];
    if(!canAfford(0,b.cost)){showMsg('Not enough resources!');placing=null;return;}
    spendCost(0,b.cost);
    let bldg=createBuilding(placing,tile.x,tile.y,0);
    bldg.complete=false;bldg.buildProgress=0;
    vils.forEach(v=>{
      v.buildQueue = v.buildQueue || [];
      v.buildQueue.push(bldg.id);
      // Start construction task immediately if not already building
      if(v.task!=='build'||!v.buildTarget){
        v.task='build';v.buildTarget=bldg.id;v.target=null;
        let px=b.isFarm?tile.x:tile.x+b.w, py=b.isFarm?tile.y:tile.y+b.h;
        pathUnitTo(v,px,py);
      }
    });
    
    // Hold Shift to place multiple building foundations
    if(!keys['Shift']){
      placing=null;
    } else {
      showMsg('Place next foundation (release Shift to finish)');
    }
  } else {
    showMsg('Can\'t build here!');
  }
}

// ---- CAMERA SCROLL (Desktop) ----
let mouseInGame=false;
C.addEventListener('mouseenter',()=>{mouseInGame=true;});
C.addEventListener('mouseleave',()=>{mouseInGame=false;});

function handleScroll(){
  if(gameOver)return;
  let spd=8;
  if(keys['w']||keys['ArrowUp'])camY-=spd;
  if(keys['s']||keys['ArrowDown'])camY+=spd;
  if(keys['a']||keys['ArrowLeft'])camX-=spd;
  if(keys['d']||keys['ArrowRight'])camX+=spd;
  // AoE2-style edge scrolling (desktop only).
  // Bottom boundary is the game viewport edge (topH+H), not window bottom, so
  // mousing over the UI panel doesn't accidentally scroll the camera.
  if(!isMobile&&mouseInGame){
    let edge=5;
    if(mouseX<edge)camX-=spd;
    if(mouseX>W-edge)camX+=spd;
    if(mouseY<topH+edge)camY-=spd;
    if(mouseY>topH+H-edge)camY+=spd;
  }
}

// ---- RESIZE ----
window.addEventListener('resize',()=>{
  W=window.innerWidth;
  bottomH=isMobile?(W<=380?130:W<=600?150:200):200;
  topH=isMobile?(W<=600?28:32):32;
  H=window.innerHeight-bottomH;
  C.width=W*dpr;C.height=window.innerHeight*dpr;
  C.style.width=W+'px';C.style.height=window.innerHeight+'px';
  X.scale(dpr,dpr);
});
