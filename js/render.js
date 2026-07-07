// Frame-scratch structures, reused every frame instead of reallocated:
// the drawable list, the visible-tree list, per-tile tree records and the
// two per-gate draw proxies (see their use sites in render()).
const _treesScratch = [];
const _drawableScratch = [];
const _treePool = new Map();      // tile key (y*MAP+x) -> tree record
const _gateProxyPool = new Map(); // gate entity id -> {back, front} proxies
let _poolMapSize = -1;

function render(){
  // Tree-pool keys encode MAP — a different map size would silently alias
  // old records onto wrong tiles, so reset the pools on any size change.
  if (MAP !== _poolMapSize) { _treePool.clear(); _gateProxyPool.clear(); _poolMapSize = MAP; }
  // Black background so unexplored fog (drawTile() skips drawing when
  // fog===0) and the area beyond the map edge both read as true black,
  // matching AoE2 rather than showing a dark-green "explored" tint.
  X.fillStyle='#000000';X.fillRect(0,0,W,window.innerHeight);

  // A guest arriving via a multiplayer join link skips the normal local
  // init()/genMap() entirely (it's about to receive the host's world over
  // the network instead — see enterGuestJoinMode in init.js), so `map` is
  // briefly empty while the connection is still being established. Every
  // tile-drawing loop below indexes map[y][x] assuming a fully populated
  // MAP x MAP grid, so bail out before that rather than crash.
  if (map.length === 0) return;

  // Viewport culling: calculate visible map tile range
  let p1 = screenToMap(0, 0);
  let p2 = screenToMap(W, 0);
  let p3 = screenToMap(0, window.innerHeight);
  let p4 = screenToMap(W, window.innerHeight);
  
  let minX = Math.max(0, Math.floor(Math.min(p1.x, p2.x, p3.x, p4.x)) - 2);
  let maxX = Math.min(MAP - 1, Math.ceil(Math.max(p1.x, p2.x, p3.x, p4.x)) + 2);
  let minY = Math.max(0, Math.floor(Math.min(p1.y, p2.y, p3.y, p4.y)) - 2);
  let maxY = Math.min(MAP - 1, Math.ceil(Math.max(p1.y, p2.y, p3.y, p4.y)) + 2);
  
  X.save();
  // Center zoom scale around viewport camera center
  X.translate(Math.round(W/2), Math.round(H/2 + topH));
  X.scale(ZOOM, ZOOM);
  X.translate(-Math.round(W/2), -Math.round(H/2 + topH));

  // Draw ground tiles (only visible ones)
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)drawTile(x,y);

  // Filter out expired corpses using wall-clock time so they still fade after game over
  corpses = corpses.filter(c => performance.now() - c.deathTime < CORPSE_LIFE);
  
  // Find visible trees with wood resource remaining to depth-sort them
  // dynamically. The per-tile tree records are pooled (keyed by tile) and
  // both work arrays are reused across frames — building fresh objects/
  // arrays for every visible tree every frame was steady GC churn.
  let trees = _treesScratch; trees.length = 0;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    if(map[y][x].t===TERRAIN.FOREST && map[y][x].res>0){
      let key = y*MAP + x;
      let rec = _treePool.get(key);
      if(!rec){ rec = {type:'tree', x:x, y:y, sortVal:0}; _treePool.set(key, rec); }
      trees.push(rec);
    }
  }

  let allDrawable = _drawableScratch; allDrawable.length = 0;
  entities.forEach(en => {
    // Only draw visible entities (either player's team or visible in fog)
    let f;
    if (en.type === 'building') {
      f = buildingFogLevel(en);
    } else {
      let ex = Math.round(en.x), ey = Math.round(en.y);
      f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    }
    if (f === 0) return; // unexplored

    // Check if the entity is within visible range (culling)
    let enX = en.x, enY = en.y;
    if (en.type === 'building') {
      enX += (en.w || 1) / 2;
      enY += (en.h || 1) / 2;
    }
    if (enX < minX - 4 || enX > maxX + 4 || enY < minY - 4 || enY > maxY + 4) return;

    if (en.type === 'building' && isGateBtype(en.btype)) {
      let wallLineNS = en.h > en.w;
      // Pooled per gate id — same two proxy objects reused every frame.
      let prox = _gateProxyPool.get(en.id);
      if(!prox){
        prox = { back: {type:'gate_back', entity:en, x:0, y:0, sortVal:0},
                 front:{type:'gate_front', entity:en, x:0, y:0, sortVal:0} };
        _gateProxyPool.set(en.id, prox);
      }
      prox.back.entity = en; prox.front.entity = en;
      prox.back.x = en.x; prox.back.y = en.y;
      prox.back.sortVal = en.y + en.x + 0.1;
      prox.front.x = wallLineNS ? en.x : en.x + 1;
      prox.front.y = wallLineNS ? en.y + 1 : en.y;
      // +0.3 beats a unit's +0.25 tiebreak on the SAME tile: a unit passing
      // through the archway stands on the front tile, and the near post
      // must draw over it (it's closer to the viewer). Units a full tile
      // nearer still sort higher and correctly draw over the gate.
      prox.front.sortVal = (wallLineNS ? en.y + 1 : en.y) + (wallLineNS ? en.x : en.x + 1) + 0.3;
      allDrawable.push(prox.back);
      allDrawable.push(prox.front);
    } else {
      let sortVal;
      if (en.type === 'building') {
        if (en.btype === 'FARM') sortVal = en.y + en.x + 0.05;
        else sortVal = en.y + (en.h || 1) / 2 + en.x + (en.w || 1) / 2;
      } else {
        if (en.utype === 'sheep_carcass') sortVal = en.y + en.x + 0.05;
        else sortVal = en.y + en.x + 0.25;
      }
      en.sortVal = sortVal;
      allDrawable.push(en);
    }
  });

  corpses.forEach(c => {
    if (c.x >= minX - 2 && c.x <= maxX + 2 && c.y >= minY - 2 && c.y <= maxY + 2) {
      c.sortVal = c.y + c.x;
      allDrawable.push(c);
    }
  });

  trees.forEach(t => {
    t.sortVal = t.y + t.x + 0.1;
    allDrawable.push(t);
  });

  allDrawable.sort((a, b) => a.sortVal - b.sortVal);

  // Building ground shadows, all in ONE union fill before any entity
  // paints: overlapping diamonds (adjacent wall segments, gate+wall runs)
  // darken once instead of stacking, and a later building's shadow can
  // never fall on top of an earlier building's base.
  X.fillStyle = 'rgba(0,0,0,0.16)';
  X.beginPath();
  allDrawable.forEach(e => {
    if (e.type !== 'building' && e.type !== 'gate_back') return;
    let be = e.type === 'gate_back' ? e.entity : e;
    let f = buildingFogLevel(be);
    if (f === 0) return;
    if (f === 1 && be.team !== myTeam && !scoutedByMe.has(be.id)) return;
    buildingShadowPath(be);
  });
  X.fill();

  allDrawable.forEach(e=>{
    // Fog of War checks for entities
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f;
    if (e.type === 'building') {
      f = buildingFogLevel(e);
    } else if (e.type === 'gate_back' || e.type === 'gate_front') {
      f = buildingFogLevel(e.entity);
    } else {
      f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    }
    if (f === 0) return; // completely unexplored
    // Resolve the actual entity and team for gate proxy objects
    let realEntity = (e.type === 'gate_back' || e.type === 'gate_front') ? e.entity : e;
    let eTeam = realEntity ? realEntity.team : e.team;
    // scoutedByMe (js/core.js) is maintained by markScoutedBuildings() on
    // both host (js/loop.js) and guest (js/net-sync.js) — render only READS
    // it; it must not write to saved state.
    if (f === 1 && eTeam !== myTeam) {
      // explored but not visible: hide enemy units, corpses, and buildings never seen before
      if (e.type === 'unit' || e.type === 'corpse') return;
      if (realEntity && realEntity.type === 'building' && !scoutedByMe.has(realEntity.id)) return;
    }

    if(e.type==='building') drawBuilding(e);
    else if(e.type==='gate_back') drawBuilding(e.entity, 'back');
    else if(e.type==='gate_front') drawBuilding(e.entity, 'front');
    else if(e.type==='corpse') drawCorpse(e);
    else if(e.type==='tree') drawTreeEntity(e.x, e.y);
    else drawUnit(e);
  });

  // Selection outlines (units + buildings), in their own pass after every
  // entity has painted for the frame — see drawOutlines() for why this
  // must run from inside the same active ZOOM transform as everything else
  // (moving it outside and re-applying ZOOM by hand was the source of a
  // frame-to-frame "glitchy" drift between the ring and the real sprite).
  drawOutlines();

  drawProjectiles(); // Draw archer arrows
  drawParticles();   // Draw fire/dust/blood particles
  drawGhost();

  // Draw selected building's rally point flag & line (AoE2-style)
  if (selected.length > 0 && selected[0].type === 'building' && selected[0].team === myTeam) {
    let bldg = selected[0];
    let bData = BLDGS[bldg.btype];
    if (bData && bData.builds && bData.builds.length > 0 && bldg.rallyX !== undefined && bldg.rallyY !== undefined) {
      let bCenter = toIso(bldg.x + (bData.w || 1)/2, bldg.y + (bData.h || 1)/2);
      let rPos = toIso(bldg.rallyX + 0.5, bldg.rallyY + 0.5);
      
      let sx1 = bCenter.ix - camX + W/2;
      let sy1 = bCenter.iy - camY + H/2 + topH;
      let sx2 = rPos.ix - camX + W/2;
      let sy2 = rPos.iy - camY + H/2 + topH;
      
      // Draw dotted rally line
      X.strokeStyle = '#ffd700';
      X.lineWidth = 1.5;
      X.setLineDash([4, 4]);
      X.beginPath();
      X.moveTo(sx1, sy1);
      X.lineTo(sx2, sy2);
      X.stroke();
      X.setLineDash([]);
      
      // Draw small gold rally flag
      X.fillStyle = '#ffd700';
      X.fillRect(sx2 - 1, sy2 - 12, 2, 12); // pole
      X.beginPath();
      X.moveTo(sx2 + 1, sy2 - 12);
      X.lineTo(sx2 + 8, sy2 - 9);
      X.lineTo(sx2 + 1, sy2 - 6);
      X.closePath();
      X.fill();
    }
  }

  // Draw command markers (AoE2-style right-click feedback)
  cmdMarkers=cmdMarkers.filter(m=>tick-m.time<30);
  cmdMarkers.forEach(m=>{
    let iso=toIso(m.x+0.5,m.y+0.5);
    let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
    let age=(tick-m.time)/30;
    X.globalAlpha=1-age;
    X.strokeStyle=m.color;X.lineWidth=2;
    // Cross marker
    let sz=6+age*8;
    X.beginPath();X.moveTo(sx-sz,sy);X.lineTo(sx+sz,sy);X.stroke();
    X.beginPath();X.moveTo(sx,sy-sz);X.lineTo(sx,sy+sz);X.stroke();
    // Expanding circle
    X.beginPath();X.arc(sx,sy,sz+4,0,Math.PI*2);X.stroke();
    X.globalAlpha=1;
  });

  X.restore();

  drawSelection();


  drawMinimap();
}
