#!/usr/bin/env node
// ---- HUD screenshot harness (Playwright driver) ----
// Unlike tools/screenshot.js (canvas-only art scenes via tools/sim.html),
// this loads the REAL pages — index.html (mobile skin) and classic.html —
// stages a completed, selected building on a flat world, and captures the
// full page including the HUD (#topbar, #bottom, #actions). Use it to check
// widgets like the Market exchange in both skins at both form factors.
//
//   node tools/screenshot-hud.js                       # market, both skins, all viewports
//   node tools/screenshot-hud.js scene=market skin=classic viewport=phone
//   node tools/screenshot-hud.js out=/tmp/shots headed=1
//
// Scenes:
//   market  own completed Market selected → commodity exchange in #actions
//   tc      own Town Center selected → train row + rally (layout baseline)
//
// Viewports:
//   desktop  1440x900 @1x
//   laptop   1280x720 @1x
//   phone          844x390 @3x (landscape iPhone 14-ish)
//   phone-sm       667x375 @2x (landscape iPhone SE)
//   phone-portrait 390x844 @3x (portrait — mobile skin's bottom-bar layout)

const path = require('path');
const fs = require('fs');
const { ROOT, requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

// ---- page-side staging (serialized into page.evaluate) ----
// Flat grass world, sim frozen, menu dismissed; real updateUI()/render() so
// the HUD reflects the staged selection exactly as in a live game.
function pageStage() {
  NUM_TEAMS = 2;
  window.__pendingMatchSeed = 7;
  setMapSize('small');
  restartGame('standard');
  gameStarted = true; gamePaused = true; // freeze the sim; we drive render()
  window.playSound = () => {};
  document.getElementById('tutorial').style.display = 'none';
  entities.length = 0; entitiesById.clear();
  selected.length = 0; corpses.length = 0;
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const t = map[y][x];
    t.occupied = null; t.res = 0; t.t = TERRAIN.GRASS;
    markMapDirty(x, y);
  }
  window.fogDisabled = true; updateFog();
  tick = 40;
}

function pageLookAt(x, y) {
  const iso = toIso(x, y);
  camX = iso.ix; camY = iso.iy;
  window.targetCamX = camX; window.targetCamY = camY;
}

// The HUD is the acceptance target here — updateUI() must succeed, but a
// render() throw (e.g. mid-edit art code) only costs the canvas backdrop,
// so it's reported without killing the capture.
const SCENES = {
  market: `(${pageStage})();
    const m = createBuilding('MARKET', 28, 28, 0);
    selected.push(m);
    (${pageLookAt})(29.5, 29.5);
    updateUI();
    try { render(); } catch (e) { console.error('render failed (HUD still valid): ' + e); }`,
  tc: `(${pageStage})();
    const t = createBuilding('TC', 28, 28, 0);
    t.queue = ['villager','villager','villager','villager']; t.trainTick = 350;
    selected.push(t);
    (${pageLookAt})(30, 30);
    updateUI();
    try { render(); } catch (e) { console.error('render failed (HUD still valid): ' + e); }`,
  mill: `(${pageStage})();
    const m = createBuilding('MILL', 28, 28, 0);
    resourceStore(0).prepaidFarms = 3; // banked reseeds → badge (mobile) / cancellable slots (classic)
    selected.push(m);
    (${pageLookAt})(29, 29);
    updateUI();
    try { render(); } catch (e) { console.error('render failed (HUD still valid): ' + e); }`,
  build: `(${pageStage})();
    const v = createUnit('villager', 28, 28, 0); selected.push(v);
    (${pageLookAt})(28, 28);
    updateUI();                                 // settle selection (menu → main)
    window.currentVillagerMenu = 'eco'; updateUI(); // open economic build submenu (House, Mill, Farm…)
    try { render(); } catch (e) { console.error('render failed (HUD still valid): ' + e); }`,
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  laptop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  'phone-sm': { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'phone-portrait': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const SKINS = { mobile: '/index.html', classic: '/classic.html' };

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(a.out || path.join(ROOT, 'tools', 'shots'));
  fs.mkdirSync(outDir, { recursive: true });
  const scenes = a.scene ? a.scene.split(',') : ['market'];
  const skins = a.skin ? a.skin.split(',') : Object.keys(SKINS);
  const vps = a.viewport ? a.viewport.split(',') : Object.keys(VIEWPORTS);
  for (const s of scenes) if (!SCENES[s]) { console.error(`unknown scene: ${s}`); process.exit(2); }
  for (const s of skins) if (!SKINS[s]) { console.error(`unknown skin: ${s}`); process.exit(2); }
  for (const v of vps) if (!VIEWPORTS[v]) { console.error(`unknown viewport: ${v}`); process.exit(2); }

  let srv, browser;
  try {
    srv = await startServer('/index.html');
    const base = 'http://127.0.0.1:' + srv.address().port;
    browser = await launchBrowser(chromium, a.headed === '1');
    for (const skin of skins) {
      for (const vp of vps) {
        const ctx = await browser.newContext(VIEWPORTS[vp]);
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(String(e.message || e)));
        await page.goto(base + SKINS[skin], { waitUntil: 'load' });
        // boot.js is the last script: once it flips the Start button on,
        // every game global we poke below is guaranteed to exist.
        await page.waitForFunction(() => {
          const b = document.getElementById('start-game-btn');
          return b && !b.disabled;
        }, { timeout: 15000 });
        for (const scene of scenes) {
          await page.evaluate(SCENES[scene]);
          await page.screenshot({ path: path.join(outDir, `hud-${scene}-${skin}-${vp}.png`) });
        }
        if (pageErrors.length) {
          console.error(`JS ERRORS (${skin}/${vp}):\n  ` + pageErrors.join('\n  '));
          process.exitCode = 1;
        }
        await ctx.close();
        console.error(`${skin}/${vp}: done`);
      }
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
