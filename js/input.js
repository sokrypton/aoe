// ==============================
// ---- INPUT: MOUSE (Desktop) ----
// ==============================
let keys={};
let isDragging=false;
let hasTouch=false; // set true on first touch, suppresses mouse
let justPlaced=false; // flag to prevent mouseup selection clearing when placing buildings

function selectTownCenter() {
  if (gameOver) return;
  let tcs = entities.filter(e => e.team === 0 && e.type === 'building' && e.btype === 'TC');
  if (tcs.length === 0) return;
  
  window.lastTCIndex = window.lastTCIndex || 0;
  let tc = tcs[window.lastTCIndex % tcs.length];
  window.lastTCIndex++;
  
  selected = [tc];
  
  // Center camera on Town Center
  let iso = toIso(tc.x + tc.w/2, tc.y + tc.h/2);
  camX = iso.ix;
  camY = iso.iy;
  window.targetCamX = camX;
  window.targetCamY = camY;
  window.cameraFollowId = null;
  
  if (window.playSound) window.playSound('select_military');
  updateUI();
}

document.addEventListener('keydown',e=>{
  if(gameOver)return;
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  keys[e.key]=true;
  let key = e.key.toLowerCase();
  
  if (key === 'h') {
    selectTownCenter();
    return;
  }
  if (e.key === '.' || e.key === ',') {
    if (window.selectIdleVillager) window.selectIdleVillager();
    return;
  }
  
  if(e.key==='Escape'){placing=null;selected=[];window.settingRally=false;updateUI();}
  if(e.key==='Delete'||e.key==='Backspace'){
    selected.forEach(en=>{
      if(en.team===0){
        en.hp=0;
        if(typeof handleDeath==='function')handleDeath(en,1);
      }
    });
    selected=[];
    updateUI();
  }
  
  // Villager building hotkeys (Grid-style like AoE2 Definitive Edition)
  let hasVil = selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
  if(hasVil) {
    window.currentVillagerMenu = window.currentVillagerMenu || 'main';
    if(window.currentVillagerMenu === 'main') {
      if(key==='q') {
        window.currentVillagerMenu = 'eco';
        updateUI();
      } else if(key==='w') {
        window.currentVillagerMenu = 'mil';
        updateUI();
      }
    } else if(window.currentVillagerMenu === 'eco') {
      if(key==='q') { placing='HOUSE'; showMsg('Place House'); }
      else if(key==='w') { placing='LCAMP'; showMsg('Place Lumber Camp'); }
      else if(key==='e') { placing='MCAMP'; showMsg('Place Mining Camp'); }
      else if(key==='r') { placing='MILL'; showMsg('Place Mill'); }
      else if(key==='t') { placing='FARM'; showMsg('Place Farm'); }
      else if(key==='Escape') { window.currentVillagerMenu = 'main'; updateUI(); }
    } else if(window.currentVillagerMenu === 'mil') {
      if(key==='q') { placing='BARRACKS'; showMsg('Place Barracks'); }
      else if(key==='w') { placing='TOWER'; showMsg('Place Watch Tower'); }
      else if(key==='e') { placing='WALL'; showMsg('Place Stone Wall'); }
      else if(key==='r') { placing='GATE'; showMsg('Place Gate'); }
      else if(key==='Escape') { window.currentVillagerMenu = 'main'; updateUI(); }
    }
  }
  
  // Training hotkeys for selected buildings
  if (selected.length > 0 && selected[0].type === 'building' && selected[0].team === 0 && selected[0].complete) {
    let bldg = selected[0];
    if (bldg.btype === 'TC') {
      if (key === 'v') {
        trainUnit(bldg, 'villager');
      }
    } else if (bldg.btype === 'BARRACKS') {
      if (key === 'm') trainUnit(bldg, 'militia');
      else if (key === 's') trainUnit(bldg, 'spearman');
      else if (key === 'a') trainUnit(bldg, 'archer');
      else if (key === 'c') trainUnit(bldg, 'scout');
    }
  }
});
document.addEventListener('keyup',e=>{keys[e.key]=false;});

window.isDraggingWall = false;
window.wallDragStart = null;
window.wallDragEnd = null;
window.wallDragCorner = null;
window.wallPrimaryAxis = null;

// Builds an elbow (two straight segments) from start->corner->end, so a
// drag that changes direction partway through (e.g. right, then down)
// projects both legs plus the corner tile, instead of collapsing to a
// single straight line toward the final cursor position.
function getWallElbowTiles(start, corner, end){
  let leg1 = getLineTiles(start, corner);
  let leg2 = getLineTiles(corner, end);
  if (leg2.length && leg1.length && leg2[0].x === leg1[leg1.length-1].x && leg2[0].y === leg1[leg1.length-1].y) {
    leg2 = leg2.slice(1);
  }
  return leg1.concat(leg2);
}

// Wall-drag: shared by mouse (drag) and touch (drag) so a line of walls can
// be laid out in one gesture on both input methods, instead of one tile per
// tap/click. A zero-length drag (touchstart+touchend with no movement, or a
// plain click) degenerates to a single wall tile via getLineTiles' steps===0
// case, so this also fully replaces the old single-tap-places-one-wall path.
function startWallDrag(sx,sy){
  let tile = screenToTile(sx, sy);
  window.isDraggingWall = true;
  window.wallDragStart = tile;
  window.wallDragEnd = tile;
  window.wallDragCorner = tile;
  window.wallPrimaryAxis = null;
}
function updateWallDrag(sx,sy){
  let tile = screenToTile(sx, sy);
  let start = window.wallDragStart;
  let dx = tile.x - start.x;
  let dy = tile.y - start.y;
  // Lock which axis the player committed to first (once they've moved at
  // least a tile), so later movement on the other axis becomes the second
  // leg of an elbow instead of re-snapping the whole drag to one straight line.
  if (window.wallPrimaryAxis === null && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) {
    window.wallPrimaryAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  }
  window.wallDragEnd = tile;
  if (window.wallPrimaryAxis === 'y') {
    window.wallDragCorner = { x: start.x, y: tile.y };
  } else {
    window.wallDragCorner = { x: tile.x, y: start.y };
  }
}
// Cancel a wall-drag in progress without placing anything (e.g. a second
// finger joins mid-gesture on touch).
function abortWallDrag(){
  window.isDraggingWall = false;
  window.wallDragStart = null;
  window.wallDragEnd = null;
  window.wallDragCorner = null;
  window.wallPrimaryAxis = null;
}
function finalizeWallDrag(){
  window.isDraggingWall = false;
  let start = window.wallDragStart;
  let end = window.wallDragEnd;
  let corner = window.wallDragCorner || end;
  window.wallDragStart = null;
  window.wallDragEnd = null;
  window.wallDragCorner = null;
  window.wallPrimaryAxis = null;

  let line = getWallElbowTiles(start, corner, end);
  let vils = selected.filter(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
  if(vils.length===0){
    showMsg('Select a villager to build!');
    placing=null;
    return;
  }

  let b = BLDGS['WALL'];
  let placedCount = 0;
  let lastBldg = null;

  line.forEach(t => {
    if (canPlace('WALL', t.x, t.y, 0)) {
      let actualCost = {...b.cost};
      if (canAfford(0, actualCost)) {
        spendCost(0, actualCost);
        let bldg = createBuilding('WALL', t.x, t.y, 0);
        bldg.complete = false;
        bldg.buildProgress = 0;
        lastBldg = bldg;
        placedCount++;

        vils.forEach(v => {
          v.buildQueue = v.buildQueue || [];
          v.buildQueue.push(bldg.id);
        });
      } else {
        showMsg('Not enough stone!');
      }
    }
  });

  if (placedCount > 0 && lastBldg) {
    vils.forEach(v => {
      if (v.task !== 'build' || !v.buildTarget) {
        v.task = 'build';
        v.buildTarget = lastBldg.id;
        v.target = null;
        pathUnitTo(v, lastBldg.x + 1, lastBldg.y + 1);
      }
    });
  }

  // keys['Shift'] (hold to place multiple lines) is desktop-only — on touch
  // that object entry is simply never set, so this naturally always exits
  // placing mode after one drag, which is the right default for mobile.
  if (!keys['Shift']) {
    placing = null;
  }
}

// Belt-and-suspenders reset: a mouseup that lands on some OTHER element
// (topbar, bottom HUD, outside the browser window, etc.) never reaches C's
// own mouseup handler below, which would otherwise leave minimapDragging
// stuck true forever — every subsequent mousemove would keep panning the
// camera to follow the cursor with no way to stop it. A window-level
// listener catches mouseup regardless of where it lands (as long as it
// bubbles, which plain releases always do) and unconditionally clears it.
window.addEventListener('mouseup',()=>{minimapDragging=false;});
// Same reasoning for tracking the drag itself: C's own mousemove only fires
// while the cursor is physically over the canvas, so dragging up into the
// topbar (or off the edge of the browser window) would silently freeze the
// pan mid-gesture until the cursor wandered back onto C. A window-level
// mousemove keeps the camera following the cursor everywhere, matching how
// the release above already works regardless of where it lands.
window.addEventListener('mousemove',e=>{
  if(minimapDragging) minimapJump(e.clientX,e.clientY);
});

C.addEventListener('mousedown',e=>{
  if(gameOver||hasTouch)return; // ignore synthetic mouse events
  if(e.button===0 && !e.ctrlKey){
    // Placing/wall-dragging always takes priority over the minimap — the
    // minimap should never block or interfere with an action already in
    // progress, only offer camera-panning when nothing else claims the click.
    if(placing){
      if (placing === 'WALL') {
        startWallDrag(e.clientX, e.clientY);
        justPlaced = true;
      } else {
        doPlace(e.clientX,e.clientY);
        justPlaced=true;
      }
      return;
    }
    if(isPointOnMinimap(e.clientX,e.clientY)){
      minimapDragging=true;
      minimapJump(e.clientX,e.clientY);
      return;
    }
    dragStart={x:e.clientX,y:e.clientY};dragEnd=null;isDragging=false;
    justPlaced=false;
  }
});
C.addEventListener('mousemove',e=>{
  if(gameOver||hasTouch)return;
  mouseX=e.clientX;mouseY=e.clientY;
  if(minimapDragging)return; // handled by the window-level listener above
  if (window.isDraggingWall) {
    updateWallDrag(e.clientX, e.clientY);
    return;
  }
  if(dragStart&&(e.buttons&1)){
    dragEnd={x:e.clientX,y:e.clientY};
    if(Math.abs(dragEnd.x-dragStart.x)+Math.abs(dragEnd.y-dragStart.y)>8){
      if(!isDragging){
        isDragging=true;
        // Visual-only cue now (the minimap can't actually intercept the
        // drag anymore — it's pointer-events:none) — dims it so it's clear
        // dragging over it won't do anything special.
        let mw=document.getElementById('minimap-wrap');
        if(mw)mw.classList.add('drag-select-active');
      }
    }
  }
});
// Track mouse position globally so edge scroll works correctly when cursor is over UI panels
document.addEventListener('mousemove',e=>{if(!gameOver){mouseX=e.clientX;mouseY=e.clientY;}});
// A trackpad two-finger swipe and a literal mouse wheel notch both arrive
// as plain 'wheel' events with no dedicated flag telling them apart —
// pinch/spread is the only unambiguous case (browsers set ctrlKey:true
// specifically so apps can detect it). This is the same well-known
// heuristic mapbox-gl's scroll-zoom handler uses for exactly this
// distinction: Chrome/Safari also expose the legacy wheelDeltaY alongside
// the standard deltaY, and for a trackpad swipe they derive it as exactly
// wheelDeltaY = -3 * deltaY — a ratio a physical wheel notch essentially
// never produces (wheelDeltaY there is a fixed step, e.g. ±120,
// independent of deltaY's own magnitude). Firefox doesn't expose
// wheelDelta* at all; there, deltaMode 0 (pixel-based) is trackpad-typical
// while a real wheel reports deltaMode 1 (line-based).
function isTrackpadWheel(e){
  if(e.wheelDeltaY!==undefined) return e.wheelDeltaY===e.deltaY*-3;
  return e.deltaMode===0;
}
C.addEventListener('wheel',e=>{
  if(gameOver)return;
  e.preventDefault();
  if(e.ctrlKey){
    // Pinch/spread — zoom, regardless of device (trackpad gesture or an
    // actual Ctrl+wheel).
    let factor=e.deltaY<0?1.02:1/1.02;
    setZoomAroundPoint(ZOOM*factor,mouseX,mouseY);
    return;
  }
  if(isTrackpadWheel(e)){
    // Two-finger trackpad swipe (no pinch) — pan the view, same convention
    // as Google Maps/Figma: the camera follows the scroll direction.
    camX+=e.deltaX/ZOOM; camY+=e.deltaY/ZOOM;
    window.cameraFollowId=null;
    return;
  }
  // An actual mouse wheel notch — zoom, unchanged from before.
  let factor=e.deltaY<0?1.02:1/1.02;
  setZoomAroundPoint(ZOOM*factor,mouseX,mouseY);
},{passive:false});
C.addEventListener('mouseup',e=>{
  if(gameOver||hasTouch)return;
  if(e.button===0 && !e.ctrlKey){
    if(minimapDragging){
      minimapDragging=false;
      return;
    }
    if (window.isDraggingWall) {
      finalizeWallDrag();
      justPlaced = false;
      return;
    }
    if(placing)return;
    if(justPlaced){
      justPlaced=false;
      return;
    }
    if(isDragging&&dragStart&&dragEnd){
      doBoxSelect(dragStart.x,dragStart.y,dragEnd.x,dragEnd.y);
    } else {
      if (window.settingRally) {
        let bldg = selected[0];
        let bData = bldg && BLDGS[bldg.btype];
        if(bldg && bldg.type==='building' && bldg.team===0 && bData && bData.builds && bData.builds.length>0){
          doCommand(e.clientX, e.clientY);
        }
        window.settingRally = false;
        updateUI();
      } else {
        doSelect(e.clientX,e.clientY,e.shiftKey);
      }
    }
    dragStart=null;dragEnd=null;isDragging=false;
    let mw=document.getElementById('minimap-wrap');
    if(mw)mw.classList.remove('drag-select-active');
  }
});
document.addEventListener('contextmenu',e=>{
  e.preventDefault();
  if(gameOver||hasTouch)return;
  if(e.target===C){
    if(isPointOnMinimap(e.clientX,e.clientY))return; // right-click over the minimap is a no-op, not a world command
    window.settingRally=false; // right-click itself handles rally; clear the flag
    doCommand(e.clientX,e.clientY);
  }
});

// ==============================
// ---- INPUT: TOUCH (Mobile) ----
// ==============================
// Simple scheme:
//   Drag = pan camera
//   Drag while placing a wall = lay a line of walls (same as the desktop drag)
//   Long-press (~380ms) then drag, starting on empty ground = box-select
//   Quick tap = context-aware:
//     - placing mode → place building
//     - nothing selected → select entity under finger
//     - units selected + tap own unit → switch selection
//     - units selected + tap own building → command (farm/repair/etc.)
//     - units selected + tap map → move/gather/attack (command)
//     - building selected + tap elsewhere → try select, or deselect
//   Double-tap on an own unit = select every unit of that type on screen
//     (touch equivalent of the desktop double-click handler below)

let touchAnchor=null;  // where the touch started (for tap detection)
let touchLast=null;    // last touch position (for pan delta)
let touchMoved=false;  // did finger travel > threshold?
let touchId=null;      // track which finger is primary
let pinchStartDist=null; // two-finger distance at pinch start, for pinch-zoom
let pinchStartZoom=null; // ZOOM at pinch start
let touchLongPressTimer=null; // arms box-select if the finger holds still on empty ground
let touchBoxSelectMode=false; // armed (and possibly active) box-select drag
let touchLastTapTime=0;       // for double-tap detection
let touchLastTapUtype=null;   // utype of the unit tapped last, if any

C.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(gameOver)return;
  hasTouch=true;
  let touches=e.touches;
  if(touches.length===1){
    let t=touches[0];
    // Placing/wall-dragging always takes priority over the minimap — see
    // the matching comment on the mouse path above.
    if(!placing && isPointOnMinimap(t.clientX,t.clientY)){
      minimapDragging=true;
      minimapJump(t.clientX,t.clientY);
      return;
    }
    touchId=t.identifier;
    touchAnchor={x:t.clientX,y:t.clientY};
    touchLast={x:t.clientX,y:t.clientY};
    touchMoved=false;
    mouseX=t.clientX;mouseY=t.clientY; // for ghost preview

    if(placing==='WALL'){
      startWallDrag(t.clientX,t.clientY);
    } else if(!placing){
      // Arm long-press box-select only when the touch starts on empty
      // ground — starting on a unit/building should never hijack a tap or
      // pan into a selection box.
      clearTimeout(touchLongPressTimer);
      touchBoxSelectMode=false;
      let hitU=getUnitUnderCursor(t.clientX,t.clientY);
      let hitB=hitU?null:getBuildingUnderCursor(t.clientX,t.clientY);
      if(!hitU&&!hitB){
        let anchorAtArm=touchAnchor;
        touchLongPressTimer=setTimeout(()=>{
          if(touchAnchor===anchorAtArm && !touchMoved){
            touchBoxSelectMode=true;
            dragStart={x:touchAnchor.x,y:touchAnchor.y};
            dragEnd=null;
            isDragging=false;
          }
        },380);
      }
    }
  }
  if(touches.length>=2){
    // Multi-touch: always pan/pinch, cancel any tap or single-finger gesture
    // that was in progress (box-select arm/drag, wall-drag).
    touchMoved=true;
    touchAnchor=null;
    clearTimeout(touchLongPressTimer);
    touchBoxSelectMode=false;
    dragStart=null;dragEnd=null;isDragging=false;
    minimapDragging=false;
    if(window.isDraggingWall)abortWallDrag();
    let mx=(touches[0].clientX+touches[1].clientX)/2;
    let my=(touches[0].clientY+touches[1].clientY)/2;
    touchLast={x:mx,y:my};
    let pdx=touches[0].clientX-touches[1].clientX;
    let pdy=touches[0].clientY-touches[1].clientY;
    pinchStartDist=Math.sqrt(pdx*pdx+pdy*pdy);
    pinchStartZoom=ZOOM;
  }
},{passive:false});

C.addEventListener('touchmove',e=>{
  e.preventDefault();
  let touches=e.touches;
  if(touches.length>=2){
    // Two-finger pinch-to-zoom (around the midpoint), then pan
    let mx=(touches[0].clientX+touches[1].clientX)/2;
    let my=(touches[0].clientY+touches[1].clientY)/2;
    let pdx=touches[0].clientX-touches[1].clientX;
    let pdy=touches[0].clientY-touches[1].clientY;
    let pdist=Math.sqrt(pdx*pdx+pdy*pdy);
    if(pinchStartDist&&Math.abs(pdist-pinchStartDist)>4){ // deadzone avoids jitter zoom during pure pans
      setZoomAroundPoint(pinchStartZoom*(pdist/pinchStartDist),mx,my);
    }
    if(touchLast){
      camX-=(mx-touchLast.x);
      camY-=(my-touchLast.y);
      window.cameraFollowId=null;
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

    if(minimapDragging){
      minimapJump(t.clientX,t.clientY);
      return;
    }

    if(window.isDraggingWall){
      updateWallDrag(t.clientX,t.clientY);
      touchMoved=true;
      return;
    }

    // Check if we've moved past the tap threshold
    if(touchAnchor){
      let dx=t.clientX-touchAnchor.x;
      let dy=t.clientY-touchAnchor.y;
      if(Math.abs(dx)+Math.abs(dy)>10){
        touchMoved=true;
      }
    }

    if(touchBoxSelectMode){
      dragEnd={x:t.clientX,y:t.clientY};
      if(Math.abs(dragEnd.x-dragStart.x)+Math.abs(dragEnd.y-dragStart.y)>8){
        if(!isDragging){
          isDragging=true;
          let mw=document.getElementById('minimap-wrap');
          if(mw)mw.classList.add('drag-select-active');
        }
      }
      touchLast={x:t.clientX,y:t.clientY};
      return; // don't also pan the camera while dragging a selection box
    }

    // Pan the camera once we know it's a drag
    if(touchMoved&&touchLast){
      let dx=t.clientX-touchLast.x;
      let dy=t.clientY-touchLast.y;
      camX-=dx;
      camY-=dy;
      window.cameraFollowId=null;
    }
    touchLast={x:t.clientX,y:t.clientY};
  }
},{passive:false});

C.addEventListener('touchend',e=>{
  e.preventDefault();
  // Only process tap when all fingers are lifted
  if(e.touches.length===0){
    clearTimeout(touchLongPressTimer);
    if(minimapDragging){
      minimapDragging=false;
    } else if(window.isDraggingWall){
      finalizeWallDrag();
    } else if(touchBoxSelectMode && isDragging && dragStart && dragEnd){
      doBoxSelect(dragStart.x,dragStart.y,dragEnd.x,dragEnd.y);
      let mw=document.getElementById('minimap-wrap');
      if(mw)mw.classList.remove('drag-select-active');
    } else if(!touchMoved&&touchAnchor){
      // It's a tap! Double-tap on the same own unit type selects every
      // instance of that type on screen (touch equivalent of dblclick below).
      let now=performance.now();
      let tappedU=getUnitUnderCursor(touchAnchor.x,touchAnchor.y);
      if(tappedU && tappedU.team===0 && touchLastTapUtype===tappedU.utype && (now-touchLastTapTime)<380){
        selected=entities.filter(en=>en.team===0&&en.type==='unit'&&en.utype===tappedU.utype&&isUnitOnScreen(en));
        if(window.playSound){
          if(tappedU.utype==='villager')window.playSound('select_villager');
          else if(tappedU.utype!=='sheep')window.playSound('select_military');
        }
        updateUI();
        touchLastTapTime=0;
        touchLastTapUtype=null;
      } else {
        handleTap(touchAnchor.x,touchAnchor.y);
        touchLastTapTime=now;
        touchLastTapUtype=tappedU?tappedU.utype:null;
      }
    }
    touchAnchor=null;
    touchLast=null;
    touchMoved=false;
    touchId=null;
    pinchStartDist=null;
    pinchStartZoom=null;
    touchBoxSelectMode=false;
    dragStart=null;dragEnd=null;isDragging=false;
  } else if(e.touches.length===1){
    // Went from 2 fingers to 1: update last position, stay in pan mode
    let t=e.touches[0];
    touchLast={x:t.clientX,y:t.clientY};
    touchMoved=true; // don't allow tap after multi-touch
    pinchStartDist=null;
    pinchStartZoom=null;
  }
},{passive:false});

// Context-aware tap handler for mobile
function handleTap(sx,sy){
  // 1. If placing a building, place it
  if(placing){
    doPlace(sx,sy);
    return;
  }

  // 2. If in rally-setting mode, set the rally point on tap
  if(window.settingRally){
    let bldg = selected[0];
    let bData = bldg && BLDGS[bldg.btype];
    if(bldg && bldg.type==='building' && bldg.team===0 && bData && bData.builds && bData.builds.length>0){
      doCommand(sx, sy);
    }
    window.settingRally = false;
    updateUI();
    return;
  }

  let tile=screenToTile(sx,sy);
  let hitR=20; // generous hit area for fingers

  // Find what's under the tap
  let tappedOwn=null;    // own unit or building
  let tappedEnemy=null;  // enemy unit or building

  // Check units first (higher priority)
  let tappedUnit = getUnitUnderCursor(sx, sy);
  if (tappedUnit) {
    if (tappedUnit.team === 0) tappedOwn = tappedUnit;
    else tappedEnemy = tappedUnit;
  }
  // Then buildings
  if(!tappedOwn&&!tappedEnemy){
    let tappedB = getBuildingUnderCursor(sx, sy);
    if (tappedB) {
      if(tappedB.team===0) tappedOwn = tappedB;
      else tappedEnemy = tappedB;
    }
  }

  // 3. Nothing selected → just select
  if(selected.length===0){
    if(tappedOwn||tappedEnemy) {
      selected=[tappedOwn||tappedEnemy];
      if (window.playSound && (tappedOwn || tappedEnemy).team === 0) {
        let clicked = tappedOwn || tappedEnemy;
        if (clicked.type === 'unit') {
          if (clicked.utype === 'villager') window.playSound('select_villager');
          else if (clicked.utype === 'sheep') window.playSound('sheep');
          else window.playSound('select_military');
        }
      }
    }
    return;
  }

  // 4. Have units selected
  let haveUnits=selected.some(s=>s.type==='unit'&&s.team===0);
  let haveVillagers=selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
  if(haveUnits){
    // Tapped on own sheep with villagers → harvest command
    if(tappedOwn&&tappedOwn.utype==='sheep'&&haveVillagers){
      doCommand(sx,sy);
      return;
    }
    // Tapped on another own UNIT → switch selection (quick re-pick). Tapping
    // an own BUILDING instead falls through to doCommand below — so a
    // selected villager tapping a farm/mill/damaged building actually
    // works it instead of just re-selecting the building and doing nothing.
    if(tappedOwn&&tappedOwn.type==='unit'){
      window.settingRally=false;
      selected=[tappedOwn];
      if (window.playSound && tappedOwn.team === 0) {
        if (tappedOwn.utype === 'villager') window.playSound('select_villager');
        else if (tappedOwn.utype === 'sheep') window.playSound('sheep');
        else window.playSound('select_military');
      }
      return;
    }
    // Tapped on enemy, own building, or empty map → command (move/gather/
    // build/repair/attack) — doCommand resolves the exact target itself.
    doCommand(sx,sy);
    return;
  }

  // 5. Have a building selected (not units)
  if(tappedOwn){
    // Switching selection cancels rally mode
    window.settingRally=false;
    selected=[tappedOwn];
    if (window.playSound && tappedOwn.team === 0) {
      if (tappedOwn.type === 'unit') {
        if (tappedOwn.utype === 'villager') window.playSound('select_villager');
        else if (tappedOwn.utype === 'sheep') window.playSound('sheep');
        else window.playSound('select_military');
      }
    }
  } else if(tappedEnemy){
    window.settingRally=false;
    selected=[tappedEnemy];
  } else {
    // Tapped empty map -> deselect
    window.settingRally=false;
    selected=[];
  }
}

// Minimap: works with both mouse and touch dragging
let minimapDragging = false;

// Returns true when canvas-local point (mx,my) falls inside the isometric
// diamond that represents the map. The minimap canvas is square but the
// playable area is only the diamond in the centre — corner regions are empty.
function isInMinimapDiamond(mx, my, mw, mh) {
  let mt = getMiniTransform(mw, mh);
  let hw = MAP * HALF_TW * mt.scale; // diamond horizontal half-width
  let hh = MAP * HALF_TH * mt.scale; // diamond vertical half-height
  let cx = mt.ox;       // horizontal centre = mw/2
  let cy = mt.oy + hh;  // vertical centre   = pad + hh from top
  return (Math.abs(mx - cx) / hw + Math.abs(my - cy) / hh) <= 1;
}

// The minimap wrap/canvas are pointer-events:none (see styles.css) so the
// game canvas underneath always receives every click/tap, everywhere on
// screen, including over the visible minimap. This is the single check its
// input handlers use to decide "is this point actually the minimap" (its
// diamond, not just its square footprint) before treating (clientX,clientY)
// as a minimap pan instead of a game-world coordinate.
function isPointOnMinimap(clientX, clientY) {
  let rect = MC.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
  let mw = MC.clientWidth || rect.width, mh = MC.clientHeight || rect.height;
  let mx = (clientX - rect.left) / rect.width * mw;
  let my = (clientY - rect.top) / rect.height * mh;
  return isInMinimapDiamond(mx, my, mw, mh);
}

function minimapJump(sx, sy) {
  let rect = MC.getBoundingClientRect();
  let mw = MC.clientWidth  || rect.width;
  let mh = MC.clientHeight || rect.height;
  // Canvas-local coordinates of the click
  let mx = (sx - rect.left) / rect.width  * mw;
  let my = (sy - rect.top)  / rect.height * mh;

  // Only apply the diamond hit-test for fresh clicks, not for an ongoing drag.
  // Once dragging has started inside the diamond, the cursor is free to roam
  // outside the minimap canvas until the mouse/touch is released.
  if (!minimapDragging && !isInMinimapDiamond(mx, my, mw, mh)) return;

  // When cursor is outside the minimap canvas during a drag, clamp canvas
  // coordinates so miniToMap still produces a valid map position.
  mx = Math.max(0, Math.min(mw, mx));
  my = Math.max(0, Math.min(mh, my));

  let p = miniToMap(mx, my, mw, mh);
  // Clamp to map bounds so dragging past the edge snaps to the corner
  p.x = Math.max(0, Math.min(MAP, p.x));
  p.y = Math.max(0, Math.min(MAP, p.y));
  let iso = toIso(p.x, p.y);
  camX = iso.ix; camY = iso.iy;
  window.targetCamX = camX; window.targetCamY = camY;
  // Manual camera jump should release camera-follow, same as any other
  // manual pan — otherwise handleScroll() snaps straight back to the
  // followed unit on the very next frame and the minimap click does nothing.
  window.cameraFollowId = null;
}

function toggleMinimap(){
  let wrap = document.getElementById('minimap-wrap');
  if(wrap) {
    let expanded = wrap.classList.toggle('minimap-expanded');
    // Light the map button up while expanded so it clearly reads as an
    // active toggle that can be pressed again to exit.
    let btn = document.getElementById('map-btn');
    if(btn) btn.classList.toggle('map-active', expanded);
    if(window.playSound) window.playSound('click');
  }
}

// Must match the max-width in the "#minimap-wrap:not(.minimap-expanded)
// {display:none}" media query in styles.css — that's the width below which
// the small corner minimap has no room and the full-screen toggle exists at all.
const MINIMAP_SMALL_BREAKPOINT = 600;
// The expanded state is a manual toggle, so it otherwise persists forever —
// if a phone is rotated from portrait (narrow, expanded map in use) to
// landscape (wide enough for the small corner map again), the expanded
// view would stay stuck full-screen with no visual reason to. Collapse it
// automatically the moment the viewport grows past the breakpoint where
// the small map becomes viable again; never force it open, only closed.
function collapseMinimapIfWide(){
  if(window.innerWidth <= MINIMAP_SMALL_BREAKPOINT) return;
  let wrap = document.getElementById('minimap-wrap');
  if(wrap && wrap.classList.contains('minimap-expanded')){
    wrap.classList.remove('minimap-expanded');
    let btn = document.getElementById('map-btn');
    if(btn) btn.classList.remove('map-active');
  }
}
window.addEventListener('resize', collapseMinimapIfWide);
window.addEventListener('orientationchange', collapseMinimapIfWide);

function focusTownCenter(){
  if(gameOver)return;
  let tc = entities.find(e => e.type === 'building' && e.team === 0 && e.btype === 'TC');
  if(tc) {
    // TC is 3x3 tiles, so center is +1.5 tiles
    let iso = toIso(tc.x + 1.5, tc.y + 1.5);
    camX = iso.ix;
    camY = iso.iy;
    window.targetCamX = camX;
    window.targetCamY = camY;
    window.cameraFollowId = null;
    if(window.playSound) window.playSound('click');
  }
}

// No listeners on MC itself — it's pointer-events:none, so every click/tap
// (even ones that visually land on the minimap) is handled by C's own
// mousedown/mouseup/contextmenu/touch* listeners below, which check
// isPointOnMinimap() first and branch to minimapJump() when it's true.

// ==============================
// ---- SHARED INPUT ACTIONS ----
// ==============================
function getBuildingUnderCursor(sx, sy, filter) {
  // BLDG_HEIGHTS is a shared global — see core.js.
  let bestB = null;
  let bestSortY = -9999;
  entities.forEach(en=>{
    if(en.type==='building' && (!filter || filter(en))){
      let w = en.w !== undefined ? en.w : BLDGS[en.btype].w;
      let h = en.h !== undefined ? en.h : BLDGS[en.btype].h;
      let cx = en.x + w / 2;
      let cy = en.y + h / 2;
      let iso = toIso(cx, cy);
      let scrx = (iso.ix - camX) * ZOOM + W/2;
      let scry = (iso.iy - camY) * ZOOM + H/2 + topH;
      let bw = w * 32 * ZOOM;
      let bhh = h * 16 * ZOOM;
      let height = (BLDG_HEIGHTS[en.btype] || 25) * ZOOM;
      
      if(sx >= scrx - bw && sx <= scrx + bw && sy >= scry - bhh - height && sy <= scry + bhh) {
        let sortY = cy + cx;
        if (sortY > bestSortY) {
          bestSortY = sortY;
          bestB = en;
        }
      }
    }
  });
  return bestB;
}

function getUnitUnderCursor(sx, sy) {
  let bestU = null;
  let bestSortY = -9999;
  let extraHit = isMobile ? 6 * ZOOM : 0;

  entities.forEach(en => {
    if (en.type === 'unit' && !en.garrisonedIn) {
      let eux = Math.round(en.x), euy = Math.round(en.y);
      let uf = (eux >= 0 && eux < MAP && euy >= 0 && euy < MAP) ? fog[euy][eux] : 0;
      if (en.team !== 0 && uf !== 2) return;

      let iso = toIso(en.x, en.y);
      let { ox, oy } = getUnitGroupOffset(en.id);
      let scrx = (iso.ix - camX + ox) * ZOOM + W/2;
      let scry = (iso.iy - camY + HALF_TH + oy) * ZOOM + H/2 + topH;

      let w = 10 * ZOOM + extraHit;
      let hStart = 2 * ZOOM + extraHit;
      let hEnd = -28 * ZOOM - extraHit;

      if (en.utype === 'sheep' || en.utype === 'sheep_carcass') {
        w = 16 * ZOOM + extraHit;
        hStart = 2 * ZOOM + extraHit;
        hEnd = -16 * ZOOM - extraHit;
      }

      let dx = sx - scrx;
      let dy = sy - scry;
      if (Math.abs(dx) <= w && dy <= hStart && dy >= hEnd) {
        let sortY = en.y + en.x;
        if (sortY > bestSortY) {
          bestSortY = sortY;
          bestU = en;
        }
      }
    }
  });
  return bestU;
}

function getResourceUnderCursor(sx, sy) {
  let tile = screenToTile(sx, sy);
  let bestRes = null;
  let bestSortY = -9999;
  
  let searchRadius = 3;
  for (let dy = -1; dy <= searchRadius; dy++) {
    for (let dx = -1; dx <= searchRadius; dx++) {
      let tx = tile.x + dx;
      let ty = tile.y + dy;
      if (!inMapBounds(tx, ty)) continue;
      
      let t0 = map[ty][tx];
      if (!t0) continue;
      
      let isForest = t0.t === TERRAIN.FOREST;
      let isGold = t0.t === TERRAIN.GOLD;
      let isStone = t0.t === TERRAIN.STONE;
      let isBerries = t0.t === TERRAIN.BERRIES;
      let isFarm = t0.t === TERRAIN.FARM;
      
      if (isForest || isGold || isStone || isBerries || isFarm) {
        let iso = toIso(tx + 0.5, ty + 0.5);
        let scrx = (iso.ix - camX) * ZOOM + W/2;
        let scry = (iso.iy - camY + HALF_TH) * ZOOM + H/2 + topH;
        
        let w = 12 * ZOOM;
        let hStart = 2 * ZOOM;
        let hEnd = -20 * ZOOM;
        
        if (isForest) {
          w = 12 * ZOOM;
          hStart = 4 * ZOOM;
          hEnd = -50 * ZOOM;
        } else if (isGold || isStone) {
          w = 16 * ZOOM;
          hStart = 2 * ZOOM;
          hEnd = -18 * ZOOM;
        } else if (isBerries) {
          w = 14 * ZOOM;
          hStart = 2 * ZOOM;
          hEnd = -22 * ZOOM;
        } else if (isFarm) {
          w = 28 * ZOOM;
          hStart = 8 * ZOOM;
          hEnd = -8 * ZOOM;
        }
        
        let clickDx = sx - scrx;
        let clickDy = sy - scry;
        if (Math.abs(clickDx) <= w && clickDy <= hStart && clickDy >= hEnd) {
          let sortY = ty + tx;
          if (sortY > bestSortY) {
            bestSortY = sortY;
            bestRes = { x: tx, y: ty, type: t0.t };
          }
        }
      }
    }
  }
  return bestRes;
}

function doSelect(sx,sy,shift){
  let tile=screenToTile(sx,sy);
  let clicked=getUnitUnderCursor(sx, sy);
  if(clicked && clicked.team!==0){
    let tx = Math.floor(clicked.x), ty = Math.floor(clicked.y);
    let visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && fog[ty][tx] === 2;
    if(!visible) clicked=null;
  }
  if(!clicked){
    clicked = getBuildingUnderCursor(sx, sy);
    // Don't select enemy buildings that aren't visible
    if(clicked && clicked.team!==0 && buildingFogLevel(clicked)!==2) clicked=null;
  }
  if(clicked){
    if(shift){
      if(!selected.some(s=>s.id===clicked.id))selected.push(clicked);
    }
    else selected=[clicked];

    // Play selection sound (player team 0)
    if (clicked.team === 0 && window.playSound) {
      if (clicked.type === 'unit') {
        if (clicked.utype === 'villager') window.playSound('select_villager');
        else if (clicked.utype === 'sheep') window.playSound('sheep');
        else window.playSound('select_military');
      }
    }
  } else {
    if (selected.length > 0 && selected[0].team === 0) {
      showMsg("Use Right-Click (or Ctrl+Click on Mac) to move/command units!");
    }
    selected=[];
  }
}

function doBoxSelect(x1,y1,x2,y2){
  let sx1=Math.min(x1,x2),sy1=Math.min(y1,y2);
  let sx2=Math.max(x1,x2),sy2=Math.max(y1,y2);
  selected=entities.filter(en=>{
    if(en.team!==0)return false;
    if(en.type!=='unit'||en.garrisonedIn)return false;
    let iso=toIso(en.x,en.y);
    let { ox, oy } = getUnitGroupOffset(en.id);
    let scrx=(iso.ix-camX+ox)*ZOOM+W/2;
    let scry=(iso.iy-camY+HALF_TH+oy)*ZOOM+H/2+topH;

    let w = 10 * ZOOM;
    let hStart = 2 * ZOOM;
    let hEnd = -28 * ZOOM;

    if (en.utype === 'sheep' || en.utype === 'sheep_carcass') {
      w = 16 * ZOOM;
      hStart = 2 * ZOOM;
      hEnd = -16 * ZOOM;
    }

    let horizontalOverlap = Math.max(sx1, scrx - w) <= Math.min(sx2, scrx + w);
    let verticalOverlap = Math.max(sy1, scry + hEnd) <= Math.min(sy2, scry + hStart);
    return horizontalOverlap && verticalOverlap;
  });
  let units=selected.filter(s=>s.type==='unit');
  if(units.length>0)selected=units;

  // Play group selection sound
  if (selected.length > 0 && selected[0].team === 0 && window.playSound) {
    let first = selected[0];
    if (first.utype === 'villager') window.playSound('select_villager');
    else if (first.utype === 'sheep') window.playSound('sheep');
    else window.playSound('select_military');
  }
}

function doCommand(sx,sy){
  placing=null; // cancel building placement preview when commanding units
  if(selected.length===0)return;
  let resTarget = getResourceUnderCursor(sx, sy);
  let tile = resTarget ? { x: resTarget.x, y: resTarget.y } : screenToTile(sx, sy);

  // If a friendly training building is selected, right-clicking sets its Rally Point
  if(selected[0].type==='building'&&selected[0].team===0){
    let bldg=selected[0];
    let bData=BLDGS[bldg.btype];
    if(!bData || !bData.builds || bData.builds.length === 0) return;
    if(!inMapBounds(tile.x,tile.y))return;
    bldg.rallyX=tile.x;
    bldg.rallyY=tile.y;
    
    // Find target entity under the click
    let rTarget = getUnitUnderCursor(sx, sy);
    if(!rTarget){
      rTarget = getBuildingUnderCursor(sx, sy);
    }
    
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
  // Check if targeting enemy OR own sheep for harvesting OR own unit to follow
  let target=null;
  let buildTarget=null;
  let followTarget=null;
  
  let clickedUnit = getUnitUnderCursor(sx, sy);
  if (clickedUnit && clickedUnit.team !== 0) {
    let tx = Math.floor(clickedUnit.x), ty = Math.floor(clickedUnit.y);
    let visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && fog[ty][tx] === 2;
    if (!visible) clickedUnit = null;
  }
  if (clickedUnit) {
    if (clickedUnit.team === 1) {
      target = clickedUnit;
    } else if (clickedUnit.utype === 'sheep' || clickedUnit.utype === 'sheep_carcass') {
      target = clickedUnit;
    } else {
      followTarget = clickedUnit;
    }
  }
  if(!target){
    target = getBuildingUnderCursor(sx, sy, en => en.team === 1 && buildingFogLevel(en) === 2);
  }
  if(!target){
    // Repair/build-finish takes priority over "Follow" — a friendly unit
    // merely standing near a damaged building shouldn't hijack the click.
    // Manual garrisoning-by-click was removed for simplicity: the town bell
    // is now the only way villagers garrison, so clicking an own building
    // always means "fix it" (repair if damaged, resume if unfinished).
    buildTarget = getBuildingUnderCursor(sx, sy, en => en.team === 0 && (!en.complete || en.hp < en.maxHp));
  }
  if(buildTarget)followTarget=null;
  if(target && target.utype==='sheep_carcass')markerColor='#ff0';
  else if(target)markerColor='#f44';
  else if(buildTarget)markerColor='#0af';
  else if(followTarget)markerColor='#0f8';
  cmdMarkers.push({x:tile.x,y:tile.y,time:tick,color:markerColor});

  // Play response sound on command
  let movers=selected.filter(s=>s.team===0&&s.type==='unit');
  if (movers.length > 0 && window.playSound) {
    let first = movers[0];
    if (first.utype === 'villager') window.playSound('select_villager');
    else if (first.utype !== 'sheep') window.playSound('select_military');
  }

  // Generate formation offsets for group movement (AoE2-style spread)
  let offsets=getFormation(movers.length);
  let idx=0;
  movers.forEach(s=>{
    s.gatherX=-1;s.gatherY=-1;s.prevTask=null;s.savedTask=null; // fully clear old state
    s.buildTarget=null;
    s.buildQueue=[];
    s.followId=undefined;
    s.defendX=s.x;s.defendY=s.y;
    s.explicitAttack=false;
    if(buildTarget&&s.utype==='villager'){
      s.target=null;s.task='build';s.buildTarget=buildTarget.id;
      let b=BLDGS[buildTarget.btype];
      let pt=b.isFarm?{x:buildTarget.x,y:buildTarget.y}:(typeof nearestBldgPerimeter==='function'?nearestBldgPerimeter(s.x,s.y,buildTarget,s.id):{x:buildTarget.x+buildTarget.w,y:buildTarget.y+buildTarget.h});
      pathUnitTo(s,pt.x,pt.y);
    } else if(target){
      if(s.utype==='sheep'){return;} // sheep don't attack
      if((target.utype==='sheep'||target.utype==='sheep_carcass')&&s.utype!=='villager'){
        // Sheep or carcass targeted by military unit: treat as move command!
        s.target=null;
        let ox=offsets[idx]?offsets[idx][0]:0, oy=offsets[idx]?offsets[idx][1]:0;
        s.task=null;issueMoveOrder(s,tile.x+ox,tile.y+oy);
        idx++;
      } else {
        s.target=target.id;s.task=null;clearUnitPath(s);s.buildTarget=null;
        s.explicitAttack=true;
      }
    } else if(followTarget&&followTarget.id!==s.id&&s.utype!=='sheep'){
      // AoE2-style "Follow": keep pathing toward the followed unit's current
      // position (see updateUnit() in logic.js for the continuous re-pathing).
      s.target=null;s.task=null;s.followId=followTarget.id;
      pathUnitTo(s,Math.round(followTarget.x),Math.round(followTarget.y));
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
          s.task=null;issueMoveOrder(s,tile.x+ox,tile.y+oy);
          idx++;
        }
      } else {
        // Military move: use formation offset
        let ox=offsets[idx]?offsets[idx][0]:0, oy=offsets[idx]?offsets[idx][1]:0;
        s.task=null;issueMoveOrder(s,tile.x+ox,tile.y+oy);
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
  if(canPlace(placing,tile.x,tile.y,0)){
    let b=BLDGS[placing];
    let gw = b.w, gh = b.h;
    let ox = tile.x, oy = tile.y;
    if (placing === 'GATE') {
      let isWall = (tx, ty) => {
        let w = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === 0);
        return !!w;
      };
      if (isWall(tile.x, tile.y) && isWall(tile.x + 1, tile.y)) {
        ox = tile.x; oy = tile.y; gw = 2; gh = 1;
      } else if (isWall(tile.x - 1, tile.y) && isWall(tile.x, tile.y)) {
        ox = tile.x - 1; oy = tile.y; gw = 2; gh = 1;
      } else if (isWall(tile.x, tile.y) && isWall(tile.x, tile.y + 1)) {
        ox = tile.x; oy = tile.y; gw = 1; gh = 2;
      } else if (isWall(tile.x, tile.y - 1) && isWall(tile.x, tile.y)) {
        ox = tile.x; oy = tile.y - 1; gw = 1; gh = 2;
      }
    }
    let wallsToRemove = [];
    for (let dy = 0; dy < gh; dy++) {
      for (let dx = 0; dx < gw; dx++) {
        let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && en.btype === 'WALL' && en.team === 0);
        if (w) wallsToRemove.push(w);
      }
    }
    let actualCost = {...b.cost};
    if (placing === 'GATE') {
      actualCost.s = Math.max(0, (actualCost.s || 0) - wallsToRemove.length * 5);
    } else if (placing === 'TOWER') {
      let existing = entities.find(en => en.type === 'building' && en.x === tile.x && en.y === tile.y && en.btype === 'WALL' && en.team === 0);
      if (existing) {
        actualCost.s = Math.max(0, (actualCost.s || 0) - 5);
        wallsToRemove.push(existing);
      }
    }
    if(!canAfford(0,actualCost)){showMsg('Not enough resources!');placing=null;return;}
    spendCost(0,actualCost);
    if (wallsToRemove.length > 0) {
      let ids = new Set(wallsToRemove.map(w => w.id));
      entities = entities.filter(en => !ids.has(en.id));
      selected = selected.filter(s => !ids.has(s.id));
      ids.forEach(id => entitiesById.delete(id));
    }
    let bldg=createBuilding(placing,ox,oy,0,gw,gh);
    bldg.complete=false;bldg.buildProgress=0;
    if (wallsToRemove.length > 0) {
      bldg.wasWall = true;
    }
    vils.forEach(v=>{
      v.buildQueue = v.buildQueue || [];
      v.buildQueue.push(bldg.id);
      // Start construction task immediately if not already building
      if(v.task!=='build'||!v.buildTarget){
        v.task='build';v.buildTarget=bldg.id;v.target=null;v.savedTask=null;
        let pt=b.isFarm?{x:ox,y:oy}:(typeof nearestBldgPerimeter==='function'?nearestBldgPerimeter(v.x,v.y,bldg,v.id):{x:ox+gw,y:oy+gh});
        pathUnitTo(v,pt.x,pt.y);
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

function handleScroll(elapsed){
  if(gameOver)return;
  let dt = elapsed !== undefined ? elapsed / 16.67 : 1.0;
  let spd = 12 * dt;
  let manualPan=false;

  if(keys['w']||keys['ArrowUp']){camY-=spd;manualPan=true;}
  if(keys['s']||keys['ArrowDown']){camY+=spd;manualPan=true;}
  if(keys['a']||keys['ArrowLeft']){camX-=spd;manualPan=true;}
  if(keys['d']||keys['ArrowRight']){camX+=spd;manualPan=true;}



  // Camera-follow: any manual pan input releases the lock; otherwise keep
  // re-centering on the followed unit every frame (see toggleCameraFollow()).
  if(manualPan){
    window.cameraFollowId=null;
  } else if(window.cameraFollowId){
    let f=entities.find(en=>en.id===window.cameraFollowId);
    if(f&&f.hp>0){
      let iso=toIso(f.x,f.y);
      camX=iso.ix;camY=iso.iy;
    } else {
      window.cameraFollowId=null;
    }
  }

  // Clamp camera to map bounds (with a margin of 200 pixels in screen/iso coordinates)
  let maxW = MAP * HALF_TW + 200;
  let maxH = MAP * TH + 200;
  camX = Math.max(-maxW, Math.min(maxW, camX));
  camY = Math.max(-200, Math.min(maxH, camY));
}

// ---- RESIZE ----
window.addEventListener('resize',()=>{
  if (window.updateBottomHeight) {
    window.updateBottomHeight();
  }
});

// Double click to select all units of same type on screen
C.addEventListener('dblclick', e => {
  if (gameOver || hasTouch) return;
  let clicked = getUnitUnderCursor(e.clientX, e.clientY);
  if (clicked && clicked.team === 0) {
    selected = entities.filter(en => en.team === 0 && en.type === 'unit' && en.utype === clicked.utype && isUnitOnScreen(en));
    if (window.playSound) {
      if (clicked.utype === 'villager') window.playSound('select_villager');
      else window.playSound('select_military');
    }
    updateUI();
  }
});
