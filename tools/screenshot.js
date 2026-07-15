#!/usr/bin/env node
// ---- Art screenshot harness (Playwright driver) ----
// Loads tools/sim.html (full render stack, canvas#game), builds a flat staged
// world, and captures PNGs of specific art scenes at real game scale — the
// acceptance view for sprite work (zoomed-in shots lie about outline weight).
//
//   node tools/screenshot.js                       # all scenes, zoom 1 + 2
//   node tools/screenshot.js scene=market zoom=2
//   node tools/screenshot.js scene=death out=/tmp/shots
//
// Scenes:
//   market  own Market on open grass, villagers standing on/near the plaza
//   farm    growth ramp left→right: ripe → mid → young → harvested → exhausted
//   carts   trade carts in all 8 facings + one loaded (carrying gold)
//   fog     enemy Market under explored-not-visible fog (darken path) and
//           the own Market selected (outline/mask path)
//   death   trade cart killed; corpse age fudged to 0.3s / 1.5s / 13s
//
// Static server + browser launch mirror tools/simulate.js (kept separate so
// the sim driver stays single-purpose).

const path = require('path');
const fs = require('fs');
const { ROOT, requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

// ---- page-side scene code (serialized into page.evaluate) ----
// Builds a flat grass stage: no trees/resources/starting entities, fog lit.
// All positions are hardcoded around tile (30,30); the camera centers there.
function pageStage() {
  NUM_TEAMS = 2;
  window.__pendingMatchSeed = 7;
  setMapSize('small');
  restartGame('standard');
  gameStarted = true; gamePaused = true; // freeze the sim; we drive render()
  window.playSound = () => {};
  window.showMsg = () => {};
  window.updateUI = () => {};
  entities.length = 0; entitiesById.clear();
  selected.length = 0; corpses.length = 0;
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const t = map[y][x];
    t.occupied = null; t.res = 0; t.t = TERRAIN.GRASS;
    markMapDirty(x, y);
  }
  window.fogDisabled = true; updateFog();
  tick = 40; // fixed animation phase (flags, cargo twinkle) → reproducible PNGs
}

function pageLookAt(x, y) {
  const iso = toIso(x, y);
  camX = iso.ix; camY = iso.iy;
  window.targetCamX = camX; window.targetCamY = camY;
}

// dirs 2/3/4 are authored mirrored (see mirroredDir, js/render-units.js)
function pageCartFacing(e, d) {
  e.dir = d;
  e.facing = (d >= 2 && d <= 4) ? -1 : 1;
  e.facingNorth = (d >= 4 && d <= 6);
}

const SCENES = {
  market: `(${pageStage})();
    const m = createBuilding('MARKET', 28, 28, 0);
    // villagers ON the plaza between the stalls (draw-order check) + around
    [[29.5,29.5],[28.6,30.0],[30.3,29.2],[30.6,30.6],[27.4,31.5],[33.5,30.5]].forEach(([x,y],i)=>{
      const v = createUnit('villager', x, y, 0); v.dir = i % 8; v.female = i % 2 === 0;
    });
    (${pageLookAt})(29.5, 29.5);
    render();`,
  farm: `(${pageStage})();
    // growth ramp left→right: ripe → mid → young → harvested-short →
    // exhausted. Farms are 2x2; three tiles of lane between them. Farm food
    // lives on the ANCHOR tile only (js/entities.js placeBuilding).
    [[22,28,1.0],[25,28,0.65],[28,28,0.35],[31,28,0.12],[34,28,0]].forEach(([x,y,fr])=>{
      const f = createBuilding('FARM', x, y, 0);
      if (fr === 0) { f.exhausted = true; map[y][x].res = 0; }
      else map[y][x].res = Math.round(f.maxFood * fr);
    });
    // depth-sort probe: a villager standing between crop rows
    const v = createUnit('villager', 23, 29.5, 0); v.dir = 0;
    (${pageLookAt})(29, 29);
    render();`,
  carts: `(${pageStage})();
    const F = ${pageCartFacing};
    for (let d = 0; d < 8; d++) {
      const c = createUnit('tradecart', 26 + (d % 4) * 3, 28 + Math.floor(d / 4) * 3, 0);
      F(c, d);
    }
    const loaded = createUnit('tradecart', 29, 34, 0);
    F(loaded, 7); loaded.carrying = 40; loaded.carryType = 'gold';
    (${pageLookAt})(29.5, 30.5);
    render();`,
  ptower: `(${pageStage})();
    // standalone size/material comparison: wooden PTOWER beside stone TOWER
    createBuilding('PTOWER', 25, 26, 0);
    createBuilding('TOWER', 28, 26, 0);
    // palisade run with an embedded PTOWER bastion, meeting a stone run —
    // link stubs must take each neighbor's material on both sides
    for (let x = 24; x <= 33; x++) if (x !== 29) createBuilding(x < 31 ? 'WALL' : 'SWALL', x, 31, 0);
    createBuilding('PTOWER', 29, 31, 0);
    // upgrade in progress: an instant-swapped construction site (btype is
    // already the stone/tower target, complete=false, half-built HP) — the
    // normal foundation render (alpha ramp + cyan HP bar) applies
    const uw = createBuilding('SWALL', 25, 35, 0);
    uw.complete = false; uw.buildProgress = uw.buildTime / 2; uw.hp = uw.maxHp / 2; uw.upgrading = true;
    const ut = createBuilding('TOWER', 29, 35, 0);
    ut.complete = false; ut.buildProgress = ut.buildTime / 2; ut.hp = ut.maxHp / 2; ut.upgrading = true;
    (${pageLookAt})(28.5, 31);
    render();`,
  guardbldg: `(${pageStage})();
    window.myTeam = 0;
    // a 4x4 TC with three militia flagged to guard it, fanned around the
    // footprint — selecting them should outline the whole building + draw a
    // line from each guard to the building center (no per-tile flags)
    const gtc = createBuilding('TC', 28, 28, 0);
    const guards = [createUnit('militia', 26, 27, 0), createUnit('militia', 33, 30, 0), createUnit('militia', 29, 33, 0)];
    guards.forEach(g => {
      const pt = nearestBldgPerimeter(g.x, g.y, gtc, g.id);
      g.order = {kind:'guardBuilding', id: gtc.id, x: pt.x, y: pt.y};
    });
    selected.length = 0; guards.forEach(g => selected.push(g));
    (${pageLookAt})(30, 30);
    render();`,
  escort: `(${pageStage})();
    window.myTeam = 0;
    // a soldier escorting a villager: the guard flag/line must sit ON the
    // villager (live position), not offset by half a tile
    const vil = createUnit('villager', 31, 29, 0);
    const sol = createUnit('militia', 28, 31, 0);
    sol.order = {kind:'escort', id: vil.id};
    selected.length = 0; selected.push(sol);
    (${pageLookAt})(29.5, 30);
    render();`,
  tcdepth: `(${pageStage})();
    window.myTeam = 0;
    // repro of aoe2-game-error.json: scout at (42,42) beside a 4x4 TC at
    // (41,40). Body should be IN FRONT of the near wall block but BEHIND the
    // roof — single-anchor sort can't split it.
    createBuilding('TC', 41, 40, 0);
    const sc = createUnit('scout', 42, 42, 0); sc.dir = 7;
    (${pageLookAt})(43, 42);
    render();`,
  selbehind: `(${pageStage})();
    window.myTeam = 0;
    // a SELECTED unit behind the TC: the white selection ring shows it through
    // the roof, so the behind-building team outline must be SUPPRESSED (no
    // doubled team-color + white ring).
    createBuilding('TC', 41, 40, 0);
    const sb = createUnit('scout', 42, 42, 0); sb.dir = 7;
    selected.length = 0; selected.push(sb);
    (${pageLookAt})(43, 42);
    render();`,
  treeoccl: `(${pageStage})();
    window.myTeam = 0;
    // units behind a stand of trees — team outline shows through the canopy
    // where trees (in front, higher y+x) hide them, clipped to the tree pixels
    // (not below/around on open grass). Both a mounted scout and a militia sit
    // just behind the front trees.
    for(let ty=30;ty<=35;ty++)for(let tx=30;tx<=35;tx++){ if(ty+tx>=63){ map[ty][tx].t=TERRAIN.FOREST; map[ty][tx].res=100; markMapDirty(tx,ty); } }
    const ts = createUnit('scout', 31, 31, 0); ts.dir = 7;
    createUnit('militia', 29, 33, 0);
    window.fogDisabled = true; updateFog();
    (${pageLookAt})(32, 33);
    render();`,
  tctents: `(${pageStage})();
    window.myTeam = 0;
    // units sheltering under both tent canopies + the notch: the whole tent
    // roof must read as ABOVE them (posts behind, canopy in front), and a
    // unit clearly OUT in front (beyond the eaves) must still draw over.
    createBuilding('TC', 28, 28, 0);
    createUnit('scout', 29.5, 29.5, 0);   // notch / centre
    createUnit('militia', 30.4, 29.2, 0); // under RIGHT tent
    createUnit('militia', 29.2, 30.4, 0); // under LEFT tent
    createUnit('militia', 31.5, 31.5, 0); // clearly out front -> over the roof
    createUnit('militia', 32.2, 30.3, 0); // just past RIGHT eave -> head must NOT clip
    createUnit('militia', 30.3, 32.2, 0); // just past LEFT eave -> head must NOT clip
    (${pageLookAt})(30.5, 31);
    render();`,
  parwalls: `(${pageStage})();
    window.myTeam = 0;
    // two parallel wall runs one tile apart (each orientation): should read as
    // two separate lines, NOT a ladder of cross-links between them.
    for (let x = 22; x <= 28; x++) { createBuilding('WALL', x, 24, 0); createBuilding('WALL', x, 25, 0); }
    for (let y = 28; y <= 33; y++) { createBuilding('WALL', 22, y, 0); createBuilding('WALL', 23, y, 0); }
    // regression: an L-corner + T-branch and a closed 4x4 ring must stay fully joined
    ['L'].forEach(()=>{ for(let x=30;x<=34;x++)createBuilding('WALL',x,24,0); for(let y=25;y<=28;y++)createBuilding('WALL',34,y,0); createBuilding('WALL',32,25,0); createBuilding('WALL',32,26,0); });
    for (let x = 30; x <= 33; x++) { createBuilding('WALL', x, 31, 0); createBuilding('WALL', x, 34, 0); }
    for (let y = 32; y <= 33; y++) { createBuilding('WALL', 30, y, 0); createBuilding('WALL', 33, y, 0); }
    (${pageLookAt})(28, 29);
    render();`,
  nestwalls: `(${pageStage})();
    window.myTeam = 0;
    const ring = (x0,y0,x1,y1) => {
      for (let x=x0;x<=x1;x++){ createBuilding('WALL',x,y0,0); createBuilding('WALL',x,y1,0); }
      for (let y=y0+1;y<y1;y++){ createBuilding('WALL',x0,y,0); createBuilding('WALL',x1,y,0); }
    };
    ring(20,20,30,30);        // outer
    ring(23,23,27,27);        // inner, 2-tile gap -> two clean concentric rings
    ring(34,22,40,28);        // outer of an ADJACENT pair
    ring(35,23,39,27);        // inner, 1-tile gap (parallel sides) -> should read as two rings
    (${pageLookAt})(30, 25);
    render();`,
  gatewalls: `(${pageStage})();
    window.myTeam = 0;
    // gate in a wall run, with a PARALLEL wall one tile away: the gate must
    // not rung across to the parallel line (same fix as plain walls).
    // E–W run row 24 with a 3-wide gate + parallel run row 25.
    createBuilding('WALL',24,24,0); createBuilding('WALL',25,24,0);
    createBuilding('GATE',26,24,0,3,1);
    createBuilding('WALL',29,24,0); createBuilding('WALL',30,24,0);
    for (let x=24;x<=30;x++) createBuilding('WALL',x,25,0);
    // N–S run col 33 with a 3-tall gate + parallel run col 34.
    createBuilding('WALL',33,28,0); createBuilding('WALL',33,29,0);
    createBuilding('GATE',33,30,0,1,3);
    createBuilding('WALL',33,33,0); createBuilding('WALL',33,34,0);
    for (let y=28;y<=34;y++) createBuilding('WALL',34,y,0);
    (${pageLookAt})(29, 29);
    render();`,
  towerwalls: `(${pageStage})();
    window.myTeam = 0;
    // towers in wall runs beside a parallel wall must not rung across either.
    createBuilding('WALL',24,24,0); createBuilding('WALL',25,24,0);
    createBuilding('TOWER',26,24,0);
    createBuilding('WALL',27,24,0); createBuilding('WALL',28,24,0);
    for (let x=24;x<=28;x++) createBuilding('WALL',x,25,0);
    createBuilding('WALL',33,28,0); createBuilding('WALL',33,29,0);
    createBuilding('TOWER',33,30,0);
    createBuilding('WALL',33,31,0); createBuilding('WALL',33,32,0);
    for (let y=28;y<=32;y++) createBuilding('WALL',34,y,0);
    // regression: a tower at an L-corner must keep BOTH its wall links
    createBuilding('TOWER',24,34,0); createBuilding('WALL',25,34,0); createBuilding('WALL',24,35,0);
    (${pageLookAt})(29, 30);
    render();`,
  ghostgate: `(${pageStage})();
    window.myTeam = 0;
    // E–W wall run; the GATE placement cursor hovers one tile NORTH of it (off
    // the wall) — it must NOT draw a connection stub down to the wall.
    for (let x=24;x<=32;x++) createBuilding('WALL',x,26,0);
    (${pageLookAt})(28, 26);
    mouseX = (toIso(28.5,25.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(28.5,25.5).iy - camY)*ZOOM + H/2 + topH;
    placing = 'GATE';
    render();`,
  ghosttower: `(${pageStage})();
    window.myTeam = 0;
    // TOWER placement cursor hovering one tile NORTH of a wall run.
    for (let x=24;x<=32;x++) createBuilding('WALL',x,26,0);
    (${pageLookAt})(28, 26);
    mouseX = (toIso(28.5,25.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(28.5,25.5).iy - camY)*ZOOM + H/2 + topH;
    placing = 'TOWER';
    render();`,
  ghostvalid: `(${pageStage})();
    window.myTeam = 0;
    // VALID gate placement (cursor ON the wall run): should still preview its
    // connection to the flanking walls.
    for (let x=24;x<=32;x++) createBuilding('WALL',x,26,0);
    (${pageLookAt})(28, 26);
    mouseX = (toIso(28.5,26.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(28.5,26.5).iy - camY)*ZOOM + H/2 + topH;
    placing = 'GATE';
    render();`,
  dragghost: `(${pageStage})();
    window.myTeam = 0;
    // ACTUAL placed wood walls (row 28) vs the wall-DRAG ghost (row 25):
    // the ghost must match the placed pillar/link size + material.
    for (let x=24;x<=30;x++) createBuilding('WALL',x,28,0);
    placing = 'WALL';
    window.isDraggingWall = true;
    window.wallDragStart = {x:24,y:25};
    window.wallDragEnd = {x:30,y:25};
    window.wallDragCorner = {x:30,y:25};
    (${pageLookAt})(27, 26.5);
    render();`,
  ghostjoin: `(${pageStage})();
    window.myTeam = 0;
    // LEFT: two PLACED walls (the reference join). RIGHT: one wall + a ghost
    // sliding IN FRONT of it (east). The ghost's join must match the placed
    // reference — before the fix the ghost showed NO connection on that side.
    createBuilding('WALL',26,26,0); createBuilding('WALL',27,26,0);
    createBuilding('WALL',34,26,0);
    (${pageLookAt})(30, 26.5);
    placing = 'WALL';
    mouseX = (toIso(35.5,26.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(35.5,26.5).iy - camY)*ZOOM + H/2 + topH;
    render();`,
  dragunify: `(${pageStage})();
    window.myTeam = 0;
    // existing wall run (row 26) + a collinear wall (23,25) west of the drag.
    for (let x=24;x<=30;x++) createBuilding('WALL',x,26,0);
    createBuilding('WALL',23,25,0);
    // drag ghost along row 25 (parallel to row 26, 1 tile N): must NOT rung
    // down to row 26, and MUST join the existing wall at (23,25).
    placing = 'WALL';
    window.isDraggingWall = true;
    window.wallDragStart = {x:24,y:25};
    window.wallDragEnd = {x:30,y:25};
    window.wallDragCorner = {x:30,y:25};
    (${pageLookAt})(27, 25.5);
    render();`,
  dragelbow: `(${pageStage})();
    window.myTeam = 0;
    // L-shaped drag (E then S) must render a connected corner via the unified path.
    placing = 'WALL';
    window.isDraggingWall = true;
    window.wallDragStart = {x:24,y:25};
    window.wallDragCorner = {x:30,y:25};
    window.wallDragEnd = {x:30,y:31};
    (${pageLookAt})(28, 28);
    render();`,
  towerjoin: `(${pageStage})();
    window.myTeam = 0;
    // PTOWER (dark-age tower, unlocked) ghost IN FRONT of (east of) an existing
    // wall: must join it, same as TOWER does at Feudal.
    createBuilding('WALL',28,26,0);
    (${pageLookAt})(28.5, 26);
    mouseX = (toIso(29.5,26.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(29.5,26.5).iy - camY)*ZOOM + H/2 + topH;
    placing = 'PTOWER';
    render();`,
  gatejoin: `(${pageStage})();
    window.myTeam = 0;
    // gate ghost dropped into a wall run: must join walls on BOTH ends.
    for (let x=24;x<=34;x++) createBuilding('WALL',x,26,0);
    (${pageLookAt})(29, 26);
    mouseX = (toIso(29.5,26.5).ix - camX)*ZOOM + W/2;
    mouseY = (toIso(29.5,26.5).iy - camY)*ZOOM + H/2 + topH;
    placing = 'GATE';
    render();`,
  gatewalk: `(${pageStage})();
    window.myTeam = 0;
    // E–W wall (row 33) with a 3-wide gate; militia walking N->S through the
    // archway at several depths — check post/door sort vs the unit.
    for (let x=24;x<=34;x++) if (x<28||x>30) createBuilding('WALL',x,33,0);
    const g=createBuilding('GATE',28,33,0,3,1); g.gateProgress=1; // OPEN
    [[29,31.4],[29,32.4],[29,33.0],[29,33.6],[29,34.6]].forEach(([x,y],i)=>{
      const u=createUnit('militia',x,y,0); u.dir=1; });
    (${pageLookAt})(29, 33);
    render();`,
  gateclosed: `(${pageStage})();
    window.myTeam = 0;
    // CLOSED gate; an ENEMY (red) and an OWN (blue) unit fully BEHIND it —
    // check the behind-building silhouette renders through the gate posts+door.
    for (let x=24;x<=34;x++) if (x<28||x>30) createBuilding('WALL',x,33,0);
    createBuilding('GATE',28,33,0,3,1); // gateProgress 0 = closed
    createUnit('militia',29.7,32.4,1);  // enemy, behind near (E) post
    createUnit('militia',28.6,32.5,0);  // own, behind W post/door
    createUnit('militia',29.1,32.6,1);  // enemy, behind door centre
    (${pageLookAt})(29, 33);
    render();`,
  idleq: `(${pageStage})();
    window.myTeam = 0;
    // LEFT: a SELECTED idle villager — the gold outline should wrap the "?".
    const v1=createUnit('villager',24,31,0); selected.length=0; selected.push(v1);
    // RIGHT: an idle villager BEHIND the TC keep — the silhouette should
    // include the "?" so you can spot the hidden idle villager.
    createBuilding('TC',28,28,0);
    createUnit('villager',29,29,0);
    (${pageLookAt})(27, 30);
    render();`,
  greenA: `(${pageStage})();
    window.myTeam = 2; // green team's perspective (color index 2)
    [[25,28],[27,30],[29,28],[26,31],[28,32]].forEach(([x,y])=>createUnit('militia',x,y,2));
    createUnit('villager',27,28,2); createUnit('scout',30,30,2);
    (${pageLookAt})(27, 30); render();`,
  greenB: `(${pageStage})();
    window.myTeam = 2;
    PLAYER_TEAM_COLORS[2] = '#35c945'; PLAYER_TEAM_COLORS_DARK[2] = '#1f9433'; // AoE2-style vivid green
    [[25,28],[27,30],[29,28],[26,31],[28,32]].forEach(([x,y])=>createUnit('militia',x,y,2));
    createUnit('villager',27,28,2); createUnit('scout',30,30,2);
    (${pageLookAt})(27, 30); render();`,
  silcolor: `(${pageStage})();
    window.myTeam = 0;
    // blue/red/green units behind the TC keep — silhouettes should be BRIGHT.
    createBuilding('TC',28,28,0);
    createUnit('militia',29.4,28.6,0); // blue
    createUnit('militia',28.6,29.4,1); // red
    createUnit('militia',29.0,29.0,2); // green
    (${pageLookAt})(28.5, 29); render();`,
  frontpunch: `(${pageStage})();
    window.myTeam = 0;
    // foreground punch-out: a unit BEHIND a house (silhouette) and a unit
    // just IN FRONT whose sprite overlaps the silhouette region — the front
    // unit must stay clean (no ghost painted over it).
    createBuilding('HOUSE', 30, 30, 0);
    createUnit('militia', 30, 30, 0);     // dead centre, behind -> silhouette
    createUnit('militia', 31.2, 31.2, 0); // just in front, overlapping
    (${pageLookAt})(31, 31);
    render();`,
  tcstates: `(${pageStage})();
    window.myTeam = 0;
    // regression: selected TC (null-path whole-building gold outline) + a
    // half-built foundation TC (alpha ramp must cover BOTH split parts).
    const sel = createBuilding('TC', 26, 27, 0);
    selected.length = 0; selected.push(sel);
    const found = createBuilding('TC', 33, 27, 0);
    found.complete = false; found.buildProgress = found.buildTime / 2; found.hp = found.maxHp / 2;
    (${pageLookAt})(31, 31);
    render();`,
  occlude: `(${pageStage})();
    window.myTeam = 0;
    // behind-building silhouettes: own + enemy soldiers whose sortVal loses
    // to the TC read as flat team-color silhouettes through its art
    createBuilding('TC', 28, 26, 0);
    createUnit('militia', 29.5, 27.2, 0);
    createUnit('archer', 31.0, 26.6, 1);
    // control: unit IN FRONT of the TC draws normally (no tint)
    createUnit('militia', 31.5, 30.5, 0);
    // gate archway: villager on the front tile is occluded ONLY by the near
    // post — silhouette against it, none against the back post
    for (let x = 24; x <= 34; x++) if (x < 28 || x > 30) createBuilding('WALL', x, 33, 0);
    createBuilding('GATE', 28, 33, 0, 3, 1);
    createUnit('villager', 29.7, 32.3, 0); // sortVal 62.25 < near post's 62.3, overlapping its art at tile (30,33)
    (${pageLookAt})(29.5, 30);
    render();`,
  fog: `(${pageStage})();
    const own = createBuilding('MARKET', 24, 29, 0);
    const foe = createBuilding('MARKET', 34, 29, 1);
    scoutedByMe.add(foe.id); // explored enemy buildings draw only once scouted
    selected.push(own); // outline/mask pass over the full building
    window.fogDisabled = false;
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) fog[y][x] = 2;
    for (let y = 27; y < 35; y++) for (let x = 32; x < 40; x++) fog[y][x] = 1; // enemy market: explored, not visible
    if (typeof invalidateBuildingFogMemo === 'function') invalidateBuildingFogMemo();
    (${pageLookAt})(30.5, 30.5);
    render();`,
  death: `(${pageStage})();
    createBuilding('TC', 6, 6, 0); createBuilding('TC', 50, 50, 1); // keep both teams alive (no defeat overlay)
    const F = ${pageCartFacing};
    const mk = (x, dir, gold) => {
      const c = createUnit('tradecart', x, 30, 0);
      F(c, dir);
      if (gold) { c.carrying = 40; c.carryType = 'gold'; }
      c.hp = 0; handleDeath(c, 1);
    };
    mk(26, 7, false); mk(30, 1, false); mk(34, 6, true);
    // rams on their own row (cave-in wreck sequence)
    [[26,7],[30,1],[34,6]].forEach(([x,d]) => {
      const r = createUnit('ram', x, 27, 0);
      F(r, d); r.hp = 0; handleDeath(r, 1);
    });
    // NOTE: do not clear corpseImpactFxDone here — respawned burst particles
    // never animate while the sim is paused and would freeze over the wreck.
    window.__setCorpseAge = (ms) => {
      corpses.forEach(c => { c.deathTime = performance.now() - ms; });
      if (typeof particles !== 'undefined') particles.length = 0;
      render();
    };
    (${pageLookAt})(30.5, 28.5);
    window.__setCorpseAge(300);`,
};

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(a.out || path.join(ROOT, 'tools', 'shots'));
  fs.mkdirSync(outDir, { recursive: true });
  const zooms = (a.zoom || '1,2').split(',').map(Number);
  const scenes = a.scene && a.scene !== 'all' ? a.scene.split(',') : Object.keys(SCENES);
  for (const s of scenes) if (!SCENES[s]) { console.error(`unknown scene: ${s}`); process.exit(2); }

  let srv, browser;
  try {
    srv = await startServer('/tools/sim.html');
    const base = 'http://127.0.0.1:' + srv.address().port;
    browser = await launchBrowser(chromium, a.headed === '1');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e.message || e)));
    await page.goto(base + '/tools/sim.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.runSimulation === 'function', { timeout: 15000 });

    // sim.html's own <canvas id="game"> plus one the boot code creates —
    // getElementById (what render.js uses) resolves to the first in the DOM.
    const canvas = page.locator('#game').first();
    const shoot = (name) => canvas.screenshot({ path: path.join(outDir, name + '.png') });

    for (const scene of scenes) {
      for (const z of zooms) {
        await page.evaluate(`ZOOM = ${z}; ${SCENES[scene]}`);
        if (scene === 'death') {
          for (const [label, ms] of [['0.3s', 300], ['0.6s', 600], ['1.5s', 1500], ['13s', 13000]]) {
            await page.evaluate(`window.__setCorpseAge(${ms})`);
            await shoot(`death-${label}-z${z}`);
          }
        } else {
          await shoot(`${scene}-z${z}`);
        }
      }
      console.error(`scene ${scene}: done`);
    }
    if (pageErrors.length) {
      console.error('JS ERRORS:\n  ' + pageErrors.join('\n  '));
      process.exitCode = 1;
    }
    console.log(outDir);
  } catch (err) {
    console.error('SCREENSHOT HARNESS ERROR: ' + (err && err.stack || err));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) srv.close();
  }
})();
