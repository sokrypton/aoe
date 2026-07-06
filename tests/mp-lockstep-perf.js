// Manual perf measurement (not part of run.js SUITES — numbers are
// environment-dependent): lockstep match, host desktop-like, guest under
// phone emulation (390x844, dpr3, touch), 300-unit battle spawned
// deterministically through the queue (dev-spawn, gated on
// window.DEV_TEST_COMMANDS). Reports guest fps/tps/render/sim cost, tick
// lag, and checksum agreement. Run: node tests/run-perf.sh equivalent —
// serve repo on :8471 then `node tests/mp-lockstep-perf.js`.
const { chromium } = require('playwright');
const BASE = (process.env.AOE_URL || 'http://127.0.0.1:8471/') + 'index.html';

(async () => {
  const b = await chromium.launch();
  const hostCtx = await b.newContext();
  const host = await hostCtx.newPage();
  await host.goto(BASE + '?lockstep');
  await host.waitForTimeout(800);
  await host.evaluate(() => { window.DEV_TEST_COMMANDS = true; onHostClicked(); });
  await host.waitForFunction(() => netPeer && netPeer.id, null, { timeout: 20000 });
  const id = await host.evaluate(() => netPeer.id);
  const gctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const g = await gctx.newPage();
  await g.goto(BASE + '?join=' + id);
  await g.waitForFunction(() => typeof lockstepActive !== 'undefined' && lockstepActive && tick > 10, null, { timeout: 30000 });
  await g.evaluate(() => {
    window.DEV_TEST_COMMANDS = true;
    window.__counters = { renders: 0, ticks: 0, renderMs: 0, simMs: 0 };
    const _r = render; render = function(){ const t0 = performance.now(); _r(); window.__counters.renderMs += performance.now() - t0; window.__counters.renders++; };
    const _u = update; update = function(){ const t0 = performance.now(); _u(); window.__counters.simMs += performance.now() - t0; window.__counters.ticks++; };
  });
  await host.evaluate(() => submitCommand({ kind: 'dev-spawn', n: 300, x: Math.floor(MAP/2) - 10, y: Math.floor(MAP/2) - 8 }));
  await new Promise(r => setTimeout(r, 3000));
  await g.evaluate(() => { const iso = toIso(MAP/2, MAP/2); camX = iso.ix; camY = iso.iy; window.__counters = { renders: 0, ticks: 0, renderMs: 0, simMs: 0 }; window.__t0 = performance.now(); });
  await new Promise(r => setTimeout(r, 8000));
  const gm = await g.evaluate(() => {
    const c = window.__counters, dt = (performance.now() - window.__t0) / 1000;
    return { fps: +(c.renders/dt).toFixed(1), tps: +(c.ticks/dt).toFixed(1),
             avgRenderMs: +(c.renderMs/c.renders).toFixed(2), avgSimMs: +(c.simMs/c.ticks).toFixed(2),
             units: entities.filter(e => e.type === 'unit').length, tick: Math.round(tick),
             desync: window.__lockstepDesync || null };
  });
  const hm = await host.evaluate(() => ({ tick: Math.round(tick), desync: window.__lockstepDesync || null }));
  const [hh, gh] = await Promise.all([host, g].map(p => p.evaluate(() => DET.history.slice(-200))));
  const gmap = new Map(gh.map(r => [r.tick, r.sum]));
  let cmp = 0, mis = 0; hh.forEach(r => { if (gmap.has(r.tick)) { cmp++; if (gmap.get(r.tick) !== r.sum) mis++; } });
  console.log('GUEST:', JSON.stringify(gm));
  console.log('HOST tick:', hm.tick, 'lag:', hm.tick - gm.tick, '| checksums:', cmp, 'mismatches:', mis);
  await b.close();
  process.exit(mis || gm.desync || hm.desync ? 1 : 0);
})();
