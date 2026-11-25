// A ghost is painted whole, solid, on a layer of its own, and the layer laid on see-through: painted see-through piece
// by piece, wherever two of its parts lap (a wall's slabs do, by design) the lap shows darker and what it covers shows
// through — the preview would not look like the wall it previews.
let _ghostLayer = null;
function ghostLayer(draw){
  const main = X, cv = main.canvas;
  if (!_ghostLayer) _ghostLayer = document.createElement('canvas');
  if (_ghostLayer.width !== cv.width || _ghostLayer.height !== cv.height) { _ghostLayer.width = cv.width; _ghostLayer.height = cv.height; }
  const g = _ghostLayer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.setTransform(main.getTransform());
  X = g; try { draw(); } finally { X = main; }
  main.save(); main.setTransform(1, 0, 0, 1, 0, 0); main.globalAlpha = 0.55; main.drawImage(_ghostLayer, 0, 0); main.restore();
}
// The wall pieces, gate or tower being placed, where they FIT, as the tiles' occupants (getConnectedBuilding's
// overlay): set for the whole frame (renderFrame), so the walls already standing are drawn as they will be once it
// is built — a join toward it, a post gained or lost, a wall under a new gate gone — and the preview is the finished
// thing, its new parts see-through. null: nothing wall-like is being placed, or it doesn't fit.
function ghostOverlay(){
  if (!placing || !(isWallBtype(placing) || isGateBtype(placing) || isTowerBtype(placing))) return null;
  const b = BLDGS[placing], m = new Map();
  const mk = (x, y, w, h) => ({ type:'building', btype:placing, x, y, team:myTeam, hp:b.hp, maxHp:b.hp, complete:true, buildProgress:0, buildTime:200, queue:[], garrison:[], w, h, rallyX:x, rallyY:y, gateProgress:0, ghost:true });
  if (isWallBtype(placing) && window.isDraggingWall && window.wallDragStart && window.wallDragEnd) {
    for (const t of getWallElbowTiles(window.wallDragStart, window.wallDragCorner || window.wallDragEnd, window.wallDragEnd))
      if (canPlace(placing, t.x, t.y, myTeam, window.__editorMode, window.__editorMode)) m.set(t.y * MAP + t.x, mk(t.x, t.y, 1, 1));
  } else {
    const tile = screenToTile(mouseX, mouseY); let ox = tile.x, oy = tile.y, bw = b.w, bh = b.h;
    if (isGateBtype(placing)) { const fp = gateFootprint(tile.x, tile.y, (tx, ty) => gateBaseAt(tx, ty, placing, myTeam)); ox = fp.ox; oy = fp.oy; bw = fp.gw; bh = fp.gh; }
    if (!canPlace(placing, tile.x, tile.y, myTeam, window.__editorMode, window.__editorMode)) return null;
    const e = mk(ox, oy, bw, bh); for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) m.set((oy + dy) * MAP + ox + dx, e);
  }
  return m.size ? m : null;
}
function drawGhost(){
  if(!placing)return;
  const world = window._ghostTiles;   // (the frame's overlay: back when this ghost has drawn through its own)
  try { drawGhostArt(); } finally { window._ghostTiles = world; }
}
function drawGhostArt(){
  let tile=screenToTile(mouseX,mouseY);

  // Wall drag: show the actual wall pillars/links along the drag line
  // (same ghost style as a single hovered wall), not just flat tint tiles.
  if (isWallBtype(placing) && window.isDraggingWall && window.wallDragStart && window.wallDragEnd) {
    let line = getWallElbowTiles(window.wallDragStart, window.wallDragCorner || window.wallDragEnd, window.wallDragEnd);
    let b = BLDGS[placing];
    // Render the drag preview through the REAL placed-wall path (drawBuilding's
    // WALL branch), so pillars/materials/links/cross-rung suppression and joins
    // to existing walls are all identical to what gets built — one code path,
    // no separate ghost geometry to drift. The not-yet-placed tiles are exposed
    // to getConnectedBuilding via a viewer-side overlay (no grid mutation).
    let overlay = new Map();
    line.forEach(t => overlay.set(t.y*MAP + t.x, {
      type:'building', btype:placing, x:t.x, y:t.y, team:myTeam,
      hp:b.hp, maxHp:b.hp, complete:true, buildProgress:0, buildTime:200,
      queue:[], garrison:[], w:1, h:1
    }));
    window._ghostDraw = true; window._ghostValid = true; window._ghostTiles = overlay;
    // Depth order: far tiles (smaller y+x) first so nearer pillars overlap.
    try { ghostLayer(() => line.slice().sort((a,c) => (a.y+a.x) - (c.y+c.x))
        .forEach(t => drawBuilding(overlay.get(t.y*MAP + t.x)))); }
    finally { window._ghostTiles = null; window._ghostDraw = false; }

    // Tint each tile green (valid) or red (invalid)
    line.forEach(t => {
      let ok = canPlace(placing, t.x, t.y, myTeam, window.__editorMode, window.__editorMode);
      let {sx, sy} = mapToScreen(t.x, t.y);
      X.fillStyle = ok ? 'rgba(0,200,0,0.28)' : 'rgba(200,0,0,0.28)';
      X.beginPath();
      X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
      X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
      X.closePath();X.fill();
    });
    return;
  }

  let b=BLDGS[placing];
  let bw=b.w, bh_=b.h;
  let ox=tile.x, oy=tile.y;
  if(isGateBtype(placing)){
    let isWall = (tx, ty) => gateBaseAt(tx, ty, placing, myTeam);
    let fp = gateFootprint(tile.x, tile.y, isWall);
    ox=fp.ox; oy=fp.oy; bw=fp.gw; bh_=fp.gh;
    // Show EXACTLY the footprint that will be built (gateFootprint) — no
    // fabricated size (a full-1x3 fallback made the ghost jump + flip the
    // instant a gate consumed its wall run). With no run it's a 1x1 red
    // ghost: honestly "can't place here".
  }
  let ok=canPlace(placing,tile.x,tile.y,myTeam,window.__editorMode,window.__editorMode);

  // Draw ghost: actual building rendered semi-transparently
  let fakeE={
    type:'building', btype:placing, x:ox, y:oy, team:myTeam,
    hp:b.hp, maxHp:b.hp, complete:true,
    buildProgress:0, buildTime:200, queue:[],
    w:bw, h:bh_, rallyX:ox, rallyY:oy, gateProgress:0
  };
  window._ghostDraw=true;
  window._ghostValid=ok; // invalid ghosts draw no wall-connection stubs (getConnectedBuilding)
  // (a wall piece, a tower or a gate that fits: on the overlay, as a drag's tiles are — the pieces round it are drawn
  // by the same rules as when it stands, so they must see it there)
  if (ok && (isWallBtype(placing) || isGateBtype(placing) || isTowerBtype(placing))) {
    window._ghostTiles = new Map(); for (let dy = 0; dy < bh_; dy++) for (let dx = 0; dx < bw; dx++) window._ghostTiles.set((oy + dy) * MAP + ox + dx, fakeE);
  }
  try { ghostLayer(() => drawBuilding(fakeE)); } finally { window._ghostDraw=false; window._ghostTiles=null; }

  // Tint footprint tiles green (valid) or red (invalid)
  X.fillStyle=ok?'rgba(0,200,80,0.28)':'rgba(220,30,0,0.28)';
  for(let dy=0;dy<bh_;dy++)for(let dx=0;dx<bw;dx++){
    let {sx, sy} = mapToScreen(ox+dx, oy+dy);
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
    X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
    X.closePath();X.fill();
  }
}

function drawSelection(){
  if(!dragStart||!dragEnd)return;
  X.strokeStyle='#0f0';X.lineWidth=1;
  X.setLineDash([4,4]);
  let x1=Math.min(dragStart.x,dragEnd.x), y1=Math.min(dragStart.y,dragEnd.y);
  let x2=Math.max(dragStart.x,dragEnd.x), y2=Math.max(dragStart.y,dragEnd.y);
  X.strokeRect(x1,y1,x2-x1,y2-y1);
  X.setLineDash([]);
}

// Terrain-layer cache: repainting all MAP² fog-tinted tile diamonds — and
// reallocating the canvas buffer via the width/height assignment — every
// frame was the single biggest per-frame cost on mobile. The tile layer only
// changes as fog is revealed / terrain mutates, and a ~4Hz refresh is
// imperceptible on a minimap, so it's painted to an offscreen canvas and
// blitted. Entities, blink, and the viewport rectangle stay per-frame.
let miniTerrain=null, miniTerrainAt=-1e9, miniTiles=null, miniTilesImg=null;
// Minimap tile colours as little-endian RGBA words: [1] explored-not-visible, [2] in view (per terrain; grass the default).
const MINI_RGBA=(()=>{ const w=h=>{ let v=parseInt(h.slice(1),16); return (0xff000000|((v&0xff)<<16)|(v&0xff00)|(v>>16))>>>0; };
  const pal=(g,fo,go,st,wa,fa)=>({grass:w(g),[TERRAIN.GRASS]:w(g),[TERRAIN.FOREST]:w(fo),[TERRAIN.GOLD]:w(go),[TERRAIN.STONE]:w(st),[TERRAIN.WATER]:w(wa),[TERRAIN.FARM]:w(fa)});
  return {1:pal('#254615','#0d2008','#6d5210','#404040','#224c6e','#453d28'), 2:pal('#4a8c2a','#1a4010','#daa520','#808080','#4499dd','#8a7a50')}; })();
let miniW=0, miniH=0, miniDimsStale=true;
window.addEventListener('resize',()=>{miniDimsStale=true;});
// The wrap's size also changes WITHOUT a window resize — most importantly
// when the minimap is toggled visible (its size was measured while hidden,
// which left it tiny until the next rotate/resize). Observe the wrap
// directly so any layout change re-measures on the next frame.
if (typeof ResizeObserver !== 'undefined' && MC.parentElement) {
  new ResizeObserver(()=>{miniDimsStale=true;}).observe(MC.parentElement);
}
// Synchronous re-measure + redraw for the moment the minimap is toggled
// (js/input.js toggleMinimap): the observer delivers too late for the very
// next painted frame, which briefly showed the canvas at its OLD size
// inside the newly-sized wrap — a visible small→large flicker on click.
function refreshMinimapSize(){
  miniDimsStale=true;
  if(MC.parentElement && MC.parentElement.clientWidth>0) drawMinimap();
}
const MINI_TERRAIN_REFRESH_MS=250;

function drawMinimap(){
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  if(miniDimsStale||!miniW){ // layout read (clientWidth forces reflow) only after a resize
    miniW=MC.parentElement.clientWidth||160;
    miniH=MC.parentElement.clientHeight||160;
    miniDimsStale=false;
  }
  let mw=miniW,mh=miniH;
  if(MC.width!==mw*dpr||MC.height!==mh*dpr){ // realloc only when the size actually changed
    MC.width=mw*dpr;MC.height=mh*dpr;
    MC.style.width=mw+'px';MC.style.height=mh+'px';
  }
  MX.setTransform(dpr,0,0,dpr,0,0);
  let mt=getMiniTransform(mw,mh);
  let miniPoint=(x,y)=>{
    let iso=toIso(x,y);
    return{x:mt.ox+iso.ix*mt.scale,y:mt.oy+iso.iy*mt.scale};
  };
  let fillDiamond=(points,color)=>{
    MX.fillStyle=color;
    MX.beginPath();
    MX.moveTo(points[0].x,points[0].y);
    for(let i=1;i<points.length;i++)MX.lineTo(points[i].x,points[i].y);
    MX.closePath();
    MX.fill();
  };

  if(!miniTerrain||miniTerrain.width!==mw*dpr||miniTerrain.height!==mh*dpr
     ||performance.now()-miniTerrainAt>MINI_TERRAIN_REFRESH_MS){
    if(!miniTerrain)miniTerrain=document.createElement('canvas');
    if(miniTerrain.width!==mw*dpr)miniTerrain.width=mw*dpr;
    if(miniTerrain.height!==mh*dpr)miniTerrain.height=mh*dpr;
    let TX=miniTerrain.getContext('2d');
    // One pixel per tile on a MAP×MAP image, laid onto the diamond by the minimap's own iso transform in one draw —
    // a path fill per tile (MAP² of them) cost ~5ms a refresh, a visible hitch in the 3D view every quarter second.
    if(!miniTiles||miniTiles.width!==MAP){ miniTiles=document.createElement('canvas'); miniTiles.width=miniTiles.height=MAP; miniTilesImg=null; }
    let MT=miniTiles.getContext('2d');
    if(!miniTilesImg) miniTilesImg=MT.createImageData(MAP,MAP);
    let px=new Uint32Array(miniTilesImg.data.buffer);
    for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){
      let f = fog[y] && fog[y][x];
      px[y*MAP+x] = f===1 ? MINI_RGBA[1][map[y][x].t]||MINI_RGBA[1].grass : f===2 ? MINI_RGBA[2][map[y][x].t]||MINI_RGBA[2].grass : 0xff000000; // unexplored is black
    }
    MT.putImageData(miniTilesImg,0,0);
    TX.setTransform(1,0,0,1,0,0);
    TX.clearRect(0,0,miniTerrain.width,miniTerrain.height);
    let k=mt.scale*dpr;
    TX.setTransform(k*HALF_TW,k*HALF_TH,-k*HALF_TW,k*HALF_TH,mt.ox*dpr,mt.oy*dpr); // tile (x, y) → toIso → the minimap, as miniPoint
    TX.imageSmoothingEnabled=false;                                                  // crisp tiles, as the per-tile fills were
    TX.drawImage(miniTiles,0,0);
    miniTerrainAt=performance.now();
  }
  MX.clearRect(0,0,mw,mh);
  MX.setTransform(1,0,0,1,0,0);
  MX.drawImage(miniTerrain,0,0);
  MX.setTransform(dpr,0,0,dpr,0,0);
  // (ornamental frame is drawn last, on top of entities/viewport — see below)
  // Selected objects draw white (AoE2-style) so the current selection is
  // findable on the minimap at a glance.
  let selectedIds=new Set(selected.map(s=>s.id));
  entities.forEach(e=>{
    if(e.type==='unit'&&e.garrisonedIn)return; // hidden inside a building
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f = e.type === 'building' ? buildingFogLevel(e) : ((fog[ey] && fog[ey][ex]) || 0);
    if (f === 0) return; // completely unexplored — hide everything
    if (f === 1 && !sameSide(e.team, myTeam) && e.type !== 'building') return; // hide ENEMY units in shroud (allies shared-visible; buildings remembered)
    // Enemy buildings in shroud are only "remembered" if they were actually
    // seen at some point — same scoutedByMe rule as the main map (js/core.js),
    // so the two views never disagree (and buildings put up after we left
    // aren't leaked).
    if (f === 1 && !sameSide(e.team, myTeam) && e.type === 'building' && !scoutedByMe.has(e.id)) return;

    let isSel=selectedIds.has(e.id);
    // Under-attack blink (AoE2): a player object hit in the last ~4 game-s
    // pulses white on the minimap so raids are spottable at a glance.
    // 60-tick cycle ≈ 1 blink per real second at 2x speed — slow enough to
    // read as a deliberate alert rather than a flicker.
    let recentlyHit=e.team===myTeam&&e.lastHitTick!==undefined&&tick-e.lastHitTick<T30(120);
    let blinkOn=recentlyHit&&(tick-e.lastHitTick)%T30(60)<T30(30);
    let color=(isSel||blinkOn)?'#ffffff':teamColorMinimap(e.team);
    if(e.type==='building'){
      let w=e.w||1,h=e.h||1;
      fillDiamond([miniPoint(e.x,e.y),miniPoint(e.x+w,e.y),miniPoint(e.x+w,e.y+h),miniPoint(e.x,e.y+h)],color);
    } else {
      let p=miniPoint(e.x+0.5,e.y+0.5);
      // Dot scales with the minimap's zoom (≈ half a tile), so units stay
      // visible when the map is expanded instead of staying 2px specks.
      let dot=Math.max(2,HALF_TW*mt.scale);
      if(isSel)dot+=1; // selected dots read slightly bigger, like AoE2
      MX.fillStyle=color;
      MX.fillRect(p.x-dot/2,p.y-dot/2,dot,dot);
    }
  });
  // Scenario objective flags (js/triggers.js markers): a gold ring at each area's center.
  if(typeof scenarioState!=='undefined'&&scenarioState&&scenarioState.markers.length){
    scenarioState.markers.forEach(m=>{
      let a=scenarioArea(m); if(!a)return;
      let p=miniPoint(a.x+a.w/2,a.y+a.h/2);
      MX.strokeStyle='#ffd34d';MX.lineWidth=2;
      MX.beginPath();MX.arc(p.x,p.y,4+2*Math.sin(performance.now()/260),0,Math.PI*2);MX.stroke();
    });
  }
  let bottomY=window.innerHeight-bottomH;
  let vp=[
    screenToMap(0,topH),
    screenToMap(W,topH),
    screenToMap(W,bottomY),
    screenToMap(0,bottomY)
  ].map(p=>miniPoint(p.x,p.y));
  MX.strokeStyle='#fff';MX.lineWidth=1;
  MX.beginPath();
  MX.moveTo(vp[0].x,vp[0].y);
  for(let i=1;i<vp.length;i++)MX.lineTo(vp[i].x,vp[i].y);
  MX.closePath();
  MX.stroke();

  // Simple thin border around the diamond
  let corners=[miniPoint(0,0),miniPoint(MAP,0),miniPoint(MAP,MAP),miniPoint(0,MAP)];
  MX.strokeStyle='#d8c878';MX.lineWidth=1.5;MX.lineJoin='round';
  MX.beginPath();
  MX.moveTo(corners[0].x,corners[0].y);
  for(let i=1;i<corners.length;i++)MX.lineTo(corners[i].x,corners[i].y);
  MX.closePath();MX.stroke();
}

function drawParticles() {
  X.save();
  particles.forEach(p => {
    let px = Math.round(p.x), ppy = Math.round(p.y);
    // NaN guard: if a particle ever gets a degenerate coord, Math.round(NaN)=NaN
    // and every bounds comparison below is false, so fog[NaN][NaN] would throw
    // and kill the whole frame. Skip the particle instead.
    if (!Number.isFinite(px) || !Number.isFinite(ppy) || ppy < 0 || ppy >= MAP || px < 0 || px >= MAP || fog[ppy][px] !== 2) return;
    
    let scr = mapToScreen(p.x, p.y);
    let sx = scr.sx;
    let sy = scr.sy + HALF_TH;
    
    let pz = p.z || 0;
    sy -= pz * 35;

    // isOffscreen scales the window by 1/ZOOM — a raw W/H bound here would
    // cull particles that are plainly visible when zoomed out.
    if (isOffscreen(sx, sy, 20)) return;

    X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
    
    if (p.type === 'fire') {
      let pct = p.life / p.maxLife;
      let col = '#e02200';
      if (pct > 0.65) col = '#ffff80';
      else if (pct > 0.35) col = '#ff9d21';
      
      let curSize = p.size * (0.3 + pct * 0.9);
      
      X.fillStyle = col;
      X.beginPath();
      X.arc(sx, sy, curSize * 2.0, 0, Math.PI * 2);
      X.globalAlpha = Math.max(0, Math.min(1, (p.life / p.maxLife) * 0.25));
      X.fill();
      
      X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    else if (p.type === 'smoke') {
      let pct = p.life / p.maxLife;
      let curSize = p.size * (1.0 + (1.0 - pct) * 1.5);
      X.fillStyle = 'rgba(100, 100, 100, 0.4)';
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    // a stone's strike (stoneLanded): the ring of dust it throws out along the ground, the cloud rolling up, its shards
    else if (p.type === 'ring') {
      const pct = 1 - p.life / p.maxLife, r = (6 + 30 * Math.sqrt(pct)) * p.size;
      X.globalAlpha = 0.75 * (1 - pct); X.strokeStyle = p.color; X.lineWidth = 1.5 + 5 * (1 - pct);
      X.beginPath(); X.ellipse(sx, sy, r, r / 2, 0, 0, Math.PI * 2); X.stroke();
    }
    else if (p.type === 'puff') {
      const pct = 1 - p.life / p.maxLife;
      const r = p.size * (1 + 1.6 * Math.sqrt(pct)), g = X.createRadialGradient(sx, sy, 0, sx, sy, r);   // (soft-edged: a cloud, not discs)
      g.addColorStop(0, p.color); g.addColorStop(0.55, p.color); g.addColorStop(1, p.color + '00');
      X.globalAlpha = 0.8 * Math.min(1, (1 - pct) * 1.6) * Math.min(1, pct * 8 + 0.3); X.fillStyle = g;
      X.beginPath(); X.arc(sx, sy, r, 0, Math.PI * 2); X.fill();
    }
    else if (p.type === 'chunk') {
      const r = p.size, c = Math.cos(p.spin), s2 = Math.sin(p.spin);
      X.globalAlpha = Math.min(1, p.life / 10); X.fillStyle = p.color; X.strokeStyle = '#000'; X.lineWidth = 0.8;
      X.beginPath(); X.moveTo(sx + c * r, sy + s2 * r); X.lineTo(sx - s2 * r * 0.8, sy + c * r * 0.8); X.lineTo(sx - c * r * 0.9, sy - s2 * r * 0.7); X.lineTo(sx + s2 * r * 0.6, sy - c * r); X.closePath(); X.fill(); X.stroke();
    }
    else if (p.type === 'blood') {
      X.fillStyle = p.color;
      if (pz <= 0.01) {
        X.beginPath();
        X.ellipse(sx, sy, p.size * 1.6, p.size * 0.8, 0, 0, Math.PI * 2);
        X.fill();
      } else {
        X.beginPath();
        X.arc(sx, sy, p.size, 0, Math.PI * 2);
        X.fill();
      }
    } 
    else {
      X.fillStyle = p.color;
      X.beginPath();
      X.arc(sx, sy, p.size, 0, Math.PI * 2);
      X.fill();
    }
  });
  X.restore();
}

// An arrow stuck where it landed (stickArrow, js/core.js): the flying arrow's shaft (same tan shaft on a black
// outline), its head buried, tail up and back along the way it came; Fletching's team vanes at the tail.
function drawStuckArrow(a){
  let s = mapToScreen(a.x, a.y), tx = s.sx, ty = s.sy + HALF_TH - a.h;
  let iso = toIso(a.dx, a.dy), il = Math.hypot(iso.ix, iso.iy) || 1, L = 10;
  let ex = tx - iso.ix / il * L * Math.cos(a.tilt), ey = ty - iso.iy / il * L * Math.cos(a.tilt) - L * Math.sin(a.tilt);
  X.save(); X.globalAlpha *= a.alpha; X.lineCap = 'round';
  X.strokeStyle = '#000'; X.lineWidth = 3; X.beginPath(); X.moveTo(tx, ty); X.lineTo(ex, ey); X.stroke();
  X.strokeStyle = ARROW_SHAFT; X.lineWidth = 1.3; X.beginPath(); X.moveTo(tx, ty); X.lineTo(ex, ey); X.stroke();
  if (a.fl != null) { let ux = (ex - tx) / L, uy = (ey - ty) / L;
    X.strokeStyle = teamColorLight(a.fl); X.lineWidth = 1.6;
    X.beginPath(); X.moveTo(ex - ux * 3, ey - uy * 3); X.lineTo(ex - ux * 0.5 - uy * 2.2, ey - uy * 0.5 + ux * 2.2);
    X.moveTo(ex - ux * 3, ey - uy * 3); X.lineTo(ex - ux * 0.5 + uy * 2.2, ey - uy * 0.5 - ux * 2.2); X.stroke(); }
  X.restore();
}

// ---- Shots in flight: one path, both views ----
// The sim flies each shot along the ground at PROJECTILE_TILES_PER_TICK to its aim point (js/loop.js). The views add
// where it was loosed from and lands (projEnds), its height — launch to what it strikes, plus a parabola (a true lob
// at a steady ground speed) — and carry it on between the sim's steps, never past its aim. V: the view's { flat (2D),
// heading(e), hk (art px up → its px up), arc (an arrow's rise at the top, px per tile of run) }.
const PROJ_HIT_H = 8, STONE_ARC = 5;   // px over the ground where it lands: a body's middle; a trebuchet's lob (an arc, both views)
const isStoneShot = p => !!(p.attackerSnap && p.attackerSnap.utype === 'trebuchet');
const PROJ_2D = { flat: true, heading: e => (e.dir !== undefined ? e.dir : 7) * Math.PI / 4, hk: 1, arc: ARROW_ARC_2D, pitch: ARROW_PITCH_2D };
const _projEnds = new WeakMap();
const ARROW_LEN_2D = 15 * UNIT_SCALE;   // (the nocked arrow's shaft, archerPose's drawing)
// Its ends, kept per shot: [x, y, h px] it's loosed from, and lands at, and its arc's rise A (px). From: a bowman's
// bow — an archer's, a garrisoned TC's or Castle's crew's (roofShot; flat: not a TC crew down inside, the 2D's keep
// stands whole) — where the nocked arrow is at the loose (bowRelease, the view's pitch), turned to its mark; else a
// building's arrow leaves the edge of its footprint facing the target (the sim's starts in its middle); a trebuchet's
// stone, its sling where it lets go (trebRelease, turned to the machine's heading). To: a building's wall facing it
// (shotFace), else the aim point. An arrow's arc is fitted to leave at the bow's pitch (rise 4·arc a tile at the
// start, whatever the drop to its mark); a stone's lob is STONE_ARC a tile.
function projEnds(p, V){
  let S = _projEnds.get(p); if (S) return S;
  const e = entitiesById.get(p.attackerId), tb = p.targetBuildingId != null ? entitiesById.get(p.targetBuildingId) : null, stone = isStoneShot(p);
  const aim = (x, y) => tb ? shotFace(x, y, tb) : [p.tx, p.ty];
  let F = [p.startX, p.startY, p.startH || 12], bow = p.attackerSnap && p.attackerSnap.utype === 'archer' ? [p.startX, p.startY, 0] : null;
  if (e && e.type === 'building') F = [Math.max(e.x - 0.5, Math.min(e.x + e.w - 0.5, p.tx)), Math.max(e.y - 0.5, Math.min(e.y + e.h - 0.5, p.ty)), F[2]];
  const R = roofShot(p); if (R && !(V.flat && R.inside)) bow = [R.x, R.y, R.h];
  if (bow) { const [ax, ay] = aim(bow[0], bow[1]), h = Math.atan2(ay - bow[1], ax - bow[0]), r = bowRelease(V.pitch), k = UNIT_SCALE / (HALF_TW * Math.SQRT2);
    F = [bow[0] + (Math.cos(h) * r[0] - Math.sin(h) * r[2]) * k, bow[1] + (Math.sin(h) * r[0] + Math.cos(h) * r[2]) * k, bow[2] + r[1] * UNIT_SCALE]; }
  if (stone) { const r = trebRelease(), h = e && e.hp > 0 ? V.heading(e) : Math.atan2(p.ty - p.startY, p.tx - p.startX), k = 1.5 * UNIT_SCALE, T = HALF_TW * Math.SQRT2;
    F = [p.startX + Math.cos(h) * r[0] * k / T, p.startY + Math.sin(h) * r[0] * k / T, r[1] * k * V.hk]; }
  const T = [...aim(F[0], F[1]), tb ? 14 : PROJ_HIT_H], run = Math.hypot(T[0] - F[0], T[1] - F[1]);
  const A = stone ? STONE_ARC * run : Math.max(0, V.arc * run - (T[2] - F[2]) / 4);
  _projEnds.set(p, S = [F, T, A]); return S;
}
// How far along (0 → 1): the sim's spot, carried on `ahead` tiles (what it has flown since that step)
function projProg(p, ahead){ const D = p.totalDist; return D > 0.1 ? Math.max(0, Math.min(1, 1 - Math.max(0, Math.hypot(p.tx - p.x, p.ty - p.y) - ahead) / D)) : 1; }
// The shot at prog: x, y (map), h (px over the ground); its tangent — the whole ground run (gx, gy, tiles) against the
// climb (dh, px per unit of prog)
function projAt(p, prog, V, o){
  const [F, T, A] = projEnds(p, V);
  o.prog = prog; o.gx = T[0] - F[0]; o.gy = T[1] - F[1]; o.x = F[0] + o.gx * prog; o.y = F[1] + o.gy * prog;
  o.h = F[2] + (T[2] - F[2]) * prog + 4 * A * prog * (1 - prog); o.dh = T[2] - F[2] + 4 * A * (1 - 2 * prog);
  return o;
}
// Its shadow's spot on the ground: thrown along the light by its height, as a building's (SHADOW_CAST) — a high stone's
// lies well off, and sweeps in to meet it as it falls
function projShadowAt(o){ const k = o.h / ART_HPX; return [o.x + SHADOW_CAST[0] * k, o.y + SHADOW_CAST[1] * k]; }
// the 2D's shots this frame: the share of the next step already elapsed, carried on as the units are (render.js)
const projAhead2D = () => typeof accumulator === 'undefined' ? 0 : Math.max(0, Math.min(1, accumulator / timeStep)) * PROJECTILE_TILES_PER_TICK;
const projVisible = p => { const x = Math.round(p.x), y = Math.round(p.y);
  // (NaN guard, as drawParticles: a degenerate coord would make fog[NaN][NaN] throw and kill the frame)
  return Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y < MAP && x >= 0 && x < MAP && fog[y][x] === 2; };
const _po = {}, _pq = {};

// A stone landing in sight shakes the view a moment: the 2D's drawing (render.js, viewShakeOffset), the 3D's camera
// (pov3d's shakeFrom: by distance) — mag: px in the 2D
let viewShake = 0, viewShakeAt = 0;
window.shakeView = (x, y, mag) => {
  if (window.world3D) { if (window.__povShake) window.__povShake(x, y, mag); return; }
  const s = mapToScreen(x, y); if (isOffscreen(s.sx, s.sy + HALF_TH, 0)) return;
  const now = performance.now(); viewShake = Math.max(viewShake * Math.exp(-(now - viewShakeAt) / 90), mag); viewShakeAt = now;
};
function viewShakeOffset(){
  const age = performance.now() - viewShakeAt, k = viewShake * Math.exp(-age / 90);
  return k < 0.2 ? null : [Math.sin(age * 0.07) * k, Math.sin(age * 0.093 + 1) * k * 0.7];
}

// The shots' shadows, on the ground under all that stands on it (render.js, after drawGround): an arrow's a thin
// dash along its flight, a stone's an oval; the higher, the fainter.
function drawProjectileShadows(){
  if (!projectiles.length) return;
  const ahead = projAhead2D(), o = _po;
  X.save(); X.fillStyle = X.strokeStyle = SHADOW_FILL; X.lineCap = 'round';
  for (const p of projectiles) {
    if (!projVisible(p)) continue;
    projAt(p, projProg(p, ahead), PROJ_2D, o);
    const g = projShadowAt(o), s = mapToScreen(g[0], g[1]), sx = s.sx, sy = s.sy + HALF_TH;
    if (isOffscreen(sx, sy, 20)) continue;
    X.globalAlpha = Math.max(0.5, 1 - o.h / 400);
    if (isStoneShot(p)) { X.beginPath(); X.ellipse(sx, sy, 8, 4, 0, 0, Math.PI * 2); X.fill(); continue; }
    const iso = toIso(o.gx, o.gy), il = Math.hypot(iso.ix, iso.iy) || 1, ux = iso.ix / il * 6, uy = iso.iy / il * 6;
    X.lineWidth = 2; X.beginPath(); X.moveTo(sx - ux, sy - uy); X.lineTo(sx + ux, sy + uy); X.stroke();
  }
  X.restore();
}

function drawProjectiles() {
  X.save();
  const ahead = projAhead2D(), o = _po, q = _pq, scr = o2 => { const s = mapToScreen(o2.x, o2.y); return [s.sx, s.sy + HALF_TH - o2.h]; };
  projectiles.forEach(p => {
    if (!projVisible(p)) return;
    const prog = projProg(p, ahead); projAt(p, prog, PROJ_2D, o);
    const [sx, sy] = scr(o);
    if (isOffscreen(sx, sy, 40)) return;
    // Its screen tangent: the ground run (iso) against the climb — it points along its true path, launch to impact
    const isoG = toIso(o.gx, o.gy), screenAngle = Math.atan2(isoG.iy - o.dh, isoG.ix), ca = Math.cos(screenAngle), sa = Math.sin(screenAngle), px2 = -sa, py2 = ca;
    // the air it parts: a short trail back along the arc it came by, fading (a stone's wider, dustier); an arrow's from
    // its nock, the 14px shaft back along the path in prog (by the tangent's screen length a unit)
    const stone = isStoneShot(p), D = Math.max(0.5, p.totalDist), step = (stone ? 0.32 : 0.28) / D, n = stone ? 6 : 4, tail = stone ? 0 : ARROW_LEN_2D / Math.max(1, Math.hypot(isoG.ix, isoG.iy - o.dh));
    let prev = [sx - ca * (stone ? 0 : ARROW_LEN_2D), sy - sa * (stone ? 0 : ARROW_LEN_2D)];
    X.lineCap = 'round';
    for (let i = 1; i <= n; i++) { const pr = prog - tail - i * step; if (pr <= 0) break;
      projAt(p, pr, PROJ_2D, q); const pt = scr(q), f = 1 - i / (n + 1);
      X.strokeStyle = stone ? 'rgba(222,212,190,' + (0.5 * f) + ')' : 'rgba(255,255,255,' + (0.4 * f) + ')'; X.lineWidth = (stone ? 4.5 : 1.8) * f + 0.4;
      X.beginPath(); X.moveTo(prev[0], prev[1]); X.lineTo(pt[0], pt[1]); X.stroke(); prev = pt; }
    if (stone) { drawStoneShot(p, sx, sy, prog); return; }

    const L = ARROW_LEN_2D;
    // Thick shaft
    X.strokeStyle = '#000'; X.lineWidth = 3.2;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.strokeStyle = ARROW_SHAFT; X.lineWidth = 1.4;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.lineCap='butt';
    // Big steel head
    X.fillStyle = '#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1;
    X.beginPath();
    X.moveTo(sx + ca*3.4, sy + sa*3.4);
    X.lineTo(sx - ca*1.5 + px2*2.3, sy - sa*1.5 + py2*2.3);
    X.lineTo(sx - ca*1.5 - px2*2.3, sy - sa*1.5 - py2*2.3);
    X.closePath(); X.fill(); X.stroke();
    // Fletching is LITERAL: bare shafts until the shooter's team has the
    // tech, TEAM-COLOR feather vanes after (archer arrows only; tower/TC
    // bolts always fly bare). attackerSnap rides every projectile,
    // render-only read.
    if (p.attackerSnap && p.attackerSnap.utype === 'archer' &&
        hasUpgrade(p.attackerSnap.team, 'fletching')) {
      let tx2 = sx - ca*L, ty2 = sy - sa*L;
      X.fillStyle = teamColorLight(p.attackerSnap.team);
      X.strokeStyle = '#000'; X.lineWidth = 1; X.lineJoin = 'round';
      for (const sgn of [-1, 1]) {
        X.beginPath();
        X.moveTo(tx2 + ca*5.2 + px2*sgn*0.6, ty2 + sa*5.2 + py2*sgn*0.6); // front, hugging the shaft
        X.lineTo(tx2 + ca*1.4 + px2*sgn*3.1, ty2 + sa*1.4 + py2*sgn*3.1); // swept outer edge
        X.lineTo(tx2 - ca*2.6 + px2*sgn*3.1, ty2 - sa*2.6 + py2*sgn*3.1); // feather back edge
        X.lineTo(tx2 - ca*0.8 + px2*sgn*0.6, ty2 - sa*0.8 + py2*sgn*0.6); // notch into the nock
        X.closePath(); X.fill(); X.stroke();
      }
    }
  });
  X.restore();
}
// A trebuchet's stone in flight: the sling's stone (its size, its grey), a lumpy rock of 7 corners (seeded by its shot)
// tumbling end over end as it goes (a turn every ~2.5 tiles, rolling the way it flies), lit from the upper left, cracked
function stoneCorners(id){ const out = []; for (let i = 0; i < 7; i++) { const a = (i + 0.5 * ((id * 7 + i * 13) % 5) / 5) / 7 * Math.PI * 2; out.push([Math.cos(a), Math.sin(a), 0.78 + 0.3 * (((id * 31 + i * 17) % 11) / 10)]); } return out; }
function drawStoneShot(p, sx, sy, prog){
  const C = stoneCorners(p.id), r = TREB_STONE * 1.5 * UNIT_SCALE, spin = prog * p.totalDist * 2.5 * (toIso(p.tx - p.startX, p.ty - p.startY).ix >= 0 ? 1 : -1);
  const pts = C.map(([cx, cy, k]) => { const c = Math.cos(spin), s = Math.sin(spin); return [sx + (cx * c - cy * s) * r * k, sy + (cx * s + cy * c) * r * k * 0.92]; });
  const path = () => { X.beginPath(); X.moveTo(...pts[0]); for (const q of pts.slice(1)) X.lineTo(...q); X.closePath(); };
  X.lineJoin = 'round'; path(); X.fillStyle = '#8f8a80'; X.fill(); X.strokeStyle = '#000'; X.lineWidth = 1.3; X.stroke();
  X.save(); path(); X.clip();
  X.fillStyle = '#aaa59a'; X.beginPath(); X.arc(sx - r * 0.45, sy - r * 0.45, r * 0.85, 0, Math.PI * 2); X.fill();       // its lit side
  X.fillStyle = '#76716a'; X.beginPath(); X.arc(sx + r * 0.75, sy + r * 0.7, r * 0.75, 0, Math.PI * 2); X.fill();        // its shaded underside
  const a = spin + 0.6; X.strokeStyle = 'rgba(40,36,30,0.55)'; X.lineWidth = 0.8;
  X.beginPath(); X.moveTo(sx - Math.cos(a) * r, sy - Math.sin(a) * r); X.lineTo(sx + Math.cos(a + 0.5) * r * 0.2, sy + Math.sin(a + 0.5) * r * 0.2); X.lineTo(sx + Math.cos(a) * r * 0.9, sy + Math.sin(a) * r * 0.9); X.stroke();
  X.restore(); path(); X.strokeStyle = '#000'; X.lineWidth = 1.3; X.stroke();
}

