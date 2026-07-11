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
      g.guardTargetId = gtc.id; g.guardX = pt.x; g.guardY = pt.y; g.guardFlagged = true;
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
    sol.guardTargetId = vil.id; sol.followId = vil.id;
    sol.guardX = vil.x; sol.guardY = vil.y; sol.guardFlagged = true;
    selected.length = 0; selected.push(sol);
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
