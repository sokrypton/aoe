#!/usr/bin/env node
// ---- Repro: "some units left behind" when a large army moves ----
// Spawns a big block of units on open grass, issues ONE group move order to a
// far tile (as a human box-select + right-click would), then steps the sim and
// reports how many actually arrive vs. get left behind, and WHY (no path /
// stuck watchdog / never issued a path). Open-field, so a left-behind unit is
// a movement/collision/formation bug, not terrain.
//
//   node tools/repro-largearmy.js [n=40] [ticks=1500] [dest=50,50] [utype=knight]

const path = require('path');
const { requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const n = parseInt(args.n || '40', 10);
  const ticks = parseInt(args.ticks || '1500', 10);
  const utype = args.utype || 'knight';
  const [dx, dy] = (args.dest || '50,50').split(',').map(Number);

  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, args.headed === '1');
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/tools/sim.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof loadScenario === 'function' && typeof update === 'function');

  const result = await page.evaluate(({ n, ticks, utype, dx, dy }) => {
    window.playSound = () => {}; window.showMsg = () => {}; window.updateUI = () => {};
    // blank grass, 2 teams, all human
    loadScenario({ map: 'medium', seed: 1, numTeams: 2, controllers: ['human', 'human'], entities: [] });
    gameStarted = true; gamePaused = false;
    myTeam = 0;

    // Build a tight block of units near (18,18).
    const cols = Math.ceil(Math.sqrt(n));
    const army = [];
    for (let i = 0; i < n; i++) {
      const x = 12 + (i % cols), y = 12 + Math.floor(i / cols);
      army.push(createUnit(utype, x, y, 0));
    }

    // Group move order via the real command path (formation offsets, groupSpeed).
    selected.length = 0; army.forEach(u => selected.push(u));
    const groupSpeed = Math.min(...army.map(m => m.speed || 1));
    const offsets = getFormation(army.length);
    army.forEach((s, idx) => {
      s.groupSpeed = groupSpeed;
      s.target = null; s.task = null; s.gatherX = -1; s.gatherY = -1;
      const ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
      issueMoveOrder(s, dx + ox, dy + oy);
    });

    const startPathCount = army.filter(u => u.path && u.path.length > 0).length;

    const snaps = [];
    for (let i = 0; i < ticks; i++) {
      update();
      if (i % 300 === 0 || i === ticks - 1) {
        const arrived = army.filter(u => Math.hypot(u.x - dx, u.y - dy) < 6).length;
        const moving = army.filter(u => u.path && u.path.length > 0).length;
        const idleFar = army.filter(u => (!u.path || u.path.length === 0) && Math.hypot(u.x - dx, u.y - dy) >= 6).length;
        snaps.push({ tick: i, arrived, moving, idleFar });
      }
    }
    // Final: classify every left-behind unit.
    const left = army.filter(u => Math.hypot(u.x - dx, u.y - dy) >= 6).map(u => ({
      id: u.id,
      pos: `${u.x.toFixed(1)},${u.y.toFixed(1)}`,
      distToDest: +Math.hypot(u.x - dx, u.y - dy).toFixed(1),
      distFromStart: +Math.hypot(u.x - 12, u.y - 12).toFixed(1),
      pathLen: u.path ? u.path.length : 0,
      stuckFor: u.stuckTicks || 0,
      task: u.task || null, tgt: u.target || null,
    }));

    return {
      n, startPathCount,
      arrivedFinal: army.filter(u => Math.hypot(u.x - dx, u.y - dy) < 6).length,
      leftBehind: left.length,
      snaps,
      leftSample: left.slice(0, 15),
      jsErrors: (window.health && window.health.jsErrors) || 0,
      watchdogFires: (window.health && window.health.watchdogFires) || 0,
    };
  }, { n, ticks, utype, dx, dy });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  srv.close();
})();
