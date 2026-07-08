// ---- STYLE GALLERY (style.html) ----
// Renders every building (at the selected age) and every unit (all 8
// facings) using the game's REAL draw code — no game loop, no sim. Open
// style.html to eyeball art changes without playing a match. The trick:
// every specimen lives at a fixed world position, and the camera is
// re-aimed per specimen so it lands in its gallery cell.
(function(){
  // Hide the injected game chrome; the gallery owns the whole canvas.
  ['tutorial','bottom','topbar','minimap','help-hint','net-stats','tooltip','chat-panel']
    .forEach(id => { let el = document.getElementById(id); if (el) el.style.display = 'none'; });

  // ---- Minimal world boot (enough for the draw code's reads) ----
  MAP = 96;
  map = [];
  for (let y = 0; y < MAP; y++) {
    map[y] = [];
    for (let x = 0; x < MAP; x++) map[y][x] = { t: TERRAIN.GRASS, res: 0, occupied: null };
  }
  window.fogDisabled = true;
  initFog();
  resetTeamVision();
  resetTeamAge();
  resetLastTeamHit();
  resetDefeatedTeams();
  resetAIStates();
  gameStarted = true;

  // ---- Specimens ----
  // Buildings: each gets a far-apart world slot so wall-link neighbor
  // scans never cross specimens. Walls get a 2-tile run + pillar, gates a
  // vertical wall pair context so their links/door render.
  let gallery = []; // {kind:'building'|'unit'|'label', ents:[..], label}
  let wx = 4, wy = 4;
  const slot = () => { let p = { x: wx, y: wy }; wx += 8; if (wx > MAP - 8) { wx = 4; wy += 8; } return p; };

  const mkB = (type, opts = {}) => {
    let p = slot();
    let ents = [];
    if (type === 'WALL' || type === 'SWALL') {
      // short run so links render
      for (let i = 0; i < 3; i++) { let w = createBuilding(type, p.x, p.y + i, 0); w.complete = true; ents.push(w); }
    } else if (type === 'GATE' || type === 'SGATE') {
      let wallB = GATE_WALL_MATCH[type];
      let wTop = createBuilding(wallB, p.x, p.y, 0); wTop.complete = true;
      let g = createBuilding(type, p.x, p.y + 1, 0, 1, 2); g.complete = true; g.gateProgress = 0;
      let wBot = createBuilding(wallB, p.x, p.y + 3, 0); wBot.complete = true;
      ents.push(wTop, g, wBot);
      g.__animGate = true;
    } else {
      let b = createBuilding(type, p.x, p.y, 0);
      b.complete = true;
      if (type === 'FARM') map[p.y][p.x].res = BLDGS.FARM.food; // ripe crop
      ents.push(b);
    }
    gallery.push({ kind: 'building', ents, label: (BLDGS[type].name || type), anchor: ents[0], gateType: type,
                   // palisade pieces are superseded by stone from Feudal —
                   // hide them at later ages to keep the gallery current
                   maxAge: (type === 'WALL' || type === 'GATE') ? 0 : undefined });
  };

  const mkU = (utype, opts = {}) => {
    // 8 facings left→right in dir order 0..7 (SE,S,SW,W,NW,N,NE,E)
    let row = [];
    for (let d = 0; d < 8; d++) {
      let p = slot();
      let u = createUnit(utype, p.x + 0.5, p.y + 0.5, 0);
      if (opts.female !== undefined) u.female = opts.female;
      u.task = 'gallery'; // any truthy task suppresses the idle '?' marker; unknown task = default pose
      // createUnit seeds gatherX/gatherY = -1; with a truthy task drawUnit
      // treats them as a facing target (map corner!) and the turn
      // hysteresis then fights the locked dir — delete so dx/dy stay 0.
      delete u.gatherX; delete u.gatherY;
      u.dir = d;
      if (d === 0 || d === 1 || d === 7) { u.facing = 1;  u.facingNorth = false; }
      else if (d === 2 || d === 3)       { u.facing = -1; u.facingNorth = false; }
      else if (d === 4)                  { u.facing = -1; u.facingNorth = true;  }
      else                               { u.facing = 1;  u.facingNorth = true;  }
      u.__lockDir = d;
      row.push(u);
    }
    gallery.push({ kind: 'unitrow', ents: row, label: opts.label || (UNITS[utype].name || utype), gateType: utype });
  };

  // Fortification combo: walls in BOTH directions, both gate orientations,
  // and towers at a corner and mid-run — one card to eyeball every
  // wall/gate/tower connection the game can produce.
  //         (0,0) SWALL
  //         (0,1) SWALL
  //  (0,2) TOWER ── (1,2)(2,2) SWALL ── (3,2)(4,2) GATE(E-W) ── (5,2) SWALL ── (6,2) TOWER
  //         (0,3) SWALL
  //         (0,4)(0,5) GATE(N-S)
  //         (0,6) SWALL
  const mkFort = (wallB, gateB, label) => {
    let p = { x: wx, y: wy }; wx = 4; wy += 12; // full-width slot on its own band
    let ents = [];
    // Palisade is the Dark-age fortification (superseded by stone from
    // Feudal), and towers only exist from Feudal — so the palisade fort
    // is towerless and shows only at Dark; the stone fort takes over after.
    let towers = wallB !== 'WALL';
    let put = (t, x, y, w, h) => { let b = createBuilding(t, p.x + x, p.y + y, 0, w, h); b.complete = true; ents.push(b); return b; };
    put(wallB, 0, 0); put(wallB, 0, 1);
    put(towers ? 'TOWER' : wallB, 0, 2);
    put(wallB, 1, 2); put(wallB, 2, 2);
    put(gateB, 3, 2, 2, 1).__animGate = true;   // E-W gate
    put(wallB, 5, 2);
    put(towers ? 'TOWER' : wallB, 6, 2);
    put(wallB, 0, 3);
    put(gateB, 0, 4, 1, 2).__animGate = true;   // N-S gate
    put(wallB, 0, 6);
    gallery.push({ kind: 'building', ents, label, anchor: ents[0],
                   gateType: towers ? 'TOWER' : wallB,
                   maxAge: wallB === 'WALL' ? 0 : undefined,
                   aimX: p.x + 3.5, aimY: p.y + 3.5, rowH: 340 });
  };

  // Farm lifecycle in one card: fresh/ripe field → progressively harvested
  // (crop height follows food left on the tile) → exhausted stubble.
  const mkFarmStages = () => {
    // fresh full-width band below the current slot row (the current wy row
    // may already hold specimens at x < wx). Stages step along world
    // (+1,-1) — screen-horizontal — so the row reads left to right.
    const stages = [1.0, 0.65, 0.35, 0.12, 0]; // food fraction left; 0 = exhausted
    let fw = BLDGS.FARM.w || 2, step = fw; // corner-to-corner: all 5 fit at 1.5x zoom
    let y0 = wy + 8 + (stages.length - 1) * step;
    let p = { x: 4, y: y0 }; wx = 4; wy = y0 + fw + 4;
    let ents = [];
    stages.forEach((fr, i) => {
      let x = p.x + i * step, y = p.y - i * step;
      let b = createBuilding('FARM', x, y, 0);
      b.complete = true;
      if (fr === 0) { b.exhausted = true; map[y][x].res = 0; }
      else map[y][x].res = Math.round(BLDGS.FARM.food * fr);
      ents.push(b);
    });
    let half = (stages.length - 1) * step / 2;
    gallery.push({ kind: 'building', ents, label: 'Farm stages (ripe → harvested → exhausted)',
                   anchor: ents[0], gateType: 'FARM',
                   aimX: p.x + half + fw / 2, aimY: p.y - half + fw / 2,
                   aimTx: 450, rowH: 240 });
  };

  const BROW = ['TC','HOUSE','BARRACKS','MILL','LCAMP','MCAMP','FARM','TOWER','WALL','GATE','SWALL','SGATE'];
  BROW.forEach(t => t === 'FARM' ? mkFarmStages() : mkB(t));
  mkFort('SWALL', 'SGATE', 'Stone fortification (walls + gates + towers)');
  mkFort('WALL', 'GATE', 'Palisade fortification (walls + gates)');
  mkU('villager', { female: false, label: 'Villager (male)' });
  mkU('villager', { female: true,  label: 'Villager (female)' });
  ['militia','spearman','archer','scout','knight','ram','sheep','bear'].forEach(u => mkU(u));

  // ---- Controls ----
  let galleryAge = 0, galleryZoom = 1.5, walking = false, attacking = false, scrollY = 0;
  document.querySelectorAll('#style-controls button[data-age]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#style-controls button[data-age]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      galleryAge = +b.dataset.age;
    };
  });
  document.querySelectorAll('#style-controls button[data-zoom]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#style-controls button[data-zoom]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      galleryZoom = +b.dataset.zoom;
    };
  });
  document.getElementById('sg-walk').onchange = e => { walking = e.target.checked; };
  // Attack toggle: previews attack cycles without a target (today only the
  // ram's drawRamBody reads __animAttack). Wins over walking — a specimen
  // can't do both.
  let sgAtk = document.getElementById('sg-attack');
  if (sgAtk) sgAtk.onchange = e => { attacking = e.target.checked; };
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') scrollY += 60;
    if (e.key === 'ArrowUp') scrollY = Math.max(0, scrollY - 60);
  });
  window.addEventListener('wheel', e => { scrollY = Math.max(0, scrollY + e.deltaY); }, { passive: true });

  // Aim the camera so world point (wxp, wyp) lands at screen (tx, ty)
  // under the current zoom transform (which is centered on the viewport).
  const aim = (wxp, wyp, tx, ty, unitAnchor) => {
    let iso = toIso(wxp, wyp);
    // invert the center-zoom: screen = center + (raw - center) * zoom
    let cx = W / 2, cy = H / 2 + topH;
    let rawX = cx + (tx - cx) / galleryZoom;
    let rawY = cy + (ty - cy) / galleryZoom;
    camX = iso.ix - (rawX - W / 2);
    camY = iso.iy - (rawY - (topH + H / 2) + (unitAnchor ? -HALF_TH : 0));
  };

  const DIR_LABELS = ['SE','S','SW','W','NW','N','NE','E'];
  const DIRV = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]; // rough world vectors per dir

  function frame(){
    tick++;
    teamAge[0] = galleryAge;
    invalidateBuildingFogMemo();

    // background
    X.setTransform(dpr, 0, 0, dpr, 0, 0);
    X.fillStyle = '#3e7a24';
    X.fillRect(0, 0, W, window.innerHeight);

    let y0 = 160 - scrollY;
    const CELL_W = 130;

    const withZoom = (fn) => {
      X.save();
      X.translate(Math.round(W/2), Math.round(H/2 + topH));
      X.scale(galleryZoom, galleryZoom);
      X.translate(-Math.round(W/2), -Math.round(H/2 + topH));
      fn();
      X.restore();
    };

    let cy = y0;
    gallery.forEach(g => {
      // Only show what actually EXISTS at the selected age — the gallery
      // mirrors the game's unlock rules (stone walls/towers from Feudal,
      // knight from Castle, etc).
      if (g.gateType && ageReq(g.gateType) > galleryAge) return;
      if (g.maxAge !== undefined && galleryAge > g.maxAge) return;
      if (cy > -260 && cy < window.innerHeight + 260) {
        // label
        X.setTransform(dpr, 0, 0, dpr, 0, 0);
        X.fillStyle = '#fff'; X.font = 'bold 14px sans-serif'; X.textAlign = 'left';
        X.fillText(g.label + (g.kind === 'building' ? '  (' + AGES[galleryAge].name + ')' : ''), 16, cy - 12);

        if (g.kind === 'building') {
          withZoom(() => {
            // draw the specimen group with one camera aim per group
            let a = g.anchor, b = BLDGS[a.btype];
            if (g.aimX !== undefined) aim(g.aimX, g.aimY, g.aimTx || 330, cy + 150, false);
            else aim(a.x + b.w / 2, a.y + b.h / 2, 130, cy + 130, false);
            // gates animate open/close so both states are visible
            g.ents.forEach(en => {
              if (en.__animGate) en.gateProgress = (Math.sin(tick * 0.03) + 1) / 2;
            });
            // ground shadows first, one union fill — same pass structure
            // as render.js so the gallery previews match in-game layering
            X.fillStyle = 'rgba(0,0,0,0.16)';
            X.beginPath();
            g.ents.forEach(en => buildingShadowPath(en));
            X.fill();
            // draw in world order (back to front): sort by x+y
            g.ents.slice().sort((p, q) => (p.y + p.x) - (q.y + q.x)).forEach(en => {
              if (isGateBtype(en.btype)) { drawBuilding(en, 'back'); drawBuilding(en, 'front'); }
              else drawBuilding(en);
            });
          });
        } else {
          g.ents.forEach((u, i) => {
            // facing labels
            X.setTransform(dpr, 0, 0, dpr, 0, 0);
            X.fillStyle = 'rgba(255,255,255,0.7)'; X.font = '11px sans-serif'; X.textAlign = 'center';
            X.fillText(DIR_LABELS[i], 90 + i * CELL_W, cy + 92);
            withZoom(() => {
              // restore locked facing (drawUnit's hysteresis may mutate it)
              let d = u.__lockDir;
              u.dir = d;
              if (d === 0 || d === 1 || d === 7) { u.facing = 1;  u.facingNorth = false; }
              else if (d === 2 || d === 3)       { u.facing = -1; u.facingNorth = false; }
              else if (d === 4)                  { u.facing = -1; u.facingNorth = true;  }
              else                               { u.facing = 1;  u.facingNorth = true;  }
              // walking toggle: a dummy path in the facing direction keeps
              // the gait cycle going AND keeps drawUnit's dir derivation
              // pointing the way the cell is labelled
              u.__animAttack = attacking;
              if (walking && !attacking) {
                u.path = [{ x: u.x + DIRV[d][0] * 3, y: u.y + DIRV[d][1] * 3 }];
              } else {
                u.path = [];
              }
              aim(u.x, u.y, 90 + i * CELL_W, cy + 55, true);
              drawUnit(u);
            });
          });
        }
      }
      cy += g.rowH || (g.kind === 'building' ? 230 : 150); // tall buildings need headroom
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
