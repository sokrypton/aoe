// ==============================
// ---- INPUT: MOUSE (Desktop) ----
// ==============================
let keys={};
let isDragging=false;
// Suppress mouse handlers only for a short window after real touch input —
// browsers can fire synthetic mouse events right after touches. A permanent
// "hasTouch" latch bricked the mouse on hybrid devices (touchscreen laptop,
// iPad + trackpad) after a single accidental screen tap.
let lastTouchTime=-1e9;
function recentTouch(){return performance.now()-lastTouchTime<700;}
let justPlaced=false; // flag to prevent mouseup selection clearing when placing buildings
let middleDrag=false;
let middleDragLast=null;

// Snap the camera to a map tile (viewer-local). Also releases camera-follow so
// handleScroll() won't yank it back to a followed unit next frame — every
// "jump to X" action needs this, so it lived copy-pasted in 6 places across
// input.js/ui.js/init.js. Shared here (global scope; called at runtime).
function jumpCameraToTile(tx, ty){
  let iso = toIso(tx, ty);
  camX = iso.ix; camY = iso.iy;
  window.targetCamX = camX; window.targetCamY = camY;
  window.cameraFollowId = null;
}

function selectTownCenter() {
  if (gameOver) return;
  let tcs = entities.filter(e => e.team === myTeam && e.type === 'building' && e.btype === 'TC');
  if (tcs.length === 0) return;
  
  window.lastTCIndex = window.lastTCIndex || 0;
  let tc = tcs[window.lastTCIndex % tcs.length];
  window.lastTCIndex++;
  
  selected = [tc];
  
  // Center camera on Town Center
  jumpCameraToTile(tc.x + tc.w/2, tc.y + tc.h/2);

  if (window.playSound) window.playSound('select_military');
  updateUI();
}

// All of the player's UNFINISHED wall foundations orthogonally connected
// to `start` — the "I mis-dragged this wall line" selection unit. BFS over
// foundations rather than "same row" literally, so an elbow-shaped drag
// (the wall tool's natural output) is caught whole. Completed segments
// break the chain on purpose: they're paid-for, standing wall, and
// bulk-cancel is a foundation-refund gesture.
function collectUnfinishedWallChain(start){
  return collectWallChain(start, en => !en.complete && !en.exhausted);
}

// COMPLETED wall/gate run connected to `start` — the double-click unit for
// bulk actions on a standing line (the Upgrade to Stone button, js/ui.js).
// Includes same-material gates so the upgrade hits walls and gates together;
// stops at a material change (see collectWallChain).
function collectCompletedWallRun(start){
  return collectWallChain(start, en => en.complete);
}

// A wall/gate double-click target: a wall or gate segment (either material),
// not exhausted. Gates ride along with the walls they sit in so bulk actions
// (e.g. Upgrade to Stone → SWALL/SGATE) hit the whole line at once.
function isWallSelectTarget(en){
  return en.team === myTeam && (isWallBtype(en.btype) || isGateBtype(en.btype)) && !en.exhausted;
}
// Two wall/gate pieces are connected if any tile of one is orthogonally
// adjacent to any tile of the other — footprint-aware, so a 1x1 wall links to
// a multi-tile gate at the run's end (plain Manhattan-1 on origins would miss
// it now that gates span 3 tiles).
function wallGateAdjacent(a, b){
  for (let ax = a.x; ax < a.x + a.w; ax++) for (let ay = a.y; ay < a.y + a.h; ay++)
    for (let bx = b.x; bx < b.x + b.w; bx++) for (let by = b.y; by < b.y + b.h; by++)
      if (Math.abs(ax - bx) + Math.abs(ay - by) === 1) return true;
  return false;
}
function collectWallChain(start, accept){
  // Same material family only (wood: WALL+GATE, stone: SWALL+SGATE) — the art
  // links mixed materials into one line, but bulk selection stops at a
  // material change so double-clicking a wood stretch never sweeps stone
  // segments into an upgrade order. Within a family, walls AND gates chain
  // together.
  let startMat = wallMat(start.btype);
  let chain = [start];
  let seen = new Set([start.id]);
  let queue = [start];
  while (queue.length) {
    let cur = queue.pop();
    entities.forEach(en => {
      if (seen.has(en.id)) return;
      if (en.type !== 'building' || en.team !== myTeam) return;
      if (!(isWallBtype(en.btype) || isGateBtype(en.btype)) || wallMat(en.btype) !== startMat) return;
      if (!accept(en)) return;
      if (!wallGateAdjacent(en, cur)) return;
      seen.add(en.id);
      chain.push(en);
      queue.push(en);
    });
  }
  return chain;
}

// Delete own units/buildings by id — shared by the Delete/Backspace key
// below and the "Cancel Build" action button (js/ui.js). Under lockstep
// no peer mutates world state out-of-band — calling handleDeath()
// directly here would desync the sims. Route it through the command
// queue so both peers execute it on the same tick.
function requestDeleteOwned(ownIds){
  if (!ownIds || !ownIds.length) return;
  submitCommand({ kind: 'delete-units', unitIds: ownIds });
}

document.addEventListener('keydown',e=>{
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor supplies its own keys
  // While reviewing the finished map (See Map), keep the arrow keys panning —
  // but nothing else (no command hotkeys post-game).
  if(gameOver && window.seeMapMode && (e.key==='ArrowUp'||e.key==='ArrowDown'||e.key==='ArrowLeft'||e.key==='ArrowRight')) keys[e.key]=true;
  if(gameOver)return;
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  // Multiplayer chat (js/chat.js) — classic RTS binding. Once the box is
  // open, its own focused-input listener owns the keyboard (the guard
  // above skips INPUT targets), so this only ever OPENS it.
  if (e.key === 'Enter' && typeof openChatInput === 'function' && chatAvailable()) {
    openChatInput();
    e.preventDefault();
    return;
  }
  // OS key auto-repeat only matters for held-key panning, which reads the
  // keys map set on the FIRST keydown — action hotkeys below must fire once
  // per physical press (holding 'a' with a barracks selected used to queue
  // archers at repeat rate while the camera panned).
  if(e.repeat)return;
  let key = e.key.toLowerCase();
  
  if (key === 'h') {
    selectTownCenter();
    return;
  }
  if (e.key === '.') {
    if (window.selectIdleVillager) window.selectIdleVillager();
    return;
  }
  // AoE2 mapping: ',' cycles idle MILITARY (the '.' key handles villagers).
  if (e.key === ',') {
    if (window.selectIdleMilitary) window.selectIdleMilitary();
    return;
  }
  // Control groups (AoE2): Ctrl+1..9 assigns the current selection, 1..9
  // recalls it, and pressing the same number again quickly also centers
  // the camera on the group.
  if (e.key >= '1' && e.key <= '9') {
    let n = e.key;
    window.ctrlGroups = window.ctrlGroups || {};
    if (e.ctrlKey || e.metaKey) {
      if (selected.length > 0 && selected.every(s => s.team === myTeam)) {
        window.ctrlGroups[n] = selected.map(s => s.id);
        showMsg('Control group ' + n + ' assigned (' + selected.length + ')');
      }
      e.preventDefault();
      return;
    }
    let ids = window.ctrlGroups[n];
    if (ids && ids.length) {
      let units = ids.map(id => entitiesById.get(id)).filter(u => u && u.hp > 0 && !u.garrisonedIn);
      window.ctrlGroups[n] = units.map(u => u.id); // prune the dead
      if (units.length) {
        let again = window._lastGroupKey === n && (performance.now() - (window._lastGroupTime || 0)) < 450;
        selected = units;
        if (again) centerCameraOnSelection();
        window._lastGroupKey = n; window._lastGroupTime = performance.now();
        updateUI();
      } else {
        showMsg('Control group ' + n + ' is empty');
      }
    }
    return;
  }
  // Space: jump the camera to the current selection (AoE2-style).
  if (e.key === ' ') {
    e.preventDefault();
    centerCameraOnSelection();
    return;
  }
  
  if(e.key==='Escape'){
    // Abort an in-progress wall drag too — leaving isDraggingWall set meant
    // the NEXT mouseup ran finalizeWallDrag() and built the wall the player
    // just tried to cancel.
    if(window.isDraggingWall)abortWallDrag();
    placing=null;selected=[];window.settingRally=false;window.settingGuard=false;updateUI();
  }
  if(e.key==='Delete'||e.key==='Backspace'){
    let ownIds = selected.filter(en=>en.team===myTeam).map(en=>en.id);
    requestDeleteOwned(ownIds);
    selected=[];
    updateUI();
  }
  
  // Villager building hotkeys (Grid-style like AoE2 Definitive Edition).
  // Consumed keys `return` so they never reach the pan-key registration at
  // the bottom. Camera panning is arrow keys / edge / middle-drag only
  // (AoE2-style) — letters are command keys and never pan.
  let hasVil = selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam);
  if(hasVil) {
    window.currentVillagerMenu = window.currentVillagerMenu || 'main';
    if(window.currentVillagerMenu === 'main') {
      if(key==='q') { window.currentVillagerMenu = 'eco'; updateUI(); return; }
      else if(key==='w') { window.currentVillagerMenu = 'mil'; updateUI(); return; }
    } else if(window.currentVillagerMenu === 'eco') {
      // Hotkeys mirror the menu's importance order (see ui.js eco builds).
      // TC placement is hidden for now (no hotkey) but doPlace still handles it.
      if(key==='q') { placing='HOUSE'; showMsg('Place House'); return; }
      else if(key==='w') { placing='FARM'; showMsg('Place Farm'); return; }
      else if(key==='e') { placing='LCAMP'; showMsg('Place Lumber Camp'); return; }
      else if(key==='r') { placing='MILL'; showMsg('Place Mill'); return; }
      else if(key==='t') { placing='MCAMP'; showMsg('Place Mining Camp'); return; }
      else if(key==='y' && isUnlocked(myTeam,'MARKET')) { placing='MARKET'; showMsg('Place Market'); return; }
    } else if(window.currentVillagerMenu === 'mil') {
      // Locked types are hidden from the menu, so their hotkeys are inert
      // (silent) too. E/R always place the BEST unlocked wall/gate material
      // — the stone versions replace the palisade slot at Feudal.
      let tryPlace=(type,label)=>{
        if(!isUnlocked(myTeam,type))return;
        placing=type; showMsg('Place '+label);
      };
      if(key==='q') { tryPlace('BARRACKS','Barracks'); return; }
      // W = best unlocked tower, matching the E/R wall convention below.
      else if(key==='w') {
        if(isUnlocked(myTeam,'TOWER')) tryPlace('TOWER','Watch Tower');
        else tryPlace('PTOWER','Palisade Watch Tower');
        return;
      }
      else if(key==='e') {
        if(isUnlocked(myTeam,'SWALL')) tryPlace('SWALL','Stone Wall');
        else tryPlace('WALL','Palisade Wall');
        return;
      }
      else if(key==='r') {
        if(isUnlocked(myTeam,'SGATE')) tryPlace('SGATE','Stone Gate');
        else tryPlace('GATE','Palisade Gate');
        return;
      }
      // Palisade stays available in every age (AoE2) — on its own keys once
      // stone has taken the E/R slots.
      else if(key==='t' && isUnlocked(myTeam,'SWALL')) { tryPlace('WALL','Palisade Wall'); return; }
      else if(key==='y' && isUnlocked(myTeam,'SWALL')) { tryPlace('GATE','Palisade Gate'); return; }
      else if(key==='u' && isUnlocked(myTeam,'TOWER')) { tryPlace('PTOWER','Palisade Watch Tower'); return; }
    }
  }

  // Training hotkeys for selected buildings (consume the key, same as above)
  if (selected.length > 0 && selected[0].type === 'building' && selected[0].team === myTeam && selected[0].complete) {
    let bldg = selected[0];
    if (bldg.btype === 'TC') {
      if (key === 'v') { trainUnit(bldg, 'villager'); return; }
    } else if (bldg.btype === 'BARRACKS') {
      // Locked (future-age) units are hidden from the panel — their
      // hotkeys are inert rather than erroring.
      let train=(ut)=>{ if(isUnlocked(myTeam,ut)) trainUnit(bldg,ut); };
      if (key === 'm') { train('militia'); return; }
      else if (key === 's') { train('spearman'); return; }
      else if (key === 'a') { train('archer'); return; }
      else if (key === 'c') { train('scout'); return; }
      else if (key === 'k') { train('knight'); return; }
    } else if (bldg.btype === 'MARKET') {
      if (key === 't') { if(isUnlocked(myTeam,'tradecart')) trainUnit(bldg,'tradecart'); return; }
    }
  }

  // Auto Scout toggle ('e' = explore) when the selection is all own scouts.
  if (selected.length > 0 && selected.every(s => s.type === 'unit' && s.utype === 'scout' && s.team === myTeam)) {
    if (key === 'e') {
      let ids = selected.map(s => s.id);
      let wantOn = selected.some(s => !s.autoScout);
      submitCommand({ kind: 'auto-scout', unitIds: ids, on: wantOn });
      if(wantOn) deselectAfterTask(); // auto-scout is a task → deselect (index model)
      return;
    }
  }

  // Nothing consumed the key as an action: register it in the held-key map
  // (handleScroll reads the arrow keys from it every frame, doPlace reads
  // Shift; keyup/blur clear it).
  keys[e.key]=true;
});
document.addEventListener('keyup',e=>{keys[e.key]=false;});
// If focus leaves the window while a key is physically held (alt-tab,
// clicking devtools, an OS shortcut, etc.), its keyup never fires and the
// key stays stuck 'true' forever — e.g. Shift stuck down keeps building
// placement (doPlace) from ever exiting "place next foundation" mode.
window.addEventListener('blur',()=>{Object.keys(keys).forEach(k=>keys[k]=false);});

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
  window.wallDragBtype = placing; // WALL or SWALL — the drag places this material
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

  let vils = selected.filter(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam);
  if(vils.length===0){
    showMsg('Select a villager to build!');
    placing=null;
    return;
  }
  // Mutation half is execWallDrag (js/commands.js), run at the scheduled
  // tick — start/corner/end are already world tiles.
  submitCommand({ kind: 'wall-drag', btype: window.wallDragBtype || 'WALL', start, end, corner, unitIds: vils.map(s=>s.id) });

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
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  if((gameOver && !window.seeMapMode)||recentTouch())return; // ignore synthetic mouse events (pan/select stay live in See Map)
  // Trust the event's own modifier snapshot over the keydown/keyup-tracked
  // keys map: OS-level shortcuts (e.g. macOS Cmd+Shift+5 for screen
  // recording) can swallow a key's keyup entirely, leaving keys['Shift']
  // stuck true forever with no window blur ever firing. e.shiftKey is
  // always accurate for the instant of this click.
  keys['Shift'] = e.shiftKey;
  if(e.button===1){
    middleDrag=true;
    middleDragLast={x:e.clientX,y:e.clientY};
    window.cameraFollowId=null;
    e.preventDefault();
    return;
  }
  if(e.button===0 && !e.ctrlKey){
    // Placing/wall-dragging always takes priority over the minimap — the
    // minimap should never block or interfere with an action already in
    // progress, only offer camera-panning when nothing else claims the click.
    if(placing){
      if (isWallBtype(placing)) {
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
    // No box-select once the match is over (See Map is view-only): without this
    // the drag rectangle still DRAWS over the frozen map even though the commit
    // (doBoxSelect) is gated — the box just never resolves to a selection.
    if(!gameOver){ dragStart={x:e.clientX,y:e.clientY};dragEnd=null;isDragging=false; }
    justPlaced=false;
  }
});
C.addEventListener('mousemove',e=>{
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  if((gameOver && !window.seeMapMode)||recentTouch())return;
  mouseX=e.clientX;mouseY=e.clientY;
  if(middleDrag && (e.buttons&4 || e.button===1)){
    if(middleDragLast){
      camX -= (e.clientX - middleDragLast.x) / ZOOM;
      camY -= (e.clientY - middleDragLast.y) / ZOOM;
      window.cameraFollowId=null;
    }
    middleDragLast={x:e.clientX,y:e.clientY};
    return;
  }
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
document.addEventListener('mousemove',e=>{if(!gameOver || window.seeMapMode){mouseX=e.clientX;mouseY=e.clientY;}});
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
  // Any horizontal component means a two-finger trackpad swipe — a plain
  // mouse wheel is vertical-only — so treat it as a pan outright.
  if(e.deltaX!==0) return true;
  if(e.wheelDeltaY!==undefined){
    // Trackpad: wheelDeltaY ≈ -3·deltaY. A physical notch instead reports a
    // FIXED wheelDeltaY (±120) unrelated to deltaY's magnitude. The compare
    // must be TOLERANT, not exact: a precision trackpad reports a fractional
    // deltaY (e.g. 4.0000009) against an integer wheelDeltaY (-12), so the
    // old `wheelDeltaY === deltaY*-3` was false for every swipe and they all
    // fell through to the zoom branch ("two-finger scroll zooms, won't pan").
    // The two are the same underlying value, so the residual is ~1e-5 for a
    // trackpad vs. hundreds for a wheel notch — a <1 window separates them
    // cleanly at any swipe speed.
    return Math.abs(e.wheelDeltaY + 3*e.deltaY) < 1;
  }
  return e.deltaMode===0;
}
C.addEventListener('wheel',e=>{
  // Camera-only (pan/zoom) — safe in the scenario editor too, so it runs in
  // BOTH edit and play there (the editor no longer defines its own wheel
  // handler): two-finger trackpad swipe pans, pinch/ctrl zooms around the
  // cursor, wheel notch zooms — identical gestures to normal gameplay.
  if(gameOver && !window.seeMapMode)return; // zoom stays live in See Map
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
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  // Match mousedown/mousemove/wheel: stay live in See-Map review mode even
  // after gameOver so PAN/ZOOM keep working and the drag cleanup at the end of
  // this handler still runs (bailing here left the minimap stuck dimmed). The
  // actual unit interaction is view-only after the match: doSelect/doBoxSelect/
  // handleTap all bail on gameOver, so no selecting or commanding the frozen map.
  if((gameOver && !window.seeMapMode)||recentTouch())return;
  if(e.button===1){
    middleDrag=false;
    middleDragLast=null;
    return;
  }
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
      if (!isClassicUI) {
        // index.html: a desktop click IS a tap — the page has ONE
        // interaction model on every device. handleTap owns the rally/
        // guard flag modes and the select-vs-command context decision
        // (and, via finishMobileUnitCommand, the same keep/release rules
        // as touch). Right-click still commands too (contextmenu below);
        // left-drag box-select was dispatched above and is unaffected.
        handleTap(e.clientX, e.clientY, e.shiftKey);
      } else if (window.settingRally) {
        // classic.html keeps the AoE2 contract: left selects, right
        // commands — that fidelity is this page's reason to exist.
        commitRallyAt(e.clientX, e.clientY);
      } else if (window.settingGuard) {
        dropGuardFlagAt(e.clientX, e.clientY);
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
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  if(gameOver||recentTouch())return;
  if(e.target===C){
    if(isPointOnMinimap(e.clientX,e.clientY))return; // right-click over the minimap is a no-op, not a world command
    window.settingRally=false; // right-click itself handles rally; clear the flag
    window.settingGuard=false; // right-click issues a manual order instead
    // index.html: right-click a friendly building/unit = Guard/Escort flag,
    // then deselect (assign-and-move-on). Ground/enemy fall through to the
    // normal walk/attack below.
    if(!isClassicUI && tryRightClickGuard(e.clientX, e.clientY)) return;
    doCommand(e.clientX,e.clientY);
    // index.html has ONE interaction model: a right-click command applies
    // the same keep/release rules as the left-click tap path (handleTap) —
    // e.g. assigning villagers to a resource releases the selection.
    // Classic keeps AoE2's sticky selection on right-click orders.
    if(!isClassicUI && selected.some(s=>s.type==='unit'&&s.team===myTeam)) finishMobileUnitCommand();
  }
});

window.addEventListener('blur',()=>{
  middleDrag=false;
  middleDragLast=null;
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
let pinchStartDist=null; // two-finger distance at pinch start, for pinch-zoom
let pinchStartZoom=null; // ZOOM at pinch start
let touchLongPressTimer=null; // arms box-select if the finger holds still on empty ground
let touchBoxSelectMode=false; // armed (and possibly active) box-select drag
let placingTouchDrag=false;   // touch drag-to-position building placement (see touchstart)
let touchLastTapTime=0;       // for double-tap detection
let touchLastTapUtype=null;   // utype of the unit tapped last, if any
let touchLastTapWallId=null;  // unfinished wall foundation tapped last (chain-select on double-tap)

C.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  if(gameOver && !window.seeMapMode)return; // touch pan/pinch stay live in See Map
  lastTouchTime=performance.now();
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
    touchAnchor={x:t.clientX,y:t.clientY};
    touchLast={x:t.clientX,y:t.clientY};
    touchMoved=false;
    mouseX=t.clientX;mouseY=t.clientY; // for ghost preview

    if(isWallBtype(placing)){
      startWallDrag(t.clientX,t.clientY);
    } else if(placing){
      // Touch placement is DRAG-TO-POSITION: the finger carries the ghost
      // (lifted above the fingertip once dragging, so it isn't hidden
      // under the finger), and lifting the finger places the building at
      // the ghost — a plain tap still places at the tap point, exactly as
      // before. While this is active, single-finger camera panning is
      // suspended (two-finger pan/pinch still works, and cancels the
      // placement drag rather than building anything).
      placingTouchDrag=true;
    } else {
      // Arm long-press box-select only when the touch starts on empty
      // ground — starting on a unit/building should never hijack a tap or
      // pan into a selection box.
      clearTimeout(touchLongPressTimer);
      touchBoxSelectMode=false;
      let hitU=getUnitUnderCursor(t.clientX,t.clientY);
      let hitB=hitU?null:getBuildingUnderCursor(t.clientX,t.clientY);
      // Never arm box-select over a finished match (See Map is view-only) —
      // otherwise a long-press+drag paints a selection box that can't select.
      if(!hitU&&!hitB&&!gameOver){
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
    // that was in progress (box-select arm/drag, wall-drag, placement drag —
    // the ghost stays, nothing is built; the next single-finger touch
    // starts a fresh placement drag).
    placingTouchDrag=false;
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
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  lastTouchTime=performance.now(); // keep the mouse-suppression window alive through long drags
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
      // Screen px -> pre-zoom iso units (camX/camY are pre-zoom; render
      // multiplies by ZOOM). Without /ZOOM the pan outruns the finger when
      // zoomed in and lags it when zoomed out. Same as wheel-pan above.
      camX-=(mx-touchLast.x)/ZOOM;
      camY-=(my-touchLast.y)/ZOOM;
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

    if(placingTouchDrag){
      // The ghost tracks the fingertip exactly — no artificial lift, so the
      // building always lands precisely where shown. No camera pan — the
      // finger is busy carrying the building.
      if(touchAnchor && Math.abs(t.clientX-touchAnchor.x)+Math.abs(t.clientY-touchAnchor.y)>10){
        touchMoved=true;
      }
      mouseX=t.clientX;
      mouseY=t.clientY;
      touchLast={x:t.clientX,y:t.clientY};
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
      // /ZOOM: see the two-finger pan above — keeps the map glued to the
      // fingertip at every zoom level.
      camX-=dx/ZOOM;
      camY-=dy/ZOOM;
      window.cameraFollowId=null;
    }
    touchLast={x:t.clientX,y:t.clientY};
  }
},{passive:false});

C.addEventListener('touchend',e=>{
  e.preventDefault();
  if(window.__editorMode && !window.__editorPlaying)return; // scenario editor handles its own canvas input
  lastTouchTime=performance.now(); // synthetic mouse events fire right after touchend
  // Only process tap when all fingers are lifted
  if(e.touches.length===0){
    clearTimeout(touchLongPressTimer);
    if(minimapDragging){
      minimapDragging=false;
    } else if(window.isDraggingWall){
      finalizeWallDrag();
    } else if(placingTouchDrag){
      // Release places at the ghost position (which handleTap's old path
      // never sees — this branch owns ALL touch placement now). A plain
      // tap places right at the tap point; a drag places at the lifted
      // ghost. On an invalid spot doPlace() shows "Can't build here!" and
      // stays in placement mode, so the user just drags again.
      placingTouchDrag=false;
      doPlace(mouseX,mouseY);
      updateUI();
    } else if(touchBoxSelectMode && isDragging && dragStart && dragEnd){
      doBoxSelect(dragStart.x,dragStart.y,dragEnd.x,dragEnd.y);
      let mw=document.getElementById('minimap-wrap');
      if(mw)mw.classList.remove('drag-select-active');
    } else if(!touchMoved&&touchAnchor){
      // It's a tap! Double-tap on the same own unit type selects every
      // instance of that type on screen (touch equivalent of dblclick below).
      let now=performance.now();
      let tappedU=getUnitUnderCursor(touchAnchor.x,touchAnchor.y);
      let tappedWallB=!tappedU?getBuildingUnderCursor(touchAnchor.x,touchAnchor.y,isWallSelectTarget):null;
      if(tappedU && tappedU.team===myTeam && touchLastTapUtype===tappedU.utype && (now-touchLastTapTime)<380){
        selected=entities.filter(en=>en.team===myTeam&&en.type==='unit'&&en.utype===tappedU.utype&&isUnitOnScreen(en));
        if(window.playSound){
          if(tappedU.utype==='villager')window.playSound('select_villager');
          else if(tappedU.utype!=='sheep')window.playSound('select_military');
        }
        updateUI();
        touchLastTapTime=0;
        touchLastTapUtype=null;
      } else if(tappedWallB && touchLastTapWallId===tappedWallB.id && (now-touchLastTapTime)<380){
        // Double-tap on a wall: an UNFINISHED foundation selects its whole
        // connected unfinished chain (the mis-dragged line) for the multi
        // Cancel Build button (js/ui.js); a COMPLETED wood wall selects its
        // connected run for bulk actions (Upgrade to Stone).
        if(tappedWallB.complete){
          selected=collectCompletedWallRun(tappedWallB);
          showMsg(selected.length+' wall segment'+(selected.length>1?'s':'')+' selected');
        } else {
          selected=collectUnfinishedWallChain(tappedWallB);
          showMsg(selected.length+' wall foundation'+(selected.length>1?'s':'')+' selected');
        }
        updateUI();
        touchLastTapTime=0;
        touchLastTapWallId=null;
      } else {
        handleTap(touchAnchor.x,touchAnchor.y);
        touchLastTapTime=now;
        touchLastTapUtype=tappedU?tappedU.utype:null;
        touchLastTapWallId=tappedWallB?tappedWallB.id:null;
      }
    }
    touchAnchor=null;
    touchLast=null;
    touchMoved=false;
    pinchStartDist=null;
    pinchStartZoom=null;
    touchBoxSelectMode=false;
    placingTouchDrag=false;
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

// UI-only record of the LAST command submitted per unit, not yet EXECUTED —
// the queue runs commands INPUT_DELAY_TICKS after the tap (js/commands.js),
// so at tap time the unit's live task/target/moveGoal fields still describe
// the PREVIOUS order. The mobile keep-selection decision must follow the
// command just issued (keep for plain walks and build orders, deselect for
// gather/attack/follow), so the resolver records that decision here and it
// takes precedence over stale live state until the command lands. Never
// read by the sim (mutating real sim fields early on just the issuer would
// desync lockstep peers).
let pendingOrderUI = new Map(); // unit id -> {t: submit tick, keep: bool}
function prunePendingOrders(){
  pendingOrderUI.forEach((p, id) => { if (tick - p.t > INPUT_DELAY_TICKS + 30) pendingOrderUI.delete(id); });
}
function hasSelectedMobileWalkOrder(){
  let movers=selected.filter(s=>s.team===myTeam&&s.type==='unit');
  return movers.length>0 && movers.every(s=>{
    let p = pendingOrderUI.get(s.id);
    if (p !== undefined && tick - p.t <= INPUT_DELAY_TICKS + 30) return p.keep;
    return !s.task && !s.target && !s.followId && !s.buildTarget && s.moveGoalX!==undefined;
  });
}
function finishMobileUnitCommand(){
  // Only a plain walk keeps the selection (see the keep rule in doCommand);
  // every committed task deselects.
  if(hasSelectedMobileWalkOrder())return;
  selected=[];
  window.settingRally=false;
  window.settingGuard=false;
  updateUI();
}
// "Assign and move on": once a unit is given a real task via a BUTTON/keyboard
// or flag drop (guard/escort, build placement, auto-scout) the index skin
// clears the selection. classic.html stays AoE2-STICKY. One home for that
// policy — the tap/left-click path uses finishMobileUnitCommand instead.
function deselectAfterTask(){
  if(isClassicUI)return;
  selected=[];
  if(typeof updateUI==='function')updateUI();
}

// Commit a rally-flag drop at a screen point — the ONE rally-drop path,
// shared by the touch tap and desktop click handlers (same pattern as
// dropGuardFlagAt below). doCommand resolves the click exactly like a
// right-click rally would.
function commitRallyAt(sx, sy){
  let bldg = selected[0];
  let bData = bldg && BLDGS[bldg.btype];
  if(bldg && bldg.type==='building' && bldg.team===myTeam && bData && bData.builds && bData.builds.length>0){
    doCommand(sx, sy);
  }
  window.settingRally = false;
  updateUI();
}

// Feedback string for a guard/escort/ground flag — shared by both flag-drop
// paths so the wording can't drift.
function guardFlagMsg(tgt){
  if(!tgt) return 'Guarding position';
  return tgt.type==='unit' ? 'Escorting' : 'Guarding '+(BLDGS[tgt.btype]?BLDGS[tgt.btype].name:'building');
}
// Resolve and submit a guard flag at a screen point — the ONE guard-drop
// path, shared by the touch tap and desktop click handlers. A tap on a
// friendly unit = ESCORT it, on an own/allied building = stand watch there
// (sprite-geometry hit-test, same as every other click), anything else =
// ground post at the tile (execGuard re-validates deterministically).
function dropGuardFlagAt(sx, sy){
  let gt = screenToTile(sx, sy);
  if(gt && selected.length>0){
    let tgt = getUnitUnderCursor(sx, sy) || getBuildingUnderCursor(sx, sy);
    if(tgt && !sameSide(tgt.team, myTeam)) tgt = null; // enemy tap → ground post
    let ids = selected.filter(s=>s.type==='unit').map(s=>s.id);
    submitCommand({ kind:'guard', unitIds: ids, x: gt.x, y: gt.y, targetId: tgt ? tgt.id : undefined });
    // Issuer-side flag preview — same latency cover as the rally preview
    // (see doCommand): guardX only updates at the exec tick, so without
    // this the units' stale posts (or no flag at all) render for a few
    // frames before jumping to the clicked spot.
    window.pendingGuardPreview = { ids: new Set(ids), x: gt.x, y: gt.y, at: tick };
    showMsg(guardFlagMsg(tgt));
    deselectAfterTask(); // guard is a task → deselect (index model); classic stays AoE2-sticky
  }
  window.settingGuard = false;
  updateUI();
}

// index.html right-click shortcut: a right-click on a friendly BUILDING
// (guard it) or friendly UNIT (escort it) plants the flag directly — the
// same command dropGuardFlagAt/execGuard use, no need to arm the Guard
// button first. GROUND and ENEMY right-clicks are NOT intercepted (they
// stay a normal walk/attack), and it only fires when the selection has
// guard-eligible units — so villager repair/follow on right-click is
// untouched. Returns true if it issued a guard flag (skip doCommand).
function tryRightClickGuard(sx, sy){
  if(!selected.some(s=>s.type==='unit'&&s.team===myTeam&&guardEligible(s)))return false;
  let tgt = getUnitUnderCursor(sx, sy) || getBuildingUnderCursor(sx, sy);
  if(!tgt || !sameSide(tgt.team, myTeam))return false; // ground / enemy → normal command
  let gt = screenToTile(sx, sy);
  if(!gt)return false;
  let ids = selected.filter(s=>s.type==='unit'&&guardEligible(s)).map(s=>s.id);
  if(!ids.length)return false;
  submitCommand({ kind:'guard', unitIds: ids, x: gt.x, y: gt.y, targetId: tgt.id });
  showMsg(guardFlagMsg(tgt));
  deselectAfterTask(); // guard is a task → deselect (index-only caller)
  return true;
}

// Context-aware tap handler — the ONE decision tree for the tap-model skin:
// touch taps on every device, AND desktop left-clicks on index.html (the
// mouseup dispatch forks here when !isClassicUI). `shift` is only ever
// passed by the desktop caller; touch leaves it undefined.
function handleTap(sx,sy,shift){
  if(gameOver)return; // match is over — See Map is view-only (no select/command)
  // 1. If placing a building, place it
  if(placing){
    doPlace(sx,sy);
    return;
  }

  // 2. If in rally-setting mode, set the rally point on tap
  if(window.settingRally){
    commitRallyAt(sx, sy);
    return;
  }
  // 2b. Guard-setting mode: the tap becomes the selection's guard flag.
  if(window.settingGuard){
    dropGuardFlagAt(sx, sy);
    return;
  }

  let tile=screenToTile(sx,sy);

  // Find what's under the tap
  let tappedOwn=null;    // own unit or building
  let tappedEnemy=null;  // enemy unit or building

  // Check units first (higher priority)
  let tappedUnit = getUnitUnderCursor(sx, sy);
  if (tappedUnit) {
    if (tappedUnit.team === myTeam) tappedOwn = tappedUnit;
    else tappedEnemy = tappedUnit;
  }
  // Then buildings
  if(!tappedOwn&&!tappedEnemy){
    let tappedB = getBuildingUnderCursor(sx, sy);
    if (tappedB) {
      if(tappedB.team===myTeam) tappedOwn = tappedB;
      else tappedEnemy = tappedB;
    }
  }

  // 2c. Desktop tap mode: Shift+click on an own UNIT toggles it in/out of
  // the selection (AoE2-DE-style, and it matches the HUD grid's
  // shift-click-to-remove). From a non-unit selection it starts a fresh
  // selection with that unit. Shift over anything else falls through to
  // the normal tap tree.
  if (shift && tappedOwn && tappedOwn.type === 'unit') {
    if (selected.length && selected.every(s => s.type === 'unit')) {
      let i = selected.indexOf(tappedOwn);
      if (i >= 0) selected.splice(i, 1); else selected.push(tappedOwn);
    } else {
      selected = [tappedOwn];
    }
    window.settingRally = false;
    window.settingGuard = false;
    if (window.playSound) playSound('click');
    updateUI();
    return;
  }

  // 3. Nothing selected → just select
  if(selected.length===0){
    if(tappedOwn||tappedEnemy) {
      selected=[tappedOwn||tappedEnemy];
      if (window.playSound && (tappedOwn || tappedEnemy).team === myTeam) {
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
  let haveUnits=selected.some(s=>s.type==='unit'&&s.team===myTeam);
  let haveVillagers=selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam);
  if(haveUnits){
    // Tapped on own sheep with villagers → harvest command
    if(tappedOwn&&tappedOwn.utype==='sheep'&&haveVillagers){
      doCommand(sx,sy);
      finishMobileUnitCommand();
      return;
    }
    // Tapped on another own UNIT → switch selection (quick re-pick). Tapping
    // an own BUILDING instead falls through to doCommand below — so a
    // selected villager tapping a farm/mill/damaged building actually
    // works it instead of just re-selecting the building and doing nothing.
    if(tappedOwn&&tappedOwn.type==='unit'){
      window.settingRally=false;
      selected=[tappedOwn];
      if (window.playSound && tappedOwn.team === myTeam) {
        if (tappedOwn.utype === 'villager') window.playSound('select_villager');
        else if (tappedOwn.utype === 'sheep') window.playSound('sheep');
        else window.playSound('select_military');
      }
      return;
    }
    // Tapped on enemy, own building, or empty map → command (move/gather/
    // build/repair/attack) — doCommand resolves the exact target itself.
    doCommand(sx,sy);
    // One tap, both outcomes: ordering villagers onto an own UNFINISHED
    // foundation also selects the foundation itself, so its card (build
    // progress + the Cancel Build refund button) is immediately on screen
    // — previously reaching Cancel Build took a deselect plus a second
    // tap, which read as "clicking the foundation does nothing".
    // Completed buildings (farm work, repairs) deliberately don't steal
    // the selection — those are repeat-order flows.
    if(tappedOwn&&tappedOwn.type==='building'&&!tappedOwn.complete&&!tappedOwn.exhausted
       &&selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam)){
      window.settingRally=false;
      selected=[tappedOwn];
      updateUI();
      return;
    }
    // After non-walk mobile commands, the next tap should feel like a fresh
    // selection. Walk orders and active builders stay selected: walking often
    // gets adjusted repeatedly, and construction has follow-up choices.
    finishMobileUnitCommand();
    return;
  }

  // 5. Have a building selected (not units)
  if(tappedOwn){
    // Switching selection cancels rally mode
    window.settingRally=false;
    selected=[tappedOwn];
    // Re-tapping the already-selected Market reopens a dismissed exchange
    // popup (mobile skin) — no selection change means no rebuild would.
    maybeReopenMktPopup(tappedOwn);
    if (window.playSound && tappedOwn.team === myTeam) {
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
  jumpCameraToTile(p.x, p.y);
}

function toggleMinimap(){
  let wrap = document.getElementById('minimap-wrap');
  if(wrap) {
    let expanded = wrap.classList.toggle('minimap-expanded');
    // Light the map button up while expanded so it clearly reads as an
    // active toggle that can be pressed again to exit.
    let btn = document.getElementById('map-btn');
    if(btn) btn.classList.toggle('map-active', expanded);
    // Redraw at the new size before the browser paints this click's frame —
    // otherwise the canvas shows one frame at the old size (visible flicker).
    if(typeof refreshMinimapSize==='function') refreshMinimapSize();
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
// Whether the map-button-toggled minimap mode is active for the current
// viewport: narrow portrait screens (no room for the corner map) OR mobile
// landscape (the corner map would eat the top-right; the toggle opens a
// tall right panel instead — see the landscape media query, styles.css).
function minimapToggleModeActive(){
  return window.innerWidth <= MINIMAP_SMALL_BREAKPOINT
    || (window.isMobileLandscape && window.isMobileLandscape());
}

function collapseMinimapIfWide(){
  if(minimapToggleModeActive()) return;
  let wrap = document.getElementById('minimap-wrap');
  if(wrap && wrap.classList.contains('minimap-expanded')){
    wrap.classList.remove('minimap-expanded');
    let btn = document.getElementById('map-btn');
    if(btn) btn.classList.remove('map-active');
  }
}
window.addEventListener('resize', collapseMinimapIfWide);
window.addEventListener('orientationchange', collapseMinimapIfWide);

function centerCameraOnSelection(){
  if(selected.length===0)return;
  let cx=0,cy=0,n=0;
  selected.forEach(s=>{
    let w=s.type==='building'?(s.w||1):0, h=s.type==='building'?(s.h||1):0;
    cx+=s.x+w/2; cy+=s.y+h/2; n++;
  });
  jumpCameraToTile(cx/n, cy/n);
}

function focusTownCenter(){
  if(gameOver)return;
  let tc = entities.find(e => e.type === 'building' && e.team === myTeam && e.btype === 'TC');
  if(tc) {
    jumpCameraToTile(tc.x + tc.w / 2, tc.y + tc.h / 2);
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
// Hit-test a wall/gate against its DRAWN parts, in the unzoomed local
// coords drawBuilding works in (same anchor math: BLDGS dims, sy -= bhh).
// Returns which part was hit:
//   'body' — a wall pillar, gate post, or the gate door: authoritative,
//            the click is unambiguously on this entity.
//   'link' — the wall's S/E extension slab toward a connected neighbor:
//            the slab is drawn BY this tile, so a click between two posts
//            resolves to the post whose extension it actually is (the
//            N/W owner), not whichever tile sorts last.
//   null   — not on any drawn part (the rest of the ground tile doesn't
//            count, unlike the generic footprint-box test).
// Gates get NO link zone on purpose: their stub links visually belong to
// the adjoining wall run, and the gate selecting from half the wall line
// is exactly the "wrong part selected" feel this replaces.
function wallGateHitPart(en, lx, ly){
  let b = BLDGS[en.btype];
  let iso = toIso(en.x + b.w / 2, en.y + b.h / 2);
  let sx0 = iso.ix - camX + W / 2;
  let sy0 = iso.iy - camY + topH + H / 2 - b.h * HALF_TH; // tile top vertex
  let pad = isMobile ? 5 : 3;      // finger/cursor forgiveness, local px
  let capPad = pad + 8;            // extra headroom above posts: caps/merlons/pennants
  if (isWallBtype(en.btype)) {
    // Pillar: drawBuildingBlock(sx, sy0+20-pw, pw, pw/2, 22) spans
    // x ∈ sx±pw, y ∈ [sy0+20-pw-22, sy0+20].
    let pw = wallMat(en.btype) === 'stone' ? 9 : 7;
    if (Math.abs(lx - sx0) <= pw + pad && ly >= sy0 + 20 - pw - 22 - capPad && ly <= sy0 + 20 + pad) return 'body';
    // Extension slabs: drawWallLink from this tile's front corner
    // (sx, sy0+16) a full tile step toward the S (-32,+16) / E (+32,+16)
    // neighbor, body rising wallH=14 above that line. Any wall-like
    // neighbor counts — mirrors the render condition, which links across
    // materials (mixed wood/stone runs stay visually continuous).
    for (let [nx, ny, dirX] of [[en.x, en.y + 1, -32], [en.x + 1, en.y, 32]]) {
      if (!isWallLike(getConnectedBuilding(nx, ny))) continue;
      let t = dirX < 0 ? (sx0 - lx) / 32 : (lx - sx0) / 32;
      if (t <= 0 || t > 1) continue;
      let lineY = sy0 + 16 + 16 * t; // slab base at this point of the run
      if (ly >= lineY - 14 - pad && ly <= lineY + pad + 2) return 'link';
    }
    return null;
  }
  // Gate (footprint 1xN / Nx1, anchored like a 1x1 — BLDGS dims): back
  // post at (sx0, sy0+16), front post (n-1) tile steps along the run, door
  // slab between them. Must mirror the render geometry (render-buildings.js).
  // drawBuildingBlock(tx, ty-7, 14, 7, 28) spans x ∈ tx±14, y ∈ [ty-35, ty+7].
  let ns = en.h > en.w;
  let n = Math.max(en.w, en.h);
  let runX = 32 * (n - 1);
  let posts = [{ x: sx0, y: sy0 + 16 }, { x: ns ? sx0 - runX : sx0 + runX, y: sy0 + 16 + 16 * (n - 1) }];
  for (let p of posts) {
    // No horizontal pad: the posts are already 28px wide, and padding them
    // sideways let the back post steal clicks from the last few px of the
    // adjoining wall's extension slab (body outranks link).
    if (Math.abs(lx - p.x) <= 14 && ly >= p.y - 35 - capPad && ly <= p.y + 7 + pad) return 'body';
  }
  // Door slab (tested at its CLOSED position: the doorway opening is gate
  // body whether or not the door is currently slid up).
  let t = ns ? (sx0 - lx) / runX : (lx - sx0) / runX;
  if (t > 0 && t < 1) {
    let lineY = sy0 + 16 + 16 * (n - 1) * t;
    if (ly >= lineY - 16 - 9 - pad && ly <= lineY + pad) return 'body';
  }
  return null;
}

// Exact "is this logical point on the entity's drawn shape" test. Re-runs the
// real drawUnit/drawBuilding into a tiny offscreen with the camera shifted so
// (lx,ly) lands at the sample window's centre, then reads the alpha there —
// the same _maskDraw path the selection outline uses (render-outlines.js), so
// the clickable area and the outline are guaranteed to match. Cheap: only ever
// called on click/tap, and only for the 0-3 buildings whose extent box the
// cursor falls in; the draw is clipped to a few pixels around the cursor.
let _hitMaskC = null, _hitMaskX = null, _hitMaskWin = 0;
function entityPixelHit(e, lx, ly) {
  let win = isMobile ? 9 : 5;             // sample window (logical px), = tap forgiveness
  let half = (win - 1) / 2;
  // Build the offscreen once (size is constant per device). willReadFrequently
  // keeps it on a CPU-backed surface so the getImageData readback below stays
  // cheap — this only ever runs on a click, but there's no reason to pay a
  // GPU stall for it.
  if (!_hitMaskC || _hitMaskWin !== win) {
    _hitMaskC = document.createElement('canvas');
    _hitMaskC.width = win; _hitMaskC.height = win;
    _hitMaskX = _hitMaskC.getContext('2d', { willReadFrequently: true });
    _hitMaskWin = win;
  }
  _hitMaskX.clearRect(0, 0, win, win);
  _hitMaskX.globalAlpha = 1;
  let sv = { X, camX, camY, ZOOM };
  X = _hitMaskX; ZOOM = 1;                // mask draws in logical px; keep W/H/topH real
  camX = sv.camX + lx - half;            // shift so (lx,ly) -> (half,half)
  camY = sv.camY + ly - half;
  window._maskDraw = true;
  try {
    if (e.type === 'unit') drawUnit(e); else drawBuilding(e);
  } catch (err) {
    /* a draw failure shouldn't wedge selection — treat as miss */
  } finally {
    window._maskDraw = false;
    X = sv.X; camX = sv.camX; camY = sv.camY; ZOOM = sv.ZOOM;
  }
  let data = _hitMaskX.getImageData(0, 0, win, win).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
  return false;
}

function getBuildingUnderCursor(sx, sy, filter) {
  // BLDG_HEIGHTS is a shared global — see core.js.
  let bestB = null;
  let bestSortY = -9999;
  let bestLink = null;
  let bestLinkSortY = -9999;
  // Wall-likes are hit-tested against drawn geometry in unzoomed local
  // space; invert the render zoom (which scales around (W/2, H/2+topH),
  // see render.js) once here.
  let lx = (sx - W / 2) / ZOOM + W / 2;
  let ly = (sy - H / 2 - topH) / ZOOM + H / 2 + topH;
  entities.forEach(en=>{
    if(en.type==='building' && (!filter || filter(en))){
      let w = en.w !== undefined ? en.w : BLDGS[en.btype].w;
      let h = en.h !== undefined ? en.h : BLDGS[en.btype].h;
      let cx = en.x + w / 2;
      let cy = en.y + h / 2;
      if (isWallBtype(en.btype) || isGateBtype(en.btype)) {
        let part = wallGateHitPart(en, lx, ly);
        if (!part) return;
        let sortY = cy + cx;
        if (part === 'link') {
          // Fallback tier: a pillar/post/door ('body') hit anywhere wins
          // over an extension hit, so the slab running INTO a post never
          // steals the post's own click.
          if (sortY > bestLinkSortY) { bestLinkSortY = sortY; bestLink = en; }
        } else if (sortY > bestSortY) {
          bestSortY = sortY;
          bestB = en;
        }
        return;
      }
      // Generic buildings: broad-phase against the silhouette's known extent
      // box (footprint top anchor, see render-outlines.js), then confirm with
      // an EXACT pixel test against the actual drawn shape. Footprint-derived
      // geometry can never match the art (e.g. the TC's annex posts hang well
      // outside the 4x4 footprint) — testing the real pixels means the click
      // area always agrees with the selection outline, by construction.
      let bIso = toIso(cx, cy);
      let aX = bIso.ix - camX + W/2;                       // logical anchor x (footprint centre)
      let aY = bIso.iy - camY + topH + H/2 - h * HALF_TH;  // logical anchor y (footprint top)
      if (lx >= aX - 175 && lx <= aX + 175 && ly >= aY - 216 && ly <= aY + 134) {
        if (entityPixelHit(en, lx, ly)) {
          let sortY = cy + cx;
          if (sortY > bestSortY) {
            bestSortY = sortY;
            bestB = en;
          }
        }
      }
    }
  });
  return bestB || bestLink;
}

function getUnitUnderCursor(sx, sy) {
  let bestU = null;
  let bestSortY = -9999;
  // Units render tiny at normal zoom, so give clicks a bit of forgiveness
  // on both desktop and mobile — mobile gets more since fingers are much
  // less precise than a mouse cursor.
  let extraHit = (isMobile ? 6 : 3) * ZOOM;

  entities.forEach(en => {
    if (en.type === 'unit' && !en.garrisonedIn) {
      let eux = Math.round(en.x), euy = Math.round(en.y);
      let uf = (eux >= 0 && eux < MAP && euy >= 0 && euy < MAP) ? fog[euy][eux] : 0;
      if (en.team !== myTeam && uf !== 2) return;

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
      } else if (en.utype === 'bear') {
        // Cartoon bear is drawn much wider/taller than a sheep
        w = 22 * ZOOM + extraHit;
        hStart = 4 * ZOOM + extraHit;
        hEnd = -24 * ZOOM - extraHit;
      } else if (en.utype === 'tradecart') {
        // recentered wagon + yoked ox composite spans ~±42px around the
        // anchor — clicking anywhere on it (incl. the ox head) selects
        w = 44 * ZOOM + extraHit;
        hStart = 5 * ZOOM + extraHit;
        hEnd = -26 * ZOOM - extraHit;
      } else if (en.utype === 'ram') {
        w = 30 * ZOOM + extraHit;
        hStart = 5 * ZOOM + extraHit;
        hEnd = -32 * ZOOM - extraHit;
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
  if(gameOver)return; // match is over — See Map is view-only (pan/zoom stay live)
  let tile=screenToTile(sx,sy);
  let clicked=getUnitUnderCursor(sx, sy);
  if(clicked && clicked.team!==myTeam){
    let tx = Math.floor(clicked.x), ty = Math.floor(clicked.y);
    let visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && fog[ty][tx] === 2;
    if(!visible) clicked=null;
  }
  if(!clicked){
    clicked = getBuildingUnderCursor(sx, sy);
    // Don't select enemy buildings that aren't visible
    if(clicked && clicked.team!==myTeam && buildingFogLevel(clicked)!==2) clicked=null;
  }
  if(clicked){
    if(shift){
      if(!selected.some(s=>s.id===clicked.id))selected.push(clicked);
    }
    else selected=[clicked];

    // Play selection sound (player team 0)
    if (clicked.team === myTeam && window.playSound) {
      if (clicked.type === 'unit') {
        if (clicked.utype === 'villager') window.playSound('select_villager');
        else if (clicked.utype === 'sheep') window.playSound('sheep');
        else window.playSound('select_military');
      }
    }
  } else {
    if (selected.length > 0 && selected[0].team === myTeam) {
      showMsg("Use Right-Click (or Ctrl+Click on Mac) to move/command units!");
    }
    selected=[];
  }
}

function doBoxSelect(x1,y1,x2,y2){
  if(gameOver)return; // match is over — no selecting over the frozen map
  let sx1=Math.min(x1,x2),sy1=Math.min(y1,y2);
  let sx2=Math.max(x1,x2),sy2=Math.max(y1,y2);
  selected=entities.filter(en=>{
    if(en.team!==myTeam)return false;
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
  if (selected.length > 0 && selected[0].team === myTeam && window.playSound) {
    let first = selected[0];
    if (first.utype === 'villager') window.playSound('select_villager');
    else if (first.utype === 'sheep') window.playSound('sheep');
    else window.playSound('select_military');
  }
}

function doCommand(sx,sy){
  if(gameOver)return; // match is over — no commands over the frozen map
  placing=null; // cancel building placement preview when commanding units
  if(selected.length===0)return;
  // Clicks never mutate world state directly — this resolves the click to
  // a world-space command and submits it to the queue (submitCommand),
  // which executes it a few ticks later on BOTH peers (lockstep). The
  // marker-color/rally-target DETECTION below reads only client-local data
  // (fog, entities, map, myTeam), so the issuer gets instant local
  // feedback (marker + sound/message) without waiting for the exec tick —
  // feedback that was always purely cosmetic.
  let resTarget = getResourceUnderCursor(sx, sy);
  let tile = resTarget ? { x: resTarget.x, y: resTarget.y } : screenToTile(sx, sy);

  // If a friendly training building is selected, this is the RALLY path —
  // the building half of right-click-to-flag. Both skins now set the rally
  // on a right-click (AoE2 standard), matching how right-clicking a unit
  // selection plants a guard/escort flag. On index.html doCommand is only
  // reached for a building via a right-click or the armed Set Rally button,
  // both of which should relocate the flag — so no extra gate is needed.
  if(selected[0].type==='building'&&selected[0].team===myTeam){
    let bldg=selected[0];
    let bData=BLDGS[bldg.btype];
    if(!bData || !bData.builds || bData.builds.length === 0) return;
    if(!inMapBounds(tile.x,tile.y))return;

    // Find target entity under the click. UNITS are not rally targets —
    // execRally snaps a flag dropped on one to the tile it's standing on,
    // so mirror that here: adjust the feedback tile and drop the target,
    // and the message reads as ground/resource, never "set to Villager".
    let rTarget = getUnitUnderCursor(sx, sy);
    if(rTarget){
      tile = { x: Math.max(0, Math.min(MAP-1, Math.round(rTarget.x))),
               y: Math.max(0, Math.min(MAP-1, Math.round(rTarget.y))) };
      rTarget = null;
    } else {
      rTarget = getBuildingUnderCursor(sx, sy);
      // Same filter as execRally — the shared isRallyBuildingTarget
      // (js/commands.js) keeps the message and the sim in agreement.
      if(rTarget && !isRallyBuildingTarget(rTarget, myTeam)) rTarget = null;
    }

    feedbackFor(myTeam, () => {
      if(rTarget){
        showMsg('Rally point set to '+ BLDGS[rTarget.btype].name);
      } else {
        let t0=map[tile.y]&&map[tile.y][tile.x];
        if(t0&&(t0.t===TERRAIN.FOREST||t0.t===TERRAIN.GOLD||t0.t===TERRAIN.STONE||t0.t===TERRAIN.BERRIES||t0.t===TERRAIN.FARM)){
          let resNames={[TERRAIN.FOREST]:'wood',[TERRAIN.GOLD]:'gold',[TERRAIN.STONE]:'stone',[TERRAIN.BERRIES]:'food',[TERRAIN.FARM]:'food (farm)'};
          showMsg('Rally point set to gather '+resNames[t0.t]);
        } else {
          showMsg('Rally point set to location');
        }
      }
      // Local-only click feedback — viewer cosmetic, never part of sim state
      cmdMarkers.push({x:tile.x,y:tile.y,time:tick,color:'#0af'});
    });

    // World-space command, scheduled on the tick queue (js/commands.js) —
    // the mutation itself happens in execRally at the stamped tick.
    submitCommand({ kind: 'rally', bldgId: bldg.id, tileX: tile.x, tileY: tile.y, targetId: rTarget ? rTarget.id : null });
    // Issuer-side flag PREVIEW (cosmetic, never sim state): the command
    // executes INPUT_DELAY_TICKS from now, and without this the planted
    // flag renders at the OLD rally spot for those frames — a visible
    // flicker-and-jump on every rally click. render.js draws the flag at
    // the preview spot until the exec tick has safely passed.
    window.pendingRallyPreview = { bldgId: bldg.id, x: tile.x, y: tile.y, at: tick };
    return;
  }
  // Visual command marker. The gather (yellow) color only applies to an
  // EXPLORED resource tile — a click on unexplored ground is a plain walk
  // (the villager can't be tasked to an unseen resource, see execUnitCommand
  // in js/commands.js), so it stays green. Mirrors that sim rule using the
  // viewer's own fog (this marker is local cosmetic feedback).
  let t0=map[tile.y]&&map[tile.y][tile.x];
  let seen = window.fogDisabled || (fog[tile.y] && fog[tile.y][tile.x] !== 0);
  let markerColor='#0f0';
  if(seen&&t0&&(t0.t===TERRAIN.FOREST||t0.t===TERRAIN.GOLD||t0.t===TERRAIN.STONE||t0.t===TERRAIN.BERRIES||t0.t===TERRAIN.FARM))markerColor='#ff0';
  // Check if targeting enemy OR own sheep for harvesting OR own unit to follow
  let target=null;
  let buildTarget=null;
  let followTarget=null;
  
  let clickedUnit = getUnitUnderCursor(sx, sy);
  if (clickedUnit && clickedUnit.team !== myTeam) {
    let tx = Math.floor(clickedUnit.x), ty = Math.floor(clickedUnit.y);
    let visible = (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) && fog[ty][tx] === 2;
    if (!visible) clickedUnit = null;
  }
  if (clickedUnit) {
    // Any OTHER player team is an attack target. Gaia (sheep/bears) is
    // handled by the separate utype checks below, not by this comparison.
    if (isEnemyOf(myTeam, clickedUnit)) {
      target = clickedUnit;
    } else if (clickedUnit.utype === 'sheep' || clickedUnit.utype === 'sheep_carcass') {
      target = clickedUnit;
    } else if (clickedUnit.utype === 'bear') {
      // Wild bear (gaia): right-click means attack, never follow
      target = clickedUnit;
    } else {
      followTarget = clickedUnit;
    }
  }
  if(!target){
    target = getBuildingUnderCursor(sx, sy, en => isEnemyOf(myTeam, en) && buildingFogLevel(en) === 2);
  }
  // Trade cart onto an ALLY's Market: an allied market is same-side-but-not-own,
  // so it's dropped by both the enemy-target and own-building filters — pass it
  // as the target so execUnitCommand's tradecart branch can start the route.
  // (Enemy markets are already picked above; gated on a cart being selected so
  // nothing else changes.)
  if(!target && selected.some(s => s.type === 'unit' && s.utype === 'tradecart' && s.team === myTeam)){
    // No fog-level gate here (unlike enemy targets): you're sending your own
    // cart to a KNOWN ally/other-player Market — if you can click it you can
    // trade with it, and ally vision/distance shouldn't block a friendly route.
    target = getBuildingUnderCursor(sx, sy, en => en.btype === 'MARKET' && en.team !== myTeam && isPlayerTeam(en.team));
  }
  if(!target){
    // Repair/build-finish takes priority over "Follow" — a friendly unit
    // merely standing near a damaged building shouldn't hijack the click.
    // Manual garrisoning-by-click was removed for simplicity: the town bell
    // is now the only way villagers garrison, so clicking an own building
    // always means "fix it" (repair if damaged, resume if unfinished).
    buildTarget = getBuildingUnderCursor(sx, sy, en => en.team === myTeam && (!en.complete || en.hp < en.maxHp));
  }
  if(buildTarget)followTarget=null;
  if(target && target.utype==='sheep_carcass')markerColor='#ff0';
  else if(target && target.type==='building' && target.btype==='MARKET' && target.team!==myTeam)markerColor='#0af'; // trade, not attack
  else if(target)markerColor='#f44';
  else if(buildTarget)markerColor='#0af';
  else if(followTarget)markerColor='#0f8';
  feedbackFor(myTeam, () => {
    // Local-only click feedback — viewer cosmetic, never part of sim state
    cmdMarkers.push({x:tile.x,y:tile.y,time:tick,color:markerColor});
  });

  // Play response sound on command — issuer feedback (feedbackFor no-ops
  // for the other peer's replayed commands and during rollback resim).
  let movers=selected.filter(s=>s.team===myTeam&&s.type==='unit');
  if (movers.length > 0 && window.playSound && myTeam === localHumanTeam) {
    let first = movers[0];
    if (first.utype === 'villager') window.playSound('select_villager');
    else if (first.utype !== 'sheep') window.playSound('select_military');
  }

  // Record the keep-selection decision for THIS command (see pendingOrderUI).
  // The rule (index.html streamlined model): a real TASK — gather/farm,
  // build, repair, attack, follow — deselects, so ordering a unit feels like
  // "assign it and move on". The ONLY keep is a plain WALK: to explored
  // ground where nothing is committed, OR to an UNEXPLORED tile (we can't
  // know what's there yet, so it's a move into the unknown, not a task).
  {
    prunePendingOrders();
    let t0p = map[tile.y] && map[tile.y][tile.x];
    let GATHERABLE_T = t0p && (t0p.t === TERRAIN.FOREST || t0p.t === TERRAIN.GOLD || t0p.t === TERRAIN.STONE || t0p.t === TERRAIN.BERRIES || t0p.t === TERRAIN.FARM);
    let unexplored = !seen; // `seen` (viewer fog) computed above for the marker color
    let plainWalk = !target && !buildTarget && !followTarget;
    movers.forEach(s => {
      let keep = unexplored || (plainWalk && !(s.utype === 'villager' && GATHERABLE_T));
      pendingOrderUI.set(s.id, { t: tick, keep });
    });
  }

  // World-space command with all targets resolved to ids against THIS
  // client's view (its fog, its screen). Mutation happens in
  // execUnitCommand (js/commands.js) at the scheduled tick — on the host's
  // queue for now, on both peers' queues once lockstep lands.
  submitCommand({
    kind: 'command',
    unitIds: movers.map(s => s.id),
    tileX: tile.x, tileY: tile.y,
    targetId: target ? target.id : null,
    buildTargetId: buildTarget ? buildTarget.id : null,
    followId: followTarget ? followTarget.id : null
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

// Resolver only: screen->tile plus issuer-local UI concerns (placement
// preview mode, Shift-to-repeat, "select a villager" nag). The actual
// placement/cost/foundation mutation is execBuildPlacement (js/commands.js),
// run at the scheduled tick.
function doPlace(sx,sy){
  let tile=screenToTile(sx,sy);
  let vils = selected.filter(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam);
  if(vils.length===0){
    showMsg('Select a villager to build!');
    placing=null;
    return;
  }
  submitCommand({ kind: 'build-placement', btype: placing, tileX: tile.x, tileY: tile.y, unitIds: vils.map(s=>s.id) });
  // Hold Shift to place multiple building foundations
  if(!keys['Shift']){
    placing=null;
    // Building is a task → deselect once the last foundation is placed
    // (index model). Shift-placing keeps them for the next foundation, and
    // classic stays AoE2-sticky.
    deselectAfterTask();
  } else {
    showMsg('Place next foundation (release Shift to finish)');
  }
}

// ---- CAMERA SCROLL (Desktop) ----
function handleScroll(elapsed){
  if(gameOver && !window.seeMapMode)return; // keep panning while reviewing the map
  let dt = elapsed !== undefined ? elapsed / 16.67 : 1.0;
  let spd = 12 * dt;
  let manualPan=false;

  // Arrow keys only, like AoE2 — WASD are (grid) command hotkeys, and letting
  // them also pan meant holding one while a barracks/villager was selected
  // trained units / armed placements mid-scroll.
  if(keys['ArrowUp']){camY-=spd;manualPan=true;}
  if(keys['ArrowDown']){camY+=spd;manualPan=true;}
  if(keys['ArrowLeft']){camX-=spd;manualPan=true;}
  if(keys['ArrowRight']){camX+=spd;manualPan=true;}



  // Camera-follow: any manual pan input releases the lock; otherwise keep
  // re-centering on the followed unit every frame (see toggleCameraFollow()).
  if(manualPan){
    window.cameraFollowId=null;
  } else if(window.cameraFollowId){
    let f=entitiesById.get(window.cameraFollowId);
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
  if (window.__editorMode) return; // scenario editor handles its own canvas input
  if (gameOver || recentTouch()) return;
  let clicked = getUnitUnderCursor(e.clientX, e.clientY);
  if (clicked && clicked.team === myTeam) {
    selected = entities.filter(en => en.team === myTeam && en.type === 'unit' && en.utype === clicked.utype && isUnitOnScreen(en));
    if (window.playSound) {
      if (clicked.utype === 'villager') window.playSound('select_villager');
      else window.playSound('select_military');
    }
    updateUI();
    return;
  }
  // Desktop parity with the touch double-tap: double-click an unfinished
  // wall foundation to select its whole connected chain for bulk cancel,
  // or a COMPLETED wood wall to select its connected run (bulk actions
  // like Upgrade to Stone).
  let wallB = getBuildingUnderCursor(e.clientX, e.clientY, isWallSelectTarget);
  if (wallB) {
    if (wallB.complete) {
      selected = collectCompletedWallRun(wallB);
      showMsg(selected.length + ' wall segment' + (selected.length > 1 ? 's' : '') + ' selected');
    } else {
      selected = collectUnfinishedWallChain(wallB);
      showMsg(selected.length + ' wall foundation' + (selected.length > 1 ? 's' : '') + ' selected');
    }
    updateUI();
  }
});
