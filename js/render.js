// Frame-scratch structures, reused every frame instead of reallocated:
// the drawable list, the visible-tree list, per-tile tree records and the
// two per-gate draw proxies (see their use sites in render()).
const _treesScratch = [];
const _drawableScratch = [];
const _treePool = new Map();      // tile key (y*MAP+x) -> tree record
const _gateProxyPool = new Map(); // gate entity id -> {back, front} proxies
const _marketProxyPool = new Map(); // market entity id -> per-part proxies (walkable plaza)
const _farmProxyPool = new Map();   // farm entity id -> flat ground-layer proxy (bed + crops)
let _poolMapSize = -1;

// ---- Flag/post visuals: ONE vocabulary shared by rally points, guard
// posts and the placement ghost (a rally IS the building's guard flag).
// Module scope, not per-frame closures — same reuse discipline as the
// scratch pools above. All inputs are globals (X, camX/camY, W/H, topH). ----
const _drawnFlagsScratch = new Set(); // per-frame flag-cluster dedup
function flagScreen(wx, wy){
  let p = toIso(wx, wy);
  return { x: p.ix - camX + W/2, y: p.iy - camY + H/2 + topH };
}
function drawFlagLine(x1, y1, x2, y2, alpha){
  X.strokeStyle = '#ffd700';
  X.globalAlpha = alpha;
  X.lineWidth = 1.5;
  X.setLineDash([4, 4]);
  X.beginPath(); X.moveTo(x1, y1); X.lineTo(x2, y2); X.stroke();
  X.setLineDash([]);
  X.globalAlpha = 1;
}
function drawFlagMarker(x, y, tall){
  let h = tall ? 16 : 12, w = tall ? 10 : 8;
  X.globalAlpha = tall ? 0.9 : 1;
  X.fillStyle = '#ffd700';
  X.fillRect(x - 1, y - h, 2, h); // pole
  X.beginPath();
  X.moveTo(x + 1, y - h);
  X.lineTo(x + w, y - h + (tall ? 4 : 3));
  X.lineTo(x + 1, y - h + (tall ? 8 : 6));
  X.closePath();
  X.fill();
  X.globalAlpha = 1;
}
// Dashed outline of a building's footprint diamond on the ground — the
// "post" marker for a unit guarding a BUILDING, so the whole structure
// reads as the assignment instead of a flag at one perimeter tile.
function drawBuildingFootprintOutline(b, alpha){
  let bd = BLDGS[b.btype];
  let w = b.w || bd.w, h = b.h || bd.h;
  let c = [flagScreen(b.x, b.y), flagScreen(b.x + w, b.y),
           flagScreen(b.x + w, b.y + h), flagScreen(b.x, b.y + h)];
  X.strokeStyle = '#ffd700';
  X.globalAlpha = alpha;
  X.lineWidth = 1.5;
  X.setLineDash([4, 4]);
  X.beginPath();
  X.moveTo(c[0].x, c[0].y);
  for (let i = 1; i < 4; i++) X.lineTo(c[i].x, c[i].y);
  X.closePath();
  X.stroke();
  X.setLineDash([]);
  X.globalAlpha = 1;
}
// Ground-plane center of a building's footprint, in screen space.
function buildingCenterScreen(b){
  let bd = BLDGS[b.btype];
  return flagScreen(b.x + (b.w || bd.w) / 2, b.y + (b.h || bd.h) / 2);
}

function render(){
  // Tree-pool keys encode MAP — a different map size would silently alias
  // old records onto wrong tiles, so reset the pools on any size change.
  if (MAP !== _poolMapSize) { _treePool.clear(); _gateProxyPool.clear(); _marketProxyPool.clear(); _farmProxyPool.clear(); _poolMapSize = MAP; }
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
    } else if (en.type === 'building' && en.btype === 'MARKET' && en.complete) {
      // Walkable plaza: one proxy per part so units sort BETWEEN the stalls.
      // Ground sits under everything on the footprint (FARM-style +0.05);
      // each prop sorts at its own tile (MARKET_PART_ANCHORS) with the gate
      // front's +0.3 tiebreak, so a prop draws over a unit sharing its tile.
      // A construction site takes the plain single-drawable path below.
      let prox = _marketProxyPool.get(en.id);
      if(!prox){
        prox = { ground: {type:'market_part', part:'ground', entity:en, x:0, y:0, sortVal:0} };
        for (let p in MARKET_PART_ANCHORS)
          prox[p] = {type:'market_part', part:p, entity:en, x:0, y:0, sortVal:0};
        _marketProxyPool.set(en.id, prox);
      }
      prox.ground.entity = en;
      prox.ground.x = en.x; prox.ground.y = en.y;
      prox.ground.sortVal = en.y + en.x + 0.05 - 1000; // flat plaza: same ground layer as farms
      allDrawable.push(prox.ground);
      for (let p in MARKET_PART_ANCHORS) {
        let [ax, ay] = MARKET_PART_ANCHORS[p];
        prox[p].entity = en;
        prox[p].x = en.x + ax; prox[p].y = en.y + ay;
        prox[p].sortVal = en.y + ay + en.x + ax + 0.3;
        allDrawable.push(prox[p]);
      }
    } else if (en.type === 'building' && en.btype === 'FARM') {
      // AoE2-style: the farm is FLAT — bed, furrows and wheat all live in
      // one ground-layer drawable far below the depth contest, so units
      // (and everything else) always draw over the field. The wheat is
      // short enough that no per-sheaf depth sorting is worth its
      // complexity; a whole rabbit hole of proxy schemes fell to the fact
      // that unit sprites are drawn well below their sort anchor anyway.
      let prox = _farmProxyPool.get(en.id);
      if(!prox){
        prox = { ground: {type:'farm_part', part:'ground', entity:en, x:0, y:0, sortVal:0} };
        _farmProxyPool.set(en.id, prox);
      }
      prox.ground.entity = en;
      prox.ground.x = en.x; prox.ground.y = en.y;
      prox.ground.sortVal = en.y + en.x + 0.05 - 1000;
      allDrawable.push(prox.ground);
    } else {
      let sortVal;
      if (en.type === 'building') {
        sortVal = en.y + (en.h || 1) / 2 + en.x + (en.w || 1) / 2;
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
      // Corpses are flat ground decals — draw them BENEATH all living units,
      // buildings and trees (a big -1000 offset, same ground band as farm/market
      // ground) so a corpse on a front tile can never occlude a standing soldier
      // behind it. Still ordered among themselves by y+x. Fixes the "dead bodies
      // hide my current troops" clutter in a big melee.
      c.sortVal = c.y + c.x - 1000;
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
    } else if (e.type === 'gate_back' || e.type === 'gate_front' || e.type === 'market_part' || e.type === 'farm_part') {
      f = buildingFogLevel(e.entity);
    } else {
      f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    }
    if (f === 0) return; // completely unexplored
    // A corpse currently in view is WITNESSED — remember it so it keeps
    // decaying on the map after we leave (AoE2), like buildings via
    // scoutedByMe. Cosmetic/local (fog is per-viewer); corpses are excluded
    // from the sim checksum, so this never affects lockstep.
    if (e.type === 'corpse' && f === 2) e.seen = true;
    // Resolve the actual entity and team for gate proxy objects
    let realEntity = (e.type === 'gate_back' || e.type === 'gate_front' || e.type === 'market_part' || e.type === 'farm_part') ? e.entity : e;
    let eTeam = realEntity ? realEntity.team : e.team;
    // scoutedByMe (js/core.js) is maintained by markScoutedBuildings() on
    // both host (js/loop.js) and guest (js/net-sync.js) — render only READS
    // it; it must not write to saved state.
    if (f === 1 && eTeam !== myTeam) {
      // explored but not visible: live enemy units are never shown, and
      // buildings only if previously scouted. A corpse shows if we WITNESSED it
      // (seen) so it finishes decaying on the map after we leave — but one that
      // died entirely in the fog stays hidden (no fog-death info leak).
      if (e.type === 'unit') return;
      if (e.type === 'corpse' && !e.seen) return;
      if (realEntity && realEntity.type === 'building' && !scoutedByMe.has(realEntity.id)) return;
    }

    if(e.type==='building') drawBuilding(e);
    else if(e.type==='gate_back') drawBuilding(e.entity, 'back');
    else if(e.type==='gate_front') drawBuilding(e.entity, 'front');
    else if(e.type==='market_part') drawBuilding(e.entity, e.part);
    else if(e.type==='farm_part') drawBuilding(e.entity, e.part);
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

  // Just-clicked flag PREVIEWS (issuer-side, cosmetic): rally/guard
  // commands execute INPUT_DELAY_TICKS after the click, and the planted
  // flag would render at the STALE spot for those frames — a flicker-and-
  // jump on every flag drop. While a preview is fresh, draw the flag at
  // the clicked spot instead; expire once the exec tick has safely passed.
  const PREVIEW_TICKS = (typeof INPUT_DELAY_TICKS === 'number' ? INPUT_DELAY_TICKS : 4) + 2;
  let rallyPrev = window.pendingRallyPreview;
  if (rallyPrev && tick - rallyPrev.at > PREVIEW_TICKS) { rallyPrev = window.pendingRallyPreview = null; }
  let guardPrev = window.pendingGuardPreview;
  if (guardPrev && tick - guardPrev.at > PREVIEW_TICKS) { guardPrev = window.pendingGuardPreview = null; }

  // Selected building's rally point (AoE2-style). Hidden while RE-placing
  // it (settingRally) — the old flag deactivates and only the cursor ghost
  // shows, so there's never two flags on screen fighting for attention.
  if (!window.settingRally && selected.length > 0 && selected[0].type === 'building' && selected[0].team === myTeam) {
    let bldg = selected[0];
    let bData = BLDGS[bldg.btype];
    if (bData && bData.builds && bData.builds.length > 0 && bldg.rallyX !== undefined && bldg.rallyY !== undefined) {
      let rx = bldg.rallyX, ry = bldg.rallyY;
      if (rallyPrev && rallyPrev.bldgId === bldg.id) { rx = rallyPrev.x; ry = rallyPrev.y; }
      let from = flagScreen(bldg.x + (bData.w || 1)/2, bldg.y + (bData.h || 1)/2);
      let to = flagScreen(rx + 0.5, ry + 0.5);
      drawFlagLine(from.x, from.y, to.x, to.y, 1);
      drawFlagMarker(to.x, to.y, false);
    }
  }

  // Selected units' GUARD posts — EXPLICIT flags only (guardFlagged):
  // implicit posts from plain moves and rally spawns behave the same but
  // stay invisible; a move order must not look like it planted a flag.
  // One faint line per guarding unit; flags dedupe into 2-tile clusters so
  // a formation reads as a shared post instead of a picket fence. Hidden
  // while RE-placing (settingGuard): old flags deactivate, only the cursor
  // ghost shows — same rule as the rally flag.
  if (!window.settingGuard && selected.length > 0 && selected[0].type === 'unit') {
    let drawnFlags = _drawnFlagsScratch;
    drawnFlags.clear();
    selected.forEach(u => {
      if (u.type !== 'unit' || u.team !== myTeam) return;
      // Fresh guard preview: this unit's post was JUST re-flagged but the
      // command hasn't executed yet — draw its line to the clicked spot
      // instead of the stale (or absent) post.
      if (guardPrev && guardPrev.ids.has(u.id)) {
        let from = flagScreen(u.x, u.y);
        let to = flagScreen(guardPrev.x + 0.5, guardPrev.y + 0.5);
        drawFlagLine(from.x, from.y, to.x, to.y, 0.55);
        let key = 'prev';
        if (!drawnFlags.has(key)) { drawnFlags.add(key); drawFlagMarker(to.x, to.y, false); }
        return;
      }
      if (u.guardX == null || !u.guardFlagged) return;
      let from = flagScreen(u.x, u.y);
      // Guarding a BUILDING: outline the whole footprint and draw the line to
      // its center, instead of a flag at the single perimeter post tile — the
      // post IS the building (see the footprint leash in js/logic.js). Ground
      // posts and escorts (guardTargetId is a unit, or none) keep the flag.
      let gb = u.guardTargetId != null ? entitiesById.get(u.guardTargetId) : null;
      if (gb && gb.type === 'building') {
        let key = 'b' + gb.id;
        if (!drawnFlags.has(key)) drawBuildingFootprintOutline(gb, 0.7); // once per building
        drawnFlags.add(key);
        let to = buildingCenterScreen(gb);
        drawFlagLine(from.x, from.y, to.x, to.y, 0.55);
        return;
      }
      if (gb && gb.type === 'unit') {
        // ESCORT: track the guarded unit's LIVE position (same source as its
        // sprite) so the flag follows it smoothly. Reading guardX/guardY here
        // instead lagged it — that field only re-syncs on sim ticks (and is
        // the unit's raw x/y, so the +0.5 tile-centering below would offset
        // the flag off the unit) — which read as the flag "skipping".
        let to = flagScreen(gb.x, gb.y);
        drawFlagLine(from.x, from.y, to.x, to.y, 0.55);
        let key = 'u' + gb.id;
        if (!drawnFlags.has(key)) { drawnFlags.add(key); drawFlagMarker(to.x, to.y, false); }
        return;
      }
      let to = flagScreen(u.guardX + 0.5, u.guardY + 0.5);
      drawFlagLine(from.x, from.y, to.x, to.y, 0.55);
      let key = Math.round(u.guardX / 2) + '_' + Math.round(u.guardY / 2);
      if (!drawnFlags.has(key)) {
        drawnFlags.add(key);
        drawFlagMarker(to.x, to.y, false);
      }
    });
  }

  // Flag placement GHOST — armed by EITHER the Guard button (units) or the
  // Set Rally button (building): a taller flag rides the cursor with faint
  // preview lines from whatever will take the flag — click/tap drops it.
  // Hover-capable pointers only: on touch there is no hover, so mouseX is
  // whatever the LAST canvas tap was and the ghost rendered as a phantom
  // flag planted at a stale spot.
  if (window.__hoverCapable === undefined) {
    window.__hoverCapable = !!(window.matchMedia && matchMedia('(hover: hover)').matches);
  }
  if (window.__hoverCapable && (window.settingGuard || window.settingRally) && selected.length > 0 && typeof mouseX === 'number') {
    let mt = screenToTile(mouseX, mouseY);
    if (mt) {
      let g = flagScreen(mt.x + 0.5, mt.y + 0.5);
      if (window.settingGuard) {
        selected.forEach(u => {
          if (u.type !== 'unit' || u.team !== myTeam) return;
          let from = flagScreen(u.x, u.y);
          drawFlagLine(from.x, from.y, g.x, g.y, 0.45);
        });
      } else {
        let bldg = selected[0];
        let bData = bldg && BLDGS[bldg.btype];
        if (bldg && bldg.type === 'building' && bldg.team === myTeam && bData) {
          let from = flagScreen(bldg.x + (bData.w || 1)/2, bldg.y + (bData.h || 1)/2);
          drawFlagLine(from.x, from.y, g.x, g.y, 0.45);
        }
      }
      drawFlagMarker(g.x, g.y, true);
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
